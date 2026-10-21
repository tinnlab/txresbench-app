// Annotate.store.test.ts — TEST-7 (ITEM-5). Node env (no React): the store is exercised
// through its raw `create()`-bound api (`createAnnotateStore().getState()`), mirroring
// `adapter/vizStores.test.ts`'s pure isolation proof.
//   • drawing grows the normalized collection,
//   • relabel touches ONLY the target object (structural sharing preserves the rest),
//   • two instances share NOTHING (add in A → B empty; distinct api refs) — the §5 no-leak.

import { describe, it, expect } from 'vitest'
import { createAnnotateStore, annotationTally, pointSeedFeatures } from './Annotate.store'
import type { PolygonGeometry } from './annotateModel'

function poly(x = 0, y = 0): PolygonGeometry {
  return { kind: 'polygon', rings: [Float64Array.from([x, y, x + 10, y, x + 10, y + 10, x, y + 10])] }
}

describe('Annotate.store — draw / relabel', () => {
  it('drawing grows the collection', () => {
    const s = createAnnotateStore()
    expect(s.getState().ids).toEqual([])
    const id = s.getState().add({ geometry: poly() })
    expect(s.getState().ids).toEqual([id])
    expect(s.getState().byId[id].geometry.kind).toBe('polygon')

    const id2 = s.getState().add({ geometry: poly(20, 20) })
    expect(s.getState().ids).toEqual([id, id2])
    expect(Object.keys(s.getState().byId).sort()).toEqual([id, id2].sort())
  })

  it('relabel updates ONLY that object (other entries keep identity)', () => {
    const s = createAnnotateStore()
    const id1 = s.getState().add({ geometry: poly(), label: 'a' })
    const id2 = s.getState().add({ geometry: poly(20, 20), label: 'b' })
    const before2 = s.getState().byId[id2]

    s.getState().relabel(id1, { label: 'renamed', classId: 'c1' })

    expect(s.getState().byId[id1].label).toBe('renamed')
    expect(s.getState().byId[id1].classId).toBe('c1')
    // the untouched annotation keeps referential identity (structural sharing)
    expect(s.getState().byId[id2]).toBe(before2)
    expect(s.getState().byId[id2].label).toBe('b')
  })

  it('commitResult adds processor output via the same add path (undoable)', () => {
    const s = createAnnotateStore()
    const created = s.getState().commitResult([
      { geometry: poly(), classId: 'tumor' },
      { geometry: poly(20, 20), classId: 'tumor' },
    ])
    expect(created).toHaveLength(2)
    expect(s.getState().ids).toEqual(created)
    // one batch => one undo entry
    expect(s.getState().undoStack).toHaveLength(1)
    s.getState().undo()
    expect(s.getState().ids).toEqual([])
  })
})

describe('Annotate.store — two-instance isolation (§5 no-leak)', () => {
  it('an add in store A does not leak into store B; api refs are distinct', () => {
    const a = createAnnotateStore()
    const b = createAnnotateStore()

    a.getState().add({ geometry: poly() })

    expect(a.getState().ids).toHaveLength(1)
    expect(b.getState().ids).toHaveLength(0)
    expect(Object.keys(b.getState().byId)).toHaveLength(0)

    // distinct api references + independent selection sets
    expect(a).not.toBe(b)
    expect(a.getState).not.toBe(b.getState)
    a.getState().select([a.getState().ids[0]])
    expect(a.getState().selection.size).toBe(1)
    expect(b.getState().selection.size).toBe(0)
  })
})

// ── ITEM-8/9: hierarchy actions (setParent/setLevel/resolveHierarchy) ─────────────────────────
function bigPoly(x: number, y: number, s: number): PolygonGeometry {
  return { kind: 'polygon', rings: [Float64Array.from([x, y, x + s, y, x + s, y + s, x, y + s])] }
}

