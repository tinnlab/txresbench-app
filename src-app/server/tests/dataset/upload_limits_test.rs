//! #185 §1 — the upload ceiling stops being a compiled constant.
//!
//! These are the acceptance tests for the invariants in
//! `.lifecycle/uncapped-uploads/PLAN.md`, which lifts them from
//! `docs/design/upload-limits-policy.md`.
//!
//! ```text
//! TEST-1  INV-2  the SaaS ceiling is read AT USE from the configured value (saas build)
//! TEST-2  INV-1  a desktop build has NO size ceiling, even with the setting at its floor
//! TEST-4  INV-6  a multi-MB multipart HEADER block is refused, and not buffered
//! TEST-5  INV-5  peak RSS is still bounded by a constant with the body limit gone
//! TEST-9  INV-2  an upload the SHIPPED binary refuses is accepted by changing a setting
//! ```
//!
//! ## Why TEST-9 is the one that actually proves the uncapping
//!
//! The retired ceiling was 64 GiB and axum's body limit is byte-driven
//! (`http_body_util::Limited` counts frames; it does not short-circuit on
//! `Content-Length`), so observing *that* number end to end means putting 64 GiB on
//! the wire. That is #185 §1's own complaint about the constant, and it does not
//! become false by wishing.
//!
//! TEST-9 sidesteps it by proving the same promotion on the other constant. At the
//! shipped default, 1025 file parts is a `413 UPLOAD_TOO_MANY_PARTS` — a refusal the
//! binary on `main` produces today, at production settings, with no test-only value
//! anywhere. Raising `max_upload_parts` through the admin API makes the *identical*
//! request succeed, with no restart. That is a genuine "previously refused, now
//! accepted", and it can only pass if the constant is really gone.

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

use cytoanalyst::modules::file::upload_guard::MAX_PART_HEADER_BYTES;

// Only TEST-2's in-process control constructs a guard directly, and TEST-2 is the
// DESKTOP arm — so under `--features saas` these three are genuinely unused and an
// ungated import warns. Gated to match the test that uses them rather than silenced
// with an allow, so the pairing stays visible.
#[cfg(not(feature = "saas"))]
use cytoanalyst::modules::file::upload_guard::{GuardRefusal, UploadGuard, UploadLimits};

use super::rss_probe::{peak_and_current_rss_kib, peak_rss_kib, server_child_pid, RssPoller, MIB};
use super::upload_streaming_test::rss_measurement_guard;
use super::{create_user, login, setup_admin};
use crate::common::TestServer;

const MIB_BYTES: u64 = 1024 * 1024;

/// The same absolute RSS bound #182 established. Kept identical on purpose: this
/// branch's claim is that removing the body limit did not move it.
const RSS_BOUND_KIB: u64 = 64 * MIB;

/// Read the workstore settings singleton as the admin.
async fn get_settings(server: &TestServer, admin: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url("/workstore/settings"))
        .bearer_auth(admin)
        .send()
        .await
        .expect("GET /workstore/settings");
    assert_eq!(resp.status().as_u16(), 200, "admin can read the settings row");
    resp.json().await.expect("settings json")
}

/// PUT a partial workstore-settings patch as the admin, asserting it was accepted.
async fn put_settings(server: &TestServer, admin: &str, patch: Value) -> Value {
    let resp = server
        .client
        .put(server.api_url("/workstore/settings"))
        .bearer_auth(admin)
        .json(&patch)
        .send()
        .await
        .expect("PUT /workstore/settings");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    assert_eq!(status, 200, "PUT {patch} accepted: {body}");
    body
}

