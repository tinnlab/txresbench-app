// Unit coverage for the legacy viz-state migration (ITEM-59). Replaces the removed
// `layout-migration` e2e, which drove the same logic through the now-removed TopToolbar's
// plot-type controls. `migrateLegacyVizState` lifts a saved plotType/plotLayout
// out of the legacy `txr.wb.layout` persist blob so it survives the relocation into the viz store.
// Runs under the app's node:test idiom (`npm run test:unit:node` globs `builtins/**`), like the
// sibling `builtins/*/extension.test.ts`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  migrateLegacyVizState,
  migrateVizStateKeys,
  DEFAULT_PLOT_TYPE,
  LEGACY_PROJECTION_KEY,
} from './vizState.store.ts'

test('migrateLegacyVizState lifts plotType + split layout per project (persist-wrapped)', () => {
  const legacy = {
    state: {
      byProject: {
        p1: { colorBy: 'leiden', plotType: 'violin', plotLayout: 'split', [LEGACY_PROJECTION_KEY]: 'umap' },
      },
    },
  }
  assert.deepStrictEqual(migrateLegacyVizState(legacy), {
    p1: { plotType: 'violin', plotLayout: 'split', activeProjection: 'umap' },
  })
})

test('migrateLegacyVizState accepts an unwrapped blob + defaults a missing plotType/projection', () => {
  // `colorBy` was REMOVED as a field, but a blob written before that removal can carry it and
  // nothing else recognisable. It must still be detected as a viz slice and migrated — skipping
  // it would silently reset the project's viz state to defaults — while the retired key itself
  // is not carried into the result. This is the regression test for `'colorBy' in s` surviving
  // in `hasVizField`.
  assert.deepStrictEqual(migrateLegacyVizState({ byProject: { p2: { colorBy: 'sample' } } }), {
    p2: { activeProjection: null, plotType: DEFAULT_PLOT_TYPE, plotLayout: 'single' },
  })
})

test('migrateVizStateKeys renames the persisted projection key without clobbering the new one', () => {
  assert.deepStrictEqual(migrateVizStateKeys({ p1: { [LEGACY_PROJECTION_KEY]: 'umap', plotType: 'violin' } }), {
    p1: { activeProjection: 'umap', plotType: 'violin' },
  })
  assert.deepStrictEqual(
    migrateVizStateKeys({ p1: { activeProjection: 'kept', [LEGACY_PROJECTION_KEY]: 'stale' } }),
    { p1: { activeProjection: 'kept' } },
  )
})

test('migrateLegacyVizState SKIPS a pure dock-chrome slice that carried no viz field', () => {
  const legacy = { state: { byProject: { p3: { layout: { kind: 'leaf' }, cells: {} } } } }
  assert.deepStrictEqual(migrateLegacyVizState(legacy), {})
})

test('migrateLegacyVizState returns {} for a malformed blob (never throws)', () => {
  assert.deepStrictEqual(migrateLegacyVizState(null), {})
  assert.deepStrictEqual(migrateLegacyVizState('nope'), {})
  assert.deepStrictEqual(migrateLegacyVizState({ state: {} }), {})
  assert.deepStrictEqual(migrateLegacyVizState({ byProject: 'bad' }), {})
})
