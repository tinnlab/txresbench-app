# P8 — interaction-dsl — FINAL (consolidated union of r1 ∪ r2 ∪ r3)

Scope: DESKTOP + SINGLE-BOX SERVER. The connective tissue of §0.4.1 + §4.4 — the SHARED
selection/brush/pick primitive set (over the live3 Coordination store), a small, safe, bounded,
typed **cell-set predicate DSL** with **TWO agreeing evaluators** (client TS for instant preview +
server Rust authoritative for AI/MCP + headless reproduce), and **selection-as-recipe** (predicate +
pinned input content-hashes → provenance), never a materialized cell set. One representation shared by
the human lasso, the AI's `selection.setByPredicate`, the cell-set-selector widget, and provenance.

**Ownership note (baked in):** the DSL SCHEMA + BOTH evaluators are **OWNED by P8**. P5
(contribution-api) only *surfaces* them via its `api.*` façade + command registry; it does not define
the schema or evaluate.

Grounded in verified live3 code (`feat/visualization`, `/data/pbya/txresbench/tmp/visualization-wt/.../modules/visualization/`):
- `viz-core/data/selection.ts` — packed-`Uint32` `IndexMask` (`union`/`intersect`/`difference`/`count`/
  `has`/`toIndices`, `popcount32`) + pure hit-tests `selectInBox`/`selectInPolygon`/`bboxCandidates`/
  `polygonBoundingBox` (d3 `polygonContains` + `PointIndex` KD-tree). The cell-set + set-ops + lasso engine.
- `viz-core/selection/SelectionController.ts` — ordered `RectArea`/`PolygonArea` with `CombineMode`
  `add|subtract|intersect`; the area list IS a proto-recipe.
- `adapter/Coordination.store.ts` (`Stores.Coordination`, `defineStore`) — `pointSelection: Uint32Array`,
  `selectionOrigin`, `highlight`, `geneSelection`; `setSelection`/`setCellSelection`/`clearSelection`/
  `setHighlight`. The shared substrate `api.*` promotes.
- `viz-core/grid/gridSelection.ts` `unprojectInCell`; `pointIndex.ts` KD-tree; `heatmap-matrix/
  matrixSelection.ts` `columnRangeToPointIndices`; `spatial/roiSelect.ts`; `DeckScatterCanvas` GPU-pick
  `HoverInfo{index}` (hover only — no click-pick yet).
- legacy `NewDEForm.tsx` `getCellIds({sampleIds,clusters,metadata,annotations,selectedCellIds})` — the
  compound include/exclude (`isExcluded` intersect/andnot) builder + **live cell-count preview** + overlap
  detection the categorical encoder generalizes.

**Gaps P8 fills:** no `CellSet` type, no persistent brush object, no predicate/recipe concept, selection
confined to the viz package (not a workbench-api primitive). Provenance (`feat/provenance`) is
design-only (recipe = `{predicate}+{content-hash}`, gesture→captured-params table, run-node
`job_type="selection.*"` via an interaction chokepoint — a P8 deliverable consuming live8's
`ProvenanceCapture` seam). The working-store + typed data API is greenfield Phase-0 critical path.

---

## Items

- **ITEM-1**: Canonical `CellSet` contract in `@txresbench/workbench-api`. Promote live3 `IndexMask`/`Uint32Array`
  duality as the workbench-wide selection type (do **not** invent a third representation) over the dense
  study view-index axis (§5 `system_cell_id`); keep `union/intersect/difference/count/has`; add
  `toDurableIds()`/`fromDurableIds()` `(sample,local_index)` round-trip so a mask survives axis
  re-materialization + cross-analysis alignment (NA outside covered cells); zero-copy `toIndices()`
  `Uint32Array` view for deck.gl + `Coordination.pointSelection`. `CellSet = IndexMask (hot render path)
  + optional source recipe` (DEC-P8-B). Server mirror = packed-`u32` `roaring`/`bitvec` with the SAME word
  layout as `IndexMask`.
- **ITEM-2**: Cell-set predicate DSL — canonical AST + ONE JSON-schema source of truth. Bounded typed JSON
  expression. Leaf terms: `{gene, layer?}`, `{obs}`/`{col}` (a `metadata-column` artifact), `{clustering,
  categories[]}`/`{clustering,id}` (categorical codes), `{qc}`, `{embeddingDim}`, `{lit}`; reductions
  `{reduce: median|mean|quantile(q)|mad|std|min|max|count, of:<term>, q?}`; comparisons
  `gt|gte|lt|lte|eq|neq|between|in|notin|isna`; boolean/set `and|or|not|xor|union|intersect|difference|
  andnot`; geometric `{inPolygon:{coords:<embeddingRef>, polygon:[[x,y],…]}}` / `{inBox:{dims,bounds}}`;
  `idList` (freehand escape hatch). `dslVersion` stamped. JSON AST wire form (DEC-P8-A) — no string grammar
  — so it IS the `setByPredicate` MCP tool input schema, directly `serde`-deserializable in Rust, directly
  what the widget builds. Acceptance fixture = the §0.4.1 worked shape
  `{gt:[{gene:ABC,layer:lognorm},{reduce:median,of:{gene:ABC,layer:lognorm}}]}`.
