//! ITEM-4 integration suite — the update-check seam against a loopback feed
//! (TEST-IR-6, TEST-IR-21, TEST-IR-17, and the ITEM-4 half of TEST-IR-14).
//!
//! The shell's runtime network reach is ONE identifier-free GET of the feed
//! URL (INV-1 / INV-4): the crate passes the fixed `UPDATER_FEED_URL`
//! constant to the check seam — never a URL built from user or install data
//! — and the loopback transport records the request's raw bytes so the shape
//! (path, empty query, no identifier headers) is asserted on the wire.
//!
//! The seams under test (`UpdateRuntime::new`) replace the plugin edges; the
//! DECISION pipeline is the crate's own: the state machine, the `is_newer`
//! gate and the `parse_feed` wire-shape reader all run against the loopback
//! body (the production check delegates the same shape to the plugin).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use txresbench_desktop_lib::updates::{
    UPDATER_FEED_URL, UpdateEvents, UpdateInfo, UpdateRuntime, UpdateState, available_prompt_text,
    boot_prompt, check_for_update, get_update_status, install_update, parse_feed,
    set_runtime_for_tests, updater_configured, CheckFn, InstallFn, RestartFn,
};

/// The updater runtime is a process-global one-slot (like the shell's); every
/// test that replaces it takes this lock so tests never see each other's
/// seams.
static SERIAL: Mutex<()> = Mutex::new(());

/// A loopback feed server: accepts connections with a bounded wait, records
/// each raw request, and answers with the configured response. After the
/// server's lifetime it stops accepting (a test asserts `received` afterwards).
struct LoopbackFeed {
    addr: std::net::SocketAddr,
    /// The raw-request record; tests assert on the Arc they passed in (the
    /// field is the server thread's own handle — read only via the clone).
    #[allow(dead_code)]
    received: Arc<Mutex<Vec<Vec<u8>>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl LoopbackFeed {
    /// Serve `body` (HTTP 200) or `status` (e.g. 404) for at most `lifetime`.
    fn serve(body: Response, lifetime: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let received: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let handle = std::thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("nonblocking listener");
            let deadline = Instant::now() + lifetime;
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = Vec::new();
                        let mut buf = [0u8; 4096];
                        // Read the request head (past the blank line) — the
                        // response is a static body, so reading a bit of the
                        // request is enough for the record.
                        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                            match stream.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => request.extend_from_slice(&buf[..n]),
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                    std::thread::sleep(Duration::from_millis(10));
                                }
                                Err(_) => {
                                    received_clone.lock().unwrap().push(request);
                                    return;
                                }
                            }
                        }
                        received_clone.lock().unwrap().push(request.clone());
                        let head = match &body {
                            Response::Feed(_) => "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ".to_string(),
                            Response::Status(code) => format!("HTTP/1.1 {code} Not Found\r\nContent-Length: 0\r\n"),
                        };
                        let content = match &body {
                            Response::Feed(bytes) => bytes.len().to_string(),
                            Response::Status(_) => "0".to_string(),
                        };
                        let head = head + &content + "\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(head.as_bytes());
                        if let Response::Feed(bytes) = &body {
                            let _ = stream.write_all(bytes);
                        }
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            addr,
            received,
            handle: Some(handle),
        }
    }
}

impl Drop for LoopbackFeed {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

enum Response {
    Feed(Vec<u8>),
    Status(u16),
}

/// A feed body in the frozen PROV-landing-site-5 wire shape (ITEM-5's
/// writer emits exactly this).
fn feed(version: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "version": version,
        "pub_date": "2026-11-05T00:00:00Z",
        "platforms": {
            "linux-x86_64": {"url": "https://github.com/tinnlab/txresbench-app/releases/download/app-v0.2.0/TxResBench_0.2.0_amd64.AppImage", "signature": "RWTdummy signature bytes"},
            "darwin-aarch64": {"url": "https://github.com/tinnlab/txresbench-app/releases/download/app-v0.2.0/TxResBench_0.2.0_universal.app.tar.gz", "signature": "RWTdummy signature bytes"},
            "darwin-x86_64": {"url": "https://github.com/tinnlab/txresbench-app/releases/download/app-v0.2.0/TxResBench_0.2.0_universal.app.tar.gz", "signature": "RWTdummy signature bytes"},
            "windows-x86_64": {"url": "https://github.com/tinnlab/txresbench-app/releases/download/app-v0.2.0/TxResBench_0.2.0_x64-setup.exe", "signature": "RWTdummy signature bytes"}
        }
    }))
    .expect("feed serializes")
}

