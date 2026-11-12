// The declarative `view_spec` CONTRACT types (PLAN.md ITEM-1, DEC-10). A
// processor ships a declarative UI that DECLARES ITS OWN ACTIONS (research §10):
// the control is the noun (a `WidgetSpec`), the action is the verb (an
// `ActionSpec` whose `body` is a declarative `EffectSpec[]` the app interprets
// — never a JS closure). These types are the shared, strict-JSON-serializable
// shape only; the renderer + interpreter + primitive vocabulary live in the app
// (`workbench/core/spec/` + `core/runtime/` + `core/render/`), never here (DEC-10).
//
// Kept dependency-free and pure-type (no runtime), mirroring `./types.ts`.
// EVERY field is a JSON scalar / array / object — no functions, no class
// instances — so a `view_spec` round-trips through YAML/JSON unchanged.

/** A binding expression string: either a `$`-reference (`$state.x`,
 *  `$data.obs[$c]`, …) the app's `evalExpr` resolves, or a plain JSON literal.
 *  NEVER arbitrary JS (research §10 — the trust boundary). */
export type ExprString = string

// ---------------------------------------------------------------------------
// State / data / derived / const
// ---------------------------------------------------------------------------

/** One declared per-instance state field. `default` is a JSON literal or a
 *  `$`-ref (e.g. `"$data.vis2D.keys[0]"`) resolved at store-init. */
export interface StateFieldSpec {
  type: string
  default?: unknown
  /**
   * WHOSE value this is (visualize-pane ITEM-11).
   *
   * Absent (the default, and every shipped field today) ⇒ the field belongs to this view's own
   * store, per instance. `pane` ⇒ the field IS one of the pane's shared values: reads resolve
   * from the pane scope and a `set` writes THROUGH to it, so every other section on the pane
   * sees the write and an anchor change is seen here.
   *
   * It is a declaration on the FIELD rather than a new effect op deliberately: the section goes
   * on writing `set: { coordinate: … }` exactly as it writes any other field, so no new verb
   * reaches an author and `EFFECT_OPS` stays closed. The pane's value set is closed too
   * (INV-13, `PANE_SCOPE_KEYS`), and `parseViewSpec` refuses a `scope: pane` field whose NAME is
   * not in it — otherwise a spec could mint a third shared value by declaring one.
   */
  scope?: 'pane'
}

/**
 * A `data` slice — pulled from a job result / artifact by the host.
 *
 * `source` names the resolver; `args` is that resolver's own argument shape:
 *   · `job.result`   — `{ datatype, produced_by?, shape?, kind? }`: the newest artifact of a
 *     declared datatype, optionally NARROWED to the analysis (or analyses) that produced it,
 *     read as the SHAPE the binding declares.
 *
 *     `path` USED TO BE DOCUMENTED HERE AND WAS READ BY NOTHING. `sliceDatatype` consults
 *     only `args.datatype`, so a slice passing `path` selected exactly what one omitting it
 *     selected — an argument that looks load-bearing and is inert is how a reader concludes
 *     a binding is specific when it is not. Removed from the contract rather than left as a
 *     comment; no shipped view passes it (one view mentions it only in prose,
 *     describing a binding it no longer uses).
 *
 *     `produced_by` exists because a DATATYPE IS NOT A SELECTOR: `data/opaque` alone is
 *     emitted by several producers, so "newest of this datatype" silently binds whichever
 *     ran last. A declared `produced_by` that matches nothing resolves to NOTHING — it never
 *     falls back to the unnarrowed newest.
 *
 *     `shape` is `"table"` (the default, and every binding written before this) or
 *     `"document"`. It exists because an `opaque` JSON artifact is TWO shapes, not one: a
 *     columnar table, and a `kind`-tagged object whose members are unrelated and of unequal
 *     length. The reader used to have only the first reading and applied it to both — zipping
 *     every array-valued key to `max(len)`, padding the short ones with nulls and dropping
 *     every key that was not an array. Measured on a real producer's bytes that produced a
 *     table with a phantom blank row and no discriminator, and no layer noticed.
 *
 *     So the two readings are DECLARED and the mismatch is refused: a `table` binding over a
 *     document, or a `document` binding over a table, resolves `unsupported` with a dev-warn
 *     rather than a best-effort decode. A `shape` this build cannot read is refused the same
 *     way and does NOT fall back to `table` — the author wrote it to get something else.
 *
 *     `kind` (document bindings only) names the discriminator the artifact must carry. It is
 *     the field the columnar decode used to drop, so a binding that names it asserts exactly
 *     what was previously unobservable: a document of a different `kind` is `unsupported`,
 *     never rendered as if it were the expected one.
 *   · `axis_columns` — `{ of, axis }`: every metadata-column present on `axis` of the
 *     dataset the artifact referenced by `of` belongs to, INCLUDING columns no analysis
 *     ever declared (INV-5/INV-6). `of` is a `$`-ref to another control's value, which is
 *     what makes this a view-level source rather than a manifest key: the reference
 *     dataset carries 65 obs columns and a declaration written before the run named 9, of
 *     which 8 did not exist.
 *
 * Both land the same columnar `{ column: values[] }` frame, so a view swapping one for
 * the other keeps its `derived` primitives (`columns_of` / `keep_mask`) unchanged.
 */
export interface DataSourceSpec {
  source: string
  args?: Record<string, unknown>
}

/** A reactive `derived` entry: a single compute-primitive call
 *  (`extent`/`unique`/`filter_mask`/`or_masks`/`count_by`), optionally repeated
 *  with `for_each`. Only the app-owned primitive vocabulary (ITEM-6) is
 *  expressible — a new primitive is an app change, never shipped by a
 *  processor. Kept structurally open (op-keyed) so the primitive set can grow
 *  without a contract break; the app validates the op names. */
