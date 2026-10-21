// zarrReader.ts — a ZERO-DEPENDENCY Zarr v3 reader for the artifact data plane
// (artifact-model ITEM-23).
//
// `GET /api/artifacts/{id}/data/{*member}` IS a Zarr store (ITEM-9): the server serves
// bytes and never opens one for meaning (INV-1), so the CLIENT does the decoding. This
// module is that decoder, and it is built out of nothing but platform primitives —
// `fetch` with `Range:`, `DecompressionStream('gzip')`, `TextDecoder`, typed-array
// views, and the ~10-line byte transpose in `zarrCodecs.ts`.
//
// The absence of a library is the deliverable, not an aesthetic. ITEM-24 deletes
// `apache-arrow` and `zarrita` from `ui/package.json` on the strength of this file; a
// single `import` of a codec or format package here would put one of them straight
// back. DEC-4 already paid 2.6% of compression ratio to keep it that way.
//
// ── WHAT IT READS ──────────────────────────────────────────────────────────────────
//
//   numeric      typed array, `shuffle + gzip`
//   categorical  uint8/uint16 codes + the DECLARED level set in `zarr.json` attributes
//   string       SPLIT arrow layout — a `uint32` `offsets` member and a `uint8` `values`
//                member under one group (the only form a producer emits)
//   sharded      `sharding_indexed`, index at the END: chunks_per_shard × (u64 offset,
//                u64 nbytes) followed by a crc32c of the index
//   unsharded    one file per chunk, no index (the small read-whole case, DEC-5)
//
// ── WHAT IT DELIBERATELY DOES NOT READ ─────────────────────────────────────────────
//
// Chunking that splits any dimension but the FIRST. Every encoding the design declares
// is either 1-D (a column; the CSR/CSC trio) or row-chunked 2-D (an n×k coordinate
// array), and for those a flat C-order element range stays contiguous — which is what
// makes `read(lo, hi)` a range of chunks instead of a scatter. A genuinely tiled 2-D array
// would need an N-D gather; rather than ship an unexercised one, `openZarrArray`
// refuses the declaration with a message naming the offending dimension. Widen this
// when a real tiled artifact exists to test against, not before.
//
// Array→array codecs (`transpose`), and any codec beside `sharding_indexed` in the outer
// chain. Same rule, and the same reason it is a REFUSAL rather than an omission: skipping
// a `transpose` returns the stored permutation as the values — `[0,3,1,4,2,5]` for a 2×3
// `[0,1,2,3,4,5]`, six plausible numbers in the wrong order — and skipping an outer
// bytes→bytes codec makes every shard-index offset address the wrong bytes. `zarr.json` is
// checked for both at OPEN time, naming the codec.
//
// ── PROGRESSIVE READING IS THE POINT ───────────────────────────────────────────────
//
// Chunk arrival IS progressive rendering (INFRA_INTEGRATION §1): the surface this
// replaces did one blocking whole-artifact fetch, and if the replacement merely awaits
// every chunk before returning, a large view goes from "paints in stages" to "blank,
// then everything" — which reads as a hang. So `chunks()` is the primitive and `read()`
// is the convenience built on it, not the other way round. A caller that paints
// incrementally allocates once (the length is known up front from `shape`) and fills
// via `readInto(out, lo, hi, onChunk)`, bumping its own update trigger per slice.
//
// ── CACHING IS UNCONDITIONALLY SAFE ────────────────────────────────────────────────
//
// Artifacts are immutable and content-addressed, and `/data` is served
// `private, max-age=31536000, immutable`. A decoded chunk can therefore be cached for
// the process lifetime with no invalidation story at all — the only bound is memory,
// which is why the chunk cache is a byte-budgeted LRU rather than an unbounded map.
// Shard indices are cached outright: they are 16 bytes per inner chunk.

import { countDecode } from './decodeCounter'
import {
  WorkstoreHttpError,
  byteRangeParam,
  fetchArtifactBytes,
  fetchArtifactBytesOrNull,
  fetchArtifactStream,
  suffixRangeParam,
} from './binaryClient'
import {
  ZarrFormatError,
  ZarrNotAnArrayError,
  copyElements,
  crc32c,
  decodeStringWindow,
  deinterleaveComplex,
  inflate,
  resolveDataType,
  streamFormatFor,
  unshuffle,
  type ZarrCodeArray,
  type ZarrComplexPair,
  type ZarrDataType,
  type ZarrTypedArray,
} from './zarrCodecs'

export {
  ZarrFormatError,
  ZarrNotAnArrayError,
  crc32c,
  decodeFloat16,
  decodeStringWindow,
  deinterleaveComplex,
  float16ToFloat32,
  inflate,
  resolveDataType,
  toUint16Codes,
  unshuffle,
} from './zarrCodecs'
export type {
  ZarrCodeArray,
  ZarrComplexPair,
  ZarrDataType,
  ZarrRepresentation,
  ZarrTypedArray,
} from './zarrCodecs'

// ── transport ───────────────────────────────────────────────────────────────────

/**
 * The read-only byte store the reader sits on: three operations, all of which an HTTP
 * `Range:` request already answers. Injectable so the decode path can be driven
 * against on-disk fixtures with no network — the same code, the same bytes.
 */
