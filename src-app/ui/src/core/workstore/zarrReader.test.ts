// zarrReader.test.ts — TEST-27/28 (ITEM-23) + TEST-42 (ITEM-31) + TEST-44 (ITEM-32) +
// TEST-45 (ITEM-33).
//
// CROSS-LANGUAGE PARITY, NOT A ROUND-TRIP. A reader tested against its own encoder
// certifies whatever the reader happens to do: a shuffle applied in the wrong direction
// on both sides, or a misread offset convention, round-trips perfectly and proves
// nothing.
//
// So the bytes here come from **the real producer** — `src-app/packages/_lib`'s
// `cyto_zarr`, the module a processor actually emits artifacts with (ITEM-1..4), driven
// by `__fixtures__/generate_zarr_fixtures.py` and checked in. Not a sketch of it, not a
// reimplementation: the shipping writer, in another language, with no compile-time link
// to this file. `cyto_zarr`'s docstring names THIS module as the consumer of its on-disk
// vocabulary; the fixtures are what make that claim checkable.
//
// Four anchors, weakest to strongest:
//   1. array fixtures         — bytes from the real writer, expected values from its inputs
//   2. `zarr/table/`          — a real `cyto_zarr.Table` artifact: n member arrays under
//                               ONE directory, the shape the client actually opens
//   3. primitive vectors      — each transform in isolation, so a failure names the
//                               STAGE; `isIdentity: false` stops the shuffle assertions
//                               going vacuous if the writer ever drops the codec
//   4. `crc32c("123456789")`  — the published CRC-32C check value, so a bug shared by
//                               BOTH implementations still fails
//
// Some fixtures are deliberately NOT from `cyto_zarr` (`i32_plain` and the four exotic
// dtypes `f16_*`/`c64`/`c128`/`r24`) — shapes and v3 CORE data types the reader must
// handle that the writer does not emit. The generator says which and why. `str_arrow` was
// a sixth until ROUND-6 FINDING 6: it fed a single-buffer string decoder that nothing
// could reach, and it went with that decoder rather than outliving it.
//
// TEST-42/44/45 are appended at the bottom. Two of the three are REQUEST-COUNT
// assertions, because their subject is invisible to a correctness test: a windowed string
// read and a whole-shard fetch return exactly the same values as the paths they replace,
// and differ only in what crosses the wire.
//
// Regenerate with:  python3 __fixtures__/generate_zarr_fixtures.py

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WorkstoreHttpError } from './binaryClient'
import {
  indexedBodyBytes,
  ZarrFormatError,
  crc32c,
  decodeFloat16,
  decodeStringWindow,
  float16ToFloat32,
  inflate,
  openSplitStringColumn,
  openZarrArray,
  readCategorical,
  readComplex,
  readSplitStrings,
  memoryStore,
  resolveDataType,
  toUint16Codes,
  unshuffle,
  type ZarrChunkSlice,
  type ZarrStore,
  type ZarrTypedArray,
} from './zarrReader'

// ── fixture loading ─────────────────────────────────────────────────────────────

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'zarr')

/** Load the whole fixture tree into one `{ storePath → bytes }` map — the same paths an
 *  artifact's `/data/{*member}` tree serves. */
function loadFixtureTree(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)))
    }
  }
  walk(root)
  return files
}

const TREE = loadFixtureTree(FIXTURES)
const store: ZarrStore = memoryStore(TREE)

/** Decoded elements as plain numbers, for comparison against `expected.json`. The
 *  `bigint` arms exist because Zarr v3 has 64-bit integer dtypes; no fixture uses one,
 *  so this widening is a type accommodation, not a lossy conversion in practice. */
function nums(values: ZarrTypedArray): number[] {
  if (values instanceof BigInt64Array || values instanceof BigUint64Array) {
    return Array.from(values, v => Number(v))
  }
  return Array.from(values)
}

interface PrimitiveVectors {
  shuffle: { elementsize: number; raw: number[]; shuffled: number[]; isIdentity: boolean }
  gzip: { raw: number[]; gzipped: number[] }
  crc32c: { bytes: number[]; value: number }[]
}
interface Expected {
  _primitives: PrimitiveVectors
  [name: string]: unknown
}

const EXPECTED = JSON.parse(new TextDecoder().decode(TREE.get('expected.json')!)) as Expected
const expectedFor = <T>(name: string): T => EXPECTED[name] as T

/** One entry of the REQUEST LOG. TEST-44 and TEST-45 are request-count assertions —
 *  every value returns correctly whether the reader fetches one shard or 300 ranges, so
 *  a correctness test is structurally blind to both — which means the log has to record
 *  the shape of each request, not just that one happened. */
interface StoreCall {
  /** `get` = the WHOLE member, no range (the ITEM-33 whole-shard fetch);
   *  `getRange` = a byte range; `getSuffix` = the trailing shard index. */
  method: 'get' | 'getRange' | 'getSuffix'
  path: string
  bytes: number
}

/** A store that logs every request, so the "chunk-granular, not whole-artifact" and
 *  "one request per shard, no separate index request" claims are asserted rather than
 *  assumed. */
function countingStore(inner: ZarrStore) {
  const stats = {
    requests: 0,
    bytes: 0,
    paths: [] as string[],
    calls: [] as StoreCall[],
    reset() {
      stats.requests = 0
      stats.bytes = 0
      stats.paths.length = 0
      stats.calls.length = 0
    },
    /** Requests against members under `prefix` (a column's `offsets` vs its `values`). */
    under(prefix: string): StoreCall[] {
      return stats.calls.filter(c => c.path.startsWith(prefix))
    },
  }
  const track = async (
    method: StoreCall['method'],
    path: string,
    p: Promise<Uint8Array | null>,
  ): Promise<Uint8Array | null> => {
    const b = await p
    stats.requests++
    stats.bytes += b?.byteLength ?? 0
    stats.paths.push(path)
    stats.calls.push({ method, path, bytes: b?.byteLength ?? 0 })
    return b
  }
  const wrapped: ZarrStore = {
    get: path => track('get', path, inner.get(path)) as Promise<Uint8Array | null>,
    getRange: (path, s, l) => track('getRange', path, inner.getRange(path, s, l)) as Promise<Uint8Array>,
    getSuffix: (path, l) => track('getSuffix', path, inner.getSuffix(path, l)) as Promise<Uint8Array>,
  }
  return { store: wrapped, stats }
}

/** Total STORED bytes of every chunk file under `prefix` (metadata excluded) — the
 *  denominator a "fetched only what it needed" claim has to be measured against. */
function storedBytesOf(prefix: string): number {
  return [...TREE.entries()]
    .filter(([p]) => p.startsWith(`${prefix}/`) && !p.endsWith('zarr.json'))
    .reduce((n, [, b]) => n + b.byteLength, 0)
}

/** `expected.json` spells the non-finite floats as strings — Python's `json` emits bare
 *  `NaN`/`Infinity`, which `JSON.parse` rejects. This reads them back. */
function expectedFloat(v: number | string): number {
  if (v === 'NaN') return Number.NaN
  if (v === 'Infinity') return Number.POSITIVE_INFINITY
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY
  return v as number
}

// ── TEST-27 · the byte layer, against the writer's bytes ─────────────────────────────

describe('TEST-27 · zero-dependency decode primitives (cross-language vectors)', () => {
  const prim = EXPECTED._primitives

  it('crc32c matches the PUBLISHED CRC-32C check value, not just the fixture writer', () => {
    // 0xe3069283 for "123456789" is the standard Castagnoli check value. A bug shared
    // by both implementations would agree with the fixture and still fail here.
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283)
    expect(crc32c(new Uint8Array(0))).toBe(0)
  })

  it('crc32c reproduces every writer-computed vector', () => {
    for (const v of prim.crc32c) {
      expect(crc32c(new Uint8Array(v.bytes))).toBe(v.value)
    }
  })

  it('unshuffle inverts the writer byte-shuffle exactly (and the shuffle is not a no-op)', () => {
    // The negative control: if `shuffled === raw` the assertion below would hold for a
    // reader whose unshuffle did nothing at all.
    expect(prim.shuffle.isIdentity).toBe(false)
    const back = unshuffle(new Uint8Array(prim.shuffle.shuffled), prim.shuffle.elementsize)
    expect(Array.from(back)).toEqual(prim.shuffle.raw)
  })

  it('unshuffle at elementSize 1 is the identity', () => {
    const bytes = new Uint8Array([9, 8, 7])
    expect(Array.from(unshuffle(bytes, 1))).toEqual([9, 8, 7])
  })

  it('inflate decodes a writer-produced gzip member with DecompressionStream', async () => {
    const out = await inflate(new Uint8Array(prim.gzip.gzipped))
    expect(Array.from(out)).toEqual(prim.gzip.raw)
  })
})

