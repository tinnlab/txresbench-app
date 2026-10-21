// zarrCodecs.ts — the ZERO-DEPENDENCY byte layer of the Zarr v3 reader (ITEM-23).
//
// Everything the artifact-model encoding needs to turn a stored chunk back into a
// typed array, using only primitives the platform already ships:
//
//   gunzip      `DecompressionStream('gzip')`      — native, since Chrome 80 / Node 18
//   unshuffle   a ~10-line byte transpose          — the inverse of numcodecs' shuffle
//   crc32c      a 256-entry table                  — the v3 shard-index checksum
//   dtype       typed-array views over the buffer  — zero-copy
//
// That list is the whole point. The design (§2.5b) measured `shuffle + gzip` at 97.4%
// of blosc's compression ratio, and blosc costs a WASM codec in the browser; DEC-4
// took the 2.6% and kept the client dependency count at ZERO. Adding a compression
// library here — for zstd, for blosc, for anything — undoes that trade, so the
// unsupported-codec arms below throw with the reason attached rather than degrading.
//
// Pure + IO-free by construction, so every function here is directly unit-testable
// against bytes produced by the Python writer (TEST-27).

/** A Zarr array's decoded elements. The `Big*` arms exist because Zarr v3 has 64-bit
 *  integer dtypes; a JS `number` cannot hold them losslessly, so they stay `bigint`. */
export type ZarrTypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

/** The integer-code arrays a categorical column can use (DEC-6: width follows the
 *  DECLARED level set — `uint8` at ≤256 levels, `uint16` above). `uint32` is accepted
 *  for a column whose levels exceed 65536. */
export type ZarrCodeArray = Uint8Array | Uint16Array | Uint32Array

/** The pair of float arrays a `complex64`/`complex128` array decodes to (ITEM-31). */
export interface ZarrComplexPair {
  re: Float32Array | Float64Array
  im: Float32Array | Float64Array
}

/** Raised for metadata this reader will not or cannot honor. Distinct from a transport
 *  error: the bytes arrived, the declaration is the problem. */
export class ZarrFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZarrFormatError'
  }
}

/**
 * The node at this path is not an ARRAY (a `zarr.json` with `node_type: "group"`).
 *
 * Its own subtype because it is a routine, EXPECTED shape rather than a malformed artifact: a
 * split-string column (`cyto.kind: "string"`, `layout: "split"`) is written as a GROUP holding
 * `offsets`/`values` sub-arrays, and the producer stamps such a column's catalog `meta.kind` as
 * `categorical` (`cyto_columns.py` routes every object-dtype Series through `Table.string()`), so
 * metadata readers legitimately arrive at a group path. A caller for whom "no array here" is an
 * ANSWER (`readDeclaredLevels`: a group declares no `levels`) catches this and only this — catching
 * `ZarrFormatError` at large would swallow a genuinely malformed member.
 */
export class ZarrNotAnArrayError extends ZarrFormatError {
  constructor(
    readonly nodeType: string,
    message: string,
  ) {
    super(message)
    this.name = 'ZarrNotAnArrayError'
  }
}

// ── dtype table ─────────────────────────────────────────────────────────────────
// Zarr v3 spec names → a typed-array view. `alloc` mints a fresh zero-filled buffer;
// `view` wraps existing bytes with NO copy (the "`new Uint16Array(buf)` — zero-copy"
// step §2.5b names). `view` demands `byteOffset` be item-aligned, which is why every
// decode path in `zarrReader.ts` hands it a buffer it owns outright.
//
// ── THE FOUR DTYPES JS HAS NO TYPE FOR (ITEM-31) ────────────────────────────────
//
// The v3 core set is `bool` + the 8 sized integers + the 3 floats + the 2 complex types
// + the raw-bits family `r<N>`. Eleven of those map straight onto a JS typed array; JS
// has a native array for none of `float16`, `complex64`, `complex128` or `r<N>`, so each
// of those four needs a DECLARED representation. Under INV-2 that is a decision to state,
// not to infer — the declarations, and why:
//
//   float16      → `Float32Array`, widened element by element. LOSSLESS: every one of
//                  the 65536 half-precision bit patterns (including subnormals, ±0, ±∞
//                  and NaN) is exactly representable in binary32, so widening changes
//                  no value and no consumer has to know the column was stored narrow.
//                  ES2025's native `Float16Array` is used to do the widening WHERE THE
//                  RUNTIME HAS IT and `float16ToFloat32` does it everywhere else; the
//                  two are pinned to identical output over all 65536 patterns by test,
//                  so the fast path can never become a second, divergent decoder.
//   complex64/   → `{re, im}` — two SEPARATE float arrays (`deinterleaveComplex`,
//   complex128     reached through `readComplex`). Handing back the interleaved buffer
//                  would make every consumer re-derive `2i`/`2i+1` indexing, and one
//                  that forgets reads the imaginary part as a real value with no error
//                  anywhere. The STORAGE view stays interleaved (below) because that is
//                  what the bytes are; the deinterleave is the declared decode step.
//   r<N>         → `Uint8Array` of the raw `N/8`-byte stride, verbatim. `r<N>` means
//                  "N opaque bits per element" — there is, by definition, nothing to
//                  interpret, so interpreting anything would be inventing meaning.
//
// Two dtypes therefore carry MORE THAN ONE JS array element per Zarr element, which is
// what `valuesPerElement` records: 2 for complex (re, im), `N/8` for `r<N>`, 1 for
// everything else. And `float16` is the one dtype whose stored width (`itemSize`, 2)
// differs from its JS width (`Float32Array`, 4) — so the two sizes are tracked apart:
// `itemSize` is always the STORED size (it drives the shuffle element size and the
// decoded-chunk length check) and the JS side reads `BYTES_PER_ELEMENT` off the array.