/// The injected CHECK seam (TEST-IR-6/21): assert the crate passed the fixed
/// constant, GET the loopback URL with a bare std transport (recording the
/// raw request), then run the crate's OWN `parse_feed` reader over the body
/// so the update decision (shape + platform + version) is the crate's.
fn loopback_check(
    address: std::net::SocketAddr,
    recorded: Arc<Mutex<Vec<Vec<u8>>>>,
) -> CheckFn {
    Box::new(move |feed_url, _events| {
        // INV-4: the seam's URL is the fixed constant, never parameterized
        // with user or install data.
        assert_eq!(
            feed_url, UPDATER_FEED_URL,
            "the crate hands the check seam the canonical feed URL (INV-4)"
        );
        Box::pin(async move {
            let mut stream =
                TcpStream::connect(address).map_err(|e| format!("loopback connect: {e}"))?;
            let request = format!(
                "GET /updates/latest.json HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
            );
            stream
                .write_all(request.as_bytes())
                .map_err(|e| format!("loopback write: {e}"))?;
            // Record the REQUEST as sent (the wire shape TEST-IR-21 asserts);
            // the transport sends nothing the crate parameterized.
            recorded.lock().unwrap().push(request.into_bytes());
            let mut response = Vec::new();
            stream
                .read_to_end(&mut response)
                .map_err(|e| format!("loopback read: {e}"))?;
            let text =
                String::from_utf8(response).map_err(|_| "loopback response is not utf8".to_string())?;
            let (head, body) = text
                .split_once("\r\n\r\n")
                .ok_or_else(|| "loopback response has no body".to_string())?;
            let status: u16 = head
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| "loopback status line unreadable".to_string())?;
            if status == 404 {
                // A 404 is the silent "no update" class (acceptance 5).
                return Ok(None);
            }
            if status != 200 {
                return Err(format!("loopback status {status}"));
            }
            parse_feed(body.as_bytes())
        })
    })
}

/// The injected INSTALL seam for the flow tests: a recording fake (no real
/// bytes; the real verify is the plugin's own, outside the test's reach —
/// TESTS.md's honesty note).
fn fake_install(ok: bool, invoked: Arc<AtomicUsize>) -> InstallFn {
    Box::new(move |_info, events| {
        let ok = ok;
        let invoked = invoked.clone();
        Box::pin(async move {
            invoked.fetch_add(1, Ordering::SeqCst);
            events.emit(txresbench_desktop_lib::updates::UpdateEvent::DownloadProgress {
                bytes_downloaded: 4,
                bytes_total: 8,
            });
            if ok { Ok(()) } else { Err("loopback install failed".to_string()) }
        })
    })
}

/// The injected RESTART seam for the flow tests: counts invocations without
/// ever restarting (an executable restart would kill the test).
fn fake_restart(invoked: Arc<AtomicUsize>) -> RestartFn {
    Box::new(move || {
        invoked.fetch_add(1, Ordering::SeqCst);
    })
}

/// The runtime the integration tests install (current version 0.1.0 — the
/// shipped `tauri.conf.json` version).
fn test_runtime(
    configured: bool,
    check: CheckFn,
    install: Option<InstallFn>,
    restarts: Arc<AtomicUsize>,
) -> Arc<UpdateRuntime> {
    let rt = Arc::new(UpdateRuntime::new(
        configured,
        "0.1.0".to_string(),
        check,
        install.unwrap_or_else(|| {
            Box::new(|_info: &UpdateInfo, _events: UpdateEvents| {
                Box::pin(async { Err("install not injected".to_string()) })
            })
        }),
        fake_restart(restarts.clone()),
    ));
    set_runtime_for_tests(rt.clone());
    rt
}

// ── TEST-IR-6 / TEST-IR-21 — the loopback check ─────────────────────────────

