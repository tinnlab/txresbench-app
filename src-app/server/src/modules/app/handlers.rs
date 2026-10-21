//! First-run setup — public, self-gated by `has_admin`. Creates the first admin
//! (with the Administrators + Users groups) and mints a session.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use ziee_auth::auth::context::AuthContext;
use ziee_auth::auth::password::hash_password;
use ziee_auth::auth::refresh_tokens::mint_session_tokens;
use ziee_auth::auth::types::AuthResponse;
use ziee_auth::auth::JwtService;
use ziee_core::{ApiResult, AppError};

#[derive(Debug, Serialize, JsonSchema)]
pub struct SetupStatusResponse {
    pub needs_setup: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetupAdminRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Public: whether the deployment still needs first-run setup.
pub async fn get_setup_status(
    Extension(ctx): Extension<AuthContext>,
) -> ApiResult<Json<SetupStatusResponse>> {
    let has_admin = ctx.user().has_admin().await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(SetupStatusResponse {
            needs_setup: !has_admin,
        }),
    ))
}

/// Public but self-gated: create the first admin. 403 once any admin exists.
pub async fn setup_admin(
    Extension(ctx): Extension<AuthContext>,
    Extension(jwt): Extension<Arc<JwtService>>,
    Json(req): Json<SetupAdminRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let users = ctx.user();
    let groups = ctx.group();

    if users.has_admin().await.map_err(e)? {
        return Err(e(AppError::forbidden(
            "SETUP_ALREADY_COMPLETE",
            "Setup has already been completed",
        )));
    }

    // Validation (mirrors ziee's setup validator, minimal form).
    let username = req.username.trim();
    if username.len() < 3 || username.len() > 100 || username.chars().any(char::is_control) {
        return Err(e(AppError::bad_request(
            "INVALID_USERNAME",
            "Username must be 3–100 characters with no control characters",
        )));
    }
    if req.email.trim().is_empty() || !req.email.contains('@') {
        return Err(e(AppError::bad_request("INVALID_EMAIL", "A valid email is required")));
    }
    if req.password.len() < 8 || req.password.len() > 72 || req.password.contains('\0') {
        return Err(e(AppError::bad_request(
            "WEAK_PASSWORD",
            "Password must be 8–72 bytes and contain no NUL",
        )));
    }

    let hash = hash_password(&req.password)
        .map_err(|_| e(AppError::internal_error("Failed to hash password")))?;
    let created = users
        .create(username, req.email.trim(), Some(hash), req.display_name.clone(), None)
        .await
        .map_err(e)?;

    // SDK_GAPS D-1: ziee-auth's create can't set is_admin → raw UPDATE.
    sqlx::query("UPDATE users SET is_admin = true WHERE id = $1")
        .bind(created.id)
        .execute(ctx.pool())
        .await
        .map_err(|err| e(AppError::database_error(err)))?;

    // Assign the first admin to both seeded system groups.
    if let Ok(Some(admins)) = groups.get_by_name("Administrators").await {
        let _ = users.assign_to_group(created.id, admins.id, None).await;
    }
    if let Ok(Some(default)) = groups.get_default().await {
        let _ = users.assign_to_group(created.id, default.id, None).await;
    }

    // Re-fetch so the response + minted claims carry is_admin = true.
    let user = users
        .get_by_id(created.id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::internal_error("admin vanished after creation")))?;

    // A5 ITEM-2: the first admin of a hosted deployment owns EXACTLY ONE personal
    // account from t=0 (INV-1) — before the session is even minted, not at their
    // first login. Idempotent (A1 `ON CONFLICT`); error surfaced, not swallowed.
    // Name = `username` (DEC-4).
    crate::modules::account::AccountRepository::new(ctx.pool().clone())
        .ensure_personal_account(user.id, &user.username)
        .await
        .map_err(e)?;

    let minted = mint_session_tokens(
        ctx.pool(),
        &jwt,
        user.id,
        &user.username,
        &user.email,
        user.is_admin,
    )
    .await
    .map_err(e)?;

    Ok((
        StatusCode::CREATED,
        Json(AuthResponse {
            user,
            tokens: minted.pair,
        }),
    ))
}
