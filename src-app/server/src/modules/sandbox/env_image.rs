//! Env-image registry (ITEM-23 / DEC-22/23) — a per-analysis-domain registry
//! of named environment images the sandbox runs converters/analyses inside.
//!
//! WHY: one monolithic rootfs with every domain's tools (single-cell + bulk +
//! variant + spatial) has conflicting deps and is unbuildable. Instead each
//! analysis DOMAIN gets its own named env image (its own tool list). A manifest
//! declares `env: <env-id>` (see `extensions::types::ConverterContribution::env`);
//! the backend resolves the env-id to its OCI location here, then lazy-fetches +
//! cosign-verifies + mounts it before the run.
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
//! This mirrors the ziee SDK's `ziee-sandbox` `RootfsProvider` seam (fetch +
//! mount, injected so backends never name concrete fetch modules); here the
//! injected axis is the ENV rather than the flavor.
//!
//! AIR-GAP SEAMS (release-honored, checked before the OCI path, in this order).
//!
//! **Both are ENV-SCOPED (#189 / PROV-E1-5).** A staged rootfs is one env's filesystem,
//! so it is associated with an env-id and serves only that env:
//!
//! * `CYTO_ENV_ROOTFS_{SQUASHFS,DIR}__<env-id>` serves `<env-id>` exactly.
//! * The un-suffixed variable serves ONE env — `CYTO_ENV_ROOTFS_{SQUASHFS,DIR}_ENV` if
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
//! the deployment can associate with NO env (no `<key>_ENV`, no `CYTO_SANDBOX_ENV_ID`, no
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
//! 1. `CYTO_ENV_ROOTFS_SQUASHFS=<path/to/rootfs.squashfs>` — **preferred**. The
//!    provider content-hashes the file, stages it into the digest cache, RECORDS
//!    the digest, and mounts by digest. A run under it is fully reproducible: its
//!    `env_rootfs_sha256` is a self-verifying sha256 of the exact mounted bytes,
//!    those bytes are servable at `GET /api/sandbox/rootfs/{digest}`, and its
//!    export capsule therefore EXECUTES.
//! 2. `CYTO_ENV_ROOTFS_DIR=<already-mounted dir>` — legacy. A mount dir carries no
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

use ziee_core::AppError;

/// A resolved env-image reference: the digest-addressed OCI location of a
/// domain's environment image. `provenance` records `{oci_ref, digest}` on a run
/// so reproduction needs only the manifest + code + this reference (DEC-22), not
/// a bundled multi-GB rootfs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvImageRef {
    /// The OCI repository ref (per-env repo): `<registry-base>/<env-id>`, e.g.
    /// `ghcr.io/ziee-ai/cyto-env/<env-id>` (DEC-23/DEC-L).
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
/// [`ConverterContribution::env`](crate::modules::extensions::types::ConverterContribution::env));
/// this reads the first one the loaded extension registry declares, so the app
/// carries no env-name literal. An operator can override with `CYTO_SANDBOX_ENV_ID`
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
/// 1. `CYTO_SANDBOX_ENV_ID` — the OPERATOR override.
/// 2. the job's own declared `env`.
/// 3. `sandbox_settings.default_env_id` — the admin-configured deployment default.
/// 4. the union of envs the loaded registry declares.
/// 5. `None` ⇒ the caller surfaces a loud `SANDBOX_UNAVAILABLE`, never an invented name.
///
/// **The operator override sits ABOVE the declared env deliberately, and this is the one
/// ordering here that is not obvious.** A declared env is the package author's statement
/// of what their code needs, so it beats a deployment-wide default (2 over 3) — that is
/// the whole point of per-job selection. But `CYTO_SANDBOX_ENV_ID` is the operator's
/// escape hatch, used to pin a whole process to one image: it is how a single-env or
/// air-gapped deployment, a recovery run, or an in-pod re-entry forces a known env
/// regardless of what any manifest asks for. If a declared env could override it, that
/// escape hatch would stop working the moment any package declared an env — exactly when
/// an operator is most likely to need it.
///
/// Steps 3-5 are byte-identical to the pre-#189 chain, so a job declaring no env
/// resolves exactly as it did before this existed (INV-1).
pub fn resolve_env_id(declared: Option<&str>) -> Option<String> {
    if let Ok(raw) = std::env::var("CYTO_SANDBOX_ENV_ID") {
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
                        "CYTO_SANDBOX_ENV_ID overrides this job's declared env; the job \
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
    // #189 — the registry auto-detect now reads the UNION of both contribution kinds.
    //
    // ORDER IS LOAD-BEARING, and it is converters-then-analyses PER MANIFEST rather than
    // anything tidier: before this change the scan saw converters only, so putting them
    // first makes the result BYTE-IDENTICAL for every registry in which no analysis
    // declares an env — i.e. every registry that exists today (INV-1). Sorting the union
    // instead would have been a behaviour change dressed as a cleanup, silently
    // re-pointing an existing deployment at a different image the first time an analysis
    // declared an env that sorted earlier.
    let reg = crate::modules::extensions::try_registry()?;
    first_declared_env(reg.all())
}

/// Every `env` declaration in `manifests`, in the order a reader encounters them:
/// per manifest, its converters then its analyses.
///
/// The PURE core of both [`default_env_id`] and [`declared_env_ids`]. Split out so the
/// union rule is testable without installing a process-wide registry — the global
/// `set_global_registry` would make these tests order-dependent on every other test in
/// the binary, which is how a supposedly-deterministic assertion becomes a flake.
fn declared_envs_in<'a>(
    manifests: impl IntoIterator<Item = &'a crate::modules::extensions::types::ExtensionManifest>,
) -> impl Iterator<Item = &'a str> {
    manifests.into_iter().flat_map(|m| {
        m.contributes
            .converters
            .iter()
            .map(|c| c.env.as_deref())
            .chain(m.contributes.analyses.iter().map(|a| a.env.as_deref()))
    })
    .flatten()
    .map(str::trim)
    .filter(|e| !e.is_empty())
}

/// The first declared env in registry order — see [`default_env_id`] for why the order
/// is converters-then-analyses per manifest rather than anything tidier.
fn first_declared_env<'a>(
    manifests: impl IntoIterator<Item = &'a crate::modules::extensions::types::ExtensionManifest>,
) -> Option<String> {
    declared_envs_in(manifests).next().map(str::to_string)
}

/// Every env-id the loaded registry DECLARES, sorted + deduped — the union
/// `default_env_id` picks from, exposed for diagnostics that must tell an operator
/// which envs this deployment actually serves.
///
/// **Derived, never enumerated** (INV-4): it walks the same declarations the loader
/// reads, so an env a package contributes tomorrow appears here with zero edits, and one
/// that stops being declared drops out the same way. This is the shape
/// `check-derived-vocabulary.sh` argues for and `every_env_dockerfile_installs_jq`
/// already demonstrates in this module — a list typed into the code is exactly the defect
/// that guard exists to retire.
///
/// Empty when the registry is not built yet (never a guess).
pub fn declared_env_ids() -> Vec<String> {
    let Some(reg) = crate::modules::extensions::try_registry() else {
        return Vec::new();
    };
    declared_env_ids_of(reg.all())
}

/// The pure core of [`declared_env_ids`] — see [`declared_envs_in`].
fn declared_env_ids_of<'a>(
    manifests: impl IntoIterator<Item = &'a crate::modules::extensions::types::ExtensionManifest>,
) -> Vec<String> {
    let mut out: Vec<String> = declared_envs_in(manifests).map(str::to_string).collect();
    out.sort();
    out.dedup();
    out
}

/// The digest (64-hex, no scheme) the provider most recently resolved+mounted —
/// read by `provenance::capture::env_digest_rootfs` so a run records the OCI
/// content digest it ran on (ITEM-4, provenance-by-reference). Replaces the
/// former embedded-rootfs sha (embedding is gone).
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
/// `ghcr.io/ziee-ai/cyto-env/<env>`. Overridable per-provider via
/// [`EnvImageSeams::registry`] (ITEM-5 loopback seam, honored in debug builds only).
const DEFAULT_REGISTRY: &str = "ghcr.io/ziee-ai/cyto-env";

/// Per-provider configuration of the registry + signature-verification seams,
/// passed EXPLICITLY into [`OciEnvImageProvider::with_seams`].
///
/// **Why this is a parameter and not an env var.** `CYTO_ENV_IMAGE_REGISTRY` and
/// `CYTO_ENV_IMAGE_COSIGN_KEY` used to configure these seams, read LIVE and
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
    /// `CYTO_ENV_IMAGE_IDENTITY_REGEXP` and the strict `@refs/heads/main` default.
    /// Release-honored (operator staging override).
    pub identity_regexp: Option<String>,
    /// Ignore the AIR-GAP env seams (`CYTO_ENV_ROOTFS_SQUASHFS` /
    /// `CYTO_ENV_ROOTFS_DIR`) and drive the real resolve → verify → pull → mount
    /// path. Debug builds only.
    ///
    /// This closes the LAST place the process environment could still overrule a
    /// provider that was configured explicitly — the failure class this whole struct
    /// exists to remove, in the other direction. The air-gap seams are consulted at
    /// the TOP of [`OciEnvImageProvider::provide`], so a run that exports
    /// `CYTO_ENV_ROOTFS_SQUASHFS` — which is the DOCUMENTED procedure for the
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

/// The compiled env-image registry BASE (`ghcr.io/ziee-ai/cyto-env`), for READ-ONLY
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

/// A `RootfsProvider`-style seam (mirrors the SDK's `ziee-sandbox`
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
    /// `CYTO_ENV_IMAGE_IDENTITY_REGEXP` staging override is set).
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
        // `CYTO_ENV_ROOTFS_SQUASHFS__<env-id>=<path>` serves THAT env; the un-suffixed
        // `CYTO_ENV_ROOTFS_SQUASHFS=<path>` serves a single-env deployment exactly as it
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
        // `CYTO_ENV_ROOTFS_DIR` points at an ALREADY-MOUNTED rootfs dir (the dir
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
                            "CYTO_ENV_ROOTFS_DIR: a bare pre-mounted dir has no content identity, so \
                             runs record NO env_rootfs_sha256 and their export capsules cannot be \
                             executed — point CYTO_ENV_ROOTFS_SQUASHFS at the squashfs file instead"
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

/// The env-var suffix separator for a per-env air-gap seam: `CYTO_ENV_ROOTFS_*__<env-id>`.
///
/// A DOUBLE underscore purely for READABILITY against the `CYTO_ENV_ROOTFS_SQUASHFS_ENV`
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
const SEAM_KEYS: [&str; 2] = ["CYTO_ENV_ROOTFS_SQUASHFS", "CYTO_ENV_ROOTFS_DIR"];

/// Which locally-staged squashfs — if any — SERVES `env_id`.
///
/// This is PROV-E1-5's positive half. The rule, in order:
///
/// 1. `CYTO_ENV_ROOTFS_SQUASHFS__<env_id>` set ⇒ that file serves this env. Exact,
///    unambiguous, and the shape a multi-env air-gapped deployment should use.
/// 2. Otherwise the bare `CYTO_ENV_ROOTFS_SQUASHFS`, if set, serves exactly ONE env —
///    the one named by `CYTO_ENV_ROOTFS_SQUASHFS_ENV`, else the deployment default.
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

/// The pre-mounted-dir twin of [`staged_squashfs_for`] (`CYTO_ENV_ROOTFS_DIR`), by the
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
/// This is what [`declared_env_ids`] exists for. A refusal that names only the requested
/// and the staged env leaves the operator guessing what the deployment actually needs
/// staged; the union answers exactly that, and it is DERIVED from the manifests rather
/// than typed anywhere (INV-4).
fn declared_union_hint() -> String {
    let ids = declared_env_ids();
    if ids.is_empty() {
        String::new()
    } else {
        format!(" (this deployment's packages declare: {})", ids.join(", "))
    }
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

/// The digest a pre-mounted `CYTO_ENV_ROOTFS_DIR` corresponds to, when — and ONLY
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
            format!("CYTO_ENV_ROOTFS_SQUASHFS={} is not readable: {e}", path.display()),
        )
    })?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "ENV_ROOTFS_SQUASHFS_INVALID",
            format!("CYTO_ENV_ROOTFS_SQUASHFS={} is not a non-empty file", path.display()),
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
    // [`EnvImageSeams::identity_regexp`], else `CYTO_ENV_IMAGE_IDENTITY_REGEXP`
    // (both release-honored), is an OPERATOR-CONTROLLED STAGING OVERRIDE that widens
    // the accepted ref — e.g. to `@refs/(heads|tags)/.*$` — so a tag- or branch-signed
    // image can be verified PRE-merge (this is how TEST-15 verifies the `env-v0-test`
    // tag build). Setting it DELIBERATELY RELAXES identity checking; it is an explicit,
    // documented staging seam, never the default. The seam field takes precedence so a
    // test never has to write it into the process env (see [`EnvImageSeams`]).
    const ISSUER: &str = "https://token.actions.githubusercontent.com";
    const DEFAULT_IDENTITY_RE: &str =
        r"^https://github\.com/ziee-ai/cytoanalyst/\.github/workflows/env-images\.yml@refs/heads/main$";
    let identity_re = seams
        .identity_regexp
        .clone()
        .into_iter()
        .chain(std::env::var("CYTO_ENV_IMAGE_IDENTITY_REGEXP").ok())
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

