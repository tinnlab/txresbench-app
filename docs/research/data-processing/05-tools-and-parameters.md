# 05 — Per-Step Tool + Parameter Cheat-Sheet

> **Scope.** This is the "which tool, which knob, what value" reference for
> single-cell + spatial transcriptomics **data processing**. For each step it
> catalogs the candidate tools, their **key parameters (with software defaults
> and typical community values)**, the tradeoffs / when-to-use, and the
> **benchmark verdict**. The step *narrative / why-you-do-it* lives in sibling
> `04-pipeline-steps.md`; spatial specifics live in `06`. This doc owns the
> concrete tools, params, numbers, and benchmarks.
>
> **How to read the tables.** Every parameter is written `name (default →
> typical/range, what it does)`. "**default**" = the value the software ships
> with (pulled from primary docs); "**typical**" / "**community**" = the value
> practitioners actually use, which may differ from the default. Where a value
> could not be pinned from a primary doc it is marked `(verify)`.
>
> **Convention shorthand.** Py = Python/scanpy/scverse ecosystem; R =
> R/Bioconductor/Seurat; CLI = standalone command-line binary.

---

## 1. Alignment / Quantification (FASTQ → count matrix)

This is the single most consequential step for reproducibility: the choice of
aligner and its cell-calling flags changes the count matrix that every
downstream step consumes. The four production tools are **Cell Ranger** (the
10x reference, full alignment), **STARsolo** (open-source, splice-aware, drop-in
Cell Ranger emulation), **salmon alevin-fry / simpleaf** (selective-alignment,
memory-frugal), and **kb-python / kallisto|bustools** (pseudoalignment,
fastest).

### 1a. Cell Ranger `count` / `multi` (CLI, 10x proprietary)

