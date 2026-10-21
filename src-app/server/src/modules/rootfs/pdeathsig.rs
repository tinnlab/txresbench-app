//! Spawn a child process that ACTUALLY dies with this server process.
//!
//! ## The trap this module exists to close
//!
//! `prctl(PR_SET_PDEATHSIG)` is a per-THREAD relationship, not a per-process one.
//! From `prctl(2)`:
//!
//! > The "parent" in this case is considered to be the *thread that created this
//! > process*. In other words, the signal will be sent when that thread
//! > terminates (via, for example, `pthread_exit(3)`), rather than after all of
//! > the threads in the parent process exit.
//!
//! The squashfuse mount in [`super::mount`] is reached from
//! `tokio::task::spawn_blocking` (`sandbox::service::…` and
//! `sandbox::backend::local_bwrap::…` both call `OciEnvImageProvider::provide`
//! there, which lands in `rootfs::ensure_ready{,_by_digest}`). Tokio reaps an
//! IDLE blocking-pool thread after `thread_keep_alive` (default ~10s). So a
//! squashfuse spawned directly on that thread is SIGTERM'd by the kernel roughly
//! ten seconds later — while the server is still running and still using the
//! mount.
//!
//! Observed downstream: `ENOTCONN` / "Transport endpoint is not connected" on
//! lookups, `SIGBUS` when a page fault hits an mmap'd `.so` on the now-dead
//! mount (child exit code 128+7 = 135), and stale `fuse.squashfuse` entries
//! piling up against a handful of live daemons.
//!
//! ## The fix
//!
//! Every PDEATHSIG spawn is dispatched to ONE dedicated OS thread that is
//! created on first use and then never exits. "The thread that created this
//! process" is therefore a thread whose lifetime is exactly the process's, and
//! PDEATHSIG once again means what every call site intends: **the child dies
//! when the SERVER dies**.
//!
//! ## Why not a Drop guard / `kill_on_drop` / a shutdown hook
//!
//! Those only cover an ORDERLY exit. The single reason PDEATHSIG was chosen here
//! is that it is enforced by the kernel and therefore survives `SIGKILL` and the
//! OOM-killer, where no userspace teardown ever runs. Trading it for a
//! Drop-based teardown would swap a real guarantee for a partial one and leak
//! FUSE daemons on exactly the failure modes that motivated it. The explicit
//! [`super::mount::teardown`] path remains as the graceful-shutdown complement,
//! not a replacement.

use std::io;
use std::process::{Child, Command};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::OnceLock;

/// A queued spawn: the fully-configured command + where to post the result.
type SpawnRequest = (Command, SyncSender<io::Result<Child>>);

static SPAWNER: OnceLock<SyncSender<SpawnRequest>> = OnceLock::new();

/// Handle to the process-lifetime spawner thread, created on first use.
fn spawner() -> &'static SyncSender<SpawnRequest> {
    SPAWNER.get_or_init(|| {
        let (tx, rx) = sync_channel::<SpawnRequest>(8);
        std::thread::Builder::new()
            .name("pdeathsig-spawn".into())
            .spawn(move || {
                // INVARIANT: this thread must outlive every child it spawns —
                // that is the whole point of the module. It only ever ends when
                // the process does.
                while let Ok((mut cmd, reply)) = rx.recv() {
                    // The receiver is gone only if the caller was cancelled; the
                    // child is still tracked by the caller's error path.
                    let _ = reply.send(cmd.spawn());
                }
                // `SPAWNER` holds the only sender for `'static`, so `recv()`
                // never actually errors. Park instead of returning so that even
                // an unforeseen channel teardown cannot let this thread exit and
                // silently re-arm the bug documented above.
                loop {
                    std::thread::park();
                }
            })
            .expect("spawn the pdeathsig spawner thread");
        tx
    })
}

