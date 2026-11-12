//! Sandbox resource-limits singleton settings.
//!
//! Mirrors txresbench `code_sandbox/resource_limits.rs` (minus the VM-only fields —
//! DEC-3) + the SDK-native singleton idiom (`txresbench-auth session_settings.rs`).
//! Repository uses runtime `query_as` (NOT the `query!` macro) — the app stands
//! up no build DB (SDK_GAPS G4).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use txresbench_core::AppError;

/// The singleton resource-limits row. `cpu_max` is bwrap/cgroup's
/// `"<quota> <period>"` form (e.g. `"200000 100000"` = 2 cores).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, sqlx::FromRow)]
pub struct SandboxResourceLimits {
    pub memory_max_bytes: i64,
    pub memory_swap_max_bytes: i64,
    pub pids_max: i64,
    pub cpu_max: String,
    pub address_space_bytes: i64,
    pub fsize_bytes: i64,
    pub nproc_max: i64,
    pub nofile_max: i64,
    pub cpu_secs_max: i64,
    pub timeout_secs: i64,
    /// Wall-clock cap on the PRE-SPAWN staging phase of a job (env-image
    /// resolve/verify/pull/mount + workspace + input materialization). The
    /// `timeout_secs` budget above only starts once a live child process exists,
    /// so without this cap anything that stalls before the spawn (hung registry,
    /// DNS blackhole, stalled TLS handshake, partial pull) pinned the job at
    /// `running` forever. Operator-facing because the right value depends on
    /// registry latency + link bandwidth + image size.
    pub staging_timeout_secs: i64,

    // ── #54: per-class resource DEFAULTS (admin-editable) ─────────────────
    // The per-job REQUEST a class starts from when the caller names no explicit
    // cpu/mem. `resolve_caps` clamps these DOWN to the ceiling above on every axis
    // (a class default can only ask for LESS than the box-wide cap), so raising one
    // past the ceiling is silently clamped, not honored — the ceiling stays the hard
    // cap. Promoted from the former hardcoded `class_defaults` match (byte-preserving
    // defaults). Classes = `backend::PriorityClass`.
    pub interactive_cpu_cores: i64,
    pub interactive_mem_bytes: i64,
    pub normal_cpu_cores: i64,
    pub normal_mem_bytes: i64,
    pub batch_cpu_cores: i64,
    pub batch_mem_bytes: i64,

    /// #54: the deployment-wide default env-id the sandbox resolves its rootfs for
    /// when neither the per-job converter nor `TXR_SANDBOX_ENV_ID` names one. `None`
    /// (or empty) = auto-detect from the installed processors' declared `env`, exactly
    /// as before this row existed. DATA (a manifest-declared env name), not the
    /// registry security boundary — the registry base stays a compiled read-only const.
    pub default_env_id: Option<String>,

    /// #54: the acting admin stamped on the last PUT (audit; the `*_by` idiom). `None`
    /// on the seeded row until the first update. Serialize-only in the API projection;
    /// never set from a wire body.
    pub updated_by: Option<uuid::Uuid>,
}

impl SandboxResourceLimits {
    /// Hardcoded defaults (also seeded by the migration). Used as the cache
    /// fallback if the DB read fails.
    pub fn defaults() -> Self {
        Self {
            // 8 GiB RSS (cgroup `memory.max`) — the REAL memory guard (vs. the
            // virtual `address_space_bytes` below). The old 2 GiB default was too
            // low for the workload CLASS this sandbox exists to run: a columnar
            // array writer peaks well above 2 GiB (chunk/write buffers + allocator
            // arenas) even on a modest input, so the cgroup denied the allocation
            // and the step died out-of-memory. The floor is set by the ingest
            // class, not by any one analysis domain; measured against a real
            // conversion run. Admin-tunable at /settings/sandbox.
            memory_max_bytes: 8 * 1024 * 1024 * 1024, // 8 GiB
            memory_swap_max_bytes: 8 * 1024 * 1024 * 1024,
            pids_max: 512,
            cpu_max: "200000 100000".to_string(), // 2 cores
            // 64 GiB VIRTUAL address space (RLIMIT_AS via prlimit). This is a
            // virtual-memory ceiling, NOT physical — the real memory guard is
            // `memory_max_bytes` (RSS, cgroup). It must be generous because
            // mmap-heavy array/columnar runtimes (the TileDB + Arrow families and
            // jemalloc's per-CPU arenas) *reserve* tens of GiB of VA up front on
            // many-core hosts even when actual RSS is tiny; a tight `--as` (the
            // old 4 GiB) made every converter run on such a stack abort
            // out-of-memory at startup, regardless of input size — the ceiling was
            // being hit by the RUNTIME's reservation, not by the data. 64 GiB is
            // verified sufficient on a 192-core box; being virtual, the headroom
            // is free.
            address_space_bytes: 64 * 1024 * 1024 * 1024, // 64 GiB
            // 64 GiB per-file write ceiling (RLIMIT_FSIZE via prlimit). Raised from
            // 2 GiB by the owner's ruling 2 (#185 §4) — that 2 GiB is what blocked
            // Xenium IMPORT: upload works since ac7c6b50 (#182), but `RLIMIT_FSIZE`
            // caps every file written INSIDE the sandbox, including the importer's
            // archive `extractall`, and a Xenium morphology OME-TIFF exceeds 2 GiB on
            // its own.
            //
            // Derived from MEASURED platform sizes, not taste (DEC-6 and
            // `docs/design/upload-limits-policy.md` §"Evidence for the new default"):
            // the largest single Xenium bundle member measured is
            // `morphology.ome.tif` at 5,179 MB (XOA 1.0.1 breast rep1; 3,078 MB on
            // XOA 3.0.0 Prime 5K), whole bundles run 7.56-9.86 GB per region, and
            // #161 frames the same file at 5-50 GB. 64 GiB clears the largest
            // measured member by ~12.6x and that 50 GB framing by ~37%.
            //
            // The BOUND survives on purpose (INV-4): this still refuses a single
            // unbounded appending file on any volume larger than 64 GiB, it is inside
            // the unchanged 1 MiB..256 GiB validate()/CHECK range, and an operator can
            // still lower it at /settings/sandbox. What it does NOT establish is that
            // Xenium import works end to end — that was not run; only the per-file
            // write refusal is removed.
            fsize_bytes: 64 * 1024 * 1024 * 1024, // 64 GiB
            nproc_max: 512,
            nofile_max: 4096,
            cpu_secs_max: 600,
            timeout_secs: 600,
            // 15 min — covers a cold multi-GB env-image pull on a modest link.
            staging_timeout_secs: 900,
            // #54: per-class defaults — byte-equal to the retired `class_defaults`
            // match arms (Interactive 2cpu/4GiB, Normal 2cpu/4GiB, Batch 4cpu/8GiB).
            interactive_cpu_cores: 2,
            interactive_mem_bytes: 4 * 1024 * 1024 * 1024,
            normal_cpu_cores: 2,
            normal_mem_bytes: 4 * 1024 * 1024 * 1024,
            batch_cpu_cores: 4,
            batch_mem_bytes: 8 * 1024 * 1024 * 1024,
            // #54: unset → auto-detect from installed processors (today's behavior).
            default_env_id: None,
            updated_by: None,
        }
    }

