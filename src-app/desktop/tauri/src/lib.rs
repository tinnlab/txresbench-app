//! CytoAnalyst desktop — a Tauri shell over the SDK's `ziee-desktop-harness`.
//!
//! Single-user desktop deployment: embeds the CytoAnalyst server, auto-provisions
//! + auto-logs-in the owner, and shows the web UI in a native window. Almost all
//! of the shell (window construction, boot→window lifecycle, single-user mint) is
//! inherited from the harness; this crate supplies only the `ServerBoot` impl,
//! the two IPC commands, and the owner-creation seam.

mod bundled_models;
mod commands;
mod config;
mod server_boot;
// `pub`: the loopback-seam integration suite (tests/update_check_seam.rs) is
// a separate crate and drives the runtime through this module's injected
// seams (PROV-IR-6 / DRIFT-1 ITEM-4).
pub mod updates;

use std::sync::Arc;

use ziee_desktop_harness::boot::ServerBoot;
use ziee_desktop_harness::window::{spawn_boot_then_window, WindowConfig};

use crate::server_boot::CytoServerBoot;

/// Wire the desktop IPC commands into a Tauri Builder.
pub fn register_invoke_handler<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::get_server_port,
        commands::auto_login,
        commands::reveal_in_file_manager,
        // ITEM-4 (PROV-IR-6): the update-check surface. The webview has no
        // update screen today (DEC-2's native prompt); the commands are the
        // status/check/install seam a future UI surface would call, and
        // `start_boot_check` drives them once per start.
        updates::get_update_status,
        updates::check_for_update,
        updates::install_update,
    ])
}

