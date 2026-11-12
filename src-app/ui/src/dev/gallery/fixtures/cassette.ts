// TxResBench gallery mock-API cassette + auth seed.
//
// Keys are ApiEndpoint keys ("NS.method"); the @txresbench/gallery mock engine matches
// a request path back to its key and serves this. Dev-only — `as any` casts are
// fine here (the cassette is not the type source of truth). `empty`/`error`
// states are derived by the engine, so we only supply the LOADED response.

import type { Cassette } from '@txresbench/gallery'

const adminUser = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'admin',
  email: 'admin@txresbench.test',
  email_verified: true,
  display_name: 'Admin',
  avatar_url: null,
  is_active: true,
  is_admin: true,
  permissions: ['*'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const researcher = {
  ...adminUser,
  id: '00000000-0000-0000-0000-000000000002',
  username: 'researcher',
  email: 'researcher@txresbench.test',
  display_name: 'Researcher',
  is_admin: false,
  permissions: [],
}

const administratorsGroup = {
  id: '00000000-0000-0000-0000-0000000000a1',
  name: 'Administrators',
  description: 'Full access',
  permissions: ['*'],
  is_active: true,
  is_system: true,
  is_protected: true,
  member_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const sampleJob = (over: Record<string, unknown>) => ({
  id: '00000000-0000-0000-0000-0000000000f0',
  owner_id: adminUser.id,
  job_type: 'stub',
  name: 'Clustering',
  status: 'running',
  params: {},
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:01Z',
  finished_at: null,
  exit_code: null,
  error: null,
  pid: 4242,
  ...over,
})

export const galleryCassette: Cassette = {
  'Auth.me': { user: adminUser, permissions: ['*'] } as any,
  // Jobs concurrency settings (the /settings/jobs page).
  'Jobs.getSettings': {
    max_concurrent_jobs: 2,
    updated_at: '2026-01-01T00:00:00Z',
  } as any,
  // A populated, mixed-status job list (the drawer list view).
  // Rows are `{ job, can_stop }` — the wire shape of `GET /api/jobs`. `can_stop` is the
  // server's per-row answer to "may THIS caller stop THIS job" (creator / scope owner /
  // admin), which the Stop control renders directly. The QUEUED row is seeded refused so the
  // cassette exercises the shown-and-unavailable state, not only the happy one; the running
  // row agrees with `Jobs.get` below, which is the same job.
  'Jobs.list': {
    jobs: [
      { job: sampleJob({ id: 'j1', name: 'Clustering', status: 'running' }), can_stop: true },
      { job: sampleJob({ id: 'j2', name: 'Differential expression', status: 'queued', started_at: null, pid: null }), can_stop: false },
      { job: sampleJob({ id: 'j3', name: 'UMAP embedding', status: 'completed', finished_at: '2026-01-01T00:02:00Z', exit_code: 0, pid: null }), can_stop: false },
      { job: sampleJob({ id: 'j4', name: 'Enrichment', status: 'failed', finished_at: '2026-01-01T00:01:00Z', exit_code: 1, error: 'stub failure', pid: null }), can_stop: false },
    ],
    total: 4,
    page: 1,
    per_page: 10,
  } as any,
  'Jobs.get': {
    job: sampleJob({ id: 'j1', name: 'Clustering', status: 'running' }),
    can_stop: true,
    logs: [
      { id: 'l1', job_id: 'j1', seq: 1, stream: 'stdout', content: '[Clustering] step 1/5', created_at: '2026-01-01T00:00:02Z' },
      { id: 'l2', job_id: 'j1', seq: 2, stream: 'stdout', content: '[Clustering] step 2/5', created_at: '2026-01-01T00:00:03Z' },
    ],
    metrics: [
      { id: 'm1', job_id: 'j1', sampled_at: '2026-01-01T00:00:02Z', cpu_pct: 12.4, mem_bytes: 2_400_000 },
      { id: 'm2', job_id: 'j1', sampled_at: '2026-01-01T00:00:03Z', cpu_pct: 31.8, mem_bytes: 2_600_000 },
    ],
  } as any,
  // Runtime-discovered processors (the /settings/processors admin page). A mix of
  // loaded + skipped-with-error so the crawl-base page shows both badge states.
  'Processor.list': [
    { id: 'anndata-import', ok: true, version: '0.1.0' },
    { id: 'qc', ok: true, version: '0.1.0' },
    { id: 'cell-filter', ok: true, version: '0.1.0' },
    { id: 'broken-pkg', ok: false, version: '0.1.0', error: "broken-pkg: unknown key `bogus_key`" },
  ] as any,
  'Processor.reload': {
    packages: [
      { id: 'anndata-import', ok: true, version: '0.1.0' },
      { id: 'qc', ok: true, version: '0.1.0' },
      { id: 'cell-filter', ok: true, version: '0.1.0' },
    ],
    registered: 3,
  } as any,
  // Runtime view-spec source assets (H2). Empty in the gallery — the baked glob already
  // registered the seed packages' views; the runtime fetch just adds nothing here.
  'Processor.packages': { packages: [] } as any,
  'Auth.getSessionSettings': {
    access_token_expiry_hours: 24,
    refresh_token_expiry_days: 30,
  } as any,
  'Auth.listProviders': [] as any,
  'AuthProviders.list': [] as any,
  'User.list': {
    users: [adminUser, researcher],
    total: 2,
    page: 1,
    per_page: 20,
  } as any,
  'UserGroup.list': {
    groups: [administratorsGroup],
    total: 1,
    page: 1,
    per_page: 20,
  } as any,
  // ---- project module ----
  'Project.list': {
    projects: [
      {
        id: '00000000-0000-0000-0000-0000000000s1',
        owner_id: adminUser.id,
        name: 'PBMC atlas 2026',
        description: 'A representative single-cell project.',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        effective_permission: 'owner',
        dataset_count: 3,
      },
      {
        id: '00000000-0000-0000-0000-0000000000s2',
        owner_id: researcher.id,
        name: 'Shared tumor cohort',
        description: '',
        created_at: '2026-01-03T00:00:00Z',
        updated_at: '2026-01-03T00:00:00Z',
        effective_permission: 'editor',
        dataset_count: 0,
      },
    ],
    total: 2,
    page: 1,
    per_page: 20,
  } as any,
  'Project.get': {
    id: '00000000-0000-0000-0000-0000000000s1',
    owner_id: adminUser.id,
    name: 'PBMC atlas 2026',
    description: 'A representative single-cell project.',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    effective_permission: 'owner',
    dataset_count: 3,
  } as any,
  'Project.listDatasets': {
    datasets: [
      {
        id: '00000000-0000-0000-0000-0000000000d1',
        name: 'sample-1',
        description: '',
        n_cells: 5000,
        n_genes: 20000,
        status: 'uploaded',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    total: 1,
    page: 1,
    per_page: 20,
  } as any,
  'Project.listShares': {
    shares: [
      {
        id: '00000000-0000-0000-0000-0000000000h1',
        project_id: '00000000-0000-0000-0000-0000000000s1',
        recipient_id: researcher.id,
        recipient_username: 'researcher',
        recipient_email: 'researcher@txresbench.test',
        permission_level: 'editor',
        status: 'accepted',
        created_at: '2026-01-02T00:00:00Z',
      },
    ],
  } as any,
  'ProjectSettings.get': { transfer_enabled: true, updated_at: '2026-01-01T00:00:00Z' } as any,
  // ---- project-admin (cross-user) — a representative mixed-status deployment ----
  'ProjectAdmin.list': {
    rows: [
      {
        id: '00000000-0000-0000-0000-0000000000s1',
        owner_id: adminUser.id,
        name: 'PBMC atlas 2026',
        description: 'A representative single-cell project.',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-05T00:00:00Z',
        owner_username: adminUser.username,
        owner_email: 'admin@txresbench.test',
        owner_display_name: 'Admin User',
        owner_is_active: true,
        dataset_count: 3,
        share_count: 2,
        transfer_pending: false,
        is_orphaned: false,
        last_activity: '2026-01-05T00:00:00Z',
      },
      {
        id: '00000000-0000-0000-0000-0000000000s2',
        owner_id: researcher.id,
        name: 'Shared tumor cohort',
        description: '',
        created_at: '2026-01-03T00:00:00Z',
        updated_at: '2026-01-03T00:00:00Z',
        owner_username: researcher.username,
        owner_email: 'researcher@txresbench.test',
        owner_display_name: null,
        owner_is_active: true,
        dataset_count: 0,
        share_count: 0,
        transfer_pending: true,
        is_orphaned: false,
        last_activity: '2026-01-03T00:00:00Z',
      },
      {
        id: '00000000-0000-0000-0000-0000000000s3',
        owner_id: '00000000-0000-0000-0000-0000000000u9',
        name: 'Legacy cohort (Dr. Gone)',
        description: 'Owner left the team.',
        created_at: '2025-06-01T00:00:00Z',
        updated_at: '2025-09-01T00:00:00Z',
        owner_username: 'dgone',
        owner_email: 'dgone@txresbench.test',
        owner_display_name: 'Dr. Gone',
        owner_is_active: false,
        dataset_count: 5,
        share_count: 1,
        transfer_pending: false,
        is_orphaned: true,
        last_activity: '2025-09-01T00:00:00Z',
      },
    ],
    total: 3,
    page: 1,
    per_page: 10,
    stats: { total_projects: 3, distinct_owners: 3, orphaned_count: 1 },
  } as any,
  'ProjectAdmin.detail': {
    project: {
      id: '00000000-0000-0000-0000-0000000000s1',
      owner_id: adminUser.id,
      name: 'PBMC atlas 2026',
      description: 'A representative single-cell project.',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-05T00:00:00Z',
    },
    owner_username: adminUser.username,
    owner_email: 'admin@txresbench.test',
    owner_display_name: 'Admin User',
    owner_is_active: true,
    shares: [
      {
        id: '00000000-0000-0000-0000-0000000000h1',
        project_id: '00000000-0000-0000-0000-0000000000s1',
        recipient_id: researcher.id,
        recipient_username: 'researcher',
        recipient_email: 'researcher@txresbench.test',
        permission_level: 'editor',
        status: 'accepted',
        created_at: '2026-01-02T00:00:00Z',
      },
    ],
    datasets: [
      {
        id: '00000000-0000-0000-0000-0000000000d1',
        name: 'sample-1',
        description: '',
        n_cells: 5000,
        n_genes: 20000,
        status: 'uploaded',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    transfer: null,
  } as any,
  'ProjectAdmin.searchUsers': {
    users: [
      { id: researcher.id, username: 'researcher', email: 'researcher@txresbench.test', display_name: null, is_active: true },
      { id: '00000000-0000-0000-0000-0000000000u9', username: 'dgone', email: 'dgone@txresbench.test', display_name: 'Dr. Gone', is_active: false },
    ],
  } as any,
  'Dataset.list': [
    {
      id: '00000000-0000-0000-0000-0000000000d2',
      name: 'sample-2',
      description: '',
      n_cells: null,
      n_genes: null,
      status: 'created',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ] as any,
  // ---- notification module (the bell renders on every sidebar page) ----
  'Notification.list': {
    items: [
      {
        id: '00000000-0000-0000-0000-0000000000n1',
        user_id: adminUser.id,
        kind: 'project_share_invite',
        title: 'Project shared: PBMC atlas 2026',
        body: 'Researcher shared the project "PBMC atlas 2026" with you',
        interrupt: true,
        payload: { project_id: '00000000-0000-0000-0000-0000000000s1', share_id: '00000000-0000-0000-0000-0000000000h1' },
        read_at: null,
        created_at: '2026-01-03T00:00:00Z',
      },
    ],
    total: 1,
    unread: 1,
    page: 1,
    per_page: 20,
  } as any,
  'Notification.unreadCount': { unread: 1 } as any,
  'Notification.kinds': [
    { kind: 'project_share_invite', description: 'A user shared a project with you.' },
    { kind: 'project_transfer_invite', description: 'A user offered to transfer project ownership to you.' },
  ] as any,
  // Provenance (Reproducibility panel) — a well-formed run trust-view + backward
  // -closure graph so the project route crawl (or any load()) gets real data
  // instead of the safe-empty `[]` fallback (which crashed `graph.roots[0]`).
  'Provenance.runs': {
    runs: [
      {
        run_id: '00000000-0000-4000-8000-0000000000d1',
        project_id: '00000000-0000-4000-8000-0000000000c1',
        kind: 'cluster',
        generator_id: 'scanpy',
        generator_version: '1.10.2',
        seed: 42,
        status: 'succeeded',
        captured_at: '2026-07-15T12:00:00Z',
        acting_user: 'ada@example.org',
        code_sha256: 'a'.repeat(64),
        env_rootfs_sha256: 'b'.repeat(64),
        params: { n_neighbors: 15, resolution: 1.0 },
        inputs: [
          { slot: 'input', kind: 'artifact', ref_id: '00000000-0000-4000-8000-0000000000c2', content_hash: 'c'.repeat(64) },
        ],
      },
    ],
    total: 1,
    page: 1,
    per_page: 10,
  } as any,
  'Provenance.graph': {
    runs: [],
    roots: [
      { id: '00000000-0000-4000-8000-0000000000c2', output_id: 'raw_counts', datatype: 'anndata', content_hash: 'c'.repeat(64) },
    ],
    readiness: {
      code_captured: true,
      env_pinned: true,
      inputs_checksummed: true,
      params_captured: true,
      seeds_set: false,
      roots_have_provenance: true,
      ready: false,
    },
  } as any,
}

/**
 * Seed the Session store so an authenticated surface renders. The gallery calls
 * this with the `?auth=` mode BEFORE loadModules(): 'admin' = full-perm owner,
 * 'limited' = a user with no permissions, 'none' = logged out (the app itself
 * has no login screen; this is a gallery-only test mode).
 */
export async function seedAuth(auth: 'admin' | 'limited' | 'none'): Promise<void> {
  const { useSessionStore } = await import('@/modules/session/Session.store')
  if (auth === 'none') {
    useSessionStore.setState({
      user: null,
      permissions: [],
      ready: true,
    } as never)
    return
  }
  const user = auth === 'admin' ? adminUser : researcher
  useSessionStore.setState({
    user: user as never,
    permissions: user.permissions,
    ready: true,
  } as never)
}
