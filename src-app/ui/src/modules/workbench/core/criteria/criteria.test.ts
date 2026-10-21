// The CRITERIA VOCABULARY tests — the coercion + spelling rules of the app's ONE
// filter encoding (`{column, control, min?, max?, keep?}[]`).
//
// PROVENANCE: ported case-for-case out of `core/dsl/criteriaPredicate.test.ts`
// (TEST-20), whose subject was a SECOND encoding of the same filter — a
// `CellSetPredicate` lift. That duplicate encoding is deleted, so every assertion
// about an EMITTED PREDICATE SHAPE (`between`/`gte`/`lte`/`and`, the derived-kind
// guard, the keep-set refusal + its diagnostics) is gone with it. The vocabulary
// those cases were really pinning is NOT gone: several rules the old file asserted
// INDIRECTLY (by inspecting an emitted predicate) are re-expressed here DIRECTLY
// against `parseBound` / `criterionColumn` / `isCategoricalCriterion`, at the same
// strength — a spelling the old file proved "records no constraint" must here prove
// `parseBound(...) === undefined`.
//
// The corpus below is SHARED with three other readers; its comments encode real
// cross-reader bug history and are kept intact.
//
// RUNNER: this package's unit runner for this file is `node --test` (see
// `package.json::test:unit:node`), NOT vitest. The old file was originally authored
// against vitest's `expect`, which made the whole file throw at import
// (`Cannot read properties of undefined (reading 'config')`) — i.e. TEST-20 never
// executed. It is `node:test` + `node:assert/strict`, and so is this one.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORY_DERIVATION_VERSION,
  CRITERIA_COERCION_VERSION,
  categoricalMatches,
  criterionColumn,
  isCategoricalCriterion,
  isSpellableScalar,
  parseBound,
  pyStr,
  spellDeclaredLevel,
} from './criteria.ts'

/**
 * The SHARED coercion corpus — mirrored case-for-case by
 * `packages/cell-filter/tests/test_cell_filter.py` (`_UNICODE_WS` /
 * `_NON_SCALAR_BOUNDS`). Four independent readers coerce the SAME
 * `{column,min,max,keep}[]`, and a spelling only one of them accepts is, by
 * construction, a recorded predicate that constrains what the committed mask did
 * not (or the reverse) — silently, at rc=0.
 */
/** Whitespace JS `String.prototype.trim()` strips and the other readers do NOT. */
const UNICODE_WS = [
  '\u00a0', // NBSP - what a spreadsheet / a CJK IME pastes
  '\u2007', // FIGURE SPACE
  '\u3000', // IDEOGRAPHIC SPACE
  '\ufeff', // ZERO WIDTH NO-BREAK SPACE (BOM)
  '\u0085', // NEXT LINE
  '\u2009', // THIN SPACE
  '\u1680', // OGHAM SPACE MARK
  '\u2028', // LINE SEPARATOR
]
/** The six ASCII whitespace characters ALL FOUR readers trim — and only these. */
const ASCII_WS = [' ', '\t', '\n', '\r', '\f', '\v']
/** Shapes that are not a bound / not a keep-set member in ANY other reader. */
const NON_SCALAR_BOUNDS = [[10], [[1]], { min: 10 }, true, false, [], {}]

