// The per-run local-API key, for the desktop build.
//
// The embedded server refuses every request that does not carry the key the
// desktop shell made at start (header `X-TxR-Local-Key`; see the server's
// `modules/local_api_lock`). The webview learns it only over Tauri IPC
// (`get_api_secret`), like the port (`get_server_port`), so a web page in the
// user's browser, which has no IPC, cannot send it.
//
// Registered as the transport's extra-headers provider (`api-client/index.ts`),
// which awaits it before every request, so nothing is sent before the key is read.
// In a plain browser (web or dev server) there is no Tauri global and no header:
// the dev proxy adds it (`vite.config.ts`).
export const LOCAL_KEY_HEADER = 'X-TxR-Local-Key'

interface TauriGlobal {
  core: { invoke: <T>(cmd: string) => Promise<T> }
}

let cached: Promise<Record<string, string>> | undefined

export const getLocalKeyHeaders = (): Promise<Record<string, string>> => {
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__
  if (!tauri) return Promise.resolve({})
  if (!cached) {
    cached = tauri.core.invoke<string>('get_api_secret').then(
      key => ({ [LOCAL_KEY_HEADER]: key }),
      err => {
        // Not cached on failure: the next request asks again (the key may not be
        // set yet at the very first call) rather than failing for the whole run.
        cached = undefined
        throw err
      },
    )
  }
  return cached
}

/** Test seam: forget the cached key. */
export const resetLocalKeyForTests = (): void => {
  cached = undefined
}
