// bundle.ts — the publication EXPORT BUNDLE (ITEM-8): one `.zip` carrying the figure + its Source Data +
// its provenance manifest, so a reader gets image + exact plotted values + how-it-was-made in a single
// deposit-ready file. Pure-TS, dep-free, node-safe: a minimal STORE-method (no compression) ZIP writer —
// images/PDF are already compressed, so store is the right, simplest choice. Little-endian throughout.

/** CRC-32 (IEEE) — required per ZIP local-file/central-directory entry. Table built once. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const enc = (s: string) => new TextEncoder().encode(s)

export interface ZipEntry { name: string; data: Uint8Array }

/** Build a valid STORE-method .zip from entries: [local headers + data] then central directory then EOCD. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc(e.name)
    const crc = crc32(e.data)
    const size = e.data.length

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // compression = 0 (store)
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0, true) // mod date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size (== size for store)
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra len
    local.set(nameBytes, 30)
    locals.push(local, e.data)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // central dir signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true) // compression store
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk #
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length + e.data.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const centralOffset = offset
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // EOCD signature
  ev.setUint16(4, 0, true) // disk #
  ev.setUint16(6, 0, true) // cd start disk
  ev.setUint16(8, entries.length, true) // entries this disk
  ev.setUint16(10, entries.length, true) // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true) // comment len

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, p); p += part.length }
  return out
}

/** Assemble the figure bundle: the rendered image, the Source-Data CSV, and the provenance manifest JSON. */
export function buildFigureBundle(opts: {
  image: { name: string; bytes: Uint8Array }
  sourceCsv: string
  manifestJson: string
}): Uint8Array {
  return buildZip([
    { name: opts.image.name, data: opts.image.bytes },
    { name: 'source-data.csv', data: enc(opts.sourceCsv) },
    { name: 'manifest.json', data: enc(opts.manifestJson) },
  ])
}
