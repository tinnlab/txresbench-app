// @vitest-environment jsdom
// Dependent-options resolver coverage (ITEM-37). The `form-dependent-options` e2e spec was
// retired with the demo fixtures (Slice 7 / ITEM-24), but the LIVE `useEnumOptions` hook still
// ships (rendered by every enum field in `SchemaForm` → `AnalysisRunPanel`). This unit test
// repoints that coverage onto the real hook (declarative-processor-ui Phase 7, FE4): static
// pass-through, debounced re-resolve, stale-resolve discard, and value-clear when the current
// selection leaves the freshly-resolved set.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { OptionsResolver } from '@/modules/workbench/core'
import { useEnumOptions } from './useDependentOptions'

describe('useEnumOptions (dependent options, ITEM-37)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('no resolver → static options synchronously (back-compat, no debounce)', () => {
    const { result } = renderHook(() =>
      useEnumOptions({
        staticOptions: ['a', 'b'],
        resolver: undefined,
        values: {},
        current: 'a',
        onClear: () => {},
      }),
    )
    expect(result.current).toEqual({ options: ['a', 'b'], loading: false })
  })

  test('a resolver re-resolves the option set (debounced) from the sibling values', async () => {
    const resolver: OptionsResolver = vi.fn(async (v: Record<string, unknown>) =>
      v.kind === 'rna' ? ['total_counts', 'pct_mito'] : ['total_counts'],
    )
    const { result, rerender } = renderHook((props: { values: Record<string, unknown> }) =>
      useEnumOptions({
        staticOptions: ['total_counts'],
        resolver,
        values: props.values,
        current: 'total_counts',
        onClear: () => {},
      }),
    { initialProps: { values: { kind: 'rna' } } },
    )
    // Before the first resolve lands, the static superset shows (no empty flash) + loading.
    expect(result.current.options).toEqual(['total_counts'])
    expect(result.current.loading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.options).toEqual(['total_counts', 'pct_mito'])
    expect(result.current.loading).toBe(false)
    // Change a sibling value → re-resolve to the narrower set.
    rerender({ values: { kind: 'atac' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.options).toEqual(['total_counts'])
  })

  test('clears the field value when the current selection leaves the resolved set', async () => {
    const onClear = vi.fn()
    const resolver: OptionsResolver = async () => ['x', 'y'] // does NOT include current 'z'
    renderHook(() =>
      useEnumOptions({
        staticOptions: ['x', 'y', 'z'],
        resolver,
        values: { dep: 1 },
        current: 'z',
        onClear,
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  test('a rapid value change before the debounce elapses resolves only the NEWEST set once', async () => {
    // The debounce cancels the superseded timer, so only the last value's resolve runs — the
    // field never flashes an intermediate (stale) option set.
    const resolver = vi.fn<OptionsResolver>(async (v: Record<string, unknown>) => [`opts-${v.n}`])
    const { result, rerender } = renderHook((props: { values: Record<string, unknown> }) =>
      useEnumOptions({
        staticOptions: ['static'],
        resolver,
        values: props.values,
        current: null,
        onClear: () => {},
      }),
    { initialProps: { values: { n: 1 } } },
    )
    rerender({ values: { n: 2 } }) // supersede before the first debounce fires
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(resolver).toHaveBeenCalledTimes(1) // the first (superseded) resolve never ran
    expect(result.current.options).toEqual(['opts-2'])
  })
})
