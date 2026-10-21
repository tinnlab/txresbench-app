// datasetStoreColoring.test.ts — TEST-10 (ITEM-6): `DatasetStore.ensureBuffers` must not paint a
// whole dataset BLACK by guessing a column name.
//
// ── The defect this exists to keep dead ──────────────────────────────────────────────────────
//
// `ensureBuffers` built its base colour buffer from `computeColoring(src, DEFAULT_COLOR_BY)`, and
// `DEFAULT_COLOR_BY` names the literal column `'group'` — a hardcoded GUESS at another module's
// vocabulary. `'group'` is what the in-package fixtures call their grouping column; a real host
// source addresses columns by artifact id and has no such column at all.
//
// The call was wrapped in a `catch` that fell back to neutral gray, and that catch made the bug
// LOOK handled. It is not, because a source without the column answers in TWO ways:
//
//   • it THROWS (a host source rejecting a key it cannot address) → caught → neutral. Fine.
//   • it returns ONE SYNTHETIC UNGROUPED CATEGORY — the frame-backed canvas source does exactly
//     this, deliberately, because "group these rows by nothing" is a real answer. No throw, so the
//     catch never fires. That single synthetic category takes palette slot 0, and slot 0 of
//     Okabe-Ito is [0,0,0]: every point in the dataset painted BLACK, under a legend claiming a
//     category called "All". Silent, confident, wrong — and invisible on a dark theme.
//
// The identical call in `useGridData.pullOwnedData` was given a catalog-membership guard; this one,
// the MULTI-DATASET sibling, was left unguarded. This file drives the REAL store (acquire →
// ensureBuffers) against a fake `DataSource` of exactly that ungrouped shape, so it exercises the
// production path rather than a re-implementation of it.

import { describe, it, expect, vi } from 'vitest'
import { createDatasetStore, NEUTRAL_GRAY } from './DatasetStore'
import type {
  CategoricalColumn,
  DataSource,
  DatasetCatalog,
  Positions,
} from '../viz-core/data/wire'

function catalogWith(over: Partial<DatasetCatalog> = {}): DatasetCatalog {
  return {
    datasetId: 'ds',
    pointCount: 3,
    layouts: [{ id: 'emb', kind: 'layout', label: 'Embedding' }],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
    ...over,
  }
}

const POSITIONS = new Float32Array([0, 0, 1, 1, 2, 2]) // 3 points

/**
 * A `DataSource` in the shape of the frame-backed canvas source: an UNKNOWN categorical key is not
 * an error, it is ONE group over every row. It also RECORDS which keys it was asked for, so
 * "never asked" is assertable rather than inferred.
 */
function ungroupedSource(catalog: DatasetCatalog): DataSource & { categoricalCalls: string[] } {
  const categoricalCalls: string[] = []
  const src: Partial<DataSource> & { categoricalCalls: string[] } = {
    categoricalCalls,
    catalog: vi.fn(async () => catalog),
    positions: vi.fn(async (): Promise<Positions> => ({ positions: POSITIONS, length: 3 }) as Positions),
    categorical: vi.fn(async (key: string): Promise<CategoricalColumn> => {
      categoricalCalls.push(key)
      // The whole point: NO THROW. One synthetic ungrouped category over every row.
      return { codes: new Uint16Array(3), categories: ['All'], length: 3 } as CategoricalColumn
    }),
    continuous: vi.fn(async () => {
      throw new Error('no continuous columns')
    }),
    valueColumn: vi.fn(async () => {
      throw new Error('no value columns')
    }),
  }
  return src as DataSource & { categoricalCalls: string[] }
}

describe('DatasetStore.ensureBuffers — the default coloring never guesses a column name', () => {
  it('a dataset with NO default color-by column gets NEUTRAL gray, and is never asked for it', async () => {
    const source = ungroupedSource(
      catalogWith({
        // Real columns — just not one called `group`. This is the ordinary host dataset.
        continuousColumns: [{ id: 'a1#values', kind: 'continuous', label: 'total_counts' }],
      }),
    )
    const store = createDatasetStore()
    await store.getState().acquire('ds', source)
    await store.getState().ensureBuffers('ds', 'emb')

    const colors = store.getState().getEntry('ds')!.colors!
    expect(colors, 'ensureBuffers must produce a full-length RGBA buffer').toHaveLength(3 * 4)

    // Every point, not just the first — the failure was uniform, so the assertion must be too.
    for (let i = 0; i < 3; i++) {
      expect(
        Array.from(colors.slice(i * 4, i * 4 + 4)),
        'a dataset with no grouping column must not be painted palette-slot-0 black',
      ).toEqual([...NEUTRAL_GRAY])
    }

    // The direct statement of the defect, independent of what "neutral" happens to be: whatever one
    // colour the whole dataset ends up, it must not be BLACK.
    expect(Array.from(colors.slice(0, 3))).not.toEqual([0, 0, 0])

    expect(
      source.categoricalCalls,
      'the catalog cannot serve the default key, so the source is never asked for it',
    ).toEqual([])
  })

  it('a dataset that DOES publish the default column is still coloured by it (the control)', async () => {
    // This is what stops the fix degenerating into "never colour anything": a source that genuinely
    // publishes `group` must go down the unchanged colouring path.
    const source = ungroupedSource(
      catalogWith({ categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }] }),
    )
    const store = createDatasetStore()
    await store.getState().acquire('ds', source)
    await store.getState().ensureBuffers('ds', 'emb')

    expect(source.categoricalCalls).toEqual(['group'])
    // A real single-category column still gets its palette colour — this fix narrows WHEN the
    // default colouring runs, never what `categoricalColors` does once it does.
    expect(Array.from(store.getState().getEntry('ds')!.colors!.slice(0, 4))).toEqual([0, 0, 0, 255])
  })

  it('a colouring that THROWS still degrades to neutral (the pre-existing best-effort contract)', async () => {
    // An advertised column can still fail to READ. That half of the guard is load-bearing and must
    // survive: the read failure must not reject the pull or error the entry.
    const source = ungroupedSource(
      catalogWith({ categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }] }),
    )
    source.categorical = vi.fn(async () => {
      throw new Error('group: 7 bytes are not u16-aligned')
    }) as DataSource['categorical']

    const store = createDatasetStore()
    await store.getState().acquire('ds', source)
    await store.getState().ensureBuffers('ds', 'emb')

    const entry = store.getState().getEntry('ds')!
    expect(entry.status).toBe('ready')
    expect(Array.from(entry.colors!.slice(0, 4))).toEqual([...NEUTRAL_GRAY])
    expect(entry.positionsByLayout.emb).toHaveLength(6)
  })
})
