//! **TEST-4 [acceptance] [invariant: INV-3] [covers: ITEM-8]**
//!
//! > *An axis IS its key artifact; identity is that artifact's `content_hash`. The
//! > axis NAME is a label, never a key.*
//! > — `00_CONSOLIDATED_DESIGN.md` §0.3, "Concepts".
//!
//! This asserts what the server must **not** do, which is why it is written as a
//! census rather than as a behaviour test: there is no call to make, and no output
//! to inspect, that demonstrates the absence of an identity. So it looks for the
//! absence directly, in the two places an identity can hide.
//!
//! ## Relation to `mod.rs::test9_axis_entry_table_is_gone_and_axes_derive_from_declarations`
//!
//! That test names `workstore_axis_entry` and asserts `to_regclass` is NULL. This is
//! the **general** form of the same invariant and does not name it: the census is
//! DERIVED (a pattern over `information_schema` / `pg_catalog`), so a *differently
//! named* axis table, an `axis_name` column bolted onto an existing table, or an
//! index keyed on an axis label all trip it — the N+1 cases a spelled-out name
//! cannot catch. Deleting `test9` would lose the specific historical pin; deleting
//! this one would lose the rule.
//!
//! ## What is asserted
//!
//!  1. **No axis-shaped KEY anywhere in the schema** — no base table, column, index
//!     or constraint in `public` is named for or defined over an axis. Derived, so a
//!     new one is caught on arrival.
//!  2. **The axis's identity is recorded in ONE place — the key artifact's own row** —
//!     asserted as a whole-database VALUE census: that hash appears on that row and
//!     **nowhere else in any table**. A join table, an FK, a materialized axis row or
//!     a cache introduced tomorrow trips it without this file changing.
//!  3. **NEGATIVE CONTROL — relabelling changes nothing the server stores or
//!     serves.** The same bytes declared under a different axis label produce the
//!     same `content_hash`, the same `object_key` and byte-identical `/data`. Under
//!     the retired name-keyed model a rename silently orphaned every row; here it
//!     moves a label and nothing else.
//!  4. **A label does not identify.** Two genuinely different key artifacts may
//!     carry the SAME label and coexist — which under a `(project, axis_name, …)`
//!     primary key was a collision — and `/catalog` reports them as TWO axes, each
//!     under its own `content_hash`.
//!  5. **…and the one production RESOLVER refuses to break the tie.** Given a label
//!     that names two distinct key artifacts,
//!     `CatalogRepository::find_dataset_axis_index` errors rather than returning
//!     either. It used to answer with `ORDER BY created_at DESC LIMIT 1`, which is
//!     recency posing as identity: the caller silently got whichever entity set was
//!     imported last.
//!
//! ## The half of INV-3 that is NOT implemented (recorded, not faked)
//!
//! *"Two artifacts over the same key artifact are related solely by that artifact's
//! `content_hash`"* has **no dependent-side spelling in production**. An aligned column
//! declares the axis LABEL and its own length; it carries no axis identity, and a
//! producer could not supply one — `content_hash` is minted by INGEST, downstream of
//! every writer. This file used to assert that relation over a `structure.axis_key`
//! field it inserted itself and nothing else in the tree reads or writes; that block is
//! gone, and what replaced it asserts the resolution the server really performs.
//!
//! Both censuses carry a **positive control that runs the identical machinery
//! against a term the schema really does use** (`artifact`). Without it, a census
//! that silently matched nothing — a typo'd catalog view, a regex that never fires —
//! would report a clean schema and pass forever.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::ingest::ingest_run_outputs;

use super::{create_project, pool_for, server_store, setup_admin, write_manifest};
use crate::common::TestServer;

// ── the schema census ─────────────────────────────────────────────────────────

/// Every place in `public` where `token` could be a KEY: a base table named for it,
/// a column named for it, an index defined over it, a constraint defined over it.
///
/// Parameterized rather than hard-coded so the positive control below runs *this*
/// function, not a hand-written echo of it.
/// `(^|_)tok($|_)` — a TOKEN boundary, so `axis_name` / `entry_axis` / `axis` all
/// match while an unrelated word that merely contains the letters does not.
/// SQLite has no regexp operator by default, so the boundary is evaluated in
/// Rust on the per-table column census (the `pragma_*` table-valued functions
/// take one table at a time).
fn at_token_boundary(name: &str, token: &str) -> bool {
    name == token
        || name.starts_with(&format!("{token}_"))
        || name.ends_with(&format!("_{token}"))
        || name.contains(&format!("_{token}_"))
}

/// All base tables, from SQLite's own catalog (`sqlite_master` is the schema's
/// catalog; `information_schema` / `pg_catalog` have no SQLite form).
async fn base_tables(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .expect("list base tables")
}

