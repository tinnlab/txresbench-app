# 02 — Experimental Platforms & Technologies for Single-Cell and Spatial Transcriptomics

> **Scope.** This document is the platform/technology reference for the
> data-processing research folder. It catalogs **every major experimental
> platform that produces single-cell or spatial transcriptomic data**, and for
> each one describes: vendor/origin + key paper, the capture chemistry/mechanism,
> resolution (single-cell vs spot vs subcellular), targeted-panel vs
> whole-transcriptome, throughput, modalities captured, the official
> pipeline/software, and the **output artifact** it produces.
>
> **Cross-references (do not duplicate here):**
> - Output-format internals (HDF5 `.h5`/`.h5ad`, MatrixMarket `.mtx`, `.parquet`,
>   `.zarr`, `.gef`/`.gem`, DCC/PKC, Loupe/`.cloupe`) → **`01-file-formats.md`**.
> - Non-RNA modality detail (ADT/protein, HTO/hashing, ATAC, V(D)J, CRISPR) →
>   **`03-modalities.md`**.
> - Spatial-specific processing (binning, segmentation, registration,
>   deconvolution) → **`06-spatial-processing.md`**.
>
> The single most important cross-cutting idea: **the chemistry determines what
> the processing code must do.** 3′ vs 5′ changes where the barcode/UMI sit;
> probe-based vs poly(dT) changes whether you can even see novel/intronic
> transcripts; targeted panels remove genome-wide QC; nuclei vs cells changes the
> reference and the ambient/empty-droplet model. Those "chemistry differences that
> matter for processing" are called out per-platform and summarized in
> [§10](#10-chemistry-differences-that-matter-for-processing).

---

## 0. Taxonomy — the five families

Single-cell/spatial transcriptomics platforms fall into five mechanistically
distinct families. Everything below is organized by these:

| Family | How cells are separated & barcoded | Representative platforms |
|---|---|---|
| **A. Droplet / bead (microfluidic)** | One cell + one barcoded bead co-encapsulated in an oil droplet | 10x Chromium (3′/5′/Flex/Multiome), Drop-seq, inDrop, PIPseq |
| **B. Combinatorial-indexing / split-pool** | No physical isolation — cells cycle through plates, accreting a unique barcode combination | Parse Evercode, SPLiT-seq, sci-RNA-seq(3), Scale Bio, BD Rhapsody (microwell hybrid), Seq-Well |
| **C. Plate-based / full-length** | One cell per well (FACS), full-length cDNA | Smart-seq2/3, CEL-seq2, MARS-seq2 |
| **D. Spatial — sequencing/capture-based** | Tissue laid on a spatially-barcoded surface (spots/beads/DNB); location = barcode | Visium, Visium HD, Slide-seq/Curio, Stereo-seq, Open-ST, HDST, DBiT-seq, Pixel-seq |
| **E. Spatial — imaging/in-situ** | RNA counted *in place* by cyclic fluorescence; no dissociation, no sequencing of the transcript itself (imaging platforms) | Xenium, MERSCOPE/MERFISH, CosMx SMI, GeoMx DSP, seqFISH+, STARmap, ISS/HybISS, CODEX/PhenoCycler (protein) |

Families A/B/C dissociate the tissue and lose spatial context but recover the
(near-)whole transcriptome per cell. Family D keeps location but at spot/bin
resolution and (mostly) genome-wide capture. Family E keeps subcellular location
but is (mostly) a **targeted panel** read by microscope, not by sequencer.

---

## A. Droplet / bead single-cell platforms

### A1. 10x Genomics Chromium 3′ Gene Expression (v2 / v3 / v3.1 / GEM-X v4)

- **Vendor/origin:** 10x Genomics. Commercial descendant of GemCode; the market
  standard for scRNA-seq. ([Chromium 3′ library structure](https://teichlab.github.io/scg_lib_structs/methods_html/10xChromium3.html))
- **Mechanism.** A gel bead carrying ~750,000 copies of a barcoded oligo (a 16 bp
  **cell barcode** shared by all oligos on that bead + a per-oligo **UMI** +
  a 30 bp **poly(dT)** capture) is co-encapsulated with one cell in a GEM (Gel
  bead-in-EMulsion). Gel dissolves → poly(dT) captures poly-adenylated mRNA →
  reverse transcription tags every molecule with (barcode, UMI). The **3′ end** of
  the transcript is captured/sequenced.
- **Chemistry versions (matters for processing):**
  - **v2** — 16 bp barcode, **10 bp UMI**, whitelist `737K-august-2016`.
  - **v3 / v3.1** — 16 bp barcode, **12 bp UMI**, whitelist `3M-february-2018`;
    higher sensitivity; v3.1 adds dual indexing + is the CellPlex/feature-barcode
    workhorse.
  - **GEM-X 3′ v4** (2024, on Chromium X) — **same library structure** as
    v3/v3.1 but a **new 16 bp barcode whitelist** shipped in **Cell Ranger
    ≥ 8.0.1**; ~50–100 % more genes and up to ~2.5× more transcripts/cell at
    matched depth, lower multiplet rate. **Does not support CellPlex.**
    ([Cell Ranger supported libraries](https://www.10xgenomics.com/support/software/cell-ranger/latest/resources/supported-libraries),
    [GEM-X v4 vs v3.1](https://www.omicsempower.com/blog/what-is-gem-x-v4-single-cell-rna-sequencing/),
    [GEM-X v4 user guide](https://www.10xgenomics.com/support/universal-three-prime-gene-expression/documentation/steps/library-prep/chromium-gem-x-single-cell-3-v4-gene-expression-user-guide))
- **Resolution / scope:** single **cell or nucleus**; near-3′-tag whole
  transcriptome (poly(dT), so any polyadenylated gene, any species with a genome).
- **Throughput:** ~500–10,000+ cells per lane; Chromium X pushes ~20k+/lane.
- **Modalities / add-ons:** Feature Barcoding — **CITE-seq** cell-surface protein
  (ADT, TotalSeq-B) and **Cell Hashing / CellPlex** sample multiplexing (HTO/CMO),
  plus **CRISPR** guide capture. (See `03-modalities.md`.)
- **Pipeline:** **Cell Ranger** (`cellranger count` / `cellranger multi`). Also
  runnable open-source with **STARsolo**, **alevin-fry/salmon**, **kallisto|
  bustools** — but each needs the correct barcode whitelist + UMI length per
  chemistry.
- **Output:** filtered + raw **feature-barcode matrix** (`filtered_feature_bc_
  matrix.h5` + MatrixMarket trio), `molecule_info.h5`, a `web_summary.html`, a
  `possorted_genome_bam.bam`, and a `.cloupe`. Format internals → `01-file-formats.md`.

### A2. 10x Genomics Chromium 5′ Gene Expression + V(D)J Immune Profiling (v1 / v2 / v3)

- **Vendor/origin:** 10x Genomics.
  ([5′ library structure](https://teichlab.github.io/scg_lib_structs/methods_html/10xChromium5.html))
- **Mechanism.** Same GEM/gel-bead partitioning, but the barcode + UMI sit on a
  **barcoded Template-Switch Oligo (TSO)**; reverse transcriptase adds the TSO at
  the **5′ end** of the transcript (template switching, à la STRT-seq). So the
  cell barcode/UMI mark the **5′** end instead of the 3′ end.
- **Why 5′ exists — V(D)J.** Because the 5′ end is captured, full-length **V(D)J**
  segments of the **TCR/BCR** can be enriched by PCR off the constant region,
  giving **paired α/β (or heavy/light) immune-receptor sequences per cell** —
  impossible with 3′ chemistry. Optionally co-measures **cell-surface protein**
  (TotalSeq-C).
- **Resolution/scope:** single cell; 5′-tag GEX; up to ~80,000 T/B cells
  profiled per run for repertoire. ([5′ + V(D)J enrichment](https://www.kumc.edu/research/genome-sequencing-facility/services/10x-services/chromium-single-cell-5-and-v(d)j-enrichment.html),
  [5′ v2 surface-protein user guide](https://cdn.10xgenomics.com/image/upload/v1673041140/support-documents/CG000330_ChromiumNextGEMSingleCell5_v2_CellSurfaceProtein_UserGuide_RevF.pdf))
- **Modalities:** GEX + **V(D)J (TCR & BCR)** + surface protein.
- **Pipeline:** **Cell Ranger `multi`** (co-analyzes GEX + VDJ + Antibody Capture);
  `cellranger vdj` for the repertoire assembly (contigs, clonotypes).
- **Output:** GEX feature-barcode matrix **plus** VDJ outputs
  (`filtered_contig_annotations.csv`, `clonotypes.csv`, `airr_rearrangement.tsv`,
  consensus/contig FASTAs). *Processing note:* the barcode/UMI live at the 5′ end,
  so **strandedness** and reference-transcript orientation differ from 3′ —
  STARsolo needs the 5′ setting.

### A3. 10x Genomics Chromium Flex / Fixed RNA Profiling (FRP)

- **Vendor/origin:** 10x Genomics. FFPE-and-fixed-cell probe assay.
  ([What is Flex/FRP](https://www.10xgenomics.com/support/software/cell-ranger/latest/getting-started/cr-flex-what-is-frp),
  [FRP algorithm](https://www.10xgenomics.com/support/software/cell-ranger/8.0/algorithms-overview/cr-flex-frp-algorithm))
- **Mechanism (probe-based, NOT poly(dT)).** Pairs of **probes** hybridize to a
  fixed panel of transcripts; a ligation joins the two probe halves only when
  correctly paired; the ligated probe (not the mRNA) is captured in the GEM and
  sequenced. Because it targets a **predesigned whole-transcriptome probe set**
  (~18,000 human / ~20,000 mouse genes), it tolerates fixation/FFPE and
  degraded RNA.
- **Sample multiplexing (built in).** Each probe carries a **probe barcode**, so
  up to **16 samples** are pooled into one GEM well; the effective cell barcode =
  **GEM barcode + probe barcode**. Kits scale to 64- and 256-sample formats.
- **Resolution/scope:** single cell/nucleus, human or mouse only (probe set is
  species-specific), targeted-but-transcriptome-wide.
- **Pipeline:** **Cell Ranger `multi`** with a **probe-set reference** and a
  **probe aligner** (assigns reads to probe/gene IDs; no genome alignment).
  ([Flex with Cell Ranger multi](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/running-pipelines/cr-flex-multi-frp))
- **Output:** per-sample feature-barcode matrices (demultiplexed by probe
  barcode). *Processing note:* **no intronic reads / no RNA velocity / no novel
  transcripts** — you only ever see genes in the probe set.

### A4. 10x Genomics Chromium Single Cell Multiome ATAC + Gene Expression

- **Vendor/origin:** 10x Genomics (joint RNA + open-chromatin).
  ([What is Cell Ranger ARC](https://www.10xgenomics.com/support/software/cell-ranger-arc/latest/getting-started/what-is-cell-ranger-arc),
  [multiome library structure](https://scg-lib-structs.readthedocs.io/en/latest/multi/10x_multiome.html))
- **Mechanism.** **Nuclei** are transposed (Tn5, ATAC) then partitioned into GEMs
  whose gel bead carries **two** barcoded oligo types sharing a common cell
  barcode: a **poly(dT)** oligo for mRNA and an **8 bp spacer** oligo that captures
  Tn5-tagged genomic fragments. So **GEX and ATAC share the same cell barcode** →
  the two modalities are natively linked per nucleus.
- **Resolution/scope:** single **nucleus** only (chromatin requires nuclei);
  genome-wide RNA + genome-wide accessibility.
- **Pipeline:** **Cell Ranger ARC** (must analyze GEX **and** ATAC together; uses
  paired whitelists `737K-arc-v1`). Emits a `feature_linkage.bedpe` linking peaks
  to genes.
- **Output:** GEX `filtered_feature_bc_matrix` + ATAC `atac_fragments.tsv.gz` +
  ATAC peak matrix + per-barcode metrics; downstream in ArchR/Signac/muon.

### A5. Drop-seq (Macosko et al., 2015) — the academic droplet precursor

- **Origin:** Macosko et al., *Cell* 2015 (McCarroll/Regev labs, Broad/Harvard).
  ([Drop-seq, Wikipedia](https://en.wikipedia.org/wiki/Drop-Seq),
  [inDrops vs Drop-seq review](https://pubs.rsc.org/en/content/articlehtml/2017/lc/c7lc90070h))
- **Mechanism.** A custom microfluidic device co-flows a cell suspension and
  **barcoded polystyrene beads** in lysis buffer into an oil junction, forming
  droplets that each (ideally) contain one cell + one bead. Beads carry a
  split-pool-synthesized 12 bp cell barcode + 8 bp UMI + poly(dT). 3′ capture.
- **Scope/throughput:** single cell, 3′ whole-transcriptome (poly(dT));
  thousands of cells; low reagent cost; **hardware DIY**.
- **Pipeline:** **Drop-seq tools** (STAR-based) → digital gene expression (DGE)
  matrix. Also STARsolo (`--soloType CB_UMI_Simple` with the Drop-seq geometry).
- **Output:** a DGE text/`.mtx` matrix (genes × cells). Conceptual ancestor of 10x.

### A6. inDrop (Klein et al., 2015)

- **Origin:** Klein et al., *Cell* 2015 (Kirschner/Weitz labs, Harvard).
  ([Harvard inDrop/Drop-seq](https://www.rna-seqblog.com/harvard-groups-tap-microfluidics-for-single-cell-rna-seq-methods/))
- **Mechanism.** Uses **deformable hydrogel (acrylamide) beads** carrying
  photo-releasable barcoded primers; one bead + one cell per droplet; barcodes the
  mRNA; unlike Drop-seq, inDrop amplifies by **CEL-seq-style linear amplification
  (in-vitro transcription)** rather than PCR. 3′ + UMI.
- **Pipeline:** `indrops` pipeline (or zUMIs/STARsolo with the inDrop read
  geometry, which is more complex — a variable-length barcode split by a spacer).
- **Output:** count matrix. Commercialized briefly as 1CellBio.

### A7. Fluent BioSciences PIPseq — instrument-free droplets

- **Vendor/origin:** Fluent BioSciences; **Particle-templated Instant Partitions
  (PIPs)**, invented in the Abate lab (UCSF).
  ([PIPseq / templated emulsification, *Nat Biotech* 2023](https://www.nature.com/articles/s41587-023-01685-z),
  [GenomeWeb on PIP-seq](https://www.genomeweb.com/sequencing/fluent-biosciences-takes-single-cell-rna-seq-market-pip-seq-technology))
- **Mechanism.** **No microfluidic instrument.** Hydrogel **template particles**
  pre-loaded with barcoded capture oligos are simply **vortexed** with the cell
  suspension + oil; each particle templates a uniform droplet around one cell.
  Barcode + UMI + poly(dT), 3′ capture.
- **Scope/throughput:** single cell/nucleus, 3′ WT; kit tiers **T2 → T100** scale
  from thousands to hundreds of thousands of cells; CRISPR guide capture add-on.
  ([PIPseq T2 v4.0 user guide](https://www.fluentbio.com/wp-content/uploads/2024/02/PIPseq-T2-v4.0-Single-Cell-RNA-Kit-User-Guide-Rev-12.3.pdf))
- **Pipeline:** **PIPseeker** (Fluent) → feature-barcode matrix (10x-compatible
  outputs → Seurat/Scanpy).
- **Output:** `raw`/`filtered` matrices analogous to Cell Ranger.

---

## B. Combinatorial-indexing / split-pool platforms (instrument-free)

The unifying idea: **cells are the wells.** Fixed cells/nuclei are distributed
across a plate (round 1 barcode via well-specific RT), pooled, re-split (round 2),
pooled, re-split… After *n* rounds the **combination** of barcodes a cell
accreted is, with high probability, unique — so no physical single-cell isolation
or instrument is needed. Fixation makes these robust and shippable.

### B1. Parse Biosciences Evercode (WT Mini / WT / WT Mega)

- **Vendor/origin:** Parse Biosciences; commercialization of **SPLiT-seq**.
  ([Parse Evercode technology](https://www.parsebiosciences.com/technology/),
  [split-pool sensitivity, bioRxiv 2022](https://www.biorxiv.org/content/10.1101/2022.08.27.505512v1.full))
- **Mechanism.** Formaldehyde-**fixed** cells/nuclei go through **4 rounds** of
  split-pool barcoding (round 1 = in-cell barcoded RT with poly(dT) **and** random
  hexamers; rounds 2–3 = ligation; round 4 = sublibrary index). Cells act as
  reaction compartments. 3′-biased but includes gene-body signal via random
  hexamers.
- **Scope/throughput:** single cell/nucleus, fixed; **up to ~1,000,000 cells and
  96 samples** in one experiment on the **WT Mega** tier (WT Mini ≈ 10k cells; WT
  ≈ 100k–500k). Very **low doublet rate** and no instrument.
  ([1M-cell kit](https://www.rna-seqblog.com/parse-biosciences-unveils-1000000-cell-scrna-seq-kit/))
- **Modalities:** GEX; **Evercode TCR/BCR** immune repertoire; CRISPR detect.
- **Pipeline:** **`split-pipe`** (Parse) — demultiplexes the nested barcodes,
  aligns, and emits per-sample DGE matrices + AnnData.
  ([split-pipe usage](https://ngisweden.scilifelab.se/methods/parse/))
- **Output:** `DGE_filtered/` (matrix + `cell_metadata.csv` + `all_genes.csv`)
  per sample, AnnData-ready. *Processing note:* the barcode is a **concatenation
  across rounds**; sample identity is *encoded in the round-1 well*, so
  demultiplexing is barcode-combinatorial, not a separate HTO library.

### B2. SPLiT-seq (Rosenberg et al., 2018) — the academic origin

- **Origin:** Rosenberg, Roco et al., *Science* 2018 (Seelig lab, UW).
  ([SPLiT-seq, *Science*](https://www.science.org/doi/10.1126/science.aam8999),
  [PubMed](https://pubmed.ncbi.nlm.nih.gov/29545511/))
- **Mechanism.** Four rounds of split-pool barcoding of formaldehyde-fixed cells/
  nuclei; round 1 uses well-specific barcoded RT primers. Demonstrated 156,049
  nuclei / >100 cell types. Directly productized as Parse Evercode.

### B3. sci-RNA-seq / sci-RNA-seq3 (Cao, Shendure et al.)

- **Origin:** Cao et al. 2017 (sci-RNA-seq) and sci-RNA-seq3 (2019), Shendure lab
  (UW). ([sci-*/combinatorial indexing overview & optimization, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC9839601/))
- **Mechanism.** Single-cell **combinatorial indexing**: in-well barcoded RT →
  pool → redistribute → hairpin ligation / index → pool. **sci-RNA-seq3** is a
  three-level scheme enabling **millions** of nuclei (whole-organism atlases:
  *C. elegans*, mouse organogenesis). Nuclei-friendly. Related family members:
  sci-Plex (chemical screens), sci-fate (metabolic labeling), split-seq siblings.
- **Pipeline:** lab custom pipelines (e.g. the Shendure `sci-RNA-seq` pipeline,
  or bbi-sci); outputs standard cell × gene matrices.

### B4. Scale Biosciences

- **Vendor/origin:** Scale Bio; **commercial combinatorial-indexing** kit line
  (Quantum scRNA), a sibling approach to Parse. Instrument-free, fixation-based,
  scales to very large cell numbers; own analysis pipeline → matrices/AnnData.
  ([single-cell technology-group comparison, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2405844024043895))

### B5. BD Rhapsody (microwell + bead — a hybrid)

- **Vendor/origin:** BD Biosciences (Becton Dickinson).
  ([BD Rhapsody pipeline user guide](https://www.bdbiosciences.com/content/dam/bdb/marketing-documents/products-pdf-folder/software-informatics/rhapsody-sequence-analysis-pipeline/Rhapsody-Sequence-Analysis-Pipeline-UG.pdf),
  [pipeline steps 3.0](https://bd-rhapsody-bioinfo-docs.genomics.bd.com/steps/top_steps.html))
- **Mechanism.** Not droplets: a **microwell cartridge** (~200,000 picowells)
  captures single cells by gravity; a barcoded **magnetic bead** is loaded on top
  of each cell. The bead's cell label is built from **three barcode segments
  joined by fixed linkers** (a split-pool-synthesized label) + UMI + poly(dT).
- **Scope/throughput:** single cell/nucleus; **WTA** (whole-transcriptome) **or a
  targeted panel** (hundreds of genes). Targeted mode is a distinguishing BD
  feature.
- **Modalities:** **AbSeq** (oligo-conjugated antibody protein), **Sample Tags**
  (SMK sample multiplexing), **VDJ (TCR/BCR)**, and **ATAC**.
- **Pipeline:** **BD Rhapsody Sequence Analysis Pipeline** (CWL; on Seven Bridges
  cloud or local). R1 = cell label + UMI; R2 = the bioproduct (gene/AbSeq/tag).
  Uses **RSEC/DBEC** UMI error-correction. → Seurat/AnnData.
  ([Rhapsody multiomic workflows, *Current Protocols* 2024](https://currentprotocols.onlinelibrary.wiley.com/doi/10.1002/cpz1.963))
- **Output:** a molecule-count matrix (`*_RSEC_MolsPerCell` / `*_DBEC_MolsPerCell`),
  cell metadata, Seurat/`.h5ad`. *Processing note:* the cell label has an internal
  linker structure — a generic 16 bp-barcode assumption (as for 10x) will not
  parse it.

### B6. Seq-Well / Microwell-seq (portable microwell)

- **Origin:** **Seq-Well** — Gierahn et al., *Nat Methods* 2017 (Shalek/Love labs,
  MIT). ([Seq-Well, Nature Methods](https://www.nature.com/articles/nmeth.4179);
  Seq-Well S³ — [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC7741456/)).
  **Microwell-seq** — Han et al. 2018 (the *Mouse Cell Atlas* platform).
- **Mechanism.** Barcoded mRNA-capture beads + single cells settle into a
  **PDMS array of sub-nanoliter wells**, sealed under a semipermeable membrane for
  lysis + capture. Portable, low-cost, no instrument; good for field/clinical
  low-input samples. 3′ + UMI → DGE matrix (Drop-seq-style tools).

---

## C. Plate-based / full-length platforms

Trade throughput for **sensitivity and full-length coverage** — one cell per
well, so you can resolve **isoforms, allele-specific expression, SNPs, and fusion
transcripts** that 3′/5′-tag methods cannot.

### C1. Smart-seq2 (Picelli et al., 2013)

- **Origin:** Picelli et al., *Nat Methods* 2013 / *Nat Protocols* 2014
  (Sandberg lab). ([Smart-seq2, PubMed](https://pubmed.ncbi.nlm.nih.gov/24385147/),
  [Illumina method page](https://www.illumina.com/science/sequencing-method-explorer/kits-and-arrays/smart-seq2.html))
- **Mechanism.** One FACS-sorted cell per plate well → oligo(dT)-primed RT with
  **template switching (TSO)** → full-length cDNA → **Nextera tagmentation** →
  Illumina. **Full-length transcript coverage**, **no UMI** (so no molecule
  counting — read counts only), **no cell barcode in-read** (well = index).
- **Scope/throughput:** high sensitivity, low throughput (hundreds–few thousand
  cells); any species.
- **Pipeline:** **not** Cell Ranger — a **bulk-style per-cell** pipeline: STAR/HISAT
  align each well's FASTQs → featureCounts/**RSEM**/Salmon → a gene × cell matrix
  assembled across wells. Isoform-level via RSEM/StringTie.
- **Output:** per-cell BAM + a merged expression matrix (TPM/counts).

### C2. Smart-seq3 / Smart-seq3xpress (Hagemann-Jensen et al., 2020 / 2022)

- **Origin:** Hagemann-Jensen et al., *Nat Biotech* 2020 (Smart-seq3);
  Smart-seq3xpress *Nat Biotech* 2022 (miniaturized).
  ([Smart-seq3xpress, Nature Biotech](https://www.nature.com/articles/s41587-022-01311-4),
  [SS2/SS3/FLASH-seq comparison](https://alitheagenomics.com/blog/what-is-the-difference-between-smart-seq2-smart-seq3-and-flash-seq-for-full-length-single-cell-rna-seq))
- **Mechanism.** Adds a **5′ UMI on the TSO**, so reads split into **UMI-containing
  5′ reads** (molecule counting) **and** internal **full-length** reads (isoform
  reconstruction) — best of both. Much higher sensitivity than SS2.
  **Smart-seq3xpress** miniaturizes to nanoliter volumes → thousands of cells.
- **Pipeline:** **zUMIs** (handles the SS3 mixed UMI/internal read structure) →
  count matrix + isoform info. FLASH-seq is a related fast full-length method.

### C3. CEL-seq / CEL-seq2 and MARS-seq / MARS-seq2

- **Origin:** CEL-seq (Hashimshony 2012) / **CEL-seq2** (Hashimshony 2016);
  MARS-seq (Jaitin 2014) / **MARS-seq2.0** (Keren-Shaul et al., *Nat Protocols*
  2019). ([CEL-Seq2, MIT DSpace](https://dspace.mit.edu/bitstream/handle/1721.1/105787/Regev_CEL-Seq2.pdf),
  [MARS-seq2.0, Nat Protocols](https://www.nature.com/articles/s41596-019-0164-4))
- **Mechanism.** Plate-based **3′** counting with **UMIs**; early barcoding then
  pooling; amplification by **in-vitro transcription (linear)** rather than PCR
  (reduces amplification bias). MARS-seq adds **FACS index sorting** (records the
  sort gate/well position as metadata). 3′-tag → gene-level, not isoform-level.
- **Pipeline:** the MARS-seq2.0 analytical pipeline / custom UMI counters → matrix.

---

## D. Spatial — sequencing / capture-based (spot & bin resolution)

Tissue is placed on a surface whose **position is barcoded**; captured mRNA is
sequenced off-instrument, then mapped back to (x, y). Reads out (mostly) the
**whole transcriptome**, but resolution is the feature (spot/bead/DNB) size, so a
"spot" usually contains several cells → **deconvolution/segmentation** needed
(see `06-spatial-processing.md`).

### D1. 10x Genomics Visium (Spatial Gene Expression)

- **Vendor/origin:** 10x Genomics; commercialization of Ståhl/Frisén "Spatial
  Transcriptomics" (2016).
  ([Visium CytAssist overview](https://www.10xgenomics.com/support/cytassist-spatial-gene-expression),
  [UMN Visium](https://spatialomics.umn.edu/technologies/visium))
- **Mechanism.** A capture slide with **~5,000 spots** (55 µm diameter, 100 µm
  center-to-center) over a 6.5 × 6.5 mm area; each spot has a unique spatial
  barcode + poly(dT) (or probe) + UMI. Tissue section placed on top, permeabilized,
  mRNA captured in situ.
  - **Fresh-frozen (FF):** **poly(dT)** capture → true whole transcriptome,
    **any species**.
  - **FFPE / CytAssist:** **probe-based** (hybridize-ligate, ~18k human/20k mouse
    genes); the **CytAssist** instrument transfers analytes from a standard H&E/IF
    slide onto the capture slide.
- **Resolution/scope:** **spot** (55 µm ≈ 1–10 cells) — **not** single cell;
  genome-wide (FF) or whole-probe-set (FFPE).
- **Modalities:** GEX; **Spatial Gene + Protein Expression** (CytAssist protein
  co-detection).
- **Pipeline:** **Space Ranger** (`spaceranger count`) — aligns reads, registers
  the tissue image, assigns barcodes to spots.
- **Output:** feature-barcode matrix (`filtered_feature_bc_matrix.h5`) + a
  **`spatial/`** folder (`tissue_positions.csv`, `scalefactors_json.json`,
  hires/lores tissue images) + `.cloupe`. Format detail → `01-file-formats.md`;
  spot deconvolution → `06-spatial-processing.md`.

### D2. 10x Genomics Visium HD

- **Vendor/origin:** 10x Genomics (2024).
  ([Visium HD intro](https://www.10xgenomics.com/blog/your-introduction-to-visium-hd-spatial-biology-in-high-definition),
  [Space Ranger outputs](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview))
- **Mechanism.** Replaces the spotted slide with a **continuous grid of 2 × 2 µm
  barcoded squares** — **>11 million** features tiling the entire 6.5 × 6.5 mm
  area with **no gaps**. **Probe-based** whole transcriptome (~18k human/20k
  mouse); **CytAssist-required**; FFPE/FF/fixed-frozen.
- **Resolution/scope:** **near-single-cell / subcellular bin** (2 µm), continuous.
- **Pipeline:** **Space Ranger** (v3+; v4 as of June 2025) emits a **hierarchical
  `binned_outputs/`**: 2 µm, 8 µm (**recommended default for analysis**), and
  16 µm bins, plus (v4) **direct H&E-segmented cell-level output**. Re-binnable to
  any 2 µm multiple.
- **Output:** per-bin feature-barcode matrices + `spatial/` per resolution +
  segmented-cell matrix. *Processing note:* raw 2 µm bins are extremely sparse →
  standard practice bins to 8 µm or segments to cells (`bin2cell`, StarDist);
  see `06-spatial-processing.md`.

### D3. Slide-seq / Slide-seqV2 → Curio Seeker

- **Origin:** Rodriques, Stickels et al., *Science* 2019 (Slide-seq); Stickels et
  al., *Nat Biotech* 2021 (Slide-seqV2), Chen/Macosko labs (Broad).
  ([Slide-seq, Science](https://www.science.org/doi/10.1126/science.aaw1219),
  [commercial Curio Seeker](https://www.genengnews.com/insights/slide-seq-hits-the-spatial-biology-market-as-curio-seeker/))
- **Mechanism.** A monolayer of **~10 µm barcoded beads** packed on a 3 mm
  rubber-coated coverslip (a **"puck"**); bead positions are decoded by **SOLiD
  in-situ sequencing** up-front; tissue laid on top → poly(dT) capture → NGS.
- **Resolution/scope:** **near-cellular (10 µm bead)**, genome-wide (poly(dT)),
  any species; V2 greatly improves capture efficiency.
- **Commercial:** **Curio Seeker** (kit = "Seeker tiles" (pucks) + a bead-barcode/
  coordinate file). Pipeline: **Curio Seeker pipeline** (Nextflow) → count matrix +
  bead-coordinate table → Seurat/AnnData.
- **Related:** **Slide-tags** (2023) uses the puck to tag *nuclei* with spatial
  barcodes for downstream droplet multiomics.

### D4. Stereo-seq (BGI / STOmics)

- **Origin:** Chen, Liao et al., *Cell* 2022 (STOmics/BGI); the **MOSTA** mouse
  organogenesis atlas.
  ([Stereo-seq, Cell/ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0092867422003993),
  [STOmics Stereo-seq](https://en.stomics.tech/why-stereo-seq/index.html))
- **Mechanism.** A chip patterned with **DNA nanoballs (DNBs)** in a dense grid
  (spot ~220 nm, ~500 nm–715 nm center-to-center); each DNB position is
  pre-decoded to a **Coordinate ID (CID)**; poly(dT) captures RNA in situ →
  **subcellular resolution** over a **cm-to-decimeter-scale field of view** (whole
  mouse embryo section on one chip). Whole transcriptome (poly(dT)).
- **Resolution/scope:** **subcellular** (down to ~500 nm), genome-wide, huge FOV —
  the standout for "large tissue at high resolution."
- **Pipeline:** **SAW (Stereo-seq Analysis Workflow)** → registers image, bins,
  segments. **StereoMap** (visualization) + **Stereopy** (Python)/StereoR analysis.
- **Output:** **`.gef`** (Gene Expression Format — HDF5-based binary, multi-bin) and
  **`.gem`** (plain-text gene × coordinate matrix); binned at bin1 (0.5 µm)/bin20/
  bin50/bin100 or **cellbin** (post-segmentation) → convertible to `.h5ad`/Seurat.
  Format detail → `01-file-formats.md`.

### D5. Other academic high-resolution capture methods (brief)

- **HDST** (High-Definition Spatial Transcriptomics) — 2 µm barcoded-bead wells,
  subcellular, poly(dT). ([resolution table, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2001037022003786))
- **DBiT-seq** (Deterministic Barcoding in Tissue) — **microfluidic channels**
  deliver crossed spatial barcodes (10–25 µm pixels); notably a **multi-omic**
  (RNA + protein) spatial method. ([DBiT-seq, Cell 2020](https://www.sciencedirect.com/science/article/pii/S0092867420313908))
- **Pixel-seq** — polony-based dense barcode array (~1 µm).
- **Seq-Scope** — Illumina flow-cell-based, sub-micron (~0.5–1 µm).
- **Open-ST** — open-source, **~0.6 µm** capture-spot resolution, **3D**
  reconstruction from serial sections. ([Open-ST, bioRxiv](https://www.biorxiv.org/content/10.1101/2023.12.22.572554.full.pdf))
  All emit a (barcode/coordinate) × gene sparse matrix + a coordinate map, then
  bin/segment like Stereo-seq.

---

## E. Spatial — imaging / in-situ platforms (subcellular, mostly targeted)

RNA is counted **in place** by cyclic fluorescence microscopy — the transcript is
never dissociated or (usually) sequenced. Outputs are fundamentally different from
sequencing platforms: a **per-molecule transcript table** (x, y, z, gene) + a
**cell-segmentation** mask → a cell × gene matrix built by counting molecules
inside each cell polygon. Most are **targeted panels** (no genome-wide QC).

### E1. 10x Genomics Xenium In Situ

- **Vendor/origin:** 10x Genomics.
  ([Xenium platform](https://www.10xgenomics.com/platforms/xenium),
  [Xenium In Situ analysis service](https://www.cd-genomics.com/spatial-omics/10x-xenium-in-situ-spatial-rna-analysis-service.html))
- **Mechanism.** **Padlock probes + rolling-circle amplification (RCA)** generate
  bright amplicons; **cyclic fluorescence** reads an **error-correcting optical
  barcode** per gene. On-instrument **cell segmentation** (DAPI + a multimodal
  membrane/interior stain).
- **Resolution/scope:** **subcellular**, single-cell; **targeted**:
  - **Xenium v1** — predesigned panels (~247–380 genes) + **custom add-on** (up to
    ~480 genes).
  - **Xenium Prime 5K** — **5,001 genes** (human & mouse).
  - **Protein co-detection** (v4.0+) alongside RNA.
- **Pipeline:** **Xenium Onboard Analysis (XOA)** — image processing, segmentation,
  registration, **decoding**, dedup, secondary analysis; **Xenium Explorer** for
  visualization.
- **Output** ([XOA output at a glance](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance)):
  `cell_feature_matrix` (MEX + `.h5` + `.zarr`), **`transcripts.parquet`** (per
  molecule: x/y/z, gene, quality), **`cells.parquet`/`.csv.gz`**, `cells.zarr.zip`
  (**segmentation masks/boundaries**), `cell_boundaries`/`nucleus_boundaries`
  (polygons), `morphology.ome.tif` + `morphology_focus/` (DAPI + stains),
  `experiment.xenium` manifest, `gene_panel.json`, `metrics_summary.csv`. *Processing
  note:* QC uses **negative-control / blank codewords**, not % mito (mito genes may
  not be in the panel).

### E2. Vizgen MERSCOPE (MERFISH)

- **Vendor/origin:** Vizgen; commercialization of **MERFISH** (Multiplexed
  Error-Robust FISH), Xiaowei Zhuang lab (Harvard), Chen et al. *Science* 2015.
  ([Vizgen MERFISH tech](https://vizgen.com/technology/merfish-spatially-resolved-transcriptomics/),
  [MERSCOPE Ultra](https://vizgen.com/merscope-ultra/))
- **Mechanism.** Each gene gets a unique **error-robust binary barcode**; encoding
  probes + successive rounds of readout hybridization + imaging decode each
  molecule; the Hamming-distance-based code enables **optical error correction**
  and combats optical crowding. Subcellular.
- **Resolution/scope:** **subcellular**, single-cell; **targeted** — standard
  panels up to ~500 genes; **MERSCOPE Ultra** up to **1,000 custom genes**;
  protein co-stains supported (MERFISH 2.0).
- **Pipeline:** **MERSCOPE** instrument software; **VPT (Vizgen Post-processing
  Tool)** for reproducible segmentation/cell-calling; **Vizualizer** for QC.
- **Output:** `cell_by_gene.csv` (cell × gene), `cell_metadata.csv`,
  **`detected_transcripts.csv`** (per molecule: global_x/y/z + gene),
  `cell_boundaries` (HDF5/parquet polygons), and **mosaic OME-TIFF** images (DAPI,
  poly-T, stains). → Squidpy/Seurat.

### E3. NanoString / Bruker CosMx SMI (Spatial Molecular Imager)

- **Vendor/origin:** NanoString (now **Bruker Spatial Biology**).
  ([CosMx SMI overview](https://brukerspatialbiology.com/products/cosmx-spatial-molecular-imager/single-cell-imaging-overview/),
  [CosMx 6K launch](https://nanostring.com/pressrelease/news-news-details-2024-nanostring-launches-the-cosmx-6000-plex-rna-assay-and-showcases-whole-transcriptome-imaging-capability/))
- **Mechanism.** Cyclic in-situ hybridization imaging with subcellular readout;
  FF **and** FFPE.
- **Resolution/scope:** **subcellular**, single-cell; **targeted**, but the
  highest-plex imaging option:
  - **1,000-plex** (Universal Cell Characterization),
  - **6,000-plex** (Human 6K Discovery),
  - **whole-transcriptome** (~19,000 genes, WTx prototype),
  - **+ up to 64+ proteins** (RNA+protein multiomic on one section).
- **Pipeline:** **AtoMx SIP** (cloud spatial informatics platform).
  ([AtoMx commercial launch](https://brukerspatialbiology.com/pressrelease/news-news-details-2022-nanostring-begins-commercial-shipments-of-cosmx-spatial-molecular-imager-and-atomx-spatial-informatics-platform/))
- **Output:** flat files — `exprMat_file.csv` (cell × gene), `metadata_file.csv`,
  **`tx_file.csv`** (per-transcript coordinates), `polygons`/`fov_positions`, plus
  morphology images → Seurat/Giotto/Squidpy. *Processing note:* CosMx has **higher
  negative-probe/background** signal than Xenium in head-to-head benchmarks — QC
  must subtract negative-probe background carefully.
  ([subcellular-platform benchmark, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12534522/))

### E4. NanoString / Bruker GeoMx Digital Spatial Profiler (DSP) — **NOT single-cell**

- **Vendor/origin:** NanoString/Bruker.
  ([GeoMx WTA overview](https://brukerspatialbiology.com/products/geomx-digital-spatial-profiler/geomx-dsp-overview/),
  [GeoMx WTA, Mayo Clinic](https://www.mayo.edu/research/core-resources/spatial-multiomics-core/services/nanostring-geomx-whole-transcriptome-atlas-wta))
- **Mechanism.** Probes carry **UV-photocleavable oligo barcodes**; the operator
  draws **Regions of Interest (ROIs) / segments (AOIs)** on a fluorescent image;
  UV illumination **releases barcodes only from the selected region**, which are
  aspirated and counted.
- **Resolution/scope:** **region/ROI-level profiling — explicitly not single-cell
  and not per-spot**; whole transcriptome (**WTA ~18,000 genes**), Cancer
  Transcriptome Atlas (~1,800), or **protein** (up to ~570+ plex).
- **Readout:** **NGS (Illumina)** for large RNA panels; **nCounter** for smaller
  panels/protein.
- **Pipeline/output:** the DSP instrument + **GeoMx DSP Data Analysis Suite**;
  NGS reads → **DCC** files (per-AOI counts) keyed by a **PKC** probe-config +
  segment annotations. Analyzed with **GeomxTools**/**standR** (limma). *Processing
  note:* this is closer to **many small bulk RNA-seq samples with spatial
  annotation** than to single-cell data — normalization (Q3/background) and DE
  follow bulk conventions, not scRNA workflows.

### E5. Akoya PhenoCycler / CODEX (spatial **proteomics**, brief)

- **Vendor/origin:** Akoya Biosciences (now Quanterix); **CODEX** = CO-Detection by
  indEXing.
  ([PhenoCycler/CODEX, Stanford](https://microscopy.stanford.edu/resources-and-reservation/multiplexed-spatial-proteomics-services-phenocycler-aka-codex),
  [PhenoCycler-Fusion 2.0](https://www.quanterix.com/phenocycler-fusion-2-0/))
- **Mechanism.** DNA-barcoded antibodies + cyclic reveal-image-remove of
  fluorescent reporters → **50–100+ proteins** at single-cell resolution.
  **Protein, not RNA** — included because it is routinely paired with **Xenium**
  (RNA) for RNA+protein multiomic studies. See `03-modalities.md`.
- **Output:** multiplexed OME-TIFF image stacks → segmentation → cell × protein
  matrix (QuPath/CellProfiler/Squidpy). 10x's **Xenium protein** add-on and CosMx
  protein overlap this space.

### E6. Academic imaging methods — seqFISH+, STARmap, ISS/HybISS (brief)

- **seqFISH / seqFISH+** (Cai lab, Caltech) — sequential FISH with expanded
  pseudocolor barcoding; **seqFISH+** images **~10,000 genes** at subcellular
  resolution.
- **STARmap** (Deisseroth/Wang) — hydrogel-embedded padlock probes +
  **error-robust sequencing-by-ligation** (SEDAL); 3D, thousands of genes.
- **ISS / HybISS** — **In Situ Sequencing** (padlock + rolling circle, ~2013,
  ~100 targets) and **Hybridization-based ISS** (2019) which uses
  sequencing-by-hybridization to scale the target count.
  ([FISH/ISS method review, Wiley](https://onlinelibrary.wiley.com/doi/10.1002/bies.201900221),
  [starfish unified pipeline](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10504669/))
- **Pipeline:** many share the open-source **`starfish`** image-based
  transcriptomics pipeline. **Output:** decoded per-molecule spot tables (x, y,
  gene) + segmentation → cell × gene matrix. Processing → `06-spatial-processing.md`.

---

## 6. Feature-barcoding & multiplexing add-ons (data-type overlays)

These are **not standalone platforms** — they are extra libraries that ride along
on a base platform (mostly 10x/BD) and produce **additional feature-barcode
matrices**. Full modality treatment is in **`03-modalities.md`**; noted here so the
platform picture is complete.

- **CITE-seq (ADT / surface protein).** Stoeckius et al., *Nat Methods* 2017.
  Oligo-conjugated antibodies (**TotalSeq**) add a protein readout. **TotalSeq-A**
  (poly-A tail, works with poly(dT)), **-B** (10x 3′ v3/v3.1 capture), **-C** (10x
  5′ capture). Output = an **Antibody Capture** matrix alongside GEX.
  ([CITE-seq/cell-hashing, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC6300015/),
  [TotalSeq A/B/C, BioLegend](https://www.biolegend.com/en-us/blog/cite-seq-and-totalseq-reagents))
- **Cell Hashing / MULTI-seq / CellPlex (HTO/CMO sample multiplexing).**
  Barcoded antibodies (HTO) or lipid-modified oligos (MULTI-seq) or CMOs tag each
  *sample*, letting many samples pool in one lane and be **demultiplexed**
  bioinformatically (HTODemux/`hashsolo`/`demuxlet`) — and doublets flagged.
  Output = a small **HTO/Multiplexing Capture** matrix. *Processing note:* the base
  GEX chemistry (v3 vs 5′) dictates which TotalSeq format is compatible.

---

## 7. Master comparison table

| Platform | Family | Mechanism / chemistry | Resolution | Targeted vs WT | Modalities | Throughput | Pipeline | Primary output |
|---|---|---|---|---|---|---|---|---|
| **10x Chromium 3′ (v2/v3/v3.1/GEM-X v4)** | Droplet | Gel-bead barcode+UMI, poly(dT), 3′ tag | Single cell/nucleus | WT (poly-A) | GEX + CITE/HTO/CRISPR | 0.5–20k+ cells/lane | **Cell Ranger** | feature-barcode `.h5`/MEX, `molecule_info.h5`, `.cloupe` |
| **10x Chromium 5′ (v1/v2/v3)** | Droplet | Barcoded TSO, template switch, 5′ tag | Single cell | WT (5′) | GEX + **V(D)J** + protein | ≤80k T/B cells/run | **Cell Ranger multi/vdj** | GEX matrix + `clonotypes.csv`, contig annotations |
| **10x Flex / FRP** | Droplet | **Probe pairs + ligation**, FFPE | Single cell/nucleus | Targeted-WT probe set (~18–20k) | GEX + protein; 16-plex | up to 16 samples/well | **Cell Ranger multi** (probe aligner) | per-sample feature-barcode matrix |
| **10x Multiome (ATAC+GEX)** | Droplet | Shared barcode; poly(dT) + Tn5 capture | Single **nucleus** | WT + genome-wide ATAC | RNA + chromatin | ~10k nuclei | **Cell Ranger ARC** | GEX matrix + `atac_fragments.tsv.gz` + peaks + `feature_linkage.bedpe` |
| **Drop-seq** | Droplet | Barcoded bead, poly(dT), 3′ | Single cell | WT (poly-A) | GEX | thousands | **Drop-seq tools**/STARsolo | DGE matrix |
| **inDrop** | Droplet | Hydrogel bead, IVT amplification, 3′ | Single cell | WT (poly-A) | GEX | thousands | `indrops`/zUMIs | count matrix |
| **Fluent PIPseq** | Droplet (instrument-free) | Particle-templated partitions, poly(dT), 3′ | Single cell/nucleus | WT (poly-A) | GEX + CRISPR | 1k–100k+/kit | **PIPseeker** | feature-barcode matrix |
| **Parse Evercode (Mini/WT/Mega)** | Split-pool | 4-round combinatorial barcode; fixed | Single cell/nucleus | WT | GEX + TCR/BCR + CRISPR | up to **1M cells / 96 samples** | **split-pipe** | per-sample DGE + AnnData |
| **SPLiT-seq** | Split-pool | 4-round split-pool; fixed | Single cell/nucleus | WT | GEX | 10^5+ | academic | count matrix |
| **sci-RNA-seq3** | Combinatorial index | 3-level in-well RT + ligation | Single nucleus | WT | GEX (+ sci-family variants) | 10^6+ | lab pipeline (bbi-sci) | count matrix |
| **Scale Bio** | Combinatorial index | Commercial split-pool; fixed | Single cell/nucleus | WT | GEX | very high | Scale pipeline | matrix/AnnData |
| **BD Rhapsody** | Microwell + bead | Picowell capture, 3-segment label, poly(dT) | Single cell/nucleus | **WTA or targeted panel** | GEX + AbSeq + SampleTag + VDJ + ATAC | ~10k–many | **BD Rhapsody pipeline** (Seven Bridges/local) | RSEC/DBEC mols-per-cell matrix |
| **Seq-Well / Microwell-seq** | Microwell | Bead in PDMS wells, poly(dT), 3′ | Single cell | WT (poly-A) | GEX | thousands | Drop-seq tools | DGE matrix |
| **Smart-seq2** | Plate full-length | oligo(dT)+TSO, full-length, **no UMI** | Single cell | WT full-length | GEX (isoform/allele/SNP) | 10^2–10^3 | STAR+RSEM/featureCounts | per-cell BAM + merged matrix |
| **Smart-seq3 / xpress** | Plate full-length | 5′ UMI + internal reads | Single cell | WT full-length + UMI | GEX + isoforms | 10^3 | **zUMIs** | count + isoform matrix |
| **CEL-seq2 / MARS-seq2** | Plate 3′ | Barcode+UMI, IVT linear amp, 3′ | Single cell | WT (3′) | GEX (+FACS index) | 10^3–10^4 | MARS-seq2 pipeline | UMI count matrix |
| **10x Visium** | Spatial capture | 55 µm spot barcode; poly(dT) (FF) / probe (FFPE) | **Spot (~1–10 cells)** | WT (FF) / probe-WT (FFPE) | GEX + protein | ~5k spots | **Space Ranger** | matrix + `spatial/` + `.cloupe` |
| **10x Visium HD** | Spatial capture | Continuous 2 µm barcoded squares; probe | **2 µm bin / near-cell** | Probe-WT (~18–20k) | GEX | 11M+ features | **Space Ranger** (binned+segmented) | `binned_outputs/` (2/8/16 µm) + segmented cells |
| **Slide-seq(V2) / Curio Seeker** | Spatial capture | 10 µm barcoded beads (puck), poly(dT) | **Bead (~10 µm)** | WT (poly-A) | GEX | ~10^5 beads/puck | **Curio Seeker pipeline** | matrix + bead-coordinate file |
| **Stereo-seq (STOmics)** | Spatial capture | DNB array (CID), poly(dT), cm-FOV | **Subcellular (~0.5 µm)** | WT (poly-A) | GEX | 10^6+ spots; huge FOV | **SAW** + Stereopy | `.gef` / `.gem` (+ bin/cellbin) |
| **HDST / DBiT-seq / Pixel-seq / Seq-Scope / Open-ST** | Spatial capture | Various dense-barcode arrays | 0.5–20 µm | WT (some +protein) | GEX (DBiT +protein) | high | method-specific | coordinate × gene matrix |
| **10x Xenium** | Imaging (ISH) | Padlock + RCA, cyclic optical barcode | **Subcellular** | **Targeted** 100–5,000 (+protein) | RNA + protein | 10^5–10^6 cells | **Xenium Onboard Analysis** | `transcripts.parquet`, `cell_feature_matrix`, `cells.zarr`, OME-TIFF |
| **Vizgen MERSCOPE (MERFISH)** | Imaging (FISH) | Error-robust binary barcode, cyclic imaging | **Subcellular** | **Targeted** ~140–1,000 | RNA (+protein) | 10^5–10^6 cells | **MERSCOPE / VPT** | `cell_by_gene.csv`, `detected_transcripts.csv`, OME-TIFF |
| **CosMx SMI (Bruker)** | Imaging (ISH) | Cyclic ISH imaging | **Subcellular** | **Targeted** 1k/6k → ~19k WTx + protein | RNA + protein | 10^5–10^6 cells | **AtoMx SIP** | `exprMat/tx/metadata` flat files + images |
| **GeoMx DSP** | Imaging (region) | UV-photocleavable oligo barcodes, ROI | **ROI/segment — NOT single-cell** | WTA ~18k / protein ~570 | RNA **or** protein | ~10s–100s ROIs | **GeoMx DSP Suite** + GeomxTools/standR | DCC + PKC + annotations (bulk-like) |
| **CODEX / PhenoCycler** | Imaging (protein) | DNA-barcoded antibodies, cyclic | Subcellular | 50–100+ proteins | **Protein only** | 10^5–10^6 cells | Akoya/QuPath | OME-TIFF → cell × protein |
| **seqFISH+ / STARmap / ISS / HybISS** | Imaging | Sequential FISH / in-situ seq | Subcellular | Targeted (100–10,000) | RNA | varies | **starfish** etc. | decoded spot table + segmentation |

---

## 8. Which pipeline for which platform (quick index)

| Pipeline / tool | Platforms it serves | Emits |
|---|---|---|
| **Cell Ranger** (`count`/`multi`/`vdj`) | 10x 3′, 5′, Flex, CITE/hashing/CRISPR | feature-barcode matrix, VDJ, `.cloupe` |
| **Cell Ranger ARC** | 10x Multiome | joint GEX+ATAC |
| **Space Ranger** | Visium, Visium HD | spatial matrix, binned outputs |
| **Xenium Onboard Analysis** | Xenium | transcripts + segmentation |
| **split-pipe** | Parse Evercode | per-sample DGE/AnnData |
| **BD Rhapsody pipeline** (Seven Bridges/CWL) | BD Rhapsody | RSEC/DBEC matrix |
| **PIPseeker** | Fluent PIPseq | matrix |
| **SAW + Stereopy** | Stereo-seq | `.gef`/`.gem` |
| **Curio Seeker pipeline** | Slide-seq / Curio | matrix + coords |
| **MERSCOPE / VPT** | MERSCOPE/MERFISH | cell-by-gene + transcripts |
| **AtoMx SIP** | CosMx | flat files + images |
| **GeoMx DSP Suite** / GeomxTools / standR | GeoMx | DCC/PKC counts |
| **zUMIs** | Smart-seq3, inDrop, many UMI methods | count matrix |
| **STAR + RSEM/featureCounts** | Smart-seq2 (full-length) | per-cell counts/TPM |
| **STARsolo / alevin-fry / kallisto\|bustools** | *generic* — 10x, Drop-seq, inDrop, custom | matrix (needs correct whitelist + read geometry) |
| **starfish** | seqFISH/ISS/STARmap/MERFISH (academic) | decoded spots |

> **STARsolo/alevin-fry compatibility caveat.** These open-source counters can
> replace Cell Ranger for droplet data, but they must be told the exact **barcode
> whitelist**, **barcode/UMI lengths**, and **read geometry** for the chemistry
> (v2 vs v3/v3.1 vs GEM-X v4 whitelists differ; 5′ needs the 5′ orientation;
> Drop-seq/inDrop have their own geometries). Getting this wrong silently
> produces a near-empty matrix.

---

## 9. Notable multi-platform comparison references

- **10x vs BD Rhapsody WTA** in complex human tissue —
  [ScienceDirect 2024](https://www.sciencedirect.com/science/article/pii/S2405844024043895).
- **Comparative droplet systems (inDrop / Drop-seq / 10x)** —
  [Zhang et al., *Mol Cell* 2019](https://www.sciencedirect.com/science/article/pii/S1097276518308803).
- **Antibody- vs lipid-based multiplexing (hashing/MULTI-seq)** —
  [bioRxiv/PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8851857/).
- **Subcellular imaging platform benchmark (Xenium 5K vs CosMx 6K, MERFISH)** —
  [PMC12534522](https://pmc.ncbi.nlm.nih.gov/articles/PMC12534522/): Xenium 5K
  showed higher scRNA-seq correlation, lower negative-control fraction, and better
  segmentation than CosMx 6K in the tested tumors.
- **Spatial resolution ladder (HDST 4 µm, DBiT 20 µm, Seq-Scope/Stereo-seq
  ~0.5 µm, Pixel-seq 1 µm, Open-ST 0.6 µm)** —
  [ScienceDirect computational-solutions review](https://www.sciencedirect.com/science/article/pii/S2001037022003786).

---

## 10. Chemistry differences that matter for processing

This is the practical payload of this document — the properties that change what
the **data-processing code** must do (feeds directly into `04`/`05` and
`06-spatial-processing.md`):

1. **3′ vs 5′ barcode/UMI position.** 3′ tags the poly-A end (gene-level
   quantification); 5′ tags the 5′ end and is what enables **V(D)J pairing**. The
   read geometry and strand orientation differ → the aligner/counter must be set
   accordingly (Cell Ranger handles it; STARsolo needs the 5′ flag).

2. **Probe-based vs poly(dT).** Poly(dT) (3′/5′ Chromium, Visium FF, Slide-seq,
   Stereo-seq, Drop-seq) captures **any polyadenylated transcript, any species**,
   and supports **intronic reads → RNA velocity** and novel-transcript discovery.
   Probe-based (Flex, Visium FFPE/HD, and all imaging platforms) sees **only the
   predesigned targets**, is **FFPE/degradation-tolerant**, needs a **probe-set
   reference + probe aligner** (not a genome aligner), and yields **no velocity / no
   novel isoforms**.

3. **Targeted panels have no genome-wide QC.** Imaging platforms (Xenium/MERSCOPE/
   CosMx) and BD-targeted mode can't compute a **% mitochondrial** QC if mito genes
   aren't in the panel; QC instead relies on **negative-control / blank codewords**,
   per-cell transcript counts, and **segmentation quality**. GeoMx is region-level,
   so QC follows **bulk RNA-seq** conventions entirely.

4. **Nuclei vs whole cells.** snRNA-seq / Multiome / most combinatorial + spatial
   methods profile **nuclei** → high **intronic** content, so the reference must
   **include introns** (`--include-introns`, default in Cell Ranger v7+); the
   ambient-RNA and empty-droplet models differ from whole-cell data.

5. **Barcode whitelist & UMI length per chemistry.** 10x v2 (10 bp UMI,
   `737K-august-2016`), v3/v3.1 (12 bp UMI, `3M-february-2018`), **GEM-X v4** (new
   whitelist, Cell Ranger ≥ 8.0.1). Split-pool (Parse) and BD use **composite/
   linkered** barcodes that a plain 16 bp assumption cannot parse. Using the wrong
   whitelist is the #1 cause of a spuriously empty matrix in open-source pipelines.

6. **Spot/bead/DNB ≠ cell.** Sequencing-based spatial features contain multiple
   cells (Visium 55 µm) or are subcellular fragments (Stereo-seq 0.5 µm,
   Visium HD 2 µm). Processing therefore needs **binning** (HD/Stereo-seq) or
   **deconvolution/segmentation** (Visium) — covered in `06-spatial-processing.md`.

7. **Imaging output is a molecule table, not reads.** Xenium/MERSCOPE/CosMx emit a
   per-molecule (x, y, z, gene) table + a segmentation mask; the cell × gene matrix
   is **built by counting molecules inside cell polygons**, so **segmentation is the
   dominant source of error/variability**, and re-segmentation (Baysor, Cellpose,
   proseg) can materially change the matrix.

---

## Sources

- [10x Cell Ranger — Libraries Supported](https://www.10xgenomics.com/support/software/cell-ranger/latest/resources/supported-libraries) — authoritative list of 10x chemistries/assays Cell Ranger handles.
- [Teichmann lab — 10x Chromium 3′ library structure](https://teichlab.github.io/scg_lib_structs/methods_html/10xChromium3.html) — exact barcode/UMI/poly(dT) read geometry, v2/v3/v4 whitelist notes.
- [omicsEmpower — GEM-X 3′ v4 vs v3.1](https://www.omicsempower.com/blog/what-is-gem-x-v4-single-cell-rna-sequencing/) — GEM-X sensitivity gains, new barcode whitelist in CR 8.0.1, no CellPlex.
- [10x — Chromium GEM-X Single Cell 3′ v4 user guide](https://www.10xgenomics.com/support/universal-three-prime-gene-expression/documentation/steps/library-prep/chromium-gem-x-single-cell-3-v4-gene-expression-user-guide) — official GEM-X v4 workflow.
- [Teichmann lab — 10x Chromium 5′ library structure](https://teichlab.github.io/scg_lib_structs/methods_html/10xChromium5.html) — 5′ TSO barcoding, UMI lengths, STRT-seq lineage.
- [KUMC — 10x 5′ + V(D)J enrichment](https://www.kumc.edu/research/genome-sequencing-facility/services/10x-services/chromium-single-cell-5-and-v(d)j-enrichment.html) — ≤80k T/B cells, paired TCR/BCR repertoire.
- [10x — Chromium 5′ v2 cell-surface-protein user guide (PDF)](https://cdn.10xgenomics.com/image/upload/v1673041140/support-documents/CG000330_ChromiumNextGEMSingleCell5_v2_CellSurfaceProtein_UserGuide_RevF.pdf) — 5′ + protein details.
- [10x — What is Fixed RNA Profiling (Flex)](https://www.10xgenomics.com/support/software/cell-ranger/latest/getting-started/cr-flex-what-is-frp) — probe-pair-ligation mechanism, FFPE compatibility.
- [10x — Flex/FRP algorithm](https://www.10xgenomics.com/support/software/cell-ranger/8.0/algorithms-overview/cr-flex-frp-algorithm) — probe aligner, probe-barcode = sample barcode.
- [10x — Flex with Cell Ranger multi](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/running-pipelines/cr-flex-multi-frp) — 16-plex multiplexing, 64/256-sample kits.
- [10x — What is Cell Ranger ARC (Multiome)](https://www.10xgenomics.com/support/software/cell-ranger-arc/latest/getting-started/what-is-cell-ranger-arc) — joint GEX+ATAC, shared barcode.
- [scg_lib_structs — 10x Multiome structure](https://scg-lib-structs.readthedocs.io/en/latest/multi/10x_multiome.html) — two oligo types (poly-dT + Tn5 spacer), `737K-arc-v1` whitelists.
- [Wikipedia — Drop-Seq](https://en.wikipedia.org/wiki/Drop-Seq) — Macosko 2015 mechanism summary.
- [RSC Lab-on-a-Chip — inDrop vs Drop-seq](https://pubs.rsc.org/en/content/articlehtml/2017/lc/c7lc90070h) — hydrogel vs polystyrene beads, IVT vs PCR.
- [RNA-Seq Blog — Harvard inDrop/Drop-seq](https://www.rna-seqblog.com/harvard-groups-tap-microfluidics-for-single-cell-rna-seq-methods/) — Klein 2015 inDrop origin.
- [Nature Biotech — PIPseq / templated emulsification (2023)](https://www.nature.com/articles/s41587-023-01685-z) — particle-templated instant partitions, instrument-free.
- [GenomeWeb — Fluent PIP-seq](https://www.genomeweb.com/sequencing/fluent-biosciences-takes-single-cell-rna-seq-market-pip-seq-technology) — commercial context, Abate-lab origin.
- [Fluent — PIPseq T2 v4.0 user guide (PDF)](https://www.fluentbio.com/wp-content/uploads/2024/02/PIPseq-T2-v4.0-Single-Cell-RNA-Kit-User-Guide-Rev-12.3.pdf) — kit tiers, workflow, PIPseeker.
- [Parse Biosciences — Evercode technology](https://www.parsebiosciences.com/technology/) — split-pool combinatorial barcoding of fixed cells.
- [RNA-Seq Blog — Parse 1M-cell kit](https://www.rna-seqblog.com/parse-biosciences-unveils-1000000-cell-scrna-seq-kit/) — WT Mega 1M cells / 96 samples.
- [bioRxiv — split-pool sensitivity (Parse, 2022)](https://www.biorxiv.org/content/10.1101/2022.08.27.505512v1.full) — split-pipe v1.4.0, low doublet rate.
- [SciLifeLab NGI — Parse Evercode method](https://ngisweden.scilifelab.se/methods/parse/) — split-pipe pipeline usage, sample/round barcoding.
- [Science — SPLiT-seq (Rosenberg 2018)](https://www.science.org/doi/10.1126/science.aam8999) — 4-round split-pool, fixed cells/nuclei origin.
- [PubMed — SPLiT-seq](https://pubmed.ncbi.nlm.nih.gov/29545511/) — abstract / cell-type counts.
- [PMC — sci-RNA-seq combinatorial indexing / optimization](https://pmc.ncbi.nlm.nih.gov/articles/PMC9839601/) — sci-RNA-seq(3) mechanism, SPLiT-seq vs sci comparison.
- [BD — Rhapsody Sequence Analysis Pipeline user guide (PDF)](https://www.bdbiosciences.com/content/dam/bdb/marketing-documents/products-pdf-folder/software-informatics/rhapsody-sequence-analysis-pipeline/Rhapsody-Sequence-Analysis-Pipeline-UG.pdf) — WTA/targeted/AbSeq/SampleTag/VDJ/ATAC library types, R1/R2 structure.
- [BD Rhapsody bioinformatics docs — pipeline steps 3.0](https://bd-rhapsody-bioinfo-docs.genomics.bd.com/steps/top_steps.html) — RSEC/DBEC, cell-label segments.
- [Current Protocols — Rhapsody multiomic workflows (2024)](https://currentprotocols.onlinelibrary.wiley.com/doi/10.1002/cpz1.963) — Seurat/Sample-Tag/AbSeq analysis.
- [Nature Methods — Seq-Well (Gierahn 2017)](https://www.nature.com/articles/nmeth.4179) — portable PDMS microwell + membrane seal.
- [PMC — Seq-Well S³](https://pmc.ncbi.nlm.nih.gov/articles/PMC7741456/) — sample-efficient picowell scRNA-seq.
- [ScienceDirect — 10x vs BD Rhapsody WTA (2024)](https://www.sciencedirect.com/science/article/pii/S2405844024043895) — technology-group comparison incl. Honeycomb HIVE, Scale Bio.
- [PubMed — Smart-seq2 (Picelli 2013)](https://pubmed.ncbi.nlm.nih.gov/24385147/) — full-length, TSO, no UMI.
- [Illumina — Smart-seq2 method](https://www.illumina.com/science/sequencing-method-explorer/kits-and-arrays/smart-seq2.html) — protocol summary.
- [Nature Biotech — Smart-seq3xpress (2022)](https://www.nature.com/articles/s41587-022-01311-4) — 5′ UMI + full-length, miniaturized.
- [Alithea — SS2/SS3/FLASH-seq comparison](https://alitheagenomics.com/blog/what-is-the-difference-between-smart-seq2-smart-seq3-and-flash-seq-for-full-length-single-cell-rna-seq) — UMI vs full-length trade-offs.
- [MIT DSpace — CEL-Seq2 (Hashimshony 2016)](https://dspace.mit.edu/bitstream/handle/1721.1/105787/Regev_CEL-Seq2.pdf) — 3′ UMI, IVT linear amplification.
- [Nature Protocols — MARS-seq2.0 (Keren-Shaul 2019)](https://www.nature.com/articles/s41596-019-0164-4) — FACS index sorting + 3′ UMI pipeline.
- [10x — Visium CytAssist support](https://www.10xgenomics.com/support/cytassist-spatial-gene-expression) — FFPE/FF/FxF, probe vs poly-A, image registration.
- [UMN Spatialomics — Visium](https://spatialomics.umn.edu/technologies/visium) — 55 µm spots, 100 µm spacing, ~5k spots.
- [10x — Space Ranger output overview](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview) — Visium/Visium HD binned_outputs structure.
- [10x blog — Introduction to Visium HD](https://www.10xgenomics.com/blog/your-introduction-to-visium-hd-spatial-biology-in-high-definition) — continuous 2 µm squares, 11M features, probe WT.
- [10x Analysis Guides — Visium HD nuclei segmentation & custom binning](https://www.10xgenomics.com/analysis-guides/segmentation-visium-hd) — 8 µm default, re-binning, segmented cells.
- [Science — Slide-seq (Rodriques 2019)](https://www.science.org/doi/10.1126/science.aaw1219) — 10 µm barcoded-bead pucks, SOLiD-decoded positions.
- [GEN — Slide-seq → Curio Seeker](https://www.genengnews.com/insights/slide-seq-hits-the-spatial-biology-market-as-curio-seeker/) — commercial kit = tiles/pucks + bead barcode/coordinate files.
- [Cell/ScienceDirect — Stereo-seq (Chen 2022, MOSTA)](https://www.sciencedirect.com/science/article/pii/S0092867422003993) — DNB array, subcellular, mouse organogenesis atlas.
- [STOmics — Why Stereo-seq](https://en.stomics.tech/why-stereo-seq/index.html) — CID coordinate barcoding, decimeter FOV, SAW/StereoMap.
- [ScienceDirect — computational solutions for spatial transcriptomics](https://www.sciencedirect.com/science/article/pii/S2001037022003786) — resolution ladder (HDST/DBiT/Seq-Scope/Stereo-seq/Pixel-seq/Open-ST).
- [Cell/ScienceDirect — DBiT-seq (2020)](https://www.sciencedirect.com/science/article/pii/S0092867420313908) — deterministic barcoding in tissue, multi-omic.
- [bioRxiv — Open-ST (PDF)](https://www.biorxiv.org/content/10.1101/2023.12.22.572554.full.pdf) — ~0.6 µm capture spots, 3D reconstruction, open-source.
- [10x — Xenium platform](https://www.10xgenomics.com/platforms/xenium) — padlock+RCA, subcellular, panel sizes, protein add-on.
- [10x — Xenium Onboard Analysis output at a glance](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance) — transcripts.parquet, cell_feature_matrix, cells.zarr masks, OME-TIFF, experiment.xenium.
- [CD Genomics — Xenium In Situ service](https://www.cd-genomics.com/spatial-omics/10x-xenium-in-situ-spatial-rna-analysis-service.html) — 5K Prime + v1 panels, multimodal segmentation.
- [Vizgen — MERFISH technology](https://vizgen.com/technology/merfish-spatially-resolved-transcriptomics/) — error-robust binary barcodes, combinatorial labeling.
- [Vizgen — MERSCOPE Ultra](https://vizgen.com/merscope-ultra/) — up to 1,000 custom genes, VPT/Vizualizer.
- [Bruker — CosMx SMI single-cell imaging overview](https://brukerspatialbiology.com/products/cosmx-spatial-molecular-imager/single-cell-imaging-overview/) — >1,000 RNA + 64 protein, FF/FFPE, subcellular.
- [Bruker/NanoString — CosMx 6K launch](https://nanostring.com/pressrelease/news-news-details-2024-nanostring-launches-the-cosmx-6000-plex-rna-assay-and-showcases-whole-transcriptome-imaging-capability/) — 6,000-plex + whole-transcriptome (~19k) imaging.
- [Bruker/NanoString — AtoMx SIP launch](https://brukerspatialbiology.com/pressrelease/news-news-details-2022-nanostring-begins-commercial-shipments-of-cosmx-spatial-molecular-imager-and-atomx-spatial-informatics-platform/) — cloud spatial informatics platform.
- [Bruker — GeoMx DSP overview](https://brukerspatialbiology.com/products/geomx-digital-spatial-profiler/geomx-dsp-overview/) — UV-cleavable barcodes, ROI/AOI, WTA/protein, NGS/nCounter readout.
- [Mayo Clinic — GeoMx WTA service](https://www.mayo.edu/research/core-resources/spatial-multiomics-core/services/nanostring-geomx-whole-transcriptome-atlas-wta) — ~18k-gene WTA, ROI selection, DCC/NGS.
- [Stanford — PhenoCycler/CODEX](https://microscopy.stanford.edu/resources-and-reservation/multiplexed-spatial-proteomics-services-phenocycler-aka-codex) — DNA-barcoded-antibody cyclic proteomics.
- [Quanterix — PhenoCycler-Fusion 2.0](https://www.quanterix.com/phenocycler-fusion-2-0/) — high-plex protein, Xenium pairing.
- [Wiley BioEssays — spatially-resolved transcriptomes review](https://onlinelibrary.wiley.com/doi/10.1002/bies.201900221) — seqFISH+/STARmap/ISS/HybISS overview.
- [PMC — starfish unified FISH pipeline](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10504669/) — shared image-based transcriptomics processing.
- [PMC — subcellular spatial platform benchmark (Xenium 5K vs CosMx 6K)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12534522/) — sensitivity/specificity/segmentation head-to-head.
- [ScienceDirect — droplet systems comparison (Mol Cell 2019)](https://www.sciencedirect.com/science/article/pii/S1097276518308803) — inDrop/Drop-seq/10x benchmarking.
- [PMC — antibody vs lipid multiplexing benchmark](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8851857/) — cell-hashing vs MULTI-seq comparison.
- [PMC — Cell Hashing (Stoeckius 2018)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6300015/) — HTO multiplexing + doublet detection.
- [BioLegend — TotalSeq A/B/C](https://www.biolegend.com/en-us/blog/cite-seq-and-totalseq-reagents) — CITE-seq/hashing reagent formats vs 3′/5′ chemistry.
