# 07 — Legacy `sc-website-scripts` Pipeline Digest

> **Source:** `/data/pbya/txresbench/tmp/txresbench-ref/sc-website-scripts` (the
> "iSCanGuide" project). Scripts run under the `QueueUtils` job-queue framework
> (`github.com/tinnlab/sc-task-queue`) inside the `sc-common` conda environment.
> This digest covers ONLY the **data-processing** scripts in scope:
> `data-process.R`, `save-sample.R`, `sample-add-metadata.R`, the `utils/`, and
> `conda/`. The analysis scripts (`clustering-create.R`, `de-create.R`,
> `embedding-create.R`, `enrichment-create.R`, `time-trajectory.R`,
> `annotation-celltype-prediction.R`) are **out of scope** and only referenced
> where they reveal a pipeline boundary.

---

## 0. TL;DR — what the legacy pipeline actually is

The concrete reference pipeline is a **minimal, Seurat-5 / R-centric import + QC +
filter path**, split across three job scripts:

| Stage | Script | What it does |
|---|---|---|
| **Import + QC metrics** | `data-process.R` | Load counts (AnnData `.h5ad` or 10x `.h5`/`.mtx`) → build a Seurat object → compute per-cell **nCount, nFeature, % mito, % ribo** → emit a serialized result object. |
| **QC filter + sample split + normalize** | `save-sample.R` | Apply **manual per-sample min/max thresholds** on the QC metrics → split into named samples → compute **`log2(x+1)`** → carry embeddings. |
| **Metadata join** | `sample-add-metadata.R` | Merge an external CSV/TSV metadata table into a saved sample by matching a cell-ID column. |

**Crucially, what the legacy pipeline does NOT do** (all of which the modern
landscape — docs `04`/`05` — treats as standard):

- ❌ **No empty-droplet calling** (assumes the *filtered* matrix is the input).
- ❌ **No ambient-RNA removal** (no SoupX / CellBender / DecontX).
- ❌ **No doublet detection** (no scDblFinder / Scrublet / DoubletFinder).
- ❌ **No advanced normalization** (no SCTransform, no scran pooling, no Pearson
  residuals) — only `log2(count+1)`.
- ❌ **No adaptive QC** (thresholds are user-supplied fixed min/max, not MAD-based
  outlier detection).
- ❌ **No HVG / scaling / PCA / integration in the processing stage** (HVGs +
  Harmony integration live in the out-of-scope `embedding-create.R`).

So for a re-implementation, this pipeline is the **baseline skeleton** — import →
QC-metric → threshold-filter → log-normalize — onto which the modern preprocessing
steps documented in `04-pipeline-steps.md` and `05-tools-and-parameters.md` should
be grafted.

**Ecosystem note:** the reference stack is **R / Seurat 5 / Bioconductor**, NOT
Scanpy/Python. Python (`anndata`, `reticulate`) is present in the conda env but the
`.h5ad` read path deliberately parses HDF5 **directly with `rhdf5`** (the reticulate
branch is commented out) — because these jobs are designed to also run **in-browser
under WebAssembly** (`IS.WASM <- R.Version()$os == "emscripten"`), where a Python
interpreter is unavailable.

---

## 1. The job-queue harness (`QueueUtils`)

Every script is a **job** executed by a dispatcher. Shared shape:

```r
QueueUtils::debug(studyId=..., jobId=..., paramsDir=..., dataDir=..., srcDir=...)  # local-only stub; dispatcher ignores
library(QueueUtils)
QueueUtils::wrapCode({
  params <- QueueUtils::args(defaultArgs = list(...))   # read JSON params for this job
  QueueUtils::writeLog("...")                           # progress log back to the UI
  inputFile <- QueueUtils::resolveFile(params$file)     # resolve a data-dir file handle
  ...
  QueueUtils::writeResult(resultObject)                 # serialize result to the study's data store
})
```

