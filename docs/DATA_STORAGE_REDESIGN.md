> ## ⚠️ SUPERSEDED (2026-07-16) — served store format is now Zarr(v3), not HDF5
> The P1 data-foundation decision (DEC-1, human-approved) reverses this doc's HDF5 +
> server-side-Rust-slicer approach: **served arrays = Zarr(v3) (dense + sparse-CSC),
> tables = Parquet, self-indexed genomics served as-is over HTTP-range; NO native
> libhdf5 / HDF5-Rust in the serving path.** HDF5→Zarr is a P3 sandbox precompute.
> Authoritative storage design = `docs/analysis-workbench/DATA_MODEL.md`. This doc is
> kept for history (the chunking/streaming rationale still informs Zarr chunk sizing).


# CytoAnalyst — Data & Results Storage Redesign

Status: **proposal** · Author: research pass over the legacy repos (`sc-website` @ `release/0.0.1`,
`sc-task-queue`, `sc-website-scripts`) + a survey of the modern single-cell storage ecosystem.

---

## 1. What the legacy system does (and why it hurts)

Analysis results are serialized by `QueueUtils::writeH5` (`sc-task-queue/.../R/h5.R`) into a
**custom "EJSON-in-HDF5"** layout: every value is tagged with `$type` (`string`, `numberInt`,
`numberDecimal`, `arrayString`, `arrayDecimal`, `boolean`, `factor`, `object`, `matrix`,
`sparseCMatrix`) plus `$value`, `$index`, `$index1`/`$index2`, `$dim`. Files live at
`{DATA_DIR}/{studyId}/{jobId}.h5`; a Mongo record points at them by `file = jobId`.

The **streaming is already server-mediated** (important — the redesign keeps this): the browser
never downloads the `.h5`. The Node server opens it with h5wasm compiled `NODERAWFS`, walks the
`$type` tree, honors `index:{from,to}` hyperslabs, and returns JSON over two cached REST
endpoints (`/api/job/result`, `/api/embedding/featureExpression`). The only true random-access
path is **color-by-gene**: `X` is stored **CSC** so the server reads `p[g..g+1] → i/x[start..end]`
for one gene's column.

### Why it's not sustainable (from the code)
1. **The `$type` schema is hand-reimplemented in ≥3 drifting parsers** — `writeH5` (R),
   `h5DatasetParse` (R), `readValue` (JS). `sparseCMatrix` is handled in two of them and missing
   from the third.
2. **0-based/1-based hacks** scattered as comments (`factor values-1`, `index1=FALSE`, but
   `Dimnames` kept 1-based "specific to R"); every reader must remember which field is which base.
3. **Path string-surgery** — logical→physical via `replace(/\//g,'/$value/')`; callers pass
   `isPathAbsolute` and hand-write `/$value/{id}/$value/...`.
4. **No schema, no versioning** — nothing tags the format version; the AnnData *export* path
   already writes `encoding-type`/`encoding-version`, but the custom result format does not.
5. **Orientation inconsistency** — sample files store `X` genes×cells, embedding files store
   cells×genes; the gene-slice hard-codes one orientation.
6. **Three formats in one system** — EJSON-HDF5, plain-array annotation files, AnnData export —
   each needs its own reader; annotations are special-cased throughout via an `isAnnotation` flag.

**The key realization: HDF5 was never the problem — the *invented `$type` schema inside it* is.**
HDF5 was chosen for a real reason (below); we keep the container and drop the invented schema.

---

## 2. Your three questions, answered

### Q1 — "How do we know if a dataset is integer or array, float or int?"
That is the exact job `$type` was invented for, and it is already solved by **standards**, at two
levels — so we never invent tags again:

- **Primitive dtype + shape are native HDF5/Zarr metadata.** An HDF5 dataset carries its datatype
  (`H5T`: integer vs float, signedness, bit-width — e.g. `<i8>`, `<f4>`) and its dataspace (rank 0
  = scalar, rank ≥1 = array, with shape). Zarr's `.zarray` carries `dtype` + `shape`. So
  **int-vs-float and scalar-vs-array are readable directly** — h5wasm/zarrita/the Rust `hdf5`
  crate all expose them. `$type: numberInt`/`arrayDecimal` is redundant with the dataset's own
  dtype+shape.
- **Semantic types HDF5 doesn't model** (factor/categorical, data.frame, sparse matrix) don't need a
  runtime tag either, because in the working store **each artifact is exactly one *kind*** (§3.1) and
  the reader knows the kind *before* it opens the file (from the catalog / the API endpoint). A
  `clustering` artifact IS a `codes`+`categories` pair; an `embedding` IS `float32[M][d]`; `expression`
  IS a CSC triplet. So the layout is known, not discovered — **no `$type`, no generic tree.** (Only the
  AnnData *export* uses the `encoding-type` attribute convention — §3.3 — where interop matters.)
- **And the decisive simplification:** because streaming is **server-mediated with typed
  endpoints** (Q2), the *client never disambiguates at all*. `GET .../embedding/{key}` is known to
  return `float32[N][2]`; `GET .../obs/{col}` returns a categorical or a float column; the type is
  in the **API contract** (generated `types.ts`), not a runtime tag. The generic `$type` reader is
  deleted, not reimplemented.

