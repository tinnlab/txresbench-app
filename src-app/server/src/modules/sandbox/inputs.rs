//! Content-addressed input materialization + the derived `inputs.json` (ITEM-14 /
//! DEC-I).
//!
//! The host resolves each declared input (a P1 catalog artifact id OR a trusted
//! server-side host path) into a file under `<workspace>/inputs/<name>`,
//! read-only-binds it at `/inputs/<name>`, and writes `/inputs/inputs.json`
//! referencing inputs by **content HASH + kind** (path-agnostic — the same fetch
//! a remote backend would do), plus `/inputs/params.json`. `inputs.json` is
//! DERIVED (slots→mounts for this run), never authoritative.
//!
//! ## Where `<name>` comes from (ITEM-23 / DEC-9)
//!
//! For an **artifact-backed** input the name is DERIVED from the artifact
//! ([`super::spec::derive_artifact_mount_name`]) — the slot plus the store form the
//! artifact itself declares (`is_multifile` + `structure.encoding`). It used to come
//! from a manifest string (`run: { inputs: { matrix: matrix.<ext> } }`) that existed
//! only so a compute could sniff its input's format off the suffix. Format is a
//! property of the ARTIFACT, which the runner is holding at this exact point; and the
//! shipped declaration was already wrong — the artifact it named is a MULTI-FILE Zarr
//! store, so `matrix.<ext>` named a DIRECTORY as a single-file blob and routed a store
//! into a single-file reader.
//!
//! For a **user file** (`dataset_file_ref` / `host_path`) there is no artifact to ask,
//! and the uploaded basename is load-bearing (the importer is the one step whose input
//! genuinely is a file of unknown format), so its declared `sandbox_subpath` stands.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sqlx::SqlitePool;
use ziee_core::AppError;

use super::backend::ComputeSpec;
use super::spec::AnalysisSpec;
use super::types::{ExtraMount, MountMode};
use crate::modules::workstore::object_store::{BlobLink, ContentKey, ObjectStore};

/// A resolved, on-disk input ready to bind read-only into the sandbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedInput {
    pub slot: String,
    /// The SOURCE kind of this input — the `inputs.json` `kind` field: one of
    /// `artifact` (single-blob workstore), `artifact-prefix` (multi-file workstore
    /// dir), `dataset-file` (a ziee-file Dataset file), or `host` (a trusted host
    /// path). Path-agnostic (ITEM-5).
    pub kind: String,
    /// Absolute host path under `<workspace>/inputs` (a file, or — for a multi-file
    /// prefix — the staged directory).
    pub host_path: PathBuf,
    /// The in-sandbox bind target (`/inputs/<subpath>`).
    pub sandbox_path: String,
    /// The path-agnostic content identity — `sha256:<hex>` (single file) or
    /// `sha256:<merkle_root>` (a multi-file prefix).
    pub content_hash: String,
}

/// The `inputs.json` wire shape (referenced by hash + kind, NOT host path).
#[derive(Debug, Clone, Serialize)]
struct InputsJson<'a> {
    inputs: Vec<InputsJsonEntry<'a>>,
}

#[derive(Debug, Clone, Serialize)]
struct InputsJsonEntry<'a> {
    slot: &'a str,
    kind: &'a str,
    content_hash: &'a str,
    sandbox_path: &'a str,
}

fn mat_err(msg: impl Into<String>) -> AppError {
    AppError::internal_error(msg.into())
}

/// Serialize the DERIVED `inputs.json` bytes (deterministic — slot order
/// preserved; only hash + kind + sandbox path, never a host path). Pure +
/// unit-testable.
pub fn render_inputs_json(inputs: &[MaterializedInput]) -> Vec<u8> {
    let entries: Vec<InputsJsonEntry> = inputs
        .iter()
        .map(|i| InputsJsonEntry {
            slot: &i.slot,
            // `kind` is the input's SOURCE kind (artifact / artifact-prefix /
            // dataset-file / host) — path-agnostic; the datatype vocab is P2's.
            kind: &i.kind,
            content_hash: &i.content_hash,
            sandbox_path: &i.sandbox_path,
        })
        .collect();
    serde_json::to_vec_pretty(&InputsJson { inputs: entries }).unwrap_or_else(|_| b"{}".to_vec())
}

/// The `/inputs`-relative mount NAME prefix every entry in `inputs.json` carries.
const SANDBOX_INPUTS_PREFIX: &str = "/inputs/";

/// Read the `(slot, mount NAME)` pairs back out of the `inputs.json` bytes
/// [`render_inputs_json`] wrote — the RECORD of where this run's inputs were bound.
///
/// The inverse of `render_inputs_json`, kept beside it so the two cannot describe
/// different wire shapes. Pure + unit-testable; malformed input yields an empty list
/// (the caller degrades rather than failing a finished run).
///
/// `sandbox_path` is stored absolute (`/inputs/<name>`); the NAME is what every
/// consumer wants (a capsule re-binds it under its own `/inputs`), so the prefix is
/// stripped here. An entry that does not carry it is skipped rather than guessed at —
/// `materialize_inputs` cannot produce one, so its appearance would mean a shape this
/// function does not understand.
pub fn parse_recorded_mount_names(bytes: &[u8]) -> Vec<(String, String)> {
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Vec::new();
    };
    let Some(arr) = doc.get("inputs").and_then(|i| i.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|e| {
            let slot = e.get("slot")?.as_str()?.to_string();
            let name = e
                .get("sandbox_path")?
                .as_str()?
                .strip_prefix(SANDBOX_INPUTS_PREFIX)?;
            (!name.is_empty()).then(|| (slot, name.to_string()))
        })
        .collect()
}

/// [`parse_recorded_mount_names`] over a run workspace's `<inputs_dir>/inputs.json`.
///
/// `None` = the file is not there to read (an already-reclaimed workspace, or a
/// foreign/legacy finalize). That is a DIFFERENT answer from `Some(vec![])` — a run
/// that genuinely staged no inputs — so a caller can tell "no record" from "no
/// inputs" and only fall back in the first case. Blocking I/O by design: the one
/// caller (the provenance recorder) already reads the staged entry script the same
/// way, in the same finalize.
pub fn recorded_mount_names(inputs_dir: &Path) -> Option<Vec<(String, String)>> {
    let bytes = std::fs::read(inputs_dir.join("inputs.json")).ok()?;
    Some(parse_recorded_mount_names(&bytes))
}

/// The two DERIVED per-run input files (`inputs.json` + `params.json`) that
/// [`materialize_inputs`] writes into `<inputs_dir>` — the names an entry script
/// reads at `/inputs/<name>`.
pub const DERIVED_INPUT_FILES: [&str; 2] = ["inputs.json", "params.json"];

/// The read-only `ExtraMount` binds for a set of materialized inputs, PLUS the two
/// derived files (`/inputs/inputs.json` + `/inputs/params.json`). Pure.
///
/// **The derived binds are not optional decoration — they are the params
/// contract.** The sandbox binds `/inputs` file-by-file (never the workspace dir),
/// so before this every processor ran with `/inputs/params.json` ABSENT: each
/// script's `read_json(inputs/params.json, {})` silently returned `{}` and the run
/// executed on defaults only. A filtering processor therefore committed an all-pass
/// mask for EVERY run, and `load_inputs_index` fell back to a filename glob instead
/// of the declared slot map. Found while landing the G3 capsule fix:
/// the capsule's `run.sh` regenerates both files into a bound `$STEP/inputs` dir,
/// so the REPLAY honored params the live run never received.
///
/// A derived file is bound only when it exists on disk, so a caller that staged
/// no inputs dir (or a future backend that binds the dir wholesale) is unaffected.
pub fn input_mounts(inputs: &[MaterializedInput], inputs_dir: &Path) -> Vec<ExtraMount> {
    let mut mounts: Vec<ExtraMount> = inputs
        .iter()
        .map(|i| ExtraMount {
            host_path: i.host_path.clone(),
            sandbox_path: i.sandbox_path.clone(),
            mode: MountMode::ReadOnly,
        })
        .collect();
    for name in DERIVED_INPUT_FILES {
        let host_path = inputs_dir.join(name);
        if host_path.is_file() {
            mounts.push(ExtraMount {
                host_path,
                sandbox_path: format!("/inputs/{name}"),
                mode: MountMode::ReadOnly,
            });
        }
    }
    mounts
}

/// `spec.params ∪ {"seed": N}` — the EXACT `/inputs/params.json` body the sandbox
/// writes, and the single source of truth the provenance reproduce-capsule
/// regenerates from (`export::reproduce_script::render_step`, ITEM-3). Sharing one
/// function is what makes the two byte-identical by construction instead of by
/// convention.
///
/// `seed` is merged in LAST (so it wins) and is NEVER `null`: the run's own seed,
/// else a seed the params object already carries, else `0`. A `null` here is a
/// latent crash now that the file is actually MOUNTED — every entry script does
/// `int(params["seed"])`, and before the derived binds landed no script ever read
/// this body at all.
pub fn params_json_value(params: &serde_json::Value, seed: Option<i64>) -> serde_json::Value {
    let mut map = match params {
        serde_json::Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };
    let resolved = seed
        .or_else(|| map.get("seed").and_then(serde_json::Value::as_i64))
        .unwrap_or(0);
    map.insert("seed".to_string(), serde_json::json!(resolved));
    serde_json::Value::Object(map)
}

