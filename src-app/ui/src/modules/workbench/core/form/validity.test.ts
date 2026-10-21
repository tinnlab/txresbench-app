// The FORM-VALIDITY pre-pass, over hand-written specs — the engine tier.
//
// Its shipped-data counterparts are the two per-package surface suites under
// `core/runtime/` (the real views, driven through this same engine) and
// `render/shippedFormConformance.test.tsx` (the real views, MOUNTED). This file is where
// the vocabulary's own rules are pinned — the ones a shipped view happens to exercise
// only partly.
//
// Two properties are asserted throughout rather than in one place, because both have
// failed before in this repo:
//
//   · every negative case has a POSITIVE CONTROL. A gate that is always closed satisfies
//     every "must refuse" assertion ever written.
//   · a verdict's ADDRESS is asserted, not just its existence. "Some field is invalid" and
//     "THIS field is invalid" look identical from a count.

import { describe, it, expect } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { CATALOG_SCOPE_KEY } from '@/modules/workbench/core/artifacts/catalog'
import { ROW_PART_KEY } from '@/modules/workbench/core/spec/schema'
import {
  evaluateForm,
  instanceKey,
  readFormValidity,
  shouldShow,
  FORM_VALIDITY_SCOPE_KEY,
  SUMMARY_LIMIT,
} from './validity.ts'

/** A minimal spec carrying `widgets` (+ optional `checks`), with the required top-level
 *  keys filled in so it is shaped like the real thing. */
function view(over: Partial<ViewSpec>): ViewSpec {
  return {
    id: 'v',
    title: 'V',
    permission: 'p',
    state: {},
    widgets: [],
    actions: [
      { id: 'go', title: 'Go', permission: 'p', params: {}, body: [{ run_processor: { id: 'x' } }] },
      { id: 'add', title: 'Add', permission: 'p', params: {}, body: [{ set: { a: 1 } }] },
    ],
    ...over,
  } as ViewSpec
}

const scopeOf = (state: Record<string, unknown>, extra: Record<string, unknown> = {}): Scope => ({
  params: {},
  state,
  derived: {},
  const: {},
  data: {},
  ...extra,
})

describe('require.required', () => {
  const spec = view({
    widgets: [
      { id: 'one', kind: 'text', label: 'One', value: '$state.one', require: { required: true } },
    ],
  })

  it('an absent value violates, and the verdict is addressed to THAT control instance', () => {
    const v = evaluateForm(spec, scopeOf({ one: '' }))
    expect(v.gate.canSubmit).toBe(false)
    expect([...v.verdicts.keys()]).toEqual([instanceKey('one', [0])])
    expect(v.verdicts.get(instanceKey('one', [0]))?.kind).toBe('required')
    expect(v.verdicts.get(instanceKey('one', [0]))?.empty).toBe(true)
  })

  it('a present value does NOT violate — the positive control', () => {
    const v = evaluateForm(spec, scopeOf({ one: 'x' }))
    expect(v.gate.canSubmit).toBe(true)
    expect(v.verdicts.size).toBe(0)
  })

  it('whitespace is not an answer, but 0 and false are', () => {
    expect(evaluateForm(spec, scopeOf({ one: '   ' })).gate.canSubmit).toBe(false)
    expect(evaluateForm(spec, scopeOf({ one: 0 })).gate.canSubmit).toBe(true)
    expect(evaluateForm(spec, scopeOf({ one: false })).gate.canSubmit).toBe(true)
  })

  it('a WHEN-GATED control contributes no requirement — an invisible one is unmeetable', () => {
    const gated = view({
      widgets: [
        {
          id: 'one',
          kind: 'text',
          label: 'One',
          when: '$state.show',
          value: '$state.one',
          require: { required: true },
        },
      ],
    })
    expect(evaluateForm(gated, scopeOf({ show: false, one: '' })).gate.canSubmit).toBe(true)
    expect(evaluateForm(gated, scopeOf({ show: true, one: '' })).gate.canSubmit).toBe(false)
  })
})