async fn schema_sites_for(pool: &SqlitePool, token: &str) -> Vec<String> {
    let mut sites = Vec::new();
    let all_tables = base_tables(pool).await;

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE '%' || $1 || '%'",
    )
    .bind(token)
    .fetch_all(pool)
    .await
    .expect("table census");
    sites.extend(tables.into_iter().map(|t| format!("table {t}")));

    // One pragma scan per table, token boundary in Rust: SQLite's catalog has
    // no cross-table column view and no regexp operator.
    for t in &all_tables {
        let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info($1)")
            .bind(t)
            .fetch_all(pool)
            .await
            .expect("column census");
        for c in cols {
            if at_token_boundary(&c, token) {
                sites.push(format!("column {t}.{c}"));
            }
        }
    }

    // Index DEFINITIONS, not just names: this is where "keyed on" actually lives.
    // It covers primary keys and unique constraints too (SQLite backs both with
    // an index; the autoindex for a PK has NULL `sql` and is matched by name).
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name || ' :: ' || COALESCE(sql, '') FROM sqlite_master
          WHERE type = 'index' AND (sql LIKE '%' || $1 || '%'
                                    OR name LIKE '%' || $1 || '%')",
    )
    .bind(token)
    .fetch_all(pool)
    .await
    .expect("index census");
    sites.extend(indexes.into_iter().map(|d| format!("index {d}")));

    // Constraints that create no index (foreign keys, checks) — in SQLite they
    // live in the CREATE TABLE text, so the table DDL is the constraint census.
    let constraints: Vec<String> = sqlx::query_scalar(
        "SELECT name || ' :: ' || sql FROM sqlite_master
          WHERE type = 'table' AND (sql LIKE '%' || $1 || '%'
                                    OR name LIKE '%' || $1 || '%')",
    )
    .bind(token)
    .fetch_all(pool)
    .await
    .expect("constraint census");
    sites.extend(constraints.into_iter().map(|c| format!("constraint {c}")));

    sites
}

/// Every base table holding `needle` anywhere in any column, with the row count.
/// One `to_jsonb(row)` scan per table, so a value hidden in a JSONB blob, an
/// array or a text column is found the same way a scalar column is.
async fn tables_containing(pool: &SqlitePool, needle: &str) -> Vec<(String, i64)> {
    let tables = base_tables(pool).await;
    assert!(
        tables.len() > 10,
        "the base-table list collapsed to {} tables — a value census over nothing \
         proves nothing",
        tables.len()
    );

    let mut hits = Vec::new();
    for t in tables {
        let cols: Vec<(String, String)> =
            sqlx::query_as("SELECT name, type FROM pragma_table_info($1)")
                .bind(&t)
                .fetch_all(pool)
                .await
                .unwrap_or_else(|e| panic!("schema census over `{t}`: {e}"));
        // A value hidden in a JSONB/blob/array column is found the same way a
        // text column is: TEXT columns (incl. the JSON1 ones, stored as TEXT)
        // match the needle as text; uuid BLOBs match as lowercased hex (the
        // needle's hyphens stripped, since `hex()` renders none).
        let mut conds = Vec::new();
        let mut binds: Vec<String> = Vec::new();
        for (c, ty) in &cols {
            if ty.eq_ignore_ascii_case("BLOB") {
                conds.push(format!("lower(hex(\"{c}\")) LIKE ?"));
                binds.push(format!("%{}%", needle.replace('-', "").to_lowercase()));
            } else {
                conds.push(format!("CAST(\"{c}\" AS TEXT) LIKE ?"));
                binds.push(format!("%{needle}%"));
            }
        }
        if conds.is_empty() {
            continue;
        }
        let n: i64 = {
            let sql = format!(
                "SELECT count(*) FROM \"{t}\" x WHERE {}",
                conds.join(" OR ")
            );
            let mut q = sqlx::query_scalar::<_, i64>(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            q.fetch_one(pool)
                .await
                .unwrap_or_else(|e| panic!("value census over `{t}`: {e}"))
        };
        if n > 0 {
            hits.push((t, n));
        }
    }
    hits
}

// ── the fixture ───────────────────────────────────────────────────────────────

/// Ingest a directory of `members` as ONE multi-file key artifact declaring `label`
/// as its axis LABEL and `n` as its cardinality. Multi-file on purpose: a
/// single-file artifact's `object_key` IS its `content_hash`, which would put the
/// same string in two columns and blunt the value census below.
async fn ingest_key_artifact(
    server: &TestServer,
    pool: &SqlitePool,
    store: &txresbench::modules::workstore::object_store::LocalFsStore,
    project: Uuid,
    output_id: &str,
    label: &str,
    members: &[(&str, &[u8])],
    n: usize,
) -> txresbench::modules::workstore::catalog::models::Artifact {
    ingest_key_artifact_scoped(
        server,
        pool,
        store,
        Some(project),
        None,
        "data/opaque",
        output_id,
        label,
        members,
        n,
    )
    .await
}

/// [`ingest_key_artifact`] with the scope and datatype spelled out — the form the
/// RESOLVER test needs, because `find_dataset_axis_index` is dataset-scoped and filtered
/// to the axis-index datatype family.
#[allow(clippy::too_many_arguments)]
async fn ingest_key_artifact_scoped(
    server: &TestServer,
    pool: &SqlitePool,
    store: &txresbench::modules::workstore::object_store::LocalFsStore,
    project: Option<Uuid>,
    dataset: Option<Uuid>,
    datatype: &str,
    output_id: &str,
    label: &str,
    members: &[(&str, &[u8])],
    n: usize,
) -> txresbench::modules::workstore::catalog::models::Artifact {
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    // The layout is DERIVED from the datatype — the pair a real producer declares
    // together, and the pair ingest validates together. It used to be the literal
    // `"opaque"`, which no producer could have emitted for a datatype declaring a
    // chunked layout — see the note on `declared_layout`.
    let layout = declared_layout(datatype);
    let manifest = json!({ "outputs": [
        { "id": output_id, "datatype": datatype, "path": "keys", "layout": layout,
          "role": "artifact",
          // `axis` is the LABEL — a display string, nothing more. Cardinality is
          // declared alongside it; neither is a key.
          "structure": { "encoding": "zarr_v3", "kind": "table", "axis": label, "n": n },
          // `is_axis_index` is the producer SAYING this artifact IS the axis — the
          // server's one definition of a key artifact (`find_dataset_axis_index`
          // resolves by it, and `/catalog` derives its axes from it). Without it this
          // fixture is an artifact that merely MENTIONS a label, which is what an
          // aligned column is.
          "meta": { "title": "a key artifact", "is_axis_index": true } }
    ]});
    let files: Vec<(String, &[u8])> = members
        .iter()
        .map(|(p, b)| (format!("keys/{p}"), *b))
        .collect();
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(p, b)| (p.as_str(), *b)).collect();
    certify_producible(&manifest);
    write_manifest(&ws, &manifest, &refs).await;
    let mut rows = ingest_run_outputs(pool, store, project, dataset, Uuid::new_v4(), None, &ws)
        .await
        .expect("ingest key artifact");
    assert_eq!(rows.len(), 1, "a directory is ONE artifact row");
    rows.remove(0)
}

