//! `stack` — the stacked-layer method sandbox: contract types + the pure
//! argv/model/ref rules (PROV-SS-1/SS-2/SS-3) + the run-seam-side helpers
//! (layer manifest parsing, entrypoint derivation, the layer-digest sidecar).
//!
//! A method run is a [`MethodRunRequest`] naming a trimmed per-language BASE
//! rootfs and one per-method LAYER image. The layer image is a single squashfs
//! whose root carries `layer-manifest.json` (a JSON array of absolute mount
//! entries); this module turns that into bwrap argv with the exact order:
//!
//! ```text
//!   hardening prefix (REUSED verbatim from sandbox::build_bwrap_argv — one
//!     security implementation, never a second copy — INV-5 / TEST-02),
//!   one --ro-bind-try <layer>/<entry> <entry> per manifest entry, in order,
//!   the verified read-only /model bind (INV-4; always --ro-bind, never
//!     --bind — TEST-05),
//!   the extra mounts (/input RO, /output RW),
//!   SIGBENCH_MODE + OMP/OPENBLAS/MKL_NUM_THREADS overrides,
//!   then the shipped FIFO / seccomp / `--` / prlimit / bash tail.
//! ```
//!
//! Everything after the hardening prefix and before the first `--` is spliced
//! in at the ONE fixed seam: immediately after the shipped builder's final
//! `/proc`-file mask, so a stacked flag can never shadow a hardening flag and
//! a later hardening change cannot be applied to only one argv path.
//!
//! Contracts on the wire (`EnvRef`, `ModelMount`, [`MethodRunRequest`],
//! [`MethodRunResult`]) are `serde` + `schemars` so the OpenAPI regen
//! (PROV-SS-5, ITEM-5) and the TS api-client see the same shapes.
//!
//! # Invariants carried by this module
//!
//! - INV-1 (network): the run stays `--unshare-net` (the shipped flag is part
//!   of the reused prefix); the ONLY network surface of the node is the env
//!   fetch (ITEM-3), never a run.
//! - INV-3 (container contract): `/input` RO + `/output` RW arrive as extra
//!   mounts; `SIGBENCH_MODE` is set from [`MethodRunMode`] per X1;
//!   `--network none` is the sandbox's own `--unshare-net`.
//! - INV-4 (models read-only + verified): the model bind is emitted as
//!   `--ro-bind <host_path> /model` with no read-write mode in the builder
//!   API; [`verify_model_tree`] is the digest gate the run seam calls BEFORE
//!   the builder (mismatch → `MODEL_VERIFY_FAILED`, no spawn).
//! - INV-6 (both digests recorded): [`RUN_LAYER_ENV_DIGEST_FILE`] names the
//!   layer sidecar the run seam writes (ITEM-4), beside the shipped
//!   `env-digest` base sidecar.
//! - Data discipline (shipped INV-4 of the module): env ids and method names
//!   are DATA. The code carries no env-id / method-id literal; the two
//!   compiled registry PREFIXES (`ghcr.io/…` host shape, no scheme — the
//!   allowlist-guard convention) and the three structural layer-entry prefixes
//!   are the only domain-bearing strings here.

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ziee_core::AppError;

use super::env_id::is_valid_env_id;
use super::sandbox::build_bwrap_argv;
use super::settings::SandboxResourceLimits;
use super::types::{ExtraMount, HardeningCapabilities, MountMode, SandboxContext};

// ────────────────────────────── typed error codes ─────────────────────────────

/// A caller-supplied OCI reference whose host / repository prefix is outside
/// the compiled txr registries ([`TXR_BASE_REGISTRY_PREFIX`] /
/// [`TXR_LAYER_REGISTRY_PREFIX`]), or whose repository component is not a
/// valid env id (TEST-03 / TEST-14).
pub const ENV_REF_HOST_UNALLOWED_CODE: &str = "ENV_REF_HOST_UNALLOWED";

/// A `layer-manifest.json` mount entry that is not an absolute `..`-free path
/// under `/usr/local`, `/opt` or `/code` (DEC-14, TEST-03). Refused before any
/// bind is built — never a bind of an unvalidated path.
pub const ENV_LAYER_ENTRY_INVALID_CODE: &str = "ENV_LAYER_ENTRY_INVALID";

/// The reusable model tree's computed sha256 does not equal the digest the
/// caller declared in [`ModelMount::tree_sha256`] (DEC-7, TEST-04). Raised
/// before any child spawn.
pub const MODEL_VERIFY_FAILED_CODE: &str = "MODEL_VERIFY_FAILED";

/// The model tree could not be read while computing its digest (an I/O error,
/// distinct from a digest MISMATCH — the caller sees the failing path, the
/// run is refused the same way).
pub const MODEL_TREE_READ_FAILED_CODE: &str = "MODEL_TREE_READ_FAILED";

/// The verified model's host path cannot be represented as a bwrap argument
/// (non-UTF-8). Refused before any bind: [`verify_model_tree`] hashes the REAL
/// directory, so a lossy string would bind a DIFFERENT host path than the one
/// whose bytes were verified — INV-4's "digest-verified before the bind" would
/// be mechanically false. Mirrors the base/layer [`ROOTFS_PATH_INVALID`] guard
/// of the shipped spawn path; the extra-mount host paths keep the shipped
/// builder's lossy `display()` (server-constructed ASCII staging paths).
pub const MODEL_PATH_INVALID_CODE: &str = "MODEL_PATH_INVALID";

/// The stacked splice point could not be located in the shipped hardening
/// prefix — the prefix changed shape in a way the seam probe does not
/// recognize (internal safety code; a wrong splice is a security bug).
const SPLICE_ANCHOR_MISSING_CODE: &str = "STACKED_AV_SPLICE_ANCHOR_MISSING";

// ────────────────────────────── compiled constants ────────────────────────────

/// The registry prefix of the per-language BASE rootfs images. Spelled without
/// a scheme exactly like the shipped `DEFAULT_REGISTRY`, and the host
/// (`ghcr.io`) is already on `scripts/network-allowlist.txt` (DEC-11), so the
/// allowlist guard stays green: no new outbound host enters the source.
pub const TXR_BASE_REGISTRY_PREFIX: &str = "ghcr.io/tinnlab/txresbench-env";

/// The registry prefix of the per-method LAYER images (PROV-method-env-images-2
/// pins this namespace; reconciled at PROV-SS-1/SS-2).
pub const TXR_LAYER_REGISTRY_PREFIX: &str = "ghcr.io/tinnlab/txr-method-env-layers";

/// The structural mount prefixes a layer entry may name (DEC-14). A layer
/// never binds `/usr` or `/opt` as a whole-dir shadow; entries are the
/// narrowly-scoped paths a layer is allowed to overlay.
pub(crate) const ALLOWED_LAYER_ENTRY_PREFIXES: &[&str] = &["/usr/local", "/opt", "/code"];

/// The fixed in-sandbox destination of the verified model bind (PROV-SS-3).
/// The builder has no read-write model mode: the destination is a constant so
/// a caller cannot bind a verified model anywhere writable-looking by accident.
pub const MODEL_SANDBOX_PATH: &str = "/model";

/// The run-scoped layer-digest sidecar, written beside the shipped
/// `env-digest` (base) by the run seam (ITEM-4); PROV-SS-1/INV-6.
pub const RUN_LAYER_ENV_DIGEST_FILE: &str = "layer-env-digest";

// ────────────────────────────── request/result types ──────────────────────────

/// Reference to one sandboxed artifact (base rootfs or method layer).
///
/// `digest` is the 64-hex sha256 of the artifact's single squashfs layer, taken
/// from the caller's catalogue record — verification is always against THIS
/// value, never against a moving tag (DEC-3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EnvRef {
    /// Full OCI reference, e.g. `<prefix>/<env_id>[:<tag>][@sha256:<hex>]`
    /// (prefixes from [`TXR_BASE_REGISTRY_PREFIX`] /
    /// [`TXR_LAYER_REGISTRY_PREFIX`]; enforced by [`validate_oci_ref`]).
    pub oci_ref: String,
    /// The pinned 64-hex sha256 of the squashfs layer the bytes are verified
    /// against.
    pub digest: String,
    /// Optional tag; resolved only when the reference carries no `@digest`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// What one stacked run does (DEC-5). Maps to the container contract's
/// mode field (X1): unset = one fit+predict call, `fit` / `predict`. The
/// sandbox emits it under BOTH spellings, `SIGBENCH_MODE` (X1-era name) and
/// `TXRESBENCH_MODE` (the 2.0 SDK's name — see TEST-05 / DRIFT-1 ITEM-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MethodRunMode {
    /// Single call: fit on the bundle, predict the same patients (X1's unset
    /// mode).
    FitPredict,
    /// `SIGBENCH_MODE`/`TXRESBENCH_MODE=fit`; the derived `/model` is
    /// written to `model_out_dir`.
    FitOnly,
    /// `SIGBENCH_MODE`/`TXRESBENCH_MODE=predict` on an already-trained,
    /// verified model bound read-only at `/model` (INV-4).
    ReuseModel,
}

impl MethodRunMode {
    /// The mode-field value for this mode, or `None` for [`FitPredict`]
    /// (X1: unset = single fit+predict call). The builder emits it under
    /// both `SIGBENCH_MODE` and `TXRESBENCH_MODE`.
    pub fn sigbench_mode(&self) -> Option<&'static str> {
        match self {
            MethodRunMode::FitPredict => None,
            MethodRunMode::FitOnly => Some("fit"),
            MethodRunMode::ReuseModel => Some("predict"),
        }
    }
}

