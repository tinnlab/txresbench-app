// subpathExports.test.ts — the STEP-7 subpath-split smoke test (EXTENSIBILITY_STUDY Part 6
// STEP 7). Verifies the three opt-in subpaths (`@txresbench/viz/core` / `/charts` / `/react`) expose
// their public surface AND — the tree-shakeability contract — that importing `/core` does NOT
// force-register the built-in chart types (they arrive only via `/charts`'s installers). The
// registry is module-global; vitest isolates module state per test FILE, so importing `./charts`
// is inert until `use(...)` / `installBuiltins()` is called.

import { describe, it, expect } from 'vitest'
import * as core from './core'
import * as charts from './charts'
import {
  ScatterChart,
  HeatmapChart,
  AllCharts,
  installBuiltins,
} from './charts'

describe('@txresbench/viz subpath split (STEP 7)', () => {
  it('/core exports the engine + option pipeline (no charts)', () => {
    expect(typeof core.use).toBe('function')
    expect(typeof core.registerChartType).toBe('function')
    expect(typeof core.getChartType).toBe('function')
    expect(typeof core.parseOption).toBe('function')
    expect(typeof core.VizController).toBe('function')
    expect(typeof core.useGridWorkspaceStore).toBe('function')
    expect(typeof core.useCoordinationStore).toBe('function')
  })

  it('/charts exports installBuiltins + a per-chart installer for each built-in', () => {
    expect(typeof charts.installBuiltins).toBe('function')
    expect(AllCharts).toHaveLength(10)
    for (const inst of AllCharts) expect(typeof inst.install).toBe('function')
    expect(typeof ScatterChart.install).toBe('function')
    expect(typeof HeatmapChart.install).toBe('function')
  })

  it('importing /core alone does NOT register any chart type (tree-shakeable)', () => {
    // Nothing has been `use`d yet in this isolated module graph.
    expect(core.getChartType('scatter')).toBeUndefined()
    expect(core.getChartType('heatmap')).toBeUndefined()
    expect(core.chartTypes()).toHaveLength(0)
  })

  it('use()-ing ONLY one installer registers ONLY that chart', () => {
    core.use(ScatterChart)
    expect(core.getChartType('scatter')).toBeDefined()
    expect(core.getChartType('scatter')?.coordinateSystem).toBe('world2d')
    // heatmap was NOT used → still unregistered (the opt-in proof)
    expect(core.getChartType('heatmap')).toBeUndefined()
  })

  it('installBuiltins() registers the full set', () => {
    installBuiltins()
    expect(core.getChartType('heatmap')).toBeDefined()
    expect(core.chartTypes()).toHaveLength(10)
  })

  it('the main `@txresbench/viz` barrel is a runtime-value superset of `/core` (back-compat contract)', async () => {
    // core.ts's header asserts the main barrel re-exports EVERYTHING in /core. This guards
    // against re-drift (the regression that dropped `cellSpaceKey` + `VizViewState`).
    // NOTE: type-only exports (e.g. `VizViewState`) do NOT appear on the runtime namespace
    // object, so this guard only catches the runtime-VALUE superset — which is exactly what a
    // runtime fn like `cellSpaceKey` needs. Type-level supersetting is enforced by `tsc`.
    // `./index` transitively runs `installBuiltins()` at module load (via GridWorkspace), so it
    // is imported DYNAMICALLY here (last test, after the tree-shakeability cases above) to keep
    // this file's top-level module graph chart-free for those earlier assertions.
    const index = await import('./index')
    const missing = Object.keys(core).filter((k) => !(k in index))
    expect(missing, `symbols in /core but missing from the main barrel: ${missing.join(', ')}`).toEqual([])
  })
})