/// The main-window parameters for the CytoAnalyst desktop shell.
///
/// Extracted from `run()` so the pop-out enablement is a statically-testable
/// value. `enable_popout_windows: true` is the load-bearing flag for ITEM-32:
/// it opts this app into the harness's `on_new_window → Create` handler (which
/// forwards `window_features`) and, on Linux/WebKitGTK,
/// `set_javascript_can_open_windows_automatically(true)` — so the workbench's
/// platform-agnostic `window.open('about:blank', …)` pop-out (see the UI's
/// `dock/popout.ts`) opens + loads a REAL, scriptable Tauri window instead of
/// being denied/blocked. The frontend stays untouched; all desktop handling
/// lives in the harness Rust layer.
///
/// The minimum size (app-shell ITEM-1, DEC-1/DEC-2): the desktop window is
/// ALWAYS in shell mode — the app-shell audit's bound is a viewport of at
/// least 768×520 — so a user who shrinks the window must not be able to
/// reach the flow layout (page-level scrolling) at all: the floor is 1000×640,
/// comfortably above the bound. (The window config lives HERE, not in
/// `tauri.conf.json`: its `app.windows` is empty by design and the harness
/// `WindowConfig` builds the window — the conf file would be a dead pin.)
pub(crate) fn desktop_window_config() -> WindowConfig {
    WindowConfig {
        title: "TxResBench".to_string(),
        inner_size: (1200.0, 800.0),
        min_inner_size: (1000.0, 640.0),
        effect_radius: 8.0,
        traffic_light_position: (20.0, 22.0),
        enable_popout_windows: true,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!("Starting TxResBench…");

    let boot: Arc<dyn ServerBoot> = Arc::new(CytoServerBoot::new(config::desktop_config()));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // ITEM-4 (PROV-IR-6): the official v2 update mechanism (the plugin
        // owns download + minisign signature verification + install) and the
        // process-control companion (its restart command wraps the same
        // core `restart` the shell's `updates` seam uses).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    register_invoke_handler(builder)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let window = desktop_window_config();

            // ITEM-3 (PROV-IR-5/8): provision the bundled models from the
            // embedded resource dir BEFORE the server's boot task starts —
            // `CYTO_TXR_BUNDLED_MODELS_DIR` must precede the
            // pretrained_catalogue module's init (its bundled-dir resolution
            // reads the env var at module setup). A failed provision is
            // logged and boot continues: the catalogue module's install path
            // re-verifies per file at use time (PRETRAINED_VERIFY_FAILED),
            // and offline/unbundled are valid states.
            if let Err(e) = bundled_models::provision_bundled_models(app.handle()) {
                tracing::error!("bundled-model provision failed (boot continues): {e}");
            }

            // The harness spawns the boot on Tauri's async runtime, runs our
            // post-boot steps, then creates the window (on both success + failure).
            spawn_boot_then_window(boot, app_handle, window, move |handle| async move {
                let _ = commands::JWT_SERVICE.set(handle.jwt.clone());
                let _ = commands::SERVER_POOL.set(handle.pool.clone());
                let _ = commands::SERVER_PORT.set(handle.addr.port());
                tracing::info!("embedded server ready on {}", handle.addr);

                if let Err(e) = commands::ensure_owner(&handle.pool).await {
                    tracing::error!("failed to ensure desktop owner: {e}");
                }
            });

            // ITEM-4 (PROV-IR-6/8): the update-check runtime registers the
            // plugin-backed seams (its `Unconfigured` state reads the config's
            // pubkey — empty = disabled, never dials) and the once-per-start
            // boot check starts AFTER the boot→window spawn (the silent
            // release-build check; its ask appears only when an update is
            // actually available, DEC-2/DEC-14).
            updates::register(app.handle());
            updates::start_boot_check(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TxResBench desktop");
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ITEM-32 (desktop pop-out parity): the desktop shell MUST opt into the
    /// harness pop-out enablement, or a workbench `window.open('about:blank', …)`
    /// pop-out is denied (`NewWindowResponse::Deny`) / blocked on the desktop
    /// build. This is the single load-bearing flag; guarding it prevents a silent
    /// regression where a config refactor drops it.
    #[test]
    fn desktop_opts_into_window_open_popout() {
        assert!(
            desktop_window_config().enable_popout_windows,
            "cytoanalyst-desktop must set enable_popout_windows=true so the \
             harness wires on_new_window→Create (+ Linux \
             javascript_can_open_windows_automatically) for the workbench pane \
             pop-out; without it window.open is denied on the desktop build",
        );
    }

    /// TEST-AS-1 (app-shell ITEM-1): the desktop window's minimum size is the
    /// plan's 1000×640 — above the shell-mode bound of the app-shell audit
    /// (768×520), so the desktop app can never reach the flow layout
    /// (DEC-2: "the desktop window has a minimum size that keeps it in shell
    /// mode"). The value lives in `desktop_window_config()`, not the Tauri
    /// conf JSON (its `app.windows` is empty by design).
    #[test]
    fn desktop_window_min_size_keeps_shell_mode() {
        let window = desktop_window_config();
        let (w, h) = window.min_inner_size;
        assert_eq!(
            (w, h),
            (1000.0, 640.0),
            "the desktop window floor must stay at 1000x640 (shell mode, DEC-2)",
        );
        assert!(
            w >= 768.0 && h >= 520.0,
            "the floor must clear the app-shell shell-mode bound",
        );
    }

    /// The default capability set grants webview-window creation. The pop-out
    /// window itself is built Rust-side by the harness (so the create path does
    /// not depend on this ACL grant), but keeping the grant present is
    /// defense-in-depth for any JS-initiated multi-window surface and documents
    /// intent. Parsed as a raw-string presence check to avoid a serde_json dep.
    #[test]
    fn default_capabilities_grant_webview_window_creation() {
        const CAPS: &str = include_str!("../capabilities/default.json");
        assert!(
            CAPS.contains("core:webview:allow-create-webview-window"),
            "capabilities/default.json should grant \
             core:webview:allow-create-webview-window",
        );
    }

    /// TEST-UR-10 (ITEM-10): the opener path permission is exactly the one
    /// added line — present ONCE, alongside the pre-existing `opener:default`
    /// grant and the capability set's other entries (the permission was
    /// verified against the plugin's autogenerated permission set:
    /// `allow-open-path` exists in tauri-plugin-opener 2.5.4's
    /// `permissions/autogenerated/commands/open_path.toml`). The ACL grant
    /// carries no host (the guard-suite network allowlist scans this file
    /// for URLs only, so the line keeps it byte-identical in the allowlist).
    #[test]
    fn default_capabilities_grant_the_opener_open_path_permission() {
        const CAPS: &str = include_str!("../capabilities/default.json");
        assert!(
            CAPS.contains("opener:default"),
            "the pre-existing opener:default grant stays (ITEM-10 touches one line)",
        );
        assert_eq!(
            CAPS.matches("opener:allow-open-path").count(),
            1,
            "capabilities/default.json gains exactly the opener open-path \
             permission (DEC-9's one-permission-line ruling)",
        );
    }

    /// TEST-UR-10 (ITEM-10): the new command is wired into the invoke handler
    /// list. `generate_handler!` output is not introspectable, so the pin is
    /// the registration SOURCE (the same raw-string style as the capability
    /// assertions above): the compile already proves the command exists with
    /// a valid `#[tauri::command]` signature, and this proves the list names
    /// it — removing the line from `register_invoke_handler` fails this test,
    /// leaving the UI's `reveal_in_file_manager` invoke unmapped.
    #[test]
    fn register_invoke_handler_wires_the_reveal_command() {
        const SRC: &str = include_str!("lib.rs");
        assert!(
            SRC.contains("commands::reveal_in_file_manager"),
            "register_invoke_handler must register the folder-reveal command",
        );
    }

    /// TEST-IR-16 (ITEM-3 half): the setup closure provisions the bundled
    /// models BEFORE the boot→window spawn — the env-var-before-server-boot
    /// order PROV-IR-8 pins (the pretrained_catalogue module reads
    /// `CYTO_TXR_BUNDLED_MODELS_DIR` at module init, so the provision must
    /// run first). Source-order assertion, same raw-string discipline as the
    /// capability tests; the post-window update-check half of TEST-IR-16 is
    /// ITEM-4's, with the boot-check start.
    #[test]
    fn setup_provisions_bundled_models_before_the_boot_spawn() {
        const SRC: &str = include_str!("lib.rs");
        let provision = SRC
            .find("bundled_models::provision_bundled_models(app.handle())")
            .expect("the setup closure calls the bundled-model provision");
        let spawn = SRC
            .find("spawn_boot_then_window(boot,")
            .expect("the setup closure spawns the boot→window lifecycle");
        assert!(
            provision < spawn,
            "provision_bundled_models must run before spawn_boot_then_window \
             (the env var precedes server module init, PROV-IR-8)",
        );
    }

    /// TEST-IR-16 (ITEM-4 half): the post-window path registers the update
    /// runtime and starts the boot check EXACTLY ONCE, after the boot→window
    /// spawn — PROV-IR-8's third step (the boot check fires after the shell
    /// is up; the ask appears only when an update was found).
    #[test]
    fn setup_starts_the_boot_check_after_the_spawn_exactly_once() {
        const SRC: &str = include_str!("lib.rs");
        let spawn = SRC
            .find("spawn_boot_then_window(boot,")
            .expect("the setup closure spawns the boot→window lifecycle");
        let register = SRC
            .find("updates::register(app.handle())")
            .expect("the setup closure registers the update runtime");
        let boot_check = SRC
            .find("updates::start_boot_check(app.handle())")
            .expect("the setup closure starts the boot check");
        assert!(
            spawn < register && register < boot_check,
            "PROV-IR-8 ordering: spawn_boot_then_window → updates::register \
             → updates::start_boot_check (the runtime must exist before the \
             check; the check fires after the window spawn)",
        );
        assert_eq!(
            SRC.matches("updates::start_boot_check(app.handle());\n").count(),
            1,
            "the boot check is started exactly once per app start (DEC-14)",
        );
    }

    /// TEST-IR-14 (ITEM-4 half): the invoke handler registers the three
    /// update commands — the same raw-string pin as the reveal-command test
    /// (the compile proves the command signatures; this proves the list).
    #[test]
    fn register_invoke_handler_wires_the_update_commands() {
        const SRC: &str = include_str!("lib.rs");
        for command in [
            "updates::get_update_status",
            "updates::check_for_update",
            "updates::install_update",
        ] {
            assert!(
                SRC.contains(command),
                "register_invoke_handler must register {command} (PROV-IR-6)",
            );
        }
    }

    /// TEST-IR-14 (ITEM-4 half): `plugins.updater.endpoints` in
    /// `tauri.conf.json` carries EXACTLY the crate's `UPDATER_FEED_URL` — the
    /// one constant (DEC-4: both sides, one value; the plugin dials the
    /// config, the seam contract names the constant).
    #[test]
    fn config_endpoints_match_the_feed_url_constant() {
        const CONF: &str = include_str!("../tauri.conf.json");
        assert!(
            CONF.contains(updates::UPDATER_FEED_URL),
            "tauri.conf.json plugins.updater.endpoints must carry \
             UPDATER_FEED_URL ({})",
            updates::UPDATER_FEED_URL,
        );
    }
}
