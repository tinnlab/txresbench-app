import { navigateViaBridge } from './navigateBridge'
import { resolveInstance, resolveInstances, type InstanceHandle } from './instanceRegistry'

// The `ctx` surface given to a `defineAction` `run(params, ctx)` handler.
//
// ARCHITECTURE.md Layer 1/3/7 describes the FULL `ctx`; slice 1 shipped the
// GLOBAL-action subset (navigate, progress/log streaming, a cancel signal).
// Slice 3 (PLAN.md ITEM-4) adds the INSTANCE-addressing subset —
// `ctx.instance`/`ctx.instances`/`ctx.stores` — backed by the runtime
// instance registry a live component joins via `./useAction.ts`
// (`./instanceRegistry.ts`). A `kind: 'instance'` action's `run` resolves its
// live target through these; a `kind: 'global'` action never needs them
// (they simply return nothing for a `storeKey`/`id` no instance registered
// under). Extend this interface (never reshape it) when a later slice adds
// `ctx.waitFor`/`ctx.fail`.

export interface ActionContext {
  /** Navigate the app to `path` (via the router bridge, DEC-9). */
  navigate: (path: string) => void
  /** Stream a progress note to the LLM mid-run (non-atomic actions — see
   *  ARCHITECTURE.md Layer 3/7). The agent engine wires this to
   *  `POST /api/mcp/agent/progress` + bumps the per-request liveness
   *  timestamp; outside the engine (no invocation in flight) it's a no-op. */
  progress: (message: string, data?: unknown) => void
  /** Local + engine-collected logging, distinct from `progress` (which is
   *  streamed to the LLM mid-run). Always logs to the console; the engine
   *  additionally collects each call into the final `result.logs[]`
   *  (CONTRACT.md's `result: {..., logs:["..."]}`). Never throws. */
  log: (...args: unknown[]) => void
  /** Cancellation signal (set by the engine when a `agent_cancel` frame
   *  arrives for this request — ARCHITECTURE.md Layer 3). Undefined outside
   *  the engine (e.g. the default context / a human-invoked action). */
  signal?: AbortSignal
  /** Resolve ONE live instance of `storeKey` by `id` (a `view_id`) —
   *  `undefined` if unmounted or registered under a different `storeKey`.
   *  ARCHITECTURE.md Layer 4: "an action reaches the target with
   *  `ctx.instance(Store, view_id)`". */
  instance: (storeKey: string, id: string) => InstanceHandle | undefined
  /** Every currently-live instance of `storeKey` — the world-model reads'
   *  (`./builtin/worldModel.ts`) primitive. */
  instances: (storeKey: string) => InstanceHandle[]
  /** Alias object form of `instance`/`instances` (PLAN.md ITEM-4: "ctx.stores
   *  (access registered instance stores)"). Same functions, grouped under a
   *  `ctx.stores.*` namespace for callers that prefer that shape. */
  stores: {
    instance: (storeKey: string, id: string) => InstanceHandle | undefined
    instances: (storeKey: string) => InstanceHandle[]
  }
}

export interface CreateActionContextOptions {
  /** Engine-supplied progress sink (posts to the backend + bumps
   *  liveness). Omit for a no-op progress (default context). */
  onProgress?: (message: string, data?: unknown) => void
  /** Engine-supplied log collector (appended to the per-request execution
   *  record, flushed into the final `result.logs[]`). Omit to log to the
   *  console only (default context). */
  onLog?: (line: string) => void
  signal?: AbortSignal
}

/**
 * Build an `ActionContext`. The agent engine (`./engine.ts`) supplies
 * `onProgress`/`onLog`/`signal` per in-flight request; `runAction` falls back
 * to this with no options (no-op progress/log sinks, no signal) when a caller
 * (e.g. a future human-invoked action) doesn't need engine wiring.
 */
export function createActionContext(
  options: CreateActionContextOptions = {},
): ActionContext {
  return {
    navigate: path => navigateViaBridge(path),
    progress: (message, data) => {
      options.onProgress?.(message, data)
    },
    log: (...args) => {
      const line = args
        .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')
      console.log('[actions]', ...args)
      options.onLog?.(line)
    },
    signal: options.signal,
    instance: resolveInstance,
    instances: resolveInstances,
    stores: {
      instance: resolveInstance,
      instances: resolveInstances,
    },
  }
}
