// useGridMasks.ts — SPLIT G (ITEM-23): the grid's MASK / SEGMENTATION authoring plane.
//
// The label-mask subsystem, moved verbatim out of `GridWorkspace`: the `imageLabelMask()` fetch and
// its two resolvers (`resolvedLabelMask` / `maskReady`), the segment-dock bindings, the per-cell
// `MaskCorrectController` sessions, the cross-cell `SharedLabelMask` controllers, and the review
// state the label-mask LAYER builder reads. It is an authoring subsystem, not a render layer: it
// mounts nothing, so INV-10 (a) still names exactly five layer files and INV-10 (d)'s layer-pair
// matrix is untouched (this module imports no layer, and no layer imports it).
//
// It RETURNS a bundle rather than writing a store, because unlike the coloring plane its outputs
// have four different consumers with four different lifetimes — the deck's `layersAfter` builder,
// the dock layer, the overlay layer and the pane toolbar — and the `paneDocks` store already owns
// the two pieces that genuinely wanted store ownership (`maskReview`, the open set). Nothing
// returned changes per FRAME (DEC-20 is about the ITEM-14 seam, which this does not touch).
//
// Writer-set completeness: every state moved here is a lexical binding of the component it was cut
// from, so `tsc` is a complete backstop — EXCEPT `sharedMaskSessionsRef` / `shareMaskAcrossGroup` /
// `detachSharedMask`, which also escape onto `window` (`__vizSharedMasks` etc.) from an effect that
// stays in the shell because it ALSO publishes link + display seams. Those three are returned and
// re-passed, so that effect is unchanged and the window seam keeps its exact identity.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { DataSource } from '../data/wire'
import { sourceForCell, type GridCell, type LabelMaskData } from './gridModel'
import { createMaskCorrectController, type MaskCorrectController } from '../annotate/maskCorrectController'
import { composeSharedLabelMask, SharedMaskTooLargeError, type SharedLabelMask, type WorldRect } from '../annotate/sharedMask'
import { createSharedMaskController, type SharedMaskController } from '../annotate/sharedMaskController'
import { nextLabelId, type DirtyRect } from '../annotate/maskEdit'
import { emptyMaskReview, type MaskCellReview } from '../annotate/maskDock'
import { selectMaskReview, selectSegmentMode, selectSegmentOpenSig, type createPaneDocksStore } from '../../adapter/PaneDocks.store'
import type { VizStores } from '../../adapter/vizStores'
import { useStore } from 'zustand'

type PaneDocksStore = ReturnType<typeof createPaneDocksStore>
type DatasetEntries = ReturnType<VizStores['datasetStore']['getState']>['datasets']

export interface GridMasksInputs {
  readonly stores: VizStores
  readonly paneDocks: PaneDocksStore
  readonly cells: readonly GridCell[]
  readonly denseIds: ReadonlySet<string>
  readonly source: DataSource
  readonly datasetEntriesRef: RefObject<DatasetEntries>
  /** The shared image-fetch mounted flag — the mask fetch is one of the three raster pulls it guards.
   *  SPLIT N (ITEM-30): its OWNER moved from the shell to `useGridRaster.ts`, which declares the other
   *  two pulls; the shell now threads it here from that plane's return. The ref identity and every
   *  read are unchanged — only where it is declared moved. */
  readonly imgFetchMountedRef: RefObject<boolean>
  readonly linkGroups: ReturnType<VizStores['gridWorkspace']['getState']>['linkGroups']
  /** cellId → link-group id (the shell's `linkGroups` inverse). Read when sharing a mask over a group. */
  readonly cellLinkGroup: Record<string, string>
}

