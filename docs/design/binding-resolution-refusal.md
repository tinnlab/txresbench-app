# Binding resolution refuses; it does not guess

**Status.** Design. Written because there was none: the first-of-N binding family has
produced four owner-reported defects, each was fixed AT ITS INSTANCE, and the rule that
would have prevented all four was never written down. This doc states the rule, the
enumeration it applies to, and what is deliberately left alone.

---

## The rule

> **A resolver may not take `[0]`.**
>
> Either exactly one candidate matches, or the resolution is an explicit refusal the
> caller must handle — and the user must be able to see why.

A corollary, because it is the shape that hides best:

> **A hardcoded column literal in a resolver is a claim about the data that no
> contributor made.**

`?? 'group'`, `?? 'qcA'`, `?? 'primary'`, `?? 'effect'` are not fallbacks. They are the
in-package fixtures' vocabulary asserted over a host's data. They look right for exactly
as long as the fixtures are the only input.

## Why "sole candidate" is the well-behaved minority

`length === 1` is not a choice at all, and the tree already ships a declared opt-in for
it (`auto_bind_sole_candidate`, `ArtifactRefWidget.autoBindVerdict`,
`inputEconomy.autoPickSoleArtifacts`, `hostCtx.resolveInputs`). Those are correct and
are not this family.

The volume is a **weaker predicate nobody named**:

```
name-match  →  Nth-of-catalog-order  →  a hardcoded column literal
```

Each step is a further retreat from evidence, and the last step invents one. The middle
step is the worst of the three because it produces a *plausible* answer: catalog order is
real, stable, and meaningless.

## The standard already exists in this tree — copy it

Two sites do this correctly and are the precedent, not a thing to invent around:

- **`extensions/data/contract.ts`** — `AxisResolution` returns **`ambiguous` as a distinct
  status no fallback may absorb**, alongside `undeclared` / `absent` / `resolved`. Its own
  doc states why: `undefined` conflated two situations licensing OPPOSITE caller behaviour,
  "and every consumer that collapsed them wrote the same bug: `axisByLabel(…) ?? <some
  other axis>`."
- **`core/runtime/producerTargets.ts`** — **refuses to narrow to one**, and names
  *"only one match, selected automatically"* as the mistake it exists to avoid. "Zero, one
  and several are three different renderings."

So the shape is settled: a **discriminated resolution**, and three renderings.

## INV — the non-negotiables

- **INV-1**: A resolver may not take `[0]`. Either exactly one candidate matches, or the
  resolution is an explicit refusal the caller must handle.
- **INV-2**: A hardcoded column literal in a resolver is a claim about the data that no
  contributor made. A resolver may not name a column the data did not.
- **INV-3**: A refusal the user cannot see is indistinguishable from a guess. Every refusal
  reaching a rendered surface must say WHICH binding is unresolved and WHY, naming the
  candidates.
- **INV-4**: `''` is load-bearing. It is viz's in-band "bind no column". An ABSENT channel
  is how a series says "never mentioned"; an EMPTY channel is how it says "deliberately
  nothing". A resolver may not normalise either into the other.
- **INV-5**: A refusal that never resolves is indistinguishable from no refusal. Gate on a
  resolved FACT, not on the absence of a value.

INV-4 and INV-5 are the two constraints this tree has already paid for. INV-4 is the bug
behind *"the violin shows many groups before I choose anything"* (`4e49c9b0`): `stripEmptyEncode`
deleted the empty channel, an absent channel is refilled from the catalog, and "explicitly
unset" became inexpressible. INV-5 is why a guard must not be written as `if (!value)` — for
a bare caret, for an empty string, for a zero-length span, that test is *vacuous, not merely
weak*.

## What the four defects share

| defect | mechanism | fixed where | class left intact |
|---|---|---|---|
| all-black canvas | `DEFAULT_COLOR_BY.key = 'group'` → the frame source answers an unknown key with ONE synthetic ungrouped category → it takes palette slot 0 → Okabe-Ito slot 0 is `[0,0,0]` | `useGridData.pullOwnedData` got a catalog-membership guard (`9e3c6c93`) | **`DatasetStore.ensureBuffers` — the multi-dataset sibling — did not.** Same call, no guard. |
| ENSEMBL-index bind | a per-row identifier column is first in catalog order and is bound as the grouping | the CANVAS catalog learned to filter identifiers (`isIdentifierColumn`) | `resolveBinding` still takes `categoricalColumns[ordinal]` from whatever a catalog offers |
| violin→histogram column swap | violin's value channel is `source:'value'`, histogram's is `'continuous'`; nothing carries, and the way back re-resolved `valueColumns[0]` — the counts column, 0–50K | the ROUND TRIP is now lossless via a per-vocabulary memo (`1aa80af8`) | the ONE-WAY hop still opens on `continuousColumns[0]`; `GridWorkspace.store.ts` documents this as a KNOWN RESIDUAL and names the render path as "the honest home for it" |
| synthetic "All" group | an absent grouping channel is refilled from the catalog, so a chart groups by whatever is first | `''` is preserved as the explicit unset (`4e49c9b0`) | an ABSENT channel is still refilled by ordinal |

Four instance fixes. The predicate that produced all four is untouched. That is the thing
this design changes.

## The mechanism

`resolveBinding` returns `string | readonly string[]` — a type in which *refusal is not
expressible*, so a guess is the only thing it can say. It becomes total over a
discriminated union:

```ts
export type BindingResolution =
  | { status: 'bound'; column: string }              // an id-match, or the SOLE candidate
  | { status: 'bound-list'; columns: readonly string[] }
  | { status: 'unbound' }                            // INV-4: the in-band "bind nothing"
  | { status: 'absent'; source: BindingSource }      // no candidate of this kind at all
  | { status: 'ambiguous'; source: BindingSource; candidates: readonly string[] }
