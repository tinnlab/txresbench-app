// violin-linked.story.tsx — the VIOLIN as a first-class, fully-synced SELECTION surface
// (DEC-25 / ITEM-25). A GPU scatter (left) and a `ViolinView` (right) share ONE
// `useCoordinationStore`, ONE `FixtureSource`, and therefore ONE dense-point index space:
//
//   • scatter → violin: selecting in the scatter writes `pointSelection`; the violin emphasises
//     the matching DOTS (per-cell) + GROUP bodies (KDE/box), dimming the rest.
//   • violin → scatter: a value-BAND brush or a LASSO in the violin writes `pointSelection`
//     (`setSelection('violin', idx)`); the scatter emphasises those exact points.
//
// A headless render harness can't drag a lasso, so two deterministic SEED affordances stand in
// for the two directions (mirroring selectionSync.story): "Select group 0 (scatter)" seeds the
// scatter→violin direction, "Band-select group 1 (violin)" runs the pure `cellsInGroupValueBand`
// producer to seed the violin→scatter direction — both write straight into the store so the
// fan-out fires with no pointer interaction. The `viz-violin-mode-*` toggle + draw overlay
// (from ViolinView) remain for the orchestrator's real-GPU cross-view e2e.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import { ViolinView } from '../../viz-core/charts/ViolinView'
import { fitViewState } from '../../viz-core/charts/ChartCanvas'
import { cellsInGroupValueBand } from '../../viz-core/charts/violinJitter'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { densify } from '../../viz-core/data/wire'
import { boundsForPositions } from '../../viz-core/density/densityBin'
import {
  buildGroupIndex,
  DIM_OPACITY,
  hasAnySelection,
  highlightMaskForPoints,
  selectedGroupCodes,
} from '../../viz-core/coordination/selectionSync'
import { createVizStores, useCoordination, VizStoresProvider } from '../../adapter/vizStores'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
import { registerStory } from '../registry'

/** Coordination cell ids the two producer directions ORIGINATE from. */
const SCATTER_SOURCE = 'violin-linked-scatter'
const VIOLIN_SOURCE = 'violin'
const GROUP_KEY = 'group'
const VALUE_KEY = 'Feature A'

/** A store-CONSUMING GPU scatter: dims the base + redraws selected points at full opacity via a
 *  `DataFilterExtension` mask (the same idiom as SelectableScatter's highlight). Reader-only. */
function LinkedScatter({
  positions,
  colors,
  totalPoints,
}: {
  positions: Float32Array
  colors: Uint8Array
  totalPoints: number
}) {
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const initialViewState = useMemo<OrthographicViewState>(() => {
    const b = boundsForPositions(positions)
    return fitViewState([b.minX, b.minY, b.maxX, b.maxY], 600, 600, 0.12, true)
  }, [positions])
  const [viewState, setViewState] = useState<OrthographicViewState>(initialViewState)

  // Reads the ACTIVE store set from context — this component is rendered under the story's own
  // `<VizStoresProvider>`, so it resolves that set rather than the module singleton.
  const pointSelection = useCoordination(s => s.pointSelection)
  const active = hasAnySelection(pointSelection)
  const mask = useMemo(
    () => (active ? highlightMaskForPoints(pointSelection!, totalPoints) : null),
    [active, pointSelection, totalPoints],
  )
  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])

  const layers = useMemo(() => {
    const out: unknown[] = [
      new ScatterplotLayer({
        id: 'violin-linked-scatter-base',
        data: {
          length: totalPoints,
          attributes: {
            getPosition: { value: positions, size: 2 },
            getFillColor: { value: colors, size: 4, normalized: true },
          },
        },
        radiusUnits: 'pixels',
        getRadius: 2,
        radiusMinPixels: 1,
        radiusMaxPixels: 6,
        stroked: false,
        filled: true,
        opacity: active ? DIM_OPACITY : 1,
        pickable: false,
      }),
    ]
    if (mask) {
      out.push(
        new ScatterplotLayer({
          id: 'violin-linked-scatter-highlight',
          data: {
            length: totalPoints,
            attributes: {
              getPosition: { value: positions, size: 2 },
              getFillColor: { value: colors, size: 4, normalized: true },
              getFilterValue: { value: mask, size: 1 },
            },
          },
          radiusUnits: 'pixels',
          getRadius: 3,
          radiusMinPixels: 2,
          radiusMaxPixels: 8,
          stroked: false,
          filled: true,
          opacity: 1,
          pickable: false,
          extensions: [filterExt],
          filterRange: [1, 1],
          updateTriggers: { getFilterValue: mask },
        }),
      )
    }
    return out
  }, [positions, colors, totalPoints, active, mask, filterExt])

  return (
    // `position:'relative'` is REQUIRED: DeckGL's container is `position:absolute` (see
    // @deck.gl/react extract-styles), so without a positioned ancestor its `deckgl-overlay`
    // canvas anchors to the viewport (1400×950) — covering the toolbar and eating its clicks.
    // Constraining it to THIS panel (matching ChartCanvas's own relative wrapper) confines the
    // canvas to the scatter pane so the toolbar stays the top element at its own coordinates.
    <div
      data-testid="viz-violin-linked-scatter"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <DeckGL
        views={view}
        controller
        viewState={viewState as never}
        onViewStateChange={((p: { viewState: OrthographicViewState }) => setViewState(p.viewState)) as never}
        layers={layers as never}
      />
    </div>
  )
}

