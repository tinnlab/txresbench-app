//! The `.txr` container codec (DEC-4) — the single-file format
//! that moves a saved model (or a whole set) between computers (board L's
//! "save as a file", board J's "open a model file"). Everything the format
//! touches is the user's own bytes: trees are copied as opaque artifact bytes
//! (INV-2), and the codec holds no decoder for any model format — the
//! container is uncompressed by design (OWNER-D2/D12: model artifacts are
//! already internally compressed, and `check-no-format-crates.sh`'s
//! decode-scope stays untouched).
//!
//! ### The exact byte layout (one container = one model or one whole set)
//!
//! All integers little-endian. The container is deterministic — models sorted
//! by token, entry paths sorted, training entries sorted — so the same export
//! writes byte-identical bytes:
//!
//! ```text
//! magic:    "TXR_MODL\0"                       (9 bytes)
//! u32 header_len; header JSON (UTF-8)          (see ContainerHeader)
//! per model, in header order:
//!   u32 entry_count
//!   per entry:
//!     u16 relpath_len; UTF-8 relpath           ('/'-separated, relative)
//!     u64 bytes_len; the bytes; 32-byte sha256 (of the bytes)
//! u64 training_entry_count (0 when none)
//!   per entry: same framing as a model entry
//! end magic: "TXR_MODLEND\0"                   (12 bytes)
//! ```
//!
//! The magic spellings are the PLAN's `T.X.R._M.O.D.L.` / `T.X.R._M.O.D.L.
//! E.N.D.` with the mnemonic dots removed — the end magic's 12-byte count in
//! the plan matches exactly that reading, and `END_MAGIC` is `MAGIC` minus
//! its NUL plus `END\0` (see DRIFT-1 ITEM-4 #1 for the byte-count
//! reconciliation).
//!
//! ### Writer discipline
//!
//! [`write_container`] computes every byte-level fact itself (per-file sha256,
//! `size_bytes`) and verifies each tree against its recorded
//! [`tree_sha256`](crate::modules::sandbox::stack::tree_sha256) BEFORE a
//! single byte is emitted — an export is the verified artifact, never a claim
//! about bytes it did not look at (DEC-5's verification semantics replayed at
//! the write boundary too; a tree whose bytes no longer match its recorded
//! digest refuses to become a container). Entry paths walk the PROV-SS-3
//! regular-files-only selection (a tree IS its regular files), and a path the
//! container cannot represent (non-UTF-8 component, `:`/`\`) refuses the
//! export — a container this writer could not import is not written.
//!
//! ### Reader discipline
//!
//! [`read_container`] extracts to a fresh staging dir the caller owns; on ANY
//! failure the staging dir is removed (a failed import lands nothing) and the
//! error names the failing byte (magic/version, framing, sha256, tree digest,
//! path safety, size reconciliation, the container size cap). Verification
//! depth is DEC-5's: every per-file sha256 AND the restored tree's digest
//! against the header's recorded `tree_sha256`
//! ([`verify_model_tree`]) — an imported model is the exact reuse asset the
//! engine binds (CONS-MS-10: one digest definition, never re-implemented).
//! Paths are validated before any write (no `..`, no absolute, no `:`/`\`, no
//! symlinked parent), the container's declared sizes are reconciled against
//! the restored bytes, and the whole container is capped at the caller's byte
//! limit (the import route's `ModelStoreLimits::MAX_CONTAINER_BYTES`).
//!
//! ### Reader/staging contract
//!
//! The staging layout is: `<staging>/model-<index>/…` per restorable tree and
//! `<staging>/training/<relpath>` per training file. Model sections are
//! staged by INDEX, never by header token — a token is a header fact, not a
//! path component (an attacker-controlled header must never influence a
//! filesystem path). ITEM-5's import moves the restored trees into
//! `trees/<tree_sha256>/` (content-addressed reuse) and the training files
//! into `training/<set_id>/`.

use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::modules::execution_engine::types::{TxrEndpoint, TxrMethodEnv, TxrTask};
use crate::modules::method_catalogue::types::RequiredMarkers;
use crate::modules::model_store::types::{CovariateFacts, MarkerFacts, ModelProvenance};
use crate::modules::sandbox::stack::verify_model_tree;
use txresbench_core::AppError;

// ─────────────────────────────────────────────────────────────────────────────
// Format constants + the error vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/// The container's leading magic — `TXR_MODL` + NUL (the plan's spelled
/// `T.X.R._M.O.D.L.` + NUL with the mnemonic dots removed, 9 bytes; see the
/// module doc and DRIFT-1 ITEM-4 #1).
pub const MAGIC: [u8; 9] = *b"TXR_MODL\0";

/// The container's trailing magic — `TXR_MODLEND` + NUL (12 bytes; the plan's
/// spelled `T.X.R._M.O.D.L.E.N.D.` + NUL dot-stripped — the plan's own byte
/// count for the end magic matches this reading exactly).
pub const END_MAGIC: [u8; 12] = *b"TXR_MODLEND\0";

/// The container format version (the header's `format_version`).
pub const FORMAT_VERSION: u32 = 1;

/// The header JSON's framing bound (a defensive bound on an untrusted length
/// field, DEC-13's spirit: a real header for `MAX_CONTAINER_MODELS` models
/// stays far below 16 MiB).
pub const MAX_HEADER_BYTES: u32 = 16 * 1024 * 1024;

/// The header's model-count bound — a defensive fan-out bound on how many
/// `model-<index>` dirs one import can create before any payload byte is
/// read. A real set's model count is the user's own saves (each ≤ 64),
/// orders of magnitude below.
pub const MAX_CONTAINER_MODELS: usize = 4096;

/// The read/write framing band: how many bytes are streamed per entry-payload
/// chunk. An entry payload is NEVER buffered whole (DEC-4's uncompressed
/// container is still streamed, not loaded).
const FRAME_CHUNK: usize = 64 * 1024;

/// The container codec's typed error vocabulary (the plan's import codes
/// `INVALID_CONTAINER` / `CONTAINER_TOO_LARGE` / `UNSAFE_PATH`). Tree-digest
/// failures carry the sandbox seam's own `MODEL_VERIFY_FAILED` — the module's
/// one digest vocabulary, never a second code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerErrorCode {
    InvalidContainer,
    ContainerTooLarge,
    UnsafePath,
}

impl ContainerErrorCode {
    /// The stable machine code of the failure.
    pub fn as_str(self) -> &'static str {
        match self {
            ContainerErrorCode::InvalidContainer => "INVALID_CONTAINER",
            ContainerErrorCode::ContainerTooLarge => "CONTAINER_TOO_LARGE",
            ContainerErrorCode::UnsafePath => "UNSAFE_PATH",
        }
    }

    /// The closed code list, in documentation order.
    pub const ALL: [ContainerErrorCode; 3] = [
        ContainerErrorCode::InvalidContainer,
        ContainerErrorCode::ContainerTooLarge,
        ContainerErrorCode::UnsafePath,
    ];
}

fn container_err(code: ContainerErrorCode, message: impl Into<String>) -> AppError {
    AppError::bad_request(code.as_str(), message)
}

fn invalid_container(message: impl Into<String>) -> AppError {
    container_err(ContainerErrorCode::InvalidContainer, message)
}

fn unsafe_path(message: impl Into<String>) -> AppError {
    container_err(ContainerErrorCode::UnsafePath, message)
}

// ─────────────────────────────────────────────────────────────────────────────
// The header JSON (serde — the container's metadata block, NOT wire types:
// the OpenAPI surface is the routes' own; TESTS.md's distinction. Every
// `|null` field of the plan's layout is a plain Option so the JSON carries
// explicit nulls and the byte layout is independent of serde's skip-empty
// opinions.)
// ─────────────────────────────────────────────────────────────────────────────

