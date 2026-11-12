import { describe, it, expect } from 'vitest'
import { crc32, buildZip, buildFigureBundle } from './bundle'

/** Minimal EOCD/central-dir reader so the test parses the zip WITHOUT a zip lib. */
function readZipNames(zip: Uint8Array): string[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // EOCD is the last 22 bytes (no comment).
  const eocd = zip.length - 22
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true) // central dir offset
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

describe('crc32', () => {
  it('matches the known IEEE check value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789')) >>> 0).toBe(0xcbf43926)
  })
})

describe('buildZip (ITEM-8)', () => {
  it('produces a parseable store-method zip with the given entries', () => {
    const zip = buildZip([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(new DataView(zip.buffer, 0, 4).getUint32(0, true)).toBe(0x04034b50) // first local header
    expect(readZipNames(zip)).toEqual(['a.txt', 'b.bin'])
  })
})

describe('buildFigureBundle (ITEM-8)', () => {
  it('bundles image + source-data.csv + manifest.json', () => {
    const zip = buildFigureBundle({
      image: { name: 'figure.png', bytes: new Uint8Array([137, 80, 78, 71]) },
      sourceCsv: 'group,value\nA,1\n',
      manifestJson: '{"schema":"txresbench-viz-figure/1"}',
    })
    expect(readZipNames(zip)).toEqual(['figure.png', 'source-data.csv', 'manifest.json'])
  })
})
