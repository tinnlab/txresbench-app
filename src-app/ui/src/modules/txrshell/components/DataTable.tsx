import { useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useScrollRegionElement } from './ScrollRegionContext'

/**
 * txrshell — DataTable (app-shell ITEM-1).
 *
 * The app's ONE table: the header row is sticky at the top of the scroll
 * region that contains it, an optional sticky first column (the patient id
 * in the results screen), a consistent row height, focus and hover rows,
 * keyboard scrolling (the region answers PageDown/Space/Home/End), wide
 * tables scroll inside their own region (never the page), and a virtualised
 * body above `virtualizeAbove` rows (the audit's 200) with the SAME
 * keyboard behaviour — the rows rendered are those in the scroll window.
 *
 * DOM disciplines:
 *  · Under the threshold a real `<table>` (native semantics, copyable); the
 *    virtualised body is the ARIA table pattern (role table/row/cell +
 *    `aria-rowcount`/`aria-rowindex`) because a virtual body cannot be a
 *    `<tbody>` of real rows.
 *  · The cell BACKGROUNDS live in index.css on the `.txr-data-table` hooks
 *    (the sticky cells need an opaque surface so rows don't show through);
 *    the sticky POSITIONS are inline (they are geometry, not palette). The
 *    one exception is the sticky corner, which needs both — its background
 *    is the header token via the CSS rule, like every cell.
 *  · The scroll element is the region that contains the table (consumed
 *    from `ScrollRegionContext`), never a box the table invents (DEC-3);
 *    a table outside a region (a dialog, a story) falls back to its own
 *    root as the scrollport.
 */

export interface DataTableColumn<T> {
  /** Stable column key. */
  id: string
  /** The header content. */
  header: ReactNode
  /** The cell content (a row cell renderer — the same for table rows and
   *  virtualised body rows). */
  cell: (row: T, rowIndex: number) => ReactNode
  /** Fixed column width in px. When every column carries one, the table
   *  declares the sum as its minimum width and the region scrolls
   *  horizontally instead of the columns collapsing. */
  width?: number
  align?: 'left' | 'right' | 'center'
}

export interface DataTableProps<T> {
  rows: readonly T[]
  columns: readonly DataTableColumn<T>[]
  rowKey: (row: T, rowIndex: number) => string
  /** The table's accessible name. */
  label: string
  /** The first column is sticky in the horizontal scroll (the patient id). */
  stickyFirstColumn?: boolean
  /** The consistent row height (px). */
  rowHeight?: number
  /** Rows above this count render virtualised. */
  virtualizeAbove?: number
  /** The empty-state content (rendered in place of the body rows). */
  empty?: ReactNode
  className?: string
  testId?: string
}

export const DATA_TABLE_DEFAULT_ROW_HEIGHT = 40
export const DATA_TABLE_VIRTUALIZE_ABOVE = 200

