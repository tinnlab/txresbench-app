> ## ⚠️ ARCHITECTURE CORRECTION (2026-07-16, orchestrator)
> **CytoAnalyst EXPOSES its functionality; it does NOT host any AI.** Cyto publishes its
> capabilities as an **MCP *server*** (JSON-RPC, permission-gated, per-study). **Ziee chat**
> (the separate app) is the external AI host that connects to that server and does all the
> reasoning/LLM/approval. Cyto builds NO chat loop, LLM, ai-providers, tool-approval UX, or
> chat panel.
> - **P0 `ai-host-substrate` is DROPPED** (it built ziee-chat’s half inside the wrong app).
> - **P9 `ai-mcp` is REFRAMED** as the MCP-server *exposure* surface (uses `ziee-control-mcp`
>   `catalog::init_from_openapi`); it **no longer depends on P0** and is buildable now.
> Ignore any "cyto host substrate / chat / approval panel / ai-providers" text below.


# HANDOFF — CytoAnalyst analysis-workbench platform

**Purpose.** This is the complete, self-contained handoff for the CytoAnalyst
analysis-workbench platform build. A fresh session/machine can read this file +
the docs it points at and continue with zero prior context. Written 2026-07-16.

CytoAnalyst = app #2 built on the ziee SDK: an extensible, AI-assisted
single-cell / bioinformatics analysis workbench (microkernel + versioned
contribution API; every capability — analyses, views, backends, datatypes — is a
self-registering extension; provenance graph; per-study MCP/AI surface).

---

## STATUS: planning COMPLETE + audited + reconciled. Implementation NOT started.

- **12 architecture parts** (P0–P11) each have a consolidated `plans/<part>/FINAL.md`.
- Produced by a **blind multi-agent convergence method** (see `plans/PLANNING_INDEX.md`):
  3 independent blind rounds per part (r1/r2/r3), round-over-round diffs
  (`DIFF_R1_R2.md`), consolidated to FINAL when saturated. All 11 original parts
  reached **saturation** (a further blind round added nothing new).
- **Blind cross-part audit** done (4 angles) → `plans/AUDIT/AUDIT_SUMMARY.md`:
  verdict COHERENT / COMPLETE / IN-SCOPE / BUILDABLE, with a ranked reconciliation
  backlog (A1–A7).
- **Reconciliation A1–A7 APPLIED** to the FINALs (canonical `OutputsManifest`
  owned by P3; new part **P0 ai-host-substrate** created; SchemaForm→P6;
  MCP-generator→P9; one `SyncEntity::Artifact`; conformance types→P5; P1/P4
  re-grounded vs merged main).
- **~298 build items total** across the 12 FINALs.

**Next action = start implementation, one lifecycle at a time**, per
`plans/IMPLEMENTATION_ORDER.md`. Nothing is coded yet.

---

## ⚠️ CRITICAL: the build base (read before touching git)

**Build off LOCAL `main` = commit `63520fb`, NOT `origin/main`.**

- Local `main` (`63520fb`) is **ahead of** `origin/main` (`29b9b29`) and is **not
  pushed**. `origin/main` is the older pre-study SDK-adoption line and does NOT
  have the study substrate — branching off it will (wrongly) look like the
  foundation is missing.
- Local `main` (`63520fb`) already has **study-management + study-admin +
  study-extensions merged** (49 study files, `EffectivePermission`,
  `STUDY_EXTENSIONS`, `delete_study_with_extensions`, migrations →
  `202607160007`) plus **ziee-file real dataset upload**. Verify with:
  `git -C <repo> ls-tree -r --name-only main | grep modules/study/ | head`.
- Repo: `ziee-ai/cytoanalyst`. Layout is `src-app/server` (Rust) + `src-app/ui`
  (React) on the ziee SDK (`sdk/`, `agent-kit/`). Migrations are **per-module**
  (`modules/<m>/migrations/*.sql`), not one central dir.

### Moving to a DIFFERENT machine (not just a new session on this box)
These branches are **local-only / not pushed** and MUST be pushed first (an
orchestrator action) or the other machine won't have them:
- local `main` (`63520fb`) — the true base
- `feat/provenance` (`1708405`), `feat/visualization` (`c0bce53`) — FEATURE #0 inputs
- `feat/analysis-workflow` — the planning branch (all these docs live there too)
- `feat/study-admin`, `feat/study-extensions` — already merged into local main, but
  unpushed as branches
(`feat/study-management` IS on origin.) A **same-box new session** needs no push —
all worktrees/branches are already on disk (see reference worktrees below).

