// maskDock.ts — the pure DOCK decision for the OPEN segment cells' `MaskReviewControls` panels
// (segmentation-scale ITEM-2, per-paned by annotate-tooling-ux ITEM-8/9). The direct twin of
// `annotateDock.ts::resolveAnnotateDocks`: the workspace renders EACH open pane's mask review/correct
// panel either PORTALED into a host-provided container (`maskControlsContainer`, called ONCE PER OPEN
// PANE) or STACKED in the internal right panel.
//
// ITEM-9 / INV-12: returns a LIST — one dock per open pane. The prior single-dock form keyed off one
// "focused" mask cell, which is the defect this feature fixes: N datasets side by side must each be
// reviewable at once. Factored out as a pure function so the branching is unit-testable under the
// node-only vitest harness (which cannot render the deck.gl-backed `GridWorkspace`).

import type { MaskTool } from './MaskReviewControls'
import type { DirtyRect, SplitSeed } from './maskEdit'

/**
 * SPLIT C (ITEM-17): the LIVE review/edit state of ONE segment pane's mask dock.
 *
 * It lives here rather than in either component because the split put its two halves in different
 * files: `GridDockLayer` renders the dock that edits it, while `GridWorkspace` still owns the
 * `maskReview` record (the label-mask LAYER builder reads hide/solo/LUT from it, and the shell's mask
 * handlers write it through `patchMaskReview`). `maskDock.ts` is the module both already import and is
 * the mask dock's own model, so it is the declaration site neither side has to import from the other.
 */
export interface MaskCellReview {
  hidden: Set<number>
  solo: number | null
  selectedId: number | null
  tool: MaskTool | null
  target: number | null
  mergeSource: number | null
  splitSeeds: SplitSeed[]
  dirty: DirtyRect | null
  catsRef: Uint16Array | null
}

/** A pane's default review state — nothing hidden, no tool, no selection. A FRESH object per call
 *  (it carries a mutable `Set`), so it is never shared between panes. */
export function emptyMaskReview(): MaskCellReview {
  return {
    hidden: new Set(), solo: null, selectedId: null, tool: null, target: null,
    mergeSource: null, splitSeeds: [], dirty: null, catsRef: null,
  }
}

export type MaskDockEntry =
  /** Stack this pane's panel in the grid's internal right panel (host resolver absent/returned nothing). */
  | { readonly kind: 'internal'; readonly cellId: string }
  /** Portal this pane's panel into the host-provided container. */
  | { readonly kind: 'portal'; readonly cellId: string; readonly host: HTMLElement }

/**
 * Resolve where EACH open segment cell's `MaskReviewControls` should render. Byte-identical to the
 * annotate/edit-form seam, per pane: portal when the host resolver returns an element for that pane,
 * else the internal right panel. Returns `[]` off the primary container, out of segment mode, or when
 * no pane is open. A pane whose mask has not resolved yet is still returned — the caller skips it
 * when it cannot build a session (the mask may still be loading).
 */
export function resolveMaskDocks(args: {
  readonly isPrimaryContainer: boolean
  readonly segmentMode: boolean
  readonly openCellIds: readonly string[]
  readonly container?: (paneId: string) => HTMLElement | null | undefined
}): MaskDockEntry[] {
  const { isPrimaryContainer, segmentMode, openCellIds, container } = args
  if (!isPrimaryContainer || !segmentMode) return []
  const out: MaskDockEntry[] = []
  for (const cellId of openCellIds) {
    if (!cellId) continue
    const host = container?.(cellId) ?? null
    out.push(host ? { kind: 'portal', cellId, host } : { kind: 'internal', cellId })
  }
  return out
}
