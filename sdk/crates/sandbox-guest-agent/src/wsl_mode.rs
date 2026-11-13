//! WSL mode's mount plan: what the agent mounts, in which order, before it
//! serves the one protocol connection on stdin/stdout.
//!
//! In WSL the agent runs in the app's distro, whose mount namespace and cgroup
//! tree are shared with every other process in it. So WSL mode
//!  1. first moves itself into a private mount namespace in which every mount is
//!     private: nothing it mounts reaches the distro, and all of it is gone when
//!     the agent (the namespace's last process) exits;
//!  2. opens every path it was given before it mounts anything, so a path under
//!     `/tmp` or another dir it covers still means what the caller meant;
//!  3. mounts private tmpfs at `/tmp` and `/workspace` (mode 1777);
//!  4. mounts the base image at `/sandbox-rootfs` and the layer at
//!     `/sandbox-layer`, read-only: kernel squashfs on a loop device that clears
//!     itself when unmounted, else squashfuse;
//!  5. mounts a tmpfs at `/host-mounts` and binds the i-th `--ro` path read-only
//!     at `/host-mounts/<i>`.
//!
//! It makes no cgroup change at all (see `main.rs`). The first failure stops
//! the plan; the agent then exits with `EXIT_SETUP`.
//!
//! The steps run through [`MountOps`], so the plan and its failure handling are
//! tested without root; the real system calls are in `wsl_sys.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::cli::StdioArgs;

/// Where the base image is mounted (the same path as in the VM).
pub const ROOTFS_MOUNT: &str = "/sandbox-rootfs";
/// Where the layer image is mounted (the same path as in the VM).
pub const LAYER_MOUNT: &str = "/sandbox-layer";
/// The dir holding the read-only binds (`/host-mounts/<i>`).
pub const HOST_MOUNTS_DIR: &str = "/host-mounts";
pub const TMP_DIR: &str = "/tmp";
pub const WORKSPACE_DIR: &str = "/workspace";
/// The private `/tmp`: the progress FIFO and the seccomp filter's temp file
/// (the outputs get their own tmpfs under it, per run).
pub const TMP_OPTIONS: &str = "size=16m,mode=1777";
pub const WORKSPACE_OPTIONS: &str = "size=16m,mode=1777";
/// Holds only the bind mount points.
pub const HOST_MOUNTS_OPTIONS: &str = "size=1m,mode=0755";

