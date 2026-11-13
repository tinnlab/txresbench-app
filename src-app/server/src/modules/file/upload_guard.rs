//! The upload request-body guard (#185 §1, owner ruling 1).
//!
//! ## Why this exists
//!
//! The dataset upload routes used to carry `DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)`
//! — a compiled 64 GiB `const`. The owner's ruling retires it: *"we should not limit
//! file size, that depends on user computer to process"*. Desktop/self-hosted now
//! carries `DefaultBodyLimit::disable()` and has no size ceiling at all; SaaS keeps a
//! ceiling, but as an admin settings row (`workstore_settings.max_upload_body_bytes`)
//! read AT USE rather than baked into the router.
//!
//! That reopens two things, and this module closes both:
//!
//! 1. **The ceiling has to be per-request to be a setting at all.**
//!    `DefaultBodyLimit::max(n)` is a tower layer: its value is fixed when
//!    `dataset_routes()` builds the stack, so reading the settings row there would
//!    be "a compiled constant read once" wearing a settings row's clothes — the exact
//!    defect #185 §1 records. axum's per-request escape hatch is not usable either:
//!    the request-extension form is `DefaultBodyLimitKind`, which is `pub(crate)` in
//!    `axum-core-0.5.6`. So the ceiling is counted here instead, as the body streams,
//!    which additionally makes the production ceiling end-to-end testable at any
//!    configured value (#185 §1's stated testing motive).
//!
//! 2. **Removing the body limit removes the only bound on multer's HEADER
//!    accumulation.** `file/stream.rs` records the case app-side code could not
//!    bound: a part's multipart headers are accumulated by `multer` inside axum's
//!    extractor *before* `next_field()` returns. Verified against the pinned
//!    `multer-3.1.0`: `Multipart::poll_next_field` calls
//!    `buffer.read_until(CRLF_CRLF)` (`multipart.rs:370`), which returns `None` and
//!    keeps accumulating into `StreamBuffer.buf` until the terminator arrives;
//!    `MAX_HEADERS = 32` (`constants.rs:6`) bounds the header *count* at `httparse`
//!    parse time, not the bytes buffered before parsing. The only upstream bound is
//!    `StreamBuffer::whole_stream_size_limit` (`buffer.rs:42`) — which is what
//!    `DefaultBodyLimit` supplies. With the limit disabled, a single multi-GB
//!    `Content-Disposition` line is bounded by nothing.
//!
//!    Leaving that would make the exposure strictly WORSE than the one this branch
//!    inherits, so it is bounded rather than merely restated:
//!    [`MAX_PART_HEADER_BYTES`] caps every part's header block, in **both** modes,
//!    upstream of `multer`. The exposure is ALSO written down — see
//!    (the upload-limits policy, "The multipart-header exposure") — because
//!    a bound whose reason is undocumented is a bound the next reader deletes.
//!
//! ## Why a boundary-aware scanner, and not something cheaper
//!
//! The bytes needing a bound are indistinguishable from file data at the transport
//! layer. "Bytes since the last `CRLFCRLF`" would false-trip on binary file data
//! (which contains no such terminator for gigabytes at a time). A smaller whole-body
//! limit would reintroduce the file-size cap the ruling forbids. So the guard tracks
//! the actual multipart structure — `\r\n--<boundary>` → header block → data — and
//! counts only inside the header block.
//!
//! Two properties make that safe to put in front of every uploaded byte:
//!
//! * **Correctness across chunk edges is structural, not buffered.** Delimiter
//!   matching is KMP with a persistent match position, so the scanner carries `O(1)`
//!   state and a delimiter split across any number of frames is matched exactly as if
//!   it had arrived whole. There is no carry buffer to double-process.
//! * **It does not cost a multi-GB upload seconds of CPU.** In the DATA state, when
//!   no partial match is in flight, `memchr` skips to the next `\r` with SIMD instead
//!   of walking byte-at-a-time; byte stepping only happens while a candidate
//!   delimiter is actually in progress.
//!
//! ## How the refusal reaches a typed 413
//!
//! The guard turns a violation into a body-stream error. That error reaches the
//! handler wrapped several layers deep (`MultipartError` → `multer::Error::
//! StreamReadFailed` → `axum::Error` → …), and axum maps an unrecognised body error
//! to `500`, so the refusal cannot be read off `MultipartError::status()`. Rather
//! than depend on the exact private shape of that chain across dependency bumps, the
//! guard records the refusal in a **task-local** for the duration of the request and
//! [`file::stream::multipart_error`] consults it. The handler future, the extractor
//! and the body polling all run inline on one task inside
//! [`guard_upload_body`]'s scope, so the read is always the current request's.
//!
//! No new error code is introduced: an over-ceiling body is the existing
//! `413 UPLOAD_TOO_LARGE`, and an over-cap header block is the existing
//! `413 UPLOAD_FIELD_TOO_LARGE` (a part's headers are part of a field). Both are
//! already declared on all three upload operations in both OpenAPI specs.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use futures_util::StreamExt;

/// Hard ceiling on ONE multipart part's header block.
///
/// `multer` caps the header COUNT at 32 (`constants::MAX_HEADERS`) but not the bytes
/// it buffers looking for the terminator, so this is the byte bound to that count:
/// 64 KiB is 2 KiB per header at multer's own ceiling. A real `Content-Disposition`
/// is well under 400 bytes — filenames are OS-bounded at 255 — so this is roughly
/// 250x the largest legitimate header block and cannot refuse a real upload, while
/// being small enough that a thousand concurrent uploads cost tens of MiB at worst
/// instead of being bounded by nothing.
pub const MAX_PART_HEADER_BYTES: usize = 64 * 1024;

/// Why the guard refused a body. Recorded in the task-local for
/// [`crate::modules::file::stream::multipart_error`] to map to a typed 413.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardRefusal {
    /// The request body exceeded the configured (SaaS) upload ceiling.
    BodyCeiling,
    /// One part's multipart header block exceeded [`MAX_PART_HEADER_BYTES`].
    PartHeaders,
}

impl std::fmt::Display for GuardRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BodyCeiling => write!(f, "upload body exceeded the configured ceiling"),
            Self::PartHeaders => write!(
                f,
                "a multipart part's headers exceeded {MAX_PART_HEADER_BYTES} bytes"
            ),
        }
    }
}

impl std::error::Error for GuardRefusal {}

// 0 = none, 1 = body ceiling, 2 = part headers. An AtomicU8 rather than a Mutex so
// the body's poll path stays allocation- and lock-free.
const REFUSAL_NONE: u8 = 0;
const REFUSAL_BODY: u8 = 1;
const REFUSAL_HEADERS: u8 = 2;

tokio::task_local! {
    static REFUSAL: Arc<AtomicU8>;
}

/// The refusal the guard recorded for the CURRENT request, if any.
///
/// Returns `None` outside a [`guard_upload_body`] scope (e.g. a unit test, or a
/// route the guard is not layered on), so callers fall back to their pre-existing
/// mapping rather than mis-attributing an unrelated error.
pub fn current_refusal() -> Option<GuardRefusal> {
    REFUSAL
        .try_with(|slot| match slot.load(Ordering::Acquire) {
            REFUSAL_BODY => Some(GuardRefusal::BodyCeiling),
            REFUSAL_HEADERS => Some(GuardRefusal::PartHeaders),
            _ => None,
        })
        .ok()
        .flatten()
}

