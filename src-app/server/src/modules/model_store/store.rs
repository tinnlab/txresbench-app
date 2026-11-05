//! Model-store tree layer (the PROV-MS-10 path half) — where
//! saved model trees live, and the copy / prune / immutability rules that
//! make the store's content addressing honest (DEC-2 / DEC-3 / INV-2).
//!
//! ### Layout (DEC-2 — plain dirs, never a blob store)
//!
//! Every byte stays under [`rootfs::data_root()`] (its test seam
//! `CYTO_APP_DATA_DIR` / `scoped_data_root` is how the integration suite
//! isolates), so the sandbox binds PATHs and the engine speaks `host_dir`:
//!
//! - [`models_dir`] — `<data_root>/models` (the J screen's "Open the folder";
//!   PROV-MS-2 exposes it once on the list response);
//! - [`trees_dir`] — `<data_root>/models/trees/<tree_sha256>/`, one
//!   content-addressed, immutable dir per tree (DEC-3: rows are references;
//!   a tree stored twice is reused, never re-copied);
//! - [`training_dir`] — `<data_root>/models/training/<set_id>/`, the L board's
//!   "keep the training files" copies of the run's `input/` files;
//! - [`exports_dir`] — `<data_root>/models/exports/`, the one-off `.txr`
//!   files the save flow's `also_export` arm writes (PROV-MS-3).
//!
//! The dirs are created lazily by the write paths — never at module init (a
//! boot that only lists models must not require a writable data dir, the
//! TEST-MS-01 split); [`ensure_dirs`] is idempotent under repetition and
//! concurrency.
//!
//! ### Copy semantics (INV-2 — the tree is an opaque, immutable artifact)
//!
//! [`copy_tree`] copies a produced tree byte-for-byte into
//! `trees/<digest>/`, through a staging dir + atomic rename (a partial copy
//! never becomes a stored tree), reuses an already-present tree, and does NOT
//! re-hash the source: the digest is the engine's own (PROV-EE-9's
//! `tree_sha256`, recorded at finalize), and verification happens at the
//! boundaries that matter — the import's verify-on-arrival and the resolve's
//! re-verify (CONS-MS-10 binds `sandbox::stack::tree_sha256` /
//! `verify_model_tree`; the algorithm is never re-implemented here).
//!
//! The copy walks the SAME file selection as the PROV-SS-3 digest — regular
//! files only, symlinks and other specials skipped — so
//! `digest(copy) == digest(source)` holds by construction (the digest is the
//! identity; entries the digest does not commit to are not part of the tree).
//! File and directory permission bits are preserved.
//!
//! ### The immutability rule
//!
//! A stored tree is never written after creation: [`copy_tree`] only ever
//! creates NEW tree dirs (staging + atomic rename into an absent path), and
//! [`write_tree_file`] is the closed refusal point for an in-place write
//! (TEST-MS-04 pins it). A changed artifact is a NEW tree under a NEW digest —
//! content addressing makes "update" a different identity, never an overwrite.
//!
//! ### Prune (DEC-3)
//!
//! [`prune_unreferenced_tree`] / [`prune_unreferenced_trees`] remove a tree
//! dir when no `txr_models` row references its digest any more — the
//! repository's `count_refs` is the single authority, never a second count.
//! [`remove_training_dir`] removes a set's training copy. Rows-only deletes
//! (the set delete's `keep_files=true`) simply skip both.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use axum::http::StatusCode;
use serde_json::Value as Json;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::container::{
    read_container, read_container_bytes, write_container, ContainerExport, ContainerModelFacts,
    ContainerModelSpec, ContainerProvenance, ContainerReadResult, ContainerSet,
    ContainerTrainingSpec,
};
use super::repository::{ModelRow, ModelStoreRepository, NewModel, SetListRow, SetRow};
use super::types::{
    CovariateFacts, ExportTarget, MarkerFacts, ModelDetail, ModelProvenance, ModelSaveResponse,
    ModelStoreLimits, ModelSummary, ModelWarning, ModelWarningCode, ResolvedAsset,
    SaveModelsRequest, SaveTarget, SetSummary,
};
use crate::modules::execution_engine::repository::{MethodRow, TxrRepository};
use crate::modules::execution_engine::types::{
    TxrEndpoint, TxrMethodEnv, TxrMethodState, TxrProducedModel, TxrRunSummary, TxrTask,
};
use crate::modules::method_catalogue::catalogue;
use crate::modules::method_catalogue::types::RequiredMarkers;
use crate::modules::{rootfs, sandbox};

/// `<data_root>/models` — the store's root under the app data root (DEC-2;
/// the audit's PASS reading: `rootfs::data_root()`'s override follows the
/// integration suite's `CYTO_APP_DATA_DIR`).
pub fn models_dir() -> PathBuf {
    rootfs::data_root().join("models")
}

/// `<data_root>/models/trees` — the content-addressed tree dirs' parent.
pub fn trees_dir() -> PathBuf {
    models_dir().join("trees")
}

/// `<data_root>/models/training` — the per-set training-copy dirs' parent.
pub fn training_dir() -> PathBuf {
    models_dir().join("training")
}

/// `<data_root>/models/exports` — the one-off `.txr` exports' parent.
pub fn exports_dir() -> PathBuf {
    models_dir().join("exports")
}

/// `<data_root>/models/trees/<digest>` — one immutable tree (DEC-3). Callers
/// MUST pass a digest already accepted by [`require_valid_digest`] — the
/// digest is untrusted input at the import boundary, so it is validated
/// before it ever joins a path.
pub fn tree_dir(digest: &str) -> PathBuf {
    trees_dir().join(digest)
}

/// `<data_root>/models/training/<set_id>` — the set's kept training files.
pub fn training_dir_for(set_id: Uuid) -> PathBuf {
    training_dir().join(set_id.to_string())
}

/// Create the store's directory tree. Idempotent under repetition and safe
/// under concurrency (`create_dir_all` is the primitive; the two store
/// write paths call it before their first byte). Never called at module init.
///
/// This is also the write gate the hygiene sweep hangs on: before the first
/// byte of any operation, the staging orphans of a process that died
/// mid-operation are reclaimed ([`sweep_stale_staging`] — age-gated, so the
/// operation ABOUT to start and any concurrent operation's fresh staging are
/// never touched; the gate runs before the caller creates its own staging).
pub fn ensure_dirs() -> Result<(), AppError> {
    for dir in [models_dir(), trees_dir(), training_dir(), exports_dir()] {
        fs::create_dir_all(&dir).map_err(|e| io_app("create store dir", dir.clone())(e))?;
    }
    let _ = sweep_stale_staging();
    Ok(())
}

/// A staging entry older than this is an orphan from a process that was killed
/// mid-save/import/export (the framework's `TMP_UPLOAD_MAX_AGE` rule —
/// `modules/file/stream.rs`; an orphan is by definition something no live
/// owner knows about). It only has to exceed the longest plausible single
/// operation: the byte cap is 16 GiB, and even a disk-bound import/export
/// moves it in minutes, never a day. A LIVE operation's staging is created
/// fresh and advances its own mtime as bytes/dirs land, so the age gate never
/// guesses about an in-flight entry.
const STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The model-store tree layer's staging entry families (the hygiene pass's
/// one name for all three — each is the complete-or-absent mechanism's
/// in-flight half and survives ONLY when the process was killed between the
/// staging write and the rename):
///
/// - `trees/.staging-<digest>-<uuid>` — [`copy_tree`]'s staged tree dir,
/// - `models/.import-<uuid>` — [`install_imported`] / [`install_imported_from_path`]'s
///   extraction root,
/// - `exports/.staging-<name>-<uuid>` — [`write_export_file`]'s staged
///   container FILE.
///
/// Correctness never depends on the sweep: a surviving orphan is invisible
/// (never read, never listed, never content-addressed). It exists for the
/// disk — a killed 16 GiB import would otherwise sit under `models/` forever.
///
/// Reclaim [`STAGING_MAX_AGE`]-old entries only; best-effort (a refused
/// removal is logged, never the failure of the write that triggered the
/// sweep). Returns the number of reclaimed entries.
pub fn sweep_stale_staging() -> u64 {
    let now = SystemTime::now();
    let mut reclaimed = 0u64;
    for (dir, prefix) in [
        (trees_dir(), ".staging-"),
        (models_dir(), ".import-"),
        (exports_dir(), ".staging-"),
    ] {
        reclaimed += sweep_staging_prefix(&dir, prefix, now);
    }
    if reclaimed > 0 {
        tracing::info!(reclaimed, "model store staging sweep reclaimed orphaned entries");
    }
    reclaimed
}

/// One staging family's sweep: entries of `dir` whose name starts with
/// `prefix` AND whose modified time is older than [`STAGING_MAX_AGE`] are
/// removed (dirs or files, whichever the family stages). A missing `dir` is
/// nothing to reclaim, never an error (the sweep never CREATES dirs — the
/// store dirs stay the lazy write paths' concern).
fn sweep_staging_prefix(dir: &Path, prefix: &str, now: SystemTime) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut reclaimed = 0u64;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with(prefix) {
            continue;
        }
        let path = entry.path();
        // `unwrap_or(false)`: an entry whose mtime cannot be read is left
        // alone — refusing to remove an entry we cannot date is the
        // conservative side of a best-effort sweep.
        let is_stale = fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).map(|d| d > STAGING_MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if !is_stale {
            continue;
        }
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let removed = if is_dir {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        match removed {
            Ok(()) => reclaimed += 1,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e,
                    "model store staging sweep could not reclaim an orphaned entry");
            }
        }
    }
    reclaimed
}

/// The tree-key shape guard: a 64-char lowercase hex sha256 — the exact
/// predicate `sandbox::stack` applies to its own digests (ONE definition for
/// the digest vocabulary, CONS-MS-10's rule; `rootfs::cache` uses the same
/// shape for its cache keys). A mismatched digest is refused before it can
/// join a filesystem path (the serve-endpoint path-traversal precedent).
fn require_valid_digest(digest: &str) -> Result<(), AppError> {
    if sandbox::stack::is_sha256_hex(digest) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "INVALID_TREE_DIGEST",
            format!(
                "a model tree digest is a 64-char lowercase hex sha256; got {digest:?}"
            ),
        ))
    }
}

