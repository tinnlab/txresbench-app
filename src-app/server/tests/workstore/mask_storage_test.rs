//! **ITEM-1 — the mask artifact's storage constraints, enforced in the database.**
//!
//! A mask is ONE `role='mask'`, `hidden=true` artifact OWNED by the virtual dataset
//! (`dataset_id=<VD>`), carrying REAL bytes and RECORDING its source dataset in
//! `meta.sources[]`. Two properties are database facts, not conventions:
//!
//! * **exactly one per VD** — the partial unique index `artifacts_one_mask_per_dataset
//!   (dataset_id) WHERE role='mask'` (`202608040009`) refuses a second mask for one dataset,
//!   the idempotency guard the finalize sink relies on (mirrors `datasets_one_per_alignment_run`).
//! * **records its source** — `meta.sources[].dataset_id` is how the sink links the VD to the
//!   dataset it filters (§3.4); a mask that recorded none leaves the VD's source unknowable.
//!
//! (The identity rule — an all-ones mask is never materialised, INV-11 — is a pure decision
//! pinned by `workstore::mask`'s in-source unit tests; here we measure the STORED constraints
//! that need a real Postgres to fail. The second-mask insert is raw SQL so the constraint NAME
//! is visible — the repository maps a violation to a redacted 500.)

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::mask::{mask_meta, mask_source_dataset_ids, MASK_ROLE};

use super::{pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::create_dataset;

/// A stored mask artifact owned by `vd`, recording `source` as the dataset it filters.
fn mask_artifact(vd: Uuid, output_id: &str, source: &str) -> NewArtifact {
    let hash = format!("sha256:{}", "e".repeat(64));
    NewArtifact {
        project_id: None,
        dataset_id: Some(vd),
        run_id: None,
        output_id: output_id.into(),
        datatype: "data/opaque".into(),
        // The mask carries REAL bytes — a STORED artifact under `artifacts_bytes_or_recipe`
        // (object_key present, no `gathered_from`).
        object_key: Some(hash.clone()),
        is_multifile: false,
        content_hash: hash,
        structure: json!({ "encoding": "opaque" }),
        meta: mask_meta(source),
        role: MASK_ROLE.into(),
        stored_bytes: 62_000,
        logical_bytes: Some(62_000),
        created_by: None,
        hidden: true,
        representation_of: None,
    }
}

/// **A virtual dataset owns EXACTLY ONE mask, and the mask records its source dataset_id.**
///
/// nc (unique arm): drop the `artifacts_one_mask_per_dataset` index and the second mask
/// commits — the VD then has two masks and nothing says which selects its rows.
/// nc (records-source arm): make `mask_meta` emit `{}` and the source read-back is empty — the
/// sink has no source to scope the VD, the detach guard nothing to protect.
#[tokio::test]
async fn a_virtual_dataset_owns_exactly_one_mask_that_records_its_source() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    let vd: Uuid = create_dataset(&server, &token, "vd-with-mask")
        .await
        .parse()
        .unwrap();

    // The FIRST mask commits and records its source dataset in meta.sources[].
    let first = repo
        .insert_artifact(&mask_artifact(vd, "mask-1", "ds-source"))
        .await
        .expect("the first mask of a virtual dataset must commit");
    assert_eq!(first.role, MASK_ROLE);
    assert!(
        first.hidden,
        "a mask is hidden — never listed as a first-class artifact"
    );
    assert_eq!(
        mask_source_dataset_ids(&first.meta),
        vec!["ds-source".to_string()],
        "the mask must record the source dataset it filters, or the VD's source is unknowable"
    );

    // A SECOND mask for the SAME virtual dataset (different output_id, so no natural-key
    // upsert) must be refused by the partial unique index — raw SQL so the NAME is visible.
    let hash = format!("sha256:{}", "f".repeat(64));
    let err = sqlx::query(
        "INSERT INTO artifacts \
           (id, dataset_id, output_id, datatype, object_key, is_multifile, content_hash, \
            structure, meta, role, status, stored_bytes, hidden) \
         VALUES (randomblob(16), $1, 'mask-2', 'data/opaque', $2, false, $2, \
                 '{\"encoding\":\"opaque\"}', '{}', 'mask', 'ready', 1, true)",
    )
    .bind(vd)
    .bind(hash)
    .execute(&pool)
    .await
    .expect_err("a virtual dataset must own exactly one mask — the second is refused");
    assert!(
        err.to_string().contains("UNIQUE constraint failed: artifacts.dataset_id")
            && !err.to_string().contains("output_id"),
        "refused by the WRONG constraint — must be the one-mask-per-dataset index: {err}"
    );
    // SQLite names no INDEX in a unique-violation message (it names the columns), so the
    // mechanism's NAME is pinned against the schema instead — the partial index over
    // `role = 'mask'` is what makes exactly one mask per virtual dataset a DB fact.
    let has_one_mask_index: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' \
                       AND name = 'artifacts_one_mask_per_dataset')",
    )
    .fetch_one(&pool)
    .await
    .expect("index census");
    assert!(
        has_one_mask_index,
        "the one-mask-per-dataset partial index is gone from the schema — the uniqueness \
         the insert above relies on would be a coincidence of something else"
    );
}

/// A `role='mask'`, `hidden` artifact is excluded from the USABLE population by construction
/// (`usable_artifacts` selects `role='artifact'`), so a mask never surfaces as an artifact a
/// user can act on — over and above the `hidden` flag keeping it off the listing.
#[tokio::test]
async fn a_mask_is_not_in_the_usable_population() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    let vd: Uuid = create_dataset(&server, &token, "vd-usable-check")
        .await
        .parse()
        .unwrap();
    repo.insert_artifact(&mask_artifact(vd, "mask-1", "ds-source"))
        .await
        .expect("mask insert");

    let usable: i64 =
        sqlx::query_scalar("SELECT count(*) FROM usable_artifacts WHERE dataset_id = $1")
            .bind(vd)
            .fetch_one(&pool)
            .await
            .expect("count usable");
    assert_eq!(
        usable, 0,
        "a mask (role='mask', hidden) is never part of the usable artifact population"
    );
}
