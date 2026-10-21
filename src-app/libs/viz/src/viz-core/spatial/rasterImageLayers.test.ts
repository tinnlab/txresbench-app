// rasterImageLayers.test.ts — TEST-1: the pure raster-image layer builder. Constructing a
// deck.gl Layer only shapes props (no GL context), so the builder is directly node-testable:
// we assert the MultiscaleImageLayer-iff-`loader.length>1`-else-ImageLayer choice, the 1:1
// mapping of channel state → Viv XRLayer props, and the stable `cellLayerId(cellId,'image')` id.

import { describe, it, expect } from 'vitest'
import { MultiscaleImageLayer, ImageLayer } from '@hms-dbmi/viv'
import { Matrix4 } from '@math.gl/core'
import { channelCountOfLoader, buildRasterImageLayers, type RasterChannelState } from './rasterImageLayers'
import { cellLayerId } from '../layers/multiView'
import { imagePixelSource, imagePixelSourceRgb } from './imageFixture'

const CHANNELS: RasterChannelState[] = [
  { name: 'C0', color: [255, 0, 0], contrastLimits: [10, 200], visible: true },
  { name: 'C1', color: [0, 255, 0], contrastLimits: [5, 180], visible: false },
  { name: 'C2', color: [0, 0, 255], contrastLimits: [0, 255], visible: true },
]

