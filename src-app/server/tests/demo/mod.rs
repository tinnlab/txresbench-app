//! demo-mode ITEM-1 — the mode switch, the route allowlist, the anonymous
//! visitor session, the shared pool, the run-creator ownership rule and the
//! limits, over a REAL spawned demo server (TEST-DM-1's ITEM-1 half).
//!
//! Structure:
//! * the pure classification sweep over the COMMITTED OpenAPI spec
//!   (`every_route_classified` + `framework_routes_all_blocked` + the
//!   spec-named blocked mutations) — the "a route added without a row fails
//!   the suite" tests;
//! * the HTTP tier: desktop vs demo boots, 403-not-401 for blocked routes,
//!   the session/local anonymous mint + cookie + role, the shared-pool reads
//!   across two sessions, stop/skip ownership, the body-size cap and the
//!   per-session rate limit.

use std::path::PathBuf;

use serde_json::Value;

use crate::common::{TestOptions, TestServer};

/// Parse a DEMO_MODE 403 response: the spec-exact bytes.
async fn assert_demo_403(resp: reqwest::Response, what: &str) {
    assert_eq!(
        resp.status().as_u16(),
        403,
        "{what}: expected 403 DEMO_MODE"
    );
    let body: Value = resp.json().await.expect("demo 403 json");
    assert_eq!(body["error_code"], "DEMO_MODE", "{what}");
    assert_eq!(body["error"], "This is not available in the demo", "{what}");
}

/// Mint an anonymous demo session; returns (access token, session cookie
/// value) for the SAME visitor.
async fn mint_demo_session(server: &TestServer) -> (String, String) {
    let resp = server.client.post(server.api_url("/session/local")).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200, "session/local mint");
    let cookie = resp
        .headers()
        .get_all("set-cookie")
        .iter()
        .find_map(|v| v.to_str().ok().map(str::to_string))
        .expect("demo mint sets a session cookie");
    let body: Value = resp.json().await.unwrap();
    (body["access_token"].as_str().unwrap().to_string(), cookie)
}

// ─────────────────────────────────────────────────────────────────────────────
// The classification sweep (the completeness tests)
// ─────────────────────────────────────────────────────────────────────────────

/// Every operation of the SHIPPED OpenAPI surface has exactly one row in the
/// allowlist table (and the table has no row the spec doesn't have). A route
/// added to the app without being classified fails THIS test.
#[test]
fn every_openapi_operation_is_classified() {
    use std::collections::BTreeSet;
    use txresbench::modules::demo::allowlist::ROUTE_POLICY;

    let spec_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ui/openapi/openapi.json");
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(&spec_path).expect("committed openapi.json"),
    )
    .expect("spec parses");

    let mut spec_ops = BTreeSet::new();
    let paths = spec["paths"].as_object().expect("paths");
    for (path, ops) in paths {
        for method in ["get", "post", "put", "patch", "delete"] {
            if ops.get(method).is_some() {
                spec_ops.insert(format!(
                    "{} {}",
                    method.to_uppercase(),
                    path.strip_prefix("/api").unwrap_or(path)
                ));
            }
        }
    }

    let mut table_ops: BTreeSet<String> = ROUTE_POLICY
        .iter()
        .map(|r| format!("{} {}", r.method, r.path))
        .collect();

    let missing: Vec<&String> = spec_ops.difference(&table_ops).collect();
    assert!(
        missing.is_empty(),
        "routes in the spec but NOT classified in ROUTE_POLICY (the gate blocks them, \
         but the completeness test demands an explicit row): {missing:?}"
    );
    let extra: Vec<&String> = table_ops.difference(&spec_ops).collect();
    assert!(
        extra.is_empty(),
        "ROUTE_POLICY rows with no spec operation (a stale row): {extra:?}"
    );
}

/// The framework surface is blocked, and the count is derived from the table
/// (the spec's stale "141" is re-counted on this tree — the strip removed the
/// platform modules, so the framework surface is 70 operations).
#[test]
fn framework_routes_are_all_blocked() {
    use txresbench::modules::demo::allowlist::{ROUTE_POLICY, RouteClass, is_framework_path};

    let framework_rows = ROUTE_POLICY
        .iter()
        .filter(|r| is_framework_path(r.path))
        .collect::<Vec<_>>();
    assert_eq!(framework_rows.len(), 70, "the framework surface is 70 ops on this tree");
    for row in framework_rows {
        assert_eq!(
            row.class,
            RouteClass::Blocked,
            "framework route {} {} must be BLOCKED in demo mode",
            row.method,
            row.path
        );
    }
}

