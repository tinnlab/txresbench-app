// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { WIDGET_KINDS } from '@/modules/workbench/core'
import { hasWidget } from '@/modules/workbench/core/render/registry'
import { installWidgets, __resetInstallWidgetsForTests } from './installWidgets'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import {
  EMPTY_DATASET_LABEL,
  EMPTY_MULTISELECT_HINT,
  EMPTY_OPTION_LABEL,
  UNCHOSEN_OPTION_LABEL,
} from './renderers'
import {
  isPicker,
  pickerOptionNodes,
  pickerOptions,
  pickerShownValues,
} from '@/modules/workbench/core/__testutil__/pickerDriver'
import type { Scope } from '@/modules/workbench/core/runtime/expr'

// TEST-10 (ITEM-9 / ITEM-10) — the acceptance test for INV-3.
//
// An options binding resolves to NOTHING all the time in real life: `$derived.columns` is
// empty until the obs slice lands, a categorical column has no categories yet, the
// dataset-picker's source is the wave-2 boundary. The old renderers answered that with a
// BLANK native control — no rows, no explanation, no way to tell "broken" from "not ready".
// That is F9. Every options-driven control now routes an empty binding through an explicit
// affordance; a POPULATED binding is the control case and must be unaffected.

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false
      },
      onchange: null,
    })) as never
  }
})

beforeEach(() => {
  cleanup()
  __resetInstallWidgetsForTests()
  installWidgets()
})

/** Render a widget list against a scope whose `$derived.columns` is empty or populated —
 *  through the REAL host + REAL registered renderers, not a hand-called function. */
function mount(specs: WidgetSpec[], columns: unknown[]): void {
  const scope: Scope = {
    params: {},
    state: { pick: '', keep: [], ds: '' },
    derived: { columns },
    const: {},
    data: {},
  }
  render(<WidgetList specs={specs} scope={scope} viewId="v" specId="t/spec" />)
}

/** What the CONTROL displays as chosen — `''` when it is showing its placeholder. The popover
 *  analogue of the native `sel.value`, read off the node the trigger renders. */
const shown = (el: HTMLElement): string => pickerShownValues(el)[0] ?? ''

/** The trigger's VALUE SLOT text. Its own text content would also carry the chevron glyph. */
const shownLabel = (el: HTMLElement): string =>
  (el.querySelector('[data-slot="select-value"]')?.textContent ?? '').trim()

const selectSpec = {
  id: 'colPicker',
  kind: 'select',
  label: 'Column',
  options: '$derived.columns',
  value: '$state.pick',
} as unknown as WidgetSpec

const multiSpec = {
  id: 'keepSet',
  kind: 'multiselect',
  label: 'Keep categories',
  options: '$derived.columns',
  value: '$state.keep',
} as unknown as WidgetSpec

const pickerSpec = {
  id: 'dsPicker',
  kind: 'dataset-picker',
  label: 'Dataset',
  value: '$state.ds',
} as unknown as WidgetSpec

