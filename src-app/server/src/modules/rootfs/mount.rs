//! Squashfuse mount of a content-digest-cached squashfs + schema-version probe.
//!
//! Mirrors txresbench `code_sandbox/runtime_mount.rs::mount_if_needed` (idempotency,
//! dead-FUSE clear, `PR_SET_PDEATHSIG` so the FUSE daemon dies with the server,
//! bounded mount-visibility wait), collapsed to the content-digest cache
//! (no per-flavor map — DEC-2). strip-single-cell ITEM-3: the EMBEDDED-rootfs
//! mount arm (`ensure_mounted`, the extract-from-the-binary path) was removed
//! with the analysis-rootfs embedding; the digest-keyed [`mount_at`] stays — it
//! is what the txr method environments mount through
//! ([`crate::modules::rootfs::ensure_ready_by_digest`]). Linux-only (the sandbox
//! is Linux-first — DEC-3); other targets return `Unsupported`.

use std::path::{Path, PathBuf};

use txresbench_core::AppError;

use super::version::{ROOTFS_SCHEMA_MARKER, ROOTFS_SCHEMA_VERSION};

/// Compare the mounted rootfs's schema marker content against the embedded
/// `ROOTFS_SCHEMA_VERSION`. Pure + testable (TEST-3): equal → Ok; anything else
/// → a precise error so the caller refuses to use the mount.
pub fn check_schema(marker_content: &str) -> Result<(), String> {
    let found = marker_content.trim();
    let want = ROOTFS_SCHEMA_VERSION.to_string();
    if found == want {
        Ok(())
    } else {
        Err(format!(
            "rootfs schema mismatch: mounted rootfs marker is {found:?}, binary \
             expects {want:?}. The sandbox will NOT use this rootfs."
        ))
    }
}

fn schema_error(detail: String) -> AppError {
    AppError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "ROOTFS_SCHEMA_MISMATCH",
        detail,
    )
}

fn mount_err(detail: impl Into<String>) -> AppError {
    AppError::new(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "ROOTFS_MOUNT_FAILED",
        detail.into(),
    )
}