export interface ZarrStore {
  /** Whole member. `null` ⇒ absent (404) — for an unsharded array that means "this
   *  chunk was never written", which is `fill_value`, not an error. */
  get(path: string): Promise<Uint8Array | null>
  /** `length` bytes starting at `start` — `?range=start-(start+length-1)`. */
  getRange(path: string, start: number, length: number): Promise<Uint8Array>
  /** The LAST `length` bytes — `?range=-length`. This is how the shard index is read: a
   *  suffix range needs no `Content-Length` and no HEAD, so locating the index costs ONE
   *  request rather than two. */
  getSuffix(path: string, length: number): Promise<Uint8Array>
  /**
   * OPTIONAL (ITEM-17) — the same read as {@link get}/{@link getRange}, unparsed and
   * unbuffered: resolves at HEADERS to a byte stream so a decoder can start on a prefix.
   *
   * Optional on purpose, and the optionality is load-bearing in two directions. It keeps
   * every existing implementation valid — the in-memory fixture store has all its bytes
   * already and has nothing to stream — and it makes the capability something a caller
   * must TEST for rather than assume, so a store without it degrades to the buffered path
   * instead of failing. Its one production implementation is {@link artifactStore}, which
   * routes through `binaryClient`, so INV-7 is preserved unchanged.
   *
   * `null` ⇒ absent (404), exactly as `get`.
   */
  getStream?(path: string, range?: { start: number; length: number }): Promise<ReadableStream<Uint8Array> | null>
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path
  if (!path) return prefix
  return `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * A `ZarrStore` over one artifact's `/data` tree. `prefix` names a subdirectory when
 * the artifact is a multi-member bundle (a table's columns, a composite result's named
 * arrays) — a member path through the merkle manifest (INV-4).
 *
 * Every request here goes through `binaryClient`, i.e. through the generated
 * `ApiClient.Workstore.getArtifactDataMember` method — this module builds no URL,
 * attaches no header and calls no `fetch` (ITEM-30).
 */
export function artifactStore(artifactId: string, prefix = ''): ZarrStore {
  const member = (path: string) => joinPath(prefix, path)
  return {
    async get(path) {
      return fetchArtifactBytesOrNull(artifactId, member(path))
    },
    async getRange(path, start, length) {
      if (length <= 0) return new Uint8Array(0)
      return fetchArtifactBytes(artifactId, member(path), byteRangeParam({ start, end: start + length - 1 }))
    },
    async getSuffix(path, length) {
      if (length <= 0) return new Uint8Array(0)
      return fetchArtifactBytes(artifactId, member(path), suffixRangeParam(length))
    },
    // ITEM-17 — the streaming read, on the SAME `?range=` vocabulary as the two above so
    // a caller can stream a window as readily as a whole member. A zero/negative length
    // is an empty read and never becomes an un-ranged request for the whole member,
    // which is the mistake the `<= 0` guards above exist to prevent.
    async getStream(path, range) {
      if (range && range.length <= 0) return null
      const param = range
        ? byteRangeParam({ start: range.start, end: range.start + range.length - 1 })
        : undefined
      return fetchArtifactStream(artifactId, member(path), param)
    },
  }
}

/**
 * A `ZarrStore` over an in-memory `{ path → bytes }` map. Used by the unit suite to
 * read the Python writer's fixtures through the EXACT decode path HTTP uses; also the
 * shape a future prefetch/offline cache would implement.
 */
export function memoryStore(files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>): ZarrStore {
  const map = files instanceof Map ? files : new Map(Object.entries(files))
  const need = (path: string): Uint8Array => {
    const b = map.get(path)
    if (!b) throw new WorkstoreHttpError(404, `memoryStore: no member "${path}"`)
    return b
  }
  return {
    async get(path) {
      return map.get(path) ?? null
    },
    async getRange(path, start, length) {
      return need(path).subarray(start, start + length)
    },
    async getSuffix(path, length) {
      const b = need(path)
      return b.subarray(Math.max(0, b.length - length))
    },
  }
}

// ── metadata ────────────────────────────────────────────────────────────────────

/** One entry of a `zarr.json` codec chain. */
export interface ZarrCodecSpec {
  name: string
  configuration?: Record<string, unknown>
}

/** The `zarr.json` fields this reader consults. Everything else is carried through on
 *  `attributes` untouched — the server does not interpret it and neither does this. */
export interface ZarrArrayMetadata {
  zarr_format: number
  node_type?: string
  shape: number[]
  data_type: string
  chunk_grid: { name: string; configuration: { chunk_shape: number[] } }
  chunk_key_encoding?: { name: string; configuration?: { separator?: string } }
  fill_value?: number | boolean | string | null
  codecs: ZarrCodecSpec[]
  attributes?: Record<string, unknown>
  dimension_names?: (string | null)[]
}

/**
 * The producer's declaration about what an array MEANS, namespaced under `cyto` in
 * `zarr.json` `attributes` (§2.5b: `meta.attributes.cyto.levels`).
 *
 * The reader never infers any of this from the bytes — a `uint16` array is not a
 * categorical because its values happen to be small (INV-2). `kind` says what it is;
 * `levels` and `n` are what the corresponding decoder needs.
 */
export interface CytoArrayAttributes {
  /** `numeric` | `categorical` | `string` — what the values mean. */
  kind?: string
  /** categorical: the DECLARED level set, in code order. A level may legitimately be
   *  absent from the data (DEC-6 picks the code width from THIS, not from observation). */
  levels?: string[]
  /** string: how many strings the `offsets`/`values` pair splits into. */
  n?: number
  /** string: `split` ⇒ two members (`offsets` + `values`) under this group. It is the
   *  only layout a producer emits and the only one this reader decodes; anything else is
   *  refused by name rather than guessed at. */
  layout?: string
  /**
   * categorical: WHICH entry of {@link levels} was INVENTED to stand for "not in this
   * vocabulary" — present only when something was actually dropped.
   *
   * Declared rather than derivable, and that is the whole point. `cyto_columns` gives a
   * pandas `-1` a real declared level rather than an out-of-range code, and a fused
   * (gathered) column does the same for a level an `authority` alignment dropped: the entry
   * is APPENDED to the vocabulary and the absent rows index it, so every code stays in
   * range. A consumer therefore cannot tell the invented entry from a real level a dataset
   * happens to spell the same way — two states that agree in the rendered value, which no
   * inspection of the values can separate. Hence it is carried.
   *
   * A surface that wants to style absence differently from a real category reads this; so
   * does any vocabulary COMPARISON, which must exclude it or two otherwise-identical
   * vocabularies disagree whenever one run happened to drop something.
   *
   * ── RESIDUE: CARRIED, NOT YET RENDERED ──────────────────────────────────────────
   *
   * **No surface consumes this today.** It is declared by the producer, carried by the serve
   * path and asserted end-to-end through the client's own parser — so the data is available
   * and cannot silently go missing — but the legend, the colour scale and the tooltip all
   * still show the invented entry as an ordinary category. Closing that is a UI change and is
   * NOT done. Recorded here rather than only in a drift file because this doc comment is what
   * the next person implementing a categorical surface will read.
   */
  missing_level?: string
}

const SHARDING_CODEC = 'sharding_indexed'
/** The v3 sentinel in a shard index meaning "this inner chunk was never written". */
const EMPTY_CHUNK = 0xffffffffffffffffn

function requireNumberArray(value: unknown, what: string): number[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'number')) {
    throw new ZarrFormatError(`zarr.json: ${what} must be an array of numbers`)
  }
  return value as number[]
}

function product(dims: readonly number[]): number {
  return dims.reduce((a, b) => a * b, 1)
}

/** One `fill_value` scalar → a JS number. v3 spells the non-finite floats as strings,
 *  which a bare `Number(...)` would turn into `NaN` for `Infinity`. */
function parseFillScalar(raw: unknown): number {
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'number') return raw
  if (raw === 'NaN') return Number.NaN
  if (raw === 'Infinity') return Number.POSITIVE_INFINITY
  if (raw === '-Infinity') return Number.NEGATIVE_INFINITY
  throw new ZarrFormatError(`zarr.json: unsupported fill_value ${JSON.stringify(raw)}`)
}

/**
 * `fill_value` → the repeating JS-element PATTERN an unwritten chunk is filled with.
 *
 * A pattern rather than a scalar because a complex dtype's fill is a `[re, im]` pair and
 * an `r<N>`'s is one byte per raw byte of the stride (both per the v3 spec) — one value
 * per JS array element, `valuesPerElement` of them per Zarr element. A scalar is still
 * accepted and broadcast, which is what makes the near-universal `fill_value: 0` work
 * unchanged for every dtype.
 */
function parseFillPattern(raw: unknown, dt: ZarrDataType): number[] {
  const width = dt.valuesPerElement
  if (raw == null) return new Array<number>(width).fill(0)
  if (Array.isArray(raw)) {
    if (raw.length !== width) {
      throw new ZarrFormatError(
        `zarr.json: fill_value has ${raw.length} components, ${dt.name} needs ${width}`,
      )
    }
    return raw.map(parseFillScalar)
  }
  return new Array<number>(width).fill(parseFillScalar(raw))
}

/** Allocate a chunk pre-filled with `fill_value`. `count` is in ZARR elements. */
function fillChunk(dt: ZarrDataType, count: number, pattern: readonly number[]): ZarrTypedArray {
  const arr = dt.alloc(count)
  if (pattern.every(v => v === 0)) return arr // typed arrays already zero-fill
  if (dt.representation === 'bigint') {
    // int64/uint64 elements are bigint; a non-integral fill for them is a declaration
    // error, not something to round silently.
    const value = pattern[0]
    if (!Number.isInteger(value)) {
      throw new ZarrFormatError(`zarr.json: fill_value ${value} is not valid for ${dt.name}`)
    }
    ;(arr as BigInt64Array).fill(BigInt(value))
    return arr
  }
  const numeric = arr as Float64Array
  if (pattern.length === 1) {
    numeric.fill(pattern[0])
    return arr
  }
  for (let i = 0; i < numeric.length; i++) numeric[i] = pattern[i % pattern.length]
  return arr
}

/** The store-relative key of chunk `index` along dim 0 (all other dims are 0 — see the
 *  row-chunked constraint at the top of this file). */
function chunkKey(meta: ZarrArrayMetadata, rank: number, index: number): string {
  const encoding = meta.chunk_key_encoding ?? { name: 'default' }
  const coords = new Array<number>(rank).fill(0)
  coords[0] = index
  if (encoding.name === 'v2') {
    const sep = encoding.configuration?.separator ?? '.'
    return coords.join(sep)
  }
  if (encoding.name !== 'default') {
    throw new ZarrFormatError(`zarr.json: unsupported chunk_key_encoding "${encoding.name}"`)
  }
  const sep = encoding.configuration?.separator ?? '/'
  return ['c', ...coords].join(sep)
}

/**
 * Split a chunk's codec chain into the `bytes` (array→bytes) codec and the bytes→bytes
 * chain applied after it, validating both.
 *
 * A v3 chain is `array→array* , bytes , bytes→bytes*`, and this reader implements NO
 * array→array codec — so anything declared before `bytes` is refused BY NAME here, at
 * open time, before a byte of data is fetched.
 *
 * Refusing rather than implementing is the deliberate choice (the same one DEC-4 made for
 * blosc): no producer in `src-app/packages/` emits one — `cyto_zarr._codec_chain` builds
 * exactly `[bytes, (numcodecs.shuffle)?, gzip]` and `_array_meta` wraps it in a lone
 * `sharding_indexed` — so there is nothing to support and nothing to test an
 * implementation against. What there IS to fix is the failure mode: SKIPPING an
 * array→array codec does not fail, it returns the stored permutation as if it were the
 * values. A `transpose` over a 2×3 `[0,1,2,3,4,5]` reads back `[0,3,1,4,2,5]` — six
 * plausible numbers in the wrong order, with no error anywhere. Widen this when a real
 * producer emits one, with that producer's bytes as the oracle.
 */
function splitCodecChain(codecs: ZarrCodecSpec[], where: string): ZarrCodecSpec[] {
  const bytesAt = codecs.findIndex(c => c.name === 'bytes')
  if (bytesAt === -1) {
    throw new ZarrFormatError(`zarr.json: ${where} codec chain has no "bytes" codec`)
  }
  if (bytesAt > 0) {
    const named = codecs
      .slice(0, bytesAt)
      .map(c => `"${c.name}"`)
      .join(', ')
    throw new ZarrFormatError(
      `zarr.json: ${where} declares array→array codec ${named} before "bytes" — this reader implements no array→array codec, and applying none would silently return the STORED permutation as the values`,
    )
  }
  const endian = codecs[bytesAt].configuration?.endian
  // Every browser and Node target is little-endian and the writer says so explicitly.
  // Accepting "big" here would mean byte-swapping in JS, which no declared encoding
  // needs; refusing is INV-2 (absence of support is an error, not a silent guess).
  if (endian !== undefined && endian !== 'little') {
    throw new ZarrFormatError(`zarr.json: ${where} endian "${String(endian)}" — only "little" is supported`)
  }
  return codecs.slice(bytesAt + 1)
}

/**
 * Undo one chunk's bytes→bytes codec chain. Codecs are DECLARED in encode order, so
 * decoding walks them backwards: written `bytes → shuffle → gzip` decodes
 * `gunzip → unshuffle`.
 */
async function decodeBytes(
  chain: readonly ZarrCodecSpec[],
  raw: Uint8Array,
  itemSize: number,
): Promise<Uint8Array> {
  let bytes = raw
  for (let i = chain.length - 1; i >= 0; i--) {
    const codec = chain[i]
    const format = streamFormatFor(codec.name)
    if (format) {
      bytes = await inflate(bytes, format)
      continue
    }
    if (codec.name === 'numcodecs.shuffle' || codec.name === 'shuffle') {
      const declared = codec.configuration?.elementsize
      bytes = unshuffle(bytes, typeof declared === 'number' ? declared : itemSize)
      continue
    }
    if (codec.name === 'crc32c') {
      bytes = verifyCrc32c(bytes, 'chunk')
      continue
    }
    // blosc / zstd are reachable only via a WASM codec, which is precisely the
    // dependency DEC-4 traded 2.6% of compression ratio to avoid. Say so.
    if (codec.name === 'blosc' || codec.name === 'zstd') {
      throw new ZarrFormatError(
        `zarr.json: codec "${codec.name}" needs a WASM decoder — the artifact-model encoding is shuffle + gzip (DEC-4)`,
      )
    }
    throw new ZarrFormatError(`zarr.json: unsupported codec "${codec.name}"`)
  }
  return bytes
}

/** Check + strip a trailing little-endian crc32c. */
function verifyCrc32c(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length < 4) throw new ZarrFormatError(`${what}: too short to carry a crc32c`)
  const body = bytes.subarray(0, bytes.length - 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4)
  const expected = view.getUint32(0, true)
  const actual = crc32c(body)
  if (actual !== expected) {
    throw new ZarrFormatError(
      `${what}: crc32c mismatch — computed 0x${actual.toString(16)}, stored 0x${expected.toString(16)}`,
    )
  }
  return body
}

// ── caching ─────────────────────────────────────────────────────────────────────

/** A byte-budgeted LRU over decoded chunks. Correctness never depends on it — the
 *  artifact is immutable, so a hit and a miss are indistinguishable except in latency
 *  — which is why eviction can be this crude. */
class ChunkCache {
  readonly #entries = new Map<number, ZarrTypedArray>()
  #bytes = 0

  constructor(private readonly budget: number) {}

  get(key: number): ZarrTypedArray | undefined {
    const hit = this.#entries.get(key)
    if (hit === undefined) return undefined
    // Map iterates in insertion order, so re-inserting moves the entry to the back and
    // makes the front the least-recently-used.
    this.#entries.delete(key)
    this.#entries.set(key, hit)
    return hit
  }

  set(key: number, value: ZarrTypedArray): void {
    if (this.budget <= 0) return
    this.#entries.set(key, value)
    this.#bytes += value.byteLength
    while (this.#bytes > this.budget && this.#entries.size > 1) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      const evicted = this.#entries.get(oldest.value)
      this.#entries.delete(oldest.value)
      this.#bytes -= evicted?.byteLength ?? 0
    }
  }
}

/** Default decoded-chunk budget. Generous because the cache can never be stale, small
 *  enough that a few open views cannot exhaust a tab. */
const DEFAULT_CHUNK_CACHE_BYTES = 64 * 1024 * 1024

/** How many chunk fetches to keep in flight while `chunks()` yields in order. Slices
 *  are still delivered strictly in order — this only overlaps the round-trips, which is
 *  the difference between a progressive read and N sequential RTTs. */
const DEFAULT_PREFETCH = 4

/** Tuning knobs for `openZarrArray`. */
export interface ZarrArrayOptions {
  /** Decoded-chunk cache budget in bytes. `0` disables caching. */
  chunkCacheBytes?: number
  /** Chunk fetches kept in flight during a ranged read. */
  prefetch?: number
}

// ── the array ───────────────────────────────────────────────────────────────────

/** One slice of a progressive read: the elements of ONE inner chunk that fall inside
 *  the requested range. */
export interface ZarrChunkSlice {
  /** 0-based position of this slice within the read. */
  index: number
  /** how many slices the read will yield in total — known up front, so a caller can
   *  show real progress rather than a spinner. */
  total: number
  /** flat element index of `values[0]` within the ARRAY (not within the read). */
  offset: number
  /** the decoded elements. A VIEW into the cached chunk — read it, copy it, never
   *  mutate it, or the next reader of that chunk sees your writes. `read()` and
   *  `readInto()` copy on your behalf.
   *
   *  For a `complex*` or `r<N>` dtype this holds `dtype.valuesPerElement` JS array
   *  entries per Zarr element, so `values.length` is NOT the element count — divide. */
  values: ZarrTypedArray
}

/**
 * The per-read state `chunks()` threads down to the transport (ITEM-33).
 *
 * It exists so a chunk fetch can ask "does the READ I belong to want this whole shard?"
 * — which is the entire whole-shard decision — and so the shard buffers a read holds are
 * scoped to that read instead of to the array. `shards` is released chunk by chunk as
 * the scheduler passes each shard's last chunk, so a 306-shard read never holds more
 * than the prefetch window's worth of compressed bytes.
 */
interface ReadPlan {
  first: number
  last: number
  totalChunks: number
  shards: Map<number, Promise<ShardSource | null>>
}

/**
 * A whole shard, held for as long as a read still has inner chunks to slice out of it.
 *
 * ITEM-18 — an INTERFACE rather than a byte buffer, because the shard may not be complete
 * yet. The buffered form answers a span immediately; the streamed form answers it as soon
 * as that span's last byte has ARRIVED, which is what lets inner chunk 0 decode while the
 * rest of the shard is still on the wire.
 */
interface ShardSource {
  readonly index: BigUint64Array
  /** Bytes `[start, end)` of the shard, awaiting their arrival if the body is streaming.
   *  Rejects if the body ends before `end` — a span past the body is a format error, not
   *  an empty read. */
  slice(start: number, end: number): Promise<Uint8Array>
}

/** A shard whose bytes are all present — the buffered path, unchanged in behaviour. */
function bufferedShard(bytes: Uint8Array, index: BigUint64Array, key: string): ShardSource {
  return {
    index,
    async slice(start, end) {
      if (end > bytes.length) {
        throw new ZarrFormatError(
          `${key}: chunk spans [${start}, ${end}) of a ${bytes.length}-byte shard`,
        )
      }
      return bytes.subarray(start, end)
    },
  }
}

/**
 * A shard whose body is still arriving (ITEM-18).
 *
 * Holds the received prefix and a set of waiters keyed by the byte offset each needs. A
 * waiter resolves as soon as `received >= end`, so inner chunk 0 decodes after a PREFIX of
 * the shard rather than after its last byte — which is the whole point, and is impossible
 * on the footer-index whole-shard path this replaces.
 *
 * Three failure modes, all explicit rather than silent:
 *   · the body ends before a span's end  ⇒ that waiter REJECTS (a truncated shard is a
 *     format error; returning short bytes would decode as garbage);
 *   · the body errors                    ⇒ every outstanding waiter rejects with it;
 *   · a span is requested after the body completed ⇒ answered immediately, or rejected if
 *     it lies past the end.
 */
/**
 * The bytes the shard index accounts for: `max(offset + nbytes)` over the present chunks.
 *
 * `EMPTY_CHUNK` entries are skipped — they address no bytes. Returns 0 for an index that accounts
 * for nothing, which leaves the caller on its 64 KiB default. Anything not representable as a safe
 * integer is also refused rather than coerced: a bogus index must not turn into a huge allocation.
 */
export function indexedBodyBytes(index: BigUint64Array): number {
  let end = 0n
  for (let i = 0; i + 1 < index.length; i += 2) {
    const offset = index[i]
    const nbytes = index[i + 1]
    if (offset === EMPTY_CHUNK || nbytes === EMPTY_CHUNK) continue
    const candidate = offset + nbytes
    if (candidate > end) end = candidate
  }
  return end > 0n && end <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(end) : 0
}

function streamingShard(
  body: ReadableStream<Uint8Array>,
  index: BigUint64Array,
  key: string,
): ShardSource {
  // One growing buffer rather than a chunk list: every consumer wants a CONTIGUOUS span,
  // so the copy has to happen somewhere and doing it on arrival keeps `slice` O(1) and
  // allocation-free. Doubling, so N arrivals cost amortized O(total).
  //
  // PRE-SIZED from the shard INDEX, which is already in hand. Doubling from 64 KiB over-allocates
  // by up to 2× at rest and ~3× transiently during the final copy, where the buffered path this
  // replaced allocated exactly once — a regression this size of buffer cannot afford. The index
  // gives every inner chunk's `(offset, nbytes)`, so `max(offset + nbytes)` is a sound lower bound
  // on the body and, for a shard whose index is a FOOTER, within one index of the whole thing.
  // (The response's own `Content-Length` would be exact, but the store's stream API hands back a
  // bare `ReadableStream` with no headers, and widening that is an SDK change.)
  //
  // Doubling is KEPT as the growth path, so an index that under-states the body (a corrupt or
  // unusual layout) still reads correctly — the hint is an allocation optimisation and never a
  // bound on what may arrive.
  let buf = new Uint8Array(Math.max(64 * 1024, indexedBodyBytes(index)))
  let received = 0
  let done = false
  let failure: unknown = null
  const waiters: Array<{ end: number; resolve: () => void; reject: (e: unknown) => void }> = []

  const wake = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      if (failure !== null) {
        waiters.splice(i, 1)
        w.reject(failure)
      } else if (received >= w.end) {
        waiters.splice(i, 1)
        w.resolve()
      } else if (done) {
        waiters.splice(i, 1)
        w.reject(
          new ZarrFormatError(`${key}: chunk needs ${w.end} bytes but the shard body ended at ${received}`),
        )
      }
    }
  }

  const pump = (async () => {
    const reader = body.getReader()
    try {
      for (;;) {
        const { value, done: end } = await reader.read()
        if (end) break
        if (!value || value.length === 0) continue
        if (received + value.length > buf.length) {
          let size = buf.length
          while (size < received + value.length) size *= 2
          const grown = new Uint8Array(size)
          grown.set(buf.subarray(0, received))
          buf = grown
        }
        buf.set(value, received)
        received += value.length
        wake()
      }
      done = true
    } catch (error) {
      failure = error
    } finally {
      done = true
      wake()
    }
  })()
  // The pump owns its own failures; every consumer learns about them through a waiter.
  // Without this an abandoned read would surface as an unhandled rejection, which is a
  // console error in the browser and a HIGH finding in the runtime-health gate.
  void pump.catch(() => {})

  return {
    index,
    async slice(start, end) {
      if (received < end && failure === null && !done) {
        await new Promise<void>((resolve, reject) => {
          waiters.push({ end, resolve, reject })
        })
      }
      if (failure !== null) throw failure
      if (received < end) {
        throw new ZarrFormatError(`${key}: chunk spans [${start}, ${end}) of a ${received}-byte shard`)
      }
      return buf.subarray(start, end)
    },
  }
}

/** A whole shard file, held for as long as a read still has inner chunks to slice out
 *  of it. The index is parsed from these same bytes — which is why the whole-shard path
 *  costs no separate index request. */
interface ShardBytes {
  bytes: Uint8Array
  index: BigUint64Array
}

/**
 * A read-only Zarr v3 array over byte-range GETs.
 *
 * Element addressing is FLAT and C-order: `read(lo, hi)` returns elements
 * `[lo, hi)` of `shape` flattened. For a 1-D column that is the obvious thing; for a
 * row-chunked `n × k` array, row `r` is `[r * rowElements, (r + 1) * rowElements)` —
 * which `readRows` does for you.
 */
export class ZarrArray {
  readonly meta: ZarrArrayMetadata
  readonly shape: readonly number[]
  readonly dtype: ZarrDataType
  /** total element count = product(shape). */
  readonly length: number
  /** elements per row along the trailing dimensions (1 for a 1-D array). */
  readonly rowElements: number
  /** elements per inner chunk — the read granularity, and the unit of progress. */
  readonly innerChunkElements: number
  /** true ⇒ `sharding_indexed`; false ⇒ one file per chunk. */
  readonly sharded: boolean
  /** producer declaration under `attributes.cyto`, if any. */
  readonly cyto: CytoArrayAttributes | undefined

  readonly #store: ZarrStore
  readonly #path: string
  readonly #rank: number
  readonly #chunksPerShard: number
  readonly #outerChunkElements: number
  readonly #chain: readonly ZarrCodecSpec[]
  readonly #indexAtEnd: boolean
  readonly #indexHasCrc: boolean
  readonly #fillPattern: readonly number[]
  readonly #prefetch: number
  readonly #cache: ChunkCache
  readonly #shardIndex = new Map<number, BigUint64Array>()
  readonly #indexInFlight = new Map<number, Promise<BigUint64Array | null>>()
  readonly #inFlight = new Map<number, Promise<ZarrTypedArray>>()

  constructor(store: ZarrStore, path: string, meta: ZarrArrayMetadata, options: ZarrArrayOptions = {}) {
    // FIRST, before any field is parsed. A GROUP declares no `shape`, so parsing shape first
    // refused a split-string member as `shape must be…` — a malformed-array error for a
    // perfectly well-formed group, and one a caller cannot tell apart from real corruption.
    // What is wrong with a group here is that it is a group; say that.
    if (meta.node_type !== undefined && meta.node_type !== 'array') {
      throw new ZarrNotAnArrayError(
        meta.node_type,
        `zarr.json: node_type "${meta.node_type}", expected "array"`,
      )
    }
    this.#store = store
    this.#path = path
    this.meta = meta
    this.shape = requireNumberArray(meta.shape, 'shape')
    if (this.shape.length === 0) throw new ZarrFormatError('zarr.json: 0-dimensional arrays are not supported')
    this.#rank = this.shape.length
    this.dtype = resolveDataType(meta.data_type)
    this.length = product(this.shape)
    this.rowElements = product(this.shape.slice(1))
    this.cyto = (meta.attributes?.cyto ?? undefined) as CytoArrayAttributes | undefined
    this.#fillPattern = parseFillPattern(meta.fill_value, this.dtype)
    this.#prefetch = Math.max(1, options.prefetch ?? DEFAULT_PREFETCH)
    this.#cache = new ChunkCache(options.chunkCacheBytes ?? DEFAULT_CHUNK_CACHE_BYTES)

    if (meta.zarr_format !== 3) throw new ZarrFormatError(`zarr.json: zarr_format ${meta.zarr_format}, expected 3`)
    if (meta.chunk_grid?.name !== 'regular') {
      throw new ZarrFormatError(`zarr.json: unsupported chunk_grid "${meta.chunk_grid?.name}"`)
    }

    const outerShape = requireNumberArray(meta.chunk_grid.configuration?.chunk_shape, 'chunk_grid chunk_shape')
    this.#assertRowChunked(outerShape, 'chunk_grid chunk_shape')
    this.#outerChunkElements = product(outerShape)

    const sharding = meta.codecs?.find(c => c.name === SHARDING_CODEC)
    this.sharded = sharding !== undefined
    if (sharding) {
      // `sharding_indexed` IS the array→bytes codec, so the outer chain has room for an
      // array→array codec before it and a bytes→bytes codec after it — and this reader
      // reads the shard file's index and chunk spans out of the RAW bytes, so it applies
      // neither. Dropping either is silent: an outer `transpose` re-orders the values, an
      // outer `gzip` makes every offset in the index address the wrong bytes. Same rule as
      // `splitCodecChain`, one level up — refuse by name rather than ignore.
      const beside = (meta.codecs ?? []).filter(c => c !== sharding)
      if (beside.length > 0) {
        const named = beside.map(c => `"${c.name}"`).join(', ')
        throw new ZarrFormatError(
          `zarr.json: codec ${named} sits beside "sharding_indexed" in the array codec chain — this reader applies no codec outside the shard, and applying none would silently misread the shard's own bytes`,
        )
      }
      const cfg = (sharding.configuration ?? {}) as {
        chunk_shape?: unknown
        codecs?: ZarrCodecSpec[]
        index_codecs?: ZarrCodecSpec[]
        index_location?: string
      }
      const innerShape = requireNumberArray(cfg.chunk_shape, 'sharding_indexed chunk_shape')
      this.#assertRowChunked(innerShape, 'sharding_indexed chunk_shape')
      this.innerChunkElements = product(innerShape)
      this.#chain = splitCodecChain(cfg.codecs ?? [], 'sharding_indexed')
      this.#indexAtEnd = (cfg.index_location ?? 'end') === 'end'
      this.#indexHasCrc = (cfg.index_codecs ?? []).some(c => c.name === 'crc32c')
      if (this.#outerChunkElements % this.innerChunkElements !== 0) {
        throw new ZarrFormatError(
          `zarr.json: shard of ${this.#outerChunkElements} elements is not a whole number of ${this.innerChunkElements}-element inner chunks`,
        )
      }
      this.#chunksPerShard = this.#outerChunkElements / this.innerChunkElements
    } else {
      this.innerChunkElements = this.#outerChunkElements
      this.#chain = splitCodecChain(meta.codecs ?? [], 'array')
      this.#indexAtEnd = true
      this.#indexHasCrc = false
      this.#chunksPerShard = 1
    }
    if (this.innerChunkElements <= 0) throw new ZarrFormatError('zarr.json: chunk shape has a zero dimension')
  }

  /** Chunking may split dim 0 only — see the header. Anything else would make a flat
   *  element range non-contiguous and demand an N-D gather this reader does not have. */
  #assertRowChunked(chunkShape: readonly number[], what: string): void {
    if (chunkShape.length !== this.#rank) {
      throw new ZarrFormatError(
        `zarr.json: ${what} has rank ${chunkShape.length}, array has rank ${this.#rank}`,
      )
    }
    for (let d = 1; d < this.#rank; d++) {
      if (chunkShape[d] !== this.shape[d]) {
        throw new ZarrFormatError(
          `zarr.json: ${what} splits dimension ${d} (${chunkShape[d]} of ${this.shape[d]}) — this reader chunks along dimension 0 only`,
        )
      }
    }
  }

  /** How many inner chunks a read of `[lo, hi)` will touch. Known before any byte is
   *  fetched, which is what lets a caller render determinate progress. */
  chunkCountFor(lo = 0, hi = this.length): number {
    const [a, b] = this.#clamp(lo, hi)
    if (b <= a) return 0
    return Math.floor((b - 1) / this.innerChunkElements) - Math.floor(a / this.innerChunkElements) + 1
  }

  /**
   * Yield the elements of `[lo, hi)` chunk by chunk, IN ORDER, as each arrives.
   *
   * This is the progressive-rendering primitive: paint inside the loop and the surface
   * fills in as ranges land, which is the behaviour the deleted streaming route used to
   * provide. Fetches for the next few chunks are already in flight while you handle the
   * current one, so ordering costs no round-trips.
   *
   * `values` is a view into the cache — copy anything you keep.
   */
  async *chunks(lo = 0, hi = this.length): AsyncGenerator<ZarrChunkSlice, void, void> {
    const [start, end] = this.#clamp(lo, hi)
    if (end <= start) return
    const first = Math.floor(start / this.innerChunkElements)
    const last = Math.floor((end - 1) / this.innerChunkElements)
    const total = last - first + 1
    const vpe = this.dtype.valuesPerElement
    // The plan is what makes ITEM-33's whole-shard fetch possible: the transport can
    // only know a shard is fully wanted by looking at the READ, not at one chunk.
    const plan: ReadPlan = {
      first,
      last,
      totalChunks: Math.ceil(this.length / this.innerChunkElements),
      shards: new Map(),
    }

    const pending = new Map<number, Promise<ZarrTypedArray>>()
    let queued = first
    for (let g = first; g <= last; g++) {
      while (queued <= last && queued < g + this.#prefetch) {
        const started = this.#innerChunk(queued, plan)
        // A prefetch the consumer never gets to (it broke out of the loop, or an
        // earlier chunk threw) would otherwise reject with nobody listening — an
        // "unhandled rejection", which in the browser is a console error and a HIGH
        // finding in the runtime-health gate. Marking it handled here does not swallow
        // anything: the `await` below still sees the rejection.
        void started.catch(() => {})
        pending.set(queued, started)
        // Once the LAST chunk of a shard has been scheduled, nothing else will ask for
        // that shard's bytes, so drop the read's reference to them. Any decode still in
        // flight holds the promise itself, so this races with nothing — and doing it at
        // SCHEDULE time rather than on consumption keeps it correct when some chunks of
        // the shard came from the decoded cache and never touched the transport at all.
        const shard = Math.floor(queued / this.#chunksPerShard)
        if (queued >= this.#lastChunkOfShard(shard, plan)) plan.shards.delete(shard)
        queued++
      }
      const chunk = await pending.get(g)!
      pending.delete(g)
      const chunkLo = g * this.innerChunkElements
      const from = Math.max(start, chunkLo) - chunkLo
      const to = Math.min(end, chunkLo + this.innerChunkElements) - chunkLo
      yield {
        index: g - first,
        total,
        offset: chunkLo + from,
        // `from`/`to` are ZARR elements; a complex or raw-bits chunk holds
        // `valuesPerElement` JS entries for each of them.
        values: chunk.subarray(from * vpe, to * vpe) as ZarrTypedArray,
      }
    }
  }

  /**
   * Fill `out` with elements `[lo, hi)`, invoking `onChunk` as each chunk lands.
   *
   * The allocate-once shape §2.5b calls for: the length is known from `shape`, so a
   * consumer allocates its GPU-bound buffer up front, passes it here, and bumps its
   * update trigger from `onChunk` — no reallocation, no whole-array await.
   */
  async readInto(
    out: ZarrTypedArray,
    lo = 0,
    hi = this.length,
    onChunk?: (slice: ZarrChunkSlice) => void,
  ): Promise<ZarrTypedArray> {
    const [start, end] = this.#clamp(lo, hi)
    // `out` is measured in JS ARRAY ENTRIES, which is `valuesPerElement` per Zarr
    // element — 2 for complex (re, im), `N/8` for `r<N>`, 1 for everything else.
    const vpe = this.dtype.valuesPerElement
    const needed = (end - start) * vpe
    if (out.length < needed) {
      throw new ZarrFormatError(`readInto: destination holds ${out.length} array entries, need ${needed}`)
    }
    // The copy stride is the DESTINATION's own element width, NOT `dtype.itemSize`.
    // Those differ for `float16`, which stores 2 bytes and decodes into a 4-byte
    // `Float32Array` slot; copying at the stored width would interleave halves of
    // adjacent floats into plausible-looking garbage instead of failing.
    const itemSize = out.BYTES_PER_ELEMENT
    for await (const slice of this.chunks(start, end)) {
      if (slice.values.BYTES_PER_ELEMENT !== itemSize) {
        throw new ZarrFormatError(
          `readInto: destination is a ${itemSize}-byte-per-entry array, ${this.dtype.name} decodes to ${slice.values.BYTES_PER_ELEMENT}-byte entries — allocate with \`array.dtype.alloc()\``,
        )
      }
      copyElements(out, (slice.offset - start) * vpe, slice.values, 0, slice.values.length, itemSize)
      onChunk?.(slice)
    }
    return out
  }

  /** Elements `[lo, hi)` as a fresh typed array. Convenience over `readInto`; a caller
   *  that wants to paint as chunks land should use `chunks`/`readInto` instead. */
  async read(lo = 0, hi = this.length): Promise<ZarrTypedArray> {
    const [start, end] = this.#clamp(lo, hi)
    return this.readInto(this.dtype.alloc(Math.max(0, end - start)), start, end)
  }

  /** The whole array. */
  async readAll(): Promise<ZarrTypedArray> {
    return this.read(0, this.length)
  }

  /** Rows `[lo, hi)` of a row-chunked array — flat `[lo * rowElements, hi * rowElements)`. */
  async readRows(lo: number, hi: number): Promise<ZarrTypedArray> {
    return this.read(lo * this.rowElements, hi * this.rowElements)
  }

  #clamp(lo: number, hi: number): [number, number] {
    const start = Math.max(0, Math.min(Math.trunc(lo), this.length))
    const end = Math.max(start, Math.min(Math.trunc(hi), this.length))
    return [start, end]
  }

  /** The last inner-chunk index shard `shard` actually HOLDS. The tail shard is short —
   *  `f32_sharded`'s last shard nominally holds 8 chunks and really holds 2 — so a read
   *  that stops at the array's end still covers that shard completely. */
  #lastChunkOfShard(shard: number, plan: ReadPlan): number {
    return Math.min((shard + 1) * this.#chunksPerShard, plan.totalChunks) - 1
  }

  /**
   * Does the READ this chunk belongs to want every inner chunk of `shard`? (ITEM-33.)
   *
   * This is the whole-shard decision, and it can only be made from the READ — one chunk
   * has no idea whether its siblings are wanted. When the answer is yes, the shard is
   * fetched ONCE with no `Range:` at all and every inner chunk is sliced out of the
   * buffer; the index trailer is inside those same bytes, so the separate suffix request
   * disappears too. That is the difference between 2,749 requests for a 10M column and
   * one per shard — sharding was inverting its own purpose without it.
   */
  #wantsWholeShard(shard: number, plan: ReadPlan): boolean {
    if (!this.sharded) return false
    return plan.first <= shard * this.#chunksPerShard && plan.last >= this.#lastChunkOfShard(shard, plan)
  }

  /** Decoded inner chunk `g`, from cache / an in-flight fetch / the store. */
  #innerChunk(g: number, plan: ReadPlan): Promise<ZarrTypedArray> {
    const cached = this.#cache.get(g)
    if (cached) return Promise.resolve(cached)
    const flight = this.#inFlight.get(g)
    if (flight) return flight
    const started = this.#fetchInnerChunk(g, plan)
      .then(chunk => {
        this.#cache.set(g, chunk)
        return chunk
      })
      .finally(() => {
        this.#inFlight.delete(g)
      })
    this.#inFlight.set(g, started)
    return started
  }

  async #fetchInnerChunk(g: number, plan: ReadPlan): Promise<ZarrTypedArray> {
    const raw = this.sharded ? await this.#shardChunkBytes(g, plan) : await this.#plainChunkBytes(g)
    if (raw === null) return fillChunk(this.dtype, this.innerChunkElements, this.#fillPattern)
    // ITEM-11 — one DECODE of this member. Counted here rather than at the request layer
    // because artifact bytes are served `immutable`, so a repeated read is usually invisible
    // as a request and fully visible as a decode. Inert unless a test switched recording on.
    countDecode('', this.#path)
    const bytes = await decodeBytes(this.#chain, raw, this.dtype.itemSize)
    const expected = this.innerChunkElements * this.dtype.itemSize
    if (bytes.length < expected) {
      throw new ZarrFormatError(
        `${this.#path}: chunk ${g} decoded to ${bytes.length} bytes, expected ${expected}`,
      )
    }
    // A typed-array view demands an item-aligned `byteOffset`. `inflate`/`unshuffle`
    // each own a fresh buffer at offset 0, so a compressed chunk is aligned by
    // construction — but an array declaring an EMPTY codec chain (stored raw) hands
    // back the transport's own bytes, which for a range read start wherever the range
    // did. Copying only in that case keeps the common path zero-copy without leaving a
    // `RangeError` waiting for the first uncompressed artifact.
    const aligned = bytes.byteOffset % this.dtype.itemSize === 0 ? bytes : bytes.slice()
    return this.dtype.view(aligned.buffer, aligned.byteOffset, this.innerChunkElements)
  }

  /** An unsharded array: chunk `g` is its own file. Absent ⇒ `fill_value`. */
  async #plainChunkBytes(g: number): Promise<Uint8Array | null> {
    return this.#store.get(this.#member(chunkKey(this.meta, this.#rank, g)))
  }

  /**
   * A sharded array: chunk `g`'s stored bytes.
   *
   * TWO paths, and which one runs is a property of the READ, not of the chunk:
   *   whole-shard (ITEM-33) — the read covers every chunk in this shard, so the shard
   *     file is fetched ONCE, un-ranged, and every chunk is sliced out of the buffer.
   *   windowed — the read touches only part of the shard, so it costs one suffix read
   *     for the fixed-size index (cached for the array's life) plus one range per chunk.
   *     Fetching the whole shard for a 2-chunk window would be strictly worse.
   */
  async #shardChunkBytes(g: number, plan: ReadPlan): Promise<Uint8Array | null> {
    const shard = Math.floor(g / this.#chunksPerShard)
    const slot = g % this.#chunksPerShard
    if (this.#wantsWholeShard(shard, plan)) {
      const whole = await this.#wholeShard(shard, plan)
      if (!whole) return null
      const span = this.#chunkSpan(whole.index, shard, slot)
      if (!span) return null
      // The bounds check moved INTO `slice`: a streamed shard does not know its length
      // until the body ends, so "is this span inside the shard?" can only be answered
      // there. Both forms still refuse an out-of-range span rather than returning short.
      return whole.slice(span.start, span.end)
    }
    const index = await this.#loadShardIndex(shard)
    if (!index) return null
    const span = this.#chunkSpan(index, shard, slot)
    if (!span) return null
    return this.#store.getRange(
      this.#member(chunkKey(this.meta, this.#rank, shard)),
      span.start,
      span.end - span.start,
    )
  }

  /** One index slot → the shard-relative byte span of that inner chunk, or `null` for
   *  the v3 "never written" sentinel (which reads as `fill_value`). */
  #chunkSpan(index: BigUint64Array, shard: number, slot: number): { start: number; end: number } | null {
    const offset = index[slot * 2]
    const nbytes = index[slot * 2 + 1]
    if (offset === EMPTY_CHUNK || nbytes === EMPTY_CHUNK) return null
    if (offset > BigInt(Number.MAX_SAFE_INTEGER) || nbytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ZarrFormatError(`${this.#path}: shard ${shard} chunk ${slot} offset exceeds Number.MAX_SAFE_INTEGER`)
    }
    return { start: Number(offset), end: Number(offset) + Number(nbytes) }
  }

  /**
   * The WHOLE shard file, fetched once and held for as long as this read still has inner
   * chunks to slice out of it (ITEM-33).
   *
   * Memoized on the READ, not on the array: shard bytes are compressed chunk data that
   * the decoded-chunk LRU already holds in its useful form, so keeping them past the read
   * would double the memory for no hit rate. `chunks()` drops each entry as it schedules
   * that shard's last chunk, which bounds a 306-shard read to the prefetch window rather
   * than to the artifact.
   */
  #wholeShard(shard: number, plan: ReadPlan): Promise<ShardSource | null> {
    const held = plan.shards.get(shard)
    if (held) return held
    // ITEM-18 — PROGRESSIVE when the store can stream, buffered otherwise.
    //
    // The old path fetched the shard un-ranged and sliced the index out of the SAME
    // bytes. That reads well until you notice the index is a FOOTER (`index_location:
    // "end"`): chunk 0 cannot be LOCATED until the last byte of the shard has arrived, so
    // streaming the body was worth nothing and a full positions read — which always takes
    // this path, because it covers every chunk of every shard — could never be
    // progressive. It would have improved every path except the primary one.
    //
    // So: the fixed-size index FIRST, via the suffix read that already exists (one
    // `?range=-N`, no `Content-Length` and no HEAD), then the body streamed and each
    // inner chunk handed over as its span completes.
    //
    // COST, stated because it is the thing not to trade away: ONE extra small request per
    // shard. Total is one body + one index per shard, and still ZERO per-chunk range
    // requests — the 2,749→1 win ITEM-33 bought is intact, and TEST-22 pins it.
    const started = this.#store.getStream
      ? this.#streamWholeShard(shard)
      : this.#fetchWholeShard(shard)
    plan.shards.set(shard, started)
    return started
  }

  /**
   * The whole shard, streamed: index first, then the body, with each inner chunk released
   * the moment its byte span has arrived (ITEM-18).
   *
   * The index read is NOT an extra round trip in the common case — `#loadShardIndex`
   * memoizes per array and dedups in flight, so a second read of the same shard pays
   * nothing, and a windowed read that already loaded it pays nothing here either.
   *
   * If the store cannot stream this member (`getStream` returned `null` — a bodyless
   * response), it falls back to the buffered read rather than failing: a shard that
   * cannot stream should still be readable, just not progressively.
   */
  async #streamWholeShard(shard: number): Promise<ShardSource | null> {
    const index = await this.#loadShardIndex(shard)
    // Absent shard file ⇒ every chunk in it is `fill_value`. Same rule as both siblings.
    if (!index) return null
    const key = this.#member(chunkKey(this.meta, this.#rank, shard))
    let body: ReadableStream<Uint8Array> | null
    try {
      body = (await this.#store.getStream!(key)) ?? null
    } catch (error) {
      if (error instanceof WorkstoreHttpError && error.status === 404) return null
      throw error
    }
    if (!body) return this.#fetchWholeShard(shard)
    return streamingShard(body, index, key)
  }

  async #fetchWholeShard(shard: number): Promise<ShardSource | null> {
    const key = this.#member(chunkKey(this.meta, this.#rank, shard))
    let bytes: Uint8Array | null
    try {
      bytes = await this.#store.get(key)
    } catch (error) {
      // Same rule as `#loadShardIndex`: an absent shard file means every chunk in it is
      // `fill_value`. Only a 404 is absorbed.
      if (error instanceof WorkstoreHttpError && error.status === 404) return null
      throw error
    }
    if (!bytes || bytes.length === 0) return null
    const suffix = this.#indexSuffixBytes()
    if (bytes.length < suffix) {
      throw new ZarrFormatError(`${key}: shard is ${bytes.length} bytes, too short for a ${suffix}-byte index`)
    }
    const raw = this.#indexAtEnd ? bytes.subarray(bytes.length - suffix) : bytes.subarray(0, suffix)
    const index = this.#parseShardIndex(raw, key)
    // The index came free with the data, so remember it: a later WINDOWED read of this
    // same shard now costs one range request instead of a suffix read plus a range.
    this.#shardIndex.set(shard, index)
    return bufferedShard(bytes, index, key)
  }

  /** The fixed size of a shard index: `chunks_per_shard` (u64, u64) pairs, plus the
   *  crc32c when the index codecs declare one. */
  #indexSuffixBytes(): number {
    return this.#chunksPerShard * 2 * 8 + (this.#indexHasCrc ? 4 : 0)
  }

  /** Verify + view a shard index's raw bytes. Copies before viewing: a suffix range (or a
   *  slice of a whole shard) starts at an arbitrary byteOffset and `BigUint64Array`
   *  demands 8-byte alignment. */
  #parseShardIndex(raw: Uint8Array, key: string): BigUint64Array {
    const suffix = this.#indexSuffixBytes()
    if (raw.length !== suffix) {
      throw new ZarrFormatError(`${key}: shard index is ${raw.length} bytes, expected ${suffix}`)
    }
    const body = this.#indexHasCrc ? verifyCrc32c(raw, `${key} shard index`) : raw
    const aligned = body.slice()
    return new BigUint64Array(aligned.buffer, aligned.byteOffset, this.#chunksPerShard * 2)
  }

  /**
   * Read (and remember) a shard's index: `chunks_per_shard` pairs of little-endian u64
   * `(offset, nbytes)`, followed by a crc32c when the index codecs declare one.
   *
   * It is a FIXED size, which is the whole trick — a suffix `Range: bytes=-N` lands it
   * in ONE request with no prior knowledge of the shard's length (the Python reference
   * simulation needed a `stat()` for exactly this and HTTP has no equivalent that is
   * free). Indices are cached for the array's lifetime: 16 bytes per inner chunk, and
   * the artifact is immutable.
   */
  #loadShardIndex(shard: number): Promise<BigUint64Array | null> {
    const cached = this.#shardIndex.get(shard)
    if (cached) return Promise.resolve(cached)
    // Dedup the IN-FLIGHT fetch, not just the completed one. The prefetch window
    // schedules several chunks of a shard concurrently and they all reach here before
    // any of them has populated `#shardIndex`, so a cache keyed only on the resolved
    // value issues one identical suffix request PER CHUNK — the same duplication
    // ITEM-33 exists to remove, one level down. `#inFlight` does this for chunks; the
    // index needs its own because it is fetched before the chunk promise exists.
    const flight = this.#indexInFlight.get(shard)
    if (flight) return flight
    const started = this.#fetchShardIndex(shard).finally(() => {
      this.#indexInFlight.delete(shard)
    })
    this.#indexInFlight.set(shard, started)
    return started
  }

  async #fetchShardIndex(shard: number): Promise<BigUint64Array | null> {
    const suffix = this.#indexSuffixBytes()
    const key = this.#member(chunkKey(this.meta, this.#rank, shard))
    let raw: Uint8Array | null
    try {
      raw = this.#indexAtEnd
        ? await this.#store.getSuffix(key, suffix)
        : await this.#store.getRange(key, 0, suffix)
    } catch (error) {
      // A shard file that is not there means every chunk in it is `fill_value` — the
      // same rule the unsharded path gets for free from `get()` returning null on 404.
      // Without this the two paths disagree: a sparse artifact with an all-empty shard
      // would read fine unsharded and 404 sharded. Only a 404 is absorbed; any other
      // transport failure still propagates.
      if (error instanceof WorkstoreHttpError && error.status === 404) return null
      throw error
    }
    if (!raw || raw.length === 0) return null
    const index = this.#parseShardIndex(raw, key)
    this.#shardIndex.set(shard, index)
    return index
  }

  #member(key: string): string {
    return joinPath(this.#path, key)
  }
}