/// A saved model dir the reuse run binds READ-ONLY at `/model` after
/// verification (PROV-SS-3, DEC-7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelMount {
    /// Host path of the saved model directory (the model store's artifact dir).
    pub host_path: PathBuf,
    /// The `tree_sha256` digest recorded at save time; the run seam recomputes
    /// it and refuses the bind on mismatch.
    pub tree_sha256: String,
}

/// One method run in its own stacked sandbox (PROV-SS-1).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MethodRunRequest {
    /// The trimmed per-language base rootfs (DEC-13: always caller-named).
    pub base: EnvRef,
    /// The per-method layer image carrying `/code` + extra mount entries.
    pub layer: EnvRef,
    /// Fit+predict / fit-only / reuse-model (DEC-5).
    pub mode: MethodRunMode,
    /// Host dir of the contract-shaped input bundle (bound RO at `/input`).
    pub bundle_dir: PathBuf,
    /// Host dir where `/output` is written (under the staging tree — DEC-6).
    pub outputs_dir: PathBuf,
    /// Verified model for a reuse run; `None` in fit modes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelMount>,
    /// Host dir the fit's `/model` is written to (under the staging tree —
    /// DEC-6); required for `FitOnly`/`FitPredict`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_out_dir: Option<PathBuf>,
    /// Per-run CPU cap: `OMP/OPENBLAS/MKL_NUM_THREADS` are set to this value
    /// (after the prefix's `1` defaults — last-wins, TEST-05).
    pub n_cpu: u32,
    /// Optional wall-clock timeout override (seconds); the run seam clamps it
    /// to the admin cap exactly like `clamp_timeout`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

/// Outcome of one stacked run (PROV-SS-1). `exit_code` etc. mirror the shipped
/// `SandboxRunResult`; the digests + model facts are the method-run extras
/// (INV-6).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MethodRunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// The base rootfs digest recorded in the run workspace.
    pub base_env_digest: String,
    /// The method-layer digest recorded in the run workspace.
    pub layer_env_digest: String,
    /// The model digest check ran and passed (`ReuseModel` only).
    pub model_verified: bool,
    /// `tree_sha256` of the fit's `/model` (a trained-model dir), when a
    /// `model_out_dir` was given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_out_digest: Option<String>,
}

// ────────────────────────────── OCI reference grammar ─────────────────────────

/// Parsed, validated OCI reference (result of [`validate_oci_ref`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OciRefParts {
    /// The matched compiled registry prefix (no scheme).
    pub registry_base: String,
    /// The env-id repository component (single `is_valid_env_id` component).
    pub repo: String,
    /// The `:tag` suffix, when present.
    pub tag: Option<String>,
    /// The `@sha256:` digest INNER component (64-hex, prefix stripped).
    pub digest: Option<String>,
}

/// Whether `s` is a 64-char lowercase hex string — the pinned-digest shape
/// used across the node (`EnvRef::digest`, OCI `sha256:` refs).
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether `tag` matches the OCI distribution tag grammar
/// (`[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`).
pub fn is_valid_oci_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 128
        && tag.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_alphanumeric() || b == b'_' || (i > 0 && (b == b'.' || b == b'-'))
        })
}

/// Validate + parse an OCI reference against the compiled txr registries.
///
/// Accepted shape: `<prefix>/<env_id>[:<tag>][@sha256:<64hex>]` where `<prefix>`
/// is [`TXR_BASE_REGISTRY_PREFIX`] or [`TXR_LAYER_REGISTRY_PREFIX`] and
/// `<env_id>` is one `is_valid_env_id` component. Every other host, prefix,
/// nested repo path, malformed tag/digest or empty component is refused with
/// [`ENV_REF_HOST_UNALLOWED_CODE`] (TEST-03/TEST-14) — this is a RELEASE-TIME
/// boundary: the pinned digests are verified by the caller, but a ref outside
/// the compiled namespace must never even be parsed for a pull.
pub fn validate_oci_ref(oci_ref: &str) -> Result<OciRefParts, AppError> {
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
        digest = Some(normalize_digest_part(d)?);
        name = n;
    }
    let mut tag: Option<String> = None;
    if let Some((n, t)) = name.rsplit_once(':') {
        if !t.contains('/') {
            // A port on an unallowed host would contain a '/' after the host
            // part; documented hosts carry none, and the prefix match below
            // refuses them regardless.
            tag = Some(t.to_string());
            name = n;
        }
    }
    if let Some(t) = tag.as_deref() {
        if !is_valid_oci_tag(t) {
            return refused("the tag does not match the OCI tag grammar");
        }
    }

    for prefix in [TXR_BASE_REGISTRY_PREFIX, TXR_LAYER_REGISTRY_PREFIX] {
        let Some(rest) = name.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')) else {
            continue;
        };
        if rest.contains('/') {
            return refused("nested repository paths are not part of the txr env registries");
        }
        if !is_valid_env_id(rest) {
            return refused("the repository component is not a valid env id");
        }
        return Ok(OciRefParts {
            registry_base: prefix.to_string(),
            repo: rest.to_string(),
            tag,
            digest,
        });
    }
    refused("host/prefix not in the compiled txr registries")
}

fn normalize_digest_part(d: &str) -> Result<String, AppError> {
    let hex = d.strip_prefix("sha256:").unwrap_or("");
    if !is_sha256_hex(hex) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_REF_HOST_UNALLOWED_CODE,
            format!("the reference digest {d:?} is not sha256:<64 lowercase hex>"),
        ));
    }
    Ok(hex.to_string())
}

// ────────────────────────────── layer entry grammar ───────────────────────────

/// Validate ONE `layer-manifest.json` mount entry (DEC-14, TEST-03):
/// absolute, no empty / `.` / `..` components, and under `/usr/local`, `/opt`
/// or `/code`. Refused with [`ENV_LAYER_ENTRY_INVALID_CODE`] — an unvalidated
/// path must never reach a bind (a `..`-laden entry would let the bind source
/// escape the layer dir).
pub fn validate_layer_entry(entry: &str) -> Result<(), AppError> {
    let invalid = |why: &str| {
        Err(AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_LAYER_ENTRY_INVALID_CODE,
            format!("layer mount entry {entry:?} is refused: {why}"),
        ))
    };
    if !entry.starts_with('/') {
        return invalid("an entry must be an absolute path");
    }
    for comp in entry[1..].split('/') {
        if comp.is_empty() || comp == "." || comp == ".." {
            return invalid("components must be non-empty and free of . / ..");
        }
    }
    let in_prefix = ALLOWED_LAYER_ENTRY_PREFIXES.iter().any(|p| {
        entry == *p
            || entry
                .strip_prefix(p)
                .is_some_and(|rest| rest.starts_with('/'))
    });
    if !in_prefix {
        return invalid("an entry must be under /usr/local, /opt or /code");
    }
    Ok(())
}

/// Validate the whole entry list (same refusal as [`validate_layer_entry`],
/// stopped at the first offender).
pub fn validate_layer_entries(entries: &[String]) -> Result<(), AppError> {
    for e in entries {
        validate_layer_entry(e)?;
    }
    Ok(())
}

// ────────────────────────────── the stacked argv ─────────────────────────────

