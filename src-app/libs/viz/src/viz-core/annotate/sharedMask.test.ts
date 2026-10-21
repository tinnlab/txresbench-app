// sharedMask.test.ts — Track A ITEM-4/7 (TEST-5, TEST-9) + INV-8 acceptance (TEST-A8).
import { describe, it, expect } from 'vitest'
import { createSharedLabelMask, type WorldRect } from './sharedMask'
import { createSharedMaskController } from './sharedMaskController'
import { fanOutDirtyRect } from './sharedMaskFanout'
import { isEmptyRect } from './maskEdit'

const BOUNDS: WorldRect = [100, 200, 900, 1000] // spanX=800, spanY=800

describe('sharedMask — world/pixel placement (TEST-5)', () => {
  it('positions the raster in world space and world↔pixel are exact inverses', () => {
    const m = createSharedLabelMask({ id: 'g1', worldBounds: BOUNDS, width: 400, height: 400 })
    // corners
    expect(m.worldToPixel(100, 200)).toEqual([0, 0])
    expect(m.worldToPixel(900, 1000)).toEqual([400, 400])
    // round-trip a scatter of interior points within eps
    for (const [wx, wy] of [
      [123.5, 456.25],
      [500, 600],
      [899.9, 999.9],
      [100.1, 200.1],
    ]) {
      const [px, py] = m.worldToPixel(wx, wy)
      const [rx, ry] = m.pixelToWorld(px, py)
      expect(rx).toBeCloseTo(wx, 9)
      expect(ry).toBeCloseTo(wy, 9)
    }
  })

  it('maps a world length to pixels via the shared scale', () => {
    const m = createSharedLabelMask({ id: 'g1', worldBounds: BOUNDS, width: 400, height: 400 })
    // spanX 800 over 400px ⇒ 2 world units / pixel ⇒ a 20-world-unit radius = 10px
    expect(m.worldLengthToPixels(20)).toBeCloseTo(10, 9)
  })

  it('modelMatrix places pixel(px,py) at world = pixelToWorld(px,py)', () => {
    const m = createSharedLabelMask({ id: 'g1', worldBounds: BOUNDS, width: 400, height: 400 })
    const mm = m.modelMatrix()
    // column-major: world = M · [px,py,0,1]
    const apply = (px: number, py: number): [number, number] => [
      mm[0] * px + mm[4] * py + mm[12],
      mm[1] * px + mm[5] * py + mm[13],
    ]
    for (const [px, py] of [
      [0, 0],
      [400, 400],
      [123, 321],
    ]) {
      const [wx, wy] = apply(px, py)
      const [ex, ey] = m.pixelToWorld(px, py)
      expect(wx).toBeCloseTo(ex, 9)
      expect(wy).toBeCloseTo(ey, 9)
    }
  })

  it('rejects non-positive dims / spans', () => {
    expect(() => createSharedLabelMask({ id: 'x', worldBounds: BOUNDS, width: 0, height: 10 })).toThrow()
    expect(() => createSharedLabelMask({ id: 'x', worldBounds: [0, 0, 0, 10], width: 10, height: 10 })).toThrow()
  })
})

describe('sharedMask — view registration (TEST-9)', () => {
  it('register/unregister add & drop views WITHOUT touching the raster (INV-8)', () => {
    const m = createSharedLabelMask({ id: 'g1', worldBounds: BOUNDS, width: 16, height: 16 })
    m.raster[0] = 7
    const before = Uint32Array.from(m.raster)
    m.registerView('a')
    m.registerView('b', [100, 200, 500, 600])
    expect(m.views.size).toBe(2)
    expect(m.views.get('a')?.worldViewport).toBeNull()
    expect(m.views.get('b')?.worldViewport).toEqual([100, 200, 500, 600])
    m.unregisterView('a')
    expect(m.views.size).toBe(1)
    expect(m.views.has('a')).toBe(false)
    // raster identity + bytes untouched by any view op
    expect(m.raster).toStrictEqual(before)
  })

  it('is ONE raster regardless of view count — a 4th view adds no allocation', () => {
    const m = createSharedLabelMask({ id: 'g1', worldBounds: BOUNDS, width: 32, height: 32 })
    const ref = m.raster
    for (const id of ['a', 'b', 'c', 'd']) m.registerView(id)
    expect(m.raster).toBe(ref) // same reference — no per-view copy
    expect(m.views.size).toBe(4)
  })

  it('adopts a supplied raster/LUT BY REFERENCE (no copy)', () => {
    const raster = new Uint32Array(64)
    const lut = new Uint16Array(4)
    const m = createSharedLabelMask({ id: 'g', worldBounds: BOUNDS, width: 8, height: 8, raster, categoryForId: lut })
    expect(m.raster).toBe(raster)
    expect(m.categoryForId).toBe(lut)
  })
})

