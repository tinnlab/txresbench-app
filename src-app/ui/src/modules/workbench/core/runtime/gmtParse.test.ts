// TEST-10 (ITEM-6) — GMT + flexible paste parse into the record shape; malformed lines handled.
import { describe, it, expect } from 'vitest'
import { parseGmt, parseFlexible } from './gmtParse'

describe('parseGmt (ITEM-6)', () => {
  it('parses tab-delimited name <tab> description <tab> values…', () => {
    const gmt = 'T cells\tCD4 subset\tCD3D\tCD3E\tIL7R\nB cells\t\tMS4A1\tCD79A'
    expect(parseGmt(gmt)).toEqual([
      { name: 'T cells', description: 'CD4 subset', values: ['CD3D', 'CD3E', 'IL7R'] },
      { name: 'B cells', description: '', values: ['MS4A1', 'CD79A'] },
    ])
  })

  it('de-duplicates values, first-seen order preserved', () => {
    expect(parseGmt('S\t\tA\tB\tA\tC')[0].values).toEqual(['A', 'B', 'C'])
  })

  it('skips blank and nameless lines (malformed handled)', () => {
    const gmt = '\n\t\tA\tB\nGood\t\tX'
    expect(parseGmt(gmt)).toEqual([{ name: 'Good', description: '', values: ['X'] }])
  })

  it('falls back to flexible parse for a line with no tabs', () => {
    expect(parseGmt('T cells CD3D, CD3E IL7R')).toEqual([
      { name: 'T', description: '', values: ['cells', 'CD3D', 'CD3E', 'IL7R'] },
    ])
  })
})

describe('parseFlexible (ITEM-6)', () => {
  it('first token is the name, the rest are comma/space/semicolon values', () => {
    expect(parseFlexible('T_cells CD3D, CD3E; IL7R\nB_cells MS4A1,CD79A')).toEqual([
      { name: 'T_cells', description: '', values: ['CD3D', 'CD3E', 'IL7R'] },
      { name: 'B_cells', description: '', values: ['MS4A1', 'CD79A'] },
    ])
  })

  it('skips blank lines and never yields a nameless record', () => {
    expect(parseFlexible('\n   \nName A B')).toEqual([{ name: 'Name', description: '', values: ['A', 'B'] }])
  })

  it('handles an empty input', () => {
    expect(parseFlexible('')).toEqual([])
    expect(parseGmt('')).toEqual([])
  })
})
