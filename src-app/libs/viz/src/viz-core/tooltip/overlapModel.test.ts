import { describe, it, expect } from 'vitest'
import { orderByCursor, resolveOverlap, resolveOverlapRow } from './overlapModel'
import { resolveTooltip, type TooltipField } from './tooltipModel'

// A tiny resident column + a field that reads it O(1) (mirrors buildScatterTooltipFields output).
const positions = new Float32Array([
  0, 0, // idx 0 at origin
  1, 0, // idx 1
  0, 2, // idx 2
  3, 0, // idx 3
])
const valueCol = new Float32Array([10, 11, 12, 13])
const fields: TooltipField[] = [
  { key: 'v', label: 'Value', accessor: i => valueCol[i] },
]

describe('orderByCursor', () => {
  it('orders nearest-to-cursor first', () => {
    // cursor at (0,0): distances → idx0=0, idx1=1, idx2=2, idx3=3.
    const ord = Array.from(orderByCursor([3, 2, 1, 0], positions, 0, 0))
    expect(ord).toEqual([0, 1, 2, 3])
  })

  it('breaks ties by index (stable + deterministic across modes)', () => {
    // two points equidistant from the cursor → the lower index comes first.
    const pos = new Float32Array([5, 0, -5, 0])
    const ord = Array.from(orderByCursor([1, 0], pos, 0, 0))
    expect(ord).toEqual([0, 1])
  })
})

describe('resolveOverlap', () => {
  it('resolves only the top-N rows and reports the rest as moreCount', () => {
    const res = resolveOverlap([0, 1, 2, 3], positions, 0, 0, fields, 3)
    expect(res.total).toBe(4)
    expect(res.top).toHaveLength(3)
    expect(res.moreCount).toBe(1)
    // nearest-first: idx0,1,2 → values 10,11,12.
    expect(res.top.map(t => t.rows[0].value)).toEqual(['10', '11', '12'])
    // the full ordered list is available for the dialog.
    expect(Array.from(res.ordered)).toEqual([0, 1, 2, 3])
  })

  it('no "N more" when total <= topN', () => {
    const res = resolveOverlap([0, 1], positions, 0, 0, fields, 3)
    expect(res.top).toHaveLength(2)
    expect(res.moreCount).toBe(0)
  })

  it('is LAZY — builds exactly topN rows, not all', () => {
    let calls = 0
    const countingFields: TooltipField[] = [
      { key: 'v', label: 'Value', accessor: i => { calls++; return valueCol[i] } },
    ]
    resolveOverlap([0, 1, 2, 3], positions, 0, 0, countingFields, 2)
    expect(calls).toBe(2) // only the 2 top rows resolved, not 4
  })

  it('handles an empty overlap set', () => {
    const res = resolveOverlap([], positions, 0, 0, fields, 3)
    expect(res.total).toBe(0)
    expect(res.top).toHaveLength(0)
    expect(res.moreCount).toBe(0)
  })
})

describe('resolveOverlapRow', () => {
  it('matches a single-point resolveTooltip (dialog row == hover tooltip)', () => {
    expect(resolveOverlapRow(2, fields)).toEqual(resolveTooltip(fields, 2))
  })
})