// ── opening ─────────────────────────────────────────────────────────────────────

/** Parse a `zarr.json` body, naming the node whose document is malformed. ONE parser for
 *  the array node and the group node: a bare `JSON.parse` throwing a `SyntaxError` that
 *  names neither the file nor the artifact is not a debuggable refusal. */
function parseZarrJson<T>(bytes: Uint8Array, path: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch (cause) {
    throw new ZarrFormatError(`${joinPath(path, 'zarr.json')}: not valid JSON (${String(cause)})`)
  }
}

/**
 * Open the Zarr array at `path` within `store` — one `zarr.json` fetch, no data.
 *
 * `path` is `''` when the artifact IS the array, or the member path when it is one
 * array inside a bundle (a table's column, one named array of a composite result).
 */
export async function openZarrArray(
  store: ZarrStore,
  path = '',
  options: ZarrArrayOptions = {},
): Promise<ZarrArray> {
  const key = joinPath(path, 'zarr.json')
  const bytes = await store.get(key)
  if (!bytes) throw new WorkstoreHttpError(404, `zarr: no ${key}`)
  return new ZarrArray(store, path, parseZarrJson<ZarrArrayMetadata>(bytes, path), options)
}

/**
 * Read a group's `zarr.json` (`node_type: "group"`) for its `attributes`.
 *
 * THROWS on an absent, unreadable or malformed document — it never answers `undefined` for
 * a group it failed to read. `undefined` means "the group is there and declares no `cyto`
 * attributes", and a caller that cannot tell that apart from "the read failed" degrades
 * into whatever its no-declaration fallback is (see `openSplitStringColumn`).
 */
