# 03 — Data Modalities and the "Possibilities of the Data"

> Scope: what kinds of measurements a single-cell / spatial experiment can produce, what each
> one *means*, and — the point of this document — **how each modality changes the
> data-PROCESSING path from raw sequencer output to an analysis-ready matrix**. For each
> modality we give (a) what the raw data physically is (matrix, `feature_type`, extra files),
> (b) the *processing deltas* versus a plain 3′ scRNA-seq run, and (c) the key tools.
>
> Cross-references (do not duplicate — read alongside):
> - **`02-platforms.md`** — the chemistries/instruments (10x 3′/5′, Smart-seq, Parse, BD
>   Rhapsody, Visium, Xenium, MERSCOPE…) that *produce* these modalities.
> - **`04-pipeline-steps.md`** — the generic raw→analysis-ready step sequence (demux →
>   align/quant → cell calling → QC → normalize → integrate → cluster/annotate).
> - **`05-tools-and-parameters.md`** — concrete tool invocations, flags, and default thresholds.
> - **`06-spatial-processing.md`** — the coordinate/image side of spatial data.

---

## 0. Mental model: "modality" vs "assay chemistry" vs "data possibility"

Three axes are easy to conflate; keeping them separate is what makes the processing path
predictable.

1. **The molecule measured (the true "modality").** mRNA, nuclear pre-mRNA, surface protein,
   open chromatin, a rearranged TCR/BCR locus, a guide RNA, a lineage barcode, etc. This is
   what determines the *biology* of the readout.
2. **The chemistry/platform (`02-platforms.md`).** Droplet 3′ tag vs plate full-length vs
   combinatorial-index vs in-situ imaging. This determines *how much* of the molecule you see
   (a 3′ UMI tag vs a full-length transcript) and what side-files exist.
3. **The "data possibility" — what you can *ask* of the data.** A 3′ droplet run can ask
   "what cell type / state?" but *cannot* ask "which isoform?" A full-length run can ask about
   isoforms/alleles but not about 100k cells cheaply. An ATAC run asks "what is regulatorily
   poised?" not "what is expressed." Each modality both *enables* and *forecloses* questions.

**The single most important processing consequence:** every non-standard modality forces a
change at one or more of these four choke points:

| Choke point | What can change per modality |
|---|---|
| **Quantification reference/feature set** | pre-mRNA/intron-inclusive reference; peaks vs tiles; splice-aware spliced/unspliced; contig assembly; guide/HTO/ADT feature reference |
| **What "a feature" is** | gene vs peak vs protein vs clonotype vs guide vs barcode |
| **Normalization** | log-CPM vs CLR/DSB (protein) vs TF-IDF (ATAC) vs none (categorical calls) |
| **QC vocabulary** | %mito & genes/cell (RNA) vs TSS-enrichment/FRiP/nucleosome-signal (ATAC) vs isotype-control background (ADT) vs HTO singlet/doublet classification |

The rest of this document walks each modality through those choke points, always anchored to
the plain-scRNA baseline in §1.

---

## 1. scRNA-seq (whole single cell) — the baseline path

**What is measured.** Polyadenylated cytoplasmic + (some) nuclear mRNA from an intact,
dissociated cell. In a 3′ droplet assay (10x GEM, etc.) you capture a UMI + a short 3′ (or 5′)
tag of each transcript; in full-length plate assays you capture the whole transcript (§13).

**Raw data.** FASTQs → aligner/quantifier → a **genes × cells count matrix**. For 10x this is
`filtered_feature_bc_matrix/` (`matrix.mtx.gz` + `features.tsv.gz` with `feature_type =
Gene Expression` + `barcodes.tsv.gz`), plus a `raw_feature_bc_matrix/` (all barcodes,
including empty droplets), a `molecule_info.h5`, and a BAM. STARsolo/alevin-fry/kallisto|bustools
produce equivalent MatrixMarket/H5AD outputs.

**Standard processing path** (the reference every later section is a *delta* against):
demultiplex → align to a **spliced-transcriptome / exonic reference** (GENCODE/Ensembl) →
UMI-collapse → **empty-droplet / cell calling** (EmptyDrops, knee) → **QC** (min genes/cell,
max %mitochondrial as a lysis/stress proxy, doublet detection) → **normalize** (log1p of
library-size-normalized counts, or analytic Pearson residuals / `sctransform`) → HVG selection
→ PCA → neighbors → cluster (Leiden) → annotate. Full step detail is in `04-pipeline-steps.md`.

**Tools.** Cell Ranger, STARsolo, alevin-fry, `kb-python`; then Scanpy/AnnData or Seurat.

**Key baseline assumptions that later modalities break:**
- "A feature is a gene." (ATAC breaks this; V(D)J/guides/barcodes break this.)
- "High %mito ⇒ dying cell." (snRNA inverts the interpretation.)
- "Log-normalize the counts." (Protein/ATAC replace this.)
- "One matrix." (Multimodal assays ship 2–4 matrices that must be co-registered by barcode.)

---

## 2. snRNA-seq (single nucleus)

**What is measured.** Only the **nuclear** RNA of each cell — dominated by **unspliced
pre-mRNA** (nascent transcripts still carrying introns) and nuclear-retained lncRNAs, with the
cytoplasm (and most mature mRNA + mitochondria) stripped away. Chosen for **frozen, archival,
fibrous, or dissociation-sensitive tissue** (brain, muscle, kidney, adipose, tumors) where
whole-cell dissociation is impossible or induces a stress-gene artifact; single-nucleus avoids
the dissociation-induced immediate-early-gene stress signature.

