// @vitest-environment jsdom
//
// A CLOSED SET's option may say what it MEANS, and the two halves are DIFFERENT strings.
//
// Reported: "the selected should show sum/count/... not the whole label. The rendered options
// should show both, but in two lines". The option list was carrying ONE string that jammed the
// value and its explanation together (`"sum — Σ counts over the set"`), so the chosen state
// rendered a whole sentence into a narrow table column, and an option physically could not be
// two lines because a label is one string.
//
// So an option declares `description` beside `label`: the ROW draws both, stacked, and the
// TRIGGER draws the label alone. The kit already carries both halves (`SelectOption.label` for
// the row, `selectedLabel` for the trigger); what was missing was a way for a DECLARED option to
// express the second one.
//
// It also declares its own `when` — the same gate a widget carries, evaluated in the control's
// render scope. An option list is DATA, and a datum may state its own precondition; without it a
// capability-gated entry can only be gated by hiding the WHOLE control, which is not the same
// proposition.

import * as React from 'react'
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { installWidgets, __resetInstallWidgetsForTests } from './installWidgets'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import {
  pickerOptionNodes,
  pickerOptions,
  pickerShownValues,
  choosePicker,
  typeInPicker,
} from '@/modules/workbench/core/__testutil__/pickerDriver'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import * as defineAction from '@/core/actions/defineAction'

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

const REDUCERS = [
  { value: 'sum', label: 'sum', description: 'Σ values over the set' },
  { value: 'count', label: 'count', description: 'members of the set above zero' },
]

const selectSpec = {
  id: 'reducer',
  kind: 'select',
  label: 'Reducer',
  options: '$const.reducers',
  value: '$state.pick',
} as unknown as WidgetSpec

function mount(
  specs: WidgetSpec[],
  over: { state?: Record<string, unknown>; reducers?: unknown; caps?: unknown } = {},
): void {
  const scope: Scope = {
    params: {},
    state: { pick: '', ...(over.state ?? {}) },
    derived: {},
    const: { reducers: over.reducers ?? REDUCERS },
    data: {},
    ...(over.caps === undefined ? {} : { caps: over.caps }),
  }
  render(<WidgetList specs={specs} scope={scope} viewId="v" specId="t/spec" />)
}

/** The trigger's VALUE SLOT text — what the collapsed control reads as. */
const shownLabel = (el: HTMLElement): string =>
  (el.querySelector('[data-slot="select-value"]')?.textContent ?? '').trim()

describe('a closed-set option shows its meaning in the ROW and its value in the TRIGGER', () => {
  it('the option row draws label AND description, on two lines', async () => {
    mount([selectSpec])
    const el = screen.getByTestId('widget-reducer')
    const rows = await pickerOptionNodes(el)
    expect(rows.map(r => r.textContent)).toEqual([
      'sumΣ values over the set',
      'countmembers of the set above zero',
    ])
    // TWO LINES, not one run of text: each half is its own block-level node inside the row, so
    // the description sits UNDER the label rather than beside it. A single concatenated string
    // would satisfy the text assertion above and still render as one line, which is the shape
    // this replaces.
    for (const row of rows) {
      const stacked = row.querySelector('[data-slot="option-lines"]')
      expect(stacked, 'the row stacks its two halves').not.toBeNull()
      expect(stacked!.children.length).toBe(2)
    }
  })

  it('the TRIGGER shows the label alone — never the description', () => {
    // The control is CONTROLLED: what it displays comes from the binding, so this is also the
    // reload path (a value restored into state, never clicked in this session).
    mount([selectSpec], { state: { pick: 'sum' } })
    const el = screen.getByTestId('widget-reducer')
    expect(pickerShownValues(el)).toEqual(['sum'])
    expect(shownLabel(el)).toBe('sum')
    expect(shownLabel(el)).not.toContain('Σ values')
  })

  it('a two-line row is still addressed by its VALUE — the display changed, the identity did not', async () => {
    mount([selectSpec])
    const el = screen.getByTestId('widget-reducer')
    // `${testid}-opt-${value}`: the row a driver (or a user's keyboard) commits is keyed on what
    // the run receives, not on what the row draws. Both halves of the display are prose now, so
    // an identity read off either of them would break the moment the wording changed.
    expect(await pickerOptions(el)).toEqual(['sum', 'count'])
  })

  it('an option with NO description is unchanged — one line, label only (the control case)', async () => {
    mount([selectSpec], { reducers: [{ value: 'sum', label: 'sum' }, { value: 'count', label: 'count' }] })
    const el = screen.getByTestId('widget-reducer')
    const rows = await pickerOptionNodes(el)
    expect(rows.map(r => r.textContent?.trim())).toEqual(['sum', 'count'])
    expect(rows[0].querySelector('[data-slot="option-lines"]')).toBeNull()
  })

  it('the description is REACHABLE by typing — a row findable only by what it displays is half findable', async () => {
    // Long enough to put the control over the kit's own search threshold, so the filter exists.
    const many = Array.from({ length: 12 }, (_, i) => ({
      value: `r${i}`,
      label: `r${i}`,
      description: i === 7 ? 'the quartile summary' : `reduction ${i}`,
    }))
    mount([selectSpec], { reducers: many })
    const el = screen.getByTestId('widget-reducer')
    await typeInPicker(el, 'quartile')
    expect(await pickerOptions(el)).toEqual(['r7'])
  })
})

