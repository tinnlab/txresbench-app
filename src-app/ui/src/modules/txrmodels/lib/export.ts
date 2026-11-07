/**
 * txrmodels — the J screen's per-row Export (ITEM-8; PROV-MS-7's
 * `GET /api/txr/models/{id}/export`, CONS-UM-10).
 *
 * The export is BYTE PASSTHROUGH: the generated client is the only
 * transport (INV-5 — the app's own loopback, never a host literal), the
 * response resolves to a `Blob` by the framework's content-type parse
 * switch (binary is the default branch), and the UI never re-parses the
 * container — the picked bytes are saved to the user's downloads, exactly
 * like the `txrintake` / `txrresults` CSV saves (blob + object URL +
 * anchor click, URL revoked on the same tick).
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

/** Save a Blob as a browser download (blob + anchor, URL revoked after the
 *  click — the `ProvenanceExport` / txrintake precedent). */
export function saveBlobAsFile(filename: string, blob: Blob): void {
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
 * One model's export: fetch the container through the generated client and
 * save it. The generated response type is `void` (the route declares no
 * JSON body), while the transport returns the response Blob for a binary
 * body — the one-seam cast (the txrintake CSV precedent); a non-Blob
 * response (a missing body) rejects loudly instead of saving nothing.
 * Rejects on any transport failure — the page's inline error line.
 */
export async function downloadModelExport(model: ModelSummary): Promise<void> {
  const body = (await ApiClient.Models.exportModel({ id: model.id })) as unknown as Blob | null
  if (body === null || typeof body !== 'object' || !('size' in body)) {
    throw new Error('the model export came back empty')
  }
  saveBlobAsFile(modelExportFilename(model), body)
}