/// THE process-environment lock for this crate's tests.
///
/// `PodShape::from_env`, `default_env_id`, `resolve_env_id` and both air-gap seams all
/// read the SAME process-global state (`CYTO_*` variables plus the settings-cache
/// snapshot), and #189 widened that overlap further: `staged_artifact_for` now calls
/// `default_env_id()`, so the seam tests and the env-id tests touch one another's inputs.
///
/// Before this there were three disjoint mutexes over overlapping globals, which is not
/// isolation — it is a slower race, and one that presents as an order-dependent failure
/// rather than a consistent one (exactly how it was found). Any test in ANY module that
/// sets or removes a `CYTO_*` variable, or invalidates the settings cache, must hold this.
#[cfg(test)]
static PROCESS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Take [`PROCESS_ENV_LOCK`]. Poison is deliberately ignored: a panicking test leaves the
/// mutex poisoned, and failing every SUBSEQUENT test with a poison error would bury the
/// one real failure under a pile of unrelated ones.
#[cfg(test)]
pub(crate) fn process_env_guard() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1: the registry resolves an env-id to its per-env repo + the MOVING
    // schema+arch-scoped tag (fetch-newest — NO baked digest); returns None only
    // for a MALFORMED id.
    //
    // The subject id is a NEUTRAL PLACEHOLDER on purpose (R3-F2). `resolve` has no
    // per-id branch and no allowlist — it is `format!("{base}/{id}")` behind a
    // grammar check — so naming a real analysis domain here would assert nothing
    // extra while pinning that domain into the app crate's own test surface. The
    // ITEM-29 block below proves the openness that actually matters. The SHIPPED
    // manifest's declared env-id is covered where it belongs, on the DATA side
    // (`extensions::loader`'s manifest test).
    #[test]
    fn resolve_returns_moving_schema_arch_tag() {
        let sc = resolve("demo-env").expect("a well-formed env-id resolves");
        assert_eq!(sc.oci_ref, format!("{}/demo-env", DEFAULT_REGISTRY));
        // The tag is schema-scoped (binary's schema) + arch-suffixed, NOT a digest.
        let expect_tag = format!(
            "schema{}-latest-{}",
            crate::modules::rootfs::version::ROOTFS_SCHEMA_VERSION,
            target_arch()
        );
        assert_eq!(sc.tag, expect_tag);
        assert!(!sc.tag.contains("sha256:"), "the tag is not a digest (resolved at pull time)");
        // The app-owned half of the ref is the REGISTRY BASE and only that. Pinned
        // literally here (it is a real published location, product-scoped, carrying
        // no analysis domain) so a silent change to `DEFAULT_REGISTRY` still fails.
        assert_eq!(DEFAULT_REGISTRY, "ghcr.io/ziee-ai/cyto-env");
        assert_eq!(sc.pull_ref(), format!("{}/demo-env:{expect_tag}", DEFAULT_REGISTRY));
        assert_eq!(
            sc.pinned_at("sha256:abc"),
            format!("{}/demo-env@sha256:abc", DEFAULT_REGISTRY)
        );

        // ITEM-29: the registry is OPEN, not an allowlist. A well-formed env-id that
        // no image has been published for still RESOLVES to its per-env repo — adding
        // a domain is `env-rootfs/<env>/` + a CI build, with ZERO core edit. The
        // failure for such an id happens at PULL time, from the registry itself.
        for e in ["bulk-rnaseq", "variant", "spatial", "nope"] {
            let r = resolve(e).unwrap_or_else(|| panic!("{e} is a well-formed env-id"));
            assert_eq!(r.oci_ref, format!("{}/{e}", DEFAULT_REGISTRY), "per-env repo for {e}");
        }
        // Only a MALFORMED id is refused — the guard that keeps a manifest-supplied
        // value from injecting a tag / digest / registry host into the ref we pull.
        for bad in ["", "Single-Cell", "a/b", "x:tag", "y@sha256:abc", "has space"] {
            assert!(resolve(bad).is_none(), "{bad:?} is not a valid repo path component");
        }
    }

    // TEST-11 [ITEM-6]: the env-id grammar `is_valid_env_id` (used by both `resolve`
    // and the settings `validate()`) accepts OCI path components and rejects anything
    // that could smuggle a tag/digest/host or is otherwise malformed.
    #[test]
    fn is_valid_env_id_grammar() {
        for ok in ["demo-env", "env-two", "env.three", "env_four", "a", "x.y_z-1"] {
            assert!(is_valid_env_id(ok), "{ok} should be valid");
        }
        for bad in ["", "Single-Cell", "a/b", "x:tag", "y@sha256:abc", "has space", "UP"] {
            assert!(!is_valid_env_id(bad), "{bad:?} should be rejected");
        }
    }

    /// Serializes the tests that read/write CYTO_SANDBOX_ENV_ID + the settings cache.
    // (The former private `ENV_ID_LOCK` is gone — every user now takes the crate-wide
    // `super::process_env_guard`, because the state these tests mutate overlaps.)

    // TEST-11 [ITEM-6]: default_env_id() precedence — the env-var override wins over
    // the settings row, which wins over registry auto-detect; an UNSET settings value
    // falls through (byte-preserving, INV-2).
    #[test]
    fn default_env_id_precedence_env_then_settings() {
        use crate::modules::sandbox::settings::SandboxResourceLimits;
        use crate::modules::sandbox::settings_cache;
        let _g = super::process_env_guard();
        let saved = std::env::var("CYTO_SANDBOX_ENV_ID").ok();

        // Settings sets a default; no env var → the settings value is returned.
        std::env::remove_var("CYTO_SANDBOX_ENV_ID");
        settings_cache::invalidate(SandboxResourceLimits {
            default_env_id: Some("from-settings".into()),
            ..SandboxResourceLimits::defaults()
        });
        assert_eq!(default_env_id().as_deref(), Some("from-settings"));

        // Env var overrides the settings value.
        std::env::set_var("CYTO_SANDBOX_ENV_ID", "from-env");
        assert_eq!(default_env_id().as_deref(), Some("from-env"));

        // Unset settings (defaults) + no env var → falls through (None here: no
        // extension registry loaded in a unit test), exactly as before the setting.
        std::env::remove_var("CYTO_SANDBOX_ENV_ID");
        settings_cache::invalidate(SandboxResourceLimits::defaults());
        assert!(default_env_id().is_none(), "unset falls through to registry auto-detect");

        // **TEST-E3-20** [covers: ITEM-11] (#191) — THE CONSEQUENCE OF DECLARING AN ENV,
        // asserted rather than left to be discovered by an operator.
        //
        // A blind design-conformance round pointed out a real behaviour change this branch
        // makes and nothing recorded: a job's DECLARED env outranks the admin-configured
        // `sandbox_settings.default_env_id` (step 2 beats step 3 — E1's deliberate
        // ordering, and the whole point of per-job selection). Twelve shipped analyses
        // gained a declaration here. So on a deployment whose admin has pointed
        // `default_env_id` at some other env, those twelve now IGNORE that setting, where
        // before this branch they followed it.
        //
        // That is by design and it is not a defect — but it was invisible: no test in the
        // tree exercised a declared env against a NON-EMPTY settings default, so nothing
        // would have gone red if the precedence were reversed either. This pins the
        // behaviour so the trade is legible instead of latent.
        std::env::remove_var("CYTO_SANDBOX_ENV_ID");
        settings_cache::invalidate(SandboxResourceLimits {
            default_env_id: Some("admin-chose-this".into()),
            ..SandboxResourceLimits::defaults()
        });
        assert_eq!(
            resolve_env_id(None).as_deref(),
            Some("admin-chose-this"),
            "an env-LESS contribution still follows the admin default — unchanged"
        );
        assert_eq!(
            resolve_env_id(Some("declared-by-the-package")).as_deref(),
            Some("declared-by-the-package"),
            "a DECLARED env outranks the admin's default_env_id. That is E1's intended \
             ordering, and after #191 it applies to twelve shipped analyses that used to \
             follow the setting — the operator-visible cost of per-job selection"
        );
        // …and the operator override still outranks BOTH, which is the escape hatch that
        // makes the above tolerable: an admin who needs those twelve back on one image can
        // still pin the whole process.
        std::env::set_var("CYTO_SANDBOX_ENV_ID", "operator-pinned");
        assert_eq!(
            resolve_env_id(Some("declared-by-the-package")).as_deref(),
            Some("operator-pinned"),
            "CYTO_SANDBOX_ENV_ID outranks a declared env — without this the setting above \
             would be unrecoverable for a deployment that needs to force one image"
        );

        // Restore ambient state for sibling tests in this binary.
        settings_cache::invalidate(SandboxResourceLimits::defaults());
        match saved {
            Some(v) => std::env::set_var("CYTO_SANDBOX_ENV_ID", v),
            None => std::env::remove_var("CYTO_SANDBOX_ENV_ID"),
        }
    }

    // TEST-2: the subprocess error-mapping `cosign_verify`/`oras_resolve` rely on
    // to REJECT an unsigned/bad image maps a MISSING tool and a NON-ZERO exit to
    // distinct typed errors — never Ok. This is the mechanism that makes
    // "never mount unverified" hold: a failed `cosign verify` is a non-zero exit
    // → `ENV_IMAGE_TOOL_FAILED` → `provide()` returns Err before any mount. (The
    // positive end-to-end pull+verify+mount is the integration test; the unsigned
    // rejection is asserted end-to-end there.)
    #[test]
    fn run_maps_missing_tool_and_nonzero_exit_to_typed_errors() {
        // Missing binary → ENV_IMAGE_TOOL_MISSING.
        let miss = run("cyto-nonexistent-tool-xyz", &["--version"], Duration::from_secs(30)).unwrap_err();
        assert_eq!(miss.error_code(), "ENV_IMAGE_TOOL_MISSING");

        // Present binary, non-zero exit (what a rejected `cosign verify` is) →
        // ENV_IMAGE_TOOL_FAILED, NOT Ok.
        let fail = run("sh", &["-c", "echo boom 1>&2; exit 7"], Duration::from_secs(30)).unwrap_err();
        assert_eq!(fail.error_code(), "ENV_IMAGE_TOOL_FAILED");

        // A zero-exit tool returns Ok(trimmed-stdout) — the success shape.
        let ok = run("sh", &["-c", "printf ' sha256:abc \n'"], Duration::from_secs(30)).unwrap();
        assert_eq!(ok, "sha256:abc");
    }

    // JOB-HANG FIX: a host tool that never returns (the shape of `oras`/`cosign`
    // talking to a hung registry, a DNS blackhole, or a stalled TLS handshake) is
    // KILLED at the deadline and mapped to a typed, diagnostic error — it does NOT
    // block its caller forever. Before the fix `run` used `Command::output()`,
    // which waits indefinitely; that unbounded wait is what pinned a job at
    // `running` with no terminal state, because the executor's wall-clock deadline
    // only starts once a live CHILD exists.
    //
    // Deterministic: a real subprocess that genuinely never exits on its own
    // (`sleep 3600`), bounded by a 1s budget, asserted to return in well under it.
    #[test]
    fn run_kills_and_reports_a_hung_tool_instead_of_waiting_forever() {
        let started = Instant::now();
        let err = run("sleep", &["3600"], Duration::from_secs(1)).unwrap_err();
        let elapsed = started.elapsed();

        assert_eq!(err.error_code(), "ENV_IMAGE_TOOL_TIMEOUT");
        assert!(
            err.to_string().contains("did not complete within 1s"),
            "the error names the budget it blew, so an operator can act on it: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "returned in {elapsed:?} — bounded, not the 3600s the child would have taken"
        );
    }

    // JOB-HANG FIX (budget accounting): the staging budget is a TOTAL across the
    // resolve → verify → pull sequence, so a budget already spent short-circuits
    // the NEXT step instead of granting it a fresh full timeout. Without this, three
    // sequential steps could each burn the cap and treble the real ceiling.
    #[test]
    fn remaining_short_circuits_once_the_budget_is_spent() {
        let live = Instant::now() + Duration::from_secs(60);
        assert!(remaining(live, "oras pull").expect("budget left") > Duration::from_secs(50));

        let spent = Instant::now() - Duration::from_secs(1);
        let err = remaining(spent, "oras pull").unwrap_err();
        assert_eq!(err.error_code(), "ENV_IMAGE_STAGING_TIMEOUT");
        assert!(err.to_string().contains("oras pull"), "names the step it refused: {err}");
    }

    // TEST-14 [ITEM-6/ITEM-1]: a bad env-id → a clear typed ERROR, NEVER a silent
    // embedded fallback (DEC-24 reversed).
    //
    // ITEM-29 narrowed WHICH ids short-circuit before the network. The env registry
    // is now open (the env-id is manifest DATA, not a core allowlist), so a
    // well-formed-but-unpublished name is no longer knowable up front — it fails at
    // pull time with the registry's own error, exactly like a typo'd container image.
    // `ENV_IMAGE_UNKNOWN` is therefore reserved for a MALFORMED id, which is the case
    // that must never reach a subprocess (it could otherwise smuggle a `:tag` /
    // `@digest` / registry host into the pull ref).
    /// Serializes the two tests in this module that read or write the AIR-GAP env vars.
    ///
    /// `provide()` reads them live off the process environment, and one test binary is
    /// one process: `provide_unknown_env_errors` clears them and
    /// `bypass_air_gap_env_takes_the_oci_path_while_the_seam_is_set` sets one, so run in
    /// parallel each can make the other measure the wrong branch. Poison is recovered
    /// rather than propagated — a panic in one of these must fail THAT test, not turn its
    /// neighbour into a second, misleading failure.
    static AIR_GAP_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn air_gap_env_guard() -> std::sync::MutexGuard<'static, ()> {
        // ONE lock for all of it — see `process_env_guard`'s note. `AIR_GAP_ENV_LOCK` is
        // kept only so the older tests' name still resolves; it guards nothing alone.
        let _ = &AIR_GAP_ENV_LOCK;
        super::process_env_guard()
    }



    #[test]
    fn provide_unknown_env_errors() {
        let _lock = air_gap_env_guard();
        std::env::remove_var("CYTO_ENV_ROOTFS_DIR"); // ignore any ambient override
        std::env::remove_var("CYTO_ENV_ROOTFS_SQUASHFS");
        let err = OciEnvImageProvider::new()
            .provide("Bogus/Env:xyz", Duration::from_secs(30))
            .unwrap_err();
        assert_eq!(err.error_code(), "ENV_IMAGE_UNKNOWN");
    }

    // `bypass_air_gap_env` makes a provider ignore the PROCESS-WIDE air-gap seams and
    // take the OCI path.
    //
    // The property is asserted through `provide()`, on a process that HAS the seam set to
    // a real, stageable file, because the whole point is which branch runs when the
    // ambient environment says one thing and the provider says another:
    //   * default provider → seam 1 → Ok(mount of the operator's file)
    //   * bypassing provider → past both seams → the OCI path, which for a malformed
    //     env-id is the `ENV_IMAGE_UNKNOWN` error. Reaching an error only the OCI path
    //     can produce IS the proof it got there — and it is the cheapest such proof,
    //     needing no registry.
    // Without the bypass, the second call would return the same `Ok` as the first: that
    // is exactly what silently disabled `sandbox::env_image_oci_test` (and with it the
    // only end-to-end cosign verification) whenever the documented rootfs procedure was
    // followed.
    #[test]
    fn bypass_air_gap_env_takes_the_oci_path_while_the_seam_is_set() {
        let _lock = air_gap_env_guard();
        let tmp = std::env::temp_dir().join(format!("cyto-env-bypass-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("rootfs.squashfs");
        let body = format!("stand-in-{}", uuid::Uuid::new_v4()).into_bytes();
        std::fs::write(&src, body).unwrap();
        let _data = crate::modules::rootfs::scoped_data_root(&tmp);

        // CONTROL: the ambient seam is honored by a default provider. (`provide` mounts,
        // which needs squashfuse; the assertion that matters is that it did NOT take the
        // OCI path, so an environment without squashfuse is still a valid control — it
        // fails inside seam 1's own staging/mount, never with `ENV_IMAGE_UNKNOWN`.)
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS", &src);
        let control = OciEnvImageProvider::new().provide("Bogus/Env:xyz", Duration::from_secs(30));
        assert_ne!(
            control.as_ref().err().map(|e| e.error_code().to_string()),
            Some("ENV_IMAGE_UNKNOWN".to_string()),
            "the default provider must take the air-gap seam, not the OCI path"
        );

        // …and the bypassing provider walks past it to the OCI path.
        let bypassed = OciEnvImageProvider::with_seams(EnvImageSeams {
            bypass_air_gap_env: true,
            ..EnvImageSeams::default()
        })
        .provide("Bogus/Env:xyz", Duration::from_secs(30));
        assert_eq!(
            bypassed.err().map(|e| e.error_code().to_string()),
            Some("ENV_IMAGE_UNKNOWN".to_string()),
            "a bypassing provider must reach the OCI path even with the air-gap seam set"
        );

        std::env::remove_var("CYTO_ENV_ROOTFS_SQUASHFS");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // The air-gap seam-1 fix: a run under `CYTO_ENV_ROOTFS_SQUASHFS` PINS a real,
    // self-verifying env digest. `squashfs_content_digest` is exactly sha256 of the
    // bytes, memoized; `stage_squashfs_into_cache` makes that digest present in the
    // content-digest cache (so `ensure_ready_by_digest` can mount it and the serve
    // endpoint can hand it to a reproducer). This is the wire that was missing:
    // before the fix the seam returned a mount dir and recorded NOTHING, so every
    // exported capsule printed "no pinned environment (not executed)".
    #[test]
    fn squashfs_seam_hashes_and_stages_a_pinnable_digest() {
        use sha2::{Digest, Sha256};
        let tmp = std::env::temp_dir().join(format!("cyto-env-seam-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("rootfs.squashfs");
        let bytes = format!("not-a-real-squashfs-{}", uuid::Uuid::new_v4()).into_bytes();
        std::fs::write(&src, &bytes).unwrap();

        let want = format!("{:x}", Sha256::digest(&bytes));
        let hex = squashfs_content_digest(&src).expect("hashes the file");
        assert_eq!(hex, want, "the pinned digest IS sha256 of the mounted bytes (self-verifying)");
        assert_eq!(squashfs_content_digest(&src).unwrap(), want, "memoized, same answer");

        // Not yet in the cache → not obtainable; staging makes it obtainable.
        let cache = crate::modules::rootfs::cache::squashfs_path_for(&hex);
        assert!(!crate::modules::rootfs::cache::has_digest(&hex));
        stage_squashfs_into_cache(&src, &hex).expect("stages into the digest cache");
        assert!(
            crate::modules::rootfs::cache::has_digest(&hex),
            "the pinned digest is present in the cache → servable to a reproducer"
        );
        assert_eq!(std::fs::read(&cache).unwrap(), bytes, "the staged bytes are the source bytes");
        stage_squashfs_into_cache(&src, &hex).expect("re-staging is a no-op");

        // A cache-shaped pre-mount dir derives the SAME digest; an arbitrary dir
        // derives none (no digest is ever invented).
        let dir = crate::modules::rootfs::cache::digest_dir(&hex);
        assert_eq!(digest_from_cache_dir(&dir).as_deref(), Some(hex.as_str()));
        assert_eq!(digest_from_cache_dir(&dir.join("mnt")).as_deref(), Some(hex.as_str()));
        assert_eq!(digest_from_cache_dir(&tmp), None, "an arbitrary mount dir pins nothing");

        // A missing / empty file is a clear typed error, never a silent unpinned run.
        assert_eq!(
            squashfs_content_digest(&tmp.join("nope.squashfs")).unwrap_err().error_code(),
            "ENV_ROOTFS_SQUASHFS_MISSING"
        );
        let empty = tmp.join("empty.squashfs");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            squashfs_content_digest(&empty).unwrap_err().error_code(),
            "ENV_ROOTFS_SQUASHFS_INVALID"
        );

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(cache.parent().unwrap());
    }

    // #196/#191 MERGE — E3's `apt_installs_package` helper and its test were REMOVED here.
    // That is a deliberate ruling, not a merge accident: DO NOT RE-ADD THEM.
    //
    // Both branches concluded the static read of a Dockerfile is a TRIPWIRE, not the
    // guarantee — then diverged on what to do with it. E3 hardened the predicate; this
    // item stopped trying to. Rounds 4/5/6 here each defeated the PREVIOUS predicate (a
    // comment containing " jq ", a YAML block scalar, an `echo` naming the command, a
    // decoy `COPY --from=`). That is an unbounded evasion space: a hardened predicate is
    // a better predicate on the same treadmill. Shipping two static predicates would
    // assert one of them is sound, when the conclusion both branches reached is neither is.
    //
    // The guarantee is BEHAVIOURAL, in two tiers that do not subsume each other — see
    // scripts/lib/env-image-verify.sh, which names which one is authoritative.


    // TEST-12 [ITEM-9]: EVERY published env recipe installs `jq`, so any converter
    // wrapper script can parse `params.json`. The recipes are the source of truth —
    // assert the dependency ships.
    //
    // R3-F2: this used to `include_str!` ONE domain's recipe by name
    // (`env-rootfs/<a-domain>/Dockerfile`), which pinned that domain into the app
    // crate at COMPILE time — the build itself would not have compiled had the
    // directory been renamed. It now DISCOVERS `env-rootfs/<env-id>/Dockerfile` at
    // runtime, exactly as `build_helper::sandbox_rootfs` does, so the assertion
    // covers every env that ships (strictly more than before) and names none.
    /// Cut an instruction at its first UNQUOTED `#`, i.e. the shell comment Docker hands to
    /// `/bin/sh` and which therefore runs nothing.
    ///
    /// #196 R4: dropping whole comment LINES is not enough. A trailing comment rides inside
    /// a real instruction and every `contains`-style predicate downstream reads it as if it
    /// were code — so `RUN true  # loads everything in requirements.txt` claimed the
    /// DERIVED smoke shape, and `RUN apt-get install -y curl  # jq comes from the base
    /// image` claimed a jq install. Both were proved live (M22/M24). This is the same
    /// prose-satisfiability the branch already fixed twice; the repair belongs in ONE place
    /// that every predicate reads through.
    ///
    /// Quote-aware because a `#` inside a quoted argument is data, not a comment
    /// (`RUN python -c "import a  # noqa"`), and cutting there would silently shrink a
    /// legitimate smoke surface — the fail-CLOSED direction, but still wrong.
    ///
    /// **A comment ends at its own newline; QUOTE STATE does not.** Both halves are
    /// load-bearing and each was got wrong once:
    ///
    /// * R4 walked the whole logical line and `break`ed at the first `#`, discarding *the
    ///   entire rest of the script*. A BuildKit heredoc body IS one logical line with
    ///   embedded `\n`, so a marked heredoc with any comment above its loader (a `#!/bin/sh`
    ///   shebang included) stopped verifying and the guard failed a CORRECT recipe.
    /// * R5 then reset quote state per physical line, which fixed that but broke the
    ///   converse: a `#` that is DATA inside a quoted string spanning several lines — the
    ///   shape heredoc bodies are exactly where you find — got treated as a comment and the
    ///   rest of its line discarded. Also a false failure, just a narrower one.
    ///
    /// R6 does the only thing that is right in both directions: ONE walk that carries `sq`
    /// / `dq` across newlines, where a comment skips to the end of ITS line instead of
    /// ending the walk. Proved by a blind audit in both directions.
    ///
    /// Failing a correctly-written recipe is not the safe direction — it is the direction
    /// that gets a guard disabled, which this module warns about at `SMOKE_MARKER`.
    fn strip_trailing_comment(instruction: &str) -> String {
        let mut out = String::with_capacity(instruction.len());
        let (mut sq, mut dq) = (false, false);
        // Which `(` we are inside: `true` = a command substitution `$(`, whose closing `)`
        // is part of the surrounding WORD, so a `#` after it is data. `false` = a subshell
        // `(`, whose `)` ends a command, so a `#` after it opens a comment. Verified against
        // dash and bash: `echo $(echo A)#X` prints `A#X`, `(echo A)#X` prints `A`.
        let mut parens: Vec<bool> = Vec::new();
        let mut at_word_start = true; // a `#` at the very start opens a comment
        let mut prev = '\0';
        let mut chars = instruction.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' if !sq => {
                    // Present so an escaped quote cannot leave the walk "inside" a string,
                    // which would keep a real comment (the fail-OPEN direction). A blind
                    // audit brute-forced 804k inputs and showed the earlier `dq || !sq`
                    // GUARD was equivalent to `!sq` (the two flags are mutually exclusive by
                    // construction) — so it is the ARM that is load-bearing, not its guard.
                    out.push(c);
                    if let Some(n) = chars.next() {
                        at_word_start = n == '\n';
                        prev = n;
                        out.push(n);
                    }
                    continue;
                }
                '\'' if !dq => sq = !sq,
                '"' if !sq => dq = !dq,
                '(' if !sq && !dq => parens.push(prev == '$'),
                '#' if !sq && !dq && at_word_start => {
                    // Skip to the end of THIS line only — never past it.
                    for n in chars.by_ref() {
                        if n == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    at_word_start = true;
                    prev = '\n';
                    continue;
                }
                _ => {}
            }
            at_word_start = match c {
                // A `#` opens a comment only at the START OF A WORD. Enumerating only
                // whitespace was too narrow three times running — `;#`, `)#` and `` `# ``
                // are all real comments (checked against dash AND bash, not assumed), and
                // each walked the hardened predicates back through their own new fixtures.
                // See DEC-16: this set is a floor on the accidental cases, NOT a claim to
                // have enumerated every spelling a shell accepts.
                ')' => !parens.pop().unwrap_or(false),
                // `(` belongs here too. R6 dropped it while adding `)` and a blind
                // verifier proved the regression: `RUN (#jq) apt-get install -y curl`
                // stopped being stripped. A narrowing introduced while widening.
                '(' | ';' | '&' | '|' | '`' => true,
                _ => c.is_whitespace(),
            };
            prev = c;
            out.push(c);
        }
        out
    }

    /// TRIPWIRE ONLY — the recipe SOURCE mentions jq on something that looks like an
    /// instruction. **This does not hold the property, and must not be read as holding it.**
    ///
    /// The property — "every env image can run `jq`, so a converter wrapper can parse
    /// params.json" — is held BEHAVIOURALLY in the image-build path by
    /// `scripts/lib/env-image-verify.sh::cyto_verify_image_runs_jq`, which RUNS jq inside
    /// the built image before it is pushed, and is re-checked against the received
    /// artifact by `fetch-env-rootfs.sh`. Read that file for the tiering and the reason.
    ///
    /// ── WHY THIS IS ONLY A TRIPWIRE ────────────────────────────────────────────────
    /// It was `src.contains(" jq ")`, which a COMMENT satisfied — proved on the shipped
    /// recipe, whose three jq-mentioning comments kept the assertion TRUE with jq deleted
    /// from the apt line. The repair was then attempted three times as successively better
    /// source matching (strip comment lines; then `;#`; then `)#` and backtick-`#`). Every
    /// finding was real and every fix correct, which is exactly the problem: deciding
    /// whether a `#` opens a comment means tokenising the shell, so the evasion space is
    /// unbounded and a zero-finding audit round is unreachable by construction. That is the
    /// phase-7 ABORT signature, whose remedy is explicitly NOT another predicate.
    ///
    /// ── HOLES THIS TRIPWIRE KNOWINGLY HAS ─────────────────────────────────────────
    /// Named, rather than left for the next audit to rediscover:
    ///   * any comment spelling `strip_trailing_comment` does not yet model (its separator
    ///     set is a floor on the ACCIDENTAL case, not an enumeration of shell syntax);
    ///   * a mention that never executes — `RUN echo jq`, `RUN rm -rf /var/cache/jq`;
    ///   * `jq` named in an instruction that installs something else entirely;
    ///   * a recipe that installs jq and then removes it in a later layer.
    /// Every one of those is caught by the behavioural check, because none of them puts a
    /// runnable jq in the image.
    ///
    /// It is kept because it is ~free and it fails in the fast gate, seconds after a
    /// mistake, rather than minutes into an image build. That is its whole value.
    fn recipe_source_mentions_jq(src: &str) -> bool {
        let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.';
        src.lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .map(|l| strip_trailing_comment(l))
            .any(|l| {
                l.match_indices("jq").any(|(i, _)| {
                    let left = i == 0 || !l[..i].chars().next_back().is_some_and(is_word);
                    let right = !l[i + 2..].chars().next().is_some_and(is_word);
                    left && right
                })
            })
    }

    #[test]
    fn every_env_recipe_source_mentions_jq_tripwire() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let entries = std::fs::read_dir(&root)
            .unwrap_or_else(|e| panic!("env-rootfs must be readable at {}: {e}", root.display()));
        let mut checked = 0usize;
        for e in entries.flatten() {
            let dockerfile = e.path().join("Dockerfile");
            if !dockerfile.is_file() {
                continue;
            }
            let src = std::fs::read_to_string(&dockerfile)
                .unwrap_or_else(|err| panic!("read {}: {err}", dockerfile.display()));
            // `src.contains(" jq ")` USED TO BE THE WHOLE CHECK, and it was satisfiable by
            // PROSE. The R recipe's own comment reads "…jq lets a shell entry parse
            // params.json…", which contains ` jq `; a blind mutation deleted `jq` from the
            // apt line of BOTH recipes and this assertion stayed green — i.e. it asserted
            // that someone had written the word, not that the package ships.
            //
            // So the scan is over INSTRUCTIONS: Dockerfile comment lines are dropped
            // (docker strips them even mid-continuation), `\`-continuations are joined into
            // one logical line, and `jq` must appear as a standalone token on a logical line
            // that is an `apt-get install`. That is exactly where an installed package can
            // be, and nowhere a comment can reach.
            assert!(
                recipe_source_mentions_jq(&src),
                "{} does not mention jq on anything resembling an instruction.\n\
                 This is the TRIPWIRE, not the guarantee: the guarantee is that jq RUNS in \
                 the built image, held by scripts/lib/env-image-verify.sh in the publish \
                 path. Failing here means the recipe almost certainly forgot jq entirely — \
                 fix that rather than satisfying this string.",
                dockerfile.display()
            );
            checked += 1;
        }
        // A discovery walk that finds nothing would pass every assertion above in
        // silence; the floor is what makes this a test rather than a no-op.
        //
        // TEST-E3-12 [covers: ITEM-3] (#191): the floor is RE-MEASURED to the number of
        // recipes that now ship. It was `>= 1` when the tree held one recipe, which is
        // the shape that goes vacuous one recipe at a time: a walk that silently found
        // only the FIRST recipe would keep passing while the second went unchecked, and
        // "the R image forgot jq" is a failure that surfaces as a converter wrapper
        // reading an empty params.json deep inside a sandbox. Raising the floor with the
        // tree is the same discipline `check-derived-vocabulary.sh` applies to its own
        // anti-vacuity count.
        let discovered = crate::modules::rootfs::version::discover_env_recipes(&root).len();
        assert!(
            discovered >= 2,
            "expected the shipped tree to hold at least two env recipes, found {discovered} \
             under {} — if a recipe was deliberately removed, lower this floor in the same \
             commit and say why",
            root.display()
        );
        assert_eq!(
            checked, discovered,
            "the jq walk checked {checked} recipe(s) but {discovered} are discoverable — \
             the walk is missing one, and a recipe nobody checks is a recipe nobody guards"
        );
    }

    /// **TEST-E3-11** [acceptance] [invariant: INV-3] [covers: ITEM-12] (#191) — each of
    /// the REAL shipped env ids resolves to ITS OWN staged rootfs, and a job asking for an
    /// env that is not staged is REFUSED BY NAME rather than served the other one.
    ///
    /// ## Why this exists next to E1's tests rather than inside them
    ///
    /// E1 (#189) fixed the defect and proved the fix for SYNTHETIC ids (`env-a`/`env-b`).
    /// What it structurally could not prove is the case the whole epic exists for, because
    /// until this branch the recipe tree held exactly ONE recipe: that a job declaring the
    /// R env does not silently mount the python image. Before E1, `provide()` returned
    /// from the air-gap seam WITHOUT reading `env_id` at all, so every env id resolved to
    /// the same squashfs — and that failure does not degrade gracefully. It runs the job's
    /// code against the wrong interpreter and reports `Rscript: not found` from deep
    /// inside a sandbox, which reads as "R is broken" and sends the next reader to the
    /// image rather than to the resolver. So the CONSUMER-side proof belongs with the
    /// second env, and it is asserted here on the ids that actually ship.
    ///
    /// The ids are DISCOVERED off the recipe tree, never spelled. Naming them would put
    /// analysis-domain vocabulary into the app crate (INV-4 / R3-F2) and would also let
    /// this pass for a resolver that had been replaced by those very constants.
    #[test]
    fn each_shipped_env_id_resolves_to_its_own_staged_rootfs() {
        let recipe_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let ids = crate::modules::rootfs::version::discover_env_recipes(&recipe_root);
        assert!(
            ids.len() >= 2,
            "this assertion is about telling two envs apart and needs two recipes; found \
             {ids:?} under {}",
            recipe_root.display()
        );
        let (first, second) = (ids[0].clone(), ids[1].clone());
        assert_ne!(first, second);

        let _g = air_gap_env_guard();
        clear_seam_vars();

        let (hex_1, dir_1, tmp_1) = stage_a_distinct_env("shipped1");
        let (hex_2, dir_2, tmp_2) = stage_a_distinct_env("shipped2");
        assert_ne!(hex_1, hex_2, "the two staged rootfs must be distinguishable at all");

        // BOTH staged, each under its own env's seam key.
        std::env::set_var(format!("CYTO_ENV_ROOTFS_DIR{ENV_SEAM_SUFFIX}{first}"), &dir_1);
        std::env::set_var(format!("CYTO_ENV_ROOTFS_DIR{ENV_SEAM_SUFFIX}{second}"), &dir_2);

        let got_1 = OciEnvImageProvider::new()
            .provide(&first, Duration::from_secs(30))
            .unwrap_or_else(|e| panic!("env {first:?} must resolve its staged rootfs: {e}"));
        let got_2 = OciEnvImageProvider::new()
            .provide(&second, Duration::from_secs(30))
            .unwrap_or_else(|e| panic!("env {second:?} must resolve its staged rootfs: {e}"));
        assert_eq!(
            got_1.digest.as_deref(),
            Some(hex_1.as_str()),
            "env {first:?} was served a rootfs that is not the one staged for it"
        );
        assert_eq!(
            got_2.digest.as_deref(),
            Some(hex_2.as_str()),
            "env {second:?} was served a rootfs that is not the one staged for it — this \
             is the silent-substitution defect, and it presents as the ENVIRONMENT being \
             broken rather than as a resolver returning the wrong thing"
        );
        assert_ne!(got_1.rootfs_dir, got_2.rootfs_dir, "two envs, two rootfs dirs");

        // Now stage ONLY the first. Asking for the second must REFUSE, by name — never
        // fall through to the one that happens to be staged.
        clear_seam_vars();
        std::env::set_var(format!("CYTO_ENV_ROOTFS_DIR{ENV_SEAM_SUFFIX}{first}"), &dir_1);
        let err = OciEnvImageProvider::new()
            .provide(&second, Duration::from_secs(30))
            .expect_err("an env with no staged rootfs must be refused, never substituted");
        assert_eq!(err.error_code(), ENV_STAGED_MISMATCH_CODE);
        let msg = err.to_string();
        // PREFIX HAZARD — the reason these are not two `contains` calls.
        //
        // The shipped ids are `<x>` and `<x>-<suffix>`: one is a PREFIX of the other. So
        // `msg.contains(first)` is satisfied by the string `second` ALONE, and the
        // "names the staged env" half passes on a message that names only the requested
        // one. That is not hypothetical: a blind mutation deleted the staged env from
        // `env_mismatch`'s message entirely and every test in the crate stayed green.
        //
        // So the requested id is REMOVED from the message first, and the staged id must
        // survive that removal. Quoted forms are used because that is how the message
        // renders an id (`{served:?}`), which keeps this from matching a bare mention in
        // surrounding prose. Phrasing-agnostic: it does not pin the sentence, only that
        // both ids are independently present.
        let q_first = format!("{first:?}");
        let q_second = format!("{second:?}");
        assert!(
            msg.contains(&q_second),
            "the refusal must name the env that was REQUESTED: {msg}"
        );
        let without_requested = msg.replace(&q_second, "");
        assert!(
            without_requested.contains(&q_first),
            "the refusal must name the env that IS STAGED, independently of the requested \
             one — the operator cannot tell which of the two is wrong otherwise. (Checked \
             with the requested id removed, because it has the staged id as a prefix and a \
             plain `contains` would pass on the requested id alone.) message: {msg}"
        );

        // CONTROL: the same provider, same process, still serves the env that IS staged.
        // Without this, "the second env errored" is indistinguishable from "the whole
        // seam is broken", which would pass this test with the env scoping deleted.
        let still_ok = OciEnvImageProvider::new()
            .provide(&first, Duration::from_secs(30))
            .unwrap_or_else(|e| panic!("the staged env must still resolve: {e}"));
        assert_eq!(still_ok.digest.as_deref(), Some(hex_1.as_str()));

        clear_seam_vars();
        for d in [&dir_1, &dir_2, &tmp_1, &tmp_2] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// TEST-13 [ITEM-10]: the jq assertion is not satisfiable by PROSE.
    ///
    /// The permanent, non-vacuity fixture for the mutation above: a recipe whose ONLY
    /// mention of jq is in comments must FAIL, or the guard is decoration. Both shipped
    /// recipes really do carry such comments above their apt line, so this is the live
    /// shape, not an invented one.
    #[test]
    fn a_comment_mentioning_jq_does_not_satisfy_the_install_assertion() {
        // The real single-cell recipe's own prose, verbatim in shape, with the apt line
        // stripped — exactly what mutation M20 produced.
        let prose_only = "\
# needs bash + coreutils; curl/bzip2 bootstrap cellranger; jq lets a shell entry
# adds squidpy+spatialdata (DEC-A full spatial) + jq (so cellranger.sh parses
RUN apt-get install -y --no-install-recommends \\
        bash coreutils ca-certificates curl bzip2 binutils \\
";
        assert!(
            !recipe_source_mentions_jq(prose_only),
            "a recipe mentioning jq ONLY in comments must not satisfy the install \
             assertion — that is the fail-open this predicate replaced"
        );

        // The real install line still passes, in either package-manager spelling.
        assert!(recipe_source_mentions_jq(
            "RUN apt-get install -y bash coreutils bzip2 jq binutils"
        ));
        assert!(recipe_source_mentions_jq("RUN apk add --no-cache jq"));

        // Token-delimited: a longer package name does not satisfy the `jq` claim.
        // R4: `jq-dev` is the case a blind audit caught passing — `mentions_token` treats
        // `-` as a boundary (right for an import pin, wrong for a package name), so this
        // predicate uses its own boundary set and all four spellings are rejected.
        for not_jq in [
            "RUN apt-get install -y libjq-dev",
            "RUN apt-get install -y jq_static",
            "RUN apt-get install -y jq-dev",
            "RUN cp jq.orig /usr/bin/",
        ] {
            assert!(!recipe_source_mentions_jq(not_jq), "must not satisfy `jq`: {not_jq}");
        }

        // A TRAILING comment is prose too — whole-line stripping alone missed this.
        // Both comment spellings, because `;#` is a real comment and the `  #` fixture
        // alone only ever tested the evasion the fix was written against.
        for prose in [
            "RUN apt-get install -y curl  # jq comes from the base image",
            "RUN apt-get install -y curl;# jq comes from the base image",
        ] {
            assert!(
                !recipe_source_mentions_jq(prose),
                "a trailing comment mentioning jq must not satisfy the install assertion: {prose}"
            );
        }

        // A jq install inside a heredoc body still counts. NOTE this reaches the stripper
        // one PHYSICAL line at a time (`src.lines()` above), so it does not exercise the
        // multi-line path — an earlier version of this comment claimed it did, which a
        // blind audit called out as a vacuous assertion. It is kept for the shape, and the
        // multi-line path is exercised where it actually exists, in TEST-15.
        assert!(recipe_source_mentions_jq(
            "RUN <<'S'\n# set up tooling\napt-get install -y jq\nS"
        ));
        // The comment-spelling closures, on the predicate that reads real recipes.
        for prose in [
            "RUN (apt-get install -y curl)# jq comes from the base image",
            "RUN apt-get install -y curl `#jq comes from the base image`",
        ] {
            assert!(!recipe_source_mentions_jq(prose), "still prose: {prose}");
        }
        // ...and the DATA cases those closures must not eat.
        assert!(recipe_source_mentions_jq("RUN echo $(echo A)#x && apt-get install -y jq"));
    }

    // ─────────────── #196 / PROV-E8-3 — the pin ⇄ build-smoke correspondence ───────────────

    /// The pin file each recipe must ship. Mirrors `build_helper`'s `ENV_PIN_FILE`, which
    /// is the enforcing constant (`read_env_recipes` hard-errors on a `Dockerfile` with no
    /// readable one) but lives in the build-script crate and is not importable here — the
    /// same one-way duplication `processor_manifest.rs` already documents in the other
    /// direction for `ENV_RECIPE_FILE`. This is a FILE NAME, not a member of the set this
    /// guard ranges over; the recipes themselves are discovered, never named.
    const ENV_PIN_FILE: &str = "requirements.txt";

    /// The build gate's EXPORTED PARSE of every recipe's pin file (#214), and the command
    /// that rewrites it. Unlike `ENV_PIN_FILE` above these are not RETYPED mirrors — they
    /// are the gate's own `pub` constants, so they cannot drift. `ENV_PIN_FILE` stays a
    /// literal only because the gate keeps it private (it compiles into `build.rs`, which
    /// runs before the crate, so the dependency only goes one way).
    const ENV_PIN_ARTEFACT: &str = crate::processor_manifest_lint::ENV_PIN_ARTEFACT;
    const ENV_PIN_REGEN_CMD: &str = crate::processor_manifest_lint::ENV_PIN_REGEN_CMD;

    /// The comment a recipe puts on its own line, immediately above the instruction that
    /// LOADS every pinned distribution at build time.
    ///
    /// ── why a DECLARED marker and not a heuristic ───────────────────────────────────
    /// The first cut inferred the smoke surface: "`RUN` lines that mention ≥2 pinned
    /// imports and do not name the pin file". A blind audit broke it in three ways, and
    /// each break is the SAME shape — the heuristic enumerated the one recipe it had seen:
    ///
    ///   1. it assumed the installer names the pin file. A recipe installing inline
    ///      (`RUN pkgmgr install -y alpha beta gamma`) had its INSTALL line join the smoke
    ///      surface, so a recipe that loads NOTHING passed. Since the whole point is to
    ///      cover a recipe whose package manager this guard has never seen, that is the
    ///      §1 failure class inside the fix for the §1 failure class.
    ///   2. an incidental line could join and "verify" a pin it merely mentions — a
    ///      cleanup like `rm -rf /opt/venv/gamma-1.0.dist-info /var/cache/alpha` clears the
    ///      ≥2 threshold, and the surface is then searched as one blob.
    ///   3. nothing required the surface to EXECUTE anything: `RUN echo "numpy,scipy"`
    ///      passed where the python predecessor had required `python -c`.
    ///
    /// No syntactic rule separates "installs" from "loads" across package managers, so
    /// there is nothing to infer FROM. The repair is the one this design doc prescribes
    /// everywhere else: stop guessing and read a DECLARATION. The recipe states which
    /// instruction is its verification, exactly as each pin states its own import name.
    ///
    /// This does not make the guard unfoolable — someone can mark an `echo`. It makes that
    /// a deliberate line in a reviewed diff rather than an accident, which is the same
    /// standard `check-guard-integrity.sh` sets for itself: the property is not "cannot be
    /// weakened", it is "cannot be weakened SILENTLY".
    const SMOKE_MARKER: &str = "cyto:env-smoke";

    /// Is this comment line the smoke MARKER, rather than prose that merely mentions it?
    ///
    /// `contains` was wrong and dangerously so: a comment DOCUMENTING the marker attached
    /// it to whatever instruction happened to follow, silently widening the smoke surface —
    /// and the shipped recipe carries a prose block immediately above its marker, so one
    /// edit spelling the marker in that prose would have re-opened exactly the hole the
    /// declared marker was introduced to close.
    ///
    /// The rule is "the comment's body BEGINS with the marker", so `# cyto:env-smoke` and
    /// `# cyto:env-smoke (see the pin file)` mark, while "The `cyto:env-smoke` marker
    /// below…" does not.
    fn is_smoke_marker(comment_line: &str) -> bool {
        comment_line
            .trim_start_matches('#')
            .trim_start()
            .starts_with(SMOKE_MARKER)
    }

    /// The heredoc tag a Dockerfile instruction opens (`RUN <<'TAG'`, `RUN <<TAG`,
    /// `RUN <<-TAG`), if any — BuildKit's multi-line instruction form.
    ///
    /// Needed because a heredoc body carries no `RUN` and no `\`, so a line-oriented reader
    /// sees the opener alone and the whole script vanishes from the instruction. The second
    /// env recipe writes its build-time verification exactly this way, and a guard whose
    /// entire claim is "it covers a recipe it was never told about" may not be blind to the
    /// form that recipe actually uses.
    fn heredoc_opener(instruction: &str) -> Option<String> {
        let at = instruction.find("<<")?;
        let rest = &instruction[at + 2..];
        let rest = rest.strip_prefix('-').unwrap_or(rest);
        // A here-STRING (`<<<`) is not a heredoc.
        if rest.starts_with('<') {
            return None;
        }
        let quote = rest.starts_with('\'') || rest.starts_with('"');
        let rest = rest.trim_start_matches(['\'', '"']);
        let tag: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if tag.is_empty() {
            return None;
        }
        // Unquoted form must still look like a tag rather than a redirect target.
        if !quote && !tag.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
            return None;
        }
        Some(tag)
    }

    /// `true` when `hay` contains `needle` delimited on both sides by a non-identifier
    /// character — so a pinned import `zarr` is not satisfied by `zarr_read`, and
    /// `packaging` is not satisfied by a substring of another module name. `.` is a
    /// BOUNDARY, so a submodule mention (`scipy.sparse`) satisfies the pin `scipy`.
    fn mentions_token(hay: &str, needle: &str) -> bool {
        let bytes = hay.as_bytes();
        let n = needle.as_bytes();
        if n.is_empty() || n.len() > bytes.len() {
            return false;
        }
        let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
        for i in 0..=(bytes.len() - n.len()) {
            if &bytes[i..i + n.len()] != n {
                continue;
            }
            let left_ok = i == 0 || !is_word(bytes[i - 1]);
            let right_ok = i + n.len() == bytes.len() || !is_word(bytes[i + n.len()]);
            if left_ok && right_ok {
                return true;
            }
        }
        false
    }

    /// **PROV-E8-3** — EVERY discovered env recipe verifies EVERY distribution it pins,
    /// at build time, by that pin's own declared import name.
    ///
    /// ── what this replaces, and why it moved here ───────────────────────────────────
    /// This claim used to live in `packages/differential-expression/tests/test_rootfs_deps.py`
    /// against a HARDCODED `env-rootfs/single-cell`. That is the enumerate-instead-of-derive
    /// failure (`docs/design/derived-guards.md` §1): it is a WHOLE-TREE property asserted
    /// about one instance, so a second recipe's pins would be entirely unguarded on the day
    /// it landed — and it was asserted from inside one analysis package's test directory, so
    /// a claim about the environment was hostage to that package's lifecycle.
    ///
    /// It now iterates `rootfs::version::discover_env_recipes` — the single source of "which
    /// recipes exist", the same one `build_helper::sandbox_rootfs` selects from — beside
    /// `every_env_dockerfile_installs_jq`, which is the in-repo exemplar of this exact shape.
    /// A recipe contributed tomorrow is guarded with zero edits to this file.
    ///
    /// ── LANGUAGE-AGNOSTIC ON PURPOSE ────────────────────────────────────────────────
    /// The python recipe smoke-loads with `python -c "import a,b,c"`; an R recipe loads with
    /// `Rscript -e 'library(x)'`. Keying on either spelling would re-introduce the defect one
    /// level down — the guard would silently cover only the recipes whose interpreter it had
    /// been told about. So the key is each pin's OWN `# import=<module>` token (the grammar
    /// the build gate's `parse_env_pins` already enforces), matched against the recipe's
    /// `RUN` surface. No interpreter, no recipe and no env-id is named here.
    ///
    /// ── which instruction counts as the SMOKE surface ───────────────────────────────
    /// The one the RECIPE DECLARES, with a `cyto:env-smoke` comment on the line above it —
    /// see that constant for the three ways an inferred surface was broken by a blind audit,
    /// and why no syntactic rule can separate "installs" from "loads" across package
    /// managers this guard has never seen. Everything not so declared is out, including the
    /// install line and any incidental mention.
    ///
    /// ── why this is a PURE CORE over a root path, and not a walk of the real tree ───
    /// The exemplar next door reads `../env-rootfs` directly, and for a one-line
    /// `contains(" jq ")` claim that is fine. This claim is not: proving it DERIVES —
    /// i.e. that it covers a recipe it was never told about — needs a SECOND recipe, and a
    /// second recipe cannot be planted in the real tree even temporarily. The #80
    /// dependency gate is a cross-product over recipes (`build_helper::processor_manifest`:
    /// *"every `run.dependencies[]` a package declares must be satisfied by EVERY env
    /// recipe's pin set"*), so `build.rs` fails before any test runs — verified by trying
    /// it: `analysis 'anndata.import' declares the library 'anndata', which the env recipe
    /// 'zz-synthetic' does NOT install`.
    ///
    /// So the check is a function of a root, and two callers exercise it: one over the real
    /// tree (the guard), and fixture cases over synthetic roots (the mutation proofs). A
    /// guard whose failure mode cannot be demonstrated is a guard nobody has checked.
    ///
    /// Returns the number of recipes verified, or the first failure's diagnosis.
    fn verify_recipe_pin_smoke_correspondence(
        env_root: &std::path::Path,
    ) -> Result<usize, String> {
        let recipes = crate::modules::rootfs::version::discover_env_recipes(env_root);

        // ANTI-VACUITY, outer ring: a collapsed discovery walk would satisfy every check
        // below by never entering the loop.
        if recipes.is_empty() {
            return Err(format!(
                "no env recipe discovered under {} — the discovery walk collapsed, and this \
                 guard was about to verify nothing while passing",
                env_root.display()
            ));
        }

        // THE EXPORTED PARSE, read once for the whole tree (#214). AFTER the emptiness
        // check above, deliberately: an empty tree has no artefact either, and "the
        // discovery walk collapsed" is the diagnosis, while "the artefact is missing" is
        // the symptom. A guard that reports the symptom sends the reader to regenerate
        // something that cannot be generated.
        let artefact = crate::processor_manifest_lint::read_env_pin_artefact(env_root)?;

        for id in &recipes {
            let dir = env_root.join(id);
            let dockerfile = dir.join(crate::modules::rootfs::version::ENV_RECIPE_FILE);
            let pin_path = dir.join(ENV_PIN_FILE);

            // ── THE PIN SET COMES FROM THE GATE'S EXPORTED PARSE (#214 / INV-1) ──
            //
            // This block used to be a PARSER. It had its own `pins_src.lines()`, its own
            // `split_once('#')` comment rule, its own `split_once("==")` token rule, its own
            // distribution character set (deliberately STRICTER than the gate's, which is
            // itself the tell), and its own word-anchored `import=` scan — 132 lines whose
            // comment claimed to "MIRROR `build_helper::processor_manifest::parse_env_pins`,
            // character set and all". A comment is not a mirror. It was the FIFTH of ten
            // programs parsing one text file, and the pairs that can disagree grow
            // quadratically in that number.
            //
            // It now reads DATA. There is no line rule, no comment rule and no token rule
            // left here, so there is nothing for this guard and the build gate to disagree
            // about — see `docs/design/pin-file-single-parse.md` §2. The `import=` grammar
            // and its word-anchoring fix did not disappear; they MOVED into the gate's
            // parser (`processor_manifest::import_token`), which is where they should have
            // been all along, because this guard existing at all was the consequence of
            // that grammar living only here.
            //
            // The freshness of what is read is not this guard's problem to solve twice:
            // `build.rs` re-derives the artefact and byte-compares on every `cargo check`,
            // and a `cargo test` runs `build.rs` first. The digest check below is
            // nevertheless kept, because a guard that assumes its input is fresh because
            // some other stage should have checked is exactly the transitive-precondition
            // shape round 4 found and rejected.
            let recipe_data = artefact
                .get(&id)
                .ok_or_else(|| format!(
                    "recipe `{id}` is not described by the exported pin parse \
                     ({ENV_PIN_ARTEFACT}). A recipe the artefact does not know about would \
                     be verified against nothing, so this is a refusal and not a skip. Run \
                     `{ENV_PIN_REGEN_CMD}`."
                ))?;

            // THE FRESHNESS DIGEST is done by `read_env_pin_artefact` for every recipe,
            // once, above — moved there by #214 after a blind audit found two consumers on
            // this branch reasoning oppositely about whether they needed one. Putting it in
            // the READER means no consumer can be the one that forgot, which is the same
            // argument that moved the canonical-bytes precondition out of a caller.
            //
            // A digest is not a parse: no line rule, no comment rule, no token rule, and so
            // nothing in it for two readers to disagree about. Hash them; never split them.

            let pins: Vec<(String, String)> = recipe_data
                .pins
                .iter()
                .map(|p| (p.raw_name.clone(), p.import.clone()))
                .collect();

            // ANTI-VACUITY, inner ring: a recipe whose pin set is empty would pass the
            // per-pin loop below without checking anything. The generator already refuses
            // this, so reaching it means the artefact was hand-edited — say so rather than
            // passing.
            if pins.is_empty() {
                return Err(format!(
                    "recipe `{id}` has ZERO pins in the exported parse. The generator \
                     refuses an empty pin set, so this artefact was edited by hand — which \
                     is the one way this guard could be made vacuous without touching the \
                     recipe. Run `{ENV_PIN_REGEN_CMD}`."
                ));
            }

            let recipe_src = std::fs::read_to_string(&dockerfile)
                .map_err(|e| format!("read {}: {e}", dockerfile.display()))?;

            // LOGICAL lines, not physical ones: a `\`-continued `RUN` is ONE instruction,
            // and only its first physical line starts with `RUN`. Scanning physically
            // would miss every load written across a continuation — over-reporting rather
            // than under-, but a guard that fails a correctly-written recipe teaches
            // people to route around it. The python recipe on disk happens to put its
            // load on one line; a recipe that wraps must not be punished for it.
            //
            // `marked` carries whether the PRECEDING comment line was the smoke marker, so
            // the marker survives the join and can be attached to the instruction it
            // introduces.
            let mut logical: Vec<(bool, String)> = Vec::new();
            let mut buf = String::new();
            let mut pending_marker = false;
            let mut marker_for_buf = false;
            let mut heredoc: Option<String> = None;
            for line in recipe_src.lines() {
                // Inside a BuildKit heredoc the body is part of the SAME instruction, and
                // its lines are arbitrary script — no `RUN`, no `\`. It ends at its own
                // terminator. A nested heredoc's terminator cannot match the outer tag, so
                // single-level tracking absorbs the nesting correctly.
                if let Some(tag) = heredoc.clone() {
                    buf.push('\n');
                    buf.push_str(line);
                    if line.trim() == tag {
                        heredoc = None;
                        logical.push((marker_for_buf, std::mem::take(&mut buf)));
                        marker_for_buf = false;
                    }
                    continue;
                }
                let trimmed = line.trim();
                // A COMMENT is never part of an instruction — Docker strips comment lines
                // wherever they appear, INCLUDING inside a `\` continuation. Gating this on
                // `buf.is_empty()` (what it did) meant a comment inside a continuation was
                // appended as if it were code and, not ending in `\`, TERMINATED the
                // instruction — splitting one legal `RUN` in two and failing a correct
                // recipe. That is the outcome the continuation comment above says must not
                // happen.
                if trimmed.starts_with('#') {
                    if buf.is_empty() && is_smoke_marker(trimmed) {
                        pending_marker = true;
                    }
                    continue;
                }
                // A BLANK line likewise. Consuming `pending_marker` here made a marker
                // separated from its instruction by an empty line vanish, and the guard
                // then reported "DECLARES no build-time smoke surface" about a recipe whose
                // marker is right there — fail-closed, but the diagnosis told the reader to
                // add what already existed.
                if trimmed.is_empty() {
                    continue;
                }
                if buf.is_empty() {
                    marker_for_buf = pending_marker;
                    pending_marker = false;
                }
                let cont = line.trim_end().ends_with('\\');
                buf.push_str(if cont {
                    line.trim_end().trim_end_matches('\\')
                } else {
                    line
                });
                if !cont {
                    if let Some(tag) = heredoc_opener(&buf) {
                        heredoc = Some(tag);
                        continue;
                    }
                    logical.push((marker_for_buf, std::mem::take(&mut buf)));
                    marker_for_buf = false;
                }
            }
            if !buf.is_empty() {
                logical.push((marker_for_buf, buf));
            }

            let smoke: String = logical
                .iter()
                .filter(|(marked, _)| *marked)
                .map(|(_, l)| l.clone())
                .collect::<Vec<_>>()
                .join("\n");

            if smoke.trim().is_empty() {
                return Err(format!(
                    "recipe `{id}` DECLARES no build-time smoke surface: no instruction in \
                     {} is preceded by a `{SMOKE_MARKER}` comment line.\n\
                     Put that marker on its own line immediately above the instruction that \
                     LOADS every pinned distribution, e.g.\n\
                     \x20   {SMOKE_MARKER}\n\
                     \x20   RUN <interpreter> <load every `# import=` module>\n\
                     An install the recipe never loads is an install that silently ships \
                     absent — which is the whole property this guard exists to hold.",
                    dockerfile.display()
                ));
            }

            // TWO legitimate shapes, and refusing either would be the enumeration this
            // guard exists to retire:
            //
            //   SPELLED  — the marked instruction names every import token
            //              (`python -c "import a,b,c"`, `Rscript -e "library(a); …"`).
            //              Checked per pin, on token boundaries.
            //   DERIVED  — the marked instruction READS the pin file and loads whatever it
            //              finds. Then the correspondence holds BY CONSTRUCTION and there
            //              is nothing to spell: demanding the names anyway would force a
            //              recipe that cannot drift to hand-maintain a list that can. That
            //              is precisely backwards, and it is the shape the second recipe
            //              uses (an in-heredoc script that parses the pin file, loads each
            //              library and compares versions).
            //
            // The install line cannot reach this branch by referencing the pin file,
            // because only the DECLARED instruction is the smoke surface at all.
            //
            // R4: this was `smoke.contains(ENV_PIN_FILE)` over the RAW marked text, and a
            // blind audit evaded it three ways — a trailing COMMENT naming the pin file
            // (`RUN true  # loads everything in requirements.txt`), a non-executing
            // instruction (`COPY requirements.txt /x`), and either of those anywhere among
            // several marked instructions, since `smoke` is their join. Any one of them
            // exempted the WHOLE recipe from every per-pin check. The exemption now demands
            // what its own rationale claims: an instruction that RUNS, naming the pin file
            // in code rather than in prose.
            //
            // Requiring `RUN` is not the enumeration this guard retires: `RUN` is Dockerfile
            // GRAMMAR, which this reader already parses (continuations, heredocs), not a
            // language ecosystem. Naming `python`/`Rscript` would be the enumeration.
            let derives_from_pin_file = logical
                .iter()
                .filter(|(marked, _)| *marked)
                .map(|(_, l)| strip_trailing_comment(l))
                .any(|l| {
                    // The KEYWORD, not a 3-char prefix: `RUNNER /tmp/requirements.txt`
                    // must not claim the derived shape. Dockerfile keywords are
                    // case-insensitive, so `run` counts.
                    l.split_whitespace()
                        .next()
                        .is_some_and(|k| k.eq_ignore_ascii_case("RUN"))
                        && l.contains(ENV_PIN_FILE)
                });
            if derives_from_pin_file {
                continue;
            }
            // Per-pin matching likewise reads CODE, not the comments beside it.
            let smoke = logical
                .iter()
                .filter(|(marked, _)| *marked)
                .map(|(_, l)| strip_trailing_comment(l))
                .collect::<Vec<_>>()
                .join("\n");
            for (dist, module) in &pins {
                if !mentions_token(&smoke, module) {
                    return Err(format!(
                        "recipe `{id}`: `{dist}` is pinned in {ENV_PIN_FILE} but its import \
                         `{module}` is NOT loaded by the recipe's build-time smoke surface \
                         — an install the smoke line does not verify silently ships \
                         absent.\nEither add `{module}` to the declared load instruction in \
                         {}, or make that instruction derive its list from {ENV_PIN_FILE} \
                         (which cannot drift, and is checked as covering by construction).",
                        dockerfile.display()
                    ));
                }
            }
        }
        Ok(recipes.len())
    }

    /// A throwaway `env-rootfs`-shaped directory. Recipes are written by the CASE, never by
    /// this helper — a fixture that knows the recipe names would be the enumeration this
    /// guard exists to retire, one level down in the test.
    struct TmpEnvRoot(std::path::PathBuf);

    impl TmpEnvRoot {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let p = std::env::temp_dir()
                .join(format!("cyto-envroot-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).expect("create fixture env root");
            Self(p)
        }
        fn recipe(&self, id: &str, dockerfile: &str, pins: &str) -> &Self {
            let d = self.0.join(id);
            std::fs::create_dir_all(&d).expect("mkdir recipe");
            std::fs::write(d.join("Dockerfile"), dockerfile).expect("write Dockerfile");
            // Every recipe DECLARES its packaging ecosystem and where its pins were
            // resolved (#192, no defaults anywhere). These fixtures predate both directives
            // and their subject is the SMOKE CORRESPONDENCE, not the directive grammar —
            // which has its own tests in the gate. Supplying the declarations here keeps
            // ~20 pin literals focused on what they are actually about; a fixture that
            // wants to exercise a MISSING declaration spells one out and this leaves it
            // alone.
            let pins = if pins.contains("cyto:ecosystem") {
                pins.to_string()
            } else {
                format!(
                    "# cyto:ecosystem=python\n\
                     # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
                     {pins}"
                )
            };
            std::fs::write(d.join(ENV_PIN_FILE), pins).expect("write pins");
            self
        }

        /// Generate this fixture tree's exported parse, exactly as `build.rs` does for the
        /// real tree — the SAME function, not a test-only stand-in.
        ///
        /// Returns the generator's refusal rather than panicking, because "the generator
        /// refuses this tree" is itself a property under test: a pin file the parser will
        /// not read produces NO artefact, so no consumer can be handed a parse that
        /// disagrees with the gate's. That is INV-2 stated as a mechanism.
        fn generate(&self) -> Result<(), String> {
            let json = crate::processor_manifest_lint::generate_env_pin_artefact(&self.0)?;
            std::fs::write(self.0.join(ENV_PIN_ARTEFACT), json)
                .map_err(|e| format!("write artefact: {e}"))
        }

        fn path(&self) -> &std::path::Path {
            // Best effort ON PURPOSE. A fixture the generator refuses gets no artefact, and
            // the consumer must then REFUSE rather than silently verify nothing — which is
            // the case `a_consumer_with_no_exported_parse_refuses_rather_than_skipping`
            // pins down.
            let _ = self.generate();
            &self.0
        }
    }

    impl Drop for TmpEnvRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A well-formed recipe in a language this repo does not use, so the case cannot pass
    /// by accidentally matching the python idiom.
    const OK_RECIPE: &str = "FROM scratch\n\
         RUN pkgmgr install -y jq curl\n\
         COPY requirements.txt /tmp/requirements.txt\n\
         RUN installer --from /tmp/requirements.txt\n\
         # cyto:env-smoke\n\
         RUN loader -e 'load(alpha); load(beta); load(gamma)'\n";
    const OK_PINS: &str = "# a comment line\n\
         alpha==1.0  # import=alpha\n\
         beta==2.0  # import=beta\n\
         gamma==3.0  # import=gamma\n";

    /// **TEST-P10** (#214) — this guard has STOPPED PARSING, proved behaviourally.
    ///
    /// ## Why "it now calls the reader" is not evidence
    ///
    /// Round 4 of #192 found a parser here whose own comment said it "MIRROR[s]
    /// `build_helper::processor_manifest::parse_env_pins`, character set and all". It did
    /// not. A comment cannot be checked, and neither can "I deleted the loop" — a residual
    /// read could sit anywhere in 300 lines.
    ///
    /// So this asks the guard a question only a data-consumer can answer correctly:
    ///
    /// > Generate the artefact from pin file **A**. Mutate the ARTEFACT's pin data —
    /// > rename a module — and re-record `sha256(A)` so the freshness check still passes.
    /// > Leave **A** untouched on disk. Now run the guard.
    /// >
    /// > A consumer of the artefact follows the MUTATED data and complains about the new
    /// > module. A residual parser follows **A** and passes.
    ///
    /// There is no way to pass this while still parsing, and no way to fail it while not
    /// parsing. It is the executable form of "grep for the residual read".
    #[test]
    fn the_smoke_guard_reads_the_exported_parse_and_not_the_pin_file() {
        let root = TmpEnvRoot::new("residual-read");
        root.recipe("envx", OK_RECIPE, OK_PINS);

        // CONTROL: as generated, the guard passes. Without this the mutation below could be
        // "failed for an unrelated reason".
        root.generate().expect("fixture generates");
        verify_recipe_pin_smoke_correspondence(&root.0)
            .expect("the unmutated fixture must pass");

        // Mutate the ARTEFACT only. `OK_RECIPE`'s smoke line loads alpha, beta and gamma;
        // the artefact now claims gamma's module is `zeta`, which the recipe does not load.
        let path = root.0.join(ENV_PIN_ARTEFACT);
        let mutated = std::fs::read_to_string(&path)
            .expect("read artefact")
            .replace("\"import\": \"gamma\"", "\"import\": \"zeta\"");
        assert!(mutated.contains("zeta"), "the mutation must have applied");
        std::fs::write(&path, &mutated).expect("write mutated artefact");

        // The pin file is BYTE-IDENTICAL to what was hashed, so the freshness check passes
        // and the only thing that changed is the data.
        let err = verify_recipe_pin_smoke_correspondence(&root.0).expect_err(
            "the guard followed the PIN FILE, not the exported parse — a residual read \
             survives somewhere in this function, which is exactly the defect #214 removes",
        );
        assert!(
            err.contains("zeta"),
            "the guard must complain about the module the ARTEFACT names ({err})"
        );
    }

    /// Lifecycle id: **TEST-10** (see `.lifecycle/derived-env-vocabulary/TESTS.md`).
    /// The guard proper: the REAL recipe tree satisfies the correspondence.
    #[test]
    fn every_env_recipe_smoke_verifies_every_pinned_import() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let checked = verify_recipe_pin_smoke_correspondence(&root)
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(
            checked >= 1,
            "no env recipe verified under {} — the walk collapsed",
            root.display()
        );
    }

    /// TEST-10, mutation 1 — **the derivation covers a recipe it was never told about.**
    /// This is the whole point: the predecessor hardcoded one recipe name, so a second
    /// recipe's pins were unguarded on the day it landed. Two recipes, neither named in
    /// this guard's source; the SECOND one's broken correspondence must be what fails.
    #[test]
    fn a_recipe_this_guard_was_never_told_about_is_still_checked() {
        let root = TmpEnvRoot::new("newrecipe");
        root.recipe("aaa-first", OK_RECIPE, OK_PINS);
        root.recipe(
            "zzz-second",
            "FROM scratch\n# cyto:env-smoke\nRUN loader -e 'load(alpha); load(beta)'\n",
            "alpha==1.0  # import=alpha\nbeta==2.0  # import=beta\ndelta==4.0  # import=delta\n",
        );
        let err = verify_recipe_pin_smoke_correspondence(root.path())
            .expect_err("the second recipe's unloaded pin must FAIL");
        assert!(err.contains("zzz-second"), "names the recipe: {err}");
        assert!(err.contains("delta"), "names the pin: {err}");
        // …and the well-formed sibling alone passes, so the failure above is the mutation
        // and not a fixture that cannot pass at all.
        let ok = TmpEnvRoot::new("newrecipe-control");
        ok.recipe("aaa-first", OK_RECIPE, OK_PINS);
        assert_eq!(
            verify_recipe_pin_smoke_correspondence(ok.path()),
            Ok(1),
            "the control fixture must pass"
        );
    }

    /// TEST-10, mutation 2 — a collapsed walk FAILS instead of passing vacuously
    /// (INV-3 / ITEM-8, the `checked >= 1` floor of the exemplar next door).
    /// **TEST-15** (#192, fix round 4) — this guard is a FIFTH parser of the pin file, and
    /// it must sit BEHIND the canonical-bytes precondition, not merely mirror the build
    /// gate in a comment.
    ///
    /// It has its own line splitting (LF-only `lines()`), its own comment rule and its own
    /// character sets. Before round 4 it was covered only transitively — `cargo test`
    /// builds the crate, which runs `build.rs`, which runs the dependency gate — and that
    /// chain had a hole at both ends: the gate returned early without checking anything
    /// when no package declared a dependency, and nothing structural tied this reader to
    /// it. A precondition that only some readers sit behind is a sixth opinion.
    ///
    /// The byte here is a lone CR, which is exactly the divergence class: `lines()` splits
    /// only on LF while the recipe's own R installer's `readLines` also splits on CR, so
    /// one physical line is one pin to this guard and two to the thing that installs.
    #[test]
    fn a_non_canonical_pin_file_is_refused_by_this_guard_too() {
        let root = TmpEnvRoot::new("noncanon");
        root.recipe(
            "envx",
            OK_RECIPE,
            "alpha==1.0  # import=alpha\rbeta==2.0  # import=beta\ngamma==3.0  # import=gamma\n",
        );
        // The refusal now happens ONE STEP EARLIER, and that step is the point (#214).
        //
        // This guard no longer has a grammar, so it cannot refuse a byte — the PARSER does,
        // when the exported parse is generated. A pin file the parser will not read
        // produces NO artefact at all, so there is nothing for this guard to be handed and
        // nothing it could disagree with the gate about. INV-2 as a mechanism rather than
        // as an agreement: the divergence is unrepresentable, not merely refused.
        let err = root
            .generate()
            .expect_err("a pin file with a lone CR must be refused, not parsed");
        assert!(
            err.contains("U+000D") && err.contains("envx"),
            "the refusal must come from the canonical-bytes precondition and name the \
             recipe: {err}"
        );

        // …and the CONSUMER refuses rather than skipping, which is the other half. A
        // consumer that treated a missing artefact as "no pins to check" would be the
        // vacuous green this whole design is about.
        let downstream = verify_recipe_pin_smoke_correspondence(&root.0)
            .expect_err("with no exported parse the consumer must REFUSE, never skip");
        assert!(
            downstream.contains(ENV_PIN_ARTEFACT),
            "the consumer's refusal must name the artefact it could not read: {downstream}"
        );

        // CONTROL: the same recipe with the CR replaced by a newline passes, so the case
        // above fails for the byte and not for the fixture.
        let ok = TmpEnvRoot::new("noncanon-ok");
        ok.recipe("envx", OK_RECIPE, OK_PINS);
        ok.path();
        verify_recipe_pin_smoke_correspondence(ok.path())
            .expect("the canonical fixture must still pass");
    }

    #[test]
    fn a_collapsed_recipe_walk_fails_instead_of_verifying_nothing() {
        let root = TmpEnvRoot::new("collapsed");
        let err = verify_recipe_pin_smoke_correspondence(root.path())
            .expect_err("an empty recipe tree must FAIL, not pass having checked nothing");
        assert!(err.contains("discovery walk collapsed"), "{err}");
    }

    /// TEST-10, mutation 3 — a recipe whose pin file parses to nothing FAILS. Without this
    /// inner floor, emptying a pin file would silently retire that recipe's coverage while
    /// the outer walk still reported a recipe checked.
    #[test]
    fn a_recipe_with_no_parsed_pins_fails_instead_of_being_skipped() {
        let root = TmpEnvRoot::new("nopins");
        root.recipe("only", OK_RECIPE, "# every line is a comment\n\n");
        // Same move as the canonicality case: the floor is now enforced by the PARSER, at
        // generation, so a recipe that parses to nothing never becomes an artefact.
        let err = root
            .generate()
            .expect_err("a recipe with zero parsed pins must FAIL");
        assert!(err.contains("ZERO pins"), "{err}");

        // The consumer keeps its own inner floor anyway. It is unreachable from the
        // generator's output today, and that is exactly why it is worth keeping: it is what
        // stands between a HAND-EDITED artefact and a guard that checks nothing while
        // reporting a recipe verified.
        let downstream = verify_recipe_pin_smoke_correspondence(&root.0)
            .expect_err("with no exported parse the consumer must REFUSE, never skip");
        assert!(downstream.contains(ENV_PIN_ARTEFACT), "{downstream}");
    }

    /// TEST-10, mutation 4 — the INSTALL is not evidence of a LOAD. A recipe that installs
    /// and never loads must FAIL: installing is structural, loading is the evidence, and
    /// conflating them is exactly the hole the python predecessor's `_smoke_line()` avoided.
    ///
    /// Both install spellings are covered, because the first cut only handled the first and
    /// a blind audit broke it with the second:
    ///   (a) installing FROM the pin file by name;
    ///   (b) installing the distributions INLINE — the case a recipe using a package
    ///       manager this guard has never seen will take. Under the old heuristic that
    ///       inline line joined the smoke surface and "covered" every pin, so a recipe that
    ///       loads NOTHING passed. That is the §1 failure class inside the fix for it.
    #[test]
    fn installing_is_not_evidence_of_loading_in_either_spelling() {
        for (tag, dockerfile) in [
            (
                "from-pin-file",
                "FROM scratch\nCOPY requirements.txt /tmp/requirements.txt\n\
                 RUN installer --from /tmp/requirements.txt\n",
            ),
            (
                "inline",
                "FROM scratch\nRUN pkgmgr install -y alpha beta gamma\n",
            ),
        ] {
            let root = TmpEnvRoot::new(tag);
            root.recipe("only", dockerfile, OK_PINS);
            let res = verify_recipe_pin_smoke_correspondence(root.path());
            let err = res.expect_err(&format!(
                "[{tag}] a recipe that installs and never LOADS must FAIL — installing is \
                 structural, loading is the evidence"
            ));
            assert!(
                err.contains("DECLARES no build-time smoke surface"),
                "[{tag}] {err}"
            );
        }
    }

    /// TEST-10, mutation 7 — an INCIDENTAL mention does not verify a pin.
    ///
    /// Under the inferred smoke surface, any `RUN` line naming two pinned modules joined it,
    /// and the surface was then searched as one blob — so a cleanup line
    /// (`rm -rf …/gamma-1.0.dist-info /var/cache/alpha`) "verified" `gamma`, which is never
    /// loaded. The python predecessor could not be fooled this way: it matched exact
    /// membership in the actual import list. Restoring that strength is why the surface is
    /// now the DECLARED instruction rather than every line that looks like one.
    #[test]
    fn an_incidental_mention_on_an_unmarked_line_does_not_verify_a_pin() {
        let root = TmpEnvRoot::new("incidental");
        root.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN loader -e 'load(alpha); load(beta)'\n\
             RUN rm -rf /opt/venv/gamma-1.0.dist-info /var/cache/alpha\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(root.path())
            .expect_err("`gamma` appears only in an rm path — it is not loaded");
        assert!(err.contains("gamma"), "{err}");
    }

    /// TEST-14 [ITEM-11]: the DERIVED-smoke exemption reads CODE, not the prose beside it.
    ///
    /// A blind audit evaded `smoke.contains(ENV_PIN_FILE)` three ways, each exempting the
    /// WHOLE recipe from every per-pin check. All three are pinned here so the exemption
    /// cannot silently widen back.
    #[test]
    fn the_derived_smoke_exemption_is_not_satisfied_by_prose_or_by_a_non_running_instruction() {
        // (a) a trailing COMMENT naming the pin file is not a derivation.
        let a = TmpEnvRoot::new("derived-comment");
        a.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN true  # loads everything in requirements.txt\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(a.path())
            .expect_err("a comment naming the pin file must not claim the DERIVED shape");
        assert!(err.contains("alpha"), "{err}");

        // (b) an instruction that does not RUN cannot be a build-time smoke.
        let b = TmpEnvRoot::new("derived-copy");
        b.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             COPY requirements.txt /x\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(b.path())
            .expect_err("COPY executes nothing — it cannot verify a pin");
        assert!(err.contains("alpha"), "{err}");

        // (c) one exempting instruction among several must not exempt the others.
        let c = TmpEnvRoot::new("derived-join");
        c.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN echo hello  # see requirements.txt\n\
             # cyto:env-smoke\n\
             RUN loader -e 'load(alpha)'\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(c.path())
            .expect_err("a commented mention in one marked line must not cover the rest");
        assert!(err.contains("beta"), "{err}");

        // (d) R5 — per-INSTRUCTION, not over the join. Distinguishing input: a marked
        // instruction that RUNs but does not name the pin file, PLUS a marked instruction
        // that names it but does not run. A join-based implementation passes (a)-(c) and
        // still exempts here; only the per-instruction rule refuses.
        let dd = TmpEnvRoot::new("derived-split");
        dd.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN echo hi\n\
             # cyto:env-smoke\n\
             COPY requirements.txt /x\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(dd.path())
            .expect_err("no single marked instruction both RUNs and reads the pin file");
        assert!(err.contains("alpha"), "{err}");

        // (e2) R6 — the other two comment spellings, END-TO-END through the exemption.
        // A blind audit proved both returned Ok(()) — i.e. exempted the whole recipe.
        for spelling in ["RUN (true)# loads everything in requirements.txt",
                         "RUN true `#loads everything in requirements.txt`"] {
            let t = TmpEnvRoot::new("derived-spelling");
            t.recipe("only", &format!("FROM scratch\n# cyto:env-smoke\n{spelling}\n"), OK_PINS);
            let err = verify_recipe_pin_smoke_correspondence(t.path())
                .unwrap_err();
            assert!(err.contains("alpha"), "{spelling} still exempts: {err}");
        }

        // (e) R6 — `RUN` is the KEYWORD, not a three-character prefix. `RUNNER` was
        // claiming the derived exemption; the change that fixed it had no test.
        let e = TmpEnvRoot::new("derived-runner");
        e.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUNNER /tmp/requirements.txt\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(e.path())
            .expect_err("`RUNNER` is not `RUN` — it must not claim the derived exemption");
        assert!(err.contains("alpha"), "{err}");

        // The genuine derived shape still passes — the exemption is narrowed, not removed.
        let ok = TmpEnvRoot::new("derived-real");
        ok.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN loader --load-each requirements.txt\n",
            OK_PINS,
        );
        assert_eq!(verify_recipe_pin_smoke_correspondence(ok.path()), Ok(1));

        // R5 — and so does the shape the exemption actually EXISTS for: an in-heredoc
        // script that parses the pin file, WITH comments in its body. The first spelling of
        // `strip_trailing_comment` failed this correct recipe, which is the regression the
        // audit caught. E3's R recipe is one reordering away from this shape.
        let heredoc = TmpEnvRoot::new("derived-heredoc");
        heredoc.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN <<'S'\n\
             #!/bin/sh\n\
             set -eux\n\
             # load every pinned import, derived from the pin file itself\n\
             for m in $(parse requirements.txt); do loader -e \"load($m)\"; done\n\
             S\n",
            OK_PINS,
        );
        assert_eq!(
            verify_recipe_pin_smoke_correspondence(heredoc.path()),
            Ok(1),
            "a commented heredoc that DERIVES its list from the pin file must still be \
             covered by construction"
        );
    }

    /// TEST-15 [ITEM-11]: `strip_trailing_comment` cuts prose without eating quoted data.
    #[test]
    fn a_trailing_comment_is_cut_but_a_quoted_hash_is_data() {
        assert_eq!(strip_trailing_comment("RUN true  # note").trim(), "RUN true");
        assert_eq!(strip_trailing_comment("#!/bin/sh").trim(), "");
        // A `#` inside quotes is an argument, not a comment — cutting it would silently
        // shrink a legitimate smoke surface.
        assert_eq!(
            strip_trailing_comment("RUN python -c \"import a  # noqa\"").trim(),
            "RUN python -c \"import a  # noqa\""
        );
        assert_eq!(
            strip_trailing_comment("RUN sh -c 'echo #1' # real").trim(),
            "RUN sh -c 'echo #1'"
        );
        // A `#` not preceded by whitespace is part of the token (a URL fragment).
        assert_eq!(
            strip_trailing_comment("RUN get http://x/y#frag").trim(),
            "RUN get http://x/y#frag"
        );

        // R5 — a LOGICAL line can span physical lines (a heredoc body). A comment ends at
        // its own newline and must NOT swallow the rest of the script. This is the
        // regression a blind tests-quality audit proved: the first spelling of this
        // function walked the whole string and `break`ed, erasing everything below the
        // first comment, so a correct heredoc recipe FAILED.
        assert_eq!(
            strip_trailing_comment("RUN <<'S'\n# load every pinned import\nloader -e 'load(alpha)'\nS"),
            "RUN <<'S'\n\nloader -e 'load(alpha)'\nS"
        );
        // A shebang is a comment too — and must cost only its own line.
        assert_eq!(
            strip_trailing_comment("RUN <<'S'\n#!/bin/sh\nloader -e 'load(beta)'\nS"),
            "RUN <<'S'\n\nloader -e 'load(beta)'\nS"
        );

        // R5 — `;#` is a real shell comment (`sh -c 'echo A;#B'` prints `A`). Requiring
        // literal whitespace let the audit walk both hardened predicates back through
        // their own new fixtures with one character changed.
        assert_eq!(strip_trailing_comment("RUN true;# note").trim(), "RUN true;");
        assert_eq!(strip_trailing_comment("RUN a && b|# note").trim(), "RUN a && b|");

        // R5 — the backslash ARM (not its guard) is load-bearing in the fail-OPEN
        // direction: delete it and the escaped quote leaves the walk "inside" a string, so
        // the comment is kept. A blind audit brute-forced 804k inputs and showed the guard
        // rewrite an earlier comment here claimed credit for was an IDENTITY; the arm
        // itself is what matters, and this assertion is what it buys.
        assert_eq!(
            strip_trailing_comment("RUN echo don\\'t # note").trim(),
            "RUN echo don\\'t"
        );

        // R6 — quote state CARRIES across newlines, so a `#` that is DATA inside a
        // multi-line quoted string survives. R5's per-line reset ate it: a narrower false
        // failure than R4's, but the same defect class as the one R5 was fixing.
        let multiline_string = "RUN <<'S'\nRscript -e '\n# alpha beta\n'\nS";
        assert_eq!(strip_trailing_comment(multiline_string), multiline_string);

        // R6 — `)#` and backtick-`#` are real comments (checked against dash AND bash, not
        // assumed), and each walked both hardened predicates back through their own new
        // fixtures. Three rounds of this is why DEC-16 stops treating the separator set as
        // a completable enumeration.
        assert_eq!(strip_trailing_comment("RUN (true)# note").trim(), "RUN (true)");
        // `(` opens a word too. R6 dropped it from the set while adding `)`, and a blind
        // verifier proved the regression — a narrowing introduced while widening. The
        // asymmetry is the whole reason this line exists.
        assert_eq!(strip_trailing_comment("RUN (#note) true").trim(), "RUN (");
        assert_eq!(strip_trailing_comment("RUN true `#note`").trim(), "RUN true `");

        // ...but a `)` closing a COMMAND SUBSTITUTION is part of the surrounding word, so
        // its `#` is DATA. `echo $(echo A)#X` prints `A#X` in both shells, while
        // `(echo A)#X` prints `A` — so the two `)` cases must not be treated alike.
        assert_eq!(
            strip_trailing_comment("RUN echo $(echo A)#x").trim(),
            "RUN echo $(echo A)#x"
        );
        // Shell parameter expansion is likewise data, not a comment.
        assert_eq!(strip_trailing_comment("RUN n=${#PINS}").trim(), "RUN n=${#PINS}");
        assert_eq!(strip_trailing_comment("RUN test $# -gt 0").trim(), "RUN test $# -gt 0");
    }

    /// TEST-10, mutation 8 — a recipe that DECLARES no smoke instruction FAILS, and the
    /// failure says what to add. This is the anti-vacuity floor for the marker itself: a
    /// recipe with no marker must not read as "nothing to check".
    #[test]
    fn a_recipe_that_declares_no_smoke_instruction_fails_saying_what_to_add() {
        let root = TmpEnvRoot::new("nomarker");
        root.recipe(
            "only",
            "FROM scratch\nRUN loader -e 'load(alpha); load(beta); load(gamma)'\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(root.path())
            .expect_err("an undeclared smoke surface must FAIL");
        assert!(err.contains("DECLARES no build-time smoke surface"), "{err}");
        assert!(err.contains("cyto:env-smoke"), "the failure must name the marker: {err}");
    }

    /// TEST-10, case 6 — a load written across a `\`-CONTINUED `RUN` is still the smoke
    /// surface. Only the first physical line of a continued instruction starts with `RUN`,
    /// so a physical-line scan would fail a correctly-written recipe — and a guard that
    /// fails correct work is one people learn to route around, which is how a guard stops
    /// being there on the day it matters. The recipe on disk happens to use one line; a
    /// second recipe need not, and this branch cannot see it.
    #[test]
    fn a_load_split_across_a_line_continuation_is_still_the_smoke_surface() {
        let root = TmpEnvRoot::new("continuation");
        root.recipe(
            "only",
            "FROM scratch\n# cyto:env-smoke\nRUN loader -e 'load(alpha);' \\\n    -e 'load(beta);' \\\n    -e 'load(gamma)'\n",
            OK_PINS,
        );
        assert_eq!(
            verify_recipe_pin_smoke_correspondence(root.path()),
            Ok(1),
            "a continued RUN is ONE instruction; its loads must count"
        );
    }

    /// TEST-10, case 9 — a smoke written as a BuildKit HEREDOC is one instruction, and a
    /// smoke that DERIVES its list from the pin file covers every pin by construction.
    ///
    /// Both halves are the same point. The second env recipe writes its verification as
    /// `RUN <<'TAG'` wrapping a script that parses the pin file, loads each library and
    /// compares versions. A line-oriented reader sees only the opener, so the script
    /// vanishes; and a spelling-only rule would then fail a recipe whose check is STRONGER
    /// than spelling — forcing a derivation that cannot drift to hand-maintain a list that
    /// can. Refusing either shape would be this guard committing the defect it exists to
    /// retire, on a recipe it was written before seeing.
    #[test]
    fn a_heredoc_smoke_that_derives_its_list_from_the_pin_file_is_covered_by_construction() {
        let root = TmpEnvRoot::new("heredoc-derived");
        root.recipe(
            "only",
            "FROM scratch\n\
             RUN <<'CYTO_INSTALL'\n\
             installer --from /tmp/requirements.txt\n\
             CYTO_INSTALL\n\
             # cyto:env-smoke\n\
             RUN <<'CYTO_SMOKE'\n\
             for m in $(parse /tmp/requirements.txt); do loader -e \"load($m)\"; done\n\
             CYTO_SMOKE\n",
            OK_PINS,
        );
        assert_eq!(
            verify_recipe_pin_smoke_correspondence(root.path()),
            Ok(1),
            "a heredoc smoke deriving from the pin file must be accepted"
        );

        // …and the INSTALL heredoc alone is still not evidence of a load: unmarked, it is
        // not the smoke surface no matter what it references.
        let bare = TmpEnvRoot::new("heredoc-install-only");
        bare.recipe(
            "only",
            "FROM scratch\n\
             RUN <<'CYTO_INSTALL'\n\
             installer --from /tmp/requirements.txt\n\
             CYTO_INSTALL\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(bare.path())
            .expect_err("an unmarked install heredoc is not a smoke surface");
        assert!(err.contains("DECLARES no build-time smoke surface"), "{err}");
    }

    /// TEST-10, case 10 — a SPELLED heredoc smoke is still checked per pin. The derived
    /// exemption must not leak into the spelled shape: a heredoc that loads only some of
    /// the pins, and never reads the pin file, must FAIL naming the one it missed.
    #[test]
    fn a_heredoc_smoke_that_spells_its_list_is_still_checked_per_pin() {
        let root = TmpEnvRoot::new("heredoc-spelled");
        root.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             RUN <<'CYTO_SMOKE'\n\
             loader -e 'load(alpha); load(beta)'\n\
             CYTO_SMOKE\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(root.path())
            .expect_err("a spelled heredoc missing a pin must FAIL");
        assert!(err.contains("gamma"), "names the missed pin: {err}");
    }

    /// TEST-10, case 11 — a comment that merely MENTIONS the marker does not mark.
    ///
    /// `contains` would attach the marker to whatever instruction followed the prose, so a
    /// comment DOCUMENTING the marker silently made the install line a smoke surface — the
    /// hole the declared marker exists to close, re-opened by writing about it. The shipped
    /// recipe carries a prose block directly above its marker, so this is one edit away.
    #[test]
    fn prose_that_mentions_the_marker_does_not_mark_the_next_instruction() {
        let root = TmpEnvRoot::new("prose-marker");
        root.recipe(
            "only",
            "FROM scratch\n\
             # The `cyto:env-smoke` marker below declares the verification.\n\
             RUN pkgmgr install -y alpha beta gamma\n\
             # cyto:env-smoke\n\
             RUN loader -e 'load(alpha)'\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(root.path()).expect_err(
            "only the real marker may mark; the install line above the prose must stay out",
        );
        assert!(
            err.contains("beta") || err.contains("gamma"),
            "the pins that are never loaded must be named: {err}"
        );
    }

    /// TEST-10, case 12 — a comment INSIDE a `\`-continuation does not split the
    /// instruction, and a blank line between marker and instruction does not eat the
    /// marker. Both were false failures on legal Dockerfiles: Docker strips comment lines
    /// wherever they appear, and the second reported "DECLARES no build-time smoke surface"
    /// about a recipe whose marker was right there — telling the reader to add what
    /// already existed.
    #[test]
    fn comments_inside_a_continuation_and_a_blank_line_after_the_marker_are_tolerated() {
        let root = TmpEnvRoot::new("comment-in-cont");
        root.recipe(
            "only",
            "FROM scratch\n\
             # cyto:env-smoke\n\
             \n\
             RUN loader \\\n\
             \x20 # load everything pinned\n\
             \x20 -e 'load(alpha); load(beta); load(gamma)'\n",
            OK_PINS,
        );
        assert_eq!(
            verify_recipe_pin_smoke_correspondence(root.path()),
            Ok(1),
            "a comment inside a continuation and a blank line after the marker are legal"
        );
    }

    /// TEST-10 case 13, RETIRED AND REPLACED (#214) — the grammar is no longer MIRRORED,
    /// it is the same grammar, so this now checks that the ONE parser still refuses each
    /// of these and that the refusal still reaches this consumer.
    ///
    /// ## What was retired, and the trap in retiring it
    ///
    /// This test used to prove that a SECOND parser here held the build gate's grammar.
    /// That second parser is deleted, so the claim is now true by construction — but
    /// deleting it was not free, and the free-looking version would have been a
    /// regression. The deleted reader was deliberately STRICTER than the gate on one
    /// character: it refused `alpha===1.0`, which splits to the version `=1.0`, and the
    /// gate accepted it. **Deleting a reader that is stricter than the one you keep does
    /// not reduce the parser count, it lowers the bar** — and #192's ledger row 64 names
    /// that direction as the one its security findings came from.
    ///
    /// So the strict rule was ADOPTED BY THE GATE first (`parse_env_pins_detailed` now has
    /// `=` in its rejected version character set) and the strict reader deleted after. The
    /// `double-eq` case below is what holds that: if someone "simplifies" the gate's
    /// character set back, this goes red.
    #[test]
    fn every_malformed_pin_the_gate_refuses_still_reaches_this_consumer() {
        for (tag, pin) in [
            // The case the DELETED reader was stricter on. The gate now carries its rule.
            ("double-eq", "alpha===1.0  # import=alpha\n"),
            ("range", "alpha==1.*  # import=alpha\n"),
            ("comma", "alpha==1.0,2.0  # import=alpha\n"),
            ("extras", "alpha[extra]==1.0  # import=alpha\n"),
            ("marker", "alpha;python_version<'3'==1.0  # import=alpha\n"),
        ] {
            let root = TmpEnvRoot::new(tag);
            root.recipe("only", OK_RECIPE, pin);
            // The GENERATOR is where the refusal now lives — it is the parser.
            assert!(
                root.generate().is_err(),
                "[{tag}] `{pin}` must be refused by the one parser"
            );
            // …and the refusal reaches this consumer, rather than leaving it to verify
            // whatever it could still read. No artefact, no pass.
            //
            // The message is checked, not just `is_err()`: a bare `is_err()` here cannot
            // tell "the consumer correctly refused because the parser produced nothing"
            // from "the consumer failed for some unrelated reason", and a blind audit
            // flagged exactly that. Naming the artefact is what makes the refusal
            // attributable to the chain under test.
            // `expect_err` takes a plain `&str`, so the first cut printed the literal
            // `[{tag}]` — the one case you could not attribute to a fixture was the one that
            // failed. Caught by a blind audit reading the panic path. A `match` is used
            // rather than `unwrap_or_else`, whose closure runs on the Err arm: writing that
            // would have inverted the test into "the consumer must SUCCEED".
            let err = match verify_recipe_pin_smoke_correspondence(&root.0) {
                Err(e) => e,
                Ok(_) => panic!(
                    "[{tag}] the consumer must refuse when the parser produced no artefact"
                ),
            };
            assert!(
                err.contains(ENV_PIN_ARTEFACT),
                "[{tag}] the consumer's refusal must name the exported parse it could not \
                 read, so it is attributable to the parser's refusal: {err}"
            );
        }
        // …and `import=` must start a WORD, so a sentence mentioning it does not become
        // the key a pin is checked on. That grammar MOVED into the gate with the parser;
        // this asserts the move kept the property rather than dropping it.
        let root = TmpEnvRoot::new("reimport");
        root.recipe("only", OK_RECIPE, "alpha==1.0  # do not reimport=beta here\n");
        let err = root
            .generate()
            .expect_err("`reimport=` is not an `import=` token");
        assert!(err.contains("import="), "{err}");
    }

    /// TEST-10, mutation 5 — a pinned import must be matched on TOKEN BOUNDARIES, so a
    /// longer name does not satisfy a shorter pin. Without this, `alpha` would be
    /// "verified" by a line loading only `alphanumeric`.
    #[test]
    fn a_longer_module_name_does_not_satisfy_a_shorter_pin() {
        let root = TmpEnvRoot::new("boundary");
        root.recipe(
            "only",
            "FROM scratch\n# cyto:env-smoke\nRUN loader -e 'load(alphanumeric); load(beta); load(gamma)'\n",
            OK_PINS,
        );
        let err = verify_recipe_pin_smoke_correspondence(root.path())
            .expect_err("a prefix match must not satisfy the pin");
        assert!(err.contains("alpha"), "{err}");
    }

    // TEST-9 [ITEM-4]: provenance-by-reference wiring — the digest the provider
    // stamps via `set_last_resolved_digest` is exactly what `last_resolved_digest`
    // (which `provenance::capture::env_digest_rootfs` reads) returns, so a run
    // records the OCI content digest it resolved. (The end-to-end record under a
    // real sandbox run is the DEC-O follow-on; this proves the stamp↔read wire.)
    #[test]
    fn resolved_digest_round_trips_to_provenance_reader() {
        let hex = "a".repeat(64);
        set_last_resolved_digest(&hex);
        assert_eq!(last_resolved_digest().as_deref(), Some(hex.as_str()));
        assert_eq!(
            crate::modules::provenance::capture::env_digest_rootfs().as_deref(),
            Some(hex.as_str()),
            "the provenance reader returns the provider-stamped digest"
        );
    }

    // TEST-1: arch maps to the OCI arch string used in the tag. The two
    // supported build arches map to their OCI names; the host we build+test on
    // must be one of them (a `_` catch-all here would make the assert vacuous).
    #[test]
    fn target_arch_maps_to_oci_arch() {
        assert!(
            matches!(target_arch(), "amd64" | "arm64"),
            "the build arch must map to a supported OCI arch, got {:?}",
            target_arch()
        );
        // On this x86 CI host it is amd64.
        #[cfg(target_arch = "x86_64")]
        assert_eq!(target_arch(), "amd64");
        #[cfg(target_arch = "aarch64")]
        assert_eq!(target_arch(), "arm64");
    }

    // ───────────────────── #189 — the derived env union + the seams ─────────────────

    /// Build an `ExtensionManifest` from JSON, so a fixture states only the keys it is
    /// about. Going through serde (rather than a struct literal) also means these
    /// fixtures exercise the very `env:` parsing the contribution type declares.
    fn manifest_json(v: serde_json::Value) -> crate::modules::extensions::types::ExtensionManifest {
        serde_json::from_value(v).expect("fixture manifest parses")
    }

    /// A manifest declaring one analysis, with `env` present or absent.
    fn analysis_manifest(id: &str, env: Option<&str>) -> crate::modules::extensions::types::ExtensionManifest {
        let mut a = serde_json::json!({ "id": format!("{id}.act"), "category": "c", "title": "T" });
        if let Some(e) = env {
            a["env"] = serde_json::json!(e);
        }
        manifest_json(serde_json::json!({
            "id": id, "name": id, "publisher": "t", "version": "0.1.0", "apiVersion": "1.0",
            "contributes": { "analyses": [a] }
        }))
    }

    /// A manifest declaring one converter, with `env` present or absent.
    fn converter_manifest(id: &str, env: Option<&str>) -> crate::modules::extensions::types::ExtensionManifest {
        let mut c = serde_json::json!({
            "id": format!("{id}.conv"), "title": "T", "trigger": "on-ingest",
            "run": { "kind": "sandbox", "runtime": "python", "entry": "compute/e.py" }
        });
        if let Some(e) = env {
            c["env"] = serde_json::json!(e);
        }
        manifest_json(serde_json::json!({
            "id": id, "name": id, "publisher": "t", "version": "0.1.0", "apiVersion": "1.0",
            "contributes": { "converters": [c] }
        }))
    }

    /// **TEST-E1-7** [acceptance] [invariant: INV-4] **PROV-E1-6** [covers: ITEM-11] —
    /// the deployment default derives from the UNION of both contribution kinds.
    ///
    /// The first case is the one that did not work before #189: a registry whose only
    /// `env` declaration sits on an ANALYSIS. The old reader walked converters only, so
    /// such a registry auto-detected nothing and every job fell through to "no env
    /// declared" — an epic whose entire point is an analysis-declared env could not have
    /// resolved one.
    ///
    /// **No env-name literal appears in any assertion.** Every expected value is read
    /// back out of the fixture that declared it (the `DECLARED_*` bindings), following
    /// the R3-F2 discipline this module's sibling tests already hold to: an assertion
    /// spelling a real env name would put the very domain vocabulary INV-4 forbids into
    /// the app core's own test surface, and would keep passing if the derivation were
    /// replaced by that constant.
    /// Lifecycle id: **TEST-7** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_default_env_derives_from_the_union_of_both_contribution_kinds() {
        const DECLARED_A: &str = "fixture-env-a";
        const DECLARED_B: &str = "fixture-env-b";

        // (a) ANALYSIS-ONLY registry ⇒ the analysis' env is found.
        let analysis_only = vec![analysis_manifest("pkg", Some(DECLARED_A))];
        assert_eq!(
            first_declared_env(&analysis_only).as_deref(),
            Some(DECLARED_A),
            "an analysis-declared env must be discoverable; walking converters alone \
             returned None here before #189"
        );
        assert_eq!(declared_env_ids_of(&analysis_only), vec![DECLARED_A.to_string()]);

        // (b) BOTH kinds ⇒ a deterministic union, sorted + deduped.
        let both = vec![
            converter_manifest("pkg1", Some(DECLARED_B)),
            analysis_manifest("pkg2", Some(DECLARED_A)),
        ];
        let mut expect = vec![DECLARED_A.to_string(), DECLARED_B.to_string()];
        expect.sort();
        assert_eq!(declared_env_ids_of(&both), expect, "the union is sorted + deduped");

        // (c) A DUPLICATE declaration across kinds collapses to one entry.
        let dup = vec![
            converter_manifest("pkg1", Some(DECLARED_A)),
            analysis_manifest("pkg2", Some(DECLARED_A)),
        ];
        assert_eq!(declared_env_ids_of(&dup), vec![DECLARED_A.to_string()]);

        // (d) NOTHING declared ⇒ None / empty. Never an invented name.
        let none = vec![analysis_manifest("pkg", None), converter_manifest("pkg2", None)];
        assert_eq!(first_declared_env(&none), None);
        assert!(declared_env_ids_of(&none).is_empty());

        // (e) INV-1 — ORDER IS PRESERVED for a converter-only registry, which is every
        //     registry shipping today. This is the regression clause: the pre-#189 reader
        //     walked converters in registry order and took the first, and that answer must
        //     not move now that analyses are also in the scan.
        let converters_only = vec![
            converter_manifest("pkg1", Some(DECLARED_B)),
            converter_manifest("pkg2", Some(DECLARED_A)),
        ];
        assert_eq!(
            first_declared_env(&converters_only).as_deref(),
            Some(DECLARED_B),
            "registry order still decides; sorting the union would have silently \
             re-pointed an existing deployment at a different image"
        );

        // …and a converter's env still OUTRANKS an analysis' env within one manifest,
        // which is what makes (e) hold once analyses start declaring envs too.
        let mixed = manifest_json(serde_json::json!({
            "id": "pkg", "name": "pkg", "publisher": "t", "version": "0.1.0", "apiVersion": "1.0",
            "contributes": {
                "converters": [{
                    "id": "pkg.conv", "title": "T", "trigger": "on-ingest", "env": DECLARED_B,
                    "run": { "kind": "sandbox", "runtime": "python", "entry": "compute/e.py" }
                }],
                "analyses": [{ "id": "pkg.act", "category": "c", "title": "T", "env": DECLARED_A }]
            }
        }));
        assert_eq!(first_declared_env(&[mixed]).as_deref(), Some(DECLARED_B));
    }

    /// A blank `env:` is REFUSED AT PARSE — it never reaches the union at all.
    ///
    /// This is the stricter of the two behaviours that were available, and it is the
    /// right one: silently treating `env: ""` as "declares no env" would run the job in
    /// the deployment default while the manifest author believed they had selected an
    /// env, which is the substitution INV-2 exists to forbid, arrived at from the
    /// manifest side instead of the seam side.
    ///
    /// The `trim`/non-empty filter inside `declared_envs_in` is therefore a BACKSTOP for
    /// manifests built by other means (struct literals in other tests, a future loader
    /// path), not the primary defence — asserted directly below so it cannot rot into a
    /// no-op unnoticed.
    /// Lifecycle id: **TEST-8** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_blank_env_declaration_is_refused_at_parse() {
        for blank in ["", "   "] {
            let err = serde_json::from_value::<crate::modules::extensions::types::ExtensionManifest>(
                serde_json::json!({
                    "id": "pkg", "name": "pkg", "publisher": "t", "version": "0.1.0",
                    "apiVersion": "1.0",
                    "contributes": {
                        "analyses": [{ "id": "pkg.act", "category": "c", "title": "T", "env": blank }]
                    }
                }),
            )
            .expect_err("a blank env-id must be refused, not read as `no env declared`");
            let msg = err.to_string();
            assert!(msg.contains("`env`"), "names the key: {msg}");
        }
    }

    /// The union's own trim/non-empty backstop, exercised directly on a manifest whose
    /// blank value bypassed the deserializer.
    /// Lifecycle id: **TEST-9** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_union_skips_a_blank_env_that_bypassed_the_parser() {
        use crate::modules::extensions::types::{AnalysisContributionData, Contributes, ExtensionManifest};
        let m = ExtensionManifest {
            id: "pkg".into(),
            name: "pkg".into(),
            publisher: "t".into(),
            version: "0.1.0".into(),
            api_version: "1.0".into(),
            contributes: Contributes {
                analyses: vec![AnalysisContributionData {
                    id: "pkg.act".into(),
                    methods: None,
                    draftable: None,
                    env: Some("   ".into()),
                    rest: Default::default(),
                }],
                ..Default::default()
            },
        };
        assert_eq!(first_declared_env(&[m]), None);
    }

    // ───────────── #189 / PROV-E1-5 — the air-gap seams are ENV-SCOPED ─────────────

    /// Clear every seam variable this test family touches, so a case starts from a known
    /// state whichever order the binary runs them in.
    fn clear_seam_vars() {
        // DERIVE the per-env variables to clear from the environment itself, so a test
        // that stages a new env-id cannot leak it into every later test in the binary by
        // forgetting to extend a typed list — the enumeration defect this whole module
        // argues against, one level down.
        for key in SEAM_KEYS {
            std::env::remove_var(key);
            std::env::remove_var(format!("{key}_ENV"));
            for env in suffixed_envs_for(key) {
                std::env::remove_var(format!("{key}{ENV_SEAM_SUFFIX}{env}"));
            }
        }
        for k in [
            "CYTO_ENV_ROOTFS_SQUASHFS",
            "CYTO_ENV_ROOTFS_SQUASHFS_ENV",
            "CYTO_ENV_ROOTFS_SQUASHFS__env-a",
            "CYTO_ENV_ROOTFS_SQUASHFS__env-b",
            "CYTO_ENV_ROOTFS_DIR",
            "CYTO_ENV_ROOTFS_DIR_ENV",
            "CYTO_ENV_ROOTFS_DIR__env-a",
            "CYTO_ENV_ROOTFS_DIR__env-b",
        ] {
            std::env::remove_var(k);
        }
    }

    /// **TEST-E1-6** [acceptance] [invariant: INV-2] **PROV-E1-5** [covers: ITEM-10] —
    /// a request for an env the staged rootfs does not serve is REFUSED BY NAME.
    ///
    /// This is the contract's whole point, and the defect it closes was not a missing
    /// feature but a WRONG ANSWER: `provide` consulted the bare squashfs variable before
    /// reading `env_id` and returned unconditionally, so every env-id resolved to the
    /// same staged image. A job declaring an R env mounted the python image and ran
    /// `Rscript` inside it — failing in a way that reads as "R is broken", which sends
    /// the next reader to the image rather than the resolver.
    ///
    /// Both envs must appear in the message. Asserting only that it errored would pass
    /// for a bare "backend unavailable", which is exactly the uninformative failure that
    /// made the original bug expensive.
    /// Lifecycle id: **TEST-10** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_request_for_an_unserved_env_is_refused_naming_both_envs() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        // A single-env deployment: the BARE variable, explicitly associated with env-a.
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS", "/staged/a.squashfs");
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS_ENV", "env-a");

        // The env it DOES serve is served — this is the single-env back-compat path
        // (DEC-3), and it is the control that keeps the refusal below meaningful: without
        // it, a resolver that refused EVERYTHING would also pass.
        let served = staged_squashfs_for("env-a").expect("the staged env is served");
        assert_eq!(
            served.as_path(),
            std::path::Path::new("/staged/a.squashfs"),
            "the env the artifact serves still resolves to it, unchanged"
        );

        // The env it does NOT serve is refused — not substituted, not warned-past.
        // The seam DECLINES for an env it does not serve; the refusal is raised once
        // every seam has declined (see `staged_env_refusal`), which is what lets a
        // deployment stage one env per seam.
        assert!(staged_squashfs_for("env-b").is_none(), "the seam declines");
        let err = staged_env_refusal("env-b")
            .expect("an env the staged rootfs does not serve must be REFUSED");
        assert_eq!(
            err.error_code(),
            ENV_STAGED_MISMATCH_CODE,
            "a typed refusal, so a caller can let it through its own error wrapping"
        );
        let msg = format!("{err}");
        assert!(msg.contains("env-b"), "names the REQUESTED env: {msg}");
        assert!(msg.contains("env-a"), "names the STAGED env: {msg}");

        clear_seam_vars();
    }

    /// A per-env suffixed variable serves exactly its own env, and a sibling env with no
    /// artifact of its own is refused rather than falling through to another env's.
    /// Lifecycle id: **TEST-11** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_suffixed_seam_serves_only_its_own_env() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS__env-a", "/staged/a.squashfs");

        assert_eq!(
            staged_squashfs_for("env-a").expect("its own env resolves").as_path(),
            std::path::Path::new("/staged/a.squashfs")
        );

        // env-b has no artifact under THIS seam, so the seam DECLINES — the refusal is
        // raised by `provide` once every seam has declined, which is what lets a
        // deployment stage one env per seam (see
        // `one_env_per_seam_is_served_not_refused_by_the_other_seam`).
        assert!(
            staged_squashfs_for("env-b").is_none(),
            "a seam with no artifact for this env declines; it does not refuse alone"
        );
        // …and the REFUSAL still happens, at the level that can see every seam.
        let err = OciEnvImageProvider::new()
            .provide("env-b", Duration::from_secs(5))
            .expect_err("a sibling env is staged, so env-b must be refused, not pulled");
        assert_eq!(err.error_code(), ENV_STAGED_MISMATCH_CODE);
        let msg = format!("{err}");
        assert!(msg.contains("env-b") && msg.contains("env-a"), "names both: {msg}");

        // The suffixed variable WINS over a bare one pointed elsewhere — the exact
        // spelling matters more than the fallback.
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS", "/staged/other.squashfs");
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS_ENV", "env-b");
        assert_eq!(
            staged_squashfs_for("env-a").expect("the exact per-env variable wins").as_path(),
            std::path::Path::new("/staged/a.squashfs")
        );

        clear_seam_vars();
    }

    /// With NOTHING staged, the seam declines and the caller falls through to the OCI
    /// path — the seam must not manufacture a refusal out of an unconfigured deployment.
    /// Lifecycle id: **TEST-12** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn no_staged_artifact_falls_through_to_the_registry_path() {
        let _g = air_gap_env_guard();
        clear_seam_vars();
        assert!(
            staged_squashfs_for("env-a").is_none(),
            "an unconfigured seam declines"
        );
        assert!(
            staged_env_refusal("env-a").is_none(),
            "…and with nothing staged anywhere there is no refusal either — the caller \
             falls through to the OCI path, as an un-air-gapped deployment should"
        );
        clear_seam_vars();
    }

    /// The refusal is ON THE RUNTIME PATH, not merely in a helper a test calls directly.
    ///
    /// This is the wired-and-behaving check: `staged_squashfs_for` could be perfectly
    /// correct and perfectly unreachable, which is the same false pass as the original
    /// bug (a resolver that was never consulted). Drive the real
    /// `EnvImageProvider::provide` and assert the refusal surfaces there.
    /// Lifecycle id: **TEST-13** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn provide_itself_refuses_a_mismatched_staged_env() {
        let _g = air_gap_env_guard();
        clear_seam_vars();
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS", "/staged/a.squashfs");
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS_ENV", "env-a");

        let err = OciEnvImageProvider::new()
            .provide("env-b", Duration::from_secs(5))
            .expect_err("provide() must refuse an env the staged rootfs does not serve");
        assert_eq!(err.error_code(), ENV_STAGED_MISMATCH_CODE);
        let msg = format!("{err}");
        assert!(msg.contains("env-b") && msg.contains("env-a"), "names both: {msg}");

        clear_seam_vars();
    }

    // ───────── #189 / PROV-E1-4 — the digest is RUN-SCOPED, proven concurrently ─────────

    /// Stage a distinct squashfs into the digest cache and return a cache-shaped,
    /// `usr/`-bearing mount dir for it — what the pre-mounted-dir seam accepts and
    /// derives a digest from.
    fn stage_a_distinct_env(tag: &str) -> (String, std::path::PathBuf, std::path::PathBuf) {
        let tmp = std::env::temp_dir().join(format!("cyto-env-conc-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("rootfs.squashfs");
        let bytes = format!("distinct-rootfs-{tag}-{}", uuid::Uuid::new_v4()).into_bytes();
        std::fs::write(&src, &bytes).unwrap();
        let hex = squashfs_content_digest(&src).expect("hashes");
        stage_squashfs_into_cache(&src, &hex).expect("stages");
        let dir = crate::modules::rootfs::cache::digest_dir(&hex);
        std::fs::create_dir_all(dir.join("usr")).unwrap();
        // The source temp dir is RETURNED, not deleted here: `stage_squashfs_into_cache`
        // may hardlink or symlink rather than copy, so removing the source can invalidate
        // the staged digest (it did — every round of the concurrency test then read back
        // `None`). The caller removes both at the end.
        (hex, dir, tmp)
    }

    /// **TEST-E1-5** [acceptance] [invariant: INV-3] **PROV-E1-4** [covers: ITEM-9] —
    /// two CONCURRENT `provide()` calls on two different envs each receive THEIR OWN
    /// digest.
    ///
    /// **This test is genuinely concurrent, and it has to be.** The property claimed is
    /// about a race, and a sequential test cannot distinguish "each call returns its own
    /// value" from "a shared cell happened to hold the right value when each call
    /// finished" — which is exactly what the process-global
    /// `LAST_RESOLVED_DIGEST` did, and why it was survivable while only one env existed.
    /// The two threads are released together off a barrier and interleave many times, so
    /// a last-write-wins carrier would be observed holding the *other* thread's digest.
    ///
    /// Note what is asserted: the value each call RETURNS. The global is deliberately not
    /// consulted — under a correct implementation there is no shared cell for the answer
    /// to come from, which is the whole of INV-3.
    /// Lifecycle id: **TEST-14** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn two_concurrent_provides_on_different_envs_each_get_their_own_digest() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        let (hex_a, dir_a, tmp_a) = stage_a_distinct_env("a");
        let (hex_b, dir_b, tmp_b) = stage_a_distinct_env("b");
        assert_ne!(hex_a, hex_b, "the two envs must be distinguishable at all");

        std::env::set_var("CYTO_ENV_ROOTFS_DIR__env-a", &dir_a);
        std::env::set_var("CYTO_ENV_ROOTFS_DIR__env-b", &dir_b);

        // Enough rounds that a shared-cell implementation is overwhelmingly likely to be
        // caught interleaved, rather than passing on a lucky schedule.
        const ROUNDS: usize = 2000;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let mismatches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::new();
        for (env, want) in [("env-a", hex_a.clone()), ("env-b", hex_b.clone())] {
            let barrier = std::sync::Arc::clone(&barrier);
            let mismatches = std::sync::Arc::clone(&mismatches);
            handles.push(std::thread::spawn(move || {
                for _ in 0..ROUNDS {
                    barrier.wait(); // release both threads into provide() together
                    let got = OciEnvImageProvider::new()
                        .provide(env, Duration::from_secs(5))
                        .expect("the staged env resolves");
                    if got.digest.as_deref() != Some(want.as_str()) {
                        mismatches.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }));
        }
        for h in handles {
            h.join().expect("neither provider thread panicked");
        }

        assert_eq!(
            mismatches.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "each concurrent run must receive the digest of the image IT mounted; a \
             non-zero count means one run was handed the other's digest, which is the \
             process-global last-write behaviour INV-3 forbids"
        );

        clear_seam_vars();
        for d in [&dir_a, &dir_b, &tmp_a, &tmp_b] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// The run-scoped sidecar round-trips, and is isolated PER WORKSPACE under genuine
    /// concurrency — the carrier that gets the returned digest to the recorder.
    ///
    /// The isolation half is the point: the recorder reads this file off the run's own
    /// workspace root, so two runs finalizing at once must not be able to see each
    /// other's value.
    /// Lifecycle id: **TEST-16** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_run_env_digest_sidecar_round_trips_and_is_per_workspace() {
        let root = std::env::temp_dir().join(format!("cyto-envdigest-{}", uuid::Uuid::new_v4()));

        // Absent ⇒ None. This is the honest record for a run that mounted no env image
        // (an in-app interaction run, a promote/byte-copy run) and is what closes the
        // second window the old DEC-O note described, where such a run inherited a
        // previous run's digest.
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(read_run_env_digest(&root), None);

        // A MALFORMED sidecar is also None — never a half-read value written into
        // provenance as though it were a content digest.
        std::fs::write(root.join(RUN_ENV_DIGEST_FILE), "not-a-digest").unwrap();
        assert_eq!(read_run_env_digest(&root), None);

        // Round-trip, including the trailing-newline tolerance.
        let hex = "a".repeat(64);
        write_run_env_digest(&root, Some(&hex));
        assert_eq!(read_run_env_digest(&root).as_deref(), Some(hex.as_str()));

        // Writing `None` records nothing rather than clearing to an empty file.
        let other = std::env::temp_dir().join(format!("cyto-envdigest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&other).unwrap();
        write_run_env_digest(&other, None);
        assert_eq!(read_run_env_digest(&other), None);

        // CONCURRENT, per-workspace isolation: N runs writing at once each read back
        // their own value.
        let roots: Vec<(std::path::PathBuf, String)> = (0..8)
            .map(|i| {
                let r = std::env::temp_dir().join(format!("cyto-envdigest-c{i}-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&r).unwrap();
                (r, format!("{i:x}").repeat(64)[..64].to_string())
            })
            .collect();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(roots.len()));
        let handles: Vec<_> = roots
            .iter()
            .cloned()
            .map(|(r, want)| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    write_run_env_digest(&r, Some(&want));
                    assert_eq!(
                        read_run_env_digest(&r).as_deref(),
                        Some(want.as_str()),
                        "a run's sidecar must be its own, whatever else is finalizing"
                    );
                })
            })
            .collect();
        for h in handles {
            h.join().expect("no writer thread panicked");
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
        for (r, _) in roots {
            let _ = std::fs::remove_dir_all(r);
        }
    }

    /// The DETERMINISTIC half of INV-3: a run whose env carries NO content identity
    /// records `None` — it does not inherit whatever digest the process resolved last.
    ///
    /// This is the companion to the concurrency test above and it exists because that
    /// test, on its own, is a probabilistic detector: the race window it targets is a
    /// few syscalls wide, so a process-global implementation survives it on most
    /// schedules. Measured against a deliberately reintroduced global, the concurrent
    /// test caught it roughly one run in five. This one catches it EVERY time, because
    /// it does not depend on timing at all — it exercises the case where the correct
    /// answer and the stale global answer are DIFFERENT VALUES rather than the same
    /// value observed at different moments.
    ///
    /// It is also the honest-record property in its own right (the second window the old
    /// DEC-O note described): a bare pre-mounted dir has no digest to record, and
    /// claiming one would write a confident, wrong image reference into the reproduce
    /// path — worse than recording nothing.
    /// Lifecycle id: **TEST-15** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_run_with_no_content_identity_records_none_not_the_last_global() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        // Poison the process-global with a sentinel a previous run might have left.
        let sentinel = "f".repeat(64);
        set_last_resolved_digest(&sentinel);
        assert_eq!(last_resolved_digest().as_deref(), Some(sentinel.as_str()));

        // A bare pre-mounted dir: `usr/` present, but NOT the digest cache's own mount
        // point, so no digest can be derived from it.
        let bare = std::env::temp_dir().join(format!("cyto-env-bare-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(bare.join("usr")).unwrap();
        std::env::set_var("CYTO_ENV_ROOTFS_DIR__env-a", &bare);

        let provided = OciEnvImageProvider::new()
            .provide("env-a", Duration::from_secs(5))
            .expect("a bare pre-mounted dir still serves the run");
        assert_eq!(provided.rootfs_dir, bare, "it mounts the operator's dir");
        assert_eq!(
            provided.digest, None,
            "a mount with no content identity records NOTHING; returning the stale \
             process-global here is precisely the corruption INV-3 forbids"
        );

        clear_seam_vars();
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// **TEST-E1-2** [acceptance] **PROV-E1-2** [covers: ITEM-7] — the per-job env
    /// precedence chain, asserted in BOTH directions at each boundary.
    ///
    /// The contract fixes an ordering that is easy to get backwards, and I did get it
    /// backwards on the first pass: the natural implementation is
    /// `declared.or_else(default_env_id)`, which puts the DECLARED env above the operator
    /// override. That silently breaks `CYTO_SANDBOX_ENV_ID` as an escape hatch the moment
    /// any package declares an env — precisely when an operator (air-gapped deployment,
    /// recovery run, in-pod re-entry) most needs to force a known image.
    ///
    /// Each boundary is asserted from both sides, because a one-sided assertion passes
    /// for an implementation that ignores the lower-precedence source entirely.
    /// Lifecycle id: **TEST-17** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_per_job_env_precedence_chain_holds_in_both_directions() {
        use crate::modules::sandbox::settings::SandboxResourceLimits;
        use crate::modules::sandbox::settings_cache;
        const DECLARED: &str = "fixture-declared";
        const OPERATOR: &str = "fixture-operator";
        const SETTINGS: &str = "fixture-settings";

        let _g = super::process_env_guard();
        let saved = std::env::var("CYTO_SANDBOX_ENV_ID").ok();

        // ── boundary 1: the DECLARED env outranks the settings row ──
        std::env::remove_var("CYTO_SANDBOX_ENV_ID");
        settings_cache::invalidate(SandboxResourceLimits {
            default_env_id: Some(SETTINGS.into()),
            ..SandboxResourceLimits::defaults()
        });
        assert_eq!(
            resolve_env_id(Some(DECLARED)).as_deref(),
            Some(DECLARED),
            "a job's declared env must beat the deployment default — this IS per-job selection"
        );
        // …and the other side: with nothing declared, the settings row still wins.
        assert_eq!(
            resolve_env_id(None).as_deref(),
            Some(SETTINGS),
            "an env-less job still resolves the deployment default (INV-1)"
        );

        // ── boundary 2: the OPERATOR override outranks the declared env ──
        std::env::set_var("CYTO_SANDBOX_ENV_ID", OPERATOR);
        assert_eq!(
            resolve_env_id(Some(DECLARED)).as_deref(),
            Some(OPERATOR),
            "CYTO_SANDBOX_ENV_ID must remain an escape hatch even when a job declares an env"
        );
        assert_eq!(resolve_env_id(None).as_deref(), Some(OPERATOR));

        // ── a blank declared env is ABSENT, not an env named "" ──
        std::env::remove_var("CYTO_SANDBOX_ENV_ID");
        assert_eq!(resolve_env_id(Some("   ")).as_deref(), Some(SETTINGS));

        // ── and `default_env_id()` is exactly `resolve_env_id(None)` ──
        assert_eq!(default_env_id(), resolve_env_id(None));

        settings_cache::invalidate(SandboxResourceLimits::defaults());
        match saved {
            Some(v) => std::env::set_var("CYTO_SANDBOX_ENV_ID", v),
            None => std::env::remove_var("CYTO_SANDBOX_ENV_ID"),
        }
    }

    /// **PROV-E1-5, the UNASSOCIATED case** — a bare staged rootfs the deployment cannot
    /// name is REFUSED, not served for whatever env happens to ask.
    ///
    /// Found by a blind audit, which observed that the `served == None` arm swallowed
    /// this and that every other seam test steered around it by setting
    /// `CYTO_ENV_ROOTFS_SQUASHFS_ENV` explicitly. It is reachable: with `*_ENV`, the
    /// operator override, the settings row and the registry all empty, the ONLY way
    /// `provide` is called is with an env a JOB declared — so "serve the bare artifact
    /// anyway" means running that job against a rootfs nothing claims is the right one,
    /// which is the substitution this contract forbids.
    /// Lifecycle id: **TEST-31** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn an_unassociated_bare_seam_is_refused_rather_than_served_for_any_env() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        // A bare artifact, and NOTHING that can name which env it is for. The
        // deployment-default resolver is INJECTED as `None` rather than arranged through
        // process globals: whether the real `default_env_id()` is None depends on whether
        // another test in this binary has published a registry, which would make this
        // test pass or fail by execution order instead of by behaviour.
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS", "/staged/unknown.squashfs");

        assert!(
            seam_serves("CYTO_ENV_ROOTFS_SQUASHFS", "env-a", || None).is_none(),
            "an unassociated seam serves nothing"
        );
        let err = staged_env_refusal_with("env-a", || None)
            .expect("an unassociated staged rootfs must be REFUSED, not served");
        assert_eq!(
            err.error_code(),
            ENV_STAGED_UNASSOCIATED_CODE,
            "its OWN code — the mismatch code's contract is that both envs are named, \
             and there is no staged env to name here"
        );
        let msg = format!("{err}");
        assert!(msg.contains("env-a"), "names the requested env: {msg}");
        assert!(
            msg.contains("CYTO_ENV_ROOTFS_SQUASHFS_ENV"),
            "tells the operator how to state the association: {msg}"
        );

        // …and the moment the association IS stated, the same request is served — so the
        // refusal above is about the missing association, not about refusing everything.
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS_ENV", "env-a");
        assert_eq!(
            seam_serves("CYTO_ENV_ROOTFS_SQUASHFS", "env-a", || None)
                .expect("now associated")
                .as_path(),
            std::path::Path::new("/staged/unknown.squashfs")
        );
        // …and a DIFFERENT env is still refused once the association exists.
        assert!(
            seam_serves("CYTO_ENV_ROOTFS_SQUASHFS", "env-b", || None).is_none()
                && staged_env_refusal_with("env-b", || None).is_some(),
            "an associated artifact still refuses the env it does not serve"
        );

        clear_seam_vars();
    }

    /// **Cross-seam scoping** — a deployment staging one env as a squashfs and another as
    /// a pre-mounted dir serves BOTH, rather than the first seam refusing the second's env.
    ///
    /// Found by a blind audit. Seam 1's sibling-refusal used to return before seam 2 was
    /// ever consulted, so `SQUASHFS__env-a` + `DIR__env-b` rejected a legitimate `env-b`
    /// job while naming `env-a`.
    /// Lifecycle id: **TEST-32** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn one_env_per_seam_is_served_not_refused_by_the_other_seam() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        let (_hex, dir_b, tmp_b) = stage_a_distinct_env("crossseam");
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS__env-a", "/staged/a.squashfs");
        std::env::set_var("CYTO_ENV_ROOTFS_DIR__env-b", &dir_b);

        // env-b is served by seam 2, even though seam 1 stages a sibling.
        let provided = OciEnvImageProvider::new()
            .provide("env-b", Duration::from_secs(5))
            .expect("env-b is staged under the DIR seam and must be served");
        assert_eq!(provided.rootfs_dir, dir_b);

        // …and an env NEITHER seam stages is still refused (the control that keeps the
        // assertion above from passing for a resolver that stopped refusing).
        let err = OciEnvImageProvider::new()
            .provide("env-c", Duration::from_secs(5))
            .expect_err("an env no seam stages must still be refused");
        assert_eq!(err.error_code(), ENV_STAGED_MISMATCH_CODE);

        clear_seam_vars();
        let _ = std::fs::remove_dir_all(&dir_b);
        let _ = std::fs::remove_dir_all(&tmp_b);
    }

    /// Lifecycle id: **TEST-37** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    ///
    /// **Cross-seam, the OTHER two refusal kinds** — a bare artifact under seam 1 must
    /// not preempt an EXACT per-env artifact under seam 2.
    ///
    /// Round 2 of the blind audit found the first cross-seam fix was only half-done: the
    /// sibling refusal had been deferred to `provide`, but the mismatch and unassociated
    /// refusals were still raised from inside seam 1 and propagated before seam 2 was
    /// consulted. The existing cross-seam test used two SUFFIXED variables — the one
    /// variant that had been fixed — so it stayed green over the gap.
    #[test]
    fn a_bare_seam_does_not_preempt_an_exact_match_under_the_other_seam() {
        let _g = air_gap_env_guard();
        clear_seam_vars();
        let (_hex, dir_b, tmp_b) = stage_a_distinct_env("crossbare");

        // (a) seam 1 bare + ASSOCIATED to a different env; seam 2 has an exact match.
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS", "/staged/a.squashfs");
        std::env::set_var("CYTO_ENV_ROOTFS_SQUASHFS_ENV", "env-a");
        std::env::set_var("CYTO_ENV_ROOTFS_DIR__env-b", &dir_b);
        let provided = OciEnvImageProvider::new()
            .provide("env-b", Duration::from_secs(5))
            .expect("an exact per-env artifact under seam 2 must win over seam 1's bare one");
        assert_eq!(provided.rootfs_dir, dir_b);

        // (b) seam 1 bare + UNASSOCIATED; seam 2 still has the exact match.
        std::env::remove_var("CYTO_ENV_ROOTFS_SQUASHFS_ENV");
        assert_eq!(
            seam_serves("CYTO_ENV_ROOTFS_DIR", "env-b", || None)
                .expect("seam 2 still serves it")
                .as_path(),
            dir_b.as_path()
        );
        // Asserted through `provide()`, which is where the ordering actually lives: the
        // refusal helper is only REACHED once every seam has declined, so calling it
        // directly here would be testing it out of contract.
        let provided = OciEnvImageProvider::new()
            .provide("env-b", Duration::from_secs(5))
            .expect("seam 2's exact match must still win over seam 1's UNASSOCIATED bare one");
        assert_eq!(provided.rootfs_dir, dir_b);

        clear_seam_vars();
        for d in [&dir_b, &tmp_b] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// Lifecycle id: **TEST-38** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    ///
    /// A per-env artifact that IS declared for the requested env but is UNUSABLE reports
    /// that, rather than a self-contradictory mismatch against the very env asked for.
    ///
    /// Round 2 found this: `staged_env_refusal` took the first suffixed env without
    /// excluding `env_id`, so a `__env-b` variable pointing at a dir with no `usr/`
    /// produced "serves env-b, but this job requested env-b" — telling the operator to
    /// set the variable they had already set, and hiding the real cause.
    #[test]
    fn an_unusable_artifact_for_the_requested_env_says_so() {
        let _g = air_gap_env_guard();
        clear_seam_vars();

        // Declared for env-b, but the dir has no `usr/` — it cannot be mounted.
        let bare = std::env::temp_dir().join(format!("cyto-nousr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&bare).unwrap();
        std::env::set_var("CYTO_ENV_ROOTFS_DIR__env-b", &bare);

        let err = OciEnvImageProvider::new()
            .provide("env-b", Duration::from_secs(5))
            .expect_err("an unusable declared artifact must be refused, not fallen through");
        assert_eq!(
            err.error_code(),
            ENV_STAGED_UNUSABLE_CODE,
            "its own code — this is not a mismatch, it is a broken path for the RIGHT env"
        );
        let msg = format!("{err}");
        assert!(msg.contains("env-b"), "names the env: {msg}");
        assert!(
            msg.contains("usr/"),
            "names what is actually wrong, rather than blaming the env: {msg}"
        );

        clear_seam_vars();
        let _ = std::fs::remove_dir_all(&bare);
    }
}

