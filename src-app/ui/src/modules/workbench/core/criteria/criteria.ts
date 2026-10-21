// The CRITERIA COERCION SPEC — the coercion + spelling rules of the app's ONE declarative
// filter encoding (`{column, control, min?, max?, keep?}[]`).
//
// ## This module is NORMATIVE (C1/C2 — DOMAIN_AUDIT)
//
// The comments here used to say core "mirrors VERBATIM `cell-filter.py::_VALUE_WS`" and
// "Mirrors the backend `cell-filter.py::_is_categorical_criterion`". That named ONE
// processor's compute script as the definition of an app-wide wire format, which is a real
// coupling and not just wording: it says core cannot change a whitespace or `str()` rule
// without breaking that processor, and that any OTHER processor wanting a filter has to go
// read a single-cell script to find out what its own filters mean.
//
// The direction is inverted here. **This module + `src-app/testdata/criteria-coercion-
// corpus.json` are the SPEC**; there are four CONFORMING READERS, none of which is
// authoritative and any of which may be replaced:
//
//   1. this module + `core/runtime/primitives.ts::keep_mask` — the live client preview;
//   2. any COMPUTE KERNEL that commits a mask (today: `packages/cell-filter/compute/
//      cell-filter.py`, one processor among N; tomorrow, an R or Rust kernel);
//   3. `server/src/modules/provenance/criteria_script.rs` — the emitted, attested replay;
//   4. `server/.../export/methods.rs` — the narration.
//
// The corpus is the executable form of the spec: 123 cases, run against readers 1-3 by
// `core/runtime/coercionCorpus.test.ts`, `packages/cell-filter/tests/
// test_coercion_corpus.py` and `criteria_script.rs`'s corpus test. A reader that disagrees
// with the corpus is the thing that is wrong. [`CRITERIA_COERCION_VERSION`] stamps the spec
// so a rule change cannot land without the corpus (and therefore every reader) moving with
// it.
//
// The encoding itself carries NO domain: `{column, control, min/max/keep}` over a columnar
// slice is a generic tabular filter, and the rules below are about crossing a LANGUAGE
// boundary (JS preview vs a Python committed mask vs a Rust attested replay), not about
// biology. That is why it is core and not a processor's private business — see the C1/C2
// note in the workstream report for the rejected alternative (relocating it into the
// cell-filter package, which processor packages, being DATA, cannot hold).
//
// It previously lived in `core/dsl/criteriaPredicate.ts` beside a SECOND encoding of
// the same filter (an index-set predicate lift). That duplicate encoding is deleted; the
// vocabulary is not, because it is what the surviving `criteria` path is built on. It
// lives OUTSIDE the (since-deleted) `core/dsl/` tree, so nothing here ever depended on
// the predicate AST — which is why this vocabulary outlived it.
/**
 * The SPEC version, stamped into `src-app/testdata/criteria-coercion-corpus.json`'s
 * `version` field and asserted equal by `core/runtime/coercionCorpus.test.ts`.
 *
 * BUMP IT whenever a coercion rule below changes (the grammar, either trim set, the `str()`
 * spelling, the categorical membership test, the cell coercion). The corpus has carried a
 * `version` since it was written but nothing compared it to the code, so a rule could drift
 * away from the cases that are supposed to pin it and the only signal would be whichever
 * case happened to cover it. Now the version is the signal.
 */
export const CRITERIA_COERCION_VERSION = 2

/** One row of the declarative criteria builder. */
export interface FilterCriterion {
  /** the obs column the criterion constrains. */
  column?: string
  /** `range` | `multiselect` — usually UNSET by the real UI (the shape decides). */
  control?: string
  min?: string | number | null
  max?: string | number | null
  /** the categorical keep-set. */
  keep?: ReadonlyArray<string | number> | null
}

