# Global Build Sequence — Blind Buildability + Sequencing Audit

Derived from the 11 `FINAL.md` `## Dependencies` + `## Sequencing` sections and `BUILD_PLAN.md`.
Confirms the BUILD_PLAN critical-path claim (Phase 0 = working store + catalog + JobRunner→sandbox
+ provenance capture) and translates it into a globally-ordered wave plan.

## Critical path

**Hard (non-stubbable) dependency root:** `P10 study-substrate → P1 data-foundation`.

- **P10** is the tenancy/access/lifecycle substrate. Its core is already built/merged (live8, on the
  branch); its ONE net-new coupling (ITEM-9 blob-GC refcount seam) lands *with* P1. So P10 is the
  root but is not itself blocked — nothing to scope until P1 exists, yet its authz/`STUDY_EXTENSIONS`
  contract must be present before P1's cascade/scoping wires. Treat P10-core as Wave 0 (done) and its
  GC tail as riding P1.
- **P1** hard-depends on **only** P10 and is depended on by **every** other part — it is THE critical
  path (the `DEC-FOUNDATION` kernel: kind-typed working store + `analysis_results` catalog + data API
  + content-addressed object store). Confirms BUILD_PLAN §"THE CRITICAL PATH" verbatim.

**Longest hard chain to the product (P11 vertical slice):**
`P10 → P1 → P3 → P5 → P6 → P7 → P11` (7 nodes).

**Longest chain to the deepest consumer (P9 AI/MCP convergence gate):**
`P10 → P1 → P2 → P5 → P8 → P4 → P9` (7 nodes) — plus P9's *external* host-substrate prerequisite
(see Substrate gaps), which is off the P1–P11 graph entirely.

P1 blocks the most: P2, P3, P4, P5, P6, P7, P8, P9, P11 all hard- or key-depend on it (9 of 10).
P5 is the second-largest hub (blocks P6, P7, P8, P9, P11).

## Phased waves

Each wave depends only on earlier waves. "‖" = buildable in parallel within the wave.

- **Wave 0 — substrate root:** **P10** (study-substrate). Prereq: live8's three study branches
  consolidated on main (ITEM-1). Mostly built; publishes the `study_id` FK/authz/`STUDY_EXTENSIONS`
  contract every later part scopes against. GC seam defers to Wave 1.
- **Wave 1 — the kernel (sole, blocks all):** **P1** (data-foundation). Working store + catalog +
  data API + local-FS content-addressed object store + FE thin binary client. Nothing real lands
  before it. Vertical-slice checkpoint: ingest one fixture `embedding` → catalog → stream as binary.
- **Wave 2 — on P1 (parallel):** **P2** (datatype-system) ‖ **P3** (compute-scheduling). P2↔P3 are
  only soft-coupled (sandbox converters / `kind` vocab); build concurrently. Both hard-depend on P1;
  both front-load their P1-independent halves (P2 pure lattice items 1–8; P3 metrics + spine + rootfs)
  during Wave 1 and wire the P1-gated tails at merge.
