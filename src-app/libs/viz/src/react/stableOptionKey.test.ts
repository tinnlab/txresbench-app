// stableOptionKey.test.ts — the exported structural-key helper `<Viz>` uses to gate `setOption`
// on the option's VALUE (not identity), so it re-applies only on a genuine change, not on every
// parent render. These assert the properties the gate relies on:
//   - value-equal objects (different key order / different identity) → the SAME key,
//   - a genuine value change → a DIFFERENT key,
//   - the null↔undefined edge → DIFFERENT keys (the bug the old `?? 'null'` collapsed).

import { describe, it, expect } from 'vitest'
import { stableOptionKey } from './Viz'

describe('stableOptionKey', () => {
  it('keys value-equal objects with DIFFERENT key order + identity to the SAME string', () => {
    const a = { dataset: { id: 'demo' }, grid: [{ id: 'g', region: { col: 0 } }] }
    // Same values, keys authored in a different order, and a fresh identity (rebuilt inline).
    const b = { grid: [{ region: { col: 0 }, id: 'g' }], dataset: { id: 'demo' } }
    expect(a).not.toBe(b) // different identity
    expect(stableOptionKey(a)).toBe(stableOptionKey(b))
  })

  it('keys nested arrays by value (order-preserving) — equal contents → same key', () => {
    const a = { series: [{ id: 's1' }, { id: 's2' }] }
    const b = { series: [{ id: 's1' }, { id: 's2' }] }
    expect(stableOptionKey(a)).toBe(stableOptionKey(b))
  })

  it('yields a DIFFERENT key for a genuine value change', () => {
    const base = { dataset: { id: 'demo' }, grid: [{ id: 'g', region: { col: 0 } }] }
    const changed = { dataset: { id: 'demo' }, grid: [{ id: 'g', region: { col: 1 } }] }
    expect(stableOptionKey(base)).not.toBe(stableOptionKey(changed))
  })

  it('distinguishes array element ORDER (a real value change)', () => {
    expect(stableOptionKey([{ id: 'a' }, { id: 'b' }])).not.toBe(
      stableOptionKey([{ id: 'b' }, { id: 'a' }]),
    )
  })

  it('keys null and undefined to DIFFERENT strings (the collision the old code had)', () => {
    expect(stableOptionKey(null)).not.toBe(stableOptionKey(undefined))
  })

  it('distinguishes a field set to null from the same field set to undefined', () => {
    // Only meaningful because null↔undefined no longer collide.
    expect(stableOptionKey({ x: null })).not.toBe(stableOptionKey({ x: undefined }))
  })

  it('keys primitives (string / number / boolean) by value', () => {
    expect(stableOptionKey('demo')).toBe(stableOptionKey('demo'))
    expect(stableOptionKey(1)).not.toBe(stableOptionKey(2))
    expect(stableOptionKey(true)).not.toBe(stableOptionKey(false))
    // a number and its string form must not collide
    expect(stableOptionKey(1)).not.toBe(stableOptionKey('1'))
  })
})
