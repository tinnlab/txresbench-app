// fetchStream.ts — fetch → typed-array STREAMING front-end (STREAMING_PROGRESSIVE_PLAN
// items 7/8, fetch variant). A backend endpoint streams a large binary column (interleaved
// Float32 xy, Uint16 packed codes, a Float32 scalar, …). `fetch()` hands back a
// `ReadableStream<Uint8Array>` whose chunks split at ARBITRARY byte boundaries — an element
// or whole "row" can straddle two chunks. This module reassembles whole rows (STRIDE bytes)
// across chunk boundaries, produces 0-ALIGNED byte batches (so `Float32Array` views are
// legal), coalesces small network chunks into good-sized batches, and yields
// `{ offset, rows, bytes }` batches where `offset` is the GLOBAL row index — feeding the
// raster worker's progressive bin+emit.
//
// Pure stream logic: `reframeBytes` is framework-free and node-testable against a synthetic
// `AsyncIterable<Uint8Array>` (no network). `streamBinaryColumn` is the thin fetch wrapper.
//
// ── ENDIANNESS CONTRACT ───────────────────────────────────────────────────────
// The wire is LITTLE-ENDIAN (matches wire.ts). `asFloat32` / `asUint16` create native
// TypedArray views, which read in the RUNTIME's byte order. Every target (browsers on
// x86/ARM, node in CI) is little-endian, so the view is a zero-copy reinterpret with no
// swap. This module does NOT byte-swap; a hypothetical big-endian host would misread — out
// of scope, same assumption wire.ts already bakes in.

/** A reframed batch: `rows` whole rows starting at global row index `offset`. `bytes` is a
 *  freshly-allocated, 0-aligned (`byteOffset === 0`) `Uint8Array` of `rows * bytesPerRow`
 *  bytes — so a `Float32Array` / `Uint16Array` view over `bytes.buffer` is always legal. */
export interface ReframedBatch {
  /** Global row index of the first row in this batch (accumulates in ROWS). */
  readonly offset: number
  /** Number of whole rows in this batch. */
  readonly rows: number
  /** 0-aligned bytes, length === `rows * bytesPerRow`. */
  readonly bytes: Uint8Array
}

/** Options for {@link reframeBytes}. */
export interface ReframeOptions {
  /** STRIDE — bytes per whole row (e.g. 8 for interleaved 2×Float32, 2 for Uint16). */
  readonly bytesPerRow: number
  /** Coalesce network chunks into batches of this many rows (default 65536). The final
   *  batch may be smaller (the whole-row remainder at stream end). */
  readonly rowsPerBatch?: number
}

const DEFAULT_ROWS_PER_BATCH = 65536

/**
 * Reframe an arbitrary byte-chunk source into whole-row batches.
 *
 * Maintains a CARRY buffer of not-yet-emitted bytes; each incoming chunk is concatenated
 * onto the carry into a FRESH 0-aligned buffer, then full `rowsPerBatch`-sized batches are
 * sliced off (each `slice()` is a fresh 0-aligned copy → legal `Float32Array` views). At
 * stream end the whole-row remainder is flushed as a final (possibly smaller) batch.
 *
 * A straddling row (bytes split across chunks) is carried until complete. If, at stream end,
 * fewer than one row's worth of bytes remain, the stream is MALFORMED and this THROWS.
 *
 * `offset` accumulates in ROWS across the whole stream.
 */
export async function* reframeBytes(
  chunks: AsyncIterable<Uint8Array>,
  opts: ReframeOptions,
): AsyncIterable<ReframedBatch> {
  const bytesPerRow = opts.bytesPerRow
  if (!Number.isInteger(bytesPerRow) || bytesPerRow <= 0) {
    throw new Error(`reframeBytes: bytesPerRow must be a positive integer, got ${bytesPerRow}`)
  }
  const rowsPerBatch = opts.rowsPerBatch ?? DEFAULT_ROWS_PER_BATCH
  if (!Number.isInteger(rowsPerBatch) || rowsPerBatch <= 0) {
    throw new Error(`reframeBytes: rowsPerBatch must be a positive integer, got ${rowsPerBatch}`)
  }
  const batchBytes = rowsPerBatch * bytesPerRow

  let carry = new Uint8Array(0)
  let offsetRows = 0

  for await (const chunk of chunks) {
    if (chunk.byteLength === 0) continue
    // Concat carry + chunk into a fresh 0-aligned buffer (carry is bounded < batchBytes at
    // the top of each iteration, so this stays proportional to one batch + one chunk).
    const merged = new Uint8Array(carry.length + chunk.byteLength)
    merged.set(carry, 0)
    merged.set(chunk, carry.length)
    carry = merged

    // Emit every full batch we now have.
    let cut = 0
    while (carry.length - cut >= batchBytes) {
      const bytes = carry.slice(cut, cut + batchBytes) // fresh, byteOffset === 0
      yield { offset: offsetRows, rows: rowsPerBatch, bytes }
      offsetRows += rowsPerBatch
      cut += batchBytes
    }
    carry = cut === 0 ? carry : carry.slice(cut)
  }

  // Flush the whole-row remainder (< one batch).
  const remRows = Math.floor(carry.length / bytesPerRow)
  if (remRows > 0) {
    const bytes = carry.slice(0, remRows * bytesPerRow)
    yield { offset: offsetRows, rows: remRows, bytes }
    offsetRows += remRows
    carry = carry.slice(remRows * bytesPerRow)
  }

  if (carry.length > 0) {
    throw new Error(
      `reframeBytes: malformed stream — ${carry.length} trailing byte(s), not a whole row of ${bytesPerRow}`,
    )
  }
}

