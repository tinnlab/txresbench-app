//! Admin Billing-integration surface (#60) — the deployment-level, ENCRYPTED-at-rest
//! Stripe credential config.
//!
//! SECURITY (the whole point):
//!  - The Stripe secret + webhook signing secret are stored ENCRYPTED (`bytea`
//!    ciphertext via `ziee_framework::secret::encrypt_secret`, pgcrypto), NEVER
//!    plaintext. The GET returns a MASKED view only (`configured`/`last4`/
//!    `connected`/`prices`) — no endpoint, log, or error carries the plaintext.
//!  - Any in-memory secret is wrapped in `SecretView<String>` at the boundary.
//!  - The Test action makes ONE lightweight Stripe call and returns `{ok,message}`
//!    — a bad key is a clean `ok:false`, never a 500 that leaks the key.
//!  - `#[cfg(feature = "saas")]` (the whole `billing` module) + gated on
//!    `billing::admin` via [`AdminBillingIntegrationScope`] (403 otherwise).
//!
//! Deployment-scoped (NOT account-scoped): unlike `admin::AdminBillingScope` there is
//! no `{account_id}` path — this configures the ONE deployment's Stripe credentials.

use std::sync::Arc;

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use aide::OperationIo;
use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use axum::{Extension, Json};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_auth::auth::DefaultIdentityResolver;
use ziee_core::{ApiResult, AppError};
use ziee_framework::permissions::IdentityResolver;
use ziee_framework::secret::{encrypt_secret, SecretView};

use crate::modules::permissions::{principal_holds, with_permission, PermissionCheck};

use super::client::{self, StripeClient};
use super::models::{
    BillingIntegrationView, TestConnectionRequest, TestConnectionResponse,
    UpdateBillingIntegrationRequest,
};
use super::permissions::BillingAdmin;
use super::repository;

/// A deployment-scoped admin context proven `is_admin` OR holding `billing::admin`.
/// `#[aide(input)]` so it is transparent to the OpenAPI schema (a request-context
/// extractor, not a body). Carries ONLY the acting admin's user id (stamped into the
/// `updated_by` audit column) — no secret ever enters this type.
#[derive(Debug, Clone, OperationIo)]
#[aide(input)]
pub struct AdminBillingIntegrationScope {
    /// The authenticated admin's user id — stamped into `updated_by` on a write.
    pub admin_user_id: Uuid,
}

impl FromRequestParts<()> for AdminBillingIntegrationScope {
    type Rejection = (StatusCode, AppError);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &(),
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let resolver = parts
                .extensions
                .get::<Arc<DefaultIdentityResolver>>()
                .cloned()
                .ok_or_else(|| {
                    AppError::internal_error("Identity resolver not configured").to_api_error()
                })?;

            // 1. authenticate (401 on any auth failure).
            let user = resolver.authenticate(parts).await?;

            // 2. authorize — is_admin OR the billing::admin grant → 403 otherwise.
            let authorized = if user.is_admin {
                true
            } else {
                let groups = resolver.load_groups(&user).await?;
                principal_holds(&user, &groups, BillingAdmin::PERMISSION)
            };
            if !authorized {
                return Err(AppError::forbidden(
                    "BILLING_ADMIN_REQUIRED",
                    "Configuring the Stripe integration requires the billing::admin permission",
                )
                .to_api_error());
            }

            Ok(AdminBillingIntegrationScope {
                admin_user_id: user.id,
            })
        }
    }
}

/// The last 4 characters of a secret (UTF-8-safe, never byte-indexed), for the masked
/// display view. `None` when there is no secret. NEVER the full key.
fn last4_of(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let start = chars.len().saturating_sub(4);
    chars[start..].iter().collect()
}

/// Build the MASKED view (INV-2): resolve the effective secret to derive
/// `configured`/`last4`/`connected` WITHOUT ever emitting the plaintext. The resolved
/// plaintext is held in a `SecretView<String>` at the boundary and dropped here.
async fn build_view(pool: &PgPool) -> Result<BillingIntegrationView, AppError> {
    let row = repository::get_billing_integration(pool).await?;

    // Determine the effective secret AND its source, so the `connected` status reflects
    // the value the resolver would actually USE (not merely that a ciphertext exists): a
    // present-but-UNDECRYPTABLE ciphertext (wrong key after a rotation) degrades to the
    // env fallback here exactly as `resolve_secret` does — never a false "database".
    // `resolve_optional_secret(_, ct, None)` decrypts when a storage key is set and, on a
    // decrypt failure, logs + returns `None` (the supplied fallback), never erroring.
    let db_plain: Option<String> = if ziee_framework::secrets::storage_key().is_some() {
        // Move the ciphertext out (only `row.price_ids` is used afterward) — never a copy.
        ziee_framework::secret::resolve_optional_secret(pool, row.stripe_secret_ciphertext, None)
            .await
    } else {
        None
    };

    // Hold any in-memory secret in a SecretView at the boundary and derive only last4.
    let (configured, last4, connected) = if let Some(plain) = db_plain {
        let sv = SecretView::new(plain);
        (true, Some(last4_of(sv.expose_secret())), "database")
    } else if let Some(env) = client::env_secret_key() {
        let sv = SecretView::new(env);
        (true, Some(last4_of(sv.expose_secret())), "environment")
    } else {
        (false, None, "unconfigured")
    };

    let webhook_configured = client::resolve_webhook_secret(pool).await?.is_some();

    Ok(BillingIntegrationView {
        configured,
        last4,
        webhook_configured,
        connected: connected.to_string(),
        prices: row.price_ids,
    })
}

