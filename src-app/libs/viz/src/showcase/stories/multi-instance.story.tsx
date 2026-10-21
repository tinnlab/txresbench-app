// multi-instance.story.tsx — PROVES per-instance `<Viz>` ISOLATION (VIZ_ISOLATION W2/W3): TWO
// independent `<Viz>` grids mounted side by side, each owning its OWN `createVizStores()` set. A
// selection or grid-edit driven through instance A's controller must NOT change instance B's
// selection / grid (and vice-versa) — the whole point of the store-factory + context refactor.
//
// Before W3, both grids shared the four module-singleton coordination stores, so a selection in A
// lit up B and a second `setOption`/addCell clobbered the other. Now each `<Viz>` provides a fresh
// set to its subtree, so the two are fully decoupled.
//
// The e2e (`multi-instance.spec.ts`) drives the per-instance buttons (each calls THAT instance's
// controller) and asserts, via the namespaced `window.__VIZ_TEST__` slots, that a mutation on A
// leaves B untouched and both stay active. Domain-neutral (generic cells / selection ids), no SVG.

import { useEffect, useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { VizController } from '../../adapter/VizController'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

/** A single-scatter-cell layout with a DISTINCT primary cell id per instance (so the two grids never
 *  collide on a shared id — a real independence signal, and it keeps the document-global pop-out
 *  registry unambiguous). */
const layoutFor = (cellId: string): VizOption => ({
  dataset: { id: 'demo' },
  grid: [{ id: cellId, region: { col: 0 } }],
  series: [{ id: `s-${cellId}`, type: 'scatter', coordId: cellId, encode: { layout: 'primary' } }],
})

/** The deterministic selection each instance's button publishes (canonical point ids). */
const SEL_A = [1, 2, 3, 4]
const SEL_B = [10, 20]

/** One isolated `<Viz>` instance + a live mirror of ITS OWN grid + coordination stores (read via the
 *  controller's per-instance set, never the module singletons). */
function useVizInstance(label: 'A' | 'B', seed: number) {
  const source = useMemo(() => new FixtureSource({ seed, pointCount: 20_000 }), [seed])
  const [controller, setController] = useState<VizController | null>(null)
  const [cellCount, setCellCount] = useState(0)
  const [selLen, setSelLen] = useState(0)

  useEffect(() => {
    if (!controller) return
    const { gridWorkspace, coordination } = controller.getStores()
    const read = () => {
      setCellCount(Object.keys(gridWorkspace.getState().cells).length)
      setSelLen(coordination.getState().pointSelection?.length ?? 0)
    }
    read()
    const offs = [gridWorkspace.subscribe(read), coordination.subscribe(read)]
    return () => {
      for (const off of offs) off()
    }
  }, [controller])

  return { label, source, controller, setController, cellCount, selLen }
}

function MultiInstanceStory() {
  const a = useVizInstance('A', 1)
  const b = useVizInstance('B', 2)

  // Namespaced e2e observation hook — each instance publishes its OWN slot, so the spec can assert
  // A and B independently on ONE `window.__VIZ_TEST__`.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      multiA_cells: a.cellCount,
      multiA_sel: a.selLen,
      multiB_cells: b.cellCount,
      multiB_sel: b.selLen,
      multiReady: a.controller != null && b.controller != null,
    }
  }, [a.cellCount, a.selLen, b.cellCount, b.selLen, a.controller, b.controller])

  return (
    <div
      data-testid="viz-multi-instance"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="multi-a-select" onClick={() => a.controller?.select(Uint32Array.from(SEL_A), 'A')}>
          select in A
        </button>
        <button type="button" data-testid="multi-a-addcell" onClick={() => a.controller?.addCell('col', 'scatter')}>
          + cell in A
        </button>
        <button type="button" data-testid="multi-b-select" onClick={() => b.controller?.select(Uint32Array.from(SEL_B), 'B')}>
          select in B
        </button>
        <button type="button" data-testid="multi-b-addcell" onClick={() => b.controller?.addCell('col', 'scatter')}>
          + cell in B
        </button>
        <span style={{ opacity: 0.6 }}>
          A: cells={a.cellCount} sel={a.selLen} · B: cells={b.cellCount} sel={b.selLen}
        </span>
      </div>
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        TWO independent <code>&lt;Viz&gt;</code> grids — each owns its own store set. A selection or
        added cell in one must NOT touch the other.
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: '0 8px 8px' }}>
        <div data-testid="viz-instance-a" style={{ flex: 1, minWidth: 0, minHeight: 0, border: '1px solid rgba(128,128,128,0.4)' }}>
          <Viz source={a.source} option={layoutFor('g-a')} onController={a.setController} />
        </div>
        <div data-testid="viz-instance-b" style={{ flex: 1, minWidth: 0, minHeight: 0, border: '1px solid rgba(128,128,128,0.4)' }}>
          <Viz source={b.source} option={layoutFor('g-b')} onController={b.setController} />
        </div>
      </div>
    </div>
  )
}

registerStory({
  id: 'viz-multi-instance',
  category: 'Grid + resize',
  title: 'Multi-instance isolation — two independent <Viz> grids',
  Component: MultiInstanceStory,
})
