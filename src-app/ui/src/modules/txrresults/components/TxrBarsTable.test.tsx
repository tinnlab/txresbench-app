// @vitest-environment jsdom
/**
 * TxrBarsTable — the H screen's patient × method bar table
 * (results-table-height): the per-patient table scrolls inside its OWN
 * bounded scroll box of `RESULTS_TABLE_MAX_HEIGHT` (the user's fixed-height
 * byte), the header cells pin to the box's top and the patient column pins
 * to its left edge, and a short table keeps its natural height. The
 * component is presentational, so the fixtures are hand-built columns and
 * rows (the sort/window derivation is the page's — see the page tests).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TxrHeatmapColumn, TxrHeatmapRow } from '../types'
import { RESULTS_TABLE_MAX_HEIGHT } from '../lib/format'
import { TxrBarsTable } from './TxrBarsTable'

function column(methodId: string): TxrHeatmapColumn {
  return {
    methodId,
    label: methodId,
    group: 'survival',
    groupLabel: 'Survival',
    task: 'pfs',
    probSource: 'recalibrated',
    flatConversion: false,
    coverage: null,
    values: [0.33, 0.52],
    notes: [null, null],
    constantValue: null,
  }
}

function row(patientId: string, value: number): TxrHeatmapRow {
  return {
    patientId,
    cells: [value],
    notes: [null],
    average: Math.round(value * 100),
    spread: null,
  }
}

const COLUMNS = [column('method-1')]
const ROWS = [row('S0001', 0.33), row('S0002', 0.52)]

function renderBars() {
  return render(
    <TxrBarsTable
      columns={COLUMNS}
      rows={ROWS}
      totalCount={ROWS.length}
      outcome="pfs"
      horizon={238}
      onShowAll={() => {}}
    />,
  )
}

describe('TxrBarsTable — the bars scroll box (results-table-height)', () => {
  it('wraps the table in its own bounded scroll box with the region byte', () => {
    renderBars()
    const box = screen.getByTestId('txr-bars-scroll')
    // results-table-height: the table scrolls inside its OWN box of
    // RESULTS_TABLE_MAX_HEIGHT; the page's ScrollRegion still scrolls the
    // page around the boxes. Max-height only, no fixed/minimum height.
    expect(box.style.maxHeight).toBe(RESULTS_TABLE_MAX_HEIGHT)
    expect(box.style.overflow).toBe('auto')
    expect(box.getAttribute('role')).toBe('region')
    expect(box.getAttribute('aria-label')).toBe('Chance per patient')
    expect(box.getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('region', { name: 'Chance per patient' })).toBe(box)
    expect(box.querySelector('table')).toBe(screen.getByTestId('txr-bars'))
  })

  it('pins the header top (the corner both axes) and the patient column left', () => {
    renderBars()
    const table = screen.getByTestId('txr-bars')
    const corner = within(table).getByRole('columnheader', { name: 'Patient' })
    const methodHeader = within(table).getByTestId('txr-bars-header-method-1')
    const patientCell = within(table).getAllByRole('rowheader')[0]
    expect(getComputedStyle(corner).position).toBe('sticky')
    expect(getComputedStyle(corner).top).toBe('0px')
    expect(getComputedStyle(corner).left).toBe('0px')
    expect(getComputedStyle(methodHeader).position).toBe('sticky')
    expect(getComputedStyle(methodHeader).top).toBe('0px')
    expect(getComputedStyle(patientCell).position).toBe('sticky')
    expect(getComputedStyle(patientCell).left).toBe('0px')
  })

  it('a short table (2 patients) has no height/minHeight on the box', () => {
    renderBars()
    const box = screen.getByTestId('txr-bars-scroll')
    expect(box.style.height).toBe('')
    expect(box.style.minHeight).toBe('')
  })
})

afterEach(cleanup)