/** How a decoded element is spelled in JS. `bigint` marks the 64-bit integer dtypes,
 *  whose values a `number` cannot hold losslessly; `complex` and `raw` mark the dtypes
 *  that occupy more than one JS array element each. */
export type ZarrRepresentation = 'number' | 'bigint' | 'complex' | 'raw'

/** How to allocate + view one Zarr data type. */
export interface ZarrDataType {
  /** the `data_type` string as it appears in `zarr.json`. */
  readonly name: string
  /** bytes per element AS STORED — the shuffle element size and the unit the decoded
   *  chunk length is checked against. NOT necessarily the JS array's element size
   *  (`float16` stores 2 and decodes into a 4-byte `Float32Array` slot). */
  readonly itemSize: number
  /** JS array elements per Zarr element: 2 for complex (re, im), `N/8` for `r<N>`,
   *  1 otherwise. Every element index into a decoded array scales by this. */
  readonly valuesPerElement: number
  readonly representation: ZarrRepresentation
  alloc(count: number): ZarrTypedArray
  /** View `count` elements of the decoded STORED bytes. Zero-copy for every dtype whose
   *  stored layout is already a JS array layout; `float16` is the one that must convert,
   *  and therefore copies. */
  view(buffer: ArrayBufferLike, byteOffset: number, count: number): ZarrTypedArray
}

function dtype(
  name: string,
  itemSize: number,
  representation: ZarrRepresentation,
  alloc: (count: number) => ZarrTypedArray,
  view: (b: ArrayBufferLike, o: number, n: number) => ZarrTypedArray,
  valuesPerElement = 1,
): ZarrDataType {
  return { name, itemSize, valuesPerElement, representation, alloc, view }
}

// ── float16 ─────────────────────────────────────────────────────────────────────

/**
 * One IEEE-754 binary16 bit pattern → its EXACT binary32 value.
 *
 * All three exponent regimes are spelled out rather than folded into a bit-twiddle,
 * because the two that a naive implementation gets wrong — subnormals (`exponent === 0`,
 * where there is no implicit leading 1) and the ±∞/NaN encoding (`exponent === 31`) —
 * are exactly the ones that produce plausible-looking wrong numbers instead of an error.
 */
export function float16ToFloat32(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x03ff
  // Subnormal (and ±0, which is `fraction === 0` and keeps its sign through `-1 * 0`).
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * (fraction + 0x400) * 2 ** (exponent - 25)
}

/** ES2025's `Float16Array` where the runtime has it, `undefined` otherwise. Reached
 *  through `globalThis` because the ambient lib may not declare it yet. */
const NativeFloat16 = (
  globalThis as { Float16Array?: new (b: ArrayBufferLike, o: number, n: number) => ArrayLike<number> }
).Float16Array

/**
 * `count` stored `float16` elements at `byteOffset` → a fresh `Float32Array`.
 *
 * `byteOffset` must be 2-aligned (the native arm requires it; the fallback reads through
 * a `DataView` and would not care). `zarrReader` guarantees that by aligning on
 * `itemSize` before it calls any `view`.
 */