/// The per-request limits the guard enforces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadLimits {
    /// Ceiling on the whole request body, in bytes.
    ///
    /// `None` means **no size ceiling** — the desktop/self-hosted policy, where the
    /// user's own disk is the limit (INV-1). Under `#[cfg(feature = "saas")]` the
    /// resolver never produces `None`: an absent or unreadable settings row falls
    /// back to the compiled default, so "unlimited" cannot be the accidental
    /// behaviour of a misconfigured SaaS deployment (INV-3).
    pub max_body_bytes: Option<u64>,
    /// Ceiling on ONE part's multipart header block, in bytes. Always enforced, in
    /// both modes — it is not a file-size limit and the ruling does not touch it.
    pub max_part_header_bytes: usize,
}

impl Default for UploadLimits {
    fn default() -> Self {
        Self { max_body_bytes: None, max_part_header_bytes: MAX_PART_HEADER_BYTES }
    }
}

/// Extract the `boundary` parameter from a `multipart/form-data` content type.
///
/// The multipart boundary for a `Content-Type`, or `None` if there is not one.
///
/// **This delegates to `multer::parse_boundary` — the exact function axum's
/// `Multipart` extractor calls (`axum-0.8.9/src/extract/multipart.rs:76,94`) — and
/// that delegation is the whole point.**
///
/// This was originally hand-parsed, to avoid a direct dependency on a crate the
/// server only saw transitively. That reasoning did not survive contact with the
/// problem. The guard is only a bound while it frames a request EXACTLY as the parser
/// that actually reads it does: if the two disagree about which bytes are the
/// delimiter, the guard scans for something the body never contains and
/// `MAX_PART_HEADER_BYTES` is applied to nothing, while the upload proceeds normally.
/// Every such disagreement therefore fails OPEN, silently.
///
/// Three consecutive blind audit rounds each found a NEW disagreement in the
/// hand-rolled version, and none of them were guessable from RFC 2045 — they were
/// artifacts of `mime` 0.3.17's implementation:
///
/// 1. `;` is legal `qdtext`, so `boundary="a;b"` is one parameter.
/// 2. `mime` has NO quoted-pair support, so `\` is an ordinary byte.
/// 3. `mime`'s closing-quote arm is `Some((i, b'"')) if i > start`, so a `"`
///    IMMEDIATELY after the opening quote is CONTENT, not a terminator —
///    `boundary=""abc"` really does mean the boundary `"abc`.
/// 4. An empty unquoted value at end-of-header parses successfully, so
///    `boundary=` yields `Ok("")` and multer then frames on the delimiter `--`.
///
/// That is an unbounded evasion space: each round found another spelling, so
/// "no findings" was unreachable by construction. Calling the real parser makes
/// agreement true BY CONSTRUCTION rather than by imitation, and it cannot drift when
/// the dependency is bumped, because it IS the dependency. `multer` is pinned to the
/// single version already in the tree, so this adds no second copy.
pub fn parse_boundary(content_type: &str) -> Option<String> {
    multer::parse_boundary(content_type).ok()
}

/// Where the scanner is in the multipart stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    /// Before the FIRST boundary. Scanning for `--<boundary>` at ANY offset, and
    /// counting what we skip.
    ///
    /// This is a separate state from [`ScanState::Data`] because `multer` anchors the
    /// first boundary differently from every later one: `StreamingStage::
    /// FindingFirstBoundary` does a plain substring search for `--<boundary>`
    /// (`multer-3.1.0` multipart.rs:258 → buffer.rs:76 `memmem::find`), with no
    /// preceding CRLF required, while every SUBSEQUENT delimiter is `\r\n--<boundary>`.
    /// Modelling the first one as "CRLF-anchored, but pretend a CRLF was just seen"
    /// only matches when it sits at offset 0 — so a single junk byte of preamble
    /// desynchronised the guard permanently while multer parsed the request happily,
    /// and the header cap was then never applied to any part.
    ///
    /// `seen` is bounded because multer's `read_to` does NOT drain while the pattern
    /// is absent: every preamble byte is retained in its `StreamBuffer`, with
    /// `whole_stream_size_limit = u64::MAX` and (since this branch) no
    /// `DefaultBodyLimit` above it. So a body that simply never contains the boundary
    /// grew server RSS without limit on desktop. Bounding the preamble is what closes
    /// that; a real client emits the first boundary at offset 0, so any cap at all is
    /// generous.
    Preamble { seen: usize },
    /// A part's DATA — unbounded, scanning for the next `\r\n--<boundary>`.
    Data,
    /// Just matched `\r\n--<boundary>`; reading the two bytes that say whether this
    /// is the FINAL boundary (`--`) or another part.
    AfterDelimiter { probe: [u8; 2], have: u8 },
    /// Inside a part's header block — every byte counted, terminated by `CRLFCRLF`.
    Headers { seen: usize, term: usize },
    /// After the closing `--boundary--`. Anything left is the epilogue: ignored, and
    /// deliberately NOT counted, so a trailing epilogue cannot be mistaken for a
    /// runaway header block.
    Epilogue,
}

/// The streaming multipart structure scanner + byte counters.
///
/// Holds `O(1)` state: two KMP positions, a byte count and two totals. It never
/// retains body bytes, which is what keeps the memory fix (#182) intact — peak RSS
/// stays bounded by a constant rather than by file size.
#[derive(Debug)]
pub struct UploadGuard {
    limits: UploadLimits,
    /// `\r\n--<boundary>` — the delimiter that precedes every part after the first.
    delimiter: Vec<u8>,
    /// KMP failure table for `delimiter`.
    delim_fail: Vec<usize>,
    /// How many bytes of `delimiter` are currently matched.
    delim_pos: usize,
    /// `--<boundary>` — the FIRST boundary, which multer matches at any offset with
    /// no preceding CRLF. Only used in [`ScanState::Preamble`].
    first: Vec<u8>,
    /// KMP failure table for `first`.
    first_fail: Vec<usize>,
    /// How many bytes of `first` are currently matched.
    first_pos: usize,
    state: ScanState,
    /// Total body bytes seen so far (for `max_body_bytes`).
    total: u64,
}

/// KMP failure table: `fail[i]` = length of the longest proper prefix of
/// `needle[..=i]` that is also a suffix of it.
fn kmp_failure(needle: &[u8]) -> Vec<usize> {
    let mut fail = vec![0usize; needle.len()];
    let mut k = 0usize;
    for i in 1..needle.len() {
        while k > 0 && needle[i] != needle[k] {
            k = fail[k - 1];
        }
        if needle[i] == needle[k] {
            k += 1;
        }
        fail[i] = k;
    }
    fail
}

/// The header-block terminator.
const CRLF_CRLF: &[u8; 4] = b"\r\n\r\n";

/// [`kmp_failure`] of [`CRLF_CRLF`], hoisted to a const so the hot header loop does
/// not allocate. `kmp_failure_table_is_correct` pins it against the generic
/// computation, so the two cannot drift.
const CRLF_CRLF_FAIL: [usize; 4] = [0, 0, 1, 2];

