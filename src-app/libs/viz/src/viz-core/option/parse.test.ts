// parse.test.ts — the PURE `parseOption` parser (EXTENSIBILITY_STUDY Part 4 / STEP 6). Proves
// the declarative `VizOption` for a linked scatter+heatmap grid resolves to the expected plan:
// the split-tree layout, the per-cell configs (kind / colorBy / linkColorScale), the resolved
// series models (bindings overlaid with `encode`), the resolved participation flags, and the
// component config — all without React, deck, or a store.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { parseOption, buildLayout, normalizeDatasets, migrateOption } from './parse'
import { installBuiltins } from '../charts/installBuiltins'
import { getChartType, registerChartType } from '../registry/registry'
import type { ChartTypeDescriptor } from '../registry/types'
import type { GridCell } from '../grid/gridModel'
import type { DatasetCatalog } from '../data/wire'
import type { VizOption } from './types'

// A minimal fixture-shaped catalog (mirrors FixtureSource: first categorical 'group',
// value columns 'Feature *', first continuous 'qcA').
const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 1000,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: ['Feature A', 'Feature B', 'Feature C', 'Feature D'],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
  continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
  hasImage: false,
}

// The Part 4 example: a linked scatter (world2d) + heatmap (matrix2d) grid with dataZoom +
// selection + a linked color scale.
const OPTION: VizOption = {
  dataset: { id: 'demo' },
  grid: [
    { id: 'g-left', region: { col: 0 } },
    { id: 'g-right', region: { col: 1 } },
  ],
  dataZoom: [
    { id: 'z-scatter', type: 'inside', coordId: 'g-left', axes: ['x', 'y'] },
    { id: 'z-heat', type: 'slider', coordId: 'g-right', axes: ['x'] },
  ],
  selection: { mode: 'lasso', link: ['s-scatter', 's-heat'] },
  colorScale: { link: ['s-scatter'] },
  series: [
    {
      id: 's-scatter',
      type: 'scatter',
      coordId: 'g-left',
      encode: { layout: 'primary', colorBy: { mode: 'continuous', key: 'qcA', colormap: 'viridis' } },
      emphasis: { consumesSelection: true },
      select: { produces: true },
      controlled: true,
    },
    {
      id: 's-heat',
      type: 'heatmap',
      coordId: 'g-right',
      encode: { groupKey: 'group', valueKeys: ['Feature A', 'Feature B', 'Feature C'] },
      emphasis: { consumesSelection: true },
    },
  ],
}

