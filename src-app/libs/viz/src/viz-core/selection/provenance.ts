// provenance.ts — the PURE engine behind selection provenance (ITEM-2).
//
// A `@ziee/viz` selection is a PREDICATE WITH A CACHE, not a bag of integers: an ordered op list
// (`VizSelectionOp[]`) plus the display state that explains it (`VizSelectionContext`), from which
// the cached `ids` are re-derivable. This module is the whole of that logic.
//
// PURITY (mirrors `SelectionController.ts:68-69` and `areaGestures.ts`): no react, no deck.gl, no
// I/O — so every function here is directly unit-testable in node, which is what lets INV-2's
// full-N oracle (`deriveSelection` vs the live fold) be a plain vitest test.
//
// THE ONE FOLD: `deriveSelection` folds through the SAME `combineMask` + `areaMask` the producers
// use (`GridWorkspace.publishCellAreas` after ITEM-4, `SelectionController.recompute()`), seeded
// from an EMPTY mask. If it folded differently it would be a third implementation and INV-2 ("ops
// re-derive ids EXACTLY") would be a lie the moment a non-`add` op existed.
//
// THE INV-8 GATEKEEPER: `classifyChange` is the single function that decides whether a
// re-evaluation tick costs a geometric re-derive or only a re-partition. DEC-19 (automatic on
// everything) × DEC-20 (a context change never changes ids) ⇒ re-running the geometry after a
// filter/hidden change provably yields the SAME set, so it is not merely expensive — it is work
// whose result is known in advance. Routing every tick through one classifier is what makes "don't
// do it" checkable (TEST-24/TEST-25) instead of an optimization someone can quietly drop.

import { IndexMask } from '../data/selection'
import { areaMask, type Area } from './SelectionController'
import { combineMask } from './areaGestures'
import type {
  VizSelectionCombine,
  VizSelectionContext,
  VizSelectionOp,
} from '../option/types'

// ---------------------------------------------------------------------------
// Area <-> op
// ---------------------------------------------------------------------------

/** Record a committed `Area` as an op. `Area.kind` is 1:1 with `op.tool` (DEC-1) and `Area.mode`
 *  with `op.op`, so this is a re-tagging, not a translation — the fidelity INV-2 rests on. */
export function areaToOp(area: Area, pane: string, space: string): VizSelectionOp {
  return area.kind === 'rect'
    ? { tool: 'rect', op: area.mode, pane, space, region: [...area.box] as [number, number, number, number] }
    : {
        tool: 'polygon',
        op: area.mode,
        pane,
        space,
        region: area.polygon.map(v => [v[0], v[1]] as readonly [number, number]),
      }
}

/** The inverse: rebuild the `Area` an op describes, so re-derivation runs the SAME `areaMask` the
 *  producer ran. Returns `null` for a `tool:'ids'` op — those carry canonical ids, not geometry,
 *  and are folded directly by `deriveSelection`. */
export function opToArea(op: VizSelectionOp): Area | null {
  if (op.tool === 'rect') return { kind: 'rect', box: op.region, mode: op.op }
  if (op.tool === 'polygon') {
    return { kind: 'polygon', polygon: op.region.map(v => [v[0], v[1]] as const), mode: op.op }
  }
  return null
}

// ---------------------------------------------------------------------------
// Content hash (DEC-8) — the staleness detector
// ---------------------------------------------------------------------------

/** FNV-1a (32-bit). Byte-loop variant of `export/manifest.ts:10-17`, operating on the position
 *  buffer directly rather than a JSON string (a 200k-point `Float32Array` must not be stringified). */
