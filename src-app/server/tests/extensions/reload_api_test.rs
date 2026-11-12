//! TEST-17 [ITEM-9/11] — the runtime processor control-plane REST: `GET
//! /api/processors` (per-package load status, `sandbox::settings::read`) +
//! `POST /api/processors/reload` (reflect trigger, `sandbox::settings::manage`) +
//! `GET /api/processors/packages` (FE view-spec source assets, `projects::use`). Drives
//! the REAL spawned server (its own boot-built registry + the shared `reflect_processors`
//! path), no mocking. (M6: the reload/list perms were reconciled from the original
//! root-only `RequireAdmin` / `projects::use` so each client self-gate equals the perm the
//! endpoint enforces.)
//!
//! Covers: reload authz (401 unauth / 403 non-admin / 2xx admin); the reload response
//! carries the discovered set + per-package load status; `GET /api/processors` returns
//! the same per-package status; and a MALFORMED package dropped into the folder + a
//! reload surfaces as `ok:false` with its package-scoped error while valid siblings stay
//! `ok:true` (INV-4 through the REST surface).

use serde_json::Value;

use super::{create_user, login, setup_admin};
use crate::common::TestServer;

// ---- reload authz: 401 unauthenticated / 403 non-admin / 2xx admin ----

#[tokio::test]
async fn reload_requires_admin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401 (refused before any reflect).
    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .send()
        .await
        .expect("unauth POST /processors/reload");
    assert_eq!(resp.status().as_u16(), 401, "no token → 401");

    // A regular user lacks `sandbox::settings::manage` → 403 (M6: reconciled from the
    // old root-only `RequireAdmin` to the perm the Administrators group holds via `*`).
    create_user(&server, &admin, "reloaduser", "reloaduser@txresbench.test").await;
    let user = login(&server, "reloaduser").await;
    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(&user)
        .send()
        .await
        .expect("non-admin POST /processors/reload");
    assert_eq!(resp.status().as_u16(), 403, "no sandbox::settings::manage → 403");

    // The admin (holds the perm via `*`) → 2xx, carrying the discovered set + status.
    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin POST /processors/reload");
    assert_eq!(resp.status().as_u16(), 200, "admin → 200");
    let body: Value = resp.json().await.expect("reload json");
    assert!(
        body["registered"].as_u64().expect("registered count") >= 1,
        "at least the anndata-import extension is registered after a reflect"
    );
    let packages = body["packages"].as_array().expect("packages array");
    assert!(!packages.is_empty(), "the discovered set is non-empty");
    // Every entry carries the load-status shape (id + ok flag).
    assert!(
        packages.iter().all(|p| p["id"].is_string() && p["ok"].is_boolean()),
        "each package has an id + ok flag"
    );
    // A valid seed sibling (qc) is present + ok.
    assert!(
        packages.iter().any(|p| p["id"] == "qc" && p["ok"] == true),
        "a valid seed package (qc) is ok in the reload response"
    );
}

// ---- GET /api/processors: per-package load status, projects::use gated ----

