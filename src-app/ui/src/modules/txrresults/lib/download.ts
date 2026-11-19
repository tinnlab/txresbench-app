/**
 * txrresults CSV download seam (ITEM-10, PROV-UR-6 / DEC-13) — the ONLY
 * file-write the module performs, and a pure local one: the engine's
 * predictions CSV is fetched through the generated client (the framework
 * transport resolves `text/*` responses to the response text — verified in
 * `sdk/packages/framework/src/api-client/core.ts`'s content-type parse
 * switch) and saved through `@/core/saveFile`: the browser download on the
 * website, the native Save dialog in the desktop app (whose window has no
 * download handler). No raw `fetch`, no host literal, no telemetry: the
 * auth/refresh/retry machinery stays the transport's, and the file lands
 * where the user chose, or in their downloads folder (INV-3).
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
import { saveFile, saveLabel, type SaveFileResult } from '@/core/saveFile'

/** The local CSV file name the results screens save (the run id is the engine's). */
export function predictionsCsvNameOf(runId: string): string {
  return `predictions-${runId}.csv`
}

/** The Save dialog's file-type filter for the predictions CSV. */
export const CSV_FILTER = { name: 'CSV', extensions: ['csv'] }

/**
 * The predictions button's text: the desktop app saves through the Save
 * dialog, the website downloads (`@/core/saveFile`). `all` is the heatmap
 * page's wording ("all predictions"); the one-method page says "predictions".
 */
export function predictionsSaveLabel(all = true): string {
  return all
    ? saveLabel('Save all predictions as CSV…', 'Download all predictions (CSV)')
    : saveLabel('Save predictions as CSV…', 'Download predictions (CSV)')
}

/** The inline error line after a failed save or download. */
export function predictionsSaveError(): string {
  return saveLabel(
    'The predictions could not be saved. Try again.',
    'The predictions could not be downloaded. Try again.',
  )
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
export function downloadPredictionsCsv(runId: string): Promise<SaveFileResult> {
  return ApiClient.Txr.downloadPredictions({ id: runId }).then(body => {
    const text = body as unknown as string
    if (typeof text !== 'string' || text.length === 0) {
      return Promise.reject(new Error('the predictions download came back empty'))
    }
    return saveFile({ filename: predictionsCsvNameOf(runId), data: text, filter: CSV_FILTER })
  })
}
