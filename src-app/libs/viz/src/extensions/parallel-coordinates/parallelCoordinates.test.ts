// parallelCoordinates.test.ts — unit tests for the parallel-coordinates extension's PURE
// parts (per-dimension normalization, axis geometry, the axis-brush → selected-ids logic)
// and its self-registration through the PUBLIC `use()` installer. No deck / DOM: the model
// math runs in node; the registration test drives the same registry the core dispatches on.

import { describe, it, expect } from 'vitest'
import {
  columnExtent,
  normalizeValue,
  axisXPositions,
  nearestAxis,
  pointVertices,
  buildAllVertices,
  idsInAxisBrush,
  clampAxisY,
} from './parallelCoordinatesModel'
import { ParallelCoordinatesChart, parallelCoordinatesDescriptor } from './parallelCoordinates'
import { use } from '../../viz-core/extension'
import { getChartType, hasChartType } from '../../viz-core/registry/registry'

describe('parallel-coordinates model — per-dimension normalization', () => {
  it('columnExtent finds min/max over the first `count` rows, ignoring non-finite', () => {
    const col = new Float32Array([3, 1, 4, 1, 5, 9, Number.NaN, -2])
    expect(columnExtent(col, 6)).toEqual({ min: 1, max: 9 }) // ignores the last two rows
    expect(columnExtent(col)).toEqual({ min: -2, max: 9 }) // full length, NaN skipped
  })

  it('columnExtent collapses an empty / all-non-finite range to {0,0}', () => {
    expect(columnExtent(new Float32Array([Number.NaN, Infinity]))).toEqual({ min: 0, max: 0 })
    expect(columnExtent(new Float32Array([]))).toEqual({ min: 0, max: 0 })
  })

  it('normalizeValue maps min→0, max→1, midpoint→0.5 and clamps out-of-range', () => {
    const ext = { min: 10, max: 20 }
    expect(normalizeValue(10, ext)).toBe(0)
    expect(normalizeValue(20, ext)).toBe(1)
    expect(normalizeValue(15, ext)).toBe(0.5)
    expect(normalizeValue(5, ext)).toBe(0) // clamped
    expect(normalizeValue(25, ext)).toBe(1) // clamped
  })

  it('normalizeValue puts a constant (degenerate) dimension on the midline', () => {
    expect(normalizeValue(7, { min: 7, max: 7 })).toBe(0.5)
    expect(normalizeValue(999, { min: 7, max: 7 })).toBe(0.5)
  })
})

describe('parallel-coordinates model — axis geometry', () => {
  it('axisXPositions places N axes at integer x', () => {
    expect(axisXPositions(4)).toEqual([0, 1, 2, 3])
    expect(axisXPositions(1)).toEqual([0])
    expect(axisXPositions(0)).toEqual([])
  })

  it('nearestAxis snaps to the closest axis within the threshold, else null', () => {
    expect(nearestAxis(0.05, 4)).toBe(0)
    expect(nearestAxis(1.9, 4)).toBe(2)
    expect(nearestAxis(1.5, 4)).toBeNull() // dead-center between axes → outside threshold
    expect(nearestAxis(-1, 4)).toBeNull() // left of axis 0
    expect(nearestAxis(4.0, 4)).toBeNull() // right of the last axis (index 3)
  })

  it('pointVertices / buildAllVertices lay a row across the axes at its normalized values', () => {
    const cols = [new Float32Array([0, 10]), new Float32Array([100, 0])]
    const exts = [
      { min: 0, max: 10 },
      { min: 0, max: 100 },
    ]
    expect(pointVertices(0, cols, exts)).toEqual([
      [0, 0], // dim0: value 0 of [0,10] → 0
      [1, 1], // dim1: value 100 of [0,100] → 1
    ])
    expect(pointVertices(1, cols, exts)).toEqual([
      [0, 1], // dim0: value 10 → 1
      [1, 0], // dim1: value 0 → 0
    ])
    const all = buildAllVertices(cols, exts, 2)
    expect(all).toHaveLength(2)
    expect(all[0]).toHaveLength(2) // one vertex per dimension
  })

  it('clampAxisY holds the drag inside [0,1]', () => {
    expect(clampAxisY(-0.3)).toBe(0)
    expect(clampAxisY(1.4)).toBe(1)
    expect(clampAxisY(0.42)).toBe(0.42)
  })
})

describe('parallel-coordinates model — axis-brush → selected ids (PRODUCE)', () => {
  const col = new Float32Array([0, 1, 2, 3, 4]) // normalized: 0, .25, .5, .75, 1
  const ext = { min: 0, max: 4 }

  it('selects exactly the rows whose normalized value is inside the range', () => {
    expect(Array.from(idsInAxisBrush(col, ext, 0.5, 1, 5))).toEqual([2, 3, 4])
    expect(Array.from(idsInAxisBrush(col, ext, 0, 0.25, 5))).toEqual([0, 1])
  })

  it('sorts the drag endpoints (brush direction does not matter)', () => {
    expect(Array.from(idsInAxisBrush(col, ext, 1, 0.5, 5))).toEqual([2, 3, 4])
  })

  it('respects the rendered `count` (never selects a row past it)', () => {
    expect(Array.from(idsInAxisBrush(col, ext, 0, 1, 3))).toEqual([0, 1, 2])
  })

  it('maps rows → canonical ids through the shared pointIds seam (not raw indices)', () => {
    const pointIds = Uint32Array.from([10, 11, 12, 13, 14])
    expect(Array.from(idsInAxisBrush(col, ext, 0.5, 1, 5, pointIds))).toEqual([12, 13, 14])
  })

  it('a constant dimension: a range covering the midline selects all, otherwise none', () => {
    const flat = new Float32Array([5, 5, 5])
    const flatExt = { min: 5, max: 5 }
    expect(Array.from(idsInAxisBrush(flat, flatExt, 0.4, 0.6, 3))).toEqual([0, 1, 2])
    expect(Array.from(idsInAxisBrush(flat, flatExt, 0.7, 1, 3))).toEqual([])
  })
})

describe('parallel-coordinates — self-registration through use()', () => {
  it('registers the chart type ONLY after use(), with the right descriptor', () => {
    expect(hasChartType('parallel-coordinates')).toBe(false)

    use(ParallelCoordinatesChart)

    const desc = getChartType('parallel-coordinates')
    expect(desc).toBeDefined()
    expect(desc).toBe(parallelCoordinatesDescriptor)
    expect(desc?.coordinateSystem).toBe('chart2d')
    expect(desc?.capabilities?.producesSelection).toBe(true)
    expect(desc?.capabilities?.consumesSelection).toBe(true)

    // The binding schema is a `valueList` `dimensions` channel + a categorical `group`.
    const schema = desc?.bindingSchema ?? []
    expect(schema.map(c => [c.id, c.source])).toEqual([
      ['dimensions', 'valueList'],
      ['group', 'categorical'],
    ])
  })

  it('is idempotent by identity (a second use() does not throw or double-register)', () => {
    use(ParallelCoordinatesChart)
    use(ParallelCoordinatesChart)
    expect(getChartType('parallel-coordinates')).toBe(parallelCoordinatesDescriptor)
  })
})