describe('require.required over a for_each — the case a length comparison cannot see', () => {
  // The shape of the defect this whole construct replaces: a list written BY INDEX can be
  // `length` N with holes in it, so `answers.length < anchors.length` is FALSE while
  // answers are missing. A requirement asked once per rendered control sees each hole.
  const spec = view({
    widgets: [
      {
        id: 'answer',
        kind: 'text',
        for_each: '$state.anchors as $a, $i',
        label: 'Answer',
        value: '$state.answers[$i]',
        require: { required: true },
      },
    ],
  })

  it('a SPARSE list with only the last position answered leaves the earlier ones violating', () => {
    const answers: unknown[] = []
    answers[2] = 'c'
    expect(answers.length, 'the case must actually be sparse').toBe(3)
    expect(answers.length < 3, 'the deleted length comparison is FALSE here').toBe(false)

    const v = evaluateForm(spec, scopeOf({ anchors: ['x', 'y', 'z'], answers }))
    expect(v.gate.canSubmit).toBe(false)
    expect([...v.verdicts.keys()].sort()).toEqual([
      instanceKey('answer', [0]),
      instanceKey('answer', [1]),
    ])
  })

  it('every position answered is launchable — the positive control', () => {
    const v = evaluateForm(spec, scopeOf({ anchors: ['x', 'y', 'z'], answers: ['a', 'b', 'c'] }))
    expect(v.gate.canSubmit).toBe(true)
  })

  it('a shorter list violates on the unanswered tail, not on the answered head', () => {
    const v = evaluateForm(spec, scopeOf({ anchors: ['x', 'y'], answers: ['a'] }))
    expect([...v.verdicts.keys()]).toEqual([instanceKey('answer', [1])])
  })
})

describe('require.min_items / max_items', () => {
  const spec = view({
    widgets: [
      { id: 'list', kind: 'multiselect', label: 'List', value: '$state.list', require: { min_items: 2, max_items: 3 } },
    ],
  })

  it('counts PRESENT entries, so holes and blanks do not pad the count', () => {
    const sparse: unknown[] = []
    sparse[3] = 'a'
    expect(sparse.length).toBe(4)
    expect(evaluateForm(spec, scopeOf({ list: sparse })).gate.canSubmit).toBe(false)
    expect(evaluateForm(spec, scopeOf({ list: ['a', '', ''] })).gate.canSubmit).toBe(false)
    expect(evaluateForm(spec, scopeOf({ list: ['a', 'b'] })).gate.canSubmit).toBe(true)
  })

  it('refuses too many as well as too few', () => {
    expect(evaluateForm(spec, scopeOf({ list: ['a', 'b', 'c', 'd'] })).gate.canSubmit).toBe(false)
    expect(evaluateForm(spec, scopeOf({ list: ['a', 'b', 'c'] })).gate.canSubmit).toBe(true)
  })
})

describe('require.number — the SHARED decimal grammar, not Number()', () => {
  const spec = view({
    widgets: [{ id: 'bound', kind: 'text', label: 'Bound', value: '$state.bound', require: { number: {} } }],
  })
  const ok = (v: unknown): boolean => evaluateForm(spec, scopeOf({ bound: v })).gate.canSubmit

  it('accepts plain decimal notation', () => {
    for (const good of ['0', '10', '-3', '+2', '1.5', '.5', '2e3', 42, ' 7 ']) {
      expect(ok(good), `${JSON.stringify(good)} is plain decimal notation`).toBe(true)
    }
  })

  it('refuses exactly what the shared coercion treats as UNBOUNDED', () => {
    // Each of these is silently "no constraint" to every reader of a bound, which is why
    // the form is the only layer that can catch them. `Number()` would accept the first
    // three of them, which is the whole reason this calls the shared parser instead.
    for (const bad of ['0x10', 'Infinity', 'inf', '1_000', '1O', '10 ', 'abc', true, ['1']]) {
      expect(ok(bad), `${JSON.stringify(bad)} is not plain decimal notation`).toBe(false)
    }
  })

  it('an EMPTY value is not a number violation — an omitted bound is a real answer', () => {
    expect(ok('')).toBe(true)
    expect(ok(null)).toBe(true)
    expect(ok(undefined)).toBe(true)
  })

  it('min / max / integer are applied on top of the grammar', () => {
    const bounded = view({
      widgets: [
        {
          id: 'count',
          kind: 'text',
          label: 'Count',
          value: '$state.count',
          require: { number: { min: 1, integer: true } },
        },
      ],
    })
    const at = (v: unknown): boolean => evaluateForm(bounded, scopeOf({ count: v })).gate.canSubmit
    expect(at('3000')).toBe(true)
    expect(at('0')).toBe(false)
    expect(at('-1')).toBe(false)
    expect(at('2.5')).toBe(false)
  })
})

