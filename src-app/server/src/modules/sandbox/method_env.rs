//! `method_env` — the txr method-environment manager (PROV-SS-4): per-env-id
//! download state, OCI fetch/verify/cache/mount of the base + layer artifacts
//! a stacked method run executes in, and the `<app_data>/txr-envs/` state
//! ledger.
//!
//! A stacked run needs TWO artifacts (DEC-2): one trimmed per-language BASE
//! rootfs and one per-method LAYER image, both published as OCI artifacts whose
//! single layer is a `.squashfs` blob. The manager is the provider-family
//! SIBLING of [`super::env_image::OciEnvImageProvider`] — same shape
//! (resolve → verify → pull → stage → mount by content digest), same
//! content-digest cache (`rootfs::cache`), same mount primitive
//! (`rootfs::ensure_ready_by_digest`: per-digest mount lock,
//! `enforce_schema = false`), but a DIFFERENT contract axis:
//!
//! - the OCI REFERENCE is caller data ([`EnvRef`]), not resolved from an env-id
//!   here — this node never enumerates method or env names (INV-4 of the
//!   module); `EnvRef.digest` is the layer blob's pinned sha256 (DEC-3), and
//!   the obtained bytes are ALWAYS verified against it (`ENV_VERIFY_FAILED`);
//! - the state is a per-env-id status (not_downloaded / downloading / ready /
//!   failed) with byte counters, bounded concurrency
//!   ([`MAX_CONCURRENT_DOWNLOADS`]) and an in-flight cancellation handle —
//!   the execution-engine polls it to drive the downloads screen;
//! - the state survives a restart as JSON under `<app_data>/txr-envs/`
//!   (DEC-10: disk state, no DB row, no migration).
//!
//! # Invariants
//!
//! - **INV-1 (network)** — the ONLY network surface of the node is the fetch
//!   in this module; the run itself stays `--unshare-net`. The pulled bytes
//!   are hashed and compared to the caller's pinned digest BEFORE they reach
//!   the cache (`ENV_VERIFY_FAILED`, no cache entry, no mount) — a tampered or
//!   swapped blob is never runnable (TEST-07). The same check is applied to a
//!   seam-staged squashfs and re-applied to a cache hit: identification with
//!   the pin is always re-derived from the bytes.
//! - **INV-2 (one stack per method)** — the manager keys everything by env-id;
//!   a base and a layer never substitute for each other (the ref prefix must
//!   match the declared [`EnvKind`], and a staged artifact for a DIFFERENT env
//!   refuses by name — the shipped #189 rule).
//! - **INV-6 (both digests recorded)** — [`ProvidedMount::digest`] is the
//!   verified content digest of the mounted artifact; ITEM-4's run seam writes
//!   base + layer digests into the run workspace from here.
//!
//! # Air-gap seams (DEC-15)
//!
//! The manager honours the same env-scoped seams the shipped provider does, so
//! local dev and the real-compute test tier stage a base or layer without OCI:
//!
//! 1. `TXR_ENV_ROOTFS_SQUASHFS__<env-id>=<path>` — **preferred** (content
//!    identity: the bytes are verified against the pinned digest, staged into
//!    the digest cache, mounted by digest, and the digest is recorded);
//! 2. `TXR_ENV_ROOTFS_DIR__<env-id>=<pre-mounted dir>` — legacy: a mount dir
//!    carries no content identity, so a digest is recorded only when it is the
//!    digest cache's own mount point; otherwise the run is unpinned and the
//!    layer digest is `None` (the shipped "provenance-only" posture);
//! 3. the un-suffixed forms serve the single env named by
//!    `TXR_ENV_ROOTFS_{SQUASHFS,DIR}_ENV` — the txr node has NO default env-id
//!    (DEC-13: the base is always caller-named), so a bare artifact without
//!    the `_ENV` association is refused rather than substituted;
//! 4. a staged artifact for a DIFFERENT env refuses by name, never substitutes.
//!
//! [`MethodEnvSeams::bypass_air_gap_env`] (debug builds only) skips both seams,
//! exactly like the shipped provider seam — the loopback-registry integration
//! fixture needs it, and it cannot be obtained by unsetting a process variable
//! (the measured cross-test contamination documented in `env_image.rs`).
//!
//! # Blocking + bounded
//!
//! [`MethodEnvManager::ensure`] shells to host tools (`oras`, resolved via
//! [`tool_bin`]: the app executable's directory (the bundled sidecar) first,
//! then `<app_data>/bin`, then `PATH` — DEC-4) and does
//! synchronous I/O, so the caller runs it on `spawn_blocking`, exactly like
//! `EnvImageProvider::provide`. `deadline` is the TOTAL wall-clock budget for
//! the whole resolve→verify→pull→stage→mount sequence; exceeding it returns
//! `ENV_STAGING_TIMEOUT`, never a hung job.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use txresbench_core::AppError;

use super::env_id::is_valid_env_id;
use super::env_image::{
    ENV_STAGED_MISMATCH_CODE, ENV_STAGED_UNASSOCIATED_CODE, ENV_STAGED_UNUSABLE_CODE,
};
use super::stack::{
    is_sha256_hex, is_valid_oci_tag, EnvRef, OciRefParts, ENV_REF_HOST_UNALLOWED_CODE,
};

// ────────────────────────────── typed error codes ─────────────────────────────

/// The bytes of a fetched / staged / cached artifact do not hash to the
/// caller's pinned [`EnvRef::digest`]. Raised BEFORE any cache entry or mount
/// (TEST-07); the message names both digests.
pub const ENV_VERIFY_FAILED_CODE: &str = "ENV_VERIFY_FAILED";

/// The environment's OCI reference has no resolvable pull identity — neither a
/// `:tag` nor an `@sha256:` suffix — or the registry answered without the
/// artifact. DEC-3 pins runtime pulls (the catalogue digest is the byte
/// anchor); a bare `latest` pull is refused.
pub const ENV_REPOSITORY_UNKNOWN_CODE: &str = "ENV_REPOSITORY_UNKNOWN";

/// The whole [fetch budget](MethodEnvManager::ensure) was spent before the
/// artifact was mounted.
pub const ENV_STAGING_TIMEOUT_CODE: &str = "ENV_STAGING_TIMEOUT";

/// The caller's declared [`EnvKind`] does not match the reference's registry
/// namespace (base vs layer), or is [`EnvKind::Unknown`] — a base artifact can
/// never be mounted as a layer and vice versa (INV-2).
pub const ENV_KIND_INVALID_CODE: &str = "ENV_KIND_INVALID";

/// An in-flight download was cancelled ([`MethodEnvManager::cancel`]); the
/// terminal state is `failed` and a later `ensure` retries cleanly (TEST-11).
pub const ENV_DOWNLOAD_CANCELLED_CODE: &str = "ENV_DOWNLOAD_CANCELLED";

/// `oras` is not found next to the app executable, in `<app_data>/bin` nor on
/// `PATH` ([`tool_bin`]). The txr env
/// status degrades (the env's state is `failed` with this error); a run is
/// never attempted against the host filesystem instead (module INV-2).
/// (The shipped `env_image.rs` names the same host-tool condition
/// `ENV_IMAGE_TOOL_MISSING` — one string, two provider families.)
const ENV_TOOL_MISSING_CODE: &str = "ENV_IMAGE_TOOL_MISSING";

// ────────────────────────────── compiled constants ────────────────────────────

/// Registry HOST of the published txr base/layer artifacts (the same `ghcr.io`
/// the shipped env images use — the allowlist guard stays green, DEC-11; the
/// spelling carries no scheme, like the shipped `DEFAULT_REGISTRY`). The
/// compiled ref prefixes themselves live in `stack.rs`; the release-time
/// prefix list assembled here is byte-identical to them, locked by a parity
/// test.
const TXR_REGISTRY_HOST: &str = "ghcr.io";

/// The OCI namespace under the registry host. Kept in one place because the
/// debug-only loopback seam re-points the SAME namespace/repo names at another
/// host.
const TXR_REGISTRY_NAMESPACE: &str = "tinnlab";

/// The per-language base-image repo name under the namespace.
const TXR_ENVS_REPO: &str = "txresbench-env";

/// The per-method layer-image repo name under the namespace
/// (PROV-method-env-images-2 pins this namespace at the publisher).
const TXR_LAYERS_REPO: &str = "txr-method-env-layers";

/// At most this many downloads run at once (DEC-8: a constant, not a
/// setting). A further request waits for a slot, and for the same env-id, for
/// that env's in-flight attempt — never a duplicate pull.
pub const MAX_CONCURRENT_DOWNLOADS: usize = 2;

/// How long [`MethodEnvManager::cancel`] waits for the in-flight worker to
/// join after the cancel flag is set (the worker's poll interval is 25 ms and
/// the child is killed, so this is generous).
pub const CANCEL_JOIN_TIMEOUT: Duration = Duration::from_secs(30);

/// The env-var-name suffix of a per-env seam (`…__<env-id>`).
const ENV_SEAM_SUFFIX: &str = "__";

/// The seam variable names, same spellings as the shipped provider (DEC-15).
const SQUASHFS_SEAM: &str = "TXR_ENV_ROOTFS_SQUASHFS";
const ROOTFS_DIR_SEAM: &str = "TXR_ENV_ROOTFS_DIR";

/// Cap on retained subprocess output per stream (the rest is drained to a
/// sink so a chatty `oras` can never block on a full pipe, nor balloon our
/// memory) — mirrors `env_image.rs`.
const TOOL_OUTPUT_CAP: usize = 256 * 1024;

/// Metadata-only `oras resolve` cap (a few-KiB control-plane RPC; the
/// bandwidth-bound pull gets the remaining budget).
const TOOL_METADATA_TIMEOUT: Duration = Duration::from_secs(120);

// ────────────────────────────── wire types ────────────────────────────────────

/// Which artifact a status/entry names (PROV-SS-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EnvKind {
    /// A trimmed per-language base rootfs
    /// (`ghcr.io/tinnlab/txresbench-env/…`).
    Base,
    /// A per-method layer image (`ghcr.io/tinnlab/txr-method-env-layers/…`).
    Layer,
    /// The env has never been ensured in this process and is not persisted, so
    /// the manager cannot know whether it is a base or a layer. This node is
    /// deliberately catalogue-free (it never enumerates env names); the caller
    /// of [`MethodEnvManager::status`] knows the kind from its own records.
    /// A `Unknown` record is never mounted — `ensure` refuses it.
    Unknown,
}

/// The fetch state machine of one env (PROV-SS-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MethodEnvState {
    /// Never fetched (or the persisted state no longer applies — a crash
    /// mid-download, or a digest no longer present in the cache).
    NotDownloaded,
    /// A fetch (resolve→pull→verify→stage→mount) is in flight for this env.
    Downloading,
    /// The verified artifact is cached; `ensure` returns its mount directly.
    Ready,
    /// The last attempt failed (or was cancelled); `error` names the reason.
    Failed,
}

/// One env's status (PROV-SS-4, CONS-EE-7). `bytes_downloaded` is polled from
/// the growing staged file (no oras-output parser — oras's progress format is
/// not a contract); `bytes_total` is `None` while no size is known (the caller
/// that holds the catalogue's `size_bytes` drives the user-visible progress
/// bar).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MethodEnvStatus {
    pub env_id: String,
    pub kind: EnvKind,
    pub state: MethodEnvState,
    pub bytes_downloaded: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// Whether the artifact's mount is currently live (the cache mount's
    /// `usr/` is visible, or the staged dir carries it).
    pub mounted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What [`MethodEnvManager::ensure`] hands back: the mount dir to bind and the
/// content digest THAT MOUNT corresponds to (`None` only for the legacy
/// pre-mounted-dir seam, mirroring [`super::env_image::ProvidedEnv`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvidedMount {
    /// The artifact mount dir (the dir whose `usr/` the stacked argv binds).
    pub mount_dir: PathBuf,
    /// The verified 64-hex content digest of the mounted artifact, when it has
    /// one (recorded in the run workspace — INV-6).
    pub digest: Option<String>,
}

/// Per-manager configuration of the registry + air-gap seams, passed
/// EXPLICITLY via [`MethodEnvManager::with_seams`] — the same rationale as
/// [`super::env_image::EnvImageSeams`]: a process-global `set_var` seam makes
/// one test's configuration visible to every concurrently-running sibling.
///
/// Release posture unchanged: `registry` and `bypass_air_gap_env` are honored
/// only under `#[cfg(debug_assertions)]`.
#[derive(Clone, Debug, Default)]
pub struct MethodEnvSeams {
    /// Registry HOST to fetch from instead of `ghcr.io` (a loopback
    /// `registry:2` for the integration fixture). The compiled namespace +
    /// repo names are kept, so the seam re-points the SAME artifact paths to a
    /// local registry. Debug builds only; the fetch switches to plain HTTP.
    pub registry: Option<String>,
    /// Skip the air-gap env seams and drive the real OCI path. Debug builds
    /// only.
    pub bypass_air_gap_env: bool,
}

/// Whether the air-gap env seams are bypassed for this manager — debug only; a
/// release build always honors the operator's air-gap configuration.
fn air_gap_bypassed(seams: &MethodEnvSeams) -> bool {
    #[cfg(debug_assertions)]
    {
        seams.bypass_air_gap_env
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = seams;
        false
    }
}