/// Build the bwrap argv of a stacked method run (PROV-SS-2).
///
/// The hardening prefix is the SHIPPED builder's output, called with the same
/// caps/ctx/base-dir/identity/limits and NO extra mounts (the method mounts are
/// spliced in AFTER the prefix but BEFORE the tail); the splice happens at the
/// one fixed seam (right after the shipped `/proc`-file mask block) so:
///
/// - every hardening flag stays byte-identical to a plain run (TEST-02),
/// - layers / model / mounts / env can never shadow a hardening flag,
/// - the pinned order is `hardening, layers, model, mounts, env` — all before
///   the first `--` terminator (TEST-01).
///
/// `layer_entries` are validated here (typed refusal, [`ENV_LAYER_ENTRY_INVALID_CODE`]),
/// exactly like TEST-15's "nothing bound, typed error" contract.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_stacked_bwrap_argv(
    caps: &HardeningCapabilities,
    ctx: &SandboxContext,
    base_dir: &Path,
    layer_dir: &Path,
    layer_entries: &[String],
    user_cmd: &str,
    passwd_path: &Path,
    group_path: &Path,
    mask_path: &Path,
    seccomp_fd: Option<i32>,
    limits: &SandboxResourceLimits,
    extra_mounts: &[ExtraMount],
    model_mount: Option<&ExtraMount>,
    n_cpu: u32,
    progress_fifo_src: Option<&str>,
    sigbench_mode: Option<&str>,
) -> Result<Vec<String>, AppError> {
    // Refuse BEFORE any flag is emitted: a bind built from an unvalidated entry
    // is a path-escape vector, never a `--ro-bind-try` that happens to work.
    validate_layer_entries(layer_entries)?;

    // Mirror spawn_bwrap_child's non-UTF8 refusal (a dropped path would make
    // `<base>/usr` == `/usr` and bind the HOST /usr — see sandbox.rs).
    if base_dir.to_str().is_none() || layer_dir.to_str().is_none() {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ROOTFS_PATH_INVALID",
            "a stacked base/layer mount path is not valid UTF-8; refusing to build the sandbox",
        ));
    }
    // The model is the ONLY bind with a verification promise (INV-4: the bytes
    // are digest-verified BEFORE the bind), so its host path must bind
    // byte-exactly — a lossy `display()` conversion could point the `--ro-bind`
    // at a DIFFERENT host dir than the one tree_sha256 hashed. Non-UTF-8 model
    // paths cannot arrive over the JSON wire (UTF-8), so this guards the
    // in-process caller.
    if let Some(model) = model_mount {
        if model.host_path.to_str().is_none() {
            return Err(AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                MODEL_PATH_INVALID_CODE,
                format!(
                    "the model host path {} is not valid UTF-8; the digest-verified bytes \
                     could not be bound under that exact name",
                    model.host_path.display()
                ),
            ));
        }
    }

    let mut argv = build_bwrap_argv(
        caps,
        ctx,
        base_dir,
        user_cmd,
        passwd_path,
        group_path,
        mask_path,
        seccomp_fd,
        limits,
        &[],
        progress_fifo_src,
    );

    let at = after_proc_mask_block(&argv)?;

    let mut block: Vec<String> = Vec::with_capacity(
        layer_entries.len() * 3
            + extra_mounts.len() * 3
            + 3
            + usize::from(model_mount.is_some()) * 3
            + usize::from(sigbench_mode.is_some()) * 3,
    );

    // Layers, in manifest order. `--ro-bind-try`: an entry the layer does not
    // actually carry MUST NOT be an error here — the base content showing
    // through is the safe direction (a missing entry never shadows the base).
    for entry in layer_entries {
        block.push("--ro-bind-try".into());
        let rel = entry.strip_prefix('/').unwrap_or(entry);
        block.push(format!("{}/{}", layer_dir.display(), rel));
        block.push(entry.clone());
    }

    // Model: ALWAYS read-only at the fixed /model dest. The mount's own
    // mode/sandbox_path fields are deliberately ignored — the builder API has
    // no read-write model mode (TEST-05); verification happened BEFORE this
    // call (verify_model_tree, MODEL_VERIFY_FAILED).
    if let Some(model) = model_mount {
        block.push("--ro-bind".into());
        block.push(model.host_path.display().to_string());
        block.push(MODEL_SANDBOX_PATH.into());
    }

    // Method /input (RO) + /output (RW), same mapping as the shipped builder
    // (ReadOnly → --ro-bind-try, ReadWrite → --bind) — deliberately mirrored
    // here, not passed through: the mounts must come AFTER the layers/model in
    // argv order (TEST-01) so a layer can never overlay the run's own dirs.
    for m in extra_mounts {
        let host = m.host_path.display().to_string();
        match m.mode {
            MountMode::ReadOnly => {
                block.push("--ro-bind-try".into());
                block.push(host);
                block.push(m.sandbox_path.clone());
            }
            MountMode::ReadWrite => {
                block.push("--bind".into());
                block.push(host);
                block.push(m.sandbox_path.clone());
            }
        }
    }

    if let Some(mode) = sigbench_mode {
        // The X1 contract field under BOTH spellings: `SIGBENCH_MODE` (the
        // contract X1-era name the app's own stacked fixtures read) and
        // `TXRESBENCH_MODE` (the name the shipped 2.0 SDK's txrmethod /
        // TxrMethod reads — package/base-images; under the old name a real
        // wrapper's `mode()` returns "" → it runs the predict branch during
        // fit and fails on the absent /model). One value, two spellings —
        // the ITEM-3 live real-data run found the gap; the epic-level
        // naming question stands (DRIFT-1 ITEM-3).
        for var in ["SIGBENCH_MODE", "TXRESBENCH_MODE"] {
            block.push("--setenv".into());
            block.push(var.into());
            block.push(mode.to_string());
        }
    }
    // Thread overrides AFTER the prefix's `1` defaults (last-wins, TEST-05).
    // `n_cpu <= 1` emits nothing (the prefix default is `1`), which keeps the
    // builder byte-identical to the shipped argv when nothing is stacked
    // (TEST-02). A `0` would be OpenMP's "auto" — clamp to 1.
    let threads = n_cpu.max(1);
    if threads > 1 {
        let t = threads.to_string();
        for var in ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"] {
            block.push("--setenv".into());
            block.push(var.into());
            block.push(t.clone());
        }
    }

    argv.splice(at..at, block);
    Ok(argv)
}

/// The shipped builder may emit, immediately after the hardening prefix (with
/// the stacked builder's `&[]` extra mounts), only these tokens: the optional
/// progress-FIFO bind (`--bind`), the optional seccomp arg (`--seccomp`), or
/// the first `--` terminator. Anything else there is a NEW hardening flag or a
/// moved emission — the splice must refuse rather than sit beside it.
const POST_HARDENING_TOKENS: &[&str] = &["--bind", "--seccomp", "--"];

/// Index just past the shipped builder's consecutive `/proc`-file mask RUN —
/// the fixed seam between the hardening prefix and the FIFO/seccomp/terminator
/// tail. With the stacked builder's `&[]` extra mounts this is exactly the
/// position where the shipped builder itself would emit its extra mounts
/// (TEST-02's strongest form, Case A).
///
/// The probe is on the masking flag RUN, not on a positional constant: it
/// consumes the WHOLE run of `--ro-bind /dev/null /proc/…` triples (then
/// requires a known post-hardening token), so a shipped-side change that adds
/// another masked path — or a new flag after the masks — ERRORS with the typed
/// [`SPLICE_ANCHOR_MISSING_CODE`] instead of splicing at a wrong offset. A
/// wrong splice is a security bug, never a silent one.
fn after_proc_mask_block(argv: &[String]) -> Result<usize, AppError> {
    let anchor_missing = |why: &str| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            SPLICE_ANCHOR_MISSING_CODE,
            format!(
                "the shipped hardening prefix changed shape ({why}); refusing to splice the \
                 stacked argv at an unknown offset"
            ),
        )
    };

    let mut i = 0usize;
    let mut at: Option<usize> = None;
    while i + 3 <= argv.len() {
        let w = &argv[i..i + 3];
        if w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2].starts_with("/proc/") {
            at = Some(i + 3);
            i += 3;
            continue;
        }
        if at.is_some() {
            break;
        }
        i += 1;
    }

    let at = at.ok_or_else(|| anchor_missing("no /proc-file mask run found"))?;
    let next = argv.get(at).map(String::as_str).unwrap_or("<end of argv>");
    if !POST_HARDENING_TOKENS.contains(&next) {
        return Err(anchor_missing(&format!(
            "the token after the /proc-file mask run is {next:?}"
        )));
    }
    Ok(at)
}

// ────────────────────────────── model tree digest ─────────────────────────────

/// Deterministic directory-tree digest (DEC-7, PROV-SS-3): sha256 over the
/// stream of, for every REGULAR file under `dir` sorted by relative path
/// (bytes, `/` separators; subdirs recursed in sorted order),
/// `<relpath>\0` + the lowercase hex sha256 of the file bytes + `\n`.
///
/// Only regular files participate: symlinks, sockets, fifos and devices are
/// skipped (a symlink's target resolves inside the sandbox anyway, and the
/// model-store writes plain files). Deterministic on the same tree — the
/// digest is portable between the model-store's save and the reuse run's
/// verification on the same machine.
pub fn tree_sha256(dir: &Path) -> Result<String, AppError> {
    let mut files: Vec<(Vec<u8>, PathBuf)> = Vec::new();
    collect_regular_files(dir, dir, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut stream = Sha256::new();
    for (rel, path) in &files {
        stream.update(rel);
        stream.update([0u8]);
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                MODEL_TREE_READ_FAILED_CODE,
                format!("read {}: {e}", path.display()),
            )
        })?;
        stream.update(hex::encode(Sha256::digest(&bytes)).as_bytes());
        stream.update([b'\n']);
    }
    Ok(hex::encode(stream.finalize()))
}

/// The PG-style verification gate (TEST-04): recompute the tree digest and
/// refuse with [`MODEL_VERIFY_FAILED_CODE`] unless it equals the digest the
/// caller declared. Called by the run seam BEFORE the argv is built — a
/// mismatch never reaches bwrap.
pub fn verify_model_tree(dir: &Path, expected: &str) -> Result<(), AppError> {
    let actual = tree_sha256(dir)?;
    if actual != expected {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            MODEL_VERIFY_FAILED_CODE,
            format!(
                "model tree digest mismatch for {}: expected {}, computed {}",
                dir.display(),
                expected,
                actual
            ),
        ));
    }
    Ok(())
}

fn collect_regular_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(Vec<u8>, PathBuf)>,
) -> Result<(), AppError> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| tree_read_err("list", dir, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| tree_read_err("list", dir, e))?;
    // Sorted directory order keeps the traversal deterministic independent of
    // the filesystem's readdir order.
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| tree_read_err("stat", dir, e))?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            collect_regular_files(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path.strip_prefix(root).map_err(|e| {
                AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    MODEL_TREE_READ_FAILED_CODE,
                    format!("relative path of {}: {e}", path.display()),
                )
            })?;
            out.push((path_bytes(rel), path));
        }
    }
    Ok(())
}

fn tree_read_err(what: &str, dir: &Path, e: std::io::Error) -> AppError {
    AppError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        MODEL_TREE_READ_FAILED_CODE,
        format!("{what} {}: {e}", dir.display()),
    )
}

/// Relative path as raw bytes with `/` separators (the digest stream's path
/// form; bytes on Unix, lossy on other targets).
fn path_bytes(p: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        p.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        p.to_string_lossy().into_owned().into_bytes()
    }
}

