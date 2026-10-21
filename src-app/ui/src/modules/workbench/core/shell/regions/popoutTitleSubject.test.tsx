// @vitest-environment jsdom
//
// A POPPED-OUT PANE'S WINDOW TITLE IS A PANE TITLE, AND A PANE TITLE ARRIVES.
//
// `RegionPopoutWindows` sets `win.document.title = paneTitle(pane)` — the same string the tab
// draws. Since `27b19e86` that string is no longer a pure function of the pane map: a `jobs`
// pane is opened with a job ID and learns the job's NAME on a later fetch, announced through
// `notifyPaneSubjectsChanged`. The two IN-shell readers subscribe (`RegionShell`, `PaneBody`);
// the popped-out one did not, so a pane popped out before its name landed kept an OS window
// titled "Jobs" forever, while the same pane's tab in the main window read "Jobs · Nightly
// filter". The effect's dep list is `[containerId, title]` and `title` never changed.
//
// The window here is a REAL second document (an iframe registered exactly as the pop-out gesture
// registers a `window.open` result), the same fixture `popoutPortalContainer.test.tsx` uses —
// `document.title` is a property of a document, so nothing short of a second document can
// observe this.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { registerPopupWindow, unregisterPopupWindow, type ContainerId } from '@ziee/dock'
import { RegionPopoutWindows } from './RegionPopoutWindows'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { rememberJobNames, __resetJobNames } from '@/modules/jobs/jobNames'
import '@/modules/workbench/core/shell/dock/panes'

function polyfill(scope: Window & typeof globalThis): void {
  const g = scope as unknown as Record<string, unknown>
  g.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (typeof g.PointerEvent !== 'function') g.PointerEvent = class extends scope.MouseEvent {}
  if (!g.CSS) g.CSS = { escape: (v: string) => v }
  if (!scope.matchMedia) {
    scope.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as never
  }
}

beforeAll(() => polyfill(globalThis as unknown as Window & typeof globalThis))

const CONTAINER = 'popup-title-1' as ContainerId
const JOB_ID = '3f2a1c8e-9d4b-4c1e-8a77-2b6f0d1e5a90'

let root: Root | null = null
let frame: HTMLIFrameElement | null = null
let seq = 0

function openPopupWindow(): Document {
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) throw new Error('iframe produced no document — the two-document premise is void')
  polyfill(win as unknown as Window & typeof globalThis)
  registerPopupWindow(CONTAINER, win)
  return doc
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  unregisterPopupWindow(CONTAINER)
  frame?.remove()
  frame = null
  document.body.innerHTML = ''
})

describe('a popped-out pane’s window title', () => {
  it('updates when the pane’s subject arrives', () => {
    __resetJobNames()
    const project = `wb-popout-title-${++seq}`
    workbenchDockStore.getState().ensureProject(project)
    workbenchRegionsStore.getState().ensureProject(project)
    const paneId = workbenchDockStore.getState().requestAddPane('jobs', JOB_ID)
    expect(paneId, 'the jobs pane opened').toBeTruthy()

    const doc = openPopupWindow()
    workbenchRegionsStore.getState().popOut(paneId, CONTAINER)

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(<RegionPopoutWindows />)
    })

    // BEFORE the fetch: honest, and never the id.
    expect(doc.title, 'the window is titled by the pane').toBe('Jobs')

    // The name ARRIVES on a poll the window did not make.
    act(() => {
      rememberJobNames([{ id: JOB_ID, name: 'Nightly filter', job_type: 'demo.filter' }])
    })
    expect(
      doc.title,
      'a popped-out pane kept a stale window title while its own tab in the main window updated',
    ).toBe('Jobs · Nightly filter')
  })
})