describe('criteria vocabulary: bound coercion', () => {
  // RE-EXPRESSED: the old case asserted this through `criterionToPredicate`
  // (`{min:1,max:2}` becomes a `between` with `lo:1, hi:2`, and a non-finite bound
  // emits no predicate at all). The rule it was pinning is `parseBound`'s, so it is
  // asserted on `parseBound` directly — a finite numeric bound is accepted as-is, a
  // non-finite one is unbounded.
  it('accepts numeric (not just string) bounds and rejects non-finite ones', () => {
    assert.equal(parseBound(1), 1)
    assert.equal(parseBound(2), 2)
    assert.equal(parseBound(Number.NaN), undefined)
    assert.equal(parseBound(Number.POSITIVE_INFINITY), undefined)
    assert.equal(parseBound(Number.NEGATIVE_INFINITY), undefined)
  })

  // TEST-37 (parity): the ONE decimal grammar, mirrored by `cell-filter.py::
  // _bound_or_none` and `predicate_script::bound`. Every rejected spelling below is
  // one at least one of the three parsers accepts and another does not — i.e. a
  // recorded predicate constraining what the committed mask did not, or the reverse.
  it('coerces bounds with the grammar all three parsers agree on', () => {
    for (const [input, want] of [
      ['0', 0],
      ['1e3', 1000],
      [' 1 ', 1],
      ['.5', 0.5],
      ['-2.', -2],
      [10, 10],
    ] as Array<[string | number, number]>) {
      assert.equal(parseBound(input), want, `accepts ${JSON.stringify(input)}`)
    }
    for (const bad of [
      '',
      '   ',
      '.',
      '+',
      'abc',
      '0x10', // JS: 16 · Python: raises
      'inf', // Python/Rust: +inf · JS: NaN
      'Infinity', // JS: +inf (non-finite) · Python: +inf · Rust: rejects
      '1_0', // Python: 10 · JS/Rust: reject
      'nan',
      '1e',
      '1.2.3',
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      // round 2 — the SHARED corpus extension (mirrored in `test_cell_filter.py`):
      // NON-ASCII whitespace padding (F2-1) and non-scalar shapes (F2-5).
      ...UNICODE_WS.map(ws => `10${ws}`),
      ...UNICODE_WS.map(ws => `${ws}10`),
      ...NON_SCALAR_BOUNDS,
    ]) {
      assert.equal(parseBound(bad as never), undefined, `rejects ${JSON.stringify(bad)}`)
    }
  })

  // F1 (re-audit): a Unicode digit is not a digit. Python's `\\d` matches them and
  // `float()` accepts them, so a fullwidth/Arabic-Indic bound constrained the COMMITTED
  // mask while this builder omitted the criterion — silently. JS `\\d` is ASCII-only, so
  // this side was always right; the case is pinned so it stays that way.
  it('rejects a Unicode-digit bound (the ASCII grammar is the point)', () => {
    for (const spelling of ['\uff11\uff10', '\u0660.\u0665', '\ud835\udfcf', '1\u0662', '1e\u0661']) {
      assert.equal(parseBound(spelling), undefined, JSON.stringify(spelling))
    }
  })

  // F2-1 (round 2): `parseBound` trimmed with JS `String.prototype.trim()`, which
  // strips the whole Unicode `White_Space` set. `cell-filter.py::_bound_or_none`
  // strips exactly `" \t\n\r\f\v"` AND refuses a non-ascii string outright
  // (`x.isascii()`); `predicate_script::bound` `trim_matches` exactly the same six and
  // its ASCII decimal grammar refuses whatever survives. So a PASTED `max: "10 "`
  // (Min/Max are free-text widgets) PERSISTED `{lte:[{col:pct_mito},10]}` and previewed
  // 3/5 kept while the COMMITTED mask kept 5/5 and the report's `thresholds` was `[]` —
  // rc=0, zero diagnostics. Executed and confirmed by four independent auditors.
  //
  // RE-EXPRESSED tail: the old case also lifted a criterion carrying such a bound and
  // asserted it recorded NOTHING. With the lift deleted the undiluted statement of the
  // same rule is that the bound itself is `undefined` — unbounded, exactly as the two
  // twins answer — which the leading/trailing/both loop below asserts.
  it('F2-1: a NON-ASCII-padded bound is unbounded here too, never a silent `lte 10`', () => {
    for (const ws of UNICODE_WS) {
      const cp = `U+${ws.codePointAt(0)!.toString(16).padStart(4, '0')}`
      assert.equal(parseBound(`10${ws}`), undefined, `trailing ${cp}`)
      assert.equal(parseBound(`${ws}10`), undefined, `leading ${cp}`)
      assert.equal(parseBound(`${ws}10${ws}`), undefined, `both ${cp}`)
    }
    // The SIX ASCII whitespace characters are still trimmed — all four readers do.
    for (const ws of ASCII_WS) {
      assert.equal(parseBound(`${ws}10${ws}`), 10, `ascii ws ${JSON.stringify(ws)}`)
    }
    // A non-ascii character anywhere else is refused for the same reason.
    assert.equal(parseBound('1\u00a00'), undefined)
    assert.equal(parseBound('10\u20ac'), undefined)
  })

  // F2-5 (round 2): `parseBound` `String()`d ANYTHING, so `{min:[10]}` recorded
  // `gte 10` while `_bound_or_none` (type-gated: not None/bool/int/float/str ⇒ None)
  // and `predicate_script::bound` (Value::Number | Value::String only) applied NO
  // constraint; and `keep:[[1]]` passed `isNumericKeepSet` (`String([1]) === '1'`) and
  // emitted a NON-SCALAR `in` value while the mask (`str([1]) === '[1]'`) dropped every
  // cell.
  //
  // The keep-set half of the rule now lives wholly in the vocabulary: a non-scalar is
  // UNSPELLABLE and therefore matches nothing on EITHER side of `categoricalMatches`
  // (asserted case-by-case in R4A-01/R4A-02 below).
  it('F2-5: only a string or a JSON number is a bound; only scalars are keep-set members', () => {
    for (const bad of NON_SCALAR_BOUNDS) {
      assert.equal(parseBound(bad as never), undefined, `rejects ${JSON.stringify(bad)}`)
      // a bool IS a JSON scalar (spellable) but is still not a BOUND; a container is
      // neither a bound nor a keep-set member.
      if (typeof bad !== 'boolean') {
        assert.equal(isSpellableScalar(bad), false, `unspellable ${JSON.stringify(bad)}`)
        assert.equal(categoricalMatches(1, [bad as never]), false, `keep ${JSON.stringify(bad)}`)
      }
    }
  })
})