### Q2 — "We do a lot of viz and need to stream server→client."
Yes — and the legacy design already does exactly that (server h5wasm slices → JSON). We keep
**server-mediated streaming** and upgrade the two weak parts:
- **Read a kind-typed working artifact** (native HDF5, §3.1) instead of the `$type` tree.
- **Send RAW TYPED-ARRAY BINARY** — not `JSON.stringify` of numbers. The real win is *binary vs
  JSON-encoded numbers* (a `Float32Array` sent as bytes is ~3–5× smaller than `[0.1,0.2,…]` text and
  needs no parse) — **not a framing format**. The endpoints are already typed (kind-driven, §3.4), so
  the client *knows* a response is `float32[M][2]`; it does `new Float32Array(arrayBuffer)` — zero-copy,
  zero dependency, straight into WebGL (deck.gl/regl). We do **not** need Apache Arrow for this: its
  schema/columnar/dictionary machinery is redundant when the shape is already known, and it adds a
  multi-MB `apache-arrow` JS dependency + framing overhead for a single array. A 500k-cell UMAP = a
  4 MB `Float32Array` blob; a gene column = two small typed arrays (§3.7). **(Columnar Arrow/Parquet
  earns its place only for large, multi-column, mixed-type tables you want to query/interop
  columnarly — which for us is the *export* path (Parquet), not the live viz wire.)**

### Q3 — "The file module is for user *uploads*, not partial reads of HDF5."
Agreed — and the legacy layout confirms it: results live under `{DATA_DIR}/{studyId}/` and are read
by the *job* endpoints, entirely separate from upload/file handling. So:
- **`ziee-file` (the SDK blob store) = INPUT uploads only** (raw matrix / 10x / `.h5ad` the user
  uploads). It is a dumb blob store; it does **not** do partial/random reads of result files.
- **Results get their own home + their own streaming service** (below): the analysis compute writes
  result files to a **results store** the *server* reads; a dedicated **analysis-results streaming
  module** does the chunked/typed slicing. This mirrors the legacy separation exactly, just cleaner.

---

## 3. Proposed architecture

```
 ┌── INPUT ────────────┐   ┌── COMPUTE (sandbox) ─────────┐   ┌── JOB-RESULT STORE ─────┐
 │ user uploads matrix │   │ each job (R/Python) writes   │   │ per-run dir on server   │
 │  → ziee-file (blob) │──▶│ its own element-encoded HDF5 │──▶│  {run_id}/{job}.h5      │
 │  (uploads ONLY)     │   │ (thin writeElem, per-job schema) │   │  {run_id}/de.parquet    │
 │                     │   │ AnnData .h5ad only on EXPORT │   │  (server-read, NOT      │
 └─────────────────────┘   └──────────────────────────────┘   │   ziee-file)            │
                                                               └───────────┬────────────┘
 ┌── FRONTEND ─────────────────────────┐   ┌── ANALYSIS-RESULTS SERVICE ──┐│
 │ deck.gl scatter · TypedArrays + small JSON │◀──│ Rust: open job .h5, read TYPED  ││
 │ ArrayBuffer → TypedArray       │   │ slice, stream raw binary       │◀┘
 └─────────────────────────────────────┘   │ typed endpoints (below)       │
        ▲  Postgres results index ─────────│ + Postgres catalog            │
        └──────────────────────────────────└───────────────────────────────┘
```

### 3.0 The one invariant (read this first)
**Two distinct layers, do not conflate them:**
- **Working store** (everything the app reads/writes/mutates day-to-day): **mutation-first, kind-typed
  HDF5 artifacts + a Postgres catalog** (§3.1). Cells identified by `(sample, local_index)`, keyed on
  the hot path by a dense **view index** (§3.9). **AnnData is NOT used here.** Written with native
  `rhdf5`/`hdf5`-crate/`h5wasm` — no heavy library, jobs stay fast.
- **Import / export codec** (only when a user uploads or downloads a study): **AnnData `.h5ad`/Zarr**
  (§3.3) — assembled from / parsed into the working artifacts. This is the *only* place `anndata`/
  `anndataR` and the `obs`/`var`/`obsm`/`encoding-type` conventions appear.

Any `obs`/`var`/`obsm` shape shown later (e.g. the study tree in §3.6) is the **export/merge view**,
not the on-disk working format.

### 3.1 The working store = **mutation-first, kind-typed artifacts** (AnnData is import/export ONLY)
The analysis data is written, edited, and removed constantly (add/remove samples, add/re-run/delete
analyses, edit metadata). A single big file — AnnData/`.h5ad` or otherwise — is the **wrong** working
format: HDF5 doesn't reclaim space on delete, editing mid-file means rewriting, and removing a sample
from a concatenated matrix rewrites the whole thing. **So AnnData is NOT the working standard — it is
only the import/export codec (§3.3).** The working store is instead a set of **small, independently
writable + removable artifacts**, indexed by Postgres:

```
study/                                (a directory of artifacts + Postgres catalog rows)
├── samples/<sample_id>/expression.h5    # this sample's cells×genes CSC (+ per-cell QC cols)
├── analyses/<analysis_id>/result.h5     # ONE analysis's output (embedding | clustering | de | …)
└── metadata/<column_id>.h5              # one editable per-cell column
   (Postgres) catalog: samples[], analyses[], metadata cols, cell registry, provenance
```
- **Add** a sample/analysis/column = write one artifact + insert a catalog row. **Remove** = delete
  the artifact + its row. **Edit** = rewrite one small artifact. Never a whole-study rewrite.

