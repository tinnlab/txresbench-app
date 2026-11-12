//! Extensions module integration tests (ITEM-1/2/3/10) — the backend-owned
//! extension-manifest registry served over `GET /api/extensions`. Full production
//! path: a real spawned server (which builds the registry from the baked
//! `src-app/packages/*/manifest.yaml` tree at boot) + the `projects::use`-gated
//! HTTP surface the FE `workbenchRegistry` mirrors.

use serde_json::{json, Value};

use crate::common::TestServer;

/// First-run setup → the admin owner + their access token (holds `*`).
pub async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "extadmin",
            "email": "ext@txresbench.test",
            "password": "extPassw0rd!",
            "display_name": "Ext Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    let body: Value = resp.json().await.expect("setup json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a regular user (admin action) — auto-joined to the Users group, so they
/// hold `projects::use` but are NOT the root admin. Used by the reload authz test to
/// get a non-admin token (403 on `RequireAdmin`, 200 on the `projects::use` list).
pub async fn create_user(server: &TestServer, admin: &str, username: &str, email: &str) {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": email,
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert!(resp.status().is_success(), "create user {username}: {}", resp.status());
}

/// Log a regular user in → their access token.
pub async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status().as_u16(), 200, "login {username}");
    let body: Value = resp.json().await.expect("login json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Write a FRESH, separate-repo-shaped fixture package into the server's extracted
/// `<data_root>/processors/` folder AT RUNTIME (the INV-3 drop-in substrate, ITEM-10):
/// a new datatype id + a declarative `ui/*.yaml` + a `compute/*.py`, NONE of which is
/// in the embedded seed. Returns the package dir. The caller then triggers a rescan
/// (the admin reload endpoint or the live watcher) — proving a package authored in a
/// SEPARATE repo is discovered with ZERO binary rebuild and ZERO app-file edit.
///
/// `datatype_id` is the fixture's contributed datatype (asserted absent from every
/// app/builtin source by the drop-in acceptance test — INV-3).
pub fn write_dropin_fixture(
    processors_dir: &std::path::Path,
    pkg_id: &str,
    datatype_id: &str,
    compute_entry: &str,
) -> std::path::PathBuf {
    let pkg = processors_dir.join(pkg_id);
    std::fs::create_dir_all(pkg.join("compute")).expect("create compute dir");
    std::fs::create_dir_all(pkg.join("ui")).expect("create ui dir");

    // A full separate-repo package: a contributed datatype (with a viewer edge) + a
    // converter routing to the co-located compute + a declarative view_spec. Passes
    // `lint_processor_package` (the SAME validator `build.rs` runs).
    std::fs::write(
        pkg.join("manifest.yaml"),
        format!(
            "id: {pkg_id}\n\
             name: Drop-in Acceptance Package\n\
             publisher: acme-labs\n\
             version: 0.1.0\n\
             apiVersion: \"1.0\"\n\
             contributes:\n\
             \x20 datatypes:\n\
             \x20   - id: {datatype_id}\n\
             \x20     extends: data\n\
             \x20     title: Drop-in widget\n\
             \x20     description: A separate-repo datatype proving zero-rebuild discovery.\n\
             \x20     is_abstract: false\n\
             \x20     storage:\n\
             \x20       layout: {{ kind: columnar_table }}\n\
             \x20       format: parquet\n\
             \x20       file_layout: single\n\
             \x20     viewers:\n\
             \x20       - {{ view_kind_id: dropin-widget-view, family: deckgl, consumes: [] }}\n\
             \x20 converters:\n\
             \x20   - id: {pkg_id}-convert\n\
             \x20     title: Convert drop-in widget\n\
             \x20     trigger: on-integrate\n\
             \x20     params: none\n\
             \x20     env: single-cell\n\
             \x20     accepts:\n\
             \x20       - type_id: {datatype_id}\n\
             \x20     produces:\n\
             \x20       - datatype: metadata-column\n\
             \x20         cardinality: many\n\
             \x20     run:\n\
             \x20       kind: sandbox\n\
             \x20       runtime: python\n\
             \x20       entry: {compute_entry}\n"
        ),
    )
    .expect("write manifest");

    // The co-located compute the converter's run.entry points at (proves compute
    // travels WITH the package — the bytes are read from the folder, INV-7).
    std::fs::write(
        pkg.join(compute_entry),
        "import json, sys\n# Separate-repo compute: emits one metadata-column.\nprint(json.dumps({\"ok\": True}))\n",
    )
    .expect("write compute");

    // A declarative view_spec (DATA, discovered FE-side; its mere presence proves the
    // ui/*.yaml leg of a separate-repo package travels through extract+scan).
    std::fs::write(
        pkg.join("ui").join("dropin.yaml"),
        format!("id: {pkg_id}.view\ntitle: Drop-in widget\n"),
    )
    .expect("write ui view_spec");

    pkg
}

mod api_test;
mod app_data_parity_test;
mod datatype_contribution_test;
mod rejection_report_test;
mod reload_api_test;
mod runtime_dropin_test;
mod view_spec_test;
mod watch_test;
