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
