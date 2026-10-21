// paneDocksStore.test.ts — the SPLIT D (ITEM-15) per-pane dock store, node tier.
//
// Mirrors `cellDisplayStore.test.ts` (which mirrors `annotate/Annotate.store.test.ts`), the package's
// precedent for a pure store test in a vitest harness with no DOM. What it has to prove is narrower
// than `CellDisplay`'s and sharper: `CellDisplay` needed a per-cell MEMO to make a per-cell selector
// work, because its selector returns an object. These selectors return BOOLEANS, so the property to
// prove is not identity stability but that the four open-set semantics (INV-8's per-pane parity) came
// through the hoist unchanged — several panes open at once, a close that leaves the others alone, and
// the no-op identity contract that stops a redundant write waking every subscriber.

import { describe, it, expect } from 'vitest'
import {
  createPaneDocksStore,
  selectAnnotateMode,
  selectAnnotateOpen,
  selectAnyDataTableOpen,
  selectDataOpen,
  selectEditOpen,
  selectMaskReview,
  selectSegmentMode,
  selectSegmentOpen,
  selectSegmentOpenSig,
} from '../../adapter/PaneDocks.store'
import { emptyMaskReview } from '../annotate/maskDock'

describe('PaneDocks store — INV-8 per-pane parity survives the hoist', () => {
  it('several panes hold the SAME surface open at once, and closing one leaves the others', () => {
    const s = createPaneDocksStore()
    s.getState().toggleEdit('a')
    s.getState().toggleEdit('b')
    s.getState().toggleEdit('c')
    expect([...s.getState().editCellIds].sort()).toEqual(['a', 'b', 'c'])

    s.getState().closeEdit('b')
    expect([...s.getState().editCellIds].sort()).toEqual(['a', 'c'])
    // …and the OTHER three surfaces were never touched by any of it.
    expect(s.getState().dataTableCellIds.size).toBe(0)
    expect(s.getState().annotateOpenIds.size).toBe(0)
    expect(s.getState().segmentOpenIds.size).toBe(0)
  })

  it('the four surfaces are independent — one pane can have all four open', () => {
    const s = createPaneDocksStore()
    s.getState().toggleEdit('p')
    s.getState().toggleDataTable('p')
    s.getState().toggleAnnotate('p')
    s.getState().toggleSegment('p')
    expect(selectEditOpen('p')(s.getState())).toBe(true)
    expect(selectDataOpen('p')(s.getState())).toBe(true)
    expect(selectAnnotateOpen('p')(s.getState())).toBe(true)
    expect(selectSegmentOpen('p')(s.getState())).toBe(true)
    // …and a DIFFERENT pane has none of them.
    expect(selectEditOpen('q')(s.getState())).toBe(false)
    expect(selectAnnotateOpen('q')(s.getState())).toBe(false)
  })

  // The identity contract carried over from `openPanes.ts`. It is what stops a redundant close (a
  // dock's × after the toolbar button already closed it) from waking every subscriber — the reason
  // the algebra returns `prev` rather than a fresh Set.
  it('a no-op close leaves the set REFERENTIALLY unchanged', () => {
    const s = createPaneDocksStore()
    s.getState().toggleAnnotate('a')
    const before = s.getState().annotateOpenIds
    s.getState().closeAnnotate('nobody')
    expect(s.getState().annotateOpenIds).toBe(before)
    s.getState().openAnnotate('a') // already open
    expect(s.getState().annotateOpenIds).toBe(before)
  })

  it('eviction drops only the panes that stopped qualifying', () => {
    const s = createPaneDocksStore()
    s.getState().toggleAnnotate('a')
    s.getState().toggleAnnotate('gone')
    s.getState().evictAnnotate(['a', 'other'])
    expect([...s.getState().annotateOpenIds]).toEqual(['a'])
    // A reconcile that evicts nothing must not churn the identity either.
    const stable = s.getState().annotateOpenIds
    s.getState().evictAnnotate(['a', 'other'])
    expect(s.getState().annotateOpenIds).toBe(stable)
  })

  // The three derived selectors the SHELL subscribes to. Their whole purpose is that opening a SECOND
  // dock does not change their value, so the shell is not re-rendered — assert exactly that.
  it('the derived modes do not change when a second pane opens the same surface', () => {
    const s = createPaneDocksStore()
    expect(selectAnnotateMode(s.getState())).toBe(false)
    s.getState().toggleAnnotate('a')
    expect(selectAnnotateMode(s.getState())).toBe(true)
    s.getState().toggleAnnotate('b')
    expect(selectAnnotateMode(s.getState())).toBe(true) // unchanged ⇒ no shell re-render
    s.getState().closeAnnotate('a')
    expect(selectAnnotateMode(s.getState())).toBe(true) // still one open
    s.getState().closeAnnotate('b')
    expect(selectAnnotateMode(s.getState())).toBe(false)

    expect(selectAnyDataTableOpen(s.getState())).toBe(false)
    s.getState().toggleDataTable('a')
    expect(selectAnyDataTableOpen(s.getState())).toBe(true)
    expect(selectSegmentMode(s.getState())).toBe(false)
  })

  // The one shell effect whose trigger is the SET's content rather than the mode reads a joined
  // string, so it must be stable BY VALUE across an unrelated write and must change when the set does.
  it('the segment-open signature is stable by value and order-independent', () => {
    const s = createPaneDocksStore()
    s.getState().toggleSegment('b')
    s.getState().toggleSegment('a')
    expect(selectSegmentOpenSig(s.getState())).toBe('a,b')
    s.getState().toggleEdit('z') // unrelated write
    expect(selectSegmentOpenSig(s.getState())).toBe('a,b')
    s.getState().closeSegment('a')
    expect(selectSegmentOpenSig(s.getState())).toBe('b')
  })
})

