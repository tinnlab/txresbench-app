// GridWorkspace.docking.test.ts — serialize/hydrate ROUND-TRIP fidelity (ITEM-4 + ITEM-18 / DEC-5,5b,15).
//
// Two guarantees under test:
//  1. The RESOLVED layout tree (nested splits + `sizes` proportions) round-trips through
//     serialize → JSON → hydrate byte-for-byte — splits, swaps, and resizes all survive.
//  2. The multi-container DOCKING state (pop-out windows) round-trips via the consolidated
//     `docking` shape AND the legacy flat fields; `pendingPlacement` is TRANSIENT (never serialized).

import { describe, it, expect } from 'vitest'
import { createGridWorkspaceStore, INITIAL_CELL_ID, type GridWorkspaceSlice } from './GridWorkspace.store'
import { leafIds, type LayoutNode } from '@txresbench/dock'

const sorted = (xs: string[]) => [...xs].sort()
const popupIds = (s: ReturnType<typeof createGridWorkspaceStore>, c: string) => {
  const t = s.getState().containerLayouts[c]
  return t ? sorted(leafIds(t)) : []
}
/** serialize → JSON stringify+parse → the plain wire object a real save/restore would round-trip. */
const wireRoundTrip = (slice: GridWorkspaceSlice): GridWorkspaceSlice =>
  JSON.parse(JSON.stringify(slice)) as GridWorkspaceSlice

/** A store with a NESTED split whose dividers have been resized off the even default. */
function nestedResizedGrid() {
  const s = createGridWorkspaceStore()
  const b = s.getState().splitCell(INITIAL_CELL_ID, 'row') // row[cell-1, cell-2]
  s.getState().splitCell(b, 'row') // row[cell-1, row[cell-2, cell-3]]  (nested)
  s.getState().resizeDivider([], 0, 0.13) // move the OUTER (root) divider off 50/50
  s.getState().resizeDivider([1], 0, -0.07) // move the INNER (nested) divider off 50/50
  return s
}

describe('layout-tree round-trip (ITEM-4 / DEC-5)', () => {
  it('a nested split + resize round-trips through serialize→JSON→hydrate BYTE-FOR-BYTE', () => {
    const src = nestedResizedGrid()
    // Sanity: the live tree really is a nested split carrying non-even `sizes`.
    const live = src.getState().layout as Extract<LayoutNode, { kind: 'split' }>
    expect(live.kind).toBe('split')
    expect(live.sizes[0]).not.toBeCloseTo(0.5) // outer divider actually moved

    const slice = src.getState().serialize()
    const wire = wireRoundTrip(slice) // survives a real JSON persistence hop

    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(wire)

    // Byte-for-byte: the resolved tree (nested splits + every `sizes` fraction) is reproduced exactly.
    expect(dst.getState().layout).toEqual(src.getState().layout)
    expect(dst.getState().cells).toEqual(src.getState().cells)
    expect(dst.getState().seq).toBe(src.getState().seq)
  })

  it('a content SWAP survives the round-trip (positions/sizes unchanged, kinds traded)', () => {
    const src = nestedResizedGrid()
    src.getState().setCellKind('cell-1', 'heatmap')
    const treeBefore = structuredClone(src.getState().layout)
    src.getState().swapCells('cell-1', 'cell-3') // trade content, keep tree geometry

    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(wireRoundTrip(src.getState().serialize()))

    expect(dst.getState().layout).toEqual(treeBefore) // swap left the tree geometry untouched
    expect(dst.getState().cells['cell-1'].kind).toBe(src.getState().cells['cell-1'].kind)
    expect(dst.getState().cells['cell-3'].kind).toBe(src.getState().cells['cell-3'].kind)
  })

  it('single-window layout stays byte-identical (no docking keys emitted)', () => {
    const src = nestedResizedGrid()
    const slice = src.getState().serialize()
    expect(slice.docking).toBeUndefined()
    expect(slice.containerLayouts).toBeUndefined()
    expect(slice.paneContainer).toBeUndefined()
    expect(slice.returnAnchors).toBeUndefined()
  })
})

