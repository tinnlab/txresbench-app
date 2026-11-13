//! Env-image provider (ITEM-23 / DEC-22/23) — named environment images the
//! sandbox runs analyses inside.
//!
//! WHY: one monolithic rootfs with every domain's tools has conflicting deps
//! and is unbuildable. Instead each analysis DOMAIN gets its own named env
//! image (its own tool list). An `env-id` resolves to its OCI location here,
//! then lazy-fetch + cosign-verify + mount before the run.
//!
//! strip-single-cell ITEM-3: the extension-registry resolution arm (the env
//! declared by a contributed processor manifest) and the provenance capture
//! glue were removed with the `extensions`/`provenance` modules; the provider
//! core — OCI resolve/verify/pull/stage by content digest, air-gap seams, the
//! digest cache + mount — stays and is shared with the txr method-env manager
//! ([`super::method_env`]).
//!
//! FETCH-NEWEST, NOTHING EMBEDDED (DEC-I / DEC-24 reversed): the binary embeds NO
//! rootfs and NO digest. [`OciEnvImageProvider`] — the ONLY runtime provider —
//! resolves the MOVING `schema<N>-latest-<arch>` tag to a content digest against
//! the registry at pull time, cosign-verifies the digest-pinned image, stages it
//! into the content-digest cache, and mounts it. A new analysis always runs the
//! newest published image; provenance records the RESOLVED digest so a reproduce
//! pulls that exact image (provenance-by-reference). No embedded fallback — an
//! unreachable/un-cached registry is a clear error, not a silent stale rootfs.
//!
//! This mirrors the txresbench SDK's `txresbench-sandbox` `RootfsProvider` seam (fetch +
//! mount, injected so backends never name concrete fetch modules); here the
//! injected axis is the ENV rather than the flavor.
//!
//! AIR-GAP SEAMS (release-honored, checked before the OCI path, in this order).
//!
//! **Both are ENV-SCOPED (#189 / PROV-E1-5).** A staged rootfs is one env's filesystem,
//! so it is associated with an env-id and serves only that env:
//!
//! * `TXR_ENV_ROOTFS_{SQUASHFS,DIR}__<env-id>` serves `<env-id>` exactly.
//! * The un-suffixed variable serves ONE env — `TXR_ENV_ROOTFS_{SQUASHFS,DIR}_ENV` if
//!   set, else the deployment default — which keeps every single-env deployment (and
//!   `just e2e-processors`) behaving exactly as before.
//! * A request for any OTHER env is **REFUSED BY NAME**, never substituted and never
//!   warned-past. Three typed codes, because the remedies differ:
//!   `ENV_IMAGE_STAGED_ENV_MISMATCH` (names BOTH the requested and the staged env),
//!   `ENV_IMAGE_STAGED_ENV_UNASSOCIATED` (a staged artifact nothing associates with an
//!   env — set `<key>_ENV`), and `ENV_IMAGE_STAGED_ENV_UNUSABLE` (the artifact for the
//!   RIGHT env is missing or malformed).
//! * A refusal is raised only after EVERY seam has declined, so a deployment may stage
//!   one env as a squashfs and another as a pre-mounted dir.
//!
//! **One behaviour genuinely changed beyond the substitution fix:** a bare artifact that
//! the deployment can associate with NO env (no `<key>_ENV`, no `TXR_SANDBOX_ENV_ID`, no
//! settings row, no env declared by the loaded registry) is now refused rather than
//! served for whatever asks. A process that never builds the extension registry and sets
//! only the bare variable therefore fails where it previously served — deliberately, and
//! with a message naming the one variable that fixes it.
//!
//! That last point is the whole of the change. Previously `provide` consulted the bare
//! squashfs variable BEFORE reading `env_id` and returned unconditionally, so every
//! env-id resolved to the same staged image — under the seam these docs call
//! *preferred*, and the one local development actually uses. A job asking for an R env
//! would mount the python image and run `Rscript` against it: a wrong answer that
//! presents as "R is broken", pointing the next reader at the image instead of the
//! resolver. Only the un-suffixed variable's single-env association preserves the old
//! behaviour, and only for the env it actually serves.
//!
//! 1. `TXR_ENV_ROOTFS_SQUASHFS=<path/to/rootfs.squashfs>` — **preferred**. The
//!    provider content-hashes the file, stages it into the digest cache, RECORDS
//!    the digest, and mounts by digest. A run under it is fully reproducible: its
//!    `env_rootfs_sha256` is a self-verifying sha256 of the exact mounted bytes,
//!    those bytes are servable at `GET /api/sandbox/rootfs/{digest}`, and its
//!    export capsule therefore EXECUTES.
//! 2. `TXR_ENV_ROOTFS_DIR=<already-mounted dir>` — legacy. A mount dir carries no
//!    content identity, so a digest is recorded only when the dir is the cache's
//!    own mount point (`<cache>/<64hex>[/mnt]`) for a cached digest; otherwise the
//!    run is UNPINNED (its capsule is provenance-only, not executable) and the
//!    provider warns. Prefer seam 1.
//!
//! Both are read off the PROCESS environment, so they apply to every provider in the
//! process — including one a test configured explicitly. A provider that declares
//! [`EnvImageSeams::bypass_air_gap_env`] (debug builds only) opts out of both and drives
//! the real OCI path; that is what lets the OCI end-to-end test — which cosign-VERIFIES
//! — run in the same process as the rootfs-gated tests that need seam 1.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use txresbench_core::AppError;

/// A resolved env-image reference: the digest-addressed OCI location of a
/// domain's environment image. `provenance` records `{oci_ref, digest}` on a run
/// so reproduction needs only the manifest + code + this reference (DEC-22), not
/// a bundled multi-GB rootfs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvImageRef {
    /// The OCI repository ref (per-env repo): `<registry-base>/<env-id>`, e.g.
    /// `ghcr.io/tinnlab/txresbench-env/<env-id>` (DEC-23/DEC-L).
    ///
    /// The trailing component is **DATA, never an app constant** — it is the
    /// `env-id` a contributed converter manifest declares (`contributes.
    /// converters[].env`), passed through [`resolve`] verbatim after a
    /// repo-path-component validity check. The app names the REGISTRY BASE
    /// (`DEFAULT_REGISTRY`, product-scoped) and nothing below it, so no analysis
    /// domain appears in this module. Writing a concrete domain here as the
    /// "example" is what made the app look like it knew one (R3-F2).
    pub oci_ref: String,
    /// The MOVING schema+arch-scoped tag the runtime resolves at PULL time
    /// (fetch-newest, DEC-I): `schema<N>-latest-<arch>`. NOT a digest — the
    /// provider resolves this to a content digest against the registry, and a
    /// run's provenance records the RESOLVED digest for reproduction.
    pub tag: String,
}

impl EnvImageRef {
    /// The tag pull ref `<oci_ref>:<tag>` — what `oras resolve` consumes to get
    /// the newest digest.
    pub fn pull_ref(&self) -> String {
        format!("{}:{}", self.oci_ref, self.tag)
    }
    /// The digest-pinned ref `<oci_ref>@<digest>` (post-resolve; what provenance
    /// records + what a reproduce pulls).
    pub fn pinned_at(&self, digest: &str) -> String {
        format!("{}@{}", self.oci_ref, digest)
    }
}

/// The env-id the sandbox resolves its rootfs for when the caller has not named one.
///
/// **DATA, not a constant.** The env-id is declared by the contributed processor
/// manifests (`contributes.converters[].env`, see
/// a contributed processor manifest's `contributes.converters[].env`);
/// this reads the first one the loaded extension registry declares, so the app
/// carries no env-name literal. An operator can override with `TXR_SANDBOX_ENV_ID`
/// (useful before the registry is built, or to pin a specific env).
///
/// `None` when neither is available — the caller then has no rootfs to provide and
/// surfaces a clear error rather than fetching an invented image name.
///
/// Since #189 the run path threads the RUNNING job's declared env when it has one;
/// this is the fallback for a job that declares none, which is every job that behaved
/// this way before per-job selection existed (INV-1).
///
/// Equivalent to [`resolve_env_id(None)`](resolve_env_id) — see there for the full
/// precedence chain, including where a job's declared env sits in it.
pub fn default_env_id() -> Option<String> {
    resolve_env_id(None)
}

