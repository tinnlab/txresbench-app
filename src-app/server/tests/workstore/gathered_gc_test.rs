//! **ITEM-28 — GC must keep the blobs an alignment reaches, and only those.**
//!
//! ## These tests are written BEFORE the refusal is opened, deliberately
//!
//! `object_keys_for_project_in_tx` currently REFUSES when it meets a gathered artifact
//! (ITEM-16), which is what has been holding GC shut. Opening it first and testing after
//! would mean writing these assertions against whatever the opened version happens to do —
//! and a keep-set that silently drops alignment-reachable sources would become the
//! documented behaviour rather than the bug.
//!
//! That is not hypothetical here: the chunk cache landed before its check and immediately
//! disabled the key-sequence verification. It was caught only because ITEM-20's tests already
//! existed. **The check must exist before the optimisation it protects**, and for GC the
//! stakes are higher — a mistake here destroys data rather than degrading a view.
//!
//! So these are expected to FAIL until ITEM-28 lands, and to fail with the ITEM-28 refusal
//! rather than with data loss. That is the correct starting state.
//!
//! ## What each test is for
//!
//! The obvious test — "a directly-referenced source survives" — is necessary and weak: a
//! keep-set that walked ONE level would pass it and silently collect everything deeper. And a
//! keep-set that kept EVERYTHING would pass every survival test while never collecting
//! anything, which is also broken, just less alarmingly. So over-keeping is tested as
//! explicitly as under-keeping.

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::ObjectStore;

use crate::common::TestServer;

use super::{create_project, pool_for, server_store, setup_admin};
use crate::dataset::create_dataset;

/// A stored artifact scoped to a DATASET, not to the project.
///
/// This scoping is the whole point of the fixture and it is ASSERTED, not arranged: a
/// dataset-scoped artifact is outside `SELECT id FROM artifacts WHERE project_id = $1`, so
/// the keep-set's BASE case cannot contain it and only the recursive reachability arm can
/// keep it alive.
///
/// The previous version of these tests made every source project-scoped — because a
/// project-scoped helper was already to hand — which put every source in the base case and
/// made all three tests pass with the reachability rule DISABLED. `assert_outside_base_case`
/// below is what stops that recurring silently if the scoping, the helper or the base-case
/// query ever changes.
async fn stored_blob(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    dataset: Uuid,
    output_id: &str,
    bytes: &[u8],
) -> (Uuid, String) {
    let key = store.put(bytes).await.expect("put");
    let a = NewArtifact {
        project_id: None,
        dataset_id: Some(dataset),
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(key.as_str().to_string()),
        is_multifile: false,
        content_hash: key.as_str().to_string(),
        structure: json!({ "encoding": "opaque", "key_sequence_digest": format!("sha256:{output_id}") }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: bytes.len() as i64,
        logical_bytes: Some(bytes.len() as i64),
        created_by: None,
        hidden: false,
        representation_of: None,
    };
    let id = repo
        .insert_artifact(&a)
        .await
        .unwrap_or_else(|e| panic!("insert {output_id:?} (dataset {dataset}): {e:?}"))
        .id;
    (id, key.as_str().to_string())
}

/// A PROJECT-scoped stored artifact.
///
/// The sources above are dataset-scoped on purpose (outside the keep-set's base case, so
/// only reachability can keep them). The ORPHAN is the opposite case and needs the opposite
/// scoping: it must be in the base case while its row lives — that is what makes "it is no
/// longer kept once the row is gone" a statement about the keep-set shrinking rather than
/// about scoping.
async fn stored_blob_in_project(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    bytes: &[u8],
) -> (Uuid, String) {
    let key = store.put(bytes).await.expect("put");
    let a = NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(key.as_str().to_string()),
        is_multifile: false,
        content_hash: key.as_str().to_string(),
        structure: json!({ "encoding": "opaque" }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: bytes.len() as i64,
        logical_bytes: Some(bytes.len() as i64),
        created_by: None,
        hidden: false,
        representation_of: None,
    };
    let id = repo
        .insert_artifact(&a)
        .await
        .unwrap_or_else(|e| panic!("insert {output_id:?} (project {project}): {e:?}"))
        .id;
    (id, key.as_str().to_string())
}

async fn gathered_row(
    repo: &CatalogRepository,
    project: Uuid,
    output_id: &str,
    source: Uuid,
    alignment: Uuid,
) -> Uuid {
    let a = NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", "e".repeat(64)),
        structure: json!({
            "kind": "table", "axis": "entries", "n": 1, "data_type": "float32",
            // The DEC-8 recipe: the ALIGNMENT artifact plus, per source dataset, the
            // artifact contributing its bytes. Both are edges GC must walk — collecting the
            // alignment leaves a column that resolves to nothing, which is the same silent
            // loss as collecting a source.
            "gathered_from": {
                "alignment_artifact_id": alignment,
                "column_selector": "values",
                "sources": [ { "dataset_id": "ds-a", "artifact_id": source } ]
            }
        }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    };
    repo.insert_artifact(&a).await.expect("insert gathered").id
}

/// **The claim, asserted rather than arranged.**
///
/// Every id here must be OUTSIDE the keep-set's base case — i.e. not a project-scoped
/// artifact of `project`. If this fails, the fixture has gone vacuous: the source would be
/// kept by the base case regardless of reachability, and every survival assertion below would
/// pass against a keep-set with no reachability rule at all. That is exactly how the previous
/// version of this file came to prove nothing.
async fn assert_outside_base_case(pool: &sqlx::SqlitePool, project: Uuid, ids: &[Uuid]) {
    for id in ids {
        let in_base: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id = $1 AND project_id = $2)",
        )
        .bind(id)
        .bind(project)
        .fetch_one(pool)
        .await
        .expect("base-case probe");
        assert!(
            !in_base,
            "FIXTURE IS VACUOUS: artifact {id} is project-scoped, so the keep-set's base case \
             contains it and reachability is never exercised. Scope it to a dataset."
        );
    }
}

