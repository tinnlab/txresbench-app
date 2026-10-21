# Required means required — validation in the declarative form

**Status:** implemented. Three places differ from the first draft, each argued where it
sits:

- §4, **CORRECTED** — `noInputAlert` is deleted, not kept. It tested selection state while
  asserting a fact about the environment, and a user reported the consequence.
- §5's cellranger row, **CORRECTED** — `required` as well as `number`, because an empty value
  is deliberately not a `number` violation.
- §1/R8 + §2/DEC-2, **ADDED** on a user decision — a sixth constraint, `not_in`: a name must
  not collide with what already exists on the axis the run writes to.

## Why

A declarative form has exactly one gate today: a hand-written boolean string on the Run
button (`ButtonWidget.disabledWhen`), evaluated by `evalWhen`
(`src-app/ui/src/modules/workbench/core/runtime/expr.ts`). There is no notion of a required
field, no per-input constraint, and no per-input feedback of any kind. The vocabulary
(`core/spec/vocabulary.ts`, `core/manifest/viewSpec.ts`) has no word for any of it.

So every processor author must, for every form, re-derive one correct predicate over the
whole form, in a string DSL, and the user learns nothing until the button they are looking
for is grey with no explanation — or, worse, until a sandbox run exits non-zero minutes
later.

That approach has already failed three times, and the third is still live.

### Failure 1 — the gate could not express the requirement, and said nothing (`be64379f`)

QC needs three things: a matrix, at least one metric row, and one gene-name column per
matrix. Writing that needs `||` and `<`. `evalWhen` had neither, and the failure was
**silent rather than loud**: the `==` branch matched the first comparison and swallowed the
rest as a bare-word right-hand side, so `a == 1 && b == 2` evaluated as `a == "1 && b ==
2"` — a gate that reads correctly and never fires. QC launched jobs the kernel refused with
`the gene_names slot has 0 binding(s) for 1 matrix input(s)`.

`be64379f` extended the grammar (quote-aware top-level `&&`/`||`, the relational operators,
NaN comparing false). The gate now works. The **shape** did not change: it is still one
author writing one predicate over the whole form by hand.

The same commit records the second-order damage: the conformance tier was *certifying* the
defect. It asserted Run is enabled at one-candidate-per-source, which for an ambiguous
picker means "launchable with a required input missing". It now completes the pickers first,
so the claim is that a **completed** form is launchable.

### Failure 2 — before that, the gate did not exist at all

`c6a2e01a` (the parent of `be64379f`) shipped `disabledWhen: "$state.matrices.length == 0"`
and nothing else, so a user who deleted every metric row could Run and get a job that emits
no columns. Earlier still, `qc.yaml` had no `disabledWhen`: the Run button was live and
`hostCtx.runProcessor` threw `found ${options.length}` from inside the launch. Its own
comment still records this — *"This is the honest version of the old behaviour, where the
Run button was live and threw."*

Each fix added one clause to one string. That is the pattern this document is trying to end.

### Failure 3 — the current QC gate is wrong today, and three more requirements have no gate at all

Read against the kernels, the shipped forms still admit runs the compute refuses:

1. **`$state.geneNames.length < $state.matrices.length` does not mean "every matrix is
   paired."** `qc.setGeneNames` writes `set: { "geneNames.{$params.index}": … }`, and
   `setIn` (`core/runtime/store.ts:232`) assigns by index into a cloned array. Answering
   only the *third* picker gives `geneNames.length === 3` with holes at 0 and 1 — the gate
   reads `3 < 3` = false, Run enables, and matrices 0 and 1 reach the kernel unpaired.
   Nothing preselects for the user on a real dataset (the picker pre-selects only at exactly
   one candidate), so the order of answering is the user's. *Derived by reading `setIn` +
   `evalWhen`'s relational branch; not executed.*
