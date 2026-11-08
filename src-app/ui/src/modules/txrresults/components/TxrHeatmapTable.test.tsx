// @vitest-environment jsdom
//
// TEST-UR-5 (ITEM-7) — `TxrHeatmapTable` (PROV-UR-5, DEC-11/12; INV-2;
// EXAMPLE-UR-2): the board's visibility contract at scale. The cell color
// formula is the BOARD's own (alpha = 0.04 + pct/100 * 0.86, light text at
// pct ≥ 52) — the constants and helpers under test are the single source,
// and every pinned expectation below is assembled from them (no duplicated
// magic numbers in the test). The windowing pins read the SHIPPED constants
// too: the window is a bounded constant, never a row-count function.
//
// The component is presentational: every fixture is a hand-built
// `TxrHeatmapView` (the view model is ITEM-4's; its wire bridge is
// TEST-UR-2's), patient ids `S00xx`, method ids `method-N` (INV-5 — the
// boards' example ids, counts and probabilities are never spelled here).
// The only substance probed is the RENDERED DOM (computed styles from the
// inline-board bits, mounted-row sets, the hovered tooltip), never the
// internal state.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TxrHeatmapColumn, TxrHeatmapRow, TxrHeatmapView } from '../types'
import {
  CHANCE_ALPHA_MIN,
  CHANCE_ALPHA_SPAN,
  CHANCE_RGB,
  CHANCE_TEXT_DARK,
  CHANCE_TEXT_FROM,
  CHANCE_TEXT_LIGHT,
  HEATMAP_OVERSCAN_ROWS,
  HEATMAP_ROW_HEIGHT,
  HEATMAP_VIEWPORT_ROWS,
  HEATMAP_WINDOW_ROWS,
  TxrHeatmapTable,
  chanceAlphaOf,
  chancePercentOf,
  chanceStyleOf,
  heatmapWindowOf,
} from './TxrHeatmapTable'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
})

afterEach(cleanup)

// ── Synthetic fixtures (INV-5) ────────────────────────────────────────────────

function patientIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `S${String(i).padStart(4, '0')}`)
}

function methodCol(index: number, groupLabel: string): TxrHeatmapColumn {
  const id = `method-${index + 1}`
  return {
    methodId: id,
    label: id,
    group: `group-${index + 1}`,
    groupLabel,
    task: 'pfs',
    probSource: 'recalibrated',
    coverage: null,
    values: [],
    notes: [],
    constantValue: null,
  }
}

type GivenRow = Pick<TxrHeatmapRow, 'patientId' | 'cells' | 'average'> & {
  /** The row's aligned abstain notes (TxrHeatmapRow.notes — the component's read). */
  notes?: (string | null)[]
}

function viewFixture(
  columns: TxrHeatmapColumn[],
  rows: readonly GivenRow[],
  shownCount: number = rows.length,
  totalCount: number = rows.length,
): TxrHeatmapView {
  return {
    columns,
    rows: rows.map(
      (r): TxrHeatmapRow => ({
        patientId: r.patientId,
        cells: r.cells,
        notes: r.notes ?? r.cells.map(() => null),
        average: r.average,
        spread: null,
      }),
    ),
    shownCount,
    totalCount,
    averageBy: 'recomputed',
  }
}

/** The small fixture with hand-picked values + abstain notes (the color/tooltip pins). */
function smallView(): { view: TxrHeatmapView; columns: TxrHeatmapColumn[] } {
  const columns: TxrHeatmapColumn[] = [
    methodCol(0, 'Dynamic risk'),
    methodCol(1, 'Static risk'),
    methodCol(2, 'Dynamic risk'),
    methodCol(3, 'Response call'),
  ]
  // The column notes are the response-order source (the wire's); the row's
  // aligned note array (below) is what the table reads.
  columns[0].notes = [null, null, 'the marker was not measured', null, null, null]
  columns[1].notes = ['below the detection limit', null, null, null, null, null]
  columns[2].notes = [null, 'incomplete draws', null, null, null, null]
  columns[3].notes = [null, null, null, 'outside the outcome window', null, null]
  const rows: GivenRow[] = [
    { patientId: 'S0000', cells: [0.33, null, 0.05, 0.95], notes: [null, 'below the detection limit', null, null], average: 44 },
    { patientId: 'S0001', cells: [0.52, 0.2, null, 0.11], notes: [null, null, 'incomplete draws', null], average: 27 },
    { patientId: 'S0002', cells: [null, 0.41, 0.77, 0.6], notes: ['the marker was not measured', null, null, null], average: 59 },
    { patientId: 'S0003', cells: [0.84, null, 0.33, null], notes: [null, null, null, 'outside the outcome window'], average: null },
    { patientId: 'S0004', cells: [0.05, 0.52, 0.51, 0.52], average: 40 },
    { patientId: 'S0005', cells: [1, 0, 0.52, 0.51], average: 50 },
  ]
  return { view: viewFixture(columns, rows), columns }
}

