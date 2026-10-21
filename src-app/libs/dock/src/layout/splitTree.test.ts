import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  type LayoutNode,
  type PaneRect,
  computeRects,
  splitLeaf,
  removeLeaf,
  resizeDivider,
  leafIds,
} from './splitTree'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeWeights(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => w / sum)
}

/** Every split path (child-index array) in DFS order, with its divider count. */
function allSplitPaths(root: LayoutNode): { path: number[]; dividers: number }[] {
  const out: { path: number[]; dividers: number }[] = []
  const walk = (node: LayoutNode, path: number[]) => {
    if (node.kind === 'leaf') return
    out.push({ path, dividers: node.children.length - 1 })
    node.children.forEach((c, i) => walk(c, [...path, i]))
  }
  walk(root, [])
  return out
}

/** Assert the full tiling invariant set for a laid-out tree. */
function assertTiles(tree: LayoutNode, w: number, h: number) {
  const rects = computeRects(tree, w, h)
  const ids = leafIds(tree)

  // (a) exactly one rect per leaf, same id set.
  expect(rects.length).toBe(ids.length)
  expect(new Set(rects.map((r) => r.id))).toEqual(new Set(ids))

  const eps = 1e-6
  let area = 0
  for (const r of rects) {
    // (b) no NaN, non-negative extents.
    expect(Number.isNaN(r.x)).toBe(false)
    expect(Number.isNaN(r.y)).toBe(false)
    expect(Number.isNaN(r.width)).toBe(false)
    expect(Number.isNaN(r.height)).toBe(false)
    expect(r.width).toBeGreaterThanOrEqual(0)
    expect(r.height).toBeGreaterThanOrEqual(0)
    // within the container bounds.
    expect(r.x).toBeGreaterThanOrEqual(-eps)
    expect(r.y).toBeGreaterThanOrEqual(-eps)
    expect(r.x + r.width).toBeLessThanOrEqual(w + eps)
    expect(r.y + r.height).toBeLessThanOrEqual(h + eps)
    area += r.width * r.height
  }

  // (c1) no two rects overlap.
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(rectsOverlap(rects[i], rects[j], eps)).toBe(false)
    }
  }
  // (c2) union area == container area (with no overlap ⇒ full coverage).
  expect(Math.abs(area - w * h)).toBeLessThanOrEqual(1e-4 * w * h + 1e-6)
}

function rectsOverlap(a: PaneRect, b: PaneRect, eps: number): boolean {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return ox > eps && oy > eps
}

// ---------------------------------------------------------------------------
// Arbitrary: random split trees (depth ≤ 4, leaves ≤ 12), unique leaf ids.
// ---------------------------------------------------------------------------

const PLACEHOLDER: LayoutNode = { kind: 'leaf', id: '?' }

function nodeArb(depth: number): fc.Arbitrary<LayoutNode> {
  const leafArb = fc.constant<LayoutNode>(PLACEHOLDER)
  if (depth <= 0) return leafArb
  const splitArb = fc.integer({ min: 2, max: 3 }).chain((n) =>
    fc
      .record({
        dir: fc.constantFrom<'row' | 'col'>('row', 'col'),
        weights: fc.array(fc.integer({ min: 2, max: 10 }), { minLength: n, maxLength: n }),
        children: fc.tuple(...Array.from({ length: n }, () => nodeArb(depth - 1))),
      })
      .map(
        ({ dir, weights, children }): LayoutNode => ({
          kind: 'split',
          dir,
          sizes: normalizeWeights(weights),
          children,
        }),
      ),
  )
  // Bias toward leaves (listed twice) so trees stay small.
  return fc.oneof(leafArb, leafArb, splitArb)
}

/** Relabel every leaf with a unique sequential id in DFS order (immutably). */
function relabel(node: LayoutNode, ctr = { n: 0 }): LayoutNode {
  if (node.kind === 'leaf') return { kind: 'leaf', id: `L${ctr.n++}` }
  return {
    kind: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map((c) => relabel(c, ctr)),
  }
}

