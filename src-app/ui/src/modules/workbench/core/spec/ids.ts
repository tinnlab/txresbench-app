// Deterministic action-id namespacing for declared `view_spec` actions
// (PLAN.md ITEM-5, DEC-6). A processor's declared action ids (`qc.setEmbedding`)
// are LOCAL to the view; the live `defineAction` registry is global, so each is
// registered under `${viewSpecId}::${actionId}` — collision-free across analyses
// and stable, so a widget's `onChange: qc.setEmbedding` resolves to the same
// namespaced id the interpreter registered. Pure string ops (no state), so the
// namespacing is identical at collect-time (`collect-actions.mjs`) and run-time.

/** The separator between a view_spec id and a local action id. Chosen so it
 *  can't collide with a `.`-bearing action id or a `/`-bearing view id. */
export const ID_SEP = '::'

/** `${viewSpecId}::${actionId}` — the global registry id for a declared action.
 *  Idempotent: an id that already carries the prefix is returned unchanged (so a
 *  widget ref and the collector both converge on the same string). */
export function namespaceActionId(viewSpecId: string, actionId: string): string {
  const prefix = `${viewSpecId}${ID_SEP}`
  return actionId.startsWith(prefix) ? actionId : `${prefix}${actionId}`
}

/** The synthesized read-action id for a view (ITEM-11). */
export function describeActionId(viewSpecId: string): string {
  return `${viewSpecId}${ID_SEP}describe`
}
