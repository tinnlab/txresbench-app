// createProcessorPort.test.ts (ITEM-8) — the acceptance proof for the concrete processor port.
//
// Proves the two halves ITEM-8 requires against a REAL per-cell `AnnotateStore`:
//  • WRITE — `commitPolygons` / `commitPoints` land in the store (indistinguishable from
//    hand-drawn: same `byId`/`ids`, undoable), `commitLabelMask` routes into the injected mask
//    sink, `setPending` flips the injected pending flag, and `origin`/`groupId` re-runs replace
//    their own prior output (napari's update-by-group contract).
//  • READ — `getViewState` / `getActiveGesture` / `getImageRef` return the seeded snapshots.

import { describe, it, expect } from 'vitest'
import { createProcessorPort, type ProcessorPortDeps } from './createProcessorPort'
import { createAnnotateStore, type AnnotateStore, MAX_HISTORY } from '../viz-core/annotate/Annotate.store'
import type {
  Gesture,
  ImageRef,
  LabelMaskResult,
  PendingState,
  ProcessorViewState,
  GeoFeature,
} from '../viz-core/annotate/processorPort'

const IMAGE_REF: ImageRef = {
  sourceId: 'fixture-image-0',
  width: 4096,
  height: 4096,
  levelCount: 3,
  channelCount: 2,
  pixelSize: [0.5, 0.5],
}
const VIEW_STATE: ProcessorViewState = { center: [2048, 2048], zoom: -2, bounds: [0, 0, 4096, 4096] }
const GESTURE: Gesture = { kind: 'lasso', ring: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]) }

const POLY: GeoFeature = {
  geometry: { kind: 'polygon', rings: [new Float64Array([0, 0, 10, 0, 10, 10, 0, 10])] },
  classId: 'tumor',
  label: 'region 1',
  properties: { measurements: { area: 123.5 } },
}
const POINT: GeoFeature = { geometry: { kind: 'point', xy: [5, 5] }, classId: null, label: null }

/** A test harness: a fresh store + a port over it, with the mask/pending sinks captured. */
function setup(gesture: Gesture | null = GESTURE) {
  const store: AnnotateStore = createAnnotateStore()
  const masks: { mask: LabelMaskResult | null; groupId: string }[] = []
  const pendings: (PendingState | null)[] = []
  const deps: ProcessorPortDeps = {
    store,
    getImageRef: () => IMAGE_REF,
    getViewState: () => VIEW_STATE,
    getActiveGesture: () => gesture,
    onMask: (mask, meta) => masks.push({ mask, groupId: meta.groupId }),
    onPending: p => pendings.push(p),
  }
  return { store, port: createProcessorPort(deps), masks, pendings }
}

