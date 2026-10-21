import {
  categoricalMatches,
  criterionColumn,
  isCategoricalCriterion as isCategoricalCriterionShared,
  parseBound,
  parseValue,
  pyStr,
} from '@/modules/workbench/core'
import {
  declarationsOf,
  isDeclaredCategorical,
  type ColumnDeclaration,
  type DeclaredFrame,
} from './columnDeclarations'
import { isColumn, mapLike } from '@/modules/workbench/core/columns/columnCoerce'
import { assertIndexParallel, FrameDepthMismatchError } from './frameDepth'

// `parseValue` is RE-EXPORTED, not defined here (C1/C2 — DOMAIN_AUDIT). It is a rule of the
// criteria COERCION SPEC (`core/criteria`), not a compute primitive, and having half the
// spec in this file was how "the app-owned compute-primitive library" came to hold one
// processor's coercion table. Re-exported because it was importable from here.
export { parseValue }

// The app-owned compute-primitive library (PLAN.md ITEM-6). The BOUNDED set a
// declarative `derived` field composes for live client-side filtering (research
// §11 finding #2). A new primitive is an app change (gated), NEVER shipped by a
// processor. Pure functions — no state, no React — so they're the reactive
// `derived` recompute kernel AND directly unit-testable.
//
// C1/C2 (DOMAIN_AUDIT): the CRITERIA COERCION rules that used to live here (`VALUE_WS`,
// `parseValue`) moved to `core/criteria`, which is the single normative home for that spec
// and its four conforming readers. What is left here is kernels: masks, extents, counts,
// column classification. The kernels below still SERVE the criteria encoding — that is
// what a general filter primitive is for — but they no longer DEFINE any of its rules.

/** d3.extent-style min/max over the finite numbers of `xs`. Empty / all-NaN →
 *  `[undefined, undefined]` (the caller decides the fallback). */
export function extent(xs: number[]): [number, number] | [undefined, undefined] {
  let min: number | undefined
  let max: number | undefined
  for (const x of xs) {
    if (typeof x !== 'number' || Number.isNaN(x)) continue
    if (min === undefined || x < min) min = x
    if (max === undefined || x > max) max = x
  }
  if (min === undefined || max === undefined) return [undefined, undefined]
  return [min, max]
}

/** Distinct values of `xs`, in first-seen order. */
export function unique<T>(xs: T[]): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

export interface FilterMaskInput {
  /** the per-ROW metric value. */
  values: number[]
  /** the per-ROW group key, parallel to `values`. */
  group_of: string[]
  /** inclusive `[min, max]` keep-range per group. A group with no range keeps
   *  every row. */
  ranges: Record<string, [number, number]>
}

/**
 * Per-group inclusive range filter. Returns a HIDDEN mask parallel to `values`:
 * a row is hidden (`true`) iff its value is `< min` or `> max` for ITS group's
 * range. A missing group range, or a non-finite value, keeps the row.
 */
export function filter_mask(input: FilterMaskInput): boolean[] {
  const { values, group_of, ranges } = input
  // INV-10 (ITEM-4): `values` and `group_of` are ONE frame's two index-parallel columns. Under
  // incremental landing they can arrive at different depths; combining them then mis-aligns every
  // row past the shorter one. Refuse rather than compute over a mixed-depth frame.
  assertIndexParallel('filter_mask', [values, group_of])
  return values.map((v, i) => {
    // Own-property + array guard: a data-derived group named `__proto__` must NOT
    // resolve to `Object.prototype` (a bare-object index would, keeping every cell).
    const g = group_of[i]
    const range = Object.prototype.hasOwnProperty.call(ranges, g) ? ranges[g] : undefined
    if (!Array.isArray(range)) return false
    const [min, max] = range
    if (typeof v !== 'number' || Number.isNaN(v)) return false
    return v < min || v > max
  })
}

/**
 * Element-wise OR across N parallel masks (the merged-hidden-points reduce). An empty input → `[]`.
 *
 * INV-10 (ITEM-4): the masks are the per-metric hidden masks of ONE frame, so they are
 * index-parallel by construction and must all be the SAME length. The old code padded to the MAX
 * length — which, once the frame's columns can land to different depths, sizes the result to the
 * DEEPEST metric and mis-aligns every shorter one. That is the silent full-length-wrong result the
 * invariant forbids, so differing lengths are now REFUSED, not padded. (Equal lengths — every case
 * a wholesale or an accumulated index-parallel landing produces — compute exactly as before.)
 */
