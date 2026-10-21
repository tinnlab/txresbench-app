import { describe, it, expect } from 'vitest'
import {
  createCpuRasterClient,
  type MainToWorker,
  type RasterWorkerLike,
  type WorkerToMain,
} from './cpuRasterClient'
import { binAndShade } from './cpuRaster'
import type { DensityBounds } from './densityBin'

// A3 off-thread bin+shade (PERFORMANCE_PLAN.md Phase 1). These tests run in the node vitest env
// where `typeof Worker === 'undefined'`, so:
//   • the DEFAULT client exercises the main-thread fallback → its output must be BYTE-IDENTICAL to
//     a direct `binAndShade` (the off-thread move must not change a single pixel);
//   • the epoch / stale-drop bookkeeping is exercised as PURE LOGIC by injecting a fake transport
//     (`workerFactory`) — no real Worker is spun up (per the plan).

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

// A hand-placed cloud (reused from cpuRaster.test.ts) across a 2×2 grid.
const pts = new Float32Array([
  0.1, 0.1, 0.2, 0.2, 0.4, 0.05, // BL ×3
  0.8, 0.2, // BR ×1
  0.9, 0.9, 0.6, 0.7, // TR ×2
])

const REQ = { bounds: UNIT, width: 2, height: 2, normalize: 'linear', flipY: false } as const

/** A controllable in-memory transport standing in for a real Worker (no threads spun up). */
function makeFakeWorker() {
  let handler: ((msg: WorkerToMain) => void) | null = null
  const posted: MainToWorker[] = []
  let terminated = false
  const worker: RasterWorkerLike = {
    postMessage: (message) => {
      posted.push(message)
    },
    terminate: () => {
      terminated = true
    },
    setOnMessage: (h) => {
      handler = h
    },
  }
  return {
    worker,
    posted,
    isTerminated: () => terminated,
    /** Deliver a worker→main message as if the worker had finished. */
    deliver: (msg: WorkerToMain) => handler?.(msg),
    /** Convenience: compute the real raster for a posted `bin` message and deliver it. */
    respond: (epoch: number) => {
      const image = binAndShade({ positions: pts, ...REQ })
      handler?.({ type: 'binResult', epoch, rgba: image.rgba, width: image.width, height: image.height })
      return image
    },
  }
}

describe('createCpuRasterClient — main-thread fallback (no Worker)', () => {
  it('produces rgba byte-identical to a direct binAndShade', async () => {
    const client = createCpuRasterClient() // node: no global Worker → fallback
    client.init(pts)
    const got = await client.requestBin(REQ)
    const expected = binAndShade({ positions: pts, ...REQ })
    expect(got).not.toBeNull()
    expect(got!.width).toBe(expected.width)
    expect(got!.height).toBe(expected.height)
    expect(Array.from(got!.rgba)).toEqual(Array.from(expected.rgba))
  })

  it('forceMainThread takes the fallback even where a factory is supplied', async () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ forceMainThread: true, workerFactory: () => fake.worker })
    client.init(pts)
    const got = await client.requestBin(REQ)
    expect(fake.posted).toHaveLength(0) // never touched the transport
    expect(Array.from(got!.rgba)).toEqual(Array.from(binAndShade({ positions: pts, ...REQ }).rgba))
  })

  it('an empty (never-init) client bins against zero positions → transparent', async () => {
    const client = createCpuRasterClient({ forceMainThread: true })
    const got = await client.requestBin({ bounds: UNIT, width: 3, height: 3 })
    expect(got!.rgba.length).toBe(3 * 3 * 4)
    expect(Array.from(got!.rgba).every((v) => v === 0)).toBe(true)
  })
})

describe('createCpuRasterClient — worker path (fake transport)', () => {
  it('init transfers a COPY of positions (caller array untouched) and posts type=init', () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ workerFactory: () => fake.worker })
    client.init(pts)
    const init = fake.posted.find((m) => m.type === 'init')
    expect(init).toBeTruthy()
    if (init && init.type === 'init') {
      expect(init.positions).not.toBe(pts) // a copy, not the same reference
      expect(Array.from(init.positions)).toEqual(Array.from(pts)) // same contents
    }
    expect(pts.length).toBe(12) // original not neutered
  })

  it('assigns a strictly increasing epoch to each requestBin', () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ workerFactory: () => fake.worker })
    client.init(pts)
    void client.requestBin(REQ)
    void client.requestBin(REQ)
    void client.requestBin(REQ)
    const epochs = fake.posted.filter((m) => m.type === 'bin').map((m) => (m as { epoch: number }).epoch)
    expect(epochs).toEqual([1, 2, 3])
    for (let i = 1; i < epochs.length; i++) expect(epochs[i]).toBeGreaterThan(epochs[i - 1])
  })

  it('only the LATEST epoch resolves with an image; superseded requests resolve null', async () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ workerFactory: () => fake.worker })
    client.init(pts)
    const p1 = client.requestBin(REQ)
    const p2 = client.requestBin(REQ)
    const bins = fake.posted.filter((m) => m.type === 'bin') as Array<{ epoch: number }>
    // Deliver in FIFO order (as a real single-threaded worker would): stale epoch first.
    fake.deliver({ type: 'binResult', epoch: bins[0].epoch, rgba: new Uint8ClampedArray(16), width: 2, height: 2 })
    const expected = fake.respond(bins[1].epoch) // latest → wins
    await expect(p1).resolves.toBeNull()
    const got = await p2
    expect(got).not.toBeNull()
    expect(Array.from(got!.rgba)).toEqual(Array.from(expected.rgba))
  })

  it('a response for the latest epoch resolves with that raster', async () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ workerFactory: () => fake.worker })
    client.init(pts)
    const p = client.requestBin(REQ)
    const bin = fake.posted.find((m) => m.type === 'bin') as { epoch: number }
    const expected = fake.respond(bin.epoch)
    const got = await p
    expect(Array.from(got!.rgba)).toEqual(Array.from(expected.rgba))
  })

  it('terminate resolves in-flight requests with null, tears down the worker, and no-ops after', async () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ workerFactory: () => fake.worker })
    client.init(pts)
    const p = client.requestBin(REQ)
    client.terminate()
    await expect(p).resolves.toBeNull()
    expect(fake.isTerminated()).toBe(true)
    // Post-terminate requests short-circuit to null and never touch the transport.
    const postedBefore = fake.posted.length
    await expect(client.requestBin(REQ)).resolves.toBeNull()
    expect(fake.posted.length).toBe(postedBefore)
  })

  it('ignores a worker message whose epoch has no pending request (late/duplicate)', async () => {
    const fake = makeFakeWorker()
    const client = createCpuRasterClient({ workerFactory: () => fake.worker })
    client.init(pts)
    const p = client.requestBin(REQ)
    const bin = fake.posted.find((m) => m.type === 'bin') as { epoch: number }
    fake.respond(bin.epoch) // resolves p
    await p
    // A duplicate delivery for the same (now-deleted) epoch must be harmlessly ignored.
    expect(() => fake.deliver({ type: 'binResult', epoch: bin.epoch, rgba: new Uint8ClampedArray(16), width: 2, height: 2 })).not.toThrow()
  })
})