**No generic self-describing format is needed — the artifact's KIND carries the type.** Each artifact
is exactly one *kind* (from a fixed vocabulary: `expression` | `embedding` | `clustering` |
`annotation` | `de` | `enrichment` | `trajectory` | `metadata-column`), and each kind has a **small,
fixed, versioned layout**. The reader always knows the kind *before* it opens the file (the catalog /
the API endpoint says so), so it knows the schema — **no `$type` tags, no generic tree to parse, and
no AnnData `encoding-type` convention in the working data.** Primitives inside a kind's layout are
plain HDF5 datasets, so int-vs-float and scalar-vs-array come from the native `H5T` dtype + rank
(§2·Q1) — nothing invented. Categoricals (clusterings/annotations) use an explicit `codes`+`categories`
pair; that's a property of the *clustering kind's* layout, not a global format.

- **Written/read with the native HDF5 the runtime already has** — `rhdf5` in R (today's dependency),
  the `hdf5` crate in Rust, `h5wasm` in JS. Each kind gets a tiny typed reader/writer (~the size of
  today's `writeH5` for that shape). **No `anndata`/`anndataR` load in jobs; per-job cost ≈ today.**
- **Keeps the multi-runtime HDF5 property** (server + R/WebR + browser all read it) that HDF5 was
  chosen for — the WebR "local study" chain still works, now over typed per-kind files instead of the
  bespoke `$type` tree.
- **This replaces the three drifting `$type` parsers with N tiny per-kind readers** — each trivial,
  because it reads *one known shape*, not an arbitrary tagged tree.

### 3.2 Standardize the JOBS — a per-job/kind output *schema registry*
The user's real concern: the **job files** must be standardized so the job chain (a job reads a
prior job's file) and the streaming module know the layout. So each job type declares a **versioned
output schema** — the element tree it writes, every node encoded per §3.1. Sketch (derived from the
R scripts):

| Job | Reads | Output element tree (all `encoding-type`-tagged) |
|---|---|---|
| `data-process` | uploaded input (AnnData/10x/CSV) | `dict{ X:csc_matrix[G×N], var:string-array[G], obs:dataframe, misc:dict }` |
| `save-sample` | a processed dataset | `dict{ <sampleId>: dict{ X:csc_matrix, metadata:dataframe, features:string-array, cellIds:string-array } }` |
| `embedding` | sample files | `dict{ <embId>: dict{ X:csc_matrix[N×G], Xlog2:csc_matrix, embedding:dict<sample,array>, vis2D:dict<sample,array N×2>, features:string-array, nCells:scalar } }` |
| `clustering` | embedding file (`embedding`,`systemCellIds`) | `dict{ <clusterId>: dict{ levels:array, clusterBySample:dict<sample, dict{cellId:string-array, cluster:array}> } }` |
| `DE` | sample + cluster files | `dict{ <cmpId>: dataframe(feature,pValue,adj,log2FC,pct1,pct2,…) + dict{group1/2CellIds} }` |
| `enrichment` | sample + cluster files | `dict{ <sampleId>: dict{ cellId:string-array, enrichment:dict<entity, dict<stat, array N>> } }` |
| `trajectory` | embedding file | `dict{ systemCellIds:dict, groups:dict, lineages:list, pseudoTimes:dict<lineage, dict<sample, array>> }` |
| `annotation` | embedding file (`X`) | `dict{ levels:string-array, values:dict<sample, array codes> }` (now a `categorical` per sample) |

The schema lives in code (a versioned descriptor per job) + is the contract the read helper +
streaming module compile against. This **is** "standardizing the job files": same encoding, declared
shape, versioned — no per-consumer path-mangling, no drift. Cross-job coupling (embedding→clustering
etc.) becomes "read element `embedding` from run X's file" via the standard `read_elem`, not the
`/$value/{id}/$value/embedding` string surgery.

### 3.3 AnnData object (`.h5ad`) = **export only**
When the user **exports a study**, `sample-export` assembles the relevant job elements into a proper
AnnData object (cells×genes; `X`+`layers`, `obs` gets clustering/annotation/metadata columns, `obsm`
gets embeddings, `uns` gets DE/params) and writes `.h5ad` (via `anndataR::write_h5ad`) — and,
optionally, `.zarr` for Vitessce/object-storage or TileDB-SOMA for atlas-scale. **This is the only
place `anndataR`/`anndata` is ever loaded** — once, per export — and the only place the AnnData
*object* model appears. Intermediate jobs never pay for it.

### 3.4 Tabular results (DE) — a **DataFrame element** (Parquet sidecar only if useful)
A DE table is a sortable/filterable table (all G genes × ~9 stat columns) — but small (~20–30k rows,
a few MB). So it needs **no SQL engine**:
- **Server-paginated** (default): the Rust service reads the DE `dataframe` element (or a Parquet
  sidecar), applies sort/filter/paginate, and streams one small JSON page. Fixes the legacy "load all G
  rows, filter in JS" amplification.
- **Client-side is just JS**: the significant-genes view is small enough to hold the whole small
  table in memory and `sort`/`filter` in plain JavaScript — no in-browser database.
- **No DuckDB-WASM.** It's a multi-MB WASM engine that buys nothing here: DE/metadata tables fit in
  memory, and the desktop build embeds the full server, so there is never a "must query a large
  table with no backend" case. (The *only* future scenario that would justify it is a fully static,
  server-less *shared study viewer* querying large tables — and even then it's optional.) Parquet
  stays useful purely as a columnar, typed sidecar readable by R/Python (`arrow`) — not for a
  browser query engine.

### 3.4 The streaming service — **typed by KIND, not a generic path-reader**
**The legacy had ONE generic endpoint** (`/api/job/result?args=`): the client passes raw HDF5
**paths** + `index:{from,to}` slices and the server reads exactly those. Maximum flexibility, minimal
server code — but it has three flaws the redesign exists to fix, and the legacy *itself proves the
last one*:
1. **It leaks the file's physical layout to the client** — the path string-surgery
   (`/$value/{id}/$value/…`, `isPathAbsolute`) is the client knowing on-disk structure. Change the
   layout → break every client.
2. **No typed contract** — the client gets untyped bytes and needs the generic `$type` reader; nothing
   in OpenAPI / `types.ts`.
3. **It wasn't even sufficient** — the one true hot path (color-by-gene) needed a *second, specialized*
   endpoint (`/api/embedding/featureExpression`) because the generic path-reader can't do the sparse
   CSC-column logic. That's the tell: the access patterns that matter want purpose-built, typed handling.

**So: keep the SPIRIT (the client decides what to read) but express it in DOMAIN terms — `kind` + `id`
+ `selector` — on a SMALL set of typed endpoints, never raw paths.** Because §3.1 gives a *bounded*
kind vocabulary (~7 kinds), this is a handful of endpoints, not a sprawl, and each is a thin
kind-dispatch → typed reader → raw binary/JSON. The client still chooses *what*; the server owns *how* (layout,
slicing, types, auth):

| Endpoint | Client chooses | Server does |
|---|---|---|
| `GET /studies/{s}/catalog` | — | list samples, analyses (kind+id+shape), obs columns, N/G |
| `GET /studies/{s}/analyses/{id}` | which analysis | read that artifact; **shape typed by its `kind`** (embedding→f32[M][d], clustering→codes+categories, …) |
| `GET /studies/{s}/expression?genes=A,B&layer=lognorm` | which gene(s) | CSC column slice `indptr[g..g+1]→indices/data` → **sparse** `{row,value}` (§3.7) |
| `GET /studies/{s}/obs/{column}` | which per-cell column | one aligned column (categorical→codes+categories, or f32) |
| `GET /studies/{s}/analyses/{id}/de?sort=&filter=&page=` | sort/filter/page | server-side sort/filter/paginate → one small JSON columnar page |

The first two give the old endpoint's generality **without** its costs: `GET …/analyses/{id}` is
"read whatever analysis I name," but the **kind** (from the catalog) determines the typed shape — so
the client picks *what* by domain id, not by file path, and gets a typed result with no `$type`
parser. The rest are the slice-heavy hot paths (gene / column / DE page) that a whole-result read
can't stream efficiently. **Wire = raw typed-array binary** (`ArrayBuffer` → `new Float32Array(buf)` /
`Uint32Array`) for the big numeric arrays (embeddings, gene columns, obs columns), and **JSON**
(columnar — arrays per column) for small tables/metadata. **Not Arrow** (§2·Q2): the endpoint is
typed, so the shape is known and a self-describing framing format buys nothing but a dependency +
overhead. The Rust service reads the kind's HDF5 layout with the `hdf5` crate (chunked hyperslab —
preserving the CSC gene-column random access, the same `indptr/indices/data` slice as the legacy,
just as raw bytes). **Auth is enforced per endpoint** (results are per-user/study) — impossible with a
static blob store, another reason not to route this through `ziee-file`.

