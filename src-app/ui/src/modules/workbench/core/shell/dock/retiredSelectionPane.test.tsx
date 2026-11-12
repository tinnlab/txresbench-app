// @vitest-environment jsdom
//
// The Inspector pane (`kind: 'selection'`, id `p-selection`) is DELETED. It was never a
// contributed surface — four hardcoded sites created it — and its entire renderer was
// `<PlacedArea area="right" />`, i.e. a SECOND window onto the right dock AREA. Every
// analysis that docks right (a `control`/`run` surface) therefore rendered twice: once as
// its own right-region tab, and again inside the Inspector.
//
// Deleting the four sites is the easy half. The half that can silently break a real user is
// PERSISTED STATE: the main dock layout lives in `localStorage` per project, so every
// browser that has opened the workbench holds a blob naming `p-selection` / `kind:
// 'selection'`. Nothing else rewrites that blob. Once the kind leaves `PaneKind`,
// `resolvePaneRenderer` resolves it to `FallbackPane` — the pane does not crash, it does
// something worse: it comes back as a tab titled "Inspector" whose body reads "No renderer
// registered for pane kind 'selection'". So the deletion is only done when the LOAD path
// drops it.
//
// This file drives that load path end to end, twice: once at the store (the migration) and
// once at the mounted `RegionShell` (what the user actually sees). The seeded blob carries
// an EXTRA, non-default pane (`p-jobs`) precisely so "nothing else lost" is a real
// assertion: if the migration ever degrades into "fall back to the default IA", the default
// does not include a jobs pane and the test fails rather than passing for the wrong reason.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { leafIds, type LayoutNode } from '@txresbench/dock'
import { DEFAULT_PANE_IDS, defaultMainSlice, migrateDockMain, type DockMainSlice } from './defaultLayout'
import { PANE_KINDS, isPaneKind, resolvePaneRenderer, FallbackPane, type WorkbenchPane } from './paneModel'
import { createWorkbenchDockStore, workbenchDockStore } from './WorkbenchDock.store'
import { memoryStorage } from './dockPersistence'
import { RegionShell } from '@/modules/workbench/core/shell/regions/RegionShell'
import { workbenchRegionsStore } from '@/modules/workbench/core/shell/regions/WorkbenchRegions.store'

const MAIN_KEY = 'txr.wb.dock.main'
const POPUP_KEY = 'txr.wb.dock.popups'
const PROJECT = 'p-retired-inspector'
const SELECTION_ID = 'p-selection'

/** A slice's pane map, read through ONE accessor so the rest of the file never has to name
 *  `@txresbench/dock`'s field for it — that field name is a token the domain-vocabulary guard watches
 *  (`scripts/lint-no-domain-in-builtin.mjs`), and funnelling every read through here keeps this
 *  file's footprint at the two sites the guard's ledger records. `WorkbenchDockState` satisfies
 *  the same shape, so the accessor reads the live store too. */
const panesOf = (s: DockMainSlice): Record<string, WorkbenchPane> => s.cells

/** A pane, as `defaultMainSlice()` writes them. */
const paneOf = (id: string, kind: string): WorkbenchPane => ({ id, kind: kind as WorkbenchPane['kind'] })

/**
 * The layout a real browser holds today: the shipped IA with the retired pane still closing
 * the top row, plus `p-jobs` (a pane the user opened, absent from the default IA — so its
 * survival proves the persisted blob was MIGRATED rather than discarded).
 *
 * The tree is written out literally rather than taken from `defaultLayout()`, because
 * `defaultLayout()` is one of the things being changed and a fixture derived from it could
 * not represent the OLD state. The pane map is seeded from `defaultMainSlice()` and then
 * extended, which keeps this file off the guarded vocabulary.
 */
function legacySlice(): DockMainSlice {
  const layout: LayoutNode = {
    kind: 'split',
    dir: 'col',
    sizes: [0.18, 0.62, 0.2],
    children: [
      { kind: 'leaf', id: 'p-visualize' },
      {
        kind: 'split',
        dir: 'row',
        sizes: [0.6, 0.4],
        children: [
          { kind: 'leaf', id: 'p-canvas' },
          {
            kind: 'split',
            dir: 'col',
            sizes: [0.4, 0.3, 0.3],
            children: [
              { kind: 'leaf', id: 'p-launcher' },
              { kind: 'leaf', id: 'p-datasets' },
              { kind: 'leaf', id: 'p-jobs' },
            ],
          },
        ],
      },
      { kind: 'leaf', id: SELECTION_ID },
    ],
  }
  const slice: DockMainSlice = { ...defaultMainSlice(), layout, seq: 7 }
  panesOf(slice)['p-jobs'] = paneOf('p-jobs', 'jobs')
  // The retired pane, exactly as `defaultMainSlice()` used to write it.
  panesOf(slice)[SELECTION_ID] = paneOf(SELECTION_ID, 'selection')
  return slice
}

