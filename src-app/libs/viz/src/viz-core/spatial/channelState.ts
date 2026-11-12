// channelState.ts — the per-channel display vocabulary, and the four pure helpers over it.
//
// ── WHY THIS IS ITS OWN MODULE, AND WHY THAT IS NOT BOOKKEEPING ──────────────────────────
// These lived in `grid/gridModel.ts`, and `buildRasterImageLayers` — which is the one function
// that consumes them — had to value-import the GRID MODEL to reach them. That contradicted
// `rasterImageLayers.ts`'s own header ("depends ONLY on @deck.gl/core + @math.gl +
// @hms-dbmi/viv") and dragged `@txresbench/dock`, the chart registry and the coordination layer into
// the layer builder.
//
// Moving them the other way — into `rasterImageLayers.ts` — fixed that and created the mirror
// image, which is the one this package has a measured comment about: `gridModel.ts`'s header
// says it takes `cellLayerId` "from the deck-FREE `layerIds` module, NOT `multiView`", because
// "this file is pure data read by the option parser and the grid STORE; taking a value from
// `multiView` gave both of those a live path to deck.gl", and `layers/layerIds.ts` records the
// ablation: that edge plus the barrel import cost **+29.1 kB gzip on the preloaded critical
// path**. A value re-export from `gridModel` to `rasterImageLayers` puts `@deck.gl/core`,
// `@hms-dbmi/viv` and `@math.gl/core` back on `gridModel`'s value graph — and therefore on
// `option/parse.ts`'s, `GridWorkspace.store.ts`'s and both barrels'.
//
// A Rollup lib build of an entry that takes only `cellSpaceKey` off `gridModel` was measured to
// shake them out, so the +29.1 kB does not automatically reappear in a production bundle. That
// was first written down as "`sideEffects: false` being declared by all three", which is FALSE
// and is corrected rather than dropped: only `@deck.gl/core` declares it, `@hms-dbmi/viv`
// declares no `sideEffects` field at all, and `@math.gl/core` declares an ARRAY
// (`["./src/lib/common.js"]`). The shaking that was observed is a property of that one entry
// point, not a guarantee the three packages give. What certainly does not survive the edge is
// the source-level invariant, and nothing guards it — which is reason enough on its own.
//
// So neither side owns them: they are a LEAF. This file imports one TYPE from `@vivjs/types`
// and nothing else, so both `rasterImageLayers.ts` and `grid/gridModel.ts` can re-export it at
// zero cost, and the two headers stay true.
//
// Nothing here knows about deck.gl, about a grid cell, or about biology (DEC-28).

import type { PixelSource, SupportedDtype } from '@vivjs/types'

/** the label set of the loaders the raster builder accepts (channel selection only). */
export type ChannelLabels = ['c']

/** live per-channel display state (the XRLayer channel model). */
export interface RasterChannelState {
  name: string
  /** additive-composite color, RGB 0-255. */
  color: [number, number, number]
  /** intensity ramp `[begin, end]` in raw pixel values. */
  contrastLimits: [number, number]
  visible: boolean
}
// builder. `gridModel.ts` re-exports all four so every existing importer is unchanged.

/**
 * ITEM-1/2: the contrast-slider upper bound for a loader's pixel dtype — 65535 for the
 * 16-bit integer path (`Uint16`/`Int16`), else 255 (8-bit + the common fixture). Pure;
 * used to seed a channel's default `[0, max]` window and to size the pane-form sliders.
 */
export function contrastMaxForDtype(dtype: string | SupportedDtype | undefined): number {
  return dtype === 'Uint16' || dtype === 'Int16' ? 65535 : 255
}

/** Cycling additive-composite palette for auto-seeded channels (numeric deck RGB, not CSS). */
const CHANNEL_SEED_PALETTE: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [0, 255, 0],
  [64, 128, 255],
  [255, 255, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
]

/** Natural-RGB channel colors for a 3-channel RGB source (H&E / brightfield), so the additive
 *  composite reproduces true color. Pure blue on channel 2 — NOT the cycling palette's
 *  `[64,128,255]`, whose green (128) component leaked into the blue data and green-tinted the grid
 *  render (the standalone RasterImageView story seeds these exact R/G/B fallbacks). */
const RGB_SEED_PALETTE: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
]