/// The env-id a run resolves to, given the env its contribution DECLARED (#189).
///
/// The precedence, highest first:
///
/// 1. `TXR_SANDBOX_ENV_ID` — the OPERATOR override.
/// 2. the job's own declared `env`.
/// 3. `sandbox_settings.default_env_id` — the admin-configured deployment default.
/// 4. the union of envs the loaded registry declares.
/// 5. `None` ⇒ the caller surfaces a loud `SANDBOX_UNAVAILABLE`, never an invented name.
///
/// **The operator override sits ABOVE the declared env deliberately, and this is the one
/// ordering here that is not obvious.** A declared env is the package author's statement
/// of what their code needs, so it beats a deployment-wide default (2 over 3) — that is
/// the whole point of per-job selection. But `TXR_SANDBOX_ENV_ID` is the operator's
/// escape hatch, used to pin a whole process to one image: it is how a single-env or
/// air-gapped deployment, a recovery run, or an in-pod re-entry forces a known env
/// regardless of what any manifest asks for. If a declared env could override it, that
/// escape hatch would stop working the moment any package declared an env — exactly when
/// an operator is most likely to need it.
///
/// Steps 3-5 are byte-identical to the pre-#189 chain, so a job declaring no env
/// resolves exactly as it did before this existed (INV-1).
pub fn resolve_env_id(declared: Option<&str>) -> Option<String> {
    if let Ok(raw) = std::env::var("TXR_SANDBOX_ENV_ID") {
        // TRIM once, here. Comparing trimmed and returning untrimmed let a value like
        // `" python "` skip the (correct) displacement warning and then fail the seam
        // lookup, producing a refusal naming `" python "` against `"python"`.
        let id = raw.trim().to_string();
        if !id.is_empty() {
            // The override WINS (that is the contract), but displacing a job's own
            // declaration is not something to do silently. On a Kubernetes control plane
            // this variable is normally set — the backend stamps it into every pod — so
            // without this line per-job selection would become a no-op there with no
            // signal anywhere that a declared env had been ignored.
            if let Some(d) = declared.map(str::trim).filter(|d| !d.is_empty()) {
                if d != id {
                    tracing::warn!(
                        declared_env = %d,
                        override_env = %id,
                        "TXR_SANDBOX_ENV_ID overrides this job's declared env; the job \
                         will run in the operator-pinned image, not the one it declared"
                    );
                }
            }
            return Some(id);
        }
    }
    if let Some(id) = declared.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(id.to_string());
    }
    // #54: the admin-configured deployment default (from the cached settings
    // snapshot — no pool needed; the snapshot is the same live row the run path
    // reads for the resource ceiling). Unset/empty falls through to registry
    // auto-detect below, exactly as before this setting existed (byte-preserving).
    if let Some(id) = crate::modules::sandbox::settings_cache::snapshot()
        .default_env_id
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        return Some(id.clone());
    }
    // strip-single-cell ITEM-3: the extension-registry auto-detect arm was removed
    // with the `extensions` module (the union of converter/analysis `env`
    // declarations). Without a registry to read, "no declared env" resolves to
    // `None` — the caller surfaces the loud `SANDBOX_UNAVAILABLE`, never an
    // invented image name. The operator override (`TXR_SANDBOX_ENV_ID`) and the
    // admin settings row still pin a specific env above this arm.
    None
}

/// The digest (64-hex, no scheme) the provider most recently resolved+mounted.
/// Kept with the provider: `rootfs::cache`'s GC protects this digest from
/// eviction (a run about to execute on it must not be pulled from under the
/// sandbox).
static LAST_RESOLVED_DIGEST: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_last_resolved_digest(hex: &str) {
    if let Ok(mut g) = LAST_RESOLVED_DIGEST.lock() {
        *g = Some(hex.to_string());
    }
}

/// The most-recently-resolved env-image content digest (64-hex), or None before any
/// run. Provenance records this as the run's `env_rootfs_sha256` (content-addressed
/// → a reproduce mounts the exact image via the digest cache / serve-by-digest).
pub fn last_resolved_digest() -> Option<String> {
    LAST_RESOLVED_DIGEST.lock().ok().and_then(|g| g.clone())
}

/// The GHCR org/owner + per-env repo prefix (DEC-B/DEC-L). One repo per env:
/// `ghcr.io/tinnlab/txresbench-env/<env>`. Overridable per-provider via
/// [`EnvImageSeams::registry`] (ITEM-5 loopback seam, honored in debug builds only).
const DEFAULT_REGISTRY: &str = "ghcr.io/tinnlab/txresbench-env";

/// Per-provider configuration of the registry + signature-verification seams,
/// passed EXPLICITLY into [`OciEnvImageProvider::with_seams`].
///
/// **Why this is a parameter and not an env var.** `TXR_ENV_IMAGE_REGISTRY` and
/// `TXR_ENV_IMAGE_COSIGN_KEY` used to configure these seams, read LIVE and
/// in-process at the moment of use. That made one test's configuration global to
/// its whole test binary: a test that `set_var`'d the registry redirected every
/// concurrently-running sibling that resolved an env-ref, for as long as its pull
/// ran. That was measured, not theoretical — round 15 caught
/// `sandbox::env_image_test` failing on exactly this assertion, its `left` reading
/// `<the OCI test's loopback registry>/<env-id>` where the `right` expected
/// `<DEFAULT_REGISTRY>/<env-id>`, while the OCI test was mid-pull. A guard that
/// CLEARS the vars afterwards does not fix that: the whole window between set and
/// clear is the race. Two providers configured here can disagree in one process and
/// neither can reach the other.
///
/// **Release posture is unchanged.** `registry` and `cosign_key` are honored only
/// under `#[cfg(debug_assertions)]`, exactly as the env seams they replace were:
/// a release binary carries no code that could redirect an env-image pull to
/// another registry or swap keyless OIDC verification for a local key, whatever
/// these fields hold. `identity_regexp` is the one release-honored field, because
/// it is a documented OPERATOR staging override (see [`cosign_verify`]), not a
/// test seam.
#[derive(Clone, Debug, Default)]
pub struct EnvImageSeams {
    /// Registry base to pull from instead of [`DEFAULT_REGISTRY`] — a local
    /// `registry:2` for the OCI end-to-end test. Debug builds only. Setting it
    /// also switches the `oras`/`cosign` calls to plain HTTP (a loopback registry
    /// has no TLS).
    pub registry: Option<String>,
    /// A cosign PUBLIC KEY to key-verify with instead of keyless OIDC. Debug
    /// builds only.
    pub cosign_key: Option<PathBuf>,
    /// Certificate-identity regexp for the KEYLESS path, overriding
    /// `TXR_ENV_IMAGE_IDENTITY_REGEXP` and the strict `@refs/heads/main` default.
    /// Release-honored (operator staging override).
    pub identity_regexp: Option<String>,
    /// Ignore the AIR-GAP env seams (`TXR_ENV_ROOTFS_SQUASHFS` /
    /// `TXR_ENV_ROOTFS_DIR`) and drive the real resolve → verify → pull → mount
    /// path. Debug builds only.
    ///
    /// This closes the LAST place the process environment could still overrule a
    /// provider that was configured explicitly — the failure class this whole struct
    /// exists to remove, in the other direction. The air-gap seams are consulted at
    /// the TOP of [`OciEnvImageProvider::provide`], so a run that exports
    /// `TXR_ENV_ROOTFS_SQUASHFS` — which is the DOCUMENTED procedure for the
    /// rootfs-dependent tests, since they cannot reach the private GHCR package —
    /// silently turned the OCI end-to-end test into a no-op that returns the operator's
    /// squashfs: no resolve, no pull, and no COSIGN VERIFY. The verification test was
    /// disabled by our own runbook, and its resulting red was recorded as "needs a live
    /// OCI registry" (it stands up its own).
    ///
    /// A test cannot fix this by unsetting the var: one test binary is one process, and
    /// this module's header records the measured cross-test contamination that made
    /// `set_var` here forbidden. Declaring the bypass on the provider makes the two
    /// requirements coexist in ONE run — the rootfs tests keep their env seam, this one
    /// opts out of it — which is the same "two providers can disagree in one process"
    /// property `registry`/`cosign_key` already have.
    ///
    /// Release posture unchanged: the reader is `#[cfg(debug_assertions)]`, so a release
    /// binary cannot be made to skip an operator's air-gap configuration.
    pub bypass_air_gap_env: bool,
}

