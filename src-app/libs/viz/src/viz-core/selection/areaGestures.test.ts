// areaGestures.test.ts — the pure shared area-selection core (ITEM-1 + ITEM-7 vocab).
import { describe, it, expect } from 'vitest'
import {
  translateArea,
  areaContainsPoint,
  combineMask,
  boxCorners,
  hitTestTopmostArea,
  selectionShapes,
  commitCandidatesFor,
  outlineStyle,
  SELECTION_TOOLS,
  SELECTION_TOOL_LABEL,
  COMBINE_MODES,
  type Vec2,
} from './areaGestures'
import type { Area } from './SelectionController'
import { IndexMask } from '../data/selection'
import { buildPointIndex } from '../spatial/pointIndex'
import { shortLabelFor, toolKeysForSurface } from '../tools/vocabulary'

const rect = (box: [number, number, number, number], mode: 'add' | 'subtract' | 'intersect' = 'add'): Area => ({ kind: 'rect', box, mode })
const poly = (ring: Vec2[], mode: 'add' | 'subtract' | 'intersect' = 'add'): Area => ({ kind: 'polygon', polygon: ring, mode })

describe('translateArea', () => {
  it('moves a rect box by (dx,dy)', () => {
    expect(translateArea(rect([0, 0, 2, 2]), 5, -3)).toEqual({ kind: 'rect', box: [5, -3, 7, -1], mode: 'add' })
  })
  it('moves every polygon vertex by (dx,dy)', () => {
    const out = translateArea(poly([[0, 0], [2, 0], [1, 2]]), 10, 1)
    expect((out as { polygon: readonly (readonly [number, number])[] }).polygon).toEqual([[10, 1], [12, 1], [11, 3]])
  })
})

describe('areaContainsPoint', () => {
  it('rect: inside true, outside false (corner-order free)', () => {
    expect(areaContainsPoint(rect([2, 2, 0, 0]), [1, 1])).toBe(true)
    expect(areaContainsPoint(rect([0, 0, 2, 2]), [3, 1])).toBe(false)
  })
  it('polygon: inside true, outside false', () => {
    const tri = poly([[0, 0], [4, 0], [2, 4]])
    expect(areaContainsPoint(tri, [2, 1])).toBe(true)
    expect(areaContainsPoint(tri, [3.9, 3.9])).toBe(false)
  })
})

describe('combineMask', () => {
  const a = () => { const m = new IndexMask(4); m.set(0); m.set(1); return m }
  const b = () => { const m = new IndexMask(4); m.set(1); m.set(2); return m }
  it('add = union, subtract = difference, intersect = intersect', () => {
    expect([...combineMask(a(), b(), 'add').toIndices()]).toEqual([0, 1, 2])
    expect([...combineMask(a(), b(), 'subtract').toIndices()]).toEqual([0])
    expect([...combineMask(a(), b(), 'intersect').toIndices()]).toEqual([1])
  })
})

describe('boxCorners', () => {
  it('orders the four corners from any corner pair', () => {
    expect(boxCorners([2, 3, 0, 1])).toEqual([[0, 1], [2, 1], [2, 3], [0, 3]])
  })
})

describe('hitTestTopmostArea', () => {
  it('returns the LAST (topmost) containing area index; -1 when none contains', () => {
    const areas = [rect([0, 0, 4, 4]), rect([1, 1, 3, 3])] // both contain (2,2); topmost is index 1
    expect(hitTestTopmostArea(areas, [2, 2])).toBe(1)
    expect(hitTestTopmostArea(areas, [0.5, 0.5])).toBe(0) // only the outer contains
    expect(hitTestTopmostArea(areas, [9, 9])).toBe(-1)
    expect(hitTestTopmostArea([], [0, 0])).toBe(-1)
  })
})

