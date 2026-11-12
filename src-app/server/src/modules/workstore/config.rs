//! Workstore config + store-root resolution (ITEM-15).
//!
//! The store root is resolved UNDER `rootfs::data_root()`, which already honors
//! `TXR_APP_DATA_DIR` for per-worktree test isolation (DEC-16 — the exact
//! precedent is `lib.rs`'s `files_root = data_root().join("files")`).
//!
//! It is no longer a bare `.join("workstore")`: that made every server sharing a
//! data root share ONE blob store while holding DIFFERENT catalogs, and the GC
//! sweep unlinks by the complement of its own catalog's keep-set — so booting a
//! second server freed the first one's live blobs. The root is now PARTITIONED
//! by catalog identity (`partition::resolve_owned_root`), which leaves a
//! single-catalog deployment on the identical `<data_root>/workstore` path. See
//! `partition`'s module doc for the full rule.
//!
//! Operational tunables (GC cadence, data-plane caps) live in a `WorkstoreLimits`
//! struct with sane defaults + env overrides (DEC-17). They are a `Limits`-style
//! struct (never inline magic numbers) so promotion to an admin-configurable
//! singleton settings row + the `workstore.*` YAML section is a later,
//! rewrite-free step — deferred because P1 is a foundational kernel that ships
//! BEFORE any admin/config surface exists in the workbench.

use std::path::Path;

use txresbench_core::{AppError, ServerConfig};

use super::partition::{catalog_key, resolve_owned_root, StoreClaim};

/// The `object_store_backend` seam (DEC-10). Only `Local` is built; `s3` is a
/// compiled stub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectStoreKind {
    Local,
    S3,
}

impl ObjectStoreKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ObjectStoreKind::Local => "local-fs",
            ObjectStoreKind::S3 => "s3",
        }
    }
}

/// Which cloud object-store the `S3` backend speaks (T2 / INV-2). Both are reached
/// through the ONE `S3Store` body over the `object_store` crate; they differ only in
/// which crate builder + credential chain is constructed. `Gcs` is the crate's NATIVE
/// `GoogleCloudStorageBuilder` (the genuine GCS JSON API), NOT an S3-interop shim
/// (INV-2 / DEC-2), so it runs unchanged against the floci-gcp emulator and real GCS alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProvider {
    S3,
    Gcs,
}

impl CloudProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            CloudProvider::S3 => "s3",
            CloudProvider::Gcs => "gcs",
        }
    }
}

/// Connection config for the cloud `S3` backend (ITEM-4). Resolved from env when
/// `TXR_WORKSTORE_BACKEND=s3`. Credentials default to the cloud's **ambient identity**
/// (IRSA / Workload-Identity / ADC — no static key), with static creds honored for the
/// emulator/test path (PROV-T1-4). The loopback `endpoint` override is a **debug-only
/// test seam** (DEC-3): `resolve_for` reads `S3_ENDPOINT` / `STORAGE_EMULATOR_HOST` only
/// under `#[cfg(debug_assertions)]`, so a release binary cannot be redirected at a
/// loopback store.
#[derive(Clone)]
pub struct S3ConnConfig {
    pub provider: CloudProvider,
    pub bucket: String,
    pub region: String,
    /// Endpoint override (floci/R2 for S3, floci-gcp for GCS). `None` ⇒ the provider's
    /// real public endpoint. Populated from env only in debug builds (DEC-3).
    pub endpoint: Option<String>,
    /// Static access key — the emulator/test path only. `None` ⇒ ambient identity.
    pub access_key_id: Option<String>,
    /// Static secret — the emulator/test path only. `None` ⇒ ambient identity.
    pub secret_access_key: Option<String>,
    /// Path-style addressing (floci/R2 need it; real AWS uses virtual-hosted). S3 only.
    pub path_style: bool,
    /// Switch a `put` to `put_multipart` at/above this many bytes (DEC-4). Env override.
    pub multipart_threshold: usize,
    /// Multipart part size (DEC-4: 8 MiB default). Clamped ≥ 5 MiB (the S3 minimum for a
    /// non-final part). Env override.
    pub part_size: usize,
}

/// Hand-written, REDACTING `Debug` (coding-guidelines §3): `S3ConnConfig` holds a plaintext
/// `access_key_id` / `secret_access_key`, and it is reachable via `WorkstoreConfig`'s derived
/// `Debug`, so a `{:?}` of the boot config must never print the credentials. Only their
/// presence is shown.
impl std::fmt::Debug for S3ConnConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3ConnConfig")
            .field("provider", &self.provider)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("endpoint", &self.endpoint)
            .field(
                "access_key_id",
                &self.access_key_id.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "secret_access_key",
                &self.secret_access_key.as_ref().map(|_| "<redacted>"),
            )
            .field("path_style", &self.path_style)
            .field("multipart_threshold", &self.multipart_threshold)
            .field("part_size", &self.part_size)
            .finish()
    }
}

/// Default: switch to multipart above 16 MiB (two 8 MiB parts) — DEC-4.
const DEFAULT_MULTIPART_THRESHOLD: usize = 16 * 1024 * 1024;
const DEFAULT_PART_SIZE: usize = 8 * 1024 * 1024;
/// S3's hard minimum for any part but the last.
const MIN_PART_SIZE: usize = 5 * 1024 * 1024;

/// The loopback endpoint-override seam (DEC-3), mirroring `sandbox/env_image.rs`
/// `EnvImageSeams`: the override value is honored under `#[cfg(debug_assertions)]` and
/// **ignored in a release build**, so a release binary cannot be pointed at a loopback
/// object store by an env var. The `raw` value is read from env by the caller; this
/// function decides whether a build is *allowed* to honor it.
fn endpoint_seam(raw: Option<String>) -> Option<String> {
    #[cfg(debug_assertions)]
    {
        raw.filter(|s| !s.is_empty())
    }
    #[cfg(not(debug_assertions))]
    {
        // The only reader is compiled out in release: the override is inert.
        let _ = raw;
        None
    }
}