**Processing delta #1 — intron-inclusive reference/quantification (the big one).** Because a
large fraction of nuclear reads fall in **introns**, quantifying against an exon-only reference
throws away 20–40% of reads and severely undercounts genes per nucleus. You must count reads
overlapping the whole gene body:
- **Cell Ranger:** `--include-introns`. In 10x whole-transcriptome data intronic reads are
  20–40% of reads; including them raises UMIs/gene per nucleus. Cell Ranger **v7.0+ includes
  introns by default** (for both cells and nuclei), retiring the old hand-built "pre-mRNA"
  reference trick that redefined every gene body as one giant exon.
  ([10x algorithm](https://www.10xgenomics.com/support/software/cell-ranger/latest/algorithms-overview/cr-gex-algorithm),
  [10x intron-mode recommendation](https://www.10xgenomics.com/support/software/cell-ranger/latest/miscellaneous/cr-intron-mode-rec))
- **STARsolo:** use the **`GeneFull`** feature (counts reads overlapping the gene locus,
  exonic *and* intronic) instead of `Gene`. "GeneFull is useful for single-nucleus RNA-seq
  since the majority of RNAs in a nucleus are unspliced pre-mRNAs."
  ([STARsolo docs](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md))
- **alevin-fry / kb-python:** use the **nascent+ambiguous+spliced (USA / `nac`) index** so
  intronic reads are counted (this doubles as the RNA-velocity quant, §12).

**Processing delta #2 — inverted mitochondrial QC.** Nuclei should contain **almost no
mitochondrial transcripts** (mitochondria are cytoplasmic). So the scRNA rule "high %mito =
dying cell" **flips**: in a clean snRNA library any mito signal is read as **ambient/cytoplasmic
contamination**, and the %mito filter is set *much lower* (often ~1–5%, sometimes near 0). A
*low* nuclear-fraction / high-cytoplasmic signal flags a poorly-stripped or lysed nucleus.
([OSCA snRNA chapter](https://bioconductor.org/books/3.14/OSCA.advanced/single-nuclei-rna-seq-processing.html))

**Processing delta #3 — MALAT1 as a nuclear-quality marker.** The long nuclear-retained
lncRNA **MALAT1** is a positive marker of nuclear integrity; **low MALAT1** flags low-quality /
contaminated nuclei (and empty-droplet debris), and is used as a snRNA-specific QC axis
alongside genes/nucleus.
([nuclei-isolation comparison](https://www.cell.com/cell-reports-methods/fulltext/S2667-2375(26)00037-8))

**Processing delta #4 — ambient/empty-droplet behavior differs.** Ambient neuronal RNA is a
notorious snRNA problem: highly-expressed neuronal transcripts leak into the ambient pool and
can create phantom "cell types" or mask real ones in brain data, so **ambient-RNA removal
(SoupX/CellBender/DecontX) and stringent nuclear-fraction QC matter more** than in scRNA.
([neuronal ambient RNA](https://www.sciencedirect.com/science/article/pii/S0896627322008157),
[nuclear-fraction QC](https://link.springer.com/article/10.1186/s12864-024-11015-5))

**Marker-set caveat for downstream annotation.** Because cytoplasmically-localized transcripts
are under-recovered, marker panels validated on scRNA can partly disagree with snRNA; this is a
biology-of-the-modality effect, not a bug. ([OSCA snRNA](https://bioconductor.org/books/3.14/OSCA.advanced/single-nuclei-rna-seq-processing.html))

**Tools.** Cell Ranger `--include-introns` / STARsolo `GeneFull` / alevin-fry USA / kb `nac`;
CellBender/SoupX/DecontX for ambient; otherwise the standard Scanpy/Seurat path.

---

## 3. CITE-seq / feature barcoding — surface protein (ADT)

**What is measured.** Surface (epitope) **protein** abundance, read out as DNA: antibodies are
conjugated to an **antibody-derived tag (ADT)** oligo; the tag is captured and sequenced
alongside mRNA, giving *simultaneous* protein + transcriptome per cell. Introduced by
**Stoeckius et al., "Simultaneous epitope and transcriptome measurement in single cells,"
Nature Methods 2017** ([nmeth.4380](https://www.nature.com/articles/nmeth.4380)). Reagent
families: BioLegend **TotalSeq-A/-B/-C** (A = 3′ v2/v3, B = 3′ with capture-sequence, C = 5′).

**Raw data.** A **separate protein matrix** (proteins × cells) with 10x `feature_type =
Antibody Capture`, co-indexed by the same cell barcodes as the Gene Expression matrix. In 10x
outputs both modalities land in one `filtered_feature_bc_matrix` distinguished by `feature_type`
(configured via a **feature-reference CSV** naming each antibody's barcode). Panels are tens to
a few hundred antibodies (vs ~20k genes), so the matrix is small, dense, and high-count.

**Processing delta #1 — do NOT log-CPM normalize.** ADT counts have a very different noise
structure — a **negative peak** (non-specific antibody background) plus a **positive peak**
(real specific staining) — not the RNA negative-binomial. Two dedicated normalizations:
- **CLR (centered log-ratio):** divide each protein's count by the **geometric mean of all
  protein counts in that cell**, then log. Corrects sequencing depth; the classic Seurat
  default. ([sc-best-practices surface-protein normalization](https://www.sc-best-practices.org/surface_protein/normalization.html))
- **DSB (Denoise and Scale by Background)** — the dedicated ADT method (**Mulè et al.,
  Nature Communications 2022**). Two-step: (I) subtract **ambient/background protein** estimated
  from **empty droplets**, and (II) remove a per-cell technical component defined by
  **isotype-control antibodies** + each cell's background. Requires the **raw (unfiltered)
  matrix with empty droplets** and named isotype controls. `dsb::DSBNormalizeProtein(...,
  denoise.counts=TRUE, use.isotype.control=TRUE)` in R, `muon.prot.pp.dsb()` in Python.
  ([dsb CRAN/README](https://cran.r-project.org/web/packages/dsb/readme/README.html),
  [dsb GitHub](https://github.com/niaid/dsb))

**Processing delta #2 — isotype controls & separate QC.** Include **isotype-control antibodies**
(non-targeting, e.g. Mouse-IgG1) as an explicit background readout; QC the ADT modality on its
own axes (total ADT counts/cell, isotype-control level, fraction of a panel that is positive) —
these are *separate* from the RNA %mito/genes-per-cell QC. Ambient free-floating antibody in the
GEM is the dominant ADT artifact, which is exactly what empty-droplet-based DSB removes.

**Downstream.** RNA and protein are usually integrated by **WNN** (§9) or analyzed as parallel
embeddings; MuData/`.h5mu` holds `rna` + `prot` modalities (§9).

**Tools.** Cell Ranger feature-barcoding / CITE-seq-Count (quant); `dsb`, Seurat, `muon`
(`muon.prot`) for normalize/integrate.

---

## 4. Cell hashing / sample multiplexing (HTO)

**What is measured.** A **hashtag oligo (HTO)** — an ADT-like antibody-oligo against a
*ubiquitous* surface protein — applied **per sample before pooling**, so every cell carries a
tag identifying its sample of origin. **Stoeckius et al., "Cell Hashing…," Genome Biology 2018**
([s13059-018-1603-1](https://link.springer.com/article/10.1186/s13059-018-1603-1)). Chemistry
cousins: **MULTI-seq** (lipid/cholesterol-anchored barcodes), 10x **CellPlex**
(`Multiplexing Capture` / CMO). Purpose: **cut cost + control batch effects by pooling many
samples in one lane, AND get a "free" doublet detector.**

**Raw data.** A small **HTO matrix** (hashtags × cells), `feature_type = Antibody Capture` (or
`Multiplexing Capture` for CMOs), co-indexed with the GEX barcodes.

**Processing delta — a demultiplexing/classification step BEFORE normal QC.** This is the
defining delta: HTO counts are not a biological signal to normalize — they are used to
**classify each droplet** as *singlet(sample X)* / *doublet* / *negative(unknown)*. Per droplet,
separate the bound "positive" HTO from ambient "negative" HTOs; **1 positive ⇒ singlet assigned
to that sample; ≥2 positive ⇒ cross-sample doublet (dropped); 0 positive ⇒ negative/empty.**
This yields both sample assignment *and* an orthogonal doublet call that transcriptome-only
doublet finders miss.
([sc-best-practices; Seurat hashing vignette](https://satijalab.org/seurat/articles/hashing_vignette))

**Demux methods** (benchmarked in *NAR Genomics & Bioinformatics* 2023):
`HTODemux` (Seurat, k-medoids + negative-binomial thresholds), **HashSolo** (Bayesian, Scanpy),
`GMM-Demux` (Gaussian mixture), `demuxmix` (negative-binomial mixture, robust on low-quality
data), `deMULTIplex` (MULTI-seq), `hashedDrops` (DropletUtils), `BFF`. Finding: all agree when
labeling is clean; **bimodal-assuming methods degrade on low-quality HTO**, while `demuxmix`,
`GMM-Demux`, `HashSolo`, `HTODemux` stay consistent.
([HTO demux benchmark](https://academic.oup.com/nargab/article/5/4/lqad086/7306668))

**Design consequence.** Because pooled samples now share a lane, the **batch structure changes**
(one technical batch spanning many biological samples) — see §16.

---

## 5. Genetic demultiplexing (no hashing)

**What is measured.** Nothing extra is added at the bench — instead **natural SNP genotype
differences between donors** already present in the reads are used to assign pooled cells to
donors. The "modality" here is *variant information latent in the existing cDNA reads.*

**Raw data.** No new matrix; the input is the aligned **BAM + a list of common SNP loci** (e.g.
1000 Genomes/Genome-10K). A per-cell sparse genotype pileup (`cellSNP`/`vartrix`) is computed,
then clustered.

**Processing delta — an added variant-based demux + doublet step.** Insert, after alignment,
before QC:
- **demuxlet** — assigns cells to donors using **known reference genotypes**.
- **freemuxlet** — genotype-**free** demuxlet variant (only needs common SNP loci).
- **souporcell** — genotype-free SNP clustering (handles many donors; `souporcell3` scales to
  high donor counts). ([souporcell3](https://www.biorxiv.org/content/10.1101/2025.07.10.664218.full.pdf))
- **vireo** — genotype-free/partial/complete; pairs with `cellSNP`; benchmarks well without a
  genotype reference. ([vireo](https://github.com/single-cell-genetics/vireo))
- **scSplit** — genotype-free SNP-based demux.

All also **flag cross-donor doublets** (a droplet whose SNPs are a mixture of two genotypes),
giving another orthogonal doublet signal. Benefits over hashing: no extra reagents, no antibody
staining, works retrospectively; cost: only separates *genetically distinct* donors (useless for
replicates of one donor or one inbred strain).
([10x demux guide](https://www.10xgenomics.com/analysis-guides/bioinformatics-tools-for-sample-demultiplexing),
[model-species demux eval](https://www.life-science-alliance.org/content/6/8/e202301979))

---

## 6. scATAC-seq (chromatin accessibility)

**What is measured.** **Open (accessible) chromatin.** A hyperactive **Tn5 transposase**
inserts sequencing adapters into accessible DNA ("tagmentation"); each insertion pair defines a
**fragment**. Accessibility marks promoters, enhancers, and TF-bound regulatory DNA — a
*regulatory-potential* readout, complementary to expression.

**Raw data.** The canonical artifact is **`fragments.tsv.gz`** (+ `.tbi`): one line per unique
fragment = `chrom  start  end  cell_barcode  read_count`. From it you build a **count matrix**
whose features are **not genes** but genomic intervals:
- **peak × cell** (peaks called from the aggregate signal), and/or
- **tile/bin × cell** (fixed-width genome windows), and/or
- **gene-activity** matrix (accessibility summed over gene bodies ± promoter, to bridge to RNA).
Cell Ranger ATAC produces the fragments file, a peak matrix, and per-barcode QC.

**Processing delta #1 — features must be *defined*, not given.** Unlike RNA (genes are fixed),
ATAC has "no inherent biological unit," so a **peak-calling or tiling step is mandatory**:
**MACS2** on the aggregate/pseudobulk signal is the standard peak caller; ArchN/SnapATAC use
fixed tiles. ([sc-best-practices ATAC](https://www.sc-best-practices.org/chromatin_accessibility/introduction.html))

**Processing delta #2 — ATAC-specific QC vocabulary.** The RNA QC axes (%mito, genes/cell) are
replaced by:
- **TSS enrichment** — accessibility signal at transcription start sites vs flanks; a global
  signal-to-noise measure (`Signac::TSSEnrichment()`; ENCODE-style threshold e.g. **> 4**).
- **Nucleosome signal / banding** — ratio of mono-nucleosomal to nucleosome-free fragment
  lengths per cell; healthy libraries show clear ~147 bp periodicity
  (`Signac::NucleosomeSignal()`; e.g. keep **< 4**).
- **FRiP (fraction of reads in peaks)** = `peak_region_fragments / passed_filters`; low FRiP
  (<15–20%) = noisy cell (e.g. keep **> 40%**).
- **Fragments per cell / unique fragments** (depth), and **blacklist ratio** (fraction in ENCODE
  blacklist regions, keep small).
([Signac PBMC vignette](https://stuartlab.org/signac/articles/pbmc_vignette))

**Processing delta #3 — normalization & DR are TF-IDF + LSI, not log-PCA.** ATAC matrices are
**near-binary and extremely sparse** (a diploid locus has at most 2 copies), so:
- **binarize** (presence/absence; ArchR default), then
- **TF-IDF** (term-frequency–inverse-document-frequency) to up-weight rare informative peaks
  (`RunTFIDF`), then
- **SVD → LSI (latent semantic indexing)** as the dimensionality reduction (`RunSVD`);
  **component 1 usually correlates with depth and is dropped** before neighbors/clustering.
([Signac vignette](https://stuartlab.org/signac/articles/pbmc_vignette))

**Tools.** Cell Ranger ATAC (quant); **Signac** (Seurat-based, R), **ArchR** (scalable to >1M
cells, tile-based, R), **SnapATAC2** (Python, peak-independent). Motif/TF activity via
chromVAR; peak calling via MACS2.

---

## 7. Multiome (joint 10x ATAC + Gene Expression in one cell)

**What is measured.** **Both** open chromatin **and** gene expression **from the same nucleus**,
so RNA and ATAC share **one cell barcode** — a true paired multimodal readout (10x Chromium
Single Cell Multiome ATAC + GEX; processed with **Cell Ranger ARC**).

**Raw data.** Two matrices sharing barcodes: a **GEX (Gene Expression)** matrix *and* an **ATAC
fragments file + peak matrix**, plus a linking that lets you place both on the same cells.
Commonly serialized as **MuData / `.h5mu`** with `rna` and `atac` modalities, or a Seurat object
with two assays.

**Processing delta #1 — joint QC on both modalities.** A cell must pass *both* the RNA QC (genes,
%mito) *and* the ATAC QC (TSS enrichment, nucleosome signal, FRiP, fragments) — the intersection
of two QC vocabularies. Since it is snRNA on the GEX side, the §2 snRNA rules (intron-inclusive
quant, low-mito interpretation) apply to the RNA half.

**Processing delta #2 — integration is WNN, not concatenation.** Each modality is normalized in
its own space (RNA: log/SCT → PCA; ATAC: TF-IDF → LSI), then combined by **Weighted Nearest
Neighbor (WNN)**: WNN learns a **per-cell weight for each modality** (some cells are better
separated by RNA, others by ATAC) and builds one joint neighbor graph used for a single
clustering/UMAP. Implemented in **Seurat** (WNN) and **muon** (`muon` WNN).
([Signac multiomic](https://stuartlab.org/signac/articles/pbmc_multiomic),
[muon/MuData](https://muon.readthedocs.io/en/latest/omics/multi.html))

**Processing delta #3 — cross-modal linking.** With RNA + ATAC in the same cell you can compute
**peak-to-gene links** (enhancer→gene) and gene-regulatory inference (e.g. ArchR/Signac
`LinkPeaks`, SCENIC+), a *possibility* unavailable to either modality alone.

**Data structure note (MuData).** MuData holds several modalities, **each as its own AnnData**
(`mdata.mod['rna']`, `['prot']`, `['atac']`), persisted to `.h5mu` (HDF5). It's the Python
multimodal analog of AnnData/Scanpy; `muon` supplies the per-modality preprocessing + WNN/MOFA
integration.
([muon docs](https://muon.readthedocs.io/en/latest/omics/multi.html))

---

## 8. V(D)J / immune repertoire (TCR / BCR)

**What is measured.** The **rearranged adaptive-immune receptor** sequence of each T cell (TCR
α/β) or B cell (BCR heavy/light) — the V(D)J recombination product that defines a **clonotype**.
Typically run as an **add-on to 5′ GEX** (5′ chemistry is required to capture the variable
region), giving paired transcriptome + receptor per cell.

**Raw data — NOT a count matrix.** The V(D)J library is assembled into **contigs**, yielding a
**`filtered_contig_annotations.csv`** (10x `cellranger vdj`): per cell/barcode, the assembled
V/D/J gene usage, CDR3 nucleotide/amino-acid sequence, chain (TRA/TRB/IGH/IGK/IGL),
productive flag, and a **clonotype ID**. The "feature" is a **categorical clonotype**, not a
gene — so this modality is *joined onto* the GEX object rather than normalized.

**Processing delta.** No normalization/HVG/PCA on the receptor data itself. Instead: contig QC
(keep productive, correctly-paired chains; drop multiplets with >2 chains), **clonotype
definition** (identical CDR3 / V-J usage; or somatic-hypermutation-aware clonal families for
BCR), then **repertoire statistics** (clonal expansion, diversity, gene usage, overlap) mapped
back onto the transcriptomic clusters by barcode.

**Tools.** `cellranger vdj` (assembly); **scirpy** (Scanpy/AnnData ecosystem, Python),
**scRepertoire** (Seurat ecosystem, R), **Dandelion** (BCR/TCR contig pipeline + V(D)J feature
space + trajectory; Python, with `dandelionR`).
([single-cell immune repertoire analysis, Nat Methods](https://www.nature.com/articles/s41592-024-02243-4),
[Dandelion, Nat Biotech](https://www.nature.com/articles/s41587-023-01734-7))

---

## 9. Perturb-seq / CROP-seq / ECCITE-seq (CRISPR guide capture)

**What is measured.** A pooled **CRISPR perturbation** delivered per cell, read out as its
**sgRNA/guide identity**, paired with the transcriptome — so you learn each guide's effect on
expression (a single-cell functional-genomics screen). Variants: **Perturb-seq / CRISP-seq**
(barcoded guide cassette), **CROP-seq** (guide itself becomes a polyadenylated, capturable
transcript), **direct-capture Perturb-seq** (guide-specific RT primers capture the sgRNA
directly), **ECCITE-seq** (adds surface protein + HTO on top — expressed CRISPR + CITE-seq).

**Raw data.** A **guide × cell matrix** with 10x `feature_type = CRISPR Guide Capture`,
co-indexed with GEX and defined by a feature-reference CSV of protospacer barcodes.
([10x CRISPR algorithm](https://www.10xgenomics.com/support/software/cell-ranger/latest/algorithms-overview/cr-crispr-algorithm))

**Processing delta — a *guide-assignment* step.** Before any expression analysis you must
**assign each cell its guide(s)**: threshold guide UMIs to call which protospacer(s) a cell
carries, then classify cells as **single-guide** (usable), **multi-guide** (often excluded, or
kept for combinatorial screens), or **no-guide** (dropped). MOI and background guide reads make
this thresholding a real analysis choice (mixture models, e.g. the guide-assignment step in
Cell Ranger / `mixscape` in Seurat / `pertpy` in Python). Downstream is **perturbation vs
control differential expression** (often with `mixscape`/`MELD`/`pertpy`), not ordinary
clustering.

**Tools.** Cell Ranger feature-barcoding (`CRISPR Guide Capture`); Seurat `mixscape`; **pertpy**
(Python perturbation toolbox). ([direct-capture Perturb-seq](https://pmc.ncbi.nlm.nih.gov/articles/PMC7416462/))

---

## 10. Lineage tracing / clonal barcoding (CellTag, LARRY, GESTALT)

**What is measured.** A heritable, **expressed DNA barcode** integrated into a founder cell and
inherited by all its progeny — so cells sharing a barcode form a **clone**, letting you
reconstruct lineage/fate maps alongside transcriptomic state.
- **LARRY** (Lineage And RNA RecoverY) — a static, high-diversity expressed-barcode library read
  out by scRNA-seq for clonal tracking.
- **CellTag** — lentiviral GFP-3′UTR random barcodes; sequential rounds ("CellTag-multi")
  give multi-timepoint lineage; captured across modalities.
- **GESTALT** — a CRISPR-edited synthetic target array that *accumulates* edits over time
  (a "recording" barcode), giving a phylogeny rather than a static clone ID.
([lineage barcoding review](https://pmc.ncbi.nlm.nih.gov/articles/PMC11694748/),
[CellTag-multi, Nat Biotech](https://www.nature.com/articles/s41587-023-01931-4))

**Raw data & processing delta.** The barcode is an **expressed transcript**, so it can ride the
same cDNA library (sometimes a dedicated barcode-enrichment library). Processing adds a
**barcode-extraction + error-correction + clone-calling** step (collapse sequencing errors,
assign each cell a clone ID, drop ambiguous/multi-barcode cells), then map clones onto the
transcriptomic embedding. For recording barcodes (GESTALT) the extra step is **phylogenetic
reconstruction** from the edit patterns. As with V(D)J and guides, the barcode is a *categorical
label joined onto* the expression matrix, not a normalized feature.

---

## 11. RNA velocity data (spliced / unspliced) — a *quantification-time* choice

**What is measured.** The **ratio of unspliced (intron-containing, nascent) to spliced (mature)
mRNA** per gene per cell, which encodes transcriptional dynamics — from which future cell state
("velocity") is inferred.

**The key point: it is a processing decision made at QUANT time, not a wet-lab modality.** You
get velocity from an *ordinary* scRNA/snRNA library **only if you quantify spliced and unspliced
counts separately.** So the choice happens in the aligner:
- **velocyto** — original tool; emits a **`.loom`** with `spliced`/`unspliced`/`ambiguous` layers.
- **STARsolo `--soloFeatures Velocyto`** — spliced/unspliced/ambiguous counting in STAR.
- **kb-python / kallisto|bustools `--workflow nac`** (nascent+ambiguous+cytoplasmic) — the
  intron-aware index that also serves snRNA.
- **alevin-fry USA mode** — **S**pliced/**U**nspliced/**A**mbiguous per gene from a
  `splici`/`spliceu` index.
The output is stored as **AnnData `layers['spliced']` / `layers['unspliced']`** (or loom
layers) alongside `.X`. Downstream: **scVelo** (steady-state / dynamical / stochastic models);
whole *unprocessed* counts are recommended input.
([sc-best-practices RNA velocity](https://www.sc-best-practices.org/trajectories/rna_velocity.html),
[preprocessing affects velocity, PLoS CB](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008585))

**Processing delta.** If you didn't run a spliced/unspliced-aware quantifier you **cannot**
add velocity later without re-quantifying from FASTQ/BAM — so this must be decided up front. (It
also couples to snRNA: the same intron-aware indices power both.)

---

## 12. Full-length vs 3′/5′-tag — the "possibilities" ceiling

The **chemistry** (`02-platforms.md`) sets a hard ceiling on what the data *can* answer, which
in turn changes processing:

**3′ / 5′ UMI-tag (droplet, e.g. 10x).** You sequence a **UMI + a short end-tag** of each
molecule. Great for **gene-level counting across many cells** with PCR-bias control (UMIs), but
you see only one end — so **isoform, fusion, and most allele-specific/SNP information is not
recoverable.** 5′ tagging is required to reach the V(D)J variable region (§8).

**Full-length (plate, Smart-seq2/3, FLASH-seq).** Reads cover the **entire transcript**, so the
data *can* resolve **splice isoforms, allele-specific expression (via SNPs), and transcribed
variants** — but at low throughput/high cost, and **Smart-seq2 has no UMIs/cell-barcodes**
(gene-level quant is noisier, no in-droplet multiplexing). **Smart-seq3** adds a **5′ UMI** on
top of full-length coverage, reconstructing molecules and assigning a majority to allelic origin
and many to specific isoforms.
([Smart-seq3, Nat Biotech](https://www.nature.com/articles/s41587-020-0497-0),
[full-length vs tag guide](https://alitheagenomics.com/blog/what-is-the-difference-between-smart-seq2-smart-seq3-and-flash-seq-for-full-length-single-cell-rna-seq))

**Processing delta.** Full-length data uses a **standard bulk-RNA-style aligner + transcript
quantifier** (STAR + RSEM/Salmon, or per-cell featureCounts) with **no UMI collapsing** (SS2),
and can run **isoform/allele** quantifiers — a different quant stack from the UMI/barcode
droplet pipeline. Downstream normalization must account for **transcript-length** (TPM), which
UMI 3′ data does *not*.

---

## 13. Species & reference considerations

The **reference genome + annotation** you quantify against is itself a processing choice that
gates correctness:

- **Human / mouse.** Standard references: **GENCODE** or **Ensembl** genome + GTF (Cell Ranger
  ships pre-built human/mouse refs). Annotation version affects gene counts and must be pinned
  for reproducibility (`05-tools-and-parameters.md`).
- **Mixed-species "barnyard" runs.** Cells of two species (usually human + mouse) are mixed and
  aligned to a **combined reference**; a cell whose reads map to *both* species is a **doublet**
  ("barnyard plot"), giving an empirical **doublet/collision-rate** estimate that scales with
  loading concentration. Cutoff convention: assign to a species only if **>~70%** of reads map
  to one genome, else discard.
  ([barnyard/mixing](https://divingintogeneticsandgenomics.com/post/mixing-mouse-and-human-10x-single-cell-rnaseq-data/),
  [scRNA tech intro](https://liorpachter.wordpress.com/2019/02/19/introduction-to-single-cell-rna-seq-technologies/))
- **Custom references.** To detect **transgenes, reporters (GFP/mCherry), CAR constructs,
  viral genomes, or knock-in cassettes**, you must **add those sequences to the reference +
  GTF** before quantification — otherwise those reads are silently lost. Same mechanism used for
  lineage-barcode / guide constructs when captured in the main library.
- **pre-mRNA / intron-inclusive references.** The snRNA requirement of §2 — historically a
  hand-built "whole gene body as one exon" reference, now the built-in `--include-introns` /
  `GeneFull` path.
- **Non-model organisms.** Poorer annotations ⇒ more reads unassigned; often need a
  de-novo/community GTF, `GeneFull`-style whole-locus counting, or ortholog mapping — expect
  lower genes/cell and annotation-quality-limited results.

---

## 14. Experimental-design possibilities (what drives INTEGRATION)

Design structure is not a "modality" but it is the biggest determinant of *whether the
downstream path needs batch integration*, so processing must know it up front:

- **Single sample vs multi-sample.** One sample → straight cluster/annotate. Multiple samples
  captured/processed separately → **technical batch effects** that usually require integration
  (Harmony, scVI, Scanorama, Seurat CCA/RPCA — see `05-tools-and-parameters.md`) before joint
  clustering, or clusters will split by batch rather than biology.
- **Conditions / treatments.** Case vs control, timepoints, doses — the *biological* signal you
  want to preserve while removing technical batch. The confound to avoid: **if condition is
  perfectly confounded with batch** (e.g. all controls run on day 1, all treated on day 2) you
  can't separate them — integration can't rescue a broken design.
- **Donors / replicates.** Biological replication is what powers **differential-abundance** and
  **pseudobulk differential-expression** downstream; pooling donors also enables the genetic
  demux of §5 and better ambient/doublet estimation.
- **Multiplexing changes batch structure.** Hashing (§4) / genetic demux (§5) let many samples
  share **one lane** → they share technical batch (good: removes per-sample capture batch;
  consequence: the "batch" is now the pool, and cross-sample doublets must be removed first).

**Rule of thumb the pipeline encodes:** *count the batches, count the biological groups, check
they aren't confounded* → this decides whether an integration step is inserted between
normalization and clustering in `04-pipeline-steps.md`.

---

## 15. Spatial as a modality (pointer)

Spatial transcriptomics is best treated as **a modality with an extra coordinate/image channel**,
and it splits into two data-possibility regimes that change processing very differently:

- **Spot / bin-level (sequencing-based: Visium, Slide-seq, Stereo-seq, Visium HD).** Each spot is
  a **mixture of several cells**, so the defining extra step is **deconvolution / mapping**
  (cell2location, RCTD, Cell2Location, Tangram, stereoscope) against a matched scRNA reference —
  the matrix is genes × spots plus (x,y) + a tissue image.
- **Single-cell / subcellular in-situ (imaging-based: Xenium, MERSCOPE/MERFISH, CosMx, seqFISH).**
  Targeted gene panels imaged in place; the defining extra step is **cell segmentation** (assign
  transcripts to cell boundaries) — the matrix is genes × segmented-cells plus per-molecule
  coordinates.

Everything about the coordinate frame, image registration, segmentation, deconvolution,
neighborhood/niche analysis, and the tool stack (Squidpy, Giotto, `spatialdata`) lives in
**`06-spatial-processing.md`** — see there, not here.

---

## 16. Summary table

| Modality | Raw data artifact (`feature_type` / files) | Special processing vs standard scRNA | Key tools |
|---|---|---|---|
| **scRNA-seq** (baseline) | genes × cells; `Gene Expression`; `filtered_feature_bc_matrix`, raw matrix, BAM | *(the reference path)*: align to spliced ref → cell-call → %mito/genes QC → log-normalize → HVG/PCA/cluster | Cell Ranger, STARsolo, alevin-fry, Scanpy/Seurat |
| **snRNA-seq** | genes × nuclei; `Gene Expression` | **intron-inclusive ref** (`--include-introns` / `GeneFull` / USA); **low-%mito = contamination** (inverted); **MALAT1** QC; heavier ambient removal | Cell Ranger `--include-introns`, STARsolo `GeneFull`, CellBender/SoupX |
| **CITE-seq protein (ADT)** | proteins × cells; **`Antibody Capture`**; feature-ref CSV | **CLR or DSB** (not log-CPM); **isotype controls**; empty-droplet background; separate ADT QC | CITE-seq-Count, `dsb`, muon (`prot`), Seurat |
| **Cell hashing (HTO)** | hashtags × cells; `Antibody Capture` / `Multiplexing Capture` | **demux classify singlet/doublet/negative** before QC; cross-sample doublet removal | HTODemux, HashSolo, GMM-Demux, demuxmix |
| **Genetic demux** | *no new matrix*; BAM + SNP loci → per-cell pileup | added **SNP-based donor assignment + cross-donor doublet** step | demuxlet/freemuxlet, souporcell, vireo(+cellSNP), scSplit |
| **scATAC-seq** | **`fragments.tsv.gz`** + peak/tile × cells matrix | **peak calling (MACS2)**; QC = **TSS enrich / nucleosome signal / FRiP / fragments**; **binarize → TF-IDF → LSI** (drop LSI-1) | Cell Ranger ATAC, Signac, ArchR, SnapATAC2 |
| **Multiome (ATAC+GEX)** | GEX matrix **+** ATAC fragments/peaks, **shared barcode**; `.h5mu` | **joint QC (both)**; **WNN** integration; peak-to-gene links | Cell Ranger ARC, Seurat WNN, Signac, muon/MuData |
| **V(D)J (TCR/BCR)** | **`filtered_contig_annotations.csv`**, clonotypes (with 5′ GEX) | contig QC + **clonotype/clonal-family calling**; join to GEX (categorical, no normalize) | `cellranger vdj`, scirpy, scRepertoire, Dandelion |
| **Perturb-seq / CROP / ECCITE** | guides × cells; **`CRISPR Guide Capture`** | **guide assignment** (single/multi/none) threshold; perturbation-vs-control DE | Cell Ranger, mixscape, pertpy |
| **Lineage / clonal barcode** | expressed barcode transcript (main or enrichment library) | **barcode extraction + error-correct + clone-calling**; (GESTALT: phylogeny); join to GEX | LARRY, CellTag(-multi), GESTALT tooling |
| **RNA velocity** | `spliced`/`unspliced`/`ambiguous` **layers**/loom | **quant-time choice**: run a splice-aware quantifier; must decide up front | velocyto, STARsolo `Velocyto`, kb `nac`, alevin-fry USA → scVelo |
| **Full-length (Smart-seq2/3)** | per-cell transcript quant; **no UMI/barcode (SS2)** | bulk-style transcript/isoform/**allele** quant; length-normalize (TPM); no UMI collapse | STAR+RSEM/Salmon, Smart-seq3 UMI stack |
| **Species/reference** | choice of genome+GTF; combined ref for barnyard; custom transgene ref | pin GENCODE/Ensembl; **barnyard doublet %**; add transgenes/reporters/CAR; pre-mRNA ref | Cell Ranger `mkref`, combined refs |
| **Design/batch** | *metadata*, not a matrix | drives whether an **integration** step is inserted; watch condition↔batch confounding | Harmony, scVI, Scanorama, Seurat CCA/RPCA (`05`) |
| **Spatial** | genes × spots/cells **+ (x,y) + image** | **deconvolution** (spot) or **segmentation** (in-situ) — see `06` | Squidpy, cell2location, RCTD, `spatialdata` (`06`) |

---

## Sources

- [Stoeckius et al. 2017, "Simultaneous epitope and transcriptome measurement in single cells," Nature Methods (CITE-seq)](https://www.nature.com/articles/nmeth.4380) — the original CITE-seq / ADT paper.
- [Stoeckius et al. 2018, "Cell Hashing…," Genome Biology](https://link.springer.com/article/10.1186/s13059-018-1603-1) — HTO multiplexing + doublet detection.
- [sc-best-practices: surface-protein normalization](https://www.sc-best-practices.org/surface_protein/normalization.html) — CLR vs DSB, ADT noise structure, isotype controls, empty-droplet background.
- [`dsb` package README (niaid/CRAN)](https://cran.r-project.org/web/packages/dsb/readme/README.html) and [dsb GitHub](https://github.com/niaid/dsb) — DSB two-step denoise (empty-droplet ambient + isotype technical), Mulè et al. Nat Commun 2022.
- [Seurat hashing vignette](https://satijalab.org/seurat/articles/hashing_vignette) — HTODemux singlet/doublet/negative classification.
- [HTO demultiplexing benchmark, NAR Genomics & Bioinformatics 2023](https://academic.oup.com/nargab/article/5/4/lqad086/7306668) — HTODemux/HashSolo/GMM-Demux/demuxmix/BFF comparison.
- [10x: Bioinformatics tools for sample demultiplexing](https://www.10xgenomics.com/analysis-guides/bioinformatics-tools-for-sample-demultiplexing) — demuxlet/freemuxlet/souporcell/vireo/scSplit overview.
- [vireo GitHub](https://github.com/single-cell-genetics/vireo) and [souporcell3 preprint](https://www.biorxiv.org/content/10.1101/2025.07.10.664218.full.pdf) — genotype-free SNP demux + cross-donor doublets.
- [10x Cell Ranger GEX algorithm](https://www.10xgenomics.com/support/software/cell-ranger/latest/algorithms-overview/cr-gex-algorithm) and [intron-mode recommendation](https://www.10xgenomics.com/support/software/cell-ranger/latest/miscellaneous/cr-intron-mode-rec) — `--include-introns`, 20–40% intronic reads, v7+ default-on.
- [STARsolo docs (alexdobin/STAR)](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md) — `GeneFull` (intron-inclusive, snRNA) and `Velocyto` (spliced/unspliced/ambiguous) features.
- [OSCA advanced: single-nuclei RNA-seq processing](https://bioconductor.org/books/3.14/OSCA.advanced/single-nuclei-rna-seq-processing.html) — snRNA low-mito interpretation and marker-set caveats.
- [Nuclei-isolation comparison, Cell Reports Methods 2026](https://www.cell.com/cell-reports-methods/fulltext/S2667-2375(26)00037-8) — MALAT1 as nuclear-quality QC marker.
- [Neuronal ambient RNA in snRNA, Neuron 2022](https://www.sciencedirect.com/science/article/pii/S0896627322008157) and [nuclear-fraction QC, BMC Genomics 2024](https://link.springer.com/article/10.1186/s12864-024-11015-5) — snRNA ambient contamination + nuclear-fraction filtering.
- [sc-best-practices: chromatin accessibility (ATAC)](https://www.sc-best-practices.org/chromatin_accessibility/introduction.html) — fragments, peaks vs tiles, TF-IDF/LSI, MACS2, sparsity/binarization.
- [Signac PBMC scATAC vignette](https://stuartlab.org/signac/articles/pbmc_vignette) — exact QC (`TSSEnrichment`, `NucleosomeSignal`, FRiP `pct_reads_in_peaks`, blacklist) + `RunTFIDF`/`RunSVD` and dropping LSI component 1.
- [Signac 10x multiomic vignette](https://stuartlab.org/signac/articles/pbmc_multiomic) and [ArchR, Nat Genet 2021](https://www.nature.com/articles/s41588-021-00790-6) — joint ATAC+GEX, WNN, ArchR scale.
- [muon / MuData docs](https://muon.readthedocs.io/en/latest/omics/multi.html) — `.h5mu` multimodal container (rna/prot/atac each an AnnData), WNN + MOFA.
- [Single-cell immune repertoire analysis, Nat Methods 2024](https://www.nature.com/articles/s41592-024-02243-4) and [Dandelion, Nat Biotech 2023](https://www.nature.com/articles/s41587-023-01734-7) — scirpy/scRepertoire/Dandelion, contig annotations, clonotypes, 5′ pairing.
- [10x Cell Ranger CRISPR Guide Capture algorithm](https://www.10xgenomics.com/support/software/cell-ranger/latest/algorithms-overview/cr-crispr-algorithm) and [direct-capture Perturb-seq, Mol Cell 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7416462/) — `CRISPR Guide Capture` feature type, guide assignment, CROP-seq/direct-capture.
- [Prospective lineage barcoding review, Genome Research 2024/PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11694748/) and [CellTag-multi, Nat Biotech 2023](https://www.nature.com/articles/s41587-023-01931-4) — LARRY / CellTag / GESTALT expressed-barcode lineage tracing.
- [sc-best-practices: RNA velocity](https://www.sc-best-practices.org/trajectories/rna_velocity.html) and [preprocessing affects velocity, PLoS Comp Biol 2021](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008585) — spliced/unspliced layers; velocyto / STARsolo Velocyto / kb `nac` / alevin-fry USA as quant-time choices.
- [Smart-seq3, Nat Biotech 2020](https://www.nature.com/articles/s41587-020-0497-0) and [full-length vs 3′/5′ tag explainer](https://alitheagenomics.com/blog/what-is-the-difference-between-smart-seq2-smart-seq3-and-flash-seq-for-full-length-single-cell-rna-seq) — isoform/allele possibilities of full-length; UMI-tag limits of droplet 3′/5′.
- [Barnyard mixing walkthrough](https://divingintogeneticsandgenomics.com/post/mixing-mouse-and-human-10x-single-cell-rnaseq-data/) and [Pachter, intro to scRNA-seq technologies](https://liorpachter.wordpress.com/2019/02/19/introduction-to-single-cell-rna-seq-technologies/) — mixed-species doublet/collision QC, combined references, >70% assignment rule.
- [Evaluation of genetic demultiplexing in model species, Life Science Alliance 2023](https://www.life-science-alliance.org/content/6/8/e202301979) — demux applicability across species/replicate structure.