/// A path the caller gave, opened once before anything is mounted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    Base,
    Layer,
    /// The i-th `--ro` path.
    Ro(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Enter a new mount namespace and make every mount in it private.
    PrivateNamespace,
    /// Open a caller's path: an image must be a regular file, a `--ro` path a
    /// directory or a regular file.
    Open { source: Source, path: PathBuf },
    /// A private tmpfs on an existing dir.
    Tmpfs { target: PathBuf, options: &'static str },
    /// An opened image, read-only on an existing dir.
    Squashfs { source: Source, target: PathBuf },
    /// An opened `--ro` path, bound read-only at `target` (created to match).
    BindRo { source: Source, target: PathBuf },
}

/// The steps for one WSL-mode run, in order.
pub fn mount_plan(args: &StdioArgs) -> Vec<Step> {
    let mut plan = vec![Step::PrivateNamespace];
    plan.push(Step::Open { source: Source::Base, path: args.base.clone() });
    if let Some(layer) = &args.layer {
        plan.push(Step::Open { source: Source::Layer, path: layer.clone() });
    }
    for (i, path) in args.ro.iter().enumerate() {
        plan.push(Step::Open { source: Source::Ro(i), path: path.clone() });
    }
    plan.push(Step::Tmpfs { target: TMP_DIR.into(), options: TMP_OPTIONS });
    plan.push(Step::Tmpfs { target: WORKSPACE_DIR.into(), options: WORKSPACE_OPTIONS });
    plan.push(Step::Squashfs { source: Source::Base, target: ROOTFS_MOUNT.into() });
    if args.layer.is_some() {
        plan.push(Step::Squashfs { source: Source::Layer, target: LAYER_MOUNT.into() });
    }
    plan.push(Step::Tmpfs { target: HOST_MOUNTS_DIR.into(), options: HOST_MOUNTS_OPTIONS });
    for i in 0..args.ro.len() {
        plan.push(Step::BindRo { source: Source::Ro(i), target: Path::new(HOST_MOUNTS_DIR).join(i.to_string()) });
    }
    plan
}

/// The system calls behind the steps. Each returns the reason on failure.
pub trait MountOps {
    fn private_namespace(&mut self) -> Result<(), String>;
    fn open(&mut self, source: Source, path: &Path) -> Result<(), String>;
    fn tmpfs(&mut self, target: &Path, options: &str) -> Result<(), String>;
    /// Kernel squashfs on a loop device (read-only, cleared when unmounted).
    fn squashfs_kernel(&mut self, source: Source, target: &Path) -> Result<(), String>;
    /// squashfuse, run by the agent until it exits.
    fn squashfuse(&mut self, source: Source, target: &Path) -> Result<(), String>;
    fn bind_ro(&mut self, source: Source, target: &Path) -> Result<(), String>;
}

/// Run the plan in order; the first failure stops it and is returned with
/// its context. The squashfs step falls back to squashfuse when the kernel
/// mount fails, and fails only when both do.
pub fn execute(plan: &[Step], ops: &mut dyn MountOps) -> Result<(), String> {
    let mut paths: HashMap<Source, &Path> = HashMap::new();
    let path_of = |paths: &HashMap<Source, &Path>, s: Source| -> String {
        paths.get(&s).map(|p| p.display().to_string()).unwrap_or_else(|| format!("{s:?}"))
    };
    for step in plan {
        match step {
            Step::PrivateNamespace => ops
                .private_namespace()
                .map_err(|e| format!("entering a private mount namespace: {e}"))?,
            Step::Open { source, path } => {
                ops.open(*source, path).map_err(|e| format!("opening {}: {e}", path.display()))?;
                paths.insert(*source, path);
            }
            Step::Tmpfs { target, options } => ops
                .tmpfs(target, options)
                .map_err(|e| format!("mounting a tmpfs at {}: {e}", target.display()))?,
            Step::Squashfs { source, target } => {
                let kernel = match ops.squashfs_kernel(*source, target) {
                    Ok(()) => {
                        tracing::info!("agent: mounted {} at {} (kernel squashfs)", path_of(&paths, *source), target.display());
                        continue;
                    }
                    Err(e) => e,
                };
                tracing::warn!(
                    "agent: kernel squashfs mount of {} failed ({kernel}); trying squashfuse",
                    path_of(&paths, *source)
                );
                match ops.squashfuse(*source, target) {
                    Ok(()) => {
                        tracing::info!("agent: mounted {} at {} (squashfuse)", path_of(&paths, *source), target.display())
                    }
                    Err(fuse) => {
                        return Err(format!(
                            "mounting {} at {}: kernel squashfs: {kernel}; squashfuse: {fuse}",
                            path_of(&paths, *source),
                            target.display()
                        ))
                    }
                }
            }
            Step::BindRo { source, target } => ops.bind_ro(*source, target).map_err(|e| {
                format!("binding {} read-only at {}: {e}", path_of(&paths, *source), target.display())
            })?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records each call; fails the calls named in `fail`.
    #[derive(Default)]
    struct FakeOps {
        calls: Vec<String>,
        fail: Vec<&'static str>,
    }

    impl FakeOps {
        fn failing(fail: &[&'static str]) -> Self {
            Self { calls: Vec::new(), fail: fail.to_vec() }
        }
        fn record(&mut self, call: String) -> Result<(), String> {
            let failed = self.fail.iter().any(|f| call.starts_with(f));
            self.calls.push(call);
            if failed {
                Err("injected failure".into())
            } else {
                Ok(())
            }
        }
    }

    impl MountOps for FakeOps {
        fn private_namespace(&mut self) -> Result<(), String> {
            self.record("namespace".into())
        }
        fn open(&mut self, source: Source, path: &Path) -> Result<(), String> {
            self.record(format!("open {source:?} {}", path.display()))
        }
        fn tmpfs(&mut self, target: &Path, options: &str) -> Result<(), String> {
            self.record(format!("tmpfs {} {options}", target.display()))
        }
        fn squashfs_kernel(&mut self, source: Source, target: &Path) -> Result<(), String> {
            self.record(format!("kernel {source:?} {}", target.display()))
        }
        fn squashfuse(&mut self, source: Source, target: &Path) -> Result<(), String> {
            self.record(format!("squashfuse {source:?} {}", target.display()))
        }
        fn bind_ro(&mut self, source: Source, target: &Path) -> Result<(), String> {
            self.record(format!("bind {source:?} {}", target.display()))
        }
    }

    fn full_args() -> StdioArgs {
        StdioArgs {
            base: "/mnt/c/img/base.sqfs".into(),
            layer: Some("/mnt/c/img/layer.sqfs".into()),
            ro: vec!["/mnt/c/run/input".into(), "/tmp/identity".into()],
        }
    }

    #[test]
    fn the_plan_enters_the_namespace_first_and_opens_every_path_before_any_mount() {
        let mut ops = FakeOps::default();
        execute(&mount_plan(&full_args()), &mut ops).expect("plan runs");
        assert_eq!(
            ops.calls,
            vec![
                "namespace",
                "open Base /mnt/c/img/base.sqfs",
                "open Layer /mnt/c/img/layer.sqfs",
                "open Ro(0) /mnt/c/run/input",
                "open Ro(1) /tmp/identity",
                "tmpfs /tmp size=16m,mode=1777",
                "tmpfs /workspace size=16m,mode=1777",
                "kernel Base /sandbox-rootfs",
                "kernel Layer /sandbox-layer",
                "tmpfs /host-mounts size=1m,mode=0755",
                "bind Ro(0) /host-mounts/0",
                "bind Ro(1) /host-mounts/1",
            ]
        );
    }

    #[test]
    fn without_a_layer_or_ro_paths_only_the_base_is_mounted() {
        let args = StdioArgs { base: "/b.sqfs".into(), layer: None, ro: vec![] };
        let plan = mount_plan(&args);
        assert!(!plan.iter().any(|s| matches!(s, Step::Squashfs { source: Source::Layer, .. })));
        assert!(!plan.iter().any(|s| matches!(s, Step::BindRo { .. })));
        // /host-mounts is still a private, empty tmpfs.
        assert!(plan.contains(&Step::Tmpfs { target: HOST_MOUNTS_DIR.into(), options: HOST_MOUNTS_OPTIONS }));
    }

    #[test]
    fn a_failed_kernel_mount_falls_back_to_squashfuse_for_that_image_only() {
        let mut ops = FakeOps::failing(&["kernel Base"]);
        execute(&mount_plan(&full_args()), &mut ops).expect("the fallback mounts the base");
        let mounts: Vec<&str> = ops
            .calls
            .iter()
            .map(String::as_str)
            .filter(|c| c.starts_with("kernel") || c.starts_with("squashfuse"))
            .collect();
        assert_eq!(
            mounts,
            vec!["kernel Base /sandbox-rootfs", "squashfuse Base /sandbox-rootfs", "kernel Layer /sandbox-layer"]
        );
    }

    #[test]
    fn both_mount_paths_failing_stops_the_plan_with_both_reasons() {
        let mut ops = FakeOps::failing(&["kernel Layer", "squashfuse Layer"]);
        let err = execute(&mount_plan(&full_args()), &mut ops).expect_err("no way to mount the layer");
        assert!(err.contains("/mnt/c/img/layer.sqfs"), "{err}");
        assert!(err.contains("/sandbox-layer"), "{err}");
        assert!(err.contains("kernel squashfs: injected failure; squashfuse: injected failure"), "{err}");
        assert_eq!(ops.calls.last().map(String::as_str), Some("squashfuse Layer /sandbox-layer"));
        assert!(!ops.calls.iter().any(|c| c.starts_with("bind")), "nothing after the failure ran");
    }

    #[test]
    fn a_failed_namespace_runs_nothing_else() {
        let mut ops = FakeOps::failing(&["namespace"]);
        let err = execute(&mount_plan(&full_args()), &mut ops).expect_err("no namespace");
        assert!(err.starts_with("entering a private mount namespace"), "{err}");
        assert_eq!(ops.calls, vec!["namespace"]);
    }

    #[test]
    fn a_path_that_cannot_be_opened_stops_the_plan_before_any_mount() {
        let mut ops = FakeOps::failing(&["open Ro(1)"]);
        let err = execute(&mount_plan(&full_args()), &mut ops).expect_err("missing input");
        assert!(err.starts_with("opening /tmp/identity"), "{err}");
        assert!(!ops.calls.iter().any(|c| c.starts_with("tmpfs") || c.starts_with("kernel")));
    }

    #[test]
    fn a_failed_bind_names_the_path_and_the_target() {
        let mut ops = FakeOps::failing(&["bind Ro(0)"]);
        let err = execute(&mount_plan(&full_args()), &mut ops).expect_err("bind fails");
        assert!(err.contains("binding /mnt/c/run/input read-only at /host-mounts/0"), "{err}");
        assert!(!ops.calls.iter().any(|c| c == "bind Ro(1) /host-mounts/1"));
    }

    #[test]
    fn a_failed_tmpfs_stops_the_plan() {
        let mut ops = FakeOps::failing(&["tmpfs /workspace"]);
        let err = execute(&mount_plan(&full_args()), &mut ops).expect_err("tmpfs fails");
        assert!(err.starts_with("mounting a tmpfs at /workspace"), "{err}");
        assert!(!ops.calls.iter().any(|c| c.starts_with("kernel")));
    }

    #[test]
    fn the_mount_points_match_the_vm_guest_paths() {
        // The app builds one bwrap argv for both runners, with these paths.
        assert_eq!(ROOTFS_MOUNT, crate::ROOTFS_MOUNT);
        assert_eq!(LAYER_MOUNT, crate::LAYER_MOUNT);
        assert_eq!(WORKSPACE_DIR, crate::WORKSPACE_MOUNT);
        #[cfg(target_os = "linux")]
        assert_eq!(HOST_MOUNTS_DIR, crate::EXTRA_MOUNTS_DIR);
    }
}
