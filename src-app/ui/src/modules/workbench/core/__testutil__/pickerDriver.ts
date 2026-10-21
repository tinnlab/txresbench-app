// Driving a POPOVER picker from a jsdom test — the two gestures a user makes, and nothing else.
//
// The artifact picker is a popover control (the kit `Select` for one artifact, the kit
// `MultiSelect` for many), so its options DO NOT EXIST in the DOM until it is opened, and a
// choice is committed by clicking a row rather than by setting a value. Every tier that asserts
// something about that control has to drive it the way a user does, or it is asserting against a
// binding it wrote itself.
//
// It lives here, once, because three suites need it (the shipped-form conformance tier, the
// widget suite, the value-preview suite) and a copy in each would drift silently: a driver that
// no longer commits is indistinguishable from a control that no longer changes — every
// assertion downstream of it just stops being reached.

import { act, fireEvent } from '@testing-library/react'

/**
 * A SINGLE-artifact picker's trigger.
 *
 * `role="combobox"` alone would also match the `multiple` arm, whose trigger is deliberately a
 * DIV (so its removable tag `<button>`s can legally nest inside it); a single-value trigger has
 * nothing to nest and is a real `<button>`.
 */
export const isSinglePicker = (el: Element | null | undefined): boolean =>
  el instanceof HTMLButtonElement && el.getAttribute('role') === 'combobox'

/** Any picker trigger, single or multiple.
 *
 *  Plain `boolean`, deliberately, not a type predicate: the callers already hold an
 *  `HTMLElement`, and a predicate would narrow the ELSE branch to `never` — which turns a
 *  perfectly good "not a picker, handle it the old way" fallback into a type error. */
export const isPicker = (el: Element | null | undefined): boolean =>
  el instanceof HTMLElement &&
  el.getAttribute('role') === 'combobox' &&
  el.getAttribute('aria-haspopup') === 'listbox'

/**
 * What a picker's trigger DISPLAYS as chosen, read off the DOM.
 *
 * A popover control has no `value` property to interrogate — the closed trigger renders the
 * choice, and the node that renders it carries the id/value it names (`data-artifact-id` for
 * the artifact picker's `ChosenArtifact`, `data-value` for every other closed set's
 * `ChosenOption`). Reading that is the same question `sel.value` answered for a native
 * control, and it covers the `multiple` arm too, which shows one node per tag.
 *
 * EMPTY means nothing is chosen — the trigger is showing its placeholder. That is a real
 * state, not a failure to read: it is exactly what "you have not chosen yet" looks like, and
 * distinguishing it from a made choice is the property both tiers assert.
 */
export const pickerShownValues = (control: HTMLElement): string[] =>
  [...control.querySelectorAll('[data-artifact-id], [data-value]')]
    .map(n => n.getAttribute('data-artifact-id') ?? n.getAttribute('data-value') ?? '')
    .filter(Boolean)

/** Open the picker if it is closed. Idempotent — a `multiple` picker stays open across choices,
 *  a single one closes itself after each. */
export async function openPicker(control: HTMLElement): Promise<void> {
  if (control.getAttribute('aria-expanded') === 'true') return
  await act(async () => {
    fireEvent.click(control)
    await Promise.resolve()
  })
}

/** The option ROWS a rendered picker offers (the kit stamps `${testid}-opt-${value}` on both
 *  arms). Opens the picker and leaves it open. */
export async function pickerOptionNodes(control: HTMLElement): Promise<HTMLElement[]> {
  const testid = control.getAttribute('data-testid') ?? ''
  await openPicker(control)
  return [...document.querySelectorAll<HTMLElement>(`[role="option"][data-testid^="${testid}-opt-"]`)]
}

/** Is this option row REFUSING to be chosen?
 *
 *  Read from the two markers a row can carry, and from the VALUE of `data-disabled` rather than
 *  its mere presence: one primitive stamps the attribute only when disabled (presence = true),
 *  the other stamps it always (`data-disabled="false"` on every enabled row). A presence test
 *  reports every row of the second as disabled, which does not fail — it makes the offered set
 *  read as EMPTY, and an assertion about an empty set passes having looked at nothing. */
const optionIsDisabled = (o: HTMLElement): boolean =>
  o.getAttribute('aria-disabled') === 'true' ||
  (o.hasAttribute('data-disabled') && o.getAttribute('data-disabled') !== 'false')

