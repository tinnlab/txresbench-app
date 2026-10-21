// Before/after run diff (ITEM-63) — the second half of the iteration loop. After a
// re-run, the user wants "what changed vs the previous run": key observables
// side-by-side (output count, per-kind output count, each shape dimension) with the delta
// highlighted.
//
// HONESTY: the observables are what's cheaply + truthfully extractable from the run's
// OUTPUT ARTIFACT RECORDS themselves — the shape dimensions + the per-kind output count.
// We do NOT read the artifact blobs (cluster labels, a top-DE table would need a data
// read); those richer observables are shown by the per-module artifact panels, not
// fabricated here. Same discipline as `StatCard` ("an HONEST headline from the artifact
// record itself").
//
// E3 (DOMAIN_AUDIT): the dimensions used to be LABELLED `cells` (shape[0]) and `features`
// (shape[1]) — rendered verbatim to the user by `RunDiffView` / `MultiRunCompareView` — so
// every artifact of every processor was described as a cells x features matrix. The
// dimension list carries no axis NAMES, so the label now says exactly what is known: the
// dimension's position. That also fixed a second, quieter defect — only the first TWO dims
// were ever reported, so a 3-D artifact's remaining extents were silently dropped.
//
// ITEM-7: the dimensions come from the producer's DECLARED `structure` (via the core
// reader's `declaredDims`), not from the dropped `shape` column. `covered_axes` — the
// other column named in the paragraph above, and the reason those labels are positional —
// is dropped too; the axis names an artifact does carry now live in its own declaration
// (`structure.axis` / `structure.axes`), which is a richer source this function
// deliberately does not reach for: naming the dims here would change what these rows MEAN,
// which is a display decision, not a migration.
//
// Pure — `RunDiffView` renders from these; the unit test drives them directly.

import type { Artifact } from '@/api-client/types'
import { declaredDimsForDisplay } from '@/core/workstore'

/** A run's cheaply-extractable numeric observables, keyed by a human-readable metric
 *  label (also the row key). Values come only from the artifact record (shape / kind /
 *  count) — never a blob read. */
export type Observables = Record<string, number>

/** One run in a compare set: its id + a short label + the params it ran with + its
 *  extracted observables (shared by `RunDiffView` and the N-run compare). */
export interface RunObservablesEntry {
  runId: string
  label: string
  params: Record<string, unknown>
  observables: Observables
}

/**
 * An artifact's DECLARED dimensions, in axis order (ITEM-7 — the successor to
 * `shapeDims`, which read the dropped `shape` column).
 *
 * A diff is a table over MANY artifacts of two runs, so one unreadable declaration must
 * not take the whole comparison down: `declaredDimsForDisplay` yields `[]`, which reads
 * as "that kind reported no dims" rather than as an invented `0`. The strict throw stays
 * where it belongs — on the READ path, where a caller is about to decode bytes.
 */
export function artifactDims(a: { id: string; structure: unknown }): number[] {
  return declaredDimsForDisplay(a.id, a.structure)
}

/** Extract a run's observables from its produced artifacts. `outputs` is the total count;
 *  each produced datatype contributes its count and (from the FIRST artifact of that kind,
 *  in stable order) EVERY declared dimension, keyed by position (`dim0`, `dim1`,
 *  …). Groups preserve first-seen order for a stable row layout. */
export function runObservables(artifacts: Artifact[]): Observables {
  const obs: Observables = { outputs: artifacts.length }
  const order: string[] = []
  const byKind = new Map<string, Artifact[]>()
  for (const a of artifacts) {
    if (!byKind.has(a.datatype)) {
      byKind.set(a.datatype, [])
      order.push(a.datatype)
    }
    byKind.get(a.datatype)!.push(a)
  }
  for (const kind of order) {
    const items = byKind.get(kind)!
    obs[`${kind} · outputs`] = items.length
    const dims = artifactDims(items[0])
    dims.forEach((n, i) => {
      obs[`${kind} · dim${i}`] = n
    })
  }
  return obs
}

export interface DiffRow {
  /** The observable/metric label. */
  key: string
  /** Value in the BEFORE run, or null when absent from it. */
  before: number | null
  /** Value in the AFTER run, or null when absent from it. */
  after: number | null
  status: 'added' | 'removed' | 'changed' | 'same'
  /** `after − before` when both are present; null otherwise. */
  delta: number | null
}

export interface RunDiff {
  /** Every observable across both runs (sorted by key), each classified. */
  rows: DiffRow[]
  added: string[]
  removed: string[]
  changed: string[]
  /** True when the two runs produced byte-identical observables (no add/remove/change)
   *  — the "same output" signal (a re-run whose tweak had no observable effect). */
  identical: boolean
}

/** Diff two runs' observables into per-metric rows + the added/removed/changed key sets
 *  + an identical-output flag. A key present in only one run is added/removed; a key in
 *  both with a differing value is changed. */
export function buildRunDiff(before: Observables, after: Observables): RunDiff {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows: DiffRow[] = []
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const key of keys) {
    const b = key in before ? before[key] : null
    const a = key in after ? after[key] : null
    let status: DiffRow['status']
    if (b === null) {
      status = 'added'
      added.push(key)
    } else if (a === null) {
      status = 'removed'
      removed.push(key)
    } else if (a !== b) {
      status = 'changed'
      changed.push(key)
    } else {
      status = 'same'
    }
    rows.push({ key, before: b, after: a, status, delta: b !== null && a !== null ? a - b : null })
  }
  return { rows, added, removed, changed, identical: added.length === 0 && removed.length === 0 && changed.length === 0 }
}
