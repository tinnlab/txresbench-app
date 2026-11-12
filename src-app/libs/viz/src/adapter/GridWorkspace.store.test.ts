import { describe, it, expect } from 'vitest'
import { createGridWorkspaceStore, INITIAL_CELL_ID, EMPTY_GRID_ID } from './GridWorkspace.store'
import { leafIds } from '@txresbench/dock'

const sorted = (xs: string[]) => [...xs].sort()
/** ids docked in the grid container (`layout`). */
const gridIds = (s: ReturnType<typeof createGridWorkspaceStore>) => sorted(leafIds(s.getState().layout))
/** ids docked in a popup container. */
const popupIds = (s: ReturnType<typeof createGridWorkspaceStore>, c: string) => {
  const t = s.getState().containerLayouts[c]
  return t ? sorted(leafIds(t)) : []
}

/** A fresh store with cells `cell-1, cell-2, cell-3` in the grid. */
function threeCellGrid() {
  const s = createGridWorkspaceStore()
  const b = s.getState().splitCell(INITIAL_CELL_ID, 'row') // cell-2
  s.getState().splitCell(b, 'row') // cell-3
  return s
}

describe('multi-container store — single-grid invariant (no docking)', () => {
  it('a fresh store is single-grid: empty containers/assignments, byte-identical layout', () => {
    const s = createGridWorkspaceStore()
    expect(gridIds(s)).toEqual([INITIAL_CELL_ID])
    expect(s.getState().containerLayouts).toEqual({})
    expect(s.getState().paneContainer).toEqual({})
    expect(s.getState().pendingClose).toEqual([])
  })

  it('addCell/splitCell/removeCell/swap leave the docking state empty (new panes default to grid)', () => {
    const s = threeCellGrid()
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3'])
    expect(s.getState().containerLayouts).toEqual({})
    expect(s.getState().paneContainer).toEqual({})
    s.getState().removeCell('cell-2')
    expect(gridIds(s)).toEqual(['cell-1', 'cell-3'])
    expect(s.getState().containerLayouts).toEqual({})
  })
})

describe('movePane store action', () => {
  it('grid → new popup: grid reflows, popup tree gets the cell, paneContainer set', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    expect(gridIds(s)).toEqual(['cell-1', 'cell-3']) // reflowed
    expect(popupIds(s, 'popup:1')).toEqual(['cell-2'])
    expect(s.getState().paneContainer['cell-2']).toBe('popup:1')
    expect(s.getState().pendingClose).toEqual([])
  })

  it('last pane out of a popup queues it for close', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' }) // popup:1 = [cell-2]
    s.getState().movePane('cell-2', 'popup:2', { kind: 'root' }) // popup:1 now empty
    expect(s.getState().containerLayouts['popup:1']).toBeUndefined()
    expect(popupIds(s, 'popup:2')).toEqual(['cell-2'])
    expect(s.getState().pendingClose).toEqual(['popup:1'])
  })

  it('moving a pane INTO a pending-close container revives it (drains pendingClose)', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' }) // popup:1 = [cell-2]
    s.getState().movePane('cell-2', 'popup:2', { kind: 'root' }) // popup:1 emptied → pendingClose
    expect(s.getState().pendingClose).toEqual(['popup:1'])
    s.getState().movePane('cell-3', 'popup:1', { kind: 'root' }) // a pane moves back IN → revive
    expect(popupIds(s, 'popup:1')).toEqual(['cell-3'])
    expect(s.getState().pendingClose).toEqual([]) // no longer queued for close (window kept open)
  })

  it('moving ALL grid cells out sets the empty-grid sentinel', () => {
    const s = createGridWorkspaceStore() // just cell-1
    s.getState().movePane(INITIAL_CELL_ID, 'popup:1', { kind: 'root' })
    expect(s.getState().layout).toEqual({ kind: 'leaf', id: EMPTY_GRID_ID })
    expect(popupIds(s, 'popup:1')).toEqual([INITIAL_CELL_ID])
  })
})

