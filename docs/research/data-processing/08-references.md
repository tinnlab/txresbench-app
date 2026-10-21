# 08 — References (consolidated bibliography)

> A categorized master bibliography for the whole folder. Each topic doc (`01`–`06`)
> also carries its **own** exhaustive `## Sources` list with per-link annotations —
> this file is the cross-cutting index organized by theme. Where a link is most
> relevant to one doc, that doc is noted in **[brackets]**.

---

## A. Canonical best-practice books & tutorials (start here)

- **sc-best-practices.org** — *Single-cell best practices* (Theis lab). The primary
  modern reference; chapter per step. [04, 05, 03, 06]
  - [Raw data processing](https://www.sc-best-practices.org/introduction/raw_data_processing.html) ·
    [Quality control](https://www.sc-best-practices.org/preprocessing_visualization/quality_control.html) ·
    [Normalization](https://www.sc-best-practices.org/preprocessing_visualization/normalization.html) ·
    [Feature selection](https://www.sc-best-practices.org/preprocessing_visualization/feature_selection.html) ·
    [Dimensionality reduction](https://www.sc-best-practices.org/preprocessing_visualization/dimensionality_reduction.html) ·
    [Integration](https://www.sc-best-practices.org/cellular_structure/integration.html) ·
    [Surface protein](https://www.sc-best-practices.org/surface_protein/normalization.html) ·
    [Chromatin/ATAC](https://www.sc-best-practices.org/chromatin_accessibility/introduction.html) ·
    [RNA velocity](https://www.sc-best-practices.org/trajectories/rna_velocity.html) ·
    [Spatial intro](https://www.sc-best-practices.org/spatial/introduction.html) ·
    [Spatial deconvolution](https://www.sc-best-practices.org/spatial/deconvolution.html)
- **Bioconductor OSCA** — *Orchestrating Single-Cell Analysis*. [04, 05]
  - [Droplet processing](https://bioconductor.org/books/release/OSCA.advanced/droplet-processing.html) ·
    [Normalization](https://bioconductor.org/books/release/OSCA.basic/normalization.html) ·
    [Feature selection](https://bioconductor.org/books/release/OSCA.basic/feature-selection.html) ·
    [Doublet detection](https://bioconductor.org/books/release/OSCA.advanced/doublet-detection.html) ·
    [SingleCellExperiment class](https://bioconductor.org/books/3.13/OSCA.intro/the-singlecellexperiment-class.html) ·
    [snRNA-seq processing](https://bioconductor.org/books/3.14/OSCA.advanced/single-nuclei-rna-seq-processing.html)
- **Bioconductor OSTA** — *Orchestrating Spatially-resolved Transcriptomics Analysis*. [06]
  - [Book](https://bioconductor.org/books/release/OSTA/) ·
    [Importing data](https://bioconductor.org/books/release/OSTA/pages/bkg-importing-data.html) ·
    [Segmentation](https://bioconductor.org/books/release/OSTA/pages/img-segmentation.html) ·
    [Deconvolution](https://bioconductor.org/books/release/OSTA/pages/seq-deconvolution.html)
- **Scanpy** — [clustering/preprocessing tutorial](https://scanpy.readthedocs.io/en/stable/tutorials/basics/clustering.html) (canonical Python step order). [04, 05]
- **Seurat** — [SCTransform vignette](https://satijalab.org/seurat/articles/sctransform_vignette) ·
  [v5 integration](https://satijalab.org/seurat/articles/seurat5_integration) ·
  [v5 essential commands](https://satijalab.org/seurat/articles/seurat5_essential_commands). [04, 05, 01]
- **Luecken & Theis 2019** — *Current best practices in single-cell RNA-seq analysis: a tutorial*, Mol Syst Biol. [[PMC6582955](https://pmc.ncbi.nlm.nih.gov/articles/PMC6582955/)] [04]

---

## B. Platforms & vendor pipelines [02] (+ formats [01])

### 10x Genomics
- [Cell Ranger supported libraries](https://www.10xgenomics.com/support/software/cell-ranger/latest/resources/supported-libraries) ·
  [Command-line args (8.0)](https://www.10xgenomics.com/support/software/cell-ranger/8.0/resources/cr-command-line-arguments) ·
  [`count` pipeline](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/running-pipelines/cr-gex-count) ·
  [GEX algorithm](https://www.10xgenomics.com/support/software/cell-ranger/latest/algorithms-overview/cr-gex-algorithm) ·
  [intron-mode rec](https://www.10xgenomics.com/support/software/cell-ranger/latest/miscellaneous/cr-intron-mode-rec)
- Chemistries: [3′ structure (Teichmann scg_lib_structs)](https://teichlab.github.io/scg_lib_structs/methods_html/10xChromium3.html) ·
  [5′ structure](https://teichlab.github.io/scg_lib_structs/methods_html/10xChromium5.html) ·
  [GEM-X 3′ v4 user guide](https://www.10xgenomics.com/support/universal-three-prime-gene-expression/documentation/steps/library-prep/chromium-gem-x-single-cell-3-v4-gene-expression-user-guide)
- Flex/FRP: [what is FRP](https://www.10xgenomics.com/support/software/cell-ranger/latest/getting-started/cr-flex-what-is-frp) ·
  [FRP algorithm](https://www.10xgenomics.com/support/software/cell-ranger/8.0/algorithms-overview/cr-flex-frp-algorithm) ·
  [Flex + multi](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/running-pipelines/cr-flex-multi-frp)
- Multiome (ARC): [what is Cell Ranger ARC](https://www.10xgenomics.com/support/software/cell-ranger-arc/latest/getting-started/what-is-cell-ranger-arc) ·
  [Multiome structure](https://scg-lib-structs.readthedocs.io/en/latest/multi/10x_multiome.html)
- Multiplexing: [multi config CSV](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/inputs/cr-multi-config-csv-opts) ·
  [what is CellPlex](https://www.10xgenomics.com/support/software/cell-ranger/latest/getting-started/cr-3p-what-is-cellplex) ·
  [aggr depth normalization](https://kb.10xgenomics.com/hc/en-us/articles/115004217543) ·
  [CRISPR Guide Capture algorithm](https://www.10xgenomics.com/support/software/cell-ranger/latest/algorithms-overview/cr-crispr-algorithm) ·
  [sample-demultiplexing tools](https://www.10xgenomics.com/analysis-guides/bioinformatics-tools-for-sample-demultiplexing)
- Spatial: [Visium CytAssist](https://www.10xgenomics.com/support/cytassist-spatial-gene-expression) ·
  [Space Ranger output overview](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview) ·
  [Intro to Visium HD](https://www.10xgenomics.com/blog/your-introduction-to-visium-hd-spatial-biology-in-high-definition) ·
  [Xenium platform](https://www.10xgenomics.com/platforms/xenium) ·
  [Xenium output at a glance](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance)

### Other single-cell platforms
- **Drop-seq** — [Macosko 2015 mechanism (Wikipedia summary)](https://en.wikipedia.org/wiki/Drop-Seq) · droplet comparison [Mol Cell 2019](https://www.sciencedirect.com/science/article/pii/S1097276518308803)
- **inDrop** — [Klein/Harvard origin](https://www.rna-seqblog.com/harvard-groups-tap-microfluidics-for-single-cell-rna-seq-methods/) · [inDrop vs Drop-seq](https://pubs.rsc.org/en/content/articlehtml/2017/lc/c7lc90070h)
- **PIPseq (Fluent)** — [Nat Biotech 2023](https://www.nature.com/articles/s41587-023-01685-z) · [PIPseq T2 v4 user guide](https://www.fluentbio.com/wp-content/uploads/2024/02/PIPseq-T2-v4.0-Single-Cell-RNA-Kit-User-Guide-Rev-12.3.pdf)
- **Parse Evercode** — [technology](https://www.parsebiosciences.com/technology/) · [split-pipe (SciLifeLab)](https://ngisweden.scilifelab.se/methods/parse/) · [split-pool sensitivity (bioRxiv 2022)](https://www.biorxiv.org/content/10.1101/2022.08.27.505512v1.full)
- **SPLiT-seq** — [Rosenberg 2018, Science](https://www.science.org/doi/10.1126/science.aam8999) · **sci-RNA-seq** [PMC9839601](https://pmc.ncbi.nlm.nih.gov/articles/PMC9839601/)
- **BD Rhapsody** — [Sequence Analysis Pipeline UG](https://www.bdbiosciences.com/content/dam/bdb/marketing-documents/products-pdf-folder/software-informatics/rhapsody-sequence-analysis-pipeline/Rhapsody-Sequence-Analysis-Pipeline-UG.pdf) · [bioinfo docs](https://bd-rhapsody-bioinfo-docs.genomics.bd.com/steps/top_steps.html)
- **Seq-Well** — [Gierahn 2017, Nat Methods](https://www.nature.com/articles/nmeth.4179)
- **Smart-seq2/3** — [Picelli 2013 (SS2)](https://pubmed.ncbi.nlm.nih.gov/24385147/) · [Smart-seq3, Nat Biotech 2020](https://www.nature.com/articles/s41587-020-0497-0) · [Smart-seq3xpress 2022](https://www.nature.com/articles/s41587-022-01311-4)
- **CEL-seq2 / MARS-seq2** — [CEL-Seq2 (Hashimshony 2016)](https://dspace.mit.edu/bitstream/handle/1721.1/105787/Regev_CEL-Seq2.pdf) · [MARS-seq2.0, Nat Protoc](https://www.nature.com/articles/s41596-019-0164-4)
- Platform comparisons — [10x vs BD Rhapsody WTA 2024](https://www.sciencedirect.com/science/article/pii/S2405844024043895) · [subcellular imaging benchmark (Xenium 5K/CosMx 6K/MERFISH)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12534522/)

### Spatial platforms
- **Slide-seq** — [Rodriques 2019, Science](https://www.science.org/doi/10.1126/science.aaw1219) · [→ Curio Seeker](https://www.genengnews.com/insights/slide-seq-hits-the-spatial-biology-market-as-curio-seeker/)
- **Stereo-seq** — [Chen 2022, Cell (MOSTA)](https://www.sciencedirect.com/science/article/pii/S0092867422003993) · [STOmics "why Stereo-seq"](https://en.stomics.tech/why-stereo-seq/index.html)
- **MERFISH/MERSCOPE (Vizgen)** — [MERFISH tech](https://vizgen.com/technology/merfish-spatially-resolved-transcriptomics/) · [MERSCOPE Ultra](https://vizgen.com/merscope-ultra/)
- **CosMx SMI (Bruker/NanoString)** — [single-cell imaging overview](https://brukerspatialbiology.com/products/cosmx-spatial-molecular-imager/single-cell-imaging-overview/) · [6K launch](https://nanostring.com/pressrelease/news-news-details-2024-nanostring-launches-the-cosmx-6000-plex-rna-assay-and-showcases-whole-transcriptome-imaging-capability/)
- **GeoMx DSP** — [overview](https://brukerspatialbiology.com/products/geomx-digital-spatial-profiler/geomx-dsp-overview/) · [WTA service](https://www.mayo.edu/research/core-resources/spatial-multiomics-core/services/nanostring-geomx-whole-transcriptome-atlas-wta)
- Other ST — [DBiT-seq 2020](https://www.sciencedirect.com/science/article/pii/S0092867420313908) · [Open-ST (bioRxiv)](https://www.biorxiv.org/content/10.1101/2023.12.22.572554.full.pdf) · [computational-solutions ST review](https://www.sciencedirect.com/science/article/pii/S2001037022003786) · [image-based ST review (BioEssays)](https://onlinelibrary.wiley.com/doi/10.1002/bies.201900221)
- Spatial proteomics (adjacent) — [PhenoCycler/CODEX (Stanford)](https://microscopy.stanford.edu/resources-and-reservation/multiplexed-spatial-proteomics-services-phenocycler-aka-codex)

---

## C. File formats [01]

- **AnnData** — [on-disk `.h5ad`/`.zarr` spec](https://anndata.readthedocs.io/en/stable/fileformat-prose.html)
- **10x** — [HDF5 matrices](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-h5-matrices) ·
  [MEX matrices](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-mex-matrices) ·
  [molecule_info.h5](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-molecule-info) ·
  [BAM tags](https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-bam) ·
  [3′ v3 read structure](https://scg-lib-structs.readthedocs.io/en/latest/ge/10xChromium3v3.html)
- **Loom** — [loompy format spec](https://linnarssonlab.org/loompy/format/index.html)
- **MuData** — [`.h5mu` spec](https://mudata.readthedocs.io/en/latest/io/spec.html) · [muon multimodal](https://muon.readthedocs.io/en/latest/omics/multi.html)
- **Seurat / BPCells** — [v5 essential commands](https://satijalab.org/seurat/articles/seurat5_essential_commands) · [BPCells interaction](https://satijalab.org/seurat/articles/seurat5_bpcells_interaction_vignette)
- **Bioconductor** — [SpatialExperiment vignette](https://bioconductor.posit.co/packages/devel/bioc/vignettes/SpatialExperiment/inst/doc/SpatialExperiment.html) · [HDF5Array saveHDF5SummarizedExperiment](https://rdrr.io/bioc/HDF5Array/man/saveHDF5SummarizedExperiment.html)
- **TileDB-SOMA / Census** — [GitHub](https://github.com/single-cell-data/TileDB-SOMA) · [SOMAExperiment reference](https://single-cell-data.github.io/TileDB-SOMA/reference/SOMAExperiment.html)
- **SpatialData** — [design doc](https://github.com/scverse/spatialdata/blob/main/docs/design_doc.md) · [intro/glossary](https://spatialdata.scverse.org/en/latest/design_doc.html)
- **OME-NGFF** — [OME-Zarr spec 0.5](https://ngff.openmicroscopy.org/0.5/)
- Spatial bundles — [Xenium output](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance) ·
  [Space Ranger spatial outputs](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/spatial-outputs) ·
  [Visium HD binned outputs](https://www.10xgenomics.com/analysis-guides/segmentation-visium-hd) ·
  [Vizgen detected_transcripts](https://vizgen.github.io/vizgen-postprocessing/output_data_formats/detected_transcripts_format.html) ·
  [Stereo-seq SAW/GEF](https://en.stomics.tech/news/stomics-blog/1108.html) · [Stereopy IO](https://stereopy.readthedocs.io/en/v1.5.1/Tutorials/IO.html) ·
  [GeomxTools](https://github.com/Nanostring-Biostats/GeomxTools) · [Loupe Browser](https://www.10xgenomics.com/support/software/loupe-browser/latest)

---

## D. Modalities [03]

- **CITE-seq** — [Stoeckius 2017, Nat Methods](https://www.nature.com/articles/nmeth.4380) · ADT norm [sc-best-practices](https://www.sc-best-practices.org/surface_protein/normalization.html) · **DSB** [package](https://github.com/niaid/dsb) + [Mulè 2022, Nat Commun](https://www.nature.com/articles/s41467-022-29356-8)
- **Cell Hashing / HTO** — [Stoeckius 2018, Genome Biol](https://link.springer.com/article/10.1186/s13059-018-1603-1) · [Seurat hashing vignette](https://satijalab.org/seurat/articles/hashing_vignette) · [HTO demux benchmark, NAR GB 2023](https://academic.oup.com/nargab/article/5/4/lqad086/7306668) · [antibody vs lipid multiplexing](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8851857/)
- **Genetic demux** — [vireo](https://github.com/single-cell-genetics/vireo) · [souporcell3 preprint](https://www.biorxiv.org/content/10.1101/2025.07.10.664218.full.pdf) · [demux across species, LSA 2023](https://www.life-science-alliance.org/content/6/8/e202301979)
- **snRNA introns/QC** — [STARsolo docs](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md) · [MALAT1 nuclear QC, Cell Rep Methods 2026](https://www.cell.com/cell-reports-methods/fulltext/S2667-2375(26)00037-8) · [snRNA ambient, Neuron 2022](https://www.sciencedirect.com/science/article/pii/S0896627322008157)
- **scATAC / multiome** — [Signac PBMC vignette](https://stuartlab.org/signac/articles/pbmc_vignette) · [Signac multiomic](https://stuartlab.org/signac/articles/pbmc_multiomic) · [ArchR, Nat Genet 2021](https://www.nature.com/articles/s41588-021-00790-6)
- **V(D)J** — [immune-repertoire analysis, Nat Methods 2024](https://www.nature.com/articles/s41592-024-02243-4) · [Dandelion, Nat Biotech 2023](https://www.nature.com/articles/s41587-023-01734-7)
- **Perturb-seq** — [direct-capture Perturb-seq, Mol Cell 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7416462/)
- **Lineage tracing** — [lineage-barcoding review, PMC11694748](https://pmc.ncbi.nlm.nih.gov/articles/PMC11694748/) · [CellTag-multi, Nat Biotech 2023](https://www.nature.com/articles/s41587-023-01931-4)
- **RNA velocity** — [preprocessing affects velocity, PLoS CB 2021](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1008585)

---

## E. Tools & parameters, per step [05] (+ narrative in [04])

- **Alignment/quant** — [STARsolo manual](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md) · [alevin-fry quant](https://alevin-fry.readthedocs.io/en/latest/quant.html) + [permit-list](https://alevin-fry.readthedocs.io/en/latest/generate_permit_list.html) · [simpleaf](https://simpleaf.readthedocs.io/en/latest/quant-command.html) · [kb-python](https://github.com/pachterlab/kb_python) + [Sullivan 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10690192/) · [alevin-fry (He 2022)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8933848/)
- **Empty droplets** — [emptyDrops man](https://rdrr.io/bioc/DropletUtils/man/emptyDrops.html) · [Lun 2019, EmptyDrops (Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-019-1662-y)
- **Ambient RNA** — [SoupX (Young & Behjati 2020, GigaScience)](https://academic.oup.com/gigascience/article/9/12/giaa151/6049831) · [CellBender usage](https://cellbender.readthedocs.io/en/latest/usage/index.html) + [Fleming 2023, Nat Methods](https://www.nature.com/articles/s41592-023-01943-7) · [DecontX (Yang 2020, Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-020-1950-6) · [ambient decontamination benchmark (2026 preprint)](https://www.biorxiv.org/content/10.64898/2026.01.13.699237v1.full)
- **Doublets** — [scDblFinder ref](https://plger.github.io/scDblFinder/reference/scDblFinder.html) · [Scrublet (Wolock 2019)](https://www.cell.com/cell-systems/fulltext/S2405-4712(18)30474-5) · [DoubletFinder (McGinnis 2019)](https://www.cell.com/cell-systems/fulltext/S2405-4712(19)30073-0) · **[Xi & Li 2021 benchmark](https://www.cell.com/cell-systems/fulltext/S2405-4712(20)30459-2)**
- **QC** — [scanpy calculate_qc_metrics](https://scanpy.readthedocs.io/en/stable/api/generated/scanpy.pp.calculate_qc_metrics.html) · [scuttle isOutlier](https://rdrr.io/bioc/scuttle/man/isOutlier.html) · [miQC (Hippen 2021)](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1009290)
- **Normalization** — [scanpy normalize_total](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.normalize_total.html) · [SCTransform ref](https://satijalab.org/seurat/reference/sctransform) · [scran vignette](https://bioconductor.org/packages/release/bioc/vignettes/scran/inst/doc/scran.html) · [Pearson residuals (Lause 2021)](https://link.springer.com/article/10.1186/s13059-021-02451-7) · **[Ahlmann-Eltze & Huber 2023, Nat Methods](https://www.nature.com/articles/s41592-023-01814-1)** · [Signac RunTFIDF](https://stuartlab.org/signac/reference/runtfidf)
- **Feature selection** — [scanpy highly_variable_genes](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.highly_variable_genes.html) · [Seurat FindVariableFeatures](https://satijalab.org/seurat/reference/findvariablefeatures) · [scran getTopHVGs](https://rdrr.io/bioc/scran/man/getTopHVGs.html)
- **Scaling / cell cycle / PCA** — [scanpy scale](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.scale.html) · [Seurat cell-cycle vignette](https://satijalab.org/seurat/articles/cell_cycle_vignette.html) · [scanpy pp.pca](https://scanpy.readthedocs.io/en/stable/generated/scanpy.pp.pca.html) · [findPC (Bioinformatics 2022)](https://academic.oup.com/bioinformatics/article/38/10/2949/6565314)
- **Integration** — [Harmony (Korsunsky 2019, Nat Methods)](https://www.nature.com/articles/s41592-019-0619-0) · [scVI/scvi-tools](https://docs.scvi-tools.org/en/stable/api/reference/scvi.model.SCVI.html) · [Seurat IntegrateLayers](https://satijalab.org/seurat/reference/integratelayers) · [batchelor fastMNN](https://rdrr.io/bioc/batchelor/man/fastMNN.html) · [BBKNN](https://github.com/Teichlab/bbknn) · [Scanorama](https://github.com/brianhie/scanorama) · [rliger optimizeALS](https://rdrr.io/cran/rliger/man/optimizeALS.html) · **[Luecken 2022 scIB, Nat Methods](https://www.nature.com/articles/s41592-021-01336-8)** · **[Tran 2020, Genome Biol](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-019-1850-9)**
- **Impact-of-choices** — [Germain 2020, pipeComp (Genome Biol)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-020-02136-7)

---

## F. Spatial processing tools [06]

- **Import/ecosystem** — [squidpy tutorials](https://squidpy.readthedocs.io/en/stable/notebooks/tutorials/index.html) · [spatialdata-io readers](https://spatialdata.scverse.org/projects/io/en/latest/) · [Seurat spatial](https://satijalab.org/seurat/articles/spatial_vignette.html) + [imaging spatial](https://satijalab.org/seurat/articles/seurat5_spatial_vignette_2) · [Giotto](https://giottosuite.com/) + [Genome Biol 2021](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-021-02286-2) · [Voyager](https://pachterlab.github.io/voyager/) · [semla (Bioinformatics 2023)](https://academic.oup.com/bioinformatics/article/39/10/btad626/7319366) · [Bento](https://bento-tools.readthedocs.io/) · [sopa (Nat Commun 2024)](https://www.nature.com/articles/s41467-024-48981-z)
- **Vendor spatial pipelines** — [Space Ranger outputs](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview) · [Space Ranger v4 segmented outputs](https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/segmented-outputs) · [Xenium segmentation algorithm](https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/algorithms-overview/segmentation) · [xeniumranger resegment](https://www.10xgenomics.com/support/software/xenium-ranger/latest/analysis/running-pipelines/XR-resegment) · [VPT (Vizgen)](https://github.com/Vizgen/vizgen-postprocessing) · [CosMx analysis KB](https://nanostring.com/support/knowledgebase/cosmx-smi-data-analysis/) · [GeoMx workflow (standR)](https://davislaboratory.github.io/GeoMXAnalysisWorkflow/)
- **Segmentation** — [StarDist (arXiv)](https://arxiv.org/abs/1806.03535) · [Baysor](https://kharchenkolab.github.io/Baysor/dev/segmentation/) · [proseg (Nat Methods 2025)](https://www.nature.com/articles/s41592-025-02697-0) · [bin2cell (Bioinformatics 2024)](https://academic.oup.com/bioinformatics/article/40/9/btae546/7754061) · [Xenium multimodal segmentation](https://www.10xgenomics.com/analysis-guides/unveiling-xenium-multimodal-cell-segmentation)
- **Deconvolution** — [cell2location](https://cell2location.readthedocs.io/en/latest/notebooks/cell2location_tutorial.html) · [RCTD/spacexr (Nat Biotech 2021)](https://www.nature.com/articles/s41587-021-00830-w) · [Tangram (Nat Methods 2021)](https://www.nature.com/articles/s41592-021-01264-7) · **[Spotless benchmark (eLife)](https://elifesciences.org/articles/88431)** · [deconvolution+integration benchmark (Bioinformatics 2023)](https://academic.oup.com/bioinformatics/article/39/1/btac805/6900924)
- **Registration/alignment** — [PASTE2 (Genome Res 2023)](https://genome.cshlp.org/content/33/7/1124) · [STalign (Cell Systems 2025)](https://www.cell.com/cell-systems/fulltext/S2405-4712(25)00097-3)
- **Spatial normalization/batch** — [imaging-based normalization benchmark (Genome Biol 2024)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-024-03303-w) · [Crescendo (Genome Biol 2025)](https://link.springer.com/article/10.1186/s13059-025-03479-9)
- **Xenium FDR caveat** — [off-target probe binding (eLife reviewed-preprint)](https://elifesciences.org/reviewed-preprints/107070)

---

## G. Key benchmark papers (the "which is best" evidence)

| Topic | Paper | Verdict (short) | Doc |
|---|---|---|---|
| Integration | **Luecken et al. 2022, scIB (Nat Methods)** | scVI/scANVI, Harmony, Scanorama top; HVGs help, scaling hurts; scANVI/scGen best with labels | 04, 05 |
| Batch correction | **Tran et al. 2020 (Genome Biol)** | Harmony/LIGER/Seurat 3 strongest; Harmony fast | 05 |
| Doublets | **Xi & Li 2021 (Cell Systems)** | scDblFinder best overall | 04, 05 |
| Normalization | **Ahlmann-Eltze & Huber 2023 (Nat Methods)** | log1p + PCA competitive with / ≥ SCT & Pearson | 04, 05 |
| Filtering/norm impact | **Germain et al. 2020, pipeComp (Genome Biol)** | preprocessing choices have large downstream impact | 05 |
| Ambient RNA | **Fleming et al. 2023, CellBender (Nat Methods)** + [2026 decontamination benchmark](https://www.biorxiv.org/content/10.64898/2026.01.13.699237v1.full) | CellBender strong; over-correction is the risk | 04, 05 |
| Spot deconvolution | **Spotless (eLife)** | cell2location / RCTD / SPOTlight top-tier | 06 |
| Subcellular platforms | [Xenium 5K vs CosMx 6K vs MERFISH (PMC12534522)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12534522/) | sensitivity/segmentation head-to-head | 02, 06 |

---

## H. Legacy pipeline (grounding) [07]

- Source repo: `sc-website-scripts` (iSCanGuide project) — `data-process.R`,
  `save-sample.R`, `sample-add-metadata.R`, `utils/`, `conda/sc-common`. Requires
  the `QueueUtils` job-queue framework (`github.com/tinnlab/sc-task-queue`). Read
  directly from source; see `07-sc-website-scripts-digest.md`.

---

*Every link above also appears — with a one-line annotation — in the `## Sources`
section of the topic doc noted in brackets. Consult those per-doc lists for the
complete, annotated set.*
