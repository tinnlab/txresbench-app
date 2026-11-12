//! TEST-61 [ITEM-25, ITEM-6] — ingest-failure safety. A run whose declared output
//! is MISSING or ESCAPES `/outputs` is FAILED with its run dirs KEPT — never a
//! false `completed` with lost artifacts — and leaves NO partial catalog.
//!
//! Driven through **BOTH** finalize arms, because they are two code paths reaching
//! the same decision from the same predicate:
//!
//!  * `reconcile_orphaned_running_in` — the BOOT re-finalize (a restart got there
//!    first), and
//!  * `finalize_analysis_with` — the LIVE finalize (the runner observed the exit).
//!
//! Asserting the property on only one of them is what let them disagree: this file
//! used to drive the boot arm alone, and the boot arm was the one that already
//! satisfied it. The live arm deleted the outputs. Same input, opposite data
//! outcome, decided by whether the server happened to restart — see
//! `runner::run_dirs_disposition` for the rule both now consult.
//!
//! Staged in the TWO-ROOT shape production uses (ITEM-17). That matters for the
//! ESCAPE leg specifically: `/outputs` is bind-mounted out of the run's STAGING
//! tree, so a declared `../escape.bin` canonicalizes to the staging dir — not, as a
//! co-located fixture implied, into the sandbox workspace.

use std::sync::Arc;

use serde_json::{json, Value};

use txresbench::modules::jobs::models::Job;
use txresbench::modules::jobs::repository::JobRepository;
use txresbench::modules::jobs::runner::finalize_analysis_with;
use txresbench::modules::jobs::scheduler::reconcile_orphaned_running_in;
use txresbench::modules::jobs::seams::{NoopRunRecorder, PeakMetrics};
use txresbench::modules::workstore::ingest::ingest_run_outputs;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

/// Stage a run's two dirs (ITEM-17) with only
/// `<staging_root>/<job>/outputs/manifest.json` (declaring `entries`) — NO output
/// files — so `load_produced_outputs` fails the missing-file check. Returns
/// `(workspace_dir, staging_dir)`.
async fn stage_manifest_only(
    server: &TestServer,
    job_id: uuid::Uuid,
    entries: Value,
) -> (std::path::PathBuf, std::path::PathBuf) {
    let job_dir = sandboxes_root(server).join(job_id.to_string());
    tokio::fs::create_dir_all(&job_dir).await.unwrap();
    let staging_dir =
        txresbench::modules::sandbox::outputs::staging_dir(&run_staging_root(server), job_id);
    let outputs = txresbench::modules::sandbox::outputs::outputs_dir(&staging_dir);
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(&entries).unwrap(),
    )
    .await
    .unwrap();
    (job_dir, staging_dir)
}

/// A COMPLETE manifest entry for `name` — every field the contract requires.
///
/// `structure`, `meta` and `role` carry NO serde default (ITEM-5/ITEM-6, INV-2), so
/// a short hand-typed entry is rejected by SERDE before `load_produced_outputs`
/// ever looks at the filesystem. That is fine for [`stage_manifest_only`]'s legs
/// (an invalid manifest is an invalid manifest), but it cannot express the case
/// this file exists to pin: a manifest that PARSES, whose good entries genuinely
/// resolve to bytes on disk, and whose ONE bad entry is what fails the load. Those
/// good bytes are the thing a rejected declaration must not take with it, so they
/// have to be really there.
fn complete_entry(name: &str) -> Value {
    json!({
        "id": name,
        "datatype": "file/upload",
        "path": format!("{name}.bin"),
        "layout": "opaque",
        "role": "artifact",
        "structure": { "encoding": "opaque", "media_type": "application/octet-stream" },
        "meta": {}
    })
}

/// Stage a run's two dirs (ITEM-17) with a complete manifest DECLARING every name
/// in `declared`, and the bytes of only the names in `present` actually written.
/// `declared == present` is a valid run; a `declared` superset is the producer bug.
async fn stage_declared_vs_present(
    server: &TestServer,
    job_id: uuid::Uuid,
    declared: &[&str],
    present: &[&str],
) -> (std::path::PathBuf, std::path::PathBuf) {
    let job_dir = sandboxes_root(server).join(job_id.to_string());
    tokio::fs::create_dir_all(job_dir.join("code"))
        .await
        .unwrap();
    let staging_dir =
        txresbench::modules::sandbox::outputs::staging_dir(&run_staging_root(server), job_id);
    let outputs = txresbench::modules::sandbox::outputs::outputs_dir(&staging_dir);
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    for name in present {
        tokio::fs::write(outputs.join(format!("{name}.bin")), name.as_bytes())
            .await
            .unwrap();
    }
    let entries: Vec<Value> = declared.iter().map(|n| complete_entry(n)).collect();
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(&json!({ "outputs": entries })).unwrap(),
    )
    .await
    .unwrap();
    (job_dir, staging_dir)
}

/// The `Job` row `finalize_analysis_with` takes, read back through the production
/// repository (not hand-built) so the fixture cannot drift from the real shape.
async fn job_of(pool: &sqlx::SqlitePool, id: uuid::Uuid) -> Job {
    JobRepository::new(pool.clone())
        .get_any(id)
        .await
        .expect("get_any")
        .expect("the seeded job row exists")
}

