import { describe, it, expect, beforeEach, vi } from 'vitest'

// EVERY JOBS FETCH FEEDS THE NAME LOOKUP — asserted per FETCH SITE, because the sites mask
// each other in the app.
//
// A workbench tab is named by whichever fetch happened to run: the status bar's project poll, a
// mounted Jobs pane's list, or a detail load. In an end-to-end run at least one of them always
// fires, so deleting any single `rememberJobNames` call leaves the tab correctly named and no
// journey notices. That makes each call individually unfalsifiable there.
//
// This file holds the window for the SHARED lifecycle's two sites (`load` and `select`), with the
// ApiClient — the external boundary, and only that — replaced. The status bar's own site is held
// by `tests/e2e/14-workbench/region-tab-strip.spec.ts`, which opens a jobs pane WITHOUT
// activating it: no Jobs pane mounts, so nothing but the status-bar poll can supply the name.

const list = vi.fn()
const get = vi.fn()
const stream = vi.fn(() => Promise.resolve())

vi.mock('@/api-client', () => ({
  ApiClient: { Jobs: { list, get, stream } },
}))
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => true }))

const { createJobsLifecycle } = await import('./jobsLifecycle')
const { jobDisplayName, __resetJobNames } = await import('./jobNames')

/** The minimum store shape the lifecycle writes into — a plain object with an immer-style `set`. */
function harness() {
  const state = {
    jobs: [] as unknown[],
    total: 0,
    page: 1,
    perPage: 10,
    loading: false,
    error: null as string | null,
    selectedId: null as string | null,
    detail: null as unknown,
    detailLoading: false,
    streaming: false,
  }
  const set = (fn: (s: typeof state) => void) => fn(state)
  return { state, lifecycle: createJobsLifecycle(set as never, () => state as never, {
    buildListQuery: (page, perPage) => ({ page, per_page: perPage }),
  }) }
}

describe('the jobs lifecycle teaches jobNames what it fetched', () => {
  beforeEach(() => {
    __resetJobNames()
    list.mockReset()
    get.mockReset()
    stream.mockReset()
    stream.mockImplementation(() => Promise.resolve())
  })

  it('a LIST load names every job on the page', async () => {
    // The LIST wire shape: rows of `{ job, can_stop }`, not bare jobs.
    list.mockResolvedValue({
      jobs: [
        { job: { id: 'j1', name: 'Nightly run', job_type: 'demo.filter', status: 'running' }, can_stop: true },
        { job: { id: 'j2', name: '', job_type: 'stub', status: 'completed' }, can_stop: false },
      ],
      total: 2,
      page: 1,
      per_page: 10,
    })
    const { lifecycle } = harness()
    await lifecycle.load(1)
    expect(jobDisplayName('j1')).toBe('Nightly run')
    expect(jobDisplayName('j2')).toBe('stub')
  })

  it('a DETAIL load names a job the list never carried', async () => {
    // The window this site owns: a job that has fallen off the list's first page is named by
    // nothing else. Opening its detail is the only remaining route to its name.
    get.mockResolvedValue({
      job: { id: 'old', name: 'Archived sweep', job_type: 'stub', status: 'completed' },
      logs: [],
      metrics: [],
      can_stop: false,
    })
    const { lifecycle } = harness()
    expect(jobDisplayName('old'), 'unknown before the detail load').toBeNull()
    await lifecycle.select('old')
    expect(jobDisplayName('old')).toBe('Archived sweep')
  })
})
