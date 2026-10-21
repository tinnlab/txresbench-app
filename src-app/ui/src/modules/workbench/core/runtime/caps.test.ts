import { describe, expect, it } from 'vitest'
import type { DatatypeLattice, Datatype } from '@/modules/workbench/core'
import { deriveCaps } from './caps'
import { hasCapability } from './expr'

/** A tiny fake lattice: `extends` chains + per-datatype `capabilities`. */
function fakeLattice(nodes: Record<string, { extends?: string | null; capabilities?: string[] }>): DatatypeLattice {
  return {
    isA: (sub, sup) => {
      let id: string | null | undefined = sub
      const seen = new Set<string>()
      while (id && !seen.has(id)) {
        if (id === sup) return true
        seen.add(id)
        id = nodes[id]?.extends ?? null
      }
      return false
    },
    matches: () => true,
    get: id =>
      nodes[id]
        ? ({ id, extends: nodes[id].extends ?? null, capabilities: nodes[id].capabilities ?? [] } as Datatype)
        : undefined,
  }
}

const LATTICE = fakeLattice({
  data: { extends: null },
  tabular: { extends: 'data' },
  matrix: { extends: 'tabular' },
  'single-cell/expression': { extends: 'matrix', capabilities: ['sparse'] },
  embedding: { extends: 'matrix' },
  fragments: { extends: 'data', capabilities: ['fragments'] },
})

describe('deriveCaps (ITEM-10 / DEC-12)', () => {
  it('unions each produced datatype id with its extends-ancestors', () => {
    const caps = deriveCaps(['single-cell/expression'], LATTICE)
    expect(caps.has('single-cell/expression')).toBe(true)
    expect(caps.has('matrix')).toBe(true)
    expect(caps.has('tabular')).toBe(true)
    expect(caps.has('data')).toBe(true)
    // a declared capability rides along
    expect(caps.has('sparse')).toBe(true)
  })

  it('has:embedding evaluates true only when an embedding was produced', () => {
    const withEmb = deriveCaps(['embedding'], LATTICE)
    expect(hasCapability('embedding', { caps: withEmb })).toBe(true)
    const without = deriveCaps(['single-cell/expression'], LATTICE)
    expect(hasCapability('embedding', { caps: without })).toBe(false)
  })

  it('has:fragments (INV-15 ATAC gate) evaluates against real data', () => {
    // No fragments artifact ⇒ the ATAC gate is false (the affordance stays hidden).
    const rnaOnly = deriveCaps(['single-cell/expression'], LATTICE)
    expect(hasCapability('fragments', { caps: rnaOnly })).toBe(false)
    // A fragments datatype/capability present ⇒ true.
    const withFrag = deriveCaps(['single-cell/expression', 'fragments'], LATTICE)
    expect(hasCapability('fragments', { caps: withFrag })).toBe(true)
  })

  it('is cycle-guarded and tolerates an absent lattice entry', () => {
    const cyclic = fakeLattice({ a: { extends: 'b' }, b: { extends: 'a' } })
    const caps = deriveCaps(['a', 'unknown-type'], cyclic)
    expect(caps.has('a')).toBe(true)
    expect(caps.has('b')).toBe(true)
    expect(caps.has('unknown-type')).toBe(true)
  })

  it('empty input ⇒ empty set', () => {
    expect(deriveCaps([], LATTICE).size).toBe(0)
  })
})
