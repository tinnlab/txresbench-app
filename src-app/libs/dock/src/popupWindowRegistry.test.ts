import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerPopupWindow,
  unregisterPopupWindow,
  closePopupWindow,
  getPopupWindow,
  nextPopupContainerId,
  subscribePopupWindows,
  getPopupWindowsSnapshot,
  __resetPopupWindowRegistry,
} from './popupWindowRegistry'
import type { ContainerId } from './containers'

/** A minimal Window-shaped fake (no jsdom needed). */
function fakeWin(): Window & { closed: boolean } {
  const w = {
    closed: false,
    close() {
      w.closed = true
    },
  }
  return w as unknown as Window & { closed: boolean }
}

describe('popupWindowRegistry', () => {
  beforeEach(() => __resetPopupWindowRegistry())

  it('register/get/unregister round-trips + publishes a fresh snapshot', () => {
    let ticks = 0
    const off = subscribePopupWindows(() => ticks++)
    const w = fakeWin()
    registerPopupWindow('popup:0', w)
    expect(getPopupWindow('popup:0')).toBe(w)
    expect(getPopupWindowsSnapshot().get('popup:0')).toBe(w)
    expect(ticks).toBe(1)
    unregisterPopupWindow('popup:0')
    expect(getPopupWindow('popup:0')).toBeUndefined()
    expect(ticks).toBe(2)
    off()
  })

  it('closePopupWindow closes the handle + unregisters (idempotent)', () => {
    const w = fakeWin()
    registerPopupWindow('popup:1', w)
    closePopupWindow('popup:1')
    expect(w.closed).toBe(true)
    expect(getPopupWindow('popup:1')).toBeUndefined()
    // idempotent — no throw, no extra publish crash
    closePopupWindow('popup:1')
    expect(getPopupWindow('popup:1')).toBeUndefined()
  })

  it('nextPopupContainerId is monotonic and skips ids with a live window', () => {
    const a = nextPopupContainerId()
    const b = nextPopupContainerId()
    expect(a).toBe('popup:0')
    expect(b).toBe('popup:1')
    // reserve popup:2 with a live window → the allocator must skip it
    registerPopupWindow('popup:2' as ContainerId, fakeWin())
    const c = nextPopupContainerId()
    expect(c).toBe('popup:3')
  })

  it('snapshot is a stable reference between changes', () => {
    const s1 = getPopupWindowsSnapshot()
    const s2 = getPopupWindowsSnapshot()
    expect(s1).toBe(s2)
    registerPopupWindow('popup:0', fakeWin())
    expect(getPopupWindowsSnapshot()).not.toBe(s1)
  })

  it('reset closes all + clears the counter', () => {
    const w = fakeWin()
    registerPopupWindow('popup:0', w)
    __resetPopupWindowRegistry()
    expect(w.closed).toBe(true)
    expect(getPopupWindow('popup:0')).toBeUndefined()
    expect(nextPopupContainerId()).toBe('popup:0')
  })
})
