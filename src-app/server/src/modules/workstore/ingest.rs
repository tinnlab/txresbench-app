//! Write-path ingest of a run's `/outputs` produces-manifest (ITEM-5).
//!
//! `ingest_run_outputs` is called by P3's job-completion hook. It reads
//! `<staging>/outputs/manifest.json`, hashes + stores each declared output
//! into the object store (single blob or a `put_prefix` for a multi-file
//! artifact), computes the merkle `content_hash` (ITEM-6), and inserts one
//! catalog row per output — **atomically**: all rows land `ready` or the whole
//! ingest rolls back. Undeclared files (logs/temp) are NOT promoted.
//!
//! Path safety (blind-audit MED): every declared `path` is confined to
//! `<staging>/outputs` BEFORE it is read. Each path is (1) structurally
//! validated ([`validate_output_rel_path`] — rejects empty/absolute/`..`/`.`
//! components) and (2) canonicalized + verified to stay under the canonical
//! outputs dir (defeats a symlink whose target escapes). Without this, a raw
//! `join` of a manifest-supplied `path` escapes — `PathBuf::join` REPLACES the
//! base on an absolute component (`join("/etc/passwd")` → `/etc/passwd`) and a
//! `..` walks out — so the ingest would read an arbitrary host file. This
//! matches the confinement `sandbox::outputs::load_produced_outputs` performs on
//! the live finalize/verify path; it is re-implemented locally here so the write
//! path never re-joins an unvalidated path.
//!
//! **A1 / DEC-18:** the `OutputsManifest` shape is P3-owned. P3 has landed, so
//! P1 now IMPORTS the canonical type from `sandbox::outputs` (the single source)
//! rather than mirroring it — a field change there is a compile-time break here,
//! not a silent drift.

use std::path::{Path, PathBuf};

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::catalog::models::{Artifact, NewArtifact};
use super::catalog::repository::CatalogRepository;
use super::object_store::ObjectStore;

// The canonical produces-manifest (A1). Owned by P3; imported here so P1/P2/P4
// all deserialize the ONE definition (`id/datatype/path/layout/role`).
pub use crate::modules::sandbox::outputs::{OutputEntry, OutputsManifest};

/// A reference to a freshly-ingested (or idempotently re-ingested) artifact.
pub type ArtifactRef = Artifact;

