import { lazy } from 'react'
import { parse as parseYaml } from 'yaml'
import type { ModuleGallery } from '@ziee/gallery'
import type { Dataset, DatasetArtifactSummary, DatasetListItem, ProjectDto } from '@/api-client/types'
import { ProjectScopeProvider } from '@/modules/project/context/ProjectScope'
import { useProjectDetailStore } from '@/modules/project/stores/ProjectDetail.store'
import { DatasetsPanel } from './components/DatasetsPanel'

/**
 * Gallery seed for the project-side dataset ATTACH panel (ITEM-3 FE). The project
 * detail page is a param route (`/projects/:id/:section`) that the shared page
 * crawl can't reach, so this panel is seeded here explicitly — the datasets
 * MODULE gallery (ITEM-17) covers the LIBRARY-side surfaces, not this project-side
 * panel. Each cell seeds the real `ProjectDetail` store offline (no backend) and
 * wraps the panel in a `ProjectScopeProvider` so the owner/viewer branches render
 * (the picker is `canEdit`-gated), mirroring the provenance module's gallery.
 */

const OWNER = '00000000-0000-4000-8000-00000000000f'
const ID_POPULATED = '00000000-0000-4000-8000-0000000000e1'
const ID_EMPTY = '00000000-0000-4000-8000-0000000000e2'
const ID_VIEWER = '00000000-0000-4000-8000-0000000000e3'

// Owner + Viewer wrappers: the panel reads `useCanEdit()` from the scope provider
// (the real ProjectDetailPage supplies it), so seed it here to exercise both roles.
const OwnerPanel = lazy(async () => ({
  default: () => (
    <ProjectScopeProvider project={{ effective_permission: 'owner' }}>
      <div className="p-4">
        <DatasetsPanel />
      </div>
    </ProjectScopeProvider>
  ),
}))
const ViewerPanel = lazy(async () => ({
  default: () => (
    <ProjectScopeProvider project={{ effective_permission: 'viewer' }}>
      <div className="p-4">
        <DatasetsPanel />
      </div>
    </ProjectScopeProvider>
  ),
}))

// A list ROW, not a bare `Dataset`: the rows the picker really receives carry the
// DERIVED processing status, and a fixture without it cannot exercise the not-ready
// marking. `DatasetListItem` is assignable to `Dataset`, so the store's declared
// element type still accepts these.
function ds(
  id: string,
  name: string,
  datatype?: string,
  processing?: { status?: string; error?: string },
): DatasetListItem {
  return {
    id,
    name,
    datatype,
    metadata: {},
    owner_id: OWNER,
    account_id: OWNER,
    source: 'upload',
    content_hash: `sha256:${'a'.repeat(64)}`,
    processing_status: processing?.status,
    processing_error: processing?.error,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
  }
}

/** A fixture dataset's own datatype id — never a second spelling of it. */
const dtOf = (d: Dataset): string => d.datatype ?? 'untyped'

/**
 * The axis NAMES each datatype declares, read out of the shipped package manifests.
 *
 * A producer stamps `axes` beside `shape` on every array artifact it writes, and the
 * contributed preview reads BOTH — so a fixture carrying `shape` alone renders the
 * count-and-title fallback and this surface silently stops showing what production
 * shows. (It did: until this was added, the panel's flagship row read as a plain
 * count for every gallery screenshot and every runtime-health pass.)
 *
 * Read rather than written for the same reason the preview declaration reads them:
 * spelling an axis word HERE would put a datatype's vocabulary into app-scanned
 * source, and would go stale the moment the owning package renamed one.
 */
const DECLARED_AXES: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {}
  const files = import.meta.glob('../../../../../packages/*/manifest.yaml', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>
  for (const text of Object.values(files)) {
    const doc = parseYaml(text) as {
      contributes?: { datatypes?: Array<{ id?: string; axes?: Array<{ name?: string }> }> }
    }
    for (const dt of doc?.contributes?.datatypes ?? []) {
      const names = (dt?.axes ?? []).map(a => a?.name).filter((n): n is string => typeof n === 'string')
      if (dt?.id && names.length > 0) out[dt.id] = names
    }
  }
  return out
})()

