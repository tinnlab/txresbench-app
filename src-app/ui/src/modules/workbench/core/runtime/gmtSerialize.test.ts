import { describe, expect, it } from 'vitest'
import { serializeGmt } from './gmtSerialize'
import { parseGmt } from './gmtParse'

// ITEM-10 (covers TEST-18 substance): the GMT serializer is the inverse of `gmtParse` — a frozen
// collection's per-set records round-trip through GMT text. Domain-free (records, not gene sets).
describe('serializeGmt', () => {
  it('emits one tab-delimited line per record (name, description, values)', () => {
    const gmt = serializeGmt([
      { name: 'T cells', description: 'CD4+ T', values: ['CD3D', 'CD3E', 'IL7R'] },
      { name: 'B cells', description: '', values: ['MS4A1', 'CD79A'] },
    ])
    expect(gmt).toBe('T cells\tCD4+ T\tCD3D\tCD3E\tIL7R\nB cells\t\tMS4A1\tCD79A\n')
  })

  it('round-trips through parseGmt (the frozen-collection export contract)', () => {
    const records = [
      { name: 'NK cells', description: 'natural killer', values: ['NKG7', 'GNLY', 'KLRD1'] },
      { name: 'Monocytes', description: '', values: ['LYZ', 'CD14'] },
    ]
    const parsed = parseGmt(serializeGmt(records))
    expect(parsed).toEqual(records)
  })

  it('skips a nameless record and trims/drops empty values', () => {
    const gmt = serializeGmt([
      { name: '', values: ['X'] },
      { name: 'S', description: undefined, values: ['A', ' ', 'B'] },
    ])
    expect(gmt).toBe('S\t\tA\tB\n')
  })

  it('returns the empty string for no records', () => {
    expect(serializeGmt([])).toBe('')
  })
})