/// Ingest a run's declared outputs. `staging` is the OUTPUT STAGING dir the run
/// wrote to — outside the sandbox workspace, which the runner deletes when the run
/// ends (ITEM-17: P3 wires the mount; P1 reads staging). Returns the N catalog rows.
///
/// That sentence was aspirational until ITEM-17 landed: outputs were a subdirectory
/// OF the workspace at four independent sites, so this function was in fact reading
/// the dir it claimed to be independent of.
///
/// ITEM-23: the run's tenancy scope is a project OR a dataset (owner) — exactly one
/// is `Some`. A project-scoped run tags its artifacts with `project_id`; a
/// dataset-scoped processing run tags them with `dataset_id`. Callers must pass at
/// least one scope (the ingest sink guards this before calling).
pub async fn ingest_run_outputs(
    pool: &PgPool,
    store: &dyn ObjectStore,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    run_id: Uuid,
    created_by: Option<Uuid>,
    staging: &Path,
) -> Result<Vec<ArtifactRef>, AppError> {
    // The ONE definition of the `/outputs` host subdir (ITEM-17), shared with the
    // mkdir, the bind mount and `sandbox::outputs::load_produced_outputs`.
    let outputs_dir = crate::modules::sandbox::outputs::outputs_dir(staging);
    let manifest_path = outputs_dir.join("manifest.json");
    let raw = tokio::fs::read(&manifest_path).await.map_err(|e| {
        AppError::bad_request(
            "MISSING_MANIFEST",
            format!("no outputs manifest at {}: {e}", manifest_path.display()),
        )
    })?;
    let manifest: OutputsManifest = serde_json::from_slice(&raw).map_err(|e| {
        AppError::bad_request("BAD_MANIFEST", format!("malformed outputs manifest: {e}"))
    })?;

    // Structurally reject an escaping declared `path` (empty/absolute/`..`/`.`)
    // BEFORE any filesystem access (blind-audit MED). A raw join of an
    // unvalidated `path` escapes `/outputs` (`PathBuf::join` replaces the base on
    // an absolute component; `..` walks out), reading an arbitrary host file.
    for entry in &manifest.outputs {
        validate_output_rel_path(&entry.path)?;
        validate_declared_structure(&entry.id, &entry.structure)?;
    }

    // P2 (datatype) validates every declared output's typing UP FRONT — before any
    // blob is stored — so an unknown/abstract datatype or a layout mismatch fails
    // FAST (422, whole ingest rolls back) and never leaves orphan blobs. The registry
    // is a process-wide singleton built at boot; if boot never ran it (a direct-repo
    // unit test that doesn't spin the module graph), validation is skipped. `shape` is
    // empty at ingest today (the manifest declares no shape), so shape validators must
    // accept `{}` — see datatype::builtin.
    if let Some(registry) = crate::modules::datatype::try_registry() {
        for entry in &manifest.outputs {
            crate::modules::datatype::validate_artifact_typing(
                &registry,
                &entry.datatype,
                &entry.layout,
                &serde_json::json!({}),
            )?;
        }
    }

    // Canonicalize the outputs dir ONCE so the per-entry containment check below
    // compares canonical prefixes (defeats a symlink placed inside /outputs).
    let canon_outputs = tokio::fs::canonicalize(&outputs_dir).await.map_err(|e| {
        AppError::bad_request(
            "BAD_OUTPUTS_DIR",
            format!(
                "canonicalize outputs dir {} failed: {e}",
                outputs_dir.display()
            ),
        )
    })?;

    // Store every declared output's blob(s) FIRST (idempotent, content-addressed),
    // building the catalog rows. Only after all blobs land do we open the DB tx and
    // insert atomically — so a mid-ingest failure leaves orphan blobs (reclaimed by
    // the GC sweep) but never a partial catalog.
    // Read-at-use (INV-4, issue #54): the ingest OOM ceilings are admin settings.
    // Read once for this ingest; `settings_cache::get` falls back to the compiled
    // defaults (== MAX_OUTPUT_FILE_BYTES / MAX_MULTIFILE_TOTAL_BYTES) on a DB error,
    // so an unset deployment is byte-identical (INV-1). Bounded ceilings (DEC-3).
    let ingest_settings = crate::modules::workstore::settings_cache::get(pool).await;
    let max_file = ingest_settings.max_output_file_bytes_u64();
    let max_total = ingest_settings.max_multifile_total_bytes_u64();

    let mut pending: Vec<NewArtifact> = Vec::with_capacity(manifest.outputs.len());
    for entry in &manifest.outputs {
        // `entry.path` is `/outputs`-relative (validated above). Resolve it,
        // canonicalize (resolves any symlink + `.`), and CONFINE it under the
        // canonical outputs dir before reading — belt-and-braces with the
        // structural check, and the guard that catches a symlink whose target
        // escapes /outputs.
        let src = outputs_dir.join(&entry.path);
        let canon = tokio::fs::canonicalize(&src).await.map_err(|e| {
            AppError::bad_request(
                "MISSING_OUTPUT",
                format!(
                    "declared output {:?} not found under /outputs: {e}",
                    entry.path
                ),
            )
        })?;
        if !canon.starts_with(&canon_outputs) {
            return Err(AppError::bad_request(
                "OUTPUT_ESCAPES_OUTPUTS",
                format!(
                    "declared output {:?} resolves outside /outputs (escape attempt)",
                    entry.path
                ),
            ));
        }
        let (object_key, content_hash, is_multifile, stored_bytes) =
            store_output(store, &canon, max_file, max_total).await?;
        pending.push(NewArtifact {
            project_id,
            dataset_id,
            run_id: Some(run_id),
            output_id: entry.id.clone(),
            datatype: entry.datatype.clone(),
            // Real handling: `store_output` above just wrote these bytes, so this path
            // always has a key. A gathered artifact is never created by ingest — it is
            // created by the alignment analysis, which writes no blob.
            object_key: Some(object_key),
            is_multifile,
            content_hash,
            // ITEM-5/6: the producer's declarations, carried through VERBATIM.
            // The server does not synthesize, merge or validate their contents —
            // it stores what was declared (INV-1) and a missing declaration has
            // already failed deserialization upstream (INV-2).
            //
            // These two ARE the artifact's declaration surface now. ITEM-7 dropped
            // `shape`/`params`/`covered_axes`/`storage_layout`, and with `params`
            // went the server-synthesized `{role,label,meta}` bag `ingest_params`
            // used to build — a merge of three manifest fields into a fourth
            // column, i.e. the server authoring meaning on the producer's behalf.
            structure: entry.structure.clone(),
            meta: entry.meta.clone(),
            // The producer's DECLARED tier (DEC-8), carried through VERBATIM like
            // `structure`/`meta` above. It used to be NORMALIZED here — blank ⇒
            // `artifact` via `role_or_default` — which meant a manifest that declared
            // no tier landed on the PROMOTABLE one, i.e. absence resolving to the more
            // privileged value (INV-2 forbids exactly that). The manifest contract now
            // refuses both an omitted and a blank `role`, so nothing is left to
            // normalize: the column is NOT NULL with no default and can never hold the
            // empty string because the entry could not have deserialized.
            //
            // It is a COLUMN and not a key in `meta` because the promote gate acts on
            // it: `meta` is the producer's display declaration carried verbatim, and
            // reading a server decision out of it would be `params` again under a new
            // name. See migration `…0003_artifact_role.sql`.
            role: entry.role.clone(),
            stored_bytes,
            // An ingested artifact OWNS its bytes, so the two quantities coincide and
            // the logical size is known exactly: it is the bytes just written. This is
            // also precisely the number the display consumers have always shown for a
            // stored artifact, so nothing on screen moves for them.
            logical_bytes: Some(stored_bytes),
            created_by,
            // ITEM-20: a producer can hide a byproduct from the catalog (e.g. the
            // dataset-metadata JSON harvested into datasets.metadata). representation_of
            // (a cross-artifact link) is a later slice — see the ITEM-20 note below.
            hidden: entry.hidden,
            representation_of: None,
        });
    }

    let mut tx = pool.begin().await.map_err(AppError::database_error)?;
    let mut out = Vec::with_capacity(pending.len());
    for a in &pending {
        out.push(CatalogRepository::insert_artifact_in_tx(&mut tx, a).await?);
    }
    tx.commit().await.map_err(AppError::database_error)?;

    // Scope-aware notify-and-refetch so a shared workbench / the dataset owner
    // updates live (ITEM-13/ITEM-23). Background/detached emit → origin None.
    for a in &out {
        match (project_id, dataset_id) {
            (Some(sid), _) => {
                super::sync::publish_artifact(
                    pool,
                    sid,
                    crate::modules::sync::SyncAction::Create,
                    a.id,
                    crate::modules::sync::Actor::detached(),
                )
                .await;
            }
            (None, Some(did)) => {
                super::sync::publish_artifact_for_dataset(
                    pool,
                    did,
                    crate::modules::sync::SyncAction::Create,
                    a.id,
                    crate::modules::sync::Actor::detached(),
                )
                .await;
            }
            (None, None) => {}
        }
    }
    Ok(out)
}

