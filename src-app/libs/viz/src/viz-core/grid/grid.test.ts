import { describe, it, expect, beforeEach } from 'vitest'
import {
  type LayoutNode,
  computeRects,
  leafIds,
} from '@ziee/dock'
import { cellLayerId, makeLayerFilter } from '../layers/multiView'
import {
  buildLayerCellMap,
  cellConsumesSelection,
  cellProducesSelection,
  cellScatterLayerId,
  contrastMaxForDtype,
  datasetLinkKey,
  orderedCells,
  resolveLinkedCellDomains,
  seedChannelsForLoader,
  swapCellContent,
  type CellColorDomain,
  type GridCell,
} from './gridModel'
import type { PixelSource } from '@vivjs/types'
import type { ChannelLabels } from '../spatial/rasterImageLayers'
import type { ColorBy } from '../data/engine'
import { highlightMaskForPoints, selectionAttribute } from '../coordination/selectionSync'
import { buildPointIndex, makePointIndexCache } from '../spatial/pointIndex'
import {
  useGridWorkspaceStore,
  INITIAL_CELL_ID,
} from '../../adapter/GridWorkspace.store'

// ---------------------------------------------------------------------------
// Pure gridModel helpers — tree → cell configs + layer→view routing.
// ---------------------------------------------------------------------------

describe('gridModel — cell ordering', () => {
  const cells: Record<string, GridCell> = {
    a: { id: 'a', kind: 'scatter', layoutId: 'primary' },
    b: { id: 'b', kind: 'violin', layoutId: 'primary' },
    c: { id: 'c', kind: 'heatmap', layoutId: 'primary' },
  }

  it('returns cell configs in visual leaf order', () => {
    // Non-uniform: top row [a | c], bottom row [b].
    const layout: LayoutNode = {
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'split', dir: 'col', sizes: [0.5, 0.5], children: [
          { kind: 'leaf', id: 'a' },
          { kind: 'leaf', id: 'c' },
        ] },
        { kind: 'leaf', id: 'b' },
      ],
    }
    expect(orderedCells(layout, cells).map(c => c.id)).toEqual(['a', 'c', 'b'])
    // …and matches leafIds order exactly.
    expect(orderedCells(layout, cells).map(c => c.id)).toEqual(leafIds(layout))
  })

  it('drops leaves that have no config (defensive)', () => {
    const layout: LayoutNode = {
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a' },
        { kind: 'leaf', id: 'missing' },
      ],
    }
    expect(orderedCells(layout, cells).map(c => c.id)).toEqual(['a'])
  })
})

