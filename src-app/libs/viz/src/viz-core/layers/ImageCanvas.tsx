// ImageCanvas.tsx — the `image` view-kind (ITEM-10 / DEC-13). A GPU canvas that
// composites a raster IMAGE UNDERLAY (BitmapLayer) beneath a scatter of spots
// positioned in the image's shared coordinate space via an AFFINE transform
// (DEC-13: cell↔image alignment is an affine; BitmapLayer bounds are `[0,H,W,0]`).
// Framework-agnostic (viz-core): depends ONLY on @deck.gl/* + react (DEC-28 generic
// naming — nothing here knows about biology).

import { useMemo, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import type { Matrix4Like } from '@math.gl/core'
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers'
import { buildScatterProps, buildBitmapProps } from './scatter'
import { toBitmapTexture } from './bitmapTexture'
import { imageBounds, type Affine } from '../data/image'
import { affineToModelMatrix } from '../data/affineMatrix'

export interface ImageCanvasProps {
  /** RGBA/RGB raster bytes + its pixel dimensions (the underlay). */
  underlay: { data: Uint8Array; width: number; height: number }
  /** interleaved xy Float32Array of spot positions in the layout's own space. */
  positions: Float32Array
  /** RGBA Uint8Array (length N*4) for the spots (from `computeColoring`). */
  colors: Uint8Array
  /** affine mapping the spot positions into the image's shared coordinate space. */
  affine: Affine
  /** physical spot radius in COMMON (world) units, so spots scale with the image. */
  radius?: number
  /** initial underlay opacity (0..1); the range control overrides it live. */
  initialOpacity?: number
  /** bump when `colors` content changes so the layer re-uploads. */
  colorEpoch?: number
}

/** The `image` view: a bitmap underlay + affine-aligned spots, dimmable underlay. */
export function ImageCanvas({
  underlay,
  positions,
  colors,
  affine,
  radius = 4,
  initialOpacity = 1,
  colorEpoch = 0,
}: ImageCanvasProps) {
  const [opacity, setOpacity] = useState(initialOpacity)

  const view = useMemo(() => new OrthographicView({ id: 'image', flipY: true }), [])

  // spots live in the image's shared coordinate space (DEC-13 affine). The affine
  // is applied on the GPU via the layer's `modelMatrix` (DEC-26) — the RAW positions
  // go straight to the GPU buffer, so there is NO O(2N)-per-point CPU pass
  // (`transformPositions`) on the hot path (it survives only as the CPU parity oracle).
  const modelMatrix = useMemo(() => affineToModelMatrix(affine), [affine])
  const bounds = useMemo(() => imageBounds(underlay.width, underlay.height), [underlay])

  // The raster texture source, memoized on `underlay` ALONE — NOT on opacity (M4). deck
  // compares BitmapLayer's `image` prop by REFERENCE; a stable object across opacity ticks
  // means the (67MB+ for a 4096² tile) texture is uploaded ONCE, not re-created on every
  // opacity change. Opacity is a shader UNIFORM applied to the BitmapLayer below, so it
  // needs no texture rebuild — the visual result is identical.
  const image = useMemo(
    () => ({ data: underlay.data, width: underlay.width, height: underlay.height }),
    [underlay],
  )

  // The actual GPU texture: deck.gl v9 uploads a raw `{data,width,height}` object with ZEROED RGB
  // (the underlay renders BLACK), so wrap the bytes in an `ImageData` (RGB→RGBA as needed). Memoized
  // on `underlay` ALONE — like `image` above — so the (potentially 67MB) texture uploads ONCE and
  // stays stable across opacity ticks (opacity is a shader uniform, not a texture rebuild).
  const texture = useMemo(() => toBitmapTexture(underlay), [underlay])

  const initialViewState = useMemo<OrthographicViewState>(
    () =>
      ({
        target: [underlay.width / 2, underlay.height / 2, 0],
        zoom: 0,
      }) as OrthographicViewState,
    [underlay],
  )

  const layers = useMemo(() => {
    // Pass the memoized `image` (stable across opacity ticks) so a new BitmapLayer created on
    // an opacity change reuses the SAME texture — only the `opacity` uniform changes (M4).
    const bp = buildBitmapProps(image, bounds, opacity)
    const bitmap = new BitmapLayer({
      id: bp.id,
      // Feed the ImageData texture (not the raw `bp.image` object, which deck v9 renders black).
      image: texture as never,
      // BitmapLayer's `bounds` is a mutable tuple; copy off the readonly build prop.
      bounds: [...bp.bounds] as [number, number, number, number],
      opacity: bp.opacity,
    })
    const spots = new ScatterplotLayer({
      ...buildScatterProps({
        id: 'image-spots',
        positions,
        colors,
        radius,
        radiusUnits: 'common',
        pickable: true,
      }),
      // GPU affine: deck multiplies this into every vertex, so the raw `positions`
      // land in image/shared-coordinate space on the shader (DEC-26). Radii are in
      // 'common' units, so the affine's scale carries the spots with the image.
      // (deck types modelMatrix as a fixed 16-tuple; our helper returns number[16].)
      modelMatrix: modelMatrix as Matrix4Like,
      updateTriggers: { getFillColor: colorEpoch },
    })
    return [bitmap, spots]
  }, [image, texture, bounds, opacity, positions, modelMatrix, colors, radius, colorEpoch])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-image-canvas"
    >
      <DeckGL views={view} controller initialViewState={initialViewState} layers={layers} />
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          background: 'rgba(255,255,255,0.7)',
          padding: '2px 6px',
          borderRadius: 4,
        }}
      >
        <label style={{ fontSize: 12 }}>
          Underlay opacity{' '}
          <input
            data-testid="image-opacity"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={e => setOpacity(Number(e.target.value))}
          />
        </label>
      </div>
    </div>
  )
}
