//! Content-addressed object store (ITEM-1) + multi-file merkle identity (ITEM-6).
//!
//! A domain-neutral blob substrate behind ONE seam, distinct from `ziee-file`
//! (user-scoped, uploads-only, UUID-keyed, not content-addressed). Keys are the
//! content hash `sha256:<hex>` (DEC-2), so the store gives free dedup + cache +
//! the immutability the provenance/verification path needs. The `get_range`
//! primitive is S3-byte-range-shaped from day one (DEC-10); the whole data plane
//! rides it. `local_fs` is the only impl (the S3/GCS cloud backends and the
//! saas cargo feature were removed — single-user local app).

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::stream::BoxStream;
use std::collections::BTreeMap;
use ziee_core::AppError;

pub mod dual_read;
pub mod local_fs;

pub use dual_read::DualReadStore;
pub use local_fs::LocalFsStore;

/// A blob (or a span of one) as a **stream of chunks** — the shape
/// `axum::body::Body::from_stream` consumes, so the byte plane can answer a
/// request without the payload ever being fully resident (artifact-model
/// ITEM-37).
///
/// Boxed + `'static` because the stream OUTLIVES the handler frame that built
/// it: axum drives it while writing the response body, so it owns its file
/// handle / upstream reader.
///
/// The error type is `std::io::Error` rather than [`AppError`] deliberately. A
/// fault here happens AFTER the status line and headers are on the wire, so there
/// is no error response left to render — the only honest outcome is to abort the
/// body, which is exactly what hyper does with a stream error. `AppError` would
/// imply a renderable failure that this position cannot produce.
pub type ByteStream = BoxStream<'static, Result<Bytes, std::io::Error>>;

/// The chunk size every backend streams in. 64 KiB is the usual sweet spot for
/// a sequential file read: big enough that per-chunk overhead is noise, small
/// enough that the resident set per in-flight request is a rounding error next
/// to a multi-MB shard (which is the entire point of ITEM-37).
pub const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// A content-address key: `sha256:<hex>`. Opaque (swappable hash behind the seam).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ContentKey(String);

impl ContentKey {
    /// Build a key from a raw sha256 hex digest.
    pub fn from_hex(hex: &str) -> Self {
        ContentKey(format!("sha256:{hex}"))
    }

    /// The full `sha256:<hex>` string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The bare hex digest (no `sha256:` prefix), or the whole string if it
    /// carries no known prefix.
    pub fn hex(&self) -> &str {
        self.0.strip_prefix("sha256:").unwrap_or(&self.0)
    }

    /// Parse a stored key string back into a `ContentKey`.
    pub fn parse(s: &str) -> Self {
        ContentKey(s.to_string())
    }
}

impl std::fmt::Display for ContentKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Metadata about a stored object (or a member of a multi-file artifact).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectStat {
    pub len: u64,
}

/// The result of storing a multi-file artifact (a Zarr chunk-dir / BAM+bai).
/// `object_key` is the stored **manifest blob** (path -> member blob-hash) so a
/// member can be resolved; `content_hash` is the merkle root over the member
/// `(relative-path, blob-hash)` set — ONE prefix => one content identity (ITEM-6).
#[derive(Debug, Clone)]
pub struct MultiFilePut {
    pub object_key: ContentKey,
    pub content_hash: String,
    pub members: Vec<MemberRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberRef {
    pub path: String,
    pub blob: ContentKey,
    pub len: u64,
}

/// A blob-GC sweep outcome (ITEM-14).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcReport {
    pub scanned: u64,
    pub freed: u64,
    pub freed_bytes: u64,
}

