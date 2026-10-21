// spatial-binding.story.tsx — #228: the image<->coordinates BINDING, and its REFUSAL.
//
// The two render states this item adds to the grid's dense `image` pane, side by side and
// switchable, because they are indistinguishable from a defect unless you can see both:
//
//   BOUND    — the raster and the layout declare the SAME `coordinate_space`, so the spots are
//              drawn on the tissue at the declared transform (design §7.5: *"A human sees a
//              misregistration instantly and sees nothing else about it."*).
//   REFUSED  — they declare DIFFERENT spaces. The picture is drawn; the points are NOT. §4
//              refuses binding by artifact adjacency by name, so "they are both in this project"
//              is not a reason to overlay one on the other.
//
// The numbers are the REAL emitted Visium ones (`viz-core/spatial/fixtures`): a placement of
// `to_space = [5,0,0,0,5,0]` over a 1400x1800 emitted grid, i.e. a 7000x9000 coordinate space,
// and 10x's own 160 spot positions in full-resolution pixels. The PIXELS are synthesized here
// (a soft blob plus a ruled grid) precisely so a misregistration is legible: under the
// pre-#228 identity placement every one of those 160 spots falls outside the picture.

import { useEffect, useMemo, useState } from 'react'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import type {
  CategoricalColumn,
  ContinuousColumn,
  DataSource,
  DatasetCatalog,
  DataTable,
  GraphData,
  ImageUnderlay,
  Positions,
  SparseColumn,
} from '../../viz-core/data/wire'
import { registerStory } from '../registry'
import VENDOR from '../../viz-core/spatial/fixtures/vendor-spot-positions.json'

/** The space the emitted artifacts of this section declare. */
const SPACE = 'visium:Visium_Mouse_Olfactory_Bulb'
/** A DIFFERENT section's space — same project, same run, different frame. */
const OTHER_SPACE = 'visium:Visium_Mouse_Olfactory_Bulb__sectionB'

/** The served level, matching the real fixture's coarsest level. */
const LEVEL_W = 350
const LEVEL_H = 450
/** space -> level pixels, as `omeTiffUnderlay.underlayAffine([5,0,0,0,5,0], [4,4])` produces. */
const LEVEL_AFFINE = [0.05, 0, 0, 0, 0.05, 0] as const
/** level 0 -> space: the producer's own `to_space`. */
const TO_SPACE = [5, 0, 0, 0, 5, 0] as const

const SPOTS = VENDOR.spots as { x: number; y: number; in_tissue: number }[]

/** A legible stand-in for tissue: a soft blob under a ruled grid, so a shift of any size shows. */
function tissueTexture(): Uint8Array {
  const out = new Uint8Array(LEVEL_W * LEVEL_H * 4)
  // the real spot cloud's centre, expressed in this level's pixels, so the blob sits under it
  const cx = (SPOTS.reduce((s, p) => s + p.x, 0) / SPOTS.length) * LEVEL_AFFINE[0]
  const cy = (SPOTS.reduce((s, p) => s + p.y, 0) / SPOTS.length) * LEVEL_AFFINE[0]
  for (let y = 0; y < LEVEL_H; y++) {
    for (let x = 0; x < LEVEL_W; x++) {
      const d = Math.hypot(x - cx, y - cy) / 70
      const blob = Math.max(0, 1 - d * d)
      const rule = x % 25 === 0 || y % 25 === 0 ? 0.82 : 1
      const i = (y * LEVEL_W + x) * 4
      out[i] = Math.round(255 * rule * (1 - 0.35 * blob))
      out[i + 1] = Math.round(255 * rule * (1 - 0.62 * blob))
      out[i + 2] = Math.round(255 * rule * (1 - 0.45 * blob))
      out[i + 3] = 255
    }
  }
  return out
}

const reject = (what: string) => () => Promise.reject(new Error(`${what} is not part of this story`))

