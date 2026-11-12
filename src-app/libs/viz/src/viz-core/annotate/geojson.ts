// geojson.ts — lossless GeoJSON import/export for the annotation model (ITEM-7).
//
// The interchange contract (INV-7): an RFC 7946 `FeatureCollection` that round-trips
// through import→edit→export→re-import WITHOUT losing geometry, class (name+colour),
// id, lock state, or ANY unmodeled property. QuPath is the portability target, so the
// per-Feature `properties` mirror QuPath exactly — `objectType`, `name`,
// `classification:{name,color:[r,g,b]}`, `isLocked`, `measurements`, namespaced
// `txresbench:{}` — and every OTHER `properties` key is passed through VERBATIM (the
// foreign-property passthrough rule) via the model's `Annotation.properties` bag.
//
// Coordinates default to full-resolution pixels — the canonical stored space (INV-4) —
// so no transform is needed for the common QuPath case. A file authored in physical /
// world / level space declares it in a top-level `txresbench:crs` member (or via `opts.space`),
// and every coordinate flows through the ITEM-14 coords facade — the ONE call surface,
// never inline level math.
//
// Winding is normalized to the RFC 7946 right-hand rule ON EXPORT (exterior rings CCW,
// holes CW) and read PERMISSIVELY on import (any winding accepted, none reordered), so
// export is idempotent while import never rejects a differently-wound QuPath ring.
//
// PURITY (INV-1): only the pure model + coords facade — NO deck/react/store/backend.

import type {
  Annotation,
  AnnotationClass,
  AnnotationGeometry,
  PolygonGeometry,
} from './annotateModel'
import {
  type CoordSpace,
  type ImageCoordinateSystem,
  coordSpaceFromString,
  coordSpaceToString,
} from './coords'

// ── minimal RFC 7946 shapes (only what we read/write; keeps the module dep-free) ──

type Position = number[]
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }

export interface GeoJsonFeature {
  type: 'Feature'
  id?: string | number
  geometry: GeoJsonGeometry
  properties: Record<string, unknown>
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
  /** txresbench namespaced coordinate-space declaration (ITEM-7); absent ⇒ full-res pixels. */
  'txresbench:crs'?: string
}

/** The result of importing a FeatureCollection: the annotations + the class registry
 *  discovered from their `classification` properties. */
export interface GeoJsonImportResult {
  readonly annotations: Annotation[]
  readonly classes: AnnotationClass[]
}

export interface GeoJsonIoOptions {
  /** the on-disk coordinate space of the coordinates. Default: read `txresbench:crs`, else
   *  `'fullRes'`. Any non-fullRes space REQUIRES `coords`. */
  readonly space?: CoordSpace
  /** the ITEM-14 facade, required iff `space` (resolved) is not `'fullRes'`. */
  readonly coords?: ImageCoordinateSystem
}

// A MultiPolygon / MultiPoint / MultiLineString Feature is stored as one Annotation PER PART
// (the flat editable model holds one polygon/point/path each). Multi-part MEMBERSHIP is tracked
// OUT OF BAND in a reserved, namespaced property bag entry (`GEOJSON_META_KEY`) rather than by
// parsing a `::part` string suffix off the annotation id — so (a) a foreign Feature id that
// literally contains `::part<n>` is never corrupted on export, (b) a single-part Multi still
// round-trips back to its Multi type, and (c) a NUMERIC RFC 7946 Feature id round-trips as a
// number (its original type is preserved in the meta). The suffix below is now only a cosmetic
// uniquifier for per-part annotation ids; it is NEVER parsed.
const PART_ID_SUFFIX = '::part'

/** Reserved property key holding this module's out-of-band per-Feature metadata (stripped on export). */
const GEOJSON_META_KEY = 'txresbench:geojson'

/** Out-of-band round-trip metadata attached to an imported annotation's property bag. */
interface GeoJsonMeta {
  /** The ORIGINAL RFC 7946 Feature id, TYPE-PRESERVED (number or string) — authoritative on export. */
  id?: string | number
  /** Part index within a multi-geometry Feature (stable export ordering). */
  part?: number
  /** The source Feature was a Multi* geometry — re-exports as Multi even with a single part. */
  multi?: boolean
}