/** The large fixture (the board's visibility contract at scale). */
function largeView(patientCount: number, methodCount: number): { view: TxrHeatmapView; columns: TxrHeatmapColumn[] } {
  const columns = Array.from({ length: methodCount }, (_, i) =>
    methodCol(i, i % 2 === 0 ? 'Dynamic risk' : 'Static risk'),
  )
  const rows: GivenRow[] = patientIds(patientCount).map((patientId, p) => ({
    patientId,
    cells: columns.map((_, m) => ((p * 7 + m * 13) % 97) / 100),
    average: 48,
  }))
  return { view: viewFixture(columns, rows), columns }
}

const BOX = () => screen.getByTestId('txr-heatmap')
const rowId = (id: string) => screen.queryByTestId(`txr-heatmap-row-${id}`)

/** The view's row elements currently mounted (data rows only, not the spacers). */
function mountedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="txr-heatmap-row-"]'))
}

/** The aria-hidden spacer rows (the window's padding). */
function spacerRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('tbody tr[aria-hidden]'))
}

/** Scroll the box to a position (jsdom: set scrollTop, then dispatch the event). */
function scrollBoxTo(scrollTop: number, scrollLeft = 0): void {
  const box = BOX()
  box.scrollTop = scrollTop
  box.scrollLeft = scrollLeft
  fireEvent.scroll(box)
}

async function hoverTooltip(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el, { bubbles: true })
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 700))
  })
}