/// Materialize every declared input into `<inputs_dir>` and return the resolved
/// set. Every input ref is AUTHORIZED against `owner_id` (the JOB OWNER) before a
/// single byte is staged — this is the security chokepoint both create paths
/// (`POST /jobs` and `POST /datasets/{id}/process`) funnel through, so a
/// cross-user `artifact_ref`/`dataset_file_ref` is rejected here (the job fails
/// safely; another user's bytes never reach the sandbox — FIX-1 IDOR). A trusted
/// `host_path` input is gated through the SAME reference-mount `allowlist` (empty
/// by default ⇒ refused): host paths belong in the admin allowlist, never as a
/// free user input. `artifact_ref` inputs are fetched (single-blob or prefix) from
/// P1's content-addressed store. Writes `inputs.json` + `params.json` into
/// `<inputs_dir>`.
///
/// **ITEM-16 scope.** Artifact inputs (`artifact_ref` / `dataset_axis_index`,
/// single-blob and multi-file alike) are HARDLINKED out of the content-addressed
/// pool — see [`Stager`]. Two other input kinds still copy, deliberately, and it
/// is worth saying why so the next reader does not read it as an oversight:
///
/// * `dataset_file_ref` reads through ziee-file's storage seam, which is a
///   different store with no content address and no local-path capability. Giving
///   it one is that module's change, not this one's.
/// * `host_path` copies BECAUSE it hashes: an admin-allowlisted reference path has
///   no content address, so its identity can only come from reading the bytes. A
///   deployment that wants a large reference tree zero-copy already has the right
///   mechanism — declare it as a reference `extra_mount`, which binds it read-only
///   in place and stages nothing.
pub async fn materialize_inputs(
    spec: &AnalysisSpec,
    inputs_dir: &Path,
    owner_id: uuid::Uuid,
    allowlist: &[PathBuf],
    pool: &SqlitePool,
    store: &dyn ObjectStore,
) -> Result<Vec<MaterializedInput>, AppError> {
    tokio::fs::create_dir_all(inputs_dir)
        .await
        .map_err(|e| mat_err(format!("create inputs dir: {e}")))?;

    let mut out = Vec::with_capacity(spec.inputs.len());
    // Every mount name already taken by this run. Slot names are not unique by
    // construction (nothing rejects two inputs on one slot), and now that the name is
    // DERIVED from the slot a collision would silently stage the second input over the
    // first. `unique_mount_name` disambiguates deterministically instead.
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for decl in &spec.inputs {
        // ITEM-23: an artifact-backed input's mount name is derived from the ARTIFACT,
        // so the artifact is resolved (fetched + AUTHORIZED + conformance-gated) BEFORE
        // a host path is chosen. Authorization therefore still happens before a single
        // byte is staged — it moved earlier, not later.
        let artifact = if let Some(artifact_id) = decl.artifact_ref {
            // A workstore catalog artifact — single-blob OR a multi-file prefix.
            // Authorized against the job owner (project Viewer+ / dataset visibility).
            Some(resolve_artifact(pool, artifact_id, owner_id).await?)
        } else if let Some(axis_ref) = &decl.dataset_axis_index {
            // A dataset's per-axis entity-INDEX (ITEM-12 / DEC-7): resolve the
            // `metadata-column` artifact scoped to the dataset for this axis by its
            // DECLARATION — `meta @> {"is_axis_index": true}` + `structure->>'axis'`
            // (INV-3: an axis is identified by its key artifact, never by a name) —
            // then stage its members via the SAME authorized `artifact_ref` fetch path
            // (job-owner artifact-read).
            Some(resolve_axis_index(pool, axis_ref, owner_id).await?)
        } else {
            None
        };

        let name = match &artifact {
            Some(a) => super::spec::derive_artifact_mount_name(&decl.slot, &a.structure),
            // No artifact to ask: a USER FILE, whose declared basename is the format
            // signal the importer legitimately reads. Falls back to the slot.
            None => decl.declared_mount_name(),
        };
        let name = unique_mount_name(name, &mut used);
        // Belt and braces: the derived name is built from a SANITIZED slot and a
        // declared one was guarded at parse, so this can only fire on a future
        // derivation bug — which must not be the thing that escapes `/inputs`.
        super::spec::validate_subpath(&name, "input mount name")?;

        let dest = inputs_dir.join(&name);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| mat_err(format!("create input subdir: {e}")))?;
        }

        let (content_hash, kind) = if let Some(a) = &artifact {
            // The SLOT is only in scope HERE, and the error is about to cross a
            // boundary that keeps nothing but the message (the runner's
            // `materialize_inputs(..).map_err(|e| e.to_string())`), so the diagnosis
            // is composed at this line or it is not composed at all. See
            // [`describe_artifact_staging_failure`].
            stage_resolved_artifact(pool, store, a, &dest)
                .await
                .map_err(|e| describe_artifact_staging_failure(&decl.slot, a, e))?
        } else if let Some(file_id) = decl.dataset_file_ref {
            // A Dataset file in ziee-file (one file; a one-or-many dataset is
            // declared as one `dataset_file_ref` input per file). Authorized against
            // the job owner (owns it ∪ visible via a dataset).
            (
                stage_dataset_file(pool, file_id, owner_id, &dest).await?,
                "dataset-file".to_string(),
            )
        } else if let Some(host_path) = &decl.host_path {
            // A trusted host_path input is only permitted when it resolves under an
            // admin-allowlisted reference-mount root (FIX-1: an arbitrary host_path
            // input could otherwise stage a secret for exfil). Bind the CANONICAL
            // path, then stream the copy + hash (never buffer a multi-GB matrix).
            let canon =
                crate::modules::sandbox::spec::canonicalize_under_allowlist(host_path, allowlist)?;
            (copy_and_hash(&canon, &dest).await?, "host".to_string())
        } else {
            // Unreachable — validate() rejected this — but fail loud not silent.
            return Err(mat_err(format!("input slot {:?} has no source", decl.slot)));
        };

        out.push(MaterializedInput {
            slot: decl.slot.clone(),
            kind,
            host_path: dest,
            sandbox_path: format!("/inputs/{name}"),
            content_hash,
        });
    }

    // Derived inputs.json + params.json (the seed/params the script may read).
    tokio::fs::write(inputs_dir.join("inputs.json"), render_inputs_json(&out))
        .await
        .map_err(|e| mat_err(format!("write inputs.json: {e}")))?;
    // params.json = the processor's DECLARED params (whatever its manifest declares —
    // the core never interprets them) with the run `seed` merged in; the entry script
    // reads BOTH from
    // /inputs/params.json (ITEM-18 last mile: the FE's `spec.params` used to be
    // dropped, so every processor ran with defaults only). `input_mounts` BINDS
    // this file at /inputs/params.json — writing it here is only half the contract.
    let params = params_json_value(&spec.params, spec.seed);
    tokio::fs::write(
        inputs_dir.join("params.json"),
        serde_json::to_vec_pretty(&params).unwrap_or_default(),
    )
    .await
    .map_err(|e| mat_err(format!("write params.json: {e}")))?;

    Ok(out)
}

/// Stream a source file to `dest` while computing its `sha256:<hex>` — chunked,
/// so a multi-GB input is never fully buffered in RAM (D3). Returns the hash.
///
/// #182: the loop itself now lives in `modules::file::stream::copy_file_hashing`,
/// because the DATASET staging path needs the identical loop and two copies of it
/// is the duplication class the `Stager` doc-comment below warns about. This wrapper
/// keeps the materialization error framing (`mat_err`) that the job-failure surface
/// reads.
async fn copy_and_hash(src: &std::path::Path, dest: &std::path::Path) -> Result<String, AppError> {
    let hex = crate::modules::file::stream::copy_file_hashing(src, dest)
        .await
        .map_err(|e| mat_err(format!("materialize input: {e}")))?;
    // hex::encode — identical to `object_store::sha256_hex`, so a streamed hash
    // equals the buffered one byte-for-byte.
    Ok(format!("sha256:{hex}"))
}

/// Why an input's bytes had to be COPIED instead of hardlinked. Kept distinct
/// because the two want different log levels: one is a permanent property of the
/// deployment's backend, the other is an operator-fixable surprise.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CopyReason {
    /// The object store keeps no local blobs (S3 / any remote backend). Expected
    /// and structural — not a warning.
    RemoteBackend,
    /// The store is local but the link failed — almost always `EXDEV`, the blob
    /// pool and the sandbox workspace on different mounts. Operator-actionable.
    LinkFailed(String),
}

