//! **TEST-3 [acceptance] [invariant: INV-2] [covers: ITEM-5, ITEM-6]**
//!
//! > *Everything is explicit. There is no default fallback. Absence is an error.
//! > Explicit optionality (`required: false`) is fine; "if absent, assume X" is not.*
//! > — `00_CONSOLIDATED_DESIGN.md` §0.3, "The two invariants" (2).
//!
//! An artifact write that omits a producer DECLARATION **fails**. It does not quietly
//! land as `{}`, which is what the four columns this model replaced all did
//! (`DEFAULT '{}'::jsonb NOT NULL`) and what left every downstream reader unable to
//! tell "nothing to declare" from "the producer forgot".
//!
//! Asserted at the two layers a write can enter through, because a default
//! reintroduced at either one satisfies the other:
//!
//!   * **the SCHEMA** — `NOT NULL` *with no default*, so an `INSERT` that omits the
//!     column is a `23502` naming that column. This is the layer that would still
//!     hold if the manifest type grew a `#[serde(default)]`.
//!   * **the MANIFEST** — the producer-facing surface. One base fixture, and variants
//!     that differ **only** by whether one key is present.
//!
//! ## Nothing here is a LIST of fields, and that is the point
//!
//! This file used to test the pair `["structure","meta"]`, typed out as a const. That
//! list was correct for the fields someone remembered, and it was structurally
//! incapable of seeing the third: `OutputEntry.role` carried `#[serde(default)]`, and
//! a blank role was mapped to `artifact` — **the promotable tier** — so a manifest
//! that declared no tier at all produced an artifact `POST /datasets/promote` would
//! export. Absence resolving to the MORE privileged of two values is the sharpest form
//! of what INV-2 forbids, and the acceptance test for INV-2 could not fail on it.
//!
//! So every field set below is DERIVED, and the derivation is the coverage mechanism:
//!
//!   * the required COLUMNS come from `information_schema` (NOT NULL, no default);
//!   * the required MANIFEST KEYS come from probing the complete fixture — remove each
//!     key in turn, and the removal must be refused;
//!   * the DECLARATION columns — the bridge between the two — are discovered by
//!     ingesting the fixture and finding which columns hold the values the producer
//!     supplied, rather than by a hand-written key→column map. (A map would have
//!     matched the manifest's `id` against `artifacts.id`, the row PK, which of course
//!     carries a default; the manifest's `id` is stored in `output_id`.)
//!
//! A newly-required declaration is therefore covered the day it lands.
//!
//! ## Controls, because "the write failed" is a weak signal
//!
//! Almost anything makes a write fail. Each of these separates *the* rejection from
//! *a* rejection:
//!
//!  1. **POSITIVE CONTROL** — the byte-identical fixture *with* every key succeeds.
//!     Without it, a fixture broken in some unrelated way would pass this test while
//!     proving nothing.
//!  2. **THE EMPTINESS CONTROL** — an *explicitly supplied* `{}` **succeeds** and is
//!     stored as `{}`. The invariant is about ABSENCE, not about emptiness; if the
//!     server rejected `{}` outright then "omitting it fails" would be indis-
//!     tinguishable from "empty is invalid", and this test would be pinning a
//!     different rule than the one it names.
//!
//!     `role` is deliberately NOT symmetric with this, and the asymmetry is the rule
//!     rather than an exception to it: `{}` is a complete statement ("I have nothing
//!     to declare"), whereas `""` is not one of the two tiers — it is the absence of a
//!     tier wearing a present key. Accepting it would restore "silence ⇒ promotable"
//!     by a second route, so a blank role is refused and that refusal is asserted.
//!  3. **THE DISCRIMINATION CONTROL** — removing one key and removing another produce
//!     errors naming *different* fields. `BAD_MANIFEST` is the shared code for
//!     **every** manifest defect — truncated JSON, a bad type, a missing `id` — so
//!     asserting on the code alone would let any unrelated rejection masquerade as
//!     this one. The assertion is on which field the error names.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;

use super::{create_project, pool_for, server_store, setup_admin, write_manifest};
use crate::common::TestServer;

/// `(is_nullable, column_default)` for one `artifacts` column.
async fn column_contract(pool: &PgPool, column: &str) -> (String, Option<String>) {
    sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT is_nullable::text, column_default::text
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'artifacts' AND column_name = $1",
    )
    .bind(column)
    .fetch_optional(pool)
    .await
    .expect("read column contract")
    .unwrap_or_else(|| panic!("`artifacts.{column}` does not exist"))
}

