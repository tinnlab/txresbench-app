// columnCoerce — the ONE place a columnar value is tested for being a column and coerced to
// numbers/strings (ITEM-25).
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
//
// Three copies of `asNums`/`asStrs` had drifted apart across the tree
// (`core/runtime/store.ts`, `extensions/canvas/canvasBinding.ts`, `extensions/canvas/viz.tsx`).
// The plan called them "verbatim copies". They were NOT:
//
//   store.ts        `typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN`
//   canvasBinding   `v.map(x => Number(x))`
//   viz.tsx         `v.map(x => Number(x))`
//
// `Number(null)`, `Number('')` and `Number(false)` are all **0**. So the same missing entry is a
// dropped non-finite on the derived-primitive path and a legitimate ZERO on the canvas path —
// a silent semantic fork in what looks like duplicated code. `store.ts`'s own comment documents
// the intent ("rather than silently skewing them to 0"); the canvas copies never got it.
//
// Collapsing them to one implementation would therefore CHANGE RESULTS on whichever side lost —
// a colour scale's domain, or a fabricated x/y coordinate, moving because a helper was tidied.
// So both semantics survive here as SEPARATE, NAMED exports, and every call site now states which
// one it means. That makes the fork visible instead of hidden, and lets any future convergence be
// a deliberate, tested change rather than a refactor side effect.
//
// ── ON TYPED ARRAYS ───────────────────────────────────────────────────────────────────────
//
// `isColumn` accepts a TypedArray as well as an Array, because `Array.isArray(new Float32Array())`
// is **false** and the typed migration (slices C1/D) converts column guards one at a time. Every
// such guard in the tree fails OPEN — it skips the column rather than throwing — so a half-done
// migration degrades to a blank plot with a clean console. Routing the guards through one
// predicate is what makes that migration auditable.

/** A columnar value: a boxed array today, a TypedArray after the C1/D migration. */
export type ColumnLike = readonly unknown[] | ArrayLike<number>

/**
 * Is `v` a column? Accepts a plain Array OR a TypedArray.
 *
 * This is the successor to the bare `Array.isArray(v)` guards. It exists because those guards are
 * the mechanism by which a typed column silently DISAPPEARS: every one of them skips rather than
 * throws, so a `Float32Array` reaching an unconverted guard yields zero points, an unchanged
 * revision, or a keep-everything mask — all with a clean console.
 */
export function isColumn(v: unknown): v is ColumnLike {
  return Array.isArray(v) || ArrayBuffer.isView(v)
}

/** `[]` for a non-column, else the value itself. The shared shape of every coercion below. */
function asColumn(v: unknown): ArrayLike<unknown> {
  return isColumn(v) ? (v as ArrayLike<unknown>) : []
}

/** Iterate an `ArrayLike` without assuming `Array.prototype` (a TypedArray has no `.map` to `unknown[]`).
 *  EXPORTED (incremental-landing ITEM-4): a converted guard's BODY must produce a real `boolean[]`/
 *  `number[]`, never `Float32Array.prototype.map`'s Float32Array — this is the one primitive that
 *  guarantees the array form over either backing. */
export function mapLike<T>(v: ArrayLike<unknown>, f: (x: unknown) => T): T[] {
  const out = new Array<T>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = f(v[i])
  return out
}

/**
 * Coerce to numbers, mapping a MISSING entry (`null` / `undefined` / `''` / a non-numeric value)
 * to **`NaN`**.
 *
 * This is the careful semantics, and the one to prefer for anything feeding a statistic: the
 * downstream primitives (`extent`, `keep_range`) skip non-finite values, so a blank entry is
 * DROPPED rather than counted as a real zero. Use it wherever a missing value must not be allowed
 * to move a domain, a threshold, or a filter boundary.
 *
 * (Was `core/runtime/store.ts`'s `asNums`.)
 */
export function asNumsNaNMissing(v: unknown): number[] {
  return mapLike(asColumn(v), x =>
    typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN,
  )
}

/**
 * Coerce to numbers with raw `Number(x)`, so a MISSING entry becomes **`0`**.
 *
 * This is the LOOSE semantics the two canvas copies had. It is preserved verbatim and named
 * loudly rather than quietly converged, because the canvas consumes it where a `NaN` would be a
 * regression rather than a fix: the fabricated-positions path writes `x[i] ?? 0` into a
 * `Float32Array`, and a `NaN` coordinate is not a dropped point — it is an unrenderable one.
 * Changing a call site from this to {@link asNumsNaNMissing} is a behaviour change and needs its
 * own test, not a refactor.
 *
 * (Was `extensions/canvas/canvasBinding.ts`'s and `extensions/canvas/viz.tsx`'s `asNums`.)
 */
export function asNumsZeroMissing(v: unknown): number[] {
  return mapLike(asColumn(v), x => Number(x))
}

/** Coerce to strings. Identical in all three former copies, so there is only one. */
export function asStrs(v: unknown): string[] {
  return mapLike(asColumn(v), x => String(x))
}
