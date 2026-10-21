// controls.test.ts — TEST-2 [covers: ITEM-9] — the per-control edit-capability resolve/diff policy
// (plot-editing). Proves DEC-4 defaults (legend shown+editable; colormap/titles/pointSize shown +
// read-only), per-flag override, and that `diffControls` is the inverse of `resolveControls` up to
// defaults (so `getOption()` re-emits the MINIMAL non-default subset → byte-identical when unset).

import { describe, it, expect } from 'vitest'
import {
  CONTROL_DEFAULTS,
  CONTROL_IDS,
  diffControls,
  resolveControls,
  type ResolvedControls,
  type VizControls,
} from './types'

describe('plot-editing: resolveControls default policy (DEC-4)', () => {
  it('absent controls → every control resolved to its (byte-identical) default', () => {
    // FIND-1/2/3 fix: net-new chrome is opt-in, so colormap/pointSize default show:false and NO control
    // is editable by default (absent controls ⇒ byte-identical to the pre-feature render).
    expect(resolveControls()).toEqual({
      legend: { show: true, editable: false },
      colormap: { show: false, editable: false },
      titles: { show: true, editable: false },
      pointSize: { show: false, editable: false },
    })
  })

  it('the defaults constant matches the resolve of undefined (single source of truth)', () => {
    expect(resolveControls(undefined)).toEqual(CONTROL_DEFAULTS)
  })

  it('nothing is editable by default; the net-new chrome (colormap/pointSize) is hidden by default', () => {
    const r = resolveControls()
    for (const id of CONTROL_IDS) expect(r[id].editable).toBe(false)
    expect(r.legend.show).toBe(true) // existing categorical legend still shows
    expect(r.titles.show).toBe(true) // title-less cell renders nothing anyway → byte-identical
    expect(r.colormap.show).toBe(false) // new picker hidden
    expect(r.pointSize.show).toBe(false) // new marks control hidden
  })

  it('show:false hides a control; editable:false makes it read-only; both are per-flag', () => {
    const r = resolveControls({
      legend: { editable: true }, // shown (default) + made editable
      colormap: { show: true }, // shown, but editable keeps its default (false)
    })
    expect(r.legend).toEqual({ show: true, editable: true })
    expect(r.colormap).toEqual({ show: true, editable: false })
    expect(r.titles).toEqual({ show: true, editable: false })
    expect(r.pointSize).toEqual({ show: false, editable: false })
  })
})

describe('plot-editing: diffControls (minimal non-default projection, byte-identical passthrough)', () => {
  it('all-default resolved → undefined (getOption emits nothing)', () => {
    expect(diffControls(resolveControls())).toBeUndefined()
  })

  it('emits only the flags that differ from the default', () => {
    const resolved = resolveControls({ legend: { show: false }, colormap: { editable: true } })
    expect(diffControls(resolved)).toEqual({
      legend: { show: false }, // editable === default(true) → omitted
      colormap: { editable: true }, // show === default(true) → omitted
    })
  })

  it('round-trips: resolveControls ∘ diffControls ∘ resolveControls is stable', () => {
    const cases: (VizControls | undefined)[] = [
      undefined,
      { legend: { show: false } },
      { colormap: { editable: true }, titles: { show: false } },
      { legend: { show: false, editable: false }, pointSize: { editable: true } },
    ]
    for (const c of cases) {
      const once: ResolvedControls = resolveControls(c)
      const twice: ResolvedControls = resolveControls(diffControls(once))
      expect(twice).toEqual(once)
    }
  })
})
