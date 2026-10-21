//! Re-run verification (P4 ITEM-6/8/9/10/11/12/14/16) — TEST-10..17. Drives the
//! real REST surface; the sandbox re-run is mocked at its boundary by the
//! `_verify_rerun_fake` debug seam (release-compiled-out), so the endpoint →
//! orchestrator → comparison → persistence → sync → RO-Crate paths all run for
//! real. TEST-17 exercises the ACTUAL bwrap re-run (runtime-gated on a rootfs).
//!
//! TEST-7 (#295) — this file also pins #295's ITEM-4: `insert_verification` now BINDS
//! `verify::status::PENDING` instead of inlining the `'pending'` SQL literal, so the
//! constant the orphan ledger used to pin has a real consumer. The assertions below that
//! the POST returns `status == "pending"` immediately, and that a directly-seeded row is
//! reclaimed as a pending row, are what prove the bound value is byte-identical.

use std::sync::Arc;
use std::time::Duration;

use super::*;

use cytoanalyst::modules::datatype::registry::{set_global_registry, DatatypeRegistry};
use cytoanalyst::modules::provenance::repository::{NewRun, ProvenanceRepository};
use cytoanalyst::modules::workstore::object_store::{content_hash_of_path, ObjectStore};
use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;

// ------------------------------- seed helpers -------------------------------

/// Seed a recorded COMPUTE run (sidecar) whose `rerun_spec_json` = `spec`. Returns
/// the run id.
async fn seed_compute_run(pool: &PgPool, project_id: Uuid, spec: Value) -> Uuid {
    let run_id = Uuid::new_v4();
    let nr = NewRun {
        run_id,
        project_id: Some(project_id),
        dataset_id: None,
        kind: "compute".into(),
        status: "completed".into(),
        generator_id: "analysis".into(),
        generator_version: "test".into(),
        code_sha256: None,
        env_rootfs_sha256: None,
        lockfile_json: None,
        seed: Some(0),
        params: json!({ "seed": 0, "language": "python" }),
        inputs_json: json!([]),
        acting_user: None,
        rerun_spec_json: Some(spec),
    };
    ProvenanceRepository::new(pool.clone())
        .insert_run(&nr)
        .await
        .expect("seed compute run");
    run_id
}

/// Seed a catalog OUTPUT artifact produced by `run_id` (its recorded signature).
async fn seed_output(pool: &PgPool, project_id: Uuid, run_id: Uuid, output_id: &str, content_hash: &str) {
    CatalogRepository::new(pool.clone())
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id), // ITEM-23: project/dataset scope now nullable
            dataset_id: None,
            run_id: Some(run_id),
            output_id: output_id.into(),
            datatype: "embedding".into(),
            object_key: Some(content_hash.into()),
            is_multifile: false,
            content_hash: content_hash.into(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed output artifact");
}

/// A `rerun_spec_json` that short-circuits the sandbox with canned outputs.
fn fake_spec_outputs(outputs: &[(&str, &str)]) -> Value {
    let outs: Vec<Value> = outputs
        .iter()
        .map(|(id, h)| json!({ "id": id, "content_hash": h }))
        .collect();
    json!({ "_verify_rerun_fake": { "outputs": outs } })
}

/// POST /provenance/verify → the response.
async fn post_verify(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    run_id: Uuid,
    mode: Option<&str>,
) -> reqwest::Response {
    server
        .client
        .post(server.api_url("/provenance/verify"))
        .bearer_auth(token)
        .json(&json!({ "project_id": project_id, "target_run_id": run_id, "tolerance_mode": mode }))
        .send()
        .await
        .expect("post verify")
}

/// Poll GET /provenance/verifications until the run's latest verification reaches
/// a terminal status (or timeout). Returns the terminal status.
async fn await_status(server: &TestServer, token: &str, project_id: Uuid, run_id: Uuid) -> String {
    await_status_within(server, token, project_id, run_id, 20).await
}

