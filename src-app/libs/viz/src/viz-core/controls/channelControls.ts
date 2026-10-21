// channelControls.ts — PURE patch/format helpers for the PaneEditForm "Channels" section
// (ITEM-2). The Channels UI is presentational (CODING §12): each control computes a
// `Partial<RasterChannelState>` patch here and hands it to the `onSetChannel(i, patch)`
// callback the grid wires to its per-cell channel store. No deck/react/GL/backend import —
// the Viv `RasterChannelState` type is consumed read-only from RasterImageView (INV-1/2/3:
// pure view-manipulation, no inference). Node-testable in isolation (TEST-2).

import type { RasterChannelState } from '../spatial/RasterImageView'

/**
 * Single-channel colormap names for Viv's `AdditiveColormapExtension` (a curated subset of
 * glsl-colormap). Selecting one is MUTUALLY EXCLUSIVE with per-channel colors — the whole
 * image is composited through the one colormap. `CHANNEL_COLORMAP_NONE` (an empty sentinel)
 * is the "back to per-channel colors" option for a `Select` (which cannot hold `undefined`).
 */
export const CHANNEL_COLORMAP_NONE = ''
export const CHANNEL_COLORMAPS = [
  'viridis',
  'magma',
  'inferno',
  'plasma',
  'jet',
  'hot',
  'cool',
  'bone',
  'greys',
] as const
export type ChannelColormap = (typeof CHANNEL_COLORMAPS)[number]

/** clamp to a byte + hex-2 pad. */
function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

/** RGB 0-255 → `#rrggbb` for a native `<input type="color">`. */
export function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

/** `#rrggbb` (from the OS color picker) → RGB 0-255. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** patch for the visible Switch. */
export function visiblePatch(visible: boolean): Partial<RasterChannelState> {
  return { visible }
}

/** patch for the color input (hex from the OS picker → RGB). */
export function colorPatch(hex: string): Partial<RasterChannelState> {
  return { color: hexToRgb(hex) }
}

/**
 * patch for ONE end of the contrast ramp. `end === 'begin'` sets `contrastLimits[0]`,
 * `end === 'end'` sets `[1]`; the other endpoint is preserved from `current`.
 */
export function contrastPatch(
  current: readonly [number, number],
  end: 'begin' | 'end',
  value: number,
): Partial<RasterChannelState> {
  return {
    contrastLimits: end === 'begin' ? [value, current[1]] : [current[0], value],
  }
}