describe('returnPaneToGrid + acknowledgeContainerClose', () => {
  it('returns a popped pane to the grid and queues the emptied popup', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().returnPaneToGrid('cell-2')
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3']) // appended back
    expect(s.getState().paneContainer['cell-2']).toBeUndefined() // back to grid default
    expect(s.getState().pendingClose).toEqual(['popup:1'])
  })

  it('restores to a remembered slot when it still exists', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().returnPaneToGrid('cell-2', { kind: 'split', atLeaf: 'cell-1', dir: 'col' })
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3'])
  })

  it('acknowledgeContainerClose drains the queue', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().movePane('cell-2', 'main', { kind: 'split', atLeaf: 'cell-1', dir: 'col' })
    expect(s.getState().pendingClose).toEqual(['popup:1'])
    s.getState().acknowledgeContainerClose('popup:1')
    expect(s.getState().pendingClose).toEqual([])
  })
})

/** grid: cell-1,cell-3 · popup:1: cell-2 (via movePane). */
function gridWithPopup() {
  const s = threeCellGrid()
  s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
  return s
}

describe('container-aware chrome actions (P3a)', () => {
  it('grid actions with the DEFAULT containerId are byte-identical + leave docking state empty', () => {
    const s = threeCellGrid()
    const newId = s.getState().splitCell('cell-1', 'row') // default → grid
    expect(gridIds(s)).toContain(newId)
    expect(s.getState().containerLayouts).toEqual({})
    expect(s.getState().paneContainer).toEqual({}) // grid cells stay sparse-absent
    s.getState().removeCell(newId) // default → grid
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3'])
    expect(s.getState().containerLayouts).toEqual({})
    expect(s.getState().paneContainer).toEqual({})
  })

  it("explicit containerId='grid' equals the default (byte-identical)", () => {
    const a = threeCellGrid()
    const b = threeCellGrid()
    const ai = a.getState().splitCell('cell-1', 'row')
    const bi = b.getState().splitCell('cell-1', 'row', 'scatter', 'main')
    expect(ai).toBe(bi)
    expect(gridIds(a)).toEqual(gridIds(b))
    expect(a.getState().paneContainer).toEqual(b.getState().paneContainer)
    a.getState().resizeDivider([0], 0, 0.1)
    b.getState().resizeDivider([0], 0, 0.1, 'main')
    expect(a.getState().layout).toEqual(b.getState().layout)
  })

  it('splitCell in a popup mutates only that container; grid untouched; new pane assigned to it', () => {
    const s = gridWithPopup()
    const gridBefore = s.getState().layout
    const newId = s.getState().splitCell('cell-2', 'row', 'scatter', 'popup:1')
    expect(popupIds(s, 'popup:1')).toEqual(sorted(['cell-2', newId]))
    expect(gridIds(s)).toEqual(['cell-1', 'cell-3']) // grid unchanged
    expect(s.getState().layout).toBe(gridBefore) // grid layout ref untouched
    expect(s.getState().paneContainer[newId]).toBe('popup:1')
  })

  it('addCell targets the popup container; grid untouched', () => {
    const s = gridWithPopup()
    const newId = s.getState().addCell('col', 'scatter', 'popup:1')
    expect(popupIds(s, 'popup:1')).toEqual(sorted(['cell-2', newId]))
    expect(s.getState().paneContainer[newId]).toBe('popup:1')
    expect(gridIds(s)).toEqual(['cell-1', 'cell-3'])
  })

  it('removeCell in a popup: a non-last pane is deleted; grid untouched; paneContainer cleaned', () => {
    const s = gridWithPopup()
    s.getState().splitCell('cell-2', 'row', 'scatter', 'popup:1') // popup:1 = [cell-2, cell-4]
    s.getState().removeCell('cell-2', 'popup:1')
    expect(popupIds(s, 'popup:1')).toEqual(['cell-4'])
    expect(s.getState().cells['cell-2']).toBeUndefined() // deleted, not moved
    expect(s.getState().paneContainer['cell-2']).toBeUndefined()
    expect(gridIds(s)).toEqual(['cell-1', 'cell-3'])
    expect(s.getState().pendingClose).toEqual([]) // popup still has a pane
  })

  it('removeCell of the LAST popup pane empties the container + queues pendingClose', () => {
    const s = gridWithPopup() // popup:1 = [cell-2]
    s.getState().removeCell('cell-2', 'popup:1')
    expect(s.getState().containerLayouts['popup:1']).toBeUndefined()
    expect(s.getState().cells['cell-2']).toBeUndefined()
    expect(s.getState().paneContainer['cell-2']).toBeUndefined()
    expect(s.getState().pendingClose).toEqual(['popup:1'])
  })

  it('cross-container isolation: a grid split never touches a popup, and vice versa', () => {
    const s = gridWithPopup() // grid: cell-1,cell-3 · popup:1: cell-2
    const g = s.getState().splitCell('cell-1', 'row') // grid
    expect(popupIds(s, 'popup:1')).toEqual(['cell-2']) // popup unchanged by a grid split
    const p = s.getState().splitCell('cell-2', 'row', 'scatter', 'popup:1') // popup
    expect(gridIds(s)).toEqual(sorted(['cell-1', 'cell-3', g])) // grid unchanged by a popup split
    expect(popupIds(s, 'popup:1')).toEqual(sorted(['cell-2', p]))
  })

  it('resizeDivider targets the given container and leaves the grid layout ref untouched', () => {
    const s = gridWithPopup()
    s.getState().splitCell('cell-2', 'row', 'scatter', 'popup:1') // popup:1 now has a divider
    const gridBefore = s.getState().layout
    const popupBefore = s.getState().containerLayouts['popup:1']
    s.getState().resizeDivider([0], 0, 0.1, 'popup:1')
    expect(s.getState().layout).toBe(gridBefore) // grid untouched
    expect(s.getState().containerLayouts['popup:1']).not.toBe(popupBefore) // popup tree changed
  })

  it('addCell / resizeDivider on an absent (empty) popup container is a safe no-op', () => {
    const s = threeCellGrid()
    expect(s.getState().addCell('col', 'scatter', 'popup:9')).toBe('')
    s.getState().resizeDivider([0], 0, 0.1, 'popup:9') // no throw
    expect(s.getState().containerLayouts).toEqual({})
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3'])
  })
})

