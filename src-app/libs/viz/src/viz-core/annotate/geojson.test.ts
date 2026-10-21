// geojson.test.ts — TEST-A7 acceptance for GeoJSON import/export (ITEM-7, INV-7).
// A QuPath-authored FeatureCollection (polygon-with-hole, multipolygon, point,
// classified, + a FOREIGN `measurements` property) → import → EDIT → export →
// re-import yields vertex-exact geometry, identical class name+colour, id, isLocked,
// and foreign props (deep-equal). Export normalizes winding while staying geometrically
// equivalent; the whole loop is idempotent.

import { describe, it, expect } from 'vitest'
import {
  importGeoJson,
  exportGeoJson,
  type GeoJsonFeatureCollection,
} from './geojson'
import type { Annotation, PolygonGeometry } from './annotateModel'
import { createImageCoordinateSystem } from './coords'
import type { NormalizedImageMeta } from '../spatial/imageMeta'

// ── the QuPath-authored fixture (coords = full-res pixels; RFC-normalized winding) ──
// poly-1  : polygon WITH a hole; class Tumor [255,0,0]; name; isLocked; FOREIGN measurements
// mpoly-1 : a two-part MultiPolygon; no class
// pt-1    : a classified Point (class Cell [0,128,255])
// path-1  : an open LineString
const FIXTURE: GeoJsonFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'poly-1',
      geometry: {
        type: 'Polygon',
        coordinates: [
          // exterior — CCW (right-hand rule)
          [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
          // hole — CW
          [[25, 25], [25, 75], [75, 75], [75, 25], [25, 25]],
        ],
      },
      properties: {
        objectType: 'annotation',
        name: 'Region A',
        classification: { name: 'Tumor', color: [255, 0, 0] },
        isLocked: true,
        // FOREIGN, unmodeled — must survive verbatim (deep-equal):
        measurements: [
          { name: 'Area µm^2', value: 12345.6 },
          { name: 'Circularity', value: 0.87 },
        ],
      },
    },
    {
      type: 'Feature',
      id: 'mpoly-1',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[200, 200], [300, 200], [300, 300], [200, 300], [200, 200]]],
          [[[400, 400], [500, 400], [500, 500], [400, 500], [400, 400]]],
        ],
      },
      properties: { objectType: 'annotation' },
    },
    {
      type: 'Feature',
      id: 'pt-1',
      geometry: { type: 'Point', coordinates: [640, 480] },
      properties: {
        objectType: 'detection',
        name: 'Cell 1',
        classification: { name: 'Cell', color: [0, 128, 255] },
      },
    },
    {
      type: 'Feature',
      id: 'path-1',
      geometry: { type: 'LineString', coordinates: [[10, 10], [20, 15], [30, 5]] },
      properties: { objectType: 'annotation' },
    },
  ],
}

function feat(fc: GeoJsonFeatureCollection, id: string) {
  const f = fc.features.find(x => x.id === id)
  if (!f) throw new Error(`no feature ${id}`)
  return f
}

describe('geojson import — model mapping (TEST-A7)', () => {
  it('maps QuPath properties → class registry + model fields', () => {
    const { annotations, classes } = importGeoJson(FIXTURE)
    // 4 features → 5 annotations (the 2-part MultiPolygon splits into 2)
    expect(annotations.length).toBe(5)

    const tumor = classes.find(c => c.name === 'Tumor')
    const cell = classes.find(c => c.name === 'Cell')
    expect(tumor?.color).toEqual([255, 0, 0])
    expect(cell?.color).toEqual([0, 128, 255])

    const poly = annotations.find(a => a.id === 'poly-1')!
    expect(poly.classId).toBe('Tumor')
    expect(poly.label).toBe('Region A')
    expect(poly.locked).toBe(true)
    // foreign measurements land in the passthrough bag verbatim; modeled keys removed
    expect(poly.properties).toEqual({
      objectType: 'annotation',
      measurements: FIXTURE.features[0].properties.measurements,
    })
    // polygon stored open (closing duplicate dropped), exterior + hole
    const g = poly.geometry as PolygonGeometry
    expect(g.rings.length).toBe(2)
    expect(Array.from(g.rings[0])).toEqual([0, 0, 100, 0, 100, 100, 0, 100])
  })
})

