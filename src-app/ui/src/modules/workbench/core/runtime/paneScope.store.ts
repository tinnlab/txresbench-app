// `$scope` — THE PANE-LEVEL SHARED STATE (visualize-pane ITEM-10 / ITEM-12).
//
// ── Why this is a workbench value and not a section's state ─────────────────────────────
//
// Design §4.5: *"Sections have isolated stores. No free-form cross-section channel in v1.
// Exactly ONE shared value: `$scope.axis`, owned by the workbench."* The thing every section
// reacts to is not another section's state — it is WHICH ROWS THE PANE IS ABOUT. So it sits
// beside `projectId` and `catalogEpoch` and is READ by any section through a `$`-ref.
//
// ── `axis` IS NOT CHOSEN. IT IS DERIVED (owner, 2026-08-13) ────────────────────────────
//
// The pane's first block used to be a control that ASKED which rows the pane was about. The
// owner's ruling is that the question does not exist — an axis is not a thing anybody picks —
// so that control is gone, § Coordinates is the pane's first block, and `axis` is now written
// ONLY by {@link PaneScopeState.setDerivedAxis}, from the coordinate set the user picked
// (`./coordinateAxis.ts`). There is no `setAxis`, no origin to record (nobody chose it, and
// nobody chose it in a way a user could review), and a view may not write it.
//
// ── The closed set, and what is deliberately NOT in it ──────────────────────────────────
//
// INV-13 caps pane state at the design's two values, and the enumeration below is what makes
// that checkable rather than promised: `PANE_SCOPE_KEYS` is asserted by `paneScope.test.ts`,
// so a third value — a `$scope.colorBy`, the one the design explicitly removed ("there is no
// such fact") — fails a test rather than passing review.
//
// ── HOW A SECTION WRITES A PANE VALUE (ITEM-11's seam) ─────────────────────────────────
//
// `coordinate` was declared here and written by nothing, because a section writes through a
// declared action's `set`, which addresses its OWN store. Of the three candidates — a
// pane-scoped `StateFieldSpec`, a new effect op, or the stack mirroring one section's state —
// the middle one is refused (`EFFECT_OPS` stays closed) and the last would make the stack
// NAME a section (§4.5). So the seam is the first: a `state` field may declare
// `scope: pane`, and the view store routes its reads and writes THROUGH this store
// (`core/runtime/store.ts`). The section still writes `set: { coordinate: … }` exactly as it
// writes any other field — the declaration is what makes that field the pane's rather than
// its own — so no new vocabulary reaches an author and INV-13's closed set is enforced by
// `parseViewSpec` refusing a `scope: pane` field whose name is not in `PANE_SCOPE_KEYS`.
//
// INV-8's binding half now runs the other way and needs no special case: the coordinate is the
// choice and the axis follows it, so a coordinate that changes re-derives the axis and a
// coordinate that is cleared clears it. A picture can no longer be drawn against rows nobody
// pointed at, because the rows ARE the ones the chosen positions declare.

import { create } from 'zustand'
import { PANE_SCOPE_KEYS, isPaneScopeKey } from './paneScopeKeys'

// The closed set lives in `./paneScopeKeys` (a dependency-free module) because `parseViewSpec`
// needs it too and must not import a store; it is RE-EXPORTED here so every existing reader of
// this module is unchanged and there is still exactly one definition.
export { PANE_SCOPE_KEYS, isPaneScopeKey, type PaneScopeKey } from './paneScopeKeys'

export interface PaneScope {
  /**
   * WHICH ROWS — the `AxisSummary.content_hash` of EVERY axis the chosen coordinate rests on
   * (ITEM-10, made plural by ITEM-8). Never a dataset id, never an artifact id, never a label.
   * DERIVED from {@link PaneScope.coordinate}, never asked.
   *
   * A LIST because an integrated coordinate rests on two datasets' axes at once and neither is
   * "the" one; the ordinary single-dataset case is a one-entry list, which is what `anchorId`
   * already reads as one anchor, so every consumer that genuinely needs ONE axis is unchanged
   * and the consumers that compose over several ask `anchorIds`.
   *
   * `[]` — never `null` — while no coordinate is chosen or while the join cannot be decided
   * from declarations, and every axis-scoped source is correspondingly EMPTY then. One absence
   * spelling, so no consumer has to decide whether a missing axis is `null` or an empty list.
   */
  axis: readonly string[]
  /** WHICH POSITIONS — the coordinate artifact the points are drawn in (ITEM-11). The pane's
   *  ONE user choice, and the thing `axis` is derived from. */
  coordinate: string | null
}

const EMPTY: PaneScope = { axis: [], coordinate: null }

