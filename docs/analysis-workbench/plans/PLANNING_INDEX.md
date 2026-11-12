# Multi-Agent Convergence Planning — index + method

Goal: a rigorous, convergence-based build plan for the **whole** platform architecture (per the design corpus:
`DESIGN_CANDIDATES` · `INTERFACE_DESIGN` · `WORKBENCH_IA` · `PLATFORM_ARCHITECTURE` · `DATA_MODEL` · `BUILD_PLAN`).
Scope: **desktop + single-box server** (build local impls behind open seams; defer remote/HPC/MinIO — see
`BUILD_PLAN.md#deployment-scope`).

## Method
1. **Decompose** the architecture into PARTS (below). One plan per part.
2. **Round N:** an independent, **blind** agent writes a build plan for each part → `plans/<part>/rN.md`.
3. **Compare** round N vs N-1 per part (diff): does round N introduce anything **substantively new** (an item,
   file, dependency, decision, risk not in N-1)?
4. **Converge:** repeat rounds for a part until a round introduces **nothing new** → mark CONVERGED, freeze.
5. **Consolidate** each converged part's rounds → `plans/<part>/FINAL.md` (the union, deduped, ordered).
6. **Audit** the FINAL plans (blind audit agents): completeness vs the design docs, cross-part consistency,
   dependency correctness, scope (desktop/1-box), reuse of existing branches.

Plans must be CONCRETE: `- **ITEM-N**: <desc>` items; **Files/modules** to create/modify; **Reuse** (what
existing branch/module to build on); **Dependencies** (which other parts/items block it); **Sequencing**;
**Decisions**; **Risks**. Ground in the CODE, not just the design docs.

## Codebase grounding (worktrees to read)
- current design + analysis-workflow: `/data/pbya/txresbench/tmp/analysis-workflow-wt`
- live3 visualization: `/data/pbya/txresbench/tmp/visualization-wt` (`feat/visualization`)
- live8 study + provenance: `/data/pbya/txresbench/tmp/study-admin-wt` (`feat/provenance`), `study-management-wt`
- main / current modules: `/data/pbya/txresbench/tmp/txresbench`
- legacy reference: `/data/pbya/txresbench/tmp/txresbench-ref/sc-website`

## Parts + status
| Part | Scope | R1 | R2 | R3 | Status |
|---|---|---|---|---|---|
| **P1 data-foundation** | working store + `analysis_results` catalog + data API + local-FS object store + authed byte-range serving | ✅ 12 | ✅ 13 | ✅ 14 | 🧊 FINAL 16 — saturation REACHED |
| **P2 datatype-system** | open datatype registry + subtyping lattice + artifact model + storage layouts (dense/sparse/columnar) + viewers-per-datatype dispatch | ✅ 13 | ✅ 16 | ✅ 14 | 🧊 FINAL 26 — saturation REACHED |
| **P3 compute-scheduling** | JobRunner→bwrap + ComputeBackend seam + scientific rootfs + scheduling classes (interactive/batch, single pool) + inputs.json/outputs-manifest contract | ✅ 18 | ✅ 17 | ✅ 22 | 🧊 FINAL 31 — saturation REACHED |
| **P4 provenance** | provenance graph capture (run nodes, content-addressed code blobs, inputs.json, output edges) + selection-as-recipe + reproduce/export; integrate live8 `feat/provenance` | ✅ 23 | ✅ 16 | ✅ 25 | 🧊 FINAL 31 — saturation REACHED |
| **P5 contribution-api** | `@txresbench/workbench-api` (registries) + manifest + declarative provisioners (collections/settings/jobs/result-kinds) + extension discovery/loader | ✅ 19 | ✅ 16 | ✅ 23 | 🧊 FINAL 33 — saturation REACHED |
| **P6 workbench-shell** | docks (L/R/bottom/center) + collapse-to-stripe + semantic slots + host-rendered panels (form-from-schema, result-from-kind) + composition | ✅ 17 | ✅ 12 | — | 🧊 FINAL 17 — CONVERGED at r2 |
| **P7 visualization** | adopt live3 `feat/visualization`; switch→view-kind-registry refactor; viewers-per-datatype; coordination/linked-views; overlays | ✅ 18 | ✅ 15 | — | 🧊 FINAL 22 — CONVERGED at r2 |
| **P8 interaction-dsl** | shared selection/brush/pick primitives + cell-set predicate DSL + host evaluator + selection-as-recipe wiring | ✅ 19 | ✅ 10 | ✅ 12 | 🧊 FINAL 25 — saturation REACHED |
| **P9 ai-mcp** | contribution-registry→MCP tools/resources generator + LLM metadata + safety hints + per-study MCP server + approval/permission gating + chat integration | ✅ 15 | ✅ 17 | — | 🧊 FINAL 24 — CONVERGED at r2 |
| **P10 study-substrate** | tenancy/access(owner/editor/viewer)/sharing/transfer/lifecycle-cascade/sync as platform scoping; integrate live8 `feat/study-management` | ✅ 12 | ✅ 12 | ✅ 11 | 🧊 FINAL 23 — saturation REACHED |
| **P11 three-modules** | data-io (upload+process+save) · embedding · clustering as no-Rust extensions (the vertical slice) | ✅ 25 | ✅ 27 | — | 🧊 FINAL 34 — CONVERGED at r2 |