/// A single-file multipart upload of `len` deterministic bytes.
///
/// The body is BUFFERED here (not generated) so the whole request is written before
/// the response is read — which is what keeps the over-ceiling legs from racing the
/// server's early refusal against the client's still-in-flight body. Sizes here are
/// single-digit MiB for exactly that reason; the multi-hundred-MiB legs live in
/// TEST-5, which does not need to observe a refusal.
async fn upload_bytes(
    server: &TestServer,
    token: &str,
    len: usize,
    filename: &str,
) -> (u16, Value) {
    let payload: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
    let form = Form::new().part(
        "file",
        Part::bytes(payload).file_name(filename.to_string()),
    );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload request");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// A multipart body with `n` tiny `file` parts, built by hand so the part COUNT is
/// exact (a `Form` would be equivalent but this keeps the count obvious).
fn many_parts_body(boundary: &str, n: usize) -> Vec<u8> {
    let mut body = Vec::new();
    for i in 0..n {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
                 filename=\"p{i}.txt\"\r\nContent-Type: text/plain\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(b"x\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

async fn post_raw_multipart(
    server: &TestServer,
    token: &str,
    boundary: &str,
    body: Vec<u8>,
) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .expect("raw multipart request");
    let status = resp.status().as_u16();
    let json: Value = resp.json().await.unwrap_or(Value::Null);
    (status, json)
}

/// The `error_code` of a refusal body.
///
/// The API's error shape is FLAT — `{"error": "<prose>", "error_code": "<CODE>"}` —
/// which is what `upload_streaming_test.rs:711/787/1259` reads. An earlier draft of
/// this helper looked at `body["error"]["code"]` and `body["code"]`, neither of which
/// exists, so it returned `""` for every refusal and every assertion built on it
/// compared `""` against the expected code. Panicking on an unrecognised shape rather
/// than returning `""` is deliberate: a silent empty string is what let that survive.
fn error_code(body: &Value) -> String {
    body["error_code"]
        .as_str()
        .unwrap_or_else(|| panic!("no `error_code` in refusal body: {body}"))
        .to_string()
}

/// The size of the single uploaded file in a `POST /datasets/upload` response.
///
/// A dataset carries its files in a `files` ARRAY (`datasets[0].files[0].file_size`);
/// there is no `file_size` directly on the dataset. Reading the flat path yields
/// `None` for a perfectly good 200, which is how four of these tests failed against
/// a server that had behaved correctly.
fn uploaded_file_size(body: &Value) -> Option<u64> {
    body["datasets"][0]["files"][0]["file_size"].as_u64()
}

// ---------------------------------------------------------------------------
// TEST-9 [acceptance] [invariant: INV-2]
// ---------------------------------------------------------------------------

/// uncapped-uploads TEST-9 — an upload the SHIPPED binary refuses today is accepted
/// after an admin changes a setting, with no restart.
///
/// This is the branch's strongest evidence that the compiled constant is genuinely
/// gone rather than merely renamed: leg 1 reproduces `main`'s behaviour exactly (1025
/// parts > the shipped 1024 default → `413 UPLOAD_TOO_MANY_PARTS`), and leg 2 sends
/// the byte-identical request after a single PUT and gets a `200`.
///
/// Runs in BOTH builds: the part cap is mode-independent (DEC-5 — it bounds resident
/// per-part state and inodes, not file size, so the owner's file-size ruling does not
/// touch it).
///
/// Two guards against a vacuous pass:
/// * leg 0 asserts the row really is at the shipped 1024 default first, so leg 1
///   cannot be passing because some earlier test lowered it; and
/// * leg 3 lowers the cap BELOW the request and shows the same body refused again,
///   so leg 2's success is attributable to the setting and not to the cap having
///   quietly stopped being enforced at all.
#[tokio::test]
async fn test9_raising_the_part_setting_accepts_an_upload_the_default_refuses() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "parts", "parts@x.test").await;
    let token = login(&server, "parts").await;

    // Leg 0 — the row is at the shipped default, which equals the retired const.
    let settings = get_settings(&server, &admin).await;
    assert_eq!(
        settings["max_upload_parts"],
        json!(1024),
        "the seeded default equals the retired MAX_UPLOAD_PARTS const"
    );

    let boundary = "cyto-test-parts-boundary";
    let over = many_parts_body(boundary, 1025);

    // Leg 1 — 1025 parts against the 1024 default: the refusal `main` produces today.
    let (status, body) = post_raw_multipart(&server, &token, boundary, over.clone()).await;
    assert_eq!(status, 413, "1025 parts over the 1024 default is refused: {body}");
    assert_eq!(error_code(&body), "UPLOAD_TOO_MANY_PARTS", "named refusal: {body}");

    // Leg 2 — raise the setting; the IDENTICAL request now succeeds. No restart.
    put_settings(&server, &admin, json!({ "max_upload_parts": 2048 })).await;
    let (status, body) = post_raw_multipart(&server, &token, boundary, over.clone()).await;
    assert_eq!(
        status, 200,
        "the same 1025-part upload is accepted once the setting is raised: {body}"
    );

    // Leg 3 — lower it below the request: refused again. This is what makes leg 2
    // evidence of the SETTING taking effect rather than of the cap disappearing.
    put_settings(&server, &admin, json!({ "max_upload_parts": 16 })).await;
    let (status, body) = post_raw_multipart(&server, &token, boundary, over).await;
    assert_eq!(status, 413, "lowering the setting refuses the same body again: {body}");
    assert_eq!(error_code(&body), "UPLOAD_TOO_MANY_PARTS");
}