impl S3ConnConfig {
    /// Resolve S3/GCS connection config from env. Provider defaults to S3; set
    /// `TXR_WORKSTORE_CLOUD=gcs` for the native-GCS backend. The loopback endpoint
    /// override is honored only in debug builds (DEC-3 / [`endpoint_seam`]).
    pub fn from_env() -> Self {
        let provider = match std::env::var("TXR_WORKSTORE_CLOUD").as_deref() {
            Ok("gcs") | Ok("gcp") => CloudProvider::Gcs,
            _ => CloudProvider::S3,
        };
        // Each provider reads ITS OWN endpoint var; both are debug-only seams.
        let endpoint = match provider {
            CloudProvider::S3 => endpoint_seam(env_opt("S3_ENDPOINT")),
            CloudProvider::Gcs => endpoint_seam(env_opt("STORAGE_EMULATOR_HOST")),
        };
        let path_style = env_bool("TXR_WORKSTORE_S3_PATH_STYLE")
            // floci/R2 (an endpoint override present) need path-style; real AWS uses
            // virtual-hosted. Default follows the endpoint's presence.
            .unwrap_or(endpoint.is_some());
        Self {
            provider,
            bucket: env_opt("TXR_WORKSTORE_S3_BUCKET").unwrap_or_default(),
            region: env_opt("AWS_REGION").unwrap_or_else(|| "us-east-1".to_string()),
            endpoint,
            access_key_id: env_opt("AWS_ACCESS_KEY_ID"),
            secret_access_key: env_opt("AWS_SECRET_ACCESS_KEY"),
            path_style,
            multipart_threshold: env_usize("TXR_WORKSTORE_S3_MULTIPART_THRESHOLD")
                .unwrap_or(DEFAULT_MULTIPART_THRESHOLD),
            part_size: env_usize("TXR_WORKSTORE_S3_PART_SIZE")
                .map(|p| p.max(MIN_PART_SIZE))
                .unwrap_or(DEFAULT_PART_SIZE),
        }
    }
}

/// Operational tunables. Defaults are safe; each has an env override so a test /
/// operator can adjust without a rebuild. Promotable to an admin settings row.
#[derive(Debug, Clone)]
pub struct WorkstoreLimits {
    /// Enable the standing blob-GC union sweep.
    pub gc_enabled: bool,
    /// Sweep cadence in hours (mirrors `mcp/tool_calls/prune.rs`'s ~6h).
    pub gc_interval_hours: u64,
    /// Max rows a table (DE/obs) page may return (bounds the control-plane page).
    /// A generic table-page bound (the bespoke server-paged table wire retired in S5b).
    pub table_page_max: usize,
    /// Max bytes a single Tier-2 slice response may return (footgun guard).
    pub slice_max_bytes: usize,
}

impl Default for WorkstoreLimits {
    fn default() -> Self {
        Self {
            gc_enabled: true,
            gc_interval_hours: 6,
            table_page_max: 500,
            slice_max_bytes: 256 * 1024 * 1024,
        }
    }
}

impl WorkstoreLimits {
    /// Resolve from env overrides, falling back to defaults (bounds-clamped).
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            gc_enabled: env_bool("TXR_WORKSTORE_GC_ENABLED").unwrap_or(d.gc_enabled),
            gc_interval_hours: env_u64("TXR_WORKSTORE_GC_INTERVAL_HOURS")
                .map(|h| h.clamp(1, 24 * 30))
                .unwrap_or(d.gc_interval_hours),
            table_page_max: d.table_page_max,
            slice_max_bytes: d.slice_max_bytes,
        }
    }
}

/// Resolved config the boot path consumes.
#[derive(Debug, Clone)]
pub struct WorkstoreConfig {
    /// The store root TOGETHER with the catalog key that owns it. They travel as
    /// one value on purpose: a root without the identity of the catalog entitled
    /// to sweep it is exactly the state that lost data.
    pub claim: StoreClaim,
    pub backend: ObjectStoreKind,
    pub limits: WorkstoreLimits,
    /// Cloud connection config, resolved when `backend == S3`; `None` for `Local`
    /// (ITEM-4). Carried on the config so `init_working_store` constructs the S3
    /// backend without re-reading env (PROV-T2-3).
    pub s3: Option<S3ConnConfig>,
}

impl WorkstoreConfig {
    /// The store root (convenience — `self.claim.root`).
    pub fn root(&self) -> &Path {
        self.claim.root()
    }

    /// Resolve the store root under the app-data dir (honors `TXR_APP_DATA_DIR`),
    /// partitioned by the identity of the catalog `config` binds this server to,
    /// + the tunables. `object_store_backend` is `local` unless overridden to a
    /// value we build (only `local` is built).
    ///
    /// A single-catalog deployment resolves to `<data_root>/workstore` exactly as
    /// before — the partitioning only ever diverts a server whose catalog is NOT
    /// the one that owns that directory.
    pub fn resolve_for(config: &ServerConfig) -> Result<Self, AppError> {
        let claim = resolve_owned_root(&crate::modules::rootfs::data_root(), &catalog_key(config));
        // FAIL-CLOSED (#69): an unrecognized TXR_WORKSTORE_BACKEND refuses to boot here rather
        // than silently resolving to Local. An unset var is Ok(Local) (INV-5 byte-identity).
        let backend = backend_from_env(std::env::var("TXR_WORKSTORE_BACKEND").ok().as_deref())?;
        // Resolve cloud connection config only when the S3 backend is selected.
        let s3 = match backend {
            ObjectStoreKind::S3 => Some(S3ConnConfig::from_env()),
            ObjectStoreKind::Local => None,
        };
        Ok(Self {
            claim,
            backend,
            limits: WorkstoreLimits::from_env(),
            s3,
        })
    }

