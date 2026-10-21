# P11 — The three modules (the vertical slice): data-io · embedding · clustering

The end-to-end proof that a single-cell workflow (upload → QC/normalize → embed → cluster → explore) is
buildable as **three no-Rust extensions** under `extensions/{data-io,embedding,clustering}/`, each a
**manifest (`extension.yaml`) + sandboxed Python/scanpy `compute/*.py` + declarative `schema/*.json`
(params + settings) + thin `ui/*.tsx` over `@cyto/workbench-api`**, composed purely through the typed
artifact graph (`accepts`/`produces`) and never importing one another. P11 builds **zero kernel machinery**;
it *consumes* P1–P10 and is the acceptance test that "add a feature = drop a folder, kernel unchanged." If a
module reaches for Rust, that's a gap in P1–P8 to fix in-kernel, not a P11 item.

Grounding: promotes the interface-round seed plugins
(`ui/src/modules/analysis/analyses/{qc-filter,normalize-lognorm,pca,umap,leiden}/plugin.tsx` — descriptor
shape: id/category/requires/produces/params/defaults/methodsText) from FE-mock → declarative manifest + real
sandbox compute; ports the legacy R/Seurat compute
(`sc-website-scripts/{data-process,embedding-create,clustering-create,save-sample}.R` + `utils/h5Parse.R` +
`server/job-templates/*.ts` onCompleted hooks) → Python/scanpy; and reuses the legacy forms'
(`New{Embedding,Clustering}Form.tsx`, `CellFilteringFormItems.tsx`, `UploadForm.tsx`) param logic as
declarative schemas.

---

## Items

### Module 1 — data-io (upload → sandboxed QC/normalize → save)
- **ITEM-1**: `extensions/data-io/extension.yaml` — manifest (`id: cyto.data-io`, `apiVersion:"^1.0"`) declaring
  `analyses: [data.process, save.sample]`; `views: [{samples, area:left, component:ui/UploadPanel},
  {qc-review, area:bottom, when:"has:qc-report", component:ui/QcReviewPanel}]`; `settings:[{id:qc-defaults,
  schema:schema/qc.settings.json}]`; `activation:[onView:samples, onAnalysis:data.process]`. Each analysis
  carries LLM-facing metadata (`description`/`when`/`examples`/`safety:read-run`) so P9 auto-emits the MCP tool.
  (§8.5 module-1 manifest verbatim is the template.)
- **ITEM-2**: `analyses.data.process` definition — `accepts:[{type:file/upload}]` (a host file-store handle; the
  ONLY root-input analysis) → `produces:[{id:expression,type:single-cell/expression},
  {id:qc_metrics,type:metadata-column,multiple},{id:qc,type:qc-report}]`. Multi-output run (one run → N
  artifacts). `run:{kind:sandbox,runtime:python,entry:compute/process.py}`,
  `schedule:{class:interactive|batch, resources:{cpu:2,mem:8Gi}}`.
- **ITEM-3**: `schema/process.params.json` — QC+normalize params JSON-schema grounded in the legacy vocabulary
  (`data-process.R` + `NewEmbeddingForm` preprocessing block + `CellFilteringFormItems`): read block
  `fileType(anndata/10x-h5/10x-mtx)`, `assay`, `cellIdColumn`, `featureIdColumn`, multi-sample split
  (`hasMultipleSamples` + `sampleIdIn/Delimiter/Position/Column`); QC block `{min_genes, max_genes,
  max_pct_mito (+mito_regex default ^MT-|^mt-), min_cells, strategy(adaptive|fixed), nmads,
  regress_mito/ribo/cellcycle toggles+gene lists}`; normalize block `{method(shifted-log/logNormalize|
  pearson|SCT), targetSum/scaling_factor default 10000, find_var_feature_method(vst), n_var_features/nHVG
  default 3000}`; `sample_id_filters` (artifact-ref multi). Renders via P6 host form-from-schema.
