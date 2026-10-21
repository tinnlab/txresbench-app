import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type { ListedArtifact } from '@/api-client/types'
import { ProjectScopeProvider } from '@/modules/project/context/ProjectScope'
import { useProjectDetailStore } from '@/modules/project/stores/ProjectDetail.store'
import { ArtifactsPanel } from './components/ArtifactsPanel'

/**
 * Gallery seed for the project ARTIFACTS pane.
 *
 * ── WHY THIS EXISTS (ITEM-41) ──────────────────────────────────────────────────────
 *
 * It did not, and that was the same blind spot one surface over. ITEM-41 fixed a pane
 * that rendered BLANK on a failed read — a bug that survived precisely because a blank
 * surface passes every health check there is — and then put the fix behind a status Tag
 * that had **no captured populated render of its own**. A Tag nobody has ever seen
 * rendered is in exactly the state the bug it fixes was in.
 *
 * So the seeded frames below are deliberately about the UNHAPPY states, which is where the
 * layout bugs live: the longest `output_id` next to the widest Tag, and the missing-source
 * line under it. The all-`ready` case is the one that always looked fine.
 *
 * Cassette-driven (no backend): the panel is zero-prop and reads `ProjectDetail` for the
 * project plus `Workstore.listArtifacts` for the rows, mirroring the dataset
 * project-extension's gallery next door.
 */

const OWNER = '00000000-0000-4000-8000-00000000000f'
const ID_MIXED = '00000000-0000-4000-8000-0000000000c1'
const ID_READY = '00000000-0000-4000-8000-0000000000c2'

const DATATYPE = 'data/opaque'

function artifact(partial: Partial<ListedArtifact> & { id: string; output_id: string }): ListedArtifact {
  return {
    content_hash: `sha256:${partial.id}`,
    created_at: '2026-08-17T00:00:00Z',
    datatype: DATATYPE,
    hidden: false,
    is_multifile: false,
    meta: { origin: 'seed' },
    role: 'artifact',
    logical_bytes: 4096,
    status: 'ready',
    structure: { encoding: 'opaque' },
    updated_at: '2026-08-17T00:00:00Z',
    ...partial,
  } as ListedArtifact
}

/** Every state on one screen — which is the only way "they are told apart" is
 *  reviewable rather than asserted. The `unresolvable` row carries a deliberately LONG
 *  source name: the missing-source line truncates, and a short name hides that. */
const MIXED: ListedArtifact[] = [
  artifact({ id: 'a-1', output_id: 'integrated_unified_coordinates', status: 'ready' }),
  artifact({ id: 'a-2', output_id: 'pending_export', status: 'pending' }),
  artifact({ id: 'a-3', output_id: 'condemned_measurement_table', status: 'failed' }),
  artifact({
    id: 'a-4',
    output_id: 'gathered_unified_annotation_column',
    status: 'unresolvable',
    meta: { origin: 'seed', unresolved_source: 'source-dataset-alpha-2026-08-17-replicate-3' },
  }),
  // An `unresolvable` row whose invalidation did NOT record a source. The copy must still
  // say something rather than render a blank line — this row is how that stays visible.
  artifact({ id: 'a-5', output_id: 'gathered_column_without_recorded_source', status: 'unresolvable' }),
  // A status this build has never heard of: the LOUD fallback, which is otherwise
  // unreachable in a capture because no server sends it today.
  artifact({ id: 'a-6', output_id: 'future_state_row', status: 'quarantined' }),
  artifact({ id: 'a-7', output_id: 'viz_intermediate', role: 'intermediate' }),
]

const ALL_READY: ListedArtifact[] = [
  artifact({ id: 'b-1', output_id: 'expression', status: 'ready' }),
  artifact({ id: 'b-2', output_id: 'coordinates', status: 'ready' }),
]

const Panel = lazy(async () => ({
  default: () => (
    <ProjectScopeProvider project={{ effective_permission: 'owner' }}>
      <div className="p-4">
        <ArtifactsPanel />
      </div>
    </ProjectScopeProvider>
  ),
}))

function seedProject(projectId: string) {
  return () => {
    useProjectDetailStore.setState({
      project: {
        id: projectId,
        name: 'Gallery project',
        description: '',
        owner_id: OWNER,
        effective_permission: 'owner',
        dataset_count: 0,
        created_at: '2026-08-17T00:00:00Z',
        updated_at: '2026-08-17T00:00:00Z',
      },
    } as never)
  }
}

export const gallery: ModuleGallery = {
  cassette: {
    'Workstore.listArtifacts': (ctx: { query?: Record<string, string> }) =>
      ctx.query?.project_id === ID_READY ? ALL_READY : MIXED,
  },
  seeded: [
    {
      slug: 'project-artifacts-unreadable-states',
      title: 'Project artifacts — every readable and unreadable state',
      note: 'ready / pending / failed / unresolvable (named + unrecorded source) / an unknown status / intermediate.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${ID_MIXED}/artifacts`,
      component: Panel,
      setup: seedProject(ID_MIXED),
    },
    {
      slug: 'project-artifacts-all-ready',
      title: 'Project artifacts — all ready',
      note: 'The quiet case: `ready` renders as plain text, so the pane does not become a wall of chips.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${ID_READY}/artifacts`,
      component: Panel,
      setup: seedProject(ID_READY),
    },
  ],
}
