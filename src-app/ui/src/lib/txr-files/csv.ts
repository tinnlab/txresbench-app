/**
 * CSV decoding (PROV-FV-7 `csv.ts`): BOM strip → delimiter sniff → header-row
 * detection → `ParsedTable`. d3-dsv does the actual field splitting
 * (RFC-4180 quoting, CRLF); everything else here is the app's own, so screen C
 * and screen N get ONE decoding story (INV-3).
 */
import { dsvFormat } from 'd3-dsv'
import {
  HEADER_SCAN_MAX_ROWS,
  type FileTableKind,
  type ParseOptions,
  type ParsedTable,
  type ParsedTableSource,
} from './types'

/** The delimiters the sniff considers, in tie-break preference order. */
const CANDIDATE_DELIMITERS = [',', '\t', ';'] as const

/**
 * DEC-5 alias sets (folded) — but ONLY the DEC-6 REQUIRED spellings: the
 * header scan recognizes a row by the primary `patient_id` / `day` / `marker`
 * names. The server's own resolution (`rules.rs` alias table) accepts the
 * wider tidy spellings (the tidy `marker`-column name among them) AFTER the
 * row is found — and every valid measurements table carries a `day` column,
 * so the wider spellings never need to drive the scan.
 */
const PATIENT_ID_ALIASES = ['patient id', 'patientid']
const DAY_ALIASES = ['day', 'day from start', 'dayfromstart', 'days from start']
const MARKER_ALIASES = ['marker']

/**
 * The header names the scan accepts for one table (folded form). A patient
 * table is recognized by its `patient_id` column; a measurements table by
 * `patient_id` OR `day` OR `marker` — a measurements file in a run where the
 * patients table is uploaded first may well have no `patient_id`.
 */
export function requiredHeaderAliases(kind: FileTableKind | undefined): readonly string[] {
  const sets = [PATIENT_ID_ALIASES]
  if (kind === undefined || kind === 'measurements') {
    sets.push(DAY_ALIASES, MARKER_ALIASES)
  }
  return sets.flat()
}

/**
 * Fold a header name for alias matching — the browser twin of the server's
 * `normalize_header_name` (`rules.rs`): lowercase, `_`/`-` become a space,
 * whitespace runs collapse, ends trim. One folding language on both sides so a
 * header the browser recognizes is a header the server resolves (INV-8).
 */
export function normalizeHeaderName(name: string): string {
  let out = ''
  let pendingSpace = false
  for (const ch of name) {
    if (ch === '_' || ch === '-' || /\s/.test(ch)) {
      if (out.length > 0) {
        pendingSpace = true
      }
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    out += ch.toLowerCase()
  }
  return out
}

/**
 * Count occurrences of each candidate delimiter outside quoted regions, on the
 * first few non-empty lines, and return the best. `undefined` means "no
 * candidate found" and the caller falls back to comma (d3-dsv's default), so
 * a single-column CSV still parses.
 */
function sniffDelimiter(lines: string[]): string | undefined {
  const counts = new Map<string, number>()
  let seen = 0
  for (const line of lines) {
    if (line.length === 0) {
      continue
    }
    let inQuotes = false
    let i = 0
    while (i < line.length) {
      const ch = line[i]
      if (ch === '"') {
        // `""` inside a quoted field is an escaped quote, not a toggle —
        // toggling twice is the no-op that the skip produces.
        if (inQuotes && line[i + 1] === '"') {
          i += 2
          continue
        }
        inQuotes = !inQuotes
      } else if (!inQuotes) {
        for (const d of CANDIDATE_DELIMITERS) {
          if (ch === d) {
            counts.set(d, (counts.get(d) ?? 0) + 1)
          }
        }
      }
      i += 1
    }
    seen += 1
    if (seen >= 10) {
      break
    }
  }
  let best: string | undefined
  let bestCount = 0
  for (const d of CANDIDATE_DELIMITERS) {
    const n = counts.get(d) ?? 0
    if (n > bestCount) {
      best = d
      bestCount = n
    }
  }
  return best
}

/**
 * The DEC-6 header scan: the FIRST row whose entries match ≥ 1 required alias
 * for the table, looking down at most `HEADER_SCAN_MAX_ROWS` rows. Returns the
 * 0-based index of the header row within the parsed rows; when nothing
 * matches, row 0 is the header (the server's A01/A02 then reports the truth —
 * a decode never guesses a header the folder's alias table does not know).
 */
export function detectHeaderRow(
  rows: readonly (readonly (string | null)[])[],
  kind: FileTableKind | undefined,
): number {
  const aliases = requiredHeaderAliases(kind)
  const limit = Math.min(rows.length, HEADER_SCAN_MAX_ROWS)
  for (let i = 0; i < limit; i += 1) {
    if (rows[i].some((entry) => entry !== null && aliases.includes(normalizeHeaderName(entry)))) {
      return i
    }
  }
  return 0
}

/** Split one File's text into a `ParsedTable` (the pure core of `parseCsvFile`). */
export function parseCsvText(text: string, opts: ParseOptions = {}, name = 'file.csv'): ParsedTable {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = sniffDelimiter(withoutBom.split('\n')) ?? ','
  const parsed = dsvFormat(delimiter).parseRows(withoutBom)
  const headerIndex = detectHeaderRow(parsed, opts.kind)
  const header = (parsed[headerIndex] ?? []).map((entry) => entry ?? '')
  const dataRows = parsed.slice(headerIndex + 1)
  return {
    source: { name, format: 'csv' } satisfies ParsedTableSource,
    header_row: headerIndex + 1,
    columns: header,
    rows: dataRows.map((row) => {
      const entries = row.map((entry) => (entry === '' ? null : entry))
      while (entries.length < header.length) {
        entries.push(null)
      }
      return entries
    }),
  }
}

/**
 * Decode a File as CSV (the promised PROV-FV-7 entry): BOM strip, delimiter
 * sniffing (comma / tab / semicolon), header-row detection, raw-text entries
 * with `null` for empty entries, data rows only.
 */
export async function parseCsvFile(file: File, opts: ParseOptions = {}): Promise<ParsedTable> {
  return parseCsvText(await file.text(), opts, file.name)
}