---

## FEATURE #0 (prerequisite, ORCHESTRATOR-owned): finish landing the foundation

Two branches remain unmerged into local main:
| Branch | Tip | Note |
|---|---|---|
| `feat/provenance` | `1708405` | stacks on study-extensions (already on main) → should merge cleanly. P4's execution model. |
| `feat/visualization` | `c0bce53` | independent of study stack. P7's deck.gl canvas. |

Land `feat/provenance` then `feat/visualization` onto local main, green at each
step. **Standing rule: do NOT self-merge/self-push — the orchestrator merges;
report READY.** P10/P1/P2/P3 do NOT need these and can start immediately; P4/P7/P11
wait on them.

---

## The implementation sequence (one lifecycle at a time — human chose sequential, not parallel)

Full table in `plans/IMPLEMENTATION_ORDER.md`. Summary (each row = ONE
`/feature-lifecycle` run, worktree off local main `63520fb`, gated 1→9 by
`.claude/lifecycle/lifecycle-check.mjs`):

1. `feat/study-scope` (P10 scope+consolidation) — study substrate already on main; its data-layer cascade items ride P1.
2. `feat/data-foundation` (P1) — **the critical path**: working store + `artifacts` catalog + typed-binary data API + local-FS content-addressed store + blob-GC refcount. Builds on already-merged ziee-file upload.
3. `feat/datatype-system` (P2)
4. `feat/compute-scheduling` (P3) — **owns the canonical `OutputsManifest`**.
5. `feat/provenance` (P4) — needs FEATURE #0.
6. `feat/workbench-api` (P5) — extract `@cyto/workbench-api`; owns conformance types.
7. `feat/workbench-shell` (P6) — **owns SchemaForm**.
8. `feat/visualization` (P7) — adopt live3; `switch(cell.kind)`→`registerViewKind`; needs FEATURE #0.
9. `feat/interaction-dsl` (P8) — cell-set predicate DSL + BOTH evaluators (TS+Rust, golden parity).
10. `feat/ai-host-substrate` (P0) — port ziee chat+mcp+approval+ai-providers; prereq for P9; independent of data path.
11. `feat/ai-mcp` (P9) — **owns the registry→MCP generator**.
12–14. `feat/module-{data-io,embedding,clustering}` (P11) — the vertical slice; end-to-end product completes at #14.

**Cross-lifecycle invariant:** a shared seam is defined ONCE by its owner and only
consumed downstream (`OutputsManifest`→P3 · `artifacts`+`SyncEntity::Artifact`→P1 ·
datatype registry→P2 · `@cyto/workbench-api`+conformance→P5 · SchemaForm→P6 ·
view-kind registry→P7 · `CellSet`+DSL→P8 · MCP generator→P9 · `StudyScope`+`GcManifest`→P10/P1).
Building in dependency order means the owner always lands first.

---

## How to continue (concrete next step)

Per-lifecycle mechanics (from the feature-lifecycle skill, `.claude/skills/feature-lifecycle/`):
1. `git worktree add -b <branch> /data/pbya/ziee/tmp/<slug>-wt 63520fb` (LOCAL main).
2. `bash .claude/lifecycle/preflight.sh --repo <worktree>` (auto-seeds config, checks env).
3. **Phase 1** `.lifecycle/<feature>/PLAN.md` + `BASE.md` — SEED from the part's
   `plans/<part>/FINAL.md`: its `## Items` are already `ITEM-N`; `## Reuse`+`## Files`
   → "Files to touch"+"Patterns to follow". Answer the UI-surface checklist per new surface.
4. **Phase 2** PLAN_AUDIT.md — re-audit against REAL local main code (migration
   collisions, openapi regen, breakage). The convergence audit was vs the plan corpus,
   NOT the code — Phase 2 is the first code-level audit.
5. **Phase 3** TESTS.md — the big net-new work: enumerate `TEST-N` per item (unit/
   integration/e2e); UI parts need ≥1 e2e + a `[negative-perm]` spec if a permission is added.
6. **Phase 4** DECISIONS.md — mostly pre-resolved in the FINAL's `## Decisions`; convert
   to `DEC-N` + `Resolution:`/`Basis:`. Every operational tunable → configurable-settings DEC.
7. **Phases 5–9** — implement+drift loop, blind multi-angle audit w/ full
   `git diff main...HEAD` hunk coverage, fix→converge, integration+e2e, human review.
   `node .claude/lifecycle/lifecycle-check.mjs --phase N --repo <worktree>` must exit 0
   before phase N+1. **Point the merge-gate at LOCAL main** (origin/main is stale).

