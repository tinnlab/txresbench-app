// visualMapRender.test.ts — the shared visual-map geometry (drives on-screen canvas + export marks).
import { describe, it, expect } from 'vitest'
import { computeVisualMapLayout, visualMapToMarks, yToValue, isStrictSubRange, fmtVal } from './visualMapRender'

const box = { x: 0, y: 0, w: 60, h: 160 }
const domain: [number, number] = [0, 100]
const stops = ['#000004', '#5a167e', '#ba3655', '#fcffa4']

describe('computeVisualMapLayout', () => {
  it('places the HIGH handle above the LOW handle (high value at top)', () => {
    const l = computeVisualMapLayout(box, domain, [25, 75], stops)
    expect(l.handles.yHi).toBeLessThan(l.handles.yLo) // 75 is higher up than 25
    expect(l.band.yTop).toBe(l.handles.yHi)
    expect(l.band.yBot).toBe(l.handles.yLo)
    expect(l.labels.hi.text).toBe('75.00')
    expect(l.labels.lo.text).toBe('25.00')
  })
  it('is LEFT-labelled: the value chips sit to the LEFT of the gradient bar', () => {
    const l = computeVisualMapLayout(box, domain, [25, 75], stops)
    expect(l.labels.hi.x).toBeLessThan(l.bar.x) // label chip is left of the bar
    expect(l.labels.lo.x).toBeLessThan(l.bar.x)
  })
  it('full range → handles at the bar extremities', () => {
    const l = computeVisualMapLayout(box, domain, [0, 100], stops)
    expect(l.handles.yHi).toBeCloseTo(l.bar.y, 1) // top
    expect(l.handles.yLo).toBeCloseTo(l.bar.y + l.bar.h, 1) // bottom
  })
})

describe('yToValue is the inverse of the handle placement', () => {
  it('the handle y maps back to its data value', () => {
    const l = computeVisualMapLayout(box, domain, [30, 80], stops)
    expect(yToValue(l.handles.yHi, domain, l.bar.y, l.bar.h)).toBeCloseTo(80, 3)
    expect(yToValue(l.handles.yLo, domain, l.bar.y, l.bar.h)).toBeCloseTo(30, 3)
  })
  it('clamps out-of-rail y to the domain bounds', () => {
    const l = computeVisualMapLayout(box, domain, [0, 100], stops)
    expect(yToValue(l.bar.y - 999, domain, l.bar.y, l.bar.h)).toBeCloseTo(100, 3) // above top → max
    expect(yToValue(l.bar.y + l.bar.h + 999, domain, l.bar.y, l.bar.h)).toBeCloseTo(0, 3) // below → min
  })
})

describe('visualMapToMarks — the export marks match the geometry', () => {
  it('emits gradient rects + 2 handle polygons + 2 label texts; a sub-range adds dim rects', () => {
    const full = visualMapToMarks(computeVisualMapLayout(box, domain, [0, 100], stops))
    const sub = visualMapToMarks(computeVisualMapLayout(box, domain, [25, 75], stops))
    expect(full.filter(m => m.type === 'polygon').length).toBe(2) // two handles
    expect(full.filter(m => m.type === 'text').length).toBe(2) // two labels
    expect(sub.length).toBeGreaterThan(full.length) // sub-range adds the 2 dim rects
    expect(sub.filter(m => m.type === 'text').map(t => (t as { text: string }).text)).toEqual(
      expect.arrayContaining(['25.00', '75.00']),
    )
  })
})

describe('isStrictSubRange + fmtVal', () => {
  it('detects a strict sub-range', () => {
    expect(isStrictSubRange(domain, [0, 100])).toBe(false)
    expect(isStrictSubRange(domain, [10, 90])).toBe(true)
  })
  it('fmtVal: exponential for large magnitudes, 2dp otherwise', () => {
    expect(fmtVal(50)).toBe('50.00')
    expect(fmtVal(5000)).toBe('5.0e+3')
  })
})