/// Axis LABELS for these tests. Deliberately non-domain: this suite's subject is axis
/// IDENTITY, so the labels are arbitrary — what matters is that two are distinct and that
/// one case reuses a single label across two identities. Core carries no domain vocabulary
/// (INV-5), and a test tree is core.
const ROW_AXIS: &str = "rows";
const COL_AXIS: &str = "columns";

/// The family's BASE type, derived from the registry-resolved id-set: the id whose
/// descendant closure covers every other member. Returns `None` for an empty set.
fn family_base(ids: &[String]) -> Option<String> {
    use txresbench::modules::datatype::DatatypeRegistry;
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    ids.iter()
        .find(|cand| {
            let closure = reg.descendants_inclusive(cand);
            ids.iter().all(|other| closure.contains(other))
        })
        .cloned()
}

/// The axis-index FAMILY id-set `sandbox::inputs::axis_index_datatype_allow`
/// resolves from the registry (DEC-12) — derived, never a datatype-id literal.
fn metadata_column_family() -> Vec<String> {
    use txresbench::modules::datatype::DatatypeRegistry;
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    let mut set: Vec<String> = reg
        .types_with_capability("metadata-column-family")
        .into_iter()
        .flat_map(|id| reg.descendants_inclusive(&id))
        .collect();
    set.sort();
    set.dedup();
    set
}

/// The `storage_layout` string a producer MUST declare for `datatype` — read off the
/// registry entry, which is the same value `datatype::validate_artifact_typing` compares
/// the manifest against at ingest.
///
/// WHY THIS IS DERIVED AND NOT A LITERAL. The fixture above hardcoded `"layout":
/// "opaque"` while the resolver test picks its datatype FROM THE REGISTRY
/// (`family_base(&metadata_column_family())` → a type whose manifest declares a CHUNKED
/// layout), so the manifest it fed to the real `ingest_run_outputs` was one no producer
/// could emit. It passed only because `ingest.rs`'s validation is
/// `if let Some(registry) = try_registry()`, and the process-global registry is
/// installed by exactly one test in this binary — so `-- workstore::axis_identity_test`
/// ran with the validator OFF while `-- datatype:: workstore::axis_identity_test::test4_a_label`
/// ran with it ON and returned 422 `LAYOUT_MISMATCH`. Boot always installs the registry
/// (`datatype/mod.rs`'s `init`, order 17), so ON is the only configuration production has:
/// a test whose result depends on which OTHER test shares its invocation is not measuring
/// the server.
///
/// Deriving also matches what a real producer does: a compute script carries the
/// `(datatype id, storage-layout string)` PAIR and declares both together, never one
/// without the other. Selecting an `opaque`-layout datatype instead was not an option for
/// the caller that matters — `find_dataset_axis_index` filters to the axis-index family
/// (the id-set [`metadata_column_family`] resolves), and no member of it declares
/// `opaque`, so there is nothing in scope to select.
fn declared_layout(datatype: &str) -> String {
    use txresbench::modules::datatype::DatatypeRegistry;
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    reg.get(datatype)
        .unwrap_or_else(|| {
            panic!(
                "the fixture's datatype `{datatype}` is not registered, so ingest would reject it"
            )
        })
        .storage
        .layout
        .as_storage_layout()
        .to_string()
}