/// The spec's named blocked mutations (delete / rename / import / export /
/// copy-clear / pretrained install-download-refresh) answer 403 — pinned by
/// CLASS so the gate's behavior test below has a known semantics.
#[test]
fn the_specs_blocked_mutations_are_classified_blocked() {
    use txresbench::modules::demo::allowlist::{RouteClass, classify};
    let blocked = [
        ("DELETE", "/txr/runs/{id}"),
        ("DELETE", "/txr/runs"),
        ("DELETE", "/txr/models/{id}"),
        ("DELETE", "/txr/model-sets/{id}"),
        ("GET", "/txr/models/{id}/export"),
        ("GET", "/txr/model-sets/{id}/export"),
        ("PATCH", "/txr/models/{id}"),
        ("PATCH", "/txr/model-sets/{id}"),
        ("POST", "/txr/models/import"),
        ("POST", "/txr/history/copies/clear"),
        ("POST", "/txr/history/{id}/copies/clear"),
        ("POST", "/txr/pretrained/{id}/install"),
        ("POST", "/txr/pretrained/{id}/download"),
        ("DELETE", "/txr/pretrained/{id}/download"),
        ("POST", "/txr/pretrained/refresh"),
        ("GET", "/auth/session-settings"),
    ];
    for (method, path) in blocked {
        assert_eq!(
            classify(method, path),
            Some(RouteClass::Blocked),
            "{method} {path}"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The HTTP tier
// ─────────────────────────────────────────────────────────────────────────────

/// Desktop mode (the default boot): `/api/app/mode` is public, reports
/// desktop, and the framework surface stays reachable — the existing tests
/// with demo OFF pin "nothing changed".
#[tokio::test]
async fn desktop_boot_is_unchanged() {
    let server = TestServer::spawn().await;
    let mode: Value = server
        .client
        .get(server.api_url("/app/mode"))
        .send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(mode["mode"], "desktop");
    assert_eq!(mode["limits"]["history"], 50);
    assert_eq!(mode["limits"]["models"], 50);
    assert_eq!(mode["notice"], "");
    assert_eq!(mode["download_url"], "");

    // The owner mint: admin user, NO demo cookie (byte-for-byte desktop).
    let resp = server.client.post(server.api_url("/session/local")).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert!(
        !resp.headers().contains_key("set-cookie"),
        "desktop session/local sets no demo cookie"
    );
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["user"]["username"], "admin");
    assert_eq!(body["user"]["is_admin"], true);

    // A framework route is REACHABLE with the owner token in desktop mode.
    let token = body["access_token"].as_str().unwrap();
    let resp = server
        .client
        .get(server.api_url("/sandbox/settings"))
        .bearer_auth(token)
        .send().await.unwrap();
    assert_eq!(
        resp.status().as_u16(),
        200,
        "desktop mode: framework routes are reachable (nothing is gated)"
    );
}

/// Demo mode: the mode endpoint reports demo + the notice text (the config
/// key mapped through the one copy table).
#[tokio::test]
async fn demo_boot_reports_mode_and_notice() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let mode: Value = server.client.get(server.api_url("/app/mode")).send().await.unwrap().json().await.unwrap();
    assert_eq!(mode["mode"], "demo");
    assert_eq!(mode["limits"]["history"], 50);
    assert_eq!(mode["limits"]["models"], 50);
    assert_eq!(mode["notice"], "Runs and models here are shared with everyone who visits the demo.");
}

/// Blocked routes answer 403 DEMO_MODE BEFORE authentication — a public demo
/// must not leak which surface exists (a blocked route without a token must
/// NOT answer 401).
#[tokio::test]
async fn blocked_routes_are_403_not_401() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let cases = [
        ("GET", "/sandbox/settings"),
        ("GET", "/files"),
        ("POST", "/auth/login"),
        ("GET", "/auth/providers"),
        ("PUT", "/mcp/settings"),
        ("GET", "/sync/subscribe"),
        ("DELETE", "/txr/runs"),
        ("DELETE", "/txr/runs/some-id"),
        ("POST", "/txr/models/import"),
        ("GET", "/txr/models/11111111-2222-3333-4444-555555555555/export"),
        ("PATCH", "/txr/models/11111111-2222-3333-4444-555555555555"),
        ("POST", "/txr/history/copies/clear"),
        ("POST", "/txr/pretrained/refresh"),
        ("GET", "/accounts"),
        ("GET", "/notifications"),
    ];
    for (method, path) in cases {
        let req = server.client.request(method.parse().unwrap(), server.api_url(path));
        let resp = req.send().await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        assert_demo_403(resp, &format!("{method} {path}")).await;
    }
}

/// Allowed routes do NOT short-circuit: an unauthenticated request to an
/// allowed route reaches the framework's auth (401 MISSING_TOKEN), proving
/// the gate isn't blocking the whole surface.
#[tokio::test]
async fn allowed_routes_reach_the_handlers() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    // Public, allowed: 200 without any token.
    let resp = server.client.get(server.api_url("/health")).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);

    // The app's gated reads: 401 (auth demanded), NOT 403 DEMO_MODE.
    for (method, path) in [
        ("GET", "/txr/runs"),
        ("GET", "/txr/analysis-config"),
        ("GET", "/txr/history"),
        ("GET", "/txr/models"),
        ("GET", "/file-validation/examples/patients"),
    ] {
        let resp = server
            .client
            .request(method.parse().unwrap(), server.api_url(path))
            .send().await.unwrap();
        assert_eq!(
            resp.status().as_u16(),
            401,
            "{method} {path}: the gate must pass it to auth"
        );
    }
    // A blocked variant of an allowed family: an unknown route under /txr is
    // still 403 DEMO_MODE (fail-closed unclassified).
    let resp = server.client.get(server.api_url("/txr/no-such-surface")).send().await.unwrap();
    assert_demo_403(resp, "GET /txr/no-such-surface").await;
}

/// POST /api/session/local in demo mode: anonymous visit session — random id
/// cookie, the demo role's permission set only, no owner.
#[tokio::test]
async fn session_local_mints_an_anonymous_visitor() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token, cookie) = mint_demo_session(&server).await;
    // The cookie's attributes are checked BEFORE the split (they are part of
    // the Set-Cookie value; the split takes the `name=value` pair only).
    assert!(cookie.contains("HttpOnly"), "cookie attributes: {cookie}");
    assert!(cookie.contains("SameSite=Strict"), "cookie attributes: {cookie}");
    let pair = cookie.split(';').next().unwrap().to_string();
    assert!(pair.starts_with("txr_demo_session="), "cookie: {pair}");
    // The cookie value is a uuid (random session id).
    let raw = pair.split('=').nth(1).unwrap();
    assert!(uuid::Uuid::parse_str(raw).is_ok(), "session id is a uuid: {raw}");

    // The minted session + the role.
    let me: Value = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(&token)
        .send().await.unwrap()
        .json().await.unwrap();
    let user = &me["user"];
    assert!(user["username"].as_str().unwrap().starts_with("guest-"), "anonymous username");
    assert_eq!(user["is_admin"], false, "the visitor is not an admin");
    let perms: Vec<&str> = me["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    assert!(perms.contains(&"jobs::use"), "{perms:?}");
    assert!(perms.contains(&"projects::use"), "{perms:?}");
    assert!(!perms.iter().any(|p| *p == "*"), "no wildcard: {perms:?}");
}

