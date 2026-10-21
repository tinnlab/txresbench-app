// annotate-linking.story.tsx (ITEM-15, P4) — image↔data linking in BOTH directions (ITEM-13),
// extending the spatial-roi pattern with the scatter→tissue RETURN leg + cross-dataset
// identity-space isolation. Everything routes through the shared `Coordination` store (no new bus):
//   • region→scatter — select a tissue region → the same cells light in the UMAP embedding.
//   • scatter→tissue — a selection ORIGINATED on the embedding side lights the tissue view's
//     consume leg (`RasterUnderlayScatterView` reads `usePointSelectionInSpace`).
//   • isolation — a second tissue view bound to a DIFFERENT identity space stays dark under a
//     default-space selection, and only lights for a selection published INTO its space.
// A headless gallery can't lasso, so deterministic buttons publish through the SAME store path.
// Authored at desktop + 390px.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { RasterUnderlayScatterView } from '../../viz-core/spatial/RasterUnderlayScatterView'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { hasAnySelection, highlightMaskForPoints } from '../../viz-core/coordination/selectionSync'
import { computeColoring } from '../../viz-core/data/engine'
import { DEFAULT_SELECTION_SPACE } from '../../adapter/Coordination.store'
import { RegionSelectFixtureSource } from './regionSelectFixture'
import { WidthKnob } from './annotateStoryKit'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
import { registerStory } from '../registry'

const GROUP_KEY = 'group'
const SPACE_B = 'dataset-b'
const TISSUE_A = 'tissue-a'
const EMBEDDING_A = 'embedding-a'