describe('TEST-27 · numeric arrays decode to the values the writer encoded', () => {
  interface F32 {
    length: number
    innerChunk: number
    chunksPerShard: number
    at: Record<string, number>
    sum: number
    slice_60_70: number[]
    slice_508_516: number[]
    slice_1090_1100: number[]
  }

  it('float32, sharded across 3 shards with a partial tail chunk and EMPTY slots', async () => {
    const exp = expectedFor<F32>('f32_sharded')
    const array = await openZarrArray(store, 'f32_sharded')
    expect(array.dtype.name).toBe('float32')
    expect(array.length).toBe(exp.length)
    expect(array.innerChunkElements).toBe(exp.innerChunk)
    expect(array.sharded).toBe(true)

    const values = await array.readAll()
    expect(values).toBeInstanceOf(Float32Array)
    expect(values.length).toBe(exp.length)
    for (const [i, v] of Object.entries(exp.at)) {
      // Exact, not approximate: these came out of the same 32-bit representation.
      expect(values[Number(i)]).toBe(v)
    }
    const sum = nums(values).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(exp.sum, 3)
  })

  it('shuffle is genuinely exercised — the fixture declares the codec', () => {
    const meta = JSON.parse(new TextDecoder().decode(TREE.get('f32_sharded/zarr.json')!)) as {
      codecs: { name: string; configuration?: { codecs?: { name: string }[] } }[]
    }
    const inner = meta.codecs[0].configuration?.codecs?.map(c => c.name) ?? []
    expect(inner).toEqual(['bytes', 'numcodecs.shuffle', 'gzip'])
  })

  it('a ranged read crosses chunk AND shard boundaries correctly', async () => {
    const exp = expectedFor<F32>('f32_sharded')
    const array = await openZarrArray(store, 'f32_sharded')
    // 60..70 straddles the first inner-chunk boundary (64).
    expect(nums(await array.read(60, 70))).toEqual(exp.slice_60_70)
    // 1090..1100 is the PADDED tail chunk of the last shard — the reader must clip the
    // writer's fill padding rather than hand back 64 elements.
    expect(nums(await array.read(1090, 1100))).toEqual(exp.slice_1090_1100)
    // 508..516 spans the SHARD boundary at 512 — two shard indices, two suffix reads.
    expect(nums(await array.read(508, 516))).toEqual(exp.slice_508_516)
  })

  it('float64 (elementSize 8) and int16 (elementSize 2, negatives) decode exactly', async () => {
    const f64 = expectedFor<{ length: number; at: Record<string, number>; sum: number }>('f64_sharded')
    const a64 = await openZarrArray(store, 'f64_sharded')
    const v64 = await a64.readAll()
    expect(v64).toBeInstanceOf(Float64Array)
    for (const [i, v] of Object.entries(f64.at)) expect(v64[Number(i)]).toBe(v)

    // int16 sign bits live in the high byte, so a transpose applied in the wrong
    // direction shows up here as wrong signs, not as subtly-wrong magnitudes.
    const i16 = expectedFor<{ values: number[] }>('i16_sharded')
    const a16 = await openZarrArray(store, 'i16_sharded')
    const v16 = await a16.readAll()
    expect(v16).toBeInstanceOf(Int16Array)
    expect(nums(v16)).toEqual(i16.values)
  })

  it('uint8 arrays carry a 2-codec chain (the writer omits the identity shuffle)', async () => {
    const exp = expectedFor<{ values: number[] }>('u8_noshuffle')
    const array = await openZarrArray(store, 'u8_noshuffle')
    const values = await array.readAll()
    expect(values).toBeInstanceOf(Uint8Array)
    expect(nums(values)).toEqual(exp.values)
  })

  it('an UNSHARDED array (one file per chunk, no index) decodes', async () => {
    const exp = expectedFor<{ values: number[] }>('i32_plain')
    const array = await openZarrArray(store, 'i32_plain')
    expect(array.sharded).toBe(false)
    const values = await array.readAll()
    expect(values).toBeInstanceOf(Int32Array)
    expect(nums(values)).toEqual(exp.values)
  })

  it('a row-chunked 2-D array reads flat and by row', async () => {
    const exp = expectedFor<{ shape: number[]; length: number; flat: number[] }>('f32_rowchunk_2d')
    const array = await openZarrArray(store, 'f32_rowchunk_2d')
    expect([...array.shape]).toEqual(exp.shape)
    expect(array.rowElements).toBe(2)
    expect(nums(await array.readAll())).toEqual(exp.flat)
    // rows [3, 5) → flat [6, 10)
    expect(nums(await array.readRows(3, 5))).toEqual(exp.flat.slice(6, 10))
  })
})

describe('TEST-27 · shard-index handling', () => {
  it('locates the index with ONE suffix range and reads only the chunks a range covers', async () => {
    const { store: counted, stats } = countingStore(store)
    const array = await openZarrArray(counted, 'f32_sharded')
    stats.reset()

    // 10 elements — one inner chunk of 64, inside a shard of 8 chunks. The read covers
    // a FRACTION of the shard, so this is the windowed path, NOT ITEM-33's whole-shard
    // fetch (which TEST-45 covers): fetching 512 elements to serve 10 would be worse.
    await array.read(0, 10)
    // 1 suffix read for shard 0's index + 1 range read for inner chunk 0.
    expect(stats.requests).toBe(2)
    expect(stats.paths).toEqual(['f32_sharded/c/0', 'f32_sharded/c/0'])
    // The whole array is 1100 float32 = 4400 raw bytes; this read must be far under it.
    expect(stats.bytes).toBeLessThan(1000)

    // The index is cached for the array's lifetime (the artifact is immutable), and so
    // is the decoded chunk — a second read of the same range costs nothing.
    const before = stats.requests
    await array.read(0, 10)
    expect(stats.requests).toBe(before)
  })

  it('an ABSENT shard reads as fill_value, matching the unsharded rule', async () => {
    // Zarr's rule is "a chunk that was never written is fill_value", and the unsharded
    // path gets that for free from a 404. The sharded path has to absorb the same 404
    // explicitly or the two disagree — an all-empty shard would read fine one way and
    // throw the other.
    const withoutShard = new Map(TREE)
    withoutShard.delete('f32_sharded/c/1')
    const array = await openZarrArray(memoryStore(withoutShard), 'f32_sharded')
    expect(nums(await array.read(512, 520))).toEqual(new Array(8).fill(0))
    // …and the surviving shards still decode.
    const exp = expectedFor<{ at: Record<string, number> }>('f32_sharded')
    expect((await array.read(0, 1))[0]).toBe(exp.at['0'])
  })

  it('decodes an UNCOMPRESSED array even when the transport hands back an unaligned view', async () => {
    // An empty codec chain means the chunk bytes reach the dtype view untouched, so
    // whatever `byteOffset` the transport chose is the one a `Float32Array` view would
    // get — and a non-multiple-of-4 offset throws `RangeError`. `artifactStore` always
    // starts at 0, but a caching or slicing store need not, so the reader copies rather
    // than assuming.
    const raw = new Float32Array([1.5, -2.25, 3, 4.75])
    const padded = new Uint8Array(raw.byteLength + 1)
    padded.set(new Uint8Array(raw.buffer), 1) // deliberately offset by one byte
    const unalignedStore: ZarrStore = {
      async get(path) {
        if (path === 'zarr.json') {
          return new TextEncoder().encode(
            JSON.stringify({
              zarr_format: 3,
              node_type: 'array',
              shape: [4],
              data_type: 'float32',
              chunk_grid: { name: 'regular', configuration: { chunk_shape: [4] } },
              chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
              fill_value: 0,
              codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
            }),
          )
        }
        return padded.subarray(1)
      },
      async getRange(_p, s, l) {
        return padded.subarray(1 + s, 1 + s + l)
      },
      async getSuffix(_p, l) {
        return padded.subarray(padded.length - l)
      },
    }
    const array = await openZarrArray(unalignedStore)
    expect(nums(await array.readAll())).toEqual([1.5, -2.25, 3, 4.75])
  })

  it('rejects a corrupted shard index instead of decoding garbage', async () => {
    const corrupted = new Map(TREE)
    const shard = new Uint8Array(TREE.get('f32_sharded/c/0')!)
    // Flip a bit inside the index (the last 4 bytes are the crc32c itself).
    shard[shard.length - 8] ^= 0x01
    corrupted.set('f32_sharded/c/0', shard)
    const array = await openZarrArray(memoryStore(corrupted), 'f32_sharded')
    await expect(array.read(0, 10)).rejects.toThrow(/crc32c mismatch/)
  })
})

describe('TEST-27 · progressive reading (chunk arrival IS rendering)', () => {
  it('chunks() yields in order, with a determinate total known before any data lands', async () => {
    const array = await openZarrArray(store, 'f32_sharded')
    expect(array.chunkCountFor(0, array.length)).toBe(Math.ceil(1100 / 64))
    expect(array.chunkCountFor(60, 70)).toBe(2)

    const slices: ZarrChunkSlice[] = []
    for await (const slice of array.chunks(0, 200)) slices.push(slice)
    expect(slices.map(s => s.index)).toEqual([0, 1, 2, 3])
    expect(slices.every(s => s.total === 4)).toBe(true)
    expect(slices.map(s => s.offset)).toEqual([0, 64, 128, 192])
    expect(slices.map(s => s.values.length)).toEqual([64, 64, 64, 8])
  })

  it('readInto fills a caller-owned buffer and reports progress per chunk', async () => {
    const exp = expectedFor<{ length: number; at: Record<string, number> }>('f32_sharded')
    const array = await openZarrArray(store, 'f32_sharded')
    // Allocate ONCE from the declared length — the shape §2.5b calls for.
    const out = new Float32Array(array.length)
    const seen: number[] = []
    await array.readInto(out, 0, array.length, s => seen.push(s.index))
    expect(seen).toEqual([...Array(Math.ceil(exp.length / 64)).keys()])
    for (const [i, v] of Object.entries(exp.at)) expect(out[Number(i)]).toBe(v)
  })

  it('readInto refuses a destination that is too small', async () => {
    const array = await openZarrArray(store, 'f32_sharded')
    await expect(array.readInto(new Float32Array(4), 0, 100)).rejects.toThrow(ZarrFormatError)
  })
})