/// Copy a produced model tree byte-for-byte into the store as the
/// content-addressed tree `digest`; returns the stored dir.
///
/// - **Reuse, never a second copy** (DEC-3): a tree dir already present is
///   returned as-is — the row is the reference, the bytes are the identity.
/// - **No re-hash** (the plan's explicit rule): the digest came from the
///   engine's finalize walk; re-hashing here would re-implement PROV-SS-3 and
///   change nothing about the identity.
/// - **Never partial**: the bytes are staged under `trees/.staging-…` and
///   renamed into place; a failure removes the staging dir and lands nothing,
///   and the atomic rename is what makes a stored tree complete-or-absent.
/// - **Immutable afterwards**: this is the ONLY creation path; nothing else
///   in the module ever writes under `trees/` again (see [`write_tree_file`]).
pub fn copy_tree(src: &Path, digest: &str) -> Result<PathBuf, AppError> {
    require_valid_digest(digest)?;
    let target = tree_dir(digest);
    if target.exists() {
        if !target.is_dir() {
            return Err(AppError::internal_error(format!(
                "the stored tree path {} exists and is not a directory — the store was \
                 modified outside the module",
                target.display()
            )));
        }
        return Ok(target);
    }
    if !src.is_dir() {
        return Err(AppError::internal_error(format!(
            "the produced model tree {} does not exist (a run dir deleted from under the \
             engine seam?)",
            src.display()
        )));
    }
    ensure_dirs()?;
    let staging = trees_dir().join(format!(".staging-{digest}-{}", Uuid::new_v4()));
    let copied = (|| -> Result<(), AppError> {
        fs::create_dir(&staging).map_err(|e| io_app("create staging dir", staging.clone())(e))?;
        copy_tree_contents(src, &staging)
    })();
    if let Err(e) = copied {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    match fs::rename(&staging, &target) {
        Ok(()) => Ok(target),
        Err(e) => {
            // A concurrent copy of the same digest won the rename. The dir is
            // content-addressed, so the winner's bytes are this digest's
            // bytes — reuse (single-user app, but the import seam can race a
            // save; the engine's single-writer convention is the same).
            let _ = fs::remove_dir_all(&staging);
            if target.is_dir() {
                return Ok(target);
            }
            Err(io_app("rename tree into place", target.clone())(e))
        }
    }
}

/// The byte size of a tree — the sum over the same regular-file selection
/// PROV-SS-3's digest walks (the store's DEC-7 fallback: the engine records
/// `size_bytes` from its own walk, and this recomputes it when a record lacks
/// it, so the L checklist's sizes are never a second, different number).
pub fn tree_size(dir: &Path) -> Result<u64, AppError> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_regular_files(dir, dir, &mut files)?;
    let mut total = 0u64;
    for (_, path) in files {
        let meta = fs::metadata(&path).map_err(|e| io_app("stat", path.clone())(e))?;
        total += meta.len();
    }
    Ok(total)
}

/// Copy the run's `input/` files into `<data_root>/models/training/<set_id>/`
/// — the L board's "keep the training files" checkbox's bytes. The engine's
/// documented `input/` layout (TEST-EE-18) is flat, so this copies the
/// top-level regular files with their ORIGINAL names (a second save into the
/// same set re-copies over the same names); anything else under `input/`
/// (subdirs, symlinks) is outside that documented layout and is skipped.
/// On failure of a first copy the partial dir is removed (a failed save
/// lands nothing); a failed re-copy into an existing dir leaves the previous
/// copy's state.
pub fn copy_training_files(run_input_dir: &Path, set_id: Uuid) -> Result<PathBuf, AppError> {
    if !run_input_dir.is_dir() {
        return Err(AppError::internal_error(format!(
            "the run's input dir {} does not exist (a run dir deleted from under the engine \
             seam?)",
            run_input_dir.display()
        )));
    }
    let target = training_dir_for(set_id);
    let target_existed = target.exists();
    if target_existed && !target.is_dir() {
        return Err(AppError::internal_error(format!(
            "the training path {} exists and is not a directory",
            target.display()
        )));
    }
    ensure_dirs()?;
    let copied = (|| -> Result<(), AppError> {
        fs::create_dir_all(&target).map_err(|e| io_app("create training dir", target.clone())(e))?;
        let mut entries: Vec<_> = fs::read_dir(run_input_dir)
            .map_err(|e| io_app("list input dir", run_input_dir.to_path_buf())(e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| io_app("list input dir", run_input_dir.to_path_buf())(e))?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let ft = entry
                .file_type()
                .map_err(|e| io_app("stat", path.clone())(e))?;
            if !ft.is_file() {
                continue; // the flat documented layout
            }
            let to = target.join(entry.file_name());
            fs::copy(&path, &to).map_err(|e| io_app("copy training file", to.clone())(e))?;
            let perms = fs::metadata(&path)
                .map_err(|e| io_app("stat", path.clone())(e))?
                .permissions();
            fs::set_permissions(&to, perms).map_err(|e| io_app("set mode", to.clone())(e))?;
        }
        Ok(())
    })();
    if let Err(e) = copied {
        if !target_existed {
            let _ = fs::remove_dir_all(&target);
        }
        return Err(e);
    }
    Ok(target)
}

/// Remove a set's training copy; returns whether a dir was removed.
pub fn remove_training_dir(set_id: Uuid) -> Result<bool, AppError> {
    let dir = training_dir_for(set_id);
    if !dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&dir).map_err(|e| io_app("remove training dir", dir.clone())(e))?;
    Ok(true)
}

/// DEC-3's prune rule, one digest: the tree dir exists only while a
/// `txr_models` row references its digest. `count_refs` (the repository's
/// single authority) is zero → the dir is removed; `true` when a dir was
/// removed. A digest still referenced (saved into a second set, imported
/// twice) is left untouched.
pub async fn prune_unreferenced_tree(pool: &SqlitePool, digest: &str) -> Result<bool, AppError> {
    require_valid_digest(digest)?;
    let repo = ModelStoreRepository::new(pool.clone());
    if repo.count_refs(digest).await? > 0 {
        return Ok(false);
    }
    remove_tree_dir(digest)
}

/// The set/run-delete variant: prune each digest's dir whose last reference
/// just went away; returns how many dirs were removed.
pub async fn prune_unreferenced_trees(
    pool: &SqlitePool,
    digests: &[String],
) -> Result<u32, AppError> {
    let mut removed = 0u32;
    for digest in digests {
        if prune_unreferenced_tree(pool, digest).await? {
            removed += 1;
        }
    }
    Ok(removed)
}

/// INV-2's immutability rule at the API — the refusal point for an in-place
/// write into a stored tree. The tree-write surface is closed by design:
/// [`copy_tree`] is the ONLY function that creates tree bytes (new dirs, via
/// staging + rename), and this function is the other half of the closed set —
/// it refuses, so a mutation of a stored artifact cannot be expressed through
/// this module at all (`relpath` / `bytes` are the proposed write the caller
/// attempted; neither is validated, the write cannot happen). A changed model
/// is a differently-addressed tree, never an update (DEC-3; TEST-MS-04 pins
/// the refusal + the tree's unchanged digest afterwards).
pub fn write_tree_file(digest: &str, relpath: &str, bytes: &[u8]) -> Result<(), AppError> {
    let _ = (relpath, bytes);
    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        "TREE_IMMUTABLE",
        format!(
            "stored model trees are immutable (INV-2); a write into trees/{digest}/ is refused"
        ),
    ))
}

#[derive(Debug, Clone)]
pub enum Provenance {
    /// A user's own `.txr` file; `source_name` is the file name (board J's
    /// "opened from breast-panel.txr").
    Imported { source_name: String },
    /// The pretrained-catalogue install seam: id + version + licence
    /// (licence mandatory — INV-8's refusal, DEC-16).
    Pretrained {
        catalogue_id: String,
        version: String,
        licence: String,
    },
}

/// The seam's import options.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    /// The target set (an existing set to import into, the merge path). None →
    /// the container's recorded set is recreated fresh (kind `set`) or the
    /// model lands standalone (kind `model`).
    pub set_id: Option<Uuid>,
    pub provenance: Provenance,
}

/// The seam's outcome (PROV-MS-10): the restored row ids + the wire summaries.
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub model_ids: Vec<String>,
    pub models: Vec<ModelSummary>,
    /// The set the models landed in: a fresh set for a kind-`set` container
    /// without a target, the merge target when one was given; null for a
    /// kind-`model` import without one (the model stands alone).
    pub set_id: Option<Uuid>,
}

/// The import's staging root — under `<data_root>/models/` (never the store's
/// content-addressed tree dirs): `<models>/.import-<uuid>`. The reader wipes
/// it on ANY failure; the install moves the verified trees out and removes
/// the rest.
fn import_staging_dir() -> PathBuf {
    models_dir().join(format!(".import-{}", Uuid::new_v4()))
}

/// Read a `.txr` container from a file and install every verified model into
/// the store (PROV-MS-6/10's path seam — a large cached asset or a staged
/// multipart streams from disk under the container byte cap instead of being
/// buffered whole; GAP-PC-2). Same code path, same verification as
/// [`install_imported`].
pub async fn install_imported_from_path(
    pool: &SqlitePool,
    path: &Path,
    opts: &ImportOptions,
) -> Result<ImportOutcome, AppError> {
    // The module's write gate (dirs + the staging sweep) before the import's
    // own staging root is created — an import was the one write path that
    // created dirs directly; it now goes through the same gate.
    ensure_dirs()?;
    let staging = import_staging_dir();
    let staging_c = staging.clone();
    let path_c = path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || -> Result<ContainerReadResult, AppError> {
        let file = std::fs::File::open(&path_c).map_err(|e| {
            AppError::internal_error(format!(
                "open the staged .txr container {}: {e}",
                path_c.display()
            ))
        })?;
        read_container(file, &staging_c, ModelStoreLimits::MAX_CONTAINER_BYTES)
    })
    .await
    .map_err(|e| AppError::internal_error(format!("container read task join: {e}")))?;
    let result = result?;
    install_verified(pool, &result, &staging, opts).await
}

/// Read a `.txr` container from bytes and install every verified model
/// (PROV-MS-10's bytes seam — the pretrained-catalogue import path, small
/// already-verified assets).
pub async fn install_imported(
    pool: &SqlitePool,
    bytes: &[u8],
    opts: &ImportOptions,
) -> Result<ImportOutcome, AppError> {
    ensure_dirs()?;
    let staging = import_staging_dir();
    let staging_c = staging.clone();
    let bytes = bytes.to_vec();
    let result = tokio::task::spawn_blocking(move || {
        read_container_bytes(&bytes, &staging_c, ModelStoreLimits::MAX_CONTAINER_BYTES)
    })
    .await
    .map_err(|e| AppError::internal_error(format!("container read task join: {e}")))?;
    let result = result?;
    install_verified(pool, &result, &staging, opts).await
}

