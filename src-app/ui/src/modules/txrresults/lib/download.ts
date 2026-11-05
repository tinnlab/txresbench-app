/**
 * txrresults CSV download seam (ITEM-10, PROV-UR-6 / DEC-13) — the ONLY
 * file-write the module performs, and a pure local one: the engine's
 * predictions CSV is fetched through the generated client (the framework
 * transport resolves `text/*` responses to the response text — verified in
 * `sdk/packages/framework/src/api-client/core.ts`'s content-type parse
 * switch) and saved via a Blob + objectURL + anchor, the
 * `ProvenanceExport` precedent. No raw `fetch`, no host literal, no
 * telemetry: the auth/refresh/retry machinery stays the transport's, and
 * the file lands in the user's own downloads folder (INV-3).
 *
 * The download needs no terminal run state — the engine serves the CSV
 * while the run is active, so the pages enable the button exactly when
 * predictions are not `'unavailable'` (the ITEM-6 boundary). A failed
 * fetch (409 / 404 / network) REJECTS — never a silent no-op: the pages
 * surface the rejection as the inline `txr-results-download-error` state
 * (PROV-UR-5, TEST-UR-8).
 *
 * The barrel re-exports `downloadPredictionsCsv` (PROV-UR-9, GAP-HIST-4):
 * `ui-history`'s screen-K "Download predictions" imports through this
 * module's barrel, never a seam-mirror of its own.
 */
import { ApiClient } from '@/api-client'

/** The local CSV file name the results screens save (the run id is the engine's). */
export function predictionsCsvNameOf(runId: string): string {
  return `predictions-${runId}.csv`
}

/**
 * Save `text` as a browser download — the blob + anchor pattern
 * (`ProvenanceExport` precedent): the anchor is appended to the document
 * (browsers need it in the tree), clicked, removed, and the object URL
 * revoked on the same tick.
 */
export function saveTextAsFile(filename: string, text: string): void {
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
 * The predictor CSV, byte passthrough through the generated client. The
 * generated response type is `void` (the route declares no body schema),
 * while the transport resolves `text/csv` to the text — the one-seam cast
 * (the txrintake precedent) keeps a bodiless response loud instead of
 * silently saving nothing.
 *
 * Rejects on any transport failure (the pages' inline error) and on an
 * empty body; the file's column shape is the provider's and is NOT
 * re-parsed here (CONS-UR-5 — byte passthrough).
 */
export function downloadPredictionsCsv(runId: string): Promise<void> {
  return ApiClient.Txr.downloadPredictions({ id: runId }).then(body => {
    const text = body as unknown as string
    if (typeof text !== 'string' || text.length === 0) {
      return Promise.reject(new Error('the predictions download came back empty'))
    }
    saveTextAsFile(predictionsCsvNameOf(runId), text)
  })
}