describe('TEST-27 · declaration errors are errors, never a best-effort guess (INV-2)', () => {
  const metaStore = (meta: unknown): ZarrStore =>
    memoryStore({ 'zarr.json': new TextEncoder().encode(JSON.stringify(meta)) })

  const base = {
    zarr_format: 3,
    node_type: 'array',
    shape: [8, 4],
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [4, 4] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
  }

  it('refuses chunking that splits a dimension other than the first', async () => {
    await expect(
      openZarrArray(metaStore({ ...base, chunk_grid: { name: 'regular', configuration: { chunk_shape: [4, 2] } } })),
    ).rejects.toThrow(/splits dimension 1/)
  })

  it('refuses big-endian, an unknown dtype, and a WASM-only codec', async () => {
    await expect(
      openZarrArray(metaStore({ ...base, codecs: [{ name: 'bytes', configuration: { endian: 'big' } }] })),
    ).rejects.toThrow(/only "little" is supported/)
    // `float16` USED to be the unknown-dtype example here; ITEM-31 implements it, so the
    // negative control has to name something the v3 core set genuinely does not contain
    // — otherwise "unknown dtypes throw" would quietly stop being tested at all.
    await expect(openZarrArray(metaStore({ ...base, data_type: 'decimal128' }))).rejects.toThrow(
      /unsupported Zarr data_type/,
    )
    const blosc = await openZarrArray(
      memoryStore({
        'zarr.json': new TextEncoder().encode(
          JSON.stringify({
            ...base,
            shape: [4],
            chunk_grid: { name: 'regular', configuration: { chunk_shape: [4] } },
            codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'blosc' }],
          }),
        ),
        // A chunk must EXIST for the codec chain to run at all — an absent chunk is
        // `fill_value`, which would decode "successfully" and hide the refusal.
        'c/0': new Uint8Array([1, 2, 3, 4]),
      }),
    )
    // The message must name the reason, not just "unsupported": blosc is excluded by
    // decision, because it costs a WASM dependency (DEC-4).
    await expect(blosc.read(0, 4)).rejects.toThrow(/WASM decoder/)
  })
})

// ── ROUND-6 FINDING 5 · an array→array codec is REFUSED, never dropped ───────────
//
// The codec chain used to be split as `codecs.slice(indexOf('bytes') + 1)`, which keeps
// the bytes→bytes tail and DISCARDS everything before `bytes` — i.e. every array→array
// codec, silently. A dropped `transpose` does not fail: it hands back the STORED
// permutation as if it were the values, which for the 2×3 fixture below is
// `[0,3,1,4,2,5]` where the array holds `[0,1,2,3,4,5]`. Six plausible numbers, in the
// wrong order, with no error anywhere — the worst failure mode this reader has.
//
// The fix is a refusal, not an implementation of `transpose`: no producer in
// `src-app/packages/` emits an array→array codec (`cyto_zarr._codec_chain` builds
// exactly `[bytes, (numcodecs.shuffle)?, gzip]`, and `_array_meta` wraps that in a lone
// `sharding_indexed`), so there is nothing to support and no producer bytes to test an
// implementation against — but there IS a wrong answer to stop returning.
//
// EVERY case below is paired with a control, because a throw alone proves nothing: a
// reader that threw for the wrong reason (an unreadable chunk, an unknown dtype) would
// satisfy a bare `rejects.toThrow`.

describe('ROUND-6 FINDING 5 · array→array codecs are refused by name (never dropped)', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))

  /** The array's LOGICAL values: a 2×3 C-order `[[0,1,2],[3,4,5]]`. */
  const LOGICAL = [0, 1, 2, 3, 4, 5]
  /** What `transpose{order:[1,0]}` STORES for those values — the 3×2 transpose. */
  const STORED = Uint8Array.from([0, 3, 1, 4, 2, 5])

  const base2x3 = {
    zarr_format: 3,
    node_type: 'array',
    shape: [2, 3],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 3] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
  }
  const BYTES = { name: 'bytes', configuration: { endian: 'little' } }
  const TRANSPOSE = { name: 'transpose', configuration: { order: [1, 0] } }

  const storeOf = (codecs: unknown[], chunk: Uint8Array): ZarrStore =>
    memoryStore({ 'zarr.json': enc({ ...base2x3, codecs }), 'c/0/0': chunk })

  it('THE ORACLE: ignoring the codec returns a PERMUTATION, not an error', async () => {
    // Exactly what the old `slice(bytesAt + 1)` produced: the same stored bytes read
    // under a chain with the `transpose` gone. It succeeds, and it is WRONG.
    const asIfDropped = await openZarrArray(storeOf([BYTES], STORED))
    const values = nums(await asIfDropped.readAll())
    expect(values).toEqual([0, 3, 1, 4, 2, 5])
    expect(values).not.toEqual(LOGICAL)
    // ANTI-VACUITY: the codec is not the identity on this fixture, so "refused" and
    // "applied" are genuinely distinguishable here. Without this, a fixture whose
    // transpose happened to be a no-op would make every assertion below vacuous.
    expect(Array.from(STORED)).not.toEqual(LOGICAL)
  })

  it('a declared `transpose` is REFUSED at open, naming the codec and the reason', async () => {
    const opening = openZarrArray(storeOf([TRANSPOSE, BYTES], STORED))
    await expect(opening).rejects.toThrow(ZarrFormatError)
    await expect(openZarrArray(storeOf([TRANSPOSE, BYTES], STORED))).rejects.toThrow(/"transpose"/)
    await expect(openZarrArray(storeOf([TRANSPOSE, BYTES], STORED))).rejects.toThrow(
      /before "bytes"/,
    )
    // The message must say what the alternative WOULD have done, or the next author
    // "fixes" it by dropping the codec again.
    await expect(openZarrArray(storeOf([TRANSPOSE, BYTES], STORED))).rejects.toThrow(
      /STORED permutation/,
    )
  })

  it('the refusal costs ONE request — `zarr.json`, and no chunk', async () => {
    // A declaration error is knowable from the declaration. Refusing only once the first
    // chunk decodes would make every consumer pay a round-trip to learn it.
    const { store: counted, stats } = countingStore(storeOf([TRANSPOSE, BYTES], STORED))
    await expect(openZarrArray(counted)).rejects.toThrow(ZarrFormatError)
    expect(stats.paths).toEqual(['zarr.json'])
  })

  it('every array→array codec in the chain is named, not just the first', async () => {
    const two = [TRANSPOSE, { name: 'squeeze' }, BYTES]
    await expect(openZarrArray(storeOf(two, STORED))).rejects.toThrow(/"transpose", "squeeze"/)
  })

  it('NEGATIVE CONTROL: the supported chain still decodes, to the RIGHT values', async () => {
    // Same shape, same dtype, same chunk grid — only the codec chain differs. If the
    // refusal above were over-broad, this would break, and the reader would refuse the
    // one chain every producer actually writes.
    const ok = await openZarrArray(storeOf([BYTES], Uint8Array.from(LOGICAL)))
    expect(nums(await ok.readAll())).toEqual(LOGICAL)
    // …and the row addressing the whole flat-C-order design rests on still holds.
    expect(nums(await ok.readRows(1, 2))).toEqual([3, 4, 5])
  })

  it('NEGATIVE CONTROL: a bytes→bytes codec AFTER `bytes` is still a valid chain', async () => {
    // The refusal is positional — before `bytes` — so the shuffle+gzip tail every real
    // member declares must be unaffected. The writer's own f32 fixture is the proof.
    const array = await openZarrArray(store, 'f32_sharded')
    const exp = expectedFor<{ at: Record<string, number> }>('f32_sharded')
    const values = await array.readAll()
    for (const [i, v] of Object.entries(exp.at)) expect(values[Number(i)]).toBe(v)
  })
})

describe('ROUND-6 FINDING 5 · a codec beside `sharding_indexed` is refused too', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const shardCfg = {
    name: 'sharding_indexed',
    configuration: {
      chunk_shape: [4],
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
      index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }],
      index_location: 'end',
    },
  }
  const shardedMeta = (codecs: unknown[]) => ({
    zarr_format: 3,
    node_type: 'array',
    shape: [8],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [8] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs,
  })
  const open = (codecs: unknown[]) =>
    openZarrArray(memoryStore({ 'zarr.json': enc(shardedMeta(codecs)) }))

  it('an outer bytes→bytes codec is refused — it would misaddress the shard index', async () => {
    // `sharding_indexed` IS the array→bytes codec, so a codec after it wraps the WHOLE
    // shard file. This reader reads the index out of a suffix range of the raw file and
    // slices chunks at the index's own byte offsets; over a gzipped shard every one of
    // those offsets addresses the wrong bytes.
    await expect(open([shardCfg, { name: 'gzip', configuration: { level: 5 } }])).rejects.toThrow(
      ZarrFormatError,
    )
    await expect(open([shardCfg, { name: 'gzip', configuration: { level: 5 } }])).rejects.toThrow(
      /"gzip" sits beside "sharding_indexed"/,
    )
  })

  it('an outer array→array codec before the shard codec is refused', async () => {
    await expect(
      open([{ name: 'transpose', configuration: { order: [0] } }, shardCfg]),
    ).rejects.toThrow(/"transpose" sits beside "sharding_indexed"/)
  })

  it('NEGATIVE CONTROL: the lone `sharding_indexed` every producer writes still opens', async () => {
    // `_array_meta` emits exactly this, so an over-broad refusal here would refuse every
    // artifact the writer has ever produced.
    const array = await open([shardCfg])
    expect(array.sharded).toBe(true)
    expect(array.innerChunkElements).toBe(4)
    // And the real fixture decodes to the writer's values, not merely "opens".
    const real = await openZarrArray(store, 'i16_sharded')
    expect(real.sharded).toBe(true)
    expect((await real.readAll()).length).toBeGreaterThan(0)
  })
})

// ── TEST-28 · categorical + arrow strings, off a REAL table artifact ─────────────
//
// `zarr/table/` was written through `cyto_zarr.Table` — the exact call a processor
// makes (ITEM-4): n arrays sharing one axis under ONE directory, one merkle identity.
// Everything above exercises the byte layer; this exercises the artifact SHAPE the
// client will actually open.

