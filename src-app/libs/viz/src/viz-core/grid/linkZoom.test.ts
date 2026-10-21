import { describe, it, expect } from 'vitest'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  SHARED_GRID_SCOPE,
  clampZoom,
  clampViewState,
  applyViewStateChange,
  buildControlledViewStates,
  cameraSignature,
  type GridViewState,
} from './linkZoom'

const vs = (x: number, y: number, zoom: number): GridViewState => ({
  target: [x, y, 0],
  zoom,
})

describe('linkZoom — zoom clamp respects min/max', () => {
  it('clampZoom clamps below min and above max, passes through in-range', () => {
    expect(clampZoom(-99)).toBe(MIN_ZOOM)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
    expect(clampZoom(3)).toBe(3)
  })

  it('clampZoom clamps a per-axis [zx,zy] (chart) zoom component-wise, preserving the array shape', () => {
    expect(clampZoom([-99, 99])).toEqual([MIN_ZOOM, MAX_ZOOM])
    expect(clampZoom([3, -1])).toEqual([3, -1])
    expect(clampZoom([10, -3], 0, 5)).toEqual([5, 0])
    // NaN axis → min (matches the scalar contract)
    expect(clampZoom([Number.NaN, 2])).toEqual([MIN_ZOOM, 2])
  })

  it('clampZoom honors custom bounds', () => {
    expect(clampZoom(10, 0, 5)).toBe(5)
    expect(clampZoom(-3, 0, 5)).toBe(0)
  })

  it('clampZoom maps NaN to min', () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM)
  })

  it('clampViewState clamps zoom but preserves target', () => {
    const out = clampViewState(vs(4, 5, 999))
    expect(out.zoom).toBe(MAX_ZOOM)
    expect(out.target).toEqual([4, 5, 0])
  })
})

describe('linkZoom — applyViewStateChange (single space, regression)', () => {
  // All three cells in ONE coordinate space → behaves exactly as the pre-fix
  // "fan to all cells" path.
  const spaces = { a: 'S', b: 'S', c: 'S' }
  const initial: Record<string, GridViewState> = {
    a: vs(0, 0, 1),
    b: vs(0, 0, 1),
    c: vs(0, 0, 1),
  }

  it('when linked, a viewState change propagates to ALL same-space cells', () => {
    const changed = vs(10, 20, 5)
    const next = applyViewStateChange(initial, 'a', changed, spaces, true)
    for (const id of ['a', 'b', 'c']) {
      expect(next[id].zoom).toBe(5)
      expect(next[id].target).toEqual([10, 20, 0])
    }
    // Pure: original untouched.
    expect(initial.b.zoom).toBe(1)
  })

  it('when linked, the propagated state is zoom-clamped', () => {
    const next = applyViewStateChange(initial, 'a', vs(0, 0, 500), spaces, true)
    for (const id of ['a', 'b', 'c']) expect(next[id].zoom).toBe(MAX_ZOOM)
  })

  it('when unlinked, only the changed cell updates', () => {
    const changed = vs(10, 20, 7)
    const next = applyViewStateChange(initial, 'b', changed, spaces, false)
    expect(next.b.zoom).toBe(7)
    expect(next.b.target).toEqual([10, 20, 0])
    // Siblings unchanged.
    expect(next.a).toEqual(initial.a)
    expect(next.c).toEqual(initial.c)
  })

  it('when unlinked, the changed cell is still zoom-clamped', () => {
    const next = applyViewStateChange(initial, 'a', vs(0, 0, -50), spaces, false)
    expect(next.a.zoom).toBe(MIN_ZOOM)
    expect(next.b).toEqual(initial.b)
  })
})

describe('linkZoom — applyViewStateChange fans only WITHIN a coordinate space', () => {
  // Two scatters share the embedding space; one image cell is a distinct space.
  const spaces = { sA: 'embedding:primary', sB: 'embedding:primary', img: 'image:primary' }
  const initial: Record<string, GridViewState> = {
    sA: vs(0, 0, 1),
    sB: vs(0, 0, 1),
    img: vs(5, 5, 2),
  }

  it('linked: moving scatter A updates scatter B (same space), leaves the image untouched', () => {
    const changed = vs(10, 20, 6)
    const next = applyViewStateChange(initial, 'sA', changed, spaces, true)
    // Same-space scatters move together.
    expect(next.sA.target).toEqual([10, 20, 0])
    expect(next.sA.zoom).toBe(6)
    expect(next.sB.target).toEqual([10, 20, 0])
    expect(next.sB.zoom).toBe(6)
    // Different space → image is byte-identical to its prior state.
    expect(next.img).toEqual(initial.img)
  })

  it('linked: moving the image updates ONLY the image space, not the scatters', () => {
    const changed = vs(-3, -4, 8)
    const next = applyViewStateChange(initial, 'img', changed, spaces, true)
    expect(next.img.target).toEqual([-3, -4, 0])
    expect(next.img.zoom).toBe(8)
    // Scatters untouched.
    expect(next.sA).toEqual(initial.sA)
    expect(next.sB).toEqual(initial.sB)
  })

  it('unlinked: only the moved cell updates regardless of space', () => {
    const next = applyViewStateChange(initial, 'sA', vs(9, 9, 3), spaces, false)
    expect(next.sA.target).toEqual([9, 9, 0])
    expect(next.sB).toEqual(initial.sB)
    expect(next.img).toEqual(initial.img)
  })

  it('linked: a changed cell with no registered space still updates itself only', () => {
    const next = applyViewStateChange(initial, 'sA', vs(1, 1, 4), { sA: 'orphan', sB: 'other' }, true)
    expect(next.sA.target).toEqual([1, 1, 0])
    // sB is in a different space → untouched; img (not in the space map) → untouched.
    expect(next.sB).toEqual(initial.sB)
    expect(next.img).toEqual(initial.img)
  })
})

