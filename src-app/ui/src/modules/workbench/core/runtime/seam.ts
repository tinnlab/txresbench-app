// The view-contribution SEAM. An ANALYSIS' declared `ui:` files become ONE `ViewContribution`
// — one pane, holding each file's widgets top to bottom in the order the manifest listed them
// (INV-3: "One analysis renders into ONE pane. Multiple UI files stack top to bottom in
// declaration order."). The contribution is an ordinary `ViewContribution` whose `render`
// carries a declarative payload the `ViewHost`'s `spec` strategy interprets — so the whole
// placement, availability and reconcile machinery is reused verbatim.
//
// ## What owns the pane's identity, and why it is the ANALYSIS
//
// This seam has fanned twice, at two different granularities, and both fans put ONE analysis
// on screen as several identically-titled tabs each holding a fragment of one form:
//
//   1. per REGION — `layout.regions` mapped widget ids to dock regions and this emitted one
//      contribution per populated region, id `${spec.id}::region::${region}`. It forced a
//      second, parallel notion of identity (a widget had to be declared AND placed, so an
//      id-less widget silently never rendered). The regions are gone and `parseViewSpec`
//      refuses a spec that still declares them.
//   2. per FILE — one contribution per view spec, id `spec.id`. This reads as INV-3 only
//      while an analysis declares exactly one `ui:` file, which both shipped processors do;
//      a second file meant a second pane, and nothing in the tree noticed because no test
//      registered two.
//
// The design says "one ANALYSIS renders into one pane" and the mechanisms were spec-level.
// The analysis is the side that resolves it: it is what the user launches, what `appliesTo`
// gates, what the manifest's `ui:` list belongs to, and the ONLY level at which "these files
// stack in declaration order" is even expressible — a per-file contribution has no place to
// put the ORDER. So the contribution id is the ANALYSIS id, the tab reads the ANALYSIS title,
// and a view file is a FRAGMENT: it keeps its own store (`view_id`), its own actions and its
// own data slices, but it does not own a pane.
//
// ## A fragment therefore declares no placement
//
// The dock AREA is a property of the pane, and the pane is the analysis'. Two stacked files
// declaring different areas would be a conflict with no answer, so the question is closed at
// the parser: `parseViewSpec` REFUSES an `area`/`region` key (the same fail-closed posture it
// takes for `layout`). No shipped spec declares one, so nothing moves — the point is that
// nothing can start to.
//
// Pure + framework-free so the contribution shape is asserted without a DOM.

import {
  WORKBENCH_API_VERSION,
  type SectionContribution,
  type ViewContribution,
} from '@/modules/workbench/core'
import type { DeclarativeView } from '@/modules/workbench/core/contributions/types'
import type { ProcessorSectionData } from '@/modules/workbench/core/manifest/processorPackage'
import type { TypeSelector } from '@/modules/workbench/core/datatypes/types'
import type { Region } from '@/modules/workbench/core/shell/regions/regionModel'

/** ONE stacked view file inside an analysis' pane (or a section's stack): the parsed spec
 *  plus the per-instance `view_id` its store, actions and resolved data slices bind to.
 *
 *  Defined in `contributions/types.ts` — it is the payload of two contribution kinds now —
 *  and re-exported here, which is where every existing importer names it. */
export type { DeclarativeView }

/** The declarative payload a `ViewContribution.render = { spec }` carries — the whole pane:
 *  which analysis it belongs to, and the ORDERED stack of view files that make it up.
 *  `ViewHost` (spec strategy) mounts one interpreter per entry, in this order. */
export interface DeclarativeRenderSpec {
  /** discriminates a declarative render payload from other `{ spec }` shapes. */
  declarative: true
  /** the analysis that owns this pane — the same id the contribution (and the persisted
   *  pane `ref`) carries. */
  analysis_id: string
  /** the view files, TOP TO BOTTOM in the manifest's `ui:` declaration order (INV-3).
   *  Never empty — `viewSpecsToContribution` refuses an empty stack. */
  views: DeclarativeView[]
}

/** Type guard: is a `ViewContribution.render`'s `{ spec }` a declarative payload? */
export function isDeclarativeRenderSpec(spec: unknown): spec is DeclarativeRenderSpec {
  return (
    spec != null &&
    typeof spec === 'object' &&
    (spec as { declarative?: unknown }).declarative === true &&
    Array.isArray((spec as { views?: unknown }).views)
  )
}

export interface ContributionOptions {
  extensionId: string
  /** the pane's tab title — the ANALYSIS' title. Under the per-file model this was the
   *  FIRST file's title, so a two-file analysis was named after one of its fragments. */
  title: string
  /** the availability `when` gate the contribution carries. */
  when?: ViewContribution['when']
  apiVersion?: string
}

/**
 * The dock region a declarative processor surface docks into.
 *
 * A `ViewContribution` must declare an `area`, and no view spec names one (see the header:
 * a fragment declares no placement). `right` is the DEC-15 role→region answer for the surface
 * a declarative view actually is: a `control`/`run` form — inputs plus the Run button — which
 * belongs beside the canvas, not under it. Both shipped specs already sat exactly here, so
 * nothing moves; `output`/`inspect` surfaces would need a declared surface ROLE
 * (`regionModel.SurfaceRole`), which no analysis carries today and which this round does not
 * invent. `center` is not reachable from here at all — it is reserved for the ONE canvas
 * `GridWorkspace`, and a declared plot routes there through the `canvas` VizOption block
 * (`placeViews` additionally rejects a smuggled center contribution LOUD).
 */
