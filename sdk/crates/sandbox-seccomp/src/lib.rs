//! Single source of truth for the code-sandbox **seccomp policy**.
//!
//! The policy (which syscalls to deny, and with which errno) must be identical
//! on the Linux host backend (`code_sandbox/probes.rs`) and inside the
//! macOS/Windows microVM guests — otherwise the VM guests
//! would silently run with weaker syscall filtering than the Linux host. Both
//! consume this crate so the lists can never drift.
//!
//! Shape: a **default-allow denylist** (deliberate — R/torch's large, evolving
//! syscall surface makes a default-deny allowlist a perpetual maintenance/
//! breakage burden). Most denied syscalls return `EPERM`; the probe-and-
//! fallback families (`clone3` + the new mount API) return **`ENOSYS`** so
//! glibc/runtimes fall back to the legacy syscall instead of failing (this is
//! what keeps threaded/forked R working under seccomp). One rule looks at an
//! argument: `socket(2)` fails for the families in [`DENY_SOCKET_FAMILIES`].

/// Denied with **EPERM** — no caller fallback path; a hard "operation not
/// permitted" is correct.
pub const DENY_EPERM: &[&str] = &[
    // Tracing / cross-process introspection
    "ptrace",
    "perf_event_open",
    "process_vm_readv",
    "process_vm_writev",
    "pidfd_send_signal",
    "pidfd_getfd",
    "pidfd_open",
    "kcmp",
    // Kernel modification
    "bpf",
    "userfaultfd",
    "kexec_load",
    "kexec_file_load",
    "init_module",
    "finit_module",
    "delete_module",
    // Legacy module API
    "create_module",
    "query_module",
    "get_kernel_syms",
    // Keyring
    "keyctl",
    "add_key",
    "request_key",
    // Mount family — old API
    "mount",
    "umount",
    "umount2",
    "pivot_root",
    "chroot",
    // Namespace manipulation
    "setns",
    "unshare",
    // File-handle resolution — the "Shocker" container-breakout primitive.
    "open_by_handle_at",
    "name_to_handle_at",
    // Time is NOT namespaced — block wall-clock tampering.
    "clock_settime",
    "clock_adjtime",
    "settimeofday",
    "stime",
    // Kernel ring buffer — leaks KASLR pointers.
    "syslog",
    // Swap / power
    "swapon",
    "swapoff",
    "reboot",
    // I/O ring — recent escape vectors via io_uring SQE rewrites
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    // Direct hardware I/O ports
    "iopl",
    "ioperm",
    // Quotas + execution-domain switching + process accounting
    "quotactl",
    "personality",
    "acct",
    // NUMA memory-policy (best-effort in libs → EPERM tolerated)
    "migrate_pages",
    "mbind",
    "get_mempolicy",
    "set_mempolicy",
    "move_pages",
    // Misc obsolete / dangerous
    "lookup_dcookie",
    "nfsservctl",
    "uselib",
    "ustat",
    "vm86",
    "vm86old",
    "modify_ldt",
];

/// Denied with **ENOSYS** — callers probe these and fall back to the legacy
/// syscall only on `ENOSYS`. `EPERM` here would defeat the fallback and break
/// threaded/forked workloads (R `parallel::mclapply`, `data.table`, `torch` on
/// glibc ≥ 2.34). Matches Flatpak.
pub const DENY_ENOSYS: &[&str] = &[
    "clone3",
    "fsopen",
    "fsconfig",
    "fsmount",
    "move_mount",
    "open_tree",
    "mount_setattr",
];

/// A socket address family that `socket(2)` refuses inside the sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeniedSocketFamily {
    /// The `AF_*` number: `socket(2)`'s first argument, `int domain`.
    pub family: u32,
    /// The `AF_*` name, for logs and tests.
    pub name: &'static str,
    /// The errno `socket(2)` fails with.
    pub errno: i32,
}

/// Socket families a sandboxed method cannot create: a rule on `socket(2)`
/// whose first argument is one of these.
///
/// - `AF_VSOCK` (40): a network namespace does not isolate vsock. In the macOS
///   method VM it reaches the libkrun host side, and in the WSL 2 distro it
///   reaches Hyper-V socket services on the Windows host (CID 2). Methods
///   never need it. It fails with `EAFNOSUPPORT` (97), the answer of a kernel
///   without vsock, so a library that tries vsock sees "not available".
///
/// The numbers are those of x86_64 and aarch64, the only targets; the tests
/// check them against `libc`.
///
/// No other syscall gives a sandboxed method a socket of these families:
/// `socketpair(2)` makes no vsock pair (the kernel's vsock sockets have no
/// socketpair operation); `io_uring`, whose `IORING_OP_SOCKET` makes sockets
/// without `socket(2)`, is denied in [`DENY_EPERM`]; and the 32-bit x86
/// `socketcall(2)` is another architecture, on which the filter kills the
/// calling thread (libseccomp's default action for an architecture the
/// filter does not list).
pub const DENY_SOCKET_FAMILIES: &[DeniedSocketFamily] = &[DeniedSocketFamily {
    family: 40,
    name: "AF_VSOCK",
    errno: 97,
}];

