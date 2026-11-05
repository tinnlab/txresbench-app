//! Model-store tree layer (PLAN Phase C, PROV-MS-10's path half) — where
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

use std::fs;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::repository::ModelStoreRepository;
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
pub fn ensure_dirs() -> Result<(), AppError> {
    for dir in [models_dir(), trees_dir(), training_dir(), exports_dir()] {
        fs::create_dir_all(&dir).map_err(|e| io_app("create store dir", dir.clone())(e))?;
    }
    Ok(())
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
}