/// Stages blob bytes onto the host for one input, **hardlinking from the
/// content-addressed pool wherever it can and copying only where it must**
/// (ITEM-16: job inputs are "bound or hardlinked, never copied").
///
/// The hardlink is not merely faster. The staged file IS the pooled blob — one
/// inode — so it cannot drift from the artifact it names, and a job taking a
/// multi-GB expression matrix stops writing a full second copy of it and stops
/// doubling peak disk during staging.
///
/// It exists as a struct, and both `stage_artifact` branches go through it,
/// because the defect it replaces was the SAME `get`-then-`write` written out
/// twice: one shared path is what stops the next edit fixing only one of them.
/// It also carries the two things a per-file helper cannot:
///
/// * a **tally**, so a 19k-member Zarr reports its staging in ONE line rather
///   than 19k, and
/// * a **give-up flag**, so once this store has proven it cannot link into this
///   directory we stop asking it 19k more times.
struct Stager<'a> {
    store: &'a dyn ObjectStore,
    linked: usize,
    copied: usize,
    /// Set on the first copy; also the "stop trying to link" latch.
    reason: Option<CopyReason>,
}

impl<'a> Stager<'a> {
    fn new(store: &'a dyn ObjectStore) -> Self {
        Self {
            store,
            linked: 0,
            copied: 0,
            reason: None,
        }
    }

    /// Put the stored bytes of `key` at `dest`.
    async fn stage(&mut self, key: &ContentKey, dest: &Path) -> Result<(), AppError> {
        // Once one link failed, every later one fails the same way (same store,
        // same destination filesystem) — don't buy 19k more failing syscalls.
        let reason = if let Some(known) = &self.reason {
            known.clone()
        } else {
            match self.store.link_blob(key, dest).await {
                BlobLink::Linked => {
                    self.linked += 1;
                    return Ok(());
                }
                BlobLink::Unsupported => CopyReason::RemoteBackend,
                BlobLink::Unavailable { reason } => CopyReason::LinkFailed(reason),
            }
        };

        // The copy floor. STREAMED, not `store.get()`-then-`write`: buffering a
        // multi-GB blob whole is the RAM half of the same mistake the second copy
        // on disk is the disk half of. `u64::MAX` is "to end of blob" — `get_stream`
        // clamps at the end rather than erroring — so this needs no extra `stat`.
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut stream = self.store.get_stream(key, 0, u64::MAX).await?;
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| mat_err(format!("create materialized input: {e}")))?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| mat_err(format!("read input blob: {e}")))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| mat_err(format!("write materialized input: {e}")))?;
        }
        file.flush()
            .await
            .map_err(|e| mat_err(format!("flush materialized input: {e}")))?;

        self.copied += 1;
        self.reason.get_or_insert(reason);
        Ok(())
    }

    /// Emit exactly ONE line describing how this input reached the host.
    ///
    /// The `LinkFailed` arm is the reason this method exists: a fallback that
    /// logged nothing would leave the deployment doing precisely what ITEM-16
    /// removed — copying every input — while every test and every doc claimed it
    /// was hardlinking. Silence is the failure mode here, not noise.
    fn report(&self, dest: &Path) {
        match &self.reason {
            None => tracing::debug!(
                dest = %dest.display(),
                files = self.linked,
                "sandbox.inputs: staged by hardlink from the blob pool (no bytes copied)"
            ),
            Some(CopyReason::RemoteBackend) => tracing::debug!(
                dest = %dest.display(),
                files = self.copied,
                "sandbox.inputs: object store keeps no local blobs; staged by copy"
            ),
            Some(CopyReason::LinkFailed(reason)) => tracing::warn!(
                dest = %dest.display(),
                copied = self.copied,
                linked = self.linked,
                reason = %reason,
                "sandbox.inputs: could not hardlink from the blob pool, so this input \
                 was COPIED in full (doubling its disk use for the run). The usual cause \
                 is the workstore blob pool and the sandbox workspace sitting on \
                 different filesystems — put them on the same mount to restore \
                 zero-copy staging"
            ),
        }
    }
}

/// A mount name not already taken by this run.
///
/// ## Why a repeated name is not a caller error to reject
///
/// A slot may legitimately carry MANY bindings (`appliesTo: { multiple: true }` — a
/// `matrices` slot takes one artifact per selection in ONE job), and
/// [`super::spec::derive_artifact_mount_name`] is a pure function of the slot and the
/// declared encoding, so every one of those bindings derives the IDENTICAL name. Without
/// this the second staging would overwrite the first and `inputs.json` would record
/// several entries sharing one `sandbox_path` — read naively, one artifact several times.
/// That is the worst available failure: no error, no missing file, just modality B's
/// numbers silently being modality A's.
///
/// ## The scheme, and the two choices in it
///
/// **The FIRST binding of a name keeps it bare**; each later one gets `_<ordinal>`
/// inserted BEFORE the store suffix (`matrices.zarr` → `matrices_1.zarr`, never
/// `matrices.zarr_1` — a Zarr reader opens `*.zarr`, and a suffix nothing recognises is
/// how the ITEM-23 defect looked from inside the sandbox).
///
/// Bare-first, rather than an ordinal on every binding, because the ordinal exists to
/// separate SIBLINGS and a lone binding has none: `/inputs/matrices.zarr` is what the
/// slot means, it is what every single-binding run (the overwhelming majority, and every
/// conformance-gate target, whose "slot" is a unique artifact UUID) already mounts, and
/// `_0` on all of them would be noise attached to the common case to serve the rare one.
/// The usual objection — "a name whose shape depends on how many siblings exist is a
/// trap" — does not apply: the first binding is bare whether or not siblings follow, so
/// no name changes because a sibling was added after it.
///
/// The ordinal counts OCCURRENCES OF THIS NAME, not the input's position in the whole
/// spec. Both are deterministic and order-carrying, but a per-spec index makes
/// `matrices_4.zarr` mean "the input at spec position 4" — which reads as "the fifth
/// matrix" and, worse, moves when an UNRELATED input is inserted earlier in the spec.
/// Counting occurrences makes the ordinal mean exactly what a reader assumes: `_1` is the
/// second binding of that name.
///
/// Assignment is therefore a function of BINDING ORDER, which is load-bearing rather than
/// cosmetic: a compute aligns its per-binding params (`params.matrix_modalities`) with
/// the slot's bindings BY POSITION, so any identity-keyed scheme (a content hash, the
/// artifact UUID, a set iteration) would produce distinct-but-misaligned mounts — the
/// same silent-wrong-answer class, one layer down.
fn unique_mount_name(name: String, used: &mut std::collections::HashSet<String>) -> String {
    let mut candidate = name;
    if used.contains(&candidate) {
        let (stem, ext) = match candidate.split_once('.') {
            Some((s, e)) => (s.to_string(), format!(".{e}")),
            None => (candidate.clone(), String::new()),
        };
        let mut n = 1usize;
        loop {
            let next = format!("{stem}_{n}{ext}");
            if !used.contains(&next) {
                candidate = next;
                break;
            }
            n += 1;
        }
    }
    used.insert(candidate.clone());
    candidate
}

/// Fetch a P1 catalog artifact, AUTHORIZE it against the job owner, and pass it
/// through the conformance gate — everything that must be true before its bytes (or
/// its NAME, ITEM-23) are used. Split out of the former `stage_artifact` so the
/// runner can derive the mount name from the artifact BEFORE choosing a host path.
async fn resolve_artifact(
    pool: &SqlitePool,
    artifact_id: uuid::Uuid,
    owner_id: uuid::Uuid,
) -> Result<crate::modules::workstore::consume::ConsumableArtifact, AppError> {
    use crate::modules::workstore::catalog::repository::CatalogRepository;
    let artifact = CatalogRepository::new(pool.clone())
        .get_any_status(artifact_id)
        .await?
        .ok_or_else(|| AppError::not_found("input artifact"))?;

    // SECURITY (FIX-1 IDOR): the JOB OWNER must be able to READ this artifact by
    // its own tenancy scope (project Viewer+ / dataset owner∪share). A cross-user
    // artifact ref is rejected here (foreign scope → 404) → the job fails safely,
    // never staging another user's bytes.
    crate::modules::workstore::authz::require_artifact_read(pool, &artifact, owner_id)
        .await
        .map_err(|(_, e)| e)?;

    // ITEM-18 / DEC-12 — the READ half of the conformance gate. An artifact the gate
    // condemned has bytes that disagree with the `structure` its producer declared, and a
    // processor stages inputs by exactly that declaration. Feeding it in produces a run
    // that succeeds, emits plausible numbers, and records a clean lineage over data nobody
    // could tell was wrong — the silent-wrong outcome, which is strictly worse than a job
    // that fails with a reason. So the job fails here, with one.
    //
    // AFTER the authz check, deliberately: the refusal names the artifact, so a caller
    // outside its tenancy scope must meet the 404 first (no existence oracle).
    crate::modules::workstore::consume::ConsumableArtifact::try_new(artifact)
}

