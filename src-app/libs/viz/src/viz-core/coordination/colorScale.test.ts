// colorScale.test.ts — L0 unit tests for shared color-domain coordination
// (DEC-25 / ITEM-64): the pure merge helpers + the Coordination store slice.
// Runs in the node vitest pass (the React hook needs a DOM env and is exercised
// by the browser/e2e tiers).

import { beforeEach, describe, expect, it } from 'vitest'

import {
  type CategoryColorScope,
  type ColorScaleScope,
  EMPTY_DOMAIN,
  isValidDomain,
  mergeDomain,
  resolveSharedCategoryColors,
  resolveSharedDomain,
} from './colorScale'
import {
  sharedColorDomain,
  useCoordinationStore,
} from '../../adapter/Coordination.store'
import {
  sharedCategoryColors,
  useColorOverrideStore,
} from '../../adapter/colorOverride.store'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('mergeDomain — union of two numeric domains', () => {
  it('returns [min, max] across both bounds', () => {
    expect(mergeDomain([0, 5], [2, 9])).toEqual([0, 9])
  })

  it('is order-independent', () => {
    expect(mergeDomain([2, 9], [0, 5])).toEqual(mergeDomain([0, 5], [2, 9]))
  })

  it('handles disjoint and nested domains', () => {
    expect(mergeDomain([0, 1], [10, 20])).toEqual([0, 20])
    expect(mergeDomain([0, 100], [40, 60])).toEqual([0, 100])
  })

  it('tolerates inverted inputs (min/max across all bounds)', () => {
    expect(mergeDomain([5, 0], [9, 2])).toEqual([0, 9])
  })

  it('treats a non-finite / empty-sentinel domain as absent (no poison)', () => {
    // An empty or all-NaN column registers the [Infinity, -Infinity] sentinel
    // (or [NaN, NaN]); it must NOT widen the union — the valid side wins.
    expect(mergeDomain([Infinity, -Infinity], [0, 5])).toEqual([0, 5])
    expect(mergeDomain([0, 5], [Infinity, -Infinity])).toEqual([0, 5])
    expect(mergeDomain([NaN, NaN], [0, 5])).toEqual([0, 5])
    expect(mergeDomain([0, 5], [NaN, NaN])).toEqual([0, 5])
  })

  it('two invalid domains merge to the empty sentinel', () => {
    expect(mergeDomain([Infinity, -Infinity], [NaN, NaN])).toEqual(EMPTY_DOMAIN)
    expect(mergeDomain([NaN, NaN], [Infinity, -Infinity])).toEqual(EMPTY_DOMAIN)
  })
})

describe('isValidDomain — both bounds finite', () => {
  it('accepts finite domains (incl. degenerate point and inverted-finite)', () => {
    expect(isValidDomain([0, 5])).toBe(true)
    expect(isValidDomain([3, 3])).toBe(true)
    expect(isValidDomain([-3, 3])).toBe(true)
    // Finite-but-inverted is a real domain mergeDomain normalizes, not absent.
    expect(isValidDomain([5, 0])).toBe(true)
  })

  it('rejects the empty sentinel, NaN, and infinities (non-finite bounds)', () => {
    expect(isValidDomain(EMPTY_DOMAIN)).toBe(false)
    expect(isValidDomain([Infinity, -Infinity])).toBe(false)
    expect(isValidDomain([NaN, NaN])).toBe(false)
    expect(isValidDomain([0, Infinity])).toBe(false)
  })
})

