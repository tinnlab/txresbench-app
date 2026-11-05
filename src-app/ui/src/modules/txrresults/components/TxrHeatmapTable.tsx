/**
 * TxrHeatmapTable — the G screen's patient × method heatmap
 * (`BusyResults.dc.html`): one row per patient, one column per finished
 * method of the active outcome tab, each chance cell colored by the board's
 * live alpha formula, the patient column pinned on the LEFT and the header
 * pinned on TOP under scrolling on both axes, the fixed-height row window
 * (bounded DOM no matter how many patients a run has), and the
 * "Showing N of M patients … Show all M" footer.
 *
 * DEC-11 — module-local native table, deliberately NOT the kit `Table`:
 * the board's construction is a native table with `position: sticky` on
 * BOTH axes (top for the header, left for the patient column), and the kit
 * `Table`'s virtualized `display: grid` path has a sticky header but no
 * pinned-LEFT-column API (`sdk/packages/kit/src/kit/table.tsx`) — the grid
 * layout would also fight the per-cell colored backgrounds. The component
 * renders the board's own native-table bytes; H's `TxrBarsTable` is the
 * kit-`Table` twin (a handful of columns, no pinning). A future kit gain
 * (pinned-column support) is the refactor trigger.
 *
 * Row windowing (PROV-UR-5, DEC-12): fixed `HEATMAP_ROW_HEIGHT` rows; the
 * box mounts only the viewport row window (constant, board box 470 px at
 * the 36 px row pitch, ± the overscan) and the rows outside the window are
 * replaced by invisible spacer rows — the native-table shape of the window:
 * a transformed overlay (translateY) inside a table breaks the sticky
 * cells, the spacer keeps the table's own row flow AND the two-axis
 * pinning intact. The window never grows with the row count ("Show all M"
 * still renders a bounded DOM).
 *
 * Color formula (the board's own, computed live): a cell's background is
 * `rgba(29, 78, 137, <alpha>)` with `alpha = 0.04 + (pct / 100) * 0.86`
 * (pct = the 0–100 display value, clamped), and its text is `#ffffff`
 * at pct ≥ 52, else `#141414` (`CHANCE_*` constants below are the single
 * source of the formula's numbers; the legend's gradient
 * (`TxrMethodFilterBar`) is the same 0.04 → 0.9 range). The checkerized
 * white cell borders are the board's (they separate the alpha cells).
 *
 * An abstain cell renders EMPTY with the engine's note in a kit `Tooltip`
 * (the board's blank cells; the note is the cell's only content — a null
 * note renders a plain empty cell).
 *
 * The component is presentational: the page passes the ready
 * `TxrHeatmapView` (ITEM-4's `viewOf` projection — columns, rows,
 * shown/total counts) and reports "Show all M" through `onShowAll` (the
 * host raises the store's patient limit; `viewOf` re-windows the rows and
 * this component re-renders them — it never filters or sorts itself).
 *
 * Copy facts (board-verbatim): the footer sentence "Showing N of M
 * patients. Scroll sideways for more methods, down for more patients; the
 * first columns stay in view." and the "Show all M" link; the board's
 * example numbers are never data (INV-5) — every count here is the view's.
 */
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { Button, Tooltip } from '@ziee/kit'
import type { TxrHeatmapRow, TxrHeatmapView } from '../types'
import { formatPct } from '../lib/format'

// ─────────────────────────────────────────────────────────────────────────────
// The windowing constants (PROV-UR-5: fixed row height + bounded window)
// ─────────────────────────────────────────────────────────────────────────────

/** The fixed row pitch — the window scroll math's single unit (PROV-UR-5). */
export const HEATMAP_ROW_HEIGHT = 36

/** The board's scroll box height (`max-height: 470px`, `BusyResults.dc.html`). */
export const HEATMAP_MAX_HEIGHT = 470

/**
 * The rows the board's box shows at once: the 470 px box minus the sticky
 * header band, at the 36 px row pitch. A named constant (not a measurement
 * round-trip): the box's height is the board's fixed cap, so the window it
 * feeds is deterministic and testable.
 */
export const HEATMAP_VIEWPORT_ROWS = 12

/** Extra rows mounted on either side of the viewport so a fast scroll never shows a gap. */
export const HEATMAP_OVERSCAN_ROWS = 6

/** The bounded mount window: viewport + both overscans (24 rows at any row count). */
export const HEATMAP_WINDOW_ROWS = HEATMAP_VIEWPORT_ROWS + HEATMAP_OVERSCAN_ROWS * 2

/**
 * The row window for a scroll position: rows `[start, end)` mount, the
 * rest are spacer rows. A negative/NaN scroll reads as the top; a scroll
 * past the bottom clamps to the last window (never a blank table); zero
 * rows → an empty window.
 */