interface PaneScopeState {
  /** The project the current scope belongs to. A scope is meaningless across projects — a
   *  `content_hash` from project A names nothing in project B — so switching projects RESETS
   *  rather than carrying, and the reset is keyed here rather than left to a caller to
   *  remember. */
  projectId: string | null
  scope: PaneScope
  /**
   * Write the axis DERIVED from the current coordinate (`./coordinateAxis.ts`).
   *
   * Not a choice and not a field write, which is why it is its own named entry point rather
   * than an arm of {@link PaneScopeState.setValue}: `setValue` is the seam a SECTION writes
   * through, and no section may write this. `[]` is a real answer — no coordinate, or a
   * join no declaration could decide — and it is written as readily as a list of hashes,
   * because a stale axis outliving the positions it was derived from is the wrong-rows failure
   * this pane exists to prevent.
   */
  setDerivedAxis: (projectId: string, axis: readonly string[]) => void
  /**
   * Set ONE pane value by name — the write half of the `scope: pane` state seam.
   *
   * Keyed rather than one setter per value so the store cannot grow a setter for a key that is
   * not in {@link PANE_SCOPE_KEYS}: an unknown name is REFUSED (and reported), which is INV-13
   * enforced at the write rather than only at the type. `axis` is REFUSED here too, and for a
   * stronger reason than an unknown name: it is derived, so a section writing it would be
   * asserting rows nothing declared.
   */
  setValue: (key: string, value: string | null) => void
  /** Point the pane's project. A CHANGE clears the scope; the same id is a no-op, so this is
   *  safe to call from a render effect. */
  bindProject: (projectId: string) => void
  /** Test-only: forget everything. */
  reset: () => void
}

/** Do two derived axis lists name the same axes, in the same order? ORDER MATTERS: it is the
 *  order the coordinate declared its memberships in, and that order is the anchor's segment
 *  order (INV-7) — two lists holding the same hashes in the other order are two different
 *  row sequences, not one value written twice. */
function sameAxes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i])
}

export const paneScopeStore = create<PaneScopeState>((set, get) => ({
  projectId: null,
  scope: EMPTY,
  setDerivedAxis: (projectId, axis) => {
    const prev = get()
    // The derivation runs on every catalog + coordinate change, so the no-op case is the
    // common one and must not replace `scope` — replacing it would re-render every section
    // that reads `$scope` for a value that did not move. The compare is ELEMENT-WISE since
    // ITEM-8 made the value a LIST: the derivation rebuilds that list every time, so a
    // reference compare would call every re-derivation a change and the no-op case would
    // never be taken.
    if (prev.projectId === projectId && sameAxes(prev.scope.axis, axis)) return
    // The COORDINATE is carried, deliberately: it is what the axis was derived FROM, so
    // clearing it here would destroy the choice in the act of recording its consequence.
    set({ projectId, scope: { ...prev.scope, axis } })
  },
  setValue: (key, value) => {
    const prev = get()
    // A pane value is meaningless before the pane knows WHICH PROJECT it is about — a
    // `content_hash` or an artifact id from project A names nothing in project B — so a write
    // that arrives before `bindProject` is REFUSED rather than stored under a placeholder id
    // that `bindProject` would then clear from under it.
    if (prev.projectId === null) return
    if (key === 'axis') {
      // DERIVED, so not writable through the section seam. Loud for the same reason an unknown
      // key is: a declaration that writes into nothing and reads back the derived value forever
      // is a control that looks wired and is not.
      console.error('[declarative] "axis" is derived from the chosen coordinate and cannot be set by a view')
      return
    }
    if (!isPaneScopeKey(key)) {
      // Loud, not silent: a section declaring `scope: pane` on a field this store does not hold
      // would otherwise write into nothing and read back `null` forever — a control that looks
      // wired and is not. `parseViewSpec` refuses it at load; this is the runtime backstop for a
      // caller that did not come through the parser.
      console.error(`[declarative] pane scope has no value named "${key}" (INV-13: ${PANE_SCOPE_KEYS.join(', ')})`)
      return
    }
    if (prev.scope[key] === value) return
    set({ scope: { ...prev.scope, [key]: value } })
  },
  bindProject: projectId => {
    if (get().projectId === projectId) return
    set({ projectId, scope: EMPTY })
  },
  reset: () => set({ projectId: null, scope: EMPTY }),
}))

/** The pane scope as a `$`-ref root — what `DeclarativeRegion` publishes as `$scope`.
 *  A plain read, so a caller outside React (the data resolver's request key) uses the same
 *  value the render does. */
export function currentPaneScope(): PaneScope {
  return paneScopeStore.getState().scope
}