/// Put the fixture's OWN manifest through the gate ingest applies, on every invocation.
///
/// Deriving the layout removes the divergence at its source; this makes its absence
/// OBSERVABLE without depending on test scheduling. `ingest.rs` calls
/// `validate_artifact_typing` only `if let Some(registry) = try_registry()`, and nothing
/// in this file installs that process-global — so the whole class of "the fixture is one
/// production could never ingest" is invisible to `-- workstore::axis_identity_test`,
/// which is exactly how the hardcoded `"opaque"` survived. Reading the values back OUT of
/// the built manifest (rather than re-checking the derived variable) is what makes this
/// non-tautological: it fails the same way whether a future edit reintroduces a literal,
/// selects an abstract datatype, or drifts the shape.
fn certify_producible(manifest: &Value) {
    use txresbench::modules::datatype::{validate_artifact_typing, DatatypeRegistry};
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    for entry in manifest["outputs"]
        .as_array()
        .expect("the fixture manifest declares an outputs array")
    {
        let (dt, layout) = (
            entry["datatype"].as_str().expect("declared datatype"),
            entry["layout"].as_str().expect("declared layout"),
        );
        validate_artifact_typing(&reg, dt, layout, &json!({})).unwrap_or_else(|e| {
            panic!(
                "this fixture declares a typing production would refuse at ingest, so \
                 whatever it goes on to assert is asserted about a manifest no producer \
                 could emit: {e:?}"
            )
        });
    }
}

// ── (1) no axis-shaped key anywhere in the schema ─────────────────────────────

#[tokio::test]
async fn test4_the_schema_holds_no_axis_table_column_index_or_constraint() {
    let server = TestServer::spawn().await;
    let _token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // POSITIVE CONTROL — the identical census, run against a token the schema really
    // does key on. All four probes must find something, or a clean result below
    // means "the census is broken", not "the schema is clean".
    let control = schema_sites_for(&pool, "artifact").await;
    for probe in ["table ", "column ", "index ", "constraint "] {
        assert!(
            control.iter().any(|s| s.starts_with(probe)),
            "the `{probe}`probe found nothing for a token the schema demonstrably \
             uses (`artifact`), so it cannot find one for `axis` either. Sites: \
             {control:?}"
        );
    }

    let sites = schema_sites_for(&pool, "axis").await;
    assert!(
        sites.is_empty(),
        "the schema keys something on an AXIS. INV-3: an axis IS its key artifact and \
         its identity is that artifact's `content_hash`; the NAME is a label, never a \
         key. The retired `workstore_axis_entry` said the opposite in the strongest \
         form a schema can — its primary key was `(project_id, axis_name, \
         entry_index)` and all three of its indexes were keyed on `axis_name`, so two \
         projects spelling one entity set differently held two unrelated axes and a \
         single rename orphaned every row. Found: {sites:#?}"
    );
}

// ── (2)(3)(4) identity is the key artifact's content_hash — nothing else ──────

