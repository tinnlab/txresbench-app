// DataTableView.tsx — the SCREEN-READER-ACCESSIBLE surface for a stat chart (ITEM-60 /
// TEST-77). A GPU canvas is opaque to assistive tech, so a chart offers a "view as table":
// this renders a REAL semantic `<table>` (caption + `<th scope>` headers + `<tbody>`) from a
// `TableModel`, so a screen reader reads the chart's actual aggregated numbers. No canvas, no
// SVG, no kit/@txresbench imports (the viz-core framework-agnostic rule) — plain DOM + a `VizTheme`
// prop for light/dark chrome. Keyboard-focusable; an optional "Copy CSV" button exports it.

import { useCallback, useState } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { tableModelToCsv, type TableModel } from './chartTableModel'

/** Display formatter: integers verbatim, other finite numbers to ≤3 decimals (trailing zeros
 *  trimmed). Strings pass through. The MODEL keeps exact numbers; only the cell text rounds. */
function formatCell(v: string | number): string {
  if (typeof v === 'string') return v
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toFixed(3)))
}

export interface DataTableViewProps {
  /** The reshaped chart aggregate (from `chartTableModel` builders). */
  readonly model: TableModel
  /** Table caption — the accessible name a screen reader announces for the table. */
  readonly caption: string
  /** Theme-aware chrome colors (text/border/surface). Default LIGHT_THEME. */
  readonly theme?: VizTheme
  /** Show the "Copy CSV" button (default true). */
  readonly showCopyCsv?: boolean
  readonly 'data-testid'?: string
}

/**
 * A real semantic HTML table view of a chart's aggregated data. The first cell of every body
 * row is a `<th scope="row">` (its label), the header cells are `<th scope="col">`, and a
 * `<caption>` names the table — so assistive tech can navigate it by row/column.
 */
export function DataTableView({
  model,
  caption,
  theme = LIGHT_THEME,
  showCopyCsv = true,
  'data-testid': testId = 'viz-data-table',
}: DataTableViewProps) {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    const csv = tableModelToCsv(model)
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (clip?.writeText) {
      void clip.writeText(csv).then(
        () => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        },
        () => {
          /* clipboard denied — no-op (the table itself remains readable) */
        },
      )
    }
  }, [model])

  const cellPad = '4px 10px'
  const borderStyle = `1px solid ${theme.border}`

  return (
    <div
      data-testid={`${testId}-panel`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        color: theme.fg,
        background: theme.surface,
        overflow: 'auto',
        minHeight: 0,
      }}
    >
      {showCopyCsv && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            data-testid={`${testId}-copy-csv`}
            onClick={onCopy}
            style={{
              fontSize: 12,
              padding: '3px 10px',
              cursor: 'pointer',
              color: theme.fg,
              background: 'transparent',
              border: borderStyle,
              borderRadius: 4,
            }}
          >
            {copied ? 'Copied' : 'Copy CSV'}
          </button>
        </div>
      )}
      <table
        data-testid={testId}
        role="table"
        tabIndex={0}
        aria-label={caption}
        style={{
          borderCollapse: 'collapse',
          fontSize: 13,
          color: theme.fg,
          outline: 'none',
          width: 'auto',
        }}
      >
        <caption style={{ textAlign: 'left', padding: '0 0 6px', color: theme.muted, fontSize: 12 }}>
          {caption}
        </caption>
        <thead>
          <tr>
            {model.columns.map((col, i) => (
              <th
                key={col}
                scope="col"
                style={{
                  textAlign: i === 0 ? 'left' : 'right',
                  padding: cellPad,
                  borderBottom: `2px solid ${theme.border}`,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                c === 0 ? (
                  <th
                    key={c}
                    scope="row"
                    style={{
                      textAlign: 'left',
                      padding: cellPad,
                      borderBottom: borderStyle,
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatCell(cell)}
                  </th>
                ) : (
                  <td
                    key={c}
                    style={{
                      textAlign: 'right',
                      padding: cellPad,
                      borderBottom: borderStyle,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatCell(cell)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {model.rows.length === 0 && (
        <div style={{ padding: cellPad, color: theme.muted, fontSize: 12 }}>No data</div>
      )}
    </div>
  )
}
