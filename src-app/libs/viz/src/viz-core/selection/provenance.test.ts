import { describe, it, expect } from 'vitest'
import { IndexMask } from '../data/selection'
import { areaMask, SelectionController, type Area } from './SelectionController'
import { combineMask } from './areaGestures'
import {
  areaToOp,
  classifyChange,
  deriveSelection,
  hashPositions,
  opToArea,
  partitionSelection,
  selectionStaleness,
  type ProvenancePane,
} from './provenance'
import type { VizSelectionContext, VizSelectionOp } from '../option/types'

// ---------------------------------------------------------------------------
// The pure provenance engine (ITEM-2).
//
// TEST-2 is the INV-2 acceptance oracle: `deriveSelection(ops)` must equal the mask the LIVE publish
// path produces, byte for byte. Per the falsifiability rule this is worthless without negative
// controls — a `deriveSelection` stubbed to return the cache would pass a bare equality — so each
// oracle assertion is paired with a perturbation (a moved vertex, a flipped combine mode, a
// reordering) that MUST change the answer.
// ---------------------------------------------------------------------------

/** A 20x20 lattice: 400 points at integer coords 0..19. Deterministic, no RNG. */
function lattice(side = 20): ProvenancePane {
  const n = side * side
  const positions = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    positions[i * 2] = i % side
    positions[i * 2 + 1] = Math.floor(i / side)
  }
  return { positions, nPoints: n, pointIds: null, space: 'default' }
}

const PANE = 'cell-1'
const resolve = (pane: ProvenancePane) => (id: string | null) => (id === PANE ? pane : null)

const rectOp = (
  region: [number, number, number, number],
  op: VizSelectionOp['op'],
): VizSelectionOp => ({ tool: 'rect', op, pane: PANE, space: 'default', region })

const polyOp = (
  region: readonly (readonly [number, number])[],
  op: VizSelectionOp['op'],
): VizSelectionOp => ({ tool: 'polygon', op, pane: PANE, space: 'default', region })

/** The LIVE fold — driven through a REAL producer, `SelectionController.recompute()`.
 *
 *  CONV-5 (L16): this was a test-local re-implementation of the fold loop, so it could only ever
 *  prove `deriveSelection` agreed with a SECOND copy of the same logic; a change to the
 *  controller's own folding would have left both sides agreeing and the screen disagreeing.
 *  `applyArea` returns `recompute()`, so the controller can be driven directly.
 *
 *  CONV-11 — ATTRIBUTION, corrected. This previously said `recompute()` is "what
 *  `GridWorkspace.publishCellAreas` calls". It is not: `GridWorkspace` imports only
 *  `{ areaMask, containmentPassCount, type Area }` from that module (`GridWorkspace.tsx:54`) and
 *  folds `combineMask(combined, areaMask(...), area.mode)` INLINE. The controller is the
 *  SINGLE-CANVAS producer's fold — `useAreaSelection` (`useAreaSelection.tsx:160`, the ONLY
 *  production `new SelectionController(...)` in the package), whose sole production host is
 *  `SelectableScatter.tsx:108`. CONV-16: the first correction named `RasterUnderlayScatterView`
 *  here, which is equally wrong — that component imports only `type Area` from this module and
 *  resolves regions through the KD-tree path (`buildPointIndex`/`selectRegion`), publishing via
 *  `coordination.setSelection(...)`.
 *
 *  CONV-20 — the SUPPORTING COUNT, corrected. This is the THIRD iteration of one docs-accuracy
 *  class: CONV-5 named the wrong site, CONV-11 replaced it with another wrong one, and CONV-16
 *  fixed the site but mis-stated its own evidence. Re-running the greps over `src/`, excluding
 *  `*.test.*`, actually gives:
 *    - `new SelectionController` → ONE hit  (`useAreaSelection.tsx:160`) — as claimed.
 *    - `useAreaSelection(`       → THREE hits: the declaration (`useAreaSelection.tsx:86`) plus TWO
 *      calls — `SelectableScatter.tsx:108` (the production host) and
 *      `showcase/stories/data-progressive.story.tsx:249` (a showcase story).
 *  So it is called TWICE outside tests, not once. A reader auditing this attribution by re-running
 *  the stated grep would have got a different number than promised and no way to tell whether the
 *  discrepancy invalidated the conclusion — the same wasted-trust cost the two prior corrections
 *  were filed for.
 *
 *  The grid runs its own copy, which is precisely why `gridAreaFold.test.ts` exists to pin the two
 *  against each other. The oracle is still a genuine production fold. */