export async function openZarrGroupAttributes(store: ZarrStore, path = ''): Promise<CytoArrayAttributes | undefined> {
  const key = joinPath(path, 'zarr.json')
  const bytes = await store.get(key)
  if (!bytes) throw new WorkstoreHttpError(404, `zarr: no ${key}`)
  const meta = parseZarrJson<{ attributes?: Record<string, unknown> }>(bytes, path)
  return (meta.attributes?.cyto ?? undefined) as CytoArrayAttributes | undefined
}

// ── logical decoders ────────────────────────────────────────────────────────────

/** A decoded categorical column: one integer code per row + the DECLARED labels.
 *  Codes keep their stored width — that is the zero-copy the encoding exists for. */
export interface ZarrCategoricalColumn {
  codes: ZarrCodeArray
  categories: string[]
}

/**
 * Read a categorical column: `uint8`/`uint16` codes plus the level set declared in
 * `zarr.json` `attributes.cyto.levels` (D10 — ONE artifact, not a codes artifact and a
 * levels artifact).
 *
 * This is the shape `canvasBinding.ts::encodeCategorical` synthesizes today by fetching
 * 150k JSON strings and re-encoding them. The artifact is already in this form, so the
 * fetch, the `JSON.parse` and the 150k-lookup Map all disappear.
 *
 * `categories` is the DECLARED set, so a level that never occurs in the data survives
 * into the legend — which is the point of DEC-6 choosing the code width from the
 * declaration: an unused level must not change the bytes, and must not vanish.
 */