describe('return-position memory (P5 §6)', () => {
  it('records a move-out anchor and restores the pane beside its old sibling on a no-arg return', () => {
    const s = threeCellGrid() // grid row[cell-1, cell-2, cell-3]
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    // anchor for cell-2 = its NEAREST sibling. The tree is row[cell-1, row[cell-2, cell-3]] (splitCell
    // nests), so cell-2's parent split is row[cell-2, cell-3] → sibling cell-3, dir 'row'.
    expect(s.getState().returnAnchors['cell-2']).toEqual({ kind: 'split', atLeaf: 'cell-3', dir: 'row' })
    s.getState().returnPaneToGrid('cell-2') // NO explicit slot → uses the anchor
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3'])
    // anchor cleared after the return.
    expect(s.getState().returnAnchors['cell-2']).toBeUndefined()
  })

  it('clears the anchor when a pane is dragged back to the main (not via close)', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    expect(s.getState().returnAnchors['cell-2']).toBeDefined()
    s.getState().movePane('cell-2', 'main', { kind: 'split', atLeaf: 'cell-1', dir: 'col' })
    expect(s.getState().returnAnchors['cell-2']).toBeUndefined()
  })
})

describe('session serialize/hydrate — docking (P5)', () => {
  it('single-window session emits NO docking keys (back-compat slice)', () => {
    const s = threeCellGrid()
    const slice = s.getState().serialize()
    expect(slice.containerLayouts).toBeUndefined()
    expect(slice.paneContainer).toBeUndefined()
    expect(slice.returnAnchors).toBeUndefined()
  })

  it('a docked session serializes the multi-container layout + assignments', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    const slice = s.getState().serialize()
    expect(slice.paneContainer).toEqual({ 'cell-2': 'popup:1' })
    expect(Object.keys(slice.containerLayouts ?? {})).toEqual(['popup:1'])
    expect(slice.returnAnchors?.['cell-2']).toBeDefined()
  })

  it('hydrate restores the docked layout + lists popups in pendingRestore', () => {
    const src = threeCellGrid()
    src.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    src.getState().movePane('cell-3', 'popup:2', { kind: 'root' })
    const slice = src.getState().serialize()

    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(slice)
    expect(gridIds(dst)).toEqual(['cell-1'])
    expect(popupIds(dst, 'popup:1')).toEqual(['cell-2'])
    expect(popupIds(dst, 'popup:2')).toEqual(['cell-3'])
    expect(sorted(dst.getState().pendingRestore)).toEqual(['popup:1', 'popup:2'])
  })

  it('a legacy single-window slice hydrates with NO pendingRestore', () => {
    const dst = createGridWorkspaceStore()
    dst.getState().hydrate({ layout: { kind: 'leaf', id: 'x' }, cells: { x: { id: 'x', kind: 'scatter', layoutId: 'primary' } }, seq: 1 })
    expect(dst.getState().pendingRestore).toEqual([])
    expect(dst.getState().paneContainer).toEqual({})
  })
})

