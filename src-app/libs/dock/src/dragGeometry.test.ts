import { describe, it, expect } from 'vitest'
import {
  dropZoneFor,
  isPointOutsideRect,
  resolveDrop,
  splitDirFor,
  zoneToSplit,
  type ContainerSnapshot,
  type DragRect,
} from './dragGeometry'

const rect = { left: 100, top: 50, right: 500, bottom: 400 }

describe('isPointOutsideRect', () => {
  it('is false for a point well inside', () => {
    expect(isPointOutsideRect(300, 200, rect)).toBe(false)
  })

  it('is true beyond each edge', () => {
    expect(isPointOutsideRect(99, 200, rect)).toBe(true) // left
    expect(isPointOutsideRect(501, 200, rect)).toBe(true) // right
    expect(isPointOutsideRect(300, 49, rect)).toBe(true) // top
    expect(isPointOutsideRect(300, 401, rect)).toBe(true) // bottom
  })

  it('counts the boundary as INSIDE (edge release stays in the main)', () => {
    expect(isPointOutsideRect(100, 50, rect)).toBe(false) // top-left corner
    expect(isPointOutsideRect(500, 400, rect)).toBe(false) // bottom-right corner
    expect(isPointOutsideRect(100, 200, rect)).toBe(false) // left edge
  })

  it('is true when outside on a diagonal (past a corner)', () => {
    expect(isPointOutsideRect(600, 500, rect)).toBe(true)
    expect(isPointOutsideRect(0, 0, rect)).toBe(true)
  })

  it('is false for a non-finite point (undecidable → never tear off)', () => {
    expect(isPointOutsideRect(NaN, 200, rect)).toBe(false)
    expect(isPointOutsideRect(300, Infinity, rect)).toBe(false)
  })

  it('is false for a degenerate/empty rect', () => {
    expect(isPointOutsideRect(300, 200, { left: 500, top: 400, right: 100, bottom: 50 })).toBe(false)
  })
})

describe('splitDirFor', () => {
  const rect = { left: 0, top: 0, right: 200, bottom: 100 } // 2:1 landscape

  it("picks 'col' (side-by-side) when the pointer is horizontally dominant", () => {
    // near the left/right edge, mid-height → horizontal offset dominates the normalized comparison.
    expect(splitDirFor(190, 50, rect)).toBe('col')
    expect(splitDirFor(10, 50, rect)).toBe('col')
  })

  it("picks 'row' (stacked) when the pointer is vertically dominant", () => {
    // near the top/bottom edge, mid-width → vertical offset dominates.
    expect(splitDirFor(100, 95, rect)).toBe('row')
    expect(splitDirFor(100, 5, rect)).toBe('row')
  })

  it("defaults to 'col' at dead center (ties → col)", () => {
    expect(splitDirFor(100, 50, rect)).toBe('col')
  })

  it("defaults to 'col' for a degenerate (zero-size) rect", () => {
    expect(splitDirFor(5, 5, { left: 10, top: 10, right: 10, bottom: 10 })).toBe('col')
  })
})

describe('dropZoneFor ("+"-cross partition)', () => {
  const r = { left: 0, top: 0, right: 100, bottom: 100 } // 100×100, center (50,50)

  it('returns center for the middle square', () => {
    expect(dropZoneFor(50, 50, r)).toBe('center')
    expect(dropZoneFor(60, 45, r)).toBe('center') // within ±34% of each half-axis
  })
  it('returns the edge arm the pointer is furthest along', () => {
    expect(dropZoneFor(5, 50, r)).toBe('left')
    expect(dropZoneFor(95, 50, r)).toBe('right')
    expect(dropZoneFor(50, 5, r)).toBe('top')
    expect(dropZoneFor(50, 95, r)).toBe('bottom')
  })
  it('resolves a corner by axis dominance (ties → horizontal)', () => {
    expect(dropZoneFor(2, 2, r)).toBe('left') // |nx| === |ny| → left/right wins
    expect(dropZoneFor(98, 2, r)).toBe('right')
  })
  it('a degenerate (zero-size) rect → center', () => {
    expect(dropZoneFor(5, 5, { left: 10, top: 10, right: 10, bottom: 10 })).toBe('center')
  })
})

describe('zoneToSplit', () => {
  it('maps edge zones to dir + before; center → null', () => {
    expect(zoneToSplit('left')).toEqual({ dir: 'col', before: true })
    expect(zoneToSplit('right')).toEqual({ dir: 'col', before: false })
    expect(zoneToSplit('top')).toEqual({ dir: 'row', before: true })
    expect(zoneToSplit('bottom')).toEqual({ dir: 'row', before: false })
    expect(zoneToSplit('center')).toBeNull()
  })
})

