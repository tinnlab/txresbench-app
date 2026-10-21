import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type {
  Dataset,
  DatasetFolder,
  DatasetShare,
  DatasetWithFiles,
  Datatype,
  ForwardGraphDto,
} from '@/api-client/types'
import type { AnalysisContribution } from '@/modules/workbench/core'
import { useDatasetsStore } from '@/modules/datasets/stores/Datasets.store'
import { useDatasetDetailStore } from '@/modules/datasets/stores/DatasetDetail.store'
import { PipelineTimeline } from '@/modules/datasets/components/PipelineTimeline'
import { LineageView } from '@/modules/datasets/components/LineageView'
import { UploadPanel } from '@/modules/datasets/components/UploadPanel'
import { BOOTSTRAP_LATTICE, datatypeRegistry, type Datatype as CoreDatatype } from '@/core/datatypes'
import { ShareDialog } from '@/modules/datasets/components/ShareDialog'
import { AttachToProjectDialog } from '@/modules/datasets/components/AttachToProjectDialog'
import type { ProcessorOption } from '@/modules/datasets/lib/workbench'

// ── seed fixtures ──────────────────────────────────────────────────────────────
const OWNER = '00000000-0000-4000-8000-00000000000f'
const DETAIL_ID = '00000000-0000-4000-8000-0000000000d1'
const F1 = '00000000-0000-4000-8000-0000000000f1'
const F2 = '00000000-0000-4000-8000-0000000000f2'

function ds(id: string, name: string, opts: Partial<Dataset> = {}): Dataset {
  return {
    id,
    owner_id: OWNER,
    account_id: OWNER,
    name,
    datatype: 'single-cell/expression',
    source: 'upload',
    metadata: {},
    content_hash: 'sha256:1a2b3c4d5e6f7788990011223344556677889900aabbccddeeff001122334455',
    created_at: '2026-07-10T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    ...opts,
  }
}

