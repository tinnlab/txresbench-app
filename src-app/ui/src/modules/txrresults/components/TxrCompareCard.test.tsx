// @vitest-environment jsdom
/**
 * TxrCompareCard — qa-fixes ITEM-4 (RES-10): the card names the two methods
 * it compares ("the two methods" never told anyone WHICH two), the
 * divergent-only toggle is disabled when nothing differs (the toggle would
 * only ever show an empty table), and the sentences carry the report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrCompareCard } from './TxrCompareCard'
import type { TxrCompareReport } from '../types'

function reportOf(over: Partial<TxrCompareReport> = {}): TxrCompareReport {
  return {
    sharedTop: [{ patientId: 'S0001', value: 65 }],
    mostDiffering: [{ patientId: 'S0007', a: 10, b: 80, diffPercent: 70 }],
    divergentCount: 1,
    ...over,
  }
}

function renderCard(report: TxrCompareReport, divergentOnly = false) {
  const onToggle = vi.fn()
  render(
    <TxrCompareCard
      report={report}
      aLabel="landmark-cox-current"
      bLabel="cox-cutpoint-risk"
      divergentOnly={divergentOnly}
      onToggleDivergent={onToggle}
    />,
  )
  return { onToggle }
}

describe('TxrCompareCard (qa-fixes RES-10)', () => {
  it('names the two methods in the title (the board\'s "two methods" named nothing)', () => {
    renderCard(reportOf())
    expect(screen.getByTestId('txr-compare-card-title').textContent).toBe(
      'How landmark-cox-current and cox-cutpoint-risk compare',
    )
  })

  it('renders the board sentences from the report', () => {
    renderCard(reportOf())
    expect(screen.getByTestId('txr-compare-card').textContent).toContain(
      'Both methods put S0001 among their five highest chances.',
    )
    expect(screen.getByTestId('txr-compare-card').textContent).toContain(
      'They differ most for S0007 (10% and 80%).',
    )
  })

  it('disables the divergent toggle when nothing differs (no empty-table dead end)', () => {
    renderCard(reportOf({ sharedTop: [], mostDiffering: [], divergentCount: 0 }))
    const toggle = screen.getByTestId('txr-compare-divergent-toggle')
    expect(toggle.hasAttribute('disabled')).toBe(true)
  })

  it('reports the toggle through the callback with aria-pressed', () => {
    const { onToggle } = renderCard(reportOf(), true)
    const toggle = screen.getByTestId('txr-compare-divergent-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('renders the none-case sentences when the report has no names', () => {
    renderCard(reportOf({ sharedTop: [], mostDiffering: [], divergentCount: 0 }))
    expect(screen.getByTestId('txr-compare-card').textContent).toContain(
      'Both methods share no patients among their five highest chances.',
    )
    expect(screen.getByTestId('txr-compare-card').textContent).toContain(
      'They do not differ for any patient.',
    )
  })
})

afterEach(cleanup)