#[tokio::test]
async fn test4_two_artifacts_over_one_axis_relate_only_through_its_content_hash() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    let sid = create_project(&server, &token, "axis-identity").await;
    let other = create_project(&server, &token, "axis-identity-relabelled").await;

    // The key artifact: a directory of row keys. Its `content_hash` IS the axis.
    let key_members: [(&str, &[u8]); 2] = [
        (
            "zarr.json",
            br#"{"zarr_format":3,"node_type":"array","shape":[4]}"#,
        ),
        ("c/0", b"k0\0k1\0k2\0k3\0"),
    ];
    let key = ingest_key_artifact(
        &server,
        &pool,
        &store,
        sid,
        "row_keys",
        "rows",
        &key_members,
        4,
    )
    .await;
    let axis = key.content_hash.clone();
    assert!(
        axis.starts_with("sha256:"),
        "the axis identity is a content hash"
    );
    assert_ne!(
        key.object_key.as_deref(),
        Some(axis.as_str()),
        "the fixture must be multi-file so `object_key` (the manifest blob) and \
         `content_hash` (the merkle root) are DIFFERENT strings — otherwise the value \
         census below cannot tell the two columns apart"
    );

    // Two artifacts ALIGNED to that axis, written the way a producer writes an aligned
    // column: the axis LABEL, their own length, and no `meta.is_axis_index`. They carry
    // no axis IDENTITY, because no producer emits one for a dependent — that is the
    // state of production, asserted here rather than papered over.
    //
    // WHAT THIS REPLACED, and why it was worth replacing. These two rows used to be
    // inserted with `structure.axis_key = <the key artifact's content_hash>`, and the
    // relation was then "resolved" by a query in this file over `structure->>'axis_key'`.
    // No producer writes that field and no server code reads it: the test supplied both
    // halves of its own subject and passed no matter what production did. The INV-3
    // behaviour the server really has is asserted by exercising the server —
    // `derive_axes` via `/catalog` below (each axis reported under its own
    // `content_hash`), and `CatalogRepository::find_dataset_axis_index` in
    // `test4_a_label_that_names_two_axes_is_refused_not_resolved_by_recency`.
    //
    // The half that is genuinely NOT implemented is stated as a gap instead of faked:
    // INV-3's "two artifacts over one axis relate solely through that artifact's
    // `content_hash`" has no dependent-side spelling. An aligned column names the axis
    // by LABEL and nothing else, so two same-label axes are indistinguishable FROM A
    // DEPENDENT'S POINT OF VIEW. A producer cannot close that on its own either: it
    // never learns the `content_hash`, which ingest mints downstream of it.
    for output_id in ["column_a", "column_b"] {
        let mut a = super::new_artifact(sid, output_id, "sha256:col", false);
        a.datatype = "data/opaque".into();
        a.content_hash = format!("sha256:{}", "c".repeat(64));
        a.structure = json!({
            "encoding": "zarr_v3", "kind": "column",
            "axis": "rows",        // the LABEL — the only thing a dependent declares
            "n": 4
        });
        repo.insert_artifact(&a).await.expect("insert dependent");
    }

    // ── the server records the axis's identity in exactly ONE place ───────────
    // POSITIVE CONTROL first: the same census, on a value the database really does
    // record in more than one table.
    let control = tables_containing(&pool, &sid.to_string()).await;
    assert!(
        control.len() >= 2,
        "the value census found the project id in {} table(s); it is written in at \
         least two (`projects` and `artifacts`), so the census is not looking \
         properly and the emptiness assertion below would be meaningless. Hits: \
         {control:?}",
        control.len()
    );

    let holders = tables_containing(&pool, &axis).await;
    assert_eq!(
        holders.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(),
        vec!["artifacts"],
        "the axis's identity is recorded outside `artifacts`. INV-3 says an axis IS \
         its key artifact: the ONLY record of it is that artifact's own row. A second \
         table holding it — a join table, an axis cache, a materialized membership — \
         is the name-keyed model returning under a new name. Hits: {holders:?}"
    );
    // Exactly ONE row: the key artifact's own. Nothing else in the database names it —
    // which is also, precisely, the gap recorded above: the dependents relate to their
    // axis by label, so the identity appears nowhere but on the axis itself.
    assert_eq!(
        holders[0].1, 1,
        "expected the key artifact's own row and nothing else; got {} rows",
        holders[0].1
    );
    // And in the key artifact's row it lives in `content_hash` — not duplicated into
    // some other column that a later query could start keying on.
    let columns_holding: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM artifacts
          WHERE id = $1 AND content_hash = $3
            AND (output_id LIKE $2 OR datatype LIKE $2 OR content_hash LIKE $2 OR
                 role LIKE $2 OR structure LIKE $2 OR meta LIKE $2)",
    )
    .bind(key.id)
    .bind(format!("%{axis}%"))
    .bind(&axis)
    .fetch_one(&pool)
    .await
    .expect("locate the hash on the key artifact row");
    assert_eq!(columns_holding, 1);

    // ── (3) NEGATIVE CONTROL — relabelling changes nothing stored or served ───
    // The SAME member bytes, ingested into another project under a DIFFERENT axis
    // label. If the label were load-bearing, something here would move.
    let relabelled = ingest_key_artifact(
        &server,
        &pool,
        &store,
        other,
        "row_keys",
        "a_completely_different_label",
        &key_members,
        4,
    )
    .await;
    assert_eq!(
        relabelled.content_hash, axis,
        "renaming the axis label changed the key artifact's IDENTITY. The identity is \
         the content hash of the bytes; the label is not an input to it"
    );
    assert_eq!(
        relabelled.object_key, key.object_key,
        "renaming the label moved the stored bytes"
    );

    let bytes_of = |id: Uuid| {
        let url = server.api_url(&format!("/artifacts/{id}/data/c/0"));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            let r = client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("member request");
            assert_eq!(r.status().as_u16(), 200);
            r.bytes().await.expect("body").to_vec()
        }
    };
    assert_eq!(
        bytes_of(key.id).await,
        bytes_of(relabelled.id).await,
        "renaming the label changed what the server SERVES"
    );

    // The label is what moved, and only the label. Cardinality — the one thing the
    // retired table computed with a name-keyed `COUNT(*)` — is unchanged, and nothing
    // was orphaned by the rename.
    let catalog = |project: Uuid| {
        let url = server.api_url(&format!("/projects/{project}/catalog"));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("catalog")
                .json::<Value>()
                .await
                .expect("catalog json")
        }
    };
    let relabelled_axes = catalog(other).await["axes"].clone();
    assert_eq!(
        relabelled_axes,
        json!([{
            // The IDENTITY is unchanged by the rename — same bytes, same content hash
            // (asserted above as `relabelled.content_hash == axis`).
            "content_hash": relabelled.content_hash,
            "name": "a_completely_different_label",
            "length": 4,
            // dimension-membership ITEM-31 — the axis's ordered KEY SEQUENCE digest, a
            // SECOND identity and not a duplicate of `content_hash` (a producer cannot name
            // a content hash; ingest mints it after the fact). `null` here because this
            // fixture's key artifact declares none, which is a state and not an error.
            //
            // The comparison stays a WHOLE-OBJECT equality rather than being relaxed to a
            // subset match: this assertion's job is that a RELABELLING moves a label and
            // nothing else, and a subset match would let a rename quietly change a field
            // nobody listed.
            "key_sequence_digest": null,
        }]),
        "the new label is reported against the SAME identity and the SAME cardinality \
         — a label moved, an axis did not"
    );

    // ── (4) a label does not identify: two different key artifacts, one label ──
    // Under `PRIMARY KEY (project_id, axis_name, entry_index)` this was a collision.
    let second_key = ingest_key_artifact(
        &server,
        &pool,
        &store,
        sid,
        "row_keys_v2",
        "rows", // the SAME label as the first key artifact
        &[
            (
                "zarr.json",
                br#"{"zarr_format":3,"node_type":"array","shape":[4]}"#,
            ),
            ("c/0", b"j0\0j1\0j2\0j3\0"), // …different bytes
        ],
        4,
    )
    .await;
    assert_ne!(
        second_key.content_hash, axis,
        "two key artifacts with different bytes must have different identities, \
         however they are labelled"
    );
    let by_label: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM artifacts
          WHERE project_id = $1 AND structure->>'axis' = 'rows'
            AND structure->>'kind' = 'table'",
    )
    .bind(sid)
    .fetch_one(&pool)
    .await
    .expect("count same-label key artifacts");
    assert_eq!(
        by_label, 2,
        "two key artifacts sharing a label must COEXIST — the label is not unique and \
         nothing in the server treats it as though it were"
    );

    // …and the SUMMARY the server SERVES says the same thing. This was the gap this
    // file recorded rather than papered over: `data_api::derive_axes` (then named
    // `derive_axis_lengths`) keyed a `BTreeMap` by the axis LABEL and folded same-label
    // declarations with `max(n)`, so `/catalog` reported these two distinct key
    // artifacts as ONE axis whose length was the max of two unrelated numbers — a
    // figure no producer declared. Grouping is now by the key artifact's
    // `content_hash`, which is what INV-3 says identity IS.
    //
    // Storage being right is not enough on its own: a read surface that folds by name
    // re-creates the identity confusion at the only place a user ever sees it.
    let served = catalog(sid).await["axes"].clone();
    let served = served.as_array().expect("catalog carries axes");
    let rows: Vec<&Value> = served.iter().filter(|a| a["name"] == "rows").collect();
    assert_eq!(
        rows.len(),
        2,
        "two key artifacts sharing a label must appear as TWO axes, not one folded \
         entry: {served:?}"
    );
    let identities: std::collections::BTreeSet<&str> = rows
        .iter()
        .filter_map(|a| a["content_hash"].as_str())
        .collect();
    assert_eq!(
        identities,
        [axis.as_str(), second_key.content_hash.as_str()]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        "each served axis carries ITS OWN key artifact's content hash — the identity, \
         not the label"
    );
    let lengths: std::collections::BTreeSet<i64> =
        rows.iter().filter_map(|a| a["length"].as_i64()).collect();
    assert!(
        lengths.iter().all(|n| *n == 4),
        "each length is the DECLARED `structure.n` of one artifact; nothing is folded \
         across artifacts: {served:?}"
    );
}

