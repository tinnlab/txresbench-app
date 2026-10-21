// perf.story.tsx — the performance-smoke story (ITEM-59). Renders a LARGE fixture scatter
// (default 1,000,000 points; the dropdown / `?points=` overrides) through the REAL GPU
// DeckScatterCanvas in one of two render modes (toolbar toggle):
//   • ANIMATE (default) — the benchmark: a ~3s rAF loop churns the point radius every frame so
//     deck redraws ALL N raw points every frame (an uncontrolled canvas can't be pan/zoom-driven
//     from props, so a per-frame prop churn is how we force continuous redraws). Each frame is
//     timed with RollingFrameTimer; the loop publishes { points, stats, verdict } on
//     window.__VIZ_PERF__ + a visible readout for scripts/viz-perf.mjs. This is the WORST-CASE
//     sustained-fps measurement, NOT a typical view.
//   • STATIC — renders the SAME N points once and lets deck's controller pan/zoom them; deck
//     reuses its cached GPU buffers and only redraws on interaction, so the identical point count
//     feels smooth. The toggle makes the distinction visible: raw GPU scatter isn't slow — a
//     forced per-frame full redraw is.
//
// This is the North-star "1M @ 60fps" MEASUREMENT surface: the story computes a lenient
// verdict (did it actually render frames?) so it works under software WebGL; the driver
// re-applies a strict fps/p95 budget for a real-GPU run.

import { useEffect, useMemo, useRef, useState } from 'react'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { FixtureSource } from '../../viz-core/data/fixtures'
import {
  RollingFrameTimer,
  frameStats,
  perfVerdict,
  type Budget,
  type FrameStats,
  type Verdict,
} from '../../viz-core/perf/perfProbe'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'
import { SelectableScatter } from '../../viz-core/selection/SelectableScatter'
import { continuousColors } from '../../viz-core/data/color'
import { sharedViewFromPositions } from '../../viz-core/timeline/FacetGrid'

const DEFAULT_POINTS = 1_000_000
const DEFAULT_DURATION_MS = 3000
// The story's own budget is deliberately LENIENT — under swiftshader we can't hit 60fps,
// so we gate only on "actually rendered a batch of frames with non-zero fps". A real-GPU
// gate (minFps/maxP95Ms) is applied by the driver via its --min-fps/--budget flags.
const STORY_BUDGET: Budget = { minFrames: 5 }

export interface VizPerfResult {
  points: number
  durationMs: number
  stats: FrameStats
  verdict: Verdict
  /** the (lenient) budget the story's own verdict used. */
  budget: Budget
}

declare global {
  interface Window {
    __VIZ_PERF__?: VizPerfResult
  }
}