/// Every `artifacts` column an INSERT must state: `NOT NULL` with no default.
/// Returned as `(name, sql_type)` pairs, ordered, so the callers below can both
/// enumerate the set and build a literal for each member.
async fn required_columns(pool: &PgPool) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT column_name::text, data_type::text FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'artifacts'
            AND is_nullable = 'NO' AND column_default IS NULL
          ORDER BY column_name",
    )
    .fetch_all(pool)
    .await
    .expect("read the required columns")
}

/// One complete, valid manifest entry. Every variant below is built by REMOVING a
/// single key from this object, so the removed key is the only difference between a
/// fixture that ingests and one that does not.
///
/// The values are chosen to be mutually DISTINCT, because
/// `test3_every_declaration_column_is_required_with_no_default` discovers the
/// key→column mapping by matching stored values against these: two keys sharing a
/// value would make the discovery ambiguous.
fn complete_entry() -> Value {
    json!({
        "id": "declared",
        "datatype": "data/opaque",
        "path": "payload.bin",
        "layout": "opaque",
        "role": "artifact",
        "structure": { "encoding": "opaque", "media_type": "application/octet-stream" },
        "meta": { "title": "a fully declared output" }
    })
}

/// The keys of [`complete_entry`], derived from the fixture rather than listed.
fn entry_keys() -> Vec<String> {
    complete_entry()
        .as_object()
        .expect("entry object")
        .keys()
        .cloned()
        .collect()
}

/// Ingest one manifest entry into a fresh run; returns the run id and the outcome.
async fn ingest_entry(
    server: &TestServer,
    pool: &PgPool,
    store: &cytoanalyst::modules::workstore::object_store::LocalFsStore,
    project: Uuid,
    entry: Value,
) -> (
    Uuid,
    Result<Vec<cytoanalyst::modules::workstore::catalog::models::Artifact>, ziee_core::AppError>,
) {
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    write_manifest(
        &ws,
        &json!({ "outputs": [entry] }),
        &[("payload.bin", b"declared bytes")],
    )
    .await;
    let run_id = Uuid::new_v4();
    let res = ingest_run_outputs(pool, store, Some(project), None, run_id, None, &ws).await;
    (run_id, res)
}

/// The `message` an [`ziee_core::AppError`] carries. `AppError` exposes
/// `error_code()` but not its message, and it derives `Serialize`, so the message is
/// read off the serialized form rather than out of `Debug` text.
fn message_of(err: &ziee_core::AppError) -> String {
    serde_json::to_value(err).expect("AppError serializes")["message"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

// ── (1) THE SCHEMA — NOT NULL with no default ─────────────────────────────────

/// Every column that holds a value the PRODUCER supplied is `NOT NULL` with no
/// default.
///
/// The declaration columns are DISCOVERED, not listed: the complete fixture is
/// ingested, the resulting row is read back as JSON, and for each manifest key the
/// column(s) holding that exact value are found. So the set grows by itself when a
/// new producer-declared field lands, which is the whole reason `role` — a manifest
/// field whose blank value resolved to the PROMOTABLE tier — went unnoticed by the
/// `["structure","meta"]` version of this test.
#[tokio::test]
async fn test3_every_declaration_column_is_required_with_no_default() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "no-default-schema").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // POSITIVE CONTROL on the query itself: a column that DOES carry a default reads
    // back as one, and a NULLABLE column reads back as nullable. Without this, a
    // query returning NULL for every row (a typo'd table, a renamed view) would make
    // "no default" pass by accident.
    let (status_nullable, status_default) = column_contract(&pool, "status").await;
    assert_eq!(status_nullable, "NO");
    assert!(
        status_default.is_some(),
        "`artifacts.status` has a default in the schema; reading it as NULL means \
         this query cannot see defaults at all, and the assertions below are vacuous"
    );
    let (project_nullable, _) = column_contract(&pool, "project_id").await;
    assert_eq!(
        project_nullable, "YES",
        "`artifacts.project_id` is nullable; reading it as NOT NULL means this query \
         cannot see nullability either"
    );

    // Ingest the complete fixture and read the whole stored row back as an object.
    let (_run, res) = ingest_entry(&server, &pool, &store, sid, complete_entry()).await;
    let rows = res.expect("the complete fixture must ingest");
    let stored: Value = sqlx::query_scalar("SELECT row_to_json(a) FROM artifacts a WHERE id = $1")
        .bind(rows[0].id)
        .fetch_one(&pool)
        .await
        .expect("read the stored row");
    let stored = stored.as_object().expect("row object");

    // DISCOVER the key→column mapping by value. A hand-written map would have matched
    // the manifest's `id` against `artifacts.id` — the row PK, which carries
    // `gen_random_uuid()` — instead of `output_id`, and the test would have failed for
    // a reason that has nothing to do with declarations.
    let mut declaration_columns: Vec<String> = Vec::new();
    for key in entry_keys() {
        let declared = complete_entry()[&key].clone();
        for (column, value) in stored.iter() {
            if *value == declared && !declaration_columns.contains(column) {
                declaration_columns.push(column.clone());
            }
        }
    }
    declaration_columns.sort();
    // NON-VACUITY: the discovery must actually have found the row's declarations. An
    // empty (or near-empty) set would make the loop below assert nothing at all.
    assert!(
        declaration_columns.len() >= 3,
        "the key→column discovery found only {declaration_columns:?}. It works by \
         matching the fixture's values against the stored row, so an empty result \
         means the ingest stopped writing them — not that the schema is clean."
    );

    for column in &declaration_columns {
        let (nullable, default) = column_contract(&pool, column).await;
        assert_eq!(
            nullable, "NO",
            "`artifacts.{column}` holds a producer declaration and is nullable — an \
             artifact could then carry NO declaration at all, which is the absence \
             INV-2 forbids"
        );
        assert_eq!(
            default, None,
            "`artifacts.{column}` holds a producer declaration and carries a DEFAULT \
             ({default:?}). A default is precisely 'if absent, assume X': an omitted \
             declaration would silently become that value and no reader downstream \
             could tell it apart from one the producer actually wrote. For `role` that \
             X was `artifact`, the PROMOTABLE tier — so silence was the privileged \
             answer."
        );
    }
}

