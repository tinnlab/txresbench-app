// annotateFixture.ts — deterministic, seeded fixtures for the annotation editor's showcase
// stories + smoke tests (ITEM-9 / ITEM-15). Pure — no deck / react / store / GL / I/O
// (mirrors `spatial/imageFixture.ts` / `spatial/labelMaskFixture.ts`). Two exports:
//
//   • `makeAnnotateFixture()` — a seeded annotation COLLECTION (K polygons + points in
//     FULL-RESOLUTION image pixels, INV-4) as a normalized `{ byId, ids }` collection plus a
//     matching class table, so a story can seed `createAnnotateStore()` with a realistic
//     loaded state (few-features / selection / mid-draw) without any hand-authoring.
//   • `QUPATH_GEOJSON_SAMPLE` — a QuPath-authored `FeatureCollection` STRING (polygon-with-hole,
//     multipolygon, a classified point, and foreign `measurements`/`objectType` properties) so
//     the `annotate-geojson` story drives the REAL `importGeoJson`→edit→`exportGeoJson`→re-import
//     round-trip (INV-7) against a portable file, not a hand-rolled object.

import type {
  Annotation,
  AnnotationClass,
  AnnotationCollection,
  AnnotationId,
} from './annotateModel'

/** mulberry32 — a tiny deterministic PRNG (seed → repeatable float stream). Matches the
 *  image/label fixtures so every fixture in the package shares one RNG idiom. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded, closed blob polygon ring (flat `[x0,y0,…]`, open — the model stores open rings)
 *  around `(cx,cy)` with a jittered radius, in full-res px. `sides` vertices. */
function blobRing(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rand: () => number,
): Float64Array {
  const flat = new Float64Array(sides * 2)
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2
    const r = radius * (0.75 + rand() * 0.5)
    flat[2 * i] = cx + Math.cos(t) * r
    flat[2 * i + 1] = cy + Math.sin(t) * r
  }
  return flat
}

/** The default class table the seeded collection is authored against (QuPath-style rgb 0–255). */
export const ANNOTATE_FIXTURE_CLASSES: AnnotationClass[] = [
  { id: 'Tumor', name: 'Tumor', color: [220, 60, 60] },
  { id: 'Stroma', name: 'Stroma', color: [60, 160, 90] },
  { id: 'Immune', name: 'Immune', color: [70, 120, 220] },
]

export interface AnnotateFixtureOpts {
  seed?: number
  /** number of polygon blobs (default 12). */
  polygons?: number
  /** number of points (default 8). */
  points?: number
  /** the full-res image extent the features are scattered over (default 4096). */
  extent?: number
}

export interface AnnotateFixture {
  /** the normalized annotation collection (feed to a store: `add`/`commitResult` each). */
  readonly collection: AnnotationCollection
  /** the class table the features reference (`classId` ∈ these ids). */
  readonly classes: AnnotationClass[]
  /** the ordered annotations (convenience — same objects as `collection.byId`). */
  readonly annotations: Annotation[]
  /** the full-res extent the features live in (INV-4). */
  readonly extent: number
}

/**
 * Build a seeded annotation collection: `polygons` blobby polygons + `points` markers scattered
 * across a `extent × extent` full-res image, each assigned a class from
 * `ANNOTATE_FIXTURE_CLASSES`. Deterministic for a given `seed` so a story/baseline renders
 * identically every run.
 */
export function makeAnnotateFixture(opts: AnnotateFixtureOpts = {}): AnnotateFixture {
  const seed = opts.seed ?? 11
  const nPoly = opts.polygons ?? 12
  const nPoint = opts.points ?? 8
  const extent = opts.extent ?? 4096
  const rand = mulberry32(seed)
  const classes = ANNOTATE_FIXTURE_CLASSES
  const margin = extent * 0.08

  const byId: Record<AnnotationId, Annotation> = {}
  const ids: AnnotationId[] = []
  const annotations: Annotation[] = []

  const place = (): [number, number] => [
    margin + rand() * (extent - 2 * margin),
    margin + rand() * (extent - 2 * margin),
  ]
  const pickClass = (): string => classes[Math.floor(rand() * classes.length)].id

  for (let i = 0; i < nPoly; i++) {
    const [cx, cy] = place()
    const sides = 6 + Math.floor(rand() * 6)
    const radius = extent * (0.02 + rand() * 0.03)
    const a: Annotation = {
      id: `poly-${i}`,
      geometry: { kind: 'polygon', rings: [blobRing(cx, cy, radius, sides, rand)] },
      classId: pickClass(),
      label: `Region ${i + 1}`,
    }
    byId[a.id] = a
    ids.push(a.id)
    annotations.push(a)
  }

  for (let i = 0; i < nPoint; i++) {
    const [x, y] = place()
    const a: Annotation = {
      id: `point-${i}`,
      geometry: { kind: 'point', xy: [x, y] },
      classId: pickClass(),
      label: `Marker ${i + 1}`,
    }
    byId[a.id] = a
    ids.push(a.id)
    annotations.push(a)
  }

  return { collection: { byId, ids }, classes, annotations, extent }
}

/**
 * A QuPath-authored `FeatureCollection` STRING (ITEM-7 portability target). Exercises every
 * import edge the round-trip must survive verbatim (INV-7):
 *   • a POLYGON WITH A HOLE (exterior ring + one interior ring),
 *   • a MULTIPOLYGON (two disjoint parts under one Feature id),
 *   • a classified POINT,
 *   • QuPath `classification:{name,color:[r,g,b]}` + `objectType` + foreign `measurements`
 *     (the foreign-property passthrough bag), and mixed ring winding (read permissively).
 * Coordinates are full-resolution pixels (QuPath's default export space) — no `txresbench:crs`.
 */
export const QUPATH_GEOJSON_SAMPLE = JSON.stringify(
  {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'annotation-tumor-1',
        geometry: {
          type: 'Polygon',
          coordinates: [
            // exterior ring (closed, CW as QuPath often emits — imported permissively)
            [
              [1200, 800],
              [1200, 1400],
              [1800, 1400],
              [1800, 800],
              [1200, 800],
            ],
            // interior ring (a hole)
            [
              [1400, 1000],
              [1600, 1000],
              [1600, 1200],
              [1400, 1200],
              [1400, 1000],
            ],
          ],
        },
        properties: {
          objectType: 'annotation',
          name: 'Tumor region A',
          classification: { name: 'Tumor', color: [220, 60, 60] },
          isLocked: false,
          measurements: { Area_um2: 360000.0, 'Num Detections': 512 },
        },
      },
      {
        type: 'Feature',
        id: 'annotation-stroma-multi',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [300, 300],
                [300, 700],
                [700, 700],
                [700, 300],
                [300, 300],
              ],
            ],
            [
              [
                [2400, 2400],
                [2400, 2800],
                [2800, 2800],
                [2800, 2400],
                [2400, 2400],
              ],
            ],
          ],
        },
        properties: {
          objectType: 'annotation',
          name: 'Stroma islands',
          classification: { name: 'Stroma', color: [60, 160, 90] },
          isLocked: true,
          measurements: { Area_um2: 320000.0 },
        },
      },
      {
        type: 'Feature',
        id: 'detection-immune-7',
        geometry: { type: 'Point', coordinates: [2050, 1600] },
        properties: {
          objectType: 'detection',
          name: 'Immune cell 7',
          classification: { name: 'Immune', color: [70, 120, 220] },
          measurements: { Nucleus_Area: 42.7 },
        },
      },
    ],
  },
  null,
  2,
)
