//! **ITEM-49 — the backfill created rows carrying BOTH scopes. Who can see them?**
//!
//! Until the backfill, `project_id` and `dataset_id` were XOR by convention, so the catalog's
//! two disjuncts (`project_id = $1 OR dataset_id IN (datasets attached to $1)`) were disjoint
//! sets. Seven live rows now carry both, and the question the plan calls "the item where a
//! mistake is an authorization mistake" is whether that changes who can see what.
//!
//! **The assertion that matters is not "each row appears once".** A dedup that quietly widened
//! visibility passes every count-based check ever written about it.

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::authz::{artifact_scope, ArtifactScope};
use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::catalog::ArtifactFilter;

use super::{create_project, pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::create_dataset;

/// **The by-artifact-id gate is unchanged by a dual-scope row, by construction.**
///
/// `artifact_scope` gives the PROJECT precedence when both columns are set, so a row the
/// backfill touched is still gated by its project — a user who could not reach it through
/// project P cannot reach it by knowing a dataset id. Pinned because that precedence is the
/// single line standing between the backfill and a byte-level disclosure, and it reads like a
/// defensive detail rather than a load-bearing rule.
#[test]
fn a_dual_scope_row_is_still_gated_by_its_project() {
    let p = Uuid::new_v4();
    let d = Uuid::new_v4();
    assert_eq!(artifact_scope(Some(p), Some(d)), ArtifactScope::Project(p));
    assert_eq!(artifact_scope(Some(p), None), ArtifactScope::Project(p));
    assert_eq!(artifact_scope(None, Some(d)), ArtifactScope::Dataset(d));
    assert_eq!(artifact_scope(None, None), ArtifactScope::None);
}

/// **The LISTING is where a dual-scope row can widen, and this measures whether it does.**
///
/// Scene: project P owns an artifact; dataset D is attached to BOTH P and Q. Before the
/// backfill the row is `(P, NULL)` and appears only in P's catalog. After it is `(P, D)` —
/// and D is attached to Q, so Q's second disjunct now matches it.
#[tokio::test]
async fn a_backfilled_row_does_not_appear_in_another_projects_catalog() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    let p = create_project(&server, &token, "scope owner").await;
    let q = create_project(&server, &token, "scope other").await;
    let d: Uuid = create_dataset(&server, &token, "shared-ds").await.parse().unwrap();

    // Attach D to BOTH projects — the shape that makes the second disjunct reachable.
    for proj in [p, q] {
        sqlx::query(
            "INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(proj)
        .bind(d)
        .execute(&pool)
        .await
        .expect("attach");
    }

    let art = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(p),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: "derived".into(),
            datatype: "metadata-column".into(),
            object_key: Some(format!("sha256:{}", "a".repeat(64))),
            is_multifile: false,
            content_hash: format!("sha256:{}", "a".repeat(64)),
            structure: json!({ "encoding": "opaque" }),
            meta: json!({}),
            role: "artifact".into(),
            stored_bytes: 1,
            logical_bytes: Some(1),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert")
        .id;

    async fn in_project(pool: &sqlx::PgPool, proj: Uuid, art: Uuid) -> usize {
        CatalogRepository::new(pool.clone())
            .list_for_project_scope(proj, &ArtifactFilter::default(), None)
            .await
            .expect("list")
            .into_iter()
            .filter(|a| a.id == art)
            .count()
    }

    // BEFORE — the pre-backfill shape. P sees it; Q does not. Both halves are the control:
    // without the first, "Q cannot see it" would also hold for a row nobody can see.
    assert_eq!(in_project(&pool, p, art).await, 1, "the owning project sees its own artifact");
    assert_eq!(in_project(&pool, q, art).await, 0, "…and the other project does not, before the backfill");

    // AFTER — exactly what the backfill does: fill dataset_id, leave project_id alone.
    sqlx::query("UPDATE artifacts SET dataset_id = $1 WHERE id = $2")
        .bind(d)
        .bind(art)
        .execute(&pool)
        .await
        .expect("backfill");

    assert_eq!(
        in_project(&pool, p, art).await,
        1,
        "the owning project must still see it exactly ONCE — both disjuncts now match this \
         row, and a query that returned it twice would double it in every consumer"
    );
    assert_eq!(
        in_project(&pool, q, art).await,
        0,
        "AND THE OTHER PROJECT STILL MUST NOT. The backfill filled a column; it did not \
         change who this artifact belongs to. If this is 1, the migration widened visibility \
         as a side effect — silent, and a disclosure of another project's derived work"
    );
}
