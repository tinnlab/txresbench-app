// aimToPlace.story.tsx — PROVES aim-to-place (docking P5). With a pop-out window open, requesting a NEW
// plot does NOT drop it silently — it enters AIM-TO-PLACE: a reminder + a live preview follow the cursor
// across windows, a CLICK places the plot where you aim, and Escape discards it. The story seeds two
// side-by-side scatter cells (declaratively, via `option`) so one remains in the main after popping one
// out. Domain-neutral.

import { useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { VizController } from '../../adapter/VizController'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

/** Two side-by-side scatter cells (no popups → no restore dialog). A plain declarative layout — the
 *  app hands `<Viz>` only `source` + this plan; the two cols become two coordinated cells. */
const TWO_CELLS: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: 'p-1', region: { col: 0 } },
    { id: 'p-2', region: { col: 1 } },
  ],
  series: [
    { id: 's-p-1', type: 'scatter', coordId: 'p-1', encode: { layout: 'primary' } },
    { id: 's-p-2', type: 'scatter', coordId: 'p-2', encode: { layout: 'primary' } },
  ],
  // Two INDEPENDENT plots: override the auto-link (same 'primary' space would otherwise link their
  // cameras) so each zooms/pans on its own by default. The Link-zoom toggle still opts into linking.
  gridLinked: false,
}

function AimToPlaceStory() {
  const source = useMemo(() => new FixtureSource({ seed: 5, pointCount: 30_000 }), [])
  const [controller, setController] = useState<VizController | null>(null)

  return (
    <div
      data-testid="viz-aim-to-place"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          data-testid="viz-aim-add"
          onClick={() => controller?.requestAddCell('col', 'scatter')}
        >
          add plot
        </button>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Pop a plot out, then <em>add plot</em> — with a window open you AIM where the new plot lands.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz source={source} option={TWO_CELLS} onController={setController} />
      </div>
    </div>
  )
}

registerStory({
  id: 'aim-to-place',
  category: 'Export',
  title: 'Aim-to-place — new plot placement across windows',
  covers: 'grid-docking',
  Component: AimToPlaceStory,
})
