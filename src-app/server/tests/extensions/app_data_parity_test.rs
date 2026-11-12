//! TEST-14 [ITEM-12] [acceptance] [invariant: INV-6] — desktop parity: the whole
//! extract+scan pipeline derives its folder SOLELY from `rootfs::data_root()`
//! (which honors `TXR_APP_DATA_DIR`, else the SDK's `get_app_data_dir()`), so there
//! is NO server-vs-desktop path fork. The desktop bundles the SAME `txresbench`
//! crate (`boot_in_background`) with the SAME `include_dir!` seed and NO module
//! blocklist, so proving the server extracts UNDER its app-data dir proves the
//! desktop does too.
//!
//! The integration harness sets `TXR_APP_DATA_DIR` to each test's isolated data dir
//! (`common/mod.rs`), so a real spawned server's processors folder MUST land under
//! `server.data_dir()` — never a shared global home. That is exactly the app-data-dir
//! derivation the desktop relies on.

use serde_json::Value;

use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn extract_and_scan_land_under_the_app_data_dir() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // The processors folder is UNDER the server's app-data dir (TXR_APP_DATA_DIR),
    // not a global `~/.app` — the single `rootfs::data_root()` derivation (INV-6).
    let data_dir = server.data_dir();
    let processors_dir = data_dir.join("processors");
    assert!(
        processors_dir.is_dir(),
        "the seed extracted under the app-data dir: {}",
        processors_dir.display()
    );
    assert!(
        processors_dir.starts_with(data_dir),
        "the extracted processors folder is under the app-data dir (no path fork): {} not under {}",
        processors_dir.display(),
        data_dir.display()
    );

    // The seed packages physically landed there (extract, not just a stub dir).
    let seed_manifest = processors_dir.join(".seed-manifest.json");
    assert!(
        seed_manifest.is_file(),
        "the top-level seed reconciliation manifest is present under the app-data dir"
    );
    assert!(
        processors_dir.join("anndata-import").join("manifest.yaml").is_file(),
        "a seed package's manifest was extracted under the app-data dir"
    );

    // The scan of that folder feeds the served registry (the same path desktop uses).
    let resp = server
        .client
        .get(server.api_url("/processors"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /processors");
    assert_eq!(resp.status().as_u16(), 200, "authed dump → 200");
    let body: Value = resp.json().await.expect("json");
    let packages = body.as_array().expect("array");
    assert!(
        packages.iter().any(|p| p["id"] == "anndata-import" && p["ok"] == true),
        "the registry scanned from the app-data-dir folder lists the seed packages"
    );
}
