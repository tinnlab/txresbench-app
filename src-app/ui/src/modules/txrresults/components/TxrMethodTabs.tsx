/**
 * TxrMethodTabs — the H screen's method tablist (`Results.dc.html`: "Compare
 * methods | landmark-cox-current | cox-cutpoint-risk"): one kit `Tabs` with
 * the hand-crafted "Compare methods" tab FIRST (the reserved path word —
 * DEC-2: `compare` is a route segment, never a method id) and one mono tab
 * per finished method, in the run's order.
 *
 * The URL segment selects the active tab (URL-as-view, INV-6): the page
 * reads `:methodId` (or its absence on `/results/compare`) and reports the
 * selection back through `onSelect`, which navigates with the path builders
 * — this component never spells a URL and never holds the selection as
 * local state. An unknown `methodId` maps to the Compare tab (DEC-18: the
 * view reconciles to the fallback, the URL stays as-is).
 *
 * The kit `Tabs` root carries `data-testid="txr-results-method"` and derives
 * the trigger selectors `${testid}-tab-${key}` — so the triggers are
 * `txr-results-method-tab-compare` and `txr-results-method-tab-<methodId>`
 * (the plan's `txr-results-compare-tab` line predates the kit derivation;
 * see DRIFT-1 ITEM-9; same class as the outcome-tabs note in ITEM-6).
 */
import type { ReactNode } from 'react'
import { Tabs } from '@ziee/kit'
import type { TabItem } from '@ziee/kit'
import type { TxrHeatmapColumn } from '../types'

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

const MONO_LABEL: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 13,
  fontWeight: 500,
}

/** The reserved Compare-methods tab's key (never a method id — DEC-2). */
export const METHOD_TAB_COMPARE_KEY = 'compare'

export interface TxrMethodTabsProps {
  /** The finished method columns — one tab per column, in the run's order. */
  columns: ReadonlyArray<TxrHeatmapColumn>
  /** The active method id, or null when the Compare-methods tab is active. */
  activeMethodId: string | null
  /** The tab was selected: null = Compare methods, else the method id. */
  onSelect: (methodId: string | null) => void
}

export function TxrMethodTabs({ columns, activeMethodId, onSelect }: TxrMethodTabsProps) {
  const items: TabItem[] = [
    { key: METHOD_TAB_COMPARE_KEY, label: 'Compare methods' },
    ...columns.map(col => ({
      key: col.methodId,
      label: <span style={MONO_LABEL}>{col.label}</span>,
    })),
  ]
  return (
    <Tabs
      data-testid="txr-results-method"
      items={items}
      value={activeMethodId ?? METHOD_TAB_COMPARE_KEY}
      onValueChange={value =>
        onSelect(value === METHOD_TAB_COMPARE_KEY ? null : value)
      }
      variant="default"
      size="sm"
    />
  )
}
