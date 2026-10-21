import { describe, it, expect } from 'vitest'
import { ARTIFACT_DETAIL_ROUTE, LEGACY_RESULT_DETAIL_ROUTE, artifactDetailPath } from './artifactRoutes'

// ITEM-25 — the `result` → `artifact` rename moved a BOOKMARKABLE url. The legacy path must stay
// resolvable (registered + redirecting), so both patterns and the mapping between them are pinned
// here; the live routing (that `module.tsx` registers both and the legacy one actually redirects)
// is covered end-to-end by `tests/e2e/14-workbench/artifact-detail-route.spec.ts`.
describe('artifact-detail route + legacy alias (ITEM-25)', () => {
  it('the current route is the artifact path; the legacy alias is the pre-rename results path', () => {
    expect(ARTIFACT_DETAIL_ROUTE).toBe('/projects/:id/artifacts/:kind/:runId')
    expect(LEGACY_RESULT_DETAIL_ROUTE).toBe('/projects/:id/results/:kind/:runId')
    // Same shape (same params, same arity) — the legacy path differs ONLY in the entity segment,
    // which is what makes a parameter-for-parameter redirect correct.
    expect(LEGACY_RESULT_DETAIL_ROUTE.replace('/results/', '/artifacts/')).toBe(ARTIFACT_DETAIL_ROUTE)
  })

  it('maps a legacy bookmark onto the current path, parameter for parameter', () => {
    expect(artifactDetailPath({ id: 'p1', kind: 'run', runId: 'r1' })).toBe('/projects/p1/artifacts/run/r1')
  })

  it('encodes each segment so a slashed produced kind cannot split into extra path segments', () => {
    expect(artifactDetailPath({ id: 'p1', kind: 'report/qc', runId: 'r1' })).toBe(
      '/projects/p1/artifacts/report%2Fqc/r1',
    )
  })

  it('missing params degrade to empty segments rather than `undefined` in the url', () => {
    expect(artifactDetailPath({})).toBe('/projects//artifacts//')
  })
})
