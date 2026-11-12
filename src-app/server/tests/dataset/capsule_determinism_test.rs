//! TEST-69 [ITEM-25, ITEM-22] — determinism. Running the exported capsule twice
//! yields BYTE-IDENTICAL output hashes (seed + thread pinning: `PYTHONHASHSEED=0`,
//! `OMP/OPENBLAS/MKL/NUMEXPR_NUM_THREADS=1`, `TXR_PROVENANCE_SEED`), proving the
//! reproduction is deterministic, not merely close.
//!
//! ROOTFS-GATED: self-skips when no analysis rootfs is mounted.

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

const DET_SCRIPT: &str = "import os, json\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/result.txt','w').write('determinism-payload')\n\
json.dump({'outputs':[{'id':'result','datatype':'file/upload','path':'result.txt','layout':'opaque','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'artifact'}]}, open('/outputs/manifest.json','w'))\n";

#[tokio::test]
async fn capsule_is_byte_deterministic_across_runs() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    if rootfs_gate(&server, &admin).await.is_none() {
        skip_no_rootfs("capsule_is_byte_deterministic_across_runs");
        return;
    }
    let project = create_project(&server, &admin, "capsule determinism project").await;
    let pool = pool_for(&server).await;

    let (run_id, signature) = run_real_analysis(
        &server, &admin, &pool, Some(project), None, "det",
        serde_json::json!({ "language": "python", "script": DET_SCRIPT, "inputs": [],
            "produces": [{ "id": "result", "datatype": "file/upload", "path": "result.txt", "layout": "opaque", "role": "artifact" }],
            "seed": 0 }),
    ).await;

    let export_id = export_bundle(&server, &admin, project, Some(run_id), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;

    // Run the capsule TWICE on independent clean workspaces.
    let (dir1, out1) = reproduce_capsule(&server, &admin, &zip, "det-1").await;
    assert!(
        out1.status.success(),
        "first run: {}",
        String::from_utf8_lossy(&out1.stderr)
    );
    let (dir2, out2) = reproduce_capsule(&server, &admin, &zip, "det-2").await;
    assert!(
        out2.status.success(),
        "second run: {}",
        String::from_utf8_lossy(&out2.stderr)
    );

    // Both runs regenerated the ORIGINAL output hash-for-hash …
    assert_reproduced(&dir1, &signature).await;
    assert_reproduced(&dir2, &signature).await;
    // … and each output's regenerated hash is IDENTICAL across the two runs.
    let h1 = capsule_regenerated_hashes(&dir1);
    let h2 = capsule_regenerated_hashes(&dir2);
    for (output_id, content_hash) in &signature {
        let hex = content_hash.strip_prefix("sha256:").unwrap_or(content_hash);
        assert!(
            h1.contains(hex) && h2.contains(hex),
            "output {output_id} is byte-identical across two capsule runs (deterministic)"
        );
    }
}
