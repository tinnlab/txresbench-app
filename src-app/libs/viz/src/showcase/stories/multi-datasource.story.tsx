// multi-datasource.story.tsx — the MULTI-DATASOURCE compare surface (ITEM-25). Renders TWO
// independent datasets (A + B) on ONE shared GridWorkspace deck: cell-1 reads the default dataset A
// (workspace props), cell-2 reads dataset B via the DatasetStore. When A + B share canonical barcodes,
// a selection published in A's canonical ids AUTO-LIGHTS the barcode-matched cells in B (DEC-M4); when
// their barcodes are disjoint, B stays dark (isolation). Two stories cover both.
//
// The story mirrors `window.__VIZ_TEST__ = { aLit, bLit, canonicalLen, ready }` so the e2e asserts the
// auto-link + isolation WITHOUT depending on GPU pixels. `aLit`/`bLit` are computed from the live
// canonical-space selection mapped through each dataset's pointIds (the same seam the render uses).

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { DEFAULT_SELECTION_SPACE } from '../../adapter/Coordination.store'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { buildIdToRow, highlightMaskForIds } from '../../viz-core/coordination/selectionSync'
import { registerStory } from '../registry'

const CANONICAL_SPACE = 'canonical'
const N = 8_000

/** Build A's barcodes (ids 0..N-1) and B's — `shared` reuses a prefix of A's barcodes (overlap);
 *  `disjoint` uses a wholly separate id range (no overlap ⇒ isolated). */
function makeBarcodes(shared: boolean): { a: Uint32Array; b: Uint32Array } {
  const a = Uint32Array.from({ length: N }, (_, i) => i)
  const b = shared
    ? Uint32Array.from({ length: N }, (_, i) => (i % 2 === 0 ? i : 1_000_000 + i)) // half overlap A
    : Uint32Array.from({ length: N }, (_, i) => 2_000_000 + i) // no overlap
  return { a, b }
}

// MD-8: distinct per-dataset tooltip labels so a hover proves the tooltip reads the HOVERED cell's
// dataset (B-* over cell-2 / A-* over cell-1), not the default dataset — and proves a datasetId cell's
// tooltip is surfaced AT ALL (pre-MD-8 it was suppressed for any datasetId cell).
const DATASET_TOOLTIP_LABELS = {
  A: { x: 'A-x', y: 'A-y' },
  B: { x: 'B-x', y: 'B-y' },
} as const