    /// Validate a candidate row. Returns a 422 `SANDBOX_LIMIT_OUT_OF_RANGE` on
    /// any out-of-range value / malformed `cpu_max` / starvation-guard trip.
    pub fn validate(&self) -> Result<(), AppError> {
        fn range(name: &str, v: i64, lo: i64, hi: i64) -> Result<(), AppError> {
            if v < lo || v > hi {
                return Err(AppError::unprocessable_entity(
                    "SANDBOX_LIMIT_OUT_OF_RANGE",
                    format!("{name}={v} out of range ({lo}..={hi})"),
                ));
            }
            Ok(())
        }
        // 64 MiB .. 256 GiB memory; swap >= 0; sensible caps.
        range("memory_max_bytes", self.memory_max_bytes, 64 * 1024 * 1024, 256i64 * 1024 * 1024 * 1024)?;
        range("memory_swap_max_bytes", self.memory_swap_max_bytes, 0, 256i64 * 1024 * 1024 * 1024)?;
        range("pids_max", self.pids_max, 16, 100_000)?;
        range("address_space_bytes", self.address_space_bytes, 128 * 1024 * 1024, 512i64 * 1024 * 1024 * 1024)?;
        range("fsize_bytes", self.fsize_bytes, 1024 * 1024, 256i64 * 1024 * 1024 * 1024)?;
        range("nproc_max", self.nproc_max, 16, 100_000)?;
        range("nofile_max", self.nofile_max, 64, 1_048_576)?;
        range("cpu_secs_max", self.cpu_secs_max, 1, 86_400)?;
        range("timeout_secs", self.timeout_secs, 1, 86_400)?;
        // Floor of 5s: a warm-cache stage is sub-second, so 5s is safely above any
        // legitimate hot path. It exists only to reject a zero/degenerate value —
        // keeping it low also means the cap is directly exercisable end-to-end by a
        // test, with no debug-only seam.
        range("staging_timeout_secs", self.staging_timeout_secs, 5, 86_400)?;

        // #54: per-class DEFAULTS — bounds mirror the DB CHECKs. cpu 1..=256 cores;
        // mem 64 MiB..256 GiB (same envelope as memory_max_bytes). These bound the
        // per-class REQUEST; `resolve_caps` still clamps it DOWN to the ceiling.
        range("interactive_cpu_cores", self.interactive_cpu_cores, 1, 256)?;
        range("normal_cpu_cores", self.normal_cpu_cores, 1, 256)?;
        range("batch_cpu_cores", self.batch_cpu_cores, 1, 256)?;
        let (mem_lo, mem_hi) = (64 * 1024 * 1024, 256i64 * 1024 * 1024 * 1024);
        range("interactive_mem_bytes", self.interactive_mem_bytes, mem_lo, mem_hi)?;
        range("normal_mem_bytes", self.normal_mem_bytes, mem_lo, mem_hi)?;
        range("batch_mem_bytes", self.batch_mem_bytes, mem_lo, mem_hi)?;

        // #54: default_env_id, when set, must be a valid OCI-path env-id (the same
        // grammar `env_image::resolve` enforces) — a malformed value would otherwise
        // resolve to a broken pull ref or smuggle a `:tag`/`@digest`/host into it.
        // Empty is treated as unset elsewhere; reject a non-empty malformed value here.
        if let Some(env) = self.default_env_id.as_deref() {
            if !env.is_empty()
                && (!crate::modules::sandbox::env_image::is_valid_env_id(env) || env.len() > 255)
            {
                // Length cap kept in lock-step with the DB CHECK (1..255) so the Rust 422
                // and the DB backstop agree on exactly the same accepted set.
                return Err(AppError::unprocessable_entity(
                    "SANDBOX_LIMIT_OUT_OF_RANGE",
                    format!("default_env_id {env:?} is not a valid env-id (lowercase alphanumerics + . _ -, 1..255 chars)"),
                ));
            }
        }

        // cpu_max shape: exactly `"<quota> <period>"`, both positive ints, and
        // a starvation guard (quota must be a meaningful fraction of period).
        let parts: Vec<&str> = self.cpu_max.split_whitespace().collect();
        if parts.len() != 2 {
            return Err(AppError::unprocessable_entity(
                "SANDBOX_LIMIT_OUT_OF_RANGE",
                format!("cpu_max must be \"<quota> <period>\", got {:?}", self.cpu_max),
            ));
        }
        let quota: i64 = parts[0].parse().map_err(|_| {
            AppError::unprocessable_entity(
                "SANDBOX_LIMIT_OUT_OF_RANGE",
                format!("cpu_max quota not an integer: {:?}", parts[0]),
            )
        })?;
        let period: i64 = parts[1].parse().map_err(|_| {
            AppError::unprocessable_entity(
                "SANDBOX_LIMIT_OUT_OF_RANGE",
                format!("cpu_max period not an integer: {:?}", parts[1]),
            )
        })?;
        if !(1000..=1_000_000).contains(&period) {
            return Err(AppError::unprocessable_entity(
                "SANDBOX_LIMIT_OUT_OF_RANGE",
                format!("cpu_max period {period} out of range (1000..=1000000 us)"),
            ));
        }
        // Starvation guard: quota must be >= 1% of period and <= 100 cores.
        if quota < period / 100 || quota > period * 100 {
            return Err(AppError::unprocessable_entity(
                "SANDBOX_LIMIT_OUT_OF_RANGE",
                format!("cpu_max quota {quota} is degenerate vs period {period} (starvation guard)"),
            ));
        }
        Ok(())
    }
}