function liveFold(areas: readonly Area[], pane: ProvenancePane): number[] {
  const controller = new SelectionController({ positions: pane.positions, totalPoints: pane.nPoints })
  let mask = new IndexMask(pane.nPoints)
  for (const a of areas) mask = controller.applyArea(a, pane.positions, pane.nPoints)
  return [...mask.toIndices()]
}

describe('TEST-2 (INV-2) — ops re-derive the cached ids EXACTLY', () => {
  const pane = lattice()

  // A 3-op list mixing rect/polygon and add/subtract/intersect, in draw order.
  const ops: VizSelectionOp[] = [
    rectOp([0, 0, 12, 12], 'add'),
    polyOp(
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
      ],
      'subtract',
    ),
    rectOp([4, 0, 19, 10], 'intersect'),
  ]

  it('equals the live fold over the same areas (the full-N oracle)', () => {
    const areas = ops.map(o => opToArea(o)!) as Area[]
    const derived = deriveSelection(ops, resolve(pane))

    expect(derived.default).toEqual(liveFold(areas, pane))
    expect(derived.default.length).toBeGreaterThan(0) // not vacuously empty
  })

  it('NEGATIVE CONTROL (a): moving ONE polygon vertex by 1e-3 changes the derived ids', () => {
    const base = deriveSelection(ops, resolve(pane)).default
    const moved: VizSelectionOp[] = [
      ops[0],
      polyOp(
        [
          [2, 2],
          [8, 2],
          [8, 8.001],
          [2, 8.001],
        ],
        'subtract',
      ),
      ops[2],
    ]
    // 8.001 now encloses the y=8 lattice row that 8.0 excluded, so the subtraction removes more.
    expect(deriveSelection(moved, resolve(pane)).default).not.toEqual(base)
  })

  it('NEGATIVE CONTROL (b): swapping op[1] from subtract to add changes the derived ids', () => {
    const base = deriveSelection(ops, resolve(pane)).default
    const flipped = [ops[0], polyOp((ops[1] as { region: readonly (readonly [number, number])[] }).region, 'add'), ops[2]]
    expect(deriveSelection(flipped, resolve(pane)).default).not.toEqual(base)
  })

  it('NEGATIVE CONTROL (c): reordering the ADD before/after the SUBTRACT changes the derived ids', () => {
    // NOTE the reorder has to be chosen with care: swapping the SUBTRACT and the INTERSECT proves
    // nothing, because (A \ B) ∩ C === (A ∩ C) \ B by set algebra — an assertion that can never go
    // red is exactly the vacuous-control trap this suite exists to avoid. Moving the SUBTRACT ahead
    // of the ADD is a genuine semantic change: ((∅ \ B) ∪ A) ∩ C === A ∩ C, which keeps the points
    // inside B that the original list removed.
    const base = deriveSelection(ops, resolve(pane)).default
    const reordered = [ops[1], ops[0], ops[2]]
    const got = deriveSelection(reordered, resolve(pane)).default

    expect(got).not.toEqual(base)
    expect(got.length).toBeGreaterThan(base.length) // B is no longer subtracted
    // and the reorder still agrees with the LIVE fold of the same reordered areas — so the
    // difference is real semantics, not a derivation bug.
    expect(got).toEqual(liveFold(reordered.map(o => opToArea(o)!) as Area[], pane))
  })

  it('maps local rows to CANONICAL ids via pointIds', () => {
    const withIds: ProvenancePane = { ...pane, pointIds: Uint32Array.from({ length: pane.nPoints }, (_, i) => i + 1000) }
    const derived = deriveSelection([rectOp([0, 0, 2, 2], 'add')], resolve(withIds)).default
    expect(derived.every(id => id >= 1000)).toBe(true)
    expect(derived).toEqual(liveFold([opToArea(rectOp([0, 0, 2, 2], 'add'))!], pane).map(r => r + 1000))
  })

  it('areaToOp / opToArea round-trip preserves kind, mode and geometry', () => {
    const a: Area = { kind: 'rect', box: [1, 2, 3, 4], mode: 'subtract' }
    const back = opToArea(areaToOp(a, PANE, 'default'))!
    expect(back).toEqual(a)
    const p: Area = { kind: 'polygon', polygon: [[0, 0], [1, 0], [1, 1]], mode: 'intersect' }
    expect(opToArea(areaToOp(p, PANE, 'default'))!).toEqual(p)
  })
})

