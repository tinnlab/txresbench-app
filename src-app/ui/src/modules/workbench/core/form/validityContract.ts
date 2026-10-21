// The FORM-VALIDITY CONTRACT — the verdict shapes, the address vocabulary, the display
// rule and the channel they travel on. Everything a CONSUMER of the pre-pass needs, and
// nothing the pre-pass itself needs to compute one.
//
// ## Why this is a separate module from `./validity.ts`
//
// Two reasons, and the second is the layering one:
//
//   · `evaluateForm` resolves an `artifact_ref`'s candidate set in order to answer DEC-6
//     ("is this requirement satisfiable at all"), which reaches the catalog resolver and,
//     through it, the workstore. That subtree cannot be loaded by the `node --test`
//     strip-types runner that pins the public barrel, so the WALKER is structurally
//     un-barrel-able — exactly as the `artifact_ref` renderer is.
//   · a widget RENDERER is in the extensions layer and may only reach core through the
//     public barrel (INV-3/INV-8). It needs the address vocabulary — a per-row control has
//     to look its verdict up under the SAME key the engine filed it under, and a second
//     spelling of that key is a message that silently lands nowhere.
//
// So the light half is here, exported through the barrel; the walker stays behind it.

import type { Scope } from '@/modules/workbench/core/runtime/expr'
import type { SubmitGate } from './gate.ts'

/** The INTERNAL scope channel a verdict travels on — like `CATALOG_SCOPE_KEY`, and
 *  deliberately NOT a `$`-ref namespace. A view DECLARES a constraint and the engine
 *  answers it; a view may not read the answer any more than it may query the catalog. */
export const FORM_VALIDITY_SCOPE_KEY = 'formValidity'

/** Which constraint a verdict came from. The discriminator exists so a consumer can tell
 *  "you have not answered" from "two entries collide" — two different remedies that a
 *  single authored sentence cannot both describe. */
export type ViolationKind =
  | 'required'
  | 'min_items'
  | 'max_items'
  | 'number'
  | 'unique_by'
  | 'not_in'
  | 'check'

/** One violated requirement, addressed to ONE rendered control instance. */
export interface FieldVerdict {
  /** `widgetId#i.j…`, or `widgetId#i.j…#part` for a repeated part of one widget. */
  key: string
  widgetId: string
  kind: ViolationKind
  /** the sentence to show. */
  message: string
  /** the control's own declared label — the only noun a default message names. */
  label?: string
  /**
   * The control holds NO value (as opposed to a value that is wrong). DEC-4 turns on
   * exactly this distinction: an empty untouched control is *not yet answered*, not
   * wrong, and reddening it the instant a pane opens is the hostile case.
   */
  empty: boolean
  /**
   * DEC-6 — the requirement CANNOT be satisfied from this form: the control's resolved
   * candidate set is empty, so this is a fact about the project rather than an unanswered
   * question. It still closes the gate; it contributes no field error and no summary line,
   * because a red "required" on a control that offers nothing is an instruction the user
   * cannot follow.
   */
  unsatisfiable: boolean
}

/** One line of the summary beside the primary action. */
export interface RequirementLine {
  key: string
  /** the control's own label, or its id when it declares none. */
  label: string
  message: string
}

export interface FormValidity {
  /** every violation, keyed by rendered-instance key. */
  verdicts: ReadonlyMap<string, FieldVerdict>
  /** the derived gate — never a parallel predicate (non-negotiable 2). */
  gate: SubmitGate
  /** the unmet requirements a user can act on, in declaration order, bounded. */
  summary: readonly RequirementLine[]
  /** how many actionable requirements were elided by the bound. */
  elided: number
  /** the LOCAL action ids that SUBMIT this form (a declared body that dispatches a run).
   *  A control bound to one of them is gated on validity; every other control is not. */
  submitActions: ReadonlySet<string>
}

/** How many summary lines are shown before the rest are counted rather than listed. A
 *  form can repeat a control per list entry, so "every unmet requirement, listed" is
 *  unbounded; a wall of identical lines is not more informative than five plus a count. */
export const SUMMARY_LIMIT = 5

/** What the summary says above its lines. Names nothing but the form. */
export const SUMMARY_LEAD = 'Not ready yet:'

/**
 * The address of ONE rendered control instance: its widget id plus the repeat indices
 * along the path that produced it, outermost first.
 *
 * The path — not just the widget's own index — is what makes a control inside a repeated
 * `group` addressable at all: every instance of such a child carries the SAME widget id
 * and the SAME (zero) own-index, so a key built from the id alone collides across every
 * row and one row's message lands on all of them.
 */
export function instanceKey(widgetId: string, path: readonly number[], part?: string): string {
  const base = `${widgetId}#${path.join('.')}`
  return part === undefined ? base : `${base}#${part}`
}

/** The address of ONE repeated part of a widget (a per-row field of a table): its column
 *  key and the row's position. */
export function partKey(columnKey: string, rowIndex: number): string {
  return `${columnKey}:${rowIndex}`
}

/** Read the channel off a render scope; `undefined` when the host published none (a bare
 *  mount), which every consumer must treat as "no constraints known" rather than as
 *  "everything is valid" — the two differ only in what they let a caller assert. */
export function readFormValidity(scope: Scope): FormValidity | undefined {
  const v = scope[FORM_VALIDITY_SCOPE_KEY]
  if (v && typeof v === 'object' && (v as FormValidity).verdicts instanceof Map) {
    return v as FormValidity
  }
  return undefined
}

/**
 * Should this verdict be SHOWN on the field right now? (DEC-4/DEC-5.)
 *
 * The rule is absent-vs-present, not touched-vs-pristine:
 *   · a control holding a value that violates its constraint is wrong RIGHT NOW —
 *     a stale bound value, a restored pane, a pasted typo — and shows immediately;
 *   · a control that is EMPTY and never changed is not wrong, it is not yet answered,
 *     and its requirement is surfaced by the summary and the disabled action instead.
 * An unsatisfiable requirement is never the user's fault and is never shown (DEC-6).
 */
export function shouldShow(verdict: FieldVerdict | undefined, touched: boolean): boolean {
  if (!verdict || verdict.unsatisfiable) return false
  return !verdict.empty || touched
}
