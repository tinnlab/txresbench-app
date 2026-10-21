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


# Implementation order — sequential (one lifecycle at a time)

Decision (human): build the parts **one by one, not in parallel**; **reconcile the FINAL
plans first** (A1–A7). This doc is the ordered backlog. Each entry is ONE
`/feature-lifecycle` run in its own worktree off `origin/main` (or off the prior
foundation branch), gated 1→9 by `lifecycle-check.mjs`, artifacts committed on the branch.

## Why this order
Topological sort of the FINAL `## Dependencies` (matches the AUDIT `global-sequence.md`
waves, linearized because we build sequentially). Sequential single-owner build dissolves
the "foundation can't be built four times" problem: each foundation layer lands on the one
before it, no parallel co-owners.

## Step 0 — before any lifecycle
- **Reconcile A1–A7** into the FINAL docs — ✅ DONE (canonical `OutputsManifest` owned by P3;
  P0 substrate part created; SchemaForm→P6; MCP-generator→P9; `SyncEntity::Artifact` one name;
  conformance types→P5; re-ground P1/P4 vs merged main).

### ⚠️ BASE (corrected 2026-07-16): build off LOCAL `main` (`63520fb`), NOT `origin/main`
Local `main` (`63520fb`) is **ahead of** `origin/main` (`29b9b29`) — origin/main is an ancestor
of local main, which adds the study-substrate merges + ziee-file upload on top and is **not yet
pushed**. Local main ALREADY has study-management + study-admin + study-extensions merged (49
study files, `EffectivePermission`, `STUDY_EXTENSIONS`, migrations → `202607160007`). So the
study part of P10 ITEM-1 is DONE. **All feature worktrees must branch off local `main`
(`63520fb`), never `origin/main`.** (`origin/main` is stale — it's the pre-study SDK-adoption line.)

Two foundation branches remain UNMERGED into local main → **FEATURE #0 (orchestrator-owned):**

| Branch | Tip | Builds on | For |
|---|---|---|---|
| feat/provenance | 1708405 | study-extensions (on local main) → merges cleanly | P4 execution model |
| feat/visualization | c0bce53 | main (independent) | P7 canvas |

Land `feat/provenance` then `feat/visualization` onto local main, green at each step. Per the
standing rule (**do NOT self-merge; the orchestrator merges; report READY**), P4/P7/P11 lifecycles
wait on this, but **P10, P1, P2, P3 can start now** off local main (they don't need provenance/viz).
I can prepare merge-readiness (conflict surface via merge-base diffs) but must not push.

- **Confirm base:** feature worktrees do `git worktree add -b <branch> <path> 63520fb` (the local
  main commit), NOT `origin/main`. Local main isn't pushed, so `origin/main` refs are behind.

## The sequence (each = one full 9-phase lifecycle)

| # | Feature branch | Part(s) | Key precondition | Notes |
|---|---|---|---|---|
| 1 | `feat/study-scope` | P10 (scope+consolidation) | live8 on main | StudyScope guard, two-level authz, viewer read-only, consolidation baseline. Its **data-layer cascade items** (catalog/jobs/provenance/collections `on_study_deleted`, blob-GC collect) are `[DESCOPED]` here and **ride P1's feature** (they need P1's store) — recorded as an approved descope. |
| 2 | `feat/data-foundation` | P1 (+ P10 cascade tail) | #1 | Working store + `artifacts` catalog + typed-binary data API + local-FS content-addressed store + authed byte-range + the P10 cascade/blob-GC refcount sweep. **The critical path.** Builds on main's already-merged ziee-file upload (A7) — do NOT rebuild upload. |
| 3 | `feat/datatype-system` | P2 | #2 | Open datatype registry (P2 core) + subtyping lattice + layout-keyed storage + viewer-per-datatype dispatch + sniff/convert. `artifacts.datatype` = TEXT validated against the registry. |
| 4 | `feat/compute-scheduling` | P3 | #2 | JobRunner→sandbox::run_analysis + ComputeBackend seam + scientific rootfs + scheduling classes + **P3 owns the canonical `OutputsManifest`** (A1) + hard cgroup caps + soft admission. |
| 5 | `feat/provenance` | P4 | #2, #4 | Reconcile live8 `feat/provenance` onto merged substrate. Graph = P1 catalog edges; P4 owns capture-logic + code-blob store + selection-recipe + reproduce/RO-Crate/DOI. |
| 6 | `feat/workbench-api` | P5 | #2, #3 | Extract `@cyto/workbench-api` registries + APIs + manifest + declarative provisioners + loader. Owns the conformance types (A6). Consumes P2's datatype registry. Dogfood built-ins on it. |
| 7 | `feat/workbench-shell` | P6 | #6 | Docks + collapse-to-stripe + semantic slots + host-rendered panels. **P6 owns SchemaForm** (A3, form-from-schema renderer). |
| 8 | `feat/visualization` | P7 | #6, #7, (live3 merged) | Adopt live3 canvas; `switch(cell.kind)`→`registerViewKind` registry (== P5 plotTypes); viewer-per-datatype; publish conformance battery; overlays. |
| 9 | `feat/interaction-dsl` | P8 | #2, #6, #8 | Shared selection/brush/pick primitives + cell-set predicate DSL (P8 owns schema) + BOTH evaluators (TS+Rust, golden parity) + selection-as-recipe. |
| 10 | `feat/ai-host-substrate` | P0 | (independent) | Port ziee chat + mcp-host + tool-approval + ai-providers into CytoAnalyst. Prereq for #11; independent of the data path, so could move earlier — placed here, right before the AI surface. |
| 11 | `feat/ai-mcp` | P9 | #6, #10 | **P9 owns the registry→MCP tools/resources generator** (A4). One contribution declaration → UI + MCP tool + REST. Per-study MCP server + approval gating. |
| 12 | `feat/module-data-io` | P11-a | #2..#8 | data-io extension: upload → sandboxed QC/normalize → save; QC-review panel; qc-defaults settings. |
| 13 | `feat/module-embedding` | P11-b | #12 | embedding extension: PCA/UMAP → embedding; fieldProvider; the built-in scatter view-kind (resolve the P7↔P11 scatter-ownership boundary here). |
| 14 | `feat/module-clustering` | P11-c | #13 | clustering extension: leiden/louvain → clustering; fieldProvider; selectionAction:subcluster; the artifact-ref-picker case. **The vertical slice completes — end-to-end product.** |

## Per-lifecycle mechanics (every entry above)
1. `git worktree add -b <branch> /data/pbya/ziee/tmp/<slug>-wt 63520fb` (LOCAL main, not origin/main; or off the prior foundation branch); `bash .claude/lifecycle/preflight.sh`.
2. **Phase 1 PLAN.md** — seed from the part's `FINAL.md`: its `## Items` are already `ITEM-N`; `## Reuse`+`## Files`→"Files to touch"+"Patterns to follow"; answer the UI-surface checklist for every new page/panel.
3. **Phase 2 PLAN_AUDIT.md** — re-audit against *real merged main* (the convergence audit was against the plan corpus; this re-checks code, migration collisions, openapi regen).
4. **Phase 3 TESTS.md** — the big net-new work: enumerate TEST-N per item (unit/integration/e2e); UI parts need ≥1 e2e + a `[negative-perm]` spec if they add a permission.
5. **Phase 4 DECISIONS.md** — mostly pre-resolved in the FINAL's `## Decisions`; convert to `DEC-N` + `Resolution:`/`Basis:` grammar; every operational tunable → configurable-settings DEC.
6. **Phases 5–9** — implement+drift loop, blind multi-angle audit with full `git diff main...HEAD` hunk coverage, fix→converge, then integration+e2e, then human review.

## The cross-lifecycle invariant (what keeps sequential builds coherent)
A **shared seam is defined once by its owner and only consumed downstream**:
`OutputsManifest`→P3(#4) · `artifacts` table + `SyncEntity::Artifact`→P1(#2) · datatype
registry→P2(#3) · `@cyto/workbench-api` + conformance types→P5(#6) · SchemaForm→P6(#7) ·
`ViewKindDescriptor`/registry→P7(#8) · `CellSet`+predicate DSL→P8(#9) · MCP generator→P9(#11)
· `StudyScope`+`GcManifest`→P10/P1(#1/#2). A downstream feature imports the owner's type;
it never redefines it. Because we build in dependency order, the owner always lands first.

## Known tradeoff of strict part-order (accepted)
The end-to-end demonstrable product only appears at #12–14 (the modules). Earlier features are
verified by their own tier tests + fixtures, not by a running workflow. (The alternative —
BUILD_PLAN's "thin vertical slice first, then extract the framework" — was considered and not
chosen; we build the framework before the modules that generalize from it.)