**All 11 parts CONVERGED. FINAL plans written (282 items total). Blind cross-part audit DONE (4 angles, `AUDIT/`).**

## Post-audit reconciliation (A1–A7) — APPLIED
- **A1** canonical `OutputsManifest { outputs: [{id,datatype,path,layout,role}] }` — owner **P3**; consumed by P1/P2/P4.
- **A2** new part **P0 ai-host-substrate** (16 items) — ports txresbench chat+mcp-host+approval+ai-providers; prereq for P9.
- **A3** SchemaForm (form-from-schema renderer) → owned by **P6**.
- **A4** registry→MCP generator → owned by **P9**.
- **A5** one sync name `SyncEntity::Artifact` (P10's `::AnalysisResult` collision fixed).
- **A6** conformance-battery types → **P5** (`@txresbench/workbench-api`); P7 imports.
- **A7** P1/P4 re-grounded vs merged main (txresbench-file dataset upload already exists — don't rebuild).

**Next: sequential implementation, one lifecycle at a time — see `IMPLEMENTATION_ORDER.md` (14 features, dependency-ordered). Feature #1 = `feat/study-scope` (P10).**

## Cross-part ownership disputes surfaced by the blind rounds (RESOLVE at consolidation/audit — not by another blind round)
- **artifacts/catalog table** — P1 (data-foundation) vs P2 (datatype-system) both claim to own the `artifacts`/`analysis_results` table. Decide one owner; the other consumes.
- **provenance graph** — P1's "catalog derivation edges ARE the provenance graph" vs P4's dedicated `provenance_*` tables. Decide whether provenance is a projection of the catalog or its own tables.
- **datatype registry + `@txresbench/*` namespace** — P2 vs P5 both place the datatype registry; decide it lives in P2 (datatype-system) and is *consumed* by P5's `@txresbench/workbench-api`, or vice-versa.
- **blob GC / lifecycle cascade** — P1 (object-store blob-GC) vs P10 (study `on_study_deleted` cascade). Decide the deletion chokepoint.
- **selection Rust evaluator** — P8 r2 (server evaluator + parity gate) vs P8 r1 (client-only, defer server). Decide at r3.
- **scatter view-kind ownership** — P7 (viz) vs P11 (embedding module) both build the embedding scatter. Decide the boundary.

Legend: ⏳ pending · ✅ done · 🔁 diverged (needs another round) · 🧊 CONVERGED (frozen).
