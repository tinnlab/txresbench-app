# model_store

The saved-model home of the TxResBench app: it keeps the trained-model
artifacts a run produced, as named sets the user can rename, delete, export
and re-import, and it answers the two questions the model screens ask —
*can this saved model run on the file the user just uploaded, and how long
would it take?* — and hands the engine the verified artifact record when a
reuse run starts. Everything it does is local: the module performs no network
I/O, keeps no analytics, and the only bytes it imports or exports are the
user's own `.txr` files.

## What is stored where

The store is a plain directory layout under the app data root
(`rootfs::data_root()` — the hidden `~/.txresbench` folder; D01), plus two
module-owned SQLite tables (`txr_model_sets`, `txr_models`):

| path | what it holds |
|---|---|
| `models/trees/<tree_sha256>/` | one immutable, content-addressed tree per saved model artifact (the engine's own digest — PROV-SS-3). Rows are references: two rows with the same digest share one directory, which is deleted only when the last referencing row goes |
| `models/training/<set_id>/` | the set's optional copies of the run's `input/` files ("keep the training files" on the save dialog) |
| `models/exports/` | the one-off `.txr` files the save dialog's "also save as a file" writes |
| `models/.import-*`, `trees/.staging-*`, `exports/.staging-*` | the staging entries of an in-flight import/save/export. Each operation is complete-or-absent (staging + atomic rename), so a staged entry exists only while an operation is running; entries older than a day are reclaimed by the write gate's sweep (an orphan from a process that died mid-operation) |

A saved tree is never modified after it is written: the copy is byte-for-byte
and the digest is the identity — a changed artifact is a new tree under a new
digest, never an update. The store never opens a model file for meaning; the
artifact is opaque bytes (INV-2).

## The `.txr` container

One container is one model or one whole set, and it is uncompressed — model
artifacts are already compression-native (keras, rds, blob trees), so the
"move to another computer" byte count is the artifact's own, and the server's
decode-scope rule (one sanctioned decoder in the entire server) stays
untouched.

Byte layout (little-endian integers):

- magic `TXR_MODL\0` (9 bytes),
- `u32 header_len` + the header JSON: format version (1), kind (`model` /
  `set`), the set facts, one `models[]` record per model (token, name,
  method id/version, group, task, provenance with licence, the recorded
  requirements — decision day, endpoint, horizon, features, env digests,
  marker facts, covariates — the tree sha256 and byte size) and the optional
  `training[]` listing,
- per model, in header order: `u32 entry_count`; per entry a `u16`-length
  relative path (no `..`, no leading `/`), `u64` byte length, the bytes and
  their 32-byte sha256,
- `u64 training_entry_count` and the same per-entry framing,
- end magic `TXR_MODLEND\0` (12 bytes).

Import verifies, in order: magic + version, the header parses, the framing
is consistent, every entry's sha256 matches its bytes, the paths are safe,
the restored tree's own digest (the same algorithm the engine ran at fit
time) equals the header's recorded digest, the declared byte size matches
the restored count, and the container is within the byte cap (16 GiB). Any
refusal writes nothing into the store. Exports are deterministic: the same
artifacts produce identical bytes.

## Save and reuse

Saving binds a run record through the engine's own in-process seam
(`produced_models`): each selected method's recorded tree (digest, dir, env
digests, trained-on count, byte size, own-data AUC) is copied into the store,
and the requirements the I screen checks against are recorded from the run's
config and the method bundle's `params.json` plus the catalogue facts — never
re-derived, never invented. A model whose requirements could not be recorded
(it was imported from a container without them) is answered
`cannot_run` + `MODEL_REQUIREMENTS_UNRECORDED` rather than a silent "looks
fine".

Reuse resolution re-verifies every selected tree against its recorded digest
before an asset leaves the store (409 on any mismatch): the engine only ever
binds a verified artifact. The response element is byte-compatible with the
engine's own `CreateRunRequest.model_ids[]` element, so the model screen
passes it through untouched.

## Boundaries

- **No training, no execution, no metric computation.** The engine produces
  `/model` artifacts; the store copies, records and presents what the run
  record says (the own-data AUC is the engine's field).
- **No pretrained catalogue, no downloads, no update checks.** The
  pretrained import seam (`install_imported`, `install_imported_from_path`,
  `list_pretrained`) receives already-verified bytes and records the licence
  the importing path declares; an install without a licence is refused.
- **No history/rerun semantics.** Reuse runs are the engine's rows; deleting
  a store entry never touches a run ("results already made with it are kept
  in history").
- **No UI.** The screens that render this state are the sibling UI modules;
  this module serves the REST surface under `/api/txr/models*` /
  `/api/txr/model-sets*` (all gated by the reused `jobs::use` permission).
- **No second DB, no scheduler, no sync entity, no stream surface.** It is a
  flat CRUD module over the app's SQLite pool, with content-addressed plain
  directories instead of a blob store — the sandbox binds paths, not objects.

## Design decisions that shape the store

- **The models directory is the app data root's `models/`**, not a
  `Documents/TxResBench/models/` path: the app owns one hidden data folder
  (D01), and the screens render the real path this module exposes (`Open the
  folder`). The board's Documents label is the design copy.
- **The container is uncompressed** (see above): the trade-off is a
  bigger export file against zero new decoder surface in the server.
- **The training-data warning is data, not a built-in method list**: the
  `embeds_training_data` fact comes from the method catalogue's curated
  marketplace of method types (GAP-A), so the warning renders only for
  method types the catalogue carries as embedding.
- **Deleting a set deletes its models** by default (the I screen's "delete
  the run's models"), with a `keep_files` escape that removes the rows and
  keeps the files; deleting a model leaves the runs that used it untouched.
- **No refit from the store**: a run created without model saving has no
  produced-model rows, and saving from it answers `MODEL_ASSET_UNKNOWN`; a
  refit is a new run with `save_models` on the engine's side.
