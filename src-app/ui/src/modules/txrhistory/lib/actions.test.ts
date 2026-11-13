/**
 * TEST-HIST-6 — txrhistory capability resolution (PROV-HIST-4, INV-3;
 * ITEM-3).
 *
 * The board's two open paths and the DEC-6 fallback, pinned as the flag
 * matrix:
 *
 * - a finished run WITH stored copies: "Open the results" + "Run again
 *   with the same settings" (rerun) + download + reveal + log — never
 *   the settings-again flag OF THAT ROW;
 * - a copy-cleared finished run: "Use these settings again" (settingsAgain)
 *   and NEVER rerun — the exclusivity is asserted both ways (a rerun call
 *   on a `can_rerun: false` row is a test failure, DEC-6);
 * - a RUNNING row: "Open the running run" and never "Open the results"
 *   even when `can_reopen` is true, and neither rerun nor settingsAgain
 *   (the F screen owns the running row's controls; an action this row
 *   cannot serve is hidden, never dead);
 * - "Open the folder" is desktop-only (the PROV-UR-7 gate — web mode
 *   renders the path text instead) and terminal-only (the run dir is the
 *   terminal-run's artifact);
 * - "Show the log" is always offered — the log dialog's data exists for
 *   every run state.
 */
import { describe, expect, it } from 'vitest'
import type { TxrActionFacts } from './actions'
import { actionsFor } from './actions'

function facts(over: Partial<TxrActionFacts> = {}): TxrActionFacts {
  return {
    bucket: 'finished',
    can_reopen: true,
    can_rerun: true,
    can_download: true,
    ...over,
  }
}

describe('actionsFor (TEST-HIST-6)', () => {
  it('exposes the copy-kept finished row: open results, rerun, download, reveal, log — never settings again', () => {
    expect(actionsFor(facts(), { isDesktop: true })).toEqual({
      openResults: true,
      openRunning: false,
      rerun: true,
      settingsAgain: false,
      download: true,
      reveal: true,
      log: true,
      deleteRun: true,
    })
  })

  it('keeps download/reveal/log on the finished row even when nothing can be re-run (the row still has its artifacts)', () => {
    expect(actionsFor(facts({ can_rerun: false }), { isDesktop: true })).toEqual({
      openResults: true,
      openRunning: false,
      rerun: false,
      settingsAgain: true,
      download: true,
      reveal: true,
      log: true,
      deleteRun: true,
    })
  })

  it('asserts the rerun/settings-again exclusivity BOTH ways (a rerun on a copy-cleared run is a test failure)', () => {
    const rerunRow = actionsFor(facts({ can_rerun: true }), { isDesktop: true })
    const settingsRow = actionsFor(facts({ can_rerun: false }), { isDesktop: true })
    expect(rerunRow.rerun && !rerunRow.settingsAgain).toBe(true)
    expect(settingsRow.settingsAgain && !settingsRow.rerun).toBe(true)
  })

  it('never offers open results or settings again on a running row — the running route is the action (INV-3)', () => {
    const running = actionsFor(facts({ bucket: 'running', can_rerun: false }), { isDesktop: true })
    expect(running.openRunning).toBe(true)
    expect(running.openResults).toBe(false)
    expect(running.rerun).toBe(false)
    expect(running.settingsAgain).toBe(false)
    expect(running.reveal).toBe(false)
  })

  it('processing a row with can_reopen false (a failed/stopped run) hides open-results but keeps its other artifacts', () => {
    const failed = actionsFor(facts({ bucket: 'failed', can_reopen: false }), { isDesktop: true })
    expect(failed.openResults).toBe(false)
    expect(failed.download).toBe(true)
    expect(failed.log).toBe(true)
    expect(failed.reveal).toBe(true)
  })

  it('removes reveal when not desktop (the PROV-UR-7 gate — web mode renders the path text)', () => {
    expect(actionsFor(facts(), { isDesktop: false }).reveal).toBe(false)
    expect(actionsFor(facts(), { isDesktop: true }).reveal).toBe(true)
  })

  it('ITEM-2 (f): "Delete this run" is desktop-only (the web demo hides delete — its spec section 3)', () => {
    expect(actionsFor(facts(), { isDesktop: true }).deleteRun).toBe(true)
    expect(actionsFor(facts(), { isDesktop: false }).deleteRun).toBe(false)
    expect(actionsFor(facts({ bucket: 'running' }), { isDesktop: true }).deleteRun).toBe(true)
  })

  it('follows the download flag for "Download predictions"', () => {
    expect(actionsFor(facts({ can_download: false }), { isDesktop: true }).download).toBe(false)
    expect(actionsFor(facts({ can_download: true }), { isDesktop: true }).download).toBe(true)
  })

  it('always offers the log (the engine log exists for every run state)', () => {
    for (const bucket of ['running', 'finished', 'stopped', 'failed'] as const) {
      expect(actionsFor(facts({ bucket }), { isDesktop: false }).log).toBe(true)
    }
  })

  it('resolves against the expanded detail record too (the detail shares the four facts — the pick shape)', () => {
    // `TxrHistoryDetail` satisfies `TxrActionFacts` (same field names), so
    // the expanded block binds the record it already loaded.
    const detail = {
      ...facts({ can_rerun: false }),
      id: 'run-1',
      mode: 'train' as const,
      created_at: '2026-11-05T10:02:00Z',
    }
    expect(actionsFor(detail, { isDesktop: true }).settingsAgain).toBe(true)
  })
})
