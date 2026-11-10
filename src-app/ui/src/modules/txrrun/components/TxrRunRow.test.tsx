// @vitest-environment jsdom
/**
 * TEST-RUN-20 — the F method row (`components/TxrRunRow.tsx`, ITEM-10;
 * PROV-UI-RUN-2/5, INV-1/2): every engine state renders its chip/label,
 * detail, progress bar and time from the PROV-UI-RUN-2 formatters
 * (waiting: "waiting" + empty detail; downloading: the board's "N of M MB"
 * download line + the env bar; running: the latest progress frame's
 * message + the row's elapsed; finished: "done in M min S s" via
 * `duration_ms`; failed/cannot_run: the reason line, never blank) and the
 * per-state action is exactly the plan's frozen mapping
 * (waiting|downloading → Skip, running → Stop, finished → View result,
 * failed|stopped|skipped|cannot_run → Show log) — reported as
 * `{kind, methodId}`, never executed here (the host owns the store calls).
 *
 * The row error (the stop/skip 409 surface, DRIFT-1 ITEM-5 #1): the row
 * keeps its state, its action disables and the error line renders — the
 * assertion TEST-RUN-11's store pin demands of the surface.
 *
 * Every expected string is built from the fixture's synthetic numbers
 * (INV-6 — the board's example values are design examples, never data).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TxrRunMethod, TxrRunProgressFrame } from '@/api-client/types'
import { TxrRunRow, type TxrRunRowAction } from './TxrRunRow'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const MB = 1024 * 1024

function row(state: TxrRunMethod['state'], over: Partial<TxrRunMethod> = {}): TxrRunMethod {
  return {
    method_id: 'method-a',
    label: 'method-a',
    version: '1.0.0',
    group: 'response-call',
    group_label: 'Response call',
    state,
    bytes_downloaded: 0,
    ...over,
  }
}

const progress = (message: string, pct: number): TxrRunProgressFrame => ({
  method_id: 'method-a',
  message,
  pct,
})

function renderRow(
  r: TxrRunMethod,
  {
    progress: p = null,
    rowError = null,
    onAction = vi.fn<(action: TxrRunRowAction) => void>(),
  }: {
    progress?: TxrRunProgressFrame | null
    rowError?: string | null
    onAction?: ReturnType<typeof vi.fn<(action: TxrRunRowAction) => void>>
  } = {},
  nowMs: number | null = null,
) {
  const utils = render(
    <table>
      <tbody>
        <TxrRunRow row={r} progress={p} rowError={rowError} onAction={onAction} nowMs={nowMs} />
      </tbody>
    </table>,
  )
  return { ...utils, onAction, rowEl: screen.getByTestId('txr-run-row-method-a') }
}

describe('TxrRunRow — the per-state row facts (TEST-RUN-20)', () => {
  it('renders a waiting row: state word, empty detail and time, empty bar, Skip', () => {
    const { rowEl, onAction } = renderRow(row('waiting'))
    expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe('waiting')
    expect(within(rowEl).queryByTestId('txr-run-detail-method-a')).toBeNull()
    expect(within(rowEl).queryByTestId('txr-run-time-method-a')).toBeNull()
    expect(within(rowEl).getByTestId('txr-run-bar-method-a').style.width).toBe('0%')
    const action = within(rowEl).getByTestId('txr-run-action-method-a')
    expect(action.textContent).toBe('Skip')
    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledWith({ kind: 'skip', methodId: 'method-a' })
  })

  it('renders a downloading row: the board download line + the env bar, Skip', () => {
    const { rowEl, onAction } = renderRow(
      row('downloading', { bytes_downloaded: 160 * MB, bytes_total: 250 * MB, progress_pct: 64 }),
    )
    expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe('downloading')
    expect(within(rowEl).getByTestId('txr-run-detail-method-a').textContent).toBe('160 of 250 MB')
    expect(within(rowEl).getByTestId('txr-run-bar-method-a').style.width).toBe('64%')
    expect(within(rowEl).queryByTestId('txr-run-time-method-a')).toBeNull()
    const action = within(rowEl).getByTestId('txr-run-action-method-a')
    expect(action.textContent).toBe('Skip')
    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledWith({ kind: 'skip', methodId: 'method-a' })
  })

  it('renders a running row: the latest frame message + the frame bar + its elapsed, Stop', () => {
    const { rowEl, onAction } = renderRow(row('running', { elapsed_secs: 100 }), {
      progress: progress('tree 140 of 500', 32),
    })
    expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe('running')
    expect(within(rowEl).getByTestId('txr-run-detail-method-a').textContent).toBe('tree 140 of 500')
    expect(within(rowEl).getByTestId('txr-run-bar-method-a').style.width).toBe('32%')
    expect(within(rowEl).getByTestId('txr-run-time-method-a').textContent).toBe('1 min 40 s')
    const action = within(rowEl).getByTestId('txr-run-action-method-a')
    expect(action.textContent).toBe('Stop')
    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledWith({ kind: 'stop', methodId: 'method-a' })
  })

  it('reads a working row\'s LIVE elapsed from the page clock (qa-fixes2 R2-4 — the Time column was empty during the run)', () => {
    const start = '2026-11-06T00:00:40Z'
    const nowMs = Date.parse('2026-11-06T00:01:30Z')
    const { rowEl } = renderRow(row('running', { started_at: start, elapsed_secs: 5 }), {}, nowMs)
    expect(within(rowEl).getByTestId('txr-run-time-method-a').textContent).toBe('50 s')
  })

  it('a downloading row with no bytes yet reads no "0 of 0 MB" detail (qa-fixes2 R2-4)', () => {
    const { rowEl } = renderRow(row('downloading', { bytes_downloaded: 0, bytes_total: 4096 }))
    expect(within(rowEl).queryByTestId('txr-run-detail-method-a')).toBeNull()
    expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe('downloading')
  })

  it('renders a finished row: the done-line from duration_ms, a full bar, View result', () => {
    const { rowEl, onAction } = renderRow(row('finished', { duration_ms: 112000 }))
    expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe('finished')
    expect(within(rowEl).queryByTestId('txr-run-detail-method-a')).toBeNull()
    expect(within(rowEl).getByTestId('txr-run-bar-method-a').style.width).toBe('100%')
    expect(within(rowEl).getByTestId('txr-run-time-method-a').textContent).toBe(
      'done in 1 min 52 s',
    )
    const action = within(rowEl).getByTestId('txr-run-action-method-a')
    expect(action.textContent).toBe('View result')
    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledWith({ kind: 'view', methodId: 'method-a' })
  })

  it('renders the failure reason, never a blank line, for failed and cannot_run — Show log', () => {
    const reason = { code: 'NEEDS_MARKER', detail: 'needs LDH, not in your file' }
    for (const state of ['failed', 'cannot_run'] as const) {
      cleanup()
      const { rowEl, onAction } = renderRow(
        row(state, { reason, elapsed_secs: 5, duration_ms: 5000 }),
      )
      expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe(
        state === 'failed' ? 'failed' : 'cannot run',
      )
      expect(within(rowEl).getByTestId('txr-run-detail-method-a').textContent).toBe(reason.detail)
      // A failed row's bar reads 100 (it ran then failed); a cannot-run row
      // reads 0 (nothing ran — the row is a note, not a bar).
      expect(within(rowEl).getByTestId('txr-run-bar-method-a').style.width).toBe(
        state === 'failed' ? '100%' : '0%',
      )
      // The row's own elapsed, in the board's duration words (sub-minute
      // reads its seconds — qa-fixes2 R2-4).
      expect(within(rowEl).getByTestId('txr-run-time-method-a').textContent).toBe('5 s')
      const action = within(rowEl).getByTestId('txr-run-action-method-a')
      expect(action.textContent).toBe('Show log')
      fireEvent.click(action)
      expect(onAction).toHaveBeenCalledWith({ kind: 'log', methodId: 'method-a' })
    }
  })

  it('renders a reason-less failure with the constant line (never blank)', () => {
    const { rowEl } = renderRow(row('failed'))
    expect(within(rowEl).getByTestId('txr-run-detail-method-a').textContent).toBe(
      'no reason recorded',
    )
  })

  it('a stopped row reads its own elapsed; a skipped row reads NOTHING (RP-7 — it never ran), Show log', () => {
    for (const state of ['stopped', 'skipped'] as const) {
      cleanup()
      const { rowEl, onAction } = renderRow(
        row(state, { elapsed_secs: 47, duration_ms: 90000 }),
      )
      expect(within(rowEl).getByTestId('txr-run-state-method-a').textContent).toBe(state)
      // The stopped row ran for 47 s → its elapsed; the skipped row never
      // ran → no time cell at all, never the engine's duration_ms ("done
      // in …" on a row that never started is a lie).
      expect(
        within(rowEl).queryByTestId('txr-run-time-method-a')?.textContent ?? null,
      ).toBe(state === 'stopped' ? '47 s' : null)
      // The bar keeps the progress the row reached (none in this fixture —
      // never a fabricated 100 for a row that did not complete).
      expect(within(rowEl).getByTestId('txr-run-bar-method-a').style.width).toBe('0%')
      const action = within(rowEl).getByTestId('txr-run-action-method-a')
      expect(action.textContent).toBe('Show log')
      fireEvent.click(action)
      expect(onAction).toHaveBeenCalledWith({ kind: 'log', methodId: 'method-a' })
    }
  })
})

describe('TxrRunRow — the action-error surface (DRIFT-1 ITEM-5 #1)', () => {
  it('disables the action and renders the row error when the store refused the control', () => {
    const { rowEl, onAction } = renderRow(row('running'), {
      rowError: 'the method is not active',
    })
    const action = within(rowEl).getByTestId('txr-run-action-method-a')
    expect(action.hasAttribute('disabled')).toBe(true)
    expect(within(rowEl).getByTestId('txr-run-row-error-method-a').textContent).toBe(
      'the method is not active',
    )
    // A disabled action never reports (the store clears the error on the
    // next attempt; the engine's frames decide the row's next state).
    fireEvent.click(within(rowEl).getByTestId('txr-run-action-method-a'))
    expect(onAction).not.toHaveBeenCalled()
  })
})
