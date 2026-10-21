// AnalysisVisualizations (PLAN.md ITEM-17) — the list-and-explain surface for an
// analysis's advertised visualizations. Reuses the PURE `availableVisualizations`
// resolver (`./discovery`): each viz the analysis produces is LISTED; one whose data
// precondition is unmet is greyed WITH its reason ("needs an embedding"), never silently
// absent (the viz twin of the launcher's disabled-with-reason contract). Presentational +
// registry-injected — no live singleton — so it can render on an analysis card AND as
// artifact tabs from the same data.

import { Tag } from '@ziee/kit'
import type { AnalysisContribution, DatatypeLattice } from '@/modules/workbench/core'
import { availableVisualizations, type VizAvailability, type VizRegistry, type VizDataContext } from './discovery'

export function AnalysisVisualizations({
  analysis,
  registry,
  data,
  'data-testid': testid = `workbench-analysis-viz-${analysis.id}`,
}: {
  analysis: AnalysisContribution
  registry?: VizRegistry
  data?: VizDataContext
  /**
   * @deprecated E6 — no longer read. A viz's data precondition is DECLARED (`requires`),
   * so the lattice no longer decides availability. Still accepted so the one production
   * caller (`AnalysisRunPanel`, owned by another workstream) keeps compiling; drop the
   * prop and its call-site argument together.
   */
  lattice?: DatatypeLattice
  'data-testid'?: string
}) {
  const viz = availableVisualizations(analysis, registry, data)
  if (viz.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid={testid}>
      <span aria-hidden>Visualizations</span>
      {viz.map(v => (
        <VizChip key={v.id} viz={v} analysisId={analysis.id} />
      ))}
    </div>
  )
}

function VizChip({ viz, analysisId }: { viz: VizAvailability; analysisId: string }) {
  const testid = `workbench-analysis-viz-${analysisId}-${viz.id}`
  if (viz.available) {
    return (
      <Tag tone="info" variant="soft" data-testid={testid} data-available="true">
        {viz.title}
      </Tag>
    )
  }
  // Unavailable → greyed with the explain reason (never hidden).
  return (
    <Tag
      tone="default"
      variant="soft"
      data-testid={testid}
      data-available="false"
      className="opacity-60"
    >
      {viz.title} — {viz.reason}
    </Tag>
  )
}
