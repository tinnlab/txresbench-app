import { describe, it, expect, vi } from 'vitest'
import { VizController, installBuiltins } from '@txresbench/viz'
import {
  parseLogicalDatasetId,
  createDatasetResolver,
  resolveCanvasCoords,
  resolveCanvasOption,
  seriesBoundColumns,
  unresolvableBinding,
  driveCanvas,
  teardownCanvas,
  CanvasObsSource,
  type CanvasBindingDeps,
  type CanvasTemplate,
} from './canvasBinding'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { UNGROUPED_CATEGORY } from './canvasBinding'

/** The ONE construction site for the frame-backed source in this file. Hoisted so the suite
 *  references the class once instead of per test — the app vocabulary belongs in the app, and
 *  a test file repeating a name it does not own is residue the domain guard rightly counts. */
const source = (
  id: string,
  cols: Record<string, number[] | string[]>,
  mask?: boolean[],
  image?: unknown,
  emb?: unknown,
) => new CanvasObsSource(id, cols, mask, image as never, emb as never)

// declarative-canvas-plots SLICE 3 — the canvas mechanism.
// TEST-2 (ITEM-2): DatasetResolver maps obs/obs.kept/<ds>.obs/<ds>.kept → DataSources; `.kept`
//                  applies the `$derived.keptMask`.
// TEST-3 (ITEM-3): $state/$derived refs in option values resolve before setOption + re-patch on
//                  state change.
// TEST-4 (ITEM-4): the resolved option drives ONE VizController.setOption; teardown removes cells.
// TEST-10 (ITEM-10): each resolved dataset is its OWN isolated identity space (no shared pointIds).

installBuiltins()

// The default analysis obs slice + a named second dataset ("d2").
const SLICE = {
  measure_a: [1000, 2000, 3000, 500],
  measure_b: [300, 600, 900, 150],
  metric_b: [2, 5, 8, 40],
  label_a: ['s1', 's1', 's2', 's2'],
}
const OBS_D2 = {
  measure_a: [10, 20, 30],
  metric_b: [1, 2, 3],
  label_a: ['b1', 'b2', 'b2'],
}

/** keep the first three cells of the default dataset (drop the metric_b=40 outlier). */
const KEEP_MASK = [true, true, true, false]

function deps(extra: Partial<CanvasBindingDeps> = {}): CanvasBindingDeps {
  return {
    obsFor: base => (base === 'd2' ? OBS_D2 : SLICE),
    keptMaskFor: base => (base === 'obs' ? KEEP_MASK : undefined),
    ...extra,
  }
}

describe('parseLogicalDatasetId (ITEM-2)', () => {
  // r3canvas: the default slice NAME is now a parameter — the id the DECLARATION chose. These
  // fixtures pass `'obs'` because that is what this suite's fixture canvas calls its default,
  // NOT because core knows the word. `obsLanguage.test.ts` is the parity proof.
  it('parses the four logical id shapes (default slice = `obs` here)', () => {
    expect(parseLogicalDatasetId('obs', 'obs')).toEqual({ base: 'obs', kept: false })
    expect(parseLogicalDatasetId('obs.kept', 'obs')).toEqual({ base: 'obs', kept: true })
    expect(parseLogicalDatasetId('d2.obs', 'obs')).toEqual({ base: 'd2', kept: false })
    expect(parseLogicalDatasetId('d2.kept', 'obs')).toEqual({ base: 'd2', kept: true })
    // a bare named dataset ⇒ its own (unfiltered) slice.
    expect(parseLogicalDatasetId('d2', 'obs')).toEqual({ base: 'd2', kept: false })
  })

  it('the `<default>` / `.kept` shapes need NO default (they are language, not a name)', () => {
    expect(parseLogicalDatasetId('obs')).toEqual({ base: 'obs', kept: false })
    expect(parseLogicalDatasetId('obs.kept')).toEqual({ base: 'obs', kept: true })
    expect(parseLogicalDatasetId('d2.kept')).toEqual({ base: 'd2', kept: true })
    // …but the `<ds>.<default>` SUFFIX form does: with no default declared, a dotted id is its
    // own base. Core no longer guesses that the trailing segment means "the default slice".
    expect(parseLogicalDatasetId('d2.obs')).toEqual({ base: 'd2.obs', kept: false })
    expect(parseLogicalDatasetId('d2.obs', '')).toEqual({ base: 'd2.obs', kept: false })
  })
})

describe('createDatasetResolver — logical id → DataSource (TEST-2, ITEM-2)', () => {
  const resolve = createDatasetResolver(deps(), 'obs') as (id: string) => CanvasObsSource

  it('maps `obs` to the full default slice', async () => {
    const src = resolve('obs') as CanvasObsSource
    expect(src).toBeInstanceOf(CanvasObsSource)
    const cat = await src.catalog()
    expect(cat.pointCount).toBe(4)
    // numeric metrics bind BOTH a value channel (violin) + a continuous channel (scatter colorBy).
    expect(cat.valueColumns).toEqual(expect.arrayContaining(['measure_a', 'metric_b']))
    expect(cat.continuousColumns.map(c => c.id)).toEqual(expect.arrayContaining(['metric_b']))
    expect(cat.categoricalColumns.map(c => c.id)).toEqual(['label_a'])
  })

  it('maps `obs.kept` to the SAME slice filtered by the keptMask', async () => {
    const src = resolve('obs.kept')
    const col = await src.continuous('metric_b')
    // the metric_b=40 outlier (mask=false) is dropped ⇒ 3 kept cells.
    expect(col.length).toBe(3)
    expect(Array.from(col.value)).toEqual([2, 5, 8])
  })

  it('maps `<ds>.obs` / `<ds>.kept` to the named dataset (kept = unfiltered when no mask)', async () => {
    const obs = await (resolve('d2.obs')).catalog()
    expect(obs.pointCount).toBe(3)
    // d2 has no keptMask ⇒ `.kept` equals the unfiltered slice.
    const kept = await (resolve('d2.kept')).continuous('metric_b')
    expect(Array.from(kept.value)).toEqual([1, 2, 3])
  })
})