/** A source declaring ONE raster and ONE spot layout, whose FRAMES the story toggles. */
function makeSource(layoutSpace: string): DataSource {
  const positions = new Float32Array(SPOTS.length * 2)
  SPOTS.forEach((s, i) => {
    positions[i * 2] = s.x
    positions[i * 2 + 1] = s.y
  })
  return {
    async catalog(): Promise<DatasetCatalog> {
      return {
        datasetId: 'section',
        pointCount: SPOTS.length,
        layouts: [
          {
            id: 'spots',
            kind: 'layout',
            label: 'Spot positions',
            space: layoutSpace,
            // §6.6 requires a placement on the coordinates artifact too, and the binding refuses
            // a layout that names a space without saying where in it its numbers sit. A Visium
            // import states its coordinates IN the space, so this is identity — declared, not
            // assumed.
            toSpace: [1, 0, 0, 0, 1, 0],
          },
        ],
        valueColumns: [],
        categoricalColumns: [],
        continuousColumns: [],
        hasImage: true,
        image: {
          width: LEVEL_W,
          height: LEVEL_H,
          channels: 4,
          affine: LEVEL_AFFINE,
          space: SPACE,
          toSpace: TO_SPACE,
        },
      }
    },
    async positions(): Promise<Positions> {
      return { positions, length: SPOTS.length }
    },
    async imageUnderlay(): Promise<ImageUnderlay> {
      return { data: tissueTexture(), width: LEVEL_W, height: LEVEL_H, channels: 4, affine: LEVEL_AFFINE }
    },
    valueColumn: reject('valueColumn') as unknown as DataSource['valueColumn'],
    categorical: reject('categorical') as unknown as () => Promise<CategoricalColumn>,
    continuous: reject('continuous') as unknown as () => Promise<ContinuousColumn>,
    table: reject('table') as unknown as () => Promise<DataTable>,
    graph: reject('graph') as unknown as () => Promise<GraphData>,
  } as unknown as DataSource
}

function SpatialBindingStory() {
  // ISOLATED store set, never the module singletons — this story seeds grid cells, and on the
  // singletons those writes are process-global for every story mounted later in the same page.
  const stores = useMemo(() => createVizStores(), [])
  const [bound, setBound] = useState(true)
  const source = useMemo(() => makeSource(bound ? SPACE : OTHER_SPACE), [bound])
  const [colors, setColors] = useState<Uint8Array | null>(null)

  useEffect(() => {
    stores.gridWorkspace.getState().reset()
    stores.gridWorkspace.getState().setCellKind(INITIAL_CELL_ID, 'image')
  }, [stores])

  useEffect(() => {
    // in_tissue paints the spots, so the overlay carries real per-spot information rather than
    // being one undifferentiated dot cloud
    const c = new Uint8Array(SPOTS.length * 4)
    SPOTS.forEach((s, i) => {
      const [r, g, b] = s.in_tissue ? [220, 30, 70] : [60, 110, 220]
      c.set([r, g, b, 255], i * 4)
    })
    setColors(c)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }} data-testid="viz-spatial-binding">
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* native-control-ok: @ziee/viz is framework-agnostic by rule (deck.gl + math.gl + viv,
            no @ziee/kit), so a story here has no kit Button to reach for. */}
        <button
          type="button"
          data-testid="viz-spatial-binding-toggle"
          onClick={() => setBound(v => !v)}
        >
          {bound ? 'Break the frame (declare a different space)' : 'Restore the frame'}
        </button>
        <span style={{ opacity: 0.7, fontSize: 12 }} data-testid="viz-spatial-binding-state">
          raster: <code>{SPACE}</code> · layout: <code>{bound ? SPACE : OTHER_SPACE}</code> ·{' '}
          {bound ? 'BOUND — 160 spots on the tissue' : 'REFUSED — the picture, and no points'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <VizStoresProvider value={stores}>
          <GridWorkspace source={source} colors={colors ?? undefined} radius={6} />
        </VizStoresProvider>
      </div>
    </div>
  )
}

registerStory({
  id: 'spatial-binding',
  category: 'View kinds',
  title: 'Spatial binding — spots on tissue, and the refusal when the frames differ',
  covers: 'spatial-binding',
  Component: SpatialBindingStory,
})
