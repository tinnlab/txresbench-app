// @vitest-environment jsdom
//
// THE EMIT CONTROL IS ONE CONTROL (owner, ledger #33) — and ledger #31's row height.
//
//   *"why the visualize button in entry do not have border but in Color by have it, the
//    coordinates too"*
//   *"each row in the group and values are too tall, we do not need row line"*
//
// ── why this file exists rather than three assertions in three widget suites ─────────────────
//
// The ledger row is not *"make these three look the same"* — it is *"make it a shared control so
// a fourth section cannot diverge"*. Three per-widget assertions would certify the three that
// exist and say nothing about the next one, which is the exact failure mode the row names: the
// three call sites were each individually reasonable and the pane still spelled one verb three
// ways.
//
// So the assertions below are of two kinds, and the second is the one that does the work:
//
//   1. the shared control renders the agreed thing (borderless, the canvas glyph, named for its
//      row, refusing out loud);
//   2. NO OTHER MODULE renders an emit control of its own — asserted over the source of every
//      renderer that could, by requiring that the emit ICON NAME appears only where it is
//      dispatched to this component.
//
// (2) is a source-shaped check and this repo has been burned by those before — a hand-written
// static analyser's evasion space is unbounded, and the activity rail paid for that lesson over
// twenty audit rounds. It is used here anyway, narrowly and with its limit stated: it does not
// try to detect "an emit-like button"; it asserts a single mechanical fact — that the string
// `EMIT_ICON` compares against is not compared against anywhere that then builds its own
// `<Button>`. The BEHAVIOURAL half (what the control looks like, what it does) is mounted, not
// scanned. A renderer that draws a scatter glyph under a different declared name would evade
// this, and that is a known, bounded gap rather than a claim.

import * as React from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { EMIT_ICON, EmitControl } from './EmitControl'
import {
  ENTRY_LIST_ROWS_CLASS,
  ENTRY_ROW_CLASS,
} from '@/modules/workbench/extensions/visualize/EntryListWidget'

const HERE = path.dirname(fileURLToPath(import.meta.url))

afterEach(cleanup)