export function decodeFloat16(buffer: ArrayBufferLike, byteOffset: number, count: number): Float32Array {
  const out = new Float32Array(count)
  if (NativeFloat16) {
    // `set` widens each half to a float exactly, which is the same mapping
    // `float16ToFloat32` computes — pinned by an all-65536-patterns test.
    out.set(new NativeFloat16(buffer, byteOffset, count))
    return out
  }
  const view = new DataView(buffer, byteOffset, count * 2)
  for (let i = 0; i < count; i++) out[i] = float16ToFloat32(view.getUint16(i * 2, true))
  return out
}

// ── complex ─────────────────────────────────────────────────────────────────────

/**
 * Split an interleaved `[re0, im0, re1, im1, …]` complex buffer into `{re, im}`.
 *
 * The declared representation for `complex64`/`complex128` (see the dtype-table header).
 * A `complex64` array of `n` elements stores `2n` float32s; this is the step that stops
 * every consumer re-deriving that indexing for itself.
 */
export function deinterleaveComplex(interleaved: Float32Array | Float64Array): ZarrComplexPair {
  if (interleaved.length % 2 !== 0) {
    throw new ZarrFormatError(
      `complex: ${interleaved.length} interleaved values is not a whole number of (re, im) pairs`,
    )
  }
  const n = interleaved.length / 2
  const re = interleaved instanceof Float32Array ? new Float32Array(n) : new Float64Array(n)
  const im = interleaved instanceof Float32Array ? new Float32Array(n) : new Float64Array(n)
  for (let i = 0; i < n; i++) {
    re[i] = interleaved[i * 2]
    im[i] = interleaved[i * 2 + 1]
  }
  return { re, im }
}

const DATA_TYPES: Record<string, ZarrDataType> = {
  // `bool` is stored one byte per element (v3 spec); the reader hands back the raw
  // 0/1 bytes rather than inventing a boolean[] — the consumer decides.
  bool: dtype('bool', 1, 'number', n => new Uint8Array(n), (b, o, n) => new Uint8Array(b, o, n)),
  int8: dtype('int8', 1, 'number', n => new Int8Array(n), (b, o, n) => new Int8Array(b, o, n)),
  uint8: dtype('uint8', 1, 'number', n => new Uint8Array(n), (b, o, n) => new Uint8Array(b, o, n)),
  int16: dtype('int16', 2, 'number', n => new Int16Array(n), (b, o, n) => new Int16Array(b, o, n)),
  uint16: dtype('uint16', 2, 'number', n => new Uint16Array(n), (b, o, n) => new Uint16Array(b, o, n)),
  int32: dtype('int32', 4, 'number', n => new Int32Array(n), (b, o, n) => new Int32Array(b, o, n)),
  uint32: dtype('uint32', 4, 'number', n => new Uint32Array(n), (b, o, n) => new Uint32Array(b, o, n)),
  int64: dtype('int64', 8, 'bigint', n => new BigInt64Array(n), (b, o, n) => new BigInt64Array(b, o, n)),
  uint64: dtype('uint64', 8, 'bigint', n => new BigUint64Array(n), (b, o, n) => new BigUint64Array(b, o, n)),
  float16: dtype('float16', 2, 'number', n => new Float32Array(n), (b, o, n) => decodeFloat16(b, o, n)),
  float32: dtype('float32', 4, 'number', n => new Float32Array(n), (b, o, n) => new Float32Array(b, o, n)),
  float64: dtype('float64', 8, 'number', n => new Float64Array(n), (b, o, n) => new Float64Array(b, o, n)),
  complex64: dtype(
    'complex64',
    8,
    'complex',
    n => new Float32Array(n * 2),
    (b, o, n) => new Float32Array(b, o, n * 2),
    2,
  ),
  complex128: dtype(
    'complex128',
    16,
    'complex',
    n => new Float64Array(n * 2),
    (b, o, n) => new Float64Array(b, o, n * 2),
    2,
  ),
}

/** `r<N>`: N raw bits per element, N a positive multiple of 8 (v3 core). */
const RAW_BITS = /^r(\d+)$/
/** Resolved `r<N>` descriptors, memoized so repeated opens share one object. */
const RAW_TYPES = new Map<string, ZarrDataType>()

function rawBitsDataType(name: string, bits: number): ZarrDataType {
  const stride = bits / 8
  return dtype(
    name,
    stride,
    'raw',
    n => new Uint8Array(n * stride),
    (b, o, n) => new Uint8Array(b, o, n * stride),
    stride,
  )
}

/** The names `resolveDataType` accepts, for an error message that tells the producer
 *  what it could have said instead. */
const KNOWN_DATA_TYPES = `${Object.keys(DATA_TYPES).join(', ')}, r<N> (raw bits, N a positive multiple of 8)`