describe('session-restore choice actions (P5)', () => {
  function restoredTwoPopups() {
    const src = threeCellGrid()
    src.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    src.getState().movePane('cell-3', 'popup:2', { kind: 'root' })
    const dst = createGridWorkspaceStore()
    dst.getState().hydrate(src.getState().serialize())
    return dst
  }

  it('mergeRestoredToPrimary folds every pending popup pane back into the main + clears restore state', () => {
    const s = restoredTwoPopups()
    s.getState().mergeRestoredToPrimary()
    expect(gridIds(s)).toEqual(['cell-1', 'cell-2', 'cell-3'])
    expect(s.getState().containerLayouts).toEqual({})
    expect(s.getState().paneContainer).toEqual({})
    expect(s.getState().pendingRestore).toEqual([])
  })

  it('resolveRestored drains ONLY the opened popups (a blocked one stays pending)', () => {
    const s = restoredTwoPopups()
    s.getState().resolveRestored(['popup:1']) // popup:2 stayed blocked
    expect(s.getState().pendingRestore).toEqual(['popup:2'])
    // the panes are untouched (still assigned) — nothing lost.
    expect(popupIds(s, 'popup:1')).toEqual(['cell-2'])
    expect(popupIds(s, 'popup:2')).toEqual(['cell-3'])
  })

  it('a partial reopen then Merge keeps the ALREADY-reopened popup (and its return anchor) intact', () => {
    const s = restoredTwoPopups()
    expect(s.getState().returnAnchors['cell-2']).toBeDefined() // restored anchor for the popup:1 pane
    s.getState().resolveRestored(['popup:1']) // popup:1 reopened; popup:2 still pending
    s.getState().mergeRestoredToPrimary() // merge folds ONLY the still-pending popup:2
    expect(popupIds(s, 'popup:1')).toEqual(['cell-2']) // the reopened popup kept its pane
    expect(gridIds(s)).toContain('cell-3') // popup:2's pane merged into the main
    expect(s.getState().returnAnchors['cell-2']).toBeDefined() // popup:1's anchor PRESERVED
    expect(s.getState().returnAnchors['cell-3']).toBeUndefined() // merged pane's anchor cleared
  })
})

