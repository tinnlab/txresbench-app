//! TEST-9 — the REAL provenance RunRecorder (P4 ITEM-1/3/4/5). Calling
//! `record_run` for a project-scoped analysis job over seeded catalog inputs writes
//! a `provenance_run_repro` sidecar with the ingest-aligned run_id, a stored code
//! blob, used-edges pinning the input content-hash, and the full re-run spec — and
//! records NOTHING for a project-less job.

use super::*;

use cytoanalyst::modules::jobs::models::Job;
use cytoanalyst::modules::jobs::seams::PeakMetrics;
use cytoanalyst::modules::jobs::seams::RunRecorder;
use cytoanalyst::modules::provenance::recorder::ProvenanceRunRecorder;
use cytoanalyst::modules::provenance::repository::ProvenanceRepository;

/// A synthetic analysis `Job` whose params pin `root_id` as an `artifact_ref`
/// input. `owner` (a real user, so a seeded `jobs` row's FK holds) / `run_id` are
/// caller-set. ITEM-68: the run's SCOPE is NOT on the Job — the caller seeds a
/// `job_scope` row via [`seed_job_scope`] so the recorder resolves it from the table.
fn analysis_job(owner: Uuid, run_id: Option<Uuid>, root_id: Uuid) -> Job {
    Job {
        id: Uuid::new_v4(),
        owner_id: owner,
        job_type: "analysis".into(),
        name: "recorder-test".into(),
        status: "completed".into(),
        params: json!({
            "language": "python",
            "script": "import scanpy as sc\nprint('ok')\n",
            "inputs": [
                { "slot": "expression", "artifact_ref": root_id, "sandbox_subpath": "expression.h5ad" }
            ],
            "produces": [
                { "id": "embedding", "datatype": "embedding", "path": "umap.zarr", "layout": "zarr", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "primary" }
            ],
            "seed": 7
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
        run_id,
    }
}

/// The first-run admin's user id (a real FK target for a seeded `jobs.owner_id`).
async fn admin_id(pool: &SqlitePool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin user id")
}

/// Seed the synthetic job's `jobs` row + (when `project` is `Some`) a project-scoped
/// `job_scope` row, so the recorder resolves the run's scope from the table (ITEM-68).
async fn seed_job_scope(pool: &SqlitePool, job: &Job, project: Option<Uuid>) {
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1, $2, $3, $4, $5)")
        .bind(job.id)
        .bind(job.owner_id)
        .bind(&job.job_type)
        .bind(&job.name)
        .bind(&job.status)
        .execute(pool)
        .await
        .expect("seed jobs row");
    if let Some(p) = project {
        sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
            .bind(job.id)
            .bind(p)
            .execute(pool)
            .await
            .expect("seed job_scope row");
    }
}

#[tokio::test]
async fn record_run_writes_the_sidecar_with_pinned_inputs() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "recorder project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    let recorder = ProvenanceRunRecorder::new(pool.clone());
    let job = analysis_job(owner, None, root_id);
    let job_id = job.id;
    // ITEM-68: seed the run's project scope into `job_scope` (the recorder reads it).
    seed_job_scope(&pool, &job, Some(project_id)).await;

    // M4: the recorder hashes the entry STAGED in the run workspace at spawn. Stage it
    // (matching the inline script) so the staged-bytes path is exercised.
    let ws = std::env::temp_dir().join(format!("cyto-rec-ws-{job_id}"));
    std::fs::create_dir_all(ws.join("code")).unwrap();
    std::fs::write(ws.join("code").join("entry.py"), "import scanpy as sc\nprint('ok')\n").unwrap();

    // record_run is fire-and-forget — it must not panic and must persist the node.
    recorder.record_run(&job, &[], 0, PeakMetrics::default(), &ws).await;
    let _ = std::fs::remove_dir_all(&ws);

    let repo = ProvenanceRepository::new(pool.clone());
    let row = repo
        .get_run(job_id)
        .await
        .expect("query sidecar")
        .expect("a run sidecar was recorded (run_id == job.id)");

    assert_eq!(row.run_id, job_id, "run_id falls back to job.id (ingest-aligned)");
    assert_eq!(row.project_id, Some(project_id), "project-scoped run node carries its project id");
    assert_eq!(row.dataset_id, None, "a project-scoped run has no dataset scope");
    assert_eq!(row.kind, "compute");
    assert_eq!(row.status, "completed");
    assert_eq!(row.seed, Some(7));
    assert!(row.code_sha256.is_some(), "the entry script was stored as a code blob");
    assert!(row.params.get("script").is_none(), "the script is not duplicated into params");

    // The used-edge pins the seeded root's content hash (kind `upload` — run-less root).
    let inputs = row.inputs_json.as_array().expect("inputs_json array");
    assert_eq!(inputs.len(), 1, "one used-edge");
    assert_eq!(inputs[0]["content_hash"], json!(root_hash), "input pins the root content hash");
    assert_eq!(inputs[0]["kind"], "upload");

    // The full spec is stashed for the verify re-run.
    let spec = repo.get_rerun_spec(job_id).await.expect("rerun spec").expect("present");
    assert_eq!(spec["script"], "import scanpy as sc\nprint('ok')\n", "full spec captured for re-run");
    assert_eq!(spec["inputs"][0]["artifact_ref"], json!(root_id.to_string()));
}