/// The registry host (production: `ghcr.io`; debug seam: the loopback).
fn registry_host(seams: &MethodEnvSeams) -> String {
    #[cfg(debug_assertions)]
    if let Some(r) = seams.registry.as_deref().filter(|r| !r.is_empty()) {
        return r.to_string();
    }
    #[cfg(not(debug_assertions))]
    let _ = seams;
    TXR_REGISTRY_HOST.to_string()
}

/// The allowed OCI reference prefixes for this manager: the two compiled txr
/// registries in release, or the same namespace/repos on the seam's host in
/// debug. A caller-supplied ref to any other host/prefix is
/// `ENV_REF_HOST_UNALLOWED` — this is a release-time boundary (PROV-SS-1).
fn registry_prefixes(seams: &MethodEnvSeams) -> Vec<String> {
    let host = registry_host(seams);
    vec![
        format!("{host}/{TXR_REGISTRY_NAMESPACE}/{TXR_ENVS_REPO}"),
        format!("{host}/{TXR_REGISTRY_NAMESPACE}/{TXR_LAYERS_REPO}"),
    ]
}

// ────────────────────────────── the manager ───────────────────────────────────

/// The process-wide manager (lazy; loads the persisted state ledger at first
/// construction — the sandbox module's `init` touches it so statuses are
/// correct from the first request).
static MANAGER: once_cell::sync::OnceCell<MethodEnvManager> = once_cell::sync::OnceCell::new();

/// [`MANAGER`] — the `config::get_state()`-style accessor PROV-SS-4 names.
/// In a DEBUG build the process environment may name a dev registry host
/// (`TXR_METHOD_ENV_REGISTRY`, see [`dev_env_seams`]); a release build
/// always constructs the production seams, so the qa-hardening dev registry
/// can never reach a shipped binary.
pub fn manager() -> &'static MethodEnvManager {
    MANAGER.get_or_init(MethodEnvManager::from_env)
}

/// The dev-only registry seam wiring (ITEM-2, node qa-hardening): read the
/// loopback registry HOST from `TXR_METHOD_ENV_REGISTRY` and route it
/// through the EXISTING [`MethodEnvSeams::registry`] seam — the same
/// re-point-the-host, keep-the-namespace rule the loopback integration
/// fixtures use (`with_seams`). Debug builds only: the `#[cfg]` halves make a
/// release build evaluate to the production defaults, so no environment can
/// turn a shipped binary onto another registry. The air-gap seams stay
/// honored (a dev box that stages artifacts still stages them).
pub fn dev_env_seams() -> MethodEnvSeams {
    dev_seams_from(&|k| std::env::var(k).ok())
}