- **ITEM-4**: `compute/process.py` (sandboxed scanpy) — reads `/inputs/matrix.*` (h5ad via `anndata.read_h5ad`,
  10x via `sc.read_10x_h5`/`sc.read_10x_mtx`) + `/inputs/params.json` → per-cell QC
  (`sc.pp.calculate_qc_metrics`: n_counts, n_genes, pct_counts_mt, pct_counts_ribo) → threshold/adaptive-MAD
  filter → optional sample split (barcode-delimiter or obs column) → normalize (`normalize_total`+`log1p` or
  pearson residuals) + optional regress-out → HVG (`highly_variable_genes`, seurat_v3) → writes
  `/outputs/expression.zarr` (AnnData-Zarr, chunked-sparse CSC for fast gene-column slicing),
  `/outputs/qc_*.parquet` obs `metadata-column` artifacts (n_genes, pct_mito, total_counts),
  `/outputs/qc-report` (pre/post distributions + threshold cutlines + per-sample retained/removed incl. the
  "sample lost 28%" guardrail as real numbers; small parquet+JSON), and `/outputs/manifest.json` mapping paths
  → typed artifacts. Port read semantics from `utils/h5Parse.R` (CSC reconstruct, assay filter, categorical
  decode) — scanpy handles most natively.
- **ITEM-5**: `analyses.save.sample` + `compute/save.py` — takes the reviewed/accepted `expression`(+obs) →
  applies per-sample manual thresholds, materializes persisted named `sample` artifact(s) with nCells +
  carried embeddings (per-sample split when multi-sample: `sample_id_in`, delimiter/position from legacy
  `UploadForm`) → `produces:[{id:sample,type:single-cell/sample}]`. "Save" = host-ingest of typed outputs, NOT
  module storage code. (May collapse toward a persist/rename if the split happens in `data.process` — see D3.)
- **ITEM-6**: `schema/qc.settings.json` + declarative `settings:qc-defaults` (P5-A provisioner) —
  deployment-wide default QC thresholds an admin sets; host renders the admin card + gated GET/PUT + sync
  entity, **zero server code**; `data.process` params default from this row when unset.
- **ITEM-7**: `ui/UploadPanel.tsx` (code `view`, left dock) — thin panel over `@cyto/kit`+`@cyto/workbench-api`:
  drag-drop to the host **file store** (`ziee-file`, `api.files.upload`; types AnnData `.h5ad`, 10x
  `.h5`/`.zip`/`.tar.gz`, mtx trio), lists uploads → `uploaded-matrix` artifact, offers "Process" (opens the
  host-rendered `data.process` form). Client-side preview (assays, N cells, metadata cols) mirrors legacy
  `read-anndata`/`read-10X` — JS parse for preview only; real ingest is the sandbox. Reuses interface-round
  `SamplesPanel.tsx` shape.
- **ITEM-8**: `ui/QcReviewPanel.tsx` (code `view`, bottom dock, `when:"has:qc-report"`) — renders the
  `qc-report` artifact: pre/post-filter QC violin/histograms (n_genes, pct_mito, counts) with threshold
  cutlines, cells-kept/removed KPIs, per-sample table; **Accept** (→ `save.sample`) / **Re-run with new
  thresholds** (re-opens `data.process`). The one mildly-interactive surface (§4.4 code panel) — read-render +
  re-run, not a bespoke canvas; the QC-review JTBD affordance (a human must see what filtering did before
  committing). Reuses seed `qc-filter` advisory/KPI copy.
- **ITEM-9**: `report/qc` datatype + viewer registration — data-io declares the `report/qc` datatype (P2
  registry; small parquet/JSON storage layout, `viewers:[qc-review]`) so the QC panel is datatype-dispatched,
  not hardcoded. `report/qc` is the ONLY module-owned datatype; `single-cell/expression`, `matrix`,
  `metadata-column`, `embedding`, `clustering` are P2-core.

### Module 2 — embedding (sandboxed pca/umap → embedding; fieldProvider; scatter view-kind)
- **ITEM-10**: `extensions/embedding/extension.yaml` — `id: cyto.embedding`,
  `analyses:[embedding.pca, embedding.umap]`, `fieldProviders:[embeddings]`,
  `activation:[onAnalysis:embedding.pca, onAnalysis:embedding.umap]`; `recipeOrder` after data-io; LLM
  metadata + `safety:read-run`. References the built-in `scatter` view-kind for `coordinates`/`embedding`.
- **ITEM-11**: `analyses.embedding.pca` + `schema/pca.params.json` — `accepts:[{type:single-cell/expression}]`
  → `produces:[{id:reduced,type:embedding,subtype:pca}]`. Params from seed `pca` + `NewEmbeddingForm`:
  `{n_pcs/nComps 10–100 def 30, dim_reduction_method(tsvd), whiten, seed}`.