describe('criteria vocabulary: the ONE column trim', () => {
  // TEST-42: ONE column spelling. The builder + both emitters trimmed; the keep-mask
  // kernels looked the RAW value up in obs, so `" pct_mito"` recorded a predicate on
  // `pct_mito` that the mask never applied.
  it('normalises the column name the same way the mask now does', () => {
    assert.equal(criterionColumn({ column: '  pct_mito ' }), 'pct_mito')
    assert.equal(criterionColumn({ column: '   ' }), '')
    assert.equal(criterionColumn({}), '')
    // RE-EXPRESSED: the old case closed by lifting `{column:' pct_mito', max:'10'}` and
    // asserting the emitted node named the TRIMMED `pct_mito`. The rule is this trim.
    assert.equal(criterionColumn({ column: ' pct_mito' }), 'pct_mito')
  })

  it('R3-65: `criterionColumn` trims the SIX ASCII characters, not the JS trim set', () => {
    // JS `trim()` strips U+FEFF, which neither python's `str.strip()` nor Rust's
    // `str::trim()` does — so a BOM-bearing CSV header column (what Excel writes) was
    // normalised HERE and left intact by the other two readers: the recorded predicate
    // named a column obs does not have while the committed mask filtered the one it does.
    // The six-character intersection is the only set all three agree on natively.
    assert.equal(criterionColumn({ column: '  pct_mito\t\n' }), 'pct_mito')
    assert.equal(criterionColumn({ column: '\ufeffpct_mito' }), '\ufeffpct_mito')
    assert.equal(criterionColumn({ column: '\u0085pct_mito' }), '\u0085pct_mito')
    assert.equal(criterionColumn({ column: '\u001cpct_mito' }), '\u001cpct_mito')
    assert.equal(criterionColumn({ column: '\u00a0pct_mito' }), '\u00a0pct_mito')
    assert.equal(criterionColumn({ column: undefined }), '')
  })
})