const treeArb: fc.Arbitrary<LayoutNode> = nodeArb(4)
  .filter((t) => leafIds(t).length <= 12)
  .map((t) => relabel(t))

const dimArb = fc.integer({ min: 1, max: 4000 })

// ---------------------------------------------------------------------------
// Concrete known-answer tests
// ---------------------------------------------------------------------------

describe('computeRects — known answers', () => {
  it('a single leaf fills the whole container', () => {
    const rects = computeRects({ kind: 'leaf', id: 'a' }, 100, 100)
    expect(rects).toEqual([{ id: 'a', x: 0, y: 0, width: 100, height: 100 }])
  })

  it("a 2-leaf 'row' split of 100×100 gives two 100×50 stacked rects", () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
      ],
    }
    expect(computeRects(tree, 100, 100)).toEqual([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 0, y: 50, width: 100, height: 50 },
    ])
  })

  it("a 2-leaf 'col' split of 100×100 gives two 50×100 side-by-side rects", () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
      ],
    }
    expect(computeRects(tree, 100, 100)).toEqual([
      { id: 'a', x: 0, y: 0, width: 50, height: 100 },
      { id: 'b', x: 50, y: 0, width: 50, height: 100 },
    ])
  })

  it('a non-uniform nested layout (col of [leaf, row-of-2]) tiles exactly', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        {
          kind: 'split',
          dir: 'row',
          sizes: [0.25, 0.75],
          children: [
            { kind: 'leaf', id: 'b' },
            { kind: 'leaf', id: 'c' },
          ],
        },
      ],
    }
    expect(computeRects(tree, 200, 100)).toEqual([
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 100, y: 0, width: 100, height: 25 },
      { id: 'c', x: 100, y: 25, width: 100, height: 75 },
    ])
  })
})

describe('splitLeaf — known answers', () => {
  const leaf: LayoutNode = { kind: 'leaf', id: 'a' }

  it('splits a lone leaf into a 50/50 split of [leaf, newLeaf]', () => {
    expect(splitLeaf(leaf, 'a', 'row', 'b')).toEqual({
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
      ],
    })
  })

  it('does not mutate the input tree', () => {
    const frozen = Object.freeze<LayoutNode>({ kind: 'leaf', id: 'a' })
    const next = splitLeaf(frozen, 'a', 'col', 'b')
    expect(next).not.toBe(frozen)
    expect(frozen).toEqual({ kind: 'leaf', id: 'a' })
  })

  it('returns the tree unchanged (structurally equal) for an unknown leaf id', () => {
    expect(splitLeaf(leaf, 'zzz', 'row', 'b')).toEqual(leaf)
  })

  it('targets a nested leaf, leaving siblings intact', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
      ],
    }
    const next = splitLeaf(tree, 'b', 'col', 'c')
    expect(leafIds(next)).toEqual(['a', 'b', 'c'])
  })

  it('before=true places the new leaf FIRST (lead side), so it precedes the original in visual order', () => {
    expect(splitLeaf(leaf, 'a', 'col', 'b', true)).toEqual({
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'b' },
        { kind: 'leaf', id: 'a' },
      ],
    })
    // in a nested tree the new leaf leads its target: [c, b] under the split of 'b'.
    const tree: LayoutNode = {
      kind: 'split', dir: 'row', sizes: [0.5, 0.5],
      children: [{ kind: 'leaf', id: 'a' }, { kind: 'leaf', id: 'b' }],
    }
    expect(leafIds(splitLeaf(tree, 'b', 'col', 'c', true))).toEqual(['a', 'c', 'b'])
  })
})