/// Whether the air-gap ENV seams are bypassed for this provider — debug only; a
/// release build always honors the operator's air-gap configuration.
fn air_gap_bypassed(seams: &EnvImageSeams) -> bool {
    #[cfg(debug_assertions)]
    {
        seams.bypass_air_gap_env
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = seams; // the only reader above is compiled out in release
        false
    }
}

/// The registry base for env images, under `seams`.
fn registry_base(seams: &EnvImageSeams) -> String {
    #[cfg(debug_assertions)]
    if let Some(r) = seams.registry.as_deref().filter(|r| !r.is_empty()) {
        return r.to_string();
    }
    #[cfg(not(debug_assertions))]
    let _ = seams; // the only reader above is compiled out in release
    DEFAULT_REGISTRY.to_string()
}

/// The build target's OCI arch string (`amd64`/`arm64`) for the arch-suffixed tag.
fn target_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The MOVING "newest for this binary's schema + arch" TAG (fetch-newest, DEC-I):
/// `schema<N>-latest-<arch>`. Schema is the binary's `ROOTFS_SCHEMA_VERSION`
/// (schema-scoped so a schema bump can't break a running deploy); arch is the
/// target's. NO baked digest — resolved against the registry at pull time (ITEM-2).
pub fn moving_tag() -> String {
    format!(
        "schema{}-latest-{}",
        crate::modules::rootfs::version::ROOTFS_SCHEMA_VERSION,
        target_arch(),
    )
}

/// Resolve an env-id to its env-image ref (per-env repo + the moving schema+arch
/// tag). The env-id is DATA — declared by a contributed converter manifest — so
/// there is no allowlist of known env names here: ANY well-formed id maps to its
/// per-env repo, and a name with no published image fails at PULL time with the
/// registry's own error. Adding a domain is therefore one `env-rootfs/<env>/` + one
/// CI build, with ZERO core edit (which was the point of the registry).
///
/// `None` only for a malformed id — empty, or carrying a character that is not
/// valid in an OCI repository path component (which would otherwise let a manifest
/// value inject `:tag` / `@digest` / a registry host into the ref we pull).
pub fn resolve(env_id: &str) -> Option<EnvImageRef> {
    resolve_with(env_id, &EnvImageSeams::default())
}

/// Whether `env_id` is a valid OCI repository PATH COMPONENT (lowercase
/// alphanumerics + `.` `_` `-`, non-empty). The one grammar `resolve` enforces,
/// exposed so the settings `validate()` can reject a malformed admin-supplied
/// `default_env_id` up front (#54) — a bad value would otherwise resolve to a broken
/// pull ref or smuggle a `:tag`/`@digest`/host into it.
///
/// **Defined in [`super::env_id`], not here**, because `build.rs` `#[path]`-includes
/// that module to give the BUILD-TIME manifest lint the identical predicate. Re-exported
/// under its original path so every existing caller is unchanged.
pub use super::env_id::is_valid_env_id;

/// The compiled env-image registry BASE (`ghcr.io/tinnlab/txresbench-env`), for READ-ONLY
/// display on the admin settings page (#54). This is a release-time security boundary
/// (a release binary carries no code that could redirect a pull to another registry),
/// so it is shown, never made operator-writable — see [`EnvImageSeams`] / INV-4.
pub fn registry_base_display() -> &'static str {
    DEFAULT_REGISTRY
}

/// [`resolve`] against an explicit seam set — what [`OciEnvImageProvider::provide`]
/// calls, so a provider pointed at a local registry resolves against THAT registry
/// without any process-wide state the free `resolve` could also see.
fn resolve_with(env_id: &str, seams: &EnvImageSeams) -> Option<EnvImageRef> {
    // OCI repository-name grammar (lowercase alphanumerics + `.`, `_`, `-`), no
    // separators — this is a path COMPONENT, not a full reference.
    if !is_valid_env_id(env_id) {
        return None;
    }
    Some(EnvImageRef {
        oci_ref: format!("{}/{}", registry_base(seams), env_id),
        tag: moving_tag(),
    })
}

/// A `RootfsProvider`-style seam (mirrors the SDK's `txresbench-sandbox`
/// `RootfsProvider`): turn an env-id into a ready-to-bind rootfs MOUNT DIR (the
/// dir whose `usr/` the sandbox binds read-only). Injecting this behind a trait
/// keeps the sandbox run path from naming a concrete OCI-fetch module, so an
/// alternate provider (e.g. an in-process `oci-client` impl) drops in without
/// touching callers. [`OciEnvImageProvider`] is the sole runtime impl today.
pub trait EnvImageProvider: Send + Sync {
    /// Make the named env available and return its mount dir + the content digest
    /// that mount corresponds to (lazy-fetch + verify + mount). Errors if the env-id
    /// is unregistered, if the image can't be fetched/verified, or if a locally
    /// staged rootfs serves a DIFFERENT env than the one requested — there is no
    /// embedded fallback and no substitution.
    ///
    /// BLOCKING + BOUNDED. This shells to host tools and does synchronous I/O, so
    /// it must never be called directly from an async task — every call site runs
    /// it on `tokio::task::spawn_blocking`. `budget` is the TOTAL wall-clock the
    /// whole resolve→verify→pull→mount sequence may consume; exceeding it returns
    /// `ENV_IMAGE_TOOL_TIMEOUT`/`ENV_IMAGE_STAGING_TIMEOUT` rather than blocking
    /// forever (the job-hang root cause: a hung registry / DNS blackhole / stalled
    /// TLS handshake used to pin the job at `running` with no terminal state).
    fn provide(&self, env_id: &str, budget: Duration) -> Result<ProvidedEnv, AppError>;
}

/// What [`EnvImageProvider::provide`] hands back: the mount dir to bind, and the OCI
/// content digest THAT MOUNT corresponds to.
///
/// The digest is RETURNED rather than stashed in a process-global (#189 / INV-3). The
/// global it replaces was a last-write-wins `static`, which was survivable only while
/// exactly one env existed: with two, a run can record the digest of an image a
/// DIFFERENT concurrent run mounted, silently pinning the wrong environment into
/// provenance and corrupting the reproduce path. Returning it makes the value
/// run-scoped by construction — there is no shared slot for a second run to overwrite.
///
/// `digest` is `None` only for the legacy pre-mounted-dir seam, where a bare mount
/// point carries no content identity to record (the run is then provenance-only, not
/// reproducible — the provider warns).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvidedEnv {
    /// The rootfs mount dir (the dir whose `usr/` the sandbox binds read-only).
    pub rootfs_dir: PathBuf,
    /// The 64-hex OCI content digest of the image mounted, when it has one.
    pub digest: Option<String>,
}

/// Fixed cap for the METADATA-only host-tool calls (`oras resolve`, `cosign
/// verify`). Deliberately a CONST, not an admin setting: these are control-plane
/// RPCs that fetch a manifest/signature — a few KiB whose cost is independent of
/// image size and link bandwidth. If one has not answered in two minutes the
/// registry is unreachable, and no operator value would change that. This is an
/// in-process resource guard, the same class as `rootfs::mount`'s 5s
/// mount-visibility wait. The bandwidth-bound `oras pull` gets the REMAINING
/// staging budget instead (one operator dial, no two knobs to disagree).
const TOOL_METADATA_TIMEOUT: Duration = Duration::from_secs(120);

/// Cap on retained subprocess output per stream (the rest is drained to a sink so
/// a chatty child can never block on a full pipe, nor balloon our memory).
const TOOL_OUTPUT_CAP: usize = 256 * 1024;

/// The PRIMARY (only) runtime provider (ITEM-1, DEC-24 reversed — nothing is
/// embedded): lazy-fetch the NEWEST schema+arch-matched image for an env from the
/// OCI registry, **cosign-verify** it, stage it into the content-digest cache, and
/// mount it. Shells to `oras`/`cosign` host binaries (DEC-N). Fetch-newest (DEC-I):
/// resolve the moving tag → digest each call; pull the blob only on a cache miss.
///
/// Construct it with [`OciEnvImageProvider::new`] in production (default registry,
/// keyless OIDC verification) or [`OciEnvImageProvider::with_seams`] to point ONE
/// provider at a different registry / verification key without touching any
/// process-wide state — see [`EnvImageSeams`] for why that distinction exists.
#[derive(Default)]
pub struct OciEnvImageProvider {
    seams: EnvImageSeams,
}

