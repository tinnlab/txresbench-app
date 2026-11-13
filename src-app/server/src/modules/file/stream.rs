//! Streaming ingest for the app-side upload path (#182).
//!
//! ## Why this module exists at all
//!
//! The blob STORE's write seam is `FileStorage::save_original(&self, .., data: &[u8])`
//! (`sdk/crates/txresbench-file/src/storage/mod.rs`), and its read seam is
//! `load_original(..) -> Vec<u8>`. Both are `&[u8]`/`Vec<u8>`, both live in the
//! PINNED `sdk/` submodule, and neither has a streaming variant. So the upload path
//! held every uploaded file whole in server RAM (twice — `Bytes` from the multipart
//! reader, then a `to_vec()` copy), and sandbox staging read the whole file back into
//! a `Vec<u8>` to hash and write it. A multi-GB vendor bundle exhausted the API
//! process before any configured cap was consulted.
//!
//! The SDK cannot be edited, so this module streams **around** the seam using only
//! the parts of it that are already public:
//!
//! * [`txresbench_file::FileStorage::get_original_path`] is a trait method that returns the
//!   DETERMINISTIC destination path for a blob. That is the whole trick: the app can
//!   compute where the bytes belong and put them there itself.
//! * `FileRepository::create`, `FileCreateData`, `FileStorage::delete_all` and
//!   `txresbench_file::utils::extension_of` are all `pub`.
//!
//! ## Why re-implementing the store half is FAITHFUL, not a divergent second path
//!
//! `txresbench_file::ingest::store_processed` does five things: `save_original`, then a
//! loop per derivative kind (text pages, geometry pages, thumbnail, preview images),
//! then `repo.create`, then `delete_all` on a DB failure, then
//! `events.on_file_changed`. TxResBench injects [`crate::modules::file::NoopFileProcessor`],
//! whose `process()` returns `ProcessingResult::default()` — so on THIS path every
//! derivative loop iterates an empty collection, by construction. What is left is
//! exactly what [`ingest_staged`] does, in the same order, with the same values:
//! the same `extension_of` blob key, the same `mime_guess` fallback expression, the
//! same `sha256` hex checksum, the same `FileCreateData` field-for-field, the same
//! rollback. `ingest_bytes` is left in the tree, untouched, for every other caller.
//!
//! Read this module side-by-side with `sdk/crates/txresbench-file/src/ingest.rs` — it is
//! deliberately a transcription of it with `&[u8]` replaced by a path, so that
//! "uploads keep working byte-identically" is auditable rather than hoped for.
//!
//! ## Two contracts this module DEPENDS on, stated so they cannot rot silently
//!
//! 1. **The active `FileStorage` must be path-addressable** — i.e.
//!    `get_original_path` must name a real filesystem path the store itself reads
//!    from. [`ingest_staged`] writes there directly. Today that is guaranteed:
//!    `FilesystemStorage` is the ONLY implementation and it lives inside the pinned
//!    SDK, so a second backend cannot appear without an SDK bump. There is no cheap
//!    fallback to add — the store's write seam takes `&[u8]`, so "fall back to
//!    `save_original`" means re-materializing the file, which is the defect this
//!    module exists to remove. If a non-path backend is ever added, this function
//!    must be revisited, not merely wrapped.
//! 2. **The injected `FileProcessor` on this path produces no derivatives.**
//!    [`ingest_staged`] cannot run a `FileProcessor`: that seam takes `&[u8]`, and
//!    handing it the bytes is the buffer being removed. It therefore writes
//!    `ProcessingResult::default()`. That is EQUIVALENT — not merely
//!    similar — only because TxResBench injects `NoopFileProcessor`, which returns
//!    exactly that. `noop_file_processor_is_still_a_no_op` in this module's tests is
//!    the tripwire on that premise.
//!
//! 3. **The store's checksum is `Sha256` rendered as lowercase hex.**
//!    `store_processed` computes it through the TRAIT method
//!    `storage.calculate_checksum(bytes)`; [`StagedPart`] cannot (it never holds the
//!    bytes) and so computes `Sha256` + `hex::encode` while streaming. Those agree
//!    because `FilesystemStorage::calculate_checksum` is exactly that. A backend
//!    with a different digest would silently re-key every uploaded file — which is
//!    why `ordinary_upload_bytes_and_hashes_are_unchanged` pins the stored checksum
//!    against a digest computed OUTSIDE this codebase rather than against whatever
//!    the store happens to return.
//!
//! ## Durability is unchanged, not improved
//!
//! The part is `flush`ed (into the page cache) and `rename`d into place before the
//! `files` row is committed; there is no `fsync` of the part or of the destination
//! directory. That is byte-identical to what it replaces —
//! `FilesystemStorage::save_original` is a single `fs::write` with no fsync either —
//! so a host crash between the rename and the row commit has always been able to
//! leave a row pointing at unflushed bytes. Adding an fsync to a multi-GB streamed
//! upload is a real cost and a change to the STORE's durability contract, which
//! lives in the pinned SDK. Recorded here so the `rename(2)` atomicity below is not
//! mistaken for a durability guarantee.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use axum::extract::multipart::{Field, MultipartError};
use axum::http::StatusCode;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use txresbench_core::AppError;
use txresbench_file::models::{File, FileCreateData, ProcessingResult};
use txresbench_file::seams::FileEvents;
use txresbench_file::utils::extension_of;
use txresbench_file::{get_file_storage, FileRepository};

use crate::modules::rootfs::data_root;

/// Copy/hash buffer. A fixed named constant rather than a settings row (DEC-8):
/// it trades a few hundred KiB of resident memory against syscall count and has no
/// per-deployment value an operator could reason about. It does not grow with the
/// file.
const STREAM_BUFFER_BYTES: usize = 256 * 1024;

/// Hard ceiling on a NON-file multipart field (`groups`, `datatype`, `supporting`,
/// `axis`, `kind`).
///
/// These are read as text, and text is held whole by definition — so without a cap
/// they are the same unbounded-RAM defect as the `file` parts were, on the same
/// routes, reachable by anyone who can upload. `axum`'s `Field::text()` has no
/// per-field ceiling and, since #185 §1, a desktop build has NO body limit above it
/// at all (a SaaS one has the configured ceiling), so a `groups` part of tens of GiB
/// would OOM the API exactly as a `file` part used to. This cap is what stands
/// between that and the process — and on a desktop build it is now the ONLY thing
/// standing there, which is why it is enforced in both modes.
/// [`read_text_capped`] streams these fields and refuses past this cap.
///
/// 1 MiB is roughly 30x the largest legitimate value (a `groups` spec for a
/// thousand-file upload is a few tens of KiB) — generous, not tight. What it buys is
/// a BOUND: a request carries at most three capped fields, so a thousand concurrent
/// uploads cost single-digit GiB of text at the very worst instead of being limited
/// only by whatever body ceiling (if any) the deployment carries.
const TEXT_FIELD_MAX_BYTES: usize = 1024 * 1024;