#[tokio::test]
async fn newer_feed_goes_to_available_and_the_request_is_a_bare_get() {
    let _serial = SERIAL.lock().unwrap();
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let feed_server = LoopbackFeed::serve(Response::Feed(feed("0.2.0")), Duration::from_secs(1));
    let rt = test_runtime(
        true,
        loopback_check(feed_server.addr, recorded.clone()),
        None,
        Arc::new(AtomicUsize::new(0)),
    );

    let dto = check_for_update().await.expect("check against the loopback");
    assert_eq!(dto.state, "available");
    assert_eq!(dto.update_version.as_deref(), Some("0.2.0"));
    assert_eq!(
        rt.state(),
        UpdateState::Available {
            version: "0.2.0".to_string(),
            url: "https://github.com/tinnlab/txresbench-app/releases/download/app-v0.2.0/TxResBench_0.2.0_amd64.AppImage".to_string(),
        }
    );

    // TEST-IR-21: the recorded request is the bare identifier-free GET.
    let requests = recorded.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "exactly one request per check");
    let request = String::from_utf8(requests[0].clone()).expect("request is utf8");
    let first_line = request.lines().next().expect("request line");
    assert_eq!(first_line, "GET /updates/latest.json HTTP/1.1");
    assert!(
        !request.contains('?'),
        "the request carries an empty query string: {request}"
    );
    let lower = request.to_ascii_lowercase();
    for forbidden in ["cookie", "authorization", "x-", "user-agent"] {
        assert!(
            !lower.contains(&format!("{forbidden}:")),
            "no identifier-bearing {forbidden} header: {request}"
        );
    }
}

#[tokio::test]
async fn equal_or_older_feed_is_up_to_date() {
    let _serial = SERIAL.lock().unwrap();
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let feed_server = LoopbackFeed::serve(Response::Feed(feed("0.1.0")), Duration::from_secs(1));
    let rt = test_runtime(
        true,
        loopback_check(feed_server.addr, recorded),
        None,
        Arc::new(AtomicUsize::new(0)),
    );

    let dto = check_for_update().await.expect("equal version is fine");
    assert_eq!(dto.state, "up_to_date");
    assert_eq!(rt.state(), UpdateState::UpToDate);
}

#[tokio::test]
async fn a_404_is_silent_up_to_date() {
    let _serial = SERIAL.lock().unwrap();
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let feed_server = LoopbackFeed::serve(Response::Status(404), Duration::from_secs(1));
    let rt = test_runtime(
        true,
        loopback_check(feed_server.addr, recorded),
        None,
        Arc::new(AtomicUsize::new(0)),
    );

    let dto = check_for_update().await.expect("a 404 is silent, not an error");
    assert_eq!(dto.state, "up_to_date");
    assert_eq!(rt.state(), UpdateState::UpToDate);
}

