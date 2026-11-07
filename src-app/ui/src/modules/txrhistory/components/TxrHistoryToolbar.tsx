/**
 * TxrHistoryToolbar — the K board's header row (PROV-HIST-5): the H1
 * "History" with the board's permanent subtitle, the search field
 * ("Search by file, method or model") and the four-option filter select
 * (the `FILTER_OPTIONS` board labels). The row is the board's own wrap
 * layout: title block left, controls right, wrapping at narrow widths.
 *
 * The toolbar is CONTROLLED and purely presentational: the search value
 * and the filter are the store page's state (the debounce + the list
 * restart are the store's, ITEM-2), and the onSearch/onFilter reports
 * are what the page binds. The title + subtitle are the board's static
 * copy from the module's own board-copy layer (`HISTORY_SUBTITLE`, one
 * source for the TEST-HIST-6 pin) — no fact, no number.
 *
 * Every control is a kit control (the native-controls lint): the search
 * box is the kit `Input` (native `type="search"` styled by the kit, the
 * board's own `aria-label`), the filter the kit `Select` (the board's
 * four options, verbatim labels from `FILTER_OPTIONS`).
 *
 * NOTE for ITEM-5: this component carries the title block the ITEM-1
 * page shell renders inline; the page swaps its inline block for this
 * component (the plan's "mount toolbar/list/footer").
 */
import type { CSSProperties } from 'react'
import { Input, Select } from '@ziee/kit'
import { HISTORY_SUBTITLE } from '../lib/format'
import { FILTER_OPTIONS, type TxrHistoryFilter } from '../types'

/** The board's header row (title block + controls, wrapping at narrow widths). */
const HEADER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 16,
}

/** The board's h1 look (the shell's own title bytes — one source of the chrome). */
const TITLE: CSSProperties = {
  margin: '0 0 2px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

const SUBTITLE: CSSProperties = { color: '#3a3a3a', fontSize: 14 }

/** The controls row (search + filter, the board's 10 px gap). */
const CONTROLS: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }

/** The board's search box width (the board's own 260 px). */
const SEARCH: CSSProperties = { width: 260 }

export interface TxrHistoryToolbarProps {
  /** The controlled search input's immediate value (the store's `searchInput`). */
  search: string
  /** The active one of the four board options (the store's `filter`). */
  filter: TxrHistoryFilter
  /** Each keystroke (the store debounces + restarts the list). */
  onSearch: (value: string) => void
  /** One of the four options picked (the store restarts the list). */
  onFilter: (filter: TxrHistoryFilter) => void
}

export function TxrHistoryToolbar({ search, filter, onSearch, onFilter }: TxrHistoryToolbarProps) {
  return (
    <div data-testid="txr-history-toolbar" style={HEADER_ROW}>
      <div>
        <h1 data-testid="txr-history-title" style={TITLE}>
          History
        </h1>
        <div data-testid="txr-history-subtitle" style={SUBTITLE}>
          {HISTORY_SUBTITLE}
        </div>
      </div>
      <div style={CONTROLS}>
        <Input
          data-testid="txr-history-search"
          type="search"
          placeholder="Search by file, method or model"
          aria-label="Search the history"
          value={search}
          onChange={event => onSearch(event.target.value)}
          size="sm"
          style={SEARCH}
          allowStyle
        />
        <Select
          data-testid="txr-history-filter"
          aria-label="Show"
          size="sm"
          options={FILTER_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
          value={filter}
          onValueChange={value => onFilter(value as TxrHistoryFilter)}
        />
      </div>
    </div>
  )
}
