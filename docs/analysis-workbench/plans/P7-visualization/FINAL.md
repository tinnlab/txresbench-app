# P7 — Visualization integration (FINAL, consolidated r1 ∪ r2)

## Reconciliation applied
Cross-part audit resolution baked into this plan: **A6** — the conformance-battery ownership between
P7 and P5 is settled. The battery **TYPES / pure invariant predicates + the `runConformance`
host-gate signature live in `@txresbench/workbench-api` (P5)**; **P7 provides the concrete view-kind
test-suite that IMPORTS them** from `@txresbench/workbench-api`. The import direction is **P7 → P5** (P7
depends on P5, never the reverse — **no package cycle**). P7 is the single source of the predicate
*bodies* (re-exported through P5's surface), and owns the per-view-kind conformance closures + the
registry-iterating battery runner. See ITEM-8/9/10.

**Scope (desktop + single-box server only, per BUILD_PLAN deployment table):** adopt live3's
`feat/visualization` `viz-core` deck.gl engine as the workbench center canvas unchanged, then perform the ONE
headline refactor — turn its **closed `switch(cell.kind)` / `CellKind` union / `isDenseKind` /
`CELL_KIND_OPTIONS` / `swapCellContent` / `Record<CellKind, KindRunner>` battery** into an **open runtime
`registerViewKind` / `getViewKind` / `listViewKinds` registry that IS the P5 `plotTypes` contribution point** —
publish its conformance battery in `@txresbench/workbench-api`, add **viewer-keyed-by-datatype** dispatch, wire the
existing Coordination linked small-multiples + synced brushing to the platform shared selection, and generalize
overlays. Genome/structure/network viewer families = later datatype-contributed seams; keep them open, do not
build them.

**Grounding (verified in live3 `feat/visualization`, `viz-core/`):** the dispatch is genuinely closed —
`CellView.tsx::ChartBody` is an exhaustive `switch(cell.kind)` over the closed union `CellKind`
(`gridModel.ts`: `scatter|image|grid|violin|box|bar|dotplot|heatmap|volcano|histogram`), each `case`
hard-importing a chart View; `isDenseKind()` hardcodes `scatter||image`; `defaultBindings()` +
`swapCellContent()` hardcode chart-binding / display-field sets; `CELL_KIND_OPTIONS` (`CellChrome.tsx`) is a
hand-maintained copy of the union; `viewKindBattery.test.ts` is a `Record<CellKind, KindRunner>` (compile-time
exhaustive). `showcase/registry.ts` is a *story* catalog only. `viz-core` is deck.gl-only and **`@txresbench/*`-free**;
only `adapter/` (Coordination.store, GridWorkspace.store via `@txresbench/framework/store-kit`, VisualizationPage,
autosave, popout) is app-coupled. `wire.ts::DataSource` is the typed-binary seam, today backed by `FixtureSource`.
So: **library-extensible via a closed union, NOT platform-extensible** — the switch→registry refactor is the P7
headline.

---

## Items

- **ITEM-1**: Adopt `feat/visualization` unchanged. Land live3 to main first (BUILD_PLAN re-sequencing step 1),
  then relocate `viz-core/` + `adapter/` under the workbench module (`modules/workbench/canvas/`). `viz-core`
  stays `@txresbench/*`-free (keep the rule); only `adapter/` imports platform APIs. No behavior change — move + re-home,
  gated by the existing viz vitest suite + `tsc` staying green (known-good baseline before any refactor).
- **ITEM-2**: Define the **`ViewKindDescriptor`** type + a runtime **`registerViewKind` / `listViewKinds` /
  `getViewKind`** registry (`viz-core/registry/viewKindRegistry.ts`). Descriptor =
  `{ id, title, dense, dataContract, render(ctx): ReactNode | DenseMarker, defaultBindings(catalog),
  conformance(caseInputs): void, swapFields?: (keyof GridCell)[], icon? }`. Plain module-level Map with a
  duplicate-id guard (mirror `showcase/registry.ts::registerStory`). This registry IS the P5 `plotTypes`
  contribution point (§4.2 "plotTypes == the viz package's view-kind registry").
- **ITEM-3**: Rewrite `CellView.tsx::ChartBody`: delete the exhaustive `switch(cell.kind)`; look up
  `getViewKind(cell.kind).render({ cell, source, catalog, rect, positions, colors, colorEpoch })`. Chart Views
  self-register by import side-effect (like the showcase stories); the per-View static imports in `CellView`
  disappear. A dense entry renders nothing here (deck draws underneath, unchanged). Unknown id → the existing
  `<Unsupported>` fallback (preserved — never crash).
- **ITEM-4**: Open `gridModel.ts` from the closed union to registry-driven. `CellKind` becomes `string` (a
  registered id); `isDenseKind(kind)` → `getViewKind(kind)?.dense ?? false`; `defaultBindings` delegates to the
  descriptor (keeping the catalog-derived default as the chart-family fallback); `swapCellContent` swaps the
  descriptor's `swapFields` (default: `kind`+`colorBy`+`linkColorScale`+`graphOverlay`) so a new view-kind's
  per-cell state travels on drag-swap. Keep the pure / no-React contract (still node-unit-testable).
- **ITEM-5**: `CellChrome.tsx::CELL_KIND_OPTIONS` → `listViewKinds()` (id + title), optionally filtered by the
  cell's datatype (ITEM-11), so the switcher `<select>` renders exactly the registered set (built-ins today,
  contributed kinds later).
