// RasterImageView.tsx — a gigapixel-capable, multi-channel RASTER IMAGE view built on
// Viv (@hms-dbmi/viv). Viv IS a set of deck.gl layers, so this composes straight into
// the same <DeckGL> + OrthographicView the rest of viz-core uses (DeckScatterCanvas /
// ImageCanvas), replacing the single 16384px-capped RGBA `BitmapLayer` with:
//   • MultiscaleImageLayer — a pyramidal, TILED loader (loader.length > 1), so a
//     gigapixel image streams only the visible tiles at the visible resolution; and
//   • ImageLayer — the small single-resolution case (loader.length === 1).
// Both drive Viv's XRLayer channel model: per-channel additive compositing with
// per-channel `colors` (RGB), `contrastLimits` ([begin,end] ramp), and
// `channelsVisible`, via the `ColorPaletteExtension`. The affine placement is our
// existing `modelMatrix` (column-major 16, from `imageMeta.imageModelMatrix`).
//
// DEPENDENCY: `@hms-dbmi/viv` (+ its transitive `@vivjs/*`) must be installed. It IS
// on this branch (see package.json). If a consumer strips it, this module won't
// resolve — it deliberately has no BitmapLayer fallback baked in because the whole
// point is the tiled/multichannel pipeline; the story documents the install path.
//
// Framework-agnostic (viz-core): depends ONLY on @deck.gl/* + @math.gl + @hms-dbmi/viv
// + react. DEC-28 generic naming — image/channel, nothing biological.

import { useMemo, useState, useCallback } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import type { PixelSource } from '@vivjs/types'
import { buildRasterImageLayers } from './rasterImageLayers'
import { contrastMaxForDtype, reconcileChannelsToLoader } from './channelState'
import type { ChannelLabels, RasterChannelState } from './rasterImageLayers'

// The channel/loader model is defined canonically in `rasterImageLayers.ts` (the shared
// builder); re-export here so existing consumers keep importing them from this module.
export type { ChannelLabels, RasterChannelState } from './rasterImageLayers'

/** Stable owning-cell id for the STANDALONE view — its layer renders as
 *  `raster-image::image` into this view's single OrthographicView. */
const STANDALONE_CELL_ID = 'raster-image'

export interface RasterImageViewProps {
  /**
   * the resolution pyramid — `PixelSource[]`, index 0 = FULL resolution, each
   * subsequent entry half-scale. `length > 1` ⇒ MultiscaleImageLayer (tiled);
   * `length === 1` ⇒ ImageLayer.
   */
  loader: PixelSource<ChannelLabels>[]
  /** initial per-channel state; the view owns the live copy after mount. */
  channels: RasterChannelState[]
  /**
   * column-major 16 modelMatrix placing the FULL-RES pixel grid into world/global
   * space (from `imageMeta.imageModelMatrix`). Identity when omitted.
   */
  modelMatrix?: number[]
  /**
   * upper bound of the contrast sliders. Absent ⇒ DERIVED from the loader's dtype
   * (`contrastMaxForDtype`), not defaulted to 255.
   *
   * It was defaulted, and `installBuiltins`' `ImageAdapter` never passes it, so the standalone
   * path put a `max=255` slider on a `Uint16` image whose seeded window is `[0, 65535]`: the DOM
   * clamps the value to 255, the slider sits pinned right, and the first touch collapses the
   * window from 65535 to <=255 — the image blows out with no feedback. The grid path threads the
   * real bound (`useGridRaster` -> `pyrEntry.contrastMax` -> the pane form); this one now derives
   * the same number from the same source rather than guessing 8-bit.
   */
  contrastMax?: number
  /** OPTIONAL single additive colormap (ITEM-2 seam) — forwarded to the builder; when set
   *  the layer uses `AdditiveColormapExtension` instead of per-channel colors. */
  colormap?: string
  /** hide the built-in channel-control panel (e.g. when a parent renders its own). */
  hideControls?: boolean
}

