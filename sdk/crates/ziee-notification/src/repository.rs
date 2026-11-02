//! DB access for `notifications`. Uses sqlx COMPILE-TIME `query!`/`query_as!`
//! macros (verified against this crate's own build DB — see `build.rs`, gated on
//! the `routes` feature). `timestamptz` columns need the `col as "col:
//! DateTime<Utc>"` override (sqlx's `time` feature is unified in across the
//! workspace). Every query is owner-scoped (`WHERE user_id = $1`).
//!
//! Dual-driver (sqlite-store DEC-1): each function has a cfg twin — the PG leg
//! is byte-identical to the baseline; the `sqlite-backend` leg ports the SQL
//! per the DEC-8 type map + DEC-12 rewrite rules (RFC3339-UTC TEXT timestamps
//! via `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, `payload` TEXT JSON via the
//! [`crate::sqlite_types::JsonValue`] transport, no `::` casts — typed binds
//! instead). The pool retypes to [`ziee_core::DbPool`] on BOTH legs.

use chrono::{DateTime, Utc};
use uuid::Uuid;
use ziee_core::{AppError, DbPool};

use crate::models::{NewNotification, Notification};

/// Insert one notification, returning the full row.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn insert(pool: &DbPool, n: NewNotification) -> Result<Notification, AppError> {
    let id = Uuid::new_v4();
    sqlx::query_as!(
        Notification,
        r#"INSERT INTO notifications (id, user_id, kind, title, body, interrupt, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, user_id, kind, title, body, interrupt,
                     payload as "payload: serde_json::Value",
                     read_at as "read_at: DateTime<Utc>",
                     created_at as "created_at: DateTime<Utc>""#,
        id,
        n.user_id,
        n.kind,
        n.title,
        n.body,
        n.interrupt,
        n.payload,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)
}

/// Insert one notification, returning the full row (sqlite leg). `payload`
/// binds through `sqlx::types::Json` — the driver's own TEXT-JSON wrapper,
/// which stores the same JSON text the column's `'{}'` default uses.
#[cfg(feature = "sqlite-backend")]
pub async fn insert(pool: &DbPool, n: NewNotification) -> Result<Notification, AppError> {
    use crate::sqlite_types::JsonValue;

    let id = Uuid::new_v4();
    let payload_json = ::sqlx::types::Json(&n.payload);
    sqlx::query_as!(
        Notification,
        r#"INSERT INTO notifications (id, user_id, kind, title, body, interrupt, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id as "id: _", user_id as "user_id: _",
                     kind, title, body, interrupt as "interrupt: _",
                     payload as "payload!: JsonValue<serde_json::Value>",
                     read_at as "read_at: DateTime<Utc>",
                     created_at as "created_at: DateTime<Utc>""#,
        id,
        n.user_id,
        n.kind,
        n.title,
        n.body,
        n.interrupt,
        payload_json,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)
}