/// A temp part older than this is an orphan from a process that died mid-upload
/// (DEC-5/DEC-8). Only has to exceed the longest plausible single upload.
const TMP_UPLOAD_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Streamed parts land here, NOT in `/tmp` (DEC-3): this is the same filesystem the
/// blob store is rooted on (`data_root()/files`), so handing a finished part to the
/// store is an atomic `rename(2)` rather than a second whole-file copy — and on a
/// host whose `/tmp` is a tmpfs, `/tmp` would have put the file straight back into
/// RAM, which is the bug being fixed.
const TMP_UPLOAD_DIR: &str = "tmp-uploads";

/// The directory streamed parts are written to.
pub fn tmp_upload_dir() -> PathBuf {
    data_root().join(TMP_UPLOAD_DIR)
}

/// Every temp part this PROCESS currently owns.
///
/// The sweep exists for parts abandoned by a process that was KILLED — by
/// definition, parts no live owner knows about. It should never have to GUESS about
/// a part this process is holding, and age is a bad way to guess: on a multi-part
/// upload only the part currently streaming advances its mtime, so parts 1..N-1 sit
/// idle for the rest of the request while the handler holds them (group planning
/// needs every filename before it can decide). Nothing in this server bounds an
/// upload's wall clock — no timeout layer, and since #185 §1 no body ceiling at all
/// on a desktop build — so "no upload lasts a day" is an assumption, not a guarantee
/// (and a weaker one than before), and betting a `remove_file` on it
/// would kill a long upload that was making progress the whole time.
///
/// Ownership is therefore recorded explicitly. A registered path is skipped at ANY
/// age; the age gate then applies only to paths THIS PROCESS does not own, and a dead
/// process's registry dies with it, so its orphans are unowned at the next boot —
/// which is the case the age gate exists for.
///
/// **The registry is per-PROCESS; the directory is not.** A second process booted
/// against the same `data_root` (a worker, or `run_job_once`) also runs the sweep,
/// with an empty registry, and would fall back to age-only over the API's parts.
/// Making ownership survive that means putting it ON DISK — an owner pid in the
/// part's name, checked for liveness — which is not portable across the platforms
/// this server builds for. Recorded as the shape of the remaining exposure rather
/// than left to be discovered: it needs two processes sharing one data root, which is
/// a deployment choice, not a default.
static LIVE_PARTS: std::sync::Mutex<Option<std::collections::HashSet<PathBuf>>> =
    std::sync::Mutex::new(None);

fn live_parts() -> std::sync::MutexGuard<'static, Option<std::collections::HashSet<PathBuf>>> {
    LIVE_PARTS.lock().unwrap_or_else(|p| p.into_inner())
}

fn register_live_part(path: &Path) {
    live_parts()
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(path.to_path_buf());
}

fn release_live_part(path: &Path) {
    if let Some(set) = live_parts().as_mut() {
        set.remove(path);
    }
}

fn is_live_part(path: &Path) -> bool {
    live_parts().as_ref().is_some_and(|set| set.contains(path))
}

/// Every staging-write failure becomes ONE named refusal.
///
/// The message deliberately does NOT say "out of space": the same mapping catches
/// ENOSPC, EACCES on a mis-permissioned data volume, EMFILE, and a stalled network
/// mount, and telling an operator "disk full" when the real cause is a permission
/// bit sends them to the wrong place. The errno is logged; the client gets the class.
/// 507 is the closest standard code for "the server cannot store the representation".
fn storage_unavailable(err: impl std::fmt::Display) -> AppError {
    tracing::error!(error = %err, "upload staging write failed");
    AppError::new(
        StatusCode::INSUFFICIENT_STORAGE,
        "UPLOAD_STORAGE_UNAVAILABLE",
        "The server could not write the uploaded file to its staging area.",
    )
}

/// Map a multipart error to a TYPED refusal (#182 INV-3).
///
/// The body ceiling used to be `dataset::routes::UPLOAD_BODY_LIMIT` enforced by
/// axum's `DefaultBodyLimit`, which surfaces as a `MultipartError` whose `status()`
/// is `413`. Since #185 §1 the ceiling is the admin setting
/// `workstore_settings.max_upload_body_bytes`, enforced by
/// [`crate::modules::file::upload_guard`] and recovered above; the `status()` arm
/// below is kept because a `DefaultBodyLimit` is still in force on OTHER multipart
/// routes that share this mapper. Before this, an over-ceiling body collapsed into a `400
/// INVALID_MULTIPART` / `UPLOAD_READ_FAILED`, indistinguishable from a corrupt
/// request. Discriminated on `MultipartError::status()`, never on the error's
/// message text.
///
/// **Exactly one case changes shape, and it is worth being precise about which.**
/// A mid-body CLIENT DISCONNECT reaches `multer` as a transport read failure whose
/// `status()` is 500, so it still falls through to the `400 <fallback_code>` it
/// always produced. This function does not claim to have typed that case; it types
/// the over-ceiling case. `fallback_code`/`fallback_prefix` reproduce the
/// pre-existing 400 verbatim so nothing else moves.
pub fn multipart_error(
    fallback_code: &str,
    fallback_prefix: &str,
    err: &MultipartError,
) -> AppError {
    // #185 §1: the upload guard's refusals reach here as a body-STREAM error, which
    // axum maps to 500 — `MultipartError::status()` cannot see them. The guard
    // records which refusal fired in a task-local for the life of the request (see
    // `upload_guard`), so the typed 413 is recovered from there rather than from the
    // private shape of the `MultipartError -> multer::Error -> axum::Error` chain,
    // which a dependency bump could rearrange under us.
    //
    // Checked BEFORE `status()`: a guard refusal is more specific than anything the
    // generic mapping below can say about the same error.
    match crate::modules::file::upload_guard::current_refusal() {
        Some(crate::modules::file::upload_guard::GuardRefusal::BodyCeiling) => {
            return AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "UPLOAD_TOO_LARGE",
                "The upload exceeds this server's maximum request body size and was refused.",
            );
        }
        Some(crate::modules::file::upload_guard::GuardRefusal::PartHeaders) => {
            return AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "UPLOAD_FIELD_TOO_LARGE",
                format!(
                    "A multipart part's headers exceed the {}-byte limit and were refused.",
                    crate::modules::file::upload_guard::MAX_PART_HEADER_BYTES
                ),
            );
        }
        None => {}
    }
    if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "UPLOAD_TOO_LARGE",
            "The upload exceeds this server's maximum request body size and was refused.",
        );
    }
    AppError::bad_request(fallback_code, format!("{fallback_prefix}: {err}"))
}

