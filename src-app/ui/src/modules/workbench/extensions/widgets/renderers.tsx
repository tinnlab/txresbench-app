// Per-kind widget RENDERERS (PLAN.md ITEM-7) for the NON-VIZ kinds. Each wraps a
// `@ziee/kit` primitive, reads its value(s) via `$`-ref bindings (`evalExpr` over
// the render scope), and dispatches its onChange/onCommit/onClick through
// `ctx.dispatch` (→ `runAction` of the bound declared action, view_id injected).
// A renderer is pure config-over-kit: it never ships a plot compiler or a JS
// closure (research §11 boundary). The viz kinds (`scatter`/`violin`) wrap `<Viz>`
// and live in `./viz`.

import * as React from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  MultiSelect,
  Select,
  Slider,
  Statistic,
  Table,
  type SelectOption,
  type SelectOptionGroup,
} from '@ziee/kit'
import { FieldLabel } from '@ziee/kit/shadcn/field'
import { Play, Trash2, type LucideIcon } from 'lucide-react'
import type {
  AlertWidget,
  ButtonWidget,
  DatasetPickerWidget,
  ExprString,
  GroupWidget,
  ListEditorWidget,
  MultiSelectWidget,
  RangeSliderWidget,
  SelectWidget,
  StatWidget,
  TableColumnSpec,
  TableCellSpec,
  TableWidget,
  TabsWidget,
  TextWidget,
  TokenInputWidget,
  WidgetSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import {
  evalExpr,
  evalWhen,
  expandForEach,
  interpolateBraces,
  type Scope,
} from '@/modules/workbench/core/runtime/expr'
import { EMIT_ICON, EmitControl } from '@/modules/workbench/core/render/EmitControl'
import type { WidgetRenderContext, WidgetRenderer } from '@/modules/workbench/core/render/registry'
import { WidgetField } from '@/modules/workbench/core/render/WidgetField'
// Through the PUBLIC barrel (INV-3/INV-8), not by deep path: an extension reaches core at
// its one published entry. What it needs is the ADDRESS vocabulary — a per-row control has
// to look its verdict up under the same key the engine filed it under.
import { SUMMARY_LEAD, partKey } from '@/modules/workbench/core'

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const testid = (spec: WidgetSpec, fallback: string): string =>
  `widget-${(spec as { id?: string }).id ?? fallback}`

/** Resolve a widget's extra `args` (`$`-refs) against the render scope — so a `for_each`-bound
 *  control forwards its loop-bound `index`/`id` alongside its own onChange payload. */
function resolveArgs(args: Record<string, string> | undefined, scope: Scope): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, expr] of Object.entries(args ?? {})) out[k] = evalExpr(expr, scope)
  return out
}

/**
 * ONE normalized option of a closed set.
 *
 * `label` and `description` are SEPARATE strings, and that separation is the whole point: the
 * label is what the control shows once the option is chosen, the description is what the option
 * MEANS while it is being chosen. Jamming both into `label` — the shape this replaces — puts a
 * whole sentence into a narrow column at rest, and makes a two-line row impossible, because one
 * string cannot be two lines.
 */
interface OptionSpec {
  value: string
  label: string
  description?: string
}

/**
 * A HEADED RUN of options — the declarative form of kit's own `SelectOptionGroup` (ITEM-22).
 *
 * The shape is deliberately kit's, field for field, rather than a second vocabulary that would
 * have to be translated: an options binding that resolves to `[{ label, options: [...] }, …]`
 * lowers to `SelectOptionGroup[]` with no remapping, so the two cannot drift about what a
 * heading is. An entry with no `options` array is an ordinary option and collapses into a
 * trailing anonymous run, exactly as kit's `optionRuns` does — which is what keeps an
 * UNGROUPED list byte-identical to what it rendered before this existed.
 *
 * Why the structure has to survive at all: kit's `Select` already renders headings and already
 * filters them honestly (`filterRuns` drops an emptied run heading-and-all and keeps a whole run
 * whose HEADING matched), but `toOptions` normalized every entry to `{value,label,description}`
 * and dropped any grouping on the floor. The alternative — two adjacent `select` widgets — is
 * two states and an unanswerable "which one is in force".
 */
interface OptionGroupSpec {
  /** absent ⇒ an ANONYMOUS run: options with no heading above them. */
  label?: string
  options: OptionSpec[]
}

/**
 * The name an option answers to WHILE ITS OWN GATES ARE JUDGED — `$option`, bound to the entry
 * itself for the length of that one evaluation and never afterwards.
 *
 * It is what makes a gate about the option EXPRESSIBLE at all. Before it, an option's `when` could
 * only ask about the world (`has:<capability>`), because nothing in scope named the entry being
 * judged — so the commonest gate of all, "do not offer what has already been taken", could only be
 * written by hand-copying a clause that spells each entry's own value into every entry. That is N
 * copies of one rule, and the N+1th entry drops out of it silently: the catalog grows, the new
 * entry carries no clause, and it is offered when it should not be, with nothing to say so.
 *
 * `option`, not `item`: `for_each` already binds `$item`, and a control repeated over a list would
 * otherwise have two different things answering to one name in one scope.
 */
const OPTION_SCOPE_KEY = 'option'

/** Normalize an options binding to {@link OptionSpec}[]. Accepts `string[]` or
 *  `{value,label,description?,when?}[]`.
 *
 *  An entry may declare its own `when`, evaluated against the control's render `scope` with the
 *  SAME grammar a widget's gate uses. An option list is DATA, and a datum is allowed to state its
 *  own precondition; the alternative is gating the WHOLE control, which asserts something else
 *  entirely. Absent ⇒ offered (the gate is opt-in, so every existing binding is unchanged).
 *
 *  `offerWhen` is the CONTROL's own gate over the same set — one clause, applied to every entry
 *  and ANDed with the entry's own, so a rule that belongs to the OFFER is written once instead of
 *  once per datum. Both are evaluated with {@link OPTION_SCOPE_KEY} bound, so either may name the
 *  entry it is judging. A SCALAR option is bound as the `{value,label}` it normalizes to, so the
 *  two option shapes answer the same gate rather than one of them silently ignoring it. */
function toOptions(raw: unknown, scope: Scope, offerWhen?: string): OptionSpec[] {
  return toOptionGroups(raw, scope, offerWhen).flatMap(g => g.options)
}

/** Normalize ONE entry that is known not to be a group. Shared by both paths so a grouped
 *  option and a bare one are gated, valued and labelled by the identical rule — a group must
 *  not become a second dialect of what an option is. Returns `undefined` when the entry's own
 *  `when` (or the control's `offerWhen`) refuses it. */
function toOption(o: unknown, scope: Scope, offerWhen?: string): OptionSpec | undefined {
  const rec: Record<string, unknown> =
    o && typeof o === 'object' ? (o as Record<string, unknown>) : { value: String(o), label: String(o) }
  const gated: Scope = { ...scope, [OPTION_SCOPE_KEY]: rec }
  if (!evalWhen(rec.when, gated)) return undefined
  if (!evalWhen(offerWhen, gated)) return undefined
  const value = String(rec.value ?? rec.key ?? '')
  const label = String(rec.label ?? value)
  const description = rec.description == null ? undefined : String(rec.description)
  return description ? { value, label, description } : { value, label }
}

/**
 * Normalize an options binding to HEADED RUNS — {@link toOptions} with the group structure
 * still on it (ITEM-22).
 *
 * An entry carrying an `options` ARRAY is a GROUP; its heading is its `label` (`group` is
 * accepted as an alias, because a data source that produces `{group, options}` reads more
 * plainly than one that produces a `label` beside an `options`). Anything else is an ordinary
 * option and joins the trailing anonymous run.
 *
 * A group's own `when`/`offer_when` gating runs per OPTION, never per group, and a run left
 * with no options is DROPPED heading-and-all — a heading standing over nothing claims a group
 * has members it does not, which inverts what the heading was added to say. (Kit's `filterRuns`
 * makes the same guarantee for SEARCH; this is the same rule one layer earlier, for gating.)
 */
function toOptionGroups(raw: unknown, scope: Scope, offerWhen?: string): OptionGroupSpec[] {
  const out: OptionGroupSpec[] = []
  for (const entry of asArray(raw)) {
    const rec = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined
    if (rec && Array.isArray(rec.options)) {
      const heading = rec.label ?? rec.group
      const options = rec.options
        .map(o => toOption(o, scope, offerWhen))
        .filter((o): o is OptionSpec => o !== undefined)
      if (options.length === 0) continue
      out.push(heading == null ? { options } : { label: String(heading), options })
      continue
    }
    const opt = toOption(entry, scope, offerWhen)
    if (!opt) continue
    const last = out[out.length - 1]
    if (last && last.label === undefined) last.options.push(opt)
    else out.push({ options: [opt] })
  }
  return out
}

/**
 * The declared refusal REASON for a control, resolved (ITEM-29c).
 *
 * A reason that resolves to nothing is not a refusal — absence and the empty string both mean
 * "this control is ordinary". That is what lets `unavailable_reason` be BOTH the gate and the
 * explanation: there is no second boolean to keep in step with it, so a control cannot be
 * refused without saying why, and cannot say why without being refused.
 */
function refusalReason(expr: ExprString | undefined, scope: Scope): string | undefined {
  if (expr == null) return undefined
  const v = evalExpr(expr, scope)
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed === '' ? undefined : trimmed
}

// ── empty-option affordance (declarative-rendering-hardening Slice 2, F9) ────
//
// An options binding legitimately resolves to NOTHING all the time — `$derived.columns` is
// empty until the obs slice lands, a categorical column has no categories yet, a picker's
// source isn't wired. The old renderers handled that by rendering a BLANK control: a picker
// with no rows, no explanation, and no way to tell "broken" from "not ready yet". That is F9.
// Every options-driven control now routes an empty binding through the same explicit,
// DISABLED reading of this label — inside the control AND in the field's description.
export const EMPTY_OPTION_LABEL = 'No options yet'

