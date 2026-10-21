// JobFlowGuidance — the processor-contributed, STATUS-keyed job-details content
// (declarative-canvas-plots ITEM-37, DEC-17). Rendered in the job details reached via the
// completion toast (ITEM-36); it is the SAME derived flow content as the run-pane completion
// (ITEM-35), keyed by the job's STATUS:
//   • completed → outputs summary + the DERIVED next-step launch actions (`AnalysisFlowGuidance`);
//   • failed    → the error + a Retry affordance (re-open the analysis to run again).
// Next-step targets stay DERIVED from the producer→consumer type graph — nothing is hand-listed.
//
// HONEST LIMIT: a `Job` carries no `analysis_id` column, so the producing analysis is resolved
// best-effort from `job.params.analysis_id` (the launch stamped it) then the job NAME (== the
// analysis title). No match → no guidance (never a fabricated next step).

import { RotateCcw } from 'lucide-react'
import { Button } from '@ziee/kit'
import type { AnalysisContribution } from '@/modules/workbench/core'
import type { Job } from '@/api-client/types'
import { runAction } from '@/core/actions/defineAction'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { AnalysisFlowGuidance } from '../analysis/AnalysisFlowGuidance'

// `resolveJobAnalysisId` moved to `core/runtime/analysisRuns` — CORE now needs the same
// answer for the per-analysis run list, and core may not import an extension. Re-exported
// here so this module's existing consumers keep their import site.
import { resolveJobAnalysisId } from '@/modules/workbench/core'
export { resolveJobAnalysisId }

export function JobFlowGuidance({ job }: { job?: Job | null }) {
  const { api, viewId, canEdit } = useWorkbench()
  if (!job) return null
  const analyses = api.registry.analyses.all()
  const analysisId = resolveJobAnalysisId(job, analyses)
  if (!analysisId) return null

  if (job.status === 'completed') {
    return <AnalysisFlowGuidance analysisId={analysisId} data-testid="workbench-jobs-detail-guidance" />
  }

  if (job.status === 'failed' && canEdit) {
    const retry = () =>
      void runAction('analysis.launch', { view_id: viewId, analysis_id: analysisId }).catch(err =>
        api.ui.notify(err instanceof Error ? err.message : String(err), 'error'),
      )
    return (
      <div className="flex items-center gap-2 pt-1" data-testid="workbench-jobs-detail-guidance">
        <Button variant="outline" onClick={retry} data-testid="workbench-jobs-detail-retry">
          <RotateCcw className="size-4" /> Retry
        </Button>
      </div>
    )
  }

  return null
}