/// `await_status` with an explicit budget — a REAL processor re-run through the
/// sandbox takes far longer than the seeded/faked reruns' 20 s.
async fn await_status_within(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    run_id: Uuid,
    secs: u64,
) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let resp = server
            .client
            .get(server.api_url(&format!(
                "/provenance/verifications?project_id={project_id}&target_run_id={run_id}"
            )))
            .bearer_auth(token)
            .send()
            .await
            .expect("list verifications");
        assert_eq!(resp.status().as_u16(), 200, "list is 200");
        let body: Value = resp.json().await.expect("list json");
        if let Some(v) = body["verifications"].as_array().and_then(|a| a.first()) {
            let status = v["status"].as_str().unwrap_or("");
            if status != "pending" {
                return status.to_string();
            }
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("verification did not reach a terminal status within {secs}s");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

// ---------------------------------- TEST-10 ----------------------------------

#[tokio::test]
async fn content_hash_matches_p1_catalog_identity() {
    // The verify re-run hashes outputs with the SAME identity P1's ingest writes
    // as the catalog `content_hash`. Run the REAL ingest against a
    // locally-constructed store (the runtime store lives in the server
    // SUBPROCESS, not this test process) and assert content_hash_of_path == the
    // stored catalog hash for both a single-file and a multi-file output — the
    // drift guard against P1's identity.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "hash identity project").await;
    let pool = pool_for(&server).await;

    let root = std::env::temp_dir().join(format!("verify-it-{}", Uuid::new_v4()));
    let ws = root.join("ws");
    // ingest resolves declared output paths relative to `<ws>/outputs` (the sandbox
    // `/outputs` bind) and reads the manifest from `<ws>/outputs/manifest.json`, so
    // both the output FILES and the manifest live under `<ws>/outputs/`.
    let out = ws.join("outputs");
    tokio::fs::create_dir_all(out.join("umap.zarr").join("sub")).await.unwrap();
    // A single-file output + a multi-file (dir) output, both under `<ws>/outputs/`.
    tokio::fs::write(out.join("x.bin"), b"embedding-payload").await.unwrap();
    tokio::fs::write(out.join("umap.zarr").join("b.bin"), b"BB").await.unwrap();
    tokio::fs::write(out.join("umap.zarr").join("sub").join("a.bin"), b"AA").await.unwrap();

    // ── the two DECLARATIONS the ingest gate reads ──────────────────────────────
    //
    // Publish the merged registry so `validate_artifact_typing` ALWAYS runs. This used
    // to be left to chance: the note here claimed the chosen datatypes made the test
    // immune to `--test-threads>1`, but `datatype::test22` publishes this same registry
    // into the process-wide holder at some arbitrary point, so whether the gate ran at
    // all depended on which test got there first — and the test passed in isolation
    // while failing in the suite. A gate that may or may not run is not a gate.
    let reg = Arc::new(DatatypeRegistry::build_from_embedded().expect("merged registry builds"));
    set_global_registry(reg.clone());
    // Each output declares a CONCRETE datatype and takes its layout string FROM THE
    // REGISTRY rather than repeating it. The pair is DECORATION for the property under
    // test — `store_output` decides single-file vs multi-file from `metadata.is_dir()`
    // on the path, never from the declared layout, which reaches only the gate — so this
    // test's business is content HASHING and it should ASK what a datatype's layout is
    // rather than keep a second copy of the answer.
    //
    // Keeping that second copy is precisely how this went red. It named
    // `single-cell/anndata` + `chunked-sparse`, true when written; the branch that
    // re-parented that IMPORT CONTAINER to `data/opaque` (nothing analyses an upload
    // format — it exists to be downloaded) left this the one site still claiming the
    // container holds a chunked-sparse store, and the gate answered LAYOUT_MISMATCH.
    let declared_layout = |id: &str| -> &'static str {
        reg.get(id)
            .unwrap_or_else(|| panic!("`{id}` is a registered datatype"))
            .storage
            .layout
            .as_storage_layout()
    };
    // A single-file blob type, and the type a processor really emits for a
    // DIRECTORY-shaped chunked store (`cyto_csc.write_csc_zarr`'s output).
    let single_file_dt = "file/upload";
    let multi_file_dt = "single-cell/expression";
    // The multi-file half must genuinely declare a multi-file layout, or this test
    // silently degrades into two single-blob cases and stops covering the merkle path.
    assert_ne!(
        declared_layout(multi_file_dt),
        declared_layout(single_file_dt),
        "`{multi_file_dt}` must declare a CHUNKED layout — the multi-file half of this \
         test is what pins the merkle-root identity"
    );
    tokio::fs::write(
        out.join("manifest.json"),
        serde_json::to_vec(&json!({ "outputs": [
            { "id": "x", "datatype": single_file_dt, "path": "x.bin", "layout": declared_layout(single_file_dt), "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" },
            { "id": "umap", "datatype": multi_file_dt, "path": "umap.zarr", "layout": declared_layout(multi_file_dt), "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" }
        ]}))
        .unwrap(),
    )
    .await
    .unwrap();

    // Ingest through P1's real write path (datatype validation runs — the registry is
    // published above) using a locally-constructed content-addressed store.
    let store = cytoanalyst::modules::workstore::object_store::LocalFsStore::new(&root.join("store"));
    let run_id = Uuid::new_v4();
    let rows = cytoanalyst::modules::workstore::ingest::ingest_run_outputs(
        &pool, &store, Some(project_id), None, run_id, None, &ws,
    )
    .await
    .expect("ingest outputs");
    assert_eq!(rows.len(), 2, "both outputs cataloged");

    for row in &rows {
        let src = out.join(if row.output_id == "x" { "x.bin" } else { "umap.zarr" });
        assert_eq!(
            content_hash_of_path(&src).await.unwrap(),
            row.content_hash,
            "content_hash_of_path == the catalog content_hash for output {}",
            row.output_id
        );
    }

    let _ = tokio::fs::remove_dir_all(&root).await;
}

// ------------------------------- TEST-11 / 12 --------------------------------

#[tokio::test]
async fn verify_reproduced_diverged_and_error() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "verify project").await;
    let pool = pool_for(&server).await;

    // A recorded run producing one output `embedding` @ sha256:aaa.
    let hash = format!("sha256:{}", "a".repeat(64));

    // (a) reproduced: the fake regenerates the exact recorded signature.
    let run_repro = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &hash)])).await;
    seed_output(&pool, project_id, run_repro, "embedding", &hash).await;
    let resp = post_verify(&server, &admin, project_id, run_repro, Some("tolerant")).await;
    assert_eq!(resp.status().as_u16(), 202, "verify accepted (async → 202)");
    let pending: Value = resp.json().await.unwrap();
    assert_eq!(pending["status"], "pending", "returns a pending row immediately");
    assert_eq!(await_status(&server, &admin, project_id, run_repro).await, "reproduced");

    // (b) diverged: the fake regenerates a DIFFERENT hash.
    let other = format!("sha256:{}", "b".repeat(64));
    let run_div = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &other)])).await;
    seed_output(&pool, project_id, run_div, "embedding", &hash).await;
    post_verify(&server, &admin, project_id, run_div, Some("exact")).await;
    assert_eq!(await_status(&server, &admin, project_id, run_div).await, "diverged");

    // (c) error: the fake reports a re-run failure.
    let run_err = seed_compute_run(&pool, project_id, json!({ "_verify_rerun_fake": { "error": "boom" } })).await;
    seed_output(&pool, project_id, run_err, "embedding", &hash).await;
    post_verify(&server, &admin, project_id, run_err, None).await;
    assert_eq!(await_status(&server, &admin, project_id, run_err).await, "error");
}