- `args(defaultArgs=…)` — the job's typed parameter contract (populated by the web
  UI). `resolveFile()` maps a logical file handle to a path under `dataDir`.
- `wrapCode({…})` — error boundary + result capture. `writeLog()` streams status.
- `writeResult()` / `OUTPUT_FILE` — persist the result into the app's custom HDF5
  store (see §5).
- `@env: sc-common` header pragma selects the conda env for the job.

This is directly analogous to the txresbench **jobs scheduler** — each processing step is
a discrete, parameterized, logged job over a shared data store.

---

## 2. `data-process.R` — import + QC-metric computation

**Role:** raw upload → a normalized in-memory count object with QC metrics. **The
single import chokepoint.**

### 2.1 Parameter contract (`params`)

| Param | Default | Meaning |
|---|---|---|
| `fileType` | `"AnnData"` | `"AnnData"` (`.h5ad`) or `"10x"` (`.h5` / `.zip` / `.gz`). |
| `file` | `NULL` | The uploaded counts file handle. |
| `assay` | `"Default"` | For 10x multi-assay: which `feature_type` to keep (`Gene Expression`, `Antibody Capture`, …). |
| `cellIdColumn` | `"_index"` | Which `obs` column is the cell barcode/ID. |
| `featureIdColumn` | `"_index"` | Which `var` column is the feature ID (`_index`/`id` = Ensembl, `name` = gene symbol). |
| `keepMetadata` | `FALSE` | Retain the full `obs` table as extra metadata. |
| `hasMultipleSamples` | `FALSE` | Whether the file pools multiple samples. |
| `sampleIdIn` | `"cellId"` | Where the sample ID comes from: `"cellId"` (barcode prefix/suffix) or `"metadata"` (an `obs` column). |
| `sampleIdDelimiter` / `sampleIdDelimiterPosition` | `"_"` / `1` | For `cellId` mode: split the barcode and take field N as the sample ID. |
| `sampleIdColumn` | `NULL` | For `metadata` mode: the `obs` column holding the sample ID. |
| `metadataFile` / `metadataCellIdColumn` / `extraMetaDataHeaders` | `NULL` | Optional external metadata join at import time. |
| `keepEmbeddings` / `embeddings` | `FALSE` / `NULL` | Carry precomputed `obsm/X_*` embeddings + their 2D visualization. |

### 2.2 The AnnData `.h5ad` read path (`readCountFile`, `fileType == "AnnData"`)

Reads the `.h5ad` **directly via `rhdf5`** (no anndata/Python):

1. **`obs` (cell metadata):** `h5read(h5file, "obs")`. Handles the **legacy
   categorical encoding** — an `obs/__categories` group holds level tables and
   integer-coded columns are decoded with `factor(categories[codes+1])`. (Modern
   AnnData instead stores each categorical column as a `{categories, codes}` group
   with an `encoding-type` attribute — see `01-file-formats.md`; this script's
   `list.to.data.frame` also handles the per-column `$codes`/`$categories` shape.)
   Row names default to the `cellIdColumn`.
2. **`var` (feature metadata):** same `list.to.data.frame`. Feature IDs taken from
   `featureIdColumn`, coerced to character, `make.unique()`.
3. **`X` vs `raw/X`:** if a `raw` group exists it reads `raw/X` (raw counts
   preferred over a possibly-normalized `X`); else reads `X`.
