// annotateDock.ts — the pure DOCK decision for the OPEN annotate cells' `AnnotateControls` panels.
// Mirrors the edit-form dock seam in `GridWorkspace.tsx` (the `for (const id of editCellIds)` loop
// that resolves `editFormContainer?.(id) ?? null` per pane → portal-vs-internal): the workspace
// renders EACH open pane's annotate class-panel either PORTALED into a host-provided container
// (`annotateControlsContainer`, called ONCE PER OPEN PANE) or STACKED in the internal right panel.
//
// ITEM-9 / INV-12: this resolver returns a LIST — one dock per open pane — because a pane-attached
// editing surface may be open on SEVERAL panes at once. The prior single-dock form (one dock for a
// "focused" cell) was the defect: it copied `editFormContainer`'s signature while inverting its
// per-pane semantics. Factored out as a pure function so the branching is unit-testable under the
// node-only vitest harness (which cannot render the deck.gl-backed `GridWorkspace` component).

export type AnnotateDockEntry =
  /** Stack this pane's panel in the grid's internal right panel (host resolver absent/returned nothing). */
  | { readonly kind: 'internal'; readonly cellId: string }
  /** Portal this pane's panel into the host-provided container. */
  | { readonly kind: 'portal'; readonly cellId: string; readonly host: HTMLElement }

/**
 * Resolve where EACH open annotate cell's `AnnotateControls` should render. Byte-identical to the
 * edit-form seam, per pane: portal when the host resolver returns an element for that pane, else the
 * internal right panel. Returns `[]` when nothing should render (not the primary container, not in
 * annotate mode, or no pane open) — the caller renders nothing, exactly as the old `'hidden'` did.
 *
 * `openCellIds` is iterated in the order given, so the internal panel's stacking order is the
 * caller's (grid) order rather than a Set's insertion order.
 */
export function resolveAnnotateDocks(args: {
  readonly isPrimaryContainer: boolean
  readonly annotateMode: boolean
  readonly openCellIds: readonly string[]
  readonly container?: (paneId: string) => HTMLElement | null | undefined
}): AnnotateDockEntry[] {
  const { isPrimaryContainer, annotateMode, openCellIds, container } = args
  if (!isPrimaryContainer || !annotateMode) return []
  const out: AnnotateDockEntry[] = []
  for (const cellId of openCellIds) {
    if (!cellId) continue
    const host = container?.(cellId) ?? null
    out.push(host ? { kind: 'portal', cellId, host } : { kind: 'internal', cellId })
  }
  return out
}
