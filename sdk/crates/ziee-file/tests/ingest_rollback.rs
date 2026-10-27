//! Crate-scoped DB integration test for `ingest::store_processed`'s blob
//! rollback.
//!
//! When the `files`/`file_versions` INSERT fails AFTER the original + derivative
//! blobs were already written to the file store, `store_processed` must
//! `delete_all` the orphaned storage so no blob outlives a row that will never
//! reference it. This drives that path on a fresh throwaway DB: we drop the
//! table the second INSERT targets so `repo.create()` fails deterministically
//! after the blobs are on disk, then assert the store was cleaned.
//!
//! Dual-driver: the harness in `common` provisions the driver of the build;
//! only the table-drop leg differs (the postgres `CASCADE` keyword vs the plain
//! sqlite drop — the ported schema has no FK targeting `file_versions`, so no
//! cascade is needed there).

mod common;
use common::{drop_db, fresh_db};

use uuid::Uuid;

use ziee_file::init_file_storage;
use ziee_file::ingest::store_processed;
use ziee_file::models::ProcessingResult;
use ziee_file::repository::FileRepository;
use ziee_file::seams::FileEvents;

/// Force `repo.create()` to fail AFTER the blobs are written: drop the table
/// its SECOND INSERT targets. The `CASCADE` keyword additionally drops the
/// deferred `files.current_version_id` FK on postgres, so the parent INSERT
/// succeeds and the `file_versions` INSERT is what errors — exercising the
/// rollback branch, not a pre-write failure. On sqlite the ported chain has no
/// FK to cascade (the baseline's FK claim is stale on BOTH engines), so the
/// plain drop gives the identical failure point.
async fn drop_version_table(pool: &ziee_core::DbPool) {
    #[cfg(not(feature = "sqlite-backend"))]
    {
        use sqlx::Executor;
        pool.execute("DROP TABLE file_versions CASCADE")
            .await
            .expect("drop file_versions to force a create() failure");
    }
    #[cfg(feature = "sqlite-backend")]
    {
        use sqlx::Executor;
        pool.execute("DROP TABLE file_versions")
            .await
            .expect("drop file_versions to force a create() failure");
    }
}

/// No-op events sink — the rollback path fires no event (it returns Err before
/// `on_file_changed`), so these are never called, but `store_processed` requires
/// a `&dyn FileEvents`.
struct NoopEvents;
impl FileEvents for NoopEvents {
    fn on_file_changed(&self, _user_id: Uuid, _file_id: Uuid, _origin: Option<Uuid>) {}
    fn on_file_deleted(&self, _user_id: Uuid, _file_id: Uuid, _origin: Option<Uuid>) {}
}

/// Count directory entries, treating a missing directory as empty.
fn dir_entry_count(path: &std::path::Path) -> usize {
    std::fs::read_dir(path).map(|it| it.count()).unwrap_or(0)
}

#[tokio::test]
async fn store_processed_rolls_back_blobs_when_the_db_create_fails() {
    let (pool, db) = fresh_db().await;

    // Point the process-global file store at a scratch tree we can inspect.
    let tmp = tempfile::tempdir().unwrap();
    init_file_storage(tmp.path());

    let repo = FileRepository::new(pool.clone());
    let events = NoopEvents;
    let user = Uuid::new_v4();

    // Force `repo.create()` to fail AFTER `store_processed` has already written
    // the blobs: drop the table its SECOND INSERT targets (see
    // `drop_version_table`).
    drop_version_table(&pool).await;

    // Include a derivative (a text page) so the rollback must clean more than
    // just the original.
    let processed = ProcessingResult {
        text_pages: vec!["page one text".to_string()],
        ..Default::default()
    };

    let res = store_processed(
        &repo,
        &events,
        user,
        b"hello original bytes",
        "notes.txt",
        Some("text/plain".to_string()),
        "user",
        None,
        &processed,
    )
    .await;

    assert!(
        res.is_err(),
        "create() must fail once file_versions is dropped"
    );

    // The original blob written before the DB failure must be rolled back: the
    // user's originals dir holds zero blobs (we don't know the internally-
    // generated file_id, so emptiness is the observable invariant).
    let originals = tmp.path().join("originals").join(user.to_string());
    assert_eq!(
        dir_entry_count(&originals),
        0,
        "the orphaned original blob must be cleaned up after the DB failure"
    );

    // The text-page derivative dir was removed too (delete_all removes the
    // per-file text directory).
    let textdir = tmp.path().join("text").join(user.to_string());
    assert_eq!(
        dir_entry_count(&textdir),
        0,
        "the orphaned text derivative must be cleaned up after the DB failure"
    );

    drop_db(&db).await;
}