describe('docking round-trip (ITEM-18 / DEC-15)', () => {
  /** grid: cell-1,cell-3 (resized) · popup:1: cell-2 · popup:2: [cell-4 split beside]. */
  function dockedWorkspace() {
    const s = createGridWorkspaceStore()
    const b = s.getState().splitCell(INITIAL_CELL_ID, 'row') // cell-2
    s.getState().splitCell(b, 'row') // cell-3  → row[cell-1, row[cell-2, cell-3]]
    s.getState().resizeDivider([], 0, 0.1) // resize the grid (root divider)
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().movePane('cell-3', 'popup:2', { kind: 'root' })
    s.getState().splitCell('cell-3', 'col', 'heatmap', 'popup:2') // popup:2 has its own split + divider
    return s
  }

  it('serialize emits the consolidated `docking` shape (containers list + paneContainer + anchors)', () => {
    const s = dockedWorkspace()
    const slice = s.getState().serialize()
    expect(slice.docking).toBeDefined()
    const d = slice.docking!
    // containers = the NON-main container LIST (main's tree is `slice.layout`).
    expect(d.containers.map(c => c.id).sort()).toEqual(['popup:1', 'popup:2'])
    for (const c of d.containers) expect(c.layout).toEqual(s.getState().containerLayouts[c.id])
    // per-pane binding + return anchors.
    expect(d.paneContainer['cell-2']).toBe('popup:1')
    expect(d.paneContainer['cell-3']).toBe('popup:2')
    expect(d.anchors['cell-2']).toBeDefined()
    // The legacy flat fields are ALSO emitted (back-compat) and agree with the consolidated shape.
    expect(slice.paneContainer).toEqual(d.paneContainer)
    expect(slice.returnAnchors).toEqual(d.anchors)
  })

  it('a docked pop-out round-trips through serialize→JSON→hydrate (windows + trees + anchors)', () => {
    const src = dockedWorkspace()
    const wire = wireRoundTrip(src.getState().serialize())

    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(wire)

    // Main grid tree reproduced (with its resize) + both pop-out container trees + assignments.
    expect(dst.getState().layout).toEqual(src.getState().layout)
    expect(dst.getState().containerLayouts).toEqual(src.getState().containerLayouts)
    expect(dst.getState().paneContainer).toEqual(src.getState().paneContainer)
    expect(dst.getState().returnAnchors).toEqual(src.getState().returnAnchors)
    expect(popupIds(dst, 'popup:1')).toEqual(['cell-2'])
    expect(popupIds(dst, 'popup:2')).toEqual(sorted(['cell-3', 'cell-4']))
    // Restore lists the reopened-needed popups (no gesture on reload).
    expect(sorted(dst.getState().pendingRestore)).toEqual(['popup:1', 'popup:2'])
  })

  it('hydrate works from the `docking` shape ALONE (legacy flat fields stripped)', () => {
    const src = dockedWorkspace()
    const slice = wireRoundTrip(src.getState().serialize())
    // Drop the legacy flat fields — the consolidated `docking` snapshot must be self-sufficient.
    delete slice.containerLayouts
    delete slice.paneContainer
    delete slice.returnAnchors
    expect(slice.docking).toBeDefined()

    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(slice)
    expect(dst.getState().containerLayouts).toEqual(src.getState().containerLayouts)
    expect(dst.getState().paneContainer).toEqual(src.getState().paneContainer)
    expect(dst.getState().returnAnchors).toEqual(src.getState().returnAnchors)
  })

  it('hydrate still accepts a legacy flat-only slice (no `docking` key) — back-compat', () => {
    const src = dockedWorkspace()
    const slice = wireRoundTrip(src.getState().serialize())
    delete slice.docking // pre-DEC-15 slice: only the flat fields
    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(slice)
    expect(dst.getState().paneContainer).toEqual(src.getState().paneContainer)
    expect(popupIds(dst, 'popup:1')).toEqual(['cell-2'])
  })
})

describe('pendingPlacement is TRANSIENT — never serialized (DEC-5b)', () => {
  it('serialize omits pendingPlacement even while a placement is armed', () => {
    const s = createGridWorkspaceStore()
    const b = s.getState().splitCell(INITIAL_CELL_ID, 'row') // cell-2
    s.getState().movePane(b, 'popup:1', { kind: 'root' }) // a popup is open
    s.getState().requestAddCell('col') // arms pendingPlacement (aim-to-place)
    expect(s.getState().pendingPlacement).toEqual({ kind: 'scatter' }) // genuinely armed

    const slice = s.getState().serialize()
    expect('pendingPlacement' in slice).toBe(false)
    expect(JSON.stringify(slice)).not.toContain('pendingPlacement')

    // A hydrate of that slice lands with NO pending placement (a restored option never half-places).
    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(wireRoundTrip(slice))
    expect(dst.getState().pendingPlacement).toBeNull()
  })
})