describe('createProcessorPort — ITEM-8 concrete seam', () => {
  it('READ: getImageRef / getViewState / getActiveGesture return the seeded snapshots', () => {
    const { port } = setup()
    expect(port.getImageRef()).toEqual(IMAGE_REF)
    expect(port.getViewState()).toEqual(VIEW_STATE)
    const g = port.getActiveGesture()
    expect(g?.kind).toBe('lasso')
    if (g?.kind === 'lasso') expect(Array.from(g.ring)).toEqual([0, 0, 10, 0, 10, 10, 0, 10])
  })

  it('getActiveGesture returns null when no gesture is active', () => {
    const { port } = setup(null)
    expect(port.getActiveGesture()).toBeNull()
  })

  it('WRITE: commitPolygons lands in the store (indistinguishable from hand-drawn)', () => {
    const { store, port } = setup()
    const res = port.commitPolygons([POLY])
    expect(res.ids).toHaveLength(1)
    expect(res.replaced).toBe(0)

    const s = store.getState()
    expect(s.ids).toEqual(res.ids)
    const a = s.byId[res.ids[0]]
    expect(a.geometry.kind).toBe('polygon')
    expect(a.classId).toBe('tumor')
    expect(a.label).toBe('region 1')
    expect(a.properties).toEqual({ measurements: { area: 123.5 } })
    // undoable — the commit is one history entry that clears the collection back to empty.
    expect(s.canUndo).toBe(true)
    store.getState().undo()
    expect(store.getState().ids).toHaveLength(0)
  })

  it('WRITE: commitPoints lands point features in the store', () => {
    const { store, port } = setup()
    const res = port.commitPoints([POINT])
    expect(res.ids).toHaveLength(1)
    const a = store.getState().byId[res.ids[0]]
    expect(a.geometry.kind).toBe('point')
    if (a.geometry.kind === 'point') expect(a.geometry.xy).toEqual([5, 5])
  })

  it('WRITE: a multi-feature commit is ONE undo entry (whole batch)', () => {
    const { store, port } = setup()
    port.commitPolygons([POLY, POLY, POLY])
    expect(store.getState().ids).toHaveLength(3)
    expect(store.getState().undoStack).toHaveLength(1)
    store.getState().undo()
    expect(store.getState().ids).toHaveLength(0)
  })

  it('WRITE: commitLabelMask routes into the mask sink and returns a group', () => {
    const { port, masks } = setup()
    const mask: LabelMaskResult = {
      data: Uint32Array.of(0, 1, 1, 2),
      width: 2,
      height: 2,
      categoryForId: [0, 1, 1, 2],
      bounds: [0, 0, 2, 2],
    }
    const res = port.commitLabelMask(mask, { groupId: 'seg-1' })
    expect(masks).toHaveLength(1)
    expect(masks[0].mask).toBe(mask)
    expect(masks[0].groupId).toBe('seg-1')
    expect(res.groupId).toBe('seg-1')
    expect(res.replaced).toBe(0)
  })

  it('WRITE: setPending flips the display flag (set then clear) — INV-3, no inference', () => {
    const { port, pendings } = setup()
    port.setPending({ message: 'Segmenting…', progress: 0.5, region: [0, 0, 10, 10] })
    port.setPending(null)
    expect(pendings).toEqual([{ message: 'Segmenting…', progress: 0.5, region: [0, 0, 10, 10] }, null])
  })

  it('update-by-group: a re-run with the same origin/groupId REPLACES its prior output', () => {
    const { store, port } = setup()
    const first = port.commitPolygons([POLY, POLY], { origin: 'sam2', groupId: 'run-1' })
    expect(first.replaced).toBe(0)
    expect(store.getState().ids).toHaveLength(2)

    const second = port.commitPolygons([POLY], { origin: 'sam2', groupId: 'run-1' })
    expect(second.replaced).toBe(2) // the two prior features were removed
    expect(store.getState().ids).toHaveLength(1) // only the new run remains
    expect(store.getState().ids).toEqual(second.ids)
    expect(second.groupId).toBe('run-1')
  })

  it('update-by-mask-group: a re-run with the same key reports replaced', () => {
    const { port } = setup()
    const mask: LabelMaskResult = { data: Uint16Array.of(0, 1), width: 2, height: 1 }
    expect(port.commitLabelMask(mask, { groupId: 'm' }).replaced).toBe(0)
    expect(port.commitLabelMask(mask, { groupId: 'm' }).replaced).toBe(1)
  })

  it('a commit with a defaultClass registers the class and applies it to unclassed features', () => {
    const { store, port } = setup()
    const res = port.commitPolygons(
      [{ geometry: { kind: 'polygon', rings: [new Float64Array([0, 0, 4, 0, 4, 4])] } }],
      { defaultClass: { id: 'stroma', name: 'Stroma', color: [10, 20, 30] } },
    )
    expect(store.getState().classes.some(c => c.id === 'stroma')).toBe(true)
    expect(store.getState().byId[res.ids[0]].classId).toBe('stroma')
  })

  it('a non-fullRes commit without a coords facade throws (INV-4 honesty)', () => {
    const { port } = setup()
    expect(() => port.commitPolygons([POLY], { space: 'physical' })).toThrow(/coords/)
  })

  // ── INV-6 hardening: mask undoability, atomic replace, space honesty, stable ids ──────────

  it('a label-mask commit is a SINGLE undoable store entry — Undo reverts it, Redo re-applies', () => {
    const { store, port, masks } = setup()
    const mask: LabelMaskResult = { data: Uint16Array.of(0, 1, 1, 0), width: 2, height: 2, bounds: [0, 0, 2, 2] }
    const res = port.commitLabelMask(mask, { groupId: 'seg' })

    // ONE undo atom, and the mask is now a real (exportable) annotation in the store.
    expect(store.getState().undoStack).toHaveLength(1)
    expect(store.getState().canUndo).toBe(true)
    expect(store.getState().ids).toContain(res.ids[0])
    expect(masks.at(-1)?.mask).toBe(mask) // shown via the onMask sink

    // Undo hides the mask (the sink is reconciled to null) and removes the placeholder.
    store.getState().undo()
    expect(masks.at(-1)?.mask).toBeNull()
    expect(store.getState().ids).toHaveLength(0)

    // Redo re-shows the exact raster.
    store.getState().redo()
    expect(masks.at(-1)?.mask).toBe(mask)
    expect(store.getState().ids).toContain(res.ids[0])
  })

  it('update-by-group re-run is ONE atomic undo entry (a single Undo restores the exact prior state)', () => {
    const { store, port } = setup()
    const first = port.commitPolygons([POLY, POLY], { origin: 'sam2', groupId: 'run-1' })
    const afterFirst = store.getState().undoStack.length
    expect(afterFirst).toBe(1)

    const second = port.commitPolygons([POLY], { origin: 'sam2', groupId: 'run-1' })
    expect(second.replaced).toBe(2)
    expect(store.getState().ids).toEqual(second.ids)
    // The whole delete-2 + add-1 re-run coalesced into EXACTLY ONE new undo entry.
    expect(store.getState().undoStack.length).toBe(afterFirst + 1)

    // A single Undo restores the exact prior state (the first run's two features), never a
    // half-deleted group.
    store.getState().undo()
    expect(store.getState().ids).toEqual(first.ids)
    for (const id of first.ids) expect(store.getState().byId[id]).toBeTruthy()

    // Redo re-applies the whole replace as one atom.
    store.getState().redo()
    expect(store.getState().ids).toEqual(second.ids)
  })

  it('update-by-group re-run at MAX_HISTORY is ONE atomic entry that restores the exact prior state (NF-6)', () => {
    const { store, port } = setup()
    // First run establishes group 'run' with TWO live features.
    const first = port.commitPolygons([POLY, POLY], { origin: 'g', groupId: 'run' })
    expect(store.getState().undoStack).toHaveLength(1)

    // Fill the undo history to EXACTLY MAX_HISTORY with unrelated single commits (no group).
    for (let i = 1; i < MAX_HISTORY; i++) port.commitPolygons([POINT])
    expect(store.getState().undoStack).toHaveLength(MAX_HISTORY)
    // The group's two priors are still LIVE (history is full, but annotations remain).
    for (const id of first.ids) expect(store.getState().byId[id]).toBeTruthy()

    // Snapshot the stack ENTRY OBJECTS so we can prove the re-run added exactly ONE new entry
    // even though the store front-evicts (shifts) at the cap during the run.
    const beforeEntries = new Set(store.getState().undoStack)

    // Re-run the group at the cap: delete-2 + add-1.
    const second = port.commitPolygons([POLY], { origin: 'g', groupId: 'run' })
    expect(second.replaced).toBe(2)

    // Exactly ONE new undo entry (the coalesced atom) — the old absolute-index coalescer failed
    // to coalesce here (leaving 2–3 entries, a partial Undo). Identity-tracking gets it right.
    const pushed = store.getState().undoStack.filter(e => !beforeEntries.has(e))
    expect(pushed).toHaveLength(1)

    // A single Undo restores the EXACT prior state: both group features back, the new one gone —
    // never a half-deleted group.
    store.getState().undo()
    for (const id of first.ids) expect(store.getState().byId[id]).toBeTruthy()
    expect(store.getState().byId[second.ids[0]]).toBeUndefined()

    // Redo re-applies the whole replace as one atom.
    store.getState().redo()
    expect(store.getState().byId[second.ids[0]]).toBeTruthy()
    for (const id of first.ids) expect(store.getState().byId[id]).toBeUndefined()
  })

  it('a re-run of a group beyond the former tracking cap still REPLACES, not duplicates (NF-8)', () => {
    const { store, port } = setup()
    // First run for group 'g0' — one feature.
    const first = port.commitPolygons([POLY], { groupId: 'g0' })
    expect(first.replaced).toBe(0)
    // Now drive MANY more DISTINCT groups (well beyond the old 64-entry recency cap) so an
    // evicting bookkeeping map would have dropped g0's ids by now.
    for (let i = 1; i <= 100; i++) port.commitPolygons([POLY], { groupId: `g${i}` })
    const countBefore = store.getState().ids.length
    expect(countBefore).toBe(101)

    // Re-run g0: it MUST replace its still-live prior feature, not append a duplicate.
    const rerun = port.commitPolygons([POLY], { groupId: 'g0' })
    expect(rerun.replaced).toBe(1)
    expect(store.getState().ids.length).toBe(countBefore) // net zero: one removed, one added
    expect(store.getState().byId[first.ids[0]]).toBeUndefined() // old g0 output gone
    expect(store.getState().byId[rerun.ids[0]]).toBeTruthy() // new g0 output present
  })

  it('dispose() drops the store subscription — a later store change does not fire the reconciler (NF-7)', () => {
    const { store, port, masks } = setup()
    const mask: LabelMaskResult = { data: Uint16Array.of(0, 1, 1, 0), width: 2, height: 2, bounds: [0, 0, 2, 2] }
    port.commitLabelMask(mask, { groupId: 'seg' })
    const shown = masks.length
    expect(shown).toBeGreaterThan(0) // mask emitted into the sink

    port.dispose()

    // Without dispose, an Undo would fire the subscription → reconcileMasks → onMask(null). After
    // dispose the subscription is gone, so the sink is never touched again.
    store.getState().undo()
    expect(masks.length).toBe(shown)
    // dispose is idempotent.
    expect(() => port.dispose()).not.toThrow()
  })

  it('a non-fullRes label-mask commit without a coords facade throws (INV-4, consistent with vectors)', () => {
    const { port } = setup()
    const mask: LabelMaskResult = { data: Uint16Array.of(0, 1), width: 2, height: 1 }
    expect(() => port.commitLabelMask(mask, { space: 'physical' })).toThrow(/coords/)
  })

  it('a committed feature preserves a supplied GeoFeature id (stable identity across a re-run)', () => {
    const { store, port } = setup()
    const feat: GeoFeature = { id: 'feat-1', geometry: { kind: 'point', xy: [7, 7] }, classId: null, label: null }
    const res = port.commitPolygons([feat], { origin: 'p', groupId: 'g1' })
    expect(res.ids).toEqual(['feat-1'])
    expect(store.getState().byId['feat-1']).toBeTruthy()

    // A re-run supplying the SAME id keeps that identity (update-by-group replaces in place).
    const res2 = port.commitPolygons(
      [{ id: 'feat-1', geometry: { kind: 'point', xy: [9, 9] } }],
      { origin: 'p', groupId: 'g1' },
    )
    expect(res2.ids).toEqual(['feat-1'])
    expect(res2.replaced).toBe(1)
    expect(store.getState().ids).toEqual(['feat-1'])
    const a = store.getState().byId['feat-1']
    if (a.geometry.kind === 'point') expect(a.geometry.xy).toEqual([9, 9])
  })
})
