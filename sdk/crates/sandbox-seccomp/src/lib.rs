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

/// Compile the seccomp filter to its BPF byte image (for bwrap `--seccomp <fd>`).
/// Per-name best-effort: syscalls absent on the running kernel are skipped (a
/// failed lookup must never disable the whole filter). Returns the BPF bytes
/// plus the names that didn't resolve (callers may log them).
#[cfg(target_os = "linux")]
pub fn build_bpf() -> Result<(Vec<u8>, Vec<String>), String> {
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
        // The socket rule is the only guard against AF_VSOCK in the sandbox:
        // without it, refuse to build the filter (the agent then refuses
        // every sandboxed command that asks for seccomp) rather than run
        // methods with vsock open. libseccomp resolves names from its own
        // table, so this does not happen on x86_64 or aarch64.
        Err(_) => return Err("socket(2) does not resolve here: the socket family rules cannot be added".into()),
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
}
