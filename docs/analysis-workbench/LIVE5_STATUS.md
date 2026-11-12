# LIVE5 STATUS — Study Analysis Workflow (design-candidates round)

**Round type:** ITERATION /feature-lifecycle — **DESIGN CANDIDATES FIRST** (research + design, no code).
**Branch:** `feat/analysis-workflow` @ worktree `/data/pbya/txresbench/tmp/analysis-workflow-wt` (off `origin/main`, sdk `95acb82`).
**Current phase:** Pre-Phase-1 **design + research**. Deliverable = `DESIGN_CANDIDATES.md` → then **PAUSE** for the user to pick a candidate → then Phase 1→9 implement.

---

## ✅ PICK MADE (user) → 🟢 NOW: INTERFACE DESIGN ROUND

**User's answers:**
- **Q1 = Candidate D** ("Guided Pipeline + Explorer", progressive-disclosure hybrid).
- **Scope reframe (important):** *"we are not designing anything related to data or jobs this round, only
  interface."* → **THIS ROUND = INTERFACE / UX ONLY.** No data model, no job orchestration, no backend —
  those are future rounds. Mock/stub data.
- **The crux (user):** *"there will be tens of analyses in the future to plug in, so design it so it is UX
  friendly for a biologist but has all the advanced stuff if they need it."* → the deliverable is an
  **extensible analysis-interface FRAMEWORK**: a UI plugin/registry where tens of analyses (QC, embedding,
  clustering, DE, trajectory, enrichment, annotation, integration, …) each declare a biologist-simple
  surface + an advanced surface, rendered by a progressive-disclosure shell + explorer.

**Delivered (interface design):**
- `INTERFACE_DESIGN.md` — the **extensible analysis-plugin framework**: the UI descriptor contract
  (`AnalysisPlugin` = category + requires/produces gating + SimpleForm/AdvancedForm/ResultView + recipe
  opt-in), a `analysisRegistry` (auto-discovered, zero-shell-edit to add the 30th analysis), the
  three-level progressive disclosure (nav / per-analysis / result), the shell anatomy (run-timeline +
  workspace + catalog), QC review, mock Explorer, and how it plugs into `STUDY_SLOTS`.
- **Interactive on-system mockup** (`interface-mockup.html` + published Artifact) — shows V1/V2/V3 shell
  directions, the Simple→Advanced disclosure, the analysis catalog (categorized + prerequisite-gated), the
  per-sample QC review with before/after + advisories, and a Canvas WebGL-style Explorer (color-by
  cluster/sample/gene). Both themes.

## ✅ ROUND-2 pick: **V2 Explorer-centric** + build real components → 🟢 BUILDING (feature-lifecycle)

**Lifecycle progress (interface build, mock data, no backend):**
- Phase 1 PLAN.md + BASE.md ✓ · Phase 2 PLAN_AUDIT.md ✓ · Phase 3 TESTS.md ✓ (13 e2e) · Phase 4 DECISIONS.md ✓ (17 DECs).
- **Base-ref corrected** (stale local origin/main `29b9b29` → real base `587ca91`) so the diff is accurate.
- **Phase 5 (implementation) IN PROGRESS** — a fork builds all 12 ITEMs (analysis module: registry + 8
  plugins + mock engine/store + explorer canvas + dock + context-panel/disclosure + catalog + result
  overlays + samples/QC + study-extension reg + export + gallery + e2e specs), tsc-green, on-system @txresbench/kit.
## 🟢 8/9 — feature-lifecycle phases 1–8 COMPLETE + gated; Phase 9 PENDING (awaiting user review)

**Built + audited + gated.** The V2 explorer-centric analysis interface is implemented on-system (`@txresbench/kit`),
blind-audited (0 unresolved), and fully gated: `tsc` ✓ · `gate:ui` (runtime-health 15/15 surfaces clean, 0
gating HIGH, WCAG-AA contrast ✓) ✓ · **14/14 e2e specs PASS** (real backend + fresh DB). Clean tree; **not
pushed**. Phase 9 (HUMAN_FEEDBACK) is deliberately PENDING until the user reviews the running interface — then
the orchestrator merges (strip `.lifecycle` + merge-gate).

**What shipped (interface, mock data):** `modules/analysis/` — the extensible `AnalysisPlugin` registry + 8
seed plugins (QC→normalize→PCA→Harmony→Leiden→UMAP→markers→annotation) with per-analysis Simple/Advanced
progressive disclosure; the explorer-centric shell (persistent Canvas UMAP + analyses dock + collapsible
context panel + prerequisite-gated catalog + result overlays + marker table + count-splitting guardrail);
Samples/QC review (adaptive thresholds + before/after + advisories + stubbed upload); export menu (methods-text
preview); study-extension registration (Samples + Workspace sections); full gallery coverage. Backend/data/jobs
deferred to a future round behind the descriptor `run()`/`ResultView` seam.