describe('options-less controls carry an explicit affordance (F9 / INV-3)', () => {
  it('select with ZERO options → the control READS "No options yet", DISABLED', async () => {
    mount([selectSpec], [])
    const el = screen.getByTestId('widget-colPicker')
    expect(isPicker(el), 'the closed set renders the kit picker, not a native <select>').toBe(true)
    expect(el.hasAttribute('disabled')).toBe(true)
    // The nothing-to-choose state is MARKED on the node the trigger renders, so it stays
    // distinguishable from nothing-CHOSEN by machine as well as by eye.
    expect(el.querySelector('[data-empty="true"]')).not.toBeNull()
    // The collapsed control READS as the empty state — not a blank box.
    expect(shownLabel(el)).toBe(EMPTY_OPTION_LABEL)
    // …and it offers nothing. An empty state is a state of the control, never a one-row menu
    // the user can "choose" from.
    expect(await pickerOptions(el)).toEqual([])
  })

  it('select with options → the real options, ENABLED (the control case)', async () => {
    // This case mounts an UNBOUND value (`state.pick` is ''), and it used to assert the
    // option list held ONLY the real options. That is what a native select turned into a
    // false display: with no option matching '', the browser selected the FIRST one, so the
    // control read as a made choice over empty state. The assertion was describing the
    // defect accurately — which is why it stayed green through it.
    //
    // The popover control has no such trap: '' selects nothing and shows the PLACEHOLDER, so
    // the offered set is exactly the real options and "nothing chosen" is asserted on what the
    // trigger reads rather than on a fake row inside the menu.
    mount([selectSpec], ['total_counts', 'pct_mito'])
    const el = screen.getByTestId('widget-colPicker')
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(el.querySelector('[data-empty]')).toBeNull()
    expect((await pickerOptionNodes(el)).map(o => o.textContent?.trim())).toEqual([
      'total_counts',
      'pct_mito',
    ])
    expect(shownLabel(el)).toBe(UNCHOSEN_OPTION_LABEL)
    expect(shownLabel(el)).not.toContain(EMPTY_OPTION_LABEL)
  })

  it('multiselect with ZERO options → an explicit hint under the control (stays enabled: allowCreate)', () => {
    mount([multiSpec], [])
    const field = screen.getByTestId('widget-keepSet')
    expect(field.textContent).toContain(EMPTY_MULTISELECT_HINT)
    // The control itself stays operable — typing a value IS the valid action here.
    expect(screen.getByTestId('widget-keepSet-select')).not.toBeNull()
  })

  it('multiselect with options → no hint (the control case)', () => {
    mount([multiSpec], ['s1', 's2'])
    const field = screen.getByTestId('widget-keepSet')
    expect(field.textContent).not.toContain(EMPTY_MULTISELECT_HINT)
  })

  it('dataset-picker with nothing resolvable → "No datasets available", DISABLED (DEC-4 gate)', () => {
    mount([pickerSpec], [])
    const el = screen.getByTestId('widget-dsPicker-select')
    expect(el.hasAttribute('disabled')).toBe(true)
    expect(el.querySelector('[data-empty="true"]')).not.toBeNull()
    expect(shownLabel(el)).toBe(EMPTY_DATASET_LABEL)
  })

  it('dataset-picker honors a DECLARED options binding (a spec that can supply choices works)', async () => {
    const withOptions = { ...(pickerSpec as object), options: '$derived.columns' } as unknown as WidgetSpec
    mount([withOptions], ['ds-a', 'ds-b'])
    const el = screen.getByTestId('widget-dsPicker-select')
    expect(el.hasAttribute('disabled')).toBe(false)
    expect((await pickerOptionNodes(el)).map(o => o.textContent?.trim())).toEqual(['ds-a', 'ds-b'])
    // It carried the SAME unchosen trap the `select` widget did — nothing bound, so a native
    // control displayed `ds-a` while state held ''. It shows the placeholder now, and this is
    // the assertion that says so.
    expect(shown(el)).toBe('')
    expect(shownLabel(el)).toBe(UNCHOSEN_OPTION_LABEL)
  })

  it('with no CHOICES but a bound value: shows the value, stays DISABLED, and says why', () => {
    const scope: Scope = {
      params: {},
      state: { ds: 'dataset-42' },
      derived: { columns: [] },
      const: {},
      data: {},
    }
    render(<WidgetList specs={[pickerSpec]} scope={scope} viewId="v" specId="t/spec" />)
    const el = screen.getByTestId('widget-dsPicker-select')
    // The bound value is never silently lost…
    expect(shown(el)).toBe('dataset-42')
    expect(el.textContent).toContain('dataset-42')
    // …but there is nothing to change it TO, so the control is disabled and the field says so.
    // (Emptiness is a property of the DECLARED binding, not of the list after the bound value
    // was prepended — otherwise this renders as a normal enabled picker with one raw value.)
    expect(el.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('widget-dsPicker').textContent).toContain(EMPTY_DATASET_LABEL)
  })

  it('select with no CHOICES but a bound value behaves identically (parity)', () => {
    const scope: Scope = {
      params: {},
      state: { pick: 'total_counts' },
      derived: { columns: [] },
      const: {},
      data: {},
    }
    render(<WidgetList specs={[selectSpec]} scope={scope} viewId="v" specId="t/spec" />)
    const el = screen.getByTestId('widget-colPicker')
    expect(shown(el)).toBe('total_counts')
    expect(el.textContent).toContain('total_counts')
    expect(el.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('widget-colPicker-field').textContent).toContain(EMPTY_OPTION_LABEL)
  })
})

