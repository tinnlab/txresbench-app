import { describe, it, expect } from 'vitest'
import { injectPngICC, zlibStore } from './pngIcc'

/** A minimal valid PNG: signature + a 13-byte IHDR chunk (1x1) + IEND. Enough to exercise chunk insertion. */
function tinyPng(): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  // IHDR: len=13, "IHDR", 1x1 8-bit RGB, crc (any 4 bytes — injector doesn't validate IHDR crc)
  const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0]
  const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]
  return Uint8Array.from([...sig, ...ihdr, ...iend])
}

describe('zlibStore', () => {
  it('produces a zlib stream with the 0x78 header and stored blocks', () => {
    const z = zlibStore(new Uint8Array([1, 2, 3]))
    expect(z[0]).toBe(0x78)
    expect(z.length).toBeGreaterThan(3 + 6) // header + block header + data + adler
  })
})

describe('injectPngICC (ITEM-19)', () => {
  it('inserts an iCCP chunk after IHDR', () => {
    const out = injectPngICC(tinyPng(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'sRGB')
    const s = new TextDecoder('latin1').decode(out)
    expect(s).toContain('iCCP')
    expect(s.indexOf('IHDR')).toBeLessThan(s.indexOf('iCCP')) // after IHDR
    expect(s.indexOf('iCCP')).toBeLessThan(s.indexOf('IEND')) // before IEND
    expect(out.length).toBeGreaterThan(tinyPng().length)
  })
  it('leaves a non-PNG buffer unchanged', () => {
    const notPng = new Uint8Array([1, 2, 3])
    expect(injectPngICC(notPng, new Uint8Array([9]))).toBe(notPng)
  })
})
