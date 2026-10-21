// The FORM-VALIDITY PRE-PASS (declarative-form-validation §6) — the ONE place a
// declarative form's requirements are evaluated, and the producer the `SubmitGate`
// contract in `./gate.ts` has been waiting for.
//
// ## Why a pre-pass and not a computation inside the renderers
//
// A requirement is DECLARED once and consumed in three places — the field's own message,
// the form summary beside the primary action, and the gate on that action. If any of them
// re-derives it, two encodings of one rule exist and can disagree; that is the failure
// this module replaces, one level up from where it happened (a hand-written boolean string
// per form, with a hand-copied prose restatement beside it).
//
// So this walks the widget tree ONCE, with THE SAME `expandForEach` + `evalWhen` the
// renderer walks, and answers every consumer from one verdict map. Two consequences are
// load-bearing rather than incidental:
//
//   · A widget whose `when` is false is NOT drawn, so its constraint is not evaluated — a
//     requirement the user cannot see is not one they can meet.
//   · A repeated widget's verdict is computed IN THAT INSTANCE'S SCOPE, from the same
//     binding the control displays. Computing against `store.state` while the control
//     renders from an iteration scope is exactly how instance i comes to show instance j's
//     error.
//
// ## What this module may name
//
// Nothing but the view's own words. A default message interpolates the control's own
// `label` and no other noun; every other sentence here is about forms, not about what any
// particular form is for.

import type {
  RequireSpec,
  TableColumnSpec,
  TableWidget,
  ViewCheckSpec,
  ViewSpec,
  WidgetBase,
  WidgetSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import { tableRowParts, tableRowPrimitives } from '@/modules/workbench/core/spec/schema'
import { evalExpr, evalWhen, expandForEach, type Scope } from '@/modules/workbench/core/runtime/expr'
import { parseBound } from '@/modules/workbench/core/criteria/criteria'
import {
  CATALOG_SCOPE_KEY,
  readCatalogScope,
} from '@/modules/workbench/core/artifacts/catalog'
import { resolveArtifactRefSource } from '@/modules/workbench/core/runtime/axisSource'
import type { SubmitGate } from './gate.ts'
import {
  SUMMARY_LIMIT,
  instanceKey,
  partKey,
  type FieldVerdict,
  type FormValidity,
  type RequirementLine,
  type ViolationKind,
} from './validityContract.ts'

// The contract half — the verdict shapes, the address vocabulary, the display rule and
// the channel — lives in `./validityContract.ts`, which the public barrel can carry (this
// module cannot: the DEC-6 answer reaches the catalog resolver, and through it a subtree
// the strip-types runner that pins that barrel cannot parse). Re-exported here so a
// core-side consumer has ONE import, and so the two halves cannot drift into two
// vocabularies.
export type { FieldVerdict, FormValidity, RequirementLine, ViolationKind } from './validityContract.ts'
export {
  FORM_VALIDITY_SCOPE_KEY,
  SUMMARY_LEAD,
  SUMMARY_LIMIT,
  instanceKey,
  partKey,
  readFormValidity,
  shouldShow,
} from './validityContract.ts'

/** The answer for a spec that declares nothing to check. */
const EMPTY_VALIDITY: FormValidity = {
  verdicts: new Map(),
  gate: { canSubmit: true },
  summary: [],
  elided: 0,
  submitActions: new Set(),
}

// ── value shapes ──────────────────────────────────────────────────────────────────────

/** Is a single value PRESENT? `''`/`null`/`undefined` are the three ways a control says
 *  "nothing here"; a `0` or a `false` is a real answer and must not read as absence. */
function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.some(isPresent)
  return true
}

/** The PRESENT entries of a list-valued binding. Holes and blanks are not entries: a
 *  list written by index can be `length` 3 with two holes, and a length comparison
 *  cannot see that while a per-entry count can. */
function presentEntries(v: unknown): unknown[] {
  if (!Array.isArray(v)) return isPresent(v) ? [v] : []
  return v.filter(isPresent)
}

// ── default messages (the view's `label`, and no other noun) ──────────────────────────

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

