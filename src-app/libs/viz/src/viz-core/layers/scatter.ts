// deckLayers.ts — pure deck.gl layer-prop builders (ITEM-4/7/10/16). Kept as
// plain functions returning prop objects (no GL context needed) so they are
// unit-testable in node; the canvas component spreads them into the layer
// constructors. The core rule (deck.gl research §1): feed BINARY typed-array
// attributes via `data:{length:N, attributes:{…}}` — never array-of-objects — so
// there is zero per-object JS iteration at 1M+ points.

/** The non-iterable binary `data` object deck.gl consumes at scale. */
export interface BinaryScatterData {
  readonly length: number
  readonly attributes: {
    readonly getPosition: { value: Float32Array; size: 2 }
    readonly getFillColor: { value: Uint8Array; size: 4; normalized: true }
    readonly getRadius?: { value: Float32Array; size: 1 }
  }
}

export interface ScatterProps {
  readonly id: string
  readonly data: BinaryScatterData
  readonly radiusUnits: 'pixels' | 'common'
  readonly radiusScale: number
  readonly radiusMinPixels: number
  readonly radiusMaxPixels: number
  readonly getRadius: number
  readonly stroked: false
  readonly filled: true
  readonly antialiasing: boolean
  readonly pickable: boolean
  readonly autoHighlight: boolean
  readonly parameters?: Record<string, unknown>
}

export interface ScatterBuildOpts {
  id?: string
  positions: Float32Array
  colors: Uint8Array
  /** Per-point radius array (optional; else the scalar `radius`). */
  radii?: Float32Array
  radius?: number
  radiusUnits?: 'pixels' | 'common'
  radiusMinPixels?: number
  radiusMaxPixels?: number
  pickable?: boolean
  /** Additive blending for density glow (deck.gl research §2). */
  additive?: boolean
}

/** Build the binary-attribute `ScatterplotLayer` props for an embedding/spatial scatter. */
export function buildScatterProps(opts: ScatterBuildOpts): ScatterProps {
  const length = opts.positions.length / 2
  // Binary-attribute length invariant: deck.gl reads `colors` as N*4 and `radii` as N per the derived
  // `length`. A caller mismatch would otherwise mis-render / throw deep inside deck with an opaque
  // message — surface a clear viz-layer error at the boundary instead (dev only; compiled-friendly).
  //
  // A length-0 `colors` is the GPU-COLORMAP SENTINEL (the shared `EMPTY_COLORS`): callers that color
  // in-shader from a LUT (`ColormapScatterLayer` in `CategoricalPointsView` / `TiledPointsView` /
  // `DeckScatterCanvas`'s GPU path) pass an empty buffer and OVERRIDE `data` with their own colored
  // attributes, so this `getFillColor` is discarded — allow it. Any OTHER non-matching length is a
  // genuine caller mismatch and still throws.
  if (opts.colors.length !== 0 && opts.colors.length !== length * 4) {
    throw new Error(
      `[viz] buildScatterProps: colors length ${opts.colors.length} !== positions/2*4 (${length * 4})`,
    )
  }
  if (opts.radii && opts.radii.length !== length) {
    throw new Error(`[viz] buildScatterProps: radii length ${opts.radii.length} !== point count ${length}`)
  }
  const attributes: BinaryScatterData['attributes'] = {
    getPosition: { value: opts.positions, size: 2 },
    getFillColor: { value: opts.colors, size: 4, normalized: true },
    ...(opts.radii ? { getRadius: { value: opts.radii, size: 1 as const } } : {}),
  }
  return {
    id: opts.id ?? 'viz-scatter',
    data: { length, attributes },
    radiusUnits: opts.radiusUnits ?? 'pixels',
    radiusScale: 1,
    // Under additive/dense accumulation, let the point shrink SUB-pixel (research item #5):
    // overdraw cost ∝ fragments shaded, so a smaller radius is the primary cost-bound. The
    // 1px floor stays for the crisp (over-blend) path so isolated points don't vanish.
    radiusMinPixels: opts.radiusMinPixels ?? (opts.additive ? 0.5 : 1),
    radiusMaxPixels: opts.radiusMaxPixels ?? 8,
    getRadius: opts.radius ?? 2,
    stroked: false,
    filled: true,
    antialiasing: !opts.additive, // AA off under additive accumulation (research §2)
    pickable: opts.pickable ?? true,
    autoHighlight: opts.pickable ?? true,
    ...(opts.additive
      ? {
          parameters: {
            depthWriteEnabled: false,
            blendColorSrcFactor: 'src-alpha',
            blendColorDstFactor: 'one',
            blendAlphaSrcFactor: 'src-alpha',
            blendAlphaDstFactor: 'one',
            blendColorOperation: 'add',
            blendAlphaOperation: 'add',
          },
        }
      : {}),
  }
}

