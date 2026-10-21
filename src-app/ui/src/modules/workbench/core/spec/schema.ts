// The `view_spec` parser/validator (PLAN.md ITEM-1). Structural validation
// mirroring the manifest validator (`@/modules/workbench/core` `validateManifest`) —
// dependency-free (DEC-9, no zod: this is trusted first-party config validated
// structurally; the published contract is the type in `@/modules/workbench/core`).
//
// Rejects, at minimum (TEST-1): an unknown widget `kind`, a permission-less
// action, and a dangling `$`-ref (a `$state|$data|$derived|$const` reference to
// a name that section never declares).

import type { ViewSpec, WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import {
  WIDGET_KINDS,
  EFFECT_OPS,
  REQUIRE_KEYS,
  REQUIRE_CONSTRAINT_KEYS,
  NUMBER_REQUIRE_KEYS,
} from './vocabulary'
import { hasWidget } from '@/modules/workbench/core/render/registry'
import { PANE_SCOPE_KEYS } from '@/modules/workbench/core/runtime/paneScopeKeys'
// This module sits on the MODULE-REGISTRATION path: `workbench/module.tsx` calls
// `loadDiscoveredProcessors()` at module eval, which parses+validates every processor's
// `view_spec` — including its `canvas` block — through `parseViewSpec` below. So whatever
// this line pulls is on the boot critical path of EVERY route, the login screen included.
//
// `installBuiltinSchemas()` replaces the `installBuiltins()` this used to call. It registers
// the same 10 chart types with the same `bindingSchema` + `capabilities` — all `parseOption`
// reads; it never touches `descriptor.view` — but with placeholder Views and no deck.gl.
// `GridWorkspace` calls the full `installBuiltins()` at ITS module load, so any path that can
// actually paint a chart has upgraded these before the first render.
//
// Measured by ablation (rebuild with `installBuiltins()` restored, diff the modulepreload set
// in `dist/index.html`): that one swap is worth **339.7 kB gzip** off the preloaded path.
//
// The SPECIFIER is deliberately the plain `@ziee/viz` barrel. A render-free `@ziee/viz/option`
// subpath was built and measured for this import and made ZERO difference (723.05 vs 723.03 kB
// critical path) — rolldown tree-shakes the barrel's unused re-exports perfectly well. What
// costs bytes here is not the import PATH, it is whether a RETAINED value transitively needs
// the Views. So the subpath was reverted rather than kept as decorative indirection.
import { parseOption, installBuiltinSchemas, type VizOption, type DatasetCatalog } from '@ziee/viz'

export interface ViewSpecError {
  path: string
  message: string
}

export interface ParseResult {
  ok: boolean
  value?: ViewSpec
  errors?: ViewSpecError[]
}

const KIND_SET: ReadonlySet<string> = new Set(WIDGET_KINDS)

/** DEC-A — the widget-kind set is OPEN. A `kind` is valid if it is a CORE form-control
 *  kind OR a kind an extension has REGISTERED (`extensions/canvas` owns the plot kinds
 *  and registers them through the ordinary `registerWidget` seam, ITEM-36). Closing this
 *  against `WIDGET_KINDS` alone would make "a processor places a plot in a region"
 *  unvalidatable — the very thing ITEM-36 preserves. The EFFECT vocabulary below stays
 *  equality-closed: rendering is not privilege escalation, ACTING is. */
function isValidKind(kind: unknown): kind is string {
  return typeof kind === 'string' && (KIND_SET.has(kind) || hasWidget(kind))
}
const EFFECT_OP_SET: ReadonlySet<string> = new Set(EFFECT_OPS)
const REQUIRE_KEY_SET: ReadonlySet<string> = new Set(REQUIRE_KEYS)
const NUMBER_REQUIRE_KEY_SET: ReadonlySet<string> = new Set(NUMBER_REQUIRE_KEYS)
const REQUIRE_CONSTRAINT_KEY_SET: ReadonlySet<string> = new Set(REQUIRE_CONSTRAINT_KEYS)

/** Core widget kinds that hold NO value, and can therefore carry no requirement. A
 *  `require` on one of them would PARSE while constraining nothing — the shape DEC-3
 *  refuses: a key that parses leaves an author believing a declaration is in force. An
 *  extension-registered kind is unknown here and is left alone. */
const VALUELESS_KINDS: ReadonlySet<string> = new Set(['button', 'alert', 'stat', 'group'])

/**
 * Validate ONE `require:` block — the CLOSED constraint vocabulary (DEC-2).
 *
 * Closed means REFUSED, not ignored: an author who mistypes `min_item` must be told, or
 * they ship a form that silently requires nothing, which is verbatim the failure this
 * whole construct replaces.
 */
function validateRequire(req: unknown, errors: ViewSpecError[], path: string): void {
  if (req === undefined) return
  if (!isObject(req)) {
    errors.push({ path, message: 'require must be an object of constraints' })
    return
  }
  for (const key of Object.keys(req)) {
    if (!REQUIRE_KEY_SET.has(key)) {
      errors.push({
        path: `${path}.${key}`,
        message: `unknown require key "${key}" (expected one of ${REQUIRE_KEYS.join(', ')})`,
      })
    }
  }
  if (req.required !== undefined && typeof req.required !== 'boolean') {
    errors.push({ path: `${path}.required`, message: 'require.required must be a boolean' })
  }
  for (const key of ['min_items', 'max_items'] as const) {
    const v = req[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      errors.push({ path: `${path}.${key}`, message: `require.${key} must be a non-negative integer` })
    }
  }
  if (req.unique_by !== undefined && (typeof req.unique_by !== 'string' || req.unique_by === '')) {
    errors.push({ path: `${path}.unique_by`, message: 'require.unique_by must be a non-empty field name' })
  }
  if (req.not_in !== undefined && (typeof req.not_in !== 'string' || req.not_in.trim() === '')) {
    errors.push({
      path: `${path}.not_in`,
      message: 'require.not_in must be a reference to the set of values that are already taken',
    })
  }
  if (req.message !== undefined) {
    if (isObject(req.message)) {
      // A per-constraint map is CLOSED like the block itself: a typo'd key would leave the
      // author believing they had written the sentence a user reads.
      for (const key of Object.keys(req.message)) {
        if (!REQUIRE_CONSTRAINT_KEY_SET.has(key)) {
          errors.push({
            path: `${path}.message.${key}`,
            message: `unknown require.message key "${key}" (expected one of ${REQUIRE_CONSTRAINT_KEYS.join(', ')})`,
          })
        } else if (typeof (req.message as Record<string, unknown>)[key] !== 'string') {
          errors.push({ path: `${path}.message.${key}`, message: 'a require.message entry must be a string' })
        }
      }
    } else if (typeof req.message !== 'string') {
      errors.push({
        path: `${path}.message`,
        message: 'require.message must be a string, or a map of constraint name → string',
      })
    }
  }
  const num = req.number
  if (num === undefined) return
  if (!isObject(num)) {
    errors.push({ path: `${path}.number`, message: 'require.number must be an object (use {} for no bounds)' })
    return
  }
  for (const key of Object.keys(num)) {
    if (!NUMBER_REQUIRE_KEY_SET.has(key)) {
      errors.push({
        path: `${path}.number.${key}`,
        message: `unknown require.number key "${key}" (expected one of ${NUMBER_REQUIRE_KEYS.join(', ')})`,
      })
    }
  }
  for (const key of ['min', 'max'] as const) {
    if (num[key] !== undefined && typeof num[key] !== 'number') {
      errors.push({ path: `${path}.number.${key}`, message: `require.number.${key} must be a number` })
    }
  }
  if (num.integer !== undefined && typeof num.integer !== 'boolean') {
    errors.push({ path: `${path}.number.integer`, message: 'require.number.integer must be a boolean' })
  }
}

/** Free-text keys whose string values are prose (labels/messages), NOT `$`-ref
 *  bindings — excluded from dangling-ref scanning so a descriptive
 *  `title: "Adjust $state.threshold"` never raises a spurious dangling-ref error
 *  (finding: validateRefs over-scan). */
const PROSE_KEYS: ReadonlySet<string> = new Set(['title', 'label', 'toast', 'description', 'text'])

/** Widget fields that carry a bare ACTION-ID reference (dispatch targets). */
const ACTION_REF_KEYS = ['onClick', 'onChange', 'onCommit', 'onSelect'] as const

/** Namespaces whose first path segment MUST be a declared name. */
const DECLARED_NAMESPACES = ['state', 'data', 'derived', 'const'] as const
type DeclaredNamespace = (typeof DECLARED_NAMESPACES)[number]

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function reqString(obj: Record<string, unknown>, key: string, errors: ViewSpecError[], path = '$'): void {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    errors.push({ path: `${path}.${key}`, message: `required non-empty string "${key}" missing` })
  }
}