describe('Annotate.store — hierarchy actions', () => {
  it('setParent reparents (undoable) and rejects a cycle', () => {
    const s = createAnnotateStore()
    const t = s.getState().add({ geometry: bigPoly(0, 0, 100) })
    const r = s.getState().add({ geometry: bigPoly(10, 10, 40) })
    s.getState().setParent(r, t)
    expect(s.getState().byId[r].parentId).toBe(t)
    // cycle: t under its own child r → rejected (no change)
    s.getState().setParent(t, r)
    expect(s.getState().byId[t].parentId ?? null).toBeNull()
    // undo restores r's parentId to null (hierarchy rides the Immer doc)
    s.getState().undo()
    expect(s.getState().byId[r].parentId ?? null).toBeNull()
  })

  it('setLevel sets a host-supplied level tag (undoable)', () => {
    const s = createAnnotateStore()
    const id = s.getState().add({ geometry: bigPoly(0, 0, 10) })
    s.getState().setLevels(['tissue', 'region', 'cell'])
    s.getState().setLevel(id, 'cell')
    expect(s.getState().byId[id].level).toBe('cell')
    s.getState().undo()
    expect(s.getState().byId[id].level ?? null).toBeNull()
  })

  it('resolveHierarchy batches containment reparenting as ONE undo entry', () => {
    const s = createAnnotateStore()
    const t = s.getState().add({ geometry: bigPoly(0, 0, 100) })
    const r = s.getState().add({ geometry: bigPoly(10, 10, 40) })
    const c = s.getState().add({ geometry: bigPoly(15, 15, 10) })
    const depthBefore = s.getState().undoStack.length
    const changed = s.getState().resolveHierarchy()
    expect(changed).toBe(2) // r→t, c→r (t stays root)
    expect(s.getState().byId[r].parentId).toBe(t)
    expect(s.getState().byId[c].parentId).toBe(r)
    expect(s.getState().undoStack.length).toBe(depthBefore + 1) // ONE entry
    s.getState().undo()
    expect(s.getState().byId[r].parentId ?? null).toBeNull()
    expect(s.getState().byId[c].parentId ?? null).toBeNull()
  })
})

// ── TEST-A11 [acceptance] [invariant: INV-11] ────────────────────────────────────────────────────
// Re-pointed here from the deleted `WorkspaceAnnotateContext.test.ts` (DEC-21). Track C — the
// workspace-level authoring store that fanned tool/class/level across every pane — is deleted
// outright (DEC-17), so INV-11 is AMENDED to a strictly STRONGER form (DEC-19): it is no longer
// "sharing authoring intent shares ONLY that intent", it is "NOTHING crosses a pane boundary".
// Anything that satisfies this test would also have satisfied the inherited invariant.
describe('TEST-A11 — INV-11 (amended): two panes share NOTHING', () => {
  it('keeps authoring intent — tool, active class, class vocabulary, level — per pane', () => {
    const a = createAnnotateStore()
    const b = createAnnotateStore()

    // Author a full, distinct intent in pane A only.
    const clsA = a.getState().addClass({ name: 'Tumour', color: [255, 0, 0] })
    a.getState().setActiveClass(clsA)
    a.getState().setTool('brush')
    a.getState().setLevels(['tissue', 'region'])
    a.getState().setActiveLevel('region')

    // Pane B must be untouched on EVERY one of those axes. Under Track C, tool/class/level would
    // have followed focus into B — that propagation is precisely what was removed.
    expect(b.getState().activeTool).not.toBe('brush')
    expect(b.getState().activeClassId).toBeNull()
    expect(b.getState().classes).toEqual([])
    expect(b.getState().activeLevel).toBeNull()
    expect(b.getState().levels).toEqual([])

    // …and the converse direction, so this is not a one-way accident.
    b.getState().setTool('point')
    expect(a.getState().activeTool).toBe('brush')
  })

  it('keeps geometry, undo depth and selection per pane', () => {
    const a = createAnnotateStore()
    const b = createAnnotateStore()
    const bIdsBefore = b.getState().ids.length
    const bUndoBefore = b.getState().undoStack.length

    const id = a.getState().add({ geometry: poly(), classId: null })
    a.getState().select([id])

    expect(a.getState().ids).toHaveLength(1)
    expect(a.getState().undoStack).toHaveLength(1)
    expect([...a.getState().selection]).toEqual([id])
    // B is byte-identical to its pre-edit state.
    expect(b.getState().ids).toHaveLength(bIdsBefore)
    expect(b.getState().undoStack).toHaveLength(bUndoBefore)
    expect([...b.getState().selection]).toEqual([])
    expect(b.getState().byId[id]).toBeUndefined()
  })
})