describe('removeLeaf — known answers', () => {
  it('collapses a 2-child split into the surviving leaf', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
      ],
    }
    expect(removeLeaf(tree, 'a')).toEqual({ kind: 'leaf', id: 'b' })
  })

  it('re-normalizes remaining sizes when ≥2 children survive', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      sizes: [0.2, 0.3, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'b' },
        { kind: 'leaf', id: 'c' },
      ],
    }
    const next = removeLeaf(tree, 'a') as LayoutNode
    expect(next.kind).toBe('split')
    if (next.kind === 'split') {
      expect(next.children.map((c) => (c as { id: string }).id)).toEqual(['b', 'c'])
      expect(next.sizes[0]).toBeCloseTo(0.375, 10) // 0.3/0.8
      expect(next.sizes[1]).toBeCloseTo(0.625, 10) // 0.5/0.8
      expect(next.sizes[0] + next.sizes[1]).toBeCloseTo(1, 12)
    }
  })

  it('returns null when the root leaf itself is removed', () => {
    expect(removeLeaf({ kind: 'leaf', id: 'a' }, 'a')).toBeNull()
  })

  it('returns the tree unchanged for an unknown id', () => {
    const tree: LayoutNode = { kind: 'leaf', id: 'a' }
    expect(removeLeaf(tree, 'zzz')).toEqual(tree)
  })
})

describe('resizeDivider — known answers', () => {
  const twoRow: LayoutNode = {
    kind: 'split',
    dir: 'row',
    sizes: [0.5, 0.5],
    children: [
      { kind: 'leaf', id: 'a' },
      { kind: 'leaf', id: 'b' },
    ],
  }

  it('moves the fraction from one pane to the next', () => {
    const next = resizeDivider(twoRow, [], 0, 0.2) as LayoutNode
    if (next.kind === 'split') {
      expect(next.sizes[0]).toBeCloseTo(0.7, 12)
      expect(next.sizes[1]).toBeCloseTo(0.3, 12)
    }
  })

  it('clamps so the shrinking pane never drops below minFraction', () => {
    const next = resizeDivider(twoRow, [], 0, 0.9, 0.05) as LayoutNode
    if (next.kind === 'split') {
      expect(next.sizes[0]).toBeCloseTo(0.95, 12)
      expect(next.sizes[1]).toBeCloseTo(0.05, 12)
    }
  })

  it('clamps a large negative delta symmetrically', () => {
    const next = resizeDivider(twoRow, [], 0, -0.9, 0.05) as LayoutNode
    if (next.kind === 'split') {
      expect(next.sizes[0]).toBeCloseTo(0.05, 12)
      expect(next.sizes[1]).toBeCloseTo(0.95, 12)
    }
  })

  it('resizes a nested split addressed by a path', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        {
          kind: 'split',
          dir: 'row',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: 'b' },
            { kind: 'leaf', id: 'c' },
          ],
        },
      ],
    }
    const next = resizeDivider(tree, [1], 0, 0.1) as LayoutNode
    if (next.kind === 'split') {
      // outer untouched
      expect(next.sizes).toEqual([0.5, 0.5])
      const inner = next.children[1]
      if (inner.kind === 'split') {
        expect(inner.sizes[0]).toBeCloseTo(0.6, 12)
        expect(inner.sizes[1]).toBeCloseTo(0.4, 12)
      }
    }
  })

  it('preserves the total (still sums to 1) after any resize', () => {
    const next = resizeDivider(twoRow, [], 0, 0.137) as LayoutNode
    if (next.kind === 'split') {
      expect(next.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    }
  })

  it('is a no-op for an out-of-range divider index', () => {
    expect(resizeDivider(twoRow, [], 5, 0.2)).toEqual(twoRow)
  })

  it('is a no-op for a path that does not resolve to a split', () => {
    expect(resizeDivider(twoRow, [9], 0, 0.2)).toEqual(twoRow)
  })

  it('does not mutate the input', () => {
    const before = JSON.stringify(twoRow)
    resizeDivider(twoRow, [], 0, 0.3)
    expect(JSON.stringify(twoRow)).toBe(before)
  })
})

