// candlestick.tsx — a CANDLESTICK (OHLC) chart as a PURE self-registering extension
// (EXTENSIBILITY_STUDY capability proof): a genuinely-advanced NEW chart type added with ZERO
// edits to the engine core. It composes ONLY the public chart-authoring surface the built-in
// Views compose from — `ChartCanvas`, `buildChartFrameLayers`, `ValueDataZoom`,
// `useAsyncChartData`, the `CoordinationHandle`, and the pure `selectionSync` emphasis helpers —
// exactly as `BarView` / `BoxView` do, then registers a `ChartTypeDescriptor` through the same
// `registerChartType` seam via a `chartInstaller`. NO SVG: the wick is a `LineLayer`, the body a
// `SolidPolygonLayer` rect (the engine's binding constraint).
//
// coordinateSystem: `chart2d` (own `ChartCanvas`, value/category auto-fit — like bar/box).
// bindingSchema: 4 continuous value channels (open/high/low/close) + an x/index channel.
// capabilities: consumes selection (dims unselected bars) + produces it (brush a bar-range).
// dataZoom: the value (y / price) axis rides the core `ValueDataZoom`.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SolidPolygonLayer, LineLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas } from '../../viz-core/charts/ChartCanvas'
import { buildChartFrameLayers, defaultChartTheme, type ChartTheme } from '../../viz-core/charts/ChartFrame'
import { clipToBounds } from '../../viz-core/charts/clip'
import { AxisDataZoom, type DataZoomConfig } from '../../viz-core/charts/AxisDataZoom'
import { minSpanFor, type AxisWindow } from '../../viz-core/charts/axisWindow'
import { useAsyncChartData, ChartError, ChartLoading } from '../../viz-core/charts/useAsyncChartData'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import { bindingValue, makeChartModel } from '../../viz-core/registry/model'
import type {
  BindingChannel,
  ChartModel,
  ChartTypeDescriptor,
  ChartViewProps,
  CoordinationHandle,
  ModelContext,
} from '../../viz-core/registry/types'
import type { Extension } from '../../viz-core/extension'
import {
  applyMarkOpacity,
  markOpacity,
  type GroupEmphasis,
} from '../../viz-core/coordination/selectionSync'
import type { DataSource } from '../../viz-core/data/wire'
import type { GridCell } from '../../viz-core/grid/gridModel'
import {
  barsFromColumns,
  barsInXRange,
  bodyRing,
  candleColor,
  ohlcValueDomain,
  wickSegment,
  type OhlcBar,
  type Ring,
  type RGBA,
} from './geometry'

// ── the binding schema: 4 continuous value channels + an x/index channel ─────────────────
// Every channel binds a CONTINUOUS column. The shared `resolveBinding`/`resolveBindings`
// (registry/model.ts) now resolves MULTIPLE same-source channels to DISTINCT columns —
// id-match first (`open`→an `open` column), then ordinal (the Nth continuous channel → the
// Nth continuous column) — so this descriptor uses the GENERIC `makeChartModel` like every
// built-in; no bespoke per-channel `model()` is needed (the earlier public-API gap is closed).
// The schema declares the channels so the chrome can render/describe them generically.
const INDEX_CHANNEL: BindingChannel = { id: 'index', source: 'continuous', label: 'Bar' }
const OPEN_CHANNEL: BindingChannel = { id: 'open', source: 'continuous', label: 'Open' }
const HIGH_CHANNEL: BindingChannel = { id: 'high', source: 'continuous', label: 'High' }
const LOW_CHANNEL: BindingChannel = { id: 'low', source: 'continuous', label: 'Low' }
const CLOSE_CHANNEL: BindingChannel = { id: 'close', source: 'continuous', label: 'Close' }

export const CANDLESTICK_SCHEMA: readonly BindingChannel[] = [
  INDEX_CHANNEL,
  OPEN_CHANNEL,
  HIGH_CHANNEL,
  LOW_CHANNEL,
  CLOSE_CHANNEL,
]

/**
 * Resolve the candlestick's five continuous channels to their catalog columns via the GENERIC
 * `makeChartModel` — the same `bindingSchema`-driven resolver every built-in descriptor uses.
 * The shared resolver now assigns each same-source channel a DISTINCT column (id-match first:
 * `index`/`open`/`high`/`low`/`close` → their like-named continuous columns; else ordinal: the
 * Nth continuous channel → the Nth continuous column), so the four price channels + the index
 * channel resolve distinctly with no bespoke per-channel logic. Pure.
 */
export function candlestickModel(cell: GridCell, ctx: ModelContext): ChartModel {
  return makeChartModel(cell, CANDLESTICK_SCHEMA, ctx.catalog)
}