describe('an option declares its own `when`, in the control’s render scope', () => {
  it('an option whose gate is FALSE is not offered', async () => {
    mount([selectSpec], {
      reducers: [...REDUCERS, { value: 'ratio', label: 'ratio', when: 'has:second-channel' }],
      caps: [],
    })
    const el = screen.getByTestId('widget-reducer')
    expect(await pickerOptions(el)).toEqual(['sum', 'count'])
  })

  it('…and IS offered once the capability is there (the positive control)', async () => {
    mount([selectSpec], {
      reducers: [...REDUCERS, { value: 'ratio', label: 'ratio', when: 'has:second-channel' }],
      caps: ['second-channel'],
    })
    const el = screen.getByTestId('widget-reducer')
    expect(await pickerOptions(el)).toEqual(['sum', 'count', 'ratio'])
  })

  it('an option with NO `when` is always offered — the gate is opt-in', async () => {
    mount([selectSpec], { caps: [] })
    const el = screen.getByTestId('widget-reducer')
    expect(await pickerOptions(el)).toEqual(['sum', 'count'])
  })
})

// ── `offer_when` — ONE gate over the whole set, and `$option` to write it with ──────────────
//
// An option could state a precondition about the WORLD (`has:<capability>`) and never one about
// ITSELF, because nothing in scope named the entry being judged. So the commonest gate of all —
// "do not offer what has already been taken" — was inexpressible except by hand-copying a clause
// that spells each entry's own value into every entry: N copies of one rule, out of which the
// N+1th entry drops SILENTLY.
//
// Two additions, and they are only useful together: `$option` names the entry under judgement,
// and `offer_when` puts the clause on the CONTROL, where a rule about the offer belongs, so the
// catalog stays pure data.
describe('`offer_when` — the control’s own gate over every option', () => {
  const withOfferWhen = (clause: string): WidgetSpec =>
    ({ ...(selectSpec as object), offer_when: clause }) as unknown as WidgetSpec

  it('an option whose gate is false is WITHHELD — and `$option` is how the gate names it', async () => {
    mount([withOfferWhen("$option.value != 'count'")])
    expect(await pickerOptions(screen.getByTestId('widget-reducer'))).toEqual(['sum'])
  })

  it('the gate reads STATE through the option — the membership test the whole key exists for', async () => {
    // The shipped shape: a map of what is already held, indexed by the option's own field. An
    // entry present in it is not offered; the rest are.
    mount([withOfferWhen('$state.taken[$option.value] == absent')], {
      state: { taken: { sum: true } },
    })
    expect(await pickerOptions(screen.getByTestId('widget-reducer'))).toEqual(['count'])
  })

  it('…and it FOLLOWS that state rather than being fixed at mount (the positive control)', async () => {
    mount([withOfferWhen('$state.taken[$option.value] == absent')], { state: { taken: {} } })
    expect(await pickerOptions(screen.getByTestId('widget-reducer'))).toEqual(['sum', 'count'])
  })

  it('a SCALAR option answers the same gate — the two option shapes are not judged differently', async () => {
    // A bare-string option normalizes to `{value,label}`, and it is bound as that. Judging only
    // the object shape would leave every `string[]` binding silently ungated, which reads as a
    // gate that works.
    mount([withOfferWhen("$option.value != 'b'")], { reducers: ['a', 'b', 'c'] })
    expect(await pickerOptions(screen.getByTestId('widget-reducer'))).toEqual(['a', 'c'])
  })

  it('it is ANDed with the option’s own `when`, never a replacement for it', async () => {
    mount([withOfferWhen("$option.value != 'count'")], {
      reducers: [...REDUCERS, { value: 'ratio', label: 'ratio', when: 'has:second-channel' }],
      caps: [],
    })
    // `count` is refused by the control's gate, `ratio` by its own. Only what passes BOTH is left.
    expect(await pickerOptions(screen.getByTestId('widget-reducer'))).toEqual(['sum'])
  })

  it('NO `offer_when` ⇒ everything is offered (the key is opt-in)', async () => {
    mount([selectSpec])
    expect(await pickerOptions(screen.getByTestId('widget-reducer'))).toEqual(['sum', 'count'])
  })

  it('a gate that withholds EVERYTHING reads as the empty state, not as a blank box', async () => {
    mount([withOfferWhen('false')])
    const el = screen.getByTestId('widget-reducer')
    expect(await pickerOptions(el)).toEqual([])
    expect(el.hasAttribute('disabled')).toBe(true)
  })

  it('…and `empty_text` lets the view say WHY, in place of the engine’s "not yet"', async () => {
    const EXHAUSTED = 'Everything is already added.'
    mount([
      { ...(withOfferWhen('false') as object), empty_text: EXHAUSTED } as unknown as WidgetSpec,
    ])
    const el = screen.getByTestId('widget-reducer')
    expect(el.textContent).toContain(EXHAUSTED)
    // The generic wording is REPLACED, not stacked beside it: "no options yet" tells a user to
    // wait for options that can never arrive, which is a worse empty state than a blank one.
    expect(screen.getByTestId('widget-reducer-field').textContent).not.toContain('No options yet')
  })
})