// ────────────────────── layer manifest + entry command (runtime) ───────────────

/// The layer-root file listing the layer's bind entries (PROV-SS-2, DEC-14).
/// Produced by the `method-env-images` publisher — this node only READS it; the
/// same file is what ITEM-7's fixture layers carry.
const LAYER_MANIFEST_FILE: &str = "layer-manifest.json";

/// The layer's root `layer-manifest.json` is missing, unreadable, or not a
/// JSON array of strings (PROV-SS-2: "a malformed manifest is
/// `ENV_UNKNOWN`-family failure, never a bind of an unvalidated path"). Plan
/// text names a FAMILY, not a code — the shipped module carries no
/// `ENV_UNKNOWN` code (the engine's catalogue-side per-method `ENV_UNKNOWN`
/// means "no env entry for this method id" and would be overloaded by a
/// second meaning), so the manifest condition gets its own typed code.
pub const ENV_LAYER_MANIFEST_INVALID_CODE: &str = "ENV_LAYER_MANIFEST_INVALID";

/// The layer names no runnable entrypoint: no parseable `method.json`
/// language AND no `/code/run.R`, `/code/run.py` or `/code/run.sh` in the
/// mounted layer (or the declared language's script is absent). The run is
/// refused before any spawn — a layer with no wrapper is publisher data the
/// caller must fix, never a host-filesystem run.
pub const METHOD_ENTRYPOINT_MISSING_CODE: &str = "METHOD_ENTRYPOINT_MISSING";

/// Parse + validate the layer's root `layer-manifest.json` (PROV-SS-2,
/// TEST-15): a JSON array of mount-entry strings, each validated by
/// [`validate_layer_entry`] BEFORE any bind is built. A missing/unreadable/
/// non-array manifest is [`ENV_LAYER_MANIFEST_INVALID_CODE`]; an offending
/// entry is [`ENV_LAYER_ENTRY_INVALID_CODE`] — either way nothing is bound.
/// `layer_mount` is the host-side mount dir [`super::method_env`]
/// returned (the dir whose `usr/` the base binds).
pub fn layer_entries_from_manifest(layer_mount: &Path) -> Result<Vec<String>, AppError> {
    let path = layer_mount.join(LAYER_MANIFEST_FILE);
    let bytes = std::fs::read(&path).map_err(|e| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_LAYER_MANIFEST_INVALID_CODE,
            format!("read {}: {e}", path.display()),
        )
    })?;
    let entries: Vec<String> = serde_json::from_slice(&bytes).map_err(|e| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            ENV_LAYER_MANIFEST_INVALID_CODE,
            format!(
                "{} is not a JSON array of mount-entry strings: {e}",
                path.display()
            ),
        )
    })?;
    validate_layer_entries(&entries)?;
    Ok(entries)
}

/// The DEC-14 half that needs the MOUNTED base: the parent directory of every
/// layer entry must exist in the base rootfs, so the per-entry overlay always
/// lands on an existing base path (a layer entry may overlay, never invent —
/// the "stacked" failure mode DEC-14 exists to prevent). Refused with the same
/// typed [`ENV_LAYER_ENTRY_INVALID_CODE`] before any bind. The grammar half
/// (absolute, no `.`/`..`, allowed prefixes) lives in [`validate_layer_entry`];
/// this is the filesystem half, asserted by the ITEM-4 run seam where the base
/// is mounted. The `/` parent of `/opt` / `/code` is the mount root itself and
/// always exists.
pub fn assert_entry_parents_exist(base_dir: &Path, entries: &[String]) -> Result<(), AppError> {
    for entry in entries {
        let parent = Path::new(entry).parent().unwrap_or(Path::new("/"));
        if parent == Path::new("/") {
            continue;
        }
        let rel = parent.strip_prefix("/").map_err(|_| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                ENV_LAYER_ENTRY_INVALID_CODE,
                format!("the parent of layer entry {entry:?} is not absolute"),
            )
        })?;
        let probe = base_dir.join(rel);
        if !probe.is_dir() {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                ENV_LAYER_ENTRY_INVALID_CODE,
                format!(
                    "the parent {} of layer entry {entry:?} does not exist in the base \
                     rootfs at {} (DEC-14: an entry may overlay an existing base path, \
                     never invent one)",
                    parent.display(),
                    base_dir.display()
                ),
            ));
        }
    }
    Ok(())
}

/// Derive the in-sandbox shell command that runs the method wrapper
/// (PROV-SS-1's `user_cmd`). The wrapper lives in the layer at `/code`; the
/// invocation follows the driver convention
/// (`driver/run.py`: `Rscript run.R` when `language == "R"`, else the Python
/// interpreter). In this app the interpreter is whatever the per-language base
/// image installed on its `PATH` (`--clearenv` + the prefix's `PATH`), so the
/// command is `Rscript /code/run.R` / `python3 /code/run.py`.
///
/// Resolution order (each step is contract data, never a host-path notion):
/// 1. `<layer>/code/method.json` `language` — the publisher's declaration:
///    its named script is THE wrapper; a declared script that is absent is a
///    broken layer (loud refusal, not a silent switch to a different wrapper);
/// 2. presence order, for a layer WITHOUT a parseable `method.json` (the
///    minimal shell layers of this node's integration fixtures — a
///    `/code/run.sh` wrapper is the fixture's own convention, TEST-08):
///    `run.R`, `run.py`, then `run.sh`;
/// 3. [`METHOD_ENTRYPOINT_MISSING_CODE`] — nothing runnable in the layer.
pub fn method_entry_command(layer_mount: &Path) -> Result<String, AppError> {
    let code = layer_mount.join("code");
    let language = std::fs::read(code.join("method.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("language").and_then(|l| l.as_str()).map(str::to_string));

    if let Some(lang) = language {
        let lower = lang.to_ascii_lowercase();
        let named = if lower.contains("python") {
            Some(("python3", "run.py"))
        } else if lower.starts_with('r') {
            Some(("Rscript", "run.R"))
        } else {
            None
        };
        if let Some((exe, script)) = named {
            if code.join(script).is_file() {
                return Ok(format!("{exe} /code/{script}"));
            }
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                METHOD_ENTRYPOINT_MISSING_CODE,
                format!(
                    "the layer's method.json declares language {lang:?}, but the layer \
                     carries no /code/{script}; nothing to run"
                ),
            ));
        }
    }

    for (exe, script) in [("Rscript", "run.R"), ("python3", "run.py"), ("bash", "run.sh")] {
        if code.join(script).is_file() {
            return Ok(format!("{exe} /code/{script}"));
        }
    }
    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        METHOD_ENTRYPOINT_MISSING_CODE,
        format!(
            "the layer at {} carries no /code/run.R, /code/run.py or /code/run.sh (and no \
             parseable method.json language); nothing to run",
            layer_mount.display()
        ),
    ))
}

/// Write `<workspace>/[`RUN_LAYER_ENV_DIGEST_FILE`]` — the method-LAYER digest
/// sidecar, the sibling of the shipped `env-digest` (base) — INV-6.
///
/// Mirrors [`super::env_image::write_run_env_digest`]'s semantics exactly: the
/// sidecar is written BEFORE the child runs and says what the PLATFORM mounted;
/// `None` (a legacy pre-mounted-dir seam carries no content identity) REMOVES a
/// stale sidecar a previous attempt left, so a retry never records the earlier
/// attempt's layer. Best-effort by design (a failure is logged, never fails the
/// run — the result then reports no layer digest honestly).
pub fn write_run_layer_digest(workspace_root: &Path, digest: Option<&str>) {
    let path = workspace_root.join(RUN_LAYER_ENV_DIGEST_FILE);
    let Some(hex) = digest else {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(
                path = %path.display(),
                error = %e,
                "could not clear a stale layer-env-digest sidecar; a retry of this job could \
                 record the previous attempt's layer"
            ),
        }
        return;
    };
    if let Err(e) = std::fs::write(&path, hex) {
        tracing::warn!(
            path = %path.display(),
            error = %e,
            "could not record this run's layer digest; the run will record no layer digest"
        );
    }
}

/// Read back the layer digest [`write_run_layer_digest`] recorded for the run
/// rooted at `workspace_root`. `None` when the seam had no content identity
/// (legacy seam), or the file is unreadable/malformed — the same honesty rule
/// as [`super::env_image::read_run_env_digest`].
pub fn read_run_layer_digest(workspace_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(workspace_root.join(RUN_LAYER_ENV_DIGEST_FILE)).ok()?;
    let hex = raw.trim();
    is_sha256_hex(hex).then(|| hex.to_string())
}

// ────────────────────────────── Unit tests ────────────────────────────────────