/// A `/outputs`-relative declared path must be non-empty, relative, and free of
/// `..`/`.`/absolute/prefix components — the escape guard so a manifest-supplied
/// `path` can never leave `<staging>/outputs`. `PathBuf::join` REPLACES the base
/// on an absolute component and a `..` walks out, so a raw join of an unvalidated
/// path reads an arbitrary host file (blind-audit MED). Kept local to this write
/// path (no cross-module call); mirrors `sandbox::outputs`' resolver guard.
fn validate_output_rel_path(rel: &str) -> Result<(), AppError> {
    use std::path::Component;
    if rel.trim().is_empty() {
        return Err(AppError::bad_request(
            "OUTPUT_PATH_INVALID",
            "an output entry has an empty path",
        ));
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(AppError::bad_request(
            "OUTPUT_PATH_INVALID",
            format!("output path {rel:?} must be relative to /outputs"),
        ));
    }
    for comp in p.components() {
        // Only plain path segments are allowed. ParentDir/RootDir/Prefix/CurDir
        // are all escape/oddity vectors.
        if !matches!(comp, Component::Normal(_)) {
            return Err(AppError::bad_request(
                "OUTPUT_PATH_INVALID",
                format!("output path {rel:?} may not contain '.', '..', or an absolute/prefix component"),
            ));
        }
    }
    Ok(())
}