/// The container's header. `set` is present iff `kind` is `set`; `training`
/// lists the carried training files (set containers only) with the same
/// sha256/size facts the trailing payload repeats.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerHeader {
    pub format_version: u32,
    pub kind: ContainerKind,
    pub set: Option<ContainerSet>,
    pub models: Vec<ContainerModel>,
    pub training: Option<Vec<ContainerTrainingEntry>>,
}

/// What the container carries (the plan's `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerKind {
    Model,
    Set,
}

/// The recorded set facts of a set container (the import recreates the set
/// fresh — the row ids are the local store's, never carried in the file).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerSet {
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub source_label: Option<String>,
    pub keep_training_files: bool,
}

/// One model's header entry. `tree_sha256` and `size_bytes` are claims the
/// writer verifies/derives and the reader reconciles; the rest are the
/// recorded facts the import stamps on the new row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerModel {
    /// Unique within the container (the section's key — a header fact only,
    /// never a path component).
    pub token: String,
    #[serde(flatten)]
    pub facts: ContainerModelFacts,
    pub tree_sha256: String,
    pub size_bytes: u64,
}

/// The recorded model facts (everything the writer does not derive from the
/// tree bytes — see [`ContainerModel`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerModelFacts {
    pub name: String,
    pub method_id: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    pub task: Option<TxrTask>,
    pub provenance: ContainerProvenance,
    pub trained_on_patients: Option<u32>,
    pub trained_at: Option<DateTime<Utc>>,
    pub decision_day: f64,
    pub endpoint: TxrEndpoint,
    pub horizon: f64,
    pub contract: String,
    pub env: TxrMethodEnv,
    pub features: Vec<String>,
    pub required_markers: Option<RequiredMarkers>,
    pub marker_facts: MarkerFacts,
    pub covariates: CovariateFacts,
    pub embeds_training_data: bool,
    pub own_auc: Option<f64>,
    pub own_c: Option<f64>,
}

/// The recorded provenance of a model in the container (the plan's
/// `{kind, imported_from|null, catalogue_id|null, licence|null}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerProvenance {
    pub kind: ModelProvenance,
    pub imported_from: Option<String>,
    pub catalogue_id: Option<String>,
    pub licence: Option<String>,
}

/// One training file's header record (the trailing payload repeats the bytes
/// with the same sha256).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerTrainingEntry {
    pub relpath: String,
    /// Lowercase hex sha256 of the file's bytes (the header's spelling; the
    /// trailing payload carries the digest as its raw 32 bytes).
    pub sha256: String,
    pub size_bytes: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer inputs — an export request; the byte-level facts are derived
// ─────────────────────────────────────────────────────────────────────────────

/// One model to write: the recorded facts + the recorded tree digest + the
/// tree dir. The writer walks the dir itself, so the container's per-file
/// hashes and sizes are what the bytes actually are (never a caller's claim).
#[derive(Debug, Clone)]
pub struct ContainerModelSpec {
    pub token: String,
    pub facts: ContainerModelFacts,
    pub tree_sha256: String,
    pub tree_dir: PathBuf,
}

/// One training file to write: the relpath the restored set keeps + the
/// source file.
#[derive(Debug, Clone)]
pub struct ContainerTrainingSpec {
    pub relpath: String,
    pub src: PathBuf,
}

