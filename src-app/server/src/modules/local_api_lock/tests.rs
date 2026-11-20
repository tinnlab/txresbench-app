//! Unit tests for the lock's decision and its middleware (no socket).

use super::*;
use axum::body::Body;
use axum::http::Request;
use axum::routing::{get, post};
use axum::Router;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const PORT: u16 = 41234;

fn lock(mode: LockMode) -> LocalApiLock {
    let l = LocalApiLock::with_origins(SECRET.to_string(), mode, "/api", allowed_origins(false));
    l.set_port(PORT);
    l
}

fn app(lock: &LocalApiLock) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/session/local", post(|| async { "minted" }))
        .route("/api/mcp", post(|| async { "rpc" }))
        .route("/api/mcp/pair/exchange", post(|| async { "paired" }))
        .layer(axum::middleware::from_fn_with_state(lock.clone(), enforce))
}

struct Req {
    method: &'static str,
    path: &'static str,
    host: Option<String>,
    origin: Option<&'static str>,
    key: Option<&'static str>,
}

impl Req {
    /// The app's own window: right Host, webview Origin, the key.
    fn window(method: &'static str, path: &'static str) -> Self {
        Self {
            method,
            path,
            host: Some(format!("127.0.0.1:{PORT}")),
            origin: Some("tauri://localhost"),
            key: Some(SECRET),
        }
    }
    fn host(mut self, h: &str) -> Self {
        self.host = Some(h.to_string());
        self
    }
    fn origin(mut self, o: Option<&'static str>) -> Self {
        self.origin = o;
        self
    }
    fn key(mut self, k: Option<&'static str>) -> Self {
        self.key = k;
        self
    }
    async fn status(self, app: &Router) -> StatusCode {
        let mut b = Request::builder().method(self.method).uri(self.path);
        if let Some(h) = self.host {
            b = b.header("host", h);
        }
        if let Some(o) = self.origin {
            b = b.header("origin", o);
        }
        if let Some(k) = self.key {
            b = b.header(KEY_HEADER, k);
        }
        app.clone().oneshot(b.body(Body::empty()).unwrap()).await.unwrap().status()
    }
}

#[tokio::test]
async fn own_window_path_works() {
    let app = app(&lock(LockMode::Desktop));
    for origin in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
        let s = Req::window("POST", "/api/session/local").origin(Some(origin)).status(&app).await;
        assert_eq!(s, StatusCode::OK, "origin {origin}");
    }
    assert_eq!(Req::window("GET", "/api/health").status(&app).await, StatusCode::OK);
}

#[tokio::test]
async fn no_origin_client_with_the_key_works() {
    // curl, the integration-test client, the dev harness health poll.
    let app = app(&lock(LockMode::Desktop));
    let s = Req::window("POST", "/api/session/local").origin(None).status(&app).await;
    assert_eq!(s, StatusCode::OK);
    for host in ["localhost", "LOCALHOST"] {
        let s = Req::window("GET", "/api/health").origin(None).host(&format!("{host}:{PORT}")).status(&app).await;
        assert_eq!(s, StatusCode::OK, "{host}");
    }
    let s = Req::window("GET", "/api/health").origin(None).host(&format!("[::1]:{PORT}")).status(&app).await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn foreign_origin_is_refused_even_with_the_key() {
    let app = app(&lock(LockMode::Desktop));
    for origin in [
        "https://evil.example",
        "http://localhost:5173", // the dev origin is debug-only: not in this list
        "http://tauri.localhost.evil.example",
        "null",
    ] {
        let s = Req::window("POST", "/api/session/local").origin(Some(origin)).status(&app).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "origin {origin}");
    }
}

#[tokio::test]
async fn debug_builds_also_allow_the_vite_origin() {
    let l = LocalApiLock::with_origins(SECRET.into(), LockMode::Desktop, "/api", allowed_origins(true));
    l.set_port(PORT);
    let app = app(&l);
    let s = Req::window("GET", "/api/health").origin(Some(DEV_ORIGIN)).status(&app).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!allowed_origins(false).contains(&DEV_ORIGIN));
}