describe('parseOption (Part 4 linked scatter+heatmap)', () => {
  beforeAll(() => {
    installBuiltins() // populate the registry the parser resolves against
  })

  it('stamps a per-series `controlled` flag onto the cell (Phase 3 controlled close); absent ⇒ undefined', () => {
    const plan = parseOption(OPTION, { demo: CATALOG })
    expect(plan.cells['g-left'].controlled).toBe(true) // s-scatter opted in
    expect(plan.cells['g-right'].controlled).toBeUndefined() // s-heat did not → field-free
  })

  it('resolves two cells keyed by region id, kind from the bound series', () => {
    const plan = parseOption(OPTION, { demo: CATALOG })
    expect(Object.keys(plan.cells).sort()).toEqual(['g-left', 'g-right'])
    expect(plan.cells['g-left'].kind).toBe('scatter')
    expect(plan.cells['g-right'].kind).toBe('heatmap')
    expect(plan.cells['g-left'].layoutId).toBe('primary')
    expect(plan.seq).toBe(2)
    expect(plan.order).toEqual(['g-left', 'g-right'])
  })

  it('builds a two-column split-tree layout from the regions', () => {
    const plan = parseOption(OPTION, { demo: CATALOG })
    expect(plan.layout).toEqual({
      kind: 'split',
      dir: 'col',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'g-left' },
        { kind: 'leaf', id: 'g-right' },
      ],
    })
  })

  it('resolves the scatter series: world2d, colorBy from encode, produces+consumes selection', () => {
    const plan = parseOption(OPTION, { demo: CATALOG })
    const scatter = plan.series.find(s => s.id === 's-scatter')!
    expect(scatter.coordinateSystem).toBe('world2d')
    expect(scatter.consumesSelection).toBe(true)
    expect(scatter.producesSelection).toBe(true)
    expect(scatter.linkColorScale).toBe(true) // in colorScale.link
    expect(scatter.colorBy).toEqual({
      mode: 'continuous',
      key: 'qcA',
      colormap: 'viridis',
      scale: 'linear', // filled default
      hidden: new Set<number>(), // filled default
    })
    // the cell carries the same colorBy + link flag (drives the dense-cell coloring)
    expect(plan.cells['g-left'].colorBy?.key).toBe('qcA')
    expect(plan.cells['g-left'].linkColorScale).toBe(true)
  })

  it('resolves the heatmap series: matrix2d, encode bindings overlaid onto the model', () => {
    const plan = parseOption(OPTION, { demo: CATALOG })
    const heat = plan.series.find(s => s.id === 's-heat')!
    expect(heat.coordinateSystem).toBe('matrix2d')
    expect(heat.consumesSelection).toBe(true)
    expect(heat.producesSelection).toBe(true) // descriptor default (not overridden)
    expect(heat.linkColorScale).toBe(false)
    // encode overlaid the valueKeys/group onto the descriptor-resolved bindings
    expect(heat.model.bindings.valueKeys).toEqual(['Feature A', 'Feature B', 'Feature C'])
    expect(heat.model.bindings.group).toBe('group')
  })

  it('resolves the decoupled components (dataZoom spaceKey, selection, colorScale, gridLinked)', () => {
    const plan = parseOption(OPTION, { demo: CATALOG })
    expect(plan.dataZoom.map(z => z.id)).toEqual(['z-scatter', 'z-heat'])
    const zScatter = plan.dataZoom.find(z => z.id === 'z-scatter')!
    expect(zScatter.axes).toEqual(['x', 'y'])
    expect(zScatter.spaceKey).toBe('embedding:primary') // cellSpaceKey of the scatter region
    expect(plan.selection).toEqual({ mode: 'lasso', link: ['s-scatter', 's-heat'] })
    expect(plan.colorScale).toEqual({ link: ['s-scatter'] })
    // scatter + heatmap live in DIFFERENT coord systems → no world2d space with ≥2 → not linked
    expect(plan.gridLinked).toBe(false)
  })

  it('links the grid cameras when two world2d series share one coordinate space', () => {
    const twoScatters: VizOption = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', region: { col: 0 } },
        { id: 'b', region: { col: 1 } },
      ],
      series: [
        { id: 's-a', type: 'scatter', coordId: 'a', encode: { layout: 'primary' } },
        { id: 's-b', type: 'scatter', coordId: 'b', encode: { layout: 'primary' } },
      ],
    }
    expect(parseOption(twoScatters, { demo: CATALOG }).gridLinked).toBe(true)
  })

  it('honors an explicit gridLinked override (independent-by-default despite a shared space)', () => {
    const twoScatters = (gridLinked?: boolean): VizOption => ({
      dataset: { id: 'demo' },
      grid: [
        { id: 'a', region: { col: 0 } },
        { id: 'b', region: { col: 1 } },
      ],
      series: [
        { id: 's-a', type: 'scatter', coordId: 'a', encode: { layout: 'primary' } },
        { id: 's-b', type: 'scatter', coordId: 'b', encode: { layout: 'primary' } },
      ],
      ...(gridLinked === undefined ? {} : { gridLinked }),
    })
    // Same space would auto-link, but an explicit false wins → cells zoom independently by default.
    expect(parseOption(twoScatters(false), { demo: CATALOG }).gridLinked).toBe(false)
    // Explicit true forces linking; absent falls back to the auto-derivation (true here).
    expect(parseOption(twoScatters(true), { demo: CATALOG }).gridLinked).toBe(true)
    expect(parseOption(twoScatters(undefined), { demo: CATALOG }).gridLinked).toBe(true)
  })

  describe('validation (fail loud, never silently half-mount)', () => {
    it('throws on an unregistered series type', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'nope', coordId: 'g' }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/unregistered type "nope"/)
    })

    it('throws on an unknown coordId', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'scatter', coordId: 'missing' }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/unknown coordId "missing"/)
    })

    it('throws on an unbound grid region', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [
          { id: 'g', region: { col: 0 } },
          { id: 'orphan', region: { col: 1 } },
        ],
        series: [{ id: 's', type: 'scatter', coordId: 'g' }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/region "orphan" has no series/)
    })

    it('throws on a selection link to an unknown series', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        selection: { mode: 'lasso', link: ['s', 'ghost'] },
        series: [{ id: 's', type: 'scatter', coordId: 'g' }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/unknown series "ghost"/)
    })

    it('throws when two series bind the same region', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [
          { id: 's1', type: 'scatter', coordId: 'g' },
          { id: 's2', type: 'violin', coordId: 'g' },
        ],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/bound by more than one series/)
    })

    it('throws on a duplicate grid id, naming the offending id', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [
          { id: 'dup', region: { col: 0 } },
          { id: 'dup', region: { col: 1 } },
        ],
        series: [],
      }
      // A stub that skips the grid-id uniqueness check would proceed silently; the
      // real parser throws AND the message names the duplicated id.
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/duplicate grid id "dup"/)
    })

    it('throws on a duplicate series id, naming the offending id', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [
          { id: 'sameId', type: 'scatter', coordId: 'g' },
          { id: 'sameId', type: 'scatter', coordId: 'g' },
        ],
      }
      // The duplicate-id guard fires before the same-region guard, so the message
      // must specifically name the duplicated series id.
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(/duplicate series id "sameId"/)
    })

    it('throws when dataZoom references an unknown coordId, naming it', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'scatter', coordId: 'g' }],
        dataZoom: [{ id: 'z', type: 'inside', coordId: 'nope', axes: ['x'] }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(
        /dataZoom "z" references unknown coordId "nope"/,
      )
    })

    it('throws when colorScale.link references an unknown series, naming it', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'scatter', coordId: 'g' }],
        colorScale: { link: ['ghost'] },
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(
        /colorScale\.link references unknown series "ghost"/,
      )
    })

    // #4 — a RESOLVED binding that names a column absent from the dataset fails LOUD at parse
    // (rather than half-mounting a View that then hangs on the rejected column fetch).
    it('throws when encode binds a value column absent from the dataset (naming column + kind)', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g', encode: { valueKey: 'Nope', groupKey: 'group' } }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(
        /series "s": encode binds "Nope" which is not a value column in the dataset/,
      )
    })

    it('throws when encode binds a categorical column absent from the dataset', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'box', coordId: 'g', encode: { valueKey: 'Feature A', groupKey: 'ghostGroup' } }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(
        /encode binds "ghostGroup" which is not a categorical column/,
      )
    })

    it('throws when a valueList encode binds any column absent from the dataset', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [
          { id: 's', type: 'heatmap', coordId: 'g', encode: { groupKey: 'group', valueKeys: ['Feature A', 'BadFeat'] } },
        ],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(
        /encode binds "BadFeat" which is not a value column/,
      )
    })

    it('does NOT throw when a continuous channel resolves to a value column (the valueKey fallback)', () => {
      const ok: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'histogram', coordId: 'g', encode: { valueKey: 'Feature A' } }],
      }
      // 'Feature A' is a value column (not continuous) but the continuous channel legitimately
      // accepts the valueKey fallback — validation must not reject it.
      expect(() => parseOption(ok, { demo: CATALOG })).not.toThrow()
    })

    it('does NOT throw on the all-defaults (no encode) path', () => {
      const ok: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g' }],
      }
      expect(() => parseOption(ok, { demo: CATALOG })).not.toThrow()
    })

    // #3 — validation is scoped to ENCODE-EXPLICIT bindings only. When a series supplies NO
    // encode, `resolveBinding` fills catalog DEFAULTS, falling back to the conventional NAME
    // ('group' / 'qcA') if the dataset lacks a categorical / continuous column. That fallback
    // name is (legitimately) absent from the catalog — but because it is a DEFAULT, not
    // encode-explicit, parse must NOT throw (the View's empty/error state owns the no-data).
    // Previously this threw ("'group' is not a categorical column") → a blank grid.
    it('does NOT throw for a default binding whose conventional column is ABSENT from the catalog', () => {
      // A catalog with value columns but NO categorical + NO continuous columns.
      const noCatCatalog: DatasetCatalog = {
        datasetId: 'sparse',
        pointCount: 10,
        layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
        valueColumns: ['Feature A', 'Feature B'],
        categoricalColumns: [],
        continuousColumns: [],
        hasImage: false,
      }
      // violin's group channel resolves to the conventional 'group' fallback (absent here), and its
      // continuous/value channels to defaults — none supplied via encode, so none is validated.
      const allDefaults: VizOption = {
        dataset: { id: 'sparse' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g' }],
      }
      expect(() => parseOption(allDefaults, noCatCatalog)).not.toThrow()
      // And a histogram whose continuous channel falls back to the conventional 'qcA' name.
      const histDefaults: VizOption = {
        dataset: { id: 'sparse' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'histogram', coordId: 'g' }],
      }
      expect(() => parseOption(histDefaults, noCatCatalog)).not.toThrow()
    })

    // Complement to the scope: an EXPLICIT encode binding on that same sparse catalog STILL throws.
    it('DOES throw when an encode-explicit binding names an absent column (scope excludes only defaults)', () => {
      const noCatCatalog: DatasetCatalog = {
        datasetId: 'sparse',
        pointCount: 10,
        layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
        valueColumns: ['Feature A', 'Feature B'],
        categoricalColumns: [],
        continuousColumns: [],
        hasImage: false,
      }
      const bad: VizOption = {
        dataset: { id: 'sparse' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g', encode: { groupKey: 'group', valueKey: 'Feature A' } }],
      }
      expect(() => parseOption(bad, noCatCatalog)).toThrow(
        /encode binds "group" which is not a categorical column/,
      )
    })
  })

  // M5 — a misspelled `encode` key is otherwise SILENTLY dropped (the VizEncode index
  // signature lets it type-check). Dev-mode WARNS (never throws — the escape hatch stays open).
  describe('encode-key typo warning (M5)', () => {
    it('warns (does not throw) on an unknown encode key, naming it', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const option: VizOption = {
          dataset: { id: 'demo' },
          grid: [{ id: 'g', region: {} }],
          // `grpKey` is a typo for `groupKey`: it type-checks via the index signature but binds nothing.
          series: [
            { id: 's', type: 'violin', coordId: 'g', encode: { valueKey: 'Feature A', groupKey: 'group', grpKey: 'group' } },
          ],
        }
        expect(() => parseOption(option, { demo: CATALOG })).not.toThrow()
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('grpKey'))
      } finally {
        spy.mockRestore()
      }
    })

    it('does NOT warn on recognized keys (layout + the chart channels)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const option: VizOption = {
          dataset: { id: 'demo' },
          grid: [{ id: 'g', region: {} }],
          series: [
            { id: 's', type: 'violin', coordId: 'g', encode: { layout: 'primary', valueKey: 'Feature A', groupKey: 'group' } },
          ],
        }
        parseOption(option, { demo: CATALOG })
        expect(spy).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
  })

  // The `continuous` binding channel falls back to `encode.valueKey` when no
  // `continuousKey` is supplied (histogram declares a `continuous` value channel).
  // A stub that only honored `continuousKey` (or the catalog default) would leave the
  // catalog default 'qcA' bound and stay green — this asserts the real fallback.
  describe('overlayEncode continuous-fallback', () => {
    it('binds a continuous channel to encode.valueKey when continuousKey is absent', () => {
      const option: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [
          { id: 's', type: 'histogram', coordId: 'g', encode: { valueKey: 'Feature A' } },
        ],
      }
      const plan = parseOption(option, { demo: CATALOG })
      const hist = plan.series.find(s => s.id === 's')!
      // Fallback resolved the continuous channel ('value') to the encode valueKey,
      // NOT the catalog-default first continuous column ('qcA').
      expect(hist.model.bindings.value).toBe('Feature A')
      expect(hist.model.bindings.value).not.toBe('qcA')
    })

    it('prefers continuousKey over valueKey when both are present', () => {
      const option: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [
          {
            id: 's',
            type: 'histogram',
            coordId: 'g',
            encode: { continuousKey: 'qcA', valueKey: 'Feature A' },
          },
        ],
      }
      const plan = parseOption(option, { demo: CATALOG })
      expect(plan.series.find(s => s.id === 's')!.model.bindings.value).toBe('qcA')
    })
  })

  // The explicit `switchTo` alternatives — the author-declared set the cell's kind switcher may
  // offer. Validated (registered + data-compatible) and threaded onto the cell as `cell.switchTo`.
  describe('switchTo (explicit kind-switch alternatives)', () => {
    it('threads a valid, data-compatible switchTo onto the cell', () => {
      const option: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g', switchTo: ['box', 'bar', 'dotplot'] }],
      }
      const plan = parseOption(option, { demo: CATALOG })
      expect(plan.cells['g'].switchTo).toEqual(['box', 'bar', 'dotplot'])
    })

    it('leaves cell.switchTo undefined when no switchTo is declared (back-compat)', () => {
      const option: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g' }],
      }
      expect(parseOption(option, { demo: CATALOG }).cells['g'].switchTo).toBeUndefined()
    })

    it('throws on a switchTo referencing an UNREGISTERED type, naming it', () => {
      const bad: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g', switchTo: ['box', 'nope'] }],
      }
      expect(() => parseOption(bad, { demo: CATALOG })).toThrow(
        /series "s": switchTo references unregistered type "nope"/,
      )
    })

    it('throws on a switchTo type INCOMPATIBLE with the dataset, naming it', () => {
      // A catalog with NO categorical columns: `bar` (which needs a categorical `group` channel)
      // is registered but NOT data-compatible → a declared switchTo to it must fail loud.
      const noCat: DatasetCatalog = {
        datasetId: 'nocat',
        pointCount: 10,
        layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
        valueColumns: ['Feature A', 'Feature B'],
        categoricalColumns: [],
        continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
        hasImage: false,
      }
      const bad: VizOption = {
        dataset: { id: 'nocat' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'histogram', coordId: 'g', switchTo: ['bar'] }],
      }
      expect(() => parseOption(bad, noCat)).toThrow(
        /series "s": switchTo type "bar" is not compatible with the dataset/,
      )
    })

    it('accepts a switchTo whose types ARE all data-compatible (registered + satisfiable)', () => {
      const ok: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'violin', coordId: 'g', switchTo: ['box', 'bar', 'heatmap'] }],
      }
      expect(() => parseOption(ok, { demo: CATALOG })).not.toThrow()
    })
  })

  describe('transitions (opt-in, per-plot)', () => {
    it('omitted ⇒ NO transitions on the resolved series OR cell (default off, byte-identical)', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'bar', coordId: 'g' }],
      }
      const resolved = parseOption(opt, { demo: CATALOG })
      expect(resolved.series[0].transitions).toBeUndefined()
      expect(resolved.cells.g.transitions).toBeUndefined()
    })

    it('`false` ⇒ still off (no field threaded)', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'bar', coordId: 'g', transitions: false }],
      }
      const resolved = parseOption(opt, { demo: CATALOG })
      expect(resolved.series[0].transitions).toBeUndefined()
      expect(resolved.cells.g.transitions).toBeUndefined()
    })

    it('an enabled config threads onto BOTH the resolved series AND the cell', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'box', coordId: 'g', transitions: { duration: 250, easing: 'linear' } }],
      }
      const resolved = parseOption(opt, { demo: CATALOG })
      expect(resolved.series[0].transitions).toEqual({ duration: 250, easing: 'linear' })
      expect(resolved.cells.g.transitions).toEqual({ duration: 250, easing: 'linear' })
    })

    it('an empty config `{}` enables (defaults applied later by the View)', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'dotplot', coordId: 'g', transitions: {} }],
      }
      const resolved = parseOption(opt, { demo: CATALOG })
      expect(resolved.cells.g.transitions).toEqual({})
    })

    it('throws LOUD on a negative duration', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        series: [{ id: 's', type: 'bar', coordId: 'g', transitions: { duration: -1 } }],
      }
      expect(() => parseOption(opt, { demo: CATALOG })).toThrow(/series "s".*duration/)
    })

    it('throws LOUD on an unknown easing', () => {
      const opt: VizOption = {
        dataset: { id: 'demo' },
        grid: [{ id: 'g', region: {} }],
        // @ts-expect-error — an invalid easing name is rejected at parse
        series: [{ id: 's', type: 'bar', coordId: 'g', transitions: { easing: 'bounce' } }],
      }
      expect(() => parseOption(opt, { demo: CATALOG })).toThrow(/series "s".*easing/)
    })
  })

  describe('buildLayout', () => {
    it('a single region → a leaf', () => {
      expect(buildLayout([{ id: 'only', region: {} }])).toEqual({ kind: 'leaf', id: 'only' })
    })

    it('a row-major grid → a row split of col splits', () => {
      const layout = buildLayout([
        { id: 'a', region: { row: 0, col: 0 } },
        { id: 'b', region: { row: 0, col: 1 } },
        { id: 'c', region: { row: 1, col: 0 } },
      ])
      expect(layout).toEqual({
        kind: 'split',
        dir: 'row',
        sizes: [0.5, 0.5],
        children: [
          {
            kind: 'split',
            dir: 'col',
            sizes: [0.5, 0.5],
            children: [
              { kind: 'leaf', id: 'a' },
              { kind: 'leaf', id: 'b' },
            ],
          },
          { kind: 'leaf', id: 'c' },
        ],
      })
    })
  })
})

