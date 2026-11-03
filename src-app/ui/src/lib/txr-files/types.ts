/**
 * TxResBench file decode — the shared `ParsedTable` wire shape and decode
 * options (PROV-FV-7).
 *
 * This library is the ONLY place bytes become table entries: the Rust server
 * never links a CSV/Excel parser (INV-1 note in `src-app/server/Cargo.toml` +
 * `scripts/check-no-format-crates.sh`), so the screens and the engine both
 * speak `ParsedTable` (DEC-1). The shapes below mirror the server's serde
 * types (`src-app/server/src/modules/file_validator/types.rs`) field for
 * field, so a decoded table posts to `/api/file-validation/inspect` and
 * `/api/file-validation/validate` without a transformation.
 */

/** The byte format the entries were decoded from (server `TableFormat`). */
export type TableFormat = 'csv' | 'excel'

/**
 * Which table the file is (server `FileTableKind`). Drives the header-row
 * scan's required aliases (DEC-6) and is echoed to the server's
 * `FileInspectionRequest.kind`. `'patients'` = screen C's patients table;
 * `'measurements'` = screen C's measurements OR screen N's measurements-only
 * file (INV-3 — one decoder, both screens).
 */
export type FileTableKind = 'patients' | 'measurements'

/** The source facts of a decoded table (server `ParsedTableSource`). */
export interface ParsedTableSource {
  /** The file name the user chose (display + kind-guessing only — never parse). */
  name: string
  format: TableFormat
}

/**
 * The browser-decoded table: raw entries only, no interpretation (DEC-1).
 * This is the wire type of every file the module sees.
 *
 * - `header_row` is the 1-based FILE row holding the column names (DEC-6), so
 *   every problem the server reports ("Row 14") matches the user's
 *   spreadsheet.
 * - `columns` are the header entries exactly as the file carried them
 *   (whitespace-stripped at the entry level would change the spelling the
 *   server's DEC-5 alias matching sees — the server folds case/`_`/`-`/space
 *   itself).
 * - `rows` are data rows only, entries as raw text; an empty entry is `null`.
 *   Ragged CSV rows are padded to the header width with `null` (a missing
 *   entry IS an empty entry); rows wider than the header are kept whole.
 */
export interface ParsedTable {
  source: ParsedTableSource
  header_row: number
  columns: string[]
  rows: (string | null)[][]
}

/**
 * Decode options. `kind` is passed by the caller that knows which table the
 * dropzone is receiving (screen C/N); when absent the header scan accepts the
 * union of both tables' required aliases (still deterministic, still DEC-6).
 */
export interface ParseOptions {
  kind?: FileTableKind
}

/**
 * How many rows the header scan looks through before giving up (DEC-6: title
 * rows are a common clinical-export reality — at most 5). The server's
 * `Limits::HEADER_SCAN_MAX_ROWS` is the same number; a decode that finds no
 * header row reports row 1 and lets the server's A01/A02 say so.
 */
export const HEADER_SCAN_MAX_ROWS = 5