/** Walk every widget (incl. `group` children) and reject an unknown `kind` or a
 *  dispatch (`onClick`/`onChange`/…) that names no declared action id. */
function validateWidgets(
  widgets: unknown,
  errors: ViewSpecError[],
  path: string,
  declaredActionIds: ReadonlySet<string>,
): void {
  if (!Array.isArray(widgets)) {
    errors.push({ path, message: 'widgets must be an array' })
    return
  }
  widgets.forEach((w, i) => validateWidget(w, errors, `${path}[${i}]`, declaredActionIds))
}

/** Reject an action-ref (`w[key]`) that names no declared action id. */
function checkActionRef(
  ref: unknown,
  key: string,
  errors: ViewSpecError[],
  path: string,
  declaredActionIds: ReadonlySet<string>,
): void {
  if (typeof ref !== 'string' || ref.length === 0) return
  if (!declaredActionIds.has(ref)) {
    errors.push({
      path: `${path}.${key}`,
      message: `widget "${key}" references undeclared action "${ref}"`,
    })
  }
}

/** The child-widget ARRAYS a container widget holds, each with the path suffix to reach it.
 *  Generalizes the "descend through `group` children" walk to every container kind: `group`
 *  (`children`), `tabs` (`tabs[].children`), and `list-editor` in CARD mode (`item.children`).
 *  A non-container yields `[]`. One source of truth for the three descent points below. */
function widgetChildGroups(w: Record<string, unknown>): Array<{ children: unknown; suffix: string }> {
  if (w.kind === 'group') return [{ children: (w as { children?: unknown }).children, suffix: 'children' }]
  if (w.kind === 'tabs' && Array.isArray((w as { tabs?: unknown }).tabs)) {
    return ((w as { tabs: unknown[] }).tabs).map((t, i) => ({
      children: isObject(t) ? (t as { children?: unknown }).children : undefined,
      suffix: `tabs[${i}].children`,
    }))
  }
  if (w.kind === 'list-editor' && isObject((w as { item?: unknown }).item)) {
    return [{ children: ((w as { item: { children?: unknown } }).item).children, suffix: 'item.children' }]
  }
  return []
}

function validateWidget(
  w: unknown,
  errors: ViewSpecError[],
  path: string,
  declaredActionIds: ReadonlySet<string>,
): void {
  if (!isObject(w)) {
    errors.push({ path, message: 'widget must be an object' })
    return
  }
  const kind = w.kind
  if (!isValidKind(kind)) {
    errors.push({ path: `${path}.kind`, message: `unknown widget kind "${String(kind)}"` })
  }
  // A requirement belongs to a CONTROL, and a control is something that holds a value
  // (DEC-1). Declared on an affordance that holds none it would parse and constrain
  // nothing, which is worse than being refused.
  if (w.require !== undefined && typeof kind === 'string' && VALUELESS_KINDS.has(kind)) {
    errors.push({
      path: `${path}.require`,
      message:
        `a "${kind}" widget holds no value, so it can carry no "require" — a constraint ` +
        'is declared on the control whose value it constrains (DEC-1). Move it there.',
    })
  } else {
    validateRequire(w.require, errors, `${path}.require`)
  }
  // Dispatch targets must name a declared action (silent-no-op-at-invoke otherwise).
  for (const key of ACTION_REF_KEYS) {
    checkActionRef(w[key], key, errors, path, declaredActionIds)
  }
  const selection = w.selection
  if (isObject(selection)) {
    checkActionRef(selection.onChange, 'selection.onChange', errors, path, declaredActionIds)
  }
  // A table row-scoped PART's per-row PRIMITIVE — its dispatch target and its own `require`.
  //
  // Enumerated generically by {@link tableRowPrimitives}, rather than through a
  // written-down list of the three that exist. The list version had to be extended by hand
  // each time the vocabulary grew (an inline editor, then a per-row action, then a
  // closed-set choice), and each extension was a window in which an undeclared dispatch
  // target on the newest primitive was a silent no-op at invoke. A fourth is covered here
  // the day it ships.
  //
  // The PARTS are enumerated the same way, by {@link tableRowParts}, for the same reason one
  // level up: a table's row-scoped parts stopped being "its columns" the moment a column could
  // FOLD, and a reader that still asks for `.columns` checks a folded part's dispatch target
  // not at all.
  //
  // A FOLDED part's SHAPE, checked before its contents. `tableRowParts` descends through a
  // container silently — which is right for every reader that wants the controls, and wrong as
  // the only judgement: a part declaring BOTH a primitive and sub-parts would have the primitive
  // quietly dropped by that descent, which is the "declares two, renders one, says nothing"
  // failure the row-primitive ordering already had to be pinned against.
  if (Array.isArray(w.columns)) {
    w.columns.forEach((col, ci) => validateRowPartShape(col, errors, `${path}.columns[${ci}]`))
  }
  for (const { decl: rowPart, path: partPath } of tableRowParts(w)) {
    for (const { primitive, decl } of tableRowPrimitives(rowPart)) {
      for (const key of ACTION_REF_KEYS) {
        checkActionRef(
          (decl as Record<string, unknown>)[key],
          `${ROW_PART_KEY}.${primitive}.${key}`,
          errors,
          `${path}.${partPath}`,
          declaredActionIds,
        )
      }
      validateRequire(
        (decl as Record<string, unknown>).require,
        errors,
        `${path}.${partPath}.${primitive}.require`,
      )
    }
  }
  // `list-editor` CARD mode dispatches `add`/`remove` action ids — validate them like any
  // other dispatch target (a typo here is otherwise a silent no-op at the add/remove button).
  if (kind === 'list-editor') {
    checkActionRef((w as Record<string, unknown>).add, 'add', errors, path, declaredActionIds)
    checkActionRef((w as Record<string, unknown>).remove, 'remove', errors, path, declaredActionIds)
  }
  for (const { children, suffix } of widgetChildGroups(w)) {
    if (Array.isArray(children)) {
      validateWidgets(children, errors, `${path}.${suffix}`, declaredActionIds)
    }
  }
}

