/**
 * TxrHistoryEmpty — the K list's empty state (PROV-HIST-5): "Nothing here
 * yet" + the board's promise sentence ("Runs you start appear here,
 * newest first."). Rendered by the list when the loaded page set is empty
 * (the store's `total === 0` state after a successful load).
 *
 * R3-results-5: a SEARCH (or filter) that matches nothing no longer reads
 * the fresh-history promise — "Nothing here yet" is the wrong story next
 * to a query the user typed. The active restriction is named instead
 * ("No run matches 'zzzz'", "No runs match 'Learned'"), the same
 * truth-telling the results page uses for its patient search.
 */
import { Empty } from '@txresbench/kit'
import { FILTER_OPTIONS, type TxrHistoryFilter } from '../types'

export const HISTORY_EMPTY_TITLE = 'Nothing here yet'

export const HISTORY_EMPTY_BODY = 'Runs you start appear here, newest first.'

/** The no-match body of an active search (the results page's own words). */
function noMatchTitle(search: string, filterLabel: string | null): string {
  if (search.trim().length > 0) return `No run matches '${search.trim()}'`
  if (filterLabel !== null) return `No runs match '${filterLabel}'`
  return HISTORY_EMPTY_TITLE
}

export function TxrHistoryEmpty({
  search = '',
  filter = 'all',
}: {
  /** The toolbar's current search text (the no-match message's query). */
  search?: string
  /** The current filter (the no-match message's restriction). */
  filter?: TxrHistoryFilter
}) {
  const filterLabel =
    filter === 'all'
      ? null
      : (FILTER_OPTIONS.find(option => option.value === filter)?.label ?? null)
  const restricted = search.trim().length > 0 || filterLabel !== null
  return (
    <Empty
      data-testid="txr-history-empty"
      title={noMatchTitle(search, filterLabel)}
      description={
        restricted ? 'Try a different search or filter.' : HISTORY_EMPTY_BODY
      }
    />
  )
}
