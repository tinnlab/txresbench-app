//! TEST-66 [ITEM-25, ITEM-22] — a 2-step capsule's `run.sh` regenerates step 1's
//! output and feeds it (by content_hash) to step 2 — step 2 reads the REGENERATED
//! file, and the final output hash matches the original.
//!
//! ROOTFS-GATED: self-skips when no analysis rootfs is mounted.

use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

const STEP1: &str = "import os, json\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/expr.txt','w').write('cells:100')\n\
json.dump({'outputs':[{'id':'expression','datatype':'file/upload','path':'expr.txt','layout':'opaque','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'artifact'}]}, open('/outputs/manifest.json','w'))\n";

// Step 2 reads step 1's regenerated file from /inputs and derives a deterministic output.
//
// It opens `/inputs/expression` — the SLOT, not `expr.txt`. ITEM-23 derives an
// artifact-backed mount name from the artifact (sanitized slot + a suffix read off
// `structure.encoding`), and step 1 declares `encoding: "opaque"` (see STEP1's manifest),
// so the artifact earns no suffix and binds at `/inputs/<slot>`. The spec's
// `sandbox_subpath` is ignored for an artifact input, in the live run AND in the capsule.
const STEP2: &str = "import os, json\n\
os.makedirs('/outputs', exist_ok=True)\n\
data = open('/inputs/expression').read()\n\
open('/outputs/filtered.txt','w').write('filtered:'+str(len(data)))\n\
json.dump({'outputs':[{'id':'filtered','datatype':'file/upload','path':'filtered.txt','layout':'opaque','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'artifact'}]}, open('/outputs/manifest.json','w'))\n";

#[tokio::test]
async fn two_step_capsule_wires_regenerated_output_to_next_step() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    if rootfs_gate(&server, &admin).await.is_none() {
        skip_no_rootfs("two_step_capsule_wires_regenerated_output_to_next_step");
        return;
    }
    let project = create_project(&server, &admin, "capsule multistep project").await;
    let pool = pool_for(&server).await;

    // Step 1 (real) → its expression artifact.
    let (run1, sig1) = run_real_analysis(
        &server, &admin, &pool, Some(project), None, "step1",
        serde_json::json!({ "language": "python", "script": STEP1, "inputs": [],
            "produces": [{ "id": "expression", "datatype": "file/upload", "path": "expr.txt", "layout": "opaque", "role": "artifact" }],
            "seed": 0 }),
    ).await;
    let expr_artifact: Uuid = sqlx::query_scalar(
        "SELECT id FROM artifacts WHERE run_id = $1 AND output_id = 'expression'",
    )
    .bind(run1)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Step 2 (real) consumes step 1's output artifact.
    //
    // The `sandbox_subpath` below is DELIBERATELY the wrong (ignored) value, and
    // deliberately kept: STEP2 opens `/inputs/expression`, so this run only completes —
    // in the LIVE run and again inside the capsule — if BOTH binds use the derived name.
    // That makes this test the end-to-end guard on the capsule recording what the run
    // actually mounted rather than what the spec declared: a capsule that re-read
    // `sandbox_subpath` would bind `/inputs/expr.txt` and step 2 would die on open().
    let (run2, sig2) = run_real_analysis(
        &server, &admin, &pool, Some(project), None, "step2",
        serde_json::json!({ "language": "python", "script": STEP2,
            "inputs": [{ "slot": "expression", "artifact_ref": expr_artifact, "sandbox_subpath": "expr.txt" }],
            "produces": [{ "id": "filtered", "datatype": "file/upload", "path": "filtered.txt", "layout": "opaque", "role": "artifact" }],
            "seed": 0 }),
    ).await;

    // Export the 2-step chain (target = the final run) and execute it.
    let export_id = export_bundle(&server, &admin, project, Some(run2), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let (dir, out) = reproduce_capsule(&server, &admin, &zip, "multistep").await;
    assert!(
        out.status.success(),
        "the 2-step capsule executed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Both the regenerated step-1 output AND the final step-2 output match the
    // originals hash-for-hash (step 2 read step 1's REGENERATED file).
    assert_reproduced(&dir, &sig1).await;
    assert_reproduced(&dir, &sig2).await;
}
