//! TEST-8 [acceptance] [invariant: INV-3] — the SINGLE compute-metering gate,
//! `seams::install_process_compute_meter` (the one `JobsModule::init` uses), proven in BOTH
//! cfg profiles from ONE test: on the `saas` (cloud) build it installs a `DbComputeMeter` that
//! writes a row; on the desktop/default build it leaves the `NoopComputeMeter` seam default,
//! which writes NOTHING (no metering export on desktop — DE-INV-10, unregressed). The expected
//! row count is exactly `cfg!(feature = "saas") as i64`.

use cytoanalyst::modules::jobs::seams::{
    compute_meter, install_process_compute_meter, ComputeUsage,
};

use super::{compute_meter_count, finished_job, pool_for};
use crate::common::TestServer;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_metering_export_is_saas_gated() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    // The production gate: build+install the deploy-appropriate meter, and observe the impl it
    // returns (no fragile process-global read).
    let meter = install_process_compute_meter(pool.clone());

    // A scope-less finished job — the account resolution is irrelevant here; only whether a row
    // is WRITTEN AT ALL, which is the desktop-vs-cloud gate.
    let job = finished_job(0);
    meter
        .record_usage(
            &job,
            ComputeUsage {
                cpu_secs: 3.0,
                wall_secs: 3.0,
                gpu_secs: 0.0,
                ram_peak_bytes: Some(64),
                exit_code: 0,
            },
        )
        .await;

    let expected = cfg!(feature = "saas") as i64;
    assert_eq!(
        compute_meter_count(&pool, job.id).await,
        expected,
        "saas build writes ONE compute_meter row; desktop/default build writes ZERO \
         (NoopComputeMeter — no metering export on desktop, INV-3)"
    );

    // Also prove the PROCESS-GLOBAL seam (the getter the real finalize path uses) matches the
    // gate — not merely the Arc returned above: under saas the install wired the global to the
    // DbComputeMeter; on desktop the global stays the NoopComputeMeter default (uninstalled).
    let global_job = finished_job(0);
    compute_meter()
        .record_usage(
            &global_job,
            ComputeUsage {
                cpu_secs: 1.0,
                wall_secs: 1.0,
                gpu_secs: 0.0,
                ram_peak_bytes: None,
                exit_code: 0,
            },
        )
        .await;
    assert_eq!(
        compute_meter_count(&pool, global_job.id).await,
        expected,
        "the installed process-global seam matches the gate (saas → writes; desktop → Noop)"
    );
}
