// benchmark.story.tsx — the REAL interaction-performance benchmark surface (the counterpart
// to perf.story.tsx). Where perf.story measures the PESSIMISTIC "rebuild the whole layer every
// frame" cost (it churns the point radius each rAF to force a full re-render), THIS story
// measures whether interactions are REALTIME:
//
//   1. STEADY-STATE pan/zoom fps — the view is rendered STATICALLY (no per-frame prop churn);
//      the runner drives real camera motion (wheel + drag) which changes ONLY deck's internal
//      viewState, never the data. So the recorded frame cadence is the true steady-state fps of
//      panning/zooming N points, NOT a data-rebuild-every-frame number.
//   2. PER-INTERACTION latency — each interaction mutates ONLY what it actually changes
//      (a uniform, an attribute re-upload, a selection mask, a resize) and we time from the
//      trigger to the frame that PAINTS the change (double-rAF). That is the realistic cost a
//      user feels, isolated per interaction type.
//
// It publishes a global `window.__BENCH__` recorder+driver that scripts/viz-bench.mjs calls.
// No source components are edited — this story only imports and composes them.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { HeatmapView } from '../../viz-core/charts/HeatmapView'
import { DotplotView } from '../../viz-core/charts/DotplotView'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { frameStats, type FrameStats } from '../../viz-core/perf/perfProbe'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'

const DEFAULT_POINTS = 100_000
type BenchKind = 'scatter' | 'heatmap' | 'dotplot'
const KINDS: readonly BenchKind[] = ['scatter', 'heatmap', 'dotplot']
// The matrix views aggregate the fixture's SPARSE value columns; these are the ones the
// heatmap/dotplot stories use.
const MATRIX_VALUE_KEYS = ['Feature A', 'Feature B', 'Feature C', 'Feature D', 'Feature E', 'Feature F']

type InteractionType = 'filter' | 'recolor' | 'select' | 'resize' | 'zoomStep'

/**
 * The imperative interaction driver a mounted benchmark component installs. `measureInteraction`
 * calls these; each returns synchronously after applying its (React) state change so the caller
 * can then wait for the painted frame. `null` when an interaction has no meaningful mapping for
 * the active kind (matrix views have no recolor/select/filter → the runner records 'n/a').
 */
interface BenchControls {
  kind: BenchKind
  pointCount: number
  /** cheapest: change a shader uniform (the colormap domain) — no attribute re-upload. */
  applyFilter: ((lo: number) => void) | null
  /** attribute re-upload: swap the color column + bump colorEpoch. */
  recolor: (() => void) | null
  /** selection-emphasis path: build a highlight mask over `fraction` of points, bump epoch. */
  select: ((fraction: number) => void) | null
  /** resize the canvas container (relayout + redraw). */
  resize: (w: number | null, h: number | null) => void
  /** the deck/chart canvas element (for synthetic wheel + bbox). */
  canvasEl: () => HTMLCanvasElement | null
}

/** Public shape of window.__BENCH__ (what scripts/viz-bench.mjs drives). */
export interface BenchApi {
  ready: boolean
  meta(): { kind: BenchKind; points: number; loadMs: number; supportsDataInteractions: boolean }
  startRecording(): void
  stopRecording(): void
  frameStats(): FrameStats
  measureInteraction(type: InteractionType): Promise<number | null>
  /** deck's own fps counter if reachable, else null (optional secondary signal). */
  deckFps(): number | null
}

declare global {
  interface Window {
    __BENCH__?: BenchApi
  }
}

// ── the global rAF frame recorder (independent of React) ───────────────────────────────────
// While recording, we sample requestAnimationFrame TIMESTAMPS into an array. During the
// runner's continuous pan/zoom, deck redraws every frame, so this cadence == the real
// steady-state fps. `frameStats` (reused from perfProbe) turns the timestamps into stats.
let recording = false
let rafHandle = 0
let samples: number[] = []
function recorderTick(t: number): void {
  if (!recording) return
  samples.push(t)
  rafHandle = requestAnimationFrame(recorderTick)
}

// The controls the currently-mounted benchmark component installs.
let controls: BenchControls | null = null
let loadMs = 0
let ready = false

/** Resolve after the frame that PAINTS a just-applied change (double-rAF): the 1st rAF fires
 *  before the browser paints the pending frame; by the 2nd, the change has been composited. */
function afterPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function dispatchWheel(el: HTMLElement, deltaY: number): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new WheelEvent('wheel', {
      deltaY,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function installBenchApi(): void {
  if (window.__BENCH__) return
  window.__BENCH__ = {
    get ready() {
      return ready
    },
    meta() {
      return {
        kind: controls?.kind ?? 'scatter',
        points: controls?.pointCount ?? 0,
        loadMs,
        supportsDataInteractions: !!(controls && controls.recolor),
      }
    },
    startRecording() {
      samples = []
      recording = true
      cancelAnimationFrame(rafHandle)
      rafHandle = requestAnimationFrame(recorderTick)
    },
    stopRecording() {
      recording = false
      cancelAnimationFrame(rafHandle)
    },
    frameStats() {
      return frameStats(samples)
    },
    async measureInteraction(type: InteractionType): Promise<number | null> {
      const c = controls
      if (!c) throw new Error('benchmark not mounted')
      const canvas = c.canvasEl()
      // Interactions with no mapping for the active kind → n/a (matrix views).
      if ((type === 'filter' && !c.applyFilter) || (type === 'recolor' && !c.recolor) || (type === 'select' && !c.select)) {
        return null
      }
      const t0 = performance.now()
      // Apply ONLY the change this interaction implies. State-mutating changes are wrapped in
      // flushSync so the React commit is synchronous — the double-rAF then reliably follows
      // deck's redraw of the new props.
      switch (type) {
        case 'filter':
          flushSync(() => c.applyFilter!(0.25 + Math.random() * 0.001))
          break
        case 'recolor':
          flushSync(() => c.recolor!())
          break
        case 'select':
          flushSync(() => c.select!(0.1))
          break
        case 'resize': {
          // toggle between two sizes so consecutive calls both cause a real change.
          const w = (resizeToggle = !resizeToggle) ? 900 : 1100
          flushSync(() => c.resize(w, null))
          break
        }
        case 'zoomStep':
          if (canvas) dispatchWheel(canvas, -120)
          break
      }
      await afterPaint()
      return performance.now() - t0
    },
    deckFps() {
      // DeckScatterCanvas does not expose its deck instance and we don't edit source, so this
      // is best-effort: if a deck instance ever surfaces on the canvas, read its metrics.
      const canvas = controls?.canvasEl() as (HTMLCanvasElement & { deck?: { metrics?: { fps?: number } } }) | null
      const fps = canvas?.deck?.metrics?.fps
      return typeof fps === 'number' && Number.isFinite(fps) ? fps : null
    },
  }
}
let resizeToggle = false

function readParam(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  return new URLSearchParams(window.location.search).get(name) ?? fallback
}
function readKind(): BenchKind {
  const k = readParam('kind', 'scatter') as BenchKind
  return KINDS.includes(k) ? k : 'scatter'
}

// ── the story component ─────────────────────────────────────────────────────────────────────
function BenchmarkStory() {
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)
  const kind = useMemo(() => readKind(), [])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: points }), [points])

  installBenchApi()

  return kind === 'scatter' ? (
    <ScatterBench source={source} points={points} control={pointControl} />
  ) : (
    <MatrixBench source={source} points={points} kind={kind} control={pointControl} />
  )
}

