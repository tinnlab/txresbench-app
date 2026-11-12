// columnDeclarations — the producer's own declaration, carried beside a columnar frame
// (ITEM-32/33/34).
//
// ── WHY A SIDECAR ON THE FRAME ────────────────────────────────────────────────────────────
//
// Three kernels currently answer questions about a column by INSPECTING ITS VALUES:
// `categories_by_column` derives the option set with `unique(v.map(pyStr))`, `controlOfColumn`
// decides range-vs-multiselect from `typeof values[0]`, and `isIdentifierColumn` scans for a
// duplicate. All three have an authoritative answer available upstream — the producer DECLARED the
// column's kind and, for a categorical, its exact level set — and reading the values to
// re-derive it is both wasteful (it is why 65 column bodies are fetched to populate a picker) and
// WRONG at the edges: a leading `null` makes a numeric column read as a multiselect, and a
// subset that happens to contain one value makes a category look like an identifier.
//
// The declaration therefore travels WITH the frame, under a reserved key. That shape is chosen
// deliberately over a second kernel argument: every `derived` kernel takes exactly ONE columnar
// operand (`frameOperand`), so a second argument would mean changing the derived-spec vocabulary
// and every call site in the shipped views. A reserved key needs neither, and it is invisible to
// existing consumers by construction — every one of them guards with `Array.isArray`/`isColumn`
// and skips a non-array value, which is exactly what this is.
//
// ── WHAT IT IS NOT ────────────────────────────────────────────────────────────────────────
//
// It is NOT a place to put anything a consumer might like to know. It carries only what the
// PRODUCER declared, so that a kernel can stop guessing; a value derived from the data does not
// belong here, because the whole point is that the declaration outranks the data.

import { spellDeclaredLevel } from '@/modules/workbench/core/criteria/criteria'

/** The reserved frame key. Double-underscored + namespaced so a real column cannot collide. */
export const DECLARED_KEY = '__txr_declared__'

/** What the producer declared about ONE column. */
export interface ColumnDeclaration {
  /** the producer's own kind, verbatim (`categorical` / `continuous` / …). */
  readonly kind?: string
  /**
   * The declared level set, ALREADY spelled in the comparator's dialect (ITEM-36).
   *
   * Spelled at construction rather than at use, so there is exactly one place a raw declared
   * level can leak from. A bool's declared levels are lowercase (`"false"`/`"true"`) while the
   * comparator spells a JS boolean `"False"`/`"True"`, and offering the raw form matches nothing
   * — every row of that criterion disappears with no error. See `spellDeclaredLevel`.
   */
  readonly levels?: readonly string[]
  /**
   * The producer's declared ROW COUNT for this column (ITEM-34).
   *
   * Carried because lazy bodies make the frame's own arrays an unreliable source for it. Every
   * length question in the kernels used to be answerable from the values — `columnLength` takes
   * the max over the frame's arrays — and with bodies fetched only for criterion-named columns
   * that max is 0 whenever no criterion names one. A `keep_mask` over a 0-length frame returns
   * an EMPTY mask, so the before/after streams would silently render nothing on a surface the
   * user has not yet filtered: a blank result that no error accompanies.
   *
   * The declaration is the right source anyway — the row count is a producer fact, not an
   * observation — and it costs no read: it is already in the `structure` the catalog row carries.
   */
  readonly n?: number
}

/** `{ columnKey → declaration }`, as carried on a frame. */
export type ColumnDeclarations = Record<string, ColumnDeclaration>

/**
 * A columnar frame that MAY carry a declaration sidecar under {@link DECLARED_KEY}.
 *
 * The union is the honest type: the sidecar is a real member of the object every kernel
 * receives, and typing the operand as columns-only would have meant a cast at each call site —
 * which is how a sidecar becomes invisible to the type system and then to the reader. Every
 * consumer already narrows with `Array.isArray`/`isColumn` before touching a value, so the
 * union costs them nothing.
 */
export type DeclaredFrame = Record<string, readonly unknown[] | ColumnDeclarations>

/** Is this a declared CATEGORICAL column? */
export function isDeclaredCategorical(d: ColumnDeclaration | undefined): boolean {
  return d?.kind === 'categorical'
}

/** Is this a declared BOOLEAN column? Its levels need the spelling bridge. */
export function isDeclaredBool(structureKind: string | undefined, storedDtype?: string): boolean {
  return storedDtype === 'bool' || structureKind === 'bool'
}

/**
 * Build a declaration, spelling its levels into the comparator dialect exactly once.
 *
 * `bool` is passed explicitly rather than sniffed, because a bool column is declared
 * `kind: categorical` with `stored_dtype: bool` — the kind alone cannot tell you the levels need
 * bridging.
 */
export function declaration(
  kind: string | undefined,
  levels: readonly string[] | undefined,
  bool: boolean,
  n?: number,
): ColumnDeclaration {
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(levels
      ? { levels: levels.map(l => spellDeclaredLevel(l, bool ? 'bool' : 'other')) }
      : {}),
    // Only a real, non-negative count. A producer that declared none leaves the kernels on
    // their observed-length path, which is byte-identical to before ITEM-34.
    ...(typeof n === 'number' && Number.isFinite(n) && n >= 0 ? { n } : {}),
  }
}

// ── THE SEAM: a WeakMap keyed by the FRAME OBJECT, not a key inside it ────────────────────
//
// The first attempt put the declarations in the frame under a reserved key. It failed, and the
// failure is instructive rather than incidental: `Object.keys(frame)` is a COLUMN-SET question,
// asked all over the tree, so a reserved key becomes a phantom column to every reader that
// enumerates. Four assertions in `axisSource.test.ts` caught it immediately ("returns EVERY
// metadata column on the axis"), and those assertions are correct — the seam had to move, not
// them (DRIFT-1.12).
//
// A WeakMap keyed by the frame object satisfies every constraint at once: the frame's own key
// space is untouched, so `Object.keys` is exactly the column set; nothing has to parse a slice
// id to find its declarations (this repo has been bitten by parsed composed ids before); and the
// entry dies with the frame, so a slice replaced on the next landing leaks nothing.
const REGISTRY = new WeakMap<object, ColumnDeclarations>()

/** Register `declarations` for `frame`. Returns the frame UNCHANGED — no key is added. */
export function attachDeclarations<T extends object>(frame: T, declarations: ColumnDeclarations): T {
  if (Object.keys(declarations).length > 0) REGISTRY.set(frame, declarations)
  return frame
}

/**
 * Read the declarations for a frame, or `{}` when it has none (every pre-existing frame).
 *
 * Checks the registry FIRST, then the in-frame reserved key. The latter is the FIXTURE form: a
 * unit test constructing a frame literally cannot register it, and requiring one would make every
 * such test route through production plumbing to say "this column is categorical". Production
 * writes only through {@link attachDeclarations}, so no real frame carries the key.
 */
export function declarationsOf(frame: unknown): ColumnDeclarations {
  if (frame == null || typeof frame !== 'object') return {}
  const registered = REGISTRY.get(frame as object)
  if (registered) return registered
  const d = (frame as Record<string, unknown>)[DECLARED_KEY]
  return d != null && typeof d === 'object' && !Array.isArray(d) ? (d as ColumnDeclarations) : {}
}


