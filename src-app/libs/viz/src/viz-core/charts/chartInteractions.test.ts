// chartInteractions.test.ts — unit tests for the PURE volcano/bracket interaction
// helpers (viz-core/charts/chartInteractions.ts). No GL/DOM/React — pure math, so they
// run in node. Covers: threshold classification (up/down/ns), top-N most-significant
// label picking, and significance-bracket geometry.

import { describe, it, expect } from 'vitest'
import { volcanoCategorize, topNLabels, bracketSegments } from './chartInteractions'
import type { VolcanoPoint2D } from './chartInteractions'
import type { Bracket } from '../data/statsKernels'

// ── volcanoCategorize ────────────────────────────────────────────────────────

describe('volcanoCategorize', () => {
  const pts: VolcanoPoint2D[] = [
    { label: 'up', x: 2, y: 3 }, // |x|≥1 and y≥1.3 and x>0 → up
    { label: 'down', x: -2, y: 3 }, // significant, x<0 → down
    { label: 'lowFc', x: 0.5, y: 3 }, // |x|<1 → ns
    { label: 'lowP', x: 2, y: 1 }, // y<1.3 → ns
  ]

  it('classifies up / down / ns against the fold-change + significance thresholds', () => {
    const out = volcanoCategorize(pts, 1, 1.30103)
    expect(out.map(p => p.direction)).toEqual(['up', 'down', 'ns', 'ns'])
  })

  it('is a boundary-inclusive (≥) test on both axes', () => {
    // exactly on both thresholds counts as significant
    const out = volcanoCategorize([{ label: 'edge', x: 1, y: 1.30103 }], 1, 1.30103)
    expect(out[0].direction).toBe('up')
  })

  it('reclassifies when the thresholds move (drag semantics)', () => {
    // raising fc past 2 demotes the |x|=2 points to ns
    const out = volcanoCategorize(pts, 2.5, 1.30103)
    expect(out.map(p => p.direction)).toEqual(['ns', 'ns', 'ns', 'ns'])
  })

  it('preserves label/x/y and treats the fc threshold as its absolute value', () => {
    const out = volcanoCategorize([{ label: 'g', x: -3, y: 5 }], -1, 1.3)
    expect(out[0]).toMatchObject({ label: 'g', x: -3, y: 5, direction: 'down' })
  })
})

// ── topNLabels ───────────────────────────────────────────────────────────────

describe('topNLabels', () => {
  const pts: VolcanoPoint2D[] = [
    { label: 'a', x: 1, y: 2 },
    { label: 'b', x: 1, y: 9 }, // most significant (highest y)
    { label: 'c', x: 1, y: 5 },
    { label: 'd', x: 1, y: 7 },
  ]

  it('picks the n most-significant (highest y) points in descending order', () => {
    const labels = topNLabels(pts, 2)
    expect(labels.map(l => l.text)).toEqual(['b', 'd'])
    expect(labels[0].position).toEqual([1, 9])
  })

  it('breaks y-ties by larger |x|', () => {
    const tied: VolcanoPoint2D[] = [
      { label: 'small', x: 0.5, y: 4 },
      { label: 'big', x: -3, y: 4 },
    ]
    expect(topNLabels(tied, 1)[0].text).toBe('big')
  })

  it('clamps n to the available count and treats n≤0 as none', () => {
    expect(topNLabels(pts, 99)).toHaveLength(4)
    expect(topNLabels(pts, 0)).toEqual([])
    expect(topNLabels(pts, -1)).toEqual([])
  })

  it('skips points with an empty label', () => {
    const labels = topNLabels([{ label: '', x: 0, y: 100 }, { label: 'ok', x: 0, y: 1 }], 2)
    expect(labels.map(l => l.text)).toEqual(['ok'])
  })
})

// ── bracketSegments ──────────────────────────────────────────────────────────

describe('bracketSegments', () => {
  it('emits a horizontal bar + two end ticks + a centered label per bracket', () => {
    const brackets: Bracket[] = [{ i: 0, j: 1, y: 5, label: '*' }]
    const { segments, labels } = bracketSegments(brackets, { spacing: 1, tickDrop: 1, labelDy: 0.5 })
    expect(segments).toHaveLength(3)
    // bar spans the two group centers at height y
    expect(segments[0]).toMatchObject({ source: [0, 5], target: [1, 5] })
    // end ticks drop by tickDrop
    expect(segments[1]).toMatchObject({ source: [0, 5], target: [0, 4] })
    expect(segments[2]).toMatchObject({ source: [1, 5], target: [1, 4] })
    // label centered above the bar
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ text: '*', position: [0.5, 5.5] })
  })

  it('honors spacing (group index → x = index·spacing)', () => {
    const { segments } = bracketSegments([{ i: 1, j: 3, y: 2, label: 'ns' }], { spacing: 2, tickDrop: 0 })
    // x = 1·2 → 3·2 = [2, 6]
    expect(segments[0]).toMatchObject({ source: [2, 2], target: [6, 2] })
  })

  it('normalizes i/j order so the bar always runs low→high', () => {
    const { segments } = bracketSegments([{ i: 3, j: 1, y: 0, label: '**' }], { spacing: 1 })
    expect(segments[0].source[0]).toBe(1)
    expect(segments[0].target[0]).toBe(3)
  })

  it('produces geometry for every bracket (stacked levels preserved via y)', () => {
    const brackets: Bracket[] = [
      { i: 0, j: 1, y: 5, label: '*' },
      { i: 1, j: 2, y: 5, label: 'ns' },
      { i: 0, j: 2, y: 6, label: '**' },
    ]
    const { segments, labels } = bracketSegments(brackets)
    expect(segments).toHaveLength(9) // 3 segments × 3 brackets
    expect(labels.map(l => l.text)).toEqual(['*', 'ns', '**'])
    // the wide bracket sits a level higher (its y is preserved from packBrackets)
    expect(labels[2].position[1]).toBeGreaterThan(labels[0].position[1])
  })

  it('handles an empty bracket set', () => {
    expect(bracketSegments([])).toEqual({ segments: [], labels: [] })
  })
})