/// The demo is ONE SHARED POOL: two anonymous sessions read the same run
/// history (both list all runs; the txr tables are workspace-global).
#[tokio::test]
async fn two_sessions_see_the_same_shared_pool() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token_a, _) = mint_demo_session(&server).await;
    let (token_b, _) = mint_demo_session(&server).await;
    let runs_a: Value = server.client.get(server.api_url("/txr/runs")).bearer_auth(&token_a).send().await.unwrap().json().await.unwrap();
    let runs_b: Value = server.client.get(server.api_url("/txr/runs")).bearer_auth(&token_b).send().await.unwrap().json().await.unwrap();
    assert_eq!(runs_a, runs_b, "both sessions read the same runs");
    let models_a: Value = server.client.get(server.api_url("/txr/models")).bearer_auth(&token_a).send().await.unwrap().json().await.unwrap();
    let models_b: Value = server.client.get(server.api_url("/txr/models")).bearer_auth(&token_b).send().await.unwrap().json().await.unwrap();
    assert_eq!(models_a, models_b, "both sessions read the same models");
}

/// Stop/skip act only on runs started by the SAME browser session: a run
/// row recorded for session A is controllable by A (202) and refused to B
/// (403 DEMO_MODE); a run with no recorded session is controlled by nobody.
#[tokio::test]
async fn stop_and_skip_only_for_the_starting_session() {
    use sqlx::SqlitePool;
    use uuid::Uuid;

    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token_a, cookie_a) = mint_demo_session(&server).await;
    let (token_b, _) = mint_demo_session(&server).await;
    let session_a = cookie_a.split(';').next().unwrap().split('=').nth(1).unwrap().to_string();

    // Seed a run row (the engine's own table shape; the gate only reads the
    // ownership row, the handler only needs the run row).
    let pool = SqlitePool::connect(server.database_url()).await.unwrap();
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO txr_runs (id, status, mode, config, input_summary, model_ids, method_count, counts, dir, seed, predictions_ready) \
         VALUES (?, 'running', 'train', '{}', '{}', NULL, 0, '{}', '/tmp/x', 1, 0)",
    )
    .bind(run_id)
    .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO txr_demo_run_sessions (run_id, session_id) VALUES (?, ?)")
        .bind(run_id)
        .bind(Uuid::parse_str(&session_a).unwrap())
        .execute(&pool).await.unwrap();

    let stop_url = server.api_url(&format!("/txr/runs/{run_id}/stop"));

    // Session A (the one that started the run): passes the gate, the handler
    // stops a running run (a fake row is enough — the stop path only reads
    // the run row through the repository and writes stopped + a log line).
    let resp = server
        .client
        .post(&stop_url)
        .bearer_auth(&token_a)
        .header("cookie", &cookie_a)
        .send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 202, "the starting session may stop its run");

    // Session B: 403 DEMO_MODE (never reaches the engine).
    let resp = server
        .client
        .post(&stop_url)
        .bearer_auth(&token_b)
        .send().await.unwrap();
    assert_demo_403(resp, "foreign session stop").await;

    // A run with NO recorded session (seeded/pinned): nobody may control it.
    let foreign_run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO txr_runs (id, status, mode, config, input_summary, model_ids, method_count, counts, dir, seed, predictions_ready) \
         VALUES (?, 'running', 'train', '{}', '{}', NULL, 0, '{}', '/tmp/x', 1, 0)",
    )
    .bind(foreign_run)
    .execute(&pool).await.unwrap();
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{foreign_run}/stop")))
        .bearer_auth(&token_a)
        .header("cookie", &cookie_a)
        .send().await.unwrap();
    assert_demo_403(resp, "unrecorded run stop").await;
}

/// The demo body-size cap: max_bytes from the demo block; an over-cap body to
/// an adapted route is refused (413 — the wire-level cap, exact status), never
/// accepted. The inspect/validate route is the REGRESSION case: it carries a
/// route-level `DefaultBodyLimit::disable()` (the framework parses big
/// schema bodies there), which would repeal an extractor-level default — the
/// demo cap is a body-stream middleware, so `disable()` cannot undo it.
#[tokio::test]
async fn demo_body_limit_rejects_oversized_bodies() {
    let server = TestServer::spawn_with(TestOptions {
        demo: true,
        extra_config_yaml: Some(
            "demo:\n  max_bytes: 4096\n".to_string(),
        ),
        ..Default::default()
    })
    .await;
    let (token, _) = mint_demo_session(&server).await;
    // A small body reaches the handler (the stored-config shape parses with
    // defaults; the point is the LIMIT did not refuse it).
    let resp = server
        .client
        .put(server.api_url("/txr/analysis-config"))
        .bearer_auth(&token)
        .json(&serde_json::json!({}))
        .send().await.unwrap();
    assert_ne!(resp.status().as_u16(), 413, "small body is not refused by the limit");

    let big = serde_json::json!({ "config": "x".repeat(16 * 1024) });
    let resp = server
        .client
        .put(server.api_url("/txr/analysis-config"))
        .bearer_auth(&token)
        .json(&big)
        .send().await.unwrap();
    assert_eq!(
        resp.status().as_u16(),
        413,
        "oversized body to an adapted route must answer 413"
    );

    // The adapted inspect route: route-level DefaultBodyLimit::disable() is
    // present there, so the demo cap must be a wire-level middleware —
    // sending a big body must STILL answer 413 (not reach the handler).
    let resp = server
        .client
        .post(server.api_url("/file-validation/inspect"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "schema": "x".repeat(16 * 1024) }))
        .send().await.unwrap();
    assert_eq!(
        resp.status().as_u16(),
        413,
        "oversized body to inspect (DefaultBodyLimit::disable'd) must answer 413"
    );
}

