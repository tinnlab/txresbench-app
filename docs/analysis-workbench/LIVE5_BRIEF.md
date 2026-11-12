# LIVE5 BRIEF — Study Analysis Workflow: DESIGN CANDIDATES FIRST (iteration /feature-lifecycle)

You (live5) built sandbox/rootfs + the study extension system (both merged). This
is an **ITERATION** round on the study area, and the deliverable THIS round is
**multiple DESIGN CANDIDATES** for the CORE study analysis + workflow — the actual
single-cell science. **DO NOT jump to one plan or to code.** Research + design
first, present candidates for the user to choose, THEN implement the chosen one.

## 0. Where to work
- **Worktree (ready):** `/data/pbya/txresbench/tmp/analysis-workflow-wt` branch
  **`feat/analysis-workflow`** (off current `origin/main` `587ca91` — has study +
  study-extensions + sandbox + rootfs + jobs; sdk `95acb82`; env greened).
- Launched in `/data/pbya/txresbench/txresbench` for memory. **`/clear` FIRST** (you just
  finished study-extensions; you need fresh capacity for deep research + design).
- Gate: `node .../analysis-workflow-wt/.claude/lifecycle/lifecycle-check.mjs --repo <wt> --phase <N>`.

## 1. The feature — the study analysis WORKFLOW
The end-to-end single-cell analysis pipeline INSIDE a study:
1. **UPLOAD SAMPLES** (raw single-cell data — 10x matrices, `.h5ad`, etc.)
2. **QUALITY CONTROL (QC)** — QC metrics, filter cells/genes/doublets
3. **SAVE SAMPLES** (persist to the working store)
4. **ANALYSIS** (clustering, DE, embedding, … via the sandbox running R/Python)
5. **VISUALIZATION** (deck.gl)

## 2. ⚠️ THIS ROUND = MULTIPLE DESIGN CANDIDATES + DEEP RESEARCH (the user's explicit ask)
Produce **MULTIPLE coherent design candidates** for the workflow (best-of-N /
design-variant-tournament style — see the committed `design-variant-tournament`
skill), each a distinct take on: the **UX flow**, the **data model**, the **job
orchestration** (via the jobs scheduler + sandbox), the **step sequencing**
(upload→QC→save→analyze→viz), and the **module structure** (how upload / sample-mgmt
/ QC / clustering / embedding modules plug into a study via the extension system you
built). Ground every candidate in THREE inputs:

1. **Digest the CURRENT TxResBench code CAREFULLY — but as a SUGGESTION ONLY, not a
   constraint.** Read: `modules/study` (+ the `STUDY_EXTENSIONS` registry / `STUDY_SLOTS`
   / recent-studies sidebar you just built — the workflow modules will plug in HERE),
   `modules/dataset`, `modules/sandbox` + `modules/rootfs` (the R/Python execution
   env), `modules/jobs` (the FCFS job queue for analysis), and **`docs/DATA_STORAGE_REDESIGN.md`**
   (the working-store HDF5 artifacts + typed-array streaming design — CRITICAL for the
   save/analysis/viz data path). The design MAY propose changing any of it.
2. **DEEP internet research — CURRENT TOOLS.** How do existing single-cell platforms
   structure upload→QC→save→analysis→viz? Study (use WebSearch/WebFetch):
   Cellenics/Biomage, Seurat + Scanpy pipelines, Bioconductor OSCA, Galaxy Single-Cell,
   cellxgene / CELLxGENE Census, 10x Loupe, Azimuth, BBrowser, Partek Flow,
   nf-core/scrnaseq, scverse ecosystem. Extract: their step models, QC conventions +
   thresholds, data formats (AnnData/SCE/Seurat), interactivity, reproducibility,
   batch/integration handling, and UX patterns — what each does WELL and BADLY.
3. **DEEP internet research — WHAT USERS WANT.** What do single-cell researchers
   actually want to DO (JTBD), and where do current tools frustrate them? QC decisions
   they agonize over, analyses they run + re-run, how they iterate, collaborate,
   reproduce, and export; wet-lab vs bioinformatician personas; the "I just want to see
   my clusters" vs "I need publication-grade reproducibility" spectrum.

Then **synthesize the candidates** (e.g. a guided linear WIZARD/pipeline · an
exploratory NOTEBOOK/session · a workflow-GRAPH/DAG · a Cellenics-style STEP-PANEL ·
a hybrid), each with explicit tradeoffs against the research + the JTBD, and a
**clear RECOMMENDATION**.

## 3. Deliverable + flow
- Write the candidates + recommendation to **`.lifecycle/analysis-workflow/DESIGN_CANDIDATES.md`**
  (the research findings, the N candidates with tradeoffs, the recommendation) as the
  headline Phase-1 artifact.
- **PAUSE and surface them** (note in `LIVE5_STATUS.md` + `LIVE5_QUESTIONS.md`) for the
  USER to choose a candidate BEFORE you implement. Do not build until the user picks.
- On the user's pick, continue the /feature-lifecycle to implement the chosen design
  (Phases 1→9): the workflow modules plug into the study via `STUDY_EXTENSIONS` /
  `STUDY_SLOTS`; analysis runs as `jobs` in the `sandbox`; results persist per
  `DATA_STORAGE_REDESIGN`; viz via deck.gl.

## 4. Process
Iteration /feature-lifecycle, txr gate. sqlx compile-time macros. New perms → A9+A10.
UI → e2e + gate:ui. Clean commits. `SDK_GAPS.md` APPEND-ONLY. **Do NOT push to main** —
report READY; the orchestrator merges. Report in `.lifecycle/analysis-workflow/LIVE5_STATUS.md`
/ `LIVE5_QUESTIONS.md` / `LIVE5_PHASELOG.md`. This is a big one — take the research
seriously; the design candidates are the point of this round.