describe('gridModel — layer→view routing', () => {
  it('maps each cell scatter layer id to its own cell', () => {
    const map = buildLayerCellMap(['a', 'b', 'c'])
    expect(map).toEqual({
      [cellScatterLayerId('a')]: 'a',
      [cellScatterLayerId('b')]: 'b',
      [cellScatterLayerId('c')]: 'c',
    })
  })

  it('routes a cell layer ONLY to its own viewport (never a sibling)', () => {
    const cellIds = ['a', 'b']
    const filter = makeLayerFilter(buildLayerCellMap(cellIds))
    // cell a's layer is drawn in view a, hidden from view b.
    const layerA = { id: cellScatterLayerId('a') }
    expect(filter({ layer: layerA, viewport: { id: 'a' } })).toBe(true)
    expect(filter({ layer: layerA, viewport: { id: 'b' } })).toBe(false)
    // cell b's layer is drawn in view b, hidden from view a.
    const layerB = { id: cellScatterLayerId('b') }
    expect(filter({ layer: layerB, viewport: { id: 'b' } })).toBe(true)
    expect(filter({ layer: layerB, viewport: { id: 'a' } })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Per-cell color-by + linked color scale union (Phase C3b / ITEM-64).
// ---------------------------------------------------------------------------

describe('resolveLinkedCellDomains — shared color-scale union', () => {
  it('unions the domains of LINKED cells sharing a key (both converge)', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: 'qcA', domain: [0, 10], linked: true },
      { id: 'b', key: 'qcA', domain: [4, 20], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    // Both linked cells map to the union [0, 20] → identical values → identical colors.
    expect(eff['a']).toEqual([0, 20])
    expect(eff['b']).toEqual([0, 20])
  })

  it('leaves an UNLINKED cell on its own domain even if a sibling links the same key', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: 'qcA', domain: [0, 10], linked: true },
      { id: 'b', key: 'qcA', domain: [4, 20], linked: false },
    ]
    const eff = resolveLinkedCellDomains(cells)
    // 'a' is alone in the linked set → its own domain; 'b' opted out → its own domain.
    expect(eff['a']).toEqual([0, 10])
    expect(eff['b']).toEqual([4, 20])
  })

  it('never merges across different keys', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: 'qcA', domain: [0, 10], linked: true },
      { id: 'b', key: 'qcB', domain: [100, 200], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    expect(eff['a']).toEqual([0, 10])
    expect(eff['b']).toEqual([100, 200])
  })

  it('a lone linked cell keeps its own domain', () => {
    const eff = resolveLinkedCellDomains([
      { id: 'a', key: 'qcA', domain: [1, 5], linked: true },
    ])
    expect(eff['a']).toEqual([1, 5])
  })

  it('three linked cells all converge to the widest union', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: 'v', domain: [2, 6], linked: true },
      { id: 'b', key: 'v', domain: [0, 4], linked: true },
      { id: 'c', key: 'v', domain: [3, 9], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    expect(eff['a']).toEqual([0, 9])
    expect(eff['b']).toEqual([0, 9])
    expect(eff['c']).toEqual([0, 9])
  })

  // MD-9: with the dataset-scoped link key, two cells coloring by the SAME column NAME over
  // DIFFERENT datasets must NOT union (they're unrelated series); same-dataset (incl. all-default)
  // cells still union exactly as before.
  it('does NOT union cross-dataset cells sharing a column name (datasetLinkKey scopes)', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: datasetLinkKey('dsA', 'qc'), domain: [0, 10], linked: true },
      { id: 'b', key: datasetLinkKey('dsB', 'qc'), domain: [4, 20], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    // distinct dataset prefixes ⇒ distinct keys ⇒ each keeps its own domain.
    expect(eff['a']).toEqual([0, 10])
    expect(eff['b']).toEqual([4, 20])
  })

  it('DOES union same-dataset cells sharing a column name (datasetLinkKey identical)', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: datasetLinkKey('dsA', 'qc'), domain: [0, 10], linked: true },
      { id: 'b', key: datasetLinkKey('dsA', 'qc'), domain: [4, 20], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    expect(eff['a']).toEqual([0, 20])
    expect(eff['b']).toEqual([0, 20])
  })

  it('default cells (empty dataset id) union under the same bare column (byte-identical to pre-MD)', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: datasetLinkKey(undefined, 'qc'), domain: [1, 3], linked: true },
      { id: 'b', key: datasetLinkKey(null, 'qc'), domain: [2, 8], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    // both resolve to the empty-prefix key `::qc` ⇒ they link, exactly as the old bare `qc` did.
    expect(datasetLinkKey(undefined, 'qc')).toBe('::qc')
    expect(eff['a']).toEqual([1, 8])
    expect(eff['b']).toEqual([1, 8])
  })
})

// ---------------------------------------------------------------------------
// D (ITEM-7): single-layer selection emphasis — the `getSelected` attribute path.
// ---------------------------------------------------------------------------

