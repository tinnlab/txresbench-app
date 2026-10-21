import { describe, it, expect } from 'vitest'
import {
  formatGeneCasing, geneFontStyle, isLikelyGeneSymbol,
  categoryShape, categoryDash, MARKER_SHAPES,
} from './labels'

describe('gene labels (ITEM-16)', () => {
  it('human = ALL-CAPS, mouse = Title-case', () => {
    expect(formatGeneCasing('cd3e', 'human')).toBe('CD3E')
    expect(formatGeneCasing('CD3E', 'mouse')).toBe('Cd3e')
  })
  it('font style follows the gene-labels flag', () => {
    expect(geneFontStyle(true)).toBe('italic')
    expect(geneFontStyle(false)).toBe('normal')
  })
  it('recognizes plausible gene symbols and rejects prose', () => {
    expect(isLikelyGeneSymbol('CD3E')).toBe(true)
    expect(isLikelyGeneSymbol('HLA-DRB1')).toBe(true)
    expect(isLikelyGeneSymbol('some long label')).toBe(false)
  })
})

describe('redundant encoding (ITEM-21)', () => {
  it('assigns a deterministic shape per category, cycling', () => {
    expect(categoryShape(0)).toBe('circle')
    expect(categoryShape(1)).toBe('triangle-up')
    expect(categoryShape(MARKER_SHAPES.length)).toBe('circle') // cycles
    expect(categoryShape(-1)).toBe(MARKER_SHAPES[MARKER_SHAPES.length - 1]) // negative safe
  })
  it('assigns dash patterns (first is solid)', () => {
    expect(categoryDash(0)).toEqual([])
    expect(categoryDash(1).length).toBeGreaterThan(0)
  })
})