/**
 * The ONE decimal grammar every coercion in this feature accepts.
 *
 * Four independent parsers read the same criterion bound / keep value — JS
 * `Number()` (this builder + the live `keep_mask`), Python `float()`
 * (`cell-filter.py`, the committed mask), Rust `parse::<f64>()`
 * (`predicate_script::bound`, the emitted replay script) and the narration
 * (`export/methods.rs`). Their *native* accept-sets differ, and every difference is
 * a case where the recorded predicate constrains something the committed mask did
 * not (or vice versa):
 *
 *   `"0x10"`     JS 16 · Python raises · Rust rejects → predicate filters, mask does not
 *   `"inf"`      JS NaN · Python +inf  · Rust +inf    → mask filters, predicate does not
 *   `"1_0"`      JS NaN · Python 10.0  · Rust rejects
 *   `"Infinity"` JS +inf (non-finite, dropped) · Python +inf · Rust rejects
 *
 * Restricting all four to plain decimal notation makes them agree by construction:
 * optional sign, digits with an optional fraction (or a leading `.`), optional
 * exponent. No hex/octal/binary, no `inf`/`nan` spellings, no digit separators.
 */
export const DECIMAL_BOUND = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * The SIX whitespace characters every reader trims — and ONLY those.
 *
 * F2-1: this used to be JS `String.prototype.trim()`, which strips the whole Unicode
 * `White_Space` set (19 codepoints: NBSP U+00A0, the U+2000-U+200A spaces, U+3000,
 * the BOM U+FEFF, U+0085, …). `cell-filter.py::_bound_or_none` strips exactly
 * `" \t\n\r\f\v"` (python's own `str.strip()` would additionally eat U+001C-U+001F
 * and U+0085) and `predicate_script::bound` `trim_matches` exactly the same six
 * (Rust's `str::trim()` would eat the Unicode set). So a PASTED bound — Min/Max are
 * free-text widgets, and a value copied out of a spreadsheet or a CJK IME carries a
 * NBSP / ideographic space — was `10` here and UNBOUNDED in both other readers: the
 * saved recipe persisted `{lte:[{col:pct_mito},10]}` and the preview kept 3/5 cells
 * while the COMMITTED mask kept 5/5 and the report's `thresholds` was `[]`. Zero
 * diagnostics, rc=0.
 */
const ASCII_WS_LEAD = /^[ \t\n\r\f\v]+/
const ASCII_WS_TRAIL = /[ \t\n\r\f\v]+$/
/** Any codepoint outside ASCII. `_bound_or_none` refuses a non-ascii bound outright
 *  (`x.isascii()`), and `predicate_script::bound` refuses it via the ASCII-only
 *  decimal grammar that survives its six-char trim — one rule, three readers. */
const NON_ASCII = /[^\u0000-\u007f]/

/** Parse a criterion bound to a finite number, or `undefined` (unbounded) — the
 *  canonical coercion. Empty / absent / not plain decimal notation → unbounded.
 *  `cell-filter.py::_bound_or_none` and `predicate_script::bound` CONFORM to this.
 *
 *  REJECT vs UNBOUNDED (F2-1, deliberate): both twins answer `None` — i.e.
 *  **unbounded, not an error** — for a padded / non-ascii / ungrammatical bound
 *  (`_bound_or_none` returns `None`, `predicate_script::bound` returns `None`, and
 *  each caller then treats that bound as absent). So this returns `undefined`
 *  (unbounded) rather than throwing: an unparseable bound must mean the SAME thing
 *  in all three readers, and "unbounded everywhere" is the only answer that keeps
 *  the recorded predicate and the committed mask describing the same selection.
 *
 *  TYPE-GATE (F2-5): only a string or a finite JSON number is a bound. This used to
 *  `String(v)` ANY value, so `{min:[10]}` stringified to `"10"` and recorded
 *  `gte 10` while `_bound_or_none` (which type-gates: not `None`/bool/int/float/str
 *  ⇒ `None`) and `predicate_script::bound` (which matches only `Value::Number` /
 *  `Value::String`) both applied NO constraint. A bool is likewise not a bound —
 *  `_bound_or_none` rejects it explicitly so `float(True)` can't become `1.0`. */
export function parseBound(v: string | number | null | undefined): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  if (NON_ASCII.test(v)) return undefined
  const s = v.replace(ASCII_WS_LEAD, '').replace(ASCII_WS_TRAIL, '')
  if (!DECIMAL_BOUND.test(s)) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

const bound = parseBound

/**
 * The ONE whitespace set every reader strips off a criteria CELL — the SPEC rule.
 * `cell-filter.py::_VALUE_WS` and `predicate_script::CRITERIA_PRELUDE::_VALUE_WS` conform to
 * it, and every `C*-pad-*` case of `src-app/testdata/criteria-coercion-corpus.json`
 * exercises it.
 *
 * C1/C2: this lived in `core/runtime/primitives.ts` — the "BOUNDED set of app-owned compute
 * primitives" — so the app's coercion spec was split across two modules and half of it sat
 * in the file whose own header says a primitive is a general kernel. Both halves live here
 * now, and `primitives.ts` imports them like it already imported `parseBound`/`pyStr`.
 *
 * ROUND-4 (R3-108): each reader used its own NATIVE trim, and the three native sets differ
 * in BOTH directions — JS `String.prototype.trim()` strips U+FEFF (the BOM a spreadsheet
 * export leaves on a pasted value) and python's `str.strip()` does not; python strips U+0085
 * (NEL) and U+001C-U+001F and JS does not. So a BOM-padded cell was KEPT by the live preview
 * and DROPPED by the committed mask, and a NEL-padded cell the reverse — the mask the user
 * tuned was not the mask that got committed, at rc=0 with no diagnostic. The set below is the
 * UNION of Unicode `White_Space`, python's extra U+001C-U+001F and JS's U+FEFF, so the
 * readers agree by construction and none loses a row another would have accepted.
 *
 * NOTE the deliberate asymmetry with [`ASCII_WS_LEAD`]/[`parseBound`]: a BOUND is AUTHORED
 * text held to the strict six-ASCII trim (a padded bound is UNBOUNDED in all readers), while
 * a CELL is DATA and is trimmed leniently. Both rules are uniform across the readers, which
 * is the invariant that matters.
 */
const VALUE_WS_CLASS =
  '[ \\t\\n\\r\\v\\f\\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]'
const VALUE_WS_LEAD = new RegExp(`^${VALUE_WS_CLASS}+`)
const VALUE_WS_TRAIL = new RegExp(`${VALUE_WS_CLASS}+$`)

/**
 * Coerce ONE criteria CELL to a number for the range branch — `NaN` when the cell is not a
 * number (a `NaN` fails every threshold in `keep_range`, which is what an unmeasured value
 * must do).
 *
 * F2-27: this used to be bare `Number()`, the ONE coercion the bound unification left behind.
 * `Number()`'s accept-set is not the committed mask's: `Number(null) === 0`, `Number('') === 0`,
 * `Number(' ') === 0` and `Number('0x10') === 16`, where `cell-filter.py::_value_float` (the
 * COMMITTED mask) and the emitted replay prelude's `_num` all answer NaN / drop. A `null` cell
 * is not hypothetical — it is what `arrowClient.tableFromArrow`'s `getChildAt(c)?.get(r)`
 * yields for an Arrow null slot, i.e. any column with missing values — so the live preview KEPT
 * (`0 <= max`) a row that the committed mask and the emitted replay script both DROPPED,
 * silently, with the recorded predicate describing the committed answer.
 *
 * The rule, in its order:
 *  - `null`/`undefined` → NaN (python `None` → NaN).
 *  - a boolean → 1/0. A boolean column reaches numpy's numeric fast path (`dtype.kind == 'b'`
 *    → `astype(float)`), which is 1.0/0.0 — and the emitted prelude's `float(True)` agrees.
 *  - a string → stripped of the CELL whitespace set (the ONE enumerated set, NOT
 *    `String.prototype.trim()`), then held to the shared [`DECIMAL_BOUND`] grammar — the same
 *    grammar the bound coercion, the emitter and the narration are held to.
 *  - anything else (an object/array cell) → NaN.
 */
export function parseValue(v: unknown): number {
  if (v === null || v === undefined) return Number.NaN
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v !== 'string') return Number.NaN
  const s = v.replace(VALUE_WS_LEAD, '').replace(VALUE_WS_TRAIL, '')
  if (!DECIMAL_BOUND.test(s)) return Number.NaN
  return Number(s)
}

