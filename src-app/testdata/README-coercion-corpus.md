# The criteria-coercion parity corpus

`criteria-coercion-corpus.json` is the shared, executable ground truth for **one
question**: given the same `{column, min, max, keep}[]` criteria and the same obs, do
all three readers of a criteria filter produce the **same keep-mask, cell for cell**?

That question is the feature's whole promise. A filter Run records its criteria + a
replay script whose sha256 is offered to the user as "replaying this reproduces the cell
set that was committed". If any two readers coerce a value differently, that claim is
false — silently, at exit 0, with no diagnostic anywhere.

## The three readers

| # | Reader | What it decides | Gated by |
|---|---|---|---|
| 1 | `server/src/modules/provenance/criteria_script.rs::CRITERIA_PRELUDE` (`_num`, `_decimal`, `_keep_in`) | the emitted **replay script**, whose sha256 is the attested reproducibility claim | `cargo test --lib provenance::criteria_script` (`…the_emitted_replay_matches_the_shared_coercion_corpus`) |
| 2 | `packages/cell-filter/compute/cell-filter.py::criteria_keep_mask` (`_value_float`, `_bound_or_none`) | the **committed** mask | `just check-py` (`cell-filter/tests/test_coercion_corpus.py`), in **both** obs dtype flavours |
| 3 | `ui/src/modules/workbench/core/runtime/primitives.ts::keep_mask` (`core/criteria/criteria.ts::parseValue`) | the **live preview** the user tunes against | `npm run check` |

`just check-coercion` (→ `node scripts/coercion-parity.mjs`) runs **all three in one
pass** and diffs them. Each language also gates its own reader so a regression fails the
cheap local gate without the cross-language runner.

### There was a FOURTH reader, and it is retired (ITEM-4)

Reader 4 was the TS **DSL builder** (`core/dsl/criteriaPredicate.ts::criteriaToPredicate`,
evaluated through `dsl/eval.ts`) — the **recorded predicate** a saved filter run stored.
It was a *second encoding* of the very filter this corpus pins, and keeping the two in
agreement is most of why the gate was built. That encoding is deleted: `criteria` is the
single encoding, the compute kernel reads it, and one encoding cannot disagree with
itself. So reader 4 has no subject and is gone.

**This costs the gate no cell-coercion coverage.** Reader 4 was never independent of
reader 3 for cells (round 6 / B6): `scripts/coercion-parity-ts.mjs` built its evaluation
ctx with reader 3's own `parseValue`, so a change to a cell rule moved both channels
identically and reader 4's mask comparisons could never contradict reader 3 about a cell.
The cell rule's genuinely independent checks are readers 1 and 2 — two separate python
implementations — plus `scripts/coercion-parity-ws-check.mjs`, all of which survive.

Readers 1–3 are all **MASK readers**: each produces a keep-mask for *every* case, so "they
agree cell-for-cell" is now earned on all of them with no per-case coverage caveat, and
the runner's headline says exactly that.

Two per-case fields are **vestigial** and no longer read by anything: `dslLifts` and
`dslEvalError` / `dslWhy`, which declared reader 4's liftability. They are left in place
rather than stripped from all 127 cases in the same change that retired the reader; they
assert nothing and should be removed in a follow-up.

### The corpus' size is pinned in BOTH directions (round 6 / B2)

`criteria_script.rs::CORPUS_CASE_IDS` lists the **exact** case-id set (mirroring the
capsule manifest's `ALWAYS_MEMBERS` + undeclared-member allow-list), so deleting a case is
as red as adding an undeclared one; `test_coercion_corpus.py` pins the exact count as a
cheap local twin. The `>= 80` floor it replaced let a case be
DELETED to hide a divergence — proven by deleting `H16` while reintroducing the real
`_cat_hit` container defect it guards: the gate printed "the 3 MASK readers agree
cell-for-cell on all 122" and exited 0.

## The ONE coercion rule the corpus encodes

**A BOUND** (`min` / `max`, and each member of a `keep` set considered numerically) is
AUTHORED text and is held strictly:

* a JSON number → itself if finite; a `bool` is **not** a bound
* a string → must be pure ASCII; strip **exactly the six** characters
  `" \t\n\r\f\v"`; then match `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`
  (ASCII-only) → `float`
* anything else (an array, an object, `null`, an empty string, `0x10`, `1_0`, `inf`,
  `nan`, non-ASCII digits) → **unbounded**, never an error

**A CELL** is DATA and is held leniently on whitespace, strictly on grammar:

* `None`/`null`/`undefined` → NA (fails every bound)
* a `bool` → `1.0` / `0.0` — the answer numpy's `astype(float)` fast path gives, so the
  mask cannot depend on a storage dtype the recipe has no way to see
* a real number → itself; non-finite → NA when anything is bounded
* a string → strip the **enumerated** whitespace set (Unicode `White_Space` ∪
  `U+001C–U+001F` ∪ `U+FEFF`), then the SAME plain-ASCII-decimal grammar → `float`
* anything else (an array, an object) → NA

**A COLUMN NAME** is trimmed of **exactly the six ASCII** characters — the only set all
three languages agree on natively — so every reader looks up the identical obs key.

**A KEEP-SET** is matched on python's `str()` spelling first (`True`/`False`/`None`/
`inf`/`-inf`/`nan`), then a numeric fallback when both sides are plain decimals — which
is what makes the answer independent of whether a column spells its `1` as `"1"` or
`"1.0"`.

A **non-scalar** value — an array or an object, on **either** side of that comparison —
is **UNSPELLABLE and matches nothing** (round 4b, R4A-01 / R4A-02). It is a refusal, not
a missing feature: no two readers spell a container alike, and the difference is not
closable.

