// axisPointer.test.ts — unit tests for the pure axis-pointer crosshair geometry (ITEM-33).
// No deck.gl / GL / DOM — asserts pixel⇄world projection, guide-line endpoints, tick snap,
// and the out-of-plot ⇒ no-pointer contract.

import { describe, it, expect } from 'vitest'
import {
  computeAxisPointer,
  pixelToWorld,
  worldToPixel,
  type OrthoViewport,
} from './axisPointer'
import type { CategoryTick } from './axisTicks'

const bounds: [number, number, number, number] = [0, 0, 10, 100]

// A concrete, hand-checkable viewport: 800×600 canvas, target at the data centre
// (5, 50), zoom 0 → 2^0 = 1 px per world unit on both axes, value-up (flipY = false).
const vp: OrthoViewport = { width: 800, height: 600, target: [5, 50], zoom: 0, flipY: false }

describe('pixel ⇄ world projection', () => {
  it('maps the viewport centre to the target world point', () => {
    expect(pixelToWorld(vp, [400, 300])).toEqual([5, 50])
    expect(worldToPixel(vp, [5, 50])).toEqual([400, 300])
  })

  it('is a round-trip inverse (value-up: +world-y is UP ⇒ smaller pixel-y)', () => {
    // 10 px right of centre, 20 px above centre (value-up).
    const world = pixelToWorld(vp, [410, 280])
    expect(world[0]).toBeCloseTo(15) // 5 + 10/1
    expect(world[1]).toBeCloseTo(70) // 50 + 20/1  (up ⇒ +y)
    expect(worldToPixel(vp, world)).toEqual([410, 280])
  })

  it('honours a per-axis [zoomX, zoomY] zoom pair and flipY', () => {
    const zvp: OrthoViewport = { width: 200, height: 100, target: [0, 0], zoom: [1, 2], flipY: true }
    // 2^1 = 2 px/unit x, 2^2 = 4 px/unit y; flipY ⇒ +world-y is DOWN.
    expect(worldToPixel(zvp, [10, 5])).toEqual([100 + 20, 50 + 20])
    expect(pixelToWorld(zvp, [120, 70])).toEqual([10, 5])
  })
})

describe('computeAxisPointer — world-coord pointer', () => {
  it('emits a full crosshair (vertical + horizontal) spanning the plot rect', () => {
    const r = computeAxisPointer({ bounds, world: [3, 40], mode: 'cross' })
    expect(r.inPlot).toBe(true)
    expect(r.segments).toHaveLength(2)
    // vertical x-line at x=3 spans yMin..yMax
    expect(r.segments[0]).toEqual({ source: [3, 0], target: [3, 100] })
    // horizontal y-line at y=40 spans xMin..xMax
    expect(r.segments[1]).toEqual({ source: [0, 40], target: [10, 40] })
    expect(r.x?.label).toBe('3')
    expect(r.y?.label).toBe('40')
  })

  it("mode 'x' draws only the vertical guide + only an x readout", () => {
    const r = computeAxisPointer({ bounds, world: [3, 40], mode: 'x' })
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]).toEqual({ source: [3, 0], target: [3, 100] })
    expect(r.x).toBeDefined()
    expect(r.y).toBeUndefined()
  })

  it("mode 'y' draws only the horizontal guide + only a y readout", () => {
    const r = computeAxisPointer({ bounds, world: [3, 40], mode: 'y' })
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]).toEqual({ source: [0, 40], target: [10, 40] })
    expect(r.y).toBeDefined()
    expect(r.x).toBeUndefined()
  })
})

describe('computeAxisPointer — tick / category snapping', () => {
  const xTicks: CategoryTick[] = [
    { pos: 0, label: 'A' },
    { pos: 1, label: 'B' },
    { pos: 2, label: 'C' },
  ]

  it('snaps the x guide to the NEAREST category (default when xTicks given)', () => {
    const r = computeAxisPointer({ bounds: [-0.6, 0, 2.6, 100], world: [1.4, 40], xTicks })
    // 1.4 is nearest to category 'B' at pos 1
    expect(r.x?.snapped).toBe(true)
    expect(r.x?.pos).toBe(1)
    expect(r.x?.label).toBe('B')
    // the vertical guide is drawn at the SNAPPED position, not the raw 1.4
    expect(r.segments.find(s => s.source[0] === s.target[0])?.source[0]).toBe(1)
  })

  it('leaves a free value axis unsnapped (raw value, formatted)', () => {
    const r = computeAxisPointer({ bounds, world: [3.25, 40], mode: 'x' })
    expect(r.x?.snapped).toBe(false)
    expect(r.x?.pos).toBe(3.25)
    expect(r.x?.label).toBe('3.25')
  })

  it('respects an explicit snapX:false even when xTicks are supplied', () => {
    const r = computeAxisPointer({ bounds: [-0.6, 0, 2.6, 100], world: [1.4, 40], xTicks, snapX: false })
    expect(r.x?.snapped).toBe(false)
    expect(r.x?.pos).toBeCloseTo(1.4)
  })
})

describe('computeAxisPointer — pixel pointer via viewport', () => {
  it('unprojects a pixel to world and builds the crosshair', () => {
    const r = computeAxisPointer({ bounds, pixel: [400, 300], viewport: vp })
    expect(r.inPlot).toBe(true)
    expect(r.world[0]).toBeCloseTo(5)
    expect(r.world[1]).toBeCloseTo(50)
    // anchor falls back to the raw cursor pixel
    expect(r.anchorPixel).toEqual([400, 300])
  })
})

describe('computeAxisPointer — out-of-plot ⇒ no pointer', () => {
  it('returns no crosshair when the pointer is outside the plot rect', () => {
    const r = computeAxisPointer({ bounds, world: [20, 40] })
    expect(r.inPlot).toBe(false)
    expect(r.segments).toHaveLength(0)
    expect(r.x).toBeUndefined()
    expect(r.y).toBeUndefined()
  })

  it('returns no crosshair when there is no pointer at all', () => {
    const r = computeAxisPointer({ bounds, world: null })
    expect(r.inPlot).toBe(false)
    expect(r.segments).toHaveLength(0)
  })
})