describe('require.unique_by', () => {
  const spec = view({
    widgets: [
      { id: 'rows', kind: 'table', rows: '$state.rows', require: { unique_by: 'name', message: 'authored' } },
    ],
  })
  const at = (rows: unknown[]): ReturnType<typeof evaluateForm> => evaluateForm(spec, scopeOf({ rows }))

  it('two entries sharing the field violate; distinct ones do not', () => {
    expect(at([{ name: 'a' }, { name: 'b' }]).gate.canSubmit).toBe(true)
    expect(at([{ name: 'a' }, { name: 'a' }]).gate.canSubmit).toBe(false)
  })

  it('two BLANKS are a duplicate — the run that refuses duplicates does not exempt them', () => {
    expect(at([{ name: '' }, { name: '' }]).gate.canSubmit).toBe(false)
  })

  it('keeps its OWN sentence rather than the block message', () => {
    // A block message is written about an absent or malformed value ("Add at least one…"),
    // which is actively wrong as the explanation of a collision. The two remedies differ,
    // so the sentences do.
    const v = at([{ name: 'a' }, { name: 'a' }])
    const verdict = [...v.verdicts.values()][0]
    expect(verdict.kind).toBe('unique_by')
    expect(verdict.message).not.toBe('authored')
  })

  it('the block message DOES replace the default for a presence constraint', () => {
    const withMin = view({
      widgets: [{ id: 'rows', kind: 'table', rows: '$state.rows', require: { min_items: 1, message: 'authored' } }],
    })
    const v = evaluateForm(withMin, scopeOf({ rows: [] }))
    expect([...v.verdicts.values()][0].message).toBe('authored')
  })
})

describe('require.not_in — uniqueness against the ENVIRONMENT', () => {
  const spec = view({
    widgets: [
      {
        id: 'name',
        kind: 'text',
        label: 'Name',
        value: '$state.name',
        require: { not_in: '$data.taken', message: { not_in: '"{value}" is spoken for.' } },
      },
    ],
  })
  const at = (name: unknown, taken: unknown): ReturnType<typeof evaluateForm> =>
    evaluateForm(spec, { params: {}, state: { name }, derived: {}, const: {}, data: { taken } })

  it('reads a LIST, an OPTION list, or the KEYS of a map — the shapes the vocabulary produces', () => {
    for (const taken of [['a', 'b'], [{ value: 'a' }, { value: 'b' }], { a: 'id-1', b: 'id-2' }]) {
      expect(at('a', taken).gate.canSubmit, JSON.stringify(taken)).toBe(false)
      expect(at('c', taken).gate.canSubmit, JSON.stringify(taken)).toBe(true)
    }
  })

  it('names the offending value, so the summary says WHICH one collided', () => {
    const v = at('a', ['a'])
    expect([...v.verdicts.values()][0].message).toBe('"a" is spoken for.')
  })

  it('an EMPTY value is never "already taken" — that is the unanswered question', () => {
    // Even when the empty string is itself in the set. Reporting a blank field as taken is
    // a second, wrong sentence about the same blank; `required` is what asks about it.
    expect(at('', ['', 'a']).gate.canSubmit).toBe(true)
    expect(at(undefined, ['a']).gate.canSubmit).toBe(true)
  })

  it('an UNRESOLVED set constrains nothing — not-yet-known must not read as free-for-all', () => {
    // It reads as "no constraint applied", which is the only honest answer while the set is
    // unknown; the gate is held by whatever else the form still requires.
    expect(at('a', undefined).gate.canSubmit).toBe(true)
  })

  it('is INDEPENDENT of unique_by — a form can satisfy one and violate the other', () => {
    const both = view({
      widgets: [
        { id: 'rows', kind: 'table', rows: '$state.rows', require: { unique_by: 'name' } },
        {
          id: 'name',
          kind: 'text',
          label: 'Name',
          value: '$state.name',
          require: { not_in: '$data.taken' },
        },
      ],
    })
    const run = (name: string, rows: unknown[], taken: unknown[]) =>
      evaluateForm(both, { params: {}, state: { name, rows }, derived: {}, const: {}, data: { taken } })
    // distinct rows, colliding name -> only the environment relation fires
    expect([...run('a', [{ name: 'x' }, { name: 'y' }], ['a']).verdicts.values()].map(v => v.kind)).toEqual([
      'not_in',
    ])
    // duplicate rows, free name -> only the within-form relation fires
    expect([...run('z', [{ name: 'x' }, { name: 'x' }], ['a']).verdicts.values()].map(v => v.kind)).toEqual([
      'unique_by',
    ])
  })
})