describe('sharedMask — one raster / one undo, fan-out per view (TEST-A8, INV-8)', () => {
  it('an edit mutates the single raster; fan-out yields each view its intersection; undo restores bytes', () => {
    // 40x40 world-unit-per-pixel=1 for easy reasoning: bounds span 40, dims 40.
    const m = createSharedLabelMask({ id: 'g1', worldBounds: [0, 0, 40, 40], width: 40, height: 40 })
    // view A shows the left half [0..20], view B the right half [20..40], view C is off in a corner
    m.registerView('A', [0, 0, 20, 40])
    m.registerView('B', [20, 0, 40, 40])
    m.registerView('C', [0, 0, 4, 4])

    const fanouts: Record<string, unknown>[] = []
    const ctl = createSharedMaskController({
      mask: m,
      onFanout: targets => fanouts.push(Object.fromEntries(targets.map(t => [t.cellId, t.rect]))),
    })

    const before = Uint32Array.from(m.raster)
    // paint a disk at world (21,20) r=3 → straddles the seam at x=20, lands mostly in view B, edge of A
    ctl.brushWorld({ wx: 21, wy: 20, rWorld: 3, id: 5 })

    // exactly ONE raster mutated in place (same ref), some pixels now 5
    expect(m.raster.some(v => v === 5)).toBe(true)
    // fan-out delivered to A and B (both overlap the edit near the seam), NOT to C (disjoint corner)
    const fo = fanouts[0]
    expect(Object.keys(fo).sort()).toEqual(['A', 'B'])
    // C never uploads
    expect(fo['C']).toBeUndefined()

    // undo restores the ONE raster byte-for-byte (no divergent per-cell copy to reconcile)
    expect(ctl.undo()).toBe(true)
    expect(m.raster).toStrictEqual(before)
  })

  it('undo/redo is ONE stack on the shared mask even after a member view leaves', () => {
    const m = createSharedLabelMask({ id: 'g1', worldBounds: [0, 0, 40, 40], width: 40, height: 40 })
    m.registerView('A', null)
    m.registerView('B', null)
    const ctl = createSharedMaskController({ mask: m })
    ctl.brushWorld({ wx: 10, wy: 10, rWorld: 2, id: 3 })
    const afterEdit = Uint32Array.from(m.raster)
    expect(ctl.undo()).toBe(true)
    // a member leaves — the single stack is unaffected
    m.unregisterView('B')
    expect(ctl.redo()).toBe(true)
    expect(m.raster).toStrictEqual(afterEdit)
  })
})

// ── FIX_ROUND-1 (blind-audit HIGH/MED): composeSharedLabelMask correctness ───────────────────────
import { composeSharedLabelMask, SharedMaskTooLargeError, MAX_SHARED_RASTER_DIM, type SharedMaskMemberInput } from './sharedMask'

// two 2×2 members placed side-by-side in world X: A at [0,0,2,2], B at [2,0,4,2], each numbering ids from 1.
function member(cellId: string, worldRect: WorldRect, raster: number[], cats: number[] = []): SharedMaskMemberInput {
  return { cellId, worldRect, raster: Uint32Array.from(raster), width: 2, height: 2, categoryForId: Uint16Array.from(cats) }
}