/// `GET /api/admin/billing/integration` (#60): the MASKED view. NEVER plaintext.
async fn get_integration(
    _scope: AdminBillingIntegrationScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<BillingIntegrationView>> {
    let view = build_view(&pool).await.map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(view)))
}

fn get_integration_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Read the masked Stripe integration config (configured/last4/connected/prices). \
             NEVER returns the plaintext secret.",
        )
        .id("Admin.getBillingIntegration")
        .tag("admin")
        .response::<200, Json<BillingIntegrationView>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<403, (), _>(|r| r.description("Requires billing::admin"))
}

/// `PUT /api/admin/billing/integration` (#60): set/rotate the secret(s) + price
/// mapping. Each secret is ENCRYPTED before storage; a blank/absent secret is left
/// unchanged (a price-only edit never wipes a secret). Stamps the audit `updated_by`.
async fn put_integration(
    scope: AdminBillingIntegrationScope,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<UpdateBillingIntegrationRequest>,
) -> ApiResult<Json<BillingIntegrationView>> {
    let storage_key = ziee_framework::secrets::storage_key();

    // Encrypt any supplied secret. `encrypt_secret` returns Ok(None) when the storage
    // key is unset — but the ADMIN explicitly asked to store a secret, so silently
    // dropping it (or storing plaintext) is wrong: refuse with a clean 400.
    let stripe_ct = match req.stripe_secret_to_store() {
        Some(plain) => Some(encrypt_or_refuse(&pool, plain, storage_key).await?),
        None => None,
    };
    let webhook_ct = match req.webhook_secret_to_store() {
        Some(plain) => Some(encrypt_or_refuse(&pool, plain, storage_key).await?),
        None => None,
    };

    repository::upsert_billing_integration(
        &pool,
        stripe_ct,
        webhook_ct,
        req.prices.clone(),
        scope.admin_user_id,
    )
    .await
    .map_err(|e| e.to_api_error())?;

    let view = build_view(&pool).await.map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(view)))
}

/// Encrypt a supplied plaintext secret, or refuse with a clean 400 when at-rest
/// encryption is not configured (`secrets.storage_key` unset) — NEVER store plaintext.
async fn encrypt_or_refuse(
    pool: &PgPool,
    plain: &str,
    storage_key: Option<&str>,
) -> Result<Vec<u8>, (StatusCode, AppError)> {
    match encrypt_secret(pool, plain, storage_key).await {
        Ok(Some(ct)) => Ok(ct),
        Ok(None) => Err(AppError::bad_request(
            "SECRET_STORAGE_DISABLED",
            "At-rest secret encryption is not configured (set secrets.storage_key). \
             Cannot store a Stripe secret; use the STRIPE_SECRET_KEY env var instead.",
        )
        .to_api_error()),
        Err(e) => Err(e.to_api_error()),
    }
}

fn put_integration_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Set/rotate the Stripe secret(s) + price mapping (encrypted at rest; blank \
             field ⇒ unchanged). Returns the masked view.",
        )
        .id("Admin.putBillingIntegration")
        .tag("admin")
        .response::<200, Json<BillingIntegrationView>>()
        .response_with::<400, (), _>(|r| r.description("At-rest encryption not configured"))
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<403, (), _>(|r| r.description("Requires billing::admin"))
}

/// `POST /api/admin/billing/integration/test` (#60): validate the STORED (or a just-
/// submitted, un-persisted) Stripe key with ONE lightweight call. Returns `{ok,message}`
/// — NEVER the key. An unconfigured key is a clean `ok:false`, not a 500.
async fn test_integration(
    _scope: AdminBillingIntegrationScope,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<TestConnectionRequest>,
) -> ApiResult<Json<TestConnectionResponse>> {
    // Prefer a just-typed candidate (tested WITHOUT storing); else the resolved key.
    let candidate = req
        .stripe_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let resp = match candidate {
        Some(key) => {
            StripeClient::new(client::stripe_base_url(), key)
                .check_connection()
                .await
        }
        None => match StripeClient::resolve(&pool).await {
            Ok(c) => c.check_connection().await,
            // No key configured at all → a clean ok:false, never a 500 leak.
            Err(_) => TestConnectionResponse {
                ok: false,
                message: "No Stripe secret is configured to test.".to_string(),
            },
        },
    };
    Ok((StatusCode::OK, Json(resp)))
}

fn test_integration_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Validate the stored (or a just-submitted) Stripe secret with one lightweight \
             call. Returns {ok,message} — never the key.",
        )
        .id("Admin.testBillingIntegration")
        .tag("admin")
        .response::<200, Json<TestConnectionResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<403, (), _>(|r| r.description("Requires billing::admin"))
}

/// The `/api/admin/billing/integration*` routes. Mounted by the billing module when
/// `secrets.storage_key` is configured (so an admin can bootstrap the first config),
/// INDEPENDENT of the §16 env kill-switch (DEC-3).
pub fn integration_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/admin/billing/integration",
            get_with(get_integration, get_integration_docs)
                .put_with(put_integration, put_integration_docs),
        )
        .api_route(
            "/admin/billing/integration/test",
            post_with(test_integration, test_integration_docs),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    // last4 is UTF-8-safe and shows only the tail (never the whole key).
    #[test]
    fn last4_shows_tail_only() {
        assert_eq!(last4_of("sk_live_abcd1234"), "1234");
        assert_eq!(last4_of("ab"), "ab");
        assert_eq!(last4_of(""), "");
    }
}