function defaultMessage(kind: ViolationKind, req: RequireSpec): string {
  switch (kind) {
    case 'required':
      return 'Required.'
    case 'min_items':
      return `Needs at least ${req.min_items} ${plural(req.min_items ?? 1, 'entry', 'entries')}.`
    case 'max_items':
      return `Keep at most ${req.max_items} ${plural(req.max_items ?? 1, 'entry', 'entries')}.`
    case 'number':
      return numberMessage(req)
    case 'unique_by':
      return 'Two entries are the same where each must be different.'
    case 'not_in':
      return '"{value}" is already taken — choose another.'
    default:
      return 'Not valid.'
  }
}

/** The constraints whose remedy is "supply a value", and therefore the ones a BLOCK-level
 *  authored sentence speaks for. The RELATIONS are excluded on purpose: a sentence written
 *  about an absent value is actively wrong as the explanation of a collision, and a control
 *  carrying both would otherwise describe two remedies with one sentence. A relation gets its
 *  own wording through the per-constraint map. */
const BLOCK_MESSAGE_KINDS: ReadonlySet<ViolationKind> = new Set([
  'required',
  'min_items',
  'max_items',
  'number',
])

function numberMessage(req: RequireSpec): string {
  const n = req.number ?? {}
  const parts: string[] = []
  if (n.integer) parts.push('a whole number')
  else parts.push('a plain decimal number')
  if (n.min !== undefined && n.max !== undefined) parts.push(`between ${n.min} and ${n.max}`)
  else if (n.min !== undefined) parts.push(`of at least ${n.min}`)
  else if (n.max !== undefined) parts.push(`of at most ${n.max}`)
  return `Enter ${parts.join(' ')}.`
}

/** The sentence for one violation: the authored one where the author wrote one, else the
 *  engine's — with `{value}` filled in from the offending value, so a collision can name what
 *  it collided with (in the form summary the control's own contents are not on screen). */
function messageFor(kind: ViolationKind, req: RequireSpec, offending?: unknown): string {
  const authored = req.message
  let picked: string | undefined
  if (typeof authored === 'string') {
    if (BLOCK_MESSAGE_KINDS.has(kind) && authored.trim() !== '') picked = authored.trim()
  } else if (authored && typeof authored === 'object') {
    const one = (authored as Record<string, unknown>)[kind]
    if (typeof one === 'string' && one.trim() !== '') picked = one.trim()
  }
  const text = picked ?? defaultMessage(kind, req)
  if (!text.includes('{value}')) return text
  return text.split('{value}').join(offending === undefined || offending === null ? '' : String(offending))
}

// ── the constraint evaluators ─────────────────────────────────────────────────────────

interface Violation {
  kind: ViolationKind
  message: string
  empty: boolean
}

/**
 * Evaluate ONE `require` block against ONE resolved value.
 *
 * Returns AT MOST ONE violation, in a fixed order: presence first, then shape, then the
 * between-entries relation. Reporting several at once would stack three sentences under a
 * blank control that needs one answer.
 */
function evaluateRequire(
  req: RequireSpec,
  value: unknown,
  /** Resolve a `$`-ref IN THE SAME SCOPE the value was read from — the only way a
   *  constraint may reach outside its own control, and only to a set the VIEW named. */
  resolve?: (expr: string) => unknown,
): Violation | undefined {
  if (req.required === true && !isPresent(value)) {
    return { kind: 'required', message: messageFor('required', req), empty: true }
  }
  if (typeof req.min_items === 'number') {
    const n = presentEntries(value).length
    if (n < req.min_items) {
      return { kind: 'min_items', message: messageFor('min_items', req), empty: n === 0 }
    }
  }
  if (typeof req.max_items === 'number') {
    const n = presentEntries(value).length
    if (n > req.max_items) {
      return { kind: 'max_items', message: messageFor('max_items', req), empty: false }
    }
  }
  if (req.number !== undefined && isPresent(value)) {
    const v = numberViolation(req, value)
    if (v) return v
  }
  if (typeof req.unique_by === 'string' && req.unique_by !== '') {
    if (hasDuplicate(value, req.unique_by)) {
      return { kind: 'unique_by', message: messageFor('unique_by', req), empty: false }
    }
  }
  // Uniqueness against the ENVIRONMENT, which is a different question from uniqueness
  // within the form's own list — a form can satisfy `unique_by` completely and still collide
  // with something already out there. Only asked of a value that IS present: "you have not
  // answered" is `required`'s question, and reporting an empty field as already-taken would
  // be a second, wrong sentence about the same blank.
  if (typeof req.not_in === 'string' && req.not_in.trim() !== '' && isPresent(value) && resolve) {
    const taken = takenSet(resolve(req.not_in))
    const spelled = String(value)
    if (taken.has(spelled)) {
      return { kind: 'not_in', message: messageFor('not_in', req, spelled), empty: false }
    }
  }
  return undefined
}

