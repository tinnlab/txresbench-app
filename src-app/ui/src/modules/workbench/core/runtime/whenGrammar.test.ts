import { describe, it, expect } from 'vitest'
import { evalWhen, type Scope } from './expr'

// `when` / `disabledWhen` decide whether a control is shown and whether a run can be launched, so
// a predicate that cannot be EXPRESSED is not a gap in the vocabulary — it is a gate that reads
// correctly and never fires. Three shipped views had written `&&`, because it looks like it
// should work, and the `==` branch silently swallowed everything after the first comparison as a
// bare-word right-hand side.

const scope = (state: Record<string, unknown>): Scope =>
  ({ params: {}, state, derived: {}, const: {}, data: {} }) as Scope

describe('compound predicates', () => {
  const s = scope({ a: 1, b: 2, empty: '', list: [1, 2] })

  it('AND requires every clause', () => {
    expect(evalWhen('$state.a == 1 && $state.b == 2', s)).toBe(true)
    expect(evalWhen('$state.a == 1 && $state.b == 99', s)).toBe(false)
  })

  it('OR requires any clause', () => {
    expect(evalWhen('$state.a == 99 || $state.b == 2', s)).toBe(true)
    expect(evalWhen('$state.a == 99 || $state.b == 99', s)).toBe(false)
  })

  it('OR binds LOOSER than AND', () => {
    // `false && false || true` is `(false && false) || true` — the conventional precedence. Read
    // the other way it is `false && (false || true)` = false, so this distinguishes them.
    expect(evalWhen('$state.a == 9 && $state.b == 9 || $state.b == 2', s)).toBe(true)
  })

  it('chains more than two clauses', () => {
    // The real gate that motivated this has three.
    expect(evalWhen('$state.a == 1 && $state.b == 2 && $state.list.length == 2', s)).toBe(true)
    expect(evalWhen('$state.a == 1 && $state.b == 2 && $state.list.length == 9', s)).toBe(false)
  })

  it('does not split an operator inside a QUOTED literal', () => {
    // A predicate legitimately compares against text; a naive split would tear it in half.
    expect(evalWhen("$state.text == 'a && b'", scope({ text: 'a && b' }))).toBe(true)
    expect(evalWhen("$state.text == 'a || b'", scope({ text: 'a || b' }))).toBe(true)
  })
})

describe('relational comparison', () => {
  const s = scope({ few: [1], many: [1, 2, 3] })

  it('compares lengths — the shape a list-alignment gate needs', () => {
    expect(evalWhen('$state.few.length < $state.many.length', s)).toBe(true)
    expect(evalWhen('$state.many.length < $state.few.length', s)).toBe(false)
  })

  it('reads <= and >= as themselves, not as < and >', () => {
    expect(evalWhen('$state.many.length >= 3', s)).toBe(true)
    expect(evalWhen('$state.many.length <= 3', s)).toBe(true)
    expect(evalWhen('$state.many.length > 3', s)).toBe(false)
  })

  it('is FALSE when either side is not a number', () => {
    // A gate must not engage on a predicate it cannot read: `false` leaves the control usable
    // and visible, where `true` would silently disable it with no stated cause.
    expect(evalWhen("$state.missing.length < 'abc'", s)).toBe(false)
  })
})

describe('the existing grammar is unchanged', () => {
  const s = scope({ a: 1, name: 'x', list: [] })

  it('still handles equality, inequality, membership and bare truthiness', () => {
    expect(evalWhen('$state.a == 1', s)).toBe(true)
    expect(evalWhen('$state.a != 2', s)).toBe(true)
    expect(evalWhen("$state.name in ['x','y']", s)).toBe(true)
    expect(evalWhen('$state.a', s)).toBe(true)
    expect(evalWhen('$state.list.length', s)).toBe(false)
  })

  it('an absent predicate still means MET', () => {
    expect(evalWhen(undefined, s)).toBe(true)
    expect(evalWhen('', s)).toBe(true)
  })
})

// Parentheses. Not an enhancement — a silent-wrong-answer hole of exactly the shape this
// grammar was extended to close. `splitTopLevel` is depth-aware, so an operator inside an
// enclosing pair sits at depth 1 and matches nothing; the string then fell through every branch
// to the bare-word arm and came back TRUTHY. An author who writes `(a || b)` — which reads as
// ordinary — got `true` regardless of a and b, and a gate written that way never fires.
describe('parentheses', () => {
  const s = {
    params: {},
    state: { a: false, b: false, t: true, n: 3, m: 5 },
    derived: {},
    const: {},
    data: {},
  } as unknown as Scope

  it('an ENCLOSING pair does not change the answer', () => {
    // The regression itself: both operands false, so both forms must be false.
    expect(evalWhen('$state.a || $state.b', s)).toBe(false)
    expect(evalWhen('($state.a || $state.b)', s)).toBe(false)
    expect(evalWhen('(($state.a || $state.b))', s)).toBe(false)
    expect(evalWhen('( $state.a && $state.t )', s)).toBe(false)
    expect(evalWhen('($state.t)', s)).toBe(true)
    expect(evalWhen('($state.n < $state.m)', s)).toBe(true)
  })

  it('a pair that does NOT enclose the whole expression is left intact', () => {
    // The over-strip guard. `($a) || ($t)` starts with `(` and ends with `)` while being two
    // operands, not one — stripping the outer characters would produce `$a) || ($t`, which parses
    // as garbage. It must still split on the top-level `||`.
    expect(evalWhen('($state.a) || ($state.t)', s)).toBe(true)
    expect(evalWhen('($state.a) || ($state.b)', s)).toBe(false)
    expect(evalWhen('($state.t) && ($state.a)', s)).toBe(false)
  })

  it('an UNBALANCED string is REFUSED, not silently repaired', () => {
    // The stripper leaves unbalanced input alone rather than mangling it, and what happens next
    // is the behaviour worth pinning: a stray `)` rides along into the $-reference and the
    // reference validator REFUSES it. Loud is the right answer here and is the opposite of the
    // bug above — a malformed predicate that evaluates to something is how a gate comes to mean
    // what nobody wrote. Asserted so a future "be lenient about parens" change has to argue with
    // this test rather than quietly restore the silent arm.
    expect(() => evalWhen('$state.t)', s)).toThrow(/invalid \$-reference/)
  })
})
