//! **TEST-30 / TEST-31 / TEST-47 [acceptance] [invariant: INV-2] [covers: ITEM-28/29/30/31]**
//!
//! > *"Lookup = same axis, non-empty membership intersection. An **indexed catalog match**;
//! > no data read."*
//!
//! The owner ruled that "indexed" means a REAL index, so this file asserts three things a
//! reading of the code cannot:
//!
//!  1. **The migration APPLIES against a real database, and the index exists with the
//!     expected expression and opclass** — read back out of `pg_indexes`. This is the
//!     `CREATE INDEX CONCURRENTLY` / `-- no-transaction` tripwire: sqlx wraps every
//!     migration in a transaction by default and `CONCURRENTLY` cannot run inside one, so
//!     without the directive the migration fails at BOOT. Nothing at compile time sees
//!     that, and no other migration in this tree carries the directive to copy.
//!  2. **`on_axis` returns exactly the artifacts declaring something about that axis**,
//!     across BOTH tenancy arms of `list_for_project_scope` (project-scoped rows and the
//!     rows of the project's attached datasets), compared as an id SET — a filter
//!     returning the right NUMBER of the wrong rows fails.
//!  3. **The SQL result is a strict SUPERSET of what the client offers.** This is the one
//!     that makes the two-filter design safe rather than redundant: SQL can only test
//!     declared containment, while A1/A2/A3/A4 is a judgment over identity, absence and
//!     intersection. A server filter that ever narrows MORE than the client silently
//!     deletes offers with no error anywhere.

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::catalog::ArtifactFilter;

use super::{create_project, pool_for, setup_admin};
use crate::common::TestServer;

const AXIS_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AXIS_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// members 0…9 and 100…109 — golden blobs from `cyto_zarr.encode_member_set`, so the
/// disjointness this corpus depends on is the producer's own encoding and not a local one.
const MEMBERS_0_TO_9: &str = "AQEBAQEBAQEBAQ==";
const MEMBERS_100_TO_109: &str = "ZQEBAQEBAQEBAQ==";

fn artifact(
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    output_id: &str,
    structure: Value,
) -> NewArtifact {
    NewArtifact {
        project_id,
        dataset_id,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "demo/column".to_string(),
        object_key: Some(format!("sha256:{output_id}")),
        is_multifile: false,
        content_hash: format!("sha256:{:0>64}", output_id),
        structure,
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: None,
        created_by: None,
        hidden: false,
        representation_of: None,
    }
}

fn membership(aligned_to: &str, kind: &str, n: i64, bitmap: Option<&str>) -> Value {
    let mut entry = json!({
        "axis": "rows",
        "aligned_to": aligned_to,
        "kind": kind,
        "n_members": n,
    });
    if let Some(b) = bitmap {
        entry["bitmap"] = json!(b);
    }
    json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "memberships": [entry] })
}

// ── 1. the migration, and the two directives ──────────────────────────────────────────

#[tokio::test]
async fn test31_the_membership_index_migration_applies_and_is_documented_as_gone() {
    // The server SPAWNED, which means the migrator ran the whole chain against this test's own
    // database. On the Postgres chain the load-bearing property is that the migration APPLIES:
    // without the `-- no-transaction` directive `CREATE INDEX CONCURRENTLY` aborts at BOOT,
    // and nothing at compile time sees that. The SQLite port of the migration is
    // comments-only (see `migrations-sqlite/workstore/202608280001_artifact_membership_index.sql`):
    // a GIN expression index has no SQLite form, so the staged file documents the divergence
    // and the runtime containment behaviour is pinned by `test30_on_axis_returns_exactly_the_
    // artifacts_declaring_that_axis` below.
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    let applied: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = 202608280001)",
    )
    .fetch_one(&pool)
    .await
    .expect("read migration history");
    assert!(
        applied,
        "the membership-index migration did not apply at boot — the `-- no-transaction` \
         tripwire would have aborted the chain"
    );

    let staged: Option<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master
          WHERE type = 'index' AND name = 'artifacts_membership_aligned_to_idx'",
    )
    .fetch_optional(&pool)
    .await
    .expect("sqlite_master");
    assert!(
        staged.is_none(),
        "a SQLite form of the GIN member-set index exists ({staged:?}); the staged migration \
         is comments-only and SQLite has no jsonb_path expression index — this would be an \
         undocumented divergence from the staged port"
    );
}