export async function readCategorical(
  array: ZarrArray,
  options: { levels?: string[] } = {},
): Promise<ZarrCategoricalColumn> {
  const levels = options.levels ?? array.cyto?.levels
  if (!levels) {
    throw new ZarrFormatError(
      `${array.meta.data_type} array declares no attributes.cyto.levels — a categorical's level set is declared, never inferred from its codes`,
    )
  }
  const codes = await array.readAll()
  if (!(codes instanceof Uint8Array || codes instanceof Uint16Array || codes instanceof Uint32Array)) {
    throw new ZarrFormatError(`categorical codes must be uint8/uint16/uint32, got ${array.dtype.name}`)
  }
  return { codes, categories: [...levels] }
}

/**
 * Read the interleaved values of a `complex64`/`complex128` array as `{re, im}` — the
 * DECLARED representation for the two complex dtypes (ITEM-31).
 *
 * The stored layout is `[re0, im0, re1, im1, …]` and `array.read()` hands that back
 * verbatim, because that is what the bytes are. This is the step that stops every
 * consumer re-deriving `2i`/`2i+1` for itself — one that forgets reads the imaginary
 * part as a real value, and nothing anywhere errors.
 */
export async function readComplex(array: ZarrArray, lo = 0, hi = array.length): Promise<ZarrComplexPair> {
  if (array.dtype.representation !== 'complex') {
    throw new ZarrFormatError(`readComplex: ${array.dtype.name} is not a complex dtype`)
  }
  const interleaved = await array.read(lo, hi)
  if (!(interleaved instanceof Float32Array || interleaved instanceof Float64Array)) {
    throw new ZarrFormatError(`readComplex: ${array.dtype.name} decoded to a non-float array`)
  }
  return deinterleaveComplex(interleaved)
}