describe('TEST-3 support (INV-3) — cross-space isolation in the derivation', () => {
  it('ops tagged with space A never contribute ids to space B', () => {
    const paneA: ProvenancePane = { ...lattice(10), space: 'spaceA' }
    const paneB: ProvenancePane = { ...lattice(10), space: 'spaceB' }
    const resolveTwo = (id: string | null) => (id === 'a' ? paneA : id === 'b' ? paneB : null)

    const ops: VizSelectionOp[] = [
      { tool: 'rect', op: 'add', pane: 'a', space: 'spaceA', region: [0, 0, 4, 4] },
      { tool: 'rect', op: 'add', pane: 'b', space: 'spaceB', region: [5, 5, 9, 9] },
    ]
    const derived = deriveSelection(ops, resolveTwo)

    expect(Object.keys(derived).sort()).toEqual(['spaceA', 'spaceB'])
    // NEGATIVE CONTROL: each space is NON-empty, so "no bleed" cannot be satisfied by deriving nothing.
    expect(derived.spaceA.length).toBeGreaterThan(0)
    expect(derived.spaceB.length).toBeGreaterThan(0)
    // Dropping B's op leaves A byte-identical — the isolation is real, not incidental.
    expect(deriveSelection([ops[0]], resolveTwo).spaceA).toEqual(derived.spaceA)
    expect(deriveSelection([ops[0]], resolveTwo).spaceB).toBeUndefined()
  })
})

describe('TEST-5 — partitionSelection explains without filtering', () => {
  const ids = [1, 2, 3, 4, 5, 6]
  // 1,2 out of range · 3,4 hidden category · 5,6 visible
  const probe = (id: number) => ({
    plotId: 'p',
    value: id <= 2 ? 0 : 100,
    code: id === 3 || id === 4 ? 7 : 1,
  })
  const context: VizSelectionContext = { filters: { p: [50, 200] }, hidden: { p: [7] } }

  it('splits into three DISJOINT groups whose union is exactly the input', () => {
    const { visible, hiddenByLegend, outsideFilters } = partitionSelection(ids, context, probe)
    expect(outsideFilters).toEqual([1, 2])
    expect(hiddenByLegend).toEqual([3, 4])
    expect(visible).toEqual([5, 6])
    expect([...visible, ...hiddenByLegend, ...outsideFilters].sort((a, b) => a - b)).toEqual(ids)
    // disjoint
    const all = [...visible, ...hiddenByLegend, ...outsideFilters]
    expect(new Set(all).size).toBe(all.length)
  })

  it('FALSIFYING PAIR: an EMPTY context makes everything visible — the partition tracks the context', () => {
    const p = partitionSelection(ids, undefined, probe)
    expect(p.visible).toEqual(ids)
    expect(p.hiddenByLegend).toEqual([])
    expect(p.outsideFilters).toEqual([])
  })

  it('never invents or loses an id, whatever the context', () => {
    for (const ctx of [undefined, {}, context, { filters: { p: [-1, -1] as const } }] as (VizSelectionContext | undefined)[]) {
      const p = partitionSelection(ids, ctx, probe)
      expect([...p.visible, ...p.hiddenByLegend, ...p.outsideFilters].sort((a, b) => a - b)).toEqual(ids)
    }
  })
})

