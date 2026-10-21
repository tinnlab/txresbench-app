// annotate-image-render.story.tsx (ITEM-15, P0) — the multichannel image render surface the
// annotation editor draws over. Renders `RasterImageView` directly (like `spatial-image.story`)
// against the three `imageFixture` pyramid shapes ITEM-1 must cover: a single-level RGB source
// (H&E-like, the `ImageLayer` path), a 16-bit multiplex-additive pyramid (the tiled
// `MultiscaleImageLayer` path), and TWO cells side-by-side (per-cell isolation). A "loading"
// state (no loader yet) covers the empty branch. Authored at desktop AND 390px via `WidthKnob`.

import { useMemo, useState } from 'react'
import { RasterImageView, type RasterChannelState } from '../../viz-core/spatial/RasterImageView'
import { imagePixelSource16, imagePixelSourceRgb } from '../../viz-core/spatial/imageFixture'
import { WidthKnob } from './annotateStoryKit'
import { registerStory } from '../registry'

const RGB_CHANNELS: RasterChannelState[] = [
  { name: 'R', color: [255, 0, 0], contrastLimits: [0, 255], visible: true },
  { name: 'G', color: [0, 255, 0], contrastLimits: [0, 255], visible: true },
  { name: 'B', color: [0, 0, 255], contrastLimits: [0, 255], visible: true },
]

const MULTIPLEX_COLORS: [number, number, number][] = [
  [0, 128, 255],
  [255, 96, 0],
  [0, 255, 128],
  [255, 0, 200],
  [255, 220, 0],
]
const MULTIPLEX_CHANNELS: RasterChannelState[] = MULTIPLEX_COLORS.map((color, i) => ({
  name: `Marker ${i}`,
  color,
  contrastLimits: [0, 65535],
  visible: true,
}))

type Variant = 'rgb' | 'multiplex' | 'two-cells' | 'loading'

function AnnotateImageRenderStory() {
  const [variant, setVariant] = useState<Variant>('rgb')
  const rgb = useMemo(() => imagePixelSourceRgb({ base: 256 }), [])
  const multiplex = useMemo(() => imagePixelSource16({ base: 256, channels: 5, levels: 3 }), [])
  const multiplexB = useMemo(() => imagePixelSource16({ base: 256, channels: 5, levels: 3 }), [])

  const body = (() => {
    if (variant === 'loading') {
      return (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'rgb(120,120,120)' }}>
          Loading image pyramid…
        </div>
      )
    }
    if (variant === 'two-cells') {
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}>
            <RasterImageView loader={rgb} channels={RGB_CHANNELS} contrastMax={255} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <RasterImageView loader={multiplexB} channels={MULTIPLEX_CHANNELS} contrastMax={65535} />
          </div>
        </div>
      )
    }
    const loader = variant === 'rgb' ? rgb : multiplex
    const channels = variant === 'rgb' ? RGB_CHANNELS : MULTIPLEX_CHANNELS
    const contrastMax = variant === 'rgb' ? 255 : 65535
    return (
      <div style={{ flex: 1, minHeight: 0 }}>
        <RasterImageView loader={loader} channels={channels} contrastMax={contrastMax} />
      </div>
    )
  })()

  return (
    <div
      data-testid="viz-annotate-image-render"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        {(['rgb', 'multiplex', 'two-cells', 'loading'] as Variant[]).map(v => (
          <button
            key={v}
            type="button"
            data-testid={`annotate-image-variant-${v}`}
            aria-pressed={variant === v}
            onClick={() => setVariant(v)}
            style={{ fontWeight: variant === v ? 700 : 400 }}
          >
            {v === 'rgb'
              ? 'H&E RGB (single-level)'
              : v === 'multiplex'
                ? '16-bit multiplex (pyramid)'
                : v === 'two-cells'
                  ? 'Two cells (isolation)'
                  : 'Loading'}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="annotate-image-render">
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
            {body}
          </div>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'annotate-image-render',
  category: 'View kinds',
  title: 'Annotate — multichannel image render (RGB · 16-bit multiplex · two-cell isolation)',
  covers: 'annotate-image-render',
  Component: AnnotateImageRenderStory,
})