/// The CPU period (µs) all per-job `cpu.max` quotas are expressed against.
pub const CPU_PERIOD_US: i64 = 100_000;

impl SandboxResourceLimits {
    /// The pre-spawn staging budget as a `Duration`, floored at 1s so a
    /// pathological row can never yield a zero/negative budget.
    pub fn staging_budget(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.staging_timeout_secs.max(1) as u64)
    }
}

impl SandboxResourceLimits {
    /// The admin ceiling's CPU quota (µs) parsed from `cpu_max` ("<quota>
    /// <period>"), normalized to [`CPU_PERIOD_US`]. Falls back to the period
    /// (1 core) if the stored value is malformed (validate() prevents that).
    fn ceiling_cpu_quota_us(&self) -> i64 {
        let mut parts = self.cpu_max.split_whitespace();
        let quota: i64 = parts.next().and_then(|q| q.parse().ok()).unwrap_or(CPU_PERIOD_US);
        let period: i64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(CPU_PERIOD_US);
        if period <= 0 {
            return CPU_PERIOD_US;
        }
        // Renormalize the quota to CPU_PERIOD_US so a differently-based ceiling
        // still clamps correctly: quota/period cores × CPU_PERIOD_US.
        ((quota as i128 * CPU_PERIOD_US as i128) / period as i128) as i64
    }
}

/// A per-job resource REQUEST resolved (per class) and clamped to the admin
/// ceiling. `cpu_cores`/`mem_bytes` are the caller's ask (None = the class
/// default). ITEM-26 / DEC-B (HARD caps).
#[derive(Debug, Clone, Copy)]
pub struct ResourceRequest {
    pub priority: crate::modules::sandbox::backend::PriorityClass,
    pub cpu_cores: Option<i64>,
    pub mem_bytes: Option<i64>,
    pub timeout_secs: Option<u64>,
}

/// Per-class default (cpu cores, mem bytes) BEFORE clamping to the ceiling, read
/// from the admin-editable settings row (#54). Was a hardcoded `match`; now a
/// read-at-use lookup on the ceiling `resolve_caps` already receives — which is the
/// live `settings_cache` snapshot — so a PUT takes effect on the next job with no
/// code change. The values are still just the class's REQUEST; `resolve_caps` clamps
/// them DOWN to the ceiling on every axis (a class can only ask for LESS).
fn class_defaults(
    priority: crate::modules::sandbox::backend::PriorityClass,
    ceiling: &SandboxResourceLimits,
) -> (i64, i64) {
    use crate::modules::sandbox::backend::PriorityClass::*;
    match priority {
        Interactive => (ceiling.interactive_cpu_cores, ceiling.interactive_mem_bytes),
        Normal => (ceiling.normal_cpu_cores, ceiling.normal_mem_bytes),
        Batch => (ceiling.batch_cpu_cores, ceiling.batch_mem_bytes),
    }
}