impl OciEnvImageProvider {
    /// The production provider: [`DEFAULT_REGISTRY`] + keyless OIDC verification
    /// against the strict `@refs/heads/main` identity (unless the operator's
    /// `TXR_ENV_IMAGE_IDENTITY_REGEXP` staging override is set).
    pub fn new() -> Self {
        Self::default()
    }

    /// A provider configured EXPLICITLY. Every field left `None` keeps the
    /// production behaviour for that seam.
    pub fn with_seams(seams: EnvImageSeams) -> Self {
        Self { seams }
    }
}

impl EnvImageProvider for OciEnvImageProvider {
    fn provide(&self, env_id: &str, budget: Duration) -> Result<ProvidedEnv, AppError> {
        let deadline = Instant::now() + budget;
        // A provider that declares `bypass_air_gap_env` skips BOTH air-gap seams and
        // drives the real resolve → verify → pull → mount path, whatever the ambient
        // environment says (debug builds only — see [`EnvImageSeams::bypass_air_gap_env`]
        // for why the OCI end-to-end test needs it and cannot get it by unsetting a var).
        // The env-id GRAMMAR is deliberately NOT re-checked here, ahead of the seams.
        //
        // It is tempting: a malformed id can never be served by anything, so refusing it
        // up front would give a better message than "does not match the staged env". But
        // the air-gap seams are honoured for whatever id the operator points them at —
        // they bypass `resolve` entirely, which is the only thing that parses an id — and
        // `bypass_air_gap_env_takes_the_oci_path_while_the_seam_is_set` pins exactly that
        // ordering, using a malformed id as its probe for WHICH BRANCH RAN. Checking the
        // grammar first would collapse that distinction and make the seam-bypass seam
        // untestable. The grammar is enforced where it decides an outcome: at manifest
        // parse, at spec validation, and in `resolve_with` on the OCI path.
        let air_gap = !air_gap_bypassed(&self.seams);
        // ── air-gap seam 1 (PREFERRED, provenance-honest) ─────────────────────
        // `TXR_ENV_ROOTFS_SQUASHFS__<env-id>=<path>` serves THAT env; the un-suffixed
        // `TXR_ENV_ROOTFS_SQUASHFS=<path>` serves a single-env deployment exactly as it
        // did before #189. Either way the provider content-hashes the file, stages it
        // into the local digest cache, and mounts BY DIGEST — so a run under this seam
        // pins a real, self-verifying `env_rootfs_sha256`, the serve endpoint can hand
        // the exact bytes to a reproducer, and `readiness.env_pinned` is true. This is
        // the seam the rootfs-gated capsule tests use to EXECUTE with no GHCR.
        //
        // ── AND IT IS WHERE THE ENV-ID USED TO BE IGNORED (#189 / PROV-E1-5) ──
        // Before this change the bare variable was consulted BEFORE `env_id` was read at
        // all, and `provide` returned from it unconditionally. Every env-id therefore
        // resolved to the SAME staged squashfs — under the seam this module's own docs
        // call *preferred*, and the one an owner developing locally actually uses. The
        // consequence was not a missing capability but a wrong answer: a job declaring an R
        // env would mount the PYTHON image and run `Rscript` inside it, failing in a way
        // that reads as "R is broken" and sends the next person to debug the image
        // rather than the resolver. `staged_squashfs_for` now decides by NAME, and
        // refuses rather than substitutes.
        if air_gap {
            if let Some(staged) = staged_squashfs_for(env_id) {
                return provide_from_squashfs(&staged, deadline);
            }
        }
        // ── air-gap seam 2 (LEGACY pre-mounted dir) ───────────────────────────
        // `TXR_ENV_ROOTFS_DIR` points at an ALREADY-MOUNTED rootfs dir (the dir
        // whose `usr/` the sandbox binds). Used directly, skipping the OCI
        // resolve/pull/verify — the operator vouches for the bytes. A mount dir
        // carries no content identity of its own, so provenance can only be pinned
        // when the dir is the digest cache's own mount point
        // (`<cache>/<64hex>[/mnt]`) AND that digest is present in the cache; then
        // the digest IS recorded. Otherwise the run records NO env digest and its
        // capsule is provenance-only (not executable) — prefer seam 1.
        //
        // Env-scoped on the same rule as seam 1, for the same reason.
        if air_gap {
            if let Some(p) = staged_rootfs_dir_for(env_id) {
                if !p.join("usr").is_dir() {
                    // Say so. Falling through in silence is what made a later refusal
                    // read as though the env were mis-staged rather than the path wrong.
                    tracing::error!(
                        dir = %p.display(),
                        env = %env_id,
                        "the staged rootfs dir for this env has no `usr/`; it cannot be \
                         mounted, so this seam declines"
                    );
                } else {
                    let digest = digest_from_cache_dir(&p);
                    if digest.is_none() {
                        tracing::warn!(
                            dir = %p.display(),
                            "TXR_ENV_ROOTFS_DIR: a bare pre-mounted dir has no content identity, so \
                             runs record NO env_rootfs_sha256 and their export capsules cannot be \
                             executed — point TXR_ENV_ROOTFS_SQUASHFS at the squashfs file instead"
                        );
                    }
                    if let Some(hex) = digest.as_deref() {
                        set_last_resolved_digest(hex);
                    }
                    return Ok(ProvidedEnv {
                        rootfs_dir: p,
                        digest,
                    });
                }
            }
        }
        // Both seams declined. If either stages a SIBLING env, this is a multi-env
        // air-gapped deployment that simply has no artifact for the requested one:
        // refuse by name rather than fall through to an OCI pull the operator
        // air-gapped themselves away from. Raised here, after both seams, so a
        // deployment staging one env per seam is not rejected by whichever ran first.
        if air_gap {
            if let Some(err) = staged_env_refusal(env_id) {
                return Err(err);
            }
        }
        let r = resolve_with(env_id, &self.seams).ok_or_else(|| {
            AppError::new(
                axum::http::StatusCode::NOT_FOUND,
                "ENV_IMAGE_UNKNOWN",
                format!("no env image registered for env-id {env_id:?}"),
            )
        })?;
        // 1. resolve the moving tag → the NEWEST digest (fetch-newest, DEC-I).
        let digest = oras_resolve(&r.pull_ref(), deadline, &self.seams)?;
        let hex = digest.strip_prefix("sha256:").unwrap_or(&digest).to_string();
        if !crate::modules::rootfs::cache::is_valid_digest(&hex) {
            return Err(AppError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                "ENV_IMAGE_BAD_DIGEST",
                format!("registry returned a malformed digest for {}: {digest}", r.pull_ref()),
            ));
        }
        // 2. pull + cosign-verify + stage ONLY on a cache miss (a new version).
        if !crate::modules::rootfs::cache::has_digest(&hex) {
            let pinned = r.pinned_at(&digest);
            cosign_verify(&pinned, deadline, &self.seams)?; // reject unsigned / wrong-identity — never mount unverified
            pull_and_stage(&pinned, &hex, deadline, &self.seams)?;
        }
        // Record the resolved digest for provenance-by-reference (ITEM-4): a run's
        // env_rootfs_sha256 becomes the OCI content digest it actually ran on, so a
        // reproduce resolves the exact image.
        //
        // DEC-O's KNOWN LIMITATION IS RESOLVED (#189 / INV-3): the digest is now RETURNED
        // to the caller, which writes it into the run's own workspace, so what provenance
        // records is the digest THAT RUN mounted rather than whatever the process
        // resolved most recently. Both windows DEC-O named are closed by that — a version
        // publishing mid-run no longer moves an already-mounted run's recorded digest,
        // and a run that never reached `provide()` records `None` instead of inheriting a
        // previous run's value.
        //
        // The global below is KEPT for its two REMAINING readers — the reproduce-time
        // drift check and the rootfs GC's live-digest protection. Neither is provenance;
        // see `LAST_RESOLVED_DIGEST`'s own doc for both, and for the multi-env limitation
        // the GC one now carries.
        set_last_resolved_digest(&hex);
        // 3. mount by content digest (reuses the cache + squashfuse; per-digest lock).
        Ok(ProvidedEnv {
            rootfs_dir: crate::modules::rootfs::ensure_ready_by_digest(&hex)?,
            digest: Some(hex),
        })
    }
}

