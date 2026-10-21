// useAreaSelection.test.ts — the shared layer builder + shape contract (ITEM-2 / ITEM-7).
// The hook itself needs react+deck runtime; here we pin the PURE, constructible pieces: the outline
// layer maps role→style (committed border persists subtle, draft is bright) and no-ops on empty.
import { describe, it, expect } from 'vitest'
import { buildSelectionOutlineLayer, selectionShapes } from './useAreaSelection'
import type { OverlayShape, Vec2 } from './areaGestures'

const area: OverlayShape = { polygon: [[0, 0], [1, 0], [1, 1]] as Vec2[], role: 'area' }
const draft: OverlayShape = { polygon: [[0, 0], [2, 0], [2, 2]] as Vec2[], role: 'draft' }

describe('buildSelectionOutlineLayer', () => {
  it('returns null when there is nothing to draw', () => {
    expect(buildSelectionOutlineLayer([])).toBeNull()
  })

  it('maps a committed area to the SUBTLE persistent border and a draft to the bright one', () => {
    const layer = buildSelectionOutlineLayer([area, draft])
    expect(layer).not.toBeNull()
    const p = layer!.props as unknown as {
      getLineColor: (d: OverlayShape) => number[]
      getLineWidth: (d: OverlayShape) => number
      getFillColor: (d: OverlayShape) => number[]
      data: OverlayShape[]
    }
    // committed area: alpha 110 / width 1 (persists after finish, subtle)
    expect(p.getLineColor(area)).toEqual([56, 132, 255, 110])
    expect(p.getLineWidth(area)).toBe(1)
    // draft: alpha 220 / width 1.5 (active gesture reads clearly)
    expect(p.getLineColor(draft)).toEqual([56, 132, 255, 220])
    expect(p.getLineWidth(draft)).toBe(1.5)
    expect(p.getFillColor(area)).toEqual([56, 132, 255, 18])
    expect(p.getFillColor(draft)).toEqual([56, 132, 255, 30])
    expect(p.data.length).toBe(2)
  })

  it('accepts a custom id (grid prefixes it with the cell id for viewport scoping)', () => {
    const layer = buildSelectionOutlineLayer([area], 'cell-7::sel-shapes')
    expect(layer!.id).toBe('cell-7::sel-shapes')
  })
})

describe('selectionShapes re-export (single source of the committed+draft shape list)', () => {
  it('committed areas persist as role:area alongside a role:draft gesture', () => {
    const shapes = selectionShapes(
      [{ kind: 'rect', box: [0, 0, 1, 1], mode: 'add' }],
      null,
      [[0, 0], [2, 0], [2, 2]],
    )
    expect(shapes.map(s => s.role)).toEqual(['area', 'draft'])
  })
})
