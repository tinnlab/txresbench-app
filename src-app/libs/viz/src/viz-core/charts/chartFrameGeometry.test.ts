// chartFrameGeometry.test.ts — unit tests for the pure ChartFrame geometry (ITEM-17). No
// deck.gl / GL / DOM — asserts the data-space segments + labels the frame emits.

import { describe, it, expect } from 'vitest'
import { buildChartFrameGeometry } from './chartFrameGeometry'
import { categoryTicks } from './axisTicks'

describe('buildChartFrameGeometry', () => {
  const bounds: [number, number, number, number] = [0, 0, 10, 100]

  it('emits exactly two axis lines along the left + bottom edges', () => {
    const g = buildChartFrameGeometry({ bounds })
    expect(g.axis).toHaveLength(2)
    // bottom x-axis along y = yMin
    expect(g.axis[0]).toEqual({ source: [0, 0], target: [10, 0] })
    // left y-axis along x = xMin
    expect(g.axis[1]).toEqual({ source: [0, 0], target: [0, 100] })
  })

  it('places tick marks + tick labels for both value axes', () => {
    const g = buildChartFrameGeometry({ bounds })
    // one tick mark + one tick label per resolved tick
    expect(g.ticks.length).toBe(g.tickLabels.length)
    expect(g.tickLabels.length).toBeGreaterThan(0)
    // an x tick label sits on the bottom axis, nudged below it
    const xLabel = g.tickLabels.find(l => l.baseline === 'top' && l.anchor === 'middle')
    expect(xLabel).toBeTruthy()
    expect(xLabel!.pixelOffset[1]).toBeGreaterThan(0)
    // a y tick label sits on the left axis, nudged left
    const yLabel = g.tickLabels.find(l => l.baseline === 'center' && l.anchor === 'end')
    expect(yLabel).toBeTruthy()
    expect(yLabel!.pixelOffset[0]).toBeLessThan(0)
  })

  it('emits dashed gridlines when showGrid (default), none when off', () => {
    const on = buildChartFrameGeometry({ bounds })
    expect(on.grid.length).toBeGreaterThan(0)
    // dashed → many short segments, not one line per tick
    expect(on.grid.length).toBeGreaterThan(on.tickLabels.length)
    const off = buildChartFrameGeometry({ bounds, showGrid: false })
    expect(off.grid).toHaveLength(0)
  })

  it('emits centered x/y titles, with the y-title rotated vertical', () => {
    const g = buildChartFrameGeometry({ bounds, xTitle: 'Value', yTitle: 'Count' })
    expect(g.titles).toHaveLength(2)
    const x = g.titles.find(t => t.text === 'Value')!
    const y = g.titles.find(t => t.text === 'Count')!
    expect(x.position[0]).toBeCloseTo(5) // centered on x span
    expect(x.angle).toBe(0)
    expect(y.position[1]).toBeCloseTo(50) // centered on y span
    expect(y.angle).toBe(90) // vertical
  })

  it('honors an explicit category tick spec on x', () => {
    const g = buildChartFrameGeometry({
      bounds: [-0.6, 0, 2.6, 50],
      xTicks: categoryTicks(['A', 'B', 'C']),
    })
    const labels = g.tickLabels.filter(l => ['A', 'B', 'C'].includes(l.text))
    expect(labels.map(l => l.text)).toEqual(['A', 'B', 'C'])
    // category ticks land at integer centers
    expect(labels.map(l => l.position[0])).toEqual([0, 1, 2])
  })

  it('skips ticks outside the bounds', () => {
    const g = buildChartFrameGeometry({
      bounds: [0, 0, 2, 10],
      xTicks: [
        { pos: -5, label: 'off-lo' },
        { pos: 1, label: 'in' },
        { pos: 99, label: 'off-hi' },
      ],
    })
    const texts = g.tickLabels.map(l => l.text)
    expect(texts).toContain('in')
    expect(texts).not.toContain('off-lo')
    expect(texts).not.toContain('off-hi')
  })
})