export function or_masks(masks: boolean[][]): boolean[] {
  if (masks.length === 0) return []
  assertIndexParallel('or_masks', masks)
  // The common NON-EMPTY length (an absent/empty mask contributes 0; `assertIndexParallel` has
  // already refused two non-empty masks of DIFFERENT length, so the max IS that common length).
  let n = 0
  for (const mask of masks) if (mask.length > n) n = mask.length
  const out = new Array<boolean>(n).fill(false)
  for (const mask of masks) {
    for (let i = 0; i < n; i++) {
      if (mask[i]) out[i] = true
    }
  }
  return out
}

/**
 * The metric-level value-range ENVELOPE across a criterion's per-GROUP ranges — the
 * single `[lo, hi]` the dense scatter renders as a value-range `filter` (DEC-1: the
 * scatter can't hide per-group, so it shows the envelope while the sliders drive the
 * exact per-group mask). `[min(lo), max(hi)]` over the groups that carry a range;
 * `undefined` when none do (no filter).
 */
export function range_envelope(byGroup: Record<string, [number, number]>): [number, number] | undefined {
  let lo: number | undefined
  let hi: number | undefined
  for (const range of Object.values(byGroup ?? {})) {
    if (!Array.isArray(range) || range.length !== 2) continue
    const [l, h] = range
    if (typeof l === 'number' && (lo === undefined || l < lo)) lo = l
    if (typeof h === 'number' && (hi === undefined || h > hi)) hi = h
  }
  return lo === undefined || hi === undefined ? undefined : [lo, hi]
}

export interface GateMaskInput {
  /** a base HIDDEN mask (e.g. the merged per-metric slider mask). */
  base: boolean[]
  /** the brushed gate — the canonical point indices to KEEP. Empty ⇒ no gate (the base
   *  mask is returned unchanged, so an un-brushed view is slider-only). */
  gate: number[]
}

/**
 * Combine a base hidden mask with a brushed gate (the "sliders AND gate" reduce, research
 * §11 class-3). A row is hidden iff the base mask hides it OR (a non-empty gate is active
 * AND the row's index is NOT in the gate). An empty gate is a no-op (returns `base`),
 * so the gate only ever REMOVES additional rows — it never resurrects a slider-hidden one.
 */
export function gate_mask(input: GateMaskInput): boolean[] {
  const { base, gate } = input
  if (gate.length === 0) return base.slice()
  // INV-10 (ITEM-4): the base hidden mask and the brushed gate index the SAME canonical point
  // space. A gate index at or beyond `base.length` means the gate was brushed over a DEEPER frame
  // than the base landed to — the two buffers are at different depths, and applying the gate would
  // silently mis-address. Refuse rather than let a local-vs-global offset mismatch through.
  for (const i of gate) {
    if (i >= base.length) {
      // Report the FIRST offending index, not `Math.max(...gate)` — a spread over a very large
      // brushed gate could itself RangeError inside the refusal path.
      throw new FrameDepthMismatchError('gate_mask', [base.length, i + 1])
    }
  }
  const keep = new Set(gate)
  return base.map((hidden, i) => hidden || !keep.has(i))
}

// ── Criteria KEEP masks (declarative-canvas-plots ITEM-29/30) ───────────────────
// A criteria form builds a per-ROW KEEP mask (true = kept) as the AND of user-chosen
// CRITERIA. A criterion is either a CONTINUOUS range (min/max on a numeric `obs` column)
// or a CATEGORICAL multi-select (the set of categories to keep). These are the pure
// kernels the run-pane form composes live (`$derived.keptMask`) and that seed the
// `obs.kept` stream feeding the before/after canvas plots — a processor's run pane is the
// first CONSUMER, but nothing below is typed to one. NOTE these return KEEP masks
// (true = kept), the INVERSE of `filter_mask`/`or_masks` above (which return HIDDEN
// masks) — a KEEP mask feeds `CanvasObsSource`'s `keepMask` (keeps where `!== false`).