// ── ROUND-4: `pyStr` really is python's `str()`. It was a divergence that flipped a
//    mask to its exact COMPLEMENT.
describe('criteria vocabulary: python spellings + categorical membership', () => {
  // F2 (re-audit): one spelling, and a dtype-independent numeric fallback.
  it('spells values the way python str() does, and matches numerically when both sides are numeric', () => {
    assert.equal(pyStr(true), 'True')
    assert.equal(pyStr(false), 'False')
    assert.equal(pyStr(null), 'None')
    assert.equal(pyStr(1.5), '1.5')
    // the COMMITTED mask compares `str(x)`; JS `String()` said 'true'/'null'
    assert.equal(categoricalMatches(true, ['True']), true)
    assert.equal(categoricalMatches(true, ['true']), false)
    assert.equal(categoricalMatches(null, ['None']), true)
    // dtype-independence: a float column's 1 is '1.0' in python, '1' here
    assert.equal(categoricalMatches(1, ['1.0']), true)
    assert.equal(categoricalMatches(1.0, ['1']), true)
    assert.equal(categoricalMatches('B', ['T', 'NK']), false)
  })

  it('R3-110: a NON-FINITE number spells itself as python does, not as JS does', () => {
    // `String(Infinity)` is `'Infinity'` and `String(NaN)` is `'NaN'`; python says
    // `'inf'` / `'-inf'` / `'nan'`. A non-finite obs cell is entirely ordinary in a QC
    // metric column, so a keep-set naming one selected the exact INVERSE set in the
    // preview from the set the kernel and the attested replay selected — and the numeric
    // fallback cannot rescue it, because `'inf'` is deliberately outside the grammar.
    assert.equal(pyStr(Number.POSITIVE_INFINITY), 'inf')
    assert.equal(pyStr(Number.NEGATIVE_INFINITY), '-inf')
    assert.equal(pyStr(Number.NaN), 'nan')
    assert.equal(categoricalMatches(Number.POSITIVE_INFINITY, ['inf']), true)
    assert.equal(categoricalMatches(Number.NEGATIVE_INFINITY, ['-inf']), true)
    assert.equal(categoricalMatches(Number.NaN, ['nan']), true)
    assert.equal(categoricalMatches(1, ['inf']), false)
  })

  it('R4A-01/R4A-02: a NON-SCALAR is UNSPELLABLE — it matches nothing, on either side', () => {
    // R3-111 (round 4) tried to REPRODUCE python's container spellings here. That was an
    // over-correction and it cannot work: JS has no int/float distinction, so `[1]` and
    // `[1.0]` are the SAME value while python spells them `'[1]'` and `'[1.0]'`. Meanwhile
    // the Rust emitter spelled the same value as serde JSON (`[1,2]` with no space,
    // `["a"]` with double quotes, `[true]`, object keys SORTED). Three implementations
    // racing to match CPython's repr, each losing differently. A container is REFUSED
    // instead: it has no spelling, and it matches nothing wherever it appears.
    assert.equal(isSpellableScalar([1]), false)
    assert.equal(isSpellableScalar({ a: 1 }), false)
    for (const scalar of [1, 1.5, 'T', true, false, null, undefined]) {
      assert.equal(isSpellableScalar(scalar), true, String(scalar))
    }
    // a container CELL matches nothing — not a scalar keep value, and not even a keep
    // value that is LITERALLY python's spelling of it.
    assert.equal(categoricalMatches([1], ['1']), false)
    assert.equal(categoricalMatches([1], ['[1]']), false)
    assert.equal(categoricalMatches([1, 2], ['[1, 2]']), false)
    assert.equal(categoricalMatches({ a: 1 }, ["{'a': 1}"]), false)
    // …and a container KEEP value matches nothing, without poisoning its scalar peers.
    assert.equal(categoricalMatches(1, [[1] as never]), false)
    assert.equal(categoricalMatches('T', [[1] as never, 'T']), true)
    assert.equal(categoricalMatches('B', [[1] as never, 'T']), false)
    // The R4A-02 case that proves the round-4 branch was unwinnable.
    assert.equal(categoricalMatches([1.0], ['[1.0]']), false)
    assert.equal(categoricalMatches([1], ['[1.0]']), false)
  })

  it('the spellings that already agreed are unchanged', () => {
    assert.equal(pyStr(true), 'True')
    assert.equal(pyStr(false), 'False')
    assert.equal(pyStr(null), 'None')
    assert.equal(pyStr(undefined), 'None')
    assert.equal(pyStr(1), '1')
    assert.equal(pyStr(1.5), '1.5')
    assert.equal(pyStr('T'), 'T')
  })

  // C1 (the KEEP-PATH half, kept executable). obs `leiden` = [NBSP-padded "1", "2"] —
  // what a spreadsheet / CJK-IME paste yields. `parseBound` refuses a non-ascii string,
  // so there is NO numeric fallback and `pyStr(cell) !== '1'`: neither cell matches.
  // (The other half of the old case evaluated the deleted predicate AST's numeric `in`
  // node, which selected cell 0 — the divergence that killed the keep-set lift. There
  // is no second encoding left to diverge from; the strictness THIS side must keep is
  // what is asserted.)
  it('C1: a NON-ASCII cell gets no numeric fallback — it matches nothing', () => {
    const cells = ['\u00a01', '2']
    assert.deepEqual(
      cells.map(v => categoricalMatches(v, ['1'])),
      [false, false],
    )
  })
})

