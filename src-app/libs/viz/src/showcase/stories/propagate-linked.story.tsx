// propagate-linked.story.tsx (segmentation-scale Track C, ITEM-14 / ITEM-15) — FIXTURES-FIRST,
// OFFLINE. Two `segment` image cells (a montage). Link them, then "Apply contrast + palette to group"
// copies the focused cell's channels + palette to every OTHER linked cell in one action. ESC-1: a
// cell WITHOUT its own overrides is applied directly; a cell that already carries overrides is only
// overwritten after a confirm listing it. The e2e seeds tile B with an override (via the
// `__vizSeedCellDisplay` dev seam), links the tiles, hits the in-grid "Apply …" button, and asserts
// the confirm dialog appears + accepting overwrites.

import { useMemo } from 'react'
import { Viz } from '../../react/Viz'
import type { VizOption } from '../../viz-core/option/types'
import type { DataSource, DatasetCatalog, Positions } from '../../viz-core/data/wire'
import type { LabelMaskData, LabelMaskCategoryMeta } from '../../viz-core/grid/gridModel'
import { imagePixelSource, type InMemoryPixelSource } from '../../viz-core/spatial/imageFixture'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { registerStory } from '../registry'

const BASE = 384
const CELL_A = 'montA'
const CELL_B = 'montB'

const CATALOG: DatasetCatalog = {
  datasetId: 'fixture-montage',
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
]

function makeMask(): LabelMaskData {
  const fx = makeLabelMaskFixture({ width: BASE, height: BASE, labelCount: 16, categoryCount: 3 })
  const categoryForId = new Uint16Array(fx.categoryForId.length)
  for (let id = 1; id < fx.categoryForId.length; id++) categoryForId[id] = (fx.categoryForId[id] % 2) + 1
  return { raster: Uint32Array.from(fx.labelMask), width: fx.width, height: fx.height, categoryForId, categories: MASK_CATEGORIES }
}

function makeFixtureSource(): DataSource {
  let loader: InMemoryPixelSource[] | null = null
  const masks: Record<string, LabelMaskData> = {}
  const reject = (what: string) => () => Promise.reject(new Error(`montage source: ${what} not provided`))
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
      if (!loader) loader = imagePixelSource({ base: BASE, channels: 3, levels: 3 })
      return Promise.resolve(loader)
    },
    imageLabelMask: params => {
      const cellId = params?.cellId ?? CELL_A
      if (!masks[cellId]) masks[cellId] = makeMask()
      return masks[cellId]
    },
  }
}

function buildOption(): VizOption {
  return {
    dataset: { id: 'fixture-montage' },
    grid: [{ id: CELL_A }, { id: CELL_B }],
    series: [
      { id: CELL_A, type: 'image', coordId: CELL_A, encode: { layout: 'primary' }, segment: true, title: 'Core A (source)' },
      { id: CELL_B, type: 'image', coordId: CELL_B, encode: { layout: 'primary' }, segment: true, title: 'Core B' },
    ],
  }
}

interface Seams {
  __vizLinkCells?: (ids: string[]) => string
  __vizSeedCellDisplay?: (cellId: string, patch: { colormap?: string }) => void
}

function PropagateLinkedStory() {
  const option = useMemo(() => buildOption(), [])
  const source = useMemo(() => makeFixtureSource(), [])
  return (
    <div data-testid="viz-propagate-linked" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.25)', fontSize: 13,
          color: 'var(--muted-foreground, #666)', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap',
        }}
      >
        <strong style={{ color: 'var(--foreground, inherit)' }}>Propagate to linked</strong>
        <span>
          Link two cores, then <strong>Apply contrast + palette to group</strong> copies the focused
          cell's display to the rest — confirming before overwriting a core that has its own settings.
        </span>
        <button
          type="button"
          data-testid="viz-propagate-setup"
          onClick={() => {
            const w = window as unknown as Seams
            // give core B its own override so the confirm-on-overwrite path is exercised, then link.
            w.__vizSeedCellDisplay?.(CELL_B, { colormap: 'magma' })
            w.__vizLinkCells?.([CELL_A, CELL_B])
          }}
        >
          Link cores (seed B override)
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Viz option={option} source={source} catalog={CATALOG} positions={EMPTY_POSITIONS.positions} colors={new Uint8Array(0)} />
      </div>
    </div>
  )
}

registerStory({
  id: 'propagate-linked',
  category: 'Grid + resize',
  title: 'Propagate display to linked cells',
  Component: PropagateLinkedStory,
})
