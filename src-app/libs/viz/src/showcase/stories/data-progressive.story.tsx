// data-progressive.story.tsx — the FRIENDLY `<Viz data={…}>` progressive-streaming showcase
// (STREAMING_PROGRESSIVE_PLAN Wave 2a). The whole product point: hand a STREAM or an ARRAY straight
// to `<Viz>` and it owns EVERYTHING (fetch/reframe/bin/progressive emit/progress/cancel) — the app
// writes ZERO plumbing. A toggle flips between a WHOLE in-memory `Float32Array` (renders instantly)
// and a CHUNKED byte stream (fills blurry→sharp): the SAME `<Viz data>` one-liner, differing only in
// WHEN bytes arrive.
//
// It mirrors `window.__VIZ_TEST__ = { framesEmitted, rowsSeen, finalMatchesOneShot }` so the harness
// can assert: (a) a chunked stream emits MORE THAN ONE raster frame (progressive), and (b) the
// completed raster equals a one-shot bin of the whole cloud (`finalMatchesOneShot`, verified through
// the public accumulator pipeline, independent of the view's internal buffers).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Viz } from '../../react/Viz'
import type { VizData } from '../../adapter/vizData'
import type { VizProgress, ColorBy } from '../../viz-core/density/CpuRasterView'
import { DensityAccumulator, ChannelAccumulator } from '../../viz-core/density/accumulator'
import { binAndShade, toBitmapImage } from '../../viz-core/density/cpuRaster'
import { boundsForPositions } from '../../viz-core/density/densityBin'
import { registerStory } from '../registry'
import { usePointCount } from '../pointCountControl'
import { continuousColors, categoricalColors } from '../../viz-core/data/color'
import { sharedViewFromPositions } from '../../viz-core/timeline/FacetGrid'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer, SolidPolygonLayer, BitmapLayer } from '@deck.gl/layers'
import { DataFilterExtension } from '@deck.gl/extensions'
import { buildPointIndex } from '../../viz-core/spatial/pointIndex'
import { useAreaSelection, buildSelectionOutlineLayer } from '../../viz-core/selection/useAreaSelection'
import { useSelectionCamera } from '../../viz-core/selection/useSelectionCamera'
import {
  SELECTION_TOOLS,
  COMBINE_MODES,
  SELECTION_TOOL_LABEL,
  type SelectionTool,
  type CombineMode,
  type Vec2,
} from '../../viz-core/selection/areaGestures'

const DEFAULT_POINTS = 400_000
/** Adaptive-LOD cap: points drawn WHILE the camera is moving (subsample for a smooth zoom/pan). */
const LOD_CAP = 150_000
// Selectable presets for the draw-at-once threshold (the reveal cap AND the motion-LOD cap).
const THRESHOLD_PRESETS = [50_000, 100_000, 150_000, 250_000, 500_000, 1_000_000]
const CHUNK_POINTS = 20_000
const CHUNK_DELAY_MS = 30
/** Category slots for the color-by-label demo (a small K so the argmax hue reads clearly). */
const CATEGORY_COUNT = 6

function makeCloud(n: number, seed = 7): Float32Array {
  const xy = new Float32Array(n * 2)
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  // two gaussian-ish blobs so the density image has structure
  for (let i = 0; i < n; i++) {
    const cx = i % 2 === 0 ? 0.35 : 0.65
    const cy = i % 2 === 0 ? 0.4 : 0.6
    const rx = (rnd() + rnd() + rnd()) / 3 - 0.5
    const ry = (rnd() + rnd() + rnd()) / 3 - 0.5
    xy[i * 2] = Math.min(1, Math.max(0, cx + rx * 0.5))
    xy[i * 2 + 1] = Math.min(1, Math.max(0, cy + ry * 0.5))
  }
  return xy
}

/** Deterministic label-code + continuous-value columns aligned 1:1 with the cloud points, so the
 *  color-by-label / color-by-value demos have real channels to shade (item 5/6/14). */
function makeChannels(cloud: Float32Array): { labels: Uint16Array; values: Float32Array } {
  const n = cloud.length >> 1
  const labels = new Uint16Array(n)
  const values = new Float32Array(n)
  let s = 1337 >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  for (let i = 0; i < n; i++) {
    labels[i] = Math.floor(rnd() * CATEGORY_COUNT)
    // value correlates with x so the value raster has visible structure
    values[i] = cloud[i * 2] * 100 + (rnd() - 0.5) * 20
  }
  return { labels, values }
}

function rgbaEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

type Mode = 'array' | 'stream'
type ColorMode = 'density' | 'label' | 'value'

