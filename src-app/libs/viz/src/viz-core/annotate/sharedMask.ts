// sharedMask.ts — the WORKSPACE-OWNED shared label mask (segmentation-scale Track A, ITEM-4/7).
//
// A tiled/whole-slide segmentation is ONE label raster in WORLD/physical space; several grid cells
// (panes) each VIEW a region of it. The invariant (INV-8): there is exactly ONE `Uint32Array` raster
// and ONE id→category LUT — cells register as lightweight VIEW descriptors, never owners, and never
// hold a copy. Memory is one raster + N small view records regardless of how many panes look at it.
//
// This module is framework-agnostic (viz-core purity rule): NO deck / react / GL / I/O. The world↔
// raster-pixel mapping is a pure affine derived from `worldBounds` + raster `width`/`height`, so a
// gesture expressed in ANY pane's world coords maps to the SAME shared pixel (the property the
// cross-pane controller in `sharedMaskController.ts` relies on for a seam-invisible stroke, INV-9).
//
// The per-cell (Track-0) `LabelMaskData` path is unchanged and remains the default; a shared mask is
// ADDITIVE and opt-in (attach to a link group via the store), so a workspace that never shares is
// byte-identical.

import type { DirtyRect } from './maskEdit'

/** DEC-10 shared-raster memory guard. A shared mask spans the union world extent of a link group at
 * the finest member density, so a widely-separated / high-density group could otherwise allocate a
 * multi-GB `Uint32Array` (or throw `RangeError: Invalid array length`). Refuse above these bounds so
 * the attach path surfaces a clear message instead of OOM-ing. ~16384² ≈ 1 GiB of Uint32. */
export const MAX_SHARED_RASTER_DIM = 16384
export const MAX_SHARED_RASTER_CELLS = MAX_SHARED_RASTER_DIM * MAX_SHARED_RASTER_DIM

/** Thrown by `createSharedLabelMask` when the requested raster exceeds the DEC-10 cap. The attach
 * caller catches this and surfaces a user-facing refusal rather than allocating. */
export class SharedMaskTooLargeError extends Error {
  constructor(public readonly width: number, public readonly height: number) {
    super(
      `shared mask ${width}×${height} exceeds the ${MAX_SHARED_RASTER_DIM}×${MAX_SHARED_RASTER_DIM} limit ` +
        `(${MAX_SHARED_RASTER_CELLS} px); reduce the link group's world span or member resolution`,
    )
    this.name = 'SharedMaskTooLargeError'
  }
}

/** A world-space axis-aligned rectangle `[minX, minY, maxX, maxY]` (maxX ≥ minX, maxY ≥ minY). */
export type WorldRect = readonly [minX: number, minY: number, maxX: number, maxY: number]

/** A registered VIEW of the shared mask: which cell, and the world rectangle that pane currently shows. */
export interface SharedMaskView {
  readonly cellId: string
  /** the world rect this pane displays (drives dirty-rect fan-out — a view that doesn't cover an edit
   * gets no upload). Absent/`null` ⇒ "covers everything" (always uploads; the safe default). */
  readonly worldViewport: WorldRect | null
}

export interface CreateSharedLabelMaskOptions {
  /** stable id (typically the owning link-group id). */
  readonly id: string
  /** the raster's placement in world space — the affine domain for world↔pixel. */
  readonly worldBounds: WorldRect
  readonly width: number
  readonly height: number
  /** optional pre-seeded raster (row-major, 0 = background). Default: a fresh zeroed raster. Adopted
   * BY REFERENCE (not copied) — one raster identity. */
  readonly raster?: Uint32Array
  /** optional pre-seeded id→category LUT. Default: fresh zeroed. Adopted by reference. */
  readonly categoryForId?: Uint16Array
}