/// One uploaded part, streamed to a temp file instead of held in RAM.
///
/// Carries only what the upload pipeline actually needs downstream — the path, the
/// byte count and the digest — so group planning, cardinality, sniffing and ingest
/// all operate on tens of bytes per part instead of on the file.
///
/// **Deletes its temp file on `Drop`**, on every IN-PROCESS exit path: a normal
/// return, an error unwind, and a cancelled request future. It cannot cover a
/// SIGKILL — that is what [`sweep_stale_tmp_uploads`] is for.
/// [`disarm`](Self::disarm) transfers ownership of the path once the bytes have been
/// handed to the blob store, so `Drop` does not chase a file that `rename` consumed.
#[derive(Debug)]
pub struct StagedPart {
    /// `None` once the part has been moved into the blob store (guard disarmed).
    path: Option<PathBuf>,
    size: u64,
    sha256_hex: String,
}

impl StagedPart {
    /// The temp file holding this part's bytes, or `None` once the part has been
    /// moved into the blob store by [`ingest_staged`].
    ///
    /// Deliberately NOT a panicking accessor. Ingesting the same part twice is
    /// prevented today only by `dataset::repository::plan_upload_groups`, which
    /// rejects a client `groups` spec that names an index twice — a guarantee that
    /// lives two modules away over user-supplied JSON. The shape this replaced
    /// (`Vec<u8>`) was harmlessly idempotent, so a panic here would be a NEW
    /// request-reachable crash bought by the fix. It returns `None` instead and the
    /// caller turns that into a typed error.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn is_empty(&self) -> bool {
        self.size == 0
    }

    /// Lowercase hex sha256 of the part's bytes, computed WHILE streaming. This is
    /// the identical value `FilesystemStorage::calculate_checksum` produces for the
    /// same bytes (`Sha256` → `hex::encode`), which is what keeps `files.checksum`
    /// — and therefore every dataset `content_hash` merkled from it — unchanged.
    pub fn sha256_hex(&self) -> &str {
        &self.sha256_hex
    }

    /// The first `n` bytes, for datatype sniffing. Reads a BOUNDED prefix — the
    /// sniffer only ever looked at `SNIFF_MAGIC_BYTES`, so the input is unchanged;
    /// only its source moves from an in-RAM slice to a short file read.
    /// Best-effort: an unreadable part sniffs as empty, exactly as a zero-length
    /// slice did.
    pub async fn head(&self, n: usize) -> Vec<u8> {
        let Some(path) = self.path.as_deref() else {
            return Vec::new();
        };
        let Ok(file) = tokio::fs::File::open(path).await else {
            return Vec::new();
        };
        let mut buf = Vec::with_capacity(n.min(self.size as usize));
        if file.take(n as u64).read_to_end(&mut buf).await.is_err() {
            return Vec::new();
        }
        buf
    }

    /// Give up ownership of the temp path (the bytes now live in the blob store),
    /// so `Drop` does not try to delete a file that has been renamed away.
    fn disarm(&mut self) -> Option<PathBuf> {
        let taken = self.path.take();
        if let Some(p) = taken.as_deref() {
            release_live_part(p);
        }
        taken
    }
}

impl Drop for StagedPart {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            release_live_part(&path);
            // Synchronous on purpose: `Drop` cannot await, and an unlink of a path
            // we just wrote is a single cheap syscall. Best-effort — a failure is a
            // disk leak the boot sweep reclaims, never a request failure.
            if let Err(err) = std::fs::remove_file(&path) {
                if err.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        path = %path.display(),
                        error = %err,
                        "failed to remove staged upload temp file; the boot sweep will reclaim it"
                    );
                }
            }
        }
    }
}

/// Drain one multipart `field` to a temp file, hashing as it goes.
///
/// This is the fix for buffer 1. The previous code called `field.bytes()`, which
/// materializes the WHOLE part as `Bytes`, and then `.to_vec()`, which copies it
/// again. Here the live footprint is one `chunk()` (a transport-sized `Bytes`) plus
/// the `STREAM_BUFFER_BYTES` writer buffer — independent of the part's size.
pub async fn stage_multipart_field(field: &mut Field<'_>) -> Result<StagedPart, AppError> {
    let dir = tmp_upload_dir();
    let path = dir.join(format!("{}.part", Uuid::new_v4()));

    // Create SYNCHRONOUSLY, before the guard exists and before any await.
    //
    // The obvious shape — arm the guard, then `tokio::fs::File::create(..).await` —
    // does NOT actually close the cancellation window, and it is worth being exact
    // about why: `tokio::fs` hands the syscall to the blocking pool and the pool
    // COMPLETES it even after the awaiting future is dropped, while the guard's
    // `Drop` is a synchronous unlink that runs first. The file would then appear
    // after its owner had already tried to remove it. Two cheap syscalls run inline
    // instead, so by the time any await exists the file exists too and the guard
    // owns it.
    //
    // The cost is honest: two syscalls run on a runtime worker per part rather than
    // on the blocking pool. On local disk that is microseconds. On a data volume
    // that can STALL — `data_root()` is operator-configurable and could be a network
    // or FUSE mount — it blocks a worker for as long as the mount takes, which the
    // previous `tokio::fs` shape did not. That is the trade for closing the window;
    // a whole-file write would never be acceptable here, two metadata syscalls are.
    std::fs::create_dir_all(&dir).map_err(storage_unavailable)?;
    let file = std::fs::File::create(&path).map_err(storage_unavailable)?;

    // Registered as OWNED before the guard exists, so the periodic sweep cannot
    // unlink it however long this request runs — which a multi-part upload's earlier
    // parts genuinely can outlast the age gate, since they go idle the moment they
    // are written and nothing bounds the request's wall clock.
    register_live_part(&path);

    // Armed the instant the file exists: every `?` below, and every cancellation
    // point, unwinds through this guard's `Drop`.
    let mut staged = StagedPart {
        path: Some(path.clone()),
        size: 0,
        sha256_hex: String::new(),
    };

    let mut writer =
        tokio::io::BufWriter::with_capacity(STREAM_BUFFER_BYTES, tokio::fs::File::from_std(file));
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|err| multipart_error("UPLOAD_READ_FAILED", "Failed to read upload", &err))?
    {
        hasher.update(&chunk);
        size += chunk.len() as u64;
        writer
            .write_all(&chunk)
            .await
            .map_err(storage_unavailable)?;
    }
    writer.flush().await.map_err(storage_unavailable)?;

    staged.size = size;
    staged.sha256_hex = hex::encode(hasher.finalize());
    Ok(staged)
}

