//! **TEST-7 / TEST-28 — INV-7 / INV-28: an ATTACHED artifact is served DIRECTLY (ITEM-10).**
//!
//! DEC-9 / D21: an attached artifact is ALWAYS a compute output of the dataset, hence on its row
//! space BY CONSTRUCTION — so the mask/row-mapping is NEVER applied to it (INV-7). The mask/gather
//! touches only the VD's GATHERED members (`object_key IS NULL`), never an attached artifact
//! (`object_key` present, a stored blob served through the byte-passthrough). INV-28: an attached
//! `n_kept × k` matrix member round-trips unmasked; routing it through the gather FAILS.

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::gather_exec::resolve;
use cytoanalyst::modules::workstore::object_store::ObjectStore;

use super::vdm_fixtures::{
    decode_f32, put_gathered, put_mask, put_multifile, put_source, structure_of, zarr_array, AXIS,
};
use super::{create_project, pool_for, server_store, setup_admin};
use crate::common::TestServer;

/// An ATTACHED 2-D matrix member: a STORED artifact (`object_key` present) with `k` numeric columns,
/// `n` rows — the shape a compute output attached to a dataset has (D21).
async fn put_attached_matrix(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    xs: &[f32],
    ys: &[f32],
) -> Uuid {
    let mut members = zarr_array(
        "coord_0",
        "float32",
        4,
        xs.iter().flat_map(|v| v.to_le_bytes()).collect(),
    );
    members.extend(zarr_array(
        "coord_1",
        "float32",
        4,
        ys.iter().flat_map(|v| v.to_le_bytes()).collect(),
    ));
    put_multifile(
        repo,
        store,
        project,
        output_id,
        members,
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": AXIS, "n": xs.len(),
            "columns": [
                { "name": "coord_0", "path": "coord_0", "kind": "numeric", "dtype": "float32",
                  "shape": [xs.len()], "axis": AXIS, "n": xs.len() },
                { "name": "coord_1", "path": "coord_1", "kind": "numeric", "dtype": "float32",
                  "shape": [ys.len()], "axis": AXIS, "n": ys.len() }
            ],
            "arrays": [],
        }),
        json!({}),
    )
    .await
}

/// **INV-7 — an attached artifact is served DIRECTLY; the mask is never applied to it.**
///
/// The attached matrix member is `object_key`-present ⇒ `is_gathered()` is FALSE ⇒ `serve_data_inner`
/// takes the byte-passthrough branch, never `serve_gathered_member`. Its declared row count is
/// unchanged — it does NOT resolve to `N_kept`. The CONTRAST proves the mask reaches gathered
/// members and never the attached one: the SAME logical row space, gathered through a dropping
/// mask, serves fewer rows.
///
/// nc: make `is_gathered()` (or the serve fork) treat an `object_key`-present artifact as
/// gathered and the attached matrix member would be run through the mask, dropping its rows.
#[tokio::test]
async fn an_attached_matrix_is_served_direct_and_the_mask_never_reaches_it() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "attached direct").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let xs = [1.0f32, 2.0, 3.0, 4.0, 5.0];
    let ys = [10.0f32, 20.0, 30.0, 40.0, 50.0];
    let attached = put_attached_matrix(&repo, &store, project, "emb", &xs, &ys).await;

    let row = repo
        .get_any_status(attached)
        .await
        .expect("read")
        .expect("row");
    assert!(
        !row.is_gathered(),
        "an attached artifact has stored bytes (object_key present) → served direct, never gathered"
    );
    assert_eq!(
        row.structure["n"],
        json!(5),
        "the attached matrix member declares its full row count — the mask never resolves it to N_kept"
    );
    assert!(
        row.structure.get("gathered_from").is_none(),
        "an attached artifact carries no gather recipe, so no mask reference can attach to it"
    );

    // CONTRAST: the same 5-row space, gathered through a dropping mask, DOES lose rows — proving
    // the mask applies to gathered members, not to the attached artifact beside them.
    let src = put_source(&repo, &store, project, "src", &xs).await;
    let mask = put_mask(
        &repo,
        &store,
        project,
        "mask",
        &[true, false, true, true, false],
    )
    .await;
    let gathered = put_gathered(&repo, src, Some(mask), project, "masked", 5).await;
    let masked = resolve(
        &pool,
        &store,
        gathered,
        &structure_of(&repo, gathered).await,
    )
    .await
    .expect("masked gather resolves");
    assert_eq!(masked.n, 3, "the GATHERED member is masked to N_kept…");
    assert_eq!(decode_f32(&masked), vec![1.0, 3.0, 4.0]);
}

/// **INV-28 — an attached matrix member round-trips unmasked; routing it through the gather FAILS.**
///
/// There is no path that masks an attached artifact: it has no `gathered_from` recipe (the
/// `artifacts_bytes_or_recipe` CHECK makes `object_key`-present ⟺ no recipe), so handing its
/// structure to the gather resolver is refused rather than silently masked.
///
/// nc: give `GatheredFrom::parse` a fallback recipe when `gathered_from` is absent and an attached
/// artifact could be routed through the mask.
#[tokio::test]
async fn routing_an_attached_artifact_through_the_gather_fails() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "attached no-gather").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let xs = [1.0f32, 2.0, 3.0];
    let ys = [4.0f32, 5.0, 6.0];
    let attached = put_attached_matrix(&repo, &store, project, "emb", &xs, &ys).await;

    let structure = structure_of(&repo, attached).await;
    // `ResolvedGather` is not `Debug`, so match rather than `expect_err`.
    let err = match resolve(&pool, &store, attached, &structure).await {
        Ok(_) => {
            panic!("an attached artifact has no recipe — the gather must refuse it, not mask it")
        }
        Err(e) => e,
    };
    let msg = format!("{err:?}");
    assert!(
        msg.contains("gathered_from") || msg.contains("GATHER_RECIPE_INVALID"),
        "the refusal must name the missing recipe, not mask an attached artifact: {msg}"
    );
}
