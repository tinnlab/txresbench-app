// Multi-output artifact data (ITEM-24 / ITEM-25). One hook + one pure helper the
// artifact-review pane reads via the generated `ApiClient` directly (the data-plumbing
// rule). `useRunArtifacts` lists EXACTLY the artifacts a run produced — the
// deterministic replacement for the racy `pickNewest`-of-type. Its former companion
// `useRunNode` is re-exported at the bottom; see the note there for where it went.

import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { Artifact } from '@/api-client/types'

/**
 * Stable order for a run's produced artifacts (by `output_id` then `id`) — so a
 * multi-output run's cards never reorder between reads. This is the deterministic
 * core the old `pickNewest` lacked: `pickNewest` sorted ALL project artifacts of a
 * datatype by `created_at` and took [0], which races (a concurrent run of the same
 * kind, or two outputs of the same kind, could win). Listing by `run_id` returns
 * exactly THIS run's outputs.
 */
export function sortRunArtifacts(rows: Artifact[]): Artifact[] {
  return [...rows].sort((a, b) => a.output_id.localeCompare(b.output_id) || a.id.localeCompare(b.id))
}

export interface RunArtifactsState {
  artifacts: Artifact[]
  loading: boolean
  error: string | null
  reload: () => void
}

/** List the artifacts a run PRODUCED (ITEM-24): `listArtifacts({project_id, run_id})`,
 *  in a stable order. A null run id resolves to an empty, non-loading state.
 *
 *  The fetch is guarded by a per-effect `ignore` flag so a stale in-flight response
 *  (from a prior `runId`/reload) can never overwrite the current run's data — the host
 *  `ArtifactReview` stays mounted across `/artifacts/:kind/:runId`, so `runId` changes while
 *  a request is still in flight. `reload` bumps a nonce so it runs through the same guard. */
export function useRunArtifacts(projectId: string, runId: string | null): RunArtifactsState {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState<boolean>(!!runId)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = useCallback(() => setReloadNonce(n => n + 1), [])

  useEffect(() => {
    let ignore = false
    if (!runId) {
      setArtifacts([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    void ApiClient.Workstore.listArtifacts({ project_id: projectId, run_id: runId })
      .then(rows => {
        if (ignore) return
        setArtifacts(sortRunArtifacts(rows))
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
  }, [projectId, runId, reloadNonce])

  return { artifacts, loading, error, reload }
}

// `useRunNode` MOVED to `@/core/provenance` — its consumers span THREE extensions (jobs,
// provenance, analysis) and an extension may not reach into another extension's
// internals, so a read that three of them need is app-level shared infrastructure.
// Re-exported here so its existing importers are untouched by the move.
export { useRunNode, type RunNodeState } from '@/core/provenance'
