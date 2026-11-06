//! The bundled-asset layout helpers (PROV-PC-12): the on-disk bundle dir
//! resolution, the embedded manifest's index parse and the per-file
//! sha256 + size verification that the install path's source order
//! (bundled → cache → download) and the download status's bundled leg both
//! run through — ONE verification function, no divergent copies (INV-11).
//!
//! The layout: the bundle dir is the seams' `bundled_dir()` (the
//! `CYTO_TXR_BUNDLED_MODELS_DIR` env override, else
//! `<data_root>/pretrained-bundled/` — resolved in `catalogue.rs`); each
//! bundled entry's file lives at `<bundled_dir>/<asset.file>` and is
//! verified against the CATALOGUE entry's `asset.sha256` + `asset.size_bytes`
//! (the embedded manifest and the catalogue entries are parity-checked at
//! boot, so verifying against the entry the card/install order reads is the
//! same contract — PROV-PC-12).
//!
//! INV-2: the verification happens BEFORE any store call; a mismatch is
//! surfaced as [`BundledVerifyError::ShaMismatch`] (the install path answers
//! `409 PRETRAINED_VERIFY_FAILED` and quarantines the file), and the source
//! order treats a missing file as "fall through", never as "verified".

use std::path::{Path, PathBuf};

use crate::modules::pretrained_catalogue::catalogue::{bundled_assets, PretrainedCatalogueSeams};
use crate::modules::pretrained_catalogue::types::{BundledAsset, PretrainedModel};

/// The per-file verification result: the verified layout path + its size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedBundle {
    pub path: PathBuf,
    pub size_bytes: u64,
}

/// The verification failure vocabulary (closed — the source order's
/// branches and the install's `409` message read the distinction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundledVerifyError {
    /// No bundled file for the entry (the source order falls through to
    /// cache/download — TEST-PC-23's "file removed" case).
    Missing,
    /// The file exists but its size differs from the catalogue entry's.
    SizeMismatch { expected: u64, found: u64 },
    /// The file exists, size matches, but the sha256 differs (INV-2).
    ShaMismatch { expected: String, found: String },
    /// The file could not be read (the verification never guesses).
    Io(String),
}

impl std::fmt::Display for BundledVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BundledVerifyError::Missing => write!(f, "no bundled file"),
            BundledVerifyError::SizeMismatch { expected, found } => {
                write!(
                    f,
                    "size mismatch (expected {expected} bytes, found {found})"
                )
            }
            BundledVerifyError::ShaMismatch { expected, found } => {
                write!(f, "sha256 mismatch (expected {expected}, found {found})")
            }
            BundledVerifyError::Io(detail) => write!(f, "read: {detail}"),
        }
    }
}

/// The embedded manifest's row for the entry — the index parse (the
/// boot-validated `bundled-models.json`; `None` for a non-bundled entry or
/// when the manifest was regenerated without it).
pub fn manifest_entry(entry: &PretrainedModel) -> Option<&'static BundledAsset> {
    if !entry.asset.bundled {
        return None;
    }
    bundled_assets()
        .iter()
        .find(|m| m.id == entry.id && m.version == entry.version)
}

/// The on-disk layout path for the entry:
/// `<bundled_dir>/<asset.file>` (the dir resolution is the seams' — this is
/// the ONE place the two join).
pub fn file_path(seams: &PretrainedCatalogueSeams, entry: &PretrainedModel) -> PathBuf {
    seams.bundled_dir().join(&entry.asset.file)
}

/// Verify the entry's bundled file against the catalogue entry's sha256 +
/// size (INV-2; the manifest's parity makes the entry the right reference).
pub fn verify(
    seams: &PretrainedCatalogueSeams,
    entry: &PretrainedModel,
) -> Result<VerifiedBundle, BundledVerifyError> {
    let path = file_path(seams, entry);
    let meta = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return Err(BundledVerifyError::Missing),
        Err(_) => return Err(BundledVerifyError::Missing),
    };
    if meta.len() != entry.asset.size_bytes {
        return Err(BundledVerifyError::SizeMismatch {
            expected: entry.asset.size_bytes,
            found: meta.len(),
        });
    }
    let found = sha256_file(&path).map_err(|e| BundledVerifyError::Io(e.to_string()))?;
    if found != entry.asset.sha256 {
        return Err(BundledVerifyError::ShaMismatch {
            expected: entry.asset.sha256.clone(),
            found,
        });
    }
    Ok(VerifiedBundle {
        path,
        size_bytes: meta.len(),
    })
}

