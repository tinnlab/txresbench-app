# 06 — Spatial Transcriptomics Data Processing (raw → analysis-ready)

> **Scope.** This doc covers everything **spatial-specific about DATA PROCESSING** —
> the steps that turn a raw spatial run into an analysis-ready object, and that
> differ from dissociated scRNA-seq processing (docs `04`/`05`). In scope: import,
> vendor alignment/quantification, **cell segmentation** (the central imaging step),
> spatial QC, spatial normalization, **spot deconvolution / cell-type mapping** (the
> processing↔analysis boundary case), image handling & registration, and binning.
>
> **Out of scope** (mention only as the boundary): spatially-variable-gene detection,
> spatial-domain / niche detection, and cell-cell communication — those are
> spatial-aware *analysis*. **Platform hardware** (chemistry, resolution, panel sizes,
> instrument throughput) lives in `02-platforms.md`; **on-disk format internals**
> (Zarr/OME-NGFF/GEF/h5 layouts) live in `01-file-formats.md`. This doc **cross-refs**
> those, it does not duplicate them.

---

## 0. TL;DR — why spatial processing is a different pipeline

Dissociated scRNA-seq gives you a clean `cell × gene` matrix straight out of Cell
Ranger, and processing (`04`/`05`) is: empty-droplet call → ambient removal →
doublet removal → QC filter → normalize → HVG → embed. **Spatial breaks that model in
two different ways, one per family:**

| | **Sequencing-based / spot-or-bin** | **Imaging-based / in situ** |
|---|---|---|
| Examples | Visium, Visium HD, Slide-seq/Curio, Stereo-seq, GeoMx | Xenium, MERFISH/MERSCOPE, CosMx, seqFISH+ |
| Measurement unit | a **barcoded spot/bin** at a known (x,y) | **individual transcript molecules** at (x,y[,z]) |
| Transcriptome | whole-transcriptome (or FFPE probe set) | **targeted panel** (~100–5000 genes) |
| The core problem | a spot = a **MIXTURE of cells** → need **deconvolution / mapping** to a scRNA reference | molecules must be grouped into cells → need **cell segmentation** to even *build* the matrix |
| Native QC | UMIs/genes per spot, %mito, in-tissue vs out | transcripts/cell, cell/nucleus area, **negative-control / blank rate**, unassigned transcripts |
| No genome-wide QC | — | **no %mito, no genome-wide feature QC** (panel is targeted; often no MT genes) |
| Subcellular info | none | **subcellular** (nucleus vs cytoplasm; molecule coords) |

So the two families need **two different central processing steps that scRNA-seq
does not have at all**: spot data needs **deconvolution** (whose "cells" are
statistical proportions, not segmented objects), and imaging data needs
**segmentation** (whose "cells" are geometry, and whose quality dominates everything
downstream). Everything else (import, QC thresholds, normalization) is scRNA-seq
processing *with spatial-specific caveats*. This doc walks both paths.