#[tokio::test]
async fn record_run_skips_a_project_less_job() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (_project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "recorder skip project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    let recorder = ProvenanceRunRecorder::new(pool.clone());
    // ITEM-68: no `job_scope` row is seeded → the recorder resolves NO scope and
    // records nothing (the scope-less path). We deliberately do NOT call
    // `seed_job_scope`, so `job_scope(job.id)` returns None.
    let job = analysis_job(owner, None, root_id);
    let job_id = job.id;
    recorder.record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir()).await;

    let repo = ProvenanceRepository::new(pool);
    assert!(
        repo.get_run(job_id).await.expect("query").is_none(),
        "a scope-less job records no provenance"
    );
}

/// R3-14, RECORDER half — the per-user dataset gate `inputs::resolve_input` applies
/// at the CAPTURE chokepoint must also apply at the COMPUTE chokepoint.
///
/// `recorder::resolve_used_edges` widens an input artifact's tenancy the same way
/// (`inputs::artifact_in_project_scope`): a project-scoped run may pin an artifact
/// whose `project_id` is NULL when its dataset is merely ATTACHED to the project. The
/// attachment says the PROJECT may use the dataset — not that every collaborator may
/// read it. Without the gate, an Editor who submits a run over that artifact gets its
/// `ref_id` + pinned `content_hash` echoed straight back out of his OWN run node.
///
/// RED ON REVERT: drop the `require_dataset_read` call in the widened arm and the
/// editor's run records a pinned `upload` edge carrying `art_id` + `secret_hash`.
#[tokio::test]
async fn a_run_does_not_pin_an_artifact_from_a_dataset_its_owner_cannot_read() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "recorder cross-dataset tenancy").await;
    let pool = pool_for(&server).await;

    // The ADMIN's private dataset + one dataset-scoped artifact, ATTACHED to the project.
    let dataset_id = Uuid::new_v4();
    let secret_hash = format!("sha256:{}", "d".repeat(64));
    let seed_acct = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) \
         VALUES ($1, 'personal', 'seed', (SELECT id FROM users WHERE username = 'admin')) \
         ON CONFLICT (personal_user_id) WHERE kind='personal' DO UPDATE SET name = accounts.name",
    )
    .bind(seed_acct)
    .execute(&pool)
    .await
    .expect("seed personal account");
    let admin_account_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = \
         (SELECT id FROM users WHERE username = 'admin')",
    )
    .fetch_one(&pool)
    .await
    .expect("personal account id");
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id) \
         VALUES ($1, $2, (SELECT id FROM users WHERE username = 'admin'), $3)",
    )
    .bind(dataset_id)
    .bind("recorder-private-dataset")
    .bind(admin_account_id)
    .execute(&pool)
    .await
    .expect("seed dataset");
    let art_id = seed_dataset_scoped_artifact(&pool, dataset_id, &secret_hash).await;
    sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)")
        .bind(project_id)
        .bind(dataset_id)
        .execute(&pool)
        .await
        .expect("attach dataset");

    // A project EDITOR with no share on the dataset at all.
    let _editor_token =
        shared_collaborator(&server, &admin, project_id, "rec_ds_editor", "editor").await;
    let editor_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'rec_ds_editor'")
        .fetch_one(&pool)
        .await
        .expect("editor user id");

    let recorder = ProvenanceRunRecorder::new(pool.clone());
    let job = analysis_job(editor_id, None, art_id);
    let job_id = job.id;
    seed_job_scope(&pool, &job, Some(project_id)).await;
    recorder.record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir()).await;

    let repo = ProvenanceRepository::new(pool.clone());
    let row = repo.get_run(job_id).await.expect("query sidecar").expect("run recorded");
    let edges = row.inputs_json.as_array().expect("inputs_json array");
    assert_eq!(edges.len(), 1, "the declared input still produces exactly one edge: {edges:?}");
    assert_eq!(
        edges[0]["ref_id"],
        json!(null),
        "the private dataset artifact's id must NOT be echoed into the editor's run: {edges:?}"
    );
    assert_eq!(
        edges[0]["content_hash"], json!(""),
        "…nor its pinned content hash: {edges:?}"
    );
    assert!(
        !row.inputs_json.to_string().contains(&secret_hash),
        "no part of the private artifact leaked: {}",
        row.inputs_json
    );
    assert!(
        !row.inputs_json.to_string().contains(&art_id.to_string()),
        "…and neither did its id: {}",
        row.inputs_json
    );

    // CONTROL: the DATASET OWNER's identical run still pins the artifact — the rule is
    // a per-user visibility check, not a ban on attached-dataset inputs.
    let owner = admin_id(&pool).await;
    let owner_job = analysis_job(owner, None, art_id);
    let owner_job_id = owner_job.id;
    seed_job_scope(&pool, &owner_job, Some(project_id)).await;
    recorder.record_run(&owner_job, &[], 0, PeakMetrics::default(), &std::env::temp_dir()).await;
    let row = repo.get_run(owner_job_id).await.expect("query").expect("owner run recorded");
    let edges = row.inputs_json.as_array().expect("inputs_json array");
    assert_eq!(edges[0]["ref_id"], json!(art_id.to_string()), "the owner pins the artifact: {edges:?}");
    assert_eq!(edges[0]["content_hash"], json!(secret_hash), "…by content hash: {edges:?}");

    // CONTROL: once the dataset is SHARED with the editor, his run pins it too.
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'user', $2, 'view')",
    )
    .bind(dataset_id)
    .bind(editor_id)
    .execute(&pool)
    .await
    .expect("share dataset with the editor");
    let shared_job = analysis_job(editor_id, None, art_id);
    let shared_job_id = shared_job.id;
    seed_job_scope(&pool, &shared_job, Some(project_id)).await;
    recorder.record_run(&shared_job, &[], 0, PeakMetrics::default(), &std::env::temp_dir()).await;
    let row = repo.get_run(shared_job_id).await.expect("query").expect("sharee run recorded");
    let edges = row.inputs_json.as_array().expect("inputs_json array");
    assert_eq!(
        edges[0]["content_hash"], json!(secret_hash),
        "a dataset SHAREE's run pins the artifact: {edges:?}"
    );
}

