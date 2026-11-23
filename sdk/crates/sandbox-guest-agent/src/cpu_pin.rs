//! CPU affinity pinning for the command the agent runs.
//!
//! The host sends CPU *slots*, not raw CPU numbers: WSL has its own CPU
//! numbering (it may expose fewer CPUs than Windows), so the host cannot name
//! guest CPUs. A slot `s` means the agent's `s % n`-th allowed CPU (the
//! ascending list from its own `sched_getaffinity`, `n` = its length); this
//! module resolves slots to real CPUs and pins the bwrap child to them before
//! exec, so bwrap and everything the method starts inherit that CPU set.

/// Resolve CPU slots against the agent's allowed CPUs. Slot `s` maps to
/// `allowed[s % allowed.len()]`; the result is deduplicated and sorted
/// ascending. An empty `allowed` or an empty `slots` gives an empty vec
/// (no pinning).
pub fn pinned_cpus(allowed: &[usize], slots: &[u32]) -> Vec<usize> {
    if allowed.is_empty() || slots.is_empty() {
        return Vec::new();
    }
    let mut cpus: Vec<usize> = slots
        .iter()
        .map(|&s| allowed[s as usize % allowed.len()])
        .collect();
    cpus.sort_unstable();
    cpus.dedup();
    cpus
}

/// The agent's own allowed CPUs — its `sched_getaffinity(0, ...)` — as an
/// ascending list, one entry per CPU in the mask.
#[cfg(target_os = "linux")]
pub fn allowed_cpus() -> std::io::Result<Vec<usize>> {
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::cpu_set_t>();
    // SAFETY: `set` is a valid, all-zero (empty) cpu_set_t; `sched_getaffinity`
    // writes exactly `size` bytes over it on success, and on failure (rc < 0)
    // the set is never read.
    let rc = unsafe { libc::sched_getaffinity(0, size, &mut set) };
    if rc < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut cpus = Vec::new();
    for cpu in 0..libc::CPU_SETSIZE as usize {
        // SAFETY: `cpu < CPU_SETSIZE`, the domain `CPU_ISSET` is defined on.
        if unsafe { libc::CPU_ISSET(cpu, &set) } {
            cpus.push(cpu);
        }
    }
    Ok(cpus)
}

/// Make the command's child run on exactly `cpus`: builds the `cpu_set_t`
/// (zeroed, then one bit per CPU) BEFORE spawn and installs a `pre_exec`
/// closure that sets the child's affinity between fork and exec. A cmd may
/// already carry a pre_exec (e.g. the seccomp fd); closures run in order.
#[cfg(target_os = "linux")]
pub fn pin_command(cmd: &mut tokio::process::Command, cpus: &[usize]) {
    // Start from an all-zero (empty) cpu_set_t, then CPU_ZERO (no-op here,
    // but the canonical clears-it call) and CPU_SET add the bits, all BEFORE
    // spawn; a `pre_exec` closure sets the child's affinity between fork and
    // exec. A cmd may already carry a pre_exec (e.g. the seccomp fd);
    // closures run in order.
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    // SAFETY: `set` is a valid, fully initialized cpu_set_t; `CPU_ZERO`
    // clears it and every `CPU_SET` uses `cpu < CPU_SETSIZE`, the domain
    // `CPU_ZERO`/`CPU_SET` are defined on.
    unsafe {
        libc::CPU_ZERO(&mut set);
        for &cpu in cpus {
            // A CPU at or past CPU_SETSIZE cannot be represented; skip it.
            // (Callers only pass CPUs from `allowed_cpus()`, all under it.)
            if cpu < libc::CPU_SETSIZE as usize {
                libc::CPU_SET(cpu, &mut set);
            }
        }
    }
    // SAFETY: the closure runs in the child, between fork and exec: only
    // async-signal-safe code may run there, and it makes exactly one syscall
    // — no allocation, no logging. The `sched_setaffinity` return value is
    // deliberately ignored: a failure leaves the child unpinned, and pinning
    // is a resource control that must never stop a run.
    unsafe {
        cmd.pre_exec(move || {
            libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set);
            Ok(())
        });
    }
}

/// Parse the `Cpus_allowed_list` line of `/proc/<pid>/status` — ranges like
/// `0-3,8,10-11` — into an ascending CPU list. Test-only, used both here and
/// by the exec-path tests in `main.rs`.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn parse_cpus_allowed_list(text: &str) -> Vec<usize> {
    let line = text
        .lines()
        .find(|l| l.starts_with("Cpus_allowed_list:"))
        .expect("Cpus_allowed_list present");
    let list = line.split_once(':').map(|(_, rest)| rest.trim()).unwrap_or_default();
    let mut cpus = Vec::new();
    for part in list.split(',') {
        if part.is_empty() {
            continue;
        }
        if let Some((lo, hi)) = part.split_once('-') {
            let lo: usize = lo.parse().expect("range start is a number");
            let hi: usize = hi.parse().expect("range end is a number");
            cpus.extend(lo..=hi);
        } else {
            cpus.push(part.parse().expect("cpu is a number"));
        }
    }
    cpus
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_cpus_maps_slots_wraps_and_dedupes() {
        // Slots are indices into `allowed`, not CPU numbers.
        assert_eq!(pinned_cpus(&(0..8).collect::<Vec<_>>(), &[2, 3]), vec![2, 3]);
        assert_eq!(pinned_cpus(&[4, 5, 6, 7], &[0, 1]), vec![4, 5]);
        // Wrap (slot 2 → allowed[0]) + dedupe + sorted ascending.
        assert_eq!(pinned_cpus(&[0, 1], &[1, 2, 3]), vec![0, 1]);
        // No slots or no allowed CPUs: no pinning.
        assert!(pinned_cpus(&[0, 1], &[]).is_empty());
        assert!(pinned_cpus(&[], &[1, 2, 3]).is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn allowed_cpus_is_ascending_and_matches_proc_self_status() {
        let cpus = allowed_cpus().expect("sched_getaffinity succeeds");
        assert!(!cpus.is_empty(), "the test process must run on at least one CPU");
        assert!(cpus.windows(2).all(|w| w[0] < w[1]), "strictly ascending: {cpus:?}");
        assert!(cpus.iter().all(|&c| c < libc::CPU_SETSIZE as usize), "{cpus:?}");
        let status = std::fs::read_to_string("/proc/self/status").expect("/proc/self/status readable");
        assert_eq!(cpus, parse_cpus_allowed_list(&status), "matches Cpus_allowed_list");
    }

    #[cfg(target_os = "linux")]
    async fn run_pinned(cpus: &[usize]) -> Vec<usize> {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", "grep Cpus_allowed_list /proc/self/status"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        pin_command(&mut cmd, cpus);
        let out = cmd.output().await.expect("sh runs");
        assert!(out.status.success(), "sh failed: {}", String::from_utf8_lossy(&out.stderr));
        parse_cpus_allowed_list(&String::from_utf8_lossy(&out.stdout))
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn pin_command_pins_the_child_to_the_requested_cpus() {
        let allowed = allowed_cpus().expect("sched_getaffinity succeeds");
        assert!(!allowed.is_empty(), "the test process must run on at least one CPU");
        // The first allowed CPU, and (with at least 2) the last one.
        assert_eq!(run_pinned(&[allowed[0]]).await, vec![allowed[0]]);
        if allowed.len() >= 2 {
            let last = *allowed.last().unwrap();
            assert_eq!(run_pinned(&[last]).await, vec![last]);
        }
    }
}