2. **`qc.addMetric` seeds `{ id:"", name:"", pattern:"", aggregation: percentage }`.** The
   compute raises `MissingGenePattern` on an absent/empty pattern — **fatal**, deliberately
   (`qc-10x.py`: *"the empty regex the compute used to substitute matches EVERY gene and
   reports ~100 % on every cell"*). Click "Add custom metric", press Run: the gate
   (`qc_metrics.length == 0`) is satisfied and the job dies. Click it **twice** and you also
   hit `DuplicateMetricName` (two rows sharing `name: ""`), likewise fatal.
3. **cell-filter's Min/Max are free text with no validation**, and the failure is silent in
   the worst possible direction. `criteria/criteria.ts::parseBound` — the normative
   coercion, conformed to by four readers — maps an ungrammatical bound to **unbounded, not
   an error**, on purpose (so the preview, the committed mask and the attested replay cannot
   disagree). So `1O`, `1_000`, or a `10` pasted with a non-breaking space from a
   spreadsheet all mean *no constraint*: the criterion filters nothing, the mask keeps every
   cell, rc=0, green report. The form is the only layer that can catch this, and it does not
   look.
4. **cellranger's `expected_cells` is free text going straight into a shell argument.**
   `jqget` uses jq's `//`, which substitutes only on `null` or `false`, so an empty or
   garbage string passes through verbatim to `--expect-cells "$EXPECTED_CELLS"`. The view's
   own comment already documents the `//` hazard for `reference`; the same hole is open on
   the numeric field and nothing checks it.

### The alerts are the tell

`qc.yaml` now carries two alert widgets (`noMetricsAlert`, `unpairedGeneNamesAlert`) whose
`when` clauses are hand-copied fragments of the Run button's `disabledWhen`, restating in
prose what the gate already computes. The author wrote the requirement **twice**, in two
places that can drift apart, because there was no way to write it once. And
`cell-filter.yaml` still carries a comment explaining that its unlabeled-mask condition
*"is a separate alert rather than a second clause on the Run button's `disabledWhen`
because `evalWhen` takes ONE predicate … and no `&&`/`||`/`!`"* — true when written, false
since `be64379f`, and nobody noticed because the two live in different files.

## Non-negotiables

Lifted from the failures above. Each is a promise the implementation may not reframe.

1. **A requirement is DECLARED once and consumed everywhere** — by the field's error, by the
   form summary, and by the Run gate. No form may compute its validity twice.
2. **The Run gate DERIVES from validity.** It is never a parallel predicate that can
   disagree with what the fields say.
3. **A constraint the user cannot satisfy is not shown as their fault** (a required control
   with zero candidates is the project's state, not an unanswered question).
4. **Red before typing is forbidden for an EMPTY field; red is MANDATORY for a PRESENT
   wrong value.** See DEC-4.
5. **Every message is programmatically associated with its control** (`aria-invalid`,
   `aria-describedby`), and lives OUTSIDE the control, because a disabled control is out of
   the tab order (the reason `SelectRenderer` already carries `EMPTY_OPTION_LABEL` in the
   field description rather than inside the control).
6. **The numeric grammar is `criteria/criteria.ts`'s, not a new one.** See DEC-7.
7. **An INCOMPLETE form must be non-launchable, and that must be asserted.** The
   conformance tier today proves only that a *completed* form is launchable; a validator
   that always answers "valid" passes it.

## 1. What the shipped specs actually need

Not a schema language — an enumeration, read off the three shipped views and the refusals
their kernels already implement. **Every entry below maps to a documented kernel refusal or
a documented silent-wrong-answer.** That is the whole basis for the vocabulary: it is not
designed, it is transcribed.

| # | Constraint | Where it occurs today | What happens without it |
|---|---|---|---|
| R1 | value present | `matrixPicker`, `expressionPicker`, `fastqsPicker`, `geneNamesPicker` | kernel refuses the empty slot; or (fastqs) an empty `/inputs` |
| R2 | list non-empty (`min_items`) | `matrices`, `fastqs`, `qc_metrics` | a run that emits nothing |
| R3 | per-row field present | `metricTable`'s `pattern` (and `name`) | `MissingGenePattern`, fatal |
| R4 | list-alignment, one entry per entry of another list | `geneNames` ⟷ `matrices` | kernel exits 2; pattern metrics silently vanish |
| R5 | numeric under the shared decimal grammar | `critMin`/`critMax`, `expected_cells` | criterion silently unbounded; `--expect-cells ""` |
| R6 | `min ≤ max` within one criterion row | `critMin`/`critMax` | a keep-range that keeps nothing, with no error |
| R7 | unique within a list | `qc_metrics[].name` | `DuplicateMetricName`, fatal |
| R8 | not already taken IN THE ENVIRONMENT | `qc_metrics[].name` vs the columns already on the target axis | a SECOND column of that name is created (storage does not key on the name), and the reader shadows all but one of them by row order |

**R4 is not what it looks like.** `geneNamesPicker` already declares
`for_each: "$state.matrices as $m, $i"` — one picker per matrix, bound to `geneNames[$i]`.
So "one entry per matrix" is not a cross-field rule at all: it is **R1 applied to a
repeater that is already keyed to the other list**, and it is right by construction where
the hand-written `<` comparison is provably wrong (Failure 3.1). The genuinely cross-field
case in the shipped set is **R6**, which spans two controls of one `for_each` row.

**What is NOT in this list, and stays out:** string length, formats (email/URL/regex),
enum membership beyond what a closed-set control already enforces, and any constraint on
`reference` (an operator-mounted directory set no API exposes — free text is the honest
answer, as `cellranger.yaml` argues at length). See §7.

## 2. The declaration surface

### DEC-1: a constraint is declared on the CONTROL, not on the state field

A constraint is only useful if the user can act on it, and the only thing a user can act on
is a rendered control. A `state:` field has no location on screen; a widget does — and
`WidgetField` (`core/render/WidgetField.tsx`) already owns the label, the description, the
generated id and the `aria-describedby` list every message would have to join.

It also falls out correctly for repeaters with **no new construct**: a `for_each` widget is
already N rendered instances in N scopes, so a per-row constraint is just the widget's
constraint, evaluated per instance.

The cost, stated: a state field with no control cannot be constrained. That is a feature —
a requirement no control can satisfy is not a requirement, it is a dead end, and this repo
has shipped one before (cell-filter's deleted `cellsIndex` picker: *"a required-LOOKING
decision … for a run that never read the answer"*).

### DEC-2: the constraint vocabulary is CLOSED, like `EFFECT_OPS`

`vocabulary.ts` already draws this line — widget kinds OPEN (rendering is not privilege
escalation), effect ops CLOSED (acting is). A constraint is a **machine-checked claim about
what the run will accept**, which is on the acting side. Closing it is also the direct
answer to Failure 1: an author who cannot write a free-form predicate can never write one
that silently evaluates to nothing.

```
required · min_items · max_items · number · unique_by · not_in
```

Six keys, one per row of §1 (R4 folds into `required`, R6 into `checks` below). A seventh is
an app change with a real second user, not a registration seam.

**ADDED after implementation, on a user decision.** `not_in` is R8, and it is deliberately
*not* `unique_by`: that one is uniqueness WITHIN the form's own list, this one is uniqueness
against the ENVIRONMENT. A form can satisfy the first completely and still collide, and the
remedies differ (drop a duplicate row, versus rename against what already exists) — so they
are separate constraints with separate sentences. The view names the set that is taken (a
`data` slice, a `derived` list); the engine only tests membership, so no domain noun enters
core.

The set has to be scoped to the **axis instance the run writes to**, and that is the whole
difficulty. QC seeds four metric rows, and any user who has ever run it has columns with
those four names in the project — so a project-wide check marks every seeded row invalid the
moment the form opens and the feature ships dead for exactly the projects it is for. An axis
instance is the anchor's own dataset plus the axis name (`siblingsOnAxis`), and a run over
several inputs writes to several, so the slice covers *every* selected anchor
(`anchorIds`) and unions them: free on the first and taken on the second is taken.

Two sentences are needed on one control (`required` and `not_in` sit on the same field), so
`require.message` additionally accepts a per-constraint MAP. A block-level string still
speaks only for the presence/shape constraints — a sentence written about an absent value is
actively wrong as the explanation of a collision.

```yaml
- id: matrixPicker
  kind: artifact_ref
  label: Count matrices
  multiple: true
  source: { subtypes_of: single-cell/expression, excludes: [single-cell/normalized] }
  value: "$state.matrices"
  onChange: qc.setMatrices
  require:
    min_items: 1
    # OPTIONAL. Absent → core's default, which names the control's own `label` and no
    # other noun. The SENTENCE is the view's to write when the view has a better one —
    # the same split as DEC-6 in analysis-run-feedback.md (authored text, derived target).
    message: Choose at least one raw-count matrix to compute over.
```

```yaml
- id: geneNamesPicker
  kind: artifact_ref
  for_each: "$state.matrices as $m, $i"
  label: Gene names from
  source: { axis: genes, of: "$m", datatype: metadata-column, values: text }
  value: "$state.geneNames[$i]"
  args: { index: "$i" }
  onChange: qc.setGeneNames
  require:
    required: true       # ← per rendered instance ⇒ R4, by construction
```

```yaml
- id: critMin
  kind: text
  when: "$derived.controlByColumn[$c.column] == range"
  label: Min
  value: "$c.min"
  require:
    number: {}           # ← the SHARED decimal grammar; see DEC-7
```

```yaml
- id: expectedCellsInput
  kind: text
  label: Expected cells
  require:
    number: { min: 1, integer: true }
```

A `table` carries `require` on the widget (row-count bounds + uniqueness) and on each
`cell:` primitive that holds a value:

```yaml
- id: metricTable
  kind: table
  rows: "$state.qc_metrics"
  require:
    min_items: 1
    unique_by: name       # ← DuplicateMetricName is fatal; make the form say so first
    message: Add at least one metric — a run with none produces no columns.
  columns:
    - key: name
      title: Metric
      cell: { editable_text: { value: "$row.name", onChange: qc.setMetricField, require: { required: true } } }
    - key: pattern
      title: Genes
      cell: { editable_text: { value: "$row.pattern", onChange: qc.setMetricField, require: { required: true } } }
```

### DEC-3: cross-field constraints are a view-level `checks:` list, and each names where it lands

R6 belongs to no single control (it is a relation between two), so it cannot be a `require`.
It is declared once, at the view level:

```yaml
checks:
  - id: minAboveMax
    for_each: "$state.criteria as $c, $i"
    fails_when: "$c.min > $c.max"
    at: { widget: critMax, index: "$i" }
    message: Min is above Max, so this criterion keeps nothing.
```

Three decisions inside that block:

- **`fails_when`, not `when`.** `WidgetBase.when` means "render when true". A key spelled
  `when` on a check would mean the opposite, and this repo has already paid for a predicate
  that "reads correctly and never fires". The inverted name makes the reading unambiguous
  at the call site.
- **It reuses `evalWhen` verbatim** — the same grammar, the same trust boundary, no second
  expression language. `$c.min > $c.max` is exactly what `be64379f` made expressible.
- **`at:` is mandatory.** A form-level message with no field is the "disabled with no stated
  cause" defect one level up. `index:` resolves the instance for a repeated target; a check
  whose `at` names no rendered widget is a **parse error**, not a silently-floating message.

`checks` is deliberately the *only* place a free-form predicate survives, and it is scoped
to a relation the closed vocabulary genuinely cannot express. If a check is ever written
that a `require` key could have expressed, that is the signal to add the key.

## 3. What "live" means

### DEC-4: suppress-until-touched applies ONLY to the empty case

The brief's two hostile poles are real and they resolve on a sharper axis than "when":

- A control that is **empty and never touched** is not wrong, it is *not yet answered*.
  Reddening it the instant the pane opens is the hostile case. Its requirement is surfaced
  in the **form summary** (§4) and by a disabled Run — never on the field.
- A control that **holds a value which is invalid** is wrong *right now*, whether or not
  this user typed it. A stale bound value surviving a catalog change, a criterion restored
  from a persisted pane, a `1O` pasted in — none of these is "you haven't got there yet".
  It shows immediately.

So the rule is not touched-vs-pristine, it is **absent-vs-present**:

> A field-level error is displayed when the control holds a value that violates its
> constraint, OR when the control is empty AND has been changed at least once in this
> session. Validity itself is computed on every render regardless of either.

### DEC-5: after the first change, on every keystroke — not on blur

For the fields where this matters most (cell-filter's Min/Max), blur-only feedback is
useless: the failure is silent downstream, so a user who types `1O`, tabs away and never
looks back learns nothing until the mask keeps every cell. Feedback that arrives after the
user has moved on is feedback that arrives after the decision.

The first-change condition is what keeps it from being hostile: the field says nothing
while it is blank and untouched, and once the user has engaged with it, it tracks them.

### The pristine form, concretely

A freshly-opened QC pane with one matrix auto-selected and no gene-name column chosen:

- `matrixPicker` — valid (seeded), no error.
- `geneNamesPicker` — empty, untouched ⇒ **no red**.
- `metricTable` — four seeded rows, all valid ⇒ no error.
- Run — **disabled**, with the summary beneath it reading *"Gene names from — required."*
- The user opens the picker, closes it without choosing ⇒ still untouched, still no red.
- The user chooses, then clears ⇒ touched ⇒ red on the field, and the summary still lists it.

## 4. Where the message appears

**Both**, and they are different statements.

**Field level.** `WidgetField` gains an `error?: React.ReactNode` slot rendering the kit's
existing `FieldError` (`sdk/packages/kit/src/shadcn/field.tsx` — already `role="alert"`,
`data-slot="field-error"`, `text-destructive`). Its id joins the existing `aria-describedby`
list beside `description` and `detail`; the control receives `aria-invalid="true"` and the
`Field` wrapper `data-invalid="true"` (which the kit's `fieldVariants` already styles:
`data-[invalid=true]:text-destructive`). One edit, in the one scaffold every control
composes — the "shared-layer only" rule from `declarative-rendering-hardening.md`.

**Form level.** ONE summary beside the Run button, listing each unmet requirement by its
control's own label, newest-relevant first and bounded. This is what answers *"why is Run
grey"* for the pristine-empty case that DEC-4 keeps off the fields, and it is the direct
descendant of DEC-3 in `analysis-run-feedback.md`: *a disabled primary action with no
stated cause reads as broken.* It renders through the same node the in-flight
`actionBlockedReason` already renders through (`ButtonRenderer`'s `-blocked` paragraph).

### What happens to QC's two alerts

`noMetricsAlert` and `unpairedGeneNamesAlert` are **deleted**. Their sentences move verbatim
into `require.message` on `metricTable` and `geneNamesPicker`. They exist only because the
requirement could not be written once; once it can, an alert restating it is a second copy
that can drift.

`noInputAlert` **is deleted too, in all three views** — and its sentence moves onto the
control, as `artifact_ref.empty_text`.

> **CORRECTED after implementation, on a user report.** This section originally said
> `noInputAlert` stays unchanged. That was wrong, and wrong for the reason the rest of this
> document is about. The distinction below is real; the alert was on the wrong side of it.

The two propositions look identical and are not:

> `matrices.length == 0` because the **project has no candidates** is a fact about the
> environment, with no action available in this form. `matrices.length == 0` because the
> **user has not chosen yet** is an unanswered question. The alert speaks to the first; the
> constraint speaks to the second.

Every shipped `noInputAlert` **tested the second and asserted the first**:

```yaml
when: "$state.matrices.length == 0"                     # the user has not SELECTED one
text: "No raw-count expression matrix in this project yet. Import one …"   # the project CONTAINS none
```

Measured against the reporting user's project: **two** raw-count expression matrices
present (`sparse_csc`, `x_state: raw_counts`). `ArtifactRefWidget` pre-selects only at
**exactly one** candidate, so with two nothing binds, `$state.matrices` stays `[]`, and the
alert fires. The message therefore appeared *precisely when the user had more than one of
the thing it said they had none of*, and grew more confident the more data they imported.
`cell-filter.yaml` carried the identical bug; `cellranger.yaml`'s was worse still, because
`resolveInputs` never auto-picks a `multiple` slot, so its alert was true-by-construction on
every project that had lane sets.

**It is not repairable as a predicate.** A view cannot observe candidate availability at
all: `evalWhen` reads `$state` / `$derived` / `$data` / `$const` / the capability set, and
the artifact catalog is deliberately an INTERNAL channel a view may not query — the same
rule that keeps `$validity` out (§6). So every `when` written here can only test the nearest
thing a view CAN see, which is its own selection state. That is how the substitution
happened, and any repair in the same place would make it again.

The smallest addition is therefore **not a new predicate**. The `artifact_ref` control
already resolves its own candidate set and already renders a distinct zero-candidate arm —
it is the one point in the system where the answer exists. So the view supplies the
**sentence** for that arm (`empty_text`) and writes no condition at all. There is nothing to
get wrong, and the message cannot drift from the `source` it is about, because it is
declared on it.

`empty_text` replaces core's generic wording for the **project-wide** absence only. An
axis-scoped source with no anchor yet is a *different* absence — that control is waiting on
the one above it, and an import instruction there points somewhere that cannot help — so
that arm keeps core's own wording.

The three renderings are then distinct, which is the property that was missing:

| candidates | what the user reads |
|---|---|
| 0 | the control's empty arm + the view's `empty_text` ("… none in this project yet. Import one.") |
| 2, none chosen | a real picker, and the summary line "*Count matrices* — Choose at least one raw-count matrix to compute over." |
| 1 | pre-selected; neither |

A `require.message` is consequently phrased as **choose**, never as **import**. Which leads
to:

### DEC-6: an unsatisfiable requirement is not reported as unmet

A `required` control whose resolved candidate set is empty contributes **no field error and
no summary line**; Run is still disabled, and the view's own alert is what speaks. A red
"required" on a control that offers nothing is an instruction the user cannot follow.

## 5. What replaces `disabledWhen`

The Run button's disabled state becomes the OR of three sources, in this order:

1. `formValidity.canSubmit === false` — derived, never authored.
2. `actionBlockedReason(onClick)` — the host's in-flight guard (unchanged,
   `WidgetHost.tsx`).
3. `disabledWhen` — if the view still declares one.

**`disabledWhen` survives in the contract but has no shipped use after migration.** Removing
it is a contract break for any third-party package, and there is a legitimate residual class
(a condition about something *other than the form's own values* — a prerequisite pane, a
host state). But every one of its three shipped uses today is pure validation, and that is
checkable: a test asserts the shipped views declare zero `disabledWhen`. If that test is
still green a year from now, deleting the key becomes a separate, easy change.

### Migration — QC (`packages/qc/ui/qc.yaml`)

| today | becomes |
|---|---|
| `disabledWhen: "$state.matrices.length == 0 \|\| $state.qc_metrics.length == 0 \|\| $state.geneNames.length < $state.matrices.length"` | *deleted* |
| clause 1 | `matrixPicker.require.min_items: 1` |
| clause 2 | `metricTable.require.min_items: 1` |
| clause 3 | `geneNamesPicker.require.required: true` — **and this fixes Failure 3.1**: the sparse-array hole the `<` comparison cannot see is exactly what per-instance required-ness catches |
| *(no clause — Failure 3.2)* | `cell.editable_text.require.required: true` on `name` + `pattern`; `metricTable.require.unique_by: name` |
| *(nothing — R8, added on a user decision)* | `name`'s `require.not_in: "$data.existingColumns"`, fed by a new `data` slice `axis_columns … as: sources` anchored on the whole `$state.matrices` list |
| `noMetricsAlert`, `unpairedGeneNamesAlert` | deleted; text moves into `require.message` |
| `noInputAlert` | **deleted**; text moves into `matrixPicker.empty_text` (corrected — see §4) |

### Migration — cell-filter (`packages/cell-filter/ui/cell-filter.yaml`)

| today | becomes |
|---|---|
| `disabledWhen: "$state.expression == ''"` | `expressionPicker.require.required: true` |
| *(nothing — Failure 3.3)* | `critMin`/`critMax`: `require.number: {}` |
| *(nothing — R6)* | `checks: [minAboveMax]` (§2, DEC-3) |
| `noInputAlert` | **deleted**; text moves into `expressionPicker.empty_text` (corrected — see §4) |
| `unlabeledAlert` | **unchanged** — see §7 |
| the stale comment at lines 250-255 claiming `evalWhen` has no `&&`/`\|\|` | deleted (false since `be64379f`) |

### Migration — cellranger (`packages/cellranger/ui/cellranger.yaml`)

| today | becomes |
|---|---|
| `disabledWhen: "$state.fastqs.length == 0"` | `fastqsPicker.require.min_items: 1` |
| *(nothing — Failure 3.4)* | `expectedCellsInput.require: { required: true, number: { min: 1, integer: true } }` — `required` as well, because an EMPTY value is deliberately not a `number` violation (an omitted bound is a real answer for a criterion) and acceptance 8 needs blank refused |
| `referenceInput` | **unchanged** — open operator set, deliberately unvalidated (§7) |
| `noInputAlert` | **deleted**; text moves into `fastqsPicker.empty_text` (corrected — see §4) |

## 6. The engine

### DEC-7: the numeric grammar is the existing one, or we ship a fifth disagreeing reader

`core/criteria/criteria.ts` is **normative** and already has four conforming readers (the
live preview, the cell-filter kernel, the Rust attested replay, the narration), pinned by a
123-case corpus and stamped with `CRITERIA_COERCION_VERSION`. Its whole existence is a
record of what happens when readers disagree: a BOM-padded cell kept by the preview and
dropped by the committed mask, at rc=0.

`require.number` therefore calls `parseBound` / `DECIMAL_BOUND` — it does not call
`Number()`, and it does not define its own accept-set. Note the deliberate consequence: the
form now *reports* as invalid precisely the inputs the readers treat as **unbounded**. That
is the point. The coercion stays "unbounded, not an error" (four readers must keep
agreeing); the FORM is the layer that says the user probably did not mean unbounded.

### Where validity is computed, and why it is a pre-pass

A pure function, in `core/form/validity.ts`:

```
evaluateForm(spec: ViewSpec, scope: Scope) → FormValidity
```

It walks `spec.widgets` with **the same `expandForEach` + `evalWhen` the renderer walks**,
and returns a verdict keyed by `widgetId#index`, plus the `checks` results, plus a
`SubmitGate`.

**Reuse, not invention:** `core/form/gate.ts` already declares
`SubmitGate { canSubmit, reason }` and `readWidgetGate`, with a standing note that it *"has
NO producer in the tree … the next widget that needs live submit-gating implements this
shape."* This is that producer. The run gate consumes a `SubmitGate` and recomputes nothing.

**It walks the rendered tree, not the spec**, and that is load-bearing for two reasons:

- A widget whose `when` is false is not drawn, so its constraint is not evaluated — a
  requirement the user cannot see is not a requirement they can meet. (This has a hazard;
  see OQ-1.)
- A `for_each` row's verdict must be computed **in that row's scope**, on the same render,
  from the same binding the control displays. Computing validity against `store.state` while
  the control renders from `entry.scope` is how row *i* ends up showing row *j*'s error —
  the exact class the shipped-form conformance tier's per-row assertions exist to catch.

### How the verdict reaches the renderer

Through an **internal scope channel**, exactly as the catalog and the value-preview port
already do (`CATALOG_SCOPE_KEY`, `VALUE_PREVIEW_SCOPE_KEY` in `DeclarativeRegion.tsx`):

```ts
const scope: Scope = {
  params: {}, state: store.state, derived: store.derived,
  const: spec.const ?? {}, data: liveData, caps,
  [CATALOG_SCOPE_KEY]: …,
  [VALUE_PREVIEW_SCOPE_KEY]: …,
  [FORM_VALIDITY_SCOPE_KEY]: validity,   // ← new
}
```

Not a `$`-ref namespace. A view declares a constraint and the engine answers it; a view may
not read `$validity` any more than it may query the catalog itself.

The **touched set** is UI state, not view state — it is not part of what the run receives
and must never appear in `store.snapshot()` (which feeds `describe` and the AI surface). It
lives in `DeclarativeRegion`, keyed by `widgetId#index`, and dies with the pane.

**Cost, stated honestly:** the `for_each` expansion runs twice per render (once for
validity, once for rendering). Bounded by `FOR_EACH_MAX` (1000) and by the fact that
`for_each` composes views rather than data; memoized on `[spec, revision, data]`, the same
dependency set the existing `scope` memo uses. If that proves too coarse, the fix is a
finer memo key, not a shared mutable pass — a validity computed *during* rendering is
exactly the show/state divergence this design exists to close.

### Consistency with "show == state"

The conformance tier's P1 is *what the form SHOWS == what STATE holds == what the RUN
receives*. An error message is not a value, so it does not participate in that identity —
but it inherits a corollary worth writing down:

> **An error is a statement about a specific displayed value, and must be derived from the
> same binding, in the same scope, on the same render as the value it is about.**

That is the property the pre-pass design buys, and it is testable the same way P1 is: for
every rendered control, the error shown is the verdict for the binding that control
displays.

## 7. Deliberately not doing

- **A general schema language.** No JSON Schema, no zod in the view contract. `schema.ts`
  already refused zod for the view spec (DEC-9 there: *"this is trusted first-party config
  validated structurally"*), and a general language re-opens Failure 1's shape one level up
  — an author writing arbitrary constraint expressions that can silently mean nothing.
- **Growing `evalWhen`.** No `!`, no parentheses, no new operators. (See OQ-6 — there is a
  live hazard here already.) The closed `require` vocabulary exists precisely so nobody
  needs to.
- **Validating the QC `pattern` as a regex.** Only its *presence* is checked. Compiling a
  user regex in JS to predict what Python's `re` will accept is two engines with two accept
  sets — the identical multi-reader trap DEC-7 is avoiding, and `compile_gene_pattern`
  already handles compile/ReDoS/length as a *recorded warning* rather than a fatal.
- **Validating `reference`.** Which transcriptomes exist is an operator fact (whatever they
  mounted at `CYTO_SANDBOX_RESOURCE_REFERENCE`) that no API exposes. A closed list would be
  a hardcoded spelling list that drops the third spelling — the argument `cellranger.yaml`
  already makes.
- **A `warning` severity tier.** cell-filter's `unlabeledAlert` (*"this mask has no label,
  so it will commit as `keep_all`"*) is the only advisory in the tree, it reads well as an
  alert, and it is legal to proceed. One candidate user is not enough to justify a second
  severity in a closed vocabulary. It stays an `alert`.
- **Async or server-side validation.** Every constraint here is answerable from state plus
  already-resolved data.
- **Cross-VIEW constraints.** Views of one analysis stack into one pane, but no shipped
  requirement spans two.
- **Changing any kernel refusal.** The kernels stay the last line of defense. The form
  refusing first does not make the kernel's refusal redundant — an AI-driven or REST-driven
  run never passes through this form at all.

## 8. What must not regress

- **Shipped-form conformance** (`core/render/shippedFormConformance.test.tsx`) — P1
  (show == state == launch), P2 (every rendered affordance operable, named, honest), P3
  (dependent controls resolve). Two notes: a `FieldError` is a `<div role="alert">` and is
  correctly *not* matched by `affordances()`, so P2's operability sweep is unaffected; and
  `completeRequiredPickers()` must keep working unchanged — with required-ness declared, its
  claim ("a COMPLETED form is launchable") gets strictly stronger.
- **The missing negative control.** Non-negotiable 7 needs a new conformance property:
  *with a required control left unanswered, Run is disabled and the summary names that
  control.* Without it a validator that always answers "valid" passes the whole tier.
- **The domain-vocabulary guard** (`ui/scripts/lint-no-domain-in-builtin.mjs`, ratcheted
  against `domain-baseline.json`). Core's default messages may interpolate a control's own
  `label` — the view's word — and may name nothing else. No datatype id, axis name or column
  name may enter `core/form/validity.ts` or `WidgetField.tsx`.
- **Accessibility.** `aria-invalid` on the control, the error id in `aria-describedby`,
  `role="alert"` on the message, and the message rendered **outside** the control so it
  stays reachable when the control is disabled.
- **`gate:ui` runtime health.** A WCAG-AA contrast failure is a gating HIGH. `text-destructive`
  over a `group` widget's `bg-muted/40` card is the case to measure before shipping, in both
  themes.
- **`CRITERIA_COERCION_VERSION`.** `require.number` becomes a *consumer* of the spec, not a
  reader of it — it must not introduce a rule the corpus does not already pin.

## 9. Open questions

Named as open, not resolved.

- **OQ-1 — a `when`-gated control's constraint is not evaluated.** Correct for the user (an
  invisible requirement is unmeetable), but it leaves a hole: a control gated off while its
  state field still holds a value the kernel will refuse. Should `run_processor` re-validate
  at dispatch? That is defense in depth, but it is also a *second evaluation site*, and this
  repo's scar tissue is entirely about two encodings of one thing disagreeing.
- **OQ-2 — touched-ness across list mutations.** `qc.setMatrices` clears `geneNames`
  wholesale. The per-index touched flags then point at indices whose meaning changed.
  Clearing them (nothing red) and keeping them (immediately red, arguably correct — the user
  *did* just invalidate them) are both defensible. Undecided.
- **OQ-3 — where a table's error renders.** A `table` is not a `WidgetField`, so
  `min_items` / `unique_by` messages have no obvious home. Under the table is the guess;
  it has not been drawn.
- **OQ-4 — does the summary need to be dismissible or bounded?** A 50-criteria form with
  every row invalid produces 50 lines. `FOR_EACH_MAX` is 1000. A bound is needed; what it
  elides is not decided.
- **OQ-5 — `checks` is the second construct to grow a `for_each`.** R6 needs it (the
  min≤max relation is per row). Whether that is one repeater too many, or whether per-row
  cross-field relations should instead be expressible on the enclosing `group`, is open.
- **OQ-6 — `evalWhen` silently accepts parentheses it does not evaluate.** `splitTopLevel`
  tracks bracket depth, so `(a || b) && c` splits correctly at the top level — but the
  sub-expression `(a || b)` then reaches no operator branch and falls through to
  `evalOperand`, where it is a bare word and therefore **truthy**. That is Failure 1's exact
  shape, still live, in the grammar `checks.fails_when` is about to reuse. The fix is
  probably to REJECT what cannot be evaluated rather than grow the grammar, but rejecting
  loudly in a `when` clause changes the behaviour of an already-shipped construct. Not
  decided here; flagged because this design increases the traffic through that code path.
- **OQ-7 — should `disabledWhen` eventually be removed?** §5 keeps it. If the
  "no shipped use" test stays green, deletion becomes a cheap separate change — but it is a
  `WORKBENCH_API_VERSION` MAJOR break for third-party packages, so the answer depends on
  whether any exist.

## 10. Acceptance

1. A QC pane with no gene-name column chosen shows **no red** on the untouched picker, a
   disabled Run, and a summary naming that control by its label.
2. Choosing a gene-name column and then clearing it turns that field red, on the field.
3. Answering only the *third* of three gene-name pickers leaves Run **disabled** (the case
   the shipped `<` gate lets through — Failure 3.1).
4. "Add custom metric" followed immediately by Run is **not possible**: the blank `pattern`
   and `name` cells are invalid and Run is disabled (Failure 3.2).
5. Adding two blank metric rows reports a duplicate-name violation before any launch (R7).
6. Typing `1O` into a cell-filter Min shows an error on that field on the next keystroke,
   and disables Run (Failure 3.3).
7. Entering `min: 5, max: 1` on one criterion row attaches the error to **that row's** Max
   control, not to another row's (R6, and the same-scope corollary in §6).
8. A blank `expected_cells` disables Run in cellranger (Failure 3.4).
9. `qc.yaml`, `cell-filter.yaml` and `cellranger.yaml` declare **zero** `disabledWhen`, and
   a test asserts it.
10. A required control whose candidate set is empty produces no field error and no summary
    line; the control's own zero-candidate arm, carrying the view's `empty_text`, is what
    speaks (DEC-6).
13. A metric name already present on the axis the run writes to is invalid, with the
    conflict named; the same name present only on ANOTHER dataset's axis is fine, so the
    default form opens clean in a project where the analysis has already run elsewhere. (R8.)
14. At **two** candidates with none chosen, the environment-empty sentence does NOT appear
    and the unanswered-requirement summary does; at **zero** the reverse; at **one** the
    pre-selection makes both silent. (Added on the user report in §4 — the one-candidate
    fixture every tier used auto-binds and hid it completely.)
11. Every rendered error carries `role="alert"`, its id appears in its control's
    `aria-describedby`, and the control carries `aria-invalid="true"`.
12. `core/form/validity.ts` and `WidgetField.tsx` name no domain noun; the
    `lint-no-domain-in-builtin.mjs` baseline does not grow.