/// A single notification, owner-scoped (None if not found / not owned).
#[cfg(not(feature = "sqlite-backend"))]
pub async fn get_for_user(
    pool: &DbPool,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<Notification>, AppError> {
    sqlx::query_as!(
        Notification,
        r#"SELECT id, user_id, kind, title, body, interrupt,
                  payload as "payload: serde_json::Value",
                  read_at as "read_at: DateTime<Utc>",
                  created_at as "created_at: DateTime<Utc>"
           FROM notifications WHERE id = $1 AND user_id = $2"#,
        id,
        user_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)
}

/// A single notification, owner-scoped (sqlite leg).
#[cfg(feature = "sqlite-backend")]
pub async fn get_for_user(
    pool: &DbPool,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<Notification>, AppError> {
    use crate::sqlite_types::JsonValue;

    sqlx::query_as!(
        Notification,
        r#"SELECT id as "id: _", user_id as "user_id: _",
                  kind, title, body, interrupt as "interrupt: _",
                  payload as "payload!: JsonValue<serde_json::Value>",
                  read_at as "read_at: DateTime<Utc>",
                  created_at as "created_at: DateTime<Utc>"
           FROM notifications WHERE id = $1 AND user_id = $2"#,
        id,
        user_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)
}

/// List a user's inbox, newest-first. Returns `(rows, total, unread)`.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn list_for_user(
    pool: &DbPool,
    user_id: Uuid,
    unread_only: bool,
    page: i64,
    per_page: i64,
) -> Result<(Vec<Notification>, i64, i64), AppError> {
    let per_page = per_page.clamp(1, 200);
    let offset = (page - 1).max(0) * per_page;

    let rows = sqlx::query_as!(
        Notification,
        r#"SELECT id, user_id, kind, title, body, interrupt,
                  payload as "payload: serde_json::Value",
                  read_at as "read_at: DateTime<Utc>",
                  created_at as "created_at: DateTime<Utc>"
           FROM notifications
           WHERE user_id = $1 AND ($2::bool = FALSE OR read_at IS NULL)
           ORDER BY created_at DESC LIMIT $3 OFFSET $4"#,
        user_id,
        unread_only,
        per_page,
        offset,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let counts = sqlx::query!(
        r#"SELECT count(*) as "total!",
                  count(*) FILTER (WHERE read_at IS NULL) as "unread!"
           FROM notifications WHERE user_id = $1"#,
        user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;

    Ok((rows, counts.total, counts.unread))
}

/// List a user's inbox, newest-first (sqlite leg). The `$2::bool` cast is
/// replaced by a plain typed bind (`FALSE` is a native SQLite 3.46 literal);
/// the `count(*) FILTER (WHERE …)` pivot follows the DEC-12
/// `SUM(CASE WHEN … THEN 1 ELSE 0 END)` rule, with `COALESCE(…, 0)` so an
/// empty inbox still yields `unread = 0` (a bare `SUM` over no rows is NULL —
/// the PG `count(*)` never is).
#[cfg(feature = "sqlite-backend")]
pub async fn list_for_user(
    pool: &DbPool,
    user_id: Uuid,
    unread_only: bool,
    page: i64,
    per_page: i64,
) -> Result<(Vec<Notification>, i64, i64), AppError> {
    use crate::sqlite_types::JsonValue;

    let per_page = per_page.clamp(1, 200);
    let offset = (page - 1).max(0) * per_page;

    let rows = sqlx::query_as!(
        Notification,
        r#"SELECT id as "id: _", user_id as "user_id: _",
                  kind, title, body, interrupt as "interrupt: _",
                  payload as "payload!: JsonValue<serde_json::Value>",
                  read_at as "read_at: DateTime<Utc>",
                  created_at as "created_at: DateTime<Utc>"
           FROM notifications
           WHERE user_id = $1 AND ($2 = FALSE OR read_at IS NULL)
           ORDER BY created_at DESC LIMIT $3 OFFSET $4"#,
        user_id,
        unread_only,
        per_page,
        offset,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let counts = sqlx::query!(
        r#"SELECT count(*) as "total!",
                  COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) as "unread"
           FROM notifications WHERE user_id = $1"#,
        user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;

    Ok((rows, counts.total, counts.unread))
}

/// The user's unread count.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn unread_count(pool: &DbPool, user_id: Uuid) -> Result<i64, AppError> {
    sqlx::query_scalar!(
        r#"SELECT count(*) as "count!" FROM notifications
           WHERE user_id = $1 AND read_at IS NULL"#,
        user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)
}

/// The user's unread count (sqlite leg).
#[cfg(feature = "sqlite-backend")]
pub async fn unread_count(pool: &DbPool, user_id: Uuid) -> Result<i64, AppError> {
    sqlx::query_scalar!(
        r#"SELECT count(*) as "count!" FROM notifications
           WHERE user_id = $1 AND read_at IS NULL"#,
        user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)
}

/// Mark one notification read (idempotent, owner-scoped). Returns rows-affected>0.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn mark_read(pool: &DbPool, user_id: Uuid, id: Uuid) -> Result<bool, AppError> {
    let res = sqlx::query!(
        "UPDATE notifications SET read_at = now() \
         WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
        id,
        user_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected() > 0)
}

/// Mark one notification read (sqlite leg): `now()` → the canonical RFC3339-UTC
/// `strftime` form the DEC-8 type map stores, so the TEXT comparison stays
/// lexicographic == chronological.
#[cfg(feature = "sqlite-backend")]
pub async fn mark_read(pool: &DbPool, user_id: Uuid, id: Uuid) -> Result<bool, AppError> {
    let res = sqlx::query!(
        "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
        id,
        user_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected() > 0)
}

/// Mark all of a user's notifications read. Returns the number affected.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn mark_all_read(pool: &DbPool, user_id: Uuid) -> Result<u64, AppError> {
    let res = sqlx::query!(
        "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
        user_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}

/// Mark all of a user's notifications read (sqlite leg).
#[cfg(feature = "sqlite-backend")]
pub async fn mark_all_read(pool: &DbPool, user_id: Uuid) -> Result<u64, AppError> {
    let res = sqlx::query!(
        "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE user_id = $1 AND read_at IS NULL",
        user_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}

/// Delete one notification (owner-scoped). Returns rows-affected>0.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn delete(pool: &DbPool, user_id: Uuid, id: Uuid) -> Result<bool, AppError> {
    let res = sqlx::query!(
        "DELETE FROM notifications WHERE id = $1 AND user_id = $2",
        id,
        user_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected() > 0)
}

/// Delete one notification (sqlite leg).
#[cfg(feature = "sqlite-backend")]
pub async fn delete(pool: &DbPool, user_id: Uuid, id: Uuid) -> Result<bool, AppError> {
    let res = sqlx::query!(
        "DELETE FROM notifications WHERE id = $1 AND user_id = $2",
        id,
        user_id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected() > 0)
}

/// Retention prune: delete rows older than `days` (0 = keep forever, no-op).
#[cfg(not(feature = "sqlite-backend"))]
pub async fn prune_older_than(pool: &DbPool, days: i64) -> Result<u64, AppError> {
    if days <= 0 {
        return Ok(0);
    }
    let res = sqlx::query!(
        "DELETE FROM notifications WHERE created_at < now() - make_interval(days => $1::int)",
        days as i32,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}

/// Retention prune (sqlite leg): the DEC-12 `interval` rewrite — `now() - N
/// days` becomes the same canonical RFC3339-UTC string produced with the
/// `-N days` modifier, so the TEXT comparison stays chronologically exact.
#[cfg(feature = "sqlite-backend")]
pub async fn prune_older_than(pool: &DbPool, days: i64) -> Result<u64, AppError> {
    if days <= 0 {
        return Ok(0);
    }
    let res = sqlx::query!(
        "DELETE FROM notifications \
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || $1 || ' days')",
        days,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}