const tooltipShown = (): string =>
  Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .map(t => (t.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join('|')

// ── The pinned chance-cell formula (the board's, DEC-11) ─────────────────────

describe('chance cell formula (TEST-UR-5 — the board alpha + text flip)', () => {
  it('computes the display percent as a whole 0–100 value, clamped', () => {
    expect(chancePercentOf(0.33)).toBe(33)
    expect(chancePercentOf(0.5149)).toBe(51)
    expect(chancePercentOf(0.523)).toBe(52)
    expect(chancePercentOf(0)).toBe(0)
    expect(chancePercentOf(1)).toBe(100)
    expect(chancePercentOf(-0.2)).toBe(0)
    expect(chancePercentOf(1.4)).toBe(100)
    expect(chancePercentOf(Number.NaN)).toBe(0)
  })

  it('renders the board alpha: 0.04 + (pct / 100) * 0.86, two decimals', () => {
    expect(chanceAlphaOf(0)).toBe('0.04')
    expect(chanceAlphaOf(33)).toBe('0.32')
    expect(chanceAlphaOf(52)).toBe('0.49')
    expect(chanceAlphaOf(77)).toBe('0.70')
    expect(chanceAlphaOf(100)).toBe('0.90')
    expect(Number(chanceAlphaOf(100))).toBeCloseTo(CHANCE_ALPHA_MIN + CHANCE_ALPHA_SPAN, 10)
  })

  it('flips the cell text to white at pct ≥ 52, near-black below (the board threshold)', () => {
    expect(chanceStyleOf(0.51).color).toBe(CHANCE_TEXT_DARK)
    expect(chanceStyleOf(0.52).color).toBe(CHANCE_TEXT_LIGHT)
    expect(chanceStyleOf(0.99).color).toBe(CHANCE_TEXT_LIGHT)
    expect(chanceStyleOf(0).color).toBe(CHANCE_TEXT_DARK)
  })

  it('composes the exact rgba background from the pinned rgb triplet', () => {
    expect(chanceStyleOf(0.33).background).toBe(`rgba(${CHANCE_RGB.join(', ')}, 0.32)`)
    expect(chanceStyleOf(0.52).background).toBe(`rgba(${CHANCE_RGB.join(', ')}, 0.49)`)
    expect(chanceStyleOf(1).background).toBe(`rgba(${CHANCE_RGB.join(', ')}, 0.90)`)
    // A NaN cell degrades to the 0% tint, never a NaN alpha in the CSS.
    expect(chanceStyleOf(Number.NaN).background).toBe(`rgba(${CHANCE_RGB.join(', ')}, 0.04)`)
  })
})

// ── The pinned windowing math (PROV-UR-5: fixed 36 px rows, bounded window) ──

describe('heatmapWindowOf (TEST-UR-5 — the bounded row window)', () => {
  const total = 500

  it('is the viewport + both overscans — a constant, never the row count', () => {
    expect(HEATMAP_WINDOW_ROWS).toBe(HEATMAP_VIEWPORT_ROWS + HEATMAP_OVERSCAN_ROWS * 2)
    expect(HEATMAP_WINDOW_ROWS).toBeLessThan(60)
  })

  it('starts at the top: rows [0, window)', () => {
    expect(heatmapWindowOf(0, total)).toEqual({ start: 0, end: HEATMAP_WINDOW_ROWS })
  })

  it('wraps the first visible row with the overscan on each side', () => {
    const firstVisible = Math.floor(3600 / HEATMAP_ROW_HEIGHT)
    expect(firstVisible).toBe(100)
    const windowed = heatmapWindowOf(3600, total)
    expect(windowed.start).toBe(firstVisible - HEATMAP_OVERSCAN_ROWS)
    expect(windowed.end).toBe(windowed.start + HEATMAP_WINDOW_ROWS)
  })

  it('slides the window so the bottom still mounts a full window', () => {
    const windowed = heatmapWindowOf(total * HEATMAP_ROW_HEIGHT, total)
    expect(windowed).toEqual({ start: total - HEATMAP_WINDOW_ROWS, end: total })
    // A scroll far past the bottom clamps to the same last window.
    expect(heatmapWindowOf(total * HEATMAP_ROW_HEIGHT * 9, total)).toEqual(windowed)
  })

  it('handles the small and empty cases without an empty-view crash', () => {
    expect(heatmapWindowOf(0, 10)).toEqual({ start: 0, end: 10 })
    expect(heatmapWindowOf(0, 0)).toEqual({ start: 0, end: 0 })
    expect(heatmapWindowOf(200, 0)).toEqual({ start: 0, end: 0 })
  })

  it('reads a negative/NaN scroll as the top', () => {
    expect(heatmapWindowOf(-1, total)).toEqual(heatmapWindowOf(0, total))
    expect(heatmapWindowOf(Number.NaN, total)).toEqual(heatmapWindowOf(0, total))
  })
})

// ── The board's visibility contract, at scale (EXAMPLE-UR-2 geometry) ────────

describe('TxrHeatmapTable (TEST-UR-5 — pinned column + sticky header)', () => {
  it('renders the board scroll box: overflow auto, the 470 px cap, the hairline border', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const box = BOX()
    expect(box.style.overflow).toBe('auto')
    // RES-07: the box budget is the viewport-adaptive cap (never less than
    // the board's 470 px floor) — the hard 470 px wasted the desktop screen.
    expect(box.style.maxHeight).toBe('max(470px, calc(100dvh - 300px))')
    expect(box.getAttribute('style')).toContain('border-radius: 10px')
    expect(box.querySelector('table')).not.toBeNull()
  })

  it('pins the patient column left and the header top, under vertical AND horizontal scroll', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const corner = screen.getByRole('columnheader', { name: 'Patient' })
    // averageBy 'recomputed' names the scope (RES-04: the Average is over
    // the methods shown — never a silent disagreement with the run's API line).
    const average = screen.getByRole('columnheader', { name: 'Average (methods shown)' })
    const firstMethod = screen.getByTestId('txr-heatmap-header-method-1')
    const firstPatientRow = screen.getByTestId('txr-heatmap-row-S0000')
    const patientCell = within(firstPatientRow).getByRole('rowheader')

    const assertPinned = () => {
      const cornerStyle = getComputedStyle(corner)
      const averageStyle = getComputedStyle(average)
      const methodStyle = getComputedStyle(firstMethod)
      const patientStyle = getComputedStyle(patientCell)
      // The corner: top AND left, above the header and the column.
      expect(cornerStyle.position).toBe('sticky')
      expect(cornerStyle.top).toBe('0px')
      expect(cornerStyle.left).toBe('0px')
      expect(cornerStyle.zIndex).toBe('3')
      // The header cells: pinned top (the Board's z-2 layer).
      expect(averageStyle.position).toBe('sticky')
      expect(averageStyle.top).toBe('0px')
      expect(methodStyle.position).toBe('sticky')
      expect(methodStyle.top).toBe('0px')
      // The patient column: pinned left (white, above the chance cells).
      expect(patientStyle.position).toBe('sticky')
      expect(patientStyle.left).toBe('0px')
      expect(patientStyle.zIndex).toBe('1')
      expect(patientStyle.backgroundColor).toBe('rgb(255, 255, 255)')
    }

    assertPinned()
    scrollBoxTo(60 * HEATMAP_ROW_HEIGHT, 400)
    // Scrolling never rewrites the pinning — the geometry is the styles'.
    assertPinned()
    scrollBoxTo(0, 0)
    assertPinned()
  })

  it('colors each chance cell with the live alpha and its label percent', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const row = screen.getByTestId('txr-heatmap-row-S0000')
    const cell = within(row).getByTestId('txr-heatmap-cell-method-1')
    expect(cell.textContent).toBe('33%')
    const style = getComputedStyle(cell)
    expect(style.backgroundColor).toBe(`rgba(${CHANCE_RGB.join(', ')}, 0.32)`)
    expect(style.color).toBe('rgb(20, 20, 20)')
    // Text flip at the 52% boundary, in the DOM.
    const flip = screen.getByTestId('txr-heatmap-row-S0001')
    const flipCell = within(flip).getByTestId('txr-heatmap-cell-method-1')
    expect(flipCell.textContent).toBe('52%')
    expect(getComputedStyle(flipCell).color).toBe('rgb(255, 255, 255)')
    // The 100% / 0% ends of the legend window. (jsdom serializes the 0.90
    // alpha as "0.9" — the browser-equivalent value — so the expected string
    // is compared through the same numeric collapse.)
    const ends = screen.getByTestId('txr-heatmap-row-S0005')
    expect(getComputedStyle(within(ends).getByTestId('txr-heatmap-cell-method-1')).backgroundColor).toBe(
      `rgba(${CHANCE_RGB.join(', ')}, ${Number(chanceAlphaOf(100))})`,
    )
    expect(getComputedStyle(within(ends).getByTestId('txr-heatmap-cell-method-2')).backgroundColor).toBe(
      `rgba(${CHANCE_RGB.join(', ')}, ${Number(chanceAlphaOf(0))})`,
    )
  })

  it('renders the average column bold, right-aligned, tabular; a null average renders empty', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const row = screen.getByTestId('txr-heatmap-row-S0000')
    const averageCell = within(row).getAllByRole('cell')[0]
    expect(averageCell.textContent).toBe('44%')
    const style = getComputedStyle(averageCell)
    expect(style.fontWeight).toBe('700')
    expect(style.textAlign).toBe('right')
    expect(style.fontVariantNumeric).toBe('tabular-nums')
    const NULL_ROW = screen.getByTestId('txr-heatmap-row-S0003')
    expect(within(NULL_ROW).getAllByRole('cell')[0].textContent).toBe('')
  })

  // RES-08 (qa-fixes ITEM-4) changed the noted abstain from a bare cell to
  // the board's visible dash; the noteless abstain stays bare.
  it('renders a dash for an abstain cell with its note in a tooltip; a noteless abstain stays bare', async () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const cell = within(screen.getByTestId('txr-heatmap-row-S0002')).getByTestId(
      'txr-heatmap-cell-method-1',
    )
    expect(cell.textContent).toBe('\u2013')
    await hoverTooltip(cell)
    expect(tooltipShown()).toBe('the marker was not measured')
    // Exactly the four noted abstains are carried by a kit Tooltip (the
    // wrapper marker on the trigger is the note, the kit's convention).
    const wrapped = Array.from(document.querySelectorAll('[data-tooltip-wrapped]'))
      .map(el => el.getAttribute('data-testid'))
      .sort()
    expect(wrapped).toEqual([
      'txr-heatmap-cell-method-1',
      'txr-heatmap-cell-method-2',
      'txr-heatmap-cell-method-3',
      'txr-heatmap-cell-method-4',
    ])
    // A noteless abstain (S0003 × method-2) is a plain empty cell — no wrapper.
    const bare = within(screen.getByTestId('txr-heatmap-row-S0003')).getByTestId(
      'txr-heatmap-cell-method-2',
    )
    expect(bare.textContent).toBe('')
    expect(bare.getAttribute('data-tooltip-wrapped')).toBeNull()
  })

  it('renders the mono method id + group sublabel headers with the id as the title', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const header = screen.getByTestId('txr-heatmap-header-method-1')
    expect(header.getAttribute('title')).toBe('method-1')
    expect(header.textContent).toContain('method-1')
    expect(header.textContent).toContain('Dynamic risk')
    expect(getComputedStyle(header).fontFamily).toContain('Source Code Pro')
    const second = screen.getByTestId('txr-heatmap-header-method-2')
    expect(second.textContent).toContain('Static risk')
  })

  it('renders the mono patient id column and the fixed 36 px row pitch', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const row = screen.getByTestId('txr-heatmap-row-S0000')
    expect(within(row).getByRole('rowheader').textContent).toBe('S0000')
    expect(row.style.height).toBe(`${HEATMAP_ROW_HEIGHT}px`)
    expect(getComputedStyle(within(row).getByRole('rowheader')).fontFamily).toContain(
      'Source Code Pro',
    )
  })
})