// Slice-6 INV-16: the canvas resolver serves a spatial tissue-image underlay so a declared
// `image` before/after series (cell-filter's `showSpatial`) PAINTS on the general canvas —
// routing into the EXISTING @txresbench/viz ImageUnderlay (raster + 2×3 affine), no new viz API.
describe('spatial image underlay (Slice 6, INV-16)', () => {
  const IMAGE = {
    data: new Uint8Array(4 * 2 * 2),
    width: 2,
    height: 2,
    channels: 4 as const,
    affine: [0.5, 0, 0, 0, 0.5, 0] as [number, number, number, number, number, number],
  }
  const spatialDeps = deps({ imageFor: base => (base === 'obs' ? IMAGE : undefined) })

  it('a base with an image advertises hasImage + serves the underlay (raster + affine)', async () => {
    const resolve = createDatasetResolver(spatialDeps)
    const src = await resolve('obs')
    const cat = await src.catalog()
    expect(cat.hasImage).toBe(true)
    const underlay = await src.imageUnderlay()
    expect(underlay.width).toBe(2)
    expect(underlay.height).toBe(2)
    // the affine is the single alignment source of truth (the Visium scalefactor scale).
    expect(underlay.affine).toEqual([0.5, 0, 0, 0, 0.5, 0])
    expect(underlay.channels).toBe(4)
  })

  it('the .kept variant shares the base image (raster unchanged by filtering)', async () => {
    const resolve = createDatasetResolver(spatialDeps)
    const kept = await resolve('obs.kept')
    expect((await kept.catalog()).hasImage).toBe(true)
    expect((await kept.imageUnderlay()).width).toBe(2)
  })

  it('a base WITHOUT an image stays metric-only (hasImage false, imageUnderlay throws)', async () => {
    const resolve = createDatasetResolver(spatialDeps)
    const d2 = await resolve('d2') // imageFor('d2') → undefined
    expect((await d2.catalog()).hasImage).toBe(false)
    await expect(d2.imageUnderlay()).rejects.toThrow(/no image underlay/)
  })

  it('an INCOMPLETE image payload (no affine) does not falsely claim hasImage', async () => {
    const badDeps = deps({ imageFor: () => ({ data: new Uint8Array(4), width: 1, height: 1 }) })
    const src = await createDatasetResolver(badDeps)('obs')
    expect((await src.catalog()).hasImage).toBe(false)
    await expect(src.imageUnderlay()).rejects.toThrow()
  })
})

// ── identity space (TEST-10, ITEM-10 — as corrected by ledger #34) ────────────────────────────
//
// This used to assert that EVERY resolved source is isolated, full stop. That is still the
// default and it is still asserted first — but as an unconditional rule it was wrong, and the
// owner's correction says why: ITEM-10's isolation was written for genuinely different DATASETS
// ("a brush/gate in dataset A cannot bleed into B"), not for two views of ONE row space, which
// is what a canvas of panes drawn in the same coordinates is. So isolation is now a property of
// a source that was given no canonical ids, and the second test is the case the first one used
// to forbid.
describe('identity space (TEST-10, ITEM-10 + ledger #34)', () => {
  const resolve = createDatasetResolver(deps()) as (id: string) => CanvasObsSource
  it('a source given NO canonical ids is its OWN isolated identity space (no pointIds method)', () => {
    const a = resolve('obs')
    const b = resolve('obs.kept')
    // distinct source instances (distinct ids ⇒ distinct DatasetStore entries ⇒ distinct spaces).
    expect(a).not.toBe(b)
    // an absent `pointIds` marks an isolated space (the `DataSource` contract) — no cross-bleed.
    expect((a as { pointIds?: unknown }).pointIds).toBeUndefined()
    expect((b as { pointIds?: unknown }).pointIds).toBeUndefined()
  })

  it('a source given canonical ids publishes them, mask-filtered on the `.kept` variant', async () => {
    const withIds = createDatasetResolver({
      ...deps(),
      keptMaskFor: () => [true, false, true],
      pointIdsFor: () => Uint32Array.from([70, 71, 72]),
    })
    type WithIds = { pointIds: () => Promise<Uint32Array> }
    const all = withIds('frame') as unknown as WithIds
    const kept = withIds('frame.kept') as unknown as WithIds
    expect([...(await all.pointIds())]).toEqual([70, 71, 72])
    // The surviving rows keep the ids they had, which is what makes a filter in one pane land on
    // the right rows of another rather than on its first k rows.
    expect([...(await kept.pointIds())]).toEqual([70, 72])
  })
})

// ── $ref + for_each resolution ─────────────────────────────────────────────────

