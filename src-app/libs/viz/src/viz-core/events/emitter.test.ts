// emitter.test.ts — the pure typed plot-event emitter (EVENT_API_PLAN Phase 1). Node-testable:
// no React, no store, no DOM. Covers on/emit delivery, multi-listener fan-out, unsubscribe,
// per-type isolation, mid-emit-unsubscribe safety, `listenerCount`, and the `windowAxis` derivation.

import { describe, it, expect, vi } from 'vitest'
import { VizEmitter, windowAxis, type VizEvent } from './emitter'

const SELECT: VizEvent = { type: 'select', ids: new Uint32Array([1, 2, 3]), origin: 'panel-a' }
const ZOOM: VizEvent = { type: 'dataZoom', id: 'p1', axis: 'x', window: { x: [0, 1] } }
const HOVER: VizEvent = { type: 'hover', id: 7, value: 42 }
const HOVER_LEAVE: VizEvent = { type: 'hover', id: null }
const LEGEND: VizEvent = { type: 'legend', column: 'cluster', hidden: [1, 3] }
const FILTER: VizEvent = { type: 'filter', id: 'vm-1', column: 'expr', range: [0.2, 0.8] }
const CELL_CLOSE: VizEvent = { type: 'cell-close', cellId: 'crit-3' }

describe('VizEmitter', () => {
  it('delivers an emitted event to a subscribed handler', () => {
    const em = new VizEmitter()
    const seen: VizEvent[] = []
    em.on('select', e => seen.push(e))
    em.emit(SELECT)
    expect(seen).toEqual([SELECT])
  })

  it('fans one event to MULTIPLE listeners of the same type', () => {
    const em = new VizEmitter()
    const a = vi.fn()
    const b = vi.fn()
    em.on('select', a)
    em.on('select', b)
    em.emit(SELECT)
    expect(a).toHaveBeenCalledWith(SELECT)
    expect(b).toHaveBeenCalledWith(SELECT)
  })

  it('unsubscribe stops further delivery (and is idempotent)', () => {
    const em = new VizEmitter()
    const h = vi.fn()
    const off = em.on('select', h)
    em.emit(SELECT)
    off()
    em.emit(SELECT)
    off() // idempotent — no throw, no effect
    expect(h).toHaveBeenCalledTimes(1)
  })

  it('delivers a cell-close event carrying the cellId (Phase 3 controlled close)', () => {
    const em = new VizEmitter()
    const seen: VizEvent[] = []
    em.on('cell-close', e => seen.push(e))
    em.emit(CELL_CLOSE)
    expect(seen).toEqual([CELL_CLOSE])
    expect((seen[0] as { cellId: string }).cellId).toBe('crit-3')
  })

  it('isolates listeners by type — a select listener never sees a dataZoom event', () => {
    const em = new VizEmitter()
    const onSelect = vi.fn()
    const onZoom = vi.fn()
    em.on('select', onSelect)
    em.on('dataZoom', onZoom)
    em.emit(ZOOM)
    expect(onZoom).toHaveBeenCalledWith(ZOOM)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('emitting to a type with no listeners is a no-op', () => {
    const em = new VizEmitter()
    expect(() => em.emit(ZOOM)).not.toThrow()
  })

  it('a handler may unsubscribe mid-dispatch without skipping its peers', () => {
    const em = new VizEmitter()
    const order: string[] = []
    let offSelf: () => void = () => {}
    // First handler removes itself while the emit is in flight; the second must still run.
    offSelf = em.on('select', () => {
      order.push('first')
      offSelf()
    })
    em.on('select', () => order.push('second'))
    em.emit(SELECT)
    expect(order).toEqual(['first', 'second'])
    // The self-removed handler is gone next emit; the peer remains.
    order.length = 0
    em.emit(SELECT)
    expect(order).toEqual(['second'])
  })

  it('delivers the Phase-2 event types (hover / legend / filter) to their listeners', () => {
    const em = new VizEmitter()
    const onHover = vi.fn()
    const onLegend = vi.fn()
    const onFilter = vi.fn()
    em.on('hover', onHover)
    em.on('legend', onLegend)
    em.on('filter', onFilter)
    em.emit(HOVER)
    em.emit(LEGEND)
    em.emit(FILTER)
    expect(onHover).toHaveBeenCalledWith(HOVER)
    expect(onLegend).toHaveBeenCalledWith(LEGEND)
    expect(onFilter).toHaveBeenCalledWith(FILTER)
  })

  it('a hover-leave (id null) delivers just like a hovered mark', () => {
    const em = new VizEmitter()
    const onHover = vi.fn()
    em.on('hover', onHover)
    em.emit(HOVER)
    em.emit(HOVER_LEAVE)
    expect(onHover).toHaveBeenNthCalledWith(1, HOVER)
    expect(onHover).toHaveBeenNthCalledWith(2, HOVER_LEAVE)
  })

  it('isolates the Phase-2 types from each other and from the Phase-1 types', () => {
    const em = new VizEmitter()
    const onHover = vi.fn()
    const onLegend = vi.fn()
    const onFilter = vi.fn()
    const onSelect = vi.fn()
    em.on('hover', onHover)
    em.on('legend', onLegend)
    em.on('filter', onFilter)
    em.on('select', onSelect)
    // A legend event reaches ONLY the legend listener.
    em.emit(LEGEND)
    expect(onLegend).toHaveBeenCalledTimes(1)
    expect(onHover).not.toHaveBeenCalled()
    expect(onFilter).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('tracks listenerCount per type', () => {
    const em = new VizEmitter()
    expect(em.listenerCount('select')).toBe(0)
    const off1 = em.on('select', () => {})
    const off2 = em.on('select', () => {})
    em.on('dataZoom', () => {})
    expect(em.listenerCount('select')).toBe(2)
    expect(em.listenerCount('dataZoom')).toBe(1)
    off1()
    expect(em.listenerCount('select')).toBe(1)
    off2()
    expect(em.listenerCount('select')).toBe(0)
  })
})

describe('windowAxis', () => {
  it('derives the moved-axis tag from a window shape', () => {
    expect(windowAxis({ x: [0, 1] })).toBe('x')
    expect(windowAxis({ y: [0, 1] })).toBe('y')
    expect(windowAxis({ x: [0, 1], y: [2, 3] })).toBe('xy')
    // An empty window degrades to 'xy' (never throws).
    expect(windowAxis({})).toBe('xy')
  })
})
