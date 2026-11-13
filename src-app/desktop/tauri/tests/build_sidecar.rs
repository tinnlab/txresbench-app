//! The build script's sidecar helpers (`build_sidecar.rs`) and the shipped
//! `bundle.externalBin` wiring they read.

#[path = "../build_sidecar.rs"]
mod build_sidecar;

use std::path::Path;

use build_sidecar::{external_bins, patch_without_external_bin, sidecar_path};

const CONF: &str = include_str!("../tauri.conf.json");

#[test]
fn the_shipped_config_lists_the_oras_sidecar() {
    assert_eq!(
        external_bins(CONF).unwrap(),
        vec!["binaries/oras".to_string()]
    );
}

#[test]
fn external_bins_reads_absent_and_rejects_malformed_entries() {
    assert!(external_bins(r#"{"bundle":{}}"#).unwrap().is_empty());
    assert!(external_bins(r#"{"bundle":{"externalBin":null}}"#)
        .unwrap()
        .is_empty());
    assert!(external_bins(r#"{"bundle":{"externalBin":"binaries/oras"}}"#).is_err());
    assert!(external_bins(r#"{"bundle":{"externalBin":[1]}}"#).is_err());
    assert!(external_bins("not json").is_err());
}

/// The names `scripts/fetch-oras.mjs` writes and tauri-build looks for.
#[test]
fn sidecar_paths_follow_the_tauri_naming() {
    let dir = Path::new("/crate");
    assert_eq!(
        sidecar_path(dir, "binaries/oras", "aarch64-apple-darwin"),
        dir.join("binaries/oras-aarch64-apple-darwin")
    );
    assert_eq!(
        sidecar_path(dir, "binaries/oras", "x86_64-unknown-linux-gnu"),
        dir.join("binaries/oras-x86_64-unknown-linux-gnu")
    );
    assert_eq!(
        sidecar_path(dir, "binaries/oras", "x86_64-pc-windows-msvc"),
        dir.join("binaries/oras-x86_64-pc-windows-msvc.exe")
    );
}

#[test]
fn the_patch_removes_external_bin_and_keeps_an_existing_patch() {
    let fresh: serde_json::Value =
        serde_json::from_str(&patch_without_external_bin(None).unwrap()).unwrap();
    assert_eq!(
        fresh,
        serde_json::json!({ "bundle": { "externalBin": null } })
    );

    let blank: serde_json::Value =
        serde_json::from_str(&patch_without_external_bin(Some("  ")).unwrap()).unwrap();
    assert_eq!(blank, fresh);

    let merged: serde_json::Value = serde_json::from_str(
        &patch_without_external_bin(Some(
            r#"{"version":"9.9.9","bundle":{"active":false,"externalBin":["x"]}}"#,
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        merged,
        serde_json::json!({
            "version": "9.9.9",
            "bundle": { "active": false, "externalBin": null }
        })
    );

    let drops_bundle: serde_json::Value =
        serde_json::from_str(&patch_without_external_bin(Some(r#"{"bundle":null}"#)).unwrap())
            .unwrap();
    assert_eq!(drops_bundle, serde_json::json!({ "bundle": null }));

    assert!(patch_without_external_bin(Some("[]")).is_err());
    assert!(patch_without_external_bin(Some(r#"{"bundle":1}"#)).is_err());
    assert!(patch_without_external_bin(Some("{")).is_err());
}