/// The shared content-address helper: the file's hex sha256 (the bundle
/// verify above and the install path's cache re-verify both run through it —
/// one hashing implementation for every at-rest byte the module verifies).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// ─────────────────────────────────────────────────────────────────────────────
// The bundled.rs unit tests (TEST-PC-09's layout + verification legs; the
// source-order behaviour itself is exercised in install.rs's tests).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pretrained_catalogue::types::{
        PretrainedAsset, PretrainedEndpoint, PretrainedEnv, PretrainedKind, PretrainedMarkerFacts,
        PretrainedModel, PretrainedNeeds,
    };

    fn write_file(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("parent dir")).expect("parent dir");
        std::fs::write(path, bytes).expect("fixture file");
    }

    fn scratch_root(name: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("target")
            .join("pretrained-catalogue-item4-bundled")
            .join(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch root");
        root
    }

    /// A minimal valid-shaped entry (the verification only reads the asset
    /// fields; the card facts are synthetic filler).
    fn sample_entry(
        id: &str,
        asset_file: &str,
        sha: &str,
        size: u64,
        bundled: bool,
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
            licence: "CC0 1.0".to_string(),
            data_sources: vec![],
            asset: PretrainedAsset {
                bundled,
                file: asset_file.to_string(),
                url: "http://127.0.0.1:9/assets/never-used.txr".to_string(),
                size_bytes: size,
                sha256: sha.to_string(),
                signature: String::new(),
            },
        }
    }

    #[test]
    fn dir_resolution_and_index_parse() {
        let root = scratch_root("dir");
        let bundled_dir = root.join("pretrained-bundled");
        let seams = PretrainedCatalogueSeams {
            data_root: Some(root.clone()),
            bundled_dir: None,
            ..Default::default()
        };
        // The default layout is `<data_root>/pretrained-bundled/`.
        assert_eq!(
            seams.bundled_dir(),
            bundled_dir,
            "the default bundled dir is data_root/pretrained-bundled"
        );
        // The constructor seam overrides the layout (the env branch of the
        // same resolution is the seams' one-liner — exercised end-to-end by
        // the integration tier, never by in-process set_var).
        let overridden = PretrainedCatalogueSeams {
            bundled_dir: Some(root.join("extra-bundled")),
            ..Default::default()
        };
        assert_eq!(overridden.bundled_dir(), root.join("extra-bundled"));

        // The embedded manifest index: the shipped snapshot has no bundled
        // entries yet, so the parse is empty for now (the index contract is
        // pinned by the boot validate + the ITEM-2 tests; this asserts the
        // non-bundled lookup answers None rather than panicking).
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            "ab".repeat(32).as_str(),
            8,
            false,
        );
        assert!(manifest_entry(&entry).is_none());
    }

    #[test]
    fn verify_accepts_matching_bytes_only() {
        let root = scratch_root("verify");
        let body = b"the synthetic bundled model bytes";
        let sha = sha256_file(&{
            let p = root.join("body.bin");
            write_file(&p, body);
            p
        })
        .expect("hash");
        let seams = PretrainedCatalogueSeams {
            data_root: Some(root.clone()),
            bundled_dir: Some(root.join("bundled")),
            ..Default::default()
        };
        let entry = sample_entry(
            "fx-rule-001",
            "fx-rule-001@1.0.0.txr",
            &sha,
            body.len() as u64,
            true,
        );
        let path = file_path(&seams, &entry);
        assert_eq!(
            path,
            root.join("bundled/fx-rule-001@1.0.0.txr"),
            "the layout path joins the dir + the asset file"
        );

        // Absent → Missing (the source order falls through; never panic).
        assert_eq!(verify(&seams, &entry), Err(BundledVerifyError::Missing));

        // Matching bytes → verified with the real size.
        write_file(&path, body);
        let v = verify(&seams, &entry).expect("matching bytes verify");
        assert_eq!(v.path, path);
        assert_eq!(v.size_bytes, body.len() as u64);

        // Size mismatch → SizeMismatch (no hashing needed, no guessing).
        write_file(&path, &body[..body.len() - 1]);
        assert!(matches!(
            verify(&seams, &entry),
            Err(BundledVerifyError::SizeMismatch {
                expected,
                found
            }) if expected == body.len() as u64 && found == body.len() as u64 - 1
        ));

        // Same size, different bytes → ShaMismatch with both digests (INV-2).
        let tampered: Vec<u8> = body.iter().copied().rev().collect();
        assert_eq!(tampered.len(), body.len());
        write_file(&path, &tampered);
        assert!(matches!(
            verify(&seams, &entry),
            Err(BundledVerifyError::ShaMismatch { expected: e, found: f })
                if e == sha && f != sha
        ));
    }
}