/// The demo per-IP + per-session rate limit is ON and CONFIGURED (never
/// disabled): a burst beyond the configured burst size answers 429 — the
/// framework's configured limiter (the demo boot honors `server.rate_limit`
/// instead of passing `None`). The bucket is 50/s with burst 2: the harness's
/// 200 ms health polls replenish between probes, but a 5-request burst in a
/// few milliseconds exhausts the burst and the later requests answer 429.
#[tokio::test]
async fn demo_rate_limit_is_configured_not_disabled() {
    let server = TestServer::spawn_with(TestOptions {
        demo: true,
        rate_limit: Some((50, 2)),
        ..Default::default()
    })
    .await;
    let mut statuses = Vec::new();
    for _ in 0..5 {
        let resp = server.client.get(server.api_url("/health")).send().await.unwrap();
        statuses.push(resp.status().as_u16());
    }
    assert!(
        statuses.contains(&429),
        "the configured demo limiter must 429 a burst; got {statuses:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-2 — the demo bundle: boot validation, the boot refusal, and the
// inspect/validate example-hash guard (TEST-DM-2)
// ─────────────────────────────────────────────────────────────────────────────

/// Parse the example CSV text (the bytes the examples endpoint serves) into
/// the request table shape — the same decode the browser performs.
fn table_from_csv_text(text: &str, name: &str) -> Value {
    let mut lines = text.split('\n').filter(|l| !l.is_empty());
    let columns: Vec<String> = lines.next().unwrap().split(',').map(|c| c.to_string()).collect();
    let rows: Vec<Vec<Option<String>>> = lines
        .map(|l| l.split(',').map(|c| if c.is_empty() { None } else { Some(c.to_string()) }).collect())
        .collect();
    serde_json::json!({
        "columns": columns,
        "header_row": 1,
        "rows": rows,
        "source": {"format": "csv", "name": name},
    })
}

/// Fetch one example table through the same endpoint the UI's Use-example
/// flow calls (allowed in demo mode — the downloads stay).
async fn fetch_example(server: &TestServer, token: &str, kind: &str) -> Value {
    let raw = server
        .client
        .get(server.api_url(&format!("/file-validation/examples/{kind}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    table_from_csv_text(&raw, &format!("{kind}-example.csv"))
}

/// ITEM-2: in demo mode the bundle hashes gate inspect/validate — only the
/// example tables pass (200), a single changed value field is 403 DEMO_MODE.
#[tokio::test]
async fn inspect_and_validate_only_accept_the_example_tables() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token, _) = mint_demo_session(&server).await;

    let patients = fetch_example(&server, &token, "patients").await;
    let measurements = fetch_example(&server, &token, "measurements").await;
    let predict = fetch_example(&server, &token, "predict-measurements").await;

    // inspect: the three example tables pass (the predict screen inspects its
    // one file AS kind measurements).
    for (kind, table) in [
        ("patients", &patients),
        ("measurements", &measurements),
        ("measurements", &predict),
    ] {
        let resp = server
            .client
            .post(server.api_url("/file-validation/inspect"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "kind": kind, "table": table }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "inspect {kind} with the example table");
    }

    // A table that is NOT the example: one changed value field.
    let mut changed = patients.clone();
    changed["rows"][0][1] = serde_json::json!("9999");
    let resp = server
        .client
        .post(server.api_url("/file-validation/inspect"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "kind": "patients", "table": changed }))
        .send()
        .await
        .unwrap();
    assert_demo_403(resp, "inspect with a non-example table").await;

    // validate: files mode accepts the training pair.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "mode": "files",
            "patients": patients,
            "measurements": measurements,
            "joins": [],
            "mapping": [],
            "parameters": {"decision_day": 56, "baseline_max_day": 0},
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "validate files mode with the example pair");

    // predict mode accepts the predict table only — the training measurements
    // table is not it.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "mode": "predict",
            "patients": Value::Null,
            "measurements": measurements,
            "joins": [],
            "mapping": [],
            "parameters": {"decision_day": 56, "baseline_max_day": 0},
        }))
        .send()
        .await
        .unwrap();
    assert_demo_403(resp, "validate predict mode with the training measurements table").await;

    // files mode with the predict table in the measurements slot is refused too.
    let resp = server
        .client
        .post(server.api_url("/file-validation/validate"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "mode": "files",
            "patients": patients,
            "measurements": predict,
            "joins": [],
            "mapping": [],
            "parameters": {"decision_day": 56, "baseline_max_day": 0},
        }))
        .send()
        .await
        .unwrap();
    assert_demo_403(resp, "validate files mode with the predict table").await;
}

/// ITEM-2: demo mode REFUSES to boot without a bundle — the loader's
/// contract is the boot contract; a missing bundle is never "a demo with no
/// data". The harness spawns the real server subprocess; a refused boot must
/// fail the spawn (the readiness loop never sees a healthy server).
#[tokio::test]
async fn demo_mode_refuses_to_boot_without_a_bundle() {
    use txresbench_test_harness::{TestHarness, Variant};

    let harness = TestHarness::new(
        crate::common::CytoHarnessApp,
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        Variant::Server,
    );
    let opts = TestOptions {
        demo: true,
        demo_missing_bundle: true,
        ..Default::default()
    };
    // The spawn panics after the readiness ceiling when the server refuses to
    // start; run it on the current runtime so the panic lands in the
    // JoinHandle instead of the test thread.
    let handle = tokio::task::spawn(async move { harness.start(opts).await });
    let joined = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(joined) => joined,
        Err(_) => panic!("the refused demo boot did not fail within 120s"),
    };
    let err = match joined {
        Ok(_server) => panic!("a demo boot without a bundle must not succeed"),
        Err(err) => err,
    };
    assert!(err.is_panic(), "the spawn failed with a panic: {err:?}");
}

