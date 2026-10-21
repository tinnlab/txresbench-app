// vizData.ts — the FRIENDLY `data` union + its normalizer (STREAMING_PROGRESSIVE_PLAN Wave 2a,
// "no-boilerplate API"). The whole product requirement: an app hands a STREAM, a URL, or a plain
// array straight to `<Viz data={…} />` and the viz owns EVERYTHING (fetch, reframe, bin,
// progressive emit, progress, cancellation). `normalizeVizData` is the seam that erases the
// difference between those inputs: it turns ANY of them into ONE uniform batch stream
// `AsyncIterable<{ offset, positions }>` — a `Float32Array` yields a single instant batch, a
// `ReadableStream`/`AsyncIterable`/URL yields many — so the raster path downstream is written once
// and both behave identically, differing only in WHEN bytes arrive.
//
// PURE + framework-free (no deck.gl / React / DOM) → node-testable by feeding a synthetic
// `ReadableStream` / `AsyncIterable` / mocked `fetch`. It reuses `fetchStream.ts` for the
// row-reframing + fetch wrapper (never re-implements the carry-buffer).
//
// ── CONTRACTS ─────────────────────────────────────────────────────────────────
// • `offset` is in POINTS (one interleaved xy pair). With `bytesPerRow === stride`, one reframed
//   "row" IS one point, so the reframer's row offset equals the point offset directly.
// • LITTLE-ENDIAN wire (inherited from `fetchStream` — every browser/node target is LE).
// • `stride` defaults to 8 (2×Float32 xy); `packed:true` defaults it to 4 (2×Uint16 codes).
// • PACKED positions are streamed as raw `Uint16` codes and decoded IDENTITY (code value → world
//   coord, i.e. a self-consistent binning domain over `[0, 65535]`). A raw stream carries no
//   per-axis origin/scale `PackMeta`, so there is nothing to affine-map to; density binning is
//   translation/scale-agnostic, so identity code-space bins correctly. Callers needing TRUE world
//   units should stream unpacked `Float32` (or use the existing `packed`+meta prop on the view).

import {
  streamBinaryColumn,
  reframeBytes,
  asFloat32,
  asUint16,
  type ReframedBatch,
  type StreamTotal,
} from '../viz-core/data/fetchStream'

/** Where the positions come FROM — the flexible per-source union nested under the object form. */
export type PositionsInput =
  | Float32Array
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | { readonly url: string }
  | { readonly stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> }

/** Where a SCALAR channel (label codes / continuous values) comes FROM — mirrors
 *  {@link PositionsInput}, but a bare typed array is `Uint16Array` (label codes) OR `Float32Array`
 *  (values). Byte streams / URLs carry the raw column (2 B/elem codes, 4 B/elem values). */
export type ChannelInput =
  | Uint16Array
  | Float32Array
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | { readonly url: string }
  | { readonly stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> }

/** The friendly `<Viz data>` union: a bare source, or the object form carrying stride/packed/total. */
export type VizData =
  | Float32Array
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | {
      readonly positions: PositionsInput
      /** bytes per point (default 8 = 2×Float32; 4 when `packed`). */
      readonly stride?: number
      /** the source carries 16-bit `Uint16` codes (identity-decoded — see the header contract). */
      readonly packed?: boolean
      /** total point count when known up front (drives `coveragePct`), else derived from
       *  `Content-Length` (URL) or left unknown (chunked/iterable). */
      readonly total?: number
      /** OPTIONAL label-code channel (categorical coloring), aligned 1:1 with `positions` by offset. */
      readonly labels?: ChannelInput
      /** OPTIONAL continuous-value channel (value coloring), aligned 1:1 with `positions` by offset. */
      readonly value?: ChannelInput
    }

/** A normalized batch: `positions` = interleaved xy `Float32Array` (length rows*2), `offset` in POINTS.
 *  `labels`/`value` (when present) are the per-point channel columns for the SAME rows (length rows). */
export interface NormalizedBatch {
  readonly offset: number
  readonly positions: Float32Array
  /** label codes for this batch's points (`Uint16Array`, length rows) — present iff a labels channel. */
  readonly labels?: Uint16Array
  /** continuous values for this batch's points (`Float32Array`, length rows) — present iff a value channel. */
  readonly value?: Float32Array
}