describe('criteria vocabulary: what counts as a categorical criterion (totality)', () => {
  // The real declarative-UI path never sets `control`, so the categorical branch is
  // INFERRED from a non-empty `keep`; mirrors `cell-filter.py::
  // _is_categorical_criterion` exactly. The old file asserted this inline, as the first
  // line of the keep-set lift-refusal case — the refusal is deleted, the inference is
  // not, so it is asserted on its own here.
  it('infers the categorical branch from a non-empty keep set', () => {
    assert.equal(isCategoricalCriterion({ column: 'cell_type', control: '', keep: ['T'] }), true)
    assert.equal(isCategoricalCriterion({ column: 'cell_type', keep: ['T', 'NK'] }), true)
    assert.equal(isCategoricalCriterion({ column: 'cell_type', keep: [] }), false)
    assert.equal(isCategoricalCriterion({ column: 'pct_mito', control: 'range', max: '10' }), false)
    // an explicit `control` wins over the shape, in both directions.
    assert.equal(isCategoricalCriterion({ column: 'x', control: 'multiselect' }), true)
    assert.equal(isCategoricalCriterion({ column: 'x', control: 'range', keep: ['T'] }), false)
  })

  // TEST-38: a non-array `keep` is NOT a keep-set. `(c.keep ?? []).length > 0` is also
  // true for the STRING "abc", so this builder took the categorical branch while
  // `primitives.ts::keep_mask` (Array.isArray) and `predicate_script::is_categorical`
  // (JSON array) took the range branch — disagreeing about what the user expressed.
  it('treats a non-array keep as no keep-set at all', () => {
    assert.equal(isCategoricalCriterion({ column: 'x', keep: 'abc' as never }), false)
    assert.equal(isCategoricalCriterion({ column: 'x', keep: ['a'] }), true)
  })

  // F4 (re-audit): an EXPLICIT `control:'multiselect'` with a non-array `keep` used to
  // throw `(...).filter is not a function` out of BOTH the derived recompute and the
  // save guard. `isCategoricalCriterion` only tested `Array.isArray` on the INFERRED
  // path — and it still does, because an explicit `multiselect` is categorical whatever
  // `keep` holds. So the surviving rule is that ASKING is TOTAL: the predicate answers
  // instead of throwing, and the `Array.isArray` guard belongs to whichever consumer
  // iterates `keep` (the old consumer was the deleted lift).
  it('does not throw on an explicit multiselect whose keep is not an array', () => {
    const c = { column: 'leiden', control: 'multiselect', keep: '12' as never }
    assert.doesNotThrow(() => isCategoricalCriterion(c))
    assert.equal(isCategoricalCriterion(c), true)
  })

  it('R4A-07/R4A-09: a malformed criteria ENTRY or column is skipped, never thrown on', () => {
    // A criteria list is client-supplied JSON. `cell-filter.py` and `primitives.ts` skip
    // an unreadable entry and apply the REST of the recipe; these used to throw
    // (`Cannot read properties of null (reading 'control')`, `raw.replace is not a
    // function`) out of the live `$derived` keep-mask recompute.
    assert.equal(isCategoricalCriterion(null as never), false)
    assert.equal(isCategoricalCriterion('nope' as never), false)
    assert.equal(isCategoricalCriterion(5 as never), false)
    assert.equal(isCategoricalCriterion(undefined as never), false)
    for (const column of [5, null, ['q'], { a: 1 }, undefined]) {
      assert.equal(criterionColumn({ column } as never), '')
    }
  })
})