- **ITEM-3**: DSL schema → TS type + Rust type CODEGEN with an `emit_ts.rs`-style byte-for-byte golden
  parity test (schema→both must match committed). Prevents TS/Rust type drift that would break the
  evaluator parity (ITEM-10). The single JSON-schema is the source; TS AST + Rust `serde` AST are generated.
- **ITEM-4**: Structural + semantic validator (one implementation, run BOTH client pre-apply and server
  pre-persist). Structural: `predicate.schema.json`. Semantic: reference resolution (gene in `var`? obs
  column exists? layer exists? `metadata-column` artifact present?) + **bounds** (AST depth ≤ D=32, node
  count ≤ N=256, reductions ≤ R=16, result-cardinality cap) → typed errors (`UnknownGene`/`UnknownColumn`/
  `TooComplex`/`TypeMismatch`). Reject unknown op / arity error / unbounded recursion.
- **ITEM-5**: Operator/feature vocabulary descriptor — machine-readable `{operators[], reductions[],
  leafKinds[]}` with arity + semantics + doc strings, exported for THREE consumers: the cell-set-selector
  widget builder (ITEM-22), the MCP DSL-vocabulary resource the AI reads (§0.4.2), and human docs.
  **Extensible**: a produced `metadata-column` (new `{col}`) or a contributed operator appends to it
  (how an extension enriches the AI's world model). P8 owns the projection functions; P9 exposes them.
- **ITEM-6**: Column resolver over the P1 data-API read surface. Binds DSL leaf refs: `data.geneColumn(gene,
  layer)` (sparse CSC slice `{row:Uint32Array, value:Float32Array}`, O(nnz)), `data.obs(col)`,
  `data.clustering(id)` (`{codes,categories}`), `data.embedding(id)`, and a `metadata-column` artifact read.
  Produces a per-cell **dense view** with **sparse-absent = 0** (layer-correct for lognorm/counts) + an
  **NA mask** (cells outside covered axis). Memoized per `(ref, layer, axisVersion)`.
- **ITEM-7**: Reduction kernels — O(n) `median` (quickselect, no full sort), `mean`, `quantile(q)`, `mad`,
  `std`, `min/max`, `count` over the resident column (optionally selection-restricted for "median within
  selection"). NA-aware (skip NA). Scalar cached per `(term, axisVersion, restrictMask?)`. Heavy computed
  features are NOT reductions (DEC-P8-C) — reductions stay cheap O(n) over one resident column.
- **ITEM-8**: Client (TS) evaluator `evalPredicate(ast, dataCtx): CellSet` in viz-core. Recursive eval over
  **resident** typed arrays (already fetched for coloring): term→column (ITEM-6); reduce→scalar (ITEM-7);
  comparison→per-cell `IndexMask`; boolean/set→`IndexMask` set-ops (reuse). Pure, bounded, deterministic;
  NaN/NA/uncovered cells NEVER selected. Powers the widget live-count preview + instant lasso resolution.
  Returns typed errors (ITEM-24), not opaque throws.
- **ITEM-9**: Server (Rust) host evaluator — new host module `modules/predicate/` (`ast.rs`, `eval.rs`,
  `reduce.rs`, `geometry.rs`). Reads kind-typed artifact columns (gene column / obs / clustering / embedding
  coords) via the Phase-0 working-store data API → packed-`u32` `BitMask` with the SAME word layout as
  `IndexMask`. Same reductions/comparisons/geometry/caps/errors as TS. **Authoritative** for
  `selection.setByPredicate` (AI/MCP), headless reproduce, and headless re-eval. Domain-neutral (generic
  per-cell columns; single-cell not privileged — DEC-P8-G). Typed error on missing gene/col/clustering
  (relayed to the AI).
- **ITEM-10**: Golden TS↔Rust parity harness (the load-bearing guarantee: human preview == AI selection ==
  reproduced cells). Shared corpus dir of `{predicate, fixtureColumns, expectedMaskWords[]}` JSON cases
  (≥20 predicates spanning every operator/reduction, empty/all, NA/NaN, categorical membership, and the
  ITEM-11 polygon boundary cases); a Rust test (`tests/predicate/parity_test.rs`) and a TS test
  (`evalPredicate.parity.test.ts`) load the SAME files and assert byte-identical bitmask words; any drift
  fails BOTH suites. Corpus generator + a `just`/npm target. Same discipline as `emit_ts.rs`
  `types_ts_parity`.
- **ITEM-11**: Geometry→predicate compilation + polygon-boundary determinism (mandatory because there are
  two evaluators). A lasso/box/column-brush/cluster-pick resolves on the client to a bitmask for immediate
  display (existing live3 path) AND compiles to a DSL node for the recipe: polygon→`inPolygon(embeddingRef,
  verts)`, box gate→`inBox`, brush→`between{col}`, cluster-pick→`{clustering,categories}`,
  freehand→`idList` (exactly the provenance §B1 gesture table). Bridges `SelectionController`'s area list →
  DSL nodes (`add|subtract|intersect` → `or|andnot|and`). **Determinism:** (a) compiler unprojects screen
  polygon → **embedding-space f32 vertices** (reuse `unprojectInCell`) stored in the recipe — never screen
  coords; reproduce runs over the pinned embedding artifact's exact stored coords; (b) port live3
  `d3-polygon.polygonContains` ray-crossing **verbatim** into Rust (same vertex iteration order, same
  half-open crossing rule, same arithmetic order); (c) identical **quantization to the artifact's stored
  precision** both sides before the crossing test (kills last-ULP cross-language divergence on
  on-edge/on-vertex/collinear); (d) parity invariant `prefiltered(KD-tree bbox) == full-scan` on the corpus.
  On-edge/on-vertex/collinear/zero-area/self-touching polygons feed ITEM-10.
- **ITEM-12**: Categorical/compound predicate encoder + live count. Generalize legacy `getCellIds`
  (cluster/metadata/annotation/sample, each include/exclude) into DSL: base `in` over sample ids, then per
  filter `intersect`(include)/`andnot`(exclude). A **partial eval** gives the legacy live cell-count preview
  + cross-group overlap check. The "DE group1/group2 builder as a recipe" resolution. Feeds the widget
  (ITEM-22).
- **ITEM-13**: `SelectionRecipe` model + input-hash pinning. `{ predicate, inputs: {ref → {artifactId,
  contentHash}}, axisVersion, evaluatorVersion, dslVersion }`. Resolve every leaf ref → catalog artifact +
  its **content hash** (P1/P2) so re-eval on the same pinned inputs yields byte-identical cells
  (content-addressed reproducibility). The recipe — not the bitmask — is what provenance stores. P8 owns the
  recipe PAYLOAD + hash-pinning; the run-node table is a shared build with provenance.
- **ITEM-14**: Selection-as-recipe capture chokepoint (the interaction chokepoint). ONE "record selection"
  API that, on any selection commit, writes a provenance **run node** (`job_type="selection.*"`) storing
  the recipe (ITEM-13) via live8's `ProvenanceCapture` seam — never the materialized mask; set-algebra
  selection stores operand refs + op, not a merged mask. Emits study-scoped `sync`. O(1) in N.
- **ITEM-15**: `api.selection` service. Wrap `Coordination.store` as the public
  `selection { current():CellSet; useCurrent(); onChange(cb):Disposable; set(CellSet);
  setByPredicate(Predicate):Promise<CellSet>; recipe():SelectionRecipe|null }`. `set` writes
  `pointSelection`; `setByPredicate` validates (ITEM-4) → evaluates (ITEM-8 client / ITEM-9 server) →
  builds+stores recipe (ITEM-13/14) → sets shared state. Extend Coordination `pointSelection` to carry BOTH
  the mask AND the source recipe (DEC-P8-B) without breaking the render hot path. The AI's hand AND the
  annotation panel's `useCurrent()` — one shared cell-set for annotation/DE/subcluster.
- **ITEM-16**: `api.brush` service — the NEW persistent brush object live3 lacks. `{axis|column, lo, hi}` on
  a numeric axis/histogram (a QC threshold / gate bound), itself a `between` predicate (composes into the
  DSL → same recipe/provenance path). Add a `brushRange` field + `setBrush` action to Coordination;
  `useCurrent`/`set`/`onChange`. Generalizes live3's heatmap-only column brush (`matrixSelection.ts`) into a
  canvas/axis brush. Consumed by the `threshold-on-histogram` widget (§4.3).
- **ITEM-17**: `api.pick` service — the clicked/hovered single cell `{viewIndex, durableId}`. Promote live3
  `highlight` (index) + add durable id + **a click-to-pick handler** (live3 has hover only — add to
  `DeckScatterCanvas.tsx`/`GridWorkspace.tsx`); `useCurrent`/`set`/`onPick`. Trajectory start/end + tooltip
  origin (§4.4).
- **ITEM-18**: Selection origin + self-echo + fan-out. Reuse `selectionOrigin`: tag a predicate-set selection
  `ai`/`widget`/`lasso`/`panel:<id>` so overlays + linked panels fan out without a write-back loop (the
  existing `setSelection` origin mechanism). AI-driven `setByPredicate` emits a study-scoped sync signal
  (§0.5).
- **ITEM-19**: `selection.setByPredicate` command + MCP tool + host handler + DSL-vocabulary resource.
  Register `selection.setByPredicate(predicate)` and `selection.current` as **commands** so §0.4's
  registry→MCP generation emits the tool (no bespoke MCP code). Host handler (`POST /api/selection/
  by-predicate`, loopback/REST): JSON-schema-validate (ITEM-4) → SERVER evaluator (ITEM-9) over the study's
  artifacts → set shared selection (ITEM-15, sync-emit to client) → record recipe (ITEM-14). Study-role
  gated; `safety: read-run` auto-approved (select can't harm; the separate `annotate.assign` is the gated
  mutation, §0.4.1). Publish the DSL operator vocabulary + available-fields (gene/col existence from the
  data schema) as an MCP **resource** the AI reads before emitting a predicate. P8 owns the schema + handler
  + resource content; P9 generates the tool + resource + the two `mcp.rs` edits (auto-attach + is-builtin so
  the model actually sees the tool).
- **ITEM-20**: Headless reproduce path. Re-evaluate a stored recipe server-side (ITEM-9) over the pinned
  artifacts to (a) verify the regenerated bitmask matches (reproducibility-badge input for the in-sandbox
  re-run), (b) drive the methods-text templater (ITEM-21). All headless/server-side (no browser). Wire into
  the provenance reproduce/export seam (Phase 4).
- **ITEM-21**: Predicate → methods/human text. A renderer `predicate → "cells where lognorm(ABC) >
  median(ABC)"` for the methods paragraph + provenance display + the widget's read-back label
  (§0.4.1/§0.6 reproduce-export).
- **ITEM-22**: `cell-set-selector` shared widget core (§4.3 Tier 3). The host-provided predicate-builder
  control with a **live cell-count preview** driven by the client evaluator (ITEM-8) + categorical encoder
  (ITEM-12) — the reusable DE-group / gate builder every extension references (`{widget: cell-set-selector}`)
  instead of re-coding. Emits a **predicate** (not a frozen id list) that round-trips through the schema
  (ITEM-2) + evaluator (ITEM-8). (Full form-engine integration belongs to the forms workstream; this
  delivers the DSL-building + preview core.)
- **ITEM-23**: Wire `selectionActions` + interactive tools to the ONE shared selection. Both a declarative
  `SelectionActionContribution` (acts on `api.selection.current()`) and a code interactive tool (annotation
  panel reading `api.selection.onChange`) consume the SAME `Stores.Coordination` selection — no per-module
  selection model. Availability-gate actions on `when:"has-selection"`. The §4.4 anti-fragmentation
  guarantee. Assigning an annotation from a predicate-sourced selection produces an artifact whose
  provenance references the recipe (ITEM-14), not a frozen mask.
- **ITEM-24**: Typed error contract + caps (shared, identical across BOTH evaluators). Shared error
  vocabulary (gene/col not found, wrong type, unbounded/oversized expression, result-cardinality cap)
  returned identically by client + server; the AI relays it, the human sees it inline. Expression depth/
  size + result caps enforced identically — part of the parity contract (ITEM-10).
- **ITEM-25**: Tests. Unit: AST JSON round-trip; **evaluator parity vs a brute-force full-N scan oracle**
  (the CPU oracle pattern in `selectionNarrowing.test.ts`); reduction kernels vs numpy-style fixtures;
  bounded-reject (`TooComplex`); NA + sparse-zero semantics; geo→predicate parity vs live3 `selectInPolygon`;
  categorical encoder vs legacy `getCellIds` oracle (port a `NewDEForm` fixture). Integration:
  `setByPredicate` → recipe persisted → re-eval yields byte-identical mask; MCP tool schema round-trip;
  input-hash stability. Property battery: eval determinism + hash stability under reorder. (The TS↔Rust
  golden corpus is ITEM-10 — distinct from this brute-force oracle.)

---

## Files/modules

**`@txresbench/workbench-api` (new package, extracted in P5 — the versioned public surface):**
- `src/interaction/cellset.ts` — `CellSet` (promote `IndexMask`) + durable-id round-trip (ITEM-1).
- `src/interaction/api.ts` + `selection.ts` — `selection`/`brush`/`pick` façade + interface types on
  `WorkbenchAPI` (ITEM-15/16/17).
- `src/dsl/predicate.schema.json` — the single JSON-schema source of truth (ITEM-2).
- generated `src/dsl/predicate.ts` (TS AST) + `src/dsl/predicate.rs` (Rust AST) via emit_ts golden
  (ITEM-3).
- `src/dsl/vocabulary.ts` — operator/reduction descriptor + extension hooks (ITEM-5).
- `src/interaction/recipe.ts` — `SelectionRecipe` type (ITEM-13).

**Client / viz framework (`@txresbench/framework` viz-core, tree `/data/pbya/txresbench/tmp/visualization-wt`):**
- `viz-core/predicate/dsl.ts`, `evalPredicate.ts` (ITEM-8), `inPolygon.ts` + lasso→predicate compiler
  (ITEM-11), `columns.ts` (ITEM-6), `reductions.ts` (ITEM-7), `categorical.ts` (ITEM-12), `errors.ts`
  (ITEM-24), `validate.ts` (ITEM-4), `recipe.ts` (client hash-resolution, ITEM-13), `methodsText.ts`
  (ITEM-21), `mcpResources.ts` (vocab + data-schema projections, ITEM-5/19), `evalPredicate.parity.test.ts`
  (ITEM-10).
- Adopt/extend: `adapter/Coordination.store.ts` (+`brushRange`/`setBrush`, carry recipe; ITEM-15/16),
  `viz-core/data/selection.ts` + `selection/SelectionController.ts` (reuse unchanged; geo compiler +
  evaluator import them), `heatmap-matrix/matrixSelection.ts` → generalize to axis brush (ITEM-16),
  `gridSelection.ts` `unprojectInCell` (ITEM-11), add click-pick to `DeckScatterCanvas.tsx`/
  `GridWorkspace.tsx` (ITEM-17). `switch(cell.kind)`→`registerViewKind` refactor is a SEPARATE
  viz-adoption workstream P8 depends on for view-kind exposure but does not own.

**Server (host, current worktree / txresbench):**
- `src-app/server/src/modules/predicate/{mod,ast,eval,reduce,geometry}.rs` — Rust evaluator + geometry
  (ITEM-9/11).
- `.../modules/predicate/recipe.rs` — recipe payload + hash pinning (ITEM-13).
- `.../modules/predicate/{handlers,routes}.rs` — `POST /api/selection/by-predicate` loopback/REST + the
  `setByPredicate` handler + the two MCP-resource projections (ITEM-19).
- `.../modules/predicate/validate.rs` — mirrored schema+semantic validation (ITEM-4).
- reproduce/methods hook in the provenance export seam (ITEM-20).
- `src-app/server/tests/predicate/parity_test.rs` + shared corpus `tests/predicate/corpus/*.json`
  (ITEM-10).
- migration `…_selection_recipes.sql` OR reuse the provenance run-node table when it lands (ITEM-13/14).

**MCP:** registry command registration (P5) → generator (P9) emits the tool + resource; `mcp.rs`
auto-attach + is-builtin edits (P9).

---

## Reuse

- **live3 `IndexMask` + `selectInBox`/`selectInPolygon`/`bboxCandidates`/`polygonBoundingBox`** — the whole
  cell-set + set-ops + lasso hit-test engine; **`d3-polygon.polygonContains`** is the algorithm ported
  verbatim into Rust (ITEM-11).
- **`SelectionController`** — ordered-area combine-mode model; geo compiler maps area list → DSL nodes.
- **`Coordination.store`** — shared selection/highlight/gene substrate + `setSelection` origin/self-echo
  (ITEM-18); `pointSelection`/`highlight`/`HoverInfo` GPU pick.
- **`gridSelection.unprojectInCell`, `pointIndex.ts` KD-tree, `matrixSelection.columnRangeToPointIndices`,
  `spatial/roiSelect`** — geometry/brush/prefilter primitives.
- **legacy `getCellIds` / `CellFilteringFormItems`** (`NewDEForm.tsx`) — compound include/exclude +
  live-count semantics the categorical encoder (ITEM-12) reproduces as DSL.
- **P1 data API** (`geneColumn`/`obs`/`clustering`/`embedding`, catalog artifact content-hashes) — the
  evaluators' read side + the recipe's pinning source.
- **txresbench host SDK:** `emit_ts.rs` golden-parity discipline (ITEM-3/10); built-in MCP server pattern
  (loopback JSON-RPC + JWT/permission gate + tool-call approval); sync (`SyncEntity`+`publish`,
  notify-and-refetch); JSON-schema→form; content-addressed file store (`txresbench-file`, checksum-indexed) for
  hash pinning; manifest-schema-validation pattern (§3).
- **live8 `feat/provenance`** recipe model (§B1 gesture table, DEC-GRAPH predicate+hash) + `ProvenanceCapture`
  seam (design-only — P8 defines the recipe payload; the run-node table is a shared build).

---

## Dependencies

- **P1 data-foundation (KEY DEP, hard)** — the typed data-API read surface (`geneColumn` sparse slice,
  `obs`, `clustering`, `embedding`) + catalog artifact **content hashes**. Both evaluators read columns
  through it (ITEM-6/7/8/9); the recipe pins against it (ITEM-13). Greenfield Phase-0 critical path — the
  server evaluator (ITEM-9/19/20) is blocked on it; the client evaluator (ITEM-8) needs the FE `data.*`
  thin client. *Nothing in P8 evaluates or pins without P1.*
- **P2 datatype-system** — the `metadata-column` datatype + subtyping so the DSL can reference a produced
  computed feature (`{col}`) as a first-class leaf (§0.4.1 heavy-feature→metadata-column→predicate-refs-it).
- **P4 provenance (hard for ITEM-14/20)** — stores the `SelectionRecipe` as a selection run-node; reproduce/
  methods export reads it. Design-only today — coordinate the recipe shape; run-node table is a shared build.
- **P5 contribution-api (hard)** — `api.selection`/`brush`/`pick` are fields on `WorkbenchAPI`; command
  registration for `setByPredicate`/`current`. P8 defines the types + owns the schema/evaluators; P5
  assembles the runtime object + surfaces them.
- **P6 workbench-shell** — hosts the `cell-set-selector` / `threshold-on-histogram` widget chrome; P8
  supplies the builder→predicate encoder + count evaluator (ITEM-22).
- **P7 visualization (hard for runtime backing)** — adopts live3 selection primitives + Coordination store
  as the shell canvas; overlays render the evaluated mask; the lasso feeding ITEM-11 comes from the canvas;
  view-kind exposure (brush-on-histogram) needs the separate viz-adoption `registerViewKind` refactor.
- **P9 ai-mcp** — generates `selection.setByPredicate` as a tool + exposes the vocabulary/data-schema
  resources from ITEM-2/5/19 (consumer, not a blocker for the evaluators).

Consumed BY: P9 (AI selection), P6 (widgets), the annotation/DE/subcluster modules (P11+), P4 (recipe).

---

## Sequencing

1. **Contract layer (blocks everyone, no P1 runtime):** ITEM-2 (DSL AST + JSON-schema) → ITEM-3 (TS+Rust
   codegen + golden) → ITEM-1 (`CellSet`) → ITEM-5 (vocabulary) → ITEM-4 (validator) → ITEM-13 (recipe
   shape). Pure types.
2. **Evaluator core (against P1 contract + fixture backend):** ITEM-6 → ITEM-7 → ITEM-8 (client) **‖**
   ITEM-9 (server) + ITEM-24 (errors/caps) — implemented against the same spec; land the brute-force oracle
   (ITEM-25) immediately.
3. **Parity gate (continuous convergence gate):** ITEM-10 accrues as ITEM-8/9/11 grow; polygon cases added
   with ITEM-11.
4. **Compilers:** ITEM-11 (geo + polygon determinism) + ITEM-12 (categorical + live count) — parallel after
   core.
5. **Primitives/services (atop live3 + client eval):** ITEM-15/16/17/18 wrap Coordination; ITEM-21 methods
   text; ITEM-22 widget core.
6. **Server + AI seam (needs P1 catalog + P4 recipe node):** ITEM-14 (capture chokepoint), ITEM-19
   (setByPredicate host surface + MCP), ITEM-20 (headless reproduce — last, needs Phase-4 export seam).
7. **Wiring + tests:** ITEM-23 (selectionAction/interactive-tool) closes; ITEM-25 integration
   recipe-roundtrip closes after step 6.

Critical path: **P1 data API + catalog hashes** → ITEM-6/7/8/9 → ITEM-13/14/15 → ITEM-19. The pure-contract
layer (step 1) starts immediately, blind of P1. ITEM-1/2/5/11 (spec + geometry) + client ITEM-8 build
against fixtures + the parity corpus before the server foundation lands; ITEM-9/14/19/20 wait on Phase-0.

---

## Decisions

- **DEC-1 (r1↔r2 tie broken by r3) — TWO evaluators, bound by a golden PARITY corpus. Client-only REJECTED.**
  Build BOTH a client-TS evaluator (instant preview: the cell-set-selector live count + lasso preview over
  columns already resident client-side for coloring — §0.4.1 "evaluates in-process (host/client)", "the
  host's predicate evaluator") AND a server-Rust evaluator (authoritative for the AI/MCP `setByPredicate`
  and headless reproduce). **Why not client-only:** `selection.setByPredicate` is a declared MCP tool that
  executes in the Rust server (loopback JSON-RPC) and is invoked **headlessly by the LLM with no browser
  attached** (§4.1.1 AI jobs default `normal`/`batch`); and headless reproduce (§0.6) re-evaluates the
  recipe server-side for the reproducibility badge + methods export — both have no client to delegate to.
  **Why not server-only:** a server round-trip per keystroke/drag is too slow for live preview. **Cost
  control:** the DSL is small + bounded (fixed operator vocabulary, no arbitrary code), so two
  implementations of one bounded spec is a closed, tractable duplication — a serializer-with-a-golden-test,
  not an open-ended reimplementation. A shared JSON golden corpus (predicate × fixture columns → expected
  bitmask words, ITEM-10) is loaded by BOTH suites and asserted byte-identical; any drift fails both. Same
  discipline as the txresbench host's `emit_ts.rs` `types_ts_parity`.
- **DEC-1a — Polygon-boundary determinism (concrete item ITEM-11, mandatory *because* there are two
  evaluators).** `inPolygon` must resolve identically in both: (a) the lasso→predicate compiler stores
  **embedding-space f32 vertices** (never screen coords); (b) port live3 `d3-polygon.polygonContains`
  ray-crossing **verbatim** into Rust (identical vertex order, half-open crossing rule, arithmetic order);
  (c) identical **embedding-space quantization** to the artifact's stored precision on both sides before the
  crossing test (kills last-ULP cross-language divergence on on-edge/on-vertex/collinear); (d) the KD-tree
  bbox prefilter is a perf-only narrowing with a `prefiltered == full-scan` parity invariant. Boundary/
  vertex/collinear/zero-area/self-touching polygons are explicit golden cases.
- **DEC-2 — DSL SCHEMA + BOTH evaluators are OWNED by P8.** P5 only surfaces them via `api.*` + the command
  registry; P9 generates the MCP tool/resource FROM P8's schema. P8 does not delegate the schema or eval.
- **DEC-3 — DSL wire form = JSON AST, not a string grammar** (DEC-P8-A). It directly IS the MCP tool's
  JSON-schema input, directly `serde`-deserializable in Rust, directly what the widget builds. No parser to
  write/keep in sync.
- **DEC-4 — Predicate schema is the single source; TS + Rust types are generated** with an emit_ts-style
  golden test (ITEM-3). Prevents the TS/Rust drift that would break DEC-1 parity.
- **DEC-5 — Selection stored as a RECIPE, never a materialized cell list** (§0.6). Even a human lasso
  persists as `{inPolygon, embeddingRef, verts, input hash}`. Scale-safe (10⁶ cells) + reproducible;
  freehand `idList` is the sole exception. `CellSet = IndexMask (render hot path) + optional source recipe`.
- **DEC-6 — Heavy computed features are NOT in the DSL** (§0.4.1). A 500-gene signature / neighborhood stat
  is a sandboxed analysis → a `metadata-column` artifact; the DSL only references that column (`{col}`).
  Reductions stay cheap O(n) over one resident column. The ITEM-4 bounds enforce this.
- **DEC-7 — Bounded, no arbitrary code.** Max AST depth D=32, nodes N=256, reductions R=16, + a
  result-cardinality cap (tunable); no function calls, loops, or host access beyond declared leaf refs.
- **DEC-8 — Sparse-absent = 0 in the layer's value domain; NA = cells outside the covered axis (never
  selected).** For lognorm/counts a gene column's non-nnz cells are genuine zeros, so `> median` is correct;
  NA is reserved for out-of-axis cells. The correctness lynchpin of ITEM-6.
- **DEC-9 — `brush` and categorical filters are DSL sugar, not separate models.** `api.brush` = a `between`
  node; a categorical widget filter = `in`/`andnot` nodes. One representation → one evaluator → one recipe.
  `brush` becomes a first-class persistent Coordination field (live3 has none) so a QC/gate brush is
  linkable + recipe-able, not transient-local.
- **DEC-10 — Selection is `read-run` (non-mutating); the mutation is the separate, gated `annotate.assign`.**
  Keeps the AI's selecting hand ungated (auto-approved) while the write stays permission-gated (§0.5 study
  role + approval).