/** world bounds of the level-0 image after the modelMatrix, for the initial camera. */
function worldExtent(width: number, height: number, m: number[] | undefined) {
  const apply = (x: number, y: number): [number, number] => {
    if (!m) return [x, y]
    return [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]]
  }
  const corners = [apply(0, 0), apply(width, 0), apply(0, height), apply(width, height)]
  const xs = corners.map(c => c[0])
  const ys = corners.map(c => c[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

export function RasterImageView({
  loader,
  channels: initialChannels,
  modelMatrix,
  contrastMax: contrastMaxProp,
  colormap,
  hideControls = false,
}: RasterImageViewProps) {
  const [channels, setChannels] = useState<RasterChannelState[]>(initialChannels)

  const view = useMemo(() => new OrthographicView({ id: STANDALONE_CELL_ID, flipY: true }), [])

  // Initial camera: center on the image, zoom to fit a nominal viewport. The canvas is
  // uncontrolled (initialViewState + controller), so this is read only at mount; the
  // user pans/zooms freely afterwards.
  //
  // flipY NOTE: the view is `flipY: true`, but this initial extent is deliberately
  // flip-INVARIANT and needs no flip term. `worldExtent` frames the image via its
  // centroid (`cx`/`cy`, the midpoint of the corners) and the ABSOLUTE spans
  // (`maxX-minX`, `maxY-minY`) — both are unchanged when the y-axis direction flips
  // (a midpoint and a |span| don't depend on axis sign). `flipY` only decides which
  // screen direction world-y maps to during rendering, not where the image's center is
  // or how large it is; so centering on the centroid and fitting the larger span frames
  // the image correctly on first render under either flip. (Verified empirically on GPU.)
  const initialViewState = useMemo<OrthographicViewState>(() => {
    const src = loader[0]
    // shape is [channels, height, width] for labels ['c','y','x'].
    const width = src?.shape[src.shape.length - 1] ?? 512
    const height = src?.shape[src.shape.length - 2] ?? 512
    const ext = worldExtent(width, height, modelMatrix)
    const worldW = Math.max(1, ext.maxX - ext.minX)
    const worldH = Math.max(1, ext.maxY - ext.minY)
    const NOMINAL_PX = 700
    const zoom = Math.log2(NOMINAL_PX / Math.max(worldW, worldH))
    return { target: [ext.cx, ext.cy, 0], zoom } as OrthographicViewState
  }, [loader, modelMatrix])

  // The Viv layer(s): built by the shared `buildRasterImageLayers` so the standalone view
  // and the grid deck render byte-identical layers (additive per-channel compositing via
  // ColorPaletteExtension; selections align 1:1 with contrastLimits / channelsVisible /
  // colors, one entry per channel in channel-index order).
  // ── ONE RECONCILED ARRAY DRIVES BOTH THE LAYER AND THE PANEL (#288) ───────────────────
  // `buildRasterImageLayers` cuts the channel state to the loader's own `'c'` extent, so for
  // one round this component passed `channels` through raw and let the builder handle it. That
  // fixed the RENDER and broke the EDITOR: the panel below maps `channels`, so a persisted
  // 5-entry array on a 2-channel loader drew 2 channels and rendered 5 rows of controls, three
  // of which mutated state the builder truncates away — the user drags a contrast slider and
  // nothing moves, with no feedback. The reverse (1 entry, 5 channels) drew four channels with
  // no control to hide, recolour or window them.
  //
  // So the reconciliation happens ONCE, here, and both consumers read the same array. The
  // builder still reconciles — it is the last line of defence for callers that do not — and on
  // this path that inner call is an identity no-op, because the array it receives already
  // matches its loader.
  // Keyed on `loader` itself, and an earlier cut narrowed that to the loader's channel COUNT to
  // avoid recomputing on a host that re-renders with a fresh `[...sources]` each time. Reverted,
  // measured: the `layers` memo below depends on `loader` identity anyway — correctly, a new
  // loader IS a new loader — so a fresh array rebuilds the deck layer either way and the narrower
  // key bought nothing observable. What it cost was real: `reconcileChannelsToLoader`'s extend
  // path seeds through `seedChannelsForLoader`, which sizes each window from the loader's DTYPE,
  // so a swap that kept the count and changed the dtype held seeded channels carrying the old
  // dtype's `[0, max]` — and an `eslint-disable react-hooks/exhaustive-deps` is what stopped the
  // linter from saying so.
  const reconciled = useMemo(() => reconcileChannelsToLoader(channels, loader), [channels, loader])

  // See the `contrastMax` prop's own note: absent means "read it off the pixels", not "assume
  // 8-bit". The grid path threads the real bound through `PyramidEntry.contrastMax`; this is the
  // same number from the same source.
  const contrastMax = contrastMaxProp ?? contrastMaxForDtype(loader[0]?.dtype)

  const layers = useMemo(
    () => buildRasterImageLayers({ loader, channels: reconciled, modelMatrix, cellId: STANDALONE_CELL_ID, colormap }),
    [loader, reconciled, modelMatrix, colormap],
  )

  // Edits land on the RECONCILED array, not on whatever was passed in. `reconciled` is what the
  // panel lists and what the layer draws, so an edit at index `i` must address the same entry:
  // mapping `prev` instead meant an edit to a channel the reconciliation had SEEDED (raw array
  // shorter than the loader) fell off the end of `prev` and silently did nothing. Reconciling
  // here converges the state to the loader's shape on the first edit.
  const setChannel = useCallback(
    (i: number, patch: Partial<RasterChannelState>) => {
      setChannels(prev =>
        reconcileChannelsToLoader(prev, loader).map((c, j) => (j === i ? { ...c, ...patch } : c)),
      )
    },
    [loader],
  )

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-raster-image"
    >
      <DeckGL views={view} controller initialViewState={initialViewState} layers={layers} />
      {!hideControls && (
        <div
          data-testid="raster-channel-controls"
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: 'rgba(255,255,255,0.85)',
            padding: 8,
            borderRadius: 6,
            fontSize: 12,
            maxWidth: 260,
          }}
        >
          {/* `reconciled`, not `channels` — the panel must list what the layer DRAWS. See the
              note above `reconciled`: mapping the raw array rendered controls for channels the
              builder had already truncated away, which are inert, and hid channels it had
              seeded, which are drawn with no control at all. `setChannel(i, …)` indexes this
              same array, so the two agree by construction. */}
          {reconciled.map((ch, i) => (
            <div
              // POSITIONAL, not `ch.name`. The reconciliation can now MANUFACTURE a duplicate
              // name from an input that had none — extending a `[{name:'Channel 1'}]` against a
              // 3-channel loader splices in `seedChannelsForLoader`'s own `Channel 1`, and React
              // logs "Encountered two children with the same key" and declines to guarantee the
              // behaviour. The list is positional by construction anyway: `setChannel(i, …)`
              // indexes it.
              key={i}
              data-testid={`raster-channel-${i}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  data-testid={`raster-channel-${i}-visible`}
                  type="checkbox"
                  checked={ch.visible}
                  onChange={e => setChannel(i, { visible: e.target.checked })}
                  aria-label={`${ch.name} visible`}
                />
                <input
                  data-testid={`raster-channel-${i}-color`}
                  type="color"
                  value={rgbToHexInput(ch.color)}
                  onChange={e => setChannel(i, { color: hexInputToRgb(e.target.value) })}
                  aria-label={`${ch.name} color`}
                  style={{ width: 24, height: 18, padding: 0, border: 'none', background: 'none' }}
                />
                <span style={{ fontWeight: 600 }}>{ch.name}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ opacity: 0.6, width: 34 }}>begin</span>
                <input
                  data-testid={`raster-channel-${i}-contrast-begin`}
                  type="range"
                  min={0}
                  max={contrastMax}
                  step={1}
                  value={ch.contrastLimits[0]}
                  onChange={e =>
                    setChannel(i, {
                      contrastLimits: [Number(e.target.value), ch.contrastLimits[1]],
                    })
                  }
                  aria-label={`${ch.name} contrast begin`}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ opacity: 0.6, width: 34 }}>end</span>
                <input
                  data-testid={`raster-channel-${i}-contrast-end`}
                  type="range"
                  min={0}
                  max={contrastMax}
                  step={1}
                  value={ch.contrastLimits[1]}
                  onChange={e =>
                    setChannel(i, {
                      contrastLimits: [ch.contrastLimits[0], Number(e.target.value)],
                    })
                  }
                  aria-label={`${ch.name} contrast end`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function rgbToHexInput([r, g, b]: [number, number, number]): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function hexInputToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