// ── scatter: the interaction-rich path (DeckScatterCanvas, GPU colormap) ─────────────────────
function ScatterBench({
  source,
  points,
  control,
}: { source: FixtureSource; points: number; control?: ReactElement }) {
  const [positions, setPositions] = useState<Float32Array | null>(null)
  // two continuous columns to swap between on recolor (a genuine attribute re-upload).
  const [colA, setColA] = useState<Float32Array | null>(null)
  const [colB, setColB] = useState<Float32Array | null>(null)
  const [activeCol, setActiveCol] = useState<0 | 1>(0)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [colorDomain, setColorDomain] = useState<[number, number]>([0, 1])
  const [highlightMask, setHighlightMask] = useState<Uint8Array | null>(null)
  const [selectionActive, setSelectionActive] = useState(false)
  const [selectionEpoch, setSelectionEpoch] = useState(0)
  const [size, setSize] = useState<{ w: number | null; h: number | null }>({ w: null, h: null })
  const rootRef = useRef<HTMLDivElement | null>(null)

  const domainA = useRef<[number, number]>([0, 1])

  useEffect(() => {
    let alive = true
    const t0 = performance.now()
    void (async () => {
      const pos = await source.positions('primary')
      const a = await source.continuous('qcA')
      const b = await source.continuous('qcB')
      if (!alive) return
      domainA.current = domainOf(a.value)
      setPositions(pos.positions)
      setColA(a.value)
      setColB(b.value)
      setColorDomain(domainA.current)
      setColorEpoch(e => e + 1)
      // ready = after the first frame paints.
      void afterPaint().then(() => {
        if (!alive) return
        loadMs = performance.now() - t0
        ready = true
        setReadyState(true)
      })
    })()
    return () => {
      alive = false
    }
  }, [source])

  const [readyState, setReadyState] = useState(false)

  // Install the imperative controls once the data is resident.
  useEffect(() => {
    if (!positions || !colA || !colB) return
    controls = {
      kind: 'scatter',
      pointCount: points,
      applyFilter: (lo: number) => {
        // shift the colormap domain — a uniform change (cheapest), no re-upload.
        const [, hi] = domainA.current
        const span = hi - domainA.current[0]
        setColorDomain([domainA.current[0] + span * lo * 0.001, hi])
      },
      recolor: () => {
        setActiveCol(c => (c === 0 ? 1 : 0))
        setColorEpoch(e => e + 1)
      },
      select: (fraction: number) => {
        const n = positions.length / 2
        const stride = Math.max(1, Math.round(1 / Math.max(fraction, 1e-6)))
        const mask = new Uint8Array(n)
        for (let i = 0; i < n; i += stride) mask[i] = 1
        setHighlightMask(mask)
        setSelectionActive(true)
        setSelectionEpoch(e => e + 1)
      },
      resize: (w, h) => setSize({ w, h }),
      canvasEl: () => rootRef.current?.querySelector('canvas') ?? null,
    }
    return () => {
      if (controls?.kind === 'scatter') controls = null
    }
  }, [positions, colA, colB, points])

  const colorValue = activeCol === 0 ? colA : colB
  const domain = activeCol === 0 ? colorDomain : domainOf(colB ?? new Float32Array(0))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <BenchHeader kind="scatter" points={points} ready={readyState} control={control} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start' }}>
        <div
          ref={rootRef}
          data-testid="viz-benchmark-root"
          style={{ width: size.w ?? '100%', height: size.h ?? '100%', minHeight: 0, flex: size.w ? '0 0 auto' : 1 }}
        >
          {positions && colorValue ? (
            <DeckScatterCanvas
              positions={positions}
              colormapMode={{ colorValue, colormap: 'viridis', colorDomain: domain }}
              colorEpoch={colorEpoch}
              highlightMask={highlightMask}
              selectionActive={selectionActive}
              selectionEpoch={selectionEpoch}
              radius={2}
            />
          ) : (
            <div style={{ padding: 16 }}>Generating {points.toLocaleString()}-point fixture…</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── matrix: heatmap / dotplot — the one-time O(N) aggregation + render path ───────────────────
function MatrixBench({
  source,
  points,
  kind,
  control,
}: { source: FixtureSource; points: number; kind: 'heatmap' | 'dotplot'; control?: ReactElement }) {
  const [readyState, setReadyState] = useState(false)
  const [size, setSize] = useState<{ w: number | null; h: number | null }>({ w: null, h: null })
  const rootRef = useRef<HTMLDivElement | null>(null)

  // The matrix views load + aggregate internally; we can't hook their internal completion, so
  // ready is signalled once a canvas has appeared (aggregation done, first frame drawn).
  useEffect(() => {
    const t0 = performance.now()
    let alive = true
    const check = () => {
      if (!alive) return
      if (rootRef.current?.querySelector('canvas')) {
        void afterPaint().then(() => {
          if (!alive) return
          loadMs = performance.now() - t0
          ready = true
          setReadyState(true)
        })
      } else {
        requestAnimationFrame(check)
      }
    }
    requestAnimationFrame(check)
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    controls = {
      kind,
      pointCount: points,
      applyFilter: null,
      recolor: null,
      select: null,
      resize: (w, h) => setSize({ w, h }),
      canvasEl: () => rootRef.current?.querySelector('canvas') ?? null,
    }
    return () => {
      if (controls?.kind === kind) controls = null
    }
  }, [kind, points])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <BenchHeader kind={kind} points={points} ready={readyState} control={control} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <div
          ref={rootRef}
          data-testid="viz-benchmark-root"
          style={{ width: size.w ?? '100%', height: size.h ?? '100%', minHeight: 0 }}
        >
          {kind === 'heatmap' ? (
            <HeatmapView source={source} valueKeys={MATRIX_VALUE_KEYS} groupKey="group" clusterRows clusterCols showDendrogram showAnnotation />
          ) : (
            <DotplotView source={source} valueKeys={MATRIX_VALUE_KEYS} groupKey="group" />
          )}
        </div>
      </div>
    </div>
  )
}

function BenchHeader({
  kind,
  points,
  ready,
  control,
}: { kind: BenchKind; points: number; ready: boolean; control?: ReactElement }) {
  return (
    <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600 }}>Interaction benchmark</span>
      {control}
      <span style={{ opacity: 0.7 }}>
        {kind} · {points.toLocaleString()} points
      </span>
      {ready && (
        <span
          data-testid="viz-benchmark-ready"
          data-kind={kind}
          data-points={points}
          style={{ fontFamily: 'monospace', fontSize: 12, padding: '2px 8px', borderRadius: 4, background: '#e6ffed', color: '#222' }}
        >
          ready · load {loadMs.toFixed(0)}ms
        </span>
      )}
    </div>
  )
}

function domainOf(v: Float32Array): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < v.length; i++) {
    if (v[i] < lo) lo = v[i]
    if (v[i] > hi) hi = v[i]
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [0, 1]
  return [lo, hi]
}

registerStory({
  id: 'benchmark',
  category: 'Scale / perf',
  title: 'Interaction benchmark — steady-state pan/zoom fps + per-interaction latency',
  covers: 'benchmark',
  Component: BenchmarkStory,
})
