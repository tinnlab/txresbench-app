# LIVE5 PHASELOG — Study Analysis Workflow

## Pre-Phase-1 — Design candidates + deep research (this round)
- **Goal:** Produce MULTIPLE coherent design candidates for the study analysis workflow
  (upload→QC→save→analysis→viz), grounded in (1) current txr code, (2) current-tools
  research, (3) user-JTBD research. PAUSE for the user to pick before implementing.
- **Grounding read:** `docs/DATA_STORAGE_REDESIGN.md` (working-store artifacts + typed-binary
  streaming), study-extension registry (both sides), jobs (FCFS + JobRunner seam), sandbox
  (`run_analysis` + `ExtraMount`), dataset (stub).
- **Research:** 4 parallel agents (code digest + 3 web-research streams).
- **Deliverable:** `DESIGN_CANDIDATES.md` + `LIVE5_QUESTIONS.md` (the pick).
- **Gate note:** the Phase-1 `lifecycle-check --phase 1` (PLAN.md) is deliberately NOT satisfied
  this round — the plan is authored AFTER the user picks a candidate (per the brief). This round
  is a design gate, not a code gate.

- **Outcome (delivered):** 4 parallel research agents completed (code digest + interactive platforms +
  programmatic pipelines + JTBD). Synthesized into `DESIGN_CANDIDATES.md`: 4 candidates (A/B/C/D) with a
  recommendation of **D — "Guided Pipeline + Explorer"** (progressive-disclosure hybrid targeting the
  market's unmet middle), built **MVP-first** (phase 1 == Candidate A). Surfaced the pick in
  `LIVE5_QUESTIONS.md` (Q1 archetype / Q2 compute-lang / Q3 scope). **PAUSED for the user.**
- **Not done (by design):** no `PLAN.md`, no code — the plan is authored after the user picks.

_(Phases 1→9 begin once the user picks a candidate.)_

## Phases 1–3 (interface build, V2 chosen)
- Preflight GREEN. PLAN.md + BASE.md (Phase 1 ✓), PLAN_AUDIT.md (Phase 2 ✓), TESTS.md (Phase 3 ✓).
- **Base-ref fix:** the worktree's local `origin/main` was stale (`29b9b29`, pre study/jobs/sandbox); the
  real base is `587ca91` (per the brief). Corrected via `git update-ref refs/remotes/origin/main 587ca91`
  so `git diff main...HEAD` = only this branch's work (was mis-attributing jobs/sandbox permissions.rs to
  the diff → false A10). All later phases (diff coverage) depend on this.
- 12 ITEMs (registry + 8 seed plugins + mock engine/store + explorer canvas + dock + context-panel +
  catalog + result overlays + samples/QC + study-extension reg + export + gallery). 13 e2e TESTs +
  gate:ui/tsc canaries. FE convention = e2e-only (no vitest in txr).
