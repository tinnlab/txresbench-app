// ImageTileLayer.tsx — a LAZY TILED BACKGROUND IMAGE layer (STREAMING_PROGRESSIVE_PLAN.md
// item 15). A big spatial image (tissue image, segmentation mask, …) that must NEVER enter
// the point accumulator renders instead as a viewport-culled TILE PYRAMID composited UNDER
// the scatter/raster. deck.gl's own `TileLayer` lives in `@deck.gl/geo-layers`, which is NOT
// a dependency of this package (see package.json) and MUST NOT be added — so this is a
// hand-rolled equivalent: a `CompositeLayer` that reads the current `OrthographicView`
// viewport from deck's layer context, runs the pure `selectImageTiles` cull, and renders one
// `BitmapLayer` per visible tile (a `getTileUrl(level,x,y)` string → deck fetches the tile
// lazily). Only viewport-intersecting tiles at the zoom-matched level are ever fetched, so
// cost decouples from the image's gigapixel size.
//
// Two entry points:
//   • `ImageTileLayer` — the drop-in deck CompositeLayer. Put it BEFORE the scatter/raster
//     layers in the `layers` array so it draws beneath them (deck paints array order, first =
//     bottom). It self-culls from `this.context.viewport` every render.
//   • `buildImageTileLayers` — the same tile→BitmapLayer expansion but for an EXPLICIT
//     viewport + zoom (no layer context), for callers that already track the OrthographicView
//     pose in React state (mirrors how RasterUnderlayScatterView composes BitmapLayers).
//
// Framework-agnostic (viz-core): depends only on @deck.gl/* + the pure `imageTiles` math —
// no @ziee/*, no React state, no DOM. Generic naming (image / tile / level — DEC-28), no SVG.

import { CompositeLayer, type Layer, type LayersList } from '@deck.gl/core'
import { BitmapLayer } from '@deck.gl/layers'
import type { DensityBounds } from '../density/densityBin'
import {
  selectImageTiles,
  levelForImageZoom,
  type ImageTilePyramid,
  type VisibleTile,
} from './imageTiles'

/** Resolve a tile's fetch URL from its pyramid coordinate. */
export type GetTileUrl = (level: number, x: number, y: number) => string

export interface ImageTileLayerProps {
  /** stable layer id (also the sub-layer id prefix). */
  id?: string
  /** the tiled image pyramid (full-res dims, tileSize, levels, world placement). */
  pyramid: ImageTilePyramid
  /** resolve a `(level,x,y)` tile to a URL/data-URI string; deck fetches it lazily. */
  getTileUrl: GetTileUrl
  /** overall layer opacity (0–1, default 1). */
  opacity?: number
  /**
   * OPTIONAL observer fired whenever the selected tile set CHANGES (level or membership) —
   * for test harnesses / debug HUDs. NOT a data path; the render doesn't depend on it.
   */
  onTilesChange?: (tiles: VisibleTile[], level: number) => void
}

/** Stable signature of a tile selection, to fire `onTilesChange` only on real change. */
function selectionKey(level: number, tiles: readonly VisibleTile[]): string {
  let s = `${level}|`
  for (const t of tiles) s += `${t.x},${t.y};`
  return s
}

/**
 * A viewport-culled lazy tile-pyramid background image, as a deck.gl CompositeLayer. Reads the
 * active OrthographicView viewport from layer context (`getBounds()` + `zoom`), selects the
 * zoom-matched level's visible tiles, and renders a `BitmapLayer` per tile.
 */
export class ImageTileLayer extends CompositeLayer<ImageTileLayerProps> {
  static layerName = 'ImageTileLayer'

  renderLayers(): LayersList {
    const { viewport } = this.context
    const { pyramid, getTileUrl, opacity = 1 } = this.props

    // Viewport → world rectangle. `getBounds()` returns [minX, minY, maxX, maxY].
    const [minX, minY, maxX, maxY] = viewport.getBounds()
    const view: DensityBounds = { minX, minY, maxX, maxY }
    const zoom = viewport.zoom

    const tiles = selectImageTiles(view, zoom, pyramid)
    const level = levelForImageZoom(pyramid, zoom)

    // Fire the change observer once per real selection change (guarded via a cached key on
    // layer state, so panning within the same tile set doesn't spam it).
    if (this.props.onTilesChange) {
      const key = selectionKey(level, tiles)
      const prev = (this.state as { selKey?: string } | undefined)?.selKey
      if (key !== prev) {
        this.setState({ selKey: key })
        this.props.onTilesChange(tiles, level)
      }
    }

    return tiles.map(
      t =>
        new BitmapLayer(
          this.getSubLayerProps({
            id: `tile-${t.level}-${t.x}-${t.y}`,
            image: getTileUrl(t.level, t.x, t.y),
            bounds: t.worldBounds as [number, number, number, number],
            opacity,
          }),
        ),
    )
  }
}

export interface BuildImageTileLayersParams {
  pyramid: ImageTilePyramid
  getTileUrl: GetTileUrl
  /** the world rectangle currently visible (e.g. from `viewportWorldBounds`). */
  viewport: DensityBounds
  /** deck OrthographicView zoom (log₂ pixels-per-world). */
  zoom: number
  /** overall opacity (default 1). */
  opacity?: number
  /** id prefix for the produced BitmapLayers (default `"image-tile"`). */
  idPrefix?: string
}

/**
 * Expand the visible tiles for an EXPLICIT viewport + zoom into `BitmapLayer[]` — the
 * no-layer-context sibling of {@link ImageTileLayer}, for callers already tracking the camera
 * in state. Returns one lazily-fetched BitmapLayer per viewport-intersecting tile; place them
 * before the point layers so they composite underneath.
 */
export function buildImageTileLayers(params: BuildImageTileLayersParams): Layer[] {
  const { pyramid, getTileUrl, viewport, zoom, opacity = 1, idPrefix = 'image-tile' } = params
  const tiles = selectImageTiles(viewport, zoom, pyramid)
  return tiles.map(
    t =>
      new BitmapLayer({
        id: `${idPrefix}-${t.level}-${t.x}-${t.y}`,
        image: getTileUrl(t.level, t.x, t.y),
        bounds: t.worldBounds as [number, number, number, number],
        opacity,
      }),
  )
}

export type { ImageTilePyramid, ImageWorldBounds, VisibleTile } from './imageTiles'
export { selectImageTiles, levelForImageZoom } from './imageTiles'
