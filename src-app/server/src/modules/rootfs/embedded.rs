//! The embedded analysis rootfs squashfs + extract-on-first-use.
//!
//! `build_helper/sandbox_rootfs.rs` docker-builds the rootfs squashfs at build
//! time and stages it at `binaries/sandbox-rootfs/rootfs.squashfs`. This module
//! `include_bytes!`s that asset and, on first sandbox use, extracts it to
//! `<app_data>/sandbox-rootfs/<content-digest>/rootfs.squashfs` (guarded by a
//! sha256 marker so a re-extract only happens on a truncated write). Mirrors
//! txresbench `code_sandbox/embedded.rs`, minus the multi-flavor layout (DEC-2).
//!
//! CONTENT-DIGEST-KEYED CACHE (ITEM-22 / DEC-17): the extraction dir is keyed by
//! the rootfs's FULL content sha256, NOT the schema version — so different rootfs
//! builds coexist on disk and an app update that swaps in a new digest EXTRACTS
//! the new dir while KEEPING the already-extracted old one (a run pinned to the
//! old digest stays reproducible/verifiable locally). See `cache.rs` for
//! `has_digest`, the placement-path helper, and reference-counted GC.
//!
//! NORMAL BUILDS STAGE A 0-BYTE STUB. Docker is no longer a build dependency of
//! TxResBench, so the staged asset is an intentional, permanent zero-byte stub and
//! `is_supported()` is false. The sandbox does NOT self-disable as a result — the
//! analysis rootfs is lazy-fetched at runtime by
//! [`crate::modules::sandbox::env_image::OciEnvImageProvider`] from
//! `ghcr.io/tinnlab/txresbench-env/<env>:schema<N>-latest-<arch>`, cosign-verified and
//! squashfuse-mounted on the first `run_analysis`. `is_supported() == false` means
//! only "nothing is embedded", never "the sandbox is unavailable".

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use txresbench_core::AppError;

/// The embedded squashfs bytes. Zero-length when the build staged a stub
/// (no docker / non-Linux / build failure) — `is_supported()` gates on this.
const ROOTFS_SQFS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/binaries/sandbox-rootfs/rootfs.squashfs"
));

/// The extracted squashfs + its owning directory.
#[derive(Debug, Clone)]
pub struct ExtractedRootfs {
    /// `<app_data>/sandbox-rootfs/<content-digest>/rootfs.squashfs` — what squashfuse mounts.
    pub squashfs_path: PathBuf,
    /// `<app_data>/sandbox-rootfs/<content-digest>/` — the per-digest dir (mount point lives here too).
    pub dir: PathBuf,
}

/// True when the build produced a real (non-stub) embedded rootfs.
pub fn is_supported() -> bool {
    !ROOTFS_SQFS.is_empty()
}

/// The embedded rootfs byte length (0 = stub). Surfaced in the admin status.
pub fn embedded_len() -> usize {
    ROOTFS_SQFS.len()
}

/// The FULL sha256 hex digest (64 chars) of the embedded rootfs — the env digest
/// the provenance layer pins (ITEM-6). Empty-string for a stub.
pub fn content_sha256_full() -> String {
    if ROOTFS_SQFS.is_empty() {
        return String::new();
    }
    let mut h = Sha256::new();
    h.update(ROOTFS_SQFS);
    hex_lower(&h.finalize())
}

/// A short content hash of the embedded rootfs (the "content version" shown in
/// the admin UI). Empty-string for a stub. The 12-char prefix of
/// [`content_sha256_full`].
pub fn content_version() -> String {
    let full = content_sha256_full();
    if full.is_empty() {
        return String::new();
    }
    full[..12].to_string()
}

/// Base dir for extracted rootfs assets: `<data_root>/sandbox-rootfs/`.
pub fn base_dir() -> PathBuf {
    super::data_root().join("sandbox-rootfs")
}

