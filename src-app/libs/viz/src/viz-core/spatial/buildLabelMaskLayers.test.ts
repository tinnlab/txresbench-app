// buildLabelMaskLayers.test.ts — TEST-1 (segmentation-scale ITEM-1): the pure in-grid label-mask
// layer builder. Constructing a deck.gl Layer only shapes props (no GL context), so the builder is
// directly node-testable: we assert the stable `cellLayerId(cellId,'labelmask')` id + `<cellId>::`
// prefix, the 1:1 feed of the resolved `labelMask` (raster/dims/categoryForId), the review-state
// pass-through, and the empty-when-absent contract (byte-identical to a no-mask grid). Also covers
// the pure `deriveMaskCategories` helper.

import { describe, it, expect } from 'vitest'
import { buildLabelMaskLayers, deriveMaskCategories, LABEL_MASK_LAYER_NAME } from './buildLabelMaskLayers'
import { LabelMaskLayer } from './LabelMaskLayer'
import { cellLayerId } from '../layers/multiView'
import type { LabelMaskData } from '../grid/gridModel'

function fixtureMask(): LabelMaskData {
  // 4×4 raster, ids 1 & 2; id 1 → category 5, id 2 → category 7.
  const raster = Uint32Array.from([
    0, 1, 1, 0,
    0, 1, 2, 0,
    0, 0, 2, 2,
    0, 0, 0, 0,
  ])
  const categoryForId = new Uint16Array([0, 5, 7]) // index = id
  return { raster, width: 4, height: 4, categoryForId }
}

describe('buildLabelMaskLayers (TEST-1)', () => {
  it('returns one LabelMaskLayer id-prefixed for the cell, fed the mask raster + dims + LUT', () => {
    const labelMask = fixtureMask()
    const layers = buildLabelMaskLayers({ labelMask, cellId: 'cellB' })
    expect(layers).toHaveLength(1)
    const layer = layers[0] as InstanceType<typeof LabelMaskLayer>
    expect(layer).toBeInstanceOf(LabelMaskLayer)
    // id = cellLayerId(cellId, 'labelmask') so the shared-deck layerFilter routes it into cellB only.
    expect(layer.id).toBe(cellLayerId('cellB', LABEL_MASK_LAYER_NAME))
    expect(layer.id.startsWith('cellB::')).toBe(true)
    // fed the resolved mask 1:1.
    expect(layer.props.labelMask).toBe(labelMask.raster)
    expect(layer.props.width).toBe(4)
    expect(layer.props.height).toBe(4)
    expect(layer.props.categoryForId).toBe(labelMask.categoryForId)
    // pixel-space flipY bounds so the mask overlays the image 1:1.
    expect(layer.props.bounds).toEqual([0, 4, 4, 0])
    expect(layer.props.pickable).toBe(true)
  })

  it('passes the review state through to the layer props', () => {
    const hidden = new Set([7])
    const layers = buildLabelMaskLayers({
      labelMask: fixtureMask(),
      cellId: 'c',
      hiddenCategories: hidden,
      soloCategory: 5,
      selectedId: 2,
      outline: true,
      dirtyRect: [0, 0, 1, 1],
    })
    const p = (layers[0] as InstanceType<typeof LabelMaskLayer>).props
    expect(p.hiddenCategories).toBe(hidden)
    expect(p.soloCategory).toBe(5)
    expect(p.selectedId).toBe(2)
    expect(p.stroked).toBe(true)
    expect(p.fillOpacity).toBe(0)
    expect(p.dirtyRect).toEqual([0, 0, 1, 1])
  })

  it('routes a click through onPick with the picked id + world coordinate', () => {
    const picks: Array<{ id: number | null; x: number; y: number }> = []
    const layers = buildLabelMaskLayers({ labelMask: fixtureMask(), cellId: 'c', onPick: p => picks.push(p) })
    const onClick = (layers[0] as InstanceType<typeof LabelMaskLayer>).props.onClick as (info: unknown) => void
    onClick({ id: 2, coordinate: [1.5, 2.5] })
    expect(picks).toEqual([{ id: 2, x: 1.5, y: 2.5 }])
  })

  it('returns [] for an absent / zero-size mask (byte-identical to a no-mask grid)', () => {
    expect(buildLabelMaskLayers({ labelMask: null, cellId: 'c' })).toEqual([])
    expect(buildLabelMaskLayers({ labelMask: undefined, cellId: 'c' })).toEqual([])
    const empty: LabelMaskData = { raster: new Uint32Array(0), width: 0, height: 0, categoryForId: new Uint16Array(1) }
    expect(buildLabelMaskLayers({ labelMask: empty, cellId: 'c' })).toEqual([])
  })
})

describe('deriveMaskCategories (TEST-1)', () => {
  it('prefers host-supplied categories (labels + colors) when present', () => {
    const cats = deriveMaskCategories(
      { categories: [{ code: 5, label: 'Tumor', color: [255, 0, 0] }, { code: 7, label: 'Stroma' }] },
      new Uint16Array([0, 5, 7]),
    )
    expect(cats).toEqual([{ code: 5, label: 'Tumor', color: [255, 0, 0] }, { code: 7, label: 'Stroma' }])
  })

  it('derives the DISTINCT non-background category codes from categoryForId when none supplied', () => {
    // ids 1,2,3 → categories 7,5,7 ⇒ distinct {5,7}, sorted.
    const cats = deriveMaskCategories({}, new Uint16Array([0, 7, 5, 7]))
    expect(cats).toEqual([{ code: 5 }, { code: 7 }])
  })
})
