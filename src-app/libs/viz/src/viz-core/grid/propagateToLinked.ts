// propagateToLinked.ts — (segmentation-scale Track C, ITEM-14) the PURE fan-out that computes the
// per-cell display patches when a user hits "apply to link group". Mirrors `resolveLinkedCellDomains`
// (also in this module): a pure, React-free, node-testable function over the link group, so the
// GridWorkspace action is a thin apply-the-patches shell.
//
// ESC-1 (owner decision): propagate BOTH channels (contrast + visibility) AND palette (channel colors
// + the additive colormap). The two `scope` flags gate what is applied — "apply contrast to group"
// (channels only), "apply palette to group" (palette only), or both. The confirm-before-overwrite
// policy lives in the GridWorkspace action (it inspects which targets already have overrides); this
// function is unconditional and pure.

import type { RasterChannelState } from '../spatial/rasterImageLayers'

/** The display fields a cell contributes to / receives from a propagation. Decoupled from `GridCell`
 *  so the fan-out is unit-testable without the full cell model. */
export interface PropagableCellDisplay {
  readonly id: string
  readonly channels?: readonly RasterChannelState[]
  /** the additive colormap NAME (image display), part of the "palette". */
  readonly colormap?: string
}

/** What crosses in a propagation. `channels` = contrast window + visibility; `palette` = channel
 *  colors + the additive colormap. */
export interface PropagateScope {
  readonly channels: boolean
  readonly palette: boolean
}

/** One target cell's patch. `channels`/`colormap` present ⇒ set them; absent ⇒ leave unchanged. */
export interface CellDisplayPatch {
  readonly cellId: string
  readonly channels?: RasterChannelState[]
  readonly colormap?: string
}

function cloneChannel(ch: RasterChannelState): RasterChannelState {
  return {
    name: ch.name,
    color: [...ch.color] as [number, number, number],
    contrastLimits: [...ch.contrastLimits] as [number, number],
    visible: ch.visible,
  }
}

/**
 * Compute the display patch for every OTHER cell in `groupIds`, copying the `source` cell's display
 * per `scope`. PURE. Returns `[]` when the source is missing or not itself a group member (a
 * propagation is always FROM a member). Cells named in `groupIds` but absent from `cells`, and any
 * cell outside the group, receive no patch. The source cell is never patched (unchanged).
 *
 * Per-channel merge (by index): a target keeps its own channel where the scope does not cover it —
 * `channels` scope overwrites `contrastLimits`+`visible`, `palette` scope overwrites `color`; a
 * target channel with no source counterpart is left intact. When `palette` is in scope the target's
 * additive `colormap` is set to the source's (which may be `undefined` ⇒ clear to per-channel colors).
 */
export function propagateToLinked(
  sourceId: string,
  groupIds: readonly string[],
  cells: readonly PropagableCellDisplay[],
  scope: PropagateScope,
): CellDisplayPatch[] {
  if (!scope.channels && !scope.palette) return []
  if (!groupIds.includes(sourceId)) return []
  const byId = new Map(cells.map(c => [c.id, c]))
  const source = byId.get(sourceId)
  if (!source) return []
  const srcChannels = source.channels ?? []

  const patches: CellDisplayPatch[] = []
  for (const targetId of groupIds) {
    if (targetId === sourceId) continue
    const target = byId.get(targetId)
    if (!target) continue // named in the group but not a live cell → no-op

    // A target with NO channels (undefined OR an explicit empty array) inherits the source's channel
    // shape — else `[].map` yields `[]` and propagation is a silent no-op for that cell.
    const base = target.channels && target.channels.length > 0 ? target.channels : srcChannels
    const channels: RasterChannelState[] = base.map((ch, i) => {
      const src = srcChannels[i] ?? ch
      const merged = cloneChannel(ch)
      if (scope.channels) {
        merged.contrastLimits = [...src.contrastLimits] as [number, number]
        merged.visible = src.visible
      }
      if (scope.palette) {
        merged.color = [...src.color] as [number, number, number]
      }
      return merged
    })

    // Under palette scope the target's additive colormap tracks the source's (possibly `undefined` ⇒
    // clear to per-channel colors); under channels-only scope the colormap key is omitted (unchanged).
    patches.push(scope.palette ? { cellId: targetId, channels, colormap: source.colormap } : { cellId: targetId, channels })
  }
  return patches
}

/** Does a cell carry its OWN display overrides (⇒ propagation would overwrite it, needing confirm)? A
 *  cell with explicit `channels` or a `colormap` has been tuned; a bare (seeded-default) cell has not. */
export function cellHasDisplayOverrides(cell: PropagableCellDisplay): boolean {
  return (cell.channels !== undefined && cell.channels.length > 0) || cell.colormap !== undefined
}
