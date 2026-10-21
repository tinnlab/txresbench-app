// The declarative-view AUTO-MOUNT GATE. It is the shipped behaviour — there is no flag.
//
// It shipped once behind `?gateViewAutomount=1` / `VITE_GATE_VIEW_AUTOMOUNT=1`, default OFF, so
// the owner could compare screenshots of the two behaviours against ONE build. That comparison
// happened, the gated side was adopted, and the switch is GONE: a flag nobody sets is a second
// code path nothing exercises, and this repo deletes those rather than keeping them "in case".
//
// ## What it changed
//
// `loadProcessors.ts` registers each analysis' `ui:` stack as a `ViewContribution` with NO
// `when:` clause, and `computeAvailability` reads only `appliesTo` — which a view never carries.
// A contributed view's availability therefore reduces to `[].every(…)` === TRUE, unconditionally,
// so `paneReconcile` used to auto-mount EVERY declarative analysis' pane, including on a project
// with no artifacts at all. This module is what stops that.
//
// ## What the gate keys on, and why THAT
//
// The owning ANALYSIS' `appliesTo`, evaluated through the SHARED `computeAvailability`
// predicate — the same one `launcherAvailability.rowAvailability` uses. So "the pane
// auto-mounted" and "the launcher row says `available`" are the same fact by construction, and
// the complementary affordance survives: an analysis whose inputs are not present is still
// LISTED in the launcher as `needs-<type>` (disabled-with-a-reason, the owner's list-and-explain
// ruling), and its ⚙ "open the analysis form" button still opens the pane on demand. Only the
// UNASKED-FOR mount goes away.
//
// The view spec's own `inspects:` key is NOT the input — and as of visualize-pane ITEM-68 it
// no longer exists. It was declared by all three shipped specs, read by nothing, and it
// duplicated the manifest selector it sat beside; a key with no consumer has no defined
// meaning, so a later reader would have been free to invent one. Gating on `appliesTo` reuses
// the declaration the launcher, the MCP capability manifest and the fallback form already
// agree on. `viewSpec.test.ts` (TEST-83) holds the key removed.
//
// The ARCH lens is deliberately NOT applied (`computeAvailability`, not
// `computeAvailabilityWithArch`): an arch-incompatible analysis is `available` and merely not
// `runnable`, and the launcher lists it rather than hiding it. Mounting is applicability, not
// runnability.
//
// ## Fail-OPEN for a view no analysis owns
//
// A `ViewContribution` with no analysis of the same id (a hand-authored shell/test view) has no
// declared inspected type, so there is nothing to gate on and it keeps mounting. The gate can
// only ever REMOVE the mount of a view whose own analysis declares an input the project has not
// produced.
//
// ## What it does NOT narrow
//
// The RETAINED set. See `reconcileViews` — a pane the user opened on purpose for a gated
// analysis must not be closed a frame later by the same pass that refused to mount it.

import {
  computeAvailability,
  type Contributions,
  type DatatypeLattice,
  type WhenContext,
} from '@/modules/workbench/core'

/**
 * Should this contributed view AUTO-MOUNT into a pane? PURE.
 *
 * `viewId` is the ANALYSIS id (`seam.viewSpecsToContribution` keys the contribution on it), so
 * the owning analysis is a direct registry lookup. No analysis ⇒ nothing declares an inspected
 * type ⇒ TRUE (fail-open; see the header).
 */
export function isViewAutoMountable(
  viewId: string,
  registry: Contributions,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): boolean {
  const analysis = registry.analyses?.get(viewId)
  if (!analysis) return true
  return computeAvailability(analysis, ctx, lattice)
}