/// Syscalls the **WSL agent's** filter answers with success without doing
/// them: `SCMP_ACT_ERRNO(0)` — the call returns 0 and changes nothing.
///
/// WSL has no cgroup cpuset, so a sandboxed method could otherwise call
/// `sched_setaffinity(2)` to widen its own CPU set back after the agent
/// pinned the command to the request's CPU slots. A no-op rather than EPERM,
/// because OpenMP runtimes and R/Python libraries that bind threads inside
/// their set call it and some do not handle a failure.
///
/// Only the WSL agent's filter uses this list. The Linux host runner and the
/// macOS VM keep the exact shared filter ([`build_bpf`]), byte for byte.
pub const NOOP_IN_WSL: &[&str] = &["sched_setaffinity"];

/// Compile the seccomp filter to its BPF byte image (for bwrap `--seccomp <fd>`).
/// Per-name best-effort for the deny lists: syscalls absent on the running
/// kernel are skipped (one failed lookup there must not disable the whole
/// filter). The exception is `socket`, which carries the socket family rules:
/// if it does not resolve, this returns an error. Returns the BPF bytes plus
/// the names that didn't resolve (callers may log them).
///
/// The shared filter: identical on the Linux host backend and in the VM
/// guests. (The WSL agent uses [`build_bpf_wsl`] instead.)
#[cfg(target_os = "linux")]
pub fn build_bpf() -> Result<(Vec<u8>, Vec<String>), String> {
    build_bpf_with_noop(&[])
}

/// [`build_bpf`] plus, for each name in [`NOOP_IN_WSL`], a rule that answers
/// the syscall with success (`SCMP_ACT_ERRNO(0)`) without executing it. WSL
/// mode only: in WSL there is no cgroup cpuset, so without this a method
/// could call `sched_setaffinity` to widen the CPU set the agent pinned.
/// Unresolved names join the returned list exactly like the deny lists'.
#[cfg(target_os = "linux")]
pub fn build_bpf_wsl() -> Result<(Vec<u8>, Vec<String>), String> {
    build_bpf_with_noop(NOOP_IN_WSL)
}

