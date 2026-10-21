import { describe, it, expect } from 'vitest'
import { normalizeVizData, type NormalizedBatch, type VizData } from './vizData'

// STREAMING_PROGRESSIVE_PLAN Wave 2b — the MULTI-CHANNEL normalizer (item 5/14). A `data` object with
// `labels`/`value` yields batches carrying those channels ALIGNED 1:1 with `positions` by the SAME
// offset — proven for whole in-memory arrays (one batch) AND independently-chunked byte streams (the
// channel puller realigns differing chunk boundaries).

function u8OfF32(f32: Float32Array): Uint8Array {
  return new Uint8Array(f32.slice().buffer)
}
function u8OfU16(u16: Uint16Array): Uint8Array {
  return new Uint8Array(u16.slice().buffer)
}
function chunkize(bytes: Uint8Array, chunkBytes: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let o = 0; o < bytes.length; o += chunkBytes) out.push(bytes.slice(o, o + chunkBytes))
  return out
}
function readableFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}
async function collect(data: VizData): Promise<NormalizedBatch[]> {
  const out: NormalizedBatch[] = []
  for await (const b of normalizeVizData(data)) out.push(b)
  return out
}

const N = 100_000 // > the 65536 rows/batch reframer default so a stream yields >1 batch
const xy = new Float32Array(N * 2)
const labels = new Uint16Array(N)
const values = new Float32Array(N)
for (let i = 0; i < N; i++) {
  xy[i * 2] = (i % 997) / 997
  xy[i * 2 + 1] = ((i * 7) % 997) / 997
  labels[i] = i % 8
  values[i] = i * 0.5 - 100
}

function assertAligned(batches: NormalizedBatch[]) {
  let acc = 0
  const outLabels = new Uint16Array(N)
  const outValues = new Float32Array(N)
  for (const b of batches) {
    const rows = b.positions.length >> 1
    expect(b.offset).toBe(acc)
    expect(b.labels).toBeDefined()
    expect(b.value).toBeDefined()
    // Each channel carries EXACTLY the batch's row count (offset alignment by construction).
    expect(b.labels!.length).toBe(rows)
    expect(b.value!.length).toBe(rows)
    outLabels.set(b.labels!, acc)
    outValues.set(b.value!, acc)
    acc += rows
  }
  expect(acc).toBe(N)
  expect(Array.from(outLabels)).toEqual(Array.from(labels))
  expect(Array.from(outValues)).toEqual(Array.from(values))
}

describe('normalizeVizData — multi-channel object form (whole arrays)', () => {
  it('a whole-array positions + labels + value yields ONE aligned batch', async () => {
    const batches = await collect({ positions: xy, labels, value: values })
    expect(batches).toHaveLength(1)
    expect(batches[0].positions).toBe(xy) // zero-copy positions
    assertAligned(batches)
  })

  it('labels-only / value-only carry just that channel', async () => {
    const labelOnly = await collect({ positions: xy, labels })
    expect(labelOnly[0].labels).toBeDefined()
    expect(labelOnly[0].value).toBeUndefined()
    const valueOnly = await collect({ positions: xy, value: values })
    expect(valueOnly[0].value).toBeDefined()
    expect(valueOnly[0].labels).toBeUndefined()
  })

  it('NO channels is byte-identical to the single-positions path (labels/value absent)', async () => {
    const batches = await collect({ positions: xy })
    expect(batches).toHaveLength(1)
    expect(batches[0].positions).toBe(xy)
    expect(batches[0].labels).toBeUndefined()
    expect(batches[0].value).toBeUndefined()
  })
})

describe('normalizeVizData — multi-channel byte streams (independent chunk boundaries)', () => {
  it('positions/labels/value chunked at DIFFERENT boundaries realign 1:1 by offset', async () => {
    // Each column split at boundaries that do NOT respect element/point size → forces reframing +
    // the channel puller to realign across chunk seams.
    const posStream = readableFrom(chunkize(u8OfF32(xy), 3003)) // stride 8 → straddles points
    const labelStream = readableFrom(chunkize(u8OfU16(labels), 777)) // stride 2 → straddles codes
    const valueStream = readableFrom(chunkize(u8OfF32(values), 1111)) // stride 4 → straddles values
    const batches = await collect({
      positions: { stream: posStream },
      labels: { stream: labelStream },
      value: { stream: valueStream },
    })
    expect(batches.length).toBeGreaterThan(1)
    assertAligned(batches)
  })
})
