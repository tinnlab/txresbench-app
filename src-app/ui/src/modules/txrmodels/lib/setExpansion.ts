/**
 * txrmodels — the one-table set-expansion store (screen J, one-table
 * round): which model sets are EXPANDED in the flat inventory table.
 *
 * The store is module-level on purpose (the brief): the expanded ids
 * survive the page's unmount while the app is open — a Back/forward or a
 * screen round-trip keeps the person's open sets — and are NEVER persisted
 * to disk (a fresh page load starts collapsed). A module-level store
 * cannot be reactive, so the page re-renders through its own tick after
 * the toggle helper mutates the store.
 *
 * The toggle helper is the one mutation path (the brief's "pure helper"):
 * it flips one id and returns the new state, so the page's reveal scroll
 * can read the outcome without re-reading the store.
 */
const expandedIds = new Set<string>()

/** The live snapshot (a fresh Set — the row builder's contract). */
export function expandedSetSnapshot(): Set<string> {
  return new Set(expandedIds)
}

/** True when the set's model rows are shown. */
export function isSetExpanded(setId: string): boolean {
  return expandedIds.has(setId)
}

/** Toggle one set's expansion; returns the new expanded state. */
export function toggleSetExpanded(setId: string): boolean {
  if (expandedIds.has(setId)) {
    expandedIds.delete(setId)
    return false
  }
  expandedIds.add(setId)
  return true
}

/** Clear the store (the tests' birth state; the app never calls it). */
export function clearSetExpansion(): void {
  expandedIds.clear()
}