/** What an UNBOUND select displays when it does have options to offer. Distinct from
 *  `EMPTY_OPTION_LABEL`: "nothing to choose from" and "you have not chosen yet" are different
 *  states, and rendering the second as the first would be a new lie in place of the old one. */
export const UNCHOSEN_OPTION_LABEL = 'Choose…'
export const EMPTY_DATASET_LABEL = 'No datasets available'
export const EMPTY_MULTISELECT_HINT = 'No options yet — type a value to add one.'
/** What an UNBOUND closed-set table column reads as. A row whose field is absent must not
 *  look like a row that chose the first option: the two mean different things and only one
 *  of them is a decision the user made. Same guard as the artifact picker's placeholder. */
export const UNSET_CELL_LABEL = 'Not set'
/** The same reading, for a column whose answer is a SET rather than one value — used only when
 *  the column declares no wording of its own. It is a SEPARATE constant, and deliberately so:
 *  what an empty set MEANS is the column's statement (an unfiltered "all", an unset "none"), so
 *  the two are free to diverge the moment one of them should. */
export const UNSET_SET_LABEL = 'Not set'

/**
 * What a table with no rows reads as — the ENGINE's half of the empty state.
 *
 * It is deliberately the only half core writes. "There is nothing in this list" is all core can
 * honestly say: it knows the rows are a list and nothing whatever about what one MEANS, so any
 * richer default would either restate this in more words or name a domain the engine must not know
 * (INV-6). The useful sentence — what a row IS, and which affordance beside the table makes the
 * first one — is the view's, declared as `empty_text` and rendered under this.
 */
export const TABLE_EMPTY_TITLE = 'Nothing here yet'

/** What the search field inside a long closed set invites the user to do. It says FILTER
 *  rather than "search", because the set is closed: the field narrows what is already
 *  offered, it never reaches for anything outside the list. */
export const SEARCH_OPTION_PLACEHOLDER = 'Filter options…'
/** What a filter that matches nothing reads as. An empty popup is indistinguishable from a
 *  broken control, which is the same illegibility `EMPTY_OPTION_LABEL` removes one state over —
 *  and it is a DIFFERENT state from "nothing to choose", so it gets its own sentence. */
export const NO_MATCHING_OPTION_LABEL = 'No option matches that filter'

// ── the CLOSED-SET control, shared by every kind that offers one ─────────────
//
// SEARCH is part of it, and part of it HERE rather than at the three call sites: a filter that
// only some closed sets have is the same fragmentation this control was consolidated to end.
//
// Every closed set in a declarative form — the `select` widget, a table column's per-row
// per-row `select` column, the dataset picker — renders through {@link ClosedSetSelect}. One
// composition, for the same reason the artifact picker has one `ChosenArtifact`: these three
// have each independently had to learn the SAME four properties, and three copies of them is
// three chances for one to be re-learned late.
//
// It is the kit `Select` (a popover listbox), NOT a native `<select>`.
//
// The native element was not merely a styling mismatch. A `<select>` whose `value` matches no
// `<option>` silently DISPLAYS the first option while the store still holds the other value —
// a show/state divergence with no change event, so nothing downstream ever learns the two
// disagree. The unbound case is the same trap and it is the ordinary one: every list-append
// action seeds a blank field, so a freshly-added row rendered as though a real choice had been
// made. That surfaced as two unrelated-looking bugs — a control gated on the chosen value
// stayed hidden "for no reason" (it was correctly reacting to the empty state), and a launch
// bound nothing while the form looked filled in. Guarding it needed a fake, disabled,
// selectable-looking `<option>` standing in for "nothing chosen".
//
// The popover control has no such trap to guard: `''` selects nothing and renders the
// PLACEHOLDER, so "you have not chosen yet" is a state of the control rather than a row
// smuggled into its option list. What the user reads is also no longer a browser-drawn menu
// that ignores the design system.

/**
 * What ONE chosen value reads as inside a closed trigger — and the node that says so.
 *
 * It carries the VALUE it names (`data-value`), stamped on the node that renders the label
 * rather than taken from the binding, so "the control shows what it holds" stays checkable off
 * the DOM. That is the same job `sel.value` did for a native control and the same device the
 * artifact picker's `data-artifact-id` uses — and the absence of the attribute is how "nothing
 * is chosen" is read, which is exactly the state that used to be unreadable.
 *
 * `data-empty` marks the nothing-to-choose arm, which is a DIFFERENT state from nothing-chosen
 * and must not read as it.
 */
function ChosenOption({
  value,
  label,
  empty,
}: {
  value?: string
  label: string
  empty?: boolean
}): React.ReactElement {
  return (
    <span
      className="w-full min-w-0 truncate text-start"
      data-value={value}
      data-empty={empty ? 'true' : undefined}
      // A closed set whose LABELS say what each choice MEANS is exactly the case where the
      // meaning gets truncated away — a narrow table column or a docked pane renders a stem.
      // The popup shows the label in full, but the title makes the whole definition reachable
      // at rest, without opening the control or widening the pane.
      title={label}
    >
      {label}
    </span>
  )
}

/**
 * What ONE option reads as in the LIST — its label, and under it what it means.
 *
 * Two block-level nodes, not one string with a separator: the meaning has to be able to wrap and
 * to be styled down without dragging the label with it, and a reader (or a test) has to be able
 * to tell the halves apart. `data-slot` marks the stack for exactly that reason — the same device
 * the kit uses for its own trigger slot.
 */
function OptionLines({ label, description }: { label: string; description: string }): React.ReactElement {
  return (
    <span data-slot="option-lines" className="flex min-w-0 flex-col gap-0.5 text-start">
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </span>
  )
}

interface ClosedSetSelectProps {
  /** From `WidgetField` — the id its visible `<label htmlFor>` points at. Absent inside a
   *  table column, whose controls are named by the column heading rather than one label each. */
  id?: string
  testid: string
  ariaLabel: string
  describedBy?: string
  /** From `WidgetField` — the control carries the invalid state itself, because a colour on
   *  the message alone is invisible to anything that is not looking at it. */
  invalid?: boolean
  /** The options the spec DECLARED. Emptiness is judged on this, never on the list after the
   *  bound value was prepended (FIX-3.4): otherwise a control whose options resolve to nothing
   *  but whose state holds a value renders as an ordinary ENABLED control holding one raw
   *  string, with no way to tell that its choices failed to resolve. */
  declared: OptionSpec[]
  /** The SAME options, with their declared headings still on them (ITEM-22). Optional, and
   *  omitted by every caller whose binding has no groups: absent ⇒ the flat `declared` list is
   *  rendered as one anonymous run, which is what it always was. When present it must contain
   *  exactly the options `declared` holds — `declared` stays the source of truth for EMPTINESS
   *  and for label lookup, so the two answers cannot diverge. */
  groups?: OptionGroupSpec[]
  value: unknown
  /** What the control reads as when there is NOTHING to choose from. */
  emptyLabel: string
  /** What it reads as when there is something to choose from and nothing is chosen YET. */
  unchosenLabel: string
  onChange: (value: string) => void
}

