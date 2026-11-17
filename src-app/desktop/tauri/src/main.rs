// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The Windows installer's `--wsl-status` answers before the app starts.
    if let Some(code) = txresbench_desktop_lib::installer_cli::cli_mode(std::env::args_os().skip(1)) {
        std::process::exit(code);
    }
    txresbench_desktop_lib::run()
}
