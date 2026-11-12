//! cgroup v2 transient-scope creation (per analysis run).
//!
//! Ported from txresbench `code_sandbox/cgroup.rs`. Writes directly to sysfs (no
//! systemd-run). The delegated parent comes from the boot cgroup probe. Only
//! invoked on the Linux exec path, but the struct itself is OS-independent
//! (plain `std::fs`) so the scope-name logic is unit-testable everywhere.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use uuid::Uuid;
use txresbench_core::AppError;

use super::settings::SandboxResourceLimits;

/// Per-run cgroup scope name: `sandbox-<job_id>-<nanos>` (unique per call).
pub fn scope_name(job_id: Uuid) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("sandbox-{job_id}-{nanos}")
}

/// Per-call cgroup scope. Cleans up on Drop (best-effort).
pub struct CgroupScope {
    path: PathBuf,
}

impl CgroupScope {
    /// Create a fresh scope under `parent` and write the configured caps. Each
    /// controller MAY fail if the parent didn't delegate it; the scope still
    /// works for whatever IS delegated (logged loudly).
    pub fn create(
        parent: &Path,
        job_id: Uuid,
        limits: &SandboxResourceLimits,
    ) -> Result<Self, AppError> {
        let path = parent.join(scope_name(job_id));
        std::fs::create_dir(&path).map_err(|e| {
            AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "CGROUP_CREATE_FAILED",
                format!("create_dir({}): {e}", path.display()),
            )
        })?;
        write_controller(&path, "memory.max", &limits.memory_max_bytes.to_string());
        write_controller(&path, "memory.swap.max", &limits.memory_swap_max_bytes.to_string());
        write_controller(&path, "pids.max", &limits.pids_max.to_string());
        write_controller(&path, "cpu.max", &limits.cpu_max);
        Ok(Self { path })
    }

    pub fn attach_pid(&self, pid: u32) -> Result<(), AppError> {
        std::fs::write(self.path.join("cgroup.procs"), pid.to_string()).map_err(|e| {
            AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "CGROUP_ATTACH_FAILED",
                format!("write cgroup.procs: {e}"),
            )
        })
    }

    /// This scope's sysfs directory (so the executor's sampler can read metrics
    /// by path without holding the scope — the scope stays owned by the run
    /// guards whose Drop cleans it up).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read back the whole-subtree resource metrics for THIS scope (ITEM-24 /
    /// DEC-C).
    pub fn read_metrics(&self) -> CgroupSample {
        read_metrics_at(&self.path)
    }
}

/// Read the whole-subtree cgroup-v2 metrics from a scope directory by PATH
/// (ITEM-24 / DEC-C). Strictly more accurate than the single-pid `ProcSampler`,
/// which misses bwrap's grandchildren. Any file a given kernel doesn't expose
/// (`memory.peak`/`pids.peak` are newer) degrades to `None` — never an error
/// (the sampler must not break the hot path).
pub fn read_metrics_at(scope_path: &Path) -> CgroupSample {
    CgroupSample {
        mem_current: read_u64_file(&scope_path.join("memory.current")),
        mem_peak: read_u64_file(&scope_path.join("memory.peak")),
        pids_current: read_u64_file(&scope_path.join("pids.current")),
        pids_peak: read_u64_file(&scope_path.join("pids.peak")),
        cpu_usage_usec: std::fs::read_to_string(scope_path.join("cpu.stat"))
            .ok()
            .and_then(|s| parse_cpu_usage_usec(&s)),
    }
}

/// A single cgroup-v2 metric read. All fields optional (kernel-version-gated).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CgroupSample {
    pub mem_current: Option<u64>,
    pub mem_peak: Option<u64>,
    pub pids_current: Option<u64>,
    pub pids_peak: Option<u64>,
    /// Cumulative CPU time in microseconds (from `cpu.stat`'s `usage_usec`).
    pub cpu_usage_usec: Option<u64>,
}

/// Parse `cpu.stat` for the `usage_usec <n>` line. Pure + unit-testable.
pub fn parse_cpu_usage_usec(contents: &str) -> Option<u64> {
    for line in contents.lines() {
        let mut it = line.split_whitespace();
        if it.next() == Some("usage_usec") {
            return it.next().and_then(|v| v.parse().ok());
        }
    }
    None
}

/// Derive CPU% between two `usage_usec` samples over `elapsed`. A non-monotonic
/// (counter reset / missing) or zero-interval delta clamps to 0. `100%` == one
/// full core; multi-core can exceed 100. Pure + unit-testable.
pub fn cpu_pct_between(prev_usec: Option<u64>, cur_usec: Option<u64>, elapsed_secs: f64) -> f32 {
    match (prev_usec, cur_usec) {
        (Some(prev), Some(cur)) if cur >= prev && elapsed_secs > 0.0 => {
            let busy_secs = (cur - prev) as f64 / 1_000_000.0;
            ((busy_secs / elapsed_secs) * 100.0) as f32
        }
        _ => 0.0,
    }
}

