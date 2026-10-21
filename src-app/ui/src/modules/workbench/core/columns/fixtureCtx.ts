// The fixture `DataCtx` builder (test support). A `FixtureColumns` is a small,
// SELF-DESCRIBING JSON — plain arrays of numbers + per-column `na` bool arrays —
// so a fixture reads identically from TS and from a non-TS corpus reader.
// `makeFixtureCtx` turns one into the `DataCtx` a resolver consumes.
//
// PROVENANCE: `core/dsl/fixtureCtx.ts`, minus the two categorical/layout fixture
// channels — the ctx accessors that read them are deleted with the
// predicate evaluator, so a fixture could declare them but nothing could read them.

import type { ValueRef } from './ref.ts'
import type { DataCtx, ResolvedColumn } from './resolve.ts'

/** a dense numeric column with an optional per-position NA flag (default all covered). */
export interface FixtureColumn {
  values: number[]
  na?: boolean[]
}

/** the full fixture — plain arrays + bool NA.
 *
 *  `positionAnnotations` is the fixture's shorthand for "annotations of the POSITION
 *  axis"; a fixture that needs more than one annotated axis declares them under
 *  `byAxis`, keyed by axis name. `positionAxis`/`valueAxis` name which axis the
 *  axis-less ref forms (`{col}`/`{metric}` and `{entry}`) resolve on. */
export interface FixtureColumns {
  n: number
  /** the value columns of `valueAxis`, keyed by ENTRY name. */
  entries?: Record<string, FixtureColumn>
  positionAnnotations?: Record<string, FixtureColumn>
  /** per-axis annotation columns — `{ [axisName]: { [columnName]: column } }`. */
  byAxis?: Record<string, Record<string, FixtureColumn>>
  positionAxis?: string
  valueAxis?: string
}

function densify(col: FixtureColumn, n: number): ResolvedColumn {
  const values = new Float64Array(n)
  const na = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    values[i] = col.values[i] ?? 0
    na[i] = col.na && col.na[i] ? 1 : 0
  }
  return { values, na }
}

/** Build a `DataCtx` over a `FixtureColumns`. Value columns resolve through
 *  `readColumn` (validated by `entryIndex`); annotations through `resolveAnnotation`,
 *  AXIS-SCOPED — so a fixture declaring the same column NAME on two axes yields two
 *  distinct columns, exactly as a real multi-axis catalog does. */
export function makeFixtureCtx(fx: FixtureColumns, axisVersion: string | number = 'fx'): DataCtx {
  const entryNames = Object.keys(fx.entries ?? {})
  const positionAxis = fx.positionAxis ?? 'positions'
  const valueAxis = fx.valueAxis ?? 'values'
  const annotationsOf = (axis: string): Record<string, FixtureColumn> | undefined =>
    axis === positionAxis
      ? { ...(fx.positionAnnotations ?? {}), ...(fx.byAxis?.[axis] ?? {}) }
      : fx.byAxis?.[axis]
  return {
    n: fx.n,
    axisVersion,
    positionAxis,
    valueAxis,
    entryIndex: (axis: string, key: string) => (axis === valueAxis ? entryNames.indexOf(key) : -1),
    readColumn: (ref: ValueRef): ResolvedColumn => {
      if ('entry' in ref) {
        const c = fx.entries?.[ref.entry]
        if (c) return densify(c, fx.n)
      }
      const target =
        'col' in ref
          ? { axis: positionAxis, name: ref.col }
          : 'metric' in ref
            ? { axis: positionAxis, name: ref.metric }
            : 'annotation' in ref
              ? { axis: ref.axis, name: ref.annotation }
              : undefined
      const c = target ? annotationsOf(target.axis)?.[target.name] : undefined
      // NA-everywhere fallback keeps `readColumn` total; the resolver's typed-error
      // path is driven by `entryIndex`/`resolveAnnotation`, not here.
      return c ? densify(c, fx.n) : { values: new Float64Array(fx.n), na: new Uint8Array(fx.n).fill(1) }
    },
    resolveAnnotation: (axis: string, name: string): ResolvedColumn | undefined => {
      const c = annotationsOf(axis)?.[name]
      return c ? densify(c, fx.n) : undefined
    },
  }
}