/** Read the reserved out-of-band meta off a property bag (absent / malformed ⇒ undefined). */
function readMeta(props: Record<string, unknown> | null | undefined): GeoJsonMeta | undefined {
  const v = props?.[GEOJSON_META_KEY]
  if (typeof v !== 'object' || v === null) return undefined
  return v as GeoJsonMeta
}

// ── small pure geometry helpers ───────────────────────────────────────────────

/** Shoelace signed area of a flat, open ring `[x0,y0,…]`; >0 ⇒ CCW, <0 ⇒ CW. */
function signedArea(flat: number[]): number {
  let a = 0
  const n = flat.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1]
  }
  return a / 2
}

/** Reverse a flat ring's vertex order (winding flip), preserving xy pairing. */
function reverseFlat(flat: number[]): number[] {
  const out: number[] = new Array(flat.length)
  const n = flat.length / 2
  for (let i = 0; i < n; i++) {
    out[2 * i] = flat[2 * (n - 1 - i)]
    out[2 * i + 1] = flat[2 * (n - 1 - i) + 1]
  }
  return out
}

/** GeoJSON position ring `[[x,y],…]` (possibly closed) → flat OPEN `[x0,y0,…]`
 *  (drops a trailing vertex that duplicates the first — the model stores open rings). */
function ringToOpenFlat(ring: Position[]): number[] {
  const flat: number[] = []
  for (const p of ring) flat.push(p[0], p[1])
  const n = flat.length / 2
  if (n >= 2 && flat[0] === flat[2 * (n - 1)] && flat[1] === flat[2 * (n - 1) + 1]) {
    flat.length -= 2 // drop the closing duplicate
  }
  return flat
}

/** flat OPEN ring `[x0,y0,…]` → CLOSED GeoJSON positions `[[x,y],…,[x0,y0]]`. */
function openFlatToClosedRing(flat: number[]): Position[] {
  const ring: Position[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) ring.push([flat[i], flat[i + 1]])
  if (ring.length > 0) ring.push([ring[0][0], ring[0][1]]) // close
  return ring
}

// ── coordinate-space plumbing ─────────────────────────────────────────────────

function resolveSpace(fc: { 'txresbench:crs'?: string } | undefined, opts?: GeoJsonIoOptions): CoordSpace {
  if (opts?.space) return opts.space
  return coordSpaceFromString(fc?.['txresbench:crs'])
}

/** Build the per-coordinate mapper `space → fullRes` (import) or `fullRes → space` (export). */
function makeMapper(
  space: CoordSpace,
  coords: ImageCoordinateSystem | undefined,
  dir: 'toFull' | 'fromFull',
): (x: number, y: number) => [number, number] {
  if (space === 'fullRes') return (x, y) => [x, y]
  if (!coords) {
    throw new Error(`geojson: space "${coordSpaceToString(space)}" requires a coords facade`)
  }
  return dir === 'toFull'
    ? (x, y) => coords.map([x, y], space, 'fullRes')
    : (x, y) => coords.map([x, y], 'fullRes', space)
}

/** Map a flat ring through a coordinate mapper. */
function mapFlat(flat: number[], m: (x: number, y: number) => [number, number]): number[] {
  const out = new Array<number>(flat.length)
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [x, y] = m(flat[i], flat[i + 1])
    out[i] = x
    out[i + 1] = y
  }
  return out
}

// ── property split (import) / merge (export) ──────────────────────────────────

interface FeatureFields {
  classId: string | null
  label: string | null
  locked: boolean | undefined
  level: string | null
  parentId: string | null
  passthrough: Record<string, unknown>
}

function parseClassification(v: unknown): AnnotationClass | null {
  if (typeof v !== 'object' || v === null) return null
  const obj = v as { name?: unknown; color?: unknown }
  if (typeof obj.name !== 'string') return null
  let color: [number, number, number] = [0, 0, 0]
  if (Array.isArray(obj.color) && obj.color.length >= 3) {
    color = [Number(obj.color[0]), Number(obj.color[1]), Number(obj.color[2])]
  }
  return { id: obj.name, name: obj.name, color }
}

