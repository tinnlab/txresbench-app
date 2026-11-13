//! `account` authz chokepoint seam — the account-graph resolvers the epic binds
//! to, re-exported as one module surface. The membership-authz layer and
//! active-account validation resolve through THESE rather than re-implementing
//! the membership lookup.
//!
//! `membership_role(account, user) -> Option<AccountRole>` is the primitive: a
//! `None` is the **cross-account-404 signal** (a resource in an account the caller
//! is not a member of resolves to 404, never 403 — INV-5).

// Re-export the role vocabulary + the repository (which carries `membership_role`
// / `has_role` / `personal_account_of` / `ensure_personal_account` / `list_*` /
// `get`) as the account chokepoint downstream items resolve through.
pub use super::models::{AccountKind, AccountRole};
pub use super::repository::AccountRepository;

use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

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
