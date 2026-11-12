// The SINGLE availability predicate (extracted per audit MAINT-1/CORR-2). Every
// public entry point that answers "is this contribution available given the
// project's produced datatypes?" MUST route through here so the two surfaces
// (`Registry.availability` and `buildContributionCatalog`) can never disagree.
// A contribution is available when (a) every REQUIRED
// `accepts` selector is satisfied by some available datatype (subtype match via the
// injected lattice) AND (b) its `when` clause (if any) holds for the context.
// Gating (`permission`) stays the host's render-time concern — never here.

import type { TypeSelector } from '../datatypes/types.ts'
import type { DatatypeLattice } from '../datatypes/lattice.ts'
import type { WhenClause, WhenContext } from '../datatypes/when.ts'
import { evaluateWhen } from '../datatypes/when.ts'

/** The typed inputs an availability check reads off a contribution. */
export interface AvailabilityInputs {
  /** The applicability selectors — all required. See `computeAvailability`. */
  appliesTo?: TypeSelector[]
  /** CPU arches this contribution can run on (ITEM-26 / DEC-29). Empty/undefined
   *  ⇒ ALL arches (default; existing processors unaffected). ONLY the arch lens
   *  (`computeAvailabilityWithArch`) reads it — the plain `computeAvailability`
   *  applicability predicate ignores it (arch is a runnability axis, not an
   *  applicability one). */
  arch?: string[]
}

export function computeAvailability(
  contribution: AvailabilityInputs,
  ctx: WhenContext,
  lattice: DatatypeLattice,
): boolean {
  // Availability is DERIVED from `appliesTo` — every entry required, no exceptions.
  //
  // The `required === false` arm is gone with `accepts`: an optional entry never
  // gated anything (it existed to carry a chaining edge, now `consumes`), so an
  // `.every()` over a list containing one was really an `.every()` over the rest.
  //
  // `when` is gone too. Its one shipped use was a `has:<type>` sitting
  // beside an `accepts` for a SUBTYPE of the same thing — a weaker restatement that
  // could never independently fail, and which existed because "accepts" reads
  // permissive enough to feel like it needed reinforcing. "appliesTo … required by
  // definition" does not, so there is nothing left to restate.
  const appliesTo = contribution.appliesTo ?? []
  return appliesTo.every(sel => ctx.producedTypeIds.some(id => lattice.matches(id, sel)))
}

// ─────────────────────────── the arch lens (ITEM-26 / DEC-29) ────────────────

/** The two CPU arches txresbench/txresbench supports. `computeAvailabilityWithArch`
 *  accepts any string for forward-compat, so an unrecognized backend arch simply
 *  matches nothing in a non-empty `arch` list. */
export type BackendArch = 'x86_64' | 'aarch64'

/** The richer availability verdict with the CPU-arch lens layered on (DEC-29):
 *  - `available` = applicable to the current data/context (accepts + `when`) —
 *    i.e. whether the picker LISTS it at all.
 *  - `runnable` = applicable AND arch-compatible with the backend — whether it
 *    can actually run here.
 *  - `reason` (only when `available && !runnable`) = the human "why it's
 *    disabled" string ("requires an x86_64 backend"). A disabled-but-listed
 *    analysis keeps `available:true`, so the surface DISABLES + explains, never
 *    HIDES (owner 2026-07-17). */
export interface AvailabilityResult {
  available: boolean
  runnable: boolean
  reason?: string
}

/** Whether a declared `arch` list can run on `backendArch`. Empty/undefined ⇒ all
 *  arches (the default that keeps existing processors runnable everywhere). */
export function archSupportsBackend(arch: string[] | undefined, backendArch: string): boolean {
  return arch === undefined || arch.length === 0 || arch.includes(backendArch)
}

/** The reason a listed-but-disabled analysis can't run on this backend
 *  (`arch` is non-empty + excludes the backend arch). E.g. `['x86_64']` →
 *  "requires an x86_64 backend"; `['x86_64','aarch64']` → "requires an x86_64 or
 *  aarch64 backend". */
export function archUnavailableReason(arch: string[]): string {
  return `requires an ${arch.join(' or ')} backend`
}

/**
 * Availability WITH the CPU-arch lens (ITEM-26 / DEC-29). Layers arch runnability
 * on top of the shared applicability predicate (`computeAvailability`):
 *  - not applicable (accepts / `when`) ⇒ `{available:false, runnable:false}` — the
 *    picker hides it (arch never OVERRIDES applicability).
 *  - applicable + arch-compatible ⇒ `{available:true, runnable:true}`.
 *  - applicable + arch-INCOMPATIBLE ⇒ `{available:true, runnable:false, reason}` —
 *    still LISTED (disabled), NOT hidden. No emulation: an x86-only tool is never
 *    marked runnable on aarch64.
 */
export function computeAvailabilityWithArch(
  contribution: AvailabilityInputs,
  ctx: WhenContext,
  lattice: DatatypeLattice,
  backendArch: string,
): AvailabilityResult {
  const available = computeAvailability(contribution, ctx, lattice)
  if (!available) return { available: false, runnable: false }
  if (archSupportsBackend(contribution.arch, backendArch)) {
    return { available: true, runnable: true }
  }
  return {
    available: true,
    runnable: false,
    reason: archUnavailableReason(contribution.arch ?? []),
  }
}
