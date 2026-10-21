// @vitest-environment jsdom
//
// A REASON CHANNEL THAT CALLERS CAN IGNORE IS WORSE THAN NO CHANNEL AT ALL.
//
// ── The defect ─────────────────────────────────────────────────────────────────────────────
// `SettingsFormActions` has had a `saveDisabledReason` since Spec B ("Save is ALWAYS the
// saturated primary; a disabled one needs a tooltip that says why"). Of its SEVEN call sites,
// FIVE disable the Save and exactly ONE supplies the reason. So four cards ship a greyed accent
// button that explains nothing — and the prop's existence is what made that invisible: a reviewer
// reading the component sees a covered case, and a reviewer reading a call site sees a prop they
// were free to omit. The Cancel had no reason channel at ALL, and four of those callers disable
// it too (`cancelDisabled={!canManage}`).
//
// The four also conflate TWO refusals into one grey: "you cannot manage this" and "there is
// nothing to save yet" are different sentences with different remedies, and neither was said.
//
// ── The fix is a TYPE, not a convention ────────────────────────────────────────────────────
// Adding the missing strings would have left the seam exactly as weak as it was — the next caller
// omits it again. `saveDisabled: boolean` + `saveDisabledReason?: string` is replaced by ONE
// `saveUnavailableReason?: string` (presence means unavailable, the string IS the reason), and
// `cancelDisabled` likewise. There is now NO WAY TO EXPRESS "refused, no reason": the boolean
// that made it expressible is gone, and every existing caller had to be migrated to compile.
// (The kit's `unavailableReason` idiom, so the Tooltip-on-a-focusable-span workaround this
// component hand-rolled goes away with it: an `aria-disabled` button is hoverable AND focusable,
// and carries the reason in the a11y tree too.)
//
// ── The oracle ─────────────────────────────────────────────────────────────────────────────
// Hover the rendered control and read the document. Not props, not source text — and NOT a
// console spy, which base-ui dedupes process-wide.

import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SettingsFormActions } from './SettingsFormActions'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

afterEach(cleanup)

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

async function hover(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el, { bubbles: true })
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => { await new Promise(r => setTimeout(r, 700)) })
}

const shown = (): string =>
  Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .map(t => (t.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join('|')

const describedText = (el: Element): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/).filter(Boolean)
    .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ').trim()

/** The whole contract for one refused action, in the order a user meets it. */
async function expectRefusalExplains(testid: string, reason: string): Promise<void> {
  const el = byTestId(testid)
  await hover(el)
  expect(shown(), `${testid}: hovering an unavailable control must show WHY`).toBe(reason)
  expect(describedText(el), `${testid}: the reason must also reach assistive tech`).toBe(reason)
  expect(el.getAttribute('aria-disabled'), `${testid}: must be marked unavailable`).toBe('true')
  expect(
    el.hasAttribute('disabled'),
    `${testid}: a natively disabled button is pointer-events:none AND out of the tab order`,
  ).toBe(false)
}

const base = {
  onSave: () => {},
  onCancel: () => {},
  saveTestid: 'x-save',
  cancelTestid: 'x-cancel',
} as const

describe('SettingsFormActions — a refused Save states its reason', () => {
  it('a permission refusal names the permission, reachably and in both channels', async () => {
    render(<SettingsFormActions {...base} saveUnavailableReason="You do not have permission to change these settings" />)
    await expectRefusalExplains('x-save', 'You do not have permission to change these settings')
  })

  it('a pristine-form refusal is a DIFFERENT sentence — the two used to share one grey button', async () => {
    render(<SettingsFormActions {...base} saveUnavailableReason="No changes to save" />)
    await expectRefusalExplains('x-save', 'No changes to save')
  })

  it('NEGATIVE CONTROL — an available Save is live and opens no refusal text', async () => {
    render(<SettingsFormActions {...base} />)
    const el = byTestId('x-save')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
    await hover(el)
    expect(shown()).toBe('')
  })

  it('an EMPTY reason is not a reason — it must not silently render a refused control', async () => {
    // The empty-string case is how a caller that computes its reason conditionally
    // (`cond ? '' : undefined`) would re-introduce a silent refusal through the new seam.
    render(<SettingsFormActions {...base} saveUnavailableReason="" />)
    const el = byTestId('x-save')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
  })
})

describe('SettingsFormActions — Cancel had NO reason channel at all', () => {
  it('a refused Cancel states its reason', async () => {
    render(<SettingsFormActions {...base} cancelUnavailableReason="You do not have permission to change these settings" />)
    await expectRefusalExplains('x-cancel', 'You do not have permission to change these settings')
  })

  it('while SAVING, Cancel says what it is waiting for instead of going silently grey', async () => {
    render(<SettingsFormActions {...base} saving />)
    const el = byTestId('x-cancel')
    expect(el.getAttribute('aria-disabled')).toBe('true')
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(describedText(el)).not.toBe('')
  })

  it('NEGATIVE CONTROL — an idle Cancel is live and silent', async () => {
    render(<SettingsFormActions {...base} />)
    const el = byTestId('x-cancel')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
    await hover(el)
    expect(shown()).toBe('')
  })
})
