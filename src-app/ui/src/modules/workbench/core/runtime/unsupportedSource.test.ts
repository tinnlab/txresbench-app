import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { aggregateDataStatus } from './dataStatus'
import { resolveViewData } from './viewData'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'

// A data slice naming a source this build has no reader for used to be SILENTLY SKIPPED —
// it contributed neither data nor status, so a view whose only slice was unrecognised
// aggregated to a clean `ready` and rendered widgets bound to `$data.<key>` holding nothing.
//
// A blank surface, reported healthy. That is the third instance of this class in this
// lifecycle, after the artifact pane's swallowed read and the artifact listing's untold
// status, and it is the same reason all three survived: nothing that watches for breakage
// can see a surface that simply renders nothing.
//
// These assert the CLASSIFICATION, not the rendering — a status that reaches the region is
// what makes any rendering possible, and asserting on the banner alone would stay green if
// the resolver went back to skipping and some other slice happened to fail.

function spec(data: Record<string, { source: string; args?: Record<string, unknown> }>): ViewSpec {
  return {
    id: 'v',
    title: 'v',
    permission: 'jobs::use',
    state: {},
    data,
    widgets: [],
    actions: [],
  } as unknown as ViewSpec
}

describe('a slice whose source this build cannot resolve is classified, not skipped', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  // POSITIVE CONTROL. Without it every assertion below would pass just as happily against a
  // resolver that classified EVERYTHING as unsupported, including working slices.
  it('leaves a KNOWN source alone', async () => {
    const readSlice = vi.fn().mockResolvedValue({ status: 'ready', payload: { a: [1] } })
    const res = await resolveViewData(spec({ good: { source: 'job.result', args: { datatype: 'x' } } }), readSlice)
    expect(res.status).toBe('ready')
    expect(res.data.good).toEqual({ a: [1] })
    expect(readSlice).toHaveBeenCalledTimes(1)
  })

  it('does NOT report `ready` over a view whose only slice it cannot resolve', async () => {
    const readSlice = vi.fn()
    const res = await resolveViewData(spec({ joinQuality: { source: 'invented_source' } }), readSlice)
    // The whole bug in one assertion: this used to be `ready`.
    expect(res.status).toBe('unsupported')
    // …and the reader is never called for a source there is no reader for.
    expect(readSlice).not.toHaveBeenCalled()
  })

  it('NAMES both the slice and the source, so the reader need not guess which slice', async () => {
    const res = await resolveViewData(spec({ joinQuality: { source: 'invented_source' } }), vi.fn())
    expect(res.error).toContain('joinQuality')
    expect(res.error).toContain('invented_source')
  })

  it('still contributes NO data — the widget binding resolves to nothing, as before', async () => {
    const res = await resolveViewData(spec({ joinQuality: { source: 'invented_source' } }), vi.fn())
    expect(res.data.joinQuality).toBeUndefined()
  })

  it('warns once per (slice, source), not once per resolve — a re-render loop must not spam', async () => {
    const s = spec({ joinQuality: { source: 'invented_source_unique_to_this_test' } })
    await resolveViewData(s, vi.fn())
    await resolveViewData(s, vi.fn())
    await resolveViewData(s, vi.fn())
    // jsdom runs with DEV true; if that ever changes this asserts 0 and would need revisiting.
    expect((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('keeps skipping a MISSING declaration — that is not a slice, and the asymmetry is deliberate', async () => {
    const res = await resolveViewData(
      spec({ nothing: undefined as unknown as { source: string } }),
      vi.fn(),
    )
    expect(res.status).toBe('ready')
  })
})

describe('worst-of ranking', () => {
  // ── THIS TEST CERTIFIED THE DEFECT, AND IS REWRITTEN RATHER THAN DELETED ────────────
  //
  // It asserted `unsupported` over a concurrent `error`, with the reasoning that
  // `unsupported` is deterministic and reporting the retryable fault "sends someone to debug
  // a backend that is fine". Half of that is right — and it is the half that made the wrong
  // answer look principled.
  //
  // What it missed is that the pair is not either half. `unsupported` renders copy promising
  // "everything else on this view still works" and deliberately offers NO retry; with a real
  // backend outage beside it, that sentence is false and the retry the user needs is gone.
  // Swapping the winner only moves the loss.
  //
  // A shipped defect usually has a PASSING test asserting it. Keeping this one here, with its
  // original claim stated, is what stops the ranking being "restored" later by someone
  // reading only the comment above it.
  it('reports the MIXED state, not either half, when unsupported and error are concurrent', () => {
    const r = aggregateDataStatus([
      { status: 'error', error: 'query threw' },
      { status: 'unsupported', error: 'no reader' },
    ])
    expect(r.status).toBe('degraded')
    expect(r.error).toContain('query threw')
    expect(r.error).toContain('no reader')
  })

  // The original claim's TRUE half, kept as its own assertion: against anything that is not a
  // retryable failure, `unsupported` still wins, and no retry is offered.
  it('still reports `unsupported` over a non-error slice (the deterministic half stands)', () => {
    expect(
      aggregateDataStatus([
        { status: 'empty' },
        { status: 'unsupported', error: 'no reader' },
      ]).status,
    ).toBe('unsupported')
  })

  it('still reports `error` when nothing is unsupported (the control for the rank above)', () => {
    expect(aggregateDataStatus([{ status: 'error', error: 'query threw' }, { status: 'ready' }]).status).toBe('error')
  })

  it('outranks ready/empty/unreadable too', () => {
    for (const other of ['ready', 'empty', 'unreadable'] as const) {
      expect(aggregateDataStatus([{ status: other }, { status: 'unsupported' }]).status).toBe('unsupported')
    }
  })
})

// ── M10 — THE MIXED CASE, WHICH NOTHING PINNED ───────────────────────────────────────────
//
// The fold's ranking is tested for SINGLE states. The case where it actively misleads is
// MIXED: one slice this build cannot read, alongside another failing on a backend outage.
// `unsupported` wins, and its copy says "Everything else on this view still works" — which is
// false, and it removes the retry affordance the user needs for the half that IS retryable.
//
// Reordering alone would only swap which truth is suppressed: `error` first means a genuinely
// unsupported view offers a retry that cannot help, which is the defect the ranking already
// refused once. So the mixed state is its own value, and this suite asserts all three.
describe('M10 — a mixed unsupported+error state is neither of its halves', () => {
  it('does not report a mixed state as plain `unsupported`', () => {
    const r = aggregateDataStatus([
      { status: 'unsupported', error: 'no reader for source "x"' },
      { status: 'error', error: 'backend down' },
    ])
    // The claim that must not survive: "everything else works" while something else is down.
    expect(r.status, 'a backend outage was suppressed behind an unsupported slice').not.toBe(
      'unsupported',
    )
    // …and it must not become plain `error` either, or an unsupported half is now invisible
    // and the user is sent to retry a build mismatch that retrying cannot clear.
    expect(r.status, 'the unsupported half was suppressed behind the error').not.toBe('error')
    expect(r.status).toBe('degraded')
  })

  it('carries BOTH sentences, so neither half is silently dropped', () => {
    const r = aggregateDataStatus([
      { status: 'unsupported', error: 'no reader for source "x"' },
      { status: 'error', error: 'backend down' },
    ])
    expect(r.error).toContain('backend down')
    expect(r.error).toContain('no reader')
  })

  it('the SINGLE cases are unchanged — this is the control that stops a regression', () => {
    // Without these, the fix above could be "always return degraded", which would break every
    // single-slice case that works today.
    expect(aggregateDataStatus([{ status: 'unsupported', error: 'u' }]).status).toBe('unsupported')
    expect(aggregateDataStatus([{ status: 'error', error: 'e' }]).status).toBe('error')
    expect(aggregateDataStatus([{ status: 'unreadable', error: 'r' }]).status).toBe('unreadable')
    expect(aggregateDataStatus([{ status: 'ready' }]).status).toBe('ready')
    expect(aggregateDataStatus([{ status: 'empty' }]).status).toBe('empty')
    // unsupported still outranks unreadable and empty — only the ERROR pairing is special,
    // because only that pairing has one retryable half and one that is not.
    expect(
      aggregateDataStatus([{ status: 'unsupported', error: 'u' }, { status: 'unreadable', error: 'r' }]).status,
    ).toBe('unsupported')
  })
})
