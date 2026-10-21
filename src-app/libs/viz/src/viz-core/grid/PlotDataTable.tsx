// PlotDataTable.tsx — the per-pane "plotting data" table: a WINDOWED (virtualized) table of the rows a
// pane actually plots, with a CSV export. DOCKED (portaled) alongside the edit form in the grid's right
// panel — NOT overlaid on the plot — so several tables can stay open at once (mirrors the edit-form dock).
// Pure presentational — the caller computes the (already visible-filtered) rows.
//
// Two interactions beyond display:
//   • SORT — click a column header to cycle none → asc → desc → none; numeric columns sort numerically,
//     others lexicographically. The CSV export honors the ACTIVE sort order (WYSIWYG with the table).
//   • ROW HOVER — hovering a row reports its ORIGINAL point index (`pointIndices[row]`, when provided)
//     via `onHoverRow`, so GridWorkspace can highlight the matching plotted point; leaving clears it.
//
// No virtualization dependency is available in the workspace, so this hand-rolls a minimal windowed
// list: a tall spacer sizes the scroll range and only the rows in view (+ a small overscan) are
// rendered, keeping a 100k-row table cheap.

import { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { Button } from '@ziee/kit'
import { X, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { toolFor } from '../tools/registry'

/** The CSV button's glyph, FROM THE REGISTRY (INV-14). `Download` is the registered `exportPane`
 *  gesture icon, and a registered glyph may not be imported directly — "export the visible rows" is
 *  that same verb, so it must wear that same mark by derivation rather than by coincidence. Caught
 *  when the icon audit's surface list became directory-derived (FIX_ROUND-1 / C4); until then this
 *  file was outside the audit entirely. */
const T_EXPORT_ROWS = toolFor('pane', 'export')

const ROW_H = 24 // px per row (fixed height ⇒ O(1) windowing)
const OVERSCAN = 8

type SortDir = 'asc' | 'desc'

export interface PlotDataTableProps {
  readonly title: string
  /**
   * HOSTED: portaled into a host-provided container (`dataTableContainer`) whose pane already draws
   * this table's title and its close. Those two stand down here so exactly one title is on screen
   * and in the a11y tree; the row COUNT and the CSV export are affordances, not chrome, and stay.
   * A prop rather than a CSS hide — see `PaneEditForm.hosted`.
   */
  readonly hosted?: boolean
  readonly columns: readonly string[]
  /** All (already visible-filtered) rows; each row aligns to `columns`. */
  readonly rows: readonly (readonly (string | number)[])[]
  /** Optional per-row ORIGINAL point index (aligned to `rows`) — the plot-space local index the row was
   *  built from. Enables the hover→highlight channel; absent ⇒ hover reports nothing. */
  readonly pointIndices?: readonly number[]
  /** Suggested CSV file name (without extension). */
  readonly fileName: string
  readonly onClose: () => void
  /** Report the hovered row's point index (or null on leave). No-op when `pointIndices` is absent. */
  readonly onHoverRow?: (pointIndex: number | null) => void
}

/** Escape one CSV field (RFC-4180: quote when it contains a comma/quote/newline; double inner quotes). */
function csvField(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Numeric-aware comparison: both parse as finite numbers ⇒ numeric; else case-insensitive string. */
function compareCells(a: string | number, b: string | number): number {
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function PlotDataTable({
  title,
  hosted = false,
  columns,
  rows,
  pointIndices,
  fileName,
  onClose,
  onHoverRow,
}: PlotDataTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(0)
  // Active sort: a column index + direction, or null (natural/plot order). Cycles none→asc→desc→none.
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null)

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
    setViewH(e.currentTarget.clientHeight)
  }, [])
  // Measure the viewport once mounted so the first paint windows correctly.
  const measure = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    if (el) setViewH(el.clientHeight)
  }, [])

  // Sorted ROW ORDER as an index permutation over `rows` (stable). Natural order when no sort is active,
  // so `pointIndices[order[i]]` stays the row's original point index regardless of sort.
  const order = useMemo(() => {
    const idx = rows.map((_, i) => i)
    if (!sort) return idx
    const sign = sort.dir === 'asc' ? 1 : -1
    return idx.sort((ra, rb) => {
      const c = compareCells(rows[ra]?.[sort.col] ?? '', rows[rb]?.[sort.col] ?? '')
      return c !== 0 ? c * sign : ra - rb // stable tiebreak on original position
    })
  }, [rows, sort])

  const cycleSort = useCallback((col: number) => {
    setScrollTop(0)
    scrollRef.current?.scrollTo({ top: 0 })
    setSort(cur => {
      if (!cur || cur.col !== col) return { col, dir: 'asc' }
      if (cur.dir === 'asc') return { col, dir: 'desc' }
      return null // desc → off
    })
  }, [])

  const total = order.length
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const visibleCount = Math.ceil((viewH || 320) / ROW_H) + OVERSCAN * 2
  const last = Math.min(total, first + visibleCount)

  // Clear any lingering highlight when the table UNMOUNTS. `onHoverRow` is typically a fresh inline
  // closure each render, so keep it in a ref and depend on `[]` — depending on its identity would fire
  // this cleanup on every re-render and instantly clear the highlight a row-hover just set.
  const onHoverRowRef = useRef(onHoverRow)
  onHoverRowRef.current = onHoverRow
  useEffect(() => () => onHoverRowRef.current?.(null), [])

  const exportCsv = useCallback(() => {
    const lines = [columns.map(csvField).join(',')]
    for (const r of order) lines.push(rows[r].map(csvField).join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName || 'plot-data'}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [columns, rows, order, fileName])

  const gridTemplate = `repeat(${columns.length}, minmax(64px, 1fr))`

  return (
    <div
      data-testid="viz-plot-data-table"
      className="pointer-events-auto flex flex-col border-b border-border bg-background text-xs"
      style={{ height: 360, flex: '0 0 auto', minHeight: 0 }}
      // Don't let interactions fall through to the deck / drag beneath.
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {/* Header: title + row count + CSV export + close. Hosted ⇒ the title and the close belong
          to the host's pane header; what stays is the row count + the CSV export. */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1">
        {hosted ? null : (
          <span className="truncate font-semibold" title={title}>
            {title}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">
          {total.toLocaleString()} visible {total === 1 ? 'row' : 'rows'}
        </span>
        <div className="flex-1" />
        <Button
          size="default"
          variant="ghost"
          tooltip="Export the visible rows as CSV (in the current sort order)"
          data-testid="viz-plot-data-export"
          onClick={exportCsv}
        >
          <T_EXPORT_ROWS.Icon className="size-3.5" />
          CSV
        </Button>
        {hosted ? null : (
          <Button
            size="icon"
            variant="ghost"
            tooltip="Close data table"
            data-testid="viz-plot-data-close"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Column header row — each header is a sort toggle (click to cycle asc/desc/off). */}
      <div
        className="grid border-b border-border bg-muted/20 font-medium"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {columns.map((c, ci) => {
          const active = sort?.col === ci
          return (
            <button
              key={c}
              type="button"
              data-testid={`viz-plot-data-sort-${ci}`}
              aria-label={`Sort by ${c}${active ? (sort?.dir === 'asc' ? ' (ascending)' : ' (descending)') : ''}`}
              className="flex items-center gap-0.5 truncate px-2 py-1 text-start hover:bg-muted/40"
              title={`Sort by ${c}`}
              onClick={() => cycleSort(ci)}
            >
              <span className="truncate">{c}</span>
              {/* Inactive columns show a muted up/down chevron so it's clear they're SORTABLE; the
                  active column shows the directional chevron for its current asc/desc order. */}
              {active ? (
                sort?.dir === 'asc' ? (
                  <ChevronUp className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                )
              ) : (
                <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/40" />
              )}
            </button>
          )
        })}
      </div>

      {/* Windowed body: a tall spacer sizes the scroll range; only the in-view slice renders. */}
      <div
        ref={measure}
        className="relative flex-1 overflow-auto"
        onScroll={onScroll}
        onMouseLeave={() => onHoverRow?.(null)}
      >
        {total === 0 ? (
          <div className="p-3 text-muted-foreground">No visible points in the current view.</div>
        ) : (
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            {order.slice(first, last).map((rowIdx, k) => {
              const displayRow = first + k
              const row = rows[rowIdx]
              const pointIndex = pointIndices?.[rowIdx]
              return (
                <div
                  key={rowIdx}
                  className="grid items-center border-b border-border/50 hover:bg-primary/10"
                  style={{
                    gridTemplateColumns: gridTemplate,
                    position: 'absolute',
                    top: displayRow * ROW_H,
                    height: ROW_H,
                    left: 0,
                    right: 0,
                  }}
                  onMouseEnter={pointIndex != null ? () => onHoverRow?.(pointIndex) : undefined}
                >
                  {row.map((cellValue, ci) => (
                    <div key={ci} className="truncate px-2 tabular-nums" title={String(cellValue)}>
                      {cellValue}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