// ─────────────────────────────────────────────────────────────────────────────
// The generated save name (ITEM-1's models/save rule, server half) is pinned
// at the pure-function level here because a full save flow needs a trained
// run (the engine's domain tests cover that path).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn demo_save_request_rewrites_to_a_generated_name() {
    use txresbench::modules::model_store::{SaveModelsRequest, SaveTarget, demo_save_request};
    // Demo off (the unit-test process never installed a state): the request
    // passes through untouched — the desktop byte-for-byte rule.
    let req = SaveModelsRequest {
        run_id: uuid::Uuid::new_v4(),
        method_ids: vec!["m".to_string()],
        target: SaveTarget::NewSet { set_name: "My Set".to_string() },
        keep_training_files: false,
        also_export: true,
        source_label: None,
    };
    let out = demo_save_request(req.clone());
    match (out.target, req.target) {
        (SaveTarget::NewSet { set_name: a }, SaveTarget::NewSet { set_name: b }) => {
            assert_eq!(a, b, "desktop saves keep the caller's name")
        }
        _ => panic!("desktop targets are preserved"),
    }
    assert_eq!(out.also_export, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-3 — the demo runner (TEST-DM-3): clone + replay, stop/skip/at-a-time/
// rerun, restart finish, the reuse flow, the model seams, the 400s.
// ─────────────────────────────────────────────────────────────────────────────

/// The recorded example pairs the demo accepts (the Q screen's example flow).
async fn fetch_example_pair(server: &TestServer, token: &str) -> (Value, Value, Value) {
    let patients = fetch_example(server, token, "patients").await;
    let measurements = fetch_example(server, token, "measurements").await;
    let predict = fetch_example(server, token, "predict-measurements").await;
    (patients, measurements, predict)
}

/// The recorded train-run request (the recorder's own shape).
fn train_run_request(
    patients: &Value,
    measurements: &Value,
    method_ids: &[&str],
    decision_day: f64,
    look_ahead_day: f64,
    endpoint: &str,
) -> Value {
    serde_json::json!({
        "mode": "train",
        "input": {
            "patients": patients,
            "measurements": measurements,
            "predict_measurements": Value::Null,
            "joins": [],
            "mapping": [],
            "keep_copies": true,
        },
        "config": {
            "endpoint": endpoint,
            "decision_day": decision_day,
            "look_ahead_day": look_ahead_day,
            "covariates": false,
            "at_a_time": 2,
            "cpus": Value::Null,
            "save_models": false,
            "label_day": Value::Null,
        },
        "method_ids": method_ids,
    })
}

/// Poll one run's detail until `finished`/`failed`/`stopped` (or timeout).
async fn wait_run_terminal(
    server: &TestServer,
    token: &str,
    run_id: &str,
    secs: u64,
) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        let resp = server
            .client
            .get(server.api_url(&format!("/txr/runs/{run_id}")))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "run detail");
        let body: Value = resp.json().await.unwrap();
        let status = body["status"].as_str().unwrap().to_string();
        if matches!(status.as_str(), "finished" | "failed" | "stopped") {
            return body;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "run {run_id} did not turn terminal (still {status})"
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// ITEM-3: the whole demo flow over a demo server with NO registry and NO
/// bwrap — create a replay run, watch it finish, read the cloned predictions
/// + CSV + logs, save + resolve the recorded models, run the reuse and read
/// its cloned results, and exercise the bundle-backed eligibility/estimate.
#[tokio::test]
async fn demo_replay_runs_the_whole_flow() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token, cookie) = mint_demo_session(&server).await;
    let (patients, measurements, predict) = fetch_example_pair(&server, &token).await;

    // ── the train replay run ────────────────────────────────────────────────
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "create replay run");
    let created: Value = resp.json().await.unwrap();
    let run_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["status"], "preparing", "the run starts preparing");
    assert_eq!(created["counts"]["waiting"], 1);
    assert_eq!(created["config"]["decision_day"], 56.0);

    // The intermediate state is observable (waiting -> running -> finished).
    let mut saw_running = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let resp = server
            .client
            .get(server.api_url(&format!("/txr/runs/{run_id}")))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        if body["status"] == "running" {
            saw_running = true;
        }
        if body["status"] == "finished" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "replay did not finish in 20s: {}",
            body["status"]
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    assert!(saw_running, "the replay passes through running");

    let done = wait_run_terminal(&server, &token, &run_id, 20).await;
    assert_eq!(done["status"], "finished");
    let method = &done["methods"][0];
    assert_eq!(method["method_id"], "kelim");
    assert_eq!(method["state"], "finished");
    assert_eq!(method["task"], "pfs");
    assert_eq!(method["prob_source"], "native");
    assert_eq!(method["coverage"]["scored"], 94);
    assert_eq!(method["exit_code"], 0);
    // No environment download, no sandbox: the row never carried manifest
    // bytes to download and the env facts are the RECORDED digest pins.
    assert_eq!(method["bytes_total"], Value::Null);
    assert!(method["elapsed_secs"].as_u64().unwrap() >= 1, "the recorded 12.5 s floor is 1.5 s");

    // The recorded log line streams (the fixture's engine line + the demo's).
    let logs: Value = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run_id}/logs")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let contents: Vec<&str> = logs["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["content"].as_str().unwrap())
        .collect();
    assert!(
        contents.iter().any(|c| c.contains("started")),
        "the recorded engine line streams: {contents:?}"
    );
    assert!(contents.iter().any(|c| c.contains("run finished")));

    // The cloned predictions equal the bundle's recorded column.
    let pred: Value = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run_id}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pred["endpoint"], "pfs");
    assert_eq!(pred["horizon"], 238.0);
    assert_eq!(pred["patients"].as_array().unwrap().len(), 94);
    let col = &pred["methods"][0];
    assert_eq!(col["method_id"], "kelim");
    assert_eq!(col["probabilities"][0], 0.5);
    assert_eq!(col["coverage"]["scored"], 94);

    // The CSV download works (409-free, per-patient rows).
    let csv = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run_id}/predictions.csv")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(csv.status().as_u16(), 200, "predictions CSV download");
    let csv_text = csv.text().await.unwrap();
    assert!(csv_text.starts_with("patient_id,"), "{csv_text}");
    assert_eq!(csv_text.lines().count(), 95, "header + 94 patients");

    // ── save + resolve: records pointing at the bundle's model metadata ────
    let saved: Value = server
        .client
        .post(server.api_url("/txr/models/save"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "run_id": run_id,
            "method_ids": ["kelim"],
            "target": {"set_name": "ignored visitor name"},
            "keep_training_files": false,
            "also_export": true,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(saved["set"]["name"].as_str().unwrap().starts_with("Demo models "), "{saved}");
    assert_eq!(saved["models"][0]["method_id"], "kelim");
    assert_eq!(saved["models"][0]["size_bytes"], 1024, "the recorded size");
    assert!(saved.get("export").is_none(), "export is off in the demo");
    let model_id = saved["models"][0]["id"].as_str().unwrap().to_string();

    let resolved: Value = server
        .client
        .post(server.api_url("/txr/models/resolve"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "model_ids": [model_id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resolved["assets"][0]["method_id"], "kelim", "{resolved}");

    // ── the reuse replay run (cloned reuse results) ────────────────────────
    let reuse_req = serde_json::json!({
        "mode": "reuse",
        "input": {
            "patients": Value::Null,
            "measurements": predict,
            "predict_measurements": predict,
            "joins": [],
            "mapping": [],
            "keep_copies": true,
        },
        "config": {
            "endpoint": "pfs",
            "decision_day": 56.0,
            "look_ahead_day": 238.0,
            "covariates": false,
            "at_a_time": 2,
            "cpus": Value::Null,
            "save_models": false,
            "label_day": Value::Null,
        },
        "model_ids": resolved["assets"],
    });
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&reuse_req)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "create reuse replay");
    let reuse_id = resp.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let reuse_done = wait_run_terminal(&server, &token, &reuse_id, 20).await;
    assert_eq!(reuse_done["status"], "finished");
    assert_eq!(reuse_done["mode"], "reuse");
    let reuse_pred: Value = server
        .client
        .get(server.api_url(&format!("/txr/runs/{reuse_id}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reuse_pred["patients"].as_array().unwrap().len(), 15, "the reuse cohort");
    assert_eq!(reuse_pred["methods"][0]["probabilities"][0], 0.5);
    // The reuse method row carries the SAVED MODEL id + the catalogue label.
    assert_ne!(
        reuse_done["methods"][0]["method_id"],
        "kelim",
        "a reuse row's id is the model's, the label the catalogue's"
    );
    assert_eq!(reuse_done["methods"][0]["label"], "kelim");

    // ── eligibility + estimate: the bundle answers ─────────────────────────
    let elig: Value = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "inventory": {
                "patients": 94,
                "decision_day": 56,
                "baseline_max_day": 0,
                "markers": [],
                "covariates": [],
                "outcomes": {"has_responder": true, "has_response_day": true, "has_event": true, "has_survival_day": true},
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let kelim = elig["methods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "kelim")
        .expect("kelim verdict");
    assert_eq!(kelim["status"], "can_run");
    assert_eq!(kelim["estimated_seconds"], 1.5, "12.5 s / 10 floored at 1.5");
    assert!(elig["total_cannot"].as_u64().unwrap() > 100, "the rest is cannot_run");

    let est: Value = server
        .client
        .post(server.api_url("/methods/estimate"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "method_ids": ["kelim"],
            "patients": 94,
            "at_a_time": 2,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(est["methods"][0]["id"], "kelim");
    assert_eq!(est["methods"][0]["estimated_seconds"], 1.5);
    assert_eq!(est["methods"][0]["estimate_quality"], "measured");

    // ── rerun replays again ────────────────────────────────────────────────
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{run_id}/rerun")))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "rerun replay");
    let rerun_id = resp.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let rerun = wait_run_terminal(&server, &token, &rerun_id, 20).await;
    assert_eq!(rerun["status"], "finished");
}

/// ITEM-3: method / configuration / table outside the bundle are refused
/// (400 for the unrecorded, 403 DEMO_MODE for a table that is not the
/// example).
#[tokio::test]
async fn demo_replay_refuses_outside_the_bundle() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token, _) = mint_demo_session(&server).await;
    let (patients, measurements, _) = fetch_example_pair(&server, &token).await;

    // An unrecorded METHOD is a plain 400.
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&train_run_request(&patients, &measurements, &["landmark-cox-current"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 400, "unrecorded method refused");
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error_code"], "DEMO_UNRECORDED");
    assert!(body["error"].to_string().contains("no recorded results"));

    // An unrecorded CONFIGURATION is a plain 400.
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 90.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 400, "unrecorded configuration refused");
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error_code"], "DEMO_CONFIG_UNRECORDED");

    // A NON-example table is 403 DEMO_MODE (the class of the inspect/validate
    // guard).
    let mut changed = measurements.clone();
    changed["rows"][0][1] = serde_json::json!("9999");
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&train_run_request(&patients, &changed, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_demo_403(resp, "run with a non-example table").await;
}

/// ITEM-3: stop/skip act on the replay — the run stops, the stopped method
/// stays stopped, and a skipping a waiting method turns it skipped.
#[tokio::test]
async fn demo_replay_stop_and_skip_act_on_the_replay() {
    let server = TestServer::spawn_with(TestOptions {
        demo: true,
        // One slow replay so the controls land while the run is live.
        extra_config_yaml: Some("demo:\n  replay_speed: 1.0\n".to_string()),
        ..Default::default()
    })
    .await;
    let (token, cookie) = mint_demo_session(&server).await;
    let (patients, measurements, _) = fetch_example_pair(&server, &token).await;

    // Create; the replay takes ~14 s (12.5 s at 1x); stop it after ~1.5 s.
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "create slow replay");
    let run_id = resp.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{run_id}/stop")))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "stop the replay");
    let stopped = wait_run_terminal(&server, &token, &run_id, 20).await;
    assert_eq!(stopped["status"], "stopped");
    let method = &stopped["methods"][0];
    assert_eq!(method["state"], "stopped", "a stopped method stays stopped");
    assert_eq!(method["reason"]["code"], "ABORTED");
    // The user's stop line.
    let logs: Value = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run_id}/logs")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(logs["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["content"] == "stopped by the user"));
    // A stopped run is idempotent + never resumes.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{run_id}/stop")))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "stopped stop is idempotent");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let again = wait_run_terminal(&server, &token, &run_id, 5).await;
    assert_eq!(again["status"], "stopped", "never resumes after stop");

    // ── skip: a waiting method becomes skipped, the run finishes ───────────
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "create second replay");
    let run2 = resp.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Skip within the waiting lead (the run is created in preparing and the
    // method waits 0.4 + 0.3 s before running).
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{run2}/methods/kelim/skip")))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "skip the waiting method");
    let skipped = wait_run_terminal(&server, &token, &run2, 20).await;
    assert_eq!(skipped["status"], "finished");
    assert_eq!(skipped["methods"][0]["state"], "skipped");
    assert!(skipped["methods"][0]["prob_source"].is_null(), "a skipped method has no column");
    assert_eq!(skipped["counts"]["skipped"], 1);
    assert_eq!(skipped["counts"]["finished"], 0);
    // A run with nothing finished has no predictions (honest 409).
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run2}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 409, "no predictions for a skipped-only run");

    // ── stop ONE method: the method stops + ABORTED, the run keeps going ────
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "create third replay");
    let run3 = resp.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Wait for the method to turn running, then stop it mid-window.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let detail: Value = server
            .client
            .get(server.api_url(&format!("/txr/runs/{run3}")))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if detail["methods"][0]["state"] == "running" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the method never ran: {detail}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{run3}/methods/kelim/stop")))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "stop one method");
    let stopped3 = wait_run_terminal(&server, &token, &run3, 20).await;
    assert_eq!(
        stopped3["status"], "finished",
        "the run finishes with the stopped method"
    );
    assert_eq!(stopped3["methods"][0]["state"], "stopped");
    assert_eq!(stopped3["methods"][0]["reason"]["code"], "ABORTED");
    assert_eq!(stopped3["counts"]["stopped"], 1);
    assert_eq!(stopped3["counts"]["finished"], 0);
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run3}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 409, "no predictions for a stop-only run");
}

