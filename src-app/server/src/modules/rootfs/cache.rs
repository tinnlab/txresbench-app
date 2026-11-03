//! Content-digest-keyed rootfs extraction cache (ITEM-22 / DEC-17).
//!
//! The extraction cache lives at `<app_data>/sandbox-rootfs/<full-digest>/rootfs.squashfs`
//! (`embedded.rs` writes the embedded binary's own digest dir; a run pins the
//! digest that ran — `provenance::capture::env_digest_rootfs`). Keying by CONTENT
//! DIGEST (not schema version) means different rootfs versions COEXIST: an app
//! update extracts its new digest dir and KEEPS the already-extracted old one, so
//! a run pinned to an older digest stays reproducible/verifiable from the local
//! cache. This module is the CONTRACT surface the provenance/reproduce siblings
//! call:
//!
//! - [`has_digest`] — is a digest present (mountable/servable) in the local cache?
//! - [`squashfs_path_for`] — the placement path for a digest's squashfs.
//! - [`gc_unreferenced`] — bounded, in-use-safe eviction (see below).
//!
//! The serve-by-digest endpoint (`GET /api/sandbox/rootfs/{digest}`) and
//! mount-by-digest (`super::ensure_ready_by_digest`) both resolve through here.
//!
//! # Why this cache needs a BOUND, not just reference counting (#154)
//!
//! The growth driver is NOT the embedded rootfs (a permanent 0-byte stub in normal
//! builds — see `embedded.rs`). It is FETCH-NEWEST (DEC-I): `OciEnvImageProvider`
//! re-resolves the MOVING tag `schema<N>-latest-<arch>` on every run, so each
//! REPUBLISH of the env image stages one more ~300 MB digest dir here, forever.
//!
//! Reference counting alone ("keep every digest some run pins") cannot bound that:
//! each republish acquires runs that pin it, so after N republishes all N digests
//! are referenced permanently and the keep-set grows without limit. The retention
//! rule is therefore PROTECTED ∪ (a bounded, recency-ordered tail) — see
//! [`plan_eviction`] for the exact policy and [`MAX_CACHED_DIGESTS_DEFAULT`] for
//! the cap.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// A full rootfs content digest is a 64-char lowercase hex sha256. Validating it
/// before it ever reaches the filesystem is the path-traversal guard for the
/// serve endpoint (`{digest}` is model-/reproducer-supplied).
pub fn is_valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `<app_data>/sandbox-rootfs/` — the same base `embedded.rs` extracts under.
pub fn base_dir() -> PathBuf {
    super::embedded::base_dir()
}

/// `<app_data>/sandbox-rootfs/<digest>/` — the per-digest cache dir (its `mnt/`
/// mount point lives here too). Callers MUST pass a validated digest.
pub fn digest_dir(digest: &str) -> PathBuf {
    base_dir().join(digest)
}

/// The placement path for a digest's squashfs:
/// `<app_data>/sandbox-rootfs/<digest>/rootfs.squashfs`. This is exactly the path
/// a reproduce capsule's `environments.json` `placement` maps to, and what the
/// serve endpoint streams.
pub fn squashfs_path_for(digest: &str) -> PathBuf {
    digest_dir(digest).join("rootfs.squashfs")
}

/// True when a digest's squashfs is present (non-empty) in the local cache — i.e.
/// it can be mounted-by-digest or served. Invalid digests are never present (no
/// filesystem hit). This is the CONTRACT `has_digest` the provenance sibling's
/// `readiness`/`environments.json` call.
pub fn has_digest(digest: &str) -> bool {
    if !is_valid_digest(digest) {
        return false;
    }
    std::fs::metadata(squashfs_path_for(digest))
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Every digest currently extracted under an EXPLICIT base dir, with each one's
/// recency key (the squashfs mtime — when the digest was staged into, or last
/// replaced in, the cache). A cached digest = a subdir whose name is a valid
/// digest and which holds a non-empty `rootfs.squashfs`; an unreadable mtime
/// sorts oldest (`0`), so a damaged entry is evicted first rather than pinned
/// forever.
///
/// The base dir is an argument, not [`base_dir`], so a GC test can run against an
/// isolated temp dir and never touch the shared cache. The `pub` no-argument
/// `list_cached_digests` wrapper that used to sit on top of this was deleted with
/// #154: it had no consumer, and the one it was written for ([`gc_unreferenced`])
/// needs the recency key this returns.
fn list_cached_in(base: &Path) -> Vec<CachedDigest> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(base) else {
        return out;
    };
    for entry in entries.flatten() {
        let fname = entry.file_name();
        let Some(name) = fname.to_str() else { continue };
        if !is_valid_digest(name) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(base.join(name).join("rootfs.squashfs")) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let recency = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(CachedDigest {
            digest: name.to_string(),
            recency,
        });
    }
    out
}

