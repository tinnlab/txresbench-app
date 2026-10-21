// dataZoomRender.test.ts — the shared dataZoom rail geometry (drives on-screen canvas + export marks).
import { describe, it, expect } from 'vitest'
import { computeDataZoomLayout, dataZoomToMarks, composeDataZoomIntoScene, DATAZOOM_RAIL, type Box } from './dataZoomRender'
import type { VectorScene } from '../export/vector'

const hBox: Box = { x: 10, y: 100, w: 200, h: 16 }
const vBox: Box = { x: 100, y: 10, w: 16, h: 200 }

describe('computeDataZoomLayout — horizontal', () => {
  it('full window → band spans the whole track; handles at the ends', () => {
    const l = computeDataZoomLayout(hBox, [0, 1], 'horizontal')
    expect(l.band.x).toBeCloseTo(hBox.x, 3)
    expect(l.band.w).toBeCloseTo(hBox.w, 3)
    expect(l.handles[0].x + l.handles[0].w / 2).toBeCloseTo(hBox.x, 3) // lo at left
    expect(l.handles[1].x + l.handles[1].w / 2).toBeCloseTo(hBox.x + hBox.w, 3) // hi at right
  })
  it('a sub-window → band is a proportional slice starting at loFrac', () => {
    const l = computeDataZoomLayout(hBox, [0.25, 0.75], 'horizontal')
    expect(l.band.x).toBeCloseTo(hBox.x + 0.25 * hBox.w, 3)
    expect(l.band.w).toBeCloseTo(0.5 * hBox.w, 3)
  })
})

describe('computeDataZoomLayout — vertical (frac 0 = bottom, matching DragRail)', () => {
  it('the HI edge is above (smaller y) the LO edge', () => {
    const l = computeDataZoomLayout(vBox, [0.25, 0.75], 'vertical')
    // handles[0]=lo (bottom, larger y), handles[1]=hi (top, smaller y)
    expect(l.handles[1].y).toBeLessThan(l.handles[0].y)
    expect(l.band.y).toBeCloseTo(vBox.y + vBox.h * (1 - 0.75), 3) // top of band = hiFrac
    expect(l.band.h).toBeCloseTo(0.5 * vBox.h, 3)
  })
})

describe('computeDataZoomLayout — clamping + ordering', () => {
  it('clamps out-of-range + normalizes reversed windows', () => {
    const l = computeDataZoomLayout(hBox, [1.5, -0.5], 'horizontal')
    expect(l.band.x).toBeCloseTo(hBox.x, 3)
    expect(l.band.w).toBeCloseTo(hBox.w, 3)
  })
})

describe('dataZoomToMarks — export marks match the geometry', () => {
  it('emits a track rect + a band rect + 2 handle rects; offset by ox,oy', () => {
    const l = computeDataZoomLayout(hBox, [0.25, 0.75], 'horizontal')
    const marks = dataZoomToMarks(l, undefined, 5, 7)
    const rects = marks.filter(m => m.type === 'rect')
    expect(rects.length).toBe(4) // track + band + 2 handles
    // track is offset
    const track = rects[0] as { x: number; y: number }
    expect(track.x).toBeCloseTo(hBox.x + 5, 3)
    expect(track.y).toBeCloseTo(hBox.y + 7, 3)
  })

  // WYSIWYG guarantee: the export marks describe the SAME rects the on-screen canvas fills
  // (`drawDataZoomCanvas` fills layout.track/band/handles; `dataZoomToMarks` emits rects for the
  // identical boxes). At ox=oy=0 the mark rects are byte-equal to the layout boxes → screen==export.
  it('the export mark rects are byte-equal to the on-screen layout boxes (one geometry)', () => {
    for (const [win, orient] of [
      [[0.25, 0.75], 'horizontal'],
      [[0.1, 0.6], 'vertical'],
    ] as const) {
      const l = computeDataZoomLayout(orient === 'horizontal' ? hBox : vBox, win, orient)
      const rects = dataZoomToMarks(l).filter(m => m.type === 'rect') as { x: number; y: number; w: number; h: number }[]
      const boxes = [l.track, l.band, l.handles[0], l.handles[1]]
      rects.forEach((r, i) => {
        expect([r.x, r.y, r.w, r.h]).toEqual([boxes[i].x, boxes[i].y, boxes[i].w, boxes[i].h])
      })
    }
  })
})