#[tokio::test]
async fn partial_rerun_never_reproduces_r7() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "r7 project").await;
    let pool = pool_for(&server).await;

    let h1 = format!("sha256:{}", "1".repeat(64));
    let h2 = format!("sha256:{}", "2".repeat(64));
    // Recorded: TWO outputs. The fake regenerates only ONE (a partial re-run).
    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("a", &h1)])).await;
    seed_output(&pool, project_id, run, "a", &h1).await;
    seed_output(&pool, project_id, run, "b", &h2).await;
    // Even in tolerant mode a missing output must NOT pass (R7).
    post_verify(&server, &admin, project_id, run, Some("tolerant")).await;
    assert_eq!(await_status(&server, &admin, project_id, run).await, "diverged");
}

// ---------------------------------- TEST-13 ----------------------------------

async fn read_until(resp: &mut reqwest::Response, needle: &str, overall: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + overall;
    let mut buf = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, resp.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if buf.contains(needle) {
                    return true;
                }
            }
            _ => return false,
        }
    }
}

#[tokio::test]
async fn verify_completion_emits_sync_frame() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "verify sync project").await;
    let pool = pool_for(&server).await;
    let hash = format!("sha256:{}", "c".repeat(64));
    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &hash)])).await;
    seed_output(&pool, project_id, run, "embedding", &hash).await;

    let mut stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&admin)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .expect("subscribe");
    assert_eq!(stream.status().as_u16(), 200);
    assert!(read_until(&mut stream, "connected", Duration::from_secs(5)).await, "handshake");

    let client2 = reqwest::Client::new();
    let resp = client2
        .post(server.api_url("/provenance/verify"))
        .bearer_auth(&admin)
        .json(&json!({ "project_id": project_id, "target_run_id": run, "tolerance_mode": "tolerant" }))
        .send()
        .await
        .expect("post verify");
    assert_eq!(resp.status().as_u16(), 202);

    assert!(
        read_until(&mut stream, "\"entity\":\"provenance_verification\"", Duration::from_secs(10)).await,
        "the owner's stream receives the provenance_verification sync frame on completion"
    );
}

// ---------------------------------- TEST-14 ----------------------------------

#[tokio::test]
async fn verify_authz_401_403_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "authz project").await;
    let pool = pool_for(&server).await;
    let hash = format!("sha256:{}", "d".repeat(64));
    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &hash)])).await;
    seed_output(&pool, project_id, run, "embedding", &hash).await;

    // 401 — no auth.
    let resp = server
        .client
        .post(server.api_url("/provenance/verify"))
        .json(&json!({ "project_id": project_id, "target_run_id": run }))
        .send()
        .await
        .expect("unauth verify");
    assert_eq!(resp.status().as_u16(), 401, "unauthenticated → 401");

    // 403 — a user WITHOUT provenance::export (A9 deny path).
    let denied = create_user_without_provenance(&server, &admin, "noexport", "noexport@cyto.test").await;
    let resp = post_verify(&server, &denied, project_id, run, None).await;
    assert_eq!(resp.status().as_u16(), 403, "lacking provenance::export → 403");

    // 404 — a foreign / nonexistent project (no leak).
    let resp = post_verify(&server, &admin, Uuid::new_v4(), run, None).await;
    assert_eq!(resp.status().as_u16(), 404, "foreign project → 404");
}

// --------------------- run-scoping + not-re-runnable edges -------------------

#[tokio::test]
async fn verify_run_from_another_project_is_404() {
    // The cross-project run-leak guard: a run that belongs to project B, targeted with
    // an ACCESSIBLE project A's id, must 404 (never re-run another project's run).
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_a = create_project(&server, &admin, "project A").await;
    let project_b = create_project(&server, &admin, "project B").await;
    let pool = pool_for(&server).await;
    let hash = format!("sha256:{}", "1".repeat(64));
    let run_b = seed_compute_run(&pool, project_b, fake_spec_outputs(&[("embedding", &hash)])).await;
    seed_output(&pool, project_b, run_b, "embedding", &hash).await;

    // admin can edit project A, but run_b belongs to B → get_run.filter(project==A) → 404.
    let resp = post_verify(&server, &admin, project_a, run_b, None).await;
    assert_eq!(resp.status().as_u16(), 404, "a run from another project → 404, no re-run");
}