/// The typed error code a staged-env refusal carries (PROV-E1-5). Named as a const so a
/// call site can let this ONE error through its own wrapping without matching on a
/// string literal that would silently stop matching if the code were reworded.
pub const ENV_STAGED_MISMATCH_CODE: &str = "ENV_IMAGE_STAGED_ENV_MISMATCH";

/// The typed code for a staged artifact the deployment can associate with NO env.
///
/// Deliberately DISTINCT from [`ENV_STAGED_MISMATCH_CODE`] rather than reusing it: that
/// code's contract (stated in this module's header, and matched on by call sites) is that
/// the message names BOTH the requested and the staged env, and this condition has no
/// staged env to name. Its remedy differs too — state the association, rather than stage
/// the other env — so a caller branching on the code gets the right one.
pub const ENV_STAGED_UNASSOCIATED_CODE: &str = "ENV_IMAGE_STAGED_ENV_UNASSOCIATED";

/// The typed code for a per-env artifact that IS declared for the requested env but
/// cannot be used (a missing path, a dir without `usr/`).
pub const ENV_STAGED_UNUSABLE_CODE: &str = "ENV_IMAGE_STAGED_ENV_UNUSABLE";

/// The run-scoped env-digest sidecar, written into the run's OWN workspace root.
///
/// Deliberately at the workspace ROOT and not under `home/`, `inputs/` or `code/` — those
/// three are the only dirs bound into the sandbox, so nothing the analysis code can do
/// reaches this file. Provenance must record what the PLATFORM mounted, not what the
/// sandboxed run claims it mounted.
const RUN_ENV_DIGEST_FILE: &str = "env-digest";

/// Record, for THIS run, the content digest of the env image it mounted (INV-3).
///
/// This is the run-scoped replacement for the `LAST_RESOLVED_DIGEST` process-global. The
/// workspace file is the right carrier rather than an in-memory field because the reader
/// is two stack frames and, on the crash-recovery path
/// (`scheduler::reconcile_orphaned_running`), a whole PROCESS LIFETIME away — an
/// in-memory value would be `None` there, silently un-pinning every run that was
/// interrupted by a restart. It also mirrors the two side-channels the recorder already
/// reads back off the run's own directories (`inputs/inputs.json` via
/// `recorded_mount_names`, and the `run-environment` output), whose shared rule is:
/// record what ran, do not re-derive it later.
///
/// Best-effort by design: a failure to write costs the run its `env_rootfs_sha256` pin
/// (recorded as absent — the honest answer) and is logged, but must never fail a job
/// that is otherwise ready to execute.
pub fn write_run_env_digest(workspace_root: &Path, digest: Option<&str>) {
    let path = workspace_root.join(RUN_ENV_DIGEST_FILE);
    let Some(hex) = digest else {
        // NO digest for this attempt ⇒ REMOVE any sidecar a previous one left.
        //
        // Returning early here was a real defect: a run workspace is deliberately KEPT
        // on a failed finalize (`RunDirs::Preserve`, "kept for inspection/retry"), so a
        // retry that mounts a seam carrying no content identity would inherit the FIRST
        // attempt's digest and provenance would record it as this run's image — the
        // confident-but-wrong reference this whole mechanism exists to prevent.
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(
                path = %path.display(),
                error = %e,
                "could not clear a stale env-digest sidecar; a retry of this job could \
                 record the previous attempt's image"
            ),
        }
        return;
    };
    if let Err(e) = std::fs::write(&path, hex) {
        tracing::warn!(
            path = %path.display(),
            error = %e,
            "could not record this run's env digest; the run will record no env_rootfs_sha256"
        );
    }
}

/// Read back the digest [`write_run_env_digest`] recorded for the run rooted at
/// `workspace_root`. `None` when the run never mounted an env image (an in-app
/// interaction run, a promote/byte-copy run), when the seam could not name a digest (a
/// bare pre-mounted dir), or when the file is unreadable/malformed.
///
/// `None` is the CORRECT answer in every one of those cases, and is why this does not
/// fall back to the process-global: inheriting whatever another run resolved most
/// recently is precisely the corruption INV-3 exists to prevent — it writes a
/// confident, wrong image reference into the reproduce path.
pub fn read_run_env_digest(workspace_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace_root.join(RUN_ENV_DIGEST_FILE)).ok()?;
    let hex = raw.trim();
    crate::modules::rootfs::cache::is_valid_digest(hex).then(|| hex.to_string())
}

/// The env-var suffix separator for a per-env air-gap seam: `TXR_ENV_ROOTFS_*__<env-id>`.
///
/// A DOUBLE underscore purely for READABILITY against the `TXR_ENV_ROOTFS_SQUASHFS_ENV`
/// association variable, which a single underscore would sit confusingly close to.
/// Parsing is unambiguous either way, because the prefix is FIXED-LENGTH and stripped as
/// a whole — the env-id is whatever remains. (An earlier version of this comment claimed
/// a doubled separator "cannot occur in a well-formed id"; that is false, since the
/// grammar permits `_` and `a__b` is well-formed. Nothing depended on the claim, but a
/// wrong reason is worse than none — it invites a change that preserves the reason and
/// breaks the behaviour.)
const ENV_SEAM_SUFFIX: &str = "__";

/// The air-gap seam variable KEYS, in consultation order. ONE list (PROV-E1-6's
/// derive-not-enumerate thesis applied to this module's own vocabulary): `provide`, both
/// resolvers and the refusal all read it, so a third seam added later cannot be served by
/// some of them and silently skipped by the rest — which would fail OPEN, falling through
/// to an OCI pull the operator air-gapped themselves away from.
const SEAM_KEYS: [&str; 2] = ["TXR_ENV_ROOTFS_SQUASHFS", "TXR_ENV_ROOTFS_DIR"];

/// Which locally-staged squashfs — if any — SERVES `env_id`.
///
/// This is PROV-E1-5's positive half. The rule, in order:
///
/// 1. `TXR_ENV_ROOTFS_SQUASHFS__<env_id>` set ⇒ that file serves this env. Exact,
///    unambiguous, and the shape a multi-env air-gapped deployment should use.
/// 2. Otherwise the bare `TXR_ENV_ROOTFS_SQUASHFS`, if set, serves exactly ONE env —
///    the one named by `TXR_ENV_ROOTFS_SQUASHFS_ENV`, else the deployment default.
///    Requesting THAT env is served.
/// 3. Anything else ⇒ this seam DECLINES (`None`).
///
/// **It never refuses.** Every refusal is deferred to [`staged_env_refusal`], which runs
/// only after EVERY seam has declined. That split is load-bearing: a deployment may
/// legitimately stage one env as a squashfs and another as a pre-mounted dir, and a seam
/// that refused from inside itself would reject the second env while naming the first —
/// which is exactly the bug an audit found in the first version of this split, where only
/// the sibling case had been deferred and the mismatch/unassociated cases had not.
///
/// **Why the refusal exists at all.** A staged rootfs is one env's filesystem: it has
/// that env's interpreter and that env's libraries. Serving it for a different env does
/// not degrade gracefully — it runs the job's code against the wrong toolchain and
/// reports whatever that produces, with nothing anywhere naming the substitution. "R is
/// broken" and "you staged the python rootfs and asked for the R one" send a reader to
/// two very different places.
///
/// Back-compat: a single-env deployment setting only the bare variable — every air-gapped
/// install today, and `just e2e-processors` — asks only for its own default env, matches
/// rule 2, and is served precisely as before (DEC-3). The one behaviour that CHANGED is
/// that a bare artifact the deployment can name no env for is refused rather than served
/// for anything (see [`env_unassociated`]).
fn staged_squashfs_for(env_id: &str) -> Option<PathBuf> {
    seam_serves(SEAM_KEYS[0], env_id, default_env_id)
}

/// The pre-mounted-dir twin of [`staged_squashfs_for`] (`TXR_ENV_ROOTFS_DIR`), by the
/// identical rule so the legacy seam cannot become a way to get the substitution back.
fn staged_rootfs_dir_for(env_id: &str) -> Option<PathBuf> {
    seam_serves(SEAM_KEYS[1], env_id, default_env_id)
}

