import { describe, it, expect } from 'vitest'
import type {
  ScatterWidget,
  ViolinWidget,
  BarWidget,
  HistogramWidget,
  ImageWidget,
} from '@/modules/workbench/core/manifest/viewSpec'
import {
  buildScatterOption,
  buildViolinOption,
  buildScatterSource,
  buildViolinSource,
  buildBarOption,
  buildHistogramOption,
  buildImageOption,
  buildBarSource,
  buildHistogramSource,
  buildImageSource,
  FrameDataSource,
  ImageDataSource,
  IMAGE_WIDGET_SPACE,
} from './viz'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { installBuiltins, parseOption } from '@ziee/viz'

// TEST-8 (PLAN.md ITEM-8) — the `scatter` / `violin` widgets build a valid `@ziee/viz`
// `VizOption` from their `encode` bindings (metric columns, colorBy %mito, groupKey), and
// their frame-backed `FrameDataSource` decodes the columnar slice into wire shapes.

const obs = {
  nCount: [1000, 2000, 3000, 500],
  nFeature: [300, 600, 900, 150],
  ratio: [2, 5, 8, 40],
  group: ['s1', 's1', 's2', 's2'],
}

function scope(extra: Record<string, unknown> = {}): Scope {
  return { params: {}, state: {}, derived: {}, const: {}, data: { obs }, ...extra }
}

describe('scatter widget → VizOption (ITEM-8)', () => {
  const w: ScatterWidget = {
    kind: 'scatter',
    id: 'metricScatter',
    obs: '$data.obs',
    encode: { x: 'nCount', y: 'nFeature', colorBy: 'ratio', groupBy: 'group' },
    filters: '$state.filteringParams',
    selection: '$state.gate',
    onSelect: 'applyGate',
    onFilter: 'setRange',
  }

  it('emits one scatter series binding the metric layout + continuous colorBy', () => {
    const option = buildScatterOption(w, scope())
    expect(option.series).toHaveLength(1)
    const s = option.series[0]
    expect(s.type).toBe('scatter')
    expect(s.coordId).toBe('metric')
    expect(s.encode?.layout).toBe('metric')
    expect(s.encode?.colorBy).toEqual({ mode: 'continuous', key: 'ratio' })
    // produces + consumes the shared selection (the brush gate).
    expect(s.select?.produces).toBe(true)
    expect(s.emphasis?.consumesSelection).toBe(true)
  })

  it('maps per-metric thresholds to value-range `filters` (DEC-1, no per-point mask)', () => {
    const option = buildScatterOption(
      w,
      scope({ state: { filteringParams: { nCount: [500, 2500], ratio: [0, 10] }, gate: [] } }),
    )
    expect(option.filters).toEqual({ nCount: [500, 2500], ratio: [0, 10] })
  })

  it('maps the brushed gate to the selection-dim ids', () => {
    const option = buildScatterOption(w, scope({ state: { gate: [0, 2], filteringParams: {} } }))
    expect(option.selection?.ids).toEqual([0, 2])
  })

  it('builds a frame DataSource whose metric layout interleaves x×y', async () => {
    const src = buildScatterSource(w, scope())
    expect(src).toBeInstanceOf(FrameDataSource)
    const pos = await src.positions('metric')
    expect(pos.length).toBe(4)
    // first point = (nCount[0], nFeature[0]).
    expect(Array.from(pos.positions.slice(0, 2))).toEqual([1000, 300])
    const cat = await src.categorical('group')
    expect(cat.categories).toEqual(['s1', 's2'])
  })
})

