//! Draftable-entity integration tests — full production path through a real spawned
//! server + real Postgres (per-test DB). Covers CRUD + list filtering (TEST-10),
//! owner/project-scoped 404 (TEST-3), the auth gate 401/403 (TEST-8), the 256 KiB
//! data cap (TEST-9), the baseline migration + grant (TEST-12), the project-audience
//! sync emit (TEST-6), and the opaque-kind round-trip (TEST-1, create→get half; the
//! freeze half is sandbox-tier — see `freeze_note`).
//!
//! Freeze-transition tests (TEST-2/4/5/17) run the package's freeze producer through
//! the sandbox and therefore need the analysis rootfs + a fixture producer package;
//! they live in `freeze_note` with the environment requirement documented.

use serde_json::{json, Value};

use crate::common::TestServer;

mod auth_gate_test;
mod auto_freeze_on_consume_test;
mod concurrency_edges_test;
mod crud_test;
mod data_cap_test;
mod freeze_note;
mod migration_test;
mod opaque_kind_test;
mod ownership_test;
mod sync_emit_test;

// ------------------------------- helpers -------------------------------

/// First-run setup → the admin owner + their access token.
pub async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "admin",
            "email": "admin@txresbench.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 200);
    token_of(resp.json().await.expect("setup json"))
}

pub fn token_of(body: Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a user (admin) — auto-joined to the Users group, so they hold
/// `projects::use` + `drafts::use` (the migration grants). Returns the id.
pub async fn create_user(server: &TestServer, admin: &str, username: &str, email: &str) -> String {
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
    let body: Value = resp.json().await.expect("user json");
    body["user"]["id"].as_str().expect("user id").to_string()
}

/// Log in → an access token.
pub async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status().as_u16(), 200, "login {username}");
    token_of(resp.json().await.expect("login json"))
}

/// Create a user then STRIP them from the Users group → they no longer hold
/// `drafts::use` (for the A9 deny path).
pub async fn create_user_without_drafts(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user(server, admin, username, email).await;
    // The `/groups` HTTP surface is stripped on this node; the removal goes
    // through the SDK user repository over a pool on the per-test DB.
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect strip pool");
    crate::common::group_remove_from_users(
        &pool,
        uuid::Uuid::parse_str(&id).expect("user id is a uuid"),
    )
    .await;
    id
}

pub async fn create_project(server: &TestServer, token: &str, name: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(resp.status().as_u16(), 201, "create project {name}");
    let body: Value = resp.json().await.expect("project json");
    body["id"].as_str().expect("project id").to_string()
}

