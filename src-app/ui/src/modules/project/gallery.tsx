import { lazy } from 'react'
import type { ModuleGallery } from '@txresbench/gallery'
import type { ProjectDto } from '@/api-client/types'
import { useRecentProjectsStore } from '@/modules/project/stores/RecentProjects.store'

/**
 * Gallery seed for the project module's NEW surfaces — the expandable
 * recent-projects sidebar widget in its conditional-render states. The detail
 * shell + datasets panel render from the shared crawl base (auto-enumerated
 * pages), so only the widget's offline states are seeded here.
 */

const RecentProjectsWidget = lazy(() =>
  import('@/modules/project/widgets/RecentProjectsWidget').then(m => ({
    default: m.RecentProjectsWidget,
  })),
)

const SEED_ID = '00000000-0000-4000-8000-0000000000a1'

function project(id: string, name: string, datasetCount: number): ProjectDto {
  return {
    id,
    owner_id: '00000000-0000-4000-8000-00000000000f',
    name,
    description: '',
    effective_permission: 'owner',
    dataset_count: datasetCount,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
  }
}

const seededProjects: ProjectDto[] = [
  project(SEED_ID, 'Melanoma atlas', 4),
  project('00000000-0000-4000-8000-0000000000a2', 'PBMC 10k', 1),
  project('00000000-0000-4000-8000-0000000000a3', 'Lung tumor microenvironment', 12),
]

type RecentState = ReturnType<typeof useRecentProjectsStore.getState>

const DEFAULTS = {
  recentProjects: [] as ProjectDto[],
  recentTotal: 0,
  recentPage: 1,
  recentHasMore: false,
  recentLoading: false,
  recentLoadingMore: false,
  recentInitialized: true,
  recentError: null as string | null,
  recentLoadSeq: 1,
}

function seed(partial: Partial<RecentState>) {
  return () => {
    useRecentProjectsStore.setState({ ...DEFAULTS, ...partial } as RecentState)
  }
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'recent-projects-expanded',
      title: 'Recent projects — selected & expanded',
      note: 'The focused project is expanded, showing its project_nav sub-entries.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${SEED_ID}/datasets`,
      component: RecentProjectsWidget,
      setup: seed({
        recentProjects: seededProjects,
        recentTotal: seededProjects.length,
      }),
    },
    {
      slug: 'recent-projects-loadmore',
      title: 'Recent projects — Load-More',
      note: 'A bounded first page with more available (Showing N of M).',
      path: '/projects',
      initialPath: '/projects',
      component: RecentProjectsWidget,
      setup: seed({
        recentProjects: seededProjects,
        recentTotal: 42,
        recentHasMore: true,
      }),
    },
    {
      slug: 'recent-projects-empty',
      title: 'Recent projects — empty',
      note: 'No projects yet.',
      path: '/projects',
      initialPath: '/projects',
      component: RecentProjectsWidget,
      setup: seed({}),
    },
    {
      slug: 'recent-projects-loading',
      title: 'Recent projects — loading',
      note: 'Initial load spinner.',
      path: '/projects',
      initialPath: '/projects',
      component: RecentProjectsWidget,
      setup: seed({ recentInitialized: false, recentLoading: true }),
    },
    {
      slug: 'recent-projects-error',
      title: 'Recent projects — error',
      note: 'Load failed with retry.',
      path: '/projects',
      initialPath: '/projects',
      component: RecentProjectsWidget,
      setup: seed({ recentError: 'Failed to load projects' }),
    },
  ],
}