function MultiDatasourceStory({ shared, noCatalog = false }: { shared: boolean; noCatalog?: boolean }) {
  const stores = useMemo(() => createVizStores(), [])
  const { a: barcodesA, b: barcodesB } = useMemo(() => makeBarcodes(shared), [shared])
  const sourceA = useMemo(() => new FixtureSource({ seed: 1, pointCount: N, pointIds: barcodesA }), [barcodesA])
  const sourceB = useMemo(() => new FixtureSource({ seed: 2, pointCount: N, pointIds: barcodesB }), [barcodesB])

  const [catalogA, setCatalogA] = useState<DatasetCatalog | null>(null)
  const [posA, setPosA] = useState<Float32Array | null>(null)
  const [colorsA, setColorsA] = useState<Uint8Array | null>(null)
  const [ready, setReady] = useState(false)

  // Mount: load A (the default dataset via props), acquire B into the DatasetStore + pull its buffers,
  // then seed a 2-cell layout — cell-1 = default (A), cell-2 = dataset B.
  useEffect(() => {
    let alive = true
    void (async () => {
      const catA = await sourceA.catalog()
      const pA = await sourceA.positions('primary')
      const cA = await computeColoring(sourceA, DEFAULT_COLOR_BY)
      // BOTH A and B are real datasets in the DatasetStore (the multi-dataset path): provide their
      // sources so GridWorkspace's render-ref reconcile resolves them; GridWorkspace owns the refs.
      const ds = stores.datasetStore.getState()
      ds.setResolver(id => (id === 'B' ? sourceB : sourceA))
      ds.provideSource('A', sourceA)
      ds.provideSource('B', sourceB)
      if (!alive) return
      // Seed the grid: cell-1 (dataset A) | cell-2 (dataset B) — both scatter, both canonical space.
      const grid = stores.gridWorkspace.getState()
      grid.reset()
      const c2 = grid.splitCell(INITIAL_CELL_ID, 'col')
      stores.gridWorkspace.setState(s => ({
        cells: {
          ...s.cells,
          [INITIAL_CELL_ID]: { ...s.cells[INITIAL_CELL_ID], datasetId: 'A' },
          [c2]: { ...s.cells[c2], datasetId: 'B' },
        },
      }))
      setCatalogA(catA)
      setPosA(pA.positions)
      setColorsA(cA.colors)
      setReady(true)
    })().catch(err => {
      const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
      w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), setupError: String(err) }
    })
    return () => {
      alive = false
    }
  }, [sourceA, sourceB, stores])

  // Live lit-counts from the canonical-space selection, mapped through each dataset's barcodes — the
  // SAME consume seam the render uses. Subscribes to the coordination store.
  const canonical = useStore(stores.coordination, s => s.selectionBySpace[CANONICAL_SPACE]?.ids ?? null)
  useEffect(() => {
    const sel = canonical
    const aLit = sel ? highlightMaskForIds(sel, buildIdToRow(barcodesA), N).reduce((n, v) => n + v, 0) : 0
    const bLit = sel ? highlightMaskForIds(sel, buildIdToRow(barcodesB), N).reduce((n, v) => n + v, 0) : 0
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      ready: ready ? 1 : 0,
      canonicalLen: sel?.length ?? 0,
      aLit,
      bLit,
      shared: shared ? 1 : 0,
    }
  }, [canonical, barcodesA, barcodesB, ready, shared])

  // Programmatic "select a subset of A" — publishes A's first 100 barcodes to the canonical space (what
  // a lasso in cell-1 does), so the e2e is deterministic without driving a GPU lasso.
  const selectInA = () => {
    const ids = barcodesA.slice(0, 100)
    stores.coordination.getState().setSelectionInSpace(CANONICAL_SPACE, INITIAL_CELL_ID, ids)
  }
  const clearSel = () => {
    stores.coordination.getState().clearSelectionInSpace(CANONICAL_SPACE)
    stores.coordination.getState().clearSelection() // DEFAULT too
  }

  return (
    <div
      data-testid={`viz-multi-datasource${shared ? '' : '-isolated'}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <b>Multi-datasource {shared ? '(shared barcodes)' : '(disjoint barcodes)'}</b>
        <button type="button" data-testid="viz-md-select-a" onClick={selectInA}>
          Select in A
        </button>
        <button type="button" data-testid="viz-md-clear" onClick={clearSel}>
          Clear
        </button>
        <span style={{ opacity: 0.7 }}>
          {shared ? 'a selection in A auto-lights matching cells in B' : 'A and B are isolated'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready && posA && colorsA && catalogA && (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              source={sourceA}
              positions={posA}
              colors={colorsA}
              // MD-10: the `-nocatalog` variant OMITS the prop catalog so GridWorkspace must fall back to
              // the first ready dataset's catalog (effectiveCatalog) to render the content overlay.
              catalog={noCatalog ? undefined : catalogA}
              pointIds={barcodesA}
              // MD-8: per-dataset tooltip labels — hovering cell-2 (B) shows B-*, cell-1 (A) shows A-*.
              datasetTooltipLabels={DATASET_TOOLTIP_LABELS}
            />
          </VizStoresProvider>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'multi-datasource',
  category: 'Grid + resize',
  title: 'Multi-datasource — two datasets, one deck, auto-link on shared barcodes',
  covers: 'multi-datasource',
  Component: () => <MultiDatasourceStory shared />,
})

registerStory({
  id: 'multi-datasource-isolated',
  category: 'Grid + resize',
  title: 'Multi-datasource — two datasets with disjoint barcodes (isolated)',
  covers: 'multi-datasource-isolated',
  Component: () => <MultiDatasourceStory shared={false} />,
})

registerStory({
  id: 'multi-datasource-nocatalog',
  category: 'Grid + resize',
  title: 'Multi-datasource — no prop catalog (MD-10 first-ready-dataset fallback)',
  covers: 'multi-datasource-nocatalog',
  Component: () => <MultiDatasourceStory shared noCatalog />,
})