**Recommended first feature: #1 `feat/study-scope` (P10)** — study substrate is already
on main, so it's mostly the `StudyScope` guard + two-level authz + viewer read-only +
consolidation baseline. (An already-created scratch worktree may exist at
`/data/pbya/ziee/tmp/study-scope-wt` off `63520fb`; recreate if absent.)

---

## Document map (everything is under this dir)

- `plans/PLANNING_INDEX.md` — the convergence method + per-part status table + the
  reconciliation summary. **Start here.**
- `plans/IMPLEMENTATION_ORDER.md` — the 14-feature sequential build order + base note + FEATURE #0.
- `plans/<part>/FINAL.md` — the buildable plan per part (P0–P11): `## Items / Files / Reuse /
  Dependencies / Sequencing / Decisions / Risks / Effort / Saturation`. **These seed each lifecycle.**
- `plans/<part>/{r1,r2,r3}.md` + `DIFF_R1_R2.md` — the convergence audit trail (provenance of the FINAL).
- `plans/AUDIT/` — the 4 blind cross-part audits + `AUDIT_SUMMARY.md` (the A1–A7 backlog, now applied).
- Design corpus (the "what"): `PLATFORM_ARCHITECTURE.md` (core architecture), `DATA_MODEL.md`
  (open datatype system + storage), `WORKBENCH_IA.md` (layout), `BUILD_PLAN.md` (north-star phasing +
  deployment-scope table).
- The other root files (`PLAN.md`, `TESTS.md`, `LIVE5_*.md`, `interface-mockup.html`, etc.) are the
  SUPERSEDED interface-round (V2 mock) lifecycle artifacts — kept for history; the platform redesign
  above supersedes them (see `BUILD_PLAN.md` "what this supersedes").

## Reference worktrees on THIS box (for grounding; won't transfer to another machine)
- `/data/pbya/ziee/tmp/cytoanalyst` — main checkout (local main `63520fb`, has study substrate).
- `/data/pbya/ziee/tmp/visualization-wt` (`feat/visualization`) — live3 deck.gl canvas (P7 adopts).
- `/data/pbya/ziee/tmp/study-admin-wt` (`feat/provenance` `1708405`) — provenance execution model (P4).
- `/data/pbya/ziee/tmp/study-extensions-wt` (`feat/study-extensions`) — STUDY_EXTENSIONS reference.
- `/data/pbya/ziee/tmp/analysis-workflow-wt` (`feat/analysis-workflow`) — where these plans were authored.
- `/data/pbya/ziee/tmp/cytoanalyst-ref/sc-website` — legacy R/Seurat reference (real param vocabulary).

---

## Deployment scope (near-term)
**DESKTOP + SINGLE-BOX SERVER ONLY.** Build local implementations behind OPEN seams
(local bwrap sandbox, local-FS object store, single-pool scheduler); keep seams open for
remote/HPC/MinIO but do NOT build the distributed arm. See `BUILD_PLAN.md` deployment-scope table.

## Standing constraints (carry these forward)
- **Do NOT self-merge or self-push to main.** The orchestrator merges; report READY.
- Clean commit messages — **no Claude/Co-Authored-By trailers**.
- Every nontrivial feature MUST go through the 9-phase `/feature-lifecycle` (gated by
  `lifecycle-check.mjs` + the pre-push hook; run `scripts/install-agent-hooks.sh` once per clone).
- Scope tests to the touched modules; never `#[ignore]` to go green (only legit skip =
  platform-incompat via `cfg`).
- The convergence audit was against the PLAN corpus, not code — each part's Phase 2 is its
  first real code-level audit; expect discovery (esp. P1 `DATA_STORAGE_REDESIGN` is a proposal).

## Key gotchas learned this session
- **origin/main is stale** (behind local main). Always verify the base has `modules/study/`.
- Several planning agents grounded in worktrees whose branch differed from the label
  (e.g. `study-management-wt` was checked out on `feat/sdk-adopt-backend`) — re-verify a
  reuse claim against the actual branch before relying on it.
- The A1 `OutputsManifest` 4-way field divergence was the highest-value audit catch — one
  canonical struct owned by P3 (`{ outputs: [{id,datatype,path,layout,role}] }`); P1/P2/P4 import it.
- P9's AI surface is blocked on a host substrate (chat+mcp+approval) absent from CytoAnalyst →
  that's why P0 exists.
