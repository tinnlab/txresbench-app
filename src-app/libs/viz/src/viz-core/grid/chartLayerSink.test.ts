import { describe, it, expect, vi } from 'vitest'
import { createChartLayerSink, type ChartContribution } from './chartLayerSink'
import type { Layer } from '@deck.gl/core'

const layerA = { id: 'volcano::pts' } as unknown as Layer
const contrib = (cellId: string, layers: readonly Layer[], zoom: number | [number, number] = 0): ChartContribution => ({
  cellId,
  layers,
  view: { flipY: false, controller: true },
  viewState: { target: [0, 0], zoom },
})

describe('createChartLayerSink — chart cells publish their shared-deck contribution', () => {
  it('publish + snapshot exposes a cell keyed by id', () => {
    const sink = createChartLayerSink()
    sink.publish(contrib('volcano', [layerA]))
    expect([...sink.snapshot().keys()]).toEqual(['volcano'])
    expect(sink.snapshot().get('volcano')?.layers).toEqual([layerA])
  })

  it('notifies subscribers on a real change and returns an unsubscribe', () => {
    const sink = createChartLayerSink()
    const fn = vi.fn()
    const off = sink.subscribe(fn)
    sink.publish(contrib('a', [layerA]))
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    sink.publish(contrib('b', [layerA]))
    expect(fn).toHaveBeenCalledTimes(1) // unsubscribed
  })

  it('is shallow-equal-gated: re-publishing an identical contribution does NOT notify (breaks the loop)', () => {
    const sink = createChartLayerSink()
    const fn = vi.fn()
    sink.subscribe(fn)
    const c = contrib('a', [layerA], [1, 2])
    sink.publish(c)
    sink.publish({ ...c, view: { flipY: false, controller: true }, viewState: { target: [0, 0], zoom: [1, 2] } }) // value-equal
    expect(fn).toHaveBeenCalledTimes(1) // second publish deduped
  })

  it('notifies when layers ref, view params, or viewState actually change', () => {
    const sink = createChartLayerSink()
    const fn = vi.fn()
    sink.subscribe(fn)
    sink.publish(contrib('a', [layerA], 0))
    sink.publish(contrib('a', [layerA], 1)) // zoom changed
    sink.publish(contrib('a', [{ id: 'x' } as unknown as Layer], 1)) // layers ref changed
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('remove drops the cell and notifies once; removing an absent cell is a no-op', () => {
    const sink = createChartLayerSink()
    const fn = vi.fn()
    sink.publish(contrib('a', [layerA]))
    sink.subscribe(fn)
    sink.remove('a')
    expect(sink.snapshot().has('a')).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    sink.remove('a') // already gone
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('snapshot identity changes on mutation (useSyncExternalStore correctness)', () => {
    const sink = createChartLayerSink()
    const s0 = sink.snapshot()
    sink.publish(contrib('a', [layerA]))
    expect(sink.snapshot()).not.toBe(s0)
  })
})
