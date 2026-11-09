/**
 * TxrMethodFilterBar — the G results' search/sort/methods row
 * (`BusyResults.dc.html`): the "Find a patient" search, the "Sort by" select
 * (the board's three options), the "Methods" select (All N / one option per
 * present group with its count / "Choose methods…" — which opens a kit
 * `MultiSelect` of the individual method ids) and the 0–100 % "Chance of
 * failure" legend.
 *
 * The bar is presentational and NEVER filters: `columns` are the finished
 * method columns the picker operates on (the active outcome tab's set — the
 * page's `viewOf(...).columns` at the unfiltered picker state), the counts
 * derive from them, and every change is reported through the callbacks (the
 * host's store applies them, DEC-5/6).
 *
 * The picker state model (the store's `methodFilter:
 * {groups, methodIds} | null`):
 * - "All N" → `null` (no restriction);
 * - a group option → `{groups: [group], methodIds: []}`;
 * - "Choose methods…" mode → `{groups: [], methodIds: [...]}`; the
 *   MultiSelect is shown while the mode is active (an empty hand-picked set
 *   is the All state — `viewOf`'s rule — and flips the mode back to All).
 * A mode switch replaces the other mode's selection (the board's single
 * picker holds one mode at a time).
 *
 * Copy facts (board-verbatim): the search input's hint text and
 * accessible name are the board's "Find a patient"; the sort label is
 * "Sort by" (the select's aria-label "Sort patients"); the methods label is
 * "Methods" (the select's aria-label "Which methods to show"; the option
 * labels "All N", "<Group> (<count>)", "Choose methods…" — method-group
 * labels + counts are data, the board's numbers are examples); the legend
 * reads "Chance of failure" + the alpha gradient + "0 to 100%" on the pfs
 * tab and the same board words for the other outcome tabs ("Chance of
 * death", "Chance of no response" — RES-04: the no-response tab must never
 * read "failure").
 */
import type { CSSProperties } from 'react'
import { Input, MultiSelect, Select } from '@ziee/kit'
import type { TxrHeatmapColumn, TxrOutcomeKey, TxrSortKey } from '../types'
import { LEGEND_LABEL } from '../lib/format'

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }
const LABEL: CSSProperties = { fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }
const LEGEND: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12.5,
  color: 'var(--txr-muted)',
  marginLeft: 'auto',
}
const LEGEND_GRADIENT: CSSProperties = {
  display: 'inline-block',
  width: 120,
  height: 10,
  borderRadius: 3,
  background:
    'linear-gradient(to right, rgba(var(--txr-chance-rgb), 0.04), rgba(var(--txr-chance-rgb), 0.9))',
}

export interface TxrMethodFilter {
  groups: string[]
  methodIds: string[]
}

export interface TxrMethodFilterBarProps {
  /** The finished columns the picker filters (the active outcome tab's set). */
  columns: ReadonlyArray<TxrHeatmapColumn>
  /** The active picker state (`null` = All). */
  filter: TxrMethodFilter | null
  /** The "Find a patient" value. */
  search: string
  /** The active "Sort by" option. */
  sort: TxrSortKey
  /** The active outcome tab — the legend's "Chance of …" word (RES-04). */
  outcome: TxrOutcomeKey
  onFilterChange: (filter: TxrMethodFilter | null) => void
  onSearchChange: (search: string) => void
  onSortChange: (sort: TxrSortKey) => void
}

const SORT_OPTIONS = [
  { value: 'average-desc', label: 'Average chance, highest first' },
  { value: 'disagree', label: 'Methods disagree most' },
  { value: 'patient', label: 'Patient' },
] as const

/** The methods picker's special values (never a group id). */
const ALL_VALUE = '__all__'
const CHOOSE_VALUE = '__choose__'

/**
 * The active mode the picker select shows for the current filter state. The
 * three modes are exactly the three shapes the UI produces (All → null, a
 * group → `{groups:[g], methodIds:[]}`, Choose → `{groups:[],
 * methodIds:[...]}`); the Choose mode's EMPTY pick shape
 * (`{groups:[], methodIds:[]}`) is the mode's marker — the moment the user
 * opens it with nothing hand-picked yet — and `viewOf` treats an empty
 * restriction as All, so the heatmap shows every column while the picker is
 * open.
 */
function pickerValueOf(filter: TxrMethodFilter | null): string {
  if (filter === null) return ALL_VALUE
  if (filter.methodIds.length > 0) return CHOOSE_VALUE
  if (filter.groups.length === 1) return filter.groups[0]
  return filter.groups.length === 0 ? CHOOSE_VALUE : ALL_VALUE
}

/** The present groups in the columns' first-appearance order, with counts. */
function groupOptions(columns: ReadonlyArray<TxrHeatmapColumn>): { value: string; label: string }[] {
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const column of columns) {
    if (seen.has(column.group)) continue
    seen.add(column.group)
    const count = columns.filter(c => c.group === column.group).length
    options.push({ value: column.group, label: `${column.groupLabel} (${count})` })
  }
  return options
}

/** One method-id option per column, in the column order (never reordered). */
function methodOptions(columns: ReadonlyArray<TxrHeatmapColumn>): { value: string; label: string }[] {
  return columns.map(column => ({ value: column.methodId, label: column.label }))
}

export function TxrMethodFilterBar({
  columns,
  filter,
  search,
  sort,
  outcome,
  onFilterChange,
  onSearchChange,
  onSortChange,
}: TxrMethodFilterBarProps) {
  const pickerValue = pickerValueOf(filter)
  const chooseMode = pickerValue === CHOOSE_VALUE
  return (
    <div data-testid="txr-results-filter" className="txr-results-filter" style={ROW}>
      <Input
        data-testid="txr-results-search"
        type="search"
        placeholder="Find a patient"
        aria-label="Find a patient"
        value={search}
        onChange={event => onSearchChange(event.target.value)}
        style={{ width: 170 }}
        allowStyle
      />
      <label style={LABEL}>
        Sort by
        <Select
          data-testid="txr-results-sort"
          aria-label="Sort patients"
          size="sm"
          options={[...SORT_OPTIONS]}
          value={sort}
          onValueChange={value => onSortChange(value as TxrSortKey)}
        />
      </label>
      <label style={LABEL}>
        Methods
        <Select
          data-testid="txr-results-methods"
          aria-label="Which methods to show"
          size="sm"
          options={[
            { value: ALL_VALUE, label: `All ${columns.length}` },
            ...groupOptions(columns),
            { value: CHOOSE_VALUE, label: 'Choose methods…' },
          ]}
          value={pickerValue}
          onValueChange={value => {
            if (value === ALL_VALUE) onFilterChange(null)
            else if (value === CHOOSE_VALUE) onFilterChange({ groups: [], methodIds: [] })
            else onFilterChange({ groups: [value], methodIds: [] })
          }}
        />
      </label>
      {chooseMode ? (
        <MultiSelect
          data-testid="txr-results-methods-multi"
          aria-label="Which methods to show"
          options={methodOptions(columns)}
          value={filter?.methodIds ?? []}
          onValueChange={methodIds =>
            onFilterChange(methodIds.length > 0 ? { groups: [], methodIds } : null)
          }
          placeholder="Choose methods…"
          searchPlaceholder="Find a method"
          emptyText="No method matches"
          removeLabel={label => `Remove ${label}`}
        />
      ) : null}
      <span data-testid="txr-results-legend" style={LEGEND}>
        {LEGEND_LABEL[outcome]}
        <span aria-hidden style={LEGEND_GRADIENT} />
        {' '}0 to 100%
      </span>
    </div>
  )
}