#[tokio::test]
async fn webview_origin_without_the_key_is_refused() {
    // Windows: every Tauri 2 app, and any local web server, shares tauri.localhost.
    let app = app(&lock(LockMode::Desktop));
    for (k, why) in [(None, "no key"), (Some("wrong"), "wrong key"), (Some(""), "empty key")] {
        let s = Req::window("POST", "/api/session/local").origin(Some("http://tauri.localhost")).key(k).status(&app).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{why}");
    }
    // A key that differs in one character, and a prefix of the right one.
    let s = Req::window("GET", "/api/health").key(Some("0123456789abcdef0123456789abcdee")).status(&app).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let s = Req::window("GET", "/api/health").key(Some("0123456789abcdef")).status(&app).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn wrong_host_is_refused() {
    let app = app(&lock(LockMode::Desktop));
    for host in [
        "evil.example".to_string(),
        format!("evil.example:{PORT}"),
        format!("127.0.0.1.evil.example:{PORT}"),
        format!("localhost.evil.example:{PORT}"),
        "127.0.0.1:1".to_string(),
        "127.0.0.1".to_string(), // no port
        format!("127.0.0.1:{PORT}0"),
        format!("0.0.0.0:{PORT}"),
        format!("[::2]:{PORT}"),
    ] {
        let s = Req::window("GET", "/api/health").host(&host).status(&app).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "host {host}");
    }
    let mut r = Req::window("GET", "/api/health");
    r.host = None;
    assert_eq!(r.status(&app).await, StatusCode::FORBIDDEN, "no Host header");
}

#[tokio::test]
async fn before_the_port_is_known_everything_is_refused() {
    let l = LocalApiLock::with_origins(SECRET.into(), LockMode::Desktop, "/api", allowed_origins(false));
    let app = app(&l);
    assert_eq!(Req::window("GET", "/api/health").status(&app).await, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn refusals_are_bare() {
    let app = app(&lock(LockMode::Desktop));
    let resp = app
        .clone()
        .oneshot(Request::builder().uri("/api/health").header("host", "evil.example").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
    assert!(body.is_empty(), "a refusal carries no detail");
}

#[tokio::test]
async fn pairing_routes_skip_only_the_key() {
    let app = app(&lock(LockMode::Desktop));
    for path in ["/api/mcp", "/api/mcp/pair/exchange"] {
        // A paired outside client: right Host, no Origin, no key.
        assert_eq!(Req::window("POST", path).origin(None).key(None).status(&app).await, StatusCode::OK, "{path}");
        // A browser page: any Origin is refused, with or without the key.
        for origin in ["https://evil.example", "tauri://localhost", "null"] {
            let s = Req::window("POST", path).origin(Some(origin)).key(None).status(&app).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{path} {origin}");
            let s = Req::window("POST", path).origin(Some(origin)).status(&app).await;
            assert_eq!(s, StatusCode::FORBIDDEN, "{path} {origin} + key: a page never uses the bearer-only door");
        }
        // The Host check still applies (DNS rebinding).
        let s = Req::window("POST", path).origin(None).key(None).host("evil.example").status(&app).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{path} wrong host");
    }
    // Only POST on those two paths: a GET on the same path needs the key.
    let s = Req::window("GET", "/api/mcp").origin(None).key(None).status(&app).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // And no other route is exempt.
    let s = Req::window("POST", "/api/session/local").origin(None).key(None).status(&app).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn headless_mode_checks_the_key_only() {
    let app = app(&lock(LockMode::Headless));
    // Any Host and Origin (reverse proxy, the Vite dev proxy) with the key.
    let s = Req::window("POST", "/api/session/local").host("my-server.lab:8080").origin(Some("https://x.example")).status(&app).await;
    assert_eq!(s, StatusCode::OK);
    let s = Req::window("POST", "/api/session/local").host("my-server.lab:8080").key(None).status(&app).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // The pairing routes keep the no-Origin rule.
    let s = Req::window("POST", "/api/mcp").host("my-server.lab:8080").origin(Some("https://x.example")).key(None).status(&app).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let s = Req::window("POST", "/api/mcp").host("my-server.lab:8080").origin(None).key(None).status(&app).await;
    assert_eq!(s, StatusCode::OK);
}

#[test]
fn secrets_are_random_and_long() {
    let a = generate_secret();
    let b = generate_secret();
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

#[test]
fn host_parser_edge_cases() {
    assert!(host_is_loopback_with_port("127.0.0.1:80", 80));
    assert!(!host_is_loopback_with_port("127.0.0.1:+80", 80));
    assert!(!host_is_loopback_with_port("127.0.0.1:080x", 80));
    assert!(!host_is_loopback_with_port("::1:80", 80), "an unbracketed v6 literal is not a host:port");
    assert!(!host_is_loopback_with_port("", 80));
}

#[test]
fn headless_key_resolution() {
    let (k, generated) = resolve_headless_key_with(Some("from-env-from-env".into()), Some("file-file-file-file".into()));
    assert_eq!((k.as_str(), generated), ("from-env-from-env", false));
    let (k, generated) = resolve_headless_key_with(Some("  ".into()), Some("file-file-file-file".into()));
    assert_eq!((k.as_str(), generated), ("file-file-file-file", false));
    let (k, generated) = resolve_headless_key_with(None, None);
    assert!(generated);
    assert_eq!(k.len(), 64);
}
