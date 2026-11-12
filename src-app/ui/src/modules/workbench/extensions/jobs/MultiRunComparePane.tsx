// MultiRunComparePane (ITEM-65) — the compare-N-runs host. Its `ref` is a comma-joined
// list of run ids. It loads each run's provenance node (params + label) and produced
// artifacts (observables), aligns them via `MultiRunCompareView`, and — when the runs
// share a produced kind — feeds their primary outputs into the existing compare seam
// (overlaid volcano / clustree). A picker adds more completed project runs to the set,
// so "select multiple runs → side-by-side compare" is reachable in-pane.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { EventBus } from '@txresbench/framework/stores'
import { Empty, ErrorState, SectionHeader, Select, Spinner, type SelectOption } from '@txresbench/kit'
import { ApiClient } from '@/api-client'
// Through `core/workstore/catalog`, NOT `ApiClient.Workstore.listArtifacts` directly:
// the wrapper feeds every fetched row into the ambient artifact-name cache
// (`rememberArtifacts`), which is how a workbench tab opened BY REF — with an artifact
// id and no row — can name itself. Reading around it made this pane's rows the only
// ones in the app that never contributed to that cache.
import { listArtifacts } from '@/core/workstore/catalog'
import type { Artifact, RunNodeDto } from '@/api-client/types'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { type WorkbenchPane, PaneScroll, compareRef, parseCompareRef } from '../../core/shell/dock/paneModel'
import { coerceRunParams } from '../analysis/rerun'
import { DEFAULT_RUNS_PER_PAGE, isCompletedRun, runLabel } from '../analysis/runHistory'
import { runObservables, type RunObservablesEntry } from './runDiff'
import { sortRunArtifacts } from './useRunArtifacts'
import { MultiRunCompareView } from './MultiRunCompareView'

// The ref GRAMMAR moved to `paneModel` — `panes.tsx` registers the subject resolver that reads
// it (a compare tab names the runs it compares), `core/` may never import `extensions/` (INV-8),
// and this component is loaded through `lazy()` so a grammar declared here would be pulled onto
// the boot path by the registration. Re-exported so this module stays the door its importers
// already knock on, exactly as `ArtifactPane` re-exports `parseArtifactRef`.
export { compareRef, parseCompareRef }

interface RunRow {
  entry: RunObservablesEntry
  artifacts: Artifact[]
}

/** Load N runs' nodes + produced artifacts → aligned observable entries (+ the raw
 *  artifacts, for the shared-kind plot compare). Reads via the generated `ApiClient`
 *  directly (the data-plumbing rule), mirroring `useRunArtifacts`/`useRunNode`. */
