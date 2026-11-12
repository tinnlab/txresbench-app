//! TEST-64 [ITEM-25, ITEM-22] — the exported capsule's EXACT file manifest. The
//! `.zip` contains `run.sh`, `scripts/step_NN_<sha>.<ext>` (each byte-equal to its
//! `provenance_code_blobs` source), `data/<hash>` (each byte-equal to the dataset's
//! txresbench-file bytes / the run's output blob), `inputs.json`, `manifest.json` (WRROC),
//! `environments.json`, methods + README + a manifest checksum — and NO undeclared
//! files. (Export reads the DB + blob store only, so this runs with NO rootfs.)
//!
//! NOTE vs the spec's idealized names: the code emits `methods.md`, `REPRODUCING.md`
//! (the README), and `manifest-sha256.txt`; asserted against the ACTUAL members.

use chrono::Utc;
use uuid::Uuid;

use txresbench::modules::jobs::models::Job;
use txresbench::modules::jobs::seams::{PeakMetrics, RunRecorder};
use txresbench::modules::provenance::recorder::ProvenanceRunRecorder;
use txresbench::modules::provenance::repository::ProvenanceRepository;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

const SCRIPT: &str =
    "import scanpy as sc\nadata = sc.read_h5ad('/inputs/matrix.csv')\nprint('qc')\n";

/// Capsule members `bundle::build_bundle` pushes UNCONDITIONALLY — asserted both
/// present (no silent shrinkage) and declared (no undeclared growth).
const ALWAYS_MEMBERS: [&str; 9] = [
    "run.sh",
    // F2-18 — run.sh's last act; the capsule's REPRODUCED / NOT REPRODUCED verdict.
    "verify_outputs.sh",
    // F2-17 — the readiness verdict travels WITH the bundle.
    "readiness.json",
    "inputs.json",
    "environments.json",
    "methods.md",
    "manifest.json",
    "REPRODUCING.md",
    "manifest-sha256.txt",
];

/// Members emitted only when the closure warrants them, so they are DECLARED (a
/// legal member) but not required of every capsule. Each is keyed to the condition
/// in `build_bundle` that emits it — that condition is what a reviewer checks when
/// deciding whether a capsule that lacks one is complete.
const CONDITIONAL_MEMBERS: [&str; 3] = [
    // emitted when a carried hash has no bytes in the bundle (holes).
    "fetch.txt",
    // emitted when a run's code blob was un-includable (`!code_gaps.is_empty()`).
    "PROVENANCE-GAPS.md",
    // emitted when the scope contains a verified run (`!verification_certs.is_empty()`).
    "verification.json",
];