/**
 * The set of values a `not_in` reference names, from either shape the vocabulary already
 * produces.
 *
 * An ARRAY is a list of values — each entry read as its `value` field when it has one, else
 * as itself, which is the same `{value,label}`-or-scalar normalization every options binding
 * in this vocabulary uses. A plain OBJECT is read as its KEYS, which is the shape a
 * name→something map already has, so a view can point at one without deriving a list first.
 */
function takenSet(resolved: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(resolved)) {
    for (const entry of resolved) {
      if (entry === null || entry === undefined) continue
      if (typeof entry === 'object') {
        const v = (entry as { value?: unknown }).value
        if (v !== undefined && v !== null) out.add(String(v))
        continue
      }
      out.add(String(entry))
    }
    return out
  }
  if (resolved && typeof resolved === 'object') {
    for (const key of Object.keys(resolved as Record<string, unknown>)) out.add(key)
  }
  return out
}

/**
 * DEC-7 — the numeric grammar is `criteria/criteria.ts`'s, not a new one.
 *
 * `parseBound` is the normative coercion, with four conforming readers pinned by a
 * committed corpus, and its whole existence is a record of what happens when readers
 * disagree. Note the deliberate consequence: the form reports as INVALID precisely the
 * inputs those readers treat as UNBOUNDED. That is the point — the coercion stays
 * "unbounded, not an error" so the readers keep agreeing, and the FORM is the layer that
 * says the user probably did not mean unbounded.
 */
function numberViolation(req: RequireSpec, value: unknown): Violation | undefined {
  const n = req.number ?? {}
  const raw = typeof value === 'number' || typeof value === 'string' ? value : undefined
  const parsed = parseBound(raw)
  if (parsed === undefined) {
    return { kind: 'number', message: messageFor('number', req), empty: false }
  }
  if (n.integer === true && !Number.isInteger(parsed)) {
    return { kind: 'number', message: messageFor('number', req), empty: false }
  }
  if (n.min !== undefined && parsed < n.min) {
    return { kind: 'number', message: messageFor('number', req), empty: false }
  }
  if (n.max !== undefined && parsed > n.max) {
    return { kind: 'number', message: messageFor('number', req), empty: false }
  }
  return undefined
}

/** Do two entries of a list share the value of `field`? A blank is a value like any
 *  other: two entries that have both been left blank ARE the same, and the run that
 *  refuses duplicates does not exempt them. */
function hasDuplicate(value: unknown, field: string): boolean {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = (entry as Record<string, unknown>)[field]
    const spelled = raw === undefined || raw === null ? '' : String(raw)
    if (seen.has(spelled)) return true
    seen.add(spelled)
  }
  return false
}

// ── the walk ──────────────────────────────────────────────────────────────────────────

/** The binding a widget's own value lives on, by kind. A widget with no value binding
 *  has nothing to constrain (and `parseViewSpec` refuses a `require` on one). */
function valueExprOf(w: WidgetSpec & Record<string, unknown>): string | undefined {
  if (w.kind === 'table') return typeof w.rows === 'string' ? w.rows : undefined
  if (w.kind === 'list-editor') return typeof w.items === 'string' ? w.items : undefined
  return typeof w.value === 'string' ? w.value : undefined
}

