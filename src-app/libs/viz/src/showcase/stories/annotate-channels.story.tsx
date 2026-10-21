// annotate-channels.story.tsx (ITEM-15, P0) — the per-channel contrast / color / visibility /
// colormap controls (ITEM-2). Renders `RasterImageView` with its built-in Channels panel
// (`hideControls={false}`) over the 16-bit multiplex fixture, so every control is live: toggle a
// marker's visibility, recolor it, drag its contrast (a shader uniform → recomposite, NO tile
// refetch), or switch the whole image to a single additive `colormap`. Authored at desktop + 390px.

import { useMemo, useState } from 'react'
import { RasterImageView, type RasterChannelState } from '../../viz-core/spatial/RasterImageView'
import { imagePixelSource16 } from '../../viz-core/spatial/imageFixture'
import { WidthKnob } from './annotateStoryKit'
import { registerStory } from '../registry'

const MARKER_COLORS: [number, number, number][] = [
  [0, 128, 255],
  [255, 96, 0],
  [0, 255, 128],
  [255, 0, 200],
  [255, 220, 0],
]

function baseChannels(): RasterChannelState[] {
  return MARKER_COLORS.map((color, i) => ({
    name: `Marker ${i}`,
    color,
    contrastLimits: [0, 45000],
    visible: true,
  }))
}

function AnnotateChannelsStory() {
  const loader = useMemo(() => imagePixelSource16({ base: 256, channels: 5, levels: 3 }), [])
  const [colormap, setColormap] = useState<string | undefined>(undefined)

  // Remount the view on the color-mode switch so its owned channel copy re-seeds from the
  // fresh initial channels (per-channel colors ↔ single additive colormap are exclusive).
  const channels = useMemo(baseChannels, [])

  return (
    <div
      data-testid="viz-annotate-channels"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ opacity: 0.7 }}>Color mode:</span>
        <button
          type="button"
          data-testid="annotate-channels-mode-perchannel"
          aria-pressed={colormap === undefined}
          onClick={() => setColormap(undefined)}
          style={{ fontWeight: colormap === undefined ? 700 : 400 }}
        >
          Per-channel colors
        </button>
        {['viridis', 'magma'].map(cm => (
          <button
            key={cm}
            type="button"
            data-testid={`annotate-channels-colormap-${cm}`}
            aria-pressed={colormap === cm}
            onClick={() => setColormap(cm)}
            style={{ fontWeight: colormap === cm ? 700 : 400 }}
          >
            Colormap: {cm}
          </button>
        ))}
        <span style={{ opacity: 0.55 }}>
          Toggle / recolor / contrast-drag a marker in the panel — recomposites live, no refetch.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="annotate-channels">
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
            <RasterImageView
              key={colormap ?? 'per-channel'}
              loader={loader}
              channels={channels}
              contrastMax={65535}
              colormap={colormap}
            />
          </div>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'annotate-channels',
  category: 'Controls',
  title: 'Annotate — channel contrast / color / visibility / colormap (live, no refetch)',
  covers: 'annotate-channels',
  Component: AnnotateChannelsStory,
})