/// The shared builder, one private implementation so [`build_bpf`] and
/// [`build_bpf_wsl`] cannot drift: `noop` is the extra list of syscalls the
/// filter answers with success without doing them (empty for the shared
/// filter — byte for byte the filter [`build_bpf`] always produced).
#[cfg(target_os = "linux")]
fn build_bpf_with_noop(noop: &[&str]) -> Result<(Vec<u8>, Vec<String>), String> {
    use libseccomp::{ScmpAction, ScmpArgCompare, ScmpCompareOp, ScmpFilterContext, ScmpSyscall};

    let mut ctx =
        ScmpFilterContext::new_filter(ScmpAction::Allow).map_err(|e| format!("ctx: {e}"))?;
    let mut unresolved: Vec<String> = Vec::new();
    for (action, names) in [
        (ScmpAction::Errno(libc_eperm()), DENY_EPERM),
        (ScmpAction::Errno(libc_enosys()), DENY_ENOSYS),
    ] {
        for name in names {
            let sys = match ScmpSyscall::from_name(name) {
                Ok(s) => s,
                Err(_) => {
                    unresolved.push((*name).to_string());
                    continue;
                }
            };
            ctx.add_rule(action, sys)
                .map_err(|e| format!("add_rule {name}: {e}"))?;
        }
    }
    // socket(2) by family. Compare only the low 32 bits of the first
    // argument: the kernel reads it as `int domain`, so a caller can put
    // anything in the upper bits of the register, and a full 64-bit compare
    // would let `(1 << 32) | AF_VSOCK` through as AF_VSOCK.
    match ScmpSyscall::from_name("socket") {
        Ok(socket) => {
            for f in DENY_SOCKET_FAMILIES {
                let domain = ScmpArgCompare::new(
                    0,
                    ScmpCompareOp::MaskedEqual(u64::from(u32::MAX)),
                    u64::from(f.family),
                );
                ctx.add_rule_conditional(ScmpAction::Errno(f.errno), socket, &[domain])
                    .map_err(|e| format!("add_rule socket {}: {e}", f.name))?;
            }
        }
        // The socket rule is the only guard against AF_VSOCK in the sandbox,
        // so without it no filter is built. What a caller then does differs:
        // the guest agent refuses every sandboxed command that asks for
        // seccomp; the Linux host runner (probes.rs compile_seccomp_filter)
        // reports seccomp as Disabled and runs bwrap without a filter.
        // libseccomp resolves names from its own table, so this does not
        // happen on x86_64 or aarch64.
        Err(_) => return Err("socket(2) does not resolve here: the socket family rules cannot be added".into()),
    }
    for name in noop {
        let sys = match ScmpSyscall::from_name(name) {
            Ok(s) => s,
            Err(_) => {
                unresolved.push((*name).to_string());
                continue;
            }
        };
        ctx.add_rule(ScmpAction::Errno(0), sys).map_err(|e| format!("add_rule {name}: {e}"))?;
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut f = tempfile::tempfile().map_err(|e| format!("tempfile: {e}"))?;
    ctx.export_bpf(&mut f).map_err(|e| format!("export_bpf: {e}"))?;
    use std::io::{Read, Seek, SeekFrom};
    f.seek(SeekFrom::Start(0)).map_err(|e| format!("seek: {e}"))?;
    f.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    Ok((buf, unresolved))
}

// Avoid a libc dep just for two errno constants.
#[cfg(target_os = "linux")]
fn libc_eperm() -> i32 {
    1
}
#[cfg(target_os = "linux")]
fn libc_enosys() -> i32 {
    38
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn build_produces_nonempty_bpf() {
        let (bpf, _unresolved) = build_bpf().expect("seccomp filter builds");
        assert!(!bpf.is_empty(), "exported BPF must be non-empty");
    }

    #[test]
    fn deny_lists_are_disjoint_and_classified_correctly() {
        assert!(!DENY_EPERM.is_empty());
        assert!(!DENY_ENOSYS.is_empty());
        for n in DENY_ENOSYS {
            assert!(!DENY_EPERM.contains(n), "{n} must not be in both lists");
        }
        for n in ["clone3", "fsopen", "fsconfig", "fsmount", "move_mount", "open_tree", "mount_setattr"] {
            assert!(DENY_ENOSYS.contains(&n), "{n} must be in DENY_ENOSYS");
        }
        assert!(DENY_EPERM.contains(&"open_by_handle_at"));
        assert!(DENY_EPERM.contains(&"name_to_handle_at"));
    }

    /// Security-critical breakout syscalls that MUST stay classified EPERM.
    /// This table is the authoritative pin: derived from the current
    /// `DENY_EPERM` contents AND txresbench's `code_sandbox/tier4_seccomp.rs`
    /// `PROD_DENY_LIST`. If anyone deletes one of these from `DENY_EPERM`,
    /// `deny_eperm_pins_every_breakout_syscall` fails closed. Do NOT prune
    /// this table to make it pass — a name missing from `DENY_EPERM` is a
    /// hardening regression, not a stale test.
    const MUST_CONTAIN_EPERM: &[&str] = &[
        // Tracing / cross-process introspection
        "ptrace",
        "perf_event_open",
        "process_vm_readv",
        "process_vm_writev",
        "pidfd_send_signal",
        "pidfd_getfd",
        "pidfd_open",
        // Kernel modification
        "bpf",
        "userfaultfd",
        "kexec_load",
        "kexec_file_load",
        "init_module",
        "finit_module",
        "delete_module",
        // Keyring
        "keyctl",
        "add_key",
        "request_key",
        // Mount family (old API)
        "mount",
        "umount",
        "umount2",
        "pivot_root",
        "chroot",
        // Namespace manipulation
        "setns",
        "unshare",
        // File-handle resolution — the "Shocker" container-breakout primitive.
        "open_by_handle_at",
        "name_to_handle_at",
        // I/O ring — recent escape vectors
        "io_uring_setup",
        "io_uring_enter",
        "io_uring_register",
        // Direct hardware I/O ports
        "iopl",
        "ioperm",
        // Reboot / swap / quota class
        "reboot",
        "swapon",
        "swapoff",
        "quotactl",
        // Execution-domain switching
        "personality",
    ];

    /// The ENOSYS-classified probe-and-fallback names that MUST stay in
    /// `DENY_ENOSYS` (reclassifying any to EPERM would break threaded/forked
    /// R/torch workloads; deleting one silently unblocks a mount/clone vector).
    const MUST_CONTAIN_ENOSYS: &[&str] = &[
        "clone3",
        "fsopen",
        "fsconfig",
        "fsmount",
        "move_mount",
        "open_tree",
        "mount_setattr",
    ];

    #[test]
    fn deny_eperm_pins_every_breakout_syscall() {
        for name in MUST_CONTAIN_EPERM {
            assert!(
                DENY_EPERM.contains(name),
                "SECURITY REGRESSION: '{name}' was removed from DENY_EPERM — a \
                 sandbox-breakout syscall is no longer denied. Restore it; do \
                 not edit MUST_CONTAIN_EPERM."
            );
            // And it must NOT have been (mis)moved to the ENOSYS list, which
            // would let a fallback path re-enable it.
            assert!(
                !DENY_ENOSYS.contains(name),
                "SECURITY REGRESSION: breakout syscall '{name}' is classified \
                 ENOSYS — that opens a caller fallback path; it must be EPERM."
            );
        }
    }

    #[test]
    fn deny_enosys_pins_every_probe_and_fallback_syscall() {
        for name in MUST_CONTAIN_ENOSYS {
            assert!(
                DENY_ENOSYS.contains(name),
                "SECURITY REGRESSION: '{name}' was removed from DENY_ENOSYS — a \
                 mount/clone probe-and-fallback syscall is no longer filtered. \
                 Restore it; do not edit MUST_CONTAIN_ENOSYS."
            );
        }
    }

    #[test]
    fn deny_lists_have_no_internal_duplicates() {
        // These are hand-maintained lists; a copy-paste dup is a real
        // maintenance bug (harmless at runtime but a sign of an editing error
        // and it inflates the filter). Assert each name is unique within its
        // list AND non-empty.
        for (label, list) in [("DENY_EPERM", DENY_EPERM), ("DENY_ENOSYS", DENY_ENOSYS)] {
            let mut seen = std::collections::HashSet::new();
            for name in list {
                assert!(!name.is_empty(), "{label} contains an empty syscall name");
                assert!(seen.insert(*name), "{label} contains duplicate '{name}'");
            }
        }
    }

    #[test]
    fn build_bpf_reports_unresolved_for_fabricated_syscall() {
        // Sanity-check the per-name best-effort contract: an unknown syscall
        // name is collected into `unresolved` instead of aborting the whole
        // filter. We can't inject into the const lists, so this asserts the
        // real lists resolve without error and the BPF is non-empty (the
        // unresolved vec being small/empty on a modern kernel is expected).
        let (bpf, unresolved) = build_bpf().expect("filter builds");
        assert!(!bpf.is_empty());
        // Every reported unresolved name must be one we actually asked for.
        for name in &unresolved {
            assert!(
                DENY_EPERM.contains(&name.as_str()) || DENY_ENOSYS.contains(&name.as_str()),
                "unresolved name '{name}' was never in a deny list"
            );
        }
    }

    #[test]
    fn wsl_filter_builds_and_differs_from_the_shared_filter() {
        let (shared, _) = build_bpf().expect("shared filter builds");
        let (wsl, _) = build_bpf_wsl().expect("WSL filter builds");
        assert!(!shared.is_empty(), "exported BPF must be non-empty");
        assert!(!wsl.is_empty(), "exported BPF must be non-empty");
        assert_ne!(
            shared, wsl,
            "the WSL filter must differ from the shared one: it adds the NOOP_IN_WSL rules"
        );
    }

    #[test]
    fn noop_in_wsl_names_are_in_no_deny_list() {
        // A name in NOOP_IN_WSL must never also be denied: the no-op answer
        // (success) would then lose to the deny rule (or vice versa) and the
        // method would either widen its CPU set again or be broken by EPERM.
        // `sched_setaffinity` must be the pinned member (an empty list would
        // make this test pass vacuously).
        assert!(
            NOOP_IN_WSL.contains(&"sched_setaffinity"),
            "the WSL no-op list must pin sched_setaffinity"
        );
        for n in NOOP_IN_WSL {
            assert!(!DENY_EPERM.contains(n), "{n} is in DENY_EPERM and NOOP_IN_WSL");
            assert!(!DENY_ENOSYS.contains(n), "{n} is in DENY_ENOSYS and NOOP_IN_WSL");
        }
    }

    #[test]
    fn deny_socket_families_pins_af_vsock() {
        let vsock = DENY_SOCKET_FAMILIES
            .iter()
            .find(|f| f.name == "AF_VSOCK")
            .expect(
                "SECURITY REGRESSION: AF_VSOCK was removed from DENY_SOCKET_FAMILIES — a \
                 sandboxed method could reach the VM or WSL host over vsock again. Restore it.",
            );
        assert_eq!(vsock.family, libc::AF_VSOCK as u32, "AF_VSOCK's number on this target");
        assert_eq!(
            vsock.errno,
            libc::EAFNOSUPPORT,
            "AF_VSOCK fails with EAFNOSUPPORT (this target's number), what a kernel without vsock answers"
        );
    }

    #[test]
    fn deny_socket_families_are_named_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for f in DENY_SOCKET_FAMILIES {
            assert!(f.name.starts_with("AF_"), "{f:?}: name it by its AF_* constant");
            assert!(f.errno > 0, "{f:?}: an errno");
            assert!(seen.insert(f.family), "DENY_SOCKET_FAMILIES lists family {} twice", f.family);
        }
    }

    #[test]
    fn the_socket_rule_resolves() {
        let (_bpf, unresolved) = build_bpf().expect("filter builds");
        assert!(
            !unresolved.iter().any(|n| n == "socket"),
            "socket(2) did not resolve, so no family is denied: {unresolved:?}"
        );
    }

    /// A `socket(2)` type flag the kernel does not know. The kernel fails such
    /// a call with EINVAL before it looks at the family, and the filter answers
    /// before the kernel: for these calls an EAFNOSUPPORT comes from the filter,
    /// on any kernel, with or without vsock.
    #[cfg(target_pointer_width = "64")]
    const BAD_TYPE_FLAG: libc::c_long = 0x4000_0000;
    /// A bit above the 32 of `int domain`: the kernel drops it.
    #[cfg(target_pointer_width = "64")]
    const HIGH_BIT: libc::c_long = 1 << 32;

    /// A call a sandboxed process could make to get a vsock socket.
    #[derive(Clone, Copy, Debug)]
    enum Call {
        /// `socket(domain, type, 0)`, as a raw syscall so that `domain` can
        /// carry bits above the 32 of an `int`.
        Socket(libc::c_long, libc::c_long),
        /// `socketpair(domain, type, 0, fds)`.
        SocketPair(libc::c_long, libc::c_long),
        /// `io_uring_setup(1, params)`: a ring makes sockets without `socket(2)`.
        IoUringSetup,
    }

    /// Make `call`: 0 if it gave fds (closed again at once), else its errno.
    /// Only raw syscalls, no allocation: it runs in a forked child.
    fn make(call: Call) -> i32 {
        // SAFETY: syscalls on memory of this frame; the fds they return are
        // closed here.
        unsafe {
            let rc = match call {
                Call::Socket(domain, ty) => {
                    let fd = libc::syscall(libc::SYS_socket, domain, ty, 0 as libc::c_long);
                    if fd >= 0 {
                        libc::close(fd as libc::c_int);
                    }
                    fd
                }
                Call::SocketPair(domain, ty) => {
                    let mut fds: [libc::c_int; 2] = [-1, -1];
                    let rc =
                        libc::syscall(libc::SYS_socketpair, domain, ty, 0 as libc::c_long, fds.as_mut_ptr());
                    if rc == 0 {
                        libc::close(fds[0]);
                        libc::close(fds[1]);
                    }
                    rc
                }
                Call::IoUringSetup => {
                    // struct io_uring_params is 120 bytes; zeroed asks for defaults.
                    let mut params = [0u64; 15];
                    let fd = libc::syscall(libc::SYS_io_uring_setup, 1 as libc::c_long, params.as_mut_ptr());
                    if fd >= 0 {
                        libc::close(fd as libc::c_int);
                    }
                    fd
                }
            };
            if rc < 0 {
                *libc::__errno_location()
            } else {
                0
            }
        }
    }

    /// build_bpf's bytes as BPF instructions, as bwrap reads them from its
    /// `--seccomp` fd.
    fn policy_filter() -> Vec<libc::sock_filter> {
        let (bytes, _) = build_bpf().expect("filter builds");
        bytes_to_instructions(&bytes)
    }

    /// build_bpf_wsl's bytes as BPF instructions (see [`policy_filter`]).
    fn policy_filter_wsl() -> Vec<libc::sock_filter> {
        let (bytes, _) = build_bpf_wsl().expect("filter builds");
        bytes_to_instructions(&bytes)
    }

    /// Split exported BPF bytes into the `sock_filter` instructions the
    /// kernel loads: 8-byte little-endian instructions.
    fn bytes_to_instructions(bytes: &[u8]) -> Vec<libc::sock_filter> {
        assert_eq!(bytes.len() % 8, 0, "whole BPF instructions");
        bytes
            .chunks_exact(8)
            .map(|i| libc::sock_filter {
                code: u16::from_ne_bytes([i[0], i[1]]),
                jt: i[2],
                jf: i[3],
                k: u32::from_ne_bytes([i[4], i[5], i[6], i[7]]),
            })
            .collect()
    }

    /// In a forked child: load `filter` the way bwrap does (no_new_privs, then
    /// PR_SET_SECCOMP), make `calls`, and return what each answered.
    /// `Err(errno)` when the kernel refused the filter.
    fn in_filtered_child(filter: &[libc::sock_filter], calls: &[Call]) -> Result<Vec<i32>, i32> {
        use std::io::Read;
        use std::os::fd::FromRawFd;

        const MAX: usize = 16;
        assert!(calls.len() <= MAX);
        let prog = libc::sock_fprog {
            len: u16::try_from(filter.len()).expect("a filter of at most 65535 instructions"),
            filter: filter.as_ptr().cast_mut(),
        };
        let mut pipe: [libc::c_int; 2] = [-1, -1];
        // SAFETY: pipe2 fills the array it is given.
        assert_eq!(unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        // SAFETY: the child makes only raw syscalls (no allocation, no locks)
        // and leaves with _exit.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork: {}", std::io::Error::last_os_error());
        if pid == 0 {
            // SAFETY: as above; `prog` points at `filter`, alive in this copy.
            unsafe {
                // out[0]: 0 when the filter is loaded, else the errno; then one answer per call.
                let mut out = [0i32; MAX + 1];
                let none: libc::c_ulong = 0;
                let loaded = libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, none, none, none) == 0
                    && libc::prctl(
                        libc::PR_SET_SECCOMP,
                        libc::SECCOMP_MODE_FILTER as libc::c_ulong,
                        &prog as *const libc::sock_fprog,
                    ) == 0;
                let words = if loaded {
                    for (i, call) in calls.iter().enumerate() {
                        out[i + 1] = make(*call);
                    }
                    calls.len() + 1
                } else {
                    out[0] = *libc::__errno_location();
                    1
                };
                libc::write(pipe[1], out.as_ptr().cast(), words * 4);
                libc::_exit(0);
            }
        }
        // SAFETY: closing this process's copy of the write end; the read end
        // becomes the File's.
        let mut answers = unsafe {
            libc::close(pipe[1]);
            std::fs::File::from_raw_fd(pipe[0])
        };
        let mut bytes = Vec::new();
        answers.read_to_end(&mut bytes).expect("read the child's answers");
        let mut status = 0;
        // SAFETY: waits for the child forked above.
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
            "the filtered child did not exit 0 (wait status {status:#x})"
        );
        let words: Vec<i32> = bytes
            .chunks_exact(4)
            .map(|w| i32::from_ne_bytes([w[0], w[1], w[2], w[3]]))
            .collect();
        match words.split_first() {
            Some((0, answers)) if answers.len() == calls.len() => Ok(answers.to_vec()),
            Some((&errno, [])) if errno != 0 => Err(errno),
            _ => panic!("the child's answers make no sense: {words:?}"),
        }
    }

    /// In a forked child: load `filter` (no_new_privs + PR_SET_SECCOMP) and
    /// then call `sched_setaffinity(0, {the first of the child's allowed
    /// CPUs})` — exactly the widening call a method could make. Reports the
    /// call's return value and the affinity mask before and after it; `before`
    /// is the mask the child inherited from the test process, so the no-op is
    /// visible: the shared filter still lets the call through and the mask
    /// narrows to the one CPU, while the WSL filter answers with success and
    /// the mask is unchanged. `Err(errno)` when the kernel refused the filter.
    #[cfg(target_pointer_width = "64")]
    fn in_filtered_child_sched(filter: &[libc::sock_filter]) -> Result<(i32, Vec<usize>, Vec<usize>), i32> {
        use std::io::Read;
        use std::os::fd::FromRawFd;

        let prog = libc::sock_fprog {
            len: u16::try_from(filter.len()).expect("a filter of at most 65535 instructions"),
            filter: filter.as_ptr().cast_mut(),
        };
        let size = std::mem::size_of::<libc::cpu_set_t>();
        let mut pipe: [libc::c_int; 2] = [-1, -1];
        // SAFETY: pipe2 fills the array it is given.
        assert_eq!(unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        // SAFETY: the child makes only raw syscalls (no allocation, no locks)
        // and leaves with _exit.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork: {}", std::io::Error::last_os_error());
        if pid == 0 {
            // SAFETY: as above; `prog` points at `filter`, alive in this copy.
            unsafe {
                // The report: [loaded, errno_or_rc, before bytes, after bytes].
                let mut out = [0u8; 8 + 2 * std::mem::size_of::<libc::cpu_set_t>()];
                let none: libc::c_ulong = 0;
                let loaded = libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, none, none, none) == 0
                    && libc::prctl(
                        libc::PR_SET_SECCOMP,
                        libc::SECCOMP_MODE_FILTER as libc::c_ulong,
                        &prog as *const libc::sock_fprog,
                    ) == 0;
                if loaded {
                    let mut before = std::mem::MaybeUninit::<libc::cpu_set_t>::zeroed();
                    let mut after = std::mem::MaybeUninit::<libc::cpu_set_t>::zeroed();
                    if libc::sched_getaffinity(0, size, before.as_mut_ptr()) == 0 {
                        let before = before.assume_init();
                        let first = (0..libc::CPU_SETSIZE as usize)
                            .find(|&c| libc::CPU_ISSET(c, &before))
                            .unwrap_or(0);
                        let mut one = std::mem::MaybeUninit::<libc::cpu_set_t>::zeroed();
                        // SAFETY: CPU_ZERO initializes the whole set; the CPU
                        // is below CPU_SETSIZE, CPU_SET's domain.
                        libc::CPU_ZERO(&mut *one.as_mut_ptr());
                        libc::CPU_SET(first, &mut *one.as_mut_ptr());
                        let one = one.assume_init();
                        let rc = libc::sched_setaffinity(0, size, &one);
                        libc::sched_getaffinity(0, size, after.as_mut_ptr());
                        let after = after.assume_init();
                        out[..4].copy_from_slice(&1u32.to_ne_bytes());
                        out[4..8].copy_from_slice(&(rc as u32).to_ne_bytes());
                        out[8..8 + size].copy_from_slice(std::slice::from_raw_parts(
                            &before as *const libc::cpu_set_t as *const u8,
                            size,
                        ));
                        out[8 + size..].copy_from_slice(std::slice::from_raw_parts(
                            &after as *const libc::cpu_set_t as *const u8,
                            size,
                        ));
                    } else {
                        // sched_getaffinity itself failed: report as an odd
                        // rc so the parent cannot mistake it for a no-op.
                        out[..4].copy_from_slice(&1u32.to_ne_bytes());
                        out[4..8].copy_from_slice(&(-2i32 as u32).to_ne_bytes());
                    }
                } else {
                    out[4..8].copy_from_slice(&((*libc::__errno_location()) as u32).to_ne_bytes());
                }
                libc::write(pipe[1], out.as_ptr().cast(), out.len());
                libc::_exit(0);
            }
        }
        // SAFETY: closing this process's copy of the write end; the read end
        // becomes the File's.
        let mut answers = unsafe {
            libc::close(pipe[1]);
            std::fs::File::from_raw_fd(pipe[0])
        };
        let mut bytes = Vec::new();
        answers.read_to_end(&mut bytes).expect("read the child's answers");
        let mut status = 0;
        // SAFETY: waits for the child forked above.
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
            "the filtered child did not exit 0 (wait status {status:#x})"
        );
        if bytes.len() != 8 + 2 * size {
            panic!("the child's report has {} bytes, want {}", bytes.len(), 8 + 2 * size);
        }
        let loaded = u32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if loaded != 1 {
            let errno = i32::from_ne_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
            return Err(errno);
        }
        let rc = i32::from_ne_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let decode = |slice: &[u8]| {
            let set = unsafe { &*(slice.as_ptr() as *const libc::cpu_set_t) };
            (0..libc::CPU_SETSIZE as usize)
                .filter(|&c| unsafe { libc::CPU_ISSET(c, set) })
                .collect::<Vec<usize>>()
        };
        Ok((rc, decode(&bytes[8..8 + size]), decode(&bytes[8 + size..])))
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn a_filtered_process_cannot_create_a_vsock_socket() {
        use libc::c_long;
        let (vsock, unix, inet) = (libc::AF_VSOCK as c_long, libc::AF_UNIX as c_long, libc::AF_INET as c_long);
        let (stream, dgram) = (libc::SOCK_STREAM as c_long, libc::SOCK_DGRAM as c_long);
        let refused = Some(libc::EAFNOSUPPORT);
        // Each with what it must answer under the filter: an errno, 0 for
        // success, or None for anything but success.
        let cases = [
            ("socket(AF_VSOCK, SOCK_STREAM)", Call::Socket(vsock, stream), refused),
            ("socket(AF_VSOCK, SOCK_DGRAM)", Call::Socket(vsock, dgram), refused),
            ("socket(AF_VSOCK, a bad type flag)", Call::Socket(vsock, stream | BAD_TYPE_FLAG), refused),
            ("socket(AF_VSOCK + bit 32, SOCK_STREAM)", Call::Socket(HIGH_BIT | vsock, stream), refused),
            (
                "socket(AF_VSOCK + bit 32, a bad type flag)",
                Call::Socket(HIGH_BIT | vsock, stream | BAD_TYPE_FLAG),
                refused,
            ),
            ("socketpair(AF_VSOCK, SOCK_STREAM)", Call::SocketPair(vsock, stream), None),
            ("io_uring_setup", Call::IoUringSetup, Some(libc::EPERM)),
            ("socket(AF_UNIX, SOCK_STREAM)", Call::Socket(unix, stream), Some(0)),
            ("socket(AF_INET, SOCK_DGRAM)", Call::Socket(inet, dgram), Some(0)),
        ];
        let calls: Vec<Call> = cases.iter().map(|c| c.1).collect();
        let got = match in_filtered_child(&policy_filter(), &calls) {
            Ok(got) => got,
            Err(errno) => {
                // Only a system that refuses every filter may skip this, such
                // as Docker's amd64 emulation on an arm64 Mac.
                let allow_all = [libc::sock_filter {
                    code: (libc::BPF_RET | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ALLOW,
                }];
                match in_filtered_child(&allow_all, &[]) {
                    Err(any) => {
                        eprintln!(
                            "SKIPPED: this system refuses every seccomp filter (errno {any}); \
                             the vsock rule was not checked in a kernel"
                        );
                        return;
                    }
                    Ok(_) => panic!("the kernel refused the policy's filter (errno {errno}) but takes an allow-all one"),
                }
            }
        };
        for ((what, _, want), got) in cases.iter().zip(&got) {
            match want {
                Some(want) => assert_eq!(got, want, "{what} under the filter: errno {got} (0 = success)"),
                None => assert_ne!(*got, 0, "{what} under the filter gave sockets"),
            }
        }
        // The same vsock calls without the filter. The bad-flag cases above
        // already prove the filter answered (the kernel says EINVAL to them
        // before it looks at the family); this only records that the
        // kernel answers some of these calls differently.
        let bare: Vec<(&str, i32)> = cases[..5]
            .iter()
            .map(|(what, call, _)| (*what, make(*call)))
            .collect();
        eprintln!("without the filter (errno, 0 = success): {bare:?}");
        assert!(
            bare.iter().any(|(_, r)| *r != libc::EAFNOSUPPORT),
            "every vsock call fails with EAFNOSUPPORT here without the filter too: {bare:?}"
        );
    }

    /// The WSL filter must turn `sched_setaffinity(2)` into a no-op that
    /// returns success, and only the WSL filter.
    ///
    /// The shared one (Linux host + VM guests) must still let the call
    /// through, so the two known filters differ on exactly this behavior: the
    /// kernel observes what the agent promised.
    #[test]
    #[cfg(target_pointer_width = "64")]
    fn wsl_filter_noops_sched_setaffinity_while_the_shared_one_still_narrows() {
        let (rc, before, after) = match in_filtered_child_sched(&policy_filter_wsl()) {
            Ok(report) => report,
            Err(errno) => {
                // Only a system that refuses every filter may skip this, such
                // as Docker's amd64 emulation on an arm64 Mac.
                let allow_all = [libc::sock_filter {
                    code: (libc::BPF_RET | libc::BPF_K) as u16,
                    jt: 0,
                    jf: 0,
                    k: libc::SECCOMP_RET_ALLOW,
                }];
                match in_filtered_child_sched(&allow_all) {
                    Err(any) => {
                        eprintln!(
                            "SKIPPED: this system refuses every seccomp filter (errno {any}); \
                             the sched_setaffinity no-op was not checked in a kernel"
                        );
                        return;
                    }
                    Ok(_) => panic!(
                        "the kernel refused the WSL filter (errno {errno}) but takes an allow-all one"
                    ),
                }
            }
        };
        assert!(!before.is_empty(), "the forked child must run on at least one CPU");
        let first = before[0];
        assert_eq!(
            rc, 0,
            "the WSL filter answers sched_setaffinity with success (a no-op, not EPERM): rc {rc}"
        );
        assert_eq!(
            after, before,
            "the WSL filter no-ops the call: the affinity mask is unchanged (before {before:?}, after {after:?})"
        );

        let (rc, _before, after) =
            in_filtered_child_sched(&policy_filter()).expect("the shared filter loads (the WSL one did)");
        assert_eq!(rc, 0, "the shared filter still lets sched_setaffinity through: rc {rc}");
        assert_eq!(
            after,
            vec![first],
            "under the shared filter the call narrows the mask to the one CPU: {after:?}"
        );
    }
}