/**
 * Is a value SPELLABLE — i.e. does it have one `str()` spelling that all four readers
 * can produce, in Rust, Python and JS alike?
 *
 * Exactly the JSON SCALARS: `string`, `number`, `boolean`, `null`/`undefined`. A
 * CONTAINER (array / object / anything else) is **not** spellable, and that is a
 * deliberate refusal rather than a missing feature — see [`pyStr`].
 */
export function isSpellableScalar(v: unknown): boolean {
  if (v === null || v === undefined) return true
  const t = typeof v
  return t === 'string' || t === 'number' || t === 'boolean'
}

/**
 * A SCALAR value as PYTHON's `str()` spells it — the spelling a categorical keep-set is
 * compared in.
 *
 * The committed mask is `cell-filter.py`'s `str(x) in wanted`, and the emitted replay
 * script matches it. The live TS mask used JS `String()`, which spells a boolean
 * `"true"` and a null `"null"` where Python says `"True"` / `"None"`. So a keep-set of
 * `["True"]` over a boolean column selected every matching cell on commit and NOTHING
 * in the live preview — the preview showed the exact inverse of what was about to be
 * committed. One spelling, all three readers.
 *
 * ## ROUND-4b (R4A-01 / R4A-02): a CONTAINER has NO spelling here, by refusal
 *
 * Round 4 tried to reproduce python's container spellings in this function
 * (`[${…join(', ')}]`, `{'k': v}`). That was an over-correction and it FAILED, because
 * JS has no int/float distinction: `pyStr([1.0])` answered `'[1]'` where the kernel
 * says `'[1.0]'`, so the live preview showed the COMPLEMENT of the committed mask for
 * any numeric member. The Rust emitter meanwhile spelled the same value as serde JSON
 * (`[1,2]` with no space, `["a"]` with double quotes, `[true]`, and object keys SORTED)
 * — three implementations racing to match CPython's `repr`, each losing differently.
 *
 * That race is unwinnable in JS, so the value is REFUSED at the boundary instead: a
 * non-scalar is UNSPELLABLE and therefore matches nothing, on either side of the
 * comparison, in all four readers (`categoricalMatches` here and in the live preview,
 * `cell-filter.py::_cat_hit`, and `CRITERIA_PRELUDE::_keep_in`). One rule, no repr.
 *
 * This function stays total (`string`) because `primitives.ts::categories_by_column`
 * maps a whole obs column through it to build the multiselect OPTIONS. For a container
 * cell it therefore returns JS's own `String(v)` — which is NOT a comparison spelling
 * and must never be used as one; every comparison goes through
 * [`isSpellableScalar`] + [`categoricalMatches`]. (An option derived from a container
 * cell is consequently unmatchable — correct, since the cell is unmatchable too.)
 */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  // ROUND-4 / R3-110: a NON-FINITE number. `String(Infinity)` is `'Infinity'` and
  // `String(NaN)` is `'NaN'`, where python says `'inf'` / `'-inf'` / `'nan'`. A
  // non-finite obs cell is entirely ordinary in a QC metric column, so a keep-set
  // naming one selected the exact INVERSE set in the preview from the set the kernel
  // and the attested replay selected — and the numeric fallback cannot rescue it,
  // because `'inf'` is deliberately outside the decimal grammar.
  if (typeof v === 'number' && !Number.isFinite(v)) {
    if (Number.isNaN(v)) return 'nan'
    return v > 0 ? 'inf' : '-inf'
  }
  // A CONTAINER is UNSPELLABLE (see the doc above) — this fallback is NOT a comparison
  // spelling and `categoricalMatches` never reaches it.
  return String(v)
}

