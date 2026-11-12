//! #182 — the upload path must not hold a file in server RAM.
//!
//! These are the acceptance tests for the four invariants in
//! `.lifecycle/streaming-upload/PLAN.md`. Three of them are MEASUREMENTS of a real
//! process's resident memory, because the defect they close was produced by
//! arithmetic over the types on the path that nobody ever checked against a running
//! server (see `docs/research/spatial-upload-path-verification.md` §7: "the RAM
//! figures in §2 are arithmetic over the types on the path, not a measured RSS").
//!
//! TEST-1  INV-1  a 256 MiB upload leaves the API process's PEAK RSS bounded
//! TEST-2  INV-2  staging a 256 MiB stored blob is likewise bounded (+ positive control)
//! TEST-3  INV-5  bytes, `files.checksum` and the dataset `content_hash` are unchanged
//! TEST-4  INV-3  an over-ceiling body is a NAMED 413, on a process that is still alive

use reqwest::multipart::{Form, Part};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::rss_probe::{peak_and_current_rss_kib, peak_rss_kib, server_child_pid, RssPoller, MIB};
use super::{create_user, login, setup_admin};
use crate::common::TestServer;

const MIB_BYTES: u64 = 1024 * 1024;

/// The bound every RSS assertion here is held to. It is an ABSOLUTE number, not a
/// fraction of the payload — "bounded by a constant rather than by the file size"
/// is the invariant, so a bound that scaled with the file would assert nothing.
const RSS_BOUND_KIB: u64 = 64 * MIB;

/// The payload the RSS tests move. 4× the bound: large enough that the pre-fix path
/// (which allocated ≥1× the file as `Bytes` and then a second `Vec<u8>` copy) misses
/// the bound by a wide margin, small enough to be safe on a modest box.
const BIG_BYTES: u64 = 256 * MIB_BYTES;

/// A smaller leg, measured against the SAME absolute bound. Two sizes are what
/// distinguish "peak is bounded by a constant" from "peak is a smaller multiple of
/// the file" — one data point cannot tell those apart.
const SMALL_BYTES: u64 = 64 * MIB_BYTES;

/// Deterministic filler. Generated a chunk at a time and never held whole, so the
/// TEST process is bounded too (this box has ~3 GB of RAM).
fn filler_byte(i: u64) -> u8 {
    (i % 251) as u8
}

/// A multipart part whose body is GENERATED as it is sent — the client never
/// buffers the payload, so a client-side allocation cannot mask a server-side one.
fn generated_part(len: u64, filename: &str) -> Part {
    const CHUNK: u64 = 1024 * 1024;
    let n = len.div_ceil(CHUNK);
    let stream = futures_util::stream::iter((0..n).map(move |i| {
        let start = i * CHUNK;
        let this = CHUNK.min(len - start);
        let buf: Vec<u8> = (0..this).map(|k| filler_byte(start + k)).collect();
        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(buf))
    }));
    Part::stream_with_length(reqwest::Body::wrap_stream(stream), len)
        .file_name(filename.to_string())
}

async fn upload_generated(server: &TestServer, token: &str, len: u64, filename: &str) -> Value {
    let form = Form::new().part("file", generated_part(len, filename));
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
    assert_eq!(
        status, 200,
        "a generated {len}-byte upload succeeds: {body}"
    );
    body
}

/// Serializes the tests that measure THIS process's resident memory.
///
/// The suite is meant to run with several test threads (`just test THREADS="4"`),
/// and three tests here deliberately allocate 256 MiB as a positive control. Without
/// this lock two of them can overlap, which both inflates a streaming leg's measured
/// growth (a spurious failure) and lets a control pass on a sibling's allocation (a
/// vacuous pass) — i.e. the parallelism defeats the very control that makes the
/// measurement meaningful.
///
/// **Who takes it, and why each one does.** The three in-process measurements
/// (`staging_a_stored_blob_does_not_rebuffer_it`,
/// `the_production_staging_function_does_not_rebuffer`,
/// `sniffing_a_large_part_reads_a_bounded_head`) take it as MEASURERS.
/// `upload_peak_rss_is_bounded_by_a_constant_not_by_file_size` takes it as a
/// POLLUTER — it measures its server child, not this process, but it pushes ~700 MiB
/// of generated body through here, and a lock only the measurers took would be
/// defeated by its own file. `double_ingest_is_a_typed_error_not_a_panic` takes it
/// because it calls `init_file_storage`, which overwrites the process-global store
/// the measurements resolve their blobs through. The three small tests that neither
/// measure, allocate at scale, nor touch that global do not take it.
///
/// **Honest scope:** this serializes the tests in this file. The integration binary
/// aggregates every module's tests and the others still run concurrently — they
/// allocate at KiB-to-MiB scale, three orders below the 64 MiB bound and the 200 MiB
/// controls, so they cannot flip either verdict; but this is a mutex over the known
/// large allocators, not process-wide isolation.
static RSS_MEASUREMENT_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

/// A `tokio` mutex, not a `std` one: these guards are held across `.await` points by
/// construction (the region being protected IS async work), and a blocking
/// `std::sync::MutexGuard` there is both `!Send` — so it silently forbids
/// `flavor = "multi_thread"` on any test that takes it — and able to stall the
/// runtime thread of a waiting test.
// #185 §1: `pub(crate)` so `upload_limits_test`'s large-allocation legs take the SAME
// lock. A second lock would not serialize them against these, which is the whole
// point — a sibling's 256 MiB allocation both inflates a streaming leg's measured
// growth and lets a positive control pass on it.
pub(crate) async fn rss_measurement_guard() -> tokio::sync::MutexGuard<'static, ()> {
    RSS_MEASUREMENT_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// The control that makes a bound on `VmHWM` GROWTH mean anything.