/// Read a cgroup pseudo-file holding a single unsigned integer (`memory.current`,
/// `pids.current`, …). `max` / non-numeric / missing → `None`.
fn read_u64_file(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok())
}

impl Drop for CgroupScope {
    fn drop(&mut self) {
        // `remove_dir` (empty-only) by design: a real cgroup with a live process
        // can't be removed, and an emptied one removes cleanly. The controller
        // pseudo-files are NOT directory entries we own on a real cgroupfs.
        let _ = std::fs::remove_dir(&self.path);
    }
}

#[cfg(test)]
impl CgroupScope {
    /// Construct a scope over an existing path WITHOUT writing controllers, so a
    /// Drop-cleanup test isn't polluted by controller pseudo-files that
    /// `std::fs::write` would materialize on a non-cgroup tmpfs.
    fn for_test(path: PathBuf) -> Self {
        Self { path }
    }
}

fn write_controller(scope: &Path, file: &str, value: &str) {
    if let Err(e) = std::fs::write(scope.join(file), value) {
        tracing::warn!(
            controller = file,
            scope = %scope.display(),
            error = %e,
            "sandbox: cgroup controller write failed; that controller's quota \
             silently degrades to unlimited within the cgroup"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-6: scope name format + Drop removes an empty scope dir.
    #[test]
    fn scope_name_has_expected_shape() {
        let id = Uuid::nil();
        let n1 = scope_name(id);
        assert!(n1.starts_with("sandbox-00000000-0000-0000-0000-000000000000-"), "{n1}");
        // The nanos tail makes two names differ (monotonic clock).
        std::thread::sleep(std::time::Duration::from_nanos(10));
        let n2 = scope_name(id);
        assert_ne!(n1, n2, "the nanos suffix makes scope names unique per call");
    }

    // TEST-10: cgroup metric parsers on fixtures + CPU% delta derivation.
    #[test]
    fn parse_cpu_usage_and_pct_delta() {
        let stat = "usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\n";
        assert_eq!(parse_cpu_usage_usec(stat), Some(2_500_000));
        assert_eq!(parse_cpu_usage_usec("nr_periods 0\n"), None, "no usage line → None");

        // 1.0s of CPU over 1.0s wall = 100% (one core).
        assert_eq!(cpu_pct_between(Some(0), Some(1_000_000), 1.0), 100.0);
        // 2.0s of CPU over 1.0s wall = 200% (two cores).
        assert_eq!(cpu_pct_between(Some(0), Some(2_000_000), 1.0), 200.0);
        // Non-monotonic (counter went backwards) → clamp 0.
        assert_eq!(cpu_pct_between(Some(5), Some(1), 1.0), 0.0);
        // Zero interval → clamp 0 (no divide-by-zero).
        assert_eq!(cpu_pct_between(Some(0), Some(1_000_000), 0.0), 0.0);
        // Missing sample → 0.
        assert_eq!(cpu_pct_between(None, Some(1), 1.0), 0.0);
        assert_eq!(cpu_pct_between(Some(1), None, 1.0), 0.0);
    }

    #[test]
    fn read_metrics_on_a_plain_dir_is_all_none() {
        // A non-cgroup tmpfs dir has none of the pseudo-files → all None, no error.
        let dir = std::env::temp_dir().join(format!("txr-cgm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let scope = CgroupScope::for_test(dir.clone());
        let m = scope.read_metrics();
        assert_eq!(m, CgroupSample::default(), "no pseudo-files → default (all None)");
        std::mem::forget(scope); // don't let Drop remove-dir race the assert path
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drop_removes_empty_scope_dir() {
        // Faithfully exercise Drop → `remove_dir` (empty-only) on an EMPTY scope
        // dir. (A real cgroupfs pre-creates the controller pseudo-files;
        // `CgroupScope::create` on a plain tmpfs would materialize them and make
        // the dir non-empty, which is a tmpfs artifact, not the Drop contract.)
        let parent = std::env::temp_dir().join(format!("txr-cg-{}", std::process::id()));
        let path = parent.join(scope_name(Uuid::nil()));
        std::fs::create_dir_all(&path).unwrap();
        {
            let _scope = CgroupScope::for_test(path.clone());
            assert!(path.exists());
        }
        assert!(!path.exists(), "Drop removed the empty scope dir");
        let _ = std::fs::remove_dir_all(&parent);
    }
}
