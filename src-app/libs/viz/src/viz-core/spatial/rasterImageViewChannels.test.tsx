// @vitest-environment jsdom
//
// rasterImageViewChannels.test.tsx — #288 TEST-21.
//
// The standalone `RasterImageView` renders BOTH the Viv layer and the per-channel control
// panel, and for one round those two read different arrays: `buildRasterImageLayers` cut the
// channel state to the loader's `'c'` extent while the panel mapped the raw `channels` prop.
// The render was right and the EDITOR was wrong, silently — a persisted 5-entry array on a
// 2-channel loader rendered five rows of controls, three of which mutated state that was
// truncated away before it became a prop, so the user drags a slider and nothing moves.
//
// It cannot be caught by a pure test: it is a property of what this component RENDERS. So this
// mounts it. `DeckGL` is stubbed because the layer objects are asserted through
// `buildRasterImageLayers` elsewhere and jsdom has no WebGL context — what is under test here
// is the AGREEMENT between the two consumers, which is exactly what the stub preserves.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imagePixelSource, imagePixelSource16 } from './imageFixture'
import { reconcileChannelsToLoader } from './channelState'
import type { RasterChannelState } from './rasterImageLayers'

vi.mock('@deck.gl/react', () => ({
  DeckGL: ({ layers }: { layers: unknown[] }) => (
    <div data-testid="deck" data-selections={JSON.stringify(
      (layers ?? []).map(l => (l as { props?: { selections?: { c: number }[] } }).props?.selections),
    )} />
  ),
}))

const { RasterImageView } = await import('./RasterImageView')

// React reports a duplicate key through `console.error`, so it is captured rather than ignored:
// a warning nobody reads is the same as no warning.
const errors: string[] = []
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors.length = 0
  consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
})
afterEach(() => {
  consoleError.mockRestore()
  cleanup()
})

const chans = (n: number): RasterChannelState[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `C${i}`,
    color: [i, i, i] as [number, number, number],
    contrastLimits: [0, 255] as [number, number],
    visible: true,
  }))

const selectionsOf = (): { c: number }[] =>
  (JSON.parse(screen.getByTestId('deck').getAttribute('data-selections') ?? '[]') as {
    c: number
  }[][])[0] ?? []

