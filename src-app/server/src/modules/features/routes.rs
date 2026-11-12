//! Feature-flags admin HTTP routes (aide-documented) — the runtime, admin-togglable
//! flag surface (#40). Gating mirrors `jobs/routes.rs` settings: a
//! `RequirePermissions<(FeaturesManage,)>` extractor on the handler (401
//! unauthenticated / 403 without the perm) + `with_permission::<(FeaturesManage,)>`
//! in the docs fn (which lands `features::manage` in the generated FE vocabulary).
//! Re-run `just openapi-regen` after any change here.
//!
//! * `GET  /api/admin/features[?account_id=]` — every registry flag with its global +
//!   per-account rows and the RESOLVED effective value (computed through the
//!   `is_feature_enabled` guard — the production caller of the seam).
//! * `PUT  /api/admin/features/{flag_key}` — upsert the global default or a per-account
//!   override. Unknown flag → 404 `UNKNOWN_FLAG`; unknown account → 404.

use aide::axum::routing::{delete_with, get_with, put_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::{ApiResult, AppError};

use crate::modules::permissions::{with_permission, RequirePermissions};

use super::guard::is_feature_enabled;
use super::models::{FeatureFlagView, FeaturesListResponse, SetFeatureFlagRequest};
use super::permissions::FeaturesManage;
use super::registry::{self, FlagSpec};
use super::repository::FeatureFlagRepository;

/// Optional `?account_id=` for the flag list — resolve the effective/per-account
/// columns for this account instead of the global view.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FeaturesListQuery {
    #[serde(default)]
    pub account_id: Option<Uuid>,
}

pub fn features_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/admin/features", get_with(list_features, list_features_docs))
        .api_route(
            "/admin/features/{flag_key}",
            put_with(set_feature, set_feature_docs),
        )
        // The per-account CLEAR keys the account in the PATH (not a query/body): the
        // pinned SDK api-client transport only routes non-path params to the query for
        // GET and to the body for POST/PUT/PATCH — a DELETE's non-path params are dropped
        // (DEC-2). A path segment is the one placement every verb substitutes.
        .api_route(
            "/admin/features/{flag_key}/account/{account_id}",
            delete_with(clear_feature, clear_feature_docs),
        )
}

/// Emit a structured audit event for a feature-flag mutation. This codebase has NO
/// audit-log table — other admin mutations column-stamp who/when onto the mutated row,
/// which a DELETE (clear) cannot do — so the audit trail is a structured `tracing` event
/// on the dedicated `audit` target carrying the actor, action, flag_key and account_id
/// (DEC-3 / INV-4). Emitted on every mutation: set-global, set-account, clear-account.
fn audit_flag_mutation(actor: Uuid, action: &str, flag_key: &str, account_id: Option<Uuid>) {
    let account = account_id
        .map(|a| a.to_string())
        .unwrap_or_else(|| "-".to_string());
    tracing::info!(
        target: "audit",
        actor = %actor,
        action = action,
        flag_key = flag_key,
        account_id = %account,
        "feature-flag mutation"
    );
}

/// Build the admin view for one registry flag, resolving `effective` through the
/// `is_feature_enabled` guard (the single owner of the precedence rule — the route
/// never re-derives per-account → global → default itself). This is the production
/// call site of the runtime seam.
async fn build_view(
    pool: &SqlitePool,
    repo: &FeatureFlagRepository,
    spec: &FlagSpec,
    account_id: Option<Uuid>,
) -> Result<FeatureFlagView, AppError> {
    let global_enabled = repo.global_enabled(spec.key).await?;
    let account_enabled = match account_id {
        Some(acc) => repo.account_enabled(spec.key, acc).await?,
        None => None,
    };
    let effective = is_feature_enabled(pool, spec.key, account_id).await;
    Ok(FeatureFlagView {
        flag_key: spec.key.to_string(),
        description: spec.description.to_string(),
        default_enabled: spec.default_enabled,
        global_enabled,
        account_enabled,
        effective,
    })
}

// ----------------------------------------------------------------- list

async fn list_features(
    _auth: RequirePermissions<(FeaturesManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<FeaturesListQuery>,
) -> ApiResult<Json<FeaturesListResponse>> {
    let repo = FeatureFlagRepository::new(pool.clone());
    let mut flags = Vec::with_capacity(registry::KNOWN_FLAGS.len());
    for spec in registry::KNOWN_FLAGS {
        flags.push(
            build_view(&pool, &repo, spec, q.account_id)
                .await
                .map_err(|e| e.to_api_error())?,
        );
    }
    Ok((
        StatusCode::OK,
        Json(FeaturesListResponse {
            flags,
            account_id: q.account_id,
        }),
    ))
}

fn list_features_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(FeaturesManage,)>(op)
        .description(
            "List every known runtime feature flag with its compiled default, its \
             global + per-account rows, and the RESOLVED effective value. Optional \
             ?account_id= resolves the effective/per-account columns for that account \
             (else the global view). Requires features::manage (admins hold it via *).",
        )
        .id("Features.list")
        .tag("features")
        .response::<200, Json<FeaturesListResponse>>()
}

// ----------------------------------------------------------------- set