describe('TEST-28 · categorical {codes, categories}', () => {
  interface TableExpected {
    n: number
    f32col: { at: Record<string, number> }
    cat8: { levels: string[]; codes: number[]; values: string[]; unusedLevel: string }
    cat16: { levelCount: number; codes: number[]; values: string[] }
    str: { n: number; values: string[] }
  }
  const table = () => expectedFor<TableExpected>('table')

  it('the table artifact is one directory of member arrays (one merkle identity)', async () => {
    const exp = table()
    // The group node carries the producer's `structure` under `attributes.cyto`, so a
    // client handed nothing but the store URL learns how to decode every member from
    // the first request it was going to make anyway.
    const group = JSON.parse(new TextDecoder().decode(TREE.get('table/zarr.json')!)) as {
      node_type: string
      attributes: { cyto: { kind: string; axis: string; n: number; columns: unknown[] } }
    }
    expect(group.node_type).toBe('group')
    expect(group.attributes.cyto.kind).toBe('table')
    expect(group.attributes.cyto.n).toBe(exp.n)
    expect(group.attributes.cyto.columns.length).toBe(4)

    // …and a member reads by path through that one directory.
    const col = await openZarrArray(store, 'table/f32col')
    const values = await col.readAll()
    for (const [i, v] of Object.entries(exp.f32col.at)) expect(values[Number(i)]).toBe(v)
  })

  it('uint8 codes + declared levels decode to the values the writer encoded', async () => {
    const exp = table().cat8
    const array = await openZarrArray(store, 'table/cat8')
    const { codes, categories } = await readCategorical(array)

    expect(codes).toBeInstanceOf(Uint8Array)
    expect(nums(codes)).toEqual(exp.codes)
    expect(categories).toEqual(exp.levels)
    // The end-to-end claim: codes ∘ categories reconstructs the original labels.
    expect(nums(codes).map(c => categories[c])).toEqual(exp.values)
  })

  it('carries non-ASCII levels and a genuine empty-string level', async () => {
    const exp = table().cat8
    const { categories } = await readCategorical(await openZarrArray(store, 'table/cat8'))
    expect(categories).toContain('café ☕')
    // An empty string is a real level, not a missing one — it must survive as ''.
    expect(categories).toContain('')
    expect(exp.values.filter(v => v === '')).not.toHaveLength(0)
  })

  it('keeps a level DECLARED but never observed in the data', async () => {
    const exp = table().cat8
    const { codes, categories } = await readCategorical(await openZarrArray(store, 'table/cat8'))
    // DEC-6: the code width — and the legend — follow the DECLARED level set. If the
    // reader derived categories from the observed codes instead, this level would
    // silently disappear from every legend and filter, and the artifact would re-encode
    // to different bytes (a new content_hash) for identical meaning.
    expect(categories).toContain(exp.unusedLevel)
    const unusedCode = categories.indexOf(exp.unusedLevel)
    expect(nums(codes)).not.toContain(unusedCode)
  })

  it('uint16 codes carry a >256-level declaration', async () => {
    const exp = table().cat16
    const array = await openZarrArray(store, 'table/cat16')
    const { codes, categories } = await readCategorical(array)
    // 300 declared levels ⇒ uint16, chosen from the DECLARATION (DEC-6).
    expect(codes).toBeInstanceOf(Uint16Array)
    expect(categories).toHaveLength(exp.levelCount)
    expect(nums(codes)).toEqual(exp.codes)
    expect(nums(codes).map(c => categories[c])).toEqual(exp.values)
  })

  it('refuses to invent a level set when none is declared', async () => {
    // A uint8 array is not a categorical because its values happen to be small.
    const array = await openZarrArray(store, 'u8_noshuffle')
    await expect(readCategorical(array)).rejects.toThrow(/levels/)
  })

  it('toUint16Codes narrows losslessly and ERRORS rather than wrapping', async () => {
    const exp = table().cat8
    const { codes, categories } = await readCategorical(await openZarrArray(store, 'table/cat8'))
    expect(nums(toUint16Codes(codes, categories.length))).toEqual(exp.codes)
    expect(() => toUint16Codes(codes, 70000)).toThrow(/wrap/)
  })
})

describe('TEST-28 · arrow-layout strings', () => {
  const table = () => expectedFor<{ str: { n: number; values: string[] } }>('table').str

  it('SPLIT layout (shuffled u32 offsets + gzipped UTF-8) decodes to what the writer encoded', async () => {
    // The form `cyto_zarr` actually emits, and the one §2.5b's "shuffled offsets + gzip"
    // measurement is of — a shuffle over one mixed buffer would transpose the UTF-8 too.
    expect(await readSplitStrings(store, 'table/str')).toEqual(table().values)
  })

  it('handles non-ASCII, an empty string, duplicates and control characters', async () => {
    const values = await readSplitStrings(store, 'table/str')
    expect(values).toContain('日本語テスト')
    expect(values).toContain('emoji ☕🛰')
    expect(values).toContain('naïve')
    expect(values).toContain('tab\tand\nnewline')
    // '' must be a value at its own index, not a skipped slot.
    expect(values[3]).toBe('')
    expect(values).toHaveLength(table().n)
    // The layout is NOT dictionary-encoded, so a repeated string repeats verbatim.
    expect(values[0]).toBe(values[5])
  })

  // The SINGLE-BUFFER arrow layout had three cases here (decode / undeclared-count
  // refusal / short-header refusal). They went with the decoder: no producer emits that
  // shape (`cyto_zarr.Table.string` writes the split form and stamps `layout: "split"`),
  // and `conformance.py::_conform_string_member` refuses it outright by reading
  // `<path>/offsets` + `<path>/values`. Tests for a path nothing can reach are coverage
  // in name only. `artifactReader.test.ts` now asserts the refusal that replaced it.

  it('rejects offsets that point outside the payload', () => {
    // offsets = [0, 0, 999] over a 4-byte payload: value 2 runs off the end.
    expect(() => decodeStringWindow(new Uint32Array([0, 0, 999]), new Uint8Array(4), 0)).toThrow(
      /outside the/,
    )
    // …and a `base` that does not match the window's first offset reads BEFORE the
    // payload, which is the specific way a windowed read goes silently wrong.
    expect(() => decodeStringWindow(new Uint32Array([100, 104]), new Uint8Array(4), 200)).toThrow(
      /outside the/,
    )
  })

})

// ── ROUND-6 FINDING 4 · the declared-`n` check cannot be skipped by a failed read ──
//
// `openSplitStringColumn` reads the GROUP's `zarr.json` for `attributes.cyto.n` and
// refuses a declared `n` that disagrees with the `offsets` member's shape. That read was
// `.catch(() => undefined)`, so ANY failure — a deleted group node, a malformed document,
// a 500 — turned the mandatory check into no check: the reader fell through to the shape
// it derives from the offsets member and answered with a length nobody declared.
//
// This is the "absence selects a shallower check" class. Absence of the declaration is a
// legitimate state (there is a documented fallback); absence of the ABILITY TO READ it is
// not, and the two were indistinguishable.
//
// The fixture is hand-laid so the disagreement is real: the group declares `n = 5`, the
// offsets member declares 4 offsets (⇒ 3 values), and the payload holds `['a','bc','def']`.
// Every refusal below is paired with the same store read successfully.