/** Options for {@link normalizeVizData}. */
export interface NormalizeOptions {
  /** Abort the fetch / stop iteration (the viz bumps this on data-change / unmount). */
  readonly signal?: AbortSignal
  /** Called ONCE with the total POINT count when it becomes known (object `total`, or a URL's
   *  `Content-Length`-derived rows), or `null` when the source cannot report a total. */
  readonly onTotal?: (totalPoints: number | null) => void
  /**
   * The transport a URL source is read with. OPTIONAL in the type because the array / stream /
   * iterable forms need no transport at all — but **REQUIRED whenever any part of `data` is a URL**
   * (`'…'`, `{ url }`, or a `labels`/`value` channel URL), and its absence THROWS there rather than
   * falling back to the ambient global `fetch` (ITEM-16 / DEC-15 (a)).
   *
   * This is the accepted public-API break: `<Viz data={url}>` without a transport used to issue an
   * unauthenticated request that could only 401; it now fails immediately, naming the fix.
   */
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_STRIDE = 8
const PACKED_STRIDE = 4

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return typeof (x as { getReader?: unknown } | null)?.getReader === 'function'
}

function isAsyncIterable(x: unknown): x is AsyncIterable<Uint8Array> {
  return typeof (x as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === 'function'
}

/** Adapt a `ReadableStream<Uint8Array>` to an `AsyncIterable` (reader-based; releases the lock on
 *  early break / abort so a cancelled stream never leaks its reader). */
function streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader()
      try {
        for (;;) {
          if (signal?.aborted) throw abortError()
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) yield value
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // already released / errored — nothing to do.
        }
      }
    },
  }
}

/** A reframed byte batch → a `Float32Array` of interleaved xy positions (identity-decode packed). */
function batchToPositions(batch: ReframedBatch, packed: boolean): Float32Array {
  if (packed) return Float32Array.from(asUint16(batch)) // codes → world coords (identity code-space)
  return asFloat32(batch)
}

/**
 * ITEM-16 / DEC-15 (a) — a URL source must NAME its transport. `streamBinaryColumn` no longer falls
 * back to the ambient global `fetch`, so this is where that requirement surfaces to a `<Viz data>`
 * caller: loudly, at the moment the URL is about to be read, naming the channel and the fix —
 * instead of an unauthenticated request that can only come back 401.
 */
function requireTransport(
  fetchImpl: typeof fetch | undefined,
  channel: 'positions' | 'labels' | 'value',
  url: string,
): typeof fetch {
  if (typeof fetchImpl === 'function') return fetchImpl
  throw new Error(
    `normalizeVizData: the ${channel} source is a URL (${url}) but no \`fetchImpl\` was supplied. ` +
      'Pass the transport that carries auth — there is no ambient-`fetch` fallback (ITEM-16).',
  )
}

interface StreamCfg {
  readonly stride: number
  readonly packed: boolean
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
  readonly onTotal?: (totalPoints: number | null) => void
}

/** Turn ONE `PositionsInput` into the uniform normalized-batch stream (the per-source dispatch). */
async function* streamPositions(input: PositionsInput, cfg: StreamCfg): AsyncIterable<NormalizedBatch> {
  const { stride, packed, signal, fetchImpl, onTotal } = cfg

  // Bare in-memory array → ONE batch at offset 0 (renders instantly; identical downstream shape).
  if (input instanceof Float32Array) {
    onTotal?.(input.length >> 1)
    yield { offset: 0, positions: input }
    return
  }

  // URL (string or `{ url }`) → the fetch/reframe front-end; `Content-Length` rows surface as total.
  const url = typeof input === 'string' ? input : 'url' in input ? input.url : null
  if (url != null) {
    const wrapTotal = onTotal ? (t: StreamTotal) => onTotal(t.totalRows) : undefined
    for await (const batch of streamBinaryColumn(url, {
      bytesPerRow: stride,
      signal,
      fetchImpl: requireTransport(fetchImpl, 'positions', url),
      onTotal: wrapTotal,
    })) {
      yield { offset: batch.offset, positions: batchToPositions(batch, packed) }
    }
    return
  }

  // A raw byte source (`ReadableStream` / `AsyncIterable` / `{ stream }`) → reframe to whole rows.
  const rawStream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> = isReadableStream(input)
    ? input
    : isAsyncIterable(input)
      ? input
      : typeof input === 'object' && input != null && 'stream' in input
        ? input.stream
        : (() => {
            throw new Error(
              'normalizeVizData: unsupported positions source (not a stream/iterable/url/array)',
            )
          })()
  const chunks: AsyncIterable<Uint8Array> = isReadableStream(rawStream)
    ? streamToAsyncIterable(rawStream, signal)
    : rawStream
  // No usable total for a chunked/iterable source (unless the object form supplied one upstream).
  onTotal?.(null)
  for await (const batch of reframeBytes(chunks, { bytesPerRow: stride })) {
    yield { offset: batch.offset, positions: batchToPositions(batch, packed) }
  }
}

