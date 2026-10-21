// @vitest-environment jsdom
// The job-detail view's two owner-reported defects, pinned as behaviour:
//
//  1. READING ORDER — the "All jobs" back affordance must come BEFORE the job title.
//     It shipped rendered AFTER the SectionHeader, so the escape hatch sat below the
//     name it escapes from. Asserted on DOM ORDER, not on markup text, so a future
//     re-layout that keeps the order keeps passing.
//
//  2. THE ERROR IS NOT RENDERED TWICE — and is never LOST. A failed analysis's
//     terminal `error` is assembled server-side by folding the child's stderr TAIL into
//     it (`scheduler.rs::with_stderr_tail`), so for that job the standalone error block
//     repeated text the log pane already shows in full. But `error` is ALSO set on paths
//     that produce NO log line at all — a pre-spawn arch refusal, a staging-ceiling
//     spawn timeout, a `dependency_failed` cascade, a boot-reconcile failure — where it
//     is the ONLY explanation a failed job has. So the block is conditional, not deleted:
//     shown exactly when the log stream does not already carry it.

import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Job, JobDetail, JobLog } from '@/api-client/types'
import { JobsPaneView } from './JobsPane'
import { JOB_STOP_UNAVAILABLE_REASON } from '@/modules/jobs/stopAuthority'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

afterEach(cleanup)

const JOB_ID = '00000000-0000-4000-8000-00000000dead'

function job(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    name: 'Nightly run',
    job_type: 'analysis',
    status: 'failed',
    owner_id: 'owner-1',
    params: {},
    priority_class: 'normal',
    resource_class: 'cpu-sandbox',
    created_at: '2026-07-19T12:00:00Z',
    ...over,
  }
}

function log(seq: number, stream: 'stdout' | 'stderr', content: string): JobLog {
  return { id: `l${seq}`, job_id: JOB_ID, seq, stream, content, created_at: '2026-07-19T12:00:0%dZ' }
}

/** Render the pane in DETAIL mode for one job. Metrics stay empty so the lazily-loaded
 *  Observable-Plot chunk is never requested (the chart renders its placeholder box). */
function renderDetail(detail: JobDetail) {
  render(
    <JobsPaneView
      paneId="t"
      jobs={[{ job: detail.job, can_stop: detail.can_stop }]}
      total={1}
      page={1}
      perPage={10}
      loading={false}
      error={null}
      selectedId={detail.job.id}
      detail={detail}
      detailLoading={false}
      streaming={false}
      onSelect={() => {}}
      onStop={() => {}}
      onBack={() => {}}
      onPage={() => {}}
      onRetry={() => {}}
    />,
  )
  return screen.getByTestId('workbench-jobs-detail')
}

function detailOf(over: Partial<Job>, logs: JobLog[], canStop = true): JobDetail {
  return { job: job(over), logs, metrics: [], milestones: [], can_stop: canStop }
}

describe('job detail — the back affordance is on top', () => {
  it('renders "All jobs" BEFORE the job title in the document', () => {
    renderDetail(detailOf({ status: 'running' }, [log(1, 'stdout', 'step 1')]))
    const back = screen.getByTestId('workbench-jobs-detail-back')
    const header = screen.getByTestId('workbench-jobs-detail-header')

    // DOCUMENT_POSITION_FOLLOWING (4) = `header` comes after `back` in document order.
    // eslint-disable-next-line no-bitwise
    const headerFollowsBack = back.compareDocumentPosition(header) & 4
    expect(
      headerFollowsBack,
      'the "All jobs" back button must render above the job name — back-then-title reading order',
    ).toBeTruthy()
  })

  it('keeps the back affordance reachable as a real button', () => {
    renderDetail(detailOf({ status: 'running' }, []))
    const back = screen.getByTestId('workbench-jobs-detail-back')
    expect(back.tagName).toBe('BUTTON')
    expect(back.textContent).toContain('All jobs')
  })
})

describe('job detail — a failed job always explains itself', () => {
  // The case a naive deletion of the error block breaks: the job never produced a single
  // log line, so the log pane can only say "No output yet". Server paths that reach here:
  // `arch-incompatible: …` (refused pre-spawn), `job runner did not start a process within
  // Ns (staging ceiling)`, `dependency_failed` (a cascade onto a job that never ran).
  it('shows the terminal error when the job produced NO log output', () => {
    const detail = renderDetail(
      detailOf(
        { status: 'failed', error: 'arch-incompatible: processor requires arm64, backend is x86_64' },
        [],
      ),
    )
    expect(detail.textContent).toContain('No output yet')
    expect(
      detail.textContent,
      'a failed job with an empty log stream would otherwise carry NO visible explanation',
    ).toContain('arch-incompatible: processor requires arm64, backend is x86_64')
  })

  it('shows the terminal error when the logs exist but do not carry it', () => {
    // A boot reconcile / restart interrupt sets `error` on a job whose child DID log.
    // The reason is a server-side determination that was never written to the stream.
    const detail = renderDetail(
      detailOf({ status: 'failed', error: 'interrupted by server restart (workspace preserved)' }, [
        log(1, 'stdout', 'Reading input (5000 x 2)...'),
      ]),
    )
    expect(detail.textContent).toContain('interrupted by server restart (workspace preserved)')
  })
})

