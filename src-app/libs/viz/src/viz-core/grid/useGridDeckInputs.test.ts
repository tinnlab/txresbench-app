// useGridDeckInputs.test.ts — TEST-52 [acceptance] (INV-10), RESTATED onto the surface that
// actually renders (owner, 2026-08-16; DRIFT-1.50).
//
// ── WHY THE FILE TESTS.md NAMED WAS THE WRONG ONE ──────────────────────────────────────────────
//
// TEST-52 was written against `viz-core/density/cpuRasterClient.test.ts`. `cpuRasterClient` is NOT
// on the grid path: the grid draws dense cells through the shared deck — `useGridDeckInputs` →
// `SelectableScatterLayer` over `cellData(cell).positions` — and `CategoricalPointsView` /
// `CpuRasterView` are exported from neither barrel and rendered only by showcase stories. A test
// there would have asserted the mixed-arrival contract about a surface no user reaches, which is
// the same restatement TEST-11 needed for the same reason (DRIFT-1.44).
//
// ── WHAT THE MIXED STATE ACTUALLY IS, AT THIS SEAM ─────────────────────────────────────────────
//
// `useGridData.ts` sets `nPoints = pos.length / 2` — from the PARTIAL positions buffer — while the
// colour buffer is COMPLETE (ITEM-10 form (a) synthesizes it from `catalog.pointCount`) and the
// value-range legend's `values` are the COMPLETE column, landed wholesale by `$data`. The value-
// range filter then indexes all three by the same `i`. That is the ONE place on the grid path
// where a partial buffer and a complete buffer are indexed against each other, and it is exactly
// INV-10's restated hazard: if the offsets disagree, the right points are shaded the WRONG colour
// and the picture stays plausible with a clean console.
//
// ── WHAT THESE CASES DO WHEN THE DEFECT IS PRESENT ─────────────────────────────────────────────
//
// Each asserts against an INDEPENDENT oracle computed from the values array, never against the
// function's own answer, and the offset control is the one TESTS.md names: a deliberately shifted
// values array must go RED. A case that only checked "some points were masked" would pass with
// every row shifted by one, which is the defect.
//
// ── WHAT THIS FILE DOES *NOT* COVER (T4, owner audit — restated rather than over-claimed) ──────
//
// `applyValueRangeMask` takes `nPoints` as a PARAMETER. The real hazard named in the paragraphs
// above — `nPoints` DERIVED from the partial positions buffer (`useGridData.ts`:
// `const nPoints = positions.length / 2`) while `colors` is sized from `catalog.pointCount` — is
// upstream of this seam and is therefore NOT exercised here: this file supplies `nPoints` itself.
//
// Two mutations prove the boundary. Changing the loop bound to `colors.length / 4`, and changing
// `vals[i]` to `vals[i + 1]`, each turn ONLY leg (a) + its negative control red; legs (b) and (c)
// stay green through both. So (a) is the discriminating case, and (b)/(c) are restated below to
// claim only the properties they actually measure — stability and immediacy of the MASK GIVEN an
// `nPoints`, not the correctness of the derivation that produces it.
//
// UNCOVERED, deliberately: a hook-level test of `useGridData`'s `nPoints` derivation. Closing it
// needs a React hook harness (`renderHook` + `GridWorkspaceContext`), which does not exist
// anywhere under `libs/viz` today. Recorded here rather than faked with a re-implementation of
// `positions.length / 2` inside the test, which would assert the formula against itself.

import { describe, expect, it } from 'vitest'
import { applyValueRangeMask } from './useGridDeckInputs'

/** The whole row space. `2 × 8192 + 137` — strictly above the store's `POSITIONS_ROWS_PER_BATCH`,
 *  so a fixture that filled in one step could not produce the partial states below (DRIFT-1.33's
 *  trap, applied here), and the trailing 137 is the FINAL SHORT BATCH TESTS.md asks for. */
const TOTAL = 2 * 8192 + 137

/** A value per row, distinct enough that an off-by-one is observable at every index. */
function values(n: number): Float32Array {
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) v[i] = i
  return v
}