/** The value-bearing per-row primitives of one table column, in declaration order.
 *
 *  The ENUMERATION is the validator's (`core/spec/schema.ts::tableRowPrimitives`), shared so
 *  the two readers cannot come to disagree about what a per-row primitive is; what is added
 *  here is the narrowing to the ones that actually BIND a value, which is what a constraint
 *  can be about. A primitive added to the vocabulary tomorrow is covered by both the day it
 *  ships, rather than on the day someone remembers to extend a list. */
function valueBearingPrimitives(
  col: unknown,
): Array<{ value: string; require?: RequireSpec; when?: string }> {
  const out: Array<{ value: string; require?: RequireSpec; when?: string }> = []
  for (const { decl } of tableRowPrimitives(col)) {
    const p = decl as { value?: unknown; require?: unknown; when?: unknown }
    if (typeof p.value !== 'string') continue
    out.push({
      value: p.value,
      require: p.require as RequireSpec | undefined,
      when: typeof p.when === 'string' ? p.when : undefined,
    })
  }
  return out
}

interface RenderedInstance {
  widgetId: string
  path: number[]
  label?: string
  scope: Scope
}

interface WalkState {
  verdicts: Map<string, FieldVerdict>
  /** every rendered instance, in walk order — the address space a `check`'s `at` resolves
   *  against. */
  rendered: RenderedInstance[]
  /** declaration-ordered violation keys, so the summary reads top to bottom. */
  order: string[]
}

/** A widget's own declared label, when it is a literal rather than a binding (a `$`-ref
 *  label would print the binding, not a name). */
function labelOf(w: WidgetSpec & Record<string, unknown>): string | undefined {
  const l = w.label
  if (typeof l !== 'string') return undefined
  const t = l.trim()
  if (t === '' || t.startsWith('$')) return undefined
  return t
}

function record(state: WalkState, verdict: FieldVerdict): void {
  if (state.verdicts.has(verdict.key)) return
  state.verdicts.set(verdict.key, verdict)
  state.order.push(verdict.key)
}

/**
 * Is this control's requirement SATISFIABLE from this form? (DEC-6.)
 *
 * Only an `artifact_ref` can answer: it resolves its own candidate set, and an empty one
 * is the project's state rather than an unanswered question. The check is skipped
 * entirely when the host published no catalog channel — "the engine cannot tell" must not
 * read as "there is nothing to choose".
 */
function isUnsatisfiable(w: WidgetSpec & Record<string, unknown>, scope: Scope): boolean {
  if (w.kind !== 'artifact_ref') return false
  if (scope[CATALOG_SCOPE_KEY] == null) return false
  const { artifacts, lattice } = readCatalogScope(scope)
  try {
    return resolveArtifactRefSource(artifacts, w.source as never, scope, { lattice }).length === 0
  } catch {
    return false
  }
}

function walkWidgets(widgets: readonly WidgetSpec[], scope: Scope, path: readonly number[], state: WalkState): void {
  for (const spec of widgets) {
    let entries
    try {
      entries = expandForEach(spec as WidgetSpec & { for_each?: string }, scope)
    } catch {
      // A malformed / oversized repeater throws in the renderer too, where the widget's
      // own error boundary shows a placeholder. There is no requirement to report about a
      // control that did not render.
      continue
    }
    entries.forEach((entry, i) => {
      const w = entry.spec as WidgetSpec & WidgetBase & Record<string, unknown>
      try {
        if (!evalWhen(w.when, entry.scope)) return
      } catch {
        return
      }
      const here = [...path, i]
      const widgetId = typeof w.id === 'string' && w.id !== '' ? w.id : `${String(w.kind)}`
      state.rendered.push({ widgetId, path: here, label: labelOf(w), scope: entry.scope })
      try {
        evaluateWidget(w, entry.scope, here, widgetId, state)
      } catch {
        // A throwing binding is the renderer's problem to surface; it is not a
        // requirement the user failed to meet.
      }
      if (w.kind === 'group' && Array.isArray(w.children)) {
        walkWidgets(w.children as WidgetSpec[], entry.scope, here, state)
      }
    })
  }
}

