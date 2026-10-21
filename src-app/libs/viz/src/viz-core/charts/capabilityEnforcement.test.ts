// capabilityEnforcement.test.ts — viz-followups Area B, TEST-5. Proves the declarative chart
// CAPABILITIES (registry/types.ts `ChartCapabilities`) are actually ENFORCED at the View's
// consume / produce / dataZoom decision points, and that the DEFAULT (a flag left unset) is
// byte-identical to today (only an explicit opt-out changes behavior).
//
// The built-in Views can't render headlessly (deck.gl/WebGL), so this exercises the SINGLE pure
// decision seam the Views call — `charts/capabilityGates.ts` — via a MOCK `CoordinationHandle`.
// Every consuming View calls `gateGroupEmphasis(coordination.useGroupEmphasis(...), consumesSelection)`
// / `gatePointSelection(coordination.usePointSelection(), consumesSelection)`, ViolinView gates its
// brush with `producesEnabled(...)`, and the value/matrix Views gate their DataZoom with
// `gateValue/MatrixDataZoom(...)` — so testing these functions tests the real enforcement path (not
// a parallel re-implementation). The "no dim" assertion is via `markOpacity` (DIM_OPACITY vs 1).

import { describe, it, expect, vi } from 'vitest'
import {
  gateGroupEmphasis,
  gatePointSelection,
  producesEnabled,
  gateValueDataZoom,
  gateMatrixDataZoom,
  INACTIVE_GROUP_EMPHASIS,
} from './capabilityGates'
import { markOpacity, DIM_OPACITY, type GroupEmphasis } from '../coordination/selectionSync'
import type { CoordinationHandle } from '../registry/types'
import type { DataZoomConfig } from './AxisDataZoom'

// A sibling brush selected group code 0 — so an UN-gated consumer dims every OTHER group's mark.
const SIBLING_EMPHASIS: GroupEmphasis = { selectedCodes: new Set<number>([0]), active: true }

/**
 * A mock coordination handle standing in for the shared Selection store: `useGroupEmphasis` /
 * `usePointSelection` report a live sibling selection, and the two are SPIES so a test can assert
 * whether the View subscribed. (The Views call these through the handle; the gate is applied to the
 * result.) The produce methods are inert spies.
 */
function mockHandle(): CoordinationHandle {
  return {
    useGroupEmphasis: vi.fn(() => SIBLING_EMPHASIS),
    usePointSelection: vi.fn(() => Uint32Array.of(7)),
    useSelectionOrigin: vi.fn(() => null),
    useExclusiveSelection: vi.fn(() => ({ epoch: 0, origin: null })),
    useSharedColorDomain: vi.fn(() => null),
    usePointSelectionInSpace: vi.fn(() => null),
    useSelectionOriginInSpace: vi.fn(() => null),
    setSelection: vi.fn(),
    setPointSelection: vi.fn(),
    clearSelection: vi.fn(),
    setSelectionInSpace: vi.fn(),
    clearSelectionInSpace: vi.fn(),
  }
}

describe('ITEM-5 consume gate — group emphasis (bar / box / dotplot / violin)', () => {
  it('DEFAULT (consumesSelection unset) consumes the sibling selection → a non-selected mark DIMS', () => {
    // The View's exact call: gate(handle.useGroupEmphasis(codes), consumesSelection).
    const h = mockHandle()
    const emphasis = gateGroupEmphasis(h.useGroupEmphasis(Uint16Array.of(0, 1)), undefined)
    expect(emphasis.active).toBe(true)
    // group code 1 was NOT selected by the sibling → it dims (byte-identical to today).
    expect(markOpacity(1, emphasis.selectedCodes, emphasis.active)).toBe(DIM_OPACITY)
    // …and the selected group stays fully opaque.
    expect(markOpacity(0, emphasis.selectedCodes, emphasis.active)).toBe(1)
  })

  it('consumesSelection:true is unchanged from default (still dims)', () => {
    const h = mockHandle()
    const emphasis = gateGroupEmphasis(h.useGroupEmphasis(Uint16Array.of(0, 1)), true)
    expect(markOpacity(1, emphasis.selectedCodes, emphasis.active)).toBe(DIM_OPACITY)
  })

  it('consumesSelection:false DISCARDS the sibling selection → NOTHING dims (no emphasis)', () => {
    const h = mockHandle()
    const emphasis = gateGroupEmphasis(h.useGroupEmphasis(Uint16Array.of(0, 1)), false)
    // The gate returns the shared INACTIVE result — active:false ⇒ every mark renders full opacity.
    expect(emphasis).toBe(INACTIVE_GROUP_EMPHASIS)
    expect(emphasis.active).toBe(false)
    expect(markOpacity(1, emphasis.selectedCodes, emphasis.active)).toBe(1)
    expect(markOpacity(0, emphasis.selectedCodes, emphasis.active)).toBe(1)
  })
})