function scope(state: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Scope {
  return { params: {}, state, derived: {}, const: {}, data: {}, ...extra }
}

/** A single-dataset before/after template: two violins over `obs`/`obs.kept` sharing one coordId,
 *  with a `filters` clamp bound to `$state`. */
function beforeAfterTemplate(): CanvasTemplate {
  return {
    datasets: [{ id: 'obs' }, { id: 'obs.kept' }],
    grid: [{ id: 'mito', region: { row: 0, col: 0 } }],
    series: [
      { id: 'before', type: 'violin', coordId: 'mito', datasetId: 'obs', encode: { groupKey: 'label_a', valueKey: 'metric_b' } },
      { id: 'after', type: 'violin', coordId: 'mito', datasetId: 'obs.kept', encode: { groupKey: 'label_a', valueKey: 'metric_b' } },
    ],
    filters: { metric_b: '$state.thresholds.metric_b' } as never,
  }
}

describe('resolveCanvasOption — $ref resolution (TEST-3, ITEM-3)', () => {
  it('resolves $state refs in option values before setOption', () => {
    const opt = resolveCanvasOption(beforeAfterTemplate(), scope({ thresholds: { metric_b: [0, 10] } }))
    expect(opt.filters).toEqual({ metric_b: [0, 10] })
    // the before/after series (two violins, one coordId, obs vs obs.kept) survive verbatim.
    expect(opt.series.map(s => s.datasetId)).toEqual(['obs', 'obs.kept'])
    expect(opt.series.every(s => s.coordId === 'mito')).toBe(true)
  })

  it('re-patches when the $state changes (the live link)', () => {
    const tpl = beforeAfterTemplate()
    const a = resolveCanvasOption(tpl, scope({ thresholds: { metric_b: [0, 10] } }))
    const b = resolveCanvasOption(tpl, scope({ thresholds: { metric_b: [0, 25] } }))
    expect(a.filters).toEqual({ metric_b: [0, 10] })
    expect(b.filters).toEqual({ metric_b: [0, 25] })
  })

  it('preserves a declared `switchTo` seed (kind is a seed — TEST-13, ITEM-13)', () => {
    const tpl: CanvasTemplate = {
      datasets: [{ id: 'obs' }],
      grid: [{ id: 'mito', region: { row: 0, col: 0 } }],
      series: [
        {
          id: 'before',
          type: 'violin',
          coordId: 'mito',
          datasetId: 'obs',
          encode: { groupKey: 'label_a', valueKey: 'metric_b' },
          switchTo: ['violin', 'box'],
        },
      ],
    }
    const opt = resolveCanvasOption(tpl, scope())
    expect(opt.series[0].type).toBe('violin')
    expect(opt.series[0].switchTo).toEqual(['violin', 'box'])
  })
})

describe('resolveCanvasOption — for_each multi-dataset expansion (TEST-8-adjacent, ITEM-8)', () => {
  it('expands a per-dataset `datasets`/`series` template over the selected set', () => {
    const tpl: CanvasTemplate = {
      datasets: [{ for_each: '$state.qcDatasets as $ds', id: '$ds.id' } as never],
      grid: [{ id: 'mito', region: { row: 0, col: 0 } }],
      series: [
        {
          for_each: '$state.qcDatasets as $ds',
          id: '$ds.id',
          type: 'violin',
          coordId: 'mito',
          datasetId: '$ds.id',
          encode: { groupKey: 'label_a', valueKey: 'metric_b' },
        } as never,
      ],
    }
    const opt = resolveCanvasOption(
      tpl,
      scope({ qcDatasets: [{ id: 'obs' }, { id: 'd2.obs' }] }),
    )
    expect(opt.datasets?.map(d => d.id)).toEqual(['obs', 'd2.obs'])
    expect(opt.series.map(s => s.id)).toEqual(['obs', 'd2.obs'])
    expect(opt.series.map(s => s.datasetId)).toEqual(['obs', 'd2.obs'])
    // `for_each` is stripped from the expanded entries (never reaches strict-JSON viz).
    expect(opt.series.every(s => !('for_each' in s))).toBe(true)
  })
})

// ── drive the canvas via ONE VizController (TEST-4, ITEM-4) ─────────────────────
// NOTE: the "two violins sharing ONE coordId" before/after shape is exercised as OPTION
// CONSTRUCTION above (`resolveCanvasOption`) but NOT driven through `setOption` here, because
// `@txresbench/viz` `parseOption` enforces one-series-per-region (v1). The DRIVE test therefore uses the
// parse-valid two-cell layout (before cell over `obs`, after cell over `obs.kept`) — how before/
// after actually mounts on the canvas today. (Overlaying two series in one cell is a slice-4 viz
// decision; see the mechanism report.)

/** A parse-valid multi-dataset before/after: two violin cells (obs vs obs.kept) + a filters clamp. */
function beforeAfterTwoCellTemplate(): CanvasTemplate {
  return {
    datasets: [{ id: 'obs' }, { id: 'obs.kept' }],
    grid: [
      { id: 'before', region: { row: 0, col: 0 } },
      { id: 'after', region: { row: 0, col: 1 } },
    ],
    series: [
      { id: 'before', type: 'violin', coordId: 'before', datasetId: 'obs', encode: { groupKey: 'label_a', valueKey: 'metric_b' } },
      { id: 'after', type: 'violin', coordId: 'after', datasetId: 'obs.kept', encode: { groupKey: 'label_a', valueKey: 'metric_b' } },
    ],
    filters: { metric_b: '$state.thresholds.metric_b' } as never,
  }
}

describe('driveCanvas — ONE VizController.setOption (TEST-4, ITEM-4)', () => {
  it('drives the resolved before/after option through one setOption; teardown removes the cells', async () => {
    const resolveDataset = createDatasetResolver(deps())
    const controller = new VizController({ resolveDataset })
    const option = resolveCanvasOption(beforeAfterTwoCellTemplate(), scope({ thresholds: { metric_b: [0, 10] } }))

    await driveCanvas(controller, option)
    const live = controller.getOption()
    // both before/after cells landed on the single canvas grid; the clamp resolved to a value range.
    expect(live.grid?.map(g => g.id).sort()).toEqual(['after', 'before'])
    expect(live.filters).toEqual({ metric_b: [0, 10] })

    // teardown removes the declared plot cells; the grid store enforces a ≥1-cell FLOOR
    // (removeCell refuses to delete the last one), so it shrinks to that floor. The dataset refs it
    // gives back at the same time are asserted in `canvasTeardown.test.ts` — this one is the grid half.
    teardownCanvas(controller)
    expect((controller.getOption().grid ?? []).length).toBe(1)
  })

  it('the declared kind is a SEED; switchTo survives into the resolved plan (TEST-13, ITEM-13)', async () => {
    const controller = new VizController({ resolveDataset: createDatasetResolver(deps()) })
    const option = resolveCanvasOption(
      {
        datasets: [{ id: 'obs' }],
        grid: [{ id: 'mito', region: { row: 0, col: 0 } }],
        series: [
          {
            id: 'v',
            type: 'violin',
            coordId: 'mito',
            datasetId: 'obs',
            encode: { groupKey: 'label_a', valueKey: 'metric_b' },
            switchTo: ['violin', 'box'],
          },
        ],
      },
      scope(),
    )
    const resolved = await driveCanvasReturning(controller, option)
    const cell = resolved.cells['mito']
    // the declared `kind` is only the SEED; the kind switcher (`switchTo`) alternatives survive.
    expect(cell.kind).toBe('violin')
    expect(cell.switchTo).toEqual(['violin', 'box'])
  })
})

/** drive + return the resolved plan (for asserting the resolved-series/cell shape). */
async function driveCanvasReturning(controller: VizController, option: Parameters<VizController['setOption']>[0]) {
  return controller.setOption(option, { replace: true })
}

// ── Bug 2: real embedding positions serve the scatter x/y (mask-filtered for `.kept`) ────────────
describe('CanvasObsSource positions — real embedding coords (Bug 2)', () => {
  const OBS4 = { measure_a: [1000, 2000, 3000, 500], label_a: ['a', 'b', 'a', 'b'] }
  // interleaved [x0,y0,x1,y1,…] — deliberately NOT the first-two-metric-columns fabrication.
  const EMB = { positions: new Float32Array([10, 11, 20, 21, 30, 31, 40, 41]), length: 4 }

  it('serves the injected embedding positions verbatim when no mask', async () => {
    const src = source('obs', OBS4, undefined, undefined, EMB)
    const p = await src.positions('metric')
    expect(p.length).toBe(4)
    expect([...p.positions]).toEqual([10, 11, 20, 21, 30, 31, 40, 41])
  })

  it('filters the embedding to the kept rows for the `.kept` variant (the thinning)', async () => {
    // keep rows 0 and 2 → the after scatter has FEWER points than the before.
    const mask = [true, false, true, false]
    const src = source('obs.kept', OBS4, mask, undefined, EMB)
    const p = await src.positions('metric')
    expect(p.length).toBe(2)
    expect([...p.positions]).toEqual([10, 11, 30, 31])
  })

  it('falls back to the metric pair when no embedding is injected and the pair is DETERMINED', async () => {
    // Rewritten with a second numeric column (ITEM-7). It used to run on `SLICE4`, which carries
    // ONE numeric column, and asserted `x = measure_a, y = 0` — i.e. it pinned the fabrication of a
    // coordinate out of a frame that had no second axis to offer. That case now REFUSES (see
    // TEST-11 below); what survives here is the only shape where the legacy fallback binds
    // anything at all: exactly two numeric columns, where the pair IS the choice.
    const src = source('obs', { measure_a: [1000, 2000, 3000, 500], measure_b: [300, 600, 900, 150], label_a: ['a', 'b', 'a', 'b'] })
    const p = await src.positions('metric')
    expect(p.length).toBe(4)
    expect([...p.positions]).toEqual([1000, 300, 2000, 600, 3000, 900, 500, 150])
  })

  // ── TEST-11 (ITEM-7) — the fallback refuses rather than picking axes by column order ────────
  //
  // The defect: `positions()`'s legacy arm read `numeric[0]` / `numeric[1]` off
  // `Object.keys(this.cols)`, which is INSERTION order. So WHICH columns became the scatter's x
  // and y was a property of how the frame was assembled, not of anything anyone declared — the
  // owner-reported "a wrong column is plotted as a coordinate".
  //
  // Leg (b) is the one that names the defect rather than a symptom: the SAME columns in a
  // DIFFERENT key order must produce the SAME answer. Pre-fix they produce two different
  // coordinate spaces, both painted with full confidence, which is the signature.
  describe('TEST-11: the legacy metric fallback refuses when the pair is not determined', () => {
    const COLS = {
      metric_b: [1, 2, 3],
      metric_a: [10, 20, 30],
      metric_c: [100, 200, 300],
      label_a: ['a', 'b', 'c'],
    }

    it('(a) refuses — and says so once, naming the candidates — with THREE numeric columns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const src = source('frame', COLS)
        const p = await src.positions('metric')
        expect(p.length, 'no coordinates are served rather than two columns being picked by order').toBe(0)
        expect([...p.positions]).toEqual([])
        expect(warn).toHaveBeenCalledTimes(1)
        const said = String(warn.mock.calls[0]?.[0] ?? '')
        // INV-3: a refusal the user cannot see is indistinguishable from a guess, and one that
        // does not name the candidates is not actionable.
        for (const c of ['metric_b', 'metric_a', 'metric_c']) expect(said).toContain(c)
        // repainting must not re-say it
        await src.positions('metric')
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })

    it('(b) THE ORDERING LEG — the same columns in a different key order resolve identically', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const reordered = {
          metric_c: COLS.metric_c,
          label_a: COLS.label_a,
          metric_a: COLS.metric_a,
          metric_b: COLS.metric_b,
        }
        const asBuilt = await source('frame', COLS).positions('metric')
        const asReordered = await source('frame', reordered).positions('metric')
        expect(
          { length: asReordered.length, positions: [...asReordered.positions] },
          'insertion order must not decide which columns are the axes',
        ).toEqual({ length: asBuilt.length, positions: [...asBuilt.positions] })
        // …and the shared outcome is the REFUSAL, not some agreed-upon guess (without this the
        // leg would pass against a resolver that always fabricated the same wrong pair).
        expect(asBuilt.length).toBe(0)
      } finally {
        warn.mockRestore()
      }
    })

    it('(a′) refuses on ZERO and ONE numeric column too — neither determines a pair', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect((await source('none', { label_a: ['a', 'b'] }).positions('metric')).length).toBe(0)
        expect((await source('one', { measure_a: [1, 2], label_a: ['a', 'b'] }).positions('metric')).length).toBe(0)
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('createDatasetResolver threads positionsFor into the source (real coords over `obs`)', async () => {
    const resolver = createDatasetResolver({
      obsFor: () => OBS4,
      keptMaskFor: () => [true, false, true, false],
      positionsFor: base => (base === 'obs' ? EMB : undefined),
    })
    const before = await (await Promise.resolve(resolver('obs'))).positions('metric')
    const after = await (await Promise.resolve(resolver('obs.kept'))).positions('metric')
    expect(before.length).toBe(4) // all cells
    expect(after.length).toBe(2) // masked → fewer (the thinning)
    expect([...after.positions]).toEqual([10, 11, 30, 31])
  })
})


describe('a frame with no categorical column still paints ONE distribution', () => {
  // The live regression this pins. A chart whose schema REQUIRES a grouping has the channel
  // auto-resolved by `resolveBinding`, which ends `?? 'group'` — a literal naming no column.
  // `categorical()` answered an unknown key with an EMPTY column, so the chart received zero
  // rows and painted nothing: a blank pane where one distribution belongs.
  //
  // It became reachable the moment per-row identifier columns stopped being advertised as
  // categorical: a metrics-only frame then has NO categorical column at all, which is the
  // ordinary shape of a frame carrying only measurements.
  const METRICS = { total: [1, 2, 3, 4], pct: [10, 20, 30, 40] }

  it('groups every row together for a key the frame does not have', async () => {
    const src = source('frame', METRICS)
    const got = await src.categorical('group')
    expect(got.length).toBe(4)
    expect(got.categories).toEqual([UNGROUPED_CATEGORY])
    expect([...got.codes]).toEqual([0, 0, 0, 0])
  })

  it('the `.kept` variant reports its OWN survivor count, not the unfiltered one', async () => {
    // A before/after pair must not show the same row count on both sides — that would make a
    // filter look like it removed nothing.
    const kept = source('frame.kept', METRICS, [true, false, true, false])
    const got = await kept.categorical('group')
    expect(got.length).toBe(2)
    expect(got.categories).toEqual([UNGROUPED_CATEGORY])
  })

  it('a REAL categorical column is untouched', async () => {
    // The control: the degenerate path must not swallow genuine grouping.
    const src = source('frame', { ...METRICS, label: ['a', 'b', 'a', 'b'] })
    const got = await src.categorical('label')
    expect(got.categories).toEqual(['a', 'b'])
    expect([...got.codes]).toEqual([0, 1, 0, 1])
  })
})

// ── the pre-filter must agree with the catalog it is checked against (G3) ───────────────────
//
// `unresolvableBinding` exists so a series viz cannot serve is DROPPED here rather than handed
// over: viz validates encode-explicit bindings against the dataset catalog and throws for the
// WHOLE option, so one bad binding blanks the entire canvas. That only holds while the predicate
// and the frame source's `catalog()` answer the same question. They did not: the catalog withholds a
// per-row identifier from its categorical channel, and the predicate accepted any non-numeric
// column — so exactly the binding the catalog refuses to advertise sailed through the pre-filter.
describe('unresolvableBinding agrees with the catalog (G3)', () => {
  /** A frame in the shape a real import lands: measurements, a genuine grouping, and a column
   *  holding a distinct value in every row (a per-row key). */
  const FRAME = {
    depth: [10, 20, 30, 40],
    batch: ['ctrl', 'ctrl', 'treated', 'treated'],
    key: ['r1', 'r2', 'r3', 'r4'],
  }
  const grouped = (column: string) =>
    ({ id: 's', type: 'violin', coordId: 'c', encode: { valueKey: 'depth', groupKey: column } }) as never

  it('the catalog does not advertise a per-row key as a grouping (the fact being mirrored)', async () => {
    const catalog = await source('frame', FRAME).catalog()
    expect(catalog.categoricalColumns.map(c => c.id)).toEqual(['batch'])
  })

  it('REFUSES a grouping bound to a per-row key', () => {
    expect(
      unresolvableBinding(grouped('key'), FRAME),
      'the catalog withholds this column, so viz will reject the binding and abort the option — ' +
        'the pre-filter exists to catch it here',
    ).toBe('key')
  })

  it('still accepts a genuine grouping, and still refuses an absent column', () => {
    expect(unresolvableBinding(grouped('batch'), FRAME)).toBeNull()
    expect(unresolvableBinding(grouped('absent'), FRAME)).toBe('absent')
  })

  // ── colorBy: the ONE channel the Visualize emit sections bind ──────────────────────
  //
  // `colorBy` is not part of viz's `bindingSchema`, so `encodeExplicitChannelIds` does not
  // enumerate it and `validateBindings` never checks it; viz's own `validateColorBy` throws
  // only for the `blend` pair. So for the whole of the Visualize pane's emit model this
  // predicate was a PERMANENT NO-OP: a failed read, or an artifact deleted under an open
  // plot, left a full-point scatter coloured uniformly "All" — indistinguishable from a
  // legitimate plot of a constant column, and silent in the console.
  //
  // RED ON REVERT: delete the `colorBy` block from `seriesBoundColumns` and every
  // assertion in this describe fails.
  describe('colorBy — the channel the pane actually emits', () => {
    const coloured = (cb: Record<string, unknown>) =>
      ({ id: 's', type: 'scatter', coordId: 'c', encode: { colorBy: cb } }) as never

    it('a CONTINUOUS colorBy naming a column the slice cannot serve is unresolvable', () => {
      expect(unresolvableBinding(coloured({ mode: 'continuous', key: 'gone' }), FRAME)).toBe('gone')
      expect(unresolvableBinding(coloured({ mode: 'value', key: 'gone' }), FRAME)).toBe('gone')
      // …and a NUMERIC column it CAN serve resolves (the positive control — without it this
      // would also pass for a predicate that refused every colorBy).
      expect(unresolvableBinding(coloured({ mode: 'continuous', key: 'depth' }), FRAME)).toBeNull()
    })

    it('a CATEGORICAL colorBy is checked as a categorical column, not merely as present', () => {
      // `depth` EXISTS but is numeric, so a categorical colorBy on it is unservable — the
      // kind test is what makes this more than an existence check.
      expect(unresolvableBinding(coloured({ mode: 'categorical', key: 'depth' }), FRAME)).toBe('depth')
      expect(unresolvableBinding(coloured({ mode: 'categorical', key: 'batch' }), FRAME)).toBeNull()
      // The catalog withholds a per-row key from its categorical channel, and so does this.
      expect(unresolvableBinding(coloured({ mode: 'categorical', key: 'key' }), FRAME)).toBe('key')
    })

    it('a BLEND colorBy checks BOTH halves of its pair', () => {
      expect(
        unresolvableBinding(coloured({ mode: 'blend', categoryKey: 'batch', valueKey: 'depth' }), FRAME),
      ).toBeNull()
      expect(
        unresolvableBinding(coloured({ mode: 'blend', categoryKey: 'gone', valueKey: 'depth' }), FRAME),
      ).toBe('gone')
      expect(
        unresolvableBinding(coloured({ mode: 'blend', categoryKey: 'batch', valueKey: 'gone' }), FRAME),
      ).toBe('gone')
      // `categoryKey` falls back to `key`, the same widening viz's own validator does.
      expect(
        unresolvableBinding(coloured({ mode: 'blend', key: 'gone', valueKey: 'depth' }), FRAME),
      ).toBe('gone')
    })

    it('an UNKNOWN or absent mode binds nothing here — viz refuses that shape LOUDLY', () => {
      // Deliberate: `assertColorByShape` throws for a malformed colorBy, and silently dropping
      // the series here would hide an authoring mistake behind an empty canvas.
      expect(unresolvableBinding(coloured({ key: 'gone' }), FRAME)).toBeNull()
      expect(unresolvableBinding(coloured({ mode: 'made-up', key: 'gone' }), FRAME)).toBeNull()
    })

    it('the colorBy binding is listed ALONGSIDE the other channels, not instead of them', () => {
      const both = {
        id: 's',
        type: 'scatter',
        coordId: 'c',
        encode: { valueKey: 'depth', colorBy: { mode: 'categorical', key: 'gone' } },
      } as never
      expect(seriesBoundColumns(both).map(c => c.id).sort()).toEqual(['depth', 'gone'])
    })
  })
})

// ── an UNSET optional channel means UNGROUPED, not "pick a column for me" ────────────────────
//
// Reported on the live app: in the filter view, with nothing chosen in "Group by", the violin
// already showed several distributions. It must show ONE — every row together — until the user
// picks a grouping column.
//
// The mechanism is NOT that an empty string reaches viz as a column name. It is the opposite:
// `resolveCanvasOption` USED to delete an `encode` channel whose ref resolved to `''`, and an
// ABSENT channel is exactly how a series says "I never mentioned this" — at which point viz's
// `resolveBinding` fills it from the catalog, and a violin silently groups by whichever
// categorical column happens to be first. "Explicitly unset" and "never mentioned" were the same
// wire shape, so the honest answer was unreachable.
//
// `''` is already the coherent in-band spelling of "no column" everywhere else in viz —
// `validateBindings` skips an empty binding, `seriesBoundColumns` skips it, `resolveBinding`'s own
// `value` fallback produces it, and the frame-backed source's `categorical('')` already returns ONE
// group over every row. The only thing that destroyed it was the strip. So an explicitly-empty
// channel is now PRESERVED as `''`, and absence again means only what it says.
describe('an explicitly-unset encode channel stays unset (group-by not chosen)', () => {
  const FRAME = {
    depth: [2, 5, 8, 40],
    weight: [1000, 2000, 3000, 500],
    siteA: ['s1', 's1', 's2', 's2'],
    siteB: ['x', 'y', 'z', 'x'],
  }
  /** The filter view's criterion violin, verbatim in shape: value = the criterion column, grouping
   *  = whatever the user picked in the group-by control. */
  const template = (): CanvasTemplate =>
    ({
      datasets: [{ id: 'unset-frame' }],
      grid: [{ id: 'before', region: { row: 0, col: 0 } }],
      series: [
        {
          id: 'before',
          type: 'violin',
          coordId: 'before',
          datasetId: 'unset-frame',
          encode: { valueKey: 'depth', groupKey: '$state.groupBy' },
        },
      ],
    }) as CanvasTemplate
  const frameScope = (groupBy: string): Scope =>
    ({ params: {}, state: { groupBy }, derived: {}, const: {}, data: {} }) as Scope

  /** Drive the REAL path — resolve the declaration, then let viz parse it against the REAL
   *  catalog the canvas source publishes — and report the grouping column the violin ends up
   *  reading plus the categories that column yields. */
  async function measure(groupBy: string): Promise<{ groupKey: string; categories: readonly string[] }> {
    const src = source('unset-frame', FRAME)
    const controller = new VizController({ resolveDataset: () => src })
    const resolved = await controller.setOption(resolveCanvasOption(template(), frameScope(groupBy)), {
      replace: true,
    })
    const binding = resolved.series[0].model.bindings['group']
    const groupKey = typeof binding === 'string' ? binding : ''
    return { groupKey, categories: (await src.categorical(groupKey)).categories }
  }

  it('NO group-by chosen ⇒ the violin reads no column and paints exactly ONE distribution', async () => {
    const { groupKey, categories } = await measure('')
    expect(
      groupKey,
      'an unset grouping must bind NO column — binding the first categorical column here is the bug',
    ).toBe('')
    expect(categories).toEqual([UNGROUPED_CATEGORY])
    expect(categories.length).toBe(1)
  })

  it('a chosen group-by still binds that exact column (the positive control)', async () => {
    const { groupKey, categories } = await measure('siteB')
    expect(groupKey).toBe('siteB')
    expect(categories.slice().sort()).toEqual(['x', 'y', 'z'])
  })

  it('the unset case is not merely "the first column happens to be right"', async () => {
    // `siteA` IS the first categorical column, and it yields 2 groups — so a run that reports one
    // group cannot be doing so by accidentally picking it.
    const catalog = await source('unset-frame', FRAME).catalog()
    expect(catalog.categoricalColumns[0].id).toBe('siteA')
    expect((await source('unset-frame', FRAME).categorical('siteA')).categories).toEqual(['s1', 's2'])
  })
})

// The SWEEP. `stripEmptyEncode` erased EVERY empty encode key, so the same "explicitly unset became
// never-mentioned" collapse applied to every channel the filter view binds to `$state.groupBy`.
// Whether that collapse is VISIBLE depends on whether the channel has a catalog DEFAULT that can
// substitute a column behind the user's back:
//
//   groupKey      → `categoricalColumns[0] ?? 'group'`   ⇒ substitutes  (the reported violin bug)
//   valueKey      → `valueColumns[0] ?? ''`              ⇒ substitutes
//   continuousKey → `continuousColumns[0] ?? 'qcA'`      ⇒ substitutes
//   colorBy       → not a binding channel at all; `parseOption` resolves it only when TRUTHY, so an
//                   absent (or empty) colorBy means NO colouring — nothing to substitute.
//
// So the scatter/image colour channels were not mis-colouring by SUBSTITUTION. They were broken a
// different way, and worse: the view wrote `colorBy: "$state.groupBy"` — a bare string where viz's
// `VizColorBy` requires `{ mode, key }` — which resolved to a mode-less, key-less object that every
// consumer reads as "colour by nothing". Choosing a group-by coloured the projection panes by
// NOTHING, in silence. Viz now REFUSES a key-less colorBy at parse, the view declares the object
// shape, and an unset key drops the channel (absence already means no colouring, nothing to guess).
describe('an unset colorBy colours by nothing (the channel that was already honest)', () => {
  const FRAME = { depth: [2, 5, 8, 40], siteA: ['s1', 's1', 's2', 's2'] }
  async function scatterColorBy(groupBy: string) {
    const src = source('unset-colour-frame', FRAME)
    const controller = new VizController({ resolveDataset: () => src })
    const resolved = await controller.setOption(
      resolveCanvasOption(
        {
          datasets: [{ id: 'unset-colour-frame' }],
          grid: [{ id: 'p', region: { row: 0, col: 0 } }],
          series: [
            {
              id: 'p',
              type: 'scatter',
              coordId: 'p',
              datasetId: 'unset-colour-frame',
              encode: { colorBy: { mode: 'categorical', key: '$state.groupBy' } },
            },
          ],
        } as CanvasTemplate,
        { params: {}, state: { groupBy }, derived: {}, const: {}, data: {} } as Scope,
      ),
      { replace: true },
    )
    return resolved.series[0].colorBy
  }

  it('NO group-by chosen ⇒ the scatter carries no colorBy (not a substituted column)', async () => {
    expect(await scatterColorBy('')).toBeUndefined()
  })

  it('a chosen group-by colours by that column (the positive control)', async () => {
    expect((await scatterColorBy('siteA'))?.key).toBe('siteA')
  })
})

// The other half of the rule: `''` is preserved ONLY for the keys that name a dataset COLUMN, where
// viz reads it as "bind no column". `layout` names a POSITIONS SET, and viz has no empty form for
// one — `parseOption` falls back to the default layout only when the key is ABSENT, so passing `''`
// through would bind a layout that names nothing and paint an empty pane. (This is the mutation
// that survived the first pass: dropping the key filter and preserving every empty value broke
// nothing any test could see.)
describe('an unset NON-column encode key still drops (layout has no empty form)', () => {
  it('an empty `layout` ref is dropped, leaving viz to fall back to its default layout', () => {
    const option = resolveCanvasOption(
      {
        datasets: [{ id: 'unset-layout-frame' }],
        grid: [{ id: 'p', region: { row: 0, col: 0 } }],
        series: [
          {
            id: 'p',
            type: 'scatter',
            coordId: 'p',
            datasetId: 'unset-layout-frame',
            encode: { layout: '$state.layout', valueKey: '$state.value' },
          },
        ],
      } as CanvasTemplate,
      { params: {}, state: { layout: '', value: '' }, derived: {}, const: {}, data: {} } as Scope,
    )
    const encode = (option.series[0] as { encode?: Record<string, unknown> }).encode!
    expect(encode.layout, 'a layout that names nothing must not be bound').toBeUndefined()
    // …while a COLUMN channel in the same encode keeps its explicit unset (the contrast that makes
    // this a rule about key kinds and not a blanket drop).
    expect(encode.valueKey).toBe('')
  })
})

// ITEM-29 — `resolveCanvasCoords` and `resolveCanvasOption` must expand IDENTICALLY.
//
// They are two functions over one template, and the failure they could have is silent: a base
// named by one and not the other would hand a dataset another's coordinates, or none. So the
// agreement is asserted rather than assumed — over a `for_each` template, which is the shape
// where two expansions could actually disagree.
describe('resolveCanvasCoords (ITEM-29)', () => {
  const template = {
    datasets: [
      { id: 'emb.$e', for_each: '$state.shown as $e', coords: { artifact: '$e' } },
      { id: 'plain' },
    ],
    series: [],
  } as unknown as CanvasTemplate

  it('resolves one entry per expansion, keyed by the resolved dataset id', () => {
    const scope = { state: { shown: ['art-a', 'art-b'] } }
    expect(resolveCanvasCoords(template, scope)).toEqual({
      'emb.art-a': 'art-a',
      'emb.art-b': 'art-b',
    })
  })

  it('names exactly the datasets the OPTION carries — no more, no fewer', () => {
    const scope = { state: { shown: ['art-a', 'art-b'] } }
    const option = resolveCanvasOption(template, scope)
    const declared = Object.keys(resolveCanvasCoords(template, scope))
    const ids = (option.datasets ?? []).map(d => d.id)
    expect(ids).toEqual(['emb.art-a', 'emb.art-b', 'plain'])
    // Every declared base exists in the option; a base with no `coords` is simply absent here.
    expect(declared.every(id => ids.includes(id))).toBe(true)
    expect(declared).not.toContain('plain')
  })

  it('yields NO entry for a ref that resolves to nothing — unset is absence (INV-4)', () => {
    expect(resolveCanvasCoords(template, { state: { shown: [] } })).toEqual({})
    const unset = {
      datasets: [{ id: 'base', coords: { artifact: '$state.missing' } }],
      series: [],
    } as unknown as CanvasTemplate
    expect(resolveCanvasCoords(unset, { state: {} })).toEqual({})
  })
})

// TEST-30 [ITEM-25] — the canvas kept the LOOSE (0-for-missing) coercion semantics.
//
// Lives here rather than beside the shared coercer because it needs the canvas source, and a core
// module may not reach into an extension. Asserted through the real consumer's BEHAVIOUR, not by
// scanning source for a helper declaration (DRIFT-1.2): a source-text guard failed by flagging a
// correct implementation, and that anti-pattern has cost this repo twice already. Built through
// this file's `source()` factory for the reason its own comment gives — a test file should not
// repeat a name it does not own.
describe('the canvas source — coercion semantics it has always had (ITEM-25)', () => {
  it('serves a MISSING entry as 0, not NaN', async () => {
    const src = source('t', { c: [1, null, 2] as unknown as number[] })
    const col = await src.continuous('c')
    // Switching this call site to the shared NaN-for-missing coercer would put a NaN into the
    // fabricated Float32Array coordinates below — an UNRENDERABLE point, not a dropped one. So
    // the fork between the two coercers is deliberate, and this is the assertion that pins it.
    expect(Array.from(col.value)).toEqual([1, 0, 2])
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// TEST-15 [acceptance][invariant: INV-10] — cross-source addressing under incremental landing
// (incremental-landing #29, ITEM-8/ITEM-7 / DEC-7)
// ════════════════════════════════════════════════════════════════════════════════════════════

describe('TEST-15 — a positions buffer (depth p) and a $data value column (depth c) address the SAME row', () => {
  it('at p!=c the mask serves the COMMON GLOBAL PREFIX — a kept slot addresses ONE row on both buffers (DEC-37)', async () => {
    // Positions come from a DIFFERENT path than the value column (`buildCanvasDataSource().positions`,
    // never the declarative arc), and under incremental landing they land to DIFFERENT depths: here
    // positions are fully landed (4 rows) while the $data value column is still landing (2 rows).
    // DEC-37: index both by the same global offset — serve the common prefix [0, min(depths)) = [0, 2),
    // so a kept slot addresses ONE row on both buffers and rows past the shorter buffer are deferred.
    const mask = [true, false, true, false] // keeps GLOBAL rows 0 and 2; row 2 is beyond the value depth
    const positions = { positions: new Float32Array([0, 100, 1, 101, 2, 102, 3, 103]), length: 4 }
    const src = source('x', { v: [10, 20] }, mask, undefined, positions) // value column landed 2 rows

    const values = await src.continuous('v')
    const pos = await src.positions('metric')
    // Served value + positions have the SAME length and address the SAME global row 0: v[0]=10 pairs
    // with positions row 0 = [0,100]. Row 2 (kept by the mask but beyond the value depth) is deferred.
    expect(values.length).toBe(1)
    expect(pos.length).toBe(1)
    expect(Array.from(values.value)).toEqual([10])
    expect(Array.from(pos.positions)).toEqual([0, 100])
    // NEGATIVE CONTROL: an impl indexing each buffer by its OWN local extent filters value(2) by
    // mask[0..2) -> 1 kept, but positions(4) by mask[0..4) -> 2 kept -> MISMATCHED. The equal length
    // below is exactly what a local-offset impl fails to produce.
    expect(values.length).toBe(pos.length)
  })

  it('once landing COMPLETES (equal depth) the mask keeps the SAME GLOBAL rows on BOTH buffers (positive control)', async () => {
    const mask = [true, false, true, false] // keeps global rows 0 and 2
    const positions = { positions: new Float32Array([0, 100, 1, 101, 2, 102, 3, 103]), length: 4 }
    const src = source('x', { v: [10, 20, 30, 40] }, mask, undefined, positions) // value fully landed

    const values = await src.continuous('v')
    expect(Array.from(values.value)).toEqual([10, 30]) // global rows 0 and 2, not local 0 and 1
    const pos = await src.positions('metric')
    expect(pos.length).toBe(2)
    expect(Array.from(pos.positions)).toEqual([0, 100, 2, 102]) // SAME global rows 0 and 2
    expect(values.value[0]).toBe(10)
    expect([pos.positions[0], pos.positions[1]]).toEqual([0, 100])
    expect(values.value[1]).toBe(30)
    expect([pos.positions[2], pos.positions[3]]).toEqual([2, 102])
  })
})
