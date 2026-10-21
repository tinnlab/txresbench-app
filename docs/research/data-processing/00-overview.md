# Single-Cell + Spatial Transcriptomics **Data Processing** — Research Folder

> **Scope:** RAW DATA → **ANALYSIS-READY DATA**. This folder maps *everything*
> involved in taking single-cell **and** spatial transcriptomic data from the
> instrument to a QC'd, normalized, batch-corrected object that is ready for the
> first biological question — and it **stops there**. Downstream *analysis*
> (clustering, differential expression, embedding-for-annotation, trajectory,
> spatially-variable genes, niche/communication) is **out of scope** and appears
> only as the boundary line.
>
> **Audience:** a working scientist who needs a reference, *and* a future
> implementer building a data-processing product on top of this landscape.

---

## 1. What "data processing" means here

Between a sequencer/imager and an analysis lies a pipeline that is easy to
under-estimate. The raw output is never analysis-ready: it carries **empty
droplets**, **ambient (background) RNA**, **doublets**, **low-quality/dying
cells**, **technical depth differences**, and **batch effects** — and for spatial
data, **un-segmented molecule clouds** and **mixed-cell spots**. "Data processing"
is the disciplined removal/correction of those artifacts plus the transforms
(normalization, feature selection, dimensionality reduction, integration) that put
every cell on a comparable footing.

The canonical flow (single-cell; spatial adds/reorders steps — see doc `06`):

```
        ┌─────────────────────────────────────────────────────────────────────┐
 RAW    │  FASTQ ──▶ align + quantify ──▶ (aggregate) ──▶ count matrix          │
        │  Cell Ranger / STARsolo / alevin-fry / kb   (raw + filtered)          │
        └─────────────────────────────────────────────────────────────────────┘
                                        │
        ┌───────────────────────────────▼─────────────────────────────────────┐
 CLEAN  │  import ─▶ empty-droplet call ─▶ ambient-RNA removal ─▶ QC metrics ─▶  │
        │  QC filter ─▶ doublet detection            (all PER-SAMPLE)           │
        └───────────────────────────────┬─────────────────────────────────────┘
                                        │  merge samples
        ┌───────────────────────────────▼─────────────────────────────────────┐
 XFORM  │  normalize ─▶ select HVGs ─▶ (scale / regress) ─▶ PCA ─▶ INTEGRATE    │
        └───────────────────────────────┬─────────────────────────────────────┘
                                        ▼
                      ★ ANALYSIS-READY  ★  (normalized counts + HVGs +
                        batch-corrected latent space + coords/images if spatial)
                                        ┊
                        ┈┈┈┈┈  (out of scope: clustering, DE, …)  ┈┈┈┈┈
```

Two things make the space large: (a) the **combinatorial matrix** of *platforms ×
modalities × file formats × tools*, and (b) the fact that almost every step has
**multiple defensible tools and parameter regimes with real tradeoffs** — there is
rarely one right answer, so the reference has to enumerate the options and what the
benchmarks say.

---

## 2. The two ecosystems

Essentially all processing happens in one of two software worlds; most concepts map
1:1 between them, and this folder documents both side by side.

| | **Python / scverse** | **R / Seurat + Bioconductor** |
|---|---|---|
| Core object | `AnnData` (`.h5ad`), `MuData` (`.h5mu`) | `Seurat` (`.rds`), `SingleCellExperiment`/`SpatialExperiment` |
| Matrix orientation | **cell × gene** | **gene × cell** |
| Preprocessing | **Scanpy** (`sc.pp.*`) | **Seurat** (`NormalizeData`/`SCTransform`/…), **scran/scater** |
| Integration | Harmony (harmonypy), **scVI/scANVI** (scvi-tools), BBKNN, Scanorama | Seurat CCA/RPCA, **Harmony**, fastMNN (batchelor), LIGER |
| Spatial | **squidpy**, **SpatialData**, Bento | Seurat spatial, **SpatialExperiment/Voyager**, **Giotto**, semla |
| Best-practice bible | **sc-best-practices.org** | **OSCA** / **OSTA** (Bioconductor books) |

The **legacy reference pipeline** this research grounds (`sc-website-scripts`, doc
`07`) sits firmly in the **R/Seurat** world and is deliberately WASM-capable
(runs R in the browser), which shaped several of its choices.

---

## 3. How to read this folder

Each doc is self-contained and cross-links the others. Suggested reading order
depends on your goal:

