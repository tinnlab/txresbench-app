import { describe, it, expect } from 'vitest'
import { encodeTIFF, lzwCompress, lzwDecompress } from './tiff'

/** Minimal little-endian IFD reader: returns a map of tag id → {type,count,value(first)}. */
function readIFD(tiff: Uint8Array) {
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  expect(dv.getUint16(0, true)).toBe(0x4949) // 'II'
  expect(dv.getUint16(2, true)).toBe(42)
  const ifd = dv.getUint32(4, true)
  const n = dv.getUint16(ifd, true)
  const tags = new Map<number, { type: number; count: number; value: number }>()
  for (let i = 0; i < n; i++) {
    const off = ifd + 2 + i * 12
    tags.set(dv.getUint16(off, true), { type: dv.getUint16(off + 2, true), count: dv.getUint32(off + 4, true), value: dv.getUint32(off + 8, true) })
  }
  return tags
}

describe('TIFF LZW (ITEM-5)', () => {
  it('round-trips arbitrary bytes', () => {
    const src = new Uint8Array(512)
    for (let i = 0; i < src.length; i++) src[i] = (i * 7) & 0xff
    expect(Array.from(lzwDecompress(lzwCompress(src)))).toEqual(Array.from(src))
  })
  it('round-trips a long repeat run (exercises dictionary + width bump)', () => {
    const src = new Uint8Array(4000).fill(42)
    for (let i = 0; i < 100; i++) src[i] = i & 0xff
    expect(Array.from(lzwDecompress(lzwCompress(src)))).toEqual(Array.from(src))
  })
})

describe('encodeTIFF (ITEM-5 / ITEM-19)', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) // 2x2

  it('writes a valid RGB TIFF header + IFD', () => {
    const t = encodeTIFF(rgba, 2, 2, { compression: 'none' })
    const tags = readIFD(t)
    expect(tags.get(256)!.value).toBe(2) // width
    expect(tags.get(257)!.value).toBe(2) // height
    expect(tags.get(262)!.value).toBe(2) // photometric RGB
    expect(tags.get(277)!.value).toBe(3) // samples per pixel
    expect(tags.get(259)!.value).toBe(1) // compression none
  })
  it('grayscale → photometric 1, spp 1', () => {
    const tags = readIFD(encodeTIFF(rgba, 2, 2, { colorMode: 'gray', compression: 'none' }))
    expect(tags.get(262)!.value).toBe(1)
    expect(tags.get(277)!.value).toBe(1)
  })
  it('cmyk → photometric 5, spp 4', () => {
    const tags = readIFD(encodeTIFF(rgba, 2, 2, { colorMode: 'cmyk', compression: 'none' }))
    expect(tags.get(262)!.value).toBe(5)
    expect(tags.get(277)!.value).toBe(4)
    expect(tags.get(332)!.value).toBe(1) // InkSet CMYK
  })
  it('lzw sets compression tag 5', () => {
    expect(readIFD(encodeTIFF(rgba, 2, 2, { compression: 'lzw' })).get(259)!.value).toBe(5)
  })
  it('embeds an ICC profile as tag 34675 (ITEM-19)', () => {
    const icc = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const tags = readIFD(encodeTIFF(rgba, 2, 2, { iccProfile: icc }))
    expect(tags.get(34675)!.count).toBe(8)
  })
})