/// The export request: `set = None` is a single-model container (kind
/// `model`, exactly one model, no training); `set = Some(..)` is a whole-set
/// container (kind `set`, ≥ 1 model, the carried training files).
#[derive(Debug, Clone)]
pub struct ContainerExport {
    pub set: Option<ContainerSet>,
    pub models: Vec<ContainerModelSpec>,
    pub training: Vec<ContainerTrainingSpec>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader outputs — what the import consumes
// ─────────────────────────────────────────────────────────────────────────────

/// One restored model tree (verified on arrival: size reconciled, per-file
/// sha256s checked, tree digest re-derived against the header).
#[derive(Debug)]
pub struct RestoredModel {
    /// The header's token (the section's key — not a path).
    pub token: String,
    /// The restored tree: `<staging>/model-<index>`.
    pub dir: PathBuf,
    /// The header's model entry (the recorded facts the new row is stamped
    /// with; `size_bytes` is now verified).
    pub header: ContainerModel,
}

/// One restored training file (its sha256 verified against the header).
#[derive(Debug)]
pub struct RestoredTrainingFile {
    pub relpath: String,
    /// The restored file: `<staging>/training/<relpath>`.
    pub path: PathBuf,
    pub size_bytes: u64,
    /// The header's recorded sha256 (verified — the payload matched it).
    pub sha256: String,
}

/// The reader's result: the header (parsed, validated) + the restored trees +
/// the restored training files, all under the staging dir.
#[derive(Debug)]
pub struct ContainerReadResult {
    pub header: ContainerHeader,
    pub models: Vec<RestoredModel>,
    pub training: Vec<RestoredTrainingFile>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer
// ─────────────────────────────────────────────────────────────────────────────

/// Write `export` as one `.txr` container to `w`; returns the container's
/// total byte size. Deterministic: models sorted by token, entry paths
/// sorted, training entries sorted — the same export is byte-identical.
/// Nothing is emitted before every tree is verified against its recorded
/// digest (an export is the verified artifact — DEC-5 at the write boundary).
pub fn write_container<W: Write>(mut w: W, export: &ContainerExport) -> Result<u64, AppError> {
    let prepared = prepare(export)?;

    let header = ContainerHeader {
        format_version: FORMAT_VERSION,
        kind: if export.set.is_some() {
            ContainerKind::Set
        } else {
            ContainerKind::Model
        },
        set: export.set.clone(),
        models: prepared.models.iter().map(|p| p.header.clone()).collect(),
        training: if prepared.training.is_empty() {
            None
        } else {
            Some(
                prepared
                    .training
                    .iter()
                    .map(|t| ContainerTrainingEntry {
                        relpath: t.relpath.clone(),
                        sha256: t.sha256.clone(),
                        size_bytes: t.size_bytes,
                    })
                    .collect(),
            )
        },
    };
    let header_bytes = serde_json::to_vec(&header)
        .map_err(|e| AppError::internal_error(format!("serialize the .txr header: {e}")))?;
    if header_bytes.len() > MAX_HEADER_BYTES as usize {
        return Err(AppError::internal_error(format!(
            "the .txr header is {} bytes, over the {} byte bound",
            header_bytes.len(),
            MAX_HEADER_BYTES
        )));
    }
    let header_len = u32::try_from(header_bytes.len())
        .map_err(|_| AppError::internal_error("the .txr header exceeds u32".to_string()))?;

    write_all(&mut w, &MAGIC, "the container's leading magic")?;
    write_all(&mut w, &header_len.to_le_bytes(), "the header length")?;
    write_all(&mut w, &header_bytes, "the header")?;

    for model in &prepared.models {
        let entry_count = u32::try_from(model.entries.len())
            .map_err(|_| AppError::internal_error("a tree has over u32 entries".to_string()))?;
        write_all(&mut w, &entry_count.to_le_bytes(), "a model's entry count")?;
        for (relpath, path, size) in &model.entries {
            write_entry(&mut w, relpath, path, *size)?;
        }
    }

    let training_count = u64::try_from(prepared.training.len())
        .map_err(|_| AppError::internal_error("a set has over u64 training files".to_string()))?;
    write_all(
        &mut w,
        &training_count.to_le_bytes(),
        "the training entry count",
    )?;
    for t in &prepared.training {
        write_entry(&mut w, &t.relpath, &t.src, t.size_bytes)?;
    }

    write_all(&mut w, &END_MAGIC, "the container's end magic")?;
    Ok(total_size(&prepared, header_bytes.len()))
}

/// A prepared model: the sorted header entry + the sorted entry list
/// (relpath → source path + byte size) the writer streams.
struct PreparedModel {
    header: ContainerModel,
    entries: Vec<(String, PathBuf, u64)>,
}

struct PreparedTraining {
    relpath: String,
    src: PathBuf,
    sha256: String,
    size_bytes: u64,
}

struct Prepared {
    models: Vec<PreparedModel>,
    training: Vec<PreparedTraining>,
}

/// Validate the export shape + walk + verify every tree, then sort
/// deterministically. Nothing is written by [`prepare`] itself — every
/// refusal happens (and every byte is hashed/verified) before the first
/// container byte.
fn prepare(export: &ContainerExport) -> Result<Prepared, AppError> {
    let is_set = export.set.is_some();
    if !is_set && export.models.len() != 1 {
        return Err(invalid_container(format!(
            "a single-model .txr container carries exactly one model; the export has {}",
            export.models.len()
        )));
    }
    if !is_set && !export.training.is_empty() {
        return Err(invalid_container(
            "a single-model .txr container carries no training files",
        ));
    }
    if is_set && export.models.is_empty() {
        return Err(invalid_container(
            "a set .txr container carries at least one model",
        ));
    }
    if export.models.len() > MAX_CONTAINER_MODELS {
        return Err(invalid_container(format!(
            "the export carries {} models, over the {} bound",
            export.models.len(),
            MAX_CONTAINER_MODELS
        )));
    }

    let mut seen_tokens = std::collections::BTreeSet::new();
    for m in &export.models {
        if m.token.is_empty() {
            return Err(invalid_container("a model token is empty"));
        }
        if !seen_tokens.insert(m.token.clone()) {
            return Err(invalid_container(format!(
                "a model token repeats in the container: {:?}",
                m.token
            )));
        }
    }

    // Deterministic: models by token, training by relpath; per-tree entry
    // sorting happens in the walk below.
    let mut order: Vec<&ContainerModelSpec> = export.models.iter().collect();
    order.sort_by(|a, b| a.token.cmp(&b.token));

    let mut models = Vec::with_capacity(order.len());
    for spec in order {
        let mut entries: Vec<(String, PathBuf, u64)> = collect_relpaths(&spec.tree_dir)?
            .into_iter()
            .map(|(rel, path)| {
                let size = fs::metadata(&path)
                    .map(|m| m.len())
                    .map_err(|e| {
                        AppError::internal_error(format!("stat {}: {e}", path.display()))
                    })?;
                Ok((rel, path, size))
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        // The digest walks the tree in relpath byte order; the writer sorts
        // the same way, so the container's entry order IS the digest's order.
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        // DEC-5 at the write boundary: the bytes this container carries must
        // match the digest the header claims. A mismatch means the recorded
        // artifact is not what its identity says — refuse before a byte is
        // emitted (a container that could never import is not exported).
        verify_model_tree(&spec.tree_dir, &spec.tree_sha256)?;

        let size = entries.iter().map(|(_, _, s)| *s).sum::<u64>();
        models.push(PreparedModel {
            header: ContainerModel {
                token: spec.token.clone(),
                facts: spec.facts.clone(),
                tree_sha256: spec.tree_sha256.clone(),
                size_bytes: size,
            },
            entries,
        });
    }

    let mut training = Vec::with_capacity(export.training.len());
    let mut seen_training = std::collections::BTreeSet::new();
    for t in &export.training {
        validate_relpath(&t.relpath)?;
        if !seen_training.insert(t.relpath.clone()) {
            return Err(invalid_container(format!(
                "a training relpath repeats in the container: {:?}",
                t.relpath
            )));
        }
        // The header's sha256 is streamed (a training CSV can be big; the
        // codec's never-buffer-whole rule applies to the header facts too).
        let mut file = fs::File::open(&t.src).map_err(|e| {
            AppError::internal_error(format!("read training file {}: {e}", t.src.display()))
        })?;
        let size = file
            .metadata()
            .map_err(|e| AppError::internal_error(format!("stat {}: {e}", t.src.display())))?
            .len();
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; FRAME_CHUNK];
        loop {
            let n = file.read(&mut buf).map_err(|e| {
                AppError::internal_error(format!("read training file {}: {e}", t.src.display()))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        training.push(PreparedTraining {
            relpath: t.relpath.clone(),
            src: t.src.clone(),
            sha256: hex::encode(hasher.finalize()),
            size_bytes: size,
        });
    }
    training.sort_by(|a, b| a.relpath.cmp(&b.relpath));

    Ok(Prepared { models, training })
}

/// The container's total byte size, computed from the same structures the
/// writer streams (exact by construction — the writer's `u64` return).
fn total_size(prepared: &Prepared, header_len: usize) -> u64 {
    let mut total = (MAGIC.len() + 4 + header_len + 8 + END_MAGIC.len()) as u64;
    for m in &prepared.models {
        total += 4; // u32 entry_count
        for (relpath, _, size) in &m.entries {
            total += 2 + relpath.len() as u64 + 8 + size + 32;
        }
    }
    for t in &prepared.training {
        total += 2 + t.relpath.len() as u64 + 8 + t.size_bytes + 32;
    }
    total
}

/// Write one length-prefixed entry (model or training — the same framing).
fn write_entry<W: Write>(
    w: &mut W,
    relpath: &str,
    path: &Path,
    bytes_len: u64,
) -> Result<(), AppError> {
    let relpath_len = u16::try_from(relpath.len())
        .map_err(|_| unsafe_path(format!("an entry path is {} bytes, over u16", relpath.len())))?;
    write_all(w, &relpath_len.to_le_bytes(), "an entry path length")?;
    write_all(w, relpath.as_bytes(), "an entry path")?;
    write_all(w, &bytes_len.to_le_bytes(), "an entry byte length")?;

    let mut file = fs::File::open(path)
        .map_err(|e| AppError::internal_error(format!("read {}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; FRAME_CHUNK];
    let mut remaining = bytes_len;
    while remaining > 0 {
        let to_read = remaining.min(FRAME_CHUNK as u64) as usize;
        let n = file.read(&mut buf[..to_read]).map_err(|e| {
            AppError::internal_error(format!("read {}: {e}", path.display()))
        })?;
        if n == 0 {
            return Err(AppError::internal_error(format!(
                "{} shortened while read (declared {bytes_len} bytes)",
                path.display()
            )));
        }
        let chunk = &buf[..n];
        write_all(w, chunk, "an entry's bytes")?;
        hasher.update(chunk);
        remaining -= chunk.len() as u64;
    }
    write_all(w, &hasher.finalize(), "an entry's sha256")?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────────

/// Read + validate a `.txr` container, streaming every entry payload into
/// `staging_root`. Returns the parsed header and the restored trees/training
/// files. On ANY failure the staging dir is removed (a failed import lands
/// nothing) and the error names the failing byte. `max_container_bytes`
/// bounds the whole container (the import route passes
/// `ModelStoreLimits::MAX_CONTAINER_BYTES`); the byte-level bounds
/// ([`MAX_HEADER_BYTES`], [`MAX_CONTAINER_MODELS`]) are the codec's framing
/// rules.
pub fn read_container<R: Read + Seek>(
    mut reader: R,
    staging_root: &Path,
    max_container_bytes: u64,
) -> Result<ContainerReadResult, AppError> {
    let total = container_len(&mut reader)?;
    if total > max_container_bytes {
        return Err(container_err(
            ContainerErrorCode::ContainerTooLarge,
            format!(
                "the .txr container is {total} bytes, over the {max_container_bytes} byte limit"
            ),
        ));
    }
    fs::create_dir_all(staging_root)
        .map_err(|e| AppError::internal_error(format!("create the staging dir: {e}")))?;
    let result = read_inner(&mut reader, staging_root);
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_root);
    }
    result
}

/// The in-process seam's byte flavor (PROV-MS-10's `install_imported`).
pub fn read_container_bytes(
    bytes: &[u8],
    staging_root: &Path,
    max_container_bytes: u64,
) -> Result<ContainerReadResult, AppError> {
    read_container(Cursor::new(bytes), staging_root, max_container_bytes)
}

fn container_len<R: Read + Seek>(reader: &mut R) -> Result<u64, AppError> {
    let total = reader
        .seek(SeekFrom::End(0))
        .map_err(|e| AppError::internal_error(format!("size the container: {e}")))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|e| AppError::internal_error(format!("rewind the container: {e}")))?;
    Ok(total)
}

fn read_inner<R: Read + Seek>(
    reader: &mut R,
    staging_root: &Path,
) -> Result<ContainerReadResult, AppError> {
    let mut magic = [0u8; MAGIC.len()];
    read_exact(reader, &mut magic, "the container's leading magic")?;
    if magic != MAGIC {
        return Err(invalid_container(
            "the leading magic is not a .txr container",
        ));
    }

    let header_len = read_u32(reader, "the header length")?;
    if header_len == 0 || header_len > MAX_HEADER_BYTES {
        return Err(invalid_container(format!(
            "the header length is {header_len}, outside 1..={MAX_HEADER_BYTES}"
        )));
    }
    let mut header_bytes = vec![0u8; header_len as usize];
    read_exact(reader, &mut header_bytes, "the header")?;
    let header: ContainerHeader = serde_json::from_slice(&header_bytes)
        .map_err(|e| invalid_container(format!("the header is not valid .txr JSON: {e}")))?;
    validate_header(&header)?;

    // Per model, in header order: entries -> staging/model-<index>.
    let mut models = Vec::with_capacity(header.models.len());
    for (index, expected) in header.models.iter().enumerate() {
        let dir = staging_root.join(format!("model-{index}"));
        fs::create_dir_all(&dir).map_err(|e| {
            AppError::internal_error(format!("create {}: {e}", dir.display()))
        })?;
        let mut seen = std::collections::BTreeSet::new();
        let mut entry_count = read_u32(reader, "a model's entry count")?;
        if entry_count == 0 {
            return Err(invalid_container(format!(
                "the model section {:?} carries no entries",
                expected.token
            )));
        }
        let mut size_sum = 0u64;
        while entry_count > 0 {
            let (_, size, _) = read_entry(reader, staging_root, &dir, &mut seen)?;
            size_sum += size;
            entry_count -= 1;
        }
        if size_sum != expected.size_bytes {
            return Err(invalid_container(format!(
                "the model section {:?} declares {} bytes but carries {}",
                expected.token, expected.size_bytes, size_sum
            )));
        }
        // The restored tree's digest against the header's recorded value —
        // the same verification the engine ran at fit time; the import's
        // verify-on-arrival (DEC-5; the seam's MODEL_VERIFY_FAILED).
        verify_model_tree(&dir, &expected.tree_sha256)?;
        models.push(RestoredModel {
            token: expected.token.clone(),
            dir,
            header: expected.clone(),
        });
    }

    let mut training = Vec::new();
    let training_dir = staging_root.join("training");
    fs::create_dir_all(&training_dir).map_err(|e| {
        AppError::internal_error(format!("create {}: {e}", training_dir.display()))
    })?;
    let training_count = read_u64(reader, "the training entry count")?;
    let expected_training = header.training.as_deref().unwrap_or(&[]);
    if training_count as usize != expected_training.len() {
        return Err(invalid_container(format!(
            "the header lists {} training files but the payload carries {training_count}",
            expected_training.len()
        )));
    }
    for (i, expected) in expected_training.iter().enumerate() {
        let path = training_dir.join(&expected.relpath);
        let mut seen = std::collections::BTreeSet::new();
        let (got_relpath, size, sha) =
            read_entry(reader, staging_root, &training_dir, &mut seen)?;
        if got_relpath != expected.relpath {
            return Err(invalid_container(format!(
                "the training field {i} declares {:?} but carries {got_relpath:?}",
                expected.relpath
            )));
        }
        if sha != expected.sha256 {
            return Err(invalid_container(format!(
                "the training file {:?} has sha256 {sha} but the header recorded {}",
                expected.relpath, expected.sha256
            )));
        }
        if size != expected.size_bytes {
            return Err(invalid_container(format!(
                "the training file {:?} carries {size} bytes but the header recorded {}",
                expected.relpath, expected.size_bytes
            )));
        }
        training.push(RestoredTrainingFile {
            relpath: expected.relpath.clone(),
            path,
            size_bytes: size,
            sha256: sha,
        });
    }

    let mut end_magic = [0u8; END_MAGIC.len()];
    read_exact(reader, &mut end_magic, "the container's end magic")?;
    if end_magic != END_MAGIC {
        return Err(invalid_container(
            "the container's end magic is missing (truncated or foreign bytes)",
        ));
    }
    // The container is exact-serialized: nothing may follow the end magic.
    let mut trailing = [0u8; 1];
    match reader.read(&mut trailing) {
        Ok(0) => Ok(ContainerReadResult {
            header,
            models,
            training,
        }),
        Ok(_) => Err(invalid_container(
            "trailing bytes after the container's end magic",
        )),
        Err(e) => Err(AppError::internal_error(format!(
            "read past the container's end magic: {e}"
        ))),
    }
}

/// The header's structural rules (the plan's `kind` semantics + the format's
/// own invariants; a header that fails these is refused before a byte lands).
fn validate_header(header: &ContainerHeader) -> Result<(), AppError> {
    if header.format_version != FORMAT_VERSION {
        return Err(invalid_container(format!(
            "the container format version is {}; this app reads {FORMAT_VERSION}",
            header.format_version
        )));
    }
    match header.kind {
        ContainerKind::Model => {
            if header.set.is_some() {
                return Err(invalid_container(
                    "a single-model container carries a set block",
                ));
            }
            if header.models.len() != 1 {
                return Err(invalid_container(format!(
                    "a single-model container carries {} models; the format carries exactly one",
                    header.models.len()
                )));
            }
            if header.training.as_ref().is_some_and(|t| !t.is_empty()) {
                return Err(invalid_container(
                    "a single-model container carries training files",
                ));
            }
        }
        ContainerKind::Set => {
            if header.set.is_none() {
                return Err(invalid_container("a set container carries no set block"));
            }
            if header.models.is_empty() {
                return Err(invalid_container("a set container carries no models"));
            }
        }
    }
    if header.models.len() > MAX_CONTAINER_MODELS {
        return Err(invalid_container(format!(
            "the container carries {} models, over the {} bound",
            header.models.len(),
            MAX_CONTAINER_MODELS
        )));
    }
    let mut seen = std::collections::BTreeSet::new();
    for m in &header.models {
        if m.token.is_empty() {
            return Err(invalid_container("a model token is empty"));
        }
        if !seen.insert(&m.token) {
            return Err(invalid_container(format!(
                "a model token repeats in the container: {:?}",
                m.token
            )));
        }
    }
    // The header's training list names each payload entry; it must be
    // canonical (the writer's determinism rule: unique, safe relpaths).
    let mut seen_training = std::collections::BTreeSet::new();
    if let Some(training) = &header.training {
        for t in training {
            validate_relpath(&t.relpath)?;
            if t.sha256.len() != 64 || !t.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(invalid_container(format!(
                    "the training file {:?} records a malformed sha256",
                    t.relpath
                )));
            }
            if !seen_training.insert(&t.relpath) {
                return Err(invalid_container(format!(
                    "a training relpath repeats in the header: {:?}",
                    t.relpath
                )));
            }
        }
    }
    Ok(())
}

/// Read + validate one entry and write its payload into `dir/<relpath>`
/// (streamed — never whole-in-memory). Returns (relpath, byte size, hex
/// sha256). `seen` rejects duplicate relpaths within the section; `staging`
/// is the root the whole chain check walks (the SECTION dir itself is part
/// of the chain — a link planted there must not be followed either).
fn read_entry<R: Read + Seek>(
    reader: &mut R,
    staging: &Path,
    dir: &Path,
    seen: &mut std::collections::BTreeSet<String>,
) -> Result<(String, u64, String), AppError> {
    let relpath_len = read_u16(reader, "an entry path length")?;
    if relpath_len == 0 {
        return Err(invalid_container("an entry path is empty"));
    }
    let mut relpath_bytes = vec![0u8; relpath_len as usize];
    read_exact(reader, &mut relpath_bytes, "an entry path")?;
    let relpath =
        String::from_utf8(relpath_bytes).map_err(|_| invalid_container("an entry path is not UTF-8"))?;
    validate_relpath(&relpath)?;
    if !seen.insert(relpath.clone()) {
        return Err(invalid_container(format!(
            "an entry path repeats in the section: {relpath:?}"
        )));
    }

    let bytes_len = read_u64(reader, "an entry byte length")?;
    let target = dir.join(&relpath);
    ensure_safe_parents(staging, &target)?;
    let mut out = fs::File::create(&target)
        .map_err(|e| AppError::internal_error(format!("create {}: {e}", target.display())))?;

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; FRAME_CHUNK];
    let mut remaining = bytes_len;
    while remaining > 0 {
        // Read at most `remaining` bytes in one go — a `Read` may legally
        // return the whole rest of the container, and this loop must not
        // consume more than the declared payload (the sha256 + framing that
        // follow belong to the next field).
        let to_read = remaining.min(FRAME_CHUNK as u64) as usize;
        let n = reader
            .read(&mut buf[..to_read])
            .map_err(|e| AppError::internal_error(format!("read an entry's bytes: {e}")))?;
        if n == 0 {
            return Err(invalid_container(format!(
                "truncated: the entry {:?} declares {bytes_len} bytes",
                relpath
            )));
        }
        let chunk = &buf[..n];
        out.write_all(chunk)
            .map_err(|e| AppError::internal_error(format!("write {}: {e}", target.display())))?;
        hasher.update(chunk);
        remaining -= chunk.len() as u64;
    }
    let computed = hasher.finalize();

    let mut declared = [0u8; 32];
    read_exact(reader, &mut declared, "an entry's sha256")?;
    if computed[..] != declared[..] {
        return Err(invalid_container(format!(
            "the entry {:?} fails its sha256 (the file is not what the container was made from)",
            relpath
        )));
    }
    Ok((relpath, bytes_len, hex::encode(computed)))
}

/// The relpath safety rule (UNSAFE_PATH): relative, `/`-separated, canonical
/// segments only. Refused: empty, absolute (`/…`), `..` / `.` segments, empty
/// segments (`a//b`), `\` (the other platform's separator) and `:` (a
/// drive-letter prefix / NTFS stream component — the container must be
/// portable between the app's platforms).
fn validate_relpath(relpath: &str) -> Result<(), AppError> {
    if relpath.is_empty() {
        return Err(unsafe_path("an entry path is empty"));
    }
    if relpath.starts_with('/') {
        return Err(unsafe_path(format!("an entry path is absolute: {relpath:?}")));
    }
    if relpath.contains('\\') || relpath.contains(':') {
        return Err(unsafe_path(format!(
            "an entry path contains a cross-platform hazard character: {relpath:?}"
        )));
    }
    for seg in relpath.split('/') {
        if seg.is_empty() {
            return Err(unsafe_path(format!(
                "an entry path has an empty segment: {relpath:?}"
            )));
        }
        if seg == "." || seg == ".." {
            return Err(unsafe_path(format!(
                "an entry path escapes the staging dir: {relpath:?}"
            )));
        }
    }
    Ok(())
}

/// Walk EVERY ancestor of `target` under `staging` and refuse a symlink in it
/// (an entry that would write THROUGH a link out of the staging dir — the
/// section dirs included) or an existing non-directory component; create the
/// missing parents.
fn ensure_safe_parents(staging: &Path, target: &Path) -> Result<(), AppError> {
    let rel = target.strip_prefix(staging).map_err(|e| {
        AppError::internal_error(format!(
            "the entry path {} is outside the staging dir: {e}",
            target.display()
        ))
    })?;
    let mut current = staging.to_path_buf();
    let components: Vec<_> = rel.components().collect();
    for comp in &components[..components.len().saturating_sub(1)] {
        current.push(comp.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(unsafe_path(format!(
                        "an entry path resolves through a symlink out of the staging dir: {}",
                        current.display()
                    )));
                }
                if !meta.is_dir() {
                    return Err(invalid_container(format!(
                        "an entry's parent is not a directory: {}",
                        current.display()
                    )));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|e| {
                    AppError::internal_error(format!("create {}: {e}", current.display()))
                })?;
            }
            Err(e) => {
                return Err(AppError::internal_error(format!(
                    "stat {}: {e}",
                    current.display()
                )));
            }
        }
    }
    Ok(())
}

/// The tree's regular files as (relpath, path) — the SAME selection the
/// PROV-SS-3 digest walks (symlinks/specials skipped; `digest(tree) ==
/// digest(restore)` by construction) with `/`-joined portable relpaths. A
/// file the container cannot represent (a non-UTF-8 component) refuses the
/// export before any byte is written.
fn collect_relpaths(root: &Path) -> Result<Vec<(String, PathBuf)>, AppError> {
    let mut out = Vec::new();
    collect_relpaths_in(root, root, &mut out)?;
    Ok(out)
}

fn collect_relpaths_in(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| AppError::internal_error(format!("list {}: {e}", dir.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::internal_error(format!("list {}: {e}", dir.display())))?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| AppError::internal_error(format!("stat {}: {e}", path.display())))?;
        if ft.is_symlink() || (!ft.is_file() && !ft.is_dir()) {
            continue; // the PROV-SS-3 selection: regular files are the tree
        }
        if ft.is_dir() {
            collect_relpaths_in(root, &path, out)?;
        } else {
            let rel = relpath_str(&path, root)?;
            // The writer's own export rule: what it writes, the reader must
            // accept — a hazard character refuses the export (the path could
            // not re-import on the other platform).
            validate_relpath(&rel)?;
            out.push((rel, path));
        }
    }
    Ok(())
}

fn relpath_str(path: &Path, root: &Path) -> Result<String, AppError> {
    let rel = path
        .strip_prefix(root)
        .map_err(|e| AppError::internal_error(format!("relative path: {e}")))?;
    let mut parts = Vec::new();
    for comp in rel.components() {
        let s = comp.as_os_str().to_str().ok_or_else(|| {
            unsafe_path(format!("a tree file name is not valid UTF-8: {:?}", comp))
        })?;
        parts.push(s);
    }
    Ok(parts.join("/"))
}

fn read_exact<R: Read>(reader: &mut R, buf: &mut [u8], what: &str) -> Result<(), AppError> {
    reader.read_exact(buf).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => {
            invalid_container(format!("truncated while reading {what}"))
        }
        _ => AppError::internal_error(format!("read {what}: {e}")),
    })
}

