// annotate-workbench.story.tsx — FIXTURES-FIRST, OFFLINE. The ANNOTATION editor shown inside the
// REAL product chrome: the actual `GridWorkspace` (left `VizToolRail` incl. the "Annotate" tool, the
// per-pane `PaneToolbar`, and — once Annotate engages — the in-cell `AnnotateControls`), hosting an
// IMAGE cell backed by the in-repo synthetic `imagePixelSource` pyramid (no network, no OME-Zarr, no
// remote requests) so it runs fully offline in the gated gallery.
//
// DECLARATIVE (`<Viz option source>`) — the gap is now closed. `VizSeries` carries an optional
// `annotate?: boolean` that `parseOption` stamps onto the resolved `GridCell` (ITEM-3). So the in-grid
// annotation editor is reachable PURELY through the public declarative surface: a single
// `series: [{ id:'slide', type:'image', annotate: true }]` drives the whole workspace chrome (the left
// tool rail's Annotate tool, the pane toolbar, the in-cell AnnotateControls + class panel), and a
// `DataSource` whose `imagePixelSource()` returns the FIXTURE pyramid feeds the raster. No direct
// `GridWorkspace` mount, no `stores.gridWorkspace.hydrate` hack — `<Viz>` owns the stores/controller and
// the option is the single source of truth for the cell (incl. `annotate`).
//
// COLOR: `seedChannelsForLoader` seeds a 3-channel source as pure R/G/B, so the additive composite
// reproduces color through the declarative image path.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Viz } from '../../react/Viz'
import type { VizOption } from '../../viz-core/option/types'
import type { DataSource, DatasetCatalog, Positions } from '../../viz-core/data/wire'
import type { AnnotateStore } from '../../viz-core/annotate/Annotate.store'
import { imagePixelSource, type InMemoryPixelSource } from '../../viz-core/spatial/imageFixture'
import { registerStory } from '../registry'

const CELL_ID = 'slide'

/** A minimal, valid catalog the image cell resolves against — the pyramid itself is read from
 *  `imagePixelSource()`, so this just needs the right shape + `hasImage` + a `primary` layout. */
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

/** Capture the resolved level-0 pixel extent so the story can seed annotations in FULL-RES pixel space
 *  (INV-4) — the same space the in-grid editor draws in. */
type SlideExtent = { w: number; h: number }

/**
 * A tiny `DataSource` that exposes ONLY the in-repo FIXTURE pyramid via `imagePixelSource()`. Every other
 * bulk method rejects — none is exercised for a pure image cell (the empty `positions`/`catalog` cover
 * the ownership-inversion pull; `imageUnderlay()` rejects and the grid falls back to the pyramid path).
 * The fixture is generated once, in-process, and memoized; `onExtent` reports the level-0 dims so
 * annotations can be seeded to scale. This is exactly the minimal `DataSource` `<Viz source>` needs for
 * an image cell — and it makes ZERO network requests.
 */
function makeFixtureSource(onExtent: (e: SlideExtent) => void): DataSource {
  let loader: InMemoryPixelSource[] | null = null
  const reject = (what: string) => () =>
    Promise.reject(new Error(`annotate-workbench source: ${what} not provided (image-only demo)`))
  return {
    catalog: () => Promise.resolve(IMAGE_CATALOG),
    positions: (_layoutId: string) => Promise.resolve(EMPTY_POSITIONS),
    valueColumn: reject('valueColumn'),
    categorical: reject('categorical'),
    continuous: reject('continuous'),
    imageUnderlay: reject('imageUnderlay'),
    table: reject('table'),
    graph: reject('graph'),
    imagePixelSource: () => {
      if (!loader) {
        // A synthetic 3-channel Uint8 multiscale pyramid (1024 → 512 → 256 → 128). Fully offline.
        loader = imagePixelSource({ base: 1024, channels: 3, levels: 4 })
        const s0 = loader[0]
        onExtent({ w: s0.width, h: s0.height })
      }
      return Promise.resolve(loader)
    },
  }
}

