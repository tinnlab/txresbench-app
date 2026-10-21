import { describe, it, expect } from 'vitest'
import {
  containerOf,
  panesInContainer,
  movePane,
  returnToPrimary,
  slotAnchorOf,
  PRIMARY_CONTAINER,
  type ContainerModel,
  type ContainerId,
} from './containers'
import { type LayoutNode, leafIds } from './layout/splitTree'

const leaf = (id: string): LayoutNode => ({ kind: 'leaf', id })

/** main with cells a,b,c in a row; no popups. */
function gridABC(): ContainerModel {
  return {
    layoutByContainer: {
      main: { kind: 'split', dir: 'row', sizes: [1 / 3, 1 / 3, 1 / 3], children: [leaf('a'), leaf('b'), leaf('c')] },
    },
    paneContainer: {},
  }
}

const sorted = (xs: string[]) => [...xs].sort()

describe('containerOf', () => {
  it('defaults an unassigned cell to the main', () => {
    expect(containerOf(gridABC(), 'a')).toBe(PRIMARY_CONTAINER)
  })
  it('reads an explicit assignment', () => {
    const m: ContainerModel = { layoutByContainer: { 'popup:1': leaf('x') }, paneContainer: { x: 'popup:1' } }
    expect(containerOf(m, 'x')).toBe('popup:1')
  })
})

describe('panesInContainer', () => {
  it('lists a container tree leaves; empty for an absent container', () => {
    const m = gridABC()
    expect(sorted(panesInContainer(m, 'main'))).toEqual(['a', 'b', 'c'])
    expect(panesInContainer(m, 'popup:9')).toEqual([])
  })
})

