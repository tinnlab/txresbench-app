// File repository
//
// Versioning model: `files` is the parent (PK = stable file_id, referenced
// everywhere). `file_versions` holds one immutable row per version. `files`
// keeps the per-version columns as a denormalized mirror of the HEAD version
// (kept in lock-step by `append_version` / `restore_version`), so existing
// readers of `files.*` transparently see the latest version. Reads here JOIN
// the head only to surface the head `version` number and `blob_version_id`
// (the storage key, which differs from `current_version_id` for a restored
// head). Storage blobs are keyed by `blob_version_id`; v1's id == file_id so
// pre-versioning blobs resolve unchanged.
//
// Dual-driver (sqlite-store DEC-1/DEC-21): every function exists twice — the
// baseline postgres leg (`#[cfg(not(feature = "sqlite-backend"))]`, untouched
// copy for txresbench) and the sqlite leg (`#[cfg(feature = "sqlite-backend")]`,
// the SQLite dialect per the DEC-8 type map + the DEC-12 port rules). The
// driver is a COMPILE-TIME property: a `sqlite-backend` build compiles ONLY
// the sqlite legs and verifies them against the sqlite build DB; the default
// build compiles ONLY the postgres legs. Never a runtime switch.

use crate::models::{File, FileCreateData, FileVersion, FileVersionCreateData};
use uuid::Uuid;
use txresbench_core::{AppError, DbPool};

#[derive(Clone, Debug)]
pub struct FileRepository {
    pool: DbPool,
}

