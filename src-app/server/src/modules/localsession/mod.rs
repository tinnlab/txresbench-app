//! `localsession` module — the single-user local session endpoint.
//!
//! TxResBench is a single-user desktop app with no login screen: the desktop
//! shell mints the owner session through the Tauri `auto_login` command. The
//! plain HTTP server (web-service mode, browsers) needs the same mint as a
//! route: `POST /api/session/local` provisions the single owner on first run
//! (idempotent) and returns a permanent session for them, using the SAME
//! `ziee_auth::auth::refresh_tokens::mint_session_tokens` path every server
//! login uses — so local sessions are revocable and pruned like any other.
//!
//! Owner identity is the framework's desktop default: `admin` /
//! `admin@localhost`, an `is_admin` user in the `Administrators` group, holder
//! of the `"*"` permission wildcard (so every permission gate passes). Owner
//! CREATION mirrors the desktop crate's `ensure_owner` (see
//! `src-app/desktop/tauri/src/commands.rs`).

use aide::axum::routing::post_with;
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Extension;
use axum::Json;
use axum::http::StatusCode;
use linkme::distributed_slice;
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;
use ziee_auth::auth::password::hash_password;
use ziee_auth::auth::refresh_tokens::mint_session_tokens;
use ziee_auth::auth::JwtService;
use ziee_auth::user::{GroupRepository, UserRepository};
use ziee_auth::User;
use ziee_core::{ApiResult, AppError};
use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The single local owner's identity (mirrors the desktop harness's
/// `SingleUserStrategy::desktop_default`).
const OWNER_USERNAME: &str = "admin";
const OWNER_EMAIL: &str = "admin@localhost";
const OWNER_PASSWORD: &str = "desktop-auto-login";

/// The minted session for the single local owner, shape-compatible with the
/// desktop `auto_login` command's return.
#[derive(Serialize, Debug, schemars::JsonSchema)]
pub struct LocalSession {
    pub user: User,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

/// Create the single local owner (admin) on first run. Idempotent — no-ops once
/// an admin exists. Mirrors the desktop crate's `ensure_owner`.
pub async fn ensure_owner(pool: &PgPool) -> Result<(), AppError> {
    let user_repo = UserRepository::new(pool.clone());
    let has_admin = user_repo.has_admin().await?;
    if has_admin {
        return Ok(());
    }

    let group_repo = GroupRepository::new(pool.clone());

    let hash = hash_password(OWNER_PASSWORD)
        .map_err(|e| AppError::internal_error(format!("password hash failed: {e}")))?;
    let user = user_repo
        .create(
            OWNER_USERNAME,
            OWNER_EMAIL,
            Some(hash),
            Some("Owner".to_string()),
            None,
        )
        .await?;

    // The SDK's `UserRepository::create` cannot set `is_admin` (SDK_GAPS D-1).
    sqlx::query("UPDATE users SET is_admin = true WHERE id = $1")
        .bind(user.id)
        .execute(pool)
        .await?;

    // Owner-`*`: membership in the Administrators group (seeded by ziee-auth's
    // migration with the `"*"` wildcard permission).
    if let Some(admins) = group_repo.get_by_name("Administrators").await? {
        user_repo
            .assign_to_group(user.id, admins.id, None)
            .await?;
    }

    // A5 ITEM-3: the single desktop owner owns EXACTLY ONE personal account.
    crate::modules::account::AccountRepository::new(pool.clone())
        .ensure_personal_account(user.id, OWNER_USERNAME)
        .await?;

    Ok(())
}

/// Mint a permanent session for the single local owner (mirrors the desktop
/// harness's `SingleUserStrategy::mint_owner_login`).
pub async fn mint_owner_session(pool: &PgPool, jwt: &JwtService) -> Result<LocalSession, AppError> {
    let owner = UserRepository::new(pool.clone())
        .get_by_username(OWNER_USERNAME)
        .await?
        .ok_or_else(|| {
            AppError::internal_error("Admin not found - server may still be starting")
        })?;

    let minted = mint_session_tokens(
        pool,
        jwt,
        owner.id,
        &owner.username,
        &owner.email,
        owner.is_admin,
    )
    .await?;
    let pair = minted.pair;

    Ok(LocalSession {
        user: owner,
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
        expires_in: pair.expires_in,
    })
}

async fn create_local_session(
    Extension(pool): Extension<PgPool>,
    Extension(jwt): Extension<Arc<JwtService>>,
) -> ApiResult<Json<LocalSession>> {
    ensure_owner(&pool).await?;
    Ok((StatusCode::OK, Json(mint_owner_session(&pool, &jwt).await?)))
}

pub struct LocalSessionModule;

impl AppModule for LocalSessionModule {
    fn name(&self) -> &'static str {
        "localsession"
    }

    fn description(&self) -> &'static str {
        "Single-user local session mint (no login screen)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.nest(
            "/session",
            ApiRouter::new().api_route("/local", post_with(create_local_session, docs)),
        )
    }
}

fn docs(op: TransformOperation) -> TransformOperation {
    op.description("Mint a permanent local session for the single owner (no login screen)")
        .id("LocalSession.create")
        .tag("localsession")
        .response::<200, Json<LocalSession>>()
}

#[distributed_slice(MODULE_ENTRIES)]
static LOCALSESSION: ModuleEntry = ModuleEntry {
    name: "localsession",
    order: 4,
    description: "Single-user local session mint (no login screen).",
    constructor: || Box::new(LocalSessionModule),
};