/// Default retention cap: how many digest dirs the cache keeps IN TOTAL once the
/// protected set is satisfied. Four ≈ the live digest plus three historical ones
/// ≈ 1.2 GB at the ~300 MB/digest this deployment measures — enough that an
/// in-flight reproduce of a recent run still hits the local cache, small enough
/// that a year of republishes cannot fill a disk. An operator whose reproduce
/// window is longer raises it with `CYTO_ROOTFS_CACHE_MAX_DIGESTS`.
pub const MAX_CACHED_DIGESTS_DEFAULT: usize = 4;

/// The configured retention cap. Release-honored (this is a capacity knob, not a
/// security seam, so it is deliberately NOT `cfg!(debug_assertions)`-gated).
/// A malformed or zero value falls back to the default — a cap of 0 would ask the
/// GC to evict the digest currently being run on.
pub fn max_cached_digests() -> usize {
    std::env::var("CYTO_ROOTFS_CACHE_MAX_DIGESTS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(MAX_CACHED_DIGESTS_DEFAULT)
}

/// One cached digest as the eviction planner sees it: its name and its recency
/// key (the squashfs mtime, seconds since the epoch; 0 when unreadable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedDigest {
    /// The 64-hex content digest (the cache subdir name).
    pub digest: String,
    /// Recency key — higher is newer. Ties break on the digest name so the plan
    /// is deterministic.
    pub recency: i64,
}

/// The PURE eviction policy (no filesystem, no clock — this is the whole decision
/// and it is unit-testable in isolation). Returns the digests to evict.
///
/// Retention order, highest priority first:
///
/// 1. **`protected`** — kept unconditionally, and NOT charged against the cap. A
///    digest is protected when it is currently mounted, when it is the digest the
///    env-image provider last resolved (the one a run is about to execute on), or
///    when it is the embedded digest of a non-stub build. Evicting any of these
///    would pull a rootfs out from under a running sandbox, so the cap must never
///    be able to reach them — this is why `max` bounds only the UNPROTECTED tail.
/// 2. **referenced**, newest first — a digest some extant run pins. Kept in
///    preference to an unreferenced one because losing it costs a reproduce.
/// 3. **unreferenced**, newest first.
///
/// Tiers 2 and 3 together are truncated to `max`. A referenced digest CAN be
/// evicted once it falls out of that window: it stays digest-pinned in the
/// registry and re-obtainable, and `provenance::env_obtain::is_env_obtainable`
/// then honestly reports it as not-locally-obtainable — which is the correct
/// signal, whereas an unbounded disk is not.
pub fn plan_eviction(
    cached: &[CachedDigest],
    protected: &HashSet<String>,
    referenced: &HashSet<String>,
    max: usize,
) -> Vec<String> {
    let mut tail: Vec<&CachedDigest> = cached
        .iter()
        .filter(|c| !protected.contains(&c.digest))
        .collect();
    // Newest first; deterministic on ties.
    tail.sort_by(|a, b| {
        b.recency
            .cmp(&a.recency)
            .then_with(|| a.digest.cmp(&b.digest))
    });
    // Referenced digests outrank unreferenced ones at equal recency-priority, so
    // partition BEFORE truncating rather than sorting by a fused key.
    let (mut keep_order, unref): (Vec<&CachedDigest>, Vec<&CachedDigest>) = tail
        .into_iter()
        .partition(|c| referenced.contains(&c.digest));
    keep_order.extend(unref);

    keep_order
        .into_iter()
        .skip(max)
        .map(|c| c.digest.clone())
        .collect()
}

