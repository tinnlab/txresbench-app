//! TEST-4 [acceptance] [invariant: INV-6] [covers: ITEM-5] [pins: PROV-T2-2] — the storage
//! byte-delta signal, on the REAL sites: ingest writes a +`stored_bytes` `storage_meter`
//! row IN THE INGEST TXN keyed by `content_hash`+`project_id`; the refcount-gated GC unlink
//! writes a −`stored_bytes` row; the signed sum over that `content_hash` reconciles to 0
//! after a full delete. This is the raw signal the deferred T5 rollup aggregates (DEC-5).
//!
//! Runs against `local_fs` (default profile) — the accounting is backend-independent, so it
//! needs no `saas`/cloud. A single-file artifact is used deliberately: its `content_hash`
//! equals its one blob's key, so the +delta (keyed on `content_hash`) and the −delta (keyed
//! on the freed blob hash) land under the SAME key and reconcile — exactly the shape T5's
//! per-hash rollup reads. (Multi-file member reconciliation is T5's, per DEC-5.)

use serde_json::json;
use uuid::Uuid;

use txresbench::modules::project::GcManifest;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::gc::GcSweeper;
use txresbench::modules::workstore::ingest::ingest_run_outputs;
use txresbench::modules::workstore::partition::StoreClaim;

use super::{create_project, pool_for, server_store, setup_admin, write_manifest};
use crate::common::TestServer;

/// The one row `storage_meter` holds per byte-delta event.
#[derive(Debug, sqlx::FromRow)]
struct MeterRow {
    content_hash: String,
    delta_bytes: i64,
    reason: String,
    project_id: Option<Uuid>,
    account_id: Option<Uuid>,
    logical_bytes: Option<i64>,
}

