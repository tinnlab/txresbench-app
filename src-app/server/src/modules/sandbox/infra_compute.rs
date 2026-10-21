//! Admin compute-backend config (#63) — the deployment-level, ENCRYPTED-at-rest
//! config + test-connection for the Kubernetes `ComputeBackend`.
//!
//! SECURITY (the #60 no-leak contract, mirrored from `billing/integration.rs`):
//!  - The kubeconfig + cluster bearer-token are stored ENCRYPTED (`bytea` ciphertext
//!    via `ziee_framework::secret::encrypt_secret`, pgcrypto), NEVER plaintext
//!    (INV-1). The GET returns a MASKED view only — no secret field (INV-2).
//!  - Any in-memory secret is wrapped in `SecretView<String>` at the boundary (INV-3).
//!  - The Test action builds a `kube::Client` from the resolved (or a just-typed)
//!    kubeconfig (else ambient `KUBECONFIG`/in-cluster) and does a trivial reachability
//!    call (list nodes, capped). It returns `{ok,message}` from a PURE classifier that
//!    emits a fixed-vocabulary message and NEVER echoes the raw error/secret (INV-4).
//!  - `#[cfg(feature = "saas")]` (the whole module) + gated on `infra::settings::manage`.
//!
//! Namespace + worker-image are read-at-use by `KubernetesBackend` (DB row layered over
//! env, INV-5), so a PUT takes effect on the next job launch. Live cluster AUTH uses
//! ambient `KUBECONFIG`/in-cluster (env fallback); the stored kubeconfig/token drive the
//! test-connection probe (the stored kubeconfig for live launch is DEC-9 [DESCOPED]).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::{ApiResult, AppError};
use ziee_framework::secret::{encrypt_secret, resolve_optional_secret, SecretView};

use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::workstore::permissions::InfraSettingsManage;

// ───────────────────────────── DTOs ─────────────────────────────

/// The MASKED read view (GET response). NO plaintext secret — only whether each
/// credential is configured, the last-4 of the token, the non-secret config, and the source.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct InfraComputeView {
    /// Effective backend selection: `"local"` or `"kubernetes"`.
    pub backend: String,
    /// Cluster API endpoint (display only). Not a secret.
    pub cluster_endpoint: String,
    /// Effective Kubernetes namespace.
    pub namespace: String,
    /// Effective worker/job image.
    pub worker_image: String,
    /// True when a kubeconfig is stored (encrypted).
    pub kubeconfig_configured: bool,
    /// True when a cluster token is stored (encrypted).
    pub token_configured: bool,
    /// The last 4 chars of the stored token (display only), or `None`. NEVER the full token.
    pub token_last4: Option<String>,
    /// Where the effective config comes from: `"database"`, `"environment"`, or
    /// `"unconfigured"`. An operator status, never a value.
    pub status: String,
}

/// PUT request: set/rotate the config. A blank/absent secret ⇒ leave it unchanged. No
/// `Debug` derive: carries the plaintext kubeconfig/token (coding-guidelines §3).
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateInfraComputeRequest {
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub cluster_endpoint: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub worker_image: Option<String>,
    /// A NEW kubeconfig to store (encrypted). Absent/blank ⇒ unchanged.
    #[serde(default)]
    pub kubeconfig: Option<String>,
    /// A NEW cluster token to store (encrypted). Absent/blank ⇒ unchanged.
    #[serde(default)]
    pub token: Option<String>,
}

