// Test fakes for the external injection boundary (never mock the unit under
// test). A fake datatype lattice (a tiny fixed `extends` chain) + a fake host.

import type { DatatypeLattice } from '../datatypes/lattice.ts'
import type { TypeSelector } from '../datatypes/types.ts'
import type { WorkbenchHost } from '../api/host.ts'

/** A fixed subtyping chain. Two NEUTRAL branches carry every generic case:
 *  `projection → matrix → tabular → data` (a subtype of `matrix`) and `grouping → data`
 *  (deliberately NOT a subtype of `matrix`, so a selector can be shown to FAIL).
 *  Prefer those in new tests — a core registry test that reaches for a contributed
 *  domain id is how the app re-acquires a domain assumption. The three domain ids below
 *  are retained ONLY for the existing callers that still name them; do not add more. */
const PARENT: Record<string, string | null> = {
  data: null,
  tabular: 'data',
  matrix: 'tabular',
  projection: 'matrix',
  grouping: 'data',
  embedding: 'matrix',
  clustering: 'data',
  de: 'tabular',
}

export const fakeLattice: DatatypeLattice = {
  isA(sub, sup) {
    let cur: string | null = sub
    while (cur) {
      if (cur === sup) return true
      cur = PARENT[cur] ?? null
    }
    return false
  },
  matches(id, sel: TypeSelector) {
    if (sel.type_id != null && id !== sel.type_id) return false
    if (sel.subtypes_of != null && !this.isA(id, sel.subtypes_of)) return false
    return true
  },
  get: () => undefined,
}

export function makeFakeHost(overrides: Partial<WorkbenchHost> = {}): WorkbenchHost {
  const kv = new Map<string, string>()
  return {
    projectId: 'project-1',
    events: {
      on: () => ({ dispose() {} }),
      emit: () => {},
    },
    storage: {
      get: async k => kv.get(k) ?? null,
      set: async (k, v) => void kv.set(k, v),
      delete: async k => void kv.delete(k),
      keys: async prefix => [...kv.keys()].filter(k => k.startsWith(prefix)),
    },
    ui: {
      notify: () => {},
      openView: () => {},
      progress: task => task(),
    },
    datatypes: fakeLattice,
    ...overrides,
  }
}