/// Resolve a per-job request into HARD cgroup caps + wall-clock, CLAMPED to the
/// admin ceiling on every axis (a caller can only ask for LESS, mirroring
/// `service::clamp_timeout`). Returns a `backend::ResourceProfile`.
pub fn resolve_caps(
    req: &ResourceRequest,
    ceiling: &SandboxResourceLimits,
) -> crate::modules::sandbox::backend::ResourceProfile {
    let (def_cores, def_mem) = class_defaults(req.priority, ceiling);

    // Memory: request or class default, clamped down to the ceiling.
    let mem = req.mem_bytes.unwrap_or(def_mem).clamp(1, ceiling.memory_max_bytes);
    // Swap never exceeds the ceiling's swap cap.
    let swap = ceiling.memory_swap_max_bytes.max(0);

    // CPU: request cores or class default, converted to a quota and clamped down.
    let want_quota = req.cpu_cores.unwrap_or(def_cores).max(1) * CPU_PERIOD_US;
    let quota = want_quota.min(ceiling.ceiling_cpu_quota_us()).max(CPU_PERIOD_US / 100);
    let cpu_max = format!("{quota} {CPU_PERIOD_US}");

    // Pids inherit the ceiling (not per-class this round).
    let pids = ceiling.pids_max.max(1);

    // Wall-clock: clamp the request to the ceiling timeout.
    let timeout = super::service::clamp_timeout(req.timeout_secs, ceiling.timeout_secs);

    crate::modules::sandbox::backend::ResourceProfile {
        memory_max_bytes: mem,
        memory_swap_max_bytes: swap,
        pids_max: pids,
        cpu_max,
        timeout_secs: timeout,
    }
}

/// A `SandboxResourceLimits` snapshot carrying a job's resolved per-job caps —
/// used to drive `CgroupScope::create` on the streaming path (it takes the same
/// limits shape the batch path uses). Overlays the resolved profile onto the
/// ceiling's non-cgroup fields (prlimit tail).
pub fn limits_from_profile(
    profile: &crate::modules::sandbox::backend::ResourceProfile,
    ceiling: &SandboxResourceLimits,
) -> SandboxResourceLimits {
    SandboxResourceLimits {
        memory_max_bytes: profile.memory_max_bytes,
        memory_swap_max_bytes: profile.memory_swap_max_bytes,
        pids_max: profile.pids_max,
        cpu_max: profile.cpu_max.clone(),
        timeout_secs: profile.timeout_secs as i64,
        ..ceiling.clone()
    }
}

/// PUT body — every field optional (absent = leave unchanged).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateSandboxResourceLimits {
    #[serde(default)]
    pub memory_max_bytes: Option<i64>,
    #[serde(default)]
    pub memory_swap_max_bytes: Option<i64>,
    #[serde(default)]
    pub pids_max: Option<i64>,
    #[serde(default)]
    pub cpu_max: Option<String>,
    #[serde(default)]
    pub address_space_bytes: Option<i64>,
    #[serde(default)]
    pub fsize_bytes: Option<i64>,
    #[serde(default)]
    pub nproc_max: Option<i64>,
    #[serde(default)]
    pub nofile_max: Option<i64>,
    #[serde(default)]
    pub cpu_secs_max: Option<i64>,
    #[serde(default)]
    pub timeout_secs: Option<i64>,
    #[serde(default)]
    pub staging_timeout_secs: Option<i64>,
    // #54: per-class defaults (absent = unchanged).
    #[serde(default)]
    pub interactive_cpu_cores: Option<i64>,
    #[serde(default)]
    pub interactive_mem_bytes: Option<i64>,
    #[serde(default)]
    pub normal_cpu_cores: Option<i64>,
    #[serde(default)]
    pub normal_mem_bytes: Option<i64>,
    #[serde(default)]
    pub batch_cpu_cores: Option<i64>,
    #[serde(default)]
    pub batch_mem_bytes: Option<i64>,
    /// #54: deployment default env-id. Absent = unchanged; explicit `""` clears it
    /// back to auto-detect (distinct from absent, honored in `merge`/`update`).
    #[serde(default)]
    pub default_env_id: Option<String>,
    // NOTE: `updated_by` is NEVER accepted from the wire — it is stamped from the
    // authenticated admin in the handler. The registry base is likewise not a field
    // here (release security boundary — read-only, INV-4).
}

pub struct SandboxSettingsRepository {
    pool: SqlitePool,
}

