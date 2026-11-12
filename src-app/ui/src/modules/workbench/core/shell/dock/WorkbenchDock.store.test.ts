import { describe, it, expect, beforeEach } from 'vitest'
import {
  leafIds,
  PRIMARY_CONTAINER,
  registerPopupWindow,
  getPopupWindow,
  __resetPopupWindowRegistry,
} from '@txresbench/dock'
import { createWorkbenchDockStore } from './WorkbenchDock.store'
import { memoryStorage, savePopups, type PopupSlice } from './dockPersistence'
import { DEFAULT_PANE_IDS } from './defaultLayout'
import { FallbackPane, isPaneKind, resolvePaneRenderer } from './paneModel'

const { visualize, canvas, datasets } = DEFAULT_PANE_IDS

/** A fresh store with injected in-memory storages (inspect what landed in local vs. session) and a
 *  fixed non-reload navigation (so ensureProject doesn't pull a restore). */
function mk(local = memoryStorage(), session = memoryStorage()) {
  const store = createWorkbenchDockStore({ storages: { local, session }, isReload: () => false })
  return { store, local, session }
}

beforeEach(() => __resetPopupWindowRegistry())

// TEST-202 (ITEM-8) — container-aware actions delegate to @txresbench/dock movePane/resizeDivider.
describe('WorkbenchDock.store — moves delegate to @txresbench/dock (ITEM-8)', () => {
  it('moving a pane main→popup:1 reflows main, roots the popup tree, sets paneContainer, honors emptied', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    const s = store.getState()
    expect(s.paneContainer[visualize]).toBe('popup:1')
    expect(s.containerLayouts['popup:1']).toEqual({ kind: 'leaf', id: visualize })
    expect(leafIds(s.layout)).not.toContain(visualize) // main reflowed to reclaim the space
    expect(s.pendingClose).not.toContain('popup:1') // moving IN never empties

    // Moving popup:1's LAST pane back to main → popup:1 emptied → queued for close (MoveResult.emptied).
    store.getState().movePane(visualize, PRIMARY_CONTAINER, { kind: 'root' })
    expect(store.getState().pendingClose).toContain('popup:1')
    expect(leafIds(store.getState().layout)).toContain(visualize)
  })

  it('resizeDivider delegates to @txresbench/dock resizeDivider (main split sizes change)', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    const before = [...(store.getState().layout as { sizes: number[] }).sizes]
    store.getState().resizeDivider([], 0, 0.1)
    const after = [...(store.getState().layout as { sizes: number[] }).sizes]
    expect(after).not.toEqual(before)
    expect(after[0]).toBeCloseTo(before[0] + 0.1, 5)
  })
})

// TEST-203 (ITEM-8) — cross-container isolation with BOTH sides populated.
describe('WorkbenchDock.store — cross-container isolation (ITEM-8)', () => {
  it('a split/resize in main leaves popup:1 byte-identical, and vice-versa', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    // Populate popup:1 with a split (two panes).
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    store.getState().movePane(datasets, 'popup:1', { kind: 'split', atLeaf: visualize, dir: 'col' })

    const popupBefore = JSON.stringify(store.getState().containerLayouts['popup:1'])
    store.getState().splitPane(canvas, 'col') // mutate MAIN
    expect(JSON.stringify(store.getState().containerLayouts['popup:1'])).toBe(popupBefore)

    const mainBefore = JSON.stringify(store.getState().layout)
    store.getState().resizeDivider([], 0, 0.1, 'popup:1') // mutate POPUP
    expect(JSON.stringify(store.getState().layout)).toBe(mainBefore)
  })
})