describe('parseOption — blend colorBy (BLEND_MODE_PLAN Phase 1)', () => {
  beforeAll(() => {
    installBuiltins()
  })

  const blendOption = (colorBy: Record<string, unknown>): VizOption => ({
    dataset: { id: 'demo' },
    grid: [{ id: 'g', region: { col: 0 } }],
    series: [
      { id: 's', type: 'scatter', coordId: 'g', encode: { layout: 'primary', colorBy } as never },
    ],
  })

  it('resolves a blend colorBy (categoryKey → hue, valueKey → modulation) with defaults', () => {
    const plan = parseOption(
      blendOption({ mode: 'blend', categoryKey: 'group', valueKey: 'qcA' }),
      CATALOG,
    )
    const cb = plan.cells['g'].colorBy!
    expect(cb.mode).toBe('blend')
    expect(cb).toMatchObject({
      mode: 'blend',
      key: 'group', // echoes categoryKey so `colorBy.key` consumers stay valid
      categoryKey: 'group',
      valueKey: 'qcA',
      channel: 'lightness', // default
      perGroupDomain: true, // default
    })
    // the resolved series carries the same colorBy
    expect(plan.series[0].colorBy?.mode).toBe('blend')
  })

  it('honors an explicit alpha channel + shared-global domain', () => {
    const plan = parseOption(
      blendOption({
        mode: 'blend',
        categoryKey: 'group',
        valueKey: 'qcA',
        channel: 'alpha',
        perGroupDomain: false,
        alphaFloor: 0.25,
      }),
      CATALOG,
    )
    expect(plan.cells['g'].colorBy).toMatchObject({
      channel: 'alpha',
      perGroupDomain: false,
      alphaFloor: 0.25,
    })
  })

  it('accepts a value column as the blend valueKey (not just a continuous column)', () => {
    const plan = parseOption(
      blendOption({ mode: 'blend', categoryKey: 'group', valueKey: 'Feature A' }),
      CATALOG,
    )
    expect(plan.cells['g'].colorBy?.valueKey).toBe('Feature A')
  })

  it('throws when categoryKey is not a categorical column', () => {
    expect(() =>
      parseOption(blendOption({ mode: 'blend', categoryKey: 'qcA', valueKey: 'qcA' }), { demo: CATALOG }),
    ).toThrow(/categoryKey "qcA" is not a categorical column/)
  })

  it('throws when valueKey is not a value/continuous column', () => {
    expect(() =>
      parseOption(blendOption({ mode: 'blend', categoryKey: 'group', valueKey: 'group' }), { demo: CATALOG }),
    ).toThrow(/valueKey "group" is not a value\/continuous column/)
  })
})

