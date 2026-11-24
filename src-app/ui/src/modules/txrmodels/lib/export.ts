/**
 * txrmodels — the J screen's per-row Export (ITEM-8; PROV-MS-7's
 * `GET /api/txr/models/{id}/export`, CONS-UM-10).
 *
 * The export is BYTE PASSTHROUGH: the generated client is the only
 * transport (INV-5 — the app's own loopback, never a host literal), the
 * response resolves to a `Blob` by the framework's content-type parse
 * switch (binary is the default branch), and the UI never re-parses the
 * container — the picked bytes are saved through `@/core/saveFile`, like
 * the `txrintake` / `txrresults` CSV saves: the browser download on the
 * website, the native Save dialog in the desktop app.
 *
 * The attachment's Content-Disposition filename is the provider's
 * response-header contract (the generated client exposes no header
 * access), so the local save name is derived here instead — the same
 * convention the whole app follows (every download helper names the file):
 * `<display name>.txr`, sanitised to one path-safe stem, `model` when the
 * name is not usable. The `.txr` extension is the provider's container
 * spelling (the pretrained cards' own `asset.file` values), never a
 * format claim.
 */
import { ApiClient } from '@/api-client'
import type { ModelSummary } from '@/api-client/types'
import { saveFile, saveLabel, type SaveFileResult } from '@/core/saveFile'

/** One path-safe stem from the model's display name (never empty). */
function exportStem(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'model'
}

/** The export's file name (`<display name>.txr`, sanitised). */
export function modelExportFilename(model: ModelSummary): string {
  return `${exportStem(model.name)}.txr`
}

/** The Save dialog's file-type filter for a model file. */
export const MODEL_FILE_FILTER = { name: 'TxResBench model', extensions: ['txr'] }

/** The Export button's text: "Export…" opens the desktop Save dialog. */
export function modelExportLabel(): string {
  return saveLabel('Export…', 'Export')
}

/** The set export's file name (`<sanitised set name>.txr` — the same
 *  path-safe stem the model export derives). */
export function setExportFilename(name: string): string {
  return `${exportStem(name)}.txr`
}

/** The Save dialog's file-type filter for a set file. */
export const SET_FILE_FILTER = { name: 'TxResBench set', extensions: ['txr'] }

/** The Export set button's text: "Export set…" opens the desktop Save
 *  dialog (the `modelExportLabel` mirror). */
export function setExportLabel(): string {
  return saveLabel('Export set…', 'Export set')
}

/** The one failure line for a set export (the page's action error). */
export const SET_EXPORT_FAILED_LINE = 'The set could not be exported.'

/**
 * One model's export: fetch the container through the generated client and
 * save it. The generated response type is `void` (the route declares no
 * JSON body), while the transport returns the response Blob for a binary
 * body — the one-seam cast (the txrintake CSV precedent); a non-Blob
 * response (a missing body) rejects loudly instead of saving nothing.
 * Rejects on any transport failure — the page's inline error line.
 */
export async function downloadModelExport(model: ModelSummary): Promise<SaveFileResult> {
  const body = (await ApiClient.Models.exportModel({ id: model.id })) as unknown as Blob | null
  if (body === null || typeof body !== 'object' || !('size' in body)) {
    throw new Error('the model export came back empty')
  }
  return saveFile({ filename: modelExportFilename(model), data: body, filter: MODEL_FILE_FILTER })
}

/**
 * One set's export (the Models page's "Export set"): fetch the set's
 * container through the generated client (`GET /api/txr/model-sets/{id}/export`
 * — the same byte-passthrough stance as `downloadModelExport`) and save it
 * under `<sanitised set name>.txr` (the same sanitiser, the same desktop
 * Save dialog / browser download). Rejects on any transport failure — the
 * page's inline `SET_EXPORT_FAILED_LINE`.
 */
export async function downloadSetExport(set: { id: string; name: string }): Promise<SaveFileResult> {
  const body = (await ApiClient.ModelSets.exportSet({ id: set.id })) as unknown as Blob | null
  if (body === null || typeof body !== 'object' || !('size' in body)) {
    throw new Error('the set export came back empty')
  }
  return saveFile({
    filename: setExportFilename(set.name),
    data: body,
    filter: SET_FILE_FILTER,
  })
}
