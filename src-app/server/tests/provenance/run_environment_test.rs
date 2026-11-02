//! TEST-11 [acceptance] [invariant: INV-2] [covers: ITEM-12, ITEM-13] — a run's RESOLVED
//! library versions reach the PROVENANCE RECORD (#80).
//!
//! ## The invariant, and the exact thing being proven
//!
//! #80's second bullet ends "…and carried into the provenance record." The distinction
//! that clause is making matters: before this, a run's resolved versions existed only
//! inside a report ARTIFACT — a blob a reader would have to know to open, attached to the
//! outputs rather than to the run. `provenance_run_repro` has carried a `lockfile_json`
//! column since the provenance baseline migration and every construction site set it to
//! `None`, so the durable record of a run said which environment IMAGE it used and nothing
//! about which library versions produced the numbers.
//!
//! These tests drive the real `ProvenanceRunRecorder` over real outputs and read the
//! column back out of Postgres. They deliberately do NOT run a sandboxed compute: the
//! bytes a compute writes are covered by `_lib/test_deps.py`, and a real sandbox run
//! self-skips wherever the rootfs is a build stub — which would make the one test that
//! proves the provenance half silently vacuous on most machines. What is tested here is
//! the seam that was missing: outputs in, column out.
//!
//! RED ON REVERT: restore `lockfile_json: None` in `build_new_run` and the first test
//! fails on a NULL column.

use super::*;

use cytoanalyst::modules::jobs::models::Job;
use cytoanalyst::modules::jobs::seams::{PeakMetrics, RunRecorder};
use cytoanalyst::modules::provenance::recorder::{
    ProvenanceRunRecorder, RUN_ENVIRONMENT_OUTPUT_ID,
};
use cytoanalyst::modules::provenance::repository::ProvenanceRepository;
use cytoanalyst::modules::sandbox::outputs::ProducedOutput;

/// A synthetic completed analysis job (the shape `recorder_test` uses, minus the inputs
/// this test does not need — the seam under test is outputs → column).
fn analysis_job(owner: Uuid, root_id: Uuid) -> Job {
    Job {
        id: Uuid::new_v4(),
        owner_id: owner,
        job_type: "analysis".into(),
        name: "run-environment-test".into(),
        status: "completed".into(),
        params: json!({
            "language": "python",
            "script": "print('ok')\n",
            "inputs": [
                { "slot": "input", "artifact_ref": root_id, "sandbox_subpath": "input.bin" }
            ],
            "produces": [],
            "seed": 11
        }),
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        exit_code: Some(0),
        error: None,
        pid: None,
        priority_class: "normal".into(),
        resource_class: "cpu-sandbox".into(),
        req_cpu: None,
        req_mem_bytes: None,
        run_id: None,
    }
}

async fn admin_id(pool: &SqlitePool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin user id")
}

async fn seed_job_scope(pool: &SqlitePool, job: &Job, project: Uuid) {
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1, $2, $3, $4, $5)")
        .bind(job.id)
        .bind(job.owner_id)
        .bind(&job.job_type)
        .bind(&job.name)
        .bind(&job.status)
        .execute(pool)
        .await
        .expect("seed jobs row");
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(job.id)
        .bind(project)
        .execute(pool)
        .await
        .expect("seed job_scope row");
}

/// One `ProducedOutput` pointing at a real file on disk — the shape the runner hands the
/// recorder after ingest.
fn produced(id: &str, host_path: std::path::PathBuf) -> ProducedOutput {
    ProducedOutput {
        id: id.to_string(),
        // A domain-free datatype: this test is about the recorder's seam, which reads the
        // output by ID and never interprets its datatype.
        datatype: "data/opaque".into(),
        rel_path: host_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("x.json")
            .to_string(),
        layout: "opaque".into(),
        role: "artifact".into(),
        label: None,
        meta: json!(null),
        hidden: true,
        host_path,
    }
}