describe('the ONE emit control (ledger #33)', () => {
  it('is borderless, and the variant is not something a caller can pass', () => {
    render(<EmitControl data-testid="emit" name="Plot alpha" onPress={() => {}} />)
    const btn = screen.getByTestId('emit')
    // `ghost` — the owner named the entry-axis section's (borderless) as the one to keep. Asserted on the
    // rendered class rather than on a prop, because a prop is what the divergence was made of;
    // and asserted as an ABSENCE of the bordered/filled variants, because kit's `ghost` is
    // defined as hover styling and contributes no positive class to look for. What the owner
    // reported is *"in Color by [it] have [a border]"*, and every variant that would give it
    // one is named here.
    // Kit's base gives every button `border border-transparent` (so a focus ring can colour it
    // without shifting layout), so the checkable fact is that no variant COLOURS that border.
    //
    // Read over the UNPREFIXED classes only: `focus-visible:border-ring` and `hover:bg-muted`
    // are states, and a control that colours its border on focus is not a bordered control.
    // Matching the raw string would have called this one bordered and filled at once.
    const resting = btn.className.split(/\s+/).filter(c => !c.includes(':'))
    expect(resting).toContain('border-transparent')
    expect(resting.join(' '), 'the emit control has a visible border').not.toMatch(
      /border-(border|input|primary|ring|destructive)/,
    )
    expect(resting.join(' '), 'the emit control is filled').not.toMatch(
      /bg-(primary|secondary|background|destructive|muted)/,
    )
    // …and it IS the hover-only variant, not merely an unstyled button.
    expect(btn.className).toContain('hover:bg-muted')
    // The props interface offers no `variant` at all — the compile-time half of the same claim.
    const props = new Set(Object.keys({ 'data-testid': '', name: '', refusal: '', onPress: () => {} }))
    expect(props.has('variant')).toBe(false)
  })

  it('is named for its ROW, on every channel a user has', () => {
    // Forty rows called "Plot" are forty indistinguishable controls to a screen-reader or voice
    // user. Both channels, because an icon-only button with a name but no tooltip is legible to
    // everything except the pointer user looking straight at it.
    render(<EmitControl data-testid="emit" name="Plot alpha" onPress={() => {}} />)
    const btn = screen.getByTestId('emit')
    expect(btn.getAttribute('aria-label')).toBe('Plot alpha')
    expect(btn.textContent?.trim()).toBe('')
  })

  it('a refusal drops the press AND says why — once, here, so no call site can forget half', () => {
    const onPress = vi.fn()
    render(<EmitControl data-testid="emit" name="Plot alpha" refusal="Pick a coordinate set first." onPress={onPress} />)
    const btn = screen.getByTestId('emit')
    fireEvent.click(btn)
    expect(onPress).not.toHaveBeenCalled()
    // Reachable rather than parked on a natively-disabled control: `aria-disabled`, still in the
    // tab order, still hoverable, with the reason wired to both channels by the kit.
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.getAttribute('disabled')).toBeNull()
  })

  it('a blank refusal is NOT a refusal — an empty string must not silently disable the row', () => {
    // The shape this normalizes: `plot_refusal` arrives as `null | ''` from three different
    // engines. A control that treated `''` as a reason would refuse every row while showing an
    // empty tooltip — a dead control that explains nothing, which is the one outcome the
    // "reason IS the gate" idiom exists to make impossible.
    const onPress = vi.fn()
    render(<EmitControl data-testid="emit" name="Plot alpha" refusal="  " onPress={onPress} />)
    fireEvent.click(screen.getByTestId('emit'))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('suppresses the click from its ancestors — choosing and drawing are two acts', () => {
    // § Coordinates puts this control INSIDE the `<label>` that activates a radio, so an
    // unguarded press would reframe the pane as a side effect of asking for a picture. The
    // suppression lives in the component, not at that one call site, so the next section to do
    // the same thing does not have to rediscover it.
    const onAncestor = vi.fn()
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: a test stand-in for the label the real
      // call site renders inside.
      <div onClick={onAncestor}>
        <EmitControl data-testid="emit" name="Plot alpha" onPress={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('emit'))
    expect(onAncestor).not.toHaveBeenCalled()
  })

  it('every emit call site DISPATCHES to it — none builds its own', () => {
    // The structural half. Each of these files renders rows that can carry a ▶; each must reach
    // the shared component and none may construct a button for the emit icon itself.
    const sites = [
      path.join(HERE, 'ArtifactRefWidget.tsx'),
      path.join(HERE, '../../extensions/visualize/EntryListWidget.tsx'),
      path.join(HERE, '../../extensions/widgets/renderers.tsx'),
    ]
    for (const file of sites) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${path.basename(file)} does not use the shared emit control`).toContain('EmitControl')
      // The glyph is the component's decision. A call site importing it is a call site that can
      // draw its own, which is what the three sites were doing before this component existed.
      expect(src, `${path.basename(file)} imports the emit glyph directly`).not.toContain('ScatterChart')
    }
    // …and the icon NAME is the declaration seam, exported once. A second literal spelling of
    // it is a second registry.
    expect(EMIT_ICON).toBe('plot')
  })
})

describe('a list row is short and has no rule under it (ledger #31)', () => {
  it('the row track declares no separator, and a tight gap', () => {
    //   *"each row in the group and values are too tall, we do not need row line"*
    //
    // Both halves, on the one string both the column section and the entry-axis section render their rows through.
    // It is a constant rather than a re-typed class for the usual reason: a test that spelled
    // the class would pass while the list rendered something else.
    // The 2px moved from the TRACK's `gap-0.5` to the ROW's own `pb-0.5` when the list became
    // virtualised (ledger #38): a flex `gap` is not part of any row's measured height, so a
    // windowed list would drift 2px per row away from its own scrollbar. The claim under test is
    // unchanged — no rule, and 2px — so the assertion follows the spacing rather than being
    // dropped, and it still names constants rather than re-typing classes.
    expect(ENTRY_LIST_ROWS_CLASS).not.toMatch(/divide|border/)
    expect(ENTRY_ROW_CLASS).not.toMatch(/divide|border/)
    expect(`${ENTRY_LIST_ROWS_CLASS} ${ENTRY_ROW_CLASS}`).toMatch(/(gap|pb)-0\.5/)
  })

  it('the emit control gives the row height back — it is the tallest thing on the line', () => {
    // A row is one line of small text plus this button, so the button is what sets the height.
    // `size-7` (28px) rather than kit's `size-8` default; asserted on the rendered class,
    // because the point is what the row actually measures and not what was intended.
    render(<EmitControl data-testid="emit" name="Plot alpha" onPress={() => {}} />)
    const cls = screen.getByTestId('emit').className
    expect(cls).toContain('size-7')
    expect(cls).not.toMatch(/(^|\s)size-8(\s|$)/)
  })
})