/// Extract the embedded squashfs on first call (idempotent via a sha256 marker).
/// Returns the extracted paths. Errors when the asset is a stub.
pub fn ensure_extracted() -> Result<ExtractedRootfs, AppError> {
    if ROOTFS_SQFS.is_empty() {
        return Err(AppError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ROOTFS_UNAVAILABLE",
            "the analysis rootfs was not built into this binary (docker was \
             absent at build time, or this is a non-Linux build). The sandbox \
             is disabled.",
        ));
    }

    // Content-digest-keyed (ITEM-22): the dir name IS the full sha256, so
    // different rootfs versions coexist and an app update never overwrites an
    // older extracted digest.
    let want_sha = content_sha256_full();
    let dir = base_dir().join(&want_sha);
    let squashfs_path = dir.join("rootfs.squashfs");
    let marker = dir.join(".sqfs-sha");

    // Fast path: already extracted with the matching sha.
    if squashfs_path.exists() && marker_matches(&marker, &want_sha) {
        return Ok(ExtractedRootfs { squashfs_path, dir });
    }

    std::fs::create_dir_all(&dir).map_err(|e| io_err("mkdir rootfs dir", e))?;

    // Write to a temp file then atomically rename into place, so a concurrent
    // reader never sees a half-written squashfs.
    let tmp = dir.join(format!("rootfs.squashfs.tmp-{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| io_err("create tmp squashfs", e))?;
        f.write_all(ROOTFS_SQFS).map_err(|e| io_err("write squashfs", e))?;
        f.flush().map_err(|e| io_err("flush squashfs", e))?;
    }
    std::fs::rename(&tmp, &squashfs_path).map_err(|e| io_err("promote squashfs", e))?;
    write_marker_atomic(&marker, &want_sha).map_err(|e| io_err("write sha marker", e))?;

    tracing::info!(
        path = %squashfs_path.display(),
        bytes = ROOTFS_SQFS.len(),
        "rootfs: extracted embedded analysis rootfs"
    );
    Ok(ExtractedRootfs { squashfs_path, dir })
}

fn marker_matches(marker: &Path, want: &str) -> bool {
    std::fs::read_to_string(marker)
        .map(|s| s.trim() == want)
        .unwrap_or(false)
}

fn write_marker_atomic(marker: &Path, sha: &str) -> std::io::Result<()> {
    let tmp = marker.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, sha)?;
    std::fs::rename(&tmp, marker)
}

fn io_err(what: &str, e: std::io::Error) -> AppError {
    AppError::new(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "ROOTFS_EXTRACT_FAILED",
        format!("{what}: {e}"),
    )
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-2: is_supported() reflects the embedded bytes; content_version is
    // empty for a stub, non-empty (12 hex chars) for a real asset. marker_matches
    // only accepts an exact sha.
    #[test]
    fn is_supported_tracks_embedded_len() {
        assert_eq!(is_supported(), !ROOTFS_SQFS.is_empty());
        assert_eq!(embedded_len(), ROOTFS_SQFS.len());
        if is_supported() {
            assert_eq!(content_version().len(), 12);
        } else {
            assert!(content_version().is_empty());
        }
    }

    // TEST-3: content_sha256_full() is a 64-hex full digest, non-empty for a real
    // rootfs, and its first 12 chars equal content_version() (additive/consistent).
    #[test]
    fn content_sha256_full_is_consistent_with_version() {
        let full = content_sha256_full();
        if is_supported() {
            assert_eq!(full.len(), 64, "full digest is 64 hex chars");
            assert!(full.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(&full[..12], content_version(), "version is the 12-char prefix");
        } else {
            assert!(full.is_empty(), "stub build has no digest");
        }
    }

    #[test]
    fn marker_matches_requires_exact_sha() {
        let dir = std::env::temp_dir().join(format!("txr-emb-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let marker = dir.join(".sqfs-sha");
        assert!(!marker_matches(&marker, "abc"), "missing marker never matches");
        std::fs::write(&marker, "abc\n").unwrap();
        assert!(marker_matches(&marker, "abc"), "exact match (trailing newline tolerated)");
        assert!(!marker_matches(&marker, "abd"), "different sha does not match");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