/**
 * A row-scoped part's own SHAPE — what a FOLD must not be, each fault reported where it was
 * declared: an empty or non-array `parts`, a container that also declares its own primitive, a
 * fold that is also a repetition, and an unnamed sub-part.
 *
 * It is a separate pass from {@link tableRowParts} on purpose: that enumeration answers "which
 * controls are there", and it answers it by descending through a container — so every one of
 * these faults is INVISIBLE to it. A container that also declared a primitive would lose the
 * primitive with no diagnostic at all.
 */
function validateRowPartShape(part: unknown, errors: ViewSpecError[], path: string): void {
  if (!isObject(part)) return
  const subs = part[ROW_SUBPARTS_KEY]
  if (subs === undefined) return
  if (!Array.isArray(subs) || subs.length === 0) {
    errors.push({
      path: `${path}.${ROW_SUBPARTS_KEY}`,
      message: `"${ROW_SUBPARTS_KEY}" must be a non-empty array of row-scoped parts sharing this column`,
    })
    return
  }
  if (part[ROW_PART_KEY] !== undefined) {
    errors.push({
      path,
      message:
        `a column declares "${ROW_PART_KEY}" OR "${ROW_SUBPARTS_KEY}", never both — a folded ` +
        `column holds its controls in its sub-parts, and the "${ROW_PART_KEY}" here would be ` +
        'silently dropped',
    })
  }
  if (part.for_each !== undefined) {
    errors.push({
      path: `${path}.for_each`,
      message:
        `a folded column ("${ROW_SUBPARTS_KEY}") is a fixed set of alternatives, not a ` +
        'repetition — declare one or the other',
    })
  }
  subs.forEach((sub, si) => {
    const subPath = `${path}.${ROW_SUBPARTS_KEY}[${si}]`
    // A sub-part MUST be named. Its key is the entire argument for the fold being a placement
    // change and nothing else — it is what its verdicts, its testid and a `check`'s `at.part`
    // are addressed by. Unnamed, a sub-part falls back to a POSITION shared with the columns
    // around it, so two parts can answer to one testid and one accessible name, and the fold
    // stops being reversible in the only way that matters.
    if (!isObject(sub) || typeof sub.key !== 'string' || sub.key === '') {
      errors.push({
        path: subPath,
        message:
          'a folded sub-part must declare a non-empty "key" — it is the address its verdicts, ' +
          'its test id and a check\'s "at.part" all use',
      })
    }
    validateRowPartShape(sub, errors, subPath)
  })
}

/**
 * The per-row PRIMITIVES one table column declares, in declaration order.
 *
 * Exported because TWO readers ask the same question and must not answer it differently:
 * this validator (which checks each primitive's dispatch target and its `require`) and the
 * form-validity pre-pass (`core/form/validity.ts`, which evaluates that `require` per row).
 * A second hand-written enumeration is how one of them comes to cover a primitive the other
 * does not — which is exactly the window the hand-listed version left open three times.
 */
/**
 * Every ROW-SCOPED PART one table declares, in render order. Each is returned with the spec
 * path it was found at, so a diagnostic still names WHERE.
 *
 * Exported, and used by every reader that walks a table's per-row declarations — this
 * validator, the form-validity pre-pass, the shipped-form conformance tier and the renderer's
 * own tests — for exactly the reason {@link tableRowPrimitives} is exported one level down.
 * "A table's row-scoped parts" was a synonym for "its columns" right up until a column could
 * FOLD, at which point every reader still spelling it `.columns` silently stopped seeing the
 * folded ones: their `require` unevaluated, their dispatch target unchecked, their action
 * reported unreachable. A part is reached here or not at all.
 *
 * A FOLDED column — several mutually-exclusive controls sharing one column — contributes its
 * SUB-PARTS here, not itself: the container holds no primitive, and a reader looking for
 * `require`/dispatch/affordances wants the controls.
 */
/**
 * The key a table's row-scoped part carries its per-row primitive under.
 *
 * Named ONCE, here, and referenced everywhere else — including from the tests that build a
 * table fixture. The word is a table's, not a biology's, and the app-builtin domain guard
 * (`scripts/lint-no-domain-in-builtin.mjs`) cannot tell those apart, so every restatement of
 * the literal is another entry in a ledger that exists to shrink. Naming it is also what the
 * rest of this vocabulary already does — `WIDGET_KINDS`, `REQUIRE_KEYS`, `EFFECT_OPS` are all
 * declared once and read; this key was the one that was not.
 */
export const ROW_PART_KEY = 'cell' as const

/** The key a part carries its FOLDED sub-parts under — several row-scoped parts sharing one
 *  column. Named beside {@link ROW_PART_KEY} and for the same reason: every reader that walks a
 *  table's parts has to descend through it, and a literal spelled at each of them is how one of
 *  them comes to stop descending. */
export const ROW_SUBPARTS_KEY = 'parts' as const

/**
 * Flatten one declared part to the LEAF parts that actually hold a per-row primitive.
 *
 * A part that declares {@link ROW_SUBPARTS_KEY} is a CONTAINER — one column, several
 * mutually-exclusive controls — so it holds no primitive itself and contributes its children
 * instead. Recursive rather than one-level, because "how deep may a fold go" is not a question
 * this enumeration should be the one to answer differently from the renderer.
 */
function flattenRowPart(decl: unknown, path: string): Array<{ decl: unknown; path: string }> {
  if (!isObject(decl)) return []
  const subs = decl[ROW_SUBPARTS_KEY]
  if (!Array.isArray(subs)) return [{ decl, path }]
  return subs.flatMap((sub, si) => flattenRowPart(sub, `${path}.${ROW_SUBPARTS_KEY}[${si}]`))
}

