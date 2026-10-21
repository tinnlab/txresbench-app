// useGridRaster.ts — SPLIT N (ITEM-30): the grid's IMAGE / RASTER plane.
//
// DEC-26's census row "image underlays / pyramids / channel controls" (133), moved verbatim out of
// `GridWorkspace`: the flat bitmap UNDERLAY cache and its fetch effect, the Viv resolution PYRAMID
// cache and its fetch effect, the component-lifetime `imgFetchMountedRef` that keeps an in-flight
// fetch from being abandoned, the three per-channel display controls (`setImageChannel`,
// `setImageColormap`, `autoContrastChannel`), and the camera-FRAMING effect that fits a newly-loaded
// image in its pane.
//
// The framing effect is included although the census row did not name it, and the reason is the one
// this decomposition keeps re-learning: it reads `imagePyramids` AND `imageUnderlays` and nothing
// else that is state, so leaving it behind would put both caches' only remaining shell reader on the
// far side of the boundary and force them to be re-exported for one consumer.
//
// SHAPE — a value bundle (DEC-27/DEC-28, a sixth time). `imageUnderlays` / `imagePyramids` are
// already `useState`; a store would not make them state, it would add a subscription between two
// fetch effects and the deck memo that already keys on them.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `imageUnderlays`        four `setImageUnderlays` calls, all inside the underlay fetch effect,
//                           which moves. Lexical `useState`; `tsc` complete.
//   `imagePyramids`         same shape — every `setImagePyramids` is inside the pyramid fetch effect
//                           or the three channel controls, all of which move. `tsc` complete.
//   `imgFetchMountedRef`    declared here and RETURNED. It has a SECOND reader that is not in this
//                           plane: `useGridMasks` takes it as an input, because the mask fetch is the
//                           third of the three raster pulls it guards. Its OWNER changes with this
//                           split (shell → this plane) and `useGridMasks.ts`'s header note is updated
//                           to say so; the ref identity and every read are unchanged.
//   `imageUnderlaysRef` / `imagePyramidsRef`
//                           render-time mirrors, RETURNED because `useGridAnnotate` reads both (the
//                           annotate unproject needs the image extent) and the deck layer reads the
//                           pyramids through props.
//   `rects` / `insetPane` / `localStatesRef` / `seedViewStateRef`
//                           NOT moved. `insetPane` is one of DRIFT-25's seven MEASUREMENT bindings
//                           and is pinned to the shell by INV-10; `rects` is the shell's own layout
//                           state; the two camera refs are SEAM members the deck layer fills. All
//                           four are borrowed by the framing effect, which is a read, not a claim.
//   `datasetEntriesRef` / `source` / `cells`
//                           NOT moved — shell-owned, three other readers each.
//
// NO DEV WINDOW SEAM is installed from this module. Checked, not assumed.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { getChannelStats } from '@hms-dbmi/viv'
import { type RasterChannelState } from '../spatial/rasterImageLayers'
import {
  contrastMaxForDtype,
  reconcileChannelsToLoader,
  sourceForCell,
  type GridCell,
  effectiveLoaderFor,
  paneRasterPresent,
  type ImageEntry,
  type PyramidEntry,
} from './gridModel'
import type { PaneRect } from '../layers/multiView'
import type { DataSource } from '../data/wire'
import type { GridViewState } from './linkZoom'
import { toBitmapTexture } from '../layers/bitmapTexture'
import {
  frameExtent,
  imageExtentInSpace,
  overlayRefusal,
  type PaneFrame,
} from '../spatial/coordinateBinding'