// ── string columns: LAZY by default (ITEM-32) ───────────────────────────────────
//
// `readSplitStrings` used to `readAll()` both members and materialize a `string[]`.
// Measured at 10M × 18 chars that is **979 ms and 580 MB of heap** — against **0.08 ms**
// for the 100 rows a table actually shows. The whole column is fetched, gunzipped,
// UTF-8-decoded and held as 10M JS strings so that a viewport can display 100 of them.
//
// So the primitive is an ACCESSOR that keeps `offsets` + `values` as bytes and decodes on
// demand, fetching only the chunks a window covers. `readAll()` is still there — a table
// export genuinely wants every value — but it is spelled out, and every other entry point
// hands back the accessor, so the expensive path is reached on purpose rather than by
// default.
//
// The accessor holds no bytes of its own: it holds the two `ZarrArray` handles, whose
// decoded chunks live in the SAME byte-budgeted LRU every other read uses. A long-lived
// accessor therefore cannot outgrow the chunk-cache budget — it participates in it.

/**
 * A string column addressed by index, decoded on demand.
 *
 * `length` is known from the DECLARATION before a byte of data is fetched, so a caller
 * can size a virtualized list up front and then pull only the window it paints.
 */
export interface ZarrStringColumn {
  /** how many strings the column holds (declared, never counted from the bytes). */
  readonly length: number
  /** value `index`. Fetches only the chunks covering that one string. */
  at(index: number): Promise<string>
  /** values `[lo, hi)`. Fetches only the chunks covering that window. */
  slice(lo: number, hi: number): Promise<string[]>
  /**
   * EVERY value. The explicit eager path — for a table export or a categorical coding
   * pass that genuinely needs the whole column. On a 10M-row column this is the 979 ms /
   * 580 MB read ITEM-32 exists to stop happening by accident.
   */
  readAll(): Promise<string[]>
}

