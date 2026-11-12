# Study Analysis Workflow — Design Candidates

**Round:** ITERATION /feature-lifecycle · design-candidates phase (no code).
**Feature:** the end-to-end single-cell pipeline inside a study — **upload samples → QC → save → analysis → visualization**.
**Deliverable:** N coherent candidate designs grounded in (1) the current txr code, (2) current-tools research, (3) user-JTBD research → a recommendation → **PAUSE for the user to pick** before implementing.

> **TL;DR recommendation:** **Candidate D — "Guided Pipeline + Explorer" (progressive-disclosure hybrid)**, built MVP-first (Candidate A's linear happy-path is literally phase 1 of D). It is the one design that fills the market's **unmet middle** — Cellenics' guided *per-sample* QC **+** cellxgene's WebGL-scale exploration **+** Azimuth's *reproducible script export* — which no existing tool spans, and it maps cleanly onto the study-extension seam, the jobs+sandbox executor, and the `DATA_STORAGE_REDESIGN` working-store. See **Part E**.

---

# Part A — Research synthesis (what grounds the candidates)

## A0. Current txr code — what exists to build on (SUGGESTION, not constraint)

| Seam | State today | Implication for this feature |
|---|---|---|
| **Study extension registry** (backend `study/core/extension/registry.rs` linkme slice + `StudyExtension` trait; frontend `STUDY_SLOTS = study_nav/detail_panels/card_tags`) | ✅ Solid. `dataset` module is the reference consumer. `on_study_deleted`/`on_study_duplicated`/`collect_summary`/`register_routes` hooks over one shared tx. | New workflow modules (samples/QC/analysis/viz) plug in with **zero study-core edits**, exactly like `dataset`. Delete/duplicate cleanup is a first-class hook. |
| **jobs** module (FCFS scheduler + concurrency cap; `JobRunner::spawn(job)->SpawnedJob` trait; per-job SSE logs+metrics; cancel; `Job{job_type:String, params:JSONB, status}`) | ✅ Works, but runner is a **stub** (`sh -c` loop). **No job-type registry** — `job_type` is free-form; nothing dispatches on it. | Analysis steps run as jobs. Must add a **job-type → runner dispatch** and drop `sandbox::run_analysis` behind the `JobRunner` trait. |
| **sandbox** module (`run_analysis(cmd, extra_mounts)` → bwrap R/Python; per-job 0700 workspace bound RW at `/home/analyst`; `ExtraMount{host_path, sandbox_path, mode}`; Linux-only→503) | ✅ Execution primitive proven. | Plumb input matrix (RO) + output dir (RW) via `ExtraMount`. **Nuance:** `run_analysis` *awaits to completion* and returns `AnalysisResult`; `JobRunner::spawn` wants a *streamable child*. Reconcile (a spawn-variant that streams stdout→job_logs) — see **DEC-JOBSEAM**. |
| **rootfs** (`include_bytes!`-embedded, squashfuse-mounted, `ensure_ready()`) | ⚠️ **Minimal** — Debian + `r-base-core` + `python3` + R `jsonlite` only. **No scanpy/anndata/Seurat.** | Provisioning the scientific stack into the rootfs Dockerfile (+ bump `ROOTFS_SCHEMA_VERSION`) is **in-scope, load-bearing work**. Drives the R-vs-Python decision (**DEC-LANG**). |
| **dataset** module (`Dataset{n_cells,n_genes,status: created→uploaded→analyzed}`; registers as study extension) | ⚠️ **Upload is a STUB.** `txresbench-file` (SDK blob store) exists but is **not even a dep** of the app server. No `study_id`/`file_id`/`owner_id` columns wired. | Wiring real matrix upload (multipart→`txresbench-file`→parse) is **in-scope**. `datasets` ≈ the "samples" concept — decide whether to extend `dataset` or add a `sample`/`analysis` module (**DEC-MODULES**). |
| **`DATA_STORAGE_REDESIGN.md`** (working-store = kind-typed HDF5 artifacts + Postgres catalog; typed-binary streaming to deck.gl; canonical dense cell-index + bitmask set-ops; AnnData import/export only) | 📄 Proposal, not yet built. | This is the **data-path blueprint** for save+analysis+viz. All candidates adopt it; they differ only in how much of it phase-1 needs. Hits **SDK gap FE-10** (binary/ArrayBuffer response plane — worked around by a thin streaming client). |
| **Study sharing + transfer** (already shipped: share drawer, transfer, sync) | ✅ | The "hand off an interactive result" JTBD (research §6) is **partly free** — a shared study already reaches another user; we add the read-only *explorer* view. |

## A1. Current tools — the market shape (full report in research streams)

Two philosophies split the market, and the split defines every tool's UX:

- **Pipeline builders** (arrive with raw-ish data, drive it through QC→cluster): **Cellenics/Biomage**, **Galaxy**, **Partek Flow**, **Azimuth**.
- **Result explorers** (heavy compute happened elsewhere; GUI is a fast viewer): **cellxgene**, **10x Loupe**, **BBrowser**.

Four **step-model archetypes** (each candidate below picks one deliberately):

1. **Fixed ordered step-panel, tune each step in place** — *Cellenics*: left rail, **auto-suggested-then-adjustable per-sample** thresholds, the right plot next to every knob, downstream invalidation on change. Best guided-QC UX in the market; **cost:** no non-standard order.
2. **Short linear wizard** — *Azimuth* (~4 steps) + a **runnable R script export** so power users aren't trapped ("GUI to explore, script to reproduce" — worth stealing).
3. **DAG / task-node graph** — *Galaxy, Partek Flow*: branchable, maximal reproducibility + side-by-side alternatives; **cost:** complexity, intimidating, slow.
4. **Free exploration of pre-computed data** — *cellxgene, Loupe, BBrowser*: WebGL scatter fluid at **millions of cells**, lasso/brush/cross-filter; **cost:** does *none* of the pipeline.

**The market's unmet middle (the wedge):** nothing does Cellenics' guided per-sample QC **and** cellxgene's WebGL-scale exploration **and** Azimuth's reproducible export. That gap is the product opportunity.

**Real QC threshold numbers users expect** (so our defaults are credible):
- **%mito:** classic fixed **5%** (Seurat human tutorial); tissue-dependent, often **10–20%** (heart/muscle/liver higher). Data-driven is better.
- **n_genes:** Seurat filters `<200 or >2,500`; common floor `≥100`.
- **UMI/counts:** Cell Ranger won't call `<500 UMI` as cells; upper bound catches doublets.
- **Modern default = adaptive:** flag outliers at **3–5 MADs** from the median (OSCA `isOutlier`, 3 MADs ≈ retains 99%; scverse best-practices uses **5 MADs** on `log1p_total_counts`/`log1p_n_genes`/`pct_in_top_20` + a **3-MAD & absolute `pct_mt>8%`** mito rule). **Golden rule: per-sample, not global** — the single most-cited QC mistake, and the thing Cellenics alone makes the default.
- **Doublets:** 10x Chromium ≈ **0.8% multiplets / 1,000 cells**; `scDblFinder` (current recommended) / Scrublet / DoubletFinder; **run per-sample, never on the merged object.**

## A2. Canonical pipeline "spine" (all three ecosystems agree — this is the step sequence)

```
raw counts (cells × genes)
 → QC metrics + cell/gene filter + doublet detection      (PER-SAMPLE)
 → normalization + log/variance-stabilizing transform
 → highly-variable-gene selection
 → [scale] → PCA
 → [batch integration if multiple samples]  ← replaces/augments PCA→graph
 → kNN graph → UMAP/t-SNE
 → Leiden/Louvain clustering
 → marker/DE → cell-type annotation
```

Exact function mapping (Scanpy / Seurat / OSCA) and where each result lives (AnnData `obs`/`var`/`obsm`/`layers`/`uns`) is captured in the research; the **decision/branch nodes** (where a human or the tool must choose) are: QC strategy (fixed vs adaptive MAD; per-batch), doublet tool + rate, normalization method, #HVGs, #PCs, whether/which integration, **clustering resolution** (the most consequential subjective knob — sweep several), annotation (manual markers vs reference).

## A3. What users actually want (JTBD) — the design drivers

**Personas:** wet-lab biologist ("just see my clusters, code-free") · bioinformatician ("control, params, reproducible, export the object + code") · core facility ("throughput + standard deliverable per PI") · PI/reviewer ("interactive result, no install").

**The core wedge (both research streams converge):** **"easy but not a black box"** — one **progressive-disclosure** surface where a biologist rides sane defaults to a figure *and* a bioinformatician opens every parameter + exports object+code. Serving only one persona cedes the other; the fragmentation ("GUI toy vs code wall") is the #1 complaint.

**Ranked JTBD → table-stakes (TS) vs delighter (DL):**
1. See clusters + markers, code-free (TS) · 2. Annotate with defensible evidence (TS UX; evidence/override DL) · 3. Compare conditions *correctly* — pseudobulk for cross-condition DE, count-split for markers (TS it exists; correct-by-default DL) · 4. **Iterate cheaply** — re-cluster/subcluster/re-integrate without recompute; side-by-side compare (DL — biggest workflow differentiator) · 5. **Hand off an interactive result, no install** (DL — highest collab value; partly free via study share) · 6. Reproduce & report — auto params/versions/seeds + generated methods text (TS for rigor; DL broadly) · 7. Get data/figures out — object + vector figures + tables + gene lists, no lock-in (TS).

**Ranked pain points → what the tool should do:**
1. **QC "did I over-filter?" with no feedback** → adaptive per-sample thresholds by default, **before/after diff**, **"you may have removed cell type X"** warning, per-sample outlier flags.
2. **Two-worlds fragmentation** → progressive disclosure (the wedge).
3. **Statistical traps** (double-dipping DE, pseudoreplication, over-integration/over-clustering) → **active guardrails** that warn + offer the correct method (differentiator + retraction insurance).
4. **Iteration slow / state lost** → cached intermediates, cheap re-clustering, branching, provenance across passes.
5. **Hand-off = static PDFs + round-trips** → read-only interactive shareable link.
6. **Annotation tedious/subjective/unreproducible** → suggest-with-evidence + override + logged rationale.
7. **"Can't reproduce my own analysis"** → auto provenance + versions/seeds + generated methods.
8. **Data/format lock-in** → bidirectional `.h5ad`/`.rds` export.

---

# Part B — Shared foundations (the same under ALL candidates)

These are **not** what the user is choosing between; they follow from the code + the storage doc regardless of archetype. The candidates differ in **UX flow, step-sequencing model, and iteration model** on top of this.

- **Compute:** every heavy step is a **`jobs` job** whose runner calls **`sandbox::run_analysis`**, mounting the sample matrix (RO) + a per-run output dir (RW). Progress/logs/metrics already stream via the job SSE. Requires: a **job-type→runner dispatch** in `jobs`, the **jobs↔sandbox seam reconciliation** (DEC-JOBSEAM), and the **scientific rootfs** (DEC-LANG).
- **Working store:** per `DATA_STORAGE_REDESIGN` — **kind-typed HDF5 artifacts** (`expression`/`embedding`/`clustering`/`de`/`metadata-column`/…) + a **Postgres catalog** (`analysis_results`-style rows). Canonical cell axis = **dense study view-index + `(sample, local_index)` durable id**; cell sets = **bitmasks** (AND/OR/ANDNOT). AnnData `.h5ad` is **import/export only**.
- **Viz data plane:** server reads the HDF5 artifact, streams **raw typed-array binary** (`ArrayBuffer`→`Float32Array`/`Uint32Array`) to **deck.gl**; gene coloring = **sparse CSC column slice** (`indptr[g..g+1]`), O(nnz of gene). Hits **SDK gap FE-10** → thin purpose-built streaming client until the SDK gains binary responses.
- **Module wiring:** each new module self-registers via `#[distributed_slice(STUDY_EXTENSIONS)]` (backend) + `study-extension/extension.tsx` (frontend `STUDY_SLOTS`), with `on_study_deleted`/`on_study_duplicated` cleanup and per-module colocated migrations (auto-merged; start at `≥ 20260720…`).
- **Permissions:** `perm!(...)` per module + a `_grants.sql` to the Users group; FE `Permissions.X` generated; gate routes + slots.

---

# Part C — The candidates

Each candidate is a distinct **take on UX flow + step-sequencing + iteration**. All sit on Part B.

## Candidate A — "Guided Pipeline" (fixed linear step-panel · Cellenics-style · biologist-first)

**Concept.** A fixed, ordered step rail inside the study (the Cellenics model, archetype 1). The user uploads samples, then walks the QC steps one at a time; each step shows the **auto-suggested per-sample threshold + the right plot**, the user adjusts, moves on; changing a step invalidates downstream. Ends in embedding+clustering and a basic set of plots.

**UX flow.** Study → "Analysis" section (a `detail_panels` slot) → left rail: `Upload → Classifier/empty-drops → Cell-size (knee) → %mito → genes-vs-UMIs → Doublets → Normalize+Integrate → Embed+Cluster → Explore/Plots`. One panel per step; "Run" enqueues a job; downstream steps show "stale — re-run."

**Step sequencing.** Linear, fixed order = the canonical spine (A2). Enable/disable toggles per step; no reordering.

**Data model.** One `analysis_run` per study (the pipeline instance) with per-step `params` + status + output artifact (kind-typed HDF5) + catalog rows. Re-running a step supersedes its + downstream artifacts.

**Job orchestration.** One job per step (`job_type = "qc.mito"`, `"analysis.cluster"`, …); FCFS queue; SSE progress. Downstream invalidation = mark stale + let the user re-run (or auto-chain).

**Module structure.** `analysis` study-extension module (rail + panels) + `sample` upload (extend `dataset`) + the results-store/streaming module + rootfs stack. ~2–3 modules.

**Persona fit.** Wet-lab biologist ★★★ · bioinformatician ★ · PI ★ (view only at end).
**Tradeoffs.** ➕ Simplest coherent build; best guided-QC UX; smallest surface; directly mirrors the proven Cellenics flow. ➖ No progressive disclosure (bioinformatician sees a "toy"); no cheap iteration/branching/compare; no script export; fixed order can't do non-standard analyses. **This is essentially the MVP of Candidate D.**

## Candidate B — "Analysis Session / Guided Notebook" (free-order stepwise session · bioinformatician-first)

**Concept.** A live analysis **session** over a study's samples — a structured, guided-notebook surface (archetype between 3 and a notebook). The user adds **steps** from a palette (QC filter, normalize, HVG, PCA, integrate, cluster@res, UMAP, DE, annotate) in any order; each step runs as a job against the current cached AnnData state; every parameter is exposed. A running **log of steps = the provenance**; export the notebook/script.

**UX flow.** Study → "Analysis" → a session view: a linear list of executed **step cards** (each = params + result + plot inline), a "+ add step" palette, and a persistent embedding explorer pane. Re-run/edit any step; fork the session.

**Step sequencing.** Free, user-driven (guarded: a step declares its input kind, so the palette greys out steps whose inputs aren't ready). The spine is the *suggested* path, not enforced.

**Data model.** A `session` with an ordered list of `session_steps` (each `kind`, `params`, input-artifact ref, output-artifact ref). Cached intermediate artifacts make re-running one step cheap. Sessions are forkable (copy the step list + re-point artifacts).

**Job orchestration.** Every step card = a job; the session tracks a DAG implicitly via input/output artifact refs.

**Module structure.** `analysis-session` module + sample upload + results-store + rootfs. The session view is heavier FE.

**Persona fit.** Bioinformatician ★★★ · biologist ★ (palette is intimidating) · PI ★.
**Tradeoffs.** ➕ Full control + every param + natural provenance + cheap re-run + fork; script export is native (the step list *is* the script). ➖ Not code-free-friendly for biologists (no "just give me clusters" happy path); more FE surface; free ordering invites invalid/こnon-canonical analyses without guardrails. Closest to "a nicer Scanpy notebook."

## Candidate C — "Workflow Graph / DAG" (branchable task-node canvas · reproducibility-first · core-facility)

**Concept.** A visual **node-graph canvas** (Galaxy/Partek, archetype 3): nodes = steps, edges = data flow; branch a node to try alternative parameterizations **side-by-side**; the graph *is* the reproducible, exportable record. Templates industrialize repeated analyses.

**UX flow.** Study → "Workflow" → canvas: drag Import→QC→Normalize→Integrate→Cluster→DE nodes; each node has params + a result preview; right-click a node → "branch with different resolution." Save graph as a reusable template; apply a template to new samples.

**Step sequencing.** Explicit DAG; branching is first-class → native side-by-side compare (a top JTBD).

**Data model.** `workflow` (graph) + `workflow_nodes` (kind, params, upstream refs) + per-node output artifact/catalog rows. Branches share upstream artifacts (cheap). Templates = a graph with no bound inputs.

**Job orchestration.** Each node = a job; the graph topological-sorts into the FCFS queue; a node re-run invalidates only its subtree.

**Module structure.** `workflow` module (canvas is a substantial FE build — node graph lib, layout) + sample upload + results-store + rootfs.

**Persona fit.** Core facility ★★★ · bioinformatician ★★★ · PI ★★ (audit trail) · biologist ★ (canvas is intimidating).
**Tradeoffs.** ➕ Best reproducibility + branching/compare + templates for throughput; the audit-trail deliverable wins institutional adoption. ➖ **Biggest build** (graph-canvas UX is a project by itself); intimidating for the primary biologist persona; overkill for "just see my clusters." Highest risk for this round's scope.

## Candidate D — "Guided Pipeline + Explorer" (progressive-disclosure hybrid) ⭐ RECOMMENDED

**Concept.** The **unmet middle**, built as **one surface with two depths**. A **guided linear pipeline spine** (Candidate A's step rail) is the default path — biologist rides auto per-sample QC + sane defaults straight to a **cellxgene-scale WebGL explorer**. **Progressive disclosure** turns each step into a full parameter panel for the bioinformatician. Layered in: **active statistical guardrails**, **cheap re-clustering + branchable "runs"** for compare, a **suggest-with-evidence annotation** step, and **reproducible script/methods + object export** (Azimuth's escape hatch). Every JTBD from A3 has a home; nothing forces a canvas.

**UX flow.**
- **Default (biologist):** Upload samples → "Review QC" (auto per-sample thresholds pre-filled, before/after diff, over-filter warnings, one "Looks good, continue") → "Analyze" (one click: normalize→HVG→PCA→[integrate]→cluster→UMAP with defaults) → **Explorer** (WebGL UMAP, color-by cluster/gene/metadata, lasso, marker table) → annotate (suggested labels + evidence) → Share/Export.
- **Depth (bioinformatician):** every step panel expands to all params (nmads, normalization method, #HVGs, #PCs, integration method, resolution); a **"branch this run"** creates a parallel run to compare resolutions/integrations **side-by-side**; guardrails fire (double-dipping DE → offer count-split; cross-condition DE → offer pseudobulk; over-integration/over-cluster flags); "Export → script + methods paragraph + `.h5ad`/`.rds`."
- **Hand-off (PI/reviewer):** the study's existing **share** → a **read-only Explorer** link (no install).

**Step sequencing.** Guided linear spine (A2) with per-sample QC; **re-run-from-step** downstream invalidation (A's model) **plus** **branchable runs** (a lightweight slice of C's compare, without the full canvas).

**Data model.** `analysis_run` per study (a pipeline instance) — **multiple runs coexist** (the branch/compare + re-run-history model from `DATA_STORAGE_REDESIGN` §3.6: each analysis a study-unique id, NA-aligned to the canonical axis, no overwrite). Kind-typed HDF5 artifacts + catalog. Cached intermediates → cheap re-cluster. Annotation + provenance (params/versions/seed) captured per run.

**Job orchestration.** One job per step (job-type dispatch); downstream invalidation; branch = fork the run's params + re-run from the branch point (shares upstream artifacts). SSE progress.

**Module structure (plugs into study via STUDY_EXTENSIONS):**
- `sample` (upload + per-sample QC; extends/replaces `dataset` upload) — `study_nav` "Samples" + `on_study_deleted` file cleanup.
- `analysis` (the pipeline spine + runs + step panels + guardrails) — `study_nav` "Analysis".
- `explorer` (WebGL deck.gl + the typed-binary streaming client) — `study_nav` "Explore".
- `results-store` (server: kind-typed HDF5 read/write + catalog + streaming endpoints; the `run_analysis` output contract).
- rootfs scientific stack.
Each is an independent study-extension → incremental, testable, `on_study_deleted`-clean.

**Persona fit.** Biologist ★★★ · bioinformatician ★★★ · PI/reviewer ★★★ · core facility ★★ (templates deferred).
**Tradeoffs.** ➕ Fills the market wedge; serves all personas via one surface; every top JTBD addressed; **phaseable** — phase 1 == Candidate A (ship value fast), later phases add depth/guardrails/compare/export. ➖ Largest *total* scope of the linear options (mitigated by phasing); the branch/compare + guardrails are real engineering; still not a full DAG (deliberate — templates/arbitrary-order deferred to a future Candidate-C layer if needed).

---

# Part D — Comparison matrix

| Axis | A · Guided Pipeline | B · Analysis Session | C · Workflow DAG | **D · Pipeline + Explorer ⭐** |
|---|---|---|---|---|
| Archetype | fixed step-panel | free-order session | node graph | step-panel + explorer (progressive) |
| Primary persona | biologist | bioinformatician | core/bioinformatician | **all (progressive disclosure)** |
| Code-free happy path | ✅ | ❌ | ❌ | ✅ |
| Full param control | ❌ | ✅ | ✅ | ✅ (on expand) |
| Cheap iterate / re-cluster | ❌ | ✅ | ✅ | ✅ |
| Side-by-side compare | ❌ | fork | ✅ branches | ✅ branchable runs |
| Statistical guardrails | ❌ | possible | possible | ✅ (designed in) |
| WebGL-scale explorer | basic | basic | basic | ✅ (core) |
| Reproducible script/methods export | ❌ | ✅ native | ✅ graph | ✅ |
| Interactive share/hand-off | end only | ❌ | audit | ✅ (read-only link) |
| Fills market "unmet middle" | partly | no | no | **✅** |
| Build size (this round) | **S** | M | **L** | M–L (phaseable; phase 1 = A) |
| Risk | low | med | high | med (low if phased) |

---

# Part E — Recommendation

**Recommend Candidate D — "Guided Pipeline + Explorer" — built MVP-first (phase 1 == Candidate A).**

**Why D.**
1. **It's the only candidate that fills the market's unmet middle** (guided per-sample QC + WebGL-scale exploration + reproducible export) — the explicit product opportunity from both research streams.
2. **It resolves the #1 user complaint** (GUI-toy-vs-code-wall) via progressive disclosure — one surface, biologist → bioinformatician, instead of picking a persona to cede.
3. **Every top JTBD has a home** (code-free clusters, defensible annotation, correct-by-default DE via guardrails, cheap iteration + compare, no-install hand-off, auto-repro, no-lock-in export).
4. **It maps cleanly onto what exists** — the study-extension seam, jobs+sandbox executor, and the `DATA_STORAGE_REDESIGN` working-store — with no architectural fight.
5. **It's phaseable, so it de-risks**: phase 1 *is* Candidate A (a shippable, valuable guided pipeline + basic explorer); depth/guardrails/compare/export land in later phases. We never build a big-bang.

**Why not the others (as the target):** **A** alone strands the bioinformatician and skips the differentiators; **B** strands the biologist (no code-free path — our primary persona); **C**'s graph-canvas is a project unto itself and intimidates the primary persona — its one unique win (branch/compare) is captured in D as "branchable runs" without the canvas cost. C's template/throughput layer is the natural *future* extension of D if core-facility demand appears.

**Proposed phasing (becomes the /feature-lifecycle plan once picked):**
- **Phase 1 (MVP = Candidate A):** real sample upload (`txresbench-file`) + per-sample **adaptive-MAD QC** with before/after diff → normalize→HVG→PCA→cluster→UMAP as jobs → **basic WebGL explorer** (color-by cluster/gene). Scientific rootfs + jobs↔sandbox seam + results-store + catalog + typed-binary streaming. *Ships the code-free happy path.*
- **Phase 2 (depth):** progressive-disclosure param panels; multi-sample **integration**; **branchable runs** + side-by-side compare; cheap re-cluster.
- **Phase 3 (rigor + reach):** DE (marker + cross-condition) with **statistical guardrails**; **annotation** (suggest-with-evidence + reference mapping); **reproducibility** (auto params/versions/seed + methods text) + **script/`.h5ad`/`.rds` export**; **read-only Explorer share**.

---

# Part F — Cross-cutting decisions the pick implies (need the user's call)

These are largely archetype-independent but the pick sets their context. Full framing in `LIVE5_QUESTIONS.md`.

- **DEC-LANG — compute language in the rootfs.** **Python/scanpy (AnnData-native)** vs **R/Seurat** vs **both**. *Recommendation: Python/scanpy primary* — AnnData is the interop lingua franca and aligns with the storage doc's `read_elem`/`.h5ad` export path; scanpy is the pragmatic default with one canonical tutorial. (The legacy txr ref used R/rhdf5; the storage doc keeps HDF5 but not R specifically.) R export (`.rds`) can come later for the bioinformatician.
- **DEC-QC — QC threshold strategy.** *Recommendation: adaptive MAD per-sample by default (5-MAD counts/genes + 3-MAD & `pct_mt>8%`), with fixed-cutoff override* — matches OSCA + scverse best-practices and the market gap Cellenics proved.
- **DEC-MODULES — module decomposition.** Extend `dataset` for samples, or introduce `sample`/`analysis`/`explorer` modules? *Recommendation: keep `dataset`≈raw-file record; add `sample`+`analysis`+`explorer`+`results-store` as study extensions* (clean `on_study_deleted`, independent testability).
- **DEC-JOBSEAM — jobs↔sandbox reconciliation.** `run_analysis` awaits; `JobRunner::spawn` streams. *Recommendation: add a spawn-style sandbox entry that streams stdout→job_logs and returns a child the executor drives* (preserves live progress; keeps the single executor).
- **DEC-SCOPE — this round's build scope.** Phase 1 only (MVP), Phases 1–2, or full 1–3? *Recommendation: agree the target = D; implement Phase 1 this round, then continue.*

---

## Sources
Research streams (this round): interactive-platform teardown (Cellenics/Biomage, cellxgene, Galaxy, Loupe, BBrowser, Partek, Azimuth); programmatic-pipeline deep-dive (Scanpy/Seurat/OSCA/scverse, doublets, integration, data models); single-cell researcher JTBD + pain points. Key external anchors: sc-best-practices.org (QC/normalization/integration), OSCA (adaptive MAD QC), 10x QC-filters guide, Luecken et al. 2022 scIB benchmark (*Nat Methods*), Cellenics/Biomage docs + repo, Azimuth (script-export pattern), cellxgene (WebGL exploration), ClusterDE / count-splitting + pseudobulk (statistical guardrails). Internal: `docs/DATA_STORAGE_REDESIGN.md`, the study-extension registry, jobs/sandbox/dataset/rootfs modules, `SDK_GAPS.md` FE-10.