/**
 * Per-ROW KEEP mask for a CONTINUOUS range criterion (ITEM-29): a row is kept iff its
 * value is within `[min, max]` (each bound INCLUSIVE; a `null` bound is unbounded on that
 * side). A non-finite value FAILS a numeric criterion (dropped) — an unmeasured row can't
 * be shown to satisfy a threshold. Both bounds `null` ⇒ no constraint (every row kept).
 */
export function keep_range(values: number[], min: number | null, max: number | null): boolean[] {
  return values.map(v => {
    // NON-FINITE fails a real numeric threshold — it cannot be SHOWN to satisfy one.
    // `Number.isNaN` alone let +/-Infinity through, so an obs column carrying an inf
    // was kept live and dropped on commit (`cell-filter.py` does `m &= np.isfinite`,
    // and the emitted replay prelude's `_num` requires `math.isfinite`). The
    // docstrings on all three already said this; only this one did not do it.
    if (typeof v !== 'number' || !Number.isFinite(v)) return min == null && max == null
    if (min != null && v < min) return false
    if (max != null && v > max) return false
    return true
  })
}

/**
 * Per-ROW KEEP mask for a CATEGORICAL multi-select criterion (ITEM-29): a row is kept iff
 * its category is in `keep`. An EMPTY `keep` set is "no category selected" ⇒ NO constraint
 * (every row kept) — a criterion the user has not narrowed yet must never hide everything.
 */
export function keep_categories(values: string[], keep: readonly string[]): boolean[] {
  if (keep.length === 0) return values.map(() => true)
  const set = new Set(keep.map(String))
  return values.map(v => set.has(String(v)))
}

/**
 * Element-wise AND across N parallel KEEP masks (ITEM-30) — the COMBINED keep-mask: a row
 * survives iff it passes EVERY criterion. An empty input ⇒ `[]` (the caller supplies the all-
 * kept default over the `obs` length, since no criterion means keep all). Length is the MAX
 * across masks; a position MISSING from a shorter mask defaults to KEPT (`true`) so a shorter
 * criterion mask can't spuriously drop tail rows (mirrors `or_masks`' length discipline).
 */
export function keep_and(masks: boolean[][]): boolean[] {
  if (masks.length === 0) return []
  // PAD-KEEP is a DELIBERATE backend-parity contract, NOT a mis-alignment (incremental-landing
  // DEC-4, amended): each mask is a CRITERION's keep-mask over its own frame column, and a criterion
  // column may be legitimately SHORTER than the frame (measured on a subset). The committed
  // backend mask pads the missing tail as KEPT (`np.concatenate([m, ones])`, the prelude's
  // `i >= len(col)`), so the live preview must too — this is pinned by the 127-case coercion corpus.
  // A missing entry defaults to KEPT is index-ALIGNED (row i is still row i, an absent column
  // defaults kept), so it does not violate INV-10's no-mis-address property. The mixed-depth
  // REFUSAL lives on the directly-paired kernels (`filter_mask`/`count_by`/`gate_mask`/`or_masks`)
  // and on the CROSS-SOURCE keep-mask (`CanvasObsSource`, ITEM-8) — where differing depths DO
  // mis-address — never on this criteria path.
  let n = 0
  for (const mask of masks) {
    if (mask.length > n) n = mask.length
  }
  const out = new Array<boolean>(n).fill(true)
  for (const mask of masks) {
    for (let i = 0; i < n; i++) {
      if (mask[i] === false) out[i] = false
    }
  }
  return out
}

export interface CountByInput {
  /** the per-cell group key. */
  group: string[]
  /** the per-cell hidden mask, parallel to `group`. */
  hidden: boolean[]
}

/**
 * Per-group before/after cell counts. `before` = every cell in the group;
 * `after` = cells NOT hidden. Groups appear in first-seen order of `group`.
 */
export function count_by(input: CountByInput): Record<string, { before: number; after: number }> {
  const { group, hidden } = input
  // INV-10 (ITEM-4): `group` and `hidden` are one frame's two index-parallel columns; a
  // mixed-depth pair would count a row's group against another row's hidden flag. Refuse.
  assertIndexParallel('count_by', [group, hidden])
  // `Object.create(null)` — a data-derived group named `__proto__`/`constructor`
  // must become an ordinary own key, NEVER write onto `Object.prototype`.
  const out: Record<string, { before: number; after: number }> = Object.create(null)
  for (let i = 0; i < group.length; i++) {
    const g = group[i]
    if (!out[g]) out[g] = { before: 0, after: 0 }
    out[g].before += 1
    if (!hidden[i]) out[g].after += 1
  }
  return out
}

