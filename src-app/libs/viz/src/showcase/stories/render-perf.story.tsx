// render-perf.story.tsx — the RENDER-PERF measurement surface (ITEM-9).
//
// WHY THIS EXISTS AND `#plot-editing` DOES NOT SUFFICE. The render-perf profile's headline
// invariant (INV-5) is a SCALING LAW: "elements created per wheel step are O(1) w.r.t. pane
// count". `#plot-editing` is a FIXED 2×2 grid, so the slope `(E(8) − E(1)) / 7` simply cannot
// be measured on it — there is one point on the curve. This story parameterizes the pane count
// (`?panes=1|2|4|8`, hard-clamped) so the harness can drive the same gesture at four grid sizes
// and fit the line.
//
// It deliberately MIRRORS `00c-plot-editing.story.tsx`'s chrome: `option.controls` fully on
// (legend + colormap + titles + pointSize, all editable) and per-pane toolbars, so the chrome
// this measures is the chrome the profile reported. The one difference is that every cell is a
// dense SCATTER (rather than 2 scatter + a box + a violin): the measurement wants N identical
// panes so the per-pane cost is a clean division, and it wants the two colorBy modes present so
// both the categorical-legend and the continuous-colormap chrome are on screen. Panes therefore
// ALTERNATE categorical / continuous.
//
// Test hook: `window.__VIZ_RENDER_PERF__` reports `{ panes, points }` so a spec can prove the
// fixture actually rendered what the URL asked for (TEST-1) — every budget downstream is
// meaningless if the story silently rendered 4 panes when the URL said 8.

import { useEffect, useMemo } from 'react'
import { Viz } from '../../react/Viz'
import { FixtureSource } from '../../viz-core/data/fixtures'
import type { VizOption } from '../../viz-core/option/types'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'

/** The pane counts the scaling law is fitted over. Hard-clamped: an unbounded `?panes=` would
 *  make the fixture the variable rather than the measurement. */
const PANE_COUNTS = [1, 2, 4, 8] as const
export type PaneCount = (typeof PANE_COUNTS)[number]

const DEFAULT_PANES: PaneCount = 4
/** 20 000 — the profile's grid point count (§1: "20 000 points inside the grid cost 75 ms"). */
const DEFAULT_POINTS = 20_000

export interface VizRenderPerfHandle {
  /** the pane count actually rendered (post-clamp), for fixture-correctness assertions. */
  panes: number
  /** the point count actually fed to the fixture source. */
  points: number
  /** the cell ids in render order, so a spec can address pane 0 without guessing. */
  cellIds: string[]
}

declare global {
  interface Window {
    __VIZ_RENDER_PERF__?: VizRenderPerfHandle
  }
}

/** `?panes=` → one of {1,2,4,8}; anything else falls back to 4. Deliberately a whitelist, not a
 *  clamp-to-range: the slope is fitted over these four points and only these four. */
export function readPaneCount(search: string, fallback: PaneCount = DEFAULT_PANES): PaneCount {
  const raw = new URLSearchParams(search).get('panes')
  if (raw == null) return fallback
  const n = Number(raw)
  return (PANE_COUNTS as readonly number[]).includes(n) ? (n as PaneCount) : fallback
}

/** Row-major placement for N panes: 1 → 1×1, 2 → 1×2, 4 → 2×2, 8 → 2×4. Keeping the aspect
 *  ratio near-square at every N is what stops the per-pane chrome from folding differently at
 *  different N — a fold change would confound the slope with a layout change. */
export function paneRegions(panes: PaneCount): { row: number; col: number }[] {
  const cols = panes === 1 ? 1 : panes === 8 ? 4 : 2
  return Array.from({ length: panes }, (_, i) => ({ row: Math.floor(i / cols), col: i % cols }))
}

/** The measured option. Every cell is a dense scatter; colorBy alternates categorical /
 *  continuous so BOTH the legend and the colormap chrome are mounted, as on `#plot-editing`. */
