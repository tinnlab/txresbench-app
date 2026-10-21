//! One-time boot probes for the sandbox (ported from ziee
//! `code_sandbox/probes.rs`).
//!
//! Host-only probes (bwrap on PATH, delegated cgroup, seccomp compile) run at
//! `init()`. The rootfs-dependent PID-ns probe runs lazily against the mounted
//! rootfs on the first run. Results are cached — no shellouts on the hot path.

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use super::types::{CgroupMode, HardeningCapabilities, HostCapabilities, PidNsMode, SeccompMode};

/// Host-only probe. `None` when bwrap is missing (sandbox self-disables).
pub fn probe_host_only() -> Option<HostCapabilities> {
    let bwrap_path = which_bwrap()?;
    let cgroup = probe_cgroup(&std::env::var("CYTO_SANDBOX_CGROUP_PARENT").unwrap_or_default());
    let seccomp = compile_seccomp_filter();
    Some(HostCapabilities { bwrap_path, cgroup, seccomp })
}

/// Whether a probed PID-ns mode is ACCEPTABLE to run the execute path.
///
/// SECURITY (FB HIGH-1): ONLY a real, strict PID namespace is accepted. Without
/// `--unshare-pid` the sandbox shares the host PID namespace, and because
/// `--unshare-user --uid 1001` maps the sandbox uid onto the SERVER's euid,
/// `ptrace_may_access` passes — so sandboxed code could `cat
/// /proc/<server_pid>/environ` and read `DATABASE_URL` / `jwt.secret` /
/// `*_API_KEY` (defeating `--clearenv`). The `/proc`-file masks cannot cover
/// `/proc/<pid>/environ`. So a `DevBindFallback` (host `/proc`) is treated
/// EXACTLY like `Disabled`: the sandbox self-disables. Pure + testable.
pub fn pidns_accept(mode: PidNsMode) -> bool {
    matches!(mode, PidNsMode::Strict)
}

/// Promote host caps to full caps by probing PID-ns against the mounted rootfs.
/// `Err` unless a real (strict) PID namespace is available — a no-PID-ns
/// fallback is REFUSED (FB HIGH-1), so the sandbox self-disables rather than run
/// with host `/proc` (secret-exfil vector).
pub fn probe_rootfs_dependent(
    host: &HostCapabilities,
    rootfs_dir: &Path,
) -> Result<HardeningCapabilities, String> {
    let pid = probe_pid_ns(&host.bwrap_path, rootfs_dir);
    if !pidns_accept(pid) {
        return Err(format!(
            "a real PID namespace is not available against the rootfs at {} \
             (strict `--unshare-pid` probe failed); the sandbox is DISABLED — a \
             no-PID-ns fallback would share the host /proc and let sandboxed code \
             read the server's /proc/<pid>/environ (secret exfil). \
             On a bare-metal host this usually just works (needs CONFIG_USER_NS=y \
             + unprivileged userns: `sysctl kernel.unprivileged_userns_clone=1`, \
             `kernel.apparmor_restrict_unprivileged_userns=0`). Inside a CONTAINER \
             it fails when /proc is MASKED (an over-mount on a /proc/... path locks \
             the whole tree against an unprivileged fresh `mount -t proc`) — run the \
             container with `--security-opt systempaths=unconfined` (or otherwise \
             leave /proc unmasked) so the sandbox can mount its own /proc.",
            rootfs_dir.display()
        ));
    }
    let caps = HardeningCapabilities::from_host(host, pid);
    tracing::info!("{}", super::types::hardening_summary(&caps));
    Ok(caps)
}

fn which_bwrap() -> Option<PathBuf> {
    for dir in std::env::var_os("PATH")?.to_string_lossy().split(':') {
        let p = Path::new(dir).join("bwrap");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Whether a cgroup subtree_control string delegates BOTH memory + pids.
/// Tokenized on whitespace (a substring match would accept the denied `-memory`
/// form or a `memory_pressure` substring). Pure + testable (TEST-5).
pub fn cgroup_has_required_controllers(subtree_control: &str) -> bool {
    let active: std::collections::HashSet<&str> = subtree_control.split_whitespace().collect();
    active.contains("memory") && active.contains("pids")
}

/// Detect a writable delegated cgroup parent. Empty config → None.
pub fn probe_cgroup(parent_str: &str) -> CgroupMode {
    if parent_str.trim().is_empty() {
        return CgroupMode::None;
    }
    let raw = PathBuf::from(parent_str);
    if let Ok(meta) = std::fs::symlink_metadata(&raw) {
        if meta.file_type().is_symlink() {
            tracing::warn!("sandbox: cgroup_parent {} is a symlink; refusing", raw.display());
            return CgroupMode::None;
        }
    }
    let parent = match std::fs::canonicalize(&raw) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("sandbox: cgroup_parent {} not accessible ({e}); rlimits-only", raw.display());
            return CgroupMode::None;
        }
    };
    if !parent.starts_with("/sys/fs/cgroup") {
        tracing::warn!("sandbox: cgroup_parent resolved outside /sys/fs/cgroup; refusing");
        return CgroupMode::None;
    }
    let subtree = parent.join("cgroup.subtree_control");
    if !subtree.exists() {
        tracing::warn!("sandbox: cgroup parent {} not delegated; rlimits-only", parent.display());
        return CgroupMode::None;
    }
    let controllers = std::fs::read_to_string(&subtree).unwrap_or_default();
    if !cgroup_has_required_controllers(&controllers) {
        tracing::warn!("sandbox: cgroup parent {} lacks memory+pids; rlimits-only", parent.display());
        return CgroupMode::None;
    }
    let probe = parent.join(".sandbox-probe");
    let _ = std::fs::remove_dir(&probe);
    if std::fs::create_dir(&probe).is_ok() {
        let _ = std::fs::remove_dir(&probe);
        CgroupMode::Delegated(parent)
    } else {
        tracing::warn!("sandbox: cgroup parent {} not writable; rlimits-only", parent.display());
        CgroupMode::None
    }
}

