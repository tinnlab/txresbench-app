// rectEquality.test.ts — the pure half of ITEM-4.
//
// The guard has TWO halves and only one of them is obvious. It must NO-OP when nothing moved (the
// perf half), and it must FIRE on every real layout change (the correctness half). A guard tested
// only on the first half is how a pane silently stops following its rect — and the perf counters in
// this feature would go happily green on exactly that, because "no re-render" is what they reward.
//
// So every case below that returns `prev` is paired with a case that must return `next`.

import { describe, expect, it } from 'vitest'
import type { PaneRect } from '../layers/multiView'
import { RECT_EPSILON_PX, keepRectsIfUnchanged, rectSetsEqual } from './rectEquality'

const r = (id: string, x = 0, y = 0, width = 100, height = 100): PaneRect => ({ id, x, y, width, height })

describe('rect-set equality (ITEM-4)', () => {
  it('a re-measure that found nothing moved compares equal (fresh objects, same geometry)', () => {
    // This is exactly what `measure()` produces: all-new objects describing the same layout.
    const before = [r('a'), r('b', 100)]
    const after = [r('a'), r('b', 100)]
    expect(after[0]).not.toBe(before[0]) // fresh objects…
    expect(rectSetsEqual(before, after)).toBe(true) // …but the same layout
  })

  it('the updater returns the PREVIOUS array identity, so React bails out', () => {
    const prev = [r('a'), r('b', 100)]
    const next = [r('a'), r('b', 100)]
    // `toBe` is the whole point: returning an equal-but-new array would still re-render everything.
    expect(keepRectsIfUnchanged(next)(prev)).toBe(prev)
  })

  it('FIRES on every real change — position, size, count, identity and ORDER', () => {
    const prev = [r('a'), r('b', 100)]
    const cases: [string, PaneRect[]][] = [
      ['moved', [r('a', 5), r('b', 100)]],
      ['resized', [r('a', 0, 0, 120), r('b', 100)]],
      ['taller', [r('a', 0, 0, 100, 140), r('b', 100)]],
      ['pane added', [r('a'), r('b', 100), r('c', 200)]],
      ['pane removed', [r('a')]],
      ['pane renamed', [r('a'), r('z', 100)]],
      // Order mirrors `cells`, so a reorder is a real layout change even with identical geometry.
      ['reordered', [r('b', 100), r('a')]],
    ]
    for (const [label, next] of cases) {
      expect(rectSetsEqual(prev, next), `${label} must NOT compare equal`).toBe(false)
      expect(keepRectsIfUnchanged(next)(prev), `${label} must produce the new array`).toBe(next)
    }
  })

  it('tolerates sub-pixel jitter but not a real sub-pixel move', () => {
    const prev = [r('a')]
    // Fractional layout jitter below the epsilon is not movement — treating it as movement would
    // make the guard a no-op on the continuous-resize path it exists for.
    expect(rectSetsEqual(prev, [r('a', RECT_EPSILON_PX / 2)])).toBe(true)
    // …but anything above it is.
    expect(rectSetsEqual(prev, [r('a', RECT_EPSILON_PX * 2)])).toBe(false)
  })

  // THE PROPERTY THAT MAKES THE TOLERANCE SAFE (FIX_ROUND-2 / A6 + B8, the basis for declining
  // them). Two auditors flagged the 0.5px epsilon: a real layout change smaller than it never
  // reaches `denseRects` → the deck views, `plotInset`, the legend gutter and the export geometry,
  // which stay up to 0.5px behind the DOM. That is TRUE and bounded, and the bound is what this
  // pins: every comparison is against the last COMMITTED array, never the last MEASURED one, so a
  // sequence of sub-epsilon drifts ACCUMULATES against the commit and lands as soon as the total
  // crosses the epsilon. The error can never exceed 0.5px, and it cannot ratchet.
  //
  // The second half of the decline is not testable here because it is a fact about the shell: the
  // pane chrome, the deck viewport (`denseRectsInset`), `legendGutterFor` and the export path all
  // derive from that ONE committed array (`GridWorkspace.tsx`: `insetPane`/`plotInset` take a
  // `PaneRect` from `rects`), so they can be 0.5px behind the DOM but can never disagree with each
  // other — which is what would actually be visible.
  it('sub-epsilon drift ACCUMULATES against the commit and cannot ratchet past the epsilon', () => {
    const step = RECT_EPSILON_PX / 5
    let committed = [r('a')]
    for (let i = 1; i <= 4; i++) {
      const measured = [r('a', step * i)]
      // …still inside the tolerance, so still not committed — the drift is held, not lost.
      expect(rectSetsEqual(committed, measured), `drift of ${step * i}px must not commit`).toBe(true)
      expect(keepRectsIfUnchanged(measured)(committed)).toBe(committed)
    }
    // …and the moment the ACCUMULATED difference from the commit crosses the epsilon, it lands.
    const crossed = [r('a', step * 6)]
    expect(rectSetsEqual(committed, crossed), 'accumulated drift past the epsilon must commit').toBe(false)
    committed = keepRectsIfUnchanged(crossed)(committed)
    expect(committed).toBe(crossed)
  })

  it('handles the empty and identical-reference cases', () => {
    expect(rectSetsEqual([], [])).toBe(true)
    const same = [r('a')]
    expect(rectSetsEqual(same, same)).toBe(true)
    expect(rectSetsEqual([], [r('a')])).toBe(false)
  })
})