#[tokio::test]
async fn exported_capsule_has_exact_manifest_byte_equal() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "capsule manifest project").await;
    let pool = pool_for(&server).await;
    let admin_id = admin_user_id(&pool).await;

    // A real uploaded dataset D (the byte source for a data/<hash> member).
    let dataset_bytes = b"cell,gene_a,gene_b\ncell_1,3,7\ncell_2,0,4\n";
    let (dataset, file_id, h_d) =
        upload_dataset(&server, &admin, "PBMC capsule", "matrix.csv", dataset_bytes).await;
    attach_dataset(&server, &admin, project, dataset).await;

    // Record a REAL compute run consuming D — stores the script as a code blob and
    // pins D's content hash as a used-edge.
    let run_id = Uuid::new_v4();
    let job = Job {
        id: run_id,
        owner_id: admin_id,
        job_type: "analysis".into(),
        name: "capsule-run".into(),
        status: "completed".into(),
        params: serde_json::json!({
            "language": "python",
            "script": SCRIPT,
            "inputs": [{ "slot": "matrix", "dataset_file_ref": file_id, "sandbox_subpath": "matrix.csv" }],
            "produces": [{ "id": "result", "datatype": "file/upload", "path": "result.bin", "layout": "opaque", "role": "artifact" }],
            "seed": 7
        }),
        created_at: Utc::now(),
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
    };
    // ITEM-68: a job carries no scope column — seed the jobs row + a project-scoped
    // `job_scope` row so the recorder resolves this run's project scope from the table.
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1, $2, 'analysis', 'capsule-run', 'completed')")
        .bind(run_id)
        .bind(admin_id)
        .execute(&pool)
        .await
        .expect("seed jobs row");
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(run_id)
        .bind(project)
        .execute(&pool)
        .await
        .expect("seed job_scope row");
    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;

    // The recorded run's code blob + its output artifact (a real blob → carried).
    let row = ProvenanceRepository::new(pool.clone())
        .get_run(run_id)
        .await
        .unwrap()
        .unwrap();
    let code_sha = row
        .code_sha256
        .clone()
        .expect("the script was captured as a code blob");
    let code_source: String =
        sqlx::query_scalar("SELECT source FROM provenance_code_blobs WHERE sha256 = $1")
            .bind(&code_sha)
            .fetch_one(&pool)
            .await
            .unwrap();
    let output_bytes = b"RESULT-OUTPUT-BYTES";
    let (_out_id, h_out) = seed_blob_artifact(
        &server,
        Some(project),
        None,
        Some(run_id),
        "result",
        output_bytes,
        "file/upload")
    .await;

    // Export the single-run capsule and unpack it.
    let export_id = export_bundle(&server, &admin, project, Some(run_id), "single").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let member = |name: &str| {
        members
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, b)| b.clone())
    };
    let names: Vec<&str> = members.iter().map(|(n, _)| n.as_str()).collect();

    // scripts/step_00_<sha12>.py — byte-equal to the provenance_code_blobs source.
    let sha12 = &code_sha[..12];
    let script_name = format!("scripts/step_00_{sha12}.py");
    let script_bytes =
        member(&script_name).unwrap_or_else(|| panic!("missing {script_name}; members: {names:?}"));
    assert_eq!(
        script_bytes,
        code_source.into_bytes(),
        "the capsule script is byte-equal to its code blob source"
    );

    // data/<D-hash> — byte-equal to the dataset's txresbench-file bytes.
    let d_member = format!("data/{}", h_d.strip_prefix("sha256:").unwrap());
    assert_eq!(
        member(&d_member).expect("dataset data member"),
        dataset_bytes,
        "data/<hash> is byte-equal to the dataset's uploaded bytes"
    );
    // data/<output-hash> — byte-equal to the run's output blob.
    let o_member = format!("data/{}", h_out.strip_prefix("sha256:").unwrap());
    assert_eq!(
        member(&o_member).expect("output data member"),
        output_bytes,
        "data/<hash> is byte-equal to the run's output blob"
    );

    // The ALWAYS-EMITTED members are all present.
    //
    // ROUND-4b (R4B-10): `verify_outputs.sh` + `readiness.json` are unconditional
    // pushes in `bundle::build_bundle` but were missing from this list, so the
    // capsule could have silently STOPPED emitting either one and this test would
    // still have passed. An allow-list alone only catches growth; this list is what
    // catches shrinkage, so every unconditional member belongs in it.
    for fixed in ALWAYS_MEMBERS {
        assert!(
            member(fixed).is_some(),
            "the capsule contains {fixed}; members: {names:?}"
        );
    }
    // manifest.json is WRROC.
    let manifest_txt = String::from_utf8_lossy(&member("manifest.json").unwrap()).to_string();
    assert!(
        manifest_txt.contains("ro/crate") || manifest_txt.contains("@graph"),
        "manifest.json is an RO-Crate (WRROC) document"
    );

    // NO undeclared files — every member is data/*, scripts/*, or a DECLARED member.
    //
    // This assertion is the only thing standing between "the capsule's contents are
    // reviewed" and "anything can be added to the artifact a third party is asked to
    // trust". It is a deliberate speed bump, not a derived check: a new member makes
    // this test RED, and the only way to green is to come here and declare it — i.e.
    // a human decides that the new file belongs in a reproducibility capsule. Keep it
    // that way. Do NOT relax it into a prefix rule or derive it from `build_bundle`,
    // which would make the capsule self-certifying and the guard vacuous.
    for (name, _) in &members {
        let declared =
            ALWAYS_MEMBERS.contains(&name.as_str()) || CONDITIONAL_MEMBERS.contains(&name.as_str());
        let ok = name.starts_with("data/") || name.starts_with("scripts/") || declared;
        assert!(ok, "undeclared capsule member: {name}");
    }
    // Exactly the two carried data members (D + the output), no more.
    let data_count = members
        .iter()
        .filter(|(n, _)| n.starts_with("data/"))
        .count();
    assert_eq!(
        data_count, 2,
        "exactly the consumed dataset + the run output are carried as data/"
    );
}
