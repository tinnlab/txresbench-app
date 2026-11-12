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
 *   move (EXAMPLE-UL-8). The WHOLE row (box AND its text label) is the
 *   toggle target — a text click reports the same toggle as the box
 *   (RES-22: the text click used to do nothing);
 * - the search placeholder is the board's byte ("Find a model or run");
 *   the sort control is the board's "Sort by" label + select.
 */
import { Button, Checkbox, Input, Select } from '@txresbench/kit'
import type { TxrFilterChip, TxrListRow, TxrSearchControl, TxrSortControl } from '../types'

export interface TxrListFilterBarProps {
  /** The rows the list received (the bar counts over exactly these). */
  rows: ReadonlyArray<TxrListRow>
  /** The host's selection set (the select-all's checked state derives from it). */
  selected: ReadonlySet<string>
  /** The host-controlled chips (group / model-kind / outcome). */
  filterChips?: ReadonlyArray<TxrFilterChip>
  /** The built-in "All N" pill's wiring (CM-3): absent = the board's inert
   *  count chip (the D/I screens keep it); present = a real filter — `active`
   *  is the host's state (highlighted exactly when NO filter is on) and
   *  `onClick` is the host's clear-to-all (clears the group filter AND the
   *  can-run filter — the QA's "All = no filter, All highlighted only when
   *  no filter"). */
  allFilter?: { active: boolean; onClick(): void }
  /** The built-in "Can run N" pill's wiring: `active` = the can-run-only
   *  filter is on; `onClick` toggles it. */
  canRunFilter?: { active: boolean; onClick(): void }
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
  background: 'var(--txr-surface)',
  color: 'var(--txr-text-2)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-border)',
} as const

const ACTIVE_CHIP = {
  ...BUILT_IN_CHIP,
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
  borderColor: 'var(--txr-brand)',
} as const

/** One built-in pill: the host-wired chip (a real button with the pressed
 *  look) or the inert count span (previous D/I behavior). */
function BuiltInChip({
  testId,
  label,
  count,
  wired,
}: {
  testId: string
  label: string
  count: number
  wired?: { active: boolean; onClick(): void }
}) {
  if (wired === undefined) {
    return (
      <span data-testid={testId} style={ACTIVE_CHIP}>
        {label} {count}
      </span>
    )
  }
  return (
    <Button
      data-testid={testId}
      variant="outline"
      className="rounded-full font-normal"
      style={{ ...(wired.active ? ACTIVE_CHIP : BUILT_IN_CHIP), height: 'auto' }}
      aria-pressed={wired.active}
      onClick={wired.onClick}
    >
      {label} {count}
    </Button>
  )
}

export function TxrListFilterBar({
  rows,
  selected,
  filterChips,
  allFilter,
  canRunFilter,
  search,
  sort,
  onToggleAllCanRun,
}: TxrListFilterBarProps) {
  const canRunCount = rows.filter(row => !row.run.disabled).length
  const allCanRunSelected =
    canRunCount > 0 && rows.every(row => row.run.disabled || selected.has(row.key))
  return (
    <div
      className="txr-list-filter-bar"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
    >
      <BuiltInChip testId="txr-list-filter-all" label="All" count={rows.length} wired={allFilter} />
      <BuiltInChip
        testId="txr-list-filter-can-run"
        label="Can run"
        count={canRunCount}
        wired={canRunFilter}
      />
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
      {/* The label IS the toggle: a text click activates the box natively
          (RES-22 — the text used to be a dead span). The checkbox's own
          change handler reports the same toggle, so one click = one report. */}
      <label
        data-testid="txr-list-select-all-label"
        style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
      >
        <Checkbox
          data-testid="txr-list-select-all-can-run"
          className="txr-list-checkbox"
          aria-label="Select all that can run"
          checked={allCanRunSelected}
          onCheckedChange={() => onToggleAllCanRun?.()}
        />
        <span style={{ fontSize: 13.5 }}>Select all that can run</span>
      </label>
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
