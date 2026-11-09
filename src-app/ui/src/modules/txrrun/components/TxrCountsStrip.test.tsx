// @vitest-environment jsdom
/**
 * TEST-RUN-19 — the per-state counter strip (`components/TxrCountsStrip.tsx`,
 * ITEM-9; PROV-UI-RUN-5): the board's finished / running / downloading /
 * waiting / failed counters render the engine's `TxrRunDetail.counts`
 * values in the board's order, and the three states the board's example
 * run never had — stopped, skipped, cannot run — render after them with
 * their own words (qa-fixes ITEM-3, RP-3: EVERY engine state is counted
 * somewhere on the screen, and each counter equals that state's own tab
 * count — a skipped method shows as "skipped", never inside the finished
 * count). A zero counter is greyed (the module palette's neutral) but still
 * visible, and an empty run renders the strip with greyed zeros without a
 * crash (a zero is a real fact, never a gap). Concurrency + memory
 * segments are NOT here — the header owns the concurrency line and the
 * memory segment is omitted by owner decision (DEC-4/OWNER-1).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { TxrRunCounts } from '@/api-client/types'
import { TxrCountsStrip } from './TxrCountsStrip'

afterEach(() => {
  cleanup()
})

/** cssstyle serializes hex colours as rgb(); normalize back to the board bytes. */
function colorHex(value: string): string {
  const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!match) return value
  return `#${match
    .slice(1)
    .map(n => Number(n).toString(16).padStart(2, '0'))
    .join('')}`
}

/** The run's eight-state counts (synthetic — the boards' facts are examples). */
function countsOf(overrides: Partial<TxrRunCounts> = {}): TxrRunCounts {
  return {
    finished: 3,
    running: 2,
    downloading: 1,
    waiting: 4,
    failed: 0,
    stopped: 1,
    skipped: 2,
    cannot_run: 1,
    ...overrides,
  }
}

function countEl(state: string) {
  return screen.getByTestId(`txr-run-counts-${state}`)
}

/** The strip's full order (the board's five, then stopped/skipped/cannot run). */
const ALL_STATES = [
  'finished',
  'running',
  'downloading',
  'waiting',
  'failed',
  'stopped',
  'skipped',
  'cannot_run',
] as const
const STATE_LABELS: Record<(typeof ALL_STATES)[number], string> = {
  finished: 'finished',
  running: 'running',
  downloading: 'downloading',
  waiting: 'waiting',
  failed: 'failed',
  stopped: 'stopped',
  skipped: 'skipped',
  cannot_run: 'cannot run',
}

describe('TxrCountsStrip (the per-state counters, TEST-RUN-19)', () => {
  it('renders every engine count in the board order with the board labels', () => {
    render(<TxrCountsStrip counts={countsOf()} />)
    expect(screen.getByTestId('txr-run-counts').textContent).toBe(
      '3 finished2 running1 downloading4 waiting0 failed1 stopped2 skipped1 cannot run',
    )
    expect(countEl('finished').textContent).toBe('3 finished')
    expect(countEl('running').textContent).toBe('2 running')
    expect(countEl('downloading').textContent).toBe('1 downloading')
    expect(countEl('waiting').textContent).toBe('4 waiting')
    expect(countEl('failed').textContent).toBe('0 failed')
    // The board's example run never had these three — they are the
    // engine's own states, each with its own word (RP-3).
    expect(countEl('stopped').textContent).toBe('1 stopped')
    expect(countEl('skipped').textContent).toBe('2 skipped')
    expect(countEl('cannot_run').textContent).toBe('1 cannot run')
  })

  it('renders each counter in its state tone; a zero counter is greyed but visible', () => {
    render(<TxrCountsStrip counts={countsOf()} />)
    const b = (state: string) =>
      countEl(state).querySelector<HTMLElement>('b')!
    expect(colorHex(b('finished').style.color)).toBe('var(--txr-success)')
    expect(colorHex(b('running').style.color)).toBe('var(--txr-brand-ink)')
    expect(colorHex(b('downloading').style.color)).toBe('var(--txr-warning)')
    expect(colorHex(b('waiting').style.color)).toBe('var(--txr-muted)')
    expect(b('failed').textContent).toBe('0')
    expect(colorHex(b('failed').style.color)).toBe('var(--txr-muted)')
    expect(colorHex(b('stopped').style.color)).toBe('var(--txr-muted)')
    expect(colorHex(b('skipped').style.color)).toBe('var(--txr-muted)')
    expect(colorHex(b('cannot_run').style.color)).toBe('var(--txr-danger)')
  })

  it('renders an empty run as greyed zero counters without a crash', () => {
    render(<TxrCountsStrip counts={countsOf({ finished: 0, running: 0, downloading: 0, waiting: 0, failed: 0, stopped: 0, skipped: 0, cannot_run: 0 })} />)
    expect(screen.getByTestId('txr-run-counts').textContent).toBe(
      '0 finished0 running0 downloading0 waiting0 failed0 stopped0 skipped0 cannot run',
    )
    for (const state of ALL_STATES) {
      expect(countEl(state).textContent).toBe(`0 ${STATE_LABELS[state]}`)
    }
  })
})