function AnnotateLinkingStory() {
  // ISOLATED store set + coordination handle, NOT the module singletons (see
  // `00-capabilities.story.tsx`). A story that writes the singleton coordination store leaves that
  // write visible to every story mounted after it in the SAME page load. The standalone chart Views
  // below default to `defaultCoordinationHandle`, so isolating the set is only half of it — each
  // View is also handed THIS set's handle. `tests/viz-e2e/story-isolation.spec.ts` walks every
  // story and fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const source = useMemo(() => new RegionSelectFixtureSource({ seed: 7, pointCount: 6000, groupCount: 6 }), [])
  const [spatialPos, setSpatialPos] = useState<Float32Array | null>(null)
  const [embeddingPos, setEmbeddingPos] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [groupCodes, setGroupCodes] = useState<Uint16Array | null>(null)
  const [categories, setCategories] = useState<readonly string[]>([])
  const [underlay, setUnderlay] = useState<{ data: Uint8Array; width: number; height: number } | null>(null)
  const [affine, setAffine] = useState<readonly [number, number, number, number, number, number]>()
  const [colorEpoch, setColorEpoch] = useState(0)

  const pointSelection = useStore(stores.coordination, s => s.pointSelection)

  useEffect(() => {
    let alive = true
    void (async () => {
      const sp = await source.positions('spatial')
      const emb = await source.positions('primary')
      const grp = await source.categorical(GROUP_KEY)
      const img = await source.imageUnderlay()
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: GROUP_KEY,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setSpatialPos(sp.positions)
      setEmbeddingPos(emb.positions)
      setGroupCodes(grp.codes)
      setCategories(grp.categories)
      setUnderlay({ data: img.data, width: img.width, height: img.height })
      setAffine(img.affine)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Clear every space on unmount so nothing bleeds into another story.
  useEffect(
    () => () => {
      const s = stores.coordination.getState()
      s.clearSelection()
      s.clearSelectionInSpace(SPACE_B)
    },
    [],
  )

  const n = embeddingPos ? embeddingPos.length / 2 : 0
  const highlightMask = useMemo(
    () => (pointSelection && n ? highlightMaskForPoints(pointSelection, n) : null),
    [pointSelection, n],
  )
  const [selEpoch, setSelEpoch] = useState(0)
  useEffect(() => setSelEpoch(e => e + 1), [pointSelection])

  const idsForGroup = (code: number): Uint32Array => {
    if (!groupCodes) return new Uint32Array(0)
    const idx: number[] = []
    for (let i = 0; i < groupCodes.length; i++) if (groupCodes[i] === code) idx.push(i)
    return Uint32Array.from(idx)
  }

  // region→scatter: publish AS the tissue view (default space) → embedding lights.
  const selectTissue = () => stores.coordination.getState().setSelection(TISSUE_A, idsForGroup(0))
  // scatter→tissue: publish AS the embedding (default space, different origin) → tissue consume-leg lights.
  const selectEmbedding = () => stores.coordination.getState().setSelection(EMBEDDING_A, idsForGroup(1))
  // isolation: publish into dataset-B's identity space → only the B view lights.
  const selectSpaceB = () => stores.coordination.getState().setSelectionInSpace(SPACE_B, 'external-b', idsForGroup(2))
  const clearAll = () => {
    const s = stores.coordination.getState()
    s.clearSelection()
    s.clearSelectionInSpace(SPACE_B)
  }

  const ready = spatialPos && embeddingPos && colors && groupCodes && underlay

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-annotate-linking"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
          <button type="button" data-testid="annotate-linking-tissue" onClick={selectTissue} disabled={!ready}>
            Select tissue region → embedding
          </button>
          <button type="button" data-testid="annotate-linking-embedding" onClick={selectEmbedding} disabled={!ready}>
            Select embedding cluster → tissue
          </button>
          <button type="button" data-testid="annotate-linking-spaceb" onClick={selectSpaceB} disabled={!ready}>
            Select in dataset B (isolated)
          </button>
          <button type="button" data-testid="annotate-linking-clear" onClick={clearAll}>
            Clear
          </button>
          <span data-testid="annotate-linking-readout" style={{ opacity: 0.7 }}>
            shared selection: {(pointSelection?.length ?? 0).toLocaleString()} cells
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <WidthKnob testId="annotate-linking">
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexWrap: 'wrap' }}>
              {/* Tissue A — publishes (region→scatter) AND consumes (scatter→tissue) on the DEFAULT space. */}
              <div data-testid="annotate-linking-tissue-a" style={{ flex: '1 1 300px', minWidth: 240, borderRight: '1px solid rgba(128,128,128,0.3)' }}>
                {ready ? (
                  <RasterUnderlayScatterView
                    coordination={coordination}
                    positions={spatialPos}
                    colors={colors}
                    totalPoints={n}
                    underlay={underlay}
                    affine={affine}
                    groupCodes={groupCodes}
                    categories={categories}
                    colorEpoch={colorEpoch}
                    sourceId={TISSUE_A}
                    selectionSpace={DEFAULT_SELECTION_SPACE}
                  />
                ) : (
                  <div style={{ padding: 16 }}>Loading fixture…</div>
                )}
              </div>
              {/* Embedding — reads the shared default-space selection (region→scatter target). */}
              <div data-testid="annotate-linking-embedding-view" style={{ flex: '1 1 300px', minWidth: 240, position: 'relative', borderRight: '1px solid rgba(128,128,128,0.3)' }}>
                {ready ? (
                  <DeckScatterCanvas
                    positions={embeddingPos}
                    colors={colors}
                    radius={3}
                    colorEpoch={colorEpoch}
                    highlightMask={highlightMask}
                    selectionActive={hasAnySelection(pointSelection)}
                    selectionEpoch={selEpoch}
                  />
                ) : (
                  <div style={{ padding: 16 }}>Loading fixture…</div>
                )}
              </div>
              {/* Tissue B — bound to a DIFFERENT identity space: stays dark under a default-space
                  selection, lights only for a selection published INTO dataset-B's space. */}
              <div data-testid="annotate-linking-tissue-b" style={{ flex: '1 1 300px', minWidth: 240 }}>
                {ready ? (
                  <RasterUnderlayScatterView
                    coordination={coordination}
                    positions={spatialPos}
                    colors={colors}
                    totalPoints={n}
                    underlay={underlay}
                    affine={affine}
                    groupCodes={groupCodes}
                    categories={categories}
                    colorEpoch={colorEpoch}
                    sourceId="tissue-b"
                    selectionSpace={SPACE_B}
                  />
                ) : (
                  <div style={{ padding: 16 }}>Loading fixture…</div>
                )}
              </div>
            </div>
          </WidthKnob>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'annotate-linking',
  category: 'Selection',
  title: 'Annotate linking — region↔scatter (both legs) + cross-dataset identity-space isolation',
  covers: 'annotate-linking',
  Component: AnnotateLinkingStory,
})