describe('ITEM-5 consume gate — point selection (heatmap row band, violin per-dot mask)', () => {
  it('DEFAULT / true pass the shared point selection through (highlight)', () => {
    const h = mockHandle()
    expect(gatePointSelection(h.usePointSelection(), undefined)).toEqual(Uint32Array.of(7))
    expect(gatePointSelection(h.usePointSelection(), true)).toEqual(Uint32Array.of(7))
  })

  it('consumesSelection:false ⇒ null (reads as "no selection" ⇒ no highlight)', () => {
    const h = mockHandle()
    expect(gatePointSelection(h.usePointSelection(), false)).toBeNull()
  })
})

describe('ITEM-5 produce gate — brush / lasso exposure (violin)', () => {
  it('DEFAULT (producesSelection unset) exposes the gesture when a sink is wired', () => {
    expect(producesEnabled(true, undefined)).toBe(true)
    expect(producesEnabled(true, true)).toBe(true)
  })

  it('producesSelection:false HIDES the gesture even with a sink wired', () => {
    expect(producesEnabled(true, false)).toBe(false)
  })

  it('no producer sink ⇒ never exposed, regardless of the flag (byte-identical)', () => {
    expect(producesEnabled(false, true)).toBe(false)
    expect(producesEnabled(false, undefined)).toBe(false)
  })
})

describe('ITEM-6 dataZoom-axes gate', () => {
  const CFG: DataZoomConfig = { y: 'both' }

  it('value (y-only) charts: unset / includes y passes through; omitting y disables', () => {
    expect(gateValueDataZoom(CFG, undefined)).toBe(CFG) // default unchanged
    expect(gateValueDataZoom(CFG, ['y'])).toBe(CFG) // descriptor default for bar/box/violin
    expect(gateValueDataZoom(CFG, ['x', 'y'])).toBe(CFG)
    expect(gateValueDataZoom(CFG, ['x'])).toBe(false) // no y ⇒ value zoom disabled
    expect(gateValueDataZoom(CFG, [])).toBe(false)
    expect(gateValueDataZoom(false, undefined)).toBe(false) // a caller-disabled zoom stays off
  })

  it('matrix (x+y) charts: unset / any axis passes through; EMPTY disables', () => {
    expect(gateMatrixDataZoom(CFG, undefined)).toBe(CFG) // default unchanged
    expect(gateMatrixDataZoom(CFG, ['x', 'y'])).toBe(CFG) // descriptor default for heatmap/dotplot
    expect(gateMatrixDataZoom(CFG, ['x'])).toBe(CFG)
    expect(gateMatrixDataZoom(CFG, [])).toBe(false) // no axes ⇒ matrix zoom disabled
  })
})

describe('ITEM-5 — the gate is the ONLY thing that changes a sibling brush outcome', () => {
  it('same sibling selection, same handle: gated-out consumer ignores it, default consumer dims', () => {
    const h = mockHandle()
    const codes = Uint16Array.of(0, 1, 2)
    // Two Views reading the SAME shared handle; only the capability flag differs.
    const consuming = gateGroupEmphasis(h.useGroupEmphasis(codes), undefined)
    const notConsuming = gateGroupEmphasis(h.useGroupEmphasis(codes), false)
    // Positive control: the consuming View dims a non-selected group.
    expect(markOpacity(2, consuming.selectedCodes, consuming.active)).toBe(DIM_OPACITY)
    // The opted-out View is un-dimmed for the very same group.
    expect(markOpacity(2, notConsuming.selectedCodes, notConsuming.active)).toBe(1)
  })
})