describe('resolveDrop (cross-window)', () => {
  // Source container 'main' with 2 panes; a foreign popup container with its OWN pane, each in its
  // own window's client coords (so both may start at 0,0 — they never mix).
  const mainSnap: ContainerSnapshot = {
    containerId: 'main',
    containerRect: { left: 0, top: 0, right: 400, bottom: 200 },
    panes: [
      { id: 'a', rect: { left: 0, top: 0, right: 200, bottom: 200 } },
      { id: 'b', rect: { left: 200, top: 0, right: 400, bottom: 200 } },
    ],
  }
  const popupSnap: ContainerSnapshot = {
    containerId: 'popup:0',
    containerRect: { left: 0, top: 0, right: 300, bottom: 300 },
    panes: [{ id: 'c', rect: { left: 0, top: 0, right: 300, bottom: 150 } }],
  }
  const emptyPopup: ContainerSnapshot = {
    containerId: 'popup:1',
    containerRect: { left: 0, top: 0, right: 300, bottom: 300 },
    panes: [],
  }

  // ── SAME container: the "+"-cross drop over a sibling (pane 'b' spans x∈[200,400], y∈[0,200]) ──
  it('SAME container over a sibling CENTER → swap', () => {
    expect(resolveDrop(300, 100, mainSnap, 'a', 'main')).toEqual({ kind: 'swap', paneId: 'b' })
  })
  it('SAME container over a sibling EDGE → reposition move (dir + before per zone)', () => {
    // left arm of b (nx≈-0.8) → col split, before (lead).
    expect(resolveDrop(220, 100, mainSnap, 'a', 'main')).toEqual({ kind: 'move', container: 'main', overPaneId: 'b', dir: 'col', before: true })
    // right arm of b (nx≈+0.8) → col split, after (trail).
    expect(resolveDrop(380, 100, mainSnap, 'a', 'main')).toEqual({ kind: 'move', container: 'main', overPaneId: 'b', dir: 'col', before: false })
    // top arm of b (ny≈-0.8) → row split, before.
    expect(resolveDrop(300, 20, mainSnap, 'a', 'main')).toEqual({ kind: 'move', container: 'main', overPaneId: 'b', dir: 'row', before: true })
    // bottom arm of b (ny≈+0.8) → row split, after.
    expect(resolveDrop(300, 180, mainSnap, 'a', 'main')).toEqual({ kind: 'move', container: 'main', overPaneId: 'b', dir: 'row', before: false })
  })
  it('SAME container over the source → none', () => {
    expect(resolveDrop(100, 100, mainSnap, 'a', 'main')).toEqual({ kind: 'none' })
  })
  it('SAME container released beyond the workspace → tearoff', () => {
    expect(resolveDrop(-10, 100, mainSnap, 'a', 'main')).toEqual({ kind: 'tearoff' })
  })

  // ── DIFFERENT container: a MOVE ──
  it('FOREIGN container over a pane → move beside it (split), dir from pointer position', () => {
    // pointer near the right edge of pane c (vertically centered in c) → horizontal-dominant → 'col'.
    const r = resolveDrop(290, 75, popupSnap, 'a', 'main')
    expect(r).toEqual({ kind: 'move', container: 'popup:0', overPaneId: 'c', dir: 'col', before: false })
  })
  it('FOREIGN container over a pane, vertically dominant → row split', () => {
    // pointer near the bottom edge of pane c, horizontally centered → vertical-dominant → 'row'.
    const r = resolveDrop(150, 145, popupSnap, 'a', 'main')
    expect(r).toEqual({ kind: 'move', container: 'popup:0', overPaneId: 'c', dir: 'row', before: false })
  })
  it('FOREIGN container over the empty BODY (below the only pane) → move append (root, null pane)', () => {
    // (150, 250) is inside the popup workspace but below pane c (0..150) → append into the body.
    expect(resolveDrop(150, 250, popupSnap, 'a', 'main')).toEqual({
      kind: 'move',
      container: 'popup:0',
      overPaneId: null,
      dir: 'col',
      before: false,
    })
  })
  it('EMPTY foreign container (no panes) anywhere inside → move append (root)', () => {
    expect(resolveDrop(150, 150, emptyPopup, 'a', 'main')).toEqual({
      kind: 'move',
      container: 'popup:1',
      overPaneId: null,
      dir: 'col',
      before: false,
    })
  })
  it('FOREIGN container released OUTSIDE its workspace → none (a foreign margin docks nothing, never tears off)', () => {
    expect(resolveDrop(-20, 150, popupSnap, 'a', 'main')).toEqual({ kind: 'none' })
    expect(resolveDrop(400, 150, popupSnap, 'a', 'main')).toEqual({ kind: 'none' })
  })

  // ── the source pane docked in a POPUP dragged back toward main ──
  it('source in a POPUP dragged over a MAIN pane → move into main beside it', () => {
    const r = resolveDrop(100, 100, mainSnap, 'c', 'popup:0')
    expect(r).toEqual({ kind: 'move', container: 'main', overPaneId: 'a', dir: 'col', before: false })
  })
  it('source in a POPUP over its OWN (source) container beyond the workspace → tearoff (its own outside)', () => {
    // Same-container semantics apply to whichever container is the source, popup included.
    expect(resolveDrop(-10, 50, popupSnap, 'c', 'popup:0')).toEqual({ kind: 'tearoff' })
  })

  // ── guards ──
  it('non-finite point → none', () => {
    expect(resolveDrop(NaN, 100, popupSnap, 'a', 'main')).toEqual({ kind: 'none' })
    expect(resolveDrop(150, Infinity, popupSnap, 'a', 'main')).toEqual({ kind: 'none' })
  })
  it('the source pane never counts as a move-beside target in its own foreign hover', () => {
    // If the source id somehow appears in a foreign snapshot, it is excluded → append, not split-on-self.
    const withSource: ContainerSnapshot = {
      containerId: 'popup:0',
      containerRect: { left: 0, top: 0, right: 300, bottom: 300 },
      panes: [{ id: 'a', rect: { left: 0, top: 0, right: 300, bottom: 300 } }],
    }
    expect(resolveDrop(150, 150, withSource, 'a', 'main')).toEqual({
      kind: 'move',
      container: 'popup:0',
      overPaneId: null,
      dir: 'col',
      before: false,
    })
  })
})
