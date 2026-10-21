// labelMaskDirtyRect.test.ts — TEST-11 (ITEM-12): an IN-PLACE mask edit re-uploads ONLY its dirty
// rect. Proves the gigapixel-safety invariant — a correction costs O(edit), not O(image): the
// texture `copyImageData` is called once with bounds == the edit's `dirtyRect`, and the FULL
// re-encode (`encodeLabelMaskRGBA`) is NOT run. Node-env (no GL): the layer's label texture is a
// spy stub injected into the layer state.

import { describe, it, expect, vi } from 'vitest'
import { LabelMaskLayer, encodeLabelMaskSubRect } from './LabelMaskLayer'
import * as labelMaskColor from './labelMaskColor'
import { decodeIdFromRGB } from './labelMaskColor'
import { applyBrush, type DirtyRect } from '../annotate/maskEdit'

const W = 16
const H = 16

/** A spy label texture stub (node has no GL device to build a real one). */
function spyTexture(): { copyImageData: ((opts: any) => void) & ReturnType<typeof vi.fn> } {
  return { copyImageData: vi.fn() as ((opts: any) => void) & ReturnType<typeof vi.fn> }
}

describe('encodeLabelMaskSubRect — pure sub-region encode', () => {
  it('encodes ONLY the rect (data length = rectArea·4) with ids packed into rgb', () => {
    const mask = new Uint32Array(W * H)
    // a 2×2 block of id 7 at (5,6)..(6,7).
    for (const [x, y] of [[5, 6], [6, 6], [5, 7], [6, 7]]) mask[y * W + x] = 7
    const rect: DirtyRect = [5, 6, 6, 7]
    const sub = encodeLabelMaskSubRect(mask, W, rect)
    expect(sub.x).toBe(5)
    expect(sub.y).toBe(6)
    expect(sub.width).toBe(2)
    expect(sub.height).toBe(2)
    expect(sub.data.length).toBe(2 * 2 * 4)
    // every texel decodes back to id 7, opaque.
    for (let i = 0; i < 4; i++) {
      const o = i * 4
      expect(decodeIdFromRGB(sub.data[o], sub.data[o + 1], sub.data[o + 2])).toBe(7)
      expect(sub.data[o + 3]).toBe(255)
    }
  })
})

describe('LabelMaskLayer.updateSubRegion — dirty-rect sub-upload (TEST-11)', () => {
  it('an in-place brush edit re-uploads ONLY its dirtyRect (no full re-encode)', () => {
    // Start from an all-background raster; a brush is a genuine in-place edit (same array ref).
    const mask = new Uint32Array(W * H)
    const { dirtyRect } = applyBrush(mask, W, H, { x: 8, y: 8, r: 3, id: 42 })
    expect(dirtyRect[2]).toBeGreaterThanOrEqual(dirtyRect[0]) // non-empty

    const layer = new LabelMaskLayer({
      id: 'lm',
      labelMask: mask,
      width: W,
      height: H,
    } as never)
    const tex = spyTexture()
    const copyImageData = tex.copyImageData

    // A full re-encode would call `encodeLabelMaskRGBA` — spy it to prove it is NOT called.
    const fullEncodeSpy = vi.spyOn(labelMaskColor, 'encodeLabelMaskRGBA')

    const sub = layer.updateSubRegion(dirtyRect, mask, tex)

    // one sub-upload, bounds EXACTLY the edit's dirty rect.
    expect(copyImageData).toHaveBeenCalledTimes(1)
    const arg = copyImageData.mock.calls[0][0]
    const uploadedRect: DirtyRect = [arg.x, arg.y, arg.x + arg.width - 1, arg.y + arg.height - 1]
    expect(uploadedRect).toEqual(dirtyRect)

    // it uploaded strictly LESS than the whole raster (the O(edit) invariant).
    expect(arg.width * arg.height).toBeLessThan(W * H)
    expect(arg.data.length).toBe(arg.width * arg.height * 4)
    expect(sub?.data.length).toBe(arg.data.length)

    // and NO full-raster re-encode happened.
    expect(fullEncodeSpy).not.toHaveBeenCalled()
    fullEncodeSpy.mockRestore()
  })

  it('is a no-op (no upload) for an empty rect or before the texture exists', () => {
    const mask = new Uint32Array(W * H)
    const layer = new LabelMaskLayer({ id: 'lm', labelMask: mask, width: W, height: H } as never)

    // no texture yet (state empty, none passed) → nothing to sub-upload.
    expect(layer.updateSubRegion([2, 2, 5, 5], mask)).toBeNull()

    // empty rect → skipped even with a texture present.
    const tex = spyTexture()
    expect(layer.updateSubRegion([0, 0, -1, -1], mask, tex)).toBeNull()
    expect(tex.copyImageData).not.toHaveBeenCalled()
  })
})
