// The declarative ViewStore directory (PLAN.md ITEM-5). A mounted declarative
// view creates its per-instance reactive store (`createViewStore`, ITEM-3) and
// registers it here under its `view_id`; the action interpreter (`interpreter.ts`)
// resolves the SAME store when a declared action targets that `view_id` — so a
// `set` op mutates the live view a human is looking at / the AI is driving.
//
// This is a THIN sibling of `core/actions/instanceRegistry` (which the store also
// joins, for `ctx.instance`/`describe`): the instance registry exposes a
// snapshot + handlers, whereas the interpreter needs the store's `set`/`state`/
// `derived` directly. Keeping this a small declarative-local map avoids widening
// the shared `InstanceHandle` shape. Module-level singleton (one browser tab).

import type { ViewStore } from './store'

const stores = new Map<string, ViewStore>()

/** Register (or replace) the live declarative store for `viewId`. Called by the
 *  mount path (`WidgetHost`) alongside `createViewStore`. A remount replacing
 *  its own record is normal (mirrors `registerInstance`). */
export function registerViewStore(viewId: string, store: ViewStore): void {
  stores.set(viewId, store)
}

/** Unregister `viewId` — called on unmount. No-op if already replaced. */
export function unregisterViewStore(viewId: string): void {
  stores.delete(viewId)
}

/** The live declarative store for `viewId`, or `undefined` if none is mounted. */
export function getViewStore(viewId: string): ViewStore | undefined {
  return stores.get(viewId)
}

/** Test-only reset (mirrors `__resetInstanceRegistryForTests`). */
export function __resetViewStoresForTests(): void {
  stores.clear()
}