// TEST-10 [ITEM-5, ITEM-6] — the WIDENED `RunReproRow` is populated through EVERY
// repository read path (`insert_run`, `get_run`, `runs_for_project`,
// `runs_for_dataset`, `promote_runs_for_user`, `list_runs`), so no one of the
// `query_as!(RunReproRow, …)` sites was missed and no code path silently gets a
// `None` envelope for a run that recorded one.
#[tokio::test]
async fn every_repository_path_returns_the_rerun_envelope() {
    use cytoanalyst::modules::provenance::repository::NewRun;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "row widening project").await;
    let pool = pool_for(&server).await;
    let repo = ProvenanceRepository::new(pool.clone());
    let owner = admin_id(&pool).await;

    // (a) insert_run — the RETURNING projection.
    let project_run = record_filter_run(&pool, project_id, root_id).await;
    let spec_params = |row: &cytoanalyst::modules::provenance::repository::RunReproRow| {
        row.rerun_spec_json
            .as_ref()
            .and_then(|s| s.get("params").cloned())
            .unwrap_or(json!(null))
    };

    // (b) get_run.
    let got = repo.get_run(project_run).await.expect("get_run").expect("recorded");
    assert_eq!(spec_params(&got), filter_run_params(), "get_run carries the stashed spec params");
    assert_eq!(got.params["criteria"][0]["column"], json!("pct_counts_mito"), "…and the promoted params");

    // (c) runs_for_project.
    let for_project = repo.runs_for_project(project_id).await.expect("runs_for_project");
    let row = for_project.iter().find(|r| r.run_id == project_run).expect("run listed");
    assert_eq!(spec_params(row), filter_run_params(), "runs_for_project carries the envelope");

    // (d) list_runs (the paginated trust view).
    let (page, total) = repo.list_runs(project_id, 1, 10).await.expect("list_runs");
    assert!(total >= 1);
    let row = page.iter().find(|r| r.run_id == project_run).expect("run paginated");
    assert_eq!(spec_params(row), filter_run_params(), "list_runs carries the envelope");

    // (e) runs_for_dataset + (f) promote_runs_for_user — the dataset-scoped paths.
    // A `promote` node is dataset-scoped and acted by the user, so ONE inserted row
    // exercises both reads.
    let dataset_id = Uuid::new_v4();
    let seed_acct = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) \
         VALUES ($1, 'personal', 'seed', $2) \
         ON CONFLICT (personal_user_id) WHERE kind='personal' DO UPDATE SET name = accounts.name",
    )
    .bind(seed_acct)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("seed personal account");
    let owner_account_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $1",
    )
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("personal account id");
    sqlx::query(
        "INSERT INTO datasets (id, owner_id, name, account_id) VALUES ($1, $2, 'row widening ds', $3)",
    )
    .bind(dataset_id)
    .bind(owner)
    .bind(owner_account_id)
    .execute(&pool)
    .await
    .expect("seed dataset");

    let promote_id = Uuid::new_v4();
    repo.insert_run(&NewRun {
        run_id: promote_id,
        project_id: None,
        dataset_id: Some(dataset_id),
        kind: "promote".into(),
        status: "completed".into(),
        generator_id: "promote".into(),
        generator_version: "test".into(),
        code_sha256: None,
        env_rootfs_sha256: None,
        lockfile_json: None,
        seed: None,
        params: json!({ "criteria": [] }),
        inputs_json: json!([]),
        acting_user: Some(owner),
        rerun_spec_json: Some(json!({ "params": filter_run_params() })),
    })
    .await
    .expect("insert promote run");

    let for_dataset = repo.runs_for_dataset(dataset_id).await.expect("runs_for_dataset");
    let row = for_dataset.iter().find(|r| r.run_id == promote_id).expect("dataset run listed");
    assert_eq!(spec_params(row), filter_run_params(), "runs_for_dataset carries the envelope");

    let promotes = repo.promote_runs_for_user(owner).await.expect("promote_runs_for_user");
    let row = promotes.iter().find(|r| r.run_id == promote_id).expect("promote run listed");
    assert_eq!(spec_params(row), filter_run_params(), "promote_runs_for_user carries the envelope");
}