/// Read a NON-file multipart field as text, refusing past [`TEXT_FIELD_MAX_BYTES`].
///
/// The streaming fix removed the unbounded `file` buffers; this removes the one the
/// same handlers kept for their control fields. `Field::text()` collects the whole
/// field with no ceiling, so `groups`/`datatype`/`supporting`/`axis`/`kind` were
/// still an unbounded allocation under any body limit, or none — the same defect, on the
/// same routes, reachable by any authenticated uploader.
///
/// A field is not streamed to disk (they are control data, not payload, and the
/// caller needs them as a `String`); it is read chunk-by-chunk and REFUSED the moment
/// it would exceed the cap. **What that bounds, precisely:** the accepted LENGTH is
/// at most the cap, and the `Vec` grows by amortized doubling, so the ALLOCATION can
/// reach roughly twice the cap plus one transport chunk — ~2 MiB, not the whole
/// field. Bounded
/// by a constant, which is the property that matters; not bounded BY the cap, which
/// would need a `reserve_exact` per chunk and pay an O(n^2) memcpy for the privilege.
///
/// **Narrowings from the `Field::text()` this replaces, enumerated rather than
/// hidden.** `text()` decodes through `encoding_rs`, which resolves the part's
/// declared `Content-Type` charset AND sniffs a byte-order mark. Both decode LOSSILY
/// (invalid bytes become U+FFFD, never an error), so a malformed field still fails
/// exactly where it always did — as invalid JSON or an unknown id. Two things are
/// narrower here:
///
/// * a part DECLARING a non-UTF-8 charset is no longer transcoded. No client in this
///   repo sends one (the browser `FormData` path is UTF-8).
/// * a UTF-16 BOM is no longer honoured (it becomes U+FFFD mojibake). A **UTF-8** BOM
///   IS still stripped below, because that is the case an ordinary editor produces
///   and it used to parse.
pub async fn read_text_capped(
    field: &mut Field<'_>,
    field_name: &str,
    fallback_code: &str,
    fallback_prefix: &str,
) -> Result<String, AppError> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|err| multipart_error(fallback_code, fallback_prefix, &err))?
    {
        if buf.len() + chunk.len() > TEXT_FIELD_MAX_BYTES {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "UPLOAD_FIELD_TOO_LARGE",
                format!(
                    "The `{field_name}` field exceeds the {TEXT_FIELD_MAX_BYTES}-byte limit for a \
                     non-file upload field and was refused."
                ),
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    // LOSSY, matching what `Field::text()` did for a UTF-8 part. A decoding problem
    // was never an error there — invalid bytes became U+FFFD and the field then
    // failed (or not) on its own terms, as invalid JSON or an unknown id. Making it
    // a hard 400 here would be a behaviour change smuggled in under a memory fix.
    //
    // The UTF-8 BOM is stripped for the same reason: `Field::text()` decodes through
    // `encoding_rs`, which SNIFFS and removes it, so a `groups` field written by an
    // editor that emits a BOM used to parse and would otherwise start failing as
    // invalid JSON on a leading U+FEFF.
    let body = buf.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&buf);
    Ok(String::from_utf8_lossy(body).into_owned())
}

/// Move a finished temp part into its final blob path.
///
/// `rename` is the whole point of DEC-3 (same filesystem ⇒ atomic, zero-copy). The
/// fallback for a cross-device or otherwise-failing rename is a BOUNDED streaming
/// copy — never a read-into-`Vec`, so a mis-configured deployment degrades to
/// "slower", never to "OOM".
///
/// The fallback copies to a SIBLING temp path and renames, rather than writing
/// `dest` directly. Writing `dest` directly means a copy that fails half way
/// (ENOSPC, EIO) leaves a TRUNCATED blob at the store's canonical path — a path a
/// `files` row will name and a reader will trust. With the sibling+rename shape,
/// `dest` either does not exist or is complete.
///
/// **What that does NOT buy.** The partial has to be a sibling (the whole reason
/// this branch exists is that `src` is on a different filesystem), and the
/// `originals/` tree is not swept. So a SIGKILL during the fallback copy leaves an
/// `<id>.<ext>.incoming-<uuid>` file nobody reclaims. That is a disk leak, and it is
/// strictly better than the truncated-blob-at-`dest` it replaces — an unreferenced
/// orphan cannot be read as data — but it is a leak, on a path that only a
/// cross-device misconfiguration reaches. Recorded rather than papered over; the
/// general sweep of `originals/` is follow-up work (#185).
async fn move_into_place(src: &Path, dest: &Path) -> Result<(), AppError> {
    if tokio::fs::rename(src, dest).await.is_ok() {
        return Ok(());
    }

    let partial = dest.with_extension(format!(
        "{}.incoming-{}",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("bin"),
        Uuid::new_v4()
    ));
    let copied = async {
        let mut reader = tokio::fs::File::open(src).await?;
        let mut writer = tokio::io::BufWriter::with_capacity(
            STREAM_BUFFER_BYTES,
            tokio::fs::File::create(&partial).await?,
        );
        tokio::io::copy(&mut reader, &mut writer).await?;
        writer.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(err) = copied {
        // Never leave a partial blob behind — not at `dest`, not at the sibling.
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(storage_unavailable(err));
    }
    if let Err(err) = tokio::fs::rename(&partial, dest).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(storage_unavailable(err));
    }
    let _ = tokio::fs::remove_file(src).await;
    Ok(())
}