Canonical references for the whole landscape: the Bioconductor **OSTA** book
("Orchestrating Spatially-resolved Transcriptomics Analysis",
<https://bioconductor.org/books/release/OSTA/>) and the **single-cell best practices**
spatial chapters (<https://www.sc-best-practices.org/spatial/introduction.html>).

---

## 1. The two families, and what "processing" means for each

### 1a. Sequencing-based / spot-or-bin

A patterned array (or bead layer) of **spatially-barcoded capture probes** binds
mRNA; the barcode→(x,y) map is known, so after normal sequencing you get a
`spot × gene` matrix where each spot's expression is the **sum of all cells (and
ambient RNA) under that spot**. Whole-transcriptome (fresh-frozen poly-A capture) or
a targeted **FFPE probe set** (Visium CytAssist / probe-based chemistry). Resolution
ranges from 55 µm spots (Visium v1/v2, ~1–10 cells/spot), to 10 µm beads
(Slide-seqV2/Curio), to sub-cellular 0.5–2 µm bins (Stereo-seq, Visium HD). Because
a spot mixes cells, the *processing-boundary* step unique to this family is
**deconvolution / cell-type mapping** (§7) — recovering *what cell types, in what
proportion,* contribute to each spot from a matched scRNA reference. **GeoMx DSP** is
the outlier: a user draws **regions of interest (ROIs)** / segments; each ROI is one
"pseudobulk" measurement, so processing looks like bulk RNA-seq QC + normalization
(§2f), not spot QC.

### 1b. Imaging-based / in situ

The instrument **images individual RNA molecules** in intact tissue (in-situ
hybridization for MERFISH/MERSCOPE/CosMx/Xenium, or in-situ sequencing) and decodes
each spot into a gene call at a precise (x,y,z). The primary output is a
**transcript table** (one row per molecule: gene, x, y, z, quality) plus one or more
**morphology images** (DAPI nucleus stain; optional boundary/interior stains).
**There is no cell × gene matrix until you segment.** So the central processing step
is **cell segmentation** (§4): detect cell/nucleus boundaries, then assign each
molecule to a cell. Panels are **targeted** (hundreds to a few thousand genes), which
kills genome-wide QC (no %mito filter possible if MT genes aren't on the panel) and
makes normalization delicate (§6). Crucially, imaging panels include
**negative-control / blank probes** that let you *directly estimate the false-discovery
rate* — a QC signal scRNA-seq never has (§5).

---

## 2. Alignment / quantification & vendor pipelines

Every platform ships an on-instrument or off-instrument pipeline that does the
"Cell-Ranger-equivalent" job. **The processing landscape starts where these outputs
land** — the analysis toolkits (§3) read *these* directory structures. Format
internals are in `01-file-formats.md`; here is what each pipeline *does*.

### 2a. Space Ranger (`spaceranger count`) — Visium

`spaceranger count` is the Visium analog of `cellranger count`. Its spatial-specific
jobs beyond read alignment + UMI counting:

- **Fiducial / image alignment.** Aligns the microscope H&E (or CytAssist) image to
  the capture-area fiducial frame — automatically, or **manually via the Loupe
  Browser** manual-alignment workflow when auto-alignment fails.
- **Tissue detection.** Segments which spots sit *under tissue* (in-tissue) vs bare
  slide, producing the in-tissue flag used for QC filtering (§5).
- **Spot barcode → coordinate mapping.** Emits the `spatial/` folder:
  `tissue_positions.csv` (per-barcode row/col array indices, `in_tissue` flag, and
  pixel coordinates in the full-res image), `scalefactors_json.json`
  (`tissue_hires_scalef`, `tissue_lowres_scalef`, `spot_diameter_fullres`,
  `fiducial_diameter_fullres`), the down-sampled `tissue_hires_image.png` /
  `tissue_lowres_image.png`, and QC overlays `aligned_fiducials.jpg` /
  `detected_tissue_image.jpg`. The count matrix comes in **filtered**
  (tissue-associated barcodes only) and **raw** (all barcodes) forms, each as MEX
  (`.mtx`) and HDF5 (`filtered_feature_bc_matrix.h5`)
  (<https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview>).
- **FFPE probe sets & CytAssist.** For FFPE tissue, Space Ranger uses a **probe set
  reference** (probe→gene map) instead of poly-A alignment; **CytAssist** transfers
  probes from a standard slide to the capture area, and its use changes the image
  inputs/outputs (the H&E is a separate microscope image aligned to the CytAssist
  image). Probe filtering (deprecated/excluded probes) happens here.

### 2b. Space Ranger — Visium HD (binning)

Visium HD's capture area is a **continuous grid of 2×2 µm squares** (no gaps). Space
Ranger:

- Produces a `binned_outputs/` directory with **multiple bin resolutions**: the
  native `square_002um`, plus aggregated `square_008um` and `square_016um` bins.
  A `bin` is the **gene-wise UMI sum** over the constituent 2 µm squares (8 µm = 4×4
  squares) (<https://www.10xgenomics.com/analysis-guides/segmentation-visium-hd>).
- **8 µm is 10x's recommended default working bin** — 2 µm is too sparse for
  spot-level clustering, 16 µm blurs cell boundaries. The 2 µm layer is the substrate
  for **segmentation-based re-binning into cells** (§9, `bin2cell`).
- Space Ranger **v4 (June 2025)** adds **H&E-segmented cell-level output** directly
  (`segmented_outputs/`) alongside the binned outputs, plus a
  `barcode_mappings.parquet` linking each 2 µm barcode (`Square_002um`) to its 8/16 µm
  bins and its inferred `Cell_id`
  (<https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/segmented-outputs>).

### 2c. Xenium Onboard Analysis (XOA) — 10x Xenium

XOA runs **on the instrument** and does decoding **and default segmentation** in one
pass (Xenium's differentiator: you get a cell × gene matrix off the box):

- **Molecule decoding** → `transcripts.parquet` (gene, x, y, z, `qv` quality value,
  overlaps-nucleus flag). A standard QC gate keeps transcripts with **QV ≥ 20**.
- **Nucleus detection** from DAPI via a custom neural net, then **cell segmentation**.
  Two modes: **DAPI-only** (nucleus + **5 µm expansion** — reduced from 15 µm in
  v1.x — or until hitting a neighbor, Voronoi-style overlap resolution), and
  **multimodal cell segmentation** (v3.0+) which runs 3 sequential steps —
  **boundary** stains (ATP1A1/E-Cadherin/CD45) → **interior** stain (18S rRNA) →
  **nuclear expansion** (DAPI) — via deep-learning models trained on FF + FFPE Xenium
  data
  (<https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/algorithms-overview/segmentation>).
- **Outputs**: `cell_feature_matrix.h5` / `.zarr`, `cells.parquet` (centroid, area,
  counts), `cells.zarr.zip` (nucleus + cell **boundary polygons** and masks),
  `nucleus_boundaries.parquet` / `cell_boundaries.parquet`, and `metrics_summary.csv`
  / `analysis_summary.html` with **negative-control** metrics (§5).
- **Re-segmentation off-instrument**: `xeniumranger resegment` lets you change the
  expansion distance, min DAPI intensity, or stain configuration; `xeniumranger
  import-segmentation` ingests an external segmentation (e.g. Baysor/Cellpose)
  (<https://www.10xgenomics.com/support/software/xenium-ranger/latest/analysis/running-pipelines/XR-resegment>).

### 2d. MERSCOPE pipeline + VPT (Vizgen post-processing) — MERFISH

The MERSCOPE instrument decodes MERFISH images to a **`detected_transcripts.csv`**
(gene, global_x, global_y, global_z, fov, barcode_id) and runs a default Cellpose
watershed segmentation → `cell_by_gene.csv` + `cell_metadata.csv` + segmentation
`.parquet`/`.hdf5`. The **Vizgen Post-processing Tool (VPT,
`pip install vpt`)** is the *reprocessing* toolkit: re-segment with a
**Cellpose/Cellpose2 plugin** (including a **user-retrained** model via
`vpt --extract` → annotate → retrain), import external segmentations, and regenerate
downstream outputs (per-entity geometry, transcript→entity assignment, per-entity
image intensity). Runs on workstation/cluster/cloud, reproducibly
(<https://github.com/Vizgen/vizgen-postprocessing>,
<https://vizgen.github.io/vizgen-postprocessing/>).

### 2e. CosMx AtoMx (SMI) — NanoString/Bruker

CosMx SMI decoding runs on-instrument; the **AtoMx Spatial Informatics Platform
(SIP)** is a no-code cloud pipeline for QC/segmentation/analysis, but for
open-source processing you **export flat files** (5 files: exprMat / metadata /
tx / fov_positions / polygons) or a Seurat/TileDB object. Community wrappers
(`CosMx_Lite`, `napari-CosMx`) and the standard toolkits (Seurat `LoadNanostring`,
squidpy `read.nanostring`) then ingest the flat files
(<https://nanostring.com/support/knowledgebase/cosmx-smi-data-analysis/>,
<https://github.com/cancerbioinformatics/CosMx_Lite>).

### 2f. Stereo-seq **SAW** — STOmics/BGI

The **SAW** (Stereo-seq Analysis Workflow) pipeline aligns reads to the DNB
(DNA-nanoball) chip coordinates and does **CellBin** tissue + cell segmentation from a
registered ssDNA/DAPI TIFF. Outputs are the STOmics **GEF** (Gene Expression Format,
HDF5-based, fast) and **GEM** (plain-text `x y gene MIDCount`) files, with layers for
different bin sizes and a **cellbin** layer. `SAW convert` interconverts; **Stereopy**
(`pip install stereopy`) reads GEF directly for square-bin *or* cell-bin analysis
(<https://en.stomics.tech/news/stomics-blog/1108.html>,
<https://stereopy.readthedocs.io/>). Format internals → `01-file-formats.md`.

### 2g. Slide-seq / Curio (Puck)

Slide-seqV2 / Curio Seeker use a **"puck"** of randomly-deposited 10 µm barcoded
beads; a separate bead-barcode→(x,y) map (from in-situ indexing) is joined to the
count matrix. The Curio Seeker pipeline emits a bead × gene matrix + a bead-location
file. Beads are near-single-cell but sparse, so this family is often **deconvolved or
bin-aggregated** like other spot data. `spatialdata-io` has a **Curio** reader.

### 2h. GeoMx DSP (ROI, not spot/molecule)

GeoMx is region-based: **DCC + PKC files** per ROI/segment → the **GeomxTools /
NanoStringNCTools** Bioconductor stack builds a `NanoStringGeoMxSet`, does QC
(segment/probe/gene filtering, LOQ), and normalizes — commonly **Q3 (upper-quartile)**
or background normalization; `standR` adds RUV-based batch correction
(<https://github.com/Nanostring-Biostats/GeomxTools>,
<https://davislaboratory.github.io/GeoMXAnalysisWorkflow/>). Processing here resembles
**bulk RNA-seq**, not single-cell — noted for completeness.

---

## 3. Import into analysis environments

The toolkits below read the vendor outputs above and place the four spatial data
elements consistently: an **expression table** (`AnnData`/`SingleCellExperiment`), a
**coordinate array**, one or more **images** (+ scalefactors), and — for imaging —
**segmentation geometry** (boundary polygons / label masks) and the raw **transcript
points**.

### 3a. Python / scverse

- **scanpy / squidpy.** `squidpy.read.visium()` (Space Ranger dir → AnnData with
  coordinates in `adata.obsm['spatial']`, images + scalefactors in
  `adata.uns['spatial']`), `squidpy.read.vizgen()` (MERSCOPE), `squidpy.read.nanostring()`
  (CosMx). Xenium reading is delegated to the `spatialdata-io` Xenium reader. squidpy
  builds the spatial neighbor graph (`sq.gr.spatial_neighbors`) — fixed-radius grid
  for Visium, Delaunay/kNN for single-cell platforms
  (<https://squidpy.readthedocs.io/en/stable/notebooks/tutorials/index.html>).
  scanpy's own `sc.read_visium` is the minimal Visium reader.
- **SpatialData + `spatialdata-io`.** The modern scverse container (a
  `SpatialData` object holds `images`, `labels` = segmentation masks, `shapes` =
  polygons/points, `points` = transcripts, `tables` = AnnData, all tied by a shared
  **coordinate transform system**, persisted to **OME-NGFF Zarr**). Readers:
  `visium`, `visium_hd`, `xenium`, `merscope`, `cosmx`, `curio`, `stereoseq`
  (7.x), `dbit`, `seqfish`, plus multiplex-imaging (`macsima`, `phenocycler`,
  `mcmicro`, `steinbock`). The idiom is **parse → write to Zarr → re-read** for
  performance
  (<https://spatialdata.scverse.org/projects/io/en/latest/>). This is the substrate
  `sopa` and `bento` build on.
- **Bento** (`bento-tools`) — **subcellular** analysis: ingests molecule coords +
  segmentation polygons (MERFISH, seqFISH+, Molecular Cartography, Xenium), stores in
  AnnData, and computes subcellular localization patterns / gene-gene colocalization,
  and **subcellular QC metrics** (part of scverse)
  (<https://bento-tools.readthedocs.io/>).
- **Stereopy** — GEF/GEM reader + square-bin/cell-bin processing for Stereo-seq.

### 3b. R / Seurat

- **`Load10X_Spatial()`** — Space Ranger Visium dir → Seurat object with a `Spatial`
  assay + a `VisiumV1`/`VisiumV2` image object (coords + scalefactors + tissue image).
- **`LoadXenium()`** — Xenium dir → assays for the panel plus `BlankCodeword`,
  `ControlCodeword`, `ControlProbe` (the negative controls kept as **separate assays**
  for QC), a `Molecules`/`fov` object holding transcript coords + segmentation.
- **`LoadNanostring()`** — CosMx flat files → Seurat object with molecule + polygon
  data. `SpatialFeaturePlot()` overlays expression on histology
  (<https://satijalab.org/seurat/articles/spatial_vignette.html>,
  <https://satijalab.org/seurat/articles/seurat5_spatial_vignette_2>).
- **semla** (successor to **STUtility**) — extends Seurat for Visium with image
  registration, interactive tissue annotation, and region-based tools
  (<https://academic.oup.com/bioinformatics/article/39/10/btad626/7319366>).

### 3c. R / Bioconductor (OSTA stack)

- **`SpatialExperiment`** — the core class: extends `SingleCellExperiment` with a
  `spatialCoords` matrix (per-spot/cell x,y), `imgData` (images + scalefactors as
  `SpatialImage`s), and colData; imaging platforms additionally carry molecule/polygon
  data.
- **Readers**: **`VisiumIO`** (`TENxVisium`/`TENxVisiumHD` → Visium/Visium HD, multi-sample),
  **`XeniumIO`** (Xenium: h5/mtx counts + parquet/csv polygons/molecules),
  **`SpatialExperimentIO`** (CosMx, Xenium, MERSCOPE, seqFISH → SPE/SCE), and
  **`SpatialFeatureExperiment` (SFE)** which reads CosMx/Xenium/MERSCOPE/Visium(HD)
  and adds **`sf`-based geometries** (spot polygons, cell/nucleus boundaries, tissue
  boundaries) as first-class `colGeometries`/`annotGeometries`
  (<https://bioconductor.org/books/release/OSTA/pages/bkg-importing-data.html>).
- **Voyager** — exploratory *spatial* data analysis (ESDA) on top of SFE: spatial QC
  plots, Moran's I, local spatial statistics; its Xenium/Visium vignettes are a good
  QC reference (<https://pachterlab.github.io/voyager/>).

### 3d. Giotto (cross-ecosystem)

**`createGiottoObject()`** (expression matrix + centroid coords) or technology
convenience readers (Visium, Xenium, Vizgen, CosMx) build a `giotto` object;
`filterGiotto` + `normalizeGiotto` do QC + normalization; Giotto Suite handles
subcellular raw data (transcripts/polygons) + multi-modal (RNA/protein/H&E) in one
object (<https://giottosuite.com/>,
<https://genomebiology.biomedcentral.com/articles/10.1186/s13059-021-02286-2>).

### 3e. sopa (unified imaging pipeline)

**sopa** is a technology-invariant pipeline built **on SpatialData** that runs
segmentation (Cellpose / **Baysor** / others) at scale (millions of cells),
transcript/channel aggregation, annotation, and a unified visualizer, for Xenium /
Visium HD / MERSCOPE / CosMx / PhenoCycler / MACSima — via CLI, API, or a Snakemake
workflow (Nat. Commun. 2024,
<https://www.nature.com/articles/s41467-024-48981-z>,
<https://github.com/gustaveroussy/sopa>). It's the "one pipeline to segment + build
the analysis-ready object" option for imaging data.

**Where spatial coords + images land — quick map**

| Ecosystem | coords | images + scalefactors | segmentation geometry | transcripts |
|---|---|---|---|---|
| scanpy/squidpy AnnData | `obsm['spatial']` | `uns['spatial'][sample]['images'/'scalefactors']` | (in SpatialData `labels`/`shapes`) | (SpatialData `points`) |
| SpatialData | element coordinate transforms | `images` | `labels` (masks) + `shapes` (polygons) | `points` |
| Seurat | image object (`VisiumV2`/`fov`) `@coordinates` | image object `@image` + `@scale.factors` | `Molecules`/segmentation slot | `fov`/`Molecules` |
| SpatialExperiment / SFE | `spatialCoords()` | `imgData()` | SFE `colGeometries`/`annotGeometries` (`sf`) | (SFE/tx table) |
| Giotto | `spatial_locs` | `images` slot | polygon layer | `feat_info` (points) |

---

## 4. Cell segmentation (imaging platforms) — the central processing step

For imaging data, **segmentation quality determines everything downstream** — a bad
segmentation fabricates cell types (spillover) and destroys real ones (over-splitting).
This is the imaging analog of empty-droplet + doublet calling in scRNA-seq, but harder,
because the "cell" is a *geometric* object you infer from images and/or transcript
density. The general recipe: **detect nuclei → define cell boundary (expand or use
membrane cue) → assign each molecule to the enclosing cell → build the matrix.**

### 4a. Nucleus detection + expansion (the default everywhere)

DAPI gives a reliable **nucleus** signal; the hard part is the **cytoplasm/membrane**.
The universal fallback: detect nuclei, then **expand** by a fixed radius (Xenium's
5 µm default; earlier 15 µm) or until neighbors collide (Voronoi tessellation). Cheap
and robust, but systematically **misses cytoplasmic transcripts** for large cells and
**over-/under-assigns** at boundaries.

### 4b. Image-based deep-learning segmenters

- **Cellpose** — generalist flow-based U-Net; predicts spatial gradients toward each
  object center and groups pixels; pretrained `nuclei` and `txr` models, retrainable.
  The default in Vizgen VPT and a common Xenium/PhenoCycler choice
  (<https://vizgen.github.io/vizgen-postprocessing/>).
- **StarDist** — represents each nucleus as a **star-convex polygon** (radial
  distances + object probability, NMS); excels at **densely packed, convex nuclei**.
  The nucleus detector inside `bin2cell` (§9)
  (<https://stardist.net/>). Rule of thumb: **StarDist for dense convex nuclei,
  Cellpose for irregular whole-cell shapes.**
- **Xenium multimodal segmentation** — 10x's boundary-stain-aware DL (ATP1A1 /
  E-Cadherin / CD45 boundary → 18S rRNA interior → DAPI expansion), the best
  membrane-accurate option when the Cell Segmentation Staining kit was used (§2c).

### 4c. Transcript-aware / transcript-only segmenters

These use the **molecule density itself** — critical where morphology images are weak
or cells are morphology-ambiguous:

- **Baysor** — optimizes 2D/3D cell boundaries from the **joint likelihood of
  transcriptional composition + molecule density**; can run **prior-free** or be
  **guided by a prior segmentation** (e.g. Cellpose/DAPI nuclei, with
  `prior-segmentation-confidence`), and recovers transcripts that nucleus-expansion
  drops. Works on MERFISH/Xenium/CosMx/Stereo-seq; 10x publishes a Baysor-on-Xenium
  guide and `xeniumranger import-segmentation`
  (<https://kharchenkolab.github.io/Baysor/dev/segmentation/>,
  <https://www.10xgenomics.com/analysis-guides/using-baysor-to-perform-xenium-cell-segmentation>).
- **proseg** — probabilistic, **Cellular-Potts-model-inspired** ("cell = bag of RNA")
  segmentation from transcript distribution alone; fast, no multimodal stain needed;
  supports Xenium/CosMx/MERSCOPE/Visium HD (Nat. Methods 2025,
  <https://www.nature.com/articles/s41592-025-02697-0>,
  <https://github.com/dcjones/proseg>).
- **ClusterMap**, **Baysor**-likes, **watershed** on DAPI, and signed-graph /
  simulation-based methods round out the field. **Segmentation-free / binning**
  approaches (aggregate molecules into a fine grid, no cell calls) sidestep the problem
  for domain-level analysis (Stereo-seq square-bin; Visium HD bins).

### 4d. The spillover / mis-segmentation problem + segmentation QC

Two failure modes dominate: **spillover** (transcripts from cell A assigned to
neighbor B → contamination → phantom "mixed" cell types, the imaging analog of
ambient RNA) and **mis-segmentation** (splitting one cell into two, or merging two
into one → doublet-like or lost cells). Because the panel is targeted, you can't lean
on %mito. **Segmentation QC** instead uses:

- **Transcripts per cell** and **cell/nucleus area** distributions (tiny/huge outliers
  = bad segments); **nucleus:cell area ratio**.
- **Fraction of transcripts assigned** vs **unassigned** (Xenium reports unassigned
  transcripts; high unassigned = under-segmentation).
- **Negative-control rate per cell** (§5) — spillover inflates it.
- Bento-style **subcellular QC** (nuclear vs cytoplasmic fraction sanity).
- Visual overlay of boundaries on DAPI/H&E; cross-method concordance (Baysor vs
  Cellpose vs proseg). The community consensus is that **no single segmenter wins
  everywhere** — hence sopa/Baysor/proseg let you swap methods and compare (OSTA §18
  "Segmentation", <https://bioconductor.org/books/release/OSTA/pages/img-segmentation.html>).

**Cells at FOV edges** are a recurring artifact: cells straddling
field-of-view/tile boundaries get split; pipelines flag or drop them.

---

## 5. QC — spatial-specific

### 5a. Spot / bin (sequencing-based)

Same metrics as scRNA-seq (**counts/UMIs per spot, genes per spot, %mito**), but with
spatial twists:

- **In-tissue vs out-of-tissue filtering.** Keep only `in_tissue == 1` spots (Space
  Ranger's tissue detection). Out-of-tissue spots capture ambient/diffusion signal.
- **%mito with a caveat.** High %mito can mark low-quality spots *or* a real biological
  region (e.g. muscle) — spatial context means you **don't blindly drop** high-mito
  spots the way you would cells; inspect the tissue map first.
- **Spots-under-tissue / low-count regions.** Some tissue regions are genuinely
  low-RNA (necrosis, adipose); an adaptive/global count threshold can erase a real
  anatomical region. Prefer visual inspection + gentler thresholds; consider
  **not** filtering low-count regions, just flagging them.
- **Visium HD bin QC.** 2 µm bins are extremely sparse (often <100 counts); QC and
  most analysis happen at **8 µm**, or after `bin2cell` reconstruction (§9). Filter
  bins outside tissue and empty bins.

### 5b. Imaging (in situ) — the distinctive QC

Imaging QC is dominated by two things scRNA-seq lacks: **you built the cells yourself
(segmentation QC, §4d)** and **you have direct false-discovery controls**:

- **Transcripts per cell / genes per cell.** Low-count cells are filtered — a common
  MERFISH cutoff is **< ~10–20 transcripts/cell** discarded; Xenium similarly drops
  near-empty segments. There is **no %mito** (MT genes usually off-panel) and **no
  genome-wide gene QC** (fixed panel).
- **Cell / nucleus area** (§4d) — outliers flag bad segmentation.
- **Negative-control / blank rate = built-in FDR estimate.** This is the signature
  imaging QC:
  - **MERFISH blank codewords** — codewords in the codebook that encode *no* gene
    (≥ Hamming-distance-4 from real codes; e.g. 7 of 140). The fraction of blanks
    "detected" estimates the **misidentification / false-positive rate**; a
    per-experiment target (often ~5%) sets decoding thresholds
    (<https://genomebiology.biomedcentral.com/articles/10.1186/s13059-024-03303-w>).
  - **Xenium negative controls** — three classes kept as separate features:
    **negative control probes** (target non-biological sequence → probe-hybridization
    false positives), **negative control codewords / blank codewords** (valid codes
    assigned to no probe → decoding errors), and **genomic/deprecated controls**. XOA
    reports **"negative control probe rate"** and **"estimated false-positive
    transcripts per cell"**; you QC by asserting real-gene counts ≫ control counts and
    can compute a per-gene FDR
    (<https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/advanced/metric-calculations>).
    Note recent work flags that **blanks/negative controls alone may underestimate
    off-target binding** — treat them as a floor, not a ceiling
    (<https://elifesciences.org/reviewed-preprints/107070>).
- **Unassigned transcripts.** The fraction of decoded molecules **not assigned to any
  cell** — high = under-segmentation or sparse tissue; a segmentation-quality signal.
- **Cells at FOV/tile edges** — flag/drop (§4d).
- The **negative controls are dropped from the expression matrix before
  normalization** (kept only for QC); e.g. Seurat `LoadXenium` isolates them as
  `BlankCodeword`/`ControlProbe`/`ControlCodeword` assays.

---

## 6. Normalization for spatial

### 6a. Spot / Visium

Largely the **scRNA-seq toolbox with caveats** (see `05-tools-and-parameters.md` for
the base methods):

- **Log-normalization** (total-count scaling + log1p) — the default, fine for most
  Visium.
- **SCTransform** — Seurat's regularized negative-binomial / Pearson-residual method;
  the Seurat spatial vignette **recommends SCTransform for Visium** because per-spot
  total counts vary strongly with tissue region (cell density), and SCT removes that
  technical-depth confound while preserving biology better than plain log-norm
  (<https://satijalab.org/seurat/articles/spatial_vignette.html>).
- **scran pooling** — usable, but its cell-based assumptions fit spot mixtures less
  cleanly; use with care.
- **Area / total normalization** — because a spot's counts scale with **how many cells
  it covers**, normalizing to total counts partly normalizes for cell number (which
  can be *desirable* — you often want per-cell-equivalent — or *undesirable* if density
  is the signal). Know which you want before you normalize.
- **Visium HD low-count bins** — 2 µm bins are too sparse to normalize reliably; work
  at 8 µm or post-`bin2cell` (§9).

### 6b. Imaging / targeted-panel — a genuinely open problem

Normalizing **targeted** im-SRT is *not* solved by copying scRNA-seq defaults. A
dedicated benchmark (Atta, Fan et al., *Genome Biology* 2024) shows **the choice of
normalization materially changes results in a cell-type/region-specific way**, because
a targeted panel that over-represents genes from one region distorts total-count
normalization there
(<https://genomebiology.biomedcentral.com/articles/10.1186/s13059-024-03303-w>):

- **Library-size / total-count** normalization is the common default but can inject
  region-specific bias when the panel is unbalanced.
- **Cell volume / area normalization** — divide counts by segmented cell **volume**
  (3D) or **area** (2D), since molecule counts scale with cell size and imaging depth;
  frequently preferred for MERFISH/Xenium.
- **DESeq2 / TMM-style** and **Pearson-residual** approaches are alternatives the
  benchmark compares; no universal winner — **pick per-dataset and check robustness of
  downstream calls**.
- Practical floor: filter **< ~10 transcripts/cell** before normalizing, and normalize
  **after** dropping negative-control features.

---

## 7. Spot deconvolution / cell-type mapping — the processing↔analysis boundary

For **spot/bin data**, a spot is a mixture, so recovering **cell-type composition per
spot** from a matched scRNA-seq reference is the defining spatial step. It **straddles
processing and analysis**: it's often the *first* thing done to a Visium object (so it
reads as processing — you're resolving the measurement unit), but the *result* (cell
proportions, mapped single cells) is an analytical inference gated on reference
quality. This doc includes it as the **boundary case**; niche/domain analysis built on
top is out of scope.

Two problem framings: **deconvolution** (estimate cell-type *proportions* per spot)
and **mapping** (project reference single cells onto spots). Every method **depends on
a good, matched scRNA/snRNA reference** — wrong or incomplete reference cell types →
wrong proportions, no matter the method.

| Tool | Model | Ecosystem | Notes / ref |
|---|---|---|---|
| **cell2location** | Bayesian hierarchical NB; estimates **absolute** cell abundance; hyperparams `N_cells_per_location`, `detection_alpha` | Python (scvi-tools/pyro) | Top performer on real + simulated; GPU-heavy; nuclei-count prior from histology. <https://cell2location.readthedocs.io/> |
| **RCTD** (`spacexr`) | Poisson; platform-effect correction; **doublet / full / multi** modes | R | Best overall accuracy on real data; doublet mode caps 2 types/pixel. Nat. Biotechnol. 2022, <https://github.com/dmcable/spacexr> |
| **SPOTlight** | seeded NMF (topics from reference) | R | Strong on Visium; fast. <https://elifesciences.org/articles/88431> |
| **stereoscope** | NB regression, per-cell-type | Python (scvi-tools) | Solid; slower. |
| **DestVI** | conditional VAE (continuous sub-type variation) | Python (scvi-tools) | Captures within-type variation. |
| **Tangram** | deep-learning **mapping** (align scRNA cells → spatial); also imputes genome-wide & corrects imaging panels | Python | Mapping not proportions; works for Visium *and* imaging. Nat. Methods 2021, <https://www.nature.com/articles/s41592-021-01264-7> |
| **SpatialDWLS** | dampened weighted least squares | Giotto (R) | Co-top on real-data accuracy. |
| **CARD** | conditional autoregressive (uses spatial correlation) | R | Spatially-informed proportions. |
| **STdeconvolve** | reference-**free** LDA topic model | R | Use when no scRNA reference exists. |

**Benchmark consensus** (Spotless *eLife* 2024; Li et al. *Bioinformatics* 2023;
sc-best-practices ch. 32): **cell2location, RCTD, and SPOTlight** are consistently
top-tier on Visium; **cell2location, RCTD, STdeconvolve** lead on Slide-seq/Stereo-seq
(<https://elifesciences.org/articles/88431>,
<https://www.sc-best-practices.org/spatial/deconvolution.html>). Practical prep: match
gene IDs (ENSEMBL) across reference + spatial, remove MT genes, use a permissive
gene-selection filter for cell2location, and QC the fit (training loss should plateau;
reconstruction should track the diagonal).

For **imaging data** deconvolution is usually unnecessary (cells are segmented), but
**mapping / reference label-transfer** (Tangram, or standard scRNA label transfer) is
still used to annotate cell types and to impute genome-wide expression from the
targeted panel.

---

## 8. Image handling & registration

Spatial objects carry **images** that must be handled, aligned, and (sometimes)
registered across modalities/sections — a processing concern scRNA-seq never has.

- **Image types.** H&E (Visium brightfield), **DAPI** (nuclei, all imaging platforms),
  **IF / morphology** channels (Xenium boundary/interior stains, CosMx morphology,
  MERSCOPE poly-T/DAPI). Multiplex-imaging (PhenoCycler/MACSima) adds many protein
  channels.
- **Pyramidal formats.** Large images are stored as **OME-TIFF** / **OME-NGFF (Zarr)**
  multiscale pyramids so viewers can lazy-load; SpatialData standardizes on OME-NGFF.
  Details → `01-file-formats.md`.
- **Scalefactors.** Visium ties the down-sampled `tissue_hires_image` /
  `tissue_lowres_image` to full-res spot coordinates via
  `tissue_hires_scalef`/`tissue_lowres_scalef` and `spot_diameter_fullres` in
  `scalefactors_json.json` — you **must apply the right scalefactor** to plot
  expression on the image. SpatialData replaces per-toolkit scalefactor juggling with
  an explicit **coordinate-transform graph** between elements.
- **Registering imaging + expression.** Xenium/MERSCOPE segmentation happens in the
  morphology-image frame; molecule coords + segmentation live in one coordinate system
  (the vendor pipeline registers them). Adding an **H&E** post-hoc (common for Xenium)
  requires registering the H&E to the DAPI frame (10x's Xenium H&E alignment; `sopa`).
- **Aligning serial sections / 3D reconstruction / multi-sample alignment.** To stack
  adjacent tissue sections into 3D or align replicates:
  - **PASTE / PASTE2** — optimal-transport (fused Gromov-Wasserstein) alignment of
    consecutive slices; **PASTE2** does **partial** overlap + estimates the overlap
    fraction, optionally using histology (Genome Res. 2023,
    <https://github.com/raphael-group/paste2>).
  - **GPSA** — Gaussian-process spatial alignment; smooth nonparametric coordinate
    warps for flexible tissue.
  - **STalign** — diffeomorphic (LDDMM) image-based registration across sections /
    samples / technologies; handles nonlinear distortion (Cell Systems 2025).
  - **Eggplant** — reference-based landmark transfer to a common coordinate framework.
  These are the entry point to *multi-sample* spatial (§10) and to comparing conditions
  in a shared coordinate system.

---

## 9. Binning strategy (Visium HD / Stereo-seq)

Sub-cellular-resolution spot arrays force a **bin-size decision** that is itself a
processing step:

- **Visium HD.** Native 2 µm is too sparse; **8 µm** is 10x's recommended analysis bin
  (§2b). To get *cells* rather than arbitrary squares:
  - **`bin2cell`** — segments Visium HD into cells by running **StarDist** on the H&E /
    morphology image to find nuclei, discretizing nuclei onto the 2 µm grid,
    **expanding** ~2 bins (4 µm), and assigning ambiguous bins by **transcriptional
    similarity in PCA space**; scanpy-compatible, minutes on CPU (Bioinformatics 2024,
    <https://academic.oup.com/bioinformatics/article/40/9/btae546/7754061>).
  - **Space Ranger v4 H&E segmentation** (§2b) and **ENACT** are alternatives that
    produce cell-level output directly.
  - **proseg** and **sopa** also segment Visium HD.
- **Stereo-seq.** Choose **square bins** (binN, e.g. bin50 ≈ 25 µm) for
  domain/pseudobulk-level work, or **CellBin** (SAW's DAPI/ssDNA-segmented cells) for
  single-cell resolution; Stereopy supports both paths (§2f). The tradeoff mirrors
  Visium HD: bigger bins = denser/less noisy but blur cells; cell-bin = true cells but
  depends on segmentation quality.

**Rule of thumb:** bin for **domain/tissue-architecture** questions; segment (bin2cell
/ CellBin / proseg) for **cell-type / single-cell** questions.

---

## 10. Integrating spatial with scRNA + multi-sample spatial

- **Reference / label transfer onto spatial.** Beyond deconvolution (§7), standard
  scRNA integration transfers **cell-type labels** and **imputes unmeasured genes** onto
  spatial: Seurat anchor-based `TransferData`, scANVI/scVI label transfer, Tangram
  mapping, or Harmony joint embedding. For imaging (targeted panel), this is how you
  get genome-wide expression + fine cell types.
- **Harmonizing multiple spatial samples.** Treat each slide as a **batch** and run the
  same integration methods as scRNA-seq: **Harmony** (recommended first, fastest),
  **scVI/scANVI**, or Scanorama on the joint PCA; represent the scRNA reference as its
  own batch and each spatial slice as a batch, correct, then cluster
  (<https://www.sc-best-practices.org/spatial/introduction.html>). Newer
  spatial-specific batch tools (e.g. **Crescendo** for imaging count data) correct
  batch while preserving spatial gene patterns
  (<https://link.springer.com/article/10.1186/s13059-025-03479-9>).
- **Batch / tissue effects unique to spatial.** Section-to-section staining/permeation
  differences, tile/FOV effects (imaging), and true anatomical differences confound
  naively. Correct expression batch **but preserve coordinates** — never mix the batch
  correction into the spatial graph. Cross-section comparison usually pairs a coordinate
  alignment (§8, PASTE/STalign) *with* an expression batch correction.

---

## 11. The analysis-ready spatial object (end-state per ecosystem)

A spatial object is "analysis-ready" when it holds: **QC-filtered, normalized
expression** + **spatial coordinates** + **image(s) with correct scalefactors** +
(imaging) **segmentation geometry & transcript points** + (spot) **deconvolution
results / mapped labels** — ready for spatially-aware *analysis* (SVGs, domains,
neighborhoods, communication — all out of scope here). Concretely:

| Ecosystem | Analysis-ready container | Holds |
|---|---|---|
| **scanpy/squidpy** | `AnnData` | `X` normalized, `obsm['spatial']`, `uns['spatial']` images+scalefactors, spatial graph in `obsp`, deconv/labels in `obs`/`obsm` |
| **SpatialData** | `SpatialData` (Zarr) | `tables` (AnnData), `images`, `labels` (masks), `shapes` (polygons/spots), `points` (transcripts), one coordinate system — the richest imaging end-state |
| **Seurat** | Seurat object | `Spatial`/panel assay (SCT/lognorm), image object (`VisiumV2`/`fov`) with coords+scalefactors, `Molecules`/segmentation, negative-control assays kept aside |
| **Bioconductor** | `SpatialExperiment` / **SFE** | `spatialCoords()`, `imgData()`, normalized assay, SFE `sf` geometries (spots/cells/tissue) for Voyager ESDA |
| **Giotto** | `giotto` object | expression + `spatial_locs` + polygons + images, multi-modal |
| **Stereopy** | `StereoExpData`/AnnData | GEF-derived square-bin or cell-bin matrix + coords + (cellbin) segmentation |

For **spot data** the end-state additionally carries per-spot **cell-type proportions**
(cell2location/RCTD/SPOTlight) or **mapped labels** (Tangram); for **imaging data** it
carries the **segmentation** used and its QC verdict. The *next* doc/stage
(spatial-aware analysis) consumes exactly this object.

---

## 12. Canonical spatial pipeline flow — sequencing-based vs imaging-based, side by side

```
 SEQUENCING-BASED (Visium / HD / Slide-seq / Stereo-seq)   |  IMAGING-BASED (Xenium / MERFISH / CosMx / seqFISH)
===========================================================|=========================================================
 1. Vendor align+count                                     |  1. Vendor decode molecules
    Space Ranger count / SAW / Curio                       |     XOA / MERSCOPE / AtoMx / SAW-CellBin
    → spot×gene matrix + spatial/ + images                 |     → transcripts table (gene,x,y,z,QV) + morphology imgs
-----------------------------------------------------------|---------------------------------------------------------
 2. (HD/Stereo) BIN or SEGMENT-to-cell                     |  2. *** CELL SEGMENTATION (central step) ***
    8µm bins / bin2cell / CellBin                          |     nucleus detect → boundary (Cellpose/StarDist/
                                                           |     multimodal) or transcript-aware (Baysor/proseg)
                                                           |     → assign molecules → cell×gene matrix
-----------------------------------------------------------|---------------------------------------------------------
 3. Import (squidpy/SpatialData/Seurat/SPE/Giotto)         |  3. Import (SpatialData/sopa/Seurat/squidpy/SPE)
    coords→obsm['spatial'], imgs→uns/imgData               |     coords + labels(masks) + shapes + points
-----------------------------------------------------------|---------------------------------------------------------
 4. QC: counts/genes per spot, %mito,                      |  4. QC: transcripts/cell, cell/nucleus AREA,
    in-tissue vs out, low-count regions                    |     NEGATIVE-CONTROL/BLANK rate (FDR), unassigned tx,
                                                           |     segmentation quality, FOV-edge cells
                                                           |     (drop neg-control features before normalize)
-----------------------------------------------------------|---------------------------------------------------------
 5. Normalize: lognorm / SCTransform / scran               |  5. Normalize: targeted-aware — volume/area norm,
    (area/total norm; HD→8µm)                              |     lognorm/Pearson; filter <~10 tx/cell first
-----------------------------------------------------------|---------------------------------------------------------
 6. *** DECONVOLUTION / MAPPING (boundary) ***             |  6. (optional) label transfer / Tangram mapping,
    cell2location / RCTD / SPOTlight / Tangram             |     genome-wide imputation from panel
    → cell-type proportions per spot (needs scRNA ref)     |
-----------------------------------------------------------|---------------------------------------------------------
 7. (multi-sample) align + integrate                       |  7. (multi-sample) align + integrate
    PASTE/PASTE2/STalign + Harmony/scVI                    |     PASTE/STalign + Harmony/scVI/Crescendo
===========================================================|=========================================================
 → analysis-ready AnnData/SpatialData/Seurat/SPE  ────────────────►  spatially-aware ANALYSIS (OUT OF SCOPE):
   normalized expr + spatial coords + images + (imaging) segmentation   SVGs, spatial domains, neighborhoods, CCC
```

---

## 13. Master tool table

| Tool | Platform(s) | Step | Ecosystem | Ref |
|---|---|---|---|---|
| Space Ranger | Visium, Visium HD | align/count, fiducial+tissue align, binning | 10x CLI | 10x support |
| Xenium Onboard Analysis (XOA) | Xenium | decode + default segmentation | 10x on-instrument | 10x support |
| xeniumranger | Xenium | re-segment / import segmentation | 10x CLI | 10x support |
| MERSCOPE pipeline + **VPT** | MERFISH | decode + (re)segment (Cellpose) | Vizgen CLI | github.com/Vizgen/vizgen-postprocessing |
| AtoMx SIP | CosMx | decode + segment + analysis (no-code) | NanoString/Bruker | nanostring KB |
| **SAW** / Stereopy | Stereo-seq | align/count, CellBin, GEF/GEM, bin/cell | STOmics | stomics.tech / stereopy |
| Curio Seeker | Slide-seq/Curio | bead align/count | Curio | — |
| **GeomxTools** / standR | GeoMx DSP | ROI QC + Q3/background norm | Bioconductor | github.com/Nanostring-Biostats/GeomxTools |
| **squidpy** / scanpy | Visium, Xenium, Vizgen, CosMx | import + QC + spatial graph | Python/scverse | squidpy.readthedocs.io |
| **SpatialData** / spatialdata-io | all major | unified container + readers | Python/scverse | spatialdata.scverse.org |
| **sopa** | Xenium/HD/MERSCOPE/CosMx/PhenoCycler | segment + aggregate + object (scale) | Python (SpatialData) | Nat Commun 2024; github.com/gustaveroussy/sopa |
| **Bento** | MERFISH/seqFISH+/Xenium | subcellular QC + patterns | Python/scverse | bento-tools.readthedocs.io |
| **Seurat** (`Load10X_Spatial`/`LoadXenium`/`LoadNanostring`) | Visium, Xenium, CosMx | import + SCTransform + viz | R | satijalab.org/seurat |
| **semla** (ex-STUtility) | Visium | import + registration + annotation | R (Seurat) | Bioinformatics 2023 |
| **SpatialExperiment** + VisiumIO/XeniumIO/SFE + **Voyager** | all major | import + geometries + ESDA/QC | Bioconductor | OSTA book |
| **Giotto** (Suite) | all major | import + QC + norm + multimodal | R | giottosuite.com |
| **Cellpose** | imaging | image segmentation (generalist) | Python | cellpose |
| **StarDist** | imaging, HD (bin2cell) | nucleus segmentation (star-convex) | Python | stardist.net |
| **Baysor** | MERFISH/Xenium/CosMx/Stereo | transcript-aware segmentation | Julia | Nat Biotechnol 2021 |
| **proseg** | Xenium/CosMx/MERSCOPE/HD | probabilistic transcript segmentation | Rust | Nat Methods 2025 |
| **bin2cell** | Visium HD | segment HD 2µm → cells (StarDist) | Python | Bioinformatics 2024 |
| **cell2location** | spot data | deconvolution (absolute abundance) | Python | Nat Biotechnol 2022 |
| **RCTD** (spacexr) | spot data (Visium/Slide-seq) | deconvolution (doublet/full mode) | R | Nat Biotechnol 2022 |
| **SPOTlight** | spot data | deconvolution (NMF) | R | — |
| **stereoscope / DestVI** | spot data | deconvolution (NB / VAE) | Python (scvi) | — |
| **Tangram** | Visium + imaging | scRNA→spatial mapping / imputation | Python | Nat Methods 2021 |
| **CARD / SpatialDWLS / STdeconvolve** | spot data | deconvolution (spatial / DWLS / ref-free) | R | — |
| **PASTE / PASTE2** | any spot/imaging | slice alignment + 3D | Python | Genome Res 2022/2023 |
| **GPSA / STalign / Eggplant** | any | multi-slice alignment / common frame | Python | — |
| **Harmony / scVI / scANVI / Crescendo** | multi-sample spatial | batch integration | R/Python | sc-best-practices |

---

## Sources

- <https://www.sc-best-practices.org/spatial/introduction.html> — Single-cell best practices: spatial intro (two families, why spatial differs).
- <https://www.sc-best-practices.org/spatial/deconvolution.html> — SC best practices ch.32: spot deconvolution methods, cell2location prep, RCTD/SpatialDWLS accuracy, scRNA-reference role.
- <https://bioconductor.org/books/release/OSTA/> — OSTA book (Orchestrating Spatially-resolved Transcriptomics Analysis), Bioconductor.
- <https://bioconductor.org/books/release/OSTA/pages/bkg-importing-data.html> — OSTA: SpatialExperiment class, VisiumIO/XeniumIO/SpatialExperimentIO/SFE readers, where coords/images land.
- <https://bioconductor.org/books/release/OSTA/pages/img-segmentation.html> — OSTA ch.18: segmentation methods + QC.
- <https://bioconductor.org/books/release/OSTA/pages/seq-deconvolution.html> — OSTA ch.12: deconvolution.
- <https://squidpy.readthedocs.io/en/stable/notebooks/tutorials/index.html> — squidpy tutorials (Visium, Xenium, Vizgen/MERFISH, Nanostring); read.visium/vizgen/nanostring, spatial neighbor graphs.
- <https://squidpy.readthedocs.io/en/stable/notebooks/tutorials/tutorial_xenium.html> — squidpy Xenium tutorial (uses spatialdata-io reader).
- <https://spatialdata.scverse.org/projects/io/en/latest/> — spatialdata-io readers list (visium, visium_hd, xenium, merscope, cosmx, curio, stereoseq, dbit, seqfish, multiplex) + parse→Zarr idiom.
- <https://github.com/scverse/spatialdata-io> — spatialdata-io source/readers.
- <https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview> — Space Ranger Visium outputs: filtered/raw h5+mtx, spatial/ folder, tissue_positions, scalefactors_json, images, CytAssist.
- <https://www.10xgenomics.com/analysis-guides/segmentation-visium-hd> — Visium HD 2µm grid, 8/16µm binning, bin = UMI sum; nuclei segmentation + custom binning.
- <https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/segmented-outputs> — Space Ranger v4 H&E-segmented cell outputs + barcode_mappings.parquet (2µm→8/16µm→Cell_id).
- <https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/algorithms-overview/segmentation> — Xenium nucleus detection, 5µm expansion, multimodal (boundary/interior/DAPI) segmentation, cells.zarr.zip outputs.
- <https://www.10xgenomics.com/support/software/xenium-ranger/latest/analysis/running-pipelines/XR-resegment> — xeniumranger resegment / import-segmentation.
- <https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/advanced/metric-calculations> — Xenium negative-control metric calculations (neg control probe rate, false-positive tx/cell).
- <https://www.10xgenomics.com/analysis-guides/unveiling-xenium-multimodal-cell-segmentation> — Xenium multimodal segmentation (ATP1A1/CD45/E-Cadherin → 18S rRNA → DAPI).
- <https://www.10xgenomics.com/analysis-guides/using-baysor-to-perform-xenium-cell-segmentation> — Baysor on Xenium (import-segmentation, capturing unassigned transcripts).
- <https://elifesciences.org/reviewed-preprints/107070> — off-target probe binding may make blanks/negative controls underestimate Xenium FDR.
- <https://vizgen.github.io/vizgen-postprocessing/> and <https://github.com/Vizgen/vizgen-postprocessing> — VPT (re-segment MERSCOPE, Cellpose/Cellpose2 plugin, retrain, transcript→entity assignment).
- <https://nanostring.com/support/knowledgebase/cosmx-smi-data-analysis/> — CosMx SMI export (flat files/Seurat/TileDB), AtoMx SIP.
- <https://github.com/cancerbioinformatics/CosMx_Lite> — CosMx flat-file analysis (5 flat files).
- <https://en.stomics.tech/news/stomics-blog/1108.html> — Stereo-seq SAW outputs, CellBin, GEF vs GEM.
- <https://stereopy.readthedocs.io/> — Stereopy: GEF/GEM reader, square-bin vs cell-bin.
- <https://github.com/Nanostring-Biostats/GeomxTools> and <https://davislaboratory.github.io/GeoMXAnalysisWorkflow/> — GeoMx DCC/PKC → NanoStringGeoMxSet, Q3/background norm, standR.
- <https://satijalab.org/seurat/articles/spatial_vignette.html> — Seurat spatial: Load10X_Spatial, SCTransform recommendation for Visium, SpatialFeaturePlot.
- <https://satijalab.org/seurat/articles/seurat5_spatial_vignette_2> — Seurat imaging spatial: LoadXenium/LoadNanostring, negative-control assays.
- <https://satijalab.org/seurat/articles/visiumhd_analysis_cell_segmentations> — Seurat Visium HD with cell segmentations.
- <https://academic.oup.com/bioinformatics/article/39/10/btad626/7319366> — semla (successor to STUtility) toolkit.
- <https://giottosuite.com/> and <https://genomebiology.biomedcentral.com/articles/10.1186/s13059-021-02286-2> — Giotto: createGiottoObject, filterGiotto, normalizeGiotto, multimodal.
- <https://pachterlab.github.io/voyager/> — Voyager ESDA/QC on SpatialFeatureExperiment (Xenium/Visium vignettes).
- <https://bento-tools.readthedocs.io/> and <https://genomebiology.biomedcentral.com/articles/10.1186/s13059-024-03217-7> — Bento subcellular toolkit + subcellular QC (AnnData/scverse).
- <https://www.nature.com/articles/s41467-024-48981-z> and <https://github.com/gustaveroussy/sopa> — sopa technology-invariant SpatialData pipeline (Cellpose/Baysor at scale).
- <https://stardist.net/> and <https://arxiv.org/abs/1806.03535> — StarDist star-convex polygon nucleus detection.
- Cellpose — generalist flow-based segmentation (referenced via VPT docs above).
- <https://kharchenkolab.github.io/Baysor/dev/segmentation/> — Baysor transcript-density segmentation, prior-guided mode.
- <https://github.com/dcjones/proseg> and <https://www.nature.com/articles/s41592-025-02697-0> — proseg probabilistic (Cellular-Potts) transcript segmentation, multi-platform.
- <https://academic.oup.com/bioinformatics/article/40/9/btae546/7754061> — bin2cell: StarDist nuclei + label expansion + PCA assignment for Visium HD.
- <https://academic.oup.com/bioinformatics/article/41/3/btaf094/8063614> — ENACT end-to-end Visium HD analysis (alt to bin2cell).
- <https://cell2location.readthedocs.io/en/latest/notebooks/cell2location_tutorial.html> — cell2location: NB hierarchical model, N_cells_per_location, detection_alpha, absolute abundance.
- <https://github.com/dmcable/spacexr> and <https://www.nature.com/articles/s41587-021-00830-w> — RCTD/spacexr doublet/full/multi modes, platform-effect correction.
- <https://elifesciences.org/articles/88431> — Spotless benchmark of deconvolution methods (cell2location/RCTD/SPOTlight top-tier).
- <https://academic.oup.com/bioinformatics/article/39/1/btac805/6900924> — deconvolution benchmarking (11 methods) + integration.
- <https://www.nature.com/articles/s41592-021-01264-7> — Tangram mapping (Visium + imaging; imputation, panel correction).
- <https://github.com/raphael-group/paste2> and <https://genome.cshlp.org/content/33/7/1124> — PASTE2 partial alignment + 3D reconstruction of slices.
- <https://www.cell.com/cell-systems/fulltext/S2405-4712(25)00097-3> — STalign diffeomorphic ST alignment.
- <https://genomebiology.biomedcentral.com/articles/10.1186/s13059-024-03303-w> — Atta/Fan: gene-count normalization in imaging-based SRT (targeted-panel bias, volume normalization, <10 tx/cell filter, MERFISH blanks).
- <https://link.springer.com/article/10.1186/s13059-025-03479-9> — Crescendo batch correction for imaging spatial count data.

---

**Cross-refs (do not duplicate here):** `01-file-formats.md` — Zarr/OME-NGFF, GEF/GEM,
Xenium `cells.zarr.zip`, Visium `scalefactors_json.json` internals. `02-platforms.md` —
platform chemistry, resolution, panel sizes, throughput. `04`/`05` — the base
scRNA-seq processing steps (QC, normalization, HVG, integration) that spatial reuses
with the caveats above. **Boundary out:** SVG detection, spatial domains,
neighborhood/niche, cell-cell communication (spatial-aware *analysis*).