describe('ROUND-6 FINDING 4 · an unreadable group `zarr.json` is an ERROR, not a fallback', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))

  /** The three values the payload really holds — the offsets member's own declaration. */
  const TRUE_VALUES = ['a', 'bc', 'def']
  const OFFSETS = Uint32Array.from([0, 1, 3, 6])

  const arrayMeta = (dtype: 'uint32' | 'uint8', n: number) => ({
    zarr_format: 3,
    node_type: 'array',
    shape: [n],
    data_type: dtype,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [n] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
  })

  /** A split string group at `col/`, whose group node declares `n = groupN`. */
  function splitColumn(groupN: number): Record<string, Uint8Array> {
    return {
      'col/zarr.json': enc({
        zarr_format: 3,
        node_type: 'group',
        attributes: { cyto: { kind: 'string', layout: 'split', n: groupN } },
      }),
      'col/offsets/zarr.json': enc(arrayMeta('uint32', OFFSETS.length)),
      'col/offsets/c/0': new Uint8Array(OFFSETS.buffer.slice(0)),
      'col/values/zarr.json': enc(arrayMeta('uint8', 6)),
      'col/values/c/0': new TextEncoder().encode('abcdef'),
    }
  }

  /** The same tree with the group node broken in one of the three observed ways. */
  function broken(how: 'deleted' | 'malformed' | 'http500'): ZarrStore {
    const files = splitColumn(5)
    if (how === 'malformed') files['col/zarr.json'] = new TextEncoder().encode('{ "attributes": ')
    if (how === 'deleted') delete files['col/zarr.json']
    const inner = memoryStore(files)
    if (how !== 'http500') return inner
    return {
      get: async path => {
        if (path === 'col/zarr.json') throw new WorkstoreHttpError(500, 'workstore get → boom')
        return inner.get(path)
      },
      getRange: inner.getRange,
      getSuffix: inner.getSuffix,
    }
  }

  it('CAUGHT CONTROL: with the group READABLE, the disagreement is refused today', async () => {
    // The check itself works. Everything below is about it being reachable.
    await expect(openSplitStringColumn(memoryStore(splitColumn(5)), 'col')).rejects.toThrow(
      /declared n=5 but the offsets member declares 4 offsets \(n=3\)/,
    )
  })

  it('a DELETED group node propagates the 404 instead of falling back', async () => {
    const opening = openSplitStringColumn(broken('deleted'), 'col')
    await expect(opening).rejects.toThrow(WorkstoreHttpError)
    await expect(openSplitStringColumn(broken('deleted'), 'col')).rejects.toThrow(
      /no col\/zarr\.json/,
    )
  })

  it('a MALFORMED group node is refused by name, not swallowed', async () => {
    // A bare `JSON.parse` SyntaxError names neither the artifact nor the file, so the
    // group node goes through the same named parser the array node does.
    await expect(openSplitStringColumn(broken('malformed'), 'col')).rejects.toThrow(ZarrFormatError)
    await expect(openSplitStringColumn(broken('malformed'), 'col')).rejects.toThrow(
      /col\/zarr\.json: not valid JSON/,
    )
  })

  it('a 500 on the group node propagates — a transport failure is not "no declaration"', async () => {
    const failed = await openSplitStringColumn(broken('http500'), 'col').catch(e => e)
    expect(failed).toBeInstanceOf(WorkstoreHttpError)
    expect((failed as WorkstoreHttpError).status).toBe(500)
  })

  it('THE ORACLE: each of those three used to answer with an UNDECLARED length', async () => {
    // What the fallback produced: the offsets-derived count, silently. The producer said
    // 5, the accessor said 3 — and 3 is not "close", it is a different column, at indices
    // that no longer line up with anything the producer wrote.
    const offsetsDerived = OFFSETS.length - 1
    expect(offsetsDerived).toBe(3)
    expect(offsetsDerived).not.toBe(5)
    // Proof the fallback is a real, reachable code path and not a straw man: supply the
    // declaration the group would have carried and the SAME store opens and decodes.
    const healthy = await openSplitStringColumn(memoryStore(splitColumn(3)), 'col')
    expect(healthy.length).toBe(offsetsDerived)
    expect(await healthy.readAll()).toEqual(TRUE_VALUES)
  })

  it('a CALLER-supplied count still skips the read — and is still checked', async () => {
    // `options.count` is a declaration the caller holds (the member row's `n`), so
    // skipping the group read for it is legitimate. The distinction the fix draws is
    // between "the declaration came from somewhere else" and "reading it failed": the
    // check runs against the caller's number on a store whose group node is GONE.
    await expect(
      openSplitStringColumn(broken('deleted'), 'col', { count: 5 }),
    ).rejects.toThrow(/declared n=5 but the offsets member declares 4 offsets \(n=3\)/)
    const ok = await openSplitStringColumn(broken('deleted'), 'col', { count: 3 })
    expect(ok.length).toBe(3)
    expect(await ok.readAll()).toEqual(TRUE_VALUES)
  })

  it('NEGATIVE CONTROL: the writer\'s own string column still opens and reads its VALUES', async () => {
    // A group read that propagates must not turn the healthy path into a failure. This is
    // the real `cyto_zarr.Table.string` artifact, read with no `count` at all — so the
    // group node IS fetched, parsed, and its `n` agrees.
    const exp = expectedFor<{ str: { n: number; values: string[] } }>('table').str
    const column = await openSplitStringColumn(store, 'table/str')
    expect(column.length).toBe(exp.n)
    expect(await column.readAll()).toEqual(exp.values)
    expect(await column.at(3)).toBe(exp.values[3])
  })
})

// ── TEST-42 · complete Zarr v3 dtype coverage (ITEM-31) ──────────────────────────
//
// The reader implemented 11 of the v3 CORE set. `float16`, `complex64`, `complex128` and
// raw-bits `r<N>` threw as "unsupported" — and JS has no native array for any of the
// four, so each needed a DECLARED representation rather than an inferred one (INV-2).
// The declarations, and what could go silently wrong with each:
//
//   float16     → `Float32Array`, widened. LOSSLESS, so every assertion below is
//                 equality, not a tolerance. Subnormals (no implicit leading 1), ±0
//                 (sign in the sign bit alone) and the ±inf/NaN encoding are what a
//                 plausible-looking wrong widening gets wrong, so they are named.
//   complex*    → `{re, im}`, deinterleaved. Handing back the interleaved buffer would
//                 make every consumer re-derive 2i/2i+1; one that forgets reads the
//                 imaginary part as a real value and nothing errors.
//   r<N>        → `Uint8Array` of the raw stride, verbatim. `r24` on purpose: a
//                 non-power-of-2 stride, so a reader that assumed 1/2/4/8 mis-strides
//                 every element after the first — invisible at any power-of-2 width.
//
// Fixtures are Python-written (`generate_zarr_fixtures.py`), like every other fixture
// here, so the reader has to agree with bytes it did not produce.

describe('TEST-42 · every Zarr v3 core dtype decodes (ITEM-31)', () => {
  it('the 11 previously-supported dtypes still resolve, and the 4 new ones now do', () => {
    const core = [
      'bool', 'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64',
      'float16', 'float32', 'float64', 'complex64', 'complex128', 'r8', 'r24', 'r64',
    ]
    for (const name of core) expect(resolveDataType(name).name).toBe(name)
    // The stored width, which drives the shuffle element size — NOT the JS width.
    expect(resolveDataType('float16').itemSize).toBe(2)
    expect(resolveDataType('complex64').itemSize).toBe(8)
    expect(resolveDataType('complex128').itemSize).toBe(16)
    expect(resolveDataType('r24').itemSize).toBe(3)
    // JS array entries per Zarr element: 2 for complex (re, im), N/8 for r<N>.
    expect(resolveDataType('complex64').valuesPerElement).toBe(2)
    expect(resolveDataType('r24').valuesPerElement).toBe(3)
    expect(resolveDataType('float16').valuesPerElement).toBe(1)
  })

  it('NEGATIVE CONTROL: a genuinely unknown dtype throws naming the known set', () => {
    // The message must be usable by the producer that got it wrong, so it lists what it
    // could have said. A permissive fallback here would decode arbitrary bytes into
    // whichever array happened to be the default — the INV-2 failure this pins.
    expect(() => resolveDataType('decimal128')).toThrow(ZarrFormatError)
    expect(() => resolveDataType('decimal128')).toThrow(/unsupported Zarr data_type "decimal128"/)
    for (const named of ['float16', 'complex64', 'complex128', 'float64', 'r<N>']) {
      expect(() => resolveDataType('decimal128')).toThrow(new RegExp(`known:.*${named.replace(/[<>]/g, '.')}`, 's'))
    }
    // A sub-byte raw width has no byte-addressable element; rounding it up to a byte
    // would mis-stride silently, so it is refused rather than accommodated.
    expect(() => resolveDataType('r7')).toThrow(/positive multiple of 8/)
    expect(() => resolveDataType('r0')).toThrow(/positive multiple of 8/)
    expect(() => resolveDataType('rabc')).toThrow(/unsupported Zarr data_type/)
  })

  it('float16 widens EXACTLY into Float32Array — subnormals, ±0, ±inf and NaN', async () => {
    const exp = expectedFor<{ length: number; values: (number | string)[]; negativeZeroAt: number }>(
      'f16_curated',
    )
    const array = await openZarrArray(store, 'f16_curated')
    expect(array.dtype.name).toBe('float16')
    const values = await array.readAll()
    // The DECLARED representation: not a Float16Array, not a Uint16Array of raw bits.
    expect(values).toBeInstanceOf(Float32Array)
    expect(values.length).toBe(exp.length)
    for (let i = 0; i < exp.length; i++) {
      const want = expectedFloat(exp.values[i])
      if (Number.isNaN(want)) expect(values[i]).toBeNaN()
      else expect(values[i]).toBe(want)
    }
    // -0 must keep its sign: `toBe` is `Object.is`, so this fails if the widening
    // collapsed it to +0 (which `===` would not have caught).
    expect(Object.is(values[exp.negativeZeroAt], -0)).toBe(true)
    expect(Object.is(values[0], 0)).toBe(true)
  })

  it('float16 is exact over EVERY non-NaN bit pattern (63490 of them)', async () => {
    // A crc32c of numpy's own float32 bytes: a complete cross-language oracle in ten
    // bytes of JSON. Sampling would leave whole exponent regimes unchecked, and the two
    // regimes a naive implementation gets wrong — subnormals and the inf encoding — are
    // exactly the sparse ones.
    const exp = expectedFor<{ length: number; float32Crc32c: number }>('f16_sweep')
    const array = await openZarrArray(store, 'f16_sweep')
    const values = (await array.readAll()) as Float32Array
    expect(values.length).toBe(exp.length)
    expect(crc32c(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))).toBe(
      exp.float32Crc32c,
    )
  })

  it('the native Float16Array arm and the scalar fallback agree on all 65536 patterns', async () => {
    // `decodeFloat16` uses ES2025's `Float16Array` where the runtime has it. If the two
    // arms could disagree, the reader would decode differently on different browsers —
    // so they are pinned to each other over the ENTIRE domain, not sampled.
    const bits = new Uint16Array(65536)
    for (let i = 0; i < 65536; i++) bits[i] = i
    const decoded = decodeFloat16(bits.buffer, 0, 65536)
    for (let i = 0; i < 65536; i++) {
      const want = float16ToFloat32(i)
      if (Number.isNaN(want)) expect(decoded[i]).toBeNaN()
      else expect(Object.is(decoded[i], want)).toBe(true)
    }
    // …and the fallback is not vacuously "whatever the native arm did": the curated
    // fixture above is decoded through `decodeFloat16` and matched against numpy, so
    // whichever arm this runtime takes is anchored cross-language too.
    expect(float16ToFloat32(0x0001)).toBe(2 ** -24) // smallest subnormal
    expect(float16ToFloat32(0x7c00)).toBe(Number.POSITIVE_INFINITY)
    expect(float16ToFloat32(0xfc00)).toBe(Number.NEGATIVE_INFINITY)
    expect(float16ToFloat32(0x7e00)).toBeNaN()
    expect(Object.is(float16ToFloat32(0x8000), -0)).toBe(true)
  })

  interface ComplexExpected {
    dtype: string
    itemSize: number
    length: number
    re: (number | string)[]
    im: (number | string)[]
    interleaved: (number | string)[]
  }

  it.each(['c64', 'c128'])('%s stores interleaved and DECODES to {re, im}', async name => {
    const exp = expectedFor<ComplexExpected>(name)
    const array = await openZarrArray(store, name)
    expect(array.dtype.name).toBe(exp.dtype)
    expect(array.dtype.itemSize).toBe(exp.itemSize)
    expect(array.length).toBe(exp.length)

    // The RAW read is the storage view — interleaved, `2n` float entries for `n`
    // elements. Asserted so the deinterleave below is a transformation of known input.
    const raw = await array.readAll()
    expect(raw).toBeInstanceOf(exp.dtype === 'complex64' ? Float32Array : Float64Array)
    expect(raw.length).toBe(exp.length * 2)
    exp.interleaved.forEach((v, i) => expect(raw[i]).toBe(expectedFloat(v)))

    // …and the DECLARED representation is the pair.
    const { re, im } = await readComplex(array)
    expect(re.length).toBe(exp.length)
    expect(im.length).toBe(exp.length)
    exp.re.forEach((v, i) => expect(re[i]).toBe(expectedFloat(v)))
    exp.im.forEach((v, i) => expect(im[i]).toBe(expectedFloat(v)))
    // The pair carries the storage precision — a complex128 must not silently narrow.
    expect(re).toBeInstanceOf(exp.dtype === 'complex64' ? Float32Array : Float64Array)
  })

  it('a complex window reads the right PAIRS, not the right float offsets', async () => {
    // The off-by-one that a correctness test on the whole array cannot see: elements
    // 2..5 are float entries 4..11, so a reader that forgot `valuesPerElement` would
    // return `[re2, im2]`-shifted values that still look like plausible complex numbers.
    const exp = expectedFor<ComplexExpected>('c64')
    const array = await openZarrArray(store, 'c64')
    const { re, im } = await readComplex(array, 2, 5)
    expect(re.length).toBe(3)
    expect(Array.from(re)).toEqual(exp.re.slice(2, 5).map(expectedFloat))
    expect(Array.from(im)).toEqual(exp.im.slice(2, 5).map(expectedFloat))
  })

  it('readComplex refuses a dtype that is not complex', async () => {
    await expect(readComplex(await openZarrArray(store, 'f32_sharded'))).rejects.toThrow(
      /not a complex dtype/,
    )
  })

  it('r24 raw bits decode to the stored bytes verbatim, at a 3-byte stride', async () => {
    const exp = expectedFor<{ stride: number; length: number; bytes: number[] }>('r24')
    const array = await openZarrArray(store, 'r24')
    expect(array.dtype.name).toBe('r24')
    expect(array.length).toBe(exp.length)
    const values = await array.readAll()
    // `r<N>` is N opaque bits — interpreting anything would be inventing meaning.
    expect(values).toBeInstanceOf(Uint8Array)
    expect(values.length).toBe(exp.length * exp.stride)
    expect(nums(values)).toEqual(exp.bytes)

    // A ranged read is in ELEMENTS, so elements [5, 9) are bytes [15, 27).
    const window = await array.read(5, 9)
    expect(nums(window)).toEqual(exp.bytes.slice(5 * 3, 9 * 3))
  })

  it('a complex/raw fill_value is a per-entry PATTERN, not a scalar', async () => {
    // v3 spells a complex fill as `[re, im]` and an `r<N>` fill as one value per raw
    // byte; the fixtures declare exactly that, so opening them at all proves the
    // pattern arm parses. A component-count mismatch is a declaration error.
    const meta = JSON.parse(new TextDecoder().decode(TREE.get('c64/zarr.json')!)) as {
      fill_value: unknown
    }
    expect(meta.fill_value).toEqual([0, 0])
    const bad = memoryStore({
      'zarr.json': new TextEncoder().encode(
        JSON.stringify({
          zarr_format: 3,
          node_type: 'array',
          shape: [4],
          data_type: 'complex64',
          chunk_grid: { name: 'regular', configuration: { chunk_shape: [4] } },
          fill_value: [1, 2, 3],
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        }),
      ),
    })
    await expect(openZarrArray(bad)).rejects.toThrow(/3 components, complex64 needs 2/)
  })

  it('readInto refuses a destination whose element width is not the dtype\'s', async () => {
    // float16 STORES 2 bytes and DECODES into a 4-byte Float32Array slot. Copying at the
    // stored width would interleave halves of adjacent floats into numbers that render
    // as a plot rather than as an error, so the mismatch is refused.
    const array = await openZarrArray(store, 'f16_curated')
    await expect(array.readInto(new Float64Array(array.length), 0, array.length)).rejects.toThrow(
      /byte-per-entry array/,
    )
    // The right way to allocate: from the dtype itself.
    const out = await array.readInto(array.dtype.alloc(array.length), 0, array.length)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(array.length)
  })

  it('readInto sizes a complex destination in JS ENTRIES, not Zarr elements', async () => {
    const array = await openZarrArray(store, 'c64')
    // n elements need 2n float entries; n would silently truncate half the column.
    await expect(array.readInto(new Float32Array(array.length), 0, array.length)).rejects.toThrow(
      /need 14/,
    )
    const out = await array.readInto(array.dtype.alloc(array.length), 0, array.length)
    expect(out.length).toBe(array.length * 2)
  })
})