| Doc | What it answers | Read it when you need… |
|---|---|---|
| **`00-overview.md`** (this) | The map + how the pieces fit | Orientation, the big picture, navigation |
| **`01-file-formats.md`** | Every format and its **internal structure** | To read/write mtx, 10x `.h5`, `.h5ad`, `.rds`/SCE, `.loom`, Zarr, MuData, SOMA, and every spatial bundle |
| **`02-platforms.md`** | Every **platform** and what data it produces | To know what a given instrument outputs and its chemistry constraints |
| **`03-modalities.md`** | Every **modality** (scRNA/snRNA/CITE/HTO/ATAC/multiome/VDJ/perturb/velocity/spatial) and how it changes processing | To handle protein/ATAC/nuclei/hashing/guides, not just plain scRNA |
| **`04-pipeline-steps.md`** | The **step-by-step story** raw→analysis-ready: what people do, in what order, and why | To understand the workflow logic and decision points |
| **`05-tools-and-parameters.md`** | Per step: **tools + parameters + typical values + benchmark verdicts** | To pick a tool and set its knobs; the cheat-sheet |
| **`06-spatial-processing.md`** | **Spatial-specific** processing (vendor pipelines, segmentation, spatial QC, deconvolution, registration, binning) | To process Visium/Xenium/MERFISH/CosMx/Slide-seq/Stereo-seq |
| **`07-sc-website-scripts-digest.md`** | What the **legacy** reference pipeline actually does + a gap analysis | To extend/replace the existing pipeline |
| **`08-references.md`** | The consolidated, categorized **bibliography** | To go to primary sources |

**Fast paths:**
- *"I just need to process a 10x scRNA run."* → `04` (steps) + `05` (params); glance
  at `01` (formats) for import.
- *"I have a Xenium / Visium HD run."* → `06` (spatial) + `02` (platform) + `01`
  (spatial formats).
- *"I'm building the pipeline into a product."* → `07` (legacy baseline + gaps) →
  `04`/`05` (what to add) → `01`/`03` (formats/modalities to support).

---

## 4. Cross-cutting themes (traps that recur in every doc)

These come up repeatedly and are worth internalizing before diving in:

1. **Raw vs. filtered matrix.** The vendor emits both a *raw* (all barcodes) and a
   *filtered* (called-cells) matrix. **Empty-droplet** and **ambient-RNA**
   correction (CellBender/SoupX/DecontX) need the **raw** matrix (or
   `molecule_info.h5`) — never the filtered one. Starting from filtered silently
   forecloses those steps (this is exactly what the legacy pipeline does — see `07`).
2. **Matrix orientation.** AnnData/Scanpy/MuData are **cell × gene**;
   MEX/10x-`.h5`/Loom/SCE/Seurat are **gene × cell**. Every cross-ecosystem loader
   transposes; getting this wrong silently corrupts everything.
3. **Targeted vs. whole-transcriptome.** Probe-based assays (10x Flex, Visium
   FFPE/HD, all imaging platforms — Xenium/MERFISH/CosMx) have **no intronic reads,
   no RNA velocity, no novel-transcript discovery, and no genome-wide % mito QC** —
   spatial-imaging QC uses **negative-control/blank codewords** instead. Poly(dT)
   assays keep all of that.
4. **Per-sample before merge.** Doublet detection, QC filtering, and ambient
   correction are done **per library/sample**, *then* samples are merged and
   *then* integrated. Doing them on a pooled object leaks batch structure into the
   estimates.
5. **Integration is conditional.** Batch correction is applied only when there is a
   real batch/technical effect to remove; over-correction erodes biology. The
   scIB/Luecken-2022 benchmark is the guide (`05`, §11).
6. **Modality branches the path.** snRNA (introns + low-mito), CITE (CLR/DSB), ATAC
   (TF-IDF/LSI), multiome (WNN), hashing/genetic-demux/guides/lineage (a
   *classification* step joined onto the matrix, not a normalized feature) — each
   inserts or swaps steps (`03`).
7. **"No universal best."** For normalization and integration especially, the
   literature is explicit that the right choice is dataset- and task-dependent;
   `05` gives the benchmark verdicts and decision matrices rather than a single
   winner.

---

## 5. The legacy pipeline in one line (and why this research exists)

The reference `sc-website-scripts` pipeline (doc `07`) is a **minimal Seurat-5
path**: *import (10x/AnnData) → compute mito/ribo % → manual per-sample min/max QC
filter → `log2(x+1)`*. It performs **none** of empty-droplet calling, ambient-RNA
removal, doublet detection, principled normalization (SCTransform/scran/Pearson),
adaptive QC, or in-step integration, and has **no spatial support at all**. Docs
`04`–`06` are, in effect, the specification of everything a modern "raw →
analysis-ready" pipeline should add on top of that baseline — which is why `07`
ends with an explicit gap-analysis table keyed to those docs.

---

## 6. Provenance

This folder was produced as a research-only deliverable (no code, no lifecycle
gate). The step-and-tool content is synthesized from primary sources —
**sc-best-practices.org**, Bioconductor **OSCA**/**OSTA**, **Scanpy** & **Seurat**
& **scran/scater** documentation, **10x Genomics** Cell Ranger / Space Ranger /
Xenium docs, the individual **tool papers and docs**, and the major **benchmark
papers** (Luecken 2022 integration; Xi & Li 2021 doublets; Ahlmann-Eltze & Huber
2023 normalization; Germain 2020; Tran 2020; Fleming 2023 CellBender; Young &
Behjati 2020 SoupX; Spotless deconvolution). Every doc carries its own inline
citations and a `## Sources` list; `08-references.md` consolidates them by
category. The legacy digest (`07`) is grounded in a direct reading of the
`sc-website-scripts` source.
