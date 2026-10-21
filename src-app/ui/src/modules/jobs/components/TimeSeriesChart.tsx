import { lazy, Suspense } from 'react'

export interface TimeSeriesPoint {
  /** ISO timestamp. */
  t: string
  v: number
}

interface Props {
  data: TimeSeriesPoint[]
  /** Chart title (e.g. "CPU %"). */
  label: string
  /** y-axis unit shown in the title (e.g. "%", "MB"). */
  unit?: string
  'data-testid'?: string
}

/**
 * The Observable-Plot drawing surface, loaded on DEMAND — see `TimeSeriesPlot.tsx` for why.
 * Short version: this component is reached eagerly from the jobs module (JobsDrawer is an
 * always-mounted global slot), so a static `import * as Plot from '@observablehq/plot'` here
 * put ~340 kB of charting + `d3-geo`/`d3-shape` on the login screen's critical path.
 */
const TimeSeriesPlot = lazy(() =>
  import('./TimeSeriesPlot').then(m => ({ default: m.TimeSeriesPlot })),
)

/** Same box the plot occupies, so nothing shifts while its chunk is in flight. */
const PlotBox = () => <div className="w-full text-primary min-h-[132px]" />

/**
 * A small streaming time-series chart. Thin wrapper over **Observable Plot**
 * (the app-wide chart lib, live3's `feat/visualization`) so call sites are
 * lib-agnostic. Theme-aware: the mark colors inherit `currentColor` from the
 * wrapper's `text-primary`, so they adapt to light/dark.
 *
 * With an empty series there is nothing to draw, so the plot chunk is not requested at all —
 * the box and the empty-state note render exactly as before.
 */
export function TimeSeriesChart({ data, label, unit, 'data-testid': testid }: Props) {
  const last = data.length ? data[data.length - 1].v : null

  return (
    <div className="w-full" data-testid={testid}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {last != null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {last.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            {unit ? ` ${unit}` : ''}
          </span>
        )}
      </div>
      {data.length === 0 ? (
        <PlotBox />
      ) : (
        <Suspense fallback={<PlotBox />}>
          <TimeSeriesPlot data={data} />
        </Suspense>
      )}
      {data.length === 0 && (
        <div className="text-xs text-muted-foreground py-6 text-center">
          No samples yet
        </div>
      )}
    </div>
  )
}