describe('geojson round-trip — import → edit → export → re-import (TEST-A7)', () => {
  it('is vertex-exact + class/id/lock/foreign-prop lossless (deep-equal, idempotent)', () => {
    const { annotations, classes } = importGeoJson(FIXTURE)

    // EDIT: reshape poly-1's exterior first vertex, and ADD a new (classless) point.
    const edited: Annotation[] = annotations.map(a => {
      if (a.id !== 'poly-1') return a
      const g = a.geometry as PolygonGeometry
      const ext = Float64Array.from(g.rings[0])
      ext[0] = 1 // (0,0) → (1,1) — stays CCW/valid
      ext[1] = 1
      return { ...a, geometry: { kind: 'polygon', rings: [ext, g.rings[1]] } }
    })
    edited.push({
      id: 'new-pt',
      geometry: { kind: 'point', xy: [12, 34] },
      classId: null,
      label: null,
      properties: {},
    })

    const exp1 = exportGeoJson(edited, classes)
    const reimported = importGeoJson(exp1)
    const exp2 = exportGeoJson(reimported.annotations, reimported.classes)

    // full round-trip: export(import(export(edited))) === export(edited)
    expect(exp2).toEqual(exp1)

    // ── targeted preservation on exp1 ──
    const p1 = feat(exp1, 'poly-1')
    expect(p1.properties.classification).toEqual({ name: 'Tumor', color: [255, 0, 0] })
    expect(p1.properties.isLocked).toBe(true)
    expect(p1.properties.name).toBe('Region A')
    expect(p1.properties.objectType).toBe('annotation')
    // FOREIGN measurements preserved deep-equal
    expect(p1.properties.measurements).toEqual(FIXTURE.features[0].properties.measurements)
    // vertex-exact (edited exterior; hole unchanged; closed + normalized winding)
    expect(p1.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [[1, 1], [100, 0], [100, 100], [0, 100], [1, 1]],
        [[25, 25], [25, 75], [75, 75], [75, 25], [25, 25]],
      ],
    })

    // MultiPolygon recombined vertex-exact (2 parts, id preserved)
    expect(feat(exp1, 'mpoly-1').geometry).toEqual(FIXTURE.features[1].geometry)
    expect(feat(exp1, 'mpoly-1').properties.objectType).toBe('annotation')

    // classified point round-trips id + class
    const pt = feat(exp1, 'pt-1')
    expect(pt.geometry).toEqual({ type: 'Point', coordinates: [640, 480] })
    expect(pt.properties.classification).toEqual({ name: 'Cell', color: [0, 128, 255] })

    // the open path round-trips exactly
    expect(feat(exp1, 'path-1').geometry).toEqual({
      type: 'LineString',
      coordinates: [[10, 10], [20, 15], [30, 5]],
    })

    // the added annotation survives the loop
    expect(feat(exp1, 'new-pt').geometry).toEqual({ type: 'Point', coordinates: [12, 34] })
  })

  it('normalizes reversed winding on export while staying geometrically equivalent', () => {
    // author the SAME square but with a CW exterior (wrong winding) — import is permissive
    const cw: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'w',
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [0, 100], [100, 100], [100, 0], [0, 0]]], // CW
          },
          properties: {},
        },
      ],
    }
    const { annotations, classes } = importGeoJson(cw)
    const out = exportGeoJson(annotations, classes)
    // export forces the exterior to CCW (RFC right-hand rule) by reversing the ring —
    // a different start vertex but the SAME geometry, now with positive signed area.
    const ring = (out.features[0].geometry as { coordinates: number[][][] }).coordinates[0]
    expect(ring).toEqual([[100, 0], [100, 100], [0, 100], [0, 0], [100, 0]])
    // signed area is now positive (CCW) and it round-trips the same 100×100 square
    const back = importGeoJson(out)
    expect(exportGeoJson(back.annotations, back.classes)).toEqual(out)
  })
})

describe('geojson coords facade — physical-space CRS round-trip (TEST-A7)', () => {
  const META: NormalizedImageMeta = {
    levels: [{ path: '0', width: 1000, height: 800, scale: [0.5, 0.5], translation: [0, 0], downsample: 1 }],
    channels: [{ name: 'C0' }],
    dtype: 'Uint16',
    axisIndex: { y: 0, x: 1 },
  }

  it('exports to physical microns via the facade and re-imports back to full-res', () => {
    const coords = createImageCoordinateSystem(META)
    const { annotations, classes } = importGeoJson(FIXTURE)

    const physical = exportGeoJson(annotations, classes, { space: 'physical', coords })
    expect(physical['ziee:crs']).toBe('physical')
    // pt-1 full-res (640,480) → physical (0.5·x, 0.5·y) = (320,240)
    expect(feat(physical, 'pt-1').geometry).toEqual({ type: 'Point', coordinates: [320, 240] })

    // re-import declaring the physical CRS → back to canonical full-res, vertex-exact
    const back = importGeoJson(physical, { space: 'physical', coords })
    const rt = exportGeoJson(back.annotations, back.classes)
    expect(feat(rt, 'pt-1').geometry).toEqual({ type: 'Point', coordinates: [640, 480] })
  })

  it('throws when a non-fullRes space is used without a coords facade', () => {
    const { annotations, classes } = importGeoJson(FIXTURE)
    expect(() => exportGeoJson(annotations, classes, { space: 'physical' })).toThrow(/coords facade/)
  })
})