/// Does the seam named `key` SERVE `env_id`? — the shared body of both resolvers.
///
/// `deployment_default` is injected so the unassociated branch is testable
/// deterministically: whether the real `default_env_id()` returns `None` depends on
/// whether some other test in the binary has published a registry, which would make a
/// test of that branch pass or fail by execution order rather than by behaviour.
fn seam_serves(
    key: &str,
    env_id: &str,
    deployment_default: impl Fn() -> Option<String>,
) -> Option<PathBuf> {
    // 1. An exact per-env variable always wins and consults nothing else.
    if let Some(p) = env_path(&format!("{key}{ENV_SEAM_SUFFIX}{env_id}")) {
        return Some(p);
    }
    // 2. The bare variable serves exactly one env: the explicitly declared one, else the
    //    deployment default. `<key>_ENV` exists so an operator can state the association
    //    directly instead of relying on the default resolving to the same thing.
    let bare = env_path(key)?;
    let served = std::env::var(format!("{key}_ENV"))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(deployment_default)?;
    (served == env_id).then_some(bare)
}

/// Refusal for a staged artifact the deployment cannot associate with any env
/// (PROV-E1-5). Distinct from [`env_mismatch`] because the remedy differs: there is no
/// "staged env" to name, so the message asks the operator to state the association.
fn env_unassociated(key: &str, requested: &str) -> AppError {
    tracing::error!(
        requested_env = %requested,
        seam = %key,
        "refusing to run a job against a staged rootfs that is not associated with any env"
    );
    AppError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        ENV_STAGED_UNASSOCIATED_CODE,
        format!(
            "`{key}` stages a rootfs but nothing says which env it serves, and this job \
             requested env {requested:?}. Refusing to assume: if the staged image is not \
             {requested:?}'s, the job would run against the wrong interpreter and \
             libraries and fail as though the analysis were broken. Set \
             `{key}_ENV=<env-id>` to say what the staged rootfs is, or stage this env \
             explicitly with `{key}{ENV_SEAM_SUFFIX}{requested}=<path>`.{}",
            declared_union_hint()
        ),
    )
}

/// The refusal to raise when NO seam serves `env_id` — `None` when nothing is staged
/// anywhere, in which case the caller falls through to the OCI path as an un-air-gapped
/// deployment should.
///
/// Raised ONCE, after every seam has declined, and it owns ALL THREE refusal kinds:
/// a sibling env is staged under some seam; a bare artifact is associated with a
/// DIFFERENT env; a bare artifact is associated with nothing. Keeping them here rather
/// than inside the seams is what lets a deployment stage one env per seam — an audit
/// found the first version of this split had deferred only the sibling case, so seam 1's
/// other two refusals still preempted seam 2 and rejected a legitimately-staged env.
fn staged_env_refusal(env_id: &str) -> Option<AppError> {
    staged_env_refusal_with(env_id, default_env_id)
}

/// [`staged_env_refusal`] against an explicit deployment-default resolver (see
/// [`seam_serves`] for why the injectable form exists).
fn staged_env_refusal_with(
    env_id: &str,
    deployment_default: impl Fn() -> Option<String> + Copy,
) -> Option<AppError> {
    // (a) A SIBLING env is staged under an exact per-env variable. `env_id` is excluded
    //     from the sibling list: without that, a seam whose own `__<env_id>` variable is
    //     set but unusable (a typo'd path, an unmounted volume, a dir missing `usr/`)
    //     produced a self-contradictory refusal — "serves env-b, but this job requested
    //     env-b" — telling the operator to set the variable they had already set.
    for key in SEAM_KEYS {
        if let Some(served) = suffixed_envs_for(key).iter().find(|e| *e != env_id) {
            return Some(env_mismatch(key, env_id, served, true));
        }
    }
    // (b) A BARE artifact is staged and associated with a different env.
    // (c) …or associated with nothing at all.
    for key in SEAM_KEYS {
        if env_path(key).is_none() {
            continue;
        }
        let served = std::env::var(format!("{key}_ENV"))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(deployment_default);
        return Some(match served {
            Some(served) => env_mismatch(key, env_id, &served, false),
            None => env_unassociated(key, env_id),
        });
    }
    // (d) A per-env variable for THIS env exists but the seam still declined — i.e. it is
    //     set to something unusable. Say THAT, rather than reporting a mismatch against
    //     the very env that was asked for.
    for key in SEAM_KEYS {
        if let Some(p) = env_path(&format!("{key}{ENV_SEAM_SUFFIX}{env_id}")) {
            return Some(AppError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                ENV_STAGED_UNUSABLE_CODE,
                format!(
                    "`{key}{ENV_SEAM_SUFFIX}{env_id}` is set to {} but that artifact is \
                     not usable (a pre-mounted dir must contain `usr/`; a squashfs must \
                     be a readable file). Refusing rather than falling back to another \
                     env's rootfs or to a registry pull this deployment is air-gapped \
                     from.",
                    p.display()
                ),
            ));
        }
    }
    None
}

/// Every env-id for which a `<key>__<env>` variable is set, sorted — used only to build
/// a refusal message that tells the operator what IS staged.
fn suffixed_envs_for(key: &str) -> Vec<String> {
    let prefix = format!("{key}{ENV_SEAM_SUFFIX}");
    // `vars_os`, NOT `vars`: the latter PANICS while iterating if ANY variable in the
    // process environment is non-UTF-8 — not merely a matching one. This runs on the
    // common path (every `provide()` in a registry-backed deployment), and the panic
    // would surface inside `spawn_blocking` as an opaque "staging task join" error
    // naming nothing about the cause. A non-UTF-8 variable simply cannot be one of ours,
    // so skipping it is both safe and correct.
    let mut out: Vec<String> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let (k, v) = (k.into_string().ok()?, v.into_string().ok()?);
            let id = k.strip_prefix(&prefix)?;
            (!v.is_empty() && !id.is_empty()).then(|| id.to_string())
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The refusal (PROV-E1-5 / INV-2): loud, typed, and naming BOTH envs.
fn env_mismatch(key: &str, requested: &str, served: &str, suffixed: bool) -> AppError {
    let staged_desc = if suffixed {
        format!("{key}{ENV_SEAM_SUFFIX}{served}")
    } else {
        key.to_string()
    };
    tracing::error!(
        requested_env = %requested,
        staged_env = %served,
        seam = %staged_desc,
        "refusing to run a job in an env the locally staged rootfs does not serve"
    );
    AppError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "ENV_IMAGE_STAGED_ENV_MISMATCH",
        format!(
            "the locally staged rootfs serves env {served:?}, but this job requested env \
             {requested:?}. Refusing to substitute: the staged image carries {served:?}'s \
             interpreter and libraries, so running {requested:?}'s code against it would fail \
             as though the analysis were broken. Stage the requested env with \
             `{key}{ENV_SEAM_SUFFIX}{requested}=<path>`, or unset `{staged_desc}` to fetch \
             {requested:?} from the registry.{}",
            declared_union_hint()
        ),
    )
}

/// A trailing " (this deployment declares envs: …)" for a refusal message, or empty when
/// the registry is not built.
///
/// strip-single-cell ITEM-3: `declared_env_ids()` was removed with the
/// `extensions` registry; the hint is empty (the refusal names the requested
/// and the staged env, and the operator fixes it with `TXR_ENV_ROOTFS_*_ENV`).
fn declared_union_hint() -> String {
    String::new()
}

/// A non-empty env var read as a path (`None` when unset or empty).
fn env_path(key: &str) -> Option<PathBuf> {
    let v = std::env::var(key).ok()?;
    if v.is_empty() {
        None
    } else {
        Some(PathBuf::from(v))
    }
}

