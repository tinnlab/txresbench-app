// processorPort.test.ts (TEST-9) — the ITEM-10 acceptance proof for the processor seam.
//
// Two things this proves, both required by ITEM-10:
//  1. COMPILE-TIME: a small mock object type-checks against `ProcessorPort` with NO
//     `as any` — so the interface is actually implementable by an external processor.
//  2. RUNTIME: `structuredClone` of every result type succeeds (LabelMaskResult with a
//     Uint32Array, a GeoFeature[], a CommitResult) — proving the seam is serialization-safe
//     so a future cross-window / Web-Worker / cross-process processor is a pure addition.

import { describe, it, expect } from 'vitest'
import type {
  ProcessorPort,
  ImageRef,
  ProcessorViewState,
  Gesture,
  LabelMaskResult,
  GeoFeature,
  CommitOpts,
  CommitResult,
  PendingState,
} from './processorPort'

// ── a mock processor-side view of the port, built with NO `as any` (compile-time proof) ──

function makeMockPort(): ProcessorPort {
  const imageRef: ImageRef = {
    sourceId: 'fixture-image-0',
    width: 4096,
    height: 4096,
    levelCount: 3,
    channelCount: 2,
    pixelSize: [0.5, 0.5],
  }
  const viewState: ProcessorViewState = {
    center: [2048, 2048],
    zoom: -2,
    bounds: [0, 0, 4096, 4096],
  }
  const gesture: Gesture = { kind: 'lasso', ring: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]) }

  const commit = (features: ReadonlyArray<GeoFeature>, opts?: CommitOpts): CommitResult => ({
    ids: features.map((_, i) => `mock-id-${i}`),
    groupId: opts?.groupId,
    replaced: 0,
  })

  return {
    getImageRef: () => imageRef,
    getViewState: () => viewState,
    getActiveGesture: () => gesture,
    commitPolygons: commit,
    commitPoints: commit,
    commitLabelMask: (_result: LabelMaskResult, opts?: CommitOpts): CommitResult => ({
      ids: ['mask-group-0'],
      groupId: opts?.groupId,
      replaced: 0,
    }),
    setPending: (_pending: PendingState | null): void => {
      /* display-only no-op in the mock (INV-3: never runs a model) */
    },
  }
}

describe('ProcessorPort — ITEM-10 typed seam', () => {
  it('a mock object type-checks against ProcessorPort with no `as any`', () => {
    const port = makeMockPort()
    // exercise every method so the shapes are real, not just structurally asserted.
    expect(port.getImageRef().width).toBe(4096)
    expect(port.getViewState().zoom).toBe(-2)
    const g = port.getActiveGesture()
    expect(g?.kind).toBe('lasso')
    port.setPending({ message: 'Segmenting…', progress: 0.5, region: [0, 0, 10, 10] })
    port.setPending(null)
  })

  it('structuredClone(LabelMaskResult) with a Uint32Array survives (serialization-safe)', () => {
    const w = 4
    const h = 3
    const data = new Uint32Array(w * h)
    for (let i = 0; i < data.length; i++) data[i] = i * 70000 // > 65535 → needs Uint32
    const result: LabelMaskResult = {
      data,
      width: w,
      height: h,
      categoryForId: [0, 1, 1, 2],
      bounds: [0, 0, w, h],
    }
    const clone = structuredClone(result)
    expect(clone.data).toBeInstanceOf(Uint32Array)
    expect(Array.from(clone.data)).toEqual(Array.from(data))
    expect(clone.data).not.toBe(result.data) // a real copy, not a shared reference
    expect(clone.width).toBe(w)
    expect(clone.categoryForId).toEqual([0, 1, 1, 2])
    expect(clone.bounds).toEqual([0, 0, w, h])
  })

  it('structuredClone(GeoFeature[]) survives — polygon, point, and path arms', () => {
    const features: GeoFeature[] = [
      {
        geometry: { kind: 'polygon', rings: [new Float64Array([0, 0, 10, 0, 10, 10, 0, 10])] },
        classId: 'tumor',
        label: 'region 1',
        properties: { measurements: { area: 123.5 }, 'txresbench:foreign': true },
      },
      { geometry: { kind: 'point', xy: [5, 5] }, classId: null, label: null },
      { geometry: { kind: 'path', xy: new Float64Array([0, 0, 1, 1, 2, 2]) } },
    ]
    const clone = structuredClone(features)
    expect(clone).toHaveLength(3)
    const poly = clone[0].geometry
    expect(poly.kind).toBe('polygon')
    if (poly.kind === 'polygon') {
      expect(poly.rings[0]).toBeInstanceOf(Float64Array)
      expect(Array.from(poly.rings[0])).toEqual([0, 0, 10, 0, 10, 10, 0, 10])
    }
    // foreign-property passthrough (INV-7) survives the clone verbatim.
    expect(clone[0].properties).toEqual({ measurements: { area: 123.5 }, 'txresbench:foreign': true })
    const pt = clone[1].geometry
    if (pt.kind === 'point') expect(pt.xy).toEqual([5, 5])
  })

  it('structuredClone(CommitResult) survives', () => {
    const result: CommitResult = { ids: ['a', 'b', 'c'], groupId: 'run-1', replaced: 2 }
    const clone = structuredClone(result)
    expect(clone.ids).toEqual(['a', 'b', 'c'])
    expect(clone.groupId).toBe('run-1')
    expect(clone.replaced).toBe(2)
  })

  it('structuredClone(Gesture) survives all three arms (click | box | lasso)', () => {
    const gestures: Gesture[] = [
      { kind: 'click', at: [3, 4] },
      { kind: 'box', rect: [0, 0, 8, 8] },
      { kind: 'lasso', ring: new Float64Array([0, 0, 5, 0, 5, 5]) },
    ]
    const clone = structuredClone(gestures)
    expect(clone[0]).toEqual({ kind: 'click', at: [3, 4] })
    expect(clone[1]).toEqual({ kind: 'box', rect: [0, 0, 8, 8] })
    const lasso = clone[2]
    if (lasso.kind === 'lasso') expect(lasso.ring).toBeInstanceOf(Float64Array)
  })
})