impl UploadGuard {
    /// Build a guard for a request whose multipart boundary is `boundary`.
    pub fn new(boundary: &str, limits: UploadLimits) -> Self {
        // The leading CRLF is part of the delimiter per RFC 2046 for every boundary
        // EXCEPT the first, which multer finds at any offset (see
        // `ScanState::Preamble`). So two needles, and the scanner starts on the
        // unanchored one.
        let mut delimiter = Vec::with_capacity(boundary.len() + 4);
        delimiter.extend_from_slice(b"\r\n--");
        delimiter.extend_from_slice(boundary.as_bytes());
        let delim_fail = kmp_failure(&delimiter);

        let mut first = Vec::with_capacity(boundary.len() + 2);
        first.extend_from_slice(b"--");
        first.extend_from_slice(boundary.as_bytes());
        let first_fail = kmp_failure(&first);

        Self {
            limits,
            delimiter,
            delim_fail,
            delim_pos: 0,
            first,
            first_fail,
            first_pos: 0,
            state: ScanState::Preamble { seen: 0 },
            total: 0,
        }
    }

    /// A guard that enforces ONLY the whole-body ceiling, for a request whose
    /// `Content-Type` carries no parseable multipart boundary.
    ///
    /// `DefaultBodyLimit::disable()` is applied to the upload routes unconditionally,
    /// so before this existed a non-multipart request to those routes carried no body
    /// bound at all — including under SaaS, where the configured ceiling is supposed
    /// to be absolute. The `Multipart` extractor rejects such a request quickly, but
    /// "something else refuses it first" is not the same as "the ceiling applies",
    /// and the ceiling is the thing SaaS operators are told bounds their tenants.
    pub fn total_only(limits: UploadLimits) -> Self {
        Self {
            limits,
            delimiter: Vec::new(),
            delim_fail: Vec::new(),
            delim_pos: 0,
            first: Vec::new(),
            first_fail: Vec::new(),
            first_pos: 0,
            // `Epilogue` short-circuits the structural scan while `consume` still
            // counts `total` against `max_body_bytes` before dispatching on state.
            state: ScanState::Epilogue,
            total: 0,
        }
    }

    /// Feed one chunk of body bytes. Returns the refusal on the first violation.
    ///
    /// Byte-for-byte equivalent whether the body arrives as one chunk or as single
    /// bytes — the KMP positions and the header counter are the only state, and none
    /// of it is per-chunk.
    pub fn consume(&mut self, chunk: &[u8]) -> Result<(), GuardRefusal> {
        // Whole-body ceiling first: it is the cheaper check and, when it fires, the
        // structural scan below cannot tell us anything more useful.
        self.total = self.total.saturating_add(chunk.len() as u64);
        if let Some(max) = self.limits.max_body_bytes {
            if self.total > max {
                return Err(GuardRefusal::BodyCeiling);
            }
        }

        // A `total_only` guard has no needles, and the structural arms below index
        // `self.delimiter[0]` / `self.first[0]` unconditionally. Today its state is
        // always `Epilogue`, so those arms are unreachable — but that is an invariant
        // held by one field initialiser, and a panic in the body-poll path of every
        // upload is a bad thing to leave one edit away. Returning here makes the
        // safety structural instead.
        if self.delimiter.is_empty() {
            return Ok(());
        }

        let mut i = 0usize;
        while i < chunk.len() {
            match self.state {
                ScanState::Epilogue => return Ok(()),
                ScanState::Preamble { mut seen } => {
                    // Unanchored search for `--<boundary>`, mirroring multer's
                    // `memmem::find`. Same memchr fast path as `Data`.
                    if self.first_pos == 0 {
                        match memchr::memchr(self.first[0], &chunk[i..]) {
                            Some(off) => {
                                seen += off;
                                i += off;
                                // Check HERE, not only on the loop's other exits. If
                                // the byte loop below goes on to complete the
                                // boundary match, this is the only place the skipped
                                // bytes are ever weighed — so omitting it made the
                                // budget `budget + one body frame` instead of
                                // `budget`, and made the verdict depend on how the
                                // body was chunked, contradicting `consume`'s own
                                // "byte-for-byte equivalent whether the body arrives
                                // as one chunk or as single bytes" invariant. A fuzz
                                // over 7 boundaries x 3 caps x chunk sizes 1-6 found
                                // 172 whole-vs-split disagreements, every one of them
                                // whole=Ok / split=Err.
                                self.state = ScanState::Preamble { seen };
                                self.check_preamble(seen)?;
                            }
                            None => {
                                seen += chunk.len() - i;
                                self.state = ScanState::Preamble { seen };
                                return self.check_preamble(seen);
                            }
                        }
                    }
                    while i < chunk.len() {
                        let b = chunk[i];
                        i += 1;
                        seen += 1;
                        while self.first_pos > 0 && b != self.first[self.first_pos] {
                            self.first_pos = self.first_fail[self.first_pos - 1];
                        }
                        if b == self.first[self.first_pos] {
                            self.first_pos += 1;
                        }
                        if self.first_pos == self.first.len() {
                            self.first_pos = 0;
                            self.delim_pos = 0;
                            self.state = ScanState::AfterDelimiter { probe: [0; 2], have: 0 };
                            break;
                        }
                        // EVERY byte, unconditionally. Checking only when the KMP
                        // position returned to exactly 0 was a fail-open hole: a
                        // preamble built from the boundary's OWN leading bytes keeps
                        // `0 < first_pos < len` alive forever — with needle `--B`, a
                        // run of `-` oscillates first_pos between 1 and 2 and never
                        // reaches 0 — so within one `consume` call the budget was
                        // never consulted at all, and if the match then completed the
                        // state moved on with no check either. Measured before this
                        // fix: `UploadGuard::new("-X", 64 KiB).consume(10 MB of dashes
                        // + a valid body)` returned `Ok(())`, while the same bytes in
                        // 8 KiB chunks refused. hyper reads up to 417_792 bytes per
                        // frame, so one read bought ~408 KiB against a 64 KiB cap.
                        self.state = ScanState::Preamble { seen };
                        self.check_preamble(seen)?;
                        if self.first_pos == 0 {
                            // Candidate died; back to the memchr fast path.
                            break;
                        }
                    }
                    if let ScanState::Preamble { .. } = self.state {
                        self.state = ScanState::Preamble { seen };
                        self.check_preamble(seen)?;
                    }
                }
                ScanState::Data => {
                    // Fast path: with no candidate delimiter in flight, skip straight
                    // to the next possible start byte. This is what keeps a multi-GB
                    // body from being walked one byte at a time.
                    if self.delim_pos == 0 {
                        match memchr::memchr(self.delimiter[0], &chunk[i..]) {
                            Some(off) => i += off,
                            None => return Ok(()),
                        }
                    }
                    while i < chunk.len() {
                        let b = chunk[i];
                        i += 1;
                        self.advance_delimiter(b);
                        if self.delim_pos == self.delimiter.len() {
                            self.delim_pos = 0;
                            self.state = ScanState::AfterDelimiter { probe: [0; 2], have: 0 };
                            break;
                        }
                        if self.delim_pos == 0 {
                            // Candidate died; go back to the memchr fast path.
                            break;
                        }
                    }
                }
                ScanState::AfterDelimiter { mut probe, mut have } => {
                    while i < chunk.len() && have < 2 {
                        probe[have as usize] = chunk[i];
                        have += 1;
                        i += 1;
                    }
                    if have < 2 {
                        // Ran out of chunk mid-probe; resume on the next one.
                        self.state = ScanState::AfterDelimiter { probe, have };
                        return Ok(());
                    }
                    if &probe == b"--" {
                        // Closing delimiter: everything after it is epilogue.
                        self.state = ScanState::Epilogue;
                    } else {
                        // Another part. The two probed bytes belong to the header
                        // block, so they are counted and fed to the terminator
                        // matcher — dropping them would let a crafted 2-byte-aligned
                        // stream slip past the CRLFCRLF detection.
                        self.state = ScanState::Headers { seen: 0, term: 0 };
                        self.feed_header_bytes(&probe)?;
                    }
                }
                ScanState::Headers { .. } => {
                    let consumed = self.feed_header_bytes(&chunk[i..])?;
                    i += consumed;
                }
            }
        }
        Ok(())
    }

