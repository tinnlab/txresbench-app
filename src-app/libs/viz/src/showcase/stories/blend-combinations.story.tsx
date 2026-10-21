// blend-combinations.story.tsx — ONE showcase for the THREE column-type blend combinations
// (category×category, category×continuous, continuous×continuous) across FOUR chart types
// (scatter · bar · violin · heatmap), selectable from a toolbar, driven through the REAL
// declarative SERIES OPTION API (`controller.setOption(option)` → `GridWorkspace`).
//
// GROUNDING — what the engine actually does (no fictional bivariate blend):
//   • cat×cat   → the two categoricals CONCATENATE into ONE composite (cross-product) category
//                 (`concatCategoricalColumns`) → a composite HUE (`mode:'categorical'`).
//   • cat×cont  → the native 2D blend: category → base hue, continuous → lightness modulation
//                 (`mode:'blend'` → `blendColorsCpu` + the 2D legend).
//   • cont×cont → the two continuous columns AGGREGATE (mean of per-column-normalized) into ONE
//                 value (`aggregateContinuousColumns`) → a single continuous ramp (`mode:'continuous'`).
//
// RENDER PATH: the option's per-series `encode.colorBy` drives the scatter through
// `GridWorkspace.perCellColors` (which now has a `blend` branch), and the aggregated series bind the
// blend's CATEGORY axis as their GROUP-BY (the composite for cat×cat, `group` otherwise) via the same
// coordinated grid. Two derived columns (composite category + aggregated value) are added by a thin
// `BlendComboSource` wrapper so the series `encode` keys resolve against the catalog.

import { useEffect, useMemo, useState } from 'react'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, type ColorBy, type Coloring } from '../../viz-core/data/engine'
import { concatCategoricalColumns, aggregateContinuousColumns } from '../../viz-core/data/blendReduce'
import { colorbarDescriptor } from '../../viz-core/data/color'
import { VizController } from '../../adapter/VizController'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import type { VizOption, ResolvedOption, VizColorBy } from '../../viz-core/option/types'
import type {
  DataSource,
  DatasetCatalog,
  CatalogEntry,
  CategoricalColumn,
  ContinuousColumn,
  Positions,
  SparseColumn,
  ImageUnderlay,
  DataTable,
  GraphData,
} from '../../viz-core/data/wire'
import { BlendLegend } from '../../viz-core/controls/BlendLegend'
import { Legend } from '../../viz-core/controls/Legend'
import { Colorbar } from '../../viz-core/controls/Colorbar'
import { registerStory } from '../registry'

const EMPTY_HIDDEN: ReadonlySet<number> = new Set<number>()
const NOOP = () => {}

// ── combos + fixed column ids ────────────────────────────────────────────────────────────────
type Combo = 'cat+cat' | 'cat+cont' | 'cont+cont'
const COMBOS: readonly Combo[] = ['cat+cat', 'cat+cont', 'cont+cont']
const COMBO_LABEL: Record<Combo, string> = {
  'cat+cat': 'category × category',
  'cat+cont': 'category × continuous',
  'cont+cont': 'continuous × continuous',
}
const DERIVED_CAT = 'blendComposite' // group × type composite (cross-product hue)
const DERIVED_CONT = 'blendAgg' // mean(normalized qcA, qcB)
const FEATURE_KEYS = ['Feature A', 'Feature B', 'Feature C']

// The category axis each combo groups the aggregated charts by (composite only for cat×cat).
function groupFor(combo: Combo): string {
  return combo === 'cat+cat' ? DERIVED_CAT : 'group'
}
function scatterModeFor(combo: Combo): 'categorical' | 'blend' | 'continuous' {
  return combo === 'cat+cat' ? 'categorical' : combo === 'cat+cont' ? 'blend' : 'continuous'
}

// The SERIES-OPTION colorBy for the scatter (parsed → the grid cell's colorBy → perCellColors).
function optionColorBy(combo: Combo): VizColorBy {
  if (combo === 'cat+cat') return { mode: 'categorical', key: DERIVED_CAT }
  if (combo === 'cat+cont') {
    return { mode: 'blend', categoryKey: 'group', valueKey: 'qcA', channel: 'lightness' }
  }
  return { mode: 'continuous', key: DERIVED_CONT, colormap: 'viridis' }
}