// Audit P-LOW-3: a structurally-malformed option fails LOUD with a clear [viz] message.
// A `colorBy` that names nothing to colour BY must fail at parse, not paint a default and look fine.
//
// `VizColorBy` requires `{ mode, key }`, but a DECLARATIVE option is untyped JSON, so a view can
// write `colorBy: "$state.groupBy"` and hand a bare string through. That used to resolve to
// `{ colormap:'viridis', scale:'linear', hidden:Set{} }` — no mode, no key — which every consumer
// reads as "colour by nothing". The shipped cell-filter embedding panes were in exactly that state:
// choosing a group-by coloured them by NOTHING, silently, and the control looked like it worked.
describe('parseOption — colorBy shape guard', () => {
  beforeAll(() => {
    installBuiltins()
  })
  const withColorBy = (colorBy: unknown): VizOption => ({
    dataset: { id: 'demo' },
    grid: [{ id: 'g', region: { col: 0 } }],
    series: [{ id: 's', type: 'scatter', coordId: 'g', encode: { layout: 'primary', colorBy } as never }],
  })

  it('REFUSES a bare column name (the shape a declarative view is most likely to write)', () => {
    expect(() => parseOption(withColorBy('group'), CATALOG)).toThrow(
      /colorBy must be an object.*not string/,
    )
  })

  it('REFUSES a mode-less or key-less object', () => {
    expect(() => parseOption(withColorBy({ key: 'group' }), CATALOG)).toThrow(/needs a mode and a non-empty key/)
    expect(() => parseOption(withColorBy({ mode: 'categorical' }), CATALOG)).toThrow(/needs a mode and a non-empty key/)
    expect(() => parseOption(withColorBy({ mode: 'categorical', key: '' }), CATALOG)).toThrow(
      /needs a mode and a non-empty key/,
    )
  })

  it('still accepts a well-formed single-channel colorBy, and an ABSENT one (the controls)', () => {
    expect(parseOption(withColorBy({ mode: 'categorical', key: 'group' }), CATALOG).cells['g'].colorBy?.key).toBe(
      'group',
    )
    expect(parseOption(withColorBy(undefined), CATALOG).cells['g'].colorBy).toBeUndefined()
  })
})

