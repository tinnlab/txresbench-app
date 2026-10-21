// Visualization discoverability (ITEM-17 / DEC-4). A PURE resolver that answers
// "which visualizations does this analysis advertise, and can each one draw on the
// data I have right now?" — the viz twin of `launcherAvailability`'s list-and-explain
// contract: a viz whose DECLARED data precondition is unmet is LISTED-with-a-reason
// ("needs <slice>"), never silently absent.
//
// Two sources, unioned + de-duped by id:
//   (a) the viz widgets (`scatter` / `violin`) statically declared in the analysis's
//       declarative `view_spec` (tolerated-absent — the view engine attaches it in a
//       parallel wave; we read it defensively so this resolver stands alone).
//   (b) datatype-keyed `views` whose `consumes` matches one of the analysis's
//       `produces` datatype ids. (ITEM-34 dropped the `plotTypes` source with the
//       `plotTypes` contribution point — canvas owns its plot types, not an extension.)
//
// E6 (DOMAIN_AUDIT): a viz's data PRECONDITION is DECLARED (`requires: [<slice>, …]`) by
// whichever side owns the viz, and both sources are judged by the same rule. Nothing here
// names a slice, a datatype or a modality; the reason string a user reads is assembled
// from the processor's own slice names.
//
// Pure + registry-injected (no live singleton) so it is directly unit-testable and can
// never disagree with the catalog it is handed. Wiring the result into the analysis
// card + artifact tabs is a small downstream surface (deferred to the ITEM-17 e2e wave).

import type { AnalysisContribution, WidgetSpec } from '@/modules/workbench/core'

/** The (structural) slice of a parsed `view_spec` this resolver reads. Declared here rather
 *  than imported from `core/manifest/viewSpec` because the declarative top type is
 *  deliberately absent from the core barrel, and these two fields are genuinely all this
 *  resolver touches — so a structural shape is honest, not a workaround. */
interface ViewSpecWidgets {
  id: string
  widgets?: WidgetSpec[]
}

/** A datatype-keyed viz source (a manifest `views` entry): its `consumes` datatype id is
 *  matched against the analysis's `produces`. */
export interface DatatypeVizSource {
  id: string
  title?: string
  /** the datatype id this viz consumes; unmatched → not advertised for the analysis. */
  consumes?: string
  /** DECLARED data-slice preconditions — the same model the view_spec widgets use
   *  (`WidgetBase.requires`). Absent ⇒ no precondition. */
  requires?: string[]
}

/** The catalog the resolver is handed (the datatype-keyed half of the sources). Kept a
 *  minimal structural shape so a caller can adapt the live registry OR a test can pass
 *  a literal. */
export interface VizRegistry {
  views?: DatatypeVizSource[]
}

/** The currently-resolved data slices (`$data`), keyed by slice name. A viz's DECLARED
 *  `requires` names are looked up here; a name whose value is `null`/`undefined`/absent is
 *  an unmet precondition. Deliberately structure-free: no slice is named in this type
 *  (E6 — it used to declare `vis2D?`, which made ONE domain slice the only expressible
 *  precondition in the whole model). */
export type VizDataContext = Record<string, unknown>

/** One advertised visualization + whether it can draw on the current data (the
 *  list-and-explain verdict). `available:false` ALWAYS carries a `reason`. */
export interface VizAvailability {
  id: string
  title: string
  available: boolean
  reason?: string
  /** where the entry came from (declared widget vs datatype-keyed catalog). */
  source: 'view_spec' | 'view'
}

/** The user-facing reason for a viz whose DECLARED data preconditions are unmet. The nouns
 *  are the processor's OWN slice names — the workbench supplies only the word "needs".
 *  (This replaces the `NEEDS_EMBEDDING` constant: "an embedding" was the single hardcoded
 *  precondition the whole model could express, E6.) */
export function needsDataReason(missing: readonly string[]): string {
  return `needs ${missing.join(' + ')}`
}

/** The DECLARED slice names that have NOT resolved in `data`. A slice present but `null`
 *  counts as unresolved (the resolver lands `null` for a slice it could not read). */