// ── (5) the production RESOLVER keys on identity, and refuses when it cannot ──

/// `CatalogRepository::find_dataset_axis_index` is the server's ONE production
/// resolution from an axis to its key artifact — the thing that decides which entity
/// set an integrate job aligns a supporting annotation table against.
///
/// It used to end `ORDER BY created_at DESC, id DESC LIMIT 1`, documented as "newest
/// `ready` row wins so a re-import supersedes". Where two rows are the same bytes that
/// is a harmless no-op; where they are NOT, it is recency posing as identity — the
/// caller silently receives whichever of two distinct entity sets was imported last, and
/// nothing downstream can tell. Every annotation row still lands, every coverage number
/// is still plausible, and the values are attached to the wrong entries.
///
/// So this asserts the three answers by IDENTITY (INV-3: an axis IS its key artifact and
/// its identity is that artifact's `content_hash`):
///
///   * nothing declared → `None` (absence is absence, INV-2),
///   * one identity → that artifact, even across several catalog rows carrying it,
///   * two identities under one label → an ERROR, not a ranking.
///
/// The fixtures are ingested through the real `ingest_run_outputs`, so the identities
/// under test are merkle roots the server minted, not strings the test invented.
#[tokio::test]
async fn test4_a_label_that_names_two_axes_is_refused_not_resolved_by_recency() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());
    let allow = metadata_column_family();

    // Dataset-scoped, not project-scoped: an IMPORTED dataset's artifacts carry
    // `dataset_id` with `project_id` NULL (ITEM-23), which is exactly the scope
    // `find_dataset_axis_index` searches.
    let dataset =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "axis-resolve-ds").await)
            .unwrap();

    let ingest = |output_id: &'static str, label: &'static str, keys: &'static [u8]| {
        let (server, pool, store) = (&server, &pool, &store);
        // DERIVED, not spelled. `allow` is the family's id-set from the registry; its
        // BASE is the type every member descends from, so it is the one whose
        // `descendants_inclusive` covers the whole set. A hardcoded id here would pin
        // this suite to one contributed bundle (INV-5) and rot the moment it is renamed.
        let allow_datatype = family_base(&allow).expect("the family base type is registry-derived");
        async move {
            ingest_key_artifact_scoped(
                server,
                pool,
                store,
                None,
                Some(dataset),
                &allow_datatype,
                output_id,
                label,
                &[
                    (
                        "zarr.json",
                        br#"{"zarr_format":3,"node_type":"array","shape":[4]}"# as &[u8],
                    ),
                    ("c/0", keys),
                ],
                4,
            )
            .await
        }
    };

    // (a) Nothing declared yet — the import has not run. Absence, not a guess.
    assert!(
        repo.find_dataset_axis_index(dataset, ROW_AXIS, &allow)
            .await
            .expect("a clean lookup")
            .is_none(),
        "an axis nobody declared must resolve to nothing"
    );

    // (b) ONE key artifact → itself.
    let first = ingest("rows_index", ROW_AXIS, b"k0\0k1\0k2\0k3\0").await;
    let got = repo
        .find_dataset_axis_index(dataset, ROW_AXIS, &allow)
        .await
        .expect("a single identity is unambiguous")
        .expect("resolved");
    assert_eq!(got.id, first.id);
    assert_eq!(got.content_hash, first.content_hash);

    // (c) The SAME bytes again under a different `output_id` — one identity, however
    // many rows carry it, so it stays resolvable. This is the case the recency ORDER BY
    // was justified by ("a re-import supersedes"), and it needs no ordering at all: the
    // same `content_hash` cannot be two axes.
    let same_bytes = ingest("rows_index_reimport", ROW_AXIS, b"k0\0k1\0k2\0k3\0").await;
    assert_eq!(
        same_bytes.content_hash, first.content_hash,
        "the fixture must re-ingest IDENTICAL bytes for this case to be about identity"
    );
    assert_ne!(same_bytes.id, first.id, "…as a distinct catalog row");
    let got = repo
        .find_dataset_axis_index(dataset, ROW_AXIS, &allow)
        .await
        .expect("two rows, one identity, no ambiguity")
        .expect("resolved");
    assert_eq!(
        got.content_hash, first.content_hash,
        "one identity resolves whichever row is returned"
    );

    // (d) A DIFFERENT key artifact under the SAME label. There is no correct pick.
    let second = ingest("rows_index_v2", ROW_AXIS, b"j0\0j1\0j2\0j3\0").await;
    assert_ne!(
        second.content_hash, first.content_hash,
        "different bytes, different identity — otherwise this case is not the case"
    );
    let err = repo
        .find_dataset_axis_index(dataset, ROW_AXIS, &allow)
        .await
        .expect_err(
            "a label naming TWO distinct key artifacts must not resolve to either of \
             them. Returning the newest is recency posing as identity: the integrate \
             job would align its annotation table against whichever entity set was \
             imported last, and every downstream number would look fine",
        );
    assert_eq!(err.error_code(), "AXIS_AMBIGUOUS");
    let msg = err.to_string();
    for identity in [&first.content_hash, &second.content_hash] {
        assert!(
            msg.contains(identity.as_str()),
            "the refusal must name WHICH identities collide, got: {msg}"
        );
    }

    // …and the refusal is about the LABEL, not about the dataset: a different label on
    // the same dataset still resolves. (Also the negative control for (d): if the
    // resolver had simply started failing, this would fail too.)
    let columns = ingest("columns_index", COL_AXIS, b"g0\0g1\0g2\0g3\0").await;
    let got = repo
        .find_dataset_axis_index(dataset, COL_AXIS, &allow)
        .await
        .expect("an unambiguous label still resolves")
        .expect("resolved");
    assert_eq!(got.id, columns.id);
}