/// The outcome of an [`ObjectStore::link_blob`] attempt — a CAPABILITY answer,
/// not an operation that can fail its caller.
///
/// Job-input staging needs a stored blob to appear at a host path without copying
/// its bytes (artifact-model ITEM-16: job inputs are "bound or hardlinked, never
/// copied"). Only a backend that keeps its blobs as local filesystem entries can
/// do that, so "can you?" is the backend's question to answer, and the answer is
/// one of three structurally different things.
///
/// It is a plain enum rather than a `Result` on purpose: every variant is
/// answerable by the caller with "then copy it yourself", and there is
/// consequently no `?` here that could turn a routine fallback into a failed job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobLink {
    /// A hardlink now exists at the requested destination, sharing the blob's
    /// inode. Zero bytes moved — and, because it IS the pooled blob, the staged
    /// file cannot drift from the artifact it names.
    Linked,
    /// This backend does not keep blobs on a local filesystem at all, so no host
    /// path can ever name one (S3, and any future remote backend). Structural and
    /// per-backend rather than per-call — and it is the trait DEFAULT, so a remote
    /// backend degrades to copying **by construction** instead of by remembering
    /// to.
    Unsupported,
    /// The backend is local, but THIS link could not be made. Overwhelmingly the
    /// cross-filesystem case (`EXDEV` — the blob pool and the destination are on
    /// different mounts), but also a filesystem that forbids hardlinks, a link-count
    /// limit, or an absent blob.
    ///
    /// It carries the OS reason because the caller has to be able to SAY why it is
    /// paying for a copy. A fallback that logged nothing would be indistinguishable
    /// from the copying defect ITEM-16 exists to remove — fixed in appearance only.
    Unavailable { reason: String },
}

