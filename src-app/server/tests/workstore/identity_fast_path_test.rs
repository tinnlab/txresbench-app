//! **TEST-11 / INV-11 — the identity fast path is BYTE-EQUIVALENT to the general path (ITEM-15 / ITEM-6).**
//!
//! §11.1b: every dataset — real or virtual — is `(sources, mask, alignment)`; a real dataset is
//! the identity-mask, no-alignment case, served through the SAME entry point. The identity fast
//! path (a lone source, NO mask) is a byte-passthrough — but it must be PROVEN equivalent to
//! routing the same column through the resolver, never a second implementation that could drift.
//!
//! The general path here is the ALL-KEEP masked read: it forces the full filter/rank/segment
//! machinery (`MaskPlan::apply`) rather than the no-mask shortcut. Proving the no-mask fast path
//! is byte-identical to the all-keep general path is the equivalence INV-11 asserts.

use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::gather_exec::resolve;

use super::vdm_fixtures::{
    decode_f32, put_gathered, put_mask, put_source, resolved_bytes, structure_of,
};
use super::{create_project, pool_for, server_store, setup_admin};
use crate::common::TestServer;

/// The no-mask identity read and the all-keep general read produce byte-identical member bytes.
///
/// nc: perturb `MaskPlan::apply` for an all-true keep vector (drop/reorder a row) and the
/// all-keep arm diverges from the no-mask arm — the fast path would no longer equal the general
/// path. nc: route the no-mask lone-source read through a second, hand-rolled passthrough that
/// re-chunks differently and the byte comparison fails.
#[tokio::test]
async fn the_identity_fast_path_is_byte_equivalent_to_the_general_path() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "identity fast path").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let vals = [10.0f32, 20.0, 30.0, 40.0, 50.0];
    let src = put_source(&repo, &store, project, "src", &vals).await;

    // (a) the identity FAST PATH: a lone source, no mask (absence encodes identity, §11.1b).
    let identity = put_gathered(&repo, src, None, project, "identity", vals.len()).await;
    // (b) the GENERAL PATH: the same lone source through an ALL-KEEP mask, which routes the full
    //     mask machinery rather than the no-mask shortcut.
    let all_keep = put_mask(&repo, &store, project, "allkeep", &[true; 5]).await;
    let general = put_gathered(&repo, src, Some(all_keep), project, "general", vals.len()).await;

    let ra = resolve(
        &pool,
        &store,
        identity,
        &structure_of(&repo, identity).await,
    )
    .await
    .expect("identity resolves");
    let rb = resolve(&pool, &store, general, &structure_of(&repo, general).await)
        .await
        .expect("all-keep resolves");

    // Same length, same decoded values, and — the strong claim — byte-identical member bytes.
    assert_eq!(ra.n, rb.n, "identity and all-keep serve the same row count");
    assert_eq!(
        ra.n,
        vals.len(),
        "the identity read serves every source row"
    );
    assert_eq!(
        decode_f32(&ra),
        vals.to_vec(),
        "the identity read is the source's own column, unperturbed"
    );
    assert_eq!(
        resolved_bytes(&ra, 4),
        resolved_bytes(&rb, 4),
        "the identity fast path is BYTE-equivalent to the all-keep general path (INV-11)"
    );
}
