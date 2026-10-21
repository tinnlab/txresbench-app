// popupWindowRegistry.ts — the bridge between the GESTURE that opens a popup window and the REACTIVE
// render that fills it (PORTAL_DOCKING P3b).
//
// `window.open` needs a user gesture, so a popout/tear-off/send-to-window CLICK handler opens the
// window synchronously and REGISTERS it here under its container id. `ContainerWindows` then reacts to
// the store's popup containers and `createPortal`s a `<GridWorkspace containerId>` into the registered
// window. On close (Return / OS chrome / empty-container drain) the window is unregistered + closed.
//
// Module-level (one popup-window map per document) + reactive via `useSyncExternalStore`, mirroring
// the `CellPopoutRegistry` pattern. No React/deck import — plain map + listeners.

import type { ContainerId } from './containers'

const windows = new Map<ContainerId, Window>()
const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<ContainerId, Window> = new Map()

function publish(): void {
  snapshot = new Map(windows)
  for (const l of listeners) l()
}

/** Register a just-opened popup window under its container id (called in the opening gesture). */
export function registerPopupWindow(containerId: ContainerId, win: Window): void {
  windows.set(containerId, win)
  publish()
}

/** Drop a container's window from the registry (does NOT close it — the caller decides). */
export function unregisterPopupWindow(containerId: ContainerId): void {
  if (windows.delete(containerId)) publish()
}

/** Close a container's window (if still open) AND unregister it. Idempotent. */
export function closePopupWindow(containerId: ContainerId): void {
  const win = windows.get(containerId)
  if (win && !win.closed) win.close()
  unregisterPopupWindow(containerId)
}

/** The live window handle for a container, or undefined. */
export function getPopupWindow(containerId: ContainerId): Window | undefined {
  return windows.get(containerId)
}

/** Allocate the next free `popup:<n>` container id (avoids colliding with a still-open window). */
let counter = 0
export function nextPopupContainerId(): ContainerId {
  let id: ContainerId
  do {
    id = `popup:${counter++}`
  } while (windows.has(id))
  return id
}

/** Advance the allocator past every `popup:<n>` id in `ids` — call on session HYDRATE so a fresh
 *  allocation can't collide with a RESTORED popup container id (the counter resets to 0 each page life,
 *  but a restored session may carry `popup:3`). Defense-in-depth on top of the `windows.has` skip. */
export function seedPopupCounterFrom(ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /^popup:(\d+)$/.exec(id)
    if (m) counter = Math.max(counter, Number(m[1]) + 1)
  }
}

/** `useSyncExternalStore` seams. */
export function subscribePopupWindows(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function getPopupWindowsSnapshot(): ReadonlyMap<ContainerId, Window> {
  return snapshot
}

/** Test-only reset. */
export function __resetPopupWindowRegistry(): void {
  for (const w of windows.values()) if (!w.closed) w.close()
  windows.clear()
  counter = 0
  publish()
}