/// Spawn `cmd` with `PR_SET_PDEATHSIG(SIGTERM)` set in the child.
///
/// The child is guaranteed to receive `SIGTERM` when THIS PROCESS dies — by any
/// means, including `SIGKILL` and the OOM-killer — and, equally importantly, NOT
/// before that.
///
/// Use this for every long-lived child that must not outlive the server. Do not
/// hand-roll the `pre_exec` at a call site: a call site reached from
/// `spawn_blocking` (or any other transient thread) gets the child killed out
/// from under it. See the module docs.
pub fn spawn_dying_with_server(mut cmd: Command) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl(PR_SET_PDEATHSIG) is async-signal-safe; no allocation.
    unsafe {
        cmd.pre_exec(|| {
            let r = libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0);
            if r == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let (reply_tx, reply_rx) = sync_channel(1);
    spawner()
        .send((cmd, reply_tx))
        .map_err(|_| io::Error::other("pdeathsig spawner thread is gone"))?;
    // Propagates the spawn's `io::Error` verbatim, so callers can still match on
    // `ErrorKind::NotFound` to detect a missing binary.
    reply_rx
        .recv()
        .map_err(|_| io::Error::other("pdeathsig spawner dropped the spawn request"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Process state from `/proc/<pid>/stat`: `R`/`S`/`D` = alive, `Z` = died and
    /// is awaiting reaping, `None` = gone entirely.
    fn proc_state(pid: u32) -> Option<char> {
        let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // `comm` can contain spaces and parens, so parse after the LAST ')'.
        let after = &s[s.rfind(')')? + 1..];
        after.split_whitespace().next()?.chars().next()
    }

    fn is_alive(pid: u32) -> bool {
        matches!(proc_state(pid), Some('R' | 'S' | 'D'))
    }

    /// A runtime whose blocking threads are reaped almost immediately. Tokio's
    /// real default is 10s; shortening it only changes HOW LONG we wait for the
    /// reap, not whether it happens.
    fn short_keepalive_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_keep_alive(Duration::from_millis(100))
            .build()
            .expect("build test runtime")
    }

    fn victim() -> Command {
        let mut cmd = Command::new("sleep");
        cmd.arg("120");
        cmd
    }

    /// REGRESSION (BUG 1): a child spawned from a `spawn_blocking` task must
    /// survive tokio reaping the blocking thread that spawned it.
    ///
    /// This is the exact production shape: `sandbox::service` /
    /// `sandbox::backend::local_bwrap` reach `rootfs::ensure_ready` — and hence
    /// the squashfuse spawn — inside `tokio::task::spawn_blocking`.
    ///
    /// Note the assertion has no timing sensitivity in the PASSING direction:
    /// with the fix the child never dies, no matter how long we wait.
    #[test]
    fn child_outlives_the_reaped_tokio_blocking_thread() {
        let rt = short_keepalive_runtime();
        let mut child = rt.block_on(async {
            tokio::task::spawn_blocking(|| spawn_dying_with_server(victim()).expect("spawn"))
                .await
                .expect("blocking task")
        });
        let pid = child.id();

        // Keep the runtime alive so the blocking thread is reaped by its IDLE
        // keep-alive timer (the production trigger), not by runtime shutdown.
        std::thread::sleep(Duration::from_secs(2)); // 20x the keep-alive
        let state = proc_state(pid);
        let alive = is_alive(pid);

        let _ = child.kill();
        let _ = child.wait();
        drop(rt);

        assert!(
            alive,
            "child (pid {pid}) was killed when tokio reaped the blocking thread that \
             spawned it — PR_SET_PDEATHSIG is per-THREAD and must be issued from the \
             process-lifetime spawner thread. /proc state = {state:?}"
        );
    }

    /// NEGATIVE CONTROL for the test above: proves the harness can actually SEE
    /// the death it asserts against. Spawning with the same `pre_exec` DIRECTLY
    /// on the blocking thread (i.e. bypassing the spawner thread — what the code
    /// did before this fix) must produce a dead child.
    ///
    /// If this ever fails, the regression test above has lost its teeth and is
    /// passing for the wrong reason.
    #[test]
    fn control_direct_spawn_on_a_blocking_thread_does_get_killed() {
        use std::os::unix::process::CommandExt;

        let rt = short_keepalive_runtime();
        let mut child = rt.block_on(async {
            tokio::task::spawn_blocking(|| {
                let mut cmd = victim();
                // SAFETY: prctl(PR_SET_PDEATHSIG) is async-signal-safe.
                // Deliberately NOT routed through `spawn_dying_with_server` —
                // this reproduces the pre-fix code path.
                unsafe {
                    cmd.pre_exec(|| {
                        let r = libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0);
                        if r == 0 {
                            Ok(())
                        } else {
                            Err(io::Error::last_os_error())
                        }
                    });
                }
                cmd.spawn().expect("spawn")
            })
            .await
            .expect("blocking task")
        });
        let pid = child.id();

        // Poll rather than fixed-sleep: we only need to observe the death, and a
        // loaded box may reap late. A generous ceiling keeps this non-flaky.
        let deadline = Instant::now() + Duration::from_secs(30);
        while is_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let state = proc_state(pid);
        let still_alive = is_alive(pid);

        let _ = child.kill();
        let _ = child.wait();
        drop(rt);

        assert!(
            !still_alive,
            "ORACLE FAILURE: a child spawned with pre_exec PDEATHSIG directly on a \
             tokio blocking thread survived the thread being reaped (pid {pid}, state \
             {state:?}). The regression test above therefore proves nothing — \
             investigate before trusting it."
        );
    }
}
