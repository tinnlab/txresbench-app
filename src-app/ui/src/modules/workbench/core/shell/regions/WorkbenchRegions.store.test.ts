import { describe, it, expect } from 'vitest'
import { createWorkbenchRegionsStore } from './WorkbenchRegions.store'
import { REGIONS_KEY, loadRegions } from './regionsPersistence'
import { memoryStorage } from '@/modules/workbench/core/shell/dock/dockPersistence'

// The region ARRANGEMENT persistence (the twin of `WorkbenchDock.store.test`'s layout persistence).
// Before this, `WorkbenchRegions.store` was a plain in-memory zustand store with NO persistence, so
// a reload reset collapse / sizes / active tab / order to the defaults even though the PANE layout
// (dock store) survived — a real UX regression from the RegionShell redesign.
//
// A "reload" is modelled the way the dock suite models it: a NEW store instance over the SAME
// storage (a page load constructs a fresh singleton and re-binds the project).
function mk(storage = memoryStorage()) {
  return { store: createWorkbenchRegionsStore({ storage }), storage }
}

describe('WorkbenchRegions.store — arrangement persistence', () => {
  it('collapse / active tab / order / region-override survive a reload (same project)', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().toggleCollapse('left')
    a.getState().setActive('right', 'pane-7')
    a.getState().setRegionOrder('right', ['pane-7', 'p-launcher'])
    a.getState().moveToRegion('p-datasets', 'bottom')
    a.getState().toggleBottomExtend('left')

    // "Reload": a fresh store over the same storage, re-bound to the same project.
    const b = mk(storage).store
    b.getState().ensureProject('p1')
    const s = b.getState()
    expect(s.collapsed.left).toBe(true)
    expect(s.active.right).toBe('pane-7')
    expect(s.activeHistory.right).toContain('pane-7')
    expect(s.order.right).toEqual(['pane-7', 'p-launcher'])
    expect(s.regionOverride['p-datasets']).toBe('bottom')
    expect(s.active.bottom).toBe('p-datasets')
    expect(s.bottomExtendLeft).toBe(true)
  })

  it('sizes survive a reload (a GLOBAL pref — applied before any project bind)', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().setLeftWidth(410)
    a.getState().setRightWidth(200)
    a.getState().setBottomHeight(320)

    const b = mk(storage).store
    // NOT project-bound: the widths are live at construction, before `ensureProject`.
    expect(b.getState().leftWidth).toBe(410)
    expect(b.getState().rightWidth).toBe(200)
    expect(b.getState().bottomHeight).toBe(320)
  })

  it('the arrangement is scoped PER PROJECT (a switch loads the other project, not a bleed)', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().toggleCollapse('left')
    a.getState().setActive('left', 'p-datasets')

    a.getState().ensureProject('p2')
    expect(a.getState().collapsed.left).toBe(false) // p2 starts from the default arrangement
    expect(a.getState().active.left).toBeNull()
    a.getState().toggleCollapse('right')

    // Back to p1 → p1's own arrangement, and p2's is not clobbered.
    a.getState().ensureProject('p1')
    expect(a.getState().collapsed.left).toBe(true)
    expect(a.getState().collapsed.right).toBe(false)
    expect(a.getState().active.left).toBe('p-datasets')
    const persisted = loadRegions(storage).byProject
    expect(persisted.p2.collapsed.right).toBe(true)
  })

  it('re-binding the SAME project is a no-op (a remount cannot clobber the live arrangement)', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().toggleCollapse('bottom')
    store.getState().ensureProject('p1')
    expect(store.getState().collapsed.bottom).toBe(true)
  })

  it('per-WINDOW state (poppedOut) + drag state are NEVER persisted and reset on a bind', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().popOut('p-datasets', 'popup:1')
    a.getState().startDrag('p-visualize')
    expect(a.getState().poppedOut['p-datasets']).toBe('popup:1')
    // Nothing per-window reached the blob…
    expect(storage.getItem(REGIONS_KEY) ?? '').not.toContain('popup:1')
    // …and a reload starts with the pane back in its region (its OS window is gone).
    const b = mk(storage).store
    b.getState().ensureProject('p1')
    expect(b.getState().poppedOut).toEqual({})
    expect(b.getState().dragPaneId).toBeNull()
  })

  it('nothing is written before a project is bound, and a corrupt blob degrades to defaults', () => {
    const storage = memoryStorage()
    const { store } = mk(storage)
    store.getState().toggleCollapse('left')
    expect(storage.getItem(REGIONS_KEY)).toBeNull()

    storage.setItem(REGIONS_KEY, '{ not json')
    const b = mk(storage).store
    b.getState().ensureProject('p1')
    expect(b.getState().collapsed.left).toBe(false)
    expect(b.getState().leftWidth).toBe(260)

    // A FUTURE blob version reads as "no data" rather than being mis-read.
    storage.setItem(REGIONS_KEY, JSON.stringify({ v: 99, byProject: { p1: { collapsed: { left: true } } } }))
    const c = mk(storage).store
    c.getState().ensureProject('p1')
    expect(c.getState().collapsed.left).toBe(false)
  })

  it('reconcilePanes drops entries for closed panes and the pruned arrangement persists', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().setActive('right', 'pane-9')
    a.getState().moveToRegion('pane-9', 'right')
    a.getState().reconcilePanes(['p-launcher'])
    expect(a.getState().active.right).toBeNull()
    expect(a.getState().regionOverride['pane-9']).toBeUndefined()

    const b = mk(storage).store
    b.getState().ensureProject('p1')
    expect(b.getState().active.right).toBeNull()
    expect(b.getState().regionOverride['pane-9']).toBeUndefined()
  })
})

