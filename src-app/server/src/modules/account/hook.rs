//! A5 / G-AUTHEVT — the clean in-transaction personal-account hook.
//!
//! The atomic counterpart to [`backstop`](super::backstop). Where the backstop is
//! a best-effort, post-hoc, first-authenticated-request lazy-ensure (the only tool
//! the app had while the SDK exposed no synchronous seam for the turnkey creation
//! paths), THIS is the clean path the SDK's G-AUTHEVT landing unlocked: an
//! [`install_user_created_hook`]-installed [`UserCreatedHook`] that the auth
//! crate fires INSIDE the user-creation transaction, at EVERY creation path (local
//! register, LDAP/OAuth first-login, admin-create, first-run setup), immediately
//! after the user row is inserted and before commit.
//!
//! So a fresh user gets their personal account in the SAME transaction as the user
//! INSERT — the two commit together or neither does (an atomic co-transaction). No
//! window exists in which a committed user has no personal account, and no
//! authenticated request is needed to heal one.
//!
//! ## Why the backstop is KEPT alongside this
//!
//! The hook only fires for users created AFTER it is installed. Users that already
//! exist — created before this hook landed, or by any future path that somehow
//! bypasses the crate's INSERT functions — are covered by the retained backstop,
//! which self-heals them on their next authenticated request (§11). The two are
//! complementary: the hook is the clean forward path for new users; the backstop
//! is the self-healing safety net for everyone else. Both bind the SAME idempotent
//! upsert ([`AccountRepository::ensure_personal_account_in_tx`] /
//! [`AccountRepository::ensure_personal_account`]), so a user covered by both
//! converges on exactly one account (INV-2/INV-3).
//!
//! ## Contract
//!
//! The hook names the personal account after the user's `username` — the same
//! choice the backstop makes (DEC-4), so a hook-created and a backstop-created
//! account are indistinguishable. Returning `Err` rolls the whole user creation
//! back (the SDK contract): a user whose personal account cannot be provisioned is
//! a broken state, so failing the creation atomically is safer than committing a
//! half-provisioned user.
//!
//! ## Note on the struct shape
//!
//! [`AccountRepository::ensure_personal_account_in_tx`] is an ASSOCIATED function
//! that runs entirely on the caller-owned connection the SDK hands us — it needs
//! no pool of its own. So the hook is a unit struct rather than carrying a repo
//! handle it would never use (a build-time refinement of the plan's illustrative
//! `PersonalAccountHook { repo }` — the honest shape, since the in-tx seam needs
//! no standalone pool).

use async_trait::async_trait;

use ziee_auth::{User, UserCreatedHook};
use ziee_core::AppError;
use ziee_core::DbConnection;

use super::repository::AccountRepository;

/// The app's [`UserCreatedHook`]: provision the just-created user's personal
/// account + owner membership atomically, inside the creation transaction.
pub struct PersonalAccountHook;

#[async_trait]
impl UserCreatedHook for PersonalAccountHook {
    async fn on_user_created(&self, user: &User, tx: &mut DbConnection) -> Result<(), AppError> {
        // In-tx idempotent upsert on the creation transaction's own connection, so
        // the personal account commits atomically with the user row. Named after
        // the username (DEC-4), matching the backstop.
        AccountRepository::ensure_personal_account_in_tx(tx, user.id, &user.username).await?;
        Ok(())
    }
}