4. **Sparse reconstruction:** `X` is a CSC store (`data`, `indices`, `indptr`);
   rebuilt with `Matrix::sparseMatrix(i=indices, p=indptr, x=data, dims=…,
   repr="C", index1=FALSE)` (0-based). Result is oriented **features × cells**
   (transpose of AnnData's cells × features).
5. **Embeddings (optional):** for each requested embedding, reads
   `obsm/X_<name>` and its visualization counterpart, transposes.

### 2.3 The 10x read path (`fileType == "10x"`)

Dispatches on extension:

- **`.h5`** (`Read10X_h5`-equivalent, hand-rolled via `rhdf5`):
  - Unwraps the `/matrix` group if present (**Cell Ranger v3**) vs the root
    (**v2**).
  - **Two matrix encodings** handled:
    - `indices`/`indptr`/`data`/`shape` → CSC (`repr="C"`), the v3 feature-barcode
      matrix.
    - `barcode_idx`/`feature_idx`/`count` → COO triplet (`repr="T"` → coerced to
      CSC), an older/molecule-style layout.
  - **Assay filtering:** `keep <- which(features$feature_type == assay)` — this is
    how a **CITE-seq / multiome** file's `Gene Expression` vs `Antibody Capture` /
    `Peaks` sub-matrices are separated. Errors if no assay chosen.
  - `featureIdColumn == "name"` → gene symbols; else Ensembl IDs.
- **`.zip` / `.gz`** (MEX bundle): extract to a temp dir, locate the single
  `matrix*` directory, `Seurat::Read10X(gene.column = 2 if "name" else 1)`.

### 2.4 Seurat object + multi-sample handling

- **`hasMultipleSamples == TRUE`, `sampleIdIn == "cellId"`:**
  `CreateSeuratObject(counts, names.delim=<delim>, names.field=<pos>)` — Seurat
  derives `orig.ident` from the barcode.
- **`sampleIdIn == "metadata"`:** create the object, then set
  `seuratObject@meta.data$orig.ident <- <sampleIdColumn values>`.
- **Single-sample:** `names.delim="__________"` (a delimiter that never matches) so
  everything is one sample.

### 2.5 QC-metric computation (the only "processing" here)

```r
seuratObject <- PercentageFeatureSet(seuratObject, pattern="^MT-|^mt-|^MT\\.|^mt\\.",  col.name="percent.mito")
seuratObject <- PercentageFeatureSet(seuratObject, pattern="^RPS-|^RPL-|^Rps-|^Rpl-|^RPS\\.|^RPL\\.|^rps-|^rpl-", col.name="percent.ribo")
```

- **% mitochondrial** — `MT-`/`mt-` prefixed genes (human upper / mouse lower;
  both `-` and `.` separators). `NA → 1` (cells with zero genes are pushed to 100%
  so the filter can drop them). Mito gene list stored in `misc$mitoGenes`.
- **% ribosomal** — `RPS`/`RPL` prefixed genes. `NA → 1`. List in
  `misc$riboGenes`.
- `nCount_RNA` / `nFeature_RNA` come free from `CreateSeuratObject`.

### 2.6 Output object (`resultObject`)

```
X         : sparse counts (features × cells)
var       : feature (row) names
obs       : { id, ident (sample), nCount, nFeature, mitoPercentage, riboPercentage }
misc      : { mitoGenes, riboGenes }
metadata  : (optional) full obs / joined external metadata
embeddings, vis2D : (optional) carried embeddings
```

**No filtering, no normalization** happens here — this stage only *measures*.

---

## 3. `save-sample.R` — QC filtering + sample split + log-normalize

**Role:** turn the measured object into per-sample, filtered, log-normalized
"samples" — this is where the **QC gate** lives.

### 3.1 Parameter contract

A `filter` list, one entry per candidate sample:

```
filter: [ {
  id, save (bool), originalName, newName,
  filter: [ { criteria, min, max }, ... ]     # e.g. criteria="nCount"/"nFeature"/"mitoPercentage"/"riboPercentage"
} ]
embeddings: [ { id, name, embedding, visualization } ]
```

### 3.2 Logic

1. Parse the app's custom serialized input (`h5DatasetParse`, §5) into `X`, `obs`,
   `metadata`, `misc`.
2. For each sample with `save == TRUE`:
   - `keepFlag <- obs$ident == originalName` (select the sample's cells), then
     **AND** every filter criterion: `obs[[criteria]] >= min & <= max`.
   - **This is the QC filter** — plain **fixed min/max thresholds** on the
     per-cell QC metrics (`nCount`, `nFeature`, `mitoPercentage`,
     `riboPercentage`). No adaptive/MAD logic; the user picks the cutoffs in the
     UI (typically from an interactive violin/scatter of the metrics).
   - Subset `X`, `obs`, `metadata` to `keepFlag`; assign fresh 17-char random
     `systemCellIds`; keep `originalCellIds`; store `features`.
   - **Normalize:** `Xlog2@x <- log2(x + 1)` (a `log2` transform of raw counts —
     *not* library-size normalized; simpler than Scanpy's `normalize_total` +
     `log1p` or Seurat's `LogNormalize`).
   - Carry the matching embedding + 2D visualization, subset to kept cells.
3. `writeResult(resultObj)`.

**Takeaway:** the QC strategy is **interactive, manual, per-sample threshold
filtering** — the opposite of the automated adaptive/knee-based approaches in the
modern QC literature (see `05`). It's simple and transparent but leaves ambient
RNA, doublets, and empty droplets entirely to the user's cutoffs.

---

## 4. `sample-add-metadata.R` — external metadata join

**Role:** merge a user-uploaded CSV/TSV of per-cell metadata into an already-saved
sample.

- Read CSV/TSV (`stringsAsFactors=T` so text columns become factors).
- Read the saved sample's `originalCellIds` from the custom h5.
- Match the metadata's `cellIdColumn` to the sample cells; **reorder** to the
  sample's cell order (`match(sampleCellIds, …)`).
- Rename columns to `params$columns`; drop the ID column.
- Write each column into the custom h5 under
  `$value/<sampleId>/$value/metadata/$value/<col>`, encoding **factors** as
  `{$type:"factor", $value:{levels, values(codes)}}` and **numerics** as
  `{$type:"arrayDecimal"}`; update the `$index`/`$index1`/`$index2` bookkeeping
  (column names / row names / column names).
- Distinguishes **overwrite** (column already present, type-checked — refuses to
  turn a categorical column non-categorical) vs **new** columns.

This is the "sample-level covariate" join — attaching condition/donor/treatment
labels after import, keyed by cell barcode.

---

## 5. The custom HDF5 serialization (`utils/h5Parse.R`)

The app persists R objects to HDF5 in a **bespoke tagged-tree layout** (NOT h5ad,
NOT loom). Each node is `{$type, $value, [$index, $index1, $index2]}`:

| `$type` | Decodes to |
|---|---|
| `sparseCMatrix` | `Matrix::sparseMatrix(i,p,x, Dim, Dimnames, repr="C", index1=FALSE)` (CSC, 0-based). |
| `string` / `int` / `decimal` (+ `array*`) | the raw `$value`. |
| `boolean` / `arrayBoolean` | `as.logical($value)`. |
| `factor` | `factor(levels[values+1], levels)` (0-based codes). |
| `object` | a `data.frame` (if `$index1` present → row names, `$index2` → col names) or a named list, recursively parsed via `$index`. |
| `matrix` | dense matrix with `$index1`/`$index2` dim names. |

`Random.id(n=17)` mints Meteor-style IDs that never start with a digit (used for
`systemCellIds`). `utils/getData.R` is the **downstream** loader that reassembles
`obs` across samples and gathers metadata/clusters/annotations for analysis jobs
(mostly analysis-side — noted only for the boundary). `utils/disableParallel.R`
pins every job to **single-threaded** BLAS/OpenMP/`future`/`data.table` (the queue
runs many jobs concurrently, each on one core).

---

## 6. The environment (`conda/sc-common`)

`environment.yml` (channels: conda-forge, bioconda):

- **R 4.3.3**, `r-seurat=5`, `r-matrix`, `r-reticulate`, `r-tidyverse`,
  `r-stringr`, `r-uwot` (UMAP), `r-rtsne` (t-SNE), `r-pbmcapply`, `r-matrixtests`,
  `bioconductor-rhdf5`.
- **Python 3.12** + `anndata` (present for reticulate interop, though the h5ad path
  bypasses it).

`setup.sh` adds (BiocManager / remotes / GitHub):

- **`Rhdf5lib`, `BH`** — HDF5 + Boost headers.
- **`harmony`** — batch integration (used in the out-of-scope `embedding-create.R`).
- **`presto`** — fast Wilcoxon rank-sum (DE, analysis-side).
- **`MAST`, `DESeq2`** — DE / pseudobulk (analysis-side).
- **`fgsea`** — gene-set enrichment (analysis-side).
- **`slingshot`** — trajectory (analysis-side).
- **`ClusterR`, `BiocNeighbors`, `DelayedMatrixStats`** — clustering / kNN / matrix
  stats.
- **`scDesign3`, `ClusterDE`** — simulation + cluster-DE significance.
- **`onnxruntime` / `onnxruntime-gpu`** — runs the ONNX cell-type-prediction model
  (`annotation-celltype-prediction.R`, analysis-side).

**Implication:** the data-processing steps rely only on **Seurat 5 + Matrix +
rhdf5**. The heavier Bioconductor / GitHub packages exist for the *analysis* jobs.
Notably **absent** from the whole env: any ambient-RNA (SoupX/CellBender), doublet
(scDblFinder/DoubletFinder/scran's `doubletCells`), empty-droplet (DropletUtils),
or SCTransform/`glmGamPoi` dependency — confirming the minimal processing scope.

Reference data shipped in-repo: `data/symbol-to-ensembl/Human.rds` (gene-symbol ↔
Ensembl map) and `data/gene-length/Human.rds` (for length-based normalizations,
analysis-side).

---

## 7. Gap analysis — legacy vs. the modern reference (for a re-implementer)

| Modern step (docs 04/05) | Legacy status | Gap to close |
|---|---|---|
| Alignment / quant | Out of scope (assumes counts uploaded) | Optionally add Cell Ranger / STARsolo / alevin-fry / kb ingest. |
| Import (10x mtx/h5, h5ad) | ✅ `data-process.R` | Add loom / Zarr / SCE / MuData; robust modern AnnData categorical + `encoding-version`. |
| Empty-droplet calling | ❌ | Add EmptyDrops / knee-point; accept the *raw* matrix. |
| Ambient-RNA removal | ❌ | Add SoupX / CellBender / DecontX. |
| Doublet detection | ❌ | Add scDblFinder / Scrublet. |
| QC metrics | ✅ (mito, ribo, nCount, nFeature) | Add %hemoglobin, complexity, MALAT1; per-cell flags. |
| QC filtering | ✅ manual min/max, per-sample | Offer adaptive MAD / miQC option alongside manual. |
| Normalization | ⚠️ only `log2(x+1)` | Add library-size log1p, SCTransform, scran, Pearson residuals. |
| HVG / scale / PCA | ❌ (in analysis stage) | Bring HVG selection into processing if the design wants it. |
| Integration | ⚠️ Harmony, but in analysis stage | Expose Harmony/scVI/CCA/RPCA as a processing option. |
| Spatial | ❌ (none) | Entire spatial path (docs 02/06) is greenfield. |
| CITE / ATAC / multiome | ⚠️ assay-split only | Protein CLR/DSB, ATAC TF-IDF, multiome WNN unimplemented. |

**Bottom line for the implementer:** the legacy scripts are a clean, WASM-capable,
Seurat-5 **import + measure + threshold-filter + log-transform** core with a job-
queue harness and a custom HDF5 store. Everything a modern "raw → analysis-ready"
pipeline additionally expects — empty-droplet, ambient, doublets, principled
normalization, and spatial — is *absent* and is exactly what docs `04`–`06`
enumerate.