// ── TEST-47 [ITEM-36] — the declared-level spelling bridge ──────────────────────────────
//
// The divergence this closes is silent and TOTAL: a keep-set saved against a boolean column
// resolves to ZERO rows if the option was spelled the producer's way. It is not a rounding
// difference at the edge of a filter — it is the whole criterion, gone, with a clean console.
describe('spellDeclaredLevel — declared levels enter the comparator dialect (ITEM-36)', () => {
  it('bridges a BOOL level from the producer spelling to the comparator spelling', () => {
    // `cyto_columns.py:225` writes lowercase; `pyStr` spells a JS boolean capitalised.
    assert.equal(spellDeclaredLevel('true', 'bool'), 'True')
    assert.equal(spellDeclaredLevel('false', 'bool'), 'False')
  })

  it('THE BUG IT EXISTS FOR: the RAW declared level matches nothing', () => {
    // Stated as an executable fact rather than a comment, so the bridge cannot later be
    // removed as redundant. Both halves matter — raw fails, bridged succeeds, same value.
    assert.equal(categoricalMatches(true, ['true']), false)
    assert.equal(categoricalMatches(true, [spellDeclaredLevel('true', 'bool')]), true)
    assert.equal(categoricalMatches(false, ['false']), false)
    assert.equal(categoricalMatches(false, [spellDeclaredLevel('false', 'bool')]), true)
  })

  it('leaves a NON-bool level untouched — a categorical\'s levels are already the values', () => {
    assert.equal(spellDeclaredLevel('T', 'other'), 'T')
    // A string column may legitimately hold the literal "true"; bridging it would be wrong.
    assert.equal(spellDeclaredLevel('true', 'other'), 'true')
  })

  it('passes an unexpected bool level through rather than guessing', () => {
    // A bool level set that is not {"true","false"} is a producer bug. Guessing invents a
    // mapping; passing through makes the mismatch visible where it happens (INV-2).
    assert.equal(spellDeclaredLevel('TRUE', 'bool'), 'TRUE')
    assert.equal(spellDeclaredLevel('', 'bool'), '')
  })

  it('the DERIVATION version is stamped separately from the COERCION version', () => {
    // Two independent ways to change a saved criterion's answer, so two stamps. The 127-case
    // coercion corpus pins the comparison rules and is blind to where the options came from.
    assert.ok(CATEGORY_DERIVATION_VERSION > 0)
    assert.equal(typeof CRITERIA_COERCION_VERSION, 'number')
  })
})