/// The install half after the reader's verification — every tree is already
/// hash- and digest-verified; this moves bytes into the content-addressed
/// store and stamps the rows. On ANY local failure the staging root is
/// removed (a failed import lands nothing new beyond what the store layer's
/// reuse rule already kept).
async fn install_verified(
    pool: &SqlitePool,
    result: &ContainerReadResult,
    staging: &Path,
    opts: &ImportOptions,
) -> Result<ImportOutcome, AppError> {
    // INV-8's licence rule is the INSTALL path's own gate (DEC-16): a
    // pretrained install without a recorded data licence refuses before any
    // byte is moved (422 LICENCE_REQUIRED — the pretrained seam's named
    // refusal; a user's own file needs no licence).
    if let Provenance::Pretrained { licence, .. } = &opts.provenance {
        if licence.trim().is_empty() {
            return Err(AppError::unprocessable_entity(
                "LICENCE_REQUIRED",
                "a pretrained model install requires its data licence to be recorded",
            ));
        }
    }
    let repo = ModelStoreRepository::new(pool.clone());

    // The target set: the caller's merge target, else the container's
    // recorded set recreated fresh, else none (kind `model` without a
    // target — the model stands alone).
    let target_id = match opts.set_id {
        Some(id) => {
            if repo.get_set(id).await?.is_none() {
                return Err(AppError::new(
                    StatusCode::NOT_FOUND,
                    "SET_NOT_FOUND",
                    format!("no set {id}"),
                ));
            }
            Some(id)
        }
        None => match result.header.set.as_ref() {
            Some(recorded) => {
                let keep = recorded.keep_training_files;
                let row = repo
                    .insert_set(
                        &recorded.name,
                        None,
                        recorded.source_label.as_deref(),
                        keep,
                        None,
                    )
                    .await?;
                Some(row.id)
            }
            None => None,
        },
    };

    let set_name = match target_id {
        Some(id) => repo.get_set(id).await?.map(|s| s.name),
        None => None,
    };

    let mut outcome = ImportOutcome {
        model_ids: Vec::with_capacity(result.models.len()),
        models: Vec::with_capacity(result.models.len()),
        set_id: target_id,
    };

    for restored in &result.models {
        let facts = &restored.header.facts;
        // DEC-3's row-is-a-reference rule: the same tree+method already saved
        // into the target set is the SAME model — the existing row is the
        // outcome's answer, never a second row (a UNIQUE violation could
        // never surface as a clean refusal anyway). Set-scoped: a NULL set_id
        // is not unique per SQLite, so standalone imports are never deduped.
        if let Some(target) = target_id {
            if repo
                .model_ref_exists(Some(target), &restored.header.tree_sha256, &facts.method_id)
                .await?
            {
                let existing = repo
                    .get_model_by_ref(Some(target), &restored.header.tree_sha256, &facts.method_id)
                    .await?
                    .ok_or_else(|| {
                        AppError::internal_error(
                            "the idempotence check found a row that vanished",
                        )
                    })?;
                outcome.model_ids.push(existing.id.to_string());
                outcome.models.push(summary_from(&existing, set_name.as_deref())?);
                continue;
            }
        }
        let stored = copy_tree(&restored.dir, &restored.header.tree_sha256)?;
        let new = NewModel {
            set_id: target_id,
            name: facts.name.clone(),
            method_id: facts.method_id.clone(),
            method_version: facts.method_version.clone(),
            group: facts.group.clone(),
            group_label: facts.group_label.clone(),
            task: facts.task.map(|t| t.as_str().to_string()),
            provenance: match &opts.provenance {
                Provenance::Imported { .. } => crate::modules::model_store::types::ModelProvenance::Imported.as_str().to_string(),
                Provenance::Pretrained { .. } => crate::modules::model_store::types::ModelProvenance::Pretrained.as_str().to_string(),
            },
            imported_from: match &opts.provenance {
                Provenance::Imported { source_name } => Some(source_name.clone()),
                _ => None,
            },
            pretrained_catalogue_id: match &opts.provenance {
                Provenance::Pretrained { catalogue_id, .. } => Some(catalogue_id.clone()),
                _ => None,
            },
            pretrained_catalogue_version: match &opts.provenance {
                Provenance::Pretrained { version, .. } => Some(version.clone()),
                _ => None,
            },
            licence: match &opts.provenance {
                Provenance::Pretrained { licence, .. } => Some(licence.clone()),
                _ => None,
            },
            tree_sha256: restored.header.tree_sha256.clone(),
            dir: stored.display().to_string(),
            size_bytes: restored.header.size_bytes as i64,
            contract: facts.contract.clone(),
            env_base_digest: Some(facts.env.base_digest.clone()),
            env_layer_digest: Some(facts.env.layer_digest.clone()),
            trained_on_patients: facts.trained_on_patients.map(|v| v as i64),
            trained_at: facts.trained_at,
            decision_day: facts.decision_day,
            endpoint: endpoint_wire(facts.endpoint)?,
            horizon: facts.horizon,
            features: json_value(&facts.features, "features")?,
            required_markers: match &facts.required_markers {
                Some(rm) => Some(json_value(rm, "required_markers")?),
                None => None,
            },
            marker_facts: json_value(&facts.marker_facts, "marker_facts")?,
            covariates: json_value(&facts.covariates, "covariates")?,
            embeds_training_data: facts.embeds_training_data,
            own_auc: facts.own_auc,
            own_c: facts.own_c,
        };
        let row = repo.insert_model(&new).await?;
        outcome.model_ids.push(row.id.to_string());
        outcome.models.push(summary_from(&row, set_name.as_deref())?);
    }

    // The restored training files — the set keeps them (the container said
    // so); the set's training facts are set to match.
    if !result.training.is_empty() {
        let set_id = target_id.expect("training files only ride a set container with a target");
        let dir = training_dir_for(set_id);
        let copied = (|| -> Result<(), AppError> {
            fs::create_dir_all(&dir)
                .map_err(|e| io_app("create training dir", dir.clone())(e))?;
            for tf in &result.training {
                let to = dir.join(&tf.relpath);
                fs::copy(&tf.path, &to)
                    .map_err(|e| io_app("copy restored training file", to.clone())(e))?;
            }
            Ok(())
        })();
        if let Err(err) = copied {
            let _ = fs::remove_dir_all(staging);
            return Err(err);
        }
        let training_dir_str = dir.display().to_string();
        repo.set_training_facts(set_id, true, Some(&training_dir_str)).await?;
    }

    let _ = fs::remove_dir_all(staging);
    Ok(outcome)
}

/// The pretrained rows (PROV-MS-10 / GAP-PC-3): the in-process query the
/// strict id+version install match binds (`installed_model_id`), with an
/// optional catalogue id filter.
pub async fn list_pretrained(
    pool: &SqlitePool,
    catalogue_id: Option<&str>,
) -> Result<Vec<ModelSummary>, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    let rows = repo.list_models(None, None, Some("pretrained")).await?;
    let set_names = set_name_map(&repo).await?;
    let mut out = Vec::new();
    for row in rows {
        if catalogue_id
            .is_some_and(|id| row.pretrained_catalogue_id.as_deref() != Some(id))
        {
            continue;
        }
        let set_name = row
            .set_id
            .as_ref()
            .and_then(|sid| set_names.get(sid))
            .map(|s| s.as_str());
        out.push(summary_from(&row, set_name)?);
    }
    Ok(out)
}