// The ENGINE colorBy — used LOCALLY only for the scatter base-colors prop + the 2D legend (cat×cont).
function engineColorBy(combo: Combo): ColorBy {
  if (combo === 'cat+cat') {
    return { mode: 'categorical', key: DERIVED_CAT, colormap: 'viridis', scale: 'linear', hidden: new Set<number>() }
  }
  if (combo === 'cat+cont') {
    return {
      mode: 'blend',
      key: 'group',
      categoryKey: 'group',
      valueKey: 'qcA',
      channel: 'lightness',
      colormap: 'viridis',
      scale: 'linear',
      hidden: new Set<number>(),
    }
  }
  return { mode: 'continuous', key: DERIVED_CONT, colormap: 'viridis', scale: 'linear', hidden: new Set<number>() }
}

const CAPTION: Record<Combo, string> = {
  'cat+cat':
    'group × type → ONE composite (cross-product) category. Scatter (top-left): composite hue · Bar/Violin/Heatmap grouped BY that composite category (bar = count per composite group).',
  'cat+cont':
    'group (hue) × qcA (lightness) → the native 2D blend (see legend). Scatter (top-left): hue × value blend · Bar/Violin/Heatmap grouped by group (their value axis is a Feature column).',
  'cont+cont':
    'qcA ⊕ qcB → mean of per-column-normalized values → ONE continuous ramp. Scatter (top-left): the combined-magnitude ramp · aggregated charts group by group as a neutral reference.',
}

// Grid layout: scatter TL · bar TR · violin BL · heatmap BR. The series' encode is rewritten per combo.
function buildOption(combo: Combo): VizOption {
  const group = groupFor(combo)
  return {
    dataset: { id: 'demo' },
    grid: [
      { id: 'g-scatter', region: { row: 0, col: 0 } },
      { id: 'g-bar', region: { row: 0, col: 1 } },
      { id: 'g-violin', region: { row: 1, col: 0 } },
      { id: 'g-heat', region: { row: 1, col: 1 } },
    ],
    selection: { mode: 'lasso', link: ['s-scatter', 's-bar', 's-violin', 's-heat'] },
    colorScale: { link: ['s-scatter'] },
    series: [
      {
        id: 's-scatter',
        type: 'scatter',
        coordId: 'g-scatter',
        encode: { layout: 'primary', colorBy: optionColorBy(combo) },
        emphasis: { consumesSelection: true },
        select: { produces: true },
      },
      {
        id: 's-bar',
        type: 'bar',
        coordId: 'g-bar',
        encode: { groupKey: group },
        emphasis: { consumesSelection: true },
      },
      {
        id: 's-violin',
        type: 'violin',
        coordId: 'g-violin',
        encode: { groupKey: group, valueKey: 'Feature A' },
        emphasis: { consumesSelection: true },
      },
      {
        id: 's-heat',
        type: 'heatmap',
        coordId: 'g-heat',
        encode: { groupKey: group, valueKeys: FEATURE_KEYS },
        emphasis: { consumesSelection: true },
      },
    ],
  }
}

// ── derived-column source wrapper (adds blendComposite + blendAgg; delegates the rest) ─────────
class BlendComboSource implements DataSource {
  private derivedPromise: Promise<{ composite: CategoricalColumn; agg: ContinuousColumn }> | null = null
  constructor(private readonly inner: DataSource) {}

  private derived(): Promise<{ composite: CategoricalColumn; agg: ContinuousColumn }> {
    if (!this.derivedPromise) {
      this.derivedPromise = (async () => {
        const [group, type, qcA, qcB] = await Promise.all([
          this.inner.categorical('group'),
          this.inner.categorical('type'),
          this.inner.continuous('qcA'),
          this.inner.continuous('qcB'),
        ])
        const cc = concatCategoricalColumns([
          { codes: group.codes, categories: group.categories },
          { codes: type.codes, categories: type.categories },
        ])
        const agg = aggregateContinuousColumns([qcA.value, qcB.value], { operator: 'mean' })
        return {
          composite: { codes: cc.compositeCodes, categories: cc.compositeCategories, length: group.length },
          agg: { value: agg.value, length: qcA.length },
        }
      })()
    }
    return this.derivedPromise
  }