const seedMine: Dataset[] = [
  ds(DETAIL_ID, 'PBMC_donor1'),
  ds('00000000-0000-4000-8000-0000000000d2', 'Visium_slideA', { datatype: 'spatial/visium' }),
  ds('00000000-0000-4000-8000-0000000000d3', 'run3_fastqs', { datatype: 'sequence/fastq' }),
  ds('00000000-0000-4000-8000-0000000000d4', 'PBMC filtered', {
    source: 'promote',
    source_artifact_id: '00000000-0000-4000-8000-0000000000a9',
  }),
]
const seedShared: Dataset[] = [
  ds('00000000-0000-4000-8000-0000000000e1', 'Shared atlas (from Dana)', { owner_id: 'someone-else' }),
]
const seedFolders: DatasetFolder[] = [
  { id: F1, owner_id: OWNER, name: 'PBMC atlas', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: F2, owner_id: OWNER, name: 'Spatial', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
]

const seedDetail: DatasetWithFiles = {
  ...ds(DETAIL_ID, 'PBMC_donor1'),
  metadata: { n_obs: 11214, n_vars: 36601, layers: ['counts'] },
  files: [
    { file_id: 'file-1', filename: 'PBMC_donor1.h5ad', file_size: 148_800_000, ordinal: 0, role: 'primary' },
    {
      file_id: 'file-2',
      filename: 'cell_types.csv',
      file_size: 412_000,
      ordinal: 1,
      role: 'supporting',
      kind: 'annotation_table',
      integration_status: 'integrated',
      integration_summary: { matched: 3410, missing: 12, extra: 5 },
    },
    {
      file_id: 'file-3',
      filename: 'gene_panel.tsv',
      file_size: 88_000,
      ordinal: 2,
      role: 'supporting',
      kind: 'annotation_table',
      integration_status: 'failed',
      integration_summary: { error: 'Duplicate key `ENSG00000141510` in the annotation table' },
    },
    // Queued (pending): just linked, integrate job enqueued but not yet started.
    {
      file_id: 'file-4',
      filename: 'donor_meta.csv',
      file_size: 21_000,
      ordinal: 3,
      role: 'supporting',
      kind: 'annotation_table',
      integration_status: 'pending',
    },
    // Running: the integrate converter is aligning the table onto its axis.
    {
      file_id: 'file-5',
      filename: 'clusters.tsv',
      file_size: 64_500,
      ordinal: 4,
      role: 'supporting',
      kind: 'annotation_table',
      integration_status: 'running',
    },
  ],
}

// The datatype catalog the add-supporting-file form reads (declared axes). Cast to
// the wire type — a gallery fixture only needs the fields the surface consumes.
const seedDatatypes = [
  {
    id: 'single-cell/expression',
    title: 'Single-cell expression',
    description: 'A cells × genes expression matrix.',
    axes: [
      { name: 'cells', key_label: 'barcode' },
      { name: 'genes', key_label: 'gene_id' },
    ],
  },
] as Datatype[]

const seedForward: ForwardGraphDto = {
  dataset_id: DETAIL_ID,
  content_hash: seedDetail.content_hash!,
  runs: [
    {
      run_id: 'run-qc',
      kind: 'analysis',
      generator_id: 'qc-10x',
      generator_version: '1.0.0',
      status: 'completed',
      captured_at: '2026-07-15T01:00:00Z',
      inputs: [],
      project_id: '',
    },
  ],
  outputs: [
    // A dataset-INPUT artifact (a workflow-produced AnnData) → promotable: the row
    // offers Promote. A component object (report/html) → not promotable: no button.
    { id: 'art-qc', content_hash: 'sha256:aabb', datatype: 'single-cell/anndata', output_id: 'filtered', run_id: 'run-qc', promotable: true },
    { id: 'art-viz', content_hash: 'sha256:ccdd', datatype: 'report/html', output_id: 'qc_report', run_id: 'run-qc', promotable: false },
  ],
}

const seedShares: DatasetShare[] = [
  {
    id: '00000000-0000-4000-8000-0000000000c1',
    dataset_id: DETAIL_ID,
    principal_type: 'user',
    principal_id: '00000000-0000-4000-8000-0000000000b1',
    role: 'view',
    created_at: '2026-07-12T00:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-0000000000c2',
    dataset_id: DETAIL_ID,
    principal_type: 'group',
    principal_id: '00000000-0000-4000-8000-0000000000b2',
    role: 'edit',
    created_at: '2026-07-13T00:00:00Z',
  },
]

// ── deterministic pipeline processor options (gallery-only; avoids mutating the
//    shared workbench registry) ─────────────────────────────────────────────────
function analysis(over: Partial<AnalysisContribution> & { id: string; title: string }): AnalysisContribution {
  return {
    extensionId: 'cyto.demo',
    apiVersion: '1.0.0',
    category: 'qc',
    appliesTo: [],
    produces: ['single-cell/expression'],
    run: { kind: 'sandbox', runtime: 'python', entry: 'compute/x.py' },
    schedule: { class: 'normal' },
    ...over,
  } as AnalysisContribution
}

const DEMO_PROCESSORS: ProcessorOption[] = [
  {
    contribution: analysis({
      id: 'qc.10x',
      title: 'QC (10x)',
      description: 'Per-cell QC metrics + threshold filtering',
    }),
    availability: { available: true, runnable: true },
  },
  {
    contribution: analysis({
      id: 'cellranger.count',
      title: 'Cell Ranger count',
      description: '10x fastq → filtered matrix (x86_64-only)',
      arch: ['x86_64'],
      run: { kind: 'sandbox', runtime: 'python', entry: 'compute/cr.py' },
    }),
    availability: { available: true, runnable: false, reason: 'requires an x86_64 backend' },
  },
]

// ── wizard demo files (tiny stand-ins so the type-first UploadPanel can render
//    its picked-file rows deterministically; File is a browser global) ──────────
const h5adFile = new File(['x'], 'PBMC_donor1.h5ad')
const mtxFile = new File(['x'], 'matrix.mtx.gz')
const barcodesFile = new File(['x'], 'barcodes.tsv.gz')
const featuresFile = new File(['x'], 'features.tsv.gz')
const zipFile = new File(['x'], 'pbmc_10x.zip')
const cellsCsv = new File(['x'], 'cell_types.csv')

// ── ITEM-6 / ITEM-8 — POPULATED Folder-mode states ───────────────────────────
//
// The Folder arm matches ONE picked directory against the container's declared
// members by the declared-depth rule, so the only way to render it populated is to
// seed BOTH halves: a declaration that carries directories, and a picked list whose
// entries carry relative paths.
//
// The declaration seeded here is SYNTHETIC and deliberately neutral. The real
// containers live as DATA in the contributed package manifests, which the gallery
// never loads (its mock cassette serves no datatype catalog, so the registry stays on
// the bootstrap roots), and `scripts/lint-no-domain-in-builtin.mjs` is what keeps a
// vendor declaration out of the app surface — this file included. What these states
// exist to show is the SURFACE: twelve rows bound to twelve distinct paths, a row
// that found nothing, a row that found several, and the dropped-directory refusal.

/** A picked entry that carries its directory-relative path (what a directory picker
 *  produces; `webkitRelativePath` is read-only, hence `defineProperty`). */
function pickedAt(path: string): File {
  const f = new File(['x'], path.slice(path.lastIndexOf('/') + 1))
  Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

const BINS = ['grid_002', 'grid_008', 'grid_016']
/** The four per-bin declared names, at the TWO depths a nested container really has
 *  (one beside the bin directory, three under its own sub-directory). */
const PER_BIN = ['counts.h5', 'geo/positions.parquet', 'geo/scale.json', 'geo/preview.png']

/** The twelve depth-carrying members (4 x 3 bins) — three of them share a basename. */
const NESTED_MEMBERS = BINS.flatMap(b => PER_BIN.map(n => `${b}/${n}`))
/** The same four names declared FLAT — over the nested tree every one of them has
 *  three candidates, which is the ambiguity state. */
const FLAT_MEMBERS = PER_BIN.map(n => n.slice(n.lastIndexOf('/') + 1))

/** A realistic picked tree: the twelve declared entries under an arbitrary root the
 *  user chose the name of, plus the noise a real run directory carries. */
const PICKED_TREE: File[] = [
  ...NESTED_MEMBERS.map(m => pickedAt(`RunA_outs/binned/${m}`)),
  pickedAt('RunA_outs/summary.html'),
  pickedAt('RunA_outs/binned/grid_008/stats/groups/table.csv'),
  pickedAt('RunA_outs/binned/grid_002/counts/values.bin.gz'),
]
/** The same tree with one bin's two `geo/` tables absent. */
const PICKED_TREE_INCOMPLETE = PICKED_TREE.filter(
  f => !/grid_016\/geo\/(scale\.json|positions\.parquet)$/.test(f.webkitRelativePath),
)
/** DEC-7 — a DROPPED directory yields top-level entries with no relative path at all. */
const DROPPED_TREE: File[] = ['summary.html', 'counts.h5'].map(n => new File(['x'], n))
/** TWO complete runs picked at once: every declared member has two candidates, so the
 *  panel refuses by name rather than taking one of each. */
const PICKED_TREE_TWO_RUNS: File[] = [
  ...NESTED_MEMBERS.map(m => pickedAt(`Experiments/RunA_outs/binned/${m}`)),
  ...NESTED_MEMBERS.map(m => pickedAt(`Experiments/RunB_outs/binned/${m}`)),
]
/** One bin taken from each of two DIFFERENT runs. Every member binds exactly once — so
 *  nothing is ambiguous — and the result would be a bundle whose three resolutions are
 *  two different specimens. The panel must refuse it BEFORE the transfer. */
const PICKED_TREE_SCATTERED: File[] = NESTED_MEMBERS.map((m, i) =>
  pickedAt(`Experiments/Run${'ABC'[Math.floor(i / PER_BIN.length)]}_outs/binned/${m}`),
)

const NESTED_TYPE = 'demo/nested-container'
/** A declaration whose two members can be satisfied by ONE file — an ambiguous
 *  DECLARATION rather than a bad pick, and the one refusal branch with no entry. */
const OVERLAP_TYPE = 'demo/overlapping-container'
const OVERLAP_MEMBERS = ['grid_002/counts.h5', 'grid_002/counts.h5|grid_002/other.h5']
const FLAT_TYPE = 'demo/flat-container'

/** Seed the datatype registry with the two synthetic containers so the wizard has a
 *  declaration to render. The gallery's cassette serves no catalog, so this is the
 *  only way any manifest state renders populated at all. */
function seedContainers(): void {
  const container = (id: string, title: string, members: string[]): CoreDatatype =>
    ({
      id,
      extends: 'data/opaque',
      title,
      description: '',
      storage: {
        layout: { kind: 'opaque_as_is' },
        format: 'any',
        selector_map: {},
        file_layout: 'manifest',
        tiers: ['tier1_range_client_decode'],
      },
      capabilities: [],
      viewers: [],
      converters: [],
      is_abstract: false,
      input_requirements: { requires: 'manifest', members, allow_archive: true },
    }) as CoreDatatype
  datatypeRegistry.replaceAll([
    ...BOOTSTRAP_LATTICE,
    container(NESTED_TYPE, 'Nested container (12 members)', NESTED_MEMBERS),
    container(FLAT_TYPE, 'Flat container (4 members)', FLAT_MEMBERS),
    container(OVERLAP_TYPE, 'Overlapping container (2 members)', OVERLAP_MEMBERS),
  ])
}

/** Open the upload dialog with the synthetic containers registered. */
function openUploadWithContainers(): void {
  seedContainers()
  useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true } as DsState)
}