function evaluateWidget(
  w: WidgetSpec & WidgetBase & Record<string, unknown>,
  scope: Scope,
  path: readonly number[],
  widgetId: string,
  state: WalkState,
): void {
  const label = labelOf(w)
  const req = w.require
  if (req && typeof req === 'object') {
    const expr = valueExprOf(w)
    const value = expr === undefined ? undefined : evalExpr(expr, scope)
    const violation = evaluateRequire(req, value, ref => evalExpr(ref, scope))
    if (violation) {
      record(state, {
        key: instanceKey(widgetId, path),
        widgetId,
        kind: violation.kind,
        message: violation.message,
        label,
        empty: violation.empty,
        unsatisfiable: isUnsatisfiable(w, scope),
      })
    }
  }
  if (w.kind !== 'table') return
  const table = w as unknown as TableWidget
  const rows = evalExpr(table.rows, scope)
  if (!Array.isArray(rows)) return
  // The table's row-scoped PARTS — its columns AND its detail band — through the one shared
  // enumeration, so a constraint declared on a banded control is evaluated on exactly the terms
  // one declared on a column is. A `for_each` part expands first; a band declares none, so the
  // flatMap passes it through untouched.
  const columns = tableRowParts(table)
    .map(c => c.decl as TableColumnSpec)
    .flatMap(col => (col.for_each ? expandForEach(col, scope).map(e => e.spec) : [col]))
  for (const col of columns) {
    const columnKey = String(col.key ?? '')
    for (const primitive of valueBearingPrimitives(col)) {
      if (!primitive.require) continue
      rows.forEach((row, rowIndex) => {
        const rowScope: Scope = { ...scope, row }
        // The PER-ROW render gate, honored here for the same reason a widget's `when` is: a
        // requirement on a field that is not drawn is one the user cannot meet. A column is ONE
        // declaration over N rows, so this is the one place the rule could be lost — and a
        // gate that cannot be READ is not a gate that passed.
        try {
          if (!evalWhen(primitive.when, rowScope)) return
        } catch {
          return
        }
        const value = evalExpr(primitive.value, rowScope)
        // Resolved in the ROW's scope, like the value it is about — a set named with a
        // `$row`-relative reference must mean this row's.
        const violation = evaluateRequire(primitive.require as RequireSpec, value, ref =>
          evalExpr(ref, rowScope),
        )
        if (!violation) return
        record(state, {
          key: instanceKey(widgetId, path, partKey(columnKey, rowIndex)),
          widgetId,
          kind: violation.kind,
          message: violation.message,
          // A per-row field is named by its COLUMN, which is the heading the user reads
          // above it — the widget's own label names the whole table.
          label: columnKey !== '' ? columnKey : label,
          empty: violation.empty,
          unsatisfiable: false,
        })
      })
    }
  }
}

// ── checks (DEC-3) ────────────────────────────────────────────────────────────────────

function evaluateChecks(checks: readonly ViewCheckSpec[], scope: Scope, state: WalkState): void {
  for (const check of checks) {
    if (!check || typeof check !== 'object' || typeof check.fails_when !== 'string') continue
    let entries
    try {
      entries = expandForEach(check as { for_each?: string }, scope)
    } catch {
      continue
    }
    for (const entry of entries) {
      let fails = false
      try {
        fails = evalWhen(check.fails_when, entry.scope)
      } catch {
        continue
      }
      if (!fails) continue
      const target = resolveCheckTarget(check, entry.scope, state)
      // A relation whose target instance is NOT on screen is dropped, for the same reason
      // a `when`-gated control's constraint is not evaluated: a message with nowhere to
      // land is the "disabled with no stated cause" defect wearing a different hat.
      if (!target) continue
      record(state, {
        key: target.key,
        widgetId: target.widgetId,
        kind: 'check',
        message: check.message,
        label: target.label,
        empty: false,
        unsatisfiable: false,
      })
    }
  }
}