/// The one set-name map for a caller-side join (DEC-10's seam rule: the
/// repository returns table rows; the response-level join happens here).
pub async fn set_name_map(repo: &ModelStoreRepository) -> Result<std::collections::HashMap<Uuid, String>, AppError> {
    let mut out = std::collections::HashMap::new();
    for s in repo.list_sets().await? {
        out.insert(s.id, s.name);
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → wire projections (the store's data shapes — ITEM-5 renders these from
// the persisted facts; the JSON cells are the recorded facts verbatim, never
// re-derived)
// ─────────────────────────────────────────────────────────────────────────────

/// A recorded task string as the engine's typed vocabulary.
pub fn parse_task(task: &Option<String>) -> Result<Option<TxrTask>, AppError> {
    match task {
        Some(s) => serde_json::from_value::<TxrTask>(Json::String(s.clone()))
            .map(Some)
            .map_err(|e| AppError::internal_error(format!("txr_models.task: {e}"))),
        None => Ok(None),
    }
}

/// A recorded endpoint string as the engine's typed vocabulary.
pub fn parse_endpoint(endpoint: &str) -> Result<TxrEndpoint, AppError> {
    serde_json::from_value::<TxrEndpoint>(Json::String(endpoint.to_string()))
        .map_err(|e| AppError::internal_error(format!("txr_models.endpoint: {e}")))
}

/// The endpoint's stored/wire spelling (the engine's serde `snake_case` — the
/// row cell is the same string a consumer switches on).
fn endpoint_wire(endpoint: TxrEndpoint) -> Result<String, AppError> {
    serde_json::to_value(endpoint)
        .map(|v| v.as_str().expect("an endpoint serializes to a string").to_string())
        .map_err(|e| AppError::internal_error(format!("serialize endpoint: {e}")))
}

/// A recorded fact serialized back into its row JSON cell (the facts were
/// typed at save/import; serialization failure is a local defect, never a
/// client input).
fn json_value<T: serde::Serialize>(v: &T, what: &str) -> Result<Json, AppError> {
    serde_json::to_value(v)
        .map_err(|e| AppError::internal_error(format!("serialize {what}: {e}")))
}

/// A recorded provenance string as the module's typed vocabulary.
pub fn parse_provenance(provenance: &str) -> Result<ModelProvenance, AppError> {
    serde_json::from_value::<ModelProvenance>(Json::String(provenance.to_string()))
        .map_err(|e| AppError::internal_error(format!("txr_models.provenance: {e}")))
}

/// The recorded facts a model carries; `row` is the DB row's verbatim JSON.
fn parse_row<T: serde::de::DeserializeOwned>(v: &Json, what: &str) -> Result<T, AppError> {
    serde_json::from_value(v.clone())
        .map_err(|e| AppError::internal_error(format!("{what}: {e}")))
}

/// The J/I list row (PROV-MS-2) — the marker-count + covariates subline facts
/// mirror the recorded JSON (TEST-MS-24: no per-row detail fetch).
pub fn summary_from(row: &ModelRow, set_name: Option<&str>) -> Result<ModelSummary, AppError> {
    let marker_facts: MarkerFacts = parse_row(&row.marker_facts, "txr_models.marker_facts")?;
    let covariates: CovariateFacts = parse_row(&row.covariates, "txr_models.covariates")?;
    Ok(ModelSummary {
        id: row.id,
        set_id: row.set_id,
        set_name: set_name.map(|s| s.to_string()),
        name: row.name.clone(),
        method_id: row.method_id.clone(),
        method_version: row.method_version.clone(),
        group: row.group.clone(),
        group_label: row.group_label.clone(),
        task: parse_task(&row.task)?,
        provenance: parse_provenance(&row.provenance)?,
        imported_from: row.imported_from.clone(),
        pretrained_catalogue_id: row.pretrained_catalogue_id.clone(),
        pretrained_catalogue_version: row.pretrained_catalogue_version.clone(),
        licence: row.licence.clone(),
        trained_on_patients: row.trained_on_patients.map(|v| v as u32),
        trained_at: row.trained_at,
        decision_day: row.decision_day,
        endpoint: parse_endpoint(&row.endpoint)?,
        horizon: row.horizon,
        size_bytes: row.size_bytes as u64,
        embeds_training_data: row.embeds_training_data,
        own_auc: row.own_auc,
        marker_count: Some(marker_facts.count),
        uses_covariates: covariates.used,
        created_at: row.created_at,
    })
}

/// DEC-6's honesty predicate: the row records NO marker set — no required
/// rule, no feature list — so the model's input schema cannot be transcribed.
/// An imported/foreign row in that state is never presented as runnable on
/// absent facts: ITEM-6's eligibility guard answers `cannot_run` +
/// `MODEL_REQUIREMENTS_UNRECORDED` and the detail's warning names the same
/// state (one definition; a marker-facts-only row is included — the count
/// without the marker set is not a requirement that can be checked).
pub fn requirements_unrecorded(row: &ModelRow) -> bool {
    if row.required_markers.is_some() {
        return false;
    }
    let features: Vec<String> = parse_row(&row.features, "txr_models.features").unwrap_or_default();
    features.is_empty()
}

/// The detail (PROV-MS-2) — the summary flatten plus the recorded digests,
/// requirements and the catalogue-consistency warnings.
pub fn detail_from(row: &ModelRow, set_name: Option<&str>) -> Result<ModelDetail, AppError> {
    let summary = summary_from(row, set_name)?;
    let required_markers: Option<RequiredMarkers> = match &row.required_markers {
        Some(v) => Some(parse_row(v, "txr_models.required_markers")?),
        None => None,
    };
    let marker_facts: MarkerFacts = parse_row(&row.marker_facts, "txr_models.marker_facts")?;
    let covariates: CovariateFacts = parse_row(&row.covariates, "txr_models.covariates")?;
    let features: Vec<String> = parse_row(&row.features, "txr_models.features")?;
    let mut warnings = Vec::new();
    if let Some(cat) = catalogue::method(&row.method_id) {
        if cat.version != row.method_version {
            warnings.push(ModelWarning {
                code: ModelWarningCode::ModelVersionMismatch,
                detail: format!(
                    "recorded method version {}; the catalogue ships {}",
                    row.method_version, cat.version
                ),
            });
        }
        if let Some(entry) = crate::modules::execution_engine::envmanifest::env_for(&row.method_id) {
            let current_base = entry
                .base_digest
                .strip_prefix("sha256:")
                .unwrap_or(&entry.base_digest);
            let layer_mismatch = row
                .env_layer_digest
                .as_deref()
                .is_some_and(|d| d != entry.layer_sha256);
            let base_mismatch = row
                .env_base_digest
                .as_deref()
                .is_some_and(|d| d != current_base);
            if layer_mismatch || base_mismatch {
                warnings.push(ModelWarning {
                    code: ModelWarningCode::DigestMismatch,
                    detail: "recorded environment digests differ from the current environment image".to_string(),
                });
            }
        }
    }
    if requirements_unrecorded(row) {
        warnings.push(ModelWarning {
            code: ModelWarningCode::RequirementsUnrecorded,
            detail: "this model carries no recorded requirements (markers, features, draws)".to_string(),
        });
    }
    let (base_digest, layer_digest) = match (&row.env_base_digest, &row.env_layer_digest) {
        (Some(b), Some(l)) => (b.clone(), l.clone()),
        _ => {
            return Err(AppError::internal_error(format!(
                "model {} records no environment digest — a corrupt row",
                row.id
            )))
        }
    };
    Ok(ModelDetail {
        summary,
        own_c: row.own_c,
        tree_sha256: row.tree_sha256.clone(),
        dir: row.dir.clone(),
        contract: row.contract.clone(),
        env: TxrMethodEnv {
            base_digest,
            layer_digest,
        },
        features,
        required_markers,
        marker_facts,
        covariates,
        warnings,
    })
}

/// The set summary (PROV-MS-4) — the aggregates row's one projection.
pub fn set_summary_from(row: &SetListRow) -> SetSummary {
    SetSummary {
        id: row.id,
        name: row.name.clone(),
        created_at: row.created_at,
        source_run_id: row.source_run_id,
        source_label: row.source_label.clone(),
        keep_training_files: row.keep_training_files,
        training_dir: row.training_dir.clone(),
        model_count: row.model_count as u32,
        total_size_bytes: row.total_size_bytes as u64,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reuse resolution (PROV-MS-8 — the `execution-engine` reuse contract)
// ─────────────────────────────────────────────────────────────────────────────

/// PROV-MS-8's core (no HTTP) — id → the VERIFIED asset record the engine
/// binds on reuse. Each asset's `host_dir` is re-verified against the row's
/// recorded `tree_sha256` (PROV-SS-3 — the same verification the engine ran
/// at fit time, DEC-5) BEFORE the asset leaves: the engine only ever sees an
/// honest asset. The verification is binary at this boundary — a mismatch, an
/// unreadable dir or a vanished tree each answer `409 MODEL_VERIFY_FAILED`
/// (the row's bytes are not the recorded artifact today; the caller's
/// alternative is a re-import, never a run on unverified bytes). The
/// `ResolvedAsset` shape is byte-compatible with
/// `execution_engine::types::TxrModelAsset` (the engine never imports this
/// module — the caller-side join, DEC-EE-10).
pub async fn resolve_assets(
    pool: &SqlitePool,
    ids: &[String],
) -> Result<Vec<ResolvedAsset>, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    let mut assets = Vec::with_capacity(ids.len());
    for id in ids {
        let uuid = Uuid::parse_str(id).map_err(|_| {
            AppError::new(
                StatusCode::NOT_FOUND,
                "MODEL_NOT_FOUND",
                format!("no model {id}"),
            )
        })?;
        let row = repo.get_model(uuid).await?.ok_or_else(|| {
            AppError::new(
                StatusCode::NOT_FOUND,
                "MODEL_NOT_FOUND",
                format!("no model {id}"),
            )
        })?;
        sandbox::stack::verify_model_tree(Path::new(&row.dir), &row.tree_sha256).map_err(|err| {
            AppError::new(
                StatusCode::CONFLICT,
                "MODEL_VERIFY_FAILED",
                format!("model {id}: {}", err),
            )
        })?;
        let (base_digest, layer_digest) = match (&row.env_base_digest, &row.env_layer_digest) {
            (Some(b), Some(l)) => (b.clone(), l.clone()),
            _ => {
                return Err(AppError::internal_error(format!(
                    "model {} records no environment digest — a corrupt row",
                    row.id
                )))
            }
        };
        assets.push(ResolvedAsset {
            model_id: id.clone(),
            host_dir: row.dir,
            tree_sha256: row.tree_sha256,
            method_id: row.method_id,
            method_version: row.method_version,
            env: TxrMethodEnv {
                base_digest,
                layer_digest,
            },
            contract: row.contract,
        });
    }
    Ok(assets)
}

// ─────────────────────────────────────────────────────────────────────────────
// The save flow (PROV-MS-3 — the route's core)
// ─────────────────────────────────────────────────────────────────────────────

/// Save the run's produced models into a set (new or existing), copying each
/// tree byte-for-byte into the content-addressed store, recording the
/// requirements (DEC-6: run facts + `params.json` + the catalogue facts,
/// never re-derived), copying the training files when asked and writing the
/// one-off `.txr` export when asked.
///
/// Error order (the plan's named set): validation 400s; `RUN_NOT_FOUND`;
/// `MODEL_ASSET_UNKNOWN` (a method id the run has no method row for);
/// `METHOD_NOT_FINISHED` (the method row is not terminal-finished with its
/// produced dir yet); `SET_NOT_FOUND` / `SET_NAME_TAKEN`; and the defensive
/// `METHOD_NOT_IN_CATALOGUE` (a method the shipped catalogue no longer knows
/// cannot have its requirements recorded — DEC-6's never-invent rule).
pub async fn save_from_run(
    pool: &SqlitePool,
    req: &SaveModelsRequest,
) -> Result<ModelSaveResponse, AppError> {
    req.validate().map_err(|e| {
        AppError::bad_request(e.code.code(), e.to_string())
    })?;

    let engine = TxrRepository::new(pool.clone());
    let run = engine
        .get_run(req.run_id)
        .await?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "RUN_NOT_FOUND", format!("no run {}", req.run_id)))?;
    let summary = run.summarize(Vec::new())?;
    let produced =
        crate::modules::execution_engine::repository::produced_models(pool, req.run_id).await?;
    let produced_by: BTreeMap<&str, &TxrProducedModel> =
        produced.iter().map(|m| (m.method_id.as_str(), m)).collect();

    // Check EVERY requested method BEFORE any mutation: a save either lands
    // the full requested set or nothing user-visible.
    let mut chosen = Vec::with_capacity(req.method_ids.len());
    for mid in &req.method_ids {
        match produced_by.get(mid.as_str()) {
            Some(_) => {}
            None => {
                let row = engine.get_method(req.run_id, mid).await?;
                if row.is_none() {
                    return Err(AppError::new(
                        StatusCode::NOT_FOUND,
                        "MODEL_ASSET_UNKNOWN",
                        format!("the run has no model produced by method {mid}"),
                    ));
                }
                return Err(AppError::new(
                    StatusCode::CONFLICT,
                    "METHOD_NOT_FINISHED",
                    format!("method {mid} has not finished with a produced model yet"),
                ));
            }
        }
        let state = engine
            .get_method(req.run_id, mid)
            .await?
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::NOT_FOUND,
                    "MODEL_ASSET_UNKNOWN",
                    format!("the run has no method row for {mid}"),
                )
            })?
            .state()?;
        if state != TxrMethodState::Finished {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "METHOD_NOT_FINISHED",
                format!("method {mid} is not finished; its produced model cannot be saved yet"),
            ));
        }
        chosen.push(mid.clone());
    }

    // The source label is engine truth (GAP-D): the request may carry the
    // dialog's free text, but the default is the run's recorded source name —
    // never the run dir stem.
    let source_label = req
        .source_label
        .clone()
        .or_else(|| summary.input_summary.file_names.patients.clone());

    let repo = ModelStoreRepository::new(pool.clone());
    let (set_row, _) = match &req.target {
        SaveTarget::NewSet { set_name } => {
            let row = repo
                .insert_set(set_name, Some(summary.id), source_label.as_deref(), req.keep_training_files, None)
                .await?;
            (row, true)
        }
        SaveTarget::ExistingSet { set_id } => {
            let row = repo.get_set(*set_id).await?.ok_or_else(|| {
                AppError::new(StatusCode::NOT_FOUND, "SET_NOT_FOUND", format!("no set {set_id}"))
            })?;
            (row, false)
        }
    };
    let set_name = set_row.name.clone();
    let set_id = set_row.id;

    // The recorded facts per chosen method, then copy + insert. A failed copy
    // after the set row exists leaves the set (possibly empty) — a save
    // failure is reported, and the unreferenced trees are prunable; the
    // copy itself never lands a partial tree (staging + atomic rename).
    let mut saved_rows = Vec::with_capacity(chosen.len());
    for mid in &chosen {
        let pm = produced_by[mid.as_str()];
        let method_row = engine
            .get_method(req.run_id, mid)
            .await?
            .expect("checked above");
        let facts = save_facts(&summary, &method_row, pm)?;
        // DEC-3's row-is-a-reference rule at the save boundary too: saving
        // the same produced tree+method into the same set again is the SAME
        // model — the existing row stands (a second row would violate the
        // UNIQUE triple, and "the model you already saved" is the honest
        // answer, not a duplicate).
        if repo
            .model_ref_exists(Some(set_id), &pm.tree_sha256, &pm.method_id)
            .await?
        {
            let existing = repo
                .get_model_by_ref(Some(set_id), &pm.tree_sha256, &pm.method_id)
                .await?
                .expect("checked above");
            saved_rows.push(existing);
            continue;
        }
        let stored = copy_tree(Path::new(&pm.dir), &pm.tree_sha256)?;
        let row = repo
            .insert_model(&NewModel {
                set_id: Some(set_id),
                name: method_row.label.clone(),
                method_id: pm.method_id.clone(),
                method_version: pm.method_version.clone(),
                group: facts.cat.group.as_str().to_string(),
                group_label: facts.cat.group_label.clone(),
                task: facts.task.as_ref().map(|t| t.as_str().to_string()),
                provenance: ModelProvenance::Run.as_str().to_string(),
                imported_from: None,
                pretrained_catalogue_id: None,
                pretrained_catalogue_version: None,
                licence: None,
                tree_sha256: pm.tree_sha256.clone(),
                dir: stored.display().to_string(),
                size_bytes: pm.size_bytes as i64,
                contract: facts.cat.env.contract.clone(),
                env_base_digest: Some(pm.env.base_digest.clone()),
                env_layer_digest: Some(pm.env.layer_digest.clone()),
                trained_on_patients: Some(pm.trained_on_patients as i64),
                trained_at: summary.finished_at,
                decision_day: summary.config.decision_day,
                endpoint: endpoint_wire(summary.config.endpoint)?,
                horizon: summary.config.look_ahead_day,
                features: json_value(&facts.features, "features")?,
                required_markers: match &facts.cat.required_markers {
                    Some(rm) => Some(json_value(rm, "required_markers")?),
                    None => None,
                },
                marker_facts: json_value(&facts.marker_facts, "marker_facts")?,
                covariates: json_value(&facts.covariates, "covariates")?,
                embeds_training_data: facts.cat.embeds_training_data,
                own_auc: pm.own_auc,
                own_c: None,
            })
            .await?;
        saved_rows.push(row);
    }

    // The training files (L's "keep the training files" checkbox).
    if req.keep_training_files {
        let input = Path::new(&summary.dir).join("input");
        copy_training_files(&input, set_id)?;
        let training_dir_str = training_dir_for(set_id).display().to_string();
        repo.set_training_facts(set_id, true, Some(&training_dir_str)).await?;
    }

    // The one-off export (L's "Also save as a file to move to another
    // computer") — the SET's container, written after the training copy so
    // the export carries what the set carries.
    let export = if req.also_export {
        let training = if req.keep_training_files {
            Some(training_dir_for(set_id))
        } else {
            None
        };
        let set_export = export_set_rows(set_row, &saved_rows, training.as_deref())?;
        let slug = set_slug(&set_name);
        let file_name = format!("{slug}-{}.txr", &set_id.simple().to_string()[..8]);
        let (path, size) = write_export_file(&file_name, &set_export)?;
        Some(ExportTarget {
            name: file_name,
            size_bytes: size,
            dir: path
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
        })
    } else {
        None
    };

    let set_summary_row = repo
        .get_set_with_counts(set_id)
        .await?
        .ok_or_else(|| AppError::internal_error("the saved set is gone after the save"))?;
    let mut models = Vec::with_capacity(saved_rows.len());
    for row in &saved_rows {
        models.push(summary_from(row, Some(&set_name))?);
    }
    Ok(ModelSaveResponse {
        set: set_summary_from(&set_summary_row),
        models,
        export,
    })
}

