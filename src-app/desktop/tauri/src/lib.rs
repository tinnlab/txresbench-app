//! CytoAnalyst desktop — a Tauri shell over the SDK's `ziee-desktop-harness`.
//!
//! Single-user desktop deployment: embeds the CytoAnalyst server, auto-provisions
//! + auto-logs-in the owner, and shows the web UI in a native window. Almost all
//! of the shell (window construction, boot→window lifecycle, single-user mint) is
//! inherited from the harness; this crate supplies only the `ServerBoot` impl,
//! the two IPC commands, and the owner-creation seam.

mod commands;
mod config;
mod server_boot;

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
pub(crate) fn desktop_window_config() -> WindowConfig {
    WindowConfig {
        title: "TxResBench".to_string(),
        inner_size: (1200.0, 800.0),
        min_inner_size: (400.0, 600.0),
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
        .plugin(tauri_plugin_dialog::init());

    register_invoke_handler(builder)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let window = desktop_window_config();

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
}
