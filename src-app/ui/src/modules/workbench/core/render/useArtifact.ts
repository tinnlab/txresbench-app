// Small shared hook for the built-in default artifact renderers (StatCard /
// ProvenanceView / GenericResult). Each of those draws a produced result from
// its artifact metadata (shape / provenance), so they all need the same
// best-effort artifact read. Kept here (one place) so the three renderers stay
// thin + defensive rather than each re-implementing the fetch/loading/error dance.
//
// The RUN a produced artifact names is read by `@/core/provenance`'s `useRunNode` —
// app-level rather than workbench-level, because its consumers span three workbench
// extensions and an extension may not reach into another extension's internals.

import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { Artifact } from '@/api-client/types'

export interface UseArtifactResult {
  artifact: Artifact | null
  loading: boolean
  /** Human-facing error string (never surfaced raw — pass to ErrorState `details`). */
  error: string | null
  reload: () => void
}

/** Best-effort read of a single artifact's metadata. Never throws: a failed
 *  fetch resolves to `{ artifact: null, error }` so the caller can render a
 *  graceful error/empty state instead of crashing. */
export function useArtifact(artifactId: string): UseArtifactResult {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void ApiClient.Workstore.getArtifact({ id: artifactId })
      .then((a) => {
        if (cancelled) return
        setArtifact(a)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setArtifact(null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [artifactId, epoch])

  return { artifact, loading, error, reload: () => setEpoch((e) => e + 1) }
}