describe('selectionAttribute — D single-layer getSelected (ITEM-7)', () => {
  it('maps a highlight mask to a per-point 0/1 Float32 attribute of size 1', () => {
    // real mask from the real builder: points {1,3} selected out of 5.
    const mask = highlightMaskForPoints(Uint32Array.from([1, 3]), 5)
    const attr = selectionAttribute(mask)
    expect(attr).toBeDefined()
    expect(attr?.size).toBe(1)
    expect(attr?.value).toBeInstanceOf(Float32Array)
    expect(Array.from(attr!.value)).toEqual([0, 1, 0, 1, 0])
  })

  it('a null mask (no active selection) yields no attribute — the layer draws full opacity', () => {
    expect(selectionAttribute(null)).toBeUndefined()
  })

  it('builds exactly ONE prefixed scatter layer id per dense cell (no separate highlight overlay)', () => {
    // D collapses the base+highlight pair to one SelectableScatterLayer keyed by cellScatterLayerId;
    // each cell contributes exactly one id, carrying the `<cellId>::` routing prefix.
    const ids = ['a', 'b', 'c']
    const layerIds = ids.map(cellScatterLayerId)
    expect(new Set(layerIds).size).toBe(3)
    for (let i = 0; i < ids.length; i++) {
      expect(layerIds[i].startsWith(`${ids[i]}${'::'}`)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// ITEM-5 (declarative capability enforcement) on the DENSE scatter path — a cell opts out of
// consuming / producing the shared selection. Default (unset) is TRUE ⇒ byte-identical.
// ---------------------------------------------------------------------------

describe('cellConsumesSelection / cellProducesSelection — dense-path capability gate (ITEM-5)', () => {
  it('defaults to TRUE when the flag is unset (byte-identical to pre-enforcement)', () => {
    const cell: GridCell = { id: 'a', kind: 'scatter', layoutId: 'primary' }
    expect(cellConsumesSelection(cell)).toBe(true)
    expect(cellProducesSelection(cell)).toBe(true)
  })

  it('an explicit false opts the dense cell OUT (no dim on consume / no publish on produce)', () => {
    expect(cellConsumesSelection({ consumesSelection: false })).toBe(false)
    expect(cellProducesSelection({ producesSelection: false })).toBe(false)
  })

  it('an explicit true is honored (still consumes / still produces)', () => {
    expect(cellConsumesSelection({ consumesSelection: true })).toBe(true)
    expect(cellProducesSelection({ producesSelection: true })).toBe(true)
  })

  it('the two flags are independent (a cell can consume but not produce, and vice-versa)', () => {
    const mk = (o: Partial<GridCell>): GridCell => ({ id: 'a', kind: 'scatter', layoutId: 'primary', ...o })
    const consumeOnly = mk({ consumesSelection: true, producesSelection: false })
    expect(cellConsumesSelection(consumeOnly)).toBe(true)
    expect(cellProducesSelection(consumeOnly)).toBe(false)
    const produceOnly = mk({ consumesSelection: false, producesSelection: true })
    expect(cellConsumesSelection(produceOnly)).toBe(false)
    expect(cellProducesSelection(produceOnly)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// MD-11 (ITEM-11): per-dataset selection-index cache (identity-keyed, build-once).
// ---------------------------------------------------------------------------

describe('makePointIndexCache — MD-11 build-once KD-tree cache', () => {
  it('returns the SAME index for a stable positions buffer (memoized, not rebuilt)', () => {
    let builds = 0
    const cache = makePointIndexCache(pos => {
      builds++
      return buildPointIndex(pos)
    })
    const pos = Float32Array.from([0, 0, 1, 1, 2, 2])
    const first = cache.get(pos)
    const second = cache.get(pos)
    expect(second).toBe(first) // identity — reused
    expect(builds).toBe(1) // built once
  })

  it('builds a fresh index for a DIFFERENT buffer (a new dataset gen replaces the buffer)', () => {
    let builds = 0
    const cache = makePointIndexCache(pos => {
      builds++
      return buildPointIndex(pos)
    })
    const a = Float32Array.from([0, 0, 1, 1])
    const b = Float32Array.from([0, 0, 1, 1]) // same VALUES, different identity
    const idxA = cache.get(a)
    const idxB = cache.get(b)
    expect(idxB).not.toBe(idxA)
    expect(builds).toBe(2)
    // …and the original buffer still returns its cached index.
    expect(cache.get(a)).toBe(idxA)
    expect(builds).toBe(2)
  })

  it('the cached index answers a real range query correctly (not a stub)', () => {
    const cache = makePointIndexCache()
    const pos = Float32Array.from([0, 0, 5, 5, 10, 10])
    const idx = cache.get(pos)
    const hits = Array.from(idx.range(-1, -1, 6, 6)).sort((x, y) => x - y)
    expect(hits).toEqual([0, 1]) // points at (0,0) and (5,5), not (10,10)
  })
})

// ---------------------------------------------------------------------------
// swapCellContent — pure drag-to-swap field trade (ITEM-70).
// ---------------------------------------------------------------------------

describe('swapCellContent — pure content swap', () => {
  const colorBy: ColorBy = {
    mode: 'continuous',
    key: 'qcA',
    colormap: 'viridis',
    scale: 'linear',
    hidden: new Set<number>(),
  }

  it('trades content fields while preserving each cell id + layoutId', () => {
    const a: GridCell = { id: 'a', kind: 'scatter', layoutId: 'primary', colorBy, graphOverlay: true, controlled: true }
    const b: GridCell = { id: 'b', kind: 'heatmap', layoutId: 'secondary', linkColorScale: true }
    const [aNext, bNext] = swapCellContent(a, b)
    // ids + slots preserved.
    expect(aNext.id).toBe('a')
    expect(bNext.id).toBe('b')
    expect(aNext.layoutId).toBe('primary')
    expect(bNext.layoutId).toBe('secondary')
    // content traded.
    expect(aNext.kind).toBe('heatmap')
    expect(bNext.kind).toBe('scatter')
    expect(aNext.colorBy).toBeUndefined()
    expect(bNext.colorBy).toBe(colorBy)
    expect(aNext.linkColorScale).toBe(true)
    expect(bNext.linkColorScale).toBeUndefined()
    expect(aNext.graphOverlay).toBeUndefined()
    expect(bNext.graphOverlay).toBe(true)
    // Phase 3: the `controlled` flag travels WITH the content on a swap (follows the derived series).
    expect(aNext.controlled).toBeUndefined()
    expect(bNext.controlled).toBe(true)
  })

  it('does not mutate the inputs (immutable)', () => {
    const a: GridCell = { id: 'a', kind: 'scatter', layoutId: 'primary' }
    const b: GridCell = { id: 'b', kind: 'violin', layoutId: 'primary' }
    swapCellContent(a, b)
    expect(a.kind).toBe('scatter')
    expect(b.kind).toBe('violin')
  })

  it('is a no-op at the field level when swapping a cell with an identical clone (self)', () => {
    const a: GridCell = { id: 'a', kind: 'bar', layoutId: 'primary', graphOverlay: true }
    const [aNext] = swapCellContent(a, { ...a })
    expect(aNext).toEqual(a)
  })
})

// ---------------------------------------------------------------------------
// The GridWorkspace store — add / remove / split / resize / setCellKind.
// ---------------------------------------------------------------------------

describe('GridWorkspace store', () => {
  beforeEach(() => {
    useGridWorkspaceStore.getState().reset()
  })

  it('starts with a single default scatter cell', () => {
    const s = useGridWorkspaceStore.getState()
    expect(leafIds(s.layout)).toEqual([INITIAL_CELL_ID])
    expect(s.cells[INITIAL_CELL_ID].kind).toBe('scatter')
  })

  it('splitCell adds a leaf + a matching cell config in lockstep', () => {
    const s = useGridWorkspaceStore.getState()
    const newId = s.splitCell(INITIAL_CELL_ID, 'col', 'violin')
    expect(newId).toBe('cell-2')
    const now = useGridWorkspaceStore.getState()
    // leaf set grew from 1 → 2, and every leaf has a config.
    expect(new Set(leafIds(now.layout))).toEqual(new Set([INITIAL_CELL_ID, 'cell-2']))
    expect(Object.keys(now.cells).sort()).toEqual([INITIAL_CELL_ID, 'cell-2'])
    expect(now.cells['cell-2'].kind).toBe('violin')
  })

  it('builds a non-uniform grid (top row 2 cells, bottom row 1)', () => {
    const s = useGridWorkspaceStore.getState()
    s.splitCell(INITIAL_CELL_ID, 'row') // cell-2 below
    s.splitCell(INITIAL_CELL_ID, 'col') // cell-3 beside cell-1
    const now = useGridWorkspaceStore.getState()
    expect(leafIds(now.layout)).toEqual([INITIAL_CELL_ID, 'cell-3', 'cell-2'])
    // Rects: top row is two half-width panes, bottom is one full-width pane.
    const rects = computeRects(now.layout, 100, 100)
    const byId = Object.fromEntries(rects.map(r => [r.id, r]))
    expect(byId[INITIAL_CELL_ID].width).toBeCloseTo(50)
    expect(byId['cell-3'].width).toBeCloseTo(50)
    expect(byId['cell-2'].width).toBeCloseTo(100)
  })

  it('addCell splits the last leaf and returns the new id', () => {
    const s = useGridWorkspaceStore.getState()
    const id = s.addCell('col')
    expect(id).toBe('cell-2')
    expect(leafIds(useGridWorkspaceStore.getState().layout)).toContain('cell-2')
  })

  it('removeCell drops the leaf + its config and collapses the split', () => {
    const s = useGridWorkspaceStore.getState()
    s.splitCell(INITIAL_CELL_ID, 'col') // → cell-2
    useGridWorkspaceStore.getState().removeCell('cell-2')
    const now = useGridWorkspaceStore.getState()
    expect(leafIds(now.layout)).toEqual([INITIAL_CELL_ID])
    expect(now.cells['cell-2']).toBeUndefined()
    // single-child split collapsed back to a lone leaf.
    expect(now.layout.kind).toBe('leaf')
  })

  it('removeCell never empties the workspace (last cell is a no-op)', () => {
    const s = useGridWorkspaceStore.getState()
    s.removeCell(INITIAL_CELL_ID)
    const now = useGridWorkspaceStore.getState()
    expect(leafIds(now.layout)).toEqual([INITIAL_CELL_ID])
  })

  it('setCellKind changes a cell view-kind', () => {
    const s = useGridWorkspaceStore.getState()
    s.setCellKind(INITIAL_CELL_ID, 'heatmap')
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].kind).toBe('heatmap')
  })

  it('toggleCellGraphOverlay flips the per-cell overlay flag (undefined ⇒ on ⇒ off)', () => {
    const s = useGridWorkspaceStore.getState()
    // starts absent (off).
    expect(s.cells[INITIAL_CELL_ID].graphOverlay).toBeFalsy()
    s.toggleCellGraphOverlay(INITIAL_CELL_ID)
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].graphOverlay).toBe(true)
    // additive: does not disturb the cell's kind.
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].kind).toBe('scatter')
    s.toggleCellGraphOverlay(INITIAL_CELL_ID)
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].graphOverlay).toBe(false)
  })

  it('toggleCellGraphOverlay is a no-op on an unknown cell id', () => {
    const s = useGridWorkspaceStore.getState()
    s.toggleCellGraphOverlay('nope')
    expect(useGridWorkspaceStore.getState().cells['nope']).toBeUndefined()
  })

  it('setCellColorBy attaches a per-cell color-by (additive; kind untouched)', () => {
    const s = useGridWorkspaceStore.getState()
    expect(s.cells[INITIAL_CELL_ID].colorBy).toBeUndefined()
    s.setCellColorBy(INITIAL_CELL_ID, {
      mode: 'continuous',
      key: 'qcA',
      colormap: 'viridis',
      scale: 'linear',
      hidden: new Set<number>(),
    })
    const now = useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID]
    expect(now.colorBy?.key).toBe('qcA')
    expect(now.colorBy?.mode).toBe('continuous')
    // additive: the cell's kind is left alone.
    expect(now.kind).toBe('scatter')
  })

  it('setCellColorBy is a no-op on an unknown cell id', () => {
    const s = useGridWorkspaceStore.getState()
    s.setCellColorBy('nope', {
      mode: 'value',
      key: 'g0',
      colormap: 'viridis',
      scale: 'linear',
      hidden: new Set<number>(),
    })
    expect(useGridWorkspaceStore.getState().cells['nope']).toBeUndefined()
  })

  it('toggleCellLinkColorScale flips the flag (undefined ⇒ on ⇒ off)', () => {
    const s = useGridWorkspaceStore.getState()
    expect(s.cells[INITIAL_CELL_ID].linkColorScale).toBeFalsy()
    s.toggleCellLinkColorScale(INITIAL_CELL_ID)
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].linkColorScale).toBe(true)
    // additive: does not disturb the cell's kind.
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].kind).toBe('scatter')
    s.toggleCellLinkColorScale(INITIAL_CELL_ID)
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].linkColorScale).toBe(false)
  })

  it('toggleCellLinkColorScale is a no-op on an unknown cell id', () => {
    const s = useGridWorkspaceStore.getState()
    s.toggleCellLinkColorScale('nope')
    expect(useGridWorkspaceStore.getState().cells['nope']).toBeUndefined()
  })

  it('the graph overlay layer id routes to its OWN cell viewport only (prefix)', () => {
    // Overlay layer ids carry the `<cellId>::` prefix, so makeLayerFilter routes them
    // via cellOfLayer even though they are NOT in buildLayerCellMap (like `highlight`).
    const filter = makeLayerFilter(buildLayerCellMap(['a', 'b']))
    const edges = { id: cellLayerId('a', 'graph-edges') }
    expect(filter({ layer: edges, viewport: { id: 'a' } })).toBe(true)
    expect(filter({ layer: edges, viewport: { id: 'b' } })).toBe(false)
    const labels = { id: cellLayerId('b', 'graph-labels') }
    expect(filter({ layer: labels, viewport: { id: 'b' } })).toBe(true)
    expect(filter({ layer: labels, viewport: { id: 'a' } })).toBe(false)
  })

  it('resizeDivider re-weights the root split, preserving the total', () => {
    const s = useGridWorkspaceStore.getState()
    s.splitCell(INITIAL_CELL_ID, 'col') // root becomes a 50/50 col split
    useGridWorkspaceStore.getState().resizeDivider([], 0, 0.2)
    const now = useGridWorkspaceStore.getState()
    expect(now.layout.kind).toBe('split')
    if (now.layout.kind === 'split') {
      expect(now.layout.sizes[0]).toBeCloseTo(0.7)
      expect(now.layout.sizes[1]).toBeCloseTo(0.3)
      expect(now.layout.sizes[0] + now.layout.sizes[1]).toBeCloseTo(1)
    }
  })

  it('swapCells trades two cells content while keeping ids + tree positions', () => {
    const s = useGridWorkspaceStore.getState()
    const c2 = s.splitCell(INITIAL_CELL_ID, 'col') // → cell-2 beside cell-1
    s.setCellKind(INITIAL_CELL_ID, 'scatter')
    s.setCellKind(c2, 'heatmap')
    s.toggleCellGraphOverlay(INITIAL_CELL_ID) // cell-1 graphOverlay = true
    const beforeLeaves = leafIds(useGridWorkspaceStore.getState().layout)
    useGridWorkspaceStore.getState().swapCells(INITIAL_CELL_ID, c2)
    const now = useGridWorkspaceStore.getState()
    // Content traded…
    expect(now.cells[INITIAL_CELL_ID].kind).toBe('heatmap')
    expect(now.cells[c2].kind).toBe('scatter')
    expect(now.cells[INITIAL_CELL_ID].graphOverlay).toBeFalsy()
    expect(now.cells[c2].graphOverlay).toBe(true)
    // …ids preserved and tree/leaf order (positions) UNCHANGED.
    expect(now.cells[INITIAL_CELL_ID].id).toBe(INITIAL_CELL_ID)
    expect(now.cells[c2].id).toBe(c2)
    expect(leafIds(now.layout)).toEqual(beforeLeaves)
  })

  it('swapCells is a no-op when either id is unknown', () => {
    const s = useGridWorkspaceStore.getState()
    s.setCellKind(INITIAL_CELL_ID, 'bar')
    s.swapCells(INITIAL_CELL_ID, 'nope')
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].kind).toBe('bar')
    s.swapCells('nope', INITIAL_CELL_ID)
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID].kind).toBe('bar')
  })

  it('swapCells is a no-op when idA === idB (self)', () => {
    const s = useGridWorkspaceStore.getState()
    s.setCellKind(INITIAL_CELL_ID, 'violin')
    s.toggleCellGraphOverlay(INITIAL_CELL_ID)
    s.swapCells(INITIAL_CELL_ID, INITIAL_CELL_ID)
    const now = useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID]
    expect(now.kind).toBe('violin')
    expect(now.graphOverlay).toBe(true)
  })

  it('the routing map derived from the store covers exactly its leaves', () => {
    const s = useGridWorkspaceStore.getState()
    s.splitCell(INITIAL_CELL_ID, 'col')
    s.splitCell(INITIAL_CELL_ID, 'row')
    const now = useGridWorkspaceStore.getState()
    const ids = leafIds(now.layout)
    const map = buildLayerCellMap(ids)
    expect(Object.keys(map).length).toBe(ids.length)
    for (const id of ids) expect(map[cellScatterLayerId(id)]).toBe(id)
  })
})

