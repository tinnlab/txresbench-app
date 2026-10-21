// clip.test.ts — #3: clipToBounds must add deck's ClipExtension + clipBounds (= the plot rect) to each
// mark layer, PRESERVING any existing extensions. Uses a mock layer (props + clone) so no GL context.
import { describe, it, expect } from 'vitest'
import { ClipExtension } from '@deck.gl/extensions'
import { clipToBounds } from './clip'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockLayer(props: Record<string, any> = {}): any {
  return {
    props,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clone(next: Record<string, any>) {
      return mockLayer({ ...props, ...next })
    },
  }
}

describe('clipToBounds — clip data marks to the plot rect (#3)', () => {
  it('adds a ClipExtension + clipBounds = bounds to each mark', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = clipToBounds([mockLayer(), mockLayer()] as any, [1, 2, 3, 4]) as any[]
    expect(out).toHaveLength(2)
    for (const l of out) {
      expect(l.props.clipBounds).toEqual([1, 2, 3, 4])
      expect(l.props.extensions.some((e: unknown) => e instanceof ClipExtension)).toBe(true)
    }
  })

  it('PRESERVES a pre-existing extension (appends clip, never replaces)', () => {
    const existing = { marker: 'keep-me' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [out] = clipToBounds([mockLayer({ extensions: [existing] })] as any, [0, 0, 1, 1]) as any[]
    expect(out.props.extensions[0]).toBe(existing) // original ext first, untouched
    expect(out.props.extensions.some((e: unknown) => e instanceof ClipExtension)).toBe(true)
    expect(out.props.extensions).toHaveLength(2)
  })

  it('the clipBounds match the given window so zoomed marks clip at the axis edge', () => {
    // A y-value window [0..50] (candlestick price-zoom) → marks above 50 are clipped by the extension.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [out] = clipToBounds([mockLayer()] as any, [-0.6, 0, 120.6, 50]) as any[]
    expect(out.props.clipBounds).toEqual([-0.6, 0, 120.6, 50])
  })
})