- **DEC-11 — `CellSet` = the existing `IndexMask`/`Uint32Array` duality, promoted — not a new type.** Over
  the dense view-index; durable ids `(sample,local_index)` are the persistence/alignment form. Server mirror
  = packed-`u32` `roaring`/`bitvec` with the same word layout.
- **DEC-12 — Evaluator is domain-neutral** — generic per-cell columns from the data API (gene/obs/
  clustering), matching DATA_MODEL's "single-cell is not privileged."
- **DEC-13 — Reuse live3, don't fork.** `IndexMask`/`selectInPolygon`/`SelectionController`/
  `Coordination.store` are the substrate; P8 adds the DSL + two evaluators + recipe + `api.*` wrappers.
- **DEC-14 — Stamp `evaluatorVersion` + `dslVersion` in the recipe now** so a future semantics change (e.g.
  NA handling) can gate re-eval; migration/version-compat policy deferred but the fields exist from day one.

---

## Risks

- **R1 — Foundation not built (critical path).** The Phase-0 working-store + typed data API + catalog
  content-hashing are greenfield/design-only; provenance is design-only. The server evaluator (ITEM-9/14/
  19/20) and hash-pinning (ITEM-13) can't be integration-tested until they land. Mitigation: build ITEM-2/3/
  4/8/9/11 against the data-API *contract* + a fixture backend + the parity corpus (unit-level, foundation-
  independent); integrate when Phase-0 + provenance land. Sequence, don't block.
