// hierarchy-tree.story.tsx — FIXTURES-FIRST, OFFLINE (ITEM-11 / ITEM-15). The QuPath-grade object
// HIERARCHY inside the real product chrome: the actual `GridWorkspace` hosting an IMAGE cell with a
// seeded tissue → region → cell tree, so the in-cell `AnnotateHierarchyPanel` (tree + level picker +
// show-only-this-level filter + "Resolve hierarchy" with a determinate readout + select-in-tree ↔
// select-on-canvas) renders over a POPULATED 3-level forest. Fully offline (synthetic pyramid).
//
// DECLARATIVE: a single `series: [{ type:'image', annotate: true }]` lights up the annotate dock
// (tool rail Annotate tool + the AnnotateControls + the hierarchy panel). The tree is seeded into the
// cell's live `AnnotateStore` (levels + level-tagged, parented polygons) via the same
// `window.__vizAnnotateStores` debug seam the annotate-workbench story uses.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Viz } from '../../react/Viz'
import type { VizOption } from '../../viz-core/option/types'
import type { DataSource, DatasetCatalog, Positions } from '../../viz-core/data/wire'
import type { AnnotateStore, AddAnnotationInput } from '../../viz-core/annotate/Annotate.store'
import { imagePixelSource, type InMemoryPixelSource } from '../../viz-core/spatial/imageFixture'
import { registerStory } from '../registry'

const CELL_ID = 'slide'

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
type SlideExtent = { w: number; h: number }

function makeFixtureSource(onExtent: (e: SlideExtent) => void): DataSource {
  let loader: InMemoryPixelSource[] | null = null
  const reject = (what: string) => () =>
    Promise.reject(new Error(`hierarchy-tree source: ${what} not provided (image-only demo)`))
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
      if (!loader) {
        loader = imagePixelSource({ base: 1024, channels: 3, levels: 4 })
        onExtent({ w: loader[0].width, h: loader[0].height })
      }
      return Promise.resolve(loader)
    },
  }
}

/** A flat square ring [x0,y0,…] in full-res px (INV-4). */
function square(cx: number, cy: number, half: number): Float64Array {
  return new Float64Array([cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half])
}

/**
 * Seed a 3-level tissue → region → cell forest (dozens of objects): 1 tissue, 3 regions, several
 * cells per region — with `level` + `parentId` set so the tree renders POPULATED and containment
 * "Resolve hierarchy" is a no-op re-confirm (already correctly parented). Idempotent.
 */
function seedHierarchy(store: AnnotateStore, ext: SlideExtent): void {
  const st = store.getState()
  if (st.ids.length > 0) return
  st.setLevels(['tissue', 'region', 'cell'])
  const tumor = st.addClass({ name: 'Tumor', color: [220, 40, 60] })
  const stroma = st.addClass({ name: 'Stroma', color: [40, 160, 220] })
  const W = ext.w
  const H = ext.h
  const tissueId = 'tissue-1'
  const inputs: AddAnnotationInput[] = [
    { id: tissueId, geometry: { kind: 'polygon', rings: [square(W / 2, H / 2, Math.min(W, H) * 0.46)] }, classId: stroma, label: 'Tissue', level: 'tissue' },
  ]
  // 3 regions across the slide, each with 4 cells.
  const regionCx = [W * 0.3, W * 0.5, W * 0.7]
  regionCx.forEach((rx, ri) => {
    const ry = H * (0.35 + 0.12 * (ri % 2))
    const rHalf = Math.min(W, H) * 0.12
    const regionId = `region-${ri + 1}`
    inputs.push({
      id: regionId,
      geometry: { kind: 'polygon', rings: [square(rx, ry, rHalf)] },
      classId: ri === 1 ? tumor : stroma,
      label: `Region ${ri + 1}`,
      level: 'region',
      parentId: tissueId,
    })
    for (let ci = 0; ci < 4; ci++) {
      const ox = (ci % 2 === 0 ? -1 : 1) * rHalf * 0.45
      const oy = (ci < 2 ? -1 : 1) * rHalf * 0.45
      inputs.push({
        id: `cell-${ri + 1}-${ci + 1}`,
        geometry: { kind: 'polygon', rings: [square(rx + ox, ry + oy, rHalf * 0.22)] },
        classId: tumor,
        label: `Cell ${ri + 1}.${ci + 1}`,
        level: 'cell',
        parentId: regionId,
      })
    }
  })
  st.commitResult(inputs)
}

function buildOption(): VizOption {
  return {
    dataset: { id: 'fixture-slide' },
    grid: [{ id: CELL_ID }],
    series: [
      { id: CELL_ID, type: 'image', coordId: CELL_ID, encode: { layout: 'primary' }, annotate: true, title: 'Tissue with nested regions + cells' },
    ],
  }
}

function HierarchyTreeStory() {
  const extentRef = useRef<SlideExtent | null>(null)
  const [, setReady] = useState(false)
  const option = useMemo(() => buildOption(), [])
  const source = useMemo(
    () => makeFixtureSource(e => {
      extentRef.current = e
      setReady(true)
    }),
    [],
  )

  useEffect(() => {
    let alive = true
    const tick = () => {
      if (!alive) return
      const ext = extentRef.current
      const map = (window as unknown as { __vizAnnotateStores?: Map<string, AnnotateStore> }).__vizAnnotateStores
      const store = map?.get(CELL_ID)
      if (ext && store) {
        seedHierarchy(store, ext)
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
    <div data-testid="viz-hierarchy-tree-story" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.25)', fontSize: 13, color: 'var(--muted-foreground, #666)', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--foreground, inherit)' }}>Object hierarchy</strong>
        <span>
          A QuPath-grade tissue → region → cell tree over the slide. Press <strong>Annotate</strong> on the
          pane&rsquo;s own toolbar to reveal the hierarchy panel: pick a <strong>level</strong> to filter, collapse a subtree,
          click a node to highlight it on the slide, and <strong>Resolve hierarchy</strong> to re-parent by
          containment.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Viz
          option={option}
          source={source}
          catalog={IMAGE_CATALOG}
          positions={EMPTY_POSITIONS.positions}
          colors={new Uint8Array(0)}
          accessibleLabel="Object hierarchy"
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'hierarchy-tree',
  category: 'Grid + resize',
  title: 'Object hierarchy · tissue→region→cell tree (fixture)',
  Component: HierarchyTreeStory,
})