    /// Refuse once the preamble has run past the header budget.
    ///
    /// Reuses `max_part_header_bytes` (and therefore `UPLOAD_FIELD_TOO_LARGE`) rather
    /// than inventing a fourth error code the two OpenAPI specs would have to grow:
    /// both bound "structural bytes multer accumulates without draining", which is
    /// the same exposure measured at two points in the stream.
    /// `seen` counts every byte consumed in `Preamble`, INCLUDING the bytes of a
    /// boundary match currently in flight. Those bytes are part of the delimiter, not
    /// the preamble, so they are subtracted before the budget is applied.
    ///
    /// Without the subtraction the verdict depended on framing, which is the invariant
    /// `consume` promises not to break: when the whole body arrives in one chunk the
    /// match completes, the state moves to `AfterDelimiter` and this check is never
    /// reached, so the delimiter's own bytes are never weighed — but when a chunk edge
    /// falls mid-match, the same bytes are already in `seen` and get weighed. A fuzz
    /// over matching bodies (5 boundaries x preambles 0..7 x caps x chunk sizes 1..6)
    /// found 1120 disagreements, all whole=Ok / split=Err, reachable whenever the cap
    /// is below `len("--" + boundary)`. Fail-closed, so it refused legitimate uploads
    /// rather than admitting bad ones — but wrong, and it made the documented
    /// equivalence property false.
    ///
    /// ## The residual bound is `cap + len("--" + boundary)`, not `cap`
    ///
    /// Because an in-flight candidate is subtracted, a preamble that is a genuine
    /// PREFIX of the delimiter is not counted until the match dies or completes. So
    /// the true worst case is `max_part_header_bytes + first.len()`, and `boundary` is
    /// attacker-chosen. That is a real amplification and it is stated rather than
    /// rounded away — `test22` pins it.
    ///
    /// It is not unbounded, and the subtraction is not removable:
    ///
    /// * `boundary` arrives in the `Content-Type` HEADER, so its length is bounded by
    ///   the server's max header size, not by the body. The worst case is a constant,
    ///   which is what INV-5 requires.
    /// * Those bytes genuinely might BE the delimiter, and `multer` is buffering them
    ///   on exactly the same reasoning. Counting them as preamble would refuse
    ///   legitimate uploads whenever the cap fell below the boundary length — which is
    ///   the fail-CLOSED bug this subtraction was introduced to fix.
    fn check_preamble(&self, seen: usize) -> Result<(), GuardRefusal> {
        if seen.saturating_sub(self.first_pos) > self.limits.max_part_header_bytes {
            return Err(GuardRefusal::PartHeaders);
        }
        Ok(())
    }

    /// Advance the delimiter KMP match by one byte.
    fn advance_delimiter(&mut self, b: u8) {
        while self.delim_pos > 0 && b != self.delimiter[self.delim_pos] {
            self.delim_pos = self.delim_fail[self.delim_pos - 1];
        }
        if b == self.delimiter[self.delim_pos] {
            self.delim_pos += 1;
        }
    }

    /// Feed bytes while in the `Headers` state, counting them against the cap and
    /// watching for `CRLFCRLF`. Returns how many bytes of `buf` were consumed
    /// (fewer than `buf.len()` once the header block ends).
    fn feed_header_bytes(&mut self, buf: &[u8]) -> Result<usize, GuardRefusal> {
        let (mut seen, mut term) = match self.state {
            ScanState::Headers { seen, term } => (seen, term),
            // `feed_header_bytes` is only ever called with the scanner in `Headers`;
            // returning 0 keeps the caller's loop from advancing on a state it did
            // not expect instead of panicking on a malformed body.
            _ => return Ok(0),
        };

        for (idx, &b) in buf.iter().enumerate() {
            seen += 1;
            if seen > self.limits.max_part_header_bytes {
                self.state = ScanState::Headers { seen, term };
                return Err(GuardRefusal::PartHeaders);
            }
            // Inline KMP over the 4-byte terminator.
            while term > 0 && b != CRLF_CRLF[term] {
                term = CRLF_CRLF_FAIL[term - 1];
            }
            if b == CRLF_CRLF[term] {
                term += 1;
            }
            if term == CRLF_CRLF.len() {
                // Header block done — the rest of this buffer is part DATA.
                self.state = ScanState::Data;
                self.delim_pos = 0;
                return Ok(idx + 1);
            }
        }
        self.state = ScanState::Headers { seen, term };
        Ok(buf.len())
    }
}

