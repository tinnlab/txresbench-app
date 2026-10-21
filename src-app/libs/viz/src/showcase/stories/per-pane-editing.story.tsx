// per-pane-editing.story.tsx — FIXTURES-FIRST, OFFLINE. The story that would have caught this whole
// feature's worth of defects (ITEM-19, TEST-22): TWO annotate panes and TWO segment panes, each with
// its OWN controls panel open at the same time, each POPULATED with classes + committed annotations.
//
// This is the surface the user's critique is about:
//   *"other software they edit only one image, we are working on multiple datasets, how is that even
//    equivalent — it should be like the edit form, when we click on it, it opens separate form for
//    each pane."*
//
// The shipped code bound annotate/segment to ONE hidden "active" pane (`activeAnnotateCellId` /
// `activeMaskCellId`) while the pre-existing `editCellIds` / `dataTableCellIds` surfaces were already
// per-pane `Set<paneId>`. Under the fix (ITEM-7..12) engaging a tool opens a SEPARATE panel per pane,
// each independently operable, and a press draws in the pressed pane on that SAME press (INV-13).
//
// Everything runs against the in-repo synthetic pyramid + label-mask fixtures — no network.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Viz } from '../../react/Viz'
import type { VizOption } from '../../viz-core/option/types'
import type { DataSource, DatasetCatalog, Positions } from '../../viz-core/data/wire'
import type { AnnotateStore } from '../../viz-core/annotate/Annotate.store'
import { imagePixelSource, type InMemoryPixelSource } from '../../viz-core/spatial/imageFixture'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import type { LabelMaskData, LabelMaskCategoryMeta } from '../../viz-core/grid/gridModel'
import { registerStory } from '../registry'

// Two ANNOTATE panes + two SEGMENT panes — four different "datasets" side by side.
const ANN_A = 'slide-a'
const ANN_B = 'slide-b'
const SEG_A = 'seg-a'
const SEG_B = 'seg-b'

const CATALOG: DatasetCatalog = {
  datasetId: 'fixture-multi',
  pointCount: 0,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary layout' }],
  valueColumns: [],
  categoricalColumns: [],
  continuousColumns: [],
  hasImage: true,
}

const EMPTY_POSITIONS: Positions = { positions: new Float32Array(0), length: 0 }

type SlideExtent = { w: number; h: number }

const MASK_CATEGORIES: LabelMaskCategoryMeta[] = [
  { code: 1, label: 'Tumor', color: [220, 40, 60] },
  { code: 2, label: 'Stroma', color: [40, 160, 220] },
  { code: 3, label: 'Immune', color: [80, 200, 120] },
]

/** A distinct labelled raster per segment pane (`Uint32Array`, 1:1 with the image). */
function makeMask(): LabelMaskData {
  const fx = makeLabelMaskFixture({ width: 256, height: 256, labelCount: 24, categoryCount: 4 })
  const categoryForId = new Uint16Array(fx.categoryForId.length)
  for (let id = 1; id < fx.categoryForId.length; id++) categoryForId[id] = (fx.categoryForId[id] % 3) + 1
  return {
    raster: Uint32Array.from(fx.labelMask),
    width: fx.width,
    height: fx.height,
    categoryForId,
    categories: MASK_CATEGORIES,
  }
}

/** One shared fixture `DataSource` serving all four panes. Each pane gets its OWN pyramid + mask
 *  instance (they are different datasets), which is exactly what makes per-pane isolation observable. */
function makeFixtureSource(onExtent: (e: SlideExtent) => void): DataSource {
  const loaders = new Map<string, InMemoryPixelSource[]>()
  const masks = new Map<string, LabelMaskData>()
  const reject = (what: string) => () =>
    Promise.reject(new Error(`per-pane-editing source: ${what} not provided (image-only demo)`))
  return {
    catalog: () => Promise.resolve(CATALOG),
    positions: () => Promise.resolve(EMPTY_POSITIONS),
    valueColumn: reject('valueColumn'),
    categorical: reject('categorical'),
    continuous: reject('continuous'),
    imageUnderlay: reject('imageUnderlay'),
    table: reject('table'),
    graph: reject('graph'),
    imagePixelSource: (opts?: { cellId?: string }) => {
      const key = opts?.cellId ?? ANN_A
      let l = loaders.get(key)
      if (!l) {
        // A small synthetic 3-channel pyramid per pane — four of these stay cheap and fully offline.
        l = imagePixelSource({ base: 512, channels: 3, levels: 3 })
        loaders.set(key, l)
        onExtent({ w: l[0].width, h: l[0].height })
      }
      return Promise.resolve(l)
    },
    // Each segment pane resolves its OWN label mask (a DISTINCT raster instance), so a correction in
    // one pane is provably not a correction in the other. Memoized per cell id: the in-place-edit
    // contract requires a stable raster reference across re-fetches.
    imageLabelMask: (opts?: { cellId?: string }) => {
      const key = opts?.cellId ?? SEG_A
      let m = masks.get(key)
      if (!m) {
        m = makeMask()
        masks.set(key, m)
      }
      return m
    },
  } as unknown as DataSource
}

/** Seed a pane's OWN class vocabulary + committed geometry. Deliberately DIFFERENT per pane — the
 *  populated two-pane render is the artifact that exposes leakage between panes. */
