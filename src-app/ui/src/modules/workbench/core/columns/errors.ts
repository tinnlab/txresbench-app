// The typed errors the column resolver raises. A ref that names an entry/column the
// context cannot address is a DISTINGUISHABLE failure (not a generic throw), so a
// caller can tell "you asked for an entry that doesn't exist" from "you asked for a
// column that doesn't exist".
//
// PROVENANCE: the surviving two constructors of `core/dsl/errors.ts`. The other five
// (`BadPolygon`, `TooManyNodes`, `TooDeep`, `TooManyReductions`, `ResultTooLarge`) were
// raised only by the deleted predicate validator/evaluator and went with them.

/** A resolver failure kind. */
export type ColumnErrorKind = 'UnknownEntry' | 'UnknownColumn'

/** A typed column-resolution error carrying a stable discriminant `kind`. */
export class ColumnError extends Error {
  readonly kind: ColumnErrorKind
  readonly detail?: string

  constructor(kind: ColumnErrorKind, message: string, detail?: string) {
    super(message)
    this.name = 'ColumnError'
    this.kind = kind
    this.detail = detail
    Object.setPrototypeOf(this, ColumnError.prototype)
  }
}

/** Type guard — narrows a caught value to a `ColumnError`. */
export function isColumnError(e: unknown): e is ColumnError {
  return e instanceof ColumnError
}

/** The constructors, so a raise site never spells the kind string by hand. */
export const ColumnErrors = {
  unknownEntry: (entry: string) => new ColumnError('UnknownEntry', `unknown entry: ${entry}`, entry),
  unknownColumn: (col: string) => new ColumnError('UnknownColumn', `unknown column: ${col}`, col),
}
