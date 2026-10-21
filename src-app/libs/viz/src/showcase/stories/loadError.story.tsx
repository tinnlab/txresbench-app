// loadError.story.tsx — the REGRESSION story for the round-2 HIGH fix: a chart View bound
// to a NON-EXISTENT column must render a VISIBLE `<ChartError>` (testid `viz-chart-error`)
// instead of a permanent "Loading…" spinner + an unhandled promise rejection.
//
// `FixtureSource.valueColumn(key)` REJECTS with `fixture has no value column "<key>"` on an
// unknown column; `ViolinView`'s `useAsyncChartData` loader try/catches that rejection and
// renders `<ChartError message={…} />`. This story drives exactly that path so an e2e can
// assert the error cell is shown (see tests/e2e/visualization/load-error.spec.ts). Category
// 'States'; `covers: 'load-error'` names the state for the story-completeness gate.

import { useMemo } from 'react'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { ViolinView } from '../../viz-core/charts/ViolinView'
import { registerStory } from '../registry'

const FIXTURE = { seed: 7, pointCount: 5_000 } as const

/** Full-height demo pane wrapper (matches charts.story.tsx). */
function Pane({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', minHeight: 0 }}>{children}</div>
}

/**
 * A ViolinView bound to a value column that the fixture does NOT have. The loader's
 * `source.valueColumn('__no_such_column__')` rejects, `useAsyncChartData` catches it, and the
 * View renders `<ChartError>` — a visible failure cell, never a hung spinner.
 */
function LoadErrorStory() {
  const source = useMemo(() => new FixtureSource(FIXTURE), [])
  return (
    <Pane>
      <ViolinView source={source} valueKey="__no_such_column__" groupKey="group" />
    </Pane>
  )
}

registerStory({
  id: 'viz-load-error',
  category: 'States',
  title: 'Load error — bad column binding renders a visible ChartError (not a hung spinner)',
  covers: 'load-error',
  Component: LoadErrorStory,
})