// TEST-204 (ITEM-8) — MAIN → per-project localStorage, POPUPS → per-tab sessionStorage.
describe('WorkbenchDock.store — split persistence local vs. session (ITEM-8)', () => {
  it('main persists to localStorage per-project; popups persist to sessionStorage per-tab', () => {
    const { store, local, session } = mk()
    store.getState().ensureProject('p1')
    store.getState().splitPane(canvas, 'col') // a MAIN change

    expect(local.map.has('txr.wb.dock.main')).toBe(true)
    const mainBlob = JSON.parse(local.map.get('txr.wb.dock.main') as string)
    expect(mainBlob.byProject.p1).toBeTruthy()

    store.getState().movePane(visualize, 'popup:1', { kind: 'root' }) // a POPUP change
    expect(session.map.has('txr.wb.dock.popups')).toBe(true)
    const popupBlob = JSON.parse(session.map.get('txr.wb.dock.popups') as string)
    expect(popupBlob.p1.paneContainer[visualize]).toBe('popup:1')
    // the MAIN blob carries no popup keys (they live only in sessionStorage).
    expect(mainBlob.byProject.p1.paneContainer).toBeUndefined()
  })

  it('two tabs (shared localStorage, own sessionStorage) share the main layout but keep independent popups', () => {
    const local = memoryStorage()
    const tab1 = mk(local, memoryStorage())
    tab1.store.getState().ensureProject('p1')
    tab1.store.getState().splitPane(canvas, 'col') // durable main change (persisted, shared)
    tab1.store.getState().movePane(visualize, 'popup:1', { kind: 'root' }) // popup only in tab1's session

    // A second tab: SAME localStorage, its OWN sessionStorage.
    const tab2 = mk(local, memoryStorage())
    tab2.store.getState().ensureProject('p1')
    // shares the main layout (the extra split persisted); does NOT see tab1's popup.
    expect(leafIds(tab2.store.getState().layout).length).toBe(leafIds(tab1.store.getState().layout).length)
    expect(tab2.store.getState().paneContainer).toEqual({})
    expect(tab2.store.getState().containerLayouts).toEqual({})
  })
})

// TEST-221 (ITEM-16) — window lifecycle: last-pane-out queues pendingClose, move-in revives, return
// uses a move-out anchor, acknowledge drains.
describe('WorkbenchDock.store — window lifecycle (ITEM-16)', () => {
  it('last-pane-out queues pendingClose; a move-in revives it; acknowledge drains', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    // Two panes into popup:1.
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    store.getState().movePane(canvas, 'popup:1', { kind: 'split', atLeaf: visualize, dir: 'col' })
    // Move one out → still has one → NOT emptied.
    store.getState().movePane(canvas, PRIMARY_CONTAINER, { kind: 'root' })
    expect(store.getState().pendingClose).not.toContain('popup:1')
    // Move the LAST out → emptied → queued.
    store.getState().movePane(visualize, PRIMARY_CONTAINER, { kind: 'root' })
    expect(store.getState().pendingClose).toContain('popup:1')
    // Move a pane back IN → revive (drops it from pendingClose so its window isn't closed).
    store.getState().movePane(canvas, 'popup:1', { kind: 'root' })
    expect(store.getState().pendingClose).not.toContain('popup:1')
  })

  it('return records + uses a move-out anchor and acknowledgeContainerClose drains the queue', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    expect(store.getState().returnAnchors[visualize]).toBeTruthy() // anchor recorded on move-out
    store.getState().returnPaneToMain(visualize)
    expect(store.getState().returnAnchors[visualize]).toBeUndefined() // cleared on return
    expect(leafIds(store.getState().layout)).toContain(visualize)
    expect(store.getState().pendingClose).toContain('popup:1') // emptied by the return
    store.getState().acknowledgeContainerClose('popup:1')
    expect(store.getState().pendingClose).not.toContain('popup:1')
  })
})

// TEST-221b (ITEM-16) — a project switch drains the OUTGOING project's popup OS windows (no orphans).
describe('WorkbenchDock.store — project switch closes outgoing popups (ITEM-16)', () => {
  it('ensureProject → a new project closes + unregisters the previous project\'s popup windows', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    // Pop a pane into popup:1 and register its OS window (as popOutPane's gesture would).
    let winClosed = false
    const fakeWin = { closed: false, close: () => { winClosed = true } } as unknown as Window
    registerPopupWindow('popup:1', fakeWin)
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    expect(getPopupWindow('popup:1')).toBe(fakeWin)

    // Switch projects → the outgoing project's popup window is closed AND unregistered.
    store.getState().ensureProject('p2')
    expect(winClosed).toBe(true)
    expect(getPopupWindow('popup:1')).toBeUndefined()
    expect(store.getState().paneContainer).toEqual({}) // p2 starts clean
  })
})

