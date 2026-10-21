// viewAsTable.story.tsx — the "view as table" accessibility affordance (ITEM-60 / TEST-77).
// A GPU box plot is opaque to a screen reader, so the story pairs the chart with a toggle
// (`viz-view-as-table-toggle`) that reveals a REAL semantic `<table>` (`viz-data-table`)
// carrying the SAME aggregated numbers the box plot draws. The table is built from
// `boxStatsFromColumn` — the exact CPU oracle `BoxView` renders (its GPU path falls back to
// it) — so the row per group shows that group's Q1/Median/Q3/fences, plus N.

import { useEffect, useMemo, useState } from 'react'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { BoxView, boxStatsFromColumn } from '../../viz-core/charts/BoxView'
import { DataTableView } from '../../viz-core/a11y/DataTableView'
import { boxStatsToTable, type BoxTableRow, type TableModel } from '../../viz-core/a11y/chartTableModel'
import { LIGHT_THEME, DARK_THEME, type VizTheme } from '../../viz-core/theme'
import { registerStory } from '../registry'

const FIXTURE = { seed: 7, pointCount: 20_000 } as const
const VALUE_KEY = 'Feature A'
const GROUP_KEY = 'group'

/** Read the showcase's active theme (published by ShowcaseApp) → a viz-core `VizTheme`. */
function useVizTheme(): VizTheme {
  const [name, setName] = useState<'light' | 'dark'>(
    () => (typeof window !== 'undefined' ? window.__VIZ_THEME__ ?? 'light' : 'light'),
  )
  useEffect(() => {
    const id = window.setInterval(() => setName(window.__VIZ_THEME__ ?? 'light'), 300)
    return () => window.clearInterval(id)
  }, [])
  return name === 'dark' ? DARK_THEME : LIGHT_THEME
}

function ViewAsTableStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  const theme = useVizTheme()
  const [showTable, setShowTable] = useState(false)
  const [model, setModel] = useState<TableModel | null>(null)

  // Build the table from the SAME fixture column the box plot renders: exact per-group Tukey
  // box stats (`boxStatsFromColumn`) + the per-group point count N.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [col, cat] = await Promise.all([
        source.valueColumn(VALUE_KEY),
        source.categorical(GROUP_KEY),
      ])
      if (!alive) return
      const stats = boxStatsFromColumn(col, cat)
      const counts = new Array<number>(cat.categories.length).fill(0)
      for (let i = 0; i < cat.codes.length; i++) {
        const g = cat.codes[i]
        if (g < counts.length) counts[g]++
      }
      const rows: BoxTableRow[] = stats.map((s, g) => ({
        group: s.group,
        n: counts[g],
        q1: s.q1,
        median: s.median,
        q3: s.q3,
        lowerFence: s.lowerFence,
        upperFence: s.upperFence,
      }))
      setModel(boxStatsToTable(rows))
    })()
    return () => {
      alive = false
    }
  }, [source])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 4px' }}>
        <button
          type="button"
          data-testid="viz-view-as-table-toggle"
          aria-pressed={showTable}
          onClick={() => setShowTable(v => !v)}
          style={{
            fontSize: 13,
            padding: '4px 12px',
            cursor: 'pointer',
            color: theme.fg,
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
          }}
        >
          {showTable ? 'View as chart' : 'View as table'}
        </button>
        <span style={{ fontSize: 12, color: theme.muted }}>
          {showTable
            ? 'Screen-reader-accessible table of the box plot’s aggregated statistics.'
            : 'Box plot — feature “' + VALUE_KEY + '” by group. Toggle a tabular, accessible view.'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {showTable ? (
          model ? (
            <DataTableView
              model={model}
              caption={`Box-plot statistics for ${VALUE_KEY} by group`}
              theme={theme}
              data-testid="viz-data-table"
            />
          ) : (
            <div style={{ padding: 16, color: theme.muted }}>Aggregating…</div>
          )
        ) : (
          <BoxView source={source} valueKey={VALUE_KEY} groupKey={GROUP_KEY} />
        )}
      </div>
    </div>
  )
}

registerStory({
  // Neither 'Accessibility' nor 'Charts' is a valid StoryCategory; the sibling a11y story
  // lives under 'Controls', so this accessibility affordance is filed there too.
  id: 'view-as-table',
  category: 'Controls',
  title: 'Accessibility — view a stat chart as a semantic data table',
  covers: 'view-as-table',
  Component: ViewAsTableStory,
})
