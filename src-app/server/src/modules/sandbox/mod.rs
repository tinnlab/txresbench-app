//! `sandbox` module — bwrap-isolated execution of analysis (R/Python) scripts
//! against an analysis rootfs, and of txr benchmark-method runs in a stacked
//! base+layer environment.
//!
//! Ported from ziee `code_sandbox`, Linux-first + companion-driven: exposed as a
//! SERVICE (`service::run_analysis`) + a thin authenticated route (NOT a chat
//! MCP server — DEC-5). Boot probes the host, creates the workspace root, and
//! records `SandboxAvailability`; the rootfs mounts lazily on first run.
//!
//! # Two execution modes, one security core
//!
//! Both modes are built by the same hardening core (`sandbox.rs`:
//! [`build_bwrap_argv`] + `spawn_bwrap_child`); only the argv differs.
//!
//! 1. **Processor pipeline** (the shipped cytoanalyst path) — one trimmed
//!    analysis rootfs per env image, bound read-only; the per-job workspace
//!    binds at `/home/analyst`; results land in the staging tree.
//! 2. **Stacked method run** (txr; the [`stack`] submodule) — ONE trimmed
//!    per-language base rootfs + ONE per-method layer image per run. The
//!    layer's `layer-manifest.json` entries bind individually, read-only, on
//!    top of the base (a layer never shadows the base wholesale),
//!    `/input` read-only, `/output` writable, `/model` read-only after a
//!    whole-tree sha256 check (fit writes `/model` into the caller's staging
//!    dir), `SIGBENCH_MODE` fit/predict per contract.md X1, and `--network
//!    none` is the shipped `--unshare-net`. [`stack::build_stacked_bwrap_argv`]
//!    REUSES [`sandbox::build_bwrap_argv`] for the byte-identical hardening
//!    prefix and splices the layer/model/mount/env block at ONE fixed seam —
//!    right after the shipped `/proc`-file mask run — so a later hardening
//!    change can never be applied to only one argv path (a wrong splice is a
//!    typed internal error, never a silent one). Every method runs in its own
//!    stack (INV-2); the base and layer digests are recorded in the run
//!    workspace (INV-6). Env fetch/verify/cache/mount and the env-status +
//!    method-run HTTP surface are the rest of this module's txr extension,
//!    gated by the existing sandbox permissions (no new permission). The
//!    method-run service seam is [`service::run_method_in_stack`]: ONE
//!    admitted job slot runs ONE method stack — the caller (execution-engine)
//!    owns admission, the bundle, the schedule and the run rows.
//!
//! # Host requirements (operator + dev)
//!
//! The sandbox needs three host properties — plus one tool for the txr env
//! fetch (item 4). On a bare-metal Linux host with the
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
//! 4. **`oras`** (txr env fetch only) — looked up in `<app_data>/bin` first, then
//!    `PATH`. Downloading method environments is the ONLY network use the desktop
//!    app has; a method run itself is `--unshare-net` (no loopback, no egress) and
//!    the fetched bytes are verified against their pinned sha256 before they are
//!    mounted. Missing `oras` degrades the txr env status, never a run against the
//!    host filesystem.
//!
//! For a local dev box, `scripts/dev-sandbox-bootstrap.sh` applies 2 + 3 idempotently.
//! `scripts/txr-sandbox-preflight.sh` is the same checklist WITHOUT the fixes —
//! the non-destructive check the installer and the operator run (DEC-16): the
//! four host tools (bwrap, squashfuse, fusermount3, oras), `user_allow_other`
//! and the fresh-`/proc` probe, each with its exact one-line remediation and a
//! non-zero exit when something required is missing. Its tool resolution
//! matches [`method_env::tool_bin`] (`<app_data>/bin` first, then `PATH`), so
//! what it reports is what `GET /api/sandbox/envs`' `stack.tool_bins` reports.

pub mod backend;
pub mod cgroup;
pub mod config;
pub mod env_id;
pub mod env_image;
pub mod inputs;
pub mod method_env;
pub mod outputs;
pub mod permissions;
pub mod processors;
pub mod probes;
pub mod routes;
pub mod sandbox;
pub mod spec;
// Stacked-layer method sandbox (txr): contract types + the pure argv/model/ref
// rules + the stacked argv builder — the second execution mode described in the
// module doc. No exported fn touches bwrap itself; the run seam drives
// `sandbox::spawn_bwrap_child` on the argv built here (DEC-1: extension of the
// shipped module, not a replacement).
pub mod stack;
#[cfg(target_os = "linux")]
pub mod streaming;
pub mod service;
pub mod settings;
pub mod settings_cache;
pub mod types;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

use config::{init_state, init_status, set_init_status, SandboxAvailability, SandboxState};

/// Sync-emit seam for a settings change. No-op today: the app-side sync
/// subscribe route + FE `initSync` land on live8's branch; at merge
/// reconciliation this wires to `ctx.sync.publish(SandboxSettings, …)` (DEC-4).
pub fn emit_settings_changed() {
    tracing::debug!("sandbox: settings changed (sync emit is a no-op until sync lands — DEC-4)");
}

