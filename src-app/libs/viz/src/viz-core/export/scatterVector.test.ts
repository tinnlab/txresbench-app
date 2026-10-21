// scatterVector.test.ts — the pure scatter→VectorCircle builder (true-vector scatter export core).

import { describe, it, expect } from 'vitest'
import { scatterToVectorScene, SCATTER_VECTOR_MAX, type ScatterVectorInput } from './scatterVector'
import type { VectorCircle } from './vector'

const circles = (ms: readonly unknown[]) => ms.filter((m): m is VectorCircle => (m as VectorCircle).type === 'circle')

// A centered, zoom-0 orthographic view: world (0,0) → screen center. Two points at the origin and one
// far off-screen so the cull path is exercised.
const base = (over: Partial<ScatterVectorInput> = {}): ScatterVectorInput => ({
  positions: new Float32Array([0, 0, 10, -10, 5000, 5000]),
  colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]),
  nPoints: 3,
  radius: 2,
  width: 400,
  height: 300,
  viewState: { target: [0, 0], zoom: 0 },
  ...over,
})

describe('scatterToVectorScene', () => {
  it('emits one circle per visible point, in the scene CSS-px size', () => {
    const scene = scatterToVectorScene(base())
    expect(scene).not.toBeNull()
    expect(scene!.width).toBe(400)
    expect(scene!.height).toBe(300)
    const cs = circles(scene!.marks)
    // point 3 is far off-screen (5000,5000) → culled; 2 remain.
    expect(cs.length).toBe(2)
  })

  it('projects the origin point to the viewport center (zoom 0)', () => {
    const scene = scatterToVectorScene(base())!
    const c0 = circles(scene.marks)[0]
    expect(c0.cx).toBeCloseTo(200, 0) // width/2
    expect(c0.cy).toBeCloseTo(150, 0) // height/2
  })

  it('encodes opaque points as #hex and translucent points as rgba()', () => {
    const cs = circles(scatterToVectorScene(base())!.marks)
    expect(cs[0].fill).toBe('#ff0000') // a=255
    expect(cs[1].fill).toBe('rgba(0,255,0,0.502)') // a=128 → 0.502
  })

  it('skips points masked out by the value-range visualMap (alpha 0)', () => {
    const inp = base({ colors: new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255]) })
    const cs = circles(scatterToVectorScene(inp)!.marks)
    // point 1 alpha 0 → skipped; point 2 visible; point 3 off-screen → 1 circle.
    expect(cs.length).toBe(1)
    expect(cs[0].fill).toBe('#00ff00')
  })

  it('clamps radius to deck ScatterplotLayer pixel bounds [1,8]', () => {
    expect(circles(scatterToVectorScene(base({ radius: 0.1 }))!.marks)[0].r).toBe(1)
    expect(circles(scatterToVectorScene(base({ radius: 99 }))!.marks)[0].r).toBe(8)
  })

  it('returns null (→ raster fallback) when empty, over the cap, or degenerate', () => {
    expect(scatterToVectorScene(base({ nPoints: 0 }))).toBeNull()
    expect(scatterToVectorScene(base({ nPoints: SCATTER_VECTOR_MAX + 1 }))).toBeNull()
    expect(scatterToVectorScene(base({ width: 0 }))).toBeNull()
  })
})