// ---------------------------------------------------------------------------
// seedChannelsForLoader — default per-channel seeding (green-tint fix).
// ---------------------------------------------------------------------------
describe('seedChannelsForLoader', () => {
  // A minimal fake Viv PixelSource: 'c'-axis at index 1, sized to `nC`.
  const fakeLoader = (nC: number, dtype = 'Uint8'): PixelSource<ChannelLabels>[] =>
    [{ labels: ['t', 'c', 'z', 'y', 'x'], shape: [1, nC, 1, 512, 512], dtype } as unknown as PixelSource<ChannelLabels>]

  it('seeds a 3-channel RGB source with NATURAL R/G/B at full contrast (no green tint)', () => {
    const ch = seedChannelsForLoader(fakeLoader(3))
    expect(ch).toHaveLength(3)
    expect(ch[0].color).toEqual([255, 0, 0])
    expect(ch[1].color).toEqual([0, 255, 0])
    // The fix: pure blue, NOT the cycling palette's [64,128,255] (whose green tinted the composite).
    expect(ch[2].color).toEqual([0, 0, 255])
    // Full-range contrast window for the 8-bit dtype, every channel visible.
    for (const c of ch) {
      expect(c.contrastLimits).toEqual([0, 255])
      expect(c.visible).toBe(true)
    }
  })

  it('sizes the contrast window to a 16-bit dtype (RGB path unchanged otherwise)', () => {
    const ch = seedChannelsForLoader(fakeLoader(3, 'Uint16'))
    expect(ch[2].color).toEqual([0, 0, 255])
    expect(ch[0].contrastLimits).toEqual([0, contrastMaxForDtype('Uint16')]) // [0, 65535]
  })

  it('keeps the cycling additive palette for a NON-3-channel (fluorescence) source', () => {
    const ch = seedChannelsForLoader(fakeLoader(4))
    expect(ch).toHaveLength(4)
    expect(ch[0].color).toEqual([255, 0, 0])
    expect(ch[1].color).toEqual([0, 255, 0])
    expect(ch[2].color).toEqual([64, 128, 255]) // cycling palette (unchanged for n !== 3)
    expect(ch[3].color).toEqual([255, 255, 255])
  })

  it('returns [] for an empty loader', () => {
    expect(seedChannelsForLoader([])).toEqual([])
  })
})