export interface SharedLabelMask {
  readonly id: string
  readonly worldBounds: WorldRect
  readonly width: number
  readonly height: number
  /** THE one raster — the same reference every viewing cell's layer renders. Mutated in place. */
  readonly raster: Uint32Array
  /** THE one id→category LUT. Mutated in place by relabel/merge. */
  readonly categoryForId: Uint16Array
  /** map a world point to a (fractional) shared-raster pixel. Exact inverse of `pixelToWorld`. */
  worldToPixel(wx: number, wy: number): readonly [px: number, py: number]
  /** map a shared-raster pixel to its world point. Exact inverse of `worldToPixel`. */
  pixelToWorld(px: number, py: number): readonly [wx: number, wy: number]
  /** map a world LENGTH along X to a raster-pixel length (for a brush radius given in world units). */
  worldLengthToPixels(len: number): number
  /** register (or replace) a cell's view. Does NOT touch the raster. */
  registerView(cellId: string, worldViewport?: WorldRect | null): void
  /** drop a cell's view. Does NOT touch the raster (INV-8: unregister ≠ mutate). */
  unregisterView(cellId: string): void
  /** the live view registrations (read-only). */
  readonly views: ReadonlyMap<string, SharedMaskView>
  /** the column-major 16-number `modelMatrix` that places the raster's pixel quad into world space
   * (fed to each viewing cell's `LabelMaskLayer` so all panes register the ONE raster identically). */
  modelMatrix(): number[]
}

/** One member (per-cell mask) to fold into a shared raster: its label raster + LUT + world placement. */
export interface SharedMaskMemberInput {
  readonly cellId: string
  readonly raster: Uint32Array
  readonly width: number
  readonly height: number
  readonly categoryForId: Uint16Array
  /** the member's world rectangle (its pixel grid placed in world space). */
  readonly worldRect: WorldRect
}

/** largest label id present in a raster (0 if empty). */
function maxLabelId(r: Uint32Array): number {
  let m = 0
  for (let i = 0; i < r.length; i++) if (r[i] > m) m = r[i]
  return m
}

/**
 * Compose ONE shared label mask from ≥1 per-cell members (segmentation-scale Track A share path).
 * Pure + oracle-testable. Three correctness guarantees the naive blit lacked:
 *  - **id namespacing** — each member's ids map to a DISJOINT range so tile A's id 5 and tile B's id 5
 *    (numbered independently from 1) do not alias into one object.
 *  - **UNION LUT** — the shared id→category is the union over members in the namespaced id space
 *    (never last-writer-wins-at-offset-0, which dropped earlier members' categories).
 *  - **resolution-aware, dest-driven blit** — every shared pixel a member covers samples the member's
 *    nearest source pixel via WORLD coords, so a member coarser than the finest density is not squished.
 * Throws `SharedMaskTooLargeError` (DEC-10) if the union extent × finest density exceeds the cap.
 * Registers one view per member (its world rect). Returns the shared mask with all members blitted in.
 */
