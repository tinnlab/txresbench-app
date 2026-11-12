// popout (ITEM-15/16/17) — the gesture-gated pop-out of a pane to an OS window, built on
// `@txresbench/dock`'s popup-window registry + `movePane`. `window.open` needs a user GESTURE, so the
// pop-out CLICK (or a tear-off pointerup, or a cross-window drop-to-empty) opens the window
// synchronously, registers it, and moves the pane into its container; `<ContainerWindows>` then
// portals the pane's workspace into it. A blocked `window.open` (popup blocker) returns
// `{ blocked: true }` so the caller offers a Retry (a fresh gesture). Mirrors viz's pop-out.

import {
  registerPopupWindow,
  nextPopupContainerId,
  type ContainerId,
  type DropTarget,
} from '@txresbench/dock'
import type { WorkbenchDockStore } from './WorkbenchDock.store'

/** Popup window geometry. */
export interface PopupGeometry {
  readonly width: number
  readonly height: number
  readonly left?: number
  readonly top?: number
}

/** Build the `window.open` features string (a real popup window, not a tab). */
export function buildPopupFeatures(g: PopupGeometry): string {
  const parts = [
    'popup=yes',
    `width=${Math.max(1, Math.round(g.width))}`,
    `height=${Math.max(1, Math.round(g.height))}`,
  ]
  if (g.left != null && Number.isFinite(g.left)) parts.push(`left=${Math.max(0, Math.round(g.left))}`)
  if (g.top != null && Number.isFinite(g.top)) parts.push(`top=${Math.max(0, Math.round(g.top))}`)
  return parts.join(',')
}

/** Center a `w×h` popup on a `sw×sh` screen (clamped to the top-left). */
export function centeredGeometry(w: number, h: number, sw: number, sh: number): PopupGeometry {
  return {
    width: w,
    height: h,
    left: Math.max(0, Math.round((sw - w) / 2)),
    top: Math.max(0, Math.round((sh - h) / 2)),
  }
}

const POPUP_W = 900
const POPUP_H = 680

export interface PopOutResult {
  ok: boolean
  /** the popup was blocked (offer a Retry). */
  blocked?: boolean
  containerId?: ContainerId
}

/**
 * Pop `paneId` out into a NEW OS window (a user gesture must be in flight). Allocates a fresh
 * popup container id, opens the window, registers it, and moves the pane into it (`root`). A
 * blocked `window.open` → `{ ok:false, blocked:true }` (the pane stays put; the caller retries).
 */
export function popOutPane(paneId: string, store: WorkbenchDockStore): PopOutResult {
  if (typeof window === 'undefined') return { ok: false }
  const containerId = nextPopupContainerId()
  const features = buildPopupFeatures(
    centeredGeometry(POPUP_W, POPUP_H, window.screen?.width ?? 1440, window.screen?.height ?? 900),
  )
  let win: Window | null = null
  try {
    win = window.open('about:blank', containerId, features)
  } catch {
    win = null
  }
  if (!win) return { ok: false, blocked: true }
  registerPopupWindow(containerId, win)
  const rootTarget: DropTarget = { kind: 'root' }
  store.getState().movePane(paneId, containerId, rootTarget)
  return { ok: true, containerId }
}

/** Reopen a session-restored popup container's window (the "Reopen windows" gesture). Returns the
 *  ids whose windows actually opened (a browser may cap multiple `window.open`s per gesture). */
export function reopenRestoredWindows(ids: readonly ContainerId[]): ContainerId[] {
  if (typeof window === 'undefined') return []
  const opened: ContainerId[] = []
  for (const id of ids) {
    const features = buildPopupFeatures(
      centeredGeometry(POPUP_W, POPUP_H, window.screen?.width ?? 1440, window.screen?.height ?? 900),
    )
    let w: Window | null = null
    try {
      w = window.open('about:blank', id, features)
    } catch {
      w = null
    }
    if (w) {
      registerPopupWindow(id, w)
      opened.push(id)
    }
  }
  return opened
}