export interface CandlestickViewProps {
  source: DataSource
  indexKey: string
  openKey: string
  highKey: string
  lowKey: string
  closeKey: string
  /** Draw the axes / ticks / labels / gridlines frame (default true). */
  showFrame?: boolean
  /** Draw gridlines within the frame (default true). */
  showGrid?: boolean
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  theme?: ChartTheme
  /** Per-instance VALUE-axis (y / price) dataZoom config; `false` disables the zoom UI. */
  dataZoom?: false | DataZoomConfig
  /** The Selection coordination handle (STEP 3); defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
}

/** Reused empty codes column so the emphasis memo has a stable input before load. */
const EMPTY_CODES = new Uint16Array(0)

interface CandlestickData {
  bars: OhlcBar[]
  /** Per-bar group codes for cross-plot emphasis: `codes[i] === i` (a bar IS its own group). */
  codes: Uint16Array
}

/**
 * The candlestick VIEW: a thin OUTER that loads the O/H/L/C columns, computes the bars + the
 * value (price) domain, reads the cross-plot emphasis through the coordination handle, and hosts
 * the core `ValueDataZoom` (price axis). The passive `CandlestickBody` REACTS to the injected
 * window (re-frames the y bounds) and owns the marks + the brush PRODUCE gesture.
 */
export function CandlestickView({
  source,
  indexKey,
  openKey,
  highKey,
  lowKey,
  closeKey,
  showFrame = true,
  showGrid = true,
  theme = defaultChartTheme(),
  dataZoom,
  coordination = defaultCoordinationHandle,
}: CandlestickViewProps) {
  const { data, error } = useAsyncChartData<CandlestickData>(
    async isAlive => {
      const [index, open, high, low, close] = await Promise.all([
        source.continuous(indexKey),
        source.continuous(openKey),
        source.continuous(highKey),
        source.continuous(lowKey),
        source.continuous(closeKey),
      ])
      if (!isAlive()) return undefined
      const bars = barsFromColumns(index.value, open.value, high.value, low.value, close.value)
      // A bar is its own "group" for emphasis: codes[i] === i, so a shared point-selection
      // carrying bar ordinals lights up exactly those bars (consume ↔ produce round-trip).
      const codes = new Uint16Array(bars.length)
      for (let i = 0; i < bars.length; i++) codes[i] = i
      return { bars, codes }
    },
    [source, indexKey, openKey, highKey, lowKey, closeKey],
  )

  // CONSUME (capabilities.consumesSelection): the shared point-selection → which bars stay lit.
  // Read THROUGH the coordination handle (never the store directly), exactly like BarView/BoxView.
  const emphasis = coordination.useGroupEmphasis(data?.codes ?? EMPTY_CODES)

  // The full price domain the core `ValueDataZoom` spans (a stable ref — resets the window only
  // when the domain values change).
  const valueDomain = useMemo<[number, number] | null>(
    () => (data ? ohlcValueDomain(data.bars) : null),
    [data],
  )

  // TWO windows (#2): x = a contiguous BAR-INDEX sub-range (snap to whole bars); y = the PRICE window
  // (unchanged behavior). Both reset to full whenever the data changes (mirrors ValueDataZoom's
  // reset-on-domain-change). `null` ⇒ the full axis (the active window falls back below).
  const [xWin, setXWin] = useState<AxisWindow | null>(null)
  const [yWin, setYWin] = useState<AxisWindow | null>(null)
  useEffect(() => {
    setXWin(null)
    setYWin(null)
  }, [data])

  if (error) return <ChartError message={error} />
  if (!data) return <ChartLoading />

  const zoomEnabled = dataZoom !== false
  const n = data.bars.length
  const xDomain: [number, number] = [0, Math.max(0, n - 1)]
  const activeX: AxisWindow = xWin ?? { lo: xDomain[0], hi: xDomain[1] }
  const activeY: AxisWindow = yWin ?? (valueDomain ? { lo: valueDomain[0], hi: valueDomain[1] } : { lo: 0, hi: 1 })

  const body = (
    <CandlestickBody
      bars={data.bars}
      valueDomain={valueDomain}
      xWindow={activeX}
      yWindow={activeY}
      zoomEnabled={zoomEnabled}
      emphasis={emphasis}
      showFrame={showFrame}
      showGrid={showGrid}
      theme={theme}
      coordination={coordination}
    />
  )

  // No zoom UI (dataZoom:false) or no data domain ⇒ render the body directly (free camera).
  if (!zoomEnabled || !valueDomain) return body

  // Both axes ride the generic AxisDataZoom: an x slider (snapped to whole bars) UNDER the plot + a y
  // (price) slider BESIDE it, wheel-zoom on both. testId unchanged so existing selectors still resolve.
  return (
    <AxisDataZoom
      testId="viz-candlestick-value-zoom"
      onWindowChange={(axis, win) => (axis === 'x' ? setXWin(win) : setYWin(win))}
      x={{
        domain: xDomain,
        window: activeX,
        mode: 'both',
        snap: Math.round,
        minSpan: 1,
        testId: 'viz-candlestick-x-zoom',
      }}
      y={{
        domain: valueDomain,
        window: activeY,
        mode: 'both',
        minSpan: minSpanFor(valueDomain[0], valueDomain[1]),
        testId: 'viz-candlestick-value-zoom-slider',
      }}
    >
      {body}
    </AxisDataZoom>
  )
}

/** The passive candlestick body: re-frames the price (y) bounds to the injected window, draws the
 *  wicks + bodies (dimmed by the shared selection), and owns the brush PRODUCE gesture. */
function CandlestickBody({
  bars,
  valueDomain,
  xWindow,
  yWindow,
  zoomEnabled,
  emphasis,
  showFrame,
  showGrid,
  theme,
  coordination,
}: {
  bars: OhlcBar[]
  valueDomain: [number, number] | null
  /** Active BAR-INDEX window (x) — the visible sub-range of bars. */
  xWindow: AxisWindow
  /** Active PRICE window (y). */
  yWindow: AxisWindow
  zoomEnabled: boolean
  emphasis: GroupEmphasis
  showFrame: boolean
  showGrid: boolean
  theme: ChartTheme
  coordination: CoordinationHandle
}) {
  const { selectedCodes, active } = emphasis

  // PRODUCE (capabilities.producesSelection): a horizontal BRUSH over the bars publishes the
  // covered bar ordinals as the shared selection through the handle. Off by default so the value
  // slider owns the pointer; toggled on via the toolbar below.
  const [brush, setBrush] = useState(false)
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null)
  const draftStart = useRef<number | null>(null)
  const barsRef = useRef(bars)
  barsRef.current = bars