describe('a check may land on ONE ROW of a table (`at.part`)', () => {
  // A table renders its rows as PARTS of one widget, so a relation between two of a row's
  // fields has no per-row widget id to name. Without an address for the part, the only place
  // left is the whole table — which reports "some row is inverted" over an unbounded list.
  const spec = view({
    widgets: [
      {
        id: 'rows',
        kind: 'table',
        rows: '$state.rows',
        columns: [
          { key: 'lo', title: 'Lo', value: '$row.lo' },
          { key: 'hi', title: 'Hi', value: '$row.hi' },
        ],
      },
    ],
    checks: [
      {
        id: 'loAboveHi',
        for_each: '$state.rows as $r, $i',
        fails_when: "$r.lo != '' && $r.hi != '' && $r.lo > $r.hi",
        at: { widget: 'rows', part: 'hi', index: '$i' },
        message: 'Lo is above Hi.',
      },
    ],
  })

  it('lands on the OFFENDING row’s named column, under the address that column reads', () => {
    const v = evaluateForm(spec, scopeOf({ rows: [{ lo: '1', hi: '9' }, { lo: '5', hi: '1' }] }))
    expect([...v.verdicts.keys()]).toEqual([instanceKey('rows', [0], 'hi:1')])
    expect([...v.verdicts.values()][0].message).toBe('Lo is above Hi.')
    // Named for the COLUMN, which is the heading the user reads above the offending field —
    // the widget's own label names the whole table.
    expect([...v.verdicts.values()][0].label).toBe('hi')
  })

  it('two inverted rows are two messages, one per row', () => {
    const v = evaluateForm(spec, scopeOf({ rows: [{ lo: '5', hi: '1' }, { lo: '9', hi: '2' }] }))
    expect([...v.verdicts.keys()].sort()).toEqual(
      [instanceKey('rows', [0], 'hi:0'), instanceKey('rows', [0], 'hi:1')].sort(),
    )
  })

  it('does not fire when the relation holds — the positive control', () => {
    expect(evaluateForm(spec, scopeOf({ rows: [{ lo: '1', hi: '5' }] })).gate.canSubmit).toBe(true)
  })
})

describe('a control inside a REPEATED group is addressed per row', () => {
  const spec = view({
    widgets: [
      {
        id: 'row',
        kind: 'group',
        for_each: '$state.rows as $r, $i',
        children: [
          { id: 'inner', kind: 'text', label: 'Inner', value: '$r.v', require: { required: true } },
        ],
      },
    ],
  })

  it('every instance carries the ENCLOSING index, so one row’s message cannot land on all', () => {
    const v = evaluateForm(spec, scopeOf({ rows: [{ v: 'a' }, { v: '' }, { v: '' }] }))
    expect([...v.verdicts.keys()].sort()).toEqual(
      [instanceKey('inner', [1, 0]), instanceKey('inner', [2, 0])].sort(),
    )
  })
})