/// The pure core of [`dev_env_seams`] (injected read — the unit test pins the
/// mapping without touching the process env).
fn dev_seams_from(read: &impl Fn(&str) -> Option<String>) -> MethodEnvSeams {
    #[cfg(debug_assertions)]
    {
        let registry = read("TXR_METHOD_ENV_REGISTRY")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        MethodEnvSeams {
            registry,
            bypass_air_gap_env: false,
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = read;
        MethodEnvSeams::default()
    }
}

/// The EFFECTIVE base registry prefix of this process: the compiled
/// `ghcr.io/tinnlab/txresbench-env` in release, or the dev-seam host (same
/// namespace/repo) in a debug build with `TXR_METHOD_ENV_REGISTRY` set —
/// the value the status surface reports, so a dev run never claims to fetch
/// from ghcr.io.
pub fn effective_base_prefix() -> String {
    registry_prefixes(&dev_env_seams())[0].clone()
}

/// A per-env-id download-state ledger + fetch/verify/cache/mount owner
/// (PROV-SS-4). Construct with [`MethodEnvManager::new`] (production seams) or
/// [`MethodEnvManager::with_seams`] (test/loopback); blocking + bounded by
/// design — the caller runs `ensure` on `spawn_blocking`, like
/// [`super::env_image::EnvImageProvider::provide`].
pub struct MethodEnvManager {
    inner: Mutex<Inner>,
    /// Signalled on every attempt start / slot release / terminal transition,
    /// so slot-waiters and per-env waiters never miss a wakeup (the predicate
    /// is re-checked under the lock).
    slot_changed: Condvar,
    seams: MethodEnvSeams,
}

struct Inner {
    entries: HashMap<String, Entry>,
    /// How many downloads are currently in flight (bounded by
    /// [`MAX_CONCURRENT_DOWNLOADS`]).
    running: usize,
}

struct Entry {
    status: MethodEnvStatus,
    /// Bumped at every attempt start; a waiter that observed a download waits
    /// out exactly the attempt it saw, so a retry after a failure never hands
    /// the waiter a stale result.
    attempt: u64,
    /// True while a worker owns this env's attempt (`cancel` waits on it).
    worker_active: bool,
    /// The in-flight attempt's cancellation handle.
    cancel: Option<Arc<AtomicBool>>,
    /// The mount dir a Ready entry resolves to (cache mount or staged dir).
    mounted_dir: Option<PathBuf>,
    /// The last attempt's terminal error, so a waiter for the same attempt
    /// receives exactly the error the worker recorded.
    last_error: Option<StoredError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredError {
    status: u16,
    code: String,
    message: String,
}

impl StoredError {
    fn from_app(err: &AppError) -> Self {
        StoredError {
            status: err.status_code(),
            code: err.error_code().to_string(),
            message: err.to_string(),
        }
    }

    fn to_app(&self) -> AppError {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        AppError::new(status, self.code.clone(), self.message.clone())
    }
}

/// The on-disk state record: `<app_data>/txr-envs/<env-id>.json` (DEC-10). No
/// DB row, no migration; the file is replaced atomically on every state
/// transition.
#[derive(Debug, Serialize, Deserialize)]
struct PersistedEnv {
    env_id: String,
    kind: EnvKind,
    state: MethodEnvState,
    digest: Option<String>,
    error: Option<StoredError>,
    /// Unix seconds of the last state write (the `last_used` PROV-SS-4 names).
    last_used: u64,
}

impl MethodEnvManager {
    /// The production manager: release registry prefixes + air-gap seams
    /// honored.
    pub fn new() -> Self {
        Self::default()
    }

    /// The manager with the dev registry seam read from the process
    /// environment ([`dev_env_seams`]) — the wiring of
    /// [`MethodEnvManager::manager`] so the running server (a debug build) can
    /// fetch from the qa-hardening dev registry; a release build sees the
    /// production seams.
    fn from_env() -> Self {
        Self::with_seams(dev_env_seams())
    }

    /// A manager configured explicitly (test fixtures, loopback registries) —
    /// see [`MethodEnvSeams`].
    pub fn with_seams(seams: MethodEnvSeams) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                running: 0,
            }),
            slot_changed: Condvar::new(),
            seams,
        }
        .with_persisted_loaded()
    }

    fn with_persisted_loaded(self) -> Self {
        self.load_persisted();
        self
    }

    /// How many persisted envs the ledger holds (the boot log line).
    pub fn persisted_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .len()
    }

    /// Make the artifact `r` names available and return its mount dir + the
    /// verified content digest (PROV-SS-4): resolve → verify → pull → stage →
    /// mount, honoring:
    ///
    /// 1. the air-gap seams (unless bypassed) — staged squashfs or pre-mounted
    ///    dir, refused by name for a different env (DEC-15);
    /// 2. the content-digest cache — a cached digest is re-verified (its bytes
    ///    must still hash to the pin) and mounted, no network;
    /// 3. the OCI path — the pinned (`@sha256:`) or tag-resolved pull ref,
    ///    bytes verified against `r.digest` ALWAYS before the cache entry,
    ///    mounted by digest.
    ///
    /// BLOCKING: run on `spawn_blocking`. `deadline` bounds the whole
    /// sequence. At most one download per env-id (a further request waits on
    /// the existing attempt) and at most [`MAX_CONCURRENT_DOWNLOADS`] in
    /// flight.
    pub fn ensure(
        &self,
        r: &EnvRef,
        kind: EnvKind,
        deadline: Duration,
    ) -> Result<ProvidedMount, AppError> {
        let deadline_at = Instant::now() + deadline;

        // Entry boundary — caller data is grammar-validated BEFORE any
        // filesystem/spawn work (the ref host/prefix boundary; the pinned
        // digest shape; base-vs-layer namespace consistency).
        let parts = parse_oci_ref(&r.oci_ref, &self.seams)?;
        if !is_sha256_hex(&r.digest) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                ENV_VERIFY_FAILED_CODE,
                format!(
                    "the pinned digest {:?} is not sha256:<64 lowercase hex>; refusing to \
                     verify bytes against it",
                    r.digest
                ),
            ));
        }
        check_kind(&parts, kind, &self.seams)?;
        let env_id = parts.repo.clone();

        // State machine: this call either owns the attempt, or waits out the
        // attempt the env already has (that attempt's result is returned), or
        // waits for a download slot.
        let owned_attempt = self.claim(&env_id, r, kind)?;
        if !owned_attempt {
            return self.result_for(&env_id);
        }

        let outcome = self.attempt_download(&env_id, r, &parts, deadline_at);

        // Terminal transition (under the lock): clear the worker, release the
        // slot, record the outcome — UNLESS cancel() already recorded the
        // terminal state for this attempt (cancel wins; the worker never
        // overwrites it).
        {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(entry) = guard.entries.get_mut(&env_id) {
                entry.worker_active = false;
                entry.cancel = None;
                entry.attempt += 1;
                if entry.status.state == MethodEnvState::Downloading {
                    match &outcome {
                        Ok(m) => {
                            entry.status.state = MethodEnvState::Ready;
                            entry.status.digest = m.digest.clone();
                            entry.status.error = None;
                            entry.last_error = None;
                            entry.mounted_dir = Some(m.mount_dir.clone());
                        }
                        Err(e) => {
                            entry.status.state = MethodEnvState::Failed;
                            entry.status.error = Some(e.to_string());
                            entry.last_error = Some(StoredError::from_app(e));
                        }
                    }
                }
            }
            guard.running = guard.running.saturating_sub(1);
            self.persist_locked(&mut guard, &env_id);
        }
        self.slot_changed.notify_all();

        outcome
    }

    /// The current status of `env_id`. An env the manager has never seen (not
    /// ensured, not persisted) is reported `not_downloaded` with
    /// [`EnvKind::Unknown`] — the manager never guesses base/layer (a wrong
    /// kind presented as a status is the "wrong answer that reads as a bug"
    /// class this node refuses). Total for a malformed id too (the grammar
    /// check happens at every filesystem-touching boundary, so `status` must
    /// not name a state file with an unvalidated id — it simply has no
    /// knowledge of such an env).
    pub fn status(&self, env_id: &str) -> MethodEnvStatus {
        if !is_valid_env_id(env_id) {
            return unknown_status(env_id);
        }
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match guard.entries.get(env_id) {
            Some(e) => self.status_with_mounted(e),
            None => unknown_status(env_id),
        }
    }

    /// Every known env's status (PROV-SS-4). PROV-SS-5's `base` + `layers`
    /// split is the caller's classification — an [`EnvKind::Unknown`] entry
    /// appears in neither list, it only answers `status`.
    pub fn list(&self) -> Vec<MethodEnvStatus> {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<MethodEnvStatus> = guard
            .entries
            .values()
            .map(|e| self.status_with_mounted(e))
            .collect();
        out.sort_by(|a, b| a.env_id.cmp(&b.env_id));
        out
    }

    /// Cancel an in-flight download: flags the worker, records the terminal
    /// `failed` + "cancelled" state immediately (a status reader never sees a
    /// stale `downloading`), then waits — up to [`CANCEL_JOIN_TIMEOUT`] — for
    /// the worker to join (the runner kills the child within one poll). A
    /// no-op for an idle env; a subsequent `ensure` retries cleanly
    /// (TEST-10 / TEST-11).
    pub fn cancel(&self, env_id: &str) {
        if !is_valid_env_id(env_id) {
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = guard.entries.get_mut(env_id) else {
            return;
        };
        if entry.status.state != MethodEnvState::Downloading {
            return;
        }
        if let Some(flag) = entry.cancel.as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
        entry.status.state = MethodEnvState::Failed;
        entry.status.error = Some("cancelled by user".to_string());
        entry.last_error = Some(StoredError {
            status: StatusCode::BAD_REQUEST.as_u16(),
            code: ENV_DOWNLOAD_CANCELLED_CODE.to_string(),
            message: "the environment download was cancelled".to_string(),
        });
        self.persist_locked(&mut guard, env_id);
        drop(guard);
        self.slot_changed.notify_all();

        // Join the worker (bounded; the flag makes the kill immediate).
        let deadline = Instant::now() + CANCEL_JOIN_TIMEOUT;
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            let active = guard
                .entries
                .get(env_id)
                .map(|e| e.worker_active)
                .unwrap_or(false);
            if !active {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (g, _) = self
                .slot_changed
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|p| p.into_inner());
            guard = g;
        }
    }

    /// The `DELETE …?prune` route's STATE half (PROV-SS-5): cancel an in-flight
    /// download — exactly [`MethodEnvManager::cancel`] (flag the worker, record
    /// the terminal state, join it) — then FORGET the env entirely: the
    /// in-memory entry and the persisted
    /// `<app_data>/txr-envs/<env-id>.json` are removed, so a follow-up
    /// [`MethodEnvManager::status`] reports `not_downloaded` +
    /// [`EnvKind::Unknown`] and a follow-up `ensure` starts clean.
    ///
    /// Returns the LAST RECORDED digest (the cache entry the caller's
    /// `?prune=true` half may remove — the cache itself stays owned by
    /// `rootfs::cache::prune_digest`, DEC-17), or `None` when no digest was
    /// recorded. A grammar-invalid env-id or an env with no record is `None`
    /// too — the route turns that into 404 `ENV_UNKNOWN` (nothing exists to
    /// cancel, forget or prune).
    ///
    /// The worker tolerates a vanished entry: its terminal transition is
    /// `if let Some(entry)` (the `cancel`-wins rule), so a join that overruns
    /// [`CANCEL_JOIN_TIMEOUT`] cannot crash the manager — worst case a pull
    /// completed behind no record, which the digest cache serves by digest.
    pub fn cancel_and_forget(&self, env_id: &str) -> Option<String> {
        if !is_valid_env_id(env_id) {
            return None;
        }
        // The digest half, read under the lock BEFORE anything is torn down.
        let digest = {
            let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .entries
                .get(env_id)
                .and_then(|e| e.status.digest.clone())
        };
        // Cancel half (joins the worker; a no-op for an idle env).
        self.cancel(env_id);
        // Forget half: drop the in-memory entry + the persisted record.
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let existed = guard.entries.remove(env_id).is_some();
        drop(guard);
        if existed {
            let _ = std::fs::remove_file(state_file(env_id));
            self.slot_changed.notify_all();
        }
        digest
    }

    /// Get-or-create the entry and either claim the attempt or route this call
    /// to the existing attempt's result. `Ok(false)` = the caller must return
    /// [`Self::result_for`]; `Ok(true)` = the caller owns the attempt.
    fn claim(&self, env_id: &str, r: &EnvRef, kind: EnvKind) -> Result<bool, AppError> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            // Predicates under the lock, with the entry borrow SCOPED so the
            // slot gate below can re-borrow `guard`.
            let (state, same_digest) = {
                let entry = guard
                    .entries
                    .entry(env_id.to_string())
                    .or_insert_with(|| Entry::new(env_id.to_string(), kind));
                (
                    entry.status.state,
                    entry.status.digest.as_deref() == Some(r.digest.as_str()),
                )
            };

            if state == MethodEnvState::Downloading {
                // Wait out exactly the attempt we observed: a waiter returns
                // THAT attempt's result ("a further request waits on the
                // existing task", CONS-EE-7), and only a call that arrives at
                // a terminal state starts a retry (TEST-11). If another
                // caller restarted the env meanwhile (a newer attempt), the
                // waiter chains onto it.
                let seen = guard.entries.get(env_id).map(|e| e.attempt).unwrap_or(0);
                loop {
                    guard = self
                        .slot_changed
                        .wait(guard)
                        .unwrap_or_else(|p| p.into_inner());
                    let (state_now, attempt_now) = guard
                        .entries
                        .get(env_id)
                        .map(|e| (e.status.state, e.attempt))
                        .unwrap_or((MethodEnvState::NotDownloaded, 0));
                    if attempt_now != seen {
                        break; // a newer attempt owns the future; re-evaluate
                    }
                    if state_now != MethodEnvState::Downloading {
                        return Ok(false); // THE observed attempt ended
                    }
                }
                continue;
            }
            // A call that reached a terminal state returns its result — a
            // Ready entry already carrying the REQUESTED pin. A Ready entry
            // ticking a different digest (the catalogue re-published under the
            // same env-id) is a fresh download, not a stale mount. A Failed
            // entry is retried by the next, fresh call (TEST-11).
            if state == MethodEnvState::Ready && same_digest {
                return Ok(false);
            }
            if guard.running >= MAX_CONCURRENT_DOWNLOADS {
                guard = self
                    .slot_changed
                    .wait(guard)
                    .unwrap_or_else(|p| p.into_inner());
                continue;
            }
            // Claim.
            let entry = guard
                .entries
                .get_mut(env_id)
                .expect("the entry exists before the claim");
            entry.attempt += 1;
            entry.status.state = MethodEnvState::Downloading;
            entry.status.bytes_downloaded = 0;
            entry.status.bytes_total = None;
            entry.status.digest = Some(r.digest.clone());
            entry.status.error = None;
            entry.last_error = None;
            entry.worker_active = true;
            entry.mounted_dir = None;
            entry.cancel = Some(Arc::new(AtomicBool::new(false)));
            guard.running += 1;
            self.persist_locked(&mut guard, env_id);
            drop(guard);
            self.slot_changed.notify_all();
            return Ok(true);
        }
    }

    /// The Ready mount or the last attempt's error, for a call that found an
    /// existing terminal state (or waited one out). A Ready entry loaded from
    /// disk mounts lazily (its digest is cache-present by the load rule).
    fn result_for(&self, env_id: &str) -> Result<ProvidedMount, AppError> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = guard.entries.get_mut(env_id) else {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_REPOSITORY_UNKNOWN_CODE,
                format!("no recorded state for env {env_id:?}"),
            ));
        };
        // A newer attempt can only own the entry if this call's observed
        // attempt was superseded between the waiter's read and this re-lock —
        // an extreme race; refuse rather than mount or fail on a state the
        // caller never asked for.
        if entry.status.state == MethodEnvState::Downloading {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                ENV_REPOSITORY_UNKNOWN_CODE,
                format!(
                    "env {env_id:?} was re-fetched meanwhile with a different pin; \
                     retry the request"
                ),
            ));
        }
        if let Some(e) = entry.last_error.clone() {
            return Err(e.to_app());
        }
        let Some(digest) = entry.status.digest.clone() else {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_REPOSITORY_UNKNOWN_CODE,
                format!("env {env_id:?} is ready but carries no digest"),
            ));
        };
        if let Some(dir) = entry.mounted_dir.clone() {
            return Ok(ProvidedMount {
                mount_dir: dir,
                digest: Some(digest),
            });
        }
        // A persisted-rule Ready entry: mount now (the per-digest lock + fast
        // path make a concurrent mount cheap).
        let mount = ready_artifact_path(&digest)?;
        entry.mounted_dir = Some(mount.clone());
        Ok(ProvidedMount {
            mount_dir: mount,
            digest: Some(digest),
        })
    }

    /// The whole fetch/verify/cache/mount sequence for this attempt (the
    /// caller owns the state-machine terminal transition).
    fn attempt_download(
        &self,
        env_id: &str,
        r: &EnvRef,
        parts: &OciRefParts,
        deadline_at: Instant,
    ) -> Result<ProvidedMount, AppError> {
        // ── Air-gap seams (production; skipped under the debug bypass) ──────
        if !air_gap_bypassed(&self.seams) {
            if let Some(sq) = seam_squashfs_for(env_id) {
                remaining(deadline_at, "read the staged squashfs")?;
                // INV-1: the pinned digest applies to the seam bytes too — a
                // mismatched staged file is refused, never mounted.
                verify_payload_bytes(&sq, &r.digest)?;
                remaining(deadline_at, "stage the staged squashfs")?;
                stage_payload(&sq, &r.digest)?;
                remaining(deadline_at, "mount the staged squashfs")?;
                let mount = ready_artifact_path(&r.digest)?;
                return Ok(ProvidedMount {
                    mount_dir: mount,
                    digest: Some(r.digest.clone()),
                });
            }
            if let Some(dir) = seam_rootfs_dir_for(env_id) {
                if dir.join("usr").is_dir() {
                    // No bytes to verify: the operator vouches for the mounted
                    // dir (the shipped legacy-seam posture). A digest is
                    // recorded only when the dir is the cache's own mount
                    // point; otherwise the run is unpinned.
                    let digest = digest_from_cache_dir(&dir);
                    return Ok(ProvidedMount {
                        mount_dir: dir,
                        digest,
                    });
                }
            }
            if let Some(err) = seam_refusal(env_id) {
                return Err(err);
            }
        }

        // ── Content-digest cache: re-verify + mount, no network ─────────────
        if crate::modules::rootfs::cache::has_digest(&r.digest) {
            let cached = crate::modules::rootfs::cache::squashfs_path_for(&r.digest);
            // The cache entry claims to BE the pinned digest; a bit-rotten or
            // operator-replaced file must not mount (INV-1 "always"). macOS
            // never attaches this file: its run seam clones it and verifies
            // the CLONE (the bytes the VM reads) — skipping that hash only
            // when this process already verified the cache file and its
            // identity, ctime included, is unchanged — so hashing the cache
            // file here as well would read each image twice.
            if !cfg!(target_os = "macos") {
                verify_payload_bytes(&cached, &r.digest)?;
            }
            remaining(deadline_at, "mount the cached artifact")?;
            let mount = ready_artifact_path(&r.digest)?;
            return Ok(ProvidedMount {
                mount_dir: mount,
                digest: Some(r.digest.clone()),
            });
        }

        // ── OCI path ────────────────────────────────────────────────────────
        let pull_ref = pull_ref_for(parts, r, &self.seams, deadline_at)?;
        let tool = tool_bin("oras").ok_or_else(|| {
            AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ENV_TOOL_MISSING_CODE,
                // qa-fixes4 ITEM-1 (first-order wording): the old text named
                // the tool, its search locations and a deployment env var —
                // internal facts a user must never see. The API-boundary
                // sanitiser (`modules::err_sanitiser`) is the backstop; the
                // sentence itself is plain now (mirrors the report's own
                // plain replacement).
                "The method environment is not available yet",
            )
        })?;
        let cancel = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .get(env_id)
            .and_then(|e| e.cancel.clone())
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ENV_DOWNLOAD_CANCELLED_CODE,
                    "the attempt's cancellation handle is not registered",
                )
            })?;

        let cache_dir = crate::modules::rootfs::cache::base_dir();
        std::fs::create_dir_all(&cache_dir).map_err(|e| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_REPOSITORY_UNKNOWN_CODE,
                format!("mkdir {}: {e}", cache_dir.display()),
            )
        })?;
        let staging = cache_dir.join(format!(".pull-{}-{}", &r.digest[..8], uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&staging).map_err(|e| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_STAGING_TIMEOUT_CODE,
                format!("mkdir staging {}: {e}", staging.display()),
            )
        })?;
        let _staging_guard = TmpDirGuard(staging.clone()); // removed on every exit path

        let payload = pull_payload(
            &tool,
            &pull_ref,
            &staging,
            deadline_at,
            &cancel,
            &mut |n| self.update_bytes(env_id, n),
            &self.seams,
        )?;
        // INV-1: verify BEFORE the cache entry exists (a mismatch never
        // becomes a mountable artifact — TEST-07).
        verify_payload_bytes(&payload, &r.digest)?;
        remaining(deadline_at, "stage the pulled artifact")?;
        stage_payload(&payload, &r.digest)?;
        remaining(deadline_at, "mount the pulled artifact")?;
        let mount = ready_artifact_path(&r.digest)?;
        Ok(ProvidedMount {
            mount_dir: mount,
            digest: Some(r.digest.clone()),
        })
    }

    /// Live `mounted` probe for a status (the mount dir for a digest entry is
    /// the cache's mount point; a staged-dir entry carries its own).
    fn status_with_mounted(&self, entry: &Entry) -> MethodEnvStatus {
        let mut status = entry.status.clone();
        status.mounted = entry
            .mounted_dir
            .as_deref()
            .map(artifact_path_ready)
            .unwrap_or_else(|| {
                entry
                    .status
                    .digest
                    .as_deref()
                    .map(digest_ready)
                    .unwrap_or(false)
            });
        status
    }

    /// Publish byte progress from the growing staged file (the "no oras-output
    /// parser" contract — the staged file IS the meter).
    fn update_bytes(&self, env_id: &str, bytes: u64) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = guard.entries.get_mut(env_id) {
            if entry.status.state == MethodEnvState::Downloading {
                entry.status.bytes_downloaded = entry.status.bytes_downloaded.max(bytes);
            }
        }
    }

    /// Load the persisted state ledger (`<app_data>/txr-envs/*.json`) into the
    /// in-memory registry. A `downloading` record is a crash leftover → the
    /// honest `not_downloaded`; a `ready` record is honoured only while its
    /// digest is still in the cache (DEC-17's "no automatic eviction" makes
    /// `ready` survive); a `failed` record keeps its error.
    fn load_persisted(&self) {
        let dir = state_dir();
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return; // first run: nothing to load
        };
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut loaded = 0usize;
        for entry in rd.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str().and_then(|n| n.strip_suffix(".json")) else {
                continue;
            };
            if !is_valid_env_id(name) {
                continue; // never a state file for an id we would refuse anyway
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let Ok(record) = serde_json::from_slice::<PersistedEnv>(&bytes) else {
                tracing::warn!(path = %entry.path().display(), "txr env state file unreadable");
                continue;
            };
            let cached_ok = record
                .digest
                .as_deref()
                .map(crate::modules::rootfs::cache::has_digest)
                .unwrap_or(false);
            let state = match (&record.state, cached_ok) {
                (MethodEnvState::Failed, false) => MethodEnvState::Failed,
                _ if cached_ok => MethodEnvState::Ready,
                _ => MethodEnvState::NotDownloaded,
            };
            let entry = guard
                .entries
                .entry(record.env_id.clone())
                .or_insert_with(|| Entry::new(record.env_id.clone(), record.kind));
            // A persisted record is the INITIAL value; an entry the process
            // already knows (the manager is single-instance) always wins.
            if entry.attempt == 0 && entry.status.state == MethodEnvState::NotDownloaded {
                entry.status.kind = record.kind;
                entry.status.state = state;
                entry.status.digest = record.digest.clone();
                entry.status.error = match state {
                    MethodEnvState::Failed => record.error.as_ref().map(|e| e.message.clone()),
                    _ => None,
                };
                entry.last_error = record.error.clone();
                loaded += 1;
            }
        }
        drop(guard);
        if loaded > 0 {
            tracing::info!(
                count = loaded,
                "txr method-env manager: loaded persisted states"
            );
        }
    }

    /// Atomically replace the state file of `env_id` (tmp + rename in the same
    /// dir). Best-effort: a failed write costs the restart-persistence, never
    /// the run.
    fn persist_locked(&self, guard: &mut std::sync::MutexGuard<'_, Inner>, env_id: &str) {
        let dir = state_dir();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(error = %e, "txr env state dir");
            return;
        }
        let Some(entry) = guard.entries.get(env_id) else {
            return;
        };
        let record = PersistedEnv {
            env_id: env_id.to_string(),
            kind: entry.status.kind,
            state: entry.status.state,
            digest: entry.status.digest.clone(),
            error: if entry.status.state == MethodEnvState::Failed {
                entry.last_error.clone()
            } else {
                None
            },
            last_used: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        let Some(json) = serde_json::to_vec_pretty(&record).ok() else {
            return;
        };
        let path = state_file(env_id);
        let tmp = path.with_file_name(format!(".{env_id}.json.tmp"));
        if std::fs::write(&tmp, &json).is_err() {
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            tracing::warn!(path = %path.display(), error = %e, "txr env state file write");
        }
    }
}

