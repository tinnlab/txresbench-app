// @vitest-environment jsdom
//
// The `select` table COLUMN primitive — a GENERIC closed-set control on one row's field.
//
// The table is the engine's only list primitive, and until now a column could render exactly
// two things: an `editable_text` (free text) or a `button` (a per-row action). A column whose
// value comes from a CLOSED SET had nowhere to live, so the only ways to ship one were
// (a) free text the user can mistype, or (b) a bespoke, analysis-named widget KIND —
// which is the INV-6 violation the per-row `button` was added to avoid for row deletion.
// A missing generic primitive was the real gap both times.
//
// Everything below is asserted against the MOUNTED control through the REAL widget host and
// the REAL registered renderers, with a REAL registered action on the other end — never
// against a spec object or a hand-called render function. This file names no domain
// vocabulary: the fixture's columns, values and options are deliberately abstract, because
// a primitive that only reads correctly with one analysis's nouns in it is not generic.
//
// The control is a POPOVER picker (the kit `Select`), not a native `<select>`: its rows do
// not exist in the DOM until it is opened, and a choice is committed by clicking one. So
// every question below is asked through the shared driver — the two gestures a user makes —
// rather than of a `value` property, and "what is on screen" is read from the node the
// trigger renders (`data-value`), which is the same fact `sel.value` used to carry.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { __clearWidgetsForTests } from './registry'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { WidgetList } from './WidgetHost'
import { EMPTY_OPTION_LABEL } from '@/modules/workbench/extensions/widgets/renderers'
import {
  FORM_VALIDITY_SCOPE_KEY,
  instanceKey,
  partKey,
} from '@/modules/workbench/core/form/validityContract'
import {
  choosePicker,
  isPicker,
  pickerOptionNodes,
  pickerOptions,
  pickerShownValues,
} from '@/modules/workbench/core/__testutil__/pickerDriver'

// ── jsdom gaps the kit's base-ui controls probe at mount ──────────────────────────────
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
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
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
})

let seq = 0
/** Register the REAL action the column names, capturing every dispatched payload. The action
 *  registry is process-global with no reset seam, so each test mints its own id. */
function captureAction(): { id: string; payloads: Record<string, unknown>[] } {
  const local = `setField${++seq}`
  const box = { id: local, payloads: [] as Record<string, unknown>[] }
  defineAction({
    id: `tsc::${local}`,
    title: local,
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async (params: unknown) => {
      box.payloads.push(params as Record<string, unknown>)
    },
  })
  return box
}

const OPTIONS = [
  { value: 'alpha', label: 'alpha — the first' },
  { value: 'beta', label: 'beta — the second' },
  { value: 'gamma', label: 'gamma — the third' },
]

/** A two-row table whose second column is a closed-set choice. `emptyText` is the VIEW-authored
 *  nothing-to-offer sentence, threaded through this one builder rather than through a second
 *  spec literal — a fixture that spells the same shape twice is a fixture that can drift. */
function tableSpec(
  onChange: string,
  options: unknown = '$const.choices',
  emptyText?: string,
): WidgetSpec {
  return {
    id: 'rows',
    kind: 'table',
    rows: '$state.rows',
    columns: [
      { key: 'label', title: 'Label', value: '$row.label' },
      {
        key: 'choice',
        title: 'Choice',
        cell: {
          select: { value: '$row.choice', options, onChange, ...(emptyText ? { empty_text: emptyText } : {}) },
        },
      },
    ],
  } as unknown as WidgetSpec
}

function mount(spec: WidgetSpec, rows: unknown[]): void {
  installBuiltinWidgets()
  const scope: Scope = {
    params: {},
    state: { rows },
    derived: {},
    const: { choices: OPTIONS },
    data: {},
  }
  render(<WidgetList specs={[spec]} scope={scope} viewId="v1" specId="tsc" />)
}

/** The rendered per-row control for one column, by row index. */
const rowControl = (index: number, column = 'choice', table = 'rows'): HTMLElement =>
  screen.getByTestId(`widget-${table}-select-${column}-${index}`)

/** What the CONTROL displays as chosen — `''` when it is showing its placeholder. The popover
 *  analogue of `sel.value`, read off the node the trigger renders. */
const shown = (el: HTMLElement): string => pickerShownValues(el)[0] ?? ''

/** The label the trigger renders for the value it is showing — its VALUE SLOT only, so the
 *  chevron's own glyph is not mistaken for control copy. */
