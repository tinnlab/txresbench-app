// resolveSectionOrder (visualize-pane ITEM-8) — the order the Visualize pane stacks its
// sections in: the user's saved arrangement first, then everything else where its AUTHOR
// said.
//
// ── Why this is not `panesInRegion`'s rule ──────────────────────────────────────────────
//
// The region tab strip already solves a sparse-order problem (`RegionShell.tsx:159-173`):
// rank an id by its index in the saved list, rank an UNKNOWN id `MAX_SAFE_INTEGER`, and let
// a stable sort leave the unknowns in the pane map's insertion order. That rule is
// right for tabs and wrong here, in exactly one place: it discards the DECLARED `order`.
//
// The difference is where the two sets come from. A pane exists because the user opened it,
// so "the order you opened them in" is a real answer for a pane the saved list has never
// heard of. A section exists because a PACKAGE declared it, with an `order` its author chose
// so the stack reads in the order the package intended rather than alphabetically. Under
// the tab rule, a section installed AFTER the user last dragged would land at the bottom of
// the stack regardless of what its author said — and it would land there in registry
// insertion order, which is a fact about module evaluation, not about the section.
//
// So this REFINES the rule rather than reusing it: same sparse-list-wins-first shape, a
// different tiebreak for the ids the list does not name.
//
//   1. every id the user's saved list names, IN THE USER'S ORDER (dragging is the strongest
//      statement of intent there is, and it must survive an install);
//   2. then every other section by declared `order` ASCENDING, `id` as the final tiebreak
//      (so the result is total and stable — never dependent on registration order).
//
// The saved list is SPARSE and never needs to be complete: a list naming one section still
// pins that one and leaves the rest to their authors. It may also name sections that are no
// longer installed — a stale id simply matches nothing (pruning is ITEM-7's job; correctness
// here does not depend on it having run).

/** The minimum a section must expose to be ordered: its id and its author's declared rank. */
export interface OrderableSection {
  id: string
  /** the package's DEFAULT position, ascending. Absent ⇒ ordered after every section that
   *  declared one — an author who declared nothing has expressed no preference, and putting
   *  them FIRST would let an omission outrank a declaration. */
  order?: number
}

/**
 * Order `sections` by the user's saved `userOrder` first, then by each section's declared
 * `order` ascending with `id` as the tiebreak. PURE.
 *
 * Returns a NEW array; the input is not mutated. Every input section appears exactly once in
 * the output, whether or not `userOrder` names it.
 */
export function resolveSectionOrder<S extends OrderableSection>(
  userOrder: readonly string[] | undefined,
  sections: readonly S[],
): S[] {
  const named = new Map<string, number>()
  for (const [i, id] of (userOrder ?? []).entries()) if (!named.has(id)) named.set(id, i)

  const pinned: S[] = []
  const rest: S[] = []
  for (const s of sections) (named.has(s.id) ? pinned : rest).push(s)

  pinned.sort((a, b) => (named.get(a.id) as number) - (named.get(b.id) as number))
  rest.sort((a, b) => declaredRank(a) - declaredRank(b) || a.id.localeCompare(b.id))

  return [...pinned, ...rest]
}

/** An absent `order` sorts AFTER every declared one (see the interface doc). `Infinity` says
 *  that literally, rather than picking a large number that a package could out-declare. */
function declaredRank(s: OrderableSection): number {
  return typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : Number.POSITIVE_INFINITY
}
