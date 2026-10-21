import { describe, it, expect } from 'vitest'
import { collectStream } from '@ziee/viz'
import { makeColumnarFrameReader } from './columnarRead'
import type { ProjectSources } from './projectSources'

// TEST-13 (incremental-landing #29, ITEM-7) — the `$data` consumer of an emit-plot colour column
// lands a multi-chunk stream in MORE THAN ONE step, AND the accumulated final value is
// byte-identical to the wholesale (`collectStream`) result. Both legs, or neither means anything:
// today's `await collectStream(...)` passes byte-identity and fails the step count; a mis-
// accumulating incremental impl passes the step count and fails byte-identity. The step count is
// observed by COUNTING landings (onChunk calls), not by timing.

/** f32 wire bytes for a run of numbers (the shape `continuous` yields). */
function f32Bytes(nums: readonly number[]): Uint8Array {
  const f = new Float32Array(nums)
  return new Uint8Array(f.buffer.slice(0))
}

/** A ProjectSources whose `continuous` stream yields the given chunks one at a time. */
function sourcesYielding(chunks: readonly Uint8Array[]): () => ProjectSources {
  return () =>
    ({
      streaming: {
        stream: () =>
          (async function* () {
            for (const c of chunks) yield c
          })(),
      },
    }) as unknown as ProjectSources
}

const STRUCTURE = {
  encoding: 'zarr_v3',
  kind: 'table',
  columns: [{ path: 'x', name: 'x', kind: 'numeric', dtype: 'float32', shape: [6] }],
}

describe('TEST-13 — progressive $data columnar read (ITEM-7)', () => {
  it('lands a multi-chunk stream in MORE THAN ONE step AND the final value is byte-identical to wholesale', async () => {
    const chunkNums = [
      [1, 2],
      [3, 4],
      [5, 6],
    ]
    const chunks = chunkNums.map(f32Bytes)

    // The wholesale reference: exactly what `collectStream` would have produced.
    const wholeBytes = await collectStream(
      (async function* () {
        for (const c of chunks) yield c
      })(),
    )
    const expected = new Float32Array(wholeBytes.buffer.slice(0))

    const reader = makeColumnarFrameReader(sourcesYielding(chunks))
    const landings: Array<{ frame: Record<string, unknown>; done: boolean }> = []
    const frame = await reader({ artifactId: 'a1', structure: STRUCTURE }, (f, done) =>
      landings.push({ frame: f as Record<string, unknown>, done }),
    )

    // STEP-COUNT leg: more than one landing (progressive), and the last is the terminal `done`.
    const partials = landings.filter(l => !l.done)
    expect(partials.length).toBeGreaterThan(1)
    expect(landings[landings.length - 1].done).toBe(true)
    // Each partial is a growing PREFIX (accumulation), not a lone chunk.
    expect((partials[0].frame.x as Float32Array).length).toBeLessThan(
      (partials[partials.length - 1].frame.x as Float32Array).length,
    )

    // BYTE-IDENTITY leg: the returned (and terminal) frame equals the wholesale result exactly.
    expect(Array.from(frame.x as Float32Array)).toEqual(Array.from(expected))
    const doneFrame = landings[landings.length - 1].frame.x as Float32Array
    expect(Array.from(doneFrame)).toEqual(Array.from(expected))
  })

  it('a caller passing NO onChunk gets exactly the wholesale frame (existing consumers unchanged)', async () => {
    const chunks = [f32Bytes([1, 2]), f32Bytes([3, 4])]
    const reader = makeColumnarFrameReader(sourcesYielding(chunks))
    const frame = await reader({ artifactId: 'a1', structure: STRUCTURE })
    expect(Array.from(frame.x as Float32Array)).toEqual([1, 2, 3, 4])
  })
})