/// The HTTP status an [`ObjectStore`] answers with when a blob is genuinely ABSENT,
/// as opposed to unreadable. Stated as the status rather than the `RESOURCE_NOT_FOUND`
/// error code because the seam's contract is written in those terms — `get_stream`
/// "resolves existence EAGERLY" so the byte plane can answer a clean 404, and
/// `LocalFsStore::map_blob_io_err` maps ENOENT here and **everything else** to a 500
/// precisely so "a transient failure must never be able to present itself as an
/// absence". Any future backend that honours the same contract is covered without
/// having to reuse this crate's error-code spelling.
const BLOB_ABSENT_STATUS: u16 = 404;

/// Turn a failure to stage an artifact's bytes into a sentence a USER can act on.
///
/// ## The defect this exists to remove
///
/// A run whose input artifact had a dangling blob failed with the whole of
/// `Blob not found` — that string, alone, in the job card, the run console and the
/// SSE frame, because they all render the one `jobs.error` column. It is a true
/// statement about a `File::open` and a useless one about a job: it names neither
/// which of the run's inputs failed, nor which artifact that input was bound to, nor
/// whether the user should re-import or simply retry. The identical string also
/// stood for a read that failed for some OTHER reason, so the two outcomes with
/// opposite remedies were indistinguishable.
///
/// ## Why the message is composed HERE
///
/// Everything it needs is in scope at exactly one place. The SLOT belongs to the
/// declaration being materialized and exists nowhere below this frame; the artifact's
/// id / datatype / multi-file-ness belong to the row this loop already resolved. One
/// frame further up (`jobs::runner::stage_and_launch`) the error is flattened with
/// `.map_err(|e| e.to_string())`, which keeps the message and discards the status, the
/// error code and the details — so a later reconstruction would have neither the
/// context nor the absent-vs-unreadable bit left to work from. Composing at the top of
/// the store instead would be worse in the other direction: `LocalFsStore` knows a key,
/// not a slot.
///
/// ## Absence and read-failure do not share a message
///
/// They are distinguishable, and already were — the store separates them and
/// documents why (see [`BLOB_ABSENT_STATUS`]). Within a `stage_resolved_artifact`
/// call a 404 can only have come from a blob read, since every other refusal on that
/// path (`create input prefix dir`, `corrupt manifest blob`, `guard_member_path`,
/// the write/flush arms of `Stager::stage`) is an `internal_error`. So the 404 arm
/// may state absence outright, and the other arm deliberately does NOT diagnose:
/// it prepends the slot and the artifact and then repeats the original message
/// verbatim, because it does not know what went wrong and guessing would put this
/// function in the business the bare string was already failing at.
///
/// ## What it does not say
///
/// Not the object key. A `sha256:…` is not something a user can act on, and it is the
/// one part of this that a UI would truncate anyway — so it goes to the log line below,
/// alongside the underlying error, where an operator correlating with
/// `workstore.gc`'s manifest complaint will look for it.
///
/// ## The result deliberately carries the 500, not the 404
///
/// Both arms return `mat_err`, so the store's 404 does not survive. That is intended and
/// costs nothing: the only production caller stringifies this (`jobs::runner`), and every
/// other refusal `materialize_inputs` produces is an `internal_error` already, so the
/// function keeps ONE status. It is also the truthful one — a catalog row pointing at a
/// blob that is not in the pool is a server-side integrity fault, not a client asking for
/// something that does not exist. A future caller that DID answer HTTP from here would
/// want the 500.
fn describe_artifact_staging_failure(
    slot: &str,
    artifact: &crate::modules::workstore::consume::ConsumableArtifact,
    err: AppError,
) -> AppError {
    let absent = err.status_code() == BLOB_ABSENT_STATUS;
    let shape = if artifact.is_multifile {
        "a multi-file artifact"
    } else {
        "a single-file artifact"
    };

    tracing::error!(
        slot = %slot,
        artifact_id = %artifact.id,
        datatype = %artifact.datatype,
        is_multifile = artifact.is_multifile,
        // A gathered artifact has no key to log; say so rather than omit the field.
        object_key = artifact.object_key.as_deref().unwrap_or("<gathered: no stored bytes>"),
        content_hash = %artifact.content_hash,
        absent,
        error = %err,
        "sandbox.inputs: could not stage an input artifact's bytes"
    );

    if absent {
        // The bytes, NOT the row: saying "artifact not found" here would send the user
        // looking for a catalog entry that is sitting right in front of them.
        mat_err(format!(
            "input slot {slot:?} is bound to artifact {id} ({datatype}, {shape}), but its \
             stored bytes are MISSING from the object store. The catalog row is intact — \
             it is the blob it names that is gone, so there is nothing to stage. This is \
             an absence, not a read that failed, so re-running will fail the same way: \
             re-import or re-produce this artifact (and check the server log for the \
             object key), then run again.",
            id = artifact.id,
            datatype = artifact.datatype,
        ))
    } else {
        mat_err(format!(
            "staging input slot {slot:?}, bound to artifact {id} ({datatype}, {shape}), \
             failed: {err}",
            id = artifact.id,
            datatype = artifact.datatype,
        ))
    }
}

/// Stage an ALREADY-resolved artifact into `dest`, returning `(content_hash, kind)`.
/// A single-blob artifact → one file at `dest` (kind `artifact`). A multi-file
/// artifact (Zarr dir / BAM+bai) → its whole prefix under `dest` as a directory
/// (kind `artifact-prefix`), with the artifact's merkle `content_hash` (ITEM-5,
/// replacing the old `MULTIFILE_INPUT_UNSUPPORTED` rejection).
async fn stage_resolved_artifact(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact: &crate::modules::workstore::consume::ConsumableArtifact,
    dest: &Path,
) -> Result<(String, String), AppError> {
    // ── ITEM-31 — a GATHERED artifact is MATERIALISED here ──────────────────────────
    //
    // Staging hardlinks pooled blobs and this artifact has none, so it is gathered into an
    // ordinary zarr store under `dest` and the processor is none the wiser (INV-8). It goes
    // through `gather_exec` — the SAME resolution and the SAME assembly the byte route
    // serves — because two gathers that agree today are two gathers that will disagree
    // later, and a processor and the browser disagreeing about one column is the worst
    // available shape of that.
    //
    // On ANY failure this returns an error rather than an empty directory. A processor
    // reading a legitimately-empty input is the blank-surface failure one layer down: every
    // step succeeds, the numbers are wrong, and nothing says so.
    if artifact.object_key.is_none() {
        let resolved = crate::modules::workstore::gather_exec::resolve(
            pool,
            store,
            artifact.id,
            &artifact.structure,
        )
        .await?;
        let bytes = resolved.materialize(dest).await?;
        // The GATHERED size — rows x element width — not a source's size and not the
        // catalog's `stored_bytes`, which is 0 for a row with no blob. A budget taken from
        // either would be the wrong number for this input (ITEM-32's residue, read from the
        // other end).
        tracing::info!(
            artifact_id = %artifact.id,
            gathered_bytes = resolved.gathered_size_bytes(),
            written_bytes = bytes,
            chunks = resolved.chunk_count(),
            "sandbox.inputs: materialised a GATHERED artifact (no blob to hardlink)"
        );
        return Ok((
            artifact.content_hash.clone(),
            "artifact-gathered".to_string(),
        ));
    }

    if artifact.is_multifile {
        // Enumerate the prefix's members (the `object_key` is the manifest blob)
        // and stage each under `dest`. The identity is the catalog's merkle
        // `content_hash` (already `sha256:<root>`), matching the provenance used-edge.
        // ITEM-16: staging a GATHERED artifact means materialising it through the
        // alignment into an ordinary file the sandbox sees — ITEM-31. Until that lands,
        // refuse by name rather than stage nothing and let the processor read an empty
        // directory, which would look like a legitimately empty input.
        let manifest_key = ContentKey::parse(
            artifact.stored_key("ITEM-31 (stage-time materialisation of a gathered artifact)")?,
        );
        stage_prefix_members(store, &manifest_key, dest).await?;
        Ok((artifact.content_hash.clone(), "artifact-prefix".to_string()))
    } else {
        // Single blob → one file, HARDLINKED out of the pool when the deployment
        // allows it (ITEM-16), copied only as the fallback.
        //
        // The content identity is the blob's own key. That is byte-for-byte what
        // the previous re-hash of the fetched bytes produced — the store is
        // content-addressed, so bytes stored at key `K` hash to `K` by construction
        // — and it is what the multi-file branch above has always done (a merkle
        // root cannot be recomputed without reading every member either). Deriving
        // it from the key is what lets the fast path avoid reading a multi-GB blob
        // at all. Critically the COPY path returns the SAME value, so `inputs.json`
        // cannot betray which path ran; a fallback that changed the recorded
        // identity would be a provenance defect, not an optimization.
        let key = ContentKey::parse(
            artifact.stored_key("ITEM-31 (stage-time materialisation of a gathered artifact)")?,
        );
        let mut stager = Stager::new(store);
        stager.stage(&key, dest).await?;
        stager.report(dest);
        Ok((format!("sha256:{}", key.hex()), "artifact".to_string()))
    }
}

