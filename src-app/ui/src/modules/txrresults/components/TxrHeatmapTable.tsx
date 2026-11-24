/**
 * TxrHeatmapTable — the G screen's patient × method heatmap
 * (`BusyResults.dc.html`): one row per patient, one column per finished
 * method of the active outcome tab, each chance cell colored by the board's
 * live alpha formula, the patient column pinned on the LEFT and the header
 * pinned on TOP under scrolling on both axes, the fixed-height row window
 * (bounded DOM no matter how many patients a run has), and the
 * "Scroll sideways…" sentence under the box.
 *
 * app-shell ITEM-3 — reversed for these tables (results-table-height): the
 * page still owns ONE ScrollRegion (the region scrolls the page around the
 * boxes), but each per-patient table now scrolls inside its OWN bounded
 * box of `RESULTS_TABLE_MAX_HEIGHT` at the user's request — a long table
 * scrolls in its fixed-height box, a short one keeps its natural height.
 * The component therefore always measures and scrolls ITS OWN box (the
 * row windowing, the overscan and the overflow sentences read the box,
 * never the page region) — the standalone mode the DataTable has.
 * The sticky header and the pinned patient column stick to the box's
 * edges (the per-cell sticky byte, the opaque surfaces in the CSS hooks).
 *
 * DEC-11 — module-local native table, deliberately NOT the kit `Table`:
 * the board's construction is a native table with `position: sticky` on
 * BOTH axes (top for the header, left for the patient column), and the kit
 * `Table`'s virtualized `display: grid` path has a sticky header but no
 * pinned-LEFT-column API (`sdk/packages/kit/src/kit/table.tsx`) — the grid
 * layout would also fight the per-cell colored backgrounds. The component
 * renders the board's own native-table bytes; H's `TxrBarsTable` is the
 * table's twin (a handful of columns, the kit grid no longer — ITEM-3).
 * A future kit gain (pinned-column support) is the refactor trigger.
 *
 * Row windowing (PROV-UR-5, DEC-12): fixed `HEATMAP_ROW_HEIGHT` rows; the
 * box mounts only the viewport row window (`HEATMAP_VIEWPORT_ROWS` rows at
 * the 36 px row pitch when the box is short, more when the
 * `RESULTS_TABLE_MAX_HEIGHT` box is taller — the window is derived from the
 * box's measured `clientHeight`, ± the overscan) and the rows outside the
 * window are replaced by invisible spacer rows — the native-table shape of
 * the window: a transformed overlay (translateY) inside a table breaks the
 * sticky cells, the spacer keeps the table's own row flow AND the two-axis
 * pinning intact. The window never grows with the row count ("Show all M"
 * still renders a bounded DOM).
 *
 * Color formula (the board's own, computed live): a cell's background is
 * `rgba(var(--txr-chance-rgb), <alpha>)` with `alpha = 0.04 + (pct / 100) * 0.86`
 * (pct = the 0–100 display value, clamped), and its text is `var(--txr-on-chance)`
 * at pct ≥ 52, else `var(--txr-text)` (`CHANCE_*` constants below are the single
 * source of the formula's numbers; the legend's gradient
 * (`TxrMethodFilterBar`) is the same 0.04 → 0.9 range). The checkerized
 * chance-cell borders are the board's (they separate the alpha cells);
 * `--txr-chance-rgb` is light the board's brand blue, dark the kit's light
 * brand blue, and the gridline token softens the white byte for the dark
 * theme. `--txr-chance-rgb` is the ONE ramp source shared with the legend.
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
 * Copy facts (board-verbatim): the footer sentence "Scroll sideways for
 * more methods, down for more patients; the first columns stay in view"
 * (the "Showing N of M patients." sentence moved to the page's fixed
 * bottom bar next to its actions — ITEM-3, the audit route table) and the
 * "Show all M" link in the same bar; the board's example numbers are never
 * data (INV-5) — every count here is the view's.
 */
import type { CSSProperties } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button, Tooltip } from '@txresbench/kit'
import type { TxrHeatmapRow, TxrHeatmapView } from '../types'
import { formatPatientList, formatPct, RESULTS_TABLE_MAX_HEIGHT } from '../lib/format'

// ─────────────────────────────────────────────────────────────────────────────
// The windowing constants (PROV-UR-5: fixed row height + bounded window)
// ─────────────────────────────────────────────────────────────────────────────

