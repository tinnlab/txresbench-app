// sessionState.story.tsx — PROVES the data-independent SESSION SAVE / RESTORE capstone via the
// consolidated `getOption()` / `setOption(saved, { replace })` pair (viz-api-consolidation ITEM-2/3/6).
// The story mutates every serializable interaction surface — a point SELECTION, a per-plot dataZoom
// WINDOW (the lifted `ValueDataZoom`), a per-plot FILTER range (the lifted `VisualMap`), and a
// per-group COLOR OVERRIDE — then CAPTURES a `VizOption` via `controller.getOption()`, RESETS the
// interaction stores (visuals snap back to defaults), and RESTORES the snapshot via
// `controller.setOption(saved, { replace: true })` (the visuals return EXACTLY). The restored render
// is pixel-identical to the pre-reset render — the "restored exactly" proof the e2e screenshots
// pre/post-restore.
//
// This is the HAND-WIRED store round-trip (the sibling `sessionStateViz.story` drives the same
// getOption/onChange path through a real `<Viz>` mount). The controller here drives the MODULE
// SINGLETON stores (`defaultVizStores`) — the exact stores the mounted `ValueDataZoom` / `VisualMap`
// observe — so a `getOption()` capture reads, and a `setOption(replace)` restore writes, the same
// state the rails render. A tiny SETUP_OPTION (a single scatter cell + a value-axis dataZoom keyed to
// `PLOT_ID`) is applied on mount so the captured option carries the dataZoom config the window rides.
//
// The two LIFTED pieces are exercised through their real components with an EXPLICIT per-plot id
// (`dataZoomId="viz-session-plot"` / `filterId="viz-session-filter"`), so the window + range live in
// `PlotInteraction.store` and round-trip like every other slice. `resetInteraction` clears ONLY the
// interaction stores (not the grid layout), so the components stay mounted — restore then writes the
// stores and the mounted visuals update reactively (no remount clobber of the dataZoom reset effect).
//
// window.__VIZ_TEST__ exposes the current values + a `sessionRestoredMatches` deep-equality flag so a
// headless harness can assert the round-trip without pixels.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { ValueDataZoom } from '../../viz-core/datazoom/DataZoom'
import { VisualMap } from '../../viz-core/controls/VisualMap'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { installBuiltins } from '../../viz-core/charts/installBuiltins'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

// Charts must be registered before `setOption` can parse a `scatter` series.
installBuiltins()

const MAIN_ID = 'g-main'
const PLOT_ID = 'viz-session-plot'
const FILTER_ID = 'viz-session-filter'
const SOURCE = 'viz-session-origin'
const COLUMN = 'group'
const DOMAIN: readonly [number, number] = [0, 100]

/** The tiny declarative plan the controller mounts — a single scatter cell + a value-axis dataZoom
 *  keyed to `PLOT_ID`, so a captured `getOption()` carries the dataZoom config its live WINDOW rides
 *  (a dataZoom window only round-trips when the resolved plan declares the dataZoom instance). */
const SETUP_OPTION: VizOption = {
  dataset: { id: 'session-demo' },
  grid: [{ id: MAIN_ID, region: { col: 0 } }],
  dataZoom: [{ id: PLOT_ID, type: 'inside', coordId: MAIN_ID, axes: ['x'] }],
  series: [{ id: MAIN_ID, type: 'scatter', coordId: MAIN_ID, encode: { layout: 'primary' } }],
}

/** The mutated target values (deterministic so the e2e can assert exact numbers). */
const SEL_IDS = [3, 7, 42, 99]
const ZOOM = { lo: 20, hi: 60 }
const FILTER: readonly [number, number] = [30, 70]
const OVERRIDE_COLOR = '#e11d48'

