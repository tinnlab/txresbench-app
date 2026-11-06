// @vitest-environment jsdom
/**
 * TEST-RUN-19 — the five-count strip (`components/TxrCountsStrip.tsx`,
 * ITEM-9; PROV-UI-RUN-5): the board's finished / running / downloading /
 * waiting / failed counters render the engine's `TxrRunDetail.counts`
 * values, their order is the board's left-to-right, a zero counter is
 * greyed (the module palette's neutral) but still visible, and an empty run
 * renders the strip with five zeros without a crash (a zero is a real fact,
 * never a gap). Concurrency + memory segments are NOT here — the header
 * owns the concurrency line and the memory segment is omitted by owner
 * decision (DEC-4/OWNER-1).
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

describe('TxrCountsStrip (the five counters, TEST-RUN-19)', () => {
  it('renders the five engine counts in the board order with the board labels', () => {
    render(<TxrCountsStrip counts={countsOf()} />)
    expect(screen.getByTestId('txr-run-counts').textContent).toBe(
      '3 finished2 running1 downloading4 waiting0 failed',
    )
    expect(countEl('finished').textContent).toBe('3 finished')
    expect(countEl('running').textContent).toBe('2 running')
    expect(countEl('downloading').textContent).toBe('1 downloading')
    expect(countEl('waiting').textContent).toBe('4 waiting')
    expect(countEl('failed').textContent).toBe('0 failed')
  })

  it('renders each counter in its state tone; a zero counter is greyed but visible', () => {
    render(<TxrCountsStrip counts={countsOf()} />)
    const b = (state: string) =>
      countEl(state).querySelector<HTMLElement>('b')!
    expect(colorHex(b('finished').style.color)).toBe('#1f6b3a')
    expect(colorHex(b('running').style.color)).toBe('#143a68')
    expect(colorHex(b('downloading').style.color)).toBe('#8a5a00')
    expect(colorHex(b('waiting').style.color)).toBe('#5e5e5e')
    expect(b('failed').textContent).toBe('0')
    expect(colorHex(b('failed').style.color)).toBe('#5e5e5e')
  })

  it('renders an empty run as five visible zero counters without a crash', () => {
    render(<TxrCountsStrip counts={countsOf({ finished: 0, running: 0, downloading: 0, waiting: 0, failed: 0 })} />)
    expect(screen.getByTestId('txr-run-counts').textContent).toBe(
      '0 finished0 running0 downloading0 waiting0 failed',
    )
    for (const state of ['finished', 'running', 'downloading', 'waiting', 'failed']) {
      expect(countEl(state).textContent).toBe(`0 ${state}`)
    }
  })
})