/** The fixed row pitch — the window scroll math's single unit (PROV-UR-5). */
export const HEATMAP_ROW_HEIGHT = 36

/**
 * The viewport row FLOOR: the rows the board's old 470 px box showed at
 * once, minus the sticky header band, at the 36 px row pitch. The window's
 * real viewport count is derived from the box's measured `clientHeight`
 * (results-table-height's `max(320px, 60vh)` box can show more rows than the
 * old 470 px one), never below this floor — the row-window tests and any
 * caller that passes no viewport keep the old constant's meaning.
 */
export const HEATMAP_VIEWPORT_ROWS = 12

/** Extra rows mounted on either side of the viewport so a fast scroll never shows a gap. */
export const HEATMAP_OVERSCAN_ROWS = 6

/** The default bounded mount window: viewport floor + both overscans (24 rows at any row count). */
export const HEATMAP_WINDOW_ROWS = HEATMAP_VIEWPORT_ROWS + HEATMAP_OVERSCAN_ROWS * 2

/**
 * The row window for a scroll position: rows `[start, end)` mount, the
 * rest are spacer rows. A negative/NaN scroll reads as the top; a scroll
 * past the bottom clamps to the last window (never a blank table); zero
 * rows → an empty window. `viewportRows` is the rows the box really shows
 * (derived from its measured `clientHeight` in the component); it defaults
 * to `HEATMAP_VIEWPORT_ROWS` so the pure-window tests and the standalone
 * callers keep the old constant's meaning.
 */
export function heatmapWindowOf(
  scrollTop: number,
  totalRows: number,
  viewportRows: number = HEATMAP_VIEWPORT_ROWS,
): { start: number; end: number } {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return heatmapWindowOf(0, totalRows, viewportRows)
  if (totalRows <= 0) return { start: 0, end: 0 }
  const windowRows = viewportRows + HEATMAP_OVERSCAN_ROWS * 2
  const firstVisible = Math.floor(scrollTop / HEATMAP_ROW_HEIGHT)
  const start = Math.min(
    Math.max(firstVisible - HEATMAP_OVERSCAN_ROWS, 0),
    Math.max(0, totalRows - windowRows),
  )
  const end = Math.min(totalRows, start + windowRows)
  return { start, end }
}

// ─────────────────────────────────────────────────────────────────────────────
// The chance-cell color formula (the board's, computed live — DEC-11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chance ramp's R,G,B triplet as the CSS variable the rgba() color
 * uses (the board's brand blue in light; the kit's light brand blue in
 * dark — see `assets/txr-theme.css`). The same variable drives the legend
 * gradient in `TxrMethodFilterBar`, so the legend and the cells can never
 * drift apart.
 */
export const CHANCE_RGB = 'var(--txr-chance-rgb)' as const

/** The alpha at 0 % (the legend's gradient start). */
export const CHANCE_ALPHA_MIN = 0.04

/** The alpha span across the 0–100 % window (the legend's 0.9 end = 0.04 + 0.86). */
export const CHANCE_ALPHA_SPAN = 0.86

/** The percentage at which the cell text flips to `CHANCE_TEXT_LIGHT`. */
export const CHANCE_TEXT_FROM = 52

/** The dark cell text (the board's near-black under a pale cell). */
export const CHANCE_TEXT_DARK = 'var(--txr-text)'

/** The light cell text (the board's white under a saturated cell). */
export const CHANCE_TEXT_LIGHT = 'var(--txr-on-chance)'

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

/**
 * The cell's `background` + `color` for a provider fraction (0–1); the caller
 * spreads it onto the cell. The background strings the CSS variable (the
 * theme resolves it — light: the board's brand blue rgb(29,78,137); dark:
 * the kit's light brand blue rgb(112,153,215), legible on the dark card).
 */
export function chanceStyleOf(value01: number): { background: string; color: string } {
  const pct = chancePercentOf(value01)
  const alpha = chanceAlphaOf(pct)
  return {
    background: `rgba(${CHANCE_RGB}, ${alpha})`,
    color: pct >= CHANCE_TEXT_FROM ? CHANCE_TEXT_LIGHT : CHANCE_TEXT_DARK,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The board's native-table bytes (DEC-11)
// ─────────────────────────────────────────────────────────────────────────────

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

/**
 * The table's OWN scroll box (results-table-height — the user's fixed-height
 * byte): the border/radius card is the box again, bounded to
 * `RESULTS_TABLE_MAX_HEIGHT` and scrollable on both axes; the row windowing
 * and the overflow sentences measure THIS element, never the page region.
 */
const SCROLL_BOX: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  minWidth: 0,
  maxHeight: RESULTS_TABLE_MAX_HEIGHT,
  overflow: 'auto',
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
  background: 'var(--txr-surface-dim)',
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--txr-border)',
  borderRight: '1px solid var(--txr-border)',
}

