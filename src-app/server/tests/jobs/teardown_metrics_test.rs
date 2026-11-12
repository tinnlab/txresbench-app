//! TEST-5 [acceptance] [invariant: INV-5] — the G3 child-exit teardown-metrics seam
//! (PROV-T3-3): a finished run emits a `compute_meter` raw signal keyed by `job_id`
//! through the `ComputeMeter` seam.
//!
//! TxResBench strip: the `DbComputeMeter` (the DB-backed metering writer, saas-gated)
//! was removed with the SaaS surface, so the DB-half of this acceptance test — the
//! live `record_usage` writes exactly one row, a boot re-finalize does not double-emit
//! (`ON CONFLICT (job_id) DO NOTHING`) — is retired with it. What remains enforceable
//! is the desktop default: the `NoopComputeMeter` writes NOTHING.

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use txresbench::modules::jobs::models::Job;
use txresbench::modules::jobs::seams::{ComputeMeter, ComputeUsage, NoopComputeMeter};

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
async fn teardown_metrics_noop_records_nothing() {
    let server = TestServer::spawn().await;
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect test db");

    // NoopComputeMeter (desktop/pre-install default) records NOTHING (INV-5).
    NoopComputeMeter
        .record_usage(
            &finished_job(),
            ComputeUsage {
                cpu_secs: 9.0,
                wall_secs: 9.0,
                gpu_secs: 0.0,
                ram_peak_bytes: Some(1),
                exit_code: 0,
            },
        )
        .await;
    let count: i64 =
        sqlx::query("SELECT count(*) AS c FROM compute_meter")
            .fetch_one(&pool)
            .await
            .expect("count meter rows")
            .get("c");
    assert_eq!(
        count, 0,
        "NoopComputeMeter records nothing (desktop default, INV-5)"
    );
}