// A guard that the shapes these tests use are the SAME ones the engine actually dispatches
// on — i.e. this is not testing a kind the engine never sees.
describe('the shapes under test are real declarative widget kinds', () => {
  it('select / multiselect / dataset-picker each resolve to a REGISTERED renderer', () => {
    for (const w of [selectSpec, multiSpec, pickerSpec]) {
      const kind = (w as { kind?: string }).kind!
      expect(hasWidget(kind), `${kind} is not a registered widget kind`).toBe(true)
      expect(WIDGET_KINDS as readonly string[]).toContain(kind)
    }
  })
})

describe('an UNBOUND select shows that nothing is chosen — not the first option', () => {
  // The defect this pins, in the words of the comment that sat above the bug: a native
  // `<select>` whose value matches no `<option>` "silently displays the FIRST option while
  // the store still holds the other value". The guard for that only ran when the value was
  // NON-empty, so the empty case — which is the state of every freshly-appended list row —
  // rendered as though a real choice had been made.
  //
  // It surfaces as two unrelated-looking bugs: a control gated on the chosen value stays
  // hidden "for no reason" (it is correctly reacting to the empty state), and a launch binds
  // nothing while the form looks filled in.
  //
  // Why no existing test saw it: every other case either asserts on STATE, or SETS the value
  // before looking. This is the only one that asks what an unchosen control DISPLAYS.
  const COLUMNS = [
    { value: 'metric_a', label: 'metric_a' },
    { value: 'metric_b', label: 'metric_b' },
  ]

  it('displays the placeholder, and shows NO value — like the state', () => {
    mount([selectSpec], COLUMNS)
    const el = screen.getByTestId('widget-colPicker')
    // The assertion that fails without the fix: a control that renders its first option for
    // an unmatched value claims a choice the state does not hold. `shown` reads the node the
    // trigger renders, so a control that names ANY value here fails.
    expect(shown(el)).toBe('')
    expect(shownLabel(el)).toContain(UNCHOSEN_OPTION_LABEL)
  })

  it('is ENABLED and still offers every real option — this is not the empty state', async () => {
    mount([selectSpec], COLUMNS)
    const el = screen.getByTestId('widget-colPicker')
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(el.querySelector('[data-empty]')).toBeNull()
    expect(shownLabel(el)).not.toContain(EMPTY_OPTION_LABEL)
    expect(await pickerOptions(el)).toEqual(['metric_a', 'metric_b'])
    // The placeholder is not choosable — it reports the state, it is not an answer to it. It
    // used to be a disabled `<option>` INSIDE the menu, which is as close to choosable as a
    // non-answer can get; it is now not in the offered set at all.
    expect((await pickerOptionNodes(el)).map(o => o.textContent?.trim())).not.toContain(
      UNCHOSEN_OPTION_LABEL,
    )
  })

  it('a BOUND select is untouched — no placeholder, the bound value displayed', () => {
    // The control case. A fix that added the placeholder unconditionally would push every
    // populated control back to showing "Choose…" over a real selection.
    const boundSpec = { ...(selectSpec as object), value: '$state.chosen' } as unknown as typeof selectSpec
    const scope = {
      params: {},
      state: { chosen: 'metric_b' },
      derived: { columns: COLUMNS },
      const: {},
      data: {},
    } as unknown as Scope
    render(<WidgetList specs={[boundSpec]} scope={scope} viewId="v" specId="t/spec" />)
    const el = screen.getByTestId('widget-colPicker')
    expect(shown(el)).toBe('metric_b')
    expect(shownLabel(el)).not.toContain(UNCHOSEN_OPTION_LABEL)
  })
})
