// compatibleChartTypes.test.ts — the DATA-SHAPE-AWARE chart-type compatibility predicate. A
// single data shape fits several chart types (a `group`+`value` cell is a valid violin / box /
// bar / dotplot), so the per-cell kind switcher offers only the types the data can SATISFY, and
// the declarative `switchTo` validation reuses the same check. This proves:
//   • correct compatible sets for {group+value}, {N value + group}, {continuous}, {none}
//   • DATA-DRIVEN dense gating: a dense scatter/image is offered only when the dataset has a spatial
//     substrate (a layout OR an image), so a scatter cell over a dataset with BOTH an embedding and
//     columns can switch cross-boundary to a violin (the data supports both); the nested `grid`
//     container is never a switch target
//   • `schemaSatisfiable` counts channels PER single-column source (candlestick's 5 continuous
//     channels need 5 continuous columns — NOT satisfiable from a value column)
//   • the current kind is always included even when it would fall outside the compatible set.

import { describe, it, expect, beforeAll } from 'vitest'
import type { DatasetCatalog } from '../data/wire'
import { installBuiltins } from '../charts/installBuiltins'
import {
  compatibleChartTypes,
  columnAvailability,
  schemaSatisfiable,
  registerChartType,
  getChartType,
} from './registry'
import type { BindingChannel, ChartTypeDescriptor } from './types'
import type { GridCell } from '../grid/gridModel'

/** Build a catalog with the given column sets overriding the empty defaults. */
function makeCatalog(over: Partial<DatasetCatalog> = {}): DatasetCatalog {
  return {
    datasetId: 'test',
    pointCount: 100,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
    ...over,
  }
}

const GROUP = { id: 'group', kind: 'categorical' as const, label: 'Group' }
const TYPE = { id: 'type', kind: 'categorical' as const, label: 'Type' }
const QC_A = { id: 'qcA', kind: 'continuous' as const, label: 'QC A' }
const QC_B = { id: 'qcB', kind: 'continuous' as const, label: 'QC B' }

/** A `group`+`value` shape: one categorical + several value columns, NO continuous. */
const GROUP_VALUE = makeCatalog({
  categoricalColumns: [GROUP, TYPE],
  valueColumns: ['A', 'B', 'C', 'D'],
})
/** A `continuous`-only shape: continuous columns, NO categorical, NO value. */
const CONTINUOUS_ONLY = makeCatalog({ continuousColumns: [QC_A, QC_B] })
/** A shape with NO bindable columns at all (only points / positions). */
const EMPTY = makeCatalog()
/** A `group`+`value` shape that ALSO has a spatial substrate — so dense views are offerable too. */
const SPATIAL_GROUP_VALUE = makeCatalog({
  categoricalColumns: [GROUP, TYPE],
  valueColumns: ['A', 'B', 'C', 'D'],
  hasImage: true, // a spatial substrate ⇒ dense scatter/image become data-compatible
})

function typesOf(descs: ChartTypeDescriptor[]): string[] {
  return descs.map(d => d.type)
}

