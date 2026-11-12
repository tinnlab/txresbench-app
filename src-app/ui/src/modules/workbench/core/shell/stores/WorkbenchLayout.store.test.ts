// TEST-525 (ITEM-59) — the per-project viz state (activeProjection/plotType/plotLayout)
// moved OFF the shell `ProjectLayout`/`WorkbenchLayout.store` into the extension-owned viz
// store. A user upgrading from the pre-ITEM-59 build has these fields inside the legacy
// `txr.wb.layout` blob; the one-time `migrateLegacyVizState` lifts them out WITHOUT
// dropping `plotType`. Pure → the node runner (no localStorage needed).
//
// WS-D (finding C5) — `activeProjection` was previously persisted under a domain-flavoured
// field name (`LEGACY_PROJECTION_KEY`). `migrateVizStateKeys` upgrades an ALREADY-persisted
// `txr.wb.viz` blob to the new key, so the rename does not silently drop a saved selection.

import { describe, expect, it } from 'vitest'
import {
  LEGACY_LAYOUT_KEY,
  LEGACY_PROJECTION_KEY,
  VIZ_STATE_KEY,
  createVizStateStore,
  migrateLegacyVizState,
  migrateVizStateKeys,
} from '@/modules/workbench/extensions/canvas/vizState.store'

describe('legacy viz-state migration (TEST-525 / ITEM-59)', () => {
  it('lifts activeProjection/plotType/plotLayout out of the legacy txr.wb.layout blob', () => {
    const legacy = {
      state: {
        byProject: {
          'proj-1': {
            left: { collapsed: false, size: 18 },
            activeTab: {},
            colorBy: 'leiden',
            [LEGACY_PROJECTION_KEY]: 'emb-9',
            plotType: 'violin',
            plotLayout: 'split',
          },
          'proj-2': {
            left: { collapsed: false, size: 18 },
            activeTab: {},
            colorBy: 'CD3D',
            plotType: 'scatter',
          },
        },
      },
      version: 0,
    }
    const migrated = migrateLegacyVizState(legacy)
    expect(migrated['proj-1']).toEqual({
      activeProjection: 'emb-9',
      plotType: 'violin',
      plotLayout: 'split',
    })
    // A slice whose ONLY recognisable viz field is the retired `colorBy` is still a viz
    // slice: it must be migrated, not skipped, and its siblings must survive. `colorBy`
    // itself is gone from the shape — this is the detector's regression test, and it is why
    // `'colorBy' in s` stays in `hasVizField`.
    expect(migrated['proj-2']).not.toHaveProperty('colorBy')
    expect(migrated['proj-2'].plotType).toBe('scatter')
    expect(migrated['proj-2'].plotLayout).toBe('single') // default fill
    expect(migrated['proj-2'].activeProjection).toBeNull()
  })

  it('a slice whose ONLY viz field is the RETIRED colorBy is still migrated, not skipped', () => {
    // The counterpart to the skip case below, and the reason `'colorBy' in s` survives in
    // `hasVizField` after the field itself was removed. A blob written before the removal can
    // carry `colorBy` and nothing else recognisable; if the detector stopped counting it, that
    // slice would be treated as pure dock chrome and skipped, silently resetting the project's
    // viz state to defaults instead of migrating it. The retired key is not read into the
    // result — it is only evidence that this slice belonged to viz.
    const legacy = { state: { byProject: { p: { left: { collapsed: false, size: 18 }, colorBy: 'leiden' } } } }
    const migrated = migrateLegacyVizState(legacy)
    expect(Object.keys(migrated), 'the slice must not be skipped').toEqual(['p'])
    expect(migrated.p).not.toHaveProperty('colorBy')
    expect(migrated.p.plotLayout).toBe('single')
  })

  it('a pure dock-chrome slice (no viz fields) is skipped — nothing to migrate', () => {
    const legacy = { state: { byProject: { 'proj-3': { left: { collapsed: false, size: 18 }, activeTab: {} } } } }
    expect(migrateLegacyVizState(legacy)).toEqual({})
  })

  it('accepts a bare { byProject } shape (not only the persist wrapper)', () => {
    const migrated = migrateLegacyVizState({ byProject: { p: { colorBy: 'x', plotType: 'heatmap', activeTab: {} } } })
    expect(migrated.p).not.toHaveProperty('colorBy')
    expect(migrated.p.plotType).toBe('heatmap')
  })

  it('a malformed blob yields an empty map (never throws)', () => {
    expect(migrateLegacyVizState(null)).toEqual({})
    expect(migrateLegacyVizState({})).toEqual({})
    expect(migrateLegacyVizState('nope')).toEqual({})
  })

  it('lifts a legacy slice that carried ONLY the pre-rename projection key', () => {
    const migrated = migrateLegacyVizState({ byProject: { p: { [LEGACY_PROJECTION_KEY]: 'emb-3' } } })
    expect(migrated.p.activeProjection).toBe('emb-3')
  })
})

