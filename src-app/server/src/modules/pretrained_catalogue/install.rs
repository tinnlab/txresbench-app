//! # The ensure/install path (PROV-PC-7 + PROV-PC-9's in-process seam)
//!
//! `POST /api/txr/pretrained/{id}/install`'s core, shared by the routes
//! (ITEM-5) and [`ensure_installed`]:
//!
//! 1. The licence belt (INV-3) — a catalogue entry without a data licence is
//!    `409 PRETRAINED_LICENCE_MISSING` before anything else (over the
//!    generator's build gate; the store's own `422 LICENCE_REQUIRED` is the
//!    last line and passes through UNREWRITTEN — because the belt fires
//!    first it is unreachable on this module path, and the rule is that the
//!    store call's errors are never re-mapped).
//! 2. The GAP-PC-3 idempotency check — the RESOLVED seam (the store's
//!    PROV-MS-10 `list_pretrained`, not a degraded fallback): a row with the
//!    same catalogue id AND version returns its model_id without a second
//!    import.
//! 3. The source order bundled → cache → download (INV-8):
//!    - bundled: the file verifies against the catalogue entry (INV-2) →
//!      import from the bundle; a mismatch is `409 PRETRAINED_VERIFY_FAILED`
//!      and the file is QUARANTINED; a missing file falls through.
//!    - cache: the content-addressed file is RE-verified (a cached file whose
//!      sha256 no longer matches the catalogue's — an updated entry — is
//!      never used: removed and the download starts).
//!    - download: the manager's [`DownloadManager::fetch`] (the fallback
//!      downloads even a bundled entry whose file is missing — TEST-PC-23);
//!      a just-required download answers `202 installing` with model_id null
//!      and the caller polls PROV-PC-6.
//! 4. The import: `model_store::store::install_imported_from_path` with
//!    `ImportOptions { set_id: None, provenance: Provenance::Pretrained {
//!    catalogue_id, version, licence } }` — the same path a user's own `.txr`
//!    takes (CONS-PC-3/4/5); INV-2's verification always ran BEFORE the call.

use std::path::Path;

use sqlx::SqlitePool;
use txresbench_core::AppError;

use crate::modules::model_store::store::{self, ImportOptions, Provenance};
use crate::modules::pretrained_catalogue::bundled;
use crate::modules::pretrained_catalogue::downloader::{self, DownloadManager};
use crate::modules::pretrained_catalogue::types::{
    PretrainedDownloadState, PretrainedErrorCode, PretrainedInstallResponse,
    PretrainedInstallSource, PretrainedInstallStatus, PretrainedModel,
};

/// The install path's outcome (PROV-PC-9): the store model_id once the bytes
/// verified and the row landed, or null while a required download runs.
#[derive(Debug, Clone)]
pub struct InstalledOutcome {
    pub model_id: Option<String>,
    pub status: PretrainedInstallStatus,
    pub source: PretrainedInstallSource,
    pub catalogue_id: String,
    pub version: String,
    pub licence: String,
    pub size_bytes: u64,
}

impl InstalledOutcome {
    /// The wire response (200 for a completed install, 202 while a download
    /// runs — the same shape, different status + model_id).
    pub fn into_response(self) -> PretrainedInstallResponse {
        PretrainedInstallResponse {
            model_id: self.model_id,
            status: self.status,
            catalogue_id: self.catalogue_id,
            version: self.version,
            licence: self.licence,
            size_bytes: self.size_bytes,
            source: self.source,
        }
    }
}

/// The PROV-PC-9 in-process seam: ensure the catalogue entry `id` (the
/// runtime's ACTIVE view) is installed, then return the outcome. The routes
/// and every in-process caller share it.
pub async fn ensure_installed(pool: &SqlitePool, id: &str) -> Result<InstalledOutcome, AppError> {
    let runtime = crate::modules::pretrained_catalogue::runtime();
    let entry = runtime
        .active()
        .catalogue
        .models
        .iter()
        .find(|m| m.id == id)
        .cloned()
        .ok_or_else(|| crate::modules::pretrained_catalogue::types::unknown_id(id))?;
    let manager = crate::modules::pretrained_catalogue::downloads();
    install_entry(pool, &entry, manager).await
}

