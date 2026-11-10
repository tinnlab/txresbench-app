// @vitest-environment jsdom
/**
 * TEST-RUN-18 — the F header (`components/TxrRunHeader.tsx`, ITEM-9;
 * PROV-UI-RUN-5, INV-2, CONS-UI-RUN-15, DEC-4/11/12): the title's count
 * from the run's rows, the time-left/elapsed line (each segment omitted
 * when unknown, the board's "·"-joined sentence), the concurrency line
 * ("N run at a time on M CPUs" — the memory segment is absent per DEC-4/
 * OWNER-1, the bare "N run at a time" when the run detected no CPU count), the
 * "See the results" link (exactly when the run is results-readable —
 * DEC-12's effective readiness; target via `txrresults`' own
 * `resultsPath(runId)` builder, never a URL literal) and the research-use
 * caption (DEC-11 — one constant with E's bar).
 *
 * Every expected string is built from the fixture's own synthetic numbers;
 * the board's example values are design examples, never data (INV-6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { resultsPath } from '@/modules/txrresults/routes'
import { RESEARCH_NOTICE } from '../lib/format'
import { formatRunTitle, TxrRunHeader, type TxrRunHeaderProps } from './TxrRunHeader'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function propsOf(overrides: Partial<TxrRunHeaderProps> = {}): TxrRunHeaderProps {
  return {
    title: 'Running 6 methods',
    timeLeft: 'about 2 minutes left',
    elapsed: '1 min 40 s elapsed',
    estimateWord: 'measured estimate',
    atATime: 3,
    cpus: 4,
    predictionsReady: false,
    runId: 'run-1',
    onSeeResults: () => undefined,
    ...overrides,
  }
}

function renderHeader(overrides: Partial<TxrRunHeaderProps> = {}) {
  return render(
    <MemoryRouter>
      <TxrRunHeader {...propsOf(overrides)} />
    </MemoryRouter>,
  )
}

describe('TxrRunHeader (F header, TEST-RUN-18)', () => {
  it('titles with the run\'s method count (the board words; singular at one)', () => {
    expect(formatRunTitle(6)).toBe('Running 6 methods')
    expect(formatRunTitle(1)).toBe('Running 1 method')
    renderHeader({ title: formatRunTitle(2) })
    expect(screen.getByTestId('txr-run-title').textContent).toBe('Running 2 methods')
  })

  it('titles with the run\'s status word (RP-1): a finished run never reads "Running"', () => {
    expect(formatRunTitle(6, 'finished')).toBe('Finished 6 methods')
    expect(formatRunTitle(1, 'finished')).toBe('Finished 1 method')
    expect(formatRunTitle(6, 'failed')).toBe('Failed 6 methods')
    expect(formatRunTitle(6, 'stopped')).toBe('Stopped 6 methods')
    expect(formatRunTitle(6, 'finishing')).toBe('Finishing 6 methods')
    expect(formatRunTitle(6, 'running')).toBe('Running 6 methods')
    expect(formatRunTitle(6, 'preparing')).toBe('Running 6 methods')
    renderHeader({ title: formatRunTitle(6, 'finished') })
    expect(screen.getByTestId('txr-run-title').textContent).toBe('Finished 6 methods')
  })

  it('a terminal run\'s title counts what happened, not what was queued (qa-fixes2 R2-1)', () => {
    expect(formatRunTitle(6, 'finished', 4)).toBe('Finished 4 of 6 methods')
    expect(formatRunTitle(6, 'finished', 6)).toBe('Finished 6 of 6 methods')
    expect(formatRunTitle(1, 'finished', 1)).toBe('Finished 1 of 1 method')
    expect(formatRunTitle(209, 'finished', 6)).toBe('Finished 6 of 209 methods')
    expect(formatRunTitle(6, 'stopped', 3)).toBe('Stopped 3 of 6 methods')
    expect(formatRunTitle(6, 'failed', 0)).toBe('Failed 0 of 6 methods')
    // A live run has no terminal count — the board's plain count stays.
    expect(formatRunTitle(6, 'running', 4)).toBe('Running 6 methods')
    renderHeader({ title: formatRunTitle(6, 'finished', 4) })
    expect(screen.getByTestId('txr-run-title').textContent).toBe('Finished 4 of 6 methods')
  })

  it('renders the time line with both segments when both facts are known', () => {
    renderHeader()
    expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
      'about 2 minutes left · 1 min 40 s elapsed · measured estimate',
    )
  })

  it('spells the estimate\'s provenance honestly (qa-fixes2 R2-3) and omits the word when there is no quality fact', () => {
    cleanup()
    renderHeader({ estimateWord: 'rough estimate' })
    expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
      'about 2 minutes left · 1 min 40 s elapsed · rough estimate',
    )

    cleanup()
    renderHeader({ estimateWord: null })
    expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
      'about 2 minutes left · 1 min 40 s elapsed',
    )
  })

  it('omits each time segment when its fact is unknown (never a bare separator)', () => {
    cleanup()
    renderHeader({ timeLeft: null })
    expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
      '1 min 40 s elapsed · measured estimate',
    )

    cleanup()
    renderHeader({ timeLeft: null, elapsed: null, estimateWord: null })
    expect(screen.queryByTestId('txr-run-time-line')).toBeNull()

    cleanup()
    renderHeader({ elapsed: null })
    expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
      'about 2 minutes left · measured estimate',
    )
  })

  it('renders the concurrency line from the run\'s at-a-time and CPU facts', () => {
    renderHeader()
    expect(screen.getByTestId('txr-run-concurrency').textContent).toBe(
      '3 run at a time on 4 CPUs',
    )

    cleanup()
    renderHeader({ cpus: null })
    expect(screen.getByTestId('txr-run-concurrency').textContent).toBe(
      '3 run at a time',
    )

    cleanup()
    renderHeader({ atATime: null })
    expect(screen.queryByTestId('txr-run-concurrency')).toBeNull()
  })

  it('shows the See-the-results link exactly when the page says results are ready, pointing at the results builder', () => {
    const onSeeResults = vi.fn()
    renderHeader({ predictionsReady: true, onSeeResults })
    const link = screen.getByTestId('txr-run-see-results')
    expect(link.textContent).toBe('See the results')
    expect(link.getAttribute('href')).toBe(resultsPath('run-1'))
    fireEvent.click(link)
    expect(onSeeResults).toHaveBeenCalledTimes(1)

    cleanup()
    renderHeader({ predictionsReady: false })
    expect(screen.queryByTestId('txr-run-see-results')).toBeNull()
  })

  it('the See-results link reads in the board\'s link tone — a link, not a bold caption (RP-8)', () => {
    renderHeader({ predictionsReady: true })
    const link = screen.getByTestId('txr-run-see-results')
    expect(link.style.color).toBe('var(--txr-brand)')
    expect(link.style.fontWeight).toBe('400')
  })

  it('renders the research-use caption on the F header (DEC-11: one constant with E)', () => {
    renderHeader()
    expect(screen.getByTestId('txr-run-notice').textContent).toBe(RESEARCH_NOTICE)
  })
})