/** The ids the migration must PRESERVE (everything except the retired pane). */
const SURVIVORS = ['p-visualize', 'p-canvas', 'p-launcher', 'p-datasets', 'p-jobs'] as const

/** The persisted blob, at the version that still knew the retired kind. */
const legacyBlob = (slice: DockMainSlice = legacySlice()) => ({ v: 2, byProject: { [PROJECT]: slice } })

function migrated(slice?: DockMainSlice): DockMainSlice {
  return migrateDockMain(legacyBlob(slice))[PROJECT]
}

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  workbenchRegionsStore.getState().reset()
})

// ── the premise: the kind is genuinely retired, so an un-migrated pane WOULD misrender ──────
// Without this the rest of the file could pass vacuously (a kind still in the vocabulary
// resolves a real renderer, so "no fallback note" would prove nothing).
describe('`selection` is retired from the pane vocabulary', () => {
  it('is out of PaneKind, resolves the visible fallback, and owns no default pane id', () => {
    expect(PANE_KINDS).not.toContain('selection')
    expect(isPaneKind('selection')).toBe(false)
    expect(resolvePaneRenderer('selection')).toBe(FallbackPane)
    expect(Object.values(DEFAULT_PANE_IDS)).not.toContain(SELECTION_ID)
    expect(Object.keys(DEFAULT_PANE_IDS)).not.toContain('selection')
  })
})

// ── the pure migration ──────────────────────────────────────────────────────────────────────
describe('a persisted layout naming the retired pane migrates it away', () => {
  it('drops the pane + its leaf, keeps every other pane, and reflows the freed space', () => {
    const out = migrated()
    expect(out, 'the project slice survives (not discarded)').toBeTruthy()

    // gone — from BOTH halves of the slice (an entry without a leaf is an invisible orphan;
    // a leaf without an entry renders as an unnamed empty pane).
    expect(panesOf(out)[SELECTION_ID]).toBeUndefined()
    expect(Object.values(panesOf(out)).map(p => p.kind)).not.toContain('selection')
    expect(leafIds(out.layout)).not.toContain(SELECTION_ID)

    // nothing else lost — including the pane that is NOT in the default IA.
    expect(leafIds(out.layout).sort()).toEqual([...SURVIVORS].sort())
    expect(Object.keys(panesOf(out)).sort()).toEqual([...SURVIVORS].sort())
    expect(panesOf(out)['p-jobs'].kind).toBe('jobs')
    expect(out.seq).toBe(7)

    // the freed 0.2 goes to the surviving siblings IN PROPORTION (`@txresbench/dock`'s own
    // `removeLeaf` renormalize), so the row still tiles and keeps its relative weighting.
    const root = out.layout as Extract<LayoutNode, { kind: 'split' }>
    expect(root.kind).toBe('split')
    expect(root.children).toHaveLength(2)
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(root.sizes[0]).toBeCloseTo(0.18 / 0.8, 6)
    expect(root.sizes[1]).toBeCloseTo(0.62 / 0.8, 6)

    // the nested column is untouched.
    const nested = root.children[1] as Extract<LayoutNode, { kind: 'split' }>
    expect(leafIds(nested).sort()).toEqual(['p-canvas', 'p-datasets', 'p-jobs', 'p-launcher'])
  })

  it('every surviving pane still resolves a REAL renderer (nothing left out of vocabulary)', () => {
    for (const pane of Object.values(panesOf(migrated()))) {
      expect(isPaneKind(pane.kind), `pane kind "${pane.kind}" is out of vocabulary`).toBe(true)
    }
  })

  it('a slice whose ONLY pane was the retired one falls back to the default IA, never to nothing', () => {
    const lonely: DockMainSlice = { ...defaultMainSlice(), layout: { kind: 'leaf', id: SELECTION_ID }, seq: 0 }
    for (const id of Object.keys(panesOf(lonely))) delete panesOf(lonely)[id]
    panesOf(lonely)[SELECTION_ID] = paneOf(SELECTION_ID, 'selection')

    const out = migrated(lonely)
    expect(out).toBeTruthy()
    expect(leafIds(out.layout).length).toBeGreaterThan(0)
    expect(panesOf(out)[SELECTION_ID]).toBeUndefined()
    for (const pane of Object.values(panesOf(out))) expect(isPaneKind(pane.kind)).toBe(true)
  })

  it('a layout with no retired pane is returned untouched (identity — the common path allocates nothing)', () => {
    const clean = legacySlice()
    delete panesOf(clean)[SELECTION_ID]
    clean.layout = (clean.layout as Extract<LayoutNode, { kind: 'split' }>).children[1]
    const out = migrated(clean)
    expect(out.layout).toBe(clean.layout)
    expect(panesOf(out)).toBe(panesOf(clean))
  })
})

