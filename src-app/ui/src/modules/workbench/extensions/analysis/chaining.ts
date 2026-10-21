// Light chaining (ITEM-27) — the TOP validated pain-point fix. From a completed
// artifact, "Start next analysis" offers the analyses that can CONSUME the produced
// artifact's datatype and launches one with that artifact already selected — so a
// user flows selection → DE → enrichment without re-finding inputs. Pure — the
// artifact view renders these; the unit test drives them directly.

import {
  type AnalysisContribution,
  type DatatypeLattice,
  type TypeSelector,
} from '@/modules/workbench/core'

/** Whether an analysis can consume `datatype` — any `appliesTo` selector matches, or the
 *  datatype is one it `consumes`. Matched via the injected lattice, so a subtype chains. */
export function acceptsDatatype(
  analysis: AnalysisContribution,
  datatype: string,
  lattice: DatatypeLattice,
): boolean {
  // `appliesTo` (what it needs to be offered) OR `consumes` (what it reads without
  // requiring). The second used to be an `accepts` entry with `required: false`, which
  // is why one lookup covered both; they are separate keys now, and chaining wants the
  // UNION — "can this analysis take that datatype" is true either way.
  const applies = (analysis.appliesTo ?? []).some((sel: TypeSelector) => lattice.matches(datatype, sel))
  const consumes = (analysis.consumes ?? []).some(id => lattice.isA(datatype, id))
  return applies || consumes
}

/** The analyses that can consume `producedDatatype` (the chaining candidates),
 *  excluding the producing analysis itself. Sorted by category then title (stable). */
export function nextAnalyses(
  analyses: AnalysisContribution[],
  producedDatatype: string,
  lattice: DatatypeLattice,
  excludeId?: string,
): AnalysisContribution[] {
  return analyses
    .filter(a => a.id !== excludeId && acceptsDatatype(a, producedDatatype, lattice))
    .sort((x, y) => (x.category || '').localeCompare(y.category || '') || x.title.localeCompare(y.title))
}

/** The artifact-ref field id whose `accepts` matches `producedDatatype` — the input
 *  SLOT the upstream artifact pre-seeds into. `undefined` when the analysis gates on
 *  the type but declares no matching artifact-ref field (the chain still launches,
 *  just unseeded).
 *
 *  ── TEST-14 / ITEM-11(a): the SOLE match binds; several REFUSE ──────────────────────
 *
 *  This was `.find(…)`, which takes the FIRST selector that matches. An analysis whose
 *  `appliesTo` declares two selectors a produced datatype satisfies — a broad one and a
 *  narrow one, or two slots that both accept a supertype — therefore had ONE of its
 *  inputs pre-seeded, chosen by declaration order, and the user met a launched form with
 *  an artifact silently sitting in a slot they did not pick. Declaration order is real,
 *  stable and meaningless (INV-1: a resolver may not take `[0]`).
 *
 *  So the slot resolves only when the choice is not a choice. With several matches the
 *  answer is `undefined` — which is NOT a new failure mode: it is the already-handled
 *  state above ("the chain still launches, just unseeded"), so the user gets the same
 *  form with every slot empty and picks the one they meant. Refusing here costs one
 *  click; guessing costs a run against the wrong input that still looks correct. */
export function chainSlotFor(
  analysis: AnalysisContribution,
  producedDatatype: string,
  lattice: DatatypeLattice,
): string | undefined {
  // The SLOT the upstream artifact pre-seeds into. It used to come from an
  // artifact-ref FIELD's id; the slot now lives on the `appliesTo` selector itself, so
  // there is one name for an input instead of a field id that had to agree with a
  // separate mount key.
  const matches = (analysis.appliesTo ?? []).filter(s => lattice.matches(producedDatatype, s))
  return matches.length === 1 ? matches[0].slot : undefined
}

/** The `analysis.launch` params for a chained run (ITEM-27) — the downstream analysis
 *  id + the upstream artifact pre-seeded into its matching input slot (when one
 *  exists). Consumed as `runAction('analysis.launch', { view_id, ...ChainLaunch })`. */
export interface ChainLaunch {
  analysis_id: string
  inputs?: Record<string, string>
}

export function buildChainLaunch(
  analysis: AnalysisContribution,
  producedDatatype: string,
  artifactId: string,
  lattice: DatatypeLattice,
): ChainLaunch {
  const slot = chainSlotFor(analysis, producedDatatype, lattice)
  return slot ? { analysis_id: analysis.id, inputs: { [slot]: artifactId } } : { analysis_id: analysis.id }
}

/** The analyses that PRODUCE `datatype` — the BACKWARD chain (ITEM-14): when an interactive
 *  view's input is not ready (it lacks a required datatype), these are the upstream steps
 *  that yield it, so the view can offer "run Compute QC metrics first". Excludes the view's
 *  own analysis; sorted by category then title. */
export function analysesProducing(
  analyses: AnalysisContribution[],
  datatype: string,
  excludeId?: string,
): AnalysisContribution[] {
  return analyses
    .filter(a => a.id !== excludeId && (a.produces ?? []).includes(datatype))
    .sort((x, y) => (x.category || '').localeCompare(y.category || '') || x.title.localeCompare(y.title))
}