function DataProgressiveStory() {
  const [points, pointControl] = usePointCount(DEFAULT_POINTS)
  // The draw-at-once threshold (points mode): reveal + motion-LOD cap. Configurable in the toolbar.
  const [lodCap, setLodCap] = useState(LOD_CAP)
  const cloud = useMemo(() => makeCloud(points, 11), [points])
  const channels = useMemo(() => makeChannels(cloud), [cloud])
  const [mode, setMode] = useState<Mode>('stream')
  const [colorMode, setColorMode] = useState<ColorMode>('density')
  // RASTERIZE toggle: on ⇒ the progressive CPU-binned density raster (`<Viz data>`, blurry→sharp);
  // off ⇒ the SAME cloud drawn as RAW GPU points, so you can see the un-rasterized scatter.
  const [rasterize, setRasterize] = useState(true)
  // RASTER STYLE (rasterize on): 'cells' = the streaming `<Viz>` BitmapLayer (square texels);
  // 'dots' = each non-empty density cell drawn as a CIRCLE (a dot-density look — round, but still
  // O(cells), not O(N) points). The dot path is a static one-shot bin of the full cloud.
  const [rasterStyle, setRasterStyle] = useState<'cells' | 'dots'>('cells')
  // How many raw points are currently revealed (rasterize-OFF PROGRESSIVE reveal). In `stream` mode we
  // uncover CHUNK_POINTS more every CHUNK_DELAY_MS (matching the raster's chunk cadence) so the raw
  // scatter fills in progressively too; in `array` mode all points show at once (the whole-array path).
  const [shownCount, setShownCount] = useState(0)
  // Progressive-reveal progress for the points path (rasterize-off): 0–100. We reveal points up to
  // REVEAL_CAP, then STOP growing the plot (redrawing an ever-larger cloud is what slowed the tail)
  // and just advance this % for the remainder; at 100 we render the whole cloud in ONE final pass.
  const [revealPct, setRevealPct] = useState(100)
  const [progress, setProgress] = useState<VizProgress>({ rowsSeen: 0, coveragePct: null })
  const [framesEmitted, setFramesEmitted] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // WHOLE-ARRAY source: the plain typed array (re-iterable, instant). CHUNKED source: a RE-ITERABLE
  // byte stream (fresh generator per consumption — robust to StrictMode/restart) with small delays so
  // progressive frames accumulate. BOTH are handed to the identical `<Viz data>` prop.
  const streamData = useMemo<AsyncIterable<Uint8Array>>(() => {
    const cloudRef = cloud
    return {
      async *[Symbol.asyncIterator]() {
        const bytes = new Uint8Array(cloudRef.slice().buffer)
        const chunkBytes = CHUNK_POINTS * 8
        for (let o = 0; o < bytes.length; o += chunkBytes) {
          yield bytes.slice(o, o + chunkBytes)
          await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS))
        }
      },
    } as AsyncIterable<Uint8Array>
  }, [cloud])

  // Bare source for density (byte-identical to Wave 2a); object form carrying labels/value channels
  // when coloring by label/value (the ONE stream carries positions + the channel, offset-aligned).
  // MEMOIZED so `data`/`colorBy` identity is stable across renders (else the view restarts the stream
  // every render). Identity changes only on a genuine mode / colorMode switch.
  const data = useMemo<VizData>(() => {
    const positionsSource: Float32Array | AsyncIterable<Uint8Array> = mode === 'array' ? cloud : streamData
    return colorMode === 'density'
      ? positionsSource
      : { positions: positionsSource, labels: channels.labels, value: channels.values }
  }, [mode, colorMode, cloud, streamData, channels])
  const colorBy = useMemo<ColorBy>(
    () =>
      colorMode === 'label' ? { label: 'category' } : colorMode === 'value' ? { value: 'signal' } : 'density',
    [colorMode],
  )
  const shadeMode = colorMode === 'label' ? 'category' : colorMode // 'density' | 'category' | 'value'

  // Raw-points colors for the RASTERIZE-OFF view (computed only when off). value→viridis,
  // label→categorical palette, density→flat (overplot + additive conveys density).
  const pointColors = useMemo<Uint8Array | null>(() => {
    if (rasterize) return null
    if (colorMode === 'value') return continuousColors(channels.values, { colormap: 'viridis' }).colors
    if (colorMode === 'label') return categoricalColors(channels.labels, {})
    const c = new Uint8Array(points * 4)
    for (let i = 0; i < points; i++) {
      c[i * 4] = 70
      c[i * 4 + 1] = 130
      c[i * 4 + 2] = 180
      c[i * 4 + 3] = 150
    }
    return c
  }, [rasterize, colorMode, channels, points])
  const fitView = useMemo(() => sharedViewFromPositions(cloud, 640), [cloud])

  // ── SELECTION over the raster/points (works in BOTH rasterize states) ──────────────────────────
  // The story owns the camera (controlled `viewState`) and shares it with the base (Viz raster OR the
  // points deck) AND a transparent selection overlay, so a lasso/rect drawn over the DENSITY IMAGE
  // hit-tests the underlying cloud and its outline + highlighted points stay ANCHORED as you pan/zoom.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const [viewState, setViewState] = useState<OrthographicViewState>(fitView)
  useEffect(() => setViewState(fitView), [fitView]) // reframe when the cloud (point count) changes
  // STATIC PAN/ZOOM toggle (like Perf smoke): on ⇒ drag/scroll pan+zoom the view; off ⇒ the camera is
  // LOCKED (a fixed static frame — every camera change is ignored, so the base + selection stay put).
  const [panZoom, setPanZoom] = useState(true)
  // ADAPTIVE LOD (points mode): while the user is INTERACTING — panning/zooming OR drawing/dragging a
  // selection — draw only a representative SUBSAMPLE of the cloud so it stays smooth at millions of
  // points; snap back to full detail when they STOP. The cloud is randomly ordered, so its first
  // LOD_CAP points are a fair sample.
  //   • CAMERA busy: a short debounce (pan/zoom fire continuous ticks).
  //   • GESTURE active: held for the WHOLE pointer-down→up (+ any polygon draft) — NOT a short timer,
  //     which would expire between spaced polygon clicks and flip full↔subsample mid-gesture (the lag).
  const [cameraBusy, setCameraBusy] = useState(false)
  const [gestureActive, setGestureActive] = useState(false)
  const interactTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markCameraBusy = useCallback(() => {
    setCameraBusy(true)
    if (interactTimer.current) clearTimeout(interactTimer.current)
    interactTimer.current = setTimeout(() => setCameraBusy(false), 160)
  }, [])
  // Clear a pending busy-debounce on unmount (no setState-after-unmount).
  useEffect(() => () => { if (interactTimer.current) clearTimeout(interactTimer.current) }, [])
  const applyViewState = useCallback(
    (next: OrthographicViewState | ((vs: OrthographicViewState) => OrthographicViewState)) => {
      if (!panZoom) return
      setViewState(next)
      markCameraBusy()
    },
    [panZoom, markCameraBusy],
  )
  const [selTool, setSelTool] = useState<SelectionTool>('pan')
  const [selMode, setSelMode] = useState<CombineMode>('add')
  const pointIndex = useMemo(() => buildPointIndex(cloud), [cloud])
  const filterExt = useMemo(() => new DataFilterExtension({ filterSize: 1 }), [])
  // A 2D (x,y) filter for VIEWPORT CULLING the points base: only points inside the current view draw,
  // so zooming IN progressively drops off-screen points (a uniform filterRange swap — no re-upload).
  const filterExt2 = useMemo(() => new DataFilterExtension({ filterSize: 2 }), [])

  const unprojectAt = useCallback(
    (vs: OrthographicViewState, clientX: number, clientY: number): Vec2 | null => {
      const el = containerRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState: vs })
      if (!vp) return null
      const world = vp.unproject([clientX - rect.left, clientY - rect.top])
      return [world[0], world[1]]
    },
    [view],
  )
  const unproject = useCallback(
    (clientX: number, clientY: number): Vec2 | null => unprojectAt(viewState, clientX, clientY),
    [unprojectAt, viewState],
  )
  // The current viewport's world rect (PADDED), for viewport-culling the points base. Recomputed per
  // camera change (cheap: one makeViewport + two unprojects).
  const viewBounds = useMemo<[number, number, number, number] | null>(() => {
    const el = containerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState })
    if (!vp) return null
    const a = vp.unproject([0, 0])
    const c = vp.unproject([rect.width, rect.height])
    const minX = Math.min(a[0], c[0])
    const maxX = Math.max(a[0], c[0])
    const minY = Math.min(a[1], c[1])
    const maxY = Math.max(a[1], c[1])
    const padX = (maxX - minX) * 0.12
    const padY = (maxY - minY) * 0.12
    return [minX - padX, maxX + padX, minY - padY, maxY + padY]
  }, [view, viewState])
  const sel = useAreaSelection({
    positions: cloud,
    totalPoints: points,
    pointIndex,
    unproject,
    tool: selTool,
    mode: selMode,
  })
  const cam = useSelectionCamera({ viewState, setViewState: applyViewState, unprojectAt })
  const rawHandlers = useMemo(() => cam.wrapPointerHandlers(sel.pointerHandlers), [cam, sel.pointerHandlers])
  // Hold `gestureActive` for the WHOLE pointer-down→up so the LOD stays subsampled for the entire
  // draw/drag (no flicker back to full render mid-gesture).
  const overlayHandlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        setGestureActive(true)
        rawHandlers.onPointerDown(e)
      },
      onPointerMove: rawHandlers.onPointerMove,
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
        rawHandlers.onPointerUp(e)
        setGestureActive(false)
      },
    }),
    [rawHandlers],
  )
  const selecting = selTool !== 'pan'
  // BUSY = camera moving OR a pointer gesture in progress OR a polygon draft open (spans the clicks).
  const interacting = cameraBusy || gestureActive || sel.polyDraftLength > 0

  // Attach the wheel-zoom NON-passively (React's JSX `onWheel` is passive, so the hook's
  // `preventDefault()` warns + can't stop page scroll). A ref keeps the latest handler without
  // re-binding on every camera change.
  const overlayDivRef = useRef<HTMLDivElement | null>(null)
  const wheelRef = useRef(cam.onWheel)
  wheelRef.current = cam.onWheel
  useEffect(() => {
    const el = overlayDivRef.current
    if (!el) return
    const h = (e: WheelEvent) => wheelRef.current(e as unknown as React.WheelEvent<HTMLElement>)
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [selecting])

  const hasSel = sel.selCount > 0
  // The selected points are highlighted in the raster's OWN viridis colors (by value) — the SAME
  // visual language in both modes (no jarring red). Computed only while a selection exists.
  const highlightColors = useMemo(
    () => (hasSel ? continuousColors(channels.values, { colormap: 'viridis' }).colors : null),
    [hasSel, channels],
  )
  // The data extent, for the raster-mode dim veil (a translucent white quad that fades the base
  // density image the same way the points base is dimmed by opacity).
  const dataBounds = useMemo(() => boundsForPositions(cloud), [cloud])

  // DOT-DENSITY base ('dots' style): bin the cloud into a COARSE grid, then draw each NON-EMPTY cell as
  // a circle at its world center, colored by the cell's density. Round like points, but O(cells) not
  // O(N). A coarse grid keeps the dots visibly circular. One-shot bin of the full cloud.
  const dotDensity = useMemo(() => {
    if (!rasterize || rasterStyle !== 'dots') return null
    const W = 160
    const H = 120
    const img = binAndShade({ positions: cloud, bounds: dataBounds, width: W, height: H, normalize: 'log', flipY: false })
    const rgba = img.rgba
    let k = 0
    for (let i = 0; i < W * H; i++) if (rgba[i * 4 + 3] > 0) k++
    const pos = new Float32Array(k * 2)
    const col = new Uint8Array(k * 4)
    const spanX = dataBounds.maxX - dataBounds.minX
    const spanY = dataBounds.maxY - dataBounds.minY
    let j = 0
    for (let row = 0; row < H; row++) {
      for (let cx = 0; cx < W; cx++) {
        const idx = (row * W + cx) * 4
        if (rgba[idx + 3] === 0) continue
        pos[j * 2] = dataBounds.minX + ((cx + 0.5) / W) * spanX
        pos[j * 2 + 1] = dataBounds.minY + ((row + 0.5) / H) * spanY
        col[j * 4] = rgba[idx]
        col[j * 4 + 1] = rgba[idx + 1]
        col[j * 4 + 2] = rgba[idx + 2]
        col[j * 4 + 3] = rgba[idx + 3]
        j++
      }
    }
    return { positions: pos, colors: col, count: k, cellW: spanX / W }
  }, [rasterize, rasterStyle, cloud, dataBounds])

  const dotLayer = useMemo(() => {
    if (!dotDensity) return null
    return new ScatterplotLayer({
      id: 'dot-density',
      data: {
        length: dotDensity.count,
        attributes: {
          getPosition: { value: dotDensity.positions, size: 2 },
          getFillColor: { value: dotDensity.colors, size: 4, normalized: true },
        },
      },
      radiusUnits: 'common',
      getRadius: dotDensity.cellW * 0.6, // ~a cell wide → circles just kiss, reading as a dot field
      radiusMinPixels: 1,
      radiusMaxPixels: 22,
      stroked: false,
      filled: true,
      pickable: false,
    })
  }, [dotDensity])

  // DEBOUNCE the (O(N)) selected re-bin: only rebuild the selected-density image when the gesture
  // SETTLES (~160ms idle), NOT on every drag/preview frame — recomputing it per frame was the
  // "painfully slow" selection at scale. The outline + count still update live; only the density fill
  // waits for you to stop. A ref keeps the latest mask so the debounced memo reads the settled one.
  const [settledSel, setSettledSel] = useState<{ mask: Uint8Array; epoch: number } | null>(null)
  useEffect(() => {
    const id = setTimeout(() => setSettledSel({ mask: sel.selected.slice(), epoch: sel.selEpoch }), 160)
    return () => clearTimeout(id)
  }, [sel.selEpoch, sel.selected])

  // RASTER-MODE selection highlight: re-bin ONLY the selected points into their OWN density image, so
  // the selection is rendered the SAME way as the base (density cells, not circular points) AND stays
  // O(pixels). Rebuilt on the DEBOUNCED epoch (see above), so a live drag doesn't re-bin every frame.
  const selectedRaster = useMemo(() => {
    if (!rasterize || !settledSel) return null
    const m = settledSel.mask
    let k = 0
    for (let i = 0; i < points; i++) if (m[i]) k++
    if (k === 0) return null
    const pos = new Float32Array(k * 2)
    let j = 0
    for (let i = 0; i < points; i++) {
      if (m[i]) {
        pos[j * 2] = cloud[i * 2]
        pos[j * 2 + 1] = cloud[i * 2 + 1]
        j++
      }
    }
    return binAndShade({ positions: pos, bounds: dataBounds, width: 480, height: 360, normalize: 'log', flipY: true })
  }, [rasterize, settledSel, cloud, points, dataBounds])

  // Raw-points base layer (points mode). Two bounded-cost tricks stacked, both re-upload-free:
  //   • PROGRESSIVE REVEAL + MOTION LOD via the instance COUNT (`data.length`): reveal the first N over
  //     time; while the camera MOVES, cap to LOD_CAP so a zoom/pan stays smooth; snap to full on idle.
  //   • VIEWPORT CULL via a 2D (x,y) filter clamped to the padded view rect: only on-screen points draw,
  //     so zooming IN progressively drops off-screen points (a uniform filterRange swap per camera).
  // The cloud is randomly ordered, so the first `count` points are a fair subsample.
  const pointsLayer = useMemo(() => {
    if (rasterize || !pointColors) return null
    const drawn = interacting ? Math.min(shownCount, lodCap) : shownCount
    return new ScatterplotLayer({
      id: 'progressive-raw-points',
      data: {
        length: drawn,
        attributes: {
          getPosition: { value: cloud, size: 2 },
          getFillColor: { value: pointColors, size: 4, normalized: true },
          getFilterValue: { value: cloud, size: 2 }, // (x,y) → viewport-cull filter
        },
      },
      radiusUnits: 'pixels',
      getRadius: 2,
      radiusMinPixels: 1,
      radiusMaxPixels: 6,
      stroked: false,
      filled: true,
      opacity: hasSel ? 0.25 : 1,
      pickable: false,
      extensions: [filterExt2],
      filterRange: viewBounds
        ? [[viewBounds[0], viewBounds[1]], [viewBounds[2], viewBounds[3]]]
        : [[-1e18, 1e18], [-1e18, 1e18]],
    })
  }, [rasterize, pointColors, cloud, shownCount, interacting, hasSel, filterExt2, viewBounds, lodCap])

  // Transparent overlay: the committed/draft selection OUTLINE + the SELECTED points highlighted bright
  // (so the selection reads OVER the density raster). Both anchor in the shared `viewState`.
  const overlayLayers = useMemo(() => {
    const out: unknown[] = []
    if (hasSel) {
      // 1) RASTER mode only: a translucent veil over the data extent that FADES the base density
      //    image (the <Viz> raster shows through the transparent overlay) — the raster analogue of
      //    dimming the points base, so the selected subset reads as emphasis rather than foreign marks.
      if (rasterize) {
        out.push(
          new SolidPolygonLayer<{ polygon: number[][] }>({
            id: 'sel-dim-veil',
            data: [
              {
                polygon: [
                  [dataBounds.minX, dataBounds.minY],
                  [dataBounds.maxX, dataBounds.minY],
                  [dataBounds.maxX, dataBounds.maxY],
                  [dataBounds.minX, dataBounds.maxY],
                ],
              },
            ],
            getPolygon: ((d: { polygon: number[][] }) => d.polygon) as never,
            getFillColor: [255, 255, 255, 165],
            pickable: false,
          }),
        )
      }
      // 2) the SELECTED subset, rendered the SAME WAY as the base so it reads consistently:
      //    RASTER mode → the selected points re-binned into their own density image (cells, viridis,
      //    O(pixels)); POINTS mode → the selected points as circles in their natural viridis colors.
      if (rasterize) {
        if (selectedRaster) {
          out.push(
            new BitmapLayer({
              id: 'sel-raster',
              image: toBitmapImage(selectedRaster) as never,
              bounds: [dataBounds.minX, dataBounds.minY, dataBounds.maxX, dataBounds.maxY],
              textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
              pickable: false,
            }),
          )
        }
      } else if (highlightColors && settledSel && !interacting) {
        // POINTS mode: highlight the selected points, using the DEBOUNCED (settled) mask. SKIPPED while
        // interacting (drawing/dragging/panning) — the O(selected) sprite draw is the per-frame cost, so
        // during a gesture we show the outline only and paint the highlight when it settles.
        out.push(
          new ScatterplotLayer({
            id: 'sel-highlight',
            data: {
              length: points,
              attributes: {
                getPosition: { value: cloud, size: 2 },
                getFillColor: { value: highlightColors, size: 4, normalized: true },
                getFilterValue: { value: settledSel.mask, size: 1 },
              },
            },
            radiusUnits: 'pixels',
            getRadius: 2.5,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 9,
            stroked: false,
            filled: true,
            pickable: false,
            extensions: [filterExt],
            filterRange: [1, 1],
            updateTriggers: { getFilterValue: settledSel.epoch },
          }),
        )
      }
    }
    const outline = buildSelectionOutlineLayer(sel.shapes)
    if (outline) out.push(outline)
    return out
  }, [hasSel, rasterize, highlightColors, selectedRaster, settledSel, interacting, dataBounds, sel.shapes, cloud, points, filterExt])

  // Rasterize-OFF progressive reveal (bounded-tail). The old loop grew the drawn set by CHUNK_POINTS
  // every tick all the way to `points`, so each of the LAST ticks redrew a near-full cloud — the reveal
  // got slower and slower at the end. Instead:
  //   • Phase 1 (0 → REVEAL_CAP): reveal points incrementally so you SEE it build up — bounded N, fast.
  //   • Phase 2 (REVEAL_CAP → points): STOP adding points (plot pinned at the cap); just advance a
  //     progress % for the remaining rows — no ever-larger redraw.
  //   • At 100%: render the WHOLE cloud in ONE final pass.
  // `array` mode is instant (whole-array path), so it just shows everything at once.
  useEffect(() => {
    if (rasterize) return
    if (mode === 'array') {
      setShownCount(points)
      setRevealPct(100)
      return
    }
    const cap = Math.min(lodCap, points)
    setShownCount(0)
    setRevealPct(points <= cap ? 100 : 0)
    let n = 0
    const id = setInterval(() => {
      n = Math.min(points, n + CHUNK_POINTS)
      if (n <= cap) {
        // Phase 1 — reveal up to the threshold (redraw cost bounded by REVEAL_CAP).
        setShownCount(n)
        if (n >= points) {
          setRevealPct(100)
          clearInterval(id)
        }
      } else {
        // Phase 2 — past the threshold: don't grow the plot, just report progress on the remainder.
        setRevealPct(Math.min(100, Math.round(((n - cap) / (points - cap)) * 100)))
        if (n >= points) {
          setShownCount(points) // ONE final full render
          setRevealPct(100)
          clearInterval(id)
        }
      }
    }, CHUNK_DELAY_MS)
    return () => clearInterval(id)
  }, [rasterize, mode, points, lodCap])

  // Value scale (KLL p1/p99) + distinct category count — computed INDEPENDENTLY through the public
  // ChannelAccumulator (like `finalMatchesOneShot`), so the harness can assert the color-scale drives
  // off the sketch without reaching into the view's internals.
  const channelSignals = useMemo(() => {
    const acc = new ChannelAccumulator(
      { bounds: boundsForPositions(cloud), width: 64, height: 48 },
      { value: true, categories: CATEGORY_COUNT, distinctLabels: true },
    )
    for (let o = 0; o < cloud.length; o += CHUNK_POINTS * 2) {
      const end = Math.min(cloud.length, o + CHUNK_POINTS * 2)
      const from = o >> 1
      acc.append(cloud.slice(o, end), {
        labels: channels.labels.slice(from, end >> 1),
        values: channels.values.slice(from, end >> 1),
      })
    }
    const [valueP1, valueP99] = acc.valueDomain()
    return { valueP1, valueP99, categoryCount: Math.round(acc.distinctLabels() ?? 0) }
  }, [cloud, channels])

  // `finalMatchesOneShot`: independently verify the accumulator pipeline the view uses converges to
  // the exact one-shot raster (feed the cloud in chunks → final shade === binAndShade). This proves
  // the progressive-final invariant without reaching into the view's private buffers.
  const finalMatchesOneShot = useMemo(() => {
    const W = 64
    const H = 48
    const bounds = boundsForPositions(cloud)
    const acc = new DensityAccumulator({ bounds, width: W, height: H })
    for (let o = 0; o < cloud.length; o += CHUNK_POINTS * 2) acc.append(cloud.slice(o, o + CHUNK_POINTS * 2))
    const final = acc.shade({ final: true })
    const oneShot = binAndShade({ positions: cloud, bounds, width: W, height: H })
    return rgbaEqual(final.rgba, oneShot.rgba)
  }, [cloud])

  // Poll the CpuRasterView's committed-frame count (`data-frame-count`) so the harness can assert a
  // chunked stream produced MORE THAN ONE frame (blurry→sharp).
  useEffect(() => {
    const id = setInterval(() => {
      const el = rootRef.current?.querySelector('[data-testid="viz-cpu-raster-view"]')
      const n = el ? Number(el.getAttribute('data-frame-count') ?? '0') : 0
      setFramesEmitted((prev) => (n > prev ? n : prev))
    }, 120)
    return () => clearInterval(id)
  }, [])

  // Reset the frame count on a mode / colorBy switch (a fresh stream or re-bind).
  useEffect(() => {
    setFramesEmitted(0)
    setProgress({ rowsSeen: 0, coveragePct: null })
  }, [mode, colorMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      framesEmitted,
      rowsSeen: progress.rowsSeen,
      coveragePct: progress.coveragePct,
      finalMatchesOneShot,
      mode,
      colorMode,
      shadeMode,
      valueP1: channelSignals.valueP1,
      valueP99: channelSignals.valueP99,
      categoryCount: channelSignals.categoryCount,
      totalPoints: points,
    }
  }, [framesEmitted, progress, finalMatchesOneShot, mode, colorMode, shadeMode, channelSignals, points])

  return (
    <div
      ref={rootRef}
      data-testid="viz-data-progressive-story"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Progressive data</strong>
        {pointControl}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '12px system-ui, sans-serif' }}>
          <span style={{ opacity: 0.8 }}>Draw cap</span>
          <select
            data-testid="dp-threshold"
            value={lodCap}
            onChange={e => setLodCap(Number(e.target.value))}
            title="Points-mode threshold: reveal up to this many, then show progress + one final full render; also the motion-LOD cap while panning/zooming."
            style={{ font: 'inherit', padding: '2px 6px', borderRadius: 4 }}
          >
            {(THRESHOLD_PRESETS.includes(lodCap) ? THRESHOLD_PRESETS : [...THRESHOLD_PRESETS, lodCap].sort((a, b) => a - b)).map(n => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <span style={{ opacity: 0.7 }}>{points.toLocaleString()} points · one-liner `&lt;Viz data&gt;`</span>
        <span role="group" aria-label="Data source" style={{ display: 'inline-flex', gap: 4 }}>
          {(['stream', 'array'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={`viz-data-mode-${m}`}
              onClick={() => setMode(m)}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                border: '1px solid #ccc',
                cursor: 'pointer',
                background: mode === m ? '#3355dd' : '#f2f2f2',
                color: mode === m ? '#fff' : '#222',
              }}
            >
              {m === 'stream' ? 'Chunked stream' : 'Whole array'}
            </button>
          ))}
        </span>
        <span role="group" aria-label="Color by" style={{ display: 'inline-flex', gap: 4 }}>
          {(['density', 'label', 'value'] as ColorMode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={colorMode === m}
              data-testid={`viz-color-mode-${m}`}
              onClick={() => setColorMode(m)}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                border: '1px solid #ccc',
                cursor: 'pointer',
                background: colorMode === m ? '#227744' : '#f2f2f2',
                color: colorMode === m ? '#fff' : '#222',
              }}
            >
              {m === 'density' ? 'Density' : m === 'label' ? 'By label' : 'By value'}
            </button>
          ))}
        </span>
        <button
          type="button"
          data-testid="viz-rasterize-toggle"
          aria-pressed={rasterize}
          onClick={() => setRasterize(v => !v)}
          style={{
            padding: '2px 10px',
            borderRadius: 4,
            border: '1px solid #ccc',
            cursor: 'pointer',
            background: rasterize ? '#227744' : '#f2f2f2',
            color: rasterize ? '#fff' : '#222',
          }}
        >
          Rasterize: {rasterize ? 'on' : 'off'}
        </button>
        {rasterize && (
          <span role="group" aria-label="Raster style" style={{ display: 'inline-flex', gap: 4 }}>
            {(['cells', 'dots'] as const).map(s => (
              <button
                key={s}
                type="button"
                data-testid={`dp-raster-style-${s}`}
                aria-pressed={rasterStyle === s}
                onClick={() => setRasterStyle(s)}
                style={{
                  padding: '2px 10px',
                  borderRadius: 4,
                  border: '1px solid #ccc',
                  cursor: 'pointer',
                  background: rasterStyle === s ? '#3355dd' : '#f2f2f2',
                  color: rasterStyle === s ? '#fff' : '#222',
                }}
              >
                {s === 'cells' ? 'Cells' : 'Dots'}
              </button>
            ))}
          </span>
        )}
        <button
          type="button"
          data-testid="dp-panzoom-toggle"
          aria-pressed={panZoom}
          onClick={() => setPanZoom(v => !v)}
          title="Enable/disable drag-to-pan + scroll-to-zoom (a locked static frame when off)"
          style={{
            padding: '2px 10px',
            borderRadius: 4,
            border: '1px solid #ccc',
            cursor: 'pointer',
            background: panZoom ? '#3355dd' : '#f2f2f2',
            color: panZoom ? '#fff' : '#222',
          }}
        >
          Static pan/zoom: {panZoom ? 'on' : 'off'}
        </button>
        {/* SELECTION over the raster/points — draw a region, it hit-tests the underlying cloud. */}
        <span role="group" aria-label="Selection tool" data-testid="dp-selection-toolbar" style={{ display: 'inline-flex', gap: 4 }}>
          {SELECTION_TOOLS.map(t => (
            <button
              key={t}
              type="button"
              data-testid={`dp-sel-tool-${t}`}
              aria-pressed={selTool === t}
              onClick={() => setSelTool(t)}
              style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid #ccc', cursor: 'pointer', fontWeight: selTool === t ? 700 : 400 }}
            >
              {SELECTION_TOOL_LABEL[t]}
            </button>
          ))}
        </span>
        {selecting && (
          <span role="group" aria-label="Combine mode" style={{ display: 'inline-flex', gap: 4 }}>
            {COMBINE_MODES.map(m => (
              <button
                key={m}
                type="button"
                data-testid={`dp-sel-mode-${m}`}
                aria-pressed={selMode === m}
                onClick={() => setSelMode(m)}
                style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid #ccc', cursor: 'pointer', fontWeight: selMode === m ? 700 : 400 }}
              >
                {m}
              </button>
            ))}
          </span>
        )}
        {selTool === 'polygon' && (
          <button type="button" data-testid="dp-sel-finish" onClick={sel.finishPolygon} disabled={sel.polyDraftLength < 3}>
            Finish polygon ({sel.polyDraftLength})
          </button>
        )}
        {sel.selCount > 0 && (
          <button type="button" data-testid="dp-sel-clear" onClick={sel.clearSelection}>
            Clear
          </button>
        )}
        <span data-testid="dp-selection-count" style={{ opacity: 0.7 }}>{sel.selCount.toLocaleString()} selected</span>
        <span data-testid="viz-data-readout" style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.85 }}>
          {rasterize
            ? `frames=${framesEmitted} · rows=${progress.rowsSeen.toLocaleString()}` +
              `${progress.coveragePct != null ? ` · ${progress.coveragePct.toFixed(0)}%` : ''} · shade=${shadeMode}`
            : !rasterize && revealPct < 100
              ? `raw points · showing first ${Math.min(lodCap, points).toLocaleString()} · loading rest ${revealPct}%`
              : `raw points · ${shownCount.toLocaleString()} / ${points.toLocaleString()} revealed` +
                `${interacting && shownCount > lodCap ? ` · LOD ${lodCap.toLocaleString()} (moving)` : ''} · not rasterized`}
        </span>
        {!rasterize && revealPct < 100 && (
          <span
            role="progressbar"
            aria-valuenow={revealPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Loading remaining points"
            data-testid="dp-reveal-progress"
            style={{ display: 'inline-block', width: 90, height: 6, borderRadius: 3, background: '#e2e2e2', overflow: 'hidden', verticalAlign: 'middle' }}
          >
            <span style={{ display: 'block', height: '100%', width: `${revealPct}%`, background: '#3355dd', transition: 'width 60ms linear' }} />
          </span>
        )}
        <span style={{ opacity: 0.5, fontSize: 11 }}>
          {!panZoom
            ? 'camera locked (static frame)'
            : selecting
              ? 'Space+drag or middle-drag to pan · scroll to zoom'
              : 'drag to pan · scroll to zoom'}
        </span>
      </div>
      <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {/* BASE — the progressive density raster (`<Viz data>`) OR the raw points; BOTH share the
            controlled `viewState`, so the selection overlay above stays aligned over either. */}
        {rasterize && rasterStyle === 'dots' ? (
          // DOT-DENSITY: each density cell as a circle (round, O(cells)). One-shot bin, own DeckGL.
          <div style={{ position: 'absolute', inset: 0 }}>
            <DeckGL
              views={view}
              controller={panZoom}
              viewState={viewState as never}
              onViewStateChange={((p: { viewState: OrthographicViewState }) => applyViewState(p.viewState)) as never}
              layers={dotLayer ? [dotLayer] : []}
            />
          </div>
        ) : rasterize ? (
          <Viz
            data={data}
            colorBy={colorBy}
            onProgress={setProgress}
            viewState={viewState}
            onViewStateChange={applyViewState}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0 }}>
            <DeckGL
              views={view}
              controller={panZoom}
              viewState={viewState as never}
              onViewStateChange={((p: { viewState: OrthographicViewState }) => applyViewState(p.viewState)) as never}
              layers={pointsLayer ? [pointsLayer] : []}
            />
          </div>
        )}
        {/* Transparent selection overlay — same camera, pointer-transparent so the base gets pan/zoom in
            Pan mode; the draw overlay below captures when a selection tool is active. */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <DeckGL
            views={view}
            controller={false}
            viewState={viewState as never}
            layers={overlayLayers as never}
            style={{ background: 'transparent' } as never}
          />
        </div>
        {selecting && (
          <div
            ref={overlayDivRef}
            data-testid="dp-selection-overlay"
            onPointerDown={overlayHandlers.onPointerDown}
            onPointerMove={overlayHandlers.onPointerMove}
            onPointerUp={overlayHandlers.onPointerUp}
            style={{ position: 'absolute', inset: 0, cursor: cam.cursorFor(sel.cursor), touchAction: 'none' }}
          />
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'data-progressive',
  category: 'Scale / perf',
  title: 'Progressive data — hand a stream or array straight to <Viz data> (blurry→sharp)',
  covers: 'data-progressive',
  Component: DataProgressiveStory,
})