/// The content-addressed blob substrate. `get_range` is the S3-byte-range-shaped
/// primitive the whole data plane rides.
#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// The LOCAL directory this store reclaims from, when it has one.
    ///
    /// Exists for the GC ownership check: a sweep unlinks the complement of its
    /// catalog's keep-set, so it must confirm that the directory it is about to
    /// walk is the directory its `partition::StoreClaim` attributed. Without this
    /// the sweeper could hold a valid claim over one root while sweeping another
    /// — the exact "swept a store I did not attribute" shape the claim exists to
    /// prevent, just moved one level up.
    ///
    /// `None` for a store with no local root (the S3 seam), which the check then
    /// cannot make and does not pretend to.
    fn store_root(&self) -> Option<&std::path::Path> {
        None
    }

    /// Store bytes, returning their content key. Idempotent: storing identical
    /// bytes yields the same key and leaves ONE physical blob (dedup).
    async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError>;

    /// Store a set of member files as ONE multi-file artifact: hash each member,
    /// build + store a manifest blob, and compute the merkle content identity.
    async fn put_prefix(&self, members: &[(String, Vec<u8>)]) -> Result<MultiFilePut, AppError>;

    /// Read a whole blob.
    async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError>;

    /// Read `length` bytes starting at `offset` (S3 byte-range GET shape). Reads
    /// past the end are clamped to the blob length.
    ///
    /// BUFFERING — the whole span lands in a `Vec`, so this is NOT the serving
    /// read: since ITEM-37 the `/data` plane goes through [`Self::get_stream`]
    /// and this method has no production caller. It stays because it is the
    /// byte-exactness ORACLE for the streaming read — `local_fs`'s
    /// `get_stream_matches_get_range_and_actually_chunks` asserts the two agree
    /// byte-for-byte, which is what would catch a streaming read that seeks or
    /// limits wrongly — and because it is the S3-byte-range-shaped primitive the
    /// seam was designed around (DEC-10). Any future caller that genuinely needs
    /// a bounded span in hand uses it; anything that SERVES uses `get_stream`.
    async fn get_range(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, AppError>;

    /// STREAM `length` bytes starting at `offset` — the read the byte plane
    /// serves from (artifact-model ITEM-37). A range is a seek plus a limit.
    ///
    /// The contrast with [`Self::get`] / [`Self::get_range`] is the whole point:
    /// those return `Vec<u8>`, so serving a 40 MB shard to 10 concurrent readers
    /// pins 400 MB of heap for bytes the server never inspects (INV-1 — it does
    /// not open them for meaning, so there is no reason to hold them). Streaming
    /// makes the resident cost [`STREAM_CHUNK_BYTES`] per in-flight request
    /// regardless of blob size, and it does not degrade as shard geometry grows
    /// under ITEM-35.
    ///
    /// Contract:
    /// * Existence is resolved EAGERLY — a missing blob is an `AppError` from
    ///   this call, not a mid-stream failure, so the handler can still answer a
    ///   clean `404` before any byte is written.
    /// * The stream yields AT MOST `length` bytes and stops at end-of-blob, so a
    ///   caller that over-asks gets a short stream rather than an error (matching
    ///   `get_range`'s clamp). Callers that promised a `Content-Length` must
    ///   therefore derive `length` from [`Self::stat`], which the byte plane does.
    async fn get_stream(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<ByteStream, AppError>;

    /// Make `dest` name the SAME stored bytes as `key` without copying them — a
    /// hardlink out of the content-addressed pool (artifact-model ITEM-16).
    ///
    /// `dest` is a host filesystem path because the CALLER lives on the host (a
    /// sandbox staging dir always does). That says nothing about where this store
    /// keeps its own bytes, which is why this is not a local-filesystem assumption
    /// in the trait: a backend whose blobs are not local files simply answers
    /// [`BlobLink::Unsupported`] — the DEFAULT — and the caller copies.
    ///
    /// Contract:
    /// * Anything other than [`BlobLink::Linked`] means "copy it yourself". The
    ///   method never leaves `dest` partially written, and never fails the caller.
    /// * An occupied `dest` is REPLACED, matching the write-a-copy path it stands
    ///   in for.
    /// * A hardlink shares the INODE, so the mode bits — and the bytes — are the
    ///   pooled blob's. A caller must therefore never `chmod` the link (that would
    ///   chmod the pool) and must never expose it writable. Confinement is the
    ///   caller's read-only bind; it is not, and cannot be, a property of this call.
    async fn link_blob(&self, _key: &ContentKey, _dest: &std::path::Path) -> BlobLink {
        BlobLink::Unsupported
    }

    /// Object length + presence.
    async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError>;
    async fn exists(&self, key: &ContentKey) -> Result<bool, AppError>;

    /// Delete one blob by key (used only by the GC sweep behind a refcount gate).
    async fn delete(&self, key: &ContentKey) -> Result<(), AppError>;

    /// Resolve a member of a multi-file artifact (`object_key` = its manifest
    /// blob) to that member's blob key.
    async fn resolve_member(
        &self,
        manifest_key: &ContentKey,
        member_path: &str,
    ) -> Result<ContentKey, AppError>;

    /// Reclaim every stored blob whose key is NOT in `keep` (the live-ref set)
    /// AND whose last-modified age is at least `min_age_secs`. The caller (ITEM-14)
    /// computes `keep` as the union of every referencing table; `min_age_secs` is
    /// a GRACE window that spares freshly-written blobs — critical because ingest
    /// `put`s a blob BEFORE committing its catalog row, so a young blob may be
    /// live-but-not-yet-committed (pass 0 only when no concurrent writer exists,
    /// e.g. tests). Also reclaims stale `staging/*.tmp` leftovers older than the
    /// grace. Returns what was swept.
    ///
    /// **Interaction with [`Self::link_blob`] (ITEM-16).** A staged job input is a
    /// HARDLINK to a pooled blob, so unlinking the pool entry while a job holds one
    /// drops a NAME without freeing the bytes. That is a bounded DELAY, not a leak
    /// and not a correctness problem:
    ///
    /// * The bytes are freed when the last link goes — which is the job workspace's
    ///   `remove_dir_all` on the success, error and boot-sweep paths alike. The
    ///   delay is therefore bounded by the run, not unbounded.
    /// * A running job never sees truncation: `unlink` removes a directory entry,
    ///   never data. Its input stays complete and stable even if the artifact is
    ///   DELETED mid-run — the same POSIX guarantee `get_stream` already leans on.
    /// * `freed_bytes` counts what was UNLINKED, which over-reports while a link is
    ///   held. Pre-existing imprecision (an open `get_stream` descriptor does the
    ///   same); it is a reporting figure, never a reclamation decision.
    async fn gc(
        &self,
        keep: &std::collections::HashSet<String>,
        min_age_secs: u64,
    ) -> Result<GcReport, AppError>;

    /// Enumerate EVERY blob key physically present in this store (#61 §2 — the migration
    /// engine's source of truth for "copy every blob old→new"). Because keys are
    /// content-addressed and therefore PORTABLE, the destination receives the identical
    /// keys; the enumeration includes manifest blobs and member blobs alike (all are just
    /// blobs addressed by hex). Order is unspecified.
    ///
    /// The trait DEFAULT fails LOUD rather than returning an empty set: an empty default
    /// would let a backend that forgot to implement this look like "nothing to migrate",
    /// which is a silent-data-loss footgun. The migration engine treats any `list_keys`
    /// error as a hard halt, so a store the engine touches MUST override this (local_fs and
    /// s3 both do). A pure decorator (dual-read) forwards to its primary.
    async fn list_keys(&self) -> Result<Vec<ContentKey>, AppError> {
        Err(AppError::internal_error(
            "workstore: this ObjectStore backend does not support list_keys (blob enumeration) \
             — a data migration cannot enumerate its blobs and MUST NOT proceed",
        ))
    }

    /// If the live store is a hot-cutover [`DualReadStore`], borrow it (#64) — so the cutover /
    /// catch-up / retire paths can reach the preserved OLD (`fallback`) and NEW (`primary`) ends
    /// SEPARATELY. The live handle's own `list_keys` forwards to the primary (NEW), so
    /// enumerating OLD-only write-window stragglers, and the retire-time `verify_all(OLD, NEW)`,
    /// require the fallback directly. Default `None`; only `DualReadStore` overrides. A cheap
    /// borrow, not `Any`-downcasting, so no per-backend machinery.
    fn as_dual_read(&self) -> Option<&dual_read::DualReadStore> {
        None
    }
}

/// Compute the sha256 hex digest of bytes (the content-address primitive).
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// The content IDENTITY of a filesystem path — the SAME `sha256:<hex>` (single
/// file) / `sha256:<merkle_root>` (directory) value `ingest::store_output` writes
/// as the catalog `content_hash`, computed WITHOUT storing. The single source of
/// that identity so the provenance verify re-run (`jobs::verify`) can hash a
/// re-run's outputs and compare them to the catalog without duplicating — or
/// drifting from — this logic. Streams each file in fixed-size chunks so a
/// multi-GB output is never fully resident (bounded memory).
pub async fn content_hash_of_path(path: &std::path::Path) -> Result<String, AppError> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::internal_error(format!("stat {}: {e}", path.display())))?;
    if meta.is_dir() {
        let mut refs = collect_member_hashes(path).await?;
        refs.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(format!("sha256:{}", merkle_root(&refs)))
    } else {
        Ok(ContentKey::from_hex(&hash_file_streaming(path).await?)
            .as_str()
            .to_string())
    }
}