// ── Cell-filter COMBINED keep-mask + obs-column classification (Slice 4, ITEM-9) ─────────────
// The general kernels the cell-filter DATA package's `$derived` composes — a keep-mask from a
// user-built criteria list, and the obs columns + control types the criterion picker offers.
// GENERAL (no cell-filter code): a criterion is `{column, control, min?, max?, keep?}` where
// `control ∈ {range, multiselect}`. Pure — directly unit-testable.

/** One criterion of the combined keep-mask: a continuous `range` (min/max on a numeric column)
 *  or a categorical `multiselect` (the set of categories to keep). Field names mirror the DATA
 *  shape a `for_each: $state.criteria` builds. */
export interface KeepCriterion {
  column?: string
  control?: string
  /** min/max may arrive as a string (a `text` input) or number; `boundOrNull` coerces. */
  min?: number | string | null
  max?: number | string | null
  keep?: readonly string[]
}

const columnLength = (columns: DeclaredFrame): number => {
  // ── incremental-landing ITEM-4: count a TypedArray column (`isColumn`, not `Array.isArray`) ──
  //
  // The bare `Array.isArray` guard classified a typed column as absent → depth 0. Routing through
  // `isColumn` fixes that. It stays a `Math.max` (NOT a refusal): keep_mask serves the CRITERIA
  // contract, where a criterion column may be legitimately shorter than the frame and is PAD-KEPT
  // (backend parity — DEC-4 amended). Pad-keep is index-aligned, so it upholds INV-10's
  // no-mis-address property; the mixed-depth refusal lives on the directly-paired kernels and the
  // cross-source keep-mask, not here.
  let n = 0
  for (const v of Object.values(columns ?? {})) if (isColumn(v)) n = Math.max(n, (v as ArrayLike<unknown>).length)
  if (n > 0) return n
  // ── ITEM-34: fall back to the DECLARED row count ────────────────────────────────────────
  //
  // Only when no body is present at all, so a frame with values answers exactly as it always
  // did. Under lazy bodies that state is the NORMAL one: until a criterion names a column,
  // nothing has been fetched, and the observed max is 0. A `keep_mask` over 0 rows returns an
  // EMPTY mask — so the before/after streams would render nothing on an unfiltered surface,
  // with no error to explain it. The row count is a producer fact; read it from the producer.
  for (const d of Object.values(declarationsOf(columns))) {
    if (typeof d.n === 'number') n = Math.max(n, d.n)
  }
  return n
}

/**
 * Every column the frame can answer about: the ones whose VALUES are present, plus the ones the
 * producer DECLARED but whose bodies have not been fetched (ITEM-34).
 *
 * The picker kernels list columns; they do not need values to do it. Iterating the frame's own
 * keys alone was correct only while every declared column's body was fetched eagerly — under
 * lazy bodies it would drop 60-odd columns off the criterion picker the moment they stopped
 * being downloaded, which is a blank picker with a clean console: the exact failure class this
 * work exists to avoid. Declaration order is preserved and frame keys come first, so a frame
 * with every body present enumerates in exactly the order it used to.
 */
function columnIds(columns: DeclaredFrame): string[] {
  const ids = Object.keys(columns ?? {})
  const seen = new Set(ids)
  for (const id of Object.keys(declarationsOf(columns))) if (!seen.has(id)) ids.push(id)
  return ids
}

/** Coerce a criterion bound to a finite number or `null` (unbounded). A `null`/`undefined`/empty-
 *  string bound (an untouched or cleared text input) is UNBOUNDED — never `Number('')===0`, which
 *  would spuriously drop every cell below 0. A non-numeric string is likewise unbounded. */
const boundOrNull = (x: unknown): number | null =>
  parseBound(x as string | number | null | undefined) ?? null

/**
 * A criterion is CATEGORICAL (a keep-set filter) vs CONTINUOUS (a min/max range) inferred from its
 * SHAPE — NOT from a `control` field the real declarative path never sets (the P1 bug: a view
 * seeds `control:''` and only ever writes `column/min/max/keep`, so a categorical keep-set
 * arriving with `control:''` silently fell into the range branch → keep-all). An explicit
 * `control` is still honored when present (back-compat / an AI that sets it); otherwise a
 * non-empty `keep` list ⇒ categorical, and min/max ⇒ range. The rule is the SPEC's
 * (`core/criteria::isCategoricalCriterion`); every reader conforms to it, so the live preview
 * mask and the committed mask agree.
 */
