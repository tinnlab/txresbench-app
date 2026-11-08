/**
 * TxrSelectList — the ONE shared selectable list of the E, D and I
 * screens (INV-1), composed from the module's pieces: the filter/search/
 * sort bar, the windowed row stream, and the boards' sticky bottom bar.
 *
 * ANATOMY (per the boards):
 * - the filter bar (`TxrListFilterBar`) sits on top: built-in "All N" /
 *   "Can run N" count chips, the host chips, the optional search/sort, the
 *   built-in "Select all that can run";
 * - the row stream is VIRTUALIZED (@tanstack/react-virtual inside the kit
 *   `ScrollArea`, DEC-18): one fixed row height per the board row layout
 *   (`TXRLIST_ROW_HEIGHT`) and one for the run-group headers — initial
 *   render is the viewport window + overscan, never the whole set, and no
 *   "Showing N of M" chrome (the count chips carry the counts);
 * - screen I's `sections` render as grouped runs: each section's header
 *   (title, run facts, select-all, host actions — `TxrListSectionHeader`)
 *   followed by its rows, in the order the host's (sorted) rows carry
 *   them; a section emptied by the host's filter renders no header
 *   (an empty group is noise, not a run);
 * - the bottom bar (`TxrListBottomBar`) is pinned to the bottom.
 *
 * CONTROLLED selection (DEC-3): the host owns the `selected` set and the
 * selection transitions. The piece-level changes are wired to the ONE
 * `lib/selection.ts` rule set — every change the subcomponents report is
 * turned into the next set HERE, so the host's `onSelectionChange` is the
 * only callback it must handle and no other component (row, section
 * header, bar) needs to know the rule set:
 * - a row checkbox → `toggle(selected, row)` (disabled rows never move);
 * - the filter bar's "Select all that can run" → `toggleAllCanRun`;
 * - a section's select-all → `toggleSection` (exactly the section's
 *   non-disabled `rowKeys`; EXAMPLE-UL-4's 9 of 11);
 * - the Run button → `bottomBar.onRun(runKeys, opts)` where `runKeys` is
 *   the selection minus the rows THIS list can see are disabled — the
 *   stale key of a row that became `cannot` is never handed to the
 *   engine, while a key of a row currently filtered OUT is kept (the
 *   run is the selection, never the view; DEC-9).
 *
 * STATES (EXAMPLE-UL-7):
 * - `loading` with no rows → `txr-list-loading` skeletons (the first
 *   load); `loading` with rows kept (a refetch) leaves the rows visible
 *   — the hooks keep the last good rows for exactly this case;
 * - `error` with no rows → `txr-list-error` + the Retry button
 *   (`onRetry`); `error` with rows — a failed refetch — leaves the rows
 *   visible too (stale-but-present is better than a blank list);
 * - zero rows, no loading, no error → `txr-list-empty` + `emptyText`
 *   (default "No <itemLabel>s to show" — the boards never show this
 *   state, so the fallback is a module constant, never blank).
 *
 * The list itself is width-flexible: rows wrap at narrow widths (the
 * board's flex-wrap row, EXAMPLE-UL-6) and the virtualizer MEASURES what
 * it actually rendered (`measureElement`), so a wrapped row corrects the
 * fixed estimate instead of overlapping the next one.
 */
import { useCallback, useState, type CSSProperties } from 'react'
import { observeElementOffset, useVirtualizer } from '@tanstack/react-virtual'
import { Button, ScrollArea, Skeleton } from '@ziee/kit'
import type {
  TxrFilterChip,
  TxrListRow,
  TxrListSection,
  TxrSearchControl,
  TxrSortControl,
} from '../types'
import { toggle, toggleAllCanRun, toggleSection } from '../lib/selection'
import { pluralize } from '../lib/format'
import { TxrListRowView } from './TxrListRow'
import { TxrListSectionHeader } from './TxrListSectionHeader'
import { TxrListFilterBar } from './TxrListFilterBar'
import { TxrListBottomBar } from './TxrListBottomBar'

/** The one fixed row height the window estimates (the board row: 10px 16px
 *  padding, two 13px lines, 1–2px border — the module's fixed paddings and
 *  the kit controls' fixed heights make it deterministic). */
export const TXRLIST_ROW_HEIGHT = 56

/** The screen-I run-group header height (8px 4px padding + the title line). */
export const TXRLIST_SECTION_HEADER_HEIGHT = 46

/** The overscan on each side of the viewport window (the kit's own list precedent). */
export const TXRLIST_OVERSCAN = 6

/** The count of skeleton rows a loading list shows (a screenful + overscan). */
const TXRLIST_SKELETON_ROWS = 6