  async catalog(): Promise<DatasetCatalog> {
    const [cat, d] = await Promise.all([this.inner.catalog(), this.derived()])
    const compositeEntry: CatalogEntry = {
      id: DERIVED_CAT,
      kind: 'categorical',
      label: 'group × type',
      categories: d.composite.categories,
    }
    const aggEntry: CatalogEntry = { id: DERIVED_CONT, kind: 'continuous', label: 'qcA ⊕ qcB (mean)' }
    return {
      ...cat,
      categoricalColumns: [...cat.categoricalColumns, compositeEntry],
      continuousColumns: [...cat.continuousColumns, aggEntry],
    }
  }

  async categorical(key: string): Promise<CategoricalColumn> {
    if (key === DERIVED_CAT) return (await this.derived()).composite
    return this.inner.categorical(key)
  }

  async continuous(key: string): Promise<ContinuousColumn> {
    if (key === DERIVED_CONT) return (await this.derived()).agg
    return this.inner.continuous(key)
  }

  // ── pure delegation ──
  positions(layoutId: string): Promise<Positions> {
    return this.inner.positions(layoutId)
  }
  valueColumn(key: string, layer?: string): Promise<SparseColumn> {
    return this.inner.valueColumn(key, layer)
  }
  imageUnderlay(): Promise<ImageUnderlay> {
    return this.inner.imageUnderlay()
  }
  table(name: string): Promise<DataTable> {
    return this.inner.table(name)
  }
  graph(id: string): Promise<GraphData> {
    return this.inner.graph(id)
  }
}

// A labeled legend block for one panel.
function LegendBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid #e2e2e2',
        borderRadius: 6,
        padding: '6px 8px',
        minWidth: 120,
        maxHeight: 132,
        overflow: 'auto',
        background: '#fafafa',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 11, opacity: 0.65, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

// The scatter panel's legend depends on the combo: 2D blend legend / continuous colorbar / categorical.
function ScatterLegend({ coloring }: { coloring: Coloring | null }) {
  if (!coloring) return <span style={{ fontSize: 11, opacity: 0.5 }}>…</span>
  if (coloring.blend?.legend2d) return <BlendLegend legend={coloring.blend.legend2d} title="group (hue) × qcA (value)" />
  if (coloring.colorbar) return <Colorbar descriptor={coloring.colorbar} length={130} title="qcA ⊕ qcB (mean)" />
  if (coloring.legend) {
    return (
      <Legend
        column={{ categories: coloring.legend.entries.map(e => e.label) }}
        hidden={EMPTY_HIDDEN}
        onChange={NOOP}
        title="composite category"
      />
    )
  }
  return null
}

