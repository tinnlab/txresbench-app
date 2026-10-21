//! T5 account-keying + exactly-once behaviour on the REAL `DbComputeMeter` (constructed
//! directly against the test pool — the impl is not `saas`-gated, only its INSTALL is).

use cytoanalyst::modules::jobs::seams::{ComputeMeter, ComputeUsage, DbComputeMeter};

use super::{
    compute_meter_account, compute_meter_count, create_project, finished_job, insert_dataset,
    insert_job, insert_org_account, pool_for, project_account, project_owner, scope_job_to_dataset,
    scope_job_to_project, set_project_account, setup_admin,
};
use crate::common::TestServer;

fn usage(exit_code: i32) -> ComputeUsage {
    ComputeUsage {
        cpu_secs: 1.25,
        wall_secs: 2.0,
        gpu_secs: 0.0,
        ram_peak_bytes: Some(8192),
        exit_code,
    }
}

/// TEST-2 [acceptance] [invariant: INV-2] — a job whose PROJECT belongs to an organization
/// account meters to that ORG account (`account_of_project`), NOT the launcher's personal
/// account; a DATASET-scoped job meters to the dataset's account; a scope-less job → NULL
/// (fail-safe, DEC-1). No metering artifact keys on `user_id`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_meter_keys_on_project_account_not_launcher() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let meter = DbComputeMeter::new(pool.clone());

    // A project created by the admin starts in the admin's PERSONAL account.
    let project = create_project(&server, &token, "t5 project").await;
    let personal = project_account(&pool, project).await;

    // Re-parent it to a distinct ORG account — this is the tenant the row must key on.
    let org = insert_org_account(&pool, "t5-org").await;
    assert_ne!(
        org, personal,
        "the org account differs from the launcher's personal one"
    );
    set_project_account(&pool, project, org).await;

    // Launch (a member's job) — a real jobs row owned by the admin user; the project it is
    // scoped to belongs to the ORG, so metering must key on the org, not the launcher.
    let owner = project_owner(&pool, project).await;
    let job = finished_job(0);
    insert_job(&pool, &job, owner).await;
    scope_job_to_project(&pool, job.id, project).await;
    meter.record_usage(&job, usage(0)).await;

    assert_eq!(
        compute_meter_account(&pool, job.id).await,
        Some(org),
        "the compute_meter row keys on the PROJECT's account (INV-2), not the launcher"
    );

    // Dataset-scoped job → the dataset's account.
    let ds_account = insert_org_account(&pool, "t5-ds-org").await;
    let dataset = insert_dataset(&pool, owner, ds_account).await;
    let ds_job = finished_job(0);
    insert_job(&pool, &ds_job, owner).await;
    scope_job_to_dataset(&pool, ds_job.id, dataset).await;
    meter.record_usage(&ds_job, usage(0)).await;
    assert_eq!(
        compute_meter_account(&pool, ds_job.id).await,
        Some(ds_account),
        "a dataset-scoped job meters to the dataset's account (account_of_dataset, INV-2)"
    );

    // Scope-less job → account_id NULL, row still lands (fail-safe, DEC-1).
    let bare = finished_job(0);
    meter.record_usage(&bare, usage(0)).await;
    assert_eq!(
        compute_meter_count(&pool, bare.id).await,
        1,
        "scope-less row still lands"
    );
    assert_eq!(
        compute_meter_account(&pool, bare.id).await,
        None,
        "a scope-less job records account_id=NULL (fail-safe)"
    );
}

/// TEST-4 — a FAILED (non-zero exit) job STILL writes exactly one row (a failed run consumed
/// compute — DEC-6); and a project whose account MOVED between enqueue and finalize meters to
/// the account resolved AT FINALIZE (a live read, not a stale enqueue snapshot — DEC-2).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_job_writes_row_and_moved_account_is_live() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let meter = DbComputeMeter::new(pool.clone());

    // Failed job still meters.
    let project = create_project(&server, &token, "t5 failed").await;
    let owner = project_owner(&pool, project).await;
    let a1 = insert_org_account(&pool, "t5-fail-org").await;
    set_project_account(&pool, project, a1).await;
    let failed = finished_job(1);
    insert_job(&pool, &failed, owner).await;
    scope_job_to_project(&pool, failed.id, project).await;
    meter.record_usage(&failed, usage(1)).await;
    assert_eq!(
        compute_meter_count(&pool, failed.id).await,
        1,
        "a failed run still writes exactly one compute_meter row (DEC-6)"
    );

    // Move the project's account, THEN finalize a different job — it meters to the NEW account.
    let a2 = insert_org_account(&pool, "t5-moved-org").await;
    set_project_account(&pool, project, a2).await;
    let moved = finished_job(0);
    insert_job(&pool, &moved, owner).await;
    scope_job_to_project(&pool, moved.id, project).await;
    meter.record_usage(&moved, usage(0)).await;
    assert_eq!(
        compute_meter_account(&pool, moved.id).await,
        Some(a2),
        "account resolved AT FINALIZE (live read), not the enqueue-time account (DEC-2, no stale snapshot)"
    );
}

/// TEST-9 — exactly-once under CONCURRENCY: two simultaneous `record_usage` for the SAME
/// job produce exactly ONE row (the `ON CONFLICT (job_id) DO NOTHING` guard holds).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_finalizes_write_one_row() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let project = create_project(&server, &token, "t5 concurrent").await;
    let owner = project_owner(&pool, project).await;
    let org = insert_org_account(&pool, "t5-conc-org").await;
    set_project_account(&pool, project, org).await;

    let job = finished_job(0);
    insert_job(&pool, &job, owner).await;
    scope_job_to_project(&pool, job.id, project).await;

    let m1 = DbComputeMeter::new(pool.clone());
    let m2 = DbComputeMeter::new(pool.clone());
    let j1 = job.clone();
    let j2 = job.clone();
    let h1 = tokio::spawn(async move { m1.record_usage(&j1, usage(0)).await });
    let h2 = tokio::spawn(async move { m2.record_usage(&j2, usage(0)).await });
    let _ = tokio::join!(h1, h2);

    assert_eq!(
        compute_meter_count(&pool, job.id).await,
        1,
        "two concurrent finalizes of the same job_id collapse to ONE row (exactly-once under concurrency)"
    );
    assert_eq!(compute_meter_account(&pool, job.id).await, Some(org));
}
