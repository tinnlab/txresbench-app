// chartVector.test.ts — the generic chart-layer → VectorScene converter (chart vector export core).
// Fake deck-layer-shaped objects ({ props, constructor.layerName }) exercise each dispatch branch; the
// projection is deck's pure OrthographicView.makeViewport (zoom 0 ⇒ world (0,0) → viewport center).

import { describe, it, expect } from 'vitest'
import { chartLayersToVectorScene } from './chartVector'
import type { VectorCircle, VectorLine, VectorPolygon, VectorText, VectorMark } from './vector'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const layer = (layerName: string, props: Record<string, any>): any => ({ constructor: { layerName }, props })
const of = <T extends VectorMark>(ms: readonly VectorMark[], t: string) => ms.filter(m => m.type === t) as T[]
const base = { viewState: { target: [0, 0] as number[], zoom: 0 }, width: 200, height: 100, flipY: false }

describe('chartLayersToVectorScene', () => {
  it('LineLayer → VectorLine, projected to screen', () => {
    const l = layer('LineLayer', {
      data: [{ s: [0, 0], t: [0, 0] }],
      getSourcePosition: (d: { s: number[] }) => d.s,
      getTargetPosition: (d: { t: number[] }) => d.t,
      getColor: [255, 0, 0],
      getWidth: 2,
    })
    const scene = chartLayersToVectorScene({ ...base, layers: [l] })!
    const lines = of<VectorLine>(scene.marks, 'line')
    expect(lines).toHaveLength(1)
    expect(lines[0].x1).toBeCloseTo(100, 0) // width/2
    expect(lines[0].y1).toBeCloseTo(50, 0) // height/2
    expect(lines[0].stroke).toBe('#ff0000')
  })

  it('SolidPolygonLayer → VectorPolygon with fill', () => {
    const l = layer('SolidPolygonLayer', {
      data: [{ poly: [[0, 0], [1, 0], [1, 1]], fill: [0, 128, 0, 255] }],
      getPolygon: (d: { poly: number[][] }) => d.poly,
      getFillColor: (d: { fill: number[] }) => d.fill,
      filled: true,
    })
    const poly = of<VectorPolygon>(chartLayersToVectorScene({ ...base, layers: [l] })!.marks, 'polygon')
    expect(poly).toHaveLength(1)
    expect(poly[0].points).toHaveLength(3)
    expect(poly[0].fill).toBe('#008000')
  })

  it('ScatterplotLayer (binary) → one VectorCircle per point, alpha 0 skipped', () => {
    const l = layer('ScatterplotLayer', {
      data: {
        length: 2,
        attributes: {
          getPosition: { value: new Float32Array([0, 0, 10, 10]), size: 2 },
          getFillColor: { value: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]), size: 4, normalized: true },
        },
      },
      getRadius: 3,
      radiusMinPixels: 1,
      radiusMaxPixels: 8,
    })
    const cs = of<VectorCircle>(chartLayersToVectorScene({ ...base, layers: [l] })!.marks, 'circle')
    expect(cs).toHaveLength(1) // second point alpha 0 → skipped
    expect(cs[0].fill).toBe('#ff0000')
    expect(cs[0].r).toBe(3)
  })

  it('stroked ScatterplotLayer (box mean / hover ring) → circle keeps stroke; filled:false ⇒ hollow (MED-4)', () => {
    // A `stroked` + `filled:false` marker (the white box MEAN dot with a dark ring, or a hover ring):
    // must export its outline or it is invisible white-on-white.
    const l = layer('ScatterplotLayer', {
      data: [{ pos: [0, 0] }],
      getPosition: (d: { pos: number[] }) => d.pos,
      getRadius: 4,
      stroked: true,
      filled: false,
      getLineColor: [30, 30, 30, 255],
      getLineWidth: 2,
    })
    const cs = of<VectorCircle>(chartLayersToVectorScene({ ...base, layers: [l] })!.marks, 'circle')
    expect(cs).toHaveLength(1)
    expect(cs[0].fill).toBeUndefined() // hollow
    expect(cs[0].stroke).toBe('#1e1e1e')
    expect(cs[0].width).toBe(2)
  })

  it('windowed BitmapLayer (heatmap) → image mark CLIPPED to the visible plot region (MED-3)', () => {
    // Bounds span far past the plot on all sides (a zoomed-in heatmap): the projected full-matrix rect
    // must be clipped to the plot [0,0,200,100], and rasterize() called with exactly that clipped rect,
    // so the export is a 1:1 crop of what's on screen, not the whole matrix stretched across the plot.
    let called: [number, number, number, number] | null = null
    const l = layer('BitmapLayer', { image: {}, bounds: [-1000, -1000, 1000, 1000] })
    const scene = chartLayersToVectorScene({
      ...base,
      layers: [l],
      rasterize: (x, y, w, h) => { called = [x, y, w, h]; return 'data:image/png;base64,AA==' },
    })!
    const imgs = scene.marks.filter(m => m.type === 'image')
    expect(imgs).toHaveLength(1)
    expect(called).toEqual([0, 0, 200, 100]) // clipped to the plot rect, not the projected matrix
    const img = imgs[0] as Extract<VectorMark, { type: 'image' }>
    expect([img.x, img.y, img.w, img.h]).toEqual([0, 0, 200, 100])
  })

  it('TextLayer → VectorText with anchor + pixel offset', () => {
    const l = layer('TextLayer', {
      data: [{ p: [0, 0], txt: 'A' }],
      getPosition: (d: { p: number[] }) => d.p,
      getText: (d: { txt: string }) => d.txt,
      getSize: 11,
      getColor: [0, 0, 0],
      getTextAnchor: () => 'middle',
      getPixelOffset: () => [0, 4],
      getAlignmentBaseline: () => 'center',
    })
    const ts = of<VectorText>(chartLayersToVectorScene({ ...base, layers: [l] })!.marks, 'text')
    expect(ts).toHaveLength(1)
    expect(ts[0].text).toBe('A')
    expect(ts[0].anchor).toBe('middle')
    expect(ts[0].y).toBeCloseTo(50 + 4 + 11 * 0.32, 0) // center + pixelOffset + baseline shift
  })

  it('returns null when nothing converts / the viewport is degenerate', () => {
    expect(chartLayersToVectorScene({ ...base, layers: [] })).toBeNull()
    expect(chartLayersToVectorScene({ ...base, width: 0, layers: [layer('LineLayer', { data: [] })] })).toBeNull()
  })

  it('reserves a scene gutter via sceneWidth + offsetX', () => {
    const l = layer('ScatterplotLayer', {
      data: { length: 1, attributes: { getPosition: { value: new Float32Array([0, 0]), size: 2 }, getFillColor: { value: new Uint8Array([1, 2, 3, 255]), size: 4 } } },
      getRadius: 2,
    })
    const scene = chartLayersToVectorScene({ ...base, layers: [l], offsetX: 40, sceneWidth: 240 })!
    expect(scene.width).toBe(240)
    expect(of<VectorCircle>(scene.marks, 'circle')[0].cx).toBeCloseTo(140, 0) // 100 + offsetX
  })
})
