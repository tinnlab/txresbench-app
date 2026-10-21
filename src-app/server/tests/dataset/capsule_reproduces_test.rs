//! TEST-65 [ITEM-25, ITEM-22] — the downloaded capsule is EXECUTABLE and produces
//! the RIGHT files. Running the exported capsule on a CLEAN workspace (no host
//! scanpy; squashfuse + bwrap; NO Docker) reproduces the ORIGINAL run's output
//! signature HASH-FOR-HASH — every `(output-id, content_hash)` equal.
//!
//! ROOTFS-GATED: self-skips at runtime (never a compile-time ignore) when no analysis rootfs is mounted;
//! RUNS + asserts hash-for-hash when one is.

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

const DET_SCRIPT: &str = "import os, json\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/result.txt','w').write('deterministic-payload-v1')\n\
json.dump({'outputs':[{'id':'result','datatype':'file/upload','path':'result.txt','layout':'opaque','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'artifact'}]}, open('/outputs/manifest.json','w'))\n";

#[tokio::test]
async fn exported_capsule_reproduces_hash_for_hash() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    if rootfs_gate(&server, &admin).await.is_none() {
        skip_no_rootfs("capsule_reproduces_hash_for_hash");
        return;
    }
    let project = create_project(&server, &admin, "capsule reproduce project").await;
    let pool = pool_for(&server).await;

    // A REAL deterministic analysis run → the original output signature.
    let (run_id, signature) = run_real_analysis(
        &server, &admin, &pool, Some(project), None, "det-run",
        serde_json::json!({ "language": "python", "script": DET_SCRIPT, "inputs": [],
            "produces": [{ "id": "result", "datatype": "file/upload", "path": "result.txt", "layout": "opaque", "role": "artifact" }],
            "seed": 0 }),
    ).await;
    assert!(!signature.is_empty(), "the run cataloged an output");

    // Export the capsule and EXECUTE it on a clean workspace (no host scanpy).
    let export_id = export_bundle(&server, &admin, project, Some(run_id), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let (dir, out) = reproduce_capsule(&server, &admin, &zip, "reproduce").await;
    assert!(
        out.status.success(),
        "the capsule run.sh executed successfully (no Docker): {}",
        String::from_utf8_lossy(&out.stderr)
    );
    // The no-Docker path was used.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("squashfuse-bwrap")
            || stdout.contains("apptainer")
            || stdout.contains("proot"),
        "the capsule ran via a NON-Docker runtime (got: {stdout})"
    );

    // Hash-for-hash: every original (output-id, content_hash) was regenerated.
    assert_reproduced(&dir, &signature).await;
}