export function tableRowParts(w: unknown): Array<{ decl: unknown; path: string }> {
  if (!isObject(w)) return []
  const out: Array<{ decl: unknown; path: string }> = []
  if (Array.isArray(w.columns))
    w.columns.forEach((col, ci) => out.push(...flattenRowPart(col, `columns[${ci}]`)))
  return out
}

export function tableRowPrimitives(col: unknown): Array<{ primitive: string; decl: unknown }> {
  if (!isObject(col)) return []
  const inner = col[ROW_PART_KEY]
  if (!isObject(inner)) return []
  const out: Array<{ primitive: string; decl: unknown }> = []
  for (const [primitive, decl] of Object.entries(inner)) {
    if (isObject(decl)) out.push({ primitive, decl })
  }
  return out
}

/** Every widget id a spec declares, including inside a `group` — the address space a
 *  `check`'s `at` may name — mapped to the PART keys that widget offers (a table's row-scoped
 *  part keys, which is the only repeated-part address the vocabulary has). A widget with no
 *  parts maps to an empty set, which is what makes "this widget has no parts at all" a
 *  distinct, reportable answer from "no such widget".
 *
 *  The keys come from {@link tableRowParts}, so a FOLDED sub-part is addressable by a `check`
 *  on the same terms a column is: it holds a per-row control, a per-row control can be the
 *  right place to land a verdict, and an address space that stopped at the top-level columns
 *  would refuse that spec rather than serve it. */
function collectWidgetIds(
  widgets: unknown,
  into: Map<string, Set<string>> = new Map(),
): Map<string, Set<string>> {
  if (!Array.isArray(widgets)) return into
  for (const w of widgets) {
    if (!isObject(w)) continue
    if (typeof w.id === 'string' && w.id !== '') {
      const parts = new Set<string>()
      for (const { decl } of tableRowParts(w)) {
        if (isObject(decl) && typeof decl.key === 'string' && decl.key !== '') parts.add(decl.key)
      }
      into.set(w.id, parts)
    }
    for (const { children } of widgetChildGroups(w)) collectWidgetIds(children, into)
  }
  return into
}

/**
 * The widget kinds whose value is a member of a CLOSED SET the engine offers — the kinds for
 * which `""` cannot be a chosen value, because nothing offers it.
 *
 * This is the exact scope of ITEM-28's refusal and it is deliberately NOT "`""` anywhere".
 * `""` is a legitimate value for an open control: a `text` widget's empty box, a `label`
 * deliberately defaulted to a word, a multi `artifact_ref` whose unset is `[]`. INV-2 says as
 * much in one line — *"`null` is the only unset. `""` is a CHOSEN empty string"* — so the rule
 * has to bite exactly where the empty string cannot have been chosen.
 */
const CLOSED_SET_KINDS: ReadonlySet<string> = new Set(['select', 'artifact_ref', 'entry_list'])

/** Every widget in a spec, descending through `group` children — the walk this file did
 *  ad-hoc in two places and now does once. */
function eachWidget(widgets: unknown, visit: (w: Record<string, unknown>, path: string) => void, path = '$.widgets'): void {
  if (!Array.isArray(widgets)) return
  widgets.forEach((w, i) => {
    if (!isObject(w)) return
    const p = `${path}[${i}]`
    visit(w, p)
    for (const { children, suffix } of widgetChildGroups(w)) eachWidget(children, visit, `${p}.${suffix}`)
  })
}

/** The `$state.<path>` a binding names, or `undefined` for any other (or no) binding. */
function stateBindingPath(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^\$state\.([A-Za-z0-9_$.]+)$/.exec(value.trim())
  return m ? m[1].split('.') : undefined
}

/** Walk a declared `default` down a dotted binding path. `undefined` when the path is not
 *  declared, which is NOT a fault here — a field with no default is unset, which is the state
 *  this rule is asking for. */
function defaultAt(field: unknown, path: readonly string[]): unknown {
  let node: unknown = isObject(field) ? field.default : undefined
  for (const seg of path) {
    if (!isObject(node)) return undefined
    node = node[seg]
  }
  return node
}

/**
 * R1 / INV-2 (ITEM-28) — refuse `""` as the DEFAULT of a state field bound to a closed-set
 * control, naming the field.
 *
 * The gap this closes is that `StateFieldSpec.default` is `unknown` and `type` is enforced
 * NOWHERE (`store.ts::initField` only resolves `$`-leaves in the default and never reads
 * `field.type`), so `""` has been every shipped spec's unset sentinel — and it only BEHAVES as
 * unset two layers away, in `ClosedSetSelect`'s `value == null || String(value) === ''` and in
 * the canvas binding's empty-encode rule. Two spellings of one state is how they drift: the
 * moment one layer treats `""` as a chosen member of the set, the form shows a selection nobody
 * made and the run receives it.
 *
 * The refusal is fail-CLOSED at parse, which is the whole point — it cannot be satisfied by
 * remembering, and it fires on the author's own file rather than on a user's screen.
 */
function validateClosedSetDefaults(widgets: unknown, state: unknown, errors: ViewSpecError[]): void {
  if (!isObject(state)) return
  eachWidget(widgets, (w, path) => {
    if (typeof w.kind !== 'string' || !CLOSED_SET_KINDS.has(w.kind)) return
    const bound = stateBindingPath(w.value)
    if (!bound) return
    const [head, ...rest] = bound
    const field = state[head]
    if (field === undefined) return // a dangling ref is `validateRefs`' complaint, not this one
    if (defaultAt(field, rest) !== '') return
    errors.push({
      path: `$.state.${bound.join('.')}.default`,
      message:
        `"${bound.join('.')}" defaults to the empty string, but it is bound to a "${w.kind}" ` +
        `control at ${path} — a CLOSED SET, which never offers "". Use null: null is the only ` +
        'unset, and "" is a value somebody chose (R1/INV-2). An unset closed-set control ' +
        'already renders its own "not chosen yet" state.',
    })
  })
}

/** The widget keys that carry a CANDIDATE BINDING — where a control says what it offers.
 *  `rows` is in the list because a `table`'s rows ARE its offer — each row is a choice;
 *  a table with an unstated empty state is the same defect as a picker with one. */
const CANDIDATE_BINDING_KEYS = ['source', 'options', 'entries', 'rows'] as const

/** Does this binding text depend on something the VIEW cannot see the availability of —
 *  another control's value (`$state.x`) or the pane's anchor (`$scope.axis`)? */
const DEPENDENT_REF = /\$state\.|\$scope\.axis\b/

/** The `$data.<slice>` names a binding text mentions. */
function dataSliceRefs(text: string): string[] {
  return [...text.matchAll(/\$data\.([A-Za-z0-9_]+)/g)].map(m => m[1])
}

