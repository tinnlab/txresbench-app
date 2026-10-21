// The per-position VALUE REFERENCE vocabulary — how a caller names one column of
// per-position values (a value column of the value axis, an annotation column of the
// position axis, a metric, or the general axis-scoped annotation) plus the stable string
// key that identifies it.
//
// ITEM-17 / C3: the ref vocabulary is DOMAIN-FREE. The variant that used to carry a
// domain noun is now `{ entry }` — it names ONE ENTRY of the ctx's `valueAxis`, which is
// exactly the word `DataCtx.entryIndex` already uses for the same thing. A processor
// package supplies the concrete entry NAMES as DATA; the workbench never names one
// itself, and no ref key or discriminant is persisted, so the rename carries no
// migration surface (see `refKey` below).
//
// PROVENANCE: this is what survived `core/dsl/predicate.ts`. That file also carried the
// index-set predicate AST + the `DslOperator` registry of a bounded query LANGUAGE; the
// language's evaluator (`dsl/eval`, `dsl/validate`, `dsl/reductions`, `dsl/inPolygon`,
// `dsl/categorical`, `dsl/vocabulary`) and its only consumers (the four dimension
// primitives) are deleted, so the AST, the operator registry, and `dslVersion` went with
// them. A REFERENCE is not a query language — hence the honest home + name.

/** A per-position value reference — an entry of the value axis, an annotation column of
 *  the position axis, a metric, or the GENERAL axis-scoped annotation ref. */
export type ValueRef =
  | { entry: string; layer?: string }
  | { col: string }
  | { metric: string }
  /** a GENERAL axis-scoped annotation ref: address a per-position annotation by its
   *  `axis` + `annotation` name (optionally in a named `layer`) — the domain-agnostic
   *  form of `entry`/`col`/`metric`. `annotation` is the distinct discriminant key. */
  | { axis: string; annotation: string; layer?: string }

/** A stable string key for a ref (memoization + column identity). The data plane
 *  dispatches on this key's prefix (`entry:` / `col:` / `annot:` / `metric:`).
 *  In-memory only — never persisted, never sent over the wire. */
export function refKey(ref: ValueRef): string {
  if ('entry' in ref) return `entry:${ref.entry}|${ref.layer ?? ''}`
  if ('col' in ref) return `col:${ref.col}`
  if ('annotation' in ref) return `annot:${ref.axis}:${ref.annotation}|${ref.layer ?? ''}`
  return `metric:${ref.metric}`
}

/** The AXIS + NAME a ref addresses, or `undefined` for a ref the caller cannot resolve
 *  to a per-position annotation (an `{entry}` value column). The axis-LESS forms
 *  (`{col}`/`{metric}`) fall back to `positionAxis` — the same rule `resolveColumn`
 *  applies — so a caller keying a cache off this can never conflate two axes' columns
 *  of the same NAME (the bug a string-prefix regex over `refKey` reintroduces every
 *  time it forgets to capture the axis group). */
export function annotationTarget(
  ref: ValueRef,
  positionAxis: string,
): { axis: string; name: string } | undefined {
  if ('col' in ref) return { axis: positionAxis, name: ref.col }
  if ('metric' in ref) return { axis: positionAxis, name: ref.metric }
  if ('annotation' in ref) return { axis: ref.axis, name: ref.annotation }
  return undefined
}