- **ITEM-12**: `analyses.embedding.umap` + `schema/umap.params.json` — `accepts:[{type:embedding,subtype:pca}]`
  (OR expression, computing a neighbor graph first) → `produces:[{id:embedding,type:embedding,
  subtype:umap-2d}]`. Params from seed `umap` + `NewEmbeddingForm`: `{n_neighbors 5–100 def 15/30, min_dist
  0.1–1 def 0.3/0.5, metric(euclidean|cosine) def cosine, spread def 1, seed}` (+ optional tSNE
  `perplexity 30` as a second method). `sample_id_filters`/`metadata_filters` as artifact-ref/cell-subset
  inputs.
- **ITEM-13**: `compute/pca.py` + `compute/umap.py` (sandboxed scanpy) — read `/inputs/expression.zarr`(obsm)
  → `sc.pp.scale`(opt) → `sc.tl.pca(n_comps)` → `sc.pp.neighbors` → `sc.tl.umap`; write `/outputs/*.zarr`
  (obsm `X_pca` / `X_umap` N×2, chunked-dense layout) + `manifest.json`. PCA emits a separate `reduced`/`pca`
  embedding artifact consumable by clustering.
- **ITEM-14**: `ui/EmbeddingFields.tsx` — registers a **`fieldProvider:embeddings`** into the P6 left-rail:
  lists the study's `embedding` artifacts (catalog query via `api.data.catalog()`), a click sets the active
  embedding as the scatter's coordinate source. No catalog SQL — declared `accepts` binds the artifact graph.
  Reuses interface-round `ColorByControl.tsx`/`ClusterLegend.tsx` patterns.
- **ITEM-15**: **Adopt live3's scatter as the built-in `scatter` view-kind.** Register
  `visualization-wt/.../viz-core/DeckScatterCanvas.tsx` (+ `ColormapScatterLayer`, `SelectableScatter`,
  `ChunkedScatter`) into the P7 **view-kind registry** with a declared data contract: `coordinates` N×2 from
  an `embedding` artifact (P1 typed-binary/zarrita range read), color-by from a `fieldProvider`
  (cluster/metadata/gene), selection wired to P8. Must pass P7's conformance battery
  (`viewKindBattery.test.ts`). The one view-kind the slice ships as built-in — the center-canvas hero. **Open
  cross-part boundary (see Decisions): whether the scatter is *owned/registered* by P11 or *provided* by P7.**
- **ITEM-16**: Harmony/integration decomposition (port note) — legacy `embedding-create.R` folds
  normalize+HVG+Harmony+PCA+UMAP into ONE job; the platform DECOMPOSES it (normalize→data-io, pca+umap→
  embedding, integration→a separate seeded `harmony` module). Carry ONLY PCA+UMAP scanpy logic here; a Harmony
  `integrated_by:sample` toggle is a noted seam, **out of P11 scope** (seed `harmony/plugin.tsx` is the 4th
  module template).

### Module 3 — clustering (sandboxed leiden/louvain → clustering; fieldProvider; selectionAction:subcluster)
- **ITEM-17**: `extensions/clustering/extension.yaml` — `id: cyto.clustering`,
  `analyses:[clustering.leiden, clustering.louvain]` (`accepts:[{type:embedding}] → produces:[clustering]`;
  gated until an `embedding` exists), `fieldProviders:[clusterings]`, `selectionActions:[{id:subcluster,
  when:"has-selection", command:clustering.subcluster}]`. LLM metadata + `safety:read-run`.
- **ITEM-18**: `analyses.clustering.leiden` + `schema/leiden.params.json` — **THE artifact-ref-picker case
  (§4.3 Tier-2).** Params from seed `leiden` + `NewClusteringForm`: `{embedding: artifact-ref, accepts:
  embedding, multiple:true, required:true; method(leiden|louvain|kmeans) def louvain; resolution 0.01–3 def
  0.6 (hidden unless graph method); n_neighbors def 15/20; distance_metric(euclidean|cosine); nPcs def 30;
  n_iterations def 10; seed; name templated "Cluster {embedding}"}`. The `embedding` field renders as a
  **host-populated Select of the study's `embedding` artifacts** (P6 form renderer + P2 catalog query) —
  the extension writes NO select code (replaces legacy `useEmbeddings()` hand-wiring). `accepts` doubles as
  the availability gate (clustering UI hidden until an embedding exists).
- **ITEM-19**: `compute/leiden.py` (sandboxed scanpy) — read `/inputs/embedding.zarr`(obsm) + params →
  `sc.pp.neighbors` (re)build kNN graph → `sc.tl.leiden`/`sc.tl.louvain(resolution)` → write
  `/outputs/clustering.zarr`/`.parquet` (obs categorical: `codes` Uint16 + `categories`, a
  `metadata-column`-shaped `clustering` artifact) + `manifest.json` (`type:clustering`). Deterministic on
  `seed`.
