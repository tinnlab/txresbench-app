// image-tile.story.tsx — the LAZY TILED BACKGROUND IMAGE showcase (STREAMING_PROGRESSIVE_PLAN
// item 15). Renders `ImageTileLayer` (the hand-rolled viewport-culled tile pyramid — deck's
// own TileLayer lives in the un-installed `@deck.gl/geo-layers`) beneath a small scatter, over
// a SYNTHETIC tiled image: each `(level,x,y)` tile is drawn on the fly as a data-URI
// checkerboard labeled with its coordinate, so it renders with NO server tile source. The big
// image is composited UNDER the points and NEVER enters the point accumulator.
//
// It exposes `window.__VIZ_TEST__.imageTile = { visibleTiles, level }` (the current culled
// selection) so the e2e harness can assert only viewport-intersecting tiles fetch and the
// zoom-matched level is chosen — the same window-hook pattern as density-aggregate.story.

import { useEffect, useMemo, useState, useCallback } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { ImageTileLayer, type ImageTilePyramid, type VisibleTile } from '../../viz-core/spatial/ImageTileLayer'
import { registerStory } from '../registry'

// A 2048×2048 full-res synthetic image, 256px tiles, 4 levels (level 3 = full-res 8×8 grid,
// level 0 = coarsest 1×1), placed 1:1 into world space (top row at world y=0).
const PYRAMID: ImageTilePyramid = {
  width: 2048,
  height: 2048,
  tileSize: 256,
  levels: 4,
  imageBounds: { left: 0, top: 0, right: 2048, bottom: 2048 },
}

// ── synthetic tile source: a labeled checkerboard per (level,x,y) as a data-URI ────────────
const tileCache = new Map<string, string>()
function checkerTileUrl(level: number, x: number, y: number): string {
  const key = `${level}-${x}-${y}`
  const cached = tileCache.get(key)
  if (cached) return cached
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  let url = ''
  if (ctx) {
    // level-tinted checkerboard so different levels read distinctly.
    const hue = (level * 67) % 360
    const a = `hsl(${hue} 55% 78%)`
    const b = `hsl(${hue} 55% 62%)`
    const cell = 32
    for (let j = 0; j < size / cell; j++) {
      for (let i = 0; i < size / cell; i++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? a : b
        ctx.fillRect(i * cell, j * cell, cell, cell)
      }
    }
    ctx.fillStyle = 'rgba(20,20,20,0.85)'
    ctx.font = 'bold 22px sans-serif'
    ctx.fillText(`L${level} ${x},${y}`, 12, 34)
    url = canvas.toDataURL('image/png')
  }
  tileCache.set(key, url)
  return url
}

// A handful of scatter points spread over the image extent (the "data" that sits above it).
const SCATTER = new Float32Array(
  [
    [256, 256],
    [1024, 512],
    [1600, 1400],
    [512, 1700],
    [1800, 300],
  ].flat(),
)

function ImageTileStory() {
  const [selection, setSelection] = useState<{ tiles: VisibleTile[]; level: number }>({
    tiles: [],
    level: PYRAMID.levels - 1,
  })

  const view = useMemo(() => new OrthographicView({ id: 'image-tile', flipY: true }), [])
  const initialViewState = useMemo<OrthographicViewState>(
    () => ({ target: [1024, 1024, 0], zoom: -1 }) as OrthographicViewState,
    [],
  )

  const onTilesChange = useCallback((tiles: VisibleTile[], level: number) => {
    setSelection({ tiles, level })
  }, [])

  // Mirror the current culled selection onto the window hook for the e2e harness.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      imageTile: {
        level: selection.level,
        visibleTiles: selection.tiles.map(t => ({ level: t.level, x: t.x, y: t.y })),
        count: selection.tiles.length,
      },
    }
  }, [selection])

  const layers = useMemo(
    () => [
      // 0) the tiled background image — FIRST so it composites UNDER the scatter.
      new ImageTileLayer({
        id: 'image-tiles',
        pyramid: PYRAMID,
        getTileUrl: checkerTileUrl,
        opacity: 1,
        onTilesChange,
      }),
      // 1) the scatter, drawn on top.
      new ScatterplotLayer({
        id: 'scatter',
        data: { length: SCATTER.length / 2, attributes: { getPosition: { value: SCATTER, size: 2 } } },
        getRadius: 14,
        radiusUnits: 'common',
        getFillColor: [220, 40, 60, 255],
        pickable: false,
      }),
    ],
    [onTilesChange],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-testid="viz-image-tile">
      <div style={{ padding: 8, opacity: 0.6 }} data-testid="image-tile-readout">
        Lazy tile pyramid (item 15) — level {selection.level}, {selection.tiles.length} tiles in
        view (fetched only for the viewport; the image never enters the point accumulator)
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DeckGL views={view} controller initialViewState={initialViewState} layers={layers} />
      </div>
    </div>
  )
}

registerStory({
  id: 'image-tile',
  category: 'View kinds',
  title: 'Image tile pyramid — lazy tiled background image (item 15)',
  covers: 'image-tile',
  Component: ImageTileStory,
})
