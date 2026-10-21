// a11yGrid.story.tsx — proves the BUILT-IN keyboard accessibility of the multi-cell `GridWorkspace`
// (deferred item #6). The shared deck is N views over N dense cells, so `accessibleLabel` gives the
// workspace keyboard camera control over ONE FOCUSED dense cell at a time: `[`/`]` cycle which dense
// cell is focused, arrows pan it, +/- zoom it, Enter/Space announce it, Esc clear — spoken through an
// off-screen ARIA live region, with a dashed outline marking the focused cell. Pan/zoom flow through
// the same `onViewStateChange` the mouse uses (link-zoom fan-out inherited). Every chrome button/select
// keeps its own keys (guardTarget). The last announcement mirrors to
// `window.__VIZ_TEST__.lastAnnouncement` for the e2e.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { createVizStores, VizStoresProvider, type VizStores } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** Seed TWO scatter (dense) cells side by side so the `[`/`]` focus-cycle is observable. */
function seedTwoScatterCells(stores: VizStores) {
  const s = stores.gridWorkspace.getState()
  s.reset() // → cell-1 (scatter, dense)
  s.splitCell(INITIAL_CELL_ID, 'col') // top row → [cell-1 | cell-2], both scatter (dense)
}

function A11yGridStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // seeds grid cells (and, where present, drives the shared selection); on the singletons those
  // writes are process-global and every story mounted later in the SAME page load inherits them.
  // `tests/viz-e2e/story-isolation.spec.ts` is the walk that measures it.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 21, pointCount: 60_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [last, setLast] = useState('')

  const announce = (m: string) => {
    setLast(m)
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), lastAnnouncement: m }
  }

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
    })()
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    seedTwoScatterCells(stores)
  }, [])

  return (
    <div data-testid="viz-a11y-grid" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, fontSize: 13, opacity: 0.8 }}>
        <b>Built-in grid a11y</b> — Tab to the workspace, then <kbd>[</kbd>/<kbd>]</kbd> cycle the
        focused cell · <kbd>←↑→↓</kbd> pan it · <kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>Enter</kbd>{' '}
        summary · <kbd>Esc</kbd> clear.
        <span data-testid="viz-a11y-last" style={{ marginLeft: 8, opacity: 0.7 }}>
          {last}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors && catalog && (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              source={source}
              catalog={catalog}
              accessibleLabel="Plot grid. Use bracket keys to cycle the focused cell, arrow keys to pan it, plus and minus to zoom, Enter for a summary, Escape to clear."
              onA11yAnnounce={announce}
            />
          </VizStoresProvider>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'a11y-grid',
  category: 'Grid + resize',
  title: 'Accessibility — built-in grid multi-cell keyboard + live region',
  covers: 'a11y-grid',
  Component: A11yGridStory,
})