describe('violin widget → VizOption (ITEM-8)', () => {
  const w: ViolinWidget = {
    kind: 'violin',
    id: 'v-before',
    obs: '$data.obs',
    encode: { groupBy: 'group', valueKey: 'ratio' },
  }

  it('emits one violin series binding groupKey + valueKey', () => {
    const option = buildViolinOption(w, scope())
    expect(option.series).toHaveLength(1)
    const s = option.series[0]
    expect(s.type).toBe('violin')
    expect(s.encode?.groupKey).toBe('group')
    expect(s.encode?.valueKey).toBe('ratio')
  })

  // The option and the source are built together and handed to `<Viz>` together, so the only
  // reading that matters is whether viz ACCEPTS the pair. Asserting the option's encode alone (the
  // test above) passed for as long as the widget existed while `parseOption` rejected every
  // violin: `FrameDataSource.catalog()` hardcoded `valueColumns: []`, and a `value` channel is
  // validated against exactly that list, so the explicit `valueKey` this widget always emits was
  // "not a value column in the dataset".
  it('viz ACCEPTS the option against the source the same widget builds', async () => {
    installBuiltins()
    const option = buildViolinOption(w, scope())
    const catalog = await buildViolinSource(w, scope()).catalog()
    expect(catalog.valueColumns, 'a numeric frame column is bindable as a value channel').toContain(
      'ratio',
    )
    expect(() => parseOption(option, catalog)).not.toThrow()
  })

  // Same disease as the canvas `.kept` source (see `canvasLiveMask.test.ts`): the widget's own
  // "after" mask is a ROW filter, and classifying the columns after applying it made the schema a
  // function of the survivors — hide every point and every column vanished from the catalog.
  it('a mask hiding EVERY point leaves the catalog’s columns where they were', async () => {
    const after: ViolinWidget = { ...w, hidden: '$derived.hidden' }
    const src = buildViolinSource(after, scope({ derived: { hidden: [true, true, true, true] } }))
    const catalog = await src.catalog()
    expect(catalog.pointCount, 'nothing survived the mask').toBe(0)
    expect(catalog.valueColumns).toContain('ratio')
    expect(catalog.categoricalColumns.map(c => c.id)).toContain('group')
    expect(
      catalog.categoricalColumns.map(c => c.id),
      'a numeric column must not change channel when its rows go away',
    ).not.toContain('ratio')
  })

  it('the "after" source drops hidden points (client mask, DEC-1)', async () => {
    // hide the last point (an outlier) → the source exposes only 3 cells.
    const after: ViolinWidget = { ...w, hidden: '$derived.hidden' }
    const src = buildViolinSource(after, scope({ derived: { hidden: [false, false, false, true] } }))
    const col = await src.continuous('ratio')
    expect(col.length).toBe(3)
    expect(Array.from(col.value)).toEqual([2, 5, 8])
  })
})

// DEC-12 — the GENERAL bar / histogram / image kinds lower onto existing @ziee/viz chart kinds.

describe('bar widget → VizOption (DEC-12)', () => {
  it('lowers onto the viz `bar` kind with a categorical GROUP channel (encode.groupKey)', () => {
    const w: BarWidget = { kind: 'bar', id: 'sampleBar', encode: { groupBy: 'group' } }
    const option = buildBarOption(w, scope())
    expect(option.series?.[0]).toMatchObject({ id: 'bar', type: 'bar', coordId: 'bar', encode: { groupKey: 'group' } })
  })

  it('buildBarSource honors the hidden mask', async () => {
    const w: BarWidget = { kind: 'bar', encode: { groupBy: 'group' }, hidden: '$derived.hidden' }
    const src = buildBarSource(w, scope({ derived: { hidden: [false, false, false, true] } }))
    const cat = await src.categorical('group')
    expect(cat.length).toBe(3)
  })
})

describe('histogram widget → VizOption (DEC-12)', () => {
  it('lowers onto the viz `histogram` kind with a CONTINUOUS value channel (encode.continuousKey)', () => {
    const w: HistogramWidget = { kind: 'histogram', id: 'ratioHist', encode: { x: 'ratio' } }
    const option = buildHistogramOption(w, scope())
    expect(option.series?.[0]).toMatchObject({
      id: 'histogram',
      type: 'histogram',
      coordId: 'histogram',
      encode: { continuousKey: 'ratio' },
    })
  })

  it('buildHistogramSource projects the continuous column', async () => {
    const w: HistogramWidget = { kind: 'histogram', encode: { x: 'ratio' } }
    const src = buildHistogramSource(w, scope())
    const col = await src.continuous('ratio')
    expect(Array.from(col.value)).toEqual([2, 5, 8, 40])
  })
})