/**
 * INV-5 (ITEM-63 / ITEM-23) — a control whose candidate binding DEPENDS on something else
 * must declare `empty_text`.
 *
 * The reason this has to be a PARSE refusal rather than a render-time nicety is the thing
 * INV-5 actually says: **the view cannot observe candidate availability at all.** A spec
 * declares where candidates come from; the engine resolves them later, against a project the
 * author never saw. So the author is the only party who can say what the emptiness MEANS —
 * and they can only say it in advance, in the file. An engine default cannot: "No options"
 * is true of a project where nothing produced them, a row space that was never anchored, and an
 * integrated space whose contributors' columns were never merged, and those are three
 * different situations with three different remedies (ITEM-63: every emptiness says WHICH
 * one it is).
 *
 * SCOPED to DEPENDENT bindings, and the scoping is the half that keeps the rule honest. A
 * control bound to a fixed `$const` list, or to a catalog-wide datatype with no `of:`, has an
 * emptiness the engine CAN describe, because it does not vary with a choice nobody has made
 * yet. Requiring a sentence there would be a different (and much noisier) rule.
 *
 * The dependency is followed through `data:`, because that is how the shipped grammar
 * expresses it: a widget binds `rows: "$data.categorical.columns"`, and it is the SLICE whose
 * `args` name `$scope.axis`. A rule that only read the widget's own text would see none of
 * the six dependent controls that ship today.
 */
function validateDependentEmptyText(widgets: unknown, data: unknown, errors: ViewSpecError[]): void {
  const dependentSlices = new Set<string>()
  if (isObject(data)) {
    for (const [name, slice] of Object.entries(data)) {
      if (DEPENDENT_REF.test(JSON.stringify(slice ?? null))) dependentSlices.add(name)
    }
  }
  eachWidget(widgets, (w, path) => {
    for (const key of CANDIDATE_BINDING_KEYS) {
      const binding = w[key]
      if (binding === undefined) continue
      const text = typeof binding === 'string' ? binding : JSON.stringify(binding)
      const dependent =
        DEPENDENT_REF.test(text) || dataSliceRefs(text).some(s => dependentSlices.has(s))
      if (!dependent) continue
      if (typeof w.empty_text === 'string' && w.empty_text.trim().length > 0) return
      errors.push({
        path: `${path}.empty_text`,
        message:
          `the "${String(w.kind)}" control ${w.id ? `"${String(w.id)}" ` : ''}binds its ` +
          `\`${key}\` to something that depends on another choice, but declares no ` +
          '`empty_text`. The view cannot observe whether candidates exist, so the engine ' +
          'cannot say WHY the list is empty — and "nothing here" is true of three different ' +
          'situations with three different remedies (INV-5). Declare the sentence this ' +
          'emptiness should read as.',
      })
      return
    }
  })
}

/**
 * INV-13 (ITEM-11) — a `state` field may declare `scope: pane`, and the pane's value set is
 * CLOSED.
 *
 * The design caps pane state at two values and says so in as many words: *"Pane state is two
 * values — `$scope.axis` and `$scope.coordinate`. Both radios, both read by every section, and
 * nothing else is shared. No `$scope.colorBy`. There is no such fact."* The store enumerates them
 * (`PANE_SCOPE_KEYS`) and a unit test pins that enumeration — but an enumeration in the app is
 * only half the guard once a SPEC can opt a field into pane scope: a package could otherwise mint
 * a third shared value simply by declaring one, and the enumeration would never see it.
 *
 * So the refusal is here, fail-closed at parse, on the author's own file: `scope` must be exactly
 * `pane`, and a `scope: pane` field's NAME must be one the pane actually holds.
 */
function validatePaneScopedFields(state: unknown, errors: ViewSpecError[]): void {
  if (!isObject(state)) return
  for (const [name, field] of Object.entries(state)) {
    if (!isObject(field) || field.scope === undefined) continue
    if (field.scope !== 'pane') {
      errors.push({
        path: `$.state.${name}.scope`,
        message: `state field "${name}" declares scope "${String(field.scope)}"; the only scope a field may declare is "pane".`,
      })
      continue
    }
    if (!(PANE_SCOPE_KEYS as readonly string[]).includes(name)) {
      errors.push({
        path: `$.state.${name}.scope`,
        message:
          `state field "${name}" declares \`scope: pane\`, but the pane holds no value of that name. ` +
          `The pane's values are a CLOSED set (${PANE_SCOPE_KEYS.join(', ')}) — a section that needs ` +
          'its own value declares an ordinary field, which is per-section and is what a display ' +
          'preference should be (INV-13).',
      })
    }
  }
}

// ── ITEM-27 / INV-19: what a consumer does with an entry's N columns ────────────────────
//
// *"The selection is an ENTRY. The entry becomes a multi-column source. Whatever consumes it
// declares what it does with N columns, and the engine never decides."*
//
// The engine can only hold that rule by REFUSING the declarations that leave it undecided,
// because the alternative — resolving a many-valued source into a single-valued channel — has
// exactly one implementation, and it is `[0]` (INV-3). Two refusals, both at parse:
//
//   · an `entry_list` that declares no `disposition`. The control's own rendering depends on
//     it (`each` gives every source its own sub-toggle; the other two do not), so an absent
//     one is not a default waiting to be chosen — it is a question nobody answered.
//   · a canvas channel bound to an `axis_entry_values` slice with neither a `for_each` on its
//     series (which is how `each` and `combined` both lower — N outputs or N series) nor a
//     `where` on the channel (which is how `one` narrows). That binding hands a MAP of entries
//     to a channel that takes one column.

/** The `data.<slice>.source` value whose bindings this rule governs. Spelled here rather than
 *  imported from the runtime resolver: `core/spec` is the dependency-free parser and must not
 *  acquire an edge into `core/runtime` for one string. The two are pinned equal by
 *  `schema.test.ts::the two spellings are EQUAL` — which
 *  imports BOTH (a test file is excluded from the import-cycle walk, so the pin costs no
 *  production edge). Exported so that pin can read it without re-spelling the literal, which
 *  would make the pin a tautology.
 *
 *  This comment claimed the pin for a while before the pin existed. That is worse than no
 *  comment: renaming the runtime constant would have silently disabled a parse-time refusal
 *  with a note beside it saying a test was watching. */
export const AXIS_ENTRY_VALUES_SOURCE_NAME = 'axis_entry_values'

/** Which slices of this spec are many-valued entry sources. Only the DEFAULT (frame) and the
 *  `sources` arms exist and both are keyed by entry, so both are many-valued. */
function entryValueSliceNames(data: unknown): Set<string> {
  const out = new Set<string>()
  if (!isObject(data)) return out
  for (const [name, decl] of Object.entries(data)) {
    if (isObject(decl) && decl.source === AXIS_ENTRY_VALUES_SOURCE_NAME) out.add(name)
  }
  return out
}