/** Clamp a caller's window onto `[0, length]`. */
function clampWindow(lo: number, hi: number, length: number): [number, number] {
  const start = Math.max(0, Math.min(Math.trunc(lo), length))
  const end = Math.max(start, Math.min(Math.trunc(hi), length))
  return [start, end]
}

/**
 * A window of `[start, end)` needs exactly `end - start + 1` offsets. Fewer means the
 * read was CLAMPED — the declared count outruns what the member actually holds — and
 * decoding anyway would silently return fewer strings than the caller asked for at
 * indices that no longer line up. That is the failure INV-2 exists to make loud.
 */
function requireWindowOffsets(got: number, start: number, end: number, what: string): void {
  const want = end - start + 1
  if (got !== want) {
    throw new ZarrFormatError(
      `${what}: window [${start}, ${end}) needs ${want} offsets, the member yielded ${got}`,
    )
  }
}

/**
 * Open a string column in the SPLIT layout — an `offsets` (`uint32`) member and a
 * `values` (`uint8`) member under one group. The form `cyto_zarr.Table.string` emits, and
 * the one §2.5b's "shuffled offsets + gzip" measurement is of (a shuffle over one mixed
 * buffer would transpose the UTF-8 too).
 *
 * `path` names the GROUP. The count comes from `options.count`, else the group's
 * `attributes.cyto.n`, else the DECLARED `offsets` shape (`n + 1`) — all three are
 * declarations in `zarr.json`, none is derived from the data (INV-2). A declared `n` that
 * disagrees with the offsets shape is an error, not a precedence rule.
 *
 * The group read is therefore NOT best-effort. It used to be `.catch(() => undefined)`,
 * which made the mandatory check above conditional on the group happening to be readable:
 * a deleted, malformed or 500-ing `zarr.json` fell through to the offsets shape and the
 * disagreement it was supposed to catch went unreported. Absence must not select the
 * shallower check, so a failed read propagates: it is `options.count` (a declaration the
 * CALLER supplies, so the check still runs against it) that legitimately skips the read,
 * never a failure to perform it.
 */
