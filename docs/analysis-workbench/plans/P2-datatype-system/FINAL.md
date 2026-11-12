# P2 — Datatype System (FINAL — consolidated from r1 ∪ r2 ∪ r3)

## Reconciliation applied
- **A1 — canonical `OutputsManifest` (P2 is a CONSUMER).** The `/outputs/manifest.json` contract is **owned and
  written by P3**: Rust `OutputsManifest { outputs: Vec<OutputEntry> }`,
  `OutputEntry { id: String, datatype: String, path: String, layout: String, role: String }` (serde-serializable).
  P2 **imports the P3 struct — it does NOT define its own** — and for each output entry validates
  `OutputEntry.datatype` against its live registry (unknown → typed 422) and resolves `OutputEntry.layout` to a
  reader, replacing P2's prior `id`/`type` field names (see ITEM-15 below).

**Scope (PLANNING_INDEX):** the **open datatype registry** (Galaxy model: dataset ≡ analysis-output ≡ typed
artifact) + **subtyping lattice** + **artifact *typing*** + **storage layouts keyed on LAYOUT, not domain**
(dense / sparse / columnar / 1-d — single-cell is NOT privileged) + **viewers-per-datatype dispatch** +
**sniff / ingest / convert** model. Datatypes self-register. Desktop + single-box, local-FS arm only; keep
every cross-part seam open, build only the near-term local slice.

**P2 is the SEMANTIC layer. It owns NO table.** (See Decisions DEC-1.) P2 gives meaning to `artifacts.datatype`
and `artifacts.layout` — registry, subtype-check, schema validation, layout→reader dispatch, sniff/convert,
viewer dispatch — all keyed off a P1-owned `artifacts` catalog row. Grounded in `DATA_MODEL.md`,
`PLATFORM_ARCHITECTURE.md §1/§4.2/§5/§5.5`, `docs/DATA_STORAGE_REDESIGN.md`, `BUILD_PLAN.md` Phase 0/1, and the
actual code at main `63520fb` (`modules/dataset`, `modules/study`, `modules/analysis`, `sdk/crates/txresbench-file`,
viz `viz-core/{grid,data/wire.ts}`).

---

## Items

### Registry core
- **ITEM-1 — Type contract (Rust + TS, authored once, mirrored).** The `Datatype` descriptor and its component
  types: `Datatype { id, extends: Option<String>, title, description, schema: JsonSchema, storage: StorageSpec,
  capabilities: Vec<String>, viewers: Vec<ViewerRef>, ingest: Option<IngestSpec>, converters: Vec<ConverterRef>,
  abstract: bool }`; `StorageSpec { layout: LayoutKind, format, selectorMap }`; `LayoutKind = ChunkedDense |
  ChunkedSparse{CSC|CSR} | ColumnarTable | Chunked1d | OpaqueAsIs`; `ViewerRef { viewKindId, family, consumes/params }`;
  `ConverterRef { from, to, run: Host|Sandbox, entry? }`; `IngestSpec`; `TypeSelector { type, subtypesOf, multiple,
  required, capabilities }`. Rust struct + TS interface stay in sync (parity-gated, ITEM-7).
