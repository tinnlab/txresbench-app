// Unit coverage for the draftable MOUNT-GLUE resolver (geneset ITEM-8c) — the seam the phase-6
// audit found had ZERO coverage. Proves the three reworked properties: StrictMode-safe in-flight
// dedup (no double-create), deterministic binding to an explicitly-threaded draft id, and a
// reload fallback SCOPED to the current user (never another project member's open draft).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Draft, DraftableSpec } from '@/api-client/types'

// The heavy action-registration side-effect import is irrelevant here — stub it.
vi.mock('./draftActions', () => ({}))

const drafts = new Map<string, Draft>()
const create = vi.fn(async (req: { kind: string; project_id: string; data: unknown }) => {
  const d: Draft = {
    id: `new-${drafts.size + 1}`,
    kind: req.kind,
    project_id: req.project_id,
    data: req.data,
    status: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
  drafts.set(d.id, d)
  return d
})
const get = vi.fn(async (id: string) => {
  const d = drafts.get(id)
  if (!d) throw new Error('404')
  return d
})
const listForProject = vi.fn(async (projectId: string, kind?: string) =>
  [...drafts.values()].filter(d => d.project_id === projectId && (!kind || d.kind === kind)),
)
const persist = vi.fn()

vi.mock('./Drafts.store', () => ({
  Drafts: {
    create: (...a: unknown[]) => create(...(a as [never])),
    get: (id: string) => get(id),
    listForProject: (p: string, k?: string) => listForProject(p, k),
    persist: (...a: unknown[]) => persist(...a),
  },
}))

let currentUser: string | undefined = 'user-A'
vi.mock('@txresbench/framework/permissions', () => ({
  authStoreProxy: () => ({ $: { user: currentUser ? { id: currentUser } : null } }),
}))

import {
  resolveDraftBinding,
  setDraftLaunchIntent,
  unbindDraftInstance,
  __resetDraftInstancesForTests,
} from './draftBinding'

// A neutral opaque kind — the resolver is DOMAIN-FREE, so the test needs no real package id.
const KIND = 'demo/kind'
const PROJECT = 'proj-1'
const draftable: DraftableSpec = { kind: KIND, freeze: 'demo.freeze' } as DraftableSpec

function seed(id: string, patch: Partial<Draft>): void {
  drafts.set(id, {
    id,
    kind: KIND,
    project_id: PROJECT,
    data: {},
    status: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...patch,
  })
}

beforeEach(() => {
  drafts.clear()
  create.mockClear()
  get.mockClear()
  listForProject.mockClear()
  currentUser = 'user-A'
  __resetDraftInstancesForTests()
})

describe('resolveDraftBinding', () => {
  it('dedups a StrictMode double-invoke — a first open creates exactly ONE draft', async () => {
    // Two concurrent resolves for the same viewId (StrictMode mount→remount), no existing draft.
    const [a, b] = await Promise.all([
      resolveDraftBinding('view-1', draftable, PROJECT),
      resolveDraftBinding('view-1', draftable, PROJECT),
    ])
    expect(create).toHaveBeenCalledTimes(1)
    // Both callers get a binding seeded from the SAME created draft.
    expect(a.data).toEqual(b.data)
  })

  it('binds the EXPLICIT launcher-threaded draft id, not a most-recent guess', async () => {
    seed('older', { updated_at: '2026-02-01T00:00:00Z', data: { name: 'older' } })
    seed('target', { updated_at: '2026-01-01T00:00:00Z', data: { name: 'target' } })
    // Even though `older` is the most-recently-updated, the intent pins `target`.
    setDraftLaunchIntent('view-1', 'target')
    const binding = await resolveDraftBinding('view-1', draftable, PROJECT)
    expect(binding.data).toEqual({ name: 'target' })
    expect(create).not.toHaveBeenCalled()
  })

  it('reload fallback resumes the CURRENT USER\'s most-recent open draft, never another member\'s', async () => {
    // Member B's draft is the most-recently-updated OPEN draft in the shared project.
    seed('b-draft', { created_by: 'user-B', updated_at: '2026-03-01T00:00:00Z', data: { name: 'B' } })
    seed('a-draft', { created_by: 'user-A', updated_at: '2026-02-01T00:00:00Z', data: { name: 'A' } })
    const binding = await resolveDraftBinding('view-1', draftable, PROJECT)
    // Bound to A's (the current user's) draft — B's is never taken over.
    expect(binding.data).toEqual({ name: 'A' })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a fresh draft when none is bound, intended, or resumable', async () => {
    const binding = await resolveDraftBinding('view-1', draftable, PROJECT)
    expect(create).toHaveBeenCalledTimes(1)
    expect(binding.data).toEqual({})
  })

  // ── round-2 HIGH: an explicit launch intent MUST beat a STALE bound instance ──────────────
  // The uncovered SECOND-use path: the first open binds draft A to the view; a second
  // New-collection / Edit-fork threads a fresh intent for the SAME view. Resolving again must
  // bind the NEW draft, never resume the stale bound A.
  it('a SECOND launch intent wins over the already-bound draft (New → New binds the new draft)', async () => {
    // First open: no intent, no drafts → creates draft A, binds view-1 to it.
    seed('A', { data: { name: 'A' } })
    setDraftLaunchIntent('view-1', 'A')
    const first = await resolveDraftBinding('view-1', draftable, PROJECT)
    expect(first.data).toEqual({ name: 'A' })

    // Second New-collection: a NEW draft B is created + its intent threaded for the SAME view.
    // (`launchEditorBoundTo` unbinds first; here we assert intent-precedence directly.)
    seed('B', { data: { name: 'B' } })
    setDraftLaunchIntent('view-1', 'B')
    const second = await resolveDraftBinding('view-1', draftable, PROJECT)
    expect(second.data).toEqual({ name: 'B' })
    expect(create).not.toHaveBeenCalled()
  })

  it('an Edit-fork after a prior open binds the FORK content, not the previously-open draft (INV-6)', async () => {
    // Prior open collection bound to the view. `values` is a NEUTRAL field — the resolver is
    // DOMAIN-FREE, so the test uses no domain noun (the fork seed is opaque `data`).
    seed('open-1', { data: { name: 'current', sets: [{ name: 'S', values: ['A'] }] } })
    setDraftLaunchIntent('view-1', 'open-1')
    await resolveDraftBinding('view-1', draftable, PROJECT)

    // Edit → new version: a fork draft SEEDED from the frozen structure, threaded for the view.
    seed('fork-1', { data: { name: 'current', sets: [{ name: 'S', values: ['A', 'B'] }] } })
    unbindDraftInstance('view-1') // what launchEditorBoundTo does before setting the new intent
    setDraftLaunchIntent('view-1', 'fork-1')
    const forked = await resolveDraftBinding('view-1', draftable, PROJECT)
    expect(forked.data).toEqual({ name: 'current', sets: [{ name: 'S', values: ['A', 'B'] }] })
    // The prior draft is untouched (never persisted-over by the fork bind).
    expect(drafts.get('open-1')?.data).toEqual({ name: 'current', sets: [{ name: 'S', values: ['A'] }] })
  })

  // ── round-2 MEDIUM: the reload fallback must FAIL SAFE when the acting identity is unknown ──
  it('does NOT bind any member draft when the current user is unknown (auth-null window)', async () => {
    currentUser = undefined // auth not hydrated yet (fresh reload)
    // Two OPEN drafts belonging to other members — neither may be bound to the unknown user.
    seed('b-draft', { created_by: 'user-B', updated_at: '2026-03-01T00:00:00Z', data: { name: 'B' } })
    seed('c-draft', { created_by: 'user-C', updated_at: '2026-02-01T00:00:00Z', data: { name: 'C' } })
    const binding = await resolveDraftBinding('view-1', draftable, PROJECT)
    // No cross-user takeover: it created a FRESH draft rather than binding B's or C's.
    expect(create).toHaveBeenCalledTimes(1)
    expect(binding.data).toEqual({})
  })

  it('never binds a null-created_by row to the current user (fail-safe filter)', async () => {
    // An unattributed open draft (created_by null) must not be resumed as "mine". The generated
    // `Draft.created_by` is typed `string | undefined`, but the wire value CAN be JSON null (an
    // Option<Uuid> that serialized null) — the runtime that this test guards, so the cast is exact.
    seed('orphan', {
      created_by: null as unknown as string | undefined,
      updated_at: '2026-03-01T00:00:00Z',
      data: { name: 'orphan' },
    })
    const binding = await resolveDraftBinding('view-1', draftable, PROJECT)
    expect(create).toHaveBeenCalledTimes(1)
    expect(binding.data).toEqual({})
  })
})
