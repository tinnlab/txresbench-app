// THE SECTION HEADER BADGE (visualize-pane ITEM-64 / R6 / INV-7).
//
// ── Why a store and not a prop ──────────────────────────────────────────────────────────
//
// R6: *"a COLLAPSED section states that it holds state. Collapse is display, not reset: an
// active filter or chosen entry shows the header badge."* The frame that draws the badge is
// the HOST's (`SectionFrame`, so a section cannot forget to have one), and what a section is
// HOLDING is known only inside that section's own view store — which the host deliberately
// does not read: a stack that reached into a section's state would be naming its fields.
//
// So the section DECLARES what its badge counts (`ViewSpec.badge`, an expression over its own
// state), each mounted region publishes the resolved value here, and the stack reads it back
// by `view_id` — the same id it already uses to order canvas contributions. The host learns a
// NUMBER and never a field name.
//
// ── What the badge may not become ───────────────────────────────────────────────────────
//
// It must not be a count of "dirty" fields or of anything the host can infer, which is why
// nothing here derives a default. A section that declares no badge publishes none and the
// frame renders none — the honest "holds nothing". A wired-looking badge that means nothing is
// precisely the failure R6 exists to prevent.

import { create } from 'zustand'

interface SectionBadgeState {
  /** `view_id → the count that view's badge currently states`. Absent ⇒ the view declares no
   *  badge, or it resolved to nothing worth marking. */
  byView: Record<string, number>
  /** Publish (or, with `0`/`undefined`, retract) one view's badge. Idempotent — safe to call
   *  from a render effect on every revision. */
  publish: (viewId: string, count: number | undefined) => void
  /** Forget a view entirely (unmount). */
  clear: (viewId: string) => void
  /** Test-only: forget everything. */
  reset: () => void
}

export const sectionBadgeStore = create<SectionBadgeState>((set, get) => ({
  byView: {},
  publish: (viewId, count) => {
    const cur = get().byView
    // A badge is a mark that a section HOLDS something, so zero is not a small badge — it is no
    // badge. Retracting rather than storing `0` is what makes "absent" the single spelling of
    // "holds nothing", so the frame has one thing to test.
    const next = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined
    if (next === undefined) {
      if (!(viewId in cur)) return
      const { [viewId]: _drop, ...rest } = cur
      set({ byView: rest })
      return
    }
    if (cur[viewId] === next) return
    set({ byView: { ...cur, [viewId]: next } })
  },
  clear: viewId => {
    const cur = get().byView
    if (!(viewId in cur)) return
    const { [viewId]: _drop, ...rest } = cur
    set({ byView: rest })
  },
  reset: () => set({ byView: {} }),
}))

/** The badge a SECTION states — the sum over the views it contributes, or `undefined` when they
 *  hold nothing between them. Summed rather than taken from the first view because a section's
 *  several `ui:` files are one section to the reader; two badges on one header would be the
 *  implementation detail leaking. */
export function sectionBadgeOf(byView: Record<string, number>, viewIds: readonly string[]): number | undefined {
  let total = 0
  for (const id of viewIds) total += byView[id] ?? 0
  return total > 0 ? total : undefined
}
