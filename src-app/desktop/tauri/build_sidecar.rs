//! The sidecar check the desktop build script runs before `tauri_build::build()`.
//!
//! `tauri.conf.json` ships `oras` as a sidecar (`bundle.externalBin:
//! ["binaries/oras"]`). tauri-build copies `binaries/oras-<target-triple>`
//! (`.exe` on Windows) next to the compiled binary and FAILS the build when the
//! file is missing. `scripts/fetch-oras.mjs` writes it, and `tauri build` /
//! `tauri dev` run that script first (beforeBuildCommand / beforeDevCommand),
//! but a plain `cargo check` / `cargo test` / `cargo build` never does. For
//! those builds only, [`drop_missing_sidecars`] removes `bundle.externalBin`
//! from the config tauri-build reads (the `TAURI_CONFIG` merge patch) and
//! prints a cargo warning: the binary then has no sidecar next to it and the
//! server's `tool_bin` falls back to `<app_data>/bin` and `PATH`.
//!
//! An installer cannot ship without the sidecar: the Tauri bundler reads
//! `tauri.conf.json` itself (this patch never reaches it) and fails when
//! `binaries/oras-<target-triple>` is absent.
//!
//! The pure helpers are also compiled by `tests/build_sidecar.rs`.

use std::path::{Path, PathBuf};

/// The `bundle.externalBin` entries of a `tauri.conf.json` document.
pub fn external_bins(conf_json: &str) -> Result<Vec<String>, String> {
    let conf: serde_json::Value =
        serde_json::from_str(conf_json).map_err(|e| format!("tauri.conf.json is not JSON: {e}"))?;
    match conf.pointer("/bundle/externalBin") {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("bundle.externalBin entry {v} is not a string"))
            })
            .collect(),
        Some(other) => Err(format!("bundle.externalBin is not an array: {other}")),
    }
}

/// The file tauri-build expects for `entry` on `target_triple`:
/// `<entry>-<target-triple>`, plus `.exe` for a Windows target (the naming of
/// tauri-utils' `resources::external_binaries`).
pub fn sidecar_path(manifest_dir: &Path, entry: &str, target_triple: &str) -> PathBuf {
    let ext = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    manifest_dir.join(format!("{entry}-{target_triple}{ext}"))
}

/// The `TAURI_CONFIG` value that removes `bundle.externalBin` (a JSON merge
/// patch: `null` deletes the key), merged over an `existing` patch.
pub fn patch_without_external_bin(existing: Option<&str>) -> Result<String, String> {
    let mut patch: serde_json::Value = match existing.map(str::trim) {
        Some(s) if !s.is_empty() => {
            serde_json::from_str(s).map_err(|e| format!("TAURI_CONFIG is not JSON: {e}"))?
        }
        _ => serde_json::json!({}),
    };
    let root = patch
        .as_object_mut()
        .ok_or_else(|| "TAURI_CONFIG is not a JSON object".to_string())?;
    let bundle = root
        .entry("bundle")
        .or_insert_with(|| serde_json::json!({}));
    match bundle {
        // the existing patch already deletes the whole `bundle` object
        serde_json::Value::Null => {}
        serde_json::Value::Object(b) => {
            b.insert("externalBin".to_string(), serde_json::Value::Null);
        }
        other => return Err(format!("TAURI_CONFIG bundle is not an object: {other}")),
    }
    Ok(patch.to_string())
}

/// Build-script entry: when a listed sidecar is missing for `TARGET`, drop
/// `bundle.externalBin` for this build and warn (see the module docs).
#[allow(dead_code)] // called by build.rs only; the tests compile the helpers above
pub fn drop_missing_sidecars() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"),
    );
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let conf_path = manifest_dir.join("tauri.conf.json");
    let conf = std::fs::read_to_string(&conf_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", conf_path.display()));
    let entries = external_bins(&conf).unwrap_or_else(|e| panic!("{e}"));
    let missing: Vec<PathBuf> = entries
        .iter()
        .map(|entry| sidecar_path(&manifest_dir, entry, &target))
        .filter(|p| !p.is_file())
        .collect();
    if missing.is_empty() {
        return;
    }
    for p in &missing {
        // Re-run once the file appears, so the next build copies it.
        println!("cargo:rerun-if-changed={}", p.display());
        println!(
            "cargo:warning=sidecar {} is missing (run `node scripts/fetch-oras.mjs {target}` from \
             the repository root); this build leaves out bundle.externalBin, so the app looks for \
             oras in <app_data>/bin and on PATH only",
            p.display()
        );
    }
    let patch = patch_without_external_bin(std::env::var("TAURI_CONFIG").ok().as_deref())
        .unwrap_or_else(|e| panic!("{e}"));
    std::env::set_var("TAURI_CONFIG", patch);
}
