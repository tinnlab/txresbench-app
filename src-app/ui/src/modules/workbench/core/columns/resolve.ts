// The column RESOLVER. Given a `ValueRef` and a `DataCtx` (the injected raw-data
// seam), it returns the DENSE `{ values: f64[N], na: bool[N] }` a caller computes over:
// a sparse value column materializes to dense with absent = 0.0; `na[i]=1` marks a position
// OUTSIDE the covered axis for that ref. A ref that doesn't resolve raises the matching
// typed error.
//
// PROVENANCE: `core/dsl/columns.ts`, minus the pieces only the deleted predicate
// evaluator used — `createColumnResolver` (the per-(refKey, axisVersion) memo the
// recursive evaluator needed so `gt(g, median(g))` read `g` once) and the two
// categorical/layout ctx accessors (read only by the deleted categorical leaf + the
// `inPolygon`/`inBox` geometry hit-tests). The one surviving caller
// (`core/form/defaults.ts`, data-driven param defaults) resolves each ref once.

import type { ValueRef } from './ref.ts'
import { ColumnErrors } from './errors.ts'

/** A dense resolved column. `values` is f64; `na[i]=1` ⇔ position `i` is uncovered
 *  (a NaN/Inf value counts as NA but is kept in `values`). */
export interface ResolvedColumn {
  values: Float64Array
  na: Uint8Array
}

/** The raw-data seam the resolver dispatches to (injected by the host; a fixture
 *  ctx in tests). Granular accessors keep the typed errors precise: a missing entry
 *  is `UnknownEntry`, a missing annotation `UnknownColumn`.
 *
 *  Every accessor is AXIS-SCOPED. A ctx used to hardcode exactly two named axes (one
 *  entry index + one annotation accessor, each named for a domain axis), so an
 *  annotation could only ever be addressed on ONE implicit axis — which made
 *  `{axis:'time',annotation:'t'}` and `{axis:'well',annotation:'t'}` the SAME column.
 *  The axis is now a parameter, so a ctx over `(comparison, variable)` or
 *  `(region, channel)` addresses each of its axes distinctly. The two axes a ctx names —
 *  `positionAxis` and `valueAxis` — exist only to give the axis-LESS legacy ref forms
 *  (`{col}`/`{metric}`/`{entry}`) a home. */
export interface DataCtx {
  /** the position-universe cardinality `N` (the length of `positionAxis`). */
  readonly n: number
  /** an opaque version token — bumped when the underlying axes change. */
  readonly axisVersion: string | number
  /** the axis whose entries are the POSITIONS (`n`) — the axis the axis-less
   *  `{col}` / `{metric}` refs annotate. */
  readonly positionAxis: string
  /** the axis an axis-less `{entry}` ref indexes into (its entries are the value
   *  columns). */
  readonly valueAxis: string
  /** dense index of an entry KEY on `axis`, or -1 if absent. */
  entryIndex(axis: string, key: string): number
  /** the dense values for a value ref (sparse-absent already densified to 0). */
  readColumn(ref: ValueRef): ResolvedColumn
  /** an annotation column of `axis` by name, or undefined if absent. */
  resolveAnnotation(axis: string, name: string): ResolvedColumn | undefined
}

/** Resolve a single ref (dispatch + typed-error validation). */
export function resolveColumn(ref: ValueRef, ctx: DataCtx): ResolvedColumn {
  if ('entry' in ref) {
    if (ctx.entryIndex(ctx.valueAxis, ref.entry) < 0) {
      throw ColumnErrors.unknownEntry(ref.entry)
    }
    return ctx.readColumn(ref)
  }
  if ('col' in ref) {
    const c = ctx.resolveAnnotation(ctx.positionAxis, ref.col)
    if (!c) throw ColumnErrors.unknownColumn(ref.col)
    return c
  }
  // the GENERAL axis-scoped annotation ref resolves on the axis IT NAMES. The axis is
  // load-bearing, not decoration: discarding it (as this used to, by routing every
  // annotation ref through the one implicit position-axis seam) collapsed
  // `{axis:'time',annotation:'t'}` and `{axis:'well',annotation:'t'}` into one column.
  if ('annotation' in ref) {
    const c = ctx.resolveAnnotation(ref.axis, ref.annotation)
    if (!c) throw ColumnErrors.unknownColumn(ref.annotation)
    return c
  }
  // a metric is an axis-less annotation of the position axis.
  const c = ctx.resolveAnnotation(ctx.positionAxis, ref.metric)
  if (!c) throw ColumnErrors.unknownColumn(ref.metric)
  return c
}