describe('checks — the cross-field relation (DEC-3)', () => {
  const spec = view({
    widgets: [
      {
        id: 'row',
        kind: 'group',
        for_each: '$state.rows as $r, $i',
        children: [
          { id: 'lo', kind: 'text', label: 'Lo', value: '$r.lo' },
          { id: 'hi', kind: 'text', label: 'Hi', value: '$r.hi' },
        ],
      },
    ],
    checks: [
      {
        id: 'loAboveHi',
        for_each: '$state.rows as $r, $i',
        fails_when: "$r.lo != '' && $r.hi != '' && $r.lo > $r.hi",
        at: { widget: 'hi', index: '$i' },
        message: 'Lo is above Hi.',
      },
    ],
  })

  it('lands on the OFFENDING row’s target control, and on no other row', () => {
    const v = evaluateForm(spec, scopeOf({ rows: [{ lo: '1', hi: '9' }, { lo: '5', hi: '1' }] }))
    expect([...v.verdicts.keys()]).toEqual([instanceKey('hi', [1, 0])])
    expect([...v.verdicts.values()][0].message).toBe('Lo is above Hi.')
  })

  it('does not fire when either side is unbounded — the positive control', () => {
    expect(evaluateForm(spec, scopeOf({ rows: [{ lo: '5', hi: '' }] })).gate.canSubmit).toBe(true)
    expect(evaluateForm(spec, scopeOf({ rows: [{ lo: '', hi: '1' }] })).gate.canSubmit).toBe(true)
    expect(evaluateForm(spec, scopeOf({ rows: [{ lo: '1', hi: '5' }] })).gate.canSubmit).toBe(true)
  })

  it('a check whose target is not RENDERED is dropped rather than floated', () => {
    const hidden = view({
      widgets: [{ id: 'hi', kind: 'text', label: 'Hi', when: '$state.show', value: '$state.hi' }],
      checks: [{ id: 'c', fails_when: 'true', at: { widget: 'hi' }, message: 'nope' }],
    })
    expect(evaluateForm(hidden, scopeOf({ show: false })).gate.canSubmit).toBe(true)
    expect(evaluateForm(hidden, scopeOf({ show: true })).gate.canSubmit).toBe(false)
  })
})

describe('DEC-6 — an UNSATISFIABLE requirement is not reported as unmet', () => {
  const spec = view({
    widgets: [
      {
        id: 'pick',
        kind: 'artifact_ref',
        label: 'Pick',
        source: { datatype: 'x' },
        value: '$state.pick',
        require: { required: true },
      },
    ],
  })

  it('with an EMPTY candidate set: the gate still closes, but nothing is said to the user', () => {
    const v = evaluateForm(spec, scopeOf({ pick: '' }, { [CATALOG_SCOPE_KEY]: { artifacts: [] } }))
    expect(v.gate.canSubmit, 'the run is still not launchable').toBe(false)
    expect(v.summary, 'no summary line — the view’s own alert speaks').toEqual([])
    expect(shouldShow([...v.verdicts.values()][0], true), 'no field error, even once touched').toBe(false)
  })

  it('with candidates present: the SAME state IS reported — the positive control', () => {
    const rows = [{ id: 'a', project_id: 'p', datatype: 'x', structure: {}, created_at: '' }]
    const v = evaluateForm(
      spec,
      scopeOf({ pick: '' }, { [CATALOG_SCOPE_KEY]: { artifacts: rows } }),
    )
    expect(v.gate.canSubmit).toBe(false)
    expect(v.summary.map(s => s.label)).toEqual(['Pick'])
    expect(shouldShow([...v.verdicts.values()][0], true)).toBe(true)
  })

  it('with NO catalog channel at all the engine does not GUESS unsatisfiable', () => {
    // "the engine cannot tell" must not read as "there is nothing to choose" — the latter
    // silences a real requirement.
    const v = evaluateForm(spec, scopeOf({ pick: '' }))
    expect(v.summary.map(s => s.label)).toEqual(['Pick'])
  })
})

