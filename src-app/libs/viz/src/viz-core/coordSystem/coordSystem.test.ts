import { describe, it, expect, vi } from 'vitest'
// EXTENSIBILITY_STUDY Part 6 STEP 5 — the three coordinate systems as registered entities.
// These tests prove: (1) `installCoordSystems()` registers world2d/chart2d/matrix2d and each
// resolves its RenderHost; (2) every built-in chart descriptor's `coordinateSystem` maps to
// a registered coordinate system; (3) the grid's region model (`grid/multiView.ts`) is a
// behavior-identical re-seam of `isDenseKind` / `cellSpaceKey`.

import {
  installCoordSystems,
} from './installCoordSystems'
import {
  getCoordSystem,
  hasCoordSystem,
  coordSystems,
  registerCoordinateSystem,
  type CoordSystemDef,
} from '../registry/coordSystem'
import type { CoordSystemId } from '../registry/types'
import { sharedDeckHost, ownCanvasHost } from './RenderHost'
import { installBuiltins } from '../charts/installBuiltins'
import { chartTypes, getChartType } from '../registry/registry'
import {
  buildGridRegions,
  cellCoordSystem,
  cellRendersOnSharedDeck,
  regionSpaceKey,
  resolveCellRegion,
  sharedDeckRegions,
} from '../grid/multiView'
import { isDenseKind, cellSpaceKey, type GridCell } from '../grid/gridModel'

// Both registries must be populated before resolution (idempotent).
installBuiltins()
installCoordSystems()

// ---------------------------------------------------------------------------
// Registration: the 3 systems register + resolve their host.
// ---------------------------------------------------------------------------

