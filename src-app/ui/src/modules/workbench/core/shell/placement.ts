// The semantic slot resolver (ITEM-6) — a PURE selector mapping the P5 `views`
// registry into the four dock areas, gated by availability. The docks read this
// for their contributed tabs (the dock hosts' own built-in tabs come from the
// dock hosts themselves). Kept pure + dependency-light so it's unit-observable via
// the `window.__workbench` e2e seam and reused by the shell + gallery.
//
// Semantic placement (IA §4.5.3): a `ViewContribution` declares its `area`; the
// shell honors it but REJECTS an out-of-vocabulary area (defensive — the type
// prevents it, but a JS-authored/loosely-typed contribution could smuggle one).
//
// GATING: there is none HERE, for views. This header used to say "a view with a
// `when` clause appears only when the clause holds for the project's produced
// datatypes (via P5's `computeAvailability`)" — but `computeAvailability` DELETED
// its `when` arm and reads only `appliesTo`, which a view never carries. So
// `isViewAvailable` is `true` for every registered view, on every project. The
// `when` field on `ViewContribution` is dead: `seam.viewSpecsToContribution` copies
// it through and nothing reads it.
//
// That is the RETAINED set, and it is correct that it is unnarrowed: a pane the user
// opened on purpose must not be closed underneath them. The AUTO-MOUNT set is a
// different question and IS gated — `shell/dock/viewAutomountGate.ts`, on the owning
// analysis' `appliesTo`, unconditionally. Do not "fix" this predicate to match it:
// narrowing here would close those panes rather than merely decline to open them.

import {
  type Contributions,
  type ViewArea,
  type ViewContribution,
  type WhenContext,
  type DatatypeLattice,
  Registry,
} from '@/modules/workbench/core'
import { assertContributableArea } from './regions/regionModel'

const VALID_AREAS: ReadonlySet<string> = new Set<ViewArea>(['left', 'right', 'bottom', 'center'])

/** The ONE view allowed to occupy the reserved CENTER region — the canvas `GridWorkspace`
 *  (registered by `registerBuiltinShellViews` in `shell/builtinViews.ts`). Any OTHER contributed
 *  view declaring `area:'center'` is rejected LOUD (ITEM-15), so no analysis can crowd the canvas. */
const CANVAS_CENTER_VIEW_ID = 'workbench.canvas'

/** Is this view available for the current project context?
 *
 *  TODAY THAT IS ALWAYS TRUE, for every registered view, and it is the RETAINED set —
 *  which pane may STAY open, not which pane gets opened for you. The auto-mount narrowing
 *  lives in `shell/dock/viewAutomountGate.ts`; putting it here instead would CLOSE a pane
 *  the user opened from the launcher's ⚙ for an analysis whose inputs are not present yet.
 *
 *  The predicate is kept (rather than inlined as `true`) because `Registry.availability`
 *  is the shared SoT — if `computeAvailability` ever grows an arm a view can carry, this
 *  call picks it up with no edit here.
 *
 *  The old comment ("availability reduces to the `when` clause") described a
 *  `computeAvailability` that no longer exists: it reads `appliesTo` only, and a view
 *  has none, so this is `[].every(…)`. */
export function isViewAvailable(
  view: ViewContribution,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): boolean {
  return Registry.availability(view, ctx.producedTypeIds, lattice)
}

/**
 * The available, ordered `views` contributed to one dock area. `views.all()` is
 * already sorted by `(order ?? 0)` then id, so filtering preserves that order.
 * An out-of-vocabulary `area` is dropped with a warning (never mis-placed).
 */
export function placeViews(
  registry: Contributions,
  area: ViewArea,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): ViewContribution[] {
  return registry.views.all().filter(v => {
    // ITEM-15: the CENTER region is reserved for the ONE canvas GridWorkspace. Any contributed view
    // that claims `area:'center'` OTHER than the canvas itself is rejected LOUD (never tabbed beside
    // the canvas).
    //
    // This is now the ONLY enforcement point. It used to be the second of two: the declarative fan
    // also dropped a declared `center` region, because a view spec could name its own regions.
    // INV-3 removed that vocabulary — a declarative view no longer chooses an area at all
    // (`seam.ts` assigns the control/run region) — so a `center` claim can only reach here from a
    // hand-authored `ViewContribution`, which is exactly what this guard is for.
    if (v.area === 'center' && v.id !== CANVAS_CENTER_VIEW_ID) {
      assertContributableArea(v.area) // throws — a non-canvas center contribution is illegal
    }
    if (!VALID_AREAS.has(v.area)) {
      // eslint-disable-next-line no-console
      console.warn(`[workbench] view "${v.id}" has invalid area "${v.area}" — dropped`)
      return false
    }
    if (v.area !== area) return false
    return isViewAvailable(v, ctx, lattice)
  })
}