describe('geojson multi-geometry robustness (audit findings 1 & 2)', () => {
  it('a SINGLE-part MultiPolygon round-trips back to MultiPolygon, not Polygon', () => {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'mp-solo',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]], // ONE polygon part
          },
          properties: { objectType: 'annotation' },
        },
      ],
    }
    const { annotations, classes } = importGeoJson(fc)
    expect(annotations.length).toBe(1) // one part → one annotation
    const out = exportGeoJson(annotations, classes)
    // The lone part must re-export as a Multi (geometry type preserved), NOT collapse to Polygon.
    expect(out.features[0].geometry.type).toBe('MultiPolygon')
    expect(out.features[0].id).toBe('mp-solo')
    // idempotent + geometry-exact
    const back = importGeoJson(out)
    expect(exportGeoJson(back.annotations, back.classes)).toEqual(out)
    expect(feat(out, 'mp-solo').geometry).toEqual(fc.features[0].geometry)
  })

  it('single-part MultiPoint and MultiLineString also round-trip as Multi', () => {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'mpt', geometry: { type: 'MultiPoint', coordinates: [[5, 6]] }, properties: {} },
        {
          type: 'Feature',
          id: 'mls',
          geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 2], [3, 4]]] },
          properties: {},
        },
      ],
    }
    const { annotations, classes } = importGeoJson(fc)
    const out = exportGeoJson(annotations, classes)
    expect(feat(out, 'mpt').geometry.type).toBe('MultiPoint')
    expect(feat(out, 'mls').geometry.type).toBe('MultiLineString')
    expect(feat(out, 'mpt').geometry).toEqual(fc.features[0].geometry)
    expect(feat(out, 'mls').geometry).toEqual(fc.features[1].geometry)
  })

  it('a foreign Feature id literally containing "::part<n>" is NOT corrupted on export', () => {
    const weirdId = 'cell::part3::of::9' // a real id that collides with the old suffix scheme
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: weirdId,
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] },
          properties: { objectType: 'annotation' },
        },
      ],
    }
    const { annotations, classes } = importGeoJson(fc)
    expect(annotations.length).toBe(1)
    const out = exportGeoJson(annotations, classes)
    // id survives verbatim (not truncated at "::part") and stays a Polygon (not mis-grouped).
    expect(out.features.length).toBe(1)
    expect(out.features[0].id).toBe(weirdId)
    expect(out.features[0].geometry.type).toBe('Polygon')
    // idempotent
    const back = importGeoJson(out)
    expect(exportGeoJson(back.annotations, back.classes)).toEqual(out)
  })

  it('two distinct foreign "::part" ids do NOT collapse into one Feature', () => {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'shape::part0', geometry: { type: 'Point', coordinates: [1, 1] }, properties: {} },
        { type: 'Feature', id: 'shape::part1', geometry: { type: 'Point', coordinates: [2, 2] }, properties: {} },
      ],
    }
    const { annotations, classes } = importGeoJson(fc)
    const out = exportGeoJson(annotations, classes)
    // Old id-suffix grouping would strip both to base "shape" and merge them; they must stay 2.
    expect(out.features.length).toBe(2)
    expect(out.features.map(f => f.id).sort()).toEqual(['shape::part0', 'shape::part1'])
    expect(out.features.every(f => f.geometry.type === 'Point')).toBe(true)
  })

  it('a FOREIGN forged "ziee:geojson" property does NOT hijack the export (NF-5)', () => {
    // A crafted input Feature carries a property shaped like the module's reserved out-of-band
    // meta key — trying to override the exported id (to a different value), force `multi`, and
    // pin a bogus part index. It MUST be ignored: the reserved key is stripped on import, never
    // trusted from foreign input, so id/geometry-type/props are driven only by the real Feature.
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'real-1',
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] },
          properties: {
            objectType: 'annotation',
            // FORGED: mimics the reserved GEOJSON_META_KEY = 'ziee:geojson'
            'ziee:geojson': { id: 'HIJACKED', multi: true, part: 7 },
          },
        },
      ],
    }
    const { annotations, classes } = importGeoJson(fc)
    expect(annotations.length).toBe(1)
    // The forged meta never reached the model's passthrough bag (stripped on import).
    expect(annotations[0].properties?.['ziee:geojson']).toBeUndefined()
    // A legit foreign prop still survives.
    expect(annotations[0].properties?.objectType).toBe('annotation')

    const out = exportGeoJson(annotations, classes)
    expect(out.features.length).toBe(1)
    const f = out.features[0]
    // id is the REAL Feature id, not the forged 'HIJACKED'.
    expect(f.id).toBe('real-1')
    // geometry stays its declared type — the forged `multi:true` did NOT promote it to MultiPolygon.
    expect(f.geometry.type).toBe('Polygon')
    // the forged reserved key does not reappear / corrupt the exported properties.
    expect(f.properties['ziee:geojson']).toBeUndefined()
    expect(f.properties.objectType).toBe('annotation')
    // and the whole loop stays idempotent.
    const back = importGeoJson(out)
    expect(exportGeoJson(back.annotations, back.classes)).toEqual(out)
  })

  it('a NUMERIC RFC 7946 Feature id round-trips as a number (not coerced to string)', () => {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 42, geometry: { type: 'Point', coordinates: [7, 8] }, properties: {} },
        {
          type: 'Feature',
          id: 7,
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]],
          },
          properties: {},
        },
      ],
    }
    const { annotations, classes } = importGeoJson(fc)
    const out = exportGeoJson(annotations, classes)
    const numPt = out.features.find(f => f.id === 42)
    const numMp = out.features.find(f => f.id === 7)
    expect(typeof numPt?.id).toBe('number')
    expect(typeof numMp?.id).toBe('number') // preserved through the multi split/regroup too
    expect(numMp?.geometry.type).toBe('MultiPolygon')
    // exported properties carry NO internal meta leak
    expect(numPt?.properties['ziee:geojson']).toBeUndefined()
    // idempotent (numeric ids stable)
    const back = importGeoJson(out)
    expect(exportGeoJson(back.annotations, back.classes)).toEqual(out)
  })
})

