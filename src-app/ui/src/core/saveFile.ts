/**
 * Saving a file the user asked for — one helper for the desktop app and the
 * website.
 *
 * - **Website:** the browser download (a Blob + a temporary `<a download>`
 *   link, the object URL revoked after the click), as before.
 * - **Desktop app:** the app window has no browser download handler, so that
 *   link does nothing there. Instead the native Save dialog opens
 *   (`plugin:dialog|save`, the dialog plugin's own command; permission
 *   `dialog:allow-save` in `desktop/tauri/capabilities/default.json`), and the
 *   bytes go to the desktop command `save_file`
 *   (`desktop/tauri/src/save_file.rs`) as a raw body, with the chosen path
 *   percent-encoded in the `x-txr-save-path` header. Cancelling the dialog is
 *   not an error.
 *
 * The desktop check is the pure `isDesktop()` predicate; the Tauri bridge is
 * the global `window.__TAURI__` (`withGlobalTauri`), the same idiom as
 * `txrresults/lib/reveal.ts`.
 */
import { isDesktop, isMacOS } from '@/core/platform'

/** What one save did. */
export type SaveFileResult =
  | { status: 'saved'; path: string }
  | { status: 'downloaded' }
  | { status: 'cancelled' }

export interface SaveFileRequest {
  /** The suggested file name (`predictions-<run>.csv`). */
  filename: string
  /** The file contents. */
  data: string | Blob
  /** The browser download's MIME type for text data (default CSV). */
  mimeType?: string
  /** The Save dialog's file-type filter (e.g. `{ name: 'CSV', extensions: ['csv'] }`). */
  filter?: { name: string; extensions: string[] }
}

/** The desktop command and its path header (the `save_file.rs` contract). */
export const SAVE_FILE_COMMAND = 'save_file'
export const SAVE_PATH_HEADER = 'x-txr-save-path'

type Invoke = (
  cmd: string,
  args?: unknown,
  options?: { headers?: Record<string, string> },
) => Promise<unknown>

interface TauriGlobal {
  core?: { invoke?: Invoke }
}

function tauriInvoke(): Invoke | null {
  if (!isDesktop()) return null
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  return tauri?.core?.invoke ?? null
}

/** True when saving goes through the native Save dialog (the desktop app). */
export function savesWithDialog(): boolean {
  return tauriInvoke() !== null
}

/** The button text for a save: the app's dialog wording, or the website's download wording. */
export function saveLabel(app: string, web: string): string {
  return savesWithDialog() ? app : web
}

/** The browser download (the website path). */
export function browserDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'))
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * Save one file: the Save dialog + the desktop write in the app, the browser
 * download on the website. Rejects when the dialog or the write fails (the
 * page shows its error line); resolves `cancelled` when the user closes the
 * dialog without choosing a place.
 */
export async function saveFile(request: SaveFileRequest): Promise<SaveFileResult> {
  const { filename, data, filter } = request
  const invoke = tauriInvoke()
  if (invoke === null) {
    const blob =
      typeof data === 'string'
        ? new Blob([data], { type: request.mimeType ?? 'text/csv;charset=utf-8' })
        : data
    browserDownload(filename, blob)
    return { status: 'downloaded' }
  }
  const chosen = await invoke('plugin:dialog|save', {
    options: {
      defaultPath: filename,
      canCreateDirectories: true,
      ...(filter ? { filters: [filter] } : {}),
    },
  })
  if (chosen === null || chosen === undefined || chosen === '') return { status: 'cancelled' }
  if (typeof chosen !== 'string') throw new Error('the Save dialog returned an unexpected value')
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : await blobBytes(data)
  await invoke(SAVE_FILE_COMMAND, bytes, {
    headers: { [SAVE_PATH_HEADER]: encodeURIComponent(chosen) },
  })
  return { status: 'saved', path: chosen }
}

/** The folder of a saved file's path (`/a/b/c.csv` → `/a/b`; Windows separators too). */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut <= 0) return path.slice(0, cut + 1) || path
  return path.slice(0, cut)
}

/** "Show in Finder" on a Mac, "Show in folder" elsewhere. */
export function showSavedLabel(): string {
  return isMacOS() ? 'Show in Finder' : 'Show in folder'
}

/**
 * Open the saved file's folder in the system file manager (the desktop
 * command `reveal_in_file_manager`). A failure is swallowed: the "Saved to"
 * line already told the user where the file is.
 */
export function revealSavedFile(path: string): Promise<void> {
  const invoke = tauriInvoke()
  if (invoke === null) return Promise.resolve()
  return invoke('reveal_in_file_manager', { path: folderOf(path) }).then(
    () => undefined,
    () => undefined,
  )
}