describe('leafIds — known answers', () => {
  it('returns leaves in visual (DFS) order', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        {
          kind: 'split',
          dir: 'row',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: 'b' },
            { kind: 'leaf', id: 'c' },
          ],
        },
      ],
    }
    expect(leafIds(tree)).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('computeRects — properties', () => {
  it('every leaf gets exactly one rect and the rects tile the container', () => {
    fc.assert(
      fc.property(treeArb, dimArb, dimArb, (tree, w, h) => {
        assertTiles(tree, w, h)
      }),
      { numRuns: 400 },
    )
  })
})

describe('resizeDivider — properties', () => {
  it('preserves leaf count and tiling for any split/divider/delta', () => {
    fc.assert(
      fc.property(
        treeArb,
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        dimArb,
        dimArb,
        (tree, splitSel, divSel, delta, w, h) => {
          const splits = allSplitPaths(tree)
          if (splits.length === 0) return // single-leaf tree, nothing to resize
          const chosen = splits[splitSel % splits.length]
          const dividerIndex = chosen.dividers === 0 ? 0 : divSel % chosen.dividers
          const before = leafIds(tree)
          const next = resizeDivider(tree, chosen.path, dividerIndex, delta)
          // leaf set unchanged
          expect(leafIds(next)).toEqual(before)
          // still tiles
          assertTiles(next, w, h)
        },
      ),
      { numRuns: 400 },
    )
  })
})

describe('splitLeaf / removeLeaf — properties', () => {
  it('splitLeaf adds exactly one leaf and keeps the layout tiling', () => {
    fc.assert(
      fc.property(
        treeArb,
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom<'row' | 'col'>('row', 'col'),
        dimArb,
        dimArb,
        (tree, sel, dir, w, h) => {
          const ids = leafIds(tree)
          const target = ids[sel % ids.length]
          const newId = '__new__'
          const next = splitLeaf(tree, target, dir, newId)
          const after = leafIds(next)
          expect(after.length).toBe(ids.length + 1)
          expect(after).toContain(newId)
          for (const id of ids) expect(after).toContain(id)
          assertTiles(next, w, h)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('removeLeaf drops exactly one leaf (or empties) and keeps tiling', () => {
    fc.assert(
      fc.property(treeArb, fc.integer({ min: 0, max: 1000 }), dimArb, dimArb, (tree, sel, w, h) => {
        const ids = leafIds(tree)
        const target = ids[sel % ids.length]
        const next = removeLeaf(tree, target)
        if (ids.length === 1) {
          expect(next).toBeNull()
          return
        }
        expect(next).not.toBeNull()
        const after = leafIds(next as LayoutNode)
        expect(after.length).toBe(ids.length - 1)
        expect(after).not.toContain(target)
        assertTiles(next as LayoutNode, w, h)
      }),
      { numRuns: 300 },
    )
  })

  it('a random sequence of split/remove ops always tiles and tracks leaf ids', () => {
    const opArb = fc.record({
      kind: fc.constantFrom<'split' | 'remove'>('split', 'remove'),
      sel: fc.integer({ min: 0, max: 1000 }),
      dir: fc.constantFrom<'row' | 'col'>('row', 'col'),
    })
    fc.assert(
      fc.property(
        treeArb,
        fc.array(opArb, { minLength: 1, maxLength: 20 }),
        dimArb,
        dimArb,
        (tree0, ops, w, h) => {
          let tree: LayoutNode | null = tree0
          let counter = 0
          for (const op of ops) {
            if (tree === null) break
            const ids = leafIds(tree)
            const target = ids[op.sel % ids.length]
            if (op.kind === 'split') {
              const newId = `S${counter++}`
              tree = splitLeaf(tree, target, op.dir, newId)
              expect(leafIds(tree)).toContain(newId)
            } else {
              tree = removeLeaf(tree, target)
            }
            if (tree !== null) {
              // no duplicate ids ever appear
              const cur = leafIds(tree)
              expect(new Set(cur).size).toBe(cur.length)
              assertTiles(tree, w, h)
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})
