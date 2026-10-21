// legendMarks.test.ts — the pure legend→VectorMark builders + scene compose (the export-legend core).

import { describe, it, expect } from 'vitest'
import {
  legendToMarks,
  composeLegendIntoScene,
  LEGEND_MAX_ROWS,
  LEGEND_MAX_COLS,
  type LegendExportSpec,
} from './legendMarks'
import type { VectorScene, VectorRect, VectorText } from './vector'
import type { LegendDescriptor, ColorbarDescriptor } from '../data/color'
import type { Blend2DLegend } from '../data/blend'
import { DARK_THEME, LIGHT_THEME } from '../theme'

const rects = (ms: readonly unknown[]) => ms.filter((m): m is VectorRect => (m as VectorRect).type === 'rect')
const texts = (ms: readonly unknown[]) => ms.filter((m): m is VectorText => (m as VectorText).type === 'text')

describe('legendToMarks — categorical (TEST-1)', () => {
  const d: LegendDescriptor = {
    kind: 'categorical',
    entries: [
      { code: 0, label: 'A', hex: '#112233' },
      { code: 1, label: 'B', hex: '#445566' },
      { code: 2, label: 'C', hex: '#778899' },
    ],
  }
  it('emits one swatch rect per entry (fill === hex) + one label text', () => {
    const { marks, width, height } = legendToMarks({ descriptor: d, title: 'Group' })
    const r = rects(marks)
    const t = texts(marks)
    expect(r).toHaveLength(3)
    expect(r.map(x => x.fill)).toEqual(['#112233', '#445566', '#778899'])
    // labels + the title
    expect(t.map(x => x.text)).toEqual(expect.arrayContaining(['Group', 'A', 'B', 'C']))
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    // rows stack downward (monotonic y for the swatches)
    expect(r[1].y).toBeGreaterThan(r[0].y)
  })

  it('threads the typography FONT into the exported legend (WYSIWYG parity)', () => {
    const { marks } = legendToMarks({ descriptor: d, title: 'Group', font: { titleSize: 20, labelSize: 16, family: 'Inter' } })
    const t = texts(marks)
    expect(t.every(x => x.fontFamily === 'Inter')).toBe(true) // family applied to title + labels
    const title = t.find(x => x.text === 'Group')!
    const label = t.find(x => x.text === 'A')!
    expect(title.size).toBe(20)
    expect(label.size).toBe(16)
    // without a font, marks carry no fontFamily (byte-identical to before)
    const plain = texts(legendToMarks({ descriptor: d, title: 'Group' }).marks)
    expect(plain.every(x => x.fontFamily === undefined)).toBe(true)
  })
})

describe('legendToMarks — continuous colorbar (TEST-2)', () => {
  const d: ColorbarDescriptor = {
    kind: 'continuous',
    colormap: 'viridis',
    domain: [0, 100],
    stops: ['#000004', '#5a167e', '#ba3655', '#fcffa4'],
  }
  it('emits the visual-map slider — stepped gradient stops + handle labels at the domain bounds + title', () => {
    const { marks } = legendToMarks({ descriptor: d, title: 'QC' })
    const r = rects(marks)
    // one segment per stop (the gradient bar)
    const fills = r.map(x => x.fill).filter(Boolean)
    expect(fills).toEqual(expect.arrayContaining(d.stops as string[]))
    // full-range handles sit at the domain min/max → labels '0.00' and '100.00' (fmtVal 2dp)
    const t = texts(marks).map(x => x.text)
    expect(t).toEqual(expect.arrayContaining(['QC', '0.00', '100.00']))
  })
  it('threads the typography font family into the colorbar title + value labels', () => {
    const t = texts(legendToMarks({ descriptor: d, title: 'QC', font: { family: 'Inter' } }).marks)
    expect(t.every(x => x.fontFamily === 'Inter')).toBe(true)
  })
})