/// The digest a pre-mounted `TXR_ENV_ROOTFS_DIR` corresponds to, when — and ONLY
/// when — the dir is the content-digest cache's own mount point for a digest that
/// is actually present in the cache: `<cache>/<64hex>/mnt` or `<cache>/<64hex>`.
/// Requiring `cache::has_digest` is what keeps this honest: the digest is recorded
/// only if the very squashfs it names is here to be served to a reproducer. Any
/// other dir → `None` (no digest is invented for it).
fn digest_from_cache_dir(dir: &Path) -> Option<String> {
    let cache = crate::modules::rootfs::cache::base_dir();
    // `<cache>/<hex>` itself, or its parent when the dir is the `mnt/` mount point.
    let candidates = [Some(dir.to_path_buf()), dir.parent().map(|p| p.to_path_buf())];
    for cand in candidates.into_iter().flatten() {
        if cand.parent() != Some(cache.as_path()) {
            continue;
        }
        let Some(hex) = cand.file_name().and_then(|n| n.to_str()) else { continue };
        if crate::modules::rootfs::cache::has_digest(hex) {
            return Some(hex.to_string());
        }
    }
    None
}

/// Memoized `sha256(<squashfs file>)` — hashing a ~2 GB rootfs is ~1 s, and
/// `provide()` runs on every sandbox job, so the result is cached per path for the
/// life of the process. Keyed by `(path, len, mtime)` so replacing the file behind
/// the seam re-hashes rather than pinning a stale digest.
static SQUASHFS_DIGESTS: std::sync::Mutex<
    Option<std::collections::HashMap<(PathBuf, u64, i128), String>>,
> = std::sync::Mutex::new(None);

/// The content digest (bare lowercase-hex sha256) of a rootfs squashfs FILE. This
/// is the same digest form the embedded-rootfs path used, and — unlike an OCI
/// manifest digest — it is SELF-VERIFYING: a reproducer that obtains the squashfs
/// can recompute it and prove they mounted the bytes the run recorded.
fn squashfs_content_digest(path: &Path) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};

    let meta = std::fs::metadata(path).map_err(|e| {
        AppError::new(
            axum::http::StatusCode::NOT_FOUND,
            "ENV_ROOTFS_SQUASHFS_MISSING",
            format!("TXR_ENV_ROOTFS_SQUASHFS={} is not readable: {e}", path.display()),
        )
    })?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "ENV_ROOTFS_SQUASHFS_INVALID",
            format!("TXR_ENV_ROOTFS_SQUASHFS={} is not a non-empty file", path.display()),
        ));
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    let key = (path.to_path_buf(), meta.len(), mtime);
    if let Ok(g) = SQUASHFS_DIGESTS.lock() {
        if let Some(hit) = g.as_ref().and_then(|m| m.get(&key)).cloned() {
            return Ok(hit);
        }
    }

    let mut f = std::fs::File::open(path).map_err(|e| {
        AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_ROOTFS_SQUASHFS_READ",
            format!("open {}: {e}", path.display()),
        )
    })?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| {
        AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_ROOTFS_SQUASHFS_READ",
            format!("hash {}: {e}", path.display()),
        )
    })?;
    let hex = format!("{:x}", hasher.finalize());

    if let Ok(mut g) = SQUASHFS_DIGESTS.lock() {
        g.get_or_insert_with(Default::default).insert(key, hex.clone());
    }
    Ok(hex)
}

/// Place a rootfs squashfs into the local content-digest cache at
/// `cache::squashfs_path_for(hex)` so it is mountable-by-digest AND servable to a
/// reproducer (`GET /api/sandbox/rootfs/{hex}`). No-op when already cached.
/// Hard-link first (no duplicate bytes), then symlink (cross-device), then a real
/// copy — each landing atomically via a rename so a concurrent reader never sees a
/// partial file.
fn stage_squashfs_into_cache(src: &Path, hex: &str) -> Result<(), AppError> {
    use crate::modules::rootfs::cache;
    if cache::has_digest(hex) {
        return Ok(());
    }
    let dest = cache::squashfs_path_for(hex);
    let dir = dest.parent().ok_or_else(|| {
        AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_IMAGE_CACHE",
            "cache path has no parent dir",
        )
    })?;
    let mkerr = |e: std::io::Error| {
        AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_IMAGE_CACHE",
            format!("stage rootfs into {}: {e}", dir.display()),
        )
    };
    std::fs::create_dir_all(dir).map_err(mkerr)?;
    let tmp = dir.join(format!(".stage-{}", uuid::Uuid::new_v4()));
    let staged = std::fs::hard_link(src, &tmp).is_ok() || {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(src, &tmp).is_ok()
        }
        #[cfg(not(unix))]
        {
            false
        }
    } || std::fs::copy(src, &tmp).is_ok();
    if !staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_IMAGE_CACHE",
            format!("could not stage {} into the rootfs cache at {}", src.display(), dest.display()),
        ));
    }
    // Atomic publish; a racing sibling that already published the SAME digest is
    // fine (identical content), so a rename failure only matters if nothing landed.
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        if !cache::has_digest(hex) {
            return Err(mkerr(e));
        }
    }
    Ok(())
}

/// Air-gap seam 1: mount the operator-supplied rootfs squashfs BY ITS CONTENT
/// DIGEST, recording that digest for provenance. Content-hash → stage into the
/// digest cache → record → mount-by-digest.
fn provide_from_squashfs(path: &Path, deadline: Instant) -> Result<ProvidedEnv, AppError> {
    // The budget applies HERE too, not only to the OCI path. This seam's two steps —
    // sha256 over a multi-GB rootfs and, when hardlink+symlink both fail (a cross-device
    // cache), a full byte copy — are exactly the "pre-spawn staging can't hang forever"
    // case the budget was added for. Local I/O cannot be interrupted mid-syscall, so the
    // check is BETWEEN steps: an overrun is reported as the same typed
    // `ENV_IMAGE_STAGING_TIMEOUT` instead of the job silently sitting at `running`.
    remaining(deadline, "squashfs content-digest")?;
    let hex = squashfs_content_digest(path)?;
    remaining(deadline, "squashfs cache staging")?;
    stage_squashfs_into_cache(path, &hex)?;
    remaining(deadline, "squashfs mount")?;
    // Record BEFORE mounting so the pin is set even if a mount races; the digest is
    // already proven present in the cache, which is what makes it obtainable.
    set_last_resolved_digest(&hex);
    Ok(ProvidedEnv {
        rootfs_dir: crate::modules::rootfs::ensure_ready_by_digest(&hex)?,
        digest: Some(hex),
    })
}

/// Debug-only: a provider pointed at a LOCAL registry ([`EnvImageSeams::registry`])
/// uses plain HTTP (the loopback `registry:2` has no TLS). Production (GHCR) is
/// always HTTPS — in a release build this is unconditionally `false`.
fn plain_http(seams: &EnvImageSeams) -> bool {
    #[cfg(debug_assertions)]
    {
        return seams.registry.is_some();
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = seams;
        false
    }
}

/// Wall-clock left before `deadline`, or `ENV_IMAGE_STAGING_TIMEOUT` when the
/// whole staging budget is already spent. Called before each host-tool step so a
/// sequence of individually-quick steps can't silently overrun the total.
fn remaining(deadline: Instant, step: &str) -> Result<Duration, AppError> {
    let now = Instant::now();
    if now >= deadline {
        return Err(AppError::new(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            "ENV_IMAGE_STAGING_TIMEOUT",
            format!("env-image staging budget exhausted before {step}"),
        ));
    }
    Ok(deadline - now)
}

/// Read up to `cap` bytes, then keep draining to a sink so the child never blocks
/// on a full pipe (a chatty `oras pull` progress stream must not deadlock us, and
/// must not balloon our memory either).
fn drain_capped(mut r: impl std::io::Read, cap: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::new();
    let _ = (&mut r).take(cap as u64).read_to_end(&mut buf);
    let _ = std::io::copy(&mut r, &mut std::io::sink());
    buf
}