/// A workspace dir with the staged entry the recorder hashes.
fn workspace(tag: &str) -> std::path::PathBuf {
    let ws = std::env::temp_dir().join(format!("cyto-runenv-{tag}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(ws.join("code")).unwrap();
    std::fs::write(ws.join("code").join("entry.py"), "print('ok')\n").unwrap();
    ws
}

#[tokio::test]
async fn the_resolved_library_versions_reach_the_provenance_run_row() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "run environment project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    let job = analysis_job(owner, root_id);
    let job_id = job.id;
    seed_job_scope(&pool, &job, project_id).await;

    // The record a compute writes: each DECLARED library with the version that was
    // actually resolved, plus the digest identifying the rest of the environment.
    let ws = workspace("present");
    let record_path = ws.join("run-environment.json");
    std::fs::write(
        &record_path,
        serde_json::to_vec_pretty(&json!({
            "declared": [
                { "library": "alpha-tool", "version": ">=1.11,<1.12", "resolved": "1.11.5" },
                { "library": "beta-tool", "version": "==2.0.0", "resolved": "2.0.0" }
            ],
            "libraries": { "alpha-tool": "1.11.5", "beta-tool": "2.0.0" },
            "env_lock_sha256": "sha256:deadbeef",
            "python": "3.11.9"
        }))
        .unwrap(),
    )
    .unwrap();

    let recorder = ProvenanceRunRecorder::new(pool.clone());
    recorder
        .record_run(
            &job,
            &[
                // a normal result output, to prove the lookup is BY ID and not "the first
                // output" or "the only output"
                produced("some-result", ws.join("code").join("entry.py")),
                produced(RUN_ENVIRONMENT_OUTPUT_ID, record_path.clone()),
            ],
            0,
            PeakMetrics::default(),
            &ws,
        )
        .await;
    let _ = std::fs::remove_dir_all(&ws);

    let row = ProvenanceRepository::new(pool.clone())
        .get_run(job_id)
        .await
        .expect("query the run row")
        .expect("a run node was recorded");

    let lock = row
        .lockfile_json
        .expect("the run row carries the environment record — NOT NULL");
    assert_eq!(
        lock["libraries"]["alpha-tool"], "1.11.5",
        "the RESOLVED version of a declared library is readable off the provenance row"
    );
    assert_eq!(lock["libraries"]["beta-tool"], "2.0.0");
    assert_eq!(
        lock["declared"][0]["version"], ">=1.11,<1.12",
        "the DECLARED range is carried alongside the resolved version, so a reader can see \
         what was promised as well as what was delivered"
    );
    assert_eq!(
        lock["env_lock_sha256"], "sha256:deadbeef",
        "the transitive closure is identified by digest, so a closure change is visible in \
         the record of the run it affected"
    );
    // The image digest keeps its own column — the two answer different questions and
    // neither replaces the other.
    assert_eq!(row.seed, Some(11), "the rest of the record is unaffected");
}

#[tokio::test]
async fn a_run_that_emits_no_environment_record_leaves_the_column_null() {
    // `None` must mean "this run did not report one" — an honest absence. A fabricated
    // placeholder would be worse than nothing: it would make a run that predates the
    // mechanism, or one whose record failed to read, indistinguishable from a verified one.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "run environment absent project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    let job = analysis_job(owner, root_id);
    let job_id = job.id;
    seed_job_scope(&pool, &job, project_id).await;

    let ws = workspace("absent");
    let recorder = ProvenanceRunRecorder::new(pool.clone());
    recorder
        .record_run(
            &job,
            &[produced("some-result", ws.join("code").join("entry.py"))],
            0,
            PeakMetrics::default(),
            &ws,
        )
        .await;
    let _ = std::fs::remove_dir_all(&ws);

    let row = ProvenanceRepository::new(pool)
        .get_run(job_id)
        .await
        .expect("query the run row")
        .expect("a run node was recorded");
    assert!(
        row.lockfile_json.is_none(),
        "no environment record ⇒ NULL, never a fabricated one"
    );
}

#[tokio::test]
async fn a_malformed_environment_record_is_dropped_and_does_not_fail_the_run() {
    // By the time the recorder runs, the outputs are already CATALOGED. Refusing to record
    // provenance over an unreadable metadata blob would discard a completed, ingested run —
    // so this path degrades to a logged NULL. The hard enforcement lives where it can still
    // change the outcome: the build gate refuses an unsatisfiable declaration, and the
    // in-sandbox check refuses the run before it produces anything.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "run environment malformed project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    let job = analysis_job(owner, root_id);
    let job_id = job.id;
    seed_job_scope(&pool, &job, project_id).await;

    let ws = workspace("malformed");
    let bad = ws.join("run-environment.json");
    std::fs::write(&bad, b"{not json").unwrap();

    let recorder = ProvenanceRunRecorder::new(pool.clone());
    recorder
        .record_run(
            &job,
            &[produced(RUN_ENVIRONMENT_OUTPUT_ID, bad)],
            0,
            PeakMetrics::default(),
            &ws,
        )
        .await;
    let _ = std::fs::remove_dir_all(&ws);

    let row = ProvenanceRepository::new(pool)
        .get_run(job_id)
        .await
        .expect("query the run row")
        .expect("the run is still recorded — a metadata read must not discard it");
    assert!(
        row.lockfile_json.is_none(),
        "an unreadable record is dropped, not stored as garbage"
    );
}
