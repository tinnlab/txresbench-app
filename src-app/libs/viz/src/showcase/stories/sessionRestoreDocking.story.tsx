// sessionRestoreDocking.story.tsx — PROVES the docking P5 SESSION-RESTORE CHOICE. A `<Viz option>`
// whose SAVED option had a pane docked in a POPUP window can't reopen that window on reload (no user
// gesture), so the main grid shows a choice dialog: MERGE the popup pane into the main grid, or REOPEN
// the window (the click is the gesture). This story mounts exactly that saved option — an option
// carrying a `docking` snapshot IS live state, so `<Viz>` applies it with `setOption(replace)` on
// mount — so the e2e can drive both branches. Domain-neutral, no SVG.

import { useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import type { VizOption } from '../../viz-core/option/types'
import type { LayoutNode } from '@ziee/dock'
import { registerStory } from '../registry'

const leaf = (id: string): LayoutNode => ({ kind: 'leaf', id })

/** A saved `VizOption` (exactly the shape `getOption()` emits for a docked workspace): cell `r-1` in
 *  the main grid, cell `r-2` docked in `popup:0` (window not open). `grid`/`series` carry BOTH cells;
 *  `layout` is the MAIN-grid tree only (leaf `r-1`); `docking` carries WHERE the popped pane lives. On
 *  restore the store lists `popup:0` in `pendingRestore` and the choice dialog appears. Because
 *  `docking` is present, `<Viz>` applies this option with `{ replace: true }` (it carries live state). */
const RESTORE_OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [{ id: 'r-1' }, { id: 'r-2' }],
  layout: leaf('r-1'),
  series: [
    { id: 's-r-1', type: 'scatter', coordId: 'r-1', encode: { layout: 'primary' } },
    { id: 's-r-2', type: 'scatter', coordId: 'r-2', encode: { layout: 'primary' } },
  ],
  docking: {
    containers: [{ id: 'popup:0', layout: leaf('r-2') }],
    paneContainer: { 'r-2': 'popup:0' },
    anchors: {},
  },
}

function SessionRestoreDockingStory() {
  const source = useMemo(() => new FixtureSource({ seed: 9, pointCount: 40_000 }), [])
  // Remount control so the e2e can re-arm the restore (each mount re-runs the restore-after-setOption).
  const [mountKey, setMountKey] = useState(0)

  return (
    <div
      data-testid="viz-restore-docking"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" data-testid="viz-restore-remount" onClick={() => setMountKey(k => k + 1)}>
          re-arm restore
        </button>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Restores a layout with one popped-out pane → the choice dialog appears.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz key={mountKey} source={source} option={RESTORE_OPTION} />
      </div>
    </div>
  )
}

registerStory({
  id: 'session-restore-docking',
  category: 'Export',
  title: 'Session restore — docked popup choice (merge / reopen)',
  covers: 'session-state',
  Component: SessionRestoreDockingStory,
})