(A generic "read a raw element at path P" endpoint is fine as an **admin/debug** tool, gated — but not
the client contract.)

#### 3.4.1 OpenAPI correctness + the ApiClient with **binary responses**
The SDK contract is OpenAPI → `emit_ts` → `types.ts` → `ApiClient` (`createApiClient` + `callAsync`,
which does token-inject + `JSON.parse` + 401-refresh). Raw binary bytes must NOT hit `JSON.parse`, so
the data-plane endpoints need explicit handling on both sides. Split the surface into a **control
plane** (JSON) and a **data plane** (binary):

- **Control plane — normal OpenAPI + ApiClient (unchanged).** `catalog`, analysis lists, small
  metadata, and the DE *page* (JSON) are ordinary typed JSON endpoints — full `types.ts` types,
  `ApiClient.Study.catalog(...)`, codegen + parity test all as today.
- **Data plane — raw binary, declared honestly in OpenAPI, consumed off the JSON client.**
  - **OpenAPI stays correct**: a binary endpoint is declared with an octet media type + a binary
    schema — `responses: 200: content: { "application/octet-stream": { schema: { type: string, format:
    binary } } }`. In aide that's a response type whose `OperationOutput` sets `application/octet-stream`
    + `format: binary` (axum `Bytes`, or a ~3-line `OperationOutput` impl if aide lacks it). The spec is
    honest — the wire *is* opaque bytes — and the golden `types_ts_parity` test still passes (generation
    stays deterministic). What OpenAPI's JSON-schema model **cannot** express is the *decoded* shape
    (`Float32Array[M][2]`) — but that's inherent to every binary API (image/file download) and correct:
    OpenAPI describes the wire; the endpoint's `kind` describes the payload.
  - **`emit_ts` must map a binary response** to `ArrayBuffer`, not `unknown`/a JSON type. **`callAsync`
    must branch on response kind** (JSON → `.json()`; octet → `.arrayBuffer()`) instead of always
    `JSON.parse`. Today the SDK does neither → **SDK gap (FE-10, below).** (Note: raw `ArrayBuffer`
    support is *simpler* than an Arrow decoder — no `apache-arrow` dependency, just `.arrayBuffer()`.)
  - **Until the SDK supports it**, the data plane uses a thin **purpose-built fetch helper**
    (`fetch` + reuse the SDK's `getAuthToken`/`getBaseUrl`/401 path → `response.arrayBuffer()`), NOT
    `createApiClient`. Its typed surface (`Stream.expression(genes) → {row:Uint32Array,
    value:Float32Array}`) is hand-written — the shape is fixed by the endpoint's kind. The OpenAPI
    still lists the endpoints (for docs/discovery), but the JSON `ApiClient` doesn't own their bodies.
- **The clean long-term** (flag to live1): teach `emit_ts` to read each response's media type and emit
  a `responseType` (`json | arraybuffer | stream`), and `callAsync` to honor it — then the *one*
  generated `ApiClient` handles binary endpoints natively (`ApiClient.Study.expression(...) →
  ArrayBuffer`), no separate client. That's the SDK enhancement CytoAnalyst's viz needs.

### 3.5 The catalog (Postgres side-table)
`analysis_results` rows (one per **analysis id**, not per job): a surrogate `id` (PK, system-assigned)
+ the natural key **`(study_id, analysis_id)`** (`analysis_id` is study-local — §3.8),
`run_id`, `job_id`, `kind` (embedding/clustering/de/…), `job_file`, `element_path`
(the analysis's group inside that file), `axis` (obs/var/both), `covered_cells` (all | a sample-set
ref), `shape`, `params`, `status`, `created_at`. Lets the UI list what's streamable **without
opening a file**, and resolves `study → analyses → (job file, element)` — replacing the Mongo
`record.file=jobId` + inner-id lookup.

### 3.6 Study data structure — merging every job's analyses with **zero conflict**
A study accumulates many analyses over time — and, as in the legacy design, **one job run emits
multiple analyses into one file** (params carry several analysis ids; the file's top level is keyed
by analysis id). Merging all of them into a single study is conflict-free by construction, on **two
pillars**:

**Pillar 1 — one canonical coordinate system per study (the shared join keys).**
The study fixes its axes ONCE, at ingest (`data-process`/`save-sample`):
- `obs._index = system_cell_id[N]` — a **generated, study-unique, stable** cell id (+ canonical
  order). **NOT the input barcode.** Input barcodes (`AAACCTGAGAAACCAT-1`) are *not* unique across
  samples (every 10x sample reuses the same barcodes) and can be missing/malformed/re-ordered, so
  they cannot be the join key once samples are merged. The system id is the opaque, collision-free,
  stable key every result references. The **input barcode is kept for display** as
  `obs['original_id']` (per-sample, non-unique — fine, it's a label, not a key). *This is exactly
  why the legacy has `systemCellIds` separate from `originalCellIds`.*
- `var._index = gene_id[G]` (stable gene id/symbol) — the canonical gene axis, likewise study-unique.

Because *all* jobs reference these same **system** ids, a cluster label and a UMAP coordinate for the
same `system_cell_id` are guaranteed to mean the same cell — across samples, across re-runs. The
legacy's only mistake was **re-storing** the cell-id list inside *every* result; here the system id
lives **once** as the axis and results are just aligned arrays (no per-result id copy). A job that
ran on a **subset** (say 3 of 5 samples) produces values for those cells only; merging aligns by
`system_cell_id` and fills **NA** for uncovered cells. Same for genes. Alignment — not key-renaming —
is what makes different jobs compose.

**Pillar 2 — every analysis is namespaced by its **study-unique** id under the right axis.**
Each `analysis_id` is unique *within its study* (not globally — see §3.8 for why that matters for
export/duplicate; global identity is the composite `(study_id, analysis_id)`). The on-disk slot is
*derived from* `(kind, analysis_id)` and **can never collide within the study**, whether two analyses
came from the same job file or from different jobs:

```
study (the merge / export target — assembled on demand; see §3.3)
├── obs   (_index = cell_id[N])                     # canonical cells
│   ├── clustering/<analysis_id>      → categorical  (NA outside covered cells)
│   ├── annotation/<analysis_id>      → categorical
│   ├── metadata/<column>            → categorical|float
│   └── pseudotime/<analysis_id>/<lineage> → float
├── var   (_index = gene_id[G])                      # canonical genes
├── obsm
│   ├── <analysis_id>                → embedding coords N×d   (one embedding = one id)
│   └── enrichment/<analysis_id>     → N×stats
├── X / layers['counts','lognorm']                   # expression, cells×genes
└── uns
    └── analyses/<analysis_id>       → { kind, job_id, params, covered_cells, created_at }
```

Within an intermediate **job file** the same rule holds (multiple analyses per run, no conflict):
```
{run_id}/{job}.h5
├── <analysis_id_1>/   (dict element — the analysis's output tree, per the job's §3.2 schema)
├── <analysis_id_2>/   (dict element)
└── _meta/             (job_id, kind, [analysis ids], params)
```

**So "merge all job files into one study" = for each `analysis_id` across all job files, drop its
element into the study slot `{kind}/{analysis_id}`, reindexed onto the canonical `obs`/`var`.** No
renaming, no collision (ids are unique), no ambiguity (the axis + `uns/analyses/<id>` carry kind +
provenance + coverage). The **live path never physically merges** — the catalog (§3.5) maps
`study → analyses → (job file, element)` and the streaming module reindexes on read; the physical
merge into a single AnnData happens only at **export** (§3.3).

Edge cases this handles cleanly:
- **Re-running an analysis** → a *new* `analysis_id` (new slot); the old one stays until deleted —
  no overwrite, full history. The UI picks the "active" one via the catalog.
- **Multiple embeddings/clusterings** → distinct ids → distinct `obsm[<id>]`/`obs['clustering/<id>']`
  side by side (this is exactly how AnnData holds `X_umap` + `X_pca` + `X_umap_harmony`).
- **Sample-scoped results** → aligned to the study cell axis with NA elsewhere; the covered-cells
  ref in the catalog records the scope.
- **Cross-job dependency** (clustering reads an embedding) → the child references the parent by
  `analysis_id`, resolved through the catalog, not by a file-path convention.

### 3.7 The expression matrix — stored **once**, read **fast by gene** (the viz hot path)
The expression matrix is the one big asset and the one **true random-access** need: coloring a
scatter by a gene must fetch that single gene's value for every cell, instantly, on every
gene-change. Everything else a scatter needs (positions, cluster/metadata color) is small. So the
matrix gets its own treatment, distinct from the lightweight analysis annotations of §3.6.

**Store it once, orient it for gene reads.** Today the matrix is duplicated + inconsistently
oriented — `save-sample` writes it **genes×cells**, then `embedding` **transposes** to cells×genes
and stores `X`+`Xlog2` *again* (the redundancy + orientation pain points). Instead:
- **One canonical study expression store** (`expression.h5`), produced at ingest and referenced by
  every analysis via the canonical `obs`/`var` axes (§3.6) — never re-stored per embedding/analysis.
- **cells×genes, `csc_matrix` encoding** (AnnData `csc_matrix`: `data` / `indices` / `indptr` /
  `shape` — the same triplet as the legacy CSC `x`/`i`/`p`). **CSC on cells×genes ⇒ a gene is a
  column ⇒ contiguous** ⇒ reading one gene is one contiguous slice. (CSR would scatter a gene across
  every row → must scan the whole matrix → OOM/slow; the Vitessce guidance says the same.)
- **Gene-chunked**: chunk `indices`/`data` so one gene's column ≈ one chunk (legacy heuristic:
  `chunk ≈ mean nnz per column`), and keep `indptr` tiny/uncompressed so `indptr[g..g+1]` is a
  one-element read. Result: **one gene = one `indptr` peek + one ~1-chunk hyperslab = O(nnz of that
  gene)** — sub-millisecond, a few KB on the wire.
- **`layers['counts']` (raw) + `layers['lognorm']`** (the coloring layer) — both CSC cells×genes.
  Replaces `X`/`Xlog2` without duplicating the container.

**The by-gene read path returns the SPARSE column — non-zero cells only, never a dense N-vector.**
`GET /analyses/{study}/expression?gene=SOX2&layer=lognorm`: the Rust service looks up the gene's
column in `var`, reads `indptr[g..g+1] → [start,end]`, then `indices[start..end]` + `data[start..end]`
— which IS the set of non-zero cells and their values — and streams **raw binary**
(a tiny header `n` + `row: uint32[n]` + `value: float32[n]`, back-to-back) where `row` = the non-zero cells' **canonical positions**
(0..N-1, i.e. their index on the `obs` axis / the positions array). The client colors those `row`
points by `value` and treats every other cell as **0** (the sparse default). For a gene expressed in
2 % of cells that's ~2 % of a dense payload. Because `row` is the canonical `obs` position, the
client indexes straight into the already-loaded positions `Float32Array` — no id join, no lookup.
Re-color by another gene = one more column slice. This is the single hottest endpoint and stays
**O(nnz of the gene)**, not O(matrix).

**Multi-sample studies:** because the study has ONE canonical cell axis (§3.6), the expression store
is a **single concatenated cells×genes CSC in canonical cell order** — so a gene column already spans
all N study cells in the right order, no per-sample stitching at read time. (Genes are the canonical
`var`; a sample lacking a gene contributes zeros.)

**Non-gene coloring** (cluster / metadata / pseudotime / embedding density) needs **no matrix read at
all** — those are the small per-cell `obs`/`obsm` arrays of §3.6 (N-length, a few KB–MB), fetched in
bulk and cached. So a scatter is: **one positions read (`obsm[<embId>]`, N×2 f32) + one color read**
— gene color = the fast CSC slice; everything else = a small `obs` column. Panning/zooming touches
nothing new (deck.gl renders the cached `TypedArray`s on the GPU).

**Net for viz:** the matrix is stored once (not per analysis), oriented+chunked for the exact access
pattern (gene = column = one chunk), and served as raw typed binary the browser drops straight into WebGL
— the legacy's fast path preserved and de-duplicated, over the standard `csc_matrix` encoding.

### 3.8 Portability — export / import / duplicate without id collisions
"Unique analysis_id" breaks the moment you **export a study and re-import it** (admin testing, moving
systems, restore) or **duplicate** a study: the ids come back and collide — with the original (on
duplicate) or with existing rows (on import). The fix: **ids are study-RELATIVE; global identity is
assigned externally.**

- **Inside a study bundle, every id is study-scoped** — unique *within* the study, not globally:
  `analysis_id`, `system_cell_id`, `gene_id`, and all cross-references (clustering→embedding) use
  these study-local ids. The bundle is fully self-contained + relative — like a git repo's internal
  refs. It embeds **no** global identifier that another system could already own.
- **Global identity = a `study_id` (UUID) + composite keys.** The catalog PK is a system-assigned
  surrogate; the natural key is **`(study_id, analysis_id)`** (and `(study_id, system_cell_id)`,
  `(study_id, gene_id)`). Two studies can carry the *same* `analysis_id` with zero collision — the
  `study_id` disambiguates.
- **Move / restore** (export from A → import into B, or re-import for testing): assign the bundle a
  `study_id` — mint a fresh UUID, or **preserve** the original for an idempotent restore keyed by the
  bundle's `bundle_uuid`. Catalog rows insert as `(study_id, local ids)`; **the result files copy
  verbatim** (their study-local ids stay valid under the new `study_id`). No collision with B's other
  studies, **no rewriting of file internals**.
- **Duplicate** (a second copy, same or another system): assign a **new `study_id`** and copy the
  files verbatim. The copy's catalog is `(new_study_id, same local ids)` — no collision, because the
  composite key differs by `study_id`. Still **no id rewriting inside files** — the whole point of
  relative ids.
- **Idempotency:** the export **manifest** carries `bundle_uuid` + `schema_version` + per-file
  checksums + the study-local id inventory. "Restore/move" upserts by `bundle_uuid` (re-importing the
  same bundle restores the *same* study, doesn't fork); "duplicate" explicitly mints a new `study_id`.
  So an accidental double-import restores rather than silently forking.
- **Storage paths** are per-location, assigned on import/duplicate (e.g. `{new_run_or_study}/…`), and
  recorded in the catalog `job_file` column — never a global path baked into file contents.

This *strengthens* §3.6: within a study, ids can't collide (Pillar 2); across studies, `study_id`
separates; and export / import / duplicate is just **re-parenting a self-contained bundle under a
`study_id`** — never a global-id rewrite. (Contrast the only alternative — globally-unique ids that
must be *re-minted with a remap pass rewriting every in-file cross-reference* on duplicate — which the
relative-id design avoids entirely.)

### 3.9 Cell identity & the **fast-comparison** representation
Cell ids are compared constantly — every scatter join, metadata filter, cluster select, and brush
intersects/aligns cell sets across stores. **Today that path is string-hashed and it's the
bottleneck:** `HashMap<{sampleId, cellId}, V>` (`imports/libs/hashmap.ts`) hashes each key as
`[sampleId, cellId].join('-')`, so *every* `get`/`set`/`has` **allocates an array, string-joins, and
hashes a string** — for N cells, on every operation; `HashSet` is worse (`cyrb64Hash(JSON.stringify
(value))`). At 10⁵–10⁶ cells this per-cell string work dominates.

Fix: **the fast key is a dense integer cell index; the string id is only a durable label.**
**Two roles the id was conflating — split them (this is also what makes sample add/remove safe):**
- **Durable identity = `(sample_id, cell_local_index)`.** The unit of add/remove is the **sample**; a
  sample is immutable once ingested, so its cells' local indices `0..nS-1` are fixed forever. Removing
  a sample drops *its* cells; **no other cell's identity changes** (no global renumbering). This is
  the id stored in results, provenance, and export. (Contrast a study-global dense `0..N-1` assigned
  at ingest: removing a middle sample would leave a hole or force shifting every later index —
  invalidating every stored array + analysis reference. So we do **not** do that.)
- **Fast key = a dense study *view* index `0..M-1`** over the **currently-live** cells, built by
  concatenating live samples in canonical order: sample S occupies a contiguous range
  `[base_S, base_S + nS)`, and `view_index = base_S + local`. All hot-path typed arrays + bitmasks use
  this dense index — integer compare, positional join ("index `i` in both"), no map.
- **Add / remove a sample = rebuild the view, not the data.** Recompute the `base_S` offsets (a
  prefix-sum over live samples, O(#samples)) and re-concatenate the per-cell view arrays (O(M)) — once
  per live-set change, not per frame. Stored per-sample data and analysis results are **untouched**
  (they're sample-scoped); a sample's result simply re-projects into the view at `[base_S, …)` by its
  local index. This replaces the legacy random-string `systemCellId` (whose only job — global
  uniqueness without a scope — §3.8 already provides).
- **Input barcode → per-sample `original_id`** (non-unique — display only).
- **Per-cell data = typed arrays in canonical order** (`Float32Array` coords/expression, `Uint16Array`
  cluster codes…). Joining two layers = index `i` in both. **The `HashMap<{sampleId,cellId}>`
  disappears.**
- **Cell SETS (selection / brush / filter / cluster membership) = a bitmask** — `Uint8Array[N]` or a
  packed `Uint32Array[⌈N/32⌉]` indexed by cell index. Membership = `mask[i]` (O(1), no hash);
  **intersection / union / difference = bitwise AND / OR / ANDNOT** over the arrays (a tight,
  vectorizable loop, ~N/32 word ops); selected count = popcount. Replaces `new Set(strings)
  .intersection(...)`. (Very sparse selections → a `roaring` bitmap; the dense in-viewport case → a
  plain packed bitmask.)
- **Server (Rust) mirrors this**: cells are `u32` indices; sets are bitsets (`roaring`/`bitvec`);
  the wire carries integer `row` indices, never id strings, on the hot path. The string label appears
  only at storage identity, export, and display.

**"Which sample is a cell in?" — sample is a per-cell *column*, not part of the id.**
The `u32` index is **study-global** (`0..N-1` across *all* samples), so it already identifies the cell
uniquely — the `sampleId` is no longer needed *for identity* (it was only in the legacy compound key
because barcodes collide across samples; a study-global index removes that need). Sample membership is
just another per-cell attribute:
- **`obs['sample']`** — a `categorical` (`codes: u16[N]` + `categories: [sampleId, …]`), aligned to the
  canonical index. "Which sample is cell `i`?" → `obs['sample'].codes[i]` — an O(1) integer read.
- Ingest concatenates samples **in order**, so a sample's cells are a **contiguous block**; we also keep
  a tiny **sample → `[start, end)` range map**. Then "all cells of sample S" = a range slice / a one-shot
  bitmask range-set (O(1) to build), not a per-cell scan; "filter to samples {A, C}" = OR their ranges
  into the selection bitmask.

This is the AnnData **concatenated** model — one study-wide `obs` axis in canonical cell order + `sample`
as an `obs` column — versus the legacy per-sample dicts (`X`/`embedding` keyed by `sampleId`). Getting
"sample A's UMAP" = slice the study `obsm['<embId>']` by A's range/mask. Nothing is lost: sample
membership moves from a *compound key* to a *fast per-cell column + range map*, which is also more
flexible (re-batching a cell never changes its id). Genes are symmetric: one study-wide `var` axis +
provenance columns, not per-sample gene lists.

Net: cell comparison goes from **per-cell string hashing** to **integer indexing + bitwise set ops** —
the representation every high-performance single-cell viewer (cellxgene, deck.gl-based tools) uses.

---

## 4. What this fixes (mapped to the legacy pain points)
- One schema, **zero hand-written parsers** — AnnData libs read it in R (`anndataR`), Python
  (`anndata`), Rust (`hdf5`), browser (AnnData-JS / the typed API). (§1.1)
- No 0/1-based hacks, no path string-surgery, no `$value/$` regex — standard slot access. (§1.2–1.3)
- **Versioned schema** via `encoding-version`. (§1.4)
- Orientation fixed at cells×genes. (§1.5)
- Annotations are just `obs` categoricals — the `isAnnotation` special-case disappears. (§1.6)
- Server-side sort/filter/paginate for DE instead of bulk-load-then-filter. (§7.7)
- Typed, compact raw-binary wire (`ArrayBuffer`→`TypedArray`) replaces base64-JSON-of-`$type`.
- Interoperable: results open in Scanpy, Seurat, cellxgene, Vitessce, TileDB-SOMA — a real export
  story, not a bespoke container.

**Preserved on purpose:** HDF5 as the multi-runtime container (server + R/WebR + browser), the CSC
gene-column random-access layout, and server-mediated streaming with per-gene lazy slicing.

---

## 5. SDK / ziee implications (dogfooding feedback)
- **`ziee-file` stays uploads-only** — confirmed correct. Do NOT push result partial-reads through it.
- **The results store + streaming is CytoAnalyst app-domain**, not SDK — but two pieces may be
  reusable SDK patterns worth flagging to live1:
  1. A generic **"large typed-array / binary" response** helper (octet/`ArrayBuffer` endpoints) — many data apps need server→client streaming of big numeric arrays; the SDK's
     current surface is JSON-only.
  2. A **sandbox→results handoff**: the compute writes result artifacts to a per-run location the
     server reads. This is the `ziee-sandbox` (pending) + a results-store seam — worth designing
     alongside the sandbox extraction so results aren't shoehorned into the blob store.
- Needs from the (pending) `ziee-sandbox`: run R/Python with `anndataR`/`scanpy` available, and a
  defined output location the server reads.

---

## 6. Rollout (incremental, behind the pending crates)
1. **Schema first (no infra change):** replace `writeH5`/`$type` with a thin `writeElem`/`readElem` (rhdf5 in R, hdf5-crate in
   Rust, h5wasm in JS — **no new/heavy deps**) emitting the standard element encoding, and a **per-job output schema** (§3.2). Replace the read side (`getData` /
   `h5DatasetParse` / JS `readValue`) with one standard `read_elem`. Kills the 3-parser drift; job
   files become interoperable immediately (Python `anndata.io.read_elem` reads them).
2. **Job-result catalog:** the `analysis`/job module writes the Postgres `analysis_results` index
   (run → job files → element keys/shapes) on job completion.
3. **Streaming service:** the Rust "read HDF5 element + stream" module → typed raw-binary endpoints
   (embedding, gene column, obs column, DE page). Frontend `ArrayBuffer`→`TypedArray` + deck.gl.
4. **DE/tables:** server-paginate the DE dataframe (Parquet sidecar optional); small significant view sorted/filtered in JS.
5. **Later:** optional Zarr export for Vitessce/object-storage; TileDB-SOMA export for atlas-scale
   interop.

---

### Sources
Vitessce (Nature Methods 2024) · Vitessce file-types docs (CSC + `[all_cells, few_genes]` chunking
for per-gene streaming) · zarrita.js · AnnData on-disk format spec (`encoding-type`/-`version`) ·
anndataR (native R `write_h5ad`/`write_zarr`, no Python) ·
TileDB-SOMA / CZ CELLxGENE Census.
