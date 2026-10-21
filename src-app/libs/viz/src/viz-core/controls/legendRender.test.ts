// legendRender.test.ts — the shared categorical-legend geometry (screen + export share it).
import { describe, it, expect } from 'vitest'
import { computeLegendLayout, legendLayoutToMarks, legendHitTest, COL_W, ROW_H, SWATCH, LEGEND_MAX_ENTRIES } from './legendRender'
import type { VectorRect, VectorText } from '../export/vector'
import { DARK_THEME, LIGHT_THEME } from '../theme'

const box = { x: 0, y: 0, w: 0, h: 0 }
const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ code: i, label: `g${i}`, hex: '#112233' }))

describe('computeLegendLayout', () => {
  it('places swatches down a column then wraps at LEGEND_MAX_ROWS', () => {
    const lay = computeLegendLayout(box, entries(20), new Set(), 'Group')
    // title offsets the first swatch down; items stack by ROW_H, wrap to col 2 after 16
    expect(lay.items).toHaveLength(20)
    expect(lay.items[1].y - lay.items[0].y).toBe(ROW_H)
    expect(lay.items[16].x).toBe(COL_W) // 17th entry → second column
    expect(lay.items[16].y).toBe(lay.items[0].y) // back to the top row
    expect(lay.width).toBe(2 * COL_W)
  })
  it('caps at 48 with a "+N more"', () => {
    const lay = computeLegendLayout(box, entries(200), new Set())
    expect(lay.items).toHaveLength(LEGEND_MAX_ENTRIES - 1) // 47 shown
    expect(lay.more?.text).toMatch(/\+\d+ more/)
  })
  it('marks a hidden code on its item', () => {
    const lay = computeLegendLayout(box, entries(3), new Set([1]))
    expect(lay.items.map(i => i.hidden)).toEqual([false, true, false])
  })
})

describe('legendHitTest', () => {
  it('returns the code whose row contains (x,y), else null', () => {
    const lay = computeLegendLayout(box, entries(3), new Set())
    const it0 = lay.items[0]
    expect(legendHitTest(lay, it0.x + 2, it0.y + 2)).toBe(0)
    expect(legendHitTest(lay, it0.x + COL_W - 1, it0.y + ROW_H - 1)).toBe(0)
    expect(legendHitTest(lay, it0.x - 5, it0.y)).toBeNull()
  })
})

describe('legendLayoutToMarks (export == on-screen geometry)', () => {
  it('emits a swatch rect (data color) + label text per entry; hidden greys both', () => {
    const lay = computeLegendLayout(box, entries(2), new Set([1]), 'G')
    const marks = legendLayoutToMarks(lay, LIGHT_THEME)
    const rects = marks.filter((m): m is VectorRect => m.type === 'rect')
    const texts = marks.filter((m): m is VectorText => m.type === 'text')
    expect(rects).toHaveLength(2)
    expect(rects[0].w).toBe(SWATCH)
    expect(rects[0].fill).toBe('#112233') // shown → data color
    expect(rects[1].fill).toBe(LIGHT_THEME.muted) // hidden → greyed
    expect(texts.map(t => t.text)).toEqual(expect.arrayContaining(['G', 'g0', 'g1']))
  })
  it('is RIGHT-ALIGNED: label text is anchored end, to the LEFT of its swatch', () => {
    const lay = computeLegendLayout(box, entries(1), new Set(), 'G')
    const marks = legendLayoutToMarks(lay, LIGHT_THEME)
    const rect = marks.find((m): m is VectorRect => m.type === 'rect')!
    const label = marks.find((m): m is VectorText => m.type === 'text' && m.text === 'g0')!
    const title = marks.find((m): m is VectorText => m.type === 'text' && m.text === 'G')!
    expect(label.anchor).toBe('end') // right-anchored label
    expect(title.anchor).toBe('end') // right-anchored title
    expect(label.x).toBeLessThanOrEqual(rect.x) // text sits to the LEFT of the swatch
    expect(rect.x + SWATCH).toBeLessThanOrEqual(lay.box.x + lay.width + 0.001) // swatch hugs the right edge
  })
  it('label text color tracks the theme (light≠dark)', () => {
    const l = legendLayoutToMarks(computeLegendLayout(box, entries(1), new Set()), LIGHT_THEME)
    const d = legendLayoutToMarks(computeLegendLayout(box, entries(1), new Set()), DARK_THEME)
    const lt = (l.find(m => m.type === 'text') as VectorText).fill
    const dt = (d.find(m => m.type === 'text') as VectorText).fill
    expect(lt).toBe(LIGHT_THEME.fg)
    expect(dt).toBe(DARK_THEME.fg)
    expect(lt).not.toBe(dt)
  })
})