const isCategoricalCriterion = (c: KeepCriterion): boolean =>
  isCategoricalCriterionShared(c as { control?: string; keep?: readonly string[] | null })

/**
 * The COMBINED per-cell KEEP mask (ITEM-9 / DEC-27 joint-drop): the AND over `criteria` of each
 * criterion's keep-mask on ITS obs column. A cell survives iff it passes EVERY criterion — a
 * criterion on ANY column (any modality's obs) drops the WHOLE cell (joint drop is inherent: the
 * mask is ONE per-cell boolean over the shared obs). NO criteria ⇒ every cell kept (all-`true`
 * over the obs length). A criterion whose column is absent from `obs` keeps every cell (an
 * unresolved column must never silently hide the dataset). The categorical-vs-range branch is
 * inferred from the criterion SHAPE (`isCategoricalCriterion`) so the real UI path — which never
 * sets `control` — reaches the categorical branch (P1 fix), matching the committed backend mask.
 * This is the client-side `$derived.keptMask` — recomputed live; nothing is persisted until Run
 * commits the labeled mask.
 */
export function keep_mask(criteria: readonly KeepCriterion[], columns: DeclaredFrame): boolean[] {
  const n = columnLength(columns)
  if (!Array.isArray(criteria) || criteria.length === 0) return new Array<boolean>(n).fill(true)
  const declared = declarationsOf(columns)
  const masks: boolean[][] = []
  for (const c of criteria) {
    // TRIMMED (`criterionColumn`) — the same spelling the predicate builder and both
    // script emitters use, so a padded column name cannot make the recorded recipe
    // constrain a column this mask never looked up.
    const name = criterionColumn(c)
    const col = name ? columns?.[name] : undefined
    // ITEM-4: `isColumn`, not `Array.isArray` — a TypedArray-backed column is a real, present
    // column; the bare guard classified it PENDING (all-false mask ⇒ everything dropped).
    if (!isColumn(col)) {
      // ── ITEM-34: ABSENT and PENDING are different, and confusing them is silent ──────────
      //
      // A criterion on a column that does not EXIST must keep every row — never silently hide
      // the table. But once column bodies are fetched lazily, a criterion can also name a
      // column that exists and has simply not ARRIVED yet, and the two are indistinguishable
      // from the values alone. Treating pending as absent means the criterion quietly does
      // nothing while the user watches an unfiltered result and believes it is filtered.
      //
      // The DECLARATION is what tells them apart: the producer says the column exists, the
      // values say it is not here yet. A pending criterion therefore contributes an
      // all-FALSE mask — conservative and VISIBLE (an empty result is obviously not an
      // answer) rather than permissive and invisible. In practice the form gates on
      // `pendingCriterionColumns` and never renders this state; this is the defence for when
      // something calls the kernel anyway.
      const pending = name !== undefined && declared[name] !== undefined
      masks.push(new Array<boolean>(n).fill(!pending))
      continue
    }
    if (isCategoricalCriterion(c)) {
      // `categoricalMatches` (the SPEC's comparator, shared with the predicate builder),
      // NOT `String()` + set-membership: JS spells a boolean `"true"` and a null `"null"`
      // where a python-`str()` committed mask says `"True"`/`"None"`, and a float column's
      // `1` is `"1"` here but `"1.0"` there. The live preview therefore showed the
      // inverse of what was committed for boolean, null-bearing and float columns.
      const keep = Array.isArray(c.keep) ? c.keep : []
      // An EMPTY keep-set is "no category selected" ⇒ NO constraint (a criterion the
      // user has not narrowed yet must never hide everything) — `keep_categories`'
      // long-standing rule, preserved here. A NON-ARRAY `keep` is not a keep-set
      // anywhere (see `isCategoricalCriterion`), so it lands here as empty too.
      masks.push(
        keep.length === 0
          ? new Array<boolean>(col.length).fill(true)
          : // ITEM-4: `mapLike`, not `col.map` — `Float32Array.prototype.map` returns a
            // Float32Array, so a converted guard whose BODY still used `.map` would yield a typed
            // array where a `boolean[]` is expected (silently wrong numbers, not a visible break).
            mapLike(col, v => categoricalMatches(v, keep)),
      )
    } else {
      // Default (and explicit `range`): a numeric min/max keep. Bounds coerced from the
      // text inputs (`boundOrNull`) and CELLS coerced with `parseValue` — NOT bare
      // `Number()`, whose accept-set differs from the committed mask's on exactly the
      // values obs columns actually carry (`null`, `''`, `' '`, `'0x10'`). See
      // [`parseValue`].
      // ITEM-4: `mapLike` produces a real `number[]` — `col.map(parseValue)` on a Float32Array
      // would hand `keep_range` a Float32Array (see the categorical arm above).
      masks.push(keep_range(mapLike(col, parseValue), boundOrNull(c.min), boundOrNull(c.max)))
    }
  }
  const combined = keep_and(masks)
  if (combined.length < n) return combined.concat(new Array<boolean>(n - combined.length).fill(true))
  return combined
}

