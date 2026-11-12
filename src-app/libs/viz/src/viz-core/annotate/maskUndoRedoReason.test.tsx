// @vitest-environment jsdom
//
// MASK UNDO/REDO — THE UN-MIGRATED TWIN OF `AnnotateControls`.
//
// `AnnotateControls` sits one directory over and states both of these refusals out loud
// (`unavailableReason={canUndo ? undefined : 'Nothing to undo'}`). `MaskReviewControls` does the
// same job over a segmentation mask with raw `<button disabled={!canUndo}>` — so the correction
// panel most likely to leave a user mid-edit is the one that says nothing when it refuses. A
// natively `disabled` button is also out of the tab order, so a keyboard user loses the control
// entirely rather than hearing why it is unavailable.
//
// It is LIVE: `GridDockLayer` passes `canUndo`/`canRedo`/`onUndo`/`onRedo` from the
// `maskCorrectController`, which is what mounts the pair at all (the showcase story omits them,
// so the block does not render there — checked, not assumed).
//
// DEC-6 keeps this panel on raw elements rather than `@txresbench/kit`, so the remedy is hand-built to
// the same contract the kit's `unavailableReason` provides: `aria-disabled` + a dropped handler
// (hoverable AND focusable), the reason in `aria-describedby`, and the NAME left intact so a
// screen-reader user can still tell WHICH control refused them.
//
// Asserted on the rendered DOM and by DRIVING a click — never on props, never on a console spy.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MaskReviewControls } from './MaskReviewControls'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(cleanup)

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

const describedText = (el: Element): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/).filter(Boolean)
    .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ').trim()

const CATS = [{ code: 1, label: 'Nucleus' }]

function mount(o: { canUndo?: boolean; canRedo?: boolean; onUndo?: () => void; onRedo?: () => void }) {
  render(
    <MaskReviewControls
      categories={CATS}
      hiddenCategories={new Set<number>()}
      soloCategory={null}
      onToggleHidden={() => {}}
      onSolo={() => {}}
      activeTool={null}
      onSelectTool={() => {}}
      canUndo={o.canUndo}
      canRedo={o.canRedo}
      onUndo={o.onUndo ?? (() => {})}
      onRedo={o.onRedo ?? (() => {})}
    />,
  )
}

/** The whole contract for one refused control, in the order a user meets it. */
function expectRefusalExplains(testid: string, reason: string, name: string): void {
  const el = byTestId(testid)
  expect(describedText(el), `${testid}: the reason must reach assistive tech`).toBe(reason)
  expect(el.getAttribute('title'), `${testid}: and a pointer user must be able to read it`).toBe(reason)
  expect(el.getAttribute('aria-label'), `${testid}: the reason must not swallow the NAME`).toBe(name)
  expect(el.getAttribute('aria-disabled'), `${testid}: must be marked unavailable`).toBe('true')
  expect(
    el.hasAttribute('disabled'),
    `${testid}: a natively disabled button is out of the tab order — the keyboard user loses it`,
  ).toBe(false)
}

describe('MaskReviewControls Undo/Redo state their refusal', () => {
  it('with nothing to undo, Undo says so — in both channels, keeping its name', () => {
    mount({ canUndo: false, canRedo: true })
    expectRefusalExplains('viz-mask-undo', 'Nothing to undo', 'Undo correction')
  })

  it('with nothing to redo, Redo says so', () => {
    mount({ canUndo: true, canRedo: false })
    expectRefusalExplains('viz-mask-redo', 'Nothing to redo', 'Redo correction')
  })

  it('a refused Undo does NOT fire — aria-disabled is a claim, not an enforcement', () => {
    // Without this, dropping the native `disabled` would turn a silent refusal into a live-looking
    // button that undoes something there is nothing to undo — strictly worse than what it replaced.
    const onUndo = vi.fn()
    mount({ canUndo: false, canRedo: true, onUndo })
    fireEvent.click(byTestId('viz-mask-undo'))
    expect(onUndo).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL — an available Undo is live, unmarked, and DOES fire', () => {
    const onUndo = vi.fn()
    mount({ canUndo: true, canRedo: true, onUndo })
    const el = byTestId('viz-mask-undo')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(describedText(el), 'an available control has no refusal to state').toBe('')
    fireEvent.click(el)
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE CONTROL — an available Redo is live and fires', () => {
    const onRedo = vi.fn()
    mount({ canUndo: true, canRedo: true, onRedo })
    fireEvent.click(byTestId('viz-mask-redo'))
    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it('the two reason nodes have DISTINCT ids — one id would make Redo announce Undo’s reason', () => {
    // The kit reaches for `useId` here for exactly this: two hand-built nodes sharing an id means
    // the browser resolves both `aria-describedby`s to whichever came first.
    mount({ canUndo: false, canRedo: false })
    const a = byTestId('viz-mask-undo').getAttribute('aria-describedby')
    const b = byTestId('viz-mask-redo').getAttribute('aria-describedby')
    expect(a).not.toBeNull()
    expect(a).not.toBe(b)
    expect(describedText(byTestId('viz-mask-undo'))).toBe('Nothing to undo')
    expect(describedText(byTestId('viz-mask-redo'))).toBe('Nothing to redo')
  })
})