impl Default for MethodEnvManager {
    fn default() -> Self {
        Self::with_seams(MethodEnvSeams::default())
    }
}

impl Entry {
    fn new(env_id: String, kind: EnvKind) -> Self {
        Entry {
            status: MethodEnvStatus {
                env_id,
                kind,
                state: MethodEnvState::NotDownloaded,
                bytes_downloaded: 0,
                bytes_total: None,
                digest: None,
                mounted: false,
                error: None,
            },
            attempt: 0,
            worker_active: false,
            cancel: None,
            mounted_dir: None,
            last_error: None,
        }
    }
}

fn unknown_status(env_id: &str) -> MethodEnvStatus {
    MethodEnvStatus {
        env_id: env_id.to_string(),
        kind: EnvKind::Unknown,
        state: MethodEnvState::NotDownloaded,
        bytes_downloaded: 0,
        bytes_total: None,
        digest: None,
        mounted: false,
        error: None,
    }
}

// ────────────────────────────── OCI reference grammar ─────────────────────────

/// The two compiled registry prefixes (the shipped namespaces on `ghcr.io`).
/// A release manager's allowed set is byte-identical to this (locked by the
/// parity test); a debug seam manager accepts BOTH spellings — its own (a
/// fixture spelling the seam host directly) and the compiled ones, which it
/// maps onto its own host (the seam's contract: "registry HOST to fetch from
/// instead of ghcr.io", with the compiled namespace/repo names kept — the
/// engine's ref builders emit exactly those namespaces).
fn compiled_registry_prefixes() -> Vec<String> {
    vec![
        format!("{TXR_REGISTRY_HOST}/{TXR_REGISTRY_NAMESPACE}/{TXR_ENVS_REPO}"),
        format!("{TXR_REGISTRY_HOST}/{TXR_REGISTRY_NAMESPACE}/{TXR_LAYERS_REPO}"),
    ]
}

/// Parse + validate an OCI reference against THIS manager's allowed prefixes
/// ([`registry_prefixes`]; release = the two compiled txr registries).
///
/// This mirrors [`super::stack::validate_oci_ref`] in every grammar decision
/// (the same tag/digest/component rules, same `ENV_REF_HOST_UNALLOWED`
/// refusal); the only difference is the prefix set the debug seam may
/// re-point. The parity unit test locks the release default against the
/// frozen `stack` grammar, so the two cannot silently drift — the
/// `env_id.rs` single-sourcing discipline, applied as a test.
///
/// Under a DEBUG seam (a different registry host):
/// * a ref spelling the seam host directly parses to itself (the fixture/
///   test shape, as before ITEM-2);
/// * a ref spelling the COMPILED namespaces is accepted and its
///   `registry_base` is mapped onto the seam host's same-namespace prefix —
///   the shape the engine's own ref builders
///   ([`crate::modules::execution_engine::orchestrator::base_env_ref`];
///   `layer_env_ref` its sibling) emit in production. Without the mapping the
///   wired app would refuse its own refs the moment the seam is set (ITEM-2
///   caught this in the acceptance test).
/// A ref on a host outside BOTH sets is refused identically with or without
/// the seam.
pub(crate) fn parse_oci_ref(
    oci_ref: &str,
    seams: &MethodEnvSeams,
) -> Result<OciRefParts, AppError> {
    let effective = registry_prefixes(seams);
    match parse_oci_ref_against(oci_ref, &effective) {
        Ok(parts) => Ok(parts),
        Err(effective_err) => {
            let compiled = compiled_registry_prefixes();
            if compiled == effective {
                return Err(effective_err);
            }
            let mut parts = parse_oci_ref_against(oci_ref, &compiled).map_err(|_| effective_err)?;
            let idx = compiled
                .iter()
                .position(|p| p.as_str() == parts.registry_base)
                .expect("a compiled match is one of the compiled prefixes");
            parts.registry_base = effective[idx].clone();
            Ok(parts)
        }
    }
}

fn parse_oci_ref_against(oci_ref: &str, prefixes: &[String]) -> Result<OciRefParts, AppError> {
    let refused = |why: &str| {
        Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_REF_HOST_UNALLOWED_CODE,
            format!("OCI reference {oci_ref:?} is refused: {why}"),
        ))
    };

    let mut name = oci_ref;
    let mut digest = None;
    if let Some((n, d)) = name.rsplit_once('@') {
        let hex = d.strip_prefix("sha256:").unwrap_or("");
        if !is_sha256_hex(&hex) {
            return refused(&format!(
                "the reference digest {d:?} is not sha256:<64 lowercase hex>"
            ));
        }
        digest = Some(hex.to_string());
        name = n;
    }
    let mut tag: Option<String> = None;
    if let Some((n, t)) = name.rsplit_once(':') {
        if !t.contains('/') {
            tag = Some(t.to_string());
            name = n;
        }
    }
    if let Some(t) = tag.as_deref() {
        if !is_valid_oci_tag(t) {
            return refused("the tag does not match the OCI tag grammar");
        }
    }

    for prefix in prefixes {
        let Some(rest) = name
            .strip_prefix(prefix.as_str())
            .and_then(|r| r.strip_prefix('/'))
        else {
            continue;
        };
        if rest.contains('/') {
            return refused("nested repository paths are not part of the txr env registries");
        }
        if !is_valid_env_id(rest) {
            return refused("the repository component is not a valid env id");
        }
        return Ok(OciRefParts {
            registry_base: prefix.clone(),
            repo: rest.to_string(),
            tag,
            digest,
        });
    }
    refused("host/prefix not in the compiled txr registries")
}

/// The kind/namespace consistency check (INV-2): a Base claim must reference
/// the base registry, a Layer claim the layer registry, and Unknown is never
/// mountable. The check is against the manager's OWN prefix set (the debug
/// seam re-points base and layer namespaces at the same loopback host, keeping
/// the distinction intact).
fn check_kind(parts: &OciRefParts, kind: EnvKind, seams: &MethodEnvSeams) -> Result<(), AppError> {
    let prefixes = registry_prefixes(seams);
    let expected = match kind {
        EnvKind::Base => &prefixes[0],
        EnvKind::Layer => &prefixes[1],
        EnvKind::Unknown => {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                ENV_KIND_INVALID_CODE,
                "the env kind is unknown; the caller must classify the artifact as base or layer",
            ));
        }
    };
    if &parts.registry_base != expected {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_KIND_INVALID_CODE,
            format!(
                "a {kind:?} artifact cannot be mounted from a {} reference; the declared \
                 kind and the reference's registry namespace disagree",
                parts.registry_base
            ),
        ));
    }
    Ok(())
}

/// The digest-addressed pull ref: the ref's own `@sha256:` when pinned (no
/// resolve — DEC-3), else the tag resolved against the registry. A ref with
/// neither is refused: a runtime pull must never fall back to a moving
/// `latest` (the catalogue pins every download).
fn pull_ref_for(
    parts: &OciRefParts,
    r: &EnvRef,
    seams: &MethodEnvSeams,
    deadline_at: Instant,
) -> Result<String, AppError> {
    if parts.digest.is_some() {
        return Ok(r.oci_ref.clone());
    }
    let tag = parts
        .tag
        .clone()
        .or_else(|| r.tag.clone().filter(|t| !t.is_empty()));
    let Some(tag) = tag else {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!(
                "the reference {:?} carries neither a tag nor a digest; the catalogue must \
                 pin the environment (DEC-3: a runtime pull is never left on a bare ref)",
                r.oci_ref
            ),
        ));
    };
    let resolve_ref = format!("{}/{}:{}", parts.registry_base, parts.repo, tag);
    let resolved = oras_resolve(&resolve_ref, deadline_at, seams)?;
    Ok(format!(
        "{}/{}@{}",
        parts.registry_base, parts.repo, resolved
    ))
}

// ────────────────────────────── tool resolution ───────────────────────────────

/// The first executable `<name>` (`<name>.exe` on Windows) found, in order:
/// the directory of the running executable (where the desktop bundle ships
/// `oras` as a Tauri sidecar, `bundle.externalBin`), then `<app_data>/bin`
/// (DEC-4 — an operator-placed tool), then `PATH` (a system install).
pub fn tool_bin(name: &str) -> Option<PathBuf> {
    let exe_dir = running_exe_dir();
    tool_bin_in(
        exe_dir.as_deref(),
        &crate::modules::rootfs::data_root().join("bin"),
        name,
        &std::env::var_os("PATH").unwrap_or_default(),
        std::env::consts::EXE_SUFFIX,
    )
}

/// The directory holding the running executable. Symlinks are resolved on
/// Unix so a linked launcher still finds the sidecar next to the real binary
/// (Windows keeps `current_exe` as is: canonicalising there yields `\\?\` paths).
fn running_exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    #[cfg(unix)]
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    exe.parent().map(Path::to_path_buf)
}

/// The pure core of [`tool_bin`], testable without touching the process:
/// `exe_dir`, then `app_data_bin`, then each `PATH` entry (split with the
/// platform's separator), looking for `<name><exe_suffix>`.
fn tool_bin_in(
    exe_dir: Option<&Path>,
    app_data_bin: &Path,
    name: &str,
    path: &std::ffi::OsStr,
    exe_suffix: &str,
) -> Option<PathBuf> {
    let file = format!("{name}{exe_suffix}");
    let path_dirs = std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty());
    exe_dir
        .map(Path::to_path_buf)
        .into_iter()
        .chain(std::iter::once(app_data_bin.to_path_buf()))
        .chain(path_dirs)
        .map(|dir| dir.join(&file))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && std::fs::metadata(path)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

// ────────────────────────────── air-gap seams ─────────────────────────────────

/// What a run consumes for a verified artifact already in the content-digest
/// cache. Linux: the squashfuse mount dir (`rootfs::ensure_ready_by_digest`).
/// macOS: the cached squashfs image itself — the method VM attaches it as a
/// read-only disk, so nothing is mounted on the host
/// (`service::run_method_in_stack`, macOS). Callers verified the bytes first.
fn ready_artifact_path(digest: &str) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "macos")]
    {
        crate::modules::rootfs::cached_image_by_digest(digest)
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::modules::rootfs::ensure_ready_by_digest(digest)
    }
}

/// Re-verify an environment image file against its pinned payload digest
/// (INV-1), for a caller that hands the FILE to something that reads it later.
/// On Linux a run reads the squashfuse mount of bytes verified when mounted;
/// the macOS method VM boots a per-run clone of the cached file, so its seam
/// verifies the clone — unless this process already verified that cache file
/// and its identity (device, inode, size, mtime, ctime) is unchanged — before
/// the boot. A replaced or corrupted file is refused, never booted under the
/// recorded digest.
pub fn verify_image_file(path: &Path, digest: &str) -> Result<(), AppError> {
    verify_payload_bytes(path, digest)
}

/// Whether a path [`ready_artifact_path`] (or a staged-dir seam) returned is
/// usable now: a mounted dir with `usr/` on Linux, the image file on macOS.
fn artifact_path_ready(path: &Path) -> bool {
    if cfg!(target_os = "macos") {
        path.is_file()
    } else {
        path.join("usr").exists()
    }
}

/// Whether the cached artifact for `digest` is usable without a new download:
/// mounted on Linux, present in the cache on macOS.
fn digest_ready(digest: &str) -> bool {
    use crate::modules::rootfs::cache;
    if cfg!(target_os = "macos") {
        cache::has_digest(digest)
    } else {
        crate::modules::rootfs::mount::is_mounted(&cache::digest_dir(digest))
    }
}