/** Split a Feature's `properties` into modeled fields + the foreign passthrough bag. */
function splitProperties(
  props: Record<string, unknown> | null | undefined,
  classSink: Map<string, AnnotationClass>,
): FeatureFields {
  const passthrough: Record<string, unknown> = {}
  let classId: string | null = null
  let label: string | null = null
  let locked: boolean | undefined
  let level: string | null = null
  let parentId: string | null = null
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'classification') {
      const cls = parseClassification(v)
      if (cls) {
        classId = cls.id
        if (!classSink.has(cls.id)) classSink.set(cls.id, cls)
      }
    } else if (k === 'name') {
      label = typeof v === 'string' ? v : String(v)
    } else if (k === 'isLocked') {
      locked = Boolean(v)
    } else if (k === 'level' && (v == null || typeof v === 'string')) {
      // Hierarchy level tag (ITEM-12) — a host-supplied open string (DEC-8). Modeled, not foreign.
      // Only intercept a STRING (or null): a foreign file using this reserved key with a NON-string
      // value (e.g. `level: 3`) stays a foreign property (passthrough), preserving its type (INV-7).
      level = v == null ? null : v
    } else if (k === 'parentId' && (v == null || typeof v === 'string')) {
      // Hierarchy parent link (ITEM-12): the parent's stable Feature/model id (INV-10 round-trip).
      // Same string-only guard so a non-string foreign `parentId` isn't coerced/hijacked.
      parentId = v == null ? null : v
    } else if (k === GEOJSON_META_KEY) {
      // SECURITY: the reserved out-of-band meta key is NEVER trusted from FOREIGN input. A
      // legitimate internal round-trip strips it on export (mergeProperties), so any file that
      // still carries it is a crafted/foreign copy attempting to hijack the export id/multi/part.
      // Drop it here so it can neither round-trip as trusted internal metadata nor reappear in
      // the passthrough bag — the editor's OWN meta is attached separately in `add()` on import.
    } else {
      passthrough[k] = v // foreign — retained verbatim (measurements, objectType, other txresbench:*, …)
    }
  }
  return { classId, label, locked, level, parentId, passthrough }
}

/** Rebuild a Feature's `properties` from an annotation + the class registry (inverse of split). */
function mergeProperties(a: Annotation, classes: Map<string, AnnotationClass>): Record<string, unknown> {
  const props: Record<string, unknown> = { ...(a.properties ?? {}) }
  delete props[GEOJSON_META_KEY] // internal round-trip meta never leaks into the exported file
  if (a.classId != null) {
    const cls = classes.get(a.classId)
    if (cls) props.classification = { name: cls.name, color: [cls.color[0], cls.color[1], cls.color[2]] }
  }
  if (a.label != null) props.name = a.label
  if (a.locked !== undefined) props.isLocked = a.locked
  // Hierarchy (ITEM-12): persist level + parent link; a flat (level-less/root) annotation writes
  // neither, so a pre-hierarchy collection round-trips byte-identically (INV-7 back-compat).
  if (a.level != null) props.level = a.level
  if (a.parentId != null) props.parentId = a.parentId
  return props
}

// ── import ────────────────────────────────────────────────────────────────────

/**
 * Import an RFC 7946 `FeatureCollection` into annotations + a class registry. Permissive:
 * accepts any ring winding (never reordered) and both closed/open rings. Coordinates are
 * mapped into the canonical full-res space (INV-4) via the ITEM-14 facade when the source
 * space is not `'fullRes'`. A multi-geometry Feature becomes one annotation per part,
 * sharing the Feature id (recombined on export) so id/class/props round-trip losslessly.
 */
