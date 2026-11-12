// RerunPane (ITEM-63) — the "Re-run with tweaked params" host. Its `ref` is the SOURCE
// run id (a completed run). It reads that run's provenance node (`Provenance.run`) to
// recover the producing analysis + its exact params (`reseedFromRun`), then renders the
// shared `AnalysisRunPanel` PRE-SEEDED with those params — so the user adjusts one
// threshold and re-runs cheaply. When the re-run completes, it pairs the new run with
// its predecessor and renders the before/after `RunDiffView` (key observables
// side-by-side). The whole iteration loop lives here: review → re-run → diff → re-run.
//
// It re-runs only analyses that use the run pane's fallback form. `reseedFromRun` recovers the
// source run's PARAMS and no inputs (a `RunNodeDto` carries `params`), so for an analysis that
// owns its form this pane re-launched with the view's own inputs silently dropped — the same
// unset-input, no-error, wrong-numbers outcome `core/contributions/ownForm.ts` describes, this
// time behind a "re-run" button. `AnalysisRunPanel` now refuses (INV-4) and signposts the
// analysis' own pane; a genuine re-run for those analyses would need the view's STATE re-seeded,
// which is a different capability (view state is not run params) and is not invented here.

import { useMemo } from 'react'
import { Empty, ErrorState, SectionHeader, Spinner } from '@txresbench/kit'
import { usePaneStateValue } from '@/modules/workbench/core'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { type WorkbenchPane, PaneScroll } from '../../core/shell/dock/paneModel'
import { workbenchDockStore } from '../../core/shell/dock/WorkbenchDock.store'
import { revealPane } from '../../core/shell/regions/openPane'
import { AnalysisRunPanel } from './AnalysisRunPanel'
import { reseedFromRun } from './rerun'
import { useRunArtifacts, useRunNode } from '../jobs/useRunArtifacts'
import { runObservables, type RunObservablesEntry } from '../jobs/runDiff'
import { RunDiffView } from '../jobs/RunDiffView'
import { compareRef } from '../jobs/MultiRunComparePane'

export function RerunPane({ pane }: { pane: WorkbenchPane }) {
  const { api, projectId } = useWorkbench()
  const sourceRunId = pane.ref ?? null
  const { run, loading: runLoading, error: runError, reload } = useRunNode(sourceRunId)
  // The completed re-run is the whole point of the pane (it gates the before/after diff), so it is
  // kept by PANE id: a region renders only its active tab, and losing this to a glance at a sibling
  // tab means the comparison is recoverable only by running the analysis again.
  const [newRunId, setNewRunId] = usePaneStateValue<string | null>(pane.id, 'newRunId', null)

  // Both runs' produced artifacts → their observables (the before/after diff inputs).
  const before = useRunArtifacts(projectId, sourceRunId)
  const after = useRunArtifacts(projectId, newRunId)

  const seed = run ? reseedFromRun(run) : null
  const analysis = seed ? api.registry.analyses.all().find(a => a.id === seed.analysisId) : undefined

  const beforeEntry = useMemo<RunObservablesEntry | null>(
    () =>
      sourceRunId
        ? { runId: sourceRunId, label: 'Previous run', params: seed?.params ?? {}, observables: runObservables(before.artifacts) }
        : null,
    [sourceRunId, seed, before.artifacts],
  )
  const afterEntry = useMemo<RunObservablesEntry | null>(
    () => (newRunId ? { runId: newRunId, label: 'This run', params: {}, observables: runObservables(after.artifacts) } : null),
    [newRunId, after.artifacts],
  )

  return (
    <div data-testid={`workbench-rerun-pane-${pane.id}`} className="flex min-h-0 flex-1 flex-col">
      <PaneScroll axis="y" className="min-h-0 flex-1">
        {!sourceRunId ? (
          <Empty
            data-testid={`workbench-rerun-pane-empty-${pane.id}`}
            title="No run to re-run"
            description="Open this from a completed run's review to re-run it with tweaked params."
          />
        ) : runLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <Spinner label="Loading run…" data-testid={`workbench-rerun-loading-${pane.id}`} />
          </div>
        ) : runError ? (
          <ErrorState
            resource="run"
            description="The source run could not be loaded."
            details={runError}
            onRetry={reload}
            data-testid={`workbench-rerun-error-${pane.id}`}
          />
        ) : !seed || !analysis ? (
          <Empty
            data-testid={`workbench-rerun-pane-unresolved-${pane.id}`}
            title="Analysis unavailable"
            description="The analysis that produced this run isn't registered, so it can't be re-run here."
          />
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <SectionHeader
              data-testid={`workbench-rerun-header-${pane.id}`}
              title={<span className="text-sm font-medium">Re-run · {analysis.title}</span>}
              description="Adjust the params below and run again — the outputs are compared to the previous run."
            />
            {/* Pre-seeded with the source run's params (ITEM-63). */}
            <AnalysisRunPanel
              analysis={analysis}
              // Keyed by the pane, so a re-run survives a tab switch like any other run.
              sessionKey={pane.id}
              initialParams={seed.params}
              onRunComplete={setNewRunId}
            />

            {/* Before/after diff, once the re-run completes + both runs' outputs resolve. */}
            {newRunId && beforeEntry && afterEntry && !before.loading && !after.loading && (
              <RunDiffView
                before={beforeEntry}
                after={afterEntry}
                onCompare={() => revealPane('compare', compareRef([sourceRunId, newRunId]))}
                data-testid={`workbench-rerun-diff-${pane.id}`}
              />
            )}
          </div>
        )}
      </PaneScroll>
    </div>
  )
}