// ── Multi-channel (labels / value) — aligned by the SAME offset (item 5/14) ──────────────────────
// Each scalar channel is its OWN column (2 B/elem label codes, 4 B/elem values). A `ChannelPuller`
// buffers a channel's reframed elements and hands out EXACTLY the row count of each positions batch,
// so `labels`/`value` are aligned 1:1 with `positions` by construction (sequential consumption), no
// matter how the underlying columns chunk. This is the client-side lockstep the plan's "batch k of
// every column covers the same [offset,offset+len) rows" requires without a shared batching size.

interface ChannelStreamCfg {
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** Turn ONE {@link ChannelInput} into a stream of typed-array element batches (`u16` codes / `f32`
 *  values). A bare typed array is one instant batch; a URL/stream is reframed at `elemBytes`/elem. */
async function* streamChannelColumn(
  input: ChannelInput,
  kind: 'u16' | 'f32',
  cfg: ChannelStreamCfg,
): AsyncIterable<Uint16Array | Float32Array> {
  const elemBytes = kind === 'u16' ? 2 : 4

  if (input instanceof Uint16Array || input instanceof Float32Array) {
    yield input
    return
  }

  const url = typeof input === 'string' ? input : 'url' in input ? input.url : null
  if (url != null) {
    for await (const batch of streamBinaryColumn(url, {
      bytesPerRow: elemBytes,
      signal: cfg.signal,
      fetchImpl: requireTransport(cfg.fetchImpl, kind === 'u16' ? 'labels' : 'value', url),
    })) {
      yield kind === 'u16' ? asUint16(batch) : asFloat32(batch)
    }
    return
  }

  const rawStream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> = isReadableStream(input)
    ? input
    : isAsyncIterable(input)
      ? input
      : typeof input === 'object' && input != null && 'stream' in input
        ? input.stream
        : (() => {
            throw new Error(
              'normalizeVizData: unsupported channel source (not a typed array/stream/iterable/url)',
            )
          })()
  const chunks: AsyncIterable<Uint8Array> = isReadableStream(rawStream)
    ? streamToAsyncIterable(rawStream, cfg.signal)
    : rawStream
  for await (const batch of reframeBytes(chunks, { bytesPerRow: elemBytes })) {
    yield kind === 'u16' ? asUint16(batch) : asFloat32(batch)
  }
}

/** Buffers a channel's element batches and yields EXACTLY `count` elements per `pull` (aligning the
 *  channel to a positions batch's row count). Returns a shorter array only if the channel runs dry. */
class ChannelPuller<T extends Uint16Array | Float32Array> {
  private readonly iter: AsyncIterator<Uint16Array | Float32Array>
  private buf: T[] = []
  private bufLen = 0
  private exhausted = false
  constructor(
    src: AsyncIterable<Uint16Array | Float32Array>,
    private readonly make: (n: number) => T,
  ) {
    this.iter = src[Symbol.asyncIterator]()
  }

