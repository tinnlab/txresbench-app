// @vitest-environment jsdom
//
// The sticky job-completion toast must not be a trap.
//
// DEC-16 (declarative-canvas-plots) decided the ack is a kit toast with `duration: Infinity`
// — "an immediate local 'your run finished' ack", deliberately NOT the notification module and
// deliberately not auto-dismissing. That decision is kept here in full: the toast still never
// expires on its own, and it still deep-links to the job.
//
// What DEC-16 did NOT decide, and what shipped by omission, is that the ONLY way out of it was
// its own "View job" action — which calls `revealPane('jobs', id)` and therefore replaces the
// pane the user was reading. A permanent overlay whose single exit navigates you away leaves a
// user two bad options: keep a click-blocker over their content forever, or lose their place.
//
// Two behaviours are pinned:
//   1. the toast carries a dismissal that is NOT a navigation — closing it must not reveal a
//      pane, because revealing a pane is what unmounts the one the user was on;
//   2. the toast surface does not take pointer input, while its own controls still do.
//
// (2) is a MECHANISM assertion here, in two halves — the classes the toast hands sonner, and the
// rules `index.css` declares for those classes. jsdom does no layout and no hit-testing, so the
// OUTCOME ("a mouse click lands on the row underneath") can only be proven in a real browser;
// that is `tests/e2e/14-declarative-qc/analysis-run-list.spec.ts`. Both halves are asserted where
// they live so that deleting either one fails here rather than only in a 12-minute e2e tier.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react'
import { Toaster } from '@ziee/kit'
import type { Job } from '@/api-client/types'

// The navigation the toast's OTHER exit performs. Mocked so this suite can prove the close
// affordance does not take it — the whole point of adding a second exit.
const { revealPaneSpy } = vi.hoisted(() => ({ revealPaneSpy: vi.fn() }))
vi.mock('./regions/openPane', () => ({ revealPane: revealPaneSpy }))

import {
  fireJobToast,
  shouldFireJobToast,
  JOB_TOAST_CONTROL_CLASS,
  JOB_TOAST_PASSTHROUGH_CLASS,
  jobToastTestId,
} from './statusBarJobsStore'

/** The app stylesheet, resolved from THIS file rather than from the cwd — the pair of rules
 *  below is half of the pass-through mechanism, and it lives there. */
const APP_CSS = resolve(import.meta.dirname, '../../../../index.css')

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'job-1',
    // Domain-free on purpose: the ack knows nothing about what ran, and `no-domain-in-builtin`
    // holds the app tree (tests included) to zero domain vocabulary.
    name: 'Probe',
    job_type: 'probe.run',
    status: 'completed',
    created_at: new Date().toISOString(),
    owner_id: 'o',
    params: {},
    priority_class: 'normal',
    resource_class: 'cpu-sandbox',
    ...over,
  }) as Job

beforeEach(() => {
  revealPaneSpy.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the sticky job toast can be dismissed without navigating away', () => {
  it('offers a close control, and closing it reveals no pane', async () => {
    render(<Toaster />)
    const j = job()
    act(() => fireJobToast(j))

    const toast = await screen.findByTestId(jobToastTestId(j.id))
    // A second exit, distinct from "View job". Selected by ROLE + accessible name so this
    // asserts an affordance a user (and a screen reader) can find, not a class.
    const close = within(toast).getByRole('button', { name: /close/i })
    expect(
      close,
      'the toast must carry a dismissal that is not its "View job" action',
    ).toBeTruthy()

    await act(async () => {
      fireEvent.click(close)
    })

    // The point of the affordance: it gets rid of the toast WITHOUT the pane swap.
    expect(
      revealPaneSpy,
      'closing the toast must not reveal a pane — revealing one replaces the pane the user was reading',
    ).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId(jobToastTestId(j.id))).toBeNull(), {
      timeout: 5_000,
    })
  })

  it('"View job" still deep-links the job — the ack keeps its DEC-16 behaviour', async () => {
    render(<Toaster />)
    const j = job({ id: 'job-2' })
    act(() => fireJobToast(j))

    const toast = await screen.findByTestId(jobToastTestId(j.id))
    await act(async () => {
      fireEvent.click(within(toast).getByRole('button', { name: 'View job' }))
    })
    expect(revealPaneSpy).toHaveBeenCalledWith('jobs', 'job-2')
  })

  it('is still STICKY — no elapsed time dismisses it (DEC-16)', async () => {
    vi.useFakeTimers()
    render(<Toaster />)
    const j = job({ id: 'job-3' })
    act(() => fireJobToast(j))

    // Sonner arms an auto-close timer only for a FINITE duration. Ten minutes of it is far
    // past any plausible timeout a well-meaning edit would swap `Infinity` for.
    await act(async () => {
      vi.advanceTimersByTime(600_000)
    })
    expect(
      screen.queryByTestId(jobToastTestId(j.id)),
      'the ack must survive being ignored — a user who stepped away still learns the run finished',
    ).not.toBeNull()
  })
})

