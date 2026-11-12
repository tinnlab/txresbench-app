# P7 Visualization — r1 vs r2 convergence diff

## Substantively new in r2 (not in r1)
- **`swapCellContent`/`swapFields` made registry-driven** (r2 ITEM-3): r2 identifies `swapCellContent()`'s hardcoded display-field set as a fourth closed point and makes each descriptor carry `swapFields` so a new view-kind's per-cell state (colorBy/linkColorScale/graphOverlay) travels on drag-swap. r1's refactor list does not surface `swapCellContent` as a site to open.
- **Pop-out renders a scatter fixture regardless of `cell.kind`** flagged as a real (registry-fixable) follow-on (r2 Risk). r1 does not mention the pop-out/cell-kind mismatch.
- **Explicit P11 (three-modules) consumer dependency** — r2 names P11 as consuming the registered scatter/heatmap view-kinds + overlays. r1 lists no downstream module consumer.

## Substantively new in r1 (not in r2)
- **Standalone `/visualization` route kept behind a dev/gallery flag** as an explicit decision (r1 DEC-P7-7 / ITEM-2). r2 re-homes the page to the shell center container but does not preserve the standalone route as a deliberate decision.
- Nothing else of substance — r1's remaining items all have r2 equivalents.

## Shared substance
Both plans converge on the identical spine: adopt live3's `feat/visualization` `viz-core` deck.gl engine unchanged (keeping viz-core `@txresbench/*`-free, only `adapter/` platform-coupled) and land it before refactor with the existing test suite green; then perform the one headline refactor — turn the closed `switch(cell.kind)` / `CellKind` union / `isDenseKind` / `CELL_KIND_OPTIONS` / `Record<CellKind,KindRunner>` battery into an **open runtime `registerViewKind`/`getViewKind`/`listViewKinds` registry that IS the P5 `plotTypes` contribution point**, with `CellKind` becoming a `string` id, `Unsupported` fallback preserved, and the 10 built-ins self-registering by import side-effect (dogfood, behavior byte-identical). Both publish the conformance battery + `invariants.ts` predicates into `@txresbench/workbench-api` as the third-party acceptance gate, inverting the battery to iterate the registry with a runtime coverage assertion replacing compile-time exhaustiveness. Both add a viewer-per-datatype dispatch seam registering the deck.gl family as the `matrix` family (genome/structure/network deferred seams), back `DataSource` with a real P1 `PlatformDataSource` replacing `FixtureSource`, adopt Coordination as the linked-small-multiples substrate bridged (not replaced) to `api.selection`, generalize `graphOverlay` into an overlay registry, and mount the grid into the P6 shell center. Same key dependency (P5 co-ownership of the registry/descriptor shape), same risks (P5 type coupling, DataSource↔P1 framing impedance, GPU-path not structurally battery-gated, losing compile-time exhaustiveness), same no-SVG law.

## Verdict
VERDICT: CONVERGED