/// TEST-61, LIVE arm — the same property as the boot arm below, driven through
/// `finalize_analysis_with`: the path the runner takes when it observes the exit
/// itself, with no restart in between.
///
/// This is the arm the property was NOT asserted on, and the arm that violated it.
/// The two legs are the decision table's two halves, and each is the other's
/// negative control:
///
///  * **rejected declaration, child exit 0** → the child's work SUCCEEDED and the
///    server declined to catalog it. Both dirs are PRESERVED. Reverting the fix
///    (reclaiming here) fails this leg.
///  * **child exit ≠ 0** → the run itself failed; its dirs are scratch, and they
///    are RECLAIMED immediately. Over-correcting to "preserve on every error" —
///    which would leak a staging tree per crashed run until the next boot — fails
///    this leg.
///  * **cataloged** → reclaimed, because the catalog now holds the bytes. A fix
///    that preserved unconditionally fails this leg too.
///
/// So the pair cannot both pass unless the rule is exactly the one documented on
/// `runner::run_dirs_disposition`.
#[tokio::test]
async fn live_finalize_preserves_outputs_when_a_declaration_is_rejected() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "live finalize project").await;
    let pool = pool_for(&server).await;
    let admin_id = admin_user_id(&pool).await;
    let ingest = || {
        Arc::new(RealIngest {
            pool: pool.clone(),
            store_root: store_root(&server),
            project_id: Some(project),
            dataset_id: None,
        })
    };

    // ── (a) exit 0, five declared, four written: the 5th misdeclares a path ──────
    // The audit's exact scenario. `load_produced_outputs` is ALL-OR-NOTHING (the
    // first unresolvable entry errors the whole load), so the four GOOD outputs are
    // never handed to ingest — and if the finalize reclaims on that error, four
    // files of completed work are deleted for a fifth entry's typo.
    let job_partial = insert_running_job(&pool, admin_id, "analysis", None).await;
    let (ws_partial, stg_partial) = stage_declared_vs_present(
        &server,
        job_partial,
        &["o1", "o2", "o3", "o4", "o5"],
        &["o1", "o2", "o3", "o4"],
    )
    .await;
    let good_bytes: Vec<std::path::PathBuf> = ["o1", "o2", "o3", "o4"]
        .iter()
        .map(|n| {
            txresbench::modules::sandbox::outputs::outputs_dir(&stg_partial)
                .join(format!("{n}.bin"))
        })
        .collect();
    for p in &good_bytes {
        assert!(
            p.exists(),
            "fixture non-vacuity: {} was written",
            p.display()
        );
    }

    let res = finalize_analysis_with(
        &job_of(&pool, job_partial).await,
        0,
        &ws_partial,
        &stg_partial,
        PeakMetrics::default(),
        ingest(),
        Arc::new(NoopRunRecorder),
    )
    .await;
    assert!(
        res.is_err(),
        "a manifest declaring a file that is not there FAILS the run (never a false completed)"
    );

    assert!(
        stg_partial.exists(),
        "the staging dir survives a rejected declaration — it holds the only copy of \
         the four outputs the run really produced"
    );
    for p in &good_bytes {
        assert!(
            p.exists(),
            "the good output {} survives the 5th entry's rejection — a rejected \
             declaration must not take the evidence with it",
            p.display()
        );
    }
    assert!(
        ws_partial.exists(),
        "the workspace is preserved with it (the boot re-finalize re-records \
         provenance out of <workspace>/code)"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(job_partial)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "no partial catalog rows from a rejected manifest");

    // ── (b) NEGATIVE CONTROL: the child itself failed → both dirs reclaimed ──────
    // Identical staged bytes; only the exit code differs. A fix that preserved on
    // every error path would keep these, and every crashed run would leak a staging
    // tree until the next boot.
    let job_crashed = insert_running_job(&pool, admin_id, "analysis", None).await;
    let (ws_crashed, stg_crashed) =
        stage_declared_vs_present(&server, job_crashed, &["o1"], &["o1"]).await;
    assert!(
        stg_crashed.exists(),
        "fixture non-vacuity: staged before finalize"
    );

    let res = finalize_analysis_with(
        &job_of(&pool, job_crashed).await,
        3,
        &ws_crashed,
        &stg_crashed,
        PeakMetrics::default(),
        ingest(),
        Arc::new(NoopRunRecorder),
    )
    .await;
    assert!(res.is_err(), "a non-zero exit fails the run");
    assert!(
        !stg_crashed.exists(),
        "a run that itself FAILED has its staging reclaimed immediately — its bytes \
         are scratch, not a work product"
    );
    assert!(!ws_crashed.exists(), "…and its workspace with it");

    // ── (c) NEGATIVE CONTROL: cataloged → both dirs reclaimed ───────────────────
    // The catalog now holds the bytes, so the staging copy is redundant. A fix that
    // preserved unconditionally would leak here on EVERY successful run.
    let job_ok = insert_running_job(&pool, admin_id, "analysis", None).await;
    let (ws_ok, stg_ok) = stage_declared_vs_present(&server, job_ok, &["good"], &["good"]).await;
    let res = finalize_analysis_with(
        &job_of(&pool, job_ok).await,
        0,
        &ws_ok,
        &stg_ok,
        PeakMetrics::default(),
        ingest(),
        Arc::new(NoopRunRecorder),
    )
    .await;
    assert!(
        res.is_ok(),
        "a valid manifest whose files exist ingests: {res:?}"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(job_ok)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "the good run cataloged its output");
    assert!(
        !stg_ok.exists(),
        "a cataloged run's staging is reclaimed — the catalog holds the bytes now"
    );
    assert!(!ws_ok.exists(), "…and its workspace with it");
}

