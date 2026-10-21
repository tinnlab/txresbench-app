# Open Data Model — datasets, datatypes, and typed-artifact composition

The correction that generalizes the platform from "a single-cell tool" to "a workbench for **any** analysis and
data type" (single-cell · spatial · bulk · pathway/gene-set · genome tracks · variants · protein structure · …).
`dataset` today is a placeholder; this is what it should be. Prior art: **Galaxy's extensible datatype system**
(the canonical solution) + CWL typed tool I/O + Bioconductor's class hierarchy.

## The core unification: **dataset ≡ analysis-output ≡ typed artifact**
There is no fundamental difference between "data a user uploaded" and "the output of an analysis." Both are
**typed artifacts**: a blob of storage + a **datatype** + provenance. So:
- **Every node in the graph is a typed artifact.** A **dataset = a source artifact** (produced by
  upload/import, no upstream analysis). An **analysis output = a derived artifact** (produced by an analysis).
- **An analysis consumes typed artifacts and produces typed artifacts.** It doesn't care whether its input was
  uploaded or computed — only its **type**.
- This IS live8's **provenance graph** (§0.6) generalized: nodes = typed artifacts, edges = analyses, datasets
  = roots. One graph does lineage, composition, *and* the dataset/analysis model.

So "analysis performs on whatever dataset it's compatible with, OR the output of whatever analysis it's
compatible with" (your words) = **type-matching over the artifact graph**. Compatibility, not a fixed pipeline.

## The open **datatype registry** (extension-contributed)
The closed `DataKind` enum I used (`expression|embedding|clustering|…`) was single-cell-specific and **wrong for
the general case**. Replace it with an **open registry of datatypes**, contributed by extensions:
```ts
interface Datatype {
  id: string                         // 'single-cell/anndata', 'variant/vcf', 'structure/pdb', 'geneset/gmt'
  extends?: string                   // subtyping — 'single-cell/anndata' extends 'matrix' extends 'tabular'
  schema: JsonSchema                 // validation of the artifact's metadata/shape
  storage: StorageSpec               // HOW it's stored + read (format-agnostic — below)
  validate(ref): Result
  ingest?: IngestSpec                // parse an uploaded file → this type (import path)
  converters?: ConverterRef[]        // implicit conversions to other types (Galaxy-style)
  viewers: ViewerRef[]               // how it renders (below)
  capabilities?: string[]            // e.g. 'sliceable', 'has-obs', 'genomic-coords'
}
```
- **Subtyping is the key to broad compatibility (the Galaxy lesson).** `single-cell/anndata extends matrix
  extends tabular extends data`. An analysis that `accepts: matrix` therefore works on `single-cell/anndata`,
  `spatial/visium`, `bulk/counts` — anything that *is-a* matrix — so tools are reused across data types
  without per-type wiring. The registry is a **type lattice**, and compatibility = subtype check.
- **New data types = a new registry entry**, no core change. `bulk/counts`, `pathway/gene-set`,
  `genome/bigwig`, `variant/vcf`, `structure/pdb`, `sequence/fastq`, `image/ome-tiff` — each an extension.

## Datasets = upload + process, contributed by extensions
"`dataset` is where people upload data and process whatever they like; extensions contribute that" — concretely:
- **Ingest extensions** turn an upload into a typed dataset: `import.anndata` (`accepts:file/h5ad →
  produces:single-cell/anndata`), `import.seurat`, `import.vcf`, `import.pdb`.
- **Pipeline extensions** turn raw data into a processed dataset: `pipeline.scrnaseq-fastq`
  (`accepts:sequence/fastq → produces:single-cell/counts`, runs nf-core/Cell Ranger in compute),
  `pipeline.bulk-rnaseq`, `pipeline.spatial`. A pipeline is just an analysis whose input is raw + output is a
  processed dataset.
So "fastq→single-cell", "fastq→bulk", "import Seurat/AnnData" are all **dataset-producing extensions** — the
dataset is the typed artifact they emit. Upload is a host capability (file store); *what the upload becomes* is
an extension's ingest/pipeline.