// ---------------------------------------------------------------------------
// TEST-1 [acceptance] [invariant: INV-2] — saas only
// ---------------------------------------------------------------------------

/// uncapped-uploads TEST-1 — the SaaS body ceiling is the CONFIGURED value, read at
/// use.
///
/// `413 UPLOAD_TOO_LARGE` is proven end to end against a value an admin PUT, which is
/// exactly #185 §1's acceptance criterion and the thing the 64 GiB constant could
/// never supply (you cannot put 64 GiB on the wire to observe it).
///
/// The over-ceiling body is deliberately only ~1.5 MiB: the refusal is written while
/// the rest of the body is still in flight, so a large overshoot races the server's
/// response against the client's remaining writes. At this size the whole request is
/// in the socket buffers before the response is read, which makes the 413 observable
/// rather than a connection reset.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test1_saas_ceiling_is_read_at_use_from_the_configured_value() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ceil", "ceil@x.test").await;
    let token = login(&server, "ceil").await;

    // The shipped default equals the retired 64 GiB const (INV-2 "defaulting high").
    let settings = get_settings(&server, &admin).await;
    assert_eq!(
        settings["max_upload_body_bytes"],
        json!(68_719_476_736i64),
        "the seeded default equals the retired UPLOAD_BODY_LIMIT const"
    );

    let payload = (1536 * 1024) as usize; // 1.5 MiB

    // Leg 1 — lower the ceiling to its 1 MiB floor; the 1.5 MiB upload is refused
    // BY NAME. Nothing about this value is compiled in anywhere.
    put_settings(&server, &admin, json!({ "max_upload_body_bytes": 1024 * 1024 })).await;
    let (status, body) = upload_bytes(&server, &token, payload, "over.bin").await;
    assert_eq!(status, 413, "1.5 MiB over a 1 MiB configured ceiling: {body}");
    assert_eq!(error_code(&body), "UPLOAD_TOO_LARGE", "named refusal: {body}");

    // Leg 2 — raise it back; the IDENTICAL upload succeeds, with no restart. This is
    // the read-at-use property: the old `DefaultBodyLimit::max(..)` layer baked its
    // value into the router at build time and could not have passed this.
    put_settings(&server, &admin, json!({ "max_upload_body_bytes": 68_719_476_736i64 })).await;
    let (status, body) = upload_bytes(&server, &token, payload, "under.bin").await;
    assert_eq!(status, 200, "the same upload is accepted once the ceiling is raised: {body}");
    assert_eq!(
        uploaded_file_size(&body),
        Some(payload as u64),
        "the bytes really transferred — the 200 is not a short-circuit: {body}"
    );
}