#[tokio::test]
async fn missing_or_escaping_output_fails_and_preserves_workspace() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "ingest failure project").await;
    let pool = pool_for(&server).await;
    let admin_id = admin_user_id(&pool).await;
    let root = sandboxes_root(&server);
    let staging_root = run_staging_root(&server);

    // (a) A running analysis job whose declared output FILE is missing.
    let job_missing = insert_running_job(&pool, admin_id, "analysis", None).await;
    let (dir_missing, stg_missing) = stage_manifest_only(&server, job_missing, json!({ "outputs": [
        { "id": "x", "datatype": "file/upload", "path": "x.bin", "layout": "opaque", "role": "artifact" }
    ]})).await;

    // (b) A running analysis job whose declared output ESCAPES /outputs.
    let job_escape = insert_running_job(&pool, admin_id, "analysis", None).await;
    let (dir_escape, stg_escape) = stage_manifest_only(&server, job_escape, json!({ "outputs": [
        { "id": "e", "datatype": "file/upload", "path": "../escape.bin", "layout": "opaque", "role": "artifact" }
    ]})).await;
    // The escape target exists OUTSIDE /outputs (so canonicalize resolves, then the
    // containment check rejects it). `..` from `<staging>/outputs` is the STAGING dir —
    // the tree `/outputs` is actually mounted out of — so that is where it goes.
    tokio::fs::write(stg_escape.join("escape.bin"), b"outside")
        .await
        .unwrap();

    // Reconcile: neither has a VALID manifest → both fail-preserved, ingest never runs.
    let report = reconcile_orphaned_running_in(
        &pool,
        &root,
        &staging_root,
        Arc::new(RealIngest {
            pool: pool.clone(),
            store_root: store_root(&server),
            project_id: Some(project),
            dataset_id: None,
        }),
        Arc::new(NoopRunRecorder),
    )
    .await;
    assert!(
        report.finalized.is_empty(),
        "no job finalized (both outputs invalid)"
    );
    assert!(
        report.failed_preserved.contains(&job_missing)
            && report.failed_preserved.contains(&job_escape),
        "both are fail-preserved"
    );

    for id in [job_missing, job_escape] {
        let (status, _, finished, _) = job_row(&pool, id).await;
        assert_eq!(
            status, "failed",
            "the job is FAILED, never a false completed"
        );
        assert!(finished, "terminal finished_at set");
    }
    // BOTH run dirs are KEPT (never silently discarded) — the workspace and, in its
    // own tree, the staging holding whatever the run did write. A co-located fixture
    // could only ever have asserted one dir under two names.
    assert!(
        dir_missing.exists(),
        "the missing-output workspace is preserved"
    );
    assert!(
        stg_missing.exists(),
        "the missing-output staging is preserved with it"
    );
    assert!(
        dir_escape.exists(),
        "the escaping-output workspace is preserved"
    );
    assert!(
        stg_escape.exists(),
        "the escaping-output staging is preserved with it"
    );
    assert!(
        stg_escape.join("escape.bin").exists(),
        "the escaping bytes themselves survive for inspection — a rejected declaration \
         must not take the evidence with it"
    );
    // No partial catalog — zero artifacts for either run.
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM artifacts \
         WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)",
    )
    .bind(uuid_list_json(&[job_missing, job_escape]))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 0, "no partial catalog rows from a failed ingest");

    // (c) Direct ingest of a missing-file manifest → hard error, zero rows, ws kept.
    let run = uuid::Uuid::new_v4();
    let ws = server.data_dir().join(format!("ingest-fail-{run}"));
    let out = ws.join("outputs");
    tokio::fs::create_dir_all(&out).await.unwrap();
    tokio::fs::write(out.join("manifest.json"), serde_json::to_vec(&json!({ "outputs": [
        { "id": "y", "datatype": "file/upload", "path": "y.bin", "layout": "opaque", "role": "artifact" }
    ]})).unwrap()).await.unwrap();
    let store = server_store(&server);
    let res = ingest_run_outputs(&pool, &store, Some(project), None, run, None, &ws).await;
    assert!(
        res.is_err(),
        "ingest of a missing declared output errors (no silent success)"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        n, 0,
        "a failed ingest inserts NO catalog rows (all-or-nothing)"
    );
    assert!(
        ws.exists(),
        "the workspace is preserved after a failed ingest"
    );
}