// ── TEST-44 · windowed string columns (ITEM-32) ──────────────────────────────────
//
// `readSplitStrings` used to `readAll()` both members and materialize a `string[]`:
// measured at 10M × 18 chars, **979 ms and 580 MB of heap** — against **0.08 ms** for the
// 100 rows a table actually shows. The accessor keeps `offsets` + `values` as bytes and
// decodes on demand.
//
// Asserted on the REQUEST LOG, not on wall-clock: a timing assertion passes on a fast
// machine whatever the reader fetches, which is precisely the regression this is for.

describe('TEST-44 · a windowed string read decodes only the covering chunks (ITEM-32)', () => {
  interface Large {
    n: number
    bytesPerValue: number
    offsetsInnerChunk: number
    valuesInnerChunk: number
    chunksPerShard: number
    window_5000_5100: string[]
    at_7777: string
    first: string
    last: string
  }
  const large = () => expectedFor<Large>('str_large')

  it('the accessor knows its length before fetching any data', async () => {
    const { store: counted, stats } = countingStore(store)
    const column = await openSplitStringColumn(counted, 'str_large/col')
    const afterOpen = stats.requests
    expect(column.length).toBe(large().n)
    // `length` is a DECLARATION (the group's `n` / the offsets member's shape), so
    // reading it costs nothing beyond the metadata the open already fetched.
    expect(stats.requests).toBe(afterOpen)
    // …and the metadata alone is far below the column's stored size.
    expect(stats.bytes).toBeLessThan(4096)
  })

  it('.slice(5000, 5100) requests ONLY the chunks covering that window', async () => {
    const exp = large()
    const { store: counted, stats } = countingStore(store)
    const column = await openSplitStringColumn(counted, 'str_large/col')
    stats.reset()

    const window = await column.slice(5000, 5100)
    expect(window).toEqual(exp.window_5000_5100)

    // ── the request log ────────────────────────────────────────────────────────────
    // offsets: values 5000..5100 need offsets [5000, 5101) — inner chunk 9 of 17, ONE
    // chunk. values: 100 × 9 bytes starting at byte 45000 — payload chunks 10 and 11 of
    // 18. Each member costs ONE suffix read for its shard index (fixed size, cached for
    // the array's life) plus one range per covering chunk. Nothing else is touched.
    const offsetCalls = stats.under('str_large/col/offsets')
    const valueCalls = stats.under('str_large/col/values')
    expect(offsetCalls.filter(c => c.method === 'getSuffix')).toHaveLength(1)
    expect(offsetCalls.filter(c => c.method === 'getRange')).toHaveLength(1)
    // ONE index request for the two payload chunks, not one per chunk: the prefetch
    // window schedules them concurrently, so an index cache keyed only on the RESOLVED
    // value duplicates the request. Both chunks live in the same shard here, which is
    // exactly the case that exposes it.
    expect(valueCalls.filter(c => c.method === 'getSuffix')).toHaveLength(1)
    expect(valueCalls.filter(c => c.method === 'getRange')).toHaveLength(2)
    // No whole-member fetch: `get` is the un-ranged read, and a window must never use it.
    expect(stats.calls.filter(c => c.method === 'get')).toHaveLength(0)
    expect(stats.calls).toHaveLength(5)

    // 3 of the column's 35 stored inner chunks. The window is 1.2% of the VALUES but
    // ~10% of the bytes, because an inner chunk is the granularity floor — on the 10M
    // column the 979 ms / 580 MB measurement came from, the same 100-row window is four
    // orders of magnitude smaller than the column.
    expect(stats.bytes / storedBytesOf('str_large/col')).toBeLessThan(0.15)
  })

  it('.at(i) fetches one string, not the column', async () => {
    const exp = large()
    const { store: counted, stats } = countingStore(store)
    const column = await openSplitStringColumn(counted, 'str_large/col')
    stats.reset()
    expect(await column.at(7777)).toBe(exp.at_7777)
    // One offsets chunk + one payload chunk, plus each member's index.
    expect(stats.calls.filter(c => c.method === 'getRange')).toHaveLength(2)
    expect(stats.calls.filter(c => c.method === 'get')).toHaveLength(0)

    // A second value in the SAME chunks is free — the artifact is immutable, so the
    // decoded-chunk cache can never be stale.
    const before = stats.requests
    expect(await column.at(7778)).toBe(`id-${(7778).toString().padStart(6, '0')}`)
    expect(stats.requests).toBe(before)
  })

  it('the EAGER path is strictly more expensive — which is why it is spelled out', async () => {
    // The comparison that makes the claim non-vacuous: same column, same store, the two
    // paths side by side. `readAll()` is not forbidden — a table export needs it — it
    // just must not be what a caller gets by default.
    const windowed = countingStore(store)
    const wCol = await openSplitStringColumn(windowed.store, 'str_large/col')
    windowed.stats.reset()
    await wCol.slice(5000, 5100)

    const eager = countingStore(store)
    const eCol = await openSplitStringColumn(eager.store, 'str_large/col')
    eager.stats.reset()
    const all = await eCol.readAll()

    expect(all).toHaveLength(large().n)
    expect(all[0]).toBe(large().first)
    expect(all[large().n - 1]).toBe(large().last)
    expect(all.slice(5000, 5100)).toEqual(large().window_5000_5100)

    // The eager path fetches the column — EVERY stored byte of both members, exactly.
    const stored = storedBytesOf('str_large/col')
    expect(eager.stats.bytes).toBe(stored)
    // …and it does so in one request per shard, which is ITEM-33 doing its job on the
    // path ITEM-32 says not to take by default. The two items are independent: whole
    // shards make the eager read cheap in REQUESTS, windowing makes it unnecessary.
    expect(eager.stats.calls.every(c => c.method === 'get')).toBe(true)
    expect(windowed.stats.bytes).toBeLessThan(stored * 0.15)
  })

  it('the accessor holds no bytes of its own — it reads through the chunk LRU', async () => {
    // The lifecycle risk of a lazy handle: if it cached decoded windows itself, a
    // long-lived accessor would grow without bound outside the byte-budgeted LRU that
    // every other read respects. With the cache DISABLED the accessor still works and
    // re-fetches, which is only possible if it is holding handles, not bytes.
    const { store: counted, stats } = countingStore(store)
    const column = await openSplitStringColumn(counted, 'str_large/col', { chunkCacheBytes: 0 })
    stats.reset()
    expect(await column.at(7777)).toBe(large().at_7777)
    const first = stats.requests
    expect(await column.at(7777)).toBe(large().at_7777)
    expect(stats.requests).toBeGreaterThan(first)
  })

  it('window edges: empty, out-of-range and reversed', async () => {
    const exp = large()
    const column = await openSplitStringColumn(store, 'str_large/col')
    expect(await column.slice(10, 10)).toEqual([])
    expect(await column.slice(20, 10)).toEqual([])
    expect(await column.slice(exp.n - 2, exp.n + 50)).toEqual([
      `id-${(exp.n - 2).toString().padStart(6, '0')}`,
      exp.last,
    ])
    expect(await column.slice(-5, 2)).toEqual([exp.first, 'id-000001'])
    await expect(column.at(exp.n)).rejects.toThrow(/outside/)
  })

  it('the eager wrapper still returns exactly what it used to', async () => {
    // `readSplitStrings` is now `readAll()` on the accessor. The wire result must be
    // unchanged — the awkward-string table column is the proof.
    const table = expectedFor<{ str: { values: string[] } }>('table').str
    expect(await readSplitStrings(store, 'table/str')).toEqual(table.values)
  })

  it('a declared count that contradicts the offsets member is an error', async () => {
    // Two sources for one value is the ambiguity INV-2 forbids; taking one silently
    // would decode a window at indices that no longer line up with the column.
    await expect(openSplitStringColumn(store, 'table/str', { count: 499 })).rejects.toThrow(
      /declared n=499/,
    )
  })
})

