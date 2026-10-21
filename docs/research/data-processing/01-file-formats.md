# File Formats in the Single-Cell + Spatial Transcriptomics Data Lifecycle

> **Scope.** This document is the exhaustive **structural** reference for *every file format* a
> single-cell (scRNA-seq/multiome/CITE) or spatial-transcriptomics dataset passes through, from raw
> sequencer output to analysis-ready objects and spatial platform bundles. For each format it
> describes: **what it is**, **what is physically inside it**, **how it is laid out** (groups /
> datasets / columns / attributes), **which tools read & write it**, **versions/variants**, and
> **gotchas**.
>
> **Cross-doc boundary.** *Platforms* (assay chemistries, instruments, what each vendor's pipeline
> does) live in `02-platforms.md`. *Spatial processing* (segmentation, binning, registration
> algorithms) lives in `06-spatial-processing.md`. **This doc owns the on-disk format structure** and
> points to those docs for the rest.
>
> **Two container technologies dominate the ecosystem** — get these straight first, because ~80% of
> the formats below are *skins over one of them*:
>
> | Container | What it is | Formats built on it |
> |---|---|---|
> | **HDF5** (`.h5`) | Hierarchical binary container: a filesystem-in-a-file of *groups* (dirs) and *datasets* (n-d arrays), each carrying arbitrary *attributes*. One file, random-access, chunked + compressed. | 10x `.h5`, `molecule_info.h5`, `.h5ad`, `.h5mu`, `.loom`, Stereo-seq `.gef`, HDF5-backed SCE, cell-boundary HDF5 |
> | **Zarr** (`.zarr`) | Same conceptual model as HDF5 (groups/arrays/attrs) but **each chunk is a separate object** on a filesystem or object store → cloud-native, parallel, partial reads without a server. Metadata in `.zattrs`/`.zgroup`/`.zarray` (v2) or `zarr.json` (v3). | AnnData `.zarr`, OME-Zarr (OME-NGFF), SpatialData `.zarr`, Xenium `.zarr.zip`, TileDB-SOMA (conceptually) |
>
> A third pillar is **Apache Parquet** (columnar, compressed tabular) — now the default for large
> spatial coordinate/transcript tables (Xenium, Visium HD positions, SpatialData points/shapes).

---

## 1. FASTQ — raw sequencing reads (the upstream root)