- **ITEM-20**: `analyses.clustering.louvain` — same `compute/leiden.py` entry, `algorithm=louvain` default
  (one script, param switch; mirrors the seed `leiden` plugin's algorithm advanced field).
- **ITEM-21**: Dynamic/dependent field — legacy `nCluster_{embeddingId}` per-embedding + kmeans-only
  visibility → declarative `repeat-per` (a sub-form per selected embedding artifact-ref) + `when:"method==
  kmeans"` conditional (§4.3), falling back to a Tier-4 code form only if a case exceeds the schema. **Scoping
  is an open decision (D5): drop kmeans (leiden/louvain only) vs keep the kmeans/repeat-per branch** — resolve
  against whether P6 ships `repeat-per`.
- **ITEM-22**: `ui/ClusterFields.tsx` — registers `fieldProvider:clusterings` → "color by clustering" in the
  left rail; clicking a clustering colors the shared scatter by cluster (categorical colormap via the
  view-kind's Coordination store, P7). Thin code over shared primitives.
- **ITEM-23**: **`selectionAction:subcluster`** — on the current shared selection (P8 cell-set, stored as a
  **recipe** = predicate + pinned input hash, not a materialized list), run `clustering.leiden` scoped to the
  selected cells → a new `clustering` artifact covering only that sub-population (NA outside). Reads
  `api.selection`, submits a compute job scoped by the recipe, writes back a clustering. Proves the
  selection→re-analysis loop + provenance recipe end-to-end.

### Cross-cutting (compose the three; prove the platform properties)
- **ITEM-24**: Datatype reconciliation + seed registration — reconcile the seed's `Kind` tokens
  (`qc|normalized|reduced|embedding|clustering`) with the DATA_MODEL datatypes (`single-cell/expression`,
  `embedding`, `clustering`, `metadata-column`, `qc-report`/`report/html`); produce a mapping table; register
  the datatypes the three modules need (P2) as the vertical-slice seed set (only `report/qc` is module-owned —
  ITEM-9; the rest are P2-core).
- **ITEM-25**: Artifact-graph composition + availability gating — verify (no new code) that the kernel builds
  the DAG from each manifest's `accepts`/`produces`: data-io ungated; embedding gated on
  `single-cell/expression`; clustering gated on `embedding`; subcluster on `has-selection`. The catalog
  `requires`/`produces` edges ARE the provenance edges (P4); no module imports another.
- **ITEM-26**: Standard-recipe spine — `inStandardRecipe`/`recipeOrder` across the three
  (upload/process=1, embed=2, cluster=3) so the host assembles the guided "Run standard analysis" path from the
  registry (mirrors interface-round `analysisRegistry.standardRecipe()`), correct as modules are added/removed.
- **ITEM-27**: Scientific rootfs deps — ensure the P3 scientific rootfs image includes
  `scanpy`/`anndata`/`zarr`/`leidenalg`/`igraph`/`umap-learn`/`scikit-misc`(HVG)/`harmonypy` at the pinned
  versions the three `compute/*.py` import; add an import-smoke test that each script imports cleanly in the
  rootfs. (Adds package requirements to P3's rootfs manifest — the only "backend" touch, a data/dep
  declaration, not Rust.)
- **ITEM-28**: Provenance + methodsText — each analysis declares `methodsText(p)` (promoted from the mock
  plugins, LLM-facing AND human-facing) so the run node carries a templated methods paragraph; verify each
  sandbox run auto-produces a run node + content-addressed code blob + input/output edges via P4 (zero P11
  code — inherent in the compute contract).
- **ITEM-29**: MCP surface (auto, verify) — confirm each analysis + the `subcluster` selection-action becomes
  a P9 MCP tool from the manifest metadata (no MCP code in P11); the AI can chain `embedding.umap` →
  `clustering.leiden` over the typed graph. Lint every analysis manifest for LLM metadata
  (`description`/`safety`) completeness.
- **ITEM-30**: Zarr-on-ingest wiring — data-io `process.py` writes served artifacts as **Zarr** directly
  (AnnData-Zarr, so P1/zarrita range-read + P2 chunked-sparse work without an HDF5 slicer); an `.h5ad` upload
  is converted to Zarr at process time (anndata writes Zarr natively). No HDF5-specific host Rust in the serve
  path (per DATA_MODEL storage table).
- **ITEM-31**: Built-in discovery + kernel-invariance — register the three under the P5/P3 build-time
  discovery glob (`import.meta.glob` for FE contributions) + stage `compute/*.py` for the sandbox at build
  (§8.5). Verify the kernel is byte-identical with 3 vs 0 modules (the microkernel thesis).

### Tests
- **ITEM-32**: Unit (FE + schema) — manifest JSON-schema validity + `apiVersion` range; params-schema
  round-trip (host form renders every field type incl. artifact-ref); availability gating
  (`missing`/`runnable`) per module; `fieldProvider` list derivation; `methodsText` templating; the scatter
  view-kind passes the P7 conformance battery.
- **ITEM-33**: Integration (real sandbox, tiny fixture) — a ~200-cell `.h5ad` fixture through: `data.process`
  → assert `expression`+`qc-report`+obs metadata-columns land in the catalog with a provenance node;
  `embedding.umap` → assert an `embedding` (N×2) artifact; `clustering.leiden` → assert a `clustering`
  (codes+categories) artifact; `subcluster` on a predicate selection → a selection-scoped clustering
  (NA-outside + covered_cells). Runs via P3 JobRunner→bwrap; scoped to the study (P10). Save full logs
  (`tee`). Asserts served gene-column + coordinate range-reads match the declared Zarr layout.
- **ITEM-34**: E2E (Playwright, real workbench shell) — upload the fixture → Process (QC form) → review QC
  panel → Accept → embed → color-by embedding on the scatter → cluster (embedding picker auto-populated) →
  color-by cluster → lasso a region → Subcluster → new clustering appears. The single spec proving the whole
  vertical slice (DAG gating + artifact-ref picker + multi-output ingest + selection→re-analysis) on the real
  canvas.

---

## Files/modules
Create (all under a new top-level `extensions/` tree provisioned by P5 — **no `src-app/server` Rust authored by
P11**):
```
extensions/data-io/     extension.yaml
                        compute/{process.py, save.py}
                        schema/{process.params.json, qc.settings.json}
                        ui/{UploadPanel.tsx, QcReviewPanel.tsx}
extensions/embedding/   extension.yaml
                        compute/{pca.py, umap.py}
                        schema/{umap.params.json, pca.params.json}
                        ui/EmbeddingFields.tsx
extensions/clustering/  extension.yaml
                        compute/leiden.py
                        schema/leiden.params.json
                        ui/ClusterFields.tsx
```
Register into host registries: the built-in `scatter` view-kind (adopted from
`visualization-wt/.../viz-core/DeckScatterCanvas.tsx`) into P7's view-kind registry; the three extensions into
the P5/P6 build-time discovery glob; the seed datatypes into the P2 registry (only `report/qc` module-owned).
Modify: the P3 scientific-rootfs package manifest (ITEM-27 — add scanpy/leiden/umap/zarr deps). No other backend
change.

Test fixtures: `extensions/**/tests/` unit specs; `server/tests/` integration (tiny `.h5ad`);
`ui/tests/e2e/` vertical-slice spec.

Replaces (interface-round seeds, once real):
`ui/src/modules/analysis/analyses/{qc-filter,normalize-lognorm,pca,umap,leiden}/plugin.tsx` — their
param/defaults/methodsText/advisory content migrates into the manifests+schemas; the mock `buildResult` KPIs
become real compute outputs.

---

## Reuse
- **Interface-round seed plugins** (`analyses/{qc-filter,normalize-lognorm,pca,umap,leiden}/plugin.tsx`): the
  entire param inventory (ranges/defaults/enums), `methodsText`, advisory copy, KPI labels, and
  `requires`/`produces` Kind wiring. `shared.tsx` field helpers → P6 host-rendered form widgets;
  `registry.ts`/`types.ts` availability+standardRecipe logic → generalizes to the platform's accepts/produces
  gate + `standardRecipe()`.
- **Legacy job-templates** (`server/job-templates/{data-process,embedding-create,clustering-create,sample-save}.ts`):
  the `onCompleted` hooks (readResult → insert catalog rows) → replaced by the host's outputs-manifest ingest
  (P1/P3); the param `metadata` shape → the schema params.
- **Legacy R compute** (`sc-website-scripts/{data-process,embedding-create,clustering-create,save-sample}.R` +
  `utils/h5Parse.R`): concrete pipeline logic (QC metrics, sample-split-by-barcode, threshold filter,
  log/lognorm, HVG, PCA, neighbors, leiden/louvain params) → PORT to scanpy Python. Digest at
  `data-processing-research-wt/docs/research/data-processing/07-sc-website-scripts-digest.md` (param contracts +
  read paths) and `04`/`05` (modern scanpy tools+params).
- **Legacy forms** (`New{Clustering,Embedding}Form.tsx`, `CellFilteringFormItems.tsx`, `UploadForm.tsx`):
  `NewClusteringForm` embedding multi-select + per-embedding nCluster + method-conditional visibility → the
  artifact-ref picker + `repeat-per` + `when` declarative pattern; `NewEmbeddingForm` preprocessing/HVG/viz
  block → the `data.process` + `embedding` schemas; `UploadForm` file types + multi-sample split → the read
  block.
- **Scatter** = live3 `feat/visualization` deck.gl scatter (DeckScatterCanvas + ColormapScatterLayer +
  SelectableScatter + ChunkedScatter + conformance battery) — **adopted** as the built-in view-kind, not
  rebuilt.
- **Host kernel**: P1 data API/catalog/range-serving, P2 datatype registry, P3 `sandbox::run_analysis` +
  `ExtraMount` + JobRunner + rootfs, P4 provenance, P5 `@cyto/workbench-api` + manifest loader + `settings`
  provisioner + discovery glob, P6 docks/form-from-schema (incl. artifact-ref picker)/result-from-kind/
  fieldProvider+selectionAction slots, P7 view-kind registry, P8 selection/recipe, P10 study scoping, file
  store `ziee-file`.
- **§8.5 worked example**: module-1 manifest, directory layout, and compose-DAG are the literal template.

---

## Dependencies (platform parts P11 consumes)
| Blocks P11? | Part | Why |
|---|---|---|
| **HARD** | **P1 data-foundation** | working store + `analysis_results` catalog + data API + authed byte-range (Zarr) serving + outputs-manifest ingest (fan-out). Every module's outputs land here. |
| **HARD** | **P2 datatype-system** | the datatypes (`single-cell/expression`, `embedding`, `clustering`, `metadata-column`, `matrix`, `report/qc`) + subtyping + `accepts`/`produces` type-match gating + storage layouts (chunked-sparse CSC / chunked-dense / Zarr / Parquet). |
| **HARD** | **P3 compute-scheduling** | JobRunner→bwrap + a **scanpy scientific rootfs** + the `inputs.json`/`/outputs`+`manifest.json` contract + interactive/batch class. **THE key dependency — no analysis runs without it.** |
| **HARD** | **P5 contribution-api** | `@cyto/workbench-api`, the manifest schema + validator, the `artifact-ref` param type, the declarative `settings` provisioner (qc-defaults), and build-time discovery/loader. |
| **HARD** | **P6 workbench-shell** | JSON-schema→form renderer INCLUDING the **artifact-ref auto-populated picker widget**, result-from-kind panels, semantic dock slots (left/bottom), file-store upload affordance, `fieldProvider`/`selectionAction` slots. |
| **HARD** | **P7 visualization** | the **view-kind registry** the built-in scatter registers into + fieldProvider color-by + categorical legend rendering embedding/clustering. |
| SOFT | **P4 provenance** | inherited automatically — each sandbox run = a run node + code blob; `methodsText` feeds methods export. No P11 code. |
| SOFT | **P8 interaction-dsl** | only clustering's `subcluster` selectionAction (reads `api.selection`, recipe-stored). data-io/embedding don't need it. |
| SOFT | **P9 ai-mcp** | MCP tools auto-generated from the three manifests (§0.4.2); P11 only supplies good `description`/`when`/`safety` metadata. |
| SOFT | **P10 study-substrate** | tenancy/role scoping inherited; artifacts + catalog rows auto study-scoped. No P11 code. |

**Single most-blocking dependency: the data+compute foundation trio P1 + P2 + P3** (DEC-FOUNDATION critical
path). Without the kind-typed working store + catalog + the scanpy sandbox, no module can run or persist. P5/P6
gate the declarative form+manifest surface; P7 gates *seeing* the result.

---

## Sequencing
1. **Gate**: confirm P1/P2/P3/P5/P6 landed (data API read/write, a datatype registered, a sandbox analysis runs
   end-to-end, a manifest discovered, a form renders) — and pick the seed datatypes (**ITEM-24** mapping)
   before any manifest is written. If the kernel isn't ready, P11 is blocked — **do not stub the kernel**.
2. **data-io first** (ITEM-1–9, 30) — it produces `expression`, the root the other two require, and exercises
   the hardest paths (file upload, multi-output ingest, settings provisioner). Ship `data.process` before
   `save.sample`. Deliver: upload → QC/normalize → `expression` in catalog + QC review.
3. **embedding** (ITEM-10–16) — `expression`→`embedding`; adopt the scatter view-kind (P7). Deliver:
   expression → embedding → colored scatter on the canvas.
4. **clustering** (ITEM-17–23) — `embedding`→`clustering`; proves the artifact-ref picker (headline §4.3 case)
   and the `subcluster` selectionAction (last — needs P8). Deliver: embedding → clustering → color-by +
   lasso→subcluster.
5. **Cross-cutting** (ITEM-25–31) — composition/gating, standard recipe, rootfs deps, provenance, MCP,
   Zarr-ingest, discovery wiring + kernel-invariance.
6. **Tests** (ITEM-32–34) — unit → integration (real sandbox fixture) → e2e vertical slice.

Within each module: manifest+schema (declarative, testable against the P5 validator) → `compute/*.py`
(testable standalone against a fixture h5ad, de-risks the foundation critical path) → `ui/*.tsx` (needs P6/P7)
→ wire into discovery.

---

## Decisions
- **D1 — Compute engine = scanpy/anndata (Python), NOT legacy R/Seurat.** §8.5 uses `process.py`; the seed
  plugins say scanpy; the P3 rootfs and ecosystem (leidenalg, umap-learn, zarr) are Python-first. Port the
  legacy params, not the R.
- **D2 — Served storage = AnnData-Zarr for expression/embedding, Parquet for obs columns/clustering/qc tables,
  qc-report as small parquet+JSON.** No HDF5 in the serve path; `.h5ad` uploads convert to Zarr inside
  `process.py` (anndata writes Zarr natively — no HDF5→Zarr host step). (DATA_MODEL storage table.)
- **D3 — `save.sample` = host-ingest of typed outputs, not module storage code.** Compute writes typed
  artifacts + `manifest.json`; the host catalogs them. Kept a SEPARATE analysis (§8.5 lists it; legacy
  re-applies thresholds interactively); may reduce to persist/rename if sample-split happens in `data.process`
  — revisit against P6's QC-review interaction.
- **D4 — Seed decomposition:** data-io={qc,normalize}, embedding={pca,umap}, clustering={leiden,louvain}.
  `harmony`/`markers`/`annotation` seeds are OUT of P11 (future modules 4+); record the
  qc/normalized/reduced Kind → expression/embedding-subtype reconciliation (ITEM-24).
- **D5 — kmeans + per-embedding `nCluster` dynamic field (ITEM-21): OPEN.** r1 DROPS kmeans from P11
  (leiden/louvain only) to keep the artifact-ref picker the clean demonstrator unless P6 ships `repeat-per`;
  r2 KEEPS the kmeans branch with `repeat-per` (Tier-4 code-form fallback). Resolve at audit against P6's
  `repeat-per` support.
- **D6 — QC thresholds default to adaptive (MAD)** per seed `qc-filter` (legacy used fixed user min/max);
  expose both via `strategy` enum; admin default via the `qc-defaults` settings row.
- **D7 — Multi-output:** `data.process` emits N artifacts from ONE run (expression + qc columns + qc-report),
  per DATA_MODEL "produce-atomically / consume-individually." Requires P1 ingest to handle the fan-out
  manifest.
- **D8 — One built-in view-kind ships in P11: `scatter`** (adopted from live3). Other view-kinds
  (violin/heatmap/dot-plot) are P7's library; the slice needs only scatter to prove color-by. Non-scatter QC
  plots render inside the QC-review panel from the `qc-report` artifact (host-rendered), not as canvas
  view-kinds.
- **D9 — Selection stored as a recipe** (predicate + pinned input hash, never a materialized cell list; P8/P4)
  — so `subcluster` is reproducible and scale-safe.
- **D10 (OPEN cross-part boundary) — scatter view-kind ownership: P11-embedding embedding vs P7 viz.** The
  DIFF flagged the P7↔P11 boundary divergence: r1 treats scatter purely as a P7 dependency P11 *consumes* (no
  P11 registration work); r2 makes registering live3's concrete `DeckScatterCanvas` into the P7 registry an
  explicit **P11 work item (ITEM-15)** with a named source dependency and the conformance-battery gate. Mark
  as an **open cross-part boundary to resolve at audit** — decide whether the scatter registration is owned by
  P11 or delivered by P7 (and whether the live3-adoption work counts against P11 or P7 effort).

---

## Risks / unknowns
- **R1 (critical-path)** — P11 is 100% blocked on P1+P2+P3 (foundation) and is the *last* phase (P1–P8). If
  those slip / the compute path or data API is a stub, the "no-Rust extension" claim can't be demonstrated and
  P11 can only build manifests+schemas+`compute.py` against fixtures. Mitigate: the ITEM-1/step-1 gate; build
  P11 only after a single sandbox analysis is proven end-to-end; test `compute.py` standalone (scanpy on a
  tiny h5ad) to de-risk R3/R4.
- **R2** — The **artifact-ref picker** (ITEM-18) is the platform's headline claim but lives in P6. If P6's form
  renderer doesn't yet support `type:artifact-ref` → catalog-query binding, clustering's key demo can't
  render. Tight P6↔P11 contract needed early.
- **R3** — Scanpy port fidelity: legacy R read paths handle CITE-seq assay filtering, legacy categorical
  encoding, 10x v2/v3 layouts, COO vs CSC (digest §2–3). scanpy covers most but exotic formats may need manual
  handling. Scope P11 to h5ad + 10x-h5 happy path; flag exotic formats.
- **R4 — Rootfs dep drift.** Rootfs must ship scanpy + anndata + zarr + leidenalg + igraph + umap-learn +
  scikit-misc + harmonypy (P3); version skew → import failures inside bwrap (`--clearenv`, no network).
  Mitigate ITEM-27 import-smoke test; pin versions in the rootfs manifest. A stub/missing dep silently disables
  all three modules.
- **R5 — Zarr write inside the sandbox** must produce a P1/P2-ingestable layout (chunked-sparse CSC for
  expression, chunked-dense for embedding, categorical for clustering) exactly as the datatype declares — a
  mismatch breaks range-read/color-by. Mitigate: integration test asserts the served gene-column + coordinate
  reads.
- **R6 — Subcluster selection scoping** — the recipe must map the P8 predicate to the cells the sandbox job
  filters on (covered_cells provenance); off-by-axis errors silently mis-cluster. Mitigate: ITEM-23 asserts
  NA-outside + covered_cells.
- **R7 — `metadata-column` alignment** — qc columns + clustering codes must align to the study's canonical
  `system_cell_id` axis (DATA_MODEL). Compute must emit cell-id-keyed columns; the host aligns on ingest —
  verify the contract with P1.
- **R8 — QC-review UX correctness (JTBD)** — filtering that silently drops half the cells is a defect even if
  the code "works"; the review panel must make pre/post + cutlines legible before Accept. Mitigate: ITEM-8 +
  the e2e spec assert the review affordance, not just the artifact. Keep it read-render + re-run (§4.4), not a
  bespoke stateful canvas.
- **R9 — View-kind adoption coupling** — live3's scatter is `switch(cell.kind)`-closed until P7's registry
  refactor; P11's scatter registration depends on that refactor landing (P7), not on P11 (ties to the D10 open
  boundary).
- **R10 — MCP metadata completeness** — a missing `description`/`safety` yields an unusable or wrongly-gated
  AI tool. Mitigate: ITEM-29 lints every analysis manifest for LLM metadata.
- **R11 — No P11 Rust is the whole thesis** — if any module reaches for a kernel change, that's a platform gap
  (P5/P6) to fix in-kernel, not a per-module Rust file. Treat any such need as a defect against the foundation
  (ITEM-31 verifies the kernel is byte-identical with 3 vs 0 modules).

---

## Effort estimate
Consumer, not a builder — **assuming P1–P8 are landed**; near-zero novel infra (all reuse + port). Dominated by
the three `compute/*.py` correctness + the integration/e2e proof; the UI is thin over `@cyto/workbench-api`.
**Zero Rust.**
- **data-io**: L (~40%) — upload UI + multi-output compute + QC-review panel + settings + the hardest read
  paths + `report/qc` datatype. (~2 wk)
- **embedding**: S–M (~20%) — two thin scanpy scripts + fieldProvider; scatter is *adopted*, not built.
  (~1–1.5 wk)
- **clustering**: M (~25%) — artifact-ref picker demo + subcluster selectionAction + one script. (~1 wk)
- **cross-module** (datatype mapping, discovery wiring, rootfs deps, provenance/MCP verify, compose E2E): M
  (~15%). (~1–1.5 wk)
- **Total P11 ≈ 3–4 focused sessions / ~4–6 engineer-weeks** once P1/P2/P3/P5/P6/P7 exist. The value is proving
  the seams, not writing lines. Standalone `compute.py` can proceed earlier against fixtures to de-risk R1/R3/R4.
