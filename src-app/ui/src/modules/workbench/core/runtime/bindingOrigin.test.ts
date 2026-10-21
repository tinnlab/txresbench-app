// TEST-1 — the origin FOLD. `strongerOrigin` is the one place the "a slot fed by several
// references is unreviewed if ANY of them is" rule lives, so it is tested as a rule rather
// than through whichever caller happens to exercise it today.

import { describe, expect, it } from 'vitest'

import { ORIGIN_AUTO, ORIGIN_USER, strongerOrigin, type BindingOrigin } from './bindingOrigin.ts'

describe('TEST-1 — strongerOrigin folds auto over user', () => {
  it('auto wins over user in BOTH argument orders', () => {
    // Order-independence is the property that matters: the caller folds across an
    // expression's references in whatever order the tokenizer produced them, and a fold that
    // depended on that order would make a slot's reported origin depend on how its author
    // happened to spell the expression.
    expect(strongerOrigin(ORIGIN_USER, ORIGIN_AUTO)).toBe(ORIGIN_AUTO)
    expect(strongerOrigin(ORIGIN_AUTO, ORIGIN_USER)).toBe(ORIGIN_AUTO)
  })

  it('a lone defined side wins over an undefined one, either way round', () => {
    expect(strongerOrigin(ORIGIN_USER, undefined)).toBe(ORIGIN_USER)
    expect(strongerOrigin(undefined, ORIGIN_USER)).toBe(ORIGIN_USER)
    expect(strongerOrigin(ORIGIN_AUTO, undefined)).toBe(ORIGIN_AUTO)
    expect(strongerOrigin(undefined, ORIGIN_AUTO)).toBe(ORIGIN_AUTO)
  })

  it('two undefineds stay undefined — absence is an answer, not a value to default (INV-4)', () => {
    // The single most important case in this file. If this ever returned `'user'`, every
    // input nobody described would be recorded as reviewed, which fabricates exactly the
    // claim the whole change exists to stop fabricating.
    expect(strongerOrigin(undefined, undefined)).toBeUndefined()
  })

  it('same-value folds are idempotent', () => {
    expect(strongerOrigin(ORIGIN_USER, ORIGIN_USER)).toBe(ORIGIN_USER)
    expect(strongerOrigin(ORIGIN_AUTO, ORIGIN_AUTO)).toBe(ORIGIN_AUTO)
  })

  it('folding a whole reference list left-to-right reports auto if ANY member is auto', () => {
    const fold = (xs: (BindingOrigin | undefined)[]): BindingOrigin | undefined =>
      xs.reduce<BindingOrigin | undefined>((acc, x) => strongerOrigin(acc, x), undefined)
    expect(fold([ORIGIN_USER, ORIGIN_USER, ORIGIN_AUTO])).toBe(ORIGIN_AUTO)
    expect(fold([ORIGIN_AUTO, ORIGIN_USER, ORIGIN_USER])).toBe(ORIGIN_AUTO)
    expect(fold([ORIGIN_USER, undefined])).toBe(ORIGIN_USER)
    expect(fold([undefined, undefined])).toBeUndefined()
    expect(fold([])).toBeUndefined()
  })
})

