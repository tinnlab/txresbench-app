import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button, Empty, ErrorState, Spinner } from '@txresbench/kit'
import { RecentProjects } from '@/modules/project/stores/RecentProjects.store'
import { FlaskConical } from 'lucide-react'

/** The focused project id out of the current path (drives the active-row highlight). */
function useFocusedProjectId(): string | undefined {
  const { pathname } = useLocation()
  return /^\/projects\/([^/]+)/.exec(pathname)?.[1]
}

/**
 * The recent-projects sidebar widget — a FLAT, clickable list (Load-More paginated):
 * each row is the project name and navigates to the project. (Previously each row
 * expanded in place to reveal per-project sub-sections; that expand/collapse was
 * removed — a plain click-to-open list is what users expect from a nav list.)
 */
export function RecentProjectsWidget() {
  const {
    recentProjects,
    recentTotal,
    recentHasMore,
    recentLoading,
    recentLoadingMore,
    recentInitialized,
    recentError,
  } = RecentProjects
  const focusedId = useFocusedProjectId()

  useEffect(() => {
    if (!recentInitialized) void RecentProjects.load()
  }, [recentInitialized])

  const header = (
    <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground" data-testid="recent-projects-header">
      Projects
    </div>
  )

  let body: React.ReactNode
  if (recentError && recentProjects.length === 0) {
    body = (
      <div className="px-2 py-3">
        <ErrorState
          resource="projects"
          description={recentError}
          onRetry={() => void RecentProjects.load()}
          data-testid="recent-projects-error"
        />
      </div>
    )
  } else if (!recentInitialized && recentLoading) {
    body = (
      <div className="flex justify-center py-6" data-testid="recent-projects-loading">
        <Spinner label="Loading projects" />
      </div>
    )
  } else if (recentProjects.length === 0) {
    body = <Empty description="No projects yet" data-testid="recent-projects-empty" />
  } else {
    body = (
      <ul className="flex flex-col gap-0.5 px-2" role="list" data-testid="recent-projects-list">
        {recentProjects.map((project, i) => {
          const isFocused = project.id === focusedId
          return (
            <li key={project.id} aria-posinset={i + 1} aria-setsize={recentHasMore ? Math.max(recentTotal, recentProjects.length) : recentProjects.length}>
              <Link
                to={`/projects/${project.id}`}
                aria-current={isFocused ? 'page' : undefined}
                data-testid={`recent-project-row-${project.id}`}
                className={
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ' +
                  (isFocused
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-foreground/80 hover:bg-accent/50')
                }
              >
                <FlaskConical aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="recent-projects-widget">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      {recentProjects.length > 0 ? (
        <div className="flex flex-col items-center gap-1 px-2 py-2">
          {/* A Load-More failure with rows already present must not be silent. */}
          {recentError ? (
            <button
              type="button"
              className="text-xs text-destructive hover:underline"
              onClick={() => void RecentProjects.loadMoreRecent()}
              data-testid="recent-projects-loadmore-error"
            >
              Couldn't load more — retry
            </button>
          ) : recentHasMore ? (
            <Button
              variant="ghost"
              loading={recentLoadingMore}
              onClick={() => void RecentProjects.loadMoreRecent()}
              data-testid="recent-projects-load-more"
            >
              Load more
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground" data-testid="recent-projects-count">
            Showing {recentProjects.length} of {recentTotal}
          </span>
        </div>
      ) : null}
    </div>
  )
}