/** Does this binding name one of `slices` — i.e. is it the many-valued map? A binding that
 *  INDEXES into the slice (`$data.chosen[$s.name]`) has already narrowed and is not the
 *  refused shape; only the bare root is. */
function bindsEntryValueSlice(value: unknown, slices: ReadonlySet<string>): string | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^\$data\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim())
  return m && slices.has(m[1]) ? m[1] : undefined
}

/**
 * Refuse a spec that binds an `axis_entry_values` slice into a single-valued channel with no
 * declared disposition construct (INV-19).
 *
 * Walks each canvas series' `encode` channels. A series carrying `for_each` is the `each` /
 * `combined` lowering and is accepted whatever its channels bind — the loop IS the declaration
 * of what happens to N. A channel object carrying `where` is the `one` lowering. Anything else
 * binding the bare slice is refused, naming the series, the channel and the slice.
 */
function validateEntryDispositions(
  canvas: unknown,
  data: unknown,
  widgets: unknown,
  errors: ViewSpecError[],
): void {
  eachWidget(widgets, (w, path) => {
    if (w.kind !== 'entry_list') return
    if (w.disposition === 'each' || w.disposition === 'combined' || w.disposition === 'one') return
    errors.push({
      path: `${path}.disposition`,
      message:
        'an "entry_list" must declare a disposition — "each" (N columns, N outputs), ' +
        '"combined" (N series, one output) or "one" (narrowed by a `where`). An entry ' +
        'resolves to SEVERAL columns and the engine never decides what happens to them ' +
        '(INV-19), so an absent disposition is an unanswered question, not a default.',
    })
  })
  const slices = entryValueSliceNames(data)
  if (slices.size === 0 || !isObject(canvas) || !Array.isArray(canvas.series)) return
  canvas.series.forEach((series, i) => {
    if (!isObject(series)) return
    // `for_each` IS the declaration: `each` and `combined` differ only in whether the loop
    // varies the `coordId`, and both are the loop.
    if (typeof series.for_each === 'string' && series.for_each.trim() !== '') return
    const encode = series.encode
    if (!isObject(encode)) return
    for (const [channel, bound] of Object.entries(encode)) {
      // A channel written as an object may carry `where` — the `one` disposition's narrowing,
      // over the column's OWN declarations and never a position.
      const value = isObject(bound) ? (bound.entry ?? bound.key) : bound
      if (isObject(bound) && bound.where !== undefined) continue
      const slice = bindsEntryValueSlice(value, slices)
      if (slice === undefined) continue
      errors.push({
        path: `$.canvas.series[${i}].encode.${channel}`,
        message:
          `binds the axis_entry_values slice "${slice}" into a single-valued channel with ` +
          'neither a `for_each` on the series nor a `where` on the channel. An entry resolves ' +
          'to N columns; declare "each"/"combined" with a for_each, or narrow to exactly one ' +
          'with `where` (INV-19). The engine will not take the first.',
      })
    }
  })
}

/** Validate the view-level `checks:` list (DEC-3). */
function validateChecks(
  checks: unknown,
  widgetIds: ReadonlyMap<string, ReadonlySet<string>>,
  errors: ViewSpecError[],
): void {
  if (checks === undefined) return
  if (!Array.isArray(checks)) {
    errors.push({ path: '$.checks', message: 'checks must be an array of cross-field constraints' })
    return
  }
  checks.forEach((c, i) => {
    const p = `$.checks[${i}]`
    if (!isObject(c)) {
      errors.push({ path: p, message: 'check must be an object' })
      return
    }
    reqString(c, 'id', errors, p)
    reqString(c, 'message', errors, p)
    // `fails_when`, NOT `when`: `WidgetBase.when` means "render when true", so the
    // inverted spelling is what keeps the reading unambiguous at the call site.
    if (typeof c.fails_when !== 'string' || c.fails_when.trim() === '') {
      errors.push({ path: `${p}.fails_when`, message: 'check requires a non-empty "fails_when" predicate' })
    }
    if (c.when !== undefined) {
      errors.push({
        path: `${p}.when`,
        message:
          'a check declares "fails_when" (TRUE ⇒ violated), never "when" — the two read the ' +
          'same and mean the opposite. Rename it.',
      })
    }
    const at = c.at
    if (!isObject(at) || typeof at.widget !== 'string' || at.widget === '') {
      errors.push({
        path: `${p}.at`,
        message: 'check requires "at: { widget: <declared widget id> }" — a message with no field is not a message',
      })
      return
    }
    if (!widgetIds.has(at.widget)) {
      errors.push({
        path: `${p}.at.widget`,
        message: `check "at.widget" names no declared widget id "${at.widget}"`,
      })
      return
    }
    // `at.part` addresses ONE REPEATED PART of that widget (a table column's key). It is
    // checked for the same reason `at.widget` is: a part key matching no column files the
    // verdict under an address no control reads, so the run is refused and NOTHING on screen
    // says why — the "disabled with no stated cause" defect, one level further in.
    if (at.part !== undefined) {
      if (typeof at.part !== 'string' || at.part === '') {
        errors.push({ path: `${p}.at.part`, message: 'check "at.part" must be a non-empty column key' })
        return
      }
      const parts = widgetIds.get(at.widget)!
      if (!parts.has(at.part)) {
        errors.push({
          path: `${p}.at.part`,
          message:
            `check "at.part" names no declared column key "${at.part}" on widget ` +
            `"${at.widget}"${parts.size === 0 ? ' (which declares no columns at all)' : ''}`,
        })
      }
    }
  })
}

/** Collect every string value reachable in a BINDING position (for $-ref
 *  scanning), skipping the free-text prose subtrees (`title`/`label`/`toast`/…)
 *  so prose that merely mentions `$state.foo` isn't scanned as a ref. */
function collectStrings(node: unknown, out: string[], inProse = false): void {
  if (typeof node === 'string') {
    if (!inProse) out.push(node)
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out, inProse)
  } else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      collectStrings(v, out, inProse || PROSE_KEYS.has(k))
    }
  }
}

const REF_RE = /\$(state|data|derived|const)\.([A-Za-z_][A-Za-z0-9_]*)/g

/** Reject a `$state|$data|$derived|$const.<name>` ref whose `<name>` is not a
 *  declared key of that section. */
/**
 * LOUD-validate a `run_processor.inputs_from` block (the data-driven input repeater).
 *
 * A malformed binding here is INVISIBLE at runtime in the worst possible way: the launch
 * proceeds, the slot it should have bound is simply absent, and a compute that treats that
 * input as optional (every `column:<name>` is 0..N by construction) reports success over a
 * filter that constrained nothing. So the shape is checked at PARSE — the same load-time
 * gate the whole build-time processor lint is, rather than a per-launch throw the author
 * discovers from a user.
 *
 * `slot` must be a non-empty string and `artifact` a non-empty `$`-ref; a missing `for_each`
 * is legal (a one-shot binding), and `when` is optional.
 */