/**
 * How many CHANNELS a resolved loader declares — the size of its level-0 `'c'` axis, read BY
 * NAME off the labels rather than positionally.
 *
 * The one place that count is derived, so `seedChannelsForLoader` and `reconcileChannelsToLoader`
 * cannot come to disagree about it. `0` for an empty loader (there is no image), `1` for a
 * greyscale plane and for interleaved RGB/RGBA, `SamplesPerPixel` for a planar sample stack
 * (#288).
 */
export function channelCountOfLoader(loader: PixelSource<ChannelLabels>[]): number {
  const src = loader[0]
  if (!src) return 0
  const ci = src.labels.indexOf('c' as never)
  return Math.max(1, ci >= 0 ? (src.shape[ci] ?? 1) : 1)
}

/**
 * A caller-supplied channel state array, RECONCILED with the loader it will be used against
 * (#288).
 *
 * `cell.channels` is persisted per cell and is used verbatim by `useGridRaster` and
 * `useGridDeckInputs`; `propagateToLinked` copies one cell's array to another. While every
 * pyramid had exactly one channel that could not go wrong. It can now: `buildRasterImageLayers`
 * derives `selections` 1:1 from this array, so an array LONGER than the loader's `'c'` extent
 * issues reads the source refuses by name (every tile fails), and one SHORTER leaves samples
 * the file carries neither displayed nor named in a refusal — which is the invariant #288 is
 * about, reintroduced one layer up.
 *
 * `buildRasterImageLayers` calls this itself, before deriving any prop — the 1:1 mapping from
 * channel state to layer props is intact, it is just applied to the RECONCILED state, because it
 * is the state that is wrong when it disagrees with its loader, not the mapping. An earlier cut
 * reconciled only at the call sites on the argument that the builder's contract should not move;
 * a blind audit then found a third call site with the same defect, so the rule went to the last
 * place that can still fix it. The call sites that ALSO reconcile do it for a different reason —
 * theirs is the array the per-channel EDITOR lists, which must agree with what is drawn.
 *
 * A too-long array is truncated; a too-short one is EXTENDED from `seedChannelsForLoader`'s
 * defaults, so the extra samples appear rather than vanish — truncating both ways would be
 * simpler and would re-create #288's own defect one layer up.
 *
 * An EMPTY array takes the extend path and yields a full seeded set, which is a deliberate
 * reading rather than an accident of `[]` being truthy: an empty channel list is not a request
 * to draw nothing (the editor toggles `visible`, it never removes entries), it is the absence of
 * any supplied state, which is what `undefined` means two lines above.
 */
export function reconcileChannelsToLoader(
  channels: RasterChannelState[] | undefined,
  loader: PixelSource<ChannelLabels>[],
): RasterChannelState[] {
  const n = channelCountOfLoader(loader)
  if (n === 0) return []
  if (!channels) return seedChannelsForLoader(loader)
  if (channels.length === n) return channels
  if (channels.length > n) return channels.slice(0, n)
  const seeded = seedChannelsForLoader(loader)
  return [...channels, ...seeded.slice(channels.length)]
}

/**
 * ITEM-1/2: seed default per-channel display state from a RESOLVED Viv loader when the
 * DataSource/omero supplies none — one visible channel per `'c'`-axis slice (count read
 * from the level-0 `shape`), a full-range `[0, max]` contrast window sized to the dtype
 * (`contrastMaxForDtype`), and additive-composite colors. A 3-channel source (RGB / H&E
 * brightfield) is seeded with NATURAL R/G/B (`RGB_SEED_PALETTE`) so the additive composite
 * reproduces true color — mirroring the standalone RasterImageView story's R/G/B fallback and
 * fixing the grid's green tint (the cycling palette's blue was `[64,128,255]`, whose green
 * component tinted the composite). Any other channel count uses the cycling `CHANNEL_SEED_PALETTE`.
 * Pure (no React / no GL), so it is unit-testable in node. Returns `[]` for an empty loader.
 */
export function seedChannelsForLoader(
  loader: PixelSource<ChannelLabels>[],
): RasterChannelState[] {
  const src = loader[0]
  if (!src) return []
  const n = channelCountOfLoader(loader)
  const max = contrastMaxForDtype(src.dtype)
  // A 3-channel source is treated as RGB (natural R/G/B); everything else cycles the additive palette.
  const palette = n === 3 ? RGB_SEED_PALETTE : CHANNEL_SEED_PALETTE
  return Array.from({ length: n }, (_, i) => ({
    name: `Channel ${i}`,
    color: [...palette[i % palette.length]] as [number, number, number],
    contrastLimits: [0, max] as [number, number],
    visible: true,
  }))
}
