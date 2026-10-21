// progressiveDomain.ts — ITEM-11. A GRID-path PROGRESSIVE color domain: stream a continuous grid
// column CHUNK-BY-CHUNK, feed a mergeable KllSketch, and emit an evolving p1/p99 domain that
// CONVERGES to the full-array KLL domain. Previously the grid collected a column WHOLE via the
// bridge's `collectStream` (DRIFT-1.4), so no progressive domain was possible; this is the seam that
// makes the grid progressive. The RASTER path (`density/ChannelAccumulator`) is untouched — the two
// share ONLY the pure `kllDomain` helper + the `KllSketch`, never the accumulator.

import { KllSketch } from './sketches'
import { mulberry32 } from '../rng'
import type { StreamingSource, Channel, StreamOptions } from './streamingSource'

/** ITEM-7: a FIXED-seed PRNG for the domain sketch so the color domain is REPRODUCIBLE across renders
 *  (the sketch's compaction is otherwise `Math.random` — the one prod nondeterminism). The estimate only
 *  needs stability, not per-cell variety, so a constant seed suffices. */
const DOMAIN_SKETCH_SEED = 0x5ee2

/** Lower/upper quantiles the value/continuous color scale spans (p1..p99) — the SINGLE source of the
 *  "which quantiles" rule, shared with the raster `ChannelAccumulator` so grid + raster agree. */
export const VALUE_SCALE_LO = 0.01
export const VALUE_SCALE_HI = 0.99

/** The p1/p99 color-scale domain from a KLL sketch (`[0,1]` fallback when empty). The single home of
 *  the "domain from a sketch" rule; the raster `ChannelAccumulator.valueDomain()` delegates here. */
export function kllDomain(sketch: KllSketch): [number, number] {
  if (sketch.count === 0) return [0, 1]
  return [sketch.quantile(VALUE_SCALE_LO), sketch.quantile(VALUE_SCALE_HI)]
}

/** One progressive frame: the values seen SO FAR + the evolving p1/p99 domain. `values` is a view
 *  over the growing buffer — a SNAPSHOT valid until the next iteration (copy it if retained). */
export interface ProgressiveDomainFrame {
  readonly values: Float32Array
  readonly domain: readonly [number, number]
  readonly count: number
  readonly final: boolean
}

/**
 * Stream a CONTINUOUS grid column chunk-by-chunk, decoding little-endian f32s across arbitrary byte
 * boundaries (a float straddling two chunks is buffered), feeding each into a `KllSketch`, and
 * yielding an evolving `{ values, domain }` after each chunk (+ a terminal `final` frame). The last
 * frame's domain equals a one-shot `KllSketch` over the whole array — CONVERGENCE — so a caller
 * re-colors the cell per frame and lands on the exact full-array domain. Continuous channel only
 * (a sparse `value` column densifies upstream via the whole-collect path); this is the dense case
 * ITEM-11 targets. Honors `opts.signal` cancellation via the underlying `stream`.
 */
export async function* streamColumnDomain(
  source: StreamingSource,
  channel: Channel,
  opts?: StreamOptions,
): AsyncIterable<ProgressiveDomainFrame> {
  const sketch = new KllSketch(undefined, mulberry32(DOMAIN_SKETCH_SEED))
  let values = new Float32Array(1024)
  let count = 0
  const push = (v: number): void => {
    if (count === values.length) {
      const grown = new Float32Array(values.length * 2)
      grown.set(values)
      values = grown
    }
    values[count++] = v
    sketch.update(v)
  }
  // Byte-buffer a f32 that straddles a chunk boundary (mirrors the CSC decoder's header carry).
  const carry = new Uint8Array(4)
  let carryLen = 0
  const carryView = new DataView(carry.buffer)

  for await (const chunk of source.stream(channel, opts)) {
    let pos = 0
    // 1. finish a float carried over from the previous chunk.
    if (carryLen > 0) {
      const take = Math.min(4 - carryLen, chunk.length)
      carry.set(chunk.subarray(0, take), carryLen)
      carryLen += take
      pos += take
      if (carryLen === 4) {
        push(carryView.getFloat32(0, true))
        carryLen = 0
      }
    }
    // 2. whole floats in this chunk.
    const avail = chunk.length - pos
    const whole = avail - (avail % 4)
    if (whole > 0) {
      const dv = new DataView(chunk.buffer, chunk.byteOffset + pos, whole)
      for (let i = 0; i < whole; i += 4) push(dv.getFloat32(i, true))
      pos += whole
    }
    // 3. stash a trailing partial float for the next chunk.
    if (pos < chunk.length) {
      const rem = chunk.length - pos
      carry.set(chunk.subarray(pos, pos + rem), 0)
      carryLen = rem
    }
    yield { values: values.subarray(0, count), domain: kllDomain(sketch), count, final: false }
  }
  if (carryLen !== 0) {
    throw new Error(`streamColumnDomain: continuous stream ended mid-float (${carryLen} trailing bytes)`)
  }
  // Terminal frame — the converged full-array domain.
  yield { values: values.subarray(0, count), domain: kllDomain(sketch), count, final: true }
}