## Analyses = typed transformations, composed by compatibility
```yaml
contributes:
  analyses:
    - id: clustering.leiden
      accepts: [ {type: neighbor-graph}, {type: matrix, subtypesOf: true} ]   # type-selector, subtyping-aware
      produces: [ {type: clustering} ]
```
The host computes **availability by type-match over the registry** (this generalizes the `requires`/`produces`
gating): show `clustering.leiden` on any artifact that is-a `matrix`/`neighbor-graph`. A pathway analysis
`accepts:[geneset, de-table]`; a genome analysis `accepts:[variant/vcf, genome/bigwig]`; a structure analysis
`accepts:[structure/pdb]`. Each composes only where types match — the workbench offers the compatible analyses
for whatever artifact is in focus, across *all* data types.

## Viewers are datatype-contributed too (the canvas generalizes beyond deck.gl)
This is the other single-cell assumption to fix: **not every datatype is a scatter.** live3's deck.gl view-kinds
render *matrix/embedding-shaped* data (scatter/heatmap/violin/…). But:
- a **genome track** wants an IGV-style **track browser**,
- a **protein structure** wants a **molecular viewer** (Mol\*),
- a **pathway/network** wants a **graph** viewer,
- a **variant set** wants a **variant table + lollipop**,
- a **spatial** artifact wants an **image + overlay**.
So the canvas dispatches **viewers keyed by datatype** (each datatype declares its `viewers`); the deck.gl
view-kind registry (after the switch→registry refactor) is **one viewer family, for matrix-like types.** A
genome/structure/network viewer is a *different* renderer contributed by *its* extension. The "plotTypes"
contribution point generalizes to a **viewer registry keyed by (datatype → view-kinds)**.