/**
 * Does a cell value belong to a categorical keep-set?
 *
 * String equality on `pyStr` FIRST, then a NUMERIC fallback: when both sides are plain
 * decimals, compare their values. Without the fallback the answer depends on a dtype
 * the UI cannot see — Python spells a float column's `1` as `"1.0"` while JS spells the
 * same position `"1"`, so a keep-set of `["1","2"]` over a float categorical column matched
 * everything in the live preview and NOTHING on commit. Comparing numerically when both
 * sides are numeric removes the dtype from the answer entirely.
 *
 * ROUND-4b (R4A-01/R4A-02): an UNSPELLABLE value — a container, on EITHER side —
 * matches nothing. It is skipped rather than spelled, because no two of the four
 * readers spell a container the same way (see [`pyStr`]). A keep-set of only
 * containers therefore matches nothing while STILL constraining: that is a keep-set
 * that selects zero cells, not an empty keep-set that selects every cell, and the
 * distinction is the caller's (`keep.length`), not this comparator's.
 */
export function categoricalMatches(cell: unknown, keep: ReadonlyArray<unknown>): boolean {
  if (!isSpellableScalar(cell)) return false
  const s = pyStr(cell)
  const n = parseBound(s)
  for (const k of keep) {
    if (!isSpellableScalar(k)) continue
    const ks = pyStr(k)
    if (ks === s) return true
    if (n !== undefined) {
      const kn = parseBound(ks)
      if (kn !== undefined && kn === n) return true
    }
  }
  return false
}