- **R2 — Two-evaluator drift.** Mitigated by the golden parity harness (ITEM-10) as a hard CI gate + the
  deliberately small, closed DSL surface (DEC-6/7).
- **R3 — Cross-language f32 polygon divergence** on boundary/vertex/collinear points — mitigated by the
  verbatim d3-polygon port + identical quantization backstop (ITEM-11) + explicit boundary golden cases.
- **R4 — Pinned-input-hash resolution** depends on the catalog exposing stable per-artifact content hashes;
  if the catalog lands without content-addressing, reproducibility weakens to `artifactId@version`. Flag as
  a catalog requirement; coordinate with P1/P2.
- **R5 — Recipe/run-node ownership** overlaps the design-only provenance workstream (risk of two
  definitions). Mitigation: P8 owns the recipe PAYLOAD + hash-pinning; the run-node table is a single shared
  build; coordinate before migrating.
- **R6 — Coordination store selection form is `Uint32Array` (materialized), not recipe-aware.** ITEM-15 must
  extend it (keep the mask on the render hot path; add the recipe alongside) without regressing live3.
  Coordination also lives inside the viz package, not yet in `@txresbench/workbench-api` — ITEM-1/15 depend on the
  Phase-1/2 extraction+adoption landing first.
- **R7 — Reduction correctness at scale (median of 10⁶, selection-restricted over a sparse gene column).**
  Which cells count as 0 vs NA is the subtlest surface — covered by DEC-8 + parity/oracle tests.