#[tokio::test]
async fn verify_not_rerunnable_and_empty_signature_error() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "edge project").await;
    let pool = pool_for(&server).await;

    // (a) a run with NO captured compute spec (an interaction run) → error.
    let run_no_spec = Uuid::new_v4();
    ProvenanceRepository::new(pool.clone())
        .insert_run(&NewRun {
            run_id: run_no_spec,
            project_id: Some(project_id),
            dataset_id: None,
            kind: "selection".into(),
            status: "recorded".into(),
            generator_id: "provenance.selection".into(),
            generator_version: "test".into(),
            code_sha256: None,
            env_rootfs_sha256: None,
            lockfile_json: None,
            seed: Some(0),
            params: json!({}),
            inputs_json: json!([]),
            acting_user: None,
            rerun_spec_json: None, // NOT re-runnable via the compute path
        })
        .await
        .expect("seed no-spec run");
    let hash = format!("sha256:{}", "9".repeat(64));
    seed_output(&pool, project_id, run_no_spec, "embedding", &hash).await;
    post_verify(&server, &admin, project_id, run_no_spec, None).await;
    assert_eq!(await_status(&server, &admin, project_id, run_no_spec).await, "error");

    // (b) a compute run WITH a spec but ZERO recorded outputs → error.
    let run_empty = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &hash)])).await;
    post_verify(&server, &admin, project_id, run_empty, None).await;
    assert_eq!(await_status(&server, &admin, project_id, run_empty).await, "error");
}

// ---------------------------------- TEST-15 ----------------------------------

#[tokio::test]
async fn export_folds_verification_claim() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "verify export project").await;
    let pool = pool_for(&server).await;

    // A recorded run consuming the root + producing one output; verify it → reproduced.
    let out_hash = format!("sha256:{}", "e".repeat(64));
    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &out_hash)])).await;
    // Pin the run's used-edge to the seeded root so the backward walk terminates.
    sqlx::query("UPDATE provenance_run_repro SET inputs_json = $2 WHERE run_id = $1")
        .bind(run)
        .bind(json!([{ "slot": "input", "kind": "upload", "ref_id": root_id, "content_hash": root_hash }]))
        .execute(&pool)
        .await
        .expect("pin input edge");
    seed_output(&pool, project_id, run, "embedding", &out_hash).await;
    post_verify(&server, &admin, project_id, run, Some("tolerant")).await;
    assert_eq!(await_status(&server, &admin, project_id, run).await, "reproduced");

    // Export the run's closure → build a bundle.
    let resp = server
        .client
        .post(server.api_url("/provenance/export"))
        .bearer_auth(&admin)
        .json(&json!({ "project_id": project_id, "target": run, "scope": "single" }))
        .send()
        .await
        .expect("export");
    assert_eq!(resp.status().as_u16(), 200, "export is 200");
    let export_id = resp.json::<Value>().await.unwrap()["export_id"].as_str().unwrap().to_string();

    // Download the zip; assert it carries the verification claim + certificate.
    let dl = server
        .client
        .get(server.api_url(&format!("/provenance/export/{export_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("download");
    assert_eq!(dl.status().as_u16(), 200, "download is 200");
    let bytes = dl.bytes().await.unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("verification.json"), "the bundle contains a verification.json member");
    assert!(text.contains("reproducibility-verification"), "the manifest carries the ControlAction claim");
    assert!(text.contains("reproduced"), "the honest terminal status rides the bundle");
}

// ---------------------------------- TEST-16 ----------------------------------

#[tokio::test]
async fn project_delete_cascades_verifications() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "cascade project").await;
    let pool = pool_for(&server).await;
    let hash = format!("sha256:{}", "f".repeat(64));
    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &hash)])).await;
    seed_output(&pool, project_id, run, "embedding", &hash).await;
    post_verify(&server, &admin, project_id, run, None).await;
    await_status(&server, &admin, project_id, run).await;

    // Precondition: a verification row exists.
    let before: (i64,) = sqlx::query_as("SELECT count(*) FROM provenance_verifications WHERE project_id = $1")
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before.0, 1, "one verification recorded");

    // Delete the project via the real endpoint (runs the project-extension cascade).
    let resp = server
        .client
        .delete(server.api_url(&format!("/projects/{project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("delete project");
    assert!(resp.status().is_success(), "project delete: {}", resp.status());

    let after: (i64,) = sqlx::query_as("SELECT count(*) FROM provenance_verifications WHERE project_id = $1")
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after.0, 0, "verifications cascade away on project delete (no orphans)");
}

// --------------------------- boot reclamation --------------------------------

#[tokio::test]
async fn boot_reclamation_resolves_orphaned_pending() {
    // A `pending` verification orphaned by a restart (its detached task died with
    // the process) must not hang forever: the boot reclamation flips it to `error`.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "reclaim project").await;
    let pool = pool_for(&server).await;
    let hash = format!("sha256:{}", "7".repeat(64));
    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("embedding", &hash)])).await;

    // Insert a bare `pending` row directly (simulating one left mid-flight).
    let repo = ProvenanceRepository::new(pool.clone());
    let vid = Uuid::new_v4();
    repo.insert_verification(vid, run, project_id, "tolerant").await.expect("seed pending");

    // The boot reclamation resolves it (mirrors what ProvenanceModule::init runs).
    let n = repo.reset_pending_verifications().await.expect("reclaim");
    assert!(n >= 1, "at least the orphaned pending row was reclaimed");
    let row = repo.get_verification(vid).await.expect("get").expect("row");
    assert_eq!(row.status, "error", "orphaned pending → error, never hung");
    assert_eq!(row.diff_report["error"], "interrupted by a server restart");
}

// ---------------------------------- TEST-17 ----------------------------------