/** One artifact summary as the batched read returns it. */
function holdings(
  datasetId: string,
  groups: {
    datatype: string
    count: number
    bytes: number
    meta?: Record<string, unknown>
    structure?: Record<string, unknown>
  }[],
): DatasetArtifactSummary {
  return {
    dataset_id: datasetId,
    artifact_count: groups.reduce((n, g) => n + g.count, 0),
    total_logical_bytes: groups.reduce((n, g) => n + g.bytes, 0),
    groups: groups.map(g => ({
      datatype: g.datatype,
      count: g.count,
      logical_bytes: g.bytes,
      representative_output_id: 'primary',
      // BOTH producer declarations, so the gallery renders what production renders. Keys come
      // from `g.meta` / `g.structure` — the FIXTURE decides, never this helper, because naming a
      // key here would put a producer's vocabulary into app-scanned source and the declaration is
      // the only place that is allowed to know it. Absent ⇒ `{}`, which is the no-contribution row.
      representative_meta: g.meta ?? {},
      representative_structure: g.structure ?? {},
    })),
  }
}

function project(id: string, perm: 'owner' | 'viewer', datasetCount: number): ProjectDto {
  return {
    id,
    owner_id: OWNER,
    name: 'Melanoma atlas',
    description: '',
    effective_permission: perm,
    dataset_count: datasetCount,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
  }
}

// The OWNED-but-not-yet-linked datasets (the picker's "My datasets" group). The third
// is a dataset whose on-ingest processing FAILED — still offered, and marked.
const ID_BROKEN = '00000000-0000-4000-8000-0000000000b3'
const OWNED_CANDIDATES: Dataset[] = [
  ds('00000000-0000-4000-8000-0000000000b1', 'PBMC 10k raw', 'single-cell/expression'),
  ds('00000000-0000-4000-8000-0000000000b2', 'Tumor QC table', 'table/qc'),
  ds(ID_BROKEN, 'Donor 7 import (broken)', 'table/qc', {
    status: 'failed',
    error: 'converter exited 2: unreadable input container',
  }),
]

type DetailState = ReturnType<typeof useProjectDetailStore.getState>

function seedProject(partial: Partial<DetailState>) {
  return () => {
    useProjectDetailStore.setState({
      projectId: null,
      project: null,
      datasets: [],
      datasetsTotal: 0,
      datasetsPage: 1,
      shares: [],
      availableDatasets: [],
      loading: false,
      loadingMore: false,
      mutating: false,
      error: null,
      ...partial,
    } as DetailState)
  }
}

const LINKED: Dataset[] = [
  ds('00000000-0000-4000-8000-0000000000a1', 'PBMC atlas expression', 'single-cell/expression'),
  ds('00000000-0000-4000-8000-0000000000a2', 'UMAP embedding', 'single-cell/embedding'),
  ds('00000000-0000-4000-8000-0000000000a3', 'Cohort manifest', undefined),
]