  async pull(count: number): Promise<T> {
    while (this.bufLen < count && !this.exhausted) {
      const { done, value } = await this.iter.next()
      if (done) {
        this.exhausted = true
        break
      }
      if (value && value.length > 0) {
        this.buf.push(value as T)
        this.bufLen += value.length
      }
    }
    const take = Math.min(count, this.bufLen)
    const out = this.make(take)
    let filled = 0
    while (filled < take && this.buf.length > 0) {
      const head = this.buf[0]
      const need = take - filled
      if (head.length <= need) {
        out.set(head, filled)
        filled += head.length
        this.bufLen -= head.length
        this.buf.shift()
      } else {
        out.set(head.subarray(0, need) as T, filled)
        this.buf[0] = head.subarray(need) as T
        this.bufLen -= need
        filled += need
      }
    }
    return out
  }
}

/** A single channel column normalized to offset-tagged element batches (offset in ELEMENTS/points). */
export interface NormalizedChannelBatch {
  readonly offset: number
  readonly data: Uint16Array | Float32Array
}

/**
 * Normalize ONE {@link ChannelInput} (a label-code `u16` column or a value `f32` column) into
 * offset-tagged element batches — the matrix "bind-a-column" source (item 14): the view fetches ONE
 * value column on demand and re-accumulates it over the resident positions, never the whole matrix.
 */
export async function* normalizeChannelColumn(
  input: ChannelInput,
  kind: 'u16' | 'f32',
  opts: ChannelStreamCfg = {},
): AsyncIterable<NormalizedChannelBatch> {
  let offset = 0
  for await (const data of streamChannelColumn(input, kind, opts)) {
    yield { offset, data }
    offset += data.length
  }
}

/**
 * Normalize ANY {@link VizData} into a uniform `AsyncIterable<{ offset, positions }>` — the single
 * seam that makes a `Float32Array`, a `ReadableStream`, an `AsyncIterable<Uint8Array>`, and a URL
 * behave IDENTICALLY downstream (a plain array = one instant batch; a stream = many). The raster
 * path consumes this and never sees the source kind.
 *
 * `offset` accumulates in POINTS. `opts.onTotal` fires once with the total point count when known.
 */
export async function* normalizeVizData(
  data: VizData,
  opts: NormalizeOptions = {},
): AsyncIterable<NormalizedBatch> {
  const { signal, onTotal, fetchImpl } = opts

  // Object form: explicit stride / packed / total wrapping an inner PositionsInput.
  if (
    data != null &&
    typeof data === 'object' &&
    !(data instanceof Float32Array) &&
    !isReadableStream(data) &&
    !isAsyncIterable(data) &&
    'positions' in data
  ) {
    const { positions, stride, packed, total, labels, value } = data
    const effStride = stride ?? (packed ? PACKED_STRIDE : DEFAULT_STRIDE)
    // An explicit `total` wins and suppresses the inner (Content-Length) total to avoid a double fire.
    if (total != null) onTotal?.(total)
    const posStream = streamPositions(positions, {
      stride: effStride,
      packed: packed ?? false,
      signal,
      fetchImpl,
      onTotal: total != null ? undefined : onTotal,
    })
    // No channels → the single-positions path is byte-identical to before.
    if (labels == null && value == null) {
      yield* posStream
      return
    }
    // Channels present → zip each column's elements to the SAME per-batch row count (offset-aligned).
    const labelPuller = labels
      ? new ChannelPuller(streamChannelColumn(labels, 'u16', { signal, fetchImpl }), (n) => new Uint16Array(n))
      : null
    const valuePuller = value
      ? new ChannelPuller(streamChannelColumn(value, 'f32', { signal, fetchImpl }), (n) => new Float32Array(n))
      : null
    for await (const b of posStream) {
      const rows = b.positions.length >> 1
      const batch: NormalizedBatch = {
        offset: b.offset,
        positions: b.positions,
        ...(labelPuller ? { labels: await labelPuller.pull(rows) } : {}),
        ...(valuePuller ? { value: await valuePuller.pull(rows) } : {}),
      }
      yield batch
    }
    return
  }

  // Bare union (array / string / stream / iterable) → default stride 8, unpacked Float32.
  yield* streamPositions(data as PositionsInput, {
    stride: DEFAULT_STRIDE,
    packed: false,
    signal,
    fetchImpl,
    onTotal,
  })
}