/// A declared `structure` must be an OBJECT that NAMES AN ENCODING (artifact-model
/// ITEM-5 / INV-2, and the resolution of a two-layer contradiction).
///
/// ## What was contradictory
///
/// `structure` is `NOT NULL` with no default, so an OMITTED declaration is refused — and
/// `explicit_no_default_test`'s emptiness control pins that the refusal is about ABSENCE,
/// not emptiness: an explicitly-supplied `{}` is a legal jsonb value for that column and
/// round-trips. Fine as a statement about the COLUMN. But `{}` was also accepted here, at
/// the manifest, while the framework conformance gate condemned exactly that shape
/// (`unknown encoding None` → `status = failed`). So a producer could emit a `{}`
/// declaration, watch it ingest cleanly, and have the artifact marked failed moments
/// later by a job it never sees. No test ingested one and then ran the gate, so nothing
/// noticed.
///
/// ## Resolved in ONE direction: `{}` is not a declaration
///
/// The alternative — teach the gate that `{}` means "nothing to declare" — would hand
/// every producer a way to make the gate check nothing, which is the opt-out DEC-8 says
/// cannot exist (and the twin of the `opaque` hole `_lib/conformance.py` now closes). A
/// declaration has to say what the bytes ARE; `{}` says nothing, so it is refused HERE,
/// at the producer-facing surface, where the error names the run that caused it. The gate
/// keeps its own refusal as the backstop for a row that arrived some other way, and the
/// two layers now give the same answer.
///
/// This does not narrow INV-2's emptiness control: `meta: {}` ("no metadata") is still a
/// declaration, and so is the column contract that test asserts.
fn validate_declared_structure(id: &str, structure: &serde_json::Value) -> Result<(), AppError> {
    let object = structure.as_object().ok_or_else(|| {
        AppError::bad_request(
            "BAD_MANIFEST",
            format!(
                "output {id:?} declares a `structure` that is not an object \
                 ({structure}) — a declaration is an object naming an `encoding`"
            ),
        )
    })?;
    match object.get("encoding").and_then(|v| v.as_str()) {
        Some(encoding) if !encoding.trim().is_empty() => Ok(()),
        _ => Err(AppError::bad_request(
            "BAD_MANIFEST",
            format!(
                "output {id:?} declares a `structure` that names no `encoding` — an \
                 empty/encoding-less declaration says nothing about the bytes, so no \
                 reader (and no conformance check) can act on it (INV-2). Declare one, \
                 e.g. {{\"encoding\": \"opaque\", \"media_type\": \"…\"}} for bytes with \
                 no member structure."
            ),
        )),
    }
}

// ── ingest OOM ceilings — now ADMIN SETTINGS (issue #54) ──────────────────────
//
// The single-file ceiling (footgun/OOM guard: `put`/`put_prefix` take OWNED bytes,
// reading the whole payload into memory) and the multi-file aggregate ceiling
// (`put_prefix` holds every member at once) used to be the bare consts
// `MAX_OUTPUT_FILE_BYTES` (8 GiB) / `MAX_MULTIFILE_TOTAL_BYTES` (32 GiB). They are
// now the admin settings `max_output_file_bytes` / `max_multifile_total_bytes`,
// read-at-use once per ingest in `ingest_run_outputs` and passed into
// `store_output` / `collect_dir` as `max_file` / `max_total`. The settings defaults
// EQUAL the old consts (byte-preserving, INV-1) and are SAFETY-BOUNDED (DEC-3): the
// ceilings are admin-tunable only within a bounded range, never raised unbounded.
// The single-file ceiling also caps each multi-file MEMBER.