/// Stream `src` → `dest` while computing its sha256; returns the lowercase hex.
///
/// **The one streaming hash-copy loop in the tree.** `sandbox::inputs::copy_and_hash`
/// delegates to it (framing the error as a materialization failure), so a fix to the
/// loop cannot land in one staging path and miss the other — which is the same
/// duplication class the `Stager` doc-comment describes for `get`-then-`write`.
/// `hex::encode(Sha256)` is byte-identical to `object_store::sha256_hex`, so a
/// Persist an already-streamed part as a durable `File`, without ever materializing
/// its bytes.
///
/// The streaming counterpart of `txresbench_file::ingest::ingest_bytes` +
/// `store_processed` for the no-derivative (`NoopFileProcessor`) path — see the
/// module doc for why that reduction is exact. Every observable it writes is
/// unchanged: the blob key (`extension_of`), the `mime_type` fallback, the
/// `checksum`, the `file_size`, `processing_metadata`, and the rollback-on-DB-error.
pub async fn ingest_staged(
    repo: &FileRepository,
    events: &dyn FileEvents,
    user_id: Uuid,
    staged: &mut StagedPart,
    filename: &str,
    mime_hint: Option<String>,
    created_by: &str,
    source_message_id: Option<Uuid>,
) -> Result<File, AppError> {
    // IDENTICAL to `ingest_bytes`: canonical extension, then the mime hint or the
    // extension-guessed type. `extension_of` (not `Path::extension`) because the
    // download/read paths derive the blob key the same way.
    let ext = extension_of(filename);
    let mime_type = mime_hint.or_else(|| mime_guess::from_ext(&ext).first().map(|m| m.to_string()));

    let file_id = Uuid::new_v4();
    let storage = get_file_storage();
    // The seam that makes streaming possible without touching the SDK: the trait
    // tells us WHERE the bytes belong, so we can put them there ourselves instead of
    // handing it a `&[u8]` it would `fs::write` in one shot.
    let dest = storage.get_original_path(user_id, file_id, &ext);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(storage_unavailable)?;
    }
    let Some(src) = staged.path() else {
        // The part was already handed to the store. Unreachable today (the upload
        // planner rejects a `groups` spec that names a file index twice), but it is
        // a TYPED 500 rather than a panic, because the guarantee lives in another
        // module over client-supplied JSON.
        return Err(AppError::internal_error("upload part was already ingested"));
    };
    move_into_place(src, &dest).await?;
    // The bytes are the store's now; the guard must not unlink the (renamed) path.
    staged.disarm();

    // `NoopFileProcessor` yields this exact value, so `processing_metadata` is
    // written with the SAME expression `store_processed` uses over the SAME input.
    let processed = ProcessingResult::default();
    let created = repo
        .create(FileCreateData {
            id: file_id,
            user_id,
            filename: filename.to_string(),
            file_size: staged.size() as i64,
            mime_type,
            checksum: Some(staged.sha256_hex().to_string()),
            has_thumbnail: !processed.thumbnails.is_empty(),
            preview_page_count: processed.images.len() as i32,
            text_page_count: processed.text_pages.len() as i32,
            processing_metadata: serde_json::to_value(&processed.metadata).unwrap_or_default(),
            source_message_id,
            created_by: created_by.to_string(),
        })
        .await;

    match created {
        Ok(file) => {
            events.on_file_changed(user_id, file_id, None);
            Ok(file)
        }
        Err(err) => {
            // Same rollback `store_processed` performs: the blob is already written
            // and no row will ever reference it.
            if let Err(cleanup_err) = storage.delete_all(user_id, file_id).await {
                tracing::warn!(
                    "ingest_staged: failed to clean up orphaned storage for {file_id} after DB error: {cleanup_err}"
                );
            }
            Err(err)
        }
    }
}

/// Best-effort reclaim of temp parts left by a process that died mid-upload.
///
/// `StagedPart::drop` covers every IN-PROCESS exit path; nothing covers a SIGKILL,
/// and an abandoned multi-GB part would otherwise sit on the data volume forever.
///
/// **What keeps the periodic sweep off a LIVE upload** (it runs hourly via
/// [`spawn_tmp_upload_sweeper`], not only at boot) is OWNERSHIP, not age: every part
/// a live request holds is in `LIVE_PARTS` and is skipped at any age. The age gate
/// applies only to paths nobody owns — after a clean start, exactly the set left
/// behind by a process that was killed.
///
/// Age ALONE would have been wrong, and specifically wrong for the case this branch
/// makes possible: on a multi-part upload only the part currently streaming advances
/// its mtime, so parts 1..N-1 go idle for the rest of the request. With up to
/// the configured per-request part cap and no wall-clock bound anywhere in this
/// server, an upload making progress the whole time could have had its earlier
/// parts unlinked and then died at `move_into_place`. Never fatal.
pub async fn sweep_stale_tmp_uploads() {
    sweep_tmp_uploads_in(tmp_upload_dir()).await
}

/// [`sweep_stale_tmp_uploads`] against an explicit directory.
///
/// The directory is a PARAMETER because `data_root()` is resolved per-thread (the
/// `scoped_data_root` testability seam), and the periodic sweeper runs on an
/// arbitrary runtime worker where no override is installed — so a sweeper that
/// re-resolved `data_root()` itself could sweep a different directory from the one
/// its caller staged into.
async fn sweep_tmp_uploads_in(dir: PathBuf) {
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return; // no temp dir yet — nothing to reclaim
    };
    let now = SystemTime::now();
    let mut reclaimed = 0usize;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("part") {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // Owned by a live request in THIS process — never reclaim it, at any age.
        if is_live_part(&path) {
            continue;
        }
        let aged = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= TMP_UPLOAD_MAX_AGE);
        if aged && tokio::fs::remove_file(&path).await.is_ok() {
            reclaimed += 1;
        }
    }
    if reclaimed > 0 {
        tracing::info!(
            count = reclaimed,
            dir = %dir.display(),
            "reclaimed abandoned upload temp parts"
        );
    }
}