describe('legendToMarks — blend 2D (TEST-3)', () => {
  const d: Blend2DLegend = {
    kind: 'blend',
    channel: 'lightness',
    alphaFloor: 0.1,
    perGroupDomain: true,
    valueDomain: [0, 1],
    rows: [
      { code: 0, label: 'c1', hex: '#3366cc' },
      { code: 1, label: 'c2', hex: '#cc3366' },
    ],
  }
  it('emits a hue-row × ramp grid (rows × steps rects) + row labels + a low/high axis', () => {
    const { marks } = legendToMarks({ descriptor: d, title: 'blend' })
    const r = rects(marks)
    // 2 rows × N ramp steps ⇒ many rects, a multiple of 2
    expect(r.length).toBeGreaterThanOrEqual(2 * 8)
    const t = texts(marks).map(x => x.text)
    expect(t).toEqual(expect.arrayContaining(['c1', 'c2']))
    expect(t.some(s => s.startsWith('low'))).toBe(true)
    expect(t.some(s => s.startsWith('high'))).toBe(true)
    // ramp within a row goes dim→hex (last step of row 0 is the full hue)
    expect(r.some(x => x.fill?.toLowerCase() === '#3366cc')).toBe(true)
  })
})

describe('composeLegendIntoScene (TEST-4)', () => {
  const scene: VectorScene = { width: 200, height: 150, marks: [{ type: 'image', x: 0, y: 0, w: 200, h: 150, href: 'x' }] }
  const legend = legendToMarks({
    descriptor: { kind: 'categorical', entries: [{ code: 0, label: 'A', hex: '#111111' }] },
  })
  it('places the legend at the corner WITHOUT resizing the figure, and does NOT mutate the input', () => {
    const before = JSON.stringify(scene)
    const out = composeLegendIntoScene(scene, legend, { corner: 'tr', beside: false })
    expect(out.width).toBe(scene.width) // no gutter growth — the plot region was already sized by the caller
    expect(out.height).toBe(scene.height)
    // a top-RIGHT overlay: appended = a readability box + the legend marks, offset toward the right edge
    const appended = out.marks.slice(scene.marks.length) as (VectorRect | VectorText)[]
    expect(appended.length).toBe(legend.marks.length + 1) // +1 readability box
    expect(JSON.stringify(scene)).toBe(before) // input untouched
  })
  it('overlay draws a readability box behind the legend; beside does not', () => {
    const overlay = composeLegendIntoScene(scene, legend, { corner: 'tl', beside: false })
    const beside = composeLegendIntoScene(scene, legend, { corner: 'tl', beside: true })
    expect(overlay.marks.length).toBe(beside.marks.length + 1) // the box is the extra mark
    const box = overlay.marks[scene.marks.length] as VectorRect
    expect(box.type).toBe('rect')
    expect(box.fill).toBe('rgba(255,255,255,0.82)')
  })
  it('an empty legend is a no-op passthrough', () => {
    const out = composeLegendIntoScene(scene, { marks: [], width: 0, height: 0 })
    expect(out).toBe(scene)
  })
})

describe('legendToMarks — theme-aware chrome (TEST-5)', () => {
  const d: LegendDescriptor = { kind: 'categorical', entries: [{ code: 0, label: 'A', hex: '#ff0000' }] }
  it('data color from the descriptor; label text color from the theme', () => {
    const light = legendToMarks({ descriptor: d }, LIGHT_THEME)
    const dark = legendToMarks({ descriptor: d }, DARK_THEME)
    // swatch fill is the DATA color regardless of theme
    expect(rects(light.marks)[0].fill).toBe('#ff0000')
    expect(rects(dark.marks)[0].fill).toBe('#ff0000')
    // label text color tracks the theme fg (differs light vs dark)
    const lLabel = texts(light.marks).find(t => t.text === 'A')!
    const dLabel = texts(dark.marks).find(t => t.text === 'A')!
    expect(lLabel.fill).toBe(LIGHT_THEME.fg)
    expect(dLabel.fill).toBe(DARK_THEME.fg)
    expect(lLabel.fill).not.toBe(dLabel.fill)
  })
})

