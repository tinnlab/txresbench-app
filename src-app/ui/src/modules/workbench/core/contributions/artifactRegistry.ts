// The per-analysis artifact-view SEAM (ITEM-39). Host-owned dispatch, import-light +
// framework-free (only React TYPES) so it is unit-testable in the node runner.
//
// ITEM-35 deleted the `resultRenderers` half of this file — the contribution resolver
// (`resolveResultRenderer` / `ResultResolution`) and the NAMED single-artifact resolver
// (`registerResultComponent` / `resolveResultComponent`) it fed. The `resultRenderers`
// registry had ZERO production contributors, so its `render: { component: '<name>' }`
// branch was unreachable, and the sole registered name (`ui/StandardResultTable`) went
// with ITEM-31. What remains is the `defaultForKind` classifier the `ArtifactPanel` now
// dispatches on directly, plus the N-way COMPARE + artifacts-LIST seams (untouched here —
// `dispatchCompare` has a live production caller in `ArtifactCompareView`).

import type { ComponentType, ReactNode } from 'react'

/** A multi-artifact COMPARE renderer (ITEM-39) — one dispatch receives ALL N ids, so a
 *  merged/side-by-side view (e.g. N volcanoes, a clustree) is expressible as ONE
 *  renderer instead of N tiled panes. */
export type ArtifactCompareComponent = ComponentType<{ artifactIds: string[] }>

/** A bespoke artifacts-LIST column set (ITEM-39) — a module may supply the columns its
 *  per-analysis artifacts list shows (legacy DE: Method/MaxCells/MinPct/Group1/Group2);
 *  absent → the generic filtered history spine is used. */
export interface ArtifactListRenderer<Row = unknown> {
  columns: { key: string; title: string; render: (row: Row) => ReactNode }[]
}

// ── named multi-artifact COMPARE renderers (ITEM-39) ─────────────────────────
const BUILTIN_COMPARE_COMPONENTS: Record<string, ArtifactCompareComponent> = {}

export function registerArtifactCompareComponent(id: string, component: ArtifactCompareComponent): void {
  BUILTIN_COMPARE_COMPONENTS[id] = component
}

export function resolveArtifactCompareComponent(id: string): ArtifactCompareComponent | undefined {
  return BUILTIN_COMPARE_COMPONENTS[id]
}

// ── bespoke artifacts-LIST columns (ITEM-39) ─────────────────────────────────
const ARTIFACT_LIST_RENDERERS: Record<string, ArtifactListRenderer> = {}

export function registerArtifactListRenderer(kind: string, renderer: ArtifactListRenderer): void {
  ARTIFACT_LIST_RENDERERS[kind] = renderer
}

/** Resolve a module's bespoke list columns for a produced kind (undefined → the generic
 *  filtered-history spine is used). */
export function resolveArtifactListRenderer(kind: string): ArtifactListRenderer | undefined {
  return ARTIFACT_LIST_RENDERERS[kind]
}

// ── ArtifactPanel pure classifier (ITEM-58 / ITEM-35) ──────────────────────────
// The host-owned artifact-panel dispatch is a PURE, node-testable CLASSIFIER: the produced
// `artifactKind` maps to one of the three host renderers. The DE-specific
// `de|marker|table → StandardResultTable` heuristic is GONE, and so is the
// `resultRenderers` contribution branch that replaced it (zero contributors, ITEM-35) —
// so an UNKNOWN datatype always reaches the universal `GenericResult` fallback.

/** The host renderer a produced kind draws through. */
export type DefaultArtifactKind = 'stat' | 'provenance' | 'generic'

/** The universal classifier — stat/metric → StatCard, provenance/methods →
 *  ProvenanceView, everything else → the universal `GenericResult` fallback. */
export function defaultForKind(artifactKind: string): DefaultArtifactKind {
  const k = artifactKind.toLowerCase()
  if (/stat|metric/.test(k)) return 'stat'
  if (/provenance|methods/.test(k)) return 'provenance'
  return 'generic'
}

// ── pure dispatch (unit-tested) ──────────────────────────────────────────────

/** Dispatch an N-way compare (ITEM-39). A registered compare renderer for `kind`
 *  receives ALL ids in ONE dispatch; else `{ mode: 'tiled' }` — the pane model serves
 *  compare by tiling / popping-out N single artifact panes (the modern form of the
 *  legacy tab pop-out). */
export type CompareDispatch =
  | { mode: 'named'; component: ArtifactCompareComponent; artifactIds: string[] }
  | { mode: 'tiled'; artifactIds: string[] }

export function dispatchCompare(kind: string, artifactIds: string[]): CompareDispatch {
  const component = resolveArtifactCompareComponent(kind)
  return component ? { mode: 'named', component, artifactIds } : { mode: 'tiled', artifactIds }
}

/** Test-only: reset every seam registry. */
export function __resetArtifactRegistry(): void {
  for (const k of Object.keys(BUILTIN_COMPARE_COMPONENTS)) delete BUILTIN_COMPARE_COMPONENTS[k]
  for (const k of Object.keys(ARTIFACT_LIST_RENDERERS)) delete ARTIFACT_LIST_RENDERERS[k]
}