/// POLL a draft until it reports `frozen` (300 s budget), returning the frozen row. The
/// freeze was already POSTed (202); this awaits the background producer run. Shared by the
/// freeze + auto-freeze-on-consume acceptance tests.
pub async fn wait_frozen(server: &TestServer, token: &str, id: &str) -> Value {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        let row: Value = server
            .client
            .get(server.api_url(&format!("/drafts/{id}")))
            .bearer_auth(token)
            .send()
            .await
            .expect("get draft")
            .json()
            .await
            .unwrap_or(Value::Null);
        if row["status"] == json!("frozen") {
            return row;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the background freeze did not reach `frozen` in time: {row}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

// ------------------------- freeze fixture install (TEST-2/4/5/17) -------------------------

/// The in-repo fixture root holding ONLY the `test-widget/` draftable freeze-producer
/// package (out of `src-app/packages/`, so it never leaks into the shipped seed).
fn fixture_packages_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/draftable-packages")
}

/// Recursively copy `src` → `dst` (plain files + dirs; no symlinks in the fixture).
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Install the `test-widget` draftable freeze-producer fixture so the freeze happy-path
/// INVARIANTS can EXECUTE against the spawned server + real sandbox. Two installs:
///
/// (a) MERGE the fixture manifest into the TEST-process extension registry
///     (`loader::try_registry` base ∪ the fixture, `from_manifests` → `set_global_registry`),
///     for any in-process reader. `set_global_registry` overwrites with a SUPERSET, so the
///     `test/widget` refusal tests (which rely on `test/widget` being UNregistered) are
///     unaffected — the fixture registers only the extra `test/frozen-widget` kind.
///
/// (b) COPY the fixture package into the SPAWNED server's
///     `<data_root>/processors/test-widget/` (so the sandbox runner can stage
///     `compute/produce.py`), then `POST /api/processors/reload` (admin) so the SUBPROCESS
///     atomically rebuilds BOTH its extension + datatype registries and resolves the freeze
///     producer.
///
/// `Ok(())` = the fixture LOADED (lint-clean, registered) on both sides. `Err(reason)` names
/// the exact blocker (a lint rejection, a reload non-200, a scan skip) so the caller can
/// `record_skip` with a precise message. It does NOT gate on the sandbox being runnable —
/// callers pair this with [`rootfs_gate`](crate::dataset::hardening_common::rootfs_gate).
pub async fn install_test_widget_fixture(server: &TestServer, admin: &str) -> Result<(), String> {
    use txresbench::modules::extensions::{loader, ExtensionRegistry};

    let fixture_parent = fixture_packages_dir();

    // (a) Build the fixture registry from the fixture folder — this ALSO runs
    // `lint_processor_package` over `test-widget`, so a manifest the lint rejects (e.g. a
    // draftable block the build-lint mirror does not accept) surfaces HERE as a load error.
    let fixture_reg = ExtensionRegistry::build_from_dir(&fixture_parent)
        .map_err(|e| format!("fixture build_from_dir failed: {e}"))?;
    if fixture_reg.get("test-widget").is_none() {
        let why = fixture_reg
            .load_status()
            .iter()
            .find(|s| s.id == "test-widget")
            .and_then(|s| s.error.clone())
            .unwrap_or_else(|| "test-widget was not scanned (no manifest?)".to_string());
        return Err(format!("fixture lint/scan rejected test-widget: {why}"));
    }
    let mut merged: Vec<txresbench::modules::extensions::types::ExtensionManifest> =
        loader::try_registry()
            .map(|r| r.all().into_iter().cloned().collect())
            .unwrap_or_default();
    for m in fixture_reg.all() {
        if !merged.iter().any(|x| x.id == m.id) {
            merged.push(m.clone());
        }
    }
    let merged_reg = ExtensionRegistry::from_manifests(merged)
        .map_err(|e| format!("merge test-process registry failed: {e}"))?;
    loader::set_global_registry(std::sync::Arc::new(merged_reg));

    // (b) Copy into the spawned server's processors folder + reflect (reload).
    let dst = server.data_dir().join("processors").join("test-widget");
    copy_dir_all(&fixture_parent.join("test-widget"), &dst)
        .map_err(|e| format!("copy fixture into {}: {e}", dst.display()))?;

    let resp = server
        .client
        .post(server.api_url("/processors/reload"))
        .bearer_auth(admin)
        .send()
        .await
        .map_err(|e| format!("processors reload request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status != 200 {
        return Err(format!("POST /processors/reload returned {status}: {body}"));
    }
    let loaded = body["packages"]
        .as_array()
        .map(|a| {
            a.iter()
                .any(|p| p["id"] == "test-widget" && p["ok"] == json!(true))
        })
        .unwrap_or(false);
    if !loaded {
        let why = body["packages"]
            .as_array()
            .and_then(|a| a.iter().find(|p| p["id"] == "test-widget"))
            .and_then(|p| p["error"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("test-widget absent from reload set: {body}"));
        return Err(format!("subprocess did not register test-widget: {why}"));
    }
    Ok(())
}

/// Create a draft → the full draft row. `kind` is opaque; `data` is any JSON.
pub async fn create_draft(
    server: &TestServer,
    token: &str,
    project_id: &str,
    kind: &str,
    data: Value,
) -> Value {
    let resp = server
        .client
        .post(server.api_url("/drafts"))
        .bearer_auth(token)
        .json(&json!({ "kind": kind, "project_id": project_id, "data": data }))
        .send()
        .await
        .expect("create draft");
    assert_eq!(resp.status().as_u16(), 201, "create draft {kind}");
    resp.json().await.expect("draft json")
}
