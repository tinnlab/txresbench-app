//! TEST-7 [acceptance] [invariant: INV-4] — the PROVIDER-side pin of the cross-epic contract
//! PROV-compute-metering-1. Billing B1's fold binds an EXACT column set/types on
//! `compute_meter`/`storage_meter`; this test introspects `information_schema` and asserts T5
//! emits a SUPERSET of exactly that shape. A T5 divergence fails HERE (Pact across the
//! boundary), rather than silently at B1 integration.

use std::collections::HashMap;

use super::pool_for;
use crate::common::TestServer;

async fn columns(pool: &sqlx::PgPool, table: &str) -> HashMap<String, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT column_name, data_type FROM information_schema.columns \
         WHERE table_name = $1 AND table_schema = 'public'",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .expect("introspect columns");
    rows.into_iter().collect()
}

fn assert_col(cols: &HashMap<String, String>, table: &str, name: &str, want_type: &str) {
    let got = cols
        .get(name)
        .unwrap_or_else(|| panic!("{table}.{name} MISSING — PROV-compute-metering-1 requires it"));
    assert_eq!(
        got, want_type,
        "{table}.{name} type is `{got}`, PROV-compute-metering-1 requires `{want_type}`"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn meter_schema_matches_prov_compute_metering_1() {
    let server = TestServer::spawn().await;
    let pool = pool_for(&server).await;

    // compute_meter — the columns B1's per-account, resource-class-split fold binds.
    let cm = columns(&pool, "compute_meter").await;
    assert_col(&cm, "compute_meter", "job_id", "uuid");
    assert_col(&cm, "compute_meter", "account_id", "uuid");
    assert_col(&cm, "compute_meter", "resource_class", "text");
    assert_col(&cm, "compute_meter", "cpu_secs", "double precision");
    assert_col(&cm, "compute_meter", "gpu_secs", "double precision");
    assert_col(
        &cm,
        "compute_meter",
        "finished_at",
        "timestamp with time zone",
    );

    // storage_meter — the columns B1's time-weighted GB-months fold binds.
    let sm = columns(&pool, "storage_meter").await;
    assert_col(&sm, "storage_meter", "account_id", "uuid");
    assert_col(&sm, "storage_meter", "delta_bytes", "bigint");
    assert_col(&sm, "storage_meter", "logical_bytes", "bigint");
    assert_col(
        &sm,
        "storage_meter",
        "created_at",
        "timestamp with time zone",
    );

    // job_id is the exactly-once natural key — a UNIQUE/PK constraint must exist on it
    // (the guard that makes a boot re-finalize a no-op, INV-1).
    let job_id_unique: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM information_schema.table_constraints tc \
           JOIN information_schema.key_column_usage kcu \
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
           WHERE tc.table_name = 'compute_meter' \
             AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE') \
             AND kcu.column_name = 'job_id' )",
    )
    .fetch_one(&pool)
    .await
    .expect("check job_id uniqueness");
    assert!(
        job_id_unique,
        "compute_meter.job_id must be UNIQUE/PK — the exactly-once key B1 relies on"
    );
}