- **ITEM-2 — `DATATYPES` distributed-slice + self-registering registry (both languages).** Built-ins
  self-register at link time via `#[distributed_slice(DATATYPES)]` — a direct mirror of
  `dataset/study_extension/extension.rs`'s `STUDY_EXTENSIONS` and `MODULE_ENTRIES`; `DatatypeEntry { id, extends,
  constructor }` mirrors `StudyExtensionEntry`. A `DatatypeRegistry` folds every entry at boot, published as a
  process-wide `OnceCell<Arc<DatatypeRegistry>>`. TS: a `DatatypeRegistry` singleton mirroring
  `modules/analysis/registry.ts` (`register/all/isA/accepts/viewersFor`). Open replacement for the closed
  `Kind`/`DataKind`/`ResultKind` enum + `AnalysisRegistry`.
- **ITEM-3 — Subtyping lattice + resolver.** Build the lattice from `extends` edges at boot; validate it
  (no cycles, every `extends` target resolves, single implicit root `data`, no duplicate ids — **fail boot with
  a clear error**). Core queries the whole platform gates on: `is_a(sub, super) -> bool` (walk `extends`),
  `ancestors(id)`/`supertypes(id)`, `descendants(id)`. Compatibility = `is_a` (the Galaxy lattice lesson: an
  analysis `accepts: matrix` matches `single-cell/anndata` because it `is_a matrix`).
- **ITEM-4 — Type-match / gating resolver (the gating primitive).** `matches(artifact_datatype,
  TypeSelector{type, subtypesOf, capabilities}) -> bool` (= `is_a` when `subtypesOf`, else exact-id, ∧ capability
  check) + `available_for(artifact) -> Vec<contribution_id>` + `compatible_artifacts(selector, &[Artifact]) ->
  Vec<&Artifact>`. Generalizes the closed `requires: DataKind[]`/`produces` gating (PLATFORM §1.2) to typed
  `accepts`/`produces` with subtyping. **One declaration does two jobs** — gates analysis availability AND
  generates the artifact-ref picker (PLATFORM §4.3 Tier-2) AND lets the AI planner chain compatible tools.
- **ITEM-5 — Capabilities vocabulary.** A small **open** string set an artifact/datatype advertises
  (`sliceable`, `has-obs`, `has-var`, `categorical`, `obs-aligned`, `genomic-coords`, …), consumed by
  gating/viewer/DSL code (e.g. the cell-set DSL needs `has-obs`/`categorical`).
- **ITEM-6 — Seed built-in datatype set (proves lattice + all layouts).** ~6–8 self-registering entries in both
  languages: `data` (abstract root) → `tabular` (abstract) → `matrix` (abstract supertype) →
  {`single-cell/anndata` (concrete, `ChunkedSparse{CSC}`, caps `sliceable`/`has-obs`/`has-var`), `embedding`
  (concrete, `ChunkedDense`)}; `clustering` (concrete, `columnar`/codes+categories, caps
  `categorical`/`obs-aligned`), `metadata-column`, `de`/`table` (`ColumnarTable`), `report/html`
  (`OpaqueAsIs` blob). Abstract types exist only as gating supertypes (no artifact is ever *directly* of an
  abstract type). `variant/vcf`, `structure/pdb`, `genome/bigwig`, `image/ome-tiff` are documented **later
  registry entries** — seam open, NOT built now.
- **ITEM-7 — Rust↔TS parity gate.** A shared golden fixture (`tests/lattice_golden.json`: the seed lattice + a
  matrix of `is_a`/`accepts` cases) validated identically by a Rust test and a TS test — mirror
  `openapi::emit_ts::tests::types_ts_parity`. Prevents host-gating-vs-UI-picker divergence.

### Storage layouts + data plane
- **ITEM-8 — Storage-layout vocabulary + selector→index mapping.** The `LayoutKind` enum + a `SelectorMap` that
  maps a datatype's *semantic* selectors (gene→column, cell→row, locus→range, residue→index) to layout indices.
  A datatype **declares which layout its artifacts use** + the selector map; the host slices the *layout*, never
  the domain. Keep the map an open `HashMap<semantic_selector, LayoutIndexRef>` (don't over-fit to single-cell).
- **ITEM-9 — `LayoutSlicer` server seam (deferred impl).** A `trait LayoutSlicer { fn slice(layout, selector) ->
  TypedBinary }`, domain-neutral, one impl per `LayoutKind`, for optional server-side **Tier-2** typed slicing
  (the 60fps hot path). **Not implemented near-term** — the client zarrita path (ITEM-11) covers the interactive
  case; keep the seam, near-term at most ship sparse (gene-column) + dense (column) slicers if the hot path
  demands it. Reads from P1's physical range endpoint.
- **ITEM-10 — Tiered data-access routing (a datatype property).** Per artifact, resolve to **Tier-1** (authed
  byte-Range + client decode — the DEFAULT, zero host format code), **Tier-2** (layout-slice, opt-in per
  datatype+layout), or **Tier-3** (precompute-as-analysis for novel formats). A datatype declares which tier(s)
  its storage supports; the data API picks. Host provides exactly two domain-neutral capabilities: authed range
  serve (P1) + layout slice (ITEM-9).
- **ITEM-11 — Client reader-dispatch data plane (the default path).** `core/datatypes/dataSource.ts`
  **generalizes viz `viz-core/data/wire.ts`** (`DataSource`/`DatasetCatalog`/`ColumnKind`): given
  (artifact, selector), issue HTTP-Range requests to P1's authed byte-range endpoint and decode **client-side**
  (zarrita for Zarr, DuckDB-WASM/Arrow for Parquet, igv.js/Mol* for as-is genomics/structure). Served formats:
  arrays→**Zarr v3**, tables→**Parquet**, self-indexed genomics/structure→**as-is**. **Rust serving path stays
  codec-free** (bytes only).

### Typing the artifact (over P1's table)
- **ITEM-12 — Schema-validation hook.** `validate.rs::validate(datatype, shape) -> Result` (reuse in-tree
  `schemars`/`jsonschema`), called from **P1's ingest** before a row lands; also validates the `datatype`
  **string** against the live registry (unknown → typed 422). No enum/FK (DEC-1/DEC-2). Seed shape-only
  validators for the concrete seed types.
- **ITEM-13 — Sniffer.** `sniff.rs`: ordered ext+magic detection (Galaxy sniff order) → candidate datatype;
  wired into P1's artifact-create/upload route so an upload becomes a **typed source artifact** (`source=true`).
  Generalizes the current `dataset` `set_uploaded` flow.
- **ITEM-14 — Multi-file artifact model (one artifact = N physical files, presents as ONE typed node).**
  `storage_ref` is a prefix/manifest; the datatype declares `FileLayout { Single | Prefix | Manifest(files[]) }`;
  the reader assembles (Zarr chunk dir, BAM+bai, mtx+barcodes+features). Content identity = **merkle/manifest
  hash over the file set** → one `content_hash` per artifact regardless of file count.
- **ITEM-15 — Multi-output run ingest (one run → N typed artifacts; fan-out).** P2 **consumes the P3-owned
  canonical `OutputsManifest` (A1)** — `{ outputs: [OutputEntry{id, datatype, path, layout, role}] }`, imported
  from P3's `sandbox/outputs.rs`, NOT a P2-local `{id, type, from}` shape. For each `OutputEntry`, P2 validates
  `datatype` against its live registry (unknown → typed 422), resolves `layout` to a reader, and types each
  declared output as its own artifact row (recording `datatype`/`layout`) sharing `produced_by_run_id`. Undeclared
  files (logs/temp) are NOT promoted (captured as run metadata by P4). **Produce-atomically / consume-individually**
  — downstream binds one specific typed output, never "the job". Gated on P3 manifest + P4 run node.

### Ingest transforms
- **ITEM-16 — Ingest + converter registry model.** `IngestSpec` (uploaded file → this type) + `ConverterRef[]`
  (Galaxy-style conversions between types). The general implicit-converter graph (auto-insert an `A→B` edge when
  an analysis `accepts: B`) is **declared but deferred** — explicit convert first.
- **ITEM-17 — Host-lite converters (the P3-independent fallback).** `convert.rs`: `csv/tsv → Parquet`;
  `h5ad → Zarr` via **kerchunk-virtualize** (a small JSON reference index into the untouched `.h5` — no rewrite,
  no sandbox). Decouples the vertical slice's real anndata ingest from P3. (DEC-6b: to keep the Rust host path
  codec-free, prefer routing even `csv→parquet` through a host-lite DuckDB step or the sandbox rather than
  pulling the Rust `parquet` codec into the server; confirm at implementation.)
- **ITEM-18 — Sandbox converter dispatch (P3 seam).** The same `ConverterRef` registry dispatches `run: Sandbox`
  converters (`h5ad → AnnData-Zarr` full convert via anndata/zarr in the scientific rootfs) through P3's
  JobRunner. Soft dep — decoupled by ITEM-17.

### Viewers-per-datatype
- **ITEM-19 — Viewer dispatch resolver.** `viewers.ts::viewersFor(datatype)` resolves **up the subtype lattice**
  (a `matrix`-family viewer applies to `single-cell/anndata`) → `ViewerRef[]`. **P2 dispatches, never renders**
  (DEC-7): each `ViewerRef.viewKindId` points at a renderer in **P7's future `registerViewKind` view-kind
  registry** (deck.gl matrix-family) or an external family (`molstar`/`igv`). Co-design the `ViewerRef`/`consumes`
  contract with P7's `switch(CellKind) → registerViewKind` refactor.

### Surfaces / integration
- **ITEM-20 — REST introspection + typed catalog view.** `GET /api/datatypes` (dump the live registry: lattice
  + capabilities + layouts + viewer refs, for the FE mirror + pickers); `GET /api/artifacts/{id}/catalog` (P1 row
  ⊗ registry → the `DatasetCatalog`-shaped payload viz already expects); `GET /api/studies/{id}/artifacts?type=
  &subtypesOf=` (server-side type-filtered query for the auto-populated Tier-2 artifact-ref pickers).
  aide-documented (OpenAPI → `emit_ts` → `types.ts`), behind study-read auth. Also feeds P9's MCP datatype/catalog
  resources (the AI world-model).
- **ITEM-21 — FE datatype registry mirror + population.** `core/datatypes/` runtime registry populated from
  `GET /api/datatypes` at boot (single source = backend; **no hand-maintained TS union**), exposing `isA`,
  `viewersFor`, `matches`, `artifactsOfType(studyId, selector)` — driving the canvas viewer dispatch (feeds P7)
  + the `artifact-ref` auto-populated Select pickers.
- **ITEM-22 — Registry ↔ P1 ingest/catalog integration seam.** Define the exact function signatures P1's write
  path calls (`validate(datatype, shape)` + `sniff(bytes/ext)` before a row lands, recording `datatype`/`layout`
  in the catalog) and the read/slice path (P1's generic slicer reads `layout` + `SelectorMap` from
  `registry.get(datatype)`). P2 exposes the registry; P1 calls it. `artifacts.datatype` stays `TEXT`.
- **ITEM-23 — Anti-regression test: open `artifacts.datatype`.** Ship a test asserting `artifacts.datatype` is
  **`TEXT`, with no closed enum, no CHECK constraint, and no FK to a datatypes table** — guards the whole open
  model against P1 boundary creep (DEC-1/R2).
- **ITEM-24 — `dataset` placeholder → typed source-artifact.** The placeholder `datasets` table is superseded by
  P1's `artifacts` table (dataset = source artifact, `source=true`, `produced_by_run_id=NULL`, sniffed
  `datatype: single-cell/anndata` or `file/*` pre-ingest). **P1 owns that migration + data migration**; P2 gives
  the rows their type meaning (sniff/validate). Keep the module's FE surface/routes and the
  `dataset/study_extension` `on_study_deleted` cascade seam intact (reframe the model underneath it).
- **ITEM-25 — P5 handoff.** When `@txresbench/workbench-api` is extracted, re-export ITEM-1's type contract as the
  `datatypes` contribution point (alongside `analyses`/`plotTypes`); **no logic moves** — it already lives in
  `core/`. No block on P5.
- **ITEM-26 — Tests (unit + parity + integration).** Enumerated in the test section below; the exit-condition
  test suite for this part.

---

## Files / modules

**Backend — NEW `src-app/server/src/modules/datatype/` (P2 adds NO migration):**
- `mod.rs` — `DatatypeModule` (`AppModule` + `#[distributed_slice(MODULE_ENTRIES)]`, order ~15, before
  `dataset`=20); `pub static DATATYPES: [DatatypeEntry]` distributed slice (mirror `study_extension`); boot-time
  `DatatypeRegistry::build()`. **[ITEM-2]**
- `types.rs` — `Datatype`, `StorageSpec`, `LayoutKind`, `FileLayout`, `SelectorMap`, `ViewerRef`, `IngestSpec`,
  `ConverterRef`, `TypeSelector`, `abstract`. **[ITEM-1]**
- `registry.rs` — lattice build + `is_a`/`ancestors`/`descendants` + cycle/orphan/dup validation +
  `matches`/`available_for`/`compatible_artifacts`. **[ITEM-3, ITEM-4]**
- `builtin.rs` — the ~6–8 seed `#[distributed_slice(DATATYPES)]` statics + their `validate` impls. **[ITEM-6, ITEM-5]**
- `layout.rs` — `LayoutKind` + `SelectorMap` + the `LayoutSlicer` trait (deferred impl). **[ITEM-8, ITEM-9]**
- `validate.rs` — `validate(datatype, shape)` + datatype-string check → 422. **[ITEM-12]**
- `sniff.rs` — ext+magic ordered detection. **[ITEM-13]**
- `convert.rs` — `ConverterRef` registry + host-lite (csv→parquet, h5ad→zarr kerchunk) + sandbox dispatch. **[ITEM-16, ITEM-17, ITEM-18]**
- `routes.rs` — `GET /api/datatypes`, `GET /api/artifacts/{id}/catalog`, `GET /api/studies/{id}/artifacts?type=&subtypesOf=`. aide-documented. **[ITEM-20]**
- `tests/lattice_golden.json` — shared parity fixture. **[ITEM-7]**
- Hooks *into P1*: `validate`/`sniff` called from P1's ingest + artifact-create; tiering + multi-file/fan-out
  typing over P1 rows. **[ITEM-14, ITEM-15, ITEM-22]**

**Frontend — NEW `src-app/ui/src/core/datatypes/` (core/, NOT a feature `modules/` — survives the P5 package
extraction unmoved):**
- `types.ts` — TS mirror of the type contract. **[ITEM-1]**
- `registry.ts` — `DatatypeRegistry` singleton (mirror `modules/analysis/registry.ts`): `isA`/`accepts`/
  `viewersFor`/`artifactsOfType`; populated from `/api/datatypes` at boot. **[ITEM-2, ITEM-21]**
- `builtin.ts` — TS seed lattice. **[ITEM-6]**
- `layouts.ts` — `LayoutKind` + selector map. **[ITEM-8]**
- `dataSource.ts` — client reader-dispatch, generalizes viz `viz-core/data/wire.ts`. **[ITEM-11]**
- `viewers.ts` — `viewersFor` subtype-aware resolver over P7's registry. **[ITEM-19]**
- `lattice.parity.test.ts` — TS half of the golden parity gate. **[ITEM-7]**

**Coordinated edits (other parts' files, contract-only):**
- P1's `artifacts` migration/ingest — call P2 `validate`/`sniff`; keep `datatype TEXT` (no enum/CHECK/FK). **[ITEM-22, ITEM-24]**
- P7's `viz-core/grid/CellView.tsx` (+ `adapter/PopoutWindow.tsx` twin) `switch(CellKind) → registerViewKind` —
  P2 supplies `ViewerRef` ids. **[ITEM-19]**
- `modules/dataset/{models,repository,routes,study_extension}.rs` + FE — reframed onto the artifact model;
  keep the study cascade seam. **[ITEM-24]**

---

## Reuse

- **`dataset/study_extension/extension.rs` `STUDY_EXTENSIONS`** — the `linkme::distributed_slice` + trait +
  `OnceCell` fold-at-init pattern is copied verbatim for `DATATYPES`/`DatatypeRegistry` (+ the empty-registry
  no-op test shape).
- **`dataset/mod.rs` `MODULE_ENTRIES`** — the `AppModule` boilerplate for `DatatypeModule`.
- **`modules/analysis/registry.ts` `AnalysisRegistry` singleton** — same shape → the TS `DatatypeRegistry`; its
  `Kind` union is the closed vocab being generalized.
- **txresbench `web_search` `catalog()`** — set-in-code registry with only per-instance config in DB → the no-table
  registry model (DEC-2).
- **viz `viz-core/data/wire.ts` `DataSource`/`DatasetCatalog`/`ColumnKind`** typed-binary framing → `dataSource.ts`
  client data plane (ITEM-11); it already targets real `GET /datasets/{id}/…` octet endpoints.
- **viz `viz-core/grid/{gridModel.ts,CellView.tsx}`** closed `CellKind` union + exhaustive switch → P7's
  `registerViewKind`; P2's `ViewerRef` contract is what feeds that registry.
- **`sdk/crates/txresbench-file` (`ingest.rs`, `FilesystemStorage`)** — the physical blob backing P2 sniffs/converts
  into (P1 owns the store; P2 references it).
- **`dataset/{models,repository,routes}.rs`** — CRUD/aide scaffolding template + the sqlx compile-time `query_as!`
  discipline (+ the `timestamptz as "c: DateTime<Utc>"` override gotcha) for typed catalog reads.
- **`openapi::emit_ts::tests::types_ts_parity`** — the golden-parity test pattern → the Rust/TS lattice parity
  gate (ITEM-7).
- **In-tree `schemars`/`jsonschema`** (already used for MCP params) → datatype shape validation (ITEM-12).
- **`DATA_STORAGE_REDESIGN.md` §3.1/§3.5/§3.7** — the single-cell kind-typed HDF5/CSC layout is the concrete
  instance of `ChunkedSparse{CSC}`; generalize its per-kind readers into per-layout slicers.
- **Legacy `imports/types/{Embedding,Clustering,DEAnalysis,Enrichment}.ts`** — source-of-truth for each seed
  datatype's shape/capabilities.

---

## Dependencies

- **P1 (data-foundation) — HARD.** Owns the `artifacts` table + blob store + authed byte-Range endpoint + the
  ingest seam that calls P2 `validate`/`sniff`, AND the `datasets→artifacts` cutover migration. P2 is a semantic
  layer *over* P1. **P2 can be authored in parallel** (ITEM-1/2/3/4/5/6/7/8/19 have no P1 dep); ITEM-12/13/14/
  20/21/22/24 integrate with P1's table+ingest. **P1 must add CAS/content-hash keying** (`txresbench-file` is today
  UUID-pathed per-user with a `checksum` column but no content-addressing) that ITEM-14's `content_hash` assumes.
- **P3 (compute) — SOFT (common-path).** Sandbox converters (ITEM-18) + the multi-output `/outputs` manifest
  (ITEM-15) — P2 **imports P3's canonical `OutputsManifest`/`OutputEntry`** (A1) and consumes its `datatype`/
  `layout` fields. Decoupled by the kerchunk host-lite fallback (ITEM-17) so real anndata ingest works without P3.
- **P4 (provenance) — feeds/blocks ITEM-15.** `produced_by_run_id` FK targets P4's run node; P4 owns the fan-out
  edges + dead-output reachability. Every typed artifact is a provenance node.
- **P5 (contribution-api) — CONSUMES P2.** Re-exports ITEM-1 as the `datatypes` contribution point (ITEM-25);
  external manifest-loaded datatypes register into the same `DATATYPES` registry. **No block** — P2 ships in
  `core/` first.
- **P7 (visualization) — JOINT contract.** Consumes ITEM-19's dispatch; implements `switch→registerViewKind` +
  renderers. Co-design `ViewerRef`/`consumes` before P7's refactor lands.
- **P9 (ai-mcp) — CONSUMES P2.** The typed-artifact graph + subtyping = the AI planner's world model (ITEM-20 MCP
  resources).
- **P10 (study-substrate) — already built (live8).** Artifacts are study-scoped (`study_id` FK,
  `EffectivePermission`); the `on_study_deleted` cascade over typed artifacts reuses the `dataset/study_extension`
  seam. Provides study-read auth for ITEM-20.
- **P11 (three-modules) — CONSUMES P2.** embedding/clustering declare `accepts: matrix`/`accepts: embedding` +
  `produces` against this registry; their outputs are typed artifacts; exercises the seed datatypes end-to-end.

---

## Sequencing

1. **ITEM-1 → ITEM-2 → ITEM-3 → ITEM-4** — type contract, registry, subtype lattice, type-match resolver (pure,
   no DB, no P1; both languages). Foundation everything sits on; ship with unit tests.
2. **ITEM-7** — Rust↔TS parity gate (locks the lattice before consumers build on it).
3. **ITEM-5 + ITEM-6** — capabilities vocab + seed the 6–8 datatypes (now the lattice is populated + testable).
4. **ITEM-8 + ITEM-10 + ITEM-19** — layout vocabulary + tier routing + viewer resolver (registry-only; define the
   joint P1/P7 contracts here).
5. **After P1 lands the `artifacts` table + ingest seam:** ITEM-12 validate hook, ITEM-13 sniffer, ITEM-11 client
   data plane, ITEM-20 introspection/catalog, ITEM-21 FE mirror, ITEM-22 integration seam, ITEM-23 anti-regression
   test.
6. **ITEM-17** host-lite converters (unblocks real anndata without P3); **ITEM-16** converter registry;
   **ITEM-18** sandbox converters when P3 is ready.
7. **ITEM-14** multi-file typing; **ITEM-15** multi-output ingest (gated on P3 manifest + P4 run node — keep the
   single-output path working meanwhile).
8. **ITEM-9** `LayoutSlicer` seam stays a trait (no impl near-term).
9. **ITEM-24** dataset→source-artifact reframe (after the artifact model is stable; P1 owns the migration).
10. **ITEM-25** P5 handoff when `@txresbench/workbench-api` is extracted (no logic moves).
11. **ITEM-26** integration/parity/FE tests last.

Steps 1–4 are fully parallel to P1; steps 5+ gate on P1's table + P10's auth.

---

## Decisions

- **DEC-1 — P1 OWNS the `artifacts`/catalog table; P2 owns NO table.** P2 is the semantic layer (registry,
  subtype-check, schema validation, layout dispatch, sniff/convert, viewer dispatch) keyed off
  `artifacts.datatype`/`artifacts.layout`. Straight from the corpus: `DATA_MODEL` "catalog … Postgres (the
  host-owned index)"; `PLATFORM §5.5-B` "Extensions don't own catalog tables"; `BUILD_PLAN` Phase-0a
  "Working store + catalog" = P1's scope. The `artifacts` table replaces the placeholder `datasets` table (the
  "dataset ≡ analysis-output ≡ typed artifact" unification); that migration is a **P1 deliverable**. *This
  overrides r1/r2's "P2-owns-the-table" stances.*
- **DEC-2 — No `datatypes` DB table; `artifacts.datatype` is `TEXT` validated against P2's live registry.**
  **No closed enum, no CHECK, no FK.** The registry is in-process, code+manifest seeded via
  `#[distributed_slice(DATATYPES)]` (Rust) + a TS singleton — the proven `STUDY_EXTENSIONS`/`AnalysisRegistry`/
  `web_search catalog()` pattern. A new datatype = a registry entry, **zero migration**. Baking a closed enum
  re-closes the Galaxy model — **P2 ships a test asserting P1 didn't** (ITEM-23/R2). Stale rows referencing an
  uninstalled-extension datatype degrade to a generic "unknown datatype" card (fail-soft, mirror
  `memory_admin_settings.enabled`), never crash.
- **DEC-3 — The registry lives in P2 core; P5's `@txresbench/workbench-api` CONSUMES it.** Registry logic + seed
  lattice + validation/dispatch = P2, in both languages, near-term resident in app **core**
  (`server/src/modules/datatype/` + `ui/src/core/datatypes/` — deliberately `core/`, not a feature `modules/`,
  so it survives the P5 extraction unmoved). When P5 extracts `@txresbench/workbench-api`, it re-exports P2's contract
  as the `datatypes` contribution point. No hard block on P5.
- **DEC-4 — Layouts keyed on LAYOUT, not domain.** `{ChunkedDense, ChunkedSparse{CSC|CSR}, ColumnarTable,
  Chunked1d, OpaqueAsIs}` — the Zarr/TileDB/Arrow model. A new **datatype** is a registry entry (no core change);
  a new **layout** is a rare core change. Single-cell CSC is one layout, equal to dense/columnar/1d — **no domain
  privilege**. The fast path lives on the layout, never the domain.
- **DEC-5 — Served formats Zarr v3 / Parquet / as-is; client-side decode is the DEFAULT.** Tier-1 (authed range +
  client decode, zero host format code) default; Tier-2 layout-slice opt-in per datatype+layout for the
  interactive hot path; Tier-3 precompute-as-analysis for novel formats. **Rust serving path is codec-free**
  (byte-Range only); writes happen in Python/sandbox.
- **DEC-6 — Converters split host-lite vs sandbox.** Host-lite = `csv→parquet`, `h5ad→zarr` **kerchunk-virtualize**
  (the P3-independent fallback that decouples the vertical slice); sandbox = `h5ad→zarr` full via P3. Implicit
  Galaxy auto-conversion **declared but deferred** — explicit convert first. **DEC-6b:** to keep the Rust host
  path codec-free, prefer routing even `csv→parquet` through a host-lite DuckDB step or the sandbox rather than
  pulling the Rust `parquet` codec into the server; confirm at implementation.
- **DEC-7 — P2 resolves datatype→`ViewerRef[]`; P7/external families render. P2 never renders.** Viewer dispatch
  resolves UP the lattice (a supertype viewer covers subtypes). `Datatype.viewers` names viewer **ids**, not
  components; each id resolves in P7's future `registerViewKind` registry.
- **DEC-8 — Compatibility = subtype `is_a` for `accepts`; supertype walk for viewer fallback.** Rust/TS
  subtype-check + seed lattice guarded by the shared golden-fixture parity test (ITEM-7).
- **DEC-9 — Near-term seed = ~6–8 types** (`data`, `tabular`, `matrix`, `single-cell/anndata`, `embedding`,
  `clustering`/`metadata-column`, `de`/`table`, `report/html`) covering dense/sparse/columnar/opaque + a 3-deep
  chain. bulk/spatial/variant/structure = later registry entries; seam open, populate incrementally.
- **DEC-10 — Abstract vs concrete.** `data`/`tabular`/`matrix` are ABSTRACT (gating supertypes only; no artifact
  is ever *directly* of an abstract type). `abstract: bool` on `Datatype`; validation forbids an artifact whose
  `datatype` is abstract.
- **DEC-11 — Multi-file = one merkle content hash; multi-output = N artifacts per run** (produce-atomically /
  consume-individually). Single `extends` chain (not multiple inheritance) near-term; flag multi-parent (e.g.
  `spatial/visium is_a matrix AND is_a image`) as a future lattice generalization.
- **DEC-12 — Local-FS for desktop+1-box.** `storage_ref` is a filesystem prefix under the study dir; object
  storage (MinIO/S3) is a later P1 swap behind the same `storage_ref`. P2 records only the *layout*, not the
  served-format decision (P1's).

---

## Risks

- **R1 — Rust/TS registry drift** (host gating ≠ UI picker) → the DEC-8 golden parity gate (ITEM-7); FE derives
  its mirror at runtime from `/api/datatypes`, no hand-copied TS union.
- **R2 — P1 boundary creep**: a closed `datatype` enum/CHECK/FK on `artifacts` re-closes the model → DEC-2
  `TEXT`+registry-validation + the ITEM-23 anti-regression test. **Now settled by DEC-1**, but must be verified
  against the P1 plan (the historical HIGH catalog-ownership collision is resolved: one table, P1-owned).
- **R3 — Common-path ingest depending on P3** (`h5ad→zarr`) → DEC-6 kerchunk host-lite fallback (ITEM-17)
  decouples the vertical slice; sequence sandbox conversion (ITEM-18) + multi-output (ITEM-15) late.
- **R4 — Viewer-dispatch double-ownership with P7** → DEC-7 joint `ViewerRef`/`consumes` contract, agreed before
  P7's switch→registry refactor.
- **R5 — `@txresbench/workbench-api` absent (P5)** → DEC-3 ship in `core/`, extract later; no block.
- **R6 — Rust Zarr/Parquet tooling maturity** → mitigated: serving is byte-Range only (no Rust codec); writes in
  Python/sandbox; DEC-6b keeps the host codec-free.
- **R7 — Over-building Tier-2 slicers** → ship only the client zarrita path near-term (ITEM-11); the
  `LayoutSlicer` server seam (ITEM-9) stays a trait; at most sparse+dense server-slice if the 60fps hot path
  demands it.
- **R8 — Schema-validation scope creep** → near-term schemas validate **shape only**; keep minimal.
- **R9 — Selector→index mapping over-fit to single-cell** → keep it an open `HashMap<semantic_selector,
  LayoutIndexRef>`; a novel datatype whose selectors map to no layout routes to Tier-1 client-decode or Tier-3
  precompute.
- **R10 — Existing `dataset` module churn** → keep the `dataset/study_extension` study-cascade seam; only reframe
  the data model underneath it (ITEM-24); P1 owns the `datasets→artifacts` cutover ordering.
- **R11 — Scope creep to "general bioinformatics workbench"** → hold the near-term line at the single-cell seed
  set with the seam open, per DATA_MODEL's honest-scope note.

---

## Effort

- ITEM-1/2/3/4 (contract + registry + lattice + type-match, pure): **M** (~1.5–2 d) — mechanical mirror of
  `STUDY_EXTENSIONS`/`AnalysisRegistry` + a small graph; `is_a`/validation is the new logic.
- ITEM-5/6/7 (capabilities + seed set + parity gate): **M** (~1 d).
- ITEM-8/9/10/11 (layouts + slicer seam + tier routing + client data plane): **L** — the technically deepest;
  bounded by shipping only the client zarrita path near-term (server slicer deferred).
- ITEM-12/13 (validate + sniff hooks, over P1): **M** (~1 d), gated on P1 ingest seam.
- ITEM-14/15 (multi-file + multi-output fan-out): **M**, ITEM-15 gated on P3/P4.
- ITEM-16/17/18 (converter registry + host-lite + sandbox): **M** — one kerchunk `h5ad→zarr` + `csv→parquet`
  near-term.
- ITEM-19 (viewer dispatch resolver): **S–M**, joint contract with P7.
- ITEM-20/21 (REST + FE mirror): **M** (~1.5 d), gated on P1 catalog + P10 auth.
- ITEM-22/23/24 (P1 seam + anti-regression test + dataset reframe): **M**, coordinated with P1.
- ITEM-25 (P5 handoff): **S** — a re-export, no logic move.
- ITEM-26 (tests): **M** (~1.5 d) across unit/parity/integration/FE.

**Total: Large** (~one of the biggest foundation parts alongside P1). **Front-loaded value:** ITEM-1–4/7 (~4 d,
fully parallel to P1) unblock P3/P5/P6/P7/P11 gating immediately; the layout/tier depth + P1 integration land
incrementally behind Tier-1 client-decode. No catalog-ownership reconciliation cost remains (DEC-1 settles it).

### Test enumeration (ITEM-26)
- **Rust unit:** `is_a` chains + `ancestors`/`descendants`; `matches`/`accepts_match` (subtype ∧ capability,
  exact-vs-subtype); cycle/orphan/dup-id rejection; empty-registry no-op; seed datatypes resolve; `sniff`
  (ext+magic→datatype, ambiguous order); `validate` (good/bad shape, unknown-datatype→422); registry
  build-from-slice completeness; abstract-type-rejected-on-artifact.
- **Parity (ITEM-7):** `lattice_golden.json` → Rust result == TS result (subtype + accepts matrix).
- **TS unit:** `DatatypeRegistry.isA`/`accepts`/`viewersFor` (lattice-walk); `dataSource` Range-URL construction
  per layout/selector (sparse gene-column, Parquet row-group, as-is passthrough).
- **Integration (with P1):** upload→sniff→typed source-artifact row; `GET /api/datatypes` returns the seeded
  lattice; `compatible_with=matrix` selects a `single-cell/anndata` artifact but not a `clustering` one;
  write-path validation rejects a shape mismatch; `GET /api/artifacts/{id}/catalog` matches viz `DatasetCatalog`
  shape; kerchunk `h5ad` roundtrip (client reads a gene column via range).
- **Anti-regression (ITEM-23):** `artifacts.datatype` is `TEXT` — no enum/CHECK/FK (guards DEC-1/DEC-2/R2).

---

## Saturation

r3 added three substantive things beyond r1∪r2, all of which are **product-relevant and now folded in**: (a) the
**sniffer** (ext+magic ordered detection as a first-class ingest step — r1/r2 only implied typing on ingest,
neither had a Galaxy-style sniff order); (b) the **kerchunk-virtualize host-lite `h5ad→Zarr` converter as the
explicit P3-independent fallback** (r2 had an ingest/converter model but treated the real anndata conversion as
sandbox/P3-bound; r3 makes the vertical slice runnable without P3); and (c) the **client reader-dispatch data
plane generalizing viz `wire.ts`** as the concrete default path (r1/r2 described Tier-1 client-decode
abstractly but didn't name the existing `DataSource`/`DatasetCatalog` code to generalize). Beyond those, r3's
primary contribution was **decisional, not new scope** — it definitively settled the P1-owns-the-table /
no-P2-table / registry-in-core / viewer-resolver-over-P7 questions that r1 (co-owned table) and r2 (P2-owned
table) had left diverged, which is exactly the DIFF_R1_R2 "DIVERGED — needs r3" verdict being resolved. The
underlying type-system substance (open registry, subtype lattice, type-match gating, layout-keyed storage,
multi-file/multi-output, unified typed artifact, viewers-per-datatype) is identical across all three rounds. No
new *work item* class has appeared that a fourth round would be expected to surface; the remaining open edges
(multi-parent lattice, implicit converter graph, server Tier-2 slicer) are already captured as deferred seams.
**SATURATION: REACHED**
