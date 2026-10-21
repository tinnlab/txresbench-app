// Boot-time population of the FE datatype registry from `GET /api/datatypes`
// (ITEM-21). The backend is the SINGLE SOURCE OF TRUTH — no hand-maintained TS
// lattice; the bootstrap skeleton (`builtin.ts`) only fills the brief pre-load
// window and is replaced wholesale here. There is no async-populate-from-API
// precedent in `core/`, so this introduces the seam; the trigger lives in
// `modules/datatypes/module.tsx` (a `routerEffects` effect, post-auth).

import { ApiClient } from '@/api-client'
import { BOOTSTRAP_LATTICE } from './builtin'
import { datatypeRegistry } from './registry'
import type { Datatype } from './types'

/** Seed the bootstrap skeleton if the registry is still empty (idempotent). */
export function seedBootstrap(): void {
  if (datatypeRegistry.size === 0) {
    datatypeRegistry.replaceAll(BOOTSTRAP_LATTICE)
  }
}

let loaded = false
// Bumped on every reset (logout) so an in-flight populate that resolves AFTER the
// reset is discarded instead of restoring the prior account's lattice.
let epoch = 0

/**
 * Populate the registry from the backend. Seeds the bootstrap first so consumers
 * never see an empty registry, then replaces it with the authoritative set. On any
 * failure (e.g. a user lacking `projects::use` gets 403), the bootstrap stays — the
 * type SHAPES are non-sensitive, so the fallback is safe.
 */
export async function populateDatatypeRegistry(force = false): Promise<void> {
  if (loaded && !force) return
  seedBootstrap()
  const started = epoch
  try {
    const types = (await ApiClient.Datatype.list()) as unknown as Datatype[]
    // A logout/reset happened while this fetch was in flight → discard the result so
    // it can't restore the prior account's authoritative lattice (epoch guard).
    if (started !== epoch) return
    if (Array.isArray(types) && types.length > 0) {
      datatypeRegistry.replaceAll(types)
      loaded = true
    }
  } catch {
    // Keep the bootstrap lattice.
  }
}

/**
 * Reset to the non-sensitive bootstrap skeleton and clear the populate latch — called
 * on logout so an in-session account switch (privileged → restricted, no reload) does
 * NOT retain the previous account's authoritative lattice (viewers/capabilities). The
 * next login re-populates from that account's `/api/datatypes`. Bumping the epoch
 * invalidates any populate still in flight.
 */
export function resetDatatypeRegistry(): void {
  epoch += 1
  loaded = false
  datatypeRegistry.replaceAll(BOOTSTRAP_LATTICE)
}
