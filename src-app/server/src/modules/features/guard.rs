//! The runtime feature-flag guard — the ONE seam other modules consult.
//!
//! `is_feature_enabled(pool, flag_key, account_id)` resolves a flag through three
//! layers, in strict precedence (INV-1):
//!
//!   1. a PER-ACCOUNT override row  (only when `account_id` is `Some`)
//!   2. the GLOBAL default row
//!   3. the COMPILED registry default   (INV-2 — a flag with no row is never an error)
//!
//! It is deliberately fail-CLOSED on the hot path: a DB error at ANY layer logs and
//! returns `false` (the feature-off baseline), so a flag check can never break a
//! request AND a transient error can never GRANT a feature that was not resolved from
//! a real row. It does NOT fall through to a more-permissive layer on error — that
//! would let a blip on the per-account read bypass an explicit per-account DENY and
//! serve the (possibly `true`) global default instead (audit F1). Only a genuine
//! ABSENCE of a row (`Ok(None)`) falls through; an UNKNOWN flag resolves to the
//! fail-closed compiled default (`false`).
//!
//! Other modules call THIS, never the table/repository directly, so the precedence
//! lives in exactly one place.

use sqlx::SqlitePool;
use uuid::Uuid;

use super::registry;
use super::repository::FeatureFlagRepository;

/// Is `flag_key` enabled for `account_id` (or globally, when `account_id` is `None`)?
///
/// Precedence: per-account override → global default → compiled default (INV-1). A
/// flag with no persisted row returns the compiled default (INV-2); an unknown flag
/// fails closed (`false`).
pub async fn is_feature_enabled(pool: &SqlitePool, flag_key: &str, account_id: Option<Uuid>) -> bool {
    let repo = FeatureFlagRepository::new(pool.clone());

    // 1. per-account override (only when an account is in scope).
    if let Some(account_id) = account_id {
        match repo.account_enabled(flag_key, account_id).await {
            Ok(Some(enabled)) => return enabled,
            Ok(None) => {} // no override → fall through to the global default
            // FAIL CLOSED (audit F1): an UNREADABLE override must not be bypassed by
            // falling through to a more-permissive global. We cannot know whether this
            // account was explicitly denied, so we withhold the feature (`false`).
            Err(e) => {
                tracing::warn!(
                    error = ?e, flag_key, %account_id,
                    "feature-flag per-account read failed; failing CLOSED (false)"
                );
                return false;
            }
        }
    }

    // 2. global default row.
    match repo.global_enabled(flag_key).await {
        Ok(Some(enabled)) => return enabled,
        Ok(None) => {} // no global row → the compiled default
        // FAIL CLOSED: an unreadable global must not fall to a possibly-`true` compiled
        // default (that would GRANT on error). Withhold the feature.
        Err(e) => {
            tracing::warn!(
                error = ?e, flag_key,
                "feature-flag global read failed; failing CLOSED (false)"
            );
            return false;
        }
    }

    // 3. compiled registry default (unknown key ⇒ fail-closed false).
    registry::compiled_default(flag_key)
}