- **ITEM-6**: Register the **10 built-in view-kinds** as descriptors through the same public API (dogfood): the
  dense pair (`scatter`, `image`) + the `grid` container-cell + the chart set
  (`violin`, `box`, `bar`, `histogram`, `dotplot`, `heatmap`, `volcano`), each wrapping its existing View
  component + its existing `aggregate`/`chartLayers` builders as `render` + `conformance`. One registration barrel
  (`viz-core/viewkinds/index.ts`). Net behavior byte-identical to the current switch (the switch is just data
  now) — the acceptance proof that "our own built-ins use only the public contribution API."
- **ITEM-7**: Each built-in's `dataContract` declares what it consumes from the platform data kinds
  (`coordinates` N×2 / a `values` continuous column / a `matrix` rows×cols / `groups`) mapped to the
  `DataSource`/`DatasetCatalog` surface — replacing the ad-hoc `defaultBindings(catalog)` with a per-view-kind
  binding resolver (keeps `defaultBindings` as the fallback resolver).
- **ITEM-8 (A6)**: Publish `conformance/invariants.ts`'s pure structural predicates (`assertFiniteRange`,
  `assertMatrixShape`, `assertPartitionCoversAll`, `assertMonotoneTicks`, `assertByteQuad`, `assertMaskLength`,
  `assertQuartilesOrdered`, `assertCountsSumTo`, …) through the **`@txresbench/workbench-api` surface** (P5) — **P5
  owns the published invariant-predicate + `runConformance` host-gate CONTRACT** (the TYPES/signatures), P7
  supplies the predicate *bodies* re-exported there, and **P7's concrete view-kind test-suite IMPORTS them from
  `@txresbench/workbench-api`** (import direction P7 → P5, no cycle) — so third-party view-kinds are validated by the
  *same* predicates the built-ins pass.
- **ITEM-9**: Refactor `viewKindBattery.test.ts` from the fixed `Record<CellKind, KindRunner>` table to
  **iterate `listViewKinds()`**, running each registered descriptor's `conformance(buildCase(...))` over the same
  seeded fast-check property runs + the degenerate / NaN-missing suites + the real-`FixtureSource` wire paths.
  The compile-time exhaustiveness (a `Record` over a closed union) becomes a **runtime coverage assertion**:
  every registered id has a `conformance` fn and the battery runs it. Keep the determinism knobs (`NUM_RUNS`,
  `FC_SEED`).
- **ITEM-10 (A6)**: **`runViewKindConformance(descriptor)` / the `runConformance` host gate** — its
  **signature/contract is published by `@txresbench/workbench-api` (P5)**; **P7 provides the concrete implementation +
  the view-kind test-suite that imports it** (the property + degenerate + NaN-missing generators, generalized to
  any descriptor; P7 → P5, no cycle). The
  host runs it at registration/load time on a *contributed* view-kind (reject-on-throw), so a third-party plot
  that leaks NaN / misaligns a buffer / drops a facet point is rejected automatically with the shrunk
  counterexample — no human review. Keep it in `just check`.