/// How often the reclaim sweep re-runs on a live server.
///
/// A boot-only sweep is not enough, and the reason is specific: a SIGKILL (OOM
/// killer, supervisor restart, crash loop) is normally followed by an IMMEDIATE
/// restart, at which point the abandoned parts are seconds old and the age gate
/// correctly skips them — so on a server that then stays up for months, nothing ever
/// reclaims them. With this interval, an abandoned part is reclaimed within
/// `TMP_UPLOAD_MAX_AGE + TMP_UPLOAD_SWEEP_INTERVAL` whether or not the process ever
/// restarts again.
const TMP_UPLOAD_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Spawn the standing reclaim loop. Best-effort and non-fatal, like the other
/// standing sweeps started at boot.
pub fn spawn_tmp_upload_sweeper() {
    // At most ONE loop per process. No reachable entry point calls `build_app` twice
    // today — `boot_in_background`, `serve_blocking`, `run_worker` and `run_job_once`
    // are mutually exclusive modes and each calls it once — so this is a guard
    // against a FUTURE second bootstrap. (The SDK's `init_file_storage` takes the
    // same posture at its own call site in `lib.rs::build_app`, though its warning is
    // `cfg(not(test))`-gated, so it is a weaker precedent than it looks.) It has a
    // consequence worth naming:
    // if a second `build_app` ever ran in one process, it would get no periodic
    // sweeper and its data root's abandoned parts would be reclaimed only at boot.
    static SPAWNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if SPAWNED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // Resolved HERE, on the caller's thread, not inside the task — see
    // `sweep_tmp_uploads_in`.
    let dir = tmp_upload_dir();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(TMP_UPLOAD_SWEEP_INTERVAL);
        // The first tick fires immediately; the boot call already swept, so skip it.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            sweep_tmp_uploads_in(dir.clone()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{FromRequest, Multipart};
    use axum::http::{header, Request};
    use futures_util::StreamExt as _;

    /// A private temp app-data root for one test. `scoped_data_root` is
    /// THREAD-scoped and `#[tokio::test]` is single-threaded, so the override is
    /// visible to everything this test drives and to nothing else.
    struct TestRoot {
        dir: PathBuf,
        _guard: crate::modules::rootfs::DataRootGuard,
    }

    impl TestRoot {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("txr-upload-stream-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let guard = crate::modules::rootfs::scoped_data_root(dir.clone());
            Self { dir, _guard: guard }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    const BOUNDARY: &str = "----cytoboundary182";

    /// The multipart prologue + payload for one `file` part (no terminator).
    fn part_prefix(field_name: &str, filename: &str, payload: &[u8]) -> Vec<u8> {
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(payload);
        body
    }

    fn multipart_over(body: axum::body::Body) -> Multipart {
        let req = Request::builder()
            .method("POST")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={BOUNDARY}"),
            )
            .body(body)
            .unwrap();
        // `Multipart::from_request` only inspects headers, so this is ready
        // immediately; awaiting it keeps the test honest about that.
        futures_util::FutureExt::now_or_never(Multipart::from_request(req, &()))
            .expect("Multipart::from_request resolves without reading the body")
            .unwrap()
    }

    /// Build a REAL `axum::extract::Multipart` over a complete hand-rolled body, so
    /// the tests drive the production parser rather than a stand-in.
    fn multipart_of(field_name: &str, filename: &str, payload: &[u8]) -> Multipart {
        let mut body = part_prefix(field_name, filename, payload);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
        multipart_over(axum::body::Body::from(body))
    }

    async fn stage_payload(payload: &[u8]) -> StagedPart {
        let mut mp = multipart_of("file", "x.bin", payload);
        let mut field = mp.next_field().await.unwrap().unwrap();
        stage_multipart_field(&mut field).await.unwrap()
    }

    fn oneshot_sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        hex::encode(h.finalize())
    }

    /// TEST-6 — the streamed digest is the SAME sha256 a one-shot hash of the same
    /// bytes produces, at every boundary that matters (empty, 1 byte, and a payload
    /// that spans several `STREAM_BUFFER_BYTES` writes). This is the leg that keeps
    /// `files.checksum` — and every `content_hash` merkled from it — unchanged.
    #[tokio::test]
    async fn streamed_digest_equals_one_shot_digest() {
        let _root = TestRoot::new();
        for payload in [
            Vec::new(),
            vec![7u8; 1],
            (0..(STREAM_BUFFER_BYTES * 3 + 977))
                .map(|i| (i % 251) as u8)
                .collect::<Vec<u8>>(),
        ] {
            let staged = stage_payload(&payload).await;
            assert_eq!(
                staged.sha256_hex(),
                oneshot_sha256_hex(&payload),
                "streamed digest must equal the one-shot digest ({} bytes)",
                payload.len()
            );
            assert_eq!(
                staged.size(),
                payload.len() as u64,
                "size is the byte count"
            );
            assert_eq!(
                std::fs::read(staged.path().unwrap()).unwrap(),
                payload,
                "the temp part holds the payload byte-for-byte"
            );
        }
    }

    /// TEST-6 — `head(n)` returns a BOUNDED prefix, so sniffing never re-reads the
    /// file. Asserts the prefix is byte-identical to what the old in-RAM
    /// `bytes.iter().take(n)` produced, including when the file is shorter than `n`.
    #[tokio::test]
    async fn head_reads_a_bounded_prefix_only() {
        let _root = TestRoot::new();
        let payload: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();
        let staged = stage_payload(&payload).await;
        assert_eq!(staged.head(512).await, payload[..512].to_vec());
        assert_eq!(staged.head(8192).await, payload, "short file → whole file");

        let short = stage_payload(b"ab").await;
        assert_eq!(short.head(512).await, b"ab".to_vec());
    }

    /// TEST-6 — the temp file is gone once the guard drops, on the plain success
    /// path (nobody ingested it) and after an error unwind.
    #[tokio::test]
    async fn drop_removes_the_temp_part() {
        let _root = TestRoot::new();
        let path = {
            let staged = stage_payload(b"some bytes").await;
            let p = staged.path().unwrap().to_path_buf();
            assert!(p.exists(), "the part exists while the guard is alive");
            p
        };
        assert!(!path.exists(), "the part is unlinked when the guard drops");
        assert!(
            std::fs::read_dir(tmp_upload_dir())
                .unwrap()
                .next()
                .is_none(),
            "no temp part is left behind"
        );
    }

    /// TEST-6 — a request future cancelled MID-WRITE still cleans up. This is the
    /// path a client disconnect takes, and it is the reason the `Drop` guard is
    /// armed BEFORE the first write rather than after the last one.
    ///
    /// The body is a stream that yields a real, partial part and then **pends
    /// forever**, so the staging future is deterministically parked mid-write
    /// (no timing race, no "hope it didn't finish"). Dropping it is the
    /// cancellation.
    #[tokio::test]
    async fn cancelled_mid_write_leaves_no_temp_part() {
        let _root = TestRoot::new();
        let payload: Vec<u8> = vec![3u8; STREAM_BUFFER_BYTES * 4];
        let prefix = part_prefix("file", "big.bin", &payload);

        let never_ends = futures_util::stream::once(async move {
            Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(prefix))
        })
        .chain(futures_util::stream::pending());
        let mut mp = multipart_over(axum::body::Body::from_stream(never_ends));
        let mut field = mp.next_field().await.unwrap().unwrap();

        {
            let staging = stage_multipart_field(&mut field);
            // Bounded, but the future can never complete — the body never ends — so
            // the elapse is guaranteed and the drop is guaranteed to be mid-write.
            let outcome = tokio::time::timeout(Duration::from_millis(250), staging).await;
            assert!(
                outcome.is_err(),
                "the staging future must still be in flight when it is cancelled"
            );
        }

        let leftovers: Vec<_> = std::fs::read_dir(tmp_upload_dir())
            .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "a cancelled staging future must leave no temp part; found {leftovers:?}"
        );
    }

    /// TEST-6 — the sweep never reclaims a part this process OWNS, however old.
    ///
    /// The age gate alone would not be enough and the failure it would cause is not
    /// hypothetical: on a multi-part upload only the part currently streaming
    /// advances its mtime, so an earlier part of a long-running request goes stale
    /// while its request is still very much alive. This backdates a LIVE part past
    /// the age gate — the exact shape of that upload — and requires the sweep to
    /// leave it alone.
    #[tokio::test]
    async fn the_sweep_never_reclaims_a_part_this_process_owns() {
        let _root = TestRoot::new();
        // TWO parts held at once, deliberately. The registry exists for parts
        // 1..N-1 of a MULTI-part upload, and a single-part test cannot tell a set
        // from a single slot: replacing the `HashSet` with a one-entry
        // `Mutex<Option<PathBuf>>` (or clearing before each insert) would reintroduce
        // the exact defect this closes and still pass.
        let first = stage_payload(b"part one, written and now idle").await;
        let second = stage_payload(b"part two, still the streaming one").await;
        let first_path = first
            .path()
            .expect("a live part owns its path")
            .to_path_buf();
        let second_path = second
            .path()
            .expect("a live part owns its path")
            .to_path_buf();
        assert_ne!(first_path, second_path);

        // Backdate BOTH past the gate. The earlier part of a slow multi-part upload
        // looks exactly like this to the sweep: written, closed, and never touched
        // again until the whole request finishes.
        let aged = SystemTime::now() - TMP_UPLOAD_MAX_AGE - Duration::from_secs(60);
        filetime_set(&first_path, aged);
        filetime_set(&second_path, aged);
        sweep_stale_tmp_uploads().await;
        assert!(
            first_path.exists(),
            "the EARLIER of two held parts must survive — it is the one a single-slot \
             registry would drop, and the one a real multi-part upload holds longest"
        );
        assert!(second_path.exists(), "and so must the later one");

        // ...and once the owners drop them the paths are unowned again, so the sweep
        // would reclaim them if the guards had not already.
        drop(first);
        drop(second);
        assert!(
            !first_path.exists() && !second_path.exists(),
            "the guards unlink on drop"
        );
        std::fs::write(&first_path, b"now an orphan").unwrap();
        filetime_set(&first_path, aged);
        sweep_stale_tmp_uploads().await;
        assert!(
            !first_path.exists(),
            "the same path, once UNOWNED and aged, is exactly what the sweep is for"
        );
    }

    /// TEST-6 (ITEM-6) — the boot sweep reclaims an AGED orphan and leaves a fresh
    /// in-flight part alone. Both legs matter: a sweep that deleted a live upload's
    /// part would be a worse bug than the leak it fixes.
    #[tokio::test]
    async fn boot_sweep_reclaims_only_aged_orphans() {
        let _root = TestRoot::new();
        let dir = tmp_upload_dir();
        std::fs::create_dir_all(&dir).unwrap();

        let fresh = dir.join("fresh.part");
        std::fs::write(&fresh, b"in flight").unwrap();
        let aged = dir.join("aged.part");
        std::fs::write(&aged, b"orphan").unwrap();
        let other = dir.join("not-a-part.txt");
        std::fs::write(&other, b"unrelated").unwrap();

        // Backdate the orphan well past the age gate.
        let old = SystemTime::now() - TMP_UPLOAD_MAX_AGE - Duration::from_secs(60);
        filetime_set(&aged, old);
        filetime_set(&other, old);

        sweep_stale_tmp_uploads().await;

        assert!(!aged.exists(), "an aged orphan part is reclaimed");
        assert!(
            fresh.exists(),
            "a fresh (possibly in-flight) part is NOT touched"
        );
        assert!(other.exists(), "a non-`.part` file is never touched");
    }

    /// Set a file's mtime without pulling in a dependency for it.
    fn filetime_set(path: &Path, when: SystemTime) {
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(when).unwrap();
    }

    /// TEST-6 — a non-file field is REFUSED past the cap instead of being collected
    /// whole. This is the second unbounded allocation the fix had to remove: the
    /// `file` parts stream, but `groups`/`datatype`/`supporting`/`axis`/`kind` were
    /// still `Field::text()`, which has no ceiling of its own at all.
    ///
    /// Both legs matter. Under the cap the field must round-trip EXACTLY (a cap that
    /// truncated would silently corrupt a `groups` spec); over the cap it must be a
    /// NAMED 413, not a 400 and not an OOM.
    #[tokio::test]
    async fn a_text_field_is_capped_and_refused_by_name() {
        let _root = TestRoot::new();

        let ok_payload = "x".repeat(TEXT_FIELD_MAX_BYTES);
        let mut mp = multipart_of("groups", "", ok_payload.as_bytes());
        let mut field = mp.next_field().await.unwrap().unwrap();
        let got = read_text_capped(
            &mut field,
            "groups",
            "INVALID_GROUPS",
            "Failed to read groups",
        )
        .await
        .expect("a field exactly at the cap is accepted");
        assert_eq!(
            got, ok_payload,
            "an accepted field round-trips byte-for-byte"
        );

        let too_big = "y".repeat(TEXT_FIELD_MAX_BYTES + 1);
        let mut mp = multipart_of("groups", "", too_big.as_bytes());
        let mut field = mp.next_field().await.unwrap().unwrap();
        let err = read_text_capped(
            &mut field,
            "groups",
            "INVALID_GROUPS",
            "Failed to read groups",
        )
        .await
        .expect_err("a field one byte over the cap is refused");
        assert_eq!(
            err.status_code(),
            413,
            "the refusal is 413, not 400: {err:?}"
        );
        assert_eq!(
            err.error_code(),
            "UPLOAD_FIELD_TOO_LARGE",
            "the refusal is NAMED so a client can act on it"
        );
    }

    /// TEST-6 — a staging directory the server cannot write to yields the NAMED
    /// `507 UPLOAD_STORAGE_UNAVAILABLE`, not an opaque 500.
    ///
    /// This is the ENOSPC-class path. Real ENOSPC cannot be produced portably, so the
    /// two failures the OS DOES let a test induce are both exercised: a staging root
    /// that exists as a FILE (so `create_dir_all` fails) and a staging directory with
    /// no write permission (so `File::create` fails). Those are the first two of the
    /// four `storage_unavailable` sites; the mid-stream `write_all`/`flush` sites go
    /// through the same mapping but cannot be provoked portably, so this asserts the
    /// two it can rather than claiming to cover "any staging-write failure".
    #[tokio::test]
    async fn an_unwritable_staging_dir_is_a_named_507() {
        let dir = std::env::temp_dir().join(format!("txr-upload-noroom-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // Leg 1 — `create_dir_all` fails: the staging ROOT is a file.
        let as_file = dir.join("root-is-a-file");
        std::fs::write(&as_file, b"not a directory").unwrap();
        {
            let _guard = crate::modules::rootfs::scoped_data_root(as_file.clone());
            let mut mp = multipart_of("file", "x.bin", b"payload");
            let mut field = mp.next_field().await.unwrap().unwrap();
            let err = stage_multipart_field(&mut field)
                .await
                .expect_err("staging must fail when the staging dir cannot be created");
            assert_eq!(
                err.status_code(),
                507,
                "a staging-write failure is a named 507, not an opaque 500: {err:?}"
            );
            assert_eq!(err.error_code(), "UPLOAD_STORAGE_UNAVAILABLE");
        }

        // Leg 2 — `File::create` fails: the staging DIRECTORY exists but is read-only.
        //
        // DAC mode bits do not apply to uid 0, and do not apply to a NON-root process
        // holding CAP_DAC_OVERRIDE either — routine in containers with file
        // capabilities. Rather than trying to detect every way the bypass can happen,
        // the leg TESTS whether it happened: if the staging write unexpectedly
        // succeeds, the environment cannot express this failure and the leg is
        // skipped LOUDLY, instead of `expect_err` inverting into a spurious RED that
        // reads like a flake. The permission restore is an RAII guard, not a trailing
        // statement, so a firing assertion cannot leave a 0o500 directory the cleanup
        // then cannot unlink through.
        //
        // KNOWN LIMITATION: libtest captures a passing test's stderr, so that skip is
        // invisible without `--nocapture`. There is no skip primitive in libtest that
        // would make it visible without also failing, so leg 2 silently no-ops under
        // a DAC-bypassing process and leg 1 (which needs no permissions) is what
        // always runs. Stated here and in TESTS.md rather than left to be discovered.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ro_root = dir.join("root-read-only");
            let staging = ro_root.join(TMP_UPLOAD_DIR);
            std::fs::create_dir_all(&staging).unwrap();

            struct RestoreMode(PathBuf);
            impl Drop for RestoreMode {
                fn drop(&mut self) {
                    use std::os::unix::fs::PermissionsExt;
                    let _ =
                        std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
                }
            }
            let _restore = RestoreMode(staging.clone());
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o500)).unwrap();

            let _guard = crate::modules::rootfs::scoped_data_root(ro_root.clone());
            let mut mp = multipart_of("file", "y.bin", b"payload");
            let mut field = mp.next_field().await.unwrap().unwrap();
            match stage_multipart_field(&mut field).await {
                Err(err) => {
                    assert_eq!(err.status_code(), 507, "{err:?}");
                    assert_eq!(err.error_code(), "UPLOAD_STORAGE_UNAVAILABLE");
                }
                Ok(_) => eprintln!(
                    "an_unwritable_staging_dir_is_a_named_507: SKIPPING leg 2 — this \
                     process writes through a 0o500 directory (uid 0 or \
                     CAP_DAC_OVERRIDE), so the File::create failure cannot be induced \
                     here. Leg 1 (create_dir_all) still ran."
                ),
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TEST-6 — a consumed part reports no path.
    ///
    /// This is the NARROW half of the double-ingest question and it is labelled as
    /// such: it asserts the accessor's contract, not the handler's behaviour. The
    /// behavioural half — that calling `ingest_staged` twice returns a typed error
    /// rather than panicking — needs a real repository, so it lives in
    /// `tests/dataset/upload_streaming_test.rs::double_ingest_is_a_typed_error_not_a_panic`,
    /// which drives the production function. Asserting `disarm()` here and calling it
    /// proof of the handler would be exactly the hollow-test shape the audit exists
    /// to catch.
    #[tokio::test]
    async fn a_consumed_part_reports_no_path() {
        let _root = TestRoot::new();
        let mut staged = stage_payload(b"already ingested").await;
        let path = staged
            .path()
            .expect("a live part owns its temp path")
            .to_path_buf();
        let orphaned = staged
            .disarm()
            .expect("disarm hands back the path it dropped");
        assert_eq!(orphaned, path, "disarm returns the path it stopped owning");
        assert!(staged.path().is_none(), "a disarmed part owns no path");
        // `disarm` transfers ownership rather than deleting, so after it the file is
        // the CALLER's. In production `ingest_staged` has already renamed it away;
        // here nothing did, so the test unlinks it. (`TestRoot`'s own Drop would
        // remove the whole scoped data root anyway — this is tidiness at the point
        // ownership actually moves, not leak prevention.)
        let _ = std::fs::remove_file(&path);
    }

    /// TEST-6 — the tripwire on the ONE premise that makes `ingest_staged` equivalent
    /// to the SDK's `store_processed`: the injected processor produces no
    /// derivatives. `ingest_staged` structurally cannot run a `FileProcessor` (that
    /// seam takes `&[u8]`, which is the buffer being removed), so if this ever stops
    /// holding, the equivalence claim in this module's doc is false and uploads
    /// silently stop producing derivatives the store would otherwise have written.
    #[tokio::test]
    async fn noop_file_processor_is_still_a_no_op() {
        use txresbench_file::seams::FileProcessor as _;
        let processed = crate::modules::file::NoopFileProcessor
            .process(b"anything at all", "application/octet-stream")
            .await
            .expect("the no-op processor never fails");
        assert!(processed.text_pages.is_empty());
        assert!(processed.geometry_pages.is_empty());
        assert!(processed.thumbnails.is_empty());
        assert!(
            processed.images.is_empty(),
            "if the injected processor ever produces derivatives, `ingest_staged` \
             must stop claiming equivalence with `store_processed` — it cannot run \
             a byte-taking processor without reintroducing the whole-file buffer"
        );
        // `ingest_staged` persists `to_value(&ProcessingResult::default().metadata)`
        // as `processing_metadata`, so the METADATA half of the premise matters just
        // as much as the derivative half — a processor that started returning
        // non-default metadata would silently change every uploaded row.
        assert_eq!(
            serde_json::to_value(&processed.metadata).unwrap(),
            serde_json::to_value(txresbench_file::models::ProcessingResult::default().metadata).unwrap(),
            "the injected processor's metadata must still be the default that \
             `ingest_staged` writes"
        );
    }
}
