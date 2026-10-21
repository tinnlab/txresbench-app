// registry/coordSystem.ts — the COORDINATE-SYSTEM extension contract + registry
// (EXTENSIBILITY_STUDY §1.4 / §3.2 / §5.3, Part 6 STEP 5). This is the deck-adapted
// analog of ECharts' `registerCoordinateSystem` + `CoordinateSystemManager`: the single
// source of truth mapping a `CoordSystemId` (`world2d` / `chart2d` / `matrix2d`) → its
// registered `CoordSystemDef`, so a chart descriptor's `coordinateSystem` string resolves
// to a first-class, registered entity instead of the ad-hoc `isDenseKind` branch.
//
// It is the coord-system sibling of `registry/registry.ts` (chart types) — a pure `Map` +
// accessors, no React, no deck — so `grid/multiView.ts` (deck-free) can resolve a cell's
// host from it. The `CoordSystemId` union itself lives in `registry/types.ts` (owned by
// the descriptor contract); this module imports it as a type and adds ONLY coord-system
// definitions on top.
//
// STEP 5 scope: the defs CAPTURE the existing two-host behavior (the shared single-
// `<DeckGL>`/N-view deck for `world2d`; the per-cell `ChartCanvas` for `chart2d`/
// `matrix2d`) behind a registered `RenderHost` seam. Nothing here reroutes rendering —
// the data-space → screen projection still happens inside each deck view exactly as
// before. The registration is infrastructure the later `option` step consumes.

import type { CoordSystemId } from './types'

/**
 * The axes a coordinate system spans — ECharts' `getCoordinateSystemDimensions(type)`
 * analog (§1.4). All three of our systems are 2-D (`['x','y']`); the field exists so the
 * later pipeline can query a system's dimensionality generically.
 */
export type CoordDimension = 'x' | 'y'

/**
 * Which physical RENDER HOST (WebGL-context regime) a coordinate system draws into.
 * These are the two deck hosts we already ship, now named as registered entities:
 *
 *  - `shared-deck` — ONE `<DeckGL>` with N `OrthographicView`s + a `layerFilter` that
 *    routes each region's `<cellId>::` layers into its own viewport (the `GridWorkspace`
 *    deck). A single WebGL context serves every region.
 *  - `own-canvas` — a per-cell `ChartCanvas` (`<DeckGL>` per region). One WebGL context
 *    per region (the chart / matrix cells).
 */
export type RenderHostId = 'shared-deck' | 'own-canvas'

/**
 * The RENDER-HOST seam (EXTENSIBILITY_STUDY §3.1 point 4): the core owns *which host* a
 * coordinate system mounts into, not any chart's layers. STEP 5 keeps it a minimal
 * descriptor that captures the EXISTING host behavior — the `shared` flag IS the
 * dense-vs-chart WebGL-context split, now named. The two host singletons live in
 * `coordSystem/RenderHost.ts`.
 */
export interface RenderHost {
  readonly id: RenderHostId
  /**
   * `true` → ONE host instance renders N regions on a shared context (the shared single-
   * `<DeckGL>` deck; `layerFilter` clips each region to its `OrthographicView`).
   * `false` → each region gets its OWN host instance (a per-cell `ChartCanvas`). This is
   * the single source of truth for the "dense" partition: a cell renders on the shared
   * deck IFF its coord system's host is `shared`.
   */
  readonly shared: boolean
  /** Human/debug label. */
  readonly label: string
}

/**
 * The spec a coordinate system is instantiated FOR — one grid cell's slot (§5.3). Folds
 * in the `cellSpaceKey` link-scope policy as the coord-system region identity: two regions
 * with the SAME `spaceKey` share a shared-deck view (link-zoom scope); regions with
 * different keys never sync.
 */
export interface CoordRegionSpec {
  /** The region's identity — the grid cell id. */
  readonly regionId: string
  /**
   * The coordinate-space key (from `cellSpaceKey`): the link-zoom scope AND the shared-deck
   * region identity. Regions sharing a `spaceKey` zoom-sync when linked.
   */
  readonly spaceKey: string
}