/// Is `dir` a MOUNT POINT? The GC-safety question, and deliberately stricter than
/// `mount::is_mounted` (which probes `mnt/usr` and so reports FALSE for a mount
/// whose FUSE daemon has died). A dead FUSE mount is still a mount: it blocks
/// removal exactly as a live one does, and the live cache on this box holds
/// several. Two signals, either sufficient:
///
/// - the path appears in `/proc/self/mounts` (Linux; covers live AND dead mounts);
/// - `symlink_metadata` fails outright — a dead FUSE mount answers `stat` with
///   `ENOTCONN`/`ENOSYS`, which no ordinary directory does.
fn is_mount_point(dir: &Path) -> bool {
    if let Ok(mounts) = std::fs::read_to_string("/proc/self/mounts") {
        let needle = dir.to_string_lossy();
        for line in mounts.lines() {
            // `<source> <target> <fstype> …`; the target is field 2 and octal-escapes
            // spaces, so compare against the raw field.
            if let Some(target) = line.split_whitespace().nth(1) {
                if target == needle {
                    return true;
                }
            }
        }
    }
    // Listed by its parent but un-stat-able == a dead mount (ENOTCONN/ENOSYS).
    // An absent path is not listed, so this cannot fire for one.
    if dir.symlink_metadata().is_ok() {
        return false;
    }
    let (Some(parent), Some(name)) = (dir.parent(), dir.file_name()) else {
        return false;
    };
    std::fs::read_dir(parent)
        .map(|rd| rd.flatten().any(|e| e.file_name() == name))
        .unwrap_or(false)
}

/// Bounded, in-use-safe cache eviction (ITEM-22 / DEC-17, bounded per #154).
/// `referenced` is the set of digests pinned by extant runs, supplied by the
/// caller that owns run provenance. Returns the digests actually evicted.
///
/// The protected set — never evicted, never charged against the cap — is computed
/// HERE rather than by the caller, because only this module can see it: every
/// currently-mounted digest, the digest the env-image provider last resolved, and
/// the embedded digest of a non-stub build.
///
/// The embedded digest is the one the ORIGINAL implementation relied on for "the
/// live rootfs is always kept". That guard was inert: `content_sha256_full()`
/// returns the EMPTY STRING in a stub build, which is every normal build, so it
/// protected nothing. Mount state and the last-resolved digest are what actually
/// identify the live rootfs here.
pub fn gc_unreferenced(referenced: &HashSet<String>) -> Vec<String> {
    gc_unreferenced_with_cap(referenced, max_cached_digests())
}

/// [`gc_unreferenced`] with the retention cap supplied by the caller instead of read from
/// the process env. The provenance GC driver (`provenance::rootfs_gc`) uses this to thread
/// the admin-configured `rootfs_cache_max_digests` (read-at-use from `provenance_settings`,
/// #54) DOWN into the eviction — without `rootfs` importing `provenance` (the dependency
/// edge stays provenance→rootfs). `gc_unreferenced` remains the env-driven entry point for
/// any other caller.
///
/// `max` bounds only the UNPROTECTED tail: the live/mounted/last-resolved digest is
/// `protected` and never charged against it, so even `max = 1` cannot evict a running
/// rootfs. The eviction touches only the local, re-obtainable cache — never a provenance
/// record.
pub fn gc_unreferenced_with_cap(referenced: &HashSet<String>, max: usize) -> Vec<String> {
    let base = base_dir();
    let mut protected: HashSet<String> = HashSet::new();
    let embedded = super::embedded::content_sha256_full();
    if !embedded.is_empty() {
        protected.insert(embedded);
    }
    if let Some(live) = crate::modules::sandbox::env_image::last_resolved_digest() {
        protected.insert(live);
    }
    let cached = list_cached_in(&base);
    for c in &cached {
        if is_mount_point(&base.join(&c.digest).join("mnt")) {
            protected.insert(c.digest.clone());
        }
    }

    // A degenerate cap of 0 would ask the GC to evict the digest currently being run on;
    // floor it to 1 (the protected set is already exempt, but this keeps the mechanism sane
    // for a direct caller that passes 0).
    let evict = plan_eviction(&cached, &protected, referenced, max.max(1));
    let removed = evict_digests(&base, &evict);
    if !removed.is_empty() {
        tracing::info!(
            count = removed.len(),
            cached = cached.len(),
            protected = protected.len(),
            "rootfs cache GC: evicted digest dirs"
        );
    }
    removed
}