**Notable finds fixed:** a11y labels (gate-critical), legend-count rendering, dock prereq-gating, gene
validation, catalog empty-state, kit reuse (Table/Statistic/Upload), mobile chrome, responsive, copy honesty,
+ test-reality strengthening. **SDK gap FE-11** logged (txr lacks the `@txresbench/gallery` visual-layer config;
`--skip-visual` is the supported mode).

---

- Phase 5 ✓ (DRIFT-1, 0 unresolved; 1 real token fix). Phase 6 ✓ — **4 blind angle-cluster audits** over the
  full 42-file diff: **0 Rules-of-Hooks violations, 0 scope drift, patterns/security clean, all lists bounded**.
  Confirmed defects (LEDGER.jsonl): a11y label gaps (gate-critical), legend-counts=0 (breaks snapshot,
  double-confirmed), dock prereq-gating bypass, gene-not-found fade, catalog empty-state, kit-reuse
  (Table/Statistic/Upload), mobile duplicated-header, responsive occlusion, copy, + test-reality gaps.
- **Phase 7 (fix loop) IN PROGRESS** — a fork applies every confirmed finding + strengthens the specs
  (adds a non-instant progress spec TEST-14; Leiden disclosure; result KPIs; honest TEST-3/4/13 wording),
  tsc-green. Then I re-audit blind → 0 new confirmed → FIX_ROUND-1.md.
- Remaining after: Phase 8 (gate:ui + e2e + tsc) → Phase 9 human feedback. Then READY (orchestrator merges;
  NOT pushed).

---

## (historical) State: ⏸️ PAUSED — DESIGN CANDIDATES DELIVERED, awaiting the user's pick

**Deliverables written:**
- `DESIGN_CANDIDATES.md` — full research synthesis (code grounding + 3 web-research streams) + **4 candidates**
  (A Guided Pipeline · B Analysis Session · C Workflow DAG · **D ⭐ Guided Pipeline + Explorer**) with tradeoffs,
  a comparison matrix, a **recommendation (D, MVP-first)**, phasing, and the cross-cutting decisions.
- `LIVE5_QUESTIONS.md` — the pick (Q1 archetype, Q2 compute-language, Q3 scope) + my recommendation + the
  defaults I'll use on "go with your recommendation."

**⏸️ I am NOT implementing until the user answers Q1.** On the pick I write Phase-1 `PLAN.md` and run the
/feature-lifecycle Phases 1→9.

**Headline finding:** the market has an **unmet middle** — no tool combines Cellenics' guided *per-sample* QC
+ cellxgene's WebGL-scale exploration + Azimuth's reproducible export. Candidate **D** targets exactly that
gap and is phaseable (phase 1 == Candidate A), so it ships value fast and de-risks. Recommend **D / Python-scanpy /
Phase-1-this-round**.

### Research done (all 4 streams complete)
- Read the brief; read `docs/DATA_STORAGE_REDESIGN.md` in full (the working-store data path — critical grounding).
- First-hand digest of the load-bearing seams:
  - **Study extension registry** (backend `study/core/extension/registry.rs` = linkme slice + `StudyExtension` trait w/ `on_study_deleted`/`on_study_duplicated`/`collect_summary`/`register_routes`; frontend `STUDY_SLOTS = {study_nav, detail_panels, card_tags}`). Reference consumer = the **dataset** module.
  - **jobs** module: FCFS scheduler + concurrency cap + `JobRunner::spawn(job)->SpawnedJob` trait (currently a stub; sandbox `run_analysis` drops in behind it). Per-job SSE (logs + cpu/mem), cancel registry. `Job{job_type:String, params:JSONB, status}`.
  - **sandbox** module: `run_analysis(pool, AnalysisRequest{command,timeout}, extra_mounts)` → bwrap R/Python, per-job 0700 workspace, lazy rootfs mount, `ExtraMount` for input/output plumbing. Linux-only (503 else).
  - **dataset** module: STUB (`Dataset{n_cells,n_genes,status: created→uploaded→analyzed}`; upload not yet wired — waits on txresbench-file/txresbench-sandbox maturity). Registers as a study extension.

### In flight (4 parallel research agents)
1. Deep digest of TxResBench code (study/dataset/sandbox/rootfs/jobs + SDK).
2. Web research — INTERACTIVE SC platforms (Cellenics/Biomage, cellxgene, Galaxy, Loupe, BBrowser, Partek, Azimuth).
3. Web research — PROGRAMMATIC pipelines (Scanpy, Seurat, OSCA, scverse, nf-core, doublets, integration).
4. Web research — user JTBD + pain points (personas, QC agony, iteration, annotation, reproducibility, sharing).

### Next
- Synthesize → write `DESIGN_CANDIDATES.md` (research + N candidates + recommendation).
- Surface the pick decision in `LIVE5_QUESTIONS.md`. **PAUSE. Do not implement until the user picks.**

**Do NOT push to main.** Orchestrator merges.
