// @vitest-environment jsdom
//
// TEST-21 (ITEM-21, INV-3) — the run trust-view states which of a run's inputs
// NOBODY reviewed.
//
// The column used to render `r.inputs.length` and nothing else, so a run launched on a
// binding the system guessed and a run launched on one a scientist deliberately
// picked were the same character on screen. This asserts the three cases that have to
// look DIFFERENT — and, just as load-bearing, the one that must NOT: a run recorded
// before the origin existed carries no origin at all, and rendering it as reviewed
// would assert a review nobody performed (DEC-7 / INV-4).
//
// It renders the real column component (not a copy of its logic), so a change that
// moves the mark into a hover — the disclaimer nobody sees — fails here.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { RunNodeDto, UsedEdgeDto } from '@/api-client/types'
import { RunInputsSummary, autoBoundInputCount } from './components/RunsList'

afterEach(cleanup)

const edge = (slot: string, boundBy?: 'user' | 'auto'): UsedEdgeDto => ({
  slot,
  kind: 'artifact',
  content_hash: `sha256:${slot}`,
  ...(boundBy ? { bound_by: boundBy } : {}),
})

const run = (inputs: UsedEdgeDto[]): RunNodeDto => ({
  run_id: '00000000-0000-4000-8000-0000000000a1',
  project_id: '00000000-0000-4000-8000-0000000000b1',
  kind: 'compute',
  status: 'completed',
  generator_id: 'tool',
  generator_version: '1.0',
  inputs,
  captured_at: '2026-08-13T12:00:00Z',
})

/** The column's full visible text — what a reviewer actually reads. */
function visibleText(node: HTMLElement): string {
  return node.textContent ?? ''
}

describe('the run trust-view marks automatically bound inputs (TEST-21 / ITEM-21)', () => {
  it('states how many inputs the system bound, on screen', () => {
    const { container } = render(
      <RunInputsSummary run={run([edge('a', 'auto'), edge('b', 'user'), edge('c', 'auto')])} />,
    )
    // The plain count survives…
    expect(visibleText(container.firstChild as HTMLElement)).toContain('3')
    // …and the unreviewed subset is STATED, rendered rather than hovered.
    const mark = screen.getByTestId('provenance-run-auto-bound-00000000-0000-4000-8000-0000000000a1')
    expect(mark).toBeTruthy()
    expect(visibleText(mark)).toContain('2')
    expect(visibleText(mark).toLowerCase()).toContain('automatically')
    expect(autoBoundInputCount(run([edge('a', 'auto'), edge('b', 'user')]))).toBe(1)
  })

  it('says nothing extra when every input was picked by a person', () => {
    const { container } = render(<RunInputsSummary run={run([edge('a', 'user'), edge('b', 'user')])} />)
    expect(screen.queryByTestId('provenance-run-auto-bound-00000000-0000-4000-8000-0000000000a1')).toBeNull()
    expect(visibleText(container.firstChild as HTMLElement).trim()).toBe('2')
  })

  it('renders a run with NO recorded origins as the plain count, never as reviewed', () => {
    // Every run recorded before this change is this shape. Absent is UNSTATED: it is
    // not `user`, so the column must not acquire a "reviewed"/"picked" affordance here,
    // and it must not acquire the auto mark either.
    const { container } = render(<RunInputsSummary run={run([edge('a'), edge('b')])} />)
    const text = visibleText(container.firstChild as HTMLElement)
    expect(screen.queryByTestId('provenance-run-auto-bound-00000000-0000-4000-8000-0000000000a1')).toBeNull()
    expect(text.trim()).toBe('2')
    for (const claim of ['review', 'chosen', 'picked', 'user']) {
      expect(text.toLowerCase()).not.toContain(claim)
    }
    expect(autoBoundInputCount(run([edge('a'), edge('b')]))).toBe(0)
  })
})

// TEST-21 (binding-origin / ITEM-21) — a FOREIGN origin value counts as neither.
//
// `UsedEdgeDto.bound_by` is a plain `String` on the wire, read out of a `jsonb` column, so its
// value is whatever some writer put there: a future origin this build has never heard of, a
// typo, a hand-edited row. It must count as neither auto nor reviewed.
//
// An earlier draft of this block claimed the count needed a parse GUARD and that without one
// an unknown value "was reported to a reviewer as an input somebody chose". That was false in
// both halves, and the correction is worth keeping: the count uses `===`, so unknowns were
// never in the auto pile; and this column renders a count plus "N bound automatically" and
// never asserts that anyone reviewed anything, so there is no claim for an unknown to be
// mistaken for. These tests are kept because the PROPERTY is worth pinning — they simply do
// not pin a guard that does not exist.

describe('TEST-21: an unrecognised bound_by is UNSTATED, never reviewed', () => {
  const foreign = (slot: string, value: string): UsedEdgeDto =>
    ({ slot, kind: 'artifact', content_hash: `sha256:${slot}`, bound_by: value }) as UsedEdgeDto

  it('does not count a foreign value as auto', () => {
    expect(autoBoundInputCount(run([foreign('a', 'system'), foreign('b', 'AUTO')]))).toBe(0)
  })

  it('renders a foreign-origin run EXACTLY as one that recorded no origin at all', () => {
    // Asserted as an EQUALITY against the unstated case rather than as an absence of words the
    // column never emits — a `not.toMatch(/reviewed/)` would pass against any rendering at all,
    // including a blank one, which is the vacuous shape this file is otherwise careful about.
    const foreignRender = render(<RunInputsSummary run={run([foreign('a', 'system')])} />)
    const foreignText = visibleText(foreignRender.container)
    cleanup()
    const unstatedRender = render(<RunInputsSummary run={run([edge('a')])} />)
    const unstatedText = visibleText(unstatedRender.container)

    expect(foreignText).toBe(unstatedText)
    // …and the POSITIVE control that keeps that equality from being satisfied by two blanks:
    // the column really does say something, and an auto run really does say more.
    expect(foreignText.trim().length).toBeGreaterThan(0)
    cleanup()
    const autoRender = render(<RunInputsSummary run={run([edge('a', 'auto')])} />)
    expect(visibleText(autoRender.container)).not.toBe(foreignText)
  })

  it('still counts a WELL-FORMED auto beside a foreign one — the over-correction control', () => {
    // Keeps the two tests above from passing via a guard that rejects everything.
    expect(autoBoundInputCount(run([foreign('a', 'system'), edge('b', 'auto')]))).toBe(1)
  })
})
