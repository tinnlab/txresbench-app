import type { ActionMeta } from './defineAction'

// Shared action SEARCH-TERM helper (richer-actions ITEM-2/3). One source of truth for
// "what terms does an action match on", used by BOTH palettes so the term SET is the
// same: the global ⌘K (`CommandPalette`, which feeds these to cmdk's FUZZY matcher)
// and the workbench palette (`WorkbenchCommandPalette`, which SUBSTRING-matches them
// via `actionMatches`). The matching ALGORITHM differs (fuzzy vs substring); only the
// term set is shared. An action is findable by its title, its (explicit) group, ANY
// alias, ANY keyword, or its description — not only the literal title.

/** The full set of lowercase-able terms an action matches a query against. Only an
 *  EXPLICIT `group` is included (no derived fallback) so the searchable group never
 *  diverges from the palette's displayed group. */
export function actionSearchTerms(meta: ActionMeta): string[] {
  return [meta.title, meta.group, ...meta.aliases, ...meta.keywords, meta.description].filter(
    (t): t is string => !!t,
  )
}

/** Does `query` (case-insensitive substring) match any of the action's terms? An
 *  empty query matches everything (the un-filtered list). */
export function actionMatches(meta: ActionMeta, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return actionSearchTerms(meta).some(term => term.toLowerCase().includes(q))
}