/// The recorded facts' sources of a save: the catalogue entry (fact set, the
/// method's group/label/requirements — CONS-MS-7) + the run bundle's
/// `markers` (the D5-selected feature keys, contract 2.0's params.json field
/// set) + the run method row's task. The catalogue is the one source that can
/// make a model UNRECORDABLE (DEC-6: never invent a method fact).
struct SaveFacts<'a> {
    cat: &'a crate::modules::method_catalogue::types::Method,
    features: Vec<String>,
    task: Option<TxrTask>,
    marker_facts: MarkerFacts,
    covariates: CovariateFacts,
}

fn save_facts(
    summary: &TxrRunSummary,
    method_row: &MethodRow,
    produced: &TxrProducedModel,
) -> Result<SaveFacts<'static>, AppError> {
    let cat = catalogue::method(&produced.method_id).ok_or_else(|| {
        AppError::new(
            StatusCode::CONFLICT,
            "METHOD_NOT_IN_CATALOGUE",
            format!(
                "method {} is not in the shipped catalogue; its requirements cannot be recorded",
                produced.method_id
            ),
        )
    })?;
    // The bundle's params.json (contract 2.0 field set — TEST-EE-18's
    // documented layout; DRIFT-1: the `features` key of contract v1.2 was
    // replaced by `markers` in 2.0, the method's received marker list).
    let bundle_params = Path::new(&summary.dir)
        .join("bundles")
        .join(&produced.method_id)
        .join("params.json");
    let features: Vec<String> = {
        let text = fs::read_to_string(&bundle_params).map_err(|e| {
            AppError::internal_error(format!(
                "read {}: {e}",
                bundle_params.display()
            ))
        })?;
        let params: Json = serde_json::from_str(&text)
            .map_err(|e| AppError::internal_error(format!("{}: {e}", bundle_params.display())))?;
        params
            .get("markers")
            .and_then(|m| serde_json::from_value::<Vec<String>>(m.clone()).ok())
            .unwrap_or_default()
    };
    let task = parse_task(&method_row.task)?;
    let marker_facts = MarkerFacts {
        kind: cat.markers.kind,
        count: cat.markers.count,
        min_draws: cat.min_draws,
        needs_baseline: cat.needs_baseline,
        uses_history: cat.uses_history,
        needs_detection_call: cat.needs_detection_call,
        marker_groups_required: cat.marker_groups_required.clone(),
    };
    let covariates = CovariateFacts {
        catalogue: cat.covariates,
        used: summary.config.covariates,
    };
    Ok(SaveFacts {
        cat,
        features,
        task,
        marker_facts,
        covariates,
    })
}

/// A set export request built from the set's rows + kept training files
/// (PROV-MS-7's set route; `training_dir` is Some only when the set's kept
/// files actually exist — the export carries what the store holds).
pub fn export_set(
    set: &SetRow,
    rows: &[ModelRow],
    training_dir: Option<&Path>,
) -> Result<ContainerExport, AppError> {
    export_set_rows(set.clone(), rows, training_dir)
}

/// A set export request built from the set's rows + kept training files.
fn export_set_rows(
    set: SetRow,
    rows: &[ModelRow],
    training_dir: Option<&Path>,
) -> Result<ContainerExport, AppError> {
    let mut specs = Vec::with_capacity(rows.len());
    for row in rows {
        specs.push(ContainerModelSpec {
            token: row.id.to_string(),
            facts: facts_from_row(row)?,
            tree_sha256: row.tree_sha256.clone(),
            tree_dir: PathBuf::from(&row.dir),
        });
    }
    let mut training = Vec::new();
    if let Some(dir) = training_dir {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| io_app("list training dir", dir.to_path_buf())(e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| io_app("list training dir", dir.to_path_buf())(e))?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let ft = entry
                .file_type()
                .map_err(|e| io_app("stat", entry.path())(e))?;
            if ft.is_file() {
                training.push(ContainerTrainingSpec {
                    relpath: entry.file_name().to_string_lossy().into_owned(),
                    src: entry.path(),
                });
            }
        }
    }
    Ok(ContainerExport {
        set: Some(ContainerSet {
            name: set.name,
            created_at: set.created_at,
            source_label: set.source_label,
            keep_training_files: set.keep_training_files,
        }),
        models: specs,
        training,
    })
}

/// A single-model export request.
pub fn export_model(row: &ModelRow) -> Result<ContainerExport, AppError> {
    Ok(ContainerExport {
        set: None,
        models: vec![ContainerModelSpec {
            token: row.id.to_string(),
            facts: facts_from_row(row)?,
            tree_sha256: row.tree_sha256.clone(),
            tree_dir: PathBuf::from(&row.dir),
        }],
        training: vec![],
    })
}

/// The row's container facts (the export's recorded-facts block; the env
/// digests are REQUIRED by the format — a row without them cannot be carried).
fn facts_from_row(row: &ModelRow) -> Result<ContainerModelFacts, AppError> {
    let (base_digest, layer_digest) = match (&row.env_base_digest, &row.env_layer_digest) {
        (Some(b), Some(l)) => (b.clone(), l.clone()),
        _ => {
            return Err(AppError::internal_error(format!(
                "model {} records no environment digest — a corrupt row",
                row.id
            )))
        }
    };
    Ok(ContainerModelFacts {
        name: row.name.clone(),
        method_id: row.method_id.clone(),
        method_version: row.method_version.clone(),
        group: row.group.clone(),
        group_label: row.group_label.clone(),
        task: parse_task(&row.task)?,
        provenance: ContainerProvenance {
            kind: parse_provenance(&row.provenance)?,
            imported_from: row.imported_from.clone(),
            catalogue_id: row.pretrained_catalogue_id.clone(),
            licence: row.licence.clone(),
        },
        trained_on_patients: row.trained_on_patients.map(|v| v as u32),
        trained_at: row.trained_at,
        decision_day: row.decision_day,
        endpoint: parse_endpoint(&row.endpoint)?,
        horizon: row.horizon,
        contract: row.contract.clone(),
        env: TxrMethodEnv {
            base_digest,
            layer_digest,
        },
        features: parse_row(&row.features, "txr_models.features")?,
        required_markers: match &row.required_markers {
            Some(v) => Some(parse_row(v, "txr_models.required_markers")?),
            None => None,
        },
        marker_facts: parse_row(&row.marker_facts, "txr_models.marker_facts")?,
        covariates: parse_row(&row.covariates, "txr_models.covariates")?,
        embeds_training_data: row.embeds_training_data,
        own_auc: row.own_auc,
        own_c: row.own_c,
    })
}