function BlendCombinationsStory() {
  const source = useMemo(() => new BlendComboSource(new FixtureSource({ seed: 42, pointCount: 60_000 })), [])
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`): this story's
  // per-combo `setOption({replace:true})` builds 4 grid cells + dataZoom windows, and on the
  // singletons every later story in the same page load inherits them. Measured before this change:
  // leaving this story left `gridWorkspace.cells=4 seq=4 plotInteraction.dataZoomWindows=3` behind.
  const stores = useMemo(() => createVizStores(), [])
  const controller = useMemo(
    () => new VizController({ resolveDataset: () => source, stores }),
    [source, stores],
  )

  const [combo, setCombo] = useState<Combo>('cat+cont')
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [coloring, setColoring] = useState<Coloring | null>(null) // scatter legend/colorbar/blend source
  const [resolved, setResolved] = useState<ResolvedOption | null>(null)

  // Load catalog + positions ONCE (the dense scatter reads the primary-layout positions prop).
  useEffect(() => {
    let alive = true
    void (async () => {
      const [cat, pos] = await Promise.all([source.catalog(), source.positions('primary')])
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // The scatter BASE colors + the 2D legend, recomputed per combo. The grid's perCellColors ALSO
  // recolors the scatter cell from the series colorBy (blend branch) — this base avoids an initial flash.
  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await computeColoring(source, engineColorBy(combo))
      if (!alive) return
      setColors(c.colors)
      setColorEpoch(e => e + 1)
      setColoring(c)
    })()
    return () => {
      alive = false
    }
  }, [source, combo])

  // Mount / update the declarative option (rebuilds the 4 series' encode) on every combo change.
  useEffect(() => {
    let alive = true
    // REPLACE (not the default merge): each combo rebuilds the whole 4-series option, so a merge would
    // stack the new series onto the prior grid (→ "region bound by more than one series").
    void controller.setOption(buildOption(combo), { replace: true }).then(r => {
      if (alive) setResolved(r)
    })
    return () => {
      alive = false
      stores.coordination.getState().clearSelection()
    }
  }, [controller, combo, stores])

  // probe / e2e hook.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      blendCombo: combo,
      blendScatterMode: scatterModeFor(combo),
      blendScatterReady: !!(positions && colors),
      blendSeriesKinds: resolved?.series.map(s => `${s.id}:${s.type}`).join(',') ?? '',
      blendPosPts: positions ? positions.length / 2 : 0,
      blendColorPts: colors ? colors.length / 4 : 0,
    }
  }, [combo, resolved, positions, colors])

  const group = groupFor(combo)
  const groupLabel = combo === 'cat+cat' ? 'group × type' : 'group'
  const groupCats = useMemo(
    () => catalog?.categoricalColumns.find(c => c.id === group)?.categories ?? [],
    [catalog, group],
  )
  const viridisStops = useMemo(() => colorbarDescriptor('viridis', [0, 1]).stops, [])

  const ready = positions && colors && catalog && resolved

  return (
    <div data-testid="viz-blend-combinations-story" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Blend combinations</strong>
        <span role="group" aria-label="Blend combination" style={{ display: 'inline-flex', gap: 4 }}>
          {COMBOS.map(c => (
            <button
              key={c}
              type="button"
              data-testid={`dp-combo-${c.replace('+', '-')}`}
              aria-pressed={combo === c}
              onClick={() => setCombo(c)}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                border: '1px solid #ccc',
                cursor: 'pointer',
                background: combo === c ? '#3355dd' : '#f2f2f2',
                color: combo === c ? '#fff' : '#222',
                fontWeight: combo === c ? 700 : 400,
              }}
            >
              {COMBO_LABEL[c]}
            </button>
          ))}
        </span>
        <span data-testid="blend-combo-series" style={{ opacity: 0.55, fontSize: 12 }}>
          {resolved ? `via setOption → ${resolved.series.map(s => s.type).join(' · ')}` : 'mounting…'}
        </span>
      </div>
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.7 }}>{CAPTION[combo]}</div>
      {/* One legend per panel (the coordinated grid can't host per-cell legends), labeled + laid out
          in the same TL→BR order as the 2×2 grid: scatter · bar · violin · heatmap. */}
      <div
        data-testid="blend-combo-legends"
        style={{ display: 'flex', gap: 8, padding: '0 8px 8px', flexWrap: 'wrap', alignItems: 'flex-start' }}
      >
        <LegendBlock label="Scatter — color">
          <ScatterLegend coloring={coloring} />
        </LegendBlock>
        <LegendBlock label="Bar — height">
          <span style={{ fontSize: 11, opacity: 0.8 }}>count of points per {groupLabel}</span>
        </LegendBlock>
        <LegendBlock label={`Violin — by ${groupLabel}`}>
          {groupCats.length > 0 ? (
            <Legend column={{ categories: groupCats }} hidden={EMPTY_HIDDEN} onChange={NOOP} title={groupLabel} />
          ) : (
            <span style={{ fontSize: 11, opacity: 0.5 }}>…</span>
          )}
        </LegendBlock>
        <LegendBlock label="Heatmap — Feature value">
          <div style={{ fontSize: 11, opacity: 0.8 }}>
            <div
              style={{
                width: 120,
                height: 10,
                borderRadius: 2,
                background: `linear-gradient(to right, ${viridisStops.join(',')})`,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', width: 120 }}>
              <span>low</span>
              <span>high</span>
            </div>
            <div style={{ marginTop: 2, opacity: 0.7 }}>
              rows: {groupLabel} · cols: A/B/C
            </div>
          </div>
        </LegendBlock>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          // key={combo}: a combo switch replaces the whole 4-series option, so remount the grid fresh
          // (a fresh deck) rather than tearing down + rebuilding the live scatter layer in place.
          <VizStoresProvider value={stores}>
            <GridWorkspace key={combo} positions={positions} colors={colors} colorEpoch={colorEpoch} source={source} catalog={catalog} />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'blend-combinations',
  category: 'View kinds',
  title: 'Blend combinations — cat×cat / cat×cont / cont×cont across scatter · bar · violin · heatmap',
  covers: 'blend-combinations',
  Component: BlendCombinationsStory,
})
