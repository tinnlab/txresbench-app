// @vitest-environment jsdom
//
// A CONTROL THAT REFUSES A USER MUST BE ABLE TO SAY WHY — asserted by OPENING the hover text,
// never by reading a prop.
//
// ── The defect these tests were written against ────────────────────────────────────────────
// A natively `disabled` <button> can open NO React tooltip at all. Two independent reasons,
// either sufficient: the kit's `buttonVariants` sets `disabled:pointer-events-none`, and even
// without it a disabled control's mouse events never reach the DOCUMENT ROOT, which is where
// React listens (it delegates there). A document-level listener records ZERO `mouseover` on a
// disabled button, capture and bubble alike.
//
// So `<Button disabled tooltip="Move selection (select something first)">` shipped a sentence
// no user could ever read — and that sentence was the ONLY place the reason existed. The
// control was greyed, unexplained, and silent about it.
//
// ── WHY THESE ASSERT THE RENDERED DOM, AND NOT A CONSOLE SPY ───────────────────────────────
// The kit warns about this class in dev. Asserting THAT WARNING would be the wrong oracle
// twice over: base-ui (and the kit's own `inertTooltipsWarned`) dedupe warnings PROCESS-WIDE,
// so a spy in the second test of a file passes because an earlier render already consumed the
// message — it passes for the wrong reason, and it passes against unfixed source. Measured:
// exactly that test was written first, and it was green on the broken tree.
//
// The oracle here is what a user gets: hover the control, then look for the text in the
// document. That is red on `disabled` and green on `aria-disabled`, with no way to fake it.
//
// ── THE REMEDY THESE PIN (commit 93167985, `PaneToolbar.blockedAction`) ────────────────────
// `aria-disabled` + no click handler. The control stays hoverable AND focusable, so both the
// pointer channel (tooltip) and the assistive-tech channel (`aria-describedby` → an sr-only
// node) can carry the reason, while `aria-label` keeps saying what the control IS. A native
// `disabled` drops the control out of the tab order entirely, so a reason parked there is
// unreachable to a keyboard user even in principle.

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { VizToolRail } from './VizToolRail'
import { AnnotateControls } from '../annotate/AnnotateControls'
import { AnnotateProvider } from '../annotate/AnnotateContext'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