    /// Resolve the effective config from an admin DB override layered over env (#63,
    /// INV-5). Identical to [`Self::resolve_for`] except the backend selection + each
    /// `S3ConnConfig` field may be overridden by the (already-decrypted) DB row. An
    /// EMPTY override (`db.is_empty()`) yields byte-identical output to `resolve_for`
    /// (compat mode), so an unconfigured deployment is unchanged. The store is built
    /// from this at boot (`lib.rs`), so a PUT takes effect at the construction seam.
    pub fn resolve_with_db(config: &ServerConfig, db: &ObjectStoreDbConfig) -> Result<Self, AppError> {
        let claim = resolve_owned_root(&crate::modules::rootfs::data_root(), &catalog_key(config));
        let (backend, s3) = resolve_backend_and_s3(db)?;
        Ok(Self {
            claim,
            backend,
            limits: WorkstoreLimits::from_env(),
            s3,
        })
    }
}

/// Resolve just the effective backend + S3 connection from a DB override layered over
/// env — WITHOUT the store root / catalog identity (which needs `ServerConfig`). The
/// admin masked-view + test-connection paths use this (they never touch the store
/// root); the boot path uses [`WorkstoreConfig::resolve_with_db`] which layers the
/// claim on top. Byte-identical to env when `db.is_empty()` (INV-5).
pub fn resolve_backend_and_s3(
    db: &ObjectStoreDbConfig,
) -> Result<(ObjectStoreKind, Option<S3ConnConfig>), AppError> {
    // FAIL-CLOSED (#69): a bad env backend errors here too, so no admin/boot path that layers a
    // DB row over env can silently fall back to Local on a mis-set var.
    let env_backend = backend_from_env(std::env::var("TXR_WORKSTORE_BACKEND").ok().as_deref())?;
    let backend = merge_backend(env_backend, db.backend.as_deref())?;
    let s3 = match backend {
        ObjectStoreKind::S3 => Some(merge_s3_conn(S3ConnConfig::from_env(), db)),
        ObjectStoreKind::Local => None,
    };
    Ok((backend, s3))
}

/// The backend selector — pure, so the `TXR_WORKSTORE_BACKEND` mapping is unit-testable
/// without touching process env (which is global + racy under parallel tests).
///
/// FAIL-CLOSED (#69, INV-4): an UNSET (or blank) value is the default `Local`; `s3` selects
/// the cloud backend; an explicit `local`/`local-fs` is `Local` too. ANY OTHER value is
/// REFUSED with an error — it does NOT silently degrade to `Local`. A deployment that
/// mis-sets the backend (the intuitive-but-wrong `TXR_WORKSTORE_BACKEND=gcs`, a typo like
/// `S3`) must refuse to boot rather than quietly run on the pod's ephemeral local disk and
/// lose data on pod death — the same principle by which a weak `jwt.secret` refuses boot.
///
/// Whitespace/case (DEC-1): surrounding whitespace is TRIMMED, then the token is matched
/// CASE-SENSITIVELY. So `"s3 "` ⇒ `S3` (whitespace forgiven for a valid token) but `"S3"` /
/// `"S3 "` ⇒ error (wrong case is the mis-set class #69 surfaces). The PROVIDER (s3 vs the
/// native GCS backend) is chosen by `TXR_WORKSTORE_CLOUD`, never by this var.
pub(crate) fn backend_from_env(raw: Option<&str>) -> Result<ObjectStoreKind, AppError> {
    match raw.map(str::trim) {
        None | Some("") => Ok(ObjectStoreKind::Local),
        Some(token) => parse_backend_token(token).map_err(|bad| {
            AppError::internal_error(format!(
                "TXR_WORKSTORE_BACKEND='{bad}' is not a recognized object-store backend. \
                 The cloud PROVIDER is chosen by TXR_WORKSTORE_CLOUD, not by this var — e.g. for \
                 native GCS set TXR_WORKSTORE_BACKEND=s3 together with TXR_WORKSTORE_CLOUD=gcs. \
                 Valid TXR_WORKSTORE_BACKEND values: unset | {VALID_BACKEND_TOKENS}."
            ))
        }),
    }
}

/// The recognized backend TOKENS, as the single human-facing string shared by every
/// "not recognized" error (env selector, admin validator, override merge) — so the valid
/// set is single-sourced in COPY as well as in [`parse_backend_token`]'s match, and the
/// three messages cannot drift apart (#70 audit AUDIT_ROUND-1, design-conformance). The
/// env message prepends `unset | ` because an unset env var means Local; the admin field
/// omits it because an absent field means "leave unchanged", not Local.
const VALID_BACKEND_TOKENS: &str = "local | local-fs | s3";

/// The ONE classifier for the recognized object-store backend token set — the single
/// source of truth shared by the env selector ([`backend_from_env`], #69), the admin
/// PUT validator ([`validate_admin_backend`], #70) and the admin-override merge
/// ([`merge_backend`], #70). Given an ALREADY-TRIMMED, NON-EMPTY token, returns the
/// [`ObjectStoreKind`] for a recognized value or `Err(the bad token)` for anything else.
///
/// The set is `{s3, local, local-fs}`, matched CASE-SENSITIVELY (DEC-1) — so `"S3"` /
/// `"Local"` are unrecognized (the mis-set class #69/#70 surface). Each caller decides
/// how absent/blank is treated (env ⇒ `Local`; admin ⇒ leave unchanged) and wraps the
/// `Err` into its own error at its own status (env/boot: refuse-to-boot 500; admin PUT:
/// 422). DRYing this one recognized set is what keeps the env and admin footguns from
/// drifting apart. Pure — no env, no DB.
fn parse_backend_token(token: &str) -> Result<ObjectStoreKind, &str> {
    match token {
        "s3" => Ok(ObjectStoreKind::S3),
        "local" | "local-fs" => Ok(ObjectStoreKind::Local),
        other => Err(other),
    }
}