describe('TEST-21 the per-channel panel lists exactly the channels the layer draws', () => {
  for (const [loaderChannels, given] of [
    [2, 5], // persisted state OUTLIVED a wider loader
    [5, 1], // …or a narrower one
    [3, 3], // and the matching case is untouched
  ] as const) {
    it(`loader has ${loaderChannels} channel(s), the caller supplies ${given}`, () => {
      const loader = imagePixelSource({ base: 64, channels: loaderChannels, levels: 1 })
      render(<RasterImageView loader={loader} channels={chans(given)} />)
      const rows = screen.getAllByTestId(/^raster-channel-\d+$/)
      expect(rows).toHaveLength(loaderChannels)
      expect(selectionsOf()).toEqual(
        Array.from({ length: loaderChannels }, (_, c) => ({ c })),
      )
      // …and the two agree on IDENTITY, not merely on SIZE. The assertion that used to stand
      // here was `rows.length === selectionsOf().length`, under a comment claiming it showed
      // "the SAME set" — both operands were already asserted equal to `loaderChannels` two lines
      // up, and REVERSING the panel's row order (so row 0's slider edits the channel the layer
      // draws last) passed the entire package.
      //
      // Row `i` must be the reconciled channel `i`, which is what `setChannel(i, …)` addresses
      // and what selection `{c: i}` draws. The names are unique per index here, so the panel's
      // own labels are the identity to check.
      const expected = reconcileChannelsToLoader(chans(given), loader)
      expect(rows.map(row => row.querySelector('input')?.getAttribute('aria-label'))).toEqual(
        expected.map(ch => `${ch.name} visible`),
      )

      // No duplicate React keys, which the reconciliation can MANUFACTURE: extending a
      // `[{name:'Channel 1'}]` against a 3-channel loader splices in `seedChannelsForLoader`'s
      // own `Channel 1`. React logs "Encountered two children with the same key" and declines
      // to guarantee the behaviour, so the panel is keyed positionally — which is also how
      // `setChannel(i, …)` addresses it.
      expect(errors.filter(m => /same key/.test(m))).toEqual([])
    })
  }

  it('the seeded rows follow the loader DTYPE across a loader swap', () => {
    // `reconcileChannelsToLoader`'s extend path seeds through `seedChannelsForLoader`, which
    // sizes each window from the loader's dtype. A memo keyed on anything narrower than `loader`
    // — an earlier cut keyed it on the channel COUNT, to avoid recomputing for a host that
    // re-renders with a fresh `[...sources]` — leaves the seeded rows carrying the PREVIOUS
    // dtype's `[0, max]` after a swap that keeps the count. The narrower key bought nothing
    // observable, because the `layers` memo depends on `loader` identity anyway; this is what it
    // cost.
    const { rerender } = render(
      <RasterImageView
        loader={imagePixelSource({ base: 64, channels: 5, levels: 1 })}
        channels={chans(1)}
      />,
    )
    const end = () =>
      (screen.getByTestId('raster-channel-4-contrast-end') as HTMLInputElement)
    expect(end().max).toBe('255')

    rerender(
      <RasterImageView
        loader={imagePixelSource16({ base: 64, channels: 5, levels: 1 })}
        channels={chans(1)}
      />,
    )
    expect(end().max).toBe('65535')
    expect(end().value).toBe('65535')
  })

  it('a caller name that COLLIDES with a seeded one does not produce a duplicate React key', () => {
    // The keys were `ch.name`, and the reconciliation can MANUFACTURE a collision from an input
    // that has none: extending `[{ name: 'Channel 1' }]` against a 3-channel loader splices in
    // `seedChannelsForLoader`'s own `Channel 1` and `Channel 2`, so the panel renders
    // ['Channel 1', 'Channel 1', 'Channel 2']. React logs "Encountered two children with the
    // same key" and explicitly declines to guarantee the behaviour of the list after that.
    //
    // The generic cases above cannot see it — their caller names (`C0`, `C1`, …) never collide
    // with the seeder's (`Channel 0`, …) — which is why this case names the seeder's own
    // spelling on purpose.
    render(
      <RasterImageView
        loader={imagePixelSource({ base: 64, channels: 3, levels: 1 })}
        channels={[{ name: 'Channel 1', color: [1, 1, 1], contrastLimits: [0, 255], visible: true }]}
      />,
    )
    expect(screen.getAllByTestId(/^raster-channel-\d+$/)).toHaveLength(3)
    expect(errors.filter(m => /same key/.test(m))).toEqual([])
    // …and the rows really do carry the colliding name, so this is not passing because the
    // reconciliation happened to rename anything.
    expect(screen.getAllByLabelText(/Channel 1 visible/)).toHaveLength(2)
  })

  it('an edit to a SEEDED channel lands, and lands on that channel', () => {
    // The fix `setChannel` carries: it reconciles `prev` before mapping, because an edit to a
    // channel the reconciliation had seeded used to fall off the end of the raw state and do
    // nothing at all. Asserted through the rendered control, not through the callback.
    render(
      <RasterImageView
        loader={imagePixelSource({ base: 64, channels: 4, levels: 1 })}
        channels={chans(1)}
      />,
    )
    const box = (i: number) => screen.getByTestId(`raster-channel-${i}-visible`) as HTMLInputElement
    expect(box(3).checked).toBe(true)
    fireEvent.click(box(3))
    expect(box(3).checked).toBe(false)
    // …and only that one.
    expect([box(0).checked, box(1).checked, box(2).checked]).toEqual([true, true, true])
  })

  it('the contrast sliders are sized from the loader DTYPE when the caller supplies no bound', () => {
    // `contrastMax` was defaulted to 255 and `installBuiltins`' `ImageAdapter` never passes it,
    // so a Uint16 image got a `max=255` slider over a seeded `[0, 65535]` window: the DOM clamps
    // the value, the slider sits pinned right, and the first touch collapses the window to <=255
    // — the image blows out with no feedback.
    render(
      <RasterImageView
        loader={imagePixelSource16({ base: 64, channels: 2, levels: 1 })}
        channels={chans(2)}
      />,
    )
    const ends = screen.getAllByTestId(
      /^raster-channel-\d+-contrast-(begin|end)$/,
    ) as HTMLInputElement[]
    expect(ends.length).toBeGreaterThan(0)
    for (const input of ends) expect(input.max).toBe('65535')
  })
})