function readNumberParam(name: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  const raw = new URLSearchParams(window.location.search).get(name)
  if (raw == null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function PerfScatterStory() {
  // #12: the point count is chosen on the INTERFACE (dropdown), seeded from `?points=` for back-compat.
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)
  const durationMs = useMemo(() => readNumberParam('durationMs', DEFAULT_DURATION_MS), [])

  const source = useMemo(
    () => new FixtureSource({ seed: 42, pointCount: points }),
    [points],
  )
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colorValue, setColorValue] = useState<Float32Array | null>(null)
  const [colorDomain, setColorDomain] = useState<[number, number]>([0, 1])
  const [colorEpoch, setColorEpoch] = useState(0)
  // Animated radius — churning this each frame forces deck to rebuild + redraw the layer,
  // so the GPU actually re-renders all N points every measured frame (a real render load,
  // not an idle rAF tick).
  const [radius, setRadius] = useState(2)
  const [result, setResult] = useState<VizPerfResult | null>(null)
  const [phase, setPhase] = useState<'loading' | 'measuring' | 'done' | 'static'>('loading')
  // `animate` (default) = the benchmark: churn the radius each rAF so deck redraws ALL N raw points
  // every frame → the worst-case sustained fps this harness measures. `static` = render the SAME N
  // points once and let deck's controller pan/zoom them — redraws happen only on interaction (deck
  // reuses its cached GPU buffers between moves), so the identical point count feels smooth. The two
  // modes make the "raw-GPU-scatter isn't slow, a forced per-frame redraw is" distinction visible.
  const [mode, setMode] = useState<'animate' | 'static'>('animate')
  const modeRef = useRef(mode)
  modeRef.current = mode

  // Load the large fixture: positions + a raw continuous column for the GPU colormap path
  // (no CPU O(N) color loop — the fastest way to color a million points, matching the
  // scatter-gpu story).
  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const col = await source.continuous('qcA')
      if (!alive) return
      let lo = Infinity
      let hi = -Infinity
      const v = col.value
      for (let i = 0; i < v.length; i++) {
        if (v[i] < lo) lo = v[i]
        if (v[i] > hi) hi = v[i]
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        lo = 0
        hi = 1
      }
      setPositions(pos.positions)
      setColorValue(v)
      setColorDomain([lo, hi])
      setColorEpoch(e => e + 1)
      // Enter the benchmark loop only in `animate` mode; `static` just renders the points for pan/zoom.
      setPhase(modeRef.current === 'animate' ? 'measuring' : 'static')
    })()
    return () => {
      alive = false
    }
  }, [source])

  // The measurement loop: once the fixture is on screen, run a rAF loop for `durationMs`,
  // stamping every frame, then publish stats + verdict.
  const startedRef = useRef(false)
  useEffect(() => {
    if (mode !== 'animate' || phase !== 'measuring' || !positions || !colorValue || startedRef.current) return
    startedRef.current = true

    const timer = new RollingFrameTimer()
    let rafId = 0
    let t0 = 0

    const loop = (t: number) => {
      if (t0 === 0) {
        t0 = t
        timer.start()
      } else {
        timer.mark()
      }
      // churn the radius so deck redraws the layer this frame.
      setRadius(r => (r >= 3 ? 1.5 : r + 0.05))

      if (t - t0 < durationMs) {
        rafId = requestAnimationFrame(loop)
      } else {
        const stats = frameStats(timer.timestamps())
        const verdict = perfVerdict(stats, STORY_BUDGET)
        const res: VizPerfResult = {
          points,
          durationMs,
          stats,
          verdict,
          budget: STORY_BUDGET,
        }
        window.__VIZ_PERF__ = res
        setResult(res)
        setPhase('done')
      }
    }
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [mode, phase, positions, colorValue, durationMs, points])

  // Switch benchmark ↔ static. Animate (re)runs the measurement over the loaded points; static stops
  // the churn (a stable radius ⇒ deck idles between pan/zoom). Switching before load defers to the
  // load effect (which reads `modeRef`).
  const switchMode = (next: 'animate' | 'static') => {
    if (next === mode) return
    setMode(next)
    if (phase === 'loading') return // load effect will pick the right phase from modeRef
    if (next === 'animate') {
      startedRef.current = false
      setResult(null)
      setPhase('measuring') // the measurement effect (dep: mode/phase) starts a fresh loop
    } else {
      setPhase('static') // cancels the running rAF via the effect's cleanup; radius stays fixed
      setResult(null)
      setRadius(2)
    }
  }

  // STATIC mode can host the real SelectableScatter (rect/polygon/move + hover-to-move) so the
  // selection interaction can be FELT over the big point cloud. It needs precomputed RGBA colors
  // (the GPU-colormap path is DeckScatterCanvas-only) + a fitted initial camera.
  const colors = useMemo(
    () => (colorValue ? continuousColors(colorValue, { colormap: 'viridis', domain: colorDomain }).colors : null),
    [colorValue, colorDomain],
  )
  const fitView = useMemo(() => (positions ? sharedViewFromPositions(positions, 640) : undefined), [positions])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Perf smoke</span>
        {pointControl}
        <span role="group" aria-label="Render mode" style={{ display: 'inline-flex', gap: 4 }}>
          {(['animate', 'static'] as const).map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={`perf-mode-${m}`}
              onClick={() => switchMode(m)}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                border: '1px solid #ccc',
                cursor: 'pointer',
                background: mode === m ? '#3355dd' : '#f2f2f2',
                color: mode === m ? '#fff' : '#222',
              }}
            >
              {m === 'animate' ? 'Animate (benchmark)' : 'Static (pan/zoom)'}
            </button>
          ))}
        </span>
        {mode === 'animate' && <span style={{ opacity: 0.7 }}>· ~{durationMs}ms sweep</span>}
        <span
          data-testid="viz-perf-readout"
          data-phase={phase}
          data-ok={result ? String(result.verdict.ok) : ''}
          style={{
            fontFamily: 'monospace',
            fontSize: 12,
            padding: '2px 8px',
            borderRadius: 4,
            background: result ? (result.verdict.ok ? '#e6ffed' : '#ffecec') : '#f2f2f2',
            color: '#222',
          }}
        >
          {phase === 'loading' && `loading ${points.toLocaleString()} points…`}
          {phase === 'measuring' && 'measuring…'}
          {phase === 'static' &&
            `static · ${points.toLocaleString()} points · pick a Select tool below → draw → Finish → hover+drag to move · Pan to navigate`}
          {phase === 'done' && result && (
            `frames=${result.stats.frames} ` +
            `mean=${result.stats.meanMs.toFixed(2)}ms ` +
            `p95=${result.stats.p95Ms.toFixed(2)}ms ` +
            `meanFps=${result.stats.meanFps.toFixed(1)} ` +
            `minFps=${result.stats.minFps.toFixed(1)} ` +
            `→ ${result.verdict.ok ? 'PASS' : 'FAIL'}` +
            (result.verdict.reasons.length ? ` (${result.verdict.reasons.join('; ')})` : '')
          )}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colorValue ? (
          mode === 'static' && colors ? (
            // Static: the real selection surface (draw/finish/hover-to-move) over the big cloud.
            <SelectableScatter
              positions={positions}
              colors={colors}
              totalPoints={points}
              radius={2}
              colorEpoch={colorEpoch}
              initialViewState={fitView}
            />
          ) : (
            // Animate: the forced-redraw benchmark (unchanged — publishes __VIZ_PERF__).
            <DeckScatterCanvas
              positions={positions}
              colormapMode={{ colorValue, colormap: 'viridis', colorDomain }}
              colorEpoch={colorEpoch}
              radius={radius}
            />
          )
        ) : (
          <div style={{ padding: 16 }}>Generating {points.toLocaleString()}-point fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'perf-scatter',
  category: 'Scale / perf',
  title: 'Perf smoke — 1M-point GPU scatter (animate=benchmark vs static=pan/zoom)',
  covers: 'perf',
  Component: PerfScatterStory,
})