export function heatmapWindowOf(scrollTop: number, totalRows: number): { start: number; end: number } {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return heatmapWindowOf(0, totalRows)
  if (totalRows <= 0) return { start: 0, end: 0 }
  const firstVisible = Math.floor(scrollTop / HEATMAP_ROW_HEIGHT)
  const start = Math.min(
    Math.max(firstVisible - HEATMAP_OVERSCAN_ROWS, 0),
    Math.max(0, totalRows - HEATMAP_WINDOW_ROWS),
  )
  const end = Math.min(totalRows, start + HEATMAP_WINDOW_ROWS)
  return { start, end }
}

// ─────────────────────────────────────────────────────────────────────────────
// The chance-cell color formula (the board's, computed live — DEC-11)
// ─────────────────────────────────────────────────────────────────────────────

/** The board's alpha cell base color. */
export const CHANCE_RGB = [29, 78, 137] as const

/** The alpha at 0 % (the legend's gradient start). */
export const CHANCE_ALPHA_MIN = 0.04

/** The alpha span across the 0–100 % window (the legend's 0.9 end = 0.04 + 0.86). */
export const CHANCE_ALPHA_SPAN = 0.86

/** The percentage at which the cell text flips to `CHANCE_TEXT_LIGHT`. */
export const CHANCE_TEXT_FROM = 52

/** The dark cell text (the board's near-black under a pale cell). */
export const CHANCE_TEXT_DARK = '#141414'

/** The light cell text (the board's white under a saturated cell). */
export const CHANCE_TEXT_LIGHT = '#ffffff'

/**
 * The cell's chance as a whole 0–100 percent (the value the label prints AND
 * the color formula and the text-threshold read): a provider fraction in
 * (0, 1) rounded to the display scale and clamped to the board's 0–100
 * legend — the color never leaks outside the legend's window. A non-finite
 * value degrades to 0 (rendered as a transparent-tinted empty value; the
 * renderer never colors a NaN).
 */
export function chancePercentOf(value01: number): number {
  if (!Number.isFinite(value01)) return 0
  return Math.min(100, Math.max(0, Math.round(value01 * 100)))
}

/** The cell's background alpha for an already-clamped 0–100 percent (the board's `toFixed(2)`). */
export function chanceAlphaOf(valuePct: number): string {
  return (CHANCE_ALPHA_MIN + (valuePct / 100) * CHANCE_ALPHA_SPAN).toFixed(2)
}

/** The cell's `background` + `color` for a provider fraction (0–1); the caller spreads it onto the cell. */
export function chanceStyleOf(value01: number): { background: string; color: string } {
  const pct = chancePercentOf(value01)
  const alpha = chanceAlphaOf(pct)
  return {
    background: `rgba(${CHANCE_RGB.join(', ')}, ${alpha})`,
    color: pct >= CHANCE_TEXT_FROM ? CHANCE_TEXT_LIGHT : CHANCE_TEXT_DARK,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The board's native-table bytes (DEC-11)
// ─────────────────────────────────────────────────────────────────────────────

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

const SCROLL_BOX: CSSProperties = {
  overflow: 'auto',
  border: '1px solid #cfcdc7',
  borderRadius: 10,
  maxHeight: HEATMAP_MAX_HEIGHT,
}

const TABLE: CSSProperties = {
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: 13.5,
  minWidth: '100%',
}

/** The pinned corner cell (Patient header): top AND left, above everything. */
const CORNER_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  left: 0,
  zIndex: 3,
  background: '#f7f6f3',
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid #cfcdc7',
  borderRight: '1px solid #cfcdc7',
}

/** The Average header: pinned top only, one layer under the corner. */
const AVERAGE_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: '#f7f6f3',
  textAlign: 'right',
  padding: '8px 10px',
  borderBottom: '1px solid #cfcdc7',
  borderRight: '1px solid #cfcdc7',
  fontWeight: 700,
}

const METHOD_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: '#f7f6f3',
  padding: '6px 8px',
  borderBottom: '1px solid #cfcdc7',
  textAlign: 'center',
  verticalAlign: 'bottom',
  minWidth: 78,
  fontFamily: MONO_FONT,
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.25,
  overflowWrap: 'anywhere',
}

const METHOD_HEADER_LABEL: CSSProperties = {
  display: 'block',
  fontFamily: "'Source Sans 3', 'Segoe UI', sans-serif",
  fontSize: 10.5,
  color: '#5e5e5e',
  fontWeight: 400,
}

/** The pinned patient column beneath the corner: left only, layer 1. */
const PATIENT_COLUMN_STYLE: CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: '#ffffff',
  textAlign: 'left',
  padding: '6px 12px',
  borderBottom: '1px solid #e7e5e0',
  borderRight: '1px solid #cfcdc7',
  fontFamily: MONO_FONT,
  fontSize: 12.5,
  fontWeight: 400,
}