async fn set_feature(
    auth: RequirePermissions<(FeaturesManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(flag_key): Path<String>,
    Json(req): Json<SetFeatureFlagRequest>,
) -> ApiResult<Json<FeatureFlagView>> {
    // Only a known (registry) flag is settable — the table is not a free-form KV store.
    let spec = registry::lookup(&flag_key).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "UNKNOWN_FLAG",
            format!("no such feature flag: {flag_key}"),
        )
        .to_api_error()
    })?;

    let repo = FeatureFlagRepository::new(pool.clone());

    match req.account_id {
        // Per-account override: refuse a write against a non-existent account with a
        // 404 (rather than surface a raw FK error), then upsert only that account's row.
        Some(account_id) => {
            if !repo
                .account_exists(account_id)
                .await
                .map_err(|e| e.to_api_error())?
            {
                return Err(AppError::not_found("Account").to_api_error());
            }
            repo.set_account(&flag_key, account_id, req.enabled)
                .await
                .map_err(|e| e.to_api_error())?;
            audit_flag_mutation(
                auth.user.id,
                "features.set_account",
                &flag_key,
                Some(account_id),
            );
        }
        // Global default: upsert only the global row.
        None => {
            repo.set_global(&flag_key, req.enabled)
                .await
                .map_err(|e| e.to_api_error())?;
            audit_flag_mutation(auth.user.id, "features.set_global", &flag_key, None);
        }
    }

    // Return the flag's resolved view for the account that was set (or the global view).
    let view = build_view(&pool, &repo, spec, req.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(view)))
}

fn set_feature_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(FeaturesManage,)>(op)
        .description(
            "Set a runtime feature flag. With no account_id in the body, sets the \
             GLOBAL default; with an account_id, sets a PER-ACCOUNT override (neither \
             disturbs the other). Unknown flag_key → 404 UNKNOWN_FLAG; unknown \
             account_id → 404. Requires features::manage.",
        )
        .id("Features.set")
        .tag("features")
        .response::<200, Json<FeatureFlagView>>()
        .response_with::<404, (), _>(|r| {
            r.description("The flag_key is not a known flag, or the account_id does not exist")
        })
}

// ---------------------------------------------------------------- clear

/// Clear a PER-ACCOUNT override so the account reverts to inheriting the global default
/// (or the compiled default) — the missing half of #48 that made a per-account set a
/// one-way footgun (#53). The precedence itself is unchanged and still owned by the guard
/// (`is_feature_enabled`): removing the override row simply makes the guard's step-1 miss
/// and fall through (INV-1). Idempotent — clearing an absent override is a success that
/// fabricates no row (DEC-5 / INV-2).
async fn clear_feature(
    auth: RequirePermissions<(FeaturesManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Path((flag_key, account_id)): Path<(String, Uuid)>,
) -> ApiResult<Json<FeatureFlagView>> {
    // Only a known (registry) flag is clearable — the table is not a free-form KV store.
    let spec = registry::lookup(&flag_key).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "UNKNOWN_FLAG",
            format!("no such feature flag: {flag_key}"),
        )
        .to_api_error()
    })?;

    let repo = FeatureFlagRepository::new(pool.clone());

    // Refuse a clear against a non-existent account with a 404 (mirrors the PUT), rather
    // than silently succeed against a phantom account.
    if !repo
        .account_exists(account_id)
        .await
        .map_err(|e| e.to_api_error())?
    {
        return Err(AppError::not_found("Account").to_api_error());
    }

    // Idempotent DELETE of exactly this account's override row (0 or 1 rows). Never touches
    // the global row or another account's override (INV-3).
    repo.clear_account(&flag_key, account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    audit_flag_mutation(
        auth.user.id,
        "features.clear_account",
        &flag_key,
        Some(account_id),
    );

    // Return the flag's resolved view for that account — now inheriting (account_enabled
    // null, effective = global/compiled), so the caller sees the revert immediately.
    let view = build_view(&pool, &repo, spec, Some(account_id))
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(view)))
}

fn clear_feature_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(FeaturesManage,)>(op)
        .description(
            "Clear a PER-ACCOUNT feature-flag override (the account is a PATH segment: \
             /admin/features/{flag_key}/account/{account_id}), so the account reverts to \
             inheriting the global default (or the compiled default). Idempotent: clearing \
             an absent override succeeds and fabricates no row; the global row and other \
             accounts' overrides are never touched. Unknown flag_key → 404 UNKNOWN_FLAG; \
             unknown account_id → 404. Returns the flag's now-inherited resolved view. \
             Requires features::manage.",
        )
        .id("Features.clear")
        .tag("features")
        .response::<200, Json<FeatureFlagView>>()
        .response_with::<404, (), _>(|r| {
            r.description("The flag_key is not a known flag, or the account_id does not exist")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5 [acceptance] [invariant: INV-4]: the audit sink actually EMITS a structured
    // event on the `audit` target carrying actor/action/flag_key/account_id — the audit
    // half of INV-4. Captured via a scoped `tracing` fmt subscriber writing to a buffer.
    #[test]
    fn audit_flag_mutation_emits_structured_event() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Buf {
            type Writer = Buf;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let actor = Uuid::new_v4();
        let account = Uuid::new_v4();
        let buf = Buf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_target(true)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            audit_flag_mutation(actor, "features.clear_account", "demo.runtime_flag", Some(account));
            // A global mutation records account_id as "-".
            audit_flag_mutation(actor, "features.set_global", "demo.runtime_flag", None);
        });

        let out = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(out.contains("audit"), "audit target present: {out}");
        assert!(out.contains("features.clear_account"), "clear action: {out}");
        assert!(out.contains("features.set_global"), "global action: {out}");
        assert!(out.contains(&actor.to_string()), "actor id: {out}");
        assert!(out.contains(&account.to_string()), "account id: {out}");
        assert!(out.contains("demo.runtime_flag"), "flag key: {out}");
        assert!(out.contains("account_id=-"), "global clears account to '-': {out}");
    }
}