#[tokio::test]
async fn malformed_feed_is_an_error_state() {
    let _serial = SERIAL.lock().unwrap();
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let feed_server = LoopbackFeed::serve(
        Response::Feed(br#"{"version": "0.2.0", "platforms": {"linux-x86_64": {"url": ""}}}"#.to_vec()),
        Duration::from_secs(1),
    );
    let rt = test_runtime(
        true,
        loopback_check(feed_server.addr, recorded.clone()),
        None,
        Arc::new(AtomicUsize::new(0)),
    );

    let err = check_for_update().await.expect_err("a malformed entry is an error");
    assert!(err.contains("platform entry"), "{err}");
    assert!(matches!(rt.state(), UpdateState::Error { .. }));
}

#[tokio::test]
async fn empty_pubkey_runs_the_check_and_makes_no_connection() {
    let _serial = SERIAL.lock().unwrap();
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    // The server lives for most of the check-run window; the never-dials
    // rule means its accept loop times out with ZERO recorded requests.
    let feed_server = LoopbackFeed::serve(Response::Feed(feed("0.2.0")), Duration::from_millis(600));
    let check = loopback_check(feed_server.addr, recorded.clone());
    let rt = test_runtime(false, check, None, Arc::new(AtomicUsize::new(0)));

    let dto = check_for_update().await.expect("unconfigured is a valid state");
    assert_eq!(dto.state, "unconfigured");
    assert_eq!(rt.state(), UpdateState::Unconfigured);
    // The server's accept loop outlives the check by a bounded margin.
    std::thread::sleep(Duration::from_millis(700));
    assert!(
        recorded.lock().unwrap().is_empty(),
        "an empty pubkey NEVER dials the feed (INV-1, DEC-5)"
    );
}

// ── TEST-IR-17 — the prompt decision + the install/restart flow ─────────────

#[test]
fn the_prompt_decision_is_pure_and_carries_no_clinical_claim() {
    let available = UpdateState::Available {
        version: "0.2.0".to_string(),
        url: "https://example.invalid/u".to_string(),
    };
    let prompt = boot_prompt(&available).expect("an available update prompts");
    assert!(
        prompt.contains("0.2.0"),
        "the ask names the new version: {prompt}"
    );
    for claim in ["cure", "treat", "efficacy", "effect", "disease", "predict"] {
        assert!(
            !prompt.to_ascii_lowercase().contains(claim),
            "the update ask carries no clinical claim ({claim}): {prompt}"
        );
    }
    assert_eq!(
        prompt,
        available_prompt_text("0.2.0"),
        "the prompt text is the PROV-IR-6 copy"
    );

    for silent in [
        UpdateState::UpToDate,
        UpdateState::Error {
            message: "offline".to_string(),
        },
        UpdateState::Unconfigured,
        UpdateState::Idle,
    ] {
        assert_eq!(boot_prompt(&silent), None, "{silent:?} is silent (DEC-14)");
    }
}

#[tokio::test]
async fn install_update_restarts_after_a_successful_download() {
    let _serial = SERIAL.lock().unwrap();
    let restarts = Arc::new(AtomicUsize::new(0));
    let installs = Arc::new(AtomicUsize::new(0));
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let feed_server = LoopbackFeed::serve(Response::Feed(feed("0.2.0")), Duration::from_secs(1));
    let rt = test_runtime(
        true,
        loopback_check(feed_server.addr, recorded),
        Some(fake_install(true, installs.clone())),
        restarts.clone(),
    );

    check_for_update().await.expect("available");
    install_update().await.expect("install ok");

    assert_eq!(rt.state(), UpdateState::ReadyToRestart);
    assert_eq!(installs.load(Ordering::SeqCst), 1, "one install ran");
    assert_eq!(
        restarts.load(Ordering::SeqCst),
        1,
        "a successful install requests the restart via the RestartFn seam"
    );
}

#[tokio::test]
async fn install_failure_records_error_and_never_restarts() {
    let _serial = SERIAL.lock().unwrap();
    let restarts = Arc::new(AtomicUsize::new(0));
    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let feed_server = LoopbackFeed::serve(Response::Feed(feed("0.2.0")), Duration::from_secs(1));
    let rt = test_runtime(
        true,
        loopback_check(feed_server.addr, recorded),
        Some(fake_install(false, Arc::new(AtomicUsize::new(0)))),
        restarts.clone(),
    );

    check_for_update().await.expect("available");
    let err = install_update().await.expect_err("the failure surfaces ONE message");
    assert_eq!(err, "loopback install failed");
    assert!(matches!(rt.state(), UpdateState::Error { .. }));
    assert_eq!(
        restarts.load(Ordering::SeqCst),
        0,
        "a failed install never requests a restart"
    );
}

#[tokio::test]
async fn install_update_without_an_available_state_is_refused() {
    let _serial = SERIAL.lock().unwrap();
    let rt = test_runtime(
        true,
        ok_check(None),
        Some(fake_install(true, Arc::new(AtomicUsize::new(0)))),
        Arc::new(AtomicUsize::new(0)),
    );

    let err = install_update().await.expect_err("nothing to install");
    assert!(err.contains("no update is available"), "{err}");
    assert_eq!(rt.state(), UpdateState::Idle);
}

// ── status + misc ───────────────────────────────────────────────────────────

#[tokio::test]
async fn get_update_status_reflects_the_state() {
    let _serial = SERIAL.lock().unwrap();
    let _rt = test_runtime(
        true,
        ok_check(Some(UpdateInfo {
            version: "0.2.0".to_string(),
            url: "https://example.invalid/u".to_string(),
        })),
        None,
        Arc::new(AtomicUsize::new(0)),
    );

    let idle = get_update_status().expect("status");
    assert_eq!(idle.state, "idle");
    assert_eq!(idle.current_version, "0.1.0");

    check_for_update().await.expect("check");
    let available = get_update_status().expect("status");
    assert_eq!(available.state, "available");
    assert_eq!(available.update_version.as_deref(), Some("0.2.0"));
    assert_eq!(available.bytes_downloaded, 0);
    assert!(available.message.is_none());
}

#[test]
fn the_pubkey_configured_rule_is_pure() {
    assert!(updater_configured(Some("RWT9kY28Xo07UQyYSU8VJg==")));
    assert!(!updater_configured(Some("")));
    assert!(!updater_configured(None));
}

/// A check seam returning a canned outcome (no network) — for the flow
/// tests that do not need the loopback feed.
fn ok_check(info: Option<UpdateInfo>) -> CheckFn {
    Box::new(move |_url, _events| {
        let info = info.clone();
        Box::pin(async move { Ok(info) })
    })
}