///
/// `VmHWM` is monotonic, so a growth bound discriminates nothing if the mark is
/// already sitting far above the process's live footprint: a re-buffering regression
/// could allocate hundreds of MiB into that headroom and move the mark barely at all.
/// Asserting there is no headroom makes "the mark did not grow" equivalent to "the
/// process did not allocate", to within the slack below.
///
/// It is re-checked before EVERY delta, not only at the baseline, because each leg's
/// delta is measured from the previous leg's mark — and under the very regression
/// these tests target, an earlier leg's 256 MiB peak IS the headroom the next leg
/// would hide in. Re-checking turns that into a loud failure at the leg that created
/// it instead of a silent pass at the leg that inherits it.
///
/// The slack (32 MiB) is not zero: a live server has transient allocations. So the
/// property is "any allocation moves the mark by ~N, to within 32 MiB", not "exactly
/// N". Against the 64 MiB bound that leaves a worst case of ~96 MiB that these
/// assertions could not distinguish — **under 3x below the 256 MiB the tests move**,
/// which is a real margin but a narrow one, not the comfortable one an earlier
/// version of this comment claimed. It is what makes a FULL re-buffering regression
/// unmissable; it would not catch one that re-buffered only a third of the file.
fn assert_no_headroom(pid: u32, when: &str) {
    let (peak, live) = peak_and_current_rss_kib(pid);
    let headroom = peak.saturating_sub(live);
    assert!(
        headroom < 32 * MIB,
        "CONTROL FAILED {when}: the server child's high-water mark ({peak} KiB) sits \
         {headroom} KiB above its live RSS ({live} KiB), so an allocation of up to \
         that size would not move VmHWM and the bounds below would be vacuous. If \
         this fires right after a leg, that leg ALLOCATED — which is the regression \
         these tests exist to catch. Do NOT relax the bound to get past it."
    );
}

fn sha256_hex_of(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

// ---------------------------------------------------------------------------
// TEST-1 [acceptance] [invariant: INV-1]
// ---------------------------------------------------------------------------

/// TEST-1 — the API process's PEAK resident memory over a 256 MiB upload stays
/// under a 64 MiB constant.
///
/// `VmHWM` is the kernel's high-water mark for the server CHILD process (the
/// harness runs the API as a real subprocess), so this is the API's own memory,
/// measured, with the client's contribution structurally excluded — and it cannot
/// miss the peak, because it is not polled.
///
/// The pre-fix path could not pass this: `field.bytes()` materialized the whole
/// part and `.to_vec()` copied it again, so the same upload moved `VmHWM` by at
/// least the file size.
///
/// Two guards against a vacuous pass:
/// * the response must report a `file_size` of exactly 256 MiB and a `content_hash`,
///   so the bound cannot be met by not transferring the bytes; and
/// * the SAME absolute bound is asserted for a 64 MiB and a 256 MiB upload, so a
///   peak that merely scaled more gently with the file would still fail.
#[tokio::test]
async fn upload_peak_rss_is_bounded_by_a_constant_not_by_file_size() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "rss", "rss@x.test").await;
    let token = login(&server, "rss").await;

    // This test does not MEASURE this process — it measures its server child — but it
    // pushes ~700 MiB of generated body through this process, which would wreck the
    // in-process measurements the other three make. It takes the lock as a POLLUTER,
    // not as a measurer; a lock that only the measurers took would be defeated by
    // exactly this test.
    let _rss_lock = rss_measurement_guard().await;

    let pid = server_child_pid(server.data_dir());
    // Baseline AFTER boot + setup + login, so the delta is upload-attributable.
    let baseline = peak_rss_kib(pid);

    // --- THE CONTROL that makes every bound below non-vacuous --------------------
    //
    // `VmHWM` is monotonic. If the server child's boot peak already sat far ABOVE
    // its steady state — plausible for a process that runs migrations and warms a
    // pool — then a full re-buffering regression could allocate 256 MiB and still
    // raise the mark by only a few MiB, and every assertion below would pass while
    // the invariant was violated. A liveness check ("the mark moved at all") does not
    // close that: it fires at 4 KiB, four orders below the failure scale.
    //
    // What closes it is asserting the mark is not ALREADY stuck high: if `VmHWM` is
    // within a small slack of the CURRENT `VmRSS`, then there is no hidden headroom,
    // and any later allocation of N bytes must move `VmHWM` by ~N. That is a
    // deterministic property of the probe's starting state, checkable from here,
    // and it is what makes the 64 MiB bound mean "peak did not grow" rather than
    // "peak was already big".
    assert_no_headroom(pid, "at the baseline, before any upload");

    let small = upload_generated(&server, &token, SMALL_BYTES, "small.bin").await;
    let after_small = peak_rss_kib(pid);
    assert_no_headroom(pid, "after the 64 MiB single-part upload");

    let big = upload_generated(&server, &token, BIG_BYTES, "big.bin").await;
    let after_big = peak_rss_kib(pid);
    assert_no_headroom(pid, "after the 256 MiB single-part upload");

    // A MULTI-PART leg: the fix holds every part of a request live (as a temp-file
    // handle) until the last group is ingested, so peak RSS is O(number of parts).
    // #182's motivating case is a multi-FILE vendor bundle, and a one-part
    // measurement cannot see that term at all.
    // The parts total MORE than the largest single upload so far, because `VmHWM` is
    // monotonic: a leg that moved less than the 256 MiB leg could never raise the
    // mark and would assert nothing. 12 x 32 MiB = 384 MiB > 256 MiB.
    //
    // **What this leg discriminates, exactly.** It catches a regression that holds
    // parts CONCURRENTLY — which is the shape this code actually has, since every
    // part is held (as a temp-file handle) until the last group is ingested. It does
    // NOT catch a per-part buffer that is materialized and freed one part at a time;
    // that peaks at 32 MiB here and is caught by the single-part leg above instead.
    // Between the two legs the O(1)-per-part and O(N)-parts shapes are both covered;
    // neither leg covers both, and claiming otherwise would be the overclaim this
    // file keeps having to correct.
    let parts = 12u64;
    let per_part = 32 * MIB_BYTES;
    assert!(
        parts * per_part > BIG_BYTES,
        "the multi-part leg must exceed the single-part leg or it cannot fail"
    );
    let mut form = Form::new();
    for i in 0..parts {
        form = form.part("file", generated_part(per_part, &format!("part-{i}.bin")));
    }
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("multi-part upload");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "a {parts}-part upload succeeds"
    );
    let multi: Value = resp.json().await.expect("multi-part json");
    assert_eq!(
        multi["datasets"].as_array().map(|d| d.len()),
        Some(parts as usize),
        "each part became its own dataset (the default one-per-file plan): {multi}"
    );
    let after_multi = peak_rss_kib(pid);
    assert_no_headroom(pid, "after the 12-part upload");
    let growth_multi = after_multi.saturating_sub(after_big);
    assert!(
        growth_multi < RSS_BOUND_KIB,
        "INV-1: {parts} parts totalling {} MiB in ONE request must not cost the peak \
         a further {} KiB (bound {} KiB). This total EXCEEDS the largest single-part \
         leg, so a per-part whole-file buffer has to raise the monotonic high-water \
         mark here — it is the only leg that can see the CONCURRENT O(number-of-parts) \
         term.",
        parts * per_part / MIB_BYTES,
        growth_multi,
        RSS_BOUND_KIB
    );

    // --- the bytes really moved (non-vacuity) ---------------------------------
    for (body, expected) in [(&small, SMALL_BYTES), (&big, BIG_BYTES)] {
        let ds = &body["datasets"][0];
        assert_eq!(
            ds["files"][0]["file_size"].as_u64(),
            Some(expected),
            "the server stored the whole payload, so the RSS bound is not met by \
             dropping the body: {body}"
        );
        assert!(
            ds["content_hash"]
                .as_str()
                .is_some_and(|h| h.starts_with("sha256:")),
            "the stored file was hashed end-to-end: {body}"
        );
    }

    // --- the invariant --------------------------------------------------------
    let growth_small = after_small.saturating_sub(baseline);
    let growth_big = after_big.saturating_sub(baseline);
    let growth_from_small_to_big = after_big.saturating_sub(after_small);

    eprintln!(
        "TEST-1 measured VmHWM (KiB): baseline={baseline} after_{small_mib}MiB={after_small} \
         after_{big_mib}MiB={after_big} (bound {RSS_BOUND_KIB})",
        small_mib = SMALL_BYTES / MIB_BYTES,
        big_mib = BIG_BYTES / MIB_BYTES,
    );

    assert!(
        growth_big < RSS_BOUND_KIB,
        "INV-1: peak API-process RSS must be bounded by a constant, not by the file \
         size. Uploading {} MiB grew VmHWM by {} KiB, over the {} KiB bound \
         (baseline {} KiB → {} KiB).",
        BIG_BYTES / MIB_BYTES,
        growth_big,
        RSS_BOUND_KIB,
        baseline,
        after_big
    );
    assert!(
        growth_from_small_to_big < RSS_BOUND_KIB,
        "INV-1: a 4x larger file must not buy 4x the peak. {} MiB → {} MiB grew \
         VmHWM by a further {} KiB.",
        SMALL_BYTES / MIB_BYTES,
        BIG_BYTES / MIB_BYTES,
        growth_from_small_to_big
    );
    assert!(
        growth_small < RSS_BOUND_KIB,
        "INV-1: even the {} MiB leg must stay under the bound; grew {} KiB",
        SMALL_BYTES / MIB_BYTES,
        growth_small
    );

    // The headroom control proves the mark COULD move; this proves it DID. Kept
    // alongside rather than instead: without it, a probe reading a frozen VmHWM (a
    // wrong pid, a dead process) would satisfy every bound above at zero growth.
    assert!(
        growth_big >= MIB,
        "the uploads must move the server's high-water mark at all — VmHWM went \
         {baseline} -> {after_big} KiB across a {} MiB upload, which reads like a \
         frozen or wrong measurement rather than a cheap one.",
        BIG_BYTES / MIB_BYTES
    );
}