// TEST-221c (ITEM-16) — reload popup-restore fires ONLY on the first project bind of a page life
// (`isReload()` is fixed for the whole lifetime, so the 2nd+ bind is an in-app nav → main-only).
describe('WorkbenchDock.store — reload restore is page-life latched (ITEM-16)', () => {
  it('a reloaded page restores popups on the first bind but not on a later in-app project switch', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    const storages = { local, session }
    // Seed BOTH projects' popups into (per-tab) sessionStorage, as a prior session would have.
    const slice = (pane: string): PopupSlice => ({
      containerLayouts: { 'popup:1': { kind: 'leaf', id: pane } },
      paneContainer: { [pane]: 'popup:1' },
      returnAnchors: {},
      cells: { [pane]: { id: pane, kind: 'launcher' } },
    })
    savePopups(storages, 'p1', slice('pane-a'))
    savePopups(storages, 'p2', slice('pane-b'))

    const store = createWorkbenchDockStore({ storages, isReload: () => true })
    // First bind of the reloaded page → restore fires (popup listed for the restore dialog).
    store.getState().ensureProject('p1')
    expect(store.getState().pendingRestore).toContain('popup:1')
    // Second bind (same page life, an in-app nav) → NO restore even though isReload() still true.
    store.getState().ensureProject('p2')
    expect(store.getState().pendingRestore).toEqual([])
    expect(store.getState().paneContainer).toEqual({})
  })
})

// TEST-225 (ITEM-18) — serialize/hydrate: single-window emits NO docking keys; docked serializes
// multi-container + paneContainer; hydrate lists popups in pendingRestore.
describe('WorkbenchDock.store — serialize / hydrate (ITEM-18)', () => {
  it('a single-window session emits no docking keys (back-compat)', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    const slice = store.getState().serialize()
    expect(slice.containerLayouts).toBeUndefined()
    expect(slice.paneContainer).toBeUndefined()
    expect(leafIds(slice.layout).length).toBe(4)
  })

  it('a docked session serializes the multi-container layout + paneContainer; hydrate → pendingRestore', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    const slice = store.getState().serialize()
    expect(slice.containerLayouts?.['popup:1']).toBeTruthy()
    expect(slice.paneContainer?.[visualize]).toBe('popup:1')

    // Hydrate on a RELOAD → the popup container is listed for the restore dialog.
    const { store: store2 } = mk()
    store2.getState().hydrate(slice, { reload: true })
    expect(store2.getState().pendingRestore).toContain('popup:1')
    // Hydrate on a non-reload → start main-only (no restore prompt).
    const { store: store3 } = mk()
    store3.getState().hydrate(slice, { reload: false })
    expect(store3.getState().pendingRestore).toEqual([])
  })
})

// TEST-231 (ITEM-41) — aim-to-place store logic.
describe('WorkbenchDock.store — aim-to-place (ITEM-41)', () => {
  it('requestAddPane with NO popup adds to main; with a popup open it defers to placement', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    // Use a kind NOT in the default IA (jobs) so it actually ADDS — requestAddPane dedups
    // by kind+ref, so a default-present kind (launcher) would just focus the existing one.
    const before = Object.keys(store.getState().cells).length
    const id = store.getState().requestAddPane('jobs')
    expect(id).not.toBe('') // added directly to main
    expect(Object.keys(store.getState().cells).length).toBe(before + 1)
    expect(store.getState().pendingPlacement).toBeNull()

    // Open a popup, then request → deferred (pendingPlacement set, returns '').
    store.getState().movePane(visualize, 'popup:1', { kind: 'root' })
    const countBefore = Object.keys(store.getState().cells).length
    const deferred = store.getState().requestAddPane('run', 'demo.leiden')
    expect(deferred).toBe('')
    expect(store.getState().pendingPlacement).toEqual({ kind: 'run', ref: 'demo.leiden' })
    expect(Object.keys(store.getState().cells).length).toBe(countBefore) // not created yet
  })

  it('placeNewPane APPENDS into a populated main (never wipes) and roots into an empty container; cancel clears', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    const mainBefore = leafIds(store.getState().layout).length
    // APPEND into a populated main.
    const newId = store.getState().placeNewPane(PRIMARY_CONTAINER, { kind: 'root' }, 'launcher')
    expect(leafIds(store.getState().layout)).toContain(newId) // existing panes preserved + new added
    expect(leafIds(store.getState().layout).length).toBe(mainBefore + 1)

    // ROOT into an empty (new) popup container.
    const popupPane = store.getState().placeNewPane('popup:2', { kind: 'root' }, 'run', 'demo.x')
    expect(store.getState().containerLayouts['popup:2']).toEqual({ kind: 'leaf', id: popupPane })
    expect(store.getState().paneContainer[popupPane]).toBe('popup:2')

    // cancel clears a pending placement.
    store.getState().movePane(visualize, 'popup:3', { kind: 'root' })
    store.getState().requestAddPane('jobs')
    expect(store.getState().pendingPlacement).not.toBeNull()
    store.getState().cancelPlacement()
    expect(store.getState().pendingPlacement).toBeNull()
  })
})