/** Seed two demo classes + a couple of polygons (in full-res pixel space) into the cell's live
 *  `AnnotateStore` once the fixture extent is known — so the POPULATED annotation state shows. Uses
 *  the store's public `addClass` + `commitResult` actions (indistinguishable from hand-drawn). The store
 *  is the per-cell one the grid minted, reached through the `window.__vizAnnotateStores` debug seam —
 *  the story never constructs a cell or touches the grid store directly. */
function seedDemoAnnotations(store: AnnotateStore, ext: SlideExtent): void {
  const st = store.getState()
  if (st.classes.length > 0 || st.ids.length > 0) return // idempotent (StrictMode double-invoke)
  const tumor = st.addClass({ name: 'Tumor', color: [220, 40, 60] })
  const stroma = st.addClass({ name: 'Stroma', color: [40, 160, 220] })
  // Two polygons sized to ~12% of the slide, offset around center — visible at the auto-fit framing.
  // A polygon ring is a flat [x0,y0,x1,y1,…] Float64Array in full-res px (annotateModel INV-4).
  const cx = ext.w / 2
  const cy = ext.h / 2
  const r = Math.max(1, Math.min(ext.w, ext.h) * 0.12)
  const ring = (ox: number, oy: number): Float64Array =>
    new Float64Array([
      cx + ox - r, cy + oy - r,
      cx + ox + r, cy + oy - r,
      cx + ox + r, cy + oy + r,
      cx + ox - r, cy + oy + r,
    ])
  st.commitResult([
    { geometry: { kind: 'polygon', rings: [ring(-r * 1.4, 0)] }, classId: tumor, label: 'Tumor nest' },
    { geometry: { kind: 'polygon', rings: [ring(r * 1.4, 0)] }, classId: stroma, label: 'Stromal band' },
  ])
}

/** The DECLARATIVE option — a single IMAGE cell with `annotate: true`. This is the whole point: the
 *  option stamps `GridCell.annotate`, which lights up the rail's Annotate tool + the in-cell
 *  AnnotateControls class panel with no imperative store construction. */
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
        annotate: true,
        title: 'Fixture whole-slide (synthetic pyramid)',
      },
    ],
  }
}

function AnnotateWorkbench() {
  const extentRef = useRef<SlideExtent | null>(null)
  const [, setReady] = useState(false)

  const option = useMemo(() => buildOption(), [])
  const source = useMemo(
    () =>
      makeFixtureSource(e => {
        extentRef.current = e
        setReady(true)
      }),
    [],
  )

  // Once the fixture extent is known AND the grid has minted the per-cell AnnotateStore (exposed on
  // `window.__vizAnnotateStores`), seed a couple of annotations so the populated state shows. Polls
  // briefly (the store mint is async). Orthogonal to the declarative mount — it only decorates the
  // already-declaratively-created annotate cell.
  useEffect(() => {
    let alive = true
    const tick = () => {
      if (!alive) return
      const ext = extentRef.current
      const map = (window as unknown as { __vizAnnotateStores?: Map<string, AnnotateStore> })
        .__vizAnnotateStores
      const store = map?.get(CELL_ID)
      if (ext && store) {
        seedDemoAnnotations(store, ext)
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
      data-testid="viz-annotate-workbench"
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
        <strong style={{ color: 'var(--foreground, inherit)' }}>Annotation workbench</strong>
        <span>
          The annotation editor inside the real grid chrome — driven purely by a declarative series{' '}
          <code>{`[{ type: 'image', annotate: true }]`}</code>. The left tool rail (Pan / Select) ·
          per-pane toolbar · in-cell AnnotateControls (select · point · polygon · brush + class panel;
          selecting an annotation reveals its vertex handles, so reshape needs no separate mode).
          Press <strong>Annotate</strong> on the pane&rsquo;s own toolbar, then draw on the slide.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Viz
          option={option}
          source={source}
          catalog={IMAGE_CATALOG}
          positions={EMPTY_POSITIONS.positions}
          colors={new Uint8Array(0)}
          accessibleLabel="Annotation workbench"
        />
      </div>
    </div>
  )
}

registerStory({
  id: 'annotate-workbench',
  category: 'Grid + resize',
  title: 'Annotation workbench · editor in the grid chrome (fixture)',
  Component: AnnotateWorkbench,
})