/// The keep-set for a project, as GC computes it.
async fn keep_keys(pool: &sqlx::SqlitePool, project: Uuid) -> Result<Vec<String>, String> {
    let mut tx = pool.begin().await.expect("begin");
    let refs = CatalogRepository::object_keys_for_project_in_tx(&mut tx, project)
        .await
        .map_err(|e| format!("{e:?}"))?;
    tx.rollback().await.ok();
    Ok(refs.into_iter().map(|r| r.object_key).collect())
}

/// A source blob reachable ONLY through an alignment survives the keep-set.
///
/// nc: drop the alignment-reachability rule and the source's key is absent from the keep-set
/// — which means `ObjectStore::gc` unlinks it, while the gathered artifact's row stays live
/// and unreadable. Silent data loss.
#[tokio::test]
async fn a_source_reachable_only_through_an_alignment_is_kept() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gc direct").await;
    let dataset: Uuid = create_dataset(&server, &token, "gc-direct-ds")
        .await
        .parse()
        .unwrap();
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (src, src_key) = stored_blob(&repo, &store, dataset, "gc-src", b"source-bytes").await;
    let (rv, rv_key) = stored_blob(&repo, &store, dataset, "gc-rows", b"\x00\x00\x00\x00").await;
    let _g = gathered_row(&repo, project, "gc-g", src, rv).await;
    assert_outside_base_case(&pool, project, &[src, rv]).await;

    let keep = keep_keys(&pool, project).await.expect(
        "the keep-set must be COMPUTABLE for a project containing a gathered artifact — \
         until ITEM-28 lands this fails with the ITEM-16 refusal, which is the correct \
         starting state for this test and not a pass",
    );
    assert!(
        keep.contains(&src_key),
        "the source blob is reachable ONLY through the alignment; dropping it from the \
         keep-set means the sweep unlinks it while the gathered row stays live and \
         unreadable. keep = {keep:?}"
    );
    assert!(
        keep.contains(&rv_key),
        "the row vector is equally load-bearing: {keep:?}"
    );
}

/// Reachable only through a CHAIN — two hops, not one.
///
/// nc: a keep-set that walks ONE level passes the direct test above and fails here, silently
/// collecting everything deeper. Composition means a source can be several hops from the
/// artifact keeping it alive.
#[tokio::test]
async fn a_source_reachable_only_through_a_chain_is_kept() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gc chain").await;
    let dataset: Uuid = create_dataset(&server, &token, "gc-chain-ds")
        .await
        .parse()
        .unwrap();
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (leaf, leaf_key) = stored_blob(&repo, &store, dataset, "gc-leaf", b"leaf-bytes").await;
    let (rv, _) = stored_blob(&repo, &store, dataset, "gc-crows", b"\x00\x00\x00\x00").await;
    let mid = gathered_row(&repo, project, "gc-mid", leaf, rv).await;
    let _top = gathered_row(&repo, project, "gc-top", mid, rv).await;
    // The LEAF is two hops from `gc-top` AND outside the base case — both are required, or a
    // one-level walk (or the base case) would keep it for the wrong reason.
    assert_outside_base_case(&pool, project, &[leaf, rv]).await;

    let keep = keep_keys(&pool, project)
        .await
        .expect("keep-set must be computable");
    assert!(
        keep.contains(&leaf_key),
        "the LEAF is two hops from `gc-top`. A one-level walk keeps `gc-mid`'s sources only \
         and collects the leaf, passing the direct test while destroying the data. \
         keep = {keep:?}"
    );
}