/// The exports file name's slug (PROV-MS-3's `<set-name-slug>-<id8>.txr`):
/// alphanumeric ASCII + `-`/`_` kept, every other character a `-` — a safe
/// path component on every platform, not merely one without path separators.
pub fn set_slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "models".to_string()
    } else {
        out
    }
}

/// The attachment's `filename="<name>.txr"` value (PROV-MS-7: sanitized, no
/// path separators) — separators, quotes and control characters become `_`,
/// so a name can never escape the header value.
pub fn sanitize_attachment_name(name: &str) -> String {
    let out: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '"' | ':' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let out = out.trim().to_string();
    if out.is_empty() {
        "model".to_string()
    } else {
        out
    }
}

/// Write a `.txr` export into `<data_root>/models/exports/` (complete-or-
/// absent: staging + atomic rename, the tree store's own idiom) and return
/// the file path + its byte size.
pub fn write_export_file(name: &str, export: &ContainerExport) -> Result<(PathBuf, u64), AppError> {
    ensure_dirs()?;
    let target = exports_dir().join(name);
    let staging = exports_dir().join(format!(".staging-{name}-{}", Uuid::new_v4()));
    let written = (|| -> Result<u64, AppError> {
        let file = fs::File::create(&staging)
            .map_err(|e| io_app("create export staging", staging.clone())(e))?;
        let mut writer = std::io::BufWriter::new(file);
        // The writer returns the total byte size while every byte is still in
        // the writer; the flush below is what makes the staged file complete
        // before the rename (an error must not rename a half-written container).
        let size = write_container(&mut writer, export)?;
        std::io::Write::flush(&mut writer)
            .map_err(|e| io_app("flush export staging", staging.clone())(e))?;
        Ok(size)
    })();
    let size = match written {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_file(&staging);
            return Err(e);
        }
    };
    match fs::rename(&staging, &target) {
        Ok(()) => Ok((target, size)),
        Err(e) => {
            let _ = fs::remove_file(&staging);
            Err(io_app("rename export into place", target.clone())(e))
        }
    }
}

fn remove_tree_dir(digest: &str) -> Result<bool, AppError> {
    let dir = tree_dir(digest);
    if !dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&dir).map_err(|e| io_app("remove tree", dir.clone())(e))?;
    Ok(true)
}

fn copy_tree_contents(src: &Path, dst: &Path) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(src)
        .map_err(|e| io_app("list", src.to_path_buf())(e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| io_app("list", src.to_path_buf())(e))?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| io_app("stat", path.clone())(e))?;
        if ft.is_symlink() || (!ft.is_file() && !ft.is_dir()) {
            continue; // the PROV-SS-3 selection: regular files are the tree
        }
        if ft.is_dir() {
            let sub = dst.join(entry.file_name());
            fs::create_dir(&sub).map_err(|e| io_app("create dir", sub.clone())(e))?;
            let perms = fs::metadata(&path)
                .map_err(|e| io_app("stat", path.clone())(e))?
                .permissions();
            fs::set_permissions(&sub, perms).map_err(|e| io_app("set mode", sub.clone())(e))?;
            copy_tree_contents(&path, &sub)?;
        } else {
            let to = dst.join(entry.file_name());
            fs::copy(&path, &to).map_err(|e| io_app("copy", to.clone())(e))?;
            let perms = fs::metadata(&path)
                .map_err(|e| io_app("stat", path.clone())(e))?
                .permissions();
            fs::set_permissions(&to, perms).map_err(|e| io_app("set mode", to.clone())(e))?;
        }
    }
    Ok(())
}

fn collect_regular_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), AppError> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| io_app("list", dir.to_path_buf())(e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| io_app("list", dir.to_path_buf())(e))?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| io_app("stat", path.clone())(e))?;
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            collect_regular_files(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| AppError::internal_error(format!("relative path: {e}")))?;
            out.push((rel.to_string_lossy().into_owned(), path));
        }
    }
    Ok(())
}

