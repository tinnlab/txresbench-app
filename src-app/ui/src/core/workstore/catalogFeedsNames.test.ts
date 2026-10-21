// THE FEED, AND WHY IT NEEDS ITS OWN FIXTURE.
//
// `artifactNames` is deliberately fetch-free: it learns only from the fetches `catalog.ts`
// already performs. That claim is a WIRING claim, and nothing else in the suite can see it — the
// tab tests call `rememberArtifacts` directly (they are about the tab), and the `artifactNames`
// tests call it directly too (they are about the cache). Delete the three feed calls in
// `catalog.ts` and every one of those still passes while no artifact in the running app is ever
// named. This file is the only thing standing in that window.
//
// The mock is the HTTP boundary and nothing above it: the real `catalog.ts` runs, the real
// `artifactNames` runs, and only the generated client is stood in for.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const listArtifacts = vi.fn()
const getCatalog = vi.fn()
const getArtifact = vi.fn()

vi.mock('@/api-client', () => ({
  ApiClient: {
    Workstore: {
      listArtifacts: (...a: unknown[]) => listArtifacts(...a),
      getCatalog: (...a: unknown[]) => getCatalog(...a),
      getArtifact: (...a: unknown[]) => getArtifact(...a),
    },
  },
}))

const { listArtifacts: list, getCatalog: catalog, getArtifact: one } = await import('./catalog')
const { artifactDisplayName, __resetArtifactNames } = await import('./artifactNames')

beforeEach(() => {
  __resetArtifactNames()
  listArtifacts.mockReset()
  getCatalog.mockReset()
  getArtifact.mockReset()
})

describe('every artifact fetch feeds the ambient lookup', () => {
  it('the project artifact LIST names every row it returned', async () => {
    listArtifacts.mockResolvedValue([
      { id: 'a1', datatype: 'table' },
      { id: 'a2', datatype: 'other' },
    ])
    expect(artifactDisplayName('a1'), 'precondition: nothing knows it yet').toBeNull()

    const rows = await list('p1')
    expect(rows).toHaveLength(2)
    expect(artifactDisplayName('a1')).toContain('table')
    expect(artifactDisplayName('a2')).toContain('other')
  })

  it('the project CATALOG names the artifacts it carries', async () => {
    getCatalog.mockResolvedValue({ project_id: 'p1', axes: [], artifacts: [{ id: 'a3', datatype: 'table' }] })
    await catalog('p1')
    expect(artifactDisplayName('a3')).toContain('table')
  })

  it('the SINGLE-row load names it — the only fetch that reaches an artifact in no list', async () => {
    getArtifact.mockResolvedValue({ id: 'a4', datatype: 'table' })
    await one('a4')
    expect(artifactDisplayName('a4')).toContain('table')
  })

  it('a catalog with no artifacts field does not throw — the wrapper still returns it', async () => {
    // The negative control for the feed being defensive rather than assuming: an endpoint that
    // answers without the list must not take the caller down.
    getCatalog.mockResolvedValue({ project_id: 'p1', axes: [] })
    await expect(catalog('p1')).resolves.toMatchObject({ project_id: 'p1' })
  })
})
