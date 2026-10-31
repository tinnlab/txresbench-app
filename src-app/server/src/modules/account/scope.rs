//! `account` authz chokepoint seam — the account-graph resolvers the epic binds
//! to, re-exported as one module surface (mirrors `project/scope.rs`'s re-export
//! shape). A3's membership-authz layer and A4's active-account validation resolve
//! through THESE rather than re-implementing the membership lookup.
//!
//! `membership_role(account, user) -> Option<AccountRole>` is the primitive: a
//! `None` is the **cross-account-404 signal** (a resource in an account the caller
//! is not a member of resolves to 404, never 403 — INV-5), the exact analogue of
//! `ProjectScope::resolve → None`. The gating that maps `None` → 404 is A3's.
//!
//! **NOT here:** `account_of(project|dataset)` — that reads the `account_id`
//! column A2 ADDS, so A2 owns it (DEC-3). A1 supplies only the account-graph half
//! (membership + personal-account).

// Re-export the role vocabulary + the repository (which carries `membership_role`
// / `has_role` / `personal_account_of` / `ensure_personal_account` / `list_*` /
// `get`) as the account chokepoint downstream items resolve through.
pub use super::models::{AccountKind, AccountRole};
pub use super::repository::AccountRepository;

use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

// ---------------------------------------------------------------------------
// A2 — the project/dataset → account BRIDGE (DEC-3: A1 owns the account graph;
// A2 owns `account_of(project|dataset|artifact)`, which read the `account_id`
// column A2 ADDS). All three are plain `&SqlitePool` one-row PK lookups returning
// `Option<Uuid>` — mirroring A1's `personal_account_of` shape — so the `account`
// module stays free of a `project`/`dataset`/`workstore` import (no module cycle;
// they read the tables by raw SQL, not by importing those modules' types).
// DEC-8: deliberately `&SqlitePool`, NOT design §6's `&ProjectRepository`.
// (sqlite-store: the pool retype follows the module's single-driver port; the
// `account_id`/`project_id`/`dataset_id` columns are 16-byte BLOBs, so the
// select overrides are written out explicitly.)
//
// `None` = the resource is absent/foreign — the 404 signal A3's membership-authz
// layer maps (the analog of `ProjectScope::resolve → None`).
// ---------------------------------------------------------------------------

/// The account a project belongs to (PROV-A2-1). `None` = no such project.
pub async fn account_of_project(
    pool: &SqlitePool,
    project_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    let row = sqlx::query!(
        r#"SELECT account_id as "account_id: Uuid" FROM projects WHERE id = $1"#,
        project_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.and_then(|r| r.account_id))
}

/// The account a dataset belongs to (PROV-A2-2). `None` = no such dataset.
pub async fn account_of_dataset(
    pool: &SqlitePool,
    dataset_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    let row = sqlx::query!(
        r#"SELECT account_id as "account_id: Uuid" FROM datasets WHERE id = $1"#,
        dataset_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.and_then(|r| r.account_id))
}

/// The account an artifact belongs to (PROV-A2-4), resolved **transitively**:
/// artifacts carry NO `owner_id`/`account_id` column, only a nullable
/// `project_id`/`dataset_id` back-pointer, so the account is
/// `account_of_project|dataset` of whichever parent the artifact hangs off.
/// Takes the artifact **id** (not the `workstore::Artifact` struct) so `account`
/// need not import `workstore` — same result, no cycle. `None` = the artifact is
/// absent, or hangs off neither a project nor a dataset.
pub async fn account_of_artifact(
    pool: &SqlitePool,
    artifact_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    let row = sqlx::query!(
        r#"SELECT project_id as "project_id?: Uuid", dataset_id as "dataset_id?: Uuid" FROM artifacts WHERE id = $1"#,
        artifact_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    if let Some(project_id) = row.project_id {
        return account_of_project(pool, project_id).await;
    }
    if let Some(dataset_id) = row.dataset_id {
        return account_of_dataset(pool, dataset_id).await;
    }
    Ok(None)
}

/// Resolve `user_id`'s personal account, CREATING it (idempotently) if it does
/// not yet exist — the DEC-7 lazy backstop the ownership-stamp write paths
/// (`project`/`dataset`/`workstore` create/duplicate/transfer, ITEM-5/6) call to
/// obtain the `account_id` for a new/re-owned row. A1's baseline gives every
/// PRE-existing user a personal account; this covers a user created AFTER the
/// migration but BEFORE A5's signup hook lands. Builds ON A1's frozen PROV-A1-4
/// (`personal_account_of` fast path + idempotent `ensure_personal_account`),
/// deriving the account name from the user's username.
pub async fn ensure_personal_account_for(
    pool: &SqlitePool,
    user_id: Uuid,
) -> Result<Uuid, AppError> {
    let repo = AccountRepository::new(pool.clone());
    if let Some(id) = repo.personal_account_of(user_id).await? {
        return Ok(id);
    }
    // No personal account yet: create one, naming it after the user (matching
    // A1's baseline, which names each personal account after `users.username`).
    let name = sqlx::query!(r#"SELECT username FROM users WHERE id = $1"#, user_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?
        .map(|r| r.username)
        .unwrap_or_else(|| "personal".to_string());
    let account_id = repo.ensure_personal_account(user_id, &name).await?;
    // A4 ITEM-6: this is a GENUINE account + owner-membership creation (the sole
    // Phase-2 account mutation), so emit the `account` / `account_member` sync frames
    // to the new member (A4 owns the emit — A1 DEC-5). It fires only on the real
    // create branch above, never on the idempotent fast-path return, so it is not
    // per-request spam. Notify-and-refetch only.
    super::sync::publish_account_created(pool, account_id).await;
    Ok(account_id)
}
