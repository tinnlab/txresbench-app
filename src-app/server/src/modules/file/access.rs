//! Who may reach a FILE — the app's answer, and the seam it is injected
//! through.
//!
//! ## Why this module exists
//!
//! `txresbench-file` is a generic blob store. Its own scope is `files.user_id`, the
//! UPLOADING actor (`ingest_bytes(&…, auth.user.id, …)`), and `files` carries no
//! `account_id` (DEC-7). In the org platform a file was reached through the DATASET
//! it is linked to, and a dataset belonged to an ACCOUNT — so `files.user_id`
//! recorded provenance and said nothing about entitlement. The platform answer was
//! [`DatasetFileAccessPolicy`], which resolved standing through the dataset graph.
//!
//! ## The app's answer (ITEM-3)
//!
//! The single-cell strip removes the dataset/project/workstore/provenance graph
//! (`datasets`, `dataset_files`, `dataset_shares`, `projects`, `artifacts` are all
//! dropped tables). With no dataset a file can be attached to, the entitlement
//! question collapses to the one scope the blob store itself carries:
//!
//! - the UPLOADER (`files.user_id`), and
//! - the platform ADMIN (`users.is_admin`), the same bypass every other gate in
//!   this build uses (`permissions.rs` short-circuits on `is_admin`; the app's
//!   single owner is an admin).
//!
//! That is both read AND write standing: the old read/write split existed because a
//! `view`-role dataset sharee could otherwise delete files, but a share cannot exist
//! without `dataset_shares`, and the platform's removed-member hole was closed
//! through the same dataset graph. The two predicates below therefore carry the
//! SAME authority, kept as separate functions so the seam's read/write distinction
//! still has an explicit answer here rather than being silently collapsed.
//!
//! ## The seam
//!
//! The SDK grew an injected [`txresbench_file::seams::FileAccessPolicy`], and
//! [`DatasetFileAccessPolicy`] is TxResBench's implementation of it — the mounted
//! `file_routes` consult it for every metadata/content/write/delete access.

use std::collections::HashSet;

use async_trait::async_trait;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::AppError;
use txresbench_file::seams::{FileAccess, FileAccessPolicy};

/// The subset of `candidates` that `user_id` may read, PRESERVING the given
/// order.
///
/// Ordering is restored in Rust rather than in SQL: the membership `IN` returns
/// rows in whatever order the planner likes, and the seam's contract is that the
/// caller's candidate order survives (the store hands over ids already sorted
/// `created_at DESC` and pages the result).
///
/// ITEM-3: the dataset-visibility branch (a hand-copy of
/// `DatasetRepository`/`require_dataset_read` visibility) was removed with the
/// `dataset` module; the authority is now the uploader + platform admin, above.
pub async fn readable_file_ids(
    pool: &SqlitePool,
    user_id: Uuid,
    candidates: &[Uuid],
) -> Result<Vec<Uuid>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let candidates_json = uuid_list_json(candidates);
    let rows: Vec<Uuid> = sqlx::query_scalar!(
        // BATCH FORM. The candidate set is the JSON1 membership form
        // (`f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)` — the
        // DEC-8 `uuid[]` → JSON-array-text rule bound in the 32-hex
        // `Uuid::simple()` form; a hyphenated list never matches). The disjunction
        // — the file-owner branch and the admin bypass — is the whole answer for
        // this build.
        r#"SELECT f.id as "id: Uuid" FROM files f WHERE f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j) AND (
               (f.user_id = $2)
               OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.is_admin)
             )"#,
        candidates_json,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let allowed: HashSet<Uuid> = rows.into_iter().collect();
    Ok(candidates
        .iter()
        .copied()
        .filter(|id| allowed.contains(id))
        .collect())
}

/// The subset of `candidates` that `user_id` may **WRITE** — restore a version of,
/// or DELETE — preserving the given order.
///
/// ITEM-3: with no dataset graph there is no read/write standing distinction to
/// make — the `edit`-role share that used to be the only path admitting a
/// non-uploader writer is itself a removed table, and no new write authority is
/// invented. The predicate is therefore the same as [`readable_file_ids`]: the
/// uploader, or the platform admin.
pub async fn writable_file_ids(
    pool: &SqlitePool,
    user_id: Uuid,
    candidates: &[Uuid],
) -> Result<Vec<Uuid>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let candidates_json = uuid_list_json(candidates);
    let rows: Vec<Uuid> = sqlx::query_scalar!(
        r#"SELECT f.id as "id: Uuid" FROM files f WHERE f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j) AND (
               (f.user_id = $2)
               OR EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.is_admin)
             )"#,
        candidates_json,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let allowed: HashSet<Uuid> = rows.into_iter().collect();
    Ok(candidates
        .iter()
        .copied()
        .filter(|id| allowed.contains(id))
        .collect())
}

/// TxResBench's [`FileAccessPolicy`]: reads resolve through [`readable_file_ids`],
/// writes through [`writable_file_ids`].
///
/// ITEM-3: the two predicates carry the same authority (uploader + admin) — the
/// read/write split is kept as an EXPLICIT answer, not as a behavioural
/// difference, and `resolve` remains the ONE place the mapping is decided, so
/// `can_access` and `filter` cannot disagree about which question they are
/// asking.
///
/// Spelled as an exhaustive match rather than a wildcard: [`FileAccess`] is
/// `#[non_exhaustive]`, so a variant the SDK adds later cannot be made a compile
/// error here — but it CAN be made a denial. A wildcard would silently grant a
/// future kind whatever the read predicate answers.
pub struct DatasetFileAccessPolicy {
    pool: SqlitePool,
}

impl DatasetFileAccessPolicy {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The predicate for `access` — the ONE place the read/write split is decided.
    async fn resolve(
        &self,
        principal: Uuid,
        candidates: &[Uuid],
        access: FileAccess,
    ) -> Result<Vec<Uuid>, AppError> {
        match access {
            FileAccess::ReadMetadata | FileAccess::ReadContent => {
                readable_file_ids(&self.pool, principal, candidates).await
            }
            FileAccess::Write | FileAccess::Delete => {
                writable_file_ids(&self.pool, principal, candidates).await
            }
            _ => Ok(Vec::new()),
        }
    }
}

#[async_trait]
impl FileAccessPolicy for DatasetFileAccessPolicy {
    async fn can_access(
        &self,
        principal: Uuid,
        file_id: Uuid,
        access: FileAccess,
    ) -> Result<bool, AppError> {
        Ok(!self.resolve(principal, &[file_id], access).await?.is_empty())
    }

    async fn filter(
        &self,
        principal: Uuid,
        candidates: &[Uuid],
        access: FileAccess,
    ) -> Result<Vec<Uuid>, AppError> {
        self.resolve(principal, candidates, access).await
    }
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicate consumes: a JSON array of 32-char lowercase hex strings (the
/// `uuid::Uuid::simple()` form), compared against a 16-byte BLOB column
/// through `unhex()` — `f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)`.
/// This is the ITEM-15 `txresbench-file` convention (its `uuid_list_json`), kept
/// local here because the app's modules are single-driver (DEC-1). The caller's
/// order is restored in Rust (the `IN` returns rows in whatever order the
/// planner likes), so only the SET membership matters.
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}
