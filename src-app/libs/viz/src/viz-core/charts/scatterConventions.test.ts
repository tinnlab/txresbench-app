import { describe, it, expect } from 'vitest'
import { pointSizeForCount, cornerArrowAxes } from './scatterConventions'

describe('pointSizeForCount (ITEM-22)', () => {
  it('decreases monotonically as count grows', () => {
    const a = pointSizeForCount(100)
    const b = pointSizeForCount(10_000)
    const c = pointSizeForCount(1_000_000)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })
  it('clamps to the usable range', () => {
    expect(pointSizeForCount(1)).toBeLessThanOrEqual(6)
    expect(pointSizeForCount(1e9)).toBeGreaterThanOrEqual(1)
  })
})

describe('cornerArrowAxes (ITEM-22)', () => {
  it('emits an X arrow pointing right and a Y arrow pointing up', () => {
    const [x, y] = cornerArrowAxes(10, 200, 40)
    expect(x).toMatchObject({ x1: 10, y1: 200, x2: 50, y2: 200, label: 'UMAP1' })
    expect(y).toMatchObject({ x1: 10, y1: 200, x2: 10, y2: 160, label: 'UMAP2' }) // up = smaller y
  })
  it('accepts custom labels', () => {
    expect(cornerArrowAxes(0, 0, 10, ['tSNE1', 'tSNE2'])[0].label).toBe('tSNE1')
  })
})
