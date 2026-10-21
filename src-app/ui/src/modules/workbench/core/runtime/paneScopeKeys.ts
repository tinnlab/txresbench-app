// The PANE's value names — INV-13's closed set, in a module with NO runtime dependencies.
//
// It lives apart from `paneScope.store.ts` because two very different layers need it and only one
// of them may depend on a store: the store itself (which holds the values) and `parseViewSpec`
// (which REFUSES a spec that tries to mint a third one). The parser is a pure function that also
// runs in bare node processes with no bundler and no React — importing a zustand store into it to
// read two strings would put a runtime graph behind a parse.

/**
 * The keys pane scope may ever carry (INV-13), enumerated so a third cannot be added without
 * arguing with a test. Both are RADIOS and both are read by every section; together they are
 * *the frame*.
 */
export const PANE_SCOPE_KEYS = ['axis', 'coordinate'] as const

export type PaneScopeKey = (typeof PANE_SCOPE_KEYS)[number]

/** Is `name` one of the pane's values? The one predicate both the parser and the store use. */
export function isPaneScopeKey(name: string): name is PaneScopeKey {
  return (PANE_SCOPE_KEYS as readonly string[]).includes(name)
}
