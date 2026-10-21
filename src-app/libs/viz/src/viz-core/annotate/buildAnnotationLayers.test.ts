// buildAnnotationLayers.test.ts — perf-contract proof for the annotation overlay builder:
//  • when a `viewport` is supplied, the flatbush cull returns ONLY the in-view committed
//    features (the fill layer's `data` has just the visible polygons);
//  • the spatial index + partition are built ONCE per collection identity — two builds over the
//    SAME collection+viewport hand back the SAME (reference-identical) static-tier `data` arrays,
//    and a mere SELECTION change does NOT reallocate them (no static-tier re-tessellation).
// Node vitest, mirroring `annotationGestures.test.ts`.

import { describe, it, expect } from 'vitest'
import { buildAnnotationLayers, type AnnotationViewport } from './buildAnnotationLayers'
import type { Annotation, AnnotationCollection, PolygonGeometry } from './annotateModel'

// A 2×2 axis-aligned square polygon whose corner is at (ox,oy).
const squareAt = (id: string, ox: number, oy: number): Annotation => ({
  id,
  geometry: {
    kind: 'polygon',
    rings: [new Float64Array([ox, oy, ox + 2, oy, ox + 2, oy + 2, ox, oy + 2])],
  } as PolygonGeometry,
  classId: null,
  label: null,
})

// Three squares far apart: A near origin, B at ~100, C at ~1000.
function collection(): AnnotationCollection {
  const a = squareAt('a', 0, 0)
  const b = squareAt('b', 100, 100)
  const c = squareAt('c', 1000, 1000)
  return { byId: { a, b, c }, ids: ['a', 'b', 'c'] }
}

/** The fill layer's `data` (the committed polygon array), or `undefined` if no fill layer. */
function fillData(layers: ReturnType<typeof buildAnnotationLayers>): Annotation[] | undefined {
  const fill = layers.find(l => String(l.id).endsWith('annot-fill'))
  return fill?.props.data as Annotation[] | undefined
}