  const bounds = useMemo<[number, number, number, number] | null>(() => {
    if (!valueDomain) return null
    // x-range = the bar-index window padded half a bar each side; y-range = the price window. Both
    // narrow as the user zooms either axis; marks outside are clipped (clipToBounds below).
    return [xWindow.lo - 0.6, yWindow.lo, xWindow.hi + 0.6, yWindow.hi]
  }, [valueDomain, xWindow, yWindow])

  const layers = useMemo<Layer[]>(() => {
    const out: Layer[] = []
    if (showFrame && bounds) {
      out.push(
        ...buildChartFrameLayers({
          id: 'viz-candlestick-frame',
          bounds,
          xTitle: 'Bar',
          yTitle: 'Price',
          showGrid,
          theme,
        }),
      )
    }
    // DATA marks (wicks/bodies/brush) collect into `marks` so they can be CLIPPED to the plot rect
    // (#3) — the frame (above) stays unclipped.
    const marks: Layer[] = []
    // Wicks (HIGH→LOW) — a LineLayer segment per bar, dimmed in lockstep with its body.
    const wickData = bars.map(b => ({
      ...wickSegment(b.x, b.low, b.high),
      color: applyMarkOpacity(dimColor(candleColor(b.open, b.close)), markOpacity(b.i, selectedCodes, active)),
    }))
    marks.push(
      new LineLayer<(typeof wickData)[number]>({
        id: 'viz-candlestick-wicks',
        data: wickData,
        getSourcePosition: d => d.source,
        getTargetPosition: d => d.target,
        getColor: d => d.color,
        getWidth: 1.5,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        pickable: false,
      }),
    )
    // Bodies (OPEN↔CLOSE) — a SolidPolygonLayer rect per bar, green up / red down, dimmed when a
    // selection is active and this bar is NOT covered (cross-plot emphasis, O(bars) per-mark).
    const bodyData = bars.map(b => ({
      polygon: bodyRing(b.x, b.open, b.close),
      fillColor: applyMarkOpacity(candleColor(b.open, b.close), markOpacity(b.i, selectedCodes, active)),
    }))
    marks.push(
      new SolidPolygonLayer<(typeof bodyData)[number]>({
        id: 'viz-candlestick-bodies',
        data: bodyData,
        getPolygon: d => d.polygon,
        getFillColor: d => d.fillColor,
        filled: true,
        extruded: false,
        pickable: false,
      }),
    )
    // Brush draft band (GPU, no SVG): a translucent rect over the dragged x-range.
    if (draft && valueDomain) {
      const ring: Ring = [
        [draft.a, yWindow.lo],
        [draft.b, yWindow.lo],
        [draft.b, yWindow.hi],
        [draft.a, yWindow.hi],
      ]
      marks.push(
        new SolidPolygonLayer<{ polygon: Ring }>({
          id: 'viz-candlestick-brush',
          data: [{ polygon: ring }],
          getPolygon: d => d.polygon,
          getFillColor: [59, 130, 246, 46],
          filled: true,
          extruded: false,
          pickable: false,
        }),
      )
    }
    out.push(...(bounds ? clipToBounds(marks, bounds) : marks))
    return out
  }, [bars, bounds, showFrame, showGrid, theme, selectedCodes, active, draft, valueDomain, yWindow])