// ── The windowing contract (PROV-UR-5: bounded DOM at 500 rows) ──────────────

describe('TxrHeatmapTable windowing (TEST-UR-5 — bounded DOM, no 500-row render)', () => {
  it('mounts only the row window at 500 rows and pads the rest with spacer rows', () => {
    const { view } = largeView(500, 24)
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const rows = mountedRows()
    expect(rows.length).toBe(HEATMAP_WINDOW_ROWS)
    expect(rowId('S0000')).not.toBeNull()
    expect(rowId('S0024')).toBeNull()
    const spacers = spacerRows()
    expect(spacers.length).toBe(1)
    expect((spacers[0].childNodes[0] as HTMLElement).getAttribute('colspan')).toBe('26')
    expect(spacers[0].style.height).toBe(`${(500 - HEATMAP_WINDOW_ROWS) * HEATMAP_ROW_HEIGHT}px`)
  })

  it('scrolls to the middle window: the offset rows appear, the top rows un-mount', () => {
    const { view } = largeView(500, 24)
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    scrollBoxTo(3600)
    const firstVisible = Math.floor(3600 / HEATMAP_ROW_HEIGHT)
    expect(rowId(`S${String(firstVisible).padStart(4, '0')}`)).not.toBeNull()
    expect(mountedRows().length).toBe(HEATMAP_WINDOW_ROWS)
    expect(rowId('S0000')).toBeNull()
    expect(rowId(`S${String(firstVisible - HEATMAP_OVERSCAN_ROWS - 1).padStart(4, '0')}`)).toBeNull()
    const spacers = spacerRows()
    expect(spacers.length).toBe(2)
    expect(spacers[0].style.height).toBe(
      `${(firstVisible - HEATMAP_OVERSCAN_ROWS) * HEATMAP_ROW_HEIGHT}px`,
    )
  })

  it('scrolls to the bottom: the last window mounts and stays bounded', () => {
    const { view } = largeView(500, 24)
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    scrollBoxTo(500 * HEATMAP_ROW_HEIGHT)
    expect(rowId('S0499')).not.toBeNull()
    expect(rowId('S0000')).toBeNull()
    expect(mountedRows().length).toBe(HEATMAP_WINDOW_ROWS)
    const spacers = spacerRows()
    expect(spacers.length).toBe(1)
    expect(spacers[0].style.height).toBe(
      `${(500 - HEATMAP_WINDOW_ROWS) * HEATMAP_ROW_HEIGHT}px`,
    )
  })

  it('scrolls back up: the top window returns (the window follows both directions)', () => {
    const { view } = largeView(500, 24)
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    scrollBoxTo(3600)
    expect(rowId('S0000')).toBeNull()
    scrollBoxTo(0)
    expect(rowId('S0000')).not.toBeNull()
    expect(mountedRows().length).toBe(HEATMAP_WINDOW_ROWS)
  })

  it('keeps the window bounded with 100+ methods — the pinned geometry holds', () => {
    const { view } = largeView(500, 120)
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    expect(mountedRows().length).toBe(HEATMAP_WINDOW_ROWS)
    const lastHeader = screen.getByTestId('txr-heatmap-header-method-120')
    expect(lastHeader.textContent).toContain('method-120')
    const corner = screen.getByRole('columnheader', { name: 'Patient' })
    const patientCell = within(screen.getByTestId('txr-heatmap-row-S0000')).getByRole('rowheader')
    scrollBoxTo(1200 * HEATMAP_ROW_HEIGHT, 9000)
    expect(getComputedStyle(corner).position).toBe('sticky')
    expect(getComputedStyle(corner).left).toBe('0px')
    expect(getComputedStyle(patientCell).left).toBe('0px')
    expect(rowId('S0499')).not.toBeNull()
  })
})

