//! Local-filesystem content-addressed store (ITEM-1). The reference `ObjectStore`
//! impl; every hardening primitive (symlink refusal, atomic staged writes) is
//! native here. Layout: `<root>/blobs/<aa>/<bb>/<full-hash>` (2-level fan-out);
//! writes are staged under `<root>/staging/` and atomically `rename`d, so a dead
//! key never appears half-written and an already-present key drops the temp (one
//! physical copy — dedup). Reuses ziee-file's `reject_if_symlink` hardening.

use async_trait::async_trait;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::fs;
use uuid::Uuid;
use ziee_core::AppError;

use super::{
    decode_manifest, encode_manifest, merkle_root, sha256_hex, BlobLink, ByteStream, ContentKey,
    GcReport, MemberRef, MultiFilePut, ObjectStat, ObjectStore, STREAM_CHUNK_BYTES,
};

// ── the decoded-manifest cache (artifact-model ITEM-34) ───────────────────────────
//
// `resolve_member` sits on the per-CHUNK path. ITEM-36 deliberately makes every chunk
// its own cacheable `GET`, so a client reading one multi-file artifact issues one
// member request per chunk — and each request used to read and JSON-decode the WHOLE
// manifest. Per-request cost was therefore O(members), and reading an artifact once
// cost O(members²).
//
// Measured (release build, this box), read + decode of an N-entry member manifest:
//
//        members   manifest   read+decode   transient
//                     bytes      per call   allocation
//             49       4 KB         17 us        8 KB
//            500      43 KB        104 us       86 KB
//          5,000     428 KB        2.3 ms      873 KB
//         50,000     4.2 MB       23.7 ms       8.7 MB
//        200,000    16.8 MB        117 ms        35 MB
//
// Two things follow, and the second is the one that decides it:
//
//  * The time is immaterial at the shape the writer helper aims for (~49 members,
//    ITEM-35) and dominant well before the shape THIS side actually permits.
//    `ingest::collect_dir` bounds a multi-file artifact by BYTES (8 GiB a member,
//    32 GiB in total) and by no member COUNT at all, and the file layout is chosen
//    by a contributed processor. ITEM-35's derivation lives in the writer helper —
//    it lowers the file count by convention, and this crate cannot enforce it. Left
//    alone, the server's per-request cost is set by a decision it does not make.
//  * The allocation defeats ITEM-37. `get_stream` exists so that serving bytes costs
//    constant memory regardless of blob size; resolution then allocated 8.7 MB in
//    front of a 64 KB chunk, once per CONCURRENT request. The bounded cache replaces
//    an unbounded-per-request transient with a bounded shared resident cost.
//
// The manifest blob is content-addressed and immutable, so its hash is an EXACT key
// and there is no invalidation problem — bytes that decoded differently would live
// under a different key, and `write_blob` refuses to overwrite an existing one. The
// cache is write-once-per-key, so the only question it has to answer well is how it
// is BOUNDED.

/// Hard ceiling on cached manifests. Bounds the entry COUNT, which the byte budget
/// below cannot: an empty (`{}`) or near-empty manifest weighs almost nothing, so a
/// byte budget alone would admit an unbounded number of map slots.
const MANIFEST_CACHE_MAX_ENTRIES: usize = 256;

/// Hard ceiling on cached manifest WEIGHT. Bounds the bytes, which the entry cap
/// cannot: 256 of the 200,000-member manifests above would hold ~9 GB.
///
/// 64 MiB is chosen so that the pathological case is the one that still gets relief —
/// a single manifest is cacheable up to the whole budget (~370k members), and it is a
/// ceiling rather than an allocation. At the ~49-member shape the entry cap binds
/// first and the real footprint is ~2 MB.
const MANIFEST_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Per-member bookkeeping charged on top of the two strings' own bytes: the two
/// `String` headers plus this entry's share of the `BTreeMap` nodes. Calibrated
/// against a counting global allocator over the table above (49 → 200,000 members
/// measured 90-92 bytes an entry beyond the character data); rounded UP so the
/// budget under-fills rather than over-fills.
const MANIFEST_ENTRY_OVERHEAD: usize = 96;

/// A decoded member manifest, shared by every request that resolves against it.
type Manifest = Arc<BTreeMap<String, String>>;

struct CachedManifest {
    members: Manifest,
    weight: usize,
    /// Monotonic use counter — the least-recently-used entry has the smallest.
    used: u64,
}

/// Bounded, content-keyed store of decoded manifests.
///
/// Keyed by the manifest blob's bare hex digest. Least-recently-used eviction; a
/// manifest whose weight exceeds the whole budget is served decoded but NOT stored,
/// so both ceilings are hard rather than best-effort.
#[derive(Default)]
struct ManifestCache {
    inner: Mutex<ManifestCacheInner>,
}

#[derive(Default)]
struct ManifestCacheInner {
    entries: HashMap<String, CachedManifest>,
    weight: usize,
    tick: u64,
}

/// Terse on purpose: a manifest holds one line per member, and a `Debug` that dumped
/// a cached 200,000-member map into a log line would be a defect of its own.
impl std::fmt::Debug for ManifestCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let g = self.lock();
        f.debug_struct("ManifestCache")
            .field("entries", &g.entries.len())
            .field("weight", &g.weight)
            .finish()
    }
}

impl ManifestCache {
    /// Poison-recovering: a panic while another caller held the lock leaves the map
    /// structurally intact (every mutation below is a whole insert/remove), and the
    /// contents are re-derivable from immutable blobs regardless. Refusing to serve
    /// for the life of the process would be the worse failure.
    fn lock(&self) -> std::sync::MutexGuard<'_, ManifestCacheInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The decoded manifest for `hex`, if cached. Marks it most-recently-used.
    fn get(&self, hex: &str) -> Option<Manifest> {
        let mut g = self.lock();
        g.tick += 1;
        let tick = g.tick;
        let e = g.entries.get_mut(hex)?;
        e.used = tick;
        Some(Arc::clone(&e.members))
    }

