//! TEST-6/7/8 (#66 / k8s-jobrun-dataplane) — the IN-POD one-shot executor
//! (`cytoanalyst run-job --job-id X`) the job-per-run `KubernetesBackend` pod runs.
//!
//! These drive the REAL `run-job` binary as a SUBPROCESS (the same entrypoint the pod runs),
//! sharing the test server's DB + `CYTO_APP_DATA_DIR` (so the same object store + sandbox rootfs
//! cache). This is the faithful in-pod proof: the executor forces the local bwrap backend and
//! reuses the SAME `materialize_inputs` + `finalize_analysis` as the worker-pod path, so the
//! inputs.json / `/outputs` contract is byte-identical (INV-1/INV-2) and a fetch failure fails
//! the job (INV-3). (Calling the in-process function cannot work: the harness runs the server in
//! a SEPARATE process, so the sandbox config + ingest seams live there, not in the test process.)
//!
//! The real-run leg is `rootfs_gate`-gated (self-skip → ledger, never a silent green). The
//! data-integrity FAULT leg needs no rootfs — a job that cannot obtain its inputs fails with NO
//! catalog whether the sandbox is unavailable or the input ref is unresolvable.

use std::path::Path;

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;

use super::setup_admin;
use crate::common::TestServer;
use crate::dataset::hardening_common::{create_project, pool_for, skip_no_rootfs};

const TEST_6_7: &str = "sandbox::jobrun_inpod::real_run";

async fn owner_id(pool: &sqlx::SqlitePool) -> Uuid {
    // The node's owner mint is `POST /session/local`, which IGNORES the request body
    // and always mints `admin`/`admin@localhost` (localsession.rs OWNER_USERNAME) —
    // the postgres leg's setup-admin route honored the posted `sbxadmin` name.
    sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("the setup-admin owner id")
}

/// Insert an ALREADY-CLAIMED (`running`) analysis job — the state the control plane leaves a job
/// in when it hands it to the job-per-run pod — marked a heavy resource class. Returns the id.
async fn running_heavy_job(
    pool: &sqlx::SqlitePool,
    owner: Uuid,
    project: Option<Uuid>,
    params: serde_json::Value,
) -> Uuid {
    let repo = JobRepository::new(pool.clone());
    let id = Uuid::new_v4();
    repo.create_running_under_cap(id, owner, "analysis", "jobrun-inpod", params, project, 100_000)
        .await
        .expect("insert running job")
        .expect("under cap");
    sqlx::query("UPDATE jobs SET resource_class = 'cluster-batch' WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .expect("mark heavy class");
    id
}

/// Write a minimal config.yaml pointing the `run-job` subprocess at the test server's
/// sqlite FILE (the `database.url` the harness hands the app — the config key
/// `ServerConfig` resolves), so the pod entrypoint boots the same assembly against the
/// same DB. The object store + sandbox rootfs are shared via `CYTO_APP_DATA_DIR`.
fn write_config(dir: &Path, database_url: &str) -> std::path::PathBuf {
    let cfg = format!(
        "database:\n  url: \"{database_url}\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3199\n  api_prefix: \"/api\"\nlogging:\n  level: \"info\"\n  format: \"pretty\"\njwt:\n  secret: \"jobrun-inpod-test-secret-key-at-least-32-characters\"\n  issuer: \"cytoanalyst\"\n  audience: \"cytoanalyst-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
    );
    let path = dir.join(format!("run-job-config-{}.yaml", Uuid::new_v4()));
    std::fs::write(&path, cfg).expect("write config");
    path
}

/// Run `cytoanalyst run-job --job-id <id>` as a subprocess against the shared DB + data dir.
/// Returns `(exit_code, combined_output)` — 0 iff the outputs were durably cataloged.
async fn run_job_subprocess(server: &TestServer, job_id: Uuid) -> (i32, String) {
    let bin = env!("CARGO_BIN_EXE_cytoanalyst");
    let data_dir = server.data_dir();
    let cfg = write_config(data_dir, server.database_url());

    let out = tokio::process::Command::new(bin)
        .args(["run-job", "--job-id", &job_id.to_string()])
        .env("CONFIG_FILE", &cfg)
        // Share the test server's object store + sandbox rootfs cache.
        .env("CYTO_APP_DATA_DIR", data_dir)
        // Belt (run_job_once also sets it): never claim/reconcile other jobs.
        .env("CYTO_SCHEDULER_ENABLED", "off")
        .output()
        .await
        .expect("spawn cytoanalyst run-job");
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // Surface the subprocess output for diagnosis.
    eprintln!("--- run-job output ---\n{combined}");
    (out.status.code().unwrap_or(-1), combined)
}

async fn artifact_rows(pool: &sqlx::SqlitePool, run: Uuid) -> Vec<(String, Option<String>)> {
    sqlx::query_as("SELECT content_hash, object_key FROM artifacts WHERE run_id = $1")
        .bind(run)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
}

// TEST-8 (acceptance / INV-3): a job that cannot obtain its inputs FAILS — the in-pod executor
// exits NON-zero and catalogs NOTHING (never runs on empty inputs, never a wrong/empty result).
// Needs no rootfs: `materialize_inputs` (or the backend precheck) rejects the run before any
// analysis executes. The data-integrity floor of the whole run-job path.
#[tokio::test]
async fn test_8_input_fetch_failure_fails_the_job_and_catalogs_nothing() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = owner_id(&pool).await;

    let bogus = Uuid::new_v4();
    let params = json!({
        "language": "python",
        "script": "open('/outputs/manifest.json','w').write('{\"outputs\":[]}')\n",
        "inputs": [{ "slot": "in", "artifact_ref": bogus }],
    });
    let job_id = running_heavy_job(&pool, owner, None, params).await;

    let (code, output) = run_job_subprocess(&server, job_id).await;
    assert_ne!(code, 0, "a job whose input fetch fails must exit non-zero (INV-3)");
    let rows = artifact_rows(&pool, job_id).await;
    assert!(
        rows.is_empty(),
        "a failed-input job catalogs NOTHING (never an empty/wrong result): {rows:?}"
    );
    // DISCRIMINATING (FIX-3): when the sandbox is usable here, the failure must be the INPUT
    // FETCH reaching `materialize_inputs` and failing there — NOT a bare backend-unavailable
    // precheck (which would make this test pass for the wrong reason). Only assert this where the
    // sandbox actually initializes; on a sandbox-less host the non-zero+no-catalog above already
    // upholds INV-3 (the job fails, never runs empty).
    if crate::dataset::hardening_common::rootfs_gate(&server, &token)
        .await
        .is_some()
    {
        assert!(
            !output.contains("sandbox NotInitialized")
                && !output.contains("compute backend unavailable"),
            "with the sandbox available, the failure must be the input fetch (materialize), not a \
             precheck — got:\n{output}"
        );
        assert!(
            output.contains("staging failed") || output.contains("inputs not fetched"),
            "the failure names the input-staging phase: {output}"
        );
    }
}

