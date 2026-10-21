// tiff.ts — a pure-TS baseline TIFF encoder (ITEM-5) + the CMYK / ICC substrate for ITEM-19. Journals
// (PLOS especially) accept TIFF/EPS only; this encodes an 8-bit RGB / grayscale / CMYK TIFF with optional
// TIFF-flavor LZW compression and an embedded ICC profile. Node-safe, dep-free, typed-array only. Little-
// endian ('II'). One strip. Mirrors the "pure encoder, sibling test" shape of the export/ family.

// ── TIFF-flavor LZW (MSB-first bit packing, ClearCode=256, EOI=257, 9→12-bit codes, EarlyChange=1) ──
const CLEAR = 256
const EOI = 257

export function lzwCompress(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let bitBuf = 0
  let bitCnt = 0
  let codeWidth = 9
  const put = (code: number) => {
    bitBuf = (bitBuf << codeWidth) | code
    bitCnt += codeWidth
    while (bitCnt >= 8) {
      bitCnt -= 8
      out.push((bitBuf >> bitCnt) & 0xff)
    }
  }
  let dict = new Map<string, number>()
  const resetDict = () => {
    dict = new Map()
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i)
    codeWidth = 9
  }
  resetDict()
  let next = 258
  put(CLEAR)
  let w = ''
  for (let i = 0; i < input.length; i++) {
    const c = String.fromCharCode(input[i])
    const wc = w + c
    if (dict.has(wc)) {
      w = wc
    } else {
      put(dict.get(w)!)
      dict.set(wc, next++)
      // EarlyChange=1: bump width one code BEFORE the table fills the current width.
      if (next === (1 << codeWidth) - 1 && codeWidth < 12) codeWidth++
      if (next === 4094) { put(CLEAR); resetDict(); next = 258 }
      w = c
    }
  }
  if (w !== '') put(dict.get(w)!)
  put(EOI)
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff)
  return Uint8Array.from(out)
}

export function lzwDecompress(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let bitBuf = 0
  let bitCnt = 0
  let pos = 0
  let codeWidth = 9
  const get = (): number => {
    while (bitCnt < codeWidth) {
      bitBuf = (bitBuf << 8) | (input[pos++] ?? 0)
      bitCnt += 8
    }
    bitCnt -= codeWidth
    return (bitBuf >> bitCnt) & ((1 << codeWidth) - 1)
  }
  let dict: string[] = []
  const resetDict = () => { dict = []; for (let i = 0; i < 256; i++) dict.push(String.fromCharCode(i)); dict.push(''); dict.push(''); codeWidth = 9 }
  resetDict()
  let prev = ''
  for (;;) {
    const code = get()
    if (code === EOI) break
    if (code === CLEAR) { resetDict(); prev = ''; continue }
    let entry: string
    if (code < dict.length) entry = dict[code]
    else if (code === dict.length && prev !== '') entry = prev + prev[0]
    else break
    for (let i = 0; i < entry.length; i++) out.push(entry.charCodeAt(i))
    if (prev !== '') {
      dict.push(prev + entry[0])
      // EarlyChange: the decoder table lags the encoder by ONE entry, so it must grow the code width one
      // threshold earlier ((1<<w)-2, not -1) to stay in lock-step with the encoder's early bump.
      if (dict.length === (1 << codeWidth) - 2 && codeWidth < 12) codeWidth++
    }
    prev = entry
  }
  return Uint8Array.from(out)
}

// ── pixel conversion ──
type ColorMode = 'rgb' | 'gray' | 'cmyk'
function toSamples(rgba: Uint8Array | Uint8ClampedArray, mode: ColorMode): { data: Uint8Array; spp: number; photometric: number } {
  const px = rgba.length / 4
  if (mode === 'gray') {
    const d = new Uint8Array(px)
    for (let i = 0; i < px; i++) d[i] = Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2])
    return { data: d, spp: 1, photometric: 1 } // BlackIsZero
  }
  if (mode === 'cmyk') {
    const d = new Uint8Array(px * 4)
    for (let i = 0; i < px; i++) {
      const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255
      const k = 1 - Math.max(r, g, b)
      const inv = 1 - k
      const c = inv === 0 ? 0 : (1 - r - k) / inv
      const m = inv === 0 ? 0 : (1 - g - k) / inv
      const y = inv === 0 ? 0 : (1 - b - k) / inv
      d[i * 4] = Math.round(c * 255); d[i * 4 + 1] = Math.round(m * 255); d[i * 4 + 2] = Math.round(y * 255); d[i * 4 + 3] = Math.round(k * 255)
    }
    return { data: d, spp: 4, photometric: 5 } // Separated (CMYK)
  }
  const d = new Uint8Array(px * 3)
  for (let i = 0; i < px; i++) { d[i * 3] = rgba[i * 4]; d[i * 3 + 1] = rgba[i * 4 + 1]; d[i * 3 + 2] = rgba[i * 4 + 2] }
  return { data: d, spp: 3, photometric: 2 } // RGB
}

export interface TiffOptions { compression?: 'none' | 'lzw'; colorMode?: ColorMode; iccProfile?: Uint8Array; dpi?: number }