/// Probe strict PID-ns (`--unshare-pid --proc /proc`). It works → `Strict`,
/// otherwise `Disabled`. There is NO host-`/proc` fallback: a shared PID
/// namespace is a secret-exfil vector (FB HIGH-1), so a host that can't provide
/// a real PID namespace simply gets NO sandbox. `--unshare-net` (no network) is
/// probed too, matching the runtime argv.
pub fn probe_pid_ns(bwrap_path: &Path, rootfs_dir: &Path) -> PidNsMode {
    if !bwrap_path.is_absolute() {
        return PidNsMode::Disabled;
    }
    let rootfs_usr = rootfs_dir.join("usr");
    if !rootfs_usr.exists() {
        tracing::warn!("sandbox: rootfs not present at {}; PID-ns probe skipped", rootfs_dir.display());
        return PidNsMode::Disabled;
    }
    let rootfs_usr = rootfs_usr.to_string_lossy().to_string();

    let strict = StdCommand::new(bwrap_path)
        .args([
            "--unshare-user", "--uid", "1001", "--gid", "1001", "--unshare-pid",
            "--unshare-net", "--new-session", "--die-with-parent",
            "--ro-bind", &rootfs_usr, "/usr",
            "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
            "--", "/bin/true",
        ])
        .output();
    match strict {
        Ok(o) if o.status.success() => PidNsMode::Strict,
        // No `--dev-bind /proc` fallback — REFUSE rather than share host /proc.
        _ => PidNsMode::Disabled,
    }
}

/// Compile the seccomp filter once at boot. Active only when BOTH the
/// `sandbox_seccomp` cargo feature is on AND the target is Linux; else
/// `NotLinked` (the base build needs no libseccomp — DEC-7).
pub fn compile_seccomp_filter() -> SeccompMode {
    #[cfg(not(all(feature = "sandbox_seccomp", target_os = "linux")))]
    {
        SeccompMode::NotLinked
    }
    #[cfg(all(feature = "sandbox_seccomp", target_os = "linux"))]
    {
        match sandbox_seccomp::build_bpf() {
            Ok((bytes, unresolved)) => {
                if !unresolved.is_empty() {
                    tracing::warn!(unresolved = ?unresolved, "sandbox: some seccomp DENY entries did not resolve on this kernel");
                }
                SeccompMode::Loaded(std::sync::Arc::new(bytes))
            }
            Err(e) => {
                tracing::warn!("sandbox: seccomp filter build failed: {e}");
                SeccompMode::Disabled
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5: empty parent → None; controller tokenization rejects -memory /
    // memory_pressure, accepts whitespace tokens memory+pids.
    #[test]
    fn empty_cgroup_parent_is_none() {
        assert!(matches!(probe_cgroup(""), CgroupMode::None));
        assert!(matches!(probe_cgroup("   "), CgroupMode::None));
    }

    #[test]
    fn controller_tokenization() {
        assert!(cgroup_has_required_controllers("memory pids cpu"));
        assert!(cgroup_has_required_controllers("cpu pids memory"));
        // Denied-controller write form (`-memory`) must NOT count as delegated.
        assert!(!cgroup_has_required_controllers("-memory pids"));
        // Substring must not match.
        assert!(!cgroup_has_required_controllers("memory_pressure pids"));
        // Missing pids.
        assert!(!cgroup_has_required_controllers("memory cpu"));
        assert!(!cgroup_has_required_controllers(""));
    }

    // TEST-23 (FB HIGH-1): only a STRICT PID namespace is accepted; any
    // non-strict mode (incl. the old host-/proc DevBindFallback) is refused, so
    // the sandbox self-disables rather than run with a shared PID namespace.
    #[test]
    fn pidns_gate_accepts_only_strict() {
        assert!(pidns_accept(PidNsMode::Strict), "strict is the only run mode");
        assert!(!pidns_accept(PidNsMode::DevBindFallback), "no host /proc fallback");
        assert!(!pidns_accept(PidNsMode::Disabled));
    }

    // TEST-10: default build (feature off) → seccomp NotLinked.
    #[test]
    fn seccomp_not_linked_without_feature() {
        #[cfg(not(all(feature = "sandbox_seccomp", target_os = "linux")))]
        assert!(matches!(compile_seccomp_filter(), SeccompMode::NotLinked));
    }
}