// ─────────────────────────── Linux backend ───────────────────────────
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::process::Command;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use once_cell::sync::OnceCell;

    struct Mounted {
        child: std::process::Child,
        mount_dir: PathBuf,
    }

    // A registry of ALL squashfuse mounts this process owns (ITEM-22): the
    // embedded rootfs PLUS any historical rootfs mounted BY DIGEST for a pinned
    // reproduce/verify re-run. Keyed by mount_dir so it's idempotent + so
    // shutdown reaps every FUSE daemon.
    static MOUNTS: OnceCell<Mutex<Vec<Mounted>>> = OnceCell::new();

    fn registry() -> &'static Mutex<Vec<Mounted>> {
        MOUNTS.get_or_init(|| Mutex::new(Vec::new()))
    }

    /// Mount a squashfs (given its path + target mount dir) read-only.
    /// `enforce_schema` gates the freshly-mounted marker against the binary's
    /// `ROOTFS_SCHEMA_VERSION`: TRUE for the embedded rootfs (must match), FALSE
    /// for a mount-BY-DIGEST of a HISTORICAL rootfs (a run pinned to an older
    /// schema is legitimately a different version — we mount + use it as-is for a
    /// faithful reproduce/verify, DEC-17).
    pub fn mount_at(
        squashfs_path: &Path,
        mount_dir: &Path,
        enforce_schema: bool,
    ) -> Result<PathBuf, AppError> {
        let mount_dir = mount_dir.to_path_buf();

        // Fast path: a healthy mount already exists (this process or a prior
        // one / an operator). `usr/` present == mounted.
        if mount_dir.join("usr").exists() {
            if enforce_schema {
                // A pre-existing mount we didn't spawn isn't tracked, so on a
                // schema mismatch we must unmount HERE or a stale rootfs stays
                // live and every ensure_ready re-errors against it. [blind-audit MED]
                if let Err(e) = verify_schema(&mount_dir) {
                    let _ = Command::new("fusermount")
                        .args(["-u", "-z"])
                        .arg(&mount_dir)
                        .status();
                    return Err(e);
                }
            }
            return Ok(mount_dir);
        }

        // Clear a stale/dead FUSE mount, retrying mkdir a few times (a dead
        // FUSE mount makes mkdir EEXIST while stat fails).
        let mut mkdir = std::fs::create_dir_all(&mount_dir);
        let mut attempts = 0;
        while mkdir.is_err() && attempts < 5 {
            let _ = Command::new("fusermount")
                .args(["-u", "-z"])
                .arg(&mount_dir)
                .status();
            std::thread::sleep(Duration::from_millis(150));
            mkdir = std::fs::create_dir_all(&mount_dir);
            attempts += 1;
        }
        mkdir.map_err(|e| mount_err(format!("mkdir {}: {e}", mount_dir.display())))?;

        tracing::info!(
            sqfs = %squashfs_path.display(),
            mount = %mount_dir.display(),
            "rootfs: spawning squashfuse"
        );

        // Foreground squashfuse + PDEATHSIG so the FUSE daemon dies with the
        // server even on SIGKILL/OOM.
        let mut cmd = Command::new("squashfuse");
        // `-o allow_other`: the sandbox runs bwrap with `--unshare-user --uid 1001`, so the
        // sandboxed process sits in a DIFFERENT user namespace than this (root) FUSE mounter.
        // Without allow_other, the FUSE daemon denies that process's reads of the rootfs
        // ("Permission denied" on `<mnt>/usr` → the strict PID-ns probe/exec fails). allow_other
        // lets the bwrap-unshared process read the read-only rootfs.
        cmd.arg("-f").arg("-o").arg("allow_other").arg(squashfs_path).arg(&mount_dir);
        // PDEATHSIG is issued from the process-lifetime spawner thread, NOT from
        // whatever thread we happen to be on. We are normally reached from
        // `tokio::task::spawn_blocking`, and tokio reaps an idle blocking thread
        // after ~10s; because PDEATHSIG is per-THREAD, spawning squashfuse here
        // directly got it SIGTERM'd out from under a live server (ENOTCONN /
        // SIGBUS on the mount). See `crate::modules::rootfs::pdeathsig`.
        let child = match crate::modules::rootfs::pdeathsig::spawn_dying_with_server(cmd) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "SQUASHFUSE_MISSING",
                    "squashfuse is not installed. Install it (e.g. `apt install \
                     squashfuse fuse3`) so the analysis rootfs can be mounted.",
                ));
            }
            Err(e) => return Err(mount_err(format!("squashfuse spawn: {e}"))),
        };

        // Wait for the mount to become visible (squashfuse forks quickly but
        // kernel visibility is async). 5s ceiling.
        let target = mount_dir.join("usr");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !target.exists() {
            if Instant::now() > deadline {
                let _ = Command::new("fusermount").args(["-u", "-z"]).arg(&mount_dir).status();
                return Err(mount_err(format!(
                    "squashfuse spawned but {}/usr did not appear within 5s",
                    mount_dir.display()
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        // Stash the child so shutdown() can reap it.
        registry().lock().unwrap_or_else(|p| p.into_inner()).push(Mounted {
            child,
            mount_dir: mount_dir.clone(),
        });

        // Schema probe against the freshly-mounted marker (embedded rootfs only).
        if enforce_schema {
            if let Err(e) = verify_schema(&mount_dir) {
                // Tear the mount back down — we refuse a mismatched rootfs.
                unmount_one(&mount_dir);
                return Err(e);
            }
        }

        Ok(mount_dir)
    }

    fn verify_schema(mount_dir: &Path) -> Result<(), AppError> {
        let marker = mount_dir.join(ROOTFS_SCHEMA_MARKER);
        let content = std::fs::read_to_string(&marker).map_err(|e| {
            schema_error(format!(
                "cannot read rootfs schema marker {}: {e}",
                marker.display()
            ))
        })?;
        check_schema(&content).map_err(schema_error)
    }

    /// Tear down + reap a single tracked mount by its mount dir (used when a
    /// just-spawned mount fails its post-mount schema probe).
    fn unmount_one(mount_dir: &Path) {
        let mut guard = registry().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pos) = guard.iter().position(|m| m.mount_dir == mount_dir) {
            let mut m = guard.remove(pos);
            let _ = m.child.kill();
            let _ = m.child.wait();
        }
        let _ = Command::new("fusermount")
            .args(["-u", "-z"])
            .arg(mount_dir)
            .status();
    }

    /// Unmount + reap EVERY squashfuse child this process owns. Idempotent.
    pub fn teardown() {
        let taken: Vec<Mounted> =
            std::mem::take(&mut *registry().lock().unwrap_or_else(|p| p.into_inner()));
        for mut m in taken {
            // SIGTERM squashfuse (its handler unmounts), then reap.
            let _ = m.child.kill();
            let _ = m.child.wait();
            // Defensive lazy unmount in case squashfuse died without unmounting.
            let _ = Command::new("fusermount")
                .args(["-u", "-z"])
                .arg(&m.mount_dir)
                .status();
        }
    }

    /// Whether a healthy mount currently exists (for the admin status).
    pub fn is_mounted(extracted_dir: &Path) -> bool {
        extracted_dir.join("mnt").join("usr").exists()
    }
}

// ─────────────────────── non-Linux (compile-only) ────────────────────
#[cfg(not(target_os = "linux"))]
mod portable {
    use super::*;

    fn unsupported() -> AppError {
        AppError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ROOTFS_UNSUPPORTED_OS",
            "the analysis sandbox is Linux-only; the rootfs cannot be mounted on \
             this platform.",
        )
    }

    pub fn mount_at(
        _squashfs_path: &Path,
        _mount_dir: &Path,
        _enforce_schema: bool,
    ) -> Result<PathBuf, AppError> {
        Err(unsupported())
    }

    pub fn teardown() {}

    pub fn is_mounted(_extracted_dir: &Path) -> bool {
        false
    }
}

#[cfg(target_os = "linux")]
pub use linux::{is_mounted, mount_at, teardown};
#[cfg(not(target_os = "linux"))]
pub use portable::{is_mounted, mount_at, teardown};

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-3: schema-version probe accepts an equal marker, refuses a mismatch.
    #[test]
    fn check_schema_accepts_equal_refuses_mismatch() {
        let ok = ROOTFS_SCHEMA_VERSION.to_string();
        assert!(check_schema(&ok).is_ok(), "equal schema mounts");
        assert!(check_schema(&format!("{ok}\n")).is_ok(), "trailing newline tolerated");
        let bad = (ROOTFS_SCHEMA_VERSION + 1).to_string();
        let err = check_schema(&bad).expect_err("mismatch must refuse");
        assert!(err.contains("mismatch"), "error names the mismatch: {err}");
        assert!(check_schema("garbage").is_err(), "non-numeric marker refuses");
        assert!(check_schema("").is_err(), "empty marker refuses");
    }

    // TEST-25 (LOW-4): teardown (wired into lib.rs graceful shutdown) is
    // idempotent — safe to call with nothing mounted, and twice.
    #[test]
    fn teardown_is_idempotent_with_nothing_mounted() {
        teardown();
        teardown();
    }
}