/// Physically evict the planned digests from `base` (testability seam — the pure
/// decision is [`plan_eviction`]; this is only the removal). Returns those that
/// actually went away.
///
/// **Rename-then-delete, never a bare `remove_dir_all`.** `remove_dir_all` walks
/// the directory and unlinks entries one at a time, so on a dir that contains a
/// mount point it deletes an ARBITRARY PREFIX of the contents (readdir hash order)
/// before aborting — measured: 5 of 40 sibling files destroyed in a single call
/// against a live squashfuse mount, with the failure surfacing only as a warning.
/// Whether `rootfs.squashfs` itself was in that prefix is decided by the
/// directory's hash seed, i.e. it differs per deployment. `rename` is atomic: it
/// either moves the whole dir aside or touches nothing at all, so a busy/mounted
/// dir can no longer be half-destroyed. The `.evicting-` prefix is not a valid
/// digest, so a dir left behind by a crash between rename and delete is invisible
/// to [`list_cached_in`] and swept by the next pass.
fn evict_digests(base: &Path, digests: &[String]) -> Vec<String> {
    let mut removed = Vec::new();
    for digest in digests {
        let src = base.join(digest);
        let staged = base.join(format!(".evicting-{digest}"));
        match std::fs::rename(&src, &staged) {
            Ok(()) => {
                if let Err(e) = std::fs::remove_dir_all(&staged) {
                    // The bytes are already out of the cache's namespace; the next
                    // pass retries the leftover.
                    tracing::warn!(digest = %digest, error = %e, "rootfs cache GC: staged dir not fully removed");
                }
                removed.push(digest.clone());
            }
            Err(e) => {
                tracing::warn!(digest = %digest, error = %e, "rootfs cache GC: digest dir busy, left intact");
            }
        }
    }
    // Sweep any `.evicting-*` leftovers from an interrupted earlier pass.
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".evicting-")
            {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    removed
}