/**
 * A live coordinate-system INSTANCE for one region — ECharts' `CoordinateSystem` instance
 * (§1.4), the thing a series is laid out into. STEP 5 is a MINIMAL handle: it identifies
 * the region + its dimensions + host so the later `option` pipeline can mount a chart's
 * layers into the right host region. The actual data-space → screen projection is
 * delegated to the host's deck view (unchanged), so this is NOT a new projector.
 */
export interface CoordSystemInstance {
  /** The coordinate system that created this instance. */
  readonly type: CoordSystemId
  /** The region (cell) this instance frames. */
  readonly regionId: string
  /** The coordinate-space key (link-scope / region identity). */
  readonly spaceKey: string
  /** The axes this instance spans (from its `CoordSystemDef`). */
  readonly dimensions: readonly CoordDimension[]
  /** The host this instance draws into. */
  readonly hostId: RenderHostId
}

/**
 * How the host FRAMES a coordinate system's camera — metadata mirroring the existing three
 * flavors (the real camera lives in the deck view, unchanged):
 *
 *  - `free-ortho` — the shared deck's free orthographic camera (`world2d`: scatter / image).
 *  - `auto-fit`   — `ChartCanvas` auto-fits an `OrthographicView` to the data bounds
 *    (`chart2d`: violin / box / bar / histogram / volcano).
 *  - `window`     — `ChartCanvas` with `controller:false`; navigation is a RANGE window
 *    driven by `bounds` only (`matrix2d`: heatmap / dotplot texel matrix, DEC-38).
 */
export type CoordCamera = 'free-ortho' | 'auto-fit' | 'window'

/**
 * Everything the core needs to run one coordinate system WITHOUT knowing what it is
 * (EXTENSIBILITY_STUDY §1.4 / §3.2). A system registers exactly one of these via
 * `registerCoordinateSystem(id, def)`; the create/dispose/dimensions seam mirrors ECharts'
 * coord-system lifecycle, adapted to deck.
 */
export interface CoordSystemDef {
  /** The `CoordSystemId` a chart descriptor's `coordinateSystem` matches. Unique. */
  readonly id: CoordSystemId
  /** Which render host this system mounts into. */
  readonly host: RenderHost
  /** The axes this system spans (ECharts `getCoordinateSystemDimensions`). */
  readonly dimensions: readonly CoordDimension[]
  /** The camera/framing regime (metadata; the real camera lives in the deck view). */
  readonly camera: CoordCamera
  /**
   * CREATE a coordinate-system instance for a region (ECharts `create`, §1.4). Pure — no
   * React, no deck — so it is unit-testable in node. Maps data-space → the host's world/
   * screen conceptually; STEP 5 returns the minimal region handle the later pipeline fills.
   */
  create(region: CoordRegionSpec): CoordSystemInstance
  /**
   * DISPOSE a coordinate-system instance (ECharts `dispose`, §1.4). Default no-op: the deck
   * host owns the GL context, so tearing a region down is releasing the (JS-only) handle.
   * Present so the seam is complete for the later `option` step.
   */
  dispose?(instance: CoordSystemInstance): void
}

/** The single module-level coordinate-system registry, keyed by `CoordSystemId`. */
const registry = new Map<CoordSystemId, CoordSystemDef>()

/**
 * Register a coordinate system (ECharts `registerCoordinateSystem(type, creator)`, §1.4).
 * Idempotent in the ECharts sense: re-registering the same `id` WARNS and REPLACES (last
 * wins) rather than throwing, so a hot-reload / double-install never hard-fails.
 * Registration is normally funneled through `use(installer)` (which dedupes by installer
 * identity), so this warn path fires only on a genuine duplicate `id`.
 */
export function registerCoordinateSystem(id: CoordSystemId, def: CoordSystemDef): void {
  if (registry.has(id) && typeof console !== 'undefined') {
    console.warn(`[viz] coordinate system "${id}" is already registered; replacing.`)
  }
  registry.set(id, def)
}

/** Resolve a `CoordSystemId` to its def, or `undefined` for an unregistered id. */
export function getCoordSystem(id: CoordSystemId | undefined): CoordSystemDef | undefined {
  return id === undefined ? undefined : registry.get(id)
}

/** Whether a `CoordSystemId` has a registered def. */
export function hasCoordSystem(id: CoordSystemId): boolean {
  return registry.has(id)
}

/** Every registered coordinate system, in registration order. */
export function coordSystems(): CoordSystemDef[] {
  return [...registry.values()]
}
