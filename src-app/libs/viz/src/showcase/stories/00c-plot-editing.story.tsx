// 00c-plot-editing.story.tsx — the PLOT-EDITING surface (registered near the top). ONE declarative
// `<Viz option>` grid whose every in-cell EDITOR is exercised: the categorical LEGEND (dbl-click a
// swatch → recolor; click a label → rename; click → hide), the continuous COLORMAP picker, per-cell
// MARKS (point size + opacity), and editable plot + axis TITLES. All are baked into the viz core and
// gated by `option.controls` (`{ legend, colormap, titles, pointSize: {show?, editable?} }`) — NOTHING
// is hand-wired for the demo. Every edit round-trips through `getOption()` (WYSIWYG + persisted).

import { useMemo, useState } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'

const FEATURES = ['Feature A', 'Feature B', 'Feature C'] as const

// A 2×2 grid: a categorical scatter (legend edit), a continuous scatter (colormap), a box + a violin
// chart (editable plot + axis titles). Marks (size/opacity) apply to the two scatter cells.
export function buildOption(): VizOption {
  return {
    dataset: { id: 'demo' },
    grid: [
      { id: 'cat', region: { row: 0, col: 0 } },
      { id: 'cont', region: { row: 0, col: 1 } },
      { id: 'box', region: { row: 1, col: 0 } },
      { id: 'violin', region: { row: 1, col: 1 } },
    ],
    // Every in-cell editor turned ON (editable). Absent ⇒ DEC-4 defaults (legend editable, rest
    // read-only); here we opt everything in so the whole plot-editing surface is exercised.
    controls: {
      legend: { show: true, editable: true },
      colormap: { show: true, editable: true },
      titles: { show: true, editable: true },
      pointSize: { show: true, editable: true },
    },
    series: [
      {
        id: 'ser-cat',
        type: 'scatter',
        coordId: 'cat',
        encode: { layout: 'primary', colorBy: { mode: 'categorical', key: 'group' } },
        title: 'Cell types',
        style: { radius: 3, opacity: 0.85 },
      },
      {
        id: 'ser-cont',
        type: 'scatter',
        coordId: 'cont',
        encode: { layout: 'primary', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } },
        title: 'QC metric',
      },
      {
        id: 'ser-box',
        type: 'box',
        coordId: 'box',
        encode: { groupKey: 'group', valueKey: 'Feature A' },
        title: 'Expression',
        axisTitles: { x: 'Group', y: 'Feature A' },
      },
      {
        id: 'ser-violin',
        type: 'violin',
        coordId: 'violin',
        encode: { groupKey: 'group', valueKey: 'Feature B' },
        title: 'Distribution',
        axisTitles: { y: 'Feature B' },
      },
    ],
  }
}

function PlotEditingStory() {
  // ITEM-18: `seed` is state so the story can MOVE THE UNDERLYING DATA on demand. TEST-24's DATA arm
  // needs a way to make a pane's positions hash change — without it the INV-8 context arm (a zero
  // containment-call delta) would also pass against an implementation that never re-derives at all.
  const [seed, setSeed] = useState(7)
  const source = useMemo(() => new FixtureSource({ seed, pointCount: 20_000 }), [seed])
  const option = useMemo(() => buildOption(), [])
  // Reflect each edit back through getOption() so the story visibly proves the round-trip.
  const [emitted, setEmitted] = useState<string>('(edit a plot to see getOption() update)')

  // EXPORT is now GridWorkspace-OWNED (like the edit form): the pane ⤓ and the rail ⤓ open a per-target
  // ExportDialog that self-resolves the canvas / pane rect / legend, docked in the internal right panel
  // (or a host container via `exportDialogContainer`). No host export wiring here.
  return (
    <div data-testid="viz-plot-editing" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      <div style={{ padding: '8px 8px 4px', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="viz-plot-editing-reseed"
          onClick={() => setSeed(v => v + 1)}
          style={{ fontSize: 11 }}
        >
          Re-seed data (seed {seed})
        </button>
        <strong>Plot editing</strong>
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          shell: global left tool rail (select / pan / zoom · toolbars · link · export-grid) · per-pane
          top toolbar (plot type · <strong>✎ Edit</strong> · <strong>⤓ Export</strong>) · WYSIWYG legend /
          title · the ✎ Edit form + ⤓ Export dialog dock in the right panel
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz
          source={source}
          option={option}
          onChange={o => setEmitted(summarize(o))}
          onSelect={ids => {
            // Test hook: expose the live selection size so an e2e/diag can prove a gesture (incl. the
            // violin's rail-driven band/lasso) published + the cross-plot union grew.
            const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
            w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), pointSelectionLength: ids.length }
          }}
        />
      </div>
      <div
        data-testid="viz-plot-editing-emitted"
        style={{ padding: '4px 8px', fontSize: 11, fontFamily: 'monospace', opacity: 0.7, borderTop: '1px solid rgba(128,128,128,0.2)', maxHeight: 64, overflow: 'auto' }}
      >
        {emitted}
      </div>
    </div>
  )
}

/** A compact one-line digest of the edit-bearing parts of the option (for the story's live readout). */
function summarize(o: VizOption): string {
  const parts: string[] = []
  if (o.colorOverrides) parts.push(`colorOverrides=${Object.keys(o.colorOverrides).join(',')}`)
  // ITEM-18: surface the PROVENANCE in the live readout, so the round-trip the story exists to
  // demonstrate visibly includes HOW a selection was made, not just how many ids it holds.
  if (o.selection?.ops?.length) {
    parts.push(`selection.ops=[${o.selection.ops.map(op => `${op.tool}:${op.op}@${op.pane ?? '-'}`).join(' ')}]`)
    const ctx = o.selection.context
    if (ctx) {
      const bits: string[] = []
      if (ctx.filters) bits.push(`filters=${Object.keys(ctx.filters).join(',')}`)
      if (ctx.hidden) bits.push(`hidden=${Object.entries(ctx.hidden).map(([k, v]) => `${k}:${v.join('/')}`).join(',')}`)
      if (ctx.panes) bits.push(`panes=${Object.keys(ctx.panes).length}`)
      if (bits.length) parts.push(`selection.context{${bits.join(' ')}}`)
    }
  }
  for (const s of o.series) {
    const bits: string[] = []
    if (s.title) bits.push(`title="${s.title}"`)
    if (s.style) bits.push(`style=${JSON.stringify(s.style)}`)
    if (s.axisTitles) bits.push(`axis=${JSON.stringify(s.axisTitles)}`)
    if (s.encode?.colorBy && 'colormap' in s.encode.colorBy) bits.push(`cmap=${s.encode.colorBy.colormap}`)
    if (bits.length) parts.push(`${s.id}{${bits.join(' ')}}`)
  }
  return parts.length ? parts.join('  ') : '(no edits yet)'
}

registerStory({
  id: 'plot-editing',
  category: 'Overview',
  title: 'Plot editing — in-cell legend / colormap / marks / titles (option.controls)',
  covers: 'plot-editing',
  Component: PlotEditingStory,
})