/** The Average header: pinned top only, one layer under the corner. */
const AVERAGE_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: 'var(--txr-surface-dim)',
  textAlign: 'right',
  padding: '8px 10px',
  borderBottom: '1px solid var(--txr-border)',
  borderRight: '1px solid var(--txr-border)',
  fontWeight: 700,
}

const METHOD_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: 'var(--txr-surface-dim)',
  padding: '6px 8px',
  borderBottom: '1px solid var(--txr-border)',
  textAlign: 'center',
  verticalAlign: 'bottom',
  // ITEM-6 (results-r3 R3-results-11): the 78 px column split method ids
  // MID-WORD ("clearanc / e-three-") on the phone; 112 px + `break-word`
  // breaks at hyphens/words only (a long id reads "ctdna-clearance-" /
  // "three-group", never "clearanc" / "e-three-").
  minWidth: 112,
  fontFamily: MONO_FONT,
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.25,
  overflowWrap: 'break-word',
}

const METHOD_HEADER_LABEL: CSSProperties = {
  display: 'block',
  fontFamily: "'Source Sans 3', 'Segoe UI', sans-serif",
  fontSize: 10.5,
  color: 'var(--txr-muted)',
  fontWeight: 400,
}

/** The pinned patient column beneath the corner: left only, layer 1. */
const PATIENT_COLUMN_STYLE: CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: 'var(--txr-surface)',
  textAlign: 'left',
  padding: '6px 12px',
  borderBottom: '1px solid var(--txr-border-subtle)',
  borderRight: '1px solid var(--txr-border)',
  fontFamily: MONO_FONT,
  fontSize: 12.5,
  fontWeight: 400,
  whiteSpace: 'nowrap',
}

const AVERAGE_COLUMN_STYLE: CSSProperties = {
  background: 'var(--txr-surface)',
  textAlign: 'right',
  padding: '6px 10px',
  borderBottom: '1px solid var(--txr-border-subtle)',
  borderRight: '1px solid var(--txr-border)',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
}