describe('WYSIWYG live state — range window + hidden (TEST-14)', () => {
  const cb: ColorbarDescriptor = {
    kind: 'continuous',
    colormap: 'viridis',
    domain: [0, 100],
    stops: ['#000004', '#5a167e', '#ba3655', '#fcffa4'],
  }
  it('the slider draws the SELECTED band + handle labels at [lo,hi]; a sub-range dims out-of-range', () => {
    const full = legendToMarks({ descriptor: cb, title: 'QC' })
    const windowed = legendToMarks({ descriptor: cb, title: 'QC', range: [25, 75] })
    // a strict sub-range adds the two dim rects (out-of-range above + below the band)
    expect(windowed.marks.length).toBeGreaterThan(full.marks.length)
    // the exported slider's HANDLE labels show the selected bounds (fmtVal → 2dp for < 1000)
    expect(texts(windowed.marks).map(t => t.text)).toEqual(expect.arrayContaining(['25.00', '75.00']))
    // handles are drawn as triangle polygons (two, one per bound)
    const polys = windowed.marks.filter(m => m.type === 'polygon')
    expect(polys.length).toBe(2)
    // a full-domain range (handles at top+bottom) adds no dim rects — same count as no-range
    expect(legendToMarks({ descriptor: cb, range: [0, 100] }).marks.length).toBe(legendToMarks({ descriptor: cb }).marks.length)
  })
  it('a hidden category is GREYED (muted swatch), a shown one keeps its data color', () => {
    const d: LegendDescriptor = {
      kind: 'categorical',
      entries: [
        { code: 0, label: 'A', hex: '#ff0000' },
        { code: 1, label: 'B', hex: '#00ff00' },
      ],
    }
    const r = rects(legendToMarks({ descriptor: d, hidden: [1] }).marks)
    expect(r[0].fill).toBe('#ff0000') // shown
    expect(r[1].fill).toBe(LIGHT_THEME.muted) // hidden → muted
  })
})

describe('robustness (F3/F4 audit fixes)', () => {
  it('a malformed/empty hex never produces "#NaN…" (F3)', () => {
    const d: Blend2DLegend = {
      kind: 'blend',
      channel: 'lightness',
      alphaFloor: 0.1,
      perGroupDomain: true,
      valueDomain: [0, 1],
      rows: [{ code: 0, label: 'x', hex: 'not-a-hex' }],
    }
    const { marks } = legendToMarks({ descriptor: d })
    expect(rects(marks).every(r => !/nan/i.test(r.fill ?? ''))).toBe(true)
  })
  it('a legend wider than the plot is clamped on-canvas (x ≥ 0) at a right corner (F4)', () => {
    const scene: VectorScene = { width: 40, height: 40, marks: [] }
    const legend = legendToMarks({
      descriptor: { kind: 'categorical', entries: [{ code: 0, label: 'a-very-wide-label', hex: '#111111' }] },
    })
    const out = composeLegendIntoScene(scene, legend, { corner: 'tr', beside: false })
    expect((out.marks as (VectorRect | VectorText)[]).every(m => (m as VectorRect).x >= 0)).toBe(true)
  })
})

describe('legendToMarks — categorical cardinality cap (TEST-9)', () => {
  it('caps many entries with a "+N more" text and a bounded gutter width', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ code: i, label: `g${i}`, hex: '#010203' }))
    const spec: LegendExportSpec = { descriptor: { kind: 'categorical', entries } }
    const { marks, width } = legendToMarks(spec)
    expect(texts(marks).some(t => /\+\d+ more/.test(t.text))).toBe(true)
    // width bounded by the max columns (never 200 stacked swatches wide/tall)
    expect(rects(marks).length).toBeLessThanOrEqual(LEGEND_MAX_ROWS * LEGEND_MAX_COLS)
    expect(width).toBeLessThanOrEqual(LEGEND_MAX_COLS * 120)
  })
})
