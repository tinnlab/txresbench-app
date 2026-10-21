//! `feature_flags` types — the persisted row + the admin API request/response shapes.
//!
//! Mirrors `jobs/models.rs` (schemars `JsonSchema` + serde + sqlx `FromRow`); the FE
//! types are generated from these via `just openapi-regen`.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// A persisted `feature_flags` row. `account_id = None` is the GLOBAL default row for
/// the flag; `Some(_)` is a per-account override.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct FeatureFlagRow {
    pub id: Uuid,
    pub flag_key: String,
    pub account_id: Option<Uuid>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One flag as presented on the admin surface: the compiled registry facts plus the
/// current global/per-account rows and the RESOLVED effective value for the queried
/// account (or the global effective value when no account was queried).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FeatureFlagView {
    pub flag_key: String,
    pub description: String,
    /// The compiled default (the value when no DB row overrides it).
    pub default_enabled: bool,
    /// The GLOBAL row's value, if a global row exists (else `null` → the compiled
    /// default applies globally).
    pub global_enabled: Option<bool>,
    /// The per-account override's value for the queried account, if one exists (and
    /// only when an `account_id` was queried). `null` otherwise.
    pub account_enabled: Option<bool>,
    /// The resolved value: per-account override → global → compiled default. When an
    /// `account_id` was queried this is that account's effective value; otherwise it
    /// is the global effective value.
    pub effective: bool,
}

/// `GET /api/admin/features` response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FeaturesListResponse {
    pub flags: Vec<FeatureFlagView>,
    /// The account the `effective`/`account_enabled` columns were resolved for
    /// (`?account_id=`), or `null` for the global view.
    pub account_id: Option<Uuid>,
}

/// `PUT /api/admin/features/{flag_key}` body. `account_id = None` sets the GLOBAL
/// default; `Some(_)` sets a per-account override.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SetFeatureFlagRequest {
    pub enabled: bool,
    #[serde(default)]
    pub account_id: Option<Uuid>,
}