const AVERAGE_COLUMN_STYLE: CSSProperties = {
  background: '#ffffff',
  textAlign: 'right',
  padding: '6px 10px',
  borderBottom: '1px solid #e7e5e0',
  borderRight: '1px solid #cfcdc7',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
}

/** The chance cells' shared layout (the checkerized white gridlines are the board's). */
const CHANCE_STYLE: CSSProperties = {
  textAlign: 'center',
  padding: '6px 4px',
  borderBottom: '1px solid #ffffff',
  borderRight: '1px solid #ffffff',
  fontVariantNumeric: 'tabular-nums',
}

const ROW: CSSProperties = { height: HEATMAP_ROW_HEIGHT }

const SPACER_STYLE: CSSProperties = { padding: 0, border: 0, background: 'transparent' }

const FOOTER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 13,
  color: '#5e5e5e',
  marginTop: 8,
}

/** The invisible spacer row outside the window (aria-hidden: not a data row). */
function SpacerRow({ height, colCount }: { height: number; colCount: number }) {
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={colCount} style={SPACER_STYLE} />
    </tr>
  )
}

function HeatmapRow({ row, columns }: { row: TxrHeatmapRow; columns: TxrHeatmapView['columns'] }) {
  return (
    <tr data-testid={`txr-heatmap-row-${row.patientId}`} style={ROW}>
      <th scope="row" style={PATIENT_COLUMN_STYLE}>
        {row.patientId}
      </th>
      <td style={AVERAGE_COLUMN_STYLE}>{row.average !== null ? formatPct(row.average) : ''}</td>
      {columns.map((col, i) => {
        const value = row.cells[i] ?? null
        // The note travels with the row's aligned cells (the view's rows are
        // SORTED — a column's response-order note array cannot be re-indexed
        // by patientId; see DRIFT-1 ITEM-7 / TxrHeatmapRow.notes).
        const note = row.notes[i] ?? null
        const testId = `txr-heatmap-cell-${col.methodId}`
        if (value === null) {
          return note !== null ? (
            <Tooltip key={col.methodId} content={note}>
              <td data-testid={testId} style={CHANCE_STYLE} />
            </Tooltip>
          ) : (
            <td key={col.methodId} data-testid={testId} style={CHANCE_STYLE} />
          )
        }
        return (
          <td
            key={col.methodId}
            data-testid={testId}
            style={{ ...CHANCE_STYLE, ...chanceStyleOf(value) }}
          >
            {formatPct(value * 100)}
          </td>
        )
      })}
    </tr>
  )
}

export interface TxrHeatmapTableProps {
  /** The ready projection (ITEM-4's `viewOf`): columns + rows + the showing counts. */
  view: TxrHeatmapView
  /** "Show all M" — the host raises the store's patient limit (`setPatientLimit(-1)`). */
  onShowAll: () => void
}

export function TxrHeatmapTable({ view, onShowAll }: TxrHeatmapTableProps) {
  const { columns, rows, shownCount, totalCount } = view
  const [scrollTop, setScrollTop] = useState(0)
  const windowed = heatmapWindowOf(scrollTop, rows.length)
  const visibleRows = rows.slice(windowed.start, windowed.end)
  const colCount = columns.length + 2
  const topSpacer = windowed.start * HEATMAP_ROW_HEIGHT
  const bottomSpacer = (rows.length - windowed.end) * HEATMAP_ROW_HEIGHT
  return (
    <div>
      <div
        data-testid="txr-heatmap"
        style={SCROLL_BOX}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table style={TABLE}>
          <thead>
            <tr>
              <th scope="col" style={CORNER_HEADER}>
                Patient
              </th>
              <th scope="col" style={AVERAGE_HEADER}>
                Average
              </th>
              {columns.map(col => (
                <th
                  key={col.methodId}
                  scope="col"
                  title={col.methodId}
                  style={METHOD_HEADER}
                  data-testid={`txr-heatmap-header-${col.methodId}`}
                >
                  <span>{col.label}</span>
                  <span style={METHOD_HEADER_LABEL}>{col.groupLabel}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topSpacer > 0 ? <SpacerRow key="top-spacer" height={topSpacer} colCount={colCount} /> : null}
            {visibleRows.map(row => (
              <HeatmapRow key={row.patientId} row={row} columns={columns} />
            ))}
            {bottomSpacer > 0 ? <SpacerRow key="bottom-spacer" height={bottomSpacer} colCount={colCount} /> : null}
          </tbody>
        </table>
      </div>
      <div style={FOOTER}>
        <span>
          Showing {shownCount} of {totalCount} patients. Scroll sideways for more methods, down
          for more patients; the first columns stay in view.
        </span>
        {shownCount < totalCount ? (
          <Button
            data-testid="txr-heatmap-show-more"
            variant="link"
            className="p-0"
            onClick={onShowAll}
          >
            {`Show all ${totalCount}`}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
