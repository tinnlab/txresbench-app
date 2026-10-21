// VisualMap.tsx — the continuous draggable value→color BAR (the ECharts "bar scale",
// DEC-30 / ELEMENT_VOCABULARY visualMap-continuous). A CSS-gradient rail (built from a
// colormap) + two `DragRail` handles emit a `[lo,hi]` range; the consumer feeds that to
// a deck.gl `DataFilterExtension.filterRange` so the scatter filters to the value range
// entirely on the GPU (DEC-26: interaction = a GPU filter uniform, zero per-frame CPU).
//
// `visualMapFilterProps(range)` is the shared helper that produces the deck.gl filter
// props ({getFilterValue, filterRange, extensions:[DataFilterExtension({filterSize:1})]}).

import { useContext } from 'react'
import { DataFilterExtension } from '@deck.gl/extensions'
import { colorbarDescriptor, type ContinuousColormap } from '../data/color'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { DragRail } from './DragRail'
import { VizEventBusContext } from '../events/EventBusContext'
import { useRafCommit } from '../core/useRafCommit'
import { useStore } from 'zustand'
import { useVizStores } from '../../adapter/vizStores'

export interface VisualMapProps {
  readonly min: number
  readonly max: number
  readonly colormap: ContinuousColormap
  /** Current [lo, hi] value range (lo ≤ hi). */
  readonly value: readonly [number, number]
  readonly onChange: (range: [number, number]) => void
  /**
   * OPTIONAL filter id (EVENT_API_PLAN Phase 2 `filter`). When set AND a `<Viz>` event bus is in
   * context, every range change ALSO fans a typed `filter` event `{ id, column?, range }`, rAF-
   * coalesced (the shared throttle). Absent / no bus ⇒ no event (byte-identical). `onChange` fires
   * unconditionally either way. `filterColumn` labels the event with the bound data column.
   */
  readonly filterId?: string
  readonly filterColumn?: string
  readonly length?: number
  /** Reverse the gradient (high value at the bottom). Default false. */
  readonly reverse?: boolean
  /** Theme-aware chrome colors (labels, strip border, handles). Default LIGHT_THEME. */
  readonly theme?: VizTheme
  readonly 'data-testid'?: string
}

/** The deck.gl filter props for a visualMap `[lo,hi]` range. `getFilterValue` defaults
 *  to a per-index passthrough; a consumer usually supplies a binary `getFilterValue`
 *  attribute on the layer `data` (which takes precedence) and just spreads
 *  `filterRange` + `extensions` from here. `filterSize:1` = a single numeric filter. */
export function visualMapFilterProps(
  range: readonly [number, number],
  getFilterValue?: (d: unknown, info: { index: number }) => number,
): {
  getFilterValue: (d: unknown, info: { index: number }) => number
  filterRange: [number, number]
  extensions: DataFilterExtension[]
} {
  const lo = Math.min(range[0], range[1])
  const hi = Math.max(range[0], range[1])
  return {
    getFilterValue: getFilterValue ?? ((_d, info) => info.index),
    filterRange: [lo, hi],
    extensions: [new DataFilterExtension({ filterSize: 1 })],
  }
}

/** The continuous value→color bar with two draggable range clamps. */
export function VisualMap({
  min,
  max,
  colormap,
  value,
  onChange,
  filterId,
  filterColumn,
  length = 200,
  reverse = false,
  theme = LIGHT_THEME,
  'data-testid': testId = 'viz-visualmap',
}: VisualMapProps) {
  const stops = colorbarDescriptor(colormap, [min, max]).stops
  // The active plot-interaction store from context (the module singleton when unprovided), so a
  // per-instance `<Viz>` keeps its filter ranges in ITS OWN store (VIZ_ISOLATION W2).
  const plotInteraction = useVizStores().plotInteraction
  // Commit a range change: `onChange` always fires; ADDITIVELY, when a `<Viz>` bus + a `filterId`
  // are present, fan a typed `filter` event, rAF-coalesced so a drag storm becomes one event/frame.
  const bus = useContext(VizEventBusContext)
  const emitFilter = useRafCommit((range: [number, number]) => {
    bus?.emit({ type: 'filter', id: filterId ?? '', column: filterColumn, range })
  })
  // rAF-coalesce the STORE write too (mirrors the DataZoom twin's `commitWin`) so a pointermove
  // storm becomes one `filters[filterId]` write per frame — the object identity churns once/frame,
  // not once/move (matters the moment any wider subtree subscribes to the `filters` map).
  const commitFilter = useRafCommit((range: [number, number]) => {
    if (filterId != null && filterId !== '') plotInteraction.getState().setFilter(filterId, range)
  })
  // SESSION_STATE_PLAN Phase 2: LIFT the filter RANGE into `PlotInteraction.store`. OPT-IN via a
  // stable `filterId`: when set, the store is the range's HOME (so capture/restore round-trips it)
  // — the store value takes precedence over the `value` prop (which becomes the initial/fallback).
  // Without a `filterId` the component is byte-identical (pure controlled `value`/`onChange`); the
  // store starts empty, so even WITH a `filterId` the first render equals `value` and a subsequent
  // `onChange` keeps the parent in sync. Read reactively so a restore that writes the store moves
  // the rail.
  const storeMode = filterId != null && filterId !== ''
  const storedRange = useStore(plotInteraction, s =>
    storeMode ? s.filters[filterId] : undefined,
  ) as readonly [number, number] | undefined
  const effectiveValue: readonly [number, number] = storeMode ? (storedRange ?? value) : value
  const handleChange = (range: [number, number]) => {
    if (storeMode) commitFilter(range)
    onChange(range)
    if (bus && filterId != null) emitFilter(range)
  }
  // vertical DragRail: bottom = min, top = max → gradient runs "to top".
  const ordered = reverse ? [...stops].reverse() : stops
  const gradient = `linear-gradient(to top, ${ordered.join(', ')})`

  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toExponential(1) : v.toFixed(2))

  return (
    <div
      data-testid={testId}
      style={{ display: 'flex', gap: 8, alignItems: 'stretch', height: length }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 11, color: theme.muted }}>
        <span data-testid={`${testId}-max`}>{fmt(effectiveValue[1])}</span>
        <span data-testid={`${testId}-min`}>{fmt(effectiveValue[0])}</span>
      </div>
      <DragRail
        min={min}
        max={max}
        value={effectiveValue}
        onChange={handleChange}
        orientation="vertical"
        length={length}
        thickness={20}
        theme={theme}
        data-testid={`${testId}-rail`}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 3,
            border: `1px solid ${theme.border}`,
            background: gradient,
          }}
        />
      </DragRail>
    </div>
  )
}