describe('parseOption — top-level shape guard', () => {
  const cat = { layouts: [{ id: 'primary' }], continuousColumns: [], valueColumns: [], categoricalColumns: [] } as never
  it('throws a clear [viz] error on a missing dataset / grid / series (not a bare TypeError)', () => {
    expect(() => parseOption(null as never, cat)).toThrow(/\[viz\] option must be an object/)
    expect(() => parseOption({ grid: [], series: [] } as never, cat)).toThrow(/option\.datasets \(or option\.dataset\)/)
    expect(() => parseOption({ dataset: { id: 'd' }, series: [] } as never, cat)).toThrow(/\[viz\] option\.grid must be an array/)
    expect(() => parseOption({ dataset: { id: 'd' }, grid: [] } as never, cat)).toThrow(/\[viz\] option\.series must be an array/)
  })
})

// MULTI-DATASOURCE (ITEM-1..5 / TEST-1..5): the new parse logic — normalize, per-series dataset +
// per-dataset catalog validation, isMultiDataset-only stamping, unknown-id throw, single-catalog compat.
describe('parseOption — multi-datasource', () => {
  const catAx = { layouts: [{ id: 'primary' }], continuousColumns: [], valueColumns: [], categoricalColumns: [{ id: 'ga', label: 'ga', categories: ['x'] }] } as never
  const catBx = { layouts: [{ id: 'primary' }], continuousColumns: [{ id: 'cb', label: 'cb' }], valueColumns: [], categoricalColumns: [{ id: 'gb', label: 'gb', categories: ['y'] }] } as never
  const twoDs = {
    datasets: [{ id: 'A' }, { id: 'B' }],
    grid: [{ id: 'p1', region: { col: 0 } }, { id: 'p2', region: { col: 1 } }],
    series: [
      { id: 's1', type: 'scatter', coordId: 'p1', datasetId: 'A', encode: { layout: 'primary' } },
      { id: 's2', type: 'scatter', coordId: 'p2', datasetId: 'B', encode: { layout: 'primary' } },
    ],
  } as VizOption

  it('normalizeDatasets merges dataset + datasets and de-dups by id (first wins)', () => {
    expect(normalizeDatasets({ dataset: { id: 'A' }, datasets: [{ id: 'B' }, { id: 'A' }] } as never).map(d => d.id)).toEqual(['A', 'B'])
    expect(normalizeDatasets({ dataset: { id: 'only' } } as never).map(d => d.id)).toEqual(['only'])
  })

  it('resolves datasetIds in order, sets ResolvedSeries.datasetId, stamps cell.datasetId (≥2 datasets)', () => {
    const plan = parseOption(twoDs, { A: catAx, B: catBx })
    expect(plan.datasetIds).toEqual(['A', 'B'])
    expect(plan.datasetId).toBe('A')
    expect(plan.series.map((s: { datasetId: string }) => s.datasetId)).toEqual(['A', 'B'])
    expect(plan.cells.p1.datasetId).toBe('A')
    expect(plan.cells.p2.datasetId).toBe('B')
  })

  it('a SINGLE dataset the series does NOT name leaves cell.datasetId unstamped (byte-identical)', () => {
    const one = { dataset: { id: 'A' }, grid: [{ id: 'p1', region: { col: 0 } }], series: [{ id: 's1', type: 'scatter', coordId: 'p1', encode: { layout: 'primary' } }] } as never
    const plan = parseOption(one, catAx)
    expect(plan.cells.p1.datasetId).toBeUndefined()
    expect(plan.datasetIds).toEqual(['A'])
  })

  // ── a NAMED dataset is stamped however many are declared ────────────────────────────────────
  //
  // The stamp used to be gated on `isMultiDataset` alone, which conflated TWO different questions:
  // "how many datasets does this option declare" and "did the author name one for this series".
  // A cell with no `datasetId` reads the WORKSPACE source at render (`GridPaneLayer`:
  // `cellEntry?.source ?? source`), while `parseOption` resolves and validates that same cell's
  // bindings against the DECLARED dataset's catalog. With ≥2 datasets those are the same source, so
  // the gap never showed; with exactly ONE they diverge the moment the host's workspace source is
  // not the option's dataset — which is exactly the declarative-canvas mount, where the workspace
  // source is the whole project's data plane and the option's dataset resolves through a
  // `DatasetResolver`. The bindings then named a column of dataset A and were read from source B,
  // and every such cell failed to load with a message about a key that was correct for the dataset
  // it was resolved against. A processor declaring TWO canvas datasets worked; declaring ONE did not.
  it('a SINGLE dataset the series NAMES is stamped, so the cell reads THAT dataset not the workspace', () => {
    const named = {
      datasets: [{ id: 'obs' }],
      grid: [{ id: 'qc-0', region: { col: 0 } }],
      series: [{ id: 's1', type: 'scatter', coordId: 'qc-0', datasetId: 'obs', encode: { layout: 'primary' } }],
    } as never
    const plan = parseOption(named, catAx)
    expect(plan.datasetIds).toEqual(['obs'])
    expect(plan.series.map((s: { datasetId: string }) => s.datasetId)).toEqual(['obs'])
    expect(
      plan.cells['qc-0'].datasetId,
      'the series named its dataset — the cell must carry it, or it renders against the workspace source',
    ).toBe('obs')
  })

  it('throws on a series datasetId that names no declared dataset', () => {
    const bad = { ...twoDs, series: [{ id: 's1', type: 'scatter', coordId: 'p1', datasetId: 'A' }, { id: 's2', type: 'scatter', coordId: 'p2', datasetId: 'ZZZ' }] } as never
    expect(() => parseOption(bad, { A: catAx, B: catBx })).toThrow(/unknown datasetId "ZZZ"/)
  })

  it('validates each series against ITS dataset catalog (a B-column binding is invalid against A)', () => {
    const okForB = { datasets: [{ id: 'A' }, { id: 'B' }], grid: [{ id: 'p2', region: { col: 0 } }], series: [{ id: 's2', type: 'scatter', coordId: 'p2', datasetId: 'B', encode: { colorBy: { mode: 'blend', categoryKey: 'gb', valueKey: 'cb' } } }] } as VizOption
    expect(() => parseOption(okForB, { A: catAx, B: catBx })).not.toThrow()
    const badForA = { ...okForB, series: [{ id: 's2', type: 'scatter', coordId: 'p2', datasetId: 'A', encode: { colorBy: { mode: 'blend', categoryKey: 'gb', valueKey: 'cb' } } }] } as never
    expect(() => parseOption(badForA, { A: catAx, B: catBx })).toThrow()
  })

  it('a bare single catalog applies to every dataset (back-compat catalog | map arg)', () => {
    // catBx has the 'primary' layout, so the single-catalog form parses the 2-dataset option fine.
    expect(() => parseOption(twoDs, catBx)).not.toThrow()
  })
})