describe('DEC-4 — absent-vs-present decides whether a message SHOWS', () => {
  const spec = view({
    widgets: [{ id: 'b', kind: 'text', label: 'B', value: '$state.b', require: { number: {} } }],
  })

  it('an EMPTY untouched control says nothing; touched, it does', () => {
    const empty = view({
      widgets: [{ id: 'b', kind: 'text', label: 'B', value: '$state.b', require: { required: true } }],
    })
    const verdict = [...evaluateForm(empty, scopeOf({ b: '' })).verdicts.values()][0]
    expect(shouldShow(verdict, false)).toBe(false)
    expect(shouldShow(verdict, true)).toBe(true)
  })

  it('a PRESENT wrong value says so immediately, touched or not', () => {
    const verdict = [...evaluateForm(spec, scopeOf({ b: '1O' })).verdicts.values()][0]
    expect(verdict.empty).toBe(false)
    expect(shouldShow(verdict, false)).toBe(true)
  })
})

describe('the summary and the gate', () => {
  it('lists unmet requirements in declaration order, by the control’s own label', () => {
    const spec = view({
      widgets: [
        { id: 'a', kind: 'text', label: 'Alpha', value: '$state.a', require: { required: true } },
        { id: 'b', kind: 'text', label: 'Beta', value: '$state.b', require: { required: true } },
      ],
    })
    const v = evaluateForm(spec, scopeOf({ a: '', b: '' }))
    expect(v.summary.map(s => s.label)).toEqual(['Alpha', 'Beta'])
    expect(v.gate.reason).toContain('Alpha')
  })

  it('is BOUNDED, and counts what it elided', () => {
    const spec = view({
      widgets: [
        {
          id: 'r',
          kind: 'text',
          for_each: '$state.rows as $x, $i',
          label: 'Row',
          value: '$x.v',
          require: { required: true },
        },
      ],
    })
    const rows = Array.from({ length: SUMMARY_LIMIT + 4 }, () => ({ v: '' }))
    const v = evaluateForm(spec, scopeOf({ rows }))
    expect(v.summary.length).toBe(SUMMARY_LIMIT)
    expect(v.elided).toBe(4)
  })

  it('names the actions that SUBMIT, so no other affordance is gated', () => {
    const v = evaluateForm(view({}), scopeOf({}))
    expect([...v.submitActions]).toEqual(['go'])
  })
})

describe('totality', () => {
  it('a throwing binding costs that widget’s verdict, never the pass', () => {
    const spec = view({
      widgets: [
        // `$` inside a non-ref string is refused by `evalExpr` as arbitrary code.
        { id: 'bad', kind: 'text', label: 'Bad', value: 'a $ b', require: { required: true } },
        { id: 'good', kind: 'text', label: 'Good', value: '$state.good', require: { required: true } },
      ],
    })
    const v = evaluateForm(spec, scopeOf({ good: '' }))
    expect([...v.verdicts.keys()]).toEqual([instanceKey('good', [0])])
  })

  it('a widget with no `require` contributes nothing', () => {
    const spec = view({ widgets: [{ id: 'x', kind: 'text', label: 'X', value: '$state.x' }] })
    expect(evaluateForm(spec, scopeOf({ x: '' })).gate.canSubmit).toBe(true)
  })
})

describe('the scope channel', () => {
  it('round-trips through the internal key, and a bare scope reads as UNKNOWN not VALID', () => {
    const spec = view({
      widgets: [{ id: 'a', kind: 'text', label: 'A', value: '$state.a', require: { required: true } }],
    })
    const v = evaluateForm(spec, scopeOf({ a: '' }))
    expect(readFormValidity(scopeOf({}))).toBeUndefined()
    expect(readFormValidity({ ...scopeOf({}), [FORM_VALIDITY_SCOPE_KEY]: v })).toBe(v)
  })
})
