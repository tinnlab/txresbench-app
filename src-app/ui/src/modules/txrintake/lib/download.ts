/**
 * txrintake download helper — the ITEM-8 home (`lib/download.ts`), created
 * at ITEM-6 because the C/N cards' "Download the template (CSV)" /
 * "Download the full example" links are the file surface's own content
 * (CONS-UI-INTAKE-6, DEC-11): fetch the 200 `text/csv` body through
 * `@/api-client` (never a server path, never a file:// URL) and save it
 * with the blob + anchor pattern (`ProvenanceExport.store.ts` precedent),
 * revoking the object URL after the click.
 *
 * The template bodies are the committed synthetic headers (PROV-FV-4):
 * `patients_template.csv` / `measurements_template.csv`; the example bodies
 * are the committed synthetic rows (INV-3). The filename convention is
 * `<kind>_template.csv` / `<kind>_example.csv`.
 */
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'

/**
 * Save `text` as a file download (`blob` + temporary anchor, then revoke).
 * The ProvenanceExport precedent: the anchor is appended to the document
 * (Safari needs it in the tree), clicked, removed, and the object URL is
 * revoked on the same tick — the blob stays alive for the click that is
 * already queued.
 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
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
