// progressiveDomain.test.ts — TEST-13 (ITEM-11). A continuous grid column streamed in N chunks
// computes a PROGRESSIVE KLL p1/p99 domain that CONVERGES to the full-array domain (final == a
// one-shot KllSketch over the whole array), across arbitrary chunk boundaries incl. mid-float splits.
import { describe, it, expect } from 'vitest'
import { streamColumnDomain, kllDomain, VALUE_SCALE_LO, VALUE_SCALE_HI } from './progressiveDomain'
import { KllSketch } from './sketches'
import type { StreamingSource, Channel } from './streamingSource'
import type { DatasetCatalog } from './wire'

/** A StreamingSource that streams ONE continuous column's raw LE f32 bytes in the given chunk
 *  byte-sizes (so a test can split floats across chunk boundaries). */
function columnSource(values: Float32Array, chunkBytes: number[]): StreamingSource {
  const bytes = new Uint8Array(values.buffer.slice(0)) // fresh 0-offset copy of the raw LE bytes
  return {
    async catalog() {
      return {} as unknown as DatasetCatalog
    },
    async *stream(_ch: Channel) {
      let off = 0
      for (const n of chunkBytes) {
        yield bytes.subarray(off, off + n)
        off += n
      }
      if (off < bytes.length) yield bytes.subarray(off)
    },
  }
}

interface Frame {
  domain: [number, number]
  count: number
  final: boolean
  values: number[]
}
async function collect(source: StreamingSource, channel: Channel): Promise<Frame[]> {
  const frames: Frame[] = []
  for await (const f of streamColumnDomain(source, channel)) {
    frames.push({ domain: [f.domain[0], f.domain[1]], count: f.count, final: f.final, values: Array.from(f.values) })
  }
  return frames
}

const CH: Channel = { kind: 'continuous', key: 'qc' }
const N = 100
// 0..99 — for N < the KLL k (200) the sketch stores every value, so quantiles are EXACT + deterministic.
const col = Float32Array.from({ length: N }, (_, i) => i)
const oneShotDomain = (): [number, number] => {
  const s = new KllSketch()
  for (const v of col) s.update(v)
  return kllDomain(s)
}

describe('streamColumnDomain — progressive KLL p1/p99 grid-column domain (ITEM-11 / TEST-13)', () => {
  it('converges to the full-array KLL p1/p99 domain (final == one-shot over the whole array)', async () => {
    const frames = await collect(columnSource(col, [100, 100, 100]), CH) // 100 B = 25 floats/chunk → 4 chunks
    const final = frames.at(-1)!
    expect(final.final).toBe(true)
    expect(final.count).toBe(N)
    expect(final.values).toEqual(Array.from(col))
    expect(final.domain).toEqual(oneShotDomain())
  })

  it('handles chunk boundaries that split a float mid-way (still exact)', async () => {
    const frames = await collect(columnSource(col, [3, 5, 7, 33, 101, 199]), CH) // odd sizes straddle floats
    const final = frames.at(-1)!
    expect(final.count).toBe(N)
    expect(final.values).toEqual(Array.from(col))
    expect(final.domain).toEqual(oneShotDomain())
  })

  it('emits an evolving domain: count grows monotonically, each domain lo≤hi, converging toward full', async () => {
    const frames = await collect(columnSource(col, [40, 40, 40]), CH)
    expect(frames.length).toBeGreaterThan(1)
    let prev = -1
    for (const f of frames) {
      expect(f.count).toBeGreaterThanOrEqual(prev)
      prev = f.count
      expect(f.domain[0]).toBeLessThanOrEqual(f.domain[1])
    }
    // The first partial frame (early values 0..) has a p99 no larger than the full column's p99.
    expect(frames[0].domain[1]).toBeLessThanOrEqual(frames.at(-1)!.domain[1])
  })

  it('throws on a stream that ends mid-float (truncation, not a silent short column)', async () => {
    const big = Float32Array.from({ length: N + 1 }, (_, i) => i)
    const bytes = new Uint8Array(big.buffer.slice(0, N * 4 + 2)) // 100 floats + 2 trailing bytes
    const src: StreamingSource = {
      async catalog() {
        return {} as unknown as DatasetCatalog
      },
      async *stream() {
        yield bytes
      },
    }
    await expect(collect(src, CH)).rejects.toThrow(/mid-float/)
  })

  it('kllDomain: empty sketch → [0,1]; populated → the sketch p1/p99', () => {
    expect(kllDomain(new KllSketch())).toEqual([0, 1])
    const s = new KllSketch()
    for (let i = 0; i < 100; i++) s.update(i)
    expect(kllDomain(s)).toEqual([s.quantile(VALUE_SCALE_LO), s.quantile(VALUE_SCALE_HI)])
  })
})
