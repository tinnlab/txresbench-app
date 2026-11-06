// @vitest-environment jsdom
/**
 * TEST-RUN-21 — the F method table (`components/TxrRunTable.tsx`, ITEM-10;
 * PROV-UI-RUN-5, INV-2, DEC-2/5/10): the rows are keyed by method_id (the
 * page passes the tab-filtered row set — the tab chips + filtering are the
 * page's own state, TEST-RUN-23 / PLAN ITEM-9 note (a); the table never
 * filters), the row/action test-ids (`txr-run-row-<id>`,
 * `txr-run-action-<id>`) are the stable anchors of the module's test-id
 * contract, `Stop all` opens the kit confirm dialog and reports the host's
 * stop-all ONLY after the confirmation (DEC-10: a per-row confirm is
 * friction, an all-methods abort gets the gate), and the at-a-time row
 * renders the run's value and reports the lane pick (the GAP call site —
 * the host's `onAtATime` is what the page binds to the run store's
 * `setAtATime`). GROWN since the plan (DRIFT-1 ITEM-5 #1): the row-error
 * pass-through (a refused stop/skip keeps the row's state and disables its
 * action) and the two run-level error lines (Stop all's failure, the lane
 * pick's typed failure) render — a failed control is never silent.
 *
 * Every fixture value is synthetic (INV-6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TxrRunMethod } from '@/api-client/types'
import { TxrRunTable, type TxrRunTableProps } from './TxrRunTable'
import type { TxrRunRowAction } from './TxrRunRow'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function row(id: string, state: TxrRunMethod['state']): TxrRunMethod {
  return {
    method_id: id,
    label: id,
    version: '1.0.0',
    group: 'response-call',
    group_label: 'Response call',
    state,
    bytes_downloaded: 0,
  }
}

function propsOf(overrides: Partial<TxrRunTableProps> = {}): TxrRunTableProps {
  return {
    rows: [row('method-1', 'running'), row('method-2', 'waiting'), row('method-3', 'finished')],
    perMethod: {},
    rowErrors: {},
    onAction: () => undefined,
    atATime: 3,
    onAtATime: () => undefined,
    atATimeError: null,
    onStopAll: () => undefined,
    stopping: false,
    actionError: null,
    ...overrides,
  }
}

function renderTable(overrides: Partial<TxrRunTableProps> = {}) {
  const onAction = vi.fn()
  const onAtATime = vi.fn()
  const onStopAll = vi.fn()
  const utils = render(
    <TxrRunTable {...propsOf({ onAction, onAtATime, onStopAll, ...overrides })} />,
  )
  return { ...utils, onAction, onAtATime, onStopAll }
}

describe('TxrRunTable — the per-method grid (TEST-RUN-21)', () => {
  it('renders one row per passed method, keyed by method_id, in the passed order', () => {
    renderTable()
    expect(screen.getByTestId('txr-run-table')).toBeTruthy()
    // Keyed by method_id — the test-id contract (PROV-UI-RUN-1), one tr per row.
    expect(screen.getByTestId('txr-run-row-method-1')).toBeTruthy()
    expect(screen.getByTestId('txr-run-row-method-2')).toBeTruthy()
    expect(screen.getByTestId('txr-run-row-method-3')).toBeTruthy()
    const rows = screen
      .getByTestId('txr-run-table')
      .querySelectorAll('tr[data-testid^="txr-run-row-"]')
    expect(rows).toHaveLength(3)
    // The table never filters — the page's tab choice is the row set it is given.
    expect(rows[0].getAttribute('data-testid')).toBe('txr-run-row-method-1')
    expect(rows[2].getAttribute('data-testid')).toBe('txr-run-row-method-3')
  })

  it('reports each row\'s per-state action through onAction (the host owns the store)', () => {
    const { onAction } = renderTable()
    fireEvent.click(screen.getByTestId('txr-run-action-method-1'))
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'stop', methodId: 'method-1' })
    fireEvent.click(screen.getByTestId('txr-run-action-method-2'))
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'skip', methodId: 'method-2' })
    fireEvent.click(screen.getByTestId('txr-run-action-method-3'))
    expect(onAction).toHaveBeenLastCalledWith({ kind: 'view', methodId: 'method-3' })
    expect(screen.getByTestId('txr-run-action-method-1').textContent).toBe('Stop')
    expect(screen.getByTestId('txr-run-action-method-2').textContent).toBe('Skip')
    expect(screen.getByTestId('txr-run-action-method-3').textContent).toBe('View result')
  })

  it('renders the run\'s at-a-time value and reports the lane pick (the GAP call site)', () => {
    const { onAtATime } = renderTable({ atATime: 3 })
    const control = screen.getByTestId('txr-run-at-a-time-control')
    // The value (3) sits outside the presets — its own chip; picking a preset reports.
    expect(within(control).getAllByRole('tab').map(b => b.textContent)).toEqual([
      '1',
      '2',
      '4',
      '3',
    ])
    fireEvent.click(within(control).getAllByRole('tab')[2])
    expect(onAtATime).toHaveBeenCalledWith(4)
  })

  it('renders a visible empty row for an empty (tab-filtered) row set without a crash', () => {
    renderTable({ rows: [] })
    expect(screen.getByTestId('txr-run-table-empty').textContent).toBe('No methods in this view.')
  })
})

describe('TxrRunTable — Stop all + the confirm gate (TEST-RUN-21, DEC-10)', () => {
  it('opens the confirmation and only reports the stop-all AFTER it', () => {
    const { onStopAll } = renderTable()
    fireEvent.click(screen.getByTestId('txr-run-stop-all'))
    expect(screen.getByTestId('txr-run-stop-all-confirm')).toBeTruthy()
    expect(onStopAll).not.toHaveBeenCalled()

    fireEvent.click(within(screen.getByTestId('txr-run-stop-all-confirm')).getByText('Stop all'))
    expect(onStopAll).toHaveBeenCalledTimes(1)
  })

  it('reports nothing on Cancel', () => {
    const { onStopAll } = renderTable()
    fireEvent.click(screen.getByTestId('txr-run-stop-all'))
    fireEvent.click(within(screen.getByTestId('txr-run-stop-all-confirm')).getByText('Cancel'))
    expect(onStopAll).not.toHaveBeenCalled()
  })

  it('disables the at-a-time row while a run-level action is in flight', () => {
    renderTable({ stopping: true })
    for (const option of within(
      screen.getByTestId('txr-run-at-a-time-control'),
    ).getAllByRole('tab')) {
      expect(option.getAttribute('aria-disabled')).toBe('true')
    }
  })
})

describe('TxrRunTable — the grown error surfaces (DRIFT-1 ITEM-5 #1)', () => {
  it('passes a row error through: the row keeps its state, its action disables, the line renders', () => {
    renderTable({ rowErrors: { 'method-1': 'the method is not active' } })
    const action = screen.getByTestId('txr-run-action-method-1')
    expect(action.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('txr-run-row-error-method-1').textContent).toBe(
      'the method is not active',
    )
    expect(screen.getByTestId('txr-run-action-method-2').hasAttribute('disabled')).toBe(false)
  })

  it('renders the run-level action error and the lane pick\'s typed failure — never silent', () => {
    renderTable({
      actionError: 'the run could not be stopped',
      atATimeError: 'Could not change the number running at a time.',
    })
    expect(screen.getByTestId('txr-run-action-error').textContent).toBe(
      'the run could not be stopped',
    )
    expect(screen.getByTestId('txr-run-at-a-time-error').textContent).toBe(
      'Could not change the number running at a time.',
    )
  })
})
