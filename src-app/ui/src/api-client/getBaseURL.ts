// Resolve the API base URL.
//
// - Web / dev: same-origin ('' → the Vite proxy forwards /api to the backend).
// - Desktop (Tauri webview): the SPA is loaded from the Tauri asset protocol, so
//   it must reach the embedded server on its ephemeral loopback port, which the
//   Rust side exposes via the `get_server_port` IPC command.
let cached: string | undefined

interface TauriGlobal {
  core: { invoke: <T>(cmd: string) => Promise<T> }
}

export const getBaseUrl = async (): Promise<string> => {
  if (cached !== undefined) return cached
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  if (tauri) {
    const port = await tauri.core.invoke<number>('get_server_port')
    cached = `http://127.0.0.1:${port}`
  } else {
    cached = window.location.origin
  }
  return cached
}