export const gallery: ModuleGallery = {
  // Beyond the seeded store state: the share-aware half of the picker (fetched on
  // mount) + the seam-route summary. The summary count keys off the project id so
  // the empty surface reads 0.
  cassette: {
    // NOTE: `Dataset.listShared` is seeded app-wide by the datasets module's own
    // gallery cassette (the Dataset entity's owner). Cassette keys are merged
    // across ALL module galleries at mount, so re-seeding the same key here
    // collides and crashes the whole gallery mount — the share-aware picker on
    // this surface uses that shared global seed.
    'Project.datasetSummary': (ctx: { params: Record<string, string> }) => ({
      dataset_count: ctx.params.id === ID_EMPTY ? 0 : LINKED.length,
    }),
    // The batched artifact read. The broken candidate has no summary row of its own beyond a
    // zero. Fixtures DO carry per-datatype declarations now that a package contributes a preview,
    // so this surface renders what production renders — the contributed phrases, joined in the
    // order those packages declared. A group with no declarations still exercises the
    // no-contribution row, which is what any uncontributed datatype gets.
    //
    // Every datatype below is READ OFF a fixture dataset rather than written out
    // again: a restated id would be a fresh domain literal in app-scanned source, and
    // deriving it also keeps the fixtures consistent if one is ever re-typed.
    'Dataset.artifactSummaries': () => ({
      summaries: [
        // Many artifacts across two datatypes — the case a flat list cannot summarise.
        holdings(LINKED[0].id, [
          // Carries the producer's bags, so this row renders the CONTRIBUTED phrase. The keys are
          // the declaration's business, not this file's — they are here only so the surface has
          // something for the declaration to draw on, and a wrong key degrades to the fallback
          // rather than to a hole (which is the behaviour the preview tests pin).
          {
            datatype: dtOf(LINKED[0]),
            count: 1,
            bytes: 41_233_920,
            meta: { n_vars: 32_738, nnz: 2_286_884 },
            structure: {
              shape: [3_460, 32_738],
              // Index-aligned with `shape`, exactly as the producer writes the pair.
              axes: DECLARED_AXES[dtOf(LINKED[0])] ?? [],
              nnz: 2_286_884,
            },
          },
          { datatype: dtOf(OWNED_CANDIDATES[1]), count: 63, bytes: 2_260_992 },
        ]),
        holdings(LINKED[1].id, [{ datatype: dtOf(LINKED[1]), count: 1, bytes: 819_200 }]),
        // Linked but holding nothing → the counted-as-zero line.
        holdings(LINKED[2].id, []),
        holdings(OWNED_CANDIDATES[0].id, [
          { datatype: dtOf(OWNED_CANDIDATES[0]), count: 1, bytes: 18_874_368 },
        ]),
        holdings(OWNED_CANDIDATES[1].id, [
          { datatype: dtOf(OWNED_CANDIDATES[1]), count: 1, bytes: 12_288 },
        ]),
        // The failed import produced nothing — the badge and this line agree.
        holdings(ID_BROKEN, []),
      ],
    }),
  },
  seeded: [
    {
      slug: 'project-datasets-attach-populated',
      title: 'Project datasets — linked + share-aware picker (owner)',
      note: 'Linked datasets with type tags; the attach picker lists owned ∪ shared candidates.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${ID_POPULATED}/datasets`,
      component: OwnerPanel,
      setup: seedProject({
        projectId: ID_POPULATED,
        project: project(ID_POPULATED, 'owner', LINKED.length),
        datasets: LINKED,
        datasetsTotal: LINKED.length,
        availableDatasets: OWNED_CANDIDATES,
      }),
      // ITEM-38 — the detach confirmation is INTERACTION-GATED, so a mount-only
      // capture never renders it and the surface it guards would be reviewed in a
      // state the user never reaches. This recipe drives the real click, so the
      // open prompt is a captured, contrast-checked, runtime-health-read state
      // like any other. It runs against the row whose name is the LONGEST of the
      // three seeded ones, because the prompt interpolates the dataset name into
      // its title and a short name hides the wrap.
      interactions: [
        {
          name: 'detach-confirm-open',
          note: 'Detach asks first — the confirmation prompt, open, naming the dataset.',
          steps: async d => {
            await d.click('project-detach-00000000-0000-4000-8000-0000000000a1')
            await d.waitFor('project-dataset-detach-confirm-00000000-0000-4000-8000-0000000000a1')
          },
        },
      ],
    },
    {
      slug: 'project-datasets-attach-empty',
      title: 'Project datasets — none linked yet (owner)',
      note: 'The empty state with an attach picker still offering owned ∪ shared datasets to link.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${ID_EMPTY}/datasets`,
      component: OwnerPanel,
      setup: seedProject({
        projectId: ID_EMPTY,
        project: project(ID_EMPTY, 'owner', 0),
        datasets: [],
        datasetsTotal: 0,
        availableDatasets: OWNED_CANDIDATES,
      }),
    },
    {
      slug: 'project-datasets-attach-viewer',
      title: 'Project datasets — read-only (viewer)',
      note: 'A Viewer sees the linked datasets but no attach picker or detach affordances.',
      path: '/projects/:id/:section',
      initialPath: `/projects/${ID_VIEWER}/datasets`,
      component: ViewerPanel,
      setup: seedProject({
        projectId: ID_VIEWER,
        project: project(ID_VIEWER, 'viewer', LINKED.length),
        datasets: LINKED,
        datasetsTotal: LINKED.length,
        availableDatasets: [],
      }),
    },
  ],
}