/** The obs column a criterion names, TRIMMED — the canonical spelling.
 *
 *  This builder and both script emitters have always trimmed; the keep-mask kernels
 *  (`primitives.ts::keep_mask`, `cell-filter.py::criteria_keep_mask`) looked the RAW
 *  value up in obs. So `{column:" pct_mito"}` recorded a predicate constraining
 *  `pct_mito` while the mask found no such column and applied NO constraint — the
 *  recipe claimed a filter that never ran. One spelling, everywhere.
 *
 *  ROUND-4 (R3-65 / R3-64): the trim is the SIX ASCII characters, not JS
 *  `String.prototype.trim()`. The three native trims disagree on a column NAME exactly
 *  as they do on a cell — JS strips U+FEFF, so a BOM-bearing CSV header column
 *  (`"﻿pct_mito"`, what Excel writes) was normalised to `pct_mito` HERE and left
 *  intact by `cell-filter.py`'s `str.strip()` and by Rust's `str::trim()`. The recorded
 *  predicate then named a column obs does not have while the committed mask filtered on
 *  the one it does; conversely python's `str.strip()` eats U+001C–U+001F, which neither
 *  other reader does. The six-character intersection is the only set all three agree on
 *  natively, and — unlike the lenient cell trim — keeping a name's exotic padding is the
 *  SAFE direction: every reader then looks up the same, unmodified obs key.
 *
 *  ROUND-4b (R4A-09): only a STRING is a column name. `criteria` is client-supplied
 *  JSON, so `column` can arrive as a number / array / object; this used to call
 *  `.replace` on it and throw `TypeError: raw.replace is not a function` straight out
 *  of the live `$derived` keep-mask recompute, while `cell-filter.py` looked the raw
 *  value up in `obs` (`obs.get([...])` → `TypeError: unhashable type`) and the emitter
 *  quietly answered `""`. A non-string names no obs column in any reader now. */
export function criterionColumn(c: { column?: unknown }): string {
  const raw = c?.column
  if (typeof raw !== 'string') return ''
  return raw.replace(ASCII_WS_LEAD, '').replace(ASCII_WS_TRAIL, '')
}