/** Resolve a `zarr.json` `data_type` string. Unknown ⇒ throws (INV-2: absence and
 *  novelty are errors, never a silent best-effort reinterpretation of the bytes). */
export function resolveDataType(name: string): ZarrDataType {
  const dt = DATA_TYPES[name]
  if (dt) return dt
  const raw = RAW_BITS.exec(name)
  if (raw) {
    const memo = RAW_TYPES.get(name)
    if (memo) return memo
    const bits = Number(raw[1])
    // A non-multiple of 8 (`r7`) or a zero width is NOT a raw-bits type this reader can
    // address — a sub-byte stride has no byte-addressable element. Refuse rather than
    // rounding up to a byte, which would silently mis-stride every element after the
    // first.
    if (bits <= 0 || bits % 8 !== 0) {
      throw new ZarrFormatError(
        `unsupported Zarr data_type "${name}" — r<N> needs N a positive multiple of 8 (known: ${KNOWN_DATA_TYPES})`,
      )
    }
    const built = rawBitsDataType(name, bits)
    RAW_TYPES.set(name, built)
    return built
  }
  throw new ZarrFormatError(`unsupported Zarr data_type "${name}" (known: ${KNOWN_DATA_TYPES})`)
}

/**
 * Byte-for-byte copy of `count` JS array elements between two arrays of the SAME dtype.
 *
 * `itemSize` is the JS array's `BYTES_PER_ELEMENT`, and `outStart`/`srcStart`/`count` are
 * in JS array elements — NOT Zarr elements. For every dtype but complex and `r<N>` those
 * coincide; for those two the caller scales by `valuesPerElement` first. Keeping this
 * function in ONE unit (the JS element) is what lets it stay dtype-agnostic.
 *
 * Done through `Uint8Array` views rather than `TypedArray.set` deliberately: `set` is
 * typed per element kind, so a dtype-generic caller would need a cast that also erases
 * the number/bigint distinction — exactly the mistake that turns an int64 column into
 * `NaN`. Copying bytes is dtype-agnostic AND exact.
 */
export function copyElements(
  out: ZarrTypedArray,
  outStart: number,
  src: ZarrTypedArray,
  srcStart: number,
  count: number,
  itemSize: number,
): void {
  if (count <= 0) return
  const dst = new Uint8Array(out.buffer, out.byteOffset + outStart * itemSize, count * itemSize)
  dst.set(new Uint8Array(src.buffer, src.byteOffset + srcStart * itemSize, count * itemSize))
}

// ── gzip ────────────────────────────────────────────────────────────────────────

/** The `DecompressionStream` formats this reader accepts, keyed by Zarr codec name. */
const STREAM_FORMAT: Record<string, CompressionFormat> = {
  gzip: 'gzip',
  // numcodecs' `zlib` codec writes a zlib-wrapped deflate stream, which is what
  // `DecompressionStream('deflate')` consumes ('deflate-raw' is the unwrapped form).
  zlib: 'deflate',
}

/**
 * Inflate `bytes` with the platform's native `DecompressionStream`. No library.
 *
 * The output is assembled into a FRESH `ArrayBuffer` starting at offset 0 — not a
 * concatenation view — because the caller immediately takes a typed-array view over
 * it, and `new Float64Array(buffer, byteOffset, …)` throws unless `byteOffset` is
 * item-aligned. Owning the buffer makes alignment unconditional instead of lucky.
 */
export async function inflate(bytes: Uint8Array, format: CompressionFormat = 'gzip'): Promise<Uint8Array> {
  const source = new Response(bytes as BufferSource).body
  if (!source) throw new ZarrFormatError('DecompressionStream: empty request body')
  const stream = source.pipeThrough(
    new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  )
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      parts.push(value)
      total += value.byteLength
    }
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Codec name → `DecompressionStream` format, or `undefined` if it is not a
 *  stream-decompressible codec. */
export function streamFormatFor(codecName: string): CompressionFormat | undefined {
  return STREAM_FORMAT[codecName]
}

// ── byte shuffle ────────────────────────────────────────────────────────────────

/**
 * Invert numcodecs' byte-shuffle: the encoder groups byte 0 of every element, then
 * byte 1, and so on (`enc[j * count + i] === raw[i * size + j]`), which makes
 * same-significance bytes adjacent and is where most of gzip's win on numerics comes
 * from. This walks that mapping backwards.
 *
 * A trailing partial element (input length not a multiple of `elementSize`) is copied
 * through verbatim — the same thing numcodecs does, since its transpose only covers
 * whole elements. The writer pads every chunk to the inner-chunk size, so in practice
 * the remainder is always zero; handling it costs three lines and removes a silent
 * corruption mode if that ever stops being true.
 */
