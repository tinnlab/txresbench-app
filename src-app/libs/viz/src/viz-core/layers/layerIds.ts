// layerIds.ts — the PURE layer-id vocabulary (`<cellId>::<layerName>`), split out of
// `multiView.ts`.
//
// ── WHY THE SPLIT (measured) ──────────────────────────────────────────────────────────
// `multiView.ts` imports `OrthographicView` from `@deck.gl/core` for its view/viewState
// builders. `grid/gridModel.ts` — pure data (the `GridCell` model), read by the declarative
// option parser and by `adapter/GridWorkspace.store.ts` — imported `cellLayerId` from it for
// a single string join. Tree-shaking cannot drop a module you take a real value from, so that
// one edge put `@deck.gl/core` behind anything touching the grid MODEL or the grid STORE.
//
// The cost is conditional, which is why it is easy to miss: measured by ablation in the
// CytoAnalyst app, restoring this edge alone changes nothing (723.03 kB critical path), and
// pointing `modules/visualization/module.tsx` at the `@ziee/viz/core` barrel instead of a
// narrower store import also changes nothing (723.06 kB) — but doing BOTH costs **+29.1 kB
// gzip** on the preloaded critical path (752.17 kB), because the store import then has a live
// path to deck. Keeping this split is what lets a consumer register the viz stores at module
// eval without reasoning about which barrel they came through.
//
// `multiView.ts` re-exports all three symbols, so every existing importer is unaffected.
//
// ── THE OTHER ID DIALECTS IN THIS PACKAGE (do not conflate them) ──────────────────────
// This defect recurred because several sites each decomposed an id in their own words. The
// register below is the standing answer to "is this one of mine?", so a future reader stops at
// the right module instead of harmonising four unrelated grammars into one bug:
//
//  · `<cellId>::<layerName>`  — THIS module. A flat join whose BOTH halves may contain `::`, so
//    it is never split; ownership is a yes/no question asked of a candidate you already hold.
//    Every consumer routes through `layerBelongsToCell` / `localLayerName` / `cellOfLayer`.
//  · `chunk-<ordinal>`        — `scale/chunkPicking.ts`. Anchored `/^chunk-(\d+)$/` over ids
//    `ChunkedScatter` mints for its OWN deck. It never publishes into the shared grid deck, so a
//    composed prefix cannot reach it; the anchors would reject one if it ever did. Same SHAPE as
//    the defect, recorded rather than changed — there is nothing here to fix.
//  · `<datasetId>::<layoutId>::<gen>` — `adapter/DatasetStore.ts`'s in-flight pull keys. Same
//    separator, different vocabulary (datasets, not panes); its one prefix match carries the
//    separator, so `ds` cannot evict `ds10`'s pulls.
//  · `<mode>:<columnKey>`     — `grid/CellView.tsx`'s colour-by select value. A SINGLE colon and
//    a closed enum on the left, so splitting at the first one is exact.
// The app's composing host mints the pane keys this module routes by and takes `LAYER_ID_SEP`
// from here rather than spelling its own (`canvasComposition.ts`).

/** Separator between a layer's owning cell id and its layer name. */
export const LAYER_ID_SEP = '::'

/** Compose a layer id that carries its owning cell id as a prefix. */
export function cellLayerId(cellId: string, layerName: string): string {
  return `${cellId}${LAYER_ID_SEP}${layerName}`
}

/**
 * Extract the owning cell id from a prefixed layer id. Returns the substring
 * before the first `::`; an id with no separator yields `''` (unknown owner).
 *
 * ── THIS ANSWER IS ONLY RIGHT WHEN THE CELL ID CARRIES NO SEPARATOR ─────────────────────
 * `<cellId>::<layerName>` is a FLAT join of two ids and BOTH halves may contain `::` — a
 * layer name can (`A::group::edges`), and a cell id can, because a host that composes
 * several declarations onto one grid namespaces every pane `<viewId>::<paneId>`. So for
 * `cell.filter::before-violin-0::violin-kde` this returns `cell.filter`: a string that
 * names NO cell. Use it ONLY as the *presence-of-a-prefix* predicate (`=== ''`).
 *
 * To decide WHOSE a layer is, you always have a candidate in hand — the viewport deck
 * reports, the cell you are asking about — so test it with `layerBelongsToCell` instead of
 * parsing a boundary out of a string whose shape depends on how many views are contributing.
 * Recovering identity by parsing here is what drew every composed pane's chart into no view
 * at all (`makeLayerFilter`, fixed 8e5e9fef) and then routed its hovers to no chart at all
 * (`GridOverlayLayer`'s two `onDeckHover` sites).
 */
export function cellOfLayer(layerId: string): string {
  const i = layerId.indexOf(LAYER_ID_SEP)
  return i === -1 ? '' : layerId.slice(0, i)
}

/**
 * Does `layerId` belong to `cellId`? THE one definition of layer ownership: the layer id
 * must begin with `<cellId>::`.
 *
 * The separator is part of the match, not decoration — pane ids that are bare string
 * prefixes of one another are ordinary (a `for_each` over 11 criteria puts `…-violin-1`
 * beside `…-violin-10`), so a plain `startsWith(cellId)` would claim the 11th criterion's
 * layers for the 2nd criterion's pane.
 *
 * An empty `cellId` owns nothing: `''` is how every caller here spells "no candidate"
 * (no viewport under the cursor, an unprefixed layer), and `layerId.startsWith('::')` would
 * otherwise turn that into a claim.
 */
export function layerBelongsToCell(layerId: string, cellId: string): boolean {
  return cellId !== '' && layerId.startsWith(`${cellId}${LAYER_ID_SEP}`)
}

/**
 * The INVERSE of `cellLayerId`: give back the layer NAME a cell's own code composed, or the id
 * unchanged when it is not this cell's.
 *
 * This is the third question the vocabulary is asked — after "whose is it" (`layerBelongsToCell`)
 * and "is it prefixed at all" (`cellOfLayer`) — and it had its own hand-rolled implementation in
 * `ChartCanvas.onGridHoverRef`, which un-prefixes a picked layer id before handing the hover to a
 * chart handler that matches on the id it BUILT (`info.layer.id === heatmapId`). Written out
 * there it was a second copy of the ownership rule, and a second copy is how this defect got to
 * happen twice already: `makeLayerFilter` and both `onDeckHover` sites each decided ownership
 * independently, so fixing one left the others. Routing it here means the separator anchoring —
 * and therefore the `…-violin-1` / `…-violin-10` case — has exactly ONE definition to get right.
 *
 * Returning the id UNCHANGED (rather than `null`/`''`) when it does not belong is what the caller
 * wants: a chart that is not sharing a deck publishes unprefixed ids, and passing those straight
 * through is the identity this function must preserve.
 */
export function localLayerName(layerId: string, cellId: string): string {
  return layerBelongsToCell(layerId, cellId)
    ? layerId.slice(cellId.length + LAYER_ID_SEP.length)
    : layerId
}