describe('movePane', () => {
  it('main → new popup: main reflows (cell gone), popup = root leaf, container reassigned', () => {
    const before = gridABC()
    const { model, emptied } = movePane(before, 'b', 'popup:1', { kind: 'root' })
    expect(sorted(panesInContainer(model, 'main'))).toEqual(['a', 'c']) // main reflowed
    expect(panesInContainer(model, 'popup:1')).toEqual(['b'])
    expect(containerOf(model, 'b')).toBe('popup:1')
    expect(emptied).toBeNull()
    // input untouched (immutability)
    expect(sorted(panesInContainer(before, 'main'))).toEqual(['a', 'b', 'c'])
  })

  it('main with a single cell → popup: main becomes empty (no entry), not an "emptied" signal', () => {
    const before: ContainerModel = { layoutByContainer: { main: leaf('only') }, paneContainer: {} }
    const { model, emptied } = movePane(before, 'only', 'popup:1', { kind: 'root' })
    expect(panesInContainer(model, 'main')).toEqual([]) // main empty is allowed
    expect(model.layoutByContainer.main).toBeUndefined()
    expect(panesInContainer(model, 'popup:1')).toEqual(['only'])
    expect(emptied).toBeNull() // main never signals a window close
  })

  it('popup → main (return): inserts into main; the emptied popup is signaled', () => {
    const m: ContainerModel = {
      layoutByContainer: { main: leaf('a'), 'popup:1': leaf('b') },
      paneContainer: { b: 'popup:1' },
    }
    const { model, emptied } = movePane(m, 'b', 'main', { kind: 'split', atLeaf: 'a', dir: 'col' })
    expect(sorted(panesInContainer(model, 'main'))).toEqual(['a', 'b'])
    expect(model.layoutByContainer['popup:1']).toBeUndefined()
    expect(containerOf(model, 'b')).toBe('main')
    expect(emptied).toBe('popup:1') // last pane left → close the window
  })

  it('last pane out of a popup (to another popup) signals the source emptied', () => {
    const m: ContainerModel = {
      layoutByContainer: { main: leaf('a'), 'popup:1': leaf('b'), 'popup:2': leaf('c') },
      paneContainer: { b: 'popup:1', c: 'popup:2' },
    }
    const { model, emptied } = movePane(m, 'b', 'popup:2', { kind: 'split', atLeaf: 'c', dir: 'row' })
    expect(emptied).toBe('popup:1')
    expect(model.layoutByContainer['popup:1']).toBeUndefined()
    expect(sorted(panesInContainer(model, 'popup:2'))).toEqual(['b', 'c'])
  })

  it('does NOT signal emptied when a popup still has panes after the move', () => {
    const m: ContainerModel = {
      layoutByContainer: {
        main: leaf('a'),
        'popup:1': { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] },
      },
      paneContainer: { b: 'popup:1', c: 'popup:1' },
    }
    const { model, emptied } = movePane(m, 'b', 'main', { kind: 'split', atLeaf: 'a', dir: 'col' })
    expect(emptied).toBeNull()
    expect(panesInContainer(model, 'popup:1')).toEqual(['c']) // popup:1 kept c
  })

  it('splits at a target leaf', () => {
    const { model } = movePane(gridABC(), 'a', 'popup:1', { kind: 'root' })
    // now move c beside a in popup:1
    const { model: m2 } = movePane(model, 'c', 'popup:1', { kind: 'split', atLeaf: 'a', dir: 'row' })
    expect(sorted(panesInContainer(m2, 'popup:1'))).toEqual(['a', 'c'])
    expect(leafIds(m2.layoutByContainer['popup:1'])).toContain('c')
  })

  it('SAME-container reposition honors `before` (drag a plot to a sibling edge, IN place)', () => {
    // row [a,b,c]; reposition 'a' beside 'c'. before=true ⇒ 'a' LEADS 'c' (visual order …a,c);
    // before=false ⇒ 'a' TRAILS 'c' (…c,a). Proves the directional "+"-cross drop end-to-end.
    const lead = movePane(gridABC(), 'a', 'main', { kind: 'split', atLeaf: 'c', dir: 'col', before: true })
    expect(leafIds(lead.model.layoutByContainer.main)).toEqual(['b', 'a', 'c'])
    expect(lead.emptied).toBeNull()
    const trail = movePane(gridABC(), 'a', 'main', { kind: 'split', atLeaf: 'c', dir: 'col', before: false })
    expect(leafIds(trail.model.layoutByContainer.main)).toEqual(['b', 'c', 'a'])
  })

  it('a split target whose leaf is missing falls back to the first leaf (stale drop target)', () => {
    const { model } = movePane(gridABC(), 'a', 'popup:1', { kind: 'split', atLeaf: 'ghost', dir: 'col' })
    expect(panesInContainer(model, 'popup:1')).toEqual(['a']) // still inserted (as root, tree was empty)
  })

  it('same-container reposition is allowed and never signals emptied', () => {
    const { model, emptied } = movePane(gridABC(), 'a', 'main', { kind: 'split', atLeaf: 'c', dir: 'row' })
    expect(sorted(panesInContainer(model, 'main'))).toEqual(['a', 'b', 'c'])
    expect(emptied).toBeNull()
  })

  it('a root drop into a POPULATED target APPENDS — never wipes the existing panes', () => {
    // Regression: a `root` target (a drop/placement resolving with no pane under the cursor — e.g. a
    // gutter/margin click) must ADD beside the container's panes, not replace the whole tree.
    // move a into an empty popup:1, then move c into popup:1 with a `root` target.
    const { model } = movePane(gridABC(), 'a', 'popup:1', { kind: 'root' })
    const { model: m2 } = movePane(model, 'c', 'popup:1', { kind: 'root' })
    expect(sorted(panesInContainer(m2, 'popup:1'))).toEqual(['a', 'c']) // a survived
  })

  it('a missing cell is a no-op', () => {
    const before = gridABC()
    const { model, emptied } = movePane(before, 'zzz', 'popup:1', { kind: 'root' })
    expect(model).toBe(before)
    expect(emptied).toBeNull()
  })
})

