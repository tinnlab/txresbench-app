// TEST-P8-columns — the column resolver: dispatch by ref kind, typed errors for
// unresolved refs, and the stable ref key.
//
// PROVENANCE: ported case-for-case out of `core/dsl/columns.test.ts`, minus its
// memoization case — `createColumnResolver` was read only by the deleted predicate
// evaluator and went with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveColumn, refKey, annotationTarget, isColumnError } from './index.ts'
import type { DataCtx, ResolvedColumn } from './index.ts'

function mkCol(values: number[], na?: boolean[]): ResolvedColumn {
  return { values: Float64Array.from(values), na: Uint8Array.from(values.map((_, i) => (na?.[i] ? 1 : 0))) }
}

/** A ctx over FOUR axes: the position axis (`positions`), the value axis (`values`),
 *  and two further annotated axes (`time`, `well`) that each carry a column named `t`.
 *  Those two are the discriminating case — a ctx that discards the ref's axis serves
 *  ONE column for both. */
function mkCtx(counter: { reads: number }): DataCtx {
  const byAxis: Record<string, Record<string, ResolvedColumn>> = {
    positions: { x: mkCol([1, 2, 3]), qc: mkCol([1, 2, 3]) },
    time: { t: mkCol([10, 20, 30]) },
    well: { t: mkCol([40, 50, 60]) },
  }
  return {
    n: 3,
    axisVersion: 'v1',
    positionAxis: 'positions',
    valueAxis: 'values',
    entryIndex: (axis, key) => (axis === 'values' && key === 'G' ? 0 : -1),
    readColumn: ref => {
      counter.reads++
      if ('entry' in ref) return mkCol([0, 5, 0]) // sparse-absent already 0
      return mkCol([0, 0, 0])
    },
    resolveAnnotation: (axis, name) => byAxis[axis]?.[name],
  }
}

test('TEST-P8-columns: entry / col / metric dispatch', () => {
  const ctx = mkCtx({ reads: 0 })
  assert.deepEqual([...resolveColumn({ entry: 'G' }, ctx).values], [0, 5, 0])
  assert.deepEqual([...resolveColumn({ col: 'x' }, ctx).values], [1, 2, 3])
  assert.deepEqual([...resolveColumn({ metric: 'qc' }, ctx).values], [1, 2, 3])
})

test('TEST-P8-columns: the GENERAL axis-scoped annotation ref resolves on the axis it NAMES', () => {
  const ctx = mkCtx({ reads: 0 })
  assert.deepEqual([...resolveColumn({ axis: 'positions', annotation: 'x' }, ctx).values], [1, 2, 3])
})

// B1 (DOMAIN_AUDIT §2) REGRESSION GUARD. The resolver used to route EVERY
// `{axis, annotation}` ref through ONE implicit position-axis seam, taking only
// `ref.annotation` — so the ref's `axis` was DISCARDED and two refs naming the same
// column on DIFFERENT axes were the same column. That is not a naming nit: a
// `(comparison, variable)` contrast table and a `(region, channel)` image both carry
// same-named annotations on more than one axis, and this silently served the wrong one.
test('TEST-P8-columns [B1]: two axes carrying the SAME column name resolve to DIFFERENT columns', () => {
  const ctx = mkCtx({ reads: 0 })
  const time = resolveColumn({ axis: 'time', annotation: 't' }, ctx)
  const well = resolveColumn({ axis: 'well', annotation: 't' }, ctx)
  assert.deepEqual([...time.values], [10, 20, 30], 'the `time` axis column')
  assert.deepEqual([...well.values], [40, 50, 60], 'the `well` axis column')
  assert.notDeepEqual([...time.values], [...well.values], 'the axis is load-bearing')
})

test('TEST-P8-columns [B1]: an annotation absent on the named axis is UnknownColumn, even when a sibling axis has it', () => {
  const ctx = mkCtx({ reads: 0 })
  // `x` exists on `positions` only. Asking for it on `time` must NOT silently fall
  // through to the position axis.
  assert.throws(
    () => resolveColumn({ axis: 'time', annotation: 'x' }, ctx),
    e => isColumnError(e) && e.kind === 'UnknownColumn',
  )
})

test('TEST-P8-columns: unknown refs throw the matching typed error', () => {
  const ctx = mkCtx({ reads: 0 })
  assert.throws(
    () => resolveColumn({ entry: 'NOPE' }, ctx),
    e => isColumnError(e) && e.kind === 'UnknownEntry',
  )
  assert.throws(
    () => resolveColumn({ col: 'nope' }, ctx),
    e => isColumnError(e) && e.kind === 'UnknownColumn',
  )
  assert.throws(
    () => resolveColumn({ metric: 'nope' }, ctx),
    e => isColumnError(e) && e.kind === 'UnknownColumn',
  )
})

test('TEST-P8-columns: refKey is stable per ref shape', () => {
  assert.equal(refKey({ entry: 'G', layer: 'lognorm' }), 'entry:G|lognorm')
  assert.equal(refKey({ entry: 'G' }), 'entry:G|')
  assert.equal(refKey({ col: 'x' }), 'col:x')
  assert.equal(refKey({ metric: 'qc' }), 'metric:qc')
  assert.equal(refKey({ axis: 'positions', annotation: 'area' }), 'annot:positions:area|')
})

test('TEST-P8-columns [B1]: annotationTarget carries the axis, so a cache key cannot conflate two axes', () => {
  assert.deepEqual(annotationTarget({ axis: 'time', annotation: 't' }, 'positions'), {
    axis: 'time',
    name: 't',
  })
  assert.deepEqual(annotationTarget({ axis: 'well', annotation: 't' }, 'positions'), {
    axis: 'well',
    name: 't',
  })
  // the axis-LESS forms fall back to the position axis — the same rule `resolveColumn` uses.
  assert.deepEqual(annotationTarget({ col: 'x' }, 'positions'), { axis: 'positions', name: 'x' })
  assert.deepEqual(annotationTarget({ metric: 'qc' }, 'positions'), { axis: 'positions', name: 'qc' })
  // a value-column ref names no annotation.
  assert.equal(annotationTarget({ entry: 'G' }, 'positions'), undefined)
})