    /// Cache `members` under `hex`, evicting least-recently-used entries until both
    /// ceilings hold. A no-op when the entry alone cannot fit the budget.
    fn insert(&self, hex: &str, members: &Manifest) {
        let weight = hex.len()
            + members
                .iter()
                .map(|(p, k)| p.len() + k.len() + MANIFEST_ENTRY_OVERHEAD)
                .sum::<usize>();
        if weight > MANIFEST_CACHE_MAX_BYTES {
            return;
        }
        let mut g = self.lock();
        g.tick += 1;
        let used = g.tick;
        // Replacing an existing key must not double-count its weight.
        if let Some(old) = g.entries.remove(hex) {
            g.weight -= old.weight;
        }
        while g.entries.len() + 1 > MANIFEST_CACHE_MAX_ENTRIES
            || g.weight + weight > MANIFEST_CACHE_MAX_BYTES
        {
            // At most `MANIFEST_CACHE_MAX_ENTRIES` candidates, scanned only when an
            // insert is over a ceiling.
            let Some(victim) = g
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(e) = g.entries.remove(&victim) {
                g.weight -= e.weight;
            }
        }
        g.weight += weight;
        g.entries.insert(
            hex.to_string(),
            CachedManifest {
                members: Arc::clone(members),
                weight,
                used,
            },
        );
    }

    /// Drop `hex` if present — called when the blob it decoded from is reclaimed, so
    /// the cache does not pin the decoding of an artifact that no longer exists.
    fn invalidate(&self, hex: &str) {
        let mut g = self.lock();
        if let Some(e) = g.entries.remove(hex) {
            g.weight -= e.weight;
        }
    }

    #[cfg(test)]
    fn stats(&self) -> (usize, usize) {
        let g = self.lock();
        (g.entries.len(), g.weight)
    }
}

/// Filesystem content-addressed store rooted at `base`.
#[derive(Debug, Clone)]
pub struct LocalFsStore {
    base: PathBuf,
    /// Shared across clones on purpose — the process-wide store handle is an
    /// `Arc<dyn ObjectStore>` set once at boot, and a `Clone` that forked the cache
    /// would silently halve its hit rate. Two stores built independently over the
    /// SAME root do hold separate caches, which is harmless: each is a consistent
    /// view of immutable content.
    manifests: Arc<ManifestCache>,
}

impl LocalFsStore {
    pub fn new(base: impl AsRef<Path>) -> Self {
        Self {
            base: base.as_ref().to_path_buf(),
            manifests: Arc::new(ManifestCache::default()),
        }
    }

    fn blobs_dir(&self) -> PathBuf {
        self.base.join("blobs")
    }

    fn staging_dir(&self) -> PathBuf {
        self.base.join("staging")
    }

    /// `<root>/blobs/<aa>/<bb>/<full-hash>` for a hex digest.
    fn blob_path(&self, hex: &str) -> PathBuf {
        // Fan-out needs at least 4 hex chars; a short (test) hash degrades to a
        // flat name under a fixed shard rather than panicking.
        let (aa, bb) = if hex.len() >= 4 {
            (&hex[0..2], &hex[2..4])
        } else {
            ("00", "00")
        };
        self.blobs_dir().join(aa).join(bb).join(hex)
    }

    fn path_for_key(&self, key: &ContentKey) -> PathBuf {
        self.blob_path(key.hex())
    }

    async fn ensure_dir(path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::internal_error(format!("workstore: mkdir failed: {e}")))?;
        }
        Ok(())
    }

    /// Map a filesystem error on a blob path, **preserving the distinction
    /// between "this blob is not here" and "I could not read it"**.
    ///
    /// Collapsing the two is a data-loss bug rather than a cosmetic one. The GC
    /// keep-set is built by READING manifest blobs (`gc::members_of`), so an
    /// `EMFILE` / `EACCES` / `EIO` reported as `not_found` is indistinguishable
    /// from an artifact that genuinely has no members — and file-descriptor
    /// pressure is at its worst precisely when a sweep is walking the whole pool.
    /// A transient failure must never be able to present itself as an absence.
    ///
    /// A genuine `ENOENT` keeps the `not_found` mapping, because a missing blob is
    /// a real `404` for the byte plane.
    fn map_blob_io_err(path: &Path, e: std::io::Error) -> AppError {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::not_found("Blob")
        } else {
            tracing::error!(
                path = %path.display(),
                error = %e,
                kind = ?e.kind(),
                "workstore: blob read failed for a reason that is NOT absence"
            );
            AppError::internal_error(format!("workstore: blob read failed: {e}"))
        }
    }

    /// Refuse to read a path that is a symlink (mirrors ziee-file's F-15 guard).
    ///
    /// An error other than "not there" is refused too: a guard that cannot see
    /// what it is guarding has not cleared anything, and `Ok(())` on an unreadable
    /// `lstat` is the same "failure read as success" defect as the one above.
    async fn reject_if_symlink(path: &Path) -> Result<(), AppError> {
        match fs::symlink_metadata(path).await {
            Ok(meta) if meta.file_type().is_symlink() => {
                tracing::error!(path = %path.display(), "workstore: refusing to read a symlink blob path");
                Err(AppError::not_found("Blob"))
            }
            Ok(_) => Ok(()),
            // Absent: not this guard's business — the caller's own open reports it.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Self::map_blob_io_err(path, e)),
        }
    }

    /// Look one member path up in an already-decoded manifest. The single place the
    /// "no such member" answer is produced, so the cached and uncached paths cannot
    /// disagree about it.
    fn member_key(
        members: &BTreeMap<String, String>,
        member_path: &str,
    ) -> Result<ContentKey, AppError> {
        members
            .get(member_path)
            .map(|s| ContentKey::parse(s))
            .ok_or_else(|| AppError::not_found("Artifact member"))
    }

    /// Store bytes at a known hex key, atomically. Returns the byte length.
    async fn write_blob(&self, hex: &str, bytes: &[u8]) -> Result<(), AppError> {
        let final_path = self.blob_path(hex);
        // Dedup: content-addressed, so an existing key is byte-identical — keep it.
        if fs::try_exists(&final_path).await.unwrap_or(false) {
            return Ok(());
        }
        Self::ensure_dir(&final_path).await?;

        let staging = self.staging_dir();
        fs::create_dir_all(&staging).await.map_err(|e| {
            AppError::internal_error(format!("workstore: mkdir staging failed: {e}"))
        })?;
        let temp = staging.join(format!("{}.tmp", Uuid::new_v4()));
        fs::write(&temp, bytes).await.map_err(|e| {
            AppError::internal_error(format!("workstore: staged write failed: {e}"))
        })?;
        // Atomic within the same filesystem (staging + blobs share the root).
        match fs::rename(&temp, &final_path).await {
            Ok(()) => Ok(()),
            Err(_) if fs::try_exists(&final_path).await.unwrap_or(false) => {
                // A concurrent writer landed the same key first — drop our temp.
                let _ = fs::remove_file(&temp).await;
                Ok(())
            }
            Err(e) => {
                let _ = fs::remove_file(&temp).await;
                Err(AppError::internal_error(format!(
                    "workstore: rename failed: {e}"
                )))
            }
        }
    }
}

