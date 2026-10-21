// buildLabelMaskLayers.ts — the PURE layer builder that turns a resolved in-grid label mask
// (`GridCell.labelMask`) + its live review state into the deck.gl layer that renders it as a
// color-by-category overlay on the ONE shared grid deck (segmentation-scale ITEM-1). The direct
// twin of `buildRasterImageLayers`: one source of truth for the in-grid `LabelMaskLayer` shape so
// the standalone `LabelMaskView` AND the grid build the SAME layer from the SAME props.
//
//   • The layer id is `cellLayerId(cellId, 'labelmask')` so the grid's `makeLayerFilter` routes it
//     into THIS cell's OrthographicView and nowhere else (pans/zooms with its camera) — exactly
//     like `cellLayerId(cellId, 'image')`.
//   • `bounds = [0, height, width, 0]` (flipY, matching `LabelMaskView`) so pixel (x,y) maps to
//     world (x,y) 1:1 over the image; an optional `modelMatrix` places the pixel grid into world
//     space (the same registration the image `loader` uses).
//   • The review state — `hiddenCategories`/`soloCategory` (LUT alpha, no pixel re-upload),
//     `selectedId` (in-shader highlight), `outline` (stroke-only) — and the in-place-edit
//     `dirtyRect` (sub-upload) are all pass-through to the layer's existing props.
//
// Framework-agnostic (viz-core): depends ONLY on @deck.gl/core + the pure `LabelMaskLayer` +
// `labelMaskColor`/`multiView` helpers. No backend/storage import (INV-1); no store/coordination
// coupling — the caller (GridWorkspace) owns the per-cell mask session + wires the callbacks.

import type { Layer, PickingInfo } from '@deck.gl/core'
import { Matrix4 } from '@math.gl/core'
import { LabelMaskLayer, type DirtyRect } from './LabelMaskLayer'
import type { Palette } from './labelMaskColor'
import type { LabelMaskData, LabelMaskCategoryMeta } from '../grid/gridModel'
import { cellLayerId } from '../layers/multiView'

/**
 * The category list for a mask's review panel: the host-supplied `data.categories` when present
 * (carrying labels + swatch colors), else the DISTINCT non-background category codes actually present
 * in `categoryForId` (labelled `Class {code}` downstream). Pure — node-testable. `categoryForId` is
 * passed explicitly (rather than read off `data`) so a live snapshot after a relabel is reflected.
 */
export function deriveMaskCategories(
  data: Pick<LabelMaskData, 'categories'>,
  categoryForId: Uint16Array,
): LabelMaskCategoryMeta[] {
  if (data.categories && data.categories.length > 0) {
    return data.categories.map(c => ({ code: c.code, label: c.label, color: c.color }))
  }
  const codes = new Set<number>()
  for (let i = 1; i < categoryForId.length; i++) {
    const c = categoryForId[i]
    if (c > 0) codes.add(c)
  }
  return [...codes].sort((a, b) => a - b).map(code => ({ code }))
}

/** The layer-name suffix for a cell's label-mask layer (`<cellId>::labelmask`). */
export const LABEL_MASK_LAYER_NAME = 'labelmask'

export interface BuildLabelMaskLayersParams {
  /** the resolved mask this cell renders; absent ⇒ no layer (`[]`). */
  labelMask?: LabelMaskData | null
  /** the owning cell id — the built layer's id is `cellLayerId(cellId, 'labelmask')`. */
  cellId: string
  /** categorical palette (default the layer's shared categorical palette). */
  palette?: Palette
  /** categories to HIDE (LUT alpha 0); a LUT rebuild, never a pixel re-upload. */
  hiddenCategories?: Set<number> | null
  /** solo one category (only it visible); overrides `hiddenCategories`. */
  soloCategory?: number | null
  /** highlight this label id in-shader (0/null = none). */
  selectedId?: number | null
  /** draw region boundaries only (stroke, transparent fills) instead of solid fills. */
  outline?: boolean
  /**
   * the dirty rect of the most-recent IN-PLACE edit. When a NEW non-empty rect is passed with the
   * SAME `raster` reference (mutated in place), the layer sub-uploads only that rect (never a full
   * re-encode). Absent/empty ⇒ full render for a fresh mask identity.
   */
  dirtyRect?: DirtyRect | null
  /** hover callback — `info.id` is the label id under the cursor (0 = background). */
  onHoverId?: (id: number | null) => void
  /**
   * click callback — carries the picked label `id` AND the world coordinate `[x,y]` of the click
   * (pixel space, since `bounds`/`modelMatrix` register the raster 1:1). The host dispatches the
   * active correction tool from this: `select`/`relabel`/`merge` need `id`; `brush`/`split` need `x,y`.
   */
  onPick?: (pick: { id: number | null; x: number; y: number }) => void
}

/** deck types `PickingInfo` loosely; the LabelMaskLayer stamps `id` onto the pick info. */
type MaskPickInfo = PickingInfo & { id?: number | null }

/**
 * Build the deck.gl layer(s) for an in-grid label-mask cell. Pure — constructing a deck Layer only
 * shapes props (no GL context), so this is directly unit-testable in node. Returns a `Layer[]`
 * (0 or 1 layer): a cell without a `labelMask` yields `[]` (byte-identical to a no-mask grid).
 */
export function buildLabelMaskLayers({
  labelMask,
  cellId,
  palette,
  hiddenCategories,
  soloCategory,
  selectedId,
  outline,
  dirtyRect,
  onHoverId,
  onPick,
}: BuildLabelMaskLayersParams): Layer[] {
  if (!labelMask || labelMask.width <= 0 || labelMask.height <= 0) return []
  const { raster, width, height, categoryForId, modelMatrix } = labelMask

  return [
    new LabelMaskLayer({
      id: cellLayerId(cellId, LABEL_MASK_LAYER_NAME),
      labelMask: raster,
      width,
      height,
      categoryForId,
      ...(palette ? { palette } : {}),
      // pixel space, flipY: row 0 at the TOP (y=height) — reads right-side-up over the image.
      bounds: [0, height, width, 0],
      ...(modelMatrix ? { modelMatrix: new Matrix4(modelMatrix) } : {}),
      // FILL by default; OUTLINE = region boundaries only (transparent fills via fillOpacity 0).
      stroked: !!outline,
      fillOpacity: outline ? 0 : 1,
      hiddenCategories: hiddenCategories ?? null,
      soloCategory: soloCategory ?? null,
      selectedId: selectedId ?? null,
      ...(dirtyRect ? { dirtyRect } : {}),
      pickable: true,
      onHover: (info: MaskPickInfo) => onHoverId?.(info?.id ?? null),
      onClick: (info: MaskPickInfo) => {
        const c = info?.coordinate as [number, number] | undefined
        onPick?.({ id: info?.id ?? null, x: c ? c[0] : 0, y: c ? c[1] : 0 })
      },
    }) as unknown as Layer,
  ]
}