/// Validate an admin-supplied object-store `backend` override at the PUT boundary (#70,
/// the saas sibling of #69's env fix). Absent/blank ⇒ `Ok(None)` — leave the stored
/// value unchanged / fall through to env. A recognized token ⇒ `Ok(Some(kind))`. An
/// UNRECOGNIZED value is REFUSED with a clean **422** (`UNPROCESSABLE_ENTITY`) whose
/// message names the bad value + the valid set + the provider hint — so a mis-typed
/// backend (e.g. `gcs`, a typo) can NEVER be persisted and later silently resolve to the
/// local-fs store (the #69 data-loss hazard, on the admin-override path).
///
/// Trim-then-case-sensitive, identical policy to the env selector (DEC-1), via the shared
/// [`parse_backend_token`]. The 422 message carries only the offending backend TOKEN — no
/// secret, no endpoint (coding-guidelines §3). Pure — no env, no DB.
pub fn validate_admin_backend(raw: Option<&str>) -> Result<Option<ObjectStoreKind>, AppError> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(token) => parse_backend_token(token).map(Some).map_err(|bad| {
            AppError::unprocessable_entity(
                "INVALID_OBJECT_STORE_BACKEND",
                format!(
                    "backend='{bad}' is not a recognized object-store backend. \
                     Valid backend values: {VALID_BACKEND_TOKENS}. The cloud PROVIDER \
                     (s3 vs gcs) is chosen by TXR_WORKSTORE_CLOUD / the provider field, \
                     not by this field."
                ),
            )
        }),
    }
}

// ───────────────────── admin DB config overrides (#63) ─────────────────────
//
// The admin infra config surface (`modules/workstore/infra_object_store.rs`,
// saas-only) reads a singleton DB row and layers it over the env resolution
// below. The DB->env MERGE is kept PURE here (profile-agnostic, no DB, no
// process env) so it is unit-testable without races (TEST-8), and so INV-5
// (byte-identical when unconfigured) is provable field-by-field: a fully-empty
// override yields exactly `from_env` / `resolve_for`.

/// Object-store config sourced from the admin DB row. Every field is `Option`:
/// `None` ⇒ fall back to the env value. Secrets arrive ALREADY DECRYPTED (the
/// saas repository layer decrypts via `resolve_optional_secret`); this struct
/// never holds ciphertext.
///
/// Hand-written REDACTING `Debug` (coding-guidelines §3, mirroring `S3ConnConfig`):
/// this struct holds the DECRYPTED `access_key_id`/`secret_access_key`, so a
/// `{:?}` must never print them — only their presence.
#[derive(Clone, Default)]
pub struct ObjectStoreDbConfig {
    /// `"local"` | `"s3"`. `None` ⇒ env `TXR_WORKSTORE_BACKEND`.
    pub backend: Option<String>,
    /// `"s3"` | `"gcs"`. `None` ⇒ env provider.
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub path_style: Option<bool>,
    /// Decrypted static access key (`None` ⇒ env / ambient identity).
    pub access_key_id: Option<String>,
    /// Decrypted static secret key (`None` ⇒ env / ambient identity).
    pub secret_access_key: Option<String>,
}