/**
 * The DISTINCT category VALUES of each CATEGORICAL (string) obs column, as a `{ column: string[] }`
 * MAP (Slice 4, ITEM-9/29). Backs a categorical criterion's keep-set multiselect OPTIONS
 * (`$derived.categoriesByColumn[$c.column]`) — without it the multiselect has no options and the
 * user can never build a categorical keep-set (the P1 keep-set-empty bug). Values are in first-seen
 * order (mirrors `encodeCategorical`/`unique`); numeric columns are skipped (they use a min/max
 * range, not a keep-set). Pure — the reactive `derived` recompute kernel over the frame.
 */
export function categories_by_column(columns: DeclaredFrame): Record<string, string[]> {
  // `Object.create(null)` — a data-derived column named `__proto__`/`constructor` must become an
  // ordinary own key, never write onto `Object.prototype` (mirrors `count_by`'s guard).
  const out: Record<string, string[]> = Object.create(null)
  const declared = declarationsOf(columns)
  for (const id of columnIds(columns)) {
    const v = (columns ?? {})[id]
    const d = declared[id]
    // ITEM-34 — a DECLARED column with no body yet still offers its levels. That is the whole
    // affordance: the picker lists a column's categories without downloading the column. A
    // body-less column with no declared levels contributes nothing (there is nothing to
    // inspect and nothing declared), rather than an empty option list that reads as "this
    // column has no categories".
    // ITEM-4: `isColumn`, not `Array.isArray` — a TypedArray body must be inspected, not treated
    // as absent (which would fall back to declared levels only ⇒ no options offered).
    if (!isColumn(v)) {
      // NON-EMPTY, not merely present: `[]` is truthy, and a producer that declared an empty level
      // set has told us nothing. `valuePreview` in `artifactReader` already applies exactly this
      // rule (`!levels || levels.length === 0`); this arm did not.
      if (d?.levels && d.levels.length > 0) out[id] = [...d.levels]
      continue
    }
    // ── ITEM-32: the PRODUCER's level set outranks the observed one ──────────────────────
    //
    // The declaration is authoritative; the rows present are only part of it. Two differences are
    // real and both are wanted: a level that occurs in ZERO rows stays on offer (pandas keeps
    // unused categories after a subset, and a user filtering on a value that is currently
    // absent should see it rather than be told it does not exist); and the ORDER is the
    // producer's, not first-seen.
    //
    // The levels arrive ALREADY spelled in the comparator's dialect (`declaration()` bridges
    // them once, at construction) — offering a raw declared bool level would match nothing and
    // silently drop every row of that criterion.
    // NON-EMPTY, not merely present. `[]` is truthy, so an empty declared set used to SUPPRESS the
    // inspection fallback below and hand back zero options over a column whose rows are right here
    // — a dropdown that says "this column has no categories" about a column full of them. An empty
    // declaration is an absence of information, not an assertion that there are no levels.
    if (d?.levels && d.levels.length > 0) {
      out[id] = [...d.levels]
      continue
    }
    // Categorical only: skip numeric columns (their control is a range, not a keep-set).
    // Falls back to INSPECTION when the producer declared nothing — every frame that predates
    // the sidecar, and every synthesised one.
    if (v.length > 0 && typeof (v as ArrayLike<unknown>)[0] === 'number') continue
    // `pyStr` — the SAME spelling `keep_mask`'s comparator (`categoricalMatches`) and the
    // committed mask (`cell-filter.py`'s `str(x) in wanted`) use. F2-28: this used to spell
    // the OPTIONS with JS `String()` while round 1 moved the COMPARISON to `pyStr`, so every
    // option a boolean column offered ("true"/"false") and every "null" option was DEAD —
    // picking it hid 100% of the cells in both the preview and the commit, with no error.
    // One spelling for the option list and the comparator, or the dropdown offers values its
    // own filter cannot match.
    // ITEM-4: `mapLike` — `unique(v.map(pyStr))` on a TypedArray would call `Float32Array.map`,
    // which returns a Float32Array (numbers), not the `string[]` `unique`/the multiselect expect.
    out[id] = unique(mapLike(v, pyStr))
  }
  return out
}