describe('resolveSharedDomain — union across scopes for a key', () => {
  const scopes: ColorScaleScope[] = [
    { key: 'expr', domain: [0, 5], colormap: 'viridis' },
    { key: 'expr', domain: [2, 9], colormap: 'viridis' },
    { key: 'other', domain: [-3, 3], colormap: 'magma' },
  ]

  it('unions every scope coloring by the key', () => {
    expect(resolveSharedDomain(scopes, 'expr')).toEqual([0, 9])
  })

  it('ignores scopes for other keys', () => {
    expect(resolveSharedDomain(scopes, 'other')).toEqual([-3, 3])
  })

  it('returns null when no scope colors by the key', () => {
    expect(resolveSharedDomain(scopes, 'missing')).toBeNull()
    expect(resolveSharedDomain([], 'expr')).toBeNull()
  })

  it('skips an invalid (empty / all-NaN) sibling — valid domain is untouched', () => {
    const withEmpty: ColorScaleScope[] = [
      { key: 'expr', domain: [Infinity, -Infinity], colormap: 'viridis' },
      { key: 'expr', domain: [0, 5], colormap: 'viridis' },
      { key: 'expr', domain: [NaN, NaN], colormap: 'viridis' },
    ]
    expect(resolveSharedDomain(withEmpty, 'expr')).toEqual([0, 5])
  })

  it('returns null when every matching scope is invalid', () => {
    const allInvalid: ColorScaleScope[] = [
      { key: 'expr', domain: [Infinity, -Infinity], colormap: 'viridis' },
      { key: 'expr', domain: [NaN, NaN], colormap: 'viridis' },
    ]
    expect(resolveSharedDomain(allInvalid, 'expr')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Coordination store slice
// ---------------------------------------------------------------------------

describe('Coordination store — colorScale slice', () => {
  beforeEach(() => {
    // Reset only the owned slice (leave sibling coordination state untouched).
    useCoordinationStore.setState({ colorScales: {} })
  })

  it('registers a scope and reads it back', () => {
    useCoordinationStore
      .getState()
      .setColorScale('panel-a', { key: 'expr', domain: [0, 5], colormap: 'viridis' })
    expect(useCoordinationStore.getState().colorScales['panel-a']).toEqual({
      key: 'expr',
      domain: [0, 5],
      colormap: 'viridis',
    })
  })

  it('two panels coloring by the same key share the union domain [0, 9]', () => {
    const store = useCoordinationStore.getState()
    store.setColorScale('panel-a', { key: 'expr', domain: [0, 5], colormap: 'viridis' })
    store.setColorScale('panel-b', { key: 'expr', domain: [2, 9], colormap: 'viridis' })
    expect(sharedColorDomain('expr')).toEqual([0, 9])
  })

  it('does not merge across different keys', () => {
    const store = useCoordinationStore.getState()
    store.setColorScale('panel-a', { key: 'expr', domain: [0, 5], colormap: 'viridis' })
    store.setColorScale('panel-b', { key: 'size', domain: [2, 9], colormap: 'magma' })
    expect(sharedColorDomain('expr')).toEqual([0, 5])
    expect(sharedColorDomain('size')).toEqual([2, 9])
  })

  it('unregister restores the surviving panel domain', () => {
    const store = useCoordinationStore.getState()
    store.setColorScale('panel-a', { key: 'expr', domain: [0, 5], colormap: 'viridis' })
    store.setColorScale('panel-b', { key: 'expr', domain: [2, 9], colormap: 'viridis' })
    expect(sharedColorDomain('expr')).toEqual([0, 9])

    store.clearColorScale('panel-b')
    expect(sharedColorDomain('expr')).toEqual([0, 5])

    store.clearColorScale('panel-a')
    expect(sharedColorDomain('expr')).toBeNull()
  })

  it('sharedColorDomain is null when nothing registered', () => {
    expect(sharedColorDomain('expr')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TEST-19 — SHARED by-name category→color coordination (Build-2 / ITEM-19, "C3"):
// the categorical analog of the continuous shared-domain path. A named group
// ("T cells") must resolve to ONE color across two linked scopes; a category only
// one scope names keeps its own; the continuous-domain path is UNCHANGED.
// ---------------------------------------------------------------------------

describe('resolveSharedCategoryColors — merge by-name category colors across scopes', () => {
  // Two panes both color by `cell_type`; both name "T cells" (different colors).
  const scopes: CategoryColorScope[] = [
    { key: 'cell_type', categoryColors: { 'T cells': '#ff0000', 'B cells': '#00ff00' } },
    { key: 'cell_type', categoryColors: { 'T cells': '#0000ff', 'NK cells': '#ffff00' } },
    { key: 'stage', categoryColors: { early: '#111111' } },
  ]

  it('resolves a named group ("T cells") to ONE color across two scopes (first-writer-wins)', () => {
    const merged = resolveSharedCategoryColors(scopes, 'cell_type')
    // Scope-A wrote "T cells" first, so its color wins over Scope-B's — one stable color.
    expect(merged?.['T cells']).toBe('#ff0000')
  })

  it('a category named by only one scope keeps its own color', () => {
    const merged = resolveSharedCategoryColors(scopes, 'cell_type')
    expect(merged?.['B cells']).toBe('#00ff00') // only in scope A
    expect(merged?.['NK cells']).toBe('#ffff00') // only in scope B
    expect(merged).toEqual({
      'T cells': '#ff0000',
      'B cells': '#00ff00',
      'NK cells': '#ffff00',
    })
  })

  it('ignores scopes for other color-by columns', () => {
    expect(resolveSharedCategoryColors(scopes, 'stage')).toEqual({ early: '#111111' })
  })

  it('returns null when no scope colors by the key (caller falls back to its own palette)', () => {
    expect(resolveSharedCategoryColors(scopes, 'missing')).toBeNull()
    expect(resolveSharedCategoryColors([], 'cell_type')).toBeNull()
  })

  it('returns a FRESH object (never leaks a caller-owned per-scope map by reference)', () => {
    const single: CategoryColorScope[] = [
      { key: 'cell_type', categoryColors: { 'T cells': '#ff0000' } },
    ]
    const merged = resolveSharedCategoryColors(single, 'cell_type')
    expect(merged).not.toBe(single[0].categoryColors)
    expect(merged).toEqual({ 'T cells': '#ff0000' })
  })
})

describe('ColorOverride store — categoryColorScopes slice', () => {
  beforeEach(() => {
    // Reset only the owned slice (leave the persisted DISPLAY `overrides` untouched).
    useColorOverrideStore.setState({ categoryColorScopes: {} })
  })

  it('registers a scope and reads it back', () => {
    useColorOverrideStore
      .getState()
      .setCategoryColorScope('panel-a', {
        key: 'cell_type',
        categoryColors: { 'T cells': '#ff0000' },
      })
    expect(useColorOverrideStore.getState().categoryColorScopes['panel-a']).toEqual({
      key: 'cell_type',
      categoryColors: { 'T cells': '#ff0000' },
    })
  })

  it('two panes coloring by the same column share ONE color for "T cells"', () => {
    const store = useColorOverrideStore.getState()
    store.setCategoryColorScope('panel-a', {
      key: 'cell_type',
      categoryColors: { 'T cells': '#ff0000', 'B cells': '#00ff00' },
    })
    store.setCategoryColorScope('panel-b', {
      key: 'cell_type',
      categoryColors: { 'T cells': '#0000ff', 'NK cells': '#ffff00' },
    })
    const shared = sharedCategoryColors('cell_type')
    expect(shared?.['T cells']).toBe('#ff0000') // one stable color across both panes
    expect(shared?.['B cells']).toBe('#00ff00')
    expect(shared?.['NK cells']).toBe('#ffff00')
  })

  it('does not merge across different color-by columns', () => {
    const store = useColorOverrideStore.getState()
    store.setCategoryColorScope('panel-a', {
      key: 'cell_type',
      categoryColors: { 'T cells': '#ff0000' },
    })
    store.setCategoryColorScope('panel-b', {
      key: 'tissue',
      categoryColors: { 'T cells': '#0000ff' },
    })
    expect(sharedCategoryColors('cell_type')).toEqual({ 'T cells': '#ff0000' })
    expect(sharedCategoryColors('tissue')).toEqual({ 'T cells': '#0000ff' })
  })

  it('unregister restores the surviving pane map', () => {
    const store = useColorOverrideStore.getState()
    store.setCategoryColorScope('panel-a', {
      key: 'cell_type',
      categoryColors: { 'T cells': '#ff0000' },
    })
    store.setCategoryColorScope('panel-b', {
      key: 'cell_type',
      categoryColors: { 'NK cells': '#ffff00' },
    })
    expect(sharedCategoryColors('cell_type')).toEqual({
      'T cells': '#ff0000',
      'NK cells': '#ffff00',
    })

    store.clearCategoryColorScope('panel-b')
    expect(sharedCategoryColors('cell_type')).toEqual({ 'T cells': '#ff0000' })

    store.clearCategoryColorScope('panel-a')
    expect(sharedCategoryColors('cell_type')).toBeNull()
  })

  it('sharedCategoryColors is null when nothing registered', () => {
    expect(sharedCategoryColors('cell_type')).toBeNull()
  })

  it('registering categorical scopes leaves the DISPLAY `overrides` slice untouched', () => {
    const store = useColorOverrideStore.getState()
    store.setCategoryColorScope('panel-a', {
      key: 'cell_type',
      categoryColors: { 'T cells': '#ff0000' },
    })
    // The additive slice does not perturb the persisted per-column display overrides.
    expect(useColorOverrideStore.getState().overrides).toEqual({})
  })
})

describe('TEST-19 — continuous-domain path is UNCHANGED by the categorical slice', () => {
  beforeEach(() => {
    useCoordinationStore.setState({ colorScales: {} })
    useColorOverrideStore.setState({ categoryColorScopes: {} })
  })

  it('the pure continuous union still merges numeric domains', () => {
    const scopes: ColorScaleScope[] = [
      { key: 'expr', domain: [0, 5], colormap: 'viridis' },
      { key: 'expr', domain: [2, 9], colormap: 'viridis' },
    ]
    expect(resolveSharedDomain(scopes, 'expr')).toEqual([0, 9])
  })

  it('registering categorical scopes does not affect the continuous sharedColorDomain', () => {
    // Continuous coordination lives in the Coordination store; categorical in the
    // ColorOverride store — registering one must not perturb the other.
    useCoordinationStore
      .getState()
      .setColorScale('panel-a', { key: 'expr', domain: [0, 5], colormap: 'viridis' })
    useColorOverrideStore
      .getState()
      .setCategoryColorScope('panel-a', {
        key: 'expr',
        categoryColors: { 'T cells': '#ff0000' },
      })
    expect(sharedColorDomain('expr')).toEqual([0, 5])
  })
})