#[async_trait]
impl ObjectStore for LocalFsStore {
    fn store_root(&self) -> Option<&Path> {
        Some(&self.base)
    }

    async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
        let hex = sha256_hex(bytes);
        self.write_blob(&hex, bytes).await?;
        Ok(ContentKey::from_hex(&hex))
    }

    async fn put_prefix(&self, members: &[(String, Vec<u8>)]) -> Result<MultiFilePut, AppError> {
        let mut refs: Vec<MemberRef> = Vec::with_capacity(members.len());
        for (path, bytes) in members {
            let key = self.put(bytes).await?;
            refs.push(MemberRef {
                path: path.clone(),
                blob: key,
                len: bytes.len() as u64,
            });
        }
        let content_hash = merkle_root(&refs);
        // The manifest (path -> member blob key) is itself a content-addressed
        // blob; its key is the artifact's `object_key` so a member can be resolved.
        let manifest_bytes = encode_manifest(&refs);
        let object_key = self.put(&manifest_bytes).await?;
        Ok(MultiFilePut {
            object_key,
            content_hash,
            members: refs,
        })
    }

    async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
        let path = self.path_for_key(key);
        Self::reject_if_symlink(&path).await?;
        fs::read(&path)
            .await
            .map_err(|e| Self::map_blob_io_err(&path, e))
    }

    async fn get_range(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, AppError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
        let path = self.path_for_key(key);
        Self::reject_if_symlink(&path).await?;
        let mut file = fs::File::open(&path)
            .await
            .map_err(|e| Self::map_blob_io_err(&path, e))?;
        let total = file
            .metadata()
            .await
            .map_err(|e| AppError::internal_error(format!("workstore: stat failed: {e}")))?
            .len();
        if offset >= total {
            return Ok(Vec::new());
        }
        // Clamp the read to the blob length (S3 byte-range semantics).
        let end = offset.saturating_add(length).min(total);
        let to_read = (end - offset) as usize;
        file.seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| AppError::internal_error(format!("workstore: seek failed: {e}")))?;
        let mut buf = vec![0u8; to_read];
        file.read_exact(&mut buf)
            .await
            .map_err(|e| AppError::internal_error(format!("workstore: range read failed: {e}")))?;
        Ok(buf)
    }

    /// Seek + limit + hand the reader to `ReaderStream` — no intermediate buffer
    /// (ITEM-37). The open happens HERE, before the stream is returned, which is
    /// what makes two things true:
    ///
    /// * a missing/symlinked blob is a clean `AppError` (→ 404) instead of a
    ///   truncated body, and
    /// * the blob survives a concurrent GC sweep for the life of the stream —
    ///   on Unix the inode is kept alive by the open descriptor, so an `unlink`
    ///   mid-stream cannot corrupt the response. (See the GC note on
    ///   `data_api::stream_span`.)
    async fn get_stream(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<ByteStream, AppError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
        let path = self.path_for_key(key);
        Self::reject_if_symlink(&path).await?;
        let mut file = fs::File::open(&path)
            .await
            .map_err(|e| Self::map_blob_io_err(&path, e))?;
        if offset > 0 {
            file.seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| AppError::internal_error(format!("workstore: seek failed: {e}")))?;
        }
        // `.take(length)` is the LIMIT half of "a range is a seek plus a limit":
        // the reader ends at `length` bytes even though the file continues.
        let limited = file.take(length);
        Ok(Box::pin(tokio_util::io::ReaderStream::with_capacity(
            limited,
            STREAM_CHUNK_BYTES,
        )))
    }

    /// Hardlink the pooled blob into `dest` — the ITEM-16 fast path. One inode, no
    /// bytes moved, so staging a multi-GB Zarr costs `link(2)` per member instead
    /// of a full second copy of the artifact.
    ///
    /// Every failure becomes [`BlobLink::Unavailable`] carrying the OS reason
    /// rather than being swallowed. The dominant cause is `EXDEV` — the blob pool
    /// and the caller's destination on different mounts — and an operator who is
    /// silently paying a full copy per input has to be told which of the two to
    /// move. No error here is worth failing the caller over: the copy fallback is
    /// always correct, just expensive.
    ///
    /// Note this deliberately does NOT special-case `EXDEV`: a filesystem that
    /// refuses hardlinks, an `EMLINK` link-count ceiling and a missing blob all
    /// want exactly the same handling, and the reason string names whichever it was.
    async fn link_blob(&self, key: &ContentKey, dest: &Path) -> BlobLink {
        let path = self.path_for_key(key);
        // The same guard `get`/`get_stream` apply: a planted symlink in the pool
        // never gets to decide what a job's input is. (`hard_link` does not follow
        // symlinks, so this is defense-in-depth, not the only line.)
        if Self::reject_if_symlink(&path).await.is_err() {
            return BlobLink::Unavailable {
                reason: "blob path is a symlink".to_string(),
            };
        }
        // `hard_link` fails `EEXIST` on an occupied dest while the `write` path it
        // stands in for truncates — clear it so the two agree.
        let _ = fs::remove_file(dest).await;
        match fs::hard_link(&path, dest).await {
            Ok(()) => BlobLink::Linked,
            Err(e) => BlobLink::Unavailable {
                reason: e.to_string(),
            },
        }
    }

    async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError> {
        let path = self.path_for_key(key);
        Self::reject_if_symlink(&path).await?;
        let meta = fs::metadata(&path)
            .await
            .map_err(|e| Self::map_blob_io_err(&path, e))?;
        Ok(ObjectStat { len: meta.len() })
    }

    /// Presence — and ONLY presence. An io error that is not "absent" is
    /// propagated rather than reported as `false`: a caller asking "is this blob
    /// still there?" to decide whether to keep it must not be told "no" because
    /// the answer was unavailable.
    async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
        let path = self.path_for_key(key);
        match fs::try_exists(&path).await {
            Ok(v) => Ok(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Self::map_blob_io_err(&path, e)),
        }
    }

    /// Delete one blob by key. Also drops any cached decoding OF that blob: the
    /// decoded manifest is derived data, and keeping it after its source is
    /// reclaimed would pin bytes for an artifact that no longer exists.
    ///
    /// It is bookkeeping, not a correctness gate. A member request for a deleted
    /// artifact is already refused upstream — `serve_data_inner` loads and
    /// authorizes the catalog row BEFORE resolving, and the member blob a stale
    /// entry named would have been swept too — so a lingering entry could at worst
    /// move a 404 from resolution to the byte read.
    async fn delete(&self, key: &ContentKey) -> Result<(), AppError> {
        let path = self.path_for_key(key);
        self.manifests.invalidate(key.hex());
        match fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::internal_error(format!(
                "workstore: delete failed: {e}"
            ))),
        }
    }

    /// Resolve a member against the manifest blob, decoding it AT MOST ONCE per
    /// manifest per process (artifact-model ITEM-34 — see the cache above).
    ///
    /// A cache hit skips `get`, and therefore skips `reject_if_symlink`. That is
    /// strictly safer, not weaker: a hit reads no file at all, so there is no path
    /// for a planted symlink to be followed. The guard ran on the miss that
    /// populated the entry.
    ///
    /// Concurrent misses on the same key may each decode; the result is identical
    /// (content-addressed, immutable) and the last insert wins. Single-flighting
    /// would mean holding a lock across file I/O to save work that is already
    /// bounded to one decode per key per race.
    async fn resolve_member(
        &self,
        manifest_key: &ContentKey,
        member_path: &str,
    ) -> Result<ContentKey, AppError> {
        let hex = manifest_key.hex();
        if let Some(members) = self.manifests.get(hex) {
            return Self::member_key(&members, member_path);
        }
        let manifest_bytes = self.get(manifest_key).await?;
        let members: Manifest = Arc::new(decode_manifest(&manifest_bytes)?);
        self.manifests.insert(hex, &members);
        Self::member_key(&members, member_path)
    }

    async fn gc(&self, keep: &HashSet<String>, min_age_secs: u64) -> Result<GcReport, AppError> {
        let mut report = GcReport::default();

        // GRACE: never free a blob (or staging temp) younger than `min_age_secs` —
        // ingest `put`s a blob before committing its catalog row, so a young,
        // not-yet-in-`keep` blob may be live. `is_older_than` fails safe (keeps the
        // blob) if the mtime can't be read.
        let is_older_than = |modified: Option<std::time::SystemTime>| -> bool {
            if min_age_secs == 0 {
                return true;
            }
            match modified.and_then(|m| m.elapsed().ok()) {
                Some(age) => age.as_secs() >= min_age_secs,
                None => false,
            }
        };

        // Reclaim stale staging temps left by a crash between write and rename.
        let staging = self.staging_dir();
        if let Ok(mut sd) = fs::read_dir(&staging).await {
            while let Ok(Some(t)) = sd.next_entry().await {
                let meta = t.metadata().await.ok();
                if is_older_than(meta.as_ref().and_then(|m| m.modified().ok())) {
                    let _ = fs::remove_file(t.path()).await;
                }
            }
        }

        let blobs = self.blobs_dir();
        if !fs::try_exists(&blobs).await.unwrap_or(false) {
            return Ok(report);
        }
        // Two-level fan-out: blobs/<aa>/<bb>/<hex>.
        let mut l1 = match fs::read_dir(&blobs).await {
            Ok(d) => d,
            Err(_) => return Ok(report),
        };
        while let Ok(Some(a)) = l1.next_entry().await {
            let mut l2 = match fs::read_dir(a.path()).await {
                Ok(d) => d,
                Err(_) => continue,
            };
            while let Ok(Some(b)) = l2.next_entry().await {
                let mut l3 = match fs::read_dir(b.path()).await {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                while let Ok(Some(blob)) = l3.next_entry().await {
                    let Some(name) = blob.file_name().to_str().map(str::to_string) else {
                        continue;
                    };
                    report.scanned += 1;
                    let key = ContentKey::from_hex(&name);
                    if keep.contains(key.as_str()) {
                        continue;
                    }
                    let meta = blob.metadata().await.ok();
                    // Grace: skip blobs younger than the window (may be a
                    // live-but-uncommitted ingest write).
                    if !is_older_than(meta.as_ref().and_then(|m| m.modified().ok())) {
                        continue;
                    }
                    let len = meta.map(|m| m.len()).unwrap_or(0);
                    if fs::remove_file(blob.path()).await.is_ok() {
                        // Same reasoning as `delete`: the sweep reclaims the blob a
                        // cached manifest was decoded from, so drop the decoding
                        // with it. The sweep unlinks directly rather than going
                        // through `delete`, so this cannot be inherited from there.
                        self.manifests.invalidate(&name);
                        report.freed += 1;
                        report.freed_bytes += len;
                    }
                }
            }
        }
        Ok(report)
    }

    /// Enumerate every stored blob key by walking `blobs/<aa>/<bb>/<hex>` — the SAME
    /// two-level fan-out `gc` walks, but collecting keys instead of reclaiming. A missing
    /// `blobs/` dir (a never-written store) is an empty set, not an error.
    ///
    /// DATA-SAFETY (never a partial set masquerading as complete): unlike `gc` (which fails
    /// SAFE by skipping an unreadable subtree — a missed blob is merely not reclaimed), a
    /// migration that acts on a TRUNCATED enumeration would either under-copy (a `verified`
    /// with blobs missing) or, on a delete path, remove an unverified blob. So EVERY
    /// directory-read error here is PROPAGATED as `Err`, which the migration engine treats as
    /// a hard halt — it is never silently swallowed into a short `Ok`.
    async fn list_keys(&self) -> Result<Vec<ContentKey>, AppError> {
        let mut out = Vec::new();
        let blobs = self.blobs_dir();
        if !fs::try_exists(&blobs).await.unwrap_or(false) {
            return Ok(out);
        }
        let readdir = |p: PathBuf| async move {
            fs::read_dir(&p)
                .await
                .map_err(|e| AppError::internal_error(format!("workstore: list_keys read_dir {}: {e}", p.display())))
        };
        let mut l1 = readdir(blobs.clone()).await?;
        loop {
            let Some(a) = l1
                .next_entry()
                .await
                .map_err(|e| AppError::internal_error(format!("workstore: list_keys next_entry (l1): {e}")))?
            else {
                break;
            };
            let mut l2 = readdir(a.path()).await?;
            loop {
                let Some(b) = l2
                    .next_entry()
                    .await
                    .map_err(|e| AppError::internal_error(format!("workstore: list_keys next_entry (l2): {e}")))?
                else {
                    break;
                };
                let mut l3 = readdir(b.path()).await?;
                loop {
                    let Some(blob) = l3
                        .next_entry()
                        .await
                        .map_err(|e| AppError::internal_error(format!("workstore: list_keys next_entry (l3): {e}")))?
                    else {
                        break;
                    };
                    if let Some(name) = blob.file_name().to_str() {
                        // Only genuine content-addressed blob names (64-hex sha256) enter the
                        // migration set — a stray non-blob file under `blobs/` would otherwise
                        // fail content-hash verify and needlessly halt a whole migration.
                        if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
                            out.push(ContentKey::from_hex(name));
                        }
                    }
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (PathBuf, LocalFsStore) {
        let dir = std::env::temp_dir().join(format!("ws-test-{}", Uuid::new_v4()));
        (dir.clone(), LocalFsStore::new(dir))
    }

    async fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir).await;
    }

    // TEST-U8
    #[tokio::test]
    async fn list_keys_enumerates_every_stored_blob() {
        let (dir, s) = store();
        let mut expected = std::collections::HashSet::new();
        for i in 0..7u32 {
            let k = s.put(format!("lk-{i}").as_bytes()).await.unwrap();
            expected.insert(k.as_str().to_string());
        }
        let got: std::collections::HashSet<String> =
            s.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();
        assert_eq!(got, expected, "list_keys must return exactly the stored content-addressed keys");
        // A never-written store enumerates to empty, not an error.
        let (d2, s2) = store();
        assert!(s2.list_keys().await.unwrap().is_empty());
        cleanup(&dir).await;
        cleanup(&d2).await;
    }

    #[tokio::test]
    async fn put_is_content_addressed_stable_and_dedups() {
        let (dir, s) = store();
        let k1 = s.put(b"gene expression bytes").await.unwrap();
        let k2 = s.put(b"gene expression bytes").await.unwrap();
        assert_eq!(k1, k2, "identical bytes -> identical key");
        assert!(k1.as_str().starts_with("sha256:"));
        // Exactly one physical blob for the shared key (dedup).
        let path = s.path_for_key(&k1);
        assert!(path.exists());
        // Blob lands under the 2-level fan-out.
        let hex = k1.hex();
        assert!(path.ends_with(hex));
        assert!(path.starts_with(s.blobs_dir().join(&hex[0..2]).join(&hex[2..4])));
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn get_range_returns_exact_bytes_and_clamps() {
        let (dir, s) = store();
        let data: Vec<u8> = (0u8..32).collect();
        let k = s.put(&data).await.unwrap();
        assert_eq!(s.get_range(&k, 0, 4).await.unwrap(), vec![0, 1, 2, 3]);
        assert_eq!(s.get_range(&k, 8, 4).await.unwrap(), vec![8, 9, 10, 11]);
        // Suffix read clamps to the blob length.
        assert_eq!(s.get_range(&k, 30, 100).await.unwrap(), vec![30, 31]);
        // Offset past the end -> empty.
        assert!(s.get_range(&k, 999, 4).await.unwrap().is_empty());
        assert_eq!(s.stat(&k).await.unwrap().len, 32);
        cleanup(&dir).await;
    }

    /// ITEM-37 — the streaming read returns the SAME bytes `get_range` does, for
    /// the whole blob and for a span, and it CHUNKS (more than one frame for a
    /// payload larger than `STREAM_CHUNK_BYTES`). The chunk-count assertion is
    /// the one that would fail if someone "simplified" `get_stream` to
    /// `get_range` + `stream::once` — byte-equality alone cannot see that.
    #[tokio::test]
    async fn get_stream_matches_get_range_and_actually_chunks() {
        use futures_util::StreamExt;
        let (dir, s) = store();
        // 5 chunks' worth, plus a tail, so the last frame is short.
        let data: Vec<u8> = (0..(STREAM_CHUNK_BYTES * 5 + 137))
            .map(|i| (i % 251) as u8)
            .collect();
        let k = s.put(&data).await.unwrap();

        let drain = |mut st: ByteStream| async move {
            let (mut bytes, mut frames) = (Vec::new(), 0usize);
            while let Some(chunk) = st.next().await {
                let chunk = chunk.expect("stream chunk");
                frames += 1;
                bytes.extend_from_slice(&chunk);
            }
            (bytes, frames)
        };

        // Whole blob.
        let (got, frames) = drain(s.get_stream(&k, 0, data.len() as u64).await.unwrap()).await;
        assert_eq!(got, data, "streamed bytes == stored bytes");
        assert!(
            frames > 1,
            "a {}-byte blob must arrive in MORE than one frame, got {frames} — \
             a single-frame stream means the whole blob was buffered first",
            data.len()
        );

        // A mid-blob span == the same span from `get_range`.
        let (span, _) = drain(s.get_stream(&k, 1000, 4096).await.unwrap()).await;
        assert_eq!(span, s.get_range(&k, 1000, 4096).await.unwrap());

        // Over-asking past the end yields a SHORT stream, not an error (mirrors
        // `get_range`'s clamp).
        let (tail, _) = drain(
            s.get_stream(&k, data.len() as u64 - 10, 1_000_000)
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(tail, data[data.len() - 10..]);

        // A missing blob fails EAGERLY, so the caller can still answer 404.
        assert!(s
            .get_stream(&ContentKey::from_hex(&"ab".repeat(32)), 0, 1)
            .await
            .is_err());
        cleanup(&dir).await;
    }

    /// The GC/mid-stream race, in the only form that can actually happen on Unix:
    /// the blob is UNLINKED after the stream opened. The open descriptor keeps the
    /// inode alive, so the response completes with the correct bytes rather than
    /// truncating. This is what lets the byte plane promise a `Content-Length` it
    /// can keep.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_blob_unlinked_mid_stream_still_completes() {
        use futures_util::StreamExt;
        let (dir, s) = store();
        let data: Vec<u8> = (0..(STREAM_CHUNK_BYTES * 3))
            .map(|i| (i % 7) as u8)
            .collect();
        let k = s.put(&data).await.unwrap();

        let mut st = s.get_stream(&k, 0, data.len() as u64).await.unwrap();
        // Pull one frame so the read is genuinely in flight, THEN delete.
        let first = st.next().await.expect("first frame").expect("ok");
        s.delete(&k).await.unwrap();
        assert!(!s.exists(&k).await.unwrap(), "the blob is gone from disk");

        let mut got = first.to_vec();
        while let Some(chunk) = st.next().await {
            got.extend_from_slice(&chunk.expect("stream survives the unlink"));
        }
        assert_eq!(got, data, "the in-flight stream still delivers every byte");
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn put_prefix_builds_manifest_and_resolves_members() {
        let (dir, s) = store();
        let members = vec![
            (".zarray".to_string(), b"{\"shape\":[10]}".to_vec()),
            ("chunk/0".to_string(), vec![1u8, 2, 3, 4]),
        ];
        let put = s.put_prefix(&members).await.unwrap();
        assert_eq!(put.members.len(), 2);
        // Resolve a member back to its blob + read it.
        let chunk_key = s.resolve_member(&put.object_key, "chunk/0").await.unwrap();
        assert_eq!(s.get(&chunk_key).await.unwrap(), vec![1, 2, 3, 4]);
        // A missing member is a not-found.
        assert!(s.resolve_member(&put.object_key, "nope").await.is_err());
        cleanup(&dir).await;
    }

    /// Build a manifest of `n` synthetic members, as `put_prefix` would.
    fn synthetic_manifest(n: usize) -> Manifest {
        Arc::new(
            (0..n)
                .map(|i| {
                    (
                        format!("X/c/0/0/{i}"),
                        ContentKey::from_hex(&format!("{i:064x}"))
                            .as_str()
                            .to_string(),
                    )
                })
                .collect(),
        )
    }

    /// artifact-model ITEM-34 — the decoded manifest is CONSULTED, not merely
    /// stored. Unlinking the manifest blob behind the store's back (directly, so
    /// `delete`'s invalidation does not run) leaves the cache as the only possible
    /// source of an answer, and a DIFFERENT member is asked for so a per-result
    /// memo could not stand in for a decoded map.
    ///
    /// The second artifact is the negative control: its manifest is unlinked the
    /// same way but was never resolved, so it must FAIL. Without it this passes on a
    /// store that stopped needing manifests at all.
    #[tokio::test]
    async fn a_cached_manifest_is_consulted_and_not_re_read() {
        let (dir, s) = store();
        let members: Vec<(String, Vec<u8>)> = (0..8)
            .map(|i| (format!("c/{i}"), vec![i as u8; 4]))
            .collect();
        let warmed = s.put_prefix(&members).await.unwrap();
        let cold = s
            .put_prefix(&[("c/0".to_string(), vec![99u8; 4])])
            .await
            .unwrap();

        // One resolve decodes + caches `warmed`. `cold` is never touched.
        assert_eq!(
            s.get(&s.resolve_member(&warmed.object_key, "c/0").await.unwrap())
                .await
                .unwrap(),
            vec![0u8; 4]
        );

        // Unlink both manifest blobs WITHOUT going through `delete`.
        for k in [&warmed.object_key, &cold.object_key] {
            fs::remove_file(s.path_for_key(k)).await.unwrap();
            assert!(!s.exists(k).await.unwrap());
        }

        // A DIFFERENT member of the warmed artifact still resolves, and to the right
        // blob — the decoded map answered, with no manifest read left to do.
        let k5 = s
            .resolve_member(&warmed.object_key, "c/5")
            .await
            .expect("a cached manifest answers without re-reading the blob");
        assert_eq!(s.get(&k5).await.unwrap(), vec![5u8; 4]);
        // Absence is still absence: a cached manifest does not answer for a member
        // it never held.
        assert!(s.resolve_member(&warmed.object_key, "nope").await.is_err());

        // NEGATIVE CONTROL — never resolved, so nothing cached it.
        assert!(
            s.resolve_member(&cold.object_key, "c/0").await.is_err(),
            "an un-warmed manifest MUST fail once its blob is gone — otherwise the \
             assertion above proves nothing about the cache"
        );
        cleanup(&dir).await;
    }

    /// The cache is bounded on BOTH axes. An unbounded map keyed by content hash is
    /// a leak, and either cap alone is unbounded in the dimension it cannot see.
    #[test]
    fn the_manifest_cache_is_bounded_on_both_axes() {
        // Entry cap: tiny manifests weigh ~nothing, so only the count can stop them.
        let c = ManifestCache::default();
        let tiny = synthetic_manifest(1);
        for i in 0..(MANIFEST_CACHE_MAX_ENTRIES * 4) {
            c.insert(&format!("{i:064x}"), &tiny);
        }
        let (entries, weight) = c.stats();
        assert_eq!(entries, MANIFEST_CACHE_MAX_ENTRIES, "entry cap holds");
        assert!(weight <= MANIFEST_CACHE_MAX_BYTES);

        // Byte cap: heavy manifests exhaust the budget long before the entry cap.
        let c = ManifestCache::default();
        let heavy = synthetic_manifest(60_000);
        for i in 0..64 {
            c.insert(&format!("{i:064x}"), &heavy);
        }
        let (entries, weight) = c.stats();
        assert!(
            weight <= MANIFEST_CACHE_MAX_BYTES,
            "byte budget holds ({weight} > {MANIFEST_CACHE_MAX_BYTES})"
        );
        assert!(
            entries < 64,
            "the byte budget must have evicted; {entries} of 64 survived"
        );

        // Most-recently inserted survives (least-recently-used is what leaves).
        assert!(c.get(&format!("{:064x}", 63)).is_some());

        // Re-inserting a key must not double-count its weight.
        let c = ManifestCache::default();
        let m = synthetic_manifest(100);
        c.insert("aa", &m);
        let (_, once) = c.stats();
        c.insert("aa", &m);
        let (entries, twice) = c.stats();
        assert_eq!(
            (entries, twice),
            (1, once),
            "re-insert is idempotent in weight"
        );
    }

    /// A manifest too big for the whole budget is served but NOT stored, so the
    /// ceiling is hard rather than best-effort.
    #[test]
    fn an_oversized_manifest_is_not_cached_at_all() {
        let c = ManifestCache::default();
        // ~96 bytes of bookkeeping per member alone puts this past the budget.
        let huge = synthetic_manifest(MANIFEST_CACHE_MAX_BYTES / MANIFEST_ENTRY_OVERHEAD + 1);
        c.insert("bb", &huge);
        assert_eq!(c.stats(), (0, 0), "over-budget manifest is refused entry");
        assert!(c.get("bb").is_none());
    }

    /// Reclaiming a blob drops the decoding derived from it — via `delete`, and via
    /// the sweep, which unlinks directly and so cannot inherit `delete`'s handling.
    #[tokio::test]
    async fn reclaiming_a_manifest_blob_drops_its_cached_decoding() {
        let (dir, s) = store();
        let put = s
            .put_prefix(&[("c/0".to_string(), vec![7u8; 4])])
            .await
            .unwrap();
        s.resolve_member(&put.object_key, "c/0").await.unwrap();
        assert!(s.manifests.get(put.object_key.hex()).is_some());
        s.delete(&put.object_key).await.unwrap();
        assert!(
            s.manifests.get(put.object_key.hex()).is_none(),
            "delete drops the cached decoding"
        );

        // And again through the sweep, which never calls `delete`.
        let put = s
            .put_prefix(&[("c/1".to_string(), vec![8u8; 4])])
            .await
            .unwrap();
        s.resolve_member(&put.object_key, "c/1").await.unwrap();
        assert!(s.manifests.get(put.object_key.hex()).is_some());
        s.gc(&HashSet::new(), 0).await.unwrap();
        assert!(
            s.manifests.get(put.object_key.hex()).is_none(),
            "the sweep drops the cached decoding too"
        );
        cleanup(&dir).await;
    }

    #[tokio::test]
    async fn gc_frees_only_unreferenced_blobs() {
        let (dir, s) = store();
        let keep = s.put(b"referenced").await.unwrap();
        let orphan = s.put(b"orphaned").await.unwrap();
        let mut live = HashSet::new();
        live.insert(keep.as_str().to_string());
        // min_age 0: no concurrent writer in the test → immediate reclaim.
        let report = s.gc(&live, 0).await.unwrap();
        assert_eq!(report.freed, 1, "exactly the orphan is freed");
        assert!(s.exists(&keep).await.unwrap(), "referenced blob survives");
        assert!(!s.exists(&orphan).await.unwrap(), "orphan is gone");
        cleanup(&dir).await;
    }

    /// ITEM-16 — `link_blob` produces the SAME INODE, not a copy, and the whole
    /// lifecycle story that follows from that.
    ///
    /// Inode identity is the only assertion that can tell a link from a copy: a
    /// byte-equality check passes for BOTH, which is exactly how the copying
    /// defect this replaces survived review.
    #[cfg(unix)]
    #[tokio::test]
    async fn link_blob_shares_the_inode_and_survives_pool_deletion() {
        use std::os::unix::fs::MetadataExt;
        let (dir, s) = store();
        let data: Vec<u8> = (0..50_000).map(|i| (i % 251) as u8).collect();
        let k = s.put(&data).await.unwrap();
        let pool = s.path_for_key(&k);

        let staged = dir.join("staged.bin");
        assert_eq!(s.link_blob(&k, &staged).await, BlobLink::Linked);

        // THE assertion: one inode, two names. Not "the bytes match" — a copy
        // matches too.
        let (pm, sm) = (
            fs::metadata(&pool).await.unwrap(),
            fs::metadata(&staged).await.unwrap(),
        );
        assert_eq!(
            sm.ino(),
            pm.ino(),
            "staged file IS the pooled blob (same inode)"
        );
        assert_eq!(sm.dev(), pm.dev(), "…on the same device");
        assert_eq!(sm.nlink(), 2, "exactly two names for one inode");
        assert_eq!(
            fs::read(&staged).await.unwrap(),
            data,
            "and it reads the stored bytes"
        );

        // ENTITY LIFECYCLE — the artifact is deleted (or GC unlinks the pool entry)
        // while a job still holds the link. `unlink` drops a NAME, never bytes, so
        // the reader sees a STABLE, complete file — never a truncated one. This is
        // the same POSIX guarantee `a_blob_unlinked_mid_stream_still_completes`
        // relies on, and it is why hardlinking is SAFER here than copying rather
        // than merely cheaper.
        s.delete(&k).await.unwrap();
        assert!(!s.exists(&k).await.unwrap(), "the pool entry is gone");
        let after = fs::metadata(&staged).await.unwrap();
        assert_eq!(after.nlink(), 1, "one name left — the job's");
        assert_eq!(
            fs::read(&staged).await.unwrap(),
            data,
            "the in-flight job still reads every byte after the blob was reclaimed"
        );

        // GC ACCOUNTING — and the converse: dropping the job's link (what
        // `remove_dir_all(workspace)` does at the end of a run) is what actually
        // frees the bytes. So a pool unlink while a link is held is a bounded
        // DELAY, not a leak: the delay ends when the workspace does.
        fs::remove_file(&staged).await.unwrap();
        assert!(!fs::try_exists(&staged).await.unwrap());

        cleanup(&dir).await;
    }

    /// ITEM-16 — an occupied destination is REPLACED, matching the `fs::write`
    /// path `link_blob` stands in for. Without this a re-staged input would fail
    /// `EEXIST` where the copy silently truncated.
    #[cfg(unix)]
    #[tokio::test]
    async fn link_blob_replaces_an_occupied_destination() {
        use std::os::unix::fs::MetadataExt;
        let (dir, s) = store();
        let k = s.put(b"the real bytes").await.unwrap();
        let dest = dir.join("occupied.bin");
        fs::create_dir_all(&dir).await.unwrap();
        fs::write(&dest, b"stale leftovers").await.unwrap();

        assert_eq!(s.link_blob(&k, &dest).await, BlobLink::Linked);
        assert_eq!(fs::read(&dest).await.unwrap(), b"the real bytes");
        assert_eq!(
            fs::metadata(&dest).await.unwrap().ino(),
            fs::metadata(s.path_for_key(&k)).await.unwrap().ino(),
        );
        cleanup(&dir).await;
    }

    /// ITEM-16 — the CROSS-FILESYSTEM fallback is DETECTED and carries a reason.
    ///
    /// Non-vacuous either way: when the host really does offer a second filesystem
    /// (`/dev/shm` is a tmpfs on Linux) this asserts the `EXDEV` refusal and that
    /// the reason names it; when it does not, it asserts the link SUCCEEDS. There
    /// is no branch here that passes by asserting nothing.
    #[cfg(unix)]
    #[tokio::test]
    async fn link_blob_reports_a_reason_when_it_cannot_link() {
        use std::os::unix::fs::MetadataExt;
        let (dir, s) = store();
        let k = s.put(b"cross-device candidate").await.unwrap();
        let pool_dev = fs::metadata(s.path_for_key(&k)).await.unwrap().dev();

        let other = PathBuf::from("/dev/shm");
        if let Ok(m) = fs::metadata(&other).await {
            let dest = other.join(format!("cyto-xdev-{}", Uuid::new_v4()));
            let got = s.link_blob(&k, &dest).await;
            if m.dev() == pool_dev {
                assert_eq!(got, BlobLink::Linked, "same device → it links");
            } else {
                match got {
                    BlobLink::Unavailable { reason } => assert!(
                        !reason.is_empty(),
                        "a cross-filesystem refusal must SAY why — a silent fallback \
                         is indistinguishable from the copying defect"
                    ),
                    other => panic!("cross-device link must be refused, got {other:?}"),
                }
                assert!(
                    !fs::try_exists(&dest).await.unwrap(),
                    "nothing partial left behind"
                );
            }
            let _ = fs::remove_file(&dest).await;
        }

        // An ABSENT blob takes the same road — reported, never panicked, so the
        // caller's copy path produces the real `not_found`.
        let missing = ContentKey::from_hex(&"ab".repeat(32));
        assert!(matches!(
            s.link_blob(&missing, &dir.join("nope")).await,
            BlobLink::Unavailable { .. }
        ));
        cleanup(&dir).await;
    }

    /// A TRANSPORT failure must not be reportable as an ABSENCE.
    ///
    /// This is a data-loss guard, not an HTTP-status nicety. `gc::members_of`
    /// enumerates a multi-file artifact's members by READING its manifest blob, so
    /// a read that says "not found" when it means "I could not read it" is
    /// indistinguishable from an artifact with no members — and the sweep unlinks
    /// by the complement of the keep-set. The blocked read that matters in
    /// production is `EMFILE` (descriptor exhaustion), which is at its most likely
    /// while a sweep walks the whole pool; `EISDIR` is used here because it is the
    /// non-absence io error a test can produce deterministically and without
    /// privileges. Both take the same branch: `ErrorKind != NotFound`.
    ///
    /// Pre-fix, `get` mapped EVERY io error through `map_err(|_| not_found)`, so
    /// the second half of this test failed.
    #[tokio::test]
    async fn a_transport_error_is_not_reported_as_an_absence() {
        let (dir, s) = store();

        // (1) genuine absence → the not-found mapping is preserved.
        let missing = ContentKey::from_hex(&"cd".repeat(32));
        let err = s.get(&missing).await.unwrap_err();
        assert_eq!(err.status_code(), 404, "a truly absent blob is still a 404");
        assert_eq!(err.error_code(), "RESOURCE_NOT_FOUND");

        // (2) present-but-unreadable → NOT an absence. A directory occupies the
        // blob path, so `read` fails `EISDIR` while the key is emphatically there.
        let key = ContentKey::from_hex(&"ef".repeat(32));
        let path = s.path_for_key(&key);
        fs::create_dir_all(&path).await.unwrap();
        let err = s.get(&key).await.unwrap_err();
        assert_ne!(
            err.status_code(),
            404,
            "an UNREADABLE blob reported as absent is what lets the GC sweep treat a \
             live artifact as memberless and free its blobs: {err}"
        );
        assert_ne!(err.error_code(), "RESOURCE_NOT_FOUND");
        assert_eq!(err.status_code(), 500);

        // …and the same distinction on the presence probe: "I could not tell" is
        // never answered as "it is not there".
        assert!(
            !s.exists(&missing).await.unwrap(),
            "absent → false, not an error"
        );

        cleanup(&dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn get_refuses_to_follow_a_symlink() {
        let (dir, s) = store();
        let k = s.put(b"real").await.unwrap();
        let path = s.path_for_key(&k);
        let secret = dir.join("secret");
        fs::write(&secret, b"TOP SECRET").await.unwrap();
        fs::remove_file(&path).await.unwrap();
        std::os::unix::fs::symlink(&secret, &path).unwrap();
        assert!(s.get(&k).await.is_err(), "a symlinked blob must be refused");
        cleanup(&dir).await;
    }
}