/// Wrap a request body in the guard, and run the rest of the stack inside the
/// task-local scope [`current_refusal`] reads.
///
/// A non-multipart request (or one with an unparseable boundary) passes through
/// untouched: the guard's job is to bound multipart structure, and refusing a
/// request it cannot parse would turn a bad `Content-Type` into a 413 instead of the
/// `400 INVALID_MULTIPART` the handler already produces.
pub async fn guard_upload_body(limits: UploadLimits, req: Request, next: Next) -> Response {
    let boundary = req
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_boundary);

    let slot = Arc::new(AtomicU8::new(REFUSAL_NONE));

    // A parseable boundary gets the full structural scan. One that is absent or
    // unparseable still gets the whole-body ceiling where a ceiling is configured —
    // `DefaultBodyLimit::disable()` applies to these routes unconditionally, so
    // without this a non-multipart request to an upload route would carry NO body
    // bound at all, including under SaaS where the configured ceiling is meant to be
    // absolute. Desktop configures no ceiling, so this correctly stays a passthrough
    // there (INV-1).
    let guard = match &boundary {
        Some(b) => Some(UploadGuard::new(b, limits)),
        None if limits.max_body_bytes.is_some() => Some(UploadGuard::total_only(limits)),
        None => None,
    };

    let req = match guard {
        Some(mut guard) => {
            let slot_for_body = Arc::clone(&slot);
            let (parts, body) = req.into_parts();
            // One boxed error type so a guard refusal and a transport failure can
            // share the stream: a client disconnect must keep mapping to the 400 it
            // always did, and only a refusal sets the task-local.
            type StreamError = Box<dyn std::error::Error + Send + Sync>;
            let stream = body.into_data_stream().map(move |frame| match frame {
                Ok(bytes) => match guard.consume(&bytes) {
                    Ok(()) => Ok(bytes),
                    Err(refusal) => {
                        slot_for_body.store(
                            match refusal {
                                GuardRefusal::BodyCeiling => REFUSAL_BODY,
                                GuardRefusal::PartHeaders => REFUSAL_HEADERS,
                            },
                            Ordering::Release,
                        );
                        Err(Box::new(refusal) as StreamError)
                    }
                },
                Err(e) => Err(Box::new(e) as StreamError),
            });
            Request::from_parts(parts, Body::from_stream(stream))
        }
        None => req,
    };

    REFUSAL.scope(slot, next.run(req)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(body: Option<u64>, headers: usize) -> UploadLimits {
        UploadLimits { max_body_bytes: body, max_part_header_bytes: headers }
    }

    /// Build a minimal but REAL multipart body: preamble-free, one file part with the
    /// given header block, `data` bytes, then the closing delimiter.
    fn multipart(boundary: &str, header_block: &str, data: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(format!("--{boundary}\r\n{header_block}\r\n\r\n").as_bytes());
        v.extend_from_slice(data);
        v.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        v
    }

    // uncapped-uploads TEST-17 — the guard frames a request the way `multer` does.
    //
    // This is now a DIFFERENTIAL test rather than a table of expected strings, which
    // is the only form that can actually fail on "the guard disagrees with the parser
    // that frames the request". Three audit rounds each found a new disagreement in a
    // hand-rolled parser, every one of them fail-OPEN, and every one of them invisible
    // to a table of values someone wrote down by hand — because the expected values
    // themselves were derived from the same misreading as the code. Two of the cases
    // below were literally asserted BACKWARDS in an earlier version of this test.
    #[test]
    fn test17_parse_boundary_agrees_with_multer_exactly() {
        let cases = [
            // ordinary
            "multipart/form-data; boundary=abc",
            "multipart/form-data; boundary=\"a b\"",
            "Multipart/Form-Data; charset=utf-8; BOUNDARY=xyz",
            // `;` is legal qdtext -- one parameter, not two (round 1)
            "multipart/form-data; boundary=\"a;b\"",
            "multipart/form-data; foo=\"x;boundary=evil\"; boundary=real",
            // no quoted-pair support in `mime` -- `\` is an ordinary byte (round 2)
            "multipart/form-data; boundary=\"a\\b\"",
            "multipart/form-data; boundary=\"a\\\"b\"",
            "multipart/form-data; foo=\"a\\\"; boundary=X",
            // a `"` immediately after the opening quote is CONTENT, because mime's
            // closing-quote arm is `Some((i, b'"')) if i > start` (round 3)
            "multipart/form-data; boundary=\"\"abc\"",
            "multipart/form-data; x=\"\"y\"; boundary=abc",
            "multipart/form-data; foo=\"\"x;boundary=evil\"; boundary=B",
            // an empty unquoted value at end-of-header parses, and multer then frames
            // on the bare `--` delimiter (round 3)
            "multipart/form-data; boundary=",
            "multipart/form-data; boundary=\"\"",
            // non-multipart / malformed
            "application/json",
            "multipart/form-data",
            "multipart/form-data; boundary=\"abc",
            "",
            "multipart/form-data; boundary=\u{e9}",
            "multipart/form-data; na\u{ef}ve=\"caf\u{e9};x\"; boundary=ok",
        ];

        for ct in cases {
            assert_eq!(
                parse_boundary(ct),
                multer::parse_boundary(ct).ok(),
                "parse_boundary must equal multer::parse_boundary for {ct:?} -- any \
                 divergence fails OPEN: the guard scans for a delimiter the body never \
                 contains and the part-header cap is applied to nothing"
            );
        }
    }

    // uncapped-uploads TEST-17b — the two shapes that disabled the guard entirely are
    // now GUARDED, not merely parsed alike. `boundary=""abc"` and `boundary=` both
    // used to yield None, which installs a `total_only` guard -- and on desktop that
    // enforces nothing at all, restoring the exact unbounded-header exposure this
    // module exists to close.
    #[test]
    fn test17b_the_shapes_that_disabled_the_guard_now_enforce_the_header_cap() {
        for ct in [
            "multipart/form-data; boundary=\"\"abc\"",
            "multipart/form-data; boundary=",
        ] {
            let b = parse_boundary(ct)
                .unwrap_or_else(|| panic!("{ct:?} must yield a boundary, not None"));
            let huge =
                format!("Content-Disposition: form-data; name=\"{}\"", "z".repeat(200_000));
            let body = multipart(&b, &huge, b"data");
            let mut g = UploadGuard::new(&b, limits(None, MAX_PART_HEADER_BYTES));
            assert_eq!(
                g.consume(&body),
                Err(GuardRefusal::PartHeaders),
                "{ct:?} must still bound part headers"
            );
        }
    }

    // uncapped-uploads TEST-18 — the header cap survives a PREAMBLE.
    //
    // multer finds the first boundary with an unanchored substring search, so a body
    // may legally begin with junk. The guard used to model the first boundary as
    // CRLF-anchored-but-pretend-we-just-saw-one, which matches only at offset 0: one
    // leading byte desynchronised it for the entire request and the header cap was
    // silently disabled. This is the regression test for that.
    #[test]
    fn test18_a_preamble_does_not_disable_the_header_cap() {
        let b = "X-PRE";
        let huge = format!("Content-Disposition: form-data; name=\"{}\"", "z".repeat(200_000));
        for preamble in ["X", "junk before the first boundary\r\n", "-", "--", "\r\n"] {
            let mut body = preamble.as_bytes().to_vec();
            body.extend_from_slice(&multipart(b, &huge, b"data"));
            let mut g = UploadGuard::new(b, limits(None, MAX_PART_HEADER_BYTES));
            assert_eq!(
                g.consume(&body),
                Err(GuardRefusal::PartHeaders),
                "a {preamble:?} preamble must not disable the part-header cap"
            );
        }

        // ...and a legitimate part after a preamble is still accepted.
        let mut body = b"X".to_vec();
        body.extend_from_slice(&multipart(b, "Content-Disposition: form-data; name=\"f\"", b"ok"));
        let mut g = UploadGuard::new(b, limits(None, MAX_PART_HEADER_BYTES));
        assert_eq!(g.consume(&body), Ok(()), "a short preamble is legal and must pass");
    }

    // uncapped-uploads TEST-19 — a body whose boundary NEVER appears is refused
    // rather than accumulated.
    //
    // multer's `read_to` does not drain while the pattern is absent, and with
    // `DefaultBodyLimit::disable()` and no SaaS ceiling there was nothing above it:
    // an endless stream that never contains the boundary grew server RSS without
    // limit. The preamble budget is what bounds it.
    #[test]
    fn test19_a_body_that_never_contains_its_boundary_is_refused() {
        let mut g = UploadGuard::new("NEVER-APPEARS", limits(None, MAX_PART_HEADER_BYTES));
        let junk = vec![b'q'; MAX_PART_HEADER_BYTES + 1];
        assert_eq!(
            g.consume(&junk),
            Err(GuardRefusal::PartHeaders),
            "preamble past the budget is refused, not buffered"
        );

        // Fed one byte at a time, the budget is identical — the counter is not
        // per-chunk.
        let mut g = UploadGuard::new("NEVER-APPEARS", limits(None, 32));
        let mut refused = None;
        for (n, byte) in junk.iter().enumerate() {
            if let Err(e) = g.consume(std::slice::from_ref(byte)) {
                refused = Some((n + 1, e));
                break;
            }
        }
        assert_eq!(refused, Some((33, GuardRefusal::PartHeaders)), "refuses at budget+1");

        // The case that exercises the memchr SKIP followed by a COMPLETED match —
        // which is the only path on which the skipped bytes are ever weighed. Feeding
        // the same bytes whole vs. split must give the same verdict; it did not, and
        // the disagreement was always whole=Ok / split=Err, i.e. a single large frame
        // bought an attacker an unbounded preamble.
        let mut body = vec![b'q'; 200_000];
        body.extend_from_slice(b"--B\r\nContent-Disposition: form-data; name=\"f\"\r\n\r\nx\r\n--B--\r\n");
        let cap = 64 * 1024;

        let mut whole = UploadGuard::new("B", limits(None, cap));
        let whole_verdict = whole.consume(&body);

        let mut split = UploadGuard::new("B", limits(None, cap));
        let mut split_verdict = Ok(());
        for piece in body.chunks(8192) {
            split_verdict = split.consume(piece);
            if split_verdict.is_err() {
                break;
            }
        }

        assert_eq!(
            whole_verdict, split_verdict,
            "the verdict must not depend on how the body was framed"
        );
        assert_eq!(
            whole_verdict,
            Err(GuardRefusal::PartHeaders),
            "200 KB of preamble is past the 64 KiB budget however it arrives"
        );

        // The equivalence claim, actually swept rather than asserted on one input.
        // A single example cannot establish "byte-for-byte equivalent whether the body
        // arrives as one chunk or as single bytes" — the disagreements that hid here
        // needed a cap below `len("--" + boundary)` AND a chunk edge landing mid-match,
        // which no hand-picked case happened to hit.
        // The header block is varied too, and a SHORT one is essential: with a long
        // header block, any cap small enough to expose the preamble accounting is also
        // small enough to trip the header cap on BOTH paths, which masks the
        // disagreement. It needs a boundary longer than the cap and a header block
        // shorter than it.
        // The PREAMBLE ALPHABET matters as much as the lengths, and getting it wrong
        // is how this sweep previously certified a fix it could not see. With a
        // preamble of `b'p'` only — a byte that can never extend a `--<boundary>`
        // candidate — the KMP position returns to 0 on every byte, so the sweep can
        // NEVER reach the shape where the budget check was skipped entirely (a
        // preamble made of the needle's own prefix bytes). Re-run against the
        // pre-fix code that alphabet reports 248 disagreements and the fixed code 0,
        // which looks conclusive and is not: widening the alphabet to include `-`
        // exposes 983 more. Self-similar runs are the interesting input here.
        let preambles: [&[u8]; 7] = [b"", b"p", b"pp", b"-", b"--", b"-----", b"--B--B"];
        let header_blocks = ["", "a: b", "Content-Disposition: form-data; name=\"f\""];
        for boundary in ["B", "----WebKitFormBoundary7MA4YWxk", "x-y-z", "--", "a", "-X", "aab"] {
            for preamble in preambles {
                for cap in [0usize, 1, 4, 10, 33, 64, 4096] {
                    for header_block in header_blocks {
                    let mut body = preamble.to_vec();
                    body.extend_from_slice(&multipart(boundary, header_block, b"data"));

                    let mut whole = UploadGuard::new(boundary, limits(None, cap));
                    let w = whole.consume(&body);

                    for chunk_size in 1..7usize {
                        let mut split = UploadGuard::new(boundary, limits(None, cap));
                        let mut sv = Ok(());
                        for piece in body.chunks(chunk_size) {
                            sv = split.consume(piece);
                            if sv.is_err() {
                                break;
                            }
                        }
                        assert_eq!(
                            w, sv,
                            "verdict differs by framing: boundary={boundary:?} \
                             preamble={preamble:?} cap={cap} chunk={chunk_size} \
                             header_block={header_block:?}"
                        );
                    }
                    }
                }
            }
        }
    }

    // uncapped-uploads TEST-22 — the preamble budget's REAL worst case, constructed.
    //
    // `check_preamble` subtracts the in-flight candidate, so the honest bound is
    // `cap + len("--" + boundary)` and not `cap`, and the boundary is attacker-chosen.
    // This test builds the input that actually REACHES that bound: `cap` bytes that
    // cannot extend the needle, followed by a maximal delimiter-PREFIX run. The prefix
    // run is subtracted while it is alive, so it rides on top of a budget already spent.
    //
    // An earlier version of this test pinned neither thing it claimed. Its `at_bound`
    // body was 201 bytes against a 1024 cap — accepted with or without the subtraction,
    // so it could not pin the fail-closed bug — and its `over` body refused 201 bytes
    // short of the bound it purported to state. It also carried an assertion that
    // reduced, on substituting its own local, to `0 < cap`: it referenced no guard
    // behaviour at all and passed against three separate mutants, including the exact
    // skipped-check bug this round fixed. Both are gone.
    //
    // What this test does and does NOT discriminate, measured rather than assumed:
    // it REDS when the `first_pos` subtraction is removed (the fail-closed bug it is
    // named for). It does not red for the skipped-check bug — that is TEST-19's, and
    // TEST-19 does red for it — nor for a `saturating_sub(2 * first_pos)` variant,
    // which for these shapes admits the same lengths and in general only widens the
    // bound from `cap + delim` to `cap + 2*delim`: still a constant in the header
    // size, so not the unbounded class INV-5 is about. Stated because "TEST-22 pins
    // the bound" was previously claimed and was not true.
    #[test]
    fn test22_preamble_worst_case_is_cap_plus_the_delimiter_length() {
        let boundary = "Z".repeat(200);
        let cap = 1024usize;
        let delim = 2 + boundary.len(); // "--" + boundary
        let max_accepted = cap + delim - 1; // the last length still admitted

        // `k` filler bytes that can never extend `--ZZZ…`, then `p` bytes of genuine
        // delimiter prefix, one short of a match so the candidate stays alive.
        let build = |k: usize, p: usize| {
            let mut v = vec![b'q'; k];
            v.extend_from_slice(&b"--".to_vec()[..p.min(2)]);
            if p > 2 {
                v.extend_from_slice(&vec![b'Z'; p - 2]);
            }
            v
        };

        // At the bound: cap filler + a full-but-incomplete prefix run is ACCEPTED.
        // Refusing it was the fail-closed bug the subtraction fixes.
        let at_bound = build(cap, delim - 1);
        assert_eq!(at_bound.len(), max_accepted);
        let mut g = UploadGuard::new(&boundary, limits(None, cap));
        assert_eq!(g.consume(&at_bound), Ok(()), "cap + delimiter prefix is admitted");

        // One byte past it — a byte that KILLS the candidate, so the whole prefix run
        // retroactively becomes preamble — is refused.
        let mut over = at_bound.clone();
        over.push(b'q');
        let mut g = UploadGuard::new(&boundary, limits(None, cap));
        assert_eq!(
            g.consume(&over),
            Err(GuardRefusal::PartHeaders),
            "past cap + len(--boundary) the preamble is refused"
        );

        // The bound is not amplifiable by REPEATING prefix runs: a second run cannot
        // buy another `delim` bytes, because the first one was charged when it died.
        let mut repeated = build(0, delim - 1);
        for _ in 0..8 {
            repeated.push(b'q');
            repeated.extend_from_slice(&build(0, delim - 1)[..]);
        }
        let mut g = UploadGuard::new(&boundary, limits(None, cap));
        assert_eq!(
            g.consume(&repeated),
            Err(GuardRefusal::PartHeaders),
            "repeated delimiter-prefix runs do not each earn their own allowance"
        );

        // Same verdicts when split, which is what the per-byte check preserves.
        for body in [&at_bound, &over] {
            let mut whole = UploadGuard::new(&boundary, limits(None, cap));
            let w = whole.consume(body);
            for size in [1usize, 3, 7, 64] {
                let mut split = UploadGuard::new(&boundary, limits(None, cap));
                let mut sv = Ok(());
                for piece in body.chunks(size) {
                    sv = split.consume(piece);
                    if sv.is_err() {
                        break;
                    }
                }
                assert_eq!(w, sv, "verdict differs by framing at chunk size {size}");
            }
        }
    }

    // uncapped-uploads TEST-20 — a request with no parseable boundary still gets the
    // configured body ceiling. Without this, `DefaultBodyLimit::disable()` left a
    // non-multipart request to an upload route with no bound at all, in SaaS too.
    #[test]
    fn test20_total_only_guard_enforces_the_body_ceiling() {
        let mut g = UploadGuard::total_only(limits(Some(64), MAX_PART_HEADER_BYTES));
        assert_eq!(g.consume(&vec![0u8; 64]), Ok(()), "exactly the ceiling passes");
        assert_eq!(
            g.consume(&[0u8]),
            Err(GuardRefusal::BodyCeiling),
            "ceiling + 1 is refused even with no multipart structure to scan"
        );
    }

    // uncapped-uploads TEST-10 (a): an oversized header block trips the cap.
    #[test]
    fn test10a_oversized_part_header_block_is_refused() {
        let b = "X-BOUNDARY-1";
        let huge = format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"",
            "A".repeat(200_000)
        );
        let body = multipart(b, &huge, b"payload");
        let mut g = UploadGuard::new(b, limits(None, MAX_PART_HEADER_BYTES));
        assert_eq!(g.consume(&body), Err(GuardRefusal::PartHeaders));
    }

    // uncapped-uploads TEST-10 (b): a LEGITIMATE part with a 255-byte filename (the
    // longest an OS will produce) passes. This is the false-trip control — without
    // it, (a) would also pass with the cap set absurdly low.
    #[test]
    fn test10b_legitimate_long_filename_is_not_refused() {
        let b = "X-BOUNDARY-2";
        let hdr = format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: application/octet-stream",
            "n".repeat(255)
        );
        let body = multipart(b, &hdr, &[0u8; 4096]);
        let mut g = UploadGuard::new(b, limits(None, MAX_PART_HEADER_BYTES));
        assert_eq!(g.consume(&body), Ok(()));
    }

    // uncapped-uploads TEST-10 (c): chunking must not change the verdict. The same
    // body fed one byte at a time, and split at EVERY offset, gives the same answer
    // as the whole-body feed — the property KMP buys and the one a carry-buffer
    // implementation gets wrong.
    #[test]
    fn test10c_chunking_never_changes_the_verdict() {
        let b = "X-BOUNDARY-3";
        let ok_body = multipart(b, "Content-Disposition: form-data; name=\"file\"", &[7u8; 3000]);
        let bad_body = multipart(
            b,
            &format!("Content-Disposition: form-data; name=\"{}\"", "z".repeat(9000)),
            &[7u8; 16],
        );

        for (body, expected) in [(&ok_body, Ok(())), (&bad_body, Err(GuardRefusal::PartHeaders))] {
            // One byte at a time.
            let mut g = UploadGuard::new(b, limits(None, 4096));
            let mut got = Ok(());
            for byte in body.iter() {
                if let Err(e) = g.consume(std::slice::from_ref(byte)) {
                    got = Err(e);
                    break;
                }
            }
            assert_eq!(got, expected, "byte-at-a-time feed");

            // Split at every offset — this is what actually exercises a delimiter or
            // a CRLFCRLF straddling a frame edge.
            for split in 0..body.len() {
                let mut g = UploadGuard::new(b, limits(None, 4096));
                let first = g.consume(&body[..split]);
                let got = if first.is_err() { first } else { g.consume(&body[split..]) };
                assert_eq!(got, expected, "split at {split}");
            }
        }
    }

    // uncapped-uploads TEST-10 (d): file DATA that contains the delimiter's leading
    // bytes, near-miss boundaries, and long runs with no CRLFCRLF must NOT false-trip.
    // A guard that refuses real binary uploads is worse than no guard.
    #[test]
    fn test10d_binary_data_resembling_the_boundary_does_not_false_trip() {
        let b = "X-BOUNDARY-4";
        // Data containing: bare CRs, CRLFs, a near-miss delimiter (`\r\n--X-BOUNDARY-`
        // without the final char), and the boundary text without its CRLF prefix.
        let mut data = Vec::new();
        for _ in 0..500 {
            data.extend_from_slice(b"\r\n--X-BOUNDARY-");
            data.extend_from_slice(b"\r\r\r\n\n");
            data.extend_from_slice(format!("--{b}").as_bytes()); // no leading CRLF
            data.extend_from_slice(&[0xFFu8; 64]);
        }
        // ...and a long stretch with no CRLFCRLF at all, which a "bytes since the
        // last CRLFCRLF" bound would have tripped on.
        data.extend_from_slice(&[0xAB; 300_000]);

        let body = multipart(b, "Content-Disposition: form-data; name=\"file\"", &data);
        let mut g = UploadGuard::new(b, limits(None, MAX_PART_HEADER_BYTES));
        assert_eq!(g.consume(&body), Ok(()), "binary data must not trip the header cap");
    }

    // uncapped-uploads TEST-10 (e): the body counter refuses at ceiling+1 and passes
    // at exactly the ceiling — measuring the edge, not "some big number fails".
    #[test]
    fn test10e_body_ceiling_is_exact() {
        let b = "X-BOUNDARY-5";
        let body = multipart(b, "Content-Disposition: form-data; name=\"file\"", &[1u8; 1000]);
        let n = body.len() as u64;

        let mut exact = UploadGuard::new(b, limits(Some(n), MAX_PART_HEADER_BYTES));
        assert_eq!(exact.consume(&body), Ok(()), "exactly at the ceiling is accepted");

        let mut over = UploadGuard::new(b, limits(Some(n - 1), MAX_PART_HEADER_BYTES));
        assert_eq!(over.consume(&body), Err(GuardRefusal::BodyCeiling), "one byte over is refused");

        // No ceiling (the desktop policy) accepts a body of any size.
        let mut none = UploadGuard::new(b, limits(None, MAX_PART_HEADER_BYTES));
        assert_eq!(none.consume(&body), Ok(()));
    }

    // uncapped-uploads TEST-10 (f): the closing `--boundary--` puts the scanner into
    // the epilogue, so trailing bytes are ignored rather than counted as a runaway
    // header block.
    #[test]
    fn test10f_epilogue_after_the_closing_delimiter_is_ignored() {
        let b = "X-BOUNDARY-6";
        let mut body = multipart(b, "Content-Disposition: form-data; name=\"file\"", b"x");
        body.extend_from_slice(&[b'E'; 500_000]);
        let mut g = UploadGuard::new(b, limits(None, 1024));
        assert_eq!(g.consume(&body), Ok(()));
    }

    // uncapped-uploads TEST-10 (g): multiple parts each get their OWN header budget —
    // the counter resets per part rather than accumulating across the request.
    #[test]
    fn test10g_header_budget_is_per_part_not_cumulative() {
        let b = "X-BOUNDARY-7";
        let hdr = format!("Content-Disposition: form-data; name=\"{}\"", "q".repeat(3000));
        let mut body = Vec::new();
        for _ in 0..50 {
            body.extend_from_slice(format!("--{b}\r\n{hdr}\r\n\r\n").as_bytes());
            body.extend_from_slice(&[9u8; 100]);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{b}--\r\n").as_bytes());

        // 4 KiB per part: each part's ~3 KiB block fits, and 50 of them do not
        // accumulate into a refusal.
        let mut g = UploadGuard::new(b, limits(None, 4096));
        assert_eq!(g.consume(&body), Ok(()));
    }

    // uncapped-uploads: the hand-written expectations that used to live here are gone,
    // deliberately, and the deletion is worth a note.
    //
    // This test asserted `parse_boundary("multipart/form-data; boundary=") == None`.
    // That expectation was WRONG — `mime` parses an empty unquoted value at
    // end-of-header successfully, so `multer::parse_boundary` returns `Ok("")` and
    // frames the body on the bare `--` delimiter. Because the guard returned `None` it
    // installed a `total_only` guard, which on desktop enforces nothing: one trivial
    // header disabled the part-header cap entirely.
    //
    // The failure mode is the point. A table of expected values cannot catch a
    // misreading of the dependency, because the same misreading produced both the code
    // and the table — this test PASSED for as long as the bug existed, and only went
    // red once the code became correct. TEST-17 replaces it with a differential
    // comparison against `multer::parse_boundary` itself, which has no such blind spot,
    // and it covers every form this test did.

    // uncapped-uploads: the KMP failure table is the correctness core of the
    // cross-chunk property, so it is pinned directly against known values.
    #[test]
    fn kmp_failure_table_is_correct() {
        assert_eq!(kmp_failure(CRLF_CRLF), vec![0, 0, 1, 2]);
        assert_eq!(kmp_failure(b"aaaa"), vec![0, 1, 2, 3]);
        assert_eq!(kmp_failure(b"abcab"), vec![0, 0, 0, 1, 2]);
        // The real delimiter shape: `\r\n--` + boundary shares no prefix/suffix.
        assert_eq!(kmp_failure(b"\r\n--X").last().copied(), Some(0));
    }

    // uncapped-uploads TEST-11: the refusal channel `multipart_error` reads.
    //
    // The refusal cannot be recovered from `MultipartError::status()` — axum maps an
    // unrecognised body-stream error to 500 — so it travels in a request-scoped
    // task-local instead (DEC-4 / DRIFT-1.1). Three properties, and all three matter:
    // each variant round-trips as ITSELF (swapping them would mislabel a 413), the
    // scope is per-request so one request's refusal cannot leak into another's, and
    // OUTSIDE any scope the answer is `None` so a route the guard is not layered on
    // keeps its pre-existing 400 mapping rather than inventing a 413.
    #[tokio::test]
    async fn test11_refusal_round_trips_within_its_request_scope_only() {
        // Outside any scope: nothing to read.
        assert_eq!(current_refusal(), None, "no refusal outside a guard scope");

        for (variant, code) in
            [(GuardRefusal::BodyCeiling, REFUSAL_BODY), (GuardRefusal::PartHeaders, REFUSAL_HEADERS)]
        {
            let slot = Arc::new(AtomicU8::new(REFUSAL_NONE));
            let read_back = REFUSAL
                .scope(Arc::clone(&slot), async {
                    // A scope with nothing recorded yet reads as None — so the 413 is
                    // attributable to a refusal actually firing, not to being inside
                    // a guarded route at all.
                    assert_eq!(current_refusal(), None, "empty scope reads as None");
                    slot.store(code, Ordering::Release);
                    current_refusal()
                })
                .await;
            assert_eq!(read_back, Some(variant), "{variant:?} round-trips as itself");
        }

        // ...and the scope really ended: a refusal recorded in one request is not
        // visible after it.
        assert_eq!(current_refusal(), None, "the refusal does not outlive its scope");

        // PER-REQUEST ISOLATION, actually exercised. The sequential loop above does
        // NOT prove it: it would pass just as well against a single global
        // `static AtomicU8`, because no two scopes are ever live at once. Two
        // CONCURRENT scopes are what distinguishes a task-local from a global, and
        // concurrent uploads are the real deployment. Each side records a different
        // refusal, yields at an await point so the executor interleaves them, and
        // must still read back its OWN.
        let a = REFUSAL.scope(Arc::new(AtomicU8::new(REFUSAL_NONE)), async {
            REFUSAL.with(|s| s.store(REFUSAL_BODY, Ordering::Release));
            tokio::task::yield_now().await;
            current_refusal()
        });
        let b = REFUSAL.scope(Arc::new(AtomicU8::new(REFUSAL_NONE)), async {
            REFUSAL.with(|s| s.store(REFUSAL_HEADERS, Ordering::Release));
            tokio::task::yield_now().await;
            current_refusal()
        });
        let (a, b) = tokio::join!(a, b);
        assert_eq!(a, Some(GuardRefusal::BodyCeiling), "one request keeps its own refusal");
        assert_eq!(b, Some(GuardRefusal::PartHeaders), "the other keeps its own, concurrently");
    }

    // uncapped-uploads: a non-multipart Content-Type must leave the request alone.
    // Refusing what the guard cannot parse would turn a bad Content-Type into a 413
    // instead of the `400 INVALID_MULTIPART` the handler already produces.
    //
    // This asserts the BEHAVIOUR, not just `parse_boundary`'s return value. An
    // earlier version only re-checked two `parse_boundary` cases already covered by
    // `boundary_parsing_handles_the_real_header_forms` and left the actual property
    // in a trailing comment, so it would have stayed green if the `None` arm had been
    // changed to refuse.
    #[tokio::test]
    async fn a_request_the_guard_cannot_parse_is_not_a_refusal() {
        use axum::body::to_bytes;
        use axum::http::StatusCode;
        use axum::routing::post;
        use axum::Router;
        use tower::ServiceExt;

        // A desktop-shaped policy: no body ceiling at all.
        let limits = limits(None, MAX_PART_HEADER_BYTES);
        let app: Router = Router::new()
            .route(
                "/u",
                post(|body: axum::body::Bytes| async move {
                    // Echo what actually arrived, so a guard that mangled or truncated
                    // the body is visible rather than merely "not a 413".
                    (StatusCode::OK, body)
                }),
            )
            .layer(axum::middleware::from_fn(move |req, next| async move {
                guard_upload_body(limits, req, next).await
            }));

        let payload = b"{\"not\":\"multipart\"}".to_vec();
        let resp = app
            .oneshot(
                axum::http::Request::post("/u")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.clone()))
                    .unwrap(),
            )
            .await
            .expect("request");

        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "a body the guard cannot frame must pass through, so the handler's own \
             400 INVALID_MULTIPART stands rather than the guard inventing a 413"
        );
        let got = to_bytes(resp.into_body(), usize::MAX).await.expect("body");
        assert_eq!(got.as_ref(), payload.as_slice(), "the body arrives byte-identical");
    }
}
