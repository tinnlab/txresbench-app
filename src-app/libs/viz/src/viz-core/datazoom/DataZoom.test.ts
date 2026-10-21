// DataZoom.test.ts — the core DATAZOOM component's WINDOW-OWNERSHIP fallback (STEP 4). The
// component owns the dataZoom window state (a React `useState` + a reset-on-domain-change effect)
// and feeds the passive View the "active window" = the owned state, or the full domain/matrix
// before the reset effect runs. That fallback is the pure `activeValueWindow` / `activeMatrixWindow`
// (extracted so the ownership contract is node-testable without rendering React). These assert the
// exact expressions the Views formerly inlined, so the hoist stays behavior-identical.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { activeValueWindow, activeMatrixWindow } from './DataZoom'
import { fullValueWindow } from '../charts/valueWindow'
import { fullWindow, type MatrixWindow } from '../charts/matrixWindow'

describe('activeValueWindow — value-axis window ownership fallback', () => {
  it('falls back to the FULL domain when the component holds no window yet', () => {
    // Before the reset effect runs the state is null → the View sees the full domain.
    expect(activeValueWindow(null, [2, 10])).toEqual(fullValueWindow(2, 10))
  })

  it('passes the owned (zoomed) window through unchanged', () => {
    const owned = { lo: 4, hi: 6 }
    expect(activeValueWindow(owned, [2, 10])).toBe(owned)
  })

  it('is null while the domain is unknown (loading)', () => {
    expect(activeValueWindow(null, null)).toBeNull()
    expect(activeValueWindow({ lo: 1, hi: 2 }, null)).toBeNull()
  })
})

// ── the FALLBACK-IDENTITY hazard + its guard (the shared-deck publish-loop regression) ────────────
// A null owned window is NOT transient: `VizController.setOption` hydrates `dataZoomWindows` from the
// option, so an option with no `dataZoom` block CLEARS the store entry, while the component's
// reset-to-full effect only re-seeds when the domain VALUES change. A surface that re-issues
// `setOption` over unchanged data (the declarative canvas, once per form edit) therefore leaves the
// owned window permanently null — and the fallback below MINTS a new object on every call. Handing a
// fresh `window` identity to the passive View on every render churns its `bounds` → `layers` memos →
// `ChartCanvas.allLayers` → `ChartLayerSink.publish`, whose equality gate compares `layers` BY
// REFERENCE (chartLayerSink.ts) — so it notifies, the grid re-renders, the chart re-renders, and the
// cycle never settles (React "Maximum update depth exceeded"; the whole surface unmounts).
// The component MUST therefore memoize the active window on the domain VALUES.
describe('active-window fallback identity (shared-deck publish-loop guard)', () => {
  it('MINTS a new object each call when no window is owned — the hazard the component must memoize', () => {
    const a = activeValueWindow(null, [2, 10])
    const b = activeValueWindow(null, [2, 10])
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    const m1 = activeMatrixWindow(null, 5, 3)
    const m2 = activeMatrixWindow(null, 5, 3)
    expect(m1).toEqual(m2)
    expect(m1).not.toBe(m2)
  })

  it('BOTH dataZoom components memoize their active window (never call the fallback inline)', () => {
    // Structural, because the loop is only observable across renders (no React renderer in this
    // node pass) — but it is the exact edit that fixed it, so a revert fails here as well as in the
    // `14-declarative-qc/canvas-update-loop-guard` e2e.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'DataZoom.tsx'), 'utf8')
    const assignments = src.match(/const active = [\s\S]*?\n(?=\s*(?:if|return|const|\/\/))/g) ?? []
    expect(assignments.length, 'ValueDataZoom + DataZoomMatrix each assign an `active` window').toBe(2)
    for (const a of assignments) {
      expect(a, `the active window must be memoized, not recomputed per render:\n${a}`).toMatch(/useMemo\(/)
    }
  })
})

describe('activeMatrixWindow — matrix window ownership fallback', () => {
  it('falls back to the FULL matrix when the component holds no window yet', () => {
    expect(activeMatrixWindow(null, 5, 3)).toEqual(fullWindow(5, 3))
  })

  it('passes the owned (zoomed) matrix window through unchanged', () => {
    const owned: MatrixWindow = { row0: 1, row1: 3, col0: 0, col1: 2 }
    expect(activeMatrixWindow(owned, 5, 3)).toBe(owned)
  })

  it('is null while the dimensions are unknown (loading / empty matrix)', () => {
    expect(activeMatrixWindow(null, 0, 0)).toBeNull()
    expect(activeMatrixWindow(null, 5, 0)).toBeNull()
    expect(activeMatrixWindow(null, 0, 3)).toBeNull()
  })
})