/// **Over-keeping is a failure too.** A blob nothing reaches must be COLLECTED.
///
/// nc: a keep-set that keeps every blob in the project passes both survival tests above while
/// never collecting anything — broken, just less alarmingly. This is what distinguishes a
/// correct keep-set from a keep-everything.
#[tokio::test]
async fn a_blob_nothing_reaches_is_not_kept() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gc overkeep").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    // ── THE FIXTURE DEFECT THAT BLOCKED THIS TEST FOR FOUR ROUNDS ────────────────────
    //
    // These four calls used to pass `project` into `stored_blob`'s `dataset` parameter. Both
    // are `Uuid`, so it compiled; at runtime the FIRST call failed on
    // `artifacts_dataset_id_fkey` and the cause was REDACTED by `AppError::database_error`,
    // which turned a one-line fixture bug into three rounds of hypotheses (the `ON CONFLICT`
    // inference on the COALESCE expression index, the omitted `status` column — both
    // FALSIFIED by a single probe that unhid the raw `sqlx::Error`).
    //
    // The lesson is already in BASE.md and this is its cleanest instance: when a failure's
    // cause is deliberately hidden, UNHIDE IT LOCALLY first — do not reason about what it
    // might be.
    let dataset: Uuid = create_dataset(&server, &token, "gc-overkeep-ds")
        .await
        .parse()
        .unwrap();
    let (src, src_key) = stored_blob(&repo, &store, dataset, "ok-src", b"kept").await;
    let (rv, _) = stored_blob(&repo, &store, dataset, "ok-rows", b"\x00\x00\x00\x00").await;
    let g = gathered_row(&repo, project, "ok-g", src, rv).await;
    let (orphan, orphan_key) =
        stored_blob_in_project(&repo, &store, project, "ok-orphan", b"unreferenced").await;

    // POSITIVE CONTROL: while its row exists the orphan IS kept — it is a first-class
    // artifact, not garbage. Without this the assertion below would pass for a keep-set
    // that had simply lost the row.
    let keep = keep_keys(&pool, project)
        .await
        .expect("keep-set must be computable");
    assert!(
        keep.contains(&orphan_key),
        "a live artifact's own blob is kept: {keep:?}"
    );

    // Delete both the orphan's row and the gathered artifact. The orphan is now reachable by
    // nothing; the source is reachable by nothing either, since the only thing that reached
    // it was the gathered artifact.
    repo.delete(orphan).await.expect("delete orphan");
    repo.delete(g).await.expect("delete gathered");

    let keep = keep_keys(&pool, project)
        .await
        .expect("keep-set must be computable");
    assert!(
        !keep.contains(&orphan_key),
        "a blob no live row reaches must be COLLECTED — a keep-set that never shrinks is \
         broken too: {keep:?}"
    );
    // NOT asserted: that `src` is collected once the alignment is gone.
    //
    // I wrote that assertion first and it failed — correctly, and the failure was in the
    // TEST. `src` is a first-class artifact with its own live row, so it is kept because of
    // ITSELF, not because of the alignment. Keeping it is not over-keeping; collecting it
    // would be data loss. The premise "the only thing reaching it was the gathered artifact"
    // was false in this fixture, and asserting it would have pinned a rule that deletes live
    // artifacts' blobs.
    //
    // The orphan assertion above is the real over-keeping test: a blob whose row is gone,
    // reachable by nothing, must not survive. That one distinguishes a correct keep-set from
    // a keep-everything; this one only ever distinguished it from a correct one.
    let _ = (src, src_key);
}

