// @vitest-environment jsdom
//
// SEARCH inside the generic closed-set control.
//
// Reported from the live app: "all selections need to be searchable". Only the MULTI picker
// ever had a search field; every single-value picker in the declarative vocabulary — the
// `select` widget (which is what a criterion's Column picker actually is), the per-row table
// column, the dataset picker — was a list you could only scroll. That is fine at four options
// and unusable at four hundred, which is the size a real project's column list actually
// reaches, and it is the reason the request was made.
//
// The property under test is not "a text field exists". It is:
//
//   · typing NARROWS the offered set, and the narrowing is read off what the control OFFERS
//     (through the shared driver) rather than off the filter function agreeing with itself;
//   · a filter that matches nothing SAYS so, rather than rendering an empty popup;
//   · the whole control is still operable BY KEYBOARD — the search field takes focus on open,
//     so the pointer path and the keyboard path stopped being the same code and a keyboard
//     user who can filter but cannot commit has a control that is inert by hand;
//   · and search is absent BELOW the threshold. A search box over four options is a second
//     thing to read for reach the eye already has, so the threshold has two sides and both
//     are asserted — a change that made search unconditional passes every test above.
//
// This file names no domain vocabulary on purpose: a primitive that only reads correctly with
// one analysis's nouns in it is not generic.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { SELECT_SEARCH_THRESHOLD } from '@txresbench/kit'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import { __clearWidgetsForTests } from '@/modules/workbench/core/render/registry'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import {
  NO_MATCHING_OPTION_LABEL,
  SEARCH_OPTION_PLACEHOLDER,
  UNCHOSEN_OPTION_LABEL,
} from './renderers'
import {
  chooseByKeyboard,
  choosePicker,
  isPicker,
  pickerOptionNodes,
  pickerOptions,
  pickerSearchInput,
  pickerShownValues,
  typeInPicker,
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
/** Register the REAL action the widget names, capturing every dispatched payload. The action
 *  registry is process-global with no reset seam, so each test mints its own id. */
function captureAction(): { id: string; payloads: Record<string, unknown>[] } {
  const local = `pickOne${++seq}`
  const box = { id: local, payloads: [] as Record<string, unknown>[] }
  defineAction({
    id: `rs::${local}`,
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

/** `n` abstract options, `metric_00 … metric_NN`. Two-digit so a query is an exact prefix
 *  rather than a substring that also matches its own neighbours. */
const metrics = (n: number): Array<{ value: string; label: string }> =>
  Array.from({ length: n }, (_, i) => {
    const k = String(i).padStart(2, '0')
    return { value: `metric_${k}`, label: `metric_${k}` }
  })

const selectSpec = (onChange: string): WidgetSpec =>
  ({
    id: 'colPicker',
    kind: 'select',
    label: 'Column',
    options: '$const.choices',
    value: '$state.pick',
    onChange,
  }) as unknown as WidgetSpec

function mount(options: unknown[], onChange = 'noop', state: Record<string, unknown> = { pick: '' }): void {
  installBuiltinWidgets()
  const scope: Scope = { params: {}, state, derived: {}, const: { choices: options }, data: {} }
  render(<WidgetList specs={[selectSpec(onChange)]} scope={scope} viewId="v1" specId="rs" />)
}

const control = (): HTMLElement => screen.getByTestId('widget-colPicker')

/** The popup a picker drew — where the search field and the no-match line live. */
const popup = (): HTMLElement | null => document.querySelector('[data-testid="widget-colPicker-popup"]')

beforeEach(() => {
  __resetBuiltinWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// The THRESHOLD — and both of its sides
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('search is offered once a list stops fitting — and not before', () => {
  it(`a list of ${SELECT_SEARCH_THRESHOLD - 1} offers NO search field`, async () => {
    // The negative side, and it is the one that keeps the change honest: a search box over a
    // list the eye already takes in whole is one more thing to read for no reach it does not
    // already have. Without this assertion, "make it searchable" and "make it searchable
    // ALWAYS" are the same change and the difference is untested.
    mount(metrics(SELECT_SEARCH_THRESHOLD - 1))
    expect(await pickerSearchInput(control())).toBeNull()
  })

  it(`a list of ${SELECT_SEARCH_THRESHOLD} offers one`, async () => {
    mount(metrics(SELECT_SEARCH_THRESHOLD))
    expect(await pickerSearchInput(control())).not.toBeNull()
  })

  it('a searchable picker is still THE SAME control — trigger, testid, offered set', async () => {
    // The searchable arm is a different composition underneath, so everything the closed-set
    // control had already earned has to be re-asserted ON it: a control that gains a filter
    // and loses its testid, its role, or its placeholder is not an improvement.
    mount(metrics(SELECT_SEARCH_THRESHOLD))
    const el = control()
    expect(isPicker(el), 'still the kit picker (role=combobox + popup listbox)').toBe(true)
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('Column')
    // Nothing is bound, so it reads as unchosen — and the placeholder is a STATE of the
    // control, never a row a user can pick.
    expect(pickerShownValues(el)).toEqual([])
    expect((el.querySelector('[data-slot="select-value"]')?.textContent ?? '').trim()).toBe(
      UNCHOSEN_OPTION_LABEL,
    )
    const offered = await pickerOptions(el)
    expect(offered).toHaveLength(SELECT_SEARCH_THRESHOLD)
    expect(offered).not.toContain(UNCHOSEN_OPTION_LABEL)
  })

  it('the search field carries its own accessible name', async () => {
    // Every rendered affordance must be nameable — the shipped-form conformance tier asserts
    // exactly this over every `input` it finds, so an unnamed search field would fail that
    // tier the moment a shipped form crossed the threshold.
    mount(metrics(SELECT_SEARCH_THRESHOLD))
    const input = await pickerSearchInput(control())
    const labelledby = input?.getAttribute('aria-labelledby')
    const named =
      (input?.getAttribute('aria-label') ?? '').trim() !== '' ||
      (labelledby != null && (document.getElementById(labelledby)?.textContent ?? '').trim() !== '')
    expect(named, `the search field has no accessible name: ${input?.outerHTML.slice(0, 200)}`).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// TYPING narrows what is offered
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('typing filters the OFFERED set', () => {
  it('narrows to the matches, and the non-matches are gone — not merely styled away', async () => {
    mount(metrics(12))
    const el = control()
    expect(await pickerOptions(el)).toHaveLength(12)
    await typeInPicker(el, 'metric_1')
    // metric_10 / metric_11 only. A filter that hid rows with CSS would still offer all 12
    // here, which is why this reads the offered set rather than a visibility flag.
    expect((await pickerOptions(el)).sort()).toEqual(['metric_10', 'metric_11'])
  })

  it('is case-insensitive, and matches anywhere in the label', async () => {
    mount([
      { value: 'a', label: 'Alpha reading' },
      { value: 'b', label: 'Beta reading' },
      ...metrics(10),
    ])
    const el = control()
    await typeInPicker(el, 'ALPHA')
    expect(await pickerOptions(el)).toEqual(['a'])
    await typeInPicker(el, 'reading')
    expect((await pickerOptions(el)).sort()).toEqual(['a', 'b'])
  })

  it('clearing the query restores the whole set', async () => {
    mount(metrics(12))
    const el = control()
    await typeInPicker(el, 'metric_11')
    expect(await pickerOptions(el)).toEqual(['metric_11'])
    await typeInPicker(el, '')
    expect(await pickerOptions(el)).toHaveLength(12)
  })

  it('a query that matches NOTHING says so, in the shared wording', async () => {
    // An empty popup is the illegible state this whole vocabulary exists to remove: it reads
    // identically to a control that is broken. The multi picker already answers this with
    // `emptyText`; the single one now answers it the same way rather than inventing a second.
    mount(metrics(12))
    const el = control()
    await typeInPicker(el, 'no_such_option')
    expect(await pickerOptions(el)).toEqual([])
    expect(popup()?.textContent).toContain(NO_MATCHING_OPTION_LABEL)
  })

  it('the search field states what it does', async () => {
    mount(metrics(12))
    const input = await pickerSearchInput(control())
    expect(input?.getAttribute('placeholder')).toBe(SEARCH_OPTION_PLACEHOLDER)
  })

  it('a filtered list still commits by POINTER — the old gesture did not stop working', async () => {
    const act = captureAction()
    mount(metrics(12), act.id)
    const el = control()
    await typeInPicker(el, 'metric_07')
    await choosePicker(el, 'metric_07')
    await waitFor(() => expect(act.payloads).toHaveLength(1))
    expect(act.payloads[0]).toMatchObject({ value: 'metric_07' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// KEYBOARD — type, move, commit
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('the searchable picker is operable end to end from the keyboard', () => {
  it('type then Enter commits the match', async () => {
    // The gesture a keyboard user actually makes. It is a DIFFERENT path from the pointer one
    // now that focus lands in a text field on open, so it needs its own assertion — a control
    // that filters but never commits looks perfect in a screenshot.
    const act = captureAction()
    mount(metrics(12), act.id)
    await chooseByKeyboard(control(), 'metric_09')
    await waitFor(() => expect(act.payloads).toHaveLength(1))
    expect(act.payloads[0]).toMatchObject({ value: 'metric_09' })
  })

  it('ArrowDown moves within the FILTERED set, and Enter takes what it landed on', async () => {
    // Arrow keys that walked the unfiltered list would commit a row the user cannot see, so
    // the query narrows and the cursor moves inside the narrowing.
    const act = captureAction()
    mount(metrics(12), act.id)
    await chooseByKeyboard(control(), 'metric_1', 1)
    await waitFor(() => expect(act.payloads).toHaveLength(1))
    expect(act.payloads[0]).toMatchObject({ value: 'metric_11' })
  })

  it('committing CLOSES the picker and shows the choice', async () => {
    const act = captureAction()
    mount(metrics(12), act.id)
    const el = control()
    await chooseByKeyboard(el, 'metric_05')
    await waitFor(() => expect(act.payloads).toHaveLength(1))
    expect(el.getAttribute('aria-expanded')).not.toBe('true')
    // The store here is a literal, so re-mount with what the action would have written and
    // assert the DISPLAY of that binding.
    cleanup()
    mount(metrics(12), 'noop', { pick: 'metric_05' })
    expect(pickerShownValues(control())).toEqual(['metric_05'])
  })

  it('Enter on a query that matches nothing commits nothing', async () => {
    const act = captureAction()
    mount(metrics(12), act.id)
    await chooseByKeyboard(control(), 'no_such_option')
    expect(act.payloads).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// The wiring a screen reader reads
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('the searchable listbox is wired for assistive tech', () => {
  // Everything above this block is about what a SIGHTED user can do. All of it can be true
  // while a screen-reader user hears nothing: the highlight is a background colour, and the
  // only thing that turns it into an announcement is `aria-activedescendant`. It is stated
  // separately here because it is separately breakable — a first draft of this control passed
  // every keyboard test above while never naming the active row at all.

  /** What the search field says the keyboard is ON. */
  const activeDescendant = async (): Promise<Element | null> => {
    const input = await pickerSearchInput(control())
    const id = input?.getAttribute('aria-activedescendant')
    return id ? document.getElementById(id) : null
  }

  it('the trigger reports its state and names the list it controls', async () => {
    mount(metrics(12))
    const el = control()
    expect(el.getAttribute('aria-expanded')).toBe('false')
    expect(el.getAttribute('aria-haspopup')).toBe('listbox')
    await pickerSearchInput(el) // opens
    expect(el.getAttribute('aria-expanded')).toBe('true')
    const controls = el.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls!)?.getAttribute('role')).toBe('listbox')
  })

  it('the search field NAMES the row the keyboard is on', async () => {
    mount(metrics(12))
    const row = await activeDescendant()
    expect(row, 'nothing is announced as active on open').not.toBeNull()
    expect(row?.getAttribute('role')).toBe('option')
    expect(row?.getAttribute('data-testid')).toBe('widget-colPicker-opt-metric_00')
  })

  it('RE-NAMES it as the filter narrows — never a row that filtered away', async () => {
    // The exact failure a filtered list invites: the cursor keeps naming the row it was on,
    // which is no longer in the DOM, so the announcement points at nothing while a different
    // row is visibly highlighted.
    mount(metrics(12))
    await typeInPicker(control(), 'metric_1')
    const row = await activeDescendant()
    expect(row, 'the announced row vanished with the filter').not.toBeNull()
    expect(row?.getAttribute('data-testid')).toBe('widget-colPicker-opt-metric_10')
    expect(row?.isConnected).toBe(true)
  })

  it('follows the arrow keys', async () => {
    mount(metrics(12))
    const input = (await pickerSearchInput(control()))!
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      await Promise.resolve()
    })
    expect((await activeDescendant())?.getAttribute('data-testid')).toBe(
      'widget-colPicker-opt-metric_01',
    )
  })

  it('names NOTHING when the filter offers nothing — rather than a stale row', async () => {
    mount(metrics(12))
    await typeInPicker(control(), 'no_such_option')
    const input = await pickerSearchInput(control())
    expect(input?.getAttribute('aria-activedescendant')).toBeNull()
  })

  it('marks the CHOSEN row as selected, and only that one', async () => {
    // `aria-selected` is the CHOICE, not the cursor — the two are different facts and a
    // listbox that conflates them tells a screen reader the highlighted row is already picked.
    mount(metrics(12), 'noop', { pick: 'metric_07' })
    const rows = await pickerOptionNodes(control())
    const selected = rows.filter(r => r.getAttribute('aria-selected') === 'true')
    expect(selected.map(r => r.getAttribute('data-testid'))).toEqual([
      'widget-colPicker-opt-metric_07',
    ])
  })
})