export interface GridRasterInputs {
  readonly cells: readonly GridCell[]
  readonly source: DataSource
  readonly datasetEntriesRef: RefObject<Record<string, { source: DataSource | null }>>
  /** Shell-owned layout state — the framing effect needs the pane's measured rect. */
  readonly rects: readonly PaneRect[]
  /** DRIFT-25 pins this to the shell: one of INV-10's seven MEASUREMENT bindings. Borrowed. */
  readonly insetPane: (r: PaneRect) => PaneRect
  /** SEAM refs the deck layer fills (SPLIT A). Borrowed — the framing effect reads and seeds. */
  readonly localStatesRef: RefObject<Record<string, GridViewState>>
  readonly seedViewStateRef: RefObject<(cellId: string, viewState: GridViewState) => void>
  /**
   * #228 — the cell's declared frame. The framing effect needs it because the camera now lives in
   * the COORDINATE SPACE rather than in the image's pixels, and the refusal reporter needs it
   * because an un-overlaid pane has to be able to say why.
   */
  readonly cellFrame: (cell: GridCell) => PaneFrame
}

export function useGridRaster({
  cells,
  source,
  datasetEntriesRef,
  rects,
  insetPane,
  localStatesRef,
  seedViewStateRef,
  cellFrame,
}: GridRasterInputs) {
  // IMAGE cells (world2d, no points): fetch the bitmap underlay from the cell's dataset (`imageUnderlay()`)
  // and build a BitmapLayer texture, cached per cell. `'loading'` while in flight; `null` = no image /
  // failed (the pane stays an empty pannable frame — never `<Unsupported>`). The texture uploads once.
  const [imageUnderlays, setImageUnderlays] = useState<Record<string, ImageEntry | 'loading' | null>>({})
  const imageUnderlaysRef = useRef(imageUnderlays)
  imageUnderlaysRef.current = imageUnderlays
  // Re-run the fetch effect ONLY when the SET of image cells changes — NOT on every cell-store mutation
  // (a legend/style edit on any cell gives `cells` a new ref). Otherwise the effect would tear down mid
  // fetch on an unrelated edit and, because the `'loading'` reservation persists, the image would stick
  // at loading forever.
  const imageCellsKey = useMemo(
    () => cells.filter(c => c.kind === 'image').map(c => `${c.id}:${c.datasetId ?? ''}`).sort().join(','),
    [cells],
  )
  // A COMPONENT-lifetime mounted flag (not a per-effect `alive`) so an in-flight fetch always writes its
  // result — a re-run on an image-set change must not abandon a pending fetch (→ stuck `'loading'`).
  const imgFetchMountedRef = useRef(true)
  // Re-arm in the SETUP body, not just cleanup — under React.StrictMode dev double-invoke
  // (setup→cleanup→setup) a cleanup-only reset would latch the ref `false` for the component's
  // life, stranding the underlay fetch at `'loading'` (the very bug this ref guards against).
  useEffect(() => { imgFetchMountedRef.current = true; return () => { imgFetchMountedRef.current = false } }, [])
  useEffect(() => {
    const imgCells = cells.filter(c => c.kind === 'image')
    if (imgCells.length === 0) {
      setImageUnderlays(prev => (Object.keys(prev).length ? {} : prev))
      return
    }
    void (async () => {
      for (const cell of imgCells) {
        const cur = imageUnderlaysRef.current[cell.id]
        if (cur !== undefined) continue // already loading/loaded/failed
        const src = sourceForCell(cell.datasetId, source, id => datasetEntriesRef.current[id]?.source ?? null)
        if (!src) continue
        setImageUnderlays(prev => ({ ...prev, [cell.id]: 'loading' }))
        try {
          const u = await src.imageUnderlay()
          if (!imgFetchMountedRef.current) return
          setImageUnderlays(prev => ({ ...prev, [cell.id]: { texture: toBitmapTexture(u), width: u.width, height: u.height } }))
        } catch {
          if (imgFetchMountedRef.current) setImageUnderlays(prev => ({ ...prev, [cell.id]: null }))
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageCellsKey, source])
  // IMAGE cells (ITEM-1): the gigapixel-capable Viv resolution PYRAMID, fetched via the optional
  // `DataSource.imagePixelSource()` seam and cached per cell in the SAME shape as `imageUnderlays`
  // ('loading' | entry | null). When present it REPLACES the flat `BitmapLayer` at the emit site with
  // `buildRasterImageLayers` (MultiscaleImageLayer / ImageLayer); absent ⇒ the underlay fallback stays
  // byte-identical. The entry also carries the live, in-cell-EDITABLE per-channel display state (ITEM-2,
  // seeded from the loader) + the single-colormap + the dtype-sized contrast max the pane form reads.
  const [imagePyramids, setImagePyramids] = useState<Record<string, PyramidEntry | 'loading' | null>>({})
  const imagePyramidsRef = useRef(imagePyramids)
  imagePyramidsRef.current = imagePyramids
  useEffect(() => {
    const imgCells = cells.filter(c => c.kind === 'image')
    if (imgCells.length === 0) {
      setImagePyramids(prev => (Object.keys(prev).length ? {} : prev))
      return
    }
    void (async () => {
      for (const cell of imgCells) {
        if (imagePyramidsRef.current[cell.id] !== undefined) continue // already loading/loaded/failed
        const src = sourceForCell(cell.datasetId, source, id => datasetEntriesRef.current[id]?.source ?? null)
        // The pyramid path is OPT-IN per source: no `imagePixelSource` ⇒ leave this cell on the
        // `imageUnderlay()` fallback (never reserve a pyramid slot, so the emit site reads `undefined`).
        if (!src?.imagePixelSource) continue
        setImagePyramids(prev => ({ ...prev, [cell.id]: 'loading' }))
        try {
          const loader = await src.imagePixelSource()
          if (!imgFetchMountedRef.current) return
          if (loader.length === 0) {
            setImagePyramids(prev => ({ ...prev, [cell.id]: null }))
            continue
          }
          // RECONCILED, not taken verbatim: `cell.channels` is persisted per cell and can
          // outlive the loader it was seeded against (and `propagateToLinked` copies one
          // cell's array to another), so a stale count would either issue selections this
          // source refuses or leave samples it carries undisplayed (#288).
          //
          // Against the EFFECTIVE loader, not the fetched one. This array is what the pane form
          // lists and what `setImageChannel` indexes, and the LAYER is built against
          // `effectiveLoaderFor(cell, entry)` — which prefers a caller-supplied `cell.loader`.
          // Reconciling against the fetched loader alone made the two disagree whenever a cell
          // carried both: measured through the real emit path, a 2-channel `cell.loader` beside
          // a resolved 5-channel pyramid gave five rows of controls over two drawn channels,
          // three of them inert — the very defect this reconciliation exists to remove, one
          // field over.
          // ── THE WHOLE ENTRY KEYS OFF THE *EFFECTIVE* LOADER ────────────────────────────
          // `effectiveLoaderFor(cell, entry)` is `cell.loader ?? entry.loader`, so a cell that
          // carries a caller-supplied `cell.loader` is DRAWN from that one — and this entry is
          // what the per-channel editor lists, what `setImageChannel` indexes by position, and
          // what `autoContrastChannel` calls `getRaster` on. All four have to name one loader.
          //
          // An earlier cut moved only `channels` here and left `loader` and `contrastMax` on
          // the fetched pyramid, which fixed the row COUNT and opened two new seams: a `Uint16`
          // `cell.loader` beside a `Uint8` fetched pyramid gave `[0, 65535]` seeded windows
          // under `max=255` sliders (the same defect this branch fixed in `RasterImageView`),
          // and `autoContrastChannel` issued a selection past the fetched source's `'c'` axis,
          // where the refusal is swallowed by a `catch {}` and the button silently does nothing.
          //
          // With no `cell.loader` — every shipped path today — `effective` IS `loader` and
          // nothing about this entry changes.
          const effective = cell.loader ?? loader
          const channels = reconcileChannelsToLoader(cell.channels, effective)
          setImagePyramids(prev => ({
            ...prev,
            [cell.id]: {
              loader: effective,
              channels,
              colormap: cell.colormap,
              contrastMax: contrastMaxForDtype(effective[0]?.dtype),
            },
          }))
        } catch {
          if (imgFetchMountedRef.current) setImagePyramids(prev => ({ ...prev, [cell.id]: null }))
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageCellsKey, source])

  // ITEM-2: mutate ONE resolved cell's per-channel display state / colormap in place → the image layer
  // re-composites on the next render (XRLayer shader uniforms; NO tile refetch). No-ops for a cell whose
  // pyramid hasn't resolved yet.
  const setImageChannel = useCallback((cellId: string, i: number, patch: Partial<RasterChannelState>) => {
    setImagePyramids(prev => {
      const e = prev[cellId]
      if (!e || e === 'loading') return prev
      const channels = e.channels.map((c, j) => (j === i ? { ...c, ...patch } : c))
      return { ...prev, [cellId]: { ...e, channels } }
    })
  }, [])
  const setImageColormap = useCallback((cellId: string, colormap: string | undefined) => {
    setImagePyramids(prev => {
      const e = prev[cellId]
      if (!e || e === 'loading') return prev
      return { ...prev, [cellId]: { ...e, colormap } }
    })
  }, [])
  // ITEM-2 auto-contrast: read the COARSEST pyramid level (a few hundred KB, never full-res) for the
  // channel, run Viv `getChannelStats`, and set the channel's contrastLimits from it.
  const autoContrastChannel = useCallback((cellId: string, i: number) => {
    const e = imagePyramidsRef.current[cellId]
    if (!e || e === 'loading') return
    void (async () => {
      try {
        const lvl = e.loader[e.loader.length - 1] ?? e.loader[0]
        if (!lvl) return
        const raster = await lvl.getRaster({ selection: { c: i } })
        const stats = getChannelStats(raster.data as never)
        const [lo, hi] = stats.contrastLimits as [number, number]
        setImageChannel(cellId, i, { contrastLimits: [lo, hi] })
      } catch {
        // a transient tile/read error leaves the channel's manual contrast unchanged
      }
    })()
  }, [setImageChannel])

  // Once an image cell's bitmap loads, FRAME its camera on the image (center + fit-zoom) — but only if
  // the user hasn't moved it yet (no local view state). Read `localStates` through a ref so the seed runs
  // on load, not on every pan. SPLIT A: the ref is now FILLED BY `GridDeckLayer` (which owns
  // `localStates`) and reaches this effect through the seam — the read site and its semantics are
  // unchanged, only the writer moved.
  useEffect(() => {
    for (const cell of cells) {
      if (cell.kind !== 'image') continue
      if (localStatesRef.current[cell.id]) continue // already framed or user-moved
      const frame = cellFrame(cell)
      // ── DO NOT SEED ON A FRAME THAT HAS NOT BEEN READ ────────────────────────────────────
      // The seed is IDEMPOTENT-ONCE (`seedViewState` applies only where the cell has no camera),
      // and the raster fetch and the catalog pull are INDEPENDENT async effects. If the raster
      // lands first, seeding here fixes the pane in the raster's own PIXEL units forever — the
      // placed frame that arrives a moment later can no longer re-seed, so the camera frames a
      // 1400x1800 box while the contents sit in a 7000x9000 space, with nothing saying so.
      if (!frame.catalogResolved) continue
      // A raster whose declared placement this reader refuses renders nothing at all (the emit
      // site drops the cell), so there is nothing to frame and seeding a camera on it would be a
      // camera onto an empty pane at an arbitrary zoom.
      if (frame.placementError) continue
      // Prefer the pyramid loader's level-0 extent (ITEM-1) when present; else the bitmap underlay's.
      // The two are DIFFERENT grids at different scales (level 0 vs the coarsest level), which is
      // why each is placed by its own affine below rather than by a shared one.
      // The SAME rule the emit uses to choose its render path (`effectiveLoaderFor`), so the
      // camera and the layers can never pick different affines for one artifact — which for a
      // caller-supplied `cell.loader` with no fetched entry they previously could.
      const pyr = imagePyramids[cell.id]
      const effLoader = effectiveLoaderFor(cell, pyr)
      const usePyramidExtent = effLoader !== null
      // The FALLBACK path with an un-invertible served-level affine draws no raster at all (the
      // emit drops it), so there is nothing to frame. Without this the effect would take the
      // identity-pixel-extent branch below and seed a camera in PIXELS onto an empty pane — the
      // exact split-frame state the `catalogResolved` guard above exists to prevent, reached by
      // a second route once the placement errors were split per path.
      if (!usePyramidExtent && frame.levelPlacementError) continue
      let iw: number | undefined
      let ih: number | undefined
      if (effLoader) {
        const src0 = effLoader[0]
        // ── INDEXED BY THE LEVEL'S OWN AXIS LABELS, NOT BY POSITION (#159) ─────────────────
        //
        // This read used to be `shape[len-1]` for width and `shape[len-2]` for height, and it
        // was correct for every source that had ever driven it: the in-memory fixture is
        // PLANAR, `['c','y','x']`, so the last two entries really are height and width.
        //
        // A real emitted RGB raster is INTERLEAVED — `['c','y','x','_c']`, with a trailing
        // per-pixel component axis — so the positional read takes the SAMPLE COUNT (3) as the
        // image width. The pane is then framed as if the image were 3 x 1400 instead of
        // 1400 x 1800: it is zoomed on the wrong dimension, centred on the wrong point, and
        // drawn half off the edge of its own pane. Measured on a real artifact, and it throws
        // nothing — the picture is simply in the wrong place, which is the failure this whole
        // raster path is most able to hide.
        //
        // Positional indexing survives as the fallback for a source that publishes no labels,
        // which is exactly the shape the old code assumed.
        const labels = (src0?.labels ?? []) as readonly string[]
        const xAxis = labels.indexOf('x')
        const yAxis = labels.indexOf('y')
        iw = xAxis >= 0 ? src0?.shape[xAxis] : src0?.shape[src0.shape.length - 1]
        ih = yAxis >= 0 ? src0?.shape[yAxis] : src0?.shape[src0.shape.length - 2]
      } else {
        const img = imageUnderlays[cell.id]
        if (img && img !== 'loading') {
          iw = img.width
          ih = img.height
        }
      }
      if (!iw || !ih) continue
      const rect = rects.find(r => r.id === cell.id)
      const p = rect ? insetPane(rect) : null
      const pix = p ? Math.min(p.width, p.height) : 300
      // ── THE CAMERA IS IN THE COORDINATE SPACE, NOT IN PIXELS (#228 / DEC-1) ────────────────
      //
      // This used to be `target: [iw/2, ih/2, 0]` and `zoom: log2(pix / max(iw, ih))` — the
      // image's own PIXEL grid — and the effect's own comment said why that was safe: *"Both
      // share the same pixel space (identity model matrix, flipY:false), so the framing is
      // identical."* That premise is what #228 removes. The raster is now PLACED by its declared
      // `to_space` and the points render at their declared coordinates, so the frame both live in
      // is the coordinate space, and a camera left in pixels would frame the pane on a rectangle
      // 5x too small on the committed Visium fixture — the picture drawn far off the edge of its
      // own pane, which is precisely the symptom #159 spent a round on.
      //
      // The extent is taken through `imageExtentInSpace`, which maps ALL FOUR corners rather than
      // scaling the two sides, so a rotated or sheared registration frames the box that actually
      // contains the image.
      //
      // Which affine: the PYRAMID path's is the full-resolution `to_space`; the single-texture
      // path's is its served level's own grid->space map. They are different numbers for the same
      // artifact (5.0 and 20.0 on the fixture) and using one for the other is a 4x mis-frame.
      // An artifact that declares NEITHER keeps the identity extent it always had.
      const placement = usePyramidExtent ? frame.imageToSpace : frame.levelToSpace
      const extent = placement
        ? imageExtentInSpace(iw, ih, placement)
        : { minX: 0, minY: 0, maxX: iw, maxY: ih }
      const seeded = frameExtent(extent, pix)
      // `null` = a degenerate extent or an unmeasured pane. Seeding nothing leaves the pane where
      // it is, which is strictly better than a zoom derived from a zero-area box.
      if (!seeded) continue
      // SPLIT A: the seed goes through the deck layer's idempotent seam handle (it owns
      // `localStates`). Same semantics as the old direct `setLocalStates` — apply only if this cell
      // has no camera yet — with the "only if absent" rule now enforced by the owner.
      seedViewStateRef.current(cell.id, seeded)
    }
  }, [cells, imageUnderlays, imagePyramids, rects, insetPane, cellFrame])

  // ── WHY A PANE SHOWS A PICTURE AND NO POINTS (#228 / ITEM-8) ───────────────────────────────
  //
  // A refused binding is a legitimate outcome and it is INVISIBLE from the render: the pane looks
  // exactly like a pane whose overlay is broken. This repo has already chased one of those (#154's
  // "broken" colour-by, which was a locator matching nothing), so the reason is said out loud.
  //
  // Once per (cell, reason), not once per frame: the layers memo re-runs on every camera move, and
  // a warning that repeats sixty times a second is a console a user learns to scroll past — which
  // is the same as not having said it. The reason is part of the key so a cell whose situation
  // CHANGES (a dataset resolves, a layout is re-bound) says so again.
  //
  // Only for a cell that actually resolved a raster. An image cell with no image has nothing to
  // overlay and nothing to explain, and warning about it would be noise on every ordinary project.
  const reportedBindingRef = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const cell of cells) {
      if (cell.kind !== 'image') continue
      const pyr = imagePyramids[cell.id]
      const img = imageUnderlays[cell.id]
      // A pane still FETCHING has nothing to explain, and a pane with no image at all — the
      // ordinary project with an image kind offered — has nothing to overlay. Both are silent.
      const settled =
        Boolean(cell.loader?.length) ||
        (pyr != null && pyr !== 'loading') ||
        (img != null && img !== 'loading')
      if (!settled) continue
      const frame = cellFrame(cell)
      // ── REPORT THE EMIT'S VERDICT, NOT THE BINDING'S ────────────────────────────────────────
      // They are not the same. `binding` is about the two declared SPACES; the EMIT also refuses
      // a pane that resolved no raster to draw, and short-circuiting on `binding.bound` left that
      // case completely mute — a pane with neither picture nor points and no explanation, which
      // is the one outcome this reporter exists to prevent. `paneRasterPresent` is the shared
      // decision, in `gridModel` because this module and the emit may not import each other
      // (INV-10 (d)) and two copies of it would drift.
      const reason = overlayRefusal(
        frame,
        paneRasterPresent(cell, pyr, img, Boolean(frame.levelPlacementError)),
      )
      if (!reason) {
        delete reportedBindingRef.current[cell.id]
        continue
      }
      if (reportedBindingRef.current[cell.id] === reason) continue
      reportedBindingRef.current[cell.id] = reason
      console.warn(
        `[viz] image cell "${cell.id}" draws NO point overlay: ${reason} ` +
          'Points are drawn over a raster only when both artifacts declare the SAME ' +
          'coordinate_space; adjacency in a project or a run does not place one in the other.',
        { cellId: cell.id, layoutId: cell.layoutId, imageSpace: frame.imageSpace, layoutSpace: frame.layoutSpace },
      )
    }
  }, [cells, imagePyramids, imageUnderlays, cellFrame])

  return {
    imageUnderlays,
    imageUnderlaysRef,
    imagePyramids,
    imagePyramidsRef,
    imgFetchMountedRef,
    setImageChannel,
    setImageColormap,
    autoContrastChannel,
  }
}
