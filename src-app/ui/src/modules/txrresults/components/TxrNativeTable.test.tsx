// @vitest-environment jsdom
/**
 * TxrNativeTable — the own-results table header says what each method itself
 * returned (a yes/no answer and its score, or only its score), not the
 * method's group label, which describes the method family rather than the
 * values below it. The heatmap header keeps its group sublabel; only this
 * table's header spells out what the method returned. The component is
 * presentational, so the fixtures are hand-built columns with own results
 * (the wire bridge is the page tests' job).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TxrHeatmapColumn } from '../types'
import { RESULTS_TABLE_MAX_HEIGHT } from '../lib/format'
import { TxrNativeTable } from './TxrNativeTable'

const PATIENTS = ['S0001', 'S0002']
const rows = PATIENTS.map(patientId => ({ patientId }))

function column(
  methodId: string,
  over: Partial<TxrHeatmapColumn> & { native?: TxrHeatmapColumn['native'] },
): TxrHeatmapColumn {
  return {
    methodId,
    label: methodId,
    group: 'response-probability',
    groupLabel: 'Response probability',
    task: 'pfs',
    probSource: null,
    flatConversion: false,
    coverage: null,
    values: [0.5, 0.5],
    notes: [null, null],
    constantValue: null,
    ...over,
  }
}

function ownTable(): HTMLElement {
  return screen.getByTestId('txr-own-table')
}

function returnedLine(methodId: string): HTMLElement {
  return within(screen.getByTestId('txr-own-results')).getByTestId(`txr-own-returned-${methodId}`)
}

describe('TxrNativeTable — the header says what the method returned (B)', () => {
  it('a score-only method shows the score line, never its group label', () => {
    render(
      <TxrNativeTable
        columns={[column('score-only', { native: { scores: [0.4, 0.6], calls: null } })]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    expect(returnedLine('score-only').textContent).toBe('Score (higher = more likely failing)')
    const header = within(ownTable()).getByTestId('txr-own-header-score-only')
    expect(header.textContent).not.toContain('Response probability')
  })

  it('a method with yes/no answers shows the calls line', () => {
    render(
      <TxrNativeTable
        columns={[column('with-calls', { native: { scores: [0.4, 0.6], calls: [1, 0] } })]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    expect(returnedLine('with-calls').textContent).toBe('Yes/no answer and score')
  })

  it('a native-chance column keeps its chance-above-is-its-own mark', () => {
    render(
      <TxrNativeTable
        columns={[
          column('native-scored', {
            probSource: 'native',
            native: { scores: [0.4, 0.6], calls: [1, 0] },
          }),
        ]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    expect(
      within(screen.getByTestId('txr-own-results')).getByTestId('txr-own-chance-mark-native-scored')
        .textContent,
    ).toBe('chance above is its own')
  })

  it('no header of the table carries any column group label', () => {
    render(
      <TxrNativeTable
        columns={[
          column('score-only', {
            groupLabel: 'Response probability',
            native: { scores: [0.4, 0.6], calls: null },
          }),
          column('with-calls', {
            group: 'dynamic-risk',
            groupLabel: 'Dynamic risk',
            native: { scores: [0.4, 0.6], calls: [1, 0] },
          }),
        ]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    const headers = within(ownTable()).getAllByRole('columnheader')
    for (const header of headers) {
      expect(header.textContent ?? '').not.toContain('Response probability')
      expect(header.textContent ?? '').not.toContain('Dynamic risk')
    }
  })
})

describe('TxrNativeTable — the own-results scroll box (results-table-height)', () => {
  it('wraps the table in its own bounded scroll box with the region byte', () => {
    render(
      <TxrNativeTable
        columns={[column('score-only', { native: { scores: [0.4, 0.6], calls: null } })]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    const box = screen.getByTestId('txr-own-table-scroll')
    // results-table-height: the table scrolls inside its OWN box of
    // RESULTS_TABLE_MAX_HEIGHT; the page's ScrollRegion still scrolls the
    // page around the boxes. Max-height only, no fixed/minimum height.
    expect(box.style.maxHeight).toBe(RESULTS_TABLE_MAX_HEIGHT)
    expect(box.style.overflow).toBe('auto')
    expect(box.getAttribute('role')).toBe('region')
    expect(box.getAttribute('aria-label')).toBe("Methods' own results per patient")
    expect(box.getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('region', { name: "Methods' own results per patient" })).toBe(box)
    expect(box.querySelector('table')).toBe(ownTable())
  })

  it('pins the header top (the corner both axes) and the patient column left', () => {
    render(
      <TxrNativeTable
        columns={[
          column('score-only', { native: { scores: [0.4, 0.6], calls: null } }),
          column('with-calls', { native: { scores: [0.4, 0.6], calls: [1, 0] } }),
        ]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    const corner = within(ownTable()).getByRole('columnheader', { name: 'Patient' })
    const methodHeader = within(ownTable()).getByTestId('txr-own-header-score-only')
    const patientCell = within(ownTable()).getAllByRole('rowheader')[0]
    expect(getComputedStyle(corner).position).toBe('sticky')
    expect(getComputedStyle(corner).top).toBe('0px')
    expect(getComputedStyle(corner).left).toBe('0px')
    expect(getComputedStyle(methodHeader).position).toBe('sticky')
    expect(getComputedStyle(methodHeader).top).toBe('0px')
    expect(getComputedStyle(patientCell).position).toBe('sticky')
    expect(getComputedStyle(patientCell).left).toBe('0px')
  })

  it('a short table (2 patients) has no height/minHeight on the box', () => {
    render(
      <TxrNativeTable
        columns={[column('score-only', { native: { scores: [0.4, 0.6], calls: null } })]}
        rows={rows}
        patients={PATIENTS}
      />,
    )
    const box = screen.getByTestId('txr-own-table-scroll')
    expect(box.style.height).toBe('')
    expect(box.style.minHeight).toBe('')
  })
})

afterEach(cleanup)