describe('PaneDocks store — the mask review record', () => {
  it('patching seeds an empty record and leaves other cells alone', () => {
    const s = createPaneDocksStore()
    s.getState().patchMaskReview('a', r => ({ ...r, selectedId: 7 }))
    expect(s.getState().maskReview.a.selectedId).toBe(7)
    const aBefore = s.getState().maskReview.a
    s.getState().patchMaskReview('b', r => ({ ...r, selectedId: 9 }))
    expect(s.getState().maskReview.a).toBe(aBefore)
    expect(s.getState().maskReview.b.selectedId).toBe(9)
    expect(selectMaskReview(s.getState())).toBe(s.getState().maskReview)
  })

  // BLIND-AUDIT M11's contract, moved into the store with the record: closing a mask dock drops the
  // HALF-FINISHED correction and nothing else, so a reopen cannot resume a stale merge/split against
  // a mask the user has since edited.
  it('clearing a pending correction drops merge/split state and keeps the rest', () => {
    const s = createPaneDocksStore()
    s.getState().patchMaskReview('a', r => ({ ...r, selectedId: 3, mergeSource: 5, splitSeeds: [{ x: 1, y: 2, id: 3 }] }))
    s.getState().clearPendingCorrection('a')
    expect(s.getState().maskReview.a.mergeSource).toBeNull()
    expect(s.getState().maskReview.a.splitSeeds).toEqual([])
    expect(s.getState().maskReview.a.selectedId).toBe(3) // the review readout survives
  })

  it('clearing with nothing pending is a no-op by identity', () => {
    const s = createPaneDocksStore()
    s.getState().patchMaskReview('a', r => ({ ...r, selectedId: 3 }))
    const before = s.getState().maskReview
    s.getState().clearPendingCorrection('a')
    expect(s.getState().maskReview).toBe(before)
    s.getState().clearPendingCorrection('never-seen')
    expect(s.getState().maskReview).toBe(before)
  })

  // The leak guard: a removed segment cell's review record (hidden Set / catsRef / dirty rect) must
  // not accumulate over pane churn.
  it('pruning drops records for cells that are no longer live', () => {
    const s = createPaneDocksStore()
    s.getState().patchMaskReview('a', r => r)
    s.getState().patchMaskReview('gone', r => r)
    s.getState().pruneMaskReview(['a'])
    expect(Object.keys(s.getState().maskReview)).toEqual(['a'])
    const stable = s.getState().maskReview
    s.getState().pruneMaskReview(['a'])
    expect(s.getState().maskReview).toBe(stable)
  })

  it('an unpatched cell resolves to nothing, and `emptyMaskReview` is the seed shape', () => {
    const s = createPaneDocksStore()
    expect(s.getState().maskReview.nobody).toBeUndefined()
    s.getState().patchMaskReview('a', r => r)
    // A LITERAL expected object (FIX_ROUND-2 / C22). This asserted `toEqual(emptyMaskReview())` —
    // expectation and subject built by the SAME function, so changing `emptyMaskReview` to return
    // `{}` moved both together and the test stayed green. It proved the store CALLS the seed
    // builder; it could never prove what the seed IS, which is what its name claims.
    expect(s.getState().maskReview.a).toEqual({
      hidden: new Set(),
      solo: null,
      selectedId: null,
      tool: null,
      target: null,
      mergeSource: null,
      splitSeeds: [],
      dirty: null,
      catsRef: null,
    })
    // …and the store really does seed FROM that builder (the property the old assertion did hold,
    // kept as its own clause rather than conflated with the shape).
    expect(s.getState().maskReview.a).toEqual(emptyMaskReview())
  })

  // COVERAGE GAP (FIX_ROUND-2 / C22): `evictSegment` and `closeDataTable` are exported actions with
  // no test at all. `evictSegment` is the pane-churn reconcile — a mask dock left open for a cell
  // that is no longer segment-eligible is a panel over a mask that does not exist.
  it('evictSegment keeps eligible open panes and drops the rest, by identity when nothing moves', () => {
    const s = createPaneDocksStore()
    s.getState().toggleSegment('a')
    s.getState().toggleSegment('b')
    expect(selectSegmentOpenSig(s.getState())).toBe('a,b')
    s.getState().evictSegment(['a'])
    expect(selectSegmentOpenSig(s.getState())).toBe('a')
    const stable = s.getState().segmentOpenIds
    s.getState().evictSegment(['a', 'z'])
    expect(s.getState().segmentOpenIds, 'a no-op eviction must not invalidate the subscription').toBe(stable)
    s.getState().evictSegment([])
    expect(selectSegmentOpenSig(s.getState())).toBe('')
  })

  it('closeDataTable closes ONE pane’s table and leaves the others open', () => {
    const s = createPaneDocksStore()
    s.getState().toggleDataTable('a')
    s.getState().toggleDataTable('b')
    expect(selectDataOpen('a')(s.getState())).toBe(true)
    s.getState().closeDataTable('a')
    expect(selectDataOpen('a')(s.getState())).toBe(false)
    expect(selectDataOpen('b')(s.getState())).toBe(true)
    const stable = s.getState().dataTableCellIds
    s.getState().closeDataTable('a')
    expect(s.getState().dataTableCellIds, 'closing an already-closed table must be identity-stable').toBe(stable)
  })
})

// DRIFT-5's per-WORKSPACE ownership, carried forward. A popped-out container mounts a SECOND
// `GridWorkspace` inside the same `<Viz>`; if this slice lived in the `VizStores` family, one
// workspace's eviction reconcile would close the other's docks (INV-7).
describe('PaneDocks store — two workspaces are independent (INV-7)', () => {
  it('a write to one store is invisible to the other', () => {
    const main = createPaneDocksStore()
    const popup = createPaneDocksStore()
    main.getState().toggleAnnotate('a')
    expect(selectAnnotateMode(main.getState())).toBe(true)
    expect(selectAnnotateMode(popup.getState())).toBe(false)
    // …and the popup's own eviction reconcile (which sees only ITS panes) cannot close the main's.
    popup.getState().evictAnnotate([])
    expect([...main.getState().annotateOpenIds]).toEqual(['a'])
  })
})