export interface TxrSelectListBottomBar {
  /** The "N <itemLabel>s selected" count (host-computed, countSelected). */
  selectedCount: number
  /** The total line's text (formatTotalTime), or null for the "…" slot. */
  totalTimeText: string | null
  /** The run-N-at-a-time select (screen E); absent on D/I (EXAMPLE-UL-3). */
  atATime?: { value: number; onChange(v: number): void }
  /** The save-the-trained-models toggle (screen E); absent on D/I. */
  saveModels?: { checked: boolean; onChange(v: boolean): void }
  /** The research-use notice (DEC-13); not rendered when null. */
  notice?: string | null
  /** Run clicked: the run keys + the options (atATime, saveModels). */
  onRun(keys: string[], opts: { atATime: number; saveModels: boolean }): void
}

export interface TxrSelectListProps {
  /** The rows this list shows (the host pre-filters them — DEC-9). */
  rows: TxrListRow[]
  /** The screen-I run groups (title, facts, rowKeys, actions). */
  sections?: TxrListSection[]
  /** "method" on E, "model" on D/I (the count + Run labels' plural). */
  itemLabel: 'method' | 'model'
  /** The host's selection set (controlled; DEC-3). */
  selected: ReadonlySet<string>
  /** The selection changed — the HOST stores the next set. */
  onSelectionChange(next: ReadonlySet<string>): void
  /** The host-controlled chips (group / model-kind / outcome). */
  filterChips?: TxrFilterChip[]
  /** The built-in "All N" pill's wiring (see TxrListFilterBar). */
  allFilter?: { active: boolean; onClick(): void }
  /** The built-in "Can run N" pill's wiring. */
  canRunFilter?: { active: boolean; onClick(): void }
  /** The find-a-model box (screen I), or null for no search. */
  search?: TxrSearchControl | null
  /** The sort control (D/I), or null for no sort. */
  sort?: TxrSortControl | null
  /** The bottom bar (count, total, at-a-time, save, notice, Run). */
  bottomBar: TxrSelectListBottomBar
  /** The row action slot (About / Model card / Details) was clicked. */
  onRowAction?(row: TxrListRow): void
  /** A section action (Rename / delete-the-run's-models) was clicked. */
  onSectionAction?(sectionKey: string, actionId: string): void
  /** The rows are loading (the first load — the skeleton state). */
  loading?: boolean
  /** The rows failed to load (the error state + Retry). */
  error?: string | null
  /** The Retry button's handler (the error state's refetch). */
  onRetry?(): void
  /** The empty state's sentence (default "No <itemLabel>s to show"). */
  emptyText?: string
}

/** One flat windowed item: a screen-I run-group header or a row. */
type TxrListItem = { kind: 'section'; section: TxrListSection } | { kind: 'row'; row: TxrListRow }

/**
 * The run keys the Run button hands the engine: the selection minus the
 * rows this list can SEE are disabled (a stale key of a row that became
 * `cannot` — the checkbox masks it and the count ignores it, so the run
 * must too), while keys of rows currently filtered OUT are kept (the run
 * is the selection, never the view; DEC-9). A filtered-out key's status is
 * unknown here — the host's own full-row view is its final guard.
 */
function runKeys(selected: ReadonlySet<string>, rows: TxrListRow[]): string[] {
  const disabled = new Set(rows.filter(row => row.run.disabled).map(row => row.key))
  return [...selected].filter(key => !disabled.has(key))
}

/** The flat windowed stream: the sections' headers interleaved with their
 *  rows, in the order the host's (sorted) rows carry them. A section with
 *  no row in the passed set (the host's filter emptied it) renders no
 *  header; a row with no section (a defensive host shape) renders alone. */
function buildItems(sections: TxrListSection[] | undefined, rows: TxrListRow[]): TxrListItem[] {
  if (!sections || sections.length === 0) return rows.map(row => ({ kind: 'row', row }))
  const sectionOf = new Map<string, TxrListSection>()
  for (const section of sections) {
    for (const key of section.rowKeys) {
      if (!sectionOf.has(key)) sectionOf.set(key, section)
    }
  }
  const items: TxrListItem[] = []
  const emitted = new Set<string>()
  for (const row of rows) {
    const section = sectionOf.get(row.key)
    if (section !== undefined && !emitted.has(section.key)) {
      emitted.add(section.key)
      items.push({ kind: 'section', section })
    }
    items.push({ kind: 'row', row })
  }
  return items
}

/** The error/empty/loading body's shared look (the module's muted line). */
const STATE_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '24px 36px',
  alignItems: 'flex-start',
}