/// `TXR_ENV_ROOTFS_SQUASHFS__<env-id>` (exact env) or the bare
/// `TXR_ENV_ROOTFS_SQUASHFS` serving the env named by
/// `TXR_ENV_ROOTFS_SQUASHFS_ENV` (DEC-15 steps 1+3). The txr node has no
/// default env-id, so a bare artifact needs the explicit `_ENV` association.
fn seam_squashfs_for(env_id: &str) -> Option<PathBuf> {
    seam_path(SQUASHFS_SEAM, env_id, |k| std::env::var(k).ok())
}

/// `TXR_ENV_ROOTFS_DIR__<env-id>` (exact env) or the bare dir seam with the
/// `_ENV` association.
fn seam_rootfs_dir_for(env_id: &str) -> Option<PathBuf> {
    seam_path(ROOTFS_DIR_SEAM, env_id, |k| std::env::var(k).ok())
}

/// The shared per-env seam resolution (exact-var wins; bare var serves only
/// the env its `_ENV` names).
fn seam_path(key: &str, env_id: &str, read: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(p) = nonempty_path(&read(&format!("{key}{ENV_SEAM_SUFFIX}{env_id}"))) {
        return Some(p);
    }
    let bare = nonempty_path(&read(key))?;
    let served = read(&format!("{key}_ENV"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    (served == env_id).then_some(bare)
}

/// The refusal when a staged artifact serves a DIFFERENT env than requested
/// (never substituted — INV-2 / the shipped #189 rule). `None` when nothing is
/// staged anywhere: the caller falls through to the OCI path.
fn seam_refusal(env_id: &str) -> Option<AppError> {
    seam_refusal_with(env_id, &|k| std::env::var(k).ok(), &env_var_names())
}

fn seam_refusal_with(
    env_id: &str,
    read: &impl Fn(&str) -> Option<String>,
    names: &[String],
) -> Option<AppError> {
    // (a) A SIBLING env is staged under an exact per-env variable.
    for key in [SQUASHFS_SEAM, ROOTFS_DIR_SEAM] {
        if let Some(served) = suffixed_env_ids_for(key, names)
            .into_iter()
            .find(|e| e != env_id)
        {
            return Some(env_mismatch(key, env_id, &served, true));
        }
    }
    // (b) A bare artifact is staged and associated with a DIFFERENT env …
    for key in [SQUASHFS_SEAM, ROOTFS_DIR_SEAM] {
        if nonempty_path(&read(key)).is_none() {
            continue;
        }
        return Some(
            match read(&format!("{key}_ENV"))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            {
                Some(served) => env_mismatch(key, env_id, &served, false),
                // … or with no env at all (the txr node has no default env-id).
                None => AppError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    ENV_STAGED_UNASSOCIATED_CODE,
                    format!(
                        "`{key}` stages an environment but nothing says which env-id it serves, \
                     and this request wants {env_id:?}. The txr app has no default env-id \
                     (the base is always caller-named), so set `{key}_ENV=<env-id>` or stage \
                     this env explicitly with `{key}{ENV_SEAM_SUFFIX}{env_id}=<path>`."
                    ),
                ),
            },
        );
    }
    // (c) The per-env variable for THIS env is set but unusable (a typo'd
    // path, a missing file, a dir without `usr/`).
    for key in [SQUASHFS_SEAM, ROOTFS_DIR_SEAM] {
        if let Some(p) = nonempty_path(&read(&format!("{key}{ENV_SEAM_SUFFIX}{env_id}"))) {
            return Some(AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ENV_STAGED_UNUSABLE_CODE,
                format!(
                    "`{key}{ENV_SEAM_SUFFIX}{env_id}` is set to {} but that artifact is not \
                     usable (a pre-mounted dir must contain `usr/`; a squashfs must be a \
                     readable file). Refusing rather than falling back to another env's \
                     artifact or to a registry pull this deployment is air-gapped from.",
                    p.display()
                ),
            ));
        }
    }
    None
}

/// Every environment variable NAME in the process, as a stable list for the
/// sibling-enumeration leg of [`seam_refusal`] (a read-by-name interface cannot
/// enumerate). `vars_os`, not `vars`: the latter panics while iterating if ANY
/// variable in the process environment is non-UTF-8.
fn env_var_names() -> Vec<String> {
    std::env::vars_os()
        .map(|(k, _)| k)
        .filter_map(|k| k.into_string().ok())
        .collect()
}

/// The env-ids named by `<key>__<env>` variables, from an explicit name list
/// (the injected test map's keys in a test; the process env in production).
fn suffixed_env_ids_for(key: &str, names: &[String]) -> Vec<String> {
    let prefix = format!("{key}{ENV_SEAM_SUFFIX}");
    let mut out: Vec<String> = names
        .iter()
        .filter_map(|k| k.strip_prefix(&prefix))
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn nonempty_path(value: &Option<String>) -> Option<PathBuf> {
    value
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn env_mismatch(key: &str, requested: &str, served: &str, suffixed: bool) -> AppError {
    let staged_desc = if suffixed {
        format!("{key}{ENV_SEAM_SUFFIX}{served}")
    } else {
        key.to_string()
    };
    AppError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ENV_STAGED_MISMATCH_CODE,
        format!(
            "the locally staged environment serves {served:?}, but this request wants \
             {requested:?}. Refusing to substitute: the staged artifact carries {served:?}'s \
             interpreter and libraries. Stage the requested env with \
             `{key}{ENV_SEAM_SUFFIX}{requested}=<path>`, or unset `{staged_desc}` to fetch \
             {requested:?} from the registry."
        ),
    )
}

/// The digest a pre-mounted `TXR_ENV_ROOTFS_DIR` corresponds to, when — and
/// only when — the dir is the content-digest cache's own mount point for a
/// digest actually present in the cache (mirrors `env_image.rs`).
fn digest_from_cache_dir(dir: &Path) -> Option<String> {
    let cache = crate::modules::rootfs::cache::base_dir();
    let candidates = [
        Some(dir.to_path_buf()),
        dir.parent().map(|p| p.to_path_buf()),
    ];
    for cand in candidates.into_iter().flatten() {
        if cand.parent() != Some(cache.as_path()) {
            continue;
        }
        let Some(hex) = cand.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if crate::modules::rootfs::cache::has_digest(hex) {
            return Some(hex.to_string());
        }
    }
    None
}

// ────────────────────────────── state ledger path ─────────────────────────────

/// `<app_data>/txr-envs/` (DEC-10).
fn state_dir() -> PathBuf {
    crate::modules::rootfs::data_root().join("txr-envs")
}

/// `<app_data>/txr-envs/<env-id>.json` — reachable only for a validated env-id
/// (the id grammar is the path hygiene: no `/`, no empty components, so the
/// file name can never escape the state dir).
fn state_file(env_id: &str) -> PathBuf {
    state_dir().join(format!("{env_id}.json"))
}

// ────────────────────────────── helper primitives ─────────────────────────────

/// Wall-clock budget gate: each host-tool / io step checks the total budget, so
/// a sequence of individually-quick steps cannot silently overrun it.
fn remaining(deadline_at: Instant, step: &str) -> Result<Duration, AppError> {
    let now = Instant::now();
    if now >= deadline_at {
        return Err(AppError::new(
            StatusCode::GATEWAY_TIMEOUT,
            ENV_STAGING_TIMEOUT_CODE,
            format!("environment staging budget exhausted before {step}"),
        ));
    }
    Ok(deadline_at - now)
}

/// The sha256 (bare lowercase hex) of a file's bytes, memoized per
/// (path, len, mtime) — hashing a hundreds-of-MB squashfs is ~1 s and the pin
/// check runs on every ensure; a replaced file re-hashes (the key changes).
fn sha256_payload(path: &Path) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};

    static DIGESTS: Mutex<Option<HashMap<(PathBuf, u64, i128), String>>> = Mutex::new(None);

    let meta = std::fs::metadata(path).map_err(|e| {
        AppError::new(
            StatusCode::NOT_FOUND,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!(
                "cannot read the environment artifact {}: {e}",
                path.display()
            ),
        )
    })?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_VERIFY_FAILED_CODE,
            format!(
                "the environment artifact {} is not a non-empty file",
                path.display()
            ),
        ));
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    let key = (path.to_path_buf(), meta.len(), mtime);
    if let Ok(g) = DIGESTS.lock() {
        if let Some(hit) = g.as_ref().and_then(|m| m.get(&key)).cloned() {
            return Ok(hit);
        }
    }

    let mut f = std::fs::File::open(path).map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!("open {}: {e}", path.display()),
        )
    })?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!("hash {}: {e}", path.display()),
        )
    })?;
    let hex = hex::encode(hasher.finalize());
    if let Ok(mut g) = DIGESTS.lock() {
        g.get_or_insert_with(HashMap::new).insert(key, hex.clone());
    }
    Ok(hex)
}

/// INV-1's tamper gate: the bytes must hash to the caller's pinned digest,
/// ALWAYS — a mismatch is `ENV_VERIFY_FAILED` before any cache entry or mount.
fn verify_payload_bytes(path: &Path, expected: &str) -> Result<(), AppError> {
    let actual = sha256_payload(path)?;
    if actual != expected {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_VERIFY_FAILED_CODE,
            format!(
                "environment artifact {} does not match its pinned digest: expected {}, \
                 computed {} — refusing to mount a tampered or swapped environment",
                path.display(),
                expected,
                actual
            ),
        ));
    }
    Ok(())
}

/// Stage a verified payload into the content-digest cache (atomic rename; a
/// racing sibling that published the SAME digest is fine).
fn stage_payload(src: &Path, hex: &str) -> Result<(), AppError> {
    let dest = crate::modules::rootfs::cache::squashfs_path_for(hex);
    let dir = dest.parent().ok_or_else(|| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ENV_REPOSITORY_UNKNOWN_CODE,
            "the cache placement path has no parent dir",
        )
    })?;
    std::fs::create_dir_all(dir).map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!("mkdir cache: {e}"),
        )
    })?;
    let tmp = dir.join(format!(".stage-{hex}-{}", uuid::Uuid::new_v4()));
    std::fs::copy(src, &tmp).map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!("stage {}: {e}", src.display()),
        )
    })?;
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        if !crate::modules::rootfs::cache::has_digest(hex) {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_REPOSITORY_UNKNOWN_CODE,
                format!("stage {} -> {}: {e}", src.display(), dest.display()),
            ));
        }
    }
    Ok(())
}

/// RAII scratch-dir cleanup on every exit path (a failed pull never leaks a
/// `.pull-*` dir under the cache).
struct TmpDirGuard(PathBuf);
impl Drop for TmpDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The largest regular file in `dir` — the growing staged payload behind the
/// byte counter.
fn staged_payload_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .max()
        .unwrap_or(0)
}

/// Run a host tool with a bounded wall-clock, a cancellation flag and a
/// progress reporter — the manager's sibling of `env_image.rs`'s `run`, plus:
///
/// - `cancel` is polled between reap polls; when set the child is killed and
///   reaped and the call returns [`ENV_DOWNLOAD_CANCELLED_CODE`] (cancel never
///   leaves a zombie or a hung child);
/// - `on_progress(bytes)` fires when the staging dir's payload grows (the
///   byte counter — no oras-output parser);
/// - a timeout kills the child and returns [`ENV_STAGING_TIMEOUT_CODE`] (a
///   non-zero tool exit is `ENV_REPOSITORY_UNKNOWN_CODE`).
fn run_tool(
    tool: &Path,
    args: &[String],
    timeout: Duration,
    cancel: &AtomicBool,
    progress_dir: Option<&Path>,
    on_progress: &mut dyn FnMut(u64),
) -> Result<String, AppError> {
    use std::process::Stdio;

    let started = Instant::now();
    let mut child = std::process::Command::new(tool)
        .args(args)
        .env_clear()
        .env(
            "PATH",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into()),
        )
        .env(
            "HOME",
            std::env::var("HOME").unwrap_or_else(|_| "/root".into()),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_TOOL_MISSING_CODE,
                // qa-fixes4 ITEM-1: the old text named the tool's path and
                // the host dependency — internal facts; plain now (the
                // boundary sanitiser is the backstop, the detail stays in
                // the log).
                format!("The method environment is not available yet ({e})"),
            )
        })?;

    let so = child.stdout.take();
    let se = child.stderr.take();
    let h_out = std::thread::spawn(move || {
        so.map(|s| drain_capped(s, TOOL_OUTPUT_CAP))
            .unwrap_or_default()
    });
    let h_err = std::thread::spawn(move || {
        se.map(|s| drain_capped(s, TOOL_OUTPUT_CAP))
            .unwrap_or_default()
    });

    let deadline = started + timeout;
    let mut last_progress = 0u64;
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait(); // reap — never leave a zombie behind
            break None;
        }
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ENV_REPOSITORY_UNKNOWN_CODE,
                    format!("`{}` wait failed: {e}", tool.display()),
                ));
            }
        }
        if let Some(dir) = progress_dir {
            let bytes = staged_payload_bytes(dir);
            if bytes != last_progress {
                last_progress = bytes;
                on_progress(bytes);
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let stdout = h_out.join().unwrap_or_default();
    let stderr = h_err.join().unwrap_or_default();

    let Some(status) = status else {
        let mut tail = String::from_utf8_lossy(&stderr).into_owned();
        tail.truncate(400);
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                ENV_DOWNLOAD_CANCELLED_CODE,
                format!("the environment download was cancelled; last output: {tail}"),
            ));
        }
        return Err(AppError::new(
            StatusCode::GATEWAY_TIMEOUT,
            ENV_STAGING_TIMEOUT_CODE,
            format!(
                "`{}` did not complete within {}s and was killed (registry unreachable, DNS \
                 blackhole, or a stalled transfer){}",
                tool.display(),
                timeout.as_secs(),
                if tail.trim().is_empty() {
                    String::new()
                } else {
                    format!("; last output: {tail}")
                }
            ),
        ));
    };
    if !status.success() {
        let mut msg = String::from_utf8_lossy(&stderr).into_owned();
        msg.truncate(600);
        return Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!("`{}` failed: {msg}", tool.display()),
        ));
    }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