/** The sticky-first-column cell geometry (the corner is the header's own). */
const firstColumnStyle = (): CSSProperties => ({
  position: 'sticky',
  left: 0,
  zIndex: 1,
})

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  stickyFirstColumn = false,
  rowHeight = DATA_TABLE_DEFAULT_ROW_HEIGHT,
  virtualizeAbove = DATA_TABLE_VIRTUALIZE_ABOVE,
  empty,
  className,
  testId,
}: DataTableProps<T>) {
  const virtualized = rows.length > virtualizeAbove
  const regionElement = useScrollRegionElement()
  const ownRef = useRef<HTMLDivElement | null>(null)
  const scrollElement = regionElement ?? ownRef
  const widthTotal = columns.reduce<number | null>(
    (sum, c) => (sum === null || c.width === undefined ? null : sum + c.width),
    0,
  )
  const tableMinWidth = widthTotal ?? undefined

  // Every column's cell geometry (the same bytes for both render paths).
  const colStyle = (index: number): CSSProperties => ({
    height: rowHeight,
    padding: '0 12px',
    whiteSpace: 'nowrap',
    textAlign: columns[index]?.align ?? 'left',
    ...(stickyFirstColumn && index === 0 ? firstColumnStyle() : {}),
  })
  // A non-corner header cell: sticky at the region's top.
  const headStyle = (index: number): CSSProperties => ({
    padding: '0 12px',
    whiteSpace: 'nowrap',
    textAlign: columns[index]?.align ?? 'left',
    position: 'sticky',
    top: 0,
    zIndex: 3,
  })
  // The sticky corner (first column + header row): both axes, top z-order.
  const headCornerStyle = (column: DataTableColumn<T>): CSSProperties => ({
    padding: '0 12px',
    whiteSpace: 'nowrap',
    textAlign: column.align ?? 'left',
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 6,
  })

  const emptyCell = (
    <div
      role="cell"
      data-testid="txr-data-table-empty"
      style={{ padding: 24, textAlign: 'center', color: 'var(--txr-muted)' }}
    >
      {empty ?? 'No rows to show'}
    </div>
  )

  const rowCount = Math.max(rows.length, 1) + 1

  if (!virtualized) {
    return (
      <div
        ref={ownRef}
        data-testid={testId ?? 'txr-data-table'}
        data-virtualized="false"
        className={`txr-data-table ${className ?? ''}`}
        style={
          regionElement
            ? { width: '100%', minHeight: 0 }
            : { overflow: 'auto', height: '100%', minHeight: 0 }
        }
      >
        <table
          aria-label={label}
          role="table"
          aria-rowcount={rowCount}
          aria-colcount={columns.length}
          style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: tableMinWidth }}
        >
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={col.id}
                  scope="col"
                  role="columnheader"
                  className="txr-data-table-head-cell"
                  style={i === 0 && stickyFirstColumn ? headCornerStyle(col) : headStyle(i)}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr role="row" style={{ height: 'auto' }}>
                {emptyCell}
              </tr>
            ) : (
              rows.map((row, r) => (
                <tr
                  key={rowKey(row, r)}
                  role="row"
                  tabIndex={0}
                  data-row-index={r}
                  data-row-key={rowKey(row, r)}
                  className="txr-data-table-row"
                >
                  {columns.map((col, i) => (
                    <td
                      key={col.id}
                      role="cell"
                      className={
                        i === 0 && stickyFirstColumn
                          ? 'txr-data-table-cell txr-data-table-first-cell'
                          : 'txr-data-table-cell'
                      }
                      style={colStyle(i)}
                    >
                      {col.cell(row, r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )
  }

  return <VirtualizedBody
    rows={rows}
    columns={columns}
    rowKey={rowKey}
    label={label}
    rowHeight={rowHeight}
    stickyFirstColumn={stickyFirstColumn}
    empty={empty}
    scrollElement={scrollElement}
    standalone={regionElement === null}
    tableMinWidth={tableMinWidth}
    className={className}
    testId={testId}
  />
}

function VirtualizedBody<T>({
  rows,
  columns,
  rowKey,
  label,
  rowHeight = DATA_TABLE_DEFAULT_ROW_HEIGHT,
  stickyFirstColumn,
  empty,
  scrollElement,
  standalone,
  tableMinWidth,
  className,
  testId,
}: DataTableProps<T> & {
  scrollElement: React.RefObject<HTMLDivElement | null>
  standalone: boolean
  tableMinWidth?: number
}) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  })
  const total = virtualizer.getTotalSize()
  const colStyle = (index: number): CSSProperties => ({
    height: rowHeight,
    padding: '0 12px',
    whiteSpace: 'nowrap',
    textAlign: columns[index]?.align ?? 'left',
    ...(stickyFirstColumn && index === 0
      ? { position: 'sticky', left: 0, zIndex: 1 }
      : {}),
  })
  const headCellStyle = (index: number): CSSProperties => ({
    padding: '0 12px',
    whiteSpace: 'nowrap',
    textAlign: columns[index]?.align ?? 'left',
    position: 'sticky',
    top: 0,
    ...(stickyFirstColumn && index === 0 ? { left: 0, zIndex: 6 } : { zIndex: 3 }),
  })

  const items = virtualizer.getVirtualItems()

  // Inside a region the region is the scrollport (the table is plain content:
  // no box of its own to scroll — DEC-3); standalone the root is the
  // scrollport and fills its parent's height.
  const rootStyle: CSSProperties = standalone
    ? { overflow: 'auto', height: '100%', minHeight: 0 }
    : { width: '100%', minHeight: 0 }

  const emptyCell = (
    <div
      role="cell"
      data-testid="txr-data-table-empty"
      style={{ padding: 24, textAlign: 'center', color: 'var(--txr-muted)' }}
    >
      {empty ?? 'No rows to show'}
    </div>
  )

  return (
    <div
      // The region published its own element as the scrollport — the table
      // must NOT attach its ref to that object (the region's ref callback
      // would fight it); the virtualizer reads `scrollElement` directly.
      ref={standalone ? scrollElement : undefined}
      role="table"
      aria-label={label}
      aria-rowcount={Math.max(rows.length, 1) + 1}
      aria-colcount={columns.length}
      data-testid={testId ?? 'txr-data-table'}
      data-virtualized="true"
      className={`txr-data-table ${className ?? ''}`}
      style={rootStyle}
    >
      <div style={{ minWidth: tableMinWidth ?? '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div
          role="row"
          className="txr-data-table-head-row"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 4,
            display: 'flex',
            alignItems: 'stretch',
            minWidth: tableMinWidth,
            flex: 'none',
          }}
        >
          {columns.map((col, i) => (
            <div
              key={col.id}
              role="columnheader"
              className="txr-data-table-head-cell"
              style={{
                ...headCellStyle(i),
                flex: '1 1 auto',
                ...(col.width !== undefined ? { flex: `0 0 ${col.width}px`, width: col.width } : {}),
              }}
            >
              {col.header}
            </div>
          ))}
        </div>
        {rows.length === 0 ? (
          <div
            role="row"
            style={{ display: 'flex', minWidth: tableMinWidth }}
          >
            {emptyCell}
          </div>
        ) : (
          <div
            role="rowgroup"
            className="txr-data-table-body"
            style={{ position: 'relative', height: total, minWidth: tableMinWidth, flex: 'none' }}
          >
            {items.map(vi => {
              const row = rows[vi.index]
              return (
                <div
                  key={rowKey(row, vi.index)}
                  role="row"
                  tabIndex={0}
                  data-row-index={vi.index}
                  data-row-key={rowKey(row, vi.index)}
                  aria-rowindex={vi.index + 2}
                  className="txr-data-table-row txr-data-table-virtual-row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                    display: 'flex',
                    alignItems: 'stretch',
                  }}
                >
                  {columns.map((col, i) => (
                    <div
                      key={col.id}
                      role="cell"
                      className={
                        i === 0 && stickyFirstColumn
                          ? 'txr-data-table-cell txr-data-table-first-cell'
                          : 'txr-data-table-cell'
                      }
                      style={{
                        ...colStyle(i),
                        flex: '1 1 auto',
                        ...(col.width !== undefined ? { flex: `0 0 ${col.width}px`, width: col.width } : {}),
                      }}
                    >
                      {col.cell(row, vi.index)}
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
