/**
 * TxrOutcomeTabs — the G/H outcome tablist (`BusyResults.dc.html`:
 * "Progression or death by day 238 | Death by day 238"): one kit `Tabs` tab
 * per DISTINCT finished-method task, in the pinned key order
 * (`pfs` → `os` → `response`, DEC-4). The run endpoint's key is the default
 * active tab (the store sets `outcomeTab` on load — this component is
 * controlled, `active` is the store's); the labels are
 * `formatTaskLabel(key, horizon)`, with the response tab's day the run's
 * label day when present, else the run horizon (OWNER-UR-1, confirmed D42).
 *
 * A task that no finished method carries renders NO tab (DEC-4: tabs are
 * derived from the columns, so a "response" tab exists only when a finished
 * response method is on screen); with no finished method at all the strip is
 * absent — the empty state owns the page.
 *
 * The kit `Tabs` root carries `data-testid="txr-results-outcome"` and derives
 * the trigger selectors `${testid}-tab-${key}` (the kit's declared
 * convention), i.e. `txr-results-outcome-tab-pfs|os|response`.
 */
import { Tabs } from '@ziee/kit'
import type { TabItem } from '@ziee/kit'
import type { TxrHeatmapColumn, TxrOutcomeKey } from '../types'
import { formatTaskLabel } from '../lib/format'

/** The pinned tab order — the board's left-to-right survival tabs, the
 *  response tab last (OWNER-UR-1's third tab when present). */
const OUTCOME_ORDER: readonly TxrOutcomeKey[] = ['pfs', 'os', 'response'] as const

export interface TxrOutcomeTabsProps {
  /** The finished method columns (their `task`s are the tab set). */
  columns: ReadonlyArray<TxrHeatmapColumn>
  /** The active tab (the store's `outcomeTab`; the run endpoint's key default). */
  active: TxrOutcomeKey
  /** The run's horizon day (the survival labels' "by day N"). */
  horizon: number
  /** The response task's label day — falls back to `horizon` (OWNER-UR-1). */
  labelDay?: number | null
  onChange: (key: TxrOutcomeKey) => void
}

export function TxrOutcomeTabs({ columns, active, horizon, labelDay, onChange }: TxrOutcomeTabsProps) {
  const present = new Set(columns.map(c => c.task))
  const keys = OUTCOME_ORDER.filter(key => present.has(key))
  if (keys.length === 0) return null
  const responseDay = labelDay ?? horizon
  const items: TabItem[] = keys.map(key => ({
    key,
    label: formatTaskLabel(key, key === 'response' ? responseDay : horizon),
  }))
  return (
    <Tabs
      data-testid="txr-results-outcome"
      items={items}
      value={active}
      onValueChange={value => onChange(value as TxrOutcomeKey)}
      variant="default"
      size="sm"
    />
  )
}