// ── (2) THE WRITE — omitting either declaration is an error, not an empty object ──

#[tokio::test]
async fn test3_an_insert_omitting_a_declaration_errors_and_stores_nothing() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "no-default-insert").await;
    let pool = pool_for(&server).await;

    /// Rows this project holds right now.
    async fn count(pool: &PgPool, sid: Uuid) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM artifacts WHERE project_id = $1")
            .bind(sid)
            .fetch_one(pool)
            .await
            .expect("count artifacts")
    }

    // The REQUIRED columns, derived from the schema rather than typed out here: every
    // `artifacts` column that is `NOT NULL` and carries no default, i.e. every column
    // an insert must state. Deriving it is what keeps this test honest as the row
    // evolves — an INSERT that hard-coded a column list would start failing on a
    // NEWLY-added required column and report that as "omitting `structure` errors",
    // which is precisely the masquerade this file exists to rule out.
    //
    // The omission loop below runs over this WHOLE set, not over a chosen pair. That
    // is what makes `role` covered: it became a required column in the same change
    // that made it a required manifest field, and a loop over `["structure","meta"]`
    // would have walked straight past it.
    let required = required_columns(&pool).await;
    let required_names: Vec<&str> = required.iter().map(|(c, _)| c.as_str()).collect();
    // NON-VACUITY: there is something to omit. An empty derived set would make every
    // assertion below trivially true by never omitting anything.
    assert!(
        required.len() >= 3,
        "only {required_names:?} are required on `artifacts`. Either the row lost its \
         declarations or this query stopped seeing them; both make this test vacuous."
    );

    /// A literal for one column, by its SQL type. Unknown types PANIC rather than
    /// being skipped: a required column this helper cannot fill would silently turn
    /// every INSERT below into a 23502 about the wrong column.
    fn literal_for(column: &str, data_type: &str) -> String {
        match data_type {
            "jsonb" | "json" => "'{\"declared\":true}'::jsonb".to_string(),
            "text" | "character varying" => "'x'".to_string(),
            "uuid" => "gen_random_uuid()".to_string(),
            "boolean" => "false".to_string(),
            "bigint" | "integer" | "smallint" | "numeric" => "0".to_string(),
            "timestamp with time zone" | "timestamp without time zone" => "now()".to_string(),
            other => panic!(
                "required column `{column}` has type `{other}`, which this test does \
                 not know how to supply — fill it in, or the INSERTs below fail for \
                 the wrong reason"
            ),
        }
    }

    // One INSERT supplying every required column EXCEPT `omit`, with every JSONB
    // column given the literal `jsonb`, scoped to this project so the row count below
    // is exact.
    let attempt = |omit: &[&str], jsonb: &str, output_id: &str| {
        let pool = pool.clone();
        let required = required.clone();
        let omit: Vec<String> = omit.iter().map(|s| s.to_string()).collect();
        let jsonb = jsonb.to_string();
        let output_id = output_id.to_string();
        async move {
            // `object_key` is supplied UNCONDITIONALLY even though ITEM-16 made it
            // nullable, so it is no longer in `required` and would otherwise be omitted
            // (→ NULL). A NULL key with no `structure.gathered_from` recipe violates the
            // `artifacts_bytes_or_recipe` CHECK, and every INSERT here would then fail
            // with a 23514 about the PAIRING instead of the 23502 about the missing
            // DECLARATION this test is actually about — including the positive control,
            // which is how the regression surfaced.
            //
            // Supplying it keeps every row coherently STORED, so the refusals below stay
            // attributable to the omitted declaration column and nothing else.
            let mut cols = vec![
                "project_id".to_string(),
                "run_id".to_string(),
                "object_key".to_string(),
            ];
            let mut vals = vec!["$1".to_string(), "$2".to_string(), "'x'".to_string()];
            for (column, data_type) in &required {
                if omit.contains(column) {
                    continue;
                }
                cols.push(column.clone());
                vals.push(if column == "output_id" {
                    format!("'{output_id}'")
                } else if data_type == "jsonb" || data_type == "json" {
                    jsonb.clone()
                } else {
                    literal_for(column, data_type)
                });
            }
            sqlx::query(&format!(
                "INSERT INTO artifacts ({}) VALUES ({})",
                cols.join(","),
                vals.join(",")
            ))
            .bind(sid)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
        }
    };

    // EVERY required column, one at a time. Not a chosen pair: a column that quietly
    // grew a default would drop out of `required` and simply stop being omitted, and
    // the only thing that notices is the non-vacuity assertion above plus the schema
    // test's discovery of the declaration columns.
    for (omitted, _) in &required {
        let err = attempt(&[omitted], "'{\"declared\":true}'::jsonb", "omits_one")
            .await
            .expect_err("an INSERT omitting a required column must fail");
        let db = err
            .as_database_error()
            .unwrap_or_else(|| panic!("expected a database error, got {err:?}"));
        assert_eq!(
            db.code().as_deref(),
            Some("23502"),
            "omitting `{omitted}` must be a NOT-NULL violation (23502); got {db:?}"
        );
        assert!(
            db.message().contains(omitted),
            "the NOT-NULL violation must name `{omitted}` — a 23502 on some OTHER \
             column would otherwise pass this assertion. Got: {}",
            db.message()
        );
    }

    // …and omitting ALL of them at once is likewise refused, not half-defaulted.
    let err = attempt(&required_names, "'{\"declared\":true}'::jsonb", "omits_all")
        .await
        .expect_err("an INSERT omitting every required column must fail");
    assert_eq!(
        err.as_database_error().and_then(|d| d.code()).as_deref(),
        Some("23502")
    );

    // THE POINT: nothing landed. Not a row with `{}`, not a row with NULL, not a row
    // at all. "Absence is an error" means the write does not happen.
    assert_eq!(
        count(&pool, sid).await,
        0,
        "a rejected write left a row behind — the declaration silently became \
         something the producer never wrote"
    );

    // POSITIVE CONTROL — the BYTE-IDENTICAL INSERT with every required column
    // supplied succeeds. Every refusal above is therefore about the missing column and
    // not about the statement, the literals or the project.
    attempt(&[], "'{\"declared\":true}'::jsonb", "declares_both")
        .await
        .expect("the same INSERT with every required column supplied must succeed");
    assert_eq!(count(&pool, sid).await, 1);

    // THE EMPTINESS CONTROL — an EXPLICIT `{}` is accepted and stored as `{}`.
    // "I have nothing to declare" is a statement; not saying anything is not. If this
    // failed, the refusals above would be about emptiness rather than absence and
    // this test would be pinning a rule the design does not state.
    attempt(&[], "'{}'::jsonb", "explicitly_empty")
        .await
        .expect("an EXPLICIT empty declaration is a declaration and must be accepted");
    let stored: (Value, Value) = sqlx::query_as(
        "SELECT structure, meta FROM artifacts
          WHERE project_id = $1 AND output_id = 'explicitly_empty'",
    )
    .bind(sid)
    .fetch_one(&pool)
    .await
    .expect("read the explicitly-empty row");
    assert_eq!(
        (stored.0, stored.1),
        (json!({}), json!({})),
        "an explicitly-declared `{{}}` must round-trip as `{{}}`"
    );
}

