// scope.caps derivation (declarative-processor-ui Slice 3 / ITEM-10, DEC-12). The
// `has:<capability>` `when` predicate (`expr.ts::hasCapability`) reads the resolved
// dataset's capability SET off `scope.caps`. This module derives that set GENERALLY
// from the workbench's resolved dataset catalog — the union, over every produced
// datatype, of {the datatype id, all its `extends`-ancestors, and each datatype's
// declared `capabilities[]}` — so a widget gated `has:fragments` / `has:embedding` /
// `has:spatial` / `has:single-cell/expression` evaluates against REAL data, not a
// hardcoded per-analysis vocabulary (INV-6: no analysis-specific names here).
//
// Pure / framework-free (no React) so the derivation is directly unit-testable.

import type { DatatypeLattice } from '@/modules/workbench/core'

/**
 * Derive the capability set for a set of produced datatype ids. For each id it walks the
 * `extends` chain (reflexive), adding every ancestor datatype id AND each datatype's
 * declared `capabilities`. So a produced `embedding` (which `extends matrix … data`) yields
 * `{embedding, matrix, tabular, data}` + whatever caps those datatypes declare — making
 * `has:embedding` true for a project that produced an embedding, `has:fragments` true iff a
 * fragments datatype/capability is actually present, and so on. Cycle-guarded (a malformed
 * self-referential `extends` can't loop). An absent lattice entry contributes only the raw id.
 */
export function deriveCaps(typeIds: readonly string[], lattice: DatatypeLattice): Set<string> {
  const caps = new Set<string>()
  for (const start of typeIds ?? []) {
    if (!start) continue
    let id: string | null = start
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      caps.add(id)
      let dt
      try {
        dt = lattice.get(id)
      } catch {
        dt = undefined
      }
      if (dt) for (const c of dt.capabilities ?? []) if (c) caps.add(c)
      id = dt?.extends ?? null
    }
  }
  return caps
}