// ════════════════════════════════════════════════════════════════════════════
//  #149 — TWO VIRTUAL DATASETS ON ONE AXIS KIND DO NOT COLLIDE
// ════════════════════════════════════════════════════════════════════════════

/// Insert a gathered KEY column exactly as the creator writes one: no bytes, a definition
/// `content_hash`, `meta.is_axis_index`, and a `structure` built by the creator's OWN
/// builder rather than restated here — so this fixture cannot describe a declaration the
/// creator does not produce.
async fn gathered_key_column(
    repo: &CatalogRepository,
    dataset: Uuid,
    datatype: &str,
    axis: &str,
    definition: &str,
) -> txresbench::modules::workstore::catalog::models::Artifact {
    use txresbench::modules::workstore::catalog::models::NewArtifact;
    use txresbench::modules::workstore::virtual_dataset::{gathered_structure, KeyIdentity};
    repo.insert_artifact(&NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id: Some(Uuid::new_v4()),
        output_id: "rows".to_string(),
        datatype: datatype.to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{definition}"),
        structure: gathered_structure(
            "utf8",
            Some("string"),
            axis,
            4,
            KeyIdentity::Carries(&format!("sha256:digest-{definition}")),
            json!({ "alignment_artifact_id": Uuid::new_v4(), "column_selector": "values" }),
        ),
        meta: json!({ "is_axis_index": true }),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(4),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("the gathered key column inserts")
}

/// **THE REGRESSION #149 COULD HAVE INTRODUCED, ASSERTED DIRECTLY.**
///
/// Before #149 a virtual dataset's key column declared the minted label `unified_rows`,
/// which collided with nothing precisely because nothing else ever used it. #149 makes it
/// declare the SOURCES' shared axis kind instead — so every virtual dataset in a project now
/// declares the SAME label as its sources and as every other virtual dataset built from
/// them.
///
/// If `AXIS_AMBIGUOUS` were keyed on the axis NAME, that change would start refusing axes
/// everywhere while looking correct in the diff. It is keyed on `content_hash` and scoped to
/// one dataset (INV-3), which is what this asserts — twice over:
///
///   * each virtual dataset resolves its OWN key column, by identity, under the shared label;
///   * a third dataset holding TWO distinct key artifacts under that same label still
///     refuses — the NEGATIVE CONTROL, without which "nothing collided" could equally mean
///     the collision check had stopped working.
#[tokio::test]
async fn two_virtual_datasets_sharing_an_axis_kind_do_not_collide() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let allow = metadata_column_family();
    let datatype = family_base(&allow).expect("the family base type is registry-derived");

    // The SHARED kind: two virtual datasets whose sources' rows were the same kind of thing
    // declare the same label — which is the entire point of #149 and the whole hazard.
    let shared = ROW_AXIS;

    let first = Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "virtual-a").await)
        .expect("dataset id");
    let second =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "virtual-b").await)
            .expect("dataset id");

    let key_a = gathered_key_column(&repo, first, &datatype, shared, "aaaa").await;
    let key_b = gathered_key_column(&repo, second, &datatype, shared, "bbbb").await;
    assert_ne!(
        key_a.content_hash, key_b.content_hash,
        "two virtual datasets must be two IDENTITIES, or this test is about nothing"
    );
    assert_eq!(
        key_a.structure["axis"], key_b.structure["axis"],
        "…wearing ONE label — the condition #149 creates and this test exists to survive"
    );

    for (dataset, expected) in [(first, &key_a), (second, &key_b)] {
        let got = repo
            .find_dataset_axis_index(dataset, shared, &allow)
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "a second virtual dataset wearing the same axis LABEL must not make either \
                     ambiguous — identity is the content hash, not the name (INV-3): {e}"
                )
            })
            .expect("the virtual dataset's own key column resolves");
        assert_eq!(got.id, expected.id);
        assert_eq!(
            got.content_hash, expected.content_hash,
            "each virtual dataset resolved its OWN key column, not its neighbour's"
        );
    }

    // NEGATIVE CONTROL — the refusal still fires where it should: ONE dataset, TWO distinct
    // key artifacts, one label. Without this, the two clean resolutions above would also be
    // satisfied by an ambiguity check that had been removed altogether.
    let third = Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "virtual-c").await)
        .expect("dataset id");
    gathered_key_column(&repo, third, &datatype, shared, "cccc").await;
    gathered_key_column(&repo, third, &datatype, shared, "dddd").await;
    let err = repo
        .find_dataset_axis_index(third, shared, &allow)
        .await
        .expect_err("two distinct key artifacts under one label, in ONE dataset, is ambiguous");
    assert_eq!(err.error_code(), "AXIS_AMBIGUOUS");
}