function SessionStateStory() {
  // An ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). The
  // controller drives THIS set and the rails below are mounted under `<VizStoresProvider>`, so
  // `getOption`/`setOption` still read/write exactly the state the rails render — the property this
  // story is about — while the writes stop being process-global. The unmount cleanup this story used
  // to carry was also PARTIAL (it cleared selection/interaction/overrides but not the grid cells or
  // the dataset the `setOption` acquired); isolation makes the whole question moot.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(() => {
    const source = new FixtureSource({ seed: 7, pointCount: 40_000 })
    return new VizController({ resolveDataset: () => source, stores })
  }, [stores])

  const capturedRef = useRef<VizOption | null>(null)
  const [captured, setCaptured] = useState<VizOption | null>(null)

  // Mount the tiny setup plan once so the captured option carries the dataZoom config.
  useEffect(() => {
    void controller.setOption(SETUP_OPTION)
  }, [controller])

  // Reactive reads so the visuals + the test hook update live.
  const selectionLength = useStore(stores.coordination, s => s.pointSelection?.length ?? 0)
  const zoomWin = useStore(stores.plotInteraction, s => s.dataZoomWindows[PLOT_ID]) as
    | { lo: number; hi: number }
    | undefined
  const filterRange = useStore(stores.plotInteraction, s => s.filters[FILTER_ID])
  const overrideColor = useStore(stores.colorOverride, s => s.overrides[COLUMN]?.categoryColors?.['A'])

  const mutate = () => {
    stores.coordination.getState().setSelection(SOURCE, Uint32Array.from(SEL_IDS))
    stores.plotInteraction.getState().setDataZoomWindow(PLOT_ID, ZOOM)
    stores.plotInteraction.getState().setFilter(FILTER_ID, FILTER)
    stores.colorOverride.getState().setCategoryColor(COLUMN, 'A', OVERRIDE_COLOR)
    stores.colorOverride.getState().setCategoryLabel(COLUMN, 'A', 'Alpha')
  }

  // CAPTURE the live state as a `VizOption` (the consolidated save surface).
  const capture = () => {
    const snap = controller.getOption()
    capturedRef.current = snap
    setCaptured(snap)
  }

  // Reset ONLY the interaction stores (keep the grid + components mounted → no dataZoom remount clobber).
  const resetInteraction = () => {
    stores.coordination.getState().clearSelection()
    stores.plotInteraction.getState().reset()
    stores.colorOverride.getState().hydrate({})
  }

  // RESTORE via `setOption(saved, { replace: true })` — the components stay mounted, so the rails
  // update reactively as the interaction stores re-hydrate.
  const restore = () => {
    if (capturedRef.current) void controller.setOption(capturedRef.current, { replace: true })
  }

  // Deep-equality of a re-`getOption()` vs the captured option — the round-trip proof (equal only
  // while the live state matches the capture: true after restore, false after reset).
  const restoredMatchesCaptured = (() => {
    if (!capturedRef.current) return false
    return JSON.stringify(controller.getOption()) === JSON.stringify(capturedRef.current)
  })()

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      sessionSelectionLength: selectionLength,
      sessionZoom: zoomWin ?? null,
      sessionFilter: filterRange ?? null,
      sessionOverrideColor: overrideColor ?? null,
      sessionRestoredMatches: restoredMatchesCaptured,
      sessionHasCapture: captured != null,
    }
  }, [selectionLength, zoomWin, filterRange, overrideColor, restoredMatchesCaptured, captured])

  return (
    <div
      data-testid="viz-session-state"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8, padding: 8 }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <button type="button" data-testid="viz-session-mutate" onClick={mutate}>
          Mutate
        </button>
        <button type="button" data-testid="viz-session-capture" onClick={capture}>
          Capture
        </button>
        <button type="button" data-testid="viz-session-reset" onClick={resetInteraction}>
          Reset
        </button>
        <button type="button" data-testid="viz-session-restore" onClick={restore}>
          Restore
        </button>
        <span data-testid="viz-session-readout" style={{ opacity: 0.75 }}>
          sel={selectionLength} · zoom={zoomWin ? `${zoomWin.lo}-${zoomWin.hi}` : '—'} · filter=
          {filterRange ? `${filterRange[0]}-${filterRange[1]}` : '—'} · match=
          {String(restoredMatchesCaptured)}
        </span>
      </div>

      <VizStoresProvider value={stores}>
      <div
        data-testid="viz-session-viz-row"
        style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}
      >
        {/* Lifted FILTER — the rail handles reflect `PlotInteraction.store.filters[FILTER_ID]`. */}
        <VisualMap
          min={DOMAIN[0]}
          max={DOMAIN[1]}
          colormap="viridis"
          value={DOMAIN as [number, number]}
          onChange={() => {}}
          filterId={FILTER_ID}
          filterColumn={COLUMN}
          length={160}
          data-testid="viz-session-visualmap"
        />

        {/* Lifted dataZoom WINDOW — the rail reflects `PlotInteraction.store.dataZoomWindows[PLOT_ID]`. */}
        <div style={{ width: 240, height: 160 }}>
          <ValueDataZoom domain={DOMAIN} testId="viz-session-zoom" dataZoomId={PLOT_ID}>
            {win => (
              <div
                data-testid="viz-session-zoom-window"
                style={{ padding: 8, fontSize: 12 }}
              >
                window: {win ? `${win.lo.toFixed(1)} – ${win.hi.toFixed(1)}` : '—'}
              </div>
            )}
          </ValueDataZoom>
        </div>

        {/* Color OVERRIDE swatch — background reflects the per-group override color. */}
        <div
          data-testid="viz-session-swatch"
          style={{
            width: 64,
            height: 64,
            borderRadius: 8,
            border: '1px solid rgba(128,128,128,0.4)',
            background: overrideColor ?? '#94a3b8',
          }}
        />
      </div>
      </VizStoresProvider>
    </div>
  )
}

registerStory({
  id: 'session-state-save-restore',
  category: 'Export',
  title: 'Session state — save + restore EXACTLY (selection · zoom · filter · override)',
  covers: 'session-state',
  Component: SessionStateStory,
})