/**
 * The criterion-named columns the producer DECLARED but whose values have not arrived (ITEM-34).
 *
 * The gate for lazy column bodies. `axis_columns` fetches metadata for every column and bodies
 * only for the columns a criterion actually names, so between the user picking a new column and
 * its body landing there is a window in which the criterion cannot be evaluated. A form that
 * rendered a result during that window would show an UNFILTERED table while the user believes a
 * filter is applied — the failure this exists to make impossible.
 *
 * Non-empty ⇒ the slice is still `loading` and no result may be shown. Empty ⇒ every criterion
 * can be answered. A criterion naming a column the producer never declared is NOT pending — it
 * is genuinely absent, and keeps every row.
 */
export function pendingCriterionColumns(
  criteria: readonly KeepCriterion[],
  columns: DeclaredFrame,
): string[] {
  if (!Array.isArray(criteria)) return []
  const declared = declarationsOf(columns)
  const out: string[] = []
  for (const c of criteria) {
    const name = criterionColumn(c)
    if (name === undefined || name === '') continue
    // ITEM-4: `isColumn` — a TypedArray body means the column has ARRIVED; the bare `Array.isArray`
    // reported it pending forever, so the loading gate never opened.
    if (declared[name] !== undefined && !isColumn(columns?.[name]) && !out.includes(name)) {
      out.push(name)
    }
  }
  return out
}

/** The control a column's criterion renders: a numeric `range` or a category `multiselect`. */
export type ControlType = 'range' | 'multiselect'

/** The control the PRODUCER's declared kind implies, or `undefined` when it declared none. */
function declaredControl(d: ColumnDeclaration | undefined): ControlType | undefined {
  if (d?.kind === 'categorical') return 'multiselect'
  if (d?.kind === 'continuous') return 'range'
  return undefined
}

/** A pickable column + its control type (numeric → `range`, string → `multiselect`). */
export interface ColumnOption {
  value: string
  label: string
  control: ControlType
}

/**
 * The control a column's criterion renders.
 *
 * EXPORTED for its first direct tests (ITEM-37). It was module-private while being one of the
 * three classifiers that decide what a user can EXPRESS about a column — a flip between `range`
 * and `multiselect` changes which branch `keep_mask` evaluates, so it is result-affecting rather
 * than cosmetic, and it had no coverage of its own.
 *
 * Note it is a HEAD PEEK: a leading `null`, or a momentarily-empty column, classifies as
 * `multiselect`. ITEM-33's declaration-driven successor must agree with this on every real
 * column, which is what the pinned tests exist to check.
 */
export const controlOfColumn = (values: ArrayLike<unknown>): ControlType =>
  values.length > 0 && typeof values[0] === 'number' ? 'range' : 'multiselect'

/**
 * Is this column an IDENTIFIER rather than a category?
 *
 * A column with a distinct value in every row names its rows; it does not group them. Both
 * things the app does with a "categorical" column are degenerate for one:
 *
 *   · as a GROUPING, every group has exactly one member — N violins of one point each. On a
 *     real frame that renders as a 2700-entry legend over a smear, which is what the shared
 *     canvas did once the charts started painting.
 *   · as a CRITERION, the keep-set offers one option per row. Choosing from it is not
 *     filtering, it is picking rows by name.
 *
 * So this is not a display threshold, and deliberately not a "too many categories" heuristic
 * with a tuned cutoff — a legitimately high-cardinality category (a donor, a cluster) stays a
 * category no matter how many levels it has. The property is exact: EVERY value distinct.
 * It holds at every size, including small ones — three rows with three different labels group
 * just as uselessly as 2700 do.
 *
 * `< 2` rows is excluded because everything is trivially distinct there and there is nothing
 * to group either way; stripping every column off a one-row frame would be a worse answer
 * than an unhelpful one.
 *
 * Cost is proportional to the DUPLICATE, not to the column: a real category repeats early, so
 * this exits after a handful of values. Only a genuine identifier pays a full pass.
 */
