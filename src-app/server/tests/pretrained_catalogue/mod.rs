//! The pretrained_catalogue integration suite — ITEM-1's file set
//! (TEST-PC-10 + TEST-PC-11). The api/downloader/install/hygiene suites
//! arrive with the items they cover.

use crate::common::TestServer;

pub mod pack_model_test;

/// The per-test pool (the same database the spawned server serves).
pub async fn pool(server: &TestServer) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("per-test pool connects")
}