describe('returnToPrimary (return-position rule)', () => {
  const popped: ContainerModel = {
    layoutByContainer: {
      main: { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('c')] },
      'popup:1': leaf('b'),
    },
    paneContainer: { b: 'popup:1' },
  }

  it('restores to the remembered slot when that leaf still exists', () => {
    const { model } = returnToPrimary(popped, 'b', { kind: 'split', atLeaf: 'a', dir: 'col' })
    expect(sorted(panesInContainer(model, 'main'))).toEqual(['a', 'b', 'c'])
    expect(containerOf(model, 'b')).toBe('main')
  })

  it('appends when the remembered leaf is gone', () => {
    const { model } = returnToPrimary(popped, 'b', { kind: 'split', atLeaf: 'gone', dir: 'col' })
    expect(sorted(panesInContainer(model, 'main'))).toEqual(['a', 'b', 'c']) // appended, not lost
  })

  it('appends when no slot is remembered', () => {
    const { model } = returnToPrimary(popped, 'b')
    expect(sorted(panesInContainer(model, 'main'))).toEqual(['a', 'b', 'c'])
  })

  it('becomes the main root when the main is empty', () => {
    const allOut: ContainerModel = { layoutByContainer: { 'popup:1': leaf('b') }, paneContainer: { b: 'popup:1' } }
    const { model, emptied } = returnToPrimary(allOut, 'b')
    expect(panesInContainer(model, 'main')).toEqual(['b'])
    expect(model.layoutByContainer.main).toEqual(leaf('b'))
    expect(emptied).toBe('popup:1')
  })
})

describe('slotAnchorOf (return-position memory)', () => {
  it('returns null for a bare leaf root (no sibling)', () => {
    expect(slotAnchorOf(leaf('a'), 'a')).toBeNull()
  })

  it('anchors to a sibling leaf under the same split, in the parent dir', () => {
    // row[a,b,c]; b leaves → anchor beside a (first non-b sibling) in 'row'.
    const tree: LayoutNode = {
      kind: 'split', dir: 'row', sizes: [1 / 3, 1 / 3, 1 / 3],
      children: [leaf('a'), leaf('b'), leaf('c')],
    }
    expect(slotAnchorOf(tree, 'b')).toEqual({ kind: 'split', atLeaf: 'a', dir: 'row' })
    expect(slotAnchorOf(tree, 'a')).toEqual({ kind: 'split', atLeaf: 'b', dir: 'row' })
  })

  it('descends into a sibling SUB-SPLIT to its first leaf', () => {
    // col[ a , row[b,c] ]; a leaves → sibling is the row split → its first leaf b.
    const tree: LayoutNode = {
      kind: 'split', dir: 'col', sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }],
    }
    expect(slotAnchorOf(tree, 'a')).toEqual({ kind: 'split', atLeaf: 'b', dir: 'col' })
  })

  it('finds a deep pane via its own parent split (nearest sibling)', () => {
    // col[ a , row[b,c] ]; c leaves → its parent is the row split → sibling b, dir 'row'.
    const tree: LayoutNode = {
      kind: 'split', dir: 'col', sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }],
    }
    expect(slotAnchorOf(tree, 'c')).toEqual({ kind: 'split', atLeaf: 'b', dir: 'row' })
  })

  it('returns null for a pane absent from the tree', () => {
    const tree: LayoutNode = { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
    expect(slotAnchorOf(tree, 'zzz')).toBeNull()
  })

  it('round-trips: a recorded anchor restores a returned pane beside its old sibling', () => {
    // row[a,b,c]; move b to a popup, remember its anchor, then return it → back beside a.
    const start: ContainerModel = {
      layoutByContainer: {
        main: { kind: 'split', dir: 'row', sizes: [1 / 3, 1 / 3, 1 / 3], children: [leaf('a'), leaf('b'), leaf('c')] },
      },
      paneContainer: {},
    }
    const anchor = slotAnchorOf(start.layoutByContainer.main, 'b')!
    const moved = movePane(start, 'b', 'popup:1', { kind: 'root' }).model
    expect(panesInContainer(moved, 'main')).toEqual(['a', 'c'])
    const returned = returnToPrimary(moved, 'b', anchor).model
    // b docks beside a (its remembered sibling), which still exists → not merely appended at the end.
    expect(leafIds(returned.layoutByContainer.main)).toContain('b')
    expect(panesInContainer(returned, 'popup:1')).toEqual([])
  })
})