/** The chance cells' shared layout (the checkerized white gridlines are the board's). */
const CHANCE_STYLE: CSSProperties = {
  textAlign: 'center',
  padding: '6px 4px',
  borderBottom: '1px solid var(--txr-chance-gridline)',
  borderRight: '1px solid var(--txr-chance-gridline)',
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
  color: 'var(--txr-muted)',
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

function HeatmapRow({
  row,
  columns,
  showAverage,
}: {
  row: TxrHeatmapRow
  columns: TxrHeatmapView['columns']
  showAverage: boolean
}) {
  return (
    <tr data-testid={`txr-heatmap-row-${row.patientId}`} style={ROW}>
      <th scope="row" style={PATIENT_COLUMN_STYLE}>
        {row.patientId}
      </th>
      {showAverage ? (
        <td style={AVERAGE_COLUMN_STYLE}>{row.average !== null ? formatPct(row.average) : ''}</td>
      ) : null}
      {columns.map((col, i) => {
        const value = row.cells[i] ?? null
        // The note travels with the row's aligned cells (the view's rows are
        // SORTED — a column's response-order note array cannot be re-indexed
        // by patientId; see DRIFT-1 ITEM-7 / TxrHeatmapRow.notes).
        const note = row.notes[i] ?? null
        const testId = `txr-heatmap-cell-${col.methodId}`
        if (value === null) {
          // RES-08: an abstain cell is never a silent blank — the note in the
          // tooltip AND a visible dash mark (the note is the cell's only
          // content; a null note renders a plain empty cell).
          return note !== null ? (
            <Tooltip key={col.methodId} content={note}>
              <td data-testid={testId} style={CHANCE_STYLE}>
                {'\u2013'}
              </td>
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
}

export function TxrHeatmapTable({ view }: TxrHeatmapTableProps) {
  const { columns, rows, totalCount, averageBy } = view
  const [scrollTop, setScrollTop] = useState(0)
  const [columnsOverflow, setColumnsOverflow] = useState(false)
  const [rowsOverflow, setRowsOverflow] = useState(false)
  const [boxClientHeight, setBoxClientHeight] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  // The scrollport the windowing and the overflow sentences measure: the
  // table's OWN box (results-table-height — the user's fixed-height byte).
  // The page's ScrollRegion stays the page scroller; this box is the
  // table's. The effect runs once on mount (the ref is set by then).
  useLayoutEffect(() => {
    const el = boxRef.current
    if (el === null) return
    const measure = () => {
      setColumnsOverflow(el.scrollWidth > el.clientWidth + 1)
      setRowsOverflow(el.scrollHeight > el.clientHeight + 1)
      // The viewport row count derives from the box's measured height (a
      // `max(320px, 60vh)` box shows more rows than the old 470 px one —
      // the window grows with the box, never leaving rows as blank spacers).
      setBoxClientHeight(el.clientHeight)
    }
    measure()
    const onScroll = () => {
      setScrollTop(el.scrollTop)
    }
    el.addEventListener('scroll', onScroll)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [])
  const viewportRows = Math.max(
    HEATMAP_VIEWPORT_ROWS,
    Math.ceil(boxClientHeight / HEATMAP_ROW_HEIGHT),
  )
  const windowed = heatmapWindowOf(scrollTop, rows.length, viewportRows)
  const visibleRows = rows.slice(windowed.start, windowed.end)
  // R2-11: the Average column is redundant when ONE method column is shown
  // (its per-patient value IS the average); it remains on the two-or-more
  // column tables the board's "Average" exists for.
  const showAverage = columns.length > 1
  const colCount = columns.length + (showAverage ? 2 : 1)
  const topSpacer = windowed.start * HEATMAP_ROW_HEIGHT
  const bottomSpacer = (rows.length - windowed.end) * HEATMAP_ROW_HEIGHT
  const averageHeader =
    averageBy === 'recomputed' ? 'Average (methods shown)' : 'Average'
  return (
    <div>
      <div
        ref={boxRef}
        data-testid="txr-heatmap"
        data-txr-table-scroll=""
        role="region"
        aria-label="Chances per patient"
        tabIndex={0}
        className="txr-results-table-box"
        style={SCROLL_BOX}
      >
        {totalCount === 0 ? (
          // RES-06: a search with no match is its own message, never a bare
          // empty table.
          <div
            data-testid="txr-heatmap-empty"
            style={{ padding: '18px 16px', fontSize: 13.5, color: 'var(--txr-text-2)' }}
          >
            No patient matches your search.
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                <th scope="col" style={CORNER_HEADER}>
                  Patient
                </th>
                {showAverage ? (
                  <th scope="col" style={AVERAGE_HEADER}>
                    {averageHeader}
                  </th>
                ) : null}
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
                    {/* single-marker-choice round 2: a no-list method the run's
                        marker rule gave markers reads the plan's fact under its
                        group label; nothing for the others. */}
                    {col.markersUsed !== undefined && col.markersUsed.length > 0 ? (
                      <span
                        style={METHOD_HEADER_LABEL}
                        data-testid={`txr-heatmap-uses-${col.methodId}`}
                      >
                        uses {formatPatientList(col.markersUsed)}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topSpacer > 0 ? <SpacerRow key="top-spacer" height={topSpacer} colCount={colCount} /> : null}
              {visibleRows.map(row => (
                <HeatmapRow key={row.patientId} row={row} columns={columns} showAverage={showAverage} />
              ))}
              {bottomSpacer > 0 ? <SpacerRow key="bottom-spacer" height={bottomSpacer} colCount={colCount} /> : null}
            </tbody>
          </table>
        )}
      </div>
      <div style={FOOTER}>
        {/* The "Showing N of M patients." sentence and the "Show all M"
            window control live in the page's fixed bottom bar (ITEM-3 — the
            audit route table's "/analysis/:id/results" row); this footer
            carries only the table's own scroll guidance — measured (RES-07):
            it renders only when the direction it names really overflows. */}
        <span data-testid="txr-heatmap-footer">
          {totalCount > 0
            ? columnsOverflow
              ? 'Scroll sideways for more methods, down for more patients; the first columns stay in view.'
              : rowsOverflow
                ? 'Scroll down for more patients.'
                : ''
            : ''}
        </span>
      </div>
    </div>
  )
}
