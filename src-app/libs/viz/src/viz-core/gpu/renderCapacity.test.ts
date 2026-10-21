import { describe, it, expect, beforeEach } from 'vitest'
import {
  rendererHash,
  capacityToThreshold,
  isCapacityRecordValid,
  resolveMachineThreshold,
  sessionMachineThreshold,
  _resetSessionThresholdCache,
  PROBE_POINT_FLOOR,
  CAPACITY_CEILING,
  CAPACITY_SCHEMA_VERSION,
  CAPACITY_STORAGE_KEY,
  CAPACITY_TTL_MS,
  type CapacityRecord,
  type CapacityStore,
} from './renderCapacity'
import { DEFAULT_RASTER_POINT_THRESHOLD } from './renderCapability'

/** An in-memory CapacityStore for deterministic cache tests. */
function memStore(seed?: Record<string, string>): CapacityStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('rendererHash', () => {
  it('is stable + differs by renderer string', () => {
    expect(rendererHash('NVIDIA H200')).toBe(rendererHash('NVIDIA H200'))
    expect(rendererHash('NVIDIA H200')).not.toBe(rendererHash('Intel Iris Xe'))
    expect(rendererHash(null)).toBe(rendererHash(undefined)) // both hash the empty string
  })
})

describe('capacityToThreshold (clamp)', () => {
  it('clamps a huge measurement to the ceiling (fast GPU never disables raster)', () => {
    expect(capacityToThreshold(50_000_000)).toBe(CAPACITY_CEILING)
  })
  it('clamps a tiny measurement up to the floor', () => {
    expect(capacityToThreshold(10_000)).toBe(PROBE_POINT_FLOOR)
  })
  it('passes a mid-range measurement through (rounded)', () => {
    expect(capacityToThreshold(750_000.6)).toBe(750_001)
  })
  it('non-finite / non-positive → the fixed default', () => {
    expect(capacityToThreshold(NaN)).toBe(DEFAULT_RASTER_POINT_THRESHOLD)
    expect(capacityToThreshold(0)).toBe(DEFAULT_RASTER_POINT_THRESHOLD)
    expect(capacityToThreshold(-5)).toBe(DEFAULT_RASTER_POINT_THRESHOLD)
  })
})

describe('isCapacityRecordValid', () => {
  const rHash = rendererHash('GPU-X')
  const base: CapacityRecord = {
    version: CAPACITY_SCHEMA_VERSION,
    rendererHash: rHash,
    threshold: 800_000,
    measuredCapacity: 800_000,
    measuredAt: 1_000,
  }
  it('accepts a fresh, same-renderer, current-version record', () => {
    expect(isCapacityRecordValid(base, rHash, 1_000 + CAPACITY_TTL_MS - 1)).toBe(true)
  })
  it('rejects a different renderer', () => {
    expect(isCapacityRecordValid(base, rendererHash('GPU-Y'), 2_000)).toBe(false)
  })
  it('rejects a stale record (past TTL)', () => {
    expect(isCapacityRecordValid(base, rHash, 1_000 + CAPACITY_TTL_MS + 1)).toBe(false)
  })
  it('rejects an old schema version + junk', () => {
    expect(isCapacityRecordValid({ ...base, version: 0 }, rHash, 2_000)).toBe(false)
    expect(isCapacityRecordValid(null, rHash, 2_000)).toBe(false)
    expect(isCapacityRecordValid('nope', rHash, 2_000)).toBe(false)
  })
})

describe('resolveMachineThreshold', () => {
  it('returns a valid cached threshold WITHOUT probing', () => {
    const rec: CapacityRecord = {
      version: CAPACITY_SCHEMA_VERSION,
      rendererHash: rendererHash('GPU-A'),
      threshold: 640_000,
      measuredCapacity: 640_000,
      measuredAt: 500,
    }
    const store = memStore({ [CAPACITY_STORAGE_KEY]: JSON.stringify(rec) })
    let probed = false
    const t = resolveMachineThreshold({
      renderer: 'GPU-A',
      store,
      now: () => 1_000,
      measure: () => {
        probed = true
        return 9_999
      },
    })
    expect(t).toBe(640_000)
    expect(probed).toBe(false)
  })

  it('probes, clamps, and PERSISTS when there is no valid cache', () => {
    const store = memStore()
    const t = resolveMachineThreshold({
      renderer: 'Intel Iris Xe',
      store,
      now: () => 42,
      measure: () => 700_000,
    })
    expect(t).toBe(700_000)
    const saved = JSON.parse(store.map.get(CAPACITY_STORAGE_KEY)!) as CapacityRecord
    expect(saved.threshold).toBe(700_000)
    expect(saved.rendererHash).toBe(rendererHash('Intel Iris Xe'))
    expect(saved.measuredAt).toBe(42)
  })

  it('clamps a monster-GPU probe to the ceiling and persists that', () => {
    const store = memStore()
    const t = resolveMachineThreshold({ renderer: 'H200', store, now: () => 1, measure: () => 40_000_000 })
    expect(t).toBe(CAPACITY_CEILING)
  })

  it('a failed probe → the fixed default and does NOT persist (re-probes next time)', () => {
    const store = memStore()
    const t = resolveMachineThreshold({ renderer: 'GPU-B', store, now: () => 1, measure: () => null })
    expect(t).toBe(DEFAULT_RASTER_POINT_THRESHOLD)
    expect(store.map.has(CAPACITY_STORAGE_KEY)).toBe(false)
  })

  it('tolerates a null store (SSR / private mode) — no throw, returns the measured value', () => {
    const t = resolveMachineThreshold({ renderer: 'GPU-C', store: null, now: () => 1, measure: () => 900_000 })
    expect(t).toBe(900_000)
  })
})

describe('sessionMachineThreshold memo', () => {
  beforeEach(() => _resetSessionThresholdCache())
  it('runs the probe at most once per renderer per session', () => {
    const store = memStore()
    let calls = 0
    const deps = {
      renderer: 'GPU-D',
      store,
      now: () => 1,
      measure: () => {
        calls++
        return 500_000
      },
    }
    expect(sessionMachineThreshold(deps)).toBe(500_000)
    expect(sessionMachineThreshold(deps)).toBe(500_000)
    expect(calls).toBe(1)
  })
})