describe('image widget → VizOption (DEC-12 / INV-16)', () => {
  it('lowers onto the viz `image` view-kind (dense, no channels)', () => {
    const w: ImageWidget = { kind: 'image', id: 'tissue' }
    const option = buildImageOption(w, scope())
    expect(option.series?.[0]).toMatchObject({ id: 'image', type: 'image', coordId: 'image' })
  })

  it('ImageDataSource serves the underlay payload + reports hasImage', async () => {
    const image = { data: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1, channels: 4 as const, affine: [1, 0, 0, 0, 1, 0] as const }
    const w: ImageWidget = { kind: 'image', image: '$data.image', points: '$data.spatial' }
    const src = buildImageSource(w, scope({ data: { image, spatial: [0.5, 0.5] } }))
    const underlay = await src.imageUnderlay()
    expect(underlay.width).toBe(1)
    expect(underlay.channels).toBe(4)
    const cat = await src.catalog()
    expect(cat.hasImage).toBe(true)
    expect(cat.pointCount).toBe(1)
  })

  it('ImageDataSource throws on a missing underlay payload', async () => {
    const src = new ImageDataSource({ image: undefined })
    await expect(src.imageUnderlay()).rejects.toThrow(/missing\/incomplete image underlay/)
  })

  // ── #228 TEST-16 — the declared-but-DEAD `points` reaches the layer emit ────────────────────
  //
  // `ImageWidget.points` has been in the spec vocabulary since DEC-12/INV-16 — *"an optional
  // spatial positions map overlaid on the raster"* — and the grid dropped it: the dense `image`
  // dense image pane drew the raster and skipped the point emit, so these positions reached it and
  // went nowhere. #159's DEC-2 named it as a live gap.
  //
  // This drives the REAL chain the widget takes — `buildImageSource` -> `catalog()` ->
  // `resolvePaneFrame` -> the pane layer builder — and asserts the overlay binds. It is
  // NOT a check that `positions()` returns something: that was already true and was exactly the
  // shape of the defect (a value produced and discarded).
  it('a widget with `points` declares a frame its raster and its layout SHARE, so the overlay binds', async () => {
    const { resolvePaneFrame } = await import('@ziee/viz/core')
    const image = {
      data: new Uint8Array([1, 2, 3, 4]),
      width: 1,
      height: 1,
      channels: 4 as const,
      affine: [0.5, 0, 0, 0, 0.5, 0] as const,
    }
    const withPoints = buildImageSource(
      { kind: 'image', image: '$data.image', points: '$data.spatial' } as ImageWidget,
      scope({ data: { image, spatial: [0.5, 0.5] } }),
    )
    const cat = await withPoints.catalog()

    // BOTH halves of the binding are the widget's OWN declaration, and they must name one id —
    // that is the change. Before it, the catalog carried `hasImage: true` and NO `image` meta and
    // NO layout `space`, so the grid could never bind and `points` reached the source and went
    // nowhere. Asserting the two ids are EQUAL (not merely present) is the assertion: a version
    // that stamped the raster and forgot the layout would satisfy "the meta exists".
    // BY NAME, never by position: a declared collection is authored in whatever order its author
    // wrote it, and the contract promises nothing about index 0 (`lint-positional-declaration`).
    const layout = cat.layouts.find(l => l.id === 'image')
    expect(cat.image?.space).toBe(IMAGE_WIDGET_SPACE)
    expect(layout?.space).toBe(IMAGE_WIDGET_SPACE)
    expect(cat.image?.space).toBe(layout?.space)

    // …and the raster knows WHERE in that space it sits, which the binding also requires. The
    // widget's `affine` runs space -> raster pixels; `toSpace` is its exact inverse, so a 0.5
    // affine is a 2.0 placement. Asserted by VALUE, because an identity stamped here would look
    // like a placement and be a fabrication.
    expect(cat.image?.toSpace).toEqual([2, 0, 0, 0, 2, 0])

    const frame = resolvePaneFrame(cat, 'image')
    expect(frame.binding.bound).toBe(true)
    // The MATRIX the raster is placed by, BY VALUE. `expect(frame.levelMatrix).toBeDefined()` was
    // here first and a blind audit called it correctly: `levelMatrix` is built for ANY catalog
    // carrying an `image`, regardless of `space`, `toSpace` or the verdict, so it was satisfied by
    // every non-empty image catalog and added nothing. The widget's affine is 0.5 (space -> raster
    // pixels), so the placement that reaches the layer is 2.0 (raster pixels -> space) — a number
    // that is wrong if the inversion is dropped, doubled, or applied to the wrong half.
    expect(frame.levelMatrix?.[0]).toBeCloseTo(2, 12)
    expect(frame.levelMatrix?.[5]).toBeCloseTo(2, 12)
    // …and the POINTS ride their own identity placement, which is a DIFFERENT matrix.
    expect(frame.layoutToSpace).toEqual([1, 0, 0, 0, 1, 0])
    // The grid's emit for a bound frame — that it produces BOTH the raster layer and the pane's
    // scatter layer — is pinned by TEST-13/TEST-22/TEST-23, and the browser half by TEST-15.
  })

  it('a widget whose image payload cannot be placed declares NO frame, so nothing overlays', async () => {
    const { resolvePaneFrame } = await import('@ziee/viz/core')
    // No `affine` — the widget's own contract is that `affine` is what relates the points to the
    // raster, so without it there is no declaration to bind on. It is not a wildcard.
    const src = buildImageSource(
      { kind: 'image', image: '$data.image', points: '$data.spatial' } as ImageWidget,
      scope({ data: { image: { data: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 }, spatial: [0.5, 0.5] } }),
    )
    const cat = await src.catalog()
    expect(cat.image).toBeUndefined()
    expect(cat.layouts.find(l => l.id === 'image')?.space).toBeUndefined()
    expect(resolvePaneFrame(cat, 'image').binding.bound).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// T2 — the coercer fork is pinned AT THIS CALL SITE, behaviourally.
//
// `viz.tsx:49` aliases `asNums = asNumsZeroMissing` — the LOOSE semantics, deliberately
// kept because the canvas writes coordinates into a `Float32Array` and a NaN coordinate is
// an UNRENDERABLE point, not a dropped one. Nothing measured that: swapping the alias to
// `asNumsNaNMissing` left the whole 246-file UI suite green.
//
// So assert the semantics through the real `FrameDataSource` channels, not the identity of
// the imported symbol (a re-alias or a re-export would hide that).
//
// WHEN THE DEFECT IS PRESENT (viz.tsx:49 aliased to `asNumsNaNMissing`) a missing entry
// becomes NaN, `x[i] ?? 0` does NOT catch it (NaN is not nullish), and the point is written
// to the buffer as a NaN coordinate — it vanishes from the plot with a clean console.
// ══════════════════════════════════════════════════════════════════════════════════

// (`null` / `''` / `false` are the entries the two coercions actually disagree on —
// `Number(undefined)` is NaN under BOTH, so it is not a discriminator and is not used here.)
describe('T2 — FrameDataSource coerces a MISSING entry to 0, never NaN', () => {
  const holey = {
    hx: [1, null, 3],
    hy: [4, '', 6],
    hv: [7, null, 9],
    lbl: ['a', 'b', 'c'],
  }

  it('positions: a missing coordinate lands as a real 0, not an unrenderable NaN', async () => {
    const src = new FrameDataSource({ frame: holey, layoutX: 'hx', layoutY: 'hy' })
    const { positions, length } = await src.positions('metric')
    expect(length).toBe(3)
    expect(Array.from(positions)).toEqual([1, 4, 0, 0, 3, 6])
    expect(Array.from(positions).every(Number.isFinite)).toBe(true)
  })

  it('continuous: a missing value is 0 in the Float32Array channel', async () => {
    const src = new FrameDataSource({ frame: holey })
    const { value } = await src.continuous('hv')
    expect(Array.from(value)).toEqual([7, 0, 9])
  })

  it('valueColumn: the sparse projection carries 0 for the missing row', async () => {
    const src = new FrameDataSource({ frame: holey })
    const col = await src.valueColumn('hv')
    expect(Array.from(col.value)).toEqual([7, 0, 9])
  })
})