// ── ITEM-16 · the counting job (TEST-19) ────────────────────────────────────────────────────
//
// The whole value of the point tool is THE NUMBER. A separately-persisted counter would drift
// the moment an undo / delete / reclass touched the collection — and drift invisibly, because
// the number is exactly what the user trusts. These tests pin the tally to the committed
// annotations so "the count is wrong" is unrepresentable, and pin the seed export to the
// ProcessorPort shape so counted points hand straight to an external segmenter (INV-2/3).
//
// DRIFT-3.8 retargets the tally's MEANING: it counts every object of a class, not the point
// subset. The old assertions ("a polygon must NOT be counted") pinned a semantic that made the
// Classes list contradict the Objects panel — one Tumor polygon read `Tumor 0` next to
// `Objects (1)` — so they are inverted here on purpose, not relaxed.

describe('TEST-19 — the class tally is DERIVED and counts EVERY object, and points export as ProcessorPort seeds', () => {
  const mkStore = () => createAnnotateStore()
  const addPoint = (s: ReturnType<typeof mkStore>, xy: [number, number], classId: string | null) =>
    s.getState().add({ geometry: { kind: 'point', xy }, classId })
  const addPoly = (s: ReturnType<typeof mkStore>, classId: string | null) =>
    s.getState().add({
      geometry: { kind: 'polygon', rings: [new Float64Array([0, 0, 9, 0, 9, 9])] },
      classId,
    })

  it('a class holding ONLY a polygon reads 1 — the count agrees with the Objects panel', () => {
    // The reported defect, as an assertion: `Objects (1)` and `Tumor 0` cannot both be true.
    const s = mkStore()
    const tumor = s.getState().addClass({ name: 'Tumor', color: [1, 2, 3] })
    addPoly(s, tumor)

    const t = annotationTally(s.getState())
    expect(t.byClass[tumor]).toBe(1)
    expect(t.total).toBe(1)
    expect(t.total).toBe(s.getState().ids.length) // === the hierarchy panel's `Objects (N)`
    expect(t.points).toBe(0) // …while the seed-export subset stays honestly empty
  })

  it('counts points + polygons + brush regions per class, and tracks unclassified', () => {
    const s = mkStore()
    const tumor = s.getState().addClass({ name: 'Tumor', color: [1, 2, 3] })
    const stroma = s.getState().addClass({ name: 'Stroma', color: [4, 5, 6] })
    addPoint(s, [0, 0], tumor)
    addPoint(s, [1, 1], tumor)
    addPoint(s, [2, 2], stroma)
    addPoint(s, [3, 3], null)
    addPoly(s, tumor) // an outlined region
    // a brush stroke commits as polygon geometry (`brushRaster.ts` → `{kind:'polygon'}`), so it
    // rides the same arm; committed here through the processor path a brush commit uses.
    s.getState().commitResult([
      { geometry: { kind: 'polygon', rings: [new Float64Array([2, 2, 8, 2, 8, 8])] }, classId: stroma },
    ])

    const t = annotationTally(s.getState())
    expect(t.byClass[tumor]).toBe(3) // 2 points + 1 polygon
    expect(t.byClass[stroma]).toBe(2) // 1 point + 1 brush region
    expect(t.unclassified).toBe(1)
    expect(t.total).toBe(6)
    expect(t.total).toBe(s.getState().ids.length)
    // the per-class numbers + unclassified partition the total — header and rows describe one set
    expect(Object.values(t.byClass).reduce((a, b) => a + b, 0) + t.unclassified).toBe(t.total)
    expect(t.points).toBe(4) // the seed subset is still points only
  })

  it('moves with add / undo / redo / delete / reclass — never a stale stored counter', () => {
    const s = mkStore()
    const c = s.getState().addClass({ name: 'Mitosis', color: [9, 9, 9] })
    addPoint(s, [0, 0], c)
    addPoint(s, [1, 1], c)
    expect(annotationTally(s.getState()).byClass[c]).toBe(2)

    s.getState().undo()
    expect(annotationTally(s.getState()).byClass[c]).toBe(1) // undo decrements
    s.getState().redo()
    expect(annotationTally(s.getState()).byClass[c]).toBe(2) // redo restores

    const firstId = s.getState().ids.find(id => s.getState().byId[id].geometry.kind === 'point')!
    s.getState().delete(firstId)
    expect(annotationTally(s.getState()).byClass[c]).toBe(1) // delete decrements

    const other = s.getState().addClass({ name: 'Other', color: [1, 1, 1] })
    const remaining = s.getState().ids.find(id => s.getState().byId[id].geometry.kind === 'point')!
    s.getState().relabel(remaining, { classId: other })
    const t = annotationTally(s.getState())
    expect(t.byClass[c] ?? 0).toBe(0) // reclass moves the count between buckets
    expect(t.byClass[other]).toBe(1)
    expect(t.total).toBe(1)
  })

  it('rapid point-dropping increments the class live, one per commit', () => {
    // The counting workflow the tally was built for must survive the semantic change.
    const s = mkStore()
    const ki67 = s.getState().addClass({ name: 'Ki-67+', color: [3, 3, 3] })
    const seen: number[] = []
    for (let i = 0; i < 12; i++) {
      addPoint(s, [i, i], ki67)
      seen.push(annotationTally(s.getState()).byClass[ki67] ?? 0)
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    // a polygon dropped mid-count keeps incrementing the SAME number (it is an object too)
    addPoly(s, ki67)
    expect(annotationTally(s.getState()).byClass[ki67]).toBe(13)
    expect(annotationTally(s.getState()).points).toBe(12)
  })

  it('empty collection tallies to zero rather than throwing', () => {
    const t = annotationTally(mkStore().getState())
    expect(t).toEqual({ byClass: {}, unclassified: 0, total: 0, points: 0 })
  })

  it('exports points in the ProcessorPort GeoFeature shape (commitPoints-compatible)', () => {
    const s = mkStore()
    const c = s.getState().addClass({ name: 'Seed', color: [7, 7, 7] })
    addPoint(s, [12.5, 34.5], c)
    addPoint(s, [1, 2], null)
    s.getState().add({
      geometry: { kind: 'polygon', rings: [new Float64Array([0, 0, 5, 0, 5, 5])] },
      classId: c,
    })

    const seeds = pointSeedFeatures(s.getState())
    // ONLY points — a polygon is not a seed
    expect(seeds.length).toBe(2)
    for (const f of seeds) expect(f.geometry.kind).toBe('point')
    // full-res px coordinates carried through verbatim (INV-4)
    expect(seeds[0].geometry).toEqual({ kind: 'point', xy: [12.5, 34.5] })
    expect(seeds[0].classId).toBe(c)
    expect(seeds[1].classId).toBeNull()
    // every feature carries the id it was committed under, so a processor can correlate results
    expect(seeds.every(f => typeof f.id === 'string' && f.id.length > 0)).toBe(true)

    // The payload is exactly what `ProcessorPort.commitPoints` accepts — round-trip it through a
    // second store via the same shape to prove no translation layer is needed.
    const s2 = mkStore()
    const ids = s2.getState().commitResult(
      seeds.map(f => ({
        geometry: { kind: 'point' as const, xy: (f.geometry as unknown as { xy: [number, number] }).xy },
        classId: f.classId ?? null,
      })),
    )
    expect(ids.length).toBe(2)
    expect(annotationTally(s2.getState()).total).toBe(2)
  })

  it('is pure — the returned payload is a fresh array that does not alias store state', () => {
    const s = mkStore()
    addPoint(s, [0, 0], null)
    const a = pointSeedFeatures(s.getState())
    const b = pointSeedFeatures(s.getState())
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
    const before = s.getState().ids.length
    a.length = 0 // mutating the snapshot must not touch the store
    expect(s.getState().ids.length).toBe(before)
  })
})
