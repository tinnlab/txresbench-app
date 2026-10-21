// WHICH DATATYPES SUPPLY POSITIONS — one declaration, read by everything that has to know.
//
// The app knows ZERO domain datatype ids. A contributed type declares the `plottable-xy`
// CAPABILITY in its manifest and the app dispatches on that (DEC-7), so a package that
// contributes positions for something entirely different is served by the same code.
//
// It lives here, alone, because THREE surfaces now ask the same question and a literal
// repeated three times is a rule that fails silently the first time one copy is touched:
//
//   · the centre canvas, deciding whether the project has anything to draw at all;
//   · § Coordinates, offering the artifacts that can frame a picture (`capabilities:
//     [plottable-xy]` in its own yaml — a DECLARATION, which is the one copy that is
//     supposed to exist outside the app);
//   · the anchor's candidacy rule, deciding whether an axis is a row space at all.
//
// The third is why this file exists. It arrived with the defect that a row space was
// taken to be "any axis the catalog publishes", so one imported file published two of
// them and the pane asked a question with a wrong answer in it.

import type { DatatypeLattice } from './lattice.ts'

/**
 * The DECLARED capability a datatype advertises when its artifacts carry positions a
 * picture can be drawn in.
 *
 * A capability NAME, never a datatype id and never a domain word — which is precisely what
 * makes it sayable in the app at all.
 */
export const PLOTTABLE_XY_CAPABILITY = 'plottable-xy'

/**
 * Does this datatype DECLARE that it supplies positions?
 *
 * Defensive around `lattice.matches`: a host that has not injected the real registry yet
 * (a bare unit context, a fresh gallery) must answer NO rather than throw. The asymmetry is
 * deliberate and is the same one `matchesTypeFilter` states for its negative constraints —
 * an unanswerable capability question that answered YES would offer exactly what the
 * question exists to narrow.
 */
export function declaresPositions(datatypeId: string, lattice: DatatypeLattice | undefined): boolean {
  if (!lattice) return false
  try {
    return lattice.matches(datatypeId, { capabilities: [PLOTTABLE_XY_CAPABILITY] })
  } catch {
    return false
  }
}