impl UpdateInfraComputeRequest {
    pub fn kubeconfig_to_store(&self) -> Option<&str> {
        self.kubeconfig.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
    pub fn token_to_store(&self) -> Option<&str> {
        self.token.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}

/// POST /test request: optionally override the kubeconfig with a just-typed candidate
/// (tested WITHOUT persisting); else the stored kubeconfig / ambient config. No `Debug`
/// derive (carries a plaintext kubeconfig candidate — coding-guidelines §3).
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct TestComputeRequest {
    #[serde(default)]
    pub kubeconfig: Option<String>,
}

/// POST /test response. Generic operator-facing message — NEVER the secret or raw error.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ComputeTestResponse {
    pub ok: bool,
    pub message: String,
}

// ───────────────────────────── masking ─────────────────────────────

fn last4_of(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let start = chars.len().saturating_sub(4);
    chars[start..].iter().collect()
}

// ───────────────────────────── repository ─────────────────────────────

#[derive(Debug, Clone)]
pub struct InfraComputeRow {
    pub backend: Option<String>,
    pub cluster_endpoint: Option<String>,
    pub namespace: Option<String>,
    pub worker_image: Option<String>,
    pub kubeconfig_ciphertext: Option<Vec<u8>>,
    pub token_ciphertext: Option<Vec<u8>>,
}

pub async fn get_row(pool: &PgPool) -> Result<InfraComputeRow, AppError> {
    let row = sqlx::query!(
        r#"SELECT backend, cluster_endpoint, namespace, worker_image,
                  kubeconfig_ciphertext, token_ciphertext
           FROM infra_compute WHERE singleton = true"#,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(InfraComputeRow {
        backend: row.backend,
        cluster_endpoint: row.cluster_endpoint,
        namespace: row.namespace,
        worker_image: row.worker_image,
        kubeconfig_ciphertext: row.kubeconfig_ciphertext,
        token_ciphertext: row.token_ciphertext,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_row(
    pool: &PgPool,
    backend: Option<String>,
    cluster_endpoint: Option<String>,
    namespace: Option<String>,
    worker_image: Option<String>,
    kubeconfig_ciphertext: Option<Vec<u8>>,
    token_ciphertext: Option<Vec<u8>>,
    updated_by: Uuid,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE infra_compute
           SET backend               = COALESCE($1, backend),
               cluster_endpoint      = COALESCE($2, cluster_endpoint),
               namespace             = COALESCE($3, namespace),
               worker_image          = COALESCE($4, worker_image),
               kubeconfig_ciphertext = COALESCE($5, kubeconfig_ciphertext),
               token_ciphertext      = COALESCE($6, token_ciphertext),
               updated_by            = $7,
               updated_at            = now()
           WHERE singleton = true"#,
        backend,
        cluster_endpoint,
        namespace,
        worker_image,
        kubeconfig_ciphertext,
        token_ciphertext,
        updated_by,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

// ───────────────────────────── effective config (INV-5) ─────────────────────────────

/// Read-at-use: the effective (namespace, worker_image) from the DB row layered over
/// the supplied env defaults. Used by `KubernetesBackend` at launch, so a PUT takes
/// effect on the next job without a restart. A DB error degrades to the env values.
pub async fn effective_namespace_image(
    pool: &PgPool,
    env_namespace: &str,
    env_image: &str,
) -> (String, String) {
    let Ok(row) = get_row(pool).await else {
        return (env_namespace.to_string(), env_image.to_string());
    };
    let ns = row
        .namespace
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| env_namespace.to_string());
    let img = row
        .worker_image
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| env_image.to_string());
    (ns, img)
}

/// The effective compute backend selection: DB `backend` else env
/// (`CYTO_COMPUTE_BACKEND`, defaulting to `local`). Pure over the two inputs.
pub(crate) fn merge_compute_backend(env_backend: Option<&str>, db: Option<&str>) -> String {
    match db.map(str::trim).filter(|s| !s.is_empty()) {
        Some("kubernetes") | Some("k8s") => "kubernetes".to_string(),
        Some("local") => "local".to_string(),
        _ => match env_backend.map(str::trim).filter(|s| !s.is_empty()) {
            Some("kubernetes") | Some("k8s") => "kubernetes".to_string(),
            _ => "local".to_string(),
        },
    }
}

/// The effective compute backend string (DB row layered over env): `"local"` | `"kubernetes"`.
/// The coupling-matrix input (#61 INV-1) — used by the object-store PUT and this module's PUT.
pub async fn effective_backend(pool: &PgPool) -> String {
    let env_backend = std::env::var("CYTO_COMPUTE_BACKEND").ok();
    let row = get_row(pool).await.ok();
    merge_compute_backend(
        env_backend.as_deref(),
        row.as_ref().and_then(|r| r.backend.as_deref()),
    )
}

// ───────────────────────────── masked view ─────────────────────────────

pub async fn build_view(pool: &PgPool) -> InfraComputeView {
    let env_ns = std::env::var("CYTO_K8S_NAMESPACE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let env_img = std::env::var("CYTO_WORKER_IMAGE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "cytoanalyst-worker:latest".to_string());
    let env_backend = std::env::var("CYTO_COMPUTE_BACKEND").ok();

    let row = get_row(pool).await.ok();
    let backend = merge_compute_backend(
        env_backend.as_deref(),
        row.as_ref().and_then(|r| r.backend.as_deref()),
    );
    let namespace = row
        .as_ref()
        .and_then(|r| r.namespace.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(env_ns);
    let worker_image = row
        .as_ref()
        .and_then(|r| r.worker_image.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(env_img);
    let cluster_endpoint = row
        .as_ref()
        .and_then(|r| r.cluster_endpoint.clone())
        .unwrap_or_default();

    // Resolve the stored token → last4 via a SecretView boundary (never returned).
    let token_plain = match row.as_ref().and_then(|r| r.token_ciphertext.clone()) {
        Some(ct) => resolve_optional_secret(pool, Some(ct), None).await,
        None => None,
    };
    let (token_last4, token_configured) = match token_plain {
        Some(t) => {
            let sv = SecretView::new(t);
            (Some(last4_of(sv.expose_secret())), true)
        }
        None => (None, false),
    };
    // `configured` is derived from DECRYPT SUCCESS (mirroring the token above + the
    // object-store surface), not raw ciphertext presence — so an undecryptable
    // kubeconfig (wrong key after a rotation) degrades to `false`, never a false
    // "configured". `resolve_optional_secret` returns `None` on a decrypt failure.
    let kubeconfig_configured = match row.as_ref().and_then(|r| r.kubeconfig_ciphertext.clone()) {
        Some(ct) => resolve_optional_secret(pool, Some(ct), None).await.is_some(),
        None => false,
    };

    let status = if row.as_ref().and_then(|r| r.backend.as_deref()).is_some()
        || kubeconfig_configured
        || token_configured
    {
        "database"
    } else if std::env::var("KUBECONFIG").ok().filter(|s| !s.is_empty()).is_some() {
        "environment"
    } else {
        "unconfigured"
    };

    InfraComputeView {
        backend,
        cluster_endpoint,
        namespace,
        worker_image,
        kubeconfig_configured,
        token_configured,
        token_last4,
        status: status.to_string(),
    }
}

// ───────────────────────────── test-connection ─────────────────────────────

/// PURE classifier: map a probe outcome to `{ok,message}`. A failure emits a
/// FIXED-VOCABULARY category derived from the error KIND — it NEVER echoes the raw
/// error or any credential (INV-4). Only the derived category is logged server-side; the
/// raw error is DISCARDED, never logged or returned.
pub fn classify_compute_test(outcome: Result<(), String>) -> ComputeTestResponse {
    match outcome {
        Ok(()) => ComputeTestResponse {
            ok: true,
            message: "Connection succeeded: reached the cluster API and listed nodes.".to_string(),
        },
        Err(reason) => ComputeTestResponse {
            ok: false,
            message: format!("Connection failed — {}.", failure_category(&reason)),
        },
    }
}

fn failure_category(reason: &str) -> &'static str {
    let r = reason.to_ascii_lowercase();
    if r.contains("401") || r.contains("403") || r.contains("unauthorized") || r.contains("forbidden") {
        "authentication rejected (check the kubeconfig / token)"
    } else if r.contains("parse") || r.contains("yaml") || r.contains("invalid") || r.contains("deserialize") {
        "kubeconfig is not valid (check the pasted YAML)"
    } else if r.contains("timed out") || r.contains("timeout") {
        "connection timed out (check the cluster endpoint and network)"
    } else if r.contains("dns")
        || r.contains("resolve")
        || r.contains("connection refused")
        || r.contains("connect")
        || r.contains("no route")
    {
        "cluster endpoint unreachable (check the API server URL)"
    } else {
        "check the kubeconfig, cluster endpoint, and token"
    }
}

/// Build a `kube::Client` from a candidate kubeconfig (else ambient) and do a trivial
/// capped reachability call (list nodes). saas-only (the `kube` crate is saas-only).
async fn probe_compute(kubeconfig: Option<&str>) -> Result<(), String> {
    use k8s_openapi::api::core::v1::Node;
    use kube::api::ListParams;
    use kube::config::{Kubeconfig, KubeConfigOptions};
    use kube::{Api, Client, Config};

    let client = match kubeconfig.map(str::trim).filter(|s| !s.is_empty()) {
        Some(yaml) => {
            let kc = Kubeconfig::from_yaml(yaml).map_err(|e| e.to_string())?;
            let cfg = Config::from_custom_kubeconfig(kc, &KubeConfigOptions::default())
                .await
                .map_err(|e| e.to_string())?;
            Client::try_from(cfg).map_err(|e| e.to_string())?
        }
        None => Client::try_default().await.map_err(|e| e.to_string())?,
    };
    let nodes: Api<Node> = Api::all(client);
    nodes
        .list(&ListParams::default().limit(1))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────────────────── handlers ─────────────────────────────

async fn get_compute(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<InfraComputeView>> {
    Ok((StatusCode::OK, Json(build_view(&pool).await)))
}

fn get_compute_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.getInfraCompute")
        .tag("admin")
        .summary("Read the masked compute backend config (no plaintext secret).")
        .response::<200, Json<InfraComputeView>>()
}

async fn put_compute(
    auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<UpdateInfraComputeRequest>,
) -> ApiResult<Json<InfraComputeView>> {
    // COUPLING GUARD (#61 INV-1): refuse a PUT selecting a compute backend INCOMPATIBLE with
    // the effective object store BEFORE persisting. The invalid pairing is remote (kubernetes)
    // compute + a Local object store. The prospective compute backend is this PUT's override
    // else the stored/env one.
    {
        let env_backend = std::env::var("CYTO_COMPUTE_BACKEND").ok();
        let current = get_row(&pool).await.ok();
        let prospective = merge_compute_backend(
            env_backend.as_deref(),
            req.backend
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or(current.as_ref().and_then(|r| r.backend.as_deref())),
        );
        let compute = crate::modules::workstore::backend_compat::ComputeKind::from_backend_str(&prospective);
        let store = crate::modules::workstore::infra_object_store::effective_backend(&pool)
            .await
            .map_err(|e| e.to_api_error())?;
        crate::modules::workstore::backend_compat::check_backend_compat_api(compute, store)
            .map_err(|e| e.to_api_error())?;
    }
    let storage_key = ziee_framework::secrets::storage_key();
    let kubeconfig_ct = match req.kubeconfig_to_store() {
        Some(p) => Some(encrypt_or_refuse(&pool, p, storage_key).await?),
        None => None,
    };
    let token_ct = match req.token_to_store() {
        Some(p) => Some(encrypt_or_refuse(&pool, p, storage_key).await?),
        None => None,
    };
    let non_empty = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    upsert_row(
        &pool,
        non_empty(req.backend),
        non_empty(req.cluster_endpoint),
        non_empty(req.namespace),
        non_empty(req.worker_image),
        kubeconfig_ct,
        token_ct,
        auth.user.id,
    )
    .await
    .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(build_view(&pool).await)))
}

fn put_compute_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.putInfraCompute")
        .tag("admin")
        .summary("Set/rotate the compute backend config (secrets encrypted at rest).")
        .response::<200, Json<InfraComputeView>>()
        .response_with::<400, (), _>(|r| r.description("At-rest encryption not configured"))
}

async fn test_compute(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<TestComputeRequest>,
) -> ApiResult<Json<ComputeTestResponse>> {
    // Effective backend: if Local, nothing remote to test.
    let env_backend = std::env::var("CYTO_COMPUTE_BACKEND").ok();
    let row = get_row(&pool).await.ok();
    let backend = merge_compute_backend(
        env_backend.as_deref(),
        row.as_ref().and_then(|r| r.backend.as_deref()),
    );
    if backend == "local" {
        return Ok((
            StatusCode::OK,
            Json(ComputeTestResponse {
                ok: true,
                message: "Using the local compute backend; no cluster to test.".to_string(),
            }),
        ));
    }

    // Candidate kubeconfig (un-persisted) else the stored one else ambient.
    let candidate = req.kubeconfig.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let stored = match row.as_ref().and_then(|r| r.kubeconfig_ciphertext.clone()) {
        Some(ct) => resolve_optional_secret(&pool, Some(ct), None).await,
        None => None,
    };
    let kubeconfig: Option<String> = candidate.map(str::to_string).or(stored);

    let outcome = probe_compute(kubeconfig.as_deref()).await;
    if let Err(ref reason) = outcome {
        tracing::warn!(category = failure_category(reason), "compute test-connection failed");
    }
    Ok((StatusCode::OK, Json(classify_compute_test(outcome))))
}

fn test_compute_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.testInfraCompute")
        .tag("admin")
        .summary("Test the compute cluster connection (list nodes). Returns {ok,message}.")
        .response::<200, Json<ComputeTestResponse>>()
}

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
             Cannot store a compute credential; use the KUBECONFIG env var instead.",
        )
        .to_api_error()),
        Err(e) => Err(e.to_api_error()),
    }
}