export const DECLARATIVE_VIEW_AREA: Region = 'right'

/**
 * Turn an analysis' declared view files into the ONE `ViewContribution` that renders them.
 * Its `id` is the ANALYSIS id — stable, and the same id the pane reconcile keys on, so a
 * persisted layout tracks the analysis rather than one of its fragments.
 *
 * `views` is the manifest's `ui:` order and is preserved verbatim: the order the author wrote
 * is the order that reaches the renderer. An EMPTY stack throws — a pane with nothing in it is
 * not a pane, and the caller (`registerDeclarativeViews`) only calls this for an analysis that
 * declared at least one file.
 */
export function viewSpecsToContribution(
  analysisId: string,
  views: DeclarativeView[],
  opts: ContributionOptions,
): ViewContribution {
  if (views.length === 0) {
    throw new Error(`[declarative] analysis "${analysisId}" would render an EMPTY pane — no view files`)
  }
  const render: DeclarativeRenderSpec = {
    declarative: true,
    analysis_id: analysisId,
    views,
  }
  return {
    id: analysisId,
    extensionId: opts.extensionId,
    apiVersion: opts.apiVersion ?? WORKBENCH_API_VERSION,
    // The CLEAN human title — the reconciled pane's tab must read "Cell filter", not the
    // raw analysis id, and not one stacked fragment's own title.
    title: opts.title,
    area: DECLARATIVE_VIEW_AREA,
    when: opts.when,
    render: { spec: render },
  }
}

// ── the SECTION seam (ITEM-2) ───────────────────────────────────────────────────────────
//
// The deliberate asymmetry with `viewSpecsToContribution` above is the whole point of the
// section kind, so it is written down here rather than left to be noticed:
//
//   · a view contribution declares an `area` and rides `placeViews` / `reconcileViews` /
//     `viewAutomountGate` / `assertContributableArea` into the dock. A SECTION declares a
//     `pane` and rides none of them — `SectionStack` reads `registry.sections.all()`
//     directly. There is no `area` on a `SectionContribution` to smuggle `center` through,
//     so INV-12's "the centre reservation is unreachable from this path" is a property of
//     the TYPE, not a check somewhere.
//   · a view contribution's stack is ONE ANALYSIS' `ui:` files, so its id is the analysis'.
//     A section is its own unit: its id is the section's own declared id, which is what the
//     user's saved `sectionOrder` names.
//
// One thing is deliberately the SAME: a section, like a pane, is fail-CLOSED over its whole
// declared stack. Half a form is not a form.

/** A section's `applies_to[]` entry as the manifest spells it — the LISTING subset of
 *  `TypeSelector`, minus the three input-slot keys (`slot`/`multiple`/`required`) whose
 *  absence is what makes "never a producer" (INV-18) a parse error rather than a
 *  convention. Both Rust parsers `deny_unknown_fields` on exactly this field set. */
type RawSectionSelector = Pick<TypeSelector, 'type_id' | 'subtypes_of' | 'capabilities' | 'excludes'>

/** Widen a manifest `applies_to[]` entry to the shared `TypeSelector` that
 *  `computeAvailability` consumes.
 *
 *  It is a WIDENING and not a translation, and deliberately so: the section selector is a
 *  strict field SUBSET of the core selector and shares its spelling (`type_id`,
 *  `subtypes_of`, …), so this drops nothing and renames nothing. The function exists only
 *  to make the widening a typed, single-site fact — the alternative, an `as TypeSelector`
 *  at each use, would silently start passing an input-slot key the day someone widened the
 *  manifest struct. */
function toTypeSelector(raw: unknown): TypeSelector {
  const s = (raw ?? {}) as RawSectionSelector
  return {
    ...(s.type_id != null ? { type_id: s.type_id } : {}),
    ...(s.subtypes_of != null ? { subtypes_of: s.subtypes_of } : {}),
    ...(s.capabilities != null ? { capabilities: s.capabilities } : {}),
    ...(s.excludes != null ? { excludes: s.excludes } : {}),
  }
}

export interface SectionContributionOptions {
  /** the PACKAGE that declared the section — its manifest id. */
  extensionId: string
  apiVersion?: string
}

/**
 * Turn ONE declared `contributes.sections[]` entry plus its PARSED view files into the
 * `SectionContribution` the Visualize pane renders. PURE.
 *
 * `views` is the manifest's `ui:` order, preserved verbatim: the order the author wrote is
 * the order `SectionStack` stacks them in. An EMPTY stack THROWS — a section with nothing
 * in it is a header the user can collapse and drag and that can never say anything, which
 * is worse than its absence. The caller only reaches here for a section that declared at
 * least one file and whose every file parsed.
 */
export function sectionToContribution(
  data: ProcessorSectionData,
  views: DeclarativeView[],
  opts: SectionContributionOptions,
): SectionContribution {
  if (views.length === 0) {
    throw new Error(`[declarative] section "${data?.id}" would render an EMPTY section — no view files`)
  }
  return {
    id: data.id,
    extensionId: opts.extensionId,
    apiVersion: opts.apiVersion ?? WORKBENCH_API_VERSION,
    title: data.title,
    pane: data.pane,
    ...(data.order !== undefined ? { order: data.order } : {}),
    ...(data.collapsed !== undefined ? { collapsed: data.collapsed } : {}),
    ...(data.applies_to !== undefined ? { appliesTo: data.applies_to.map(toTypeSelector) } : {}),
    ...(data.ui !== undefined ? { ui: data.ui } : {}),
    views,
  }
}