## Format-agnostic storage (correct DATA_STORAGE_REDESIGN's HDF5 assumption)
`DATA_STORAGE_REDESIGN` assumed HDF5 because it was scoped to single-cell matrices. In the open model, **each
datatype owns its storage format**: HDF5/Parquet for matrices, VCF/BCF for variants, mmCIF/PDB for structures,
GMT/JSON for gene-sets, BigWig for tracks, object blobs for FASTQ/BAM. The **working store is format-agnostic**
(content-addressed blobs + the datatype's reader); the **catalog** indexes `(datatype, storage-ref, shape,
provenance)` uniformly. HDF5 becomes *one datatype's storage*, not the platform's assumption. The **data API**
reads through the datatype's `storage`/reader, so a viewer/analysis gets typed access regardless of underlying
format.

## Study = a bag of datasets (of any types)
A study references artifacts of **heterogeneous datatypes** (single-cell + spatial + bulk + variants in one
study). No change to the study substrate (§0.5) — it's already a container scoped by tenancy; it just contains
typed artifacts, not single-cell-only ones.

## What this corrects in the earlier docs
- **`DataKind` (closed enum) → the open datatype registry** (§1/§5 of PLATFORM_ARCHITECTURE). Compatibility =
  subtype match, not a fixed vocabulary.
- **HDF5-only working store → format-agnostic storage** (datatype owns format).
- **`plotTypes` view-kinds → viewer registry keyed by datatype** (deck.gl view-kinds are the matrix-family
  viewer; genome/structure/network viewers are other families).
- **`dataset` placeholder → the typed source-artifact** (= an artifact with `produced_by: upload/pipeline`).
- **`requires`/`produces` → typed `accepts`/`produces`** with subtyping.

## Fetching/streaming data to a viewer without Rust-per-format
The tension: today's streaming is **Rust reads HDF5 → slices → typed binary** (server-mediated,
`DATA_STORAGE_REDESIGN`). That's great for the single-cell hot path but **can't generalize** — the Rust host
has no reader for an extension's VCF/PDB/BigWig/custom format, and extensions add no Rust. Resolution: a
**tiered data-access model**, and the key insight is that **most extension datatypes use Tier 1, which needs
zero format-specific host code** — because that's how the real heterogeneous-viewer ecosystem already works.

**Tier 1 — Authed byte/range serving + CLIENT-SIDE decode (format-agnostic, no Rust per format).**
The host exposes any artifact through a **permission-gated, study/user-scoped byte + HTTP-Range endpoint**
(`GET /api/artifacts/{id}` + `Range:`). The **viewer extension ships the reader as JS/WASM** and decodes in
the browser. This is not a workaround — it's the dominant pattern:
- **Vitessce** reads AnnData-Zarr + OME-Zarr **directly from object storage via range requests**, client-side.
- **igv.js / IGV** fetches indexed BAM/VCF/BigWig via **HTTP range requests**, indexes + decodes client-side.
- **Mol\*** fetches mmCIF/BinaryCIF over HTTP, parses in JS/WASM. **zarrita** reads Zarr chunks by range;
  **h5wasm** reads HDF5 in the browser.
So genome tracks, structures, networks, Zarr, spatial images — the whole long tail — need the host only to be
a **dumb authed range server** (which it provides generically over the working store). The datatype/viewer
extension owns the decoder. **No Rust per format.**

**Tier 2 — Server-side typed slicing over GENERIC STORAGE LAYOUTS (host, domain-neutral, available to ANY
datatype — single-cell is NOT privileged).**
The interactive fast path (color-a-500k-cell-scatter-by-gene = a sparse column slice, 60fps, don't ship the
whole matrix) is real — but the fast slicer must be keyed on a **generic storage layout, never on the
data domain.** The host provides fast typed-binary slicing over a **small fixed set of domain-neutral chunked
layouts**:
- `chunked-dense-array` (N-D), `chunked-sparse` (CSC/CSR), `columnar-table`, `chunked-1d` (tracks) — i.e. the
  **Zarr / TileDB / Arrow** model: chunked, typed, sliceable by index/range, **domain-agnostic**.
A **datatype declares which layout its artifacts use** + a mapping from its *semantic* selectors (gene→column,
cell→row, locus→range, residue→index) to layout indices. The host slices the **layout**, not "a single-cell
matrix." So:
- **single-cell** expression = a `chunked-sparse` artifact → fast gene-column slicing;
- **bulk** matrix = `chunked-dense` → fast column slicing;
- **spatial** = `chunked-dense` + coords → same;
- a **genome track** = `chunked-1d` → fast range slicing;
- **any future datatype** that stores in a supported layout gets the identical fast path — **with no Rust and
  no privilege.** Single-cell is just one consumer of the sparse layout; it is **not a special tier.**
This **corrects** `DATA_STORAGE_REDESIGN` (which baked HDF5-sparse-CSC as *the* format): the fast path is a
generic chunked-store slicer (Zarr/TileDB-shaped); HDF5-sparse is *one layout a datatype may pick*, equal to
dense/columnar/1-D. The privilege lives on the **layout** (a generic engineering primitive every datatype can
opt into), never on the **domain**. (Vitessce already runs single-cell *and* imaging on one Zarr store —
proof the generic-chunked-store approach spans domains.)

**Tier 3 — Precompute a fast-serveable artifact via the sandbox (novel format needing a fast server slice).**
If a viewer needs a *computed/aggregated/indexed* view of a novel format that neither client-decode nor the
core slicer handles (a density aggregation, a downsample, a spatial pyramid, a tabix index), that work is
**reified as an analysis**: a sandbox/sidecar step reads the weird format (Python has a reader for everything —
pysam, pyBigWig, biotite) and **writes a Tier-1/Tier-2-serveable artifact** (a downsampled matrix, a
precomputed index, a Zarr pyramid). The viewer then fetches *that* fast. Heavy format-specific server work
becomes a provenance-tracked precompute, never a live per-request Rust read.

**So how extensions help with fetching:** they ship (1) a **client-side decoder** over range-served bytes
(the default — igv.js/Mol\*/Vitessce/zarrita style), OR (2) they **store in a generic sliceable layout** and
declare the selector→index mapping, getting Tier-2 fast slicing for free, OR (3) for a format that maps to
neither, a **sandbox precompute** emits an artifact in a generic layout / client-decodable form. The host
provides exactly two generic, **domain-neutral** capabilities — **authed range serving of any artifact** +
**typed slicing over the generic chunked layouts** — and **neither knows what single-cell is.** Every datatype,
single-cell included, is an equal consumer. (Auth matters: the range + slice endpoints are permission-gated +
study-scoped, not a static server, so extensions inherit access control.)

This **corrects `DATA_STORAGE_REDESIGN`** in two ways: (a) its server-mediated slicing becomes a **generic
chunked-store slicer keyed on layout, not on "single-cell matrix"** (Tier 2, any datatype); (b) add **Tier 1
(range + client decode)** for opaque formats. HDF5-sparse-CSC is *one layout among dense/columnar/1-D*, chosen
by a datatype, not the platform's privileged format.

## One job → many output files of different types
A run rarely produces one file. Cell Ranger emits a matrix + a BAM + `web_summary.html` + `metrics.csv`; a DE
run emits a Parquet table + a volcano spec + a stats JSON. Two distinctions resolve this — and both fall out of
the provenance graph:

**1. A run produces a SET of typed artifacts (one run node → N output edges).** This is already live8's model
("a multi-analysis job = N run nodes"; outputs are edges) — generalized: **each coherent typed output is its
own artifact node**, all sharing the run as producer. So the Cell Ranger run yields *four* artifacts —
`expression` (single-cell/expression), `alignment` (sequence/bam), `qc` (report/html), `metrics` (table) —
each independently typed, cataloged, addressable, and consumable. Multi-output is native; nothing special.

**2. An artifact may be MANY physical files but presents as ONE typed thing.** A Zarr store is a directory of
chunk objects; a BAM is `.bam`+`.bai`; a 10x matrix is `matrix.mtx`+`barcodes`+`features`. The **datatype
declares its file layout** (a prefix/manifest), and its reader assembles them. So "several files that form one
logical dataset" = **one artifact** whose storage-ref is a prefix; "several outputs of different types" = **N
artifacts**. Don't conflate the two.

**How the job declares it — the `produces` manifest maps output paths → typed artifacts:**
```yaml
produces:
  - { id: expression, type: single-cell/expression, from: outputs/filtered.h5 }   # → converted to a Zarr artifact
  - { id: alignment,  type: sequence/bam,           from: outputs/possorted.bam } # → served as-is (+.bai)
  - { id: qc,         type: report/html,            from: outputs/web_summary.html }
  - { id: metrics,    type: table,                  from: outputs/metrics.csv }    # → Parquet
