//! TEST-9 [covers: ITEM-7] — the KEDA scaler SQL counts ONLY claimable work.
//!
//! Reads the EXACT `query:` from `src-app/cloud-sim/keda-scaledobject.yaml` (so the
//! test tracks the shipped manifest, not a copy) and runs it against the real
//! `jobs` schema: a `queued` row counts; a `running`/`completed` row does NOT —
//! so replicas are never held up for not-yet-claimable rows (§13a.3 caveat), and
//! scale-to-zero is reachable once the queue drains.

use std::path::Path;

use sqlx::SqlitePool;
use uuid::Uuid;

use super::{pool_for, register_user};
use crate::common::{TestOptions, TestServer};

/// Pull the `query:` value out of the committed ScaledObject manifest.
fn scaler_query() -> String {
    let manifest =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../cloud-sim/keda-scaledobject.yaml");
    let text = std::fs::read_to_string(&manifest)
        .unwrap_or_else(|e| panic!("read {}: {e}", manifest.display()));
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("query:") {
            // Strip ONE layer of MATCHING surrounding quotes (YAML double-quotes
            // the value). Do NOT blanket-strip both quote kinds — the SQL body
            // itself ends in a single-quoted literal (`'queued'`), so a naive
            // trim_matches('\'') would eat its closing quote and unterminate it.
            let v = rest.trim();
            let unquoted = if v.len() >= 2
                && ((v.starts_with('"') && v.ends_with('"'))
                    || (v.starts_with('\'') && v.ends_with('\'')))
            {
                &v[1..v.len() - 1]
            } else {
                v
            };
            return unquoted.to_string();
        }
    }
    panic!("no `query:` line in keda-scaledobject.yaml");
}

async fn insert_job(pool: &SqlitePool, owner: Uuid, status: &str) {
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at, finished_at) \
         VALUES ($1, $2, 'stub', 'k', $3, CASE WHEN $3 <> 'queued' THEN now() END, \
                 CASE WHEN $3 IN ('completed','failed') THEN now() END)",
    )
    .bind(Uuid::new_v4())
    .bind(owner)
    .bind(status)
    .execute(pool)
    .await
    .expect("insert job");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keda_scaler_query_counts_only_queued() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "kedaq").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;

    let query = scaler_query();
    assert!(
        query.contains("status") && query.contains("queued"),
        "the shipped scaler query filters on status='queued' (got: {query})"
    );

    // 3 queued + 2 running + 1 completed. Only the 3 queued are claimable.
    for _ in 0..3 {
        insert_job(&pool, owner, "queued").await;
    }
    for _ in 0..2 {
        insert_job(&pool, owner, "running").await;
    }
    insert_job(&pool, owner, "completed").await;

    // Run the manifest's OWN query and assert it returns exactly the queued count —
    // a running/completed row does NOT inflate it (no replica hold-up on
    // already-claimed / finished work).
    let depth: i32 = sqlx::query_scalar(&query)
        .fetch_one(&pool)
        .await
        .expect("run the scaler query against the real jobs schema");
    assert_eq!(
        depth, 3,
        "the KEDA scaler counts ONLY status='queued' (claimable) work"
    );
}
