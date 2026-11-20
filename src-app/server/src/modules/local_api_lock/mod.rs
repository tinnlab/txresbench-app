//! `local_api_lock` — only the app's own window (or a caller that holds the
//! per-run key) can use the local HTTP API.
//!
//! Why: the desktop app serves its API on a loopback port. Any web page in the
//! user's browser can send requests to `127.0.0.1:<port>`, and a CORS answer
//! does not stop a request from being processed (only from being READ). Without
//! a lock, a page could mint the owner token (`POST /api/session/local`) and
//! then run methods, delete environments and read results.
//!
//! The lock is ONE whole-app middleware, layered in `lib.rs::build_app` after
//! every route exists (so a route added later is covered by construction; the
//! guard test enumerates the built router to prove it). It refuses with a bare
//! `403` and no detail (nothing for a probe to learn from):
//!
//! 1. **Host** (desktop mode only): `127.0.0.1`, `localhost` or `[::1]` WITH
//!    the bound port. Anything else is a DNS-rebinding attempt.
//! 2. **Origin** (desktop mode only): when present, one of the webview
//!    origins ([`allowed_origins`]). A foreign page is refused even if it
//!    somehow held the key.
//! 3. **Key**: the `X-TxR-Local-Key` header must equal the per-run secret
//!    (constant-time compare). The secret is made at start, kept in memory,
//!    given to the webview only over Tauri IPC and never logged or written.
//!
//! No route is exempt, `/api/health` included, with ONE narrow exception: the
//! two requests an outside AI client makes before and after pairing (see
//! [`BEARER_ONLY_ROUTES`]). Those clients are separate programs that cannot
//! read the window's IPC; the one-time pairing code and the bearer token are
//! their credentials. They skip only the key check: Host is still checked, and
//! ANY request carrying an `Origin` header is refused, so a web page cannot use
//! the exemption (browsers send `Origin` on every POST).
//!
//! Modes: [`LockMode::Desktop`] (the embedded server: all three checks) and
//! [`LockMode::Headless`] (the CLI server, reachable under any hostname and by
//! a dev proxy: the key check only, plus the Origin rule on the pairing
//! routes). Demo mode (a public web service with anonymous visitors by
//! design) installs no lock at all.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rand::RngCore;
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

/// The request header that carries the per-run secret.
pub const KEY_HEADER: &str = "x-txr-local-key";
/// The env var that supplies the headless server's key.
pub const KEY_ENV: &str = "TXR_LOCAL_API_KEY";

/// The origins the app's own webview uses: `tauri://localhost` (macOS, Linux)
/// and `http(s)://tauri.localhost` (Windows).
pub const WEBVIEW_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];
/// The Vite dev server origin; allowed in debug builds only.
pub const DEV_ORIGIN: &str = "http://localhost:5173";

/// The origins the desktop server accepts (and answers CORS for). Never `*`.
pub fn allowed_origins(debug: bool) -> Vec<&'static str> {
    let mut v = WEBVIEW_ORIGINS.to_vec();
    if debug {
        v.push(DEV_ORIGIN);
    }
    v
}