/// The datatype allow-set for a dataset axis-index artifact (ITEM-14 / DEC-12):
/// the metadata-column FAMILY resolved from the registry as the union of every
/// type carrying the `metadata-column-family` capability and its subtypes
/// (`descendants_inclusive`). Pure over the registry so it's directly unit-testable
/// for both the present + absent branches. Empty when the registry isn't built (a
/// direct-repo test context, never a request path) → the `= ANY(empty)` predicate
/// matches nothing → the caller surfaces a clean `not_found` (never over-broad).
fn axis_index_datatype_allow(
    registry: Option<&crate::modules::datatype::DatatypeRegistry>,
) -> Vec<String> {
    let Some(reg) = registry else {
        return Vec::new();
    };
    let mut set: Vec<String> = reg
        .types_with_capability("metadata-column-family")
        .into_iter()
        .flat_map(|id| reg.descendants_inclusive(&id))
        .collect();
    set.sort();
    set.dedup();
    set
}

/// Resolve a dataset's per-axis entity-INDEX (ITEM-12/14 / DEC-7/12). Looks
/// up the metadata-column-family artifact scoped to `axis_ref.dataset_id` by its own
/// DECLARATION — `meta @> '{"is_axis_index": true}'` AND `structure->>'axis'`
/// (`list_dataset_axis_index_candidates`) — then delegates to [`resolve_artifact`] so the
/// SAME job-owner artifact-read authz + conformance gate applies (and, ITEM-23, so the
/// mount name is derived from the index artifact just like any other). A missing
/// index (import not yet emitted / wrong axis) → `not_found`, so the integrate job fails
/// safely with a clear reason.
///
/// This doc read `output_id == "<axis>_index"` — "the import converter's contract key" —
/// until 2026-07-29. `output_id` is not in that query's WHERE clause and never was on
/// this branch. INV-3 is that an axis IS its key artifact, identified by `content_hash`,
/// with its name only a label; a comment presenting an `output_id` SPELLING as the
/// contract is the documentation vector by which that defect kept returning, so do not
/// reintroduce one.
async fn resolve_axis_index(
    pool: &SqlitePool,
    axis_ref: &super::spec::DatasetAxisIndexRef,
    owner_id: uuid::Uuid,
) -> Result<crate::modules::workstore::consume::ConsumableArtifact, AppError> {
    use crate::modules::workstore::catalog::repository::CatalogRepository;
    // Resolve the metadata-column FAMILY id-set from the registry (DEC-12): the
    // handler resolves, the repo stays pure SQL. No `metadata-column` id literal
    // survives here — the family is DATA (the `metadata-column-family` capability).
    let datatype_allow =
        axis_index_datatype_allow(crate::modules::datatype::try_registry().as_deref());
    let artifact = CatalogRepository::new(pool.clone())
        .find_dataset_axis_index(axis_ref.dataset_id, &axis_ref.axis, &datatype_allow)
        .await?
        .ok_or_else(|| {
            AppError::not_found(&format!(
                "axis-index artifact for dataset {} axis {:?}",
                axis_ref.dataset_id, axis_ref.axis
            ))
        })?;
    resolve_artifact(pool, artifact.id, owner_id).await
}

/// Stage every member of a multi-file artifact (its manifest blob `object_key`)
/// as files under `dest` (created as a directory). Pure w.r.t. the DB — it only
/// reads the object store — so it's unit-testable against a `LocalFsStore`.
/// Each member path is re-validated escape-free (defense-in-depth even though our
/// own ingest produced the manifest).
async fn stage_prefix_members(
    store: &dyn ObjectStore,
    manifest_key: &ContentKey,
    dest: &Path,
) -> Result<(), AppError> {
    use crate::modules::workstore::object_store::decode_manifest;
    let manifest_bytes = store.get(manifest_key).await?;
    let members = decode_manifest(&manifest_bytes)?;

    tokio::fs::create_dir_all(dest)
        .await
        .map_err(|e| mat_err(format!("create input prefix dir: {e}")))?;

    // ITEM-16: every member is HARDLINKED out of the content-addressed pool, not
    // copied. This is the path that matters most — under the artifact model every
    // Zarr artifact is multi-file, so copying here meant a job taking an expression
    // matrix wrote a multi-GB duplicate on every single run.
    let mut stager = Stager::new(store);
    for (member_path, member_blob) in &members {
        guard_member_path(member_path)?;
        let member_dest = dest.join(member_path);
        if let Some(parent) = member_dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| mat_err(format!("create input member subdir: {e}")))?;
        }
        stager
            .stage(&ContentKey::parse(member_blob), &member_dest)
            .await?;
    }
    stager.report(dest);
    Ok(())
}

/// A multi-file member relative path must be relative + free of `..`/`.`/absolute
/// components, so a corrupt/hostile manifest can never write outside `dest`.
fn guard_member_path(rel: &str) -> Result<(), AppError> {
    use std::path::{Component, Path};
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(mat_err(format!(
            "input member path {rel:?} must be relative"
        )));
    }
    for comp in p.components() {
        if !matches!(comp, Component::Normal(_)) {
            return Err(mat_err(format!(
                "input member path {rel:?} may not contain '.', '..', or an absolute/prefix component"
            )));
        }
    }
    Ok(())
}

/// Whether `owner_id` may read ziee-file `file_id` as a sandbox input.
///
/// **The rule itself now lives in [`crate::modules::file::access::readable_file_ids`]**,
/// which carries the single SQL literal and the whole design record for it (FIX-1,
/// A3/DEC-15, #147 H-1, #170, and the residues). This is a thin single-id adapter
/// over that predicate, kept at its original path and signature so the sandbox
/// call site and its three integration pins are untouched.
///
/// It was promoted because a SECOND caller appeared: `ziee-file`'s mounted HTTP
/// surface, whose injected `FileAccessPolicy` asks exactly this question about
/// exactly these files. Two hand-copies of an authorization predicate is how the
/// next hole gets made — the group-`is_active` defect that `841e6111` fixed here
/// was already the sixth copy of one such divergence — so there is one literal and
/// both callers go through it.
///
/// A nonexistent OR foreign file → `false`: a uniform reject with no existence
/// oracle.
pub async fn file_readable_by(
    pool: &SqlitePool,
    file_id: uuid::Uuid,
    owner_id: uuid::Uuid,
) -> Result<bool, AppError> {
    Ok(
        !crate::modules::file::access::readable_file_ids(pool, owner_id, &[file_id])
            .await?
            .is_empty(),
    )
}

/// Stage one Dataset file (ziee-file) into `dest`, returning its `sha256:<hex>`.
///
/// #182: this used to be `load_original` → `Vec<u8>` → hash → `fs::write`, i.e. the
/// SECOND place a whole uploaded file was materialized in the API process (the first
/// was the multipart handler). `load_original` returns `Vec<u8>` and lives in the
/// pinned SDK, so it cannot be made streaming in place; `copy_original_streaming`
/// goes around it through the same seam's `get_original_path` and hashes while it
/// copies. Peak RSS here is now the copy buffer, not the file.
///
/// NOT a hardlink, though that would be free: `/inputs` is materialized into a
/// workspace the compute can write to, so a link would let a job mutate the
/// canonical stored original (DEC-6).
///
/// `pub` as a TESTABILITY SEAM (#182), in the same class as
/// `rootfs::scoped_data_root`: the memory invariant this function carries can only
/// be proven by DRIVING IT, and a test that drove the private helper it calls would
/// stay green if this function were reverted to the buffered shape. Production
/// callers are unchanged (`materialize_inputs`, below).
pub async fn stage_dataset_file(
    pool: &SqlitePool,
    file_id: uuid::Uuid,
    owner_id: uuid::Uuid,
    dest: &Path,
) -> Result<String, AppError> {
    // SECURITY (FIX-1 IDOR): authorize the ref against the JOB OWNER before loading
    // any bytes. A cross-user `files.id` is rejected (uniform "not accessible", no
    // existence oracle) → the job fails safely, never staging another user's file.
    if !file_readable_by(pool, file_id, owner_id).await? {
        return Err(mat_err(format!(
            "input file {file_id} is not accessible to the job owner"
        )));
    }
    let file = ziee_file::FileRepository::new(pool.clone())
        .get_by_id(file_id)
        .await?
        .ok_or_else(|| AppError::not_found("dataset input file"))?;
    let extension = file
        .filename
        .rsplit('.')
        .next()
        .unwrap_or("bin")
        .to_lowercase();
    crate::modules::file::stream::copy_original_streaming(
        file.user_id,
        file.blob_version_id,
        &extension,
        dest,
    )
    .await
    .map_err(|e| mat_err(format!("stage dataset file {file_id}: {e}")))
}