/**
 * Which rendered instance a check's `at` addresses.
 *
 * `at.index` is matched against the OUTERMOST repeat index of the instance's path. That
 * is what makes the two shapes agree: a control repeated in its own right is indexed by
 * its own position, and a control inside a repeated container is indexed by the
 * container's — which is the index a per-row relation is written over.
 */
function resolveCheckTarget(
  check: ViewCheckSpec,
  scope: Scope,
  state: WalkState,
): { key: string; widgetId: string; label?: string } | undefined {
  const widgetId = check.at?.widget
  if (typeof widgetId !== 'string' || widgetId === '') return undefined
  const part = typeof check.at?.part === 'string' && check.at.part !== '' ? check.at.part : undefined
  const wanted =
    check.at?.index === undefined ? undefined : Number(evalExpr(check.at.index, scope))
  for (const instance of state.rendered) {
    if (instance.widgetId !== widgetId) continue
    // With a `part`, `index` addresses the ROW of that part — not which instance of the widget
    // — so the instance is matched on id alone and the row goes into the part key. That is the
    // ONLY shape in which a message can reach one row of a table, and it is the same key the
    // column's own control reads its message from.
    if (part !== undefined) {
      return {
        key: instanceKey(widgetId, instance.path, partKey(part, wanted ?? 0)),
        widgetId,
        // Named for the COLUMN, exactly as a per-row REQUIREMENT is: the heading above the
        // offending field, not the widget's label, which names the whole table.
        label: part,
      }
    }
    if (wanted !== undefined && instance.path[0] !== wanted) continue
    return { key: instanceKey(widgetId, instance.path), widgetId, label: instance.label }
  }
  return undefined
}

// ── the submit set ────────────────────────────────────────────────────────────────────

/** The LOCAL action ids whose declared body dispatches a run. A control bound to one of
 *  them is the form's primary action and is gated on validity; every other affordance —
 *  add a row, remove one, toggle a plot — is not, and gating them would make an
 *  incomplete form unfixable. */
function submitActionIds(spec: ViewSpec): Set<string> {
  const out = new Set<string>()
  for (const action of spec.actions ?? []) {
    const body = action?.body ?? []
    if (body.some(op => op && typeof op === 'object' && 'run_processor' in op)) out.add(action.id)
  }
  return out
}

// ── the entry point ───────────────────────────────────────────────────────────────────

/**
 * Evaluate every requirement this form declares, against this render's scope.
 *
 * Pure and total: a throwing binding costs that one widget's verdict, never the pass.
 */
export function evaluateForm(spec: ViewSpec, scope: Scope): FormValidity {
  if (!spec || typeof spec !== 'object') return EMPTY_VALIDITY
  const state: WalkState = { verdicts: new Map(), rendered: [], order: [] }
  try {
    walkWidgets(spec.widgets ?? [], scope, [], state)
    if (Array.isArray(spec.checks)) evaluateChecks(spec.checks, scope, state)
  } catch {
    // Fail CLOSED on an unexpected engine failure: an empty verdict map would read as
    // "everything is valid", which is the one answer a validator must never give by
    // accident.
    return {
      verdicts: new Map(),
      gate: { canSubmit: false, reason: 'This form could not be checked.' },
      summary: [],
      elided: 0,
      submitActions: submitActionIds(spec),
    }
  }
  const actionable = state.order
    .map(k => state.verdicts.get(k))
    .filter((v): v is FieldVerdict => v !== undefined && !v.unsatisfiable)
  const summary: RequirementLine[] = actionable
    .slice(0, SUMMARY_LIMIT)
    .map(v => ({ key: v.key, label: v.label ?? v.widgetId, message: v.message }))
  return {
    verdicts: state.verdicts,
    gate:
      state.verdicts.size === 0
        ? { canSubmit: true }
        : {
            canSubmit: false,
            reason:
              summary.length > 0 ? `${summary[0].label} — ${summary[0].message}` : undefined,
          },
    summary,
    elided: Math.max(0, actionable.length - summary.length),
    submitActions: submitActionIds(spec),
  }
}
