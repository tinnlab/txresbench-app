// in-grid-mask.story.tsx (segmentation-scale ITEM-1/2/15) — FIXTURES-FIRST, OFFLINE. The in-grid
// LABEL-MASK surface + its LIVE review/correct panel, shown inside the REAL product chrome: the actual
// `GridWorkspace` (left `VizToolRail` incl. the new "Segment" tool + the in-cell `MaskReviewControls`),
// hosting an IMAGE cell whose synthetic tissue pyramid is overlaid by a synthetic label mask.
//
// DECLARATIVE (`<Viz option source>`): a single `series: [{ type:'image', segment: true }]` stamps
// `GridCell.segment` (ITEM-3) so the mask surface + the Segment tool light up purely from the public
// option; the mask raster itself is resolved out-of-band by the `DataSource.imageLabelMask()` seam
// (ITEM-1). Press "Segment" on the PANE'S OWN toolbar → the review/correct panel docks in the internal right
// panel; toggle solo/hide (LUT only), pick a tool + Paint-as class, and click the mask to relabel /
// brush / merge / split — every edit mutates the ONE raster in place (dirty-rect sub-upload) + is undoable.

import { useMemo } from 'react'
import { Viz } from '../../react/Viz'
import type { VizOption } from '../../viz-core/option/types'
import type { DataSource, DatasetCatalog, Positions } from '../../viz-core/data/wire'
import type { LabelMaskData, LabelMaskCategoryMeta } from '../../viz-core/grid/gridModel'
import { imagePixelSource, type InMemoryPixelSource } from '../../viz-core/spatial/imageFixture'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { registerStory } from '../registry'

const CELL_ID = 'slide'
const DIM = 512 // image level-0 AND mask dims — 1:1 so the mask overlays the image with no modelMatrix.

const IMAGE_CATALOG: DatasetCatalog = {
  datasetId: 'fixture-slide',
  pointCount: 0,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary layout' }],
  valueColumns: [],
  categoricalColumns: [],
  continuousColumns: [],
  hasImage: true,
}
const EMPTY_POSITIONS: Positions = { positions: new Float32Array(0), length: 0 }

// Three named classes (with swatch colors) so the review panel + the Paint-as picker show real labels.
const MASK_CATEGORIES: LabelMaskCategoryMeta[] = [
  { code: 1, label: 'Tumor', color: [220, 40, 60] },
  { code: 2, label: 'Stroma', color: [40, 160, 220] },
  { code: 3, label: 'Immune', color: [80, 200, 120] },
]

/** Build the resolved in-grid mask from the synthetic fixture — a `Uint32Array` raster (ITEM-1 /
 *  DEC-1) sized 1:1 with the image, ~40 blobby labelled regions across 3 categories. */
function makeMask(): LabelMaskData {
  const fx = makeLabelMaskFixture({ width: DIM, height: DIM, labelCount: 40, categoryCount: 4 })
  // fixture categories are 0..3; remap so labelled ids carry a 1..3 class (0 stays background).
  const categoryForId = new Uint16Array(fx.categoryForId.length)
  for (let id = 1; id < fx.categoryForId.length; id++) {
    categoryForId[id] = (fx.categoryForId[id] % 3) + 1
  }
  return {
    raster: Uint32Array.from(fx.labelMask),
    width: fx.width,
    height: fx.height,
    categoryForId,
    categories: MASK_CATEGORIES,
  }
}

/** A minimal `DataSource` exposing ONLY the fixture image pyramid (`imagePixelSource`) + the fixture
 *  label mask (`imageLabelMask`). Every bulk method rejects — none is exercised for an image+segment
 *  cell. Zero network. The mask is generated once + memoized so re-fetches return the SAME raster ref
 *  (the in-place-edit contract depends on a stable reference). */
function makeFixtureSource(): DataSource {
  let loader: InMemoryPixelSource[] | null = null
  let mask: LabelMaskData | null = null
  const reject = (what: string) => () =>
    Promise.reject(new Error(`in-grid-mask source: ${what} not provided (image+segment demo)`))
  return {
    catalog: () => Promise.resolve(IMAGE_CATALOG),
    positions: () => Promise.resolve(EMPTY_POSITIONS),
    valueColumn: reject('valueColumn'),
    categorical: reject('categorical'),
    continuous: reject('continuous'),
    imageUnderlay: reject('imageUnderlay'),
    table: reject('table'),
    graph: reject('graph'),
    imagePixelSource: () => {
      if (!loader) loader = imagePixelSource({ base: DIM, channels: 3, levels: 3 })
      return Promise.resolve(loader)
    },
    imageLabelMask: () => {
      if (!mask) mask = makeMask()
      return mask
    },
  }
}

function buildOption(): VizOption {
  return {
    dataset: { id: 'fixture-slide' },
    grid: [{ id: CELL_ID }],
    series: [
      {
        id: CELL_ID,
        type: 'image',
        coordId: CELL_ID,
        encode: { layout: 'primary' },
        segment: true,
        title: 'Fixture slide + label mask (synthetic)',
      },
    ],
  }
}

function InGridMaskStory() {
  const option = useMemo(() => buildOption(), [])
  const source = useMemo(() => makeFixtureSource(), [])
  return (
    <div
      data-testid="viz-in-grid-mask"
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
        <strong style={{ color: 'var(--foreground, inherit)' }}>In-grid label mask</strong>
        {/* DRIFT-2.5 — at 390px the inline <code> below is a ~135px UNBREAKABLE token; as a flex
            item this span could not shrink below that min-content width, so it overflowed the
            body by 44px. `minWidth:0` lets the item shrink and `overflowWrap:anywhere` lets the
            token itself break. */}
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          A label mask rendered over the tissue IN the grid — driven by a declarative series{' '}
          <code>{`[{ type: 'image', segment: true }]`}</code>. Press <strong>Segment</strong> on the
          pane&rsquo;s own toolbar to open the live review/correct panel (hide/solo · relabel/split/merge/brush · undo).
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Viz
          option={option}
          source={source}
          catalog={IMAGE_CATALOG}
          positions={EMPTY_POSITIONS.positions}
          colors={new Uint8Array(0)}
          accessibleLabel="In-grid label mask"
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'in-grid-mask',
  category: 'Grid + resize',
  title: 'In-grid label mask · render + live review/correct (fixture)',
  Component: InGridMaskStory,
})