| Parameter | Default → typical, what it does |
|---|---|
| `--transcriptome` | **required** → path to a 10x-compatible reference (e.g. `refdata-gex-GRCh38-2024-A`). Determines gene model + genome build. |
| `--fastqs` / `--sample` | **required** → input FASTQ dir + sample prefix. |
| `--expect-cells` | auto-estimated (v7+) → set only to replicate a prior run or when auto-calling is off. Feeds the cell-calling prior, **not** a hard cap. |
| `--force-cells` | off → integer; **bypasses** the EmptyDrops cell caller and takes exactly the top-N barcodes by UMI. Use only when auto-calling fails. |
| `--include-introns` | **`true`** (default since **v7.0**) → set `false` to count exonic reads only. Intronic counting is standard now, especially for single-nucleus. |
| `--chemistry` | **`auto`** → `auto` detects; force with `threeprime`, `fiveprime`, `SC3Pv2`/`SC3Pv3`/`SC3Pv4`, `SC5P-R2`, etc. Only override when auto-detect fails on shallow data. |
| `--create-bam` | **required in v8** (`true`/`false`; replaced the old `--no-bam`) → `false` saves large I/O when a BAM isn't needed downstream. |
| `--nosecondary` | off (flag) → disables clustering/UMAP/t-SNE + the `.cloupe` file. Set it when you only want the raw/filtered matrices (you'll re-cluster yourself). |
| `--r1-length` / `--r2-length` | full → hard-trim reads to N bases (rarely needed). |
| `--nosecondary`, `--no-libraries`, `--localcores`, `--localmem` | resource + output toggles. |

`cellranger multi` is the superset pipeline for multiplexed / multi-modal runs
(CellPlex/HTO demux, Antibody Capture/CITE-seq, VDJ, Flex probe sets); it is
driven by a `--csv` config that names per-library `[gene-expression]`,
`[feature]`, `[vdj]` sections rather than bare flags. Use `multi` for any
hashed/feature-barcoded/Flex experiment; `count` for a plain single 3'/5' GEX
library.

- Docs: [Cell Ranger command-line arguments (8.0)](https://www.10xgenomics.com/support/software/cell-ranger/8.0/resources/cr-command-line-arguments) · [`count` pipeline](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/running-pipelines/cr-gex-count)

### 1b. STARsolo (CLI, open-source — the Cell Ranger emulator)

STARsolo is a mode of the STAR aligner. Its **defaults reproduce Cell Ranger
2.x**; a specific flag set is required to match Cell Ranger ≥3.x/4.x (the
version most people compare against). This is the crux of using STARsolo.

| Parameter | Default → typical, what it does |
|---|---|
| `--soloType` | `None` → **`CB_UMI_Simple`** for 10x (one CB + one UMI of fixed length in R1). Other: `CB_UMI_Complex` (multi-segment CB, e.g. inDrop), `SmartSeq`, `CB_samTagOut`. |
| `--soloCBwhitelist` | `-` (all) → path to the 10x barcode whitelist (`3M-february-2018.txt` for v3, `737K-august-2016.txt` for v2). `None` for whitelist-free. |
| `--soloCBstart/--soloCBlen/--soloUMIstart/--soloUMIlen` | CB start 1, **CBlen 16**, UMIstart 17, **UMIlen 10** → set **`--soloUMIlen 12`** for 10x **v3** (v2 uses 10). Wrong UMI length silently corrupts dedup. |
| `--soloFeatures` | **`Gene`** → `Gene GeneFull SJ Velocyto` (space-separated, combinable in one run). `GeneFull` = pre-mRNA/intron-inclusive (single-nucleus / to match CR `--include-introns`); `Velocyto` emits spliced/unspliced/ambiguous for RNA velocity; `SJ` = splice junctions. |
| `--soloCBmatchWLtype` | **`1MM_multi`** → **`1MM_multi_Nbase_pseudocounts`** to match CR ≥3.0. Controls how a 1-mismatch barcode is corrected to the whitelist. |
| `--soloUMIdedup` | **`1MM_All`** → **`1MM_CR`** to match CR (the "CellRanger 2-4" 1-mismatch UMI collapse). Other: `Exact`, `NoDedup`, `1MM_Directional`. |
| `--soloUMIfiltering` | **`-`** (basic: drop N/homopolymer UMIs) → **`MultiGeneUMI_CR`** to match CR ≥3.0 (removes lower-count UMIs mapping to >1 gene). |
| `--soloCellFilter` | **`CellRanger2.2 3000 0.99 10`** → **`EmptyDrops_CR`** to match CR ≥3.0's EmptyDrops caller. Also `None` (emit raw), `TopCells N`. |
| `--clipAdapterType` / `--outFilterScoreMin` | STAR defaults → add **`--clipAdapterType CellRanger4`** + **`--outFilterScoreMin 30`** to match CR **4.x/5.x** read trimming. |
| `--soloBarcodeReadLength` | 1 (check R1 length) → set `0` to disable the length check for non-standard R1. |

**The canonical "reproduce Cell Ranger" flag block:**

```bash
# Match Cell Ranger 3.x:
--soloType CB_UMI_Simple --soloCBwhitelist 3M-february-2018.txt \
--soloUMIlen 12 \
--soloCBmatchWLtype 1MM_multi_Nbase_pseudocounts \
--soloUMIfiltering MultiGeneUMI_CR \
--soloUMIdedup 1MM_CR \
--soloCellFilter EmptyDrops_CR

# Match Cell Ranger 4.x / 5.x: add
--clipAdapterType CellRanger4 --outFilterScoreMin 30
```

The `EmptyDrops_CR` filter takes 10 positional numbers whose defaults mirror
Cell Ranger: `nExpectedCells 3000, maxPercentile 0.99, maxMinRatio 10, indMin
45000, indMax 90000, umiMin 500, umiMinFracMedian 0.01, candMaxN 20000, FDR
0.01, simN 10000`.

- Docs: [STARsolo manual (GitHub master)](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md)

### 1c. salmon **alevin-fry** / **simpleaf** (CLI, selective-alignment)

alevin-fry is a two-binary pipeline: `salmon alevin` (RAD mapping) →
`alevin-fry` (`generate-permit-list` → `collate` → `quant`). **simpleaf** wraps
all of it (`simpleaf index`, `simpleaf quant`) into one ergonomic command and is
the recommended entry point. `pyroe` / the `fry` R helpers load the USA-mode
output into AnnData / SCE.

**`alevin-fry generate-permit-list` (cell calling):**

| Parameter | Default → typical, what it does |
|---|---|
| `--expected-ori` | **required** → `fw` / `rc` / `both`(`either`). Read orientation vs. the transcriptome; wrong value ⇒ near-empty matrix. For 10x 3' use `fw`; simpleaf sets this for you from `--chemistry`. |
| `--unfiltered-pl` | off → supply the **external 10x whitelist**; counts exact matches, then corrects edit-distance-1 barcodes to present cells. The **recommended** modern path (analogous to STARsolo's whitelist correction). |
| `--knee-distance` | off → **data-driven knee** on the barcode-rank curve (no external list). |
| `--expect-cells` / `--force-cells` | off → prior N cells / hard top-N (mirror Cell Ranger's two knobs). |
| `--valid-bc` / `--min-reads` | filtering thresholds for the permit list. |

**`alevin-fry quant` (UMI resolution):**

| Parameter | Default → typical, what it does |
|---|---|
| `--resolution` | (no silent default; **`cr-like`** is the Cell-Ranger-comparable choice) → `cr-like` (tie-break by UMI frequency, discard ambiguous), `cr-like-em` (EM over equal-frequency genes instead of discarding), `parsimony`/`parsimony-em` (`full`) (graph-parsimony over the PUG, EM-resolve remainder), `trivial`. **USA-mode supports only `cr-like` / `cr-like-em`.** |
| `--use-mtx` | on (MatrixMarket is default) → output format. |
| `--umi-edit-dist` | 1 for parsimony modes, 0 otherwise → Hamming distance for UMI collapse. |
| `-b/--num-bootstraps`, `-d/--dump-eqclasses`, `--summary-stat` | inferential / diagnostic outputs. |

**USA mode** ("Unspliced-Spliced-Ambiguous") is enabled by a **3-column t2g**
(transcript, gene, status) built by `simpleaf index --ref-type spliced+intron`
(a.k.a. `splici`). It tags every UMI as spliced / unspliced / ambiguous in ONE
quant, giving both a standard gene matrix and the spliced/unspliced layers RNA
velocity needs — the alevin-fry analog of STARsolo `Velocyto` / kb `nac`.

- Docs: [alevin-fry `quant`](https://alevin-fry.readthedocs.io/en/latest/quant.html) · [`generate-permit-list`](https://alevin-fry.readthedocs.io/en/latest/generate_permit_list.html) · [simpleaf](https://simpleaf.readthedocs.io/en/latest/quant-command.html)

### 1d. **kb-python** / kallisto | bustools (CLI/Py, pseudoalignment — fastest)

Two commands: `kb ref` builds the index; `kb count` pseudoaligns + counts.

| Parameter | Default → typical, what it does |
|---|---|
| `kb ref -i -g -f1 ...` | build the kallisto index + t2g. Add `--workflow nac` to build a nascent+mature (spliced/unspliced) index. |
| `kb count -x` | **required** → technology string: `10xv2`, `10xv3`, `10xv1`, `10xFB`, `SPLIT-SEQ`, or an explicit `bc:umi:seq` triple. `10xv3` ⇒ 16 bp CB + 12 bp UMI in R1. |
| `--workflow` | **`standard`** → `nac` (nascent+mature, **the current name**; quantifies unspliced+spliced for velocity / single-nucleus), `lamanno` (the **older** velocity workflow name, superseded by `nac`), `nucleus`, `kite`/`kite:10xFB` (feature barcoding). |
| `--filter` | off → **`bustools`** applies the knee-based barcode filter and emits a `counts_filtered/` matrix alongside `counts_unfiltered/`. |
| `-g` / `-t2g` | transcript-to-gene map (from `kb ref`). |
| `-m` | **`4G`** → max memory. |
| `-w` | auto (per-technology whitelist bundled) → override barcode whitelist. |
| `--h5ad` / `--loom` | off → also emit AnnData `.h5ad` (scanpy) / `.loom`. |

- Docs: [kb-python GitHub](https://github.com/pachterlab/kb_python) · [kallisto|bustools docs](https://kallisto.readthedocs.io/en/latest/manuals/kb.html) · method paper [Sullivan et al. 2023, PMC10690192](https://pmc.ncbi.nlm.nih.gov/articles/PMC10690192/)

### 1e. Space Ranger (CLI — Visium spatial; brief, see `06`)

`spaceranger count` mirrors `cellranger count` plus imaging. Key extras:
`--probe-set` (the CSV probe reference for FFPE/Visium-CytAssist), `--image` /
`--darkimage` / `--colorizedimage` (the tissue microscopy input),
`--cytassist` (the CytAssist alignment image), `--slide` + `--area` (capture-area
geometry), `--loupe-alignment` (manual fiducial alignment JSON). Defer full
treatment to `06-spatial-processing.md`.

- Docs: [Space Ranger command-line args](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/running-pipelines/command-line-arguments)

### Benchmark verdict — quantifiers

> **Speed / memory.** kallisto|bustools and alevin-fry are the fastest and most
> memory-frugal; STARsolo, alevin, and kallisto are all **≥3× faster than Cell
> Ranger 6**, with kallisto typically **4–6× faster**. alevin-fry's "sketch"
> mode is faster than kallisto|bustools and uses less peak memory; it handles
> single-nucleus data at the same speed/memory as single-cell (a place STARsolo
> and kb slow down). ([He et al. 2022, *alevin-fry*, PMC8933848](https://pmc.ncbi.nlm.nih.gov/articles/PMC8933848/); [Kaminow et al. STARsolo / like-for-like preprint](https://www.biorxiv.org/content/10.1101/2021.02.10.430656.full.pdf))
>
> **Concordance / accuracy.** STARsolo with the Cell-Ranger-emulation flags is
> the closest match to Cell Ranger (near-identical count matrices). alevin-fry
> and kallisto reach the **highest transcriptome mapping rates**; on RNA-velocity
> fidelity, alevin-fry best delineated developmental trajectories, STARsolo
> recapitulated most biology, and kallisto|bustools recovered only parts — so for
> velocity the spliced/unspliced quantifier matters. In general the four tools
> are **highly concordant on well-expressed genes**; they diverge most on
> low-count barcodes and multi-mapping/ambiguous reads (exactly where the
> cell-calling + UMI-resolution flags bite).
>
> **Practical rule.** Match an existing 10x study → Cell Ranger or STARsolo-emulation.
> Big cohort / limited RAM → alevin-fry (simpleaf) or kb. Need spliced/unspliced
> → STARsolo `Velocyto`, alevin-fry USA-mode, or kb `nac`.

---

## 2. Import (count matrix → in-memory object)

| Tool | Eco | Key call / params | When to use | Ref |
|---|---|---|---|---|
| `sc.read_10x_mtx(path, var_names='gene_symbols', make_unique=True, cache=True)` | Py | reads a CellRanger `filtered/raw_feature_bc_matrix/` dir (`matrix.mtx.gz`+`features.tsv.gz`+`barcodes.tsv.gz`). `var_names` picks symbol vs. Ensembl ID. | Default scanpy entry from CR output. | [scanpy read](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.read_10x_mtx.html) |
| `sc.read_10x_h5(filename, genome=None, gex_only=True)` | Py | reads the single-file `*_feature_bc_matrix.h5`. `gex_only=False` to keep Antibody/CRISPR features. | HDF5 single-file CR output; multimodal. | scanpy |
| `sc.read_h5ad` / `ad.read_h5ad` | Py | load a serialized AnnData. | Resume / share processed objects. | anndata |
| `Read10X(data.dir)` / `Read10X_h5(filename)` | R | Seurat readers for the mtx dir / `.h5`; wrap in `CreateSeuratObject(counts, min.cells=3, min.genes=200)`. | Seurat entry. | [Seurat Read10X](https://satijalab.org/seurat/reference/read10x) |
| `DropletUtils::read10xCounts(samples, col.names=TRUE)` | R | builds a `SingleCellExperiment`; can read **multiple** sample dirs into one SCE; reads the **raw** (unfiltered) matrix for `emptyDrops`. | Bioconductor entry; needed before empty-drop calling. | [DropletUtils](https://bioconductor.org/packages/DropletUtils) |

**Gotcha:** `read_10x_mtx`/`read10xCounts` on the **`raw`** matrix give all
~700k–6M barcodes (needed for empty-drop calling); the **`filtered`** matrix is
already cell-called by the aligner. Know which one you loaded.

---

## 3. Empty-droplet calling (raw matrix → real cells)

Distinguishes barcodes containing a cell from barcodes containing only ambient
soup. Only relevant when you start from the **raw/unfiltered** matrix; if you
took the aligner's **filtered** matrix, this was already done for you (by
EmptyDrops_CR inside Cell Ranger / STARsolo).

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| `DropletUtils::emptyDrops(m, ...)` | R | `lower` (**100** → UMI total at/below which a barcode is assumed empty & used to estimate the ambient profile), `niters` (**10000** → Monte-Carlo p-value iterations; raise if many p-values hit the `Limited` cap), `test.ambient` (**FALSE**), `retain` (**NULL** → auto = knee point; barcodes above it are always cells), `ignore` (**NULL**), `alpha` (**NULL** → MLE of the Dirichlet overdispersion), `round` (**TRUE**). Then **filter `FDR ≤ 0.001`** (community standard; stricter than 0.01). | Models each barcode against the ambient pool (Good-Turing) and tests for deviation; keeps real-but-small cells the knee would miss. | [emptyDrops man](https://rdrr.io/bioc/DropletUtils/man/emptyDrops.html); [Lun et al. 2019](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-019-1662-y) |
| `DropletUtils::barcodeRanks(m, lower=100)` | R | returns the **knee** and **inflection** points of the log-rank/log-total curve. | Quick threshold + diagnostic plot; the knee is a hard cutoff (misses low-RNA cell types). | DropletUtils |
| Cell Ranger / STARsolo **EmptyDrops_CR** | CLI | the 10-number vector in §1b (`FDR 0.01`, `umiMin 500`, `nExpectedCells 3000`, …). | Built into the aligner's filtered output. | STARsolo manual |
| `--force-cells N` | CLI | override cell-calling with a hard top-N by UMI. | Escape hatch when EmptyDrops mis-calls (e.g. low-diversity or damaged samples). | Cell Ranger |

> **Verdict.** `emptyDrops` (FDR ≤ 0.001, `lower=100`) is the field standard and
> the algorithm Cell Ranger ≥3 and STARsolo adopted (`EmptyDrops_CR`). Prefer it
> over a bare knee/inflection cut, which discards genuine low-RNA cells. Bump
> `lower` up for very deep libraries and `niters` up if the output flags
> `Limited` p-values.

---

## 4. Ambient-RNA removal (soup correction)

Removes the cell-free mRNA ("soup") that contaminates every droplet. Distinct
from empty-drop calling: here the barcodes are real cells but their counts are
inflated by ambient transcripts.

| Tool | Eco | Key parameters (default → typical) | Approach / when | Ref |
|---|---|---|---|---|
| **SoupX** `autoEstCont` + `adjustCounts` | R | `autoEstCont(sc, tfidfMin=1, soupQuantile=0.9, maxMarkers=100, contaminationRange=c(0.01,0.8), rhoMaxFDR=0.2, priorRho=0.05, priorRhoStdDev=0.1, forceAccept=FALSE)`; **requires clusters** (`setClusters`). Estimated contamination fraction **rho** typically lands **0.05–0.20**. Manual override: `setContaminationFraction(sc, 0.1)`. | Needs both raw + filtered matrices + clustering. Estimates a single global soup profile + per-cell rho, then subtracts. Conservative; fast; interpretable rho. | [autoEstCont man](https://rdrr.io/github/constantAmateur/SoupX/man/autoEstCont.html); [Young & Behjati 2020, GigaScience](https://academic.oup.com/gigascience/article/9/12/giaa151/6049831) |
| **CellBender** `remove-background` | CLI/Py (GPU) | `--input`/`--output`, `--fpr` (**0.01** → target false-positive rate; raise for more aggressive removal), `--epochs` (**150** typical), `--expected-cells` / `--total-droplets-included` (**auto in v0.3+**; set manually only if the UMI curve is odd), `--learning-rate` (`1e-4` default; lower if training diverges/NaNs), `--cuda` (GPU strongly recommended). Emits a **filtered `.h5`** (`_filtered.h5`) with denoised integer counts. | Deep generative model (VAE) of ambient + cells; also does cell-calling. Best raw performance; needs a GPU + tuning; can over-correct when there's little soup. | [CellBender usage](https://cellbender.readthedocs.io/en/latest/usage/index.html); [Fleming et al. 2023, *Nat Methods*](https://www.nature.com/articles/s41592-023-01943-7) |
| **DecontX** (`celda`) | R (also `decontx-python`) | `decontX(x, z=NULL, delta=c(10,10), estimateDelta=TRUE, maxIter=500, convergence=0.001)`. `z` = cluster labels (auto-clusters if NULL); `delta` = Beta prior on contamination. | Bayesian mixture; no raw matrix needed (uses in-sample clusters as the "native" profile). Convenient; can over-correct with no true soup. | [decontX ref](https://www.camplab.net/celda/v1.18.1/reference/decontX.html); [Yang et al. 2020, *Genome Biol*](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-020-1950-6) |
| **FastCAR** | R | knee-based ambient profile subtraction. | Lightweight alternative. | FastCAR GitHub |

> **Verdict.** In the recent decontamination benchmark, **CellBender** had the
> best overall performance (ambient removal + retaining endogenous signal +
> improved biological interpretation), followed closely by **DecontX (full
> mode)**, then **SoupX (reduced mode)**. But **no single method wins on every
> dataset**, and CellBender / DecontX-full are **more prone to over-correction
> when there is little-to-no ambient RNA** than SoupX-reduced. Practical guidance:
> SoupX or DecontX when you need a fast CPU pass and interpretable rho; CellBender
> when soup is heavy and a GPU is available; always sanity-check that a known
> lineage marker wasn't erased. ([Benchmarking computational decontamination of
> ambient RNA, 2026 preprint](https://www.biorxiv.org/content/10.64898/2026.01.13.699237v1.full))

---

## 5. Doublet detection

Flags droplets that captured ≥2 cells. Two families: **simulation-based**
(simulate synthetic doublets, score real cells by similarity — Scrublet,
scDblFinder, DoubletFinder) and **co-expression-based** (scds). Run
**per-sample** (never on a merged/integrated object) and **before** integration.

### Expected 10x multiplet-rate table (drives every tool's rate prior)

The 10x Chromium multiplet rate scales ~linearly with recovered cells — the
**community rule of thumb is ≈0.8% per 1,000 recovered cells** (≈8% at 10k).
scDblFinder encodes this exactly as `dbr.per1k = 0.008`.

| Cells recovered | Expected multiplet rate |
|---:|---:|
| ~500 | ~0.4% |
| ~1,000 | ~0.8% |
| ~2,000 | ~1.6% |
| ~3,000 | ~2.3% |
| ~4,000 | ~3.1% |
| ~5,000 | ~3.9% |
| ~6,000 | ~4.6% |
| ~8,000 | ~6.1% |
| ~10,000 | ~7.6% |

*(10x Chromium 3'/5' user-guide table; for the High-Throughput (HT) chips the
per-cell rate is roughly halved — scDblFinder recommends `dbr.per1k = 0.004`.)*

### Tools

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| **scDblFinder** | R (Bioc) | `dbr` (**NULL** → auto from `dbr.per1k=0.008` × cells; e.g. ~3.2% at 4k), `dbr.sd` (**NULL** → 40% of dbr), `clusters` (**FALSE/NULL** → *random* artificial-doublet mode is now default; `TRUE` = fast cluster-based), `samples` (+ `BPPARAM` to process captures in parallel), `nfeatures` (**1352**), `dims` (**20**), `includePCs` (**19**), `knownDoublets`. | Trains a gradient-boosted classifier on simulated doublets. **Top-ranked in the Xi & Li benchmark**, fast, handles multiple samples. | [scDblFinder ref](https://plger.github.io/scDblFinder/reference/scDblFinder.html) |
| **Scrublet** | Py | `Scrublet(counts, expected_doublet_rate=0.06, sim_doublet_ratio=2.0)`; `scrub_doublets(min_counts=2, min_cells=3, min_gene_variability_pctl=85, n_prin_comps=30)`; threshold **auto** = min of the bimodal simulated-score histogram (override manually if bimodality is weak). | Original simulation method. Exposed in scanpy as **`sc.pp.scrublet`**. | [scanpy scrublet](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.pp.scrublet.html); [Wolock et al. 2019](https://www.cell.com/cell-systems/fulltext/S2405-4712(18)30474-5) |
| **DoubletFinder** | R | `pN` (**0.25** → fraction of simulated doublets; low sensitivity to it), `pK` (**no default** → must be tuned per dataset via `paramSweep` → `find.pK`), `nExp` (from the loading-density rate × dataset size, then **homotypic-adjusted** with `modelHomotypic`). Requires a fully processed Seurat object (PCA done). | Accurate but the most hands-on (per-dataset `pK` sweep, homotypic correction). | [DoubletFinder](https://github.com/chris-mcginnis-ucsf/DoubletFinder); [McGinnis et al. 2019](https://www.cell.com/cell-systems/fulltext/S2405-4712(19)30073-0) |
| **scds** | R | `cxds` (co-expression), `bcds` (binary-classifier), `hybrid` (both). Annotation-free, very fast. | Good speed/no-tuning option. | [scds](https://bioconductor.org/packages/scds) |
| **solo** (scvi-tools) | Py | VAE-based; trains on an scVI latent space. | Deep-learning option; heavier. | [scvi-tools solo](https://docs.scvi-tools.org/en/stable/api/reference/scvi.external.SOLO.html) |
| **DoubletDetection** | Py | iterative phenograph-based. | Alternative Py method. | DoubletDetection GitHub |

> **Verdict.** The definitive benchmark (**Xi & Li 2021, *Cell Systems***,
> 16 datasets, 8 methods) ranks **scDblFinder best overall** on detection accuracy
> *and* on downstream impact (DE, clustering), with DoubletFinder and cxds/bcds
> also strong; it also found more sophisticated methods don't beat the simple ones
> and that **overloading detection helps but isn't a substitute** for careful
> experimental design. Default to **scDblFinder** (R) or **Scrublet /
> `sc.pp.scrublet`** (Py). Always set the rate prior from the recovered-cell count
> (table above), run per-sample, and treat calls as *soft* flags (inspect, don't
> blindly delete). ([Xi & Li 2021](https://www.cell.com/cell-systems/fulltext/S2405-4712(20)30459-2))

---

## 6. QC metrics + filtering

Compute per-cell/per-gene metrics, then remove low-quality cells (dying/empty →
low genes + high mito) and lowly-detected genes. Two philosophies: **fixed
thresholds** (simple, reproducible, but dataset-blind) vs. **adaptive MAD-based
outlier detection** (auto-adjusts to depth/tissue, per-sample).

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| `sc.pp.calculate_qc_metrics(adata, qc_vars=['mt','ribo','hb'], percent_top=[20,50,...])` | Py | flag mito genes first (`adata.var['mt']=var_names.str.startswith('MT-')`). Adds `n_genes_by_counts`, `total_counts`, `pct_counts_mt`. | Metric computation only. | [scanpy qc](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.pp.calculate_qc_metrics.html) |
| `sc.pp.filter_cells(min_genes=…)` / `sc.pp.filter_genes(min_cells=…)` | Py | fixed thresholds: **`min_genes=200`**, **`min_cells=3`** (the ubiquitous starting pair). Also filter on `pct_counts_mt`, `total_counts` ranges. | Fixed-threshold path. | scanpy |
| `scater::perCellQCMetrics` + `isOutlier` / `quickPerCellQC` | R | `isOutlier(metric, nmads=3, type=...)` flags points **>3 MAD** from the median (per direction); `quickPerCellQC` bundles it over sum/detected/subset_mito. Use `batch=` for **per-sample** thresholds; `min.diff` avoids over-calling on discrete metrics. | **Adaptive** path; auto-adjusts to depth/tissue. `nmads=3` is the default & community norm. | [isOutlier man](https://rdrr.io/bioc/scuttle/man/isOutlier.html) |
| **miQC** | R (Bioc) | `mixtureModel()` fits a 2-component mixture over (`pct mito`, `n detected`); filter on posterior prob of being "compromised" (e.g. `>0.75`). | Data-adaptive mito+complexity joint filter; better than a hard mito cut on heterogeneous tissue. | [miQC](https://bioconductor.org/packages/miQC); [Hippen et al. 2021, *PLOS CB*](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1009290) |
| `sctk` / SoupX-adjacent QC | R | wrapper suites bundling the above + doublets + decontam. | Convenience. | singleCellTK |

**Typical thresholds (community, always inspect distributions first):**

- `min_genes` 200–500 per cell; `min_cells` 3 per gene.
- `nFeature_RNA` (genes/cell) window ~200–2,500 (cell-type dependent — raise the
  upper bound for large/active cells); `nCount_RNA` (UMIs/cell) similar windowing.
- **% mitochondrial < 5–10%** for whole cells; **single-nucleus** tolerates
  little-to-no mito but **flags nuclei on high cytoplasmic markers like MALAT1**
  and typically uses a *higher* gene/UMI floor.
- Prefer **per-sample** thresholds (or MAD-adaptive) over one global cut across a
  multi-sample study.

> **Verdict.** Adaptive **MAD (`nmads=3`)** or **miQC** beat a single global
> fixed cut on multi-sample / multi-tissue data because they track depth and
> composition automatically; fixed thresholds remain fine (and more transparent)
> for a single homogeneous sample. Whichever you pick, **QC per sample, not
> pooled**, and re-check after doublet + ambient correction. pipeComp (Germain
> 2020) found filtering choices have a **large** downstream impact — over-filtering
> is as harmful as under-filtering. ([Germain et al. 2020, *pipeComp*, *Genome
> Biol*](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-020-02136-7))

---

## 7. Normalization

Corrects per-cell sequencing depth (and stabilizes variance). This is the step
with the most method proliferation — and the benchmark surprise that the
**simplest method is competitive**.

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| `sc.pp.normalize_total` + `sc.pp.log1p` | Py | `normalize_total(target_sum=None)` → **`None`** scales each cell to the **median** total; **`1e4`** ("CP10K") is the popular explicit choice; then `log1p` (natural-log of x+1). Together = the "shifted logarithm". | The default scanpy path; the benchmark-winning approach. | [normalize_total](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.normalize_total.html) |
| **SCTransform** (`sctransform`/Seurat) | R | `SCTransform(vst.flavor="v2", variable.features.n=3000, vars.to.regress=NULL, ncells=5000, ...)`; **v2 is default in Seurat v5**; **needs `glmGamPoi`** installed for the fast path. Regularized-NB (Pearson-residual) VST; returns residuals + selects HVGs in one call. | One-call normalize+HVG+variance-stabilize; heavier; strong on rare types. | [SCTransform ref](https://satijalab.org/seurat/reference/sctransform) |
| **scran** `computeSumFactors`/`quickCluster` + `logNormCounts` | R | `quickCluster(sce, min.size=100)` → `computeSumFactors(sce, clusters=, min.mean=0.1)` → `logNormCounts(sce)`. Pooling-deconvolution size factors robust to composition bias. | Bioconductor default; well-tested for downstream batch tasks. | [scran vignette](https://bioconductor.org/packages/release/bioc/vignettes/scran/inst/doc/scran.html) |
| **Analytic Pearson residuals** | Py | `sc.experimental.pp.normalize_pearson_residuals(adata, theta=100, clip=None)`. `theta` = NB overdispersion (**100** default; `theta=inf` ⇒ Poisson); `clip=None` ⇒ clip residuals to `±sqrt(n_obs)`. | Good for HVG selection + rare-cell detection; from a raw-count model. | [normalize_pearson_residuals](https://scanpy.readthedocs.io/en/stable/generated/scanpy.experimental.pp.normalize_pearson_residuals.html); [Lause et al. 2021, *Genome Biol*](https://link.springer.com/article/10.1186/s13059-021-02451-7) |
| **DSB** (protein / CITE-seq ADT) | R | `DSBNormalizeProtein(cell_matrix, empty_drop_matrix, denoise.counts=TRUE, use.isotype.control=TRUE, isotype.control.name.vec=…)`. Uses **empty droplets** as the background estimate + isotype controls to remove technical noise. | The recommended ADT normalization; needs empty-droplet matrix. | [DSB](https://cran.r-project.org/web/packages/dsb/); [Mulè et al. 2022, *Nat Commun*](https://www.nature.com/articles/s41467-022-29356-8) |
| **CLR** (protein, in-Seurat) | R | `NormalizeData(assay="ADT", normalization.method="CLR", margin=2)`. **`margin=2`** = CLR across cells per feature (10x/WNN tutorial choice); `margin=1` = across features per cell. | Simple ADT normalization without empty droplets. | [Seurat NormalizeData](https://satijalab.org/seurat/reference/normalizedata) |
| **TF-IDF** (scATAC) | R | `Signac::RunTFIDF(object, method=1, scale.factor=1e4)`. **`method=1`** (default) = `log(TF × IDF)` (Stuart 2019). | ATAC peak-matrix depth normalization; precedes `RunSVD` (LSI). | [RunTFIDF](https://stuartlab.org/signac/reference/runtfidf) |

> **Verdict.** **Ahlmann-Eltze & Huber 2023 (*Nat Methods*)** benchmarked
> transformations and found the **shifted logarithm (`normalize_total` + `log1p`)
> followed by PCA performs as well or better** than the more sophisticated
> SCTransform and Pearson-residual methods for dimensionality reduction and DE —
> i.e. the field default is hard to beat. The nuance (from Lause 2021 and the
> best-practices book): **analytic Pearson residuals** are well suited to **HVG
> selection and rare-cell detection**; **scran pooling** is well tested for
> **batch-correction** downstream; **SCTransform v2** remains a strong one-call
> option and is Seurat's default. Booeshaghi/Pachter and pipeComp both caution
> that normalization choice interacts with every later step, so **pick one and
> keep it consistent**. Modality-specific: **DSB** for ADT (or CLR if no empty
> droplets), **TF-IDF/LSI** for ATAC. ([Ahlmann-Eltze & Huber 2023](https://www.nature.com/articles/s41592-023-01814-1); [sc-best-practices normalization](https://www.sc-best-practices.org/preprocessing_visualization/normalization.html))

---

## 8. Feature selection (highly variable genes)

Restrict to the genes carrying biological signal (typically 2,000–3,000) to
denoise PCA and speed everything up.

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| `sc.pp.highly_variable_genes` | Py | `flavor` (**`seurat`** default, on log data; `cell_ranger`; **`seurat_v3`**/`seurat_v3_paper` on **raw counts**, requires `n_top_genes`; `pearson_residuals`), `n_top_genes` (**None** for seurat/cell_ranger dispersion-cutoff mode; **2000–3000** with seurat_v3), `batch_key` (select **within each batch** then intersect/merge → avoids batch-specific genes), `span` (**0.3** loess for seurat_v3), `min_mean`/`max_mean`/`min_disp`. | `seurat_v3` (VST on counts) is the modern default for a fixed gene count. `batch_key` is a lightweight batch guard. | [highly_variable_genes](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.highly_variable_genes.html) |
| `Seurat::FindVariableFeatures` | R | `selection.method="vst"`, `nfeatures=2000` (default), `loess.span=0.3`, `clip.max="auto"`, `num.bin=20`, `binning.method="equal_width"`. | Seurat default HVG (VST); 2,000 is standard. | [FindVariableFeatures](https://satijalab.org/seurat/reference/findvariablefeatures) |
| `scran::modelGeneVar` / `modelGeneVarByPoisson` + `getTopHVGs` | R | `modelGeneVar(sce)` (mean-variance trend, decompose bio vs. technical) or `modelGeneVarByPoisson` (Poisson-noise trend for UMI); `getTopHVGs(dec, n=2000 | prop=0.1 | var.threshold=0 | fdr.threshold=0.05)`. FDR thresholding **off by default**. | Statistically principled; flexible selection strategies. | [getTopHVGs](https://rdrr.io/bioc/scran/man/getTopHVGs.html) |
| SCTransform | R | `variable.features.n=3000` — HVGs are a **by-product** of the SCT call. | See §7. | Seurat |

**Common practice:** exclude confounder gene sets before/after selection —
mitochondrial, ribosomal, `HB*` (hemoglobin), sex/`XIST`, TCR/BCR V(D)J genes,
sometimes cell-cycle — so they don't dominate HVGs or PCA.

> **Verdict.** scIB (Luecken 2022) found **HVG selection *improves* integration
> performance** (a rare "free lunch"); 2,000–3,000 genes is the sweet spot.
> Use `seurat_v3`/VST on raw counts (or scran's Poisson trend for UMI) for a fixed
> gene count; add `batch_key` in multi-sample studies. Pearson-residual HVGs
> (Lause 2021) are the best choice when rare-cell recovery matters.

---

## 9. Scaling / regression

Z-score genes so PCA weights them equally, and optionally regress out unwanted
covariates (depth, mito %, cell cycle). Increasingly *skipped or minimized*
because scaling can hurt bio-conservation (see scIB) and heavy regression can
erase real signal.

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| `sc.pp.scale` | Py | `max_value` (**None** → **10** community "clip at 10 SD"), `zero_center` (**True**). Scale on HVGs only. | Standardize genes pre-PCA. | [scanpy scale](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.scale.html) |
| `sc.pp.regress_out` | Py | `keys=['total_counts','pct_counts_mt']` (and/or `['S_score','G2M_score']`). Slow; linear. | Use sparingly; can remove biology. | scanpy |
| `Seurat::ScaleData` | R | `vars.to.regress=c('nCount_RNA','percent.mt','S.Score','G2M.Score')`, `model.use="linear"` (default; also `poisson`,`negbinom`), `do.scale`/`do.center` (TRUE). | Regression + scaling in one call (or handled inside SCTransform via `vars.to.regress`). | [ScaleData](https://satijalab.org/seurat/reference/scaledata) |
| Cell-cycle scoring | Both | `Seurat::CellCycleScoring(s.features=cc.genes$s.genes, g2m.features=cc.genes$g2m.genes)` → adds `S.Score`, `G2M.Score`, `Phase`; scanpy `sc.tl.score_genes_cell_cycle(s_genes=, g2m_genes=)`. Gene lists = **Tirosh et al. 2015** (97 genes: 43 S + 54 G2M, human symbols — map orthologs for other species). | Score first, then decide whether to regress the *scores* (Seurat uses the continuous scores, not the discrete phase). "Alternative" workflow regresses `S.Score - G2M.Score` to keep cycling-vs-quiescent signal. | [Seurat cell-cycle vignette](https://satijalab.org/seurat/articles/cell_cycle_vignette.html); [scanpy cell-cycle](https://scanpy.readthedocs.io/en/latest/how-to/cell-cycle.html) |

> **Verdict.** scIB (Luecken 2022): **scaling pushes methods toward batch removal
> at the expense of biological conservation** — so for integration, prefer
> *unscaled* input or check both. Regress covariates only with evidence they
> confound (visible cell-cycle or mito-driven clusters); default to **not**
> regressing. SCTransform folds depth-regression into normalization, so a separate
> scale/regress step is often unnecessary on that path.

---

## 10. PCA (linear dimensionality reduction)

Compresses the HVG matrix to ~50 components that feed neighbors/UMAP/clustering.

| Tool | Eco | Key parameters (default → typical) | Notes | Ref |
|---|---|---|---|---|
| `sc.pp.pca` | Py | `n_comps` (**50** community default; scanpy default is `min(50, n_vars-1)`), `svd_solver` (**`arpack`** typical; `auto`/`randomized` for large data), `zero_center` (**True**; set False for sparse/Pearson-residual input), `use_highly_variable` (**True** if HVGs flagged), `mask_var`. | Standard scanpy PCA. | [scanpy pca](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.pca.html) |
| `Seurat::RunPCA` | R | `npcs=50` (default), `features=VariableFeatures(obj)`, `approx=TRUE` (irlba). | Standard Seurat PCA. | [RunPCA](https://satijalab.org/seurat/reference/runpca) |

**Choosing the number of PCs** (community methods, roughly increasing rigor):

- **Elbow plot** (`ElbowPlot` / `sc.pl.pca_variance_ratio`) — eyeball where the
  variance curve flattens; fast, standard, slightly subjective.
- **`JackStraw`** (Seurat) — permutation test for significant PCs; principled but
  slow, and deprecated for SCTransform data.
- **`findPC`** — automates elbow detection across several heuristics.
- **Molecular cross-validation** — data-driven optimal-PC selection by holding
  out counts; the most rigorous, least used.
- **Rule of thumb:** 30–50 PCs is safe for most datasets; too few loses rare
  structure, too many injects noise. Downstream results are usually robust across
  a broad 20–50 window.

> **Verdict.** The exact PC count rarely matters within a sensible window
> (~20–50); over-thinking it is low-value. Use the elbow plot by default; escalate
> to findPC / molecular cross-validation only when rare populations are the point.

---

## 11. Integration / batch correction

Removes technical batch effects across samples/donors/technologies while
preserving biology. The **highest-variance decision** in the pipeline. Methods
split by output: **embedding-only** (corrected latent space for
neighbors/clustering — Harmony, scVI, BBKNN, Scanorama, fastMNN) vs.
**corrected-expression** (a batch-corrected gene matrix usable for DE —
Seurat/CCA, fastMNN, Scanorama full, LIGER).

### One row per method (every key knob)

**Harmony** (`harmonypy` / `RunHarmony`) — Py/R, embedding

| Param | Default → what it does |
|---|---|
| `theta` | **2** → diversity-clustering penalty; **↑ = more aggressive mixing** (0 = no diversity pressure). The main knob. |
| `lambda` | **1** → ridge penalty; **↑ = more conservative** (protects against over-correction). |
| `sigma` | **0.1** → soft-kmeans cluster width; ↑ assigns cells to more clusters. |
| `nclust` | NULL (auto) → number of Harmony clusters; `nclust=1` ≈ linear regression. |
| `max.iter.harmony` | **10** → max clustering↔correction rounds. |
| `group.by.vars` / `vars_use` | **required** → the batch column(s) to correct. |

Fast, scalable, corrects an existing PCA; the most-used method. Docs: [RunHarmony](https://portals.broadinstitute.org/harmony/reference/RunHarmony.html); [Korsunsky et al. 2019, *Nat Methods*](https://www.nature.com/articles/s41592-019-0619-0)

**scVI / scANVI** (`scvi-tools`) — Py, embedding (deep generative)

| Param | Default → what it does |
|---|---|
| `n_latent` | **10** → latent dim (community often **10–30** for atlases). |
| `n_layers` | **1** → hidden layers in encoder/decoder (**1–2**). |
| `n_hidden` | **128** → nodes per hidden layer. |
| `gene_likelihood` | **`zinb`** → also `nb`, `poisson`. |
| `dispersion` | **`gene`** → `gene-batch`, `gene-label`, `gene-cell`. |
| `dropout_rate` | **0.1**. |
| `batch_key` (setup) | the batch covariate; also `categorical_covariate_keys`, `continuous_covariate_keys`. |
| `max_epochs` | auto (∝ dataset size) → training length. |
| input | HVG raw counts, typically **~2,000** genes. |

**scANVI** = the semi-supervised extension: seed it with partial labels for
**label transfer** + label-aware integration. Models raw counts directly (good
when you need a probabilistic count model / query-to-reference mapping). Docs: [scvi.model.SCVI](https://docs.scvi-tools.org/en/stable/api/reference/scvi.model.SCVI.html); [Lopez et al. 2018 / Xu et al. 2021]

**Seurat CCA / RPCA** (`FindIntegrationAnchors`/`IntegrateData` legacy; v5 `IntegrateLayers`) — R, corrected-expression

| Param | Default → what it does |
|---|---|
| `dims` | **1:30** → dimensions for anchor finding. |
| `k.anchor` | **5** → neighbors when defining anchors (↑ = stronger integration). |
| `k.filter` | **200** → neighbors for filtering anchors (`NA` to skip). |
| `k.weight` | **100** → neighbors for weighting anchors in `IntegrateData` (lower for small samples). |
| `reduction` | **`cca`** (sensitive, slower) vs. **`rpca`** (faster, more conservative — recommended for large/well-separated data). |
| v5 `IntegrateLayers method=` | `CCAIntegration` / `RPCAIntegration` / `HarmonyIntegration` / `FastMNNIntegration` / `scVIIntegration`. |

CCA = maximal sensitivity (good for shared rare types across technologies); RPCA
= faster + resists over-correction. Docs: [FindIntegrationAnchors](https://satijalab.org/seurat/reference/findintegrationanchors); [IntegrateLayers](https://satijalab.org/seurat/reference/integratelayers); [Stuart et al. 2019, *Cell*]

**fastMNN** (`batchelor`) — R, both

| Param | Default → what it does |
|---|---|
| `d` | **50** → PCs for the multi-batch PCA. |
| `k` | **20** → mutual-nearest-neighbors used to detect matches (↑ = stronger merge). |
| `cos.norm` | **TRUE** → cosine-normalize (protects against per-batch scaling). |
| `merge.order` | **NULL** → custom hierarchical merge order. |
| `auto.merge` | **FALSE** → `TRUE` picks the order maximizing MNN pairs each step. |

Docs: [fastMNN](https://rdrr.io/bioc/batchelor/man/fastMNN.html); [Haghverdi et al. 2018, *Nat Biotech*]

**BBKNN** — Py, graph (embedding-adjacent)

| Param | Default → what it does |
|---|---|
| `neighbors_within_batch` | **3** → neighbors taken **per batch** (↑ for many batches / stronger mixing, e.g. 5–10). |
| `n_pcs` | **50** → PCs used. |
| `trim` | None (auto ≈ 10× total neighbors) → prunes spurious cross-batch edges. |

Extremely fast; edits the kNN graph directly (no corrected matrix/embedding). Docs: [bbknn](https://github.com/Teichlab/bbknn); [Polański et al. 2020, *Bioinformatics*]

**Scanorama** — Py, both

| Param | Default → what it does |
|---|---|
| `knn` | **20** → neighbors for matching panoramas. |
| `sigma` | **15** → Gaussian-kernel correction smoothing. |
| `alpha` | **0.1** → minimum alignment-score cutoff. |
| `batch_size` | **5000** → alignment-vector batch size. |
| `dimred` | **100** → output dimensions. |

Robust, order-independent panorama stitching; exposed as `sc.external.pp.scanorama_integrate`. Docs: [scanorama](https://github.com/brianhie/scanorama); [Hie et al. 2019, *Nat Biotech*]

**LIGER / rliger** — R, factor-based

| Param | Default → what it does |
|---|---|
| `optimizeALS` `k` | **20** → number of shared+dataset-specific factors (iNMF). |
| `lambda` | **5** → penalty on dataset-specific factors (↑ = stronger integration). |
| `quantile_norm` `quantiles` | **50** → quantile alignment of factor loadings; `knn_k` **20**. |

Good for very different modalities / cross-species; keeps dataset-specific
structure. Docs: [rliger](https://welch-lab.github.io/liger/); [Welch et al. 2019, *Cell*]

### Benchmark verdict — integration

> **scIB — Luecken et al. 2022 (*Nat Methods*)** benchmarked 68 method/preprocessing
> combinations on 85 batches (>1.2M cells, 13 tasks) scoring **batch removal vs.
> bio-conservation** on 14 metrics. Headline findings:
> - **Top performers:** **scANVI, scVI, and Scanorama** rank best on complex tasks;
>   **scGen** and **scANVI** are best **when cell-type labels are available**
>   (label-aware). **Harmony** is a top method for **simpler tasks and is the
>   fastest** strong option; **FastMNN (embedding)** also competitive.
> - **Preprocessing matters as much as method:** **HVG selection improves**
>   integration; **scaling pushes toward batch removal at the cost of biology.**
> - **The core tradeoff** is batch-removal vs. bio-conservation — no method
>   maximizes both; pick per your priority.
>
> **Tran et al. 2020 (*Genome Biol*, 14 methods)** — recommends **Harmony, LIGER,
> Seurat 3**; **Harmony first** for its far shorter runtime, with LIGER/Seurat 3 as
> alternatives; Harmony also best on cell-type purity (ARI), then fastMNN, Seurat 3.
> ([Luecken 2022](https://www.nature.com/articles/s41592-021-01336-8); [Tran 2020](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-019-1850-9))

### Decision matrix

| Situation | Recommended | Why |
|---|---|---|
| Small–medium, quick, "just correct my PCA" | **Harmony** | Fastest strong method; corrects existing PCA in seconds; the default first try (Tran 2020). |
| Large atlas, want a probabilistic count model | **scVI** | Scales to millions; models raw counts; embedding reusable for query mapping. |
| Have (partial) cell-type labels / want label transfer | **scANVI** (or scGen) | Label-aware; top bio-conservation in scIB; enables reference→query annotation. |
| Need a **batch-corrected expression matrix** for DE | **Seurat (RPCA)**, **fastMNN**, or **Scanorama (full)** | Return corrected counts, not just an embedding (Harmony/scVI/BBKNN don't). |
| Shared rare types across different technologies | **Seurat CCA** or **Scanorama** | Maximal sensitivity to shared structure. |
| Very large / need speed on the graph only | **BBKNN** | Edits kNN graph directly; near-instant; no corrected matrix. |
| Many batches / order-robustness | **Scanorama** | Order-independent panorama stitching. |
| Very heterogeneous modalities / cross-species | **LIGER** | iNMF keeps dataset-specific factors. |
| No GPU, no labels, medium data | **Harmony** or **fastMNN** | CPU-friendly, no training. |
| GPU available, big data, no labels | **scVI** | Best scaling + bio-conservation among unsupervised. |

**Cross-cutting rules:** integrate on **HVGs**, prefer **unscaled** input, run
**doublet + QC + ambient correction per-sample before** integrating, and always
evaluate both batch-mixing *and* whether known markers stayed cluster-specific
(don't trust a UMAP that "looks mixed").

---

## Sources

**Alignment / quantification**
- [Cell Ranger command-line arguments (8.0)](https://www.10xgenomics.com/support/software/cell-ranger/8.0/resources/cr-command-line-arguments) — `count`/`multi` flags, `--include-introns` default `true` (v7+), `--create-bam`, `--chemistry auto`.
- [Cell Ranger `count` pipeline](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/running-pipelines/cr-gex-count) — cell-calling, `--expect-cells`/`--force-cells`.
- [STARsolo manual (GitHub master)](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md) — all solo* defaults; Cell-Ranger-emulation flag set; EmptyDrops_CR params.
- [alevin-fry `quant` docs](https://alevin-fry.readthedocs.io/en/latest/quant.html) — `--resolution` modes; USA mode.
- [alevin-fry `generate-permit-list`](https://alevin-fry.readthedocs.io/en/latest/generate_permit_list.html) — `--unfiltered-pl`, `--knee-distance`, `--expected-ori`.
- [simpleaf docs](https://simpleaf.readthedocs.io/en/latest/quant-command.html) — one-command wrapper; chemistry/resolution.
- [kb-python GitHub](https://github.com/pachterlab/kb_python) + [kallisto|bustools docs](https://kallisto.readthedocs.io/en/latest/manuals/kb.html) — `kb ref`/`kb count`, `--workflow standard/nac/lamanno`, `-x`, `--filter bustools`.
- [Sullivan et al. 2023, kb-python (PMC10690192)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10690192/) — method + nac workflow.
- [Space Ranger command-line args](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/running-pipelines/command-line-arguments) — `--probe-set`, `--cytassist`, `--darkimage`.
- [He et al. 2022, alevin-fry (PMC8933848)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8933848/) — speed/memory + velocity fidelity benchmark.
- [Like-for-like lightweight-mapping comparison (bioRxiv)](https://www.biorxiv.org/content/10.1101/2021.02.10.430656.full.pdf) — alevin-fry vs. kb concordance.

**Import**
- [scanpy read_10x_mtx](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.read_10x_mtx.html) · [Seurat Read10X](https://satijalab.org/seurat/reference/read10x) · [DropletUtils](https://bioconductor.org/packages/DropletUtils) — reader APIs; raw vs. filtered matrix distinction.

**Empty droplets**
- [emptyDrops man page](https://rdrr.io/bioc/DropletUtils/man/emptyDrops.html) — `lower=100`, `niters=10000`, `test.ambient=FALSE`, `retain=NULL`.
- [Lun et al. 2019, EmptyDrops (Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-019-1662-y) — method; typical FDR ≤ 0.001.

**Ambient RNA**
- [SoupX autoEstCont man](https://rdrr.io/github/constantAmateur/SoupX/man/autoEstCont.html) — priorRho=0.05, contaminationRange, needs clusters.
- [Young & Behjati 2020, SoupX (GigaScience)](https://academic.oup.com/gigascience/article/9/12/giaa151/6049831).
- [CellBender usage docs](https://cellbender.readthedocs.io/en/latest/usage/index.html) — `--fpr 0.01`, `--epochs 150`, auto cells/droplets in v0.3+.
- [Fleming et al. 2023, CellBender (Nat Methods)](https://www.nature.com/articles/s41592-023-01943-7).
- [decontX reference (celda)](https://www.camplab.net/celda/v1.18.1/reference/decontX.html) — `delta=c(10,10)`, `z` clusters, `maxIter=500`.
- [Yang et al. 2020, DecontX (Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-020-1950-6).
- [Ambient-RNA decontamination benchmark (2026 preprint)](https://www.biorxiv.org/content/10.64898/2026.01.13.699237v1.full) — CellBender > DecontX-full > SoupX-reduced; over-correction caveat.

**Doublets**
- [scDblFinder reference](https://plger.github.io/scDblFinder/reference/scDblFinder.html) — `dbr` auto via `dbr.per1k=0.008`, `dbr.sd`, `clusters`, `nfeatures=1352`, `dims=20`.
- [scanpy pp.scrublet](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.pp.scrublet.html) + [Wolock et al. 2019](https://www.cell.com/cell-systems/fulltext/S2405-4712(18)30474-5) — `expected_doublet_rate≈0.06`, `sim_doublet_ratio=2`.
- [DoubletFinder GitHub](https://github.com/chris-mcginnis-ucsf/DoubletFinder) + [McGinnis et al. 2019](https://www.cell.com/cell-systems/fulltext/S2405-4712(19)30073-0) — `pN=0.25`, `pK` sweep, `nExp` homotypic.
- [Xi & Li 2021, doublet benchmark (Cell Systems)](https://www.cell.com/cell-systems/fulltext/S2405-4712(20)30459-2) — scDblFinder top.
- [10x multiplet-rate table (biostars discussion)](https://www.biostars.org/p/9467937/) — ~0.8% per 1,000 recovered cells.

**QC**
- [scanpy calculate_qc_metrics](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.pp.calculate_qc_metrics.html) — metric computation.
- [scuttle isOutlier man](https://rdrr.io/bioc/scuttle/man/isOutlier.html) — `nmads=3` adaptive MAD; `quickPerCellQC`.
- [miQC (Bioconductor)](https://bioconductor.org/packages/miQC) + [Hippen et al. 2021 (PLOS CB)](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1009290) — mixture-model mito QC.
- [Germain et al. 2020, pipeComp (Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-020-02136-7) — large impact of filtering/normalization choices.

**Normalization**
- [scanpy normalize_total](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.normalize_total.html) — `target_sum=None` → median; 1e4 community.
- [Seurat SCTransform reference](https://satijalab.org/seurat/reference/sctransform) — `vst.flavor="v2"`, `variable.features.n=3000`, `ncells=5000`, needs glmGamPoi.
- [scran normalization vignette](https://bioconductor.org/packages/release/bioc/vignettes/scran/inst/doc/scran.html) — computeSumFactors/quickCluster/logNormCounts.
- [scanpy normalize_pearson_residuals](https://scanpy.readthedocs.io/en/stable/generated/scanpy.experimental.pp.normalize_pearson_residuals.html) + [Lause et al. 2021 (Genome Biol)](https://link.springer.com/article/10.1186/s13059-021-02451-7) — `theta=100`, clip.
- [Ahlmann-Eltze & Huber 2023 (Nat Methods)](https://www.nature.com/articles/s41592-023-01814-1) — log1p+PCA ≥ SCT/Pearson.
- [sc-best-practices: normalization](https://www.sc-best-practices.org/preprocessing_visualization/normalization.html) — per-method use-cases.
- [dsb (CRAN)](https://cran.r-project.org/web/packages/dsb/) + [Mulè et al. 2022 (Nat Commun)](https://www.nature.com/articles/s41467-022-29356-8) — ADT DSB, `denoise.counts=TRUE`, `use.isotype.control=TRUE`.
- [Seurat NormalizeData](https://satijalab.org/seurat/reference/normalizedata) — CLR `margin=2`.
- [Signac RunTFIDF](https://stuartlab.org/signac/reference/runtfidf) — ATAC TF-IDF `method=1`.

**Feature selection**
- [scanpy highly_variable_genes](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.highly_variable_genes.html) — flavors, `n_top_genes`, `batch_key`, `span=0.3`.
- [Seurat FindVariableFeatures](https://satijalab.org/seurat/reference/findvariablefeatures) — `vst`, `nfeatures=2000`.
- [scran getTopHVGs](https://rdrr.io/bioc/scran/man/getTopHVGs.html) — `n`/`prop=0.1`/`var.threshold`/`fdr.threshold`.

**Scaling / cell cycle / PCA**
- [scanpy scale](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.scale.html) — `max_value=10`, `zero_center`.
- [Seurat ScaleData](https://satijalab.org/seurat/reference/scaledata) — `vars.to.regress`, `model.use`.
- [Seurat cell-cycle vignette](https://satijalab.org/seurat/articles/cell_cycle_vignette.html) + [scanpy cell-cycle](https://scanpy.readthedocs.io/en/latest/how-to/cell-cycle.html) — Tirosh 97-gene S/G2M lists.
- [scanpy pp.pca](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.pca.html) + [Seurat RunPCA](https://satijalab.org/seurat/reference/runpca) — `n_comps/npcs=50`.
- [findPC (Bioinformatics 2022)](https://academic.oup.com/bioinformatics/article/38/10/2949/6565314) — auto PC selection.

**Integration**
- [Harmony RunHarmony](https://portals.broadinstitute.org/harmony/reference/RunHarmony.html) + [Korsunsky et al. 2019 (Nat Methods)](https://www.nature.com/articles/s41592-019-0619-0) — `theta=2`, `lambda=1`, `sigma=0.1`.
- [scvi.model.SCVI](https://docs.scvi-tools.org/en/stable/api/reference/scvi.model.SCVI.html) — `n_latent=10`, `n_layers=1`, `n_hidden=128`, `gene_likelihood='zinb'`; scANVI for labels.
- [Seurat FindIntegrationAnchors](https://satijalab.org/seurat/reference/findintegrationanchors) + [IntegrateLayers](https://satijalab.org/seurat/reference/integratelayers) — `dims=1:30`, `k.anchor=5`, `k.weight=100`, CCA/RPCA/Harmony/FastMNN/scVI.
- [batchelor fastMNN](https://rdrr.io/bioc/batchelor/man/fastMNN.html) — `d=50`, `k=20`, `cos.norm=TRUE`, `auto.merge`.
- [bbknn GitHub](https://github.com/Teichlab/bbknn) — `neighbors_within_batch=3`, `n_pcs=50`, `trim`.
- [scanpy scanorama_integrate](https://scanpy.readthedocs.io/en/stable/generated/scanpy.external.pp.scanorama_integrate.html) + [scanorama GitHub](https://github.com/brianhie/scanorama) — `knn=20`, `sigma=15`, `alpha=0.1`, `dimred=100`.
- [rliger optimizeALS](https://rdrr.io/cran/rliger/man/optimizeALS.html) — `k=20`, `lambda=5`, quantile_norm.
- [Luecken et al. 2022, scIB (Nat Methods)](https://www.nature.com/articles/s41592-021-01336-8) — top methods; HVG helps / scaling hurts.
- [Tran et al. 2020, batch-correction benchmark (Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-019-1850-9) — Harmony/LIGER/Seurat 3; Harmony first for speed.