function missingSlices(requires: readonly string[] | undefined, data: VizDataContext | undefined): string[] {
  if (!Array.isArray(requires) || requires.length === 0) return []
  return requires.filter(name => (data ?? {})[name] == null)
}

/** Flatten a widget tree, descending into `group` children, so nested viz widgets are
 *  discovered too. */
function flattenWidgets(widgets: WidgetSpec[]): WidgetSpec[] {
  const out: WidgetSpec[] = []
  for (const w of widgets) {
    out.push(w)
    if (w.kind === 'group') out.push(...flattenWidgets(w.children))
  }
  return out
}

/**
 * Resolve the visualizations an analysis advertises, each tagged available/unavailable
 * with an explain reason (ITEM-17). Pure — no live registry, no data mutation.
 *
 * Availability is decided by ONE rule for BOTH sources: every DECLARED `requires` slice
 * must have resolved in `data`. A viz that declares no precondition is available.
 *
 * E6: this used to have two different, both-hardcoded rules — a `view_spec` scatter was
 * "embedding-space" iff its `when` string CONTAINED `vis2D`, and a datatype-keyed source
 * was so iff its consumed type declared `plottable-xy`; both then probed the single
 * hardcoded slice `data.vis2D`. The capability check answered "does this viz plot XY",
 * which is a real and generic question, but it never answered "does the XY DATA exist" —
 * `data.vis2D` did, and that was the leak. Since the answer has to be declared either
 * way, both arms now read the same declaration and the capability inference is gone
 * rather than left as a branch with no remaining effect.
 *
 * @param analysis  the analysis whose viz to resolve (its `produces` + optional `view_spec`).
 * @param registry  the datatype-keyed viz catalog (`views` with `consumes` + `requires`).
 * @param data      the currently-resolved `$data` slices a `requires` name is looked up in.
 */
export function availableVisualizations(
  analysis: AnalysisContribution,
  registry: VizRegistry = {},
  data?: VizDataContext,
): VizAvailability[] {
  const out: VizAvailability[] = []
  const seen = new Set<string>()
  const add = (entry: VizAvailability): void => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    out.push(entry)
  }

  // (a) viz widgets declared in the analysis's view_spec — ONLY when a parsed ViewSpec
  // object is actually present. The backend `view_spec` field is a PATH STRING; a
  // parsed ViewSpec object is attached in-memory by the view engine (a parallel wave),
  // so the field is honestly `ViewSpec | string | undefined`. A string path (or absent)
  // yields no declared-widget viz — the branch is a no-op, never a mis-typed read.
  const rawViewSpec = (analysis as { view_spec?: ViewSpecWidgets | string }).view_spec
  const viewSpec = rawViewSpec && typeof rawViewSpec === 'object' ? rawViewSpec : undefined
  if (viewSpec && Array.isArray(viewSpec.widgets)) {
    for (const w of flattenWidgets(viewSpec.widgets)) {
      if (w.kind !== 'scatter' && w.kind !== 'violin') continue
      const id = w.id ?? `${viewSpec.id}.${w.kind}`
      const title = w.title ?? (w.kind === 'scatter' ? 'Scatter' : 'Violin')
      const missing = missingSlices(w.requires, data)
      add({
        id,
        title,
        available: missing.length === 0,
        reason: missing.length === 0 ? undefined : needsDataReason(missing),
        source: 'view_spec',
      })
    }
  }

  // (b) datatype-keyed views whose `consumes` matches a `produces` id.
  const produces = new Set(analysis.produces ?? [])
  const fromSources = (sources: DatatypeVizSource[] | undefined, source: 'view'): void => {
    for (const s of sources ?? []) {
      if (s.consumes == null || !produces.has(s.consumes)) continue
      const missing = missingSlices(s.requires, data)
      add({
        id: s.id,
        title: s.title ?? s.id,
        available: missing.length === 0,
        reason: missing.length === 0 ? undefined : needsDataReason(missing),
        source,
      })
    }
  }
  fromSources(registry.views, 'view')

  return out
}
