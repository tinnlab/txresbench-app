// visualmapFilters.story.tsx — the ROUND-TRIP proof for a dense scatter's IN-CELL visual-map range
// (`VizOption.filters`). The sibling of `sessionStateViz.story` (whole-`<Viz>` capture → remount →
// restore), narrowed to the ONE field that was silently dropped: an in-cell visual-map drag must land
// in `getOption().filters[cellId]` (DATA units, keyed by the stable plot/cell id) and a
// `setOption(saved, { replace: true })` restore must bring BOTH the option value AND the visual clamp
// back.
//
// Nothing here is hand-wired: the range is set by DRAGGING the real `InCellVisualMap` the grid renders,
// the capture is a plain `controller.getOption()`, and the restore is the production remount path
// (`<Viz option={saved}>` + a fresh mount key → the restore-on-mount `setOption(replace)`), exactly as
// `sessionStateViz.story` models it. `window.__VIZ_FILTERS_TEST__` exposes the observations the headless
// harness asserts; the live visual clamp is read from the existing dev hook `window.__VIZ_INCELL__`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { VizController } from '../../adapter/VizController'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

/** The one cell id — also the stable PLOT id the filter must be keyed by. */
const CELL_ID = 'cont'

/** A single dense scatter coloured CONTINUOUSLY (⇒ the grid renders the in-cell visual-map bar). */
const LAYOUT: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: CELL_ID, region: { row: 0, col: 0 } }],
  series: [
    {
      id: 'ser-cont',
      type: 'scatter',
      coordId: CELL_ID,
      encode: { layout: 'primary', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } },
      title: 'QC metric',
    },
  ],
}

function VisualMapFiltersStory() {
  const source = useMemo(() => new FixtureSource({ seed: 7, pointCount: 20_000 }), [])
  const [controller, setController] = useState<VizController | null>(null)
  // The captured option (the "saved figure"), and the option handed to the REMOUNTED `<Viz>`.
  const savedRef = useRef<VizOption | null>(null)
  const [restoreOption, setRestoreOption] = useState<VizOption | null>(null)
  const [mountKey, setMountKey] = useState(0)
  const [changeCount, setChangeCount] = useState(0)

  const onController = useCallback((c: VizController) => setController(c), [])

  // Test hook: the harness reads `filters` straight off a live `getOption()` (no summarising), plus the
  // capture/restore drivers. Re-published whenever the controller / mount / onChange count changes.
  useEffect(() => {
    const w = window as unknown as { __VIZ_FILTERS_TEST__?: unknown }
    w.__VIZ_FILTERS_TEST__ = {
      /** `getOption().filters` verbatim (`null` when the option carries none — the defect's signature). */
      filters: () => controller?.getOption().filters ?? null,
      /** Capture the whole option (the "save"), returning its `filters` for convenience. */
      capture: () => {
        savedRef.current = controller?.getOption() ?? null
        return savedRef.current?.filters ?? null
      },
      /** The captured option's filters (post-capture, without re-reading the live stores). */
      savedFilters: () => savedRef.current?.filters ?? null,
      /** REMOUNT `<Viz option={saved}>` — the production restore path (`setOption(saved, {replace})`). */
      restore: () => {
        setRestoreOption(savedRef.current)
        setMountKey(k => k + 1)
        return savedRef.current != null
      },
      /** REMOUNT with the plain layout (no live state) — the "fresh session" reset. */
      reset: () => {
        setRestoreOption(null)
        setMountKey(k => k + 1)
      },
      mountKey,
      changeCount,
    }
  }, [controller, mountKey, changeCount])

  return (
    <div data-testid="viz-visualmap-filters" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 8px 4px', fontSize: 12, opacity: 0.7 }}>
        <strong>visualMap → option.filters round-trip</strong> — drag the in-cell bar, then capture +
        remount-restore; both the option value and the visual clamp must come back.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz
          key={mountKey}
          source={source}
          option={restoreOption ?? LAYOUT}
          onController={onController}
          onChange={() => setChangeCount(c => c + 1)}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'visualmap-filters',
  category: 'Controls',
  title: 'visualMap range → option.filters (capture / restore round-trip)',
  Component: VisualMapFiltersStory,
})
