import * as Plot from '@observablehq/plot'
import { useEffect, useRef } from 'react'
import type { TimeSeriesPoint } from './TimeSeriesChart'

/**
 * The Observable-Plot drawing surface for `TimeSeriesChart`, split into its own module so the
 * ~340 kB of `@observablehq/plot` (plus a dozen `d3-*` packages, incl. `d3-geo`) is reached
 * only through a dynamic import.
 *
 * WHY the split: `TimeSeriesChart` is rendered by `JobDetail`, which is inside `JobsDrawer`,
 * which the jobs module registers as an ALWAYS-MOUNTED global `appBanners` slot component
 * ("renders nothing until opened"). Mounting it always means its import graph is eager, so a
 * charting library that only draws inside an opened job's detail panel was being downloaded
 * and parsed on the login screen.
 *
 * The chart CHROME (label, latest value, empty state) stays in the eager wrapper, so the
 * layout is identical before and after this chunk arrives — only the plot marks stream in.
 */
export function TimeSeriesPlot({ data }: { data: TimeSeriesPoint[] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const points = data.map(d => ({ t: new Date(d.t), v: d.v }))

    el.replaceChildren()
    if (points.length === 0) return

    const chart = Plot.plot({
      width: el.clientWidth || 320,
      height: 132,
      marginLeft: 44,
      marginBottom: 22,
      x: { type: 'time', label: null, ticks: 4, grid: false },
      y: { label: null, grid: true, nice: true, zero: true },
      style: { background: 'transparent', color: 'currentColor', fontSize: '10px' },
      marks: [
        Plot.areaY(points, {
          x: 't',
          y: 'v',
          fill: 'currentColor',
          fillOpacity: 0.1,
        }),
        Plot.lineY(points, {
          x: 't',
          y: 'v',
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.2 }),
      ],
    })
    el.append(chart)
    return () => {
      el.replaceChildren()
    }
  }, [data])

  // text-primary drives the Plot marks' currentColor (theme-aware).
  return <div ref={ref} className="w-full text-primary min-h-[132px]" />
}