fn read_u16<R: Read>(reader: &mut R, what: &str) -> Result<u16, AppError> {
    let mut b = [0u8; 2];
    read_exact(reader, &mut b, what)?;
    Ok(u16::from_le_bytes(b))
}

fn read_u32<R: Read>(reader: &mut R, what: &str) -> Result<u32, AppError> {
    let mut b = [0u8; 4];
    read_exact(reader, &mut b, what)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(reader: &mut R, what: &str) -> Result<u64, AppError> {
    let mut b = [0u8; 8];
    read_exact(reader, &mut b, what)?;
    Ok(u64::from_le_bytes(b))
}

fn write_all<W: Write>(w: &mut W, bytes: &[u8], what: &str) -> Result<(), AppError> {
    w.write_all(bytes)
        .map_err(|e| AppError::internal_error(format!("write {what}: {e}")))
}

#[cfg(test)]
mod tests {
    //! TEST-MS-06 / TEST-MS-07 — the `.txr` codec over the exact byte layout
    //! (the codec's own contract): the writer's layout + determinism + restore fidelity,
    //! and every refusal with the staging dir wiped on failure. Fixtures are
    //! synthetic opaque bytes (never real model or patient data).

    use super::*;
    use crate::modules::method_catalogue::types::{CovariateMode, MarkerKind, UsesHistory};
    use crate::modules::model_store::types::{CovariateFacts, MarkerFacts};
    use crate::modules::sandbox::stack::tree_sha256;

    fn scratch(name: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("target")
            .join("txr-model-store-item4")
            .join(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("scratch root");
        root
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        fs::write(path, bytes).expect("fixture file");
    }

    /// A synthetic produced tree (deterministic bytes): model.json + a nested
    /// weights dir. `variant` shifts the bytes so two fixtures differ.
    fn fixture_tree(root: &Path, variant: &str) -> PathBuf {
        let tree = root.join("tree");
        write_file(
            &tree.join("model.json"),
            format!("{{\"v\":\"{variant}\"}}").as_bytes(),
        );
        write_file(
            &tree.join("weights").join("tree-01.bin"),
            format!("opaque-{variant}\x00bytes").as_bytes(),
        );
        tree
    }

    fn facts(method_id: &str) -> ContainerModelFacts {
        ContainerModelFacts {
            name: format!("{method_id} trained model"),
            method_id: method_id.to_string(),
            method_version: "1.2.0".to_string(),
            group: "landmark".to_string(),
            group_label: "Landmark stats".to_string(),
            task: Some(TxrTask::Pfs),
            provenance: ContainerProvenance {
                kind: ModelProvenance::Run,
                imported_from: None,
                catalogue_id: None,
                licence: None,
            },
            trained_on_patients: Some(151),
            trained_at: Some("2026-10-19T14:30:00Z".parse().expect("timestamp")),
            decision_day: 56.0,
            endpoint: TxrEndpoint::Pfs,
            horizon: 238.0,
            contract: "2.0".to_string(),
            env: TxrMethodEnv {
                base_digest: "sha256:base0000".to_string(),
                layer_digest: "sha256:layer000".to_string(),
            },
            features: vec!["M1".to_string(), "M2".to_string()],
            required_markers: None,
            marker_facts: MarkerFacts {
                kind: MarkerKind::Single,
                count: 1,
                min_draws: 3,
                needs_baseline: true,
                uses_history: UsesHistory::Landmark,
                needs_detection_call: false,
                marker_groups_required: vec![],
            },
            covariates: CovariateFacts {
                catalogue: CovariateMode::Optional,
                used: true,
            },
            embeds_training_data: false,
            own_auc: Some(0.66),
            own_c: Some(0.63),
        }
    }

    fn single_export(root: &Path, variant: &str) -> ContainerExport {
        let tree = fixture_tree(&root.join(format!("src-{variant}")), variant);
        let digest = tree_sha256(&tree).expect("fixture digest");
        ContainerExport {
            set: None,
            models: vec![ContainerModelSpec {
                token: "model-1".to_string(),
                facts: facts("landmark-cox"),
                tree_sha256: digest,
                tree_dir: tree,
            }],
            training: vec![],
        }
    }

    fn set_export(root: &Path, training: bool) -> ContainerExport {
        let tree_a = fixture_tree(&root.join("a"), "a");
        let tree_b = fixture_tree(&root.join("b"), "b");
        let digest_a = tree_sha256(&tree_a).expect("digest a");
        let digest_b = tree_sha256(&tree_b).expect("digest b");
        let mut training_specs = Vec::new();
        let mut training_bytes = Vec::new();
        if training {
            let training_file = root.join("train").join("patients.csv");
            write_file(&training_file, b"patient_id,pfs_days\nS0001,238\n");
            training_bytes = b"patient_id,pfs_days\nS0001,238\n".to_vec();
            training_specs.push(ContainerTrainingSpec {
                relpath: "patients.csv".to_string(),
                src: training_file,
            });
        }
        ContainerExport {
            set: Some(ContainerSet {
                name: "CRC cohort, day 56".to_string(),
                created_at: "2026-10-19T14:30:00Z".parse().expect("timestamp"),
                source_label: Some("patients.csv".to_string()),
                keep_training_files: training,
            }),
            models: vec![
                ContainerModelSpec {
                    token: "b-token".to_string(),
                    facts: facts("dynforest"),
                    tree_sha256: digest_b,
                    tree_dir: tree_b,
                },
                ContainerModelSpec {
                    token: "a-token".to_string(),
                    facts: facts("landmark-cox"),
                    tree_sha256: digest_a,
                    tree_dir: tree_a,
                },
            ],
            training: training_specs,
        }
    }

    /// (header offset, header len) per the framing.
    fn header_of(bytes: &[u8]) -> (usize, usize) {
        let magic_len = MAGIC.len();
        let hlen = u32::from_le_bytes(bytes[magic_len..magic_len + 4].try_into().expect("hlen"));
        (magic_len + 4, hlen as usize)
    }

    /// The byte offset of the FIRST model section's first entry's relpath
    /// length field (the mutation tests patch the first entry's relpath in
    /// place — the same byte count).
    fn first_entry_relpath_pos(bytes: &[u8], h_off: usize, h_len: usize) -> usize {
        let mut pos = h_off + h_len;
        let count = u32::from_le_bytes(bytes[pos..pos + 4].try_into().expect("count"));
        assert!(count >= 1, "a model section has entries");
        pos + 4
    }

    /// Patch the first model entry's relpath bytes with a same-length
    /// replacement (`old` and `new` must be equal length).
    fn patch_first_relpath(bytes: &mut [u8], h_off: usize, h_len: usize, new: &str) -> usize {
        let pos = first_entry_relpath_pos(bytes, h_off, h_len);
        let rl = u16::from_le_bytes(bytes[pos..pos + 2].try_into().expect("rl")) as usize;
        let old = String::from_utf8(bytes[pos + 2..pos + 2 + rl].to_vec()).expect("old relpath");
        assert_eq!(old.len(), new.len(), "same-length rebuild of {old:?}");
        bytes[pos + 2..pos + 2 + rl].copy_from_slice(new.as_bytes());
        pos
    }

    /// TEST-MS-06 (acceptance, INV-2): the writer emits the exact layout
    /// (magic, header JSON with `format_version: 1`, entry framing, end
    /// magic), is deterministic (two writes byte-equal), and the reader
    /// restores trees byte-identical to the source with every sha256
    /// verified.
    #[test]
    fn writer_emits_the_exact_layout_deterministically_and_round_trips() {
        let root = scratch("exact-layout");
        let export = set_export(&root, true);

        let mut bytes = Vec::new();
        write_container(&mut bytes, &export).expect("write");
        let bytes2 = {
            let mut b = Vec::new();
            write_container(&mut b, &export).expect("write again");
            b
        };
        assert_eq!(bytes, bytes2, "the container is deterministic");

        assert_eq!(&bytes[..MAGIC.len()], &MAGIC, "leading magic");
        assert_eq!(
            &bytes[bytes.len() - END_MAGIC.len()..],
            &END_MAGIC,
            "end magic"
        );

        // The header: format_version 1, the set block, the training list.
        let (h_off, h_len) = header_of(&bytes);
        let header: ContainerHeader =
            serde_json::from_slice(&bytes[h_off..h_off + h_len]).expect("header JSON");
        assert_eq!(header.format_version, FORMAT_VERSION);
        assert_eq!(header.kind, ContainerKind::Set);
        let set = header.set.as_ref().expect("set block");
        assert_eq!(set.name, "CRC cohort, day 56");
        assert!(set.keep_training_files);
        assert_eq!(
            header.models.iter().map(|m| m.token.as_str()).collect::<Vec<_>>(),
            vec!["a-token", "b-token"],
            "models sorted by token"
        );
        for m in &header.models {
            let expected_tree = root
                .join(if m.token == "a-token" { "a" } else { "b" })
                .join("tree");
            assert_eq!(
                m.tree_sha256,
                tree_sha256(&expected_tree).expect("the recorded digest"),
            );
            assert!(m.size_bytes > 0);
        }
        let training_header = header.training.as_ref().expect("training list");
        assert_eq!(training_header.len(), 1);
        assert_eq!(training_header[0].relpath, "patients.csv");
        assert_eq!(training_header[0].sha256.len(), 64);
        assert_eq!(training_header[0].size_bytes, 30);

        // The per-model sections: entry framing walks back to the source
        // bytes with the right per-entry sha256.
        let mut pos = h_off + h_len;
        for m in &header.models {
            let curl = root.join(if m.token == "a-token" { "a" } else { "b" });
            let expected_tree = curl.join("tree");
            let entry_count =
                u32::from_le_bytes(bytes[pos..pos + 4].try_into().expect("entry count"));
            pos += 4;
            assert!(entry_count >= 1, "a model carries its tree files");
            for _ in 0..entry_count {
                let rl = u16::from_le_bytes(bytes[pos..pos + 2].try_into().expect("rl"));
                pos += 2;
                let relpath =
                    String::from_utf8(bytes[pos..pos + rl as usize].to_vec()).expect("relpath");
                pos += rl as usize;
                let bl = u64::from_le_bytes(bytes[pos..pos + 8].try_into().expect("bl"));
                pos += 8;
                let payload = &bytes[pos..pos + bl as usize];
                pos += bl as usize;
                let declared_sha = &bytes[pos..pos + 32];
                pos += 32;
                assert_eq!(
                    declared_sha,
                    Sha256::digest(payload).as_slice(),
                    "per-entry sha256"
                );
                assert_eq!(
                    payload,
                    fs::read(expected_tree.join(&relpath)).expect("source bytes").as_slice(),
                    "{relpath}"
                );
            }
        }
        let training_count =
            u64::from_le_bytes(bytes[pos..pos + 8].try_into().expect("training count"));
        pos += 8;
        assert_eq!(training_count, 1);
        let rl = u16::from_le_bytes(bytes[pos..pos + 2].try_into().expect("rl"));
        pos += 2 + rl as usize;
        let bl = u64::from_le_bytes(bytes[pos..pos + 8].try_into().expect("bl"));
        pos += 8;
        assert_eq!(
            &bytes[pos..pos + bl as usize],
            b"patient_id,pfs_days\nS0001,238\n"
        );
        pos += bl as usize + 32;
        assert_eq!(pos + END_MAGIC.len(), bytes.len(), "the end magic closes it");

        // Reader round trip: restored trees byte-identical to the source
        // with every sha256 verified (the reader returns only verified
        // bytes; the tree digest is re-derived and compared).
        let staging = root.join("staging");
        let restored =
            read_container(Cursor::new(&bytes), &staging, 1024 * 1024).expect("import restores");
        assert_eq!(restored.header.format_version, FORMAT_VERSION);
        assert_eq!(restored.models.len(), 2);
        for (i, m) in restored.models.iter().enumerate() {
            let expected_tree = root
                .join(if m.token == "a-token" { "a" } else { "b" })
                .join("tree");
            assert_eq!(
                fs::read(m.dir.join("model.json")).expect("restored model.json"),
                fs::read(expected_tree.join("model.json")).expect("source model.json"),
                "{} model.json bytes",
                m.token
            );
            assert_eq!(
                fs::read(m.dir.join("weights").join("tree-01.bin")).expect("restored weights"),
                fs::read(expected_tree.join("weights").join("tree-01.bin"))
                    .expect("source weights"),
                "{} weights bytes",
                m.token
            );
            assert_eq!(
                tree_sha256(&m.dir).expect("restored digest"),
                m.header.tree_sha256,
                "{} re-derived digest",
                m.token
            );
            assert_eq!(m.header.size_bytes, header.models[i].size_bytes);
        }
        assert_eq!(
            fs::read(&restored.training[0].path).expect("restored training"),
            b"patient_id,pfs_days\nS0001,238\n"
        );
        assert_eq!(restored.training[0].sha256, training_header[0].sha256);
        assert_eq!(restored.training[0].size_bytes, 30);
    }

    /// TEST-MS-07 (framing half): bad magic, unknown format version,
    /// truncated frames — each is the typed refusal and the staging dir is
    /// wiped.
    #[test]
    fn reader_refuses_bad_magic_unknown_version_and_truncation() {
        let root = scratch("refusals-framing");
        let export = single_export(&root, "f1");
        let valid = {
            let mut b = Vec::new();
            write_container(&mut b, &export).expect("write");
            b
        };
        let (h_off, h_len) = header_of(&valid);

        // Bad magic (flip a byte).
        let mut bad = valid.clone();
        bad[0] ^= 0xFF;
        let staging = root.join("s-bad-magic");
        let err = read_container(Cursor::new(&bad), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "INVALID_CONTAINER");
        assert!(!staging.exists(), "nothing written (staging wiped)");

        // Unknown format version: patch the header's `1` to `2` in place —
        // same byte count, so the framing survives and the version check is
        // what fails.
        let mut version = valid.clone();
        let header_str =
            std::str::from_utf8(&version[h_off..h_off + h_len]).expect("header is UTF-8");
        let needle = "\"format_version\":1";
        let at = header_str.find(needle).expect("the version field");
        let abs = h_off + at + needle.len() - 1; // the digit
        assert_eq!(&version[abs..abs + 1], b"1");
        assert_eq!(&version[abs + 1..abs + 2], b",");
        version[abs] = b'2';
        let staging = root.join("s-version");
        let err =
            read_container(Cursor::new(&version), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "INVALID_CONTAINER");
        assert!(!staging.exists());

        // Truncated frames: in the magic, in the header, and just before the
        // end magic.
        for (i, cut) in [5usize, (h_off + h_len / 2).max(3), valid.len() - 7]
            .into_iter()
            .enumerate()
        {
            let cut = cut.min(valid.len() - 1);
            let truncated = valid[..cut].to_vec();
            let staging = root.join(format!("s-trunc-{i}"));
            let err =
                read_container(Cursor::new(&truncated), &staging, 1024 * 1024).expect_err("refused");
            assert_eq!(err.error_code(), "INVALID_CONTAINER", "cut at {cut}");
            assert!(!staging.exists(), "cut at {cut}: staging wiped");
        }

        let ok_staging = root.join("s-ok");
        read_container(Cursor::new(&valid), &ok_staging, 1024 * 1024).expect("valid import");
    }

    /// TEST-MS-07 (content half): per-file sha256 mismatch, tree-digest
    /// mismatch, `..` / absolute paths, a symlink escape, a header size that
    /// disagrees with the restored count, and the container size cap (an
    /// overridden small limit) — each is the typed refusal, staging wiped.
    #[test]
    fn reader_refuses_tampered_bytes_unsafe_paths_size_and_cap() {
        let root = scratch("refusals-content");
        let export = single_export(&root, "f2");
        let valid = {
            let mut b = Vec::new();
            write_container(&mut b, &export).expect("write");
            b
        };
        let (h_off, h_len) = header_of(&valid);

        // Per-file sha256 mismatch: flip a payload byte in the first model
        // section (a header byte flip would break the header instead — the
        // payload lies after the header).
        let mut sha = valid.clone();
        let payload_at = h_off + h_len + 4 + 2 + 10 + 8; // entry count, path len, "model.json", bytes len
        let expected_payload = &sha[payload_at..payload_at + 10];
        assert_eq!(expected_payload, b"{\"v\":\"f2\"}", "payload aligned");
        sha[payload_at] ^= 0xFF;
        let staging = root.join("s-sha");
        let err = read_container(Cursor::new(&sha), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "INVALID_CONTAINER");
        assert!(!staging.exists());

        // Tree-digest mismatch: patch a hex digit of the header's
        // `tree_sha256` (same length — the framing survives; the restored
        // tree's re-derived digest then differs).
        let mut digest = valid.clone();
        let header_str =
            std::str::from_utf8(&digest[h_off..h_off + h_len]).expect("header is UTF-8");
        let needle = "\"tree_sha256\":\"";
        let at = header_str.find(needle).expect("the tree field");
        let abs = h_off + at + needle.len();
        let first = digest[abs];
        assert!(first.is_ascii_hexdigit());
        digest[abs] = if first == b'0' { b'1' } else { b'0' };
        let staging = root.join("s-digest");
        let err =
            read_container(Cursor::new(&digest), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "MODEL_VERIFY_FAILED");
        assert!(!staging.exists());

        // `..` path (same-length rebuild of the first entry's relpath).
        let mut dotdot = valid.clone();
        patch_first_relpath(&mut dotdot, h_off, h_len, "a/../..xxx");
        let staging = root.join("s-dotdot");
        let err =
            read_container(Cursor::new(&dotdot), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "UNSAFE_PATH");
        assert!(!staging.exists());

        // Absolute path.
        let mut absolute = valid.clone();
        patch_first_relpath(&mut absolute, h_off, h_len, "/xxxxxxxxx");
        let staging = root.join("s-absolute");
        let err =
            read_container(Cursor::new(&absolute), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "UNSAFE_PATH");
        assert!(!staging.exists());

        // Backslash path (the other platform's separator).
        let mut backslash = valid.clone();
        patch_first_relpath(&mut backslash, h_off, h_len, r"..\..\abcd");
        let staging = root.join("s-backslash");
        let err = read_container(Cursor::new(&backslash), &staging, 1024 * 1024)
            .expect_err("refused");
        assert_eq!(err.error_code(), "UNSAFE_PATH");
        assert!(!staging.exists());

        // Symlink escape (unix): a link planted in the section dir that the
        // entry path would write through (the chain check covers the section
        // dir itself and every ancestor below the staging root).
        #[cfg(unix)]
        {
            let staging = root.join("s-symlink");
            fs::create_dir_all(staging.join("model-0")).expect("staging + section");
            let outside = root.join("outside");
            fs::create_dir_all(&outside).expect("outside");
            std::os::unix::fs::symlink(&outside, staging.join("model-0").join("link"))
                .expect("planted link");
            let mut sym = valid.clone();
            patch_first_relpath(&mut sym, h_off, h_len, "link/exxxx");
            let err =
                read_container(Cursor::new(&sym), &staging, 1024 * 1024).expect_err("refused");
            assert_eq!(err.error_code(), "UNSAFE_PATH");
            assert!(!staging.exists(), "staging wiped, link not followed");
        }

        // Header size_bytes disagrees with the restored count (same-length
        // digit patch).
        let mut sized = valid.clone();
        let header_str =
            std::str::from_utf8(&sized[h_off..h_off + h_len]).expect("header is UTF-8");
        let needle = "\"size_bytes\":";
        let at = header_str.find(needle).expect("the size field");
        let digits_start = h_off + at + needle.len();
        let mut len = 0;
        while sized[digits_start + len].is_ascii_digit() {
            len += 1;
        }
        assert!(len >= 2, "a multi-digit size to patch");
        let original = std::str::from_utf8(&sized[digits_start..digits_start + len])
            .expect("digits")
            .to_string();
        let patched: String = if original.starts_with('9') {
            format!("1{}", "0".repeat(len - 1))
        } else {
            format!("9{}", "0".repeat(len - 1))
        };
        assert_ne!(patched, original);
        sized[digits_start..digits_start + len].copy_from_slice(patched.as_bytes());
        let staging = root.join("s-size");
        let err = read_container(Cursor::new(&sized), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "INVALID_CONTAINER");
        assert!(!staging.exists());

        // Container size cap with an overridden small limit.
        let staging = root.join("s-cap");
        let err =
            read_container(Cursor::new(&valid), &staging, (valid.len() - 1) as u64)
                .expect_err("refused");
        assert_eq!(err.error_code(), "CONTAINER_TOO_LARGE");
        assert!(!staging.exists());

        // Trailing bytes after the end magic.
        let mut trailing = valid.clone();
        trailing.push(0xAB);
        let staging = root.join("s-trailing");
        let err =
            read_container(Cursor::new(&trailing), &staging, 1024 * 1024).expect_err("refused");
        assert_eq!(err.error_code(), "INVALID_CONTAINER");
        assert!(!staging.exists());

        let ok_staging = root.join("s-ok");
        read_container(Cursor::new(&valid), &ok_staging, 1024 * 1024).expect("valid import");
    }

    /// TEST-MS-07 (seam flavor): `read_container_bytes` is the in-process
    /// seam's flavor of the same reader and refuses identically.
    #[test]
    fn bytes_flavor_is_the_same_reader() {
        let root = scratch("bytes-flavor");
        let export = single_export(&root, "f3");
        let valid = {
            let mut b = Vec::new();
            write_container(&mut b, &export).expect("write");
            b
        };
        let staging = root.join("s-bytes");
        let restored = read_container_bytes(&valid, &staging, 1024 * 1024).expect("restores");
        assert_eq!(restored.models.len(), 1);
        assert_eq!(
            restored.models[0].header.facts.features,
            vec!["M1".to_string(), "M2".to_string()]
        );

        let staging2 = root.join("s-bytes-cap");
        let err = read_container_bytes(&valid, &staging2, 10).expect_err("cap refused");
        assert_eq!(err.error_code(), "CONTAINER_TOO_LARGE");
        assert!(!staging2.exists());
    }

    /// The codec's constants and error vocabulary are the documented,
    /// closed set.
    #[test]
    fn container_constants_and_error_codes_are_declared() {
        assert_eq!(
            ContainerErrorCode::ALL
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>(),
            vec!["INVALID_CONTAINER", "CONTAINER_TOO_LARGE", "UNSAFE_PATH"]
        );
        assert_eq!(&MAGIC, b"TXR_MODL\0");
        assert_eq!(&END_MAGIC, b"TXR_MODLEND\0");
        // The end magic is the leading magic minus its NUL plus END + NUL.
        assert_eq!(&END_MAGIC[..MAGIC.len() - 1], &MAGIC[..MAGIC.len() - 1]);
        assert_eq!(&END_MAGIC[MAGIC.len() - 1..], b"END\0");
    }
}