// ── ITEM-12: hierarchy (level + parentId) round-trip (TEST-14) ────────────────────────────────
describe('geojson — hierarchy level + parent round-trip (TEST-14)', () => {
  const poly = (id: string, x0: number, y0: number, x1: number, y1: number, level?: string, parentId?: string) => ({
    type: 'Feature' as const,
    id,
    geometry: { type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
    properties: {
      ...(level !== undefined ? { level } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      measurements: { area: (x1 - x0) * (y1 - y0) }, // FOREIGN prop — must survive
    },
  })

  it('a 3-level FeatureCollection preserves parent links + levels + foreign props', () => {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        poly('tissue', 0, 0, 100, 100, 'tissue'),
        poly('region', 10, 10, 60, 60, 'region', 'tissue'),
        poly('cell', 20, 20, 30, 30, 'cell', 'region'),
      ],
    }
    const imported = importGeoJson(fc)
    const byId = new Map(imported.annotations.map(a => [a.id, a]))
    expect(byId.get('region')?.parentId).toBe('tissue')
    expect(byId.get('cell')?.level).toBe('cell')
    // foreign property retained on the model
    expect((byId.get('cell')?.properties as Record<string, unknown>)?.measurements).toEqual({ area: 100 })

    const out = exportGeoJson(imported.annotations, imported.classes)
    const cellFeat = out.features.find(f => f.id === 'cell')!
    expect(cellFeat.properties.level).toBe('cell')
    expect(cellFeat.properties.parentId).toBe('region')
    expect(cellFeat.properties.measurements).toEqual({ area: 100 }) // foreign survives export
    // full re-import → identical tree
    const back = importGeoJson(out)
    const byId2 = new Map(back.annotations.map(a => [a.id, a]))
    expect(byId2.get('cell')?.parentId).toBe('region')
    expect(byId2.get('region')?.parentId).toBe('tissue')
  })

  it('a flat (level-less) collection round-trips byte-identically (INV-7 back-compat)', () => {
    const fc: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [poly('a', 0, 0, 10, 10)], // no level, no parentId
    }
    const imported = importGeoJson(fc)
    expect(imported.annotations[0].level).toBeUndefined()
    expect(imported.annotations[0].parentId).toBeUndefined()
    const out = exportGeoJson(imported.annotations, imported.classes)
    expect('level' in out.features[0].properties).toBe(false)
    expect('parentId' in out.features[0].properties).toBe(false)
    // idempotent
    expect(exportGeoJson(importGeoJson(out).annotations, [])).toEqual(out)
  })
})