export function buildRenderPerfOption(panes: PaneCount): VizOption {
  const regions = paneRegions(panes)
  return {
    dataset: { id: 'render-perf' },
    grid: regions.map((region, i) => ({ id: `p${i}`, region })),
    // Identical to 00c-plot-editing: everything on and editable, so the measured chrome is the
    // chrome the render-perf profile reported.
    controls: {
      legend: { show: true, editable: true },
      colormap: { show: true, editable: true },
      titles: { show: true, editable: true },
      pointSize: { show: true, editable: true },
    },
    series: regions.map((_, i) => ({
      id: `ser-p${i}`,
      type: 'scatter' as const,
      coordId: `p${i}`,
      encode: {
        layout: 'primary' as const,
        colorBy:
          i % 2 === 0
            ? ({ mode: 'categorical', key: 'group' } as const)
            : ({ mode: 'continuous', key: 'qcA', colormap: 'viridis' } as const),
      },
      title: i % 2 === 0 ? `Cell types ${i}` : `QC metric ${i}`,
      style: { radius: 3, opacity: 0.85 },
    })),
  }
}

function RenderPerfStory() {
  const panes = useMemo(
    () => readPaneCount(typeof window === 'undefined' ? '' : window.location.search),
    [],
  )
  // Point count seeded from `?points=` then interface-owned, exactly as the other perf stories.
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)

  const source = useMemo(() => new FixtureSource({ seed: 11, pointCount: points }), [points])
  const option = useMemo(() => buildRenderPerfOption(panes), [panes])

  // Publish the fixture's ACTUAL shape (post-clamp), not the URL's request — TEST-1 asserts the
  // two agree, which is what makes every downstream budget attributable to a known fixture.
  useEffect(() => {
    window.__VIZ_RENDER_PERF__ = {
      panes,
      points,
      cellIds: option.grid?.map(g => g.id) ?? [],
    }
  }, [panes, points, option])

  return (
    <div
      data-testid="viz-render-perf"
      data-panes={panes}
      data-points={points}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}
    >
      <div style={{ padding: '8px 8px 4px', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Render perf</strong>
        {pointControl}
        <span role="group" aria-label="Pane count" style={{ display: 'inline-flex', gap: 4 }}>
          {PANE_COUNTS.map(n => (
            // FIX_ROUND-3 / the design-conformance angle's one NEW finding. This pill group shipped
            // with `background: '#3355dd' : '#f2f2f2'` + `color: '#fff' : '#222'` + `border: 1px solid
            // #ccc` in an inline `style` — three ways at once past the token system (an arbitrary
            // value, an inline style color prop, and a hardcoded brand blue standing in for the
            // runtime accent), so the strip was theme-blind and unreadable in dark mode. The showcase
            // loads the kit's token layer (`showcase.css` → `@ziee/kit/styles/tokens.css`), so the
            // semantic classes resolve here exactly as they do in the app.
            //
            // EXACTLY what moved, per FIX_ROUND-4 / R4-7 (this comment previously claimed "layout
            // stays inline; only the COLOR and the radius move", which was wrong on three counts):
            // the WHOLE pill style became classes. TWO of them are geometry changes rather than pure
            // token swaps, and both are named because the point of this comment is to not understate
            // the edit — FIX_ROUND-5 / R5-6 caught the second one missing: `padding: '2px 10px'` →
            // `px-2 py-0.5` is 10px→8px horizontally, and `borderRadius: 4` → `rounded-sm` is 4px→6px
            // (`--radius-sm` = `calc(var(--radius) - 4px)` = 10px − 4px, from the kit's token layer;
            // `showcase.css` sets no `--radius` override). Pure swaps: `background`/`color`/`border`
            // → the tokens, `fontSize: 12` → `text-xs` (12px), `textDecoration: 'none'` →
            // `no-underline`. The parent row's `gap: 10` → `gap: 8` is an inline value that STAYED
            // inline; it moved onto the 4px rhythm, not onto the class scale.
            <a
              key={n}
              data-testid={`render-perf-panes-${n}`}
              aria-current={panes === n ? 'true' : undefined}
              href={`?panes=${n}&points=${points}#render-perf`}
              className={`rounded-sm border border-border px-2 py-0.5 text-xs no-underline ${
                panes === n ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
              }`}
            >
              {n} pane{n === 1 ? '' : 's'}
            </a>
          ))}
        </span>
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          {panes} panes × {points.toLocaleString()} points · chrome identical to #plot-editing ·
          drive the wheel over a pane and read the counters
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Viz source={source} option={option} />
      </div>
    </div>
  )
}

registerStory({
  id: 'render-perf',
  category: 'Scale / perf',
  title: 'Render perf — N-pane grid (?panes=1|2|4|8) for the O(1)-in-panes scaling law',
  covers: 'render-perf',
  Component: RenderPerfStory,
})