function validateInputBindings(rp: unknown, errors: ViewSpecError[], path: string): void {
  if (!isObject(rp)) return
  const bindings = rp.inputs_from
  if (bindings === undefined) return
  if (!Array.isArray(bindings)) {
    errors.push({ path: `${path}.inputs_from`, message: 'inputs_from must be an array of input bindings' })
    return
  }
  bindings.forEach((b, bi) => {
    const bp = `${path}.inputs_from[${bi}]`
    if (!isObject(b)) {
      errors.push({ path: bp, message: 'input binding must be an object' })
      return
    }
    if (typeof b.slot !== 'string' || b.slot.trim().length === 0) {
      errors.push({ path: `${bp}.slot`, message: 'input binding requires a non-empty "slot"' })
    }
    if (typeof b.artifact !== 'string' || b.artifact.trim().length === 0) {
      errors.push({
        path: `${bp}.artifact`,
        message: 'input binding requires a non-empty "artifact" reference',
      })
    }
  })
}

function validateRefs(spec: Record<string, unknown>, errors: ViewSpecError[]): void {
  const declared: Record<DeclaredNamespace, Set<string>> = {
    state: new Set(Object.keys(isObject(spec.state) ? spec.state : {})),
    data: new Set(Object.keys(isObject(spec.data) ? spec.data : {})),
    derived: new Set(Object.keys(isObject(spec.derived) ? spec.derived : {})),
    const: new Set(Object.keys(isObject(spec.const) ? spec.const : {})),
  }
  const strings: string[] = []
  collectStrings(spec, strings)
  const seen = new Set<string>()
  for (const s of strings) {
    for (const m of s.matchAll(REF_RE)) {
      const ns = m[1] as DeclaredNamespace
      const name = m[2]
      const key = `${ns}.${name}`
      if (seen.has(key)) continue
      if (!declared[ns].has(name)) {
        seen.add(key)
        errors.push({
          path: '$',
          message: `dangling $-reference "$${ns}.${name}" — no such "${name}" declared in "${ns}"`,
        })
      }
    }
  }
}

/**
 * A PERMISSIVE `DatasetCatalog` for CATALOG-FREE parse-time canvas validation: every string the
 * canvas block references is treated as a valid column of every kind. This lets `parseOption`'s
 * structural + registry checks (unknown `series.type` / `coordId` / `datasetId` / duplicate id /
 * unbound region) fail LOUD at parse WITHOUT false-failing a valid encode column — column-existence
 * is deferred to the catalog-aware runtime check (which alone knows the real columns).
 */
function permissiveCanvasCatalog(canvas: Record<string, unknown>): DatasetCatalog {
  const strings: string[] = []
  collectStrings(canvas, strings)
  const ids = [...new Set(strings)]
  return {
    datasetId: '*',
    pointCount: 0,
    layouts: [],
    valueColumns: ids,
    continuousColumns: ids.map(id => ({ id, kind: 'continuous', label: id })),
    categoricalColumns: ids.map(id => ({ id, kind: 'categorical', label: id })),
    hasImage: false,
  }
}

/**
 * Parse + validate a raw (already YAML/JSON-decoded) `view_spec`. When a `canvas` block is present
 * it is LOUD-validated (ITEM-1) via `validateCanvasOption`: pass the analysis' resolved
 * `canvasCatalog` for full column validation, or omit it (the register path, no dataset selected
 * yet) to validate structure + registry against a permissive catalog.
 */