// ── seed helpers ─────────────────────────────────────────────────────────────
type DsState = ReturnType<typeof useDatasetsStore.getState>
type DetailState = ReturnType<typeof useDatasetDetailStore.getState>

const DS_DEFAULTS: Partial<DsState> = {
  items: seedMine,
  total: seedMine.length,
  mineTotal: seedMine.length,
  sharedTotal: seedShared.length,
  recent: seedMine.slice(0, 8),
  folders: seedFolders,
  folderMembers: { [DETAIL_ID]: [F1], '00000000-0000-4000-8000-0000000000d2': [F2] },
  tab: 'mine',
  activeFolderId: null,
  search: '',
  page: 1,
  pageSize: 20,
  loading: false,
  mutating: false,
  isInitialized: true,
  error: null,
  uploadOpen: false,
  shareTarget: null,
  shares: seedShares,
  sharesLoading: false,
  attachTarget: null,
  folderCreateOpen: false,
  uploading: false,
  uploadPct: 0,
  uploadError: null,
}

const DETAIL_DEFAULTS: Partial<DetailState> = {
  dataset: seedDetail,
  loading: false,
  error: null,
  tab: 'contents',
  forward: null,
  lineageLoading: false,
  lineageError: null,
  processJob: null,
  processError: null,
  submitting: false,
  promoting: false,
  datatypes: seedDatatypes,
  addingSupporting: false,
  addSupportingPct: 0,
  addSupportingError: null,
}