function ClosedSetSelect({
  id,
  testid,
  ariaLabel,
  describedBy,
  invalid,
  declared,
  groups,
  value,
  emptyLabel,
  unchosenLabel,
  onChange,
}: ClosedSetSelectProps): React.ReactElement {
  const bound = value == null || String(value) === '' ? undefined : String(value)
  // The bound value ALWAYS gets an option — including one the declared list does not contain
  // (a retired column, a stale id). Without it the trigger would fall back to the placeholder
  // and the value would simply vanish from the screen while the run still receives it.
  const options: OptionSpec[] =
    bound !== undefined && !declared.some(o => o.value === bound)
      ? [{ value: bound, label: bound }, ...declared]
      : declared
  const isEmpty = declared.length === 0
  // What the TRIGGER draws for a value: the option's LABEL, never the row it drew in the list.
  // Looked up rather than read off the kit's own option, because a two-line row's `label` is a
  // NODE — stringifying it would put the meaning back into the collapsed control, which is the
  // reported defect.
  const labelOf = (v: string): string => options.find(o => o.value === v)?.label ?? v
  const toRow = (o: OptionSpec): SelectOption =>
    o.description === undefined
      ? { value: o.value, label: o.label }
      : {
          value: o.value,
          label: <OptionLines label={o.label} description={o.description} />,
          // What the trigger falls back to when no `labelRender` is given. Stated even though
          // this control always passes one, so the two never disagree if that changes.
          selectedLabel: o.label,
          // A node label has no text to filter on, and a row findable only by what it DISPLAYS
          // is half findable — the meaning is frequently the part a user remembers.
          searchText: `${o.label} ${o.description}`,
        }
  // ITEM-22 — the rows the kit is handed keep their headings when the binding declared any.
  // The prepended out-of-set bound value (above) is deliberately NOT filed under a heading: it
  // is not a member of any declared group, and putting it under one would assert a grouping the
  // data never made. It leads as an anonymous run, which is what kit renders headingless.
  const prepended = options.length > declared.length ? [toRow(options[0])] : []
  const rows: (SelectOption | SelectOptionGroup)[] =
    groups === undefined
      ? options.map(toRow)
      : [...prepended, ...groups.map(g => ({ label: g.label, options: g.options.map(toRow) }))]
  /**
   * REPORT A CHANGE, NEVER AN ECHO.
   *
   * The control is CONTROLLED: what it shows comes from the binding. The underlying listbox also
   * keeps its own internal selection, and when a render hands it a `value` that disagrees with
   * that selection it re-syncs DOWN — and announces the correction through the same `onChange` a
   * user's click comes through. The engine cannot tell the two apart from the call alone, so a
   * correction is dispatched as though somebody had chosen it.
   *
   * That is invisible while the bound action WRITES the chosen value (the correction then agrees
   * with what state already holds, so the redundant write changes nothing) and it is destructive
   * the moment an action does anything else. The shipped case: a picker whose change ADDS a row
   * and deliberately leaves its own binding empty. Choosing one option produced TWO dispatches —
   * the choice, then `''` — so every add also appended a row built from a lookup that resolved to
   * nothing: a blank row the user never asked for, holding no name and no pattern, which then
   * invalidated the form they had just completed.
   *
   * So a dispatch has to mean "the user chose something OTHER than what this control is already
   * showing", and that is exactly what this says. Re-choosing the value already bound is a no-op
   * by definition, so nothing legitimate is lost.
   */
  const commit = (v: string): void => {
    if (v === (bound ?? '')) return
    onChange(v)
  }
  return (
    <Select
      id={id}
      data-testid={testid}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      // `invalid`, NOT `aria-invalid`. The kit `Select` declares `invalid` and renders
      // `aria-invalid` from it; `aria-invalid` is not one of its props, so the attribute
      // spelled here was silently dropped — every closed-set control in a declarative form
      // (this widget, the per-row table control, the artifact picker) showed its message with no
      // programmatic invalid state and none of the kit's own invalid styling.
      //
      // It type-checked for a reason worth stating precisely, because the intuitive one is wrong:
      // NOT because the props are a union. JSX exempts any HYPHENATED attribute name from
      // excess-property checking outright — on a union or on a plain interface alike — so that
      // `data-*`/`aria-*` can go on anything. (A non-hyphenated typo here has always been an
      // error.) The kit now DECLARES the aria-* it does not forward with an uninhabited type, so
      // this line is a compile error rather than a silent drop; see
      // `sdk/packages/kit/src/kit/aria-passthrough.ts`.
      invalid={invalid}
      // F9: nothing to choose ⇒ say so and disable, rather than a blank box.
      disabled={isEmpty}
      value={bound ?? ''}
      onChange={commit}
      placeholder={isEmpty ? emptyLabel : unchosenLabel}
      options={rows}
      // SEARCH, once the list stops fitting (the kit owns the threshold). A project's column
      // list runs to hundreds, and a closed set you can only scroll is the reported defect;
      // below the threshold nothing changes, because a filter over four rows is noise.
      // The copy is passed rather than defaulted so every closed set in the vocabulary — the
      // `select` widget, a table column, the dataset picker — reads the same sentence.
      searchPlaceholder={SEARCH_OPTION_PLACEHOLDER}
      emptyText={NO_MATCHING_OPTION_LABEL}
      // `min-w-0` on the value slot so the chosen label can actually truncate inside the
      // trigger's flex row instead of pushing the chevron out of it.
      className="*:data-[slot=select-value]:min-w-0"
      labelRender={o =>
        o ? (
          <ChosenOption value={o.value} label={labelOf(o.value)} empty={isEmpty} />
        ) : isEmpty ? (
          // Nothing to choose AND nothing bound. Rendered rather than left to the placeholder
          // so the empty state carries its marker on the same node every other state uses.
          <ChosenOption label={emptyLabel} empty />
        ) : (
          // Nothing chosen yet — the placeholder speaks, and the trigger carries no
          // `data-value`, so what is on screen equals what is in state.
          undefined
        )
      }
    />
  )
}

// ── select ──────────────────────────────────────────────────────────────────
export const SelectRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as SelectWidget
  // ITEM-22 — resolved ONCE as headed runs, and flattened for every answer that is about the
  // option SET rather than its shape (emptiness, label lookup, the bound-value prepend). Two
  // independent resolutions would be two chances to disagree about which options exist.
  const groups = toOptionGroups(evalExpr(w.options, ctx.scope), ctx.scope, w.offer_when)
  const declared = groups.flatMap(g => g.options)
  const grouped = groups.some(g => g.label !== undefined)
  const value = evalExpr(w.value, ctx.scope)
  const extra = resolveArgs(w.args, ctx.scope)
  const isEmpty = declared.length === 0
  // The view's own sentence for the nothing-to-offer arm, or the engine's. The distinction it
  // buys is a real one: the generic wording says "not yet", which is true of a binding that has
  // not resolved and FALSE of a set the user has exhausted — and a control that tells someone to
  // wait for options that can never arrive is a worse empty state than a blank box.
  const emptyLabel = w.empty_text ?? EMPTY_OPTION_LABEL
  return (
    <WidgetField
      label={w.label}
      testid={`${testid(spec, 'select')}-field`}
      ariaLabel="select"
      // A DISABLED control is out of the tab order, so a message rendered INSIDE it is
      // unreachable to a keyboard/AT user — the state has to be carried OUTSIDE the control
      // as well, not only inside it.
      description={isEmpty ? emptyLabel : undefined}
      error={ctx.error}
    >
      {({ id, ariaLabel, describedBy, invalid }) => (
        <ClosedSetSelect
          id={id}
          testid={testid(spec, 'select')}
          ariaLabel={w.label ?? ariaLabel}
          describedBy={describedBy}
          invalid={invalid}
          declared={declared}
          // Passed ONLY when the binding actually declared a heading, so an ungrouped list takes
          // the identical code path it always took rather than one anonymous run that happens to
          // render the same. "Byte-identical when nothing changed" is the additive half of
          // ITEM-22, and it is cheaper to guarantee structurally than to assert.
          groups={grouped ? groups : undefined}
          value={value}
          emptyLabel={emptyLabel}
          unchosenLabel={UNCHOSEN_OPTION_LABEL}
          onChange={v => ctx.dispatch(w.onChange, { ...extra, value: v })}
        />
      )}
    </WidgetField>
  )
}

// ── text ──────────────────────────────────────────────────────────────────────
export const TextRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as TextWidget
  const value = w.value != null ? evalExpr(w.value, ctx.scope) : ''
  const extra = resolveArgs(w.args, ctx.scope)
  return (
    <WidgetField label={w.label} testid={testid(spec, 'text')} ariaLabel="text" error={ctx.error}>
      {({ id, ariaLabel, describedBy, invalid }) => (
        <Input
          id={id}
          data-testid={`${testid(spec, 'text')}-input`}
          aria-label={w.label ?? ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          placeholder={w.placeholder}
          value={value == null ? '' : String(value)}
          // DEC-5 — on every keystroke, not on blur. Where this matters most, the failure
          // downstream is SILENT, so feedback that waits for the user to leave the control
          // arrives after they have stopped looking at it.
          onChange={e => ctx.dispatch(w.onChange, { ...extra, value: e.target.value })}
        />
      )}
    </WidgetField>
  )
}

// ── multiselect (categorical keep-set) ─────────────────────────────────────────
export const MultiSelectRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as MultiSelectWidget
  const options = toOptions(evalExpr(w.options, ctx.scope), ctx.scope, w.offer_when)
  const value = asArray(evalExpr(w.value, ctx.scope)).map(String)
  const extra = resolveArgs(w.args, ctx.scope)
  // "No options yet" would contradict the tokens the user can SEE, so a keep-set that
  // already holds values is not empty for the purposes of the hint.
  const isEmpty = options.length === 0 && value.length === 0
  return (
    <WidgetField
      label={w.label}
      testid={testid(spec, 'multiselect')}
      ariaLabel="categories"
      // F9: an options-less multiselect says so under the control, instead of opening onto
      // an empty popover with no explanation. It stays ENABLED (unlike `select`) because
      // this control is `allowCreate` — typing a value IS a valid action here.
      description={isEmpty ? EMPTY_MULTISELECT_HINT : undefined}
      error={ctx.error}
    >
      {({ id, ariaLabel, describedBy, invalid }) => (
        <MultiSelect
          // `WidgetField` renders `<FieldLabel htmlFor={id}>`, so the control MUST carry that
          // id or the visible label points at nothing.
          id={id}
          data-testid={`${testid(spec, 'multiselect')}-select`}
          aria-describedby={describedBy}
          invalid={invalid}
          options={options}
          value={value}
          onChange={(v: string[]) => ctx.dispatch(w.onChange, { ...extra, value: v })}
          allowCreate
          tokenSeparators={[',']}
          placeholder={w.placeholder ?? 'Keep categories…'}
          searchPlaceholder="Type a category…"
          emptyText="Type a category to keep"
          removeLabel={(l: string) => `Remove ${l}`}
          createLabel={(q: string) => `Keep "${q}"`}
          aria-label={w.label ?? ariaLabel}
        />
      )}
    </WidgetField>
  )
}

// ── range_slider ──────────────────────────────────────────────────────────────
export const RangeSliderRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as RangeSliderWidget
  const label = w.label != null ? String(evalExpr(w.label, ctx.scope)) : undefined
  const range = evalExpr(w.range, ctx.scope) as [number, number] | undefined
  const [min, max] = Array.isArray(range) ? range : [0, 100]
  const value = evalExpr(w.value, ctx.scope) as [number, number] | undefined
  const current = Array.isArray(value) ? value : [min, max]
  // Extra static args (each a `$`-ref) — a per-sample slider forwards its `for_each`-bound
  // `ident`/`criterion` alongside `range` so the declared `set` writes the right cell.
  const extra: Record<string, unknown> = {}
  for (const [k, expr] of Object.entries(w.args ?? {})) extra[k] = evalExpr(expr, ctx.scope)
  return (
    <WidgetField label={label} testid={testid(spec, 'range_slider')} ariaLabel="range" error={ctx.error}>
      {({ ariaLabel, invalid }) => (
        <Slider
          min={min}
          max={max}
          value={current}
          aria-label={ariaLabel}
          aria-invalid={invalid ? true : undefined}
          onValueCommitted={(v: number | readonly number[]) =>
            ctx.dispatch(w.onCommit, { ...extra, range: Array.isArray(v) ? v : [v] })
          }
        />
      )}
    </WidgetField>
  )
}