/** Total-size info surfaced once (before the first batch) from the response `Content-Length`.
 *  Both fields are `null` when the server does not send a usable `Content-Length` (e.g. a
 *  chunked-transfer response). */
export interface StreamTotal {
  /** Total payload size in bytes, or `null` if unknown. */
  readonly totalBytes: number | null
  /** Total row count (`floor(totalBytes / bytesPerRow)`), or `null` if unknown. */
  readonly totalRows: number | null
}

/** Options for {@link streamBinaryColumn}. */
export interface StreamBinaryOptions extends ReframeOptions {
  /** Abort the fetch + stop iteration. */
  readonly signal?: AbortSignal
  /**
   * The transport this read uses — **REQUIRED** (ITEM-16 / DEC-15 option (a)).
   *
   * It used to be optional, silently falling back to the ambient global `fetch`. That fallback
   * could only ever produce a 401 against a route gated `RequirePermissions<(ProjectsUse,)>`
   * (`data_api.rs:1061`, `:1077`) plus per-artifact scope resolution (`authz.rs:138-148`) — no
   * bearer, no credentials, no base URL — and would have produced an UNAUTHENTICATED read had any
   * such route ever been relaxed. Making it required turns INV-7 ("every byte read goes through the
   * app's client") from a convention someone must remember into something `tsc` enforces.
   *
   * In the app, pass the transport that carries auth. In a fixture / showcase / test, pass a mock
   * returning a `ReadableStream` — that is what this parameter is FOR, and naming it is the point.
   */
  readonly fetchImpl: typeof fetch
  /** Called ONCE, before the first batch, with the `Content-Length`-derived totals. This is
   *  how the total is surfaced (kept off the uniform `ReframedBatch` shape). */
  readonly onTotal?: (total: StreamTotal) => void
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Fetch a binary column and yield reframed whole-row batches (`offset` = global row index).
 *
 * Uses `response.body.getReader()` — pull-based, so backpressure is natural (the network is
 * only pulled as the consumer pulls batches). Reads `Content-Length` and surfaces it once via
 * `opts.onTotal` before the first batch. Honors `opts.signal` (forwarded to `fetch` AND
 * checked between reads). `opts.fetchImpl` is REQUIRED — there is no ambient-`fetch` fallback.
 */
export async function* streamBinaryColumn(
  url: string,
  opts: StreamBinaryOptions,
): AsyncIterable<ReframedBatch> {
  const { bytesPerRow, rowsPerBatch, signal, fetchImpl, onTotal } = opts
  // No `?? fetch` — see `StreamBinaryOptions.fetchImpl`. The runtime check exists for a JS caller
  // (or a `as never` cast) that slips past the type: an ambient-transport read must fail LOUD here
  // rather than 401 somewhere far away.
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'streamBinaryColumn: `fetchImpl` is required — name the transport that carries auth (ITEM-16). ' +
        'There is no ambient-`fetch` fallback: it can only produce an unauthenticated read.',
    )
  }
  const doFetch = fetchImpl

  if (signal?.aborted) throw abortError()

  const res = await doFetch(url, { signal })
  if (!res.ok) {
    throw new Error(`streamBinaryColumn: HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  if (!res.body) {
    throw new Error(`streamBinaryColumn: response has no readable body for ${url}`)
  }

  if (onTotal) {
    const raw = res.headers?.get?.('Content-Length') ?? null
    const totalBytes = raw != null && raw !== '' ? Number(raw) : Number.NaN
    if (Number.isFinite(totalBytes) && totalBytes >= 0) {
      onTotal({ totalBytes, totalRows: Math.floor(totalBytes / bytesPerRow) })
    } else {
      onTotal({ totalBytes: null, totalRows: null })
    }
  }

  const reader = res.body.getReader()
  const byteChunks: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (signal?.aborted) throw abortError()
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) yield value
        }
      } finally {
        // Release so an aborted/early-broken stream doesn't leak the lock.
        try {
          reader.releaseLock()
        } catch {
          // reader already released / stream errored — nothing to do.
        }
      }
    },
  }

  yield* reframeBytes(byteChunks, { bytesPerRow, rowsPerBatch })
}

// ── typed-view helpers (zero-copy views over the 0-aligned batch buffer) ──────

/** View a batch as `Float32Array`. Requires `bytesPerRow` (hence `bytes.byteLength`) to be a
 *  multiple of 4 — true for Float32 rows (e.g. STRIDE 8 = 2×Float32). Little-endian (see
 *  the endianness contract at the top). */
export function asFloat32(batch: ReframedBatch): Float32Array {
  return new Float32Array(batch.bytes.buffer, batch.bytes.byteOffset, batch.bytes.byteLength / 4)
}

/** View a batch as `Uint16Array`. Requires `bytes.byteLength` to be a multiple of 2 — true
 *  for Uint16 rows. Little-endian (see the endianness contract at the top). */
export function asUint16(batch: ReframedBatch): Uint16Array {
  return new Uint16Array(batch.bytes.buffer, batch.bytes.byteOffset, batch.bytes.byteLength / 2)
}