export interface GridMasks {
  readonly segmentCellIds: readonly string[]
  readonly segmentMode: boolean
  readonly toggleSegmentCell: (id: string) => void
  readonly closeSegmentCell: (id: string) => void
  readonly resolvedLabelMask: (cell: GridCell) => LabelMaskData | null
  readonly maskReady: ReadonlySet<string>
  readonly maskReview: Record<string, MaskCellReview>
  readonly maskEpoch: number
  readonly bumpMask: () => void
  readonly patchMaskReview: (cellId: string, fn: (r: MaskCellReview) => MaskCellReview) => void
  readonly maskShareNotice: string | null
  readonly ensureMaskSession: (cellId: string) => { controller: MaskCorrectController; data: LabelMaskData } | null
  readonly sharedSessionForCell: (cellId: string) => { mask: SharedLabelMask; controller: SharedMaskController } | null
  readonly applyMaskPick: (cellId: string, pick: { id: number | null; x: number; y: number }) => void
  readonly shareMaskAcrossGroup: (groupId: string) => void
  readonly detachSharedMask: (groupId: string) => void
  readonly sharedMaskSessionsRef: RefObject<Map<string, { mask: SharedLabelMask; controller: SharedMaskController }>>
}

/** The mask / segmentation plane. */
export function useGridMasks({
  stores,
  paneDocks,
  cells,
  denseIds,
  source,
  datasetEntriesRef,
  imgFetchMountedRef,
  linkGroups,
  cellLinkGroup,
}: GridMasksInputs): GridMasks {
  // SEGMENTATION (segmentation-scale ITEM-1): the resolved in-grid LABEL MASK for a `segment` cell,
  // fetched via the optional `DataSource.imageLabelMask()` seam and cached per cell (same 'loading' |
  // entry | null shape as `imagePyramids`). The effective mask a cell renders/edits is
  // `cell.labelMask ?? maskData[cell.id]` (a caller may supply it directly). Absent ⇒ no mask (the
  // mask layer + controls don't mount — byte-identical).
  const [maskData, setMaskData] = useState<Record<string, LabelMaskData | 'loading' | null>>({})
  const maskDataRef = useRef(maskData)
  maskDataRef.current = maskData
  useEffect(() => {
    const segCells = cells.filter(c => c.segment && !c.labelMask && denseIds.has(c.id))
    if (segCells.length === 0) {
      setMaskData(prev => (Object.keys(prev).length ? {} : prev))
      return
    }
    void (async () => {
      for (const cell of segCells) {
        if (maskDataRef.current[cell.id] !== undefined) continue // already loading/loaded/failed
        const src = sourceForCell(cell.datasetId, source, id => datasetEntriesRef.current[id]?.source ?? null)
        if (!src?.imageLabelMask) continue // opt-in per source; absent ⇒ no in-grid mask for this cell
        setMaskData(prev => ({ ...prev, [cell.id]: 'loading' }))
        try {
          const data = await src.imageLabelMask({ cellId: cell.id })
          if (!imgFetchMountedRef.current) return
          setMaskData(prev => ({ ...prev, [cell.id]: data ?? null }))
        } catch {
          if (imgFetchMountedRef.current) setMaskData(prev => ({ ...prev, [cell.id]: null }))
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, denseIds, source])
  // The effective mask a segment cell renders/edits: a caller-supplied `cell.labelMask` wins, else the
  // async-resolved `maskData[cellId]` (null/'loading' ⇒ none yet).
  const resolvedLabelMask = useCallback(
    (cell: GridCell): LabelMaskData | null => {
      if (cell.labelMask) return cell.labelMask
      const d = maskData[cell.id]
      return d && d !== 'loading' ? d : null
    },
    [maskData],
  )

  /** BLIND-AUDIT M10 — panes whose mask has actually RESOLVED. The mask dock body renders only when
   *  `session && data` holds, so offering the pane-toolbar Segment button on the `segment` FLAG alone
   *  opened an empty panel on a pane that is still loading (or never resolves). Same predicate, one
   *  source. */
  const maskReady = useMemo(
    () => new Set(cells.filter(c => resolvedLabelMask(c) != null).map(c => c.id)),
    [cells, resolvedLabelMask],
  )

  const segmentCellIds = useMemo(
    () => cells.filter(c => c.segment && denseIds.has(c.id)).map(c => c.id),
    [cells, denseIds],
  )
  const segmentAvailable = segmentCellIds.length > 0
  // PER-PANE (ITEM-8, INV-12) — the mask twin of `annotateOpenIds`. The mask CANVAS ops were already
  // per-cell (they route off the deck pick's `cellId`); only the PANEL binding was single, which is
  // what stopped two segment panes being reviewed side by side.
  //
  // SPLIT D (ITEM-15): the SET lives in `paneDocks`; the shell subscribes to the derived MODE, and
  // separately to a stable-by-VALUE signature of the set for the one dev-hook effect below whose
  // trigger is the set's CONTENT rather than the mode.
  const segmentMode = useStore(paneDocks, selectSegmentMode)
  const segmentOpenSig = useStore(paneDocks, selectSegmentOpenSig)
  /** The pane toolbar's Segment button: open THIS pane's mask dock, or close it if already open. */
  const toggleSegmentCell = useCallback((id: string) => paneDocks.getState().toggleSegment(id), [paneDocks])
  const closeSegmentCell = useCallback(
    (id: string) => {
      paneDocks.getState().closeSegment(id)
      // BLIND-AUDIT M11 — closing the dock must also drop that pane's HALF-FINISHED correction, or a
      // reopen silently resumes a stale merge source / split seeds against a mask the user has since
      // changed. Mirrors the annotate side, where closing drops the in-flight draft.
      paneDocks.getState().clearPendingCorrection(id)
    },
    [paneDocks],
  )

  // A fixed Track-0 brush radius (SegmentLimits, DEC-10 — promotable to a prop without a rewrite).
  const MASK_BRUSH_RADIUS_PX = 8

  // Per-cell mask session: the controller + the raster/LUT it mutates in place. Minted lazily + retained
  // across renders (like `annotateStoresRef`) so a re-render never rebinds the controller.
  const maskSessionsRef = useRef<Map<string, { controller: MaskCorrectController; data: LabelMaskData }>>(new Map())

  // Live review/edit state per segment cell. Kept in React state so the layer memo + the panel re-render
  // on any change; `maskEpoch` is the coarse repaint trigger for in-place raster edits + undo/redo.
  // SPLIT C (ITEM-17): the `MaskCellReview` SHAPE + `emptyMaskReview` moved to `annotate/maskDock.ts`
  // — the mask dock's own model module, which both this shell and `GridDockLayer` already import. The
  // RECORD stays here: the label-mask LAYER builder reads hide/solo/LUT out of it, and every mask
  // pointer handler writes it through `patchMaskReview`.
  // UNION a pending dirty rect with a new one so two edits batched into one render both sub-upload
  // (a replace would drop the first edit's changed texels on the GPU). Empty/null ⇒ take the new rect.
  const unionDirty = (prev: DirtyRect | null, next: DirtyRect): DirtyRect => {
    if (!prev || prev[2] < prev[0] || prev[3] < prev[1]) return [...next] as DirtyRect
    return [Math.min(prev[0], next[0]), Math.min(prev[1], next[1]), Math.max(prev[2], next[2]), Math.max(prev[3], next[3])]
  }
  // DEC-10 refusal message (over-cap shared raster) surfaced in the mask dock; null when clear.
  const [maskShareNotice, setMaskShareNotice] = useState<string | null>(null)
  // SPLIT D (ITEM-15): the RECORD lives in `paneDocks`. The shell still SUBSCRIBES to it — the
  // label-mask layer builder reads hide/solo/LUT/selection out of it and feeds deck's `layersAfter`
  // — so this is not a re-render narrowing the way the four open sets were; it is an OWNERSHIP move,
  // which is what lets the dock layer read the record directly instead of taking it as a prop, and
  // what lets the ~15 shell mask handlers keep writing through one `[]`-stable `patchMaskReview`.
  // The gesture-time read that used to go through `maskReviewRef` now goes through `getState()`,
  // which is strictly fresher (a ref mirrored in render is one commit behind a same-tick write).
  const maskReview = useStore(paneDocks, selectMaskReview)
  const [maskEpoch, setMaskEpoch] = useState(0)
  const bumpMask = useCallback(() => setMaskEpoch(e => e + 1), [])
  const patchMaskReview = useCallback(
    (cellId: string, fn: (r: MaskCellReview) => MaskCellReview) => paneDocks.getState().patchMaskReview(cellId, fn),
    [paneDocks],
  )

  // Evict a per-cell mask session + its review state when a cell is removed or drops `segment` (mirrors
  // the annotate-store teardown effect). Without this a removed segment cell leaks its raster + up-to-200
  // undo atoms, and its stale MaskCellReview (hidden Set / catsRef / dirty) accumulates over churn.
  useEffect(() => {
    const live = new Set(segmentCellIds)
    for (const id of [...maskSessionsRef.current.keys()]) if (!live.has(id)) maskSessionsRef.current.delete(id)
    paneDocks.getState().pruneMaskReview(segmentCellIds)
    // `paneDocks` is deliberately absent from the deps and there is no eslint-disable, because the
    // pre-split form closed over the lifetime-stable `setMaskReview` and this one closes over a
    // lifetime-stable STORE HANDLE: `paneDocks` is minted once per workspace by
    // `useState(createPaneDocksStore)` and never reassigned, and the effect reads through
    // `.getState()` rather than a subscription, so adding it would change nothing but the noise.
    // Recorded here because it is the one dep-array change the extracted hooks made that arrived
    // without its justification (FIX_ROUND-2 / A11).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentCellIds])

  const ensureMaskSession = useCallback(
    (cellId: string): { controller: MaskCorrectController; data: LabelMaskData } | null => {
      const cell = cells.find(c => c.id === cellId)
      const data = cell ? resolvedLabelMask(cell) : null
      if (!data) return null
      // Return the cached session ONLY while it still wraps the CURRENT resolved mask. If the cell's
      // mask identity changed (a source re-emitted a fresh LabelMaskData), the stale controller would
      // keep mutating the orphaned raster while the layer renders the new one → invisible corrections.
      const existing = maskSessionsRef.current.get(cellId)
      if (existing && existing.data === data) return existing
      const controller = createMaskCorrectController({
        mask: data.raster,
        width: data.width,
        height: data.height,
        categoryForId: data.categoryForId,
        // pixel edit → record the tight dirty rect (SAME raster ref ⇒ the layer sub-uploads only it).
        onPixels: rect => patchMaskReview(cellId, r => ({ ...r, dirty: unionDirty(r.dirty, [...rect] as DirtyRect) })),
        // category edit → hand the layer a FRESH LUT snapshot ref so it rebuilds the id→color LUT
        // (the raster ref stays stable, so this never re-encodes pixels).
        onCategories: cats => patchMaskReview(cellId, r => ({ ...r, catsRef: Uint16Array.from(cats) })),
      })
      const session = { controller, data }
      maskSessionsRef.current.set(cellId, session)
      return session
    },
    [cells, patchMaskReview, resolvedLabelMask],
  )

  // Shared-mask runtime (Track A) — declared here (before `applyMaskPick`) so the gesture dispatcher can
  // route a SHARED cell's corrections to the ONE shared controller. Keyed by link-group id; runtime-only
  // (non-serializable). Attach/detach + fan-out wiring live in the block below the mask sessions.
  const sharedMaskSessionsRef = useRef<Map<string, { mask: SharedLabelMask; controller: SharedMaskController }>>(new Map())
  const sharedSessionForCell = useCallback(
    (cellId: string): { mask: SharedLabelMask; controller: SharedMaskController } | null => {
      const gid = cellLinkGroup[cellId]
      if (gid === undefined) return null
      return sharedMaskSessionsRef.current.get(gid) ?? null
    },
    [cellLinkGroup],
  )

  // Correction-gesture dispatcher: a click on the mask layer carries the picked id + WORLD coord. The
  // ACTIVE tool decides the op — select/relabel/merge key off `id`; brush extends the selected label at
  // the coord; split collects two seeds. Every op mutates the one raster/LUT in place + is one undo atom.
  // A SHARED cell routes to its group's shared controller (world→shared-pixel mapping, INV-9); else the
  // per-cell Track-0 controller (world==pixel via the identity modelMatrix). The two paths share one
  // shape via `ops`, so the tool logic below is written once.
  const applyMaskPick = useCallback(
    (cellId: string, pick: { id: number | null; x: number; y: number }) => {
      const shared = sharedSessionForCell(cellId)
      const session = shared ? null : ensureMaskSession(cellId)
      if (!shared && !session) return
      // per-cell world==pixel (identity registration); shared maps world→pixel + a world-unit radius that
      // yields ~MASK_BRUSH_RADIUS_PX shared pixels (so on-screen brush size is stable across resolutions).
      const raster = shared ? shared.mask.raster : session!.data.raster
      const ops = shared
        ? (() => {
            const b = shared.mask.worldBounds
            const rWorld = MASK_BRUSH_RADIUS_PX * ((b[2] - b[0]) / shared.mask.width)
            return {
              relabel: (i: number, c: number) => shared.controller.relabel(i, c),
              merge: (a: number, bb: number) => shared.controller.merge(a, bb),
              brush: (x: number, y: number, i: number) => shared.controller.brushWorld({ wx: x, wy: y, rWorld, id: i }),
              split: (target: number, seeds: { x: number; y: number; id: number }[]) =>
                shared.controller.splitWorld({ cellId: target, seeds: seeds.map(s => ({ wx: s.x, wy: s.y, id: s.id })) }),
            }
          })()
        : {
            relabel: (i: number, c: number) => session!.controller.relabel(i, c),
            merge: (a: number, bb: number) => session!.controller.merge(a, bb),
            brush: (x: number, y: number, i: number) => session!.controller.brush({ x, y, r: MASK_BRUSH_RADIUS_PX, id: i }),
            split: (target: number, seeds: { x: number; y: number; id: number }[]) =>
              session!.controller.split({ cellId: target, seeds }),
          }
      const r = paneDocks.getState().maskReview[cellId] ?? emptyMaskReview()
      const id = pick.id ?? 0
      const tool = r.tool
      // select (or a relabel/merge with nothing actionable yet) → just update the readout.
      if (!tool || tool === 'relabel') {
        if (tool === 'relabel' && r.target != null && id > 0) {
          ops.relabel(id, r.target)
          patchMaskReview(cellId, cur => ({ ...cur, selectedId: id }))
          bumpMask()
        } else {
          patchMaskReview(cellId, cur => ({ ...cur, selectedId: id > 0 ? id : null }))
        }
        return
      }
      if (tool === 'merge') {
        if (r.mergeSource == null) {
          patchMaskReview(cellId, cur => ({ ...cur, mergeSource: id > 0 ? id : null, selectedId: id > 0 ? id : cur.selectedId }))
        } else if (id > 0 && id !== r.mergeSource) {
          ops.merge(r.mergeSource, id)
          patchMaskReview(cellId, cur => ({ ...cur, mergeSource: null, selectedId: id }))
          bumpMask()
        }
        return
      }
      if (tool === 'brush') {
        const paintId = r.selectedId && r.selectedId > 0 ? r.selectedId : id
        if (paintId > 0) {
          ops.brush(pick.x, pick.y, paintId)
          patchMaskReview(cellId, cur => ({ ...cur, selectedId: paintId }))
          bumpMask()
        }
        return
      }
      if (tool === 'split') {
        const seeds = [...r.splitSeeds]
        const seedId = seeds.length === 0 ? (id > 0 ? id : 0) : nextLabelId(raster)
        seeds.push({ x: pick.x, y: pick.y, id: seedId })
        if (seeds.length >= 2) {
          const target = r.splitSeeds[0]?.id || (id > 0 ? id : r.selectedId ?? 0)
          if (target > 0) ops.split(target, seeds)
          patchMaskReview(cellId, cur => ({ ...cur, splitSeeds: [] }))
          bumpMask()
        } else {
          patchMaskReview(cellId, cur => ({ ...cur, splitSeeds: seeds, selectedId: id > 0 ? id : cur.selectedId }))
        }
        return
      }
    },
    [ensureMaskSession, patchMaskReview, bumpMask, sharedSessionForCell],
  )

  // ELIGIBILITY RECONCILE (DEC-8) — the mask twin of the annotate reconcile. Eviction only: a pane
  // that leaves the segment set is dropped from the open set, so no stale id survives.
  useEffect(() => {
    paneDocks.getState().evictSegment(segmentCellIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentCellIds.join(',')])

  // Expose the per-cell mask sessions for gallery stories / e2e to drive + assert the LIVE controller
  // (dev hook only, exactly like `__vizAnnotateStores`). Bumped by `maskEpoch` so a newly-minted session
  // becomes visible. Each entry's `controller` mutates the SAME `data.raster` the mask layer renders.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __vizMaskSessions?: Map<string, { controller: MaskCorrectController; data: LabelMaskData }> })
        .__vizMaskSessions = maskSessionsRef.current
    }
  }, [maskEpoch, segmentOpenSig])

  // ── Shared mask across panes (segmentation-scale Track A, ITEM-4..7) ────────────────────────────
  // A link group can OPT IN (explicit "Share mask across group" action, ESC-3) to ONE workspace-owned
  // label raster in world space: each member cell becomes a read-through VIEW of the same raster, so a
  // correction dragged across a pane seam is continuous and one undo reverts it everywhere. Additive +
  // opt-in: until a group is shared, every segment cell keeps its Track-0 per-cell mask (byte-identical).
  // The raster/controller are runtime (non-serializable) so they live in a ref keyed by link-group id,
  // NOT the store; membership itself lives in the store's `linkGroups`. (`sharedMaskSessionsRef` +
  // `sharedSessionForCell` are declared earlier, above `applyMaskPick`, which routes to them.)

  // World rect of a cell's resolved per-cell mask (its pixel grid placed by `modelMatrix`, else 1:1).
  const cellMaskWorldRect = useCallback((data: LabelMaskData): WorldRect => {
    const mm = data.modelMatrix
    if (!mm) return [0, 0, data.width, data.height]
    // column-major scale+translate: world = (sx·px + tx, sy·py + ty). Corners at (0,0) and (w,h).
    const sx = mm[0], sy = mm[5], tx = mm[12], ty = mm[13]
    const x0 = tx, y0 = ty, x1 = tx + sx * data.width, y1 = ty + sy * data.height
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
  }, [])

  // Promote a link group to ONE shared mask (ESC-3 explicit action). Spans the union world extent of the
  // group's segment members; blits each member's existing per-cell raster into its world sub-region so no
  // prior correction is lost; registers each member as a view; wires the shared controller's fan-out to
  // sub-upload each viewing pane. No-op if <2 segment members resolve a mask.
  const shareMaskAcrossGroup = useCallback(
    (groupId: string) => {
      // Already-shared guard: re-blitting from the (never-mutated) per-cell rasters would silently
      // discard every shared correction + reset undo. The toolbar toggles share/detach, but the dev
      // seam + any future caller must be safe.
      if (sharedMaskSessionsRef.current.has(groupId)) return
      const memberIds = (linkGroups[groupId] ?? []).filter(id => {
        const c = cells.find(x => x.id === id)
        return c?.segment && !!resolvedLabelMask(c)
      })
      if (memberIds.length < 2) return
      const members = memberIds.map(id => {
        const c = cells.find(x => x.id === id)!
        const data = resolvedLabelMask(c)!
        return {
          cellId: id,
          raster: data.raster,
          width: data.width,
          height: data.height,
          categoryForId: data.categoryForId,
          worldRect: cellMaskWorldRect(data),
        }
      })
      // Pure compose: id-namespaced + UNION-LUT + resolution-aware blit + DEC-10 cap (see sharedMask.ts).
      let mask: SharedLabelMask
      try {
        mask = composeSharedLabelMask(groupId, members)
      } catch (e) {
        // DEC-10: refuse (don't OOM) an over-cap shared raster; surface the reason in the dock.
        if (e instanceof SharedMaskTooLargeError) { setMaskShareNotice(e.message); return }
        throw e
      }
      setMaskShareNotice(null)
      const controller = createSharedMaskController({
        mask,
        // a shared edit's dirty rect fans out to each viewing pane → each sub-uploads only its slice.
        // UNION with any pending dirty rect so two edits batched into one render both sub-upload.
        onFanout: targets => {
          for (const t of targets) patchMaskReview(t.cellId, r => ({ ...r, dirty: unionDirty(r.dirty, t.rect) }))
        },
        onCategories: cats => {
          for (const id of memberIds) patchMaskReview(id, r => ({ ...r, catsRef: Uint16Array.from(cats) }))
        },
      })
      sharedMaskSessionsRef.current.set(groupId, { mask, controller })
      bumpMask()
    },
    [linkGroups, cells, resolvedLabelMask, cellMaskWorldRect, patchMaskReview, bumpMask],
  )

  // Detach a group's shared mask — each member reverts to its own Track-0 per-cell mask (ESC-3). One
  // raster is dropped; the per-cell rasters were never mutated by the shared path, so they resume as-is.
  const detachSharedMask = useCallback(
    (groupId: string) => {
      const session = sharedMaskSessionsRef.current.get(groupId)
      if (!session) return
      sharedMaskSessionsRef.current.delete(groupId)
      // Clear each REGISTERED view (not `linkGroups[groupId]`, which may already be dissolved) so a
      // departed member reverts to its per-cell mask + no stale shared-space dirty/cats remain.
      for (const cellId of session.mask.views.keys()) patchMaskReview(cellId, r => ({ ...r, dirty: null, catsRef: null }))
      setMaskShareNotice(null)
      bumpMask()
    },
    [patchMaskReview, bumpMask],
  )

  // Reconcile shared-mask sessions with live link-group membership. A group that no longer exists or
  // dropped below 2 members → detach + FREE the (possibly huge) shared raster (previously leaked unless
  // the user clicked Unshare). A member that LEFT a still-shared group → drop its view + revert to its
  // per-cell mask; otherwise a remaining member's paint fans a SHARED-space dirty rect onto the departed
  // cell's per-cell raster (wrong dimensions → out-of-bounds / corrupted sub-upload).
  useEffect(() => {
    for (const [groupId, session] of Array.from(sharedMaskSessionsRef.current.entries())) {
      const members = linkGroups[groupId]
      if (!members || members.length < 2) { detachSharedMask(groupId); continue }
      const memberSet = new Set(members)
      for (const cellId of Array.from(session.mask.views.keys())) {
        if (!memberSet.has(cellId)) {
          session.mask.unregisterView(cellId)
          patchMaskReview(cellId, r => ({ ...r, dirty: null, catsRef: null }))
        }
      }
    }
  }, [linkGroups, detachSharedMask, patchMaskReview])
  return {
    segmentCellIds,
    segmentMode,
    toggleSegmentCell,
    closeSegmentCell,
    resolvedLabelMask,
    maskReady,
    maskReview,
    maskEpoch,
    bumpMask,
    patchMaskReview,
    maskShareNotice,
    ensureMaskSession,
    sharedSessionForCell,
    applyMaskPick,
    shareMaskAcrossGroup,
    detachSharedMask,
    sharedMaskSessionsRef,
  }
}