/// The REAL sandbox re-run — exercises the actual bwrap boundary the
/// `_verify_rerun_fake` seam stands in for, and the only test in this file that
/// does. Runtime-gated (a resource dependency, like the real-LLM tests keyed on an
/// API key) through the SHARED `hardening_common::rootfs_gate`, exactly like its
/// TEST-34/35 siblings below: it self-skips only when no rootfs is usable here,
/// and RUNS on any host where one is.
///
/// It used to gate on a bare `std::env::var("ZIEE_SANDBOX_ROOTFS")` — the LEGACY
/// seam. This branch standardised on `CYTO_ENV_ROOTFS_SQUASHFS` /
/// `CYTO_ENV_ROOTFS_DIR` / the live OCI pull, all of which `rootfs_gate` honors
/// (it still honors `ZIEE_SANDBOX_ROOTFS` too). Under the config the branch
/// documents, the bespoke check made this test report `ok … finished in 0.00s`
/// having executed NOTHING, in the very same run in which its siblings executed
/// against a real pinned rootfs — so "on a maintainer's box it asserts for real"
/// was never actually discharged. `rootfs_gate` additionally PROBES a real sandbox
/// execute, so a host with a rootfs it cannot run in skips honestly (into the skip
/// ledger) instead of false-failing.
#[tokio::test]
async fn real_sandbox_rerun_reproduces() {
    let test = "real_sandbox_rerun_reproduces";
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    if hc_rootfs_gate(&server, &admin).await.is_none() {
        hc_skip_no_rootfs(test);
        return;
    }
    let project_id = create_project(&server, &admin, "real rerun project").await;
    let pool = pool_for(&server).await;

    // A deterministic Python analysis that writes a fixed /outputs file + manifest.
    let script = "import os, json\n\
        os.makedirs('/outputs', exist_ok=True)\n\
        open('/outputs/result.txt','w').write('deterministic')\n\
        json.dump({'outputs':[{'id':'result','datatype':'data','path':'result.txt','layout':'opaque','structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{},'role':'primary'}]}, open('/outputs/manifest.json','w'))\n";
    let spec = json!({
        "language": "python",
        "script": script,
        "inputs": [],
        "produces": [{ "id": "result", "datatype": "data", "path": "result.txt", "layout": "opaque", "role": "primary" }],
        "seed": 0
    });
    let run = seed_compute_run(&pool, project_id, spec).await;
    // The recorded signature = the deterministic file's content identity, written
    // through the SERVER's own on-disk blob store.
    //
    // NOT `workstore::try_get_object_store()`: that reads a process-global OnceLock
    // initialised by the workstore module inside the SPAWNED SERVER process, so in
    // THIS test binary it is always `None` and the old `.unwrap()` panicked. That
    // line had never executed — the legacy `ZIEE_SANDBOX_ROOTFS` gate returned
    // before reaching it on every host (see the gate note above), which is exactly
    // the cost of a self-skip that reads as a PASS.
    let store = hc_server_store(&server);
    let key = store.put(b"deterministic").await.unwrap();
    seed_output(&pool, project_id, run, "result", key.as_str()).await;

    post_verify(&server, &admin, project_id, run, Some("exact")).await;
    // A REAL bwrap re-run (mount + spawn + interpreter start) does not fit the
    // faked reruns' 20 s default, especially on a loaded box — budget like the
    // TEST-34/35 siblings so a slow-but-correct run is not reported as a hang.
    assert_eq!(
        await_status_within(&server, &admin, project_id, run, 300).await,
        "reproduced",
        "a deterministic script reproduces its recorded output hash through the real sandbox"
    );
}

// ─────────────── TEST-34 + TEST-35 (ITEM-21, DEC-13) — UNMOCKED verify ───────────────
//
// Every assertion above but one injects the `_verify_rerun_fake` seam, so the comparator
// is validated against hashes THE TEST wrote; the single unmocked one
// (`real_sandbox_rerun_reproduces`) runs a 4-line toy script. Neither proves the verify
// path stays true for a REAL scientific pipeline — which is exactly the kind of hole that
// let the G3 capsule bug (a silently params-less replay) survive.
//
// These two record a REAL `cell.filter` / `qc.10x` run through the PRODUCT path — the
// workbench's own `POST /jobs {project_id, params}` (what `api.compute.run` submits),
// project-scoped because `POST /provenance/verify` verifies a run in ITS project — and
// then verify it with NO `_verify_rerun_fake` marker in the recorded spec: the rerun goes
// through the true sandbox and `diff::compare` diffs recorded-vs-RECOMPUTED
// `content_hash`es the test never wrote. Each carries the negative control that a
// PERTURBED recorded hash reports NOT-`reproduced` through the same unmocked path, so a
// comparator that trivially returns success cannot pass.
//
// Rootfs + fixture gated with a printed self-skip; never the compile-time ignore
// attribute, and a SKIP is recorded as SKIP — in the SKIP LEDGER
// (`hardening_common::record_skip`) as well as on stderr, so it survives libtest's
// default output capture and can be counted without `--nocapture`.

use crate::dataset::hardening_common::{
    attach_dataset as hc_attach_dataset, create_project as hc_create_project, gate as hc_gate,
    pinned_env_digest as hc_pinned_env_digest, rootfs_gate as hc_rootfs_gate,
    run_real_analysis as hc_run_real_analysis, server_store as hc_server_store,
    skip_no_rootfs as hc_skip_no_rootfs, upload_fixture as hc_upload_fixture,
    PBMC3K as HC_PBMC3K,
};

/// The uploaded dataset's single file id — the `dataset_file_ref` a PROJECT-scoped
/// analysis job binds (the same bytes a dataset-scoped run gets, staged through the
/// same authorized chokepoint).
async fn dataset_file_id(pool: &PgPool, dataset_id: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT file_id FROM dataset_files WHERE dataset_id = $1 LIMIT 1")
        .bind(dataset_id)
        .fetch_one(pool)
        .await
        .expect("the uploaded dataset has a file")
}

