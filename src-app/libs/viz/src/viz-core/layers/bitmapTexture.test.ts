// bitmapTexture.test.ts — the shared BitmapLayer texture wrap (image underlay black-square bug).
// deck.gl v9 uploads a raw {data,width,height} object with ZEROED RGB (a black quad); the layer must
// receive an ImageData instead. The vitest env is `node` (no ImageData), so we stub it.

import { describe, it, expect } from 'vitest'
import { toBitmapTexture } from './bitmapTexture'

class FakeImageData {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

/** Run `fn` with a stubbed global `ImageData`, restoring the previous value after. */
function withImageData<T>(fn: () => T): T {
  const g = globalThis as unknown as { ImageData?: unknown }
  const prev = g.ImageData
  g.ImageData = FakeImageData
  try {
    return fn()
  } finally {
    if (prev === undefined) delete g.ImageData
    else g.ImageData = prev
  }
}

describe('toBitmapTexture (image-underlay black-square bug)', () => {
  it('wraps RGBA bytes in an ImageData verbatim (not the raw object)', () => {
    const data = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]) // 2×1 RGBA
    const out = withImageData(() => toBitmapTexture({ data, width: 2, height: 1 })) as FakeImageData
    expect(out).toBeInstanceOf(FakeImageData)
    expect(out.width).toBe(2)
    expect(out.height).toBe(1)
    expect(Array.from(out.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 128])
  })

  it('expands a 3-channel RGB source to opaque RGBA', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]) // 2×1 RGB
    const out = withImageData(() =>
      toBitmapTexture({ data, width: 2, height: 1, channels: 3 }),
    ) as FakeImageData
    expect(out.width).toBe(2)
    expect(out.height).toBe(1)
    expect(Array.from(out.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 255])
  })

  it('infers channels from data length when `channels` is omitted (RGB → RGBA)', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]) // length 6 = 2px·3 ⇒ RGB
    const out = withImageData(() => toBitmapTexture({ data, width: 2, height: 1 })) as FakeImageData
    expect(Array.from(out.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
  })

  it('copies into an own buffer (ImageData ctor requires a non-shared, exactly-sized array)', () => {
    const data = new Uint8Array([1, 2, 3, 4]) // 1×1 RGBA
    const out = withImageData(() => toBitmapTexture({ data, width: 1, height: 1 })) as FakeImageData
    expect(out.data).toBeInstanceOf(Uint8ClampedArray)
    expect(out.data.length).toBe(4)
    // mutating the source must not affect the produced texture (it was copied).
    data[0] = 99
    expect(out.data[0]).toBe(1)
  })

  it('degrades a 0-dimension raster to the raw object (ImageData ctor rejects 0×0)', () => {
    // Even WITH ImageData available, a width/height of 0 must NOT reach the ctor (real browsers
    // throw IndexSizeError on new ImageData(_, 0, 0)); it returns the raw object instead.
    const data = new Uint8Array(0)
    const out = withImageData(() => toBitmapTexture({ data, width: 0, height: 5 }))
    expect(out).not.toBeInstanceOf(FakeImageData)
    expect(out).toEqual({ data, width: 0, height: 5 })
  })

  it('falls back to RGB expansion when an explicit channels:4 buffer is too short (no throw)', () => {
    // channels:4 claimed but only 4 bytes for a 2px image (needs 8) → the 4-channel fast path would
    // build a wrong-length ImageData (throws in a real browser); we bounds-safely expand instead.
    const data = new Uint8Array([1, 2, 3, 4]) // 2×1, but 4 < 2·4
    const out = withImageData(() =>
      toBitmapTexture({ data, width: 2, height: 1, channels: 4 }),
    ) as FakeImageData
    expect(out).toBeInstanceOf(FakeImageData)
    expect(out.data.length).toBe(8) // px·4, exactly what the ctor requires
  })

  it('falls back to the raw object under SSR/node (no ImageData, never rendered)', () => {
    const g = globalThis as unknown as { ImageData?: unknown }
    expect(g.ImageData).toBeUndefined() // sanity: node env
    const data = new Uint8Array([1, 2, 3, 4])
    const out = toBitmapTexture({ data, width: 1, height: 1 })
    expect(out).toEqual({ data, width: 1, height: 1 })
  })
})