/// The install core (the routes' sibling; unit-tested here with a real pool
/// and the real packer output).
pub async fn install_entry(
    pool: &SqlitePool,
    entry: &PretrainedModel,
    manager: &DownloadManager,
) -> Result<InstalledOutcome, AppError> {
    // INV-3: the belt over the generator's gate.
    if entry.licence.trim().is_empty() {
        return Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            PretrainedErrorCode::LicenceMissing.as_str(),
            format!(
                "the catalogue entry {} carries no data licence (a pretrained install \
                 records it — INV-3)",
                entry.id
            ),
        ));
    }

    // The GAP-PC-3 idempotency check: the CACHE layer's strict row match —
    // same id AND same version (an updated entry is a NEW row, not a silent
    // reinstall).
    let existing = store::list_pretrained(pool, Some(&entry.id)).await?;
    if let Some(row) = existing
        .iter()
        .find(|m| m.pretrained_catalogue_version.as_deref() == Some(entry.version.as_str()))
    {
        return Ok(InstalledOutcome {
            model_id: Some(row.id.to_string()),
            status: PretrainedInstallStatus::Installed,
            source: source_label(manager, entry),
            catalogue_id: entry.id.clone(),
            version: entry.version.clone(),
            licence: entry.licence.clone(),
            size_bytes: entry.asset.size_bytes,
        });
    }

    // Source order: bundled → cache → download (INV-8).
    if entry.asset.bundled {
        match bundled::verify(manager.seams(), entry) {
            Ok(v) => return imported(pool, entry, &v.path, PretrainedInstallSource::Bundled).await,
            Err(bundled::BundledVerifyError::Missing) => {
                // The bundle is absent — the source order continues.
            }
            Err(err) => {
                // INV-2: a tampered bundle never imports. Quarantine the
                // file (a rejected rename is best-effort — the 409 is the
                // answer either way; the next attempt falls through to
                // cache/download once the file is gone).
                quarantine(&bundled::file_path(manager.seams(), entry));
                return Err(AppError::new(
                    axum::http::StatusCode::CONFLICT,
                    PretrainedErrorCode::VerifyFailed.as_str(),
                    format!(
                        "the bundled asset {} of {}@{} failed verification: {err}",
                        entry.asset.file, entry.id, entry.version
                    ),
                ));
            }
        }
    }

    let cache = downloader::cache_path(&manager.seams().data_root(), &entry.asset.sha256);
    if cache.is_file() {
        // RE-verify the cached bytes (the name is the digest the catalogue
        // recorded, but the file may predate an updated entry): a mismatch is
        // never used — the lying cache entry is dropped and the download
        // starts.
        match bundled::sha256_file(&cache) {
            Ok(found) if found == entry.asset.sha256 => {
                return imported(pool, entry, &cache, PretrainedInstallSource::Cache).await
            }
            _ => {
                let _ = std::fs::remove_file(&cache);
            }
        }
    }

    // The download leg.
    let st = manager.fetch(entry);
    if st.state == PretrainedDownloadState::Ready {
        // The download completed in the window (a raced prior download) —
        // the verified cache is the source.
        if let Ok(found) = bundled::sha256_file(&cache) {
            if found == entry.asset.sha256 {
                return imported(pool, entry, &cache, PretrainedInstallSource::Cache).await;
            }
        }
        let _ = std::fs::remove_file(&cache);
    }
    Ok(InstalledOutcome {
        model_id: None,
        status: PretrainedInstallStatus::Installing,
        source: PretrainedInstallSource::Download,
        catalogue_id: entry.id.clone(),
        version: entry.version.clone(),
        licence: entry.licence.clone(),
        size_bytes: entry.asset.size_bytes,
    })
}

/// The import via the store's pretrained provenance seam. The bytes are
/// ALREADY verified against the catalogue entry (INV-2) before this call;
/// the store's own gate (an empty licence → `422 LICENCE_REQUIRED`) is the
/// last line and passes through unrewritten.
async fn imported(
    pool: &SqlitePool,
    entry: &PretrainedModel,
    path: &Path,
    source: PretrainedInstallSource,
) -> Result<InstalledOutcome, AppError> {
    let opts = ImportOptions {
        set_id: None,
        provenance: Provenance::Pretrained {
            catalogue_id: entry.id.clone(),
            version: entry.version.clone(),
            licence: entry.licence.clone(),
        },
    };
    let outcome = store::install_imported_from_path(pool, path, &opts).await?;
    let model_id = outcome.model_ids.first().cloned().ok_or_else(|| {
        AppError::internal_error(format!(
            "the pretrained import of {}@{} returned no model ids",
            entry.id, entry.version
        ))
    })?;
    Ok(InstalledOutcome {
        model_id: Some(model_id),
        status: PretrainedInstallStatus::Installed,
        source,
        catalogue_id: entry.id.clone(),
        version: entry.version.clone(),
        licence: entry.licence.clone(),
        size_bytes: entry.asset.size_bytes,
    })
}