describe('buildAnnotationLayers viewport cull', () => {
  it('returns ONLY in-view features when a viewport is passed', () => {
    const col = collection()
    // A window around origin that covers only square A (0..2), not B (100) or C (1000).
    const viewport: AnnotationViewport = { bounds: [-10, -10, 10, 10] }
    const data = fillData(buildAnnotationLayers({ collection: col, viewport, cellId: 'cell1' }))
    expect(data?.map(a => a.id)).toEqual(['a'])
  })

  it('draws EVERYTHING when no viewport is passed', () => {
    const col = collection()
    const data = fillData(buildAnnotationLayers({ collection: col, viewport: null, cellId: 'cell1' }))
    expect(data?.map(a => a.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('culls to the window that spans two features', () => {
    const col = collection()
    const viewport: AnnotationViewport = { bounds: [-10, -10, 110, 110] } // covers A and B, not C
    const data = fillData(buildAnnotationLayers({ collection: col, viewport, cellId: 'cell1' }))
    expect(data?.map(a => a.id).sort()).toEqual(['a', 'b'])
  })
})

describe('buildAnnotationLayers memoization (index + partition built once)', () => {
  it('reuses the SAME static-tier data array for a repeated build (same collection+viewport)', () => {
    const col = collection()
    const viewport: AnnotationViewport = { bounds: [-2000, -2000, 2000, 2000] }
    const first = fillData(buildAnnotationLayers({ collection: col, viewport, cellId: 'cell1' }))
    const second = fillData(buildAnnotationLayers({ collection: col, viewport, cellId: 'cell1' }))
    expect(first).toBeDefined()
    expect(second).toBe(first) // reference identity ⇒ index + partition were NOT rebuilt
  })

  it('does NOT reallocate the static-tier data on a mere selection change', () => {
    const col = collection()
    const viewport: AnnotationViewport = { bounds: [-2000, -2000, 2000, 2000] }
    const unselected = fillData(buildAnnotationLayers({ collection: col, viewport, cellId: 'cell1' }))
    const selected = fillData(
      buildAnnotationLayers({ collection: col, viewport, selection: new Set(['b']), cellId: 'cell1' }),
    )
    expect(selected).toBe(unselected) // selection drives an accessor/updateTrigger, not a rebuild
  })

  it('rebuilds the partition when the collection identity changes (new byId)', () => {
    const first = fillData(
      buildAnnotationLayers({ collection: collection(), viewport: null, cellId: 'cell1' }),
    )
    const second = fillData(
      buildAnnotationLayers({ collection: collection(), viewport: null, cellId: 'cell1' }),
    )
    // Different `byId` objects ⇒ different cache entries ⇒ different arrays (same contents).
    expect(second).not.toBe(first)
    expect(second?.map(a => a.id).sort()).toEqual(['a', 'b', 'c'])
  })
})

// ── ROOT 3 · legible in-progress state (INV-15) ─────────────────────────────────────────────
//
// These are the PERCEPTUAL tests the prior suites lacked entirely. Every earlier test asserted
// COMMITTED state, which is precisely why the two defects below shipped through a green suite:
// a user could not tell a draft vertex from a committed point, and the draft never moved between
// clicks. Asserting rendered ATTRIBUTES (fill/colour/trigger), not just geometry, is what makes
// a regression here fail a test instead of an owner's eyes.

describe('ROOT 3 — draft vs committed, and the rubber band', () => {
  const cellId = 'c1'
  /** a collection holding exactly one COMMITTED point. */
  function committedPoint(): AnnotationCollection {
    const a: Annotation = {
      id: 'p1',
      geometry: { kind: 'point', xy: [10, 20] },
      classId: null,
      label: null,
    }
    return { byId: { p1: a }, ids: ['p1'] }
  }
  const pick = (layers: readonly { id: string }[], suffix: string) =>
    layers.find(l => l.id.endsWith(suffix)) as
      | (({ id: string }) & { props: Record<string, unknown> })
      | undefined

  it('TEST-14: a draft vertex differs from a committed point in FILL and COLOUR, not radius alone', () => {
    const layers = buildAnnotationLayers({
      collection: committedPoint(),
      editDraft: { draftPath: [[0, 0], [5, 0], [5, 5]] },
      cellId,
    })
    const point = pick(layers, 'annot-point')
    const draft = pick(layers, 'annot-draft-verts')
    expect(point).toBeDefined()
    expect(draft).toBeDefined()

    // FILL channel: committed is solid, draft is hollow. (`filled` defaults to true.)
    expect(draft!.props.filled).toBe(false)
    expect(point!.props.filled ?? true).toBe(true)

    // HUE channel: the draft's stroke is the amber draft colour; the committed point is blue.
    const draftColor = draft!.props.getLineColor as number[]
    const pointColor = point!.props.getFillColor as number[]
    expect(draftColor.slice(0, 3)).not.toEqual(pointColor.slice(0, 3))
    // and specifically: red/green dominant (amber) vs blue-dominant.
    expect(draftColor[2]).toBeLessThan(draftColor[0])
    expect(pointColor[2]).toBeGreaterThan(pointColor[0])

    // The distinction must NOT rest on radius: even if the radii were equalised the two above
    // channels still separate them. Guard that the test would fail on a radius-only difference.
    const radiusOnly =
      draftColor.slice(0, 3).join() === pointColor.slice(0, 3).join() &&
      draft!.props.filled !== false
    expect(radiusOnly).toBe(false)
  })

  it('TEST-15: a cursor-only move changes the draft trigger but NOT the committed data identity', () => {
    const collection = committedPoint()
    const draftPath: [number, number][] = [[0, 0], [5, 0], [5, 5]]
    const a = buildAnnotationLayers({
      collection,
      editDraft: { draftPath, cursor: [9, 9] },
      cellId,
    })
    const b = buildAnnotationLayers({
      collection,
      editDraft: { draftPath, cursor: [40, 40] }, // ONLY the cursor moved; vertex count constant
      cellId,
    })

    const trg = (l: { props: Record<string, unknown> }) =>
      (l.props.updateTriggers as { getPath: unknown[] }).getPath
    // The old trigger was [draftPath, draftPath.length] — both invariant here, so redraw-on-move
    // was structurally impossible. It must now differ.
    expect(trg(pick(a, 'annot-draft-path')!)).not.toEqual(trg(pick(b, 'annot-draft-path')!))

    // DRIFT-3.1: the draft is now ONE open `PathLayer` polyline over FLAT `[x0,y0,…]` coords —
    // it was N `LineLayer` segments only to dodge the non-painting `PathLayer`.
    const pathB = (pick(b, 'annot-draft-path')!.props.data as Float64Array[])[0]
    // The stroked band must actually reach the new cursor: the LAST point IS the cursor.
    expect([pathB[pathB.length - 2], pathB[pathB.length - 1]]).toEqual([40, 40])
    // n vertices + a cursor ⇒ n+1 points (the vertices, plus the rubber-band end).
    expect(pathB.length / 2).toBe(draftPath.length + 1)

    // …while the COMMITTED tier is untouched: a mouse move must not re-upload committed geometry.
    expect(pick(a, 'annot-point')!.props.data).toBe(pick(b, 'annot-point')!.props.data)
  })

  it('TEST-15b: with no cursor the draft is stroked through its vertices only (no phantom segment)', () => {
    const layers = buildAnnotationLayers({
      collection: committedPoint(),
      editDraft: { draftPath: [[0, 0], [5, 0], [5, 5]], cursor: null },
      cellId,
    })
    const path = (pick(layers, 'annot-draft-path')!.props.data as Float64Array[])[0]
    // 3 vertices, no cursor ⇒ 3 points and no trailing rubber band
    expect(path.length / 2).toBe(3)
    expect([path[path.length - 2], path[path.length - 1]]).toEqual([5, 5])
  })

  it('TEST-15c: the close target appears only once the ring is closable', () => {
    const open = buildAnnotationLayers({
      collection: committedPoint(),
      editDraft: { draftPath: [[0, 0], [5, 0]], closable: false },
      cellId,
    })
    expect(pick(open, 'annot-draft-close')).toBeUndefined()

    const closable = buildAnnotationLayers({
      collection: committedPoint(),
      editDraft: { draftPath: [[0, 0], [5, 0], [5, 5]], closable: true },
      cellId,
    })
    const target = pick(closable, 'annot-draft-close')
    expect(target).toBeDefined()
    // it marks the FIRST vertex and is larger than an ordinary draft vertex
    expect((target!.props.data as number[][])[0]).toEqual([0, 0])
    expect(target!.props.getRadius as number).toBeGreaterThan(
      pick(closable, 'annot-draft-verts')!.props.getRadius as number,
    )
  })
})

// ── DRIFT-3.1: the PATH-LAYER DATA CONTRACT ────────────────────────────────────────────────
//
// `_pathType` does NOT merely mean "close the ring" — it sets `normalize:false` on deck's
// PathTesselator, which then assumes each path is a FLAT coordinate array measured as
// `path.length / positionSize`. Nested `[[x,y],…]` + `_pathType` ⇒ a 4-point ring measures as
// 4/3 = 1.33 points ⇒ `getGeometrySize` returns 0 ⇒ the layer tesselates to ZERO vertices and
// paints NOTHING, at any width or colour. That silently killed `annot-outline`, `annot-path`
// and `annot-edit-edges` for the whole life of the surface.
//
// These are PROP-level guards on the invariant `_pathType ⇒ flat coords ⇒ positionFormat:'XY'`.
// They cannot prove pixels reach the screen — the tests above were all green while nothing drew
// — so the real gate is `tests/e2e/annotate-outline-pixels.e2e.mjs`. Keep BOTH.
describe('buildAnnotationLayers PathLayer data contract (DRIFT-3.1)', () => {
  const cellId = 'cell-1'
  /** every layer that declares `_pathType` (the no-normalization PathLayers). */
  const pathTypeLayers = (layers: ReturnType<typeof buildAnnotationLayers>) =>
    layers.filter(l => (l.props as { _pathType?: string })._pathType != null)

  const scene = () =>
    buildAnnotationLayers({
      collection: collection(),
      selection: ['a'], // selects a committed feature ⇒ the edit-edges tier is built too
      editDraft: { draftPath: [[0, 0], [5, 0], [5, 5]], cursor: [7, 7] },
      cellId,
    })

  it('every `_pathType` layer also declares positionFormat XY and yields FLAT coords', () => {
    const layers = pathTypeLayers(scene())
    // outline + edit-edges + draft-path at minimum
    expect(layers.length).toBeGreaterThanOrEqual(3)
    for (const layer of layers) {
      const props = layer.props as {
        _pathType?: string
        positionFormat?: string
        data: unknown
        getPath?: (d: unknown, ctx?: unknown) => unknown
      }
      expect(
        props.positionFormat,
        `${String(layer.id)} sets _pathType but not positionFormat:'XY' — its paths would be ` +
          `measured as length/3 and tesselate to nothing`,
      ).toBe('XY')

      const rows = props.data as unknown[]
      expect(Array.isArray(rows) && rows.length > 0).toBe(true)
      const path = props.getPath!(rows[0], { index: 0, data: rows, target: [] })
      // FLAT typed array, not a nested [[x,y],…] array — the whole point of the contract.
      expect(
        ArrayBuffer.isView(path),
        `${String(layer.id)} getPath returned a nested array; with _pathType this tesselates ` +
          `to zero vertices (DRIFT-3.1)`,
      ).toBe(true)
      const flat = path as Float64Array
      expect(flat.length % 2).toBe(0)
      expect(flat.length / 2).toBeGreaterThanOrEqual(2) // ≥2 points, or deck draws nothing
    }
  })

  it("closes rings explicitly for `_pathType:'loop'` (no spurious diagonal)", () => {
    // deck emits numPoints+2 vertices for a loop and wraps the trailing two via
    // `index + 1 - numPoints`, which lands on p1,p2 — correct ONLY if p_last duplicates p0.
    // An OPEN ring therefore renders a stray p3→p1 segment: a diagonal across the polygon.
    const loops = pathTypeLayers(scene()).filter(
      l => (l.props as { _pathType?: string })._pathType === 'loop',
    )
    expect(loops.length).toBeGreaterThan(0)
    for (const layer of loops) {
      // `as unknown as` — deck's `StatefulComponentProps<Required<LayerProps>>` does not structurally
      // overlap this narrowed accessor shape, so the direct cast is a TS2352 under `tsc --noEmit`.
      const props = layer.props as unknown as { data: unknown[]; getPath: (d: unknown, c?: unknown) => unknown }
      const ring = props.getPath(props.data[0], {
        index: 0,
        data: props.data,
        target: [],
      }) as Float64Array
      const n = ring.length
      expect(
        [ring[n - 2], ring[n - 1]],
        `${String(layer.id)} ring is not explicitly closed`,
      ).toEqual([ring[0], ring[1]])
    }
  })

  it('leaves the model rings themselves untouched (closure is render-only)', () => {
    const col = collection()
    const before = Array.from((col.byId.a.geometry as PolygonGeometry).rings[0])
    buildAnnotationLayers({ collection: col, selection: ['a'], cellId })
    expect(Array.from((col.byId.a.geometry as PolygonGeometry).rings[0])).toEqual(before)
  })
})
