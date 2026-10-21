import type { ActionContext } from './ctx'

// The INSTANCE registry (PLAN.md ITEM-5; ARCHITECTURE.md Layer 4). Backs
// `kind: 'instance'` actions: a live, mounted UI surface (a React component
// using `./useAction`) joins this registry under a stable `instanceId` (a
// `view_id`, UUID, never reused — ARCHITECTURE.md Layer 6), exposing:
//   - a `type` (the "store key" `ctx.instance(storeKey, id)` filters on),
//   - a set of per-actionId handlers (what actually runs a `kind: 'instance'`
//     action's `defineAction.run`, resolved via `ctx.instance`),
//   - a `getSnapshot()` reader whose returned object carries `_state_token`
//     (stamped by `./versioned.ts`) — the read-before-write guard's ground
//     truth (`./engine.ts`'s `handleInvoke` reads it BEFORE dispatching a
//     mutating+stateful invoke).
//
// Two lookup shapes over the SAME underlying map:
//   - by `instanceId` (`ctx.instance`, the engine's stale-token/NOT_FOUND
//     checks, `view.describe`) — O(1).
//   - by `type` (`ctx.instances`, `views.list`'s world-model directory) —
//     O(n) over the (expected small) live-instance set, no secondary index
//     needed at this scale.
//
// Module-level singleton (mirrors `./defineAction.ts`'s `registry` Map) —
// every consumer (the engine, `ctx`, the world-model read actions, a
// component's `useAction`) reads/writes the ONE process-wide instance
// directory, matching the real (single browser tab) runtime.

export type InstanceActionHandler = (
  params: unknown,
  ctx: ActionContext,
) => unknown | Promise<unknown>

/** What a mounted instance registers. `getHandlers`/`getSnapshot` are
 *  lazily-read accessors (not a one-time snapshot) so `useAction` can keep a
 *  single registration alive across re-renders while always resolving the
 *  LATEST handlers/state (see `./useAction.ts`'s ref-based wiring). */
export interface InstanceRecord {
  type: string
  getHandlers: () => Record<string, InstanceActionHandler>
  getSnapshot: () => Record<string, unknown>
}

/** The read-only view of one live instance a `ctx.instance`/`ctx.instances`
 *  caller receives — a materialized snapshot of the record at read time. */
export interface InstanceHandle {
  id: string
  type: string
  handlers: Record<string, InstanceActionHandler>
  snapshot: Record<string, unknown>
}

const instances = new Map<string, InstanceRecord>()

/** Register (or replace) the live instance `id`. Called from `useAction`'s
 *  mount effect — a duplicate `id` (e.g. a fast remount) simply overwrites
 *  the prior record, mirroring `defineAction`'s "last registration wins for
 *  a given key at any instant" shape (unlike the GLOBAL registry, a
 *  duplicate instance id is not a programmer error worth throwing over — a
 *  remount replacing its own record is normal React behavior). */
export function registerInstance(id: string, record: InstanceRecord): void {
  instances.set(id, record)
}

/** Unregister `id` — called from `useAction`'s unmount cleanup. A no-op if
 *  `id` isn't currently registered (e.g. already replaced by a remount). */
export function unregisterInstance(id: string): void {
  instances.delete(id)
}

/** The raw registered record for `id`, if currently mounted. */
export function getInstanceRecord(id: string): InstanceRecord | undefined {
  return instances.get(id)
}

/** Every currently-mounted instance whose `type` matches `storeKey`. */
export function instancesOfType(storeKey: string): Array<{ id: string; record: InstanceRecord }> {
  const out: Array<{ id: string; record: InstanceRecord }> = []
  for (const [id, record] of instances) {
    if (record.type === storeKey) out.push({ id, record })
  }
  return out
}

/** Every currently-mounted instance, materialized for the world-model
 *  `views.list` read (`./builtin/worldModel.ts`). */
export function listAllInstances(): Array<{
  id: string
  type: string
  snapshot: Record<string, unknown>
}> {
  return Array.from(instances.entries()).map(([id, record]) => ({
    id,
    type: record.type,
    snapshot: record.getSnapshot(),
  }))
}

/** The handler registered for `actionId` on the live instance `instanceId`,
 *  if both the instance and that specific handler exist. */
export function getInstanceHandler(
  instanceId: string,
  actionId: string,
): InstanceActionHandler | undefined {
  return instances.get(instanceId)?.getHandlers()[actionId]
}

/** The live `_state_token` for `instanceId` (ARCHITECTURE.md Layer 6),
 *  `undefined` if unmounted or the snapshot carries no token. */
export function getInstanceStateToken(instanceId: string): string | undefined {
  const token = instances.get(instanceId)?.getSnapshot()['_state_token']
  return typeof token === 'string' ? token : undefined
}

/** `ctx.instance(storeKey, id)` — a live instance handle, or `undefined`
 *  when unmounted OR mounted under a different `type`. */
export function resolveInstance(storeKey: string, id: string): InstanceHandle | undefined {
  const record = instances.get(id)
  if (!record || record.type !== storeKey) return undefined
  return { id, type: record.type, handlers: record.getHandlers(), snapshot: record.getSnapshot() }
}

/** `ctx.instances(storeKey)` — every live instance handle of that type. */
export function resolveInstances(storeKey: string): InstanceHandle[] {
  return instancesOfType(storeKey).map(({ id, record }) => ({
    id,
    type: record.type,
    handlers: record.getHandlers(),
    snapshot: record.getSnapshot(),
  }))
}

/** Test-only reset (mirrors no equivalent existing anywhere else in this
 *  module family — the GLOBAL action registry has no reset because actions
 *  are registered once at module load and never torn down; INSTANCES mount
 *  and unmount constantly, so a stray leaked registration between unrelated
 *  tests is a real risk a reset guards against). Never called from
 *  production code. */
export function __resetInstanceRegistryForTests(): void {
  instances.clear()
}
