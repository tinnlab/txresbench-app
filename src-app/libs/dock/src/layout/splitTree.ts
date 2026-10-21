// splitTree.ts — free-form resizable split-pane tree geometry (DEC-21).
//
// A layout is a nested split-pane tree (the VS Code / tmux pane model): interior
// `split` nodes divide their box among `children` by `sizes` (fractions summing to
// 1); `leaf` nodes are the panes. Different branches can hold different numbers of
// leaves, and every divider is independently resizable — so arbitrary non-uniform
// layouts (row 1 = 3 panes, row 2 = 2 panes) are expressible.
//
// This file is PURE geometry: no deck.gl, no React, no GPU, no DOM. It is the
// model the `GridWorkspace` store mutates and `react-resizable-panels` renders.
// Names are domain-agnostic (DEC-28) so the module is extractable as a standalone
// visualization package.
//
// SPLIT-DIRECTION CONVENTION (documented once, applied everywhere):
//   dir === 'row' → the split divides its HEIGHT among children (panes stacked
//                   vertically; each child spans the full width).
//   dir === 'col' → the split divides its WIDTH among children (panes side by
//                   side; each child spans the full height).

export type SplitDir = 'row' | 'col'

export interface SplitNode {
  kind: 'split'
  dir: SplitDir
  /** Fractions in (0,1] summing to 1; `sizes.length === children.length`. */
  sizes: number[]
  children: LayoutNode[]
}

export interface LeafNode {
  kind: 'leaf'
  /** Stable leaf key = the pane id. Used to match/key the leaf in tree ops and to key
   *  the renderer's resizable panel. Each leaf holds exactly one pane. */
  id: string
}

export type LayoutNode = SplitNode | LeafNode

export interface PaneRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/** Smallest fraction a pane is allowed to shrink to when dragging a divider. */
export const DEFAULT_MIN_FRACTION = 0.05

// ---------------------------------------------------------------------------
// 1. computeRects — lay the tree out into absolute pixel rects.
// ---------------------------------------------------------------------------

/**
 * Recursively lay out `root` inside a `width`×`height` box (origin at 0,0). Every
 * leaf receives exactly one absolute-pixel {@link PaneRect}. Rects perfectly tile
 * the container (contiguous, no gaps, no overlap) regardless of float drift — the
 * last child in each split absorbs the rounding remainder so boundaries meet
 * exactly.
 */
export function computeRects(root: LayoutNode, width: number, height: number): PaneRect[] {
  const out: PaneRect[] = []
  layout(root, 0, 0, width, height, out)
  return out
}

function layout(
  node: LayoutNode,
  x: number,
  y: number,
  width: number,
  height: number,
  out: PaneRect[],
): void {
  if (node.kind === 'leaf') {
    out.push({ id: node.id, x, y, width, height })
    return
  }
  const n = node.children.length
  if (node.dir === 'row') {
    // Divide HEIGHT; each child spans the full width.
    const bottom = y + height
    let cursor = y
    for (let i = 0; i < n; i++) {
      const h = i === n - 1 ? bottom - cursor : node.sizes[i] * height
      layout(node.children[i], x, cursor, width, h, out)
      cursor += h
    }
  } else {
    // Divide WIDTH; each child spans the full height.
    const right = x + width
    let cursor = x
    for (let i = 0; i < n; i++) {
      const w = i === n - 1 ? right - cursor : node.sizes[i] * width
      layout(node.children[i], cursor, y, w, height, out)
      cursor += w
    }
  }
}

// ---------------------------------------------------------------------------
// 2. splitLeaf — split a leaf into [leaf, newLeaf] 50/50 (immutable).
// ---------------------------------------------------------------------------

/**
 * Replace the leaf `leafId` with a new `dir` split holding the original leaf plus
 * a fresh leaf `newLeafId`, sized 50/50. `before` places the new leaf FIRST (left/top
 * of the original) instead of last (right/bottom, the default). Returns a NEW tree; the
 * input is never mutated. If `leafId` is absent the tree is returned structurally unchanged.
 */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  dir: SplitDir,
  newLeafId: string,
  before: boolean = false,
): LayoutNode {
  return mapLeaf(root, leafId, (leaf) => ({
    kind: 'split',
    dir,
    sizes: [0.5, 0.5],
    children: before
      ? [{ kind: 'leaf', id: newLeafId }, leaf]
      : [leaf, { kind: 'leaf', id: newLeafId }],
  }))
}

