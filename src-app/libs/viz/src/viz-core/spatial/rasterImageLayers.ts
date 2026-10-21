// rasterImageLayers.ts — the PURE layer builder that turns a Viv resolution pyramid +
// per-channel display state into the deck.gl layer(s) that render a gigapixel-capable
// raster image. Extracted verbatim from `RasterImageView`'s layer memo so BOTH the
// standalone view AND the shared grid deck (`GridWorkspace`'s dense `image` cell) build
// the SAME layer from the SAME code — one source of truth for the Viv layer shape
// (ITEM-1 / DEC "shared new cell seam").
//
//   • loader.length > 1 ⇒ `MultiscaleImageLayer` — a pyramidal, TILED loader, so a
//     gigapixel image streams only the visible tiles at the visible resolution.
//   • loader.length === 1 ⇒ `ImageLayer` — the small single-resolution case.
//
// Both drive Viv's XRLayer channel model: per-channel additive compositing with
// `colors` (RGB), `contrastLimits` ([begin,end]) and `channelsVisible`, via the
// `ColorPaletteExtension`; an optional single `colormap` swaps in the
// `AdditiveColormapExtension` (the ITEM-2 seam, mutually exclusive with per-channel
// colors). The affine placement is the caller's `modelMatrix` (column-major 16, from
// `imageMeta.imageModelMatrix`, or a `Matrix4`). The layer id is
// `cellLayerId(cellId, 'image')` so the grid's `makeLayerFilter` routes it into that
// cell's viewport and nowhere else (DEC-20), exactly like `cellScatterLayerId`.
//
// Framework-agnostic (viz-core): depends ONLY on @deck.gl/core + @math.gl + @hms-dbmi/viv.
// No backend/storage import (INV-1); no annotation/coordination coupling. DEC-28 generic
// naming — image/channel, nothing biological.

import type { Layer } from '@deck.gl/core'
import { Matrix4 } from '@math.gl/core'
import {
  MultiscaleImageLayer,
  ImageLayer,
  ColorPaletteExtension,
  AdditiveColormapExtension,
} from '@hms-dbmi/viv'
import type { PixelSource } from '@vivjs/types'
import { cellLayerId } from '../layers/multiView'
// The channel-state vocabulary and its helpers, from a LEAF module — see `channelState.ts` for
// why they are not here and not in `grid/gridModel.ts`.
import {
  reconcileChannelsToLoader,
  type ChannelLabels,
  type RasterChannelState,
} from './channelState'

// Re-exported so every existing importer of this module is unchanged. Types are erased; the one
// value re-export is a leaf with no deck/viv/dock dependency of its own.
export type { ChannelLabels, RasterChannelState } from './channelState'
export {
  contrastMaxForDtype,
  channelCountOfLoader,
  reconcileChannelsToLoader,
  seedChannelsForLoader,
} from './channelState'



export interface BuildRasterImageLayersParams {
  /**
   * the resolution pyramid — `PixelSource[]`, index 0 = FULL resolution, each
   * subsequent entry half-scale. `length > 1` ⇒ `MultiscaleImageLayer` (tiled);
   * `length === 1` ⇒ `ImageLayer`; `length === 0` ⇒ no layer (`[]`).
   */
  loader: PixelSource<ChannelLabels>[]
  /**
   * per-channel display state; `selections`/`contrastLimits`/`channelsVisible`/`colors` are
   * derived 1:1 from this array — after it is RECONCILED against `loader` (see below).
   *
   * OPTIONAL, and absent is not a special case: it means "no state supplied", which
   * `reconcileChannelsToLoader` answers by seeding one entry per channel. That is the same
   * answer it gives an empty array, and it lets a call site that has nothing to say pass
   * nothing rather than duplicate the seed.
   */
  channels?: RasterChannelState[]
  /**
   * placement of the FULL-RES pixel grid into world space — a column-major 16
   * `number[]` (from `imageMeta.imageModelMatrix`) or a ready `Matrix4`. Identity when
   * omitted.
   */
  modelMatrix?: number[] | Matrix4
  /** the owning cell id — the built layer's id is `cellLayerId(cellId, 'image')`. */
  cellId: string
  /**
   * OPTIONAL single additive colormap (e.g. `'viridis'`, ITEM-2 seam). When set, the
   * layer uses the `AdditiveColormapExtension` (a shared intensity→colormap ramp)
   * instead of the per-channel `ColorPaletteExtension`; the per-channel `colors` are
   * then ignored by Viv. Absent ⇒ per-channel additive colors (byte-identical to the
   * standalone view's historical behavior).
   */
  colormap?: string
}

