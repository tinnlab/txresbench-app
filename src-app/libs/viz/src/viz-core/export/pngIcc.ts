// pngIcc.ts — embed an ICC profile into a PNG by inserting an `iCCP` chunk (ITEM-19, the RGB+sRGB path).
// A browser `canvas.toDataURL('image/png')` produces an un-color-managed PNG; journals want an embedded
// profile so the RGB is unambiguous. We insert `iCCP` right after `IHDR`. The profile is zlib-wrapped using
// STORED deflate blocks (no compression) so we need no deflate dependency. Pure, node-safe.

import { crc32 } from './bundle'

/** Adler-32 (zlib checksum). */
function adler32(data: Uint8Array): number {
  let a = 1, b = 0
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521 }
  return ((b << 16) | a) >>> 0
}

/** Wrap bytes in a zlib stream using STORED (uncompressed) deflate blocks — valid, dependency-free. */
export function zlibStore(data: Uint8Array): Uint8Array {
  const blocks: number[] = []
  let i = 0
  do {
    const chunk = Math.min(0xffff, data.length - i)
    const final = i + chunk >= data.length ? 1 : 0
    blocks.push(final) // BFINAL in bit0, BTYPE=00
    blocks.push(chunk & 0xff, (chunk >> 8) & 0xff)
    blocks.push(~chunk & 0xff, (~chunk >> 8) & 0xff)
    for (let j = 0; j < chunk; j++) blocks.push(data[i + j])
    i += chunk
  } while (i < data.length)
  const adler = adler32(data)
  return Uint8Array.from([0x78, 0x01, ...blocks, (adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length, false) // length (big-endian, PNG)
  out.set(body, 4)
  dv.setUint32(4 + body.length, crc32(body), false)
  return out
}

const PNG_SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Insert an `iCCP` chunk (with `profile`) after IHDR. Returns a new PNG. If `png` isn't a PNG, returns it
 *  unchanged. `name` is the profile name (ASCII, ≤79 chars). */
export function injectPngICC(png: Uint8Array, profile: Uint8Array, name = 'sRGB'): Uint8Array {
  if (png.length < 8 || !PNG_SIG.every((b, i) => png[i] === b)) return png
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const ihdrLen = dv.getUint32(8, false)
  const ihdrEnd = 8 + 4 + 4 + ihdrLen + 4 // sig..len..type..data..crc
  const nameBytes = new TextEncoder().encode(name.slice(0, 79))
  const compressed = zlibStore(profile)
  const data = new Uint8Array(nameBytes.length + 2 + compressed.length)
  data.set(nameBytes, 0)
  data[nameBytes.length] = 0 // null separator
  data[nameBytes.length + 1] = 0 // compression method = 0 (zlib)
  data.set(compressed, nameBytes.length + 2)
  const iccp = chunk('iCCP', data)
  const out = new Uint8Array(png.length + iccp.length)
  out.set(png.subarray(0, ihdrEnd), 0)
  out.set(iccp, ihdrEnd)
  out.set(png.subarray(ihdrEnd), ihdrEnd + iccp.length)
  return out
}