// ── (3) THE MANIFEST — the producer-facing surface ────────────────────────────

#[tokio::test]
async fn test3_a_manifest_omitting_a_declaration_is_refused_by_the_field_it_omitted() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "no-default-manifest").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    // POSITIVE CONTROL FIRST — the complete fixture ingests. Every refusal below is
    // then attributable to the one key that was removed from THIS object, because
    // nothing else about it changes.
    let (run, res) = ingest_entry(&server, &pool, &store, sid, complete_entry()).await;
    let rows = res.expect("the complete fixture must ingest");
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].structure["encoding"], "opaque",
        "the complete fixture's declaration is stored as written"
    );
    assert_eq!(rows[0].meta["title"], "a fully declared output");
    assert_eq!(repo.list_by_run(sid, run).await.expect("list").len(), 1);

    // EVERY key of the complete entry, one at a time — the set is derived from the
    // fixture, so a newly-required field is probed the day it is added to it. A typed
    // list is what let `role` sit here with a `#[serde(default)]` and a privileged
    // fallback while this very file claimed to test "absence is an error".
    for omitted in entry_keys() {
        let omitted = omitted.as_str();
        let mut entry = complete_entry();
        entry
            .as_object_mut()
            .expect("entry object")
            .remove(omitted)
            .unwrap_or_else(|| panic!("`{omitted}` was not in the fixture to remove"));

        let (run, res) = ingest_entry(&server, &pool, &store, sid, entry).await;
        let err = match res {
            Err(e) => e,
            Ok(rows) => panic!(
                "a manifest entry that declares no `{omitted}` must be refused — an \
                 omitted declaration may not become an implied one. If this field is \
                 genuinely optional, say so here AND say why its absence cannot resolve \
                 to a privileged value. Instead this landed: {rows:?}"
            ),
        };

        // The error CODE is asserted, but it is NOT the discriminator: `BAD_MANIFEST`
        // is what every manifest defect answers with. The next assertion is the one
        // that distinguishes this rejection from any other.
        assert_eq!(err.error_code(), "BAD_MANIFEST");
        let message = message_of(&err);
        assert!(
            message.contains(&format!("`{omitted}`")),
            "the refusal must name the MISSING FIELD `{omitted}`. Without that, a \
             manifest broken in any unrelated way answers with the same code and this \
             test cannot tell the two apart. Got: {message}"
        );
        // …and it must name ONLY the one that was removed. If every field appeared in
        // every message, "it named the field" would carry no information.
        for other in entry_keys().iter().filter(|k| k.as_str() != omitted) {
            assert!(
                !message.contains(&format!("`{other}`")),
                "the refusal for a missing `{omitted}` also names `{other}`, so the \
                 message does not discriminate between them: {message}"
            );
        }

        // And nothing was written — no row with a defaulted value in the slot the
        // producer left empty.
        assert_eq!(
            repo.list_by_run(sid, run).await.expect("list").len(),
            0,
            "a refused ingest left a catalog row behind"
        );
    }

    // PRESENCE IS NOT ENOUGH, for a field whose two values are not equally
    // privileged. `role` is required now, but `""` would satisfy "the key is present"
    // while declaring nothing — and the old code mapped exactly that to `artifact`,
    // the PROMOTABLE tier. A blank is refused, naming the field, and writes nothing:
    // otherwise a mechanical migration that added `"role": ""` everywhere would have
    // re-opened this with the test still green.
    //
    // This is not in tension with the emptiness control on `structure`/`meta`. `{}` is
    // a complete statement — "I have nothing to declare" — and it is accepted. `""` is
    // not one of the two tiers; it is the absence of a tier with the key present.
    {
        let mut entry = complete_entry();
        entry["role"] = json!("");
        let (run, res) = ingest_entry(&server, &pool, &store, sid, entry).await;
        let err = match res {
            Err(e) => e,
            Ok(rows) => panic!(
                "a blank `role` was accepted. Whatever tier it resolved to, the \
                 producer did not declare it — and if that tier is `artifact`, silence \
                 just bought a promotable artifact. Landed: {rows:?}"
            ),
        };
        assert_eq!(err.error_code(), "BAD_MANIFEST");
        let message = message_of(&err);
        assert!(
            message.contains("`role`"),
            "a blank role must be refused BY `role`: {message}"
        );
        assert_eq!(
            repo.list_by_run(sid, run).await.expect("list").len(),
            0,
            "a refused ingest left a catalog row behind"
        );
    }

    // The whole project still holds exactly the one row the positive control wrote.
    let all = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM artifacts WHERE project_id = $1")
        .bind(sid)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(
        all, 1,
        "only the fully-declared output is in the catalog; the undeclared ones \
         did not silently become `{{}}`"
    );
}