describe('the sticky job toast does not take pointer input for its whole footprint', () => {
  it('hands the toast a pass-through class and its controls an interactive one', async () => {
    render(<Toaster />)
    const j = job({ id: 'job-4' })
    act(() => fireJobToast(j))

    const toast = await screen.findByTestId(jobToastTestId(j.id))
    expect(
      toast.className.split(/\s+/),
      'the toast surface must opt out of pointer input',
    ).toContain(JOB_TOAST_PASSTHROUGH_CLASS)

    const buttons = within(toast).getAllByRole('button')
    expect(buttons.length, 'the toast has controls of its own (View job + close)').toBeGreaterThan(1)
    for (const b of buttons) {
      expect(
        b.className.split(/\s+/),
        `every control the toast owns must opt back IN (${b.getAttribute('aria-label') ?? b.textContent})`,
      ).toContain(JOB_TOAST_CONTROL_CLASS)
    }
  })

  it('the app stylesheet declares what those classes mean', () => {
    const css = readFileSync(APP_CSS, 'utf8')
    expect(
      css,
      `.${JOB_TOAST_PASSTHROUGH_CLASS} must actually disable pointer events — without the rule ` +
        'the class is decoration and the toast still swallows every click under it',
    ).toMatch(new RegExp(`\\.${JOB_TOAST_PASSTHROUGH_CLASS}\\s*\\{[^}]*pointer-events:\\s*none`))
    expect(
      css,
      `.${JOB_TOAST_CONTROL_CLASS} must re-enable pointer events, or the toast's own close and ` +
        '"View job" controls become unclickable too',
    ).toMatch(new RegExp(`\\.${JOB_TOAST_CONTROL_CLASS}\\s*\\{[^}]*pointer-events:\\s*auto`))
  })
})

// ── WHEN the ack fires ────────────────────────────────────────────────────────────────────────
//
// Found while proving the two behaviours above, and it had to be fixed to prove them at all: on
// a host where compute is fast the ack NEVER FIRED. The poll runs every 3 s; a small analysis is
// created and finished inside one window, so the store only ever saw the job already terminal,
// and its transition rule required a previously-observed NON-terminal frame. `job-toast.spec.ts`
// — the DEC-16 spec itself — fails on this tree for exactly that reason, with "element(s) not
// found" and an empty Notifications region.
//
// That is the same requirement from the other side: a user who launches a job must learn what
// happened to it. So a job seen terminal for the FIRST time counts too — but only when it is
// NEWER than anything the previous frame held, which is what separates "it ran while we blinked"
// from "an older row became visible". Both timestamps are the server's, never the client clock.

const frame = (over: Partial<Parameters<typeof shouldFireJobToast>[0]> = {}) => ({
  status: 'completed',
  createdAtMs: 2_000,
  prior: undefined,
  seeded: true,
  newestSeenMs: 1_000,
  ...over,
})

describe('when a poll frame raises the ack', () => {
  it('fires on the observed transition — non-terminal, then terminal', () => {
    expect(shouldFireJobToast(frame({ prior: 'running' }))).toBe(true)
    expect(shouldFireJobToast(frame({ prior: 'queued' }))).toBe(true)
  })

  it('fires ONCE — a job that was already terminal last frame does not re-ack', () => {
    expect(shouldFireJobToast(frame({ prior: 'completed' }))).toBe(false)
    expect(shouldFireJobToast(frame({ status: 'failed', prior: 'failed' }))).toBe(false)
  })

  it('fires for a run that started AND finished between two polls', () => {
    // The whole reason the ack was invisible on a fast host.
    expect(
      shouldFireJobToast(frame({ prior: undefined, createdAtMs: 2_000, newestSeenMs: 1_000 })),
      'a job newer than the last frame, already finished, ran entirely between two polls',
    ).toBe(true)
  })

  it('never acks history — an older row becoming visible is not a run that just finished', () => {
    expect(
      shouldFireJobToast(frame({ prior: undefined, createdAtMs: 500, newestSeenMs: 1_000 })),
      'older than what we had already seen, so it did not run while we were watching',
    ).toBe(false)
    expect(
      shouldFireJobToast(frame({ seeded: false })),
      'the FIRST frame is a snapshot of history, not a set of transitions',
    ).toBe(false)
    expect(
      shouldFireJobToast(frame({ prior: undefined, createdAtMs: Number.NaN })),
      'an unreadable timestamp cannot establish "this ran while we were watching"',
    ).toBe(false)
  })

  it('says nothing about a job still in flight', () => {
    expect(shouldFireJobToast(frame({ status: 'running', prior: 'queued' }))).toBe(false)
    expect(shouldFireJobToast(frame({ status: 'queued', prior: undefined }))).toBe(false)
  })
})