```

- **id-match first** (unchanged) — an exact match is evidence, not a guess.
- **sole candidate** — `length === 1` binds. That is the declared opt-in this tree already
  ships, and it is what keeps every single-column fixture byte-identical.
- **≥2 candidates** → `ambiguous`. No ordinal. No literal.
- **0 candidates** → `absent`. No literal.
- **explicitly empty** → `unbound`, preserved verbatim (INV-4).

`ResolvedBindings` keeps its shape and carries only BOUND channels, so every reader
downstream is unchanged; the resolutions ride ALONGSIDE on the model, so the render seam
can say what it refused. A channel that refused is ABSENT from `bindings` — never `''`,
which already means something else.

### The user-visible half (INV-3)

`CellView.ChartBody` is the seam. A chart cell whose REQUIRED channel refused renders a
message naming the channel and the candidates — the sibling of the `Unsupported` and
`ChartEmpty` surfaces that already exist there — instead of a chart confidently painted
from a guess. An OPTIONAL channel that refuses simply stays unbound (that is what
"ungrouped" means, and it is already the honest answer).

### The parse-time exemption

`parse.ts::validateBindings` deliberately EXEMPTS catalog-default bindings from validation,
because `resolveBinding` "falls back to a conventional `'group'`/`'qcA'` NAME when the
dataset lacks that column kind" and "that fallback name is expected to be absent."

The exemption exists to protect the invented literal. Once no literal is invented, a
catalog-default binding is either a real column or not a binding at all — so the exemption's
subject no longer exists. **But it is narrowed, not deleted**: a refused channel is still
skipped, because it names no column to validate. Deleting the skip outright would turn a
silent guess into a hard parse crash on every shipped chart whose catalog cannot serve a
channel — which is a worse defect than the one being fixed.

## Proving the class, not the instances

A test per site is N tests that each let the N+1th through. Three mechanisms, in order of
strength:

1. **Type-level (unbounded).** `BindingResolution` makes a guess *inexpressible* in the
   resolver's return type. A new caller must handle refusal to compile.
2. **Registry-derived property test.** For EVERY chart type in the registry × every channel
   in its schema, against a catalog with ≥2 candidates of that channel's source and no
   id-match: the resolution must NOT be `bound`. The enumeration is DERIVED from the
   registry, so a chart type added tomorrow is covered with no edit — which is exactly the
   property "a test per site" lacks.
3. **Lint ratchet.** `lint-positional-declaration.mjs` already forbids `<declared-field>[N]`
   — and `libs/viz` is an explicit carve-out from its scan set, which is why the epicenter
   was invisible to it. The carve-out is closed and the CATALOG collections
   (`categoricalColumns` / `continuousColumns` / `valueColumns` / `layouts` / `datasets`)
   join the field set, so a NEW positional pick has to be argued into the baseline.

## Deliberately NOT changed (with the argument)

- **`canvasHostProvider.ts:124` — the project-wide `cat.layouts[0]`.** Already reported
  in-source as a known INV-3 violation with a stated ruling: DEC-15 rules this exact shape
  **declare-and-MIGRATE, not declare-and-break**, and the blocker is named — one shipped
  analysis' scatter has no coordinate picker to declare from. Ending it here breaks a
  shipping surface. It is a UI migration, not a resolver change.
- **`axisEntries.ts:168` — `matches[0]` after a `distinct.size === 1` guard.** The guard is
  on content HASHES, not artifact ROWS, so two rows sharing one hash reach `matches[0]`.
  But an axis IS its key artifact and its identity IS that content hash, so the two rows are
  byte-identical: the READ is correct either way. What is wrong is that the chosen `artifact`
  id is a picker KEY and a stored-choice target, and it is non-deterministic across catalog
  reads. The fix is determinism (and saying so), not refusal — refusing would break a working
  surface for no data-correctness gain.
- **`model.ts` `valueList` `slice(0, limit)`.** A `valueList` channel is inherently
  multi-valued and the cap is a render budget, not an identity claim. It is not made to
  refuse; it is made to REPORT the truncation so a caller can say "showing 6 of 40" rather
  than silently implying 6 is all there is.