describe('compatibleChartTypes — data-shape-aware switch targets', () => {
  beforeAll(() => {
    installBuiltins() // populate the registry with the 10 built-ins
  })

  it('a {group + value} cell (current: violin) offers violin/box/bar/dotplot — NOT scatter/image/grid/candlestick', () => {
    const compatible = typesOf(compatibleChartTypes(GROUP_VALUE, 'violin'))
    // the data-bound family that fits group+value…
    for (const t of ['violin', 'box', 'bar', 'dotplot', 'heatmap']) {
      expect(compatible, `${t} fits a group+value shape`).toContain(t)
    }
    // …but NOT the dense / nested (bindingless) family — a cross-family switch is excluded.
    for (const t of ['scatter', 'image', 'grid']) {
      expect(compatible, `${t} is bindingless/dense → excluded for a data-bound cell`).not.toContain(t)
    }
  })

  it('a shape with BOTH columns and a spatial substrate offers dense AND chart types (data-driven cross-family)', () => {
    // A scatter cell over a dataset that has an embedding/raster AND group+value columns can become
    // a violin (columns present) OR stay a scatter (spatial substrate present) — the data supports
    // both, so both are offered. This is the point: a data shape maps to several chart types,
    // INCLUDING across the dense↔chart boundary when the dataset genuinely supports it.
    const fromScatter = typesOf(compatibleChartTypes(SPATIAL_GROUP_VALUE, 'scatter'))
    expect(fromScatter).toContain('scatter') // current kind
    expect(fromScatter).toContain('image') // spatial substrate ⇒ the other dense view too
    for (const t of ['violin', 'box', 'bar', 'dotplot', 'heatmap']) {
      expect(fromScatter, `${t} fits the columns → offered cross-family`).toContain(t)
    }
    expect(fromScatter).not.toContain('grid') // the nested container is never a switch target
  })

  it('the current kind is ALWAYS included even when the data cannot satisfy it', () => {
    // a violin cell over an EMPTY shape keeps violin selectable though no value/categorical exist.
    expect(typesOf(compatibleChartTypes(EMPTY, 'violin'))).toContain('violin')
    // a scatter cell over a NON-spatial group+value shape keeps scatter, but the OTHER dense view
    // (image) is NOT offered — there is no spatial substrate for it.
    const noSpatial = typesOf(compatibleChartTypes(GROUP_VALUE, 'scatter'))
    expect(noSpatial).toContain('scatter') // current kind, always kept
    expect(noSpatial).not.toContain('image') // no spatial substrate ⇒ other dense NOT offered
  })

  it('a {continuous-only} shape offers histogram but NOT the value/group charts', () => {
    // histogram binds a single `continuous` channel → satisfiable; volcano binds a fixed `table`
    // name (no dataset column) → always satisfiable. But violin/box (value + categorical) and
    // dotplot/heatmap (valueList + categorical) need columns this shape lacks.
    const compatible = typesOf(compatibleChartTypes(CONTINUOUS_ONLY, 'histogram'))
    expect(compatible).toContain('histogram')
    expect(compatible).toContain('volcano') // table channel is always satisfiable
    for (const t of ['violin', 'box', 'dotplot', 'heatmap']) {
      expect(compatible, `${t} needs value/categorical columns the continuous-only shape lacks`).not.toContain(t)
    }
    // bar needs a categorical column → not satisfiable here.
    expect(compatible).not.toContain('bar')
  })

  it('an EMPTY (no columns, no spatial substrate) shape offers only table-only charts + the current kind', () => {
    // Data-bound cell (violin) over an empty shape: only `table`-only charts (volcano) survive the
    // satisfiability filter; violin itself is force-included (current kind), everything else drops.
    const dataBound = typesOf(compatibleChartTypes(EMPTY, 'violin'))
    expect(dataBound).toContain('violin') // current kind always kept
    expect(dataBound).toContain('volcano') // table channel needs no columns
    expect(dataBound).not.toContain('box') // needs a value column
    expect(dataBound).not.toContain('bar') // needs a categorical column
    // A scatter cell over an empty shape keeps scatter (current) but NOT image (no spatial) / grid.
    const dense = typesOf(compatibleChartTypes(EMPTY, 'scatter'))
    expect(dense).toContain('scatter')
    expect(dense).not.toContain('image')
    expect(dense).not.toContain('grid')
  })

  it('with NO currentKind, offers every type the DATASET satisfies (dense gated on a spatial substrate)', () => {
    // A non-spatial group+value shape: the fitting data-bound charts, but NO dense views + no container.
    const tabular = typesOf(compatibleChartTypes(GROUP_VALUE))
    expect(tabular).toEqual(expect.arrayContaining(['violin', 'box', 'bar', 'dotplot']))
    expect(tabular).not.toContain('scatter') // no spatial substrate
    expect(tabular).not.toContain('grid') // nested container
    // Add a spatial substrate ⇒ the dense views are offered ALONGSIDE the fitting charts.
    const spatial = typesOf(compatibleChartTypes(SPATIAL_GROUP_VALUE))
    expect(spatial).toEqual(expect.arrayContaining(['scatter', 'image', 'violin', 'box']))
  })
})

describe('schemaSatisfiable — counts channels PER single-column source (candlestick guard)', () => {
  const avail = columnAvailability(GROUP_VALUE) // { categorical:2, value:4, continuous:0 }

  it('a 5-continuous schema (candlestick shape) needs 5 continuous columns — NOT value columns', () => {
    const candleSchema: readonly BindingChannel[] = [
      { id: 'index', source: 'continuous', label: 'Bar' },
      { id: 'open', source: 'continuous', label: 'Open' },
      { id: 'high', source: 'continuous', label: 'High' },
      { id: 'low', source: 'continuous', label: 'Low' },
      { id: 'close', source: 'continuous', label: 'Close' },
    ]
    // group+value has 0 continuous columns → NOT satisfiable (the value columns must NOT stand in).
    expect(schemaSatisfiable(candleSchema, avail)).toBe(false)
    // 4 continuous columns still short of the 5 channels → still not satisfiable.
    expect(schemaSatisfiable(candleSchema, { categorical: 0, value: 0, continuous: 4 })).toBe(false)
    // exactly 5 continuous columns → satisfiable.
    expect(schemaSatisfiable(candleSchema, { categorical: 0, value: 0, continuous: 5 })).toBe(true)
  })

  it('an empty schema is trivially satisfiable; a valueList needs only ≥1 value column', () => {
    expect(schemaSatisfiable([], avail)).toBe(true)
    expect(schemaSatisfiable(undefined, avail)).toBe(true)
    const list: readonly BindingChannel[] = [{ id: 'vs', source: 'valueList', label: 'Vs' }]
    expect(schemaSatisfiable(list, { categorical: 0, value: 1, continuous: 0 })).toBe(true)
    expect(schemaSatisfiable(list, { categorical: 0, value: 0, continuous: 0 })).toBe(false)
  })

  it('candlestick (when registered) is excluded from a group+value cell\'s switch set', () => {
    // Register a candlestick-shaped descriptor if not already present (its extension may not be
    // installed here); the compat set for a group+value cell must still exclude it.
    if (!getChartType('candlestick')) {
      const desc: ChartTypeDescriptor = {
        type: 'candlestick',
        coordinateSystem: 'chart2d',
        view: (() => null) as unknown as ChartTypeDescriptor['view'],
        bindingSchema: [
          { id: 'index', source: 'continuous', label: 'Bar' },
          { id: 'open', source: 'continuous', label: 'Open' },
          { id: 'high', source: 'continuous', label: 'High' },
          { id: 'low', source: 'continuous', label: 'Low' },
          { id: 'close', source: 'continuous', label: 'Close' },
        ],
        model: (c: GridCell) => ({ kind: c.kind, bindings: {}, resolutions: {}, cell: c }),
      }
      registerChartType(desc)
    }
    const compatible = compatibleChartTypes(GROUP_VALUE, 'violin').map(d => d.type)
    expect(compatible).not.toContain('candlestick')
  })
})