// ---------------------------------------------------------------------------
// TEST-2 [acceptance] [invariant: INV-1] — desktop only
// ---------------------------------------------------------------------------

/// uncapped-uploads TEST-2 — a desktop/self-hosted build has NO upload size ceiling,
/// even with the SaaS setting pinned at its lowest legal value.
///
/// This is the owner's ruling asserted directly — *"we should not limit file size,
/// that depends on user computer to process"*. The setting is driven to its 1 MiB
/// floor through the real admin API and an 8 MiB upload still succeeds: on a desktop
/// build there is nothing for that number to act on.
///
/// **The control is what makes it mean something.** "An 8 MiB upload succeeded" would
/// also be true of a build with a 64 GiB cap, so the same body is additionally run
/// through the REAL `UploadGuard` with a 1 MiB ceiling and must be refused. Same
/// bytes, same guard, ceiling present → refused; production desktop policy → accepted
/// over the wire. And the ceiling used for the desktop leg is the PRODUCTION
/// resolver's, not a hand-picked `None`, so a desktop build that grew a cap turns
/// this red.
#[cfg(not(feature = "saas"))]
#[tokio::test]
async fn test2_desktop_has_no_upload_size_ceiling() {
    use cytoanalyst::modules::dataset::upload_body_ceiling;
    use cytoanalyst::modules::workstore::settings::WorkstoreSettings;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "nocap", "nocap@x.test").await;
    let token = login(&server, "nocap").await;

    // Drive the SaaS knob to its floor. On a desktop build this must not bind.
    put_settings(&server, &admin, json!({ "max_upload_body_bytes": 1024 * 1024 })).await;

    let payload = (8 * MIB_BYTES) as usize;
    let (status, body) = upload_bytes(&server, &token, payload, "uncapped.bin").await;
    assert_eq!(
        status, 200,
        "8 MiB uploads on desktop with the ceiling setting at its 1 MiB floor: {body}"
    );
    assert_eq!(
        uploaded_file_size(&body),
        Some(payload as u64),
        "every byte landed — the 200 is not a short-circuit: {body}"
    );

    // The production resolver really returns "no ceiling" here, for EVERY input —
    // including a row an admin has driven to the floor.
    assert_eq!(
        upload_body_ceiling(&WorkstoreSettings::defaults()),
        None,
        "the desktop resolver imposes no ceiling"
    );
    let floored =
        WorkstoreSettings { max_upload_body_bytes: 1024 * 1024, ..WorkstoreSettings::defaults() };
    assert_eq!(
        upload_body_ceiling(&floored),
        None,
        "not even a floored settings row produces a desktop ceiling"
    );

    // THE CONTROL: the same body IS refused when a ceiling exists, so the leg above
    // is evidence of policy and not of a guard that stopped working.
    let boundary = "cyto-test-nocap-boundary";
    let mut same_body = Vec::new();
    same_body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"uncapped.bin\"\r\n\r\n"
        )
        .as_bytes(),
    );
    same_body.extend(std::iter::repeat(b'x').take(payload));
    same_body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let mut with_ceiling = UploadGuard::new(
        boundary,
        UploadLimits {
            max_body_bytes: Some(1024 * 1024),
            max_part_header_bytes: MAX_PART_HEADER_BYTES,
        },
    );
    assert_eq!(
        with_ceiling.consume(&same_body),
        Err(GuardRefusal::BodyCeiling),
        "control: the identical body IS refused when a ceiling is configured"
    );
}

// ---------------------------------------------------------------------------
// TEST-4 [acceptance] [invariant: INV-6]
// ---------------------------------------------------------------------------