const shownLabel = (el: HTMLElement): string =>
  (el.querySelector('[data-slot="select-value"]')?.textContent ?? '').trim()

const ROWS = [
  { label: 'first', choice: 'alpha' },
  { label: 'second', choice: 'gamma' },
]

beforeEach(() => {
  __resetBuiltinWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
})

describe('the `select` table column is a closed-set control on one row', () => {
  it('renders a real closed-set PICKER per row, carrying the DECLARED options', async () => {
    // Not a native `<select>`: the design system owns this control, and a browser-drawn menu
    // cannot be styled, cannot render a row as anything but a flat string, and does not match
    // any other picker in the app.
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    const el = rowControl(0)
    expect(el.tagName, 'a native <select> is not the design system’s control').not.toBe('SELECT')
    expect(isPicker(el), 'the column renders the kit picker (role=combobox + popup listbox)').toBe(true)
    expect(await pickerOptions(el)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it("each row shows ITS OWN value — not row 0's, and not the first option", async () => {
    // The positional-binding failure class: a per-row control that evaluates its value
    // against the TABLE's scope rather than the ROW's shows the same thing on every row.
    // Read from what the control DISPLAYS, so a trigger rendering anything other than its
    // binding is caught here rather than downstream of it.
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    expect(shown(rowControl(0))).toBe('alpha')
    expect(shown(rowControl(1))).toBe('gamma')
  })

  it('the option LABEL is what the user reads, and the VALUE is what is bound', async () => {
    // A closed set whose options carry `{value,label}` is how a column states what each
    // choice MEANS at the point of choosing it — the label is not decoration.
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    const el = rowControl(0)
    expect((await pickerOptionNodes(el)).map(o => o.textContent?.trim())).toEqual(OPTIONS.map(o => o.label))
    expect(shown(el)).toBe('alpha')
    // …and the label is what the CLOSED control reads as too, not the raw value.
    expect(shownLabel(el)).toBe('alpha — the first')
  })

  it('changing it dispatches {key, index, value} — the SAME payload editable_text sends', async () => {
    // Parity is the property: one row-field action (`{index, key, value}`) serves every
    // primitive, so adding a closed-set column to an existing table needs no new action.
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    await choosePicker(rowControl(1), 'beta')
    expect(act.payloads).toHaveLength(1)
    expect(act.payloads[0]).toMatchObject({ key: 'choice', index: 1, value: 'beta' })
  })

  it('forwards declared `args` alongside the value (parity with the button primitive)', async () => {
    const act = captureAction()
    const spec = {
      id: 'rows',
      kind: 'table',
      rows: '$state.rows',
      columns: [
        {
          key: 'choice',
          title: 'Choice',
          cell: {
            select: {
              value: '$row.choice',
              options: '$const.choices',
              args: { rowLabel: '$row.label' },
              onChange: act.id,
            },
          },
        },
      ],
    } as unknown as WidgetSpec
    mount(spec, ROWS)
    await choosePicker(rowControl(0), 'beta')
    expect(act.payloads[0]).toMatchObject({ rowLabel: 'first', value: 'beta', index: 0 })
  })

  it('a bound value OUTSIDE the closed set is still SHOWN, never silently swapped', async () => {
    // A control whose bound value matches no option must not fall back to SOMETHING ELSE —
    // a native <select> displayed the first option, and a popover with no matching row would
    // display its placeholder. Either way the store still holds the other value and no change
    // event ever fires, which is precisely what the shipped-form conformance tier forbids. So
    // the bound value is prepended and is both shown and offered.
    const act = captureAction()
    mount(tableSpec(act.id), [{ label: 'stale', choice: 'retired_value' }])
    const el = rowControl(0)
    expect(shown(el)).toBe('retired_value')
    expect(await pickerOptions(el)).toContain('retired_value')
  })

  it('an EMPTY bound value selects nothing — it does not read as the first option', async () => {
    // The other half of the same property: a row whose field is absent must not LOOK like a
    // row that chose the first option, because the two mean different things and only one
    // of them is a decision the user made.
    const act = captureAction()
    mount(tableSpec(act.id), [{ label: 'blank' }])
    const el = rowControl(0)
    expect(shown(el)).toBe('')
    // …and what it READS is not the first option either: the unchosen placeholder is the
    // table's own wording ("Not set" — a row stating a fact about itself), never a real
    // choice's label.
    expect(shownLabel(el)).not.toBe(OPTIONS[0].label)
    // The unchosen reading is a state of the control, not a row smuggled into the choosable
    // set: offering it would let a user "choose" not-choosing.
    expect(await pickerOptions(el)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('with ZERO options and nothing bound it says so and disables (F9 parity)', () => {
    const act = captureAction()
    mount(tableSpec(act.id, '$const.missing'), [{ label: 'blank' }])
    const el = rowControl(0)
    expect(el.hasAttribute('disabled')).toBe(true)
    // The nothing-to-choose state is MARKED on the node the trigger renders, so it stays
    // distinguishable from nothing-chosen by machine as well as by eye.
    expect(el.querySelector('[data-empty="true"]')).not.toBeNull()
    expect(el.textContent).toContain(EMPTY_OPTION_LABEL)
  })

  it('honors a VIEW-AUTHORED `empty_text` in place of the engine wording', () => {
    // The engine's generic wording names the SYMPTOM ("No options yet") at the exact control a
    // user pokes, while the CAUSE — usually another control they have not answered yet — is
    // stated somewhere else on the form, if at all. The standalone `select` widget has been
    // able to say its own sentence since F9; this per-row arm passed the constant
    // unconditionally, so the one closed set most likely to be empty (a per-row picker fed by
    // a binding that depends on another control) was the one that could not speak.
    const act = captureAction()
    const authored = 'No options here yet — they come from the choice above.'
    mount(tableSpec(act.id, '$const.missing', authored), [{ label: 'blank' }])
    const el = rowControl(0)
    expect(el.hasAttribute('disabled')).toBe(true)
    // Inside the collapsed control, where the engine's constant used to be…
    expect(shownLabel(el)).toBe(authored)
    expect(shownLabel(el)).not.toContain(EMPTY_OPTION_LABEL)
    // …and OUTSIDE it too, which is not a duplicate: the trigger is DISABLED (out of the tab
    // order) and carries its own `aria-label` for the row, so its contents are the one thing a
    // keyboard/AT user cannot reach — and one column of a row is narrow, so the sentence is
    // truncated there for everyone else. The standalone widget solved both with a field
    // description; this is the same fact in the arm that had neither.
    const note = screen.getByTestId('widget-rows-select-choice-0-empty')
    expect(note.textContent).toBe(authored)
    expect(el.getAttribute('aria-describedby')).toBe(note.id)
    // A STATE, NOT A FAULT. Having nothing to offer yet is the ordinary opening condition of a
    // dependent picker; announcing it on the channel real errors arrive on is how a reader learns
    // to ignore that channel. The distinction was implicit in where the two notes were RENDERED
    // (one arm wrote `role="alert"`, the other did not) and became a runtime branch the moment
    // both moved into the row's shared band — so it is asserted rather than assumed.
    expect(note.getAttribute('role'), 'an empty-set note must not interrupt like an error').toBeNull()
    const invalid = screen.getByTestId('widget-rows-select-choice-0')
    expect(invalid.getAttribute('aria-invalid'), 'nor mark the control invalid').toBeNull()
  })

  it('an empty control with NO authored sentence still says the engine\'s, inside AND outside', () => {
    // The default arm is not left behind: the reachability fix is about the empty STATE, not
    // about whether a view happened to write a better sentence for it.
    const act = captureAction()
    mount(tableSpec(act.id, '$const.missing'), [{ label: 'blank' }])
    const note = screen.getByTestId('widget-rows-select-choice-0-empty')
    expect(note.textContent).toBe(EMPTY_OPTION_LABEL)
  })

  it('a POPULATED control has no empty note at all (the control case)', () => {
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    expect(screen.queryByTestId('widget-rows-select-choice-0-empty')).toBeNull()
    expect(rowControl(0).getAttribute('aria-describedby')).toBeNull()
  })

  it('with ZERO options but a bound value: keeps the VALUE and still disables', () => {
    // Emptiness is judged on the DECLARED binding, never on the list after the bound value
    // was prepended — otherwise a column whose options resolve to nothing renders as an
    // ordinary ENABLED control holding one raw value, with no way to tell that its choices
    // failed to resolve. The value is never silently lost either.
    const act = captureAction()
    mount(tableSpec(act.id, '$const.missing'), ROWS)
    const el = rowControl(0)
    expect(shown(el)).toBe('alpha')
    expect(el.hasAttribute('disabled')).toBe(true)
    expect(el.querySelector('[data-empty="true"]')).not.toBeNull()
  })

  it("carries the SELECTED option's full label as a hover title", () => {
    // A table column is narrow, and a closed set whose labels say what each choice MEANS
    // is exactly the case where the meaning gets truncated away: the collapsed control
    // renders "gamma —" where the label reads "gamma — the third". The popup still shows it
    // in full, and a screen reader reads the selected row's text — but at rest, in a docked
    // pane, a sighted user sees only the stem. The title makes the whole definition
    // reachable without opening the control or widening the pane.
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    expect(rowControl(1).querySelector('[data-value]')?.getAttribute('title')).toBe('gamma — the third')
  })

  it('the hover title falls back to the raw VALUE when it matches no option', () => {
    const act = captureAction()
    mount(tableSpec(act.id), [{ label: 'stale', choice: 'retired_value' }])
    expect(rowControl(0).querySelector('[data-value]')?.getAttribute('title')).toBe('retired_value')
  })

  it('every rendered row control has an accessible name that carries its ROW', () => {
    // N identical controls in a column are indistinguishable to a screen-reader or voice
    // user unless each names its row — the same reason the per-row action button does.
    const act = captureAction()
    mount(tableSpec(act.id), ROWS)
    const names = [0, 1].map(i => rowControl(i).getAttribute('aria-label'))
    expect(names[0]).toBeTruthy()
    expect(names[1]).toBeTruthy()
    expect(names[0]).not.toBe(names[1])
  })

  it('a PER-ROW verdict addressed to this column lands on THAT row, and takes the note over', () => {
    // The other half of the address: a `check` with `at: {widget, part, index}` files its
    // verdict under the same key this control reads, so a relation about one row of a list has
    // somewhere to land. Without a rendering proof, a `check` can be perfectly well-formed —
    // valid part key, gate correctly closed — and still say nothing on screen, which is the
    // "disabled with no stated cause" defect one level further in.
    const act = captureAction()
    const spec = tableSpec(act.id)
    const scope: Scope = {
      params: {},
      state: { rows: ROWS },
      derived: {},
      const: { choices: OPTIONS },
      data: {},
      [FORM_VALIDITY_SCOPE_KEY]: {
        verdicts: new Map([
          [
            instanceKey('rows', [0], partKey('choice', 1)),
            {
              key: instanceKey('rows', [0], partKey('choice', 1)),
              widgetId: 'rows',
              kind: 'check' as const,
              message: 'That choice is not available here any more.',
              empty: false,
              unsatisfiable: false,
            },
          ],
        ]),
        gate: { canSubmit: false },
        summary: [],
        elided: 0,
        submitActions: new Set<string>(),
      },
    }
    installBuiltinWidgets()
    render(<WidgetList specs={[spec]} scope={scope} viewId="v1" specId="tsc" />)
    const el = rowControl(1)
    const message = screen.getByTestId('widget-rows-select-choice-1-error')
    expect(message.textContent).toBe('That choice is not available here any more.')
    expect(message.getAttribute('role')).toBe('alert')
    expect(el.getAttribute('aria-describedby')).toBe(message.id)
    expect(el.getAttribute('aria-invalid')).toBe('true')
    // …and ONLY that row. A key built from the widget id alone lands one row's message on
    // every row, which reads as a working control until two rows disagree.
    expect(screen.queryByTestId('widget-rows-select-choice-0-error')).toBeNull()
  })

  it('the other column primitives are untouched — a table may mix all three', () => {
    const act = captureAction()
    const spec = {
      id: 'mixed',
      kind: 'table',
      rows: '$state.rows',
      columns: [
        { key: 'label', title: 'Label', cell: { editable_text: { value: '$row.label', onChange: act.id } } },
        { key: 'choice', title: 'Choice', cell: { select: { value: '$row.choice', options: '$const.choices', onChange: act.id } } },
        { key: 'drop', title: '', cell: { button: { label: 'Remove', variant: 'destructive', onClick: act.id } } },
      ],
    } as unknown as WidgetSpec
    mount(spec, ROWS)
    expect(screen.getByTestId('widget-mixed-edit-label-0')).not.toBeNull()
    expect(rowControl(0, 'choice', 'mixed')).not.toBeNull()
    expect(screen.getByTestId('widget-mixed-action-drop-0')).not.toBeNull()
  })
})