- **R8 — Categorical encoder parity with legacy `getCellIds`** (intersect-then-andnot per filter, sample-id
  base has subtle overlap semantics). The oracle test (ITEM-25) must port real `NewDEForm` fixtures or
  behavioral drift ships silently.
- **R9 — Column residency for headless AI selection.** Resolved by DEC-1's server evaluator: the AI path
  evaluates server-side and records the recipe regardless; a client materializes the mask on next attach
  (recipe is the source of truth).
- **R10 — Geometric recipe stability under embedding recompute.** A `geo` recipe pins the embedding artifact
  hash (DEC-5), so re-running on a new embedding is correctly a *different* recipe — but the "your lasso is
  stale because the embedding changed" UX needs a surfaced signal (P6/P7).
- **R11 — View-kind exposure** (brush-on-histogram, `view.set`) needs the `switch(cell.kind)`→
  `registerViewKind` refactor owned by the viz-adoption workstream; the histogram brush (ITEM-16) has no
  live3 backing today. Coordinate.

---

## Effort

| Cluster | Items | Est. |
|---|---|---|
| Contracts (CellSet, DSL AST+schema, TS+Rust codegen+golden, vocabulary, validator, recipe shape) | 1,2,3,4,5,13 | ~5 d |
| Evaluator core — client + server + shared errors/caps (resolver, reductions, both evals) | 6,7,8,9,24 | ~7 d |
| Golden parity harness (load-bearing correctness gate, ongoing) | 10 | ~3 d |
| Compilers (geo + polygon determinism, categorical + live count) | 11,12 | ~5 d |
| `api.*` services + Coordination adoption + methods text + widget core | 15,16,17,18,21,22 | ~5 d |
| Server seam (capture chokepoint, setByPredicate host + MCP, headless reproduce) | 14,19,20 | ~5 d |
| Wiring + tests (selectionAction/interactive-tool, brute-force oracle, integration, battery) | 23,25 | ~4 d |