// ── artifact-model ITEM-15 — the ingest byte-inference is GONE ────────────────────
//
// This block used to hold `infer_shape_multifile` / `infer_shape_single` (plus their
// helpers `sparse_cols_from_members`, `column_envelope` and `table_columns_from_json`,
// and the `COLUMN_ENVELOPE_KEYS` envelope-name constant). They opened a freshly-stored
// payload — `serde_json::from_slice` on a single-file blob, an i64-LE read of a
// multi-file `indptr` member — and DERIVED MEANING from it: a row count, a per-column
// `continuous`/`categorical` classification, a sparse column count. The result was
// written to `artifacts.shape`.
//
// That is exactly what INV-1 forbids — *the server stores and serves; it confines,
// caps, hashes, stores, records and serves bytes, and it never opens a byte for
// meaning*. It was also the last thing in app-core that had to KNOW a domain envelope
// name (`COLUMN_ENVELOPE_KEYS = ["obs"]`, INV-5), so deleting it removes a
// domain-vocabulary literal from the core at the same time.
//
// Nothing replaces it here. What the FE needs is DECLARED by the producer and stored
// verbatim: `structure` (how to decode the bytes — members, dtypes, chunk geometry,
// levels) and `meta` (what they mean, for display). Both arrive on the manifest entry
// with no serde default (ITEM-5/6), so an omitted declaration is an ingest failure
// rather than an inferred guess.

/// Store one declared output — a single file (single blob) or a directory (a
/// multi-file artifact via `put_prefix`). Returns
/// `(object_key, content_hash, is_multifile, stored_bytes)`.
///
/// It takes no `layout` and looks at no byte: the only thing this function decides
/// is WHERE the bytes go (one blob vs a member prefix), and that follows from the
/// filesystem node type, not from the payload (ITEM-15 / INV-1).
///
/// A declared output MUST be a regular file or a directory (blind-audit LOW): a
/// named pipe / socket / device node is refused rather than read (reading a fifo
/// hangs; a device streams unboundedly), and a single file over the per-file
/// ceiling (`max_file`, the admin setting) is refused before it is allocated.
async fn store_output(
    store: &dyn ObjectStore,
    src: &Path,
    max_file: u64,
    max_total: u64,
) -> Result<(String, String, bool, i64), AppError> {
    let meta = tokio::fs::metadata(src).await.map_err(|e| {
        AppError::bad_request(
            "MISSING_OUTPUT",
            format!("declared output {} not found: {e}", src.display()),
        )
    })?;
    if meta.is_dir() {
        let members = collect_dir(src, max_file, max_total).await?;
        let total: i64 = members.iter().map(|(_, b)| b.len() as i64).sum();
        let put = store.put_prefix(&members).await?;
        // Merkle root is a bare hex digest; normalize to the `sha256:<hex>` form
        // used for every content identity in the catalog.
        let content_hash = format!("sha256:{}", put.content_hash);
        Ok((
            put.object_key.as_str().to_string(),
            content_hash,
            true,
            total,
        ))
    } else if meta.is_file() {
        // Refuse a runaway single file BEFORE allocating (a regular file's
        // metadata length is exact).
        if meta.len() > max_file {
            return Err(AppError::bad_request(
                "OUTPUT_TOO_LARGE",
                format!(
                    "declared output {} is {} bytes (max {max_file} for a single-file artifact; use a chunked multi-file layout)",
                    src.display(),
                    meta.len()
                ),
            ));
        }
        let bytes = tokio::fs::read(src)
            .await
            .map_err(|e| AppError::internal_error(format!("read output failed: {e}")))?;
        let key = store.put(&bytes).await?;
        // Single-file content identity = its blob's content key (`sha256:<hex>`).
        Ok((
            key.as_str().to_string(),
            key.as_str().to_string(),
            false,
            bytes.len() as i64,
        ))
    } else {
        // Not a regular file or directory — a named pipe / socket / device node
        // is never a promotable artifact and reading it can hang / stream forever.
        Err(AppError::bad_request(
            "OUTPUT_NOT_REGULAR_FILE",
            format!(
                "declared output {} is not a regular file or directory (named pipe / socket / device refused)",
                src.display()
            ),
        ))
    }
}