describe('buildRasterImageLayers (TEST-1)', () => {
  it('returns a MultiscaleImageLayer when loader.length > 1', () => {
    const loader = imagePixelSource({ levels: 3 }) // 3-level pyramid
    expect(loader.length).toBeGreaterThan(1)
    const layers = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'cellA' })
    expect(layers).toHaveLength(1)
    expect(layers[0]).toBeInstanceOf(MultiscaleImageLayer)
    expect(layers[0]).not.toBeInstanceOf(ImageLayer)
  })

  it('returns an ImageLayer when loader.length === 1 (single-level RGB)', () => {
    const loader = imagePixelSourceRgb() // single level
    expect(loader).toHaveLength(1)
    const layers = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'cellA' })
    expect(layers).toHaveLength(1)
    expect(layers[0]).toBeInstanceOf(ImageLayer)
    expect(layers[0]).not.toBeInstanceOf(MultiscaleImageLayer)
  })

  it('returns no layer for an empty loader', () => {
    expect(buildRasterImageLayers({ loader: [], channels: CHANNELS, cellId: 'cellA' })).toEqual([])
  })

  it('maps channel state 1:1 to selections / contrastLimits / channelsVisible / colors', () => {
    const loader = imagePixelSource({ levels: 3 })
    const [layer] = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'cellA' })
    const p = (layer as unknown as { props: Record<string, unknown> }).props
    // selections: one { c: i } per channel, in channel-index order.
    expect(p.selections).toEqual([{ c: 0 }, { c: 1 }, { c: 2 }])
    expect(p.contrastLimits).toEqual([[10, 200], [5, 180], [0, 255]])
    expect(p.channelsVisible).toEqual([true, false, true])
    expect(p.colors).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255]])
    // dtype taken off level 0 (Uint8 fixture).
    expect(p.dtype).toBe(loader[0].dtype)
    // exactly one extension (the ColorPaletteExtension, no colormap).
    expect(Array.isArray(p.extensions)).toBe(true)
    expect((p.extensions as unknown[]).length).toBe(1)
  })

  it('mirrors the channel count for any channel arity (props stay 1:1)', () => {
    const loader = imagePixelSource({ levels: 3, channels: 5 })
    const chans: RasterChannelState[] = Array.from({ length: 5 }, (_, i) => ({
      name: `C${i}`,
      color: [i, i, i],
      contrastLimits: [i, 100 + i],
      visible: i % 2 === 0,
    }))
    const [layer] = buildRasterImageLayers({ loader, channels: chans, cellId: 'x' })
    const p = (layer as unknown as { props: Record<string, unknown> }).props
    expect((p.selections as unknown[]).length).toBe(5)
    expect((p.contrastLimits as unknown[]).length).toBe(5)
    expect((p.channelsVisible as unknown[]).length).toBe(5)
    expect((p.colors as unknown[]).length).toBe(5)
    expect(p.selections).toEqual([{ c: 0 }, { c: 1 }, { c: 2 }, { c: 3 }, { c: 4 }])
  })

  it('#288: channel state that disagrees with the loader is RECONCILED before it becomes props', () => {
    // Every prop below is still 1:1 with the channel state — what changed is that the state is
    // first cut to the loader's own `'c'` extent. Before #288 every OME-TIFF pyramid had one
    // channel and this could not go wrong; a source can now declare 2 or 5..10, and `channels`
    // reaches this function from three call sites, all of which can be handed a persisted
    // `cell.channels` that outlived the loader it was seeded against (`propagateToLinked`
    // copies one cell's array to another by design).
    const chans = (n: number): RasterChannelState[] =>
      Array.from({ length: n }, (_, i) => ({
        name: `C${i}`,
        color: [i, i, i] as [number, number, number],
        contrastLimits: [i, 100 + i] as [number, number],
        visible: i % 2 === 0,
      }))
    const propsOf = (layer: unknown): Record<string, unknown> =>
      (layer as { props: Record<string, unknown> }).props

    // TOO LONG: unreconciled this issued {c:2}..{c:4} against a 2-channel source, which
    // `omeTiffPyramid` refuses BY NAME — once per tile, from inside deck.gl's render loop.
    const narrowLoader = imagePixelSource({ levels: 3, channels: 2 })
    const [narrowed] = buildRasterImageLayers({ loader: narrowLoader, channels: chans(5), cellId: 'n' })
    const narrowProps = propsOf(narrowed)
    expect(narrowProps.selections).toEqual([{ c: 0 }, { c: 1 }])
    // …and every 1:1 prop is cut with it, or Viv would read them at mismatched lengths.
    expect((narrowProps.contrastLimits as unknown[]).length).toBe(2)
    expect((narrowProps.channelsVisible as unknown[]).length).toBe(2)
    expect((narrowProps.colors as unknown[]).length).toBe(2)

    // TOO SHORT: unreconciled this drew ONE of five samples and named none of the others —
    // #288's own invariant, broken one layer above the reader that enforces it.
    const wideLoader = imagePixelSource({ levels: 3, channels: 5 })
    const [widened] = buildRasterImageLayers({ loader: wideLoader, channels: chans(1), cellId: 'w' })
    const wideProps = propsOf(widened)
    expect(wideProps.selections).toEqual([{ c: 0 }, { c: 1 }, { c: 2 }, { c: 3 }, { c: 4 }])
    expect((wideProps.colors as unknown[]).length).toBe(5)
    // The caller's own state for channel 0 survives; the rest are seeded defaults.
    expect((wideProps.contrastLimits as [number, number][])[0]).toEqual([0, 100])
  })

  it('#288: an EMPTY channel array means "none supplied", not "draw nothing"', () => {
    // `[]` is truthy, so it takes the EXTEND path and yields the full seeded set — a deliberate
    // reading (the editor toggles `visible`, it never removes entries), documented at length in
    // `reconcileChannelsToLoader`, and for one round pinned by nothing. It is INV-3-shaped: the
    // other reading gives zero selections, i.e. every sample the file carries neither displayed
    // nor named in a refusal.
    const loader = imagePixelSource({ levels: 3, channels: 4 })
    const [layer] = buildRasterImageLayers({ loader, channels: [], cellId: 'empty' })
    const props = (layer as unknown as { props: Record<string, unknown> }).props
    expect(props.selections).toEqual([{ c: 0 }, { c: 1 }, { c: 2 }, { c: 3 }])
    expect((props.colors as unknown[]).length).toBe(4)
  })

  it('#288: a source declaring a ZERO-length channel axis still yields one channel', () => {
    // `channelCountOfLoader`'s `Math.max(1, …)` — removable-while-green for one round. A `'c'`
    // axis of 0 is malformed, and the honest floor is ONE channel (which then reads the plane)
    // rather than zero selections, which is the same "draw nothing, say nothing" outcome.
    const loader = imagePixelSource({ levels: 1, channels: 1 })
    const zeroAxis = [
      { ...loader[0], shape: [0, 64, 64], labels: ['c', 'y', 'x'] },
    ] as unknown as typeof loader
    expect(channelCountOfLoader(zeroAxis)).toBe(1)
    const [layer] = buildRasterImageLayers({ loader: zeroAxis, channels: CHANNELS, cellId: 'z' })
    const props = (layer as unknown as { props: Record<string, unknown> }).props
    expect(props.selections).toEqual([{ c: 0 }])
  })

  it('gives the layer the stable prefixed id cellLayerId(cellId, "image")', () => {
    const multiscale = buildRasterImageLayers({ loader: imagePixelSource({ levels: 3 }), channels: CHANNELS, cellId: 'paneQ' })
    expect(multiscale[0].id).toBe(cellLayerId('paneQ', 'image'))
    expect(multiscale[0].id).toBe('paneQ::image')
    const single = buildRasterImageLayers({ loader: imagePixelSourceRgb(), channels: CHANNELS, cellId: 'paneR' })
    expect(single[0].id).toBe(cellLayerId('paneR', 'image'))
  })

  it('accepts a modelMatrix as number[] or Matrix4 and threads it onto the layer', () => {
    const loader = imagePixelSource({ levels: 3 })
    const mm = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1] // column-major scale+translate
    const [fromArray] = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'x', modelMatrix: mm })
    const pa = (fromArray as unknown as { props: { modelMatrix: Matrix4 } }).props
    expect(pa.modelMatrix).toBeInstanceOf(Matrix4)
    expect(Array.from(pa.modelMatrix)).toEqual(mm)
    // a ready Matrix4 is passed through unchanged.
    const m4 = new Matrix4(mm)
    const [fromMat] = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'x', modelMatrix: m4 })
    expect((fromMat as unknown as { props: { modelMatrix: Matrix4 } }).props.modelMatrix).toBe(m4)
  })

  it('swaps to a single colormap extension when `colormap` is set (ITEM-2 seam)', () => {
    const loader = imagePixelSource({ levels: 3 })
    const [withPalette] = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'x' })
    const [withColormap] = buildRasterImageLayers({ loader, channels: CHANNELS, cellId: 'x', colormap: 'viridis' })
    const ep = (l: unknown) => (l as { props: { extensions: unknown[]; colormap?: string } }).props
    // both carry exactly one extension, but a different one; colormap prop only when set.
    expect(ep(withPalette).extensions.length).toBe(1)
    expect(ep(withColormap).extensions.length).toBe(1)
    expect(ep(withPalette).extensions[0]).not.toBe(ep(withColormap).extensions[0])
    expect(ep(withColormap).colormap).toBe('viridis')
    expect(ep(withPalette).colormap).toBeUndefined()
  })
})