/** A criterion is CATEGORICAL when it says so, or — the real declarative-UI path,
 *  which never sets `control` — when it carries a non-empty `keep` set. This is the SPEC
 *  rule; `cell-filter.py::_is_categorical_criterion` and `predicate_script::is_categorical`
 *  conform to it (corpus-gated). */
export function isCategoricalCriterion(c: FilterCriterion): boolean {
  // ROUND-4b (R4A-07/R4A-08): TOTAL. A criteria list is client-supplied JSON and may
  // hold a `null` / string / number entry; `cell-filter.py` and `primitives.ts` skip
  // such an entry and apply the REST of the recipe, but this threw
  // `Cannot read properties of null (reading 'control')` — out of the live keep-mask
  // recompute and out of the parity harness.
  if (!c || typeof c !== 'object') return false
  if (c.control === 'multiselect') return true
  if (c.control === 'range') return false
  // `Array.isArray` is load-bearing, not defensive. `(c.keep ?? []).length > 0` is
  // ALSO true for a non-empty STRING, so `{column:'x', keep:'abc'}` took the
  // categorical branch here while `primitives.ts::keep_mask` (which already tested
  // `Array.isArray`) and `predicate_script::is_categorical` (which requires a JSON
  // array) took the range branch — the builder and the mask disagreeing about what
  // kind of filter the user expressed. A malformed non-array `keep` is not a
  // keep-set anywhere now.
  return Array.isArray(c.keep) && c.keep.length > 0
}

/**
 * Version of how a column's CATEGORY SET is derived — a different question from how a value is
 * COERCED, and until now an unversioned one (ITEM-36).
 *
 * `CRITERIA_COERCION_VERSION` stamps the comparison rules, so a change to them cannot land
 * without the 127-case corpus and all three readers moving with it. It says nothing about where
 * the OPTION LIST comes from, and that is a second way to change which rows a saved criterion
 * keeps: a keep-set persists BY NAME, so if the set of names on offer — or their SPELLING —
 * changes, the same saved criterion resolves to a different row set with nothing to notice it.
 *
 * That gap is not hypothetical. Serving the picker from the producer's DECLARED levels instead
 * of the observed values changes the spelling for booleans (declared `"false"`/`"true"` vs the
 * comparator's `pyStr` `"False"`/`"True"`), and adds levels that occur in ZERO rows. Both are
 * legitimate; both move the answer. Bump this when the derivation changes, so an attested replay
 * can tell that it did.
 */
export const CATEGORY_DERIVATION_VERSION = 1

/**
 * Spell one DECLARED level in the comparator's own dialect (ITEM-36).
 *
 * The producer declares a column's level set as strings. For most kinds those strings ARE the
 * comparison spelling — a categorical's levels are the values themselves, and `pyStr('T') === 'T'`.
 * A BOOLEAN is the exception, and it is a silent one: `cyto_columns.py` writes
 * `levels: ["false", "true"]` (lowercase, and for a bool that is the ONLY copy — it is stored as
 * a plain bool array, so there is no `attributes.cyto.levels` to fall back on), while the values
 * themselves decode to JS booleans that `pyStr` spells `"False"`/`"True"`.
 *
 * Offer a raw declared level and `categoricalMatches` finds nothing: `"true" !== "True"`, and the
 * numeric fallback cannot rescue it because neither side parses as a decimal. The user picks the
 * only option there is and EVERY row of that criterion disappears, with no error anywhere.
 *
 * So every declared level crosses this function before it is offered. `kind` is the producer's
 * own declaration, never inferred from the data.
 */
export function spellDeclaredLevel(level: string, kind: 'bool' | 'other'): string {
  if (kind !== 'bool') return level
  // Match the producer's own lowercase spelling, then hand back the dialect the comparator
  // uses. Anything else in a bool level set is a producer bug and is passed through unchanged
  // rather than guessed at (INV-2: absence/oddity is an error, not a default).
  if (level === 'true') return pyStr(true)
  if (level === 'false') return pyStr(false)
  return level
}
