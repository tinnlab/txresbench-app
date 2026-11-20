//! The local API lock over a REAL spawned server (the headless boot path:
//! `serve_blocking` with `TXR_LOCAL_API_KEY`). The middleware's own decision
//! table is unit-tested in `src/modules/local_api_lock/tests.rs`; these prove
//! the wiring: every request is refused without the key, the session mint
//! writes nothing for an outside caller, outside AI clients still pair, the MCP
//! loopback reaches the locked server, a headless server with no configured key
//! makes and prints its own, and demo mode installs no lock.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::common::{TestOptions, TestServer, TEST_LOCAL_API_KEY};
use crate::mcp::{create_user, login, setup_admin, tools_call};

fn bare() -> reqwest::Client {
    reqwest::Client::new()
}

async fn user_count(server: &TestServer) -> i64 {
    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap();
    pool.close().await;
    n
}

#[tokio::test]
async fn every_request_without_the_key_is_refused_and_the_mint_writes_nothing() {
    let server = TestServer::spawn().await;
    let before = user_count(&server).await;

    for (client, why) in [
        (bare(), "no key"),
        (
            reqwest::Client::builder()
                .default_headers(
                    [("x-txr-local-key".parse().unwrap(), "wrong-key-wrong-key".parse().unwrap())]
                        .into_iter()
                        .collect(),
                )
                .build()
                .unwrap(),
            "wrong key",
        ),
    ] {
        let r = client.post(server.api_url("/session/local")).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 403, "mint, {why}");
        assert!(r.bytes().await.unwrap().is_empty(), "a refusal carries no detail ({why})");
        let r = client.get(server.api_url("/health")).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 403, "health, {why}");
    }
    assert_eq!(user_count(&server).await, before, "a refused mint must not create the owner");

    // The debug worktree sentinel (outside /api) is behind the lock too: nothing
    // is exempt, and it would otherwise tell any caller the worktree path.
    let r = bare().get(server.root_url("/__worktree")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403, "sentinel without the key");
    let r = server.client.get(server.root_url("/__worktree")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "sentinel with the key");

    // The same mint WITH the key returns the owner session.
    let r = server.client.post(server.api_url("/session/local")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let body: Value = r.json().await.unwrap();
    assert!(body["access_token"].as_str().is_some_and(|t| !t.is_empty()));
    assert_eq!(user_count(&server).await, before + 1);
}

#[tokio::test]
async fn an_outside_ai_client_still_pairs_and_calls_mcp_without_the_key() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "pairer", "pairer@x.test").await;
    let pairer = login(&server, "pairer").await;

    // The window (keyed) shows the code.
    let start: Value = server
        .client
        .post(server.api_url("/mcp/pair/start"))
        .bearer_auth(&pairer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = start["code"].as_str().unwrap().to_string();
    // The mcp_url is the real bound address: the base the outside client dials.
    let mcp_url = start["mcp_url"].as_str().unwrap().to_string();
    assert!(mcp_url.ends_with("/api/mcp") && !mcp_url.contains(":0/"), "{mcp_url}");

    // The outside client: no key, no Origin.
    let outside = bare();
    let r = outside
        .post(server.api_url("/mcp/pair/exchange"))
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200, "pair/exchange needs only the one-time code");
    let token = r.json::<Value>().await.unwrap()["access_token"].as_str().unwrap().to_string();

    let rpc = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let ok = outside.post(&mcp_url).bearer_auth(&token).json(&rpc).send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200, "a paired client reaches /api/mcp");

    // No bearer: the route itself refuses (the exemption grants nothing alone).
    let r = outside.post(&mcp_url).json(&rpc).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401, "no bearer is refused by the route");

    // A browser page cannot use the exemption: it always carries an Origin.
    for url in [mcp_url.clone(), server.api_url("/mcp/pair/exchange")] {
        let r = outside
            .post(&url)
            .header("origin", "https://evil.example")
            .bearer_auth(&token)
            .json(&rpc)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 403, "{url} with an Origin");
    }
}

