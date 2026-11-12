// "Start next analysis" (ITEM-27) — the chaining affordance on a produced artifact.
// Offers the analyses that can CONSUME this artifact's datatype and launches one
// through the ONE `analysis.launch` action, pre-seeding this artifact into the
// downstream input slot. A write (it starts a run), so it is `canEdit`-gated — viewers
// never see it. Nothing to chain → renders nothing (no dead affordance).

import { ArrowRight } from 'lucide-react'
import { Button } from '@txresbench/kit'
import { runAction } from '@/core/actions/defineAction'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { buildChainLaunch, nextAnalyses } from '../analysis/chaining'

export interface ArtifactChainingProps {
  /** the produced artifact's datatype (what the next analysis must accept). */
  producedDatatype: string
  /** the produced artifact id (pre-seeded into the downstream input slot). */
  artifactId: string
  /** the producing analysis id (excluded from the candidates). */
  producedByAnalysisId?: string
  'data-testid'?: string
}

export function ArtifactChaining({
  producedDatatype,
  artifactId,
  producedByAnalysisId,
  'data-testid': testid = 'workbench-artifact-chaining',
}: ArtifactChainingProps) {
  const { api, viewId, lattice, canEdit } = useWorkbench()

  // Chaining starts a run → gate on edit rights (viewers are read-only).
  if (!canEdit) return null

  const candidates = nextAnalyses(api.registry.analyses.all(), producedDatatype, lattice, producedByAnalysisId)
  if (candidates.length === 0) return null

  const start = (analysisId: string) => {
    const analysis = candidates.find(a => a.id === analysisId)
    if (!analysis) return
    const launch = buildChainLaunch(analysis, producedDatatype, artifactId, lattice)
    void runAction('analysis.launch', { view_id: viewId, ...launch }).catch(err => {
      api.ui.notify(err instanceof Error ? err.message : String(err), 'error')
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testid}>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <ArrowRight className="size-3.5" aria-hidden />
        Start next analysis
      </span>
      {candidates.map(a => (
        <Button
          key={a.id}
          variant="outline"
          onClick={() => start(a.id)}
          data-testid={`${testid}-${a.id}`}
        >
          {a.title}
        </Button>
      ))}
    </div>
  )
}