// Lifecycle ids: stack TEST-01..TEST-05 (TESTS.md). Tests BELOW the shipped
// `sandbox.rs` naming discipline: pure argv assertions + the tree digest on a
// temp fixture (no bwrap, no network, no host tools).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::sandbox::PROGRESS_FIFO_SANDBOX_PATH;
    use crate::modules::sandbox::types::{CgroupMode, PidNsMode, SeccompMode};
    use uuid::Uuid;

    fn caps() -> HardeningCapabilities {
        HardeningCapabilities {
            bwrap_path: PathBuf::from("/usr/bin/bwrap"),
            pid_namespace: PidNsMode::Strict,
            cgroup: CgroupMode::None,
            seccomp: SeccompMode::NotLinked,
        }
    }

    fn ctx() -> SandboxContext {
        SandboxContext {
            job_id: Uuid::nil(),
            workspace: PathBuf::from("/data/sandboxes/job"),
        }
    }

    fn limits() -> SandboxResourceLimits {
        SandboxResourceLimits::defaults()
    }

    fn pos(a: &[String], needle: &str) -> Option<usize> {
        a.iter().position(|s| s == needle)
    }

    /// LAST occurrence — the prefix always sets the thread vars to `1`, so the
    /// override under test is the trailing one (last-wins).
    fn rpos(a: &[String], needle: &str) -> Option<usize> {
        a.iter().rposition(|s| s == needle)
    }

    fn stacked(
        entries: &[&str],
        extra_mounts: &[ExtraMount],
        model: Option<&ExtraMount>,
        n_cpu: u32,
        mode: Option<&str>,
    ) -> Vec<String> {
        stacked_fifo(entries, extra_mounts, model, n_cpu, mode, None)
    }

    fn stacked_fifo(
        entries: &[&str],
        extra_mounts: &[ExtraMount],
        model: Option<&ExtraMount>,
        n_cpu: u32,
        mode: Option<&str>,
        fifo: Option<&str>,
    ) -> Vec<String> {
        stacked_full(entries, extra_mounts, model, n_cpu, mode, fifo, None)
    }

    /// Full-parameter stacked builder for the prefix-shape matrix (fifo ×
    /// seccomp) — every shipped prefix shape must stay byte-identical in the
    /// shared segment.
    fn stacked_full(
        entries: &[&str],
        extra_mounts: &[ExtraMount],
        model: Option<&ExtraMount>,
        n_cpu: u32,
        mode: Option<&str>,
        fifo: Option<&str>,
        seccomp_fd: Option<i32>,
    ) -> Vec<String> {
        let entries: Vec<String> = entries.iter().map(|s| s.to_string()).collect();
        build_stacked_bwrap_argv(
            &caps(),
            &ctx(),
            Path::new("/mnt/base"),
            Path::new("/mnt/layer"),
            &entries,
            "run.sh",
            Path::new("/id/passwd"),
            Path::new("/id/group"),
            Path::new("/id/empty"),
            seccomp_fd,
            &limits(),
            extra_mounts,
            model,
            n_cpu,
            fifo,
            mode,
        )
        .expect("stacked argv builds from valid entries")
    }

    /// The shipped builder with the fixture identity/limits and NO extra mounts
    /// (the stacked builder consumes them itself) — the prefix/tail source the
    /// stacked argv is compared against.
    fn plain_argv(seccomp_fd: Option<i32>, fifo: Option<&str>) -> Vec<String> {
        build_bwrap_argv(
            &caps(),
            &ctx(),
            Path::new("/mnt/base"),
            "run.sh",
            Path::new("/id/passwd"),
            Path::new("/id/group"),
            Path::new("/id/empty"),
            seccomp_fd,
            &limits(),
            &[],
            fifo,
        )
    }

    fn model_mount() -> ExtraMount {
        ExtraMount {
            host_path: PathBuf::from("/host/model"),
            sandbox_path: "/ignored".into(), // ignored: dest is fixed at /model
            mode: MountMode::ReadWrite,      // ignored: model is always RO
        }
    }

    fn count(a: &[String], needle: &str) -> usize {
        a.iter().filter(|s| *s == needle).count()
    }

    /// Hardening flags the shipped prefix emits at most once each. The stacked
    /// argv must carry them EXACTLY as often as the shipped argv — a second
    /// occurrence would be a second, independently-maintained security
    /// implementation (TEST-02's "no second copy" proof).
    const LOCKED_HARDENING_FLAGS: &[&str] = &[
        "--clearenv",
        "--unshare-user",
        "--unshare-uts",
        "--unshare-ipc",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--unshare-pid",
        "--as-pid-1",
        "--new-session",
        "--die-with-parent",
        "--uid",
        "--gid",
        "--proc",
        "--tmpfs",
        "--dev",
        "--chdir",
    ];

    /// The `--ro-bind <src> /home/analyst/<dotfile>` mask triples of an argv —
    /// the (source, target) pairs. Derived from each argv rather than re-listed,
    /// so a dotfile the shipped builder newly masks shows up in BOTH paths.
    fn mask_triples(a: &[String]) -> Vec<(String, String)> {
        a.windows(3)
            .filter(|w| w[0] == "--ro-bind" && w[2].starts_with("/home/analyst/"))
            .map(|w| (w[1].clone(), w[2].clone()))
            .collect()
    }

    /// A fabricated `/proc`-file mask run of `n` triples — the shape the seam
    /// probe must consume in full.
    fn mask_run(n: usize) -> Vec<String> {
        let mut v = Vec::new();
        for i in 0..n {
            v.push("--ro-bind".into());
            v.push("/dev/null".into());
            v.push(format!("/proc/mask{i}"));
        }
        v
    }

    fn input_output_mounts() -> Vec<ExtraMount> {
        vec![
            ExtraMount {
                host_path: PathBuf::from("/host/input"),
                sandbox_path: "/input".into(),
                mode: MountMode::ReadOnly,
            },
            ExtraMount {
                host_path: PathBuf::from("/host/output"),
                sandbox_path: "/output".into(),
                mode: MountMode::ReadWrite,
            },
        ]
    }

    /// TEST-01: hardening prefix shape + the pinned splice order:
    /// hardening, layers, model, mounts, env — all before the first `--`.
    #[test]
    fn argv_pins_hardening_then_layers_then_model_then_mounts_then_env() {
        let model = ExtraMount {
            host_path: PathBuf::from("/host/model"),
            sandbox_path: "/somewhere-else".into(), // ignored: dest is fixed
            mode: MountMode::ReadWrite,             // ignored: model is always RO
        };
        let a = stacked(
            &["/code", "/opt/venv/lib/site-packages"],
            &input_output_mounts(),
            Some(&model),
            4,
            Some("fit"),
        );

        // Hardening prefix: shipped shape.
        assert_eq!(a[0], "--clearenv", "clearenv must be first");
        assert!(a.contains(&"--unshare-user".to_string()));
        let uid = pos(&a, "--uid").unwrap();
        assert_eq!(a[uid + 1], "1001");
        assert!(
            a.contains(&"--unshare-net".to_string()),
            "no network (INV-1)"
        );
        assert!(!a.contains(&"--share-net".to_string()));
        assert!(a.contains(&"--unshare-pid".to_string()), "strict pid-ns");
        assert!(a.contains(&"--proc".to_string()));
        assert!(
            a.contains(&"/etc/ssl/certs".to_string()),
            "certs-only /etc/ssl"
        );
        // Dotfile masks present (spot check).
        let dot = pos(&a, "/home/analyst/.gitconfig").expect("dotfile masked");
        assert_eq!(a[dot - 1], "/id/empty");
        // Two `--` terminators + prlimit + bash tail.
        let terms: Vec<usize> = a
            .iter()
            .enumerate()
            .filter(|(_, s)| *s == "--")
            .map(|(i, _)| i)
            .collect();
        assert!(
            terms.len() >= 2,
            "two -- terminators (before prlimit, before bash)"
        );
        let prlimit = pos(&a, "/usr/bin/prlimit").unwrap();
        assert!(
            terms[0] < prlimit,
            "first -- precedes prlimit (CVE-2024-32462)"
        );
        let bash = pos(&a, "/bin/bash").unwrap();
        assert_eq!(a[bash + 1], "-lc");
        assert_eq!(a[bash + 2], "run.sh");

        // Layer binds, in manifest order.
        let c = pos(&a, "/code").expect("/code entry bound");
        assert_eq!(a[c - 2], "--ro-bind-try");
        assert_eq!(a[c - 1], "/mnt/layer/code");
        let p = pos(&a, "/opt/venv/lib/site-packages").expect("second entry bound");
        assert_eq!(a[p - 2], "--ro-bind-try");
        assert_eq!(a[p - 1], "/mnt/layer/opt/venv/lib/site-packages");
        assert!(c < p, "layer entries keep manifest order");

        // Model: always --ro-bind at the fixed /model dest, mode/sandbox_path ignored.
        let m = pos(&a, MODEL_SANDBOX_PATH).expect("model bound at /model");
        assert_eq!(a[m - 2], "--ro-bind", "model is NEVER --bind (TEST-05)");
        assert_eq!(a[m - 1], "/host/model");
        assert!(
            !a.iter().any(|s| s == "/somewhere-else"),
            "model dest is fixed, not the mount's own"
        );

        // Extra mounts after the model.
        let in_p = pos(&a, "/input").unwrap();
        assert_eq!(a[in_p - 2], "--ro-bind-try");
        assert_eq!(a[in_p - 1], "/host/input");
        let out_p = pos(&a, "/output").unwrap();
        assert_eq!(a[out_p - 2], "--bind");
        assert_eq!(a[out_p - 1], "/host/output");
        assert!(m < in_p && in_p < out_p, "model before mounts");

        // Env after the mounts; the X1 mode field under BOTH spellings
        // (SIGBENCH_MODE = X1-era name, TXRESBENCH_MODE = the 2.0 SDK's name)
        // + n_cpu overrides. `rposition` picks the LAST occurrence — the
        // prefix's own `1` defaults precede.
        let env_p = pos(&a, "SIGBENCH_MODE").expect("mode env present");
        assert_eq!(a[env_p + 1], "fit");
        let env_t = pos(&a, "TXRESBENCH_MODE").expect("2.0 mode env present");
        assert_eq!(a[env_t + 1], "fit", "both spellings carry the mode");
        assert!(out_p < env_p, "env setenvs after the mounts");
        let omp = rpos(&a, "OMP_NUM_THREADS").expect("thread override present");
        assert_eq!(a[omp + 1], "4");
        let mkl = rpos(&a, "MKL_NUM_THREADS").expect("MKL override present");
        assert_eq!(a[mkl + 1], "4");
        // Last-wins: the override comes AFTER the prefix's "1" default.
        let default_pos = a
            .iter()
            .enumerate()
            .filter(|(_, s)| *s == "1")
            .map(|(i, _)| i)
            .max()
            .unwrap();
        assert!(
            default_pos < omp,
            "n_cpu override after the prefix 1-defaults"
        );

        // Everything before the first `--`.
        let first_term = pos(&a, "--").unwrap();
        assert!(c < first_term && m < first_term && in_p < first_term && env_p < first_term);
    }

    /// TEST-02 + the INV-5 design-fidelity proof: the builder REUSES the
    /// shipped hardening prefix — with nothing stacked it is byte-identical to
    /// `build_bwrap_argv`; with a real stack the shared prefix + tail are
    /// byte-identical for EVERY shipped prefix shape (fifo × seccomp); and no
    /// single-occurrence hardening flag appears a second time, so a later
    /// hardening change can never be silently applied to only one argv path.
    #[test]
    fn builder_reuses_shipped_prefix_byte_identically() {
        // Case A — nothing stacked: FULL byte-identity.
        let plain = build_bwrap_argv(
            &caps(),
            &ctx(),
            Path::new("/mnt/base"),
            "run.sh",
            Path::new("/id/passwd"),
            Path::new("/id/group"),
            Path::new("/id/empty"),
            None,
            &limits(),
            &input_output_mounts(),
            Some("/host/run/fifo"),
        );
        let stacked_v = build_stacked_bwrap_argv(
            &caps(),
            &ctx(),
            Path::new("/mnt/base"),
            Path::new("/mnt/layer"),
            &[],
            "run.sh",
            Path::new("/id/passwd"),
            Path::new("/id/group"),
            Path::new("/id/empty"),
            None,
            &limits(),
            &input_output_mounts(),
            None,
            1,
            Some("/host/run/fifo"),
            None,
        )
        .expect("empty stack builds");
        assert_eq!(
            stacked_v, plain,
            "a stack with nothing stacked must equal the shipped argv"
        );

        // Case B — a real stack: the shipped argv (with NO extra mounts, as the
        // builder consumes them) shares the prefix before the seam and the tail
        // after the splice; only the spliced block differs.
        let base_no_mounts = plain_argv(None, Some("/host/run/fifo"));
        let stacked_v = stacked_fifo(
            &["/code"],
            &input_output_mounts(),
            None,
            4,
            Some("fit"),
            Some("/host/run/fifo"),
        );
        let at = after_proc_mask_block(&base_no_mounts).expect("anchor found");
        assert_eq!(
            stacked_v[..at],
            base_no_mounts[..at],
            "hardening prefix byte-identical to the shipped builder"
        );
        assert_eq!(
            stacked_v[at + stacked_v.len() - base_no_mounts.len()..],
            base_no_mounts[at..],
            "FIFO/terminator/prlimit tail preserved"
        );

        // Case C — every shipped prefix shape (fifo × seccomp fd): the shared
        // segment stays byte-identical with a real stack on top, and the
        // spliced block contains no hardening flag (no second copy).
        let mm = model_mount();
        for (fifo, seccomp) in [
            (None, None),
            (Some("/host/run/fifo"), None),
            (None, Some(7)),
            (Some("/host/run/fifo"), Some(7)),
        ] {
            let base = plain_argv(seccomp, fifo);
            let stacked_v = stacked_full(
                &["/code", "/opt/venv/lib"],
                &input_output_mounts(),
                Some(&mm),
                4,
                Some("predict"),
                fifo,
                seccomp,
            );
            let at = after_proc_mask_block(&base).expect("anchor found");
            assert_eq!(
                stacked_v[..at],
                base[..at],
                "hardening prefix byte-identical (fifo={fifo:?} seccomp={seccomp:?})"
            );
            let tail_at = at + stacked_v.len() - base.len();
            assert_eq!(
                stacked_v[tail_at..],
                base[at..],
                "tail byte-identical (fifo={fifo:?} seccomp={seccomp:?})"
            );
            let block = &stacked_v[at..tail_at];
            for flag in LOCKED_HARDENING_FLAGS {
                assert_eq!(
                    count(&stacked_v, flag),
                    count(&base, flag),
                    "{flag}: occurrence count must equal the shipped argv \
                     (a second copy would be a second security implementation)"
                );
                assert!(
                    !block.contains(&flag.to_string()),
                    "{flag} must not repeat inside the spliced block"
                );
            }
        }
    }

    /// ITEM-2 contract pin: the stacked argv satisfies the SAME hardening rules
    /// the shipped builder's own unit tests pin (sandbox.rs TEST-7/8/9/24 +
    /// the FIFO test) — network blocked, strict PID-ns with an own `/proc` and
    /// NO host-`/proc` dev-bind, CA-certs-only `/etc/ssl`, every dotfile masked
    /// with the empty file, base `/usr`/`/opt` read-only, tmpfs `/tmp`, the
    /// prlimit tail after the first `--`, seccomp only with an fd, the FIFO
    /// added exactly once — regardless of what is stacked on top.
    #[test]
    fn stacked_argv_preserves_every_shipped_hardening_rule() {
        let a = stacked(
            &["/code", "/opt/venv/lib"],
            &input_output_mounts(),
            None,
            2,
            Some("fit"),
        );

        // TEST-24 (MEDIUM-1 / HIGH-1 / LOW-1): network, /proc, /etc/ssl.
        assert!(a.contains(&"--unshare-net".to_string()), "network blocked");
        assert!(
            !a.contains(&"--share-net".to_string()),
            "must NOT --share-net"
        );
        assert!(a.contains(&"--unshare-pid".to_string()), "strict pid-ns");
        assert!(a.contains(&"--proc".to_string()), "own /proc");
        assert!(
            !a.windows(3)
                .any(|w| w[0] == "--dev-bind" && w[1] == "/proc"),
            "must NEVER --dev-bind the host /proc (secret-exfil vector)"
        );
        assert!(a.iter().any(|s| s == "/etc/ssl/certs"), "certs bound");
        assert!(
            !a.windows(3)
                .any(|w| w[0] == "--ro-bind-try" && w[2] == "/etc/ssl"),
            "no bare /etc/ssl destination bind"
        );

        // TEST-7/9: identity, base rootfs binds, dotfile masks, terminators,
        // prlimit + bash tail.
        let uid = pos(&a, "--uid").expect("uid set");
        assert_eq!(a[uid + 1], "1001");
        let gid = pos(&a, "--gid").expect("gid set");
        assert_eq!(a[gid + 1], "1001");
        let ub = pos(&a, "/usr").expect("base /usr bound");
        assert_eq!(a[ub - 2], "--ro-bind", "/usr is read-only");
        assert_eq!(
            a[ub - 1],
            "/mnt/base/usr",
            "the BASE rootfs /usr, never the host /usr"
        );
        let tb = pos(&a, "/tmp").expect("tmpfs present");
        assert_eq!(a[tb - 1], "--tmpfs");
        // Dotfile masks: exactly the shipped argv's (source, target) set —
        // derived from BOTH argv so a newly-added dangerous dotfile is masked
        // in both paths, never in one.
        let plain = plain_argv(None, None);
        let plain_masks = mask_triples(&plain);
        assert!(!plain_masks.is_empty(), "the shipped prefix masks dotfiles");
        assert_eq!(mask_triples(&a), plain_masks, "identical dotfile mask set");
        // Terminators + prlimit after the first `--` (CVE-2024-32462) + bash.
        let terms: Vec<usize> = a
            .iter()
            .enumerate()
            .filter(|(_, s)| *s == "--")
            .map(|(i, _)| i)
            .collect();
        assert!(terms.len() >= 2, "two -- terminators");
        let prlimit = pos(&a, "/usr/bin/prlimit").expect("prlimit tail");
        assert!(terms[0] < prlimit, "first -- precedes prlimit");
        let bash = pos(&a, "/bin/bash").expect("bash tail");
        assert_eq!(a[bash + 2], "run.sh");

        // TEST-8: the method mounts map RO→--ro-bind-try, RW→--bind, before `--`.
        let in_p = pos(&a, "/input").unwrap();
        assert_eq!(a[in_p - 2], "--ro-bind-try");
        let out_p = pos(&a, "/output").unwrap();
        assert_eq!(a[out_p - 2], "--bind");
        assert!(in_p < terms[0] && out_p < terms[0]);

        // TEST-3 (FIFO): exactly one extra --bind, bound over the tmpfs path,
        // before the first `--`.
        let with = stacked_fifo(
            &["/code"],
            &input_output_mounts(),
            None,
            2,
            None,
            Some("/host/fifo"),
        );
        let without = stacked_fifo(&["/code"], &input_output_mounts(), None, 2, None, None);
        assert_eq!(
            count(&with, "--bind"),
            count(&without, "--bind") + 1,
            "exactly one extra --bind for the FIFO"
        );
        let fp = pos(&with, PROGRESS_FIFO_SANDBOX_PATH).expect("fifo dest present");
        assert_eq!(with[fp - 2], "--bind");
        assert!(
            fp < pos(&with, "--").unwrap(),
            "fifo bind precedes the terminator"
        );

        // Seccomp only when an fd is passed, before the first `--`.
        let sc = stacked_full(&["/code"], &[], None, 1, None, None, Some(9));
        let scp = pos(&sc, "--seccomp").expect("--seccomp present with fd");
        assert_eq!(sc[scp + 1], "9");
        assert!(
            scp < pos(&sc, "--").unwrap(),
            "seccomp is part of the hardening prefix"
        );
        assert!(
            !a.contains(&"--seccomp".to_string()),
            "no --seccomp without an fd"
        );
    }

    /// ITEM-2 audit pin: the seam probe consumes the WHOLE consecutive
    /// `/proc`-file mask run and REFUSES (typed [`SPLICE_ANCHOR_MISSING_CODE`])
    /// a prefix whose token after the run is not the FIFO/`--seccomp`/`--`
    /// trio — a shipped-side hardening change can never be spliced around
    /// silently.
    #[test]
    fn seam_guard_tracks_the_mask_run_and_refuses_shape_changes() {
        // No mask run at all → typed anchor error.
        let bare: Vec<String> = vec!["--clearenv".into(), "--unshare-net".into(), "--".into()];
        let err = after_proc_mask_block(&bare).expect_err("no mask run must be refused");
        assert_eq!(err.error_code(), SPLICE_ANCHOR_MISSING_CODE);

        // A mask run followed by a NEW hardening flag → refused (the splice
        // must not sit beside a flag the seam code does not know about).
        let mut new_flag = mask_run(4);
        new_flag.push("--unshare-all".into());
        new_flag.push("--".into());
        let err = after_proc_mask_block(&new_flag).expect_err("post-mask hardening flag refused");
        assert_eq!(err.error_code(), SPLICE_ANCHOR_MISSING_CODE);

        // A GROWN mask run (5 paths, the shape a hardening change could add)
        // still yields the seam AFTER the whole run — never between masks.
        let mut grown = mask_run(5);
        grown.push("--".into());
        assert_eq!(
            after_proc_mask_block(&grown).expect("grown run accepted"),
            mask_run(5).len(),
            "the seam consumes every consecutive mask triple"
        );

        // The live shipped prefix: seam = end of the 4-mask run, immediately
        // before the FIFO bind.
        let real = plain_argv(None, Some("/host/run/fifo"));
        let at = after_proc_mask_block(&real).expect("live prefix accepted");
        assert_eq!(real.get(at).map(String::as_str), Some("--bind"));
        let masks = &real[at - mask_run(4).len()..at];
        assert!(
            masks.chunks_exact(3).all(|w| {
                w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2].starts_with("/proc/")
            }),
            "the shipped prefix's 4-mask run sits directly before the seam"
        );
    }

    /// ITEM-2 audit pin: a non-UTF-8 model host path refuses BEFORE any bind —
    /// the bytes tree_sha256 verified must be the bytes the `--ro-bind` mounts
    /// (INV-4); a lossy string could silently point at a different dir.
    #[cfg(unix)]
    #[test]
    fn model_path_must_be_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/host/mod\xFFel"));
        let model = ExtraMount {
            host_path: bad,
            sandbox_path: "/model".into(),
            mode: MountMode::ReadOnly,
        };
        let err = build_stacked_bwrap_argv(
            &caps(),
            &ctx(),
            Path::new("/mnt/base"),
            Path::new("/mnt/layer"),
            &[],
            "run.sh",
            Path::new("/p"),
            Path::new("/g"),
            Path::new("/m"),
            None,
            &limits(),
            &[],
            Some(&model),
            1,
            None,
            None,
        )
        .expect_err("a non-UTF-8 model path must be refused before any bind");
        assert_eq!(err.error_code(), MODEL_PATH_INVALID_CODE);
    }

    /// TEST-03: the entries validator refuses `..`, relative, empty-component
    /// and outside-prefix entries; `validate_oci_ref` accepts only the compiled
    /// txr registries with a single valid-env-id repo component.
    #[test]
    fn layer_entry_and_oci_ref_validation() {
        // Layer entries: only valid shapes pass.
        for ok in [
            "/code",
            "/usr/local",
            "/usr/local/bin",
            "/opt",
            "/opt/venv/x",
        ] {
            assert!(validate_layer_entry(ok).is_ok(), "{ok} must be accepted");
        }
        for bad in [
            "code",          // relative
            "../code",       // ..
            "/usr/../code",  // ..
            "/usr/local/..", // ..
            "/code/",        // empty trailing component
            "/usr/local/",   // empty trailing component
            "/usr",          // outside the allowed prefixes
            "/usr/lib/x",    // outside (a full /usr overlay would shadow the base)
            "/etc/passwd",   // outside
            "/code//x",      // empty component
            "/code/./x",     // "." component
        ] {
            let err = validate_layer_entry(bad).expect_err(&format!("{bad} must be refused"));
            assert_eq!(err.error_code(), ENV_LAYER_ENTRY_INVALID_CODE, "{bad}");
        }
        validate_layer_entries(&["/code".into(), "/usr/local".into()])
            .expect("the list validator accepts a valid list");

        // OCI refs: the two compiled prefixes + valid env id + tag/digest pass.
        let ok_refs = [
            "ghcr.io/tinnlab/txresbench-env/base-r:latest",
            "ghcr.io/tinnlab/txr-method-env-layers/cox-delta:1.0.0",
            "ghcr.io/tinnlab/txresbench-env/base-py@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ];
        for r in ok_refs {
            let parts = validate_oci_ref(r).unwrap_or_else(|e| panic!("{r} must be accepted: {e}"));
            assert!(parts.repo == "base-r" || parts.repo == "cox-delta" || parts.repo == "base-py");
            assert!(
                parts.registry_base == TXR_BASE_REGISTRY_PREFIX
                    || parts.registry_base == TXR_LAYER_REGISTRY_PREFIX
            );
        }
        let p = validate_oci_ref("ghcr.io/tinnlab/txr-method-env-layers/cox-delta:1.0.0").unwrap();
        assert_eq!(p.repo, "cox-delta");
        assert_eq!(p.tag.as_deref(), Some("1.0.0"));
        assert_eq!(p.digest, None);
        let p = validate_oci_ref("ghcr.io/tinnlab/txresbench-env/base-py@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(
            p.digest.as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );

        // Every other shape is refused ENV_REF_HOST_UNALLOWED.
        for bad in [
            "quay.io/tinnlab/txresbench-env/base-r",   // other host
            "ghcr.io/other-org/txresbench-env/base-r", // other org
            "ghcr.io/tinnlab/other-prefix/base-r",     // other prefix
            "ghcr.io/tinnlab/txresbench-env/base-r/x", // nested repo path
            "ghcr.io/tinnlab/txresbench-env/Base-R",   // invalid env id (uppercase)
            "ghcr.io/tinnlab/txresbench-env/base-r:tag/nested", // path-laden tag
            "ghcr.io/tinnlab/txresbench-env/base-r:has space", // malformed tag
            "ghcr.io/tinnlab/txresbench-env/base-r@md5:123", // non-sha256 digest
            "ghcr.io/tinnlab/txresbench-env",          // no repo component
            "http://ghcr.io/tinnlab/txresbench-env/base-r", // scheme-laden
        ] {
            let err = validate_oci_ref(bad).expect_err(&format!("{bad} must be refused"));
            assert_eq!(err.error_code(), ENV_REF_HOST_UNALLOWED_CODE, "{bad}");
        }
        assert!(
            is_valid_oci_tag("1.0.0") && is_valid_oci_tag("latest") && is_valid_oci_tag("x_y.9")
        );
        assert!(
            !is_valid_oci_tag("") && !is_valid_oci_tag("has space") && !is_valid_oci_tag("a:b")
        );
        assert!(is_sha256_hex(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_sha256_hex("") && !is_sha256_hex("ABC"));
    }

    /// TEST-05: mode → SIGBENCH_MODE mapping, thread override last-wins, and
    /// the builder refuses unvalidated entries with a typed error (nothing bound).
    #[test]
    fn mode_mapping_threads_and_refusal_contract() {
        assert_eq!(MethodRunMode::FitPredict.sigbench_mode(), None);
        assert_eq!(MethodRunMode::FitOnly.sigbench_mode(), Some("fit"));
        assert_eq!(MethodRunMode::ReuseModel.sigbench_mode(), Some("predict"));

        // n_cpu 1 → no override (the prefix default `1` is already correct);
        // n_cpu 0 → clamped to 1 (OMP's `0` means "auto" — a runaway risk).
        let a1 = stacked(&[], &[], None, 1, None);
        let a0 = stacked(&[], &[], None, 0, None);
        assert_eq!(a1, a0);
        let omp1 = rpos(&a1, "OMP_NUM_THREADS").expect("prefix default present");
        assert_eq!(
            a1[omp1 + 1],
            "1",
            "n_cpu 1 leaves the prefix's 1 default (no override)"
        );

        // Override present only when n_cpu > 1 (and it is the LAST occurrence).
        let a4 = stacked(&[], &[], None, 4, None);
        let omp = rpos(&a4, "OMP_NUM_THREADS").expect("override for n_cpu 4");
        assert_eq!(a4[omp + 1], "4");

        // The builder refuses an unvalidated entry (nothing is emitted).
        let bad: Vec<String> = vec!["/usr".into()];
        let err = build_stacked_bwrap_argv(
            &caps(),
            &ctx(),
            Path::new("/mnt/base"),
            Path::new("/mnt/layer"),
            &bad,
            "run.sh",
            Path::new("/p"),
            Path::new("/g"),
            Path::new("/m"),
            None,
            &limits(),
            &[],
            None,
            1,
            None,
            None,
        )
        .expect_err("unvalidated entry must be refused");
        assert_eq!(err.error_code(), ENV_LAYER_ENTRY_INVALID_CODE);
    }

    /// PROV-SS-3 unit half (determinism + tamper sensitivity; the RO-bind-in-a-
    /// run half is TEST-04, integration): two calls agree, file order is
    /// sorted, symlinks do not participate, and a tampered file changes the digest.
    #[test]
    fn tree_sha256_is_deterministic_order_sensitive_and_skips_symlinks() {
        let dir = std::env::temp_dir().join(format!("stack-tree-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("b.txt"), b"bb").unwrap();
        std::fs::write(dir.join("a.txt"), b"aa").unwrap();
        std::fs::write(dir.join("sub/c.txt"), b"cc").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("a.txt", dir.join("link.txt")).unwrap();

        let d1 = tree_sha256(&dir).unwrap();
        let d2 = tree_sha256(&dir).unwrap();
        assert_eq!(d1, d2, "deterministic across calls");
        assert_eq!(d1.len(), 64);
        // Order matters (digest differs from a differently-ordered tree): the
        // stream is sorted by relpath, so swapping the file CONTENT between
        // two files must change the digest even though the set is identical.
        std::fs::write(dir.join("b.txt"), b"aa").unwrap();
        std::fs::write(dir.join("a.txt"), b"bb").unwrap();
        let d_swapped = tree_sha256(&dir).unwrap();
        assert_ne!(
            d1, d_swapped,
            "sorted-by-name stream keeps content↔name pairing"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// verify_model_tree: a tampered dir is refused MODEL_VERIFY_FAILED; the
    /// pristine dir passes; the I/O failure path is typed separately.
    #[test]
    fn verify_model_tree_refuses_tamper() {
        let dir = std::env::temp_dir().join(format!("stack-model-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.json"), b"{}").unwrap();
        let good = tree_sha256(&dir).unwrap();
        verify_model_tree(&dir, &good).expect("matching digest passes");

        std::fs::write(dir.join("model.json"), b"{ tampered }").unwrap();
        let err = verify_model_tree(&dir, &good).expect_err("tamper must be refused");
        assert_eq!(err.error_code(), MODEL_VERIFY_FAILED_CODE);

        let missing = dir.join("does-not-exist");
        let err2 = verify_model_tree(&missing, &good).expect_err("missing dir must be refused");
        assert_eq!(err2.error_code(), MODEL_TREE_READ_FAILED_CODE);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // TEST-15 (runtime half): the layer manifest parse + entry validation —
    // a fixture layer dir whose root `layer-manifest.json` parses into
    // `layer_entries`; a relative / `..` / wrong-prefix entry is refused
    // (nothing bound, typed error); a missing or non-array manifest is the
    // typed manifest refusal.
    #[test]
    fn layer_manifest_parses_entries_and_refuses_bad_shapes() {
        let layer = std::env::temp_dir().join(format!("stack-layer-mf-{}", Uuid::new_v4()));
        std::fs::create_dir_all(layer.join("code")).unwrap();

        std::fs::write(
            layer.join(LAYER_MANIFEST_FILE),
            br#"["/code", "/usr/local/lib/R/site-library"]"#,
        )
        .unwrap();
        let entries = layer_entries_from_manifest(&layer).unwrap();
        assert_eq!(
            entries,
            vec!["/code".to_string(), "/usr/local/lib/R/site-library".to_string()]
        );

        for bad in [
            br#"["relative/path"]"#.as_slice(),
            br#"["/usr/../etc"]"#,
            br#"["/usr"]"#,
            br#"["/etc"]"#,
        ] {
            std::fs::write(layer.join(LAYER_MANIFEST_FILE), bad).unwrap();
            let err = layer_entries_from_manifest(&layer).expect_err("bad entry refused");
            assert_eq!(err.error_code(), ENV_LAYER_ENTRY_INVALID_CODE, "for {bad:?}");
        }

        // A manifest that is not a JSON array OF STRINGS (an entry that is not
        // a string, a bare string, a missing file) is MALFORMED — the
        // manifest refusal, never a bind of an unvalidated path.
        for bad in [br#"["/code", 42]"#.as_slice(), br#""not-an-array""#] {
            std::fs::write(layer.join(LAYER_MANIFEST_FILE), bad).unwrap();
            let err = layer_entries_from_manifest(&layer).expect_err("bad manifest refused");
            assert_eq!(err.error_code(), ENV_LAYER_MANIFEST_INVALID_CODE, "for {bad:?}");
        }

        // Missing manifest — the typed manifest refusal.
        std::fs::remove_file(layer.join(LAYER_MANIFEST_FILE)).unwrap();
        let err = layer_entries_from_manifest(&layer).expect_err("missing manifest refused");
        assert_eq!(err.error_code(), ENV_LAYER_MANIFEST_INVALID_CODE);

        let _ = std::fs::remove_dir_all(&layer);
    }

    // DEC-14 filesystem half: parents must exist in the base; the `/` parent
    // of `/opt` / `/code` is the mount root; a missing parent refuses with the
    // SAME typed entry code, before any bind.
    #[test]
    fn entry_parents_must_exist_in_the_mounted_base() {
        let base = std::env::temp_dir().join(format!("stack-base-{}", Uuid::new_v4()));
        std::fs::create_dir_all(base.join("usr/local/lib/R")).unwrap();
        std::fs::create_dir_all(base.join("opt")).unwrap();

        assert_entry_parents_exist(
            &base,
            &["/code".into(), "/opt".into(), "/usr/local/lib/R/site-library".into()],
        )
        .expect("existing parents pass");

        let err = assert_entry_parents_exist(&base, &["/usr/local/no/such/lib".into()])
            .expect_err("missing parent refused");
        assert_eq!(err.error_code(), ENV_LAYER_ENTRY_INVALID_CODE);

        let _ = std::fs::remove_dir_all(&base);
    }

    // The entrypoint command: method.json language is the publisher's
    // declaration (its named script is THE wrapper; absent → loud refusal);
    // presence order covers a layer without a readable method.json (the
    // /code/run.sh fixture layers); nothing → typed miss.
    #[test]
    fn entry_command_follows_language_then_presence() {
        let layer = std::env::temp_dir().join(format!("stack-entry-{}", Uuid::new_v4()));
        std::fs::create_dir_all(layer.join("code")).unwrap();

        std::fs::write(layer.join("code/run.R"), "").unwrap();
        assert_eq!(method_entry_command(&layer).unwrap(), "Rscript /code/run.R");

        std::fs::write(layer.join("code/run.py"), "").unwrap();
        std::fs::write(
            layer.join("code/method.json"),
            br#"{"language": "Python"}"#,
        )
        .unwrap();
        assert_eq!(method_entry_command(&layer).unwrap(), "python3 /code/run.py");

        std::fs::write(layer.join("code/method.json"), br#"{"language": "R"}"#).unwrap();
        assert_eq!(
            method_entry_command(&layer).unwrap(),
            "Rscript /code/run.R",
            "language names its script; both present, language wins"
        );

        // A declared script that is absent is a broken layer — loud refusal,
        // never a silent switch to the other wrapper.
        std::fs::write(layer.join("code/method.json"), br#"{"language": "Python"}"#).unwrap();
        std::fs::remove_file(layer.join("code/run.py")).unwrap();
        let err = method_entry_command(&layer).expect_err("declared script missing → typed miss");
        assert_eq!(err.error_code(), METHOD_ENTRYPOINT_MISSING_CODE);

        std::fs::remove_file(layer.join("code/method.json")).unwrap();
        std::fs::remove_file(layer.join("code/run.R")).unwrap();
        std::fs::write(layer.join("code/run.sh"), "").unwrap();
        assert_eq!(method_entry_command(&layer).unwrap(), "bash /code/run.sh");

        std::fs::remove_file(layer.join("code/run.sh")).unwrap();
        let err = method_entry_command(&layer).expect_err("no entry → typed miss");
        assert_eq!(err.error_code(), METHOD_ENTRYPOINT_MISSING_CODE);

        let _ = std::fs::remove_dir_all(&layer);
    }

    // INV-6 sidecar: write + read round-trip, and `None` CLEARS a stale
    // sidecar (a retry after a legacy-seam attempt must not record the
    // previous attempt's layer — the shipped sidecar's exact rule).
    #[test]
    fn layer_digest_sidecar_roundtrip_and_clears() {
        let root = std::env::temp_dir().join(format!("stack-digest-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        assert_eq!(read_run_layer_digest(&root), None, "absent → None");
        write_run_layer_digest(&root, Some(hex));
        assert_eq!(read_run_layer_digest(&root).as_deref(), Some(hex));
        write_run_layer_digest(&root, None);
        assert_eq!(
            read_run_layer_digest(&root),
            None,
            "None removes a stale sidecar"
        );
        std::fs::write(root.join(RUN_LAYER_ENV_DIGEST_FILE), "not-a-digest").unwrap();
        assert_eq!(read_run_layer_digest(&root), None, "malformed → None");

        let _ = std::fs::remove_dir_all(&root);
    }
}
