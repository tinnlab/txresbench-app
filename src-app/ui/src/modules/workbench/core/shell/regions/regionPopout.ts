// regionPopout — pop a pane out of its region into its OWN OS window (region-model version of the old
// split-tree `popOutPane`). `window.open` needs a live user gesture (the pop-out click), so this opens
// + registers the window synchronously and records the pane in `workbenchRegionsStore.poppedOut`
// (which excludes it from its region). `RegionPopoutWindows` then portals the pane's content into the
// window; closing the window un-pops it (back to its region). Reuses `@txresbench/dock`'s popup registry.

import { registerPopupWindow, nextPopupContainerId } from '@txresbench/dock'
import { buildPopupFeatures, centeredGeometry } from '@/modules/workbench/core/shell/dock/popout'
import { workbenchRegionsStore } from './WorkbenchRegions.store'

const POPUP_W = 900
const POPUP_H = 680

/** Pop `paneId` out into a new window. Returns false if blocked / unavailable (the pane stays put). */
export function regionPopOut(paneId: string): boolean {
  if (typeof window === 'undefined') return false
  if (workbenchRegionsStore.getState().poppedOut[paneId]) return false // already popped out
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
  if (!win) return false
  registerPopupWindow(containerId, win)
  workbenchRegionsStore.getState().popOut(paneId, containerId)
  return true
}