// ── the PROVENANCE NOTE leg (ziee visualize-pane ITEM-19 / DEC-13) ───────────────────────────────
//
// The legend is the load-bearing surface for a marker that has to survive leaving the app: a
// screenshot crops the pane chrome and keeps the legend. These assert the two properties that make
// that true — the note is laid out from the SAME geometry both surfaces read, and adding one does
// not move a single swatch (so an unrelated control's click targets cannot shift under it).
describe('legend provenance note', () => {
  const NOTE = 'alignment not declared'

  it('adds ONE line under the entries and moves no item', () => {
    const without = computeLegendLayout(box, entries(5), new Set(), 'Group')
    const withNote = computeLegendLayout(box, entries(5), new Set(), 'Group', 'right', NOTE)
    expect(withNote.items).toEqual(without.items)
    expect(withNote.width).toBe(without.width)
    expect(withNote.height).toBeGreaterThan(without.height)
    expect(withNote.note?.text).toBe(NOTE)
    // BELOW the last row — the whole reason the items are untouched.
    expect(withNote.note!.y).toBeGreaterThan(without.items[without.items.length - 1].y)
  })

  it('is absent for an omitted / empty / whitespace note (byte-identical geometry)', () => {
    const base = computeLegendLayout(box, entries(4), new Set(), 'Group')
    for (const n of [undefined, '', '   \n\t ']) {
      const lay = computeLegendLayout(box, entries(4), new Set(), 'Group', 'right', n)
      expect(lay.note).toBeUndefined()
      expect(lay.height).toBe(base.height)
      expect(lay.items).toEqual(base.items)
    }
  })

  it('leaves the hit test byte-identical', () => {
    const a = computeLegendLayout(box, entries(6), new Set(), 'Group')
    const b = computeLegendLayout(box, entries(6), new Set(), 'Group', 'right', NOTE)
    for (const it of a.items) {
      expect(legendHitTest(b, it.x + 2, it.y + 2)).toBe(legendHitTest(a, it.x + 2, it.y + 2))
    }
  })

  it('travels into the EXPORT marks — the leg that makes it survive a screenshot', () => {
    const lay = computeLegendLayout(box, entries(3), new Set(), 'Group', 'right', NOTE)
    const texts = legendLayoutToMarks(lay).filter((m): m is VectorText => m.type === 'text')
    expect(texts.some(t => t.text === NOTE)).toBe(true)
    // …and is NOT emitted when there is no note.
    const plain = legendLayoutToMarks(computeLegendLayout(box, entries(3), new Set(), 'Group'))
    expect(plain.filter((m): m is VectorText => m.type === 'text').some(t => t.text === NOTE)).toBe(false)
  })

  it('anchors with the title on both swatch sides', () => {
    const right = computeLegendLayout(box, entries(3), new Set(), 'Group', 'right', NOTE)
    const left = computeLegendLayout(box, entries(3), new Set(), 'Group', 'left', NOTE)
    expect(right.note!.x).toBe(box.x + right.width)
    expect(left.note!.x).toBe(box.x)
  })
})
