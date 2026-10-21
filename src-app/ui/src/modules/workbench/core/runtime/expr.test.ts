import { describe, it, expect } from 'vitest'
import {
  evalExpr,
  evalWhen,
  expandForEach,
  hasCapability,
  isRef,
  stateRefPaths,
  type Scope,
} from './expr'

// TEST-2 (PLAN.md ITEM-2) — the safe `$`-binding evaluator: refs resolve;
// `for_each` expands over a list; `when` gates; a non-ref expression (arbitrary
// code) is rejected.

const scope: Scope = {
  state: { sel: 'umap', filters: { A: { nCount: [1, 5] } } },
  data: { obs: { ident: ['A', 'B'], nCount: [3, 9] } },
  derived: { hidden: [false, true] },
  job: { status: 'completed' },
  params: { value: 42 },
  const: { criteria: ['nCount', 'mito'] },
}

describe('evalExpr — reference resolution (ITEM-2)', () => {
  it('resolves $state / $data / $derived / $job refs', () => {
    expect(evalExpr('$state.sel', scope)).toBe('umap')
    expect(evalExpr('$data.obs.nCount', scope)).toEqual([3, 9])
    expect(evalExpr('$derived.hidden', scope)).toEqual([false, true])
    expect(evalExpr('$job.status', scope)).toBe('completed')
    expect(evalExpr('$params.value', scope)).toBe(42)
  })

  it('resolves numeric + nested-ref indexing', () => {
    expect(evalExpr('$data.obs.nCount[1]', scope)).toBe(9)
    expect(evalExpr('$state.filters.A.nCount', scope)).toEqual([1, 5])
    // index by a nested ref: filters[$data.obs.ident[0]] === filters.A
    expect(evalExpr('$state.filters[$data.obs.ident[0]].nCount', scope)).toEqual([1, 5])
  })

  it('returns literals unchanged and tolerates a missing path', () => {
    expect(evalExpr(5, scope)).toBe(5)
    expect(evalExpr('plain label', scope)).toBe('plain label')
    expect(evalExpr('$data.obs.absentColumn', scope)).toBeUndefined()
  })

  it('rejects a non-ref expression (no arbitrary code)', () => {
    expect(() => evalExpr('$state.sel + 1', scope)).toThrow()
    expect(() => evalExpr('doStuff($state.sel)', scope)).toThrow()
    expect(() => evalExpr('$state.a == $state.b', scope)).toThrow()
    expect(isRef('$state.sel')).toBe(true)
    expect(isRef('$state.sel + 1')).toBe(false)
  })
})

describe('expandForEach (ITEM-2)', () => {
  it('expands a `$list as $item` clause, binding the item per iteration', () => {
    const widget = { for_each: '$const.criteria as $c', kind: 'violin' }
    const out = expandForEach(widget, scope)
    expect(out.length).toBe(2)
    expect(out[0].item).toBe('nCount')
    expect(out[1].item).toBe('mito')
    expect(out[0].scope.c).toBe('nCount')
    expect(evalExpr('$c', out[1].scope)).toBe('mito')
    // the `for_each` key is stripped from the per-iteration spec
    expect((out[0].spec as { for_each?: string }).for_each).toBeUndefined()
    expect((out[0].spec as { kind: string }).kind).toBe('violin')
  })

  it('yields a single identity entry when there is no for_each', () => {
    const widget: { for_each?: string; kind: string } = { kind: 'button' }
    const out = expandForEach(widget, scope)
    expect(out.length).toBe(1)
    expect(out[0].spec).toEqual({ kind: 'button' })
  })

  it('throws on a malformed for_each clause', () => {
    expect(() => expandForEach({ for_each: 'not a clause' }, scope)).toThrow()
  })
})

describe('evalWhen (ITEM-2)', () => {
  it('gates on equality / inequality / membership / truthiness', () => {
    expect(evalWhen('$job.status == completed', scope)).toBe(true)
    expect(evalWhen('$job.status == failed', scope)).toBe(false)
    expect(evalWhen('$job.status != failed', scope)).toBe(true)
    expect(evalWhen('$job.status in [pending, running]', scope)).toBe(false)
    expect(evalWhen('$job.status in [completed, running]', scope)).toBe(true)
    expect(evalWhen('$derived.hidden', scope)).toBe(true) // non-empty array is truthy
    expect(evalWhen(undefined, scope)).toBe(true) // no gate → always render
    expect(evalWhen('', scope)).toBe(true)
  })
})

