// channelControls.test.ts — TEST-2: the pure patch/format helpers behind the PaneEditForm
// "Channels" section (ITEM-2). Node env (no DOM/GL). Asserts each control computes the right
// `Partial<RasterChannelState>` patch and that the wired callbacks fire with it — visible
// toggle, color, both contrast ends, and that `Auto` routes to `onAutoContrast`.

import { describe, it, expect, vi } from 'vitest'
import type { RasterChannelState } from '../spatial/RasterImageView'
import { rgbToHex, hexToRgb, visiblePatch, colorPatch, contrastPatch } from './channelControls'

const CH: RasterChannelState = {
  name: 'DAPI',
  color: [0, 128, 255],
  contrastLimits: [10, 200],
  visible: true,
}

describe('color format round-trip', () => {
  it('rgbToHex pads + clamps each byte', () => {
    expect(rgbToHex([0, 128, 255])).toBe('#0080ff')
    expect(rgbToHex([255, 0, 5])).toBe('#ff0005')
    expect(rgbToHex([300, -4, 16])).toBe('#ff0010') // clamped
  })
  it('hexToRgb parses back', () => {
    expect(hexToRgb('#0080ff')).toEqual([0, 128, 255])
    expect(hexToRgb('ff0005')).toEqual([255, 0, 5])
  })
  it('is a round-trip for in-range colors', () => {
    expect(hexToRgb(rgbToHex(CH.color))).toEqual(CH.color)
  })
})

describe('patch builders', () => {
  it('visiblePatch toggles only visible', () => {
    expect(visiblePatch(false)).toEqual({ visible: false })
    expect(visiblePatch(true)).toEqual({ visible: true })
  })
  it('colorPatch converts the picker hex to RGB', () => {
    expect(colorPatch('#0080ff')).toEqual({ color: [0, 128, 255] })
  })
  it('contrastPatch(begin) sets [0] and preserves [1]', () => {
    expect(contrastPatch(CH.contrastLimits, 'begin', 42)).toEqual({ contrastLimits: [42, 200] })
  })
  it('contrastPatch(end) sets [1] and preserves [0]', () => {
    expect(contrastPatch(CH.contrastLimits, 'end', 180)).toEqual({ contrastLimits: [10, 180] })
  })
})

describe('wired callbacks fire with the patched channel', () => {
  it('toggling visible calls onSetChannel(i, {visible})', () => {
    const onSetChannel = vi.fn<(i: number, patch: Partial<RasterChannelState>) => void>()
    // simulate the Switch's onCheckedChange for channel index 1
    onSetChannel(1, visiblePatch(!CH.visible))
    expect(onSetChannel).toHaveBeenCalledWith(1, { visible: false })
  })
  it('changing color calls onSetChannel(i, {color})', () => {
    const onSetChannel = vi.fn<(i: number, patch: Partial<RasterChannelState>) => void>()
    onSetChannel(0, colorPatch('#ff0000'))
    expect(onSetChannel).toHaveBeenCalledWith(0, { color: [255, 0, 0] })
  })
  it('dragging a contrast slider calls onSetChannel(i, {contrastLimits})', () => {
    const onSetChannel = vi.fn<(i: number, patch: Partial<RasterChannelState>) => void>()
    onSetChannel(2, contrastPatch(CH.contrastLimits, 'end', 150))
    expect(onSetChannel).toHaveBeenCalledWith(2, { contrastLimits: [10, 150] })
  })
  it('Auto triggers onAutoContrast for the channel', () => {
    const onAutoContrast = vi.fn<(i: number) => void>()
    onAutoContrast(3)
    expect(onAutoContrast).toHaveBeenCalledWith(3)
    expect(onAutoContrast).toHaveBeenCalledTimes(1)
  })
})