### What it is
Plain-text (usually gzip'd, `.fastq.gz`) sequence format: the direct output of an Illumina/Element/etc.
sequencer after demultiplexing. Every read is **4 lines**:

```
@INSTRUMENT:RUN:FLOWCELL:LANE:TILE:X:Y READnum:filter:control:index   ← header (@)
GATCACAGGT…                                                            ← base calls
+                                                                      ← separator
FFFFF:F,FF…                                                            ← Phred quality (ASCII-33)
```

Single-cell libraries are **multi-file**: the barcode/UMI live in one read, the cDNA in another.

### The R1/R2/I1/I2 roles
| File | Role in 10x scRNA-seq |
|---|---|
| **R1** | The **cell barcode + UMI** (technical read). NOT cDNA. |
| **R2** | The **cDNA insert** (the actual transcript sequence that gets aligned). |
| **I1** | **i7 sample index** (which sample/library in a pooled flowcell). |
| **I2** | **i5 sample index** (dual-indexing; present for dual-index kits). |

File-naming (bcl2fastq/`cellranger mkfastq` convention):
`[Sample]_S1_L001_R1_001.fastq.gz` (`S#`=sample number, `L00#`=lane, `R1/R2/I1/I2`, `001`=chunk).

### 10x read structure per chemistry (where the barcode + UMI sit inside R1)
The cell barcode (CB) and UMI are **positional substrings of R1**:

| Chemistry | R1 layout | CB len | UMI len | cDNA |
|---|---|---|---|---|
| 3′ **v1** (legacy) | CB in R1, UMI in a separate read | 14 bp | 10 bp | R2 |
| 3′ **v2** | `[16 bp CB][10 bp UMI]` | 16 | 10 | R2 |
| 3′ **v3 / v3.1** | `[16 bp CB][12 bp UMI]` | 16 | 12 | R2 |
| 5′ **v1/v2** | `[16 bp CB][10 bp UMI]` then TSO; cDNA on R2 | 16 | 10 | R2 (5′ end) |
| Multiome ATAC | `[16 bp CB]` (ATAC barcode) in a dedicated read | 16 | — | R1/R3 genomic |
| Visium v1 spatial | `[16 bp spatial barcode][12 bp UMI]` | 16 | 12 | R2 |

Key facts a pipeline must respect ([10x 3′ v3](https://scg-lib-structs.readthedocs.io/en/latest/ge/10xChromium3v3.html)):
- **R1 length ≥ 28 bp** (16+12) for 3′ v3; if R1 is shorter, the UMI is truncated and Cell Ranger errors.
- The CB is matched against a **fixed whitelist** (`3M-february-2018.txt.gz` for 3′ v3, ~6.8 M barcodes;
  `737K-august-2016.txt` for v2). This whitelist is how "raw" barcodes get error-corrected to `CB`.
- The dual-index i5/i7 are **10 bp** each; single-index (older) kits use one 8 bp i7.
- **Gotcha:** feeding R1 and R2 swapped is a classic error — the pipeline "runs" but produces near-zero
  valid barcodes. STARsolo/Cell Ranger/Alevin/kallisto all take an explicit CB/UMI geometry argument.

### Tools
Produced by `bcl2fastq`/`bcl-convert`/`cellranger mkfastq`. Consumed by every aligner/pseudoaligner:
**Cell Ranger, STARsolo, salmon alevin/alevin-fry, kallisto|bustools, Space Ranger, Xenium Ranger**.
`cellranger bamtofastq` regenerates FASTQs *from* a Cell Ranger BAM (see §2).

---

## 2. BAM — aligned reads with barcode tags (`possorted_genome_bam.bam`)

### What it is
**BAM** = the binary, BGZF-compressed, indexed form of **SAM** (Sequence Alignment/Map). Cell Ranger's
`count` emits `outs/possorted_genome_bam.bam` (+ `.bai` index): position-sorted reads aligned to the
genome/transcriptome, **plus unmapped reads**, with the Chromium barcode/UMI stamped into custom tags so
the whole cell×gene matrix can be reconstructed from the BAM alone
([10x BAM tags](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-bam)).

### The 10x barcode/molecule tags (the important part)
| Tag | Type | Meaning |
|---|---|---|
| `CB` | Z | **Error-corrected** cell barcode, whitelist-confirmed, with GEM-group suffix (`…-1`). Absent if not correctable. |
| `CR` | Z | Raw cell barcode as sequenced. |
| `CY` | Z | Phred quality of the cell barcode. |
| `UB` | Z | **Error-corrected** UMI. |
| `UR` | Z | Raw UMI. |
| `UY` | Z | UMI quality. |
| `TR` | Z | Trailing sequence after the barcode+UMI. |
| `GX` | Z | Compatible **gene ID(s)** (semicolon-joined if multiple). |
| `GN` | Z | Compatible **gene name(s)**. |
| `TX` | Z | Compatible **transcript** alignments (strand+pos+CIGAR). |
| `AN` | Z | Antisense transcript alignments. |
| `RE` | A | **Region**: `E`=exonic, `N`=intronic, `I`=intergenic. |
| `xf` | i | **Extra flags** bitfield (below). |
| `mm` | i | 1 if MAPQ was adjusted (read overlaps a single gene). |
| `pa` | i | # poly-A nt trimmed from 3′ end. |
| `ts` | i | # template-switch-oligo nt trimmed from 5′ end. |
| `RG` | Z | Read group (library/GEM identity). |
| `fb`/`fr`/`fq`/`fx` | Z | Feature-Barcode (CITE/CRISPR): corrected / raw / quality / matched feature id. |
| `pr` | Z | Probe IDs (Flex/targeted only). |

**`xf` extra-flags bit values** (bitwise OR):
`1`=confidently mapped to transcriptome; `2`=read's barcode/UMI/feature discarded in favor of a
higher-support feature; `4`=discordant gene pairing; `8`=this is the **representative record for a UMI**
that is counted in the matrix; `16`=maps to exactly one feature; `32`=removed by targeted-UMI filtering.
**`xf & 8` (== a counted UMI) is the standard filter to enumerate counted molecules from the BAM.**

### Variants & gotchas
- **`--no-bam`**: newer Cell Ranger can skip BAM output entirely (saves TBs). Don't assume it exists.
- Space Ranger emits an analogous spatial BAM; Cell Ranger ATAC/ARC use different tag sets
  (`CB` present, no `UB`; fragment intervals instead).
- **`cellranger bamtofastq`** reverses BAM → original FASTQs (preserving `R1/R2/I1`), the sanctioned way
  to re-run a different pipeline on published data that only shipped a BAM.
- A BAM without `CB`/`UB` tags means the reads were never barcode-processed (e.g. a plain STAR BAM) — a
  frequent confusion on public data.

---

## 3. 10x MEX (Market Exchange / Matrix Market) feature-barcode matrix

### What it is
A **3-file directory** encoding the sparse cell×gene count matrix as text
([10x MEX](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-mex-matrices)).
The canonical "counts folder" everyone loads with `scanpy.read_10x_mtx` / `Seurat::Read10X`.

```
filtered_feature_bc_matrix/          (or raw_feature_bc_matrix/)
├── matrix.mtx.gz        ← the sparse matrix (MatrixMarket coordinate format)
├── barcodes.tsv.gz      ← one cell barcode per line  (columns of the matrix)
└── features.tsv.gz      ← one feature per line        (rows of the matrix)
```

### `matrix.mtx` layout (MatrixMarket)
```
%%MatrixMarket matrix coordinate integer general
%metadata_json: {"software_version":"cellranger-7.x", "format_version":2}
36601 8000 12876947          ← (# rows=features)  (# cols=barcodes)  (# nonzeros)
1 1 4                        ← row col value  (1-BASED indices; value = UMI count)
1 5 1
…
```
- **Orientation: features are ROWS, cells/barcodes are COLUMNS** (gene×cell). This is the *transpose* of
  the AnnData/Scanpy convention (cells×genes), so loaders transpose on read.
- Indices are **1-based**; values are integer UMI counts.

### v2 vs v3 (the single most common footgun)
| | Cell Ranger **v2** | Cell Ranger **v3+** |
|---|---|---|
| Features file | `genes.tsv` | `features.tsv.gz` |
| Columns | 2: `gene_id`, `gene_name` | 3: `feature_id`, `feature_name`, **`feature_type`** |
| Compression | uncompressed `.tsv`/`.mtx` | `.gz` |
| `feature_type` values | (none) | `Gene Expression`, `Antibody Capture`, `CRISPR Guide Capture`, `Multiplexing Capture`, `CUSTOM`, `Peaks` |

`features.tsv.gz` example:
```
ENSG00000141510	TP53	Gene Expression
ENSG00000012048	BRCA1	Gene Expression
CD3_GCCTGACTAGATCCA	CD3	Antibody Capture
```
`barcodes.tsv.gz` example: `AAACCCAAGGAGAGTA-1` (the `-1` suffix = GEM group / aggregation index).

### filtered vs raw
- **`filtered_feature_bc_matrix/`** — only barcodes called as **real cells** (cell-calling / EmptyDrops).
- **`raw_feature_bc_matrix/`** — **every** barcode with ≥1 read (millions of mostly-empty droplets). This
  is what ambient-RNA tools (**CellBender, SoupX, DecontX**) and custom cell-callers need.

### Tools
`Read10X`(Seurat), `read_10x_mtx`(Scanpy), `DropletUtils::read10xCounts`, `scipy.io.mmread`. A **standalone
`.mtx`** (no barcodes/features sidecars) is a plain MatrixMarket sparse matrix, common for GEO deposits.

---

## 4. 10x HDF5 `.h5` feature-barcode matrix

### What it is
The **binary equivalent of MEX** — the same matrix in one HDF5 file, faster and smaller. Emitted as
`filtered_feature_bc_matrix.h5` and `raw_feature_bc_matrix.h5`
([10x HDF5 format](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-h5-matrices)).

### v3 layout (Cell Ranger 3+): everything under `/matrix`
```
(root)
└── matrix                       [HDF5 group]
    ├── barcodes    string[N]    "AAACGGGCAGCTCGAC-1"
    ├── data        uint32[nnz]  nonzero UMI counts, column-major
    ├── indices     uint32[nnz]  zero-based ROW index of each data element
    ├── indptr      uint32[Ncol+1]  start offset of each COLUMN in data/indices
    ├── shape       uint64[2]    (#rows=features, #cols=barcodes)
    └── features                 [HDF5 group]
        ├── _all_tag_keys  string[]   which of the below are "tag" columns
        ├── feature_type   string[M]  Gene Expression / Antibody Capture / …
        ├── genome         string[M]  GRCh38 / mm10 (multi-genome refs supported)
        ├── id             string[M]  Ensembl feature id
        ├── name           string[M]  human-readable name
        ├── pattern        string[]   (Feature Barcode assays only)
        ├── read           string[]   (Feature Barcode only) R1/R2
        ├── sequence       string[]   (Feature Barcode only)
        └── target_sets/[panel]       (Flex/targeted only)
```

**Storage = Compressed Sparse Column (CSC)**: the matrix is column-major, so **each barcode (cell) is a
contiguous run** in `data`/`indices` — efficient for per-cell slicing. To read column *j*: elements
`data[indptr[j] : indptr[j+1]]` at rows `indices[indptr[j] : indptr[j+1]]`.

### v2 vs v3 differences
- **v2** (Cell Ranger 2): datasets sit **at the root**, one group *per genome* (`/GRCh38/data`, `/GRCh38/genes`,
  `/GRCh38/gene_names`, `/GRCh38/barcodes`, `/GRCh38/indices`, `/GRCh38/indptr`, `/GRCh38/shape`). No
  `feature_type`, genes not features.
- **v3**: single `/matrix` group with a `features` subgroup carrying `feature_type` (enabling multimodal
  CITE/CRISPR in one file). Genome is now a per-feature column, not a top-level group.
- **Gotcha:** `scanpy.read_10x_h5` auto-detects; `Read10X_h5` too. But hand-written HDF5 readers must
  branch on presence of `/matrix`.

### Tools
`read_10x_h5`(Scanpy), `Read10X_h5`(Seurat), `DropletUtils::read10xCounts` (also reads `.h5`),
`TENxMatrix`(HDF5Array, lazy/on-disk). Space Ranger + Xenium emit the identical structure
(`cell_feature_matrix.h5`).

---

## 5. `molecule_info.h5` — per-molecule (UMI) record

### What it is
The **most granular** Cell Ranger output: **one row per observed molecule** — a unique
`(cell-barcode, UMI, feature)` tuple with its read count. It is the substrate for **`cellranger aggr`**
(cross-library normalization/subsampling), **saturation/downsampling** analysis, and ambient-RNA models
like **CellBender**
([molecule_info](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-molecule-info)).

### Layout
```
(root)
├── barcode_idx    uint64[]   zero-based index into /barcodes for this molecule
├── barcodes       string[]   the barcode dictionary (AAACCCAAGGAGAGTA-1)
├── count          uint32[]   reads confidently supporting this UMI
├── feature_idx    uint32[]   zero-based index into /features
├── gem_group      uint16[]   which GEM well (multiplex/aggr)
├── library_idx    uint16[]   index into library_info (GEX vs Antibody vs CRISPR…)
├── umi            uint32[]   2-bit-packed UMI sequence
├── umi_type       uint32[]   1=exonic, 0=intronic
├── probe_idx      int32[]    (Flex, CR v7.1+)
├── library_info   string     JSON array describing each library
├── metrics_json   string     pipeline metrics blob
├── barcode_info               [group]
│   ├── genomes                genome names
│   └── pass_filter  uint64[k,3]  (barcode_idx, library_idx, genome_idx) rows that passed cell-calling
├── features                   [group]  id/name/feature_type/genome/… (same as §4)
└── probes                     [group, Flex v7.1+]  feature_id/feature_name/probe_id/region
```

### Gotchas
- It is **columnar, not a matrix**: parallel arrays `barcode_idx`/`feature_idx`/`count`/`umi` are aligned
  row-wise (row *i* of each = molecule *i*). You reconstruct the matrix by aggregating.
- The `count`>1 field is *reads per UMI* — enables read-depth downsampling (`aggr` subsamples to equalize
  sequencing depth across libraries by dropping reads and re-collapsing UMIs).
- The `pass_filter` matrix under `barcode_info` is how you recover which barcodes were called cells.

---

## 6. AnnData `.h5ad` — the Python single-cell standard

### What it is
The **scverse/Scanpy** in-memory & on-disk object: an annotated data matrix. On disk it is an **HDF5
file** (`.h5ad`) whose structure is a **formal, versioned spec** — every element self-describes its type
via `encoding-type`/`encoding-version` attributes
([AnnData on-disk spec](https://anndata.readthedocs.io/en/stable/fileformat-prose.html)).

### The AnnData object (cells × genes; `n_obs` × `n_var`)
```
root  (attrs: encoding-type="anndata", encoding-version="0.1.0")
├── X          main matrix, shape (n_obs, n_var)            [dense array OR sparse group]
├── layers/    alternative matrices, each (n_obs, n_var)    e.g. "counts","spliced","unspliced"
├── obs        cell metadata                                [dataframe group]
├── var        gene metadata                                [dataframe group]
├── obsm/      per-cell multi-dim (embeddings): X_pca, X_umap, spatial …
├── varm/      per-gene multi-dim: PCs …
├── obsp/      cell×cell graphs: distances, connectivities  [sparse]
├── varp/      gene×gene matrices
├── uns/       unstructured dict: params, colors, neighbors, dendrograms …
└── raw/       optional frozen snapshot: raw/X, raw/var, raw/varm
```

### The encoding system (this is the spec's core idea)
Every group/dataset carries two string attributes so a reader knows how to decode it **without external
schema**:

| `encoding-type` | version | On-disk representation |
|---|---|---|
| `anndata` | 0.1.0 | the top-level group |
| `array` | 0.2.0 | a dense HDF5 dataset |
| `csr_matrix` / `csc_matrix` | 0.1.0 | a **group** with `data`, `indices`, `indptr` datasets + **`shape` attribute** `[rows, cols]` |
| `dataframe` | 0.2.0 | a group; attrs `_index`=name of index column, `column-order`=[cols]; each column a sub-array |
| `categorical` | 0.2.0 | a group with `codes` (int, `-1`=missing) + `categories` (labels) + `ordered` bool attr |
| `string-array` | 0.2.0 | variable-length UTF-8 (HDF5) / `VLenUTF8` codec (Zarr) |
| `dict` | 0.1.0 | a generic mapping group (used throughout `uns`) |
| `numeric-scalar` / `string` | 0.2.0 | 0-d arrays (scalars, only in `uns`) |
| `nullable-integer` / `nullable-boolean` | 0.1.0 | a group with `values` + `mask` (boolean) arrays |
| `nullable-string-array` | 0.1.0 | `values`+`mask`, optional `na-value` attr |
| `awkward-array` | 0.1.0 | ragged arrays via `ak.to_buffers()`: `node*-data/offsets/mask` + `form` JSON + `length` attrs (experimental) |

**Sparse matrices** (the usual `X`): a group, e.g.
```
X/ (attrs: encoding-type="csr_matrix", encoding-version="0.1.0", shape=[164114, 36601])
├── data     float32[nnz]
├── indices  int32[nnz]
└── indptr   int32[n_obs+1]
```
Note the **`shape` is an attribute**, not a dataset (differs from the 10x `.h5` which has a `shape` *dataset*).
CSR = row-major (cell-major, since cells are rows) → fast per-cell slicing; CSC = column/gene-major.

**Categoricals** are how `obs['cell_type']` etc. are stored compactly:
`obs/cell_type/{codes:int8[], categories:string[]}` with `-1` code = missing.

### Versions & gotchas
- **AnnData ≥0.8** writes the modern spec above (obs/var as `dataframe` groups). **Legacy** (<0.7) wrote
  obs/var as HDF5 **compound dtypes** — old files may still be around; readers handle both.
- **Missing-value semantics** for nullable strings: `na-value` attr chooses `"NA"` (NA-propagating) vs
  `"NaN"` (comparisons return bool). Default `NA`.
- **`.h5ad` is not appendable** in place for arbitrary edits, but AnnData supports **backed mode**
  (`read_h5ad(..., backed='r')`) for lazy row access to `X`.
- **Round-trip pitfalls to R:** `obs` categoricals, `uns` nesting, and `raw` don't always survive
  h5ad↔Seurat conversion (see SeuratDisk §8) — dtypes silently coerce.

---

## 7. AnnData Zarr (`.zarr`)

Same schema as `.h5ad`, but the store is a **Zarr hierarchy** instead of HDF5. Groups → directories,
arrays → chunked directories, attributes → `.zattrs` (Zarr v2) or `zarr.json` (Zarr v3). The
**identical `encoding-type`/`encoding-version` attributes** apply, so the logical layout (`X`, `obs`,
`var`, `obsm`, …, sparse `data/indices/indptr`, categorical `codes/categories`) is byte-for-byte
conceptually equal — only the physical container differs.

**Why it exists:** each chunk is an independent object → **cloud-native** (read a slice from S3/GCS
without downloading the whole file), **parallel writes**, and it is the storage substrate for
**SpatialData** and **MuData/Zarr**. Written via `adata.write_zarr()`.
**Gotcha:** chunk shape matters enormously for access-pattern performance; a badly chunked sparse `X`
(e.g. one giant chunk) defeats the point. Zarr v2 vs v3 metadata formats are not interchangeable —
match the reader.

---

## 8. Loom `.loom` — HDF5 annotated matrix (genes × cells)

### What it is
An HDF5 spec from the Linnarsson lab / GA4GH; the historical output of **velocyto** (RNA velocity) and
**loompy**/**LoomExperiment**
([Loom format](https://linnarssonlab.org/loompy/format/index.html)). "Treats rows and columns the same".

### Layout (spec v3.0.0)
```
/matrix            main dataset, N rows × M cols   (rows=GENES, cols=CELLS — note orientation!)
/layers/           additional N×M matrices
    /spliced       ← velocyto
    /unspliced     ← velocyto
    /ambiguous     ← velocyto
/row_attrs/        arrays of length N (per-gene): Gene, Accession, …
/col_attrs/        arrays of length M (per-cell): CellID, Clusters, _X, _Y …
/row_graphs/, /col_graphs/  sparse graphs, each with datasets a[E] (int32 src), b[E] (int32 dst), w[E] (float32 weight)
/attrs/            global attributes group
    /LOOM_SPEC_VERSION = "3.0.0"
```

### Versions & gotchas
- **Orientation is genes×cells** (like MEX, opposite AnnData) — Scanpy's `read_loom` transposes and asks
  which attrs are the obs/var index (`obs_names`, `var_names`).
- **Spec 3.0.0 breaking change**: global attributes moved from HDF5 root attributes into the `/attrs`
  **group as datasets**, and strings became variable-length UTF-8. Pre-3.0 files store globals as
  root-level attrs — readers must handle both.
- The **velocyto** spliced/unspliced/ambiguous layers are the reason Loom persists in RNA-velocity
  workflows (scVelo reads them). `loompy` (Python) and `LoomExperiment` (Bioconductor) are independent
  implementations of the same on-disk spec.

---

## 9. Seurat `.rds` / `.h5Seurat` — the R single-cell object

### What it is
Seurat objects are **native R S4 objects** serialized with `saveRDS()` → `.rds` (gzipped R serialization).
An `.rds` is opaque outside R (it's the R serialization stream, not a documented cross-language format).

### Seurat v5 object anatomy
```
Seurat object
├── assays$RNA         (class Assay5 in v5; Assay in v3/4)
│   └── layers:  counts, data, scale.data   (v5 "layers" replace v3 "slots";
│                may be split by batch: counts.batch1, counts.batch2 …)
│   └── features / cells, var.features, meta.data (per-feature)
├── reductions$pca / umap / tsne / harmony   (DimReduc: cell.embeddings, feature.loadings, stdev)
├── graphs$RNA_nn / RNA_snn                   (Graph: sparse neighbor graphs)
├── neighbors                                 (Neighbor objects)
├── meta.data          per-CELL data.frame (nCount_RNA, nFeature_RNA, clusters, …)
├── images$…           (spatial: SlideSeq / VisiumV1 / FOV for Xenium/MERFISH — coords + scalefactors + image)
├── reductions, misc, commands, tools
└── active.assay / active.ident / project.name / version
```

### v5 specifics — layers & BPCells
- **v5 replaced "slots" with "layers"**: an `Assay5` can hold *only* a `data` layer (no counts), or many
  count layers split by sample — the basis of v5's layered integration
  ([Seurat v5](https://satijalab.org/seurat/articles/seurat5_essential_commands)).
- **BPCells on-disk matrices**: v5 can back a layer with a **BPCells** matrix — the counts live in an
  on-disk bit-packed directory (not in the `.rds`); the `.rds` stores a *pointer* to that directory.
  **Gotcha:** moving/copying the `.rds` without the BPCells directory breaks it (paths are baked in);
  you must `write_matrix_dir()` alongside.

### `.h5Seurat` (SeuratDisk)
**SeuratDisk** defines `.h5Seurat`, an HDF5 layout mirroring the Seurat object, and provides
`Convert()` between `.h5Seurat` ↔ `.h5ad`. It is the main **Seurat↔AnnData bridge** (alongside
`sceasy`, `zellkonverter`, `anndata` R pkg, `schard`). **Gotcha:** conversions lose/mangle nested
`uns`, some `obsm`, and factor levels; always spot-check `obs`/`meta.data` and embeddings after a
round-trip.

---

## 10. SingleCellExperiment (SCE) & the Bioconductor family

### What it is
The **Bioconductor** in-memory class for single-cell data, extending `SummarizedExperiment`
([SCE intro](https://bioconductor.org/books/3.13/OSCA.intro/the-singlecellexperiment-class.html)).
Serialized as `.rds` like any R object, **or** HDF5-backed (below).

### SCE structure
```
SingleCellExperiment  (rows = features/genes, cols = cells)
├── assays          named list of matrices: counts, logcounts, …  (dense/dgCMatrix/DelayedArray)
├── rowData          DataFrame of per-gene metadata (+ rowRanges: GRanges of gene coords)
├── colData          DataFrame of per-cell metadata (barcodes, clusters, QC)
├── reducedDims      named list of cell embeddings: PCA, TSNE, UMAP  (rows=cells)
├── altExps          alternative Experiments: **CITE-seq ADTs, spike-ins (ERCC)** as nested SCEs
├── sizeFactors      per-cell normalization factors
└── metadata         arbitrary list
```
Inherited from `SummarizedExperiment`: `assays`, `colData`, `rowData/rowRanges`, `metadata`.
**Note orientation: features×cells** (opposite AnnData). `altExps` is the elegant bit — CITE antibody
counts or ERCC spike-ins live as *separate experiments sharing the same cells*.

### HDF5-backed on disk (`HDF5Array` / `DelayedArray`)
For datasets too big for RAM, `HDF5Array::saveHDF5SummarizedExperiment(sce, dir=…)` writes a **directory**
([HDF5Array](https://rdrr.io/bioc/HDF5Array/man/saveHDF5SummarizedExperiment.html)):
```
myDir/
├── assays.h5     ← one HDF5 dataset per assay (dense) or TENxMatrix (sparse)
└── se.rds        ← the serialized SCE whose assays are HDF5Array *pointers* into assays.h5
```
- `loadHDF5SummarizedExperiment(dir)` returns an SCE whose assays are lazy **`HDF5Array`/`DelayedArray`**
  objects — light in memory, computed on demand.
- **`TENxMatrix`** is the HDF5Array class that reads a **10x `.h5`'s CSC layout directly** as a
  DelayedArray (no densification).
- **Gotcha:** `assays.h5` + `se.rds` must travel together; the `.rds` hard-references the `.h5` path.

### SpatialExperiment (SPE) & SpatialFeatureExperiment (SFE)
- **`SpatialExperiment`** extends SCE with `spatialCoords` (numeric matrix of x/y per spot/cell) and
  `imgData` (a DataFrame of tissue images + scale factors). Native target for **Visium/Xenium/MERFISH**
  Bioconductor import ([SPE](https://bioconductor.posit.co/packages/devel/bioc/vignettes/SpatialExperiment/inst/doc/SpatialExperiment.html)).
- **`SpatialFeatureExperiment`** extends SPE with **Simple Features (sf)** geometry — cell/nucleus
  polygons, tissue boundaries — for true geospatial ops. Supports Visium, Xenium, MERFISH, seqFISH,
  Slide-seq.

---

## 11. MuData `.h5mu` — multimodal (CITE-seq, multiome)

### What it is
The scverse **multimodal** container: a MuData holds several AnnData modalities (e.g. `rna` + `prot`, or
`rna` + `atac`) that share observations. On disk = an **HDF5 `.h5mu`** (or Zarr) whose modalities are each
a full AnnData group ([MuData](https://mudata.readthedocs.io/en/latest/io/spec.html)).

### Layout
```
root  (attrs: encoding-type="mudata", encoding-version, mod-order=[…])
├── mod/                       [group] — one full AnnData per modality
│   ├── rna/   (a complete .h5ad structure: X, obs, var, obsm, …)
│   ├── prot/  (…)
│   └── atac/  (…)
├── obs        GLOBAL cell metadata (collated across modalities)
├── var        GLOBAL feature metadata
├── obsm/, varm/
├── obsmap/    integer maps: obsmap["rna"][i] = 1-based row of global obs i within rna (0 = absent)
├── varmap/    integer maps for variables
└── uns/
```
- Modalities live under `/mod/<name>`, each stored **exactly like a standalone `.h5ad`**. The
  **`mod-order`** attribute preserves ordering.
- Global `obs`/`var` are **collated** from the per-modality indices; **`obsmap`/`varmap`** are integer
  maps that record which global observation/variable is present in which modality (nonzero = present,
  value = position). This handles the "different modalities measure overlapping-but-not-identical cell
  sets" problem.
- **Tools:** `muon` (Python), `MuData`/`MuDataSeurat` (R). **Zarr** variant is the same schema over a Zarr
  store. **Gotcha:** editing a modality's `obs_names` without updating the global maps corrupts the
  collation; use the library API, not raw HDF5 pokes.

---

## 12. TileDB-SOMA (CELLxGENE Census)

### What it is
**SOMA** ("Stack Of Matrices, Annotated") is an open **data model** (not a single file) for single-cell
data at *any* scale, implemented on **TileDB's cloud-native multi-dimensional arrays**. It backs the
**CZ CELLxGENE Census** (~50 M+ cells, 700+ datasets, queryable without download)
([TileDB-SOMA](https://github.com/single-cell-data/TileDB-SOMA)).

### The SOMA data model
```
SOMAExperiment                       (a SOMACollection)
├── obs        SOMADataFrame         cell-level annotations (a TileDB array)
└── ms/        SOMACollection of measurements (modalities)
    └── RNA    SOMAMeasurement
        ├── var    SOMADataFrame     gene/feature annotations
        ├── X/     SOMACollection of 2D matrices ("layers"): raw, normalized …  (SOMASparseNDArray)
        ├── obsm/  SOMACollection of 2D arrays (embeddings)
        ├── varm/  …
        ├── obsp/  cell×cell graphs
        └── varp/  gene×gene
```
Primitive SOMA objects: `SOMADataFrame`, `SOMASparseNDArray`, `SOMADenseNDArray`, `SOMACollection`,
`SOMAExperiment`, `SOMAMeasurement`. Physically each is one or more **TileDB arrays** (chunked,
versioned, S3/GCS-native, with fast filtered reads on obs/var).

### Gotchas
- It **maps cleanly to/from AnnData** (`tiledbsoma.io.from_anndata` / `to_anndata`), so SOMA is best
  thought of as "AnnData at petabyte scale with server-side filtering".
- Reads are **query-first**: you slice by `obs`/`var` value filters and get back an AnnData/Arrow table —
  you rarely materialize the whole thing.
- There is also a **spatial** SOMA extension (SpatialData-like scenes) in newer versions.

---

## 13. Generic tabular formats

- **Dense CSV/TSV expression matrix** — genes×cells (or cells×genes) with a header row of cell IDs and a
  first column of gene IDs. Ubiquitous on **GEO**. **Gotchas:** orientation is not standardized (check
  which axis is genes), huge for dense data (a 30k×100k matrix is >GBs uncompressed), and Excel silently
  corrupts gene symbols (`SEPT9`→`9-Sep`). Read with `pandas`/`data.table`.
- **Standalone `.mtx`** — a lone MatrixMarket file (see §3) without the barcodes/features sidecars;
  requires you to supply row/col names separately.
- **gzip conventions** — nearly everything text (`.tsv`, `.mtx`, `.csv`, FASTQ) ships `.gz`. 10x MEX v3 is
  always gzip'd; v2 was not. Loaders transparently handle both.
- **Parquet** — increasingly the default for large spatial tables (columnar, typed, compressed, partial
  column reads). Xenium, Visium HD positions, and SpatialData points/shapes all use it.

---

## 14. Space Ranger `outs/` — Visium spatial output structure

### What it is
Space Ranger (10x Visium/Visium HD/CytAssist) produces a superset of Cell Ranger outputs **plus a
`spatial/` folder** tying counts to tissue coordinates
([Space Ranger spatial outputs](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/spatial-outputs)).

```
outs/
├── filtered_feature_bc_matrix/         (§3 MEX) + filtered_feature_bc_matrix.h5 (§4)
├── raw_feature_bc_matrix/  + .h5
├── analysis/                            clustering, DR, DE (like Cell Ranger)
├── spatial/
│   ├── tissue_positions.csv            (or tissue_positions_list.csv in SR ≤1.x; .parquet for Visium HD)
│   ├── scalefactors_json.json
│   ├── tissue_hires_image.png          downsampled tissue image (~2000 px)
│   ├── tissue_lowres_image.png         downsampled (~600 px longest side)
│   ├── aligned_fiducials.jpg           QC: detected fiducial frame
│   ├── detected_tissue_image.jpg       QC: spot/tissue detection
│   ├── cytassist_image.tiff            (CytAssist) eosin brightfield with fiducials
│   └── aligned_tissue_image.jpg        (CytAssist v2 / HD) registration checkerboard
├── possorted_genome_bam.bam (+ .bai)
├── molecule_info.h5
├── metrics_summary.csv
└── web_summary.html
```

### `tissue_positions(_list).csv` columns
| Column | Meaning |
|---|---|
| `barcode` | spot barcode (`…-1`) — matches `barcodes.tsv.gz` |
| `in_tissue` | 1 if spot is under tissue, 0 otherwise |
| `array_row` / `array_col` | spot's logical position on the Visium hex grid |
| `pxl_row_in_fullres` / `pxl_col_in_fullres` | spot **pixel** coords in the *full-resolution* image |

**Gotcha:** SR ≤1.x wrote `tissue_positions_list.csv` **with no header**; SR ≥2.0 wrote
`tissue_positions.csv` **with a header**. Loaders (`squidpy.read.visium`, `Seurat::Load10X_Spatial`)
branch on filename.

### `scalefactors_json.json` fields
```json
{
  "spot_diameter_fullres": 89.4,        // spot Ø in full-res pixels
  "fiducial_diameter_fullres": 144.6,
  "tissue_hires_scalef": 0.150,         // fullres px → hires px  (multiply)
  "tissue_lowres_scalef": 0.045,        // fullres px → lowres px
  "regist_target_img_scalef": …,
  "microns_per_pixel": … , "bin_size_um": …   // (Visium HD)
}
```
To plot a spot on `tissue_hires_image.png`: `pxl_*_in_fullres * tissue_hires_scalef`.

> **`spot_diameter_fullres` is a RENDERED circle, and it VARIES BY SLIDE DESIGN.** The
> one-line description above ("spot Ø in full-res pixels") is the under-specification that
> caused two defects: #222 (it was divided by the 55 µm *capture* spot, making every micron
> result 15.4% low) and #257 (one value was applied to every slide, making CytAssist ~7% low
> and the 11 mm slide ~8% high). 10x states it outright — *"This field is intended for
> visualization purposes, and can vary for different slide designs, ranging from 60-70 µm"* —
> and the three designs measured across 24 real vendor bundles are **65 µm** (6.5 mm,
> `fiducial/spot` = 21/13), **70 µm** (CytAssist 6.5 mm and pre-1.1 Space Ranger direct
> placement, 3/2) and **60 µm** (CytAssist 11 mm, 7/4).
> `regist_target_img_scalef` is written only on CytAssist/HD runs and places the
> *registration target* (`aligned_tissue_image.jpg`), not `cytassist_image.tiff`.
> Full derivation, provenance and the vendor quotes:
> [`docs/design/visium-slide-design-scale.md`](../../design/visium-slide-design-scale.md).

### Visium HD `binned_outputs/`
Visium HD captures at a **2 µm** native grid; Space Ranger bins to **8 µm** and **16 µm** by default:
```
outs/binned_outputs/
├── square_002um/   filtered_feature_bc_matrix/ + .h5 + spatial/tissue_positions.parquet
├── square_008um/   …
└── square_016um/   …
```
Each `square_XXXum/` mirrors a full Visium `outs/`. Positions are **Parquet** (millions of squares).
8 µm bin = 16 native barcodes; 16 µm = 64. **Gotcha:** the 2 µm matrix is enormous and very sparse;
most analyses start at 8 µm or use custom nucleus-based binning.

---

## 15. Xenium output bundle (10x in-situ imaging)

### What it is
A directory bundle from the Xenium Analyzer / Xenium Onboard Analysis (XOA)
([Xenium outputs](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance)).

```
output-XETG…/
├── experiment.xenium              JSON manifest (required by Xenium Explorer)
├── gene_panel.json                input panel; protein_panel.json (XOA 4.0+)
├── cell_feature_matrix.h5         cell×gene matrix (10x .h5 CSC layout §4)
├── cell_feature_matrix/           same as MEX (barcodes/features/matrix.mtx.gz)
├── cell_feature_matrix.zarr.zip   zipped Zarr variant
├── cells.parquet  /  cells.csv.gz cell summary: cell_id, x_centroid, y_centroid,
│                                  transcript_counts, control_probe_counts,
│                                  total_counts, cell_area, nucleus_area
├── cells.zarr.zip                 THE segmentation masks + boundaries used for assignment
├── transcripts.parquet            EVERY decoded molecule (below)
├── transcripts.zarr.zip
├── cell_boundaries.parquet/.csv.gz   cell polygon vertices  (cell_id, vertex_x, vertex_y)
├── nucleus_boundaries.parquet/.csv.gz  nucleus polygon vertices
├── morphology.ome.tif             3D DAPI nuclei image (OME-TIFF, §18)
├── morphology_focus/              2D multi-focus projection; extra stains (multimodal)
├── analysis/  + analysis.zarr.zip clustering/UMAP/DE
├── analysis_summary.html, metrics_summary.csv
└── aux_outputs/                   FOV locations, per-cycle images, QC
```

### `transcripts.parquet` (the molecule table)
Columns: `transcript_id`, `cell_id` (which cell it was assigned to; `UNASSIGNED`/-1 if none),
`overlaps_nucleus`, `feature_name` (gene / control), `x_location`, `y_location`, `z_location`
(microns), `qv` (Phred-like **quality value**; the standard filter is **`qv ≥ 20`**), `fov_name`,
`nucleus_distance`, `codeword_index`. **Gotchas:** includes **negative-control probes/codewords** and
`Blank`/`Deprecated` features — filter them out; `cell_id` is an alphanumeric string in newer XOA
(not a plain int); z is a real axis (3D). Boundaries are **one row per polygon vertex**, not one row per
cell — group by `cell_id`.

---

## 16. Vizgen MERSCOPE (MERFISH)

### What it is
Output of the Vizgen MERSCOPE MERFISH platform. CSV-centric
([Vizgen detected transcripts](https://vizgen.github.io/vizgen-postprocessing/output_data_formats/detected_transcripts_format.html)).

```
region_0/
├── cell_by_gene.csv               cell×gene count matrix (row=cell id, cols=genes + Blank-* controls)
├── cell_metadata.csv              per-cell: fov, volume, center_x, center_y, min_x/max_x/min_y/max_y
├── detected_transcripts.csv       every decoded molecule (below)
├── cell_boundaries/  (HDF5 or .parquet)  cell polygon geometries per FOV
├── images/
│   ├── mosaic_DAPI_z*.tif, mosaic_PolyT_z*.tif   mosaic stain images
│   └── micron_to_mosaic_pixel_transform.csv      3×3 affine: micron → mosaic-pixel
└── manifest.json
```

### `detected_transcripts.csv` columns
| Column | Type | Meaning |
|---|---|---|
| (index) | int | transcript index within FOV |
| `barcode_id` | int | row index of the target's barcode in the codebook (0-based) |
| `global_x` / `global_y` | float | position in **global microns** |
| `global_z` | float | z-plane index |
| `x` / `y` | float | position in FOV **pixels** |
| `fov` | int | field-of-view index (0-based) |
| `gene` | string | human-readable gene name (from codebook) |
| `transcript_id` | int64 | unique gene identifier |

A post-segmentation step appends a **cell/EntityID** column (`-1` = not in any cell). **Gotchas:**
`Blank-*` codewords are negative controls — exclude for real analysis; the micron↔pixel transform is
required to overlay transcripts on the mosaic images. Vizgen post-processing can also emit AnnData.

---

## 17. NanoString CosMx (SMI)

### What it is
Output of the NanoString/Bruker CosMx Spatial Molecular Imager. Per-sample folder of 5 CSVs + images
([CosMx import](https://help.multiomics.illumina.com/partek/partek-flow/tutorials/nanostring-cosmx-tutorial/importing-cosmx-data.html)).

```
<Sample>/
├── <Sample>_exprMat_file.csv       cell×gene counts (fov, cell_ID, then one col per target + NegPrb*)
├── <Sample>_metadata_file.csv      per-cell metadata: fov, cell_ID, CenterX/Y_global_px,
│                                   CenterX/Y_local_px, Area, AspectRatio, Width, Height, cell type…
├── <Sample>_tx_file.csv            per-transcript: fov, cell_ID, x_global_px, y_global_px, z,
│                                   target/gene, CellComp (Nuclear/Cytoplasm/Membrane/None)
│                                   — omit for protein panels
├── <Sample>_fov_positions_file.csv FOV grid positions (fov, x_global_px, y_global_px)
├── <Sample>_polygons.csv           cell polygon vertices (fov, cellID, x_local_px, y_local_px)
└── CellComposite/ or CellOverlay/  one image per FOV
```

**Gotchas:** coordinates are in **pixels** (not microns) — apply the pixel size (~0.12 µm/px, panel-dependent)
to convert; `NegPrb*`/`Negative` and `SystemControl` features are controls; `cell_ID` is unique *within an
FOV*, so a global cell id = `(fov, cell_ID)`; the `exprMat` filename must begin with the sample name for
importers. Newer AtoMx exports may bundle these as `.parquet` or a flat-file zip.

---

## 18. Slide-seq / Slide-seqV2

### What it is
Bead-array spatial transcriptomics (Broad). Each **puck** is a monolayer of DNA-barcoded ~10 µm beads at
known (x,y); reads carry the bead barcode ([Slide-seq](https://singlecell.broadinstitute.org/single_cell/study/SCP815)).

- **Bead locations**: a CSV (`MappedLocationsForR.csv` / `BeadLocationsForR.csv` /
  `<puck>_barcode_matching.csv`) with columns `barcode, xcoord, ycoord` (microns).
- **DGE (digital gene expression)**: a genes×beads count matrix, as `MappedDGEForR.csv` or a
  `.mtx`/`.h5ad`. The bead `barcode` is the join key between locations and DGE.
- Some pipelines pack everything into a MATLAB `BijectiveMapping.mat`.

**Load pattern:** `Seurat::ReadSlideSeq` / build an AnnData where `barcode`→`obs_names` and
`(xcoord, ycoord)`→`obsm['spatial']`. **Gotchas:** beads are **not cells** (sub-cellular/multi-cell
resolution, sparse per-bead counts); barcode error-correction (Hamming ≤1 vs the puck whitelist) happens
upstream; no image per se — the "image" is the bead point cloud.

---

## 19. Stereo-seq — GEF (`.gef`) & GEM (`.gem`)

### What it is
BGI/STOmics Stereo-seq (DNB nanoball array, sub-µm capture). SAW pipeline emits **GEM** (text) and
**GEF** (HDF5) ([STOmics SAW](https://en.stomics.tech/news/stomics-blog/1108.html)).

### GEM — text
Header (`#`-prefixed metadata: `#FileFormat`, `#StereoChip`, `#OffsetX/Y`, `#BinSize`), then columns:
```
geneID    x    y    MIDCount    [ExonCount]
```
`x,y` = capture-spot coordinates (units of DNB pitch, ~500 nm); `MIDCount` = UMI count at that (gene,x,y);
`ExonCount` (SAW ≥5.1.3) = exonic-only count. It is a **long/tidy molecule-count table**, not a matrix.

### GEF — HDF5
Faster binary form. Two variants:
```
Square-bin GEF   (.raw.gef / .gef / .tissue.gef)
├── geneExp/
│   ├── bin1/    {gene[], expression[(x,y,count)]}     ← native resolution
│   ├── bin10/, bin20/, bin50/, bin100/, bin200/ …     ← pre-binned pyramids
├── wholeExp/    per-bin summary matrices
└── stat/        statistics

Cell-bin GEF     (.cellbin.gef)
├── cell/        cell polygons + centroids + area
├── cellExp/     per-cell expression
├── gene/        gene dictionary
└── blockIndex/  spatial block index for fast region queries
```

**Gotchas:** GEF **bins** are the equivalent of Visium HD squares — pick a bin size for your resolution;
`bin1` is astronomically large/sparse (whole-chip can be cm² of 500 nm spots). Read with **Stereopy**
(`st.io.read_gef`, → AnnData-like `StereoExpData`) or convert GEF→`.h5ad`. Coordinates are chip-relative;
combine with `#OffsetX/Y` for global.

---

## 20. NanoString GeoMx DSP — DCC / PKC / config

### What it is
GeoMx Digital Spatial Profiler is **region-of-interest (ROI/AOI)-based**, not single-cell — you get counts
per *selected region*, not per cell ([GeomxTools](https://github.com/Nanostring-Biostats/GeomxTools)).

| File | What it is |
|---|---|
| **`.DCC`** (one per AOI) | Data Collection Count file: probe counts + sequencing stats for that AOI. Tag-value text. |
| **`.PKC`** (Probe Kit Config) | JSON-ish config mapping probes→targets/genes for a given assay panel/lot (`.MKC` for protein). Must match the assay lot used. |
| **annotation / `LabWorksheet.txt`** | sample↔AOI metadata (segment, ROI, tissue, patient). |
| **`.dsp`** | GeoMx DSP Control Center project/workspace file. |

Loaded via `GeomxTools::readNanoStringGeoMxSet(dccFiles, pkcFiles, phenoDataFile)` → a
`NanoStringGeoMxSet` (an `ExpressionSet`/`SummarizedExperiment`-like object: AOIs as columns, probes/targets
as rows). **Gotchas:** the number of "observations" is tens–hundreds of AOIs (not thousands of cells);
PKCs must correspond to the DCC lot or probes won't map; multi-analyte scans need all relevant PKCs.

---

## 21. SpatialData `.zarr` — the scverse unified spatial format

### What it is
The scverse framework unifying **all** the above spatial platforms (Visium, Visium HD, Xenium, MERSCOPE,
CosMx, Stereo-seq…) into one **Zarr** store built on **OME-NGFF + AnnData + Parquet**
([SpatialData design](https://github.com/scverse/spatialdata/blob/main/docs/design_doc.md)).

### Five SpatialElement types & their on-disk form
| Element | In-memory | On disk |
|---|---|---|
| **Images** | `xarray`/multiscale | **OME-NGFF** multiscale Zarr arrays; dims `cyx`(2D)/`czyx`(3D) |
| **Labels** | integer raster (segmentation masks) | OME-NGFF Zarr arrays; dims `yx`/`zyx` |
| **Points** | dask DataFrame (molecules) | **Parquet** (+ `.zattrs` transforms) |
| **Shapes** | GeoPandas (polygons/circles) | Parquet/Zarr with GeoPandas geometry |
| **Tables** | **AnnData** | AnnData-in-Zarr |

### Store layout
```
dataset.zarr/
├── images/<name>/    0/ 1/ 2/ … (multiscale)  .zattrs (coordinateTransformations)
├── labels/<name>/    0/ 1/ …    .zattrs
├── points/<name>/    points.parquet            .zattrs
├── shapes/<name>/    shapes.parquet            .zattrs
└── tables/<name>/    X/ obs/ var/ obsm/ uns/   .zattrs (region, region_key, instance_key)
```

### Coordinate systems (the reason SpatialData exists)
Every Images/Labels/Points/Shapes element carries **coordinate transformations** mapping its intrinsic
pixel/array space to one or more named **extrinsic coordinate systems** (e.g. `"global"`, `"microns"`).
Transform classes: **Identity, MapAxis, Translation, Scale, Affine, Rotation, Sequence**. **Tables cannot
have a coordinate system** — instead a Table *annotates* a Labels/Shapes element via three obs fields:
`region` (which element), `region_key` (obs column naming the element), `instance_key` (obs column giving
the per-region instance id). This is how the count matrix links to segmentation masks/polygons.
**Gotcha:** element **names** are constrained (alphanumeric + `-._`, no leading `__`, case-unique);
`_index` is reserved in tables. Points may migrate to **GeoParquet**.

---

## 22. OME-TIFF & OME-NGFF (OME-Zarr) — imaging substrate

### OME-TIFF
A TIFF whose ImageDescription holds **OME-XML** metadata (channels, physical pixel size, planes,
instrument). Multi-page/pyramidal. It is how spatial **morphology images** ship (Xenium
`morphology.ome.tif` = 3D DAPI stack; CosMx/MERSCOPE mosaics; CyCIF/CODEX multiplex). **Gotcha:** channel
order and physical calibration live in the OME-XML, not the pixel data — a reader that ignores it plots in
pixel units.

### OME-NGFF (OME-Zarr)
The **next-gen** cloud-native replacement: pixel data as a **multiscale Zarr pyramid** with a strict
metadata schema ([OME-Zarr spec 0.5](https://ngff.openmicroscopy.org/0.5/)).
```
image.zarr/
├── .zattrs / zarr.json      "multiscales": [{ axes, datasets, coordinateTransformations, type }]
├── 0/   full resolution     (dims per "axes": t,c,z,y,x)
├── 1/   ½ resolution
├── 2/   ¼ …
└── labels/<name>/ 0/ 1/ …   integer segmentation masks (image-labels metadata)
```
Key metadata: **`axes`** (length == array ndim; each has `name`+`type` of `space`/`channel`/`time`),
**`datasets`** (one per pyramid level, each with a `coordinateTransformations` **scale** mapping array→physical
coords), optional per-multiscale transforms + downscaling `type`. **Versions:** 0.4 (Zarr v2, `.zattrs`) is
still the most widely written; **0.5** moves to **Zarr v3** (`zarr.json`, `ome` metadata key). This is the
imaging foundation SpatialData's images/labels are built on. **Gotcha:** 0.4 vs 0.5 metadata layouts differ
(where `multiscales` lives) — check the version before parsing.

---

## 23. 10x `.cloupe` / `.loupe` — Loupe Browser (proprietary)

### What it is
The **proprietary binary** project file for 10x **Loupe Browser** (desktop viewer). Emitted by
Cell Ranger (`cloupe.cloupe`), Space Ranger, and Xenium (`.loupe`). Bundles the count matrix + precomputed
projections (t-SNE/UMAP), clusterings, and (spatial) tissue images for interactive point-and-click
exploration ([Loupe](https://www.10xgenomics.com/support/software/loupe-browser/latest)).

### Gotchas
- **Closed format, viewer-only.** There is no official reader → data-exchange path *out*. It is an
  endpoint, not an interchange format.
- **Into** it: **LoupeR** (`create_loupe_from_seurat`, `create_loupe`) converts a Seurat/generic object
  → `.cloupe`. Community tools (`cloupe-to-10x`) reverse-engineer it, unsupported.
- Don't treat `.cloupe` as a data source in a pipeline — always keep the `.h5`/MEX/`.h5ad` as the real
  artifact and generate `.cloupe` for humans.

---

## 24. Quick cross-reference

| Format | Container | Orientation | Sparse? | Primary tools | Lifecycle stage |
|---|---|---|---|---|---|
| FASTQ | text/gz | — | — | aligners | raw reads |
| BAM | BGZF | — | — | samtools, bamtofastq | aligned |
| MEX | text/gz dir | gene×cell | yes (MM) | Scanpy, Seurat | counts |
| 10x `.h5` | HDF5 | gene×cell | CSC | Scanpy, Seurat, HDF5Array | counts |
| `molecule_info.h5` | HDF5 | molecule rows | — | aggr, CellBender | counts (per-UMI) |
| `.h5ad` | HDF5 | cell×gene | CSR/CSC | Scanpy/anndata | analysis (Py) |
| AnnData `.zarr` | Zarr | cell×gene | CSR/CSC | anndata | analysis (cloud) |
| `.loom` | HDF5 | gene×cell | dense-ish | loompy, scVelo | velocity |
| Seurat `.rds`/`.h5Seurat` | R serial / HDF5 | gene×cell | dgCMatrix/BPCells | Seurat, SeuratDisk | analysis (R) |
| SCE (`.rds` / HDF5-backed) | R serial / HDF5 | gene×cell | DelayedArray | Bioconductor | analysis (R) |
| `.h5mu` | HDF5/Zarr | multimodal | per-mod | muon | multimodal |
| TileDB-SOMA | TileDB arrays | cell×gene | sparse ND | tiledbsoma, Census | atlas scale |
| Space Ranger `outs/` | mixed | — | — | squidpy, Seurat, SPE | spatial (Visium) |
| Xenium bundle | h5/parquet/zarr/ometiff | — | CSC + tables | squidpy, SpatialData | spatial (in-situ) |
| MERSCOPE | csv/parquet/tif | — | — | squidpy, SpatialData | spatial (MERFISH) |
| CosMx | csv/parquet/tif | — | — | squidpy, Seurat | spatial (SMI) |
| Slide-seq | csv/mtx | gene×bead | yes | Seurat, SPE | spatial (bead) |
| Stereo-seq GEF/GEM | HDF5 / text | molecule/bin | binned | Stereopy | spatial (DNB) |
| GeoMx DCC/PKC | text/json | probe×AOI | — | GeomxTools | spatial (ROI) |
| SpatialData `.zarr` | Zarr+Parquet | multi-element | mixed | spatialdata | spatial (unified) |
| OME-TIFF / OME-Zarr | TIFF / Zarr | image | — | bioformats, ome-zarr | imaging |
| `.cloupe` | proprietary | — | — | Loupe Browser | visualization |

### Cross-cutting notes for the other docs
- **Orientation trap (relevant to any pipeline/loader doc):** MEX, 10x `.h5`, and Loom are **gene×cell**;
  AnnData, MuData, and Scanpy are **cell×gene**. SCE/Seurat/SPE are **gene×cell**. Loaders transpose; a
  hand-rolled importer that skips the transpose silently produces a garbage matrix.
- **Sparse `shape`:** in 10x `.h5` the matrix `shape` is a **dataset**; in AnnData it's a **group
  attribute**. Different code paths.
- **Raw vs filtered** matters for `06-spatial-processing.md` and any QC step — ambient-RNA correction
  (CellBender/SoupX) needs the **raw** matrix or `molecule_info.h5`, never the filtered one.
- **Parquet is the new default** for large spatial coordinate/transcript tables (Xenium, Visium HD, CosMx
  AtoMx, SpatialData) — the pipeline doc should assume `pyarrow`/`polars`, not CSV, for these.
- **SpatialData `.zarr`** is the convergence target for `06-spatial-processing.md`: it can ingest every
  vendor format in §14–§20 and normalize coordinate systems — worth flagging there as the recommended
  in-memory representation.
- **Convertibility web (for the platforms doc):** `.h5ad`↔SCE (`zellkonverter`), `.h5ad`↔Seurat
  (`SeuratDisk`/`sceasy`), AnnData↔SOMA (`tiledbsoma.io`), any-spatial→SpatialData (`spatialdata-io`). The
  `.cloupe` and vendor raw bundles are the two "endpoints" with no clean round-trip out.

---

## Sources
- [AnnData on-disk format spec (stable)](https://anndata.readthedocs.io/en/stable/fileformat-prose.html) — authoritative encoding-type/version table, sparse/dataframe/categorical/nullable layouts.
- [10x Cell Ranger HDF5 feature-barcode matrix](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-h5-matrices) — `/matrix` group tree, CSC datatypes, features subgroup.
- [10x Cell Ranger MEX matrices](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-mex-matrices) — 3-file layout, v2 genes vs v3 features, filtered vs raw.
- [10x molecule_info.h5](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-molecule-info) — per-molecule field table, barcode_info/pass_filter, probes.
- [10x Cell Ranger BAM tags](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-bam) — CB/CR/UB/UR/GX/GN/RE/xf tag table + xf bit values.
- [10x 3′ v3 read structure (scg_lib_structs)](https://scg-lib-structs.readthedocs.io/en/latest/ge/10xChromium3v3.html) — R1 = 16 bp CB + 12 bp UMI, R2 cDNA, dual index geometry.
- [Loom format spec (loompy)](https://linnarssonlab.org/loompy/format/index.html) — /matrix genes×cells, row/col_attrs, layers, col/row_graphs, spec 3.0.0.
- [MuData .h5mu spec (RFC)](https://mudata.readthedocs.io/en/latest/io/spec.html) — mod/ groups, global obs/var, obsmap/varmap, mod-order.
- [SpatialData design doc (GitHub)](https://github.com/scverse/spatialdata/blob/main/docs/design_doc.md) — 5 SpatialElement types, zarr store tree, coordinate transforms, table region mapping.
- [SpatialData intro/glossary (scverse)](https://spatialdata.scverse.org/en/latest/design_doc.html) — element definitions, NGFF/AnnData/Parquet substrate.
- [OME-Zarr / OME-NGFF spec 0.5](https://ngff.openmicroscopy.org/0.5/) — multiscales axes/datasets/coordinateTransformations, labels, Zarr v3 metadata.
- [Xenium output at a glance (10x)](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance) — full bundle: cell_feature_matrix, cells/transcripts/boundaries parquet, morphology OME-TIFF, experiment.xenium.
- [Space Ranger spatial outputs (10x)](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/spatial-outputs) — spatial/ folder files, tissue_positions columns, scalefactors_json fields, cytassist image.
- [Visium HD binned outputs (10x analysis guide)](https://www.10xgenomics.com/analysis-guides/segmentation-visium-hd) — 2/8/16 µm bins, parquet positions, binned_outputs structure.
- [Vizgen detected_transcripts format](https://vizgen.github.io/vizgen-postprocessing/output_data_formats/detected_transcripts_format.html) — MERSCOPE detected_transcripts column schema; cell_by_gene/cell_metadata/transform files.
- [NanoString CosMx import (Illumina/Partek)](https://help.multiomics.illumina.com/partek/partek-flow/tutorials/nanostring-cosmx-tutorial/importing-cosmx-data.html) — 5-file CosMx bundle (exprMat/metadata/tx/fov_positions/polygons) + image folders.
- [Stereo-seq SAW output files (STOmics)](https://en.stomics.tech/news/stomics-blog/1108.html) — GEF (HDF5) square-bin/cellbin structure, GEM text columns.
- [Stereopy IO](https://stereopy.readthedocs.io/en/v1.5.1/Tutorials/IO.html) — GEF geneExp bins / wholeExp / stat; cellbin cell/cellExp/gene/blockIndex.
- [GeomxTools (NanoString GeoMx)](https://github.com/Nanostring-Biostats/GeomxTools) — DCC + PKC + config → NanoStringGeoMxSet.
- [Slide-seq study (Broad Single Cell Portal)](https://singlecell.broadinstitute.org/single_cell/study/SCP815) — bead locations CSV + DGE, barcode matching.
- [SingleCellExperiment class (OSCA)](https://bioconductor.org/books/3.13/OSCA.intro/the-singlecellexperiment-class.html) — assays/rowData/colData/reducedDims/altExps/sizeFactors.
- [HDF5Array saveHDF5SummarizedExperiment](https://rdrr.io/bioc/HDF5Array/man/saveHDF5SummarizedExperiment.html) — assays.h5 + se.rds, HDF5Array/DelayedArray/TENxMatrix.
- [SpatialExperiment vignette (Bioconductor)](https://bioconductor.posit.co/packages/devel/bioc/vignettes/SpatialExperiment/inst/doc/SpatialExperiment.html) — spatialCoords + imgData; SpatialFeatureExperiment sf geometry.
- [Seurat v5 essential commands](https://satijalab.org/seurat/articles/seurat5_essential_commands) — Assay5 layers (counts/data/scale.data), reductions/graphs/meta.data.
- [Seurat + BPCells](https://satijalab.org/seurat/articles/seurat5_bpcells_interaction_vignette) — on-disk bit-packed counts backing a v5 assay.
- [TileDB-SOMA (GitHub)](https://github.com/single-cell-data/TileDB-SOMA) + [SOMAExperiment reference](https://single-cell-data.github.io/TileDB-SOMA/reference/SOMAExperiment.html) — SOMAExperiment/Measurement/DataFrame/NDArray model, CELLxGENE Census.
- [Loupe Browser / LoupeR (10x)](https://www.10xgenomics.com/support/software/loupe-browser/latest) — proprietary .cloupe/.loupe, LoupeR Seurat→cloupe.
