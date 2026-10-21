// fixtures.test.ts — TEST-14 (ITEM-15): FixtureSource exposes canonical `pointIds` ONLY when barcodes
// are supplied; a bare fixture has no namespace (isolated), so unrelated fixtures never falsely link.
import { describe, it, expect } from 'vitest'
import { FixtureSource } from './fixtures'

describe('FixtureSource.pointIds (multi-datasource namespace)', () => {
  it('exposes pointIds when barcodes are supplied, returns them, and is absent otherwise', async () => {
    const ids = Uint32Array.from([5, 6, 7])
    const withIds = new FixtureSource({ pointCount: 3, pointIds: ids })
    const bare = new FixtureSource({ pointCount: 3 })

    expect(typeof withIds.pointIds).toBe('function')
    expect(await withIds.pointIds!()).toEqual(ids)

    // A bare fixture is an ISOLATED identity space — no pointIds method (never cross-links on raw rows).
    expect(bare.pointIds).toBeUndefined()
  })
})