#[tokio::test]
async fn deltas_recorded_at_ingest_and_gc() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "storage meter").await;
    let pool = pool_for(&server).await;
    let store = std::sync::Arc::new(server_store(&server));

    // ── ingest a single-file artifact through the REAL ingest path ──────────────────
    const BODY: &[u8] = b"expression-matrix-bytes-for-metering";
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "expression", "datatype": "data/opaque", "path": "expr.bin",
          "layout": "opaque", "role": "artifact",
          "structure": { "encoding": "opaque" }, "meta": {} }
    ]});
    write_manifest(&ws, &manifest, &[("expr.bin", BODY)]).await;

    let run_id = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, store.as_ref(), Some(sid), None, run_id, None, &ws)
        .await
        .expect("ingest single-file artifact");
    assert_eq!(rows.len(), 1, "one artifact row");

    let repo = CatalogRepository::new(pool.clone());
    let art = repo
        .list_by_run(sid, run_id)
        .await
        .unwrap()
        .into_iter()
        .next()
        .expect("the ingested row");
    let content_hash = art.content_hash.clone();
    let object_key = art
        .object_key
        .clone()
        .expect("a single-file artifact owns a blob");
    // Single-file: the content identity IS the blob key (INV-5).
    assert_eq!(
        content_hash, object_key,
        "single-file content_hash == object_key"
    );
    let stored = art.stored_bytes;
    assert_eq!(stored, BODY.len() as i64, "stored_bytes is the file length");

    // Storage metering is CLOUD-only (INV-3 / DE-INV-10): rows are written iff the
    // `saas` cargo feature is on. On the desktop/default build the emit compiles out, so a desktop ingest
    // writes NO storage_meter row — this test proves BOTH: the account-keyed row under saas, and
    // its ABSENCE on desktop.
    let expected_account: Option<Uuid> =
        sqlx::query_scalar("SELECT account_id FROM projects WHERE id = $1")
            .bind(sid)
            .fetch_one(&pool)
            .await
            .expect("project account_id");
    assert!(
        expected_account.is_some(),
        "the test project resolves to an account (accounts baseline)"
    );

    // ── the +delta landed in the ingest txn (saas), keyed by content_hash + project + account ──
    let after_ingest = meter_rows(&pool, &content_hash).await;
    if cfg!(feature = "saas") {
        assert_eq!(
            after_ingest.len(),
            1,
            "exactly one +delta at ingest (saas): {after_ingest:?}"
        );
        let ing = &after_ingest[0];
        assert_eq!(ing.reason, "ingest");
        assert_eq!(ing.delta_bytes, stored, "the +delta is +stored_bytes");
        assert_eq!(ing.project_id, Some(sid), "keyed by the owning project");
        // TEST-5 [acceptance] [invariant: INV-2] — the +delta is ACCOUNT-keyed (T5): it carries
        // the project's account (account_of_project), and logical_bytes = the artifact's declared
        // logical size (== stored_bytes here; what B1 bills GB-months on). Never a user_id.
        assert_eq!(
            ing.account_id, expected_account,
            "the ingest +delta carries the project's account (INV-2), not a user_id"
        );
        assert_eq!(
            ing.logical_bytes,
            Some(stored),
            "ingest logical_bytes == the artifact's logical size (DEC-9)"
        );
    } else {
        assert!(
            after_ingest.is_empty(),
            "desktop/non-saas build writes NO storage_meter row (INV-3): {after_ingest:?}"
        );
    }

    // ── GC the blob and assert the −delta ───────────────────────────────────────────
    // Delete the catalog row so the blob is no longer in the live keep-set, then run the
    // refcount-gated post-commit sweep over a manifest that MARKED it.
    repo.delete(art.id).await.unwrap();
    let mut gc_manifest = GcManifest::for_project(sid);
    gc_manifest.mark(object_key.clone(), "catalog");

    let claim = StoreClaim::adopt_existing(server.data_dir().join("workstore"))
        .expect("the spawned server claimed its blob-store root at boot");
    let sweeper = GcSweeper::new(pool.clone(), store.clone(), claim);
    let report = sweeper.sweep_marked(&gc_manifest).await.unwrap();
    assert_eq!(
        report.freed, 1,
        "exactly the marked blob is freed: {report:?}"
    );
    assert_eq!(
        report.freed_bytes, stored as u64,
        "freed_bytes == the blob length"
    );

    // ── the −delta landed at the unlink (saas), and the signed sums reconcile to 0 ─────────
    let after_gc = meter_rows(&pool, &content_hash).await;
    if cfg!(feature = "saas") {
        assert_eq!(
            after_gc.len(),
            2,
            "ingest +delta and gc −delta, both present (saas): {after_gc:?}"
        );
        let gc = after_gc
            .iter()
            .find(|r| r.reason == "gc")
            .expect("a gc −delta row");
        assert_eq!(gc.delta_bytes, -stored, "the −delta is −stored_bytes");
        assert_eq!(
            gc.project_id,
            Some(sid),
            "the gc delta carries the project from the manifest"
        );
        // TEST-5 (gc leg): the −delta is account-keyed too; logical_bytes is SIGNED DOWN on a
        // reclaim (R1 fix) so the logical footprint reconciles to 0 (not billed forever).
        assert_eq!(
            gc.account_id, expected_account,
            "the gc −delta carries the project's account (INV-2)"
        );
        assert_eq!(
            gc.logical_bytes,
            Some(-stored),
            "a gc −delta credits the freed logical bytes DOWN (DEC-9 R1), so logical reconciles to 0"
        );

        // TEST-6 — the account-keying + logical additions do NOT regress T2's reconciliation:
        // BOTH the delta_bytes AND logical_bytes signed sums over a content_hash return to 0 after
        // a full ingest→GC delete (storage exactly-once by construction; no double-emit).
        let sum: i64 = after_gc.iter().map(|r| r.delta_bytes).sum();
        assert_eq!(
            sum, 0,
            "delta_bytes reconciles to 0 after full delete: {after_gc:?}"
        );
        let logical_sum: i64 = after_gc.iter().filter_map(|r| r.logical_bytes).sum();
        assert_eq!(
            logical_sum, 0,
            "logical_bytes reconciles to 0 too (no billed-forever): {after_gc:?}"
        );
    } else {
        assert!(
            after_gc.is_empty(),
            "desktop/non-saas build writes NO storage_meter row at ingest OR gc (INV-3): {after_gc:?}"
        );
    }

    // ── negative control: a SECOND sweep over the now-absent marked blob must NOT emit a
    //    phantom −0 delta nor count a phantom free ────────────────────────────────────────
    // `ObjectStore::delete` is idempotent (absent → Ok), so a naive `is_ok()`-gated sweep would
    // count the already-gone blob as freed AGAIN and write a −0 `storage_meter` row — an
    // affirmatively-false "freed 0 bytes of this hash" that corrupts the reconciliation. The fix
    // stats first and skips both the count and the delta when the length is unknown/absent.
    let report2 = sweeper.sweep_marked(&gc_manifest).await.unwrap();
    assert_eq!(
        report2.freed, 0,
        "an already-absent marked blob is not counted as freed again: {report2:?}"
    );
    let after_second = meter_rows(&pool, &content_hash).await;
    let expected_rows = if cfg!(feature = "saas") { 2 } else { 0 };
    assert_eq!(
        after_second.len(),
        expected_rows,
        "no phantom −0 delta row is written for an already-gone blob: {after_second:?}"
    );
    let sum2: i64 = after_second.iter().map(|r| r.delta_bytes).sum();
    assert_eq!(
        sum2, 0,
        "the reconciliation still holds after a redundant sweep"
    );
}

async fn meter_rows(pool: &sqlx::SqlitePool, content_hash: &str) -> Vec<MeterRow> {
    sqlx::query_as::<_, MeterRow>(
        "SELECT content_hash, delta_bytes, reason, project_id, account_id, logical_bytes \
         FROM storage_meter WHERE content_hash = $1 ORDER BY id",
    )
    .bind(content_hash)
    .fetch_all(pool)
    .await
    .expect("read storage_meter rows")
}
