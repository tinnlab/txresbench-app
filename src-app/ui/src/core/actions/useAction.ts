import { useEffect, useRef } from 'react'
import {
  registerInstance,
  unregisterInstance,
  type InstanceActionHandler,
} from './instanceRegistry'

// `useAction` (PLAN.md ITEM-5; ARCHITECTURE.md Layer 4/6) — the hook a live
// UI surface calls to join the instance registry: mount registers
// `instanceId` (a `view_id`, UUID, never reused), unmount removes it. The
// SAME handlers a human affordance on this surface calls directly (e.g. a
// button's `onClick`) are the ones the AI reaches via `ctx.instance(type,
// instanceId).handlers[actionId]` from a `kind: 'instance'` `defineAction`'s
// `run` (`./defineAction.ts`'s module doc) — one implementation, two callers.
//
// `handlers`/`getSnapshot` are read through a ref updated on every render,
// so the registry always sees the LATEST closures (fresh component state)
// without re-registering (and therefore without a mount/unmount flicker in
// the instance directory) on every render — only `instanceId` changing
// re-registers.

export interface UseActionOptions<T extends Record<string, unknown>> {
  /** The `ctx.instance(storeKey, id)` / `ctx.instances(storeKey)` filter key
   *  — mirrors ARCHITECTURE.md Layer 4's per-Store `view_id -> store`
   *  directory, generalized to a string key since this round has no
   *  `defineLocalStore` class to key on (DEC-4). */
  type: string
  /** `actionId -> handler` for every `kind: 'instance'` action this surface
   *  answers. A `defineAction({kind:'instance', id, run})` resolves to one of
   *  these via `ctx.instance(type, view_id).handlers[id]`. */
  handlers: Record<string, InstanceActionHandler>
  /** Current state, INCLUDING `_state_token` (stamp it with
   *  `./versioned.ts`'s `Versioned.snapshot()`) — read by `ctx.instance`/
   *  `ctx.instances`, the world-model reads (`views.list`/`view.describe`),
   *  and the engine's stale-token guard. Called fresh on every read (never
   *  cached), so it always reflects the LATEST mutation regardless of
   *  whether it came from this component's own UI or an AI-driven invoke. */
  getSnapshot: () => T
}

/**
 * Join the instance registry as `instanceId` for as long as this component
 * is mounted. Call once per live instance (e.g. keyed by a freshly-minted
 * `crypto.randomUUID()` held in component state) — see
 * `src/modules/instance-harness/InstanceHarnessPage.tsx` for the reference
 * usage this slice's e2e proof (TEST-11) drives against.
 */
export function useAction<T extends Record<string, unknown>>(
  instanceId: string,
  options: UseActionOptions<T>,
): void {
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    registerInstance(instanceId, {
      type: optionsRef.current.type,
      getHandlers: () => optionsRef.current.handlers,
      getSnapshot: () => optionsRef.current.getSnapshot(),
    })
    return () => unregisterInstance(instanceId)
    // Intentionally re-register only when `instanceId` changes — `type` is
    // expected stable for a given mounted instance's lifetime; `handlers`/
    // `getSnapshot` are read live via `optionsRef` (see above), never stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])
}
