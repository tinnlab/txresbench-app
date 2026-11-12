// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DataTable, DATA_TABLE_DEFAULT_ROW_HEIGHT } from './DataTable'
import { ScrollRegion } from './ScrollRegion'

/**
 * TEST-AS-1 (table half) — the DataTable's structure: sticky header and
 * optional sticky first column (geometry, inline), consistent row height,
 * focusable rows, the virtualised path above the threshold with the same
 * row keyboard surface. jsdom does no layout, so the STICKINESS and the
 * actual scroll are the browser tier's proof; here the bytes the browser
 * asserts are pinned (position/left/top/zIndex, the same in both paths).
 */
afterEach(() => cleanup())

interface Row {
  id: string
  value: string
}

const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `P${i + 1}`,
  value: `v${i + 1}`,
}))

const COLUMNS = [
  { id: 'patient', header: 'Patient', width: 120, cell: (r: Row) => r.id },
  { id: 'value', header: 'Value', width: 90, align: 'right' as const, cell: (r: Row) => r.value },
]

function table() {
  return render(
    <MemoryRouter initialEntries={['/analysis/1/results']}>
      <ScrollRegion label="Patients">
        <DataTable rows={ROWS} columns={COLUMNS} rowKey={r => r.id} label="Patients" stickyFirstColumn />
      </ScrollRegion>
    </MemoryRouter>,
  )
}

describe('DataTable under the threshold (TEST-AS-1)', () => {
  it('renders a real table with the labelled columns and consistent row height', () => {
    table()
    const tbl = screen.getByRole('table')
    expect(tbl.getAttribute('aria-label')).toBe('Patients')
    expect(tbl.getAttribute('aria-rowcount')).toBe(String(ROWS.length + 1))
    expect(tbl.getAttribute('aria-colcount')).toBe('2')
    const headCells = screen.getAllByRole('columnheader')
    expect(headCells.map(c => c.textContent)).toEqual(['Patient', 'Value'])
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(ROWS.length + 1)
    for (const cell of screen.getAllByRole('cell')) {
      expect((cell as HTMLElement).style.height).toBe(`${DATA_TABLE_DEFAULT_ROW_HEIGHT}px`)
    }
  })

  it('makes the header cells sticky at the region top and the first column sticky left', () => {
    table()
    const headCells = screen.getAllByRole('columnheader')
    for (const cell of headCells) {
      expect((cell as HTMLElement).style.position).toBe('sticky')
      expect((cell as HTMLElement).style.top).toBe('0px')
    }
    // The corner cell holds both axes at the top z-order.
    expect(headCells[0].style.left).toBe('0px')
    expect(headCells[0].style.zIndex).toBe('6')
    // Body cells: the first column sticky against the left edge.
    const firstCells = screen
      .getAllByRole('cell')
      .filter(c => c.classList.contains('txr-data-table-first-cell'))
    expect(firstCells.length).toBe(ROWS.length)
    for (const cell of firstCells) {
      expect((cell as HTMLElement).style.position).toBe('sticky')
      expect((cell as HTMLElement).style.left).toBe('0px')
    }
  })

  it('rows are focusable (the row-focus byte) with the data-row keys', () => {
    table()
    const rows = screen.getAllByRole('row').slice(1)
    for (const row of rows) {
      expect((row as HTMLElement).tabIndex).toBe(0)
    }
    expect(rows[0].getAttribute('data-row-index')).toBe('0')
    expect(rows[0].getAttribute('data-row-key')).toBe('P1')
  })
})

describe('DataTable above the threshold (TEST-AS-1)', () => {
  const BIG = Array.from({ length: 260 }, (_, i) => ({ id: `P${i + 1}`, value: `v${i + 1}` }))

  it('virtualises: the ARIA table carries the full row count while the DOM holds only the window', () => {
    render(
      <MemoryRouter initialEntries={['/analysis/1/results']}>
        <ScrollRegion label="Patients">
          <DataTable rows={BIG} columns={COLUMNS} rowKey={r => r.id} label="Patients" stickyFirstColumn />
        </ScrollRegion>
      </MemoryRouter>,
    )
    const table = screen.getByTestId('txr-data-table')
    expect(table.getAttribute('data-virtualized')).toBe('true')
    expect(table.getAttribute('aria-rowcount')).toBe(String(BIG.length + 1))
    // jsdom measures no layout, so no window rows are drawn — what the unit
    // tier pins is the CONTRACT: the header row is there, the body is the
    // full-height spacer (260 x 40 = 10,400 px) and the row count is the
    // full set. The real window rows (and their sticky header) are the
    // browser tier's proof.
    const rendered = screen.getAllByRole('row').length
    expect(rendered).toBeGreaterThanOrEqual(1)
    expect(rendered).toBeLessThan(260)
    const body = table.querySelector('[role="rowgroup"]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.style.height).toBe(`${BIG.length * DATA_TABLE_DEFAULT_ROW_HEIGHT}px`)
    expect(table.getAttribute('aria-colcount')).toBe('2')
  })
})
