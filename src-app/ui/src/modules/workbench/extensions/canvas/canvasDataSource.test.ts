// canvasDataSource.test.ts — ITEM-8's memoization, which is the half the wiring rests on.
//
// `CanvasView` clean-replaces its `VizController` on every option change (`CanvasView.tsx:127`,
// declarative twin at `:181`), and a colour change IS an option change. So the controller is
// rebuilt, the `DatasetStore` resolver is re-installed and the dataset is re-acquired — and
// whether that costs a fresh read of the coordinates comes down to one question: does the
// re-resolve reach the SAME `WorkbenchStreamingSource`, whose replay buffer already holds them?
//
// It does only because `buildCanvasSources` memoizes. This file pins that, and its companion —
// "given one instance, an encoding change re-decodes positions ZERO times, and given two, twice"
// — is `workbenchStreamingSource.test.ts`'s `TEST-7(c)` pair. Neither half is evidence alone: a
// memoized factory over a source with no replay still re-reads, and a source with replay reached
// through a fresh instance each time never replays.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@ziee/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import type { WorkbenchAPI } from '@/modules/workbench/core'
import { buildCanvasSources, __resetCanvasSourcesForTests } from './canvasDataSource'

/** A handle with the right IDENTITY and nothing else. Legitimate here: the control-plane read is
 *  lazy (`buildCanvasDataSource` reaches `api.capabilities` only inside `getCatalog`), and no case
 *  below resolves a catalog — the subject is which INSTANCE comes back, not what it reads. */
function fakeApi(): WorkbenchAPI {
  return {} as WorkbenchAPI
}

describe('ITEM-8 — buildCanvasSources memoizes per (api, project)', () => {
  it('the same (api, project) yields the SAME source instance', () => {
    const api = fakeApi()
    __resetCanvasSourcesForTests(api)
    const first = buildCanvasSources(api, 'p1')
    const second = buildCanvasSources(api, 'p1')
    // Identity, not deep equality. The cache and in-flight multicast are per-INSTANCE, so two
    // structurally-identical sources share nothing — which is exactly the pre-ITEM-8 behaviour
    // (`buildCanvasDataSource` minted a new one on every call) and exactly what makes a recolour
    // re-read the coordinates.
    expect(second.streaming).toBe(first.streaming)
    expect(second.pull).toBe(first.pull)
  })

  it('a DIFFERENT project gets a cold source — never the previous project`s cache', () => {
    const api = fakeApi()
    __resetCanvasSourcesForTests(api)
    const p1 = buildCanvasSources(api, 'p1')
    const p2 = buildCanvasSources(api, 'p2')
    // The correctness half of the memo, and the more important one: every artifact id changes
    // with the project, so serving p2 out of p1's cache would hand back another project's bytes.
    expect(p2.streaming).not.toBe(p1.streaming)
    expect(buildCanvasSources(api, 'p1').streaming).toBe(p1.streaming)
  })

  it('a DIFFERENT workbench handle gets a cold source', () => {
    const a = fakeApi()
    const b = fakeApi()
    __resetCanvasSourcesForTests(a)
    __resetCanvasSourcesForTests(b)
    expect(buildCanvasSources(b, 'p1').streaming).not.toBe(buildCanvasSources(a, 'p1').streaming)
  })

  it('the reset seam really empties the cache — so a test asserting on reads starts cold', () => {
    const api = fakeApi()
    const before = buildCanvasSources(api, 'p1')
    __resetCanvasSourcesForTests(api)
    // Non-vacuity for every case above: if the reset were a no-op, "a different project gets a
    // cold source" would still pass and this file would be asserting nothing about lifetime.
    expect(buildCanvasSources(api, 'p1').streaming).not.toBe(before.streaming)
  })
})