// ── WS-D (finding C5) — the projection field-RENAME migration ────────────────

describe('persisted viz-state key rename (WS-D / C5)', () => {
  it('upgrades an already-persisted slice from the pre-rename key to activeProjection', () => {
    const upgraded = migrateVizStateKeys({
      'proj-1': {
        colorBy: 'leiden',
        [LEGACY_PROJECTION_KEY]: 'emb-9',
        plotType: 'violin',
        plotLayout: 'split',
      },
    })
    expect(upgraded['proj-1']).toEqual({
      colorBy: 'leiden',
      activeProjection: 'emb-9',
      plotType: 'violin',
      plotLayout: 'split',
    })
    // the old key is GONE (not left behind to be re-read on the next load).
    expect(LEGACY_PROJECTION_KEY in upgraded['proj-1']).toBe(false)
  })

  it('does NOT clobber a slice that already carries the new key', () => {
    // A slice already on the new key wins outright — even when a stale legacy key
    // sits next to it (the new key is authoritative, including an explicit null).
    const upgraded = migrateVizStateKeys({
      'proj-1': { activeProjection: 'new-emb', [LEGACY_PROJECTION_KEY]: 'stale-emb' },
      'proj-2': { activeProjection: null, [LEGACY_PROJECTION_KEY]: 'stale-emb' },
      'proj-3': { activeProjection: 'kept', colorBy: 'x' },
    })
    expect(upgraded['proj-1'].activeProjection).toBe('new-emb')
    expect(upgraded['proj-2'].activeProjection).toBeNull()
    expect(upgraded['proj-3']).toEqual({ activeProjection: 'kept', colorBy: 'x' })
  })

  it('is idempotent and preserves sibling fields; a malformed map never throws', () => {
    const once = migrateVizStateKeys({ p: { [LEGACY_PROJECTION_KEY]: 'e', plotType: 'violin' } })
    expect(migrateVizStateKeys(once)).toEqual(once)
    expect(once.p.plotType).toBe('violin')
    expect(migrateVizStateKeys(null)).toEqual({})
    expect(migrateVizStateKeys('nope')).toEqual({})
    expect(migrateVizStateKeys({ p: null })).toEqual({})
  })

  it('END-TO-END: a persisted blob on the OLD key survives a real store load', () => {
    // The regression this migration exists to stop: `loadBlob` short-circuits on the
    // `_migrated` latch, so a bare rename would return the stored map verbatim and the
    // user's saved selection would read back as `null`.
    const mem = new Map<string, string>([
      [
        VIZ_STATE_KEY,
        JSON.stringify({
          _migrated: true,
          byProject: {
            'proj-1': { colorBy: 'leiden', [LEGACY_PROJECTION_KEY]: 'emb-9', plotType: 'violin', plotLayout: 'split' },
          },
        }),
      ],
    ])
    const kv = {
      read: (k: string) => mem.get(k) ?? null,
      write: (k: string, v: string) => {
        mem.set(k, v)
      },
    }

    const store = createVizStateStore({ kv })
    store.getState().ensureProject('proj-1')
    expect(store.getState().current()).toEqual({
      colorBy: 'leiden',
      activeProjection: 'emb-9',
      plotType: 'violin',
      plotLayout: 'split',
    })

    // ...and the upgraded shape is written straight back, so the next load needs no repair.
    const persisted = JSON.parse(mem.get(VIZ_STATE_KEY) as string)
    expect(persisted.byProject['proj-1'].activeProjection).toBe('emb-9')
    expect(LEGACY_PROJECTION_KEY in persisted.byProject['proj-1']).toBe(false)
  })

  it('END-TO-END: a PRE-ITEM-59 blob on the OLD key still lifts into the new key', () => {
    // The other persisted surface: a user who never booted an ITEM-59 build has the
    // field inside `txr.wb.layout`. The lift + the rename compose in one pass.
    const mem = new Map<string, string>([
      [
        LEGACY_LAYOUT_KEY,
        JSON.stringify({
          state: { byProject: { 'proj-1': { activeTab: {}, colorBy: 'leiden', [LEGACY_PROJECTION_KEY]: 'emb-9' } } },
          version: 0,
        }),
      ],
    ])
    const kv = {
      read: (k: string) => mem.get(k) ?? null,
      write: (k: string, v: string) => {
        mem.set(k, v)
      },
    }

    const store = createVizStateStore({ kv })
    store.getState().ensureProject('proj-1')
    expect(store.getState().current().activeProjection).toBe('emb-9')
  })
})
