// AnalysisFlowGuidance — the self-explaining pipeline's DONE-state flow content
// (declarative-canvas-plots ITEM-35/37, DEC-17). Authored ONCE and rendered in BOTH the run-pane
// completion (ITEM-35) and the status-keyed job details (ITEM-37): three beats —
//   (1) what it DID   — the analysis description;
//   (2) what it PRODUCED — plain language (`producedSummary`);
//   (3) what's NEXT   — the downstream analyses that CONSUME this output (`deriveNextSteps`), each
//                       a launch button that opens the analysis with the produced artifact pre-seeded.
// The next-step targets are DERIVED from the producer→consumer type graph, so a new downstream
// analysis appears automatically with no upstream edit. Launch is a write → `canEdit`-gated.

import { ArrowRight, CircleCheck } from 'lucide-react'
import { Button } from '@ziee/kit'
import { runAction } from '@/core/actions/defineAction'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { deriveNextSteps, producedSummary } from './nextSteps'

export interface AnalysisFlowGuidanceProps {
  /** the completed analysis id (resolved against the registry). */
  analysisId: string
  /** the produced artifact id — pre-seeded into a downstream input slot when known. */
  artifactId?: string
  'data-testid'?: string
}

export function AnalysisFlowGuidance({
  analysisId,
  artifactId,
  'data-testid': testid = 'workbench-flow-guidance',
}: AnalysisFlowGuidanceProps) {
  const { api, viewId, lattice, canEdit } = useWorkbench()
  const analyses = api.registry.analyses.all()
  const analysis = analyses.find(a => a.id === analysisId)
  if (!analysis) return null

  const steps = deriveNextSteps(analysis, analyses, lattice, artifactId)

  const launch = (id: string) => {
    const step = steps.find(s => s.analysisId === id)
    if (!step) return
    void runAction('analysis.launch', { view_id: viewId, ...step.launch }).catch(err => {
      api.ui.notify(err instanceof Error ? err.message : String(err), 'error')
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid={testid}>
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <CircleCheck className="size-4 text-success" aria-hidden />
        {analysis.title} finished
      </div>
      {analysis.description && (
        <p className="text-xs text-muted-foreground" data-testid={`${testid}-did`}>
          {analysis.description}
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid={`${testid}-produced`}>
        Produced: <span className="text-foreground">{producedSummary(analysis, lattice)}</span>
      </p>
      {canEdit && steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1" data-testid={`${testid}-next`}>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ArrowRight className="size-3.5" aria-hidden />
            Next
          </span>
          {steps.map(s => (
            <Button key={s.analysisId} variant="outline" onClick={() => launch(s.analysisId)} data-testid={`${testid}-${s.analysisId}`}>
              Open {s.title}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