// ── TEST-13 (visualize-pane ITEM-7): the per-project `sectionOrder` ─────────────────────
//
// Everything below is about WHICH BUCKET the value lives in. The section order is
// ARRANGEMENT, so it is per-project localStorage: shared across a user's tabs (reorder in
// one, get it in the next), scoped to the project, absent by default, and cleared by
// "Reset layout". The design explicitly warns against "fixing" it into sessionStorage.

describe('sectionOrder (visualize-pane ITEM-7)', () => {
  it('is ABSENT by default — so an older persisted blob needs no version bump', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    expect(a.getState().sectionOrder).toEqual({})
    // A blob written before this field existed reads back as "never dragged", not as corrupt.
    storage.setItem(
      REGIONS_KEY,
      JSON.stringify({ v: 1, byProject: { p1: { collapsed: { left: true } } } }),
    )
    const b = mk(storage).store
    b.getState().ensureProject('p1')
    expect(b.getState().sectionOrder).toEqual({})
    expect(b.getState().collapsed.left).toBe(true)
  })

  it('survives a reload, in the PER-PROJECT bucket (not the global size prefs)', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().setSectionOrder('visualize', ['sec.beta', 'sec.alpha'])

    const b = mk(storage).store
    b.getState().ensureProject('p1')
    expect(b.getState().sectionOrder.visualize).toEqual(['sec.beta', 'sec.alpha'])

    // The bucket, asserted at the storage layer rather than inferred: it is inside
    // `byProject[p1]`, and NOT among the global prefs.
    const blob = JSON.parse(storage.getItem(REGIONS_KEY) as string)
    expect(blob.byProject.p1.sectionOrder.visualize).toEqual(['sec.beta', 'sec.alpha'])
    expect(blob.prefs.sectionOrder).toBeUndefined()
  })

  it('is SCOPED to the project — a second project does not inherit it', () => {
    const storage = memoryStorage()
    const a = mk(storage).store
    a.getState().ensureProject('p1')
    a.getState().setSectionOrder('visualize', ['sec.beta'])
    a.getState().ensureProject('p2')
    expect(a.getState().sectionOrder).toEqual({})
    a.getState().ensureProject('p1')
    expect(a.getState().sectionOrder.visualize).toEqual(['sec.beta'])
  })

  it('is SPARSE per pane kind — reordering `visualize` says nothing about any other pane', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().setSectionOrder('visualize', ['sec.beta'])
    expect(Object.keys(store.getState().sectionOrder)).toEqual(['visualize'])
  })

  it('prunes ids whose section is no longer registered, and leaves a clean list alone', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().setSectionOrder('visualize', ['sec.beta', 'sec.gone', 'sec.alpha'])
    store.getState().reconcileSections('visualize', ['sec.beta', 'sec.alpha'])
    expect(store.getState().sectionOrder.visualize).toEqual(['sec.beta', 'sec.alpha'])
    // Idempotent, and identity-stable when nothing changed (so it can run on every registry pass).
    const before = store.getState().sectionOrder
    store.getState().reconcileSections('visualize', ['sec.beta', 'sec.alpha'])
    expect(store.getState().sectionOrder).toBe(before)
  })

  it('pruning a pane kind the user never dragged is a no-op, not an empty list', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().reconcileSections('visualize', ['sec.beta'])
    expect(store.getState().sectionOrder.visualize).toBeUndefined()
  })

  it('"Reset layout" clears it', () => {
    const { store } = mk()
    store.getState().ensureProject('p1')
    store.getState().setSectionOrder('visualize', ['sec.beta'])
    store.getState().reset()
    expect(store.getState().sectionOrder).toEqual({})
  })
})
