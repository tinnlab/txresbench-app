//! `sandbox` module — bwrap-isolated execution of analysis (R/Python) scripts
//! against the embedded analysis rootfs.
//!
//! Ported from ziee `code_sandbox`, Linux-first + companion-driven: exposed as a
//! SERVICE (`service::run_analysis`) + a thin authenticated route (NOT a chat
//! MCP server — DEC-5). Boot probes the host, creates the workspace root, and
//! records `SandboxAvailability`; the rootfs mounts lazily on first run.
//!
//! # Host requirements (operator + dev)
//!
//! The sandbox needs three host properties. On a bare-metal Linux host with the
//! packages installed they are all satisfied by default; inside a CONTAINER (dev
//! or prod) two of them need deployment config — these are host/deployment facts,
//! NOT things the server can fix at runtime.
//!
//! 1. **Packages:** `bubblewrap` + `squashfuse` + `fuse3` (per-distro; e.g.
//!    `apt install bubblewrap squashfuse fuse3`).
//! 2. **`user_allow_other` in `/etc/fuse.conf`** — the rootfs is squashfuse-mounted
//!    with `-o allow_other` so bwrap's user-namespaced (uid-1001) process can read
//!    it; `allow_other` from a NON-root mounter requires this flag. Without it the
//!    mount silently never appears (`<mnt>/usr did not appear within 5s`). Needed
//!    whenever the server runs as a non-root user (the recommended posture).
//! 3. **Unprivileged PID-ns + a fresh `/proc`** — the sandbox `--unshare-pid` +
//!    mounts its own `/proc` (masking the host `/proc/<server_pid>/environ`
//!    secret-exfil vector; a no-PID-ns fallback is REFUSED — see `probes.rs`).
//!    Bare host: enable unprivileged userns (`kernel.unprivileged_userns_clone=1`,
//!    `kernel.apparmor_restrict_unprivileged_userns=0`). Inside a container: `/proc`
//!    must NOT be masked (an over-mount on any `/proc/...` path — e.g. the NVIDIA
//!    container toolkit's `/proc/driver/nvidia/params` — locks the tree against an
//!    unprivileged `mount -t proc`); run with `--security-opt systempaths=unconfined`.
//!
//! For a local dev box, `scripts/dev-sandbox-bootstrap.sh` applies 2 + 3 idempotently.

pub mod backend;
pub mod cgroup;
pub mod config;
pub mod env_id;
pub mod env_image;
pub mod inputs;
pub mod outputs;
pub mod permissions;
/// Admin compute-backend config (#63) — encrypted-at-rest Kubernetes config +
/// test-connection. `saas`-only (mirrors the K8s backend it configures).
#[cfg(feature = "saas")]
pub mod infra_compute;
pub mod processors;
pub mod probes;
pub mod routes;
pub mod sandbox;
pub mod spec;
#[cfg(target_os = "linux")]
pub mod streaming;
pub mod service;
pub mod settings;
pub mod settings_cache;
pub mod types;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

use config::{init_state, set_init_status, SandboxAvailability, SandboxState};

/// Sync-emit seam for a settings change. No-op today: the app-side sync
/// subscribe route + FE `initSync` land on live8's branch; at merge
/// reconciliation this wires to `ctx.sync.publish(SandboxSettings, …)` (DEC-4).
pub fn emit_settings_changed() {
    tracing::debug!("sandbox: settings changed (sync emit is a no-op until sync lands — DEC-4)");
}

pub struct SandboxModule;

impl AppModule for SandboxModule {
    fn name(&self) -> &'static str {
        "sandbox"
    }

    fn description(&self) -> &'static str {
        "bwrap-isolated execution of analysis scripts against the embedded rootfs."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // ANALYSIS-ROOTFS (DEC-24 reversed): NOTHING is embedded. The rootfs is a
        // GHCR-published OCI artifact the `OciEnvImageProvider` LAZY-fetches +
        // cosign-verifies + mounts on first run — so init no longer requires an
        // embedded rootfs. Availability depends on the HOST TOOLS (bwrap/squashfuse
        // below; oras/cosign are checked at first pull with a clear error). A
        // registry-unreachable / unsigned image fails the RUN with a typed error,
        // not init.

        // Host probe (bwrap on PATH + cgroup + seccomp). Missing bwrap → disable.
        let host = match probes::probe_host_only() {
            Some(h) => h,
            None => {
                set_init_status(SandboxAvailability::HostUnsupported);
                tracing::warn!(
                    "sandbox: bwrap not found on PATH — sandbox disabled (host_unsupported). \
                     Install bubblewrap + squashfuse to enable."
                );
                return Ok(());
            }
        };

        // Workspace root `<data_root>/sandboxes/` chmod 0700. `data_root()`
        // honors CYTO_APP_DATA_DIR so each integration test isolates here.
        let workspace_root = crate::modules::rootfs::data_root().join("sandboxes");
        if let Err(e) = create_workspace_root(&workspace_root) {
            set_init_status(SandboxAvailability::WorkspaceInitFailed);
            tracing::warn!("sandbox: workspace root init failed ({e}) — sandbox disabled");
            return Ok(());
        }
        // Output staging root `<data_root>/run-staging/`, same 0700 treatment
        // (ITEM-17). Created here rather than lazily per run so a permission or
        // disk fault disables the sandbox at boot with a reason, instead of
        // failing every run at staging time.
        let staging_root = outputs::staging_root();
        if let Err(e) = create_workspace_root(&staging_root) {
            set_init_status(SandboxAvailability::WorkspaceInitFailed);
            tracing::warn!("sandbox: output staging root init failed ({e}) — sandbox disabled");
            return Ok(());
        }

        init_state(SandboxState {
            workspace_root,
            staging_root,
            host_caps: host,
        });
        set_init_status(SandboxAvailability::Ready);
        tracing::info!("sandbox: registered (rootfs mounts lazily on first run)");
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        #[allow(unused_mut)]
        let mut router = router.merge(routes::sandbox_routes());
        // Admin compute backend config (#63): mounted UNCONDITIONALLY in a saas binary,
        // saas-only + `infra::settings::manage`-gated at the handler.
        #[cfg(feature = "saas")]
        {
            router = router.merge(infra_compute::routes());
        }
        router
    }
}

#[cfg(unix)]
fn create_workspace_root(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_workspace_root(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

#[distributed_slice(MODULE_ENTRIES)]
static SANDBOX: ModuleEntry = ModuleEntry {
    name: "sandbox",
    order: 61,
    description: "bwrap-isolated analysis execution.",
    constructor: || Box::new(SandboxModule),
};