impl FileRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Create a new file: inserts the parent `files` row, version 1 (id =
    /// file_id, blob_version_id = file_id so the on-disk blob path is keyed by
    /// the file_id for v1), and points the head at it — all in one transaction.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn create(&self, data: FileCreateData) -> Result<File, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;

        // Insert the parent already pointing at its (about-to-exist) v1. The
        // current_version_id FK is DEFERRABLE INITIALLY DEFERRED, so referencing
        // file_versions($1) before that row exists is fine — it's verified at
        // COMMIT. This keeps current_version_id NOT NULL at all times.
        sqlx::query!(
            r#"
            INSERT INTO files (
                id, user_id, filename, file_size, mime_type, checksum,
                has_thumbnail, preview_page_count, text_page_count,
                processing_metadata, created_by, current_version_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1)
            "#,
            data.id,
            data.user_id,
            data.filename,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            data.processing_metadata,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        sqlx::query!(
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $1, 1, true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
            data.id,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            data.processing_metadata,
            data.source_message_id,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        tx.commit().await.map_err(AppError::database_error)?;

        self.get_by_id(data.id)
            .await?
            .ok_or_else(|| AppError::internal_error("file vanished after create"))
    }

    /// Create a new file: inserts the parent `files` row, version 1 (id =
    /// file_id, blob_version_id = file_id so the on-disk blob path is keyed by
    /// the file_id for v1), and points the head at it — all in one transaction.
    ///
    /// SQLite leg: the `current_version_id` self-reference is NOT an FK in the
    /// ported schema (the PG baseline's FK claim is stale on BOTH engines — no
    /// `REFERENCES` clause exists in either migration), so the insert order is
    /// a plain choice rather than a deferred-constraint dance. Both inserts
    /// write then the head mirrors at COMMIT, exactly as above.
    #[cfg(feature = "sqlite-backend")]
    pub async fn create(&self, data: FileCreateData) -> Result<File, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;
        // Bind-note (E0716, ITEM-14 drift 1): every bind is a PLACE expression;
        // the Json wrapper is pre-bound to a local, never constructed in bind
        // position.
        let meta_json = ::sqlx::types::Json(&data.processing_metadata);

        sqlx::query!(
            r#"
            INSERT INTO files (
                id, user_id, filename, file_size, mime_type, checksum,
                has_thumbnail, preview_page_count, text_page_count,
                processing_metadata, created_by, current_version_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1)
            "#,
            data.id,
            data.user_id,
            data.filename,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            meta_json,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        sqlx::query!(
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $1, 1, true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
            data.id,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            meta_json,
            data.source_message_id,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        tx.commit().await.map_err(AppError::database_error)?;

        self.get_by_id(data.id)
            .await?
            .ok_or_else(|| AppError::internal_error("file vanished after create"))
    }

    /// Like `create`, but enforces the per-user storage quota atomically.
    /// A per-user transaction-scoped advisory lock serializes concurrent
    /// uploads so two can't both pass a separate count-then-insert check and
    /// overshoot the quota (closes the TOCTOU in the upload handler). Returns
    /// `STORAGE_QUOTA_EXCEEDED` (the handler's pre-check is the fast path).
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn create_with_quota(
        &self,
        data: FileCreateData,
        quota_bytes: i64,
    ) -> Result<File, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;

        // Serialize per user for the lifetime of the transaction.
        sqlx::query!(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            data.user_id.to_string()
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let used: i64 = sqlx::query_scalar!(
            r#"SELECT COALESCE(SUM(file_size), 0)::BIGINT AS "total"
               FROM files WHERE user_id = $1"#,
            data.user_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .unwrap_or(0);

        if used.saturating_add(data.file_size) > quota_bytes {
            return Err(AppError::bad_request(
                "STORAGE_QUOTA_EXCEEDED",
                format!(
                    "Upload would exceed the per-user storage quota \
                     ({used} bytes already used + {} bytes incoming)",
                    data.file_size
                ),
            ));
        }

        sqlx::query!(
            r#"
            INSERT INTO files (
                id, user_id, filename, file_size, mime_type, checksum,
                has_thumbnail, preview_page_count, text_page_count,
                processing_metadata, created_by, current_version_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1)
            "#,
            data.id,
            data.user_id,
            data.filename,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            data.processing_metadata,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        sqlx::query!(
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $1, 1, true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
            data.id,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            data.processing_metadata,
            data.source_message_id,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        tx.commit().await.map_err(AppError::database_error)?;

        self.get_by_id(data.id)
            .await?
            .ok_or_else(|| AppError::internal_error("file vanished after create"))
    }

    /// Like `create`, but enforces the per-user storage quota atomically.
    ///
    /// SQLite leg: `pg_advisory_xact_lock` has no analogue, so the serialization
    /// moves UP to the transaction itself — `BEGIN IMMEDIATE` takes the database
    /// write lock before the count read, so a concurrent upload's count-then-
    /// insert cannot interleave with this one (a deferred transaction would
    /// snapshot the count before the peer's COMMIT and fail the write with
    /// SQLITE_BUSY_SNAPSHOT instead of serializing — correct (no overshoot) but
    /// an avoidable 500). The lock is per-database rather than per-user: the
    /// finer grain PG's advisory lock gives is not expressible on SQLite, and
    /// the quota check is short + write-rare, so the coarser grain is the right
    /// trade.
    #[cfg(feature = "sqlite-backend")]
    pub async fn create_with_quota(
        &self,
        data: FileCreateData,
        quota_bytes: i64,
    ) -> Result<File, AppError> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let meta_json = ::sqlx::types::Json(&data.processing_metadata);

        // COALESCE(SUM(...)) is inferred NON-null on sqlite (no `::BIGINT`
        // cast — the DEC-8 map says INTEGER); the PG leg's Option+unwrap_or(0)
        // collapses to the plain i64 here.
        let used: i64 = sqlx::query_scalar!(
            r#"SELECT COALESCE(SUM(file_size), 0) as "total"
               FROM files WHERE user_id = $1"#,
            data.user_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        if used.saturating_add(data.file_size) > quota_bytes {
            return Err(AppError::bad_request(
                "STORAGE_QUOTA_EXCEEDED",
                format!(
                    "Upload would exceed the per-user storage quota \
                     ({used} bytes already used + {} bytes incoming)",
                    data.file_size
                ),
            ));
        }

        sqlx::query!(
            r#"
            INSERT INTO files (
                id, user_id, filename, file_size, mime_type, checksum,
                has_thumbnail, preview_page_count, text_page_count,
                processing_metadata, created_by, current_version_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1)
            "#,
            data.id,
            data.user_id,
            data.filename,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            meta_json,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        sqlx::query!(
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $1, 1, true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
            data.id,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            meta_json,
            data.source_message_id,
            data.created_by,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        tx.commit().await.map_err(AppError::database_error)?;

        self.get_by_id(data.id)
            .await?
            .ok_or_else(|| AppError::internal_error("file vanished after create"))
    }

    // NOTE (chunk txresbench-file): the former `set_workflow_run_id` /
    // `list_ids_by_workflow_run` helpers + the `files.workflow_run_id` column
    // are NOT part of this domain-agnostic store. The file↔run association lives
    // app-side in txresbench's `file_workflow_runs` join table (workflow module), so
    // the store stays free of any `workflow_runs` reference.

    /// Get file by ID (internal use). Returns the head view.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_by_id(&self, file_id: Uuid) -> Result<Option<File>, AppError> {
        let file = sqlx::query_as!(
            File,
            r#"
            SELECT f.id, f.user_id, f.filename, f.file_size, f.mime_type, f.checksum,
                   f.has_thumbnail, f.preview_page_count, f.text_page_count,
                   f.processing_metadata as "processing_metadata!: _",
                   f.created_by,
                   f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version, f.current_version_id as "current_version_id!",
                   fv.blob_version_id
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id = $1
            "#,
            file_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(file)
    }

    /// Get file by ID (internal use). Returns the head view.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_by_id(&self, file_id: Uuid) -> Result<Option<File>, AppError> {
        use crate::sqlite_types::JsonValue;

        let file = sqlx::query_as!(
            File,
            r#"
            SELECT f.id as "id: _", f.user_id as "user_id: _", f.filename,
                   f.file_size as "file_size: _", f.mime_type, f.checksum,
                   f.has_thumbnail as "has_thumbnail: _",
                   f.preview_page_count as "preview_page_count: _",
                   f.text_page_count as "text_page_count: _",
                   f.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   f.created_by, f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version as "version: _",
                   f.current_version_id as "current_version_id: _",
                   fv.blob_version_id as "blob_version_id: _"
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id = $1
            "#,
            file_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(file)
    }

    /// Batch variant of [`get_by_id`] — resolve many files in one query (head
    /// views). No ownership filter (callers that need it use
    /// `get_by_ids_and_user`); used where ownership is enforced downstream.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_by_ids(&self, file_ids: &[Uuid]) -> Result<Vec<File>, AppError> {
        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id, f.user_id, f.filename, f.file_size, f.mime_type, f.checksum,
                   f.has_thumbnail, f.preview_page_count, f.text_page_count,
                   f.processing_metadata as "processing_metadata!: _",
                   f.created_by,
                   f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version, f.current_version_id as "current_version_id!",
                   fv.blob_version_id
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id = ANY($1)
            "#,
            file_ids
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(files)
    }

    /// Batch variant of [`get_by_id`] — resolve many files in one query (head
    /// views). No ownership filter (callers that need it use
    /// `get_by_ids_and_user`); used where ownership is enforced downstream.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_by_ids(&self, file_ids: &[Uuid]) -> Result<Vec<File>, AppError> {
        use crate::sqlite_types::JsonValue;

        // `= ANY($1)` (uuid[]) has no SQLite analogue; per DEC-12 the batch
        // rides JSON membership, typed honestly through `unhex()` so the BLOB
        // column compares against 16-byte blobs, not TEXT uuid strings
        // (`json_each` yields TEXT; BLOB = TEXT is never true — the storage
        // classes are ordered, not equal).
        let ids_json = crate::sqlite_types::uuid_list_json(file_ids);

        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id as "id: _", f.user_id as "user_id: _", f.filename,
                   f.file_size as "file_size: _", f.mime_type, f.checksum,
                   f.has_thumbnail as "has_thumbnail: _",
                   f.preview_page_count as "preview_page_count: _",
                   f.text_page_count as "text_page_count: _",
                   f.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   f.created_by, f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version as "version: _",
                   f.current_version_id as "current_version_id: _",
                   fv.blob_version_id as "blob_version_id: _"
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
            "#,
            ids_json
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(files)
    }

    /// Get file by ID and verify user ownership. Returns the head view.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_by_id_and_user(
        &self,
        file_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<File>, AppError> {
        let file = sqlx::query_as!(
            File,
            r#"
            SELECT f.id, f.user_id, f.filename, f.file_size, f.mime_type, f.checksum,
                   f.has_thumbnail, f.preview_page_count, f.text_page_count,
                   f.processing_metadata as "processing_metadata!: _",
                   f.created_by,
                   f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version, f.current_version_id as "current_version_id!",
                   fv.blob_version_id
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id = $1 AND f.user_id = $2
            "#,
            file_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(file)
    }

    /// Get file by ID and verify user ownership. Returns the head view.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_by_id_and_user(
        &self,
        file_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<File>, AppError> {
        use crate::sqlite_types::JsonValue;

        let file = sqlx::query_as!(
            File,
            r#"
            SELECT f.id as "id: _", f.user_id as "user_id: _", f.filename,
                   f.file_size as "file_size: _", f.mime_type, f.checksum,
                   f.has_thumbnail as "has_thumbnail: _",
                   f.preview_page_count as "preview_page_count: _",
                   f.text_page_count as "text_page_count: _",
                   f.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   f.created_by, f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version as "version: _",
                   f.current_version_id as "current_version_id: _",
                   fv.blob_version_id as "blob_version_id: _"
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id = $1 AND f.user_id = $2
            "#,
            file_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(file)
    }

    /// Batch-fetch files by id, scoped to the owning user. Foreign or deleted
    /// ids simply don't appear in the result. Returns head views.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_by_ids_and_user(
        &self,
        file_ids: &[Uuid],
        user_id: Uuid,
    ) -> Result<Vec<File>, AppError> {
        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id, f.user_id, f.filename, f.file_size, f.mime_type, f.checksum,
                   f.has_thumbnail, f.preview_page_count, f.text_page_count,
                   f.processing_metadata as "processing_metadata!: _",
                   f.created_by,
                   f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version, f.current_version_id as "current_version_id!",
                   fv.blob_version_id
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id = ANY($1) AND f.user_id = $2
            "#,
            file_ids,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(files)
    }

    /// Batch-fetch files by id, scoped to the owning user. Foreign or deleted
    /// ids simply don't appear in the result. Returns head views.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_by_ids_and_user(
        &self,
        file_ids: &[Uuid],
        user_id: Uuid,
    ) -> Result<Vec<File>, AppError> {
        use crate::sqlite_types::JsonValue;

        // `= ANY($1)` → JSON membership via `unhex()` (see get_by_ids).
        let ids_json = crate::sqlite_types::uuid_list_json(file_ids);

        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id as "id: _", f.user_id as "user_id: _", f.filename,
                   f.file_size as "file_size: _", f.mime_type, f.checksum,
                   f.has_thumbnail as "has_thumbnail: _",
                   f.preview_page_count as "preview_page_count: _",
                   f.text_page_count as "text_page_count: _",
                   f.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   f.created_by, f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version as "version: _",
                   f.current_version_id as "current_version_id: _",
                   fv.blob_version_id as "blob_version_id: _"
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
              AND f.user_id = $2
            "#,
            ids_json,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(files)
    }

    /// List files for user with pagination (head views). One row per file —
    /// the head join attaches head metadata, so versioned files appear once.
    /// **Unfiltered owner-scoped listing — NOT the route path.**
    ///
    /// `GET /files` goes through [`crate::http::FileContext::authorized_list`],
    /// which filters through the host's [`crate::seams::FileAccessPolicy`] before
    /// paging. This method applies no policy at all, so wiring a route to it
    /// re-opens the enumeration this seam exists to close — the same hazard
    /// [`crate::http::FileContext::authorize`]'s doc records for
    /// [`Self::get_by_id`].
    ///
    /// It is kept for callers that legitimately need the full owner footprint
    /// with no principal to authorize (administrative sweeps, quota/footprint
    /// accounting). If you are serving a request, you want `authorized_list`.
    #[deprecated(
        since = "0.0.0",
        note = "unfiltered: use FileContext::authorized_list for anything serving a request"
    )]
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn list_by_user(
        &self,
        user_id: Uuid,
        page: i32,
        per_page: i32,
    ) -> Result<(Vec<File>, i64), AppError> {
        let page64 = (page as i64).max(1);
        // Clamp per_page to the shared upper bound so `?per_page=100000000`
        // can't force an unbounded LIMIT (memory amplification). Matches the
        // convention in file/handlers/versions.rs + common::PaginationQuery.
        let per_page64 = (per_page as i64).clamp(1, 100i64);
        let offset = (page64 - 1).saturating_mul(per_page64);

        let total: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM files WHERE user_id = $1"#,
            user_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id, f.user_id, f.filename, f.file_size, f.mime_type, f.checksum,
                   f.has_thumbnail, f.preview_page_count, f.text_page_count,
                   f.processing_metadata as "processing_metadata!: _",
                   f.created_by,
                   f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version, f.current_version_id as "current_version_id!",
                   fv.blob_version_id
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.user_id = $1
            ORDER BY f.created_at DESC
            LIMIT $2 OFFSET $3
            "#,
            user_id,
            per_page64,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((files, total))
    }

    /// List files for user with pagination (head views). One row per file —
    /// the head join attaches head metadata, so versioned files appear once.
    /// **Unfiltered owner-scoped listing — NOT the route path.**
    ///
    /// `GET /files` goes through [`crate::http::FileContext::authorized_list`],
    /// which filters through the host's [`crate::seams::FileAccessPolicy`] before
    /// paging. This method applies no policy at all, so wiring a route to it
    /// re-opens the enumeration this seam exists to close — the same hazard
    /// [`crate::http::FileContext::authorize`]'s doc records for
    /// [`Self::get_by_id`].
    ///
    /// It is kept for callers that legitimately need the full owner footprint
    /// with no principal to authorize (administrative sweeps, quota/footprint
    /// accounting). If you are serving a request, you want `authorized_list`.
    #[deprecated(
        since = "0.0.0",
        note = "unfiltered: use FileContext::authorized_list for anything serving a request"
    )]
    #[cfg(feature = "sqlite-backend")]
    pub async fn list_by_user(
        &self,
        user_id: Uuid,
        page: i32,
        per_page: i32,
    ) -> Result<(Vec<File>, i64), AppError> {
        use crate::sqlite_types::JsonValue;

        let page64 = (page as i64).max(1);
        // Clamp per_page to the shared upper bound so `?per_page=100000000`
        // can't force an unbounded LIMIT (memory amplification). Matches the
        // convention in file/handlers/versions.rs + common::PaginationQuery.
        let per_page64 = (per_page as i64).clamp(1, 100i64);
        let offset = (page64 - 1).saturating_mul(per_page64);

        // `created_at DESC` orders the RFC3339-UTC TEXT (DEC-8): lexicographic
        // == chronological.
        let total: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM files WHERE user_id = $1"#,
            user_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id as "id: _", f.user_id as "user_id: _", f.filename,
                   f.file_size as "file_size: _", f.mime_type, f.checksum,
                   f.has_thumbnail as "has_thumbnail: _",
                   f.preview_page_count as "preview_page_count: _",
                   f.text_page_count as "text_page_count: _",
                   f.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   f.created_by, f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version as "version: _",
                   f.current_version_id as "current_version_id: _",
                   fv.blob_version_id as "blob_version_id: _"
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.user_id = $1
            ORDER BY f.created_at DESC
            LIMIT $2 OFFSET $3
            "#,
            user_id,
            per_page64,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((files, total))
    }

    /// Every file id owned by `user_id`, newest first — the candidate set an
    /// authorization policy filters before the list is paged.
    ///
    /// Ids only: this runs on every list request, so it stays a narrow index-ish
    /// scan rather than materializing rows that will mostly be paged away.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn list_ids_by_user(&self, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT id as "id!" FROM files WHERE user_id = $1 ORDER BY created_at DESC"#,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Every file id owned by `user_id`, newest first — the candidate set an
    /// authorization policy filters before the list is paged.
    ///
    /// Ids only: this runs on every list request, so it stays a narrow index-ish
    /// scan rather than materializing rows that will mostly be paged away.
    #[cfg(feature = "sqlite-backend")]
    pub async fn list_ids_by_user(&self, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        // The exact-type override is required: `query_scalar!` infers a BLOB
        // column as `Vec<u8>` (the local annotation does not drive it), and the
        // stored `files.id` is a 16-byte BLOB per DEC-8.
        sqlx::query_scalar!(
            r#"SELECT id as "id: Uuid" FROM files WHERE user_id = $1 ORDER BY created_at DESC"#,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// [`Self::list_by_user`] restricted to an explicit id allow-list.
    ///
    /// Both the page AND the `total` are computed over the restricted set, so a
    /// filtered listing cannot report a count that includes what it withheld.
    /// Passing an empty allow-list yields an empty page and a `total` of 0 — a
    /// principal with no readable files is indistinguishable from one with no
    /// files.
    ///
    /// `user_id` is retained as a conjunct alongside the allow-list: the ids come
    /// from a host policy, and the store does not take a caller-supplied id set
    /// as permission to leave its own owner scope.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn list_by_user_filtered(
        &self,
        user_id: Uuid,
        allowed: &[Uuid],
        page: i32,
        per_page: i32,
    ) -> Result<(Vec<File>, i64), AppError> {
        let page64 = (page as i64).max(1);
        // Same clamp as `list_by_user` — `?per_page=100000000` must not force an
        // unbounded LIMIT.
        let per_page64 = (per_page as i64).clamp(1, 100i64);
        let offset = (page64 - 1).saturating_mul(per_page64);

        let total: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM files
               WHERE user_id = $1 AND id = ANY($2)"#,
            user_id,
            allowed
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id, f.user_id, f.filename, f.file_size, f.mime_type, f.checksum,
                   f.has_thumbnail, f.preview_page_count, f.text_page_count,
                   f.processing_metadata as "processing_metadata!: _",
                   f.created_by,
                   f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version, f.current_version_id as "current_version_id!",
                   fv.blob_version_id
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.user_id = $1 AND f.id = ANY($2)
            ORDER BY f.created_at DESC
            LIMIT $3 OFFSET $4
            "#,
            user_id,
            allowed,
            per_page64,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((files, total))
    }

    /// [`Self::list_by_user`] restricted to an explicit id allow-list.
    ///
    /// Both the page AND the `total` are computed over the restricted set, so a
    /// filtered listing cannot report a count that includes what it withheld.
    /// Passing an empty allow-list yields an empty page and a `total` of 0 — a
    /// principal with no readable files is indistinguishable from one with no
    /// files.
    ///
    /// `user_id` is retained as a conjunct alongside the allow-list: the ids come
    /// from a host policy, and the store does not take a caller-supplied id set
    /// as permission to leave its own owner scope.
    #[cfg(feature = "sqlite-backend")]
    pub async fn list_by_user_filtered(
        &self,
        user_id: Uuid,
        allowed: &[Uuid],
        page: i32,
        per_page: i32,
    ) -> Result<(Vec<File>, i64), AppError> {
        use crate::sqlite_types::JsonValue;

        let page64 = (page as i64).max(1);
        // Same clamp as `list_by_user` — `?per_page=100000000` must not force an
        // unbounded LIMIT.
        let per_page64 = (per_page as i64).clamp(1, 100i64);
        let offset = (page64 - 1).saturating_mul(per_page64);

        // `= ANY($2)` → JSON membership via `unhex()` (see get_by_ids).
        let ids_json = crate::sqlite_types::uuid_list_json(allowed);

        let total: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM files
               WHERE user_id = $1 AND id IN (SELECT unhex(j.value) FROM json_each($2) AS j)"#,
            user_id,
            ids_json
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let files = sqlx::query_as!(
            File,
            r#"
            SELECT f.id as "id: _", f.user_id as "user_id: _", f.filename,
                   f.file_size as "file_size: _", f.mime_type, f.checksum,
                   f.has_thumbnail as "has_thumbnail: _",
                   f.preview_page_count as "preview_page_count: _",
                   f.text_page_count as "text_page_count: _",
                   f.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   f.created_by, f.created_at as "created_at: _",
                   f.updated_at as "updated_at: _",
                   fv.version as "version: _",
                   f.current_version_id as "current_version_id: _",
                   fv.blob_version_id as "blob_version_id: _"
            FROM files f
            JOIN file_versions fv ON fv.id = f.current_version_id
            WHERE f.user_id = $1
              AND f.id IN (SELECT unhex(j.value) FROM json_each($2) AS j)
            ORDER BY f.created_at DESC
            LIMIT $3 OFFSET $4
            "#,
            user_id,
            ids_json,
            per_page64,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((files, total))
    }

    /// Sum the user's current uploaded file bytes (= head sizes, since
    /// `files.file_size` mirrors the head). Drives the per-user storage quota.
    /// Quota counts the current footprint (head once), not the sum of all
    /// versions.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn count_user_bytes(&self, user_id: Uuid) -> Result<i64, AppError> {
        let total: Option<i64> = sqlx::query_scalar!(
            r#"SELECT COALESCE(SUM(file_size), 0)::BIGINT AS "total"
               FROM files
               WHERE user_id = $1"#,
            user_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(total.unwrap_or(0))
    }

    /// Sum the user's current uploaded file bytes (= head sizes, since
    /// `files.file_size` mirrors the head). Drives the per-user storage quota.
    /// Quota counts the current footprint (head once), not the sum of all
    /// versions.
    #[cfg(feature = "sqlite-backend")]
    pub async fn count_user_bytes(&self, user_id: Uuid) -> Result<i64, AppError> {
        let total: i64 = sqlx::query_scalar!(
            r#"SELECT COALESCE(SUM(file_size), 0) as "total"
               FROM files
               WHERE user_id = $1"#,
            user_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(total)
    }

    /// Delete a file and all its versions. Returns the DISTINCT
    /// `blob_version_id`s that were referenced so the caller can purge the
    /// on-disk blobs (restored versions share a blob → dedupe avoids a
    /// double-delete / missing-blob). The DB rows cascade via the FK.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn delete(&self, file_id: Uuid, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let blob_ids: Vec<Uuid> = sqlx::query_scalar!(
            r#"SELECT DISTINCT fv.blob_version_id
               FROM file_versions fv
               JOIN files f ON f.id = fv.file_id
               WHERE fv.file_id = $1 AND f.user_id = $2"#,
            file_id,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let result = sqlx::query!(
            "DELETE FROM files WHERE id = $1 AND user_id = $2",
            file_id,
            user_id
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        if result.rows_affected() == 0 {
            return Err(AppError::not_found("File"));
        }

        Ok(blob_ids)
    }

    /// Delete a file and all its versions. Returns the DISTINCT
    /// `blob_version_id`s that were referenced so the caller can purge the
    /// on-disk blobs (restored versions share a blob → dedupe avoids a
    /// double-delete / missing-blob).
    ///
    /// SQLite leg: no FK cascade exists in the ported schema (and none in the
    /// PG baseline either — the "cascade via the FK" note above is stale on
    /// both engines); the caller purges the returned blobs, which is the same
    /// contract. `rows_affected()` works identically.
    #[cfg(feature = "sqlite-backend")]
    pub async fn delete(&self, file_id: Uuid, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        // Exact-type overrides: `query_scalar!` infers BLOB columns as
        // `Vec<u8>` (see list_ids_by_user).
        let blob_ids: Vec<Uuid> = sqlx::query_scalar!(
            r#"SELECT DISTINCT fv.blob_version_id as "blob_version_id: Uuid"
               FROM file_versions fv
               JOIN files f ON f.id = fv.file_id
               WHERE fv.file_id = $1 AND f.user_id = $2"#,
            file_id,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let result = sqlx::query!(
            "DELETE FROM files WHERE id = $1 AND user_id = $2",
            file_id,
            user_id
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        if result.rows_affected() == 0 {
            return Err(AppError::not_found("File"));
        }

        Ok(blob_ids)
    }

    /// All distinct blob version ids owned by a user (across every file +
    /// version). Used by the user-delete path to clean up on-disk blobs that
    /// the `files` `ON DELETE CASCADE` would otherwise orphan.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn list_all_blob_ids_for_user(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT DISTINCT fv.blob_version_id
               FROM file_versions fv
               JOIN files f ON f.id = fv.file_id
               WHERE f.user_id = $1"#,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// All distinct blob version ids owned by a user (across every file +
    /// version). Used by the user-delete path to clean up on-disk blobs that
    /// the `files` delete would otherwise orphan (the stored rows are NOT
    /// cascaded on either engine — see `delete`).
    #[cfg(feature = "sqlite-backend")]
    pub async fn list_all_blob_ids_for_user(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT DISTINCT fv.blob_version_id as "blob_version_id: Uuid"
               FROM file_versions fv
               JOIN files f ON f.id = fv.file_id
               WHERE f.user_id = $1"#,
            user_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Append a new immutable version and advance the head. The caller MUST
    /// have already saved the new blob keyed by `new_version_id` (the new
    /// version's `blob_version_id` == its own id). Flips the prior head via the
    /// partial-unique `is_head` index and re-syncs the `files` head mirror.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn append_version(
        &self,
        file_id: Uuid,
        new_version_id: Uuid,
        data: FileVersionCreateData,
    ) -> Result<FileVersion, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;

        // Serialize concurrent appends to this file. Without the lock, two
        // parallel edits (or an MCP edit racing a sandbox version-back) both read
        // the same MAX(version) and collide on UNIQUE(file_id, version), surfacing
        // as a 500. Locking the parent row makes per-file appends sequential.
        sqlx::query_scalar!("SELECT id FROM files WHERE id = $1 FOR UPDATE", file_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(AppError::database_error)?;

        let next: i32 = sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(version), 0) + 1 AS "v!" FROM file_versions WHERE file_id = $1"#,
            file_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        sqlx::query!(
            "UPDATE file_versions SET is_head = false WHERE file_id = $1 AND is_head",
            file_id
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let version = sqlx::query_as!(
            FileVersion,
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $2, $3, true, $1, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id, file_id, version, is_head, blob_version_id,
                      file_size, mime_type, checksum, has_thumbnail,
                      preview_page_count, text_page_count,
                      processing_metadata as "processing_metadata!: _",
                      source_message_id,
                      created_by,
                      created_at as "created_at: _"
            "#,
            new_version_id,
            file_id,
            next,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            data.processing_metadata,
            data.source_message_id,
            data.created_by,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        self.sync_head_mirror(&mut tx, file_id, new_version_id, &version)
            .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(version)
    }

    /// Append a new immutable version and advance the head. The caller MUST
    /// have already saved the new blob keyed by `new_version_id` (the new
    /// version's `blob_version_id` == its own id). Flips the prior head via the
    /// partial-unique `is_head` index and re-syncs the `files` head mirror.
    ///
    /// SQLite leg: `FOR UPDATE` has no analogue; the serialization moves to
    /// `BEGIN IMMEDIATE` (the write lock is taken before the MAX(version) read,
    /// so two concurrent appends queue at the lock instead of both reading the
    /// same next version and colliding on UNIQUE(file_id, version)). The
    /// existence SELECT is retained with the same discarded-result semantics as
    /// the postgres leg (which likewise ignores its row — the row lock was the
    /// point there, and the lock is the transaction here). SQLite's single-
    /// writer lock is the coarse-grained version of the per-row lock: the
    /// granularity is the database, and the invariant (per-file appends are
    /// sequential) holds.
    #[cfg(feature = "sqlite-backend")]
    pub async fn append_version(
        &self,
        file_id: Uuid,
        new_version_id: Uuid,
        data: FileVersionCreateData,
    ) -> Result<FileVersion, AppError> {
        use crate::sqlite_types::JsonValue;

        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;

        sqlx::query_scalar!("SELECT id FROM files WHERE id = $1", file_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(AppError::database_error)?;

        // Sqlite's `MAX(version) + 1` is INTEGER → i64 (the DEC-8 map has no
        // i32/int4 distinction); the version column accepts the cast value.
        let next: i64 = sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(version), 0) + 1 AS "v!" FROM file_versions WHERE file_id = $1"#,
            file_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let next = next as i32;

        sqlx::query!(
            "UPDATE file_versions SET is_head = false WHERE file_id = $1 AND is_head",
            file_id
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let meta_json = ::sqlx::types::Json(&data.processing_metadata);
        let version = sqlx::query_as!(
            FileVersion,
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $2, $3, true, $1, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id as "id: _", file_id as "file_id: _",
                      version as "version: _", is_head as "is_head: _",
                      blob_version_id as "blob_version_id: _",
                      file_size as "file_size: _", mime_type, checksum,
                      has_thumbnail as "has_thumbnail: _",
                      preview_page_count as "preview_page_count: _",
                      text_page_count as "text_page_count: _",
                      processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                      source_message_id as "source_message_id: _", created_by,
                      created_at as "created_at: _"
            "#,
            new_version_id,
            file_id,
            next,
            data.file_size,
            data.mime_type,
            data.checksum,
            data.has_thumbnail,
            data.preview_page_count,
            data.text_page_count,
            meta_json,
            data.source_message_id,
            data.created_by,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        self.sync_head_mirror(&mut tx, file_id, new_version_id, &version)
            .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(version)
    }

    /// Restore a prior version: append a NEW head whose bytes are the target
    /// version's (no blob is copied — `blob_version_id` points at the target's
    /// blob). Append-only: the intervening versions are untouched.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn restore_version(
        &self,
        file_id: Uuid,
        target_version: i32,
        created_by: String,
        source_message_id: Option<Uuid>,
    ) -> Result<FileVersion, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;

        // Serialize against concurrent appends/restores on this file (see
        // append_version) so the new version number can't collide.
        sqlx::query_scalar!("SELECT id FROM files WHERE id = $1 FOR UPDATE", file_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(AppError::database_error)?;

        let target = sqlx::query!(
            r#"SELECT blob_version_id, file_size, mime_type, checksum, has_thumbnail,
                      preview_page_count, text_page_count,
                      processing_metadata as "processing_metadata!: serde_json::Value"
               FROM file_versions WHERE file_id = $1 AND version = $2"#,
            file_id,
            target_version
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| AppError::not_found("File version"))?;

        let next: i32 = sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(version), 0) + 1 AS "v!" FROM file_versions WHERE file_id = $1"#,
            file_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        sqlx::query!(
            "UPDATE file_versions SET is_head = false WHERE file_id = $1 AND is_head",
            file_id
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let new_id = Uuid::new_v4();
        let version = sqlx::query_as!(
            FileVersion,
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id, file_id, version, is_head, blob_version_id,
                      file_size, mime_type, checksum, has_thumbnail,
                      preview_page_count, text_page_count,
                      processing_metadata as "processing_metadata!: _",
                      source_message_id,
                      created_by,
                      created_at as "created_at: _"
            "#,
            new_id,
            file_id,
            next,
            target.blob_version_id,
            target.file_size,
            target.mime_type,
            target.checksum,
            target.has_thumbnail,
            target.preview_page_count,
            target.text_page_count,
            target.processing_metadata,
            source_message_id,
            created_by,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        self.sync_head_mirror(&mut tx, file_id, new_id, &version)
            .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(version)
    }

    /// Restore a prior version: append a NEW head whose bytes are the target
    /// version's (no blob is copied — `blob_version_id` points at the target's
    /// blob). Append-only: the intervening versions are untouched.
    ///
    /// SQLite leg: `FOR UPDATE` → `BEGIN IMMEDIATE` (see `append_version`).
    /// The target read is the anonymous `query!`; anonymous queries accept
    /// only EXACT-type overrides (no `_` wildcards), so the columns carry
    /// their DEC-8 Rust types explicitly (in particular `processing_metadata`
    /// decodes through the TEXT transport).
    #[cfg(feature = "sqlite-backend")]
    pub async fn restore_version(
        &self,
        file_id: Uuid,
        target_version: i32,
        created_by: String,
        source_message_id: Option<Uuid>,
    ) -> Result<FileVersion, AppError> {
        use crate::sqlite_types::JsonValue;

        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;

        // Serialized by the IMMEDIATE transaction (see append_version).
        sqlx::query_scalar!("SELECT id FROM files WHERE id = $1", file_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(AppError::database_error)?;

        let target = sqlx::query!(
            r#"SELECT blob_version_id as "blob_version_id: Uuid",
                      file_size as "file_size: i64", mime_type, checksum,
                      has_thumbnail as "has_thumbnail: bool",
                      preview_page_count as "preview_page_count: i32",
                      text_page_count as "text_page_count: i32",
                      processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>"
               FROM file_versions WHERE file_id = $1 AND version = $2"#,
            file_id,
            target_version
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| AppError::not_found("File version"))?;

        let next: i64 = sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(version), 0) + 1 AS "v!" FROM file_versions WHERE file_id = $1"#,
            file_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let next = next as i32;

        sqlx::query!(
            "UPDATE file_versions SET is_head = false WHERE file_id = $1 AND is_head",
            file_id
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let new_id = Uuid::new_v4();
        let version = sqlx::query_as!(
            FileVersion,
            r#"
            INSERT INTO file_versions (
                id, file_id, version, is_head, blob_version_id,
                file_size, mime_type, checksum, has_thumbnail,
                preview_page_count, text_page_count, processing_metadata,
                source_message_id, created_by
            )
            VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id as "id: _", file_id as "file_id: _",
                      version as "version: _", is_head as "is_head: _",
                      blob_version_id as "blob_version_id: _",
                      file_size as "file_size: _", mime_type, checksum,
                      has_thumbnail as "has_thumbnail: _",
                      preview_page_count as "preview_page_count: _",
                      text_page_count as "text_page_count: _",
                      processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                      source_message_id as "source_message_id: _", created_by,
                      created_at as "created_at: _"
            "#,
            new_id,
            file_id,
            next,
            target.blob_version_id,
            target.file_size,
            target.mime_type,
            target.checksum,
            target.has_thumbnail,
            target.preview_page_count,
            target.text_page_count,
            target.processing_metadata,
            source_message_id,
            created_by,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        self.sync_head_mirror(&mut tx, file_id, new_id, &version)
            .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(version)
    }

    /// Re-point `files.current_version_id` and refresh the denormalized
    /// per-version mirror columns to the new head, inside an open transaction.
    #[cfg(not(feature = "sqlite-backend"))]
    async fn sync_head_mirror(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        file_id: Uuid,
        new_version_id: Uuid,
        v: &FileVersion,
    ) -> Result<(), AppError> {
        sqlx::query!(
            r#"UPDATE files SET current_version_id = $1, file_size = $2, mime_type = $3,
                   checksum = $4, has_thumbnail = $5, preview_page_count = $6,
                   text_page_count = $7, processing_metadata = $8, updated_at = NOW()
               WHERE id = $9"#,
            new_version_id,
            v.file_size,
            v.mime_type,
            v.checksum,
            v.has_thumbnail,
            v.preview_page_count,
            v.text_page_count,
            v.processing_metadata,
            file_id,
        )
        .execute(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Re-point `files.current_version_id` and refresh the denormalized
    /// per-version mirror columns to the new head, inside an open transaction.
    ///
    /// SQLite leg: `NOW()` → the DEC-8 RFC3339-ms `strftime` form (byte-format
    /// compatible with the columns' DEFAULTs and the lexicographic ordering);
    /// the jsonb bind rides `sqlx::types::Json` (pre-bound — E0716).
    #[cfg(feature = "sqlite-backend")]
    async fn sync_head_mirror(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        file_id: Uuid,
        new_version_id: Uuid,
        v: &FileVersion,
    ) -> Result<(), AppError> {
        let meta_json = ::sqlx::types::Json(&v.processing_metadata);
        sqlx::query!(
            r#"UPDATE files SET current_version_id = $1, file_size = $2, mime_type = $3,
                   checksum = $4, has_thumbnail = $5, preview_page_count = $6,
                   text_page_count = $7, processing_metadata = $8,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $9"#,
            new_version_id,
            v.file_size,
            v.mime_type,
            v.checksum,
            v.has_thumbnail,
            v.preview_page_count,
            v.text_page_count,
            meta_json,
            file_id,
        )
        .execute(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// List all versions of a file (newest first), ownership-gated.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn list_versions(
        &self,
        file_id: Uuid,
        user_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<FileVersion>, AppError> {
        let versions = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id, fv.file_id, fv.version, fv.is_head, fv.blob_version_id,
                   fv.file_size, fv.mime_type, fv.checksum, fv.has_thumbnail,
                   fv.preview_page_count, fv.text_page_count,
                   fv.processing_metadata as "processing_metadata!: _",
                   fv.source_message_id, fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.file_id = $1 AND f.user_id = $2
            ORDER BY fv.version DESC
            LIMIT $3 OFFSET $4
            "#,
            file_id,
            user_id,
            limit,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(versions)
    }

    /// List all versions of a file (newest first), ownership-gated.
    #[cfg(feature = "sqlite-backend")]
    pub async fn list_versions(
        &self,
        file_id: Uuid,
        user_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<FileVersion>, AppError> {
        use crate::sqlite_types::JsonValue;

        let versions = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id as "id: _", fv.file_id as "file_id: _",
                   fv.version as "version: _", fv.is_head as "is_head: _",
                   fv.blob_version_id as "blob_version_id: _",
                   fv.file_size as "file_size: _", fv.mime_type, fv.checksum,
                   fv.has_thumbnail as "has_thumbnail: _",
                   fv.preview_page_count as "preview_page_count: _",
                   fv.text_page_count as "text_page_count: _",
                   fv.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   fv.source_message_id as "source_message_id: _", fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.file_id = $1 AND f.user_id = $2
            ORDER BY fv.version DESC
            LIMIT $3 OFFSET $4
            "#,
            file_id,
            user_id,
            limit,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(versions)
    }

    /// Get a specific version by (file_id, version number), ownership-gated.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_version(
        &self,
        file_id: Uuid,
        version: i32,
        user_id: Uuid,
    ) -> Result<Option<FileVersion>, AppError> {
        let v = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id, fv.file_id, fv.version, fv.is_head, fv.blob_version_id,
                   fv.file_size, fv.mime_type, fv.checksum, fv.has_thumbnail,
                   fv.preview_page_count, fv.text_page_count,
                   fv.processing_metadata as "processing_metadata!: _",
                   fv.source_message_id, fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.file_id = $1 AND fv.version = $2 AND f.user_id = $3
            "#,
            file_id,
            version,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(v)
    }

    /// Get a specific version by (file_id, version number), ownership-gated.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_version(
        &self,
        file_id: Uuid,
        version: i32,
        user_id: Uuid,
    ) -> Result<Option<FileVersion>, AppError> {
        use crate::sqlite_types::JsonValue;

        let v = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id as "id: _", fv.file_id as "file_id: _",
                   fv.version as "version: _", fv.is_head as "is_head: _",
                   fv.blob_version_id as "blob_version_id: _",
                   fv.file_size as "file_size: _", fv.mime_type, fv.checksum,
                   fv.has_thumbnail as "has_thumbnail: _",
                   fv.preview_page_count as "preview_page_count: _",
                   fv.text_page_count as "text_page_count: _",
                   fv.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   fv.source_message_id as "source_message_id: _", fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.file_id = $1 AND fv.version = $2 AND f.user_id = $3
            "#,
            file_id,
            version,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(v)
    }

    /// Get the head version of a file, ownership-gated.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_head(
        &self,
        file_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<FileVersion>, AppError> {
        let v = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id, fv.file_id, fv.version, fv.is_head, fv.blob_version_id,
                   fv.file_size, fv.mime_type, fv.checksum, fv.has_thumbnail,
                   fv.preview_page_count, fv.text_page_count,
                   fv.processing_metadata as "processing_metadata!: _",
                   fv.source_message_id, fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.file_id = $1 AND fv.is_head AND f.user_id = $2
            "#,
            file_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(v)
    }

    /// Get the head version of a file, ownership-gated.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_head(
        &self,
        file_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<FileVersion>, AppError> {
        use crate::sqlite_types::JsonValue;

        let v = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id as "id: _", fv.file_id as "file_id: _",
                   fv.version as "version: _", fv.is_head as "is_head: _",
                   fv.blob_version_id as "blob_version_id: _",
                   fv.file_size as "file_size: _", fv.mime_type, fv.checksum,
                   fv.has_thumbnail as "has_thumbnail: _",
                   fv.preview_page_count as "preview_page_count: _",
                   fv.text_page_count as "text_page_count: _",
                   fv.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   fv.source_message_id as "source_message_id: _", fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.file_id = $1 AND fv.is_head AND f.user_id = $2
            "#,
            file_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(v)
    }

    /// Get a version by its own `file_versions.id` (pins exact bytes regardless
    /// of head), ownership-gated. Used to resolve `version_id`-pinned reads.
    #[cfg(not(feature = "sqlite-backend"))]
    pub async fn get_version_by_id(
        &self,
        version_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<FileVersion>, AppError> {
        let v = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id, fv.file_id, fv.version, fv.is_head, fv.blob_version_id,
                   fv.file_size, fv.mime_type, fv.checksum, fv.has_thumbnail,
                   fv.preview_page_count, fv.text_page_count,
                   fv.processing_metadata as "processing_metadata!: _",
                   fv.source_message_id, fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.id = $1 AND f.user_id = $2
            "#,
            version_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(v)
    }

    /// Get a version by its own `file_versions.id` (pins exact bytes regardless
    /// of head), ownership-gated. Used to resolve `version_id`-pinned reads.
    #[cfg(feature = "sqlite-backend")]
    pub async fn get_version_by_id(
        &self,
        version_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<FileVersion>, AppError> {
        use crate::sqlite_types::JsonValue;

        let v = sqlx::query_as!(
            FileVersion,
            r#"
            SELECT fv.id as "id: _", fv.file_id as "file_id: _",
                   fv.version as "version: _", fv.is_head as "is_head: _",
                   fv.blob_version_id as "blob_version_id: _",
                   fv.file_size as "file_size: _", fv.mime_type, fv.checksum,
                   fv.has_thumbnail as "has_thumbnail: _",
                   fv.preview_page_count as "preview_page_count: _",
                   fv.text_page_count as "text_page_count: _",
                   fv.processing_metadata as "processing_metadata!: JsonValue<serde_json::Value>",
                   fv.source_message_id as "source_message_id: _", fv.created_by,
                   fv.created_at as "created_at: _"
            FROM file_versions fv
            JOIN files f ON f.id = fv.file_id
            WHERE fv.id = $1 AND f.user_id = $2
            "#,
            version_id,
            user_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(v)
    }
}
