// @vitest-environment jsdom
//
// TEST-9 [covers: ITEM-4] — the section frame belongs to the HOST.
//
// The claim ITEM-4 makes is not "the frame looks like this", it is "a section cannot
// forget to have one". A section comes from a package the app has never seen, so the
// only way that claim can be true is if the header is supplied by the wrapper rather
// than declared by the section. The subject here is therefore a section that declares
// NO chrome at all — no title element, no toggle, no handle, no badge, just a body —
// and every header element is asserted on the RENDERED output anyway.
//
// The badge leg is R6, and it is asserted in the collapsed state on purpose: *"an active
// filter or chosen entry shows the header badge. Without it, collapsing hides a filter
// still in force."* A badge that disappears on collapse would satisfy a naive "the badge
// renders" test and still ship the exact defect R6 names.
//
// (TEST-9's `SectionStack` half — that the stack wraps every section it renders in this
// frame — belongs with ITEM-3 and is asserted where the stack lives.)

import * as React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'

import { SectionFrame, SECTION_INSET_VAR } from './SectionFrame'
import { PANE_CONTENT_INSET } from './dock/paneModel'

afterEach(cleanup)

/** The collapse toggle, by its EXACT accessible name — the drag handle is also a
 *  button and also names the section, so a loose matcher hits both. */
const toggle = (title: string) => screen.getByRole('button', { name: title })

/** A section that declares NO chrome whatsoever — the whole point of the subject. */
function BareSection() {
  return <div data-testid="bare-body">just a body</div>
}

