import { useEffect, useRef, useState } from 'react'
import { Permissions } from '@/api-client/permissions'
import { Can } from '@/core/permissions'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout.store'
import { Projects } from '@/modules/project/stores/Projects.store'
import { ProjectDrawer } from '@/modules/project/stores/ProjectDrawer.store'
import { Button, Empty, ErrorState, Input, Spinner, Title, Tooltip } from '@ziee/kit'
import { DivScrollY, HeaderBarContainer, useElementMinSize } from '@ziee/shell'
import { FolderPlus, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeScroll } from '@/modules/layouts/app-layout/hooks/useNativeScroll'
import { ProjectCard } from '@/modules/project/components/ProjectCard'
import { ProjectFormDrawer } from '@/modules/project/components/ProjectFormDrawer'
import { ProjectShareDrawer } from '@/modules/project/components/ProjectShareDrawer'
import { ProjectTransferDrawer } from '@/modules/project/components/ProjectTransferDrawer'

export function ProjectsPage() {
  const { projects, total, loading, loadingMore, error, isInitialized, search } =
    Projects
  const hasMore = projects.length < total

  // Responsive is PAGE-WIDTH-aware (not viewport): the page is narrow when the sidebar is open
  // on a medium window too, so track the page element, mirroring the ziee Chats page + Settings.
  const pageRef = useRef<HTMLDivElement>(null)
  const minSize = useElementMinSize(pageRef)
  const isNarrow = minSize.sm
  const [searchOpenNarrow, setSearchOpenNarrow] = useState(false)
  // Opt into native document scroll on mobile (iOS toolbar collapse); no-op on desktop.
  useNativeScroll(true)
  const { nativeScroll } = AppLayout

  // Tidy up: close the narrow body-search when the page grows back to wide.
  useEffect(() => {
    if (!isNarrow) setSearchOpenNarrow(false)
  }, [isNarrow])

  const searchInput = (
    <Input
      className="w-full"
      placeholder="Search projects"
      aria-label="Search projects"
      prefix={<Search className="size-4" />}
      defaultValue={search}
      onChange={e => Projects.setSearch(e.target.value)}
      data-testid="projects-search"
    />
  )

  return (
    <div
      ref={pageRef}
      className={cn('flex flex-col', nativeScroll ? 'min-h-dvh' : 'h-full overflow-hidden')}
      data-testid="projects-page"
    >
      {/* Page header — standardized on the shared HeaderBarContainer bar (matches Datasets/Chats). */}
      <HeaderBarContainer>
        <div className="flex h-full w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <Title level={4} className="!m-0 !leading-tight truncate">
              Projects
            </Title>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {/* Wide: inline search. Narrow: an icon button that toggles a body search box
                (page-width-aware, like the Chats page) so the header never overflows. */}
            {!isNarrow ? (
              <div className="w-48 sm:w-64">{searchInput}</div>
            ) : (
              <Tooltip content={searchOpenNarrow ? 'Hide search' : 'Search projects'}>
                <Button
                  variant={searchOpenNarrow ? 'default' : 'ghost'}
                  size="icon"
                  icon={<Search className="size-4" />}
                  aria-label={searchOpenNarrow ? 'Hide search' : 'Search projects'}
                  aria-pressed={searchOpenNarrow}
                  onClick={() => setSearchOpenNarrow(v => !v)}
                  data-testid="projects-search-toggle"
                />
              </Tooltip>
            )}
            <Can permission={Permissions.ProjectsUse}>
              {isNarrow ? (
                <Button
                  size="icon"
                  icon={<Plus className="size-4" />}
                  aria-label="New project"
                  onClick={() => ProjectDrawer.openCreate()}
                  data-testid="projects-new-button"
                />
              ) : (
                <Button
                  onClick={() => ProjectDrawer.openCreate()}
                  data-testid="projects-new-button"
                >
                  <Plus className="mr-1 size-4" />
                  New project
                </Button>
              )}
            </Can>
          </div>
        </div>
      </HeaderBarContainer>

      {/* Page body — scrollable, nativeScroll-aware region below the bar. */}
      <DivScrollY nativeFlow className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
          {/* Narrow: the body search box the header icon toggles (kept mounted while open). */}
          {isNarrow && searchOpenNarrow ? (
            <div data-testid="projects-search-narrow">{searchInput}</div>
          ) : null}

          {error ? (
            <ErrorState
              resource="projects"
              description={error}
              onRetry={() => void Projects.load()}
              data-testid="projects-error"
            />
          ) : !isInitialized && loading ? (
            <div className="flex justify-center py-16" data-testid="projects-loading">
              <Spinner label="Loading projects" />
            </div>
          ) : projects.length === 0 ? (
            <div className="py-16" data-testid="projects-empty">
              <Empty
                data-testid="projects-empty-state"
                description={search ? 'No projects match your search' : 'No projects yet'}
              >
                {!search ? (
                  <Can permission={Permissions.ProjectsUse}>
                    <Button
                      onClick={() => ProjectDrawer.openCreate()}
                      data-testid="projects-empty-create"
                    >
                      <FolderPlus className="mr-1 size-4" />
                      Create your first project
                    </Button>
                  </Can>
                ) : null}
              </Empty>
            </div>
          ) : (
            <>
              <div
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                data-testid="projects-grid"
              >
                {projects.map(s => (
                  <ProjectCard key={s.id} project={s} />
                ))}
              </div>
              {hasMore ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    loading={loadingMore}
                    onClick={() => void Projects.loadMore()}
                    data-testid="projects-load-more"
                  >
                    Show more ({projects.length} of {total})
                  </Button>
                </div>
              ) : null}
            </>
          )}

          {/* Overlays (read the ProjectDrawer/ProjectDetail stores) */}
          <ProjectFormDrawer />
          <ProjectShareDrawer />
          <ProjectTransferDrawer />
        </div>
      </DivScrollY>
    </div>
  )
}
