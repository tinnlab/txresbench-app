//! The pretrained_catalogue integration suite — ITEM-1's file set
//! (TEST-PC-10 + TEST-PC-11) and ITEM-2's generator driver
//! (TEST-PC-12/16/26). The api/downloader/install/hygiene suites
//! arrive with the items they cover.

use crate::common::TestServer;

pub mod gen_catalogue_test;
pub mod pack_model_test;

/// The per-test pool (the same database the spawned server serves).
pub async fn pool(server: &TestServer) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("per-test pool connects")
}
