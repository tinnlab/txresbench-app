//! Content-addressed code-blob store (ITEM-2) + env digest helpers. The real
//! capture write path; the seam in `seams.rs` is only the notify hook.

use sqlx::SqlitePool;
use txresbench_core::AppError;

use crate::modules::workstore::object_store::sha256_hex;

use super::repository::ProvenanceRepository;

/// Hash a code source with the SAME sha256 primitive P1's object store uses, so
/// the graph's code identity matches the data plane's content identity.
pub fn code_sha256(source: &str) -> String {
    sha256_hex(source.as_bytes())
}

/// Store an emitted code blob, deduped by sha256. Returns the content hash; a
/// second store of identical source is a no-op returning the same hash.
pub async fn store_code(pool: &SqlitePool, source: &str, language: &str) -> Result<String, AppError> {
    let sha = code_sha256(source);
    ProvenanceRepository::new(pool.clone())
        .insert_code_blob(&sha, language, source, source.len() as i64)
        .await?;
    Ok(sha)
}

/// The environment digest for a run: the OCI env-image CONTENT digest the sandbox
/// most recently resolved+mounted (ITEM-4, provenance-by-reference — DEC-24
/// reversed: nothing is embedded, so this is the pulled image's digest, not an
/// embedded sha). A reproduce resolves the exact image from this content digest
/// (digest cache / serve-by-digest). None before any sandbox run (e.g. an in-app
/// interaction run, or a promote/byte-copy run).
pub fn env_digest_rootfs() -> Option<String> {
    crate::modules::sandbox::env_image::last_resolved_digest()
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-2: store_code hashes with the P1 sha256 primitive and the SAME source
    // yields the SAME hash (dedup key). (The one-row dedup is asserted at the
    // integration tier — TEST-17 — since it needs the DB.)
    #[test]
    fn code_sha256_matches_p1_primitive_and_is_stable() {
        let src = "mask = adata.obs['leiden'] == '3'\n";
        let a = code_sha256(src);
        let b = code_sha256(src);
        assert_eq!(a, b, "same source -> same hash (dedup key)");
        assert_eq!(a, sha256_hex(src.as_bytes()), "uses the P1 sha256 primitive");
        assert_ne!(a, code_sha256("different source\n"), "different source -> different hash");
    }
}