// ── viz-followups Area B — ITEM-4/6: capability flags are stamped onto the CELL ─────────────────
// TEST-4: `parseOption` threads the resolved coordination capabilities (consumesSelection /
// producesSelection / dataZoomAxes / linkableColorScale) onto each `GridCell` (not just the
// resolved series), INCLUDING the descriptor default when the series does not override; and the
// ITEM-6 `linkableColorScale:false` gate refuses to link such a series.
describe('parseOption stamps the ENFORCED capability flags onto the cell (Area B, TEST-4)', () => {
  beforeAll(() => {
    installBuiltins()
  })

  // A dataset supporting scatter (layout) + the group/value charts.
  const CAT: DatasetCatalog = {
    datasetId: 'demo',
    pointCount: 100,
    layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
    valueColumns: ['Feature A', 'Feature B'],
    categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
    continuousColumns: [{ id: 'qcA', kind: 'continuous', label: 'QC A' }],
    hasImage: false,
  }

  it('carries the DESCRIPTOR DEFAULT capability onto the cell when the series does not override', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'p-scatter', region: { col: 0 } },
        { id: 'p-violin', region: { col: 1 } },
      ],
      series: [
        { id: 's1', type: 'scatter', coordId: 'p-scatter', encode: { layout: 'primary' } },
        { id: 's2', type: 'violin', coordId: 'p-violin' },
      ],
    }
    const plan = parseOption(opt, CAT)
    // scatter descriptor: consumes+produces true, dataZoomAxes ['x','y'], linkableColorScale true.
    expect(plan.cells['p-scatter'].consumesSelection).toBe(true)
    expect(plan.cells['p-scatter'].producesSelection).toBe(true)
    expect(plan.cells['p-scatter'].dataZoomAxes).toEqual(['x', 'y'])
    expect(plan.cells['p-scatter'].linkableColorScale).toBe(true)
    // violin descriptor: consumes+produces true, dataZoomAxes ['y'] (value axis only).
    expect(plan.cells['p-violin'].consumesSelection).toBe(true)
    expect(plan.cells['p-violin'].producesSelection).toBe(true)
    expect(plan.cells['p-violin'].dataZoomAxes).toEqual(['y'])
    // The resolved SERIES mirrors the cell (descriptor-default when unset).
    const violin = plan.series.find(s => s.id === 's2')!
    expect(violin.consumesSelection).toBe(true)
    expect(violin.producesSelection).toBe(true)
  })

  it('an EXPLICIT series override lands on the cell (consumesSelection / producesSelection false)', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'p', region: { col: 0 } }],
      series: [
        {
          id: 's1',
          type: 'violin',
          coordId: 'p',
          emphasis: { consumesSelection: false },
          select: { produces: false },
        },
      ],
    }
    const plan = parseOption(opt, CAT)
    expect(plan.cells['p'].consumesSelection).toBe(false)
    expect(plan.cells['p'].producesSelection).toBe(false)
    // …and the resolved series too.
    expect(plan.series[0].consumesSelection).toBe(false)
    expect(plan.series[0].producesSelection).toBe(false)
  })

  it('a chart with NO declared consume/produce capability leaves those cell fields undefined', () => {
    // histogram declares only dataZoomAxes: [] — no consumes/produces cap.
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'p', region: { col: 0 } }],
      series: [{ id: 's1', type: 'histogram', coordId: 'p', encode: { continuousKey: 'qcA' } }],
    }
    const plan = parseOption(opt, CAT)
    expect(plan.cells['p'].consumesSelection).toBeUndefined()
    expect(plan.cells['p'].producesSelection).toBeUndefined()
    expect(plan.cells['p'].dataZoomAxes).toEqual([]) // histogram declares [] (no zoom axes)
  })

  it('ITEM-3: a series declaring `annotate:true` stamps `annotate:true` onto the image cell; a series without it leaves the field undefined', () => {
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [
        { id: 'p-anno', region: { col: 0 } },
        { id: 'p-plain', region: { col: 1 } },
      ],
      series: [
        { id: 's-anno', type: 'image', coordId: 'p-anno', annotate: true },
        { id: 's-plain', type: 'image', coordId: 'p-plain' },
      ],
    }
    const plan = parseOption(opt, CAT)
    // Opt-in cell gets the flag stamped…
    expect(plan.cells['p-anno'].annotate).toBe(true)
    // …and a series without it stays field-free (byte-identical to pre-ITEM-3).
    expect(plan.cells['p-plain'].annotate).toBeUndefined()
  })

  it('ITEM-6: a `linkableColorScale:false` descriptor is NOT linked even when colorScale.link names it', () => {
    // Register a one-off chart type that opts OUT of the shared color domain.
    if (!getChartType('noLinkChart')) {
      const desc: ChartTypeDescriptor = {
        type: 'noLinkChart',
        coordinateSystem: 'chart2d',
        view: (() => null) as unknown as ChartTypeDescriptor['view'],
        bindingSchema: [{ id: 'group', source: 'categorical', label: 'Group' }],
        capabilities: { linkableColorScale: false },
        model: (c: GridCell) => ({ kind: c.kind, bindings: {}, resolutions: {}, cell: c }),
      }
      registerChartType(desc)
    }
    const opt: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'p', region: { col: 0 } }],
      colorScale: { link: ['s1'] },
      series: [{ id: 's1', type: 'noLinkChart', coordId: 'p', encode: { groupKey: 'group' } }],
    }
    const plan = parseOption(opt, CAT)
    // The gate refuses the link: neither the cell nor the resolved series is linked.
    expect(plan.cells['p'].linkColorScale).toBeUndefined()
    expect(plan.series[0].linkColorScale).toBe(false)
    // …and the descriptor's opt-out is carried onto the cell for the render path.
    expect(plan.cells['p'].linkableColorScale).toBe(false)
  })
})

// TEST-1 [covers: ITEM-1] — the `controls` capability field resolves onto ResolvedOption with the
// per-control defaults filled in, and an explicit control overrides them.
describe('plot-editing: controls capability resolution (ITEM-1)', () => {
  beforeAll(() => {
    if (!getChartType('scatter')) installBuiltins()
  })

  const base = (controls?: VizOption['controls']): VizOption => ({
    dataset: { id: 'demo' },
    grid: [{ id: 'g', region: {} }],
    series: [{ id: 's', type: 'scatter', coordId: 'g' }],
    ...(controls ? { controls } : {}),
  })

  it('absent controls → ResolvedOption.controls carries the byte-identical per-control defaults (DEC-4)', () => {
    const plan = parseOption(base(), { demo: CATALOG })
    // Always present + fully resolved; net-new chrome opt-in (FIND-1/2/3 fix).
    expect(plan.controls).toEqual({
      legend: { show: true, editable: false },
      colormap: { show: false, editable: false },
      titles: { show: true, editable: false },
      pointSize: { show: false, editable: false },
    })
  })

  it('an explicit control overrides only the flags it names; the rest keep defaults', () => {
    const plan = parseOption(
      base({ legend: { editable: true }, colormap: { show: true } }),
      { demo: CATALOG },
    )
    expect(plan.controls.legend).toEqual({ show: true, editable: true }) // show keeps default
    expect(plan.controls.colormap).toEqual({ show: true, editable: false }) // editable keeps default
    expect(plan.controls.titles).toEqual({ show: true, editable: false }) // untouched → default
    expect(plan.controls.pointSize).toEqual({ show: false, editable: false })
  })
})