describe('selectionShapes', () => {
  it('emits role:area per committed area + a role:draft for an in-progress rect/polygon', () => {
    const committed = [rect([0, 0, 1, 1]), poly([[0, 0], [2, 0], [1, 2]])]
    const withRect = selectionShapes(committed, { start: [0, 0], end: [3, 3] }, [])
    expect(withRect.map(s => s.role)).toEqual(['area', 'area', 'draft'])
    const withPoly = selectionShapes(committed, null, [[0, 0], [1, 0], [1, 1]])
    expect(withPoly.map(s => s.role)).toEqual(['area', 'area', 'draft'])
    // a <2-vertex polygon draft renders no draft shape
    expect(selectionShapes([], null, [[0, 0]]).length).toBe(0)
  })
})

describe('outlineStyle (committed-border-persists + subtle-styling contract)', () => {
  it('draft is bright/thick, committed area is subtle/thin', () => {
    expect(outlineStyle('draft')).toMatchObject({ lineColor: [56, 132, 255, 220], lineWidth: 1.5 })
    expect(outlineStyle('area')).toMatchObject({ lineColor: [56, 132, 255, 110], lineWidth: 1 })
  })
})

describe('commitCandidatesFor', () => {
  // 4 points at (0,0)(1,1)(2,2)(3,3)
  const positions = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3])
  const idx = buildPointIndex(positions)
  it('rect: range query returns points in the box', () => {
    const cands = [...commitCandidatesFor(rect([-0.5, -0.5, 1.5, 1.5]), idx)].sort((a, b) => a - b)
    expect(cands).toEqual([0, 1])
  })
  it('polygon: returns the bbox candidate superset (never fewer than the true inside set)', () => {
    const cands = new Set(commitCandidatesFor(poly([[-0.5, -0.5], [2.5, -0.5], [2.5, 2.5], [-0.5, 2.5]]), idx))
    expect(cands.has(0)).toBe(true)
    expect(cands.has(1)).toBe(true)
    expect(cands.has(2)).toBe(true)
    expect(cands.has(3)).toBe(false)
  })
})

describe('TEST-3 — shared tool/mode vocabulary, now DERIVED from the one registry', () => {
  it('exposes the canonical tool + mode lists', () => {
    // RETARGETED, not weakened: the exact-contents assertion survives verbatim. What changed is
    // where the contents come FROM — this module used to declare them itself while calling itself
    // "one definition, consumed by every host", which `VizToolRail` never honoured.
    expect(SELECTION_TOOLS).toEqual(['pan', 'rect', 'polygon', 'move'])
    expect(COMBINE_MODES).toEqual(['add', 'subtract', 'intersect'])
  })

  it('derives that list from the registry rather than a local literal', () => {
    expect(SELECTION_TOOLS).toEqual(['pan', ...toolKeysForSurface('select')])
  })

  it('keeps SELECTION_TOOL_LABEL a total, registry-derived re-export', () => {
    // `SelectableScatter.tsx` + the progressive story read these labels, so they must stay total and
    // must agree with the registry — a label edit then lands in exactly one place.
    expect(Object.keys(SELECTION_TOOL_LABEL).sort()).toEqual([...SELECTION_TOOLS].sort())
    // BLIND-AUDIT M15 — these are BUTTON TEXT, so they derive from `shortLabelFor`, not `labelFor`
    // (tooltip prose). Deriving from `label` printed the 47-char sentence "Pan + zoom (scroll to
    // zoom, hold Space or drag to pan)" inside the button and blew it out to 499px.
    expect(SELECTION_TOOL_LABEL.pan).toBe(shortLabelFor('view', 'pan'))
    for (const key of toolKeysForSurface('select')) {
      expect(SELECTION_TOOL_LABEL[key]).toBe(shortLabelFor('select', key))
    }
    // …and a button label must stay SHORT. Tooltip prose in a text button is the defect M15 fixed.
    for (const [tool, text] of Object.entries(SELECTION_TOOL_LABEL)) {
      expect(text.length, `${tool} button label is tooltip-length ("${text}")`).toBeLessThanOrEqual(16)
    }
  })
})
