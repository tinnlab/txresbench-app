// Re-run params-reseed extraction (ITEM-63) — the iteration loop's core. From ANY
// completed run's provenance node (`Provenance.run` → `RunNodeDto`), extract the
// producing analysis id + the exact params it ran with, so a "Re-run with tweaked
// params" affordance opens a run pane PRE-SEEDED with that config (the user
// adjusts one threshold + re-runs cheaply). Pure — the `RerunPane` renders from this;
// the unit test drives it directly. The params source is `RunNodeDto.params` (opaque
// `unknown`, coerced defensively to a record) — the same node the lineage view reads.

import type { RunNodeDto } from '@/api-client/types'

export interface RerunSeed {
  /** The producing analysis id (`generator_id`) — the analysis the re-run re-launches. */
  analysisId: string
  /** The exact params the source run used — pre-seeded into the re-run form. */
  params: Record<string, unknown>
}

/** Coerce an opaque `RunNodeDto.params` into a params record. A non-object (null /
 *  array / scalar — a malformed or empty node) yields `{}`, so the re-run falls back
 *  to the analysis defaults rather than crashing on a bad shape. */
export function coerceRunParams(params: unknown): Record<string, unknown> {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    return { ...(params as Record<string, unknown>) }
  }
  return {}
}

/** Extract the re-run seed (analysis id + params) from a completed run's provenance
 *  node. The `analysisId` is the run's `generator_id`; the params are its recorded
 *  `params` (coerced). */
export function reseedFromRun(run: RunNodeDto): RerunSeed {
  return { analysisId: run.generator_id, params: coerceRunParams(run.params) }
}
