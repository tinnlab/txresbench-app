//! **TEST-34 (ITEM-2) — the recipe's source-count rule, enforced in the database.**
//!
//! `structure.gathered_from.alignment_artifact_id` is nullable (§3.4-correction): a single-
//! source FILTER carries no join and rides a MASK, so its alignment is legitimately absent;
//! a MULTI-source integration fuses through an alignment that is the AUTHORITY no reader may
//! re-derive (INV-3). The `artifacts_recipe_alignment_or_single_source` CHECK
//! (`202608040010`) makes the asymmetry a database fact: `sources >= 2 ⇒ alignment NOT NULL`.
//!
//! This is a STATE guard, not a syntax guard (mirrors `artifacts_bytes_or_recipe`): it is
//! measured by INSERTing directly against the database and asserting the row is refused by
//! THIS constraint by NAME, so a future INSERT site that has never read `GatheredFrom::parse`
//! is bound too. Raw SQL (not the repository) is used deliberately — the repository maps the
//! sqlx error to a redacted 500, and the point is to prove WHICH constraint fired.

use serde_json::{json, Value};
use uuid::Uuid;

use super::{pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::create_dataset;

/// INSERT a GATHERED artifact (no stored bytes; the recipe rides `structure.gathered_from`)
/// straight against the pool, returning the raw sqlx result so a constraint name is visible.
async fn insert_gathered(
    pool: &sqlx::SqlitePool,
    dataset_id: Uuid,
    output_id: &str,
    structure: Value,
) -> Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error> {
    let hash = format!("sha256:{}", "d".repeat(64));
    sqlx::query(
        "INSERT INTO artifacts \
           (id, dataset_id, output_id, datatype, object_key, is_multifile, content_hash, \
            structure, meta, role, status, stored_bytes) \
         VALUES (randomblob(16), $1, $2, 'data/opaque', NULL, false, $3, $4, '{}', 'artifact', \
                 'ready', 0)",
    )
    .bind(dataset_id)
    .bind(output_id)
    .bind(hash)
    .bind(structure)
    .execute(pool)
    .await
}

/// **A multi-source recipe with a NULL alignment is REJECTED by name; a single-source masked
/// recipe with a null alignment is ACCEPTED (the control).**
///
/// nc (reject arm): drop the `artifacts_recipe_alignment_or_single_source` CHECK and the
/// two-source-no-alignment row commits — the serve path would then re-derive an intersection
/// nobody computed (INV-3).
/// nc (accept arm): make the alignment id NOT NULL again and the single-source filter — the
/// whole mask capability — cannot be represented at all.
#[tokio::test]
async fn a_multi_source_null_alignment_recipe_is_rejected_and_a_single_source_masked_one_is_accepted(
) {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let d: Uuid = create_dataset(&server, &token, "recipe-nullability")
        .await
        .parse()
        .unwrap();

    // ── REJECT: two sources, no alignment. The CHECK must refuse the row, by NAME. ────────
    let err = insert_gathered(
        &pool,
        d,
        "bad-multi",
        json!({ "gathered_from": {
            "column_selector": "values",
            "sources": [
                { "dataset_id": "ds-a", "artifact_id": Uuid::new_v4() },
                { "dataset_id": "ds-b", "artifact_id": Uuid::new_v4() },
            ],
        }}),
    )
    .await
    .expect_err(
        "a two-source gather with a null alignment_artifact_id must be refused by the \
         database — it would re-derive the join INV-3 forbids",
    );
    assert!(
        err.to_string()
            .contains("artifacts_recipe_alignment_or_single_source"),
        "refused by the WRONG constraint — must be the source-count rule: {err}"
    );

    // ── ACCEPT (control): one source, a mask reference, no alignment. The filter case. ────
    insert_gathered(
        &pool,
        d,
        "good-single",
        json!({ "gathered_from": {
            "column_selector": "values",
            "mask_artifact_id": Uuid::new_v4(),
            "sources": [
                { "dataset_id": "ds-a", "artifact_id": Uuid::new_v4() },
            ],
        }}),
    )
    .await
    .expect("a single-source masked recipe with a null alignment must be accepted");
}