afterEach(cleanup)

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no element with data-testid="${id}"`)
  return el
}

/** Hover the way a pointer does, then let the kit's 300ms open delay elapse. */
async function hover(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el, { bubbles: true })
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 700))
  })
}

/** What a SIGHTED user reads on hover. '' when nothing opened — which is the failure. */
const shown = (): string =>
  Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .map(t => (t.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join('|')

/** The reason in the ACCESSIBILITY tree — the channel a pointer user never touches. */
const describedText = (el: Element): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(id => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim()

/**
 * The whole contract for one refused control, in one place.
 *
 *  1. the reason is READABLE ON HOVER  (the half `disabled` destroys)
 *  2. the reason is in the A11Y TREE   (the half a pointer user never reaches)
 *  3. the NAME still says what the control IS — a reason that swallows the name leaves a
 *     screen-reader user unable to tell WHICH control refused them (the 93167985 rule)
 *  4. it is not natively `disabled`, which is WHY 1 and 2 are reachable at all
 */
async function expectRefusalExplains(testid: string, reason: string, name: string): Promise<void> {
  const el = byTestId(testid)
  // (1) THE USER-VISIBLE HALF FIRST. On a natively `disabled` button this reads '' — nothing
  //     opened — which is the whole defect, stated in the failure message rather than inferred
  //     from an attribute.
  expect(
    await hoverText(el),
    `${testid}: hovering an unavailable control must show WHY it is unavailable`,
  ).toBe(reason)
  // (2) …and the same reason where a pointer never goes.
  expect(describedText(el), `${testid}: the reason must also reach assistive tech`).toBe(reason)
  // (3) …without the reason swallowing what the control IS (the 93167985 rule).
  expect(el.getAttribute('aria-label'), `${testid}: the reason must not swallow the NAME`).toBe(name)
  // (4) THE MECHANISM that makes 1-3 reachable at all, pinned so a future edit cannot satisfy
  //     them by some construction that puts the control back out of reach.
  expect(el.getAttribute('aria-disabled'), `${testid}: must be marked unavailable`).toBe('true')
  expect(
    el.hasAttribute('disabled'),
    `${testid}: a natively disabled button is pointer-events:none AND out of the tab order`,
  ).toBe(false)
}

/**
 * The same claim with the WORDING removed. A test that names the sentence fails both when the
 * tooltip cannot open AND when someone rephrases it, and those are not the same finding — this
 * one is red ONLY for the mechanism, so the red-first evidence cannot be mistaken for a typo.
 */
async function expectSomethingOpensOnHover(testid: string): Promise<void> {
  expect(
    await hoverText(byTestId(testid)),
    `${testid}: hovering opened NOTHING — a greyed control with no hover text explains itself ` +
      'to nobody, whatever the words would have been',
  ).not.toBe('')
}

async function hoverText(el: Element): Promise<string> {
  await hover(el)
  return shown()
}

// ── VizToolRail ────────────────────────────────────────────────────────────────────────────

const railProps = {
  activeTool: 'select' as const,
  onToolChange: () => {},
  cellToolbars: true,
  onToggleCellToolbars: () => {},
  linkZoom: false,
  onToggleLinkZoom: () => {},
  onExportGrid: () => {},
  selectExpanded: true,
}

describe('VizToolRail — a sub-tool that refuses says why', () => {
  it('MOVE with no selection opens SOMETHING on hover (wording-independent)', async () => {
    render(<VizToolRail {...railProps} hasSelection={false} />)
    await expectSomethingOpensOnHover('viz-tool-rail-sel-move')
  })

  it('MOVE with no selection explains itself on hover', async () => {
    render(<VizToolRail {...railProps} hasSelection={false} />)
    // `Move selection` is the registry label; the reason is why it is unavailable RIGHT NOW.
    await expectRefusalExplains(
      'viz-tool-rail-sel-move',
      'Select something first',
      'Move selection',
    )
  })

  it('MOVE with a selection is a live control with its plain name on hover', async () => {
    render(<VizToolRail {...railProps} hasSelection />)
    const el = byTestId('viz-tool-rail-sel-move')
    expect(el.getAttribute('aria-disabled'), 'a usable control is not marked unavailable').toBeNull()
    expect(await hoverText(el)).toBe('Move selection')
  })

  it('FINISH POLYGON below three vertices explains the threshold', async () => {
    render(<VizToolRail {...railProps} selShape="polygon" polyDraftCount={1} />)
    await expectRefusalExplains(
      'viz-tool-rail-sel-finish',
      'A polygon needs at least 3 points — 1 so far',
      'Finish polygon',
    )
  })

  it('FINISH POLYGON at three vertices is live', async () => {
    render(<VizToolRail {...railProps} selShape="polygon" polyDraftCount={3} />)
    const el = byTestId('viz-tool-rail-sel-finish')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(await hoverText(el)).toBe('Finish polygon (3)')
  })
})

// ── AnnotateControls ───────────────────────────────────────────────────────────────────────

const renderAnnotate = (props: Record<string, unknown> = {}) =>
  render(
    <AnnotateProvider>
      <AnnotateControls data-testid="ann" {...props} />
    </AnnotateProvider>,
  )

describe('AnnotateControls — every refused control says why', () => {
  it('UNDO with nothing to undo opens SOMETHING on hover (wording-independent)', async () => {
    renderAnnotate()
    await expectSomethingOpensOnHover('ann-undo')
  })

  it('UNDO with nothing to undo explains itself', async () => {
    renderAnnotate()
    await expectRefusalExplains('ann-undo', 'Nothing to undo', 'Undo')
  })

  it('REDO with nothing to redo explains itself', async () => {
    renderAnnotate()
    await expectRefusalExplains('ann-redo', 'Nothing to redo', 'Redo')
  })

  it('ADD CLASS with an empty name explains itself', async () => {
    renderAnnotate()
    await expectRefusalExplains('ann-newclass-add', 'Type a class name first', 'Add class')
  })

  it('ADD CLASS becomes a live control once a name is typed', async () => {
    renderAnnotate()
    const input = byTestId('ann-newclass-name') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Tumour' } })
    })
    const el = byTestId('ann-newclass-add')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(await hoverText(el)).toBe('Add class')
  })

  it('FINISH POLYGON below three vertices explains the threshold', async () => {
    renderAnnotate({ polyDraftLength: 2, onFinishPolygon: () => {}, onCancelPolygon: () => {} })
    // the polygon tool must be active for Finish to render at all
    await act(async () => {
      fireEvent.click(byTestId('ann-tool-polygon'))
    })
    await expectRefusalExplains(
      'ann-finish',
      'A polygon needs at least 3 points — 2 so far',
      'Finish polygon',
    )
  })

  it('CANCEL POLYGON with no draft explains itself', async () => {
    renderAnnotate({ polyDraftLength: 0, onFinishPolygon: () => {}, onCancelPolygon: () => {} })
    await act(async () => {
      fireEvent.click(byTestId('ann-tool-polygon'))
    })
    await expectRefusalExplains('ann-cancel', 'No polygon in progress', 'Cancel polygon')
  })
})