// ITEM-25 — the `result` → `artifact` pane-kind rename crosses PERSISTED state. This drives the
// REAL store over a layout blob written BEFORE the rename (both halves of the split persistence:
// the per-project MAIN blob in localStorage and the per-tab POPUP slice in sessionStorage) and
// asserts the saved pane SURVIVES the upgrade — same id, same ref, under the new kind, resolving a
// real renderer instead of the "no renderer registered" fallback.
describe('WorkbenchDock.store — a pre-rename persisted layout survives (ITEM-25)', () => {
  it('a legacy `result` pane in the persisted MAIN blob loads back as an `artifact` pane', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    // A main blob exactly as the pre-rename build wrote it (v1, `kind: 'result'`).
    local.map.set(
      'txr.wb.dock.main',
      JSON.stringify({
        v: 1,
        byProject: {
          p1: {
            layout: {
              kind: 'split',
              dir: 'col',
              sizes: [0.5, 0.5],
              children: [
                { kind: 'leaf', id: canvas },
                { kind: 'leaf', id: 'pane-7' },
              ],
            },
            cells: {
              [canvas]: { id: canvas, kind: 'canvas' },
              'pane-7': { id: 'pane-7', kind: 'result', ref: 'run::r1' },
            },
            seq: 7,
          },
        },
      }),
    )

    const store = createWorkbenchDockStore({ storages: { local, session }, isReload: () => false })
    store.getState().ensureProject('p1')
    const s = store.getState()

    // The pane is still in the tree (not silently dropped) …
    expect(leafIds(s.layout)).toContain('pane-7')
    // … and reads under the CURRENT vocabulary, with its binding ref intact.
    expect(s.cells['pane-7'].kind).toBe('artifact')
    expect(s.cells['pane-7'].ref).toBe('run::r1')
    expect(isPaneKind(s.cells['pane-7'].kind)).toBe(true)
    // Negative control — WITHOUT the migration the stored kind stays out-of-vocabulary and the
    // pane renders the visible "no renderer registered" note instead of its content.
    expect(resolvePaneRenderer('result')).toBe(FallbackPane)
    // The rest of the saved layout is untouched.
    expect(s.cells[canvas].kind).toBe('canvas')
    expect(s.seq).toBe(7)
  })

  it('a legacy `result` pane in the per-tab POPUP slice restores as an `artifact` pane', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    // The popup slice persists popped-out panes' cells VERBATIM (no transient pruning), so this is
    // the surface a pre-rename `result` pane actually survives in.
    session.map.set(
      'txr.wb.dock.popups',
      JSON.stringify({
        p1: {
          containerLayouts: { 'popup:1': { kind: 'leaf', id: 'pane-8' } },
          paneContainer: { 'pane-8': 'popup:1' },
          returnAnchors: {},
          cells: { 'pane-8': { id: 'pane-8', kind: 'result', ref: 'run::r2' } },
        },
      }),
    )

    const store = createWorkbenchDockStore({ storages: { local, session }, isReload: () => true })
    store.getState().ensureProject('p1')
    const s = store.getState()

    expect(s.pendingRestore).toContain('popup:1')
    expect(s.paneContainer['pane-8']).toBe('popup:1')
    expect(s.cells['pane-8'].kind).toBe('artifact')
    expect(s.cells['pane-8'].ref).toBe('run::r2')
    expect(isPaneKind(s.cells['pane-8'].kind)).toBe(true)
    expect(resolvePaneRenderer('result')).toBe(FallbackPane) // negative control
  })
})