#[tokio::test]
async fn the_mcp_loopback_dispatch_reaches_the_locked_server() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // `App.mode` is a REST-kind capability: the dispatch calls
    // GET /api/app/mode on this very server, which is behind the lock.
    let result = tools_call(
        &server,
        &admin,
        "invoke_capability",
        json!({ "operation_id": "App.mode" }),
    )
    .await;
    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(result["structuredContent"]["status"], 200, "{result}");
    assert_eq!(result["structuredContent"]["ok"], true, "{result}");
    // The REAL dispatch is what reached it: its answer is the app-mode body.
    assert!(result["structuredContent"]["response"]["mode"].is_string(), "{result}");
}

#[tokio::test]
async fn demo_mode_installs_no_lock() {
    let server = TestServer::spawn_with(TestOptions { demo: true, ..Default::default() }).await;
    // The public web demo mints its restricted anonymous session for anyone.
    let r = bare().post(server.api_url("/session/local")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let r = bare().get(server.api_url("/health")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
}

/// A headless server started with NO key configured makes one, prints it once
/// and enforces it; with a key in the environment it prints nothing.
#[test]
fn a_headless_server_without_a_key_makes_and_prints_one() {
    let dir = std::env::temp_dir().join(format!("txr-lock-headless-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let cfg = dir.join("config.yaml");
    std::fs::write(
        &cfg,
        format!(
            "database:\n  path: '{db}'\nserver:\n  host: '127.0.0.1'\n  port: {port}\n  api_prefix: '/api'\n  trust_forwarded_headers: false\njwt:\n  secret: 'test-secret-key-for-jwt-tokens-min-32-chars-long'\n  issuer: 'txresbench'\n  audience: 'txresbench-api'\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
            db = dir.join("t.db").display()
        ),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_txresbench"))
        .arg("--config-file")
        .arg(&cfg)
        .env("TXR_APP_DATA_DIR", dir.join("data"))
        .env_remove("TXR_LOCAL_API_KEY")
        .env_remove("TXR_DEMO")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the server");
    struct Kill(std::process::Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let stdout = child.stdout.take().unwrap();
    let guard = Kill(child);

    // The key arrives on stdout (a thread, so a silent server cannot hang us).
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let mut key = None;
    let mut lines = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && key.is_none() {
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
            if let Some(k) = line.strip_prefix("TxResBench local API key: ") {
                key = Some(k.trim().to_string());
            }
            lines.push(line);
        }
    }
    let key = key.unwrap_or_else(|| panic!("no key line on stdout: {lines:?}"));
    assert_eq!(key.len(), 64, "a fresh 256-bit hex key");

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let url = format!("http://127.0.0.1:{port}/api/health");
        let client = reqwest::Client::new();
        let mut healthy = false;
        for _ in 0..150 {
            if let Ok(r) = client.get(&url).header("x-txr-local-key", &key).send().await {
                if r.status().is_success() {
                    healthy = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(healthy, "the server must answer with the printed key");
        let r = client.get(&url).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 403, "and refuse without it");
        let r = client.post(format!("http://127.0.0.1:{port}/api/session/local")).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 403, "the owner-token mint is not open");
    });
    drop(guard);
    let _ = std::fs::remove_dir_all(&dir);
    assert_ne!(key, TEST_LOCAL_API_KEY);
}

// ───────────────── the guard: no route can skip the lock ─────────────────

/// Every operation in the committed OpenAPI document (the app's documented
/// routes, 132 at the time of writing), plus the plain routes it does not list
/// (the MCP JSON-RPC and SSE routes, the debug sentinel) and a path that does
/// not exist, is called WITHOUT the key against a real booted server. Each must
/// be refused with 403. The only answers that may be anything else are the two
/// outside-AI-client routes ([`txresbench::modules::local_api_lock::BEARER_ONLY_ROUTES`]),
/// and those are checked to refuse an Origin.
///
/// This is what makes "a new route cannot skip the check" a test and not a
/// promise: a route added to the spec is enumerated here with no edit to this
/// file, and one that answers anything but 403 names itself in the failure.
#[tokio::test]
async fn every_route_is_behind_the_lock() {
    use txresbench::modules::local_api_lock::BEARER_ONLY_ROUTES;

    let server = TestServer::spawn().await;
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/openapi/openapi.json"),
        )
        .expect("the committed OpenAPI document"),
    )
    .unwrap();

    let mut routes: Vec<(String, String)> = Vec::new();
    for (path, item) in spec["paths"].as_object().expect("paths") {
        for (method, _) in item.as_object().expect("path item") {
            if matches!(method.as_str(), "get" | "post" | "put" | "patch" | "delete") {
                routes.push((method.to_uppercase(), path.clone()));
            }
        }
    }
    assert!(routes.len() > 100, "the spec enumeration found only {} operations", routes.len());
    // Not in the spec (plain axum routes) and one that is not a route at all.
    for (m, p) in [
        ("POST", "/api/mcp"),
        ("GET", "/api/mcp"),
        ("GET", "/api/mcp/agent/stream"),
        ("GET", "/api/this-route-does-not-exist"),
        ("GET", "/__worktree"),
        ("GET", "/"),
    ] {
        routes.push((m.to_string(), p.to_string()));
    }

    let exempt = |m: &str, p: &str| {
        m == "POST"
            && BEARER_ONLY_ROUTES.iter().any(|r| p == format!("/api{r}"))
    };
    let client = bare();
    let mut not_refused = Vec::new();
    for (method, path) in &routes {
        // `{id}`-style parameters: any value (the lock answers before routing).
        let concrete = regex_lite_params(path);
        let url = server.root_url(&concrete);
        let r = client
            .request(method.parse().unwrap(), &url)
            .send()
            .await
            .unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        let status = r.status().as_u16();
        if exempt(method, path) {
            assert_ne!(status, 403, "{method} {path} is a bearer-only route: it skips only the key");
            // ...and it must still refuse a browser page: any Origin is a 403.
            let r = client
                .request(method.parse().unwrap(), &url)
                .header("origin", "https://evil.example")
                .send()
                .await
                .unwrap();
            assert_eq!(r.status().as_u16(), 403, "{method} {path} with an Origin");
        } else if status != 403 {
            not_refused.push(format!("{method} {path} -> {status}"));
        }
    }
    assert!(
        not_refused.is_empty(),
        "these routes answered without the local-API key (the lock must cover every route):\n{}",
        not_refused.join("\n")
    );
}

/// `/api/x/{id}/y` -> `/api/x/00000000-0000-0000-0000-000000000000/y`.
fn regex_lite_params(path: &str) -> String {
    let mut out = String::new();
    let mut in_param = false;
    for c in path.chars() {
        match c {
            '{' => {
                in_param = true;
                out.push_str("00000000-0000-0000-0000-000000000000");
            }
            '}' => in_param = false,
            _ if !in_param => out.push(c),
            _ => {}
        }
    }
    out
}

/// The wiring half of the guard: axum's `Router::layer` wraps only the routes
/// registered BEFORE it, so a route added to `build_app` after the lock's
/// `.layer(...)` would sit outside it. The source of `build_app` must not
/// register a route, merge or nest a router, or set a fallback after the lock.
#[test]
fn build_app_adds_no_route_after_the_lock() {
    const LIB: &str = include_str!("../../src/lib.rs");
    let start = LIB.find("async fn build_app(").expect("build_app");
    let end = LIB[start..].find("\n}\n").map(|i| start + i).expect("end of build_app");
    let body = &LIB[start..end];
    let lock = body
        .find("modules::local_api_lock::enforce")
        .expect("build_app installs the lock");
    let after: String = body[lock..]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in [".route(", ".api_route(", ".merge(", ".nest(", ".fallback(", ".nest_service("] {
        assert!(
            !after.contains(forbidden),
            "build_app must not call `{forbidden}` after the local API lock is layered: \
             that route would sit outside the lock"
        );
    }
}