/// The `/api/admin/infra/compute*` routes (mounted only in a saas binary).
pub fn routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/admin/infra/compute",
            get_with(get_compute, get_compute_docs).put_with(put_compute, put_compute_docs),
        )
        .api_route(
            "/admin/infra/compute/test",
            post_with(test_compute, test_compute_docs),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-2 [covers: ITEM-6]: the masked view serializes with NO secret field.
    #[test]
    fn view_has_no_secret_field() {
        let view = InfraComputeView {
            backend: "kubernetes".into(),
            cluster_endpoint: "https://k8s.example:6443".into(),
            namespace: "cyto".into(),
            worker_image: "cytoanalyst-worker:latest".into(),
            kubeconfig_configured: true,
            token_configured: true,
            token_last4: Some("6789".into()),
            status: "database".into(),
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("\"token_last4\":\"6789\""));
        assert!(!json.contains("ciphertext"));
        assert!(!json.contains("kubeconfig\":"), "kubeconfig plaintext must never appear");
        assert!(!json.to_lowercase().contains("\"token\":"));
    }

    // TEST-4 [covers: ITEM-6]: blank/absent secret ⇒ leave-unchanged (None).
    #[test]
    fn blank_secret_is_leave_unchanged() {
        let absent: UpdateInfraComputeRequest = serde_json::from_str(r#"{"namespace":"x"}"#).unwrap();
        assert!(absent.kubeconfig_to_store().is_none());
        assert!(absent.token_to_store().is_none());

        let blank: UpdateInfraComputeRequest =
            serde_json::from_str(r#"{"kubeconfig":"  ","token":""}"#).unwrap();
        assert!(blank.kubeconfig_to_store().is_none());
        assert!(blank.token_to_store().is_none());

        let set: UpdateInfraComputeRequest =
            serde_json::from_str(r#"{"kubeconfig":" apiVersion: v1 ","token":"tok"}"#).unwrap();
        assert_eq!(set.kubeconfig_to_store(), Some("apiVersion: v1"));
        assert_eq!(set.token_to_store(), Some("tok"));
    }

    // TEST-6 [covers: ITEM-8] [invariant: INV-4]: the classifier maps Ok/Err → {ok,message}
    // and the failure message NEVER contains the raw error or any credential.
    #[test]
    fn classifier_never_leaks_the_secret_or_raw_error() {
        assert!(classify_compute_test(Ok(())).ok);

        let leaky = "Unauthorized: token=eyJhbGvery-secret-token bearer sneaky";
        let bad = classify_compute_test(Err(leaky.to_string()));
        assert!(!bad.ok);
        assert!(!bad.message.contains("eyJhbGvery-secret-token"), "token leaked: {}", bad.message);
        assert!(!bad.message.contains("sneaky"));
        assert!(bad.message.to_lowercase().contains("authentication"));

        let generic = classify_compute_test(Err("weird thing plugh".to_string()));
        assert!(!generic.message.contains("plugh"));
    }

    // TEST-9 (merge half) [covers: ITEM-9]: DB backend wins over env; both default local.
    #[test]
    fn merge_compute_backend_prefers_db_then_env() {
        assert_eq!(merge_compute_backend(None, None), "local");
        assert_eq!(merge_compute_backend(Some("kubernetes"), None), "kubernetes");
        assert_eq!(merge_compute_backend(Some("kubernetes"), Some("local")), "local");
        assert_eq!(merge_compute_backend(None, Some("kubernetes")), "kubernetes");
        assert_eq!(merge_compute_backend(Some(""), Some("  ")), "local");
    }
}
