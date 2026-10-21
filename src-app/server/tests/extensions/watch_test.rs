//! TEST-16 [ITEM-13, INV-10] [acceptance] — the LIVE filesystem watcher.
//!
//! With the real server's live watcher running on `<data_root>/processors/` (the
//! default-ON kill-switch), a fresh package written to disk at RUNTIME is
//! AUTO-REFLECTED into the registry (visible via `GET /api/extensions`) after the
//! debounce window — WITHOUT any call to the reload endpoint and WITHOUT a restart.
//! Removing it makes it absent after the next debounce. Drives the REAL server (its
//! own boot-started watcher + arc-swap republish), process-isolated so the global
//! registry swap is safe.

use std::time::{Duration, Instant};

use super::setup_admin;
use crate::common::TestServer;

/// GET `/api/extensions` and return whether an extension with `id` is present.
async fn extension_present(server: &TestServer, token: &str, id: &str) -> bool {
    let resp = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET /extensions");
    assert_eq!(resp.status().as_u16(), 200, "authed dump → 200");
    let body: serde_json::Value = resp.json().await.expect("extensions json");
    body.as_array()
        .expect("dump is an array")
        .iter()
        .any(|e| e["id"] == id)
}

/// Poll `GET /api/extensions` until `id`'s presence == `want`, up to `bound`.
async fn wait_for_presence(
    server: &TestServer,
    token: &str,
    id: &str,
    want: bool,
    bound: Duration,
) -> bool {
    let start = Instant::now();
    loop {
        if extension_present(server, token, id).await == want {
            return true;
        }
        if start.elapsed() >= bound {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

// A package dir dropped into `<data_root>/processors/` at runtime is auto-reflected
// (present) after the debounce with NO reload call; removing it makes it absent.
#[tokio::test]
async fn live_watcher_reflects_dropin_and_removal_without_reload() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let processors_dir = server.data_dir().join("processors");
    // The boot extract created it; assert so a path regression fails loudly here.
    assert!(
        processors_dir.is_dir(),
        "the server extracted the processors folder at boot: {}",
        processors_dir.display()
    );

    let id = "watch-dropin";
    assert!(
        !extension_present(&server, &token, id).await,
        "the drop-in is absent before it is written"
    );

    // Drop a minimal, VALID package (passes `lint_processor_package`) at runtime —
    // no reload endpoint is called; only the live watcher can surface it.
    let pkg = processors_dir.join(id);
    std::fs::create_dir_all(pkg.join("compute")).expect("create pkg dir");
    std::fs::write(
        pkg.join("manifest.yaml"),
        "id: watch-dropin\nname: Watch Dropin\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\ncontributes: {}\n",
    )
    .expect("write manifest");

    // AUTO-REFLECT: it appears within a generous bound (debounce is 500 ms; the box
    // may be loaded, so poll up to 20 s rather than race a fixed sleep).
    let appeared = wait_for_presence(&server, &token, id, true, Duration::from_secs(20)).await;
    assert!(
        appeared,
        "the dropped-in package auto-reflected into GET /api/extensions without a reload"
    );

    // REMOVE it → absent after the next debounce.
    std::fs::remove_dir_all(&pkg).expect("remove pkg dir");
    let vanished = wait_for_presence(&server, &token, id, false, Duration::from_secs(20)).await;
    assert!(
        vanished,
        "the removed package auto-reflected to ABSENT in GET /api/extensions without a reload"
    );
}