function fnv1aBytes(buf: Float32Array, init: number): number {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  let h = init >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
// `>>> 0` coerces to UNSIGNED before formatting. Without it the `^` below yields a SIGNED int32, so
// a negative result formatted to a 17-char token beginning with '-' — violating the documented
// "16 hex chars" contract that a stored figure manifest and any consumer parse against.
const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0')

// M8 — memoized by BUFFER IDENTITY. `snapshotContext` hashes every pane's positions on each
// `recordCellProvenance`, and `publishCellAreas` calls that on every pointermove of a live vertex
// update / area drag — measured at 8.2 ms per call over 200k points, i.e. a whole frame budget spent
// re-hashing data that did not change. Keying on the array OBJECT is sound because position buffers
// are treated as IMMUTABLE here: every read site indexes them (`positions[i * 2]`) and none writes,
// so a data change produces a NEW buffer and therefore a cache MISS — the change-detection this hash
// exists for is preserved. A `WeakMap` adds no retention: the entry dies with the buffer.
const positionHashCache = new WeakMap<Float32Array, string>()

/** A stable content hash of a pane's positions — same data ⇒ same hash, changed data ⇒ different.
 *  Two passes with different init give 16 hex chars, exactly the `manifest.ts` idiom (DEC-8: no
 *  crypto dep). The point COUNT is mixed in so a truncation cannot collide with the original.
 *  Memoized on the buffer's identity (see above), so repeated calls for an unchanged pane are O(1). */
export function hashPositions(positions: Float32Array): string {
  const hit = positionHashCache.get(positions)
  if (hit !== undefined) return hit
  const out =
    hex8(fnv1aBytes(positions, 0x811c9dc5) ^ positions.length) +
    hex8(fnv1aBytes(positions, 0x7a646e4d))
  positionHashCache.set(positions, out)
  return out
}

// ---------------------------------------------------------------------------
// Re-derivation
// ---------------------------------------------------------------------------

/** What `deriveSelection` needs to know about one pane to re-run its geometry. */
export interface ProvenancePane {
  /** Interleaved `[x,y,…]` world positions — the same buffer the producer hit-tested. */
  readonly positions: Float32Array
  readonly nPoints: number
  /** Local row -> canonical point id. Absent ⇒ the row index IS the canonical id. */
  readonly pointIds?: Uint32Array | null
  /** The identity space this pane's ids live in. */
  readonly space: string
}

/** Resolve a pane id to its live buffers, or `null` when the pane is not mounted. */
export type ResolvePane = (pane: string | null) => ProvenancePane | null

/** Re-derive the live selection from an op list — the executable form of "the selection IS the
 *  predicate" (INV-7).
 *
 *  Ops are grouped BY PANE in first-appearance order and each pane's group is folded independently
 *  through `combineMask`, because a combine op only means anything against masks over the same
 *  point set. Each pane's resulting rows are mapped local -> canonical via `pointIds` and unioned
 *  into that pane's identity SPACE — so a selection in space A never bleeds into space B (INV-3).
 *
 *  Returns per-space sorted canonical ids. A pane the resolver cannot supply is SKIPPED (its ops
 *  contribute nothing) rather than throwing: an option may legitimately be restored before every
 *  pane exists, and DEC-9 defers the derive to the first render that has the buffers. */
export function deriveSelection(
  ops: readonly VizSelectionOp[],
  resolvePane: ResolvePane,
): Record<string, number[]> {
  const byPane = new Map<string, VizSelectionOp[]>()
  for (const op of ops) {
    const key = op.pane ?? '\u0000programmatic'
    const list = byPane.get(key)
    if (list) list.push(op)
    else byPane.set(key, [op])
  }

  const bySpace = new Map<string, Set<number>>()
  const addTo = (space: string, id: number) => {
    const s = bySpace.get(space)
    if (s) s.add(id)
    else bySpace.set(space, new Set([id]))
  }

  for (const [key, paneOps] of byPane) {
    const paneId = key === '\u0000programmatic' ? null : key
    const pane = resolvePane(paneId)

    // A pure `tool:'ids'` group needs no geometry — fold the id sets directly, so a programmatic
    // selection survives even when no pane is mounted.
    if (!pane) {
      if (paneOps.every(o => o.tool === 'ids')) {
        let acc = new Set<number>()
        for (const op of paneOps) acc = foldIds(acc, (op as { region: readonly number[] }).region, op.op)
        for (const id of acc) addTo(paneOps[0].space, id)
      }
      continue
    }

    let mask = new IndexMask(pane.nPoints)
    let idsAcc: Set<number> | null = null

    for (const op of paneOps) {
      if (op.tool === 'ids') {
        // An id op is expressed in CANONICAL ids, not rows — fold it in id-space, then intersect
        // back at the end. Kept separate so a mixed list cannot silently coerce ids to rows.
        idsAcc = foldIds(idsAcc ?? new Set<number>(), op.region, op.op)
        continue
      }
      const area = opToArea(op)
      if (!area) continue
      mask = combineMask(mask, areaMask(area, pane.positions, pane.nPoints), op.op)
    }

    const hasGeometry = paneOps.some(o => o.tool !== 'ids')
    if (hasGeometry) {
      for (const row of mask.toIndices()) {
        addTo(pane.space, pane.pointIds ? pane.pointIds[row] : row)
      }
    }
    if (idsAcc) for (const id of idsAcc) addTo(pane.space, id)
  }

  const out: Record<string, number[]> = {}
  for (const [space, set] of bySpace) out[space] = [...set].sort((a, b) => a - b)
  return out
}

function foldIds(base: Set<number>, incoming: readonly number[], mode: VizSelectionCombine): Set<number> {
  if (mode === 'add') {
    const out = new Set(base)
    for (const id of incoming) out.add(id)
    return out
  }
  if (mode === 'subtract') {
    const out = new Set(base)
    for (const id of incoming) out.delete(id)
    return out
  }
  const inc = new Set(incoming)
  const out = new Set<number>()
  for (const id of base) if (inc.has(id)) out.add(id)
  return out
}

// ---------------------------------------------------------------------------
// Partition (the explanatory half — DEC-20)
// ---------------------------------------------------------------------------

/** How a reported selection breaks down against the display state. The three groups are DISJOINT
 *  and their union is exactly the input ids — nothing invented, nothing lost. */
export interface SelectionPartition {
  readonly visible: number[]
  readonly hiddenByLegend: number[]
  readonly outsideFilters: number[]
}

/** What the caller must supply to decide whether ONE canonical id is currently displayed. Kept as a
 *  callback so this module stays pure — it never reaches into a store or a cell. */
export interface PartitionProbe {
  /** The plot id whose `context.filters` / `context.hidden` entry governs this id. */
  readonly plotId: string
  /** The id's value on the filtered column, or `null` when it has none. */
  readonly value: number | null
  /** The id's category code, or `null` when the plot is not categorical. */
  readonly code: number | null
}

/** Split reported ids into `{visible, hiddenByLegend, outsideFilters}` (DEC-20). This is the ONLY
 *  place the context is allowed to affect anything — it explains a selection, it never shrinks one
 *  (INV-1). An id that is both hidden AND out of range is reported as `outsideFilters` (checked
 *  first) so the groups stay disjoint. */
export function partitionSelection(
  ids: readonly number[],
  context: VizSelectionContext | undefined,
  probe: (id: number) => PartitionProbe | null,
): SelectionPartition {
  const visible: number[] = []
  const hiddenByLegend: number[] = []
  const outsideFilters: number[] = []

  for (const id of ids) {
    const p = probe(id)
    if (!p) {
      visible.push(id)
      continue
    }
    const range = context?.filters?.[p.plotId]
    if (range && p.value != null && (p.value < range[0] || p.value > range[1])) {
      outsideFilters.push(id)
      continue
    }
    const hidden = context?.hidden?.[p.plotId]
    if (hidden && p.code != null && hidden.includes(p.code)) {
      hiddenByLegend.push(id)
      continue
    }
    visible.push(id)
  }
  return { visible, hiddenByLegend, outsideFilters }
}

// ---------------------------------------------------------------------------
// Change classification (the INV-8 gatekeeper) + staleness
// ---------------------------------------------------------------------------

export type ChangeClass = 'none' | 'context' | 'data'
export type SelectionStaleness = 'fresh' | 'stale-data' | 'stale-context'

/** THE INV-8 GATEKEEPER — the one pure function every re-evaluation tick routes through.
 *
 *  `'data'`  — some pane's positions hash moved (or a pane appeared/disappeared). The cached ids
 *              may reference points that no longer exist ⇒ FULL geometric re-derive.
 *  `'context'` — ONLY `filters`/`hidden` moved ⇒ RE-PARTITION ONLY, zero containment tests, and the
 *              ids array must be left as the SAME INSTANCE (a rebuilt equal array breaks reference
 *              identity for reactive readers).
 *  `'none'`  — nothing moved ⇒ no work.
 *
 *  DATA WINS: if both moved this returns `'data'`, never `'context'`. Downgrading a data change to
 *  a re-partition would leave `ids` pointing at replaced points — the naive
 *  `if (contextChanged) return 'context'` ordering bug TEST-25's both-moved arm exists to catch. */
export function classifyChange(
  recorded: VizSelectionContext | undefined,
  live: VizSelectionContext | undefined,
): ChangeClass {
  if (!sameRecord(recorded?.panes, live?.panes, (a, b) => a === b)) return 'data'
  const filtersSame = sameRecord(recorded?.filters, live?.filters, (a, b) => a[0] === b[0] && a[1] === b[1])
  const hiddenSame = sameRecord(recorded?.hidden, live?.hidden, sameNumbers)
  return filtersSame && hiddenSame ? 'none' : 'context'
}

/** The observability surface for the one genuinely non-`fresh` window (DEC-23): an ops-only restore
 *  whose pane buffers do not exist yet. Under DEC-19 the steady state is always `'fresh'`. */
export function selectionStaleness(
  recorded: VizSelectionContext | undefined,
  live: VizSelectionContext | undefined,
): SelectionStaleness {
  const cls = classifyChange(recorded, live)
  return cls === 'data' ? 'stale-data' : cls === 'context' ? 'stale-context' : 'fresh'
}

function sameRecord<T>(
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
  eq: (x: T, y: T) => boolean,
): boolean {
  const ak = a ? Object.keys(a) : []
  const bk = b ? Object.keys(b) : []
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!(b && k in b)) return false
    if (!eq(a![k], b[k])) return false
  }
  return true
}

const sameNumbers = (x: readonly number[], y: readonly number[]) =>
  x.length === y.length && x.every((v, i) => v === y[i])
