// Launcher availability + grouping (ITEM-20 / ITEM-28). The launcher lists every
// registered analysis grouped by `category`, each row tagged with WHY it can (or
// can't) launch, so an unavailable analysis is DISABLED-with-a-reason, never hidden
// (owner ruling: list + explain). Pure — the launcher pane renders from this and the
// unit test drives it directly. Built on the SHARED `@/modules/workbench/core`
// applicability + arch predicates (`computeAvailabilityWithArch`) so the launcher can
// never disagree with the MCP capability manifest.

import {
  computeAvailabilityWithArch,
  type AnalysisContribution,
  type BackendArch,
  type DatatypeLattice,
  type TypeSelector,
  type WhenContext,
} from '@/modules/workbench/core'

/** Per-row availability verdict (drives the badge + the disabled state). */
export type RowAvailability =
  | { status: 'available' }
  /** an applicability gate is unmet — the required input datatype(s) aren't produced yet. */
  | { status: 'needs-type'; missing: string[] }
  /** applicable, but the backend CPU arch can't run it (still listed, disabled). */
  | { status: 'arch-disabled'; reason: string }

/** A launcher row: the analysis + its availability + whether it can be launched. */
export interface LauncherRow {
  analysis: AnalysisContribution
  availability: RowAvailability
  launchable: boolean
}

/** A category group of rows (sorted by category, then analysis order/title). */
export interface LauncherGroup {
  category: string
  rows: LauncherRow[]
}

/** A human label for an unmet type selector (`subtypes_of`/`type_id`/capability). */
export function selectorLabel(sel: TypeSelector): string {
  if (sel.type_id) return sel.type_id
  if (sel.subtypes_of) return sel.subtypes_of
  if (sel.capabilities && sel.capabilities.length > 0) return sel.capabilities.join('+')
  return 'input'
}

/** The REQUIRED accept selectors an analysis needs that the project hasn't produced
 *  (the "needs-<type>" reason set). Optional selectors (`required:false`) never gate. */
export function missingInputs(
  analysis: AnalysisContribution,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): string[] {
  const out: string[] = []
  // Every `appliesTo` entry is required by definition — the `required === false` skip
  // went with `accepts` (an optional entry was a chaining edge, now `consumes`).
  for (const sel of analysis.appliesTo ?? []) {
    const satisfied = ctx.producedTypeIds.some(id => lattice.matches(id, sel))
    if (!satisfied) out.push(selectorLabel(sel))
  }
  // De-dup while preserving order.
  return [...new Set(out)]
}

/** Compute one analysis's launcher availability (ITEM-20 / ITEM-28). Layers the CPU
 *  arch lens on the shared applicability predicate: applicable+runnable → available;
 *  applicable+arch-incompatible → arch-disabled (reason); not-applicable → needs-type. */
export function rowAvailability(
  analysis: AnalysisContribution,
  ctx: WhenContext,
  lattice: DatatypeLattice,
  backendArch: BackendArch,
): RowAvailability {
  const verdict = computeAvailabilityWithArch(analysis, ctx, lattice, backendArch)
  if (verdict.available && verdict.runnable) return { status: 'available' }
  if (verdict.available && !verdict.runnable) {
    return { status: 'arch-disabled', reason: verdict.reason ?? 'not runnable on this backend' }
  }
  // Not applicable — surface the specific missing input datatype(s) (or a `when` gate).
  const missing = missingInputs(analysis, ctx, lattice)
  return { status: 'needs-type', missing: missing.length > 0 ? missing : ['a prior artifact'] }
}

/** Whether a row can be launched (only a fully-available row). */
export function isLaunchable(a: RowAvailability): boolean {
  return a.status === 'available'
}

/** ITEM-16 (DEC-4) — the launcher-VISIBILITY predicate: a PURE filter, distinct
 *  from availability (which lists-and-explains an unmet-input analysis). An analysis
 *  is hidden from the launcher iff it is a converter (`trigger: 'on-ingest'`, the
 *  ingest builtins) or was explicitly opted out (`launchable === false`, the demos /
 *  dogfood). Everything else — including an availability-gated real analysis — stays
 *  listed. Registration is untouched: a hidden analysis is still resolvable by id and
 *  AI/test-reachable (DEC-7); only the user-facing launcher list drops it. */
export function isLauncherVisible(analysis: AnalysisContribution): boolean {
  if (analysis.launchable === false) return false
  if (analysis.trigger === 'on-ingest') return false
  return true
}

/** Apply {@link isLauncherVisible} to a list — the launcher's real, user-launchable
 *  analysis set (converters + demos filtered out). Pure; order-preserving. */
export function launcherVisibleAnalyses(
  analyses: AnalysisContribution[],
): AnalysisContribution[] {
  return analyses.filter(isLauncherVisible)
}

/** Group analyses by `category`, tagging each row's availability (ITEM-20 / ITEM-28).
 *  Categories sort alphabetically; rows within a category sort by `order` then title,
 *  so the launcher list is stable + deterministic. */
export function byCategory(
  analyses: AnalysisContribution[],
  ctx: WhenContext,
  lattice: DatatypeLattice,
  backendArch: BackendArch,
): LauncherGroup[] {
  const groups = new Map<string, LauncherRow[]>()
  for (const analysis of analyses) {
    const availability = rowAvailability(analysis, ctx, lattice, backendArch)
    const row: LauncherRow = { analysis, availability, launchable: isLaunchable(availability) }
    const cat = analysis.category || 'General'
    const list = groups.get(cat) ?? []
    list.push(row)
    groups.set(cat, list)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, rows]) => ({
      category,
      rows: rows.sort(
        (x, y) =>
          (x.analysis.order ?? 0) - (y.analysis.order ?? 0) ||
          x.analysis.title.localeCompare(y.analysis.title),
      ),
    }))
}

/** Case-insensitive substring search over an analysis's title / description / category
 *  (the launcher search box). An empty query matches everything. */
export function matchesQuery(analysis: AnalysisContribution, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = `${analysis.title} ${analysis.description ?? ''} ${analysis.category ?? ''}`.toLowerCase()
  return hay.includes(q)
}