/** The VALUES a rendered picker offers, disabled rows excluded. */
export async function pickerOptions(control: HTMLElement): Promise<string[]> {
  const prefix = `${control.getAttribute('data-testid') ?? ''}-opt-`
  return (await pickerOptionNodes(control))
    .filter(o => !optionIsDisabled(o))
    .map(o => (o.getAttribute('data-testid') ?? '').slice(prefix.length))
}

/**
 * Choose `value` THROUGH the control — open it, click that row.
 *
 * The three events are what base-ui's option row commits on: a click alone is not enough, since
 * it tracks the press so that a press-drag-release across the list also selects. (Established
 * against the real control, not assumed — a `click`-only driver silently selects NOTHING, which
 * reads exactly like a picker whose options do not work.)
 */
export async function choosePicker(control: HTMLElement, value: string): Promise<void> {
  const testid = control.getAttribute('data-testid') ?? ''
  await openPicker(control)
  const opt = document.querySelector<HTMLElement>(`[role="option"][data-testid="${testid}-opt-${value}"]`)
  if (!opt) throw new Error(`picker "${testid}" offers no option for ${value}`)
  await act(async () => {
    fireEvent.pointerDown(opt)
    fireEvent.pointerUp(opt)
    fireEvent.click(opt)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** The group HEADINGS an open picker draws, in render order — the dataset→artifact hierarchy as
 *  a user reads it. Empty when the picker draws no headings (one dataset ⇒ no heading).
 *
 *  A heading that is present but HIDDEN is not drawn: the searchable arm removes a run whose
 *  every option filtered out, and a reader that counted hidden nodes would report a heading the
 *  user cannot see — which is exactly the empty-heading defect this is used to rule out. */
export async function pickerGroupHeadings(control: HTMLElement): Promise<string[]> {
  await openPicker(control)
  return [...document.querySelectorAll<HTMLElement>('[data-slot="select-label"], [cmdk-group-heading]')]
    .filter(el => el.closest('[hidden]') === null)
    .map(el => el.textContent?.trim() ?? '')
}

// ── the SEARCH affordance ────────────────────────────────────────────────────────────────
//
// A picker past the search threshold puts a text field in its popup, and typing there is the
// SECOND way a user operates the control (the first is scrolling to a row). Both have to be
// drivable from a test, or the filter is only ever exercised by reading the function that
// implements it — which is the shape of a test that cannot fail.

/** The picker's SEARCH field, or `null` when it offers none (below the threshold). Opens the
 *  picker and leaves it open, like every other reader here. */
export async function pickerSearchInput(control: HTMLElement): Promise<HTMLInputElement | null> {
  const testid = control.getAttribute('data-testid') ?? ''
  await openPicker(control)
  return document.querySelector<HTMLInputElement>(`input[data-testid="${testid}-search"]`)
}

/**
 * Type `query` into the picker's search field.
 *
 * THROWS when the picker offers no search field, for the same reason `choosePicker` throws on a
 * missing option: a driver that quietly did nothing would report a picker whose search vanished
 * as one whose search matches everything, and every assertion downstream of it would pass having
 * filtered nothing.
 */
export async function typeInPicker(control: HTMLElement, query: string): Promise<void> {
  const input = await pickerSearchInput(control)
  if (!input) throw new Error(`picker "${control.getAttribute('data-testid')}" offers no search field`)
  await act(async () => {
    fireEvent.change(input, { target: { value: query } })
    await Promise.resolve()
  })
}

/**
 * Choose THROUGH THE KEYBOARD — type, arrow, Enter — never touching a row with the pointer.
 *
 * The searchable arm moves focus into a text field on open, so the pointer path and the keyboard
 * path no longer share a single implementation the way a plain listbox's do. A keyboard user who
 * can filter but cannot commit has a control that is operable by eye and inert by hand, and that
 * is invisible to every click-driven assertion in the suite.
 */
export async function chooseByKeyboard(
  control: HTMLElement,
  query: string,
  arrowDowns = 0,
): Promise<void> {
  const input = await pickerSearchInput(control)
  if (!input) throw new Error(`picker "${control.getAttribute('data-testid')}" offers no search field`)
  if (query !== '') await typeInPicker(control, query)
  // ONE keystroke per commit. Batching them into a single `act` is not "faster" — it is a
  // DIFFERENT interaction: React would not re-render between the arrow and the Enter, so Enter
  // would read the cursor position the arrow was about to replace and commit the row the user
  // moved OFF of. A real keypress lands in its own task with a paint behind it.
  for (let i = 0; i < arrowDowns; i++) {
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      await Promise.resolve()
    })
  }
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}
