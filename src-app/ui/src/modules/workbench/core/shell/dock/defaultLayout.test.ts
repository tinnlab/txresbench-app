import { describe, it, expect } from 'vitest'
import { leafIds } from '@ziee/dock'
import {
  defaultLayout,
  defaultMainSlice,
  DEFAULT_PANE_IDS,
  migrateDockMain,
  migratePaneCells,
  migratePaneKind,
  DOCK_MAIN_VERSION,
} from './defaultLayout'
import { isPaneKind, resolvePaneRenderer, FallbackPane } from './paneModel'

// TEST-205 (ITEM-9) — the default LayoutNode reproduces today's IA (visualize · canvas ·
// launcher · datasets) as a single-container slice with no popups. It was FIVE panes until the
// `selection` ("Inspector") pane was retired — see `retiredSelectionPane.test.tsx`.
describe('defaultLayout (ITEM-9)', () => {
  it('the default LayoutNode reproduces the IA (4 named panes, one tree, no popups)', () => {
    const l = defaultLayout()
    const ids = leafIds(l)
    expect(ids.sort()).toEqual([...Object.values(DEFAULT_PANE_IDS)].sort())
    expect(ids.length).toBe(4)
    const slice = defaultMainSlice()
    expect(Object.keys(slice.cells).sort()).toEqual(ids.sort())
    expect(slice.cells[DEFAULT_PANE_IDS.canvas].kind).toBe('canvas')
    expect(slice.seq).toBe(0)
  })

  // TEST-206 (ITEM-9) — the versioned migration upgrades a v0 blob preserving placement, and an
  // unknown/future version falls back to the default WITHOUT throwing or leaving a broken state.
  it('migrates a v0 blob preserving pane placement', () => {
    const slice = defaultMainSlice()
    const v0 = { byProject: { p1: slice } } // no `v` tag = v0
    const migrated = migrateDockMain(v0)
    expect(migrated.p1).toBeTruthy()
    expect(leafIds(migrated.p1.layout).length).toBe(4)
  })

  it('accepts the current version verbatim', () => {
    const slice = defaultMainSlice()
    const cur = { v: DOCK_MAIN_VERSION, byProject: { p1: slice } }
    expect(migrateDockMain(cur).p1).toBeTruthy()
  })

  it('an unknown/future version falls back to the default without throwing', () => {
    const slice = defaultMainSlice()
    const future = { v: 999, byProject: { p1: slice } }
    expect(() => migrateDockMain(future)).not.toThrow()
    expect(migrateDockMain(future)).toEqual({})
  })

  it('garbage / absent blobs migrate to an empty map (default IA per project)', () => {
    expect(migrateDockMain(null)).toEqual({})
    expect(migrateDockMain('nope')).toEqual({})
    expect(migrateDockMain({ v: 1 })).toEqual({})
    // a corrupt per-project slice is dropped, not thrown on.
    expect(migrateDockMain({ v: 1, byProject: { bad: { nope: true } } })).toEqual({})
  })
})

// ITEM-25 — the `result` → `artifact` pane-kind rename is a PERSISTED-STATE change: a layout
// saved before the rename carries `kind: 'result'`, which is no longer in the `PaneKind`
// vocabulary. Without a migration `resolvePaneRenderer` falls back to the visible
// "no renderer registered" note — i.e. an existing user's saved pane silently stops working.
describe('defaultLayout — legacy `result` pane kind migrates to `artifact` (ITEM-25)', () => {
  it('the legacy kind is genuinely out-of-vocabulary + renders the fallback (the thing being fixed)', () => {
    expect(isPaneKind('result')).toBe(false)
    expect(resolvePaneRenderer('result')).toBe(FallbackPane)
    // …and the target kind IS in the vocabulary.
    expect(isPaneKind('artifact')).toBe(true)
  })

  it('migratePaneKind remaps `result` → `artifact` and leaves every current kind alone', () => {
    expect(migratePaneKind('result')).toBe('artifact')
    expect(migratePaneKind('artifact')).toBe('artifact')
    expect(migratePaneKind('artifacts')).toBe('artifacts') // the plural project panel is untouched
    expect(migratePaneKind('run')).toBe('run')
  })

  it('migratePaneCells remaps only the legacy panes and preserves id/ref (identity when nothing changed)', () => {
    const cells = {
      'pane-1': { id: 'pane-1', kind: 'result' as never, ref: 'run::r1' },
      'pane-2': { id: 'pane-2', kind: 'canvas' as const },
    }
    const out = migratePaneCells(cells)
    expect(out['pane-1'].kind).toBe('artifact')
    expect(out['pane-1'].ref).toBe('run::r1')
    expect(out['pane-2']).toBe(cells['pane-2'])
    const clean = { 'pane-2': cells['pane-2'] }
    expect(migratePaneCells(clean)).toBe(clean) // no allocation on the common path
  })

  it('a PRE-RENAME persisted blob survives migrateDockMain: the pane is kept, remapped + renderable', () => {
    const slice = defaultMainSlice()
    // A v1 blob as it was written before the rename: the default IA plus a `result` pane.
    const legacy = {
      v: 1,
      byProject: {
        p1: {
          ...slice,
          layout: {
            kind: 'split',
            dir: 'col',
            sizes: [0.5, 0.5],
            children: [slice.layout, { kind: 'leaf', id: 'pane-9' }],
          },
          cells: { ...slice.cells, 'pane-9': { id: 'pane-9', kind: 'result', ref: 'run::r1' } },
          seq: 9,
        },
      },
    }
    const migrated = migrateDockMain(legacy)
    expect(migrated.p1).toBeTruthy()
    // the pane SURVIVES (not dropped) …
    expect(leafIds(migrated.p1.layout)).toContain('pane-9')
    expect(migrated.p1.cells['pane-9']).toBeTruthy()
    // … under the new vocabulary, with its `ref` intact, and it resolves a REAL renderer.
    expect(migrated.p1.cells['pane-9'].kind).toBe('artifact')
    expect(migrated.p1.cells['pane-9'].ref).toBe('run::r1')
    expect(isPaneKind(migrated.p1.cells['pane-9'].kind)).toBe(true)
    // the rest of the layout is untouched.
    expect(migrated.p1.seq).toBe(9)
    expect(migrated.p1.cells[DEFAULT_PANE_IDS.canvas].kind).toBe('canvas')
  })

  it('the version was bumped for the vocabulary change, and a v1 blob still reads', () => {
    expect(DOCK_MAIN_VERSION).toBeGreaterThanOrEqual(2)
    expect(migrateDockMain({ v: 1, byProject: { p1: defaultMainSlice() } }).p1).toBeTruthy()
  })
})
