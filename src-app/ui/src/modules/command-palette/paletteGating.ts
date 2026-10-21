import type { ActionMeta } from '@/core/actions/defineAction'

// The PURE command-palette gating predicate (PLAN.md ITEM-3), extracted out of
// `CommandPalette.tsx` so it is unit-testable in isolation (TEST-103) with no
// React / store / registry dependency. Every input the decision needs is
// INJECTED via `PaletteGatingDeps`, so this module imports only the
// `ActionMeta` TYPE (elided at build) — the real palette supplies the deps
// from `activeContext` / `hasPermissionNow` / the instance registry.
//
// An action is offered in ⌘K iff ALL hold:
//   1. `surfaces.palette !== false`      — it hasn't opted out of the palette;
//   2. `context === 'global'` OR its context is currently active — it belongs
//      "where the user is" (`activeContext.isContextActive`);
//   3. `hasPermissionNow(permission)`    — the user may invoke it.
// A `kind:'instance'` action is additionally offered ONLY when there is an
// active FOCUSED instance for its context (the palette supplies that
// instance's `view_id`); with no focused instance it is not offerable from a
// generic launcher and is excluded (this is why the pre-ITEM-3 palette simply
// dropped every instance action).

/** The runtime facts the pure gate needs, injected by the caller. */
export interface PaletteGatingDeps {
  /** Is this (non-`'global'`) context currently active? — backed by
   *  `activeContext.isContextActive`. */
  isContextActive: (context: string) => boolean
  /** May the current user invoke this permission now? — backed by
   *  `hasPermissionNow`. */
  hasPermission: (permission: string) => boolean
  /** The `view_id` of the active focused instance for `context`, or
   *  `undefined` when none is focused — backed by the instance registry
   *  (`instancesOfType(context)`). Only consulted for `kind:'instance'`
   *  actions. */
  activeInstanceId: (context: string) => string | undefined
}

/** An action that passed the gate, plus (for instance actions) the resolved
 *  target the palette must supply as `view_id`. */
export interface GatedAction {
  meta: ActionMeta
  /** Present ⟺ `meta.kind === 'instance'` — the focused instance's `view_id`. */
  viewId?: string
}

/** Decide whether ONE action is offered in the palette. Returns the gated
 *  action (with a resolved `viewId` for an instance action) or `null` when it
 *  should not appear. */
export function gateAction(meta: ActionMeta, deps: PaletteGatingDeps): GatedAction | null {
  // (1) opted out of the palette surface.
  if (meta.surfaces.palette === false) return null
  // (2) context precondition.
  if (meta.context !== 'global' && !deps.isContextActive(meta.context)) return null
  // (3) permission.
  if (!deps.hasPermission(meta.permission)) return null

  if (meta.kind === 'instance') {
    // Offer the instance action against the active focused instance of its
    // context; with none focused it is not offerable from the launcher.
    const viewId = deps.activeInstanceId(meta.context)
    if (!viewId) return null
    return { meta, viewId }
  }

  return { meta }
}

/** Gate an entire list, preserving order and dropping the excluded. */
export function gatePaletteActions(metas: readonly ActionMeta[], deps: PaletteGatingDeps): GatedAction[] {
  const out: GatedAction[] = []
  for (const meta of metas) {
    const gated = gateAction(meta, deps)
    if (gated) out.push(gated)
  }
  return out
}