// ── 2. what `on_axis` returns ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test30_on_axis_returns_exactly_the_artifacts_declaring_that_axis() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "membership index").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // A dataset attached to the project — the SECOND tenancy arm of `list_for_project_scope`.
    // Seeded directly, because a filter that silently covered only the project-scoped arm
    // would pass a single-arm fixture and drop every imported artifact in production.
    let dataset_id: Uuid = sqlx::query_scalar(
        "INSERT INTO datasets (id, name, owner_id, account_id)
         VALUES (randomblob(16), 'attached', (SELECT id FROM users LIMIT 1),
                 (SELECT id FROM accounts WHERE kind = 'personal' AND personal_user_id = (SELECT id FROM users LIMIT 1)))
         RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .expect("seed dataset");
    sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)")
        .bind(project)
        .bind(dataset_id)
        .execute(&pool)
        .await
        .expect("attach dataset");

    let on_a = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "on-a",
            membership(AXIS_A, "full", 1000, None),
        ))
        .await
        .unwrap();
    let on_a_dataset = repo
        .insert_artifact(&artifact(
            None,
            Some(dataset_id),
            "on-a-ds",
            membership(AXIS_A, "subset", 10, Some(MEMBERS_0_TO_9)),
        ))
        .await
        .unwrap();
    let on_b = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "on-b",
            membership(AXIS_B, "full", 7, None),
        ))
        .await
        .unwrap();
    let legacy = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "legacy",
            json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "aligned_to": AXIS_A }),
        ))
        .await
        .unwrap();
    let undeclared = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "undeclared",
            json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows" }),
        ))
        .await
        .unwrap();

    let filter = ArtifactFilter {
        on_axis: Some(AXIS_A.to_string()),
        ..Default::default()
    };
    let got = repo
        .list_for_project_scope(project, &filter, None)
        .await
        .unwrap();
    let ids: std::collections::HashSet<Uuid> = got.iter().map(|a| a.id).collect();

    // The SET, never its size: a filter returning the right NUMBER of the wrong rows fails.
    assert_eq!(
        ids,
        [on_a.id, on_a_dataset.id, legacy.id, undeclared.id]
            .into_iter()
            .collect(),
        "on_axis must return both tenancy arms, the legacy spelling and the undeclared row"
    );
    // The one thing it DROPS, and the reason the narrowing is worth having: a row that
    // positively declares a DIFFERENT axis.
    assert!(
        !ids.contains(&on_b.id),
        "an artifact declaring another axis must be dropped"
    );

    // …and the SAME corpus against the OTHER axis returns the other one, so the filter is the
    // axis's doing and not a property of the fixture.
    let other = ArtifactFilter {
        on_axis: Some(AXIS_B.to_string()),
        ..Default::default()
    };
    let other_ids: std::collections::HashSet<Uuid> = repo
        .list_for_project_scope(project, &other, None)
        .await
        .unwrap()
        .iter()
        .map(|a| a.id)
        .collect();
    assert!(other_ids.contains(&on_b.id));
    assert!(!other_ids.contains(&on_a.id));

    // No filter ⇒ the listing is exactly what it was, byte for byte in membership terms.
    let unfiltered = repo
        .list_for_project_scope(project, &ArtifactFilter::default(), None)
        .await
        .unwrap();
    assert_eq!(unfiltered.len(), 5, "an absent `on_axis` narrows nothing");
}

// ── 3. INV-2 — the SQL result is a strict SUPERSET of what the client offers ───────────

#[tokio::test]
async fn test47_the_sql_filter_is_a_strict_superset_of_the_client_offer() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "superset").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // The corpus spans all four client states against an anchor whose coordinate declares
    // members 0…9 on AXIS_A.
    //   A1 — declares AXIS_A, members intersect          → offered
    //   A1 — declares AXIS_A via the LEGACY scalar       → offered
    //   A2 — declares AXIS_B                             → not offered
    //   A3 — declares nothing                            → offered
    //   A4 — declares AXIS_A, members DISJOINT           → not offered
    let a1 = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "a1",
            membership(AXIS_A, "subset", 20, Some(MEMBERS_0_TO_9)),
        ))
        .await
        .unwrap();
    let a1_legacy = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "a1legacy",
            json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "aligned_to": AXIS_A }),
        ))
        .await
        .unwrap();
    let a2 = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "a2",
            membership(AXIS_B, "full", 5, None),
        ))
        .await
        .unwrap();
    let a3 = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "a3",
            json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows" }),
        ))
        .await
        .unwrap();
    let a4 = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "a4",
            membership(AXIS_A, "subset", 10, Some(MEMBERS_100_TO_109)),
        ))
        .await
        .unwrap();

    let filter = ArtifactFilter {
        on_axis: Some(AXIS_A.to_string()),
        ..Default::default()
    };
    let sql: std::collections::HashSet<Uuid> = repo
        .list_for_project_scope(project, &filter, None)
        .await
        .unwrap()
        .iter()
        .map(|a| a.id)
        .collect();

    // EVERY id the client offers is in the SQL result. The client's judgment is not run here
    // (it is TypeScript, and `axisSource.test.ts` runs it over the identical corpus); what is
    // asserted is the CONTAINMENT the two filters must satisfy for the pair to be safe.
    for (id, why) in [
        (a1.id, "A1 — intersecting members"),
        (
            a1_legacy.id,
            "A1 — the legacy scalar spelling, which is every artifact today",
        ),
        (a3.id, "A3 — declares nothing, and is offered"),
        (
            a4.id,
            "A4 — the CLIENT drops it, but only the client can: SQL cannot intersect",
        ),
    ] {
        assert!(
            sql.contains(&id),
            "the SQL filter dropped an id the client offers ({why})"
        );
    }
    // …and it is STRICT: the SQL result contains rows the client's judgment drops (A4), which
    // is what makes the client's test load-bearing rather than a second copy of this one.
    assert!(sql.contains(&a4.id));
    // The only thing SQL can decide, and does: a positively-declared different axis.
    assert!(
        !sql.contains(&a2.id),
        "A2 is decidable in SQL and must be dropped"
    );
}