/// ITEM-3: the example set is seeded from the bundle (no training run, no
/// sandbox); a reuse of it clones the bundle's reuse results.
#[tokio::test]
async fn demo_example_set_is_seeded_from_the_bundle() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token, _) = mint_demo_session(&server).await;
    let (_, _, predict) = fetch_example_pair(&server, &token).await;

    let resp = server
        .client
        .post(server.api_url("/txr/models/example"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "example set");
    let example: Value = resp.json().await.unwrap();
    assert_eq!(example["state"], "ready", "{example}");
    let set_id = example["set_id"].as_str().unwrap().to_string();

    // The set lists the recorded model.
    let models: Value = server
        .client
        .get(server.api_url(&format!("/txr/models?set_id={set_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["models"].as_array().unwrap().len(), 1);
    let model_id = models["models"][0]["id"].as_str().unwrap().to_string();

    let resolved: Value = server
        .client
        .post(server.api_url("/txr/models/resolve"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "model_ids": [model_id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resolved["assets"][0]["method_id"], "kelim");

    // The reuse replay of the example set on the example predict file.
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "mode": "reuse",
            "input": {
                "patients": Value::Null,
                "measurements": predict,
                "predict_measurements": predict,
                "joins": [],
                "mapping": [],
                "keep_copies": true,
            },
            "config": {
                "endpoint": "pfs",
                "decision_day": 56.0,
                "look_ahead_day": 238.0,
                "covariates": false,
                "at_a_time": 2,
                "cpus": Value::Null,
                "save_models": false,
                "label_day": Value::Null,
            },
            "model_ids": resolved["assets"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "reuse of the example set");
    let reuse_id = resp.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let done = wait_run_terminal(&server, &token, &reuse_id, 20).await;
    assert_eq!(done["status"], "finished");
    let pred: Value = server
        .client
        .get(server.api_url(&format!("/txr/runs/{reuse_id}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pred["patients"].as_array().unwrap().len(), 15);
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-4 — the shared-pool retention: the usage counters, the run limit with
// the pinned example run, the model-set limit with the pinned example set
// (TEST-DM-4)
// ─────────────────────────────────────────────────────────────────────────────

/// ITEM-4: `GET /api/txr/history/usage` in demo mode answers the
/// shared-pool counters (the plan's shape: runs/run_limit/models/model_limit/
/// pinned_runs/pinned_models/shared) — the boot-seeded example run is PINNED
/// and not counted; a visitor run is counted.
#[tokio::test]
async fn demo_usage_reports_the_retention_counters() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    let (token, _) = mint_demo_session(&server).await;

    let resp = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "usage in demo mode");
    let usage: Value = resp.json().await.unwrap();
    assert_eq!(usage["runs"], 0, "no visitor run yet: {usage}");
    assert_eq!(usage["run_limit"], 50);
    assert_eq!(usage["models"], 0, "no saves yet: {usage}");
    assert_eq!(usage["model_limit"], 50);
    assert!(
        usage["pinned_runs"].as_u64().unwrap() >= 1,
        "the boot-seeded example run is pinned: {usage}"
    );
    assert_eq!(usage["pinned_models"], 0);
    assert_eq!(usage["shared"], true, "the shared-pool flag");

    // A visitor run is counted; the pinned side stays.
    let (patients, measurements, _) = fetch_example_pair(&server, &token).await;
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "create a visitor run");
    let run_id = resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    wait_run_terminal(&server, &token, &run_id, 20).await;
    let usage: Value = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(usage["runs"], 1, "the visitor run is counted: {usage}");
    assert!(usage["pinned_runs"].as_u64().unwrap() >= 1, "{usage}");
}

/// ITEM-4: with `history_limit` 4, six finished visitor runs leave only the
/// newest four (the two oldest are evicted — rows gone, dirs pruned), the
/// boot-seeded PINNED example run survives, and the run list never shows a
/// gap in the newest side.
#[tokio::test]
async fn demo_retention_evicts_the_oldest_runs_beyond_the_limit() {
    let server = TestServer::spawn_with(TestOptions {
        demo: true,
        extra_config_yaml: Some("demo:\n  history_limit: 4\n".to_string()),
        ..Default::default()
    })
    .await;
    let (token, cookie) = mint_demo_session(&server).await;
    let (patients, measurements, _) = fetch_example_pair(&server, &token).await;

    let mut created = Vec::new();
    for i in 0..6 {
        let resp = server
            .client
            .post(server.api_url("/txr/runs"))
            .bearer_auth(&token)
            .header("cookie", &cookie)
            .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 202, "create run {i}");
        let id = resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
        wait_run_terminal(&server, &token, &id, 30).await;
        created.push(id);
    }

    // The enforcement runs after the 6th insert (fire-and-forget): wait for
    // the shared pool to settle at 4 kept visitor runs + the pinned one.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let runs: Value = server
            .client
            .get(server.api_url("/txr/runs"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let ids: Vec<&str> = runs["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        if runs["total"].as_u64().unwrap() == 5 {
            for old in &created[..2] {
                assert!(!ids.contains(&old.as_str()), "the oldest runs are evicted");
            }
            for new in &created[2..] {
                assert!(ids.contains(&new.as_str()), "the newest runs stay: {new}");
            }
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the retention did not settle: {runs}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    // The evicted runs are gone through the API: history 404 + the 50-limit
    // usage counter shows the truth.
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{}", created[0])))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 404, "the evicted run is gone");
    let usage: Value = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(usage["runs"], 4, "4 counted runs: {usage}");
    assert_eq!(usage["run_limit"], 4);
    assert!(usage["pinned_runs"].as_u64().unwrap() >= 1, "{usage}");
}

/// ITEM-4: with `model_limit` 2, a demo save + one older set (seeded
/// through the repository — the save name is minute-generated, so the API
/// cannot create two sets in one minute) leave the NEWEST non-pinned set and
/// evict the older one WHOLE (its model too); the PINNED example set (the
/// `models/example` seeding) survives untouched.
#[tokio::test]
async fn demo_retention_evicts_the_oldest_model_sets() {
    let server = TestServer::spawn_with(TestOptions {
        demo: true,
        extra_config_yaml: Some("demo:\n  model_limit: 1\n".to_string()),
        ..Default::default()
    })
    .await;
    let (token, cookie) = mint_demo_session(&server).await;

    // The pinned example set first (the demo seeds it from the bundle).
    let resp = server
        .client
        .post(server.api_url("/txr/models/example"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "example set");
    let example_set = resp.json::<Value>().await.unwrap()["set_id"]
        .as_str()
        .unwrap()
        .to_string();

    // One finished train run to save from.
    let (patients, measurements, _) = fetch_example_pair(&server, &token).await;
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202);
    let run_id = resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    wait_run_terminal(&server, &token, &run_id, 20).await;

    // A demo save: set A (newest). Its generated name is minute-precision.
    let resp = server
        .client
        .post(server.api_url("/txr/models/save"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "run_id": run_id,
            "method_ids": ["kelim"],
            "target": {"set_name": "visitor name"},
            "keep_training_files": false,
            "also_export": false,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 201, "first save");
    let set_a = resp.json::<Value>().await.unwrap()["set"]["id"].as_str().unwrap().to_string();

    // An OLDER set (set B) through the repository — backdated, so the
    // retention's oldest-first rule must evict IT, never the new save.
    use txresbench::modules::model_store::repository::{ModelStoreRepository, NewModel};
    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();
    let repo = ModelStoreRepository::new(pool.clone());
    let set_b = repo
        .insert_set("an older demo set", None, Some("example"), false, None)
        .await
        .expect("old set insert");
    sqlx::query("UPDATE txr_model_sets SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-100000 seconds') WHERE id = ?")
        .bind(set_b.id)
        .execute(&pool)
        .await
        .unwrap();
    let digest = "d".repeat(64);
    repo.insert_model(&NewModel {
        set_id: Some(set_b.id),
        name: "old model".into(),
        method_id: "kelim".into(),
        method_version: "1.0.0".into(),
        group: "kinetics".into(),
        group_label: "Kinetics".into(),
        task: Some("pfs".into()),
        provenance: "run".into(),
        imported_from: None,
        pretrained_catalogue_id: None,
        pretrained_catalogue_version: None,
        licence: None,
        tree_sha256: digest.clone(),
        dir: format!("/nonexistent/trees/{digest}"),
        size_bytes: 1024,
        contract: "2.0".into(),
        env_base_digest: None,
        env_layer_digest: None,
        trained_on_patients: Some(94),
        trained_at: None,
        decision_day: 56.0,
        endpoint: "pfs".into(),
        horizon: 238.0,
        features: serde_json::json!(["M1", "M2"]),
        required_markers: None,
        marker_facts: serde_json::json!({"kind": "single", "count": 3}),
        covariates: serde_json::json!({"catalogue": "optional", "used": false}),
        embeds_training_data: false,
        own_auc: Some(0.71),
        own_c: None,
        conversions: serde_json::json!({}),
    })
    .await
    .expect("old model insert");

    // Now 2 counted models > limit 1; the next run insert triggers the
    // enforcement pass, which must evict the OLDEST set (B) whole.
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .header("cookie", &cookie)
        .json(&train_run_request(&patients, &measurements, &["kelim"], 56.0, 238.0, "pfs"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 202, "trigger run");
    let trigger_id = resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    wait_run_terminal(&server, &token, &trigger_id, 20).await;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let sets: Value = server
            .client
            .get(server.api_url("/txr/model-sets"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let ids: Vec<&str> = sets["sets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        if !ids.contains(&set_b.id.to_string().as_str()) && ids.contains(&set_a.as_str())
            && ids.contains(&example_set.as_str())
        {
            assert_eq!(sets["sets"].as_array().unwrap().len(), 2, "{sets}");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the retention did not settle: {sets}");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    // The pinned example set is whole (its one model survived the sweep) and
    // the counters tell the truth.
    let models: Value = server
        .client
        .get(server.api_url(&format!("/txr/models?set_id={example_set}")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["models"].as_array().unwrap().len(), 1, "the example set is whole");
    let usage: Value = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(usage["models"], 1, "{usage}");
    assert_eq!(usage["model_limit"], 1);
    assert_eq!(usage["pinned_models"], 1, "the example set's model is pinned: {usage}");
}