- **Wave 3 — the API + capture (parallel):** **P5** (contribution-api) ‖ **P4** (provenance capture
  backbone). P5 needs P1+P2+P3 (stubs P8's AST). P4's capture backbone needs P1+P3 only (its recipe/
  export items defer to Wave 4/5). P5's pure type surface (items 1–8) can begin in Wave 1–2 against
  interface stubs.
- **Wave 4 — the shell/canvas/DSL cluster (parallel, seam-coupled):** **P6** (workbench-shell) ‖
  **P7** (visualization) ‖ **P8** (interaction-dsl). All three key-depend on P5 and on each other
  (P6 hosts P7's canvas + P8's widgets; P7's runtime backing needs P8; P8's runtime backing needs P7).
  The cycles are broken by placeholder/fixture seams (ExplorerCanvas fallback, FixtureSource, the
  pure-contract DSL layer) — see Bootstrap hazards. P7's bounded switch→registry refactor (steps 2–4)
  can even start in Wave 1–2 on merged live3.
- **Wave 5 — consumers + convergence (parallel):** **P11** (three-modules: data-io → embedding →
  clustering) ‖ **P9** (ai-mcp) ‖ P4 export/verify tail ‖ P8 server/AI seam tail. P11 needs P1+P2+P3+
  P5+P6+P7 all real (explicitly refuses to stub the kernel). P9 additionally needs the external host
  substrate (below) and is the end-to-end acceptance gate (ITEM-21).

- **Parallel EXTERNAL track (start ASAP, must finish before Wave 5):** host **chat + MCP host +
  approval flow** substrate. Independent of P1–P11, so schedule it alongside Wave 1 — it is the pacing
  item for P9, not a Wave-5 discovery.

## Bootstrap hazards

**Good — parts that build against a seam/contract/fixture before their real upstream exists:**
- **P1** — write path is inert, testable via a synthetic `/outputs` produces-manifest until P3 exists.
- **P2** — pure lattice items 1–8 parallel to P1; kerchunk host-lite fallback (ITEM-17) decouples real
  anndata ingest from P3.
- **P3** — seams ITEM-27/28 no-op so the queue/spine test independently; runs a fixed command with no
  inputs/outputs before the P1 contract lands.
- **P4** — standalone slice (code_blobs, repro sidecar, rootfs digest, settings) builds + unit-tests
  against fixtures before P1/P3.
- **P5** — pure items (1–8, 10-AST, 12–16, 20, 27, 30) land first against interface stubs + a local
  `Kind`-union fallback.
- **P6** — builds against a typed stub `WorkbenchAPI` + an `analysisRegistry` adapter if P5 lags.
- **P7** — `FixtureSource` keeps it unblocked; the switch→`registerViewKind` refactor proceeds on
  merged live3 before P1/P2/P6.
- **P8** — the pure-contract layer (AST + JSON-schema + codegen) starts immediately, blind of P1; the
  client evaluator builds against fixtures + the parity corpus + a brute-force oracle.

**Chicken-and-egg pairs (resolved by design, watch at integration):**
- **P5 API ↔ P11/built-in analyses (dogfood).** P5's ITEM-32 dogfood + BUILD_PLAN Phase-1b ("rebuild
  built-ins on ONLY the public API") need real analyses to generalize from, but analyses are authored
  against P5. Resolution = BUILD_PLAN §Re-sequencing: *extract `@cyto/workbench-api` FROM 2–3 real
  modules*, don't design it top-down. So a thin real analysis must precede P5 hardening — sequence a
  vertical slice (P1 + one analysis) inside/adjacent to Wave 2–3, not after.
- **P5 ↔ P8.** P8 imports P5's AST; P5 needs P8's evaluator for `api.selection`. One-way declared
  (P8→P5 for types; P5 assembles the runtime) — safe if honored.
- **P6 ↔ P7.** P6 hosts P7's canvas / P7 mounts into P6's center slot. Placeholder-first (ExplorerCanvas
  fallback) breaks it.

**Genuine hard block with NO in-plan fallback:**
- **P9's host substrate** (chat loop + MCP host + approval) — ABSENT and owned by no P1–P11 part.
- **P11** deliberately has no kernel stub ("do NOT stub the kernel") — acceptable because P11 is a leaf
  consumer that simply waits for Wave 4; not a risk, just a hard gate.

## Substrate gaps

- **The P9 gap is real and confirmed.** P9's ITEM-1/2/3 (host MCP + chat + ai-providers + approval flow)
  are flagged HARD/BLOCKING and **absent from the CytoAnalyst app** — CytoAnalyst is app #2 on the ziee
  SDK and, unlike the parent ziee app, does not ship chat/MCP/approval. P9 explicitly surfaces this to
  the human (DEC-1) and assigns it to "platform bootstrap / live1," i.e. **outside** the P1–P11 plan.
- **Where it must be resolved:** it gates only P9 (Wave 5), but because it is external and independent
  of the kernel, it should be **bootstrapped in parallel from Wave 1** so it is not the thing that
  discovers itself at Wave 5. It is the pacing item for the AI/MCP differentiator.
- **Does any other part silently assume it?** No silent assumption found. Every other MCP touchpoint
  funnels *through* P9: P8 ITEM-19 (`setByPredicate` host surface + MCP), P11 SOFT-P9 (tools
  auto-generated from manifests), P4 ITEM-18 (provenance/sync via MCP), P10 ITEM-14 (per-study MCP role
  gate → handed off to P9). None build the host themselves; all are consumers scheduled at/after P9.
  So the gap is correctly isolated to the P9 wave — provided the external track is actually scheduled.

## Verdict

**BUILDABLE.** The graph is a clean DAG once the declared seam/stub bootstraps are honored: a single
hard root (P10→P1), two independent mid-waves (P2‖P3, then P5‖P4-capture), a seam-broken tri-cluster
(P6‖P7‖P8), and a consumer wave (P11‖P9). **5 hazards** — 4 are seam/contract-resolved cyclic couplings
(P5↔P11 dogfood, P5↔P8, P6↔P7, P11 no-stub leaf gate); **1 is a genuine external hard blocker** with no
in-plan owner: **P9's host chat+MCP+approval substrate**, which must be scheduled as a parallel bootstrap
from Wave 1 or it becomes the Wave-5 critical path.

VERDICT: BUILDABLE | 5 hazards (1 hard-external: P9 host substrate)