/// Read up to `cap` bytes, then drain the rest to a sink (the child must never
/// block on a full pipe, and must not balloon our memory either).
fn drain_capped(mut r: impl std::io::Read, cap: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::new();
    let _ = (&mut r).take(cap as u64).read_to_end(&mut buf);
    let _ = std::io::copy(&mut r, &mut std::io::sink());
    buf
}

/// `oras resolve <ref>` → the newest content digest (`sha256:<hex>`).
fn oras_resolve(
    resolve_ref: &str,
    deadline_at: Instant,
    seams: &MethodEnvSeams,
) -> Result<String, AppError> {
    let tool = tool_bin("oras").ok_or_else(|| {
        AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ENV_TOOL_MISSING_CODE,
            "The method environment is not available yet",
        )
    })?;
    let mut args = vec!["resolve".to_string()];
    if plain_http(seams) {
        args.push("--plain-http".to_string());
    }
    args.push(resolve_ref.to_string());
    let budget = remaining(deadline_at, "oras resolve")?.min(TOOL_METADATA_TIMEOUT);
    let out = run_tool(
        &tool,
        &args,
        budget,
        &AtomicBool::new(false),
        None,
        &mut |_| {},
    )?;
    if !out.starts_with("sha256:") {
        return Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            ENV_REPOSITORY_UNKNOWN_CODE,
            format!("`oras resolve {resolve_ref}` did not return a sha256 digest: {out}"),
        ));
    }
    Ok(out)
}

/// `oras pull` the artifact into the staging dir and return the extracted
/// payload path (the single `.squashfs` layer the artifact carried).
fn pull_payload(
    tool: &Path,
    pull_ref: &str,
    staging: &Path,
    deadline_at: Instant,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64),
    seams: &MethodEnvSeams,
) -> Result<PathBuf, AppError> {
    let staging_s = staging.to_string_lossy().into_owned();
    let mut args = vec!["pull".to_string()];
    if plain_http(seams) {
        args.push("--plain-http".to_string());
    }
    args.push("-o".to_string());
    args.push(staging_s);
    args.push(pull_ref.to_string());
    run_tool(
        tool,
        &args,
        remaining(deadline_at, "oras pull")?,
        cancel,
        Some(staging),
        on_progress,
    )?;
    std::fs::read_dir(staging)
        .map_err(|e| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ENV_REPOSITORY_UNKNOWN_CODE,
                format!("read staging {}: {e}", staging.display()),
            )
        })?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|x| x == "squashfs"))
        .ok_or_else(|| {
            AppError::new(
                StatusCode::BAD_GATEWAY,
                ENV_REPOSITORY_UNKNOWN_CODE,
                "the pulled environment artifact contained no .squashfs layer",
            )
        })
}

/// Plain-HTTP fetch for the debug loopback seam (a release build never turns
/// this on — GHCR is always HTTPS).
fn plain_http(seams: &MethodEnvSeams) -> bool {
    #[cfg(debug_assertions)]
    {
        seams.registry.is_some()
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = seams;
        false
    }
}

// ────────────────────────────── Unit tests ────────────────────────────────────