/// The routes outside AI clients call without the key (path relative to the
/// API prefix; always POST). Each still needs its own credential: `/mcp`
/// refuses a missing or invalid bearer (`RequirePermissions`), `/mcp/pair/exchange`
/// refuses an unknown or used one-time code.
pub const BEARER_ONLY_ROUTES: [&str; 2] = ["/mcp", "/mcp/pair/exchange"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockMode {
    /// The embedded desktop server: Host + Origin + key.
    Desktop,
    /// The CLI server: key only.
    Headless,
}

/// A fresh 256-bit secret (OS random), hex.
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// The lock's state: cheap to clone (everything is shared).
#[derive(Clone)]
pub struct LocalApiLock {
    inner: Arc<Inner>,
}

struct Inner {
    /// SHA-256 of the secret: the compare never touches the raw secret's length.
    digest: [u8; 32],
    secret: String,
    mode: LockMode,
    api_prefix: String,
    origins: Vec<&'static str>,
    /// The bound port; 0 until the listener is bound (then every desktop
    /// request is refused: fail closed).
    port: AtomicU16,
}

impl LocalApiLock {
    pub fn new(secret: String, mode: LockMode, api_prefix: &str) -> Self {
        Self::with_origins(secret, mode, api_prefix, allowed_origins(cfg!(debug_assertions)))
    }

    pub fn with_origins(
        secret: String,
        mode: LockMode,
        api_prefix: &str,
        origins: Vec<&'static str>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                digest: Sha256::digest(secret.as_bytes()).into(),
                secret,
                mode,
                api_prefix: api_prefix.trim_end_matches('/').to_string(),
                origins,
                port: AtomicU16::new(0),
            }),
        }
    }

    /// Record the bound port (called right after `bind`, before `serve`).
    pub fn set_port(&self, port: u16) {
        self.inner.port.store(port, Ordering::Relaxed);
    }

    /// The secret, for the in-process callers that must present it (the MCP
    /// loopback dispatch).
    pub fn secret(&self) -> &str {
        &self.inner.secret
    }

    fn key_ok(&self, headers: &HeaderMap) -> bool {
        let Some(v) = headers.get(KEY_HEADER) else {
            return false;
        };
        let got: [u8; 32] = Sha256::digest(v.as_bytes()).into();
        // Constant-time: fold the XOR of two fixed-size digests.
        let mut diff = 0u8;
        for (a, b) in got.iter().zip(self.inner.digest.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }

    fn host_ok(&self, headers: &HeaderMap) -> bool {
        let port = self.inner.port.load(Ordering::Relaxed);
        if port == 0 {
            return false;
        }
        let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
            return false;
        };
        host_is_loopback_with_port(host, port)
    }

    fn origin_ok(&self, headers: &HeaderMap) -> bool {
        match headers.get(header::ORIGIN) {
            None => true,
            Some(v) => v
                .to_str()
                .map(|o| self.inner.origins.iter().any(|a| *a == o))
                .unwrap_or(false),
        }
    }

    fn is_bearer_only(&self, method: &Method, path: &str) -> bool {
        method == Method::POST
            && path
                .strip_prefix(self.inner.api_prefix.as_str())
                .is_some_and(|rel| BEARER_ONLY_ROUTES.contains(&rel))
    }

    /// The whole decision, pure so the unit tests drive it without a socket.
    pub fn allows(&self, method: &Method, path: &str, headers: &HeaderMap) -> Result<(), &'static str> {
        if self.inner.mode == LockMode::Desktop && !self.host_ok(headers) {
            return Err("host");
        }
        if self.is_bearer_only(method, path) {
            // No key, but never from a browser page: refuse any Origin.
            return if headers.contains_key(header::ORIGIN) {
                Err("origin on a bearer-only route")
            } else {
                Ok(())
            };
        }
        if self.inner.mode == LockMode::Desktop && !self.origin_ok(headers) {
            return Err("origin");
        }
        if !self.key_ok(headers) {
            return Err("key");
        }
        Ok(())
    }
}

/// `127.0.0.1`, `localhost` or `[::1]`, then exactly `:<port>`.
fn host_is_loopback_with_port(host: &str, port: u16) -> bool {
    let Some((name, p)) = host.rsplit_once(':') else {
        return false;
    };
    if p.parse::<u16>().ok() != Some(port) || p.starts_with('+') {
        return false;
    }
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1" || name == "[::1]"
}

/// The middleware: a refusal is a bare 403 (no body, no reason on the wire).
pub async fn enforce(State(lock): State<LocalApiLock>, req: Request, next: Next) -> Response {
    match lock.allows(req.method(), req.uri().path(), req.headers()) {
        Ok(()) => next.run(req).await,
        Err(reason) => {
            tracing::debug!(
                reason,
                method = %req.method(),
                path = %req.uri().path(),
                "local api lock: request refused"
            );
            StatusCode::FORBIDDEN.into_response()
        }
    }
}

/// A configured key shorter than this is refused: a short key is guessable.
pub const MIN_KEY_LEN: usize = 16;

/// The key a headless server runs with: `TXR_LOCAL_API_KEY` (non-empty), else
/// the config file's `local_api.key`, else a fresh one (`generated == true`,
/// so `main` prints it once). A configured key under [`MIN_KEY_LEN`]
/// characters is an error (boot refuses; it never silently falls back).
pub fn resolve_headless_key(from_file: Option<String>) -> Result<(String, bool), String> {
    resolve_headless_key_with(std::env::var(KEY_ENV).ok(), from_file)
}

pub fn resolve_headless_key_with(
    env: Option<String>,
    from_file: Option<String>,
) -> Result<(String, bool), String> {
    for v in [env, from_file].into_iter().flatten() {
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        if v.len() < MIN_KEY_LEN {
            return Err(format!(
                "the local API key ({KEY_ENV} or `local_api.key`) must be at least {MIN_KEY_LEN} characters"
            ));
        }
        return Ok((v.to_string(), false));
    }
    Ok((generate_secret(), true))
}

/// The line a headless server prints once at start when it made the key.
pub fn key_banner(key: &str) -> String {
    format!(
        "TxResBench local API key: {key}\n\
         Every request must send it as the `X-TxR-Local-Key` header. Set {KEY_ENV} to choose your own."
    )
}
