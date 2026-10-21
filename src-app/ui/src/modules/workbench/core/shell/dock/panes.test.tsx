// @vitest-environment jsdom
//
// TEST-10 [covers: visualize-pane ITEM-5] — the `visualize` pane RENDERS the section stack.
//
// `deletionClauses.test.ts` asserts the same swap by reading `panes.tsx`'s source, which is
// how it can also assert the NEGATIVE ("exactly one kind routes through `PlacedArea`") — a
// negative over anonymous arrow renderers is not observable at runtime. This file asserts
// the POSITIVE at runtime instead: the registered renderer, actually invoked, actually
// produces the section stack. A regex agreeing with the source and a component that never
// mounts is a pairing this repo has paid for before.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// The two hosts are stubbed by MODULE, so what is asserted is which one the registration
// reaches — not what either of them draws (each is covered where it lives).
vi.mock('@/modules/workbench/core/shell/SectionStack', () => ({
  SectionStack: ({ pane }: { pane: string }) => <div data-testid={`stub-section-stack-${pane}`} />,
}))
vi.mock('@/modules/workbench/core/shell/PlacedArea', () => ({
  PlacedArea: ({ area }: { area: string }) => <div data-testid={`stub-placed-area-${area}`} />,
}))

import { registerPanes } from './panes'
import { resolvePaneRenderer } from './paneModel'

afterEach(cleanup)

/** Render a pane kind's REGISTERED renderer with a minimal pane. */
function renderKind(kind: string) {
  registerPanes()
  const Renderer = resolvePaneRenderer(kind)
  return render(<Renderer pane={{ id: `p-${kind}`, kind: kind as never }} />)
}

describe('TEST-10: the visualize pane is a SECTION STACK (ITEM-5)', () => {
  it('`visualize` resolves to `SectionStack pane="visualize"`, not a placed area', () => {
    renderKind('visualize')
    expect(screen.getByTestId('stub-section-stack-visualize')).toBeTruthy()
    // The negative that makes it mean something: the retired left-AREA host is gone from
    // this pane, so a partially-applied swap (both rendered, or the area still rendered)
    // fails here rather than looking correct.
    expect(screen.queryByTestId('stub-placed-area-left')).toBeNull()
  })

  it('`canvas` is UNCHANGED — still the centre hero through PlacedArea', () => {
    // The positive control for the assertion above: `PlacedArea` did not stop working, and
    // the centre reservation still routes exactly as it did.
    renderKind('canvas')
    expect(screen.getByTestId('stub-placed-area-center')).toBeTruthy()
    expect(screen.queryByTestId(/stub-section-stack/)).toBeNull()
  })
})