// ── The "Showing N of M … Show all M" footer ─────────────────────────────────

describe('TxrHeatmapTable footer (TEST-UR-5 — showing counts + show-all)', () => {
  it('renders the board sentence and the Show all link while the window is capped', () => {
    const { view } = largeView(24, 4)
    const capped = viewFixture(view.columns, view.rows, 100, 500)
    render(<TxrHeatmapTable view={capped} onShowAll={() => {}} />)
    const footer = screen.getByText('Showing 100 of 500 patients.')
    expect(footer).not.toBeNull()
    const link = screen.getByTestId('txr-heatmap-show-more')
    expect(link.textContent).toBe('Show all 500')
    expect(link.tagName).toBe('BUTTON')
  })

  it('reports Show all through onShowAll — the host raises the limit', () => {
    const onShowAll = vi.fn()
    const { view } = largeView(24, 4)
    const capped = viewFixture(view.columns, view.rows, 100, 500)
    render(<TxrHeatmapTable view={capped} onShowAll={onShowAll} />)
    fireEvent.click(screen.getByTestId('txr-heatmap-show-more'))
    expect(onShowAll).toHaveBeenCalledTimes(1)
  })

  it('hides the Show all link once every row is shown (no dead action)', () => {
    const { view } = largeView(24, 4)
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    expect(screen.queryByTestId('txr-heatmap-show-more')).toBeNull()
    expect(screen.getByText('Showing 24 of 24 patients.')).not.toBeNull()
  })

  it('keeps the DOM bounded after Show all — the windowing still applies at 500 rows', () => {
    const { view } = largeView(500, 24)
    const allShown = viewFixture(view.columns, view.rows, 500, 500)
    render(<TxrHeatmapTable view={allShown} onShowAll={() => {}} />)
    expect(mountedRows().length).toBe(HEATMAP_WINDOW_ROWS)
    expect(rowId('S0499')).toBeNull()
    scrollBoxTo(500 * HEATMAP_ROW_HEIGHT)
    expect(rowId('S0499')).not.toBeNull()
    expect(mountedRows().length).toBe(HEATMAP_WINDOW_ROWS)
  })
})