describe('installCoordSystems', () => {
  it('registers world2d / chart2d / matrix2d', () => {
    expect(hasCoordSystem('world2d')).toBe(true)
    expect(hasCoordSystem('chart2d')).toBe(true)
    expect(hasCoordSystem('matrix2d')).toBe(true)
    const ids = coordSystems().map(cs => cs.id)
    expect(ids).toEqual(expect.arrayContaining(['world2d', 'chart2d', 'matrix2d']))
  })

  it('world2d resolves to the SHARED deck host (the dense partition)', () => {
    const cs = getCoordSystem('world2d')!
    expect(cs.host).toBe(sharedDeckHost)
    expect(cs.host.id).toBe('shared-deck')
    expect(cs.host.shared).toBe(true)
    expect(cs.camera).toBe('free-ortho')
    expect(cs.dimensions).toEqual(['x', 'y'])
  })

  it('chart2d / matrix2d resolve to the OWN-canvas host (not shared)', () => {
    for (const id of ['chart2d', 'matrix2d'] as const) {
      const cs = getCoordSystem(id)!
      expect(cs.host).toBe(ownCanvasHost)
      expect(cs.host.id).toBe('own-canvas')
      expect(cs.host.shared).toBe(false)
    }
    expect(getCoordSystem('chart2d')!.camera).toBe('auto-fit')
    expect(getCoordSystem('matrix2d')!.camera).toBe('window')
  })

  it('is idempotent (re-install does not multiply registrations)', () => {
    const before = coordSystems().length
    installCoordSystems()
    installCoordSystems()
    expect(coordSystems().length).toBe(before)
  })

  it('unregistered id resolves to undefined', () => {
    expect(getCoordSystem('bogus' as CoordSystemId)).toBeUndefined()
    expect(getCoordSystem(undefined)).toBeUndefined()
  })

  it('re-registering the same id warns and replaces (last-wins), then restores', () => {
    // Capture the real def so we can restore it after proving replacement — the registry
    // is module-global, so leaving a replacement in place would corrupt later assertions.
    const original = getCoordSystem('matrix2d')!
    const replacement: CoordSystemDef = { ...original } // distinct object, same id

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registerCoordinateSystem('matrix2d', replacement)
      // A stub that skipped the has()-check would neither warn nor... well, it would still
      // replace — but the WARN is the observable contract the audit found untested.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"matrix2d"'))
      // last-wins: the replacement object is what resolves now.
      expect(getCoordSystem('matrix2d')).toBe(replacement)
      expect(getCoordSystem('matrix2d')).not.toBe(original)
      // Restore the genuine def (this warn is swallowed by the still-active mock).
      registerCoordinateSystem('matrix2d', original)
      expect(getCoordSystem('matrix2d')).toBe(original)
    } finally {
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// create/dispose/dimension seam (ECharts §1.4, adapted to deck).
// ---------------------------------------------------------------------------

describe('CoordSystemDef.create', () => {
  it('builds a region instance carrying type / region / spaceKey / host', () => {
    const cs = getCoordSystem('world2d')!
    const inst = cs.create({ regionId: 'cell-1', spaceKey: 'embedding:umap' })
    expect(inst).toEqual({
      type: 'world2d',
      regionId: 'cell-1',
      spaceKey: 'embedding:umap',
      dimensions: ['x', 'y'],
      hostId: 'shared-deck',
    })
  })

  it('own-canvas systems stamp their own host id', () => {
    const inst = getCoordSystem('matrix2d')!.create({ regionId: 'c', spaceKey: 's' })
    expect(inst.type).toBe('matrix2d')
    expect(inst.hostId).toBe('own-canvas')
  })
})

// ---------------------------------------------------------------------------
// Every chart descriptor's coordinateSystem maps to a registered system.
// ---------------------------------------------------------------------------

describe('chart descriptors ↔ coordinate systems', () => {
  it('every built-in chart type resolves its coordinateSystem to a registered system', () => {
    const types = chartTypes()
    expect(types.length).toBeGreaterThan(0)
    for (const desc of types) {
      expect(hasCoordSystem(desc.coordinateSystem)).toBe(true)
      expect(getCoordSystem(desc.coordinateSystem)!.id).toBe(desc.coordinateSystem)
    }
  })

  it('the dense kinds (scatter / image) select world2d → shared deck', () => {
    for (const k of ['scatter', 'image'] as const) {
      expect(getChartType(k)!.coordinateSystem).toBe('world2d')
      expect(getCoordSystem(getChartType(k)!.coordinateSystem)!.host.shared).toBe(true)
    }
  })

  it('matrix kinds (heatmap / dotplot) select matrix2d → own canvas', () => {
    for (const k of ['heatmap', 'dotplot'] as const) {
      expect(getChartType(k)!.coordinateSystem).toBe('matrix2d')
      expect(getCoordSystem(getChartType(k)!.coordinateSystem)!.host.shared).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// grid/multiView — the region model is a behavior-identical re-seam.
// ---------------------------------------------------------------------------

/** Build a minimal cell of a given kind. */
function cell(id: string, kind: string, layoutId = 'umap'): GridCell {
  return { id, kind, layoutId }
}

const ALL_KINDS = [
  'scatter',
  'image',
  'grid',
  'violin',
  'box',
  'bar',
  'histogram',
  'dotplot',
  'heatmap',
  'volcano',
  'unregistered-kind',
]

describe('grid/multiView region model', () => {
  it('cellRendersOnSharedDeck is byte-identical to isDenseKind for every kind', () => {
    for (const kind of ALL_KINDS) {
      expect(cellRendersOnSharedDeck({ kind })).toBe(isDenseKind(kind))
    }
  })

  it('cellCoordSystem resolves the descriptor-selected system (undefined for a miss)', () => {
    expect(cellCoordSystem({ kind: 'scatter' })!.id).toBe('world2d')
    expect(cellCoordSystem({ kind: 'violin' })!.id).toBe('chart2d')
    expect(cellCoordSystem({ kind: 'heatmap' })!.id).toBe('matrix2d')
    expect(cellCoordSystem({ kind: 'unregistered-kind' })).toBeUndefined()
  })

  it('regionSpaceKey folds in cellSpaceKey unchanged (image vs embedding scope)', () => {
    const scatter = cell('c1', 'scatter', 'umap')
    const image = cell('c2', 'image', 'umap')
    expect(regionSpaceKey(scatter)).toBe(cellSpaceKey(scatter))
    expect(regionSpaceKey(image)).toBe(cellSpaceKey(image))
    // Same layoutId but different space ⇒ never collide (the embedding-blind-zoom fix).
    expect(regionSpaceKey(scatter)).not.toBe(regionSpaceKey(image))
  })

  it('resolveCellRegion maps a cell to its coord-system region (null on a miss)', () => {
    const region = resolveCellRegion(cell('c1', 'scatter', 'umap'))
    expect(region).toEqual({
      cellId: 'c1',
      coordSystem: 'world2d',
      hostId: 'shared-deck',
      shared: true,
      spaceKey: cellSpaceKey(cell('c1', 'scatter', 'umap')),
    })
    expect(resolveCellRegion(cell('c9', 'unregistered-kind'))).toBeNull()
  })

  it('buildGridRegions drops unregistered cells; sharedDeckRegions = the dense cells', () => {
    const cells = [
      cell('a', 'scatter'),
      cell('b', 'violin'),
      cell('c', 'heatmap'),
      cell('d', 'image'),
      cell('e', 'unregistered-kind'),
    ]
    const regions = buildGridRegions(cells)
    // 'e' is dropped (unregistered).
    expect(regions.map(r => r.cellId)).toEqual(['a', 'b', 'c', 'd'])
    // Shared-deck (world2d) regions are exactly the dense cells: scatter + image.
    expect(sharedDeckRegions(regions).map(r => r.cellId)).toEqual(['a', 'd'])
    for (const r of sharedDeckRegions(regions)) expect(r.shared).toBe(true)
  })
})