#[tokio::test]
async fn list_processors_requires_auth_and_dumps_status() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401.
    let resp = server
        .client
        .get(server.api_url("/processors"))
        .send()
        .await
        .expect("unauth GET /processors");
    assert_eq!(resp.status().as_u16(), 401, "no token → 401");

    // A regular user LACKS `sandbox::settings::read` → 403 (M6: the list is gated on the
    // same admin-held read-perm the `/settings/processors` page gates on, so the client
    // self-gate equals the endpoint perm — the FE never shows the page to a rejected user).
    create_user(&server, &admin, "listuser", "listuser@txresbench.test").await;
    let user = login(&server, "listuser").await;
    let resp = server
        .client
        .get(server.api_url("/processors"))
        .bearer_auth(&user)
        .send()
        .await
        .expect("user GET /processors");
    assert_eq!(resp.status().as_u16(), 403, "no sandbox::settings::read → 403");

    // The admin holds it via `*` → 200.
    let resp = server
        .client
        .get(server.api_url("/processors"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin GET /processors");
    assert_eq!(resp.status().as_u16(), 200, "sandbox::settings::read holder → 200");
    let body: Value = resp.json().await.expect("processors json");
    let packages = body.as_array().expect("the dump is a JSON array");
    assert!(!packages.is_empty(), "at least the seed packages are listed");
    assert!(
        packages.iter().any(|p| p["id"] == "anndata-import" && p["ok"] == true),
        "the anndata-import seed package is listed ok"
    );
}

// ---- GET /api/processors/packages: FE view-spec source assets, projects::use gated ----

#[tokio::test]
async fn packages_route_requires_auth_and_serves_assets() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401 (the §14 negative path).
    let resp = server
        .client
        .get(server.api_url("/processors/packages"))
        .send()
        .await
        .expect("unauth GET /processors/packages");
    assert_eq!(resp.status().as_u16(), 401, "no token → 401");

    // A regular user holds projects::use (Users group) → 200, serving each registered
    // package's manifest + ui/*.yaml bytes from the runtime folder.
    create_user(&server, &admin, "pkguser", "pkguser@txresbench.test").await;
    let user = login(&server, "pkguser").await;
    let resp = server
        .client
        .get(server.api_url("/processors/packages"))
        .bearer_auth(&user)
        .send()
        .await
        .expect("user GET /processors/packages");
    assert_eq!(resp.status().as_u16(), 200, "projects::use holder → 200");
    let body: Value = resp.json().await.expect("packages json");
    let packages = body["packages"].as_array().expect("packages array");
    // A seed package's manifest bytes are served (qc ships a ui/*.yaml view-spec).
    let qc = packages
        .iter()
        .find(|p| p["id"] == "qc")
        .expect("the qc seed package's assets are served");
    assert!(qc["manifest"].as_str().unwrap_or_default().contains("id: qc"), "manifest bytes served");
    assert!(qc["views"].as_array().map(|v| !v.is_empty()).unwrap_or(false), "qc ships a ui view-spec");
}

// ---- INV-4 through REST: a malformed drop-in shows ok:false; valid siblings ok:true ----

#[tokio::test]
async fn reload_surfaces_malformed_package_as_skipped_with_error() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let processors_dir = server.data_dir().join("processors");
    assert!(
        processors_dir.is_dir(),
        "the server extracted the processors folder at boot: {}",
        processors_dir.display()
    );

    // Drop a MALFORMED package — an unknown outer key trips the S1 validator's
    // `deny_unknown_fields` (the SAME lint `build.rs` runs).
    let bad = processors_dir.join("broken-rest-pkg");
    std::fs::create_dir_all(&bad).expect("create pkg dir");
    std::fs::write(
        bad.join("manifest.yaml"),
        "id: broken-rest-pkg\nname: Broken\npublisher: txr\nversion: 0.1.0\napiVersion: \"1.0\"\nbogus_unknown_key: true\ncontributes: {}\n",
    )
    .expect("write manifest");

    // Reload (admin) → 200; the reflect re-scans the folder and republishes.
    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin POST /processors/reload");
    assert_eq!(resp.status().as_u16(), 200, "admin reload → 200");
    let body: Value = resp.json().await.expect("reload json");
    let packages = body["packages"].as_array().expect("packages array");

    // The malformed package is present in the load status as ok:false, with a
    // package-scoped error naming it.
    let broken = packages
        .iter()
        .find(|p| p["id"] == "broken-rest-pkg")
        .expect("the malformed package appears in the load status");
    assert_eq!(broken["ok"], false, "the malformed package is skipped (ok:false)");
    let err = broken["error"].as_str().unwrap_or_default();
    assert!(err.contains("broken-rest-pkg"), "the error is package-scoped: {err}");

    // Valid seed siblings still register (ok:true) — the scan did not abort.
    assert!(
        packages.iter().any(|p| p["id"] == "anndata-import" && p["ok"] == true),
        "a valid seed sibling (anndata-import) still registers ok"
    );

    // GET /api/processors returns the SAME discovered set (malformed still ok:false).
    let resp = server
        .client
        .get(server.api_url("/processors"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin GET /processors");
    assert_eq!(resp.status().as_u16(), 200);
    let list: Value = resp.json().await.expect("processors json");
    let listed = list.as_array().expect("array");
    assert!(
        listed.iter().any(|p| p["id"] == "broken-rest-pkg" && p["ok"] == false),
        "GET /api/processors shows the malformed package skipped-with-error"
    );
}
