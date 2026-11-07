/**
 * TxrHistoryList — the K list area (PROV-HIST-5): the card list
 * (newest-first, the store's server-paged order) + the list's three
 * boundary states — the empty state (`TxrHistoryEmpty`), the failure
 * state (`TxrHistoryError` with the Retry affordance) and the "Load more"
 * continuation (the INV-1 bound: shown exactly while `items.length <
 * total`, server-paged by the store — never a fetch-all). The first-page
 * load paints the quiet skeleton rows; the rest of the page (toolbar,
 * footer) is the page's own composition.
 *
 * The list is reported, never executed: every interaction reports the
 * run/set id or the continuation; the page binds the store actions and
 * the builders' navigations (ITEM-5).
 */
import type { CSSProperties } from 'react'
import { Button, Skeleton } from '@ziee/kit'
import type { TxrHistoryDetail, TxrHistoryItem } from '@/api-client/types'
import { TxrHistoryCard } from './TxrHistoryCard'
import { TxrHistoryEmpty } from './TxrHistoryEmpty'
import { TxrHistoryError } from './TxrHistoryError'

/** The board's list: one column, 10 px gaps, no list markers. */
const LIST: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

/** The first-page loading area (the board's row silhouette). */
const LOADING: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '4px 0',
}

/** The load-more row (centered under the list). */
const LOAD_MORE_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  paddingTop: 2,
}

export interface TxrHistoryListProps {
  items: readonly TxrHistoryItem[]
  /** The provider's engine-truth count (the Load-more bound + the
   *  footer's honest fallback count). */
  total: number
  /** The first page is loading (the skeleton state). */
  loading: boolean
  /** A Load-more continuation is in flight (the button's busy state). */
  loadingMore: boolean
  /** Any failed first-page call (the failure state — never a blank page). */
  error: 'network' | null
  /** The one expanded row (the store's `expandedId`). */
  expandedId: string | null
  /** The expanded row's detail (the store's `detail`). */
  detail: TxrHistoryDetail | null
  detailLoading: boolean
  isDesktop: boolean
  /** The toggle (the store's `expand` — one expanded row at a time). */
  onToggle: (runId: string) => void
  /** The continuation (the store's `loadMore`). */
  onLoadMore: () => void
  /** The Retry affordance (the store's `retryLoad`). */
  onRetry: () => void
  onOpenResults?: (runId: string) => void
  onOpenRunning?: (runId: string) => void
  onRerun?: (runId: string) => void
  onSettingsAgain?: (runId: string) => void
  onDownload?: (runId: string) => void
  onReveal?: (runId: string) => void
  onLog?: (runId: string) => void
  onOpenSet?: (setId: string) => void
}

export function TxrHistoryList({
  items,
  total,
  loading,
  loadingMore,
  error,
  expandedId,
  detail,
  detailLoading,
  isDesktop,
  onToggle,
  onLoadMore,
  onRetry,
  onOpenResults,
  onOpenRunning,
  onRerun,
  onSettingsAgain,
  onDownload,
  onReveal,
  onLog,
  onOpenSet,
}: TxrHistoryListProps) {
  if (error !== null) {
    return <TxrHistoryError onRetry={onRetry} />
  }
  if (loading && items.length === 0) {
    return (
      <div data-testid="txr-history-loading" style={LOADING}>
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    )
  }
  if (items.length === 0) {
    return <TxrHistoryEmpty />
  }
  return (
    <div>
      <ul data-testid="txr-history-list" style={LIST}>
        {items.map(item => (
          <TxrHistoryCard
            key={item.id}
            item={item}
            expanded={expandedId === item.id}
            detail={detail !== null && detail.id === item.id ? detail : null}
            detailLoading={detailLoading && expandedId === item.id}
            isDesktop={isDesktop}
            onToggle={onToggle}
            onOpenResults={onOpenResults}
            onOpenRunning={onOpenRunning}
            onRerun={onRerun}
            onSettingsAgain={onSettingsAgain}
            onDownload={onDownload}
            onReveal={onReveal}
            onLog={onLog}
            onOpenSet={onOpenSet}
          />
        ))}
      </ul>
      {items.length < total ? (
        <div style={LOAD_MORE_ROW}>
          <Button
            data-testid="txr-history-load-more"
            variant="outline"
            onClick={onLoadMore}
            loading={loadingMore}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  )
}
