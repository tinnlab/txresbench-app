import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type { GraphDto, RunNodeDto, ProjectDto } from '@/api-client/types'
import { useProvenanceStore } from '@/modules/provenance/stores/Provenance.store'
import { useProvenanceExportStore } from '@/modules/provenance/stores/ProvenanceExport.store'
import { useProvenanceSettingsStore } from '@/modules/provenance/stores/ProvenanceSettings.store'
import { useProjectDetailStore } from '@/modules/project/stores/ProjectDetail.store'

/**
 * Gallery seed for the provenance module's NEW surfaces — the project
 * "Reproducibility" detail panel (seeded runs / empty / error), the export
 * drawer open-state, and the admin settings card. Each cell seeds the real
 * stores offline (no backend), mirroring the project module's gallery.
 */

const PROJECT_ID = '00000000-0000-4000-8000-0000000000c1'
const ARTIFACT_ID = '00000000-0000-4000-8000-0000000000c2'

const ProvenanceSettingsCard = lazy(() =>
  import('@/modules/provenance/components/ProvenanceSettingsCard').then(m => ({
    default: m.ProvenanceSettingsCard,
  })),
)

function seededProject(): ProjectDto {
  return {
    id: PROJECT_ID,
    owner_id: '00000000-0000-4000-8000-00000000000f',
    name: 'Melanoma atlas',
    description: '',
    effective_permission: 'owner',
    dataset_count: 4,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
  }
}

function run(
  id: string,
  kind: string,
  seed: number | undefined,
  over?: Partial<RunNodeDto>,
): RunNodeDto {
  return {
    run_id: id,
    project_id: PROJECT_ID,
    kind,
    generator_id: 'scanpy',
    generator_version: '1.10.2',
    seed,
    status: 'succeeded',
    captured_at: '2026-07-15T12:00:00Z',
    acting_user: 'ada@example.org',
    code_sha256: 'a'.repeat(64),
    env_rootfs_sha256: 'b'.repeat(64),
    params: { n_neighbors: 15, resolution: 1.0 },
    inputs: [{ slot: 'input', kind: 'artifact', ref_id: ARTIFACT_ID, content_hash: 'c'.repeat(64) }],
    ...over,
  }
}

const SEED_RUNS: RunNodeDto[] = [
  run('00000000-0000-4000-8000-0000000000d1', 'cluster', 42),
  run('00000000-0000-4000-8000-0000000000d2', 'embed', 7),
  // A filter run — the predicate surfaces (ITEM-9) render its criteria; and a run
  // with NO scientific params renders no predicate chrome.
  run('00000000-0000-4000-8000-0000000000d3', 'compute', undefined, {
    generator_id: 'cell.filter',
    params: {
      criteria: [
        { column: 'pct_counts_mito', control: 'range', max: 10 },
        { column: 'n_genes_by_counts', control: 'range', min: 500 },
      ],
      label: 'lowqc',
      seed: 7,
    },
  }),
  run('00000000-0000-4000-8000-0000000000d4', 'promote', undefined, { params: {} }),
]

const SEED_GRAPH: GraphDto = {
  runs: SEED_RUNS,
  roots: [{ id: ARTIFACT_ID, output_id: 'raw_counts', datatype: 'anndata', content_hash: 'c'.repeat(64), promotable: false }],
  readiness: {
    code_captured: true,
    env_pinned: true,
    inputs_checksummed: true,
    params_captured: true,
    seeds_set: false,
    roots_have_provenance: true,
    ready: false,
  },
}

function seedProject() {
  useProjectDetailStore.setState({
    projectId: PROJECT_ID,
    project: seededProject(),
  } as Partial<ReturnType<typeof useProjectDetailStore.getState>> as ReturnType<
    typeof useProjectDetailStore.getState
  >)
}

function seedProvenance(partial: Partial<ReturnType<typeof useProvenanceStore.getState>>) {
  useProvenanceStore.setState({
    projectId: PROJECT_ID,
    // Pre-mark as loaded so the panel's mount effect renders THIS seeded state
    // instead of refetching (offline, there is no backend) and clobbering it.
    loadedProjectId: PROJECT_ID,
    runs: [],
    total: 0,
    page: 1,
    perPage: 10,
    graph: null,
    readiness: null,
    loading: false,
    recording: false,
    error: null,
    ...partial,
  } as ReturnType<typeof useProvenanceStore.getState>)
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'provenance-settings-card',
      title: 'Provenance settings — admin card',
      note: 'The deployment-wide export/verify settings form, loaded.',
      path: '/settings/provenance',
      initialPath: '/settings/provenance',
      component: ProvenanceSettingsCard,
      setup: () => {
        useProvenanceSettingsStore.setState({
          settings: {
            export_bundle_max_bytes: 500 * 1024 * 1024,
            export_retention_days: 30,
            methods_llm_polish_enabled: false,
            verify_default_tolerance: 0.01,
            verify_time_budget_secs: 600,
            verify_size_budget_bytes: 2 * 1024 * 1024 * 1024,
            rootfs_gc_interval_secs: 21600,
            rootfs_cache_max_digests: 4,
          },
          loading: false,
          saving: false,
          error: null,
        } as ReturnType<typeof useProvenanceSettingsStore.getState>)
      },
    },
  ],
}