// ── list-editor ────────────────────────────────────────────────────────────────
// TWO modes (ITEM-18 / DEC-5):
//   · FLAT (`items` + `onChange`): an editable `string[]` (the original behaviour).
//   · CARD (`item.children` + `items` + `add`/`remove`): an editable array of OBJECTS, each
//     element rendered as a card of child controls scoped by `$item`/`$index` — the same
//     row-scope idiom `table` uses for `$row`. Generic + DOMAIN-FREE (a card of items).
export const ListEditorRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as ListEditorWidget
  const base = testid(spec, 'list-editor')
  const label = w.label != null ? String(evalExpr(w.label, ctx.scope)) : undefined

  // CARD mode — a repeat of a group of child widgets over a `$state` array of objects.
  if (w.item && Array.isArray(w.item.children)) {
    const rows = asArray(evalExpr(w.items, ctx.scope))
    const addLabel = w.add_label != null ? String(evalExpr(w.add_label, ctx.scope)) : 'Add'
    const removeLabel =
      w.remove_label != null ? String(evalExpr(w.remove_label, ctx.scope)) : 'Remove'
    return (
      <div className="flex w-full flex-col items-start gap-3" data-testid={base}>
        {label ? <FieldLabel>{label}</FieldLabel> : null}
        {rows.map((row, i) => {
          // `$item` = this element, `$index` = its position — the child controls read them
          // (`$item.<field>`, `$index`) exactly as a table row reads `$row`. Not a dangling ref:
          // validateRefs only scans `$state|$data|$derived|$const`.
          const itemScope: Scope = { ...ctx.scope, item: row, index: i }
          return (
            <div
              key={i}
              data-testid={`${base}-item-${i}`}
              className="flex w-full flex-col gap-2 rounded-md border border-border bg-card p-3"
            >
              {ctx.renderChildren(w.item?.children ?? [], itemScope)}
              {w.remove ? (
                <div className="flex justify-end">
                  <Button
                    data-testid={`${base}-remove-${i}`}
                    variant="ghost"
                    onClick={() => ctx.dispatch(w.remove, { index: i })}
                  >
                    {removeLabel}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}
        {w.add ? (
          <Button data-testid={`${base}-add`} variant="outline" onClick={() => ctx.dispatch(w.add, {})}>
            {addLabel}
          </Button>
        ) : null}
      </div>
    )
  }

  // FLAT mode — an editable `string[]`.
  const items = asArray(evalExpr(w.items, ctx.scope)).map(String)
  const commit = (next: string[]) => ctx.dispatch(w.onChange, { items: next })
  return (
    <div className="flex w-full max-w-md flex-col items-start gap-2" data-testid={base}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      {items.map((item, i) => (
        <div key={i} className="flex w-full items-center gap-2">
          <Input
            className="flex-1"
            data-testid={`${base}-item-${i}`}
            aria-label={`${label ?? 'item'} ${i + 1}`}
            value={item}
            onChange={e => commit(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button data-testid={`${base}-remove-${i}`} variant="ghost" onClick={() => commit(items.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Button data-testid={`${base}-add`} variant="outline" onClick={() => commit([...items, ''])}>
        Add
      </Button>
    </div>
  )
}

// ── tabs (mode-switch) ───────────────────────────────────────────────────────────
// A generic segmented tab group (ITEM-16). The active tab id is a bound `$state` value; only
// the active tab's children render. DOMAIN-FREE.
export const TabsRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as TabsWidget
  const base = testid(spec, 'tabs')
  const label = w.label != null ? String(evalExpr(w.label, ctx.scope)) : undefined
  const tabs = Array.isArray(w.tabs) ? w.tabs : []
  const raw = w.value != null ? evalExpr(w.value, ctx.scope) : undefined
  const active = raw != null && raw !== '' ? String(raw) : (tabs[0]?.id ?? '')
  const activeTab = tabs.find(t => t.id === active) ?? tabs[0]
  return (
    <div className="flex w-full flex-col gap-3" data-testid={base}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <div role="tablist" aria-label={label ?? 'tabs'} className="flex gap-1 border-b border-border">
        {tabs.map(t => {
          const on = t.id === (activeTab?.id ?? active)
          const tabLabel = String(evalExpr(t.label, ctx.scope))
          return (
            // A role=tab element in a tablist, whose selected state is a custom bottom-border
            // underline (border-b-2 border-primary). The kit Button's chrome (rounded box +
            // all-side border) fights the tablist styling; a tablist tab is the primitive here.
            // native-control-ok: tablist tab with a custom underline indicator, not a Button.
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`${base}-tab-${t.id}`}
              onClick={() => ctx.dispatch(w.onChange, { value: t.id })}
              className={
                on
                  ? 'border-b-2 border-primary px-3 py-1.5 text-sm font-medium text-foreground'
                  : 'border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground'
              }
            >
              {tabLabel}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" data-testid={`${base}-panel`}>
        {activeTab ? ctx.renderChildren(activeTab.children ?? [], ctx.scope) : null}
      </div>
    </div>
  )
}

// ── token-input (chip list) ────────────────────────────────────────────────────
// A generic add/remove token list bound to a `$state` string[] (ITEM-17). Hook-free: the
// pending token lives in the uncontrolled input; Enter / comma / blur commit it. DOMAIN-FREE.
export const TokenInputRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as TokenInputWidget
  const base = testid(spec, 'token-input')
  const label = w.label != null ? String(evalExpr(w.label, ctx.scope)) : undefined
  const tokens = asArray(evalExpr(w.value, ctx.scope)).map(String)
  const extra: Record<string, unknown> = {}
  for (const [k, expr] of Object.entries(w.args ?? {})) extra[k] = evalExpr(expr, ctx.scope)
  const commit = (next: string[]) => ctx.dispatch(w.onChange, { ...extra, value: next })
  const add = (input: HTMLInputElement) => {
    const t = input.value.trim()
    if (t && !tokens.includes(t)) commit([...tokens, t])
    input.value = ''
  }
  return (
    <div className="flex w-full flex-col gap-2" data-testid={base}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {tokens.map((t, i) => (
          <span
            key={`${t}-${i}`}
            data-testid={`${base}-chip-${i}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-accent px-2 py-0.5 font-mono text-xs"
          >
            {t}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${t}`}
              data-testid={`${base}-remove-${i}`}
              className="size-4 rounded-sm text-muted-foreground hover:text-foreground"
              // `onMouseDown`+preventDefault so clicking × does NOT blur the pending-token
              // input: the blur `add()` and this `remove` would otherwise both dispatch off
              // the SAME render-scope `tokens` (two racing LWW commits — one silently drops the
              // other). Keeping focus means the removal commits alone, and any half-typed token
              // stays in the input rather than being force-added or lost.
              onMouseDown={e => e.preventDefault()}
              onClick={() => commit(tokens.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </span>
        ))}
        <Input
          className="h-7 w-28 flex-none"
          data-testid={`${base}-input`}
          aria-label={label ?? 'add token'}
          placeholder={w.placeholder ?? 'Add…'}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add(e.currentTarget)
            }
          }}
          onBlur={e => add(e.currentTarget)}
        />
      </div>
    </div>
  )
}

// ── table (+ editable cell + row selection) ──────────────────────────────────
type Row = Record<string, unknown>

/**
 * How a per-row MESSAGE breaks — and the one place `break-words` would not have been enough.
 *
 * `wrap-anywhere` (`overflow-wrap: anywhere`) is the only wrapping rule that participates in
 * INTRINSIC sizing: `break-words` breaks a long token during layout but still reports the whole
 * token as the box's min-content, so a message would keep a floor under the column equal to its
 * longest word — and a message that interpolates a value (`"{value}"`, an id, a path) has no bound
 * on that word at all. With `anywhere`, a message's min-content is one character, so a message
 * NEVER sizes the grid: the width of the table stops depending on whether a field is valid.
 *
 * The cost is a mid-word break, and it is only ever paid in a column already narrower than the
 * word — where the alternative is the whole grid sliding out from under the row being read. The
 * same trade, for the same reason, as the kit's own `Card` action label (`wrap-anywhere`, "not
 * `break-words`").
 */
const MESSAGE_CLASS = 'text-xs text-destructive wrap-anywhere'

/**
 * ONE sentence a row has to say about itself — a field's verdict, or a picker's nothing-to-offer
 * state — carried OUT of the column that produced it so the row can say it at full width.
 *
 * THE MEASUREMENT THAT FORCED THIS. A column is as wide as the grid can afford, and in the pane
 * this form is docked into (the right region's default 300px ⇒ a 284px content box) the grid is
 * already at its minimum: the Metric column gets 60px. A 160-character sentence rendered INSIDE
 * that box — wrapped, and with a per-column `max-width` cap on top — measured **44px wide and
 * 480px tall: a thirty-line ribbon**. The width bug was gone and the message had become
 * unreadable, which is not a fix. Widening the column instead is the bug the user reported.
 *
 * (THE CAP IS NOT HERE, and its absence is a measurement rather than an omission. Once the
 * sentence left the column, the cap changed NOTHING: both shipped tables measure byte-identical
 * with and without it — `305px [60,60,138,48]` and `284px [119,117,48]` either way — because
 * nothing else a per-row control draws has an unbounded intrinsic width. A rule no test can tell
 * the presence of is a rule nobody is keeping. The one shape that would bring it back is a
 * `column.value` box holding a long string, which no shipped view declares today; when one does,
 * it wants this treatment and a measurement of its own.)
 *
 * There is no third option inside a column, and the kit already says so: `renderRowDetail` is
 * documented as "the one placement a columns-only grid cannot express … a value that belongs to a
 * row but needs the whole width — a range control over two of that row's own bounds, A MESSAGE, a
 * preview". A sentence is not a value, and a column is the wrong box for one. The band is a
 * full-width `<td colSpan>` DIRECTLY under its row, so the message:
 *
 *   · reads across the whole pane (four lines at 284px, not thirty);
 *   · contributes NOTHING to any column's width, so the grid's size no longer depends on whether
 *     a field is valid — which is the reported defect, closed at the root rather than bounded;
 *   · stays adjacent to the row it is about, and (the kit suppresses the rule between a row and
 *     its own band) reads as part of it;
 *   · keeps its `id`, so the control's `aria-describedby` still resolves — DOM distance is
 *     irrelevant to an id reference, which is why this placement costs nothing to a screen reader.
 *
 * `label` names WHICH control the sentence is about. It is a sibling node rather than a prefix
 * INSIDE the message, so the message element's own text is still exactly the declared sentence.
 */
interface RowNote {
  /** The id the control's `aria-describedby` points at. */
  id: string
  testid: string
  /** The column heading (or, for a folded sub-part, its own key) this sentence is about. */
  label: string
  text: string
  /** A fault INTERRUPTS (`role="alert"`, destructive); a state does not. Having nothing to offer
   *  yet is the ordinary opening condition of a dependent picker, and announcing it on the
   *  channel real errors arrive on is how a reader learns to ignore that channel. */
  tone: 'error' | 'state'
}

/** What one row-scoped part draws: the control that goes IN the grid, and the sentences that go
 *  UNDER the row (see {@link RowNote}). A gated-off part draws neither. */
interface DrawnPart {
  control: React.ReactNode
  notes: RowNote[]
}

const NOTHING_TO_DRAW: DrawnPart = { control: null, notes: [] }

/**
 * The CLOSED set of glyphs a per-row action may draw itself as.
 *
 * Closed, and looked up by NAME, for the same reason the pane-kind icons are: a view is DATA,
 * so it cannot hand the renderer a component — and it must not be able to reach an arbitrary
 * glyph either, or the vocabulary stops being reviewable. The set starts at what a per-row
 * action in this engine actually does; a seventh entry is a one-line change the day a view
 * needs one.
 *
 * A name that is not here yields `undefined`, and the caller draws the LABELLED button. That is
 * deliberate: an unrecognised name must degrade to the wordy control, never to an unnamed or
 * empty one.
 */
// `plot` IS NOT IN THIS MAP. It is not an icon this renderer draws — it is the EMIT control
// (`core/render/EmitControl.tsx`), a whole component with its own variant, its own click
// suppression and its own refusal handling, shared with `EntryListWidget` and
// `ArtifactRefWidget` (owner, ledger #33). It used to be an entry here whose glyph this file
// and `EntryListWidget` "deliberately agreed on by hand" — and they agreed on the glyph while
// disagreeing on the VARIANT, which is exactly what the owner was looking at when they asked
// why the same verb had a border in one section and not in another. `renderButton` below
// dispatches on {@link EMIT_ICON} BEFORE it reaches this map.
const ROW_ACTION_ICONS: Record<string, LucideIcon> = {
  remove: Trash2,
  // `play` remains a legitimate glyph for a row action that genuinely STARTS something — a
  // thing with a timeline, which is precisely what an emit is not. Removing the key would
  // silently degrade any such row to the wordy button (see `rowActionIcon`).
  play: Play,
}

function rowActionIcon(name: unknown): LucideIcon | undefined {
  return typeof name === 'string' && name !== '' ? ROW_ACTION_ICONS[name] : undefined
}

/**
 * The renderer for ONE row-scoped PART declaration — a column's inner control. It returns the
 * `(record, index) => `{@link DrawnPart} the table calls per row: the control its own box draws,
 * and the sentences the ROW draws under itself.
 *
 * The five properties below are each a thing one of these primitives had to learn, and they are
 * learned ONCE here rather than per primitive:
 *
 *   · every binding is evaluated in the ROW's scope, so row N shows row N's value;
 *   · the accessible name carries the ROW, so N controls in one column are distinguishable;
 *   · `aria-invalid` + the message's id in `aria-describedby` are composed by hand here, because
 *     a per-row field is named by its heading rather than by a `WidgetField` label of its own —
 *     and the message itself is HANDED BACK rather than rendered, because a column is the wrong
 *     box for a sentence ({@link RowNote});
 *   · a per-row `when` gates the control AND (in the validity pre-pass) its requirement;
 *   · `key` travels in the dispatch payload, so ONE action serves every editable part.
 *
 * `ci` is the part's positional fallback for the two places a missing `key` still has to
 * produce a distinct name (the testid and the accessible label). `label` is what a sentence
 * about this part CALLS it — the column's heading, or a folded sub-part's own key.
 */
function rowPartRenderer(
  col: TableColumnSpec,
  ci: number,
  spec: WidgetSpec,
  ctx: WidgetRenderContext,
  label: string,
): (record: Row, index: number) => DrawnPart {
  const rowScope = (row: Row): Scope => ({ ...ctx.scope, row })
  // A FOLDED part — several mutually-exclusive controls sharing ONE column — is composed from
  // this same function, once per sub-part. Recursion rather than a second renderer is the whole
  // point: a sub-part keeps its own key, so its bindings, its verdict address, its testid and
  // its accessible name are computed by the identical code that computes a column's. Folding
  // moves where a control is DRAWN; a copy here is how it would quietly stop being addressable.
  //
  // A sub-part whose per-row gate is false renders nothing and takes no space, which is what
  // makes the fold pay: the row shows the one control its own kind calls for, and the column is
  // as wide as the widest of them rather than as wide as all of them.
  const subParts = Array.isArray(col.parts) ? col.parts : undefined
  if (subParts) {
    const inner = subParts.map((sub, si) => ({
      key: sub.key ?? `part-${si}`,
      // A sub-part's sentences call it by its OWN key: one heading cannot name both ends of a
      // range, which is the whole reason the fold exists.
      render: rowPartRenderer(sub, ci + si, spec, ctx, sub.key ?? `part-${si}`),
    }))
    return (record: Row, index: number): DrawnPart => {
      const drawn = inner.map(sub => ({ key: sub.key, part: sub.render(record, index) }))
      // Every sub-part's sentences travel up, gated-off ones included (they have none), so the
      // band a fold produces is the union of its parts' — the same fact the address space already
      // states: folding moves where a control is DRAWN and not what it is CALLED.
      const notes = drawn.flatMap(({ part }) => part.notes)
      // Rendered node kept WITH the sub-part it came from, so a gated-off neighbour cannot
      // shift the React keys of the ones that did draw.
      const shown = drawn.filter(
        ({ part }) => part.control != null && part.control !== false && part.control !== '',
      )
      if (shown.length === 0) return { control: null, notes }
      return {
        notes,
        control: (
          <div className="flex min-w-0 items-start gap-1">
            {shown.map(({ key, part }) => (
              <React.Fragment key={key}>{part.control}</React.Fragment>
            ))}
          </div>
        ),
      }
    }
  }
  const cellSpec = col.cell as TableCellSpec | undefined
  const editable = cellSpec?.editable_text
  const rowButton = cellSpec?.button
  const rowSelect = cellSpec?.select
  const rowMulti = cellSpec?.multiselect
  /** The address a per-row field's own verdict is filed under — the column plus the row's
   *  position, which is what makes "row N shows row N's message" possible at all. */
  const fieldPart = (index: number): string => partKey(String(col.key ?? ci), index)
  /** The name one row's control answers to. A column renders N of them, and N controls
   *  sharing one name are indistinguishable to a screen-reader / voice user. */
  const rowName = (index: number): string => `${col.key ?? `column ${ci + 1}`} row ${index + 1}`
  /** The verdict on one part of one row, as the note the ROW will draw. `[]` when it is valid. */
  const errorNotes = (base: string, index: number): RowNote[] => {
    const message = ctx.partError?.(fieldPart(index))
    return message
      ? [{ id: `${base}-error`, testid: `${base}-error`, label, text: message, tone: 'error' }]
      : []
  }
  const renderEditable = (record: Row, index: number): DrawnPart => {
    if (!evalWhen(editable?.when, rowScope(record))) return NOTHING_TO_DRAW
    const base = `${testid(spec, 'table')}-edit-${col.key ?? ci}-${index}`
    // A per-row field is not a `WidgetField` (its name is the COLUMN HEADING above it,
    // not a label of its own), so the invalid wiring is composed here — but it is the
    // same three parts the shared scaffold applies: `aria-invalid` on the control, the
    // message OUTSIDE it, and the message's id in the control's `aria-describedby`.
    // "Outside" is now the ROW's band rather than this box — see {@link RowNote}; the id
    // reference is what ties them, and it does not care how far apart they sit.
    const message = ctx.partError?.(fieldPart(index))
    const errorId = `${base}-error`
    return {
      notes: errorNotes(base, index),
      control: (
        <Input
          data-testid={base}
          aria-label={`${col.key ?? `column ${ci + 1}`} row ${index + 1}`}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          // A per-row field is normally named by the column HEADING above it, and that stops
          // being true the moment two fields FOLD into one column: one heading cannot name both
          // ends of a range. The placeholder is where the column declares what an empty box is
          // waiting for. Absent ⇒ no placeholder, exactly as before.
          placeholder={editable?.placeholder}
          value={String(evalExpr(editable?.value, rowScope(record)) ?? '')}
          onChange={e => {
            ctx.markTouched?.(fieldPart(index))
            ctx.dispatch(editable?.onChange, { key: col.key, index, value: e.target.value })
          }}
        />
      ),
    }
  }
  // A per-row ACTION. Its accessible name carries the ROW so the N buttons a table
  // renders are distinguishable to a screen-reader / voice user (the same reason the
  // widget error boundary names its retry) — and so a destructive one READS as
  // destructive on the row it destroys, rather than as an unexplained checkbox.
  const renderButton = (record: Row, index: number): DrawnPart => {
    const scope = { ...rowScope(record), index }
    if (!evalWhen(rowButton?.when, scope)) return NOTHING_TO_DRAW
    // `actionLabel`, not `label`: the enclosing `label` is what a SENTENCE about this part calls
    // it (the column heading), and this is what the BUTTON says. Two different strings.
    const actionLabel = rowButton?.label != null ? String(evalExpr(rowButton.label, scope) ?? '') : ''
    const named =
      String((record as { name?: unknown; id?: unknown }).name ?? (record as { id?: unknown }).id ?? '') ||
      `row ${index + 1}`
    const extra: Record<string, unknown> = { index }
    for (const [k, expr] of Object.entries(rowButton?.args ?? {})) extra[k] = evalExpr(expr, scope)
    const testId = `${testid(spec, 'table')}-action-${col.key ?? ci}-${index}`
    const ariaLabel = `${actionLabel || (col.key ?? 'action')} ${named}`
    const variant = BUTTON_VARIANT[rowButton?.variant ?? 'default']
    const Glyph = rowActionIcon(rowButton?.icon)
    // The per-row refusal (ITEM-29c/ITEM-39). Resolved in the ROW's scope, so the cause is that
    // row's own — which is the only place it can be stated: a column heading cannot say "4,102
    // levels is too many" about one of forty rows, and the form-level requirements summary
    // would say it forty times.
    const rowRefusal = refusalReason(rowButton?.unavailableReason, scope)
    // THE EMIT VERB IS ONE CONTROL EVERYWHERE (owner, ledger #33). A view declaring
    // `icon: plot` gets the shared component, not this file's idea of an icon button — so a
    // table-shaped section and a list-shaped section cannot spell the same verb two ways.
    if (rowButton?.icon === EMIT_ICON) {
      return {
        notes: [],
        control: (
          <EmitControl
            data-testid={testId}
            name={ariaLabel}
            refusal={rowRefusal}
            onPress={() => ctx.dispatch(rowButton?.onClick, extra)}
          />
        ),
      }
    }
    // The ICON form. The declared `label` is NOT dropped — it becomes the accessible name AND the
    // hover/focus tooltip, so the action is still named to a screen-reader user, a voice user and
    // a pointer user alike. What is spent is the WIDTH of a word repeated identically on every
    // row, in a pane where a quarter of the space was going to it.
    //
    // BOTH are passed EXPLICITLY, and the same string, even though the kit would derive the
    // tooltip from `aria-label` on its own. An icon-only control with a name but no tooltip is
    // legible to everything except the pointer user looking straight at it, and that derivation is
    // the kit's private business — stating both here is what makes this call site answer the
    // icon-only rule on its own terms rather than by inheriting it.
    //
    // The name carries the ROW (`Remove <that row's own name>`, not `Remove`), the whole reason a
    // destructive icon can be unlabelled at all: the one thing a user must know before pressing it
    // is WHAT it destroys, and the glyph cannot say that. N identical `Remove`s would also be N
    // indistinguishable controls to a voice user.
    //
    // An UNREGISTERED icon name falls back to the text button rather than to a blank square:
    // the closed registry is the point (a view cannot reach an arbitrary glyph), and a control
    // the user can neither read nor recognise is a worse answer than a wide one.
    if (Glyph) {
      return {
        notes: [],
        control: (
          <Button
            size="icon"
            icon={<Glyph />}
            data-testid={testId}
            aria-label={ariaLabel}
            tooltip={ariaLabel}
            variant={variant}
            unavailableReason={rowRefusal}
            onClick={() => {
              if (rowRefusal != null) return
              ctx.dispatch(rowButton?.onClick, extra)
            }}
          />
        ),
      }
    }
    return {
      notes: [],
      control: (
        <Button
          data-testid={testId}
          aria-label={ariaLabel}
          variant={variant}
          unavailableReason={rowRefusal}
          onClick={() => {
            if (rowRefusal != null) return
            ctx.dispatch(rowButton?.onClick, extra)
          }}
        >
          {actionLabel}
        </Button>
      ),
    }
  }
  // A per-row CLOSED-SET choice — the SAME control the `select` widget renders, so the
  // properties it had to learn are inherited rather than re-derived (see
  // {@link ClosedSetSelect}: the bound-value prepend, emptiness judged on the DECLARED
  // options, and a placeholder that is a state of the control rather than option zero).
  //
  // What is this renderer's OWN, and cannot live in the shared control:
  //
  //   · the value is evaluated in the ROW's scope, so row N shows row N's value (a
  //     table-scope evaluation shows row 0's on every row and looks like it works);
  //   · the accessible name carries the ROW, so N controls in one column are
  //     distinguishable to a screen-reader / voice user;
  //   · the unchosen placeholder is the table's own ("Not set"), not the widget's
  //     ("Choose…"): a table row states a FACT about itself, so an absent field reads as
  //     unset rather than as an instruction to choose.
  //   · the nothing-to-OFFER sentence is the VIEW's where it wrote one (`empty_text`), and it
  //     is rendered OUTSIDE the control as well as inside it. Both halves are this arm's own:
  //     a per-row closed set is fed by a binding that depends on another control, so empty is
  //     its ordinary opening state, and the engine's constant names the symptom at the control
  //     the user pokes while the cause is stated four controls away. Outside, because a
  //     disabled trigger is out of the tab order AND carries its own row-naming `aria-label`
  //     (so its contents are exactly what a keyboard/AT user never hears), and because one
  //     column of a row is narrow enough to truncate the sentence away for everyone else. The
  //     standalone `select` widget answers both with its field DESCRIPTION; a per-row control
  //     has no field, so the note goes through the node the row's error message already uses.
  const renderSelect = (record: Row, index: number): DrawnPart => {
    const scope = { ...rowScope(record), index }
    if (!evalWhen(rowSelect?.when, scope)) return NOTHING_TO_DRAW
    const extra: Record<string, unknown> = { key: col.key, index }
    for (const [k, expr] of Object.entries(rowSelect?.args ?? {})) extra[k] = evalExpr(expr, scope)
    const base = `${testid(spec, 'table')}-select-${col.key ?? ci}-${index}`
    const message = ctx.partError?.(fieldPart(index))
    const errorId = `${base}-error`
    // Emptiness is judged on the DECLARED options, exactly as `ClosedSetSelect` judges it —
    // never on the list after a bound value was prepended, or a control whose choices failed
    // to resolve would read as an ordinary enabled one holding a single raw value.
    const declared = toOptions(evalExpr(rowSelect?.options, scope), scope, rowSelect?.offer_when)
    const emptyLabel = rowSelect?.empty_text ?? EMPTY_OPTION_LABEL
    const emptyId = `${base}-empty`
    const isEmpty = declared.length === 0
    return {
      // An error, when there is one, TAKES THE DESCRIPTION OVER: two sentences under one control
      // is one more than the user can act on. So the nothing-to-offer note is the fallback arm,
      // never a second note beside the fault.
      notes: message
        ? errorNotes(base, index)
        : isEmpty
          ? [{ id: emptyId, testid: emptyId, label, text: emptyLabel, tone: 'state' }]
          : [],
      control: (
        <ClosedSetSelect
          testid={base}
          ariaLabel={`${col.key ?? `column ${ci + 1}`} row ${index + 1}`}
          describedBy={message ? errorId : isEmpty ? emptyId : undefined}
          invalid={message != null}
          declared={declared}
          value={evalExpr(rowSelect?.value, scope)}
          emptyLabel={emptyLabel}
          unchosenLabel={UNSET_CELL_LABEL}
          onChange={v => {
            ctx.markTouched?.(fieldPart(index))
            ctx.dispatch(rowSelect?.onChange, { ...extra, value: v })
          }}
        />
      ),
    }
  }
  // A per-row MULTI-value choice — the same control the `multiselect` widget renders, bound
  // to one row's field. Its placeholder is DECLARED rather than defaulted here: what an empty
  // set means is the column's own statement (an unfiltered "all", an unset "none"), and a
  // default would put the engine's word in the author's mouth.
  const renderMulti = (record: Row, index: number): DrawnPart => {
    const scope = { ...rowScope(record), index }
    if (!evalWhen(rowMulti?.when, scope)) return NOTHING_TO_DRAW
    const extra: Record<string, unknown> = { key: col.key, index }
    for (const [k, expr] of Object.entries(rowMulti?.args ?? {})) extra[k] = evalExpr(expr, scope)
    const base = `${testid(spec, 'table')}-multiselect-${col.key ?? ci}-${index}`
    const message = ctx.partError?.(fieldPart(index))
    const errorId = `${base}-error`
    return {
      notes: errorNotes(base, index),
      control: (
        <MultiSelect
          data-testid={base}
          aria-label={rowName(index)}
          aria-describedby={message ? errorId : undefined}
          invalid={!!message}
          options={toOptions(evalExpr(rowMulti?.options, scope), scope, rowMulti?.offer_when)}
          value={asArray(evalExpr(rowMulti?.value, scope)).map(String)}
          onChange={(v: string[]) => {
            ctx.markTouched?.(fieldPart(index))
            ctx.dispatch(rowMulti?.onChange, { ...extra, value: v })
          }}
          allowCreate
          tokenSeparators={[',']}
          placeholder={rowMulti?.placeholder ?? UNSET_SET_LABEL}
          searchPlaceholder={SEARCH_OPTION_PLACEHOLDER}
          emptyText={NO_MATCHING_OPTION_LABEL}
          removeLabel={(l: string) => `Remove ${l}`}
          createLabel={(q: string) => `Add "${q}"`}
        />
      ),
    }
  }
  // ONE primitive per part, in a fixed order. A part declaring two renders the first and
  // silently drops the rest, which the shipped-form tier asserts against separately.
  return editable
    ? renderEditable
    : rowButton
      ? renderButton
      : rowSelect
        ? renderSelect
        : rowMulti
          ? renderMulti
          : (record) => {
              const v = col.value != null ? evalExpr(col.value, rowScope(record)) : undefined
              return { control: v == null ? '' : String(v), notes: [] }
            }
}

export const TableRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as TableWidget
  const rows = asArray(evalExpr(w.rows, ctx.scope)) as Row[]

  // Expand any `for_each` columns (dynamic per-criterion columns) up front.
  const columnSpecs: TableColumnSpec[] = (w.columns ?? []).flatMap(col =>
    col.for_each ? expandForEach(col, ctx.scope).map(e => e.spec) : [col],
  )

  type KitCol = {
    key: string
    title: React.ReactNode
    render: (record: Row, index: number) => React.ReactNode
    // Declared LAYOUT, passed straight through to the kit. Absent on every existing column, so
    // nothing already shipped changes shape; see `TableColumnSpec.width` / `.ellipsis` for why
    // a narrow pane needs them at all.
    width?: number | string
    ellipsis?: boolean
  }
  const columns: KitCol[] = []
  // Optional leading row-selection column.
  if (w.selection) {
    const selected = new Set(asArray(evalExpr(w.selection.value, ctx.scope)).map(String))
    columns.push({
      key: '__select',
      title: '',
      render: (record, index) => {
        const key = String((record as { id?: unknown; ident?: unknown }).ident ?? (record as { id?: unknown }).id ?? index)
        return (
          <Checkbox
            data-testid={`${testid(spec, 'table')}-select-${key}`}
            aria-label={`select ${key}`}
            checked={selected.has(key)}
            onCheckedChange={(checked: boolean) =>
              ctx.dispatch(w.selection?.onChange, { key, selected: checked })
            }
          />
        )
      },
    })
  }

  /**
   * ONE evaluation per (column, row), read TWICE.
   *
   * A part's control and its sentences come out of the same call — which is what keeps them from
   * disagreeing about a per-row `when` gate, about which primitive a part declares, or about the
   * id an `aria-describedby` has to resolve to. The kit asks for the band FIRST and the columns
   * after, so without this memo every options binding (`$derived.columns` runs to hundreds of
   * entries in the criteria table) would be resolved twice per row.
   *
   * The cache is created inside this render call and dies with it, so it can never serve a stale
   * row: within one render, index → record is fixed.
   */
  const partCache = new Map<string, DrawnPart>()
  const partOf = (
    colKey: string,
    render: (record: Row, index: number) => DrawnPart,
    record: Row,
    index: number,
  ): DrawnPart => {
    const k = `${colKey}#${index}`
    let hit = partCache.get(k)
    if (hit === undefined) {
      hit = render(record, index)
      partCache.set(k, hit)
    }
    return hit
  }
  const partColumns = columnSpecs.map((col, ci) => {
    const key = col.key ?? `col-${ci}`
    const title = col.title != null ? String(evalExpr(col.title, ctx.scope)) : (col.key ?? '')
    return {
      key,
      title,
      // A sentence about this column calls it by what the reader sees ABOVE it — its heading —
      // falling back to the key for a column that declares no title.
      render: rowPartRenderer(col, ci, spec, ctx, title || key),
      width: col.width,
      ellipsis: col.ellipsis,
    }
  })
  partColumns.forEach(({ key, title, render, width, ellipsis }) => {
    columns.push({
      key,
      title,
      render: (record, index) => partOf(key, render, record, index).control,
      ...(width != null ? { width } : {}),
      ...(ellipsis ? { ellipsis: true } : {}),
    })
  })

  /**
   * The row's own full-width band — every sentence its controls have to say, under the row and
   * across the whole pane. `null` for a row with nothing to say, which is the kit's contract for
   * "this row renders exactly as it always did".
   *
   * See {@link RowNote} for why a sentence cannot live in the column that produced it.
   */
  const rowDetail = (record: Row, index: number): React.ReactNode => {
    const notes = partColumns.flatMap(({ key, render }) => partOf(key, render, record, index).notes)
    if (notes.length === 0) return null
    return (
      <div className="flex flex-col gap-1" data-testid={`${testid(spec, 'table')}-notes-${index}`}>
        {notes.map(note => (
          <div key={note.id} className="flex flex-wrap items-baseline gap-x-2">
            {/* WHICH control this is about. A sibling node rather than a prefix inside the
                message, so the message element's own text stays exactly the declared sentence —
                what a view author wrote, what a test reads, and what a screen reader announces
                through `aria-describedby` are then one string. */}
            <span className="text-xs font-medium text-muted-foreground">{note.label}</span>
            <p
              id={note.id}
              data-testid={note.testid}
              // `role="alert"` on a FAULT only. See {@link RowNote.tone}.
              role={note.tone === 'error' ? 'alert' : undefined}
              className={note.tone === 'error' ? MESSAGE_CLASS : 'text-xs text-muted-foreground wrap-anywhere'}
            >
              {note.text}
            </p>
          </div>
        ))}
      </div>
    )
  }

  return (
    // `w-full min-w-0` is the whole reason a wide grid stays inside its pane, and it is not
    // cosmetic. `RegionBody` is a COLUMN flex with `items-start`, so a child that states no
    // width is sized to its own CONTENT — and every other declarative control escapes that by
    // composing `WidgetField` (`w-full max-w-md`). The table was the one that did not: it
    // returned a bare `<div>`, so the div grew to the grid's max-content, the kit's own
    // `overflow-x-auto` container (which is `w-full` OF THIS DIV) grew with it, and a scroller
    // that is always as wide as its content never scrolls. The result was not a scrollable
    // table, it was an overflowing one — the last heading and the row action simply cut off at
    // the pane edge, at EVERY pane width, with the grid measuring identically at 180px and at
    // 300px because the pane was never an input to it.
    //
    // Stating the width hands the container the pane's width instead, so the grid fits when it
    // can and SCROLLS INSIDE ITSELF when it cannot — which is the repo's rule for wide content,
    // and the only answer that can hold at a width the user picks. `min-w-0` says the same
    // thing to any future flex ROW ancestor, where `width` alone would still be floored at
    // min-content.
    <div className="w-full min-w-0" data-testid={testid(spec, 'table')}>
      {/* WHAT THIS BLOCK IS — rendered above the grid AND above the empty state, because an
          unnamed empty block is the case that needs the name most. See `TableWidget.heading`. */}
      {w.heading ? (
        <p
          className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          data-testid={`${testid(spec, 'table')}-heading`}
        >
          {w.heading}
        </p>
      ) : null}
      {/* NO ROWS ⇒ an empty STATE, not an empty grid.
          A grid with nothing in it draws its headings over a void: it announces a structure and
          withholds every instance of it, at exactly the moment the reader knows least — and the
          titled, populated-LOOKING frame reads as "this part is done" rather than "this is yours
          to fill". Solved once here rather than per view, because "a list is empty" is a property
          of the primitive and nothing about it belongs to any one form.
          The engine supplies the heading; the SENTENCE under it is the view's, because core knows
          the rows are a list and nothing about what one MEANS (INV-6) — while the view knows both
          that and which affordance beside the table makes the first one. */}
      {rows.length === 0 ? (
        <Empty
          data-testid={`${testid(spec, 'table')}-empty`}
          className="border"
          title={TABLE_EMPTY_TITLE}
          description={w.empty_text}
        />
      ) : (
        <Table<Row>
          data-testid={`${testid(spec, 'table')}-grid`}
          columns={columns}
          dataSource={rows}
          rowKey={(_record, index) => String(index)}
          renderRowDetail={rowDetail}
        />
      )}
      {/* A table is not a `WidgetField`, so a requirement about the ROW SET — too few rows,
          two rows that collide — has no label to hang under. It goes UNDER the grid, which
          is where the row set ends and where an "Add" affordance sits: the message and the
          action that answers it are then adjacent. */}
      {ctx.error ? (
        <p
          role="alert"
          data-testid={`${testid(spec, 'table')}-error`}
          className="mt-2 text-sm text-destructive"
        >
          {ctx.error}
        </p>
      ) : null}
    </div>
  )
}

// ── button ───────────────────────────────────────────────────────────────────
const BUTTON_VARIANT: Record<string, 'default' | 'outline' | 'destructive'> = {
  primary: 'default',
  default: 'outline',
  destructive: 'destructive',
}

export const ButtonRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as ButtonWidget
  // A button with no visible `label` would be nameless — fall back to an aria-label
  // (its widget id or the bound action) so it still has an accessible name.
  const hasLabel = typeof w.label === 'string' && w.label.length > 0
  const extra = resolveArgs(w.args, ctx.scope)
  // `disabledWhen` is DISABLED-AND-VISIBLE, deliberately not `when` (which unmounts).
  // A Run button is what the user is looking for; hiding it while its inputs are
  // incomplete leaves them staring at a form with no primary action and no explanation.
  // `evalWhen` is reused so the two gates share one expression grammar — an absent
  // `disabledWhen` is `undefined`, which `evalWhen` treats as met, so it is negated here
  // rather than defaulted.
  const declaredDisabled = w.disabledWhen != null && evalWhen(w.disabledWhen, ctx.scope)
  // A second reason to be disabled, supplied by the HOST rather than the view: an identical
  // launch is already in the air. It is not a `disabledWhen` a processor could write — the view
  // cannot see what is in flight — and it must not be one, or the guard would be opt-in and
  // absent from exactly the analyses whose authors did not think of it.
  const blocked = ctx.actionBlockedReason?.(w.onClick)
  // A THIRD reason, and the one that replaces the hand-written predicate: the form's own
  // requirements are not met. It is DERIVED from the same verdicts the fields show
  // (`core/form/validity.ts`), never recomputed here — a gate that can disagree with what
  // the fields say is the defect this construct exists to remove, not a second opinion.
  const incomplete = ctx.submitGate?.canSubmit === false
  // A FOURTH reason, and the only one that arrives WITH its explanation (ITEM-29c). It is the
  // view's own per-control refusal, so it takes kit's unavailable path rather than the native
  // `disabled` one: aria-disabled, the reason as the tooltip and as an sr-only described-by
  // node, the NAME left alone. It is not folded into `disabled` above because a natively
  // disabled control shows no tooltip, which would throw away the string that is the point.
  const refusal = refusalReason(w.unavailableReason, ctx.scope)
  const requirements = incomplete ? (ctx.requirements ?? []) : []
  const elided = incomplete ? (ctx.requirementsElided ?? 0) : 0
  const disabled = declaredDisabled || blocked != null || incomplete
  // Does this control SUBMIT the form — i.e. is it the affordance that starts the work the user
  // opened the pane to start?
  //
  // Read off `submitGate`, which the host hands ONLY to a control bound to an action whose body
  // dispatches a run (`core/form/validity.ts::submitActionIds`). So the answer is DERIVED from
  // what the action DOES, and a view cannot get it wrong, forget it, or claim it for a control
  // that starts nothing.
  //
  // It is deliberately NOT a declared variant on the widget. A `footer: true` (or a
  // `variant: submit`) would be a SECOND encoding of a fact the engine already holds, opt-in and
  // therefore absent from exactly the views whose authors did not think of it — and free to
  // contradict the gate, so a form could grow a footer around a control that submits nothing while
  // its real Run sat inline. It is not the VIEW's layout either: a view spec has no placement
  // vocabulary at all (INV-3, `widgets` is the order), and giving every yaml a hand-rolled footer
  // to compose is how N forms end up with N slightly different ones.
  const submits = ctx.submitGate !== undefined
  // WHAT THE BUTTON SAYS, with `{…}` segments resolved (visualize-pane ITEM-30/ITEM-43).
  //
  // A standalone action button's label was rendered verbatim, which makes *"name the SUBJECT,
  // not the verb"* inexpressible for a control whose subject is a value the user just chose:
  // the bare-frame ▶ has to name what it plots, and `Plot` alone is the shape this rule exists to
  // refuse. `interpolateBraces` is the app's existing explicitly-delimited form (the one
  // `inputs_from` slot names and `axis_entry_values` column names already use), so this adds no
  // second syntax — and a label with no braces returns unchanged, so every shipped label is
  // byte-identical.
  const buttonLabel = interpolateBraces(w.label, ctx.scope)
  const button = (
    <Button
      data-testid={testid(spec, 'button')}
      aria-label={hasLabel ? undefined : ((spec as { id?: string }).id ?? w.onClick ?? 'button')}
      variant={BUTTON_VARIANT[w.variant ?? 'default']}
      disabled={disabled}
      unavailableReason={refusal}
      // Belt AND braces: a disabled `<button>` fires no click, but this renderer's kit
      // primitive could be swapped for a div-based one, and an action that runs a job is
      // not something to leave guarded by a single attribute.
      onClick={() => {
        if (disabled || refusal != null) return
        ctx.dispatch(w.onClick, extra)
      }}
    >
      {buttonLabel}
    </Button>
  )
  const reasons = (
    <>
      {/* The reason lives BESIDE the control, not only in a tooltip (DEC-3): a disabled primary
          action with no stated cause is indistinguishable from a broken one, and a tooltip is
          unreachable on touch and invisible to a user who never hovers. */}
      {blocked != null ? (
        <p data-testid={`${testid(spec, 'button')}-blocked`} className="text-xs text-muted-foreground">
          {blocked}
        </p>
      ) : null}
      {/* WHY it is refused, through the SAME node the in-flight reason renders through. It
          answers the one question a disabled primary action cannot answer for itself, and it
          is the only place the requirements a field deliberately keeps quiet about — an empty
          control the user has not reached yet — are stated at all (DEC-4).
          `role="status"` rather than `alert`: it appears as a consequence of what the user is
          doing, and interrupting them on every keystroke would be worse than useless. */}
      {requirements.length > 0 ? (
        <div
          role="status"
          data-testid={`${testid(spec, 'button')}-requirements`}
          className="flex flex-col gap-0.5 text-xs text-muted-foreground"
        >
          <span>{SUMMARY_LEAD}</span>
          <ul className="flex list-disc flex-col gap-0.5 ps-4">
            {requirements.map(r => (
              <li key={r.key} data-testid={`${testid(spec, 'button')}-requirement`}>
                {r.label} — {r.message}
              </li>
            ))}
          </ul>
          {elided > 0 ? <span>{`…and ${elided} more.`}</span> : null}
        </div>
      ) : null}
    </>
  )
  if (submits) {
    // THE FOOTER. A muted bar spanning the form column with the action at its END — the same
    // shape a dialog gives the control that commits it, and for the same reason: the thing that
    // starts the work has to be findable as THE thing, not as the Nth button down a column of
    // peers. Inline, "Compute" sat between an "Add" affordance and a plot toggle, styled like
    // them and read like them.
    //
    // Its own bar rather than a bleed to the pane edges, because it is not the last thing in the
    // pane — the run LIST follows it — so an edge-to-edge band would claim to close a surface it
    // does not close.
    //
    // The unmet requirements sit ABOVE the action inside the bar: they are what the action is
    // waiting for, and reading them after having already passed the control is reading them too
    // late.
    return (
      <div
        data-slot="run-footer"
        data-testid={`${testid(spec, 'button')}-footer`}
        className="flex w-full flex-col gap-2 rounded-md border border-border bg-muted/50 p-3"
      >
        {reasons}
        <div className="flex justify-end">{button}</div>
      </div>
    )
  }
  return (
    // A STABLE single root, with the reason as a conditional CHILD.
    //
    // This returned a fragment whose second child appeared and disappeared with `blocked`, so a
    // widget's node COUNT changed as the guard engaged and released. React then crashed the whole
    // app on the toggle — `NotFoundError: Failed to execute 'insertBefore'` — and the error
    // boundary replaced the page. It only ever showed up on a SECOND run of the SAME analysis,
    // because that is the only sequence in which the guard both engages and releases in one
    // mount; a single run, or runs of two different analyses, never toggle it.
    //
    // `display: contents` keeps the root out of layout, so the button sits in its parent's flex
    // or grid exactly as a bare `<Button>` did.
    <div className="contents">
      {button}
      {reasons}
    </div>
  )
}

// ── alert ────────────────────────────────────────────────────────────────────
export const AlertRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as AlertWidget
  const text = w.text != null ? String(evalExpr(w.text, ctx.scope)) : ''
  // ZERO, ONE and SEVERAL producers are three renderings (DEC-7).
  //
  //   several — every one offered; picking for the user is the "only one match, selected
  //             automatically" mistake that once bound a picker to identifier columns.
  //   one     — a direct affordance naming it.
  //   zero    — the text alone. A link that goes nowhere is worse than no link, and this is
  //             the ordinary state of a deployment whose domain ships no such producer.
  //
  // Each target is labelled by its OWN title: a consumer that wrote the label would go stale
  // exactly as a hardcoded id would.
  const targets = w.action?.launch === 'producer' ? (ctx.producerTargets?.() ?? []) : []
  return (
    <Alert data-testid={testid(spec, 'alert')} tone={w.tone ?? 'info'} description={text}>
      {targets.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid={`${testid(spec, 'alert')}-actions`}>
          {targets.map(t => (
            <Button
              key={t.id}
              variant="outline"
              data-testid={`${testid(spec, 'alert')}-launch-${t.id}`}
              onClick={() => ctx.launchAnalysis?.(t.id)}
            >
              {t.title}
            </Button>
          ))}
        </div>
      ) : null}
    </Alert>
  )
}

// ── stat ─────────────────────────────────────────────────────────────────────
export const StatRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as StatWidget
  const value = w.value != null ? (evalExpr(w.value, ctx.scope) as number | string) : ''
  return (
    <Statistic
      data-testid={testid(spec, 'stat')}
      title={w.label ?? ''}
      value={value == null ? '' : (value as number | string)}
    />
  )
}

// ── group ────────────────────────────────────────────────────────────────────
export const GroupRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as GroupWidget
  const label = w.label != null ? String(evalExpr(w.label, ctx.scope)) : undefined
  // A group renders as a subtle, self-delineating CARD spanning the form column: the border + muted
  // fill visually separate repeated groups (e.g. each cell-filter criterion row), `items-start`
  // keeps its buttons (e.g. "Remove criterion") content-sized instead of stretching, and its
  // width-capped `Field` children fill the card.
  return (
    <div
      className="flex w-full flex-col items-start gap-3 rounded-md border border-border bg-muted/40 p-3"
      data-testid={testid(spec, 'group')}
    >
      {label ? <div className="text-sm font-medium">{label}</div> : null}
      {ctx.renderChildren(w.children ?? [], ctx.scope)}
    </div>
  )
}

// ── dataset-picker ────────────────────────────────────────────────────────────
//
// GATED, not finished (declarative-rendering-hardening DEC-4, F9). The project-attachments
// dataset SOURCE is still the wave-2 boundary — this renderer does NOT invent one. What it
// no longer does is render a blank control that merely echoes its own bound value with no
// affordance and no explanation:
//
//   • it now honors a declared `options` binding exactly like `select` — the SAME
//     {@link ClosedSetSelect}, so a spec that CAN supply choices (e.g. from a `$derived`
//     list) gets a real, working picker; and
//   • when nothing resolves it reads as the shared DISABLED empty state ("No datasets
//     available") instead of an empty box, so the state is legible.
//
// The currently-bound value is still shown when there are no options, so a picker that was
// set elsewhere never appears to have lost its value.
export const DatasetPickerRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as DatasetPickerWidget
  const declared = toOptions(evalExpr((w as { options?: unknown }).options, ctx.scope), ctx.scope)
  // See the `select` note: emptiness is a property of the DECLARED binding (FIX-3.4).
  const isEmpty = declared.length === 0
  return (
    <WidgetField
      label={w.label}
      testid={testid(spec, 'dataset-picker')}
      ariaLabel="dataset"
      description={isEmpty ? EMPTY_DATASET_LABEL : undefined}
      error={ctx.error}
    >
      {({ id, ariaLabel, describedBy, invalid }) => (
        <ClosedSetSelect
          id={id}
          testid={`${testid(spec, 'dataset-picker')}-select`}
          ariaLabel={w.label ?? ariaLabel}
          describedBy={describedBy}
          invalid={invalid}
          declared={declared}
          value={evalExpr(w.value, ctx.scope)}
          emptyLabel={EMPTY_DATASET_LABEL}
          unchosenLabel={UNCHOSEN_OPTION_LABEL}
          onChange={v => ctx.dispatch(w.onChange, { value: v })}
        />
      )}
    </WidgetField>
  )
}
