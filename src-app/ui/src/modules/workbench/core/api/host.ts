// The host-injection seam (ITEM-8/9). The `WorkbenchAPI` is constructed
// PER-EXTENSION, capability-scoped, from a bundle of host services the shell
// provides. Keeping these as INTERFACES (not hard imports of ApiClient / the
// framework EventBus) is what makes the package acyclic + unit-testable: the
// CytoAnalyst host implements them against `@ziee/framework` ApiClient + P2
// `datatypeRegistry`; a test injects fakes.
//
// ITEM-7/10/11 — the `data` and `compute` PLANES are gone from this bundle. They
// were the two capability-specific interfaces core had no business owning; each now
// lives with the extension that publishes the capability over it
// (`extensions/data`, `extensions/jobs`). What remains here are HOST services:
// `events`, `storage`, `ui`, the datatype lattice and the bound project — plus the
// opaque `planes` bag through which a shell (the gallery/e2e fake) may inject a
// capability's backend BY ID. Core never inspects a plane.

import type { DatatypeLattice } from '../datatypes/lattice.ts'

export interface Disposable {
  dispose(): void
}

/** A minimal event bus (the framework EventBus, bridged). */
export interface EventBusLike {
  on(event: string, cb: (payload: unknown) => void): Disposable
  emit(event: string, payload: unknown): void
}

/** A raw key-value backend the per-extension `storage` namespaces on top of. */
export interface KeyValueBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

/** Shell UI services. */
export interface UiHost {
  notify(msg: string, level?: 'info' | 'success' | 'error'): void
  openView(id: string): void
  progress<T>(task: () => Promise<T>, label?: string): Promise<T>
}

/** The full bundle the shell injects to construct a per-extension API. */
export interface WorkbenchHost {
  /** the current project the extension is scoped to. */
  projectId: string
  events: EventBusLike
  storage: KeyValueBackend
  ui: UiHost
  /** P2's subtyping lattice (adapted) — powers availability + WhenClause. */
  datatypes: DatatypeLattice
  /**
   * OPTIONAL per-capability backends, keyed BY CAPABILITY ID and OPAQUE to core
   * (INV-6). A publishing extension reads its own slot and falls back to the real
   * backend it builds itself; the gallery/e2e fake host fills the slots with fakes.
   */
  planes?: Record<string, unknown>
}
