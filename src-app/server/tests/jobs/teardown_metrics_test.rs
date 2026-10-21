//! TEST-5 [acceptance] [invariant: INV-5] — the G3 child-exit teardown-metrics seam
//! (PROV-T3-3). A finished run emits EXACTLY ONE `compute_meter` raw signal keyed by
//! `job_id`; a boot re-finalize of the SAME job does NOT double-emit (idempotent by the
//! `job_id` natural key). With the `NoopComputeMeter` (the desktop/pre-install default)
//! nothing is recorded. This is the raw per-job cpu/gpu-seconds signal the deferred T5
//! aggregates into exactly-once, account-keyed metering.

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use cytoanalyst::modules::jobs::models::Job;
use cytoanalyst::modules::jobs::seams::{
    ComputeMeter, ComputeUsage, DbComputeMeter, NoopComputeMeter,
};

use crate::common::TestServer;

fn finished_job() -> Job {
    Job {
        id: Uuid::new_v4(),
        owner_id: Uuid::new_v4(),
        job_type: "analysis".into(),
        name: "teardown-metrics".into(),
        status: "completed".into(),
        params: serde_json::json!({}),
        created_at: Utc::now(),
        started_at: Some(Utc::now()),
        finished_at: Some(Utc::now()),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_metrics_exactly_once_per_job() {
    let server = TestServer::spawn().await;
    let pool = sqlx::PgPool::connect(server.database_url())
        .await
        .expect("connect test db");

    let meter = DbComputeMeter::new(pool.clone());
    let job = finished_job();

    // Live finalize: record the real teardown reading.
    meter
        .record_usage(
            &job,
            ComputeUsage {
                cpu_secs: 1.5,
                wall_secs: 2.25,
                gpu_secs: 0.0,
                ram_peak_bytes: Some(4096),
                exit_code: 0,
            },
        )
        .await;

    // Boot re-finalize of the SAME job (a crash-recovery path) — a DIFFERENT (zero) reading.
    // It must NOT double-emit; the first writer wins (idempotent by job_id).
    meter
        .record_usage(&job, ComputeUsage::from_peak(Default::default(), 0))
        .await;

    // TEST-1 [acceptance] [invariant: INV-1] — exactly ONE row per job_id after a live finalize
    // + a boot re-finalize (the exactly-once negative control), now carrying the T5 columns.
    let rows = sqlx::query(
        "SELECT cpu_secs, wall_secs, ram_peak_bytes, gpu_secs, resource_class, finished_at, account_id \
         FROM compute_meter WHERE job_id = $1",
    )
    .bind(job.id)
    .fetch_all(&pool)
    .await
    .expect("query compute_meter");
    assert_eq!(
        rows.len(),
        1,
        "exactly ONE row per job_id (INV-1 exactly-once; a boot re-finalize did NOT double-emit)"
    );
    let cpu: f64 = rows[0].get("cpu_secs");
    let wall: f64 = rows[0].get("wall_secs");
    let ram: Option<i64> = rows[0].get("ram_peak_bytes");
    assert_eq!(
        cpu, 1.5,
        "the FIRST (live) reading wins, not the zero re-finalize"
    );
    assert_eq!(wall, 2.25);
    assert_eq!(ram, Some(4096));
    // T5 columns: resource_class from the job, finished_at present (the fold high-water mark).
    // This scope-less job (no project) resolves to a NULL account — fail-safe, DEC-1.
    let rc: String = rows[0].get("resource_class");
    let finished_at: Option<chrono::DateTime<chrono::Utc>> = rows[0].get("finished_at");
    let account_id: Option<uuid::Uuid> = rows[0].get("account_id");
    assert_eq!(
        rc, "cpu-sandbox",
        "resource_class recorded from the job (DEC-8)"
    );
    assert!(
        finished_at.is_some(),
        "finished_at present (B1 fold high-water mark)"
    );
    assert_eq!(
        account_id, None,
        "a scope-less job (no project/dataset) records account_id=NULL (fail-safe, DEC-1)"
    );

    // NoopComputeMeter (desktop/pre-install default) records NOTHING (INV-5).
    let noop_job = finished_job();
    NoopComputeMeter
        .record_usage(
            &noop_job,
            ComputeUsage {
                cpu_secs: 9.0,
                wall_secs: 9.0,
                gpu_secs: 0.0,
                ram_peak_bytes: Some(1),
                exit_code: 0,
            },
        )
        .await;
    let noop_count: i64 =
        sqlx::query("SELECT count(*)::bigint AS c FROM compute_meter WHERE job_id = $1")
            .bind(noop_job.id)
            .fetch_one(&pool)
            .await
            .expect("count noop rows")
            .get("c");
    assert_eq!(
        noop_count, 0,
        "NoopComputeMeter records nothing (desktop default, INV-5)"
    );
}