describe('job detail — the error is not rendered twice', () => {
  it('does not repeat the stderr tail the log pane already shows', () => {
    // `with_stderr_tail` folds the child's last stderr lines INTO the terminal error, so
    // rendering both showed the same traceback twice on one screen.
    const stderr = 'ValueError: bad superblock version number'
    const detail = renderDetail(
      detailOf({ status: 'failed', error: `analysis exited with code 1: ${stderr}` }, [
        log(1, 'stdout', 'Reading input...'),
        log(2, 'stderr', stderr),
      ]),
    )
    const occurrences = (detail.textContent ?? '').split(stderr).length - 1
    expect(occurrences, 'the failure text must appear once, in the log, not twice').toBe(1)
  })

  it('dedupes a MULTI-LINE traceback, whose fold joins the lines with " | "', () => {
    // The real shape: `with_stderr_tail` joins the last N stderr lines with " | ", so the
    // error ends with the LAST line and merely contains the earlier ones. A job's stderr is
    // almost always several lines (a Python traceback), never one.
    const lines = [
      'Traceback (most recent call last):',
      '  File "/work/run.py", line 42, in <module>',
      'ValueError: bad superblock version number',
    ]
    const detail = renderDetail(
      detailOf({ status: 'failed', error: `analysis exited with code 1: ${lines.join(' | ')}` }, [
        log(1, 'stderr', lines[0]),
        log(2, 'stderr', lines[1]),
        log(3, 'stderr', lines[2]),
      ]),
    )
    for (const line of lines) {
      const occurrences = (detail.textContent ?? '').split(line).length - 1
      expect(occurrences, `"${line}" must appear once, in the log, not twice`).toBe(1)
    }
  })

  it('still dedupes when the child prints to stdout AFTER the failure', () => {
    // stdout/stderr interleave: the wrapper's final "cleanup" line lands after the
    // traceback. The error is still the folded stderr tail, so it is still a duplicate —
    // only the last non-empty STDERR line characterises the fold, not the last log line.
    const stderr = 'ValueError: bad superblock version number'
    const detail = renderDetail(
      detailOf({ status: 'failed', error: `analysis exited with code 1: ${stderr}` }, [
        log(1, 'stderr', stderr),
        log(2, 'stdout', 'cleaning up workspace'),
      ]),
    )
    const occurrences = (detail.textContent ?? '').split(stderr).length - 1
    expect(occurrences, 'a trailing stdout line must not resurrect the duplicate').toBe(1)
  })

  it('is not fooled into hiding the error by a trailing BLANK stderr line', () => {
    // A blank line is contained in / ends every string. Treating it as a match would
    // suppress the explanation for every job whose log happens to end in whitespace.
    const detail = renderDetail(
      detailOf({ status: 'failed', error: 'interrupted by server restart (workspace preserved)' }, [
        log(1, 'stderr', 'warning: resolution is high'),
        log(2, 'stderr', '   '),
      ]),
    )
    expect(detail.textContent).toContain('interrupted by server restart (workspace preserved)')
  })

  it('still renders the stderr line itself in the log pane', () => {
    const stderr = 'ValueError: bad superblock version number'
    const detail = renderDetail(
      detailOf({ status: 'failed', error: `analysis exited with code 1: ${stderr}` }, [
        log(2, 'stderr', stderr),
      ]),
    )
    expect(screen.getByTestId('workbench-jobs-logs').textContent).toContain(stderr)
    expect(detail.textContent).not.toContain('No output yet')
  })
})

// ── The Stop control renders the SERVER'S answer ─────────────────────────────────────────
//
// Sight and stop are different rights: an editor of the dataset/project a job runs on may LIST
// it, but only the run's creator, the owner of its scope, or an admin may STOP it. The pane used
// to gate Stop on the per-project EDIT role (`jobStopVisible(active, canEdit)`) — a second,
// client-side copy of an authorization rule, which both offered a Stop the server refuses and
// hid one it would have allowed. These are mounted, not source-scanned: what is asserted is what
// a user meets.

describe('job detail — Stop renders the server-stated right, never a re-derived one', () => {
  it('fires when the server said this caller may stop the run', () => {
    renderDetail(detailOf({ status: 'running' }, [], true))
    const stop = screen.getByTestId('workbench-jobs-detail-stop')
    expect(stop.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('is SHOWN and refuses, saying who may stop it, when the server said this caller may not', () => {
    // The defect being fixed, from the other side: this control used to be ABSENT for anyone the
    // role gate excluded. A refusal a user cannot see is one they cannot act on — they cannot ask
    // the owner for something they never learned exists.
    renderDetail(detailOf({ status: 'running' }, [], false))
    const stop = screen.getByTestId('workbench-jobs-detail-stop')
    expect(stop, 'the control must be present, not hidden').toBeTruthy()
    expect(stop.getAttribute('aria-disabled')).toBe('true')
    expect(stop.textContent).toContain(JOB_STOP_UNAVAILABLE_REASON)
  })

  it('NEGATIVE CONTROL — a terminal job has no Stop at all, whatever can_stop says', () => {
    // `can_stop` answers "may you", not "is there anything to stop" (stopping a finished job is a
    // 409, not a 403), so the status check has to survive as a separate condition. Without this,
    // rendering purely from `can_stop` would pass every other assertion here.
    renderDetail(detailOf({ status: 'completed' }, [], true))
    expect(screen.queryByTestId('workbench-jobs-detail-stop')).toBeNull()
  })
})
