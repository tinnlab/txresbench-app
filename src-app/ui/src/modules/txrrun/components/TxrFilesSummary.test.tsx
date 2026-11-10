// @vitest-environment jsdom
/**
 * ITEM-2 (a) — the E screen's compact files summary
 * (`components/TxrFilesSummary.tsx`): the one-line summary, the marker
 * names, the Details disclosure holding the full per-file list (the old
 * slot chips — the long draw-day strip is gone from the face), and
 * "Change files". The component is presentational: the page builds the
 * facts (`buildFilesSummary`) and this suite pins the rendering + the
 * disclosure state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrFilesSummary } from './TxrFilesSummary'
import type { TxrSlotSummarySlot } from '../lib/slotSummary'

const slots: TxrSlotSummarySlot[] = [
  { kind: 'patients', sourceName: 'patients.csv', summaryText: '18 patients · 7 events' },
  {
    kind: 'measurements',
    sourceName: 'measurements.csv',
    summaryText: '2 markers · draws at day 0, 14, 28',
  },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrFilesSummary (ITEM-2 a)', () => {
  it('renders the one-line summary, the marker names and Change files', () => {
    render(
      <TxrFilesSummary
        line="18 patients · 7 events · 2 markers · draws from day 0 to 28 (3 different days)"
        markerNames={['ldh', 'cea']}
        details={slots}
        onChangeFiles={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-summary-line').textContent).toBe(
      '18 patients · 7 events · 2 markers · draws from day 0 to 28 (3 different days)',
    )
    expect(screen.getByTestId('txr-run-summary-markers').textContent).toBe('Markers: ldh, cea')
    expect(screen.getByTestId('txr-run-change-files')).toBeTruthy()
  })

  it('the Details disclosure holds the full per-file list, toggled in place', async () => {
    render(
      <TxrFilesSummary
        line="18 patients · 7 events · 2 markers"
        markerNames={['ldh', 'cea']}
        details={slots}
        onChangeFiles={() => undefined}
      />,
    )
    expect(screen.queryByTestId('txr-run-summary-details-measurements')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-summary-details'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-summary-details-patients').textContent).toContain(
      '18 patients · 7 events',
    )
    expect(screen.getByTestId('txr-run-summary-details-measurements').textContent).toContain(
      'draws at day 0, 14, 28',
    )
  })

  it('the marker-names line is absent when the validation resolved none', () => {
    render(
      <TxrFilesSummary
        line="patients.csv · measurements.csv"
        markerNames={[]}
        details={slots}
        onChangeFiles={() => undefined}
      />,
    )
    expect(screen.queryByTestId('txr-run-summary-markers')).toBeNull()
  })
})