  const commitBrush = (a: number, b: number) => {
    const ids = barsInXRange(barsRef.current, a, b)
    // PRODUCE through the handle: publish the covered bar ordinals (origin-attributed) — the
    // View's own CONSUME then re-lights exactly those bars.
    coordination.setSelection('candlestick', ids.length > 0 ? ids : null)
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ChartCanvas
        layers={layers}
        bounds={bounds ?? undefined}
        controller={!zoomEnabled && !brush}
        theme={theme}
        testId="viz-candlestick-view"
        interaction={
          brush
            ? {
                drawing: true,
                overlayTestId: 'viz-candlestick-brush-overlay',
                onPointerDown: world => {
                  draftStart.current = world[0]
                  setDraft({ a: world[0], b: world[0] })
                },
                onPointerMove: world => {
                  if (draftStart.current != null) setDraft({ a: draftStart.current, b: world[0] })
                },
                onPointerUp: world => {
                  const a = draftStart.current
                  draftStart.current = null
                  setDraft(null)
                  if (a != null) commitBrush(a, world[0])
                },
              }
            : undefined
        }
      />
      {/* Produce toolbar (brush toggle + clear). Small, top-left, over the canvas. */}
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 6,
          display: 'flex',
          gap: 4,
          font: '12px system-ui, sans-serif',
        }}
      >
        <button
          type="button"
          data-testid="viz-candlestick-brush"
          aria-pressed={brush}
          onClick={() => setBrush(v => !v)}
          style={{ ...TOOLBAR_BTN, background: brush ? SELECTED_BG : IDLE_BG }}
        >
          {brush ? '◈ Brush: ON' : 'Brush'}
        </button>
        <button
          type="button"
          data-testid="viz-candlestick-clear"
          onClick={() => {
            setDraft(null)
            draftStart.current = null
            coordination.clearSelection()
          }}
          style={{ ...TOOLBAR_BTN, background: IDLE_BG }}
        >
          Clear
        </button>
      </div>
    </div>
  )
}

/** A slightly darker variant of a candle color for its wick (reads on top of the body). */
function dimColor(color: RGBA): RGBA {
  return [Math.round(color[0] * 0.7), Math.round(color[1] * 0.7), Math.round(color[2] * 0.7), color[3]]
}

const TOOLBAR_BTN: React.CSSProperties = {
  pointerEvents: 'auto',
  padding: '3px 8px',
  borderRadius: 5,
  border: '1px solid rgba(128,128,128,0.5)',
  color: '#fff',
  cursor: 'pointer',
}
const SELECTED_BG = 'rgba(59,130,246,0.85)'
const IDLE_BG = 'rgba(30,30,30,0.75)'

// ── the thin adapter (uniform ChartViewProps → CandlestickView props) ────────────────────
// Spreads the resolved `model.bindings` onto the View AND forwards the injected coordination
// handle — exactly the shape of the built-in adapters in `installBuiltins.tsx`.
function CandlestickAdapter({ model, source, coordination }: ChartViewProps): ReactNode {
  const b = model.bindings
  return (
    <CandlestickView
      source={source}
      indexKey={bindingValue(b, 'index')}
      openKey={bindingValue(b, 'open')}
      highKey={bindingValue(b, 'high')}
      lowKey={bindingValue(b, 'low')}
      closeKey={bindingValue(b, 'close')}
      coordination={coordination}
    />
  )
}

/** The candlestick chart-type descriptor (registered via the `CandlestickChart` installer). */
export const candlestickDescriptor: ChartTypeDescriptor = {
  type: 'candlestick',
  coordinateSystem: 'chart2d',
  view: CandlestickAdapter,
  bindingSchema: CANDLESTICK_SCHEMA,
  capabilities: {
    consumesSelection: true,
    producesSelection: true,
    dataZoomAxes: ['x', 'y'],
  },
  model: candlestickModel,
}

/**
 * The self-registering extension: `use(CandlestickChart)` registers ONLY the `candlestick` type
 * through the same `registerChartType` seam the built-ins use — ZERO core edits. Stable
 * module-level object so `use()` dedupes it by identity across repeated installs.
 */
export const CandlestickChart: Extension = {
  install: r => r.registerChartType(candlestickDescriptor),
}