// ── Overdraw-bounding: size + alpha + blend by on-screen density (research item #5) ──────────
//
// The cost of a dense point cloud is dominated by FRAGMENTS SHADED (overdraw), not vertex count.
// Between the crisp zoomed-in regime (few points per pixel → keep points opaque + full-size) and
// the density-aggregate image that replaces points entirely at the far end (`chooseLayerMode` /
// DensityView), there is a "points but dense" middle regime. There, scaling point SIZE and per-
// point ALPHA down with density both BOUNDS the fragment cost AND reads better: a zoomed-out cloud
// no longer overdraws opaquely into a saturated blob, and — summed additively — overlapping points
// build a smooth density field instead of flat overpaint.
//
// `density` here is points-per-pixel (visible points ÷ viewport pixels). The mapping is pure so it
// unit-tests in node; the canvas samples the live camera to feed it (throttled, not per-frame).

export interface DensitySizeAlpha {
  /** the point radius to draw at this density (≤ base; floors at `radiusFloorFactor·base`). */
  readonly radius: number
  /** per-point opacity at this density (≤ 1; floors at `alphaFloor`). Fed to the layer `opacity`. */
  readonly alpha: number
}

export interface SizeAlphaConfig {
  /** at/below this points-per-pixel the cloud is sparse → crisp + opaque (identity). */
  lowPpp?: number
  /** at/above this points-per-pixel the cloud is fully dense → radius/alpha at their floors. */
  highPpp?: number
  /** radius multiplier at full density (0<f≤1): the point shrinks toward `f·base`. */
  radiusFloorFactor?: number
  /** per-point opacity at full density (0<a≤1): translucent so overlaps sum, not saturate. */
  alphaFloor?: number
}