```
The compute writes to `/outputs/*` + a `manifest.json`; the host **ingests each declared output as its own
artifact** (storage per its datatype's format — §"Storage technology") + a **provenance edge from the one run
node**. Files the analysis does NOT declare (logs, temp/intermediate) are captured as **run logs / generic
`file/blob`** for provenance, **not promoted** to first-class artifacts — the `produces` manifest is the
contract for what becomes a typed dataset.

**Downstream binds to the SPECIFIC typed output, not "the job."** A clustering `accepts: single-cell/expression`
→ binds the `expression` artifact; a genome viewer `accepts: sequence/bam` → binds `alignment`; the QC panel
renders `qc`. Precise, type-matched composition over individual outputs — never "consume the whole bundle."

**The run node IS the grouping.** "All outputs of this job" is a *view* over the run node's output edges
(provenance), not a storage concept — so the UI can show "Cell Ranger produced: expression · alignment · qc ·
metrics" by walking the run, while each output remains independently addressable.

**Prefer decomposed artifacts over one monolith** (per `DATA_STORAGE_REDESIGN`'s mutation-first rule): an
embedding, a clustering, an obs column are each their *own* small artifact (independently add/remove/re-run) —
a big AnnData/Seurat object is **assembled only on export**, never the working unit. So "a job that produces an
AnnData" actually emits several small typed artifacts aligned to the study's canonical axes — which is exactly
the one-run→many-artifacts model.

### Provenance implications (flag for live8's `feat/provenance` model)
Multi-output changes the provenance graph in specific ways — and it maps onto live8's stated model (*"ANALYSIS
is the provenance unit, JOB is the execution unit; a multi-analysis job = N run nodes"*):
- **One analysis run = ONE run node that FANS OUT to N artifact nodes** (N output edges) — distinct from a
  *multi-analysis* job (N run nodes). The graph needs run→{artifact_i} fan-out cardinality.
- **The reproduce/re-run unit is the RUN, not the individual artifact.** The N outputs are **jointly produced
  by one code execution**, so you cannot regenerate one output alone — re-running the producer regenerates the
  whole set atomically. (Contrast the **consume** unit, which *is* the individual artifact — downstream binds
  one output. So produce-atomically / consume-individually.)
- **Content identity per artifact; output-signature per run.** Each artifact (even a multi-file one — a Zarr
  prefix, BAM+bai) is **one node with one content hash** (a merkle/manifest hash over its files). The run's
  **output signature = the set of `(output-id, hash)`**; live8's in-sandbox **re-run verification** checks all
  N hashes match, not one.
- **Lineage stays per-artifact (precise).** Because downstream binds specific outputs, edges are exact; a run
  that emitted 4 artifacts where only `expression` is used leaves the BAM/qc **off the dependency path** —
  reachability from a final result naturally distinguishes **used vs dead outputs.**
- **The `produces` manifest IS captured provenance** — recorded on the run node alongside the content-addressed
  **code blob** + path-agnostic **`inputs.json`**, so the graph knows which output path became which typed node
  (and the reproduce-script re-emits the same manifest).
- **Minimal reproduce/export = backward reachability over artifact edges.** A multi-output run is included in a
  figure's reproduce bundle **iff any of its outputs is on the path**; unused sibling outputs aren't *carried*
  but *do* regenerate on re-run (since the code produces the set). Export scoping walks artifact-dependency
  edges, not runs.
- **Ancillary files (logs, temp) are NOT graph nodes** — they attach to the run node as run metadata for audit,
  keeping the derivation graph to declared typed artifacts only.

Net: multi-output is the **fan-out edge** in the provenance graph. The graph already is the composition DAG +
the lineage record (§0.6); this just makes a run node point at *several* typed artifacts, with
**produce-atomically / consume-individually** semantics and a **set-valued output signature** for verification.

## Storage technology (concrete — what we store AS, and how each format is served)

The big insight: **choose Zarr as the served chunked format and the server-side slicer disappears** — because
Zarr stores each chunk as its own object, the **client reads only the chunks it needs over an authed range
endpoint**, so the Rust host is a *dumb range server*, not a format slicer. This is exactly how **Vitessce**
streams 500k+ cell AnnData-Zarr today. It also makes single-cell non-special by construction: it's just one
Zarr consumer.

**The stack:**
1. **Blob substrate — S3-compatible object storage** (MinIO self-host / S3 cloud / **filesystem for
   desktop+dev**). Range-native (`Range:`/S3 byte-range GET). Not public/static — the host mediates every read
   with **permission + study scoping** (auth preserved, which is why `DATA_STORAGE_REDESIGN` originally reached
   for server-mediation; we keep the auth, drop the per-format server slicing).
2. **Served chunked-array format — Zarr (v3)** for the generic sliceable layouts (dense/sparse/1-D). Chunk =
   object ⇒ **the client (`zarrita.js`) slices by fetching only needed chunks** over the authed range endpoint.
   Domain instances: **AnnData-Zarr** (single-cell), **OME-Zarr** (imaging/spatial). A gene column ≈ one
   gene-chunk of `indices` + one of `data` + an `indptr` peek → sub-ms, KB on the wire, **no server slicer.**
3. **Columnar tables — Parquet (Arrow)** for DE tables, `obs`/`var`, catalogs. Range-readable + queryable in
   the browser (**DuckDB-WASM / Arrow**) or server (DuckDB/Polars). The `columnar-table` layout.
4. **Self-indexed domain formats — served AS-IS over range** for their native viewers: **VCF+tabix (`.vcf.gz`+
   `.tbi`)**, **BigWig** (self-indexing), **BAM+bai**, **mmCIF/BinaryCIF**. The viewer's client lib (**igv.js**,
   **Mol\***) reads them by HTTP range using their own index. **Zero host format code.**
5. **Catalog / relational metadata — Postgres** (the host-owned index; §5.5-B). Small rows, not the data.

**The incumbent problem — HDF5 (what scanpy/Seurat/anndata WRITE):** HDF5 is a single file, not chunk-as-object,
so it doesn't range-serve natively. Two host-provided ingest options, both making the served path Zarr with
**no HDF5-specific Rust**:
- **(a) Convert to Zarr on ingest** — `anndata`/`zarr` in the sandbox rewrites `.h5ad` → AnnData-Zarr (the
  common path; scanpy/anndata do this natively).
- **(b) Kerchunk-virtualize** — write a small **reference index** (JSON) mapping Zarr chunk keys → byte ranges
  *inside* the original HDF5, so Zarr clients read the untouched `.h5` by range. No rewrite; the `.h5` is served
  through the Zarr abstraction.

**Per-format, concretely:**
| Datatype | Stored as | Served how | Sliced/decoded where |
|---|---|---|---|
| single-cell expression | Zarr (from `.h5ad` via convert/kerchunk) | authed range | **client** (zarrita + CSC helper) |
| embedding / dense matrix | Zarr `chunked-dense` | authed range | client (zarrita) |
| DE / obs / var tables | Parquet | authed range | client (DuckDB-WASM/Arrow) or server (DuckDB) |
| variants (VCF) | `.vcf.gz`+`.tbi` as-is | authed range | **client** (igv.js, tabix index) · analysis via sandbox `bcftools`→Parquet |
| genome coverage (BigWig) | `.bw` as-is (self-indexed) | authed range | **client** (igv.js) |
| alignments (BAM) | `.bam`+`.bai` as-is | authed range | client (igv.js) |
| protein structure | mmCIF/BinaryCIF as-is | authed range | **client** (Mol\*) |
| imaging / spatial | OME-Zarr | authed range | client (Viv/Vitessce) |
| gene sets | Parquet / JSON (small) | authed range or Layer-C collection | client |

**The Rust host's data role — one thing, domain-neutral:** an **authed, study-scoped byte + Range server** over
object storage, plus the Postgres catalog and sandbox-compute orchestration. **No HDF5/VCF/BigWig-specific Rust
in the serving path** — formats decode at the edges (browser viewers via zarrita/igv.js/Mol\*/DuckDB-WASM, or
the sandbox for compute). The one place server-side compute-on-read is still wanted (a 10M-point density
aggregation, a spatial pyramid) is **Tier 3**: a sandbox/GPU **precompute writes a Zarr pyramid** the client
then range-reads — never a live per-request Rust read.

So: **store served arrays as Zarr, tables as Parquet, self-indexed genomics/structure formats as-is; put them
in S3-compatible object storage; the host serves authed byte-ranges and owns the Postgres catalog; every format
is decoded/sliced at the edge.** Single-cell rides this exactly like every other datatype — no privileged tier,
no format-specific core code.

## Honest scope note
This makes the platform a **general typed-artifact bioinformatics workbench**, not a single-cell app — a
bigger ambition, but the model is proven (Galaxy runs thousands of tools × hundreds of datatypes this way).
For the near-term slice it costs little: implement the datatype registry with 2–3 types (single-cell/anndata,
its `matrix` supertype, `clustering`) and the type-match gating — the *same* wiring the single-cell modules
need — but with the seam open, so bulk/spatial/variant/structure are later registry entries + viewer
extensions, not a re-architecture. **Design the seam open now; populate it incrementally.**
