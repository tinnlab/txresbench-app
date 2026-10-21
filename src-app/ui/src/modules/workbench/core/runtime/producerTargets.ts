// producerTargets — which analyses could produce what THIS one consumes.
//
// The target of a "you have nothing to filter on yet — compute it first" affordance is not the
// view author's to name. Writing another package's analysis id into a view breaks SILENTLY —
// a dead affordance, not an error — the moment someone ships a different producer, renames one,
// or works in a domain whose producer is called something else entirely.
//
// It is derivable, and from declarations that already exist: an analysis says what it `consumes`
// and every analysis says what it `produces`. So the guidance TEXT is authored (the view owns
// what its user reads) and the DESTINATION is derived (DEC-6). A new domain inherits the
// affordance with no edit anywhere.

/** The shape this needs from an analysis — a structural subset, so the derivation can be tested
 *  without constructing a whole contribution. */
export interface ProducerCandidate {
  id: string
  title?: string
  consumes?: string[]
  produces?: string[]
}

export interface ProducerTarget {
  id: string
  /** What the affordance READS as — the target's OWN title, never a string the consumer wrote.
   *  A consumer that labelled the button itself would go stale the same way a hardcoded id does. */
  title: string
}

/**
 * The analyses that produce at least one datatype `consumerId` consumes.
 *
 * Deliberately NOT ranked and never narrowed to one: with several producers, choosing for the
 * user is the "only one match, selected automatically" mistake that once bound a label
 * picker to identifier columns. Zero, one and several are three different renderings (DEC-7), and this
 * returns the honest set for the caller to render.
 *
 * Self-exclusion is not a special case — an analysis that produced what it consumed would be
 * offering to launch itself as the remedy for its own empty state.
 */
export function producerTargets(
  consumerId: string,
  analyses: readonly ProducerCandidate[],
): ProducerTarget[] {
  const consumer = analyses.find(a => a.id === consumerId)
  const needed = new Set(consumer?.consumes ?? [])
  if (needed.size === 0) return []
  return analyses
    .filter(a => a.id !== consumerId && (a.produces ?? []).some(t => needed.has(t)))
    .map(a => ({ id: a.id, title: a.title ?? a.id }))
}