impl std::fmt::Debug for ObjectStoreDbConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObjectStoreDbConfig")
            .field("backend", &self.backend)
            .field("provider", &self.provider)
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("path_style", &self.path_style)
            .field("access_key_id", &self.access_key_id.as_ref().map(|_| "<redacted>"))
            .field(
                "secret_access_key",
                &self.secret_access_key.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl ObjectStoreDbConfig {
    /// True when the row carries no configuration at all — the compat/unconfigured
    /// state where the effective config MUST be byte-identical to env-only (INV-5).
    pub fn is_empty(&self) -> bool {
        self.backend.is_none()
            && self.provider.is_none()
            && self.endpoint.is_none()
            && self.bucket.is_none()
            && self.region.is_none()
            && self.path_style.is_none()
            && self.access_key_id.is_none()
            && self.secret_access_key.is_none()
    }
}

/// Map the DB `backend` override string over the env-resolved kind: an explicit
/// recognized token in the row wins; absent/blank ⇒ the env value (INV-4/INV-5).
///
/// FAIL-CLOSED (#70): an UNRECOGNIZED stored value is REFUSED (`Err`), never passed
/// through as `env_backend` — that `_ => env_backend` was the #69 silent-fall-to-Local
/// class on the admin-override layer. This is defense-in-depth: the admin PUT boundary
/// already rejects a bad value with a 422 ([`validate_admin_backend`]) so it can never be
/// persisted; if a bad value somehow reaches here (a hand-edited row, a pre-#70 row) boot
/// fails-closed rather than silently resolving to Local. Uses the shared
/// [`parse_backend_token`] so the recognized set matches the env + PUT paths exactly. Pure.
pub(crate) fn merge_backend(
    env_backend: ObjectStoreKind,
    db: Option<&str>,
) -> Result<ObjectStoreKind, AppError> {
    match db.map(str::trim) {
        None | Some("") => Ok(env_backend),
        Some(token) => parse_backend_token(token).map_err(|bad| {
            AppError::internal_error(format!(
                "stored object-store backend='{bad}' is not a recognized value. \
                 Valid backend values: {VALID_BACKEND_TOKENS} (the cloud provider is chosen \
                 separately by TXR_WORKSTORE_CLOUD / the provider field). Fix the admin \
                 object-store configuration."
            ))
        }),
    }
}

/// Layer the DB override over an env-resolved `S3ConnConfig`, field by field: a
/// `Some` DB field replaces the env value, a `None` leaves it. Pure — no env, no
/// DB — so a fully-empty override returns `env` UNCHANGED (INV-5). Static creds are
/// only overridden when supplied (else the env / ambient-identity chain stands).
pub(crate) fn merge_s3_conn(mut env: S3ConnConfig, db: &ObjectStoreDbConfig) -> S3ConnConfig {
    if let Some(p) = db.provider.as_deref().filter(|s| !s.is_empty()) {
        env.provider = match p {
            "gcs" | "gcp" => CloudProvider::Gcs,
            _ => CloudProvider::S3,
        };
    }
    if let Some(ep) = db.endpoint.as_deref().filter(|s| !s.is_empty()) {
        env.endpoint = Some(ep.to_string());
    }
    if let Some(b) = db.bucket.as_deref().filter(|s| !s.is_empty()) {
        env.bucket = b.to_string();
    }
    if let Some(r) = db.region.as_deref().filter(|s| !s.is_empty()) {
        env.region = r.to_string();
    }
    if let Some(ps) = db.path_style {
        env.path_style = ps;
    }
    if let Some(ak) = db.access_key_id.as_deref().filter(|s| !s.is_empty()) {
        env.access_key_id = Some(ak.to_string());
    }
    if let Some(sk) = db.secret_access_key.as_deref().filter(|s| !s.is_empty()) {
        env.secret_access_key = Some(sk.to_string());
    }
    env
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn env_usize(key: &str) -> Option<usize> {
    std::env::var(key).ok()?.parse().ok()
}

fn env_bool(key: &str) -> Option<bool> {
    match std::env::var(key).ok()?.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let l = WorkstoreLimits::default();
        assert!(l.gc_enabled);
        assert_eq!(l.gc_interval_hours, 6);
        assert!(l.table_page_max > 0);
        assert!(l.slice_max_bytes > 0);
    }

    /// TEST-8 [covers: ITEM-5] [invariant: INV-5] — the DB->env merge is per-field and
    /// an EMPTY override is byte-identical to the env base (compat mode). Pure — no
    /// process env, no DB.
    ///
    /// TEST-5 (#70) [covers: ITEM-4] — this existing overlay test also proves the DB->env
    /// `merge_backend` overlay still holds with the new `Result` signature (valid tokens
    /// `.unwrap()` to the same kinds): empty override ⇒ env kind, explicit `s3`/`local`
    /// win — INV-5 per-field byte-identity preserved.
    #[test]
    fn effective_object_store_merge_prefers_db_then_env() {
        let env = S3ConnConfig {
            provider: CloudProvider::S3,
            bucket: "env-bucket".into(),
            region: "us-east-1".into(),
            endpoint: Some("http://env".into()),
            access_key_id: Some("ENV_AK".into()),
            secret_access_key: Some("ENV_SK".into()),
            path_style: true,
            multipart_threshold: DEFAULT_MULTIPART_THRESHOLD,
            part_size: DEFAULT_PART_SIZE,
        };

        // Empty override ⇒ env unchanged, backend from env (INV-5 byte-identity).
        let empty = ObjectStoreDbConfig::default();
        assert!(empty.is_empty());
        let merged = merge_s3_conn(env.clone(), &empty);
        assert_eq!(merged.bucket, "env-bucket");
        assert_eq!(merged.access_key_id.as_deref(), Some("ENV_AK"));
        assert_eq!(
            merge_backend(ObjectStoreKind::S3, empty.backend.as_deref()).unwrap(),
            ObjectStoreKind::S3
        );
        assert_eq!(merge_backend(ObjectStoreKind::Local, None).unwrap(), ObjectStoreKind::Local);

        // A populated override wins per-field; unset fields keep env.
        let db = ObjectStoreDbConfig {
            backend: Some("s3".into()),
            provider: Some("gcs".into()),
            endpoint: None, // keep env endpoint
            bucket: Some("db-bucket".into()),
            region: None, // keep env region
            path_style: Some(false),
            access_key_id: Some("DB_AK".into()),
            secret_access_key: None, // keep env secret
        };
        let merged = merge_s3_conn(env, &db);
        assert_eq!(merged.provider, CloudProvider::Gcs);
        assert_eq!(merged.bucket, "db-bucket");
        assert_eq!(merged.region, "us-east-1", "unset region falls back to env");
        assert_eq!(merged.endpoint.as_deref(), Some("http://env"));
        assert!(!merged.path_style);
        assert_eq!(merged.access_key_id.as_deref(), Some("DB_AK"));
        assert_eq!(merged.secret_access_key.as_deref(), Some("ENV_SK"), "unset secret keeps env");
        // The DB explicitly selects s3 even if env said local.
        assert_eq!(
            merge_backend(ObjectStoreKind::Local, db.backend.as_deref()).unwrap(),
            ObjectStoreKind::S3
        );
        // An explicit 'local' in the DB overrides an env s3.
        assert_eq!(merge_backend(ObjectStoreKind::S3, Some("local")).unwrap(), ObjectStoreKind::Local);
    }

    /// TEST-3 [invariant: INV-3] (deploy-hardening gap #3) — a RELEASE worker configures a
    /// CUSTOM S3 endpoint via the DB `infra_object_store` row (#63), release-safe.
    ///
    /// HOW THIS IS A REAL GUARD (not a tautology): `merge_s3_conn` carries `db.endpoint` with NO
    /// `debug_assertions` gate — the ONLY such gate is `endpoint_seam`, which covers the
    /// `S3_ENDPOINT` *env var*, not the DB row. This test drives the RELEASE shape of the env
    /// base (`endpoint: None`, exactly what `S3ConnConfig::from_env()` yields once `endpoint_seam`
    /// compiles the env var out) and asserts the DB endpoint/bucket/creds survive the merge. The
    /// falsification is profile-scoped and therefore run under BOTH profiles (TEST_RESULTS records
    /// a `--release` run too): if someone gated `merge_s3_conn`'s `db.endpoint` on
    /// `debug_assertions`, the RELEASE run of this test would drop the endpoint and go red — which
    /// a debug-only run could NOT catch. Belt-and-braces: `endpoint_override_is_a_debug_only_seam`
    /// proves the ENV endpoint IS debug-gated, so together they pin "env seam debug-only, DB row
    /// release-safe".
    #[test]
    fn release_worker_reads_custom_endpoint_from_db_infra_config() {
        // The RELEASE-build env base: no endpoint (S3_ENDPOINT compiled out by endpoint_seam),
        // ambient identity (no static creds), default region.
        let release_env_base = S3ConnConfig {
            provider: CloudProvider::S3,
            bucket: String::new(),
            region: "us-east-1".into(),
            endpoint: None, // ← the release shape: the env seam yields None
            access_key_id: None,
            secret_access_key: None,
            path_style: false,
            multipart_threshold: DEFAULT_MULTIPART_THRESHOLD,
            part_size: DEFAULT_PART_SIZE,
        };
        // The admin DB row (#63): a custom S3-compatible endpoint + bucket + static creds.
        let db = ObjectStoreDbConfig {
            backend: Some("s3".into()),
            provider: Some("s3".into()),
            endpoint: Some("https://objstore.internal.example:9000".into()),
            bucket: Some("prod-worklab".into()),
            region: Some("eu-west-1".into()),
            path_style: Some(true),
            access_key_id: Some("DB_PROD_AK".into()),
            secret_access_key: Some("DB_PROD_SK".into()),
        };
        // The DB row explicitly selects s3 even when env is unset/Local (release worker path).
        assert_eq!(
            merge_backend(backend_from_env(None).unwrap(), db.backend.as_deref()).unwrap(),
            ObjectStoreKind::S3
        );
        let merged = merge_s3_conn(release_env_base, &db);
        // The custom endpoint (and bucket/region/creds/path-style) come from the DB row — the
        // release build could not have gotten the endpoint from env (it was None).
        assert_eq!(merged.endpoint.as_deref(), Some("https://objstore.internal.example:9000"));
        assert_eq!(merged.bucket, "prod-worklab");
        assert_eq!(merged.region, "eu-west-1");
        assert!(merged.path_style);
        assert_eq!(merged.access_key_id.as_deref(), Some("DB_PROD_AK"));
        assert_eq!(merged.secret_access_key.as_deref(), Some("DB_PROD_SK"));
    }

    #[test]
    fn backend_str_is_stable() {
        assert_eq!(ObjectStoreKind::Local.as_str(), "local-fs");
        assert_eq!(ObjectStoreKind::S3.as_str(), "s3");
        assert_eq!(CloudProvider::S3.as_str(), "s3");
        assert_eq!(CloudProvider::Gcs.as_str(), "gcs");
    }

    /// TEST-2 (selection: unset default) [acceptance] [invariant: INV-2] — an UNSET or blank
    /// `TXR_WORKSTORE_BACKEND` resolves to `Local`, byte-identical to prior behavior, so the
    /// desktop / single-box path is unchanged (DE-INV-1). Pure — no process env.
    #[test]
    fn backend_selector_unset_or_blank_is_local_default() {
        assert_eq!(backend_from_env(None).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("")).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("   ")).unwrap(), ObjectStoreKind::Local);
    }

    /// TEST-3 (selection: valid tokens) [acceptance] [invariant: INV-3] — the recognized
    /// literals keep their meaning; surrounding whitespace is trimmed for a valid token
    /// (DEC-1). Pure — no process env.
    #[test]
    fn backend_selector_accepts_the_valid_tokens() {
        assert_eq!(backend_from_env(Some("s3")).unwrap(), ObjectStoreKind::S3);
        assert_eq!(backend_from_env(Some("s3 ")).unwrap(), ObjectStoreKind::S3, "whitespace trimmed");
        assert_eq!(backend_from_env(Some("local")).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("local-fs")).unwrap(), ObjectStoreKind::Local);
    }

    /// TEST-1 (fail-closed) [acceptance] [invariant: INV-1] — the safety-critical proof (#69):
    /// an UNRECOGNIZED non-empty value ERRORS, it does NOT silently degrade to `Local`. Covers
    /// the intuitive-but-wrong `gcs`, another provider name `minio`, and a wrong-case token (RETIRED-SUBSTRATE: named only as a rejected fixture)
    /// with whitespace `S3 `. The error message names the offending value AND points at
    /// `TXR_WORKSTORE_CLOUD` (so the operator learns the provider is chosen there). Flipping
    /// the selector back to silent-`Local` turns this test RED. Pure — no process env.
    #[test]
    fn backend_selector_fails_closed_on_unrecognized_value() {
        for bad in ["gcs", "minio", "S3 ", "S3", "s33"] { // RETIRED-SUBSTRATE: invalid-token fixtures, not a live substrate reference
            let err = backend_from_env(Some(bad))
                .expect_err(&format!("{bad:?} must fail-closed, not resolve to Local"));
            let msg = err.to_string();
            assert!(
                msg.contains(bad.trim()),
                "error must name the offending value {bad:?}: {msg}"
            );
            assert!(
                msg.contains("TXR_WORKSTORE_CLOUD"),
                "error must point at TXR_WORKSTORE_CLOUD: {msg}"
            );
        }
    }

    // ───────────────────── #70: admin-override fail-closed ─────────────────────

    /// TEST-1 (#70) [acceptance] [invariant: INV-1] — the admin PUT-boundary validator refuses
    /// an unrecognized backend override with a 422 (not a silent fall to Local), and the error
    /// NAMES the bad value AND the valid set. Recognized tokens (trim-forgiven) parse; absent /
    /// blank ⇒ `Ok(None)` (leave unchanged). Flipping the validator to accept-anything, or the
    /// status away from 422, turns this RED. Pure — no env, no DB.
    #[test]
    fn validate_admin_backend_rejects_unrecognized_with_422() {
        for bad in ["gcs", "minio", "Local", "S3", "s3x"] { // RETIRED-SUBSTRATE: invalid-token fixtures, not a live substrate reference
            let err = validate_admin_backend(Some(bad))
                .expect_err(&format!("{bad:?} must be refused, not accepted/silently-Local"));
            assert_eq!(
                err.status_code(),
                422,
                "an unrecognized admin backend must be a 422: {bad:?}"
            );
            let msg = err.to_string();
            assert!(msg.contains(bad.trim()), "error must name the bad value {bad:?}: {msg}");
            assert!(
                msg.contains("local | local-fs | s3"),
                "error must list the valid set: {msg}"
            );
        }
        // Recognized tokens parse (whitespace trimmed for a valid token, DEC-1).
        assert_eq!(validate_admin_backend(Some("s3")).unwrap(), Some(ObjectStoreKind::S3));
        assert_eq!(validate_admin_backend(Some("s3 ")).unwrap(), Some(ObjectStoreKind::S3));
        assert_eq!(validate_admin_backend(Some("local")).unwrap(), Some(ObjectStoreKind::Local));
        assert_eq!(validate_admin_backend(Some("local-fs")).unwrap(), Some(ObjectStoreKind::Local));
        // Absent / blank ⇒ leave the stored value unchanged (fall through to env).
        assert_eq!(validate_admin_backend(None).unwrap(), None);
        assert_eq!(validate_admin_backend(Some("")).unwrap(), None);
        assert_eq!(validate_admin_backend(Some("   ")).unwrap(), None);
    }

    /// TEST-3 (#70) [acceptance] [invariant: INV-2] — `merge_backend` fails CLOSED on an
    /// unrecognized STORED value (defense-in-depth), rather than the old `_ => env_backend`
    /// silent pass-through. The valid paths are unchanged: absent/blank DB ⇒ the env kind,
    /// recognized DB token ⇒ that kind. Reverting to `_ => env_backend` turns this RED. Pure.
    #[test]
    fn merge_backend_fails_closed_on_unrecognized_db_value() {
        assert!(
            merge_backend(ObjectStoreKind::Local, Some("gcs")).is_err(),
            "a bad stored backend must fail-closed, not resolve to the env (Local) kind"
        );
        assert!(merge_backend(ObjectStoreKind::S3, Some("nope")).is_err());
        // Valid paths preserved.
        assert_eq!(merge_backend(ObjectStoreKind::S3, None).unwrap(), ObjectStoreKind::S3);
        assert_eq!(merge_backend(ObjectStoreKind::S3, Some("")).unwrap(), ObjectStoreKind::S3);
        assert_eq!(merge_backend(ObjectStoreKind::Local, Some("s3")).unwrap(), ObjectStoreKind::S3);
        assert_eq!(merge_backend(ObjectStoreKind::S3, Some("local")).unwrap(), ObjectStoreKind::Local);
    }

    /// TEST-4 (#70) [acceptance] [invariant: INV-4] — `parse_backend_token` is the SINGLE
    /// classifier, and the three consumers (env selector, admin validator, override merge) all
    /// agree on the same token: they all REJECT `"gcs"` and all ACCEPT `"s3"`. Case-sensitive
    /// (`"S3"` is unrecognized everywhere). Pure — no env, no DB.
    #[test]
    fn parse_backend_token_is_the_single_shared_classifier() {
        assert_eq!(parse_backend_token("s3"), Ok(ObjectStoreKind::S3));
        assert_eq!(parse_backend_token("local"), Ok(ObjectStoreKind::Local));
        assert_eq!(parse_backend_token("local-fs"), Ok(ObjectStoreKind::Local));
        assert_eq!(parse_backend_token("gcs"), Err("gcs"));
        assert_eq!(parse_backend_token("S3"), Err("S3"), "case-sensitive");
        // All three consumers agree that "gcs" is bad …
        assert!(backend_from_env(Some("gcs")).is_err());
        assert!(validate_admin_backend(Some("gcs")).is_err());
        assert!(merge_backend(ObjectStoreKind::Local, Some("gcs")).is_err());
        // … and that "s3" is good.
        assert_eq!(backend_from_env(Some("s3")).unwrap(), ObjectStoreKind::S3);
        assert_eq!(validate_admin_backend(Some("s3")).unwrap(), Some(ObjectStoreKind::S3));
        assert_eq!(merge_backend(ObjectStoreKind::Local, Some("s3")).unwrap(), ObjectStoreKind::S3);
    }

    /// TEST-6 (#70) [acceptance] [invariant: INV-3] — the #69 ENV path is UNCHANGED after the
    /// refactor onto the shared parser: unset/blank ⇒ Local; `s3` ⇒ S3; `local`/`local-fs` ⇒
    /// Local; `s3 ` (trim) ⇒ S3; `gcs`/`S3` ⇒ Err still naming `TXR_WORKSTORE_CLOUD`. Proves
    /// the desktop/default selector stays byte-identical. Pure — no process env.
    #[test]
    fn env_selector_unchanged_after_shared_parser() {
        assert_eq!(backend_from_env(None).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("")).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("   ")).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("s3")).unwrap(), ObjectStoreKind::S3);
        assert_eq!(backend_from_env(Some("s3 ")).unwrap(), ObjectStoreKind::S3);
        assert_eq!(backend_from_env(Some("local")).unwrap(), ObjectStoreKind::Local);
        assert_eq!(backend_from_env(Some("local-fs")).unwrap(), ObjectStoreKind::Local);
        for bad in ["gcs", "S3"] {
            let msg = backend_from_env(Some(bad)).unwrap_err().to_string();
            assert!(msg.contains(bad), "error names the value: {msg}");
            assert!(msg.contains("TXR_WORKSTORE_CLOUD"), "error points at the provider var: {msg}");
        }
    }

    /// TEST-8 [invariant: INV-4 / DEC-3] — the loopback endpoint override is honored in a
    /// DEBUG build and IGNORED in release (mirrors `EnvImageSeams`): a release binary
    /// cannot be redirected at a loopback object store. Tests run in debug, so the
    /// positive branch is asserted directly; the release branch is compiled out and
    /// carried by the `#[cfg(not(debug_assertions))]` arm (the same test shape the sandbox
    /// `EnvImageSeams` seams use).
    #[test]
    fn endpoint_override_is_a_debug_only_seam() {
        let raw = Some("http://127.0.0.1:9000".to_string());
        if cfg!(debug_assertions) {
            assert_eq!(
                endpoint_seam(raw.clone()),
                raw,
                "a debug build honors the loopback endpoint override (the test seam)"
            );
        } else {
            assert_eq!(
                endpoint_seam(raw),
                None,
                "a release build must IGNORE a loopback endpoint override (DEC-3)"
            );
        }
        // An empty override is never honored, in either build.
        assert_eq!(endpoint_seam(Some(String::new())), None);
        assert_eq!(endpoint_seam(None), None);
    }

    /// F2 (coding-guidelines §3) — a `{:?}` of `S3ConnConfig` (reachable via
    /// `WorkstoreConfig`'s derived `Debug`) must NEVER print the AWS credentials. The hidden
    /// bucket/region are still shown (they aid debugging + are not secret).
    #[test]
    fn debug_redacts_the_credentials() {
        let cfg = S3ConnConfig {
            provider: CloudProvider::S3,
            bucket: "txr-worklab".to_string(),
            region: "us-east-1".to_string(),
            endpoint: Some("http://127.0.0.1:9000".to_string()),
            access_key_id: Some("AKIA_SUPER_SECRET_ID".to_string()),
            secret_access_key: Some("TOP+SECRET/awskey".to_string()),
            path_style: true,
            multipart_threshold: DEFAULT_MULTIPART_THRESHOLD,
            part_size: DEFAULT_PART_SIZE,
        };
        let dbg = format!("{cfg:?}");
        assert!(
            !dbg.contains("AKIA_SUPER_SECRET_ID"),
            "access key leaked: {dbg}"
        );
        assert!(
            !dbg.contains("TOP+SECRET/awskey"),
            "secret key leaked: {dbg}"
        );
        assert!(
            dbg.contains("<redacted>"),
            "presence is shown as redacted: {dbg}"
        );
        assert!(
            dbg.contains("txr-worklab"),
            "non-secret bucket is still shown: {dbg}"
        );
    }

    /// The multipart tunables clamp the part size to S3's 5 MiB minimum and carry DEC-4's
    /// defaults, so a `from_conn` handle never issues an illegal sub-5-MiB non-final part.
    #[test]
    fn multipart_defaults_and_clamp() {
        assert_eq!(DEFAULT_PART_SIZE, 8 * 1024 * 1024);
        assert_eq!(DEFAULT_MULTIPART_THRESHOLD, 16 * 1024 * 1024);
        assert!(DEFAULT_PART_SIZE >= MIN_PART_SIZE);
    }

    /// The e2e/production contract, on the REAL resolver: whatever
    /// `rootfs::data_root()` returns — and `TXR_APP_DATA_DIR` is what sets it
    /// for the integration + e2e harnesses — a single-catalog deployment's store
    /// sits at exactly `<that>/workstore`. The catalog partitioning must be
    /// invisible here, or every existing deployment's blobs are stranded.
    #[test]
    fn a_single_catalog_resolves_to_data_root_slash_workstore() {
        let data = std::env::temp_dir().join(format!("txr-cfgroot-{}", uuid::Uuid::new_v4()));
        let _guard = crate::modules::rootfs::scoped_data_root(&data);

        // SQLite-shaped config (ITEM-26): no `postgresql:` block; the DB target
        // defaults to `<app-data-dir>/txresbench.db` under the scoped data
        // root, which is exactly what `catalog_identity` resolves at runtime.
        let server_cfg: ServerConfig = serde_norway::from_str(
            r#"
server:
  host: "127.0.0.1"
  port: 3100
  api_prefix: "/api"
jwt:
  secret: "test-secret-key-for-jwt-tokens-min-32-chars-long"
  issuer: "txresbench"
  audience: "txresbench-api"
  access_token_expiry_hours: 24
  refresh_token_expiry_days: 30
"#,
        )
        .expect("test config parses");

        // TEST-4: resolve_for now returns Result; with TXR_WORKSTORE_BACKEND unset it is Ok
        // and byte-identical (INV-2). (This test never sets the env var — see DEC-4 on why a
        // bad-value boot case is a pure unit test, not this process-global path.)
        let cfg = WorkstoreConfig::resolve_for(&server_cfg).expect("unset backend resolves Ok");
        assert_eq!(
            cfg.root(),
            data.join("workstore"),
            "a single-catalog deployment must keep the un-suffixed root"
        );
        // And it is a CLAIMED root, so its sweep is permitted.
        assert_eq!(cfg.claim.key(), catalog_key(&server_cfg));
        let _ = std::fs::remove_dir_all(&data);
    }
}