function seedDatasets(partial: Partial<DsState>) {
  return () => useDatasetsStore.setState({ ...DS_DEFAULTS, ...partial } as DsState)
}

function seedDetailState(partial: Partial<DetailState>) {
  return () => useDatasetDetailStore.setState({ ...DETAIL_DEFAULTS, ...partial } as DetailState)
}

// ── lazy demo wrappers (zero-prop components the gallery frame can mount) ────────
const PipelinePicker = lazy(async () => ({
  default: () => (
    <div className="p-4">
      <PipelineTimeline datasetId={DETAIL_ID} datatype="single-cell/expression" processorsOverride={DEMO_PROCESSORS} />
    </div>
  ),
}))
const PipelineRunning = lazy(async () => ({
  default: () => (
    <div className="p-4">
      <PipelineTimeline datasetId={DETAIL_ID} datatype="single-cell/expression" processorsOverride={[]} />
    </div>
  ),
}))
const LineagePanel = lazy(async () => ({
  default: () => (
    <div className="p-4">
      <LineageView datasetName="PBMC_donor1" />
    </div>
  ),
}))
const DetailPage = lazy(() =>
  import('@/modules/datasets/pages/DatasetDetailPage').then(m => ({ default: m.DatasetDetailPage })),
)
const LibraryPage = lazy(() =>
  import('@/modules/datasets/pages/DatasetsLibraryPage').then(m => ({ default: m.DatasetsLibraryPage })),
)

