// The deep-linkable ARTIFACT-detail route (ITEM-46) + the LEGACY path it replaced (ITEM-25).
//
// ITEM-25 renamed the invented `result` entity to `artifact` (INV-10: one server entity, one UI
// name), which moved a BOOKMARKABLE url: `/projects/:id/results/:kind/:runId` →
// `/projects/:id/artifacts/:kind/:runId`. A bare rename would 404 every existing bookmark and
// every link in someone's notes, so the legacy path stays REGISTERED and redirects (`replace`, so
// it does not pollute browser history) onto the current one. Keeping both paths + the mapping
// here — rather than inline in `module.tsx` — is what makes the mapping unit-testable.

/** The current deep-linkable artifact-detail route pattern. */
export const ARTIFACT_DETAIL_ROUTE = '/projects/:id/artifacts/:kind/:runId'

/** The pre-ITEM-25 path. Still registered, purely to redirect onto `ARTIFACT_DETAIL_ROUTE`. */
export const LEGACY_RESULT_DETAIL_ROUTE = '/projects/:id/results/:kind/:runId'

/** Build the concrete artifact-detail path from route params. `useParams` hands back DECODED
 *  segments, so each is re-encoded (a produced kind may legitimately contain a `/`, e.g.
 *  `report/qc`, which must not split into extra path segments). */
export function artifactDetailPath(params: { id?: string; kind?: string; runId?: string }): string {
  const enc = (v: string | undefined) => encodeURIComponent(v ?? '')
  return `/projects/${enc(params.id)}/artifacts/${enc(params.kind)}/${enc(params.runId)}`
}