describe('composeDataZoomIntoScene — append rail(s), grow the figure, WYSIWYG dpr scaling', () => {
  const scene = (): VectorScene => ({
    width: 600,
    height: 400,
    marks: [{ type: 'image', x: 0, y: 0, w: 600, h: 400, href: 'data:,' }],
  })
  const GAP = 4 // DATAZOOM_GAP

  it('returns the scene UNCHANGED (same ref) when neither axis is present', () => {
    const s = scene()
    expect(composeDataZoomIntoScene(s, {})).toBe(s)
  })

  it('x-only: grows HEIGHT by gap+rail, keeps width, rail spans the plot width', () => {
    const out = composeDataZoomIntoScene(scene(), { x: { window: [0.2, 0.8] } })
    expect(out.width).toBe(600)
    expect(out.height).toBe(400 + GAP + DATAZOOM_RAIL)
    // the appended track rect sits below the plot, spanning the original width.
    const track = out.marks.find(m => m.type === 'rect') as { x: number; y: number; w: number; h: number }
    expect(track.y).toBe(400 + GAP)
    expect(track.w).toBe(600)
    expect(track.h).toBe(DATAZOOM_RAIL)
  })

  it('y-only: grows WIDTH by gap+rail, keeps height, rail spans the plot height', () => {
    const out = composeDataZoomIntoScene(scene(), { y: { window: [0.2, 0.8] } })
    expect(out.width).toBe(600 + GAP + DATAZOOM_RAIL)
    expect(out.height).toBe(400)
    const track = out.marks.find(m => m.type === 'rect') as { x: number; y: number; w: number; h: number }
    expect(track.x).toBe(600 + GAP)
    expect(track.w).toBe(DATAZOOM_RAIL)
    expect(track.h).toBe(400)
  })

  it('both axes: grows width AND height; the x-rail spans the ORIGINAL plot width (not the grown one)', () => {
    const out = composeDataZoomIntoScene(scene(), { x: { window: [0.1, 0.9] }, y: { window: [0.1, 0.9] } })
    expect(out.width).toBe(600 + GAP + DATAZOOM_RAIL)
    expect(out.height).toBe(400 + GAP + DATAZOOM_RAIL)
    // x-rail track (appended after the y-rail's marks) still spans only 600 (under the plot).
    const tracks = out.marks.filter(m => m.type === 'rect') as { x: number; w: number; h: number }[]
    const xTrack = tracks.find(t => t.w === 600)
    expect(xTrack).toBeDefined()
  })

  it('appends immutably (does not mutate the input scene marks)', () => {
    const s = scene()
    const before = s.marks.length
    composeDataZoomIntoScene(s, { x: { window: [0.2, 0.8] } })
    expect(s.marks.length).toBe(before)
  })

  it('WYSIWYG on HiDPI: dpr=2 scales the rail/gap/handle so it stays proportional in the device-px scene', () => {
    const dpr = 2
    const out = composeDataZoomIntoScene(scene(), { x: { window: [0.2, 0.8] } }, undefined, dpr)
    // rail + gap grow by dpr → the figure grows by (GAP+RAIL)*dpr, not the raw CSS px.
    expect(out.height).toBe(400 + (GAP + DATAZOOM_RAIL) * dpr)
    const track = out.marks.find(m => m.type === 'rect') as { y: number; h: number }
    expect(track.y).toBe(400 + GAP * dpr)
    expect(track.h).toBe(DATAZOOM_RAIL * dpr)
    // the handle scales in EVERY dimension: thickness (HANDLE_T=8→16), overhang (over=1→2 so
    // h = rail + 2*over = 32+4 = 36), and border stroke width (1→2). A miss on any would break WYSIWYG.
    const handle = out.marks[out.marks.length - 1] as { w: number; h: number; width: number }
    expect(handle.w).toBe(8 * dpr) // horizontal handle thickness
    expect(handle.h).toBe(DATAZOOM_RAIL * dpr + 2 * dpr) // rail height + 2×overhang
    expect(handle.width).toBe(dpr) // border stroke scaled to device px
  })

  it('dpr=1 is byte-identical to the no-dpr call (default)', () => {
    const a = composeDataZoomIntoScene(scene(), { x: { window: [0.3, 0.7] }, y: { window: [0.1, 0.5] } })
    const b = composeDataZoomIntoScene(scene(), { x: { window: [0.3, 0.7] }, y: { window: [0.1, 0.5] } }, undefined, 1)
    expect(b).toEqual(a)
  })
})