describe('TEST-22 — hashPositions + selectionStaleness', () => {
  it('is stable for identical buffers and differs on ANY change', () => {
    const a = new Float32Array([1, 2, 3, 4, 5, 6])
    const same = new Float32Array([1, 2, 3, 4, 5, 6])
    expect(hashPositions(a)).toBe(hashPositions(same))

    // one coordinate changed
    expect(hashPositions(new Float32Array([1, 2, 3, 4, 5, 6.5]))).not.toBe(hashPositions(a))
    // point COUNT changed
    expect(hashPositions(new Float32Array([1, 2, 3, 4]))).not.toBe(hashPositions(a))
    // ORDER changed (same multiset)
    expect(hashPositions(new Float32Array([3, 4, 1, 2, 5, 6]))).not.toBe(hashPositions(a))
    // a constant-returning hash fails every one of the three above
  })

  it('maps change class onto staleness', () => {
    const base: VizSelectionContext = { panes: { c: 'h1' }, filters: { c: [0, 1] }, hidden: { c: [2] } }
    expect(selectionStaleness(base, base)).toBe('fresh')
    expect(selectionStaleness(base, { ...base, panes: { c: 'h2' } })).toBe('stale-data')
    expect(selectionStaleness(base, { ...base, filters: { c: [0, 2] } })).toBe('stale-context')
  })
})

describe('TEST-25 — classifyChange, the INV-8 gatekeeper', () => {
  const ctx = (panes: Record<string, string>, filters?: Record<string, readonly [number, number]>, hidden?: Record<string, readonly number[]>): VizSelectionContext =>
    ({ panes, ...(filters ? { filters } : {}), ...(hidden ? { hidden } : {}) })

  it("returns 'none' for identical inputs", () => {
    const a = ctx({ c: 'h1' }, { c: [0, 1] }, { c: [3] })
    expect(classifyChange(a, { ...a })).toBe('none')
  })

  it("returns 'context' when ONLY filters/hidden differ (every pane hash equal)", () => {
    const a = ctx({ c: 'h1' }, { c: [0, 1] })
    expect(classifyChange(a, ctx({ c: 'h1' }, { c: [0, 2] }))).toBe('context')
    expect(classifyChange(a, ctx({ c: 'h1' }, { c: [0, 1] }, { c: [9] }))).toBe('context')
  })

  it("returns 'data' when ANY pane's positions hash differs", () => {
    expect(classifyChange(ctx({ c: 'h1' }), ctx({ c: 'h2' }))).toBe('data')
  })

  it("returns 'data' — NEVER 'context' — when BOTH moved (a data change must not be downgraded)", () => {
    const before = ctx({ c: 'h1' }, { c: [0, 1] })
    const after = ctx({ c: 'h2' }, { c: [0, 5] })
    // This is the arm that catches a naive `if (contextChanged) return 'context'` ordering bug:
    // downgrading here would leave ids pointing at replaced points.
    expect(classifyChange(before, after)).toBe('data')
  })

  it("classifies a pane ADDED or REMOVED as 'data'", () => {
    expect(classifyChange(ctx({ c: 'h1' }), ctx({ c: 'h1', d: 'h9' }))).toBe('data')
    expect(classifyChange(ctx({ c: 'h1', d: 'h9' }), ctx({ c: 'h1' }))).toBe('data')
  })

  it('NEGATIVE CONTROL: a constant-returning classifier fails at least two arms', () => {
    const arms: ChangeExpectation[] = [
      [ctx({ c: 'h1' }), ctx({ c: 'h1' }), 'none'],
      [ctx({ c: 'h1' }, { c: [0, 1] }), ctx({ c: 'h1' }, { c: [0, 2] }), 'context'],
      [ctx({ c: 'h1' }), ctx({ c: 'h2' }), 'data'],
    ]
    const results = arms.map(([a, b]) => classifyChange(a, b))
    expect(new Set(results).size).toBe(3) // all three classes are actually reachable
    arms.forEach(([a, b, want]) => expect(classifyChange(a, b)).toBe(want))
  })
})