// ---------------------------------------------------------------------------
// TEST-2 [acceptance] [invariant: INV-2]
// ---------------------------------------------------------------------------

/// TEST-2 — staging a stored blob as a sandbox input does not re-buffer it.
///
/// Drives `modules::file::stream::copy_original_streaming`, which is EXACTLY the
/// function `sandbox::inputs::stage_dataset_file` now calls (that handler needs a
/// job, a pool and an authorized dataset; the memory question is entirely in this
/// call, so it is driven directly rather than through a sandbox run).
///
/// The measurement is of THIS process, which is a shared test binary, so `VmHWM` is
/// unusable (a previous test's peak makes every later delta read as zero). It
/// therefore polls `VmRSS` — and carries a **positive control**: the same blob is
/// also copied through the OLD shape (`load_original` → `Vec<u8>` → write) and the
/// control must exceed the bound. If the probe could not see a whole-file
/// allocation, the control fails and this test fails, so the streaming assertion
/// can never pass for the wrong reason.
///
/// Order matters: the streaming leg runs FIRST, so the control's 256 MiB allocation
/// cannot inflate the streaming leg's baseline and flatter it.
///
/// **Scope caveat, now that `the_production_staging_function_does_not_rebuffer`
/// exists:** this measures the shared test binary, so under several test threads a
/// sibling's allocations land in the same window. That is why the load-bearing INV-2
/// proof is TEST-10 (which measures the production function) and this is kept as the
/// function-level bound plus the digest-equality check.
#[tokio::test]
async fn staging_a_stored_blob_does_not_rebuffer_it() {
    let _rss_lock = rss_measurement_guard().await;
    let dir = std::env::temp_dir().join(format!("txr-182-stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = txresbench_file::init_file_storage(&dir);

    let user = uuid::Uuid::new_v4();
    let blob = uuid::Uuid::new_v4();
    let ext = "bin";

    // Write the blob directly at the store's deterministic path, a chunk at a time
    // (so seeding the fixture does not itself allocate 256 MiB).
    let src = storage.get_original_path(user, blob, ext);
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    let mut expected = Sha256::new();
    {
        use std::io::Write;
        let mut f = std::io::BufWriter::new(std::fs::File::create(&src).unwrap());
        let chunk = MIB_BYTES;
        let mut written = 0u64;
        while written < BIG_BYTES {
            let this = chunk.min(BIG_BYTES - written);
            let buf: Vec<u8> = (0..this).map(|k| filler_byte(written + k)).collect();
            expected.update(&buf);
            f.write_all(&buf).unwrap();
            written += this;
        }
        f.flush().unwrap();
    }
    let expected_hash = format!("sha256:{}", hex::encode(expected.finalize()));

    // --- the invariant: the streaming stage ----------------------------------
    let streamed_dest = dir.join("staged-streaming.bin");
    let poller = RssPoller::start();
    let streamed_hash = txresbench::modules::file::stream::copy_original_streaming(
        user,
        blob,
        ext,
        &streamed_dest,
    )
    .await
    .expect("streaming stage succeeds");
    let streaming_growth = poller.growth_kib();

    assert_eq!(
        streamed_hash, expected_hash,
        "the streamed digest is the SAME sha256 as a one-shot hash of the same bytes"
    );
    assert_eq!(
        std::fs::metadata(&streamed_dest).unwrap().len(),
        BIG_BYTES,
        "the whole blob was staged (non-vacuity: the bound is not met by copying nothing)"
    );

    // --- the positive control: the shape this replaced -----------------------
    let control_dest = dir.join("staged-buffered.bin");
    let control_poller = RssPoller::start();
    {
        let bytes = storage
            .load_original(user, blob, ext)
            .await
            .expect("load_original succeeds");
        let control_hash = format!("sha256:{}", sha256_hex_of(&bytes));
        assert_eq!(control_hash, expected_hash, "control reads the same blob");
        std::fs::write(&control_dest, &bytes).unwrap();
    }
    let control_growth = control_poller.growth_kib();

    eprintln!(
        "TEST-2 measured VmRSS growth (KiB): streaming={streaming_growth} \
         buffered_control={control_growth} (bound {RSS_BOUND_KIB})"
    );

    assert!(
        control_growth > 200 * MIB,
        "POSITIVE CONTROL FAILED: the old `load_original` -> Vec<u8> shape allocated \
         {} MiB and the probe saw only {} KiB of growth. The measurement apparatus \
         cannot see a whole-file allocation, so the streaming assertion below would \
         be vacuous. Do not weaken this — fix the probe.",
        BIG_BYTES / MIB_BYTES,
        control_growth
    );
    assert!(
        streaming_growth < RSS_BOUND_KIB,
        "INV-2: staging must not re-buffer the file. Staging {} MiB grew peak RSS by \
         {} KiB, over the {} KiB bound (the buffered control grew {} KiB).",
        BIG_BYTES / MIB_BYTES,
        streaming_growth,
        RSS_BOUND_KIB,
        control_growth
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// TEST-3 [acceptance] [invariant: INV-5]
// ---------------------------------------------------------------------------

/// The regression fixture: 65 536 bytes of `i % 251`.
fn regression_payload() -> Vec<u8> {
    (0..65536u64).map(filler_byte).collect()
}

/// sha256 of [`regression_payload`], computed INDEPENDENTLY of this codebase
/// (`python3 -c "hashlib.sha256(bytes([(i%251) for i in range(65536)])).hexdigest()"`).
/// Pinning it here is what makes TEST-3 a regression test rather than a tautology:
/// it does not ask "does the server agree with itself", it asks "does the server
/// still produce THIS value".
const REGRESSION_SHA256_HEX: &str =
    "4b640d85ab3ba30fd02c9fc9db4a8928f416322ad27022ea58a65aaee68a4df2";

/// TEST-3 — an ordinary upload is byte-identical, and so is every hash derived
/// from it.
///
/// A changed content hash would silently orphan every existing artifact reference,
/// so all three links in the chain are asserted against independently-known values:
///
/// 1. the bytes read back from the download route equal the bytes sent;
/// 2. `files.checksum` equals the sha256 computed outside this codebase; and
/// 3. the dataset `content_hash` equals `sha256:<that checksum>` — the single-file
///    case of `dataset_content_hash`, which is the input every multi-file merkle is
///    built from, so an unchanged checksum is exactly what keeps merkles unchanged.
#[tokio::test]
async fn ordinary_upload_bytes_and_hashes_are_unchanged() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "reg", "reg@x.test").await;
    let token = login(&server, "reg").await;

    let payload = regression_payload();
    assert_eq!(
        sha256_hex_of(&payload),
        REGRESSION_SHA256_HEX,
        "the fixture itself is the one the pinned digest was computed from"
    );

    // A DOTFILE, and specifically `.csv`, because the assertion below has to
    // discriminate the actual expression rather than merely be non-default:
    //   * `.bin` fails to discriminate at all — every mutation yields the universal
    //     `application/octet-stream`;
    //   * `regression.csv` fails to discriminate the two interesting mutations —
    //     `Path::extension` and `from_path` both also yield `text/csv`;
    //   * `.csv` separates them, and it is the case the SDK's own comment calls out:
    //     `extension_of` is `rsplit('.')`, so it reads "csv", while
    //     `Path::new(".csv").extension()` is None and `from_path(".csv")` guesses
    //     nothing. `extension_of` also derives the BLOB KEY, so a silent swap there
    //     would mis-key every stored file — which is why this is the fixture.
    let form = Form::new().part("file", Part::bytes(payload.clone()).file_name(".csv"));
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("upload");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("upload json");
    let ds = &body["datasets"][0];
    let file_id = ds["files"][0]["file_id"].as_str().expect("file id");

    // (1) the stored bytes
    let dl = server
        .client
        .get(server.api_url(&format!("/files/{file_id}/download")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("download");
    assert_eq!(dl.status().as_u16(), 200, "the uploaded file downloads");
    let round_tripped = dl.bytes().await.expect("download body").to_vec();
    assert_eq!(
        round_tripped, payload,
        "the streamed upload stored the bytes verbatim"
    );

    // (2) files.checksum
    let meta: Value = server
        .client
        .get(server.api_url(&format!("/files/{file_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("file meta")
        .json()
        .await
        .expect("file meta json");
    assert_eq!(
        meta["checksum"].as_str(),
        Some(REGRESSION_SHA256_HEX),
        "files.checksum is the SAME sha256 the pre-streaming path wrote: {meta}"
    );
    assert_eq!(
        meta["file_size"].as_u64(),
        Some(payload.len() as u64),
        "files.file_size is unchanged"
    );
    // Every OTHER column `ingest_staged` now writes with its own expression instead
    // of through the SDK's `store_processed`. `mime_type` is the one the new
    // `mime_guess` dependency exists to keep identical — it is client-visible on
    // `GET /files/{id}` — and the three derivative counters are what the
    // no-derivative contract promises. Without these, a divergence in the
    // `mime_guess::from_ext(&extension_of(filename))` expression would turn no test
    // red, which is exactly the byte-identity claim INV-5 makes.
    assert_eq!(
        meta["mime_type"].as_str(),
        Some("text/csv"),
        "files.mime_type is derived by the SAME expression `ingest_bytes` used \
         (`mime_guess::from_ext(&extension_of(filename))`). For a DOTFILE this value \
         is produced by that expression and by no plausible substitute for it — \
         `Path::extension` and `from_path` both yield None here: {meta}"
    );
    assert_eq!(meta["has_thumbnail"].as_bool(), Some(false));
    assert_eq!(meta["preview_page_count"].as_u64(), Some(0));
    assert_eq!(meta["text_page_count"].as_u64(), Some(0));
    assert_eq!(
        meta["processing_metadata"],
        serde_json::json!({}),
        "the no-derivative contract writes the default ProcessingMetadata: {meta}"
    );

    // (3) the dataset content_hash the merkle is built from
    assert_eq!(
        ds["content_hash"].as_str(),
        Some(format!("sha256:{REGRESSION_SHA256_HEX}").as_str()),
        "the dataset content_hash is unchanged — an artifact reference keyed on it \
         still resolves: {body}"
    );
}

// ---------------------------------------------------------------------------
// TEST-4 [acceptance] [invariant: INV-3]
// ---------------------------------------------------------------------------

/// TEST-4 — an over-ceiling body is refused with a NAMED 413, and the process
/// serving it survives to answer the next request.
///
/// This drives a real `axum` router carrying a real `DefaultBodyLimit` and the real
/// production error mapping (`modules::file::stream::multipart_error`) over a real
/// over-limit multipart body, via `ServiceExt::oneshot` — the same technique the
/// harness-sentinel test uses to assert a route's behaviour without a port bind.
///
/// **Honest limit.** The production route's own BODY ceiling is the 64 GiB
/// `UPLOAD_BODY_LIMIT`, and sending 64 GiB to observe it is not feasible; axum's
/// limit is byte-driven (`http_body_util::Limited` counts frames, it does not
/// short-circuit on `Content-Length`), so there is no way to trip that constant
/// cheaply. This test therefore proves the MAPPING against a real `DefaultBodyLimit`
/// on a small limit. The other reachable ceiling — the per-field cap — IS driven
/// over the real route, by `over_ceiling_field_on_the_real_route_is_a_named_413`
/// below, so INV-3's "an over-ceiling upload produces a named refusal" is not left
/// resting on a synthetic router alone. Making the 64 GiB constant itself
/// end-to-end testable is one of the reasons DEC-7 files the settings-row promotion.
#[tokio::test]
async fn over_ceiling_upload_is_a_named_413_and_the_service_survives() {
    use axum::extract::{DefaultBodyLimit, Multipart};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use tower::ServiceExt;

    // Staging writes under `data_root()`; without this the test would create
    // `<the developer's real app-data dir>/tmp-uploads` and write parts into it.
    // `scoped_data_root` is thread-scoped and `#[tokio::test]` is single-threaded,
    // so the override covers everything this test drives and nothing else.
    let scratch = std::env::temp_dir().join(format!("txr-182-limit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).unwrap();
    let _root = txresbench::modules::rootfs::scoped_data_root(scratch.clone());

    const LIMIT: usize = 32 * 1024;

    async fn handler(mut multipart: Multipart) -> axum::response::Response {
        // The SAME two error seams the production upload handlers use.
        loop {
            match multipart.next_field().await {
                Ok(Some(mut field)) => {
                    match txresbench::modules::file::stream::stage_multipart_field(&mut field)
                        .await
                    {
                        Ok(part) => {
                            if part.is_empty() {
                                return (axum::http::StatusCode::OK, "empty").into_response();
                            }
                        }
                        Err(err) => {
                            let (status, err) = err.to_api_error();
                            return (status, axum::Json(err)).into_response();
                        }
                    }
                }
                Ok(None) => return (axum::http::StatusCode::OK, "ok").into_response(),
                Err(err) => {
                    let (status, err) = txresbench::modules::file::stream::multipart_error(
                        "INVALID_MULTIPART",
                        "Malformed multipart body",
                        &err,
                    )
                    .to_api_error();
                    return (status, axum::Json(err)).into_response();
                }
            }
        }
    }

    let app = axum::Router::new()
        .route("/upload", post(handler))
        .layer(DefaultBodyLimit::max(LIMIT));

    // --- over the ceiling -----------------------------------------------------
    let over = multipart_body(&vec![7u8; LIMIT * 4]);
    let resp = app
        .clone()
        .oneshot(multipart_request(over))
        .await
        .expect("router responds");
    let status = resp.status().as_u16();
    let body = http_body_util::BodyExt::collect(resp.into_body())
        .await
        .expect("body")
        .to_bytes();
    let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);

    assert_eq!(
        status, 413,
        "INV-3: an over-ceiling upload is refused with 413, not a generic 400 or a \
         dropped connection: {json}"
    );
    assert_eq!(
        json["error_code"].as_str(),
        Some("UPLOAD_TOO_LARGE"),
        "INV-3: the refusal is NAMED, so a client can tell 'too big' from \
         'malformed': {json}"
    );

    // --- and the service is still alive ---------------------------------------
    let under = multipart_body(b"small enough");
    let ok = app
        .oneshot(multipart_request(under))
        .await
        .expect("router still responds after refusing an over-size body");
    assert_eq!(
        ok.status().as_u16(),
        200,
        "INV-3: the refusal must leave the process serving — the whole point is that \
         it is an error and not a death"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// TEST-4 (second leg) — the named refusal on the REAL production route.
///
/// The ceiling it trips is the per-field cap on a NON-file part — the second
/// unbounded allocation the fix removed (`Field()` had no ceiling under a
/// 64 GiB body limit, so a giant `groups` part could OOM the API exactly as a `file`
/// part used to). It is reachable over HTTP with ~1 MiB, unlike the body limit, which
/// is why INV-3 gets an end-to-end proof at all.
///
/// **What this does and does not cover.** The 413 observed here is raised inside
/// `read_text_capped`, so it proves the FIELD-cap refusal is wired into the real
/// route. It does NOT exercise `multipart_error`'s body-limit mapping: reverting the
/// `multipart_error(..)` calls in the three handlers to `bad_request` would leave
/// this test green. That mapping is covered only by the synthetic-router leg above,
/// because tripping it for real needs 64 GiB on the wire — the same reason DEC-7
/// files the settings-row promotion. Two different ceilings, and only one of them is
/// cheap enough to drive end-to-end; saying so is better than implying both are.
#[tokio::test]
async fn over_ceiling_field_on_the_real_route_is_a_named_413() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "cap", "cap@x.test").await;
    let token = login(&server, "cap").await;

    // Comfortably over `stream::TEXT_FIELD_MAX_BYTES` (1 MiB) — ~1.14 MiB. The exact
    // off-by-one boundary (at the cap accepted, one byte over refused) is asserted
    // against the helper in `stream.rs`'s unit tests; what this leg has to show is
    // that the refusal is reachable and named on the REAL route.
    let oversized_groups = "[".to_string() + &"0,".repeat(600_000) + "0]";
    assert!(
        oversized_groups.len() > 1024 * 1024,
        "the fixture must actually exceed the field cap ({} bytes)",
        oversized_groups.len()
    );

    let form = Form::new()
        .part("file", Part::bytes(b"tiny".to_vec()).file_name("a.bin"))
        .text("groups", oversized_groups);
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("oversized-field upload");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);

    assert_eq!(
        status, 413,
        "INV-3: an over-ceiling FIELD on the real upload route is refused with 413, \
         not a 400 and not by exhausting the process: {body}"
    );
    assert_eq!(
        body["error_code"].as_str(),
        Some("UPLOAD_FIELD_TOO_LARGE"),
        "INV-3: the refusal is NAMED on the real route: {body}"
    );

    // ...and the API is still serving, which is the half that distinguishes a
    // refusal from the OOM this whole branch exists to remove.
    let ok = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(Form::new().part("file", Part::bytes(b"after".to_vec()).file_name("b.bin")))
        .send()
        .await
        .expect("the server still answers after refusing");
    assert_eq!(
        ok.status().as_u16(),
        200,
        "INV-3: the process survives its own refusal"
    );
}

const TEST_BOUNDARY: &str = "----txr182bound";

fn multipart_body(payload: &[u8]) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(format!("--{TEST_BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"x.bin\"\r\n\r\n",
    );
    body.extend_from_slice(payload);
    body.extend_from_slice(format!("\r\n--{TEST_BOUNDARY}--\r\n").as_bytes());
    body
}

fn multipart_request(body: Vec<u8>) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri("/upload")
        .header(
            axum::http::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={TEST_BOUNDARY}"),
        )
        .body(axum::body::Body::from(body))
        .unwrap()
}

// ---------------------------------------------------------------------------
// TEST-10 [acceptance] [invariant: INV-2] — the PRODUCTION staging function
// ---------------------------------------------------------------------------

/// TEST-10 — `sandbox::inputs::stage_dataset_file` itself, the function INV-2 names,
/// does not re-buffer the file.
///
/// TEST-2 measures the helper that function calls, which leaves a hole: reverting
/// `stage_dataset_file` to the old `load_original` -> `Vec<u8>` -> `fs::write` shape
/// while leaving the helper in the tree keeps TEST-2 green and INV-2 violated. This
/// test closes that hole by driving the production function on real data:
///
/// * the blob is uploaded through the real API, so it is a real `files` row with a
///   real owner and real bytes on the server's disk;
/// * the test then points its own `txresbench-file` storage at that same on-disk store
///   (it is a local filesystem store, so the test can read what the server wrote)
///   and calls `stage_dataset_file` with the real pool and the real owner — which
///   also exercises the `file_readable_by` authorization gate that guards it;
/// * a positive control in the same test performs the OLD shape over the same blob
///   and must exceed the bound, so the measurement cannot pass vacuously.
///
/// Reverting `sandbox/inputs.rs` turns this red.
#[tokio::test]
async fn the_production_staging_function_does_not_rebuffer() {
    let _rss_lock = rss_measurement_guard().await;
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let owner_id = create_user(&server, &admin, "stage", "stage@x.test").await;
    let token = login(&server, "stage").await;
    let owner: uuid::Uuid = owner_id.parse().expect("owner uuid");

    let body = upload_generated(&server, &token, BIG_BYTES, "staged.bin").await;
    let file_id: uuid::Uuid = body["datasets"][0]["files"][0]["file_id"]
        .as_str()
        .expect("file id")
        .parse()
        .expect("file uuid");

    // The server's blob store is a local filesystem tree under its per-test data
    // dir, so the test process can open the very same store.
    let storage = txresbench_file::init_file_storage(server.data_dir().join("files"));
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect to the test database");

    let scratch = std::env::temp_dir().join(format!("txr-182-prodstage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).unwrap();
    let dest = scratch.join("staged-input.bin");

    // --- the invariant: the production function -------------------------------
    let poller = RssPoller::start();
    let hash =
        txresbench::modules::sandbox::inputs::stage_dataset_file(&pool, file_id, owner, &dest)
            .await
            .expect("the production staging path succeeds");
    let streaming_growth = poller.growth_kib();

    assert!(
        hash.starts_with("sha256:"),
        "staging returns the input's content hash: {hash}"
    );
    assert_eq!(
        std::fs::metadata(&dest).unwrap().len(),
        BIG_BYTES,
        "the whole blob was staged (non-vacuity: the bound is not met by staging nothing)"
    );

    // --- the positive control: the shape this replaced ------------------------
    let control_poller = RssPoller::start();
    {
        let bytes = storage
            .load_original(owner, file_id, "bin")
            .await
            .expect("the old load_original path still reads the same blob");
        assert_eq!(bytes.len() as u64, BIG_BYTES);
        assert_eq!(
            format!("sha256:{}", sha256_hex_of(&bytes)),
            hash,
            "the streamed digest equals the buffered digest of the same blob"
        );
    }
    let control_growth = control_poller.growth_kib();

    eprintln!(
        "TEST-10 measured VmRSS growth (KiB): production_stage={streaming_growth} \
         buffered_control={control_growth} (bound {RSS_BOUND_KIB})"
    );

    assert!(
        control_growth > 200 * MIB,
        "POSITIVE CONTROL FAILED: reading the same {} MiB blob the OLD way grew peak \
         RSS by only {} KiB, so the probe cannot see a whole-file allocation and the \
         assertion below would be vacuous. Fix the probe, do not relax the bound.",
        BIG_BYTES / MIB_BYTES,
        control_growth
    );
    assert!(
        streaming_growth < RSS_BOUND_KIB,
        "INV-2: `stage_dataset_file` must not re-buffer. Staging {} MiB grew peak RSS \
         by {} KiB, over the {} KiB bound (the buffered control grew {} KiB).",
        BIG_BYTES / MIB_BYTES,
        streaming_growth,
        RSS_BOUND_KIB,
        control_growth
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

// ---------------------------------------------------------------------------
// TEST-11 — sniffing reads a BOUNDED head, measured
// ---------------------------------------------------------------------------

/// TEST-11 — `StagedPart::head(n)` reads a bounded prefix, proven by MEASUREMENT.
///
/// The unit test for `head` asserts only that the returned prefix is correct, which
/// an implementation that did `read_to_end()` and then truncated would satisfy
/// identically — while re-buffering a 50 GB blob to sniff 512 bytes, i.e. exactly
/// the defect this branch removes, on the sniff path instead of the ingest path.
/// Correctness of the bytes is not the claim; boundedness is. So this drives the
/// real `stage_multipart_field` -> `head` pair over a 256 MiB part and measures.
#[tokio::test]
async fn sniffing_a_large_part_reads_a_bounded_head() {
    use axum::extract::{DefaultBodyLimit, Multipart};
    use futures_util::StreamExt as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use tower::ServiceExt;

    let _rss_lock = rss_measurement_guard().await;
    let scratch = std::env::temp_dir().join(format!("txr-182-head-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).unwrap();
    let _root = txresbench::modules::rootfs::scoped_data_root(scratch.clone());

    // Driven through a real router because `Multipart` applies axum's 2 MiB default
    // body limit unless a route declares otherwise — the production upload routes
    // declare `DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)`, and this is the
    // test-scale equivalent of that declaration.
    let measured = Arc::new(AtomicU64::new(u64::MAX));
    let control = Arc::new(AtomicU64::new(0));
    let sink = Arc::clone(&measured);
    let control_out = Arc::clone(&control);
    let app = axum::Router::new()
        .route(
            "/head",
            axum::routing::post(move |mut mp: Multipart| {
                let sink = Arc::clone(&sink);
                let control_sink = Arc::clone(&control_out);
                async move {
                    let mut field = mp.next_field().await.unwrap().unwrap();
                    let staged =
                        txresbench::modules::file::stream::stage_multipart_field(&mut field)
                            .await
                            .expect("staging a large part succeeds");
                    assert_eq!(staged.size(), BIG_BYTES, "the whole part was staged");

                    let poller = RssPoller::start();
                    let head = staged.head(512).await;
                    sink.store(poller.growth_kib(), Ordering::SeqCst);

                    // POSITIVE CONTROL, in the same process and the same window
                    // shape: read the WHOLE staged part and FREE it again before the
                    // poller is stopped. Freeing first is the whole point — the
                    // mutation this test exists to catch is a `head` that reads the
                    // file and discards the buffer before returning, which is visible
                    // ONLY to an intermediate poll. A control that held the buffer
                    // live until the final read would be satisfied by that final read
                    // and would prove nothing about the polling loop.
                    let control_poller = RssPoller::start();
                    {
                        let whole = std::fs::read(staged.path().expect("a live part")).unwrap();
                        assert_eq!(whole.len() as u64, BIG_BYTES);
                    }
                    control_sink.store(control_poller.growth_kib(), Ordering::SeqCst);

                    assert_eq!(head.len(), 512, "the head is exactly the requested prefix");
                    assert_eq!(
                        head,
                        (0..512u64).map(filler_byte).collect::<Vec<u8>>(),
                        "and it is the right bytes"
                    );
                    axum::http::StatusCode::OK
                }
            }),
        )
        .layer(DefaultBodyLimit::disable());

    const BOUNDARY: &str = "----txr182head";
    let mut prologue: Vec<u8> = Vec::new();
    prologue.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    prologue.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"big.bin\"\r\n\r\n",
    );
    let epilogue = format!("\r\n--{BOUNDARY}--\r\n").into_bytes();

    // Generated as it is consumed, so the TEST process never holds the part either.
    const CHUNK: u64 = 1024 * 1024;
    let n = BIG_BYTES.div_ceil(CHUNK);
    let payload = futures_util::stream::iter((0..n).map(move |i| {
        let start = i * CHUNK;
        let this = CHUNK.min(BIG_BYTES - start);
        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(
            (0..this)
                .map(|k| filler_byte(start + k))
                .collect::<Vec<u8>>(),
        ))
    }));
    let full = futures_util::stream::once(async move {
        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(prologue))
    })
    .chain(payload)
    .chain(futures_util::stream::once(async move {
        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(epilogue))
    }));

    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/head")
        .header(
            axum::http::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(axum::body::Body::from_stream(full))
        .unwrap();
    let resp = app.oneshot(req).await.expect("router responds");
    assert_eq!(resp.status().as_u16(), 200, "the staging handler completed");

    let growth = measured.load(Ordering::SeqCst);
    let control_growth = control.load(Ordering::SeqCst);
    eprintln!(
        "TEST-11 measured VmRSS growth (KiB): head(512)={growth} whole_file_control={control_growth} \
         on a {} MiB part",
        BIG_BYTES / MIB_BYTES
    );
    assert!(
        control_growth > 200 * MIB,
        "POSITIVE CONTROL FAILED: reading the WHOLE {} MiB part grew peak RSS by only \
         {} KiB, so the poller cannot observe a whole-file read in this window and the \
         boundedness assertion below would be vacuous. Fix the probe, not the bound.",
        BIG_BYTES / MIB_BYTES,
        control_growth
    );
    assert!(
        growth < 8 * MIB,
        "sniffing must read a BOUNDED prefix, not the file: head(512) on a {} MiB \
         part grew peak RSS by {} KiB. A `read_to_end`-then-truncate implementation \
         returns the same bytes and fails only here.",
        BIG_BYTES / MIB_BYTES,
        growth
    );

    drop(_root);
    let _ = std::fs::remove_dir_all(&scratch);
}

// ---------------------------------------------------------------------------
// Double-ingest — the BEHAVIOURAL half of the consumed-part contract
// ---------------------------------------------------------------------------

/// TEST-12 — calling `ingest_staged` twice on the same part is a TYPED error, not a
/// panic.
///
/// `ingest_staged` hands the temp file to the blob store and disarms the part, so a
/// second call has no path to move. Before the fix round that was an `.expect()` —
/// a request-reachable panic the pre-#182 `Vec<u8>` shape did not have, prevented
/// only by `dataset::repository::plan_upload_groups` rejecting a duplicated index in
/// client-supplied JSON two modules away.
///
/// This drives the PRODUCTION function with a real repository. The unit test in
/// `stream.rs` asserts only the accessor's contract (`path()` is `None` after
/// disarm), which would stay green if the handler's `let ... else` were turned back
/// into a panic — so it is the accessor's test, not this one's.
#[tokio::test]
async fn double_ingest_is_a_typed_error_not_a_panic() {
    use axum::extract::{DefaultBodyLimit, FromRequest, Multipart};

    // Takes the measurement lock even though it measures nothing: it calls
    // `init_file_storage`, which OVERWRITES a process-global, and the two INV-2
    // measurements resolve their blobs through that same global. Without the lock
    // this test can swap the store out from under one of them mid-measurement.
    let _rss_lock = rss_measurement_guard().await;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let owner_id = create_user(&server, &admin, "twice", "twice@x.test").await;
    let owner: uuid::Uuid = owner_id.parse().expect("owner uuid");

    // Point this process at the server's own blob store + database, so the ingest is
    // the real one against real rows.
    txresbench_file::init_file_storage(server.data_dir().join("files"));
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect to the test database");
    let repo = txresbench_file::FileRepository::new(pool.clone());

    let scratch = std::env::temp_dir().join(format!("txr-182-twice-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).unwrap();
    let _root = txresbench::modules::rootfs::scoped_data_root(scratch.clone());

    const BOUNDARY: &str = "----txr182twice";
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"twice.bin\"\r\n\r\n",
    );
    body.extend_from_slice(b"ingested exactly once");
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let req = axum::http::Request::builder()
        .method("POST")
        .header(
            axum::http::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .extension(DefaultBodyLimit::disable())
        .body(axum::body::Body::from(body))
        .unwrap();
    let mut mp = Multipart::from_request(req, &()).await.expect("multipart");
    let mut field = mp.next_field().await.unwrap().unwrap();
    let mut staged = txresbench::modules::file::stream::stage_multipart_field(&mut field)
        .await
        .expect("staging succeeds");

    let first = txresbench::modules::file::stream::ingest_staged(
        &repo,
        &txresbench::modules::file::NoopFileEvents,
        owner,
        &mut staged,
        "twice.bin",
        None,
        "user",
        None,
    )
    .await
    .expect("the first ingest stores the part");
    assert_eq!(first.file_size, 21, "the part was stored");

    let second = txresbench::modules::file::stream::ingest_staged(
        &repo,
        &txresbench::modules::file::NoopFileEvents,
        owner,
        &mut staged,
        "twice.bin",
        None,
        "user",
        None,
    )
    .await;
    let err = second.expect_err("the second ingest of the same part must not succeed");
    assert_eq!(
        err.status_code(),
        500,
        "a re-ingest is a typed server error, never a panic that takes the process \
         with it: {err:?}"
    );

    // ...and it must not have DONE anything. Returning the right error after writing
    // a phantom `files` row would be strictly worse than the panic this replaced, and
    // a status-code-only assertion cannot tell the two apart: moving the guard below
    // `repo.create` would keep the 500 and leak a duplicate row.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE user_id = $1")
        .bind(owner)
        .fetch_one(&pool)
        .await
        .expect("count the owner's files");
    assert_eq!(
        rows, 1,
        "the refused re-ingest must create NO second files row (found {rows})"
    );

    drop(_root);
    let _ = std::fs::remove_dir_all(&scratch);
}

// ---------------------------------------------------------------------------
// The part-count ceiling (INV-1's other axis) and the staging fallback branch
// ---------------------------------------------------------------------------

/// TEST-13 — an upload with too MANY parts is refused by name, and the API survives it.
///
/// Per-part state is tiny but it is held for the whole request, so an uncapped part
/// count is the same unbounded-memory defect as an uncapped part SIZE, reached along
/// a different axis: under the 64 GiB body limit a request could carry on the order
/// of 10^8 minimal parts. This drives the real route past the cap and asserts the
/// refusal is typed rather than an exhaustion.
#[tokio::test]
async fn too_many_parts_is_a_named_413_and_the_service_survives() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "parts", "parts@x.test").await;
    let token = login(&server, "parts").await;

    // The magnitude is pinned because a test written only relative to the constant
    // stays green if the constant is lowered to 8 — which would refuse every real
    // multi-file bundle while every assertion below still passed. (The NUMBER is not
    // in the OpenAPI spec, which names only the error codes; it reaches a client
    // solely through the refusal's message body. That is a reason to pin it here, not
    // a reason to think a client already depends on it.)
    assert_eq!(
        txresbench::modules::file::stream::MAX_UPLOAD_PARTS,
        1024,
        "the declared part ceiling is part of the API contract"
    );
    let over = txresbench::modules::file::stream::MAX_UPLOAD_PARTS + 1;
    let mut form = Form::new();
    for i in 0..over {
        form = form.part(
            "file",
            Part::bytes(b"x".to_vec()).file_name(format!("p{i}.bin")),
        );
    }
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("many-part upload");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    assert_eq!(
        status, 413,
        "INV-1/INV-3: an upload with {over} parts is refused, not absorbed: {body}"
    );
    assert_eq!(
        body["error_code"].as_str(),
        Some("UPLOAD_TOO_MANY_PARTS"),
        "the refusal is NAMED: {body}"
    );

    // Exactly at the cap must still work, or the ceiling would be off by one in the
    // direction that breaks a legitimate bundle.
    let mut ok_form = Form::new();
    for i in 0..txresbench::modules::file::stream::MAX_UPLOAD_PARTS {
        ok_form = ok_form.part(
            "file",
            Part::bytes(b"x".to_vec()).file_name(format!("q{i}.bin")),
        );
    }
    let ok = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(ok_form)
        .send()
        .await
        .expect("at-cap upload");
    assert_eq!(
        ok.status().as_u16(),
        200,
        "an upload EXACTLY at the cap is accepted, and the API is still serving"
    );

    // The cap counts FILE parts, not multipart parts. The real wizard sends N files
    // PLUS `groups`/`datatype`/`supporting` control fields in the same body, so a cap
    // hoisted above the field-name match would refuse a legitimate at-cap bundle —
    // and both legs above, which send only `file` parts, would stay green.
    let at_cap = txresbench::modules::file::stream::MAX_UPLOAD_PARTS;
    let mut mixed = Form::new();
    for i in 0..at_cap {
        mixed = mixed.part(
            "file",
            Part::bytes(b"x".to_vec()).file_name(format!("r{i}.bin")),
        );
    }
    let mixed = mixed.text("datatype", "").text("supporting", "[]");
    let with_controls = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&token)
        .multipart(mixed)
        .send()
        .await
        .expect("at-cap upload with control fields");
    assert_eq!(
        with_controls.status().as_u16(),
        200,
        "control fields must not consume the FILE budget — {at_cap} files plus the \
         wizard's control fields is a legitimate upload"
    );
}

/// TEST-14 — a missing blob fails typed and writes nothing.
///
/// **Deliberately narrower than it looks, and worth saying why.** The intent was to
/// cover `copy_original_streaming`'s `load_original` fallback — the one place staging
/// still re-buffers — because both INV-2 measurements seed a real regular file and
/// take the fast arm. This drives the fallback in its reachable-today shape (an
/// absent blob), but it does NOT prove the fallback ARM ran: deleting the fallback
/// and returning `not_found` from the `_ => {}` arm would leave this green, because
/// the observable outcome is the same.
///
/// Proving the fallback's re-buffering behaviour needs a `FileStorage` whose blobs
/// are not at `get_original_path` — i.e. a second implementation, which lives in the
/// pinned SDK and does not exist. So this asserts the property that IS reachable
/// (a missing blob is an error, not a panic or a partial write) and the gap is
/// recorded in the ledger rather than dressed up as coverage.
#[tokio::test]
async fn staging_a_missing_blob_takes_the_fallback_and_fails_typed() {
    // Calls `init_file_storage`, which overwrites the process-global store the two
    // INV-2 measurements resolve their blobs through.
    let _rss_lock = rss_measurement_guard().await;
    let dir = std::env::temp_dir().join(format!("txr-182-missing-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    txresbench_file::init_file_storage(&dir);

    let dest = dir.join("staged.bin");
    let err = txresbench::modules::file::stream::copy_original_streaming(
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4(),
        "bin",
        &dest,
    )
    .await
    .expect_err("a blob that is not on disk cannot be staged");
    assert!(
        err.status_code() >= 400,
        "the fallback surfaces a typed error rather than panicking or hanging: {err:?}"
    );
    assert!(
        !dest.exists(),
        "nothing is written to the destination when the source is absent"
    );

    // The directory is deliberately NOT removed: `init_file_storage` overwrote a
    // process-global that still points here, and leaving it dangling would make a
    // later `get_file_storage()` resolve a vanished root. It holds nothing (the
    // staging never wrote), so the OS temp reaper is the right owner of it.
}