function ViolinLinkedStory() {
  // ISOLATED store set + coordination handle, NOT the module singletons (see
  // `00-capabilities.story.tsx`). A story that writes the singleton coordination store leaves that
  // write visible to every story mounted after it in the SAME page load. The standalone chart Views
  // below default to `defaultCoordinationHandle`, so isolating the set is only half of it — each
  // View is also handed THIS set's handle. `tests/viz-e2e/story-isolation.spec.ts` walks every
  // story and fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 8_000, groupCount: 6 }), [])
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [groupCodes, setGroupCodes] = useState<Uint16Array | null>(null)
  const [values, setValues] = useState<Float32Array | null>(null)
  const [nGroups, setNGroups] = useState(0)

  const pointSelection = useStore(stores.coordination, s => s.pointSelection)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const grp = await source.categorical(GROUP_KEY)
      const col = await source.valueColumn(VALUE_KEY)
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: GROUP_KEY,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setPositions(pos.positions)
      setGroupCodes(grp.codes)
      setValues(densify(col))
      setNGroups(grp.categories.length)
      setColors(c.colors)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Clear on unmount. With the isolated set above this is no longer CROSS-STORY hygiene (the set
  // dies with the story); it just resets this story's own state between its StrictMode mounts.
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  // Derived readouts for the visible UI + the test hooks. `violinSelectedDots` = the count of
  // emphasised dots (every selected in-range cell IS an emphasised dot); `violinSelectedGroups`
  // = the distinct group codes those dots cover (the group bodies that light up).
  const selectionLength = pointSelection?.length ?? 0
  const selectedGroups = useMemo(
    () => (pointSelection && groupCodes ? selectedGroupCodes(pointSelection, groupCodes) : new Set<number>()),
    [pointSelection, groupCodes],
  )
  const selectedDots = useMemo(() => {
    if (!pointSelection || !groupCodes) return 0
    let c = 0
    for (let k = 0; k < pointSelection.length; k++) if (pointSelection[k] < groupCodes.length) c++
    return c
  }, [pointSelection, groupCodes])

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      pointSelectionLength: selectionLength,
      violinSelectedDots: selectedDots,
      violinSelectedGroups: selectedGroups.size,
    }
  }, [selectionLength, selectedDots, selectedGroups])

  // scatter → violin: select every point in group code 0.
  const seedScatter = () => {
    if (!groupCodes) return
    const idx: number[] = []
    for (let i = 0; i < groupCodes.length; i++) if (groupCodes[i] === 0) idx.push(i)
    stores.coordination.getState().setSelection(SCATTER_SOURCE, Uint32Array.from(idx))
  }

  // violin → scatter: run the value-band PRODUCER over group 1 (upper half of its value range).
  const seedViolinBand = () => {
    if (!groupCodes || !values) return
    const gi = buildGroupIndex(groupCodes, nGroups)
    // upper-half band of group 1's observed values.
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < groupCodes.length; i++) {
      if (groupCodes[i] === 1) {
        const v = values[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo)) return
    const idx = cellsInGroupValueBand(gi, 1, values, (lo + hi) / 2, hi)
    stores.coordination.getState().setSelection(VIOLIN_SOURCE, idx)
  }

  const clear = () => stores.coordination.getState().clearSelection()

  const ready = positions && colors && groupCodes && values

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-violin-linked"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div
          style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
        >
          <button
            type="button"
            data-testid="viz-violin-linked-seed"
            onClick={seedScatter}
            disabled={!groupCodes}
          >
            Select group 0 (scatter)
          </button>
          <button
            type="button"
            data-testid="viz-violin-linked-seed-band"
            onClick={seedViolinBand}
            disabled={!ready}
          >
            Band-select group 1 (violin)
          </button>
          <button type="button" data-testid="viz-violin-linked-clear" onClick={clear}>
            Clear
          </button>
          <span data-testid="viz-violin-linked-readout" style={{ opacity: 0.75 }}>
            Shared selection: {selectionLength.toLocaleString()} points · {selectedGroups.size} groups
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}>
            {ready ? (
              <LinkedScatter positions={positions!} colors={colors!} totalPoints={groupCodes!.length} />
            ) : (
              <div style={{ padding: 16 }}>Loading fixture…</div>
            )}
          </div>
          <div data-testid="viz-violin-linked-violin" style={{ flex: 1, minWidth: 0 }}>
            <ViolinView
              coordination={coordination}
              source={source}
              valueKey={VALUE_KEY}
              groupKey={GROUP_KEY}
              showSignificance={false}
              onSelectPoints={idx => stores.coordination.getState().setSelection(VIOLIN_SOURCE, idx)}
            />
          </div>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'violin-linked',
  category: 'Selection',
  title: 'Violin — linked cell-level selection (scatter ⇄ violin dots/groups)',
  covers: 'violin-linked',
  Component: ViolinLinkedStory,
})