/// Assemble the input-side of a [`ComputeSpec`] (mounts) — a thin helper so the
/// runner keeps mount assembly in one place. (Kept here since it owns
/// `MaterializedInput`.)
pub fn attach_input_mounts(
    spec: &mut ComputeSpec,
    inputs: &[MaterializedInput],
    inputs_dir: &Path,
) {
    spec.input_mounts = input_mounts(inputs, inputs_dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the tests still compare a STREAMED digest against a buffered one; the
    // production paths hash while they copy (#182).
    use crate::modules::workstore::object_store::sha256_hex;

    // ITEM-14 / DEC-12: the axis-index datatype allow-set is DATA — resolved from
    // the `metadata-column-family` capability + `descendants_inclusive`, NOT a
    // `metadata-column` id literal. Proves capability-derivation, subtype coverage
    // (== the carrier's descendants-inclusive set, so a contributed subtype resolves
    // for free), and the registry-absent degrade (empty → matches nothing).
    #[test]
    fn axis_index_allow_set_is_capability_derived() {
        use crate::modules::datatype::DatatypeRegistry;
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        let got = axis_index_datatype_allow(Some(&reg));
        assert!(
            got.contains(&"metadata-column".to_string()),
            "the family base type resolves from the metadata-column-family capability"
        );
        // The set is exactly the descendants-inclusive expansion of the capability
        // carrier(s) — so any CONTRIBUTED subtype of a carrier resolves for free.
        let mut expected: Vec<String> = reg
            .types_with_capability("metadata-column-family")
            .into_iter()
            .flat_map(|id| reg.descendants_inclusive(&id))
            .collect();
        expected.sort();
        expected.dedup();
        assert_eq!(
            got, expected,
            "allow-set == family carriers' descendants-inclusive"
        );
        // No registry (direct-repo test context) → empty → `= ANY(empty)` matches
        // nothing (never over-broad).
        assert!(axis_index_datatype_allow(None).is_empty());
    }

    fn mat(slot: &str, sub: &str, hash: &str) -> MaterializedInput {
        mat_kind(slot, "artifact", sub, hash)
    }

    fn mat_kind(slot: &str, kind: &str, sub: &str, hash: &str) -> MaterializedInput {
        MaterializedInput {
            slot: slot.into(),
            kind: kind.into(),
            host_path: PathBuf::from(format!("/ws/inputs/{sub}")),
            sandbox_path: format!("/inputs/{sub}"),
            content_hash: hash.into(),
        }
    }

    /// `unique_mount_name` — the disambiguation that keeps N bindings of ONE slot from
    /// collapsing onto one mount. It had NO test, which is how a reader of
    /// `derive_artifact_mount_name` alone (a pure function of slot + encoding, so all N
    /// bindings derive the same name) could correctly conclude the collision was live.
    ///
    /// Pins the two decisions in the scheme, not just "the names differ":
    ///  * the FIRST binding keeps the bare name, so a lone binding — and every
    ///    conformance-gate target, whose slot is a unique artifact UUID — mounts at the
    ///    slot itself;
    ///  * the ordinal counts OCCURRENCES OF THE NAME (1, 2, 3 …), so it is independent of
    ///    where in the spec the slot sits, and it is inserted BEFORE the store suffix.
    #[test]
    fn repeated_names_get_an_ordinal_before_the_store_suffix() {
        let mut used = std::collections::HashSet::new();
        let take = |used: &mut std::collections::HashSet<String>, n: &str| {
            unique_mount_name(n.to_string(), used)
        };

        // The first binding keeps the slot's own name; later ones count up.
        assert_eq!(take(&mut used, "matrices.zarr"), "matrices.zarr");
        assert_eq!(take(&mut used, "matrices.zarr"), "matrices_1.zarr");
        assert_eq!(take(&mut used, "matrices.zarr"), "matrices_2.zarr");
        // The ordinal is before the suffix — a Zarr reader opens `*.zarr`, and
        // `matrices.zarr_1` is exactly the "named as a format nothing recognises" shape
        // ITEM-23 removed.
        assert!(!used.iter().any(|n| n.contains(".zarr_")));

        // A suffix-less (opaque) name works the same way.
        assert_eq!(take(&mut used, "labels"), "labels");
        assert_eq!(take(&mut used, "labels"), "labels_1");

        // The ordinal is per-NAME, not per-spec-position: an unrelated input taken in
        // between must not move the next `matrices` binding's number.
        assert_eq!(take(&mut used, "gene_names"), "gene_names");
        assert_eq!(take(&mut used, "matrices.zarr"), "matrices_3.zarr");

        // A name that an EARLIER input already claimed outright is still respected — the
        // generated ordinal never silently displaces a taken name.
        let mut used2 = std::collections::HashSet::new();
        assert_eq!(take(&mut used2, "m_1.zarr"), "m_1.zarr");
        assert_eq!(take(&mut used2, "m.zarr"), "m.zarr");
        assert_eq!(
            take(&mut used2, "m.zarr"),
            "m_2.zarr",
            "`m_1.zarr` is taken, so the ordinal skips past it rather than colliding"
        );
    }

    /// `parse_recorded_mount_names` is the INVERSE of `render_inputs_json`, and the
    /// provenance capsule's only source for where a run's inputs were bound. Round-trip
    /// it against the real writer so the two cannot drift into different wire shapes,
    /// and pin the degradations (they must never panic a finished run's recording).
    #[test]
    fn recorded_mount_names_round_trip_the_written_inputs_json() {
        let inputs = vec![
            mat("matrices", "matrices.zarr", "sha256:aaa"),
            mat("matrices", "matrices_1.zarr", "sha256:bbb"),
            mat("labels", "labels", "sha256:ccc"),
        ];
        let got = parse_recorded_mount_names(&render_inputs_json(&inputs));
        assert_eq!(
            got,
            vec![
                ("matrices".to_string(), "matrices.zarr".to_string()),
                ("matrices".to_string(), "matrices_1.zarr".to_string()),
                ("labels".to_string(), "labels".to_string()),
            ],
            "every entry round-trips, IN ORDER, with the `/inputs/` prefix stripped — a \
             repeated slot keeps both of its distinct mounts"
        );

        // Degradations: no panic, no invented pair.
        assert!(parse_recorded_mount_names(b"not json").is_empty());
        assert!(parse_recorded_mount_names(b"{}").is_empty());
        assert!(parse_recorded_mount_names(&render_inputs_json(&[])).is_empty());
        // An entry whose path is not under `/inputs/` is a shape this function does not
        // understand, so it is skipped rather than guessed at.
        let odd = br#"{"inputs":[{"slot":"x","sandbox_path":"/elsewhere/x"},
                                 {"slot":"y","sandbox_path":"/inputs/y"}]}"#;
        assert_eq!(
            parse_recorded_mount_names(odd),
            vec![("y".to_string(), "y".to_string())]
        );
    }

    // TEST-5: inputs.json is deterministic + references by hash (not host path);
    // no-input → empty list + zero mounts; one RO mount per input.
    #[test]
    fn inputs_json_is_hash_referenced_and_deterministic() {
        let inputs = vec![
            mat("expression", "expression.h5ad", "sha256:aaa"),
            mat("labels", "labels.csv", "sha256:bbb"),
        ];
        let a = render_inputs_json(&inputs);
        let b = render_inputs_json(&inputs);
        assert_eq!(a, b, "same inputs → identical bytes (deterministic)");
        let s = String::from_utf8(a).unwrap();
        assert!(
            s.contains("sha256:aaa") && s.contains("sha256:bbb"),
            "referenced by hash"
        );
        assert!(
            s.contains("/inputs/expression.h5ad"),
            "carries the sandbox path"
        );
        // The host path must NOT leak into inputs.json (path-agnostic contract).
        assert!(!s.contains("/ws/inputs"), "host path must not appear: {s}");

        // Mounts: one read-only bind per input, at the /inputs path.
        let mounts = input_mounts(&inputs, Path::new("/ws/inputs"));
        assert_eq!(mounts.len(), 2);
        assert!(mounts.iter().all(|m| m.mode == MountMode::ReadOnly));
        assert_eq!(mounts[0].sandbox_path, "/inputs/expression.h5ad");
        assert_eq!(
            mounts[0].host_path,
            PathBuf::from("/ws/inputs/expression.h5ad")
        );

        // No inputs → empty json list + zero mounts.
        let empty = render_inputs_json(&[]);
        assert!(String::from_utf8(empty).unwrap().contains("\"inputs\": []"));
        assert!(input_mounts(&[], Path::new("/ws/inputs")).is_empty());
    }

    // REGRESSION (the params-mount bug, a discovered-blocker guard): the DERIVED
    // `inputs.json` + `params.json` that `materialize_inputs` writes must also be
    // BOUND. The sandbox binds /inputs file-by-file, so before this they were
    // written to the workspace and never mounted — every processor read `{}` params
    // and ran on defaults (cell-filter.py committed an all-true `keep_all` mask on
    // EVERY live run).
    #[test]
    fn derived_inputs_and_params_json_are_bound_read_only() {
        let root = std::env::temp_dir().join(format!("cyto-derived-{}", uuid::Uuid::new_v4()));
        let dir = root.join("inputs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("inputs.json"), b"{}").unwrap();
        std::fs::write(dir.join("params.json"), b"{}").unwrap();

        let mounts = input_mounts(&[], &dir);
        let paths: Vec<&str> = mounts.iter().map(|m| m.sandbox_path.as_str()).collect();
        assert!(
            paths.contains(&"/inputs/params.json"),
            "params.json is bound: {paths:?}"
        );
        assert!(
            paths.contains(&"/inputs/inputs.json"),
            "inputs.json is bound: {paths:?}"
        );
        assert!(
            mounts.iter().all(|m| m.mode == MountMode::ReadOnly),
            "derived binds are RO"
        );
        // Each derived bind points at the file the writer actually produced.
        let p = mounts
            .iter()
            .find(|m| m.sandbox_path == "/inputs/params.json")
            .unwrap();
        assert_eq!(p.host_path, dir.join("params.json"));

        // Absent derived files add no mounts (a caller that staged nothing).
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(input_mounts(&[], &empty).is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    // REGRESSION, end of the argv chain: the params the RUNNER materializes must
    // survive all the way into the bwrap command line the kernel is handed —
    // `materialize_inputs` (write) → `input_mounts` (bind) → `assemble_mounts`
    // (backend) → `build_bwrap_argv`. This is the assertion that actually fails if
    // the bind is dropped anywhere along the chain; the unit above only covers the
    // first hop. (It does NOT execute bwrap — see the run-level note in the branch
    // report — but the argv it asserts is byte-for-byte the one `spawn_bwrap`
    // passes to the child.)
    #[test]
    fn derived_params_json_reaches_the_bwrap_argv() {
        use crate::modules::sandbox::backend::local_bwrap::assemble_mounts;
        use crate::modules::sandbox::backend::{
            ComputeSpec, PriorityClass, ResourceClass, ResourceProfile,
        };
        use crate::modules::sandbox::sandbox::build_bwrap_argv;
        use crate::modules::sandbox::settings::SandboxResourceLimits;
        use crate::modules::sandbox::types::{
            CgroupMode, HardeningCapabilities, PidNsMode, SandboxContext, SeccompMode,
        };

        let root = std::env::temp_dir().join(format!("cyto-argv-{}", uuid::Uuid::new_v4()));
        let dir = root.join("inputs");
        std::fs::create_dir_all(&dir).unwrap();
        // The REAL body the runtime writes — the criteria a processor must see.
        let params = params_json_value(
            &serde_json::json!({ "criteria": [{ "column": "total_counts", "min": 1500 }] }),
            Some(7),
        );
        std::fs::write(
            dir.join("params.json"),
            serde_json::to_vec_pretty(&params).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("inputs.json"), render_inputs_json(&[])).unwrap();

        let mut spec = ComputeSpec {
            job_id: uuid::Uuid::nil(),
            workspace_root: root.clone(),
            // ITEM-17: staged outside the workspace. This fixture exercises the
            // `/inputs` side only, so the path merely has to be a real sibling —
            // never a subdir of `root`.
            outputs_dir: std::path::PathBuf::from(format!("{}-staging/outputs", root.display())),
            command: "python3 /code/entry.py".into(),
            input_mounts: vec![],
            code_mount: None,
            extra_mounts: vec![],
            profile: ResourceProfile {
                memory_max_bytes: 1 << 30,
                memory_swap_max_bytes: 1 << 30,
                pids_max: 128,
                cpu_max: "100000 100000".into(),
                timeout_secs: 60,
            },
            priority: PriorityClass::Normal,
            resource_class: ResourceClass::CpuSandbox,
            // #189 test fixture: no per-job env ⇒ the deployment default (INV-1).
            env_id: None,
        };
        // Exactly what the queued runner does after materializing inputs.
        attach_input_mounts(&mut spec, &[], &dir);
        let mounts = assemble_mounts(&spec, &spec.extra_mounts);

        let argv = build_bwrap_argv(
            &HardeningCapabilities {
                bwrap_path: PathBuf::from("/usr/bin/bwrap"),
                pid_namespace: PidNsMode::Strict,
                cgroup: CgroupMode::None,
                seccomp: SeccompMode::NotLinked,
            },
            &SandboxContext {
                job_id: uuid::Uuid::nil(),
                workspace: root.clone(),
            },
            Path::new("/mnt/rootfs"),
            &spec.command,
            Path::new("/id/passwd"),
            Path::new("/id/group"),
            Path::new("/id/empty"),
            None,
            &SandboxResourceLimits::defaults(),
            &mounts,
            None,
        );

        // The bind triple `--ro-bind-try <host params.json> /inputs/params.json` is
        // present, in order, in the argv the child is spawned with.
        let host = dir.join("params.json").display().to_string();
        let at = argv
            .iter()
            .position(|s| *s == host)
            .unwrap_or_else(|| panic!("params.json host path in argv: {argv:?}"));
        assert_eq!(argv[at - 1], "--ro-bind-try", "bound read-only");
        assert_eq!(
            argv[at + 1],
            "/inputs/params.json",
            "at the path the script reads"
        );

        // inputs.json likewise (the slot map `load_inputs_index` reads).
        let ihost = dir.join("inputs.json").display().to_string();
        let iat = argv
            .iter()
            .position(|s| *s == ihost)
            .unwrap_or_else(|| panic!("inputs.json host path in argv: {argv:?}"));
        assert_eq!(argv[iat + 1], "/inputs/inputs.json");

        // And the file the sandbox will read really carries the criteria — a run
        // that reaches this argv cannot silently see `{}`.
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("params.json")).unwrap()).unwrap();
        assert_eq!(on_disk["criteria"][0]["min"], serde_json::json!(1500));
        assert_eq!(on_disk["seed"], serde_json::json!(7));

        let _ = std::fs::remove_dir_all(&root);
    }

    // `params_json_value` is the SHARED source of truth for `/inputs/params.json`
    // (the live runtime AND the reproduce capsule). `seed` is merged in last, wins,
    // and is never `null` — a null is a crash in every `int(params["seed"])` entry
    // script, and it only became reachable once the derived bind above started
    // delivering this body to the scripts at all.
    #[test]
    fn params_json_value_merges_a_non_null_seed_last() {
        let p = serde_json::json!({ "criteria": [{ "column": "total_counts", "min": 1500 }] });

        // The run's own seed wins and is merged in.
        let v = params_json_value(&p, Some(7));
        assert_eq!(v["seed"], serde_json::json!(7));
        assert_eq!(
            v["criteria"], p["criteria"],
            "the science is preserved verbatim"
        );

        // No run seed → a seed already inside params is preserved (never clobbered).
        let with_seed = serde_json::json!({ "label": "subset", "seed": 42 });
        assert_eq!(
            params_json_value(&with_seed, None)["seed"],
            serde_json::json!(42)
        );

        // Neither → 0, NEVER null.
        assert_eq!(params_json_value(&p, None)["seed"], serde_json::json!(0));
        assert!(!params_json_value(&p, None)["seed"].is_null());

        // A non-object `params` degrades to just the seed (today's behaviour for a
        // run that recorded no params).
        assert_eq!(
            params_json_value(&serde_json::Value::Null, Some(3)),
            serde_json::json!({ "seed": 3 })
        );
    }

    // TEST-6: the new input kinds (dataset-file + multi-file prefix) surface in
    // `inputs.json` as hash-referenced, deterministic, host-path-free entries
    // alongside the unchanged single-blob path; a prefix input still binds RO as
    // one directory. Extends TEST-5's invariants (ITEM-5).
    #[test]
    fn inputs_json_carries_new_kinds_hash_referenced() {
        let inputs = vec![
            mat_kind("expression", "artifact", "expression.h5ad", "sha256:aaa"),
            mat_kind("genome", "dataset-file", "genome.fa", "sha256:bbb"),
            mat_kind("counts", "artifact-prefix", "counts.zarr", "sha256:ccc"),
        ];
        let a = render_inputs_json(&inputs);
        assert_eq!(a, render_inputs_json(&inputs), "deterministic");
        let s = String::from_utf8(a).unwrap();
        // Every input is referenced by its content hash + declares its source kind.
        assert!(s.contains("sha256:aaa") && s.contains("sha256:bbb") && s.contains("sha256:ccc"));
        assert!(
            s.contains("\"kind\": \"dataset-file\""),
            "dataset-file kind present: {s}"
        );
        assert!(
            s.contains("\"kind\": \"artifact-prefix\""),
            "prefix kind present: {s}"
        );
        assert!(
            s.contains("\"kind\": \"artifact\""),
            "single-blob kind unchanged: {s}"
        );
        // Still no host path leak (path-agnostic contract holds for all kinds).
        assert!(!s.contains("/ws/inputs"), "host path must not appear: {s}");

        // A prefix input binds RO as one directory at its /inputs subpath.
        let mounts = input_mounts(&inputs, Path::new("/ws/inputs"));
        assert_eq!(mounts.len(), 3);
        assert!(mounts.iter().all(|m| m.mode == MountMode::ReadOnly));
        let prefix = mounts
            .iter()
            .find(|m| m.sandbox_path == "/inputs/counts.zarr")
            .unwrap();
        assert_eq!(prefix.host_path, PathBuf::from("/ws/inputs/counts.zarr"));
    }

    // TEST-6 (multi-file staging leg): stage a real multi-file prefix from a
    // `LocalFsStore` — every member is written under `dest` with faithful bytes,
    // and a nested member path is preserved. Real store path, no DB (ITEM-5).
    #[tokio::test]
    async fn stage_prefix_members_writes_all_members() {
        use crate::modules::workstore::object_store::LocalFsStore;

        let root = std::env::temp_dir().join(format!("cyto-prefix-{}", uuid::Uuid::new_v4()));
        let store = LocalFsStore::new(root.join("store"));
        let members = vec![
            (".zattrs".to_string(), b"{\"kind\":\"zarr\"}".to_vec()),
            ("chunk/0.0".to_string(), (0u8..200).collect::<Vec<u8>>()),
            ("chunk/0.1".to_string(), b"second chunk bytes".to_vec()),
        ];
        let put = store.put_prefix(&members).await.unwrap();

        let dest = root.join("inputs").join("counts.zarr");
        stage_prefix_members(&store, &put.object_key, &dest)
            .await
            .unwrap();

        // Every member landed with byte-faithful content + nested paths preserved.
        assert_eq!(
            tokio::fs::read(dest.join(".zattrs")).await.unwrap(),
            members[0].1
        );
        assert_eq!(
            tokio::fs::read(dest.join("chunk/0.0")).await.unwrap(),
            members[1].1
        );
        assert_eq!(
            tokio::fs::read(dest.join("chunk/0.1")).await.unwrap(),
            members[2].1
        );

        // ITEM-16 — …and each member IS the pooled blob, not a copy of it.
        //
        // The byte assertions above are exactly the shape of test that let the
        // copying defect survive: they pass identically whether the member was
        // hardlinked or written out a second time. `nlink > 1` is the assertion
        // that can tell the two apart, so it belongs right next to them rather
        // than only in the integration tier.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            for (rel, _) in &members {
                let m = tokio::fs::metadata(dest.join(rel)).await.unwrap();
                assert!(
                    m.nlink() > 1,
                    "member {rel} must share the pooled blob's inode (hardlinked); \
                     nlink={} means a full second copy was written",
                    m.nlink()
                );
            }
        }

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    // TEST-6 (member-path guard leg): a manifest member path that tries to escape
    // is rejected (defense-in-depth), never written outside `dest`.
    #[test]
    fn guard_member_path_rejects_escapes() {
        assert!(guard_member_path("chunk/0.0").is_ok());
        assert!(guard_member_path("../escape").is_err());
        assert!(guard_member_path("/etc/passwd").is_err());
        assert!(guard_member_path("a/../../b").is_err());
    }

    // TEST-5 (streamed-hash leg, blind-audit D3): copy_and_hash streams src→dest
    // and its digest equals the buffered sha256_hex byte-for-byte, and the copy
    // is faithful. Uses data larger than one 128 KiB chunk to exercise the loop.
    #[tokio::test]
    async fn copy_and_hash_matches_buffered_and_copies() {
        let dir = std::env::temp_dir().join(format!("cyto-inp-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let src = dir.join("src.bin");
        let dest = dir.join("dest.bin");
        let data: Vec<u8> = (0..300_000).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&src, &data).await.unwrap();

        let hash = copy_and_hash(&src, &dest).await.unwrap();
        assert_eq!(
            hash,
            format!("sha256:{}", sha256_hex(&data)),
            "streamed == buffered digest"
        );
        let copied = tokio::fs::read(&dest).await.unwrap();
        assert_eq!(copied, data, "the copy is byte-faithful");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// Build a consumable artifact fixture for the staging-diagnosis tests.
    fn consumable(is_multifile: bool) -> crate::modules::workstore::consume::ConsumableArtifact {
        use crate::modules::workstore::catalog::models::Artifact;
        use crate::modules::workstore::consume::{ConsumableArtifact, STATUS_READY};
        ConsumableArtifact::try_new(Artifact {
            id: uuid::Uuid::nil(),
            project_id: Some(uuid::Uuid::new_v4()),
            dataset_id: None,
            run_id: None,
            output_id: "expression".into(),
            datatype: "single-cell/expression".into(),
            object_key: Some("sha256:831e51a0b0fd413be7b4b181e7bbcbfe".into()),
            is_multifile,
            content_hash: "sha256:831e51a0b0fd413be7b4b181e7bbcbfe".into(),
            structure: serde_json::json!({ "encoding": "zarr_v3" }),
            meta: serde_json::json!({}),
            role: "artifact".into(),
            status: STATUS_READY.into(),
            stored_bytes: 1,
            logical_bytes: Some(1),
            created_by: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            hidden: false,
            representation_of: None,
        })
        .expect("a ready artifact is consumable")
    }

    /// The ABSENT arm of [`describe_artifact_staging_failure`].
    ///
    /// The whole diagnosis a user got for this was `Blob not found`: the run's job card,
    /// its detail pane and the dataset's processing badge all render the one `jobs.error`
    /// column, and that column held those three words. So the assertions here are on the
    /// facts a user needs, one at a time, rather than on the sentence — a message that
    /// merely got LONGER would satisfy a substring check on the old text.
    #[test]
    fn a_missing_blob_names_the_slot_the_artifact_and_the_remedy() {
        let a = consumable(true);
        let msg =
            describe_artifact_staging_failure("matrix", &a, ziee_core::AppError::not_found("Blob"))
                .to_string();

        assert!(msg.contains("matrix"), "names the input SLOT: {msg}");
        assert!(
            msg.contains(&a.id.to_string()),
            "names the ARTIFACT it was bound to: {msg}"
        );
        assert!(
            msg.contains("single-cell/expression"),
            "names the datatype: {msg}"
        );
        assert!(
            msg.contains("multi-file"),
            "says the artifact is multi-file: {msg}"
        );
        // The BYTES, not the row — a user told "artifact not found" would go looking for
        // a catalog entry that is sitting in front of them, intact.
        assert!(
            msg.contains("stored bytes") && msg.contains("MISSING"),
            "says it is the stored bytes that are gone: {msg}"
        );
        assert!(
            msg.contains("catalog row is intact"),
            "and says the row is NOT what is missing: {msg}"
        );
        // Absence has a different remedy from a failed read, so it says which this is.
        assert!(
            msg.contains("re-running will fail the same way") || msg.contains("re-import"),
            "tells the user retrying will not help: {msg}"
        );
        // The key is a log-only detail: not actionable, and the first thing a card
        // truncates.
        assert!(
            !msg.contains("sha256:"),
            "keeps the raw object key OUT of the user-facing string: {msg}"
        );
    }

    /// The single-file arm says so, so the two shapes are not reported identically.
    #[test]
    fn a_single_file_artifact_is_described_as_one() {
        let msg = describe_artifact_staging_failure(
            "labels",
            &consumable(false),
            ziee_core::AppError::not_found("Blob"),
        )
        .to_string();
        assert!(msg.contains("single-file artifact"), "{msg}");
        assert!(!msg.contains("multi-file"), "{msg}");
    }

    /// NEGATIVE CONTROL — the arm that makes the positive one mean anything.
    ///
    /// If a read that FAILED were also reported as "the bytes are missing", the new
    /// message would be a more confident version of the old defect: the user is told to
    /// re-import over an `EMFILE`. The store already separates the two (ENOENT → 404,
    /// everything else → 500, deliberately — see `map_blob_io_err`), and this pins that
    /// the distinction survives to the sentence. The non-404 arm also does not DIAGNOSE:
    /// it keeps the original message whole and only adds the context it actually has.
    #[test]
    fn a_read_that_failed_is_not_reported_as_an_absence() {
        let a = consumable(true);
        let msg = describe_artifact_staging_failure(
            "matrix",
            &a,
            ziee_core::AppError::internal_error("workstore: blob read failed: too many open files"),
        )
        .to_string();

        assert!(
            !msg.contains("MISSING") && !msg.contains("re-import"),
            "a transient read failure must not be reported as absent data: {msg}"
        );
        assert!(
            msg.contains("too many open files"),
            "the underlying reason is preserved verbatim, not replaced: {msg}"
        );
        // Still an improvement on the bare string: it names what was being staged.
        assert!(msg.contains("matrix"), "names the slot: {msg}");
        assert!(msg.contains(&a.id.to_string()), "names the artifact: {msg}");
    }
}
