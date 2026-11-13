import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEADER_BAR_HEIGHT,
  HEADER_INSET_COLLAPSED,
  HEADER_INSET_EXPANDED,
  SIDEBAR_TOGGLE_LEFT,
  headerLeftInsetFor,
  sidebarToggleLeftFor,
  skipLinkStyleFor,
  titleBarHeightFor,
  windowChromeOrNull,
  windowDragRegionAttr,
  type WindowChrome,
} from './windowChrome.ts'

// The macOS overlay title bar a desktop app reports: the traffic lights end at
// x = 74, text starts at 94, and the title bar is 56 px tall.
const MAC: WindowChrome = { controlsRight: 74, contentStart: 94, titleBarHeight: 56 }

test('no window chrome (the web, or outside an AppLayout): the chrome is unchanged', () => {
  for (const chrome of [undefined, null]) {
    assert.equal(headerLeftInsetFor(true, chrome), 48)
    assert.equal(headerLeftInsetFor(false, chrome), 12)
    assert.equal(sidebarToggleLeftFor(chrome), 12)
    assert.equal(titleBarHeightFor(chrome), 50)
    // undefined = keep the class's own `left-2`; no inline style at all.
    assert.equal(skipLinkStyleFor(chrome), undefined)
    assert.equal(windowDragRegionAttr(chrome), undefined)
  }
  assert.equal(HEADER_INSET_COLLAPSED, 48)
  assert.equal(HEADER_INSET_EXPANDED, 12)
  assert.equal(HEADER_BAR_HEIGHT, 50)
  assert.equal(SIDEBAR_TOGGLE_LEFT, 12)
})

test('window chrome moves the toggle, the collapsed header and the skip link past the controls', () => {
  // The toggle 8 px after the controls; the header after the toggle (82 + 28 + 8).
  assert.equal(sidebarToggleLeftFor(MAC), 82)
  assert.equal(headerLeftInsetFor(true, MAC), 118)
  // The skip link where the window's text starts.
  assert.deepEqual(skipLinkStyleFor(MAC), { left: 94 })
  assert.ok(sidebarToggleLeftFor(MAC) > MAC.controlsRight)
  assert.ok(headerLeftInsetFor(true, MAC) > sidebarToggleLeftFor(MAC) + 28)
})

test('window chrome sets the title-bar height and the drag region', () => {
  assert.equal(titleBarHeightFor(MAC), 56)
  assert.equal(windowDragRegionAttr(MAC), 'deep')
})

test('beside an open sidebar the header keeps its 12 px: the sidebar carries the controls', () => {
  assert.equal(headerLeftInsetFor(false, MAC), 12)
})

test('a nonsense chrome is ignored, never applied', () => {
  const bad = [
    { controlsRight: -10, contentStart: 94, titleBarHeight: 56 },
    { controlsRight: 74, contentStart: Number.NaN, titleBarHeight: 56 },
    { controlsRight: 74, contentStart: 94, titleBarHeight: 0 },
  ]
  for (const chrome of bad) {
    assert.equal(windowChromeOrNull(chrome), null)
    assert.equal(headerLeftInsetFor(true, chrome), 48)
    assert.equal(sidebarToggleLeftFor(chrome), 12)
    assert.equal(titleBarHeightFor(chrome), 50)
    assert.equal(skipLinkStyleFor(chrome), undefined)
    assert.equal(windowDragRegionAttr(chrome), undefined)
  }
  assert.equal(windowChromeOrNull(MAC), MAC)
})