- **ITEM-11**: Add a **`ViewerFamily`/`ViewerRegistry` keyed by datatype** (DATA_MODEL "Viewers are
  datatype-contributed"; `viz-core/registry/viewerFamily.ts`): a datatype declares `viewers: ViewerRef[]`; the
  deck.gl view-kind registry is registered as **one viewer family** for `matrix`/`embedding`-shaped datatypes
  (single-cell/anndata, spatial/visium, bulk/counts). The canvas resolves a grid cell's bound artifact → its
  datatype (P2) → the datatype's declared `viewers` → candidate view-kinds; the CellChrome switcher lists only
  view-kinds valid for that datatype. Genome-track/structure/network families are **DEFERRED seams** (registry
  accepts them; none built).
- **ITEM-12**: Wire the datatype→viewer resolution through P2's **open datatype registry + subtyping lattice**:
  `matrix`-family view-kinds are offered on any subtype of `matrix`. A cell whose artifact has no matching viewer
  family renders a typed "no viewer for datatype X" placeholder (extends `<Unsupported>`). Near-term only the
  `matrix` family is populated; the datatype→family indirection exists but resolves to matrix for the single-cell
  types P11 ships.
- **ITEM-13**: Adopt the **Coordination store as-is** (`adapter/Coordination.store.ts`:
  `viewStates`/`pointSelection`/`selectionOrigin`/`colorScales`/`gridLinked`) + `viz-core/coordination/*` — the
  synced zoom/pan (per `GRID_SCOPE`), selection fan-out (a selection in any cell highlights every cell in its own
  idiom), and linked color scales (union domain). This IS small-multiples + synced brushing; no rebuild. Adopt the
  existing selection producer (`GridWorkspace.tsx` rect/polygon → `setSelection`) unchanged.
- **ITEM-14**: Bridge `Coordination.pointSelection`/`setSelection` ↔ the **platform shared selection API**
  (`api.selection`, P8): emit the selection outward on change (indices + originating cell + the geometric shape)
  so a lasso in any grid cell IS the platform `CellSet` (read by the right-dock selection inspector, DE,
  annotation). Coordination becomes the **canvas-local mirror** of `api.selection`, not a parallel model; P8
  compiles the lasso→predicate recipe (provenance, P4/P8) — P7 does not own the recipe.
- **ITEM-15**: Keep the grid workspace as the small-multiples **layout engine** (`GridWorkspace.store` +
  `viz-core/grid/*`: split-tree, drag-swap, pop-out/pop-in, per-cell color-by + link-scale) — already built;
  verify it composes inside the workbench center slot (P6) rather than a full-page route.
- **ITEM-16**: Generalize the per-cell **`graphOverlay`** (`GridCell.graphOverlay` flag +
  `overlays/graphOverlay.ts` + `GraphScatterView` drawing LineLayer/ScatterplotLayer/TextLayer riding a dense
  cell's viewport on the shared deck) into an **overlay registry** (`viz-core/overlays/overlayRegistry.ts`):
  `OverlayContribution = { id, consumes: datakind, appliesTo: 'dense'|'chart', buildLayers(ctx): DeckLayer[] }`.
  `buildGraphOverlay` becomes the first registered overlay (node-link/trajectory), reusing the `<cellId>::`
  layer-prefix routing + toggle machinery unchanged. Register graph + selection-highlight (the existing
  `DataFilterExtension` path) near-term; overlays render on the shared embedding and link with the shared
  selection — the seam interactive tools (annotation highlight, gate polygons, trajectory path) contribute onto
  the canvas.
- **ITEM-17**: **Back `DataSource` with the real platform data API** (P1): a `PlatformDataSource`
  (`adapter/PlatformDataSource.ts`) satisfying the *unchanged* `wire.ts::DataSource`/`DatasetCatalog`
  (`catalog/positions/valueColumn/categorical/continuous/table/graph/imageUnderlay`) by reading P1's
  typed-binary streaming endpoints (`GET /datasets/{id}/…` octet payloads decoded via the existing
  `decodePositions`/`decodeSparseColumn`/… helpers). `FixtureSource` stays the gallery/test source. This is
  exactly the seam `wire.ts` was designed for — no viz rewrite.
- **ITEM-18**: Mount the grid as the **workbench center canvas** in the P6 shell: mount `GridWorkspace` in the
  center region; feed color-by from the left field-providers (metadata/gene click → color, `fieldProviders` P5);
  the selection inspector into the right dock; results into the bottom dock. Reuse `VisualizationPage`'s
  data-loading effects (catalog/positions/color/tooltip) as the canvas container, dropping its standalone page
  chrome (top bar / export popover move to the shell toolbar per WORKBENCH_IA).
- **ITEM-19**: Keep the standalone `/visualization` route (today a top-level `sidebarNavigation` entry,
  fixture-seeded) behind a **dev/gallery flag** for the showcase/gallery; the *product* surface is the workbench
  center slot (ITEM-18).
- **ITEM-20**: Adopt **export / a11y / tooltip / autosave / pop-out untouched** (already generic): `export/`
  (raster + the one-allowed-SVG vector surface), `a11y/` (chartTableModel + DataTableView + live region),
  `tooltip/` (O(1) GPU-pick), `adapter/autosave.ts` + `popout/`. Re-home `ExportDialog` into the shell toolbar;
  keep `getDeckCanvas`/`getPaneRect` resolution.
- **ITEM-21**: Extend the **showcase gallery** (`showcase/**`, ~30 stories) as the visual-test surface: ensure
  the registry refactor doesn't break the story-completeness gate (stories `covers` a view-kind id — now sourced
  from `listViewKinds()`); add a completeness check that every registered built-in view-kind has a story; add a
  "contribute a toy view-kind through the public registry → it passes the battery → renders in a grid cell" story
  as the end-to-end extensibility proof.
- **ITEM-22**: Registry unit tests: register / lookup / duplicate-id guard / unknown-id-fallback; dense-flag via
  registry; switcher vocabulary = registry ids filtered by datatype; the host `runConformance` rejects a
  deliberately broken toy view-kind (NaN leak / buffer-length mismatch).

---

## Files / modules

**Adopt (vendor from `feat/visualization`, `src-app/ui/src/modules/visualization/` → `modules/workbench/canvas/`):**
- `viz-core/**` — the whole deck.gl engine (grid, charts, layers, coordination, selection, gpu, scale, spatial,
  density, export, a11y, tooltip, timeline, controls, core, layout, heatmap-matrix, overlays, conformance).
  Framework-agnostic; land unchanged (ITEM-1).
- `adapter/{Coordination,GridWorkspace}.store.ts`, `adapter/VisualizationPage.tsx`, `adapter/autosave.ts`,
  `adapter/useCellPopout.ts`, `adapter/PopoutWindow.tsx` — the txresbench/store-kit binding layer.
- `showcase/**` — the story gallery (visual-test surface).

**Create:**
- `viz-core/registry/viewKindRegistry.ts` — `ViewKindDescriptor` type + `registerViewKind`/`listViewKinds`/
  `getViewKind` (ITEM-2).
- `viz-core/viewkinds/index.ts` + per-kind co-located `register()` in each `charts/*View.tsx` and the dense
  `scatter`/`image` — the 10 built-in descriptors + `dataContract` (ITEM-6/7).
- `viz-core/registry/viewerFamily.ts` — datatype→viewer-family dispatch (ITEM-11/12).
- `viz-core/overlays/overlayRegistry.ts` — the overlay contribution seam (ITEM-16).
- `viz-core/conformance/hostGate.ts` (or in `@txresbench/workbench-api`) — `runViewKindConformance`/`runConformance`
  reject-on-throw host gate (ITEM-10).
- `adapter/PlatformDataSource.ts` — real `DataSource` impl over P1 endpoints (ITEM-17).

**Modify (in `viz-core`/`adapter`):**
- `grid/CellView.tsx` — `ChartBody` switch → `getViewKind().render` (ITEM-3).
- `grid/gridModel.ts` — `CellKind` union → `string`; `isDenseKind`/`defaultBindings`/`swapCellContent`
  registry-driven (ITEM-4/7).
- `grid/CellChrome.tsx` — `CELL_KIND_OPTIONS` → `listViewKinds()` (datatype-filtered) (ITEM-5/11).
- `conformance/invariants.ts` → re-exported via `@txresbench/workbench-api`; `conformance/viewKindBattery.test.ts` →
  registry-iterating (ITEM-8/9/10).
- `adapter/module.tsx` — top-level route → center-canvas slot contribution + dev-flag standalone route
  (ITEM-18/19).
- `adapter/VisualizationPage.tsx` — `FixtureSource` → `PlatformDataSource`; page chrome → shell container
  (ITEM-17/18).
- `adapter/Coordination.store.ts` + `viz-core/coordination/*` — bridge to `api.selection` (ITEM-14).

**Adopted unchanged (no edits):** `viz-core/{gpu,scale,export,a11y,tooltip,perf,popout,heatmap-matrix,density,
timeline,layers,spatial,controls,core}/*`, `adapter/{GridWorkspace.store,autosave,PopoutWindow,useCellPopout}`
(ITEM-20).

**Cross-part (owned elsewhere, P7 consumes/contributes to):**
- `@txresbench/workbench-api` (P5) — publishes `plotTypes`/`viewers`/`overlays` registries + the conformance
  invariants + `runViewKindConformance`.
- P2 datatype registry — `Datatype.viewers` field + subtyping lattice (ITEM-11/12).
- P1 data API — the real `DataSource` backing (ITEM-17).
- P6 center-canvas slot + docks + `fieldProviders` (ITEM-15/18); P8 `api.selection` (ITEM-14); P11 consumes the
  registered scatter/heatmap view-kinds + overlays.

---

## Reuse (live3's `viz-core`)

Nearly the entire engine is reused verbatim; the refactor is surgical (make dispatch data-driven):
- **live3 `viz-core` in full** — the whole deck.gl engine, charts, GPU kernels, scale/chunking (250k → millions),
  spatial (Viv/segmentation/transcript), export, a11y, tooltip, conformance predicates. This is the "adopt" — do
  NOT rebuild.
- **Grid workspace** — `grid/{GridWorkspace,gridModel,gridSelection,linkZoom}`, `layout/splitTree`,
  `adapter/GridWorkspace.store` (split/drag-swap/pop-out/resize) → small-multiples layout, unchanged.
- **View-kinds** — the 10 chart/dense Views + `charts/{ChartFrame,ChartCanvas,chartLayers,aggregate}` (pure
  GPU-layer prop builders + stat pre-pass) → wrapped as built-in view-kind contributions, internals unchanged.
- **Coordination / linked-views** — `adapter/Coordination.store` + `coordination/{colorScale,selectionSync,
  useSharedColorDomain}` → synced brushing + linked color scales, unchanged.
- **Conformance battery** — `conformance/{invariants,viewKindBattery,invariants.test}` → published as the
  third-party acceptance gate (ITEM-8/9/10).
- **`showcase/registry.ts` pattern** — the register/list/dup-guard shape is the template for `viewKindRegistry`
  + `overlayRegistry`.
- **Overlays** — `overlays/{graphOverlay,GraphScatterView}` + `GridCell.graphOverlay` + the `<cellId>::`
  layer-prefix routing → generalized to the overlay registry (ITEM-16).
- **Data plane** — `data/{wire,fixtures,engine,color,selection,statsKernels,missing}` + the decoders
  (`decodePositions`/`decodeSparseColumn`) → the `DataSource` seam P1's data API drops behind (ITEM-17).
- **`GridWorkspace.store` (`defineStore`/store-kit)** — the split-tree + per-cell config store, already
  platform-idiomatic.
- **Also reused untouched:** `gpu/*` (colormap LUT, densify, group-reduce, persistent attrs), `scale/*`
  (chunked/LOD/adaptive-sample), `export/*` (SVG/PDF vector — the one allowed SVG surface), `a11y/*`, `perf/*`,
  `tooltip/*`, `popout/*`, `heatmap-matrix/*`, `density/*`, `timeline/*` (faceting).

---

## Dependencies

- **P5 contribution-api — KEY DEP.** The `@txresbench/workbench-api` registries (`plotTypes`/`viewers`/`overlays`) +
  the manifest are where the view-kind/viewer/overlay contribution types live and where the conformance battery
  is published. P7's registry (ITEM-2) is the concrete first implementation of P5's `plotTypes` point; they must
  agree on the `ViewKind`/`Viewer`/`Overlay` type shapes (P7 defines the descriptor in viz-core; P5 re-exports —
  single source). **Blocks ITEM-2/8/10/11/16.**
- **P2 datatype-system** — viewer-keyed-by-datatype (ITEM-11/12) needs the open datatype registry + subtyping
  lattice + `Datatype.viewers`. Near-term only the `matrix` family is needed. **Blocks ITEM-11/12.**
- **P1 data-foundation** — the real `DataSource` backing (typed-binary streaming/data API + catalog + authed
  byte-range). **Blocks ITEM-17** (fixture unblocks everything else — the refactor is testable on `FixtureSource`).
- **P6 workbench-shell** — the center-canvas slot + docks + `fieldProviders` the grid mounts into. **Blocks
  ITEM-15/18.**
- **P8 interaction-dsl** — `api.selection` (shared selection/brush/pick + selection-as-recipe). **Blocks
  ITEM-14** (Coordination works standalone until then).
- **P4 provenance** — selection-recipe persistence downstream of ITEM-14 (soft dep, via P8).
- **P11 three-modules** — downstream **consumer**: renders into the registered scatter/heatmap view-kinds +
  overlays (embedding/clustering/annotation). P7 provides the registered built-ins they consume.
- **`feat/visualization` merged to main** — ITEM-1 precondition.
- **Internal:** the switch→registry refactor (ITEM-2→7) blocks the conformance-registry refactor (ITEM-9/10),
  viewer dispatch (ITEM-11), and overlay registry (ITEM-16) — the registry must exist first.

---

## Sequencing

1. **Land the framework** (ITEM-1) — merge live3 to main, vendor + re-home `viz-core`/`adapter` under
   `modules/workbench/canvas/`, green baseline (tsc + vitest). No behavior change. Unblocks everything.
2. **Registry core** (ITEM-2) — `ViewKindDescriptor` + `registerViewKind`/`listViewKinds`/`getViewKind`,
   coordinated with P5's contribution-api type shapes.
3. **Switch → registry** (ITEM-3,4,5,6,7) — rewrite `ChartBody`, open `CellKind`/`isDenseKind`/`defaultBindings`/
   `swapCellContent`, self-register the 10 built-ins by import side-effect + per-view-kind binding resolver +
   `CELL_KIND_OPTIONS` from `listViewKinds()`. **Gate: byte-identical behavior** (existing vitest + gallery
   green) — the risky refactor; converge here before moving on.
4. **Conformance published + registry-driven** (ITEM-8,9,10) — move invariants into `@txresbench/workbench-api`, make
   the battery iterate the registry, add the host `runConformance` reject gate.
5. **Data API swap** (ITEM-17) — `PlatformDataSource` once P1 lands; `FixtureSource` keeps P7 unblocked meanwhile.
6. **Viewer-per-datatype** (ITEM-11,12) — once P2's datatype type exists; register the deck.gl family as the
   `matrix` viewer; datatype-filter the switcher (resolves to matrix near-term).
7. **Coordination + selection bridge** (ITEM-13,14,15) — adopt Coordination as-is (13/15) early with the
   fixture; bridge to `api.selection` (14) when P8 lands.
8. **Overlays** (ITEM-16) — generalize the graph overlay into the overlay registry (graph + selection-highlight).
9. **Shell mount + re-home** (ITEM-18,19,20) — mount into the workbench center slot (needs P6), keep the
   standalone route behind a dev flag, re-home export/toolbar; adopt export/a11y/tooltip/autosave/pop-out
   untouched.
10. **Tests/gallery** (ITEM-21,22) — throughout; the toy-view-kind extensibility story is the exit proof.

**Steps 2–4 are the self-contained "bounded refactor"** — can proceed on merged live3 before P1/P2/P6 exist,
validated by the existing viz test suite + the new registry-driven battery.

---

## Decisions

- **DEC-P7-1** `CellKind` becomes an open `string` (registered view-kind id), NOT an enlarged closed union nor a
  plugin enum. The compile-time exhaustiveness live3 relied on (`Record<CellKind, …>`) is replaced by the
  **runtime conformance gate** (`runConformance`) — the correct trade for an open ecosystem (you cannot
  type-check a third-party contribution at the host's compile time). Matches VS Code `contributes` / napari
  `npe2`. `<Unsupported>` fallback preserves crash-safety.
- **DEC-P7-2** Built-ins self-register through the **same public `registerViewKind` API** by import side-effect
  (like `showcase/registry.ts` stories), no privileged path, no central static list — the switch's static imports
  disappear. This is the dogfood invariant (PLATFORM_ARCHITECTURE §0), proven correct by the behavior-identical
  gate (existing tests stay green).
- **DEC-P7-3** The refactor is **behavior-preserving first** (ITEM-6 registers exactly the 10 existing kinds with
  identical render/aggregate). No new plots, no new data wiring in the refactor step — de-risks it.
- **DEC-P7-4** The registry lives in **`viz-core` (`@txresbench/*`-free); `@txresbench/workbench-api` re-exports it** — keeps
  viz-core a standalone package while P5 owns the public contribution surface. The descriptor type is the shared
  contract.
- **DEC-P7-5** Conformance is a **per-descriptor closure the published harness drives**, NOT a hand-maintained
  `Record`. A runtime coverage assertion (every registered id has a `conformance` fn, and the battery runs it)
  replaces compile-time union exhaustiveness — the automatic acceptance gate for third-party plots.
- **DEC-P7-6** The deck.gl view-kind registry is **one viewer family (matrix/embedding-shaped), one of many**,
  registered into a datatype-keyed `ViewerRegistry`. Genome/structure/network are **out of P7 scope** — the seam
  is open (registry accepts new families) but no non-deck viewer is built (DATA_MODEL "design the seam open now;
  populate it incrementally").
- **DEC-P7-7** Adhere to viz-core's **no-SVG / all-GPU law** (DEC-18/23) for view-kinds; the only SVG surface
  stays the vector `export/*`. A contributed view-kind renders deck.gl layers via `ChartFrame`/`chartLayers`,
  never Vega/SVG/iframe — so the safe declarative tier is **parameterize-a-built-in-view-kind** or a **new
  deck.gl-layer view-kind (battery-gated)**, NOT a Vega-Lite spec.
- **DEC-P7-8** The `Coordination` store is **adopted, not replaced** — the canvas-local mirror of the platform
  `api.selection`, one selection representation across canvas / interactive tools / provenance (avoids the
  N-selection-models failure §4.4).
- **DEC-P7-9** Overlays are a **registry** (graph + selection-highlight first), reusing the `<cellId>::`-prefix
  layer routing — so interactive tools (annotation/gating/trajectory) contribute overlays without touching the
  grid.
- **DEC-P7-10** Keep the standalone `/visualization` route behind a dev/gallery flag; the *product* surface is
  the workbench center slot (ITEM-18/19).
- **DEC-P7-11 (OPEN cross-part boundary — resolve at audit)** **Scatter / matrix view-kind ownership: P7 viz vs
  P11 embedding module.** The DIFF flagged that P11 (three-modules) is the downstream consumer of the registered
  `scatter`/`heatmap` view-kinds + overlays. It is not yet settled whether P7 owns and ships those built-in
  view-kinds (P11 merely renders into them) or whether the embedding/clustering-specific scatter view-kind is
  *contributed by* P11 through the same public registry. Current plan assumption: **P7 registers the 10 built-ins
  (incl. scatter/heatmap); P11 consumes them** — but confirm the direction of the view-kind→datatype vs
  datatype→view-kind declaration (see U3) and P11's ownership at plan-audit before implementation.

---

## Risks / unknowns

- **R1 (refactor regression)** Opening `CellKind` union → `string` removes `tsc` exhaustiveness across the
  codebase (`gridModel`, `CellChrome`, the battery table, `swapCellContent`, tooltip). Every `switch`/
  `Record<CellKind,…>` site must move to registry lookups; a registered kind could ship without a `conformance`
  fn. **Mitigation:** ITEM-6's behavior-identical gate + the ~30-story gallery + vitest; the runtime coverage
  assertion (ITEM-9) + register-time harness (ITEM-10) fail loudly; keep in `just check`; grep every `CellKind`
  reference before merge.
- **R2 (P5 type-shape coupling)** The `ViewKind`/`Viewer`/`Overlay` contribution types are co-owned with P5. If
  P5's manifest shape diverges from P7's runtime registry, it's built twice. **Mitigation:** ITEM-2 done *with*
  P5; P7 defines the descriptor in viz-core, P5 re-exports — single source; converge the type in planning.
- **R3 (dense-vs-chart partition leaks into the registry)** `isDenseKind` drives deep pointer-events +
  shared-deck-vs-own-ChartCanvas behavior in `CellView` (pointer-transparency contract, drag-swap overlay). A
  registry `dense` flag must reproduce it exactly. **Mitigation:** keep `dense` a first-class registry field;
  scatter/image register `dense:true`; test the pointer contract.
- **R4 (datatype dispatch depends on P2 shape)** Viewer-per-datatype (ITEM-11) is only as good as P2's datatype
  registry + subtyping. If P2 slips, ITEM-11/12 degrade to "single matrix family for all artifacts" (acceptable
  interim — matches today's single-cell-only behavior). **Mitigation:** seam-open design; default family fallback.
- **R5 (DataSource↔P1 impedance)** `wire.ts`'s framings (interleaved positions, CSC sparse column, u16 codes)
  must match P1's octet endpoints exactly, or the "no rewrite" promise breaks. **Mitigation:** `wire.ts` was
  designed against `DATA_STORAGE_REDESIGN` §2/§3.4 — hold P1 to those framings; the decoders are the contract
  test.
- **R6 (adapter store-kit coupling on move)** `Coordination`/`GridWorkspace` stores use
  `@txresbench/framework/store-kit`; re-homing must keep the import path valid in the platform tree. **Mitigation:**
  move `adapter/` intact; viz-core stays framework-free.
- **R7 (pop-out renders a scatter fixture regardless of `cell.kind`)** — noted in the `CellView` C3a comment.
  Generalizing pop-out to the actual registered view-kind is now easy via the registry but is real work. **Flag
  as a follow-on, not a P7 blocker.**
- **R8 (conformance gate false-negatives / GPU path)** The battery is CPU/pure-math (GPU `*Gpu` parity proven
  only in the browser harness). A contributed view-kind's GPU layer could pass the pure battery yet mis-render —
  the gate validates *structural* invariants, not pixels/shaders. **Known limitation** (live3 documented it); the
  gallery + runtime-health pass covers the visual layer.
- **U1** Exact P6 center-canvas slot API (how the grid mounts + gets its data-API handle) — unknown until P6 r1.
- **U2** Whether `api.selection`'s cell-set representation (P8) is bitmask vs index-array — Coordination uses
  `Uint32Array` indices + `IndexMask`; a bitmask bridge may need a converter.
- **U3** Whether the datatype registry (P2) lets a *view-kind extension* declare which datatypes it serves
  (view-kind→datatypes) vs only the datatype declaring its viewers (datatype→view-kinds) — DATA_MODEL says the
  latter; confirm the direction in P2/P5 (tied to DEC-P7-11).

---

## Effort

- **Adopt/land + re-home** (ITEM-1): S–M. Vendoring + move are mechanical; gated on the live3 merge.
- **Switch→registry core** (ITEM-2–7): **M–L, the headline.** Bounded (~10 files), mechanical switch→registry +
  descriptor shape (dense flag, dataContract) + battery re-drive; touches every `CellKind` site; the
  behavior-identical gate is the cost, and the tests already exist to hold it green. ~4–5 units.
- **Conformance publish** (ITEM-8,9,10): S–M. Moving + inverting the battery to iterate the registry + the host
  reject-gate; gated on P5's package skeleton. ~2 units.
- **PlatformDataSource** (ITEM-17): M, gated on P1.
- **Viewer-family + overlay registries** (ITEM-11,12,16): S–M seams (matrix + graph/selection only near-term).
- **Coordination/selection bridge** (ITEM-13,14,15): S adopt + M bridge (gated P8).
- **Shell mount + re-home + adopt-unchanged** (ITEM-18,19,20): M, gated on P6/P8.
- **Tests/gallery** (ITEM-21,22): S, continuous. ~1 unit.

**Total ≈ M–L (14–18 units).** The bulk of the *value* (a proven GPU framework + conformance battery + linked
small-multiples + export/a11y/tooltip) is **reused**, not built; P7's genuine work is the **switch→registry
refactor + publishing the battery + datatype-keyed dispatch + overlay generalization** — everything else is
adopt-and-wire. The self-contained core (steps 2–4) is **M** and can land on merged live3 independently of
P1/P2/P6.