// TEST-4 (segmentation-scale ITEM-3): the declarative `segment` opt-in — the exact twin of the
// shipped `annotate` stamp. A series with `segment: true` resolves to a `GridCell` with the flag;
// a series without it leaves the cell field-free (byte-identical); `migrateOption` round-trips it.
describe('parseOption / migrateOption — segment stamp (TEST-4)', () => {
  beforeAll(() => installBuiltins())

  const withSegment = (segment?: boolean): VizOption => ({
    dataset: { id: 'demo' },
    grid: [{ id: 'g0', region: { col: 0 } }],
    series: [
      {
        id: 's0',
        type: 'scatter',
        coordId: 'g0',
        encode: { layout: 'primary' },
        ...(segment === undefined ? {} : { segment }),
      },
    ],
  })

  it('stamps `segment: true` onto the resolved cell when the series opts in', () => {
    const plan = parseOption(withSegment(true), { demo: CATALOG })
    expect(plan.cells['g0'].segment).toBe(true)
  })

  it('leaves the cell field-free (undefined) when the series omits segment or sets it false', () => {
    expect(parseOption(withSegment(undefined), { demo: CATALOG }).cells['g0'].segment).toBeUndefined()
    expect(parseOption(withSegment(false), { demo: CATALOG }).cells['g0'].segment).toBeUndefined()
  })

  it('round-trips the flag through migrateOption (a saved session-state with a segment cell)', () => {
    const session = {
      grid: { cells: { g0: { kind: 'image', layoutId: 'primary', segment: true } } },
      interaction: {},
    }
    const opt = migrateOption(session)
    const s0 = opt.series.find(s => (s as { coordId?: string }).coordId === 'g0') as { segment?: boolean }
    expect(s0.segment).toBe(true)
    // a cell WITHOUT segment stays field-free (no spurious `segment: false`).
    const flat = migrateOption({ grid: { cells: { g1: { kind: 'image', layoutId: 'primary' } } }, interaction: {} })
    const s1 = flat.series.find(s => (s as { coordId?: string }).coordId === 'g1') as { segment?: boolean }
    expect(s1.segment).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Selection provenance (ITEM-3) — parse + validate.
//
// TEST-7  : each malformed op is rejected with its OWN `[viz] …` message, so a blanket throw
//           cannot satisfy all of them.
// TEST-12 : INV-5 — a pre-provenance option still parses and resolves provenance-free.
// TEST-19 : strict-JSON discipline — a `Set` handed into `context.hidden` is normalized to a
//           sorted `number[]`, never passed through.
// ---------------------------------------------------------------------------

const withOps = (ops: unknown[], context?: unknown): VizOption =>
  ({
    ...OPTION,
    selection: { mode: 'lasso', link: [], ops, ...(context ? { context } : {}) },
  }) as unknown as VizOption

describe('TEST-7 (ITEM-3) — malformed selection ops are rejected at the boundary', () => {
  beforeAll(() => installBuiltins())

  it('rejects an unknown tool', () => {
    expect(() => parseOption(withOps([{ tool: 'blob', op: 'add', pane: 'g-left', space: 'd', region: [] }]), { demo: CATALOG }))
      .toThrow(/\[viz\] option\.selection\.ops\[0\] has unknown tool "blob"/)
  })

  it('rejects an unknown combine op', () => {
    expect(() => parseOption(withOps([{ tool: 'rect', op: 'xor', pane: 'g-left', space: 'd', region: [0, 0, 1, 1] }]), { demo: CATALOG }))
      .toThrow(/has unknown combine op "xor"/)
  })

  it('rejects a rect whose region is not 4 numbers', () => {
    expect(() => parseOption(withOps([{ tool: 'rect', op: 'add', pane: 'g-left', space: 'd', region: [0, 0, 1] }]), { demo: CATALOG }))
      .toThrow(/is a rect whose region is not 4 numbers/)
  })

  it('rejects a polygon ring with fewer than 3 vertices', () => {
    expect(() => parseOption(withOps([{ tool: 'polygon', op: 'add', pane: 'g-left', space: 'd', region: [[0, 0], [1, 1]] }]), { demo: CATALOG }))
      .toThrow(/is a polygon with fewer than 3 vertices/)
  })

  it('rejects an op naming an unknown pane', () => {
    expect(() => parseOption(withOps([{ tool: 'rect', op: 'add', pane: 'nope', space: 'd', region: [0, 0, 1, 1] }]), { demo: CATALOG }))
      .toThrow(/names unknown pane "nope"/)
  })

  it('does NOT throw for the valid shapes (incl. a programmatic pane:null ids op)', () => {
    const valid = [
      { tool: 'rect', op: 'add', pane: 'g-left', space: 'd', region: [0, 0, 1, 1] },
      { tool: 'polygon', op: 'subtract', pane: 'g-left', space: 'd', region: [[0, 0], [1, 0], [1, 1]] },
      { tool: 'ids', op: 'intersect', pane: 'g-right', space: 'd', region: [1, 2, 3] },
      { tool: 'ids', op: 'add', pane: null, space: 'd', region: [9] },
    ]
    const plan = parseOption(withOps(valid), { demo: CATALOG })
    expect(plan.selection?.ops).toHaveLength(4)
    expect(plan.selection?.ops?.[1].op).toBe('subtract')
  })
})

describe('TEST-12 (INV-5) — a pre-provenance option is untouched', () => {
  beforeAll(() => installBuiltins())

  it('parses with NO ops/context/provenance and resolves them undefined', () => {
    const plan = parseOption(
      { ...OPTION, selection: { mode: 'lasso', link: [], ids: [1, 2, 3] } },
      { demo: CATALOG },
    )
    expect(plan.selection?.ids).toEqual([1, 2, 3])
    expect(plan.selection?.ops).toBeUndefined()
    expect(plan.selection?.context).toBeUndefined()
    expect(plan.selection?.provenance).toBeUndefined()
    // the version does not move for an additive optional field (DEC-6)
    expect(plan.version).toBe(1)
  })

  it('NEGATIVE CONTROL: the same fixture WITH ops resolves them non-undefined', () => {
    const plan = parseOption(
      withOps([{ tool: 'rect', op: 'add', pane: 'g-left', space: 'd', region: [0, 0, 1, 1] }]),
      { demo: CATALOG },
    )
    expect(plan.selection?.ops).toBeDefined()
  })

  it('migrateOption over a legacy VizSessionState blob yields a provenance-free selection', () => {
    // The `grid` + `interaction` arm (parse.ts:1185) — a v1 session snapshot predating provenance.
    const migrated = migrateOption({
      grid: { order: [], cells: {} },
      interaction: { selection: { ids: [4, 5] } },
    })
    expect((migrated.selection as { ops?: unknown } | undefined)?.ops).toBeUndefined()
    expect((migrated.selection as { context?: unknown } | undefined)?.context).toBeUndefined()
  })
})

describe('TEST-19 (ITEM-1) — the provenance block is strict JSON', () => {
  beforeAll(() => installBuiltins())

  it('normalizes a Set in context.hidden to a SORTED number[] rather than passing it through', () => {
    const plan = parseOption(
      withOps(
        [{ tool: 'rect', op: 'add', pane: 'g-left', space: 'd', region: [0, 0, 1, 1] }],
        { hidden: { 'g-left': new Set([5, 1, 3]) }, filters: { 'g-left': [0, 10] }, panes: { 'g-left': 'abc' } },
      ),
      { demo: CATALOG },
    )
    expect(plan.selection?.context?.hidden?.['g-left']).toEqual([1, 3, 5])
    expect(Array.isArray(plan.selection?.context?.hidden?.['g-left'])).toBe(true)
  })

  it('survives a JSON string round-trip with no loss (no Set / typed array reaches the wire)', () => {
    const plan = parseOption(
      withOps(
        [
          { tool: 'rect', op: 'add', pane: 'g-left', space: 'd', region: [0, 0, 1, 1] },
          { tool: 'polygon', op: 'subtract', pane: 'g-left', space: 'd', region: [[0, 0], [1, 0], [1, 1]] },
        ],
        { hidden: { 'g-left': [2] } },
      ),
      { demo: CATALOG },
    )
    const sel = plan.selection!
    expect(JSON.parse(JSON.stringify(sel))).toEqual(sel)
  })
})

// ---------------------------------------------------------------------------
// TEST-9 — the catalog-default validation exemption, and what it was protecting.
//
// `validateBindings` used to check only ENCODE-EXPLICIT bindings, and said why: a
// catalog-DEFAULT binding could resolve to a conventional NAME (`'group'`/`'qcA'`) the
// dataset did not have, "and that fallback name is expected to be absent". The exemption
// existed to keep the validator from catching the guess.
//
// The guess is gone, so the exemption is gone. That is only safe if the thing it protected
// is genuinely no longer reachable — a silent guess turned into a hard parse crash on a
// shipped chart would be a WORSE defect than the one being fixed. Both halves are pinned
// here, because the risk lives between them: (a) an undecidable catalog must still PARSE,
// and (b) an explicit encode naming a nonexistent column must still THROW.
// ---------------------------------------------------------------------------

describe('TEST-9 — parse-time validation after the catalog-default exemption was removed', () => {
  const EMPTY: DatasetCatalog = {
    datasetId: 'empty',
    pointCount: 0,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
  }
  const AMBIGUOUS: DatasetCatalog = {
    datasetId: 'amb',
    pointCount: 10,
    layouts: [{ id: 'primary', kind: 'layout', label: 'P' }],
    valueColumns: ['a', 'b', 'c'],
    categoricalColumns: [
      { id: 'x', kind: 'categorical', label: 'X' },
      { id: 'y', kind: 'categorical', label: 'Y' },
    ],
    continuousColumns: [
      { id: 'm', kind: 'continuous', label: 'M' },
      { id: 'n', kind: 'continuous', label: 'N' },
    ],
    hasImage: false,
  }

  /** Every registered chart type, one series each — the "shipped chart" population. */
  function optionForEveryKind(): VizOption {
    const kinds = ['violin', 'box', 'bar', 'histogram', 'dotplot', 'heatmap', 'volcano']
    return {
      dataset: { id: 'd' },
      grid: kinds.map((k, i) => ({ id: `g-${i}`, region: { col: i } })),
      series: kinds.map((k, i) => ({ id: `s-${k}`, type: k, coordId: `g-${i}` })),
    }
  }

  it('(a) every built-in chart type PARSES against an EMPTY catalog — no throw', () => {
    // This is the leg the exemption was buying. It must survive its removal.
    expect(() => parseOption(optionForEveryKind(), { d: EMPTY })).not.toThrow()
  })

  it('(a) …and against an AMBIGUOUS catalog, where every channel refuses', () => {
    expect(() => parseOption(optionForEveryKind(), { d: AMBIGUOUS })).not.toThrow()
  })

  it('(b) an ENCODE-EXPLICIT binding naming a nonexistent column still THROWS', () => {
    const bad: VizOption = {
      dataset: { id: 'd' },
      grid: [{ id: 'g', region: { col: 0 } }],
      series: [{ id: 's', type: 'violin', coordId: 'g', encode: { valueKey: 'no_such_column' } }],
    }
    expect(() => parseOption(bad, { d: AMBIGUOUS })).toThrow(/no_such_column/)
  })

  it('(b) …and one naming a column of the WRONG KIND still throws', () => {
    const wrongKind: VizOption = {
      dataset: { id: 'd' },
      grid: [{ id: 'g', region: { col: 0 } }],
      // `a` is a VALUE column, bound to the categorical grouping channel.
      series: [{ id: 's', type: 'violin', coordId: 'g', encode: { groupKey: 'a' } }],
    }
    expect(() => parseOption(wrongKind, { d: AMBIGUOUS })).toThrow(/categorical/)
  })

  it('a catalog-DEFAULT binding that DID resolve is validated too, and passes', () => {
    // The removal made validation strictly WIDER, not narrower: a catalog-resolved binding is
    // now checked like any other. It passes by construction (the resolver only names columns
    // the catalog carries) — which is exactly why the narrower skip would have been vacuous.
    const sole: DatasetCatalog = { ...AMBIGUOUS, valueColumns: ['only'], categoricalColumns: [{ id: 'g1', kind: 'categorical', label: 'G' }] }
    const plan = parseOption(
      { dataset: { id: 'd' }, grid: [{ id: 'g', region: { col: 0 } }], series: [{ id: 's', type: 'violin', coordId: 'g' }] },
      { d: sole },
    )
    expect(plan.series[0].model.bindings.value).toBe('only')
    expect(plan.series[0].model.bindings.group).toBe('g1')
  })
})
