// colorOverride.store.test.ts — the runtime per-group DISPLAY-OVERRIDE store
// (COLOR_PALETTE_PLAN interactive editing). Proves: set/clear/reset for BOTH color + label; the
// by-NAME keying (stable identity — an edit targets a named group, not an index); per-COLUMN
// isolation (an edit under `cell_type` never leaks into `cluster`); and that an emptied/cleared
// column collapses back to `undefined` (the byte-identical no-override path) via
// `overridesForColumn`.

import { describe, it, expect, beforeEach } from 'vitest'
import { useColorOverrideStore, overridesForColumn } from './colorOverride.store'

const store = useColorOverrideStore

function overrides() {
  return store.getState().overrides
}

describe('colorOverride.store — set / clear / reset (color + label)', () => {
  beforeEach(() => {
    store.setState({ overrides: {} })
  })

  it('setCategoryColor writes a by-NAME color under the column', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    expect(overrides()['cell_type'].categoryColors).toEqual({ 'T cells': '#ff0000' })
    // no label side-effect
    expect(overrides()['cell_type'].categoryLabels).toBeUndefined()
  })

  it('setColumnPalette applies an ordered palette + resolves through overridesForColumn', () => {
    store.getState().setColumnPalette('cell_type', ['#111111', '#222222', '#333333'])
    expect(overrides()['cell_type'].palette).toEqual(['#111111', '#222222', '#333333'])
    expect(overridesForColumn(overrides(), 'cell_type')?.palette).toEqual(['#111111', '#222222', '#333333'])
  })

  it('setColumnPalette CLEARS per-group colors (a fresh auto-populate)', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    store.getState().setColumnPalette('cell_type', ['#111111', '#222222'])
    expect(overrides()['cell_type'].categoryColors).toBeUndefined()
    expect(overrides()['cell_type'].palette).toEqual(['#111111', '#222222'])
  })

  it('setColumnPalette(undefined) clears the palette + prunes an otherwise-empty column', () => {
    store.getState().setColumnPalette('cell_type', ['#111111'])
    store.getState().setColumnPalette('cell_type', undefined)
    expect(overrides()['cell_type']).toBeUndefined()
    expect(overridesForColumn(overrides(), 'cell_type')).toBeUndefined()
  })

  it('setCategoryLabel writes a by-NAME display label under the column', () => {
    store.getState().setCategoryLabel('cell_type', '3', 'T cells')
    expect(overrides()['cell_type'].categoryLabels).toEqual({ '3': 'T cells' })
    expect(overrides()['cell_type'].categoryColors).toBeUndefined()
  })

  it('color + label for the same group co-exist and update independently', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    store.getState().setCategoryLabel('cell_type', 'T cells', 'Lymphocyte')
    store.getState().setCategoryColor('cell_type', 'T cells', '#00ff00') // recolor same group
    expect(overrides()['cell_type']).toEqual({
      categoryColors: { 'T cells': '#00ff00' },
      categoryLabels: { 'T cells': 'Lymphocyte' },
    })
  })

  it('clearColorOverride removes BOTH the color and label for one group', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    store.getState().setCategoryLabel('cell_type', 'T cells', 'Lymphocyte')
    store.getState().setCategoryColor('cell_type', 'B cells', '#0000ff')
    store.getState().clearColorOverride('cell_type', 'T cells')
    // T cells gone from both maps; B cells untouched
    expect(overrides()['cell_type'].categoryColors).toEqual({ 'B cells': '#0000ff' })
    expect(overrides()['cell_type'].categoryLabels).toBeUndefined() // emptied map pruned
  })

  it('clearing the LAST group prunes the whole column entry (collapses to no-override)', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    store.getState().clearColorOverride('cell_type', 'T cells')
    expect(overrides()['cell_type']).toBeUndefined()
    expect(overridesForColumn(overrides(), 'cell_type')).toBeUndefined()
  })

  it('resetColumn drops all overrides for that column only', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    store.getState().setCategoryLabel('cluster', '1', 'Alpha')
    store.getState().resetColumn('cell_type')
    expect(overrides()['cell_type']).toBeUndefined()
    // the other column survives
    expect(overrides()['cluster'].categoryLabels).toEqual({ '1': 'Alpha' })
  })
})

describe('colorOverride.store — per-COLUMN isolation + stable by-name identity', () => {
  beforeEach(() => {
    store.setState({ overrides: {} })
  })

  it('the SAME group name under two columns is stored independently', () => {
    store.getState().setCategoryColor('cell_type', '3', '#ff0000')
    store.getState().setCategoryColor('cluster', '3', '#0000ff')
    expect(overrides()['cell_type'].categoryColors).toEqual({ '3': '#ff0000' })
    expect(overrides()['cluster'].categoryColors).toEqual({ '3': '#0000ff' })
  })

  it('a clear on one column does not touch the other', () => {
    store.getState().setCategoryColor('cell_type', '3', '#ff0000')
    store.getState().setCategoryColor('cluster', '3', '#0000ff')
    store.getState().clearColorOverride('cell_type', '3')
    expect(overrides()['cell_type']).toBeUndefined()
    expect(overrides()['cluster'].categoryColors).toEqual({ '3': '#0000ff' })
  })
})

describe('overridesForColumn — CategoricalOverrides projection for the render path', () => {
  beforeEach(() => {
    store.setState({ overrides: {} })
  })

  it('returns undefined for an unknown / empty column (byte-identical no-override path)', () => {
    expect(overridesForColumn(overrides(), 'nope')).toBeUndefined()
  })

  it('projects color + label maps into a CategoricalOverrides bundle', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    store.getState().setCategoryLabel('cell_type', '3', 'B cells')
    const ov = overridesForColumn(overrides(), 'cell_type')
    expect(ov).toEqual({
      categoryColors: { 'T cells': '#ff0000' },
      categoryLabels: { '3': 'B cells' },
    })
  })

  it('omits an absent map (color-only override has no categoryLabels key)', () => {
    store.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    const ov = overridesForColumn(overrides(), 'cell_type')
    expect(ov).toEqual({ categoryColors: { 'T cells': '#ff0000' } })
    expect('categoryLabels' in (ov as object)).toBe(false)
  })
})
