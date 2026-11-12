// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import * as React from 'react'
import type { ScatterWidget } from '@/modules/workbench/core/manifest/viewSpec'

// TEST (finding #4) — the scatter renderer MEMOIZES its `FrameDataSource`: `<Viz>` keys its
// data pull on `source` IDENTITY, so a fresh source on every store revision (a slider /
// gate change) would blank + re-pull the chart. The memo anchors on the STABLE frame
// slice reference, so a state change that does NOT replace the slice keeps the SAME
// source; only a real data arrival (a new slice ref) rebuilds it.

const captured: unknown[] = []
vi.mock('@txresbench/viz', () => ({
  Viz: (props: { source?: unknown }) => {
    captured.push(props.source)
    return React.createElement('div', { 'data-testid': 'viz-mock' })
  },
}))

// Import AFTER the mock is registered (vi.mock is hoisted, but keep intent explicit).
import { ScatterRenderer } from './viz'
import type { WidgetRenderContext } from '@/modules/workbench/core/render/registry'

const obsA = { nCount: [1, 2, 3], nFeature: [4, 5, 6], pct_mito: [1, 2, 3], ident: ['a', 'a', 'b'] }
const obsB = { nCount: [9, 8, 7], nFeature: [6, 5, 4], pct_mito: [3, 2, 1], ident: ['c', 'c', 'd'] }

const w: ScatterWidget = {
  kind: 'scatter',
  id: 'sc',
  obs: '$data.obs',
  encode: { x: 'nCount', y: 'nFeature', colorBy: 'pct_mito', groupBy: 'ident' },
  filters: '$state.filteringParams',
  selection: '$state.gate',
  onSelect: 'applyGate',
  onFilter: 'setRange',
}

function ctxFor(gate: number[], obs: Record<string, unknown>): WidgetRenderContext {
  return {
    viewId: 'v',
    scope: { params: {}, state: { gate, filteringParams: {} }, derived: {}, const: {}, data: { obs } },
    dispatch: () => {},
    renderChildren: () => null as unknown as React.ReactElement,
  }
}

function Harness({ gate, obs }: { gate: number[]; obs: Record<string, unknown> }): React.ReactElement {
  return <>{ScatterRenderer(w, ctxFor(gate, obs))}</>
}

beforeEach(() => {
  captured.length = 0
  cleanup()
})

describe('scatter renderer — memoized FrameDataSource (finding #4)', () => {
  it('keeps the SAME source across a state change when the /obs slice is unchanged', () => {
    const { rerender } = render(<Harness gate={[0]} obs={obsA} />)
    // A state-only change (gate) with the same obs slice reference.
    rerender(<Harness gate={[1]} obs={obsA} />)
    rerender(<Harness gate={[2]} obs={obsA} />)

    expect(captured.length).toBeGreaterThanOrEqual(2)
    const first = captured[0]
    expect(first).toBeDefined()
    // Every render observed the SAME memoized source identity — no re-pull storm.
    for (const s of captured) expect(s).toBe(first)
  })

  it('rebuilds the source when the /obs slice reference changes (real data arrival)', () => {
    const { rerender } = render(<Harness gate={[0]} obs={obsA} />)
    const beforeCount = captured.length
    const sourceA = captured[0]
    rerender(<Harness gate={[0]} obs={obsB} />)
    expect(captured.length).toBeGreaterThan(beforeCount)
    const sourceB = captured[captured.length - 1]
    expect(sourceB).not.toBe(sourceA)
  })
})