describe('aim-to-place (P5)', () => {
  it('requestAddCell with NO popup open adds directly to the main (no placement)', () => {
    const s = threeCellGrid()
    const id = s.getState().requestAddCell('col')
    expect(id).toMatch(/^cell-/)
    expect(s.getState().pendingPlacement).toBeNull()
    expect(gridIds(s)).toContain(id)
  })

  it('requestAddCell with a popup open DEFERS to placement (no cell created yet)', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    const before = sorted([...gridIds(s), ...popupIds(s, 'popup:1')])
    const id = s.getState().requestAddCell('col')
    expect(id).toBe('')
    expect(s.getState().pendingPlacement).toEqual({ kind: 'scatter' })
    // no new cell appeared.
    expect(sorted([...gridIds(s), ...popupIds(s, 'popup:1')])).toEqual(before)
  })

  it('placeNewCell splits beside a MAIN cell and clears pendingPlacement', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().requestAddCell('col')
    const id = s.getState().placeNewCell('main', { kind: 'split', atLeaf: 'cell-1', dir: 'col' }, 'scatter')
    expect(gridIds(s)).toContain(id)
    expect(s.getState().pendingPlacement).toBeNull()
    expect(s.getState().cells[id].kind).toBe('scatter')
  })

  it('placeNewCell into a POPUP container assigns the new cell to it', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    const id = s.getState().placeNewCell('popup:1', { kind: 'split', atLeaf: 'cell-2', dir: 'row' }, 'scatter')
    expect(popupIds(s, 'popup:1')).toContain(id)
    expect(s.getState().paneContainer[id]).toBe('popup:1')
  })

  it('placeNewCell with a root drop into an EMPTY container becomes its root leaf', () => {
    const s = createGridWorkspaceStore() // just cell-1 in main
    s.getState().movePane('cell-1', 'popup:1', { kind: 'root' }) // main now empty
    const id = s.getState().placeNewCell('main', { kind: 'root' }, 'scatter')
    expect(gridIds(s)).toEqual([id])
  })

  it('placeNewCell with a root drop into a POPULATED main APPENDS — never wipes existing cells', () => {
    // Regression: aim-to-place maps a gutter/margin click (no pane under the cursor) to a `root` drop.
    // That must ADD the new plot to the main, NOT replace the whole main tree (data loss).
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' }) // main = [cell-1, cell-3], popup open
    const before = gridIds(s)
    const id = s.getState().placeNewCell('main', { kind: 'root' }, 'scatter')
    expect(gridIds(s)).toEqual(sorted([...before, id])) // existing main cells survive + new one added
    expect(s.getState().pendingPlacement).toBeNull()
  })

  it('cancelPlacement clears the pending request', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().requestAddCell('col')
    expect(s.getState().pendingPlacement).not.toBeNull()
    s.getState().cancelPlacement()
    expect(s.getState().pendingPlacement).toBeNull()
  })
})

describe('global ≥1-cell invariant + empty-grid recovery (audit G-MEDHIGH-1)', () => {
  it('refuses to remove the globally-last cell (popped-out then Removed in the popup)', () => {
    const s = createGridWorkspaceStore() // just cell-1 in the main
    s.getState().movePane('cell-1', 'popup:1', { kind: 'root' }) // main empty (sentinel), cell-1 in popup
    s.getState().removeCell('cell-1', 'popup:1') // would strand zero cells → must NO-OP
    expect(Object.keys(s.getState().cells)).toEqual(['cell-1'])
    expect(popupIds(s, 'popup:1')).toEqual(['cell-1'])
  })

  it('allows removing the last PRIMARY cell when others live in popups (primary → empty sentinel)', () => {
    const s = threeCellGrid()
    s.getState().movePane('cell-2', 'popup:1', { kind: 'root' })
    s.getState().movePane('cell-3', 'popup:2', { kind: 'root' }) // main = [cell-1]; popups hold 2 & 3
    s.getState().removeCell('cell-1') // last primary cell, but cells remain in popups → allowed
    expect(gridIds(s)).toEqual([EMPTY_GRID_ID]) // primary empty sentinel
    expect(s.getState().cells['cell-1']).toBeUndefined()
    expect(sorted(Object.keys(s.getState().cells))).toEqual(['cell-2', 'cell-3'])
  })

  it('addCell RECOVERS an empty primary (all panes popped) by seeding a fresh root cell', () => {
    const s = createGridWorkspaceStore()
    s.getState().movePane('cell-1', 'popup:1', { kind: 'root' }) // main = empty sentinel
    expect(gridIds(s)).toEqual([EMPTY_GRID_ID])
    const id = s.getState().addCell('col', 'scatter') // must NOT be a no-op
    expect(id).toMatch(/^cell-/)
    expect(gridIds(s)).toEqual([id]) // primary re-populated with a root cell
  })
})
