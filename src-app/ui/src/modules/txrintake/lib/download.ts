/**
 * txrintake download helper — the ITEM-8 home (`lib/download.ts`), created
 * at ITEM-6 because the C/N cards' "Download the template (CSV)" /
 * "Download the full example" links are the file surface's own content
 * (CONS-UI-INTAKE-6, DEC-11): fetch the 200 `text/csv` body through
 * `@/api-client` (never a server path, never a file:// URL) and save it
 * through `@/core/saveFile` (the browser download on the website, the native
 * Save dialog in the desktop app).
 *
 * The template bodies are the committed synthetic headers (PROV-FV-4):
 * `patients_template.csv` / `measurements_template.csv`; the example bodies
 * are the committed synthetic rows (INV-3). The filename convention is
 * `<kind>_template.csv` / `<kind>_example.csv`.
 */
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'
import { saveFile, saveLabel, type SaveFileResult } from '@/core/saveFile'

/**
 * Save one template/example CSV: the browser download on the website, the
 * native Save dialog in the desktop app (`@/core/saveFile` — the app window
 * has no download handler, so the old blob + link did nothing there).
 */
export function downloadText(filename: string, text: string): Promise<SaveFileResult> {
  return saveFile({ filename, data: text, filter: { name: 'CSV', extensions: ['csv'] } })
}

/** The template link's text (the app opens the Save dialog). */
export function templateLinkLabel(): string {
  return saveLabel('Save the template (CSV)…', 'Download the template (CSV)')
}

/** The full-example link's text, with the card's own wording for "(CSV)". */
export function exampleLinkLabel(withCsv: boolean): string {
  return withCsv
    ? saveLabel('Save the full example (CSV)…', 'Download the full example (CSV)')
    : saveLabel('Save the full example…', 'Download the full example')
}

/** A card's error line after a failed save or download of its template/example. */
export function templateSaveError(what: string): string {
  return saveLabel(`The ${what} could not be saved. Try again.`, `The ${what} could not be downloaded. Try again.`)
}

/**
 * One template/example CSV from the provider asset endpoint
 * (CONS-UI-INTAKE-6) — the same cast + byte guard StartPage's example-data
 * loader uses: the generated response type is `void` (the openapi schema
 * declares no JSON body; the shared transport returns the TEXT of a
 * `text/*` body), so the one-seam cast with a byte check keeps a bodiless
 * response loud instead of silently saving nothing.
 */
export async function fetchTemplateCsv(
  kind: FileTableKind,
  which: 'template' | 'example',
): Promise<string> {
  const call = which === 'template' ? ApiClient.FileValidation.template : ApiClient.FileValidation.example
  const body = (await call({ kind })) as unknown as string
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`the ${kind} ${which} came back empty`)
  }
  return body
}

/** The download filename convention (`patients_template.csv`, `measurements_example.csv`). */
export function templateFilename(kind: FileTableKind, which: 'template' | 'example'): string {
  return `${kind}_${which}.csv`
}
