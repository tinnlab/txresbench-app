// dataOwnership.story.tsx — the DATA-OWNERSHIP-INVERSION story.
//
// Proves the viz OWNS its data: the app hands `<Viz>` ONLY the small `source` + the declarative
// `option` (the initial layout) — NO `positions` / `colors` / `catalog` bulk props. `GridWorkspace`
// pulls the buffers + catalog from `source` ONCE and owns them; thereafter every manipulation is an
// imperative COMMAND on the returned `VizController` (`addCell` / `setCellColorBy` / `removeCell`),
// with NO buffer ever re-passed from the app. Contrast the `optionDeclarative` story, which still
// computes + holds `positions`/`colors` in app state and feeds them to the grid.

import { useEffect, useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { VizController } from '../../adapter/VizController'
import type { GridCell } from '../../viz-core/grid/gridModel'
import type { ColorBy } from '../../viz-core/data/engine'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

/** The id of the primary cell the initial layout mounts (the option's grid-entry id). */
const MAIN_ID = 'g-main'

/** The INITIAL layout — a single scatter cell. This is ALL the app hands over (plus `source`): a
 *  tiny declarative plan, no bulk buffers. */
const INITIAL_LAYOUT: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: MAIN_ID, region: { col: 0 } }],
  series: [{ id: 's-scatter', type: 'scatter', coordId: MAIN_ID, encode: { layout: 'primary' } }],
}

/** Two color-by intents the app flips the OWNED scatter between — the app supplies only the tiny
 *  intent object; the viz recolors by pulling the column from its OWNED `source` (no color re-pass). */
const COLOR_BY_GROUP: ColorBy = {
  mode: 'categorical',
  key: 'group',
  colormap: 'viridis',
  scale: 'linear',
  hidden: new Set<number>(),
}
const COLOR_BY_VALUE: ColorBy = {
  mode: 'continuous',
  key: 'qcA',
  colormap: 'viridis',
  scale: 'linear',
  hidden: new Set<number>(),
}

function DataOwnershipStory() {
  // The app holds the SMALL source + the controller handle. It NEVER computes or stores
  // positions/colors — that is exactly the inversion this story demonstrates.
  const source = useMemo(() => new FixtureSource({ seed: 7, pointCount: 60_000 }), [])
  const [controller, setController] = useState<VizController | null>(null)

  // Observe the viz's OWN grid store (VIZ_ISOLATION W3: `<Viz>` owns a per-instance set — the module
  // singleton no longer reflects this instance's grid). Subscribe to the controller's grid store so
  // every imperative command (addCell / setCellColorBy / removeCell) re-reads viz-owned state.
  const [cells, setCells] = useState<Record<string, GridCell>>({})
  useEffect(() => {
    if (!controller) return
    const grid = controller.getStores().gridWorkspace
    const read = () => setCells(grid.getState().cells)
    read()
    return grid.subscribe(read)
  }, [controller])
  const cellIds = Object.keys(cells)
  const mainColorMode = cells[MAIN_ID]?.colorBy?.mode ?? 'default'

  // e2e observation hook.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      ownershipCellCount: cellIds.length,
      ownershipMainColorMode: mainColorMode,
      ownershipHasController: controller != null,
    }
  }, [cellIds.length, mainColorMode, controller])

  const addCell = () => controller?.addCell('col', 'scatter')
  const colorByGroup = () => controller?.setCellColorBy(MAIN_ID, COLOR_BY_GROUP)
  const colorByValue = () => controller?.setCellColorBy(MAIN_ID, COLOR_BY_VALUE)
  const removeLast = () => {
    // Remove the most-recently added cell (never the primary one — a workspace keeps ≥1 cell).
    const extra = cellIds.filter(id => id !== MAIN_ID)
    const last = extra[extra.length - 1]
    if (last) controller?.removeCell(last)
  }

  return (
    <div
      data-testid="viz-data-ownership"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="ownership-add-cell" onClick={addCell}>
          + scatter cell
        </button>
        <button type="button" data-testid="ownership-remove-cell" onClick={removeLast}>
          − remove last
        </button>
        <button type="button" data-testid="ownership-color-group" onClick={colorByGroup}>
          color by group
        </button>
        <button type="button" data-testid="ownership-color-value" onClick={colorByValue}>
          color by value
        </button>
        <span style={{ opacity: 0.6 }}>
          cells = {cellIds.length}; main color = {mainColorMode}
        </span>
      </div>
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        The app hands <code>&lt;Viz&gt;</code> ONLY <code>source</code> + the initial{' '}
        <code>option</code> — NO <code>positions</code>/<code>colors</code>/<code>catalog</code>. The
        viz pulls + OWNS its data once; every button is an imperative{' '}
        <code>controller.addCell / setCellColorBy / removeCell</code> command with no buffer re-pass.
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz source={source} option={INITIAL_LAYOUT} onController={setController} />
      </div>
    </div>
  )
}

registerStory({
  id: 'viz-data-ownership',
  category: 'Grid + resize',
  title: 'Data ownership — buffers-omitted <Viz source={…}/> + imperative mutators',
  Component: DataOwnershipStory,
})