/// uncapped-uploads TEST-4 — a part's multipart HEADER block is bounded, and the
/// bound holds without buffering the block.
///
/// This is the exposure `file/stream.rs` recorded and could not close: `multer`
/// accumulates a part's headers inside axum's extractor before `next_field()`
/// returns (`multer-3.1.0` `multipart.rs:370`, `buffer.rs:42`), so the body limit was
/// the only thing bounding a multi-GB `Content-Disposition`. Disabling the body limit
/// removes that, which is why the guard adds a header-level bound instead of merely
/// restating the problem (DEC-4 / INV-6).
///
/// Two legs, because they prove different halves:
///
/// * **the refusal** — a header block a few times over the cap is a NAMED
///   `413 UPLOAD_FIELD_TOO_LARGE`, observable because the body is small enough not to
///   race the response;
/// * **the memory** — a 512 MiB header block, which the pre-guard path would have
///   buffered whole, moves the server child's `VmHWM` by less than the same 64 MiB
///   constant #182 established. Here a transport error is an ACCEPTABLE outcome (the
///   server refuses at 64 KiB and hyper resets a connection with half a gigabyte
///   still in flight); the load-bearing assertions are the RSS bound and that the
///   server is still alive and serving afterwards.
#[tokio::test]
async fn test4_a_multipart_header_block_is_bounded_and_not_buffered() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "hdr", "hdr@x.test").await;
    let token = login(&server, "hdr").await;

    // This leg pushes ~512 MiB of body through THIS process, which would wreck the
    // in-process RSS measurements elsewhere in this binary. Taken as a POLLUTER, the
    // same way `upload_streaming_test`'s wire test takes it.
    let _rss_lock = rss_measurement_guard().await;

    let boundary = "cyto-test-hdr-boundary";

    // --- leg 1: the named refusal ------------------------------------------------
    // 4x the cap: over it by a wide margin, small enough that the whole request is
    // written before the response is read.
    let overlong = "A".repeat(4 * MAX_PART_HEADER_BYTES);
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"{overlong}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"payload\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, json) = post_raw_multipart(&server, &token, boundary, body).await;
    assert_eq!(status, 413, "an over-cap header block is refused: {json}");
    assert_eq!(
        error_code(&json),
        "UPLOAD_FIELD_TOO_LARGE",
        "a part's headers are part of a field — no new error code: {json}"
    );

    // --- leg 2: the memory bound -------------------------------------------------
    let pid = server_child_pid(server.data_dir());
    assert_no_headroom(pid, "before the 512 MiB header attack");
    let baseline = peak_rss_kib(pid);

    // A header line built as a STREAM so the test process does not hold 512 MiB
    // either — a client-side allocation would otherwise mask the server-side one this
    // leg exists to detect.
    const CHUNK: usize = 1024 * 1024;
    const HEADER_MIB: usize = 512;
    let prefix = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
    );
    let stream = futures_util::stream::iter(
        std::iter::once(Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(
            prefix.into_bytes(),
        )))
        .chain((0..HEADER_MIB).map(|_| {
            Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(vec![b'B'; CHUNK]))
        })),
    );
    let attack = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await;

    // Two outcomes are legitimate, and BOTH are asserted rather than one being a
    // silent escape hatch. The guard refuses while the rest of the body is still in
    // flight, so hyper may close the connection before the client reads the response
    // — a transport error is the expected shape of that race, not a failure. What is
    // NOT acceptable is a 200 (the block was accepted), a 500 (it blew up rather than
    // refusing), or a transport error of some UNRELATED kind such as a timeout, which
    // would mean the server hung rather than refused. An earlier version wrapped this
    // in `if let Ok(..)` and asserted nothing at all on the error path.
    match attack {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let json: Value = resp.json().await.unwrap_or(Value::Null);
            assert_eq!(status, 413, "a response that arrives is the named 413: {json}");
            assert_eq!(error_code(&json), "UPLOAD_FIELD_TOO_LARGE");
        }
        Err(e) => {
            assert!(
                !e.is_timeout(),
                "a timeout means the server HUNG on the oversized header block rather \
                 than refusing it — the opposite of the property under test: {e}"
            );
            assert!(
                e.is_request() || e.is_body() || e.is_connect(),
                "the only acceptable error here is the connection being closed as the \
                 server refuses mid-stream, not {e:?}: {e}"
            );
        }
    }

    let after = peak_rss_kib(pid);
    let growth = after.saturating_sub(baseline);
    assert!(
        growth < RSS_BOUND_KIB,
        "a {HEADER_MIB} MiB multipart header block moved the server child's peak RSS \
         by {growth} KiB (bound {RSS_BOUND_KIB} KiB). Before the guard, multer would \
         have accumulated the whole block inside axum's extractor — this is the \
         measurement that catches that, and a functional 413 test would not."
    );

    // ...and the server is still alive and serving, so "bounded" did not mean "died".
    let (status, json) = upload_bytes(&server, &token, 64 * 1024, "after-attack.bin").await;
    assert_eq!(status, 200, "the server still serves a normal upload afterwards: {json}");
}