// ── qa-fixes ITEM-4 — the measured footer, the no-match state, the abstain dash ──

describe('TxrHeatmapTable qa-fixes ITEM-4 (RES-03/06/07/08)', () => {
  it('names the average scope: "Average" only when the provider value is trusted (RES-04)', () => {
    const { view } = smallView()
    const trusted = viewFixture(view.columns, view.rows, view.shownCount, view.totalCount)
    render(<TxrHeatmapTable view={{ ...trusted, averageBy: 'provider' }} onShowAll={() => {}} />)
    expect(screen.getByRole('columnheader', { name: 'Average' })).not.toBeNull()
  })

  it('renders a no-match search as its own message, never a "Showing 0 of 0" table + scroll sentence (RES-06)', () => {
    const { view } = smallView()
    render(
      <TxrHeatmapTable
        view={{ ...view, rows: [], shownCount: 0, totalCount: 0 }}
        onShowAll={() => {}}
      />,
    )
    const box = BOX()
    expect(box.querySelector('table')).toBeNull()
    expect(screen.getByTestId('txr-heatmap-empty').textContent).toBe(
      'No patient matches your search.',
    )
    expect(screen.getByTestId('txr-heatmap-footer').textContent).toBe('')
    expect(screen.queryByTestId('txr-heatmap-show-more')).toBeNull()
  })

  it('renders a visible dash for an abstain cell that carries a note (RES-08)', () => {
    const { view } = smallView()
    render(<TxrHeatmapTable view={view} onShowAll={() => {}} />)
    const cell = within(screen.getByTestId('txr-heatmap-row-S0002')).getByTestId(
      'txr-heatmap-cell-method-1',
    )
    expect(cell.textContent).toBe('\u2013')
  })
})