/// Run an `oras`/`cosign` subprocess with a clean env (only PATH + HOME so the
/// ambient docker/oras credential config is found), capture output, cap it, and
/// map a non-zero exit to a typed error. No secret is ever placed on argv.
///
/// BOUNDED (job-hang fix): the child is killed and reaped at `timeout`, and the
/// call returns `ENV_IMAGE_TOOL_TIMEOUT`. The previous `Command::output()` waited
/// forever, so a hung registry / DNS blackhole / stalled TLS handshake blocked the
/// caller — and, because the caller was an async task, the whole job executor —
/// with no terminal state ever reached.
fn run(bin: &str, args: &[&str], timeout: Duration) -> Result<String, AppError> {
    use std::process::Stdio;

    let started = Instant::now();
    let mut child = std::process::Command::new(bin)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into()))
        .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/root".into()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "ENV_IMAGE_TOOL_MISSING",
                format!("failed to run `{bin}` (host dependency; install oras/cosign): {e}"),
            )
        })?;

    // Drain both pipes on their own threads so `try_wait` polling can never
    // deadlock against a full pipe. They finish when the child's fds close —
    // which a kill guarantees — so the joins below are themselves bounded.
    let so = child.stdout.take();
    let se = child.stderr.take();
    let h_out = std::thread::spawn(move || so.map(|s| drain_capped(s, TOOL_OUTPUT_CAP)).unwrap_or_default());
    let h_err = std::thread::spawn(move || se.map(|s| drain_capped(s, TOOL_OUTPUT_CAP)).unwrap_or_default());

    let deadline = started + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "ENV_IMAGE_TOOL_FAILED",
                    format!("`{bin}` wait failed: {e}"),
                ));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait(); // reap — never leave a zombie behind
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let stdout = h_out.join().unwrap_or_default();
    let stderr = h_err.join().unwrap_or_default();

    let Some(status) = status else {
        let mut tail = String::from_utf8_lossy(&stderr).into_owned();
        tail.truncate(400);
        return Err(AppError::new(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            "ENV_IMAGE_TOOL_TIMEOUT",
            format!(
                "`{bin}` did not complete within {}s and was killed (registry unreachable, DNS \
                 blackhole, or a stalled transfer){}",
                timeout.as_secs(),
                if tail.trim().is_empty() { String::new() } else { format!("; last output: {tail}") }
            ),
        ));
    };
    if !status.success() {
        let mut msg = String::from_utf8_lossy(&stderr).into_owned();
        msg.truncate(600);
        return Err(AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "ENV_IMAGE_TOOL_FAILED",
            format!("`{bin}` failed: {msg}"),
        ));
    }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

/// `oras resolve <oci_ref:tag>` → the newest content digest (`sha256:<hex>`).
fn oras_resolve(
    pull_ref: &str,
    deadline: Instant,
    seams: &EnvImageSeams,
) -> Result<String, AppError> {
    let mut args = vec!["resolve"];
    if plain_http(seams) {
        args.push("--plain-http");
    }
    args.push(pull_ref);
    // Metadata-only: the SHORTER of the fixed control-plane cap and what is left
    // of the operator's staging budget.
    let cap = remaining(deadline, "oras resolve")?.min(TOOL_METADATA_TIMEOUT);
    let d = run("oras", &args, cap)?;
    if !d.starts_with("sha256:") {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "ENV_IMAGE_RESOLVE",
            format!("`oras resolve {pull_ref}` did not return a sha256 digest: {d}"),
        ));
    }
    Ok(d)
}

/// cosign-verify the digest-pinned image. Local tests key-verify via
/// [`EnvImageSeams::cosign_key`] (honored in debug builds only); production
/// keyless-verifies the CI's OIDC identity (the `env-images.yml` workflow signing
/// as this repo). Never mounts an unverified image.
fn cosign_verify(pinned: &str, deadline: Instant, seams: &EnvImageSeams) -> Result<(), AppError> {
    #[cfg(debug_assertions)]
    if let Some(key) = seams.cosign_key.as_ref().map(|k| k.to_string_lossy()) {
        let mut args = vec!["verify", "--key", key.as_ref(), "--insecure-ignore-tlog=true"];
        if plain_http(seams) {
            args.push("--allow-insecure-registry");
        }
        args.push(pinned);
        let cap = remaining(deadline, "cosign verify")?.min(TOOL_METADATA_TIMEOUT);
        run("cosign", &args, cap)?;
        return Ok(());
    }
    // Keyless: the image must be signed by the `env-images.yml` workflow's OIDC
    // identity IN THIS REPO. The DEFAULT is STRICT — the workflow running on
    // `refs/heads/main`, i.e. the reviewed/merged path — so production only trusts a
    // rootfs signed after merge-to-main, NOT one a write collaborator signed from an
    // arbitrary branch/tag without review (least privilege).
    //
    // [`EnvImageSeams::identity_regexp`], else `TXR_ENV_IMAGE_IDENTITY_REGEXP`
    // (both release-honored), is an OPERATOR-CONTROLLED STAGING OVERRIDE that widens
    // the accepted ref — e.g. to `@refs/(heads|tags)/.*$` — so a tag- or branch-signed
    // image can be verified PRE-merge (this is how TEST-15 verifies the `env-v0-test`
    // tag build). Setting it DELIBERATELY RELAXES identity checking; it is an explicit,
    // documented staging seam, never the default. The seam field takes precedence so a
    // test never has to write it into the process env (see [`EnvImageSeams`]).
    const ISSUER: &str = "https://token.actions.githubusercontent.com";
    const DEFAULT_IDENTITY_RE: &str =
        r"^https://github\.com/tinnlab/txresbench/\.github/workflows/env-images\.yml@refs/heads/main$";
    let identity_re = seams
        .identity_regexp
        .clone()
        .into_iter()
        .chain(std::env::var("TXR_ENV_IMAGE_IDENTITY_REGEXP").ok())
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_IDENTITY_RE.to_string());
    let cap = remaining(deadline, "cosign verify")?.min(TOOL_METADATA_TIMEOUT);
    run(
        "cosign",
        &[
            "verify",
            "--certificate-oidc-issuer",
            ISSUER,
            "--certificate-identity-regexp",
            identity_re.as_str(),
            pinned,
        ],
        cap,
    )?;
    Ok(())
}

/// RAII: remove a scratch dir on EVERY exit path (success or any `?`-early-return),
/// so a failed `oras pull` / read / rename never leaks a `.pull-*` dir under the
/// cache. `hex` changes with every published version (fetch-newest), so a
/// remove-at-start self-heal would only ever reclaim a repeat of the SAME hex —
/// this guard reclaims regardless.
struct TmpDirGuard(PathBuf);
impl Drop for TmpDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `oras pull` the squashfs to a UNIQUE per-attempt temp dir, then atomically
/// move it into the content-digest cache at `cache::squashfs_path_for(hex)`.
///
/// Concurrency: two cold-cache runs can both miss `has_digest(hex)` and pull the
/// same digest at once. Each uses a UNIQUE scratch dir (`.pull-<hex>-<uuid>`) so
/// neither deletes the other's in-flight download; both then `rename` onto the
/// same cache path — atomic, last-writer-wins, and the bytes are identical (same
/// content digest), so a racing sibling can never corrupt or fail the other's pull.
fn pull_and_stage(
    pinned: &str,
    hex: &str,
    deadline: Instant,
    seams: &EnvImageSeams,
) -> Result<(), AppError> {
    let cache = crate::modules::rootfs::cache::squashfs_path_for(hex);
    let dir = cache.parent().ok_or_else(|| {
        AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_IMAGE_CACHE",
            "cache path has no parent dir",
        )
    })?;
    std::fs::create_dir_all(dir).map_err(|e| {
        AppError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "ENV_IMAGE_CACHE", format!("mkdir cache: {e}"))
    })?;
    let tmp = dir.join(format!(".pull-{hex}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| {
        AppError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "ENV_IMAGE_CACHE", format!("mkdir tmp: {e}"))
    })?;
    let _tmp_guard = TmpDirGuard(tmp.clone()); // cleans up on every return below
    let tmp_s = tmp.to_string_lossy().into_owned();
    let mut args = vec!["pull"];
    if plain_http(seams) {
        args.push("--plain-http");
    }
    args.extend(["-o", tmp_s.as_str(), pinned]);
    // The pull is bandwidth-bound (a multi-GB squashfs over an unknown link), so
    // it gets the WHOLE remaining operator budget rather than a second knob.
    run("oras", &args, remaining(deadline, "oras pull")?)?;
    // Find the single .squashfs the artifact carried.
    let sq = std::fs::read_dir(&tmp)
        .map_err(|e| AppError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "ENV_IMAGE_CACHE", format!("read tmp: {e}")))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|x| x == "squashfs"))
        .ok_or_else(|| {
            AppError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                "ENV_IMAGE_NO_SQUASHFS",
                "pulled env image contained no .squashfs layer",
            )
        })?;
    std::fs::rename(&sq, &cache).map_err(|e| {
        AppError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "ENV_IMAGE_CACHE", format!("stage squashfs: {e}"))
    })?;
    Ok(())
}