describe('linkZoom — buildControlledViewStates', () => {
  const fallback = vs(0, 0, 4)

  it('linked: each cell gets ITS SPACE’s shared state (scatters vs image are independent)', () => {
    const spaces = { sA: 'emb', sB: 'emb', img: 'img' }
    const sharedBySpace = { emb: vs(3, 3, 6), img: vs(9, 9, 2) }
    const out = buildControlledViewStates(spaces, {}, true, sharedBySpace, fallback)
    // Both scatters read the embedding space's shared state.
    expect(out.sA).toBe(sharedBySpace.emb)
    expect(out.sB).toBe(sharedBySpace.emb)
    // The image cell reads its OWN space's shared state — a DIFFERENT object.
    expect(out.img).toBe(sharedBySpace.img)
    expect(out.img).not.toBe(out.sA)
  })

  it('linked: a space with no stored shared state falls back to local then fallback', () => {
    const spaces = { sA: 'emb', img: 'img' }
    const sharedBySpace = { emb: vs(3, 3, 6) } // img space unset
    const states = { img: vs(7, 7, 5) }
    const out = buildControlledViewStates(spaces, states, true, sharedBySpace, fallback)
    expect(out.sA).toBe(sharedBySpace.emb)
    expect(out.img).toEqual(vs(7, 7, 5)) // local fallback for the unshared space
  })

  it('unlinked: per-cell (or fallback) state, ignoring shared/space', () => {
    const spaces = { a: 'emb', b: 'emb' }
    const states = { a: vs(1, 1, 2) }
    const out = buildControlledViewStates(spaces, states, false, { emb: vs(3, 3, 6) }, fallback)
    expect(out.a).toEqual(vs(1, 1, 2))
    expect(out.b).toBe(fallback) // no stored entry → fallback (NOT the shared state)
  })

  it('single space regression: every cell gets the one shared state when linked', () => {
    const spaces = { a: 'S', b: 'S' }
    const shared = vs(3, 3, 6)
    const out = buildControlledViewStates(spaces, {}, true, { S: shared }, fallback)
    expect(out.a).toBe(shared)
    expect(out.b).toBe(shared)
  })
})

describe('linkZoom — constants', () => {
  it('exports the base grid scope prefix', () => {
    expect(SHARED_GRID_SCOPE).toBe('grid')
    expect(MIN_ZOOM).toBeLessThan(MAX_ZOOM)
  })
})

// ── The CAMERA-COMMIT CHOKEPOINT's key (DEC-46) ───────────────────────────────────────────────────
// `GridDeckLayer` notifies `onCameraCommit` once per change of THIS signature, so what the signature
// does and does not distinguish IS the notification contract: a camera move must change it (or an
// open plot-data table lists a pre-move window), and a re-render that did not move the camera must
// NOT (the shell converts a notification into a re-render, so an over-sensitive key is a loop).
describe('linkZoom — cameraSignature (the camera-commit chokepoint key)', () => {
  it('changes when a target moves', () => {
    expect(cameraSignature({ a: vs(0, 0, 1) })).not.toBe(cameraSignature({ a: vs(1, 0, 1) }))
    expect(cameraSignature({ a: vs(0, 0, 1) })).not.toBe(cameraSignature({ a: vs(0, 1, 1) }))
  })

  it('changes when a zoom moves', () => {
    expect(cameraSignature({ a: vs(0, 0, 1) })).not.toBe(cameraSignature({ a: vs(0, 0, 2) }))
  })

  it('changes when a cell is added or removed', () => {
    expect(cameraSignature({ a: vs(0, 0, 1) })).not.toBe(
      cameraSignature({ a: vs(0, 0, 1), b: vs(0, 0, 1) }),
    )
  })

  it('is IDENTICAL for a re-minted map with equal values — a re-render is not a camera move', () => {
    // The map is a `useMemo` over inputs that include NON-camera values (the cell list, the link
    // toggle), so it re-mints without the camera having moved. An identity key would notify, the
    // shell would re-render, this component would re-mint the memo again → an unbounded loop.
    const a = { p0: vs(1, 2, 3), p1: vs(4, 5, 6) }
    const b = { p0: vs(1, 2, 3), p1: vs(4, 5, 6) }
    expect(a).not.toBe(b)
    expect(cameraSignature(a)).toBe(cameraSignature(b))
  })

  it('is INSENSITIVE to key insertion order', () => {
    expect(cameraSignature({ b: vs(1, 1, 1), a: vs(0, 0, 0) })).toBe(
      cameraSignature({ a: vs(0, 0, 0), b: vs(1, 1, 1) }),
    )
  })

  it('distinguishes a per-axis (migrated chart) zoom change', () => {
    const a = { c: { target: [0, 0, 0], zoom: [1, 2] as [number, number] } }
    const b = { c: { target: [0, 0, 0], zoom: [1, 3] as [number, number] } }
    expect(cameraSignature(a)).not.toBe(cameraSignature(b))
  })

  it('does not confuse two cells whose ids concatenate ambiguously', () => {
    // `a` at 1 + `b:2` must not read the same as `a:1` + `b` at 2 through the delimiter.
    expect(cameraSignature({ a: vs(1, 0, 0), b: vs(2, 0, 0) })).not.toBe(
      cameraSignature({ a: vs(2, 0, 0), b: vs(1, 0, 0) }),
    )
  })
})
