// @vitest-environment jsdom
//
// propStability.test.ts — TEST-5's UNIT half (ITEM-1 / ITEM-2), the gate whose absence already cost
// a defect.
//
// ── WHY THIS FILE HAD TO EXIST ───────────────────────────────────────────────────────────────────
// Every other render-perf gate measures a CONSEQUENCE: element creations counted during a wheel
// (TEST-P1, TEST-P3, TEST-F5). That is a strictly weaker property than the one memoization actually
// depends on. An unstable prop is only VISIBLE to those gates when it happens to change during the
// drive they run; a prop that re-mints on some OTHER interaction is invisible to all of them.
//
// That is not hypothetical — it is exactly how blind-audit finding B1 survived. `requestExportCell`
// was `useCallback(…, [onRequestExportCell, perCellLegend, perCellRange, perCellHiddenCodes])`.
// All three of those are WHOLE-RECORD store reads, so ANY cell's legend / visual-map / hidden-code
// change re-minted the callback, which descends as `onExportCell` through
// `GridPaneCell -> CellView -> PaneToolbar` — a memo-boundary prop. ONE pane's legend click
// therefore rebuilt EVERY pane's chrome, defeating Split D/0b's per-cell isolation grid-wide. The
// counter leg never saw it because a WHEEL does not touch those records.
//
// The lesson, and this file's whole reason for being: **"is a useCallback" is not "has a stable
// identity"**. PLAN_AUDIT.md:226 made exactly that conflation when it called `plotGutter` the SOLE
// referentially-unstable prop at that boundary.
//
// ── WHAT IT ASSERTS, AND WHY IT IS NOT A SOURCE SCAN ────────────────────────────────────────────
// It RENDERS the real `useGridWindows` hook against real `createVizStores()` and re-renders it with
// each of the four B1 inputs re-minted as a fresh object — the precise thing a whole-record store
// read does on every unrelated store write — then asserts the produced callback is REFERENTIALLY
// IDENTICAL across the two renders. No regex over the dep array, no reading of the source: the
// property is observed on the value the component actually hands down. DEC-45 removed a guard for
// pattern-matching a semantic property; this asserts the semantic property itself.

import { createRef } from 'react'
import * as React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createVizStores } from '../../adapter/vizStores'
import { useGridWindows } from './useGridWindows'
import type { GridCell } from './gridModel'
import type { PaneRect } from '../layers/multiView'

/** One render's captured outputs plus the identities of the inputs that produced them. */
interface Capture {
  readonly requestExportCell: unknown
  readonly openExportCell: unknown
  readonly legendIdentity: unknown
}

function drive(renders: number) {
  const stores = createVizStores()
  const containerRef = createRef<HTMLDivElement>()
  const deckRef = createRef<unknown>()
  const activeCellRef = { current: null as string | null }
  const denseCellsRef = { current: [] as readonly GridCell[] }
  const denseRects: readonly PaneRect[] = []
  const captures: Capture[] = []

  // Each render re-mints ALL FOUR B1 inputs as fresh objects. That is what a whole-record store
  // read does when any unrelated cell's legend/range/hidden-codes change — the literal B1 trigger.
  function Probe({ tick }: { tick: number }) {
    const perCellLegend = React.useMemo(() => ({}) as Record<string, never>, [tick])
    const perCellRange = React.useMemo(() => ({}) as Record<string, never>, [tick])
    const perCellHiddenCodes = React.useMemo(() => ({}) as Record<string, never>, [tick])
    // The shipping app passes an INLINE ARROW here (VisualizationPage.tsx), so it churns on every
    // host render. Reproduced faithfully rather than hoisted, because hoisting it would remove half
    // of what B1 was about.
    const onRequestExportCell = (_cellId: string) => {}

    const out = useGridWindows({
      stores,
      containerId: 'primary' as never,
      containerRef,
      deckRef: deckRef as never,
      restoreKey: 0,
      denseRects,
      activeCellRef,
      denseCellsRef,
      perCellLegend: perCellLegend as never,
      perCellRange: perCellRange as never,
      perCellHiddenCodes: perCellHiddenCodes as never,
      onRequestExportCell,
    })
    captures.push({
      requestExportCell: out.requestExportCell,
      openExportCell: out.openExportCell,
      legendIdentity: perCellLegend,
    })
    return null
  }

  const view = render(React.createElement(Probe, { tick: 0 }))
  for (let i = 1; i < renders; i++) view.rerender(React.createElement(Probe, { tick: i }))
  view.unmount()
  return captures
}

describe('prop referential stability at the memo boundaries (TEST-5 unit half, ITEM-1 / ITEM-2)', () => {
  it('`requestExportCell` survives a re-mint of all four B1 inputs with its identity intact', () => {
    const caps = drive(2)

    // ── NON-VACUITY, asserted BEFORE the property ───────────────────────────────────────────────
    // Two things could make the real assertion pass while measuring nothing: the component not
    // re-rendering at all, or the "re-minted" input coming back identical. Both are ruled out
    // first, because a silent green here would reproduce the exact class this file exists to close.
    expect(caps.length, 'the probe must have rendered TWICE — one render cannot show stability').toBe(2)
    expect(
      caps[0].legendIdentity === caps[1].legendIdentity,
      'the perCellLegend input must be a DIFFERENT object across the two renders, or this test is ' +
        'asserting stability against an input that never changed (vacuous)',
    ).toBe(false)

    // ── THE PROPERTY ────────────────────────────────────────────────────────────────────────────
    expect(
      caps[0].requestExportCell === caps[1].requestExportCell,
      'requestExportCell was RE-MINTED when the four whole-record inputs changed. It descends as ' +
        '`onExportCell` through GridPaneCell -> CellView -> PaneToolbar, where it is a memo-boundary ' +
        'prop, so ONE pane’s legend click now rebuilds EVERY pane’s chrome (blind-audit B1). ' +
        'Read the four inputs through render-assigned refs and give the callback an EMPTY dep array.',
    ).toBe(true)
  })

  it('POSITIVE CONTROL: the `[]`-stable sibling `openExportCell` is stable too, so the probe can see stability at all', () => {
    const caps = drive(2)
    expect(
      caps[0].openExportCell === caps[1].openExportCell,
      'openExportCell has always been []-stable; if THIS is unstable the probe is measuring ' +
        'something other than callback identity and the assertion above proves nothing',
    ).toBe(true)
  })

  it('the identity holds across MANY re-mints, not just one', () => {
    const caps = drive(5)
    expect(caps.length).toBe(5)
    const first = caps[0].requestExportCell
    expect(
      caps.every(c => c.requestExportCell === first),
      'requestExportCell drifted across five consecutive re-mints',
    ).toBe(true)
  })
})
