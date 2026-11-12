// The subtyping-lattice SEAM (DEC-3). workbench-api owns the availability logic
// but delegates the actual subtype/selector matching to a host-INJECTED lattice
// — in the TxResBench host that is P2's `datatypeRegistry` (`isA`/`matches`),
// adapted to this interface at wiring time. Keeping it an interface (not a hard
// import) is what makes the package acyclic + unit-testable with a fake.

import type { Datatype, TypeSelector } from './types.ts'

export interface DatatypeLattice {
  /** reflexive `extends`-walk: is `sub` the same as or a descendant of `sup`? */
  isA(sub: string, sup: string): boolean
  /** does a datatype id satisfy a `TypeSelector` (type_id / subtypes_of / capabilities)? */
  matches(datatypeId: string, selector: TypeSelector): boolean
  /** the registered datatype for an id, if known. */
  get(id: string): Datatype | undefined
}

/**
 * A permissive fallback lattice for hosts that have not injected P2's registry
 * yet (e.g. a bare unit context). `isA` is identity-only; `matches` honors an
 * exact `type_id` and treats `subtypes_of` as identity. NEVER used when the real
 * `datatypeRegistry` is wired — it exists so the package degrades gracefully, not
 * so availability silently over-reports in production.
 */
export const identityLattice: DatatypeLattice = {
  isA: (sub, sup) => sub === sup,
  matches: (id, sel) => {
    if (sel.type_id != null) return id === sel.type_id
    if (sel.subtypes_of != null) return id === sel.subtypes_of
    return true
  },
  get: () => undefined,
}
