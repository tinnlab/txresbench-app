// The shared PROVENANCE-RUN read (`GET /api/provenance/runs/{id}` → `RunNodeDto`),
// through the generated `ApiClient` (DEC-11 — no raw fetch), mirroring the role
// `core/workstore/catalog.ts` plays for the workstore control plane.
//
// ── WHY IT IS APP-LEVEL AND NOT IN A WORKBENCH EXTENSION ────────────────────────────
//
// It used to live in `modules/workbench/extensions/jobs/useRunArtifacts.ts`, next to the
// workstore read it is usually paired with. But its consumers span THREE workbench
// extensions — jobs (`RunPane`/`ArtifactReview` neighbourhood), provenance
// (`ArtifactLineage`, `ProvenanceView`) and analysis (`RerunPane`) — and an extension may
// not reach into another extension's internals (the `lint-layer-boundary` INV-3/INV-8
// rule; every such edge today is recorded debt). A read with three extension consumers is
// shared infrastructure, so it sits where all three may legitimately import it. Workbench
// `core/` is not that place either: `core/index.ts` is a strip-types-loadable, surface-
// baselined barrel and must not pull `@/api-client` in behind it.
//
// `extensions/jobs/useRunArtifacts` re-exports it so its existing importers are unmoved.

import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { RunNodeDto } from '@/api-client/types'

export interface RunNodeState {
  run: RunNodeDto | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * Read a run's provenance node — its `inputs[]` + `generator_id` + `status` for a lineage
 * chain, and the `params` the run was GIVEN for a parameters panel.
 *
 * A null run id resolves to an empty, non-loading state and issues NO request, so an
 * artifact with no producing run (a source/upload artifact) costs nothing to render.
 *
 * The fetch is guarded by a per-effect `ignore` flag so a stale in-flight response (from a
 * prior `runId`/reload) can never overwrite the current run's node — the host panes stay
 * mounted while the run id changes underneath them. `reload` bumps a nonce so it runs
 * through the same guard.
 */
export function useRunNode(runId: string | null): RunNodeState {
  const [run, setRun] = useState<RunNodeDto | null>(null)
  const [loading, setLoading] = useState<boolean>(!!runId)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = useCallback(() => setReloadNonce(n => n + 1), [])

  useEffect(() => {
    let ignore = false
    if (!runId) {
      setRun(null)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    void ApiClient.Provenance.run({ id: runId })
      .then(node => {
        if (ignore) return
        setRun(node)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (ignore) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [runId, reloadNonce])

  return { run, loading, error, reload }
}