export function parseViewSpec(
  raw: unknown,
  canvasCatalog?: DatasetCatalog | Record<string, DatasetCatalog>,
): ParseResult {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      return { ok: false, errors: [{ path: '$', message: `not valid JSON: ${(e as Error).message}` }] }
    }
  }
  if (!isObject(obj)) {
    return { ok: false, errors: [{ path: '$', message: 'view_spec must be an object' }] }
  }

  const errors: ViewSpecError[] = []
  reqString(obj, 'id', errors)
  reqString(obj, 'title', errors)
  reqString(obj, 'permission', errors)

  if (!isObject(obj.state)) {
    errors.push({ path: '$.state', message: 'state must be an object of field specs' })
  }
  if (obj.data !== undefined && !isObject(obj.data)) {
    errors.push({ path: '$.data', message: 'data must be an object' })
  }
  if (obj.derived !== undefined && !isObject(obj.derived)) {
    errors.push({ path: '$.derived', message: 'derived must be an object' })
  }
  if (obj.const !== undefined && !isObject(obj.const)) {
    errors.push({ path: '$.const', message: 'const must be an object' })
  }
  // INV-3 — `layout` is REMOVED, and a spec that still carries it is REFUSED, not
  // ignored. Declaration order IS the layout now; silently dropping a `layout.regions`
  // map would re-order somebody's form (and, worse, would keep rendering the widgets it
  // OMITTED, which the region map used to filter out) with no diagnostic. Same fail-closed
  // posture this parser takes for an unknown widget kind or a permission-less action.
  if (obj.layout !== undefined) {
    errors.push({
      path: '$.layout',
      message:
        'the "layout" key is removed — one ANALYSIS renders into ONE pane and its view ' +
        'files\' "widgets" order IS the layout (INV-3). Delete the layout block; order the ' +
        'widgets array instead.',
    })
  }
  // INV-3, the same rule one level up: a view file is a FRAGMENT of its analysis' pane, and
  // the dock AREA is a property of the PANE. A file cannot carry a placement of its own —
  // two files of one analysis declaring different areas is a conflict with no answer. Refused
  // rather than accepted-and-ignored, so the key cannot creep into shipped specs and then
  // start meaning something. (No spec declares one today; that is what makes closing it free.)
  for (const key of ['area', 'region'] as const) {
    if (obj[key] !== undefined) {
      errors.push({
        path: `$.${key}`,
        message:
          `the "${key}" key is not a view_spec key — a view file is one FRAGMENT of its ` +
          'analysis\' single pane, and the pane\'s dock placement belongs to the analysis ' +
          '(INV-3). Delete it.',
      })
    }
  }
  // The last member of the may-not set, and the one that was still ACCEPTED-AND-IGNORED.
  // A view file does not name its analysis: the binding runs the other way, from the
  // analysis' `ui:` list to its files, so a back-pointer here is either redundant (it agrees)
  // or a lie (it does not) — and nothing read it either way. That is the shape DEC-3 refuses:
  // a key that parses leaves an author believing a declaration is in force.
  //
  // Found by the phase-8 sweep, which noticed that no shipped spec declares it while the
  // parser would take one. Closing it while that is still true is what makes it free.
  if (obj.analysis !== undefined) {
    errors.push({
      path: '$.analysis',
      message:
        'the "analysis" key is not a view_spec key — the analysis names its view files ' +
        'through its manifest `ui:` list, never the reverse (INV-3). Delete it.',
    })
  }

  // Collect declared action ids up front so widget dispatch refs can be checked.
  const declaredActionIds = new Set<string>()
  if (Array.isArray(obj.actions)) {
    for (const a of obj.actions) {
      if (isObject(a) && typeof a.id === 'string' && a.id.length > 0) declaredActionIds.add(a.id)
    }
  }

  // canvas (ITEM-1) — a `@ziee/viz` VizOption, LOUD-validated AT PARSE via `validateCanvasOption`
  // (reuses `@ziee/viz` parseOption). A structural gate first (object + `series` array), then the
  // per-field validation: with the analysis' resolved `canvasCatalog` → full (unknown series.type /
  // coordId / datasetId / column); catalog-free (the register path) → a permissive catalog so the
  // structural/registry errors still fail LOUD here rather than being swallowed at drive-time
  // (`VizController.setOption` → console.error). Column-existence is deferred to the catalog-aware
  // runtime call once a dataset is selected.
  if (obj.canvas !== undefined) {
    if (!isObject(obj.canvas)) {
      errors.push({ path: '$.canvas', message: 'canvas must be a VizOption object' })
    } else if (!Array.isArray((obj.canvas as Record<string, unknown>).series)) {
      errors.push({ path: '$.canvas.series', message: 'canvas.series must be an array' })
    } else {
      const catalog = canvasCatalog ?? permissiveCanvasCatalog(obj.canvas as Record<string, unknown>)
      for (const e of validateCanvasOption(obj.canvas, catalog)) errors.push(e)
    }
  }

  validateWidgets(obj.widgets, errors, '$.widgets', declaredActionIds)

  // R1 / INV-2 (ITEM-28) — `null` is the only unset, and a CLOSED-SET control's default may not
  // be the empty string.
  validateClosedSetDefaults(obj.widgets, obj.state, errors)

  // INV-5 (ITEM-63) — a control whose candidate binding depends on another choice must
  // declare what its emptiness MEANS; the view cannot observe candidate availability.
  validateDependentEmptyText(obj.widgets, obj.data, errors)

  // INV-13 (ITEM-11) — a field may join the PANE's shared state, and that set is closed.
  validatePaneScopedFields(obj.state, errors)

  // ITEM-27 / INV-19 — what a consumer does with an entry's N columns is DECLARED, and a
  // declaration that leaves it undecided is refused rather than resolved by taking the first.
  validateEntryDispositions(obj.canvas, obj.data, obj.widgets, errors)

  // checks[] — the view-level CROSS-FIELD constraints (DEC-3). `at` is checked against
  // the widget ids this spec actually declares, because a check whose message has nowhere
  // to land is a form-level complaint with no field attached — the "disabled with no
  // stated cause" defect one level up, and the exact thing this construct exists to avoid.
  validateChecks(obj.checks, collectWidgetIds(obj.widgets), errors)

  // actions[] — each MUST carry a non-empty permission (research §10); each body
  // effect MUST name a known op (`EFFECT_OPS`) — an unknown op otherwise only
  // throws at invoke, not at load.
  if (!Array.isArray(obj.actions)) {
    errors.push({ path: '$.actions', message: 'actions must be an array' })
  } else {
    obj.actions.forEach((a, i) => {
      const p = `$.actions[${i}]`
      if (!isObject(a)) {
        errors.push({ path: p, message: 'action must be an object' })
        return
      }
      reqString(a, 'id', errors, p)
      if (typeof a.permission !== 'string' || a.permission.length === 0) {
        errors.push({ path: `${p}.permission`, message: 'action requires a non-empty "permission"' })
      }
      if (!Array.isArray(a.body)) {
        errors.push({ path: `${p}.body`, message: 'action body must be an array of effects' })
      } else {
        a.body.forEach((eff, ei) => {
          if (!isObject(eff)) {
            errors.push({ path: `${p}.body[${ei}]`, message: 'effect must be an object' })
            return
          }
          // NOTE: a `call_action.id` is NOT existence-checked here — actions resolve at INVOKE time
          // against the GLOBAL action registry (built-ins + cross-spec actions the single-spec
          // validator can't see), so a parse-time check would raise false errors for a legitimate
          // global/cross-spec target. `runAction` surfaces a clear "unknown action" error at invoke.
          const ops = Object.keys(eff)
          const unknown = ops.filter(op => !EFFECT_OP_SET.has(op))
          if (unknown.length > 0) {
            errors.push({
              path: `${p}.body[${ei}]`,
              message: `unknown effect op ${JSON.stringify(unknown)} (expected one of ${EFFECT_OPS.join(', ')})`,
            })
          }
          validateInputBindings(eff.run_processor, errors, `${p}.body[${ei}].run_processor`)
        })
      }
    })
  }

  validateRefs(obj, errors)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: obj as unknown as ViewSpec }
}

/** True iff `w.kind` is a known widget kind. */
export function isKnownWidgetKind(w: WidgetSpec | { kind?: unknown }): boolean {
  return isValidKind(w.kind)
}

/**
 * LOUD validation of a `view_spec` `canvas` block (ITEM-1) — the `@ziee/viz` `VizOption` a
 * processor declares. Reuses `@ziee/viz` `parseOption`, so an unknown `series.type` (unregistered
 * chart), an unknown `coordId` (no matching `grid` entry), an unknown `datasetId` (not in
 * `datasets[]`), or an `encode` column absent from the dataset all fail LOUD — the SAME validation
 * the runtime `setOption` enforces, surfaced at parse. `catalogs` is the resolved
 * `DatasetCatalog` (single-dataset) or an id→catalog map (multi-dataset). Returns `[]` when the
 * block is absent or valid; a one-entry error list carrying the `[viz]` message otherwise.
 *
 * Called by `parseViewSpec` AT PARSE (ITEM-1): with the analysis' resolved catalog for full column
 * validation, or with a permissive catalog (built from the block's own strings) when no dataset is
 * selected yet, so structural/registry errors still fail LOUD at parse. `installBuiltinSchemas()`
 * (idempotent) guarantees the chart registry is populated so `series.type` resolves — the
 * render-free half of `installBuiltins()`, carrying the identical `bindingSchema`/`capabilities`
 * this validation reads without the deck.gl Views it does not.
 */
export function validateCanvasOption(
  canvas: unknown,
  catalogs: DatasetCatalog | Record<string, DatasetCatalog>,
): ViewSpecError[] {
  if (canvas === undefined || canvas === null) return []
  if (!isObject(canvas)) {
    return [{ path: '$.canvas', message: 'canvas must be a VizOption object' }]
  }
  installBuiltinSchemas()
  try {
    parseOption(canvas as unknown as VizOption, catalogs)
    return []
  } catch (e) {
    return [{ path: '$.canvas', message: (e as Error).message }]
  }
}