/// Recursively collect a directory's files as `(relative-path, bytes)` for a
/// multi-file artifact (e.g. a Zarr chunk-dir). Relative paths use `/`.
async fn collect_dir(
    root: &Path,
    max_file: u64,
    max_total: u64,
) -> Result<Vec<(String, Vec<u8>)>, AppError> {
    let mut out = Vec::new();
    let mut running_total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| AppError::internal_error(format!("readdir failed: {e}")))?;
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| AppError::internal_error(format!("readdir entry failed: {e}")))?
        {
            let path = entry.path();
            let ft = entry
                .file_type()
                .await
                .map_err(|e| AppError::internal_error(format!("filetype failed: {e}")))?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                // Bound each member + the running total BEFORE reading it into
                // memory (blind-audit LOW): `put_prefix` holds every member's bytes
                // at once, so an unbounded member or an unbounded aggregate would
                // OOM the server. `entry.metadata()` does not follow symlinks (and
                // symlinks are skipped below), so the length is the real file's.
                let mlen = entry
                    .metadata()
                    .await
                    .map_err(|e| AppError::internal_error(format!("member metadata failed: {e}")))?
                    .len();
                if mlen > max_file {
                    return Err(AppError::bad_request(
                        "OUTPUT_TOO_LARGE",
                        format!(
                            "multi-file member {} is {mlen} bytes (max {max_file} per member)",
                            path.display()
                        ),
                    ));
                }
                running_total = running_total.saturating_add(mlen);
                if running_total > max_total {
                    return Err(AppError::bad_request(
                        "OUTPUT_TOO_LARGE",
                        format!(
                            "multi-file artifact under {} exceeds {max_total} bytes total",
                            root.display()
                        ),
                    ));
                }
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = tokio::fs::read(&path)
                    .await
                    .map_err(|e| AppError::internal_error(format!("read member failed: {e}")))?;
                out.push((rel, bytes));
            }
            // symlinks/other are ignored (not promoted).
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // blind-audit MED: the write-path escape guard accepts a plain `/outputs`-
    // relative path and rejects every escape vector (empty, absolute, `..`, `.`,
    // absolute-nested) BEFORE any `join`/read — so a manifest-supplied `path` can
    // never leave `<staging>/outputs`.
    #[test]
    fn validate_output_rel_path_rejects_escapes() {
        assert!(validate_output_rel_path("umap.zarr").is_ok());
        assert!(validate_output_rel_path("sub/dir/x.bin").is_ok());

        for bad in [
            "",
            "   ",
            "/etc/passwd",
            "../secret",
            "a/../../etc",
            "./x",
            "..",
        ] {
            let err =
                validate_output_rel_path(bad).expect_err(&format!("{bad:?} must be rejected"));
            assert_eq!(err.error_code(), "OUTPUT_PATH_INVALID", "for {bad:?}");
        }
    }

    // The `{}` resolution (see [`validate_declared_structure`]). `structure` must be an
    // object that NAMES an encoding; the framework conformance gate condemns exactly the
    // shapes refused here (`_lib/conformance.py` → "structure declares no `encoding`",
    // covered by `test_a_structure_that_names_no_encoding_is_not_a_declaration` and
    // `test_an_encodingless_structure_is_condemned_by_the_production_entry`). The two
    // layers previously disagreed — ingest accepted `{}` and the gate failed the artifact
    // for it, with no test on either side of the seam.
    #[test]
    fn validate_declared_structure_requires_an_encoding() {
        // POSITIVE CONTROL first: the shapes real producers emit must pass, or every
        // rejection below could be "this function refuses everything".
        for good in [
            serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            serde_json::json!({ "encoding": "zarr_v3", "kind": "table", "n": 4 }),
        ] {
            validate_declared_structure("out", &good).expect("a declared encoding is accepted");
        }

        // `{}` is the case the two layers disagreed about; the rest are the same absence
        // wearing different clothes.
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "media_type": "text/html" }),
            serde_json::json!({ "encoding": null }),
            serde_json::json!({ "encoding": "" }),
            serde_json::json!({ "encoding": "   " }),
            serde_json::json!({ "encoding": 3 }),
            serde_json::json!("opaque"),
            serde_json::json!(null),
        ] {
            let err = validate_declared_structure("out", &bad)
                .expect_err(&format!("{bad} must be refused"));
            assert_eq!(err.error_code(), "BAD_MANIFEST", "for {bad}");
            let message = serde_json::to_value(&err).expect("AppError serializes")["message"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            assert!(
                message.contains("encoding") && message.contains("out"),
                "the refusal must name the field AND the output it belongs to: {message}"
            );
        }
    }

    use crate::modules::workstore::object_store::local_fs::LocalFsStore;

    fn tmp_store() -> (PathBuf, LocalFsStore) {
        let dir = std::env::temp_dir().join(format!("cyto-ingest-store-{}", Uuid::new_v4()));
        (dir.clone(), LocalFsStore::new(dir))
    }

    // blind-audit LOW: a normal regular file stores; a single file over the
    // per-file ceiling is refused BEFORE it is read into memory (metadata length
    // is exact for a regular file, so the guard never allocates the file).
    #[tokio::test]
    async fn store_output_stores_small_file_and_refuses_oversize() {
        let (dir, store) = tmp_store();
        let work = std::env::temp_dir().join(format!("cyto-ingest-src-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&work).await.unwrap();

        // The default ingest ceilings (== the old consts, INV-1) drive the guard.
        let d = crate::modules::workstore::settings::WorkstoreSettings::defaults();
        let max_file = d.max_output_file_bytes_u64();
        let max_total = d.max_multifile_total_bytes_u64();

        // A small regular file stores fine (single-file blob).
        let ok = work.join("small.bin");
        tokio::fs::write(&ok, b"\x01\x02\x03\x04").await.unwrap();
        let (_key, hash, is_multi, size) = store_output(&store, &ok, max_file, max_total)
            .await
            .expect("small file stores");
        assert!(hash.starts_with("sha256:"));
        assert!(!is_multi);
        assert_eq!(size, 4);

        // A sparse file whose declared length exceeds the ceiling is refused
        // (set_len does not allocate blocks; the guard reads only metadata).
        let big = work.join("huge.bin");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(max_file + 1).unwrap();
        drop(f);
        let err = store_output(&store, &big, max_file, max_total)
            .await
            .expect_err("oversize file refused");
        assert_eq!(err.error_code(), "OUTPUT_TOO_LARGE");

        let _ = tokio::fs::remove_dir_all(&work).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    // blind-audit LOW: a non-regular node (named pipe) under /outputs is refused
    // rather than read — reading a fifo would hang the ingest indefinitely.
    #[cfg(unix)]
    #[tokio::test]
    async fn store_output_refuses_named_pipe() {
        let (dir, store) = tmp_store();
        let work = std::env::temp_dir().join(format!("cyto-ingest-fifo-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&work).await.unwrap();
        let fifo = work.join("pipe");
        let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: mkfifo on a fresh path in a private temp dir; libc is linked on unix.
        let rc = unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
        assert_eq!(rc, 0, "mkfifo created the test named pipe");

        let d = crate::modules::workstore::settings::WorkstoreSettings::defaults();
        let err = store_output(&store, &fifo, d.max_output_file_bytes_u64(), d.max_multifile_total_bytes_u64())
            .await
            .expect_err("fifo refused");
        assert_eq!(err.error_code(), "OUTPUT_NOT_REGULAR_FILE");

        let _ = tokio::fs::remove_dir_all(&work).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
