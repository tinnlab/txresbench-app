/**
 * Excel (.xlsx) decoding (PROV-FV-7 `workbook.ts`): `read-excel-file` on the
 * File's ArrayBuffer, first sheet only, header-row detection, entries as text
 * or `null`. The same `ParsedTable` shape as CSV, so the screens and the
 * server see one table type (DEC-1, INV-3).
 */
import { InvalidInputError, readSheet, type SheetData } from 'read-excel-file/universal'
import { detectHeaderRow } from './csv'
import type { ParseOptions, ParsedTable, ParsedTableSource } from './types'

/** One Excel entry as the library reports it (string | number | boolean | Date | null). */
type SheetEntry = SheetData[number][number]

/**
 * Why a workbook was refused (DEC-13): `legacy_xls` is the binary pre-2007
 * format (OLE2 magic bytes — the library reports it by signature, never by
 * file name); `not_a_workbook` is anything else that is not a zip container.
 * The intake screens turn this into "save as .xlsx" guidance — the validator
 * never pretends a binary file is text.
 */
export type UnsupportedReason = 'legacy_xls' | 'not_a_workbook'

/**
 * The decode library's distinguishable "unsupported file type" result (DEC-13).
 * `code` is the stable reason the UI branches on; the original library error
 * (`read-excel-file`'s `InvalidInputError`) is preserved as `cause`.
 */
export class UnsupportedFileError extends Error {
  readonly code = 'unsupported_file_type' as const
  readonly reason: UnsupportedReason

  constructor(reason: UnsupportedReason, message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'UnsupportedFileError'
    this.reason = reason
  }
}

/** One Excel entry as the wire's raw text (PROV-FV-7: "entries as text or null"). */
function entryToText(entry: SheetEntry): string | null {
  if (entry === null) {
    return null
  }
  if (typeof entry === 'string') {
    return entry
  }
  if (typeof entry === 'number') {
    return String(entry)
  }
  if (typeof entry === 'boolean') {
    // What the user sees in the spreadsheet — the validator's binary checks
    // read 0/1, and Excel's TRUE/FALSE renders as it displays.
    return entry ? 'TRUE' : 'FALSE'
  }
  // A date entry: ISO text. The validator's numeric day/value checks then
  // report it honestly (a date is not a day number, nor a marker value).
  // (The library's entry type spells the Date variant as `typeof Date`; the
  // runtime value is a Date instance.)
  return (entry as unknown as Date).toISOString()
}

/** Map a rejected workbook onto the app's distinguishable result (DEC-13). */
function toUnsupportedFileError(err: unknown): UnsupportedFileError {
  const libraryCode =
    err instanceof InvalidInputError || (err as { name?: string } | null)?.name === 'InvalidInputError'
      ? (err as { code?: string }).code
      : undefined
  if (libraryCode === 'XLS_FILE_NOT_SUPPORTED') {
    return new UnsupportedFileError(
      'legacy_xls',
      'This is a legacy .xls workbook — save it as .xlsx and choose it again.',
      err,
    )
  }
  return new UnsupportedFileError(
    'not_a_workbook',
    'This file does not look like an .xlsx workbook — choose a .csv or .xlsx file.',
    err,
  )
}

/**
 * Decode a File as Excel (the promised PROV-FV-7 entry): `read-excel-file` on
 * `file.arrayBuffer()`, first sheet only, header-row detection, entries as
 * text with `null` for empty entries, data rows only.
 */
export async function parseWorkbookFile(file: File, opts: ParseOptions = {}): Promise<ParsedTable> {
  const buffer = await file.arrayBuffer()
  let rows: SheetEntry[][]
  try {
    rows = await readSheet<number>(buffer)
  } catch (err) {
    throw toUnsupportedFileError(err)
  }
  const textRows = rows.map((row) => row.map(entryToText))
  const headerIndex = detectHeaderRow(textRows, opts.kind)
  const header = (textRows[headerIndex] ?? []).map((entry) => entry ?? '')
  return {
    source: { name: file.name, format: 'excel' } satisfies ParsedTableSource,
    header_row: headerIndex + 1,
    columns: header,
    rows: textRows.slice(headerIndex + 1),
  }
}