function seedPane(store: AnnotateStore, ext: SlideExtent, which: 'a' | 'b'): void {
  const st = store.getState()
  if (st.classes.length > 0 || st.ids.length > 0) return // idempotent under StrictMode
  const cx = ext.w / 2
  const cy = ext.h / 2
  const r = Math.max(1, Math.min(ext.w, ext.h) * 0.15)
  const ring = (ox: number): Float64Array =>
    new Float64Array([cx + ox - r, cy - r, cx + ox + r, cy - r, cx + ox + r, cy + r, cx + ox - r, cy + r])
  if (which === 'a') {
    const tumor = st.addClass({ name: 'Tumor', color: [220, 40, 60] })
    st.commitResult([{ geometry: { kind: 'polygon', rings: [ring(0)] }, classId: tumor, label: 'Tumor nest' }])
  } else {
    // A DIFFERENT vocabulary — pane B knows nothing about pane A's classes (INV-11 as amended).
    const stroma = st.addClass({ name: 'Stroma', color: [40, 160, 220] })
    const immune = st.addClass({ name: 'Immune', color: [250, 200, 60] })
    st.commitResult([
      { geometry: { kind: 'polygon', rings: [ring(-r * 0.6)] }, classId: stroma, label: 'Stromal band' },
      { geometry: { kind: 'polygon', rings: [ring(r * 0.9)] }, classId: immune, label: 'Immune front' },
    ])
  }
}

/** Four cells: two `annotate`, two `segment` — all declarative, no imperative grid construction. */
function buildOption(): VizOption {
  return {
    dataset: { id: 'fixture-multi' },
    grid: [{ id: ANN_A }, { id: ANN_B }, { id: SEG_A }, { id: SEG_B }],
    series: [
      { id: ANN_A, type: 'image', coordId: ANN_A, encode: { layout: 'primary' }, annotate: true, title: 'Slide A' },
      { id: ANN_B, type: 'image', coordId: ANN_B, encode: { layout: 'primary' }, annotate: true, title: 'Slide B' },
      { id: SEG_A, type: 'image', coordId: SEG_A, encode: { layout: 'primary' }, segment: true, title: 'Segment A' },
      { id: SEG_B, type: 'image', coordId: SEG_B, encode: { layout: 'primary' }, segment: true, title: 'Segment B' },
    ],
  }
}

function PerPaneEditing() {
  const extentRef = useRef<SlideExtent | null>(null)
  const [, setReady] = useState(false)
  // ITEM-16 — what the host received from the seed export (proves the payload is real, not a stub).
  const [seeds, setSeeds] = useState<{
    paneId: string
    count: number
    first: [number, number] | null
  } | null>(null)

  const option = useMemo(() => buildOption(), [])
  const source = useMemo(
    () =>
      makeFixtureSource(e => {
        extentRef.current = e
        setReady(true)
      }),
    [],
  )

  // Seed BOTH annotate panes with their own (different) classes + geometry once the grid has minted
  // their per-cell stores. A populated render is required by the UI-surface checklist — an empty
  // two-pane render hides exactly the layout/leakage bugs this story exists to catch.
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (!alive) return
      const ext = extentRef.current
      const map = (window as unknown as { __vizAnnotateStores?: Map<string, AnnotateStore> }).__vizAnnotateStores
      const a = map?.get(ANN_A)
      const b = map?.get(ANN_B)
      if (ext && a && b) {
        seedPane(a, ext, 'a')
        seedPane(b, ext, 'b')
        return
      }
      window.setTimeout(tick, 400)
    }
    const t = window.setTimeout(tick, 800)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [])

  return (
    <div
      data-testid="viz-per-pane-editing"
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
        <strong style={{ color: 'var(--foreground, inherit)' }}>Per-pane editing</strong>
        <span>
          Four panes = four datasets. Press <strong>Annotate</strong> (or <strong>Segment</strong>) on
          a PANE&rsquo;S OWN toolbar — beside Edit — and THAT pane opens its own controls panel: its own
          tool, its own classes, its own hierarchy, its own undo. Open one, two or all four; the others
          are untouched. Pressing in a pane draws in <em>that</em> pane on the same press; nothing is
          consumed to &ldquo;focus&rdquo; it first.
        </span>
      </div>
      {/* ITEM-16 — a HOST wiring of the seed export. The counted points leave the editor as
          `ProcessorPort` GeoFeatures; a real host would hand them to a segmenter, so the readout
          below shows exactly what it received (which pane, how many, and the first coordinate). */}
      {seeds && (
        <div
          data-testid="ppe-seeds"
          data-pane={seeds.paneId}
          data-count={String(seeds.count)}
          style={{ padding: '6px 10px', fontSize: 12, borderBottom: '1px solid rgba(128,128,128,0.25)' }}
        >
          Seeds from <strong>{seeds.paneId}</strong>: {seeds.count} point
          {seeds.count === 1 ? '' : 's'}
          {seeds.first ? ` · first @ ${seeds.first[0]}, ${seeds.first[1]}` : ''}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Viz
          option={option}
          source={source}
          catalog={CATALOG}
          positions={EMPTY_POSITIONS.positions}
          colors={new Uint8Array(0)}
          accessibleLabel="Per-pane editing"
          onAnnotateExportSeeds={(paneId, features) =>
            setSeeds({
              paneId,
              count: features.length,
              first:
                features[0] && features[0].geometry.kind === 'point'
                  ? [
                      Math.round(features[0].geometry.xy[0]),
                      Math.round(features[0].geometry.xy[1]),
                    ]
                  : null,
            })
          }
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'per-pane-editing',
  category: 'Grid + resize',
  title: 'Per-pane editing · two annotate + two segment panes, all open at once',
  Component: PerPaneEditing,
})