| value | serde_json (reader 1) | python `str()` (readers 1-runtime/2) | JS |
|---|---|---|---|
| `[1,2]` | `[1,2]` | `[1, 2]` | — |
| `["a"]` | `["a"]` | `['a']` | — |
| `[true]` | `[true]` | `[True]` | — |
| `{"b":1,"a":2}` | `{"a":2,"b":1}` (keys **sorted**) | `{'b': 1, 'a': 2}` | — |
| `[1.0]` | `[1.0]` | `[1.0]` | **cannot spell it** — JS has no int/float distinction, so `[1]` and `[1.0]` are one value |

The last row is why "reproduce CPython's `repr` everywhere" is unwinnable and why round
4's attempt to do so in `pyStr` made the live preview show the *complement* of the
committed mask for any numeric member. A keep-set whose members are **all** unspellable
still **constrains** — it selects zero cells; that is not the same as an *empty* keep-set,
which imposes no constraint at all.

**A CRITERIA LIST ENTRY** that is not an object, and a `column` that is not a string,
impose **no constraint** in every reader (they are skipped; the rest of the recipe still
applies).

### Why the asymmetry between a bound and a cell is deliberate

A padded bound must be **unbounded** in every reader (a bound the user cannot see is
worse than no bound). A padded cell must stay **numeric** in every reader (dropping real
measurements because a spreadsheet left a NBSP on them loses data). Both rules are
uniform across all readers, which is the invariant that matters; the asymmetry
itself is not a divergence.

## Encoding

Cases are plain JSON. Three values JSON cannot carry are escaped:

```json
{"$special": "inf"}   {"$special": "-inf"}   {"$special": "nan"}
```

Every reader's harness decodes them. The Rust harness additionally renders the replay
`ctx` as text (`corpus_py_json`) rather than through `serde_json`, because `serde_json`
spells `f64::INFINITY` as `null` while python's `json.load` accepts the `Infinity` /
`NaN` literals — a non-finite obs cell is entirely ordinary in a QC metric column and
must be expressible.

## Case groups

| prefix | what it varies |
|---|---|
| `A*` | the BOUND spelling (grammar, padding, hex/underscore/inf, non-scalars) |
| `B*` | the CELL spelling (numeric string forms) |
| `C*` | CELL whitespace padding — one case per contested codepoint |
| `D*` | non-ASCII decimal digits (fullwidth / Arabic-Indic / Devanagari) |
| `E*` | `null` / empty / non-finite / non-scalar cells, half-bounded ranges |
| `F*` | boolean columns (the dtype-dependence class) |
| `G*` | keep-sets and dtype independence |
| `H*` | keep-sets and python's `str()` spelling |
| `I*` | composition: AND, criterion order, absent columns, explicit `control` |
| `J*` | column-NAME trim sets, keep-set widening, absent-column-with-keep-set |
| `K*` | the criteria LIST's own shape: empty list, non-object entries, non-string `column` |
| `L*` | RAGGED obs columns — the short-mask tail-pad contract |

`H10`–`H19` are the round-4b **non-scalar** axis: containers with multi-element, string,
bool, null, float and object members; object key ORDER; a container CELL vs a keep value
that is literally its python spelling; a mixed scalar+container keep-set; and the
constrains-but-matches-nothing case that separates "unspellable keep-set" from "empty
keep-set".

## Adding a case

Add it to the JSON and run `just check-coercion`. `expect` is the **specification's**
answer, derived from the rule above — **not** whatever the readers happen to say. If a
reader disagrees, that reader is the defect. If a divergence is genuinely irreconcilable
(a shape one reader's transport cannot carry), say so in the case's `why` and restrict
the readers explicitly — never drop the case.

## Provenance

Round 3 of the `filter-provenance` lifecycle ran an ad-hoc 80-case version of this by
hand, found **12 disagreements**, and committed neither the corpus nor a runner. Round 4
made it permanent: 106 cases, 12 divergences on the first run, 0 after the fixes
(R3-63, R3-64, R3-65, R3-79, R3-108, R3-109, R3-110, R3-111, R3-131).

Round 6 audited the round-5 gate itself and found it blind in five places, each proven by
a mutation the gate answered rc 0 to: the keep path had **no** padded-cell case (trimming
the cell inside `categoricalMatches` was invisible → `G08`/`G09`); the corpus could be
**shrunk** to hide a divergence (→ `CORPUS_CASE_IDS`); the six-ASCII bound/column trim was
mirrored in **six** places with zero cross-check and `A05` omitted `U+000B` *and* had a
vacuous min bound (→ the ws-check's second half, `A05`/`J05`); the kernel's only
`np.isfinite` drop was unreachable from a two-sided case (→ `E10`); and the short-mask
tail-pad contract had no case at all (→ `L00`). **127 cases.**

Round 4b audited round 4's own fix and found three HIGH defects in it — the emitter and
the preview each spelling a container differently from the kernel (R4A-01 / R4A-02, the
"reproduce CPython's repr" over-correction, now a refusal) and reader 4's channel being
an expression reader 3 already evaluated (R4A-03). It also closed the criteria-list-shape
holes (R4A-07 / R4A-09) and the harness's own crash on a `null` entry (R4A-08). **123
cases**; a fresh non-scalar / list-shape sweep found 4 more divergences (the emitter's
serde spelling, the preview's float spelling, the emitter refusing a whole recipe over one
malformed entry, and the kernel raising `TypeError: unhashable type: 'list'` on an array
`column`), all fixed.

> Historically not to be confused with `server/tests/predicate/corpus/*.json`, the **DSL
> predicate evaluator's** TS↔Rust parity corpus — a different corpus for a different
> question. That one was deleted with the DSL (ITEM-4); this one pins the surviving
> `criteria` encoding and stays.
