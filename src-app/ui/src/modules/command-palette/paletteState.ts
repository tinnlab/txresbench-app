import { useSyncExternalStore } from 'react'

// Module-level open/closed state for the command palette — the SAME
// out-of-React-singleton + `useSyncExternalStore` shape the agent engine
// uses for its connection status (`@/core/actions/engine.ts`). A
// module-level singleton (not a Zustand store) is deliberate: the palette
// must be openable from non-React call sites too (a `sidebarTools` slot's
// `onClick`, the global ⌘K keydown listener in `module.tsx`) — it has no
// server-backed state worth a full store, just visibility.

let open = false
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach(listener => listener())
}

export function isCommandPaletteOpen(): boolean {
  return open
}

export function openCommandPalette(): void {
  if (open) return
  open = true
  emit()
}

export function closeCommandPalette(): void {
  if (!open) return
  open = false
  emit()
}

export function toggleCommandPalette(): void {
  open = !open
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** React hook for the palette's live open/closed state. */
export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, isCommandPaletteOpen, isCommandPaletteOpen)
}
