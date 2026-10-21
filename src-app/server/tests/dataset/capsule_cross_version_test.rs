//! TEST-68 [ITEM-25, ITEM-22] — a heterogeneous-environment capsule (step 1 `@D1`,
//! step 2 `@D2`) obtains + runs EACH step in its OWN pinned rootfs and reproduces.
//!
//! Needs TWO genuinely-distinct, obtainable rootfs digests — a resource a single-
//! rootfs box does not have. ROOTFS-GATED, and additionally self-skips (never
//! a compile-time ignore) unless a second rootfs digest is provided via
//! `ZIEE_SANDBOX_ROOTFS_D2` and is servable by this deployment.

use uuid::Uuid;

use cytoanalyst::modules::workstore::object_store::sha256_hex;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

const STEP1_SRC: &str = "import os\nos.makedirs('/outputs',exist_ok=True)\nopen('/outputs/o1.txt','w').write('STEP1-OUT')\n";
const STEP2_SRC: &str = "import os\nos.makedirs('/outputs',exist_ok=True)\nd=open('/inputs/o1.txt').read()\nopen('/outputs/o2.txt','w').write('STEP2:'+d)\n";

/// Is a rootfs digest servable by this deployment (obtainable)?
async fn servable(server: &TestServer, admin: &str, hex: &str) -> bool {
    server
        .client
        .get(server.api_url(&format!("/sandbox/rootfs/{hex}")))
        .bearer_auth(admin)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tokio::test]
async fn heterogeneous_env_capsule_runs_each_step_in_its_own_rootfs() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(d1) = rootfs_gate(&server, &admin).await else {
        skip_no_rootfs("heterogeneous_env_capsule");
        return;
    };
    // A second, DISTINCT rootfs digest (the "before an app update" env). An
    // explicit `ZIEE_SANDBOX_ROOTFS_D2` wins; otherwise obtain a REAL older
    // published env image (the immutable `schema<N>-<commit>-<arch>` build tag
    // alongside the moving `latest`) through the same oras+cosign chain the
    // runtime uses, and stage it so this deployment can serve it.
    let d2 = match std::env::var("ZIEE_SANDBOX_ROOTFS_D2") {
        Ok(v) if v.len() == 64 && v != d1 && servable(&server, &admin, &v).await => v,
        _ => match stage_second_env_image(&server, &d1).await {
            Ok(v) if servable(&server, &admin, &v).await => v,
            // R3-98: this was a bare `eprintln!`, which libtest CAPTURES — so the
            // run printed `ok` for a test that executed nothing, the skip never
            // reached `target/test-skip-ledger.tsv`, and `CYTO_TEST_NO_SKIP=1`
            // could not turn it into the hard failure an acceptance tier needs.
            // Every sibling gate goes through `record_skip`; so does this one now.
            //
            // R14: and the reason is now the one the helper actually hit, not a
            // catch-all. The catch-all it replaced ("no oras/registry reach") was
            // printed on a host where oras AND cosign are installed and the
            // registry resolves — the real cause was an unpublished in-process
            // extension registry, i.e. a harness fault, which the helper now
            // panics on rather than laundering through this arm. A skip line that
            // misnames its cause is worse than no skip line: it is read.
            Ok(v) => {
                record_skip(
                    "heterogeneous_env_capsule",
                    &format!(
                        "a second env image was staged ({v}) but this deployment does not serve \
                         it — GET /sandbox/rootfs/{v} did not succeed"
                    ),
                );
                return;
            }
            Err(why) => {
                record_skip(
                    "heterogeneous_env_capsule",
                    &format!(
                        "no second obtainable rootfs digest: {why}. Set ZIEE_SANDBOX_ROOTFS_D2 to \
                         a distinct servable digest to run this tier anyway"
                    ),
                );
                return;
            }
        },
    };
    assert_ne!(d1, d2, "the two pinned environments are genuinely distinct");
    eprintln!("[cross-version] step1 @ {d1}  step2 @ {d2}");

    let project = create_project(&server, &admin, "cross version capsule project").await;
    let pool = pool_for(&server).await;

    // Deterministic step outputs (their content identity is the file's blob sha).
    let h_o1 = format!("sha256:{}", sha256_hex(b"STEP1-OUT"));
    let h_o2 = format!("sha256:{}", sha256_hex(b"STEP2:STEP1-OUT"));

    // Step 1 @ D1.
    let sha1 = store_code(&pool, STEP1_SRC, "python").await;
    let run1 = Uuid::new_v4();
    let mut r = run_template(run1, Some(project), None);
    r.env_rootfs_sha256 = Some(d1.clone());
    r.code_sha256 = Some(sha1);
    r.params = serde_json::json!({ "seed": 0, "language": "python" });
    r.inputs_json = serde_json::json!([]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run1),
        "o1",
        &h_o1,
        "file/upload",
        false,
    )
    .await;

    // Step 2 @ D2 consumes step 1's output (by content_hash).
    let sha2 = store_code(&pool, STEP2_SRC, "python").await;
    let run2 = Uuid::new_v4();
    let mut r = run_template(run2, Some(project), None);
    r.env_rootfs_sha256 = Some(d2.clone());
    r.code_sha256 = Some(sha2);
    r.params = serde_json::json!({ "seed": 0, "language": "python" });
    r.inputs_json = serde_json::json!([used_edge("o1", "artifact", None, &h_o1)]);
    // The `/inputs`-relative PATH step 2 saw comes from the run's stashed re-run
    // spec (`inputs[].sandbox_subpath`, read by `bundle::input_subpaths_from_rerun`).
    // Without it the capsule binds the input at `/inputs/<content-hash>` and
    // `STEP2_SRC`'s `open('/inputs/o1.txt')` cannot resolve — the original defect
    // this test never surfaced, because it had never actually executed.
    r.rerun_spec_json = Some(serde_json::json!({
        "language": "python",
        "inputs": [{ "slot": "o1", "sandbox_subpath": "o1.txt" }],
        "seed": 0,
    }));
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run2),
        "o2",
        &h_o2,
        "file/upload",
        false,
    )
    .await;

    // Export the heterogeneous chain + run it — each step in its OWN pinned rootfs.
    let export_id = export_bundle(&server, &admin, project, Some(run2), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let env_txt = String::from_utf8_lossy(
        &unzip_store(&zip)
            .into_iter()
            .find(|(n, _)| n == "environments.json")
            .unwrap()
            .1,
    )
    .to_string();
    assert!(
        env_txt.contains(&d1) && env_txt.contains(&d2),
        "environments.json declares BOTH pinned digests"
    );

    let (dir, out) = reproduce_capsule(&server, &admin, &zip, "crossver").await;
    assert!(
        out.status.success(),
        "heterogeneous-env capsule executed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_reproduced(&dir, &[("o1".into(), h_o1), ("o2".into(), h_o2)]).await;
}