function useMultiRunObservables(projectId: string, runIds: string[]) {
  const key = runIds.join(',')
  const [rows, setRows] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(runIds.length > 0)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = useCallback(() => setReloadNonce(n => n + 1), [])

  useEffect(() => {
    let ignore = false
    if (runIds.length === 0) {
      setRows([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    // `allSettled`, not `all`: a deleted/failed run contributes nothing rather than
    // rejecting the whole compare — the loadable runs still render. A whole-compare
    // error is surfaced ONLY when EVERY selected run failed. The `ignore` flag drops a
    // stale resolution after `runIds` changes (or a reload) so it can't overwrite.
    void Promise.allSettled(
      runIds.map(async (runId): Promise<RunRow> => {
        const [node, arts] = await Promise.all([
          ApiClient.Provenance.run({ id: runId }),
          listArtifacts(projectId, { run_id: runId }),
        ])
        const artifacts = sortRunArtifacts(arts)
        const entry: RunObservablesEntry = {
          runId,
          label: runLabel(node),
          params: coerceRunParams(node.params),
          observables: runObservables(artifacts),
        }
        return { entry, artifacts }
      }),
    ).then(settled => {
      if (ignore) return
      const loaded = settled.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
      setRows(loaded)
      if (loaded.length === 0) {
        const firstReject = settled.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
        const reason = firstReject?.reason
        setError(reason instanceof Error ? reason.message : reason ? String(reason) : 'The selected runs could not be loaded.')
      } else {
        setError(null)
      }
      setLoading(false)
    })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key, reloadNonce])

  return { rows, loading, error, reload }
}

/** The first produced datatype ALL runs share → their primary output ids (the plot
 *  compare's input). Undefined when the runs share no produced kind. */
function sharedCompare(rows: RunRow[]): { kind: string; artifactIds: string[] } | undefined {
  if (rows.length < 2) return undefined
  const perRun = rows.map(r => r.artifacts)
  const kinds = perRun.map(arts => new Set(arts.map(a => a.datatype)))
  const shared = [...kinds[0]].filter(k => kinds.every(s => s.has(k)))
  if (shared.length === 0) return undefined
  const kind = shared[0]
  const artifactIds = rows.map(r => r.artifacts.find(a => a.datatype === kind)!.id)
  return { kind, artifactIds }
}

export function MultiRunComparePane({ pane }: { pane: WorkbenchPane }) {
  const { projectId } = useWorkbench()
  const [runIds, setRunIds] = useState<string[]>(() => parseCompareRef(pane.ref))
  const { rows, loading, error, reload } = useMultiRunObservables(projectId, runIds)

  // Completed project runs the picker can add (excluding the already-selected set).
  //
  // Refetched on `sync:provenance` as well as on mount: a run finishing — this user's
  // or a collaborator's — is exactly when a new comparable run appears, and the picker
  // used to keep offering whatever the list held when the pane was opened. `runIds` is
  // in the dep list because adding a run re-filters the options.
  const [projectRuns, setProjectRuns] = useState<RunNodeDto[]>([])
  const [runsNonce, setRunsNonce] = useState(0)
  useEffect(() => {
    const off = EventBus.on('sync:provenance', () => setRunsNonce(n => n + 1))
    const offReconnect = EventBus.on('sync:reconnect', () => setRunsNonce(n => n + 1))
    return () => {
      off()
      offReconnect()
    }
  }, [])
  useEffect(() => {
    let ignore = false
    void ApiClient.Provenance.runs({ project_id: projectId, page: 1, per_page: DEFAULT_RUNS_PER_PAGE })
      .then(res => {
        if (!ignore) setProjectRuns(res.runs.filter(isCompletedRun))
      })
      .catch(() => {
        if (!ignore) setProjectRuns([])
      })
    return () => {
      ignore = true
    }
  }, [projectId, runIds, runsNonce])

  const addOptions = useMemo<SelectOption[]>(
    () => projectRuns.filter(r => !runIds.includes(r.run_id)).map(r => ({ value: r.run_id, label: runLabel(r) })),
    [projectRuns, runIds],
  )

  const entries = rows.map(r => r.entry)
  const compare = sharedCompare(rows)

  return (
    <div data-testid={`workbench-compare-pane-${pane.id}`} className="flex min-h-0 flex-1 flex-col">
      <PaneScroll axis="y" className="min-h-0 flex-1">
        <div className="flex flex-col gap-2">
          <SectionHeader
            data-testid={`workbench-compare-header-${pane.id}`}
            title={<span className="text-sm font-medium">Compare runs</span>}
            actions={
              addOptions.length > 0 ? (
                <Select
                  options={addOptions}
                  value=""
                  placeholder="Add a run…"
                  onChange={v => v && setRunIds(prev => [...prev, v])}
                  aria-label="Add a run to compare"
                  data-testid={`workbench-compare-add-${pane.id}`}
                />
              ) : undefined
            }
          />

          {loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <Spinner label="Loading runs…" data-testid={`workbench-compare-loading-${pane.id}`} />
            </div>
          ) : error ? (
            <ErrorState
              resource="runs"
              description="The selected runs could not be loaded."
              details={error}
              onRetry={reload}
              data-testid={`workbench-compare-error-${pane.id}`}
            />
          ) : entries.length === 0 ? (
            <Empty
              data-testid={`workbench-compare-pane-empty-${pane.id}`}
              title="No runs selected"
              description="Add two or more completed runs to compare their params and outcomes."
            />
          ) : (
            <MultiRunCompareView entries={entries} compare={compare} data-testid={`workbench-compare-${pane.id}`} />
          )}
        </div>
      </PaneScroll>
    </div>
  )
}
