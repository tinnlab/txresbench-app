/**
 * TxrListFilterBar — the boards' filter row above the list: the built-in
 * "All N" / "Can run N" count chips, the host-controlled chips
 * (group chips on E, model-kind chips on D, outcome chips on I — DEC-9),
 * the optional search (screen I's find-a-model box) and the sort select
 * (D/I), and the built-in "Select all that can run" toggle.
 *
 * DEC-9 is the split this bar implements: the counts and the
 * select-all-that-can-run are BUILT-IN (identical on the three boards),
 * everything else — group/kind/outcome chips, search, sort — is
 * host-controlled state through `TxrFilterChip` / `TxrSearchControl` /
 * `TxrSortControl`. The component NEVER filters the row set: the host
 * passes the rows already pre-filtered and computes the counts the bar
 * displays over them; a host chip's `onToggle` is the host's filter
 * predicate.
 *
 * Board-copy facts (DEC-8/DEC-12):
 * - the built-in chips are count chips — "All <N>" in the board's pressed
 *   look (the default view is everything), "Can run <N>" over the
 *   non-disabled rows, N computed from the rows the bar received;
 * - "Select all that can run" is a toggle: checked ⇔ every non-disabled
 *   row is selected, a change reports the toggle — the host applies
 *   `lib/selection.ts`'s `toggleAllCanRun`, so the `cannot` rows never
 *   move (EXAMPLE-UL-8);
 * - the search placeholder is the board's byte ("Find a model or run");
 *   the sort control is the board's "Sort by" label + select.
 */
import { Button, Checkbox, Input, Select } from '@ziee/kit'
import type { TxrFilterChip, TxrListRow, TxrSearchControl, TxrSortControl } from '../types'

export interface TxrListFilterBarProps {
  /** The rows the list received (the bar counts over exactly these). */
  rows: ReadonlyArray<TxrListRow>
  /** The host's selection set (the select-all's checked state derives from it). */
  selected: ReadonlySet<string>
  /** The host-controlled chips (group / model-kind / outcome). */
  filterChips?: ReadonlyArray<TxrFilterChip>
  /** The find-a-model box (screen I), or `null` for no search. */
  search?: TxrSearchControl | null
  /** The sort control (screens D/I), or `null` for no sort. */
  sort?: TxrSortControl | null
  /** "Select all that can run" toggled (the host applies `toggleAllCanRun`). */
  onToggleAllCanRun?: () => void
}

/** The built-in count chips' looks (the boards' pressed/unpressed pill). */
const BUILT_IN_CHIP = {
  borderRadius: 999,
  padding: '5px 12px',
  fontSize: 13.5,
  background: '#ffffff',
  color: '#3a3a3a',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#cfcdc7',
} as const

const ACTIVE_CHIP = {
  ...BUILT_IN_CHIP,
  background: '#e8eef6',
  color: '#143a68',
  borderColor: '#1d4e89',
} as const

export function TxrListFilterBar({
  rows,
  selected,
  filterChips,
  search,
  sort,
  onToggleAllCanRun,
}: TxrListFilterBarProps) {
  const canRunCount = rows.filter(row => !row.run.disabled).length
  const allCanRunSelected =
    canRunCount > 0 && rows.every(row => row.run.disabled || selected.has(row.key))
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <span data-testid="txr-list-filter-all" style={ACTIVE_CHIP}>
        All {rows.length}
      </span>
      <span data-testid="txr-list-filter-can-run" style={BUILT_IN_CHIP}>
        Can run {canRunCount}
      </span>
      {filterChips?.map(chip => (
        <Button
          key={chip.id}
          data-testid={`txr-list-filter-${chip.id}`}
          variant="outline"
          className="rounded-full font-normal"
          style={{ ...(chip.active ? ACTIVE_CHIP : BUILT_IN_CHIP), height: 'auto' }}
          aria-pressed={chip.active}
          onClick={chip.onToggle}
        >
          {chip.label} {chip.count}
        </Button>
      ))}
      {search ? (
        <Input
          data-testid="txr-list-search"
          type="search"
          placeholder="Find a model or run"
          aria-label="Find a model or run"
          value={search.value}
          onChange={event => search.onChange(event.target.value)}
          style={{ width: 190 }}
          allowStyle
        />
      ) : null}
      <span style={{ flexGrow: 1 }} />
      <Checkbox
        data-testid="txr-list-select-all-can-run"
        aria-label="Select all that can run"
        checked={allCanRunSelected}
        onCheckedChange={() => onToggleAllCanRun?.()}
      />
      <span style={{ fontSize: 13.5 }}>Select all that can run</span>
      {sort ? (
        <label style={{ fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }}>
          Sort by
          <Select
            data-testid="txr-list-sort"
            aria-label="Sort"
            size="sm"
            options={sort.options.map(option => ({ value: option.value, label: option.label }))}
            value={sort.value}
            onValueChange={sort.onChange}
          />
        </label>
      ) : null}
    </div>
  )
}