/** Immutably rebuild `node`, replacing the leaf `id` with `fn(leaf)`. */
function mapLeaf(
  node: LayoutNode,
  id: string,
  fn: (leaf: LeafNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') {
    return node.id === id ? fn(node) : node
  }
  return {
    kind: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map((c) => mapLeaf(c, id, fn)),
  }
}

// ---------------------------------------------------------------------------
// 3. removeLeaf — drop a leaf, collapsing single-child splits (immutable).
// ---------------------------------------------------------------------------

/**
 * Remove the leaf `leafId`. A split left with a single child collapses into that
 * child; a split left with ≥2 children re-normalizes its remaining sizes to sum to
 * 1. Returns a NEW tree, or `null` if the whole layout became empty (the removed
 * leaf was the root). Input never mutated.
 */
export function removeLeaf(root: LayoutNode, leafId: string): LayoutNode | null {
  return dropLeaf(root, leafId)
}

function dropLeaf(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === 'leaf') {
    return node.id === id ? null : node // the removed leaf → its split collapses
  }
  const keptChildren: LayoutNode[] = []
  const keptSizes: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const child = dropLeaf(node.children[i], id)
    if (child !== null) {
      keptChildren.push(child)
      keptSizes.push(node.sizes[i])
    }
  }
  if (keptChildren.length === 0) return null
  if (keptChildren.length === 1) return keptChildren[0] // collapse
  return {
    kind: 'split',
    dir: node.dir,
    sizes: normalize(keptSizes),
    children: keptChildren,
  }
}

/** Scale a positive-weight vector to sum to exactly 1. */
function normalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0)
  if (sum <= 0) {
    // Degenerate guard: fall back to an even split.
    return sizes.map(() => 1 / sizes.length)
  }
  return sizes.map((s) => s / sum)
}

// ---------------------------------------------------------------------------
// 4. resizeDivider — move a divider by `deltaFraction`, clamped (immutable).
// ---------------------------------------------------------------------------

/**
 * At the split reached by following `path` (an array of child indices from the
 * root; `[]` = the root itself), move `deltaFraction` from the pane at
 * `dividerIndex` to its next sibling (`dividerIndex + 1`). The applied delta is
 * clamped so neither pane shrinks below `minFraction`. Total is preserved, so the
 * layout keeps tiling. Returns a NEW tree; input never mutated. A `path`/index
 * that does not resolve to a split with that divider returns the tree unchanged.
 */
export function resizeDivider(
  root: LayoutNode,
  path: number[],
  dividerIndex: number,
  deltaFraction: number,
  minFraction: number = DEFAULT_MIN_FRACTION,
): LayoutNode {
  if (!Number.isFinite(deltaFraction)) return root // a NaN/Infinity delta would corrupt the size vector
  return updateAtPath(root, path, 0, (split) => {
    const { sizes } = split
    if (dividerIndex < 0 || dividerIndex + 1 >= sizes.length) return split
    const a = sizes[dividerIndex]
    const b = sizes[dividerIndex + 1]
    // a can grow by at most (b - min); a can shrink by at most (a - min).
    const lo = -(a - minFraction)
    const hi = b - minFraction
    // If either pane is already below min, the feasible range can invert — no-op.
    const applied = hi <= lo ? 0 : Math.max(lo, Math.min(hi, deltaFraction))
    if (applied === 0) return split
    const next = sizes.slice()
    next[dividerIndex] = a + applied
    next[dividerIndex + 1] = b - applied
    return { kind: 'split', dir: split.dir, sizes: next, children: split.children }
  })
}

/** Immutably rebuild the node at `path`, applying `fn` to the split it points at. */
function updateAtPath(
  node: LayoutNode,
  path: number[],
  depth: number,
  fn: (split: SplitNode) => SplitNode,
): LayoutNode {
  if (node.kind === 'leaf') return node
  if (depth === path.length) {
    return fn(node)
  }
  const idx = path[depth]
  if (idx < 0 || idx >= node.children.length) return node
  const children = node.children.slice()
  children[idx] = updateAtPath(node.children[idx], path, depth + 1, fn)
  return { kind: 'split', dir: node.dir, sizes: node.sizes.slice(), children }
}

// ---------------------------------------------------------------------------
// 5. leafIds — the leaf ids in layout order (left→right, top→bottom).
// ---------------------------------------------------------------------------

/** Collect every leaf id in depth-first (visual) order. */
export function leafIds(root: LayoutNode): string[] {
  const out: string[] = []
  collectLeafIds(root, out)
  return out
}

function collectLeafIds(node: LayoutNode, out: string[]): void {
  if (node.kind === 'leaf') {
    out.push(node.id)
    return
  }
  for (const c of node.children) collectLeafIds(c, out)
}
