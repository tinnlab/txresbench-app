// nextSteps — the self-explaining pipeline's flow content (declarative-canvas-plots
// ITEM-35/37/38, DEC-17). Authored ONCE from the producer→consumer datatype graph and
// rendered in BOTH surfaces: the run-pane completion (ITEM-35) and the status-keyed job
// details reached via the completion toast (ITEM-37). "What you can do next" is DERIVED, not
// hand-listed — the analyses whose `accepts` match THIS analysis's `produces` (reusing
// `chaining.nextAnalyses`), so a NEW downstream analysis appears automatically with no upstream
// edit. Pure — no React, no store — so the derivation is directly unit-testable.

import {
  buildChainLaunch,
  nextAnalyses,
  type ChainLaunch,
} from './chaining'
import type { AnalysisContribution, DatatypeLattice } from '@/modules/workbench/core'

/** One derived next-step: a downstream analysis that consumes this one's output + its launch
 *  payload (pre-seeding the produced artifact into the matching input slot when known). */
export interface NextStep {
  readonly analysisId: string
  readonly title: string
  /** the produced datatype that makes this analysis a consumer. */
  readonly producedDatatype: string
  /** the `analysis.launch` payload (input pre-seeded when an artifact id is supplied). */
  readonly launch: ChainLaunch
}

/**
 * Derive the downstream next-step launch actions (ITEM-35/38): for each datatype `completed`
 * PRODUCES, the analyses that ACCEPT it (`nextAnalyses`, subtype-aware), deduped by analysis id
 * (first-producing-datatype wins), the producing analysis excluded. When `artifactId` is given
 * the launch pre-seeds it into the downstream input slot; otherwise the launch just opens the
 * analysis unseeded. Order-stable (produces order, then `nextAnalyses`' category/title sort).
 */
export function deriveNextSteps(
  completed: AnalysisContribution,
  analyses: AnalysisContribution[],
  lattice: DatatypeLattice,
  artifactId?: string,
): NextStep[] {
  const seen = new Set<string>()
  const out: NextStep[] = []
  for (const datatype of completed.produces ?? []) {
    for (const a of nextAnalyses(analyses, datatype, lattice, completed.id)) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      const launch = artifactId
        ? buildChainLaunch(a, datatype, artifactId, lattice)
        : { analysis_id: a.id }
      out.push({ analysisId: a.id, title: a.title, producedDatatype: datatype, launch })
    }
  }
  return out
}

/** A plain-language summary of what an analysis PRODUCED (ITEM-35 beat 2) — the friendly label for
 *  each produced datatype, joined with commas + a trailing "and"; `nothing` when it produces no
 *  artifacts. The friendly label is DATA-driven (INV-6): it is the datatype's DECLARED `title`
 *  from the registry (the same lattice `caps.ts` reads), falling back to the raw id when the
 *  lattice has no entry — so a NEW datatype surfaces its declared display name with ZERO edit to
 *  this general engine. (The per-run COUNT — "4 Metadata columns" — needs the run outputs, not
 *  available to this pure type-graph summary; the phrasing names the KIND.) */
export function producedSummary(completed: AnalysisContribution, lattice: DatatypeLattice): string {
  const labels = (completed.produces ?? []).map(id => {
    let title: string | undefined
    try {
      title = lattice.get(id)?.title
    } catch {
      title = undefined
    }
    return title || id
  })
  if (labels.length === 0) return 'nothing'
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