type ChangeExpectation = [VizSelectionContext, VizSelectionContext, 'none' | 'context' | 'data']

// ── TEST-29 [LOW] — the documented "16 hex chars" wire contract ────────────────────────────────
describe('hashPositions honors its stated format (TEST-29)', () => {
  it('always emits exactly 16 lowercase hex chars — never a signed 17-char token', () => {
    // The bug: `hex8` formatted a SIGNED int32, so `^` could produce e.g. "-788b0e2460c29d50".
    // n=4,5,6 are the sizes the audit observed it on; the loop covers a wider sweep.
    for (let n = 1; n <= 64; n++) {
      const positions = new Float32Array(n * 2)
      for (let i = 0; i < n * 2; i++) positions[i] = i * 0.5 - 3
      const h = hashPositions(positions)
      expect(h).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('stays injective across a length change (the count is still mixed in)', () => {
    const a = new Float32Array([1, 2, 3, 4])
    const b = new Float32Array([1, 2, 3, 4, 0, 0])
    expect(hashPositions(a)).not.toEqual(hashPositions(b))
  })
})

// ── CONV-4 [M8] — hashPositions is memoized by BUFFER IDENTITY ─────────────────────────────────
// `snapshotContext` hashes every pane on each `recordCellProvenance`, which `publishCellAreas`
// calls on EVERY pointermove of a live vertex update — 8.2 ms/call over 200k points. The memo must
// make a repeat call O(1) WITHOUT defeating change detection: a different buffer (even with equal
// contents) must still be hashed, because that is how a data change is noticed.
describe('hashPositions — identity memo (CONV-4 / M8)', () => {
  it('returns the identical string for a repeat call on the SAME buffer', () => {
    const buf = new Float32Array([1, 2, 3, 4, 5, 6])
    const a = hashPositions(buf)
    const b = hashPositions(buf)
    expect(b).toBe(a)
  })

  it('still distinguishes CHANGED data (a new buffer is a cache miss, not a stale hit)', () => {
    const before = new Float32Array([1, 2, 3, 4])
    const h1 = hashPositions(before)
    const after = new Float32Array([1, 2, 3, 9]) // same length, different contents
    expect(hashPositions(after)).not.toBe(h1)
  })

  it('an equal-content COPY hashes to the same value (the memo is not the identity of the hash)', () => {
    const a = new Float32Array([7, 8, 9])
    const copy = new Float32Array([7, 8, 9])
    expect(hashPositions(copy)).toBe(hashPositions(a))
  })

  it('is measurably cheaper on repeat: 200 repeat calls beat 200 fresh buffers', () => {
    const N = 60_000
    const base = new Float32Array(N)
    for (let i = 0; i < N; i++) base[i] = i * 0.5
    hashPositions(base) // prime

    const t0 = performance.now()
    for (let i = 0; i < 200; i++) hashPositions(base) // all memo hits
    const cached = performance.now() - t0

    const t1 = performance.now()
    for (let i = 0; i < 200; i++) hashPositions(base.slice()) // all fresh buffers → real work
    const uncached = performance.now() - t1

    // Generous margin: the point is O(1) vs O(n), not a precise ratio.
    expect(cached).toBeLessThan(uncached / 5)
  })
})