// ── the HTTP arm (ITEM-29 / ITEM-31): the filter reaches the wire ─────────────────────

#[tokio::test]
async fn test30_on_axis_is_accepted_on_the_catalog_endpoint() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "on_axis wire").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    let on_a = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "on-a",
            membership(AXIS_A, "full", 3, None),
        ))
        .await
        .unwrap();
    let on_b = repo
        .insert_artifact(&artifact(
            Some(project),
            None,
            "on-b",
            membership(AXIS_B, "full", 3, None),
        ))
        .await
        .unwrap();

    let resp = server
        .client
        .get(server.api_url(&format!("/projects/{project}/artifacts?on_axis={AXIS_A}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list artifacts");
    assert_eq!(resp.status().as_u16(), 200);
    let rows: Vec<Value> = resp.json().await.expect("json");
    let ids: std::collections::HashSet<String> = rows
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    assert!(ids.contains(&on_a.id.to_string()));
    assert!(
        !ids.contains(&on_b.id.to_string()),
        "an unknown query param would be IGNORED and this would still contain it — which is \
         exactly what a missing `on_axis` field on `ArtifactFilter` looks like"
    );
}

// ── TEST-6 [covers: ITEM-1, ITEM-4] — the producer's `memberships` array survives ingest ──────
//
// The host holds NO opinion about a producer's declaration: a PLURAL `memberships` array — the
// integrated-coordinate shape (INV-1) — must land on the catalog row and read back with its
// entries, their order, and every per-entry field intact, never normalised, reordered or
// defaulted by the server. This is the producer half of the off-by-thousands guard: if the host
// silently dropped the second entry or reordered the pair, an integrated coordinate would resolve
// on one axis and paint the wrong rows on the other with no error anywhere.
//
// nc (negative control): the re-read is compared to the EXACT input `Value`. Dropping either
// entry, swapping their order, or defaulting an absent field (e.g. inventing a `bitmap` or
// coercing `n_members`) makes the two `Value`s unequal and turns this red. The array is
// deliberately order-sensitive (entry B before entry A) and the two entries differ in `kind`,
// `n_members` and the presence of `bitmap`, so a right-sized-but-permuted result fails.
#[tokio::test]
async fn test6_memberships_survive_ingest_verbatim() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "membership verbatim").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // A plural declaration: two entries, order-sensitive (B first), with one carrying an inline
    // bitmap and the other not — the exact shape a two-axis integrated coordinate emits.
    let declared = json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": "rows",
        "memberships": [
            { "axis": "cols", "aligned_to": AXIS_B, "kind": "subset", "n_members": 10, "bitmap": MEMBERS_0_TO_9 },
            { "axis": "rows", "aligned_to": AXIS_A, "kind": "full",   "n_members": 1000 }
        ]
    });

    let inserted = repo
        .insert_artifact(&artifact(Some(project), None, "plural", declared.clone()))
        .await
        .unwrap();

    // Re-READ from the database (not the insert echo), so this proves PERSISTENCE and not merely
    // that the request body round-tripped in memory.
    let stored = repo
        .get_any_status(inserted.id)
        .await
        .unwrap()
        .expect("the artifact must exist after insert");

    assert_eq!(
        stored.structure, declared,
        "the server must persist the producer's `memberships` declaration verbatim — no entry \
         dropped, no order changed, no field defaulted"
    );
    // And specifically the array: entries, in order, byte-for-value identical.
    assert_eq!(
        stored.structure["memberships"], declared["memberships"],
        "the memberships ARRAY (order + per-entry fields) is the thing that must not be normalised"
    );
}