export const DEFAULT_SIZE_ALPHA: Required<SizeAlphaConfig> = {
  lowPpp: 0.15,
  highPpp: 2.0,
  radiusFloorFactor: 0.5,
  alphaFloor: 0.25,
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * Map an on-screen density (points/pixel) to a {radius, alpha} for the "dense points" regime.
 *
 * Sparse (density ≤ `lowPpp`)  → identity: {radius: base, alpha: 1} (crisp, opaque — DEFAULT-SAFE).
 * Dense  (density ≥ `highPpp`) → floors:   {radius: base·radiusFloorFactor, alpha: alphaFloor}.
 * Between, a smoothstep ramp — MONOTONIC (radius + alpha strictly non-increasing in density) and
 * CLAMPED (non-finite / negative density ⇒ sparse identity; beyond `highPpp` pins to the floors).
 */
export function sizeAlphaForDensity(
  density: number,
  base: number,
  cfg: SizeAlphaConfig = DEFAULT_SIZE_ALPHA,
): DensitySizeAlpha {
  const c = { ...DEFAULT_SIZE_ALPHA, ...cfg }
  const d = Number.isFinite(density) && density > 0 ? density : 0
  const span = Math.max(c.highPpp - c.lowPpp, 1e-9)
  const t = clamp01((d - c.lowPpp) / span)
  const s = t * t * (3 - 2 * t) // smoothstep — monotonic on [0,1], zero-slope at the knees
  const radius = base * (1 - s * (1 - c.radiusFloorFactor))
  const alpha = 1 - s * (1 - c.alphaFloor)
  return { radius, alpha }
}

/** ENTER additive (density-field) blending at/above this points-per-pixel. */
export const ADDITIVE_ENTER_PPP = 1.0
/** LEAVE additive blending (back to over-blend) below this — hysteresis band (no pop). */
export const ADDITIVE_EXIT_PPP = 0.6

/**
 * Decide whether the dense regime should SUM overlapping points additively (a density field) vs
 * normal over-blend. Hysteretic (`enter > exit`) so a camera hovering at the boundary can't
 * oscillate the blend mode frame-to-frame. Non-finite/negative density ⇒ over-blend (safe).
 * By the time it flips on, `sizeAlphaForDensity` has already lowered per-point alpha, so the
 * over→additive transition is not a visible brightness pop.
 */
export function shouldAdditiveBlend(
  density: number,
  currentlyAdditive: boolean,
  enterPpp: number = ADDITIVE_ENTER_PPP,
  exitPpp: number = ADDITIVE_EXIT_PPP,
): boolean {
  const d = Number.isFinite(density) && density > 0 ? density : 0
  return currentlyAdditive ? d > exitPpp : d >= enterPpp
}

// ── Level-of-detail gating (ITEM-7) ──────────────────────────────────────────

export interface LodConfig {
  /** Below this zoom, or above `pointThreshold` points, use aggregation. */
  minScatterZoom: number
  pointThreshold: number
}

export const DEFAULT_LOD: LodConfig = {
  minScatterZoom: -3,
  pointThreshold: 5_000_000,
}

/**
 * Choose the render mode given the current zoom + point count. Aggregation
 * (`ScreenGridLayer`) replaces individual dots when zoomed far out or when the
 * point count exceeds the threshold (deck.gl research §7).
 */
export function chooseLayerMode(
  zoom: number,
  pointCount: number,
  cfg: LodConfig = DEFAULT_LOD,
): 'scatter' | 'density' {
  if (pointCount > cfg.pointThreshold) return 'density'
  if (zoom < cfg.minScatterZoom) return 'density'
  return 'scatter'
}

export interface DensityProps {
  readonly id: string
  readonly data: { length: number; attributes: { getPosition: { value: Float32Array; size: 2 } } }
  readonly pointSizePixels: number
  readonly opacity: number
}

/** Build `ScreenGridLayer` props for the zoomed-out / huge-N density fallback. */
export function buildDensityProps(positions: Float32Array, id = 'viz-density'): DensityProps {
  return {
    id,
    data: { length: positions.length / 2, attributes: { getPosition: { value: positions, size: 2 } } },
    pointSizePixels: 4,
    opacity: 0.8,
  }
}

// ── Bitmap image underlay (ITEM-10) ──────────────────────────────────────────

export interface BitmapProps {
  readonly id: string
  readonly bounds: readonly [number, number, number, number]
  readonly image: { data: Uint8Array; width: number; height: number }
  readonly opacity: number
}

export function buildBitmapProps(
  image: { data: Uint8Array; width: number; height: number },
  bounds: readonly [number, number, number, number],
  opacity: number,
  id = 'viz-image-underlay',
): BitmapProps {
  return { id, bounds, image, opacity }
}

// ── Graph overlay (ITEM-16) ─────────────────────────────────────────────

export interface GraphEdge {
  readonly source: [number, number]
  readonly target: [number, number]
  readonly color: [number, number, number, number]
}

export interface LineProps {
  readonly id: string
  readonly data: readonly GraphEdge[]
  readonly getSourcePosition: (e: GraphEdge) => [number, number]
  readonly getTargetPosition: (e: GraphEdge) => [number, number]
  readonly getColor: (e: GraphEdge) => [number, number, number, number]
  readonly getWidth: number
  readonly widthUnits: 'pixels'
  readonly widthMinPixels: number
}

/**
 * Compute per-group centroids from the positions array and build `LineLayer` props
 * connecting the path's ordered groups (ITEM-16). `codes` assigns each point to a
 * group; `path` is the ordered list of group codes to connect.
 */
export function buildGraphProps(
  positions: Float32Array,
  codes: Uint16Array,
  paths: readonly (readonly number[])[],
  color: [number, number, number, number] = [40, 40, 40, 255],
  id = 'viz-graph',
): LineProps {
  const centroids = computeCentroids(positions, codes)
  const edges: GraphEdge[] = []
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = centroids.get(path[i])
      const b = centroids.get(path[i + 1])
      if (a && b) edges.push({ source: a, target: b, color })
    }
  }
  return {
    id,
    data: edges,
    getSourcePosition: e => e.source,
    getTargetPosition: e => e.target,
    getColor: e => e.color,
    getWidth: 2,
    widthUnits: 'pixels',
    widthMinPixels: 2,
  }
}

/** Per-group centroid (mean position) over the dense positions array. */
export function computeCentroids(
  positions: Float32Array,
  codes: Uint16Array,
): Map<number, [number, number]> {
  const sumX = new Map<number, number>()
  const sumY = new Map<number, number>()
  const cnt = new Map<number, number>()
  const n = codes.length
  for (let i = 0; i < n; i++) {
    const k = codes[i]
    sumX.set(k, (sumX.get(k) ?? 0) + positions[i * 2])
    sumY.set(k, (sumY.get(k) ?? 0) + positions[i * 2 + 1])
    cnt.set(k, (cnt.get(k) ?? 0) + 1)
  }
  const out = new Map<number, [number, number]>()
  for (const [k, c] of cnt) out.set(k, [sumX.get(k)! / c, sumY.get(k)! / c])
  return out
}
