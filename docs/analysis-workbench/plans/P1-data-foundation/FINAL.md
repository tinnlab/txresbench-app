# P1 — Data Foundation · FINAL (consolidated r1 ∪ r2 ∪ r3)

## Reconciliation applied

Pinned cross-part audit decisions baked into this plan:
- **A1 — canonical `OutputsManifest` (P1 is a CONSUMER, P3 OWNS it).** The `/outputs/manifest.json`
  contract has ONE canonical shape owned by P3: a Rust struct `OutputsManifest { outputs: Vec<OutputEntry> }`
  with `OutputEntry { id: String, datatype: String, path: String, layout: String, role: String }`
  (serde-deserializable). P1's catalog-ingest references (ITEM-5, Files, Decisions, Risks) now use these
  exact field names (`id`/`datatype`/`path`/`layout`/`role`) and **import the P3-owned struct** instead of
  defining a divergent one. The old P1 shape (`{output_id, datatype, from, layout?}`) is retired.
- **A5 — one `SyncEntity` name.** P1 emits exactly `SyncEntity::Artifact` (matches P1's `artifacts` table);
  `SyncEntity::AnalysisResult` is NOT a separate entity (P10 is being corrected to use `::Artifact` too).
- **A7 — re-grounded vs merged main (tip `63520fb`).** Main ALREADY adopted `ziee-file` as a real server
  dependency with dataset multipart upload (P2/P10/P11 assume it exists). P1's grounding/Reuse/Items now treat
  the ziee-file content-addressed store + dataset upload wiring as **ALREADY EXISTING on main**; P1 builds the
  catalog + typed-binary data-API + content-address refcount **on top of it** and does NOT rebuild the
  upload/multipart path.

---

**Part:** the platform's critical-path substrate — a content-addressed local-FS **object store**, the
host-owned **`artifacts`/`analysis_results` catalog** (Postgres), the **canonical cell/gene axes +
dense view-index** alignment subsystem, the **write-path ingest** of a run's `/outputs`
produces-manifest, the JSON **control plane** + raw-typed-array **binary data plane** with
**authed study-scoped HTTP-Range/206 serving**, a **frontend thin binary client**, study-lifecycle
**cascade + sync**, and a standing **content-address GC sweep**. Desktop + single-box server ONLY;
S3/MinIO stays behind an open `ObjectStore` seam (drop-in, same content keys + `get_range`
primitive). Everything in P2–P11 stands on this — it is THE critical path
(`BUILD_PLAN.md#the-critical-path`, live8 `DEC-FOUNDATION`).

New host module: `src-app/server/src/modules/workstore/` — compiled Rust, host-owned kernel piece
(`PLATFORM_ARCHITECTURE.md §7`), no per-analysis / no domain logic.

**Grounding (verified in the tree):** `modules/dataset` is a metadata-only placeholder (row:
id/name/n_cells/n_genes/status, `upload`→`UploadStubResponse`, `datasets.file_id` FK ON DELETE SET
NULL); `modules/jobs` is real (FCFS queue + `JobRunner` trait + `StubJobRunner`); `modules/sandbox::
service::run_analysis(pool,&AnalysisRequest,&[ExtraMount])->AnalysisResult` (linux-only, 503 else)
already plumbs RO/RW `ExtraMount{host_path,sandbox_path,mode}`. **No `analysis_results`/`artifacts`
table, no content-addressed store, no byte-range/streaming exists anywhere.** `sdk/crates/ziee-file`
is uploads-only: UUID-keyed (`blob_version_id`), sha256 `checksum` stored+indexed but NEVER used for
pathing/dedup, every download loads a full `Vec<u8>` (no `Range`/`206`/`Accept-Ranges`), not
study-scoped. So the content-addressed store + byte-range serving (ITEM-1/6/8/9) are greenfield —
BUT the ziee-file *upload path itself already exists as a wired server dependency* (see A7 below).

**A7 re-grounding (this tree is BEHIND merged main tip `63520fb`).** The claim that "ziee-file is not
yet a server dependency / raw dataset upload is greenfield" was true only on this stale
analysis-workflow tree. On **merged main** `ziee-file` is ALREADY a real server dependency with
**dataset multipart upload** wired in (`init_file_storage` + a multipart receiver + the
content-addressed store); P2/P10/P11 correctly assume it exists. Therefore P1 **must NOT rebuild the
upload/multipart path** — it builds the catalog + typed-binary data-API + content-address refcount
**on top of the already-existing** ziee-file content-addressed store + dataset upload wiring. Only the
range-native serving, catalog, axes, and content-address-keyed layer are net-new.

**Cross-part ownership resolutions baked in (agreed by adjacent parts' r3 passes):**
1. **P1 OWNS the `artifacts`/catalog table** — the host-owned, domain-neutral catalog. P2's
   datatype-system is only the semantic layer keyed off the `datatype`/`storage_layout` columns.
   `artifacts.datatype` is a plain `TEXT` column **validated against P2's registry, NOT a closed
   enum / FK**. (`PLATFORM_ARCHITECTURE.md §5.5-B`: "extensions don't own catalog tables; the host
   writes the catalog row.")
2. **The provenance graph IS P1's catalog derivation edges** (`run_id` + `params` + `covered_axes`
   + producer→artifact fan-out on the catalog rows) — NOT separate `provenance_*` tables. P4 owns
   only capture-logic + code-blob store + the reproduce layer, attaching to P1's `run_id`/
   `content_hash`.
3. **Blob GC** — P1 owns the content-address refcount sweep. P10's `on_study_deleted` cascade only
   collects/marks (decrements refs); the post-commit union sweep that actually reclaims orphaned
   blobs is P1's (ITEM-14).

---

## Items

- **ITEM-1**: **`ObjectStore` trait + local-FS content-addressed impl.** A domain-neutral blob
  substrate behind one seam, distinct from `ziee-file` (user-scoped, uploads-only, UUID-keyed, not
  content-addressed). Ops: `put(reader)->ContentKey`, `put_prefix(dir)->Key` (multi-file artifacts:
  Zarr chunk-dir / BAM+bai), `get(&Key)->bytes`, **`get_range(&Key, byte_range)->impl AsyncRead`**
  (the range-native primitive the whole data plane rides — S3-byte-range-shaped from day one),
  `stat(key)->{len}`, `exists`, `delete`, `open_write()->staging handle`, `gc(keep_set)`. Keys =
  `sha256:<hex>` content hash (DEC-D3). Local layout `<app_data>/workstore/blobs/<aa>/<bb>/<full-hash>`
  (2-level fan-out); writes staged to a temp file, hashed while streaming, atomically `rename`d
  (dedup: existing key ⇒ drop temp, one physical copy). Reuse `ziee-file`'s `reject_if_symlink` +
  `ensure_dir` hardening. `object_store/s3.rs` is a compiled `todo!()` stub/seam (not built).
  Content-addressing gives free dedup + cache + the immutability the provenance/verification path
  needs.

- **ITEM-2**: **`artifacts` / `analysis_results` catalog table + migration + sqlx repository.**
  Host-owned (resolution #1). One small Postgres row per **produced typed artifact** (= per declared
  output, NOT per job): `id uuid PK` (surrogate, FK target); `study_id uuid FK` (tenancy scope);
  `run_id uuid` nullable (the producing run; NULL for source/upload artifacts — the `dataset`
  placeholder folds in here as a source artifact, not a parallel table); `output_id text` (manifest
  slot name, e.g. `expression`/`alignment`); **`datatype text`** (opaque to P1, validated against
  P2's registry — NOT an enum/FK); `storage_layout text`
  (`chunked-dense|chunked-sparse|columnar-table|chunked-1d|opaque`); `object_key text` (content hash,
  or a prefix for multi-file); `content_hash text` (merkle/manifest hash — ITEM-6); `shape jsonb`;
  `params jsonb`; `covered_axes jsonb` (which canonical-axis ranges this artifact spans, refs
  ITEM-3 — NA-alignment); `status text` (`pending|ready|failed`); `size_bytes bigint`; `created_by`;
  `created_at/updated_at`. **Natural key `(study_id, run_id, output_id)` UNIQUE** (idempotent
  re-ingest) + the surrogate uuid. Indexes on `(study_id, datatype)`. sqlx compile-time `query_as!`
  per `dataset/repository.rs` incl. the `timestamptz as "c: DateTime<Utc>"` chrono override gotcha +
  `provision_build_db`. CRUD: `insert_artifact`, `get`, `list_by_study`, `list_by_run`, `set_status`,
  `delete` (row + schedules blob GC, never touches a still-referenced blob). **The catalog's
  producer→artifact derivation edges ARE the provenance graph (resolution #2)** — P4 attaches to
  `run_id`/`content_hash`; no separate provenance tables.

- **ITEM-3**: **Canonical cell/gene axes + dense view-index subsystem** (r1's subsystem, restored;
  `axes.rs` + migration `202607200002_workstore_axes.sql`). The join keys every artifact aligns to
  "by construction" (`PLATFORM_ARCHITECTURE.md §5`, `DATA_MODEL.md §canonical-axes`).
  - `workstore_cell_axis(study_id, system_cell_id bigint, sample_id uuid, cell_local_index int,
    view_index int)` — `system_cell_id` is a **study-unique, stable surrogate** (NOT the input
    barcode, which isn't unique across samples); durable identity `(sample_id, cell_local_index)`;
    `view_index` is a **dense `0..M-1`** packing for the hot path (WebGL / binary slicing) with
    **prefix-sum `base_S` per-sample offsets** so each sample occupies a contiguous `[start,end)`.
  - `workstore_gene_axis(study_id, gene_id, gene_index int)` — dense gene column axis.
  - `axes.rs` provides: append-only assign/extend on source ingest (a new sample extends the
    view-index tail, never renumbers → stable offsets); a sample→`[start,end)` range map; bitmask
    cell-set ops over the dense view-index; `obs['sample']` categorical; and **NA-fill outside
    covered cells** (an artifact covering a subset writes `covered_axes`; readers/aligners NA-fill
    outside it). **View-index alignment is a first-class host/kernel concern, not per-extension**
    (DEC-D2): an extension emits values in ITS row order + declares coverage; the host maps onto the
    canonical dense index. Gives integer-indexed reads + bitmask set-ops instead of string-hash joins.

- **ITEM-4**: **Storage-layout encoding contract (Zarr/Parquet/as-is) + codec/layout abstraction.**
  Served arrays stored as **Zarr(v3)** (dense/sparse-CSC), tables as **Parquet**, self-indexed
  genomics/structure (`.vcf.gz+.tbi`, BigWig, BAM, mmCIF) **as-is** (`DATA_MODEL.md
  §storage-technology`). **No HDF5-specific Rust in the serving path**; HDF5→Zarr conversion, when
  needed, is a **P3 sandbox precompute** (Python has the writers). P1's host stores already-encoded
  bytes + the `storage_layout` tag; a thin server-side codec trait
  (`ArtifactCodec{ layout(); read_typed(selector) }` dispatched on layout, **keyed on layout not
  domain** — single-cell un-privileged, so P2 can extend additively) backs the Tier-2 fast path
  (ITEM-9). The expression/CSC gene-column codec (`indptr[g..g+1]→indices/data`) is the first + hot
  path.

- **ITEM-5**: **Write-path ingest of a run's `/outputs` produces-manifest** (P3-co-owned contract).
  `workstore::ingest_run_outputs(study_id, run_id, workspace) -> Vec<ArtifactRef>`, called by P3's
  job-completion hook. Reads `<workspace>/outputs/manifest.json` deserialized via the **P3-owned
  canonical `OutputsManifest` struct** (A1): `OutputsManifest { outputs: Vec<OutputEntry> }` where
  `OutputEntry { id: String, datatype: String, path: String, layout: String, role: String }`
  (`DATA_MODEL.md §"one job → many output files"`). P1 **imports** this P3-owned struct — it does NOT
  define its own (the old P1 shape `{output_id, datatype, from, layout?}` is retired). Per
  `OutputEntry`: hash + `put`/`put_prefix` (from `entry.path`) into the object store, compute the
  merkle `content_hash` (ITEM-6), insert one catalog row (`status=ready`; the row's `output_id`
  natural-key component is taken from `entry.id`, `datatype`←`entry.datatype`,
  `storage_layout`←`entry.layout`), stamp `covered_axes` + reindex onto the canonical axes (ITEM-3).
  One run → **N artifact rows** (the provenance fan-out). **Atomic per run**: all rows land `ready` or
  the run is `failed`. **Undeclared files** (logs/temp) are **NOT promoted** — captured only as run
  metadata (P4). **Gotcha:** `sandbox::run_analysis` deletes its per-job workspace on return, so the
  `/outputs` RW `ExtraMount.host_path` must point OUTSIDE the workspace (a
  `<app_data>/workstore/staging/<run>/` dir the ingest reads before cleanup) — P3 wires the mount,
  P1's ingest reads the staging dir. P1 tests this contract against a synthetic fixture `/outputs`; P3
  **owns** the `OutputsManifest` struct + the shared JSON-schema; P1 is a CONSUMER that imports it.

- **ITEM-6**: **Multi-file / merkle content identity.** A helper computing an artifact's
  `content_hash` as a merkle/manifest hash over its member `(relative-path, blob-hash)` set (Zarr
  prefix, BAM+bai); a single-file artifact = the one blob's hash. A small `manifest.json`
  (path→blob-hash) is itself a blob; member blobs keyed by their own `sha256`. One prefix ⇒ **one
  node, one content identity** (DEC-multifile). Enables P4's set-valued run output-signature +
  in-sandbox re-run verification (all N hashes match). Streaming, one-time at ingest.

- **ITEM-7**: **Data API control plane (JSON, typed — normal OpenAPI/aide `ApiClient`).**
  Study-scoped, permission-gated: `GET /api/studies/{s}/artifacts` (catalog list: datatype + shape +
  layout + status, filterable by `datatype`/`run_id`/`output_id`, without opening a blob),
  `GET /api/artifacts/{id}` (one artifact's typed metadata), `GET /api/studies/{s}/catalog` (samples,
  analyses `{kind,id,shape,layout}`, obs/var columns, N/G), + a DE table endpoint
  `.../artifacts/{id}/de?sort&filter&page` (server-side sort/filter/paginate → small JSON page,
  `§3.4`). Every handler authorizes through `study::repository::effective_permission(user, study_id)`
  (Viewer+ read, Editor+ write/delete); a foreign study → 404. Wire types flow through `emit_ts` →
  `types.ts`, parity test green.

- **ITEM-8**: **Data plane Tier-1 — authed, study-scoped HTTP-Range/206 byte serving.**
  `GET /api/artifacts/{id}/data[/{path}]` (+ `Range:` → `206 Partial Content` +
  `Content-Range`/`Accept-Ranges: bytes`; full `200` when no Range; `416` on unsatisfiable),
  `Content-Type: application/octet-stream`, streaming from `ObjectStore::get_range` (axum
  `Body::from_stream`, no full-buffer). The `{path}` suffix serves a member INSIDE a multi-file
  artifact (a Zarr chunk key, a `.bai`) so client decoders (zarrita/igv.js/Mol*) range-read chunks.
  The **dumb, domain-neutral** range server `DATA_MODEL.md` Tier-1 requires — VCF+tbi/BigWig/BAM/
  mmCIF/Zarr all serve through it; the browser owns the decoder; **no format-specific Rust**. **Auth
  on every byte** (DEC-D4) — permission + study scoped per request, NOT a static file server, NOT
  routed through uploads-only `ziee-file`. Reuse `ziee-file`'s **download-token** JWT pattern
  (`DownloadTokenClaims`, `aud: ziee-download`, made **study-scoped**) so a viewer streaming hundreds
  of chunk ranges doesn't re-auth each range but can't escape its study. Range parse + `206` assembly
  is net-new (ziee-file serves `200` octet only).

- **ITEM-9**: **Data plane Tier-2 — server-side typed-binary layout slicer** (the interactive fast
  path; `DATA_MODEL.md` Tier-2 — e.g. color-a-500k-cell scatter by gene = one sparse column).
  `POST /api/artifacts/{id}/slice` with a **layout-keyed, domain-neutral** selector: `chunked-sparse`
  → CSC column slice (`indptr[g..g+1]→indices/data`, the gene-column hot path); `chunked-dense` →
  N-D hyperslab; `columnar-table` → column/page; `chunked-1d` → range. Returns **raw little-endian
  typed-array binary** (a tiny header `n` + `Uint32Array` row/index + `Float32Array` value,
  back-to-back — **NOT Arrow, NOT JSON-of-numbers**), `application/octet-stream` +
  `X-Workstore-Dtype`/`X-Workstore-Shape` headers. Keys on **storage layout, never data domain** —
  single-cell un-privileged. The semantic-selector→layout-index mapping (gene→column, cell→row) is
  declared by the datatype (**P2 owns the mapping**) and **uses ITEM-3's `gene_index`/`view_index`**;
  P1 slices the generic layout via a `LayoutResolver` seam P2 fills. Zarr-served arrays can skip this
  (client range-decodes per ITEM-8); the slicer exists for the non-Zarr fast path + the sparse CSC
  gene-column. This item ships behind the P2 seam last.

- **ITEM-10**: **OpenAPI-honest binary responses.** Declare the Tier-1/Tier-2 endpoints as
  `content: application/octet-stream, schema: {type: string, format: binary}` via a ~3-line aide
  `OperationOutput` over axum `Bytes`/a range body (the existing sentinel `Json<BlobType>` →
  `emit_ts` `Blob` convention is the fallback shape). The spec describes the *wire* (opaque bytes);
  the endpoint's `datatype` describes the *decoded* shape. Keeps the byte-sensitive `types_ts_parity`
  golden test green and generation deterministic. **Regen BOTH binaries** (`just openapi-regen` →
  `ui/` + `desktop/ui/`) after routes land.

- **ITEM-11**: **Frontend thin binary data-plane client** (the FE-10 `emit_ts` workaround). The
  SDK's `createApiClient`/`callAsync` always `JSON.parse` — raw `ArrayBuffer` must not hit it. Ship a
  hand-written fetch helper (`src-app/ui/src/core/workstore/` — `binaryClient.ts` + `catalog.ts` +
  `index.ts`) reusing the SDK's token-inject / base-url / 401-refresh path but calling
  `response.arrayBuffer()`, with a hand-typed surface (`fetchArtifactRange(id,path,range)->ArrayBuffer`,
  `sliceColumn(id,selector)->{row:Uint32Array,value:Float32Array}` zero-copy to WebGL,
  `catalog(sid)->JSON`). Shape is fixed by the endpoint's datatype so the typed wrapper is safe. The
  generated `ApiClient` keeps the JSON control-plane calls. **Clean long-term deferred** (flag to
  SDK/live1): teach `emit_ts`/`callAsync` a per-response `responseType` (`json|arraybuffer`) so the
  one generated client owns binary natively — NOT P1-blocking; keep the binary surface tiny.

- **ITEM-12**: **Study-lifecycle cascade** (register a `workstore` cleanup with live8's shared
  `delete_study_with_extensions` chokepoint — DEC-D5, resolution #3). `on_study_deleted(study_id)`:
  delete the study's catalog rows + axis rows + **decrement blob refs** for every `object_key`/
  manifest member (collect/mark only — the actual reclaim is ITEM-14's post-commit sweep).
  `on_study_duplicated`: deep-copy catalog rows + axes + **re-reference** (not re-upload —
  content-addressing makes duplicate a cheap ref-add) the same blobs; study-local ids stay valid
  (`§3.8`, no in-file id rewrite). Mirror `dataset/study_extension/`; the same seam other
  study-extensions use (a hook add, not a study-module rewrite). Read/write gated by the study role
  (owner/editor mutate, viewer read) + a `workstore::{read,write}` permission.

- **ITEM-13**: **Sync entity `Artifact` + study-scoped emit.** Add `SyncEntity::Artifact` to
  `modules/sync/event.rs` (+ the string mapping); the write path (ITEM-5) + delete emit
  `publish(Artifact, action, id, Audience::study(study_id), origin)` so a study's collaborators'
  devices refetch the catalog live. Notify-and-refetch only (no row data on the wire). **A5 — ONE
  entity name: P1 uses exactly `SyncEntity::Artifact`** (matches the P1-owned `artifacts` table).
  `SyncEntity::AnalysisResult` is **NOT** a separate entity (P10 is being corrected to emit
  `::Artifact` too) — do not add a second variant for catalog rows. **Verify `Audience::study(...)`
  exists in live8's sync at merge** (jobs used owner-scope seams); fall back to owner-scope +
  collaborator fan-out if absent.

- **ITEM-14**: **Standing Object-GC union-sweep** (`gc.rs` — P1-owned, resolution #3). A boot-time +
  periodic (~6h, mirrors `mcp/tool_calls/prune.rs`) sweep that reclaims content-addressed blobs
  referenced by **NO** live table — sweeping the **union** of every referencing table:
  `analysis_results` (object_key + manifest members) ∪ `ziee-file` (`files.checksum`) ∪ P4
  run-artifact links. A blob is deletable iff its content-hash appears in no referencing table. This
  is the backstop to ITEM-12's delete-time refcount (a crash between row-delete and blob-delete, or an
  orphaned staging temp, is reclaimed) and what makes cross-table dedup (a ziee-file file and an
  artifact sharing a checksum) safe to delete. **Enumerate referencing tables in ONE place (a
  `blob_refs()` registry)** so adding P4's link table can't be forgotten.

- **ITEM-15**: **Config + boot wiring + module registration.** `modules/workstore/config.rs`: resolve
  `workstore.root` (default `<app_data>/workstore` via `get_app_data_dir()`, + a
  `CYTO_WORKSTORE_DIR`/`CYTO_APP_DATA_DIR` override for per-worktree test isolation, matching
  `rootfs::data_root`); `workstore.gc_enabled`/`gc_interval_hours`; an `object_store_backend:
  local|s3` seam field (only `local` built). `init_working_store` in `lib.rs::build_app` (mirrors the
  existing `ziee_file::init_file_storage` call), installing `Extension(WorkstoreContext{ store:
  Arc<dyn ObjectStore>, catalog, axes })` handlers pull from. Register `WorkstoreModule` via
  `#[distributed_slice(MODULE_ENTRIES)]` (order ~25, after study/dataset). Desktop parity: it's a
  server-embedded foundational kernel module — rides desktop the same, **no `CORE_MODULE_BLOCKLIST`
  entry**. Boot log line reports store root + backend (`local-fs`).

- **ITEM-16**: **Tests (unit + integration, scoped to the module).** Unit: content-address key
  stability + dedup, merkle prefix hash, CSC gene-column slice correctness (indptr/indices/data),
  Range header parse / `206` / `416`, view-index prefix-sum + sample add/remove rebuild, NA-fill
  alignment, bitmask set-ops, GC reachability over the `blob_refs()` union. Integration (build DB +
  synthetic `/outputs` fixture, no real sandbox): ingest→catalog roundtrip, catalog list, DE page
  sort/filter/paginate, binary endpoint returns correct bytes, byte-range `206` (test against a real
  zarrita/igv.js range pattern — a subtly-wrong `206` breaks them silently), auth 403 cross-study,
  study-delete cascade, duplicate re-parent, sync emit via a probe, OpenAPI `types_ts_parity`.
  Follow the `jobs`/`dataset` harness (per-test UUID DBs).

---

## Files/modules

**New — `src-app/server/src/modules/workstore/`:**
- `mod.rs` — `WorkstoreModule` + `#[distributed_slice(MODULE_ENTRIES)]` (order ~25); boot wiring (ITEM-15).
- `config.rs` — store-root resolution + `ObjectStoreKind`/`object_store_backend` seam (ITEM-15).
- `object_store/mod.rs` — `ObjectStore` trait + `ContentKey` + merkle prefix hash (ITEM-1, ITEM-6).
- `object_store/local_fs.rs` — local content-addressed impl (put/put_prefix/get/`get_range`/staging) (ITEM-1).
- `object_store/s3.rs` — compiled `todo!()` stub/seam (feature-gated; not built).
- `catalog/models.rs`, `catalog/repository.rs` — `Artifact` row + sqlx repo (ITEM-2, ITEM-7).
- `axes.rs` — canonical cell/gene axes, dense view-index, bitmask set-ops, NA-fill, sample-range map (ITEM-3).
- `artifact/{mod,expression,embedding,clustering,de,obs}.rs` — layout codec trait + per-layout codecs (ITEM-4, ITEM-9).
- `ingest.rs` — `/outputs` manifest → objects + catalog + axis reindex + merkle hash (ITEM-5, ITEM-6).
- `routes.rs` — control + data-plane REST wiring (ITEM-7, ITEM-8, ITEM-9).
- `data_api.rs` / `range.rs` / `slice.rs` — Range/206 serving + typed slicer + octet `OperationOutput` (ITEM-8, ITEM-9, ITEM-10).
- `permissions.rs` — `WorkstoreRead`/`WorkstoreWrite` marker perms (ITEM-12).
- `study_extension/{mod,extension,repository}.rs` — cascade + sync (ITEM-12, ITEM-13).
- `gc.rs` — standing union-sweep + delete-time refcount (ITEM-12, ITEM-14).
- Migrations (`YYYYMMDDNNNN_workstore_*`, must sort AFTER current max `202607190005_jobs_grants`):
  `202607200001_workstore_catalog.sql`, `202607200002_workstore_axes.sql`,
  `..0003_workstore_obsvar_columns.sql`, `..0004_workstore_grants.sql`.

**New — frontend:**
- `src-app/ui/src/core/workstore/{index.ts, binaryClient.ts, catalog.ts}` — thin binary client (ITEM-11).

**Modified:**
- `src-app/server/src/modules/mod.rs` — `pub mod workstore;`.
- `src-app/server/src/lib.rs` (`build_app`) — `init_working_store` next to `init_file_storage` (ITEM-15).
- `src-app/server/src/modules/sync/event.rs` — `SyncEntity::Artifact` (ITEM-13).
- `src-app/server/Cargo.toml` — a Zarr writer/reader (`zarrs` — verify v3 maturity), `parquet`+`arrow`,
  `blake3` or reuse `sha2`/`hex` (content hash), `roaring`/`bitvec` (server-side cell-set bitmasks),
  `bytes`, `tokio` fs/io (present). **Avoid the native `hdf5` crate** (links libhdf5 — host + rootfs
  system dep) unless DEC-D6 is reversed.
- `openapi.json` + `api-client/types.ts` in **both** `ui/` and `desktop/ui/` via `just openapi-regen` (ITEM-10).
- `modules/dataset` — note the seam (a processed dataset's `expression` artifact lands in the catalog
  as a source artifact `run_id NULL`); coordinate with P11 data-io — P1 keeps the seam, doesn't wire
  dataset-upload fully.

---

## Reuse

- **`sdk/crates/ziee-file`** — reuse the `FilesystemStorage{base_path}` handle + `reject_if_symlink`/
  `ensure_dir` hardening (`storage/filesystem.rs`) and the `download_with_token()` JWT-scoped-token
  shape as templates. **Do NOT route artifact data through it** (uploads/UUID-blob-only, not
  content-addressed, not study-scoped, no range — verified). Its sha256 `checksum` is the precedent
  hash (aligns with DEC-D3) and a cross-table dedup source ITEM-14's union-sweep must include. It is
  **ALREADY a wired server dependency on merged main** (`63520fb`): the dep + migrations +
  `init_file_storage` + the multipart **dataset upload** receiver already exist server-side (A7 —
  the stale analysis-workflow tree lacks them, but P2/P10/P11 correctly assume them). So P1 does **NOT**
  rebuild the upload/multipart path — it builds its content-addressed store + catalog + range serving
  **on top of** the existing ziee-file store + dataset-upload wiring.
- **`modules/dataset`** — the exact sqlx-compile-time repo + dated-migration + study-scoping +
  `ModuleEntry`/`AppModule` + multipart/`ingest_bytes` idioms (incl. the chrono `timestamptz`
  gotcha). The `dataset` placeholder folds into the catalog as a source artifact (DEC-D1), not a
  parallel table.
- **`modules/study` + `STUDY_EXTENSIONS`** — `effective_permission` (Owner/Editor/Viewer) verbatim
  for every route; the shared `delete_study_with_extensions` chokepoint +
  `on_study_deleted`/`on_study_duplicated` hooks for ITEM-12 (`dataset/study_extension` is the copy
  template).
- **`modules/permissions.rs::RequirePermissions<…>`** — the JSON control-plane gates.
- **`modules/sync`** — `SyncEntity` + `publish` (study-scoped notify-and-refetch) for `Artifact`.
- **`modules/jobs` + `modules/sandbox`** — catalog rows reference `run_id`/`job_id`; ITEM-5's
  `ingest_run_outputs` is called BY P3's `JobRunner→sandbox::run_analysis` wiring (the `ExtraMount`/
  `MountMode` seam is the compute→results handoff). P1 does not touch the runner.
- **`mcp/tool_calls/prune.rs`** — the boot-time + periodic prune-loop shape is ITEM-14's GC template.
- **`ziee_core::app_state::get_app_data_dir`**, aide/axum/sqlx patterns, the per-test-UUID-DB
  integration harness.
- **Legacy `sc-website`/`sc-task-queue`** — the CSC gene-column slice (`p[g..g+1]→i/x`),
  server-mediated streaming, and `systemCellId` split are the proven designs ITEM-3/4/9 reimplement
  cleanly (`DATA_STORAGE_REDESIGN §1`).

---

## Dependencies

- **P1 depends on (the ONE hard upstream): P10 study-substrate** (live8, already merged on this
  branch) — `study` module + `STUDY_EXTENSIONS` + `effective_permission` (Owner/Editor/Viewer) + the
  `delete_study_with_extensions` chokepoint P1 registers into (ITEM-12/DEC-D5). Nothing else upstream —
  P1 is the kernel foundation.
- **P1 is depended on by EVERYTHING (it is THE critical path):**
  - **P2 datatype-system** — consumes ITEM-2's `datatype`/`storage_layout` columns + ITEM-9's layout
    slicer; owns the `datatype` *meaning* (subtyping lattice, validators, viewers) + the
    selector→layout-index mapping via a `LayoutResolver` seam P1 exposes. P1 owns the *table + slicer*
    (resolution #1). P1 builds ITEM-1..8,10..16 with a minimal placeholder layout enum, then wires
    ITEM-9 against P2's registry.
  - **P3 compute-scheduling** — owns the `JobRunner→sandbox::run_analysis` producer + the scientific
    rootfs (scanpy/anndata/zarr) + `.h5ad→Zarr` conversion; calls ITEM-5 `ingest_run_outputs` on
    completion. The `/outputs` produces-manifest `OutputsManifest` struct + JSON-schema is **P3-owned
    (A1); P1 is a CONSUMER that imports it** — field names `id/datatype/path/layout/role`. P1's write
    path is inert (testable via synthetic manifest) until P3 exists.
  - **P4 provenance** — attaches run nodes to ITEM-2 `run_id` + uses ITEM-6's set-valued content
    hashes for re-run verification; ITEM-14 sweeps P4's run-artifact links. **P4 owns only
    capture-logic + code-blob store + reproduce; the derivation-edge graph IS P1's catalog**
    (resolution #2).
  - **P6 workbench**, **P7 viz** + **P8 interaction-dsl** — read via ITEM-7/8/9/11 (typed arrays →
    WebGL) and set-op over ITEM-3's dense view-index bitmask.
  - **P9 ai-mcp** — catalog as an MCP resource.
  - **P11 three-modules** (data-io/embedding/clustering) — first real producers/consumers of the
    write + read + slice paths (validates the vertical slice); not a blocker.

---

## Sequencing

1. **ITEM-15** config + **ITEM-1** ObjectStore (local-FS) + **ITEM-2** catalog + **ITEM-3** axes —
   the storage primitives, largely parallel; nothing else compiles without them.
2. **ITEM-4** layout encoding contract + **ITEM-5** ingest + **ITEM-6** merkle hash — the write path
   (needs 1+2+3), tested against a synthetic `/outputs` fixture. Codec order: **`expression` (CSC
   gene-column) first** (the hot path), then embedding/clustering/obs/de.
3. **ITEM-7** control-plane → **ITEM-8** Tier-1 Range serving → **ITEM-9** Tier-2 slicer (behind the
   P2 `LayoutResolver` seam, last); **ITEM-10** OpenAPI honesty rides 7/8/9.
4. **ITEM-11** FE thin binary client — after ITEM-8/9 endpoints are live (unblocks P7 viz).
5. **ITEM-12** cascade + **ITEM-13** sync + **ITEM-14** GC — after catalog + object store exist
   (ITEM-12 needs the study delete chokepoint).
6. **ITEM-16** tests — unit alongside each item; integration after ITEM-8.

**Vertical-slice checkpoint** (aligns `BUILD_PLAN §Re-sequencing`): ingest one real `embedding`
artifact from a fixture `/outputs` → catalog → stream it as binary to the client. Prove the path
before breadth. Build **ITEM-1..8 + 10 + 15 first** (unblocks P3/P11); ITEM-9 second once P2's
LayoutResolver exists.

---

## Decisions

- **D-format (DEC-D6, the central one) — served store = Zarr(v3) arrays + Parquet tables +
  self-indexed genomics/structure as-is; host = dumb authed range server; NOT server-sliced HDF5.**
  `DATA_MODEL.md` + `BUILD_PLAN.md` (newer, general) supersede the single-cell `DATA_STORAGE_REDESIGN`
  (older, HDF5+Rust-slicer). Zarr chunk-as-object → client range-decode (the Vitessce model): (a) no
  native-libhdf5 system dep, (b) format-agnostic range serving generalizes to P2's other datatypes,
  (c) client-side decode (zarrita) removes a whole Rust slicing surface. Keep a **thin server-side
  typed-binary slice** (ITEM-9) as the Tier-2 fast path over the SAME Zarr-sparse-CSC store.
  HDF5→Zarr conversion, when needed, is a **P3 sandbox precompute**, not host code. **Flag to human —
  a genuine reversal of the redesign doc's HDF5 assumption; ripples into P3 (rootfs zarr/anndata +
  `.h5ad→Zarr`) and P11 (compute writes Zarr not HDF5); settle with P3 before compute lands.**
- **D-hash (DEC-D3) — content-address = `sha256:<hex>`.** Deterministic, dedup-enabling, matches
  ziee-file's `checksum` + the provenance/cosign hashing vocabulary. blake3 is faster for multi-GB
  artifacts; the `ObjectStore` key is opaque so it's swappable if a hot-path profile demands it — pin
  ONE with P4 for verification parity.
- **D-catalog-owner (DEC-D1, resolution #1) — P1 owns the *table*, P2 owns the *type meaning*.** The
  single `artifacts`/`analysis_results` table lives in P1 with `datatype`/`storage_layout` as plain
  string columns opaque to P1; P2 owns the registry that gives them meaning + the
  selector→layout-index mapping (ITEM-9). `datatype` is `TEXT` validated against P2's registry, NOT a
  closed enum/FK. The `dataset` placeholder folds in as a source artifact (`run_id NULL`).
- **D-provenance (resolution #2) — the provenance graph IS the catalog's derivation edges.** No
  separate `provenance_*` tables; P4 attaches to `run_id`/`content_hash` and owns only capture-logic +
  code-blob store + reproduce.
- **D-axes (DEC-D2) — canonical axes + dense view-index are a first-class P1 kernel subsystem.** r1↔r2
  divergence resolved in favor of building it; view-index alignment is the host's job, not each
  extension's. r2's bare `covered_scope` JSONB is subsumed by `covered_axes` referencing the real
  axis registry (ITEM-3).
- **D-catalog-key — surrogate `uuid` PK + study-local natural key `(study_id, run_id, output_id)`
  UNIQUE** (idempotent re-ingest + portable export/import/duplicate with no in-file id rewrite, `§3.8`).
- **D-multifile-artifact — one Zarr store (dir of chunk objects) / BAM+bai = ONE artifact** (one
  merkle/manifest content identity); a run producing N typed outputs = N artifacts sharing one run
  node. Don't conflate.
- **D-serving-auth (DEC-D4) — the data plane is a dedicated authed, study-scoped Range endpoint,**
  every byte `effective_permission`-gated; NOT the `ziee-file` download path, NOT a static server.
  This is *why* the host mediates reads.
- **D-object-store-seam — `get_range(key, byte_range)` is S3-byte-range-shaped from day one;** local-FS
  is the only impl built; `s3.rs` is a compiled stub.
- **D-two-planes / D-wire (DEC-D7) — JSON control plane on the generated `ApiClient`; binary data
  plane on a hand-written fetch helper (FE-10) until the SDK grows `responseType`.** Wire = raw
  little-endian typed-array `ArrayBuffer` — **no Apache Arrow, no DuckDB-WASM, no JSON-of-numbers** on
  the live wire (`DATA_MODEL/§2·Q2`). OpenAPI declares `application/octet-stream` to keep
  `types_ts_parity` green (ITEM-10).
- **D-produce-atomically — a run's N outputs are one atomic ingest** (ITEM-5); each is an
  independently-addressable catalog row downstream binds to.
- **D-blob-GC (DEC-D5, resolution #3) — study-delete is the *chokepoint* (P10/live8's
  `delete_study_with_extensions`, P1 registers `on_study_deleted` decrementing refs); the standing
  P1-owned union-sweep GC (ITEM-14) is the *safety net*.** Blob deletion gated on "referenced by no
  live table across the union." Two mechanisms, not a conflict.

---

## Risks

- **Zarr-v3 Rust maturity (TOP build risk).** Verify `zarrs` covers v3 write + sparse/CSC chunking +
  sharding; if immature, fall back to writing Zarr chunks as plain content-addressed blobs with a
  hand-written `.zarray`/`.zmetadata` (still zarrita-readable), or reconsider HDF5 (native-lib cost).
  Resolve the DEC-D6 spike FIRST — it gates ITEM-4 onward.
- **Format tension (DEC-D6) ripples into P3** (rootfs must ship zarr/anndata + the `.h5ad→Zarr`
  convert) **and P11** (compute writes Zarr not HDF5). Must be settled with P3 before compute lands.
- **HDF5 native-lib** — any HDF5 keeps the `hdf5` crate → host + rootfs system dep + cross-compile
  pain. Zarr-first avoids it.
- **P1↔P3 manifest-contract drift** — a mismatched `OutputsManifest` silently drops outputs. **A1: P3
  OWNS the canonical `OutputsManifest { outputs: Vec<OutputEntry{id,datatype,path,layout,role}> }`
  struct + JSON-schema; P1 imports it (does not redefine).** Guard with a round-trip test (synthetic
  manifest → ingest → catalog rows) using the P3-owned struct.
- **Range-serving correctness** — off-by-one `Content-Range`, multi-range, `416` on unsatisfiable,
  large-file streaming without buffering. igv.js/zarrita are strict; a subtly-wrong `206` breaks them
  silently. Test against a real range pattern.
- **Byte-range auth cost** — a viewer streams hundreds of chunk ranges; per-request JWT verify is hot.
  The one-scoped-token model (reused across ranges) mitigates; confirm it's **study-scoped**, not just
  user-scoped.
- **View-index stability under sample add/remove** — append-only keeps existing offsets stable, but
  **sample DELETION would renumber**. Mitigate: soft-delete / tombstone a removed sample's `[start,end)`
  (NA it) rather than compacting, so downstream `covered_axes` never dangle. Also ensure the O(M)
  view-array re-concat is once-per-live-set-change, not per read. (Flag for P4/P10.)
- **Multi-file artifact hash cost** — merkle-hashing a large Zarr prefix on ingest is O(chunks);
  acceptable one-time, but stream it, don't re-read (ITEM-6).
- **Cross-table dedup deletion hazard** — a blob shared by `ziee-file` and an artifact must not be
  deleted while either references it; ITEM-14's union-sweep is the guard, but the refcount union MUST
  include every referencing table. Enumerate them in ONE place (a `blob_refs()` registry) so adding
  P4's link table can't be forgotten.
- **OpenAPI binary + `types_ts_parity`** — the golden parity test is byte-sensitive; the octet
  `OperationOutput` must generate deterministically or `just openapi-regen` diverges across the two UI
  workspaces.
- **Study-scoped sync audience** — verify `Audience::study(...)` exists in live8's sync at merge (jobs
  used owner-scope seams); fall back to owner-scope + collaborator fan-out if absent.
- **P2 reopening the layout seam** — if the `ArtifactCodec`/`storage_layout` seam isn't general enough,
  P2 becomes a rewrite. Key the trait on *layout*, not *domain*, now.
- **`artifacts` vs `datasets` overlap** — DATA_MODEL says dataset ≡ analysis-output ≡ typed artifact;
  the `dataset` placeholder folds in as a source artifact (DEC-D1). Confirm with P2/P11 whether
  `datasets` becomes a thin view or is fully subsumed.
- **`DATA_MODEL` is a proposal, not built** — P1 is its first real implementation; expect discovery on
  axis-alignment + sparse-CSC slicing + multi-file Zarr layout. Build ITEM-3 with the single-cell
  2–3-type slice first, seam open.

---

## Effort

Medium-large — the platform's critical path, front-loaded on the Zarr-crate spike (DEC-D6, resolve
first, gates ITEM-4 onward). Rough split (one focused engineer):
- ITEM-1 ObjectStore + ITEM-15 config: ~2–3 d
- ITEM-2 catalog + ITEM-3 axes: ~3–4 d (axes/view-index is the highest-novelty piece — new migration
  + `axes.rs` + its own unit tests)
- ITEM-4 layout encoding + codecs (Zarr/Parquet, expression CSC first): ~4–6 d (dominated by the Zarr
  spike)
- ITEM-5 ingest + ITEM-6 merkle + manifest contract: ~2–3 d
- ITEM-7/8/9/10 data API (control + Tier-1 range + Tier-2 slice + OpenAPI honesty): ~4–5 d (range +
  slice are correctness-sensitive; ITEM-9 gated on P2's LayoutResolver, can land in a second pass)
- ITEM-11 FE thin client: ~1–2 d
- ITEM-12 cascade + ITEM-13 sync + ITEM-14 GC: ~2–3 d
- ITEM-16 tests: ~3–4 d (interwoven)

**Total ≈ 20–29 dev-days / one focused foundation effort** ("one owner for Phase 0"). Unit-testable in
isolation (object store, axes set-ops/alignment, manifest ingest, GC reachability); integration needs
the study substrate + a stub sandbox producing an `/outputs` manifest. Highest-leverage effort in the
program — everything downstream (P2/P3/P4/P6/P7/P8/P9/P11) is blocked until it lands.

---

## Saturation

r3 was explicitly authored as the union of r1 + r2 and introduced **nothing substantively new** beyond
that union: it added no new work item (its ITEMs are the r1∪r2 set with r1's canonical-axes subsystem
and r2's standing GC sweep both present), no new dependency (the P2/P3/P4/P10/P11 graph is identical),
and its Decisions D1–D7 are **explicit *resolutions* of already-surfaced disputes** (axis-vs-covered_scope,
GC-chokepoint-vs-sweep, catalog-owner) rather than new scope — which is exactly the cross-part ownership
carve-up this FINAL bakes in. Its two finer additions (the sample-*deletion* view-index tombstone risk,
and the single-place `blob_refs()` registry mitigation) are refinements *within* r1's axes subsystem and
r2's GC subsystem, not new subsystems, items, or dependencies. r1 and r2 had already independently
derived the same critical-path spine (`DIFF_R1_R2.md` "Shared substance"); r3 only closed the one real
gap (r1's axes absent from r2) and picked positions. Three independent passes have converged.

SATURATION: REACHED
