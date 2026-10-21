import { AppShell } from '@ziee/shell'
import { useSessionStore } from '@/modules/session/Session.store'
import { loadModules } from '@/modules/loader'

// Discover + register every module BEFORE the shell mounts (the shell renders
// whatever registered; it owns no module discovery of its own).
loadModules()

/**
 * App — TxResBench's root.
 *
 * The whole body is the SDK's generic, slot-driven `AppShell` (@ziee/shell): it
 * renders every module-registered component sorted by `order` (the router at
 * order 0) inside the shell's `ThemeProvider`, wraps each module in its own
 * error boundary, prefetches lazy chunks on idle, and wires the realtime-sync
 * SSE lifecycle to this app's single-user `Session` store. No app-specific
 * bootstrap logic remains here — it's all SDK.
 */
export default function App() {
  return <AppShell authStore={useSessionStore} />
}
