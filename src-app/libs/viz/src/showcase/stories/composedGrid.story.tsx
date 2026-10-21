// composedGrid.story.tsx — a grid whose pane ids were NAMESPACED by a composing host.
//
// ── WHY THIS FIXTURE HAS TO EXIST ────────────────────────────────────────────────────────────────
// Every other grid story builds panes whose two identities COINCIDE: the id the author wrote IS the
// id the store is keyed by. That is the un-composed case, and it makes a whole class of bug
// invisible — any code that confuses the two renders and behaves identically, so a suite built
// entirely on such fixtures cannot fail on the confusion.
//
// A composing host (the workbench folds several independently-authored declarations onto ONE grid)
// must namespace, or two declarations that happen to name a pane the same thing silently merge into
// one square. From then on a pane has two ids and they are NOT interchangeable:
//   · the GRID KEY (`coordId`, here `panel.alpha::left`) — what the layout, the store and the drag
//     hit-test are keyed by. It must stay invertible from the DOM, which is what `data-cell-id` is
//     for;
//   · the AUTHORED id (`localId`, here `left`) — what a reader addresses: a spec, a screenshot
//     diff, a person, a screen-reader announcement. That is what every `data-testid` carries.
// This story is the only fixture in the showcase where those two differ, so it is the only one where
// a regression in either direction is observable at all.
//
// ── WHAT DRIVES IT ───────────────────────────────────────────────────────────────────────────────
// `composed-grid-drag.spec.ts`. It asserts (a) no `data-testid` anywhere under the workspace carries
// the composition separator, and (b) a real pointer drag of one pane's grip onto the other still
// SWAPS them — which it can only do by recovering the grid key off the DOM. Driving the drag on an
// un-composed grid proves nothing about (b): both ids are the same string there, so an inversion
// through the wrong one succeeds by accident.
//
// The option below is written the way `composeCanvas` emits one (`<viewId>::<local>` coordIds and
// series ids, `localId` + `ownerId` stamped alongside) rather than by calling it — this package
// must not depend on the app, and the wire shape is the contract between them.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import { cellTestId } from '../../viz-core/grid/gridModel'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

/** The two contributing declarations. Named as views, because that is what they are to the host. */
const ALPHA = 'panel.alpha'
const BETA = 'panel.beta'
/** …and the ids each declaration wrote for its own pane. Distinct, so a locator stays unambiguous;
 *  the collision case they exist to survive is covered by `composedPaneDomId.test.ts` on the fold. */
const LEFT = 'left'
const RIGHT = 'right'

const ns = (view: string, local: string) => `${view}::${local}`

/** Two panes of DIFFERENT kinds, so a drag-swap (which trades CONTENT, not position) is observable. */
const OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: ns(ALPHA, LEFT), region: { col: 0 } },
    { id: ns(BETA, RIGHT), region: { col: 1 } },
  ],
  series: [
    {
      id: ns(ALPHA, 's-left'),
      type: 'scatter',
      coordId: ns(ALPHA, LEFT),
      localId: LEFT,
      ownerId: ALPHA,
      encode: { layout: 'primary', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } },
    },
    {
      id: ns(BETA, 's-right'),
      type: 'heatmap',
      coordId: ns(BETA, RIGHT),
      localId: RIGHT,
      ownerId: BETA,
      encode: { groupKey: 'group', valueKeys: ['Feature A', 'Feature B', 'Feature C'] },
    },
  ],
}

function ComposedGridStory() {
  const source = useMemo(() => new FixtureSource({ seed: 11, pointCount: 40_000 }), [])
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // had NO unmount cleanup at all, so its two composed panes stayed in the process-global grid
  // store for every story mounted after it in the same page load.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(
    () => new VizController({ resolveDataset: () => source, stores }),
    [source, stores],
  )

  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [mounted, setMounted] = useState(false)

  // Reads THIS story's grid store (the story component renders the provider, so it is outside its
  // own context) — the same store the controller writes and `<GridWorkspace>` below reads.
  const cells = useStore(stores.gridWorkspace, s => s.cells)

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const c = await computeColoring(source, DEFAULT_COLOR_BY)
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    let alive = true
    void controller.setOption(OPTION).then(() => {
      if (alive) setMounted(true)
    })
    return () => {
      alive = false
    }
  }, [controller])

  // ── The observation hook the spec reads ──────────────────────────────────────────────────────
  // Published from the LIVE store, never from the constant above, so it reports what the grid
  // actually holds after an interaction rather than what the fixture asked for. The spec uses it
  // twice: once to prove the fixture really is composed (`key` ≠ `addressed`), and once after the
  // drag to prove the two panes traded content — which a drag that inverted through the wrong id
  // could not have done. Sorted by key so a re-render cannot reorder the assertion out from under it.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      composedPanes: Object.values(cells)
        .map(c => ({ key: c.id, addressed: cellTestId(c), kind: c.kind }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    }
  }, [cells])

  const ready = positions && colors && catalog && mounted

  return (
    <div
      data-testid="viz-composed-grid"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: '8px 8px 4px', fontSize: 12, opacity: 0.7 }}>
        Two independently-authored declarations folded onto one grid. Each pane is KEYED by
        <code> {'<view>::<name>'} </code>internally and ADDRESSED by the name its author wrote —
        drag either grip onto the other pane to swap them.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              colorEpoch={colorEpoch}
              source={source}
              catalog={catalog}
              // The RESIDENT columns a point readout indexes. Present so this fixture can be
              // HOVERED, not only dragged: the dense-pane readout is gated on a context being
              // supplied at all, so without one the composed hover route renders nothing and a
              // spec cannot tell "the route is broken" from "this story never reads out".
              // `positions` alone is the minimum that produces a badge (x/y rows) and adds no
              // data the fixture did not already hold.
              tooltipContext={{ positions }}
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
  id: 'composed-grid',
  category: 'Grid + resize',
  title: 'Grid — a COMPOSED grid (host-namespaced pane keys, author-addressed DOM)',
  covers: 'composed-grid',
  Component: ComposedGridStory,
})
