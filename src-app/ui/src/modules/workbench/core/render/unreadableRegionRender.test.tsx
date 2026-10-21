// @vitest-environment jsdom
import * as React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { RegionStatus } from './RegionStatus'

// INV-9's LOAD-BEARING HALF: a view whose artifact cannot be read must NAME what is missing
// and must NEVER render short or empty.
//
// ── WHY THIS TIER, STATED RATHER THAN ASSUMED ────────────────────────────────────────────
//
// The listing half of ITEM-41 is proven end-to-end against a real server
// (`tests/e2e/virtual-dataset/unreadable-state.spec.ts` — a seeded `unresolvable` row, the
// real byte route, the real error codes). The VIEWER half cannot currently be reached that
// way, and the blocker was measured rather than guessed: exactly one shipped view binds a
// `job.result` slice, that slice narrows by `produced_by`, and `generator_id` is derived
// server-side from `provenance_run_repro` joined on the artifact's `run_id` — which the debug
// seed sets to `None` unconditionally (`data_api.rs`, no `run_id: Some` anywhere on the seed
// path). So a seeded artifact can never be attributed to a producing analysis, the narrowing
// correctly matches nothing, and the slice resolves `empty` instead of reaching the read.
//
// This is the same reasoning the tree already applies to `ChartUnbound`: a refusal surface
// that production cannot currently reach is proven "at the tier that CAN reach it", with the
// unreachability reported rather than papered over. Raising this to e2e needs a seed that can
// attribute an artifact to a run — recorded as the blocker, not worked around by weakening
// `produced_by`, which exists to close a real shadowing defect.

afterEach(cleanup)

const VIEW = 'wb'
const MISSING = 'source-dataset-alpha'
/** The message the RESOLVER builds, carrying the server's own text — which names the missing
 *  source. Kept in the shape `readFailure` produces so this is not testing an invented one. */
const DETAIL = `Could not read "jq" (data/opaque): workstore artifact read → …`
/** The SERVER's own sentence, verbatim in shape — it names the source and states the remedy,
 *  which is why it is shown INLINE rather than behind the kit's Details disclosure. */
const SERVER_SENTENCE =
  `artifact 7f is status='unresolvable': it is GATHERED, and the alignment it reads through can no ` +
  `longer be resolved — missing or changed source: ${MISSING}. Its own declaration is intact and ` +
  `nothing about it is wrong, so deleting it is not the fix; restore or re-attach that source.`

describe('a view whose artifact the server refuses renders a NAMED failure, never a blank', () => {
  it('renders the unreadable surface, and the missing source survives to the screen', () => {
    render(<RegionStatus status="unreadable" error={DETAIL} hint={SERVER_SENTENCE} viewId={VIEW} resource="Integrate datasets" />)

    const surface = screen.getByTestId(`declarative-status-unreadable-${VIEW}`)
    expect(surface).toBeTruthy()
    // THE assertion INV-9 is actually about. Not "an error appeared" — the NAME of the thing
    // that went missing has to reach the person reading the pane, or the remedy is unguessable.
    expect(surface.textContent ?? '').toContain(MISSING)
  })

  it('is not short or empty — the likely accident is silence, not a wrong word', () => {
    render(<RegionStatus status="unreadable" error={DETAIL} hint={SERVER_SENTENCE} viewId={VIEW} resource="Integrate datasets" />)
    const text = (screen.getByTestId(`declarative-status-unreadable-${VIEW}`).textContent ?? '').trim()
    // A blank surface passes every health check there is, so the floor is asserted directly.
    expect(text.length).toBeGreaterThan(40)
  })

  it('does NOT claim a server outage, and does NOT offer to delete good work', () => {
    render(<RegionStatus status="unreadable" error={DETAIL} hint={SERVER_SENTENCE} viewId={VIEW} resource="Integrate datasets" />)
    const text = screen.getByTestId(`declarative-status-unreadable-${VIEW}`).textContent ?? ''
    // `unresolvable` means the artifact is INTACT and its source is gone. Two sentences are
    // wrong here in opposite directions: "the server may be unavailable" sends the reader to
    // debug a server that is fine, and anything advising deletion offers to destroy work that
    // is perfectly good. Both are what `error`'s surface would have said.
    expect(text).not.toMatch(/server may be unavailable/i)
    expect(text).not.toMatch(/\bdelete\b/i)
  })

  // POSITIVE CONTROL for all three: the component genuinely renders DIFFERENT surfaces, so the
  // assertions above are not passing against one generic box that happens to contain
  // everything. Without this, "it is not the error surface" would be unfalsifiable.
  it('the error surface is a DIFFERENT surface, and it is the one that blames the server', () => {
    render(<RegionStatus status="error" error={DETAIL} viewId={VIEW} resource="Integrate datasets" />)
    expect(screen.queryByTestId(`declarative-status-unreadable-${VIEW}`)).toBeNull()
    const err = screen.getByTestId(`declarative-status-error-${VIEW}`)
    expect(err.textContent ?? '').toMatch(/unavailable|access/i)
  })

  it('renders nothing structural for `ready` — the surface is not always-on', () => {
    const { container } = render(<RegionStatus status="ready" viewId={VIEW} resource="Integrate datasets" />)
    expect(screen.queryByTestId(`declarative-status-unreadable-${VIEW}`)).toBeNull()
    expect(screen.queryByTestId(`declarative-status-error-${VIEW}`)).toBeNull()
    expect(container.textContent ?? '').toBe('')
  })
})