export function TxrSelectList({
  rows,
  sections,
  itemLabel,
  selected,
  onSelectionChange,
  filterChips,
  allFilter,
  canRunFilter,
  search,
  sort,
  bottomBar,
  onRowAction,
  onSectionAction,
  loading = false,
  error = null,
  onRetry,
  emptyText,
}: TxrSelectListProps) {
  const items = buildItems(sections, rows)
  const [viewport, setViewport] = useState<HTMLElement | null>(null)

  const estimateSize = useCallback(
    (index: number) =>
      items[index]?.kind === 'section' ? TXRLIST_SECTION_HEADER_HEIGHT : TXRLIST_ROW_HEIGHT,
    [items],
  )
  const getItemKey = useCallback(
    (index: number) => {
      const item = items[index]
      if (item === undefined) return `index:${index}`
      return item.kind === 'section' ? `section:${item.section.key}` : `row:${item.row.key}`
    },
    [items],
  )

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewport,
    estimateSize,
    overscan: TXRLIST_OVERSCAN,
    getItemKey,
    // CANCEL THE LEAKED SCROLL-RESET TIMER ON UNMOUNT — react-virtual's
    // default offset observer schedules a 150 ms `isScrollingResetDelay`
    // debounce on every scroll and its unsubscribe does NOT clear that
    // pending timer, so a scroll shortly before unmount leaves a timer that
    // fires against the torn-down DOM (the EntryListWidget fix, same seam).
    observeElementOffset: (instance, cb) => {
      let stopped = false
      const unsub = observeElementOffset(instance, (offset, isScrolling) => {
        if (!stopped) cb(offset, isScrolling)
      })
      return () => {
        stopped = true
        unsub?.()
      }
    },
  })

  return (
    <div
      data-testid="txr-list"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <TxrListFilterBar
        rows={rows}
        selected={selected}
        filterChips={filterChips}
        allFilter={allFilter}
        canRunFilter={canRunFilter}
        search={search}
        sort={sort}
        onToggleAllCanRun={() => onSelectionChange(toggleAllCanRun(selected, rows))}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        {loading && rows.length === 0 ? (
          <div
            data-testid="txr-list-loading"
            aria-busy="true"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 0' }}
          >
            {Array.from({ length: TXRLIST_SKELETON_ROWS }, (_, i) => (
              <Skeleton key={i} style={{ height: TXRLIST_ROW_HEIGHT, borderRadius: 10 }} />
            ))}
          </div>
        ) : error !== null && rows.length === 0 ? (
          <div data-testid="txr-list-error" style={STATE_BODY}>
            <span style={{ fontSize: 13.5, color: '#b3261e' }}>{error}</span>
            {onRetry ? (
              <Button data-testid="txr-list-retry" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : items.length === 0 ? (
          <div data-testid="txr-list-empty" style={STATE_BODY}>
            <span style={{ fontSize: 13.5, color: '#5e5e5e' }}>
              {emptyText ?? `No ${pluralize(itemLabel, 2)} to show`}
            </span>
          </div>
        ) : (
          <ScrollArea
            events={{
              // overlayscrollbars' own viewport — the node the virtualizer
              // measures and listens to; `updated` as well as `initialized`,
              // because the viewport is swapped when the instance restarts.
              initialized: instance =>
                setViewport(instance.elements().scrollOffsetElement as HTMLElement),
              updated: instance =>
                setViewport(instance.elements().scrollOffsetElement as HTMLElement),
            }}
            style={{ height: '100%' }}
          >
            <div
              data-testid="txr-list-content"
              style={{
                height: virt.getTotalSize(),
                position: 'relative',
                width: '100%',
              }}
            >
              {virt.getVirtualItems().map(virtualRow => {
                const item = items[virtualRow.index]
                if (item === undefined) return null
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virt.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {item.kind === 'section' ? (
                      <TxrListSectionHeader
                        section={item.section}
                        rows={rows}
                        selected={selected}
                        onToggleSection={section =>
                          onSelectionChange(toggleSection(selected, section, rows))
                        }
                        onSectionAction={onSectionAction}
                      />
                    ) : (
                      <TxrListRowView
                        row={item.row}
                        checked={selected.has(item.row.key)}
                        onToggle={row => onSelectionChange(toggle(selected, row))}
                        onAction={onRowAction}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </div>
      <TxrListBottomBar
        itemLabel={itemLabel}
        selectedCount={bottomBar.selectedCount}
        totalTimeText={bottomBar.totalTimeText}
        atATime={bottomBar.atATime}
        saveModels={bottomBar.saveModels}
        notice={bottomBar.notice}
        onRun={opts => bottomBar.onRun(runKeys(selected, rows), opts)}
      />
    </div>
  )
}