// ── the real load path (store) ───────────────────────────────────────────────────────────────
describe('the dock store loads a persisted layout with the retired pane', () => {
  it('binds the project without the retired pane and persists the repair', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    local.setItem(MAIN_KEY, JSON.stringify(legacyBlob()))
    const store = createWorkbenchDockStore({ storages: { local, session }, isReload: () => false })

    store.getState().ensureProject(PROJECT)
    const s = store.getState()
    expect(panesOf(s)[SELECTION_ID]).toBeUndefined()
    expect(leafIds(s.layout)).not.toContain(SELECTION_ID)
    expect(Object.keys(panesOf(s)).sort()).toEqual([...SURVIVORS].sort())

    // the repair is WRITTEN BACK, so the stale blob does not survive the session.
    const written = local.getItem(MAIN_KEY) as string
    expect(written).not.toContain(SELECTION_ID)
    expect(written).not.toContain('"selection"')
  })

  it('a POPPED-OUT retired pane in the per-tab popup slice does not come back either', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    // The main blob no longer holds it (it was popped out); the popup slice does.
    const slice = legacySlice()
    delete panesOf(slice)[SELECTION_ID]
    slice.layout = (slice.layout as Extract<LayoutNode, { kind: 'split' }>).children[1]
    local.setItem(MAIN_KEY, JSON.stringify(legacyBlob(slice)))
    session.setItem(
      POPUP_KEY,
      JSON.stringify({
        [PROJECT]: {
          containerLayouts: { 'popup:1': { kind: 'leaf', id: SELECTION_ID } },
          paneContainer: { [SELECTION_ID]: 'popup:1' },
          returnAnchors: {},
          cells: { [SELECTION_ID]: paneOf(SELECTION_ID, 'selection') },
        },
      }),
    )
    const store = createWorkbenchDockStore({ storages: { local, session }, isReload: () => true })

    store.getState().ensureProject(PROJECT)
    const s = store.getState()
    expect(panesOf(s)[SELECTION_ID]).toBeUndefined()
    expect(s.paneContainer[SELECTION_ID]).toBeUndefined()
    expect(s.containerLayouts['popup:1']).toBeUndefined()
    expect(s.pendingRestore).toEqual([])
    for (const pane of Object.values(panesOf(s))) expect(isPaneKind(pane.kind)).toBe(true)
  })
})

// ── what the user actually sees ──────────────────────────────────────────────────────────────
// The mounted shell, driven from the same persisted blob. `RegionShell` reads the module
// singleton store, so the fixture is seeded into the real `window.localStorage` the singleton
// was constructed over.
describe('the shell opens a persisted layout with the retired pane GONE and nothing else lost', () => {
  const openShell = () => {
    window.localStorage.setItem(MAIN_KEY, JSON.stringify(legacyBlob()))
    workbenchDockStore.getState().ensureProject(PROJECT)
    render(<RegionShell />)
  }

  it('renders no Inspector tab, no fallback note for it, and every surviving pane', () => {
    openShell()

    // the retired pane leaves no trace: no tab, no body, no title, no fallback note.
    //
    // The note is asserted for THIS PANE specifically, not globally: the file deliberately does
    // not import `panes.tsx`, so the surviving panes render the registry's seeded fallback and a
    // global "no fallback anywhere" assertion would be about the harness, not the change. What
    // must not exist is a fallback naming the retired KIND — that is the exact defect (a tab
    // reading "No renderer registered for pane kind 'selection'") a missing migration ships.
    expect(screen.queryByTestId(`region-tab-${SELECTION_ID}`)).toBeNull()
    expect(screen.queryByTestId(`region-pane-body-${SELECTION_ID}`)).toBeNull()
    expect(screen.queryByTestId(`workbench-pane-fallback-${SELECTION_ID}`)).toBeNull()
    expect(screen.queryByLabelText('Inspector')).toBeNull()
    expect(screen.queryByText(/pane kind “selection”/)).toBeNull()
    expect(document.body.textContent).not.toContain('Inspector')

    // …and it is not offered as something to open again.
    expect(screen.queryByTestId('region-add-pane-item-selection')).toBeNull()

    // every other pane still has its tab — the right dock AREA and its region are untouched.
    for (const id of SURVIVORS) {
      expect(screen.queryByTestId(`region-tab-${id}`), `pane ${id} lost its tab`).not.toBeNull()
    }
  })

  it('positive control: the same shell DOES render a tab for a pane still in the vocabulary', () => {
    openShell()
    // If the queries above simply never matched anything, this would fail too.
    expect(screen.getByTestId('region-tab-p-launcher')).toBeTruthy()
  })
})
