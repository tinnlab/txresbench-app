// The builtin PROVIDER registry (ITEM-6). `createWorkbenchApi` must be able to
// stock a fresh broker with the builtin implementations WITHOUT importing — or
// naming — any of them (INV-6). So each owning module registers a `{id, version,
// create}` declaration at module evaluation (`extensions/index.ts`), and core
// merely instantiates whatever is registered, in registration order.
//
// This is the same shape as `core/shell/builtinViews.ts`: a builtin declares
// itself through the ordinary public seam a third-party package would use.
//
// Pinned to `globalThis` (the `globalSingleton` pattern) because, exactly like the
// contribution registry, this is cross-module shared state: under Vite HMR or a
// duplicated package instance a plain module-level `const` would diverge.

import { globalSingleton } from '../internal/globalSingleton.ts'
import type { CapabilityBroker, CapabilityFactory, CapabilityProvider } from './types.ts'

const PROVIDERS = globalSingleton<CapabilityProvider<never>[]>('__txr_wb_capability_providers__', () => [])

/**
 * Declare that `id` (at `version`) is created by `create` once a host bundle
 * exists. Idempotent per id: a re-registration of the SAME id is ignored (the
 * first declaration wins), so a module re-evaluated under HMR does not stack
 * duplicates.
 */
export function registerCapabilityProvider<TCtx>(
  id: string,
  version: string,
  create: CapabilityFactory<TCtx>,
): void {
  if (PROVIDERS.some(p => p.id === id)) return
  PROVIDERS.push({ id, version, create } as unknown as CapabilityProvider<never>)
}

/** Instantiate every registered provider into `broker`, bound to `ctx`. A single
 *  failing factory is isolated so it cannot abort the rest (mirrors
 *  `discoverBuiltins`' per-builtin isolation). */
export function installRegisteredCapabilities<TCtx>(broker: CapabilityBroker, ctx: TCtx): void {
  for (const p of PROVIDERS as unknown as CapabilityProvider<TCtx>[]) {
    try {
      broker.publish(p.id, p.version, p.create(ctx))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[workbench] "${p.id}" failed to initialise; it will resolve as absent`, err)
    }
  }
}

/** Every registered id (introspection / test). */
export function registeredCapabilityIds(): string[] {
  return PROVIDERS.map(p => p.id)
}

/** Test-only reset. */
export function __resetCapabilityProvidersForTests(): void {
  PROVIDERS.length = 0
}