describe('evalWhen — has:<capability> predicate (DEC-12)', () => {
  it('tests capability membership against scope.caps (array / Set / record)', () => {
    expect(evalWhen('has:embedding', { caps: ['embedding', 'spatial'] })).toBe(true)
    expect(evalWhen('has:spatial', { caps: ['embedding', 'spatial'] })).toBe(true)
    expect(evalWhen('has:atac', { caps: ['embedding', 'spatial'] })).toBe(false)
    expect(evalWhen('has:embedding', { caps: new Set(['embedding']) })).toBe(true)
    expect(evalWhen('has:embedding', { caps: { embedding: true, spatial: false } })).toBe(true)
    expect(evalWhen('has:spatial', { caps: { embedding: true, spatial: false } })).toBe(false)
  })

  it('supports a namespaced capability name (slash / dot / dash)', () => {
    expect(evalWhen('has:single-cell/expression', { caps: ['single-cell/expression'] })).toBe(true)
    expect(evalWhen('has:single-cell/expression', { caps: [] })).toBe(false)
  })

  it('is FALSE (not a truthy literal) when caps is absent — the reason to intercept before the bare-word fallback', () => {
    expect(evalWhen('has:embedding', {})).toBe(false)
    expect(evalWhen('has:embedding', { caps: undefined })).toBe(false)
  })

  it('hasCapability is exported + directly testable', () => {
    expect(hasCapability('x', { caps: ['x'] })).toBe(true)
    expect(hasCapability('x', {})).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// TEST-2 (binding-origin / ITEM-2) — `stateRefPaths`: which AUTHORED state a declared
// expression reads. It is the input to per-slot binding origin, and it is deliberately built
// on this file's own `REF_TOKEN_RE` + `parseRefPath` rather than a second regex.
//
// (The `TEST-2` above belongs to the visualize-pane namespace; test IDs restart per lifecycle.)
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('stateRefPaths — the authored state a binding reads (TEST-2)', () => {
  it('returns the dotted path of a bare $state ref — the shape every shipped inputs: block uses', () => {
    expect(stateRefPaths('$state.matrices')).toEqual(['matrices'])
    expect(stateRefPaths('$state.pickedNames')).toEqual(['pickedNames'])
  })

  it('returns a $scope ref too — the pane-shared half of what a control can write', () => {
    expect(stateRefPaths('$scope.axis')).toEqual(['axis'])
  })

  it('finds refs embedded in a template, not only a bare expression', () => {
    // A declaration is not always a lone ref; `{…}` segments and prose interpolation are both
    // shipped forms, and a reader that only understood the bare case would silently report no
    // origin for the other two.
    expect(stateRefPaths('column:{$state.column}')).toEqual(['column'])
    expect(stateRefPaths('$state.a and $state.b')).toEqual(['a', 'b'])
  })

  it('de-duplicates a path named twice', () => {
    expect(stateRefPaths('$state.a $state.a')).toEqual(['a'])
  })

  it('stops at the first non-property accessor, reporting the field whose origin was recorded', () => {
    // `ViewStore.set` records the origin at the path it WROTE. `criteria.0.column` is written
    // as `criteria.0.column`, but an index may itself hold a reference whose value is not
    // known here — so half a path is reported rather than a wrong whole one.
    expect(stateRefPaths('$state.criteria[0].column')).toEqual(['criteria'])
    // A NUMERIC segment is not a property in this grammar (`PROP_RE` requires a letter or
    // `_`), so the ref token itself ends at `criteria` — the same answer, reached one step
    // earlier. Asserted so a later grammar change that started accepting `.0` is caught here
    // rather than silently widening what a slot's origin is attributed to.
    expect(stateRefPaths('$state.criteria.0.column')).toEqual(['criteria'])
  })

  it('returns NOTHING for roots no control can write', () => {
    // `$data` is a catalog fact, `$derived` is computed, `$params` is an argument bag. A path
    // under any of them can carry no user-vs-system distinction, and returning one would
    // invite a caller to look it up and get a confident `undefined`.
    expect(stateRefPaths('$data.sources[$c.column]')).toEqual([])
    expect(stateRefPaths('$derived.hidden')).toEqual([])
    expect(stateRefPaths('$params.value')).toEqual([])
  })

  it('returns [] for a non-string and for a $-free literal, rather than throwing', () => {
    // It is called on whatever an author declared, including a literal artifact id or a
    // number. A reader of declarations must never be the thing that makes a launch throw.
    expect(stateRefPaths(undefined)).toEqual([])
    expect(stateRefPaths(42)).toEqual([])
    expect(stateRefPaths(['$state.a'])).toEqual([])
    expect(stateRefPaths('a-literal-artifact-id')).toEqual([])
    expect(stateRefPaths('')).toEqual([])
  })

  it('ignores a bare root with no property — there is no field to ask about', () => {
    expect(stateRefPaths('$state')).toEqual([])
    expect(stateRefPaths('$scope')).toEqual([])
  })
})