/// The already-installed case's source label: the same source-order
/// detection WITHOUT starting anything — the verified bundle, then the
/// cached file, then the remaining member of the closed vocabulary
/// (`download` — the only way the bytes could have arrived once no local
/// verified file remains).
fn source_label(manager: &DownloadManager, entry: &PretrainedModel) -> PretrainedInstallSource {
    if entry.asset.bundled && bundled::verify(manager.seams(), entry).is_ok() {
        return PretrainedInstallSource::Bundled;
    }
    if downloader::cache_path(&manager.seams().data_root(), &entry.asset.sha256).is_file() {
        return PretrainedInstallSource::Cache;
    }
    PretrainedInstallSource::Download
}

/// A tampered bundled file's quarantine: renamed `<file>.rejected` (an old
/// quarantine is replaced; the caller's `409` is the answer even if the
/// rename fails).
fn quarantine(path: &Path) {
    let rejected = sibling_quarantine_path(path);
    let _ = std::fs::remove_file(&rejected);
    let _ = std::fs::rename(path, rejected);
}

fn sibling_quarantine_path(path: &Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".rejected");
    path.with_file_name(name)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-PC-09 — the source order, the idempotency check (no duplicate row),
// the cache-mismatch rule, the licence belt, and the bundled-dir layout
// overrides. The real store (file-backed sqlite + the merged migrations) and
// the REAL packer output (the only writer of fixture `.txr` bytes) are the
// fixtures; the loopback server is used only for the download leg.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pretrained_catalogue::types::{
        PretrainedAsset, PretrainedEndpoint, PretrainedEnv, PretrainedKind, PretrainedMarkerFacts,
        PretrainedModel, PretrainedNeeds,
    };
    use std::path::PathBuf;
    use std::process::Command;

    /// Repo root (`CARGO_MANIFEST_DIR` is `src-app/server`).
    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-app")
            .parent()
            .expect("repo root")
            .to_path_buf()
    }

    /// The committed synthetic fixture tree + facts.
    fn fixture(rel: &str) -> PathBuf {
        repo_root()
            .join("scripts/pretrained-catalogue/fixtures/pack")
            .join(rel)
    }

    fn run_packer(dst: &Path) -> (u64, String) {
        let out = Command::new("python3")
            .arg(repo_root().join("scripts/pretrained-catalogue/pack_model_txr.py"))
            .args([
                "--tree",
                fixture("tree").to_str().expect("utf-8"),
                "--facts",
                fixture("facts.json").to_str().expect("utf-8"),
                "--out",
                dst.to_str().expect("utf-8"),
            ])
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .output()
            .unwrap_or_else(|e| panic!("pack the fixture: spawn failed: {e}"));
        assert!(out.status.success(), "the packer failed: {:?}", out.status);
        let text = String::from_utf8(out.stdout).expect("packer stdout is utf-8");
        let mut size = None;
        let mut sha = None;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("size_bytes: ") {
                size = Some(rest.parse::<u64>().expect("size parses"));
            } else if let Some(rest) = line.strip_prefix("sha256: ") {
                sha = Some(rest.trim().to_string());
            }
        }
        (
            size.unwrap_or_else(|| panic!("no size line in: {text}")),
            sha.unwrap_or_else(|| panic!("no sha line in: {text}")),
        )
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("parent dir")).expect("parent dir");
        std::fs::write(path, bytes).expect("fixture file");
    }

    /// A scratch root under the worktree's gitignored `target/` (never /tmp)
    /// with the thread's scoped data-root override installed — the store
    /// writes under it, and the manager's seams point at the same root.
    fn scratch(name: &str) -> (PathBuf, crate::modules::rootfs::DataRootGuard) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("target")
            .join("pretrained-catalogue-item4-install")
            .join(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch root");
        let guard = crate::modules::rootfs::scoped_data_root(root.clone());
        (root, guard)
    }

    /// A file-backed pool with the FULL merged chain (the runtime's shape —
    /// `build.rs` composes the module-owned migration dirs).
    async fn test_pool(path: &Path) -> SqlitePool {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite file connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR.run(&pool).await.expect("merged migrations apply");
        pool
    }

    fn sample_entry(
        id: &str,
        file: &str,
        url: &str,
        sha: &str,
        size: u64,
        bundled: bool,
        licence: &str,
    ) -> PretrainedModel {
        PretrainedModel {
            id: id.to_string(),
            version: "1.0.0".to_string(),
            kind: PretrainedKind::PublishedRule,
            name: "Sample rule".to_string(),
            description: "A synthetic card fact set.".to_string(),
            method_id: "landmark-cox-current".to_string(),
            method_version: "2.0.0".to_string(),
            group: "dynamic-risk".to_string(),
            group_label: "Dynamic risk".to_string(),
            paper: None,
            needs: PretrainedNeeds {
                marker_facts: PretrainedMarkerFacts {
                    kind: crate::modules::method_catalogue::types::MarkerKind::Single,
                    count: 1,
                    min_draws: 1,
                    needs_baseline: true,
                    uses_history: crate::modules::method_catalogue::types::UsesHistory::Landmark,
                    needs_detection_call: false,
                    marker_groups_required: vec![],
                },
                required_markers: None,
                covariates: crate::modules::method_catalogue::types::CovariateMode::None,
                decision_day: 56.0,
                endpoint: PretrainedEndpoint::Pfs,
                horizon: 180.0,
                task: Some(crate::modules::pretrained_catalogue::types::PretrainedTask::Survival),
            },
            env: PretrainedEnv {
                base_digest: format!("sha256:{}", "aa".repeat(32)),
                layer_digest: format!("sha256:{}", "bb".repeat(32)),
            },
            contract: "2.0".to_string(),
            embeds_training_data: false,
            transfer: None,
            assay_warnings: vec![],
            research_notice: true,
            licence: licence.to_string(),
            data_sources: vec![],
            asset: PretrainedAsset {
                bundled,
                file: file.to_string(),
                url: url.to_string(),
                size_bytes: size,
                sha256: sha.to_string(),
                signature: String::new(),
            },
        }
    }

    /// The packer's deterministic fixture (1555 bytes; the sha is a FIXED
    /// contract — the packer is byte-stable).
    const FIXTURE_SHA: &str = "fadf29c0dbbfbbb39c94aaad7fb5e300f14313a1e663494225acb21b96fa9d44";

    /// One-shot loopback serving the fixture bytes (the download leg only —
    /// the whole fixture fits a single chunk).
    async fn serve_once(bytes: Vec<u8>) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let port = listener.local_addr().expect("addr").port();
        let task = tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 1024];
                loop {
                    match stream.read(&mut tmp).await {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: \
                     application/octet-stream\r\nconnection: close\r\n\r\n",
                    bytes.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&bytes).await;
                let _ = stream.shutdown().await;
            }
        });
        (port, task)
    }

    /// TEST-PC-09 (source order + idempotency): a verified bundled file is
    /// the first source and the install answers `installed` with source
    /// `bundled`; the second install of the same (id, version) returns the
    /// SAME model id without a duplicate store row.
    #[tokio::test]
    async fn bundled_source_installs_and_second_install_is_idempotent() {
        let (root, _guard) = scratch("bundled");
        let packed = root.join("packed.txr");
        let (size, sha) = run_packer(&packed);
        assert_eq!(sha, FIXTURE_SHA, "the pinned fixture sha");
        let bytes = std::fs::read(&packed).expect("packed bytes");

        let primary_bundle = root.join("pretrained-bundled");
        write_file(&primary_bundle.join("fx-rule-001@1.0.0.txr"), &bytes);
        let manager = DownloadManager::new(
            crate::modules::pretrained_catalogue::catalogue::PretrainedCatalogueSeams {
                data_root: Some(root.clone()),
                bundled_dir: None,
                ..Default::default()
            },
        );
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            "http://127.0.0.1:9/assets/never-used.txr",
            &sha,
            size,
            true,
            "CC0 1.0 (synthetic fixture)",
        );

        let pool = test_pool(&root.join("store.sqlite")).await;
        let out = install_entry(&pool, &entry, &manager)
            .await
            .expect("bundled install");
        let model_id = out.model_id.clone().expect("a store row id");
        assert_eq!(out.status, PretrainedInstallStatus::Installed);
        assert_eq!(out.source, PretrainedInstallSource::Bundled);
        assert_eq!(out.size_bytes, size);

        let rows = store::list_pretrained(&pool, Some("fx-rule-001"))
            .await
            .expect("list the pretrained rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id.to_string(), model_id);
        assert_eq!(
            rows[0].pretrained_catalogue_id.as_deref(),
            Some("fx-rule-001")
        );
        assert_eq!(
            rows[0].pretrained_catalogue_version.as_deref(),
            Some("1.0.0")
        );
        assert_eq!(
            rows[0].licence.as_deref(),
            Some("CC0 1.0 (synthetic fixture)")
        );
        // The bundle is intact — a reinstall is a row lookup, never a second import.
        assert!(primary_bundle.join("fx-rule-001@1.0.0.txr").is_file());

        let out2 = install_entry(&pool, &entry, &manager)
            .await
            .expect("second install");
        assert_eq!(out2.status, PretrainedInstallStatus::Installed);
        assert_eq!(out2.source, PretrainedInstallSource::Bundled);
        assert_eq!(out2.model_id.as_deref(), Some(model_id.as_str()));
        let rows = store::list_pretrained(&pool, Some("fx-rule-001"))
            .await
            .expect("list the pretrained rows");
        assert_eq!(rows.len(), 1, "no duplicate row for the same (id, version)");
    }

    /// TEST-PC-09 (source order): a verified content-addressed cache file is
    /// the second source (no bundle, no network).
    #[tokio::test]
    async fn cache_source_installs_without_network() {
        let (root, _guard) = scratch("cache");
        let packed = root.join("packed.txr");
        let (size, sha) = run_packer(&packed);
        let bytes = std::fs::read(&packed).expect("packed bytes");
        write_file(&downloader::cache_path(&root, &sha), &bytes);

        let manager = DownloadManager::new(
            crate::modules::pretrained_catalogue::catalogue::PretrainedCatalogueSeams {
                data_root: Some(root.clone()),
                ..Default::default()
            },
        );
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            "http://127.0.0.1:9/assets/never-used.txr",
            &sha,
            size,
            false,
            "CC0 1.0",
        );
        let pool = test_pool(&root.join("store.sqlite")).await;
        let out = install_entry(&pool, &entry, &manager)
            .await
            .expect("cache install");
        assert_eq!(out.status, PretrainedInstallStatus::Installed);
        assert_eq!(out.source, PretrainedInstallSource::Cache);
        assert!(out.model_id.is_some());
        // The download state agrees (ready + cached), and the cache file is
        // still the verified source.
        let st = manager.status(&entry);
        assert_eq!(st.state, PretrainedDownloadState::Ready);
        assert!(st.cached);
    }

    /// TEST-PC-09 (verify before use): a cached file whose sha256 no longer
    /// matches the catalogue entry (an updated entry) is NOT used — it is
    /// removed and the install starts the download (202 `installing`) and
    /// then completes from the VERIFIED downloaded bytes.
    #[tokio::test]
    async fn mismatched_cache_is_not_used_and_download_starts() {
        let (root, _guard) = scratch("mismatch");
        let packed = root.join("packed.txr");
        let (size, sha) = run_packer(&packed);
        let mut bytes = std::fs::read(&packed).expect("packed bytes");
        // Same length, different content: a stale cached copy of an updated
        // entry (the size verify would pass; the sha256 must not).
        bytes[0] ^= 0xff;
        write_file(&downloader::cache_path(&root, &sha), &bytes);

        let (port, server) = serve_once(std::fs::read(&packed).expect("packed bytes")).await;
        let manager = DownloadManager::new(
            crate::modules::pretrained_catalogue::catalogue::PretrainedCatalogueSeams {
                data_root: Some(root.clone()),
                ..Default::default()
            },
        );
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            &format!("http://127.0.0.1:{port}/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            size,
            false,
            "CC0 1.0",
        );
        let pool = test_pool(&root.join("store.sqlite")).await;

        let out = install_entry(&pool, &entry, &manager)
            .await
            .expect("install with stale cache");
        assert_eq!(
            out.status,
            PretrainedInstallStatus::Installing,
            "the stale cache was dropped and the download started"
        );
        assert_eq!(out.source, PretrainedInstallSource::Download);
        assert!(out.model_id.is_none());
        assert!(
            !downloader::cache_path(&root, &sha).exists(),
            "the mismatched cache file was removed, not used"
        );

        // The download the install started completes with a VERIFIED cache.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let st = manager.status(&entry);
            if st.state != PretrainedDownloadState::Downloading {
                assert_eq!(st.state, PretrainedDownloadState::Ready, "{:?}", st.error);
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the download stalled");
            tokio::time::sleep(std::time::Duration::from_millis(4)).await;
        }

        // The retried install imports the verified bytes (source: the cache).
        let out = install_entry(&pool, &entry, &manager)
            .await
            .expect("retry install");
        assert_eq!(out.status, PretrainedInstallStatus::Installed);
        assert_eq!(out.source, PretrainedInstallSource::Cache);
        assert!(out.model_id.is_some());
        let rows = store::list_pretrained(&pool, Some("fx-rule-001"))
            .await
            .expect("list the pretrained rows");
        assert_eq!(rows.len(), 1);
        server.await.expect("fixture server finishes");
    }

    /// TEST-PC-09 (INV-3 belt): a licence-less catalogue entry is `409
    /// PRETRAINED_LICENCE_MISSING` before any store call. (The store's OWN
    /// 422 LICENCE_REQUIRED answers the same condition on the import seam
    /// and passes through unrewritten — the belt firing first makes it
    /// unreachable on this module path; the no-mapping rule is the pin.)
    #[tokio::test]
    async fn licence_less_entry_is_409_belt() {
        let (root, _guard) = scratch("licence");
        let packed = root.join("packed.txr");
        let (size, sha) = run_packer(&packed);
        let bytes = std::fs::read(&packed).expect("packed bytes");
        write_file(
            &root.join("pretrained-bundled/fx-rule-001@1.0.0.txr"),
            &bytes,
        );
        let manager = DownloadManager::new(
            crate::modules::pretrained_catalogue::catalogue::PretrainedCatalogueSeams {
                data_root: Some(root.clone()),
                ..Default::default()
            },
        );
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            "http://127.0.0.1:9/assets/x.txr",
            &sha,
            size,
            true,
            "   ",
        );
        let pool = test_pool(&root.join("store.sqlite")).await;
        let err = install_entry(&pool, &entry, &manager)
            .await
            .expect_err("a licence-less entry refuses");
        assert_eq!(err.error_code(), "PRETRAINED_LICENCE_MISSING");
        assert_eq!(
            err.status_code(),
            409,
            "the belt is a 409, not the store's 422"
        );
        let rows = store::list_pretrained(&pool, Some("fx-rule-001"))
            .await
            .expect("list the pretrained rows");
        assert_eq!(rows.len(), 0, "no store call was made");
    }

    /// TEST-PC-09 (layout override): the bundled-dir constructor seam points
    /// the source order at a NON-default dir (the same resolution the
    /// `TXR_BUNDLED_MODELS_DIR` env override drives — the env branch
    /// itself is the seams' one-liner in `catalogue.rs` and is exercised
    /// end-to-end by the integration tier's spawned server, never by an
    /// in-process `set_var`).
    #[tokio::test]
    async fn bundled_dir_override_points_the_source_order() {
        let (root, _guard) = scratch("dir-override");
        let packed = root.join("packed.txr");
        let (size, sha) = run_packer(&packed);
        let bytes = std::fs::read(&packed).expect("packed bytes");
        let extra = root.join("extra-bundled");
        write_file(&extra.join("fx-rule-001@1.0.0.txr"), &bytes);
        assert!(!root.join("pretrained-bundled").exists());

        let manager = DownloadManager::new(
            crate::modules::pretrained_catalogue::catalogue::PretrainedCatalogueSeams {
                data_root: Some(root.clone()),
                bundled_dir: Some(extra.clone()),
                ..Default::default()
            },
        );
        assert_eq!(manager.seams().bundled_dir(), extra);
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            "http://127.0.0.1:9/assets/x.txr",
            &sha,
            size,
            true,
            "CC0 1.0",
        );
        let pool = test_pool(&root.join("store.sqlite")).await;
        let out = install_entry(&pool, &entry, &manager)
            .await
            .expect("override install");
        assert_eq!(out.status, PretrainedInstallStatus::Installed);
        assert_eq!(out.source, PretrainedInstallSource::Bundled);
        assert!(
            !root.join("pretrained-bundled").exists(),
            "the default dir was never consulted"
        );
    }
}