describe('composeSharedLabelMask — id namespacing (blind-audit H2)', () => {
  it('distinct members reusing the same raw id do NOT alias into one object', () => {
    // both members have an object with raw id 1 filling their raster.
    const a = member('a', [0, 0, 2, 2], [1, 1, 1, 1], [0, 2]) // id1 → category 2
    const b = member('b', [2, 0, 4, 2], [1, 1, 1, 1], [0, 5]) // id1 → category 5
    const mask = composeSharedLabelMask('g', [a, b])
    // A's pixels keep id 1; B's id 1 is namespaced to a DISJOINT id (offset by A's maxId=1 ⇒ 2).
    const [ax] = mask.worldToPixel(1, 1) // a point inside member A
    const [bx] = mask.worldToPixel(3, 1) // a point inside member B
    const aId = mask.raster[Math.floor(mask.worldToPixel(1, 1)[1]) * mask.width + Math.floor(ax)]
    const bId = mask.raster[Math.floor(mask.worldToPixel(3, 1)[1]) * mask.width + Math.floor(bx)]
    expect(aId).not.toBe(bId) // the collision bug would make these equal
    expect(aId).toBeGreaterThan(0)
    expect(bId).toBeGreaterThan(0)
    // UNION LUT (not last-writer-wins): both members' categories survive at their namespaced ids.
    expect(mask.categoryForId[aId]).toBe(2)
    expect(mask.categoryForId[bId]).toBe(5)
  })
})

describe('composeSharedLabelMask — resolution-aware blit (blind-audit H3)', () => {
  it('a coarse member fills its whole world region (not squished into a corner)', () => {
    // fine member A (2×2 over world [0,0,2,2]) sets the finest density = 1px/world-unit.
    // coarse member B is 1×1 over world [2,0,4,2] (0.5px/world-unit) with a single object id 1.
    const a = member('a', [0, 0, 2, 2], [1, 1, 1, 1], [0, 3])
    const b: SharedMaskMemberInput = { cellId: 'b', worldRect: [2, 0, 4, 2], raster: Uint32Array.from([1]), width: 1, height: 1, categoryForId: Uint16Array.from([0, 7]) }
    const mask = composeSharedLabelMask('g', [a, b])
    // B spans world x∈[2,4] → shared pixels; EVERY shared pixel in B's region must carry B's object,
    // not just one corner pixel. Sample 4 points across B's world region.
    for (const [wx, wy] of [[2.5, 0.5], [3.5, 0.5], [2.5, 1.5], [3.5, 1.5]] as const) {
      const [px, py] = mask.worldToPixel(wx, wy)
      const v = mask.raster[Math.floor(py) * mask.width + Math.floor(px)]
      expect(v).toBeGreaterThan(0) // squish bug would leave most of B's region as 0
    }
  })
})

describe('composeSharedLabelMask — DEC-10 memory cap (blind-audit M2)', () => {
  it('refuses an over-cap raster with SharedMaskTooLargeError instead of allocating', () => {
    // A member with a TINY world footprint has a huge px/world density; over the group's union span
    // that drives the shared width past MAX_SHARED_RASTER_DIM ⇒ refuse (don't allocate/OOM).
    const dense: SharedMaskMemberInput = {
      cellId: 'd', worldRect: [0, 0, 0.0001, 0.0001], // 2px over 0.0001 world ⇒ 20000 px/world
      raster: Uint32Array.from([1, 1, 1, 1]), width: 2, height: 2, categoryForId: Uint16Array.from([0, 1]),
    }
    const wide: SharedMaskMemberInput = {
      cellId: 'w', worldRect: [0, 0, 2, 2], // union spanX ≈ 2 ⇒ shared width ≈ 2×20000 = 40000 > 16384
      raster: Uint32Array.from([1, 0, 0, 1]), width: 2, height: 2, categoryForId: Uint16Array.from([0, 1]),
    }
    expect(() => composeSharedLabelMask('g', [dense, wide])).toThrow(SharedMaskTooLargeError)
    expect(MAX_SHARED_RASTER_DIM).toBe(16384)
  })
})