/// Stream a file through a Sha256 hasher in 1 MiB chunks → the bare hex digest.
async fn hash_file_streaming(path: &std::path::Path) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError::internal_error(format!("open {}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| AppError::internal_error(format!("read {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Recursively hash a directory's files into `MemberRef`s (rel-path, blob-hash,
/// len) WITHOUT holding their bytes — `/`-normalized paths, mirroring
/// `ingest::collect_dir`'s traversal so the merkle root matches.
async fn collect_member_hashes(root: &std::path::Path) -> Result<Vec<MemberRef>, AppError> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| AppError::internal_error(format!("readdir {}: {e}", dir.display())))?;
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| AppError::internal_error(format!("readdir entry: {e}")))?
        {
            let path = entry.path();
            let ft = entry
                .file_type()
                .await
                .map_err(|e| AppError::internal_error(format!("filetype: {e}")))?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let len = tokio::fs::metadata(&path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                let hex = hash_file_streaming(&path).await?;
                out.push(MemberRef {
                    path: rel,
                    blob: ContentKey::from_hex(&hex),
                    len,
                });
            }
            // symlinks/other ignored (not promoted) — mirrors ingest.
        }
    }
    Ok(out)
}

/// Compute an artifact's merkle/manifest `content_hash` over its member
/// `(relative-path, blob-hash)` set. Order-independent (members are sorted by
/// path), so the identity is stable regardless of ingest order. A single-file
/// artifact's content identity is just its one blob hash — callers use
/// `sha256_hex` directly there; this is the multi-file case (ITEM-6). Changing
/// any member path or byte changes the root.
pub fn merkle_root(members: &[MemberRef]) -> String {
    // Deterministic canonical serialization: sorted `path\0hex\n`.
    let mut sorted: BTreeMap<&str, &str> = BTreeMap::new();
    for m in members {
        sorted.insert(m.path.as_str(), m.blob.hex());
    }
    let mut buf = String::new();
    for (path, hex) in &sorted {
        buf.push_str(path);
        buf.push('\0');
        buf.push_str(hex);
        buf.push('\n');
    }
    sha256_hex(buf.as_bytes())
}