export const gallery: ModuleGallery = {
  // Mock-API seed for the auto-crawled `/datasets` library page + the detail
  // route's reads (typed against the generated api-client).
  cassette: {
    'Dataset.listMine': { items: seedMine, total: seedMine.length },
    'Dataset.listShared': { items: seedShared, total: seedShared.length },
    'Dataset.listFolders': seedFolders,
    'Dataset.listFolderDatasets': (ctx: { params: Record<string, string> }) =>
      seedMine.filter(d => (ctx.params.id === F1 ? d.id === DETAIL_ID : d.id === '00000000-0000-4000-8000-0000000000d2')),
    'Dataset.get': seedDetail,
    'Dataset.listShares': seedShares,
    'Provenance.forward': seedForward,
  },

  seeded: [
    {
      slug: 'datasets-library-folder',
      title: 'Library — folder filtered',
      note: 'A folder selected in the rail scopes the table.',
      path: '/datasets',
      initialPath: '/datasets',
      component: LibraryPage,
      setup: seedDatasets({ tab: 'mine', activeFolderId: F1 }),
    },
    {
      slug: 'datasets-library-shared',
      title: 'Library — shared with me',
      note: 'The Shared tab (no owner folders).',
      path: '/datasets',
      initialPath: '/datasets',
      component: LibraryPage,
      setup: seedDatasets({ tab: 'shared' }),
    },
    {
      slug: 'datasets-detail-contents',
      title: 'Dataset detail — Contents',
      note: 'Files + metadata inspector for a typed dataset.',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: DetailPage,
      setup: seedDetailState({ tab: 'contents' }),
    },
    {
      slug: 'datasets-supporting',
      title: 'Dataset detail — Supporting files',
      note: 'All four integration states — queued / running / integrated (with coverage) / failed (with reason); Add appears because the dataset is converted (TEST-18).',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: DetailPage,
      setup: seedDetailState({ tab: 'supporting', datatypes: seedDatatypes }),
    },
    {
      slug: 'datasets-supporting-unconverted',
      title: 'Dataset detail — Supporting (not converted)',
      note: 'An unconverted dataset (empty metadata): the Add control is hidden behind a convert-first hint.',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: DetailPage,
      setup: seedDetailState({
        tab: 'supporting',
        datatypes: seedDatatypes,
        dataset: { ...seedDetail, metadata: {}, files: [seedDetail.files[0]] },
      }),
    },
    {
      slug: 'datasets-pipeline-picker',
      title: 'Pipeline — processor picker',
      note: 'Applicable processors; an x86_64-only one is disabled with the reason (DEC-29).',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: PipelinePicker,
    },
    {
      slug: 'datasets-pipeline-running',
      title: 'Pipeline — running',
      note: 'A dataset-scoped process job streaming logs.',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: PipelineRunning,
      setup: seedDetailState({
        processJob: {
          jobId: 'job-1',
          name: 'QC (10x)',
          status: 'running',
          running: true,
          milestones: [
            { id: 'm1', job_id: 'job-1', milestone_id: 'read', status: 'done', detail: null, created_at: '2026-07-15T02:00:01Z' },
            { id: 'm2', job_id: 'job-1', milestone_id: 'detect_counts', status: 'done', detail: { note: 'raw counts' }, created_at: '2026-07-15T02:00:03Z' },
            { id: 'm3', job_id: 'job-1', milestone_id: 'embeddings', status: 'started', detail: null, created_at: '2026-07-15T02:00:05Z' },
          ],
          logs: [
            { id: 'l1', job_id: 'job-1', seq: 0, stream: 'stdout', content: 'Loading PBMC_donor1.h5ad …', created_at: '2026-07-15T02:00:00Z' },
            { id: 'l2', job_id: 'job-1', seq: 1, stream: 'stdout', content: 'Computing per-cell QC metrics …', created_at: '2026-07-15T02:00:05Z' },
          ],
        },
      }),
    },
    {
      slug: 'datasets-pipeline-completed',
      title: 'Pipeline — completed',
      note: 'A finished run; promote an output from Lineage.',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: PipelineRunning,
      setup: seedDetailState({
        processJob: {
          jobId: 'job-1',
          name: 'QC (10x)',
          status: 'completed',
          running: false,
          milestones: [
            { id: 'm1', job_id: 'job-1', milestone_id: 'read', status: 'done', detail: null, created_at: '2026-07-15T02:00:01Z' },
            { id: 'm2', job_id: 'job-1', milestone_id: 'detect_counts', status: 'done', detail: { note: 'raw counts' }, created_at: '2026-07-15T02:00:03Z' },
            { id: 'm3', job_id: 'job-1', milestone_id: 'embeddings', status: 'done', detail: { count: 2, names: ['UMAP', 'PCA'] }, created_at: '2026-07-15T02:00:07Z' },
            { id: 'm4', job_id: 'job-1', milestone_id: 'metadata', status: 'done', detail: { count: 32 }, created_at: '2026-07-15T02:00:09Z' },
          ],
          logs: [
            { id: 'l1', job_id: 'job-1', seq: 0, stream: 'stdout', content: 'Filtered 11214 → 8062 cells.', created_at: '2026-07-15T02:01:00Z' },
          ],
        },
      }),
    },
    {
      slug: 'datasets-lineage',
      title: 'Lineage — forward graph',
      note: 'Dataset → run → outputs with Promote.',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: LineagePanel,
      setup: seedDetailState({ forward: seedForward }),
    },
    {
      slug: 'datasets-lineage-empty',
      title: 'Lineage — empty',
      note: 'A dataset with no derivations yet.',
      path: '/datasets/:id',
      initialPath: `/datasets/${DETAIL_ID}`,
      component: LineagePanel,
      setup: seedDetailState({ forward: { dataset_id: DETAIL_ID, content_hash: '', runs: [], outputs: [] } }),
    },
  ],

  overlays: [
    {
      slug: 'datasets-upload-type-select',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — type not chosen',
      component: lazy(() => Promise.resolve({ default: UploadPanel })),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true } as DsState),
    },
    {
      slug: 'datasets-upload-h5ad',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — AnnData one file',
      component: lazy(() =>
        Promise.resolve({
          default: () => <UploadPanel initial={{ datatype: 'single-cell/anndata', single: h5adFile }} />,
        }),
      ),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true } as DsState),
    },
    {
      slug: 'datasets-upload-10x-files',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — 10x three slots',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: 'single-cell/matrix-mtx',
                inputMode: 'files',
                slots: { matrix: mtxFile, barcodes: barcodesFile, features: featuresFile },
              }}
            />
          ),
        }),
      ),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true } as DsState),
    },
    {
      slug: 'datasets-upload-10x-zip',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — 10x archive',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel initial={{ datatype: 'single-cell/matrix-mtx', inputMode: 'archive', archive: zipFile }} />
          ),
        }),
      ),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true } as DsState),
    },
    {
      slug: 'datasets-upload-annotations',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — with axis annotations',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: 'single-cell/anndata',
                single: h5adFile,
                supporting: { cells: cellsCsv },
              }}
            />
          ),
        }),
      ),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true } as DsState),
    },
    {
      slug: 'datasets-upload-uploading',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — uploading',
      component: lazy(() =>
        Promise.resolve({
          default: () => <UploadPanel initial={{ datatype: 'single-cell/anndata', single: h5adFile }} />,
        }),
      ),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, uploadOpen: true, uploading: true, uploadPct: 42 } as DsState),
    },
    {
      slug: 'datasets-upload-error',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — error',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: 'single-cell/matrix-mtx',
                inputMode: 'files',
                slots: { matrix: mtxFile, features: featuresFile },
              }}
            />
          ),
        }),
      ),
      open: () =>
        useDatasetsStore.setState({
          ...DS_DEFAULTS,
          uploadOpen: true,
          uploadError: '10x needs 3 files or a .zip — barcodes.tsv is missing',
        } as DsState),
    },
    // ── ITEM-8 — the Folder arm's render states, all POPULATED ────────────────
    {
      slug: 'datasets-upload-folder-empty',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder, nothing picked',
      component: lazy(() =>
        Promise.resolve({
          default: () => <UploadPanel initial={{ datatype: NESTED_TYPE, inputMode: 'folder' }} />,
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-upload-folder-matched',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder, 12 members bound',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{ datatype: NESTED_TYPE, inputMode: 'folder', folderFiles: PICKED_TREE }}
            />
          ),
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-upload-folder-missing',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder, two members absent',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: NESTED_TYPE,
                inputMode: 'folder',
                folderFiles: PICKED_TREE_INCOMPLETE,
              }}
            />
          ),
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-upload-folder-ambiguous',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder holding two complete runs',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: NESTED_TYPE,
                inputMode: 'folder',
                folderFiles: PICKED_TREE_TWO_RUNS,
              }}
            />
          ),
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-upload-folder-multiclaim',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder, one file claims two members',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: OVERLAP_TYPE,
                inputMode: 'folder',
                folderFiles: [pickedAt('RunA_outs/binned/grid_002/counts.h5')],
              }}
            />
          ),
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-upload-folder-scattered',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder, members from different runs',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{
                datatype: NESTED_TYPE,
                inputMode: 'folder',
                folderFiles: PICKED_TREE_SCATTERED,
              }}
            />
          ),
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-upload-folder-dropped',
      surface: 'src/modules/datasets/components/UploadPanel.tsx',
      title: 'Upload — folder dropped, not supported',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <UploadPanel
              initial={{ datatype: NESTED_TYPE, inputMode: 'folder', folderFiles: DROPPED_TREE }}
            />
          ),
        }),
      ),
      open: openUploadWithContainers,
    },
    {
      slug: 'datasets-share',
      surface: 'src/modules/datasets/components/ShareDialog.tsx',
      title: 'Share dialog',
      component: lazy(() => Promise.resolve({ default: ShareDialog })),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, shareTarget: seedMine[0] } as DsState),
    },
    {
      slug: 'datasets-attach',
      surface: 'src/modules/datasets/components/AttachToProjectDialog.tsx',
      title: 'Attach-to-project dialog',
      component: lazy(() => Promise.resolve({ default: AttachToProjectDialog })),
      open: () => useDatasetsStore.setState({ ...DS_DEFAULTS, attachTarget: seedMine[0] } as DsState),
    },
  ],
}