/// One-digest ON-DEMAND prune (PROV-SS-5's `DELETE
/// /api/sandbox/envs/{env_id}?prune=true`, DEC-17): removes the cache entry
/// for `digest` with the SAME rename-then-delete discipline as
/// [`evict_digests`] — a busy (mounted) digest dir is never half-destroyed, it
/// is left intact. Returns true when the entry went away. An invalid digest
/// or an absent entry is a quiet no-op (`false`) — pruning a digest that is
/// not cached is a successful no-op for the caller, not an error.
///
/// This is the txr DELETE route's CACHE half; the env-state half is
/// `MethodEnvManager::cancel_and_forget`, and the GC policy / protected set of
/// [`gc_unreferenced`] are deliberately untouched (this node prunes on demand
/// only — never an automatic eviction of a catalogue-pinned digest).
pub fn prune_digest(digest: &str) -> bool {
    if !is_valid_digest(digest) {
        return false;
    }
    !evict_digests(&base_dir(), &[digest.to_string()]).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-22a: digest validation is the path-traversal guard — only a 64-char
    // lowercase-hex string is a valid digest; anything with a slash / `..` / a
    // wrong length / uppercase is rejected (so `has_digest`/`squashfs_path_for`
    // never build a traversal path).
    #[test]
    fn is_valid_digest_is_strict_64_lower_hex() {
        let good = "a".repeat(64);
        assert!(is_valid_digest(&good));
        assert!(is_valid_digest(&"0123456789abcdef".repeat(4)));
        assert!(!is_valid_digest(""));
        assert!(!is_valid_digest(&"a".repeat(63)), "too short");
        assert!(!is_valid_digest(&"a".repeat(65)), "too long");
        assert!(!is_valid_digest(&"A".repeat(64)), "uppercase rejected");
        assert!(
            !is_valid_digest("../../etc/passwd"),
            "path traversal rejected"
        );
        assert!(
            !is_valid_digest(&format!("{}/x", "a".repeat(62))),
            "slash rejected"
        );
        assert!(!is_valid_digest(&"g".repeat(64)), "non-hex rejected");
    }

    // TEST-22b: the placement path is exactly
    // `<base>/<digest>/rootfs.squashfs` — the CONTRACT path the sibling's
    // `environments.json` `placement` maps to.
    #[test]
    fn squashfs_path_is_digest_keyed_under_base() {
        let d = "a".repeat(64);
        let p = squashfs_path_for(&d);
        assert!(
            p.ends_with(format!("{d}/rootfs.squashfs")),
            "path: {}",
            p.display()
        );
        assert_eq!(digest_dir(&d), base_dir().join(&d));
        assert!(
            p.starts_with(base_dir()),
            "placement stays under the cache base"
        );
    }

    // TEST-22c: `has_digest` is false for an invalid digest (no fs hit) and false
    // for an absent one; true only for a present non-empty squashfs.
    #[test]
    fn has_digest_reflects_presence_and_rejects_invalid() {
        assert!(!has_digest("../escape"), "invalid digest is never present");
        assert!(!has_digest(&"b".repeat(64)), "absent digest is not present");
    }

    fn hex(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    // TEST-5 [ITEM-5]: gc_unreferenced_with_cap honors the caller-supplied cap end-to-end
    // (through the real base_dir() via a thread-scoped data root, so it exercises the NEW
    // settings-threaded entry point, not only plan_eviction), and a smaller cap evicts more.
    #[test]
    fn gc_unreferenced_with_cap_honors_the_caller_cap() {
        fn evicted_count_for(cap: usize) -> (usize, usize) {
            let root = scratch();
            let _guard = super::super::scoped_data_root(&root);
            let base = base_dir();
            std::fs::create_dir_all(&base).unwrap();
            for i in 0..6u8 {
                place(&base, &hex(i), b"sqfs");
            }
            let referenced = HashSet::new();
            let evicted = gc_unreferenced_with_cap(&referenced, cap);
            let remaining = list_cached_in(&base).len();
            let _ = std::fs::remove_dir_all(&root);
            (evicted.len(), remaining)
        }

        let (ev4, rem4) = evicted_count_for(4);
        assert_eq!(rem4, 4, "cap 4 keeps 4 of 6");
        assert_eq!(ev4, 2, "cap 4 evicts the 2 oldest unreferenced digests");

        let (ev2, rem2) = evicted_count_for(2);
        assert_eq!(rem2, 2, "cap 2 keeps only 2");
        assert!(ev2 > ev4, "a smaller cap evicts strictly more ({ev2} > {ev4})");

        // A degenerate 0 cap is floored to 1 (never a wipe of the live digest).
        let (_ev0, rem0) = evicted_count_for(0);
        assert_eq!(rem0, 1, "cap 0 floors to 1 — one digest is always kept");
    }

    // TEST-6 [acceptance][INV-6]: at the floor cap (1) a `protected` digest (mounted /
    // last-resolved / embedded — the live rootfs) is NEVER evicted; it is exempt from `max`.
    // gc_unreferenced_with_cap delegates to plan_eviction with `max.max(1)`, so this is the
    // exact decision the floor cap makes. Flip: charge protected against max → this goes red.
    #[test]
    fn floor_cap_never_evicts_the_live_protected_digest() {
        // Four cached; the OLDEST is the protected (live) one, so a recency-only policy would
        // evict it first. cap = 1.
        let cached: Vec<CachedDigest> = (0..4u8)
            .map(|i| CachedDigest {
                digest: hex(i),
                recency: 1_700_000_000 + i as i64,
            })
            .collect();
        let live = hex(0);
        let protected: HashSet<String> = [live.clone()].into_iter().collect();

        let evicted = plan_eviction(&cached, &protected, &HashSet::new(), 1);

        assert!(
            !evicted.contains(&live),
            "the live/protected digest survives even at the floor cap of 1"
        );
        // The single kept UNPROTECTED slot is the newest unprotected digest; the rest go.
        assert!(evicted.contains(&hex(1)), "older unprotected digests are evicted");
        assert!(evicted.contains(&hex(2)));
    }

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("cyto-rootfs-gc-{}", uuid::Uuid::new_v4()))
    }

    fn place(base: &Path, digest: &str, bytes: &[u8]) {
        let d = base.join(digest);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("rootfs.squashfs"), bytes).unwrap();
    }

    // TEST-154a — THE BOUND, under the growth driver measured in #154.
    //
    // Fetch-newest re-resolves a MOVING tag, so every republish of the env image
    // stages one more digest AND acquires runs that pin it. Twelve republishes,
    // ALL referenced, is therefore the realistic steady state — not a corner case.
    //
    // Uniquely kills: reverting to pure reference counting (`keep iff referenced`).
    // That predicate keeps all twelve here and returns an EMPTY eviction list, so
    // this test fails under the pre-#154 behaviour and passes only under a policy
    // that actually bounds the cache. It is the test the old suite could not have
    // had, because the old suite asserted the unbounded rule was correct.
    #[test]
    fn plan_eviction_bounds_the_cache_when_every_digest_is_referenced() {
        let max = 4;
        let cached: Vec<CachedDigest> = (0..12u8)
            .map(|i| CachedDigest {
                digest: hex(i),
                recency: 1_700_000_000 + i as i64,
            })
            .collect();
        let referenced: HashSet<String> = cached.iter().map(|c| c.digest.clone()).collect();

        let evicted = plan_eviction(&cached, &HashSet::new(), &referenced, max);

        assert_eq!(evicted.len(), 12 - max, "the cache is bounded at the cap");
        let kept: HashSet<&String> = cached
            .iter()
            .map(|c| &c.digest)
            .filter(|d| !evicted.contains(d))
            .collect();
        assert_eq!(kept.len(), max);
        // Newest survive: digests 8..=11.
        for i in 8..12u8 {
            assert!(kept.contains(&hex(i)), "newest digest {i} is kept");
        }
        for i in 0..8u8 {
            assert!(evicted.contains(&hex(i)), "oldest digest {i} is evicted");
        }
    }

    // TEST-154b — the protected set is NOT charged against the cap.
    //
    // Uniquely kills: applying `skip(max)` to the whole cached list instead of to
    // the unprotected tail. Under that mutation the six protected digests would
    // consume the cap and two of them would be evicted — i.e. the GC would pull a
    // mounted rootfs out from under a running sandbox, which is the single most
    // damaging thing this code can do.
    #[test]
    fn plan_eviction_never_evicts_a_protected_digest_even_over_cap() {
        let cached: Vec<CachedDigest> = (0..9u8)
            .map(|i| CachedDigest {
                digest: hex(i),
                recency: 1_700_000_000 + i as i64,
            })
            .collect();
        // Six protected — more than the cap of 2, and deliberately the OLDEST ones
        // so a recency-only policy would evict them first.
        let protected: HashSet<String> = (0..6u8).map(hex).collect();

        let evicted = plan_eviction(&cached, &protected, &HashSet::new(), 2);

        for p in &protected {
            assert!(
                !evicted.contains(p),
                "protected digest {p} must never be evicted"
            );
        }
        // The three unprotected ones are bounded at 2 → exactly one goes, the oldest.
        assert_eq!(evicted, vec![hex(6)], "only the unprotected tail is capped");
    }

    // TEST-154c — referenced outranks unreferenced at the eviction boundary.
    //
    // Uniquely kills: dropping the referenced/unreferenced partition and using a
    // plain recency LRU. Here the unreferenced digest is strictly NEWER, so an LRU
    // keeps it and evicts the referenced one; the shipped policy does the reverse,
    // because losing a referenced digest costs a reproduce and losing an
    // unreferenced one costs nothing.
    #[test]
    fn plan_eviction_prefers_a_referenced_digest_over_a_newer_unreferenced_one() {
        let old_referenced = CachedDigest {
            digest: hex(1),
            recency: 100,
        };
        let new_unreferenced = CachedDigest {
            digest: hex(2),
            recency: 999,
        };
        let cached = vec![new_unreferenced.clone(), old_referenced.clone()];
        let referenced: HashSet<String> = [old_referenced.digest.clone()].into_iter().collect();

        let evicted = plan_eviction(&cached, &HashSet::new(), &referenced, 1);

        assert_eq!(
            evicted,
            vec![new_unreferenced.digest],
            "the newer UNreferenced digest is the one that goes"
        );
    }

    // TEST-154d — an un-removable digest dir is left BYTE-INTACT, never half-destroyed.
    //
    // This is the defect measured on the live cache: `std::fs::remove_dir_all` walks
    // the directory unlinking entries and, when it cannot finish, has already
    // destroyed an arbitrary readdir-order prefix — 5 of 40 sibling files in the
    // #154 reproduction against a live squashfuse mount — while reporting only a
    // warning. A read-only BASE dir reproduces the same class deterministically and
    // without root or FUSE: unlinking the entries INSIDE `<digest>/` needs write on
    // `<digest>` (granted), while removing `<digest>` itself needs write on `base`
    // (denied). So `remove_dir_all` deletes the squashfs and then fails.
    //
    // Uniquely kills: replacing the rename-then-delete with a direct
    // `remove_dir_all(base.join(digest))`. Under that mutation `rootfs.squashfs` is
    // gone while the dir remains — the digest silently stops being servable — and
    // the assertion below fails.
    #[test]
    fn evict_digests_leaves_an_unremovable_dir_completely_intact() {
        let base = scratch();
        let victim = hex(7);
        place(&base, &victim, b"sqfs-bytes");
        let sqfs = base.join(&victim).join("rootfs.squashfs");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // r-xr-xr-x: entries under `base` can be read and descended, but not
            // unlinked — so the rename cannot land.
            std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o555)).unwrap();
        }

        let removed = evict_digests(&base, std::slice::from_ref(&victim));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        assert!(
            removed.is_empty(),
            "a dir that could not be moved is not reported evicted"
        );
        assert!(base.join(&victim).exists(), "the digest dir survives");
        assert!(
            sqfs.exists(),
            "the squashfs is NOT unlinked — an un-evictable digest stays fully servable"
        );
        assert_eq!(
            std::fs::read(&sqfs).unwrap(),
            b"sqfs-bytes",
            "and its bytes are untouched"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // TEST-154e — a crash between the rename and the delete leaks nothing.
    //
    // Uniquely kills: dropping the `.evicting-*` sweep, which would leave the full
    // ~300 MB of a half-evicted digest on disk forever — the very failure this
    // whole change exists to prevent, reintroduced by its own implementation.
    #[test]
    fn evict_digests_sweeps_a_staged_dir_left_by_an_interrupted_pass() {
        let base = scratch();
        std::fs::create_dir_all(&base).unwrap();
        let orphaned_stage = base.join(format!(".evicting-{}", hex(3)));
        std::fs::create_dir_all(&orphaned_stage).unwrap();
        std::fs::write(orphaned_stage.join("rootfs.squashfs"), b"leaked").unwrap();

        // A pass that evicts nothing still sweeps the leftover.
        let removed = evict_digests(&base, &[]);

        assert!(removed.is_empty());
        assert!(
            !orphaned_stage.exists(),
            "an interrupted pass's staged dir is reclaimed"
        );
        // And it was never a cache entry to begin with (the prefix is not valid hex).
        assert!(list_cached_in(&base).is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    // TEST-154f — the cache listing feeding the planner still admits only real
    // entries, and now carries a recency key.
    //
    // Uniquely kills: counting an empty-squashfs dir, a non-digest dir, or the
    // `.evicting-*` staging dir as a cached digest — each of which would let the
    // planner spend cap on a non-entry and evict a real one to make room.
    #[test]
    fn list_cached_in_admits_only_non_empty_valid_digest_dirs() {
        let base = scratch();
        place(&base, &hex(1), b"real");
        place(&base, &hex(2), b"");
        std::fs::create_dir_all(base.join("not-a-digest")).unwrap();
        std::fs::create_dir_all(base.join(format!(".evicting-{}", hex(9)))).unwrap();

        let listed = list_cached_in(&base);

        assert_eq!(
            listed.len(),
            1,
            "only the non-empty valid-digest dir counts"
        );
        assert_eq!(listed[0].digest, hex(1));
        assert!(
            listed[0].recency > 0,
            "a readable squashfs carries a real mtime"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // TEST-154g — mount detection, the input the protected set is built from.
    //
    // Uniquely kills: an `is_mount_point` that always returns false, which would
    // make every mounted digest evictable. `/proc` is a mount point on every Linux
    // box and needs no privileges to observe.
    #[test]
    fn is_mount_point_distinguishes_a_mount_from_a_plain_dir() {
        let base = scratch();
        std::fs::create_dir_all(base.join("plain")).unwrap();
        assert!(
            !is_mount_point(&base.join("plain")),
            "a plain dir is not a mount"
        );
        assert!(
            !is_mount_point(&base.join("absent")),
            "an absent path is not a mount"
        );
        #[cfg(target_os = "linux")]
        assert!(is_mount_point(Path::new("/proc")), "/proc is a mount point");
        let _ = std::fs::remove_dir_all(&base);
    }

    // TEST-154h — the retention cap is operator-configurable and refuses a value
    // that would evict the digest a run is executing on.
    //
    // Uniquely kills: `unwrap_or(0)` / dropping the `> 0` filter, under which an
    // empty or malformed env var yields a cap of zero and the planner evicts the
    // entire unprotected cache on every pass.
    #[test]
    fn max_cached_digests_falls_back_on_a_zero_or_malformed_override() {
        assert!(
            MAX_CACHED_DIGESTS_DEFAULT > 0,
            "the default keeps at least one digest"
        );
        // The parse+filter is the unit under test; exercising it directly keeps this
        // free of process-wide `set_var` (which every sibling test thread would see).
        let read = |raw: &str| {
            raw.trim()
                .parse::<usize>()
                .ok()
                .filter(|n| *n > 0)
                .unwrap_or(MAX_CACHED_DIGESTS_DEFAULT)
        };
        assert_eq!(read("7"), 7, "a valid override is honored");
        assert_eq!(read("0"), MAX_CACHED_DIGESTS_DEFAULT, "zero falls back");
        assert_eq!(
            read("banana"),
            MAX_CACHED_DIGESTS_DEFAULT,
            "malformed falls back"
        );
        assert_eq!(read(""), MAX_CACHED_DIGESTS_DEFAULT, "empty falls back");
    }

    // TEST-154i — the production entry point, end to end, against an ISOLATED data
    // root (thread-scoped, so no sibling test can observe it and the shared
    // `~/.app` cache is never touched).
    //
    // Uniquely kills: leaving `gc_unreferenced` unwired from the protected set or
    // the cap — i.e. the state this task started in. It is also the only test that
    // exercises `base_dir()` resolution, mount probing and the planner together.
    #[test]
    fn gc_unreferenced_bounds_an_isolated_cache_end_to_end() {
        let root = scratch();
        let _guard = super::super::scoped_data_root(&root);
        let base = base_dir();
        std::fs::create_dir_all(&base).unwrap();

        for i in 0..8u8 {
            place(&base, &hex(i), b"sqfs-bytes");
        }
        assert_eq!(list_cached_in(&base).len(), 8, "eight digests staged");

        let referenced: HashSet<String> = (0..8u8).map(hex).collect();
        let evicted = gc_unreferenced(&referenced);

        let remaining = list_cached_in(&base).len();
        assert!(
            remaining <= max_cached_digests(),
            "the cache is at or under the cap after a pass: {remaining} left"
        );
        assert_eq!(evicted.len(), 8 - remaining, "every eviction is reported");
        for d in &evicted {
            assert!(!has_digest(d), "an evicted digest is no longer servable");
        }
        // A second pass is a no-op — the bound is stable, not oscillating.
        assert!(gc_unreferenced(&referenced).is_empty(), "GC converges");

        drop(_guard);
        let _ = std::fs::remove_dir_all(&root);
    }

    // PROV-SS-5 / DEC-17: the on-demand prune is a single-digest eviction —
    // a planted entry goes away (the accepted `?prune=true` outcome), an
    // invalid digest and an absent digest are quiet no-ops, and the prune
    // never touches another digest's entry. Runs under a scoped data root so
    // the real cache is never touched.
    #[test]
    fn prune_digest_removes_exactly_the_named_entry() {
        let root = scratch();
        let _guard = super::super::scoped_data_root(&root);
        let base = base_dir();
        std::fs::create_dir_all(&base).unwrap();

        let victim = hex(3);
        place(&base, &victim, b"sqfs-bytes");
        let bystander = hex(4);
        place(&base, &bystander, b"other-bytes");

        // An invalid digest is a no-op (and never hits the filesystem with a
        // traversal shape).
        assert!(!prune_digest("../../etc/passwd"));
        assert!(!prune_digest("short"));
        // An absent-but-valid digest is a successful no-op.
        assert!(!prune_digest(&hex(9)));

        assert!(prune_digest(&victim), "the planted entry is pruned");
        assert!(!has_digest(&victim), "the pruned digest is no longer servable");
        assert!(
            has_digest(&bystander),
            "the bystander digest is untouched (a single-digest prune)"
        );
        assert!(
            !base.join(&victim).exists(),
            "the digest dir is gone, not just the squashfs file"
        );

        drop(_guard);
        let _ = std::fs::remove_dir_all(&root);
    }
}
