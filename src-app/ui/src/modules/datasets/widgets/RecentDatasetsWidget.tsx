import { Link, useLocation } from 'react-router-dom'
import { Empty, ErrorState, Spinner } from '@ziee/kit'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { Database } from 'lucide-react'

const MAX_RECENT = 8

/**
 * The recent-datasets sidebar feed (mirrors `RecentProjectsWidget`). Reads the
 * shared `Datasets` store (owned set), shows the most-recently-updated datasets
 * as deep-links, and highlights the one matching the current `/datasets/:id`
 * route. The store auto-loads + refetches on `sync:dataset`, so the feed stays
 * live without its own fetch.
 */
export function RecentDatasetsWidget() {
  const { recent: recentOwned, loading, isInitialized, error } = Datasets
  const { pathname } = useLocation()
  const focusedId = /^\/datasets\/([^/]+)/.exec(pathname)?.[1]

  // The store feeds the newest-CREATED owned datasets (server `list_mine` orders by
  // `created_at DESC`, capped at 8). Sort by the SAME key so the feed is consistent —
  // re-sorting this created-window by `updated_at` couldn't surface an old-but-recently-
  // updated dataset (it isn't in the window), which was misleading.
  const recent = [...recentOwned]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_RECENT)

  let body: React.ReactNode
  if (error && recentOwned.length === 0) {
    body = (
      <div className="px-2 py-3">
        <ErrorState
          resource="datasets"
          description={error}
          onRetry={() => void Datasets.load()}
          data-testid="recent-datasets-error"
        />
      </div>
    )
  } else if (!isInitialized && loading) {
    body = (
      <div className="flex justify-center py-6" data-testid="recent-datasets-loading">
        <Spinner label="Loading datasets" />
      </div>
    )
  } else if (recent.length === 0) {
    body = <Empty description="No datasets yet" data-testid="recent-datasets-empty" />
  } else {
    body = (
      <ul className="flex flex-col gap-0.5 px-2" role="list" data-testid="recent-datasets-list">
        {recent.map(ds => {
          const isFocused = ds.id === focusedId
          return (
            <li key={ds.id}>
              <Link
                to={`/datasets/${ds.id}`}
                aria-current={isFocused ? 'page' : undefined}
                data-testid={`recent-dataset-row-${ds.id}`}
                className={
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ' +
                  (isFocused
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-foreground/80 hover:bg-accent/50')
                }
              >
                <Database aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{ds.name}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="recent-datasets-widget">
      <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground" data-testid="recent-datasets-header">
        Datasets
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  )
}