// ---------------------------------------------------------------------------
// TEST-5 [acceptance] [invariant: INV-5]
// ---------------------------------------------------------------------------

/// The same headroom control `upload_streaming_test` uses, restated here so this
/// file's bounds are not vacuous either. `VmHWM` is monotonic, so a growth bound
/// discriminates nothing if the mark already sits far above the live footprint.
fn assert_no_headroom(pid: u32, when: &str) {
    let (peak, live) = peak_and_current_rss_kib(pid);
    let headroom = peak.saturating_sub(live);
    assert!(
        headroom < 32 * MIB,
        "CONTROL FAILED {when}: the server child's high-water mark ({peak} KiB) sits \
         {headroom} KiB above its live RSS ({live} KiB), so an allocation of up to \
         that size would not move VmHWM and the bounds below would be vacuous."
    );
}

/// uncapped-uploads TEST-5 — removing the body limit did not reintroduce buffering.
///
/// This is the re-measurement the ruling asks for: #182 made peak RSS flat
/// (64 MiB → +3,552 KiB, 256 MiB → +5,580 KiB against a 65,536 KiB bound), and a
/// functional test would stay green through a regression that undid it. The upload
/// path has changed underneath — `DefaultBodyLimit::disable()` plus a guard that now
/// wraps every body — so the measurement is re-run against the SAME absolute bound
/// rather than assumed to still hold.
///
/// Three things keep it from passing vacuously:
/// * the headroom control is re-checked before every delta, so a leg that allocated
///   fails at the leg that created the headroom rather than passing at the next one;
/// * the two legs (64 MiB and 256 MiB) are held to the same ABSOLUTE bound, so a peak
///   that merely scaled more gently with the file still fails; and
/// * a positive control allocates 256 MiB and asserts the probe apparatus actually
///   observes it — without that, "nothing grew" and "nothing was watched" look alike.
#[tokio::test]
async fn test5_peak_rss_stays_bounded_with_the_body_limit_removed() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "rsslimit", "rsslimit@x.test").await;
    let token = login(&server, "rsslimit").await;

    let _rss_lock = rss_measurement_guard().await;

    // ---- CONTROLS -----------------------------------------------------------
    //
    // Two are needed, because this test's bounds read `VmHWM` of the SERVER CHILD
    // while the obvious control allocates in the TEST process. Those are different
    // processes AND different /proc fields (`VmHWM` vs `VmRSS`, see rss_probe.rs's
    // module doc), so one control cannot cover both. An earlier draft ran only
    // control A and presented it as validating the child probe — it did not.
    //
    // Note why control A cannot simply be moved onto the measured child: `VmHWM` is
    // the monotonic high-water mark since exec, so deliberately making the measured
    // server allocate 256 MiB would raise its watermark permanently and every
    // `saturating_sub` delta below would then read 0 — a vacuous pass. The control
    // must not touch the process under measurement.

    // Control A — the /proc parsing and the KiB arithmetic really do resolve a
    // 256 MiB resident allocation. Scoped to the TEST process, which is what
    // `RssPoller` observes.
    let poller = RssPoller::start();
    {
        let mut hog: Vec<u8> = vec![0u8; 256 * MIB_BYTES as usize];
        // Touch every page so the allocation is resident, not just reserved.
        for i in (0..hog.len()).step_by(4096) {
            hog[i] = 1;
        }
        std::hint::black_box(&hog);
    }
    let control_growth = poller.growth_kib();
    assert!(
        control_growth > 200 * MIB,
        "POSITIVE CONTROL A FAILED: allocating 256 MiB moved the polled in-process RSS \
         by only {control_growth} KiB, so the /proc probe cannot resolve an allocation \
         at the scale the bounds below are meant to catch."
    );

    let pid = server_child_pid(server.data_dir());

    // Control B — the CHILD probe is live and is reading the child, not us. A real
    // API process that has booted, opened a pool and served requests is tens of MiB
    // resident; a `VmHWM` of 0 (or one equal to this test binary's own) would mean
    // `server_child_pid`/`peak_rss_kib` is pointed at the wrong thing, and every
    // `growth < BOUND` assertion below would pass vacuously.
    let self_hwm = peak_rss_kib(std::process::id());
    let child_hwm_at_start = peak_rss_kib(pid);
    assert!(
        child_hwm_at_start > 8 * MIB,
        "POSITIVE CONTROL B FAILED: the server child's VmHWM reads {child_hwm_at_start} KiB, \
         which is too small to be a booted API process — the child probe is not observing \
         the server, so the bounds below would pass vacuously."
    );
    assert_ne!(
        child_hwm_at_start, self_hwm,
        "POSITIVE CONTROL B FAILED: the child VmHWM equals this test process's own \
         ({self_hwm} KiB) — the probe is reading the wrong pid."
    );

    let baseline = child_hwm_at_start;
    assert_no_headroom(pid, "at the baseline, before any upload");

    // 64 MiB leg.
    let small = (64 * MIB_BYTES) as usize;
    let (status, body) = upload_bytes(&server, &token, small, "rss-small.bin").await;
    assert_eq!(status, 200, "64 MiB upload: {body}");
    assert_eq!(uploaded_file_size(&body), Some(small as u64));
    let after_small = peak_rss_kib(pid);
    let small_growth = after_small.saturating_sub(baseline);
    assert!(
        small_growth < RSS_BOUND_KIB,
        "64 MiB upload moved peak RSS by {small_growth} KiB (bound {RSS_BOUND_KIB} KiB)"
    );
    assert_no_headroom(pid, "after the 64 MiB upload");

    // 256 MiB leg, held to the SAME absolute bound.
    let big = (256 * MIB_BYTES) as usize;
    let (status, body) = upload_bytes(&server, &token, big, "rss-big.bin").await;
    assert_eq!(status, 200, "256 MiB upload: {body}");
    assert_eq!(uploaded_file_size(&body), Some(big as u64));
    let after_big = peak_rss_kib(pid);
    let big_growth = after_big.saturating_sub(after_small);
    assert!(
        big_growth < RSS_BOUND_KIB,
        "256 MiB upload moved peak RSS by {big_growth} KiB (bound {RSS_BOUND_KIB} KiB) — \
         4x the payload of the previous leg for a peak held to the same constant is the \
         property; a regression that re-buffered would miss this by a wide margin"
    );
    assert_no_headroom(pid, "after the 256 MiB upload");

    eprintln!(
        "uncapped-uploads TEST-5 VmHWM(server child): baseline {baseline} KiB, \
         64 MiB leg +{small_growth} KiB, 256 MiB leg +{big_growth} KiB, \
         bound {RSS_BOUND_KIB} KiB; control A (in-process, 256 MiB alloc) \
         +{control_growth} KiB; control B child VmHWM at start {child_hwm_at_start} KiB \
         vs test process {self_hwm} KiB"
    );
}