// ── a controlled closed set reports a CHOICE, never an echo of what it already shows ─────────
//
// The underlying listbox keeps its OWN internal selection. When a render hands it a `value` that
// disagrees, it re-syncs down — and announces the correction through the same `onChange` a user's
// click comes through, so the engine cannot tell the two apart from the call.
//
// That is invisible while the bound action WRITES the chosen value (the correction then agrees
// with what state already holds) and destructive the moment an action does anything else. The
// shipped case is a picker whose change ADDS A ROW and deliberately leaves its own binding empty:
// one choice dispatched TWICE — the choice, then `''` — and the second dispatch appended a row
// built from a lookup that resolved to nothing, which then invalidated the form.
describe('a controlled closed set dispatches once per choice', () => {
  /** The "choosing IS the action" shape: the change is bound to an action that does not write
   *  this control's own binding. */
  const addingSpec = {
    ...(selectSpec as object),
    id: 'adder',
    onChange: 'fx.add',
  } as unknown as WidgetSpec

  /**
   * The shipped shape, reproduced: choosing an option TAKES it (it stops being offered) and the
   * control's own binding is never written. Re-renders IN PLACE — a remount would throw away the
   * internal selection the echo is produced by, so a harness that unmounts between renders
   * reports a clean single dispatch for a control that fires twice in the app.
   *
   * Withdrawing the chosen option is not decoration: it is what makes the listbox's own selection
   * name something that is no longer in the list, which is the condition it corrects by
   * announcing `''` through `onChange`.
   */
  let takeOption: (value: string) => void
  function Harness({ bound }: { bound: string }): React.ReactElement {
    const [taken, setTaken] = React.useState<readonly string[]>([])
    takeOption = v => setTaken(t => (t.includes(v) ? t : [...t, v]))
    const scope: Scope = {
      params: {},
      state: { pick: bound },
      derived: {},
      const: { reducers: REDUCERS.filter(o => !taken.includes(o.value)) },
      data: {},
    }
    return <WidgetList specs={[addingSpec]} scope={scope} viewId="v" specId="t/spec" />
  }

  /** Every action dispatch the host attempted, in order. */
  function recordDispatches(): Array<{ id: string; args: unknown }> {
    const calls: Array<{ id: string; args: unknown }> = []
    vi.spyOn(defineAction, 'runAction').mockImplementation(async (id: string, args: unknown) => {
      calls.push({ id, args })
      // AFTER a tick, which is the whole point. A declared action is interpreted
      // asynchronously, so the store lands — and the region re-renders — in a LATER task than
      // the click. Re-rendering synchronously inside the handler batches into the same commit,
      // the listbox never observes a value that disagrees with its own selection, and the echo
      // this suite is about does not happen: a harness that does it that way reports a clean
      // single dispatch for a control that fires twice in the app.
      await Promise.resolve()
      const chosen = (args as { value?: unknown }).value
      if (typeof chosen === 'string' && chosen !== '') takeOption(chosen)
      return undefined as never
    })
    return calls
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('an action that leaves the binding EMPTY produces ONE dispatch, carrying the chosen value', async () => {
    const calls = recordDispatches()
    render(<Harness bound="" />)
    await choosePicker(screen.getByTestId('widget-adder'), 'sum')
    expect(calls.map(c => (c.args as { value?: unknown }).value)).toEqual(['sum'])
  })

  it('a SECOND choice still dispatches — the guard suppresses echoes, not choices', async () => {
    // The positive control the guard needs: suppressing "the value already shown" must not
    // suppress the next real choice, or a picker whose action never writes its binding would go
    // inert after one use.
    const calls = recordDispatches()
    render(<Harness bound="" />)
    await choosePicker(screen.getByTestId('widget-adder'), 'sum')
    await choosePicker(screen.getByTestId('widget-adder'), 'count')
    expect(calls.map(c => (c.args as { value?: unknown }).value)).toEqual(['sum', 'count'])
  })

  it('choosing the value the control ALREADY shows dispatches nothing', async () => {
    const calls = recordDispatches()
    render(<Harness bound="sum" />)
    await choosePicker(screen.getByTestId('widget-adder'), 'sum')
    expect(calls).toEqual([])
  })
})