export async function openSplitStringColumn(
  store: ZarrStore,
  path = '',
  options: ZarrArrayOptions & { count?: number } = {},
): Promise<ZarrStringColumn> {
  const [offsetsArray, valuesArray, groupAttrs] = await Promise.all([
    openZarrArray(store, joinPath(path, 'offsets'), options),
    openZarrArray(store, joinPath(path, 'values'), options),
    options.count === undefined
      ? openZarrGroupAttributes(store, path)
      : Promise.resolve(undefined),
  ])
  if (offsetsArray.dtype.name !== 'uint32') {
    throw new ZarrFormatError(`split strings: offsets must be uint32, got ${offsetsArray.dtype.name}`)
  }
  if (valuesArray.dtype.name !== 'uint8') {
    throw new ZarrFormatError(`split strings: values must be uint8, got ${valuesArray.dtype.name}`)
  }
  const fromShape = Math.max(0, offsetsArray.length - 1)
  const declared = options.count ?? groupAttrs?.n
  if (declared !== undefined && declared !== fromShape) {
    throw new ZarrFormatError(
      `split strings at "${path}": declared n=${declared} but the offsets member declares ${offsetsArray.length} offsets (n=${fromShape})`,
    )
  }
  const length = declared ?? fromShape

  const slice = async (lo: number, hi: number): Promise<string[]> => {
    const [start, end] = clampWindow(lo, hi, length)
    if (end <= start) return []
    // ONE offsets read + ONE payload read, both covering only this window's chunks.
    const offsets = (await offsetsArray.read(start, end + 1)) as Uint32Array
    requireWindowOffsets(offsets.length, start, end, 'split strings')
    const base = offsets[0]
    const stop = offsets[offsets.length - 1]
    const payload = (await valuesArray.read(base, stop)) as Uint8Array
    return decodeStringWindow(offsets, payload, base)
  }

  return {
    length,
    slice,
    async at(index) {
      const [one] = await slice(index, index + 1)
      if (one === undefined) throw new ZarrFormatError(`string index ${index} is outside [0, ${length})`)
      return one
    },
    async readAll() {
      return slice(0, length)
    },
  }
}

// The SINGLE-BUFFER arrow layout (`[u32 offsets × (n+1)][concatenated UTF-8]` in one
// `uint8` array) had a windowed accessor + an eager wrapper here. Both are DELETED, and
// the deletion is the finding: nothing could ever reach them. No producer emits the shape
// — `cyto_zarr.Table.string` writes the SPLIT form and stamps `layout: "split"` on every
// string member — and `conformance.py::_conform_string_member` reads `<path>/offsets` and
// `<path>/values` unconditionally, so a single-buffer member fails the framework gate
// before any reader sees it. `openStringColumn`'s `layout !== 'split'` arm was the only
// call site, and it now REFUSES by name instead of dispatching into an unreachable
// decoder. Re-add both (with a producer's bytes as the oracle) if the single-buffer form
// is ever emitted; until then a tested, exported, unreachable decoder is a claim of
// coverage the artifact model does not have.

/**
 * EAGER read of a split-layout string column — every value as a `string[]`.
 *
 * Kept for callers that genuinely want the whole column. Prefer `openSplitStringColumn`
 * and pull the window you paint: this materializes 10M JS strings for a 10M-row column
 * whether or not the caller looks at more than a hundred of them (ITEM-32).
 */
export async function readSplitStrings(
  store: ZarrStore,
  path = '',
  options: ZarrArrayOptions & { count?: number } = {},
): Promise<string[]> {
  return (await openSplitStringColumn(store, path, options)).readAll()
}