// ── TEST-45 · whole-shard fetching (ITEM-33) ─────────────────────────────────────
//
// A full read used to issue one range request per INNER CHUNK plus one index request per
// shard — 2,749 requests for a 10M column, WORSE than the 2,441 of not sharding at all,
// which inverts the entire purpose of the `sharding_indexed` codec.
//
// Every value comes back correctly either way, so a correctness test is structurally
// blind to this: only a REQUEST-COUNT assertion can see it.

describe('TEST-45 · a full read fetches whole shards, not inner chunks (ITEM-33)', () => {
  it('one request per shard, and NO separate index request', async () => {
    const exp = expectedFor<{ length: number; innerChunk: number; chunksPerShard: number }>(
      'f32_sharded',
    )
    const { store: counted, stats } = countingStore(store)
    const array = await openZarrArray(counted, 'f32_sharded')
    stats.reset()

    const values = await array.readAll()

    const chunks = Math.ceil(exp.length / exp.innerChunk) // 18
    const shards = Math.ceil(chunks / exp.chunksPerShard) // 3
    expect(chunks).toBeGreaterThan(shards) // or the assertion below is vacuous
    // BEFORE: 18 range requests + 3 suffix index requests = 21.
    // AFTER: 3 whole-shard GETs; the index trailer is inside those same bytes.
    expect(stats.requests).toBe(shards)
    expect(stats.calls.every(c => c.method === 'get')).toBe(true)
    expect(stats.calls.filter(c => c.method === 'getSuffix')).toHaveLength(0)
    expect(stats.calls.filter(c => c.method === 'getRange')).toHaveLength(0)
    expect(stats.paths).toEqual(['f32_sharded/c/0', 'f32_sharded/c/1', 'f32_sharded/c/2'])

    // …and the values are still right, against a control that took the OTHER path.
    // Reading one inner chunk at a time never covers a whole shard, so the reference is
    // assembled by the range-plus-index path this test just proved was not used — which
    // is what makes the equality a cross-check rather than a tautology.
    const perChunk = countingStore(store)
    const control = await openZarrArray(perChunk.store, 'f32_sharded', { chunkCacheBytes: 0 })
    perChunk.stats.reset()
    const reference: number[] = []
    for (let g = 0; g < chunks; g++) {
      const from = g * exp.innerChunk
      reference.push(...nums(await control.read(from, Math.min(from + exp.innerChunk, exp.length))))
    }
    expect(perChunk.stats.calls.filter(c => c.method === 'get')).toHaveLength(0)
    expect(perChunk.stats.calls.filter(c => c.method === 'getRange')).toHaveLength(chunks)
    expect(nums(values)).toEqual(reference)
  })

  it('a PARTIAL read still range-reads — a window must not drag its shard along', async () => {
    // The inverse error: fetching a whole 512-element shard to serve 8 elements would be
    // a regression in the other direction. The decision is per-READ, not per-array.
    const { store: counted, stats } = countingStore(store)
    const array = await openZarrArray(counted, 'f32_sharded')
    stats.reset()
    await array.read(508, 516) // straddles the shard-0/shard-1 boundary
    expect(stats.calls.filter(c => c.method === 'get')).toHaveLength(0)
    expect(stats.calls.filter(c => c.method === 'getSuffix')).toHaveLength(2) // two indices
    expect(stats.calls.filter(c => c.method === 'getRange')).toHaveLength(2) // two chunks
  })

  it('the TAIL shard counts as whole even though it is short', async () => {
    // Shard 2 nominally holds 8 inner chunks and really holds 2 (1100 elements, 64 per
    // chunk). A reader comparing against the NOMINAL count would never take the
    // whole-shard path on the last shard of any array whose length is not a multiple of
    // the shard size — i.e. almost every array.
    const { store: counted, stats } = countingStore(store)
    const array = await openZarrArray(counted, 'f32_sharded')
    stats.reset()
    await array.read(1024, 1100) // exactly shard 2
    expect(stats.paths).toEqual(['f32_sharded/c/2'])
    expect(stats.calls[0].method).toBe('get')
  })

  it('progressive delivery survives: chunks still arrive one INNER chunk at a time', async () => {
    // The regression whole-shard fetching risks. One request now carries 8 inner chunks,
    // but the consumer must still see 8 slices, in order, each before the read resolves —
    // otherwise a large view goes from "paints in stages" to "blank, then everything".
    const exp = expectedFor<{ length: number; innerChunk: number; at: Record<string, number> }>(
      'f32_sharded',
    )
    const array = await openZarrArray(store, 'f32_sharded')
    const total = Math.ceil(exp.length / exp.innerChunk)
    const seen: ZarrChunkSlice[] = []
    let resolved = false
    const out = await array.readInto(array.dtype.alloc(array.length), 0, array.length, s => {
      if (resolved) throw new Error('a chunk arrived AFTER the read resolved')
      seen.push(s)
    })
    resolved = true
    expect(seen).toHaveLength(total)
    expect(seen.map(s => s.index)).toEqual([...Array(total).keys()])
    expect(seen.every(s => s.total === total)).toBe(true)
    let cursor = 0
    for (const s of seen) {
      expect(s.offset).toBe(cursor)
      cursor += s.values.length
    }
    expect(cursor).toBe(exp.length)
    for (const [i, v] of Object.entries(exp.at)) expect(out[Number(i)]).toBe(v)
  })

  it('an absent shard file reads as fill_value on the whole-shard path too', async () => {
    // The windowed path absorbs a 404 as "never written". The whole-shard path is a
    // second transport call site, so it needs the same rule or a sparse artifact reads
    // fine windowed and throws when read whole.
    const withoutShard = new Map(TREE)
    withoutShard.delete('f32_sharded/c/1')
    const array = await openZarrArray(memoryStore(withoutShard), 'f32_sharded')
    const values = await array.readAll()
    expect(nums(values.subarray(512, 1024) as ZarrTypedArray)).toEqual(new Array(512).fill(0))
    const exp = expectedFor<{ at: Record<string, number> }>('f32_sharded')
    expect(values[0]).toBe(exp.at['0'])
    expect(values[1099]).toBe(exp.at['1099'])
  })

  it('a corrupt index inside a whole shard is still caught', async () => {
    // The index moved from its own request into the shard body; the crc32c check has to
    // move with it, or corruption that the windowed path rejects decodes as garbage here.
    const corrupted = new Map(TREE)
    const shard = new Uint8Array(TREE.get('f32_sharded/c/0')!)
    shard[shard.length - 8] ^= 0x01
    corrupted.set('f32_sharded/c/0', shard)
    const array = await openZarrArray(memoryStore(corrupted), 'f32_sharded')
    await expect(array.readAll()).rejects.toThrow(/crc32c mismatch/)
  })

  it('an UNSHARDED array is unaffected — one file per chunk is already one request', async () => {
    const exp = expectedFor<{ length: number; values: number[] }>('i32_plain')
    const { store: counted, stats } = countingStore(store)
    const array = await openZarrArray(counted, 'i32_plain')
    stats.reset()
    expect(nums(await array.readAll())).toEqual(exp.values)
    // 70 elements, 32 per chunk → 3 chunk files, each a whole-member GET.
    expect(stats.calls.map(c => c.method)).toEqual(['get', 'get', 'get'])
  })

  it('a whole-shard read leaves the index cached for a later windowed read', async () => {
    // The index arrived free inside the shard bytes, so a subsequent window into the same
    // shard must not pay a suffix request for it.
    const { store: counted, stats } = countingStore(store)
    const array = await openZarrArray(counted, 'f32_sharded', { chunkCacheBytes: 0 })
    stats.reset()
    await array.readAll()
    stats.reset()
    await array.read(70, 80) // one chunk of shard 0, cache disabled ⇒ a real fetch
    expect(stats.calls.filter(c => c.method === 'getSuffix')).toHaveLength(0)
    expect(stats.calls.filter(c => c.method === 'getRange')).toHaveLength(1)
  })
})

