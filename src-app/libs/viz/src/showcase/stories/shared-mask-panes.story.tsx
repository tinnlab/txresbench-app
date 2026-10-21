// shared-mask-panes.story.tsx (segmentation-scale Track A, ITEM-4..7 / ITEM-15) — FIXTURES-FIRST,
// OFFLINE. Two `segment` cells that are the LEFT and RIGHT tiles of ONE whole-slide image in world
// space. Linking them and hitting "Share mask across group" (ESC-3, explicit) promotes both to a
// SINGLE workspace-owned label raster (INV-8): a brush dragged across the pane seam paints continuously
// and ONE undo reverts it in both panes. Detach reverts each tile to its own per-cell mask.
//
// Everything runs inside the REAL `GridWorkspace` chrome; the shared-mask attach button appears in the
// in-grid mask panel when the focused cell is in a link group with ≥2 segment members. The e2e drives
// the seam-crossing stroke through the live shared controller (`window.__vizSharedMasks`), exactly as
// the in-grid story drives `window.__vizMaskSessions`.

import { useMemo } from 'react'
import { Viz } from '../../react/Viz'
import type { VizOption } from '../../viz-core/option/types'
import type { DataSource, DatasetCatalog, Positions } from '../../viz-core/data/wire'
import type { LabelMaskData, LabelMaskCategoryMeta } from '../../viz-core/grid/gridModel'
import { imagePixelSource, type InMemoryPixelSource } from '../../viz-core/spatial/imageFixture'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { registerStory } from '../registry'

const TILE = 384 // each tile's image + mask dim; two tiles ⇒ a 768-wide world image.
const TILE_A = 'tileA'
const TILE_B = 'tileB'

const CATALOG: DatasetCatalog = {
  datasetId: 'fixture-wsi',
  pointCount: 0,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary layout' }],
  valueColumns: [],
  categoricalColumns: [],
  continuousColumns: [],
  hasImage: true,
}
const EMPTY_POSITIONS: Positions = { positions: new Float32Array(0), length: 0 }

const MASK_CATEGORIES: LabelMaskCategoryMeta[] = [
  { code: 1, label: 'Tumor', color: [220, 40, 60] },
  { code: 2, label: 'Stroma', color: [40, 160, 220] },
  { code: 3, label: 'Immune', color: [80, 200, 120] },
]

/** A tile mask placed in world space by a translate `modelMatrix` (column-major): tile A at world
 *  x∈[0,384], tile B at world x∈[384,768]. Sharing unions these into a 768-wide world raster. */
function makeTileMask(worldOffsetX: number): LabelMaskData {
  const fx = makeLabelMaskFixture({ width: TILE, height: TILE, labelCount: 24, categoryCount: 4 })
  const categoryForId = new Uint16Array(fx.categoryForId.length)
  for (let id = 1; id < fx.categoryForId.length; id++) categoryForId[id] = (fx.categoryForId[id] % 3) + 1
  return {
    raster: Uint32Array.from(fx.labelMask),
    width: fx.width,
    height: fx.height,
    categoryForId,
    categories: MASK_CATEGORIES,
    // scale 1 (world unit == pixel), translate x by the tile's world offset.
    modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, worldOffsetX, 0, 0, 1],
  }
}

function makeFixtureSource(): DataSource {
  let loader: InMemoryPixelSource[] | null = null
  const masks: Record<string, LabelMaskData> = {}
  const reject = (what: string) => () =>
    Promise.reject(new Error(`shared-mask source: ${what} not provided (WSI-tiles demo)`))
  return {
    catalog: () => Promise.resolve(CATALOG),
    positions: () => Promise.resolve(EMPTY_POSITIONS),
    valueColumn: reject('valueColumn'),
    categorical: reject('categorical'),
    continuous: reject('continuous'),
    imageUnderlay: reject('imageUnderlay'),
    table: reject('table'),
    graph: reject('graph'),
    imagePixelSource: () => {
      if (!loader) loader = imagePixelSource({ base: TILE, channels: 3, levels: 3 })
      return Promise.resolve(loader)
    },
    imageLabelMask: params => {
      const cellId = params?.cellId ?? TILE_A
      if (!masks[cellId]) masks[cellId] = makeTileMask(cellId === TILE_B ? TILE : 0)
      return masks[cellId]
    },
  }
}

function buildOption(): VizOption {
  return {
    dataset: { id: 'fixture-wsi' },
    grid: [{ id: TILE_A }, { id: TILE_B }],
    series: [
      { id: TILE_A, type: 'image', coordId: TILE_A, encode: { layout: 'primary' }, segment: true, title: 'WSI tile A (left)' },
      { id: TILE_B, type: 'image', coordId: TILE_B, encode: { layout: 'primary' }, segment: true, title: 'WSI tile B (right)' },
    ],
  }
}

function SharedMaskPanesStory() {
  const option = useMemo(() => buildOption(), [])
  const source = useMemo(() => makeFixtureSource(), [])
  return (
    <div
      data-testid="viz-shared-mask-panes"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid rgba(128,128,128,0.25)',
          fontSize: 13,
          color: 'var(--muted-foreground, #666)',
          display: 'flex',
          gap: 10,
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ color: 'var(--foreground, inherit)' }}>Shared mask across panes</strong>
        <span>
          Two <strong>segment</strong> tiles of one slide. Link them, then{' '}
          <strong>Share mask across group</strong> — a brush dragged across the seam paints ONE
          world-space raster in both panes; one undo reverts it everywhere.
        </span>
        <button
          type="button"
          data-testid="viz-shared-mask-link-tiles"
          onClick={() => {
            const w = window as unknown as { __vizLinkCells?: (ids: string[]) => string }
            w.__vizLinkCells?.([TILE_A, TILE_B])
          }}
        >
          Link tiles
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Viz
          option={option}
          source={source}
          catalog={CATALOG}
          positions={EMPTY_POSITIONS.positions}
          colors={new Uint8Array(0)}
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'shared-mask-panes',
  category: 'Grid + resize',
  title: 'Shared mask across panes (tiled WSI)',
  Component: SharedMaskPanesStory,
})