/// The one-line boot summary of the stacked method mode (ITEM-6): the same
/// facts `GET /api/sandbox/envs`' `stack` section reports, formatted like
/// [`super::types::hardening_summary`] (`sandbox: <field> = { … }`).
/// Pure so its shape is pinned by tests; the call sites read
/// `init_status()` + `method_env::tool_bin("oras")`, exactly like the route.
fn stack_boot_summary(
    status: SandboxAvailability,
    oras: Option<String>,
    registry_base: &str,
) -> String {
    let supported = status == SandboxAvailability::Ready;
    let oras = oras.unwrap_or_else(|| "missing".to_string());
    format!(
        "sandbox: stack = {{ supported: {supported}, oras: {oras}, registry_base: \"{registry_base}\" }}"
    )
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
                tracing::info!(
                "{}",
                stack_boot_summary(
                    init_status(),
                    method_env::tool_bin("oras").map(|p| p.display().to_string()),
                    stack::TXR_BASE_REGISTRY_PREFIX,
                )
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
            tracing::info!(
                "{}",
                stack_boot_summary(
                    init_status(),
                    method_env::tool_bin("oras").map(|p| p.display().to_string()),
                    stack::TXR_BASE_REGISTRY_PREFIX,
                )
            );
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
            tracing::info!(
                "{}",
                stack_boot_summary(
                    init_status(),
                    method_env::tool_bin("oras").map(|p| p.display().to_string()),
                    stack::TXR_BASE_REGISTRY_PREFIX,
                )
            );
            return Ok(());
        }

        init_state(SandboxState {
            workspace_root,
            staging_root,
            host_caps: host,
        });
        set_init_status(SandboxAvailability::Ready);
        // The stacked (base+layer) method-mode summary, at boot, in the same
        // one-line style as the hardening summary (ITEM-6): the facts
        // `GET /api/sandbox/envs`' `stack` section reports. `supported` is the
        // same host-capability bit (`SandboxAvailability::Ready` — bwrap +
        // squashfuse + userns/`/proc` are the shipped boot probes); `oras` is
        // the ONLY stack-specific tool, and a missing one degrades (a staged/
        // cached txr env runs without it — the `reason`/`tool_bins` pairing),
        // never disables the stack; `registry_base` is the compiled
        // release-time boundary (read-only, like `env_registry_base`).
        // `scripts/txr-sandbox-preflight.sh` is the operator's checklist
        // (DEC-16).
        tracing::info!(
            "{}",
            stack_boot_summary(
                init_status(),
                method_env::tool_bin("oras").map(|p| p.display().to_string()),
                stack::TXR_BASE_REGISTRY_PREFIX,
            )
        );
        // txr method-env manager: loads the persisted download-state ledger
        // (`<app_data>/txr-envs/`, DEC-10 — disk state, no DB row) so the env
        // status surface is correct from the first request after a restart.
        let persisted = method_env::manager().persisted_count();
        tracing::info!(
            "sandbox: registered (rootfs mounts lazily on first run; {} persisted txr method envs)",
            persisted
        );
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::sandbox_routes())
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

#[cfg(test)]
mod tests {
    use super::*;

    // ITEM-6 boot summary: the Ready facts are reported exactly, including the
    // resolved oras path and the compiled registry base.
    #[test]
    fn stack_boot_summary_reports_the_ready_facts() {
        let s = stack_boot_summary(
            SandboxAvailability::Ready,
            Some("/usr/bin/oras".to_string()),
            stack::TXR_BASE_REGISTRY_PREFIX,
        );
        assert_eq!(
            s,
            format!(
                "sandbox: stack = {{ supported: true, oras: /usr/bin/oras, \
                 registry_base: \"{}\" }}",
                stack::TXR_BASE_REGISTRY_PREFIX
            )
        );
    }

    // A missing oras is reported as `missing`, NOT as `supported: false` — a
    // staged/air-gapped or cached environment runs without the fetch tool
    // (DRIFT-1 #35; the HTTP surface's `reason`/`tool_bins` carries the note).
    #[test]
    fn stack_boot_summary_keeps_support_with_a_missing_oras() {
        let s = stack_boot_summary(SandboxAvailability::Ready, None, "reg");
        assert!(s.contains("supported: true"), "{s}");
        assert!(s.contains("oras: missing"), "{s}");
    }

    // Any non-Ready availability is `supported: false` — the stack rides the
    // same probes as the shipped sandbox, so a disabled sandbox is a disabled
    // stack (DEC-16's degrade works on the same bit).
    #[test]
    fn stack_boot_summary_reflects_a_disabled_host() {
        let s = stack_boot_summary(
            SandboxAvailability::HostUnsupported,
            Some("/usr/bin/oras".to_string()),
            "reg",
        );
        assert!(s.contains("supported: false"), "{s}");
        assert!(s.contains("oras: /usr/bin/oras"), "{s}");
    }
}