**Total ≈ 34 engineer-days** (~7 wk solo) — larger than r1's ~25 d because the second (Rust) evaluator +
golden parity + polygon determinism are now in scope (the r3 tie-break). The pure-contract cluster (~5 d)
is unblocked and lands first; the two evaluators + parity are the critical-path correctness core; the
server seam is gated on the Phase-0 data API + P4 provenance. Effort is M-heavy in count, not raw volume;
the load-bearing risk is the Phase-0 data-API dependency + the two-evaluator parity discipline.

---

## Saturation

r3 did NOT add a substantively new *work item* beyond r1∪r2 — every deliverable it lists already exists in
the union (r2 introduced the second evaluator + golden parity; r1 introduced the column resolver,
reduction kernels, categorical encoder, selection-origin taxonomy, methods-text, and evaluatorVersion).
What r3 contributed was **decision resolution + concretization**, not new scope: it broke the exact r1↔r2
tie the DIFF flagged (`DIVERGED — needs r3`) by ruling BOTH evaluators in with a first-principles argument
grounded in the app's real MCP model (MCP tools run headlessly in the Rust server with no browser; headless
reproduce is server-side), and it turned r2's one-line "polygon boundary determinism" risk into a concrete,
buildable item (verbatim d3-polygon→Rust port + embedding-space quantization + prefilter==full-scan
invariant + a boundary golden corpus). Those are refinements of existing items, not a new coverage area.
With the tie resolved and the last fuzzy risk (polygon determinism) now specified as an item, there is no
open architectural fork or uncovered work surface remaining. **SATURATION: REACHED**