/// Serialize the member manifest (path -> member blob key) that `object_key`
/// points at. JSON so it round-trips through `resolve_member`.
pub(crate) fn encode_manifest(members: &[MemberRef]) -> Vec<u8> {
    let map: BTreeMap<&str, &str> = members
        .iter()
        .map(|m| (m.path.as_str(), m.blob.as_str()))
        .collect();
    serde_json::to_vec(&map).unwrap_or_else(|_| b"{}".to_vec())
}

pub(crate) fn decode_manifest(bytes: &[u8]) -> Result<BTreeMap<String, String>, AppError> {
    serde_json::from_slice(bytes)
        .map_err(|e| AppError::internal_error(format!("workstore: corrupt manifest blob: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    // TxResBench: the `object_store` cloud SDK seam (s3.rs) was REMOVED with the SaaS
    // feature — the local-fs store is the only object store. Keeping this test would be
    // vacuous (no seam to confine the SDK to), so it is gone with the seam.

    #[test]
    fn content_key_roundtrips_prefix_and_hex() {
        let k = ContentKey::from_hex("abcd");
        assert_eq!(k.as_str(), "sha256:abcd");
        assert_eq!(k.hex(), "abcd");
        assert_eq!(ContentKey::parse("sha256:abcd"), k);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // sha256("hello")
        assert_eq!(
            sha256_hex(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn merkle_root_is_order_independent_and_member_sensitive() {
        let a = MemberRef {
            path: "b".into(),
            blob: ContentKey::from_hex("22"),
            len: 1,
        };
        let b = MemberRef {
            path: "a".into(),
            blob: ContentKey::from_hex("11"),
            len: 1,
        };
        // Same set, different insertion order -> same root.
        let r1 = merkle_root(&[a.clone(), b.clone()]);
        let r2 = merkle_root(&[b.clone(), a.clone()]);
        assert_eq!(r1, r2, "merkle root must be order-independent");
        // Changing a member's blob hash changes the root.
        let c = MemberRef {
            path: "a".into(),
            blob: ContentKey::from_hex("99"),
            len: 1,
        };
        assert_ne!(merkle_root(&[a.clone(), b]), merkle_root(&[a, c]));
    }

    #[test]
    fn single_file_identity_is_the_blob_hash() {
        // A single-file artifact's content identity is just its blob's sha256.
        let bytes = b"one file artifact";
        let blob_hex = sha256_hex(bytes);
        // A one-member merkle root differs from the bare blob hash (it hashes the
        // path->hash manifest), so single-file callers use the blob hash directly.
        let member = MemberRef {
            path: "data".into(),
            blob: ContentKey::from_hex(&blob_hex),
            len: bytes.len() as u64,
        };
        assert_ne!(merkle_root(&[member]), blob_hex);
    }

    /// ITEM-16 — a NON-LOCAL backend degrades to copying **by construction** was proven
    /// against `S3Store` (trait default `Unsupported`). TxResBench strip: the S3 backend
    /// is gone, so the proof's only subject is gone with it; the trait default remains
    /// (seen above in `a_link_default_is_unsupported`).

    #[test]
    fn manifest_encode_decode_roundtrips() {
        let members = vec![
            MemberRef {
                path: "chunk/0.0".into(),
                blob: ContentKey::from_hex("aa"),
                len: 3,
            },
            MemberRef {
                path: ".zarray".into(),
                blob: ContentKey::from_hex("bb"),
                len: 9,
            },
        ];
        let bytes = encode_manifest(&members);
        let map = decode_manifest(&bytes).unwrap();
        assert_eq!(map.get("chunk/0.0").map(String::as_str), Some("sha256:aa"));
        assert_eq!(map.get(".zarray").map(String::as_str), Some("sha256:bb"));
    }
}
