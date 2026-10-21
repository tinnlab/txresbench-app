// controls.test.ts — L0 unit tests for the pure bits of the ECharts-style controls
// (DEC-30): the DragRail pointer→value math, the visualMap deck.gl filter helper, and
// the legend hidden-set toggle/solo logic. Node env (no DOM/GL).

import { describe, it, expect } from 'vitest'
import { railValueAt } from './DragRail'
import { visualMapFilterProps } from './VisualMap'
import { toggleHidden, soloHidden } from './Legend'

describe('railValueAt — pointer → data value (TEST DragRail)', () => {
  const rect = { start: 0, size: 100 } // left=value(min), right=value(max)

  it('maps the endpoints exactly', () => {
    expect(railValueAt(0, rect, 0, 10)).toBe(0)
    expect(railValueAt(100, rect, 0, 10)).toBe(10)
  })

  it('maps the midpoint linearly', () => {
    expect(railValueAt(50, rect, 0, 10)).toBeCloseTo(5)
    expect(railValueAt(25, rect, 2, 6)).toBeCloseTo(3) // 2 + 0.25*(6-2)
  })

  it('clamps out-of-rail positions to the endpoints', () => {
    expect(railValueAt(-40, rect, 0, 10)).toBe(0)
    expect(railValueAt(140, rect, 0, 10)).toBe(10)
  })

  it('handles a negative (bottom-up) axis: start=bottom, size=-height', () => {
    const v = { start: 200, size: -200 } // clientY 200=min(bottom), 0=max(top)
    expect(railValueAt(200, v, 0, 1)).toBe(0)
    expect(railValueAt(0, v, 0, 1)).toBe(1)
    expect(railValueAt(100, v, 0, 1)).toBeCloseTo(0.5)
    expect(railValueAt(300, v, 0, 1)).toBe(0) // below the rail → clamps to min
  })

  it('degenerate zero-size rail returns min', () => {
    expect(railValueAt(50, { start: 0, size: 0 }, 3, 7)).toBe(3)
  })
})

describe('visualMapFilterProps — deck.gl filter shape (TEST VisualMap)', () => {
  it('produces filterRange = [lo,hi] and a filterSize:1 DataFilterExtension', () => {
    const props = visualMapFilterProps([2, 8])
    expect(props.filterRange).toEqual([2, 8])
    expect(props.extensions).toHaveLength(1)
    // the extension carries filterSize:1
    expect((props.extensions[0] as unknown as { opts: { filterSize: number } }).opts.filterSize).toBe(1)
    expect(typeof props.getFilterValue).toBe('function')
  })

  it('normalizes a reversed range so lo ≤ hi', () => {
    expect(visualMapFilterProps([9, 3]).filterRange).toEqual([3, 9])
  })

  it('default getFilterValue passes the point index through', () => {
    const { getFilterValue } = visualMapFilterProps([0, 1])
    expect(getFilterValue(null, { index: 42 })).toBe(42)
  })

  it('honors a supplied getFilterValue accessor', () => {
    const vals = new Float32Array([10, 20, 30])
    const { getFilterValue } = visualMapFilterProps([0, 100], (_d, info) => vals[info.index])
    expect(getFilterValue(null, { index: 1 })).toBe(20)
  })
})

describe('legend hidden-set (TEST Legend)', () => {
  it('toggle adds then removes a code, returning a new set', () => {
    const empty = new Set<number>()
    const afterHide = toggleHidden(empty, 2)
    expect(afterHide).not.toBe(empty)
    expect([...afterHide]).toEqual([2])
    expect(empty.size).toBe(0) // original untouched (pure)

    const afterShow = toggleHidden(afterHide, 2)
    expect([...afterShow]).toEqual([])
  })

  it('solo hides every OTHER category', () => {
    const codes = [0, 1, 2, 3]
    const solo = soloHidden(codes, 1, new Set())
    expect([...solo].sort()).toEqual([0, 2, 3])
  })

  it('solo again on the already-isolated category clears the hidden set', () => {
    const codes = [0, 1, 2, 3]
    const isolated = new Set([0, 2, 3]) // only code 1 visible
    expect([...soloHidden(codes, 1, isolated)]).toEqual([])
  })
})