// ── TEST-21 / TEST-22 [ITEM-18, ITEM-23] — the shard body arrives PROGRESSIVELY ────────
//
// The defect this fixes is invisible to every test that existed. `#wantsWholeShard` is
// true for any read covering a whole shard — which a full positions read always is — and
// that path fetched the shard un-ranged and sliced the index out of the SAME bytes. The
// index is a FOOTER, so inner chunk 0 could not be LOCATED until the last byte of the
// shard had arrived. Streaming the body was therefore worth exactly nothing on the one
// path that matters, and no assertion in the tree could tell.
//
// `zarrReader.test.ts`'s existing "progressive delivery survives" test asserts callback
// ORDER, which stays green when every byte arrives in one blocking gulp — it would have
// passed throughout the defect. Order is not arrival. What is needed is a store that
// resolves bytes INCREMENTALLY, which nothing in the tree did before this.
function incrementalStore(inner: ZarrStore): {
  store: ZarrStore
  /** Release the next queued body chunk; resolves once the reader has consumed it. */
  release(): Promise<void>
  /** Every request, so the request-count guard can be asserted on the same run. */
  calls: Array<{ path: string; range: string | null }>
  pending(): number
} {
  const calls: Array<{ path: string; range: string | null }> = []
  const gates: Array<() => void> = []
  const store: ZarrStore = {
    async get(path) {
      calls.push({ path, range: null })
      return inner.get(path)
    },
    async getRange(path, start, length) {
      calls.push({ path, range: `${start}-${start + length - 1}` })
      return inner.getRange(path, start, length)
    },
    async getSuffix(path, length) {
      calls.push({ path, range: `-${length}` })
      return inner.getSuffix(path, length)
    },
    // The body, handed over in TWO pieces with a gate between them. The first piece is a
    // genuine PREFIX of the shard — the second byte half is still unsent when the first
    // inner chunk must decode.
    async getStream(path, range) {
      calls.push({ path, range: range ? `${range.start}-${range.start + range.length - 1}` : null })
      const whole = await inner.get(path)
      if (!whole) return null
      const cut = Math.floor(whole.length / 2)
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(whole.subarray(0, cut))
          await new Promise<void>(resolve => gates.push(resolve))
          controller.enqueue(whole.subarray(cut))
          controller.close()
        },
      })
    },
  }
  return {
    store,
    calls,
    pending: () => gates.length,
    async release() {
      const open = gates.shift()
      if (open) open()
      // Let the pump copy the released bytes and wake its waiters.
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

describe('TEST-21/22 · a whole-shard read is PROGRESSIVE, and still costs one body + one index', () => {
  it('TEST-21: inner chunk 0 decodes from a PREFIX — before the last byte arrives', async () => {
    const inc = incrementalStore(store)
    const array = await openZarrArray(inc.store, 'f32_sharded')
    const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

    const seen: number[] = []
    let finished = false
    const drain = (async () => {
      for await (const chunk of array.chunks()) seen.push(chunk.index)
    })().then(() => {
      finished = true
    })

    // The body's FIRST half is enqueued immediately; the second half sits behind the gate
    // and is NOT released here. So everything below happens while the shard is genuinely
    // INCOMPLETE — which is the entire claim. (Releasing first would complete the body and
    // the assertion would prove nothing, which is how this test failed on its first
    // draft: it asserted after the release and therefore measured the buffered path.)
    for (let i = 0; i < 50 && seen.length === 0; i++) await tick()
    expect(
      inc.pending(),
      'the gate must still be CLOSED — otherwise the body completed and the assertion ' +
        'below would hold on the buffered path too',
    ).toBeGreaterThan(0)

    expect(
      seen.length,
      'inner chunk 0 must decode from a PREFIX of the shard. ZERO here is the defect ' +
        'this item fixes: on the footer-index whole-shard path nothing can be located ' +
        'until the last byte arrives, so that path cannot satisfy this assertion.',
    ).toBeGreaterThan(0)
    expect(seen[0]).toBe(0)

    // Drain the rest. Bounded, so a stall fails as a clear assertion rather than a
    // five-second timeout with nothing to read.
    for (let i = 0; i < 200 && !finished; i++) {
      await inc.release()
      await tick()
    }
    await drain
    expect(finished, 'the read completed').toBe(true)

    // Progressiveness must not have cost correctness: every chunk, in order, and the
    // values identical to the buffered read of the same fixture.
    expect(seen.length, 'every chunk is delivered').toBeGreaterThan(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    const viaStream = nums(await array.readAll())
    const buffered = nums(await openZarrArray(store, 'f32_sharded').then(a => a.readAll()))
    expect(viaStream).toEqual(buffered)
  })

  it('TEST-22: one body + one suffix index per shard, and ZERO per-chunk ranges', async () => {
    // The restated request-count guard. ITEM-18 buys progressiveness with ONE extra small
    // request per shard; it must not buy it with a range per inner chunk, which is the
    // 2,749→1 win ITEM-33 paid for and the thing that is explicitly not currency.
    const inc = incrementalStore(store)
    const array = await openZarrArray(inc.store, 'f32_sharded')
    const drain = (async () => {
      for await (const _ of array.chunks()) void _
    })()
    for (let i = 0; i < 20 && inc.pending() >= 0; i++) {
      await inc.release()
      if (inc.pending() === 0) await new Promise(resolve => setTimeout(resolve, 0))
      if (inc.pending() === 0) break
    }
    await drain

    const shardCalls = inc.calls.filter(c => c.path.startsWith('f32_sharded/c/'))
    const bodies = shardCalls.filter(c => c.range === null)
    const suffixes = shardCalls.filter(c => c.range?.startsWith('-'))
    const windows = shardCalls.filter(c => c.range !== null && !c.range.startsWith('-'))

    expect(windows.map(c => c.range), 'ZERO per-chunk window ranges').toEqual([])
    expect(bodies.length, 'one un-ranged body per shard').toBeGreaterThan(0)
    expect(suffixes.length, 'one suffix index read per shard').toBe(bodies.length)
    // Per shard PATH, exactly one of each — never two, which would mean a cache broke.
    for (const path of new Set(shardCalls.map(c => c.path))) {
      expect(bodies.filter(c => c.path === path)).toHaveLength(1)
      expect(suffixes.filter(c => c.path === path)).toHaveLength(1)
    }
  })
})

// ── F5 — the streaming shard buffer is PRE-SIZED from the index it already holds ────────────────
//
// WHAT THIS DOES WHEN THE DEFECT IS PRESENT: the streaming path grew one buffer from 64 KiB by
// DOUBLING — up to 2× over-allocated at rest and ~3× transiently during the final copy — where the
// buffered path it replaced allocated exactly `Content-Length` once. The shard index is already in
// hand and accounts for every present chunk, so `max(offset + nbytes)` is a sound size hint.
//
// WHAT THIS DOES NOT PIN, stated rather than implied: an allocation is not observable from outside,
// so this pins the HINT — the number the buffer is sized from — and not the sizing itself. The
// existing streaming-shard read tests are what keep the wiring honest (the growth path is retained
// precisely so a wrong hint cannot corrupt a read, only cost an extra copy).
describe('indexedBodyBytes (F5) — the size hint taken from a shard index', () => {
  const EMPTY = 0xffffffffffffffffn

  it('is the far end of the last present chunk', () => {
    // (offset, nbytes) pairs, deliberately NOT in ascending order — the hint is a maximum over the
    // index, not "the last pair", and an index need not be sorted.
    expect(indexedBodyBytes(new BigUint64Array([100n, 50n, 0n, 100n, 300n, 7n]))).toBe(307)
  })

  it('skips EMPTY chunks rather than counting the sentinel as an offset', () => {
    // The sentinel is 2^64-1. Counting it would ask for an 18-exabyte buffer, i.e. throw.
    expect(indexedBodyBytes(new BigUint64Array([EMPTY, EMPTY, 0n, 64n]))).toBe(64)
  })

  it('answers 0 — the caller keeps its default — for an index that accounts for nothing', () => {
    expect(indexedBodyBytes(new BigUint64Array([]))).toBe(0)
    expect(indexedBodyBytes(new BigUint64Array([EMPTY, EMPTY]))).toBe(0)
  })

  it('refuses a size that is not a safe integer instead of coercing it', () => {
    // A bogus/hostile index must not turn into a huge allocation; the read still works because
    // the buffer grows on arrival regardless of the hint.
    expect(indexedBodyBytes(new BigUint64Array([0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]))).toBe(0)
  })
})
