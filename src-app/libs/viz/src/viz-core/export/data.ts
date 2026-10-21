// data.ts — CSV/TSV DATA export (DEC-31 "Data" family). Pure string builders, no DOM,
// framework-agnostic (viz-core). Two shapes:
//   selectionToCSV — a single column of the selected dense point indices.
//   tableToCSV     — a `rowLabel` column + one column per numeric column of a DataTable
//                    (pass sep='\t' for TSV).

import type { IndexMask } from '../data/selection'
import type { DataTable } from '../data/wire'

/** Quote a cell iff it contains the separator, a quote, or a newline (RFC-4180-ish), AND neutralize a
 *  spreadsheet FORMULA trigger: a field starting with `= + - @` (or tab/CR) is executed by Excel/Sheets
 *  on open, so a dataset-derived label like `=HYPERLINK(...)` / `=cmd|...` becomes CSV-injection. Prefix
 *  a `'` so the cell is treated as literal text. */
function csvCell(value: string, sep: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (
    guarded.includes(sep) ||
    guarded.includes('"') ||
    guarded.includes('\n') ||
    guarded.includes('\r')
  ) {
    return `"${guarded.replace(/"/g, '""')}"`
  }
  return guarded
}

/**
 * Serialize a selection mask as a one-column CSV of the selected dense point
 * indices (header `index`, one index per row, ascending).
 */
export function selectionToCSV(mask: IndexMask): string {
  const indices = mask.toIndices()
  const lines: string[] = ['index']
  for (let i = 0; i < indices.length; i++) lines.push(String(indices[i]))
  return lines.join('\n')
}

/**
 * Serialize a DataTable as CSV (or TSV with `sep='\t'`): a leading `rowLabel`
 * column followed by every numeric column in insertion order, one row per label.
 */
export function tableToCSV(table: DataTable, sep = ','): string {
  const keys = Object.keys(table.columns)
  const rows: string[] = [['rowLabel', ...keys].join(sep)]
  const n = table.rowLabels.length
  for (let r = 0; r < n; r++) {
    const cells: string[] = [csvCell(table.rowLabels[r], sep)]
    for (const k of keys) {
      const col = table.columns[k]
      cells.push(String(col[r]))
    }
    rows.push(cells.join(sep))
  }
  return rows.join('\n')
}