// Lifecycle ids: method_env ITEM-3 (TESTS.md TEST-10 + the item's "pure parts
// and tamper/path checks" wording; the real-execute TEST-06/07/11 live in
// `tests/sandbox/method_stack_test.rs`, ITEM-7). No bwrap, no squashfuse, no
// network: the OCI path is driven by a stub `oras` in an isolated data root,
// and every env/seam/tool lookup is exercised through its injectable core.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::rootfs::{scoped_data_root, DataRootGuard};
    use std::collections::BTreeMap;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("txr-method-env-{}", uuid::Uuid::new_v4()))
    }

    /// A test data root with `<root>/bin/` created, scoped to THIS thread (the
    /// thread-scoped override is invisible to sibling test threads).
    fn data_root() -> (PathBuf, DataRootGuard) {
        let root = scratch();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let guard = scoped_data_root(root.clone());
        (root, guard)
    }

    fn hex_of(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(bytes))
    }

    /// ITEM-2 (qa-hardening): the dev-registry seam is pure env → seams — the
    /// loopback host lands in [`MethodEnvSeams::registry`], the namespace and
    /// repo names stay compiled, the air-gap seams stay honored, and an unset/
    /// blank variable is the production default (a debug build with nothing
    /// configured is byte-identical to a release manager's seams).
    #[test]
    #[cfg(debug_assertions)]
    fn dev_registry_seam_maps_env_to_registry_host_only() {
        let read = |v: &str| {
            let mut m = std::collections::HashMap::new();
            m.insert("TXR_METHOD_ENV_REGISTRY".to_string(), "127.0.0.1:5055".to_string());
            m.get(v).cloned()
        };
        let seams = dev_seams_from(&read);
        assert_eq!(seams.registry.as_deref(), Some("127.0.0.1:5055"));
        assert!(!seams.bypass_air_gap_env, "the dev registry never bypasses the air-gap seams");
        let prefixes = registry_prefixes(&seams);
        assert_eq!(prefixes[0], "127.0.0.1:5055/tinnlab/txresbench-env");
        assert_eq!(prefixes[1], "127.0.0.1:5055/tinnlab/txr-method-env-layers");
        assert_eq!(
            effective_base_prefix(),
            "ghcr.io/tinnlab/txresbench-env",
            "the process env has no dev registry set in this test process"
        );

        let unset = dev_seams_from(&|_| None);
        assert_eq!(unset.registry, None);
        let blank = dev_seams_from(&|_| Some("  ".to_string()));
        assert_eq!(blank.registry, None, "a blank value is not a registry host");
    }

    /// ITEM-2 (qa-hardening): under the dev seam the parser accepts the
    /// COMPILED spellings the engine's ref builders emit (base_env_ref /
    /// layer_env_ref — `ghcr.io/…`) and maps them onto the seam host, so the
    /// wired app's own refs resolve against the dev registry; the seam-host
    /// spelling parses to itself; a host outside both sets stays refused; and
    /// release (no seam) is untouched by construction.
    #[test]
    fn dev_seam_maps_the_compiled_spelling_onto_the_seam_host() {
        let seam = MethodEnvSeams {
            registry: Some("127.0.0.1:5055".to_string()),
            bypass_air_gap_env: true,
        };
        let base = parse_oci_ref("ghcr.io/tinnlab/txresbench-env/base-py:2.0-amd64", &seam)
            .expect("the engine's base spelling is accepted under the seam");
        assert_eq!(base.registry_base, "127.0.0.1:5055/tinnlab/txresbench-env");
        assert_eq!(base.repo, "base-py");
        assert_eq!(base.tag.as_deref(), Some("2.0-amd64"));
        assert_eq!(
            parse_oci_ref("ghcr.io/tinnlab/txresbench-env/base-py@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &seam)
                .expect("digest-addressed compiled spelling too")
                .registry_base,
            "127.0.0.1:5055/tinnlab/txresbench-env"
        );
        let layer = parse_oci_ref(
            "ghcr.io/tinnlab/txr-method-env-layers/txr-dev-fixture:1.0.0-amd64",
            &seam,
        )
        .expect("the engine's layer spelling is accepted under the seam");
        assert_eq!(layer.registry_base, "127.0.0.1:5055/tinnlab/txr-method-env-layers");
        assert_eq!(layer.repo, "txr-dev-fixture");
        // The seam-host spelling still parses to itself (fixture shape).
        let direct = parse_oci_ref(
            "127.0.0.1:5055/tinnlab/txr-method-env-layers/txr-dev-fixture:1.0.0-amd64",
            &seam,
        )
        .expect("the seam-host spelling is accepted directly");
        assert_eq!(direct.registry_base, "127.0.0.1:5055/tinnlab/txr-method-env-layers");
        // A host outside both sets is refused under the seam too.
        let err = parse_oci_ref("evil.example.com/tinnlab/txr-method-env-layers/x:1", &seam)
            .expect_err("other hosts stay refused");
        assert_eq!(err.error_code(), ENV_REF_HOST_UNALLOWED_CODE);
        // Release (no seam): the compiled spelling maps to itself.
        let release = MethodEnvSeams::default();
        let base = parse_oci_ref("ghcr.io/tinnlab/txresbench-env/base-py:2.0-amd64", &release)
            .expect("release accepts the compiled spelling");
        assert_eq!(base.registry_base, "ghcr.io/tinnlab/txresbench-env");
    }

    /// Write an executable stub script into `<data>/bin/oras`.
    fn stub_oras(root: &Path, script: &str) {
        let path = root.join("bin").join("oras");
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// A stub `oras` for the loopback-style manager: `resolve` prints the
    /// pinned digest; `pull` writes a start marker, sleeps
    /// `pull_sleep_s` (to make the pull cancellable mid-flight), then copies
    /// `payload` to `<the -o dir>/rootfs.squashfs`.
    fn oras_script(payload: &Path, digest: &str, pull_sleep_s: u64, marker: &Path) -> String {
        let payload = payload.display();
        let marker = marker.display();
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"resolve\" ]; then\n\
             \x20 echo sha256:{digest}\n\
             \x20 exit 0\n\
             fi\n\
             if [ \"$1\" = \"pull\" ]; then\n\
             \x20 echo started > {marker}\n\
             \x20 if [ {pull_sleep_s} -gt 0 ]; then exec sleep {pull_sleep_s}; fi\n\
             \x20 out=\"\"\n\
             \x20 prev=\"\"\n\
             \x20 for a in \"$@\"; do\n\
             \x20 \x20 if [ \"$prev\" = \"-o\" ]; then out=\"$a\"; fi\n\
             \x20 \x20 prev=\"$a\"\n\
             \x20 done\n\
             \x20 cp {payload} \"$out/rootfs.squashfs\"\n\
             \x20 exit 0\n\
             fi\n\
             exit 1\n"
        )
    }

    /// A first-class loopback-style layer ref (the seam's host, the compiled
    /// namespace + repo).
    fn layer_ref(env_id: &str, tag: &str, digest: &str) -> EnvRef {
        EnvRef {
            oci_ref: format!("127.0.0.1:5000/tinnlab/txr-method-env-layers/{env_id}:{tag}"),
            digest: digest.to_string(),
            tag: Some(tag.to_string()),
        }
    }

    /// Wait (bounded) until `pred` holds; panics with `what` on timeout.
    fn wait_until(what: &str, pred: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !pred() {
            assert!(Instant::now() < deadline, "{what}: timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn loopback_seams() -> MethodEnvSeams {
        MethodEnvSeams {
            registry: Some("127.0.0.1:5000".to_string()),
            bypass_air_gap_env: true,
        }
    }

    // ── tool_bin (TEST-10) ────────────────────────────────────────────────

    /// Write an executable stub `<dir>/<file>` (mode 0755 on Unix).
    fn exec_stub(dir: &Path, file: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(file);
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    fn path_of(dirs: &[&Path]) -> std::ffi::OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn tool_bin_prefers_the_executable_dir_over_app_data_bin_and_path() {
        let (root, _guard) = data_root();
        let exe_dir = root.join("exe-dir");
        let app_bin = root.join("bin");
        let on_path = root.join("on-path");
        let sidecar = exec_stub(&exe_dir, "oras");
        exec_stub(&app_bin, "oras");
        exec_stub(&on_path, "oras");
        let path = path_of(&[&on_path]);
        let resolved = tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, "").expect("resolved");
        assert_eq!(resolved, sidecar, "the sidecar next to the executable wins");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tool_bin_prefers_app_data_bin_over_path() {
        let (root, _guard) = data_root();
        let exe_dir = root.join("exe-dir");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let app_bin = root.join("bin");
        let in_app_bin = exec_stub(&app_bin, "oras");
        let also = root.join("also-bin");
        exec_stub(&also, "oras");
        let path = path_of(&[&app_bin, &also]);
        let resolved = tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, "").expect("resolved");
        assert_eq!(
            resolved, in_app_bin,
            "app_data/bin wins over PATH when no sidecar"
        );
        let resolved = tool_bin_in(None, &app_bin, "oras", &path, "").expect("resolved");
        assert_eq!(
            resolved, in_app_bin,
            "no executable dir known: app_data/bin first"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tool_bin_falls_back_to_path_when_absent_from_exe_dir_and_app_data_bin() {
        let (root, _guard) = data_root();
        let exe_dir = root.join("exe-dir");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let app_bin = root.join("bin");
        let empty = root.join("empty-path-dir");
        std::fs::create_dir_all(&empty).unwrap();
        let also = root.join("also-bin");
        let on_path = exec_stub(&also, "oras");
        let path = path_of(&[&empty, &also]);
        let resolved = tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, "").expect("resolved");
        assert_eq!(resolved, on_path, "PATH fallback, entries in order");
        assert!(
            tool_bin_in(
                Some(&exe_dir),
                &app_bin,
                "definitely-absent",
                std::ffi::OsStr::new(""),
                ""
            )
            .is_none(),
            "an empty PATH resolves nothing"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(unix)]
    fn tool_bin_skips_a_non_executable_sidecar() {
        let (root, _guard) = data_root();
        let exe_dir = root.join("exe-dir");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(exe_dir.join("oras"), "not executable").unwrap();
        let app_bin = root.join("bin");
        let in_app_bin = exec_stub(&app_bin, "oras");
        let resolved = tool_bin_in(
            Some(&exe_dir),
            &app_bin,
            "oras",
            std::ffi::OsStr::new(""),
            "",
        )
        .expect("resolved");
        assert_eq!(resolved, in_app_bin);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Windows naming: with the `.exe` suffix only `oras.exe` resolves, at
    /// every step of the order; a bare `oras` file is not the tool.
    #[test]
    fn tool_bin_uses_the_exe_suffix_at_every_step() {
        let (root, _guard) = data_root();
        let exe_dir = root.join("exe-dir");
        let app_bin = root.join("bin");
        let on_path = root.join("on-path");
        exec_stub(&exe_dir, "oras");
        exec_stub(&app_bin, "oras");
        exec_stub(&on_path, "oras");
        let path = path_of(&[&on_path]);
        assert!(
            tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, ".exe").is_none(),
            "no oras.exe anywhere: nothing resolves"
        );
        let on_path_exe = exec_stub(&on_path, "oras.exe");
        assert_eq!(
            tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, ".exe"),
            Some(on_path_exe)
        );
        let app_bin_exe = exec_stub(&app_bin, "oras.exe");
        assert_eq!(
            tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, ".exe"),
            Some(app_bin_exe)
        );
        let sidecar_exe = exec_stub(&exe_dir, "oras.exe");
        assert_eq!(
            tool_bin_in(Some(&exe_dir), &app_bin, "oras", &path, ".exe"),
            Some(sidecar_exe)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `tool_bin` itself reads the running executable's directory: a stub
    /// placed next to the test binary is what it resolves.
    #[test]
    fn tool_bin_reads_the_running_executable_dir() {
        let (root, _guard) = data_root();
        let exe_dir = running_exe_dir().expect("the test binary has a directory");
        let name = format!("txr-tool-bin-probe-{}", uuid::Uuid::new_v4());
        let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        let stub = exec_stub(&exe_dir, &file);
        let resolved = tool_bin(&name);
        let _ = std::fs::remove_file(&stub);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(resolved, Some(stub));
    }

    // ── persistence / state ledger ─────────────────────────────────────────

    #[test]
    fn persisted_ready_state_survives_a_manager_reinit_while_cached() {
        let (root, _guard) = data_root();
        let digest = hex_of(b"sqfs-bytes");
        // A non-empty cache file is `has_digest`-true (the mount probe is not
        // part of the persisted-state rule).
        let cache_file = crate::modules::rootfs::cache::squashfs_path_for(&digest);
        std::fs::create_dir_all(cache_file.parent().unwrap()).unwrap();
        std::fs::write(&cache_file, b"sqfs-bytes").unwrap();

        let record = PersistedEnv {
            env_id: "fixture-env".to_string(),
            kind: EnvKind::Layer,
            state: MethodEnvState::Ready,
            digest: Some(digest.clone()),
            error: None,
            last_used: 1_700_000_000,
        };
        std::fs::create_dir_all(state_dir()).unwrap();
        std::fs::write(
            state_file("fixture-env"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let m = MethodEnvManager::new();
        let s = m.status("fixture-env");
        assert_eq!(s.state, MethodEnvState::Ready, "ready survives a restart");
        assert_eq!(s.kind, EnvKind::Layer);
        assert_eq!(s.digest.as_deref(), Some(digest.as_str()));
        assert!(m.list().iter().any(|x| x.env_id == "fixture-env"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn persisted_ready_state_drops_to_not_downloaded_when_evicted() {
        let (root, _guard) = data_root();
        let digest = hex_of(b"gone");
        let record = PersistedEnv {
            env_id: "fixture-env".to_string(),
            kind: EnvKind::Base,
            state: MethodEnvState::Ready,
            digest: Some(digest.clone()),
            error: None,
            last_used: 1_700_000_000,
        };
        std::fs::create_dir_all(state_dir()).unwrap();
        std::fs::write(
            state_file("fixture-env"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let m = MethodEnvManager::new();
        let s = m.status("fixture-env");
        assert_eq!(
            s.state,
            MethodEnvState::NotDownloaded,
            "a ready record whose digest is no longer cached is not_downloaded (DEC-17)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn persisted_downloading_state_loads_as_not_downloaded() {
        let (root, _guard) = data_root();
        let record = PersistedEnv {
            env_id: "fixture-env".to_string(),
            kind: EnvKind::Layer,
            state: MethodEnvState::Downloading,
            digest: None,
            error: None,
            last_used: 1_700_000_000,
        };
        std::fs::create_dir_all(state_dir()).unwrap();
        std::fs::write(
            state_file("fixture-env"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let m = MethodEnvManager::new();
        assert_eq!(
            m.status("fixture-env").state,
            MethodEnvState::NotDownloaded,
            "a crash-mid-download record is never left 'downloading' after a restart"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_and_forget_drops_the_record_and_returns_its_digest() {
        let (root, _guard) = data_root();
        let digest = hex_of(b"some-bytes");
        let record = PersistedEnv {
            env_id: "fixture-env".to_string(),
            kind: EnvKind::Base,
            state: MethodEnvState::Ready,
            digest: Some(digest.clone()),
            error: None,
            last_used: 1_700_000_000,
        };
        std::fs::create_dir_all(state_dir()).unwrap();
        std::fs::write(
            state_file("fixture-env"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let m = MethodEnvManager::new();
        assert_eq!(
            m.status("fixture-env").kind,
            EnvKind::Base,
            "fixture precondition: the record loaded"
        );
        // The DELETE route's state half: the recorded digest (the caller's
        // `?prune=true` cache key) comes back, the record is gone.
        assert_eq!(
            m.cancel_and_forget("fixture-env").as_deref(),
            Some(digest.as_str()),
            "the last recorded digest is returned for the cache-prune half"
        );
        assert_eq!(
            m.status("fixture-env").kind,
            EnvKind::Unknown,
            "a forgotten env is unknown again (there is no record to classify)"
        );
        assert_eq!(
            m.status("fixture-env").state,
            MethodEnvState::NotDownloaded
        );
        assert!(
            !state_file("fixture-env").exists(),
            "the persisted record is removed, not just the in-memory entry"
        );
        assert_eq!(
            m.cancel_and_forget("fixture-env"),
            None,
            "a second forget has nothing to forget"
        );
        assert_eq!(
            m.cancel_and_forget("Bad/Id"),
            None,
            "a malformed id never touches the ledger"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn persisted_failed_state_keeps_its_error() {
        let (root, _guard) = data_root();
        let record = PersistedEnv {
            env_id: "fixture-env".to_string(),
            kind: EnvKind::Layer,
            state: MethodEnvState::Failed,
            digest: None,
            error: Some(StoredError {
                status: 400,
                code: ENV_VERIFY_FAILED_CODE.to_string(),
                message: "tampered bytes".to_string(),
            }),
            last_used: 1_700_000_000,
        };
        std::fs::create_dir_all(state_dir()).unwrap();
        std::fs::write(
            state_file("fixture-env"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let m = MethodEnvManager::new();
        let s = m.status("fixture-env");
        assert_eq!(s.state, MethodEnvState::Failed);
        assert_eq!(s.error.as_deref(), Some("tampered bytes"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn status_of_a_never_seen_env_is_not_downloaded_and_does_not_guess_kind() {
        let (root, _guard) = data_root();
        let m = MethodEnvManager::new();
        assert!(
            m.list().is_empty(),
            "no manager knowledge, no fabricated list"
        );
        let s = m.status("never-seen");
        assert_eq!(s.state, MethodEnvState::NotDownloaded);
        assert_eq!(
            s.kind,
            EnvKind::Unknown,
            "the manager never guesses base/layer"
        );
        // A malformed id is a boundary: status is total, and the filesystem is
        // never touched for it.
        let before = state_dir();
        for bad in ["../escape", "a/b", "", "has space"] {
            let s = m.status(bad);
            assert_eq!(
                (s.kind, s.state),
                (EnvKind::Unknown, MethodEnvState::NotDownloaded)
            );
        }
        assert!(!before.exists(), "no state file was created for any env");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── OCI reference grammar (parity with the frozen stack grammar) ──────

    #[test]
    fn ref_grammar_matches_the_release_stack_grammar() {
        let seams = MethodEnvSeams::default();
        let cases: &[(&str, bool)] = &[
            ("ghcr.io/tinnlab/txresbench-env/base-r:1.0", true),
            ("ghcr.io/tinnlab/txr-method-env-layers/fixture-layer:1.0", true),
            (
                "ghcr.io/tinnlab/txr-method-env-layers/fixture-layer@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                true,
            ),
            ("ghcr.io/tinnlab/txresbench-env/base-r", true),
            ("elsewhere.io/tinnlab/txr-method-env-layers/x:1", false),
            ("ghcr.io/tinnlab/txresbench-env/a/b:1", false),
            ("ghcr.io/tinnlab/txr-method-env-layers/UPPER:1", false),
            ("ghcr.io/tinnlab/txr-method-env-layers/x:bad:tag", false),
            ("ghcr.io/tinnlab/txr-method-env-layers/x@sha256:zz", false),
        ];
        for (oci_ref, ok) in cases {
            let here = parse_oci_ref(oci_ref, &seams);
            let there = crate::modules::sandbox::stack::validate_oci_ref(oci_ref);
            assert_eq!(here.is_ok(), *ok, "method_env acceptance for {oci_ref:?}");
            match (&here, &there) {
                (Ok(a), Ok(b)) => {
                    assert_eq!(a.repo, b.repo, "repo component parity: {oci_ref}");
                    assert_eq!(a.tag, b.tag, "tag parity: {oci_ref}");
                    assert_eq!(a.digest, b.digest, "digest parity: {oci_ref}");
                    assert_eq!(a.registry_base, b.registry_base, "prefix parity: {oci_ref}");
                }
                (Err(a), Err(b)) => {
                    assert_eq!(a.error_code(), b.error_code(), "code parity: {oci_ref}");
                }
                (a, b) => panic!("grammar drift for {oci_ref:?}: {a:?} vs {b:?}"),
            }
        }
    }

    #[test]
    fn ensure_refuses_a_bare_ref_without_a_tag_or_digest() {
        let (root, _guard) = data_root();
        let m = MethodEnvManager::with_seams(MethodEnvSeams {
            registry: None,
            bypass_air_gap_env: true,
        });
        let r = EnvRef {
            oci_ref: "ghcr.io/tinnlab/txr-method-env-layers/fixture-layer".to_string(),
            digest: hex_of(b"bytes"),
            tag: None,
        };
        let err = m
            .ensure(&r, EnvKind::Layer, Duration::from_secs(30))
            .expect_err("a bare ref must refuse");
        assert_eq!(err.error_code(), ENV_REPOSITORY_UNKNOWN_CODE);
        assert_eq!(
            m.status("fixture-layer").state,
            MethodEnvState::Failed,
            "the refusal is a terminal state, not a silent skip"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_refuses_a_malformed_pinned_digest() {
        let (root, _guard) = data_root();
        let m = MethodEnvManager::with_seams(MethodEnvSeams {
            registry: None,
            bypass_air_gap_env: true,
        });
        let r = EnvRef {
            oci_ref: "ghcr.io/tinnlab/txr-method-env-layers/fixture-layer:1.0".to_string(),
            digest: "not-a-digest".to_string(),
            tag: Some("1.0".to_string()),
        };
        let err = m
            .ensure(&r, EnvKind::Layer, Duration::from_secs(30))
            .expect_err("malformed pin must refuse");
        assert_eq!(err.error_code(), ENV_VERIFY_FAILED_CODE);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_refuses_a_kind_namespace_mismatch() {
        let (root, _guard) = data_root();
        let m = MethodEnvManager::with_seams(MethodEnvSeams {
            registry: None,
            bypass_air_gap_env: true,
        });
        let r = EnvRef {
            oci_ref: "ghcr.io/tinnlab/txr-method-env-layers/fixture-layer:1.0".to_string(),
            digest: hex_of(b"bytes"),
            tag: Some("1.0".to_string()),
        };
        let err = m
            .ensure(&r, EnvKind::Base, Duration::from_secs(30))
            .expect_err("a base claim on a layer ref must refuse");
        assert_eq!(err.error_code(), ENV_KIND_INVALID_CODE);
        let err = m
            .ensure(&r, EnvKind::Unknown, Duration::from_secs(30))
            .expect_err("unknown-kind must refuse");
        assert_eq!(err.error_code(), ENV_KIND_INVALID_CODE);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_refuses_a_ref_outside_the_compiled_registries() {
        let (root, _guard) = data_root();
        let m = MethodEnvManager::with_seams(MethodEnvSeams {
            registry: None,
            bypass_air_gap_env: true,
        });
        let r = EnvRef {
            oci_ref: "evil.example.com/tinnlab/txr-method-env-layers/x:1".to_string(),
            digest: hex_of(b"bytes"),
            tag: Some("1".to_string()),
        };
        let err = m
            .ensure(&r, EnvKind::Layer, Duration::from_secs(30))
            .expect_err("another host must refuse");
        assert_eq!(err.error_code(), ENV_REF_HOST_UNALLOWED_CODE);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── tamper / verify (TEST-07's unit core) ─────────────────────────────

    #[test]
    fn verify_refuses_tampered_bytes_before_any_cache_entry() {
        let (root, _guard) = data_root();
        let payload = root.join("payload.squashfs");
        std::fs::write(&payload, b"the real bytes").unwrap();
        let real = hex_of(b"the real bytes");
        let tampered = hex_of(b"the OTHER bytes");

        // Negative: mismatch → ENV_VERIFY_FAILED.
        let err = verify_payload_bytes(&payload, &tampered).expect_err("tamper must refuse");
        assert_eq!(err.error_code(), ENV_VERIFY_FAILED_CODE);
        assert!(
            !crate::modules::rootfs::cache::has_digest(&tampered),
            "no cache entry for a refused artifact"
        );
        // Positive: the pinned bytes verify.
        verify_payload_bytes(&payload, &real).expect("pristine bytes verify");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_refuses_tampered_pulled_bytes_without_a_cache_entry_or_mount() {
        let (root, _guard) = data_root();
        let payload = root.join("payload.squashfs");
        std::fs::write(&payload, b"tampered payload").unwrap();
        let marker = root.join("pull-started");
        let pinned = hex_of(b"the pinned bytes the layer SHOULD have");
        stub_oras(&root, &oras_script(&payload, &pinned, 0, &marker));

        let m = MethodEnvManager::with_seams(loopback_seams());
        let r = layer_ref("fixture-layer", "1.0", &pinned);
        let err = m
            .ensure(&r, EnvKind::Layer, Duration::from_secs(30))
            .expect_err("tampered bytes must refuse BEFORE any mount");
        assert_eq!(err.error_code(), ENV_VERIFY_FAILED_CODE);
        assert!(
            !crate::modules::rootfs::cache::has_digest(&pinned),
            "TEST-07 negative control: no cache entry"
        );
        assert_eq!(m.status("fixture-layer").state, MethodEnvState::Failed);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── cancel (TEST-10) ──────────────────────────────────────────────────

    #[test]
    fn cancel_interrupts_an_inflight_pull_and_joins_within_the_timeout() {
        let (root, _guard) = data_root();
        let payload = root.join("payload.squashfs");
        std::fs::write(&payload, b"payload").unwrap();
        let marker = root.join("pull-started");
        let digest = hex_of(b"payload");
        stub_oras(&root, &oras_script(&payload, &digest, 3600, &marker)); // pull sleeps

        let m = Arc::new(MethodEnvManager::with_seams(loopback_seams()));
        let r = layer_ref("fixture-layer", "1.0", &digest);
        let m2 = m.clone();
        let root2 = root.clone();
        let h = std::thread::spawn(move || {
            // ensure is blocking by contract; the caller runs it off-thread.
            // The scoped data root is per-THREAD, so the worker installs its
            // own (no process-env mutation — the hermetic pattern).
            let _g = scoped_data_root(root2);
            m2.ensure(&r, EnvKind::Layer, Duration::from_secs(300))
        });
        wait_until("the stub oras reached the pull", || marker.exists());
        assert_eq!(m.status("fixture-layer").state, MethodEnvState::Downloading);

        let t0 = Instant::now();
        m.cancel("fixture-layer");
        let joined = t0.elapsed();
        assert!(
            joined < CANCEL_JOIN_TIMEOUT,
            "cancel joins the worker promptly ({joined:?})"
        );
        let s = m.status("fixture-layer");
        assert_eq!(s.state, MethodEnvState::Failed, "never left 'downloading'");
        assert!(
            s.error.as_deref().unwrap_or_default().contains("cancelled"),
            "error names the cancel: {:?}",
            s.error
        );
        let err = h
            .join()
            .expect("the ensure returns")
            .expect_err("cancelled");
        assert_eq!(err.error_code(), ENV_DOWNLOAD_CANCELLED_CODE);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_is_a_noop_for_an_idle_env() {
        let (root, _guard) = data_root();
        let m = MethodEnvManager::new();
        m.cancel("fixture-env"); // no entry: no panic, nothing to cancel
        assert_eq!(m.status("fixture-env").state, MethodEnvState::NotDownloaded);
        assert!(
            !state_dir().exists(),
            "no state file was created for an env that was never ensured"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_subsequent_ensure_retries_a_cancelled_download_cleanly() {
        let (root, _guard) = data_root();
        let payload = root.join("payload.squashfs");
        std::fs::write(&payload, b"payload").unwrap();
        let marker = root.join("pull-started");
        let digest = hex_of(b"payload");
        stub_oras(&root, &oras_script(&payload, &digest, 3600, &marker));

        let m = Arc::new(MethodEnvManager::with_seams(loopback_seams()));
        let r = layer_ref("fixture-layer", "1.0", &digest);
        let m2 = m.clone();
        let root2 = root.clone();
        let h = std::thread::spawn(move || {
            let _g = scoped_data_root(root2);
            m2.ensure(&r, EnvKind::Layer, Duration::from_secs(300))
        });
        wait_until("the first pull started", || marker.exists());
        m.cancel("fixture-layer");
        let _ = h.join().expect("first attempt returns");

        // A fresh attempt starts cleanly (downloading again) — the state
        // machine does not stick to the cancelled terminal. A second stub with
        // its own marker distinguishes the retry's pull.
        let marker2 = root.join("pull-started-2");
        stub_oras(&root, &oras_script(&payload, &digest, 3600, &marker2));
        let r2 = layer_ref("fixture-layer", "1.0", &digest);
        let m2 = m.clone();
        let root2 = root.clone();
        let h2 = std::thread::spawn(move || {
            let _g = scoped_data_root(root2);
            m2.ensure(&r2, EnvKind::Layer, Duration::from_secs(300))
        });
        wait_until("the retry's pull started", || marker2.exists());
        assert_eq!(m.status("fixture-layer").state, MethodEnvState::Downloading);
        m.cancel("fixture-layer");
        let _ = h2.join();
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── download slots (MAX_CONCURRENT_DOWNLOADS) ─────────────────────────

    #[test]
    fn a_third_download_waits_for_a_slot() {
        let (root, _guard) = data_root();
        let digest = hex_of(b"payload");
        // The pull stage writes its argv (which contains the pulled ref) to
        // one log file; the ref names the repo, so the log records WHICH env's
        // pull started. The stub sleeps so the pull is cancellable.
        let log = root.join("pull-log");
        let log_disp = log.display();
        let stub = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"resolve\" ]; then echo sha256:{digest}; exit 0; fi\n\
             if [ \"$1\" = \"pull\" ]; then\n\
             \x20 echo \"$@\" > {log_disp}\n\
             \x20 exec sleep 3600\n\
             \x20 exit 0\n\
             fi\n\
             exit 1\n"
        );
        stub_oras(&root, &stub);

        let m = Arc::new(MethodEnvManager::with_seams(loopback_seams()));

        let m2 = m.clone();
        let root2 = root.clone();
        let dig_a = digest.clone();
        let ha = std::thread::spawn(move || {
            let _g = scoped_data_root(root2);
            m2.ensure(
                &layer_ref("env-a", "1.0", &dig_a),
                EnvKind::Layer,
                Duration::from_secs(300),
            )
        });
        wait_until("env-a's pull started", || {
            std::fs::read_to_string(&log)
                .map(|s| s.contains("env-a"))
                .unwrap_or(false)
        });
        assert_eq!(m.status("env-a").state, MethodEnvState::Downloading);

        let m2 = m.clone();
        let root2 = root.clone();
        let dig_b = digest.clone();
        let hb = std::thread::spawn(move || {
            let _g = scoped_data_root(root2);
            m2.ensure(
                &layer_ref("env-b", "1.0", &dig_b),
                EnvKind::Layer,
                Duration::from_secs(300),
            )
        });
        wait_until("env-b's pull started", || {
            std::fs::read_to_string(&log)
                .map(|s| s.contains("env-b"))
                .unwrap_or(false)
        });
        assert_eq!(m.status("env-b").state, MethodEnvState::Downloading);

        // Two downloads are in flight; a third env's request must WAIT for a
        // slot rather than start a third pull.
        let m2 = m.clone();
        let root2 = root.clone();
        let dig_c = digest.clone();
        let hc = std::thread::spawn(move || {
            let _g = scoped_data_root(root2);
            m2.ensure(
                &layer_ref("env-c", "1.0", &dig_c),
                EnvKind::Layer,
                Duration::from_secs(300),
            )
        });
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(
            m.status("env-c").state,
            MethodEnvState::NotDownloaded,
            "the third download is waiting for a slot"
        );
        assert!(
            std::fs::read_to_string(&log)
                .map(|s| !s.contains("env-c"))
                .unwrap_or(true),
            "no third pull started while both slots are busy"
        );

        // Cancelling one frees a slot; the waiting request proceeds.
        m.cancel("env-a");
        wait_until("env-c's pull started after the slot freed", || {
            std::fs::read_to_string(&log)
                .map(|s| s.contains("env-c"))
                .unwrap_or(false)
        });
        assert_eq!(m.status("env-c").state, MethodEnvState::Downloading);

        m.cancel("env-b");
        m.cancel("env-c");
        let _ = ha.join().expect("env-a returns");
        let _ = hb.join().expect("env-b returns");
        let _ = hc.join().expect("env-c returns");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── air-gap seam lookup (pure core) ───────────────────────────────────

    #[test]
    fn seam_lookup_serves_the_exact_env_and_refuses_a_sibling() {
        let vars: BTreeMap<String, String> = [
            (
                "TXR_ENV_ROOTFS_SQUASHFS__fixture-env".to_string(),
                "/srv/fixture.squashfs".to_string(),
            ),
            (
                "TXR_ENV_ROOTFS_DIR__other-env".to_string(),
                "/srv/other".to_string(),
            ),
        ]
        .into_iter()
        .collect();
        let read = |k: &str| vars.get(k).cloned();

        // Exact per-env variable serves that env.
        assert_eq!(
            seam_path(SQUASHFS_SEAM, "fixture-env", read),
            Some(PathBuf::from("/srv/fixture.squashfs"))
        );
        // A sibling staged env never serves another env: refused by name.
        let names: Vec<String> = vars.keys().cloned().collect();
        let refusal = seam_refusal_with("fixture-env", &read, &names).expect("sibling staged");
        assert_eq!(refusal.error_code(), ENV_STAGED_MISMATCH_CODE);
        let msg = refusal.to_string();
        assert!(
            msg.contains("other-env"),
            "the refusal names the staged env"
        );
        assert!(msg.contains("fixture-env"), "and the requested one");
    }

    #[test]
    fn seam_lookup_bare_artifact_needs_an_explicit_env_association() {
        let vars: BTreeMap<String, String> = [
            (
                "TXR_ENV_ROOTFS_SQUASHFS".to_string(),
                "/srv/a.squashfs".to_string(),
            ),
            (
                "TXR_ENV_ROOTFS_SQUASHFS_ENV".to_string(),
                "fixture-env".to_string(),
            ),
        ]
        .into_iter()
        .collect();
        let read = |k: &str| vars.get(k).cloned();
        assert_eq!(
            seam_path(SQUASHFS_SEAM, "fixture-env", read),
            Some(PathBuf::from("/srv/a.squashfs"))
        );
        // Same bare artifact associated with a DIFFERENT env: refusal.
        let names: Vec<String> = vars.keys().cloned().collect();
        let refusal = seam_refusal_with("other-env", &read, &names).expect("mismatch");
        assert_eq!(refusal.error_code(), ENV_STAGED_MISMATCH_CODE);

        // Bare artifact with NO association at all: unassociated refusal (the
        // txr node has no default env-id — DEC-13).
        let vars: BTreeMap<String, String> = [(
            "TXR_ENV_ROOTFS_SQUASHFS".to_string(),
            "/srv/a.squashfs".to_string(),
        )]
        .into_iter()
        .collect();
        let read = |k: &str| vars.get(k).cloned();
        let names: Vec<String> = vars.keys().cloned().collect();
        let refusal = seam_refusal_with("fixture-env", &read, &names).expect("unassociated");
        assert_eq!(refusal.error_code(), ENV_STAGED_UNASSOCIATED_CODE);
    }

    #[test]
    fn seam_lookup_names_an_unusable_exact_artifact() {
        let vars: BTreeMap<String, String> = [(
            "TXR_ENV_ROOTFS_DIR__fixture-env".to_string(),
            "/srv/not-mounted".to_string(),
        )]
        .into_iter()
        .collect();
        let read = |k: &str| vars.get(k).cloned();
        let names: Vec<String> = vars.keys().cloned().collect();
        let refusal =
            seam_refusal_with("fixture-env", &read, &names).expect("own artifact unusable");
        assert_eq!(refusal.error_code(), ENV_STAGED_UNUSABLE_CODE);
    }
}
