// heatmap-matrix.story.tsx — the matrix-as-multiscale-image HEATMAP view-kind showcase.
// Renders a 50-row × 200,000-column synthetic matrix as a GPU image via `MatrixHeatmapView`:
// the zoom picks the pyramid level (≈ 1 texel per screen pixel), value → colormap in-shader,
// empty bins are transparent, and a visualMap-style value-range control (dual sliders) drives
// a filter-aware pyramid recompute. A live hovered-cell readout + a reset button round it out.
// State is mirrored to window.__VIZ_TEST__ for the visual/e2e harness. Follows the
// spatial-segmentation.story.tsx conventions.
//
// The row/column labels here are readable DEMO labels only — the viz-core API is domain-
// agnostic (rows × columns of scalar values); the story is free to name them for legibility.

import { useEffect, useMemo, useState } from 'react'
import { MatrixHeatmapView, type HoveredMatrixCell } from '../../viz-core/heatmap-matrix/MatrixHeatmapView'
import { makeMatrixFixture } from '../../viz-core/heatmap-matrix/matrixFixture'
import { VALUE_MAX, VALUE_MIN } from '../../viz-core/heatmap-matrix/matrixTypes'
import { registerStory } from '../registry'

const ROWS = 50
const COLS = 200_000

function HeatmapMatrixStory() {
  const base = useMemo(() => makeMatrixFixture({ rows: ROWS, cols: COLS, seed: 7 }), [])

  const [filterLo, setFilterLo] = useState(VALUE_MIN)
  const [filterHi, setFilterHi] = useState(VALUE_MAX)
  const [hovered, setHovered] = useState<HoveredMatrixCell | null>(null)
  const [level, setLevel] = useState(0)
  const [visibleCols, setVisibleCols] = useState(0)

  // A filter is "active" only when it narrows the full domain; full-range ⇒ no filter object
  // (so buildPyramid takes the fast unfiltered path + nothing is discarded).
  const filterActive = filterLo > VALUE_MIN || filterHi < VALUE_MAX
  const filter = useMemo(
    () => (filterActive ? { lo: filterLo, hi: filterHi } : undefined),
    [filterActive, filterLo, filterHi],
  )

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      level,
      hoveredCell: hovered,
      filterLo,
      filterHi,
      visibleCols,
    }
  }, [level, hovered, filterLo, filterHi, visibleCols])

  const resetFilter = () => {
    setFilterLo(VALUE_MIN)
    setFilterHi(VALUE_MAX)
  }

  // keep lo <= hi as the two sliders move.
  const onLo = (v: number) => setFilterLo(Math.min(v, filterHi))
  const onHi = (v: number) => setFilterHi(Math.max(v, filterLo))

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="viz-heatmap-matrix"
    >
      <div style={{ padding: 8, opacity: 0.6 }}>
        GPU matrix heatmap — {ROWS} rows × {COLS.toLocaleString()} columns as a multiscale image ·
        zoom picks the pyramid level · value→colormap in-shader · empty bins transparent · drag
        the value range to filter
      </div>

      <div
        style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '4px 8px', fontSize: 12 }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          min
          <input
            type="range"
            min={VALUE_MIN}
            max={VALUE_MAX}
            step={1}
            value={filterLo}
            onChange={e => onLo(Number(e.target.value))}
            aria-label="value range min"
            data-testid="viz-heatmap-filter-lo"
          />
          <span data-testid="viz-heatmap-filter-lo-value" style={{ width: 26 }}>
            {filterLo}
          </span>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          max
          <input
            type="range"
            min={VALUE_MIN}
            max={VALUE_MAX}
            step={1}
            value={filterHi}
            onChange={e => onHi(Number(e.target.value))}
            aria-label="value range max"
            data-testid="viz-heatmap-filter-hi"
          />
          <span data-testid="viz-heatmap-filter-hi-value" style={{ width: 26 }}>
            {filterHi}
          </span>
        </label>
        <button
          type="button"
          onClick={resetFilter}
          disabled={!filterActive}
          data-testid="viz-heatmap-reset-filter"
        >
          Reset filter
        </button>
        <span style={{ opacity: 0.6 }} data-testid="viz-heatmap-level-readout">
          level {level} · ~{visibleCols.toLocaleString()} cols visible
        </span>
        <span data-testid="viz-heatmap-hover-readout">
          {hovered
            ? `row ${hovered.row}, col ${hovered.col} = ${hovered.value} (cov ${hovered.coverage})`
            : 'hover a cell —'}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <MatrixHeatmapView
          base={base}
          filter={filter}
          onHoverCell={setHovered}
          onLodChange={info => {
            setLevel(info.level)
            setVisibleCols(info.visibleCols)
          }}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'heatmap-matrix',
  category: 'View kinds',
  title: 'Matrix heatmap — GPU multiscale image (zoom→level · value→colormap · range filter)',
  covers: 'heatmap-matrix',
  Component: HeatmapMatrixStory,
})