impl SandboxSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self) -> Result<SandboxResourceLimits, AppError> {
        // Compile-time-verified against the build DB schema (sqlx `query_as!`,
        // the canonical `dataset` idiom). No timestamptz in the projection, so
        // no `DateTime<Utc>` overrides are needed.
        sqlx::query_as!(
            SandboxResourceLimits,
            r#"SELECT memory_max_bytes, memory_swap_max_bytes, pids_max, cpu_max,
                      address_space_bytes, fsize_bytes, nproc_max, nofile_max,
                      cpu_secs_max, timeout_secs, staging_timeout_secs,
                      interactive_cpu_cores, interactive_mem_bytes,
                      normal_cpu_cores, normal_mem_bytes,
                      batch_cpu_cores, batch_mem_bytes,
                      default_env_id,
                      updated_by as "updated_by: uuid::Uuid"
               FROM sandbox_settings WHERE id = TRUE"#
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// COALESCE-update the singleton, then re-read + return the new row. The
    /// caller validates the merged row before calling (so the DB never holds an
    /// invalid value).
    pub async fn update(
        &self,
        req: &UpdateSandboxResourceLimits,
        updated_by: uuid::Uuid,
    ) -> Result<SandboxResourceLimits, AppError> {
        // default_env_id is three-state: absent = unchanged; empty = clear to NULL
        // (auto-detect); non-empty = set. COALESCE can't express "clear", so it is
        // driven by an explicit touch flag + a normalized value (empty → NULL).
        // log the owned bind (the sqlite macro borrows arg values across the
        // statement — a temporary would be dropped while borrowed).
        let cpu_max_bound = req.cpu_max.clone();
        let env_touch = req.default_env_id.is_some();
        let env_val = req
            .default_env_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string());
        sqlx::query_as!(
            SandboxResourceLimits,
            r#"UPDATE sandbox_settings SET
                    memory_max_bytes = COALESCE($1, memory_max_bytes),
                    memory_swap_max_bytes = COALESCE($2, memory_swap_max_bytes),
                    pids_max = COALESCE($3, pids_max),
                    cpu_max = COALESCE($4, cpu_max),
                    address_space_bytes = COALESCE($5, address_space_bytes),
                    fsize_bytes = COALESCE($6, fsize_bytes),
                    nproc_max = COALESCE($7, nproc_max),
                    nofile_max = COALESCE($8, nofile_max),
                    cpu_secs_max = COALESCE($9, cpu_secs_max),
                    timeout_secs = COALESCE($10, timeout_secs),
                    staging_timeout_secs = COALESCE($11, staging_timeout_secs),
                    interactive_cpu_cores = COALESCE($12, interactive_cpu_cores),
                    interactive_mem_bytes = COALESCE($13, interactive_mem_bytes),
                    normal_cpu_cores = COALESCE($14, normal_cpu_cores),
                    normal_mem_bytes = COALESCE($15, normal_mem_bytes),
                    batch_cpu_cores = COALESCE($16, batch_cpu_cores),
                    batch_mem_bytes = COALESCE($17, batch_mem_bytes),
                    default_env_id = CASE WHEN $18 THEN $19 ELSE default_env_id END,
                    updated_by = $20,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = TRUE
               RETURNING memory_max_bytes, memory_swap_max_bytes, pids_max, cpu_max,
                         address_space_bytes, fsize_bytes, nproc_max, nofile_max,
                         cpu_secs_max, timeout_secs, staging_timeout_secs,
                         interactive_cpu_cores, interactive_mem_bytes,
                         normal_cpu_cores, normal_mem_bytes,
                         batch_cpu_cores, batch_mem_bytes,
                         default_env_id,
                         updated_by as "updated_by: uuid::Uuid""#,
            req.memory_max_bytes,
            req.memory_swap_max_bytes,
            req.pids_max,
            cpu_max_bound,
            req.address_space_bytes,
            req.fsize_bytes,
            req.nproc_max,
            req.nofile_max,
            req.cpu_secs_max,
            req.timeout_secs,
            req.staging_timeout_secs,
            req.interactive_cpu_cores,
            req.interactive_mem_bytes,
            req.normal_cpu_cores,
            req.normal_mem_bytes,
            req.batch_cpu_cores,
            req.batch_mem_bytes,
            env_touch,
            env_val,
            updated_by,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Apply a partial update onto the current row → the merged candidate, for
    /// validation before the DB write.
    pub fn merge(
        current: &SandboxResourceLimits,
        req: &UpdateSandboxResourceLimits,
    ) -> SandboxResourceLimits {
        SandboxResourceLimits {
            memory_max_bytes: req.memory_max_bytes.unwrap_or(current.memory_max_bytes),
            memory_swap_max_bytes: req.memory_swap_max_bytes.unwrap_or(current.memory_swap_max_bytes),
            pids_max: req.pids_max.unwrap_or(current.pids_max),
            cpu_max: req.cpu_max.clone().unwrap_or_else(|| current.cpu_max.clone()),
            address_space_bytes: req.address_space_bytes.unwrap_or(current.address_space_bytes),
            fsize_bytes: req.fsize_bytes.unwrap_or(current.fsize_bytes),
            nproc_max: req.nproc_max.unwrap_or(current.nproc_max),
            nofile_max: req.nofile_max.unwrap_or(current.nofile_max),
            cpu_secs_max: req.cpu_secs_max.unwrap_or(current.cpu_secs_max),
            timeout_secs: req.timeout_secs.unwrap_or(current.timeout_secs),
            staging_timeout_secs: req
                .staging_timeout_secs
                .unwrap_or(current.staging_timeout_secs),
            // #54 per-class defaults (present = overlay, absent = keep).
            interactive_cpu_cores: req.interactive_cpu_cores.unwrap_or(current.interactive_cpu_cores),
            interactive_mem_bytes: req.interactive_mem_bytes.unwrap_or(current.interactive_mem_bytes),
            normal_cpu_cores: req.normal_cpu_cores.unwrap_or(current.normal_cpu_cores),
            normal_mem_bytes: req.normal_mem_bytes.unwrap_or(current.normal_mem_bytes),
            batch_cpu_cores: req.batch_cpu_cores.unwrap_or(current.batch_cpu_cores),
            batch_mem_bytes: req.batch_mem_bytes.unwrap_or(current.batch_mem_bytes),
            // default_env_id: absent = unchanged; empty = clear to auto-detect; else set.
            default_env_id: match req.default_env_id.as_deref() {
                None => current.default_env_id.clone(),
                Some(s) if s.trim().is_empty() => None,
                Some(s) => Some(s.to_string()),
            },
            // merge never adopts updated_by from the wire body (stamped in the handler).
            updated_by: current.updated_by,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-11: validate() range + cpu_max shape + starvation guard.
    #[test]
    fn defaults_are_valid() {
        SandboxResourceLimits::defaults().validate().expect("defaults valid");
    }

    #[test]
    fn out_of_range_values_rejected_422() {
        let bad_mem = SandboxResourceLimits { memory_max_bytes: 1, ..SandboxResourceLimits::defaults() };
        let e = bad_mem.validate().unwrap_err();
        assert_eq!(e.status_code(), 422);
        assert_eq!(e.error_code(), "SANDBOX_LIMIT_OUT_OF_RANGE");

        let bad_pids = SandboxResourceLimits { pids_max: 0, ..SandboxResourceLimits::defaults() };
        assert_eq!(bad_pids.validate().unwrap_err().status_code(), 422);

        let bad_timeout = SandboxResourceLimits { timeout_secs: 0, ..SandboxResourceLimits::defaults() };
        assert_eq!(bad_timeout.validate().unwrap_err().status_code(), 422);

        // The pre-spawn staging cap is validated like every other operator knob —
        // a 0 (which would mean "no budget at all") is a 422, not a silent
        // degenerate value the job-hang fix would then act on.
        let no_budget =
            SandboxResourceLimits { staging_timeout_secs: 0, ..SandboxResourceLimits::defaults() };
        assert_eq!(no_budget.validate().unwrap_err().status_code(), 422);
        let absurd = SandboxResourceLimits {
            staging_timeout_secs: 86_401,
            ..SandboxResourceLimits::defaults()
        };
        assert_eq!(absurd.validate().unwrap_err().status_code(), 422);
    }

    // JOB-HANG FIX: the pre-spawn staging budget is a real, finite Duration on the
    // defaults path too — a deployment that never touches the setting still gets a
    // bounded staging phase (the fix must not depend on an admin opting in), and
    // `staging_budget` never yields zero even from a degenerate row.
    #[test]
    fn staging_budget_is_finite_by_default_and_never_zero() {
        let d = SandboxResourceLimits::defaults();
        assert_eq!(d.staging_timeout_secs, 900, "15 min covers a cold multi-GB pull");
        assert_eq!(d.staging_budget(), std::time::Duration::from_secs(900));

        let degenerate = SandboxResourceLimits { staging_timeout_secs: 0, ..d };
        assert!(
            degenerate.staging_budget() >= std::time::Duration::from_secs(1),
            "a bad row floors to 1s rather than producing a zero/instant budget"
        );
    }

    #[test]
    fn cpu_max_shape_and_starvation_guard() {
        let bad_shape = SandboxResourceLimits { cpu_max: "200000".into(), ..SandboxResourceLimits::defaults() };
        assert_eq!(bad_shape.validate().unwrap_err().error_code(), "SANDBOX_LIMIT_OUT_OF_RANGE");

        let non_int = SandboxResourceLimits { cpu_max: "abc def".into(), ..SandboxResourceLimits::defaults() };
        assert!(non_int.validate().is_err());

        // Degenerate quota vs period (starvation).
        let starve = SandboxResourceLimits { cpu_max: "1 100000".into(), ..SandboxResourceLimits::defaults() };
        assert!(starve.validate().is_err(), "quota well under 1% of period must trip the guard");

        // A valid non-default shape passes (1 core).
        let ok = SandboxResourceLimits { cpu_max: "100000 100000".into(), ..SandboxResourceLimits::defaults() };
        ok.validate().expect("1-core cpu_max valid");
    }

    // TEST-11: resolve_caps clamps a per-job request DOWN to the ceiling, never
    // up; per-class defaults resolve within the ceiling.
    #[test]
    fn resolve_caps_clamps_down_to_ceiling() {
        use crate::modules::sandbox::backend::PriorityClass;
        // Ceiling: 2 GiB mem, 2 cores ("200000 100000"), timeout 600.
        let ceiling = SandboxResourceLimits::defaults();

        // A request ASKING FOR MORE than the ceiling is clamped down.
        let greedy = ResourceRequest {
            priority: PriorityClass::Batch,
            cpu_cores: Some(64),
            mem_bytes: Some(1024i64 * 1024 * 1024 * 1024), // 1 TiB
            timeout_secs: Some(u64::MAX),
        };
        let caps = resolve_caps(&greedy, &ceiling);
        assert_eq!(caps.memory_max_bytes, ceiling.memory_max_bytes, "mem clamped to ceiling");
        assert_eq!(caps.cpu_max, "200000 100000", "cpu clamped to the ceiling's 2 cores");
        assert_eq!(caps.timeout_secs, ceiling.timeout_secs as u64, "timeout clamped to ceiling");
        assert_eq!(caps.pids_max, ceiling.pids_max);

        // A request asking for LESS is honored (ask-less works).
        let modest = ResourceRequest {
            priority: PriorityClass::Interactive,
            cpu_cores: Some(1),
            mem_bytes: Some(512 * 1024 * 1024),
            timeout_secs: Some(30),
        };
        let caps2 = resolve_caps(&modest, &ceiling);
        assert_eq!(caps2.memory_max_bytes, 512 * 1024 * 1024, "smaller mem honored");
        assert_eq!(caps2.cpu_max, "100000 100000", "1 core honored");
        assert_eq!(caps2.timeout_secs, 30, "shorter timeout honored");

        // Per-class default (no explicit request) resolves within the ceiling.
        let defaulted = ResourceRequest {
            priority: PriorityClass::Normal,
            cpu_cores: None,
            mem_bytes: None,
            timeout_secs: None,
        };
        let caps3 = resolve_caps(&defaulted, &ceiling);
        assert!(caps3.memory_max_bytes <= ceiling.memory_max_bytes);
        assert_eq!(caps3.timeout_secs, ceiling.timeout_secs as u64);
    }

    #[test]
    fn merge_overlays_only_present_fields() {
        let cur = SandboxResourceLimits::defaults();
        let req = UpdateSandboxResourceLimits { pids_max: Some(256), ..Default::default() };
        let merged = SandboxSettingsRepository::merge(&cur, &req);
        assert_eq!(merged.pids_max, 256);
        assert_eq!(merged.memory_max_bytes, cur.memory_max_bytes, "untouched fields preserved");
    }

    // TEST-2 [acceptance][INV-2]: the promoted per-class defaults byte-equal the
    // retired `class_defaults` match arms, and default_env_id is unset — a deployment
    // that never PUTs resolves identically to before this row existed.
    #[test]
    fn per_class_defaults_are_byte_preserving() {
        let d = SandboxResourceLimits::defaults();
        assert_eq!((d.interactive_cpu_cores, d.interactive_mem_bytes), (2, 4 * 1024 * 1024 * 1024));
        assert_eq!((d.normal_cpu_cores, d.normal_mem_bytes), (2, 4 * 1024 * 1024 * 1024));
        assert_eq!((d.batch_cpu_cores, d.batch_mem_bytes), (4, 8 * 1024 * 1024 * 1024));
        assert!(d.default_env_id.is_none(), "unset → auto-detect (today's behavior)");
        assert!(d.updated_by.is_none());
    }

    // TEST-1 [acceptance][INV-1]: a per-class DEFAULT set ABOVE the ceiling is clamped
    // DOWN to the ceiling by resolve_caps — making the defaults editable did NOT let a
    // class ask for more than the box-wide cap.
    #[test]
    fn per_class_default_over_ceiling_is_clamped_down() {
        use crate::modules::sandbox::backend::PriorityClass;
        // Ceiling: 2 cores / 8 GiB (defaults). Inflate the Normal per-class default
        // far past it, then resolve a Normal job that names NO explicit cpu/mem.
        let ceiling = SandboxResourceLimits {
            normal_cpu_cores: 64,
            normal_mem_bytes: 200i64 * 1024 * 1024 * 1024, // 200 GiB, within column bounds
            ..SandboxResourceLimits::defaults()
        };
        let req = ResourceRequest {
            priority: PriorityClass::Normal,
            cpu_cores: None,
            mem_bytes: None,
            timeout_secs: None,
        };
        let caps = resolve_caps(&req, &ceiling);
        assert_eq!(caps.memory_max_bytes, ceiling.memory_max_bytes, "mem clamped to ceiling, not the 200 GiB default");
        assert_eq!(caps.cpu_max, "200000 100000", "cpu clamped to the ceiling's 2 cores, not the 64-core default");
    }

    // TEST-12 [ITEM-3]: class_defaults reads per-class values from the ceiling
    // (read-at-use). A raised default that stays WITHIN the ceiling is honored.
    #[test]
    fn class_defaults_read_from_ceiling_within_caps() {
        use crate::modules::sandbox::backend::PriorityClass;
        // Raise the ceiling's cpu to 4 cores + mem to 8 GiB, and set Normal default to
        // 3 cores / 6 GiB (below the ceiling) — resolve honors the per-class default.
        let ceiling = SandboxResourceLimits {
            cpu_max: "400000 100000".into(), // 4 cores
            memory_max_bytes: 8 * 1024 * 1024 * 1024,
            normal_cpu_cores: 3,
            normal_mem_bytes: 6 * 1024 * 1024 * 1024,
            ..SandboxResourceLimits::defaults()
        };
        let req = ResourceRequest { priority: PriorityClass::Normal, cpu_cores: None, mem_bytes: None, timeout_secs: None };
        let caps = resolve_caps(&req, &ceiling);
        assert_eq!(caps.cpu_max, "300000 100000", "3-core Normal default honored (under the 4-core ceiling)");
        assert_eq!(caps.memory_max_bytes, 6 * 1024 * 1024 * 1024, "6 GiB Normal default honored");
    }

    // TEST-8 [ITEM-2]: validate() rejects out-of-range per-class values and a
    // malformed default_env_id with a typed 422.
    #[test]
    fn per_class_and_env_id_validation() {
        let bad_cpu = SandboxResourceLimits { batch_cpu_cores: 0, ..SandboxResourceLimits::defaults() };
        assert_eq!(bad_cpu.validate().unwrap_err().status_code(), 422);
        let big_cpu = SandboxResourceLimits { interactive_cpu_cores: 257, ..SandboxResourceLimits::defaults() };
        assert_eq!(big_cpu.validate().unwrap_err().error_code(), "SANDBOX_LIMIT_OUT_OF_RANGE");
        let tiny_mem = SandboxResourceLimits { normal_mem_bytes: 1024, ..SandboxResourceLimits::defaults() };
        assert!(tiny_mem.validate().is_err());

        // default_env_id: a valid id passes, empty passes (unset), malformed 422s.
        let ok = SandboxResourceLimits { default_env_id: Some("demo-env".into()), ..SandboxResourceLimits::defaults() };
        ok.validate().expect("valid env-id");
        let empty = SandboxResourceLimits { default_env_id: Some(String::new()), ..SandboxResourceLimits::defaults() };
        empty.validate().expect("empty env-id is unset, allowed");
        for bad in ["Single-Cell", "a/b", "x:tag", "y@sha256:abc", "has space"] {
            let m = SandboxResourceLimits { default_env_id: Some(bad.into()), ..SandboxResourceLimits::defaults() };
            assert_eq!(m.validate().unwrap_err().status_code(), 422, "{bad:?} must be rejected");
        }
    }

    // TEST-9 [ITEM-4]: merge overlays only present per-class/env-id fields and never
    // adopts updated_by from the wire body; empty env-id clears to None.
    #[test]
    fn merge_per_class_env_id_and_never_updated_by() {
        let cur = SandboxResourceLimits {
            default_env_id: Some("bulk-rnaseq".into()),
            updated_by: Some(uuid::Uuid::new_v4()),
            ..SandboxResourceLimits::defaults()
        };
        // Only batch_cpu_cores present.
        let req = UpdateSandboxResourceLimits { batch_cpu_cores: Some(8), ..Default::default() };
        let m = SandboxSettingsRepository::merge(&cur, &req);
        assert_eq!(m.batch_cpu_cores, 8);
        assert_eq!(m.normal_cpu_cores, cur.normal_cpu_cores, "untouched class preserved");
        assert_eq!(m.default_env_id.as_deref(), Some("bulk-rnaseq"), "env-id untouched when absent");
        assert_eq!(m.updated_by, cur.updated_by, "merge preserves updated_by, never from body");

        // Empty env-id clears to None (auto-detect).
        let clear = UpdateSandboxResourceLimits { default_env_id: Some("  ".into()), ..Default::default() };
        assert!(SandboxSettingsRepository::merge(&cur, &clear).default_env_id.is_none());
    }

    // ── uncapped-uploads (#185 §4 / owner ruling 2) ─────────────────────────────
    // NOTE on ids: TEST-N is a PER-FEATURE namespace and this file already carries
    // another feature's ids; the test below belongs to `uncapped-uploads` and is
    // named with that prefix so a grep cannot bind one feature's claim to another
    // feature's assertion (lifecycle A11).

    // uncapped-uploads TEST-8: the raised RLIMIT_FSIZE default is the number the
    // design doc derives, it is still INSIDE the unchanged validate() range (the
    // bound survives, INV-4), and it clears the largest MEASURED Xenium bundle
    // member by more than 10x.
    //
    // This asserts the design's promise, not the code's behaviour: the two
    // evidence constants below are transcribed from
    // `docs/design/upload-limits-policy.md` §"Evidence for the new default", so if
    // the default were quietly lowered back toward the old 2 GiB the headroom
    // assertion goes red rather than silently tracking whatever `defaults()` says.
    #[test]
    fn uncapped_uploads_test8_fsize_default_is_raised_and_still_bounded() {
        const GIB: i64 = 1024 * 1024 * 1024;
        // Largest single Xenium bundle member measured: morphology.ome.tif,
        // XOA 1.0.1 breast rep1 = 5,179 MB (docs/design/upload-limits-policy.md).
        const LARGEST_MEASURED_XENIUM_MEMBER_BYTES: i64 = 5_179 * 1000 * 1000;
        // The old shipped default that blocked Xenium import.
        const OLD_DEFAULT_BYTES: i64 = 2 * GIB;

        let d = SandboxResourceLimits::defaults();
        assert_eq!(d.fsize_bytes, 64 * GIB, "64 GiB, the DEC-6 value");
        assert_eq!(d.fsize_bytes, 68_719_476_736, "== the migration's column default");

        // The bound did not disappear: defaults still validate against the
        // UNCHANGED 1 MiB..256 GiB range, and a raise past it is still refused.
        d.validate().expect("the raised default is inside the unchanged range");
        let over = SandboxResourceLimits { fsize_bytes: 257 * GIB, ..d.clone() };
        let e = over.validate().unwrap_err();
        assert_eq!(e.status_code(), 422);
        assert_eq!(e.error_code(), "SANDBOX_LIMIT_OUT_OF_RANGE");
        // ...and an operator can still LOWER it, which is the point of keeping it a
        // setting rather than deleting the limit.
        SandboxResourceLimits { fsize_bytes: 1024 * 1024, ..d.clone() }
            .validate()
            .expect("an operator may still lower the ceiling to the 1 MiB floor");

        // The old default could not hold the file that blocked import; the new one
        // clears it by more than 10x.
        //
        // NOTE: `OLD_DEFAULT_BYTES < LARGEST_MEASURED_XENIUM_MEMBER_BYTES` is NOT
        // asserted here. Both are literals declared in this function, so the compiler
        // settles it and no change to the codebase could ever make it fail — it read
        // as evidence about the shipped code while being a statement about two
        // constants. What is worth binding is that the OLD default would still be
        // REFUSED by the shipped validator for the file that blocked import, and that
        // the new one is not.
        let old = SandboxResourceLimits { fsize_bytes: OLD_DEFAULT_BYTES, ..d.clone() };
        assert!(
            old.fsize_bytes < LARGEST_MEASURED_XENIUM_MEMBER_BYTES,
            "the retired default {} could not hold the largest measured Xenium member {} \
             — this is the concrete reason the default moved",
            old.fsize_bytes,
            LARGEST_MEASURED_XENIUM_MEMBER_BYTES
        );
        assert!(
            d.fsize_bytes > LARGEST_MEASURED_XENIUM_MEMBER_BYTES * 10,
            "new default {} leaves >10x headroom over the largest measured member {}",
            d.fsize_bytes,
            LARGEST_MEASURED_XENIUM_MEMBER_BYTES
        );
    }
}