export function importGeoJson(input: unknown, opts?: GeoJsonIoOptions): GeoJsonImportResult {
  const fc = input as GeoJsonFeatureCollection
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('geojson: expected a FeatureCollection')
  }
  const space = resolveSpace(fc, opts)
  const toFull = makeMapper(space, opts?.coords, 'toFull')

  const classSink = new Map<string, AnnotationClass>()
  const annotations: Annotation[] = []

  fc.features.forEach((feat, fi) => {
    const rawId = feat.id // string | number | undefined — TYPE preserved for round-trip
    const baseId = rawId != null ? String(rawId) : `feature-${fi}`
    const fields = splitProperties(feat.properties, classSink)
    const geom = feat.geometry

    // Attach the annotation, folding any out-of-band meta into its property bag (separate object
    // per part so parts don't alias one shared bag).
    const add = (id: string, geometry: AnnotationGeometry, meta?: GeoJsonMeta): void => {
      const properties = meta
        ? { ...fields.passthrough, [GEOJSON_META_KEY]: meta }
        : fields.passthrough
      annotations.push({
        id,
        geometry,
        classId: fields.classId,
        label: fields.label,
        locked: fields.locked,
        ...(fields.level != null ? { level: fields.level } : {}),
        ...(fields.parentId != null ? { parentId: fields.parentId } : {}),
        properties,
      })
    }
    // A singular geometry only needs meta to preserve a NUMERIC id's type.
    const addSingle = (geometry: AnnotationGeometry): void =>
      add(baseId, geometry, typeof rawId === 'number' ? { id: rawId } : undefined)
    // A multi geometry emits one annotation per part; meta carries the (typed) id, the multi flag,
    // and the part index. `multi` survives even a SINGLE-part multi so it re-exports as Multi.
    const addPart = (i: number, total: number, geometry: AnnotationGeometry): void => {
      const id = total > 1 ? `${baseId}${PART_ID_SUFFIX}${i}` : baseId
      add(id, geometry, { id: rawId ?? baseId, part: i, multi: true })
    }

    switch (geom.type) {
      case 'Point': {
        const [x, y] = toFull(geom.coordinates[0], geom.coordinates[1])
        addSingle({ kind: 'point', xy: [x, y] })
        break
      }
      case 'MultiPoint': {
        geom.coordinates.forEach((c, i) => {
          const [x, y] = toFull(c[0], c[1])
          addPart(i, geom.coordinates.length, { kind: 'point', xy: [x, y] })
        })
        break
      }
      case 'LineString': {
        const flat = mapFlat(ringToLineFlat(geom.coordinates), toFull)
        addSingle({ kind: 'path', xy: Float64Array.from(flat) })
        break
      }
      case 'MultiLineString': {
        geom.coordinates.forEach((line, i) => {
          const flat = mapFlat(ringToLineFlat(line), toFull)
          addPart(i, geom.coordinates.length, { kind: 'path', xy: Float64Array.from(flat) })
        })
        break
      }
      case 'Polygon': {
        addSingle({ kind: 'polygon', rings: polygonRings(geom.coordinates, toFull) })
        break
      }
      case 'MultiPolygon': {
        geom.coordinates.forEach((poly, i) => {
          addPart(i, geom.coordinates.length, {
            kind: 'polygon',
            rings: polygonRings(poly, toFull),
          })
        })
        break
      }
      default:
        throw new Error(`geojson: unsupported geometry type "${(geom as { type: string }).type}"`)
    }
  })

  return { annotations, classes: [...classSink.values()] }
}

/** A LineString/MultiLineString element's positions → flat (open, no closing logic). */
function ringToLineFlat(line: Position[]): number[] {
  const flat: number[] = []
  for (const p of line) flat.push(p[0], p[1])
  return flat
}

/** A GeoJSON Polygon's rings → the model's open flat rings (exterior first, then holes). */
function polygonRings(
  rings: Position[][],
  toFull: (x: number, y: number) => [number, number],
): Float64Array[] {
  return rings.map(r => Float64Array.from(mapFlat(ringToOpenFlat(r), toFull)))
}

// ── export ──────────────────────────────────────────────────────────────────

/**
 * Export annotations to an RFC 7946 `FeatureCollection`, QuPath-portable. Reconstructs
 * multi-geometry Features from parted annotations (`id::partN`), rebuilds each Feature's
 * `properties` (classification/name/isLocked + the foreign passthrough bag verbatim),
 * normalizes ring winding to the RFC right-hand rule, and maps coordinates from the
 * canonical full-res space out to `opts.space` when it is not `'fullRes'`. Idempotent:
 * `export(import(fc))` re-emits a byte-equivalent FeatureCollection.
 */