// ── TEST-29 (INV-5, FINDING 7) — BOTH lineage edges survive the widened row ────

use crate::dataset::hardening_common::{
    attach_dataset as hc_attach_dataset, create_project as hc_create_project, gate as hc_gate,
    run_real_analysis as hc_run_real_analysis, upload_fixture as hc_upload_fixture,
    PBMC3K as HC_PBMC3K,
};

/// **This test was enumerated in `TESTS.md` and credited to ITEM-17 / INV-5 but was
/// never written** (FINDING 7). The output edge survived only INCIDENTALLY, via
/// helpers elsewhere that happen to query `artifacts WHERE run_id`; nothing
/// asserted it as the invariant it is.
///
/// INV-5: widening `RunReproRow` (ITEM-6) and promoting the scientific `params`
/// (ITEM-5 / DEC-1) must not disturb EITHER lineage edge —
///  * the INPUT edge: the run's `inputs_json` carries the `used` edges
///    `resolve_used_edges` produced (slot + pinned content hash), and they project
///    onto the wire DTO the trust view reads;
///  * the OUTPUT edge: each ingested output artifact carries this run's `run_id`
///    stamp — what makes the artifact reachable from the run in the graph walk
///    (`outputs_by_run`) and what the A5 cascade keys on.
///
/// Driven by a REAL processor run through the production submit → sandbox →
/// finalize → ingest path (`run_real_analysis`), because the output edge is written
/// by the INGEST seam: a fixture that only calls `record_run` cannot observe it, and
/// asserting it on a hand-seeded artifact row would be testing the fixture.
/// Rootfs + fixture gated with a printed self-skip (never the compile-time ignore
/// attribute; a SKIP is recorded as SKIP — in the SKIP LEDGER
/// (`hardening_common::record_skip`) as well as on stderr, so it survives
/// libtest's default output capture).
#[tokio::test]
async fn both_lineage_edges_survive_the_widened_row_and_promoted_params() {
    let test = "test29_lineage_edges";
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = hc_gate(&server, &admin, test).await else {
        return; // fixture/rootfs unavailable — SKIP, printed by `gate`
    };
    let pool = pool_for(&server).await;

    let project_id = hc_create_project(&server, &admin, "lineage edges project").await;
    let dataset_id = hc_upload_fixture(&server, &admin, HC_PBMC3K, bytes).await;
    hc_attach_dataset(&server, &admin, project_id, dataset_id).await;
    let file_id: Uuid =
        sqlx::query_scalar("SELECT file_id FROM dataset_files WHERE dataset_id = $1 LIMIT 1")
            .bind(dataset_id)
            .fetch_one(&pool)
            .await
            .expect("the uploaded dataset has a file");

    let (run_id, signature) = hc_run_real_analysis(
        &server,
        &admin,
        &pool,
        Some(project_id),
        None,
        test,
        json!({
            "language": "python",
            "code_ref": "compute/cell-filter.py",
            "params": {
                "criteria": [{ "column": "total_counts", "control": "range", "min": 1500 }],
                "label": "lowqc"
            },
            "inputs": [{
                "slot": "expression",
                "dataset_file_ref": file_id,
                "sandbox_subpath": "expression.h5ad",
            }],
        }),
    )
    .await;

    // (1) OUTPUT edge — every cataloged output carries THIS run's `run_id` stamp.
    assert!(!signature.is_empty(), "the run cataloged its outputs (INV-5 output edge)");
    let stamped: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("count stamped outputs");
    assert_eq!(
        stamped as usize,
        signature.len(),
        "every ingested output artifact carries the run_id stamp"
    );

    // (2) INPUT edge — recorded on the sidecar row by PINNED CONTENT HASH…
    let inputs_json: Value =
        sqlx::query_scalar("SELECT inputs_json FROM provenance_run_repro WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .expect("inputs_json");
    let edges = inputs_json.as_array().expect("inputs_json is an array of used edges");
    assert_eq!(edges.len(), 1, "one declared input -> one used edge: {inputs_json}");
    assert_eq!(edges[0]["slot"], json!("expression"), "the logical slot survives");
    let hash = edges[0]["content_hash"].as_str().unwrap_or_default();
    assert!(
        hash.starts_with("sha256:"),
        "the used edge pins a real content hash: {inputs_json}"
    );

    // …and still projects onto the wire DTO the trust view reads.
    let node = get_run_node(&server, &admin, run_id).await;
    assert_eq!(node["inputs"][0]["content_hash"], json!(hash), "{node}");

    // (3) …under the NEW row shape: the promoted scientific params really are on the
    //     row, so this is a non-regression assertion against the ITEM-5 change INV-5
    //     guards, not against the pre-change shape.
    let params: Value =
        sqlx::query_scalar("SELECT params FROM provenance_run_repro WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .expect("params");
    assert_eq!(
        params["criteria"][0]["column"],
        json!("total_counts"),
        "the promoted scientific params are present alongside both edges: {params}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// The capsule binds where the RUN bound — not where the spec asked
// ─────────────────────────────────────────────────────────────────────────────────

/// An exported reproducibility capsule must bind each input at the path the ORIGINAL
/// RUN actually mounted it at.
///
/// ## The defect this pins
///
/// ITEM-23 made an artifact-backed input's mount name a DERIVATION from the artifact
/// (`derive_artifact_mount_name`), so the spec's `sandbox_subpath` is ignored for it. The
/// export layer went on reading `rerun_spec_json`'s `inputs[].sandbox_subpath` — the
/// ignored field — so a capsule declared, in its `run.sh` and its `inputs.json`, a bind
/// path the run had never used. Capsules stayed INTERNALLY consistent (they wrote and
/// read the same wrong name, and a compute resolves by slot anyway), which is exactly why
/// nothing failed and why self-consistency is not the property to assert. A capsule is
/// this product's out-of-app trust artifact; one that states a path the run did not take
/// is a provenance lie whether or not anything downstream trips over it.
///
/// ## Why this test cannot pass on a self-consistent capsule
///
/// The expected value is not a literal and not a re-derivation. It is
/// `MaterializedInput::sandbox_path` — taken from the REAL `materialize_inputs`, the same
/// call the job runner makes, over a real artifact in the server's real blob pool. The
/// capsule is then required to equal THAT. So the two sides are the runner and the
/// export, and they cannot agree by both being wrong in the same way.
///
/// The fixture makes the two answers maximally different on purpose: a multi-file
/// `zarr_v3` artifact on slot `expression`, declared with the historical
/// `sandbox_subpath: "matrix.h5ad"` — the literal shipped lie (a Zarr DIRECTORY named as
/// an h5ad blob, which routed a store into `anndata.read_h5ad`). The run mounts
/// `/inputs/expression.zarr`; the pre-fix capsule said `/inputs/matrix.h5ad`.
#[tokio::test]
async fn the_exported_capsule_binds_inputs_where_the_run_actually_mounted_them() {
    use cytoanalyst::modules::sandbox::inputs::materialize_inputs;
    use cytoanalyst::modules::sandbox::spec::AnalysisSpec;
    use cytoanalyst::modules::workstore::object_store::{LocalFsStore, ObjectStore};

    use crate::dataset::hardening_common::{download_zip, export_bundle, unzip_store};

    /// What the caller DECLARED — ignored for an artifact-backed input since ITEM-23.
    const DECLARED: &str = "matrix.h5ad";

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "capsule bind fidelity").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    // A real multi-file (Zarr) artifact with real bytes in the SERVER's own pool, so
    // `materialize_inputs` runs its production path rather than a stub.
    let store = LocalFsStore::new(server.data_dir().join("workstore"));
    let members: Vec<(String, Vec<u8>)> = vec![
        ("zarr.json".to_string(), br#"{"zarr_format":3}"#.to_vec()),
        ("c/0".to_string(), b"counts".to_vec()),
    ];
    let put = store.put_prefix(&members).await.expect("put_prefix");
    let art = CatalogRepository::new(pool.clone())
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id),
            dataset_id: None,
            run_id: None, // a root: the backward walk terminates here
            output_id: "upload".to_string(),
            datatype: "single-cell/expression".to_string(),
            object_key: Some(put.object_key.as_str().to_string()),
            is_multifile: true,
            content_hash: put.content_hash.clone(),
            structure: json!({ "encoding": "zarr_v3", "kind": "table" }),
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed zarr root artifact")
        .id;

    let mut job = analysis_job(owner, None, art);
    job.params["inputs"][0]["sandbox_subpath"] = json!(DECLARED);
    let job_id = job.id;
    seed_job_scope(&pool, &job, Some(project_id)).await;

    // ── (1) RUN IT: the real staging chokepoint, into a real run workspace ────────
    let ws = std::env::temp_dir().join(format!("cyto-bindfid-ws-{job_id}"));
    std::fs::create_dir_all(ws.join("code")).expect("workspace");
    std::fs::write(
        ws.join("code").join("entry.py"),
        job.params["script"].as_str().expect("script"),
    )
    .expect("stage entry");
    let spec = AnalysisSpec::parse(&job.params).expect("spec parses");
    let staged = materialize_inputs(&spec, &ws.join("inputs"), owner, &[], &pool, &store)
        .await
        .expect("materialize inputs");
    assert_eq!(staged.len(), 1);
    let mounted = staged[0].sandbox_path.clone(); // ← the RUNNER's answer, not a literal
    assert_ne!(
        mounted,
        format!("/inputs/{DECLARED}"),
        "fixture sanity: the run must NOT mount at the declared subpath, or this test \
         could not tell the two sources apart"
    );

    // ── (2) RECORD IT: the real recorder, over that same workspace ────────────────
    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &ws)
        .await;
    let _ = std::fs::remove_dir_all(&ws);

    // Pin an environment on the recorded row. ORTHOGONAL to the property under test —
    // it only decides whether `run.sh` RENDERS the step at all (a step with no pinned
    // rootfs is emitted as "provenance-only, not executed"), and a dev/CI build's
    // embedded rootfs is a 0-byte stub, so `capture::env_digest_rootfs()` is `None`
    // here for reasons that have nothing to do with input binding. Without this the
    // `run.sh` half below could never fire, in either direction.
    sqlx::query("UPDATE provenance_run_repro SET env_rootfs_sha256 = $2 WHERE run_id = $1")
        .bind(job_id)
        .bind(format!("sha256:{}", "e".repeat(64)))
        .execute(&pool)
        .await
        .expect("pin an environment so the capsule renders the step");

    // ── (3) EXPORT IT: the real bundle, read as a third party would ──────────────
    let export_id = export_bundle(&server, &admin, project_id, None, "project").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let find = |name: &str| -> Vec<u8> {
        members
            .iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| {
                panic!(
                    "{name} in the bundle; members: {:?}",
                    members.iter().map(|(n, _)| n).collect::<Vec<_>>()
                )
            })
            .1
            .clone()
    };

    let capsule: Value =
        serde_json::from_slice(&find("inputs.json")).expect("the capsule's inputs.json parses");
    let bound: Vec<String> = capsule["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .flat_map(|s| s["inputs"].as_array().cloned().unwrap_or_default())
        .filter_map(|i| i["sandbox_path"].as_str().map(|s| s.to_string()))
        .collect();
    assert_eq!(
        bound.len(),
        1,
        "the exported capsule carries the run's one input: {capsule}"
    );
    assert_eq!(
        bound[0], mounted,
        "the capsule must bind the input where the RUN mounted it. This compares the \
         capsule against `materialize_inputs`' own answer, so it cannot be satisfied by a \
         capsule that is merely self-consistent: {capsule}"
    );
    assert_ne!(
        bound[0],
        format!("/inputs/{DECLARED}"),
        "…and specifically not at the `sandbox_subpath` the spec declared, which the \
         runner ignores for an artifact-backed input"
    );

    // The generated `run.sh` is the half a third party actually EXECUTES, so the same
    // path has to reach it — an `inputs.json` that agrees while `run.sh` stages elsewhere
    // would be the identical defect one file over.
    let run_sh = String::from_utf8(find("run.sh")).expect("run.sh is utf-8");
    let name = mounted.trim_start_matches("/inputs/");
    assert!(
        run_sh.contains(name),
        "run.sh must stage the input under {name:?} (the mounted name):\n{run_sh}"
    );
    assert!(
        !run_sh.contains(DECLARED),
        "…and must not stage it under the declared {DECLARED:?}"
    );
}

// ───────────────────── binding origin (ITEM-18 / INV-3) ──────────────────────

/// A synthetic analysis `Job` declaring an arbitrary list of `inputs` entries, so a
/// test can drive the recorder over EVERY input shape in one run.
fn analysis_job_with_inputs(owner: Uuid, inputs: Value) -> Job {
    let mut job = analysis_job(owner, None, Uuid::new_v4());
    job.params["inputs"] = inputs;
    job
}

/// Record `job` through the REAL recorder (project-scoped) and return the
/// `inputs_json` array it persisted.
async fn recorded_edges(pool: &SqlitePool, job: &Job, project_id: Uuid) -> Vec<Value> {
    seed_job_scope(pool, job, Some(project_id)).await;
    ProvenanceRunRecorder::new(pool.clone())
        .record_run(job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;
    ProvenanceRepository::new(pool.clone())
        .get_run(job.id)
        .await
        .expect("query sidecar")
        .expect("a run sidecar was recorded")
        .inputs_json
        .as_array()
        .expect("inputs_json array")
        .clone()
}

/// TEST-23 [acceptance] [invariant: INV-3] — *"A run records the origin of every input
/// it consumed. A run launched on an input nobody reviewed is observably different, in
/// the provenance record, from one launched on an input a user chose."*
///
/// This asserts the DESIGN's promise, not the code's shape: two runs that consume THE
/// SAME artifact in THE SAME slot — identical in every other recorded respect — must
/// differ in `inputs_json` when one binding was reviewed and the other was not. Before
/// this change the two records were byte-identical, which is precisely why an
/// unreviewed binding was invisible to anyone reading the record afterwards.
///
/// The third arm is the one that keeps the annotation HONEST: a run that recorded no
/// origin (every run predating this field, and any caller with nothing to report) must
/// leave the key ABSENT. Defaulting it to `user` would fabricate a review that never
/// happened; defaulting it to `auto` would fabricate an accusation (DEC-7 / INV-4).
///
/// RED ON REVERT: drop the origin from `resolve_used_edges`' funnel and the `user` and
/// `auto` runs record identical edges again.
#[tokio::test]
async fn a_reviewed_and_an_unreviewed_binding_are_different_records() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "binding origin project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    let one_input = |origin: Option<&str>| {
        let mut decl = json!({ "slot": "input", "artifact_ref": root_id });
        if let Some(o) = origin {
            decl["bound_by"] = json!(o);
        }
        json!([decl])
    };

    let picked = analysis_job_with_inputs(owner, one_input(Some("user")));
    let guessed = analysis_job_with_inputs(owner, one_input(Some("auto")));
    let silent = analysis_job_with_inputs(owner, one_input(None));

    let picked_edges = recorded_edges(&pool, &picked, project_id).await;
    let guessed_edges = recorded_edges(&pool, &guessed, project_id).await;
    let silent_edges = recorded_edges(&pool, &silent, project_id).await;

    // The premise: the two runs really did consume the SAME artifact in the SAME slot,
    // so nothing but the origin can be producing the difference asserted below.
    for edges in [&picked_edges, &guessed_edges, &silent_edges] {
        assert_eq!(edges.len(), 1, "one declared input, one edge: {edges:?}");
        assert_eq!(edges[0]["slot"], json!("input"), "the same slot: {edges:?}");
        assert_eq!(edges[0]["ref_id"], json!(root_id.to_string()), "the same artifact: {edges:?}");
        assert_eq!(edges[0]["content_hash"], json!(root_hash), "the same bytes: {edges:?}");
    }

    // INV-3 — the two records are VISIBLY different.
    assert_ne!(
        picked_edges[0], guessed_edges[0],
        "a reviewed binding and an unreviewed one must not record the same edge: \
         {picked_edges:?} vs {guessed_edges:?}"
    );
    assert_eq!(picked_edges[0]["bound_by"], json!("user"), "{picked_edges:?}");
    assert_eq!(guessed_edges[0]["bound_by"], json!("auto"), "{guessed_edges:?}");

    // INV-4 / DEC-7 — an unstated origin stays unstated.
    assert!(
        silent_edges[0].get("bound_by").is_none(),
        "a run that declared no origin records NO origin — never `user`, which would \
         claim a review nobody performed: {silent_edges:?}"
    );
}

/// TEST-25 [ITEM-18] — the origin reaches EVERY edge arm `resolve_used_edges` can
/// produce, not just the artifact one that the finding named.
///
/// The five arms, driven through the real recorder in ONE run so no arm can be
/// silently skipped: a run-less catalog artifact (`upload`), a run-produced artifact
/// (`artifact`), a dataset file (`dataset`), a readable host path (`host`), and a
/// declared-but-unresolvable reference (`unresolved`). The last is the arm most likely
/// to be forgotten and the one it matters most for: an input nobody reviewed AND that
/// could not be resolved is the worst case a bundle reader can face, and dropping the
/// origin there would hide half of it.
///
/// RED ON REVERT: stamp the origin at the artifact arm only (the shape the finding
/// described) and the dataset / host / unresolved edges come back origin-less.
#[tokio::test]
async fn the_origin_reaches_every_used_edge_arm() {
    use crate::dataset::hardening_common::{insert_run, run_template, seed_artifact};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, upload_art, _root_hash) =
        create_project_with_artifact(&server, &admin, "every edge arm project").await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    // (a) A run-PRODUCED artifact → `edge_from_artifact` with kind `artifact`.
    let producer_id = Uuid::new_v4();
    insert_run(&pool, &run_template(producer_id, Some(project_id), None)).await;
    let produced_hash = format!("sha256:{}", "e".repeat(64));
    let produced_art = seed_artifact(
        &pool,
        Some(project_id),
        None,
        Some(producer_id),
        "out",
        &produced_hash,
        // A neutral datatype: this arm is about the EDGE, not the payload.
        "app/opaque",
        false,
    )
    .await;

    // (b) A dataset file → `dataset_edge`. The dataset needs a merkle content hash
    //     (the provenance link key) or the arm degrades to `unresolved`.
    let dataset_id = Uuid::new_v4();
    let seed_acct = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) \
         VALUES ($1, 'personal', 'seed', $2) \
         ON CONFLICT (personal_user_id) WHERE kind='personal' DO UPDATE SET name = accounts.name",
    )
    .bind(seed_acct)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("seed personal account");
    let owner_account_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $1",
    )
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("personal account id");
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, content_hash, account_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(dataset_id)
    .bind("every-arm-dataset")
    .bind(owner)
    .bind(format!("sha256:{}", "f".repeat(64)))
    .bind(owner_account_id)
    .execute(&pool)
    .await
    .expect("seed dataset");
    let file_id: Uuid = sqlx::query_scalar(
        "INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by) \
         VALUES (randomblob(16), $1, 'arm.csv', 10, randomblob(16), 'user') RETURNING id",
    )
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("seed file");
    sqlx::query("INSERT INTO dataset_files (dataset_id, file_id, ordinal, role) VALUES ($1, $2, 0, 'primary')")
        .bind(dataset_id)
        .bind(file_id)
        .execute(&pool)
        .await
        .expect("link file to dataset");

    // (c) A readable host path → `host_path_edge`.
    let host_file = std::env::temp_dir().join(format!("cyto-origin-arm-{}.txt", Uuid::new_v4()));
    std::fs::write(&host_file, b"host bytes\n").expect("write host input");

    let job = analysis_job_with_inputs(
        owner,
        json!([
            { "slot": "upload_arm", "artifact_ref": upload_art, "bound_by": "auto" },
            { "slot": "artifact_arm", "artifact_ref": produced_art, "bound_by": "auto" },
            { "slot": "dataset_arm", "dataset_file_ref": file_id, "bound_by": "auto" },
            { "slot": "host_arm", "host_path": host_file.to_string_lossy(), "bound_by": "auto" },
            // A catalog id that exists nowhere → the `unresolved` fallback.
            { "slot": "unresolved_arm", "artifact_ref": Uuid::new_v4(), "bound_by": "auto" },
        ]),
    );
    let edges = recorded_edges(&pool, &job, project_id).await;
    let _ = std::fs::remove_file(&host_file);

    let by_slot = |slot: &str| -> Value {
        edges
            .iter()
            .find(|e| e["slot"] == json!(slot))
            .unwrap_or_else(|| panic!("an edge for slot {slot}: {edges:?}"))
            .clone()
    };

    // The premise: all five arms really were exercised — otherwise the assertions
    // below would pass over edges that never took the arm they are named for.
    for (slot, kind) in [
        ("upload_arm", "upload"),
        ("artifact_arm", "artifact"),
        ("dataset_arm", "dataset"),
        ("host_arm", "host"),
        ("unresolved_arm", "unresolved"),
    ] {
        let edge = by_slot(slot);
        assert_eq!(edge["kind"], json!(kind), "the fixture must reach the {kind} arm: {edge}");
        assert_eq!(
            edge["bound_by"],
            json!("auto"),
            "the {kind} arm must carry the declared origin — a fact that survives at one \
             arm and evaporates at the others is the defect this change exists to fix: {edge}"
        );
    }
}
