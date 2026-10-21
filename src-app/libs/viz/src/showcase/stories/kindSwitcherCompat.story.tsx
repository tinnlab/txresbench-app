// kindSwitcherCompat.story.tsx — the DATA-SHAPE-AWARE kind-switcher story. A single cell bound to a
// `group`+`value` shape (a violin) with EXPLICIT bindings. The per-cell chrome `<select>` (testid
// `viz-cell-kind-cell-1`) is populated from `compatibleChartTypes(catalog, kind)`, so it offers ONLY
// the types that fit the data (violin / box / bar / dotplot / heatmap) — NOT the dense (scatter /
// image) or nested (grid) kinds, nor a candlestick (needs OHLC continuous columns the shape lacks).
//
// The story mirrors the current cell's `kind` + resolved `bindings` onto `window.__VIZ_TEST__` so the
// e2e can assert that switching violin→box PRESERVES the bound value/group columns (the data-shape-
// aware preserve in `setCellKind`), not just that a control's value flipped.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { createVizStores, VizStoresProvider, type VizStores } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** The value column the seeded violin binds — deliberately NOT the first ('Feature A', the catalog
 *  default) so a preserved binding is DISTINGUISHABLE from a default re-resolution after a switch. */
const SEED_VALUE = 'Feature B'
const SEED_GROUP = 'group'

/** Seed a single violin cell with EXPLICIT bindings (so the preserve path has something to keep). */
function seedViolinCell(stores: VizStores) {
  const s = stores.gridWorkspace.getState()
  s.reset() // → cell-1 (scatter)
  stores.gridWorkspace.setState(prev => ({
    cells: {
      ...prev.cells,
      [INITIAL_CELL_ID]: {
        ...prev.cells[INITIAL_CELL_ID],
        kind: 'violin',
        bindings: { value: SEED_VALUE, group: SEED_GROUP },
      },
    },
  }))
}

function KindSwitcherCompatStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // seeds grid cells (and, where present, drives the shared selection); on the singletons those
  // writes are process-global and every story mounted later in the SAME page load inherits them.
  // `tests/viz-e2e/story-isolation.spec.ts` is the walk that measures it.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 11, pointCount: 20_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  const cell = useStore(stores.gridWorkspace, s => s.cells[INITIAL_CELL_ID])

  // ── Minimal e2e observation hook (additive, no product effect) ──────────────
  // Mirror the current cell's kind + resolved bindings so the switch-preserve spec can assert the
  // bound value/group survived a violin→box switch (not merely that the <select> value changed).
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      cellKind: cell?.kind ?? null,
      cellBindings: cell?.bindings ?? null,
    }
  }, [cell?.kind, cell?.bindings])

  // Load the fixture once (catalog drives the compatible-types set + chart bindings).
  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const c = await computeColoring(source, DEFAULT_COLOR_BY)
      if (!alive) return
      // Present a TABULAR shape (drop the embedding + image): the switcher is data-driven, so with
      // NO spatial substrate the dense scatter/image views are (correctly) NOT offered — this is
      // the scenario where the group×value restriction is meaningful. (A dataset WITH an embedding
      // would legitimately also offer scatter/image — cross-family, since the data supports both.)
      setCatalog({ ...cat, layouts: [], hasImage: false })
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Seed the single violin cell on mount.
  useEffect(() => {
    seedViolinCell(stores)
  }, [])

  return (
    <div
      data-testid="viz-kind-switcher-compat"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: '8px 12px', fontSize: 12, opacity: 0.7 }}>
        A single <strong>group×value</strong> cell (violin). Open its chrome kind switcher (top-right
        ▾): it offers only the COMPATIBLE chart types — violin / box / bar / dotplot / heatmap — never
        the dense scatter/image, the nested grid, or a candlestick. Switch violin→box and the bound
        value ({SEED_VALUE}) + group ({SEED_GROUP}) columns are PRESERVED.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors && catalog ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              colorEpoch={colorEpoch}
              source={source}
              catalog={catalog}
            />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'kind-switcher-compat',
  category: 'Grid + resize',
  title: 'Grid — data-shape-aware kind switcher (compatible types only + preserve on switch)',
  covers: 'kind-switcher-compat',
  Component: KindSwitcherCompatStory,
})