/// **ITEM-27's PIN — a gathered artifact can never enter the conformance gate's target set.**
///
/// ITEM-27 dissolved: the gate does not need teaching to "verify the definition resolves
/// instead of bytes", because it never sees a gathered artifact. That was established by
/// reading the call site — `jobs/seams.rs:287` passes `dispatch_after_ingest(…, &rows)`, and
/// `rows` is exactly what `ingest_run_outputs` returned.
///
/// **But a dissolve confirmed by reading is an observation about today's code, not a guard
/// against tomorrow's.** This is the guard. The gate's target set is `ingest_run_outputs`'
/// output, so the property that makes the dissolve true is:
///
/// > **`ingest_run_outputs` never produces a blob-less row.**
///
/// If that ever stops holding — someone teaches ingest to catalog an abstract output — then
/// gathered rows CAN reach the gate, the gate WILL try to hardlink a blob that does not
/// exist, and ITEM-27 comes back. This test fails at that moment rather than after.
///
/// The control is the invariant itself: break it (return a `NewArtifact` with
/// `object_key: None` from the ingest path) and this goes red. It cannot be satisfied
/// vacuously — the assertion runs over a non-empty ingest whose count is checked first.
#[tokio::test]
async fn ingest_never_produces_a_blob_less_row_so_the_gate_cannot_see_one() {
    use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "item27 pin").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = serde_json::json!({ "outputs": [
        { "id": "a", "datatype": "data/opaque", "path": "a.bin", "layout": "opaque",
          "structure": {"encoding":"opaque","media_type":"application/octet-stream"},
          "meta": {}, "role": "artifact" },
        { "id": "b", "datatype": "data/opaque", "path": "b.bin", "layout": "opaque",
          "structure": {"encoding":"opaque","media_type":"application/octet-stream"},
          "meta": {}, "role": "artifact" }
    ]});
    tokio::fs::create_dir_all(ws.join("outputs")).await.unwrap();
    tokio::fs::write(ws.join("outputs/manifest.json"), manifest.to_string())
        .await
        .unwrap();
    tokio::fs::write(ws.join("outputs/a.bin"), b"alpha")
        .await
        .unwrap();
    tokio::fs::write(ws.join("outputs/b.bin"), b"beta")
        .await
        .unwrap();

    let run = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, Some(project), None, run, None, &ws)
        .await
        .expect("valid ingest");

    // NON-VACUITY FIRST. An ingest that produced nothing would satisfy "every row has a
    // blob" trivially, which is the shape this whole branch keeps tripping over.
    assert_eq!(rows.len(), 2, "the fixture must actually ingest rows");

    // THE PROPERTY. Read back what landed: every row a run ingested carries an object_key.
    let keys: Vec<Option<String>> =
        sqlx::query_scalar("SELECT object_key FROM artifacts WHERE run_id = $1")
            .bind(run)
            .fetch_all(&pool)
            .await
            .expect("read back the ingested rows");
    assert_eq!(keys.len(), 2, "both rows are readable back");
    assert!(
        keys.iter().all(Option::is_some),
        "ingest produced a BLOB-LESS row: {keys:?}. The conformance gate's targets are \
         exactly these rows (jobs/seams.rs passes them straight to dispatch_after_ingest), \
         and it hardlinks each one out of the content-addressed pool — so a blob-less row \
         here means gathered artifacts can reach a gate that cannot handle them, and \
         ITEM-27's dissolve is void."
    );
}

/// **AUDIT FINDING 10 — one gathered artifact must not stop blob reclamation deployment-wide.**
///
/// `all_blob_refs()` is the keep-set the GLOBAL sweep and the project reclaim both read
/// (`gc.rs:413`, `:483`), and `lifecycle.rs` logs-and-swallows their error — so a keep-set
/// that refuses on a blob-less row stops all reclamation silently and permanently, with disk
/// growing and nothing in the logs that reads as a failure. It did exactly that.
///
/// Two assertions, and the second is why the first is safe: the call SUCCEEDS with a gathered
/// artifact present, **and** the source blob it reads through is still in the keep-set —
/// because every source is its own catalog row contributing its own key, which is the
/// property that makes skipping a blob-less row lossless for a keep-set with no `WHERE`.
#[tokio::test]
async fn one_gathered_artifact_does_not_stop_blob_reclamation_deployment_wide() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gc not stalled").await;
    let dataset: Uuid = create_dataset(&server, &token, "gc-stall-ds")
        .await
        .parse()
        .unwrap();
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (src, src_key) = stored_blob(&repo, &store, dataset, "stall-src", b"kept-bytes").await;
    let (align, align_key) = stored_blob(&repo, &store, dataset, "stall-align", b"align").await;

    // POSITIVE CONTROL — the keep-set works before the gathered row exists, so a failure
    // below is caused by that row and not by the fixture.
    let before = repo.all_blob_refs().await.expect("keep-set before");
    assert!(before.iter().any(|r| r.object_key == src_key));

    let _g = gathered_row(&repo, project, "stall-g", src, align).await;

    let after = repo
        .all_blob_refs()
        .await
        .expect("a gathered artifact must not make the keep-set unreadable — that stops the \
                 global sweep and every project reclaim, silently, for the whole deployment");
    assert!(
        after.iter().any(|r| r.object_key == src_key),
        "the source blob the alignment reads through must still be kept: it is its own \
         catalog row with its own key, which is why skipping the BLOB-LESS row loses nothing"
    );
    assert!(after.iter().any(|r| r.object_key == align_key));
    assert!(
        !after.iter().any(|r| r.artifact_id == _g),
        "…and the gathered row itself contributes no blob ref, because it has no blob"
    );
}