// One shared extension instance of each kind is enough (they're stateless config);
// recreating one each build would churn deck's extension-equality check.
const COLOR_PALETTE_EXTENSION = new ColorPaletteExtension()
const ADDITIVE_COLORMAP_EXTENSION = new AdditiveColormapExtension()

/**
 * Build the deck.gl layer(s) for a raster image cell. Pure — constructing a deck Layer
 * only shapes props (no GL context), so this is directly unit-testable in node.
 * Returns a `Layer[]` (0 or 1 layer) ready to compose into the shared `<DeckGL>`.
 */
export function buildRasterImageLayers({
  loader,
  channels,
  modelMatrix,
  cellId,
  colormap,
}: BuildRasterImageLayersParams): Layer[] {
  if (loader.length === 0) return []

  // ── RECONCILED AGAINST THE LOADER FIRST (#288) ───────────────────────────────────────
  // The props below are 1:1 with the channel state — that has not changed — but the channel
  // state is first cut to the loader's own `'c'` extent. Before #288 every OME-TIFF pyramid
  // had exactly one channel and this could not go wrong; now a source can declare 2 or 5..10,
  // and `channels` reaches here from TWO call sites — `useGridDeckInputs`' grid emit and the
  // standalone `RasterImageView` (via `installBuiltins`' `ImageAdapter`) — both of which can be
  // handed a persisted `cell.channels` that outlived the loader it was seeded against, because
  // `propagateToLinked` copies one cell's array to another by design. (An earlier version of
  // this note said THREE and counted `useGridRaster`, which does not call this function: it
  // produces `PyramidEntry.channels`, which the grid emit then passes on. The wrong count is
  // what made a redundant call at the emit site sound like a necessary one.)
  //
  // Unreconciled that is the same defect twice: a LONGER array issues `{c: k}` past the
  // source's channel axis, which `omeTiffPyramid` refuses BY NAME once per tile from inside
  // the render loop; a SHORTER one leaves samples the file carries neither displayed nor named,
  // which is #288's own invariant broken one layer above the reader that enforces it.
  //
  // Here rather than only at the call sites because there is no correct behaviour for a
  // selection the loader cannot answer, so the LAST place that can still fix it should. The
  // call sites reconcile too, and that is not redundant: theirs is what the per-channel EDITOR
  // lists, so a stale array would otherwise offer the user controls for channels that are not
  // drawn.
  const reconciled = reconcileChannelsToLoader(channels, loader)

  const selections = reconciled.map((_, i) => ({ c: i }))
  const contrastLimits = reconciled.map(c => c.contrastLimits)
  const channelsVisible = reconciled.map(c => c.visible)
  const colors = reconciled.map(c => c.color)

  const mm =
    modelMatrix == null
      ? undefined
      : modelMatrix instanceof Matrix4
        ? modelMatrix
        : new Matrix4(modelMatrix)

  const useColormap = !!colormap

  const shared = {
    selections,
    contrastLimits,
    channelsVisible,
    colors,
    // Viv's typed props require `dtype` even though the layer also reads it off the
    // loader at runtime; it's identical across a pyramid, so take it from level 0.
    dtype: loader[0].dtype,
    extensions: [useColormap ? ADDITIVE_COLORMAP_EXTENSION : COLOR_PALETTE_EXTENSION],
    // The AdditiveColormapExtension reads a single `colormap` name; the palette path ignores it.
    ...(useColormap ? { colormap } : {}),
    modelMatrix: mm,
  }

  const id = cellLayerId(cellId, 'image')

  if (loader.length > 1) {
    return [
      new MultiscaleImageLayer<ChannelLabels>({
        id,
        loader,
        ...shared,
      }) as unknown as Layer,
    ]
  }
  return [
    new ImageLayer<ChannelLabels>({
      id,
      loader: loader[0],
      ...shared,
    }) as unknown as Layer,
  ]
}