export function isIdentifierColumn(values: ArrayLike<unknown>): boolean {
  if (values.length < 2) return false
  const seen = new Set<unknown>()
  // Indexed, not `for…of` — `values` is an `ArrayLike` (ITEM-4: a TypedArray column reaches here
  // too), which the type does not guarantee is iterable.
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (seen.has(v)) return false
    seen.add(v)
  }
  return true
}

/**
 * Classify a columnar slice into its pickable columns + control types (ITEM-9/29). A numeric
 * column → `range`, a string column → `multiselect`. `only` filters to one control family (a
 * group-by picker asks for `categorical`); `keyed` returns a `{ column: <value> }` MAP (for a
 * `when` gate) instead of the `[{value,label,control}]` ARRAY (for a `select`'s options).
 * Empty / non-array columns are skipped. Pure.
 *
 * `as` REMAPS the map's values. C1/C2 (DOMAIN_AUDIT): this used to accept the literal
 * `as: 'plot'` and answer `violin` for a continuous column and `bar` for a categorical one —
 * a chart-choice default, for one product's taste, hardcoded inside a core compute primitive
 * that is supposed to know nothing about plots. The mapping is DATA now: the view declares
 * `as: { range: <kind>, multiselect: <kind> }` and gets exactly what it asked for. A control
 * with no entry in the map falls back to the control name itself, so a partial map cannot
 * silently produce `undefined`.
 */
export function columns_of(
  columns: DeclaredFrame,
  opts?: {
    only?: 'continuous' | 'categorical'
    keyed?: boolean
    /** a `{ <control> : <value> }` remap for the keyed form (e.g. a chart kind per control). */
    as?: Partial<Record<ControlType, string>>
  },
): ColumnOption[] | Record<string, string> {
  const wantControl =
    opts?.only === 'continuous' ? 'range' : opts?.only === 'categorical' ? 'multiselect' : undefined
  const remap = opts?.as && typeof opts.as === 'object' ? opts.as : undefined
  const array: ColumnOption[] = []
  const map: Record<string, string> = {}
  const declared = declarationsOf(columns)
  for (const id of columnIds(columns)) {
    const v = (columns ?? {})[id]
    const d = declared[id]
    // ITEM-34 — a DECLARED column with no body yet is still offered, classified from its
    // declaration. Dropping it would empty the criterion picker under lazy bodies; and a
    // body-less column with NO declared kind is skipped, because there is then nothing to
    // classify it by and guessing a control decides what the user is allowed to express.
    // ITEM-4: `isColumn` — a TypedArray body must be classified from its values, not dropped from
    // the picker as if absent.
    if (!isColumn(v)) {
      const dc = declaredControl(d)
      if (dc === undefined) continue
      if (wantControl && dc !== wantControl) continue
      array.push({ value: id, label: id, control: dc })
      map[id] = remap?.[dc] ?? dc
      continue
    }
    // ITEM-33 — classify from the DECLARATION when the producer made one. The head peek
    // (`typeof values[0]`) misreads a column whose first row is `null`, and misreads an
    // empty column entirely; the producer's kind is right in both cases and costs no read.
    const control = declaredControl(d) ?? controlOfColumn(v)
    // An identifier is offered as NEITHER control. It reaches here as a `multiselect` only
    // because it is not numeric, and a keep-set with one option per row is not a filter.
    //
    // A DECLARED categorical is never an identifier, however the sampled rows look: a subset
    // in which every value happens to be distinct is still a category, and dropping it would
    // remove a legitimate filter the moment a user narrowed far enough.
    if (control === 'multiselect' && !isDeclaredCategorical(d) && isIdentifierColumn(v)) continue
    if (wantControl && control !== wantControl) continue
    array.push({ value: id, label: id, control })
    map[id] = remap?.[control] ?? control
  }
  return opts?.keyed ? map : array
}