/// Record a REAL processor run on the pbmc3k fixture, verify it UNMOCKED, and assert
/// `reproduced` + the perturbed-hash negative control. Shared by both analyses so the two
/// stay symmetric.
async fn unmocked_verify_of_a_real_run(
    test: &str,
    project_name: &str,
    code_ref: &str,
    params: Value,
) {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = hc_gate(&server, &admin, test).await else {
        return;
    };
    let pool = pool_for(&server).await;

    let project_id = hc_create_project(&server, &admin, project_name).await;
    let dataset_id = hc_upload_fixture(&server, &admin, HC_PBMC3K, bytes).await;
    hc_attach_dataset(&server, &admin, project_id, dataset_id).await;
    let file_id = dataset_file_id(&pool, dataset_id).await;

    // The PROJECT-scoped analysis job the workbench submits, binding the dataset's own
    // h5ad at the slot the processors read.
    let (run_id, signature) = hc_run_real_analysis(
        &server,
        &admin,
        &pool,
        Some(project_id),
        None,
        test,
        json!({
            "language": "python",
            "code_ref": code_ref,
            "params": params,
            "inputs": [{
                "slot": "expression",
                "dataset_file_ref": file_id,
                "sandbox_subpath": "expression.h5ad",
            }],
        }),
    )
    .await;
    assert!(!signature.is_empty(), "{test}: the run cataloged its outputs");

    // A run with no pinned environment cannot be re-executed here — self-skip with the
    // reason printed rather than reporting a phantom pass.
    if hc_pinned_env_digest(&pool, run_id, test).await.is_none() {
        return;
    }

    // The recorded spec carries NO `_verify_rerun_fake` marker: this is the true sandbox.
    let spec: Option<Value> =
        sqlx::query_scalar("SELECT rerun_spec_json FROM provenance_run_repro WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .expect("read the recorded rerun spec");
    let spec = spec.expect("a compute run records a rerun spec");
    assert!(
        spec.get("_verify_rerun_fake").is_none(),
        "{test}: the rerun spec must be REAL — no debug seam: {spec}"
    );

    let resp = post_verify(&server, &admin, project_id, run_id, Some("exact")).await;
    assert_eq!(resp.status().as_u16(), 202, "{test}: verify is accepted");
    let status = await_status_within(&server, &admin, project_id, run_id, 600).await;
    if status != "reproduced" {
        let diff: Option<Value> = sqlx::query_scalar(
            "SELECT diff_report FROM provenance_verifications WHERE target_run_id = $1 \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .ok()
        .flatten();
        panic!(
            "{test}: a real analysis must reproduce from GENUINELY RECOMPUTED hashes — \
             got status={status}\nrecorded signature: {signature:?}\ndiff: {diff:?}"
        );
    }

    // ── negative control: perturb ONE recorded output hash. The same unmocked path must
    //    now report NOT-reproduced — a comparator that trivially succeeds fails here.
    let (output_id, _) = &signature[0];
    sqlx::query("UPDATE artifacts SET content_hash = $1 WHERE run_id = $2 AND output_id = $3")
        .bind(format!("sha256:{}", "f".repeat(64)))
        .bind(run_id)
        .bind(output_id)
        .execute(&pool)
        .await
        .expect("perturb one recorded output hash");

    let resp = post_verify(&server, &admin, project_id, run_id, Some("exact")).await;
    assert_eq!(resp.status().as_u16(), 202, "{test}: the second verify is accepted");
    let status = await_status_within(&server, &admin, project_id, run_id, 600).await;
    assert_ne!(
        status, "reproduced",
        "{test}: a perturbed recorded hash must NOT report reproduced (got {status})"
    );
}

/// TEST-34 — the `cell.filter` half.
#[tokio::test]
async fn unmocked_verify_reproduces_a_real_cell_filter_run() {
    unmocked_verify_of_a_real_run(
        "unmocked_verify_reproduces_a_real_cell_filter_run",
        "unmocked verify filter",
        "compute/cell-filter.py",
        json!({
            "criteria": [{ "column": "total_counts", "min": 1500 }],
            "label": "subset",
            "seed": 0,
        }),
    )
    .await;
}

/// TEST-35 — the `qc.10x` twin, so the real-analysis verify proof is not asymmetric.
#[tokio::test]
async fn unmocked_verify_reproduces_a_real_qc_10x_run() {
    unmocked_verify_of_a_real_run(
        "unmocked_verify_reproduces_a_real_qc_10x_run",
        "unmocked verify qc",
        "compute/qc-10x.py",
        json!({
            "fileType": "h5ad",
            "min_genes": 200,
            "max_pct_mito": 15,
            "min_cells": 3,
            "strategy": "fixed",
        }),
    )
    .await;
}

// ====================== the verification's `jobs` row ========================
//
// A verification re-run is a full bwrap child. It used to have NO `jobs` row, which
// meant three things at once, and only the first was obvious:
//
//   * INVISIBLE — absent from every jobs endpoint. Its only trace was a
//     `provenance_verifications` row, which says what the verdict was, not that a
//     process is running on the box right now.
//   * UNSTOPPABLE — nobody could end it. Not its requester, not the project owner,
//     not an admin. A re-run that wedged burned its full wall-clock budget.
//   * UNCOUNTED — the concurrency cap is `SELECT count(*) … WHERE status = 'running'`,
//     so a row-less run was worth ZERO to it. Verification enforced its own private
//     `Semaphore::new(4)` INSTEAD, and two independent caps over one CPU pool do not
//     compose into a bound; they compose into a sum. `max_concurrent_jobs = 2` could
//     mean six concurrent sandbox children with every mechanism reporting satisfied.
//
// Minting the row answers all three from the one fact the whole jobs surface is
// already keyed on. These tests assert each of the three separately, because a fix
// that delivered visibility and quietly kept the second cap would look identical from
// the outside.

/// Read the verification's `jobs` row off the LIST wire, as `token` sees it.
async fn find_verify_job(server: &TestServer, token: &str, id: Uuid) -> Option<Value> {
    let body: Value = server
        .client
        .get(server.api_url("/jobs?per_page=100"))
        .bearer_auth(token)
        .send()
        .await
        .expect("list jobs")
        .json()
        .await
        .expect("list json");
    body["jobs"]
        .as_array()
        .expect("jobs array")
        .iter()
        .find(|it| it["job"]["id"].as_str() == Some(&id.to_string()))
        .cloned()
}

/// Wait until `job_id` reaches a terminal status on the jobs surface.
async fn await_job_terminal(server: &TestServer, token: &str, job_id: Uuid) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let resp = server
            .client
            .get(server.api_url(&format!("/jobs/{job_id}")))
            .bearer_auth(token)
            .send()
            .await
            .expect("get job");
        assert_eq!(resp.status().as_u16(), 200, "the verification's job row is readable");
        let body: Value = resp.json().await.expect("job json");
        let status = body["job"]["status"].as_str().unwrap_or("").to_string();
        if matches!(status.as_str(), "completed" | "failed" | "stopped") {
            return status;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("the verification's job row never left {status}");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// **A verification is a job, and the jobs surface can see it.**
///
/// The id is deliberately shared with the verification row (it is also the name of
/// the sandbox workspace dir), so this asserts against the id the verify response
/// returned — if the row were minted under a second identity, nothing would tie the
/// listed run to the verification a user is watching.
#[tokio::test]
async fn a_verification_mints_a_listable_job_row_scoped_to_its_project() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "verify job row project").await;
    let pool = pool_for(&server).await;

    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("a", "sha256:1")])).await;
    seed_output(&pool, project_id, run, "a", "sha256:1").await;

    let resp = post_verify(&server, &admin, project_id, run, None).await;
    assert_eq!(resp.status().as_u16(), 202, "verify accepted");
    let vid: Uuid = resp.json::<Value>().await.expect("json")["id"]
        .as_str()
        .expect("verification id")
        .parse()
        .expect("uuid");

    let listed = find_verify_job(&server, &admin, vid)
        .await
        .expect("THE REGRESSION: the verification's re-run is listed as a job");
    assert_eq!(
        listed["job"]["job_type"].as_str(),
        Some("verify"),
        "job_type is `verify`, NOT `analysis` — reconcile_orphaned_running FINALIZES \
         and INGESTS an orphaned running ANALYSIS job at boot, and a verification must \
         never reach the catalog"
    );
    assert_eq!(
        listed["job"]["owner_id"].as_str().is_some(),
        true,
        "the row is owned by the requester"
    );

    // Scoped to the project — which is what makes it reachable by anyone other than
    // its creator. `?project_id=` filters through the `job_scope` JOIN, so a row with
    // no scope row would vanish from this list even though it is listed above.
    let scoped: Value = server
        .client
        .get(server.api_url(&format!("/jobs?per_page=100&project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("list scoped")
        .json()
        .await
        .expect("json");
    assert!(
        scoped["jobs"]
            .as_array()
            .expect("array")
            .iter()
            .any(|it| it["job"]["id"].as_str() == Some(&vid.to_string())),
        "the row carries a PROJECT scope — without it `resolve_job_reach` answers \
         creator-and-admin-only and the project owner is locked out of a run on their \
         own project"
    );

    assert_eq!(
        await_job_terminal(&server, &admin, vid).await,
        "completed",
        "the run's row closes when the run ends — a `running` row that never closes \
         permanently consumes a slot of max_concurrent_jobs"
    );
    assert_eq!(
        await_status(&server, &admin, project_id, run).await,
        "reproduced",
        "…and the verification itself still reaches its own verdict"
    );
}

/// **The verification obeys the SAME cap as everything else on the box.**
///
/// Burn the only slot with an ordinary job and the verify is refused. That refusal is
/// the whole point: before this, `max_concurrent_jobs = 1` plus a full jobs pool still
/// admitted four more sandbox children, because verification counted against a
/// different number.
#[tokio::test]
async fn verify_is_refused_when_the_job_pool_is_full() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "verify cap project").await;
    let pool = pool_for(&server).await;

    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 1 }))
        .send()
        .await
        .expect("set cap");
    assert_eq!(put.status().as_u16(), 200, "cap set to 1");

    let hold: Uuid = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(&admin)
        .json(&json!({ "job_type": "stub", "name": "burns-the-slot", "params": { "steps": 600 } }))
        .send()
        .await
        .expect("create holding job")
        .json::<Value>()
        .await
        .expect("json")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");

    // Wait for the scheduler to actually START it — the cap counts `running`, not
    // `queued`, so a queued holder would prove nothing.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let body: Value = server
            .client
            .get(server.api_url(&format!("/jobs/{hold}")))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("get")
            .json()
            .await
            .expect("json");
        if body["job"]["status"].as_str() == Some("running") {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "the holding job never started");
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("a", "sha256:1")])).await;
    seed_output(&pool, project_id, run, "a", "sha256:1").await;
    let resp = post_verify(&server, &admin, project_id, run, None).await;
    assert_eq!(
        resp.status().as_u16(),
        429,
        "THE REGRESSION: a verification is admitted under max_concurrent_jobs, not \
         alongside it"
    );

    // …and the refusal left NO stray rows behind, on either table.
    assert!(
        find_verify_job(&server, &admin, run).await.is_none(),
        "a refused verify minted no job row"
    );
    let listed: Value = server
        .client
        .get(server.api_url(&format!(
            "/provenance/verifications?project_id={project_id}&target_run_id={run}"
        )))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("list verifications")
        .json()
        .await
        .expect("json");
    assert_eq!(
        listed["verifications"].as_array().map(Vec::len),
        Some(0),
        "a refused verify left no stray `pending` verification either — admission \
         happens BEFORE any row is written"
    );

    // Negative control: the cap is the reason, not a blanket refusal. Free the slot
    // and the identical request is accepted.
    let stopped = server
        .client
        .post(server.api_url(&format!("/jobs/{hold}/stop")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("stop holder");
    assert_eq!(stopped.status().as_u16(), 200, "the holding job is stopped");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let again = post_verify(&server, &admin, project_id, run, None).await;
        if again.status().as_u16() == 202 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the slot never freed — verify stayed refused after the holder stopped"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// `shared_collaborator`, but with the user-CREATOR and the project-SHARER as separate
/// principals: only an admin may create a user, and only the project's owner may share
/// it, and in these tests the owner is deliberately not the admin.
async fn project_sharee(
    server: &TestServer,
    admin: &str,
    owner: &str,
    project_id: Uuid,
    username: &str,
    level: &str,
) -> String {
    let email = format!("{username}@cyto.test");
    create_user(server, admin, username, &email).await;
    let token = login(server, username).await;
    let share = server
        .client
        .post(server.api_url(&format!("/projects/{project_id}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": email, "permission_level": level }))
        .send()
        .await
        .expect("share project");
    assert!(share.status().is_success(), "share {level}: {}", share.status());
    let share_id = share.json::<Value>().await.expect("share json")["id"]
        .as_str()
        .expect("share id")
        .to_string();
    let acc = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("accept share");
    assert!(acc.status().is_success(), "accept share: {}", acc.status());
    token
}

/// **The run inherits the jobs module's stop rule — including its refusals.**
///
/// This is the join between the two halves of this change: the verification is now a
/// job, so `can_stop` on the wire and the `stop` gate grade it exactly as they grade
/// any other project-scoped run. The third-party EDITOR is the load-bearing principal:
/// they may watch a verification running on a project they edit, and they may not end
/// somebody else's run.
#[tokio::test]
async fn a_verification_job_grades_stop_like_every_other_project_scoped_run() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // A NON-ADMIN project owner, deliberately: an admin owner would satisfy every
    // `can_stop` through the admin wildcard, and the assertion "the project OWNER may
    // stop" would pass without the owner arm existing at all.
    create_user(&server, &admin, "vscowner", "vscowner@cyto.test").await;
    let owner = login(&server, "vscowner").await;
    let project_id = create_project(&server, &owner, "verify stop project").await;
    let editor = project_sharee(&server, &admin, &owner, project_id, "vsceditor", "editor").await;
    let viewer = project_sharee(&server, &admin, &owner, project_id, "vscviewer", "viewer").await;
    let pool = pool_for(&server).await;

    let run = seed_compute_run(&pool, project_id, fake_spec_outputs(&[("a", "sha256:1")])).await;
    seed_output(&pool, project_id, run, "a", "sha256:1").await;

    // The EDITOR requests it (they hold project edit, which `verify` requires), so the
    // creator and the project owner are different principals — the divergence that
    // makes the rule observable at all.
    let resp = post_verify(&server, &editor, project_id, run, None).await;
    assert_eq!(resp.status().as_u16(), 202, "an editor may request a verification");
    let vid: Uuid = resp.json::<Value>().await.expect("json")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");

    let creator = find_verify_job(&server, &editor, vid).await.expect("the creator sees their run");
    assert_eq!(creator["can_stop"].as_bool(), Some(true), "the creator may stop it");
    let by_owner = find_verify_job(&server, &owner, vid)
        .await
        .expect("THE REGRESSION: the PROJECT OWNER sees a verification running on their project");
    assert_eq!(
        by_owner["can_stop"].as_bool(),
        Some(true),
        "the project owner may stop a run on their own project"
    );
    assert!(
        find_verify_job(&server, &viewer, vid).await.is_none(),
        "a project VIEWER never sees the jobs surface — /jobs serves raw logs the \
         viewer surfaces deliberately redact"
    );

    // A second editor: sight without stop-authority, and the only 403 in the surface.
    let other = project_sharee(&server, &admin, &owner, project_id, "vscother", "editor").await;
    let seen = find_verify_job(&server, &other, vid)
        .await
        .expect("a third-party editor SEES the run on a project they edit");
    assert_eq!(
        seen["can_stop"].as_bool(),
        Some(false),
        "…and is TOLD, on the wire, that they may not end it — rather than being \
         shown a control that answers 403"
    );
    let refused = server
        .client
        .post(server.api_url(&format!("/jobs/{vid}/stop")))
        .bearer_auth(&other)
        .send()
        .await
        .expect("stop");
    assert_eq!(
        refused.status().as_u16(),
        403,
        "and the gate honors what the wire said — 403, not 404, because they can \
         already see it"
    );
}
