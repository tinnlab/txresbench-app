// The generic contribution registry primitive (ITEM-3). Generalizes the FE
// `DatatypeRegistry` (id-keyed Map, `isA`/`matches`) + `ProjectExtensionRegistry`
// (HMR-safe last-wins) idioms into one reusable, package-exportable class.
//
// Gating (`when`/permission) is a RENDER-TIME concern the HOST filters — never
// inside the registry (a registry entry always exists; whether it's SHOWN is the
// shell's call). `availability` is the pure type-match half, delegating subtype
// matching to the injected P2 lattice (DEC-3).

import type { Contribution } from './types.ts'
import type { DatatypeLattice } from '../datatypes/lattice.ts'
import { computeAvailability, type AvailabilityInputs } from './availability.ts'

export class Registry<C extends Contribution> {
  private items = new Map<string, C>()
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  /** Register a contribution. Idempotent-by-id: a re-register of the same id is
   *  last-wins with a warning (HMR-safe, per `ProjectExtensionRegistry`). */
  register(contribution: C): void {
    if (this.items.has(contribution.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[workbench-api] ${this.name}: "${contribution.id}" re-registered (last wins)`)
    }
    this.items.set(contribution.id, contribution)
  }

  get(id: string): C | undefined {
    return this.items.get(id)
  }

  /** Remove a contribution (imperative unregister / dispose). No-op if absent. */
  remove(id: string): void {
    this.items.delete(id)
  }

  has(id: string): boolean {
    return this.items.has(id)
  }

  /** All contributions, stable id-sorted then by `order` (deterministic render). */
  all(): C[] {
    return [...this.items.values()].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    )
  }

  byCategory(category: string): C[] {
    return this.all().filter(c => c.category === category)
  }

  /** Test-only: clear all entries (HMR / test isolation). */
  clear(): void {
    this.items.clear()
  }

  get size(): number {
    return this.items.size
  }

  /**
   * Pure availability: is this contribution's typed input requirement satisfied by
   * the project's available datatype ids? Thin wrapper over the single
   * `computeAvailability` predicate (the SoT shared with `buildContributionCatalog`,
   * so the two never disagree). Gating (`permission`) stays the host's render-time
   * filter.
   */
  static availability(
    contribution: Contribution & AvailabilityInputs,
    availableTypeIds: string[],
    lattice: DatatypeLattice,
  ): boolean {
    return computeAvailability(contribution, { producedTypeIds: availableTypeIds }, lattice)
  }
}