/** A COMPLETE colour buffer, RGBA per row, alpha 255 everywhere — so any alpha 0 in a result was
 *  put there by the filter and by nothing else. The R channel carries the row index (mod 256) so a
 *  reordered buffer is detectable, not just a re-alpha'd one. */
function colours(n: number): Uint8Array {
  const c = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    c[i * 4] = i % 256
    c[i * 4 + 1] = 7
    c[i * 4 + 2] = 11
    c[i * 4 + 3] = 255
  }
  return c
}

/** THE ORACLE. Which rows the filter must hide, computed from the values array directly — never
 *  from the function under test. */
function expectedHidden(vals: Float32Array, nPoints: number, lo: number, hi: number): number[] {
  const out: number[] = []
  for (let i = 0; i < nPoints; i++) if (vals[i] < lo || vals[i] > hi) out.push(i)
  return out
}

function hiddenRows(colors: Uint8Array, upTo: number): number[] {
  const out: number[] = []
  for (let i = 0; i < upTo; i++) if (colors[i * 4 + 3] === 0) out.push(i)
  return out
}

const DOMAIN: [number, number] = [0, TOTAL - 1]

describe('TEST-52 [acceptance] (INV-10) — row i is the same cell in every channel under MIXED arrival', () => {
  it('(a) PARTIAL positions beside a COMPLETE colour + values buffer masks exactly the arrived rows', () => {
    const vals = values(TOTAL)
    // One batch has landed; the colour buffer and the column are whole. This is the state slice B
    // newly creates and the one C2's departure did not remove.
    const arrived = 8192
    const lo = 1000
    const hi = 5000
    const { colors, filterKey } = applyValueRangeMask({
      colors: colours(TOTAL),
      nPoints: arrived,
      epoch: 3,
      legend: { values: vals, domain: DOMAIN },
      range: [lo, hi],
    })
    // Non-vacuity: the state really is partial and the filter really is active.
    expect(arrived).toBeLessThan(TOTAL)
    expect(filterKey).toBe(`3:${lo}:${hi}`)

    expect(hiddenRows(colors, arrived)).toEqual(expectedHidden(vals, arrived, lo, hi))
    // …and the rows that have NOT arrived are untouched: the helper must never reach past the
    // prefix, because those rows are not drawn and their colours are not its business.
    expect(hiddenRows(colors.subarray(arrived * 4), TOTAL - arrived)).toEqual([])
  })

  it('(a) NEGATIVE CONTROL — a values array OFFSET by one row must turn it RED', () => {
    const vals = values(TOTAL)
    const arrived = 8192
    const lo = 1000
    const hi = 5000
    // The defect this whole test exists for: the same NUMBER of points is hidden and the plot still
    // renders, but every hidden row is the wrong cell. A "something was masked" assertion passes.
    const offset = new Float32Array(TOTAL)
    offset.set(vals.subarray(1))
    offset[TOTAL - 1] = TOTAL - 1
    const { colors } = applyValueRangeMask({
      colors: colours(TOTAL),
      nPoints: arrived,
      epoch: 1,
      legend: { values: offset, domain: DOMAIN },
      range: [lo, hi],
    })
    const truth = expectedHidden(vals, arrived, lo, hi)
    const got = hiddenRows(colors, arrived)
    // Same COUNT — which is why a count-tolerant assertion would have absorbed this — different SET.
    expect(got.length).toBe(truth.length)
    expect(got).not.toEqual(truth)
  })

  // (b) RESTATED (T4): this measures that the MASK is a pure function of the global row index for
  // any GIVEN `nPoints` — it does not measure where `nPoints` comes from (see the file header).
  it('(b) for a GIVEN arrived-row count, the mask is indexed by GLOBAL row — every prefix agrees with the whole', () => {
    const vals = values(TOTAL)
    const lo = 1000
    const hi = 5000
    const args = { epoch: 0, legend: { values: vals, domain: DOMAIN }, range: [lo, hi] as const }
    // Positions and colour now share ONE source (DEC-20 / ITEM-42), so they agree by construction.
    // What that CLAIM has to mean at the drawing seam is this: the answer for row i is the same at
    // every arrival step. A batch boundary deliberately NOT aligned with the colour buffer's
    // chunking (8191, and the final short batch) is included, because an implementation that
    // indexed by batch rather than by global row would agree only on aligned boundaries.
    const whole = applyValueRangeMask({ colors: colours(TOTAL), nPoints: TOTAL, ...args }).colors
    for (const arrived of [1, 8191, 8192, 8193, 2 * 8192, TOTAL]) {
      const prefix = applyValueRangeMask({ colors: colours(TOTAL), nPoints: arrived, ...args }).colors
      expect(
        Array.from(prefix.subarray(0, arrived * 4)),
        `prefix of ${arrived} rows disagrees with the settled buffer`,
      ).toEqual(Array.from(whole.subarray(0, arrived * 4)))
    }
    // Non-vacuity: the settled buffer really did hide something, so the equality above is not an
    // agreement between two untouched buffers.
    expect(hiddenRows(whole, TOTAL).length).toBeGreaterThan(0)
  })

  // (c) RESTATED (T4): this measures that a COMPLETE legend is applied at `nPoints = 1` rather
  // than deferred until the row space fills. It does not measure that `nPoints` was itself
  // derived from a partial positions buffer — that value is supplied here (see the file header).
  it('(c) a COMPLETE keep-set is applied at an arrived-count of ONE, not deferred', () => {
    const vals = values(TOTAL)
    // The leg that survives ITEM-42's unification: `$data` still LANDS wholesale, so the keep-set
    // is derived from complete columns while positions stream. The filter must apply immediately
    // rather than wait for the row space — a criterion that silently does nothing while data
    // arrives is the permissive answer this branch refuses everywhere else.
    const { colors, filterKey } = applyValueRangeMask({
      colors: colours(TOTAL),
      nPoints: 1,
      epoch: 9,
      legend: { values: vals, domain: DOMAIN },
      range: [1000, 5000],
    })
    expect(filterKey).toBe('9:1000:5000')
    expect(hiddenRows(colors, 1)).toEqual([0]) // row 0's value is 0, outside [1000, 5000]
  })

  it('(c) a values array SHORTER than the arrived rows is refused WHOLESALE, not applied partially', () => {
    // A stale legend from a previously-bound column. Applying it to the rows it happens to cover
    // would shade part of the plot by one column and part by another — the same "row i means two
    // different cells" failure, arriving from the legend side instead of the positions side.
    const arrived = 8192
    const { colors, filterKey } = applyValueRangeMask({
      colors: colours(TOTAL),
      nPoints: arrived,
      epoch: 4,
      legend: { values: values(arrived - 1), domain: DOMAIN },
      range: [1000, 5000],
    })
    expect(hiddenRows(colors, arrived)).toEqual([])
    expect(filterKey).toBe(4) // the epoch, i.e. no fill re-upload — the untouched path
  })

  it('an inactive range returns the buffer ITSELF, not a copy — the byte-identical no-filter path', () => {
    const buffer = colours(TOTAL)
    const { colors, filterKey } = applyValueRangeMask({
      colors: buffer,
      nPoints: 4096,
      epoch: 12,
      legend: { values: values(TOTAL), domain: DOMAIN },
      // the full domain: not a strict sub-range, so nothing is filtered
      range: DOMAIN,
    })
    // Identity. A copy here would re-upload the fill on every frame for a filter that hides nothing.
    expect(colors).toBe(buffer)
    expect(filterKey).toBe(12)
  })

  it('the cached colour buffer is NEVER mutated', () => {
    const buffer = colours(TOTAL)
    const before = Array.from(buffer)
    applyValueRangeMask({
      colors: buffer,
      nPoints: TOTAL,
      epoch: 0,
      legend: { values: values(TOTAL), domain: DOMAIN },
      range: [1000, 5000],
    })
    // The buffer is shared with the store and with every other cell bound to the same dataset, so
    // an in-place mask would leak one cell's visualMap into its neighbours.
    expect(Array.from(buffer)).toEqual(before)
  })
})