export function unshuffle(encoded: Uint8Array, elementSize: number): Uint8Array {
  if (elementSize <= 1) return encoded
  const count = Math.floor(encoded.length / elementSize)
  const out = new Uint8Array(encoded.length)
  for (let j = 0; j < elementSize; j++) {
    const base = j * count
    for (let i = 0; i < count; i++) out[i * elementSize + j] = encoded[base + i]
  }
  const tail = count * elementSize
  if (tail < encoded.length) out.set(encoded.subarray(tail), tail)
  return out
}

// ── crc32c ──────────────────────────────────────────────────────────────────────

/** Castagnoli (reflected polynomial 0x82F63B78) — NOT the zlib CRC-32. Zarr v3 uses
 *  it for the sharding index checksum. */
const CRC32C_TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** crc32c of `bytes`, as an unsigned 32-bit number. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32C_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── arrow string layout ─────────────────────────────────────────────────────────

/** One `TextDecoder` for the module. Constructing one per string — as the design
 *  sketch does for brevity — costs more than the decode on a 150k-row column. */
const UTF8 = /* @__PURE__ */ new TextDecoder()

/**
 * Decode a WINDOW of an arrow string column: `offsets.length - 1` values out of a
 * `payload` whose byte 0 is column offset `base` (ITEM-32).
 *
 * This is the ONE string decoder, and there is exactly ONE layout that reaches it: the
 * `split` `offsets`/`values` pair, through `openSplitStringColumn` in `zarrReader.ts` —
 * its only call site. Window reads and whole-column reads both route through here, a
 * whole-column read being the degenerate window (`base = 0` over the full arrays). The
 * single-buffer arrow layout that used to be the other caller is DELETED: no producer
 * emits it and the framework conformance gate refuses it, so its decoder could never run
 * (the note above `readSplitStrings` in `zarrReader.ts` is where that is recorded).
 * The window form is what lets a caller fetch the covering chunks of each member
 * and nothing else, instead of `readAll()`-ing a 10M-row column to display a hundred
 * rows. `base` re-relativizes the absolute stored offsets onto the slice of payload
 * actually in hand — getting it wrong reads a neighbouring string, so it is validated
 * rather than assumed.
 *
 * An empty string is a legitimate value (and a legitimate categorical level), so the
 * zero-length span produces `''` rather than being skipped.
 */
export function decodeStringWindow(offsets: Uint32Array, payload: Uint8Array, base: number): string[] {
  const count = Math.max(0, offsets.length - 1)
  const out = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    const start = offsets[i] - base
    const end = offsets[i + 1] - base
    if (start < 0 || end < start || end > payload.length) {
      throw new ZarrFormatError(
        `arrow strings: offset pair [${offsets[i]}, ${offsets[i + 1]}) at window index ${i} is outside the ${payload.length}-byte window starting at ${base}`,
      )
    }
    out[i] = start === end ? '' : UTF8.decode(payload.subarray(start, end))
  }
  return out
}

/**
 * Narrow categorical codes to `Uint16Array` for a GPU binary attribute, ERRORING
 * rather than wrapping when they cannot fit.
 *
 * The boundary is `WorkbenchDataSource.categorical`, which CALLS this — it is the only
 * implementation of the rule, and the reason is that a string-valued column can carry
 * more than 65536 distinct labels — any near-unique per-row identifier does — so a silent
 * `mod 65536` produces confidently wrong labels. `artifactReader.readCategoricalColumn`
 * therefore keeps codes at `Uint32Array` and this narrowing happens once, at the hand-off
 * to deck.gl, where the count can be checked. (`arrowClient.ts` used to hold that comment;
 * ITEM-24 deleted it with the Arrow decoder.)
 *
 * The cap is 65536 LEVELS, not 65535: a u16 code spans 0…65535, so a 65536-level set fits
 * exactly and it is the 65537th level whose code wraps to 0.
 */
export function toUint16Codes(codes: ZarrCodeArray, categoryCount: number): Uint16Array {
  if (categoryCount > 65536) {
    throw new ZarrFormatError(
      `cannot narrow ${categoryCount} categories to uint16 codes (max 65536) — a 16-bit code would wrap`,
    )
  }
  if (codes instanceof Uint16Array) return codes
  const out = new Uint16Array(codes.length)
  out.set(codes)
  return out
}