/** Encode an RGBA buffer to a baseline little-endian TIFF. */
export function encodeTIFF(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, opts: TiffOptions = {}): Uint8Array {
  const mode = opts.colorMode ?? 'rgb'
  const useLzw = (opts.compression ?? 'lzw') === 'lzw'
  const dpi = opts.dpi ?? 600
  const { data, spp, photometric } = toSamples(rgba, mode)
  const strip = useLzw ? lzwCompress(data) : data

  // Tags (sorted ascending by id, as TIFF requires). Values >4 bytes are written after the IFD.
  const tags: Array<{ id: number; type: number; count: number; value: number | Uint8Array | number[] }> = []
  const bitsPerSample = new Array(spp).fill(8)
  tags.push({ id: 256, type: 3, count: 1, value: width }) // ImageWidth
  tags.push({ id: 257, type: 3, count: 1, value: height }) // ImageLength
  tags.push({ id: 258, type: 3, count: spp, value: bitsPerSample }) // BitsPerSample
  tags.push({ id: 259, type: 3, count: 1, value: useLzw ? 5 : 1 }) // Compression
  tags.push({ id: 262, type: 3, count: 1, value: photometric }) // Photometric
  tags.push({ id: 273, type: 4, count: 1, value: 0 }) // StripOffsets — patched below
  tags.push({ id: 277, type: 3, count: 1, value: spp }) // SamplesPerPixel
  tags.push({ id: 278, type: 3, count: 1, value: height }) // RowsPerStrip
  tags.push({ id: 279, type: 4, count: 1, value: strip.length }) // StripByteCounts
  tags.push({ id: 282, type: 5, count: 1, value: [dpi, 1] }) // XResolution (RATIONAL)
  tags.push({ id: 283, type: 5, count: 1, value: [dpi, 1] }) // YResolution
  tags.push({ id: 296, type: 3, count: 1, value: 2 }) // ResolutionUnit = inch
  if (mode === 'cmyk') tags.push({ id: 332, type: 3, count: 1, value: 1 }) // InkSet = CMYK
  if (opts.iccProfile && opts.iccProfile.length) tags.push({ id: 34675, type: 7, count: opts.iccProfile.length, value: opts.iccProfile })
  tags.sort((a, b) => a.id - b.id)

  // Layout: header(8) + IFD(2 + 12*n + 4) + external values + strip.
  const n = tags.length
  const ifdStart = 8
  const ifdSize = 2 + 12 * n + 4
  let extPos = ifdStart + ifdSize
  const externals: Array<{ at: number; bytes: Uint8Array }> = []

  const typeSize = (t: number) => (t === 3 ? 2 : t === 4 ? 4 : t === 5 ? 8 : 1)
  const encodeValue = (t: number, count: number, value: number | number[] | Uint8Array): { inline: number; ext?: Uint8Array } => {
    const totalBytes = typeSize(t) * count
    const buf = new Uint8Array(Math.max(4, totalBytes))
    const dv = new DataView(buf.buffer)
    if (t === 7 && value instanceof Uint8Array) { buf.set(value.subarray(0, totalBytes)) }
    else {
      const arr = Array.isArray(value) ? value : [value as number]
      if (t === 5) { dv.setUint32(0, arr[0], true); dv.setUint32(4, arr[1], true) }
      else { for (let i = 0; i < count; i++) { if (t === 3) dv.setUint16(i * 2, arr[i], true); else dv.setUint32(i * 4, arr[i], true) } }
    }
    if (totalBytes <= 4) return { inline: new DataView(buf.buffer).getUint32(0, true) }
    return { inline: 0, ext: buf.subarray(0, totalBytes) }
  }

  // First pass: place externals, remember StripOffsets patch.
  const ifd = new Uint8Array(ifdSize)
  const idv = new DataView(ifd.buffer)
  idv.setUint16(0, n, true)
  const entryVals: number[] = []
  tags.forEach((tag, i) => {
    const off = 2 + i * 12
    idv.setUint16(off, tag.id, true)
    idv.setUint16(off + 2, tag.type, true)
    idv.setUint32(off + 4, tag.count, true)
    const enc = encodeValue(tag.type, tag.count, tag.value as number | number[] | Uint8Array)
    if (enc.ext) { externals.push({ at: extPos, bytes: enc.ext }); entryVals.push(extPos); extPos += enc.ext.length + (enc.ext.length & 1) }
    else entryVals.push(enc.inline)
  })
  const stripOffset = extPos
  // Patch StripOffsets (id 273) to the strip position.
  tags.forEach((tag, i) => { if (tag.id === 273) entryVals[i] = stripOffset })
  tags.forEach((_, i) => idv.setUint32(2 + i * 12 + 8, entryVals[i], true))
  idv.setUint32(2 + n * 12, 0, true) // next IFD = 0

  const totalLen = stripOffset + strip.length
  const out = new Uint8Array(totalLen)
  const hv = new DataView(out.buffer)
  hv.setUint16(0, 0x4949, true) // 'II'
  hv.setUint16(2, 42, true)
  hv.setUint32(4, ifdStart, true)
  out.set(ifd, ifdStart)
  for (const e of externals) out.set(e.bytes, e.at)
  out.set(strip, stripOffset)
  return out
}