export function exportGeoJson(
  annotations: readonly Annotation[],
  classes: readonly AnnotationClass[],
  opts?: GeoJsonIoOptions,
): GeoJsonFeatureCollection {
  const space = opts?.space ?? 'fullRes'
  const fromFull = makeMapper(space, opts?.coords, 'fromFull')
  const classMap = new Map(classes.map(c => [c.id, c]))

  // Group annotations by their out-of-band Feature identity (first-seen order). Grouping keys off
  // `meta.id` (type-tagged) when present, else the literal annotation id — NEVER a parsed `::part`
  // suffix, so a foreign id containing `::part<n>` groups (and exports) verbatim.
  const order: string[] = []
  const groups = new Map<string, Annotation[]>()
  for (const a of annotations) {
    const key = groupKeyOf(a)
    let g = groups.get(key)
    if (!g) {
      g = []
      groups.set(key, g)
      order.push(key)
    }
    g.push(a)
  }

  const features: GeoJsonFeature[] = order.map(key => {
    const members = groups.get(key)!.slice().sort((a, b) => partIndexOf(a) - partIndexOf(b))
    const head = members[0]
    const meta = readMeta(head.properties)
    // The exported id is the type-preserved original (a number stays a number); fall back to the
    // annotation id for annotations created in-app (no meta).
    const id: string | number = meta?.id !== undefined ? meta.id : head.id
    const multi = meta?.multi === true || members.length > 1
    return {
      type: 'Feature',
      id,
      geometry: buildGeometry(members, fromFull, multi),
      properties: mergeProperties(head, classMap),
    }
  })

  const out: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
  if (space !== 'fullRes') out['txresbench:crs'] = coordSpaceToString(space)
  return out
}

/** A collision-proof group key: type-tagged `meta.id` when present, else the literal annotation id. */
function groupKeyOf(a: Annotation): string {
  const meta = readMeta(a.properties)
  if (meta && meta.id !== undefined) return `M ${typeof meta.id} ${String(meta.id)}`
  return `A ${a.id}`
}

/** Part index for stable multi-geometry ordering (0 when not a multi part). */
function partIndexOf(a: Annotation): number {
  return readMeta(a.properties)?.part ?? 0
}

/** Build the (possibly multi-) GeoJSON geometry for one Feature's member annotations. */
function buildGeometry(
  members: Annotation[],
  fromFull: (x: number, y: number) => [number, number],
  multi: boolean,
): GeoJsonGeometry {
  const kind = members[0].geometry.kind
  switch (kind) {
    case 'point': {
      const pts = members.map(m => {
        const g = m.geometry as { kind: 'point'; xy: readonly [number, number] }
        const [x, y] = fromFull(g.xy[0], g.xy[1])
        return [x, y] as Position
      })
      return multi ? { type: 'MultiPoint', coordinates: pts } : { type: 'Point', coordinates: pts[0] }
    }
    case 'path': {
      const lines = members.map(m => {
        const g = m.geometry as { kind: 'path'; xy: Float64Array }
        return openFlatToPositions(mapFlat(Array.from(g.xy), fromFull))
      })
      return multi
        ? { type: 'MultiLineString', coordinates: lines }
        : { type: 'LineString', coordinates: lines[0] }
    }
    case 'polygon': {
      const polys = members.map(m => polygonCoordinates(m.geometry as PolygonGeometry, fromFull))
      return multi
        ? { type: 'MultiPolygon', coordinates: polys }
        : { type: 'Polygon', coordinates: polys[0] }
    }
  }
}

/** A path's flat coords → open GeoJSON positions (no winding, no closing). */
function openFlatToPositions(flat: number[]): Position[] {
  const out: Position[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

/** A model Polygon → GeoJSON rings: exterior CCW, holes CW, each closed (RFC 7946 §3.1.6). */
function polygonCoordinates(
  g: PolygonGeometry,
  fromFull: (x: number, y: number) => [number, number],
): Position[][] {
  return g.rings.map((ring, i) => {
    let flat = mapFlat(Array.from(ring), fromFull)
    const exterior = i === 0
    const area = signedArea(flat)
    // exterior wants CCW (area>0), holes want CW (area<0); flip if wrong.
    if ((exterior && area < 0) || (!exterior && area > 0)) flat = reverseFlat(flat)
    return openFlatToClosedRing(flat)
  })
}