/// The engine's io_app shape (orchestrator.rs) — a path-naming wrapper so
/// every store error names the file that failed.
fn io_app(what: &'static str, path: PathBuf) -> impl FnOnce(std::io::Error) -> AppError {
    move |e| AppError::internal_error(format!("{what} {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    //! TEST-MS-04 / TEST-MS-05 — the tree store's contract over real bytes on
    //! a scoped data root (the fixtures are synthetic: patient-free marker
    //! names, model serializations that are opaque bytes — never real data).
    //! The repository's own round trip (TEST-MS-03) supplies the rows; these
    //! tests glue rows + bytes and pin the prune / immutability rules.

    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use chrono::{DateTime, Utc};
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::*;
    use crate::modules::rootfs;
    use crate::modules::sandbox::stack::{tree_sha256, verify_model_tree};
    use crate::modules::model_store::repository::{ModelStoreRepository, NewModel};

    /// A file-backed pool with the FULL merged chain (the runtime's
    /// `MERGED_MIGRATOR` shape — `build.rs` composes the module-owned dirs
    /// into `migrations-merged/`, so one Migrator applies engine + store):
    /// produced models live in the engine's `txr_run_methods`, the store's
    /// rows are `txr_models`, and the run-row guard of TEST-MS-05 needs the
    /// real `txr_runs` table (the engine's in-crate suite precedent).
    async fn test_pool() -> (SqlitePool, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "model-store-tree-test-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite file connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR
            .run(&pool)
            .await
            .expect("merged migrations apply");
        (pool, path)
    }

    /// A scratch data root under the worktree's gitignored `target/` (the
    /// engine's `test_data_dir` pattern — never `/tmp`), with the thread's
    /// scoped override installed for its whole lifetime.
    fn scratch_root(name: &str) -> (PathBuf, rootfs::DataRootGuard) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("target")
            .join("txr-model-store-item3")
            .join(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("scratch root");
        let guard = rootfs::scoped_data_root(root.clone());
        (root, guard)
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        fs::write(path, bytes).expect("fixture file");
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("fixture mode");
    }

    /// A synthetic produced tree: opaque non-text bytes, a nested dir, a
    /// distinctive file mode — content-addressing means the digest follows the
    /// BYTES, so `variant` is folded into the content to keep two fixtures
    /// distinct. Returns (src, digest, size) — the digest is the engine's own
    /// `tree_sha256`, exactly what `produced_models` would carry.
    fn fixture_tree(root: &Path, variant: &str) -> (PathBuf, String, u64) {
        let src = root.join("produced-model");
        let model = format!(
            r#"{{"contract":"2.0","method":"dynforest","features":["M1"],"variant":"{variant}"}}"#
        );
        write_file(&src.join("model.json"), model.as_bytes());
        write_file(
            &src.join("weights").join("tree-01.bin"),
            format!("{variant}").as_bytes(),
        );
        write_file(
            &src.join("weights").join("tree-02.blob"),
            format!("opaque\x00{variant}\x00bytes").as_bytes(),
        );
        #[cfg(unix)]
        set_mode(&src.join("model.json"), 0o640);
        let digest = tree_sha256(&src).expect("fixture digest");
        let size = tree_size(&src).expect("fixture size");
        (src, digest, size)
    }

    /// Every regular file of a tree as name → (bytes, mode) — the byte-level
    /// comparison surface of TEST-MS-04.
    fn files_of(dir: &Path) -> BTreeMap<String, (Vec<u8>, u32)> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in fs::read_dir(&d).expect("read_dir") {
                let entry = entry.expect("entry");
                let path = entry.path();
                let ft = entry.file_type().expect("file_type");
                if ft.is_dir() {
                    stack.push(path);
                } else if ft.is_file() {
                    let rel = path
                        .strip_prefix(dir)
                        .expect("strip")
                        .to_string_lossy()
                        .into_owned();
                    let bytes = fs::read(&path).expect("read");
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let mode = fs::metadata(&path).expect("meta").permissions().mode();
                        out.insert(rel, (bytes, mode));
                    }
                    #[cfg(not(unix))]
                    out.insert(rel, (bytes, 0));
                }
            }
        }
        out
    }

    /// TEST-MS-04's row for the store layer's glue tests (the save flow's
    /// recorded values are the engine's; this is the row a produced model
    /// would carry once saved).
    fn row_for(
        dir: &Path,
        digest: &str,
        set_id: Option<Uuid>,
        method_id: &str,
    ) -> NewModel {
        NewModel {
            set_id,
            name: format!("{method_id} trained model"),
            method_id: method_id.to_string(),
            method_version: "1.2.0".to_string(),
            group: "landmark".to_string(),
            group_label: "Landmark stats".to_string(),
            task: Some("pfs".to_string()),
            provenance: "run".to_string(),
            imported_from: None,
            pretrained_catalogue_id: None,
            pretrained_catalogue_version: None,
            licence: None,
            tree_sha256: digest.to_string(),
            dir: dir.display().to_string(),
            size_bytes: 0,
            contract: "2.0".to_string(),
            env_base_digest: Some("sha256:base0000".to_string()),
            env_layer_digest: Some("sha256:layer000".to_string()),
            trained_on_patients: Some(151),
            trained_at: Some(
                "2026-10-19T14:30:00+00:00"
                    .parse::<DateTime<Utc>>()
                    .expect("fixture timestamp parses"),
            ),
            decision_day: 56.0,
            endpoint: "pfs".to_string(),
            horizon: 238.0,
            features: json!(["M1"]),
            required_markers: None,
            marker_facts: json!({"kind": "single", "count": 1, "min_draws": 3, "needs_baseline": true, "uses_history": "landmark", "needs_detection_call": false, "marker_groups_required": []}),
            covariates: json!({"catalogue": "optional", "used": true}),
            embeds_training_data: false,
            own_auc: Some(0.66),
            own_c: Some(0.63),
        }
    }

    /// The relocated half of TEST-MS-01 (the item that owns `store.rs`): the
    /// store dirs are created lazily and idempotently — repeated and
    /// concurrent creations are all-success and one tree.
    #[test]
    fn models_dir_creation_is_idempotent() {
        let (root, _guard) = scratch_root("dir-idempotence");
        ensure_dirs().expect("first creation");
        ensure_dirs().expect("second creation");
        assert_eq!(models_dir(), root.join("models"));
        assert!(models_dir().is_dir());
        assert!(trees_dir().is_dir());
        assert!(training_dir().is_dir());
        assert!(exports_dir().is_dir());

        // Concurrent: each thread installs its OWN scoped root (the hermetic
        // pattern — never a process-env mutation) and runs the same creation.
        let mut handles = Vec::new();
        for _ in 0..4 {
            let d = root.clone();
            handles.push(std::thread::spawn(move || {
                let _g = rootfs::scoped_data_root(d);
                ensure_dirs()
            }));
        }
        for h in handles {
            h.join()
                .expect("thread")
                .expect("concurrent ensure_dirs succeeds");
        }
        assert!(models_dir().is_dir());

        // Nothing else exists under the scoped root (only the models tree).
        let mut entries: Vec<_> = fs::read_dir(&root)
            .expect("root")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();
        assert_eq!(entries, vec!["models"]);
    }

    /// TEST-MS-27 (the ITEM-7 hygiene pass): the write gate's staging sweep
    /// reclaims an AGED orphan of each of the three staging families (tree
    /// copy dir, import dir, export file) and leaves a FRESH staging entry —
    /// the possible in-flight one — plus every real store entry alone. Both
    /// halves matter: a sweep that deleted a live operation's staging would be
    /// a worse bug than the disk leak it fixes (the framework's own sweep
    /// contract, `modules/file/stream.rs`).
    #[test]
    fn staging_orphans_are_reclaimed_and_live_entries_kept() {
        let (root, _guard) = scratch_root("staging-sweep");
        ensure_dirs().expect("store dirs");

        // The three aged orphan families, each with content (an orphan is
        // exactly what a killed process left BETWEEN the staging write and the
        // rename).
        let stale_tree = trees_dir().join(format!(".staging-{}-orphan", "a".repeat(64)));
        write_file(&stale_tree.join("model.json"), b"half-copied");
        let stale_import = models_dir().join(format!(".import-{}", Uuid::new_v4()));
        write_file(&stale_import.join("model-0").join("weights.bin"), b"half-extracted");
        let stale_export = exports_dir().join(format!(".staging-foo-{}", Uuid::new_v4()));
        write_file(&stale_export, b"half-written");

        // A FRESH staging entry — what a concurrent in-flight operation looks
        // like (created moments ago, mtime advances as bytes land).
        let live_tree = trees_dir().join(format!(".staging-{}-live", "b".repeat(64)));
        write_file(&live_tree.join("model.json"), b"in flight");

        // Real store entries — a stored tree and the unrelated model-dir file
        // (the import prefix lives NEXT TO trees/, training/ and exports/).
        let real_tree = trees_dir().join("c".repeat(64));
        write_file(&real_tree.join("model.json"), b"the stored artifact");
        write_file(&models_dir().join("README.txt"), b"unrelated");

        let aged = SystemTime::now() - STAGING_MAX_AGE - Duration::from_secs(60);
        backdate(&stale_tree, aged);
        backdate(&stale_import, aged);
        backdate(&stale_export, aged);
        backdate(&real_tree, aged); // aged but NOT a staging name — the prefix gate

        let reclaimed = sweep_stale_staging();
        assert_eq!(reclaimed, 3, "exactly the three prefixed aged orphans");
        assert!(!stale_tree.exists(), "a killed tree copy's staging is reclaimed");
        assert!(!stale_import.exists(), "a killed import's staging is reclaimed");
        assert!(!stale_export.exists(), "a killed export's staging is reclaimed");
        assert!(live_tree.exists(), "a FRESH staging entry is never touched");
        assert!(real_tree.exists(), "an aged TREE (no staging prefix) is never touched");
        assert!(models_dir().join("README.txt").exists(), "unrelated files never touched");

        // The write gate runs the sweep too (ensure_dirs is the hook): a
        // second orphan created after the setup is reclaimed on the next
        // ensure_dirs, before the caller's own staging would be created.
        let late = trees_dir().join(format!(".staging-{}-late", "d".repeat(64)));
        write_file(&late.join("model.json"), b"late orphan");
        backdate(&late, aged);
        ensure_dirs().expect("write gate");
        assert!(!late.exists(), "ensure_dirs reclaims aged orphans");
    }

    /// Set an entry's mtime without pulling in a dependency for it (the
    /// framework's `filetime_set` pattern — `File::set_modified` on an opened
    /// fd; a read-only open suffices for directories too).
    fn backdate(path: &Path, when: SystemTime) {
        let f = fs::File::open(path).expect("open for backdating");
        f.set_modified(when).expect("backdate mtime");
    }

    /// TEST-MS-04 (acceptance, INV-2): a produced tree into
    /// `trees/<tree_sha256>/` is byte-identical (every file's sha256, modes
    /// preserved), the copy is idempotent (a second copy of the same tree
    /// adds no second dir), the immutability rule holds (a write into a
    /// stored tree is refused and the tree is unchanged), and `tree_size`
    /// equals the sum over the tree.
    #[test]
    fn copy_tree_is_byte_identical_idempotent_and_immutable() {
        let (root, _guard) = scratch_root("copy-identical");
        let (src, digest, size) = fixture_tree(&root, "original");

        let stored = copy_tree(&src, &digest).expect("copy stores the tree");
        assert_eq!(stored, tree_dir(&digest));
        assert_eq!(stored.parent().expect("parent"), trees_dir());
        assert!(stored
            .strip_prefix(&root.join("models"))
            .expect("under the models root")
            .starts_with("trees"));

        // The copy walks the PROV-SS-3 file selection: a symlink in the source
        // is not part of the tree (the digest never covers it, and a store
        // copy must not point outside its own dir).
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("model.json", src.join("link.json"))
                .expect("fixture symlink");
            assert_eq!(
                tree_sha256(&src).expect("digest ignores the symlink"),
                digest,
                "the digest walks regular files only"
            );
        }

        // Byte-identical: every file's bytes match, every mode preserved.
        let before = files_of(&src);
        let after = files_of(&stored);
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>(),
            "the same file set, nested dirs included"
        );
        #[cfg(unix)]
        assert!(
            !after.contains_key("link.json"),
            "a symlink is never copied into a stored tree"
        );
        for (rel, (bytes, mode)) in &before {
            let (got, got_mode) = &after[rel];
            assert_eq!(got, bytes, "{rel} bytes");
            #[cfg(unix)]
            assert_eq!(got_mode & 0o777, mode & 0o777, "{rel} mode");
        }
        assert_eq!(tree_size(&stored).expect("size"), size);
        assert!(tree_size(&stored).expect("size") > 0);
        // The engine's own verification accepts the stored tree — the copy is
        // the digest it committed to (CONS-MS-10's seam, one algorithm).
        verify_model_tree(&stored, &digest).expect("stored tree verifies");
        // The digest of the copy equals the engine's digest of the source.
        assert_eq!(tree_sha256(&stored).expect("copy digest"), digest);

        // Idempotent: the same tree from a second source path reuses the dir.
        let (src2, digest2, _) = fixture_tree(&root.join("second-copy"), "original");
        assert_eq!(digest2, digest, "identical bytes, identical digest");
        let stored2 = copy_tree(&src2, &digest).expect("second copy reuses");
        assert_eq!(stored2, stored, "one content-addressed dir per digest");
        // … and the trees dir holds exactly one tree dir (no staging leftover).
        let mut tree_entries: Vec<_> = fs::read_dir(trees_dir())
            .expect("trees dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        tree_entries.sort();
        assert_eq!(tree_entries.len(), 1, "{tree_entries:?}");
        assert_eq!(tree_entries[0], digest);

        // Immutability: a write into a stored tree is refused, and the tree is
        // left byte-identical (its engine digest still verifies).
        let err = write_tree_file(&digest, "model.json", b"tampered").expect_err("refused");
        assert_eq!(err.status_code(), 400);
        assert_eq!(err.error_code(), "TREE_IMMUTABLE");
        verify_model_tree(&stored, &digest).expect("untouched after the refused write");
        assert_eq!(files_of(&stored), before);
    }

    /// TEST-MS-04 (keep_training_files half): the run's `input/` files land in
    /// `models/training/<set_id>/` with their original names, and a second
    /// copy into the same set is an overwrite of the same names.
    #[test]
    fn keep_training_files_copies_the_input_files_with_original_names() {
        let (root, _guard) = scratch_root("training-copy");
        let run_input = root.join("run").join("input");
        write_file(&run_input.join("patients.csv"), b"patient_id,pfs_days\nS0001,238\n");
        write_file(&run_input.join("measurements.csv"), b"patient_id,marker,day,value\nS0001,M1,0,1.2\n");
        write_file(&run_input.join("run-input.json"), b"{\"mode\":\"train\"}");
        // The documented layout is flat: a subdir is not part of it.
        write_file(&run_input.join("extra").join("nested.csv"), b"ignored");

        let set_id = Uuid::new_v4();
        let target = copy_training_files(&run_input, set_id).expect("training copy");
        assert_eq!(target, training_dir_for(set_id));
        fs::read_dir(&target)
            .expect("target")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .for_each(|name| {
                assert!(!name.contains("nested"), "subdirs are not copied: {name}");
            });
        assert_eq!(
            fs::read(&target.join("patients.csv")).expect("patients"),
            b"patient_id,pfs_days\nS0001,238\n"
        );
        assert_eq!(
            fs::read(&target.join("measurements.csv")).expect("measurements"),
            b"patient_id,marker,day,value\nS0001,M1,0,1.2\n"
        );
        assert_eq!(
            fs::read(&target.join("run-input.json")).expect("run-input"),
            b"{\"mode\":\"train\"}"
        );

        // Second copy into the same set: same paths, same bytes (overwrite).
        let target2 = copy_training_files(&run_input, set_id).expect("second copy");
        assert_eq!(target2, target);
        assert!(target.join("patients.csv").is_file());
        // A different set gets its own dir.
        let target3 = copy_training_files(&run_input, Uuid::new_v4()).expect("other set copy");
        assert_ne!(target3, target);
        assert_eq!(remove_training_dir(set_id).expect("remove"), true);
        assert!(!target.exists());
        assert_eq!(remove_training_dir(set_id).expect("again"), false);
    }

    /// TEST-MS-05 (prune half): deleting the LAST row referencing a tree
    /// removes the tree dir; deleting one of two rows sharing a tree keeps it.
    #[tokio::test]
    async fn tree_prune_removes_the_dir_only_at_zero_refs() {
        let (root, _guard) = scratch_root("prune-refs");
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());
        let set_a = repo.insert_set("set A", None, None, false, None).await.expect("set A");
        let set_b = repo.insert_set("set B", None, None, false, None).await.expect("set B");

        let (src_shared, shared_digest, _) = fixture_tree(&root, "shared");
        let shared_dir = copy_tree(&src_shared, &shared_digest).expect("shared tree");
        let (src_own, own_digest, _) = fixture_tree(&root.join("own"), "own");
        let own_dir = copy_tree(&src_own, &own_digest).expect("own tree");

        let m1 = repo.insert_model(&row_for(&shared_dir, &shared_digest, Some(set_a.id), "dynforest")).await.expect("m1");
        let m2 = repo.insert_model(&row_for(&shared_dir, &shared_digest, Some(set_b.id), "dynforest")).await.expect("m2");
        let m3 = repo.insert_model(&row_for(&own_dir, &own_digest, None, "landmark-cox")).await.expect("m3");

        // One of two refs gone: the shared tree stays.
        assert!(repo.delete_model(m1.id).await.expect("delete m1"));
        assert!(!prune_unreferenced_tree(&pool, &shared_digest).await.expect("prune shared"));
        assert!(tree_dir(&shared_digest).is_dir());
        assert_eq!(repo.count_refs(&shared_digest).await.expect("refs"), 1);

        // The last ref gone: the shared tree goes with it.
        assert!(repo.delete_model(m2.id).await.expect("delete m2"));
        assert!(prune_unreferenced_tree(&pool, &shared_digest).await.expect("prune shared"));
        assert!(!tree_dir(&shared_digest).exists(), "last reference gone");
        // … and pruning again is a harmless false.
        assert!(!prune_unreferenced_tree(&pool, &shared_digest).await.expect("prune again"));

        // The standalone model's tree goes with its only row.
        assert!(repo.delete_model(m3.id).await.expect("delete m3"));
        assert!(prune_unreferenced_tree(&pool, &own_digest).await.expect("prune own"));
        assert!(!tree_dir(&own_digest).exists());

        // A digest still referenced is never pruned.
        let (src_keep, keep_digest, _) = fixture_tree(&root.join("keep"), "keep");
        let keep_dir = copy_tree(&src_keep, &keep_digest).expect("keep tree");
        let keep_row = repo.insert_model(&row_for(&keep_dir, &keep_digest, None, "glmnet-cph")).await.expect("keep row");
        assert!(!prune_unreferenced_tree(&pool, &keep_digest).await.expect("keep"));
        assert!(tree_dir(&keep_digest).is_dir());
        assert!(repo.delete_model(keep_row.id).await.expect("delete keep"));

        pool.close().await;
        let _ = fs::remove_file(&path);
    }

    /// TEST-MS-05 (cascade half): a set cascade delete with `keep_files=false`
    /// prunes the set's trees + its training dir; `keep_files=true` leaves the
    /// files and removes the rows only.
    #[tokio::test]
    async fn set_cascade_prune_honors_keep_files() {
        let (root, _guard) = scratch_root("set-cascade");
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        // Two trees for two methods + a populated training dir.
        let (src1, d1, _) = fixture_tree(&root.join("m1"), "one");
        let dir1 = copy_tree(&src1, &d1).expect("tree 1");
        let (src2, d2, _) = fixture_tree(&root.join("m2"), "two");
        let dir2 = copy_tree(&src2, &d2).expect("tree 2");
        let set = repo.insert_set("cascade", None, None, true, Some("x")).await.expect("set");
        let r1 = repo.insert_model(&row_for(&dir1, &d1, Some(set.id), "dynforest")).await.expect("r1");
        let r2 = repo.insert_model(&row_for(&dir2, &d2, Some(set.id), "landmark-cox")).await.expect("r2");
        let run_input = root.join("run-input");
        write_file(&run_input.join("patients.csv"), b"S0001\n");
        copy_training_files(&run_input, set.id).expect("training copy");
        let training = training_dir_for(set.id);
        assert!(training.is_dir());

        // keep_files = true: rows (cascade) only — files stay.
        assert!(repo.delete_set(set.id).await.expect("delete set"));
        assert!(repo.list_models(None, None, None).await.expect("models").is_empty());
        assert_eq!(repo.count_refs(&d1).await.expect("refs1"), 0);
        assert_eq!(repo.count_refs(&d2).await.expect("refs2"), 0);
        assert!(tree_dir(&d1).is_dir(), "keep_files: the tree dir stays");
        assert!(tree_dir(&d2).is_dir());
        assert!(training.is_dir(), "keep_files: the training dir stays");
        // The store never proposes to prune on this path: even a prune walk
        // would be the caller's rows-only delete's conscious skip.

        // keep_files = false (the default): prune the now-unreferenced trees
        // + the training dir.
        let (src3, d3, _) = fixture_tree(&root.join("m3"), "three");
        let dir3 = copy_tree(&src3, &d3).expect("tree 3");
        let set2 = repo.insert_set("cascade 2", None, None, true, None).await.expect("set 2");
        repo.insert_model(&row_for(&dir3, &d3, Some(set2.id), "dynforest")).await.expect("r3");
        write_file(&root.join("run-input2").join("patients.csv"), b"S0002\n");
        copy_training_files(&root.join("run-input2"), set2.id).expect("training copy 2");
        let training2 = training_dir_for(set2.id);
        assert!(training2.is_dir());

        assert!(repo.delete_set(set2.id).await.expect("delete set 2"));
        assert_eq!(
            prune_unreferenced_trees(&pool, &[d3.clone()]).await.expect("prune"),
            1,
            "the one unreferenced tree dir is removed"
        );
        assert!(remove_training_dir(set2.id).expect("remove training"));
        assert!(!tree_dir(&d3).exists());
        assert!(!training2.exists());

        // The keep_files=true set's files are still there — untouched by the
        // second set's prune (never pruned, its rows' cascade was rows-only).
        assert!(tree_dir(&d1).is_dir());
        assert!(training.is_dir());

        pool.close().await;
        let _ = fs::remove_file(&path);
    }

    /// TEST-MS-05 (run-isolation half): a store delete — model row, set
    /// cascade, prune, training removal — never touches a `txr_runs` row.
    #[tokio::test]
    async fn store_deletes_never_touch_runs() {
        let (root, _guard) = scratch_root("runs-untouched");
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        // A real engine row (the table the store must not reach — the J board
        // "Results already made with it are kept in History" is this rule).
        let run_id = Uuid::new_v4();
        sqlx::query!(
            r#"INSERT INTO txr_runs
                 (id, status, mode, config, input_summary, method_count, counts, dir, seed)
               VALUES ($1, 'finished', 'train', '{}', '{}', 1, '{}', '/data/runs/demo', 1)"#,
            run_id,
        )
        .execute(&pool)
        .await
        .expect("run row inserts");

        let (src, digest, _) = fixture_tree(&root, "runs");
        let dir = copy_tree(&src, &digest).expect("tree");
        let set = repo.insert_set("set", None, None, false, None).await.expect("set");
        let row = repo.insert_model(&row_for(&dir, &digest, Some(set.id), "dynforest")).await.expect("row");
        write_file(&root.join("run-input").join("patients.csv"), b"S0001\n");
        copy_training_files(&root.join("run-input"), set.id).expect("training copy");

        // Delete everything the store owns.
        assert!(repo.delete_model(row.id).await.expect("delete model"));
        assert!(prune_unreferenced_tree(&pool, &digest).await.expect("prune"));
        assert!(remove_training_dir(set.id).expect("remove training"));
        assert!(repo.delete_set(set.id).await.expect("delete set"));

        let runs = sqlx::query_scalar!(r#"SELECT COUNT(*) as "n!: i64" FROM txr_runs"#)
            .fetch_one(&pool)
            .await
            .expect("count runs");
        assert_eq!(runs, 1, "the run row survives every store delete");
        assert!(!tree_dir(&digest).exists());

        pool.close().await;
        let _ = fs::remove_file(&path);
    }

    /// TEST-MS-14 (store half): `resolve_assets` — the PROV-MS-8 core returns
    /// the engine's asset shape for a verified tree, refuses a tampered host
    /// dir with 409 `MODEL_VERIFY_FAILED` BEFORE the asset leaves (DEC-5), and
    /// answers 404 `MODEL_NOT_FOUND` for an unknown or unparseable id. The
    /// tamper is one byte flipped in a STORED tree — content addressing means
    /// the row's digest no longer matches the bytes.
    #[tokio::test]
    async fn resolve_assets_verifies_before_any_asset_leaves() {
        let (root, _guard) = scratch_root("resolve");
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        let (src, digest, _) = fixture_tree(&root, "resolve");
        let dir = copy_tree(&src, &digest).expect("tree");
        let row = repo
            .insert_model(&row_for(&dir, &digest, None, "dynforest"))
            .await
            .expect("row");
        let id = row.id.to_string();

        // The verified asset: the engine's element shape (model_id, host_dir,
        // tree_sha256, method_id, method_version, env, contract).
        let assets = resolve_assets(&pool, &[id.clone()]).await.expect("resolve");
        assert_eq!(assets.len(), 1);
        let a = &assets[0];
        assert_eq!(a.model_id, id);
        assert_eq!(a.host_dir, dir.display().to_string());
        assert_eq!(a.tree_sha256, digest);
        assert_eq!(a.method_id, "dynforest");
        assert_eq!(a.method_version, "1.2.0");
        assert_eq!(a.contract, "2.0");
        assert_eq!(a.env.base_digest, "sha256:base0000");
        assert_eq!(a.env.layer_digest, "sha256:layer000");

        // A tampered byte in the STORED tree: the resolve refuses with the
        // seam's code at 409 (the plan's MODEL_VERIFY_FAILED) — and NO asset
        // returns (the failure is per-request in the caller's selection; the
        // engine only ever receives honest assets).
        fs::write(dir.join("model.json"), b"tampered once").expect("tamper");
        let err = resolve_assets(&pool, &[id.clone()]).await.expect_err("must refuse");
        assert_eq!(err.status_code(), 409);
        assert_eq!(err.error_code(), "MODEL_VERIFY_FAILED");
        assert!(err.to_string().contains(&digest), "the failure names the digest");

        // Unknown id → 404 MODEL_NOT_FOUND; an unparseable id → the same.
        let err = resolve_assets(&pool, &[Uuid::new_v4().to_string()])
            .await
            .expect_err("unknown");
        assert_eq!(err.status_code(), 404);
        assert_eq!(err.error_code(), "MODEL_NOT_FOUND");
        let err = resolve_assets(&pool, &["not-a-uuid".to_string()])
            .await
            .expect_err("unparseable");
        assert_eq!(err.status_code(), 404);
        assert_eq!(err.error_code(), "MODEL_NOT_FOUND");

        pool.close().await;
        let _ = fs::remove_file(&path);
    }
}
