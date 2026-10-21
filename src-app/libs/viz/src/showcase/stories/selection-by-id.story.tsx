// selection-by-id.story.tsx — PROVES the cell/point-ID selection seam (multi-source
// correctness). TWO scatters (A + B) render the SAME set of points but with DIFFERENT
// embeddings (different positions) AND DIFFERENT ROW ORDER — B's `pointIds` is a
// PERMUTATION of A's, so an index-based selection sync would highlight the WRONG points
// in B, while the id-based path highlights the RIGHT ones (the same underlying points).
//
// A third scatter (C) renders a DIFFERENT point set (disjoint canonical ids), so a
// selection made in A highlights NOTHING there — a selection never crosses point sets.
//
// Both A/B/C read ONE shared `useCoordinationStore`. Selecting "cluster 0" in A publishes
// canonical POINT IDs (`mapRowsToIds`); each reader builds its own reverse map
// (`buildIdToRow`) and lights its local rows via `highlightMaskForIds`. A headless harness
// can't drag a lasso, so a "Seed cluster 0 (A)" button seeds the selection deterministically.
//
// window.__VIZ_TEST__ exposes: pointSelectionLength, aSelectedCount, bSelectedCount,
// cSelectedCount, and — the correctness proof — bSelectedMatchesA (true iff the exact
// canonical points emphasised in B equal the canonical ids selected in A).

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import {
  buildIdToRow,
  hasAnySelection,
  highlightMaskForIds,
  identityPointIds,
  mapRowsToIds,
} from '../../viz-core/coordination/selectionSync'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** The origin view id A's selection is attributed to (DEC-25). */
const SOURCE_A = 'selection-by-id-a'

const N = 3000 // points shared by A and B
const K = 6 // clusters
const CLUSTER0 = 0 // the cluster the seed button selects

/** Deterministic cluster of a canonical point id (stable across A and B). */
function clusterOf(id: number): number {
  return id % K
}

/** A tiny deterministic PRNG (mulberry32) so the demo is reproducible frame-to-frame. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Cluster-blob positions for `count` rows, where row r's canonical id is `idOf(r)`.
 *  `layout[k]` is the on-screen center of cluster k, so A and B can arrange the SAME
 *  clusters at DIFFERENT centers (distinct embeddings). Returns interleaved xy (len 2*count). */
function embedding(
  count: number,
  idOf: (r: number) => number,
  layout: readonly [number, number][],
  seed: number,
): Float32Array {
  const rnd = mulberry32(seed)
  const pos = new Float32Array(count * 2)
  for (let r = 0; r < count; r++) {
    const k = clusterOf(idOf(r))
    const [cx, cy] = layout[k]
    pos[2 * r] = cx + (rnd() - 0.5) * 3
    pos[2 * r + 1] = cy + (rnd() - 0.5) * 3
  }
  return pos
}

/** Per-cluster palette (RGBA), so the same cluster reads as the same color in A and B. */
const PALETTE: [number, number, number][] = [
  [31, 119, 180],
  [255, 127, 14],
  [44, 160, 44],
  [214, 39, 40],
  [148, 103, 189],
  [140, 86, 75],
]

function colorsFor(count: number, idOf: (r: number) => number): Uint8Array {
  const c = new Uint8Array(count * 4)
  for (let r = 0; r < count; r++) {
    const [rr, gg, bb] = PALETTE[clusterOf(idOf(r)) % PALETTE.length]
    c[4 * r] = rr
    c[4 * r + 1] = gg
    c[4 * r + 2] = bb
    c[4 * r + 3] = 255
  }
  return c
}

/** A deterministic permutation of 0..n-1 (Fisher–Yates with a seeded PRNG). */
function permutation(n: number, seed: number): Uint32Array {
  const p = identityPointIds(n)
  const rnd = mulberry32(seed)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  return p
}

// Two DIFFERENT cluster layouts (⇒ different embeddings for A vs B).
const LAYOUT_A: [number, number][] = [
  [-8, -8],
  [-8, 0],
  [-8, 8],
  [8, -8],
  [8, 0],
  [8, 8],
]
const LAYOUT_B: [number, number][] = [
  [8, 8],
  [0, 8],
  [-8, 8],
  [8, -8],
  [0, -8],
  [-8, -8],
]
const LAYOUT_C: [number, number][] = LAYOUT_A

function SelectionByIdStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). A story that
  // writes the singleton coordination store leaves that write visible to every story mounted after
  // it in the SAME page load. This story wires every view EXPLICITLY (`selection` /
  // `onSelectColumns` / `highlightMask` props), so no view falls back to `defaultCoordinationHandle`
  // and the set alone is sufficient. `tests/viz-e2e/story-isolation.spec.ts` walks every story and
  // fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  // A: identity — row r carries canonical id r.
  const pointIdsA = useMemo(() => identityPointIds(N), [])
  // B: SAME points, PERMUTED order — row r carries canonical id permB[r].
  const pointIdsB = useMemo(() => permutation(N, 1234), [])
  // C: a DIFFERENT point set — disjoint canonical ids [N .. 2N-1].
  const pointIdsC = useMemo(() => {
    const a = new Uint32Array(N)
    for (let r = 0; r < N; r++) a[r] = N + r
    return a
  }, [])

  const positionsA = useMemo(
    () => embedding(N, r => pointIdsA[r], LAYOUT_A, 7),
    [pointIdsA],
  )
  const positionsB = useMemo(
    () => embedding(N, r => pointIdsB[r], LAYOUT_B, 8),
    [pointIdsB],
  )
  const positionsC = useMemo(
    () => embedding(N, r => pointIdsC[r], LAYOUT_C, 9),
    [pointIdsC],
  )
  const colorsA = useMemo(() => colorsFor(N, r => pointIdsA[r]), [pointIdsA])
  const colorsB = useMemo(() => colorsFor(N, r => pointIdsB[r]), [pointIdsB])
  const colorsC = useMemo(() => colorsFor(N, r => pointIdsC[r]), [pointIdsC])

  // Reverse maps (CONSUME direction) — canonical id → local row for each view.
  const idToRowA = useMemo(() => buildIdToRow(pointIdsA), [pointIdsA])
  const idToRowB = useMemo(() => buildIdToRow(pointIdsB), [pointIdsB])
  const idToRowC = useMemo(() => buildIdToRow(pointIdsC), [pointIdsC])

  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const active = hasAnySelection(pointSelection)

  // Each view's per-row highlight mask, built from the SHARED canonical-id selection.
  const maskA = useMemo(
    () => (active ? highlightMaskForIds(pointSelection!, idToRowA, N) : null),
    [active, pointSelection, idToRowA],
  )
  const maskB = useMemo(
    () => (active ? highlightMaskForIds(pointSelection!, idToRowB, N) : null),
    [active, pointSelection, idToRowB],
  )
  const maskC = useMemo(
    () => (active ? highlightMaskForIds(pointSelection!, idToRowC, N) : null),
    [active, pointSelection, idToRowC],
  )

  const aSelectedCount = useMemo(() => countOnes(maskA), [maskA])
  const bSelectedCount = useMemo(() => countOnes(maskB), [maskB])
  const cSelectedCount = useMemo(() => countOnes(maskC), [maskC])

  // The correctness proof: the SET of canonical ids B emphasises must equal the set of
  // canonical ids A selected. (Index-based sync would light B's WRONG rows → mismatch.)
  const bSelectedMatchesA = useMemo(() => {
    if (!pointSelection || !maskB) return false
    const selected = new Set<number>(pointSelection)
    // ids B lights up = { pointIdsB[r] : maskB[r] === 1 }
    const bIds = new Set<number>()
    for (let r = 0; r < N; r++) if (maskB[r] === 1) bIds.add(pointIdsB[r])
    if (bIds.size !== selected.size) return false
    for (const id of bIds) if (!selected.has(id)) return false
    return true
  }, [pointSelection, maskB, pointIdsB])

  // Clear on unmount. With the isolated set above this is no longer CROSS-STORY hygiene (the set
  // dies with the story); it just resets this story's own state between its StrictMode mounts.
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      pointSelectionLength: pointSelection?.length ?? 0,
      aSelectedCount,
      bSelectedCount,
      cSelectedCount,
      bSelectedMatchesA,
    }
  }, [pointSelection, aSelectedCount, bSelectedCount, cSelectedCount, bSelectedMatchesA])

  // PRODUCE: select every point in cluster 0 IN VIEW A. A's local rows (identity, so row==id)
  // → canonical ids via `mapRowsToIds`, then publish. B/C then react purely by id.
  const seedClusterA = () => {
    const rows: number[] = []
    for (let r = 0; r < N; r++) if (clusterOf(pointIdsA[r]) === CLUSTER0) rows.push(r)
    const ids = mapRowsToIds(Uint32Array.from(rows), pointIdsA)
    stores.coordination.getState().setSelection(SOURCE_A, ids)
  }
  const clear = () => stores.coordination.getState().clearSelection()

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-sel-by-id"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div
          style={{
            padding: 8,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: 13,
          }}
        >
          <button type="button" data-testid="viz-sel-by-id-seed-a" onClick={seedClusterA}>
            Seed cluster 0 (A)
          </button>
          <button type="button" data-testid="viz-sel-by-id-clear" onClick={clear}>
            Clear
          </button>
          <span style={{ opacity: 0.75 }}>
            A={aSelectedCount} · B={bSelectedCount} · C={cSelectedCount} · match=
            {String(bSelectedMatchesA)}
          </span>
          <span style={{ opacity: 0.55 }}>
            A &amp; B are the SAME points in DIFFERENT embeddings + row order; C is a disjoint
            set. Seed A → B lights the SAME points (by id), C lights nothing.
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ScatterPane
            testid="viz-sel-by-id-a"
            label="A — identity order"
            positions={positionsA}
            colors={colorsA}
            mask={maskA}
            active={active}
          />
          <ScatterPane
            testid="viz-sel-by-id-b"
            label="B — permuted order, other embedding"
            positions={positionsB}
            colors={colorsB}
            mask={maskB}
            active={active}
          />
          <ScatterPane
            testid="viz-sel-by-id-c"
            label="C — disjoint point set"
            positions={positionsC}
            colors={colorsC}
            mask={maskC}
            active={active}
          />
        </div>
      </div>
    </VizStoresProvider>
  )
}

function countOnes(mask: Uint8Array | null): number {
  if (!mask) return 0
  let c = 0
  for (let i = 0; i < mask.length; i++) c += mask[i]
  return c
}

interface PaneProps {
  testid: string
  label: string
  positions: Float32Array
  colors: Uint8Array
  mask: Uint8Array | null
  active: boolean
}

function ScatterPane({ testid, label, positions, colors, mask, active }: PaneProps) {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => setEpoch(e => e + 1), [mask])
  return (
    <div
      data-testid={testid}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid rgba(128,128,128,0.3)',
      }}
    >
      <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.7 }}>{label}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DeckScatterCanvas
          positions={positions}
          colors={colors}
          radius={2}
          highlightMask={mask}
          selectionActive={active}
          selectionEpoch={epoch}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'selection-by-point-id',
  category: 'Selection',
  title: 'Selection by point id — cross-embedding sync stays correct under a row permutation',
  covers: 'selection-by-id',
  Component: SelectionByIdStory,
})