describe('SectionFrame (ITEM-4) — the frame is the host’s', () => {
  it('gives a chrome-less section a title, a collapse control and a drag handle', () => {
    render(
      <SectionFrame id="sc.coordinates" title="Coordinates" collapsed={false} onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )

    // The body is genuinely chrome-less — a positive control on the subject itself, so
    // "the header exists" cannot be satisfied by the section having supplied it.
    const body = screen.getByTestId('bare-body')
    expect(body.textContent).toBe('just a body')
    expect(within(body).queryByRole('button')).toBeNull()

    // TITLE — rendered by the frame.
    expect(screen.getByText('Coordinates')).toBeTruthy()

    // COLLAPSE — a real toggle, not a styled div: keyboard-operable and state-announcing.
    expect(toggle('Coordinates').getAttribute('aria-expanded')).toBe('true')

    // DRAG HANDLE — present even though nothing wired a reorder mechanism to it.
    const handle = screen.getByTestId('section-drag-handle-sc.coordinates')
    expect(handle.getAttribute('aria-label')).toBe('Reorder Coordinates')
  })

  it('toggles through the host, reporting the NEXT collapsed state', () => {
    const onCollapsedChange = vi.fn()
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={onCollapsedChange}>
        <BareSection />
      </SectionFrame>,
    )
    fireEvent.click(toggle('Coordinates'))
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  // ── "collapse is DISPLAY, not unmount" — the PROPOSITION, not its label ──────────
  //
  // This test used to assert `aria-expanded === 'false'` and nothing else. That is a
  // statement about the TRIGGER; the sentence in its own name is a statement about the
  // PANEL, and the two were never connected. It therefore certified a proposition it did
  // not compute: base-ui's `keepMounted` defaults to false, so the collapsed body WAS
  // unmounted for the whole life of this file and this test stayed green — while the
  // section's badge-publishing effect ran its cleanup and retracted the badge, and the
  // canvas order froze. A test whose subject lives outside the thing it names cannot see
  // the defect its name is about.
  //
  // So: assert MOUNTED-NESS, and assert it through an effect, because a component that is
  // merely hidden keeps running and a component that is unmounted runs its cleanup. The
  // effect is the sharpest available witness — it is exactly the mechanism the real
  // regression went through (`DeclarativeRegion`'s badge cleanup).
  it('keeps a COLLAPSED section MOUNTED — collapse is display, not unmount', () => {
    const mounted: string[] = []
    function Watched() {
      React.useEffect(() => {
        mounted.push('mount')
        return () => {
          mounted.push('unmount')
        }
      }, [])
      return <div data-testid="watched-body">body</div>
    }

    const { rerender } = render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={() => {}}>
        <Watched />
      </SectionFrame>,
    )
    expect(mounted).toEqual(['mount'])
    // The trigger still reports the state — the OLD assertion, kept as the display half.
    expect(toggle('Coordinates').getAttribute('aria-expanded')).toBe('true')

    rerender(
      <SectionFrame id="s" title="Coordinates" collapsed onCollapsedChange={() => {}}>
        <Watched />
      </SectionFrame>,
    )

    // DISPLAY changed …
    expect(toggle('Coordinates').getAttribute('aria-expanded')).toBe('false')
    // … and the subtree did NOT unmount. This is the assertion that goes RED against the
    // pre-fix code (`keepMounted` absent ⇒ `['mount','unmount']`).
    expect(mounted).toEqual(['mount'])
    // The element survives in the DOM too — hidden, not gone.
    expect(screen.queryByTestId('watched-body')).not.toBeNull()
  })

  // NEGATIVE CONTROL for the test above. Without it, "the body is still mounted" could be
  // satisfied by a frame that never unmounts anything under ANY condition — including one
  // where `collapsed` was simply ignored — and the assertion would prove nothing about the
  // collapse path. Removing the frame's child is a real unmount, and this witness SEES it:
  // so the witness is sensitive, and its silence above is evidence rather than noise.
  it('the mount witness is sensitive — a genuinely removed body DOES report unmount', () => {
    const mounted: string[] = []
    function Watched() {
      React.useEffect(() => {
        mounted.push('mount')
        return () => {
          mounted.push('unmount')
        }
      }, [])
      return <div data-testid="watched-body">body</div>
    }

    const { rerender } = render(
      <SectionFrame id="s" title="Coordinates" collapsed onCollapsedChange={() => {}}>
        <Watched />
      </SectionFrame>,
    )
    expect(mounted).toEqual(['mount'])

    rerender(
      <SectionFrame id="s" title="Coordinates" collapsed onCollapsedChange={() => {}}>
        <div data-testid="other-body">something else</div>
      </SectionFrame>,
    )
    expect(mounted).toEqual(['mount', 'unmount'])
  })

  // ── R6 ───────────────────────────────────────────────────────────────────────────
  it('advertises held state on the header — and KEEPS advertising it while collapsed', () => {
    const { rerender } = render(
      <SectionFrame id="s" title="Color by" collapsed={false} badge={2} badgeLabel="2 active filters" onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    expect(screen.getByTestId('section-badge-s').textContent).toContain('2')

    // The state R6 exists for: collapsed, still holding a filter.
    rerender(
      <SectionFrame id="s" title="Color by" collapsed badge={2} badgeLabel="2 active filters" onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    const badge = screen.getByTestId('section-badge-s')
    expect(badge.textContent).toContain('2')
    expect(badge.getAttribute('title')).toBe('2 active filters')
  })

  // ── WHERE THE BADGE SITS — REWRITTEN, AND THE DIRECTION IS THE POINT (ledger #25) ─────
  //
  // The owner first asked for the plot count *"on the right of the collapse button"*, and this
  // test asserted exactly that. It was correct: the previous round READ the rendered order
  // rather than transcribing the request, found the badge already after the trigger, changed
  // nothing, and pinned it here so a swap could not happen unnoticed.
  //
  // The owner then corrected themselves — *"it should be on the LEFT of the collapse button"* —
  // and the later wording governs. So the assertion INVERTS. It is not deleted, because the
  // thing it protects is unchanged: this ordering has now been specified twice in opposite
  // directions, which makes it exactly the kind of detail that drifts back.
  //
  // The COLLAPSE CONTROL is the chevron, and the chevron rides inside the accordion trigger at
  // its right edge — so "before the collapse control" is asserted against the CHEVRON, not
  // against the trigger box. Asserting against the trigger would be unsatisfiable in one
  // direction and trivially true in the other, which is what made the first version read as
  // already-correct.
  it('renders the badge BEFORE the collapse control in document order', () => {
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} badge={3} onCollapsedChange={() => {}}>
        <p>body</p>
      </SectionFrame>,
    )
    const frame = screen.getByTestId('section-frame-s')
    const trigger = frame.querySelector('[data-slot="accordion-trigger"]')!
    const chevron = trigger.querySelector('[data-slot="accordion-trigger-icon"]')!
    const badge = screen.getByTestId('section-badge-s')
    expect(chevron, 'the collapse control has no chevron to be left of').toBeTruthy()
    // `DOCUMENT_POSITION_FOLLOWING` on (badge → chevron): the chevron comes AFTER the badge,
    // i.e. the badge is to its left in a row that lays out in document order.
    expect(badge.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // …and the badge is INSIDE the trigger, which is the mechanic the move required: the
    // header's `extra` slot renders after the whole trigger, so nothing arranged within it
    // could ever sit left of the chevron.
    expect(trigger.contains(badge)).toBe(true)
    // The GRIP stays outside the trigger and last — it is the grab target, and a grip inside
    // the toggle would collapse the section on every drag.
    const grip = screen.getByTestId('section-drag-handle-s')
    expect(trigger.contains(grip)).toBe(false)
    expect(chevron.compareDocumentPosition(grip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // ── ONE PADDING VALUE, AND IT IS THE PANE'S OWN (ledger #30) ──────────────────────────
  //
  //   *"The padding should be consistent, how much padding do you have to the pane border then
  //    that much padding inside the card too"*
  //
  // The assertable form of that sentence is IDENTITY, not a number: the card's inside and the
  // pane's inset must be the SAME value, from the same source. A test asserting `8px` would go
  // green against two independent literals that happen to agree today — which is the drift the
  // owner is describing, one round earlier.
  it('takes its inside padding FROM the pane inset, not from a literal of its own', () => {
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={() => {}}>
        <p>body</p>
      </SectionFrame>,
    )
    const box = screen.getByTestId('section-frame-s')
    // The card box PUBLISHES the pane's constant as the one shared variable every side reads.
    // The inline inset no longer lives ON the card itself — it was relocated onto the header
    // band + the body wrapper so the entry_list scroll region (in the overflow:hidden accordion
    // panel) can bleed its scrollbar flush to the card's inner border (SectionFrame.tsx,
    // "entry_list scrollbar flush at section card border"). So the checkable fact is that the
    // card carries the VARIABLE, and every padding rule is derived FROM it — not that the card
    // pads its own inline.
    expect(box.style.getPropertyValue(SECTION_INSET_VAR)).toBe(PANE_CONTENT_INSET)
    const cls = box.className
    // Every side that pads reads the VARIABLE. jsdom computes no Tailwind, so what is checkable
    // is which source each rule was pointed at — and "pointed at the shared variable" is
    // precisely the clause worth pinning. The inset now lands on the header (`h3`) and the body
    // wrapper (`accordion-content > div`), all off the same `--section-inset`.
    for (const rule of [
      '[padding-inline:var(--section-inset)]',
      '[padding-top:var(--section-inset)]',
      '[padding-bottom:var(--section-inset)]',
    ]) {
      expect(cls, `the frame no longer derives ${rule} from the shared inset`).toContain(rule)
    }
    // …and no hand-tuned inset survives beside it. `px-1.5` + a header padded `px-2` is the
    // exact 6-vs-8 mismatch the owner was looking at.
    expect(/(^|\s)-?[pm][xytblrse]?-\d/.test(cls), `a literal spacing class is back: ${cls}`).toBe(false)
  })

  // ── THE HEADER BAND (ledger #26: *"make the header background muted"*) ────────────────
  //
  // Asserted on the CLASS the frame applies, and specifically that it names the existing
  // `muted` token: jsdom computes no Tailwind, so the only checkable fact is which token was
  // asked for — and "the existing token, not a new value" is exactly the clause worth pinning.
  it('gives the header the existing muted surface token', () => {
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={() => {}}>
        <p>body</p>
      </SectionFrame>,
    )
    const cls = screen.getByTestId('section-frame-s').className
    expect(cls).toContain('h3]:bg-muted')
    // No opacity-mixed variant: `bg-muted/60` and friends are new values wearing the token's name.
    expect(/h3\]:bg-muted\//.test(cls)).toBe(false)
  })

  it('marks only a section that HOLDS something — no badge, and no "0"', () => {
    const { rerender } = render(
      <SectionFrame id="s" title="Color by" collapsed onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    expect(screen.queryByTestId('section-badge-s')).toBeNull()

    // `0` is the ABSENCE of held state; a badge reading "0" says the opposite of R6.
    rerender(
      <SectionFrame id="s" title="Color by" collapsed badge={0} onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    expect(screen.queryByTestId('section-badge-s')).toBeNull()

    rerender(
      <SectionFrame id="s" title="Color by" collapsed badge="  " onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    expect(screen.queryByTestId('section-badge-s')).toBeNull()
  })

  it('does not collapse the section when the drag handle is grabbed', () => {
    // A handle that toggled the panel on every grab would make reordering unusable —
    // and it is the default outcome of putting the handle inside the toggle button.
    const onCollapsedChange = vi.fn()
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={onCollapsedChange}>
        <BareSection />
      </SectionFrame>,
    )
    fireEvent.click(screen.getByTestId('section-drag-handle-s'))
    expect(onCollapsedChange).not.toHaveBeenCalled()
  })

  // ── the handle is a TOUCH target, and a touch target that scrolls is not a handle ────
  it('claims the touch gesture on the grip, so a drag is not stolen by the scroller', () => {
    // The grip became a 44px TOUCH target for the mobile sheet. Without `touch-action: none`
    // the browser hands the first vertical movement to the pane's scroller: the gesture ends
    // before the drag's 4px threshold is crossed, the section never moves, and the pointer
    // stream terminates in `pointercancel`. The 44px box and this class are one change.
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    const handle = screen.getByTestId('section-drag-handle-s')
    expect(handle.className).toContain('touch-none')
    // …and it is scoped to the GRIP: the rest of the header must still scroll by touch.
    expect(screen.getByTestId('section-frame-s').className).not.toContain('touch-none')
  })

  // ── an unwired handle announces as disabled rather than lying ────────────────────────
  it('does not offer an UNWIRED handle to the keyboard as an operable button', () => {
    // The handle renders before any stack wires a reorder to it — deliberately, so a package
    // cannot ship a section without one. But `role="button"` + `tabIndex=0` + no key handler
    // is an ARIA lie: a screen-reader user is told there is a control, tabs to it, presses
    // Enter, and nothing happens with no explanation. Disabled is the honest state.
    render(
      <SectionFrame id="s" title="Coordinates" collapsed={false} onCollapsedChange={() => {}}>
        <BareSection />
      </SectionFrame>,
    )
    const handle = screen.getByTestId('section-drag-handle-s')
    expect(handle.getAttribute('aria-disabled')).toBe('true')
    expect(handle.getAttribute('tabindex')).toBeNull()
  })

  it('offers a WIRED handle as a real, focusable control', () => {
    // The other half — without it, "unwired handles are not focusable" would be satisfied by a
    // frame whose handle is never reachable at all, which is the same defect wearing a badge.
    render(
      <SectionFrame
        id="s"
        title="Coordinates"
        collapsed={false}
        onCollapsedChange={() => {}}
        dragHandleProps={{ onPointerDown: () => {}, onKeyDown: () => {}, 'aria-pressed': false }}
      >
        <BareSection />
      </SectionFrame>,
    )
    const handle = screen.getByTestId('section-drag-handle-s')
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-disabled')).toBeNull()
    // The host's state and key handling survive the frame's own attributes.
    expect(handle.getAttribute('aria-pressed')).toBe('false')
  })

  it('spreads the host’s reorder props onto the handle', () => {
    const onPointerDown = vi.fn()
    render(
      <SectionFrame
        id="s"
        title="Coordinates"
        collapsed={false}
        onCollapsedChange={() => {}}
        dragHandleProps={{ draggable: true, onPointerDown }}
      >
        <BareSection />
      </SectionFrame>,
    )
    const handle = screen.getByTestId('section-drag-handle-s')
    expect(handle.getAttribute('draggable')).toBe('true')
    fireEvent.pointerDown(handle)
    expect(onPointerDown).toHaveBeenCalled()
  })
})