export interface DerivedSpec {
  /** `for_each: "$list as $item"` — repeat this derived over a list. */
  for_each?: string
  /** With `for_each`, an optional per-iteration KEY expression (usually the loop
   *  var, `"$c"`): present → the derived is a MAP keyed by that value
   *  (`$derived.ranges[$c]`); absent → the array form (`$derived.hiddenByCrit`
   *  → `or_masks`). Additive: an existing `for_each` derived without `key` keeps
   *  producing an array. */
  key?: ExprString
  /** the per-iteration derived when `for_each` is present. */
  value?: DerivedSpec
  extent?: ExprString
  unique?: ExprString
  filter_mask?: { values: ExprString; group_of: ExprString; ranges: ExprString }
  or_masks?: ExprString
  /** combine a base hidden mask with a brushed gate keep-set (sliders AND gate). */
  gate_mask?: { base: ExprString; gate: ExprString }
  /** `[min(lo), max(hi)]` envelope over a criterion's per-sample ranges → the scatter's
   *  metric value-range `filter`. */
  range_envelope?: ExprString
  count_by?: { group: ExprString; hidden: ExprString }
  /** The COMBINED per-row KEEP mask (declarative-processor-ui Slice 4, ITEM-9) — the AND over a
   *  user-built `criteria` list of each criterion's keep-mask on ITS column (continuous → a
   *  min/max range, categorical → a keep-set). `criteria` resolves to `[{column, control,
   *  min?, max?, keep?}]`; `frame` to the columnar data frame the criteria filter. Client-side
   *  `$derived` during tuning; Run commits an immutable mask under the name the user typed. General
   *  (composes the bounded `keep_range`/`keep_categories`/`keep_and` kernels). */
  keep_mask?: {
    criteria: ExprString
    /** the columnar frame (`{ column: values[] }`) the criteria filter, e.g. `$data.<slice>`. */
    frame?: ExprString
    /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`. Core no longer names a data slice;
     *  `obs:` is the pre-rename spelling, honored so shipping specs need no migration. REMOVE at
     *  the next MAJOR `WORKBENCH_API_VERSION` (see `core/version.ts`), together with the
     *  `?? spec.obs` fallbacks in `core/runtime/store.ts`. */
    obs?: ExprString
  }
  /** The frame's COLUMNS + their control TYPE, derived from a columnar frame (Slice 4, ITEM-9/29):
   *  a numeric column → `range` (min/max), a string column → `multiselect` (keep-set). `only`
   *  filters to one control family (the group-by picker wants `categorical` columns); `keyed: true`
   *  returns a `{ column: control }` MAP (for a `when` gate — `$derived.controlByColumn[$c.column]
   *  == range`), else a `[{ value, label, control }]` ARRAY (for a `select`'s options). General. */
  columns_of?: {
    /** the columnar frame (`{ column: values[] }`) to describe, e.g. `$data.<slice>`. */
    frame?: ExprString
    /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`; see `keep_mask.obs`. */
    obs?: ExprString
    only?: 'continuous' | 'categorical'
    keyed?: boolean
    /** REMAP the keyed form's values: `{ range: <value>, multiselect: <value> }`. The view
     *  declares the vocabulary it wants (e.g. a chart kind per control type); a control with
     *  no entry falls back to the control name. C1/C2: this used to be the literal
     *  `as: 'plot'`, with core answering `violin`/`bar` — a chart-choice default hardcoded
     *  in a compute primitive. */
    as?: { range?: string; multiselect?: string }
  }
  /** The DISTINCT category VALUES of each categorical column of a frame, as a
   *  `{ column: string[] }` MAP (Slice 4, ITEM-9/29). Backs a categorical criterion's keep-set
   *  multiselect OPTIONS (`$derived.categoriesByColumn[$c.column]`) — a numeric column is skipped
   *  (it uses a range). General (composes the bounded `categories_by_column` kernel). */
  categories_by_column?: {
    /** the columnar frame (`{ column: values[] }`) to enumerate, e.g. `$data.<slice>`. */
    frame?: ExprString
    /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`; see `keep_mask.obs`. */
    obs?: ExprString
  }
  /**
   * The criterion-named columns the producer DECLARED but whose bodies have not arrived
   * (ITEM-34) — the LOADING GATE for lazy column bodies.
   *
   * Non-empty ⇒ at least one criterion cannot be evaluated yet and no result may be presented
   * as final. It answers with column NAMES rather than a boolean so a user with several
   * criteria can see WHICH one is waiting; a bare spinner cannot say that.
   *
   * A criterion naming a column the producer never declared is NOT pending — it is genuinely
   * absent, and keeps every row. Telling those two apart is the entire reason the declaration
   * sidecar exists: from the values alone they are identical.
   */
  pending_criterion_columns?: {
    /** the criteria list, e.g. `$state.criteria`. */
    criteria?: ExprString
    /**
     * the columnar frame the criteria are evaluated against, e.g. `$data.<slice>`.
     *
     * `frame` ONLY — this kernel is new, so it has no shipped caller written against the
     * pre-rename alias the older frame kernels still dual-accept. Adding the alias here would
     * re-import a deprecated spelling into a contract that never had it.
     */
    frame?: ExprString
  }
}

// ---------------------------------------------------------------------------
// Widgets — a discriminated union on `kind`
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// require — the CLOSED constraint vocabulary (declarative-form-validation DEC-1/DEC-2)
// ---------------------------------------------------------------------------

/**
 * The bound a `require.number` holds a value to, under the SHARED decimal grammar
 * (`core/criteria/criteria.ts::parseBound` / `DECIMAL_BOUND`) — never `Number()`, and
 * never a second accept-set (DEC-7). Four readers already conform to that grammar,
 * pinned by a committed corpus; a fifth that disagreed would be a defect generator.
 *
 * An ABSENT value is not a `number` violation — "you have not answered yet" is what
 * `required` asks. This one asks "what is written here is not a number".
 */
export interface NumberRequirement {
  min?: number
  max?: number
  integer?: boolean
}

/**
 * What a CONTROL requires of its own value — declared on the widget, consumed by the
 * field's own message, by the form summary and by the submit gate, all from ONE
 * declaration (non-negotiable 1).
 *
 * The vocabulary is CLOSED, like `EFFECT_OPS` and for the same reason: a constraint is a
 * machine-checked claim about what the run will accept, which is on the ACTING side. An
 * author who cannot write a free-form predicate can never write one that silently
 * evaluates to nothing — which is the failure this whole construct replaces.
 *
 * On a `for_each` widget it is evaluated PER RENDERED INSTANCE, which is what makes
 * "one entry per entry of another list" right by construction instead of a hand-written
 * length comparison that cannot see a hole.
 */
export interface RequireSpec {
  /** the control must hold a value (a non-empty string / a non-empty list). */
  required?: boolean
  /** a list-valued control must hold at least this many present entries. */
  min_items?: number
  /** …and at most this many. */
  max_items?: number
  /** a present value must parse under the shared decimal grammar (see
   *  {@link NumberRequirement}). */
  number?: NumberRequirement
  /** no two entries of a list-valued control may share this field's value. */
  unique_by?: string
  /**
   * The value must NOT already be taken — a `$`-ref to the set that is.
   *
   * Distinct from `unique_by`, and deliberately so: `unique_by` is uniqueness WITHIN this
   * form's own list, and this is uniqueness against the ENVIRONMENT. A form can satisfy the
   * first completely and still collide with something already out there, and the two have
   * different remedies (drop a duplicate row vs rename against what exists).
   *
   * The set is the VIEW's to name — it says where "already taken" is read from (a `data`
   * slice, a `derived` list), and the engine only tests membership. Two shapes are accepted,
   * both of which the vocabulary already produces: an ARRAY (each entry compared as its
   * `value` field when it has one, else as itself — the same `{value,label}`-or-scalar
   * normalization every options binding uses) or a plain OBJECT (its KEYS, which is the shape
   * a name→id map already has).
   */
  not_in?: ExprString
  /**
   * OPTIONAL authored sentence(s). Absent → the engine's default, which names the control's
   * own `label` and no other noun.
   *
   * A STRING replaces the default for the PRESENCE / SHAPE constraints (`required`,
   * `min_items`, `max_items`, `number`) — the ones whose remedy is "supply a value". It
   * deliberately does NOT reach the RELATIONS (`unique_by`, `not_in`): a sentence written
   * about an absent value is actively wrong as the explanation of a collision, and a control
   * carrying both would otherwise have to describe two different remedies with one sentence.
   *
   * A per-constraint MAP (`{ not_in: "…" }`) overrides any single constraint, relations
   * included — which is how a view says something a domain-free default cannot.
   *
   * `{value}` in any message is replaced by the offending value, so a collision can name
   * what it collided with (in the form summary the control's own contents are not visible).
   */
  message?: string | Partial<Record<RequireMessageKey, string>>
}

/** The constraints a `require.message` MAP may address. */
export type RequireMessageKey = 'required' | 'min_items' | 'max_items' | 'number' | 'unique_by' | 'not_in'

/**
 * A CROSS-FIELD constraint — a relation between two controls, which by definition
 * belongs to neither, so it is declared once at the view level (DEC-3).
 *
 * `fails_when`, not `when`: `WidgetBase.when` means "render when true", so a key spelled
 * `when` here would mean the opposite of what it reads as — and this repo has already
 * paid for a predicate that reads correctly and never fires. It reuses `evalWhen`
 * verbatim: the same grammar, the same trust boundary, no second expression language.
 *
 * `at` is MANDATORY. A form-level message attached to no control is the
 * "disabled with no stated cause" defect one level up; a check whose `at` names no
 * declared widget is a PARSE error, not a silently floating message.
 */
export interface ViewCheckSpec {
  id: string
  /** repeat the relation over a list: `"$state.rows as $r, $i"`. */
  for_each?: string
  /** TRUE ⇒ the relation is VIOLATED. */
  fails_when: ExprString
  /**
   * Where the message lands.
   *
   * `widget` is a declared widget id. `index` (an expression, usually the loop index) selects
   * WHICH instance — normally the repeat index of the widget itself.
   *
   * `part` addresses ONE REPEATED PART of a single widget instead: a `table` column's key. A
   * table renders its rows as parts of ONE widget, so a relation between two fields of one row
   * has no per-row widget id to name; without `part` the only address left is the whole table,
   * which reports "some row is wrong" over an unbounded list. With it, `index` means the ROW —
   * and the address is the one that column's own control already reads its message from, so a
   * relation and a requirement land in the same place by construction.
   */
  at: { widget: string; part?: string; index?: ExprString }
  message: string
}

/** Fields common to every widget: an optional id, a `when` visibility gate,
 *  and a `for_each` repeater. */
export interface WidgetBase {
  id?: string
  /** What this control requires of its own value (DEC-1). Declared on the CONTROL,
   *  because the only thing a user can act on is a rendered control — and because a
   *  `for_each` widget is already N instances in N scopes, so a per-instance
   *  constraint needs no new construct. */
  require?: RequireSpec
  /** boolean `$`-expression gating this widget's render (ITEM-2 `evalWhen`). */
  when?: ExprString
  /** `for_each: "$list as $item"` — data-driven widget repetition (research §11
   *  finding #1). */
  for_each?: string
  /**
   * E6 (DOMAIN_AUDIT) — the DECLARED data-slice preconditions this widget needs in order
   * to draw at all: the `data.<slice>` names that must have resolved. Consumed by the
   * discoverability resolver (`extensions/analysis/discovery.ts`), which lists a viz whose
   * precondition is unmet WITH a reason instead of silently dropping it.
   *
   * This exists because the resolver used to infer "needs an embedding" by SUBSTRING-
   * matching `vis2D` inside the `when` expression. That was wrong in both directions: a
   * `when` naming an unrelated symbol (`$state.vis2D_enabled`) was misclassified, and a
   * processor needing anything ELSE (a raster, a graph, a second table) could not state a
   * precondition at all. `when` is a RENDER gate; a precondition is a separate,
   * first-class declaration, and the noun in the user-facing reason is the processor's
   * own slice name, never a word the workbench knows.
   */
  requires?: string[]
}

export interface SelectWidget extends WidgetBase {
  kind: 'select'
  label?: string
  options: ExprString
  /**
   * ONE gate applied to EVERY option this control offers, ANDed with whatever gate an option
   * carries of its own. TRUE ⇒ offered.
   *
   * It is evaluated in the control's render scope with **`$option` bound to the option itself**,
   * which is the whole reason it exists: an options binding is DATA, and until now a datum could
   * only state a precondition about the WORLD (`has:<capability>`) and never one about ITSELF.
   * "Do not offer what has already been taken" is the commonest such precondition, and it was
   * inexpressible — the option had no name for its own value, so the only way to write it was to
   * hand-copy a clause naming each entry LITERALLY into all N entries, which drops silently on
   * the N+1th.
   *
   * Declared HERE rather than on each option for exactly that reason: the clause is a property of
   * the OFFER (this control, over this catalog), not of any one entry, so adding an entry stays a
   * pure data change.
   *
   * It is deliberately NOT `require.not_in` on the control. A requirement is a machine-checked
   * claim about what the RUN will refuse, so it closes the submit gate — and a picker whose choice
   * is optional must never do that. This one narrows what is OFFERED and asserts nothing about the
   * form's validity. (`not_in` on the LIST the choice appends to remains the right place to refuse
   * a collision that arrives by another route.)
   *
   * Absent ⇒ every option is offered, so an existing binding is unchanged.
   */
  offer_when?: ExprString
  /**
   * What this control reads as when it has NOTHING to offer — the view's own sentence, in place
   * of the engine's generic wording.
   *
   * The generic wording says "not yet", which is right for the ordinary cause (a binding that has
   * not resolved) and WRONG for the one a gated offer creates: a set the user has exhausted is
   * complete, not pending, and telling them to wait for options that will never come is a worse
   * empty state than a blank one. Which of the two it is, is the view's to say — the engine
   * cannot know why a list came back empty.
   *
   * Kept short: it is drawn INSIDE the collapsed control as well as under it.
   */
  empty_text?: string
  value: ExprString
  /** extra static dispatch args (each a `$`-ref evaluated against the — possibly `for_each`-bound —
   *  render scope) merged into `onChange`'s payload alongside `value`, so a per-row select in a
   *  `for_each` forwards its loop-bound `index`/`id` (Slice 4; mirrors `RangeSliderWidget.args`). */
  args?: Record<string, ExprString>
  onChange?: string
}

/** Single-line TEXT input bound to a state field (Slice 4). A general primitive the engine lacked
 *  (the only text-edit path was a `table` editable cell); e.g. the cell-filter mask LABEL. */
export interface TextWidget extends WidgetBase {
  kind: 'text'
  label?: string
  value?: ExprString
  placeholder?: string
  /** extra static dispatch args merged into `onChange`'s payload alongside `value`. */
  args?: Record<string, ExprString>
  onChange?: string
}

/** CATEGORICAL keep-set control (Slice 4, ITEM-9/29) — a multi-select of the categories to keep for
 *  a categorical criterion. LOWERS onto `@txresbench/kit` `MultiSelect`; onChange forwards `{...args,
 *  value: string[]}`. General (any processor composes it), NOT cell-filter-named. */
export interface MultiSelectWidget extends WidgetBase {
  kind: 'multiselect'
  label?: string
  /** the selectable options (`string[]` or `{value,label}[]`); empty ⇒ free-type entry. */
  options?: ExprString
  /** See {@link SelectWidget.offer_when} — the same gate, over this control's own option set. */
  offer_when?: ExprString
  /** the current kept set (`string[]`). */
  value?: ExprString
  placeholder?: string
  /** extra static dispatch args merged into `onChange`'s payload alongside `value`. */
  args?: Record<string, ExprString>
  onChange?: string
}

export interface RangeSliderWidget extends WidgetBase {
  kind: 'range_slider'
  label?: ExprString
  range?: ExprString
  value?: ExprString
  /** extra static dispatch args, each a `$`-ref evaluated against the (possibly
   *  `for_each`-bound) render scope and merged into `onCommit`'s payload — so a
   *  per-sample slider forwards its loop-bound `ident`/`criterion` alongside `range`
   *  (research §11 per-sample thresholds). */
  args?: Record<string, ExprString>
  onCommit?: string
}

export interface ListEditorWidget extends WidgetBase {
  kind: 'list-editor'
  label?: ExprString
  /** The bound array. In FLAT mode it is a `string[]`; in CARD mode (with `item`) it is an
   *  array of OBJECTS, each rendered as a card of `item.children` scoped by `$item`/`$index`. */
  items?: ExprString
  /** FLAT mode: the whole (edited) `string[]` is dispatched as `{ items }`. */
  onChange?: string
  /** CARD mode (the per-element template, ITEM-18). When present, each element of the bound
   *  array renders `item.children` in a card, with `$item` (the element) and `$index` (its
   *  position) added to the render scope — the same row-scope idiom `table` uses for `$row`.
   *  A generic repeat of a group of child controls over a `$state` array; DOMAIN-FREE. */
  item?: { children: WidgetSpec[] }
  /** CARD mode: the action dispatched (no args) to APPEND a new element (usually `listAppend`). */
  add?: string
  /** CARD mode: the action dispatched with `{ index }` to REMOVE an element (usually `listRemove`). */
  remove?: string
  /** CARD mode: the "add" affordance label (defaults to "Add"). */
  add_label?: ExprString
  /** CARD mode: the per-card "remove" affordance label (defaults to "Remove"). */
  remove_label?: ExprString
}

/**
 * A generic TAB / segmented group (ITEM-16). A closed set of `tabs`, the active one held in a
 * bound `$state` field (`value`); switching dispatches `onChange` with `{ value: <tab id> }`.
 * Only the ACTIVE tab's `children` render — the domain-free realization of the mockup's
 * Manual/Paste/Import mode-switch. DOMAIN-FREE (no domain nouns; a tab is a tab).
 */
export interface TabsWidget extends WidgetBase {
  kind: 'tabs'
  label?: ExprString
  /** The active tab id (a bound `$state` field). */
  value?: ExprString
  /** Dispatched `{ value: <tab id> }` when a tab is selected. */
  onChange?: string
  /** The tabs, in order; the first is the default active tab. */
  tabs: Array<{ id: string; label: ExprString; children: WidgetSpec[] }>
}

/**
 * A generic TOKEN / chip input (ITEM-17): add/remove free-text tokens as chips, bound to a
 * `$state` `string[]`. Adding (Enter / comma / blur) or removing a chip dispatches `onChange`
 * with the whole new `{ value: string[] }`. DOMAIN-FREE — a "token list", never a typed input;
 * the token vocabulary lives only in the package view that binds it.
 */
export interface TokenInputWidget extends WidgetBase {
  kind: 'token-input'
  label?: ExprString
  /** The bound token array (`string[]`). */
  value?: ExprString
  placeholder?: string
  /** Dispatched `{ ...args, value: string[] }` on every add/remove. */
  onChange?: string
  /** Extra static dispatch args (each a `$`-ref) merged into `onChange`'s payload alongside
   *  `value` — so a `for_each`-bound token list forwards its loop index. */
  args?: Record<string, ExprString>
}

/**
 * What a table's inner content renders as (the `cell:` key on a column). An OPEN record (an extension may add a kind), with the two
 * core kinds named so an author gets completion and the validator can check their dispatch
 * targets:
 *
 *   `editable_text` — an inline editor bound to a field of `$row`.
 *   `button`        — a per-row ACTION. Generic, exactly like the other one: the table is
 *                     the only list primitive with no way to act on ONE row, so a view that
 *                     needed "remove this row" had to bind the row-SELECTION checkbox to a
 *                     destructive action — a control labelled "select" that deletes, which
 *                     is unreachable-by-honest-reading and was in fact inert (the checkbox
 *                     forwards the row's `key`, and `listRemove` wants a positional index).
 *                     A per-row button is the vocabulary that was missing; a bespoke,
 *                     analysis-named widget KIND would have been the INV-6 violation.
 *   `select`        — a per-row CLOSED-SET choice. Same gap, third time: a column whose
 *                     value comes from a fixed vocabulary could only be shipped as free
 *                     text the user can mistype, or as an analysis-named widget kind. Any
 *                     table needs this (a status, a unit, a mode); it names no analysis.
 */
export interface TableCellSpec {
  /** `require` on a value-bearing primitive is evaluated PER ROW, in that row's scope
   *  (DEC-1) — so a blank field on row 2 reports on row 2.
   *
   *  `when` is a PER-ROW render gate, evaluated in that row's scope with the same grammar
   *  `WidgetBase.when` uses. A column is ONE declaration over N rows, but which control a row
   *  NEEDS can be a property of that row — and without a gate a table can only offer every
   *  column to every row, so a control meant for one kind of row silently accepts input on
   *  another and the run applies it. A gated-off primitive is NOT rendered and its `require`
   *  is NOT evaluated, which is the same rule a `when`-gated widget already follows: a
   *  requirement the user cannot see is not one they can meet. */
  editable_text?: {
    value?: ExprString
    onChange?: string
    require?: RequireSpec
    when?: ExprString
    /**
     * What an EMPTY input reads as. Optional, and it earns its place where a column heading
     * stops being able to name the field: two bounds folded into one column share one heading,
     * so "which box is the lower one" has to be said by the boxes. (The accessible name already
     * carries it — this is the same fact, for someone looking at the screen.)
     */
    placeholder?: string
  }
  /** A per-row action button. `args` forward loop-bound values (`{ index: "$index" }`)
   *  exactly as a top-level `button`'s do; `$row`/`$index` are in scope. */
  button?: {
    label?: ExprString
    variant?: 'primary' | 'default' | 'destructive'
    args?: Record<string, ExprString>
    onClick?: string
    /** See {@link ButtonWidget.unavailableReason}. This is the form the per-row `▶` needs
     *  (ITEM-39): the cause is a property of the ROW, so it can only be stated per row. */
    unavailableReason?: ExprString
    /** See {@link TableCellSpec.editable_text}. */
    when?: ExprString
    /**
     * Draw the action as an ICON rather than as its text — the idiom for a per-row action in a
     * dense grid, where the label is the same word on every row and the column heading (or the
     * icon itself) already says which action it is. A text button spends a quarter of a narrow
     * pane restating that.
     *
     * `label` is NOT dropped: it becomes the accessible name (with the row), so the control is
     * still named for a screen-reader / voice user and still carries a hover tooltip. A name
     * that only some users can read would be a worse trade than the width.
     *
     * The value is a key into the renderer's own small registry of row-action icons — a CLOSED
     * set, so a view cannot reach an arbitrary glyph, and an unregistered name falls back to
     * the labelled text button rather than to a blank square.
     */
    icon?: string
  }
  /**
   * A per-row closed-set choice. `options` is a `$`-ref to a `string[]` or a
   * `{value,label}[]` — the LABEL is where a choice says what it MEANS at the point of
   * choosing it, which is the whole reason this is not a free-text column.
   *
   * `onChange` receives `{ ...args, key, index, value }` — byte-identical to what
   * `editable_text` sends, so one row-field action serves both and adding a closed-set
   * column to an existing table needs no new action.
   */
  select?: {
    value?: ExprString
    options?: ExprString
    /** See {@link SelectWidget.offer_when} — evaluated in the ROW's scope, so one row may offer
     *  what another has already taken. */
    offer_when?: ExprString
    args?: Record<string, ExprString>
    onChange?: string
    /** See {@link TableCellSpec.editable_text}. */
    require?: RequireSpec
    /** See {@link TableCellSpec.editable_text}. */
    when?: ExprString
    /**
     * See {@link SelectWidget.empty_text} — the same sentence, for the arm that needed it most.
     *
     * A per-row closed set is fed by a binding that usually depends on ANOTHER control (the
     * columns of the dataset chosen above it), so "nothing to offer" is its ordinary opening
     * state rather than a corner. The engine's generic wording names the SYMPTOM at the exact
     * control a user pokes, while the CAUSE sits somewhere else on the form — and a user pokes
     * the empty picker, not the footer that explains it.
     *
     * The engine cannot write this sentence: it knows the options binding came back empty and
     * nothing whatever about which of the view's OWN controls the reader should answer first.
     */
    empty_text?: string
  }
  /**
   * A per-row MULTI-value choice. The closed-set primitive above commits ONE value; a column
   * whose answer is a SET had no primitive, so it could only ship as free text or as an
   * analysis-named widget kind — the fourth time that same gap appeared.
   *
   * `onChange` receives `{ ...args, key, index, value }` with `value` a string ARRAY, so one
   * row-field action serves this and the single-value primitives alike.
   */
  multiselect?: {
    value?: ExprString
    options?: ExprString
    /** See {@link SelectWidget.offer_when} — evaluated in the ROW's scope. */
    offer_when?: ExprString
    placeholder?: string
    args?: Record<string, ExprString>
    onChange?: string
    /** See {@link TableCellSpec.editable_text}. */
    require?: RequireSpec
    /** See {@link TableCellSpec.editable_text}. */
    when?: ExprString
  }
  [k: string]: unknown
}

export interface TableColumnSpec {
  key?: string
  title?: ExprString
  value?: ExprString
  cell?: TableCellSpec
  /**
   * A FIXED width for this column, in the kit's own vocabulary (`number` px or a CSS length).
   *
   * Declared where a column's content should NOT decide the table's width — an icon-only action
   * box being the case it was added for. A grid lays itself out at content width, so on a narrow
   * pane the widest text column pushes the RIGHTMOST column past the edge; and the rightmost
   * column here is the emit button, i.e. the section's entire purpose, silently off-screen with
   * nothing to say it had happened.
   */
  width?: number | string
  /**
   * May this column's text be TRUNCATED to make the table fit?
   *
   * Opt-in, and it must be: truncation removes information, so it is the view's call which
   * column can afford it. `truncate` alone would not work — `overflow: hidden` clips at the
   * USED width and leaves min-content untouched, so a grid still sizes itself to its longest
   * entry; the kit's `ellipsis` caps the column's minimum, which is what actually lets the
   * table narrow. (The full text stays reachable — the kit keeps it as a native `title`.)
   */
  ellipsis?: boolean
  /**
   * SUB-PARTS sharing this column — each a `TableColumnSpec` in its own right, rendered side by
   * side in the one box a row gets for that column, each keeping its OWN key.
   *
   * It exists because a grid reserves a column's width on EVERY row, and a per-row `when` can
   * make a control that no row of a given kind will ever draw. A criteria row is either
   * continuous (bounds apply, a keep-set is meaningless) or categorical (the reverse), so three
   * columns for those three controls spend permanent width on a control the row cannot use —
   * and a narrow pane is exactly where that is unaffordable. Folded, the column is one FIELD
   * SLOT and the per-row gate decides what fills it.
   *
   * A sub-part is a full part and NOT a reduced shape, which is what keeps the fold free of
   * consequences: its `key` still addresses its verdicts, its testid and its `at.part` exactly
   * as a column key does, and every reader walks it through the shared `tableRowParts`
   * enumeration. Folding therefore changes where a control is DRAWN and not what it is CALLED.
   *
   * A part declares its own primitive OR `parts`, never both (two answers to "what is in this
   * column"), and a part with `parts` declares no `for_each` (the fold is a fixed set of
   * alternatives, not a repetition). `title` belongs to the CONTAINER — one heading over one
   * column — so a sub-part's own title has nothing to name and is not read.
   */
  parts?: TableColumnSpec[]
  for_each?: string
  column?: Record<string, unknown>
}

export interface TableWidget extends WidgetBase {
  kind: 'table'
  rows?: ExprString
  /**
   * What stands in for the grid when the row binding resolves to NOTHING — the view's own
   * sentence, rendered as the description of an empty STATE.
   *
   * A grid with no rows draws its headings over a void: it announces a structure and then
   * withholds every instance of it, which is the least informative thing a surface can do at
   * precisely the moment the reader knows least. Worse, the headings make it look ANSWERED — a
   * form whose most prominent element is a titled, populated-looking frame reads as "this part is
   * done" rather than "this part is empty and you are the one who fills it".
   *
   * The SENTENCE is the view's because the engine cannot write it. Core knows the rows are a list
   * and nothing whatever about what one MEANS, so any wording it supplied would either say
   * nothing ("no rows") or say something about a domain it must not know (INV-6). The view knows
   * both what a row is and which affordance beside the table makes the first one, which is the
   * pair a useful empty state has to state.
   *
   * Absent ⇒ the engine's own heading alone, which is still an empty STATE rather than an empty
   * table. So an existing table is improved without being edited, and a view that has something
   * to say says it.
   */
  empty_text?: string
  /**
   * What this BLOCK is, when a section holds more than one of them.
   *
   * A `table` has column headers and no title, which is right for a section holding one grid
   * and wrong the moment it holds two: the reader then meets two stacked grids whose only
   * stated names are the words above their first COLUMN, and has to infer from those which
   * block is which. The shipped § Colour by is exactly that shape — one grid of grouping
   * columns and one of measured ones — and the owner's report of it is *"I don't know what
   * header is for what"*.
   *
   * Declared by the VIEW rather than derived, for the usual reason: core knows the rows are a
   * list and nothing about what one means (INV-6), so it has no word to supply. Absent ⇒
   * nothing renders and an existing table is unchanged, which is what keeps this from being a
   * migration.
   *
   * It is NOT `label`, and not a `group` wrapper: `group` draws a bordered, tinted CARD, and a
   * card inside a section that is now itself a card is two boxes to say one thing.
   */
  heading?: string
  columns?: TableColumnSpec[]
  selection?: { value?: ExprString; onChange?: string; guard?: ExprString }
}

export interface ButtonWidget extends WidgetBase {
  kind: 'button'
  label: string
  variant?: 'primary' | 'default' | 'destructive'
  /**
   * Boolean `$`-expression that renders the button PRESENT BUT DISABLED — deliberately
   * distinct from `WidgetBase.when`, which removes it from the tree.
   *
   * The two are not interchangeable for an action a user is waiting to take. `qc.yaml`'s
   * only surface holds the RUN button, and the datatype it declares is produced BY that
   * run, so a fresh project shows "No data yet. Run the analysis that produces its input"
   * — with the Run button hidden behind the very message telling the user to run it
   * (`DeclarativeRegion` records the same measured deadlock for its status placement).
   * A control the user must find in order to proceed has to stay visible and say WHY it
   * cannot be pressed yet; hiding it is a dead end with no affordance.
   *
   * Disabled means disabled at the DISPATCH too: the renderer must not run `onClick`.
   */
  disabledWhen?: ExprString
  /**
   * WHY this control refuses, when the refusal is a FACT ABOUT THIS ROW rather than a state of
   * the form (ITEM-29c).
   *
   * A `$`-expression. Resolving to a non-empty string makes the control UNAVAILABLE and that
   * string is the cause the user reads; resolving to null/empty leaves it ordinary. So the
   * reason IS the gate — there is no way to declare a refusal and forget to say why, which is
   * the exact defect this closes: `disabledWhen` carries no reason string, so a declaratively
   * disabled control was indistinguishable from a broken one.
   *
   * It threads to kit's `Button.unavailableReason`, which is aria-disabled (never natively
   * disabled), replaces the tooltip for a pointer user, and hangs an sr-only node off
   * `aria-describedby` for everyone else — while leaving the control's NAME alone, so the
   * reason says why it refused and the name still says WHICH control refused.
   *
   * Distinct from `disabledWhen` and deliberately not a replacement for it: a form-wide
   * incompleteness is stated ONCE beside the submit control (the requirements summary), and
   * restating it on every row would be forty copies of one sentence. This is for the refusal
   * only that row can state — "4,102 levels is too many to colour by".
   */
  unavailableReason?: ExprString
  /** extra static dispatch args (each a `$`-ref) merged into `onClick`'s payload, so a per-row
   *  button in a `for_each` forwards its loop-bound `index`/`id` (Slice 4). */
  args?: Record<string, ExprString>
  onClick?: string
}

export interface AlertWidget extends WidgetBase {
  kind: 'alert'
  tone?: 'info' | 'success' | 'warning' | 'error'
  text?: ExprString
  /** An OPTIONAL affordance beside the text, so a view can guide its own user somewhere.
   *
   *  `launch: 'producer'` is the only form: offer to launch whatever produces what this
   *  analysis CONSUMES. The author writes the sentence; the destination is derived from the
   *  analysis' own `consumes` (DEC-6), so no view ever names another package's analysis.
   *
   *  It does NOT make `alert` a button (DEC-10). An alert stays an informational surface with
   *  an optional affordance; guidance that IS the primary call to action is a `button`, and the
   *  author should declare one. Omitted ⇒ the alert renders exactly as it always has. */
  action?: { launch: 'producer' }
}

export interface StatWidget extends WidgetBase {
  kind: 'stat'
  label?: string
  value?: ExprString
}

export interface GroupWidget extends WidgetBase {
  kind: 'group'
  label?: ExprString
  children: WidgetSpec[]
}

/**
 * `lineage` — the frozen-artifact VERSION-CHAIN readout (INV-7 / DEC-11). A DISPLAY widget (no
 * value binding): given a bound frozen artifact id, it walks that artifact's lineage chain
 * (`GET /api/drafts/artifacts/{id}/lineage`) and renders `v3←v2←v1` (current bold, superseded
 * dimmed — not hidden) plus the per-set `+A −B` membership delta between the current version and
 * its parent. DOMAIN-FREE: the set/member field names ride in as config (`values_field` is the
 * domain noun), so the widget speaks only "sets" and "members" — a registered visualize kind
 * (not a core form control), like `entry_list`.
 */
export interface LineageWidget extends WidgetBase {
  kind: 'lineage'
  label?: string
  /** The frozen artifact id whose version chain to render (a `$`-expr, e.g.
   *  `$state.selected_artifact_id`). Empty/absent ⇒ the widget renders nothing. */
  artifact?: ExprString
  /** The structure key holding the per-set records (default `sets`). */
  sets_field?: string
  /** The set-record field holding each set's member list — the domain noun rides HERE. */
  values_field: string
  /** The set-record field holding a set's display name (default `name`). */
  name_field?: string
  /** Copy shown for a first (unforked) version that has no lineage to show. Optional — a
   *  single-version artifact renders nothing when this is absent. */
  empty_text?: string
}

export interface DatasetPickerWidget extends WidgetBase {
  kind: 'dataset-picker'
  label?: string
  accepts?: string[]
  value?: ExprString
  onChange?: string
}

// ---------------------------------------------------------------------------
// artifact_ref — the view's OWN input picker (INV-2 / INV-4)
// ---------------------------------------------------------------------------

/**
 * A CATALOG source: the artifacts of a datatype (or its subtypes), project-wide.
 *
 * Deliberately NOT the manifest's `TypeSelector`. The manifest's `appliesTo` is a fact
 * about the ANALYSIS ("this one applies to raw-count matrices") and the workbench
 * derives availability from it; what a control OFFERS is the view's own decision and may
 * legitimately be narrower, wider, or a selection `appliesTo` cannot express at all
 * (INV-2). Typing this as `TypeSelector` would re-tie the two and re-open the coupling
 * this round removes — so the shapes are separate even where they currently rhyme.
 */
export interface CatalogArtifactSource {
  /** an exact datatype id. */
  datatype?: string
  /** any subtype of this id. */
  subtypes_of?: string
  /** required datatype capabilities — a datatype missing any of them is not offered. */
  capabilities?: string[]
  /**
   * Datatype ids (or their subtypes) to REJECT even when the base match holds — the
   * "subtypes of X except Y" primitive.
   *
   * A raw-count-only analysis is the case that requires it: a NORMALIZED matrix is a
   * subtype of the same parent, so `subtypes_of: matrix` alone offers it. Running such an
   * analysis on already-normalized values yields numbers that are arithmetically fine and
   * meaningless for the question asked — a wrong answer with no error, which is the
   * failure shape this whole round is removing.
   */
  excludes?: string[]
  /**
   * How many COMPONENTS an offered artifact must declare — its second declared dimension.
   *
   * The one source term that narrows by SHAPE rather than by kind or by identity, and it
   * exists because a capability is not a shape: `plottable-xy` says an artifact carries
   * positions, and a decomposition carrying fifty of them declares it just as truthfully as a
   * two-component layout does. A pane that draws a picture in two axes can use exactly two, so
   * § Coordinates declares `dims: 2` and a 50-component artifact is NOT OFFERED — no component
   * picker, no "first two" default, which would be `layouts[0]` choosing which of fifty
   * projections the user meant.
   *
   * DECLARED, never inferred (INV-11): the count is read off the producer's own `structure`,
   * no bytes are fetched, and an artifact that declares no shape does not match — the same
   * fail-closed direction `excludes` and `capabilities` take, and for the same reason (a
   * narrowing that cannot be evaluated must not offer the thing it exists to exclude).
   */
  dims?: number
}

/**
 * An AXIS-SCOPED source: the sibling artifacts on `axis` of the dataset the artifact
 * referenced by `of` belongs to.
 *
 * This is the form that cannot be a manifest key, and the reason is `of`: the candidate
 * set depends on ANOTHER CONTROL'S CURRENT VALUE. "Which columns carry the display names"
 * is only answerable once the user has said which matrix they are running on, and the
 * manifest is read before any of that exists.
 *
 * It is therefore EMPTY, not "all artifacts", until `of` resolves to a value — an empty
 * picker that says so is honest, whereas a project-wide fallback would silently offer
 * columns from a different dataset (INV-4: what is launched is what was shown).
 */
export interface AxisScopedArtifactSource {
  /** the declared axis LABEL (`AxisSpec.name`) the siblings sit on. */
  axis: string
  /** a `$`-ref to the artifact id that anchors the dataset + axis (usually another
   *  control's value, e.g. `"$state.matrices[0]"`). */
  of: ExprString
  /** narrow the siblings to a datatype id or its subtypes. */
  datatype?: string
  /** required datatype capabilities (see {@link CatalogArtifactSource.capabilities}). */
  capabilities?: string[]
  /** datatype ids (or their subtypes) to REJECT (see {@link CatalogArtifactSource.excludes}). */
  excludes?: string[]
  /** narrow to artifacts whose members declare this VALUE kind — the producer's
   *  `numeric` / `categorical` / `string` declaration. Kept an open string: the kind
   *  vocabulary is the producer's, not this contract's (INV-6).
   *
   *  ONE term is resolved by the app rather than matched literally — `text`, meaning
   *  "text-valued, HOWEVER ENCODED" (see `axisSource.ts::valueKindsFor`). Prefer it for a
   *  "which column holds the labels" control. A producer's `kind` names an ENCODING —
   *  `string` is inline utf8, `categorical` is dictionary-encoded — so asking for `string`
   *  asks for one storage choice, and on a real dataset that admitted ONLY the axis's own
   *  index column while excluding every label column beside it. Every other term is matched
   *  exactly, so naming one encoding on purpose still works. */
  values?: string
}

/**
 * A ROW-SPACE-SCOPED source: the artifacts whose values are declared to line up with the
 * points of the anchored row space (ITEM-17).
 *
 * The third form, and it asks a different question from the two above. `CatalogArtifactSource`
 * and `AxisScopedArtifactSource` both narrow by KIND and by which dataset an artifact belongs
 * to; this one narrows by IDENTITY — *may these values be painted on those points?* — which no
 * amount of kind-matching answers. A section can be perfectly applicable (the project holds
 * artifacts of the right kind) while a given candidate within it belongs to a different row
 * space, and offering it would paint one dataset's values on another's coordinates with
 * nothing on screen to say so (design §6.1).
 *
 * The view declares WHICH row space (`aligned_to`, a `$`-ref, in practice `"$scope.axis"`) and
 * nothing else: HOW alignment is decided is the engine's, so a view can neither weaken it nor
 * get it wrong. Unresolved ⇒ EMPTY, on the same INV-4 rule as `of` above — with no anchor
 * there is no row space for a candidate to be aligned TO, and offering everything would be the
 * project-wide fallback that rule exists to prevent.
 */
export interface RowSpaceScopedArtifactSource {
  /** a `$`-ref to the anchored row space's IDENTITY — an `AxisSummary.content_hash`, never
   *  a label and never a dataset id (INV-1). */
  aligned_to: ExprString
  /** narrow to a datatype id or its subtypes. */
  datatype?: string
  /** any subtype of this id (see {@link CatalogArtifactSource.subtypes_of}). */
  subtypes_of?: string
  /** required datatype capabilities (see {@link CatalogArtifactSource.capabilities}). */
  capabilities?: string[]
  /** datatype ids (or their subtypes) to REJECT (see {@link CatalogArtifactSource.excludes}). */
  excludes?: string[]
}

/** Where an `artifact_ref` widget's candidates come from. Discriminated by the presence
 *  of `axis` / `aligned_to`; the narrowing predicates live with the resolver
 *  (`core/runtime/axisSource.ts`), so this file stays pure-type. */
export type ArtifactRefSource =
  | CatalogArtifactSource
  | AxisScopedArtifactSource
  | RowSpaceScopedArtifactSource

/**
 * An ARTIFACT-REF input control — the visible form of an input the run consumes (INV-4).
 *
 * It replaces the auto-resolution that threw `found ${options.length}` whenever the
 * candidate count was not exactly 1: the input is now a control the user can SEE before
 * Run and correct when the guess is wrong — the case where a hardcoded column source
 * matched NOTHING and the run reported a silent zero rather than an error. (The concrete
 * incident is in `docs/design/processor-manifest-ui-separation.md`.)
 *
 * The widget declares its OWN `source` (INV-2) — it never reads the manifest's
 * `appliesTo`, so what the form offers is a view decision, not a registration one.
 */
export interface ArtifactRefWidget extends WidgetBase {
  kind: 'artifact_ref'
  label?: string
  /**
   * The control's ACCESSIBLE name, when a visible `label` would only repeat what is already
   * on screen above it.
   *
   * § Coordinates is the case: its section header says *"Coordinates"* (the host's frame, from
   * the manifest) and its one picker declared `label: Coordinates` as well, so the word printed
   * twice one line apart and the second copy carried nothing. Dropping the visible label alone
   * would have been a REGRESSION of a different kind — the radiogroup's accessible name is
   * derived from `label`, so it would have degraded to the generic fallback and a screen-reader
   * user would have lost the name a sighted one is reading off the header.
   *
   * So the two are separated: `label` is what RENDERS, this is what the control is CALLED. When
   * only this is declared, nothing is drawn and the name is intact. `label` still supplies both
   * when it is declared, so no existing widget changes.
   */
  aria_label?: string
  /** the candidate set this control offers (INV-2 — the view's own declaration). */
  source?: ArtifactRefSource
  /**
   * The view's OWN sentence for the arm where this control's `source` resolves ZERO
   * candidates — "there is nothing of this kind in the project yet", in the view's words.
   *
   * It is declared HERE, on the control, rather than written as an `alert` with a `when`
   * predicate, and that is a correctness property rather than a placement preference. A
   * view cannot observe candidate availability at all: `evalWhen` reads `$state`,
   * `$derived`, `$data`, `$const` and the capability set, and the artifact catalog is
   * deliberately an INTERNAL channel a view may not query. So every attempt to write this
   * condition ends up testing the nearest thing a view CAN see — its own selection state —
   * and the two are different propositions.
   *
   * Both shipped views made exactly that substitution and shipped the resulting lie: an
   * alert reading "no matrix in this project yet" gated on `matrices.length == 0`, which
   * is ALSO true when the project holds several and the user has not picked one. Since the
   * sole-candidate arm auto-binds, the message appeared precisely when there was MORE than
   * one of the thing it said there were none of, and got more confident the more data was
   * imported.
   *
   * Declared on the control there is no predicate to get wrong: the engine already knows
   * the candidate count at the only point where the answer exists, and the sentence cannot
   * drift from the `source` it is about.
   *
   * It replaces the engine's generic wording for the PROJECT-WIDE absence only. An
   * axis-scoped source with no anchor yet is a different absence — that control is waiting
   * on the one above it, and telling the user to import something would send them
   * somewhere that cannot help — so that arm keeps its own wording.
   */
  empty_text?: string
  /**
   * BIND the sole candidate automatically when the source resolves exactly one (R2 / INV-3).
   *
   * **Opt-IN. Absence means OFF** (DEC-15), and that is the whole point: R2 forbids a resolver
   * taking `[0]`, and says that if auto-binding is wanted it must be a DECLARED affordance *"so
   * the form shows what it bound"*. Before this key the behaviour was unconditional and had no
   * opt-out — a live R2 violation, and the reason ITEM-13's auto-anchor could not be built on
   * top of it.
   *
   * Declaring it does not guarantee it fires. INV-10: *"a marked or contested candidate is never
   * chosen FOR the user … Sole candidacy is not consent."* So the bind is still refused for a
   * candidate whose label was CONTESTED in this offer, and for one whose alignment to the
   * anchored row space is undeclared (A3) — and the control says which, rather than silently
   * doing nothing.
   *
   * A package that declares nothing gets an ordinary, UNBOUND picker holding one option, which
   * is a legible state: the user sees the single candidate and chooses it.
   */
  auto_bind_sole_candidate?: boolean
  /**
   * WHICH SINGLE-CHOICE CONTROL renders — a searchable list (the default) or a RADIO.
   *
   * Declared per widget rather than inferred, and rather than made the default. The seam also
   * serves run forms whose `source` resolves hundreds of candidates, where a radio is the wrong
   * control; and the one place it is emphatically the RIGHT control — the pane's frame picker
   * (owner, DEC-10: *"Row space and Coordinates are RADIO — one active choice each"*) — is the
   * one place where seeing every alternative WITHOUT a gesture is the whole point. An unopened
   * dropdown reading `Layout A` gives no hint that a second set of positions exists, which is
   * the mistake the visualize pane exists to prevent.
   *
   * Ignored by the `multiple` arm, which is not a single choice at all.
   *
   * Above `ARTIFACT_REF_RADIO_MAX` candidates the renderer falls back to the list and SAYS so —
   * a declared threshold, never a silent substitution.
   */
  control?: 'radio'
  /**
   * SELECT THE FIRST CANDIDATE when nothing is selected yet (owner, ledger #24: *"Always select
   * the first … please"*, of the thing this control offers — the owner's own noun is a domain
   * one and stays in the ledger, which is where domain vocabulary belongs).
   *
   * ── It reverses `auto_bind_sole_candidate`'s rule, deliberately, and only where declared ──
   *
   * INV-10 says sole candidacy is not consent, and it is right about the case it was written
   * for: a control that SILENTLY resolved a binding the user never saw, whose consequence was a
   * confident picture drawn from something they did not pick. That is a rule about INVISIBLE
   * binding.
   *
   * This is a different act. The control it applies to is a RADIO: every candidate is on screen
   * at once, the chosen one is visibly checked, changing it is one click, and the selection
   * carries the `auto` binding-origin mark — so nothing is hidden and nothing is asserted that
   * the user cannot see and undo. What it removes is an opening state in which the pane shows a
   * list and refuses to do anything with it until a gesture that has exactly one sensible
   * answer.
   *
   * It is therefore NOT gated on the INV-10 refusals (`ambiguous` / `alignmentUnknown`): the
   * project this exists for is one where every candidate contests the same declared name, i.e.
   * precisely the state those refusals fire on, and refusing there would make the declaration a
   * no-op on the only data it was asked for. The marks stay — a contested option still shows its
   * qualifier and an A3 one still shows its mark; what changes is that the pane opens with a
   * frame instead of with a question.
   *
   * Opt-IN, per widget: absence is OFF (DEC-15), so every existing picker is untouched.
   * `multiple` ignores it — "the first" is not a set.
   */
  auto_select_first?: boolean
  /**
   * A PER-OPTION action button, rendered on each row of the `radio` arm beside the choice —
   * the mockup's own row-by-row `▶` (owner, ledger #27: *"each … should have that button"*),
   * replacing a single wide button at the foot of the card.
   *
   * It is the SAME control the emitting sections' rows carry (`TableCellSpec.button` /
   * `EntryListWidget.action`) — icon-only, named for its subject rather than for the verb — so
   * one pane does not spell one verb two ways.
   *
   * A row is a CHOICE and a VERB at once here, which is the one thing this arm has that the
   * others do not: choosing the frame and drawing it are different acts on the same row, so the
   * button MUST NOT change the selection. The renderer suppresses the label's own activation for
   * that reason, and an e2e asserts the two stay independent.
   *
   * `args` and `unavailableReason` are evaluated in a scope carrying `$option`
   * (`{ id, label }`), so a view addresses the row the press came from without the engine
   * inventing a vocabulary for it.
   */
  row_action?: {
    label?: string
    icon?: string
    onClick?: string
    args?: Record<string, ExprString>
    unavailableReason?: ExprString
  }
  /** select several (the value binding is then an id ARRAY). */
  multiple?: boolean
  /** the selected artifact id, or id array when `multiple`. */
  value?: ExprString
  /** extra static dispatch args merged into `onChange`'s payload alongside `value`. */
  args?: Record<string, ExprString>
  onChange?: string
}

/** One SOURCE an entry resolved to — the provenance an `entry_list` row states (INV-6).
 *  `artifact` + `selector` is the identity (INV-1: never the title); `title` is display only. */
// `alignment_mark` / `plot_note` are DELETED from this shape (owner, ledger #28 + #29): the
// pane no longer tells anyone about undeclared alignment, on a row or on an emitted plot. The
// sources it offers are unchanged. See the note at the top of `runtime/rowSpaceColumns.ts`.
export interface EntryListSource {
  artifact: string
  selector?: string
  datatype?: string
  title?: string
}

/**
 * `entry_list` — a searchable list of AXIS ENTRIES, each of which resolves to zero or more
 * COLUMNS (design §5.6, DEC-2 / ITEM-23).
 *
 * It is a new KIND rather than a `multiselect` because a token cannot carry any of the four
 * things this control exists to say: WHICH sources an entry resolved to, that it resolved to
 * ZERO (U1), a per-source sub-toggle under disposition `each`, or the active-filter badge.
 * kit's `MultiSelect` is virtualised and would have covered the scale objection — scale was
 * never the objection.
 *
 * It is registered through the ordinary `registerWidget` seam and is deliberately NOT in core's
 * `WIDGET_KINDS` (DEC-2): core's list is the FORM-CONTROL vocabulary that must be complete by
 * kind, and putting a visualize-specific control in the transport layer is exactly what the
 * open-kind seam exists to stop.
 */
export interface EntryListWidget extends WidgetBase {
  kind: 'entry_list'
  label?: string
  /** the offered entries — a `string[]` of keys, or `{key,label?}[]` when a key displays as
   *  something else. The KEY is the identity; the label is never keyed on (INV-1). */
  entries?: ExprString
  /** `{ <entryKey>: EntryListSource[] }` — what each CHOSEN entry resolved to. A key that is
   *  absent or maps to `[]` is the U1 state: chosen, and resolved to nothing. The two are one
   *  state here on purpose — "no sources" and "no answer about sources" are the same fact from
   *  the user's side, and the control says it with `unresolved_text` either way. */
  sources?: ExprString
  /** the chosen entry keys (a `string[]`). */
  value?: ExprString
  onChange?: string
  /** the persistent search affordance. An open set is SEARCHED, not scrolled — which is the
   *  other half of why this is not a dropdown. */
  search?: { placeholder?: string }
  /** INV-5 — the view's own sentence for "there is nothing to offer", REQUIRED on a control
   *  whose `entries` binding depends on another control, because a view cannot observe
   *  candidate availability at all. */
  empty_text?: string
  /** INV-6 / U1 — what a CHOSEN entry that resolved to zero columns reads as. It is a separate
   *  string from `empty_text` because they are different facts: one is "nothing is offered",
   *  the other is "what you picked is not here". */
  unresolved_text?: string
  /**
   * Whether the entries were actually LISTED — the engine's own `browsable` (ITEM-63).
   *
   * `empty_text` is a claim about the AXIS ("it resolved and holds no entries"), and an empty
   * `entries` binding does not establish it: the axis may have been REFUSED as over-budget
   * (4.1M entries — the section's alert says so on the same surface), or no row space may be
   * anchored yet. Rendering `empty_text` for those printed two sentences of which one was
   * false. So the claim is gated on the engine saying the list exists.
   *
   * Absent ⇒ the view makes no claim and `entries` is the whole truth (every view written
   * before this gate). Declared ⇒ only a literal `true` is a listing; anything else renders
   * NOTHING, leaving the sentence to whoever knows WHICH absence it is.
   */
  browsable?: ExprString
  /**
   * What a consumer does with an entry's N columns (design §5.5). The ENGINE never decides
   * (INV-19); the control only renders what the declaration says.
   *
   * `each` is the one that changes this control: N columns are N separate outputs, so each
   * source is individually addressable and gets its own sub-toggle. Under `combined` (N series,
   * one output) and `one` (`where` narrows to exactly one column) the sources are not
   * separately choosable, so a sub-toggle would offer a choice that does not exist.
   */
  disposition?: 'each' | 'combined' | 'one'
  /** `{ <entryKey>: string[] }` — the ENABLED source ids per entry, for the `each` sub-toggles.
   *  Absent ⇒ every source is enabled, which is what `each` means with nothing said. */
  source_value?: ExprString
  /** dispatched as `{ entry, source, value }` when a per-source sub-toggle changes. */
  onSourceChange?: string
  /**
   * The declared GROUPS these entries fall into, `[{name, count}]` (ITEM-54).
   *
   * The counts are the DECLARED totals, not the number currently shown, so a heading under a
   * query can read `1 of 18,204` — which says both what matched and how much is not being
   * shown. A group with no matches is not rendered at all: a heading claiming matches it does
   * not have *"inverts what the heading was"* (kit's own `filterRuns` rule, applied here
   * because this control does its own filtering).
   */
  groups?: ExprString
  /** ITEM-56 — whether headings render AT ALL. ONE group is not a grouping, and a single
   *  heading over everything is noise. Declared as a binding rather than derived from
   *  `groups.length` so the ENGINE owns the rule (a view cannot see the whole offer). */
  grouped?: ExprString
  /**
   * The header's DISPLAY-name select (ITEM-48 / ITEM-49 / ITEM-56).
   *
   * It governs DISPLAY only — which annotation renders as each row's name. It changes nothing
   * about what is searched, emitted or plotted, and the control has no other authority.
   * `when` is the engine's *"is there anything to distinguish?"* answer: one declared option
   * ⇒ the select does not RENDER (not merely disabled), because a control offering one choice
   * is a statement that there was a decision to make.
   */
  show?: {
    label?: string
    options?: ExprString
    value?: ExprString
    onChange?: string
    when?: ExprString
    /** what the section SAYS about the choice it made for itself — ITEM-49's *"and the
     *  section says that is what it picked"*. Rendered only while the choice is the default. */
    note?: ExprString
  }
  /**
   * The per-row ▶ (ITEM-30 / ITEM-34 / ITEM-59) — a row is a VERB, not a choice.
   *
   * Declared, so a list that has no act to offer renders none rather than a dead control.
   * Under disposition `each` the PARENT ▶ dispatches once per source (ITEM-59: one click, N
   * plots) and each source additionally carries its own ▶ that dispatches exactly one; under
   * `combined`/`one` it dispatches once.
   */
  action?: {
    label: string
    icon?: string
    onClick: string
    /** extra args, evaluated with `$row` bound to the entry and `$source` to the source. */
    args?: Record<string, ExprString>
  }
  /** ITEM-33 — `{ <entryKey>: n }` (or `count_by`'s `{before, after}` record), the number of
   *  plots of that entry currently open. A small numeral, absent at zero: it must not read as
   *  a SELECTED state, because a row carries none. */
  counts?: ExprString
}

/** viz widget encode-binding (metric columns → axes / color / group). */
export interface VizEncode {
  x?: ExprString
  y?: ExprString
  colorBy?: ExprString
  groupBy?: ExprString
  [channel: string]: ExprString | undefined
}

export interface ScatterWidget extends WidgetBase {
  kind: 'scatter'
  title?: string
  points?: ExprString
  groups?: ExprString
  hidden?: ExprString
  encode?: VizEncode
  /** the resolved columnar frame the metric layout + colorBy read from (`$data.<slice>`).
   *  The x/y `encode` channels name COLUMNS within it. */
  frame?: ExprString
  /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`; see `DerivedSpec.keep_mask.obs`. */
  obs?: ExprString
  // C5 (DOMAIN_AUDIT): the `embeddings?: ExprString` channel is DELETED. It made a 2-D
  // biological embedding a first-class field of the general widget contract (its own doc
  // named the slice `$data.vis2D`, which pins the dimensionality at 2), and it had ZERO
  // readers — no renderer, no resolver, no shipping view_spec. Point COORDINATES now reach
  // the canvas through the canvas host, attached to the canvas's own default dataset base
  // (`extensions/canvas/canvasHostProvider`), and a scatter binds its axes through the
  // general `encode.x`/`encode.y` channels like every other plot.
  /** per-metric inclusive keep-ranges (`$state.filteringParams` shaped
   *  `{metric:[lo,hi]}`) → the dense scatter's value-range `filters` (DEC-1: sliders,
   *  no per-point mask). */
  filters?: ExprString
  /** the brushed gate index-set (`$state.gate`) → the scatter's selection-dim (DEC-1). */
  selection?: ExprString
  onSelect?: string
  onFilter?: string
}

export interface ViolinWidget extends WidgetBase {
  kind: 'violin'
  title?: string
  points?: ExprString
  groups?: ExprString
  hidden?: ExprString
  encode?: VizEncode
  /** the resolved columnar frame (`$data.<slice>`); `encode.groupBy`/`valueKey`
   *  name columns within it. */
  frame?: ExprString
  /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`; see `DerivedSpec.keep_mask.obs`. */
  obs?: ExprString
}

/** GENERAL bar-chart widget (DEC-12) — a categorical value chart LOWERING onto the
 *  EXISTING `@txresbench/viz` `bar` chart kind (no new viz API). NOT analysis-named: any
 *  processor composes it. `encode.groupBy`/`.x` names the categorical column. */
export interface BarWidget extends WidgetBase {
  kind: 'bar'
  title?: string
  groups?: ExprString
  hidden?: ExprString
  encode?: VizEncode
  /** the resolved columnar frame (`$data.<slice>`); `encode.groupBy` names a column. */
  frame?: ExprString
  /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`; see `DerivedSpec.keep_mask.obs`. */
  obs?: ExprString
}

/** GENERAL histogram widget (DEC-12) — a continuous-value distribution LOWERING onto
 *  the EXISTING `@txresbench/viz` `histogram` chart kind (no new viz API). `encode.x`/`.value`
 *  names the continuous column. */
export interface HistogramWidget extends WidgetBase {
  kind: 'histogram'
  title?: string
  points?: ExprString
  hidden?: ExprString
  encode?: VizEncode
  /** the resolved columnar frame (`$data.<slice>`); `encode.x` names a continuous column. */
  frame?: ExprString
  /** @deprecated r3canvas — DUAL-ACCEPTED alias of `frame`; see `DerivedSpec.keep_mask.obs`. */
  obs?: ExprString
}

/** GENERAL image-underlay widget (DEC-12 / INV-16) — a raster underlay (+ optional point
 *  overlay) LOWERING onto the EXISTING `@txresbench/viz` `image` view-kind + `imageUnderlay()`
 *  data source (no new viz API). `image` resolves an `ImageUnderlay`-shaped payload
 *  (`$data.image`); `points` an optional positions map (`$data.spatial`). */
export interface ImageWidget extends WidgetBase {
  kind: 'image'
  title?: string
  /** the resolved image-underlay payload (`$data.image` → `{ data, width, height, channels, affine }`). */
  image?: ExprString
  /** an optional spatial positions map overlaid on the raster (`$data.spatial`). */
  points?: ExprString
  encode?: VizEncode
}

export type WidgetSpec =
  | SelectWidget
  | TextWidget
  | MultiSelectWidget
  | RangeSliderWidget
  | ListEditorWidget
  | TabsWidget
  | TokenInputWidget
  | TableWidget
  | ButtonWidget
  | AlertWidget
  | StatWidget
  | GroupWidget
  | LineageWidget
  | DatasetPickerWidget
  | ArtifactRefWidget
  | EntryListWidget
  | ScatterWidget
  | ViolinWidget
  | BarWidget
  | HistogramWidget
  | ImageWidget

/** The enforced widget-`kind` NAME SET + the `EffectSpec` op NAME SET moved to
 *  `core/spec/vocabulary.ts` (ITEM-3) — beside `parseViewSpec`, their only
 *  enforcement point. This file stays PURE-TYPE + dependency-free (the shared
 *  contract shape); import `WIDGET_KINDS` / `WidgetKind` / `EFFECT_OPS` /
 *  `EffectOp` from `@/modules/workbench/core` (or `core/spec/vocabulary`). */

// ---------------------------------------------------------------------------
// Actions — the verbs, declared in the same spec
// ---------------------------------------------------------------------------

/**
 * ONE data-driven input binding on `run_processor` — the `inputs_from` entry.
 *
 * `inputs` is a literal `{ slot → artifact id }` map, and a literal map can only carry slots
 * whose NAMES the spec author knew when they wrote the file. Some slots are named by the
 * user's own selection: a compute resolves each metadata column on `column:<name>`, because
 * a single-column store carries its values under the constant member `values` and cannot
 * carry its own name — so the name has to arrive with the binding. Which columns exist is
 * data; which of them a run consumes is a choice the user makes in the form. Neither is
 * expressible as a literal key.
 *
 * So `inputs_from` is the repeater for the `inputs` map, built from the two constructs a
 * spec author already writes everywhere else — `for_each` and a `when` gate — plus `{expr}`
 * interpolation in the slot name (the same `{…}` segment form a `set` field-path uses).
 * It EXTENDS `inputs`; it does not replace it, so the static bindings stay readable as
 * static bindings.
 *
 * A binding that passes `when` and resolves to no artifact is an ERROR, not a skip: silently
 * dropping it is precisely the failure this construct exists to remove (a criterion the user
 * built, on a column the run never received, filtering nothing at rc=0). Use `when` to say
 * which iterations are legitimately not bindings — a criterion whose column is still blank.
 */
export interface InputBindingSpec {
  /** repeat this binding over a list: `"$state.criteria as $c"` (`, $i` binds the index). */
  for_each?: ExprString
  /** skip an iteration whose gate is false — e.g. `"$c.column"` for a not-yet-filled row. */
  when?: ExprString
  /** the SLOT name. `{…}` segments are interpolated against the iteration scope
   *  (`"column:{$c.column}"`); the rest is literal. */
  slot: string
  /** a `$`-ref resolving to the artifact id to bind (`"$data.obsSources[$c.column]"`). */
  artifact: ExprString
}

/** A declared effect — the app INTERPRETS this over `ctx`; it is never JS. */
export type EffectSpec =
  | { set: Record<string, unknown> }
  | { api: { call: string; args?: Record<string, unknown>; into?: string } }
  // `inputs` and `params` are SEPARATE channels and must stay so (INV-4). `inputs` is a
  // `{ slot → artifact id(s) }` map the view passes EXPLICITLY from its own state — the run
  // consumes exactly what the form showed. `params` is the plain-value payload the compute
  // reads from `params.json`. Merging them (the shape this key had while the shipped views
  // were migrated to declare `inputs:`) means a scalar param is indistinguishable from an
  // artifact id at the launch site: a plain string param binds as a phantom artifact input,
  // and an input declared ONLY in `inputs` is dropped entirely.
  | {
      run_processor: {
        id: string
        inputs?: Record<string, unknown>
        /** data-driven bindings MERGED into `inputs` — the repeater for slots whose NAME is
         *  a user selection rather than a literal the author could write. See
         *  {@link InputBindingSpec}. */
        inputs_from?: InputBindingSpec[]
        params?: Record<string, unknown>
        into?: string
      }
    }
  | { wait_for: { job: ExprString; until?: string } }
  | { progress: ExprString }
  | { toast: { success?: string; error?: string } | ExprString }
  | { open_view: { view: string; with?: Record<string, unknown> } }
  | { close_view: Record<string, never> }
  | { call_action: { id: string; params?: Record<string, unknown> } }
  // Dynamic-list mutation (DEC-9) — the criteria / qc_metrics list mechanisms. Each is a
  // reviewed INV-4 app change (a new union variant = a commit to the app), NOT a processor-
  // shipped closure. `path` is a `set`-style field path (`{expr}` segments interpolated).
  | { listAppend: { path: string; value: unknown } }
  | {
      listRemove: {
        path: string
        /** remove by position — an `ExprString` resolving to a numeric index. */
        index?: ExprString
        /** remove by id/value — drop elements whose every listed field equals the resolved value. */
        match?: Record<string, unknown>
      }
    }


/** A declared action: registered into the LIVE `defineAction` registry at
 *  view_spec load with a `run` that interprets `body` (research §10). A
 *  mandatory `permission` makes it backend-authoritative + AI-drivable exactly
 *  like a hand-written action. */
export interface ActionSpec {
  id: string
  title: string
  permission: string
  mutating?: boolean
  stateful?: boolean
  /** where the action is exposed — `palette` (human) / `ai` (agent). Defaults
   *  applied by the collector when omitted (ITEM-10). */
  surfaces?: { palette?: boolean; ai?: boolean }
  params: Record<string, unknown>
  body: EffectSpec[]
}

// ---------------------------------------------------------------------------
// The top-level view_spec
// ---------------------------------------------------------------------------
//
// There is NO `layout` key (INV-3), and no `area`/`region` key either. A view spec is
// ONE FRAGMENT of its analysis' single pane: `widgets` is its order, top to bottom,
// and several `ui:` files of one analysis stack in the order the manifest lists them
// (`runtime/seam.ts::viewSpecsToContribution` builds ONE contribution per ANALYSIS from
// the whole list). The pane's dock placement is the ANALYSIS' — a fragment declaring
// its own would make two files of one analysis a conflict with no answer — so
// `parseViewSpec` refuses `area`/`region` the same way it refuses `layout`.
//
// `layout.regions` was a widget-id→dock-region map, and it made ONE analysis mount as
// up to three panes carrying the same title, each holding a fragment of one form. It
// also made every widget id load-bearing twice (declaration + placement), so a widget
// with no id silently never rendered. `parseViewSpec` REFUSES a spec that still
// declares it — loudly, naming the key — rather than ignoring it, because a dropped
// layout would silently re-order somebody's form.

export interface ViewSpec {
  id: string
  title: string
  /** MANDATORY permission — backend-authoritative gate on the whole surface. */
  permission: string
  state: Record<string, StateFieldSpec>
  data?: Record<string, DataSourceSpec>
  derived?: Record<string, DerivedSpec>
  const?: Record<string, unknown>
  /** The pane's contents, rendered TOP TO BOTTOM in this order (INV-3). */
  widgets: WidgetSpec[]
  /** OPTIONAL cross-field constraints (DEC-3) — the ONE place a free-form predicate
   *  survives, scoped to a relation the closed `require` vocabulary cannot express. */
  checks?: ViewCheckSpec[]
  actions: ActionSpec[]
  /**
   * OPTIONAL declarative CANVAS plot(s) (declarative-canvas-plots ITEM-1): a `@txresbench/viz`
   * `VizOption` (strict-JSON `datasets[]` / `grid[]` / `series[]` / `filters` / `encode`) the
   * workbench RESOLVES (`$state`/`$derived` ref resolution + `for_each` multi-dataset expansion)
   * and drives the SINGLE canvas `GridWorkspace` via `VizController.setOption` — NOT a second
   * `<Viz>`. Kept OPAQUE here so this contract stays dependency-free; the app validates it against
   * the viz option schema (`parseOption`, via `validateCanvasOption`) and augments each
   * `series`/`datasets` entry with an optional `for_each` clause. Dataset ids are LOGICAL
   * (`obs` / `obs.kept` / `<ds>.obs` / `<ds>.kept`), resolved by the engine's `DatasetResolver`.
   */
  canvas?: unknown
  /**
   * WHAT THIS VIEW IS HOLDING, as a number its host may state on its behalf (visualize-pane
   * ITEM-64 / R6).
   *
   * An expression over this view's OWN state (`"$state.plots.length"`). A section is drawn in a
   * frame the HOST owns — so a section cannot forget to have one — and the host must not read a
   * section's fields to decide what "holding something" means; the section says so here, and the
   * host learns a number.
   *
   * Absent ⇒ no badge, which is the honest "holds nothing". Resolving to zero is the same
   * answer: a badge is a mark that there IS something, so zero is not a small badge.
   */
  badge?: ExprString
}
