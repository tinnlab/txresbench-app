// spatial-image.story.tsx — the gigapixel/multi-channel SPATIAL IMAGE view-kind
// showcase (Viv adoption). Renders `RasterImageView` over a SYNTHETIC multiscale,
// multi-channel image fixture (`viz-core/spatial/imageFixture`) so it renders with no
// real OME-Zarr/OME-TIFF dataset — a 3-channel, 3-level pyramid with a recognizable
// pattern per channel (horizontal ramp / vertical ramp / concentric rings), composited
// additively via Viv's XRLayer channel model with per-channel color / contrast /
// visibility toggles.
//
// The affine placement (`imageModelMatrix`) maps the full-res pixel grid into global
// micron space; here we also fold in a small element→global registration affine to
// exercise the composition path.
//
// NOTE ON CATEGORY: the `StoryCategory` union has no 'Spatial' bucket, so this story
// registers under the existing 'View kinds' category (alongside the legacy `image`
// BitmapLayer story). It `covers: 'spatial-image'` for the completeness gate.

import { useMemo } from 'react'
import { RasterImageView, type RasterChannelState } from '../../viz-core/spatial/RasterImageView'
import { makeSpatialImageFixture } from '../../viz-core/spatial/imageFixture'
import { imageModelMatrix } from '../../viz-core/spatial/imageMeta'
import { composeAffine } from '../../viz-core/data/image'
import { registerStory } from '../registry'

function SpatialImageStory() {
  const fixture = useMemo(() => makeSpatialImageFixture({ base: 256, channels: 3, levels: 3 }), [])

  // element→global-micron registration (a gentle rotate+scale+shift) folded over the
  // NGFF pixel→micron scale, so the demonstrated modelMatrix exercises composition.
  const modelMatrix = useMemo(() => {
    const registration = composeAffine({ scale: 1, rotation: 0.05, translate: [8, -4] })
    return imageModelMatrix(fixture.meta, registration)
  }, [fixture])

  const initialChannels = useMemo<RasterChannelState[]>(
    () =>
      fixture.channels.map(ch => ({
        name: ch.name,
        color: ch.color,
        contrastLimits: [...ch.window] as [number, number],
        visible: true,
      })),
    [fixture],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-testid="viz-spatial-image">
      <div style={{ padding: 8, opacity: 0.6 }}>
        Viv multiscale image — {fixture.loader.length}-level pyramid, {fixture.channels.length}{' '}
        channels (additive compositing + per-channel color / contrast / visibility)
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <RasterImageView
          loader={fixture.loader}
          channels={initialChannels}
          modelMatrix={modelMatrix}
          contrastMax={255}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'spatial-image',
  category: 'View kinds',
  title: 'Spatial image — Viv multiscale + multi-channel (gigapixel)',
  covers: 'spatial-image',
  Component: SpatialImageStory,
})