export function composeSharedLabelMask(
  id: string,
  members: readonly SharedMaskMemberInput[],
): SharedLabelMask {
  if (members.length === 0) throw new Error('composeSharedLabelMask: needs ≥1 member')
  const minX = Math.min(...members.map(m => m.worldRect[0]))
  const minY = Math.min(...members.map(m => m.worldRect[1]))
  const maxX = Math.max(...members.map(m => m.worldRect[2]))
  const maxY = Math.max(...members.map(m => m.worldRect[3]))
  const bounds: WorldRect = [minX, minY, maxX, maxY]
  // resolution: 1 shared pixel per finest member pixel (worst-case member density over its world span).
  const pxPerWorldX = Math.max(...members.map(m => m.width / (m.worldRect[2] - m.worldRect[0])))
  const pxPerWorldY = Math.max(...members.map(m => m.height / (m.worldRect[3] - m.worldRect[1])))
  const width = Math.max(1, Math.round((maxX - minX) * pxPerWorldX))
  const height = Math.max(1, Math.round((maxY - minY) * pxPerWorldY))
  // disjoint id ranges: member i's ids 1..maxᵢ → idOffsetᵢ+1..idOffsetᵢ+maxᵢ.
  const partMax = members.map(m => maxLabelId(m.raster))
  const idOffsets: number[] = []
  let base = 0
  for (const m of partMax) { idOffsets.push(base); base += m }
  const totalMaxId = base
  const categoryForId = new Uint16Array(totalMaxId + 1)
  members.forEach((m, i) => {
    const off = idOffsets[i]
    for (let v = 1; v <= partMax[i]; v++) if (v < m.categoryForId.length) categoryForId[off + v] = m.categoryForId[v]
  })
  // createSharedLabelMask enforces the DEC-10 cap (throws SharedMaskTooLargeError) before allocating.
  const mask = createSharedLabelMask({ id, worldBounds: bounds, width, height, categoryForId })
  members.forEach((m, i) => {
    const off = idOffsets[i]
    const [rx0, ry0, rx1, ry1] = m.worldRect
    const [ax, ay] = mask.worldToPixel(rx0, ry0)
    const [bx, by] = mask.worldToPixel(rx1, ry1)
    const sx0 = Math.max(0, Math.floor(Math.min(ax, bx)))
    const sx1 = Math.min(width, Math.ceil(Math.max(ax, bx)))
    const sy0 = Math.max(0, Math.floor(Math.min(ay, by)))
    const sy1 = Math.min(height, Math.ceil(Math.max(ay, by)))
    for (let sy = sy0; sy < sy1; sy++) {
      for (let sx = sx0; sx < sx1; sx++) {
        const [wx, wy] = mask.pixelToWorld(sx + 0.5, sy + 0.5)
        const mpx = Math.floor(((wx - rx0) / (rx1 - rx0)) * m.width)
        const mpy = Math.floor(((wy - ry0) / (ry1 - ry0)) * m.height)
        if (mpx < 0 || mpx >= m.width || mpy < 0 || mpy >= m.height) continue
        const v = m.raster[mpy * m.width + mpx]
        if (v === 0) continue
        mask.raster[sy * width + sx] = v + off
      }
    }
    mask.registerView(m.cellId, m.worldRect)
  })
  return mask
}

/**
 * Create a shared label mask. The raster + LUT are the single source of truth; views are metadata.
 */
export function createSharedLabelMask(opts: CreateSharedLabelMaskOptions): SharedLabelMask {
  const { id, worldBounds, width, height } = opts
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`createSharedLabelMask: width/height must be > 0 (got ${width}×${height})`)
  }
  // DEC-10 memory guard: refuse an over-cap raster (would OOM / throw RangeError at allocation).
  if (width > MAX_SHARED_RASTER_DIM || height > MAX_SHARED_RASTER_DIM || width * height > MAX_SHARED_RASTER_CELLS) {
    throw new SharedMaskTooLargeError(width, height)
  }
  const [minX, minY, maxX, maxY] = worldBounds
  const spanX = maxX - minX
  const spanY = maxY - minY
  if (!(spanX > 0) || !(spanY > 0)) {
    throw new Error(`createSharedLabelMask: worldBounds must have positive span (got ${worldBounds})`)
  }
  const raster = opts.raster ?? new Uint32Array(width * height)
  if (raster.length !== width * height) {
    throw new Error(`createSharedLabelMask: raster length ${raster.length} ≠ ${width}×${height}`)
  }
  const categoryForId = opts.categoryForId ?? new Uint16Array(0)

  const sx = spanX / width // world units per pixel, X
  const sy = spanY / height // world units per pixel, Y
  const views = new Map<string, SharedMaskView>()

  return {
    id,
    worldBounds,
    width,
    height,
    raster,
    categoryForId,
    worldToPixel(wx, wy) {
      return [(wx - minX) / sx, (wy - minY) / sy] as const
    },
    pixelToWorld(px, py) {
      return [minX + px * sx, minY + py * sy] as const
    },
    worldLengthToPixels(len) {
      return len / sx
    },
    registerView(cellId, worldViewport = null) {
      views.set(cellId, { cellId, worldViewport: worldViewport ?? null })
    },
    unregisterView(cellId) {
      views.delete(cellId)
    },
    views,
    modelMatrix() {
      // column-major: scale(sx, sy) then translate(minX, minY). Places pixel(px,py) at world
      // (minX + px·sx, minY + py·sy) — the inverse of `worldToPixel`, so a viewing cell whose layer
      // uses bounds [0,height,width,0] + this matrix registers the raster in world space 1:1.
      return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, minX, minY, 0, 1]
    },
  }
}
