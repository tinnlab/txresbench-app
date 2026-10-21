import { describe, it, expect } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { evalExpr, expandForEach, expandForEachKeyed, type Scope } from './expr'
import { createViewStore } from './store'

// DRIFT-1.3 — map-keyed `for_each`: a `derived` with `for_each` + `key` builds a
// MAP keyed by the loop var, so `$derived.ranges[$c]` resolves the entry for the
// current criterion; the array form (no `key`) is preserved.

const scope: Scope = {
  const: { criteria: ['nCount', 'mito'] },
  data: { obs: { nCount: [1, 5, 9], mito: [2, 4, 6] } },
}

describe('expandForEachKeyed (DRIFT-1.3)', () => {
  it('keys each iteration by the evaluated key expression', () => {
    const out = expandForEachKeyed({ for_each: '$const.criteria as $c' }, scope, '$c')
    expect(out.map(e => e.key)).toEqual(['nCount', 'mito'])
    expect(out[0].entry.scope.c).toBe('nCount')
  })

  it('leaves the array form (expandForEach) untouched', () => {
    const out = expandForEach({ for_each: '$const.criteria as $c' }, scope)
    expect(out.map(e => e.item)).toEqual(['nCount', 'mito'])
  })
})

function keyedSpec(): ViewSpec {
  return {
    id: 'test/keyed',
    title: 'Keyed derived',
    permission: 'jobs::use',
    state: {},
    const: { criteria: ['nCount', 'mito'] },
    derived: {
      // MAP form (key present): ranges[$c] → per-criterion extent.
      ranges: { for_each: '$const.criteria as $c', key: '$c', value: { extent: '$data.obs[$c]' } },
      // ARRAY form (no key): per-criterion unique list, positional.
      uniques: { for_each: '$const.criteria as $c', value: { unique: '$data.obs[$c]' } },
    },
    widgets: [],
    actions: [],
  }
}

describe('createViewStore — keyed vs array derived (DRIFT-1.3)', () => {
  it('builds a map keyed by the loop var; `$derived.ranges[$c]` resolves', () => {
    const store = createViewStore(keyedSpec(), 'keyed-1', {
      obs: { nCount: [1, 5, 9], mito: [2, 4, 6] },
    })
    const ranges = store.derived.ranges as Record<string, unknown>
    expect(ranges.nCount).toEqual([1, 9])
    expect(ranges.mito).toEqual([2, 6])

    // The whole point: a widget binding `$derived.ranges[$c]` (inside a
    // `for_each ... as $c`) resolves the entry for the current criterion.
    const bindScope: Scope = { derived: store.derived, c: 'mito' }
    expect(evalExpr('$derived.ranges[$c]', bindScope)).toEqual([2, 6])
    store.dispose()
  })

  it('preserves the array form for a keyless for_each derived', () => {
    const store = createViewStore(keyedSpec(), 'keyed-2', {
      obs: { nCount: [1, 5, 9], mito: [2, 4, 6] },
    })
    expect(store.derived.uniques).toEqual([
      [1, 5, 9],
      [2, 4, 6],
    ])
    store.dispose()
  })
})