// TEST-6 (acceptance / INV-1) + TEST-7 (acceptance / INV-2): a REAL heavy-class analysis driven
// through the in-pod `run-job` entrypoint stages + runs + finalizes via the SAME contract as the
// worker path — it exits 0 and its declared output lands as a cataloged artifact whose object_key
// is the sha256 content blob written by `finalize_analysis`'s ingest (finalize reuse, INV-2). The
// analysis is unaware it ran "remotely" (INV-1, path-agnostic). rootfs-gated self-skip.
#[tokio::test]
async fn test_6_7_real_inpod_run_stages_and_catalogs_outputs() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    if crate::dataset::hardening_common::rootfs_gate(&server, &token)
        .await
        .is_none()
    {
        skip_no_rootfs(TEST_6_7);
        return;
    }

    let owner = owner_id(&pool).await;
    let project = create_project(&server, &token, "jobrun-inpod").await;

    let params = json!({
        "language": "python",
        "script": "import os, json\n\
os.makedirs('/outputs', exist_ok=True)\n\
open('/outputs/result.bin','wb').write(b'jobrun-inpod-output-bytes')\n\
json.dump({'outputs':[{'id':'result','datatype':'data/opaque','path':'result.bin',\
'layout':'opaque','role':'artifact','structure':{'encoding':'opaque'},'meta':{}}]},\
 open('/outputs/manifest.json','w'))\n",
    });
    let job_id = running_heavy_job(&pool, owner, Some(project), params).await;

    let (code, _output) = run_job_subprocess(&server, job_id).await;
    assert_eq!(code, 0, "the in-pod heavy-class analysis exits 0 (INV-1)");

    let rows = artifact_rows(&pool, job_id).await;
    assert_eq!(rows.len(), 1, "one cataloged output (INV-1): {rows:?}");
    let (content_hash, object_key) = &rows[0];
    assert!(!content_hash.is_empty(), "the output carries a content hash");
    let key = object_key.as_deref().expect("single-file artifact owns a blob (INV-2)");
    assert!(
        key.contains(content_hash),
        "the object_key is the content-addressed sha256 blob written by finalize's ingest: \
         key={key} hash={content_hash}"
    );
}
