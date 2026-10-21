// wire.ts — the typed-array binary WIRE CONTRACT consumer (DATA_STORAGE_REDESIGN
// §2/§3.4/§3.7). GENERIC, domain-agnostic names (DEC-28) so viz-core extracts as a
// standalone package: point (not cell), dataset (not study), layout (not embedding),
// valueColumn (not gene), imageUnderlay (not tissue), DataTable (not DE), GraphData
// (not trajectory), DataSource (not VizStream). Only fixture demo data carries labels.
//
// Every payload is raw typed-array binary (`ArrayBuffer` → `new Float32Array(buf)` /
// `Uint32Array`), NOT Arrow, NOT JSON-of-numbers — the single seam that drops onto the
// real `GET /datasets/{id}/…` octet endpoints later with no viz rewrite.
//
// Data-plane framings (little-endian):
//   positions      : Float32Array[N*2], interleaved [x0,y0,x1,y1,…]  (no header)
//   sparse column  : u32 n | u32[n] row | f32[n] value               (CSC value col)
//   categorical    : u16[N] codes                (categories ride as control JSON)
//   continuous     : Float32Array[N]                                 (no header)

import type { PixelSource } from '@vivjs/types'
// type-only (erased at runtime) — no runtime cycle with gridModel's `DatasetCatalog` import from here.
import type { LabelMaskData } from '../grid/gridModel'

/** A decoded 2D positions layout: interleaved xy, `length` points. */
export interface Positions {
  /** Float32Array of length N*2, [x0,y0,x1,y1,…]. */
  readonly positions: Float32Array
  /** Number of points (positions.length / 2). */
  readonly length: number
}

/** A sparse value column — non-zero points only (CSC column slice). */
export interface SparseColumn {
  /** Canonical point positions (0..N-1) of the non-zero points. */
  readonly row: Uint32Array
  /** Value at each `row`. */
  readonly value: Float32Array
  /** Total point count N (the dense length the sparse column projects into). */
  readonly length: number
}

/** A decoded categorical column (codes are binary, categories are JSON). */
export interface CategoricalColumn {
  readonly codes: Uint16Array
  readonly categories: readonly string[]
  readonly length: number
}

/** A decoded continuous column. */
export interface ContinuousColumn {
  readonly value: Float32Array
  readonly length: number
}

// ── decoders (ArrayBuffer → TypedArray, zero-copy where the view allows) ──────

/** Decode a positions octet payload. Zero-copy view over the buffer. */
export function decodePositions(buf: ArrayBuffer): Positions {
  if (buf.byteLength % 8 !== 0) {
    throw new Error(`positions payload not a multiple of 8 bytes (got ${buf.byteLength})`)
  }
  const positions = new Float32Array(buf)
  return { positions, length: positions.length / 2 }
}

/**
 * Decode a sparse CSC value-column octet payload: `u32 n | u32[n] row | f32[n]
 * value`. `length` (total N) is supplied by the catalog/control plane.
 */
export function decodeSparseColumn(buf: ArrayBuffer, length: number): SparseColumn {
  const dv = new DataView(buf)
  const n = dv.getUint32(0, true)
  const rowOffset = 4
  const valueOffset = rowOffset + n * 4
  if (valueOffset + n * 4 > buf.byteLength) {
    throw new Error(`sparse column truncated: need ${valueOffset + n * 4} bytes, have ${buf.byteLength}`)
  }
  // row + value are 4-byte aligned (4 + 4n both divisible by 4) → direct views.
  const row = new Uint32Array(buf, rowOffset, n)
  const value = new Float32Array(buf, valueOffset, n)
  return { row, value, length }
}

/** Decode a categorical column's binary codes. Categories come from control JSON. */
export function decodeCategorical(
  buf: ArrayBuffer,
  categories: readonly string[],
): CategoricalColumn {
  const codes = new Uint16Array(buf)
  return { codes, categories, length: codes.length }
}

/** Decode a continuous column octet payload. */
export function decodeContinuous(buf: ArrayBuffer): ContinuousColumn {
  const value = new Float32Array(buf)
  return { value, length: value.length }
}

/**
 * Project a sparse column into a dense `Float32Array[N]` with the sparse default
 * (0) for every point not present in `row` (DATA_STORAGE_REDESIGN §3.7). NOTE: this
 * is the "densify" pre-pass — color-by-value is densify-THEN-swap, not zero-copy
 * (only dense continuous columns are zero-copy). ITEM-27 provides a GPU densify; this
 * CPU form is the parity oracle + fallback.
 */
export function densify(col: SparseColumn): Float32Array {
  const dense = new Float32Array(col.length) // zero-initialised
  const { row, value } = col
  for (let i = 0; i < row.length; i++) {
    dense[row[i]] = value[i]
  }
  return dense
}

// ── the typed DataSource surface (hand-written fetch-helper shape) ────────────
// DATA_STORAGE_REDESIGN §3.4.1: the data plane is raw ArrayBuffer, consumed off a
// purpose-built helper (NOT the JSON ApiClient). Round-1 backs it with the fixture
// generator; the SAME interface later points at the real octet endpoints.

export type ColumnKind =
  | 'layout'
  | 'value'
  | 'categorical'
  | 'continuous'
  | 'table'
  | 'graph'
  | 'image'

export interface CatalogEntry {
  readonly id: string
  readonly kind: ColumnKind
  readonly label: string
  /** For categorical columns: the category names (control-plane JSON). */
  readonly categories?: readonly string[]
  /**
   * STREAMING METADATA (DEC-10, ITEM-8b) — for a LAYOUT entry: how its headerless positions
   * `stream({kind:'positions',layout})` are encoded, so the consumer can decode without an inline
   * header. Absent ⇒ the default `f32` / stride 8 (back-compat). See {@link LayoutEncoding}.
   */
  readonly encoding?: LayoutEncoding
  /** For a VALUE column: which `layer` variants (raw/lognorm) the source can stream (G21). */
  readonly layers?: readonly string[]
  /**
   * D20 (ITEM-12, INV-26) — for a LAYOUT entry stored as k separate 1-D NUMERIC columns rather
   * than one interleaved `n×2` member: the component column KEYS (`[xKey, yKey]`), which the
   * adapter reads each through the numeric channel and INTERLEAVES to `Positions`. Present only
   * for that representation (a virtual/masked embedding, whose positions are two masked numeric
   * columns — there is NO 2-D gathered member); absent ⇒ the interleaved-`positions` channel is
   * used (a real dataset's own coordinate artifact), unchanged. Masking is inherited from the
   * numeric column path, so the adapter needs no mask logic of its own.
   */
  readonly components?: readonly string[]
  /**
   * THE FRAME THESE POSITIONS ARE IN (#228) — for a LAYOUT entry, the producer's declared
   * `coordinate_space` id (design §4 binding (2), §6.6).
   *
   * The twin of `ImageMeta.space`, and the pair is the whole binding: a layout's points may be
   * drawn over a raster IFF the two ids are EQUAL. Absent ⇒ this layout is not in any shared
   * frame — which is the ordinary case for an embedding, and is exactly what stops a UMAP being
   * painted onto a tissue section. SpatialData's axiom, which §5 adopts verbatim, is the same
   * rule stated upstream: *"Images, Labels, Points and Shapes MUST have one or more coordinate
   * systems and coordinate transformations, while Tables CAN NOT have a coordinate system or
   * coordinate transforms."*
   *
   * READ OFF THE ARTIFACT'S FULL ROW, not off the catalog LISTING row, and the reason is worth
   * stating because the first cut of this got it wrong: `compact_declaration`
   * (`dataset/models.rs:288`) caps arrays at four items — which is what drops a 6-element affine —
   * but it ALSO keeps only the first `DECL_MAX_KEYS = 8` keys in key order and truncates a string
   * value past `DECL_MAX_VALUE_CHARS = 120`. So a listing row can lose or mangle this id too, and
   * a mangled id is a SPURIOUS REFUSAL that looks exactly like two artifacts genuinely being in
   * different frames.
   */
  readonly space?: string
  /**
   * WHERE IN `space` THESE POSITIONS SIT (#228) — the layout artifact's own declared `to_space`,
   * the 2x3 row-major affine `[a,b,tx,c,d,ty]` mapping its stated numbers into `space` (§6.6).
   *
   * §5's axiom puts Points and Shapes in the set of elements that MUST carry a coordinate system
   * AND its transform, alongside Images. Both shipped importers state their coordinates directly
   * in the space (`[1,0,0,0,1,0]`), so in practice this is identity today — which is exactly why
   * it must be READ rather than assumed: a coordinate set registered into a shared frame with a
   * non-identity placement would otherwise be drawn unregistered, with no error anywhere.
   *
   * Absent ⇒ the layout states no placement, and the overlay REFUSES rather than assuming
   * identity.
   */
  readonly toSpace?: readonly number[]
}

/** How a layout's positions ride the wire (DEC-10). `packed-u16` carries `packMeta` for TRUE world units. */
export interface LayoutEncoding {
  readonly kind: 'f32' | 'packed-u16'
  /** bytes per point (8 for f32 xy, 4 for packed-u16 xy). */
  readonly stride: number
  /** for `packed-u16`: per-axis origin/scale to map codes → world coords (identity when absent). */
  readonly packMeta?: {
    readonly originX: number
    readonly scaleX: number
    readonly originY: number
    readonly scaleY: number
  }
}

/** Image underlay METADATA (dims + affine) — the pixels stream via `stream({kind:'image'})` (DEC-8/10). */
export interface ImageMeta {
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
  readonly affine: readonly [number, number, number, number, number, number]
  /**
   * THE FRAME THIS RASTER IS IN (#228) — the producer's declared `coordinate_space` id, carried
   * verbatim from the artifact's `meta`.
   *
   * This is design §4's binding (2): *"World coordinate space (image ↔ everything geometric) — a
   * declared `coordinate_space` id + affine. This is the new binding … It rides in each spatial
   * artifact's `meta`"*. It is what says a set of positions and this picture are the same scene,
   * and §4 refuses the alternative by name — binding them by *artifact adjacency in the same run*
   * does not survive a second image registered later to the same tissue.
   *
   * ABSENT ⇒ the raster declares no frame. That is a fact about the artifact, not a defect, and
   * it means the raster is UN-OVERLAYABLE — the same stance `omeTiffUnderlay` already takes for an
   * absent `to_space`. It must not be read as "matches whatever else is here".
   */
  readonly space?: string
  /**
   * THE FULL-RESOLUTION placement (#228): the 2x3 row-major affine `[a,b,tx,c,d,ty]` mapping this
   * raster's LEVEL-0 pixels into `space`, i.e. the artifact's own declared `to_space`.
   *
   * DISTINCT FROM `affine` ABOVE, and the two are easy to confuse to the exact tune of a factor
   * of the pyramid depth. `affine` runs space -> the SERVED (coarsest) level's pixels and exists
   * for the single-texture fallback; this one runs LEVEL-0 pixels -> space and is what the tiling
   * `imagePixelSource()` path is placed by. On the committed Visium fixture they are 0.05 and 5.0.
   *
   * Carried as DATA. A consumer validates it (six finite numbers) and REFUSES a malformed one
   * rather than substituting identity — a summary row drops arrays longer than four, so a
   * `to_space` read off the wrong row arrives missing, and identity would place the raster at
   * array-index units with nothing saying so.
   */
  readonly toSpace?: readonly number[]
}

/** A table's control-plane structure — the column bytes stream via `stream({kind:'tableColumn'})` (DEC-8). */
export interface TableMeta {
  readonly name: string
  readonly rowLabels: readonly string[]
  readonly columns: readonly string[]
}

export interface DatasetCatalog {
  readonly datasetId: string
  readonly pointCount: number
  readonly layouts: readonly CatalogEntry[]
  readonly valueColumns: readonly string[]
  readonly categoricalColumns: readonly CatalogEntry[]
  readonly continuousColumns: readonly CatalogEntry[]
  readonly hasImage: boolean
  /**
   * STREAMING METADATA (DEC-10, ITEM-8b) — the structure a headerless `stream()` can't self-describe.
   * All OPTIONAL + additive (a v≤3 catalog omits them → back-compat defaults). `graph` topology rides
   * here (control-plane, NOT a byte channel — DEC-8); image dims/affine + table structure ride here
   * while their bulk bytes stream; `hasPointIds` expresses the isolated-identity dataset without a
   * throw-means-isolated hack (DEC-10/E).
   */
  readonly image?: ImageMeta
  readonly tables?: readonly TableMeta[]
  readonly graphs?: readonly GraphData[]
  readonly hasPointIds?: boolean
}

/** A small columnar table (DATA_STORAGE_REDESIGN §3.4) — e.g. a DE/stat table. */
export interface DataTable {
  readonly rowLabels: readonly string[]
  readonly columns: Readonly<Record<string, Float32Array>>
}

/** Node-link graph over a categorical grouping (generalizes trajectory). */
export interface GraphData {
  /** The categorical column whose category centroids the nodes anchor to. */
  readonly nodeKey: string
  /** Ordered category codes per path (centroids connected in order). */
  readonly paths: readonly (readonly number[])[]
}

/** A raster underlay + the affine placing points into its pixel space. */
export interface ImageUnderlay {
  readonly data: Uint8Array // RGBA or RGB pixel bytes
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
  /** 2×3 row-major affine [a,b,tx,c,d,ty] mapping point coords → image px. */
  readonly affine: readonly [number, number, number, number, number, number]
}

/**
 * The viz data plane. A production impl fetches `ArrayBuffer`s from the octet
 * endpoints; the round-1 fixture impl resolves them from generated buffers. Either
 * way the viz consumes ONLY this typed surface. Covers the FULL wire contract (G19):
 * catalog drives the pickers; `table` is the bulk read for volcano/heatmap.
 */
/**
 * ITEM-15 leg (b) — per-READ cancellation, threaded through the pull surface.
 *
 * Every BULK-BYTE method below takes this as an OPTIONAL trailing argument. Optional and trailing
 * is the whole design: every existing caller and every existing implementor is unchanged (an
 * implementation that ignores the argument still satisfies the interface), so this is purely
 * additive. `asDataSource` forwards it into `StreamingSource.stream(channel, opts)`, which is what
 * makes INV-4 ("one epoch bump cancels network reader + in-flight batch + pending emit") reachable
 * for a DataSource-shaped read — before this, a caller could only DISCARD a completed read's result.
 *
 * The CONTROL-plane methods (`catalog`, `graph`) deliberately do NOT take it: they read no byte
 * stream, and widening them would imply a cancellation that has nothing to cancel.
 *
 * Structurally identical to `streamingSource.ts`'s `StreamOptions`, and kept as its own name here so
 * `wire.ts` does not depend on the streaming module (the dependency runs the other way).
 */
export interface DataReadOptions {
  /** Abort the underlying read + stop iteration. */
  readonly signal?: AbortSignal
}

export interface DataSource {
  catalog(): Promise<DatasetCatalog>
  positions(layoutId: string, opts?: DataReadOptions): Promise<Positions>
  /** A single value column's sparse CSC slice. `layer` = raw|lognorm (G21). */
  valueColumn(key: string, layer?: string, opts?: DataReadOptions): Promise<SparseColumn>
  categorical(key: string, opts?: DataReadOptions): Promise<CategoricalColumn>
  continuous(key: string, opts?: DataReadOptions): Promise<ContinuousColumn>
  /** The image underlay + its affine (for the `image` view-kind). */
  imageUnderlay(opts?: DataReadOptions): Promise<ImageUnderlay>
  /**
   * OPTIONAL Viv resolution pyramid for the `image` view-kind (ITEM-1). Returns a
   * `PixelSource[]` (index 0 = full resolution, each subsequent entry half-scale) that
   * the dense image cell feeds to `buildRasterImageLayers` — a gigapixel-capable, TILED
   * upgrade over the single-texture `imageUnderlay()`. Storage-agnostic: a production
   * source resolves it from an OME-Zarr/OME-TIFF loader; the fixture source builds an
   * `InMemoryPixelSource[]`. ABSENT ⇒ the cell falls back to `imageUnderlay()`
   * (byte-identical to pre-ITEM-1 behavior).
   */
  imagePixelSource?(): Promise<PixelSource<['c']>[]>
  /**
   * OPTIONAL resolved LABEL MASK for a `segment` cell (segmentation-scale ITEM-1). Returns the
   * integer label raster + id→category LUT + placement that the in-grid mask surface renders via
   * `buildLabelMaskLayers` and edits through the per-cell `createMaskCorrectController`. Storage-
   * agnostic: a production source resolves it from an OME-Zarr `labels/` group / a segmentation
   * processor's output; the fixture builds one in memory. ABSENT ⇒ the segment cell has no mask
   * (the mask layer + controls simply don't mount — byte-identical). Returned by value or promise.
   * The optional `params.cellId` lets a source place a per-cell tile in world space (e.g. adjacent
   * tiles of one whole-slide image for the shared-mask-across-panes flow); existing impls ignore it.
   */
  imageLabelMask?(params?: { readonly cellId: string }): Promise<LabelMaskData> | LabelMaskData | null
  /** A bulk columnar table (whole ~20-30k-row stat table at once — volcano/heatmap). */
  table(name: string, opts?: DataReadOptions): Promise<DataTable>
  /** Node-link graph over a categorical grouping. */
  graph(id: string): Promise<GraphData>
  /**
   * OPTIONAL canonical point-id namespace (MULTI-DATASOURCE / DEC-M6). Returns `pointIds[row]` =
   * the STABLE canonical id (e.g. a cell barcode) of the dataset's local `row`. Two datasets whose
   * `pointIds` sets intersect AUTO-LINK their selections (a lasso in one lights the barcode-matched
   * cells in the other). ABSENT ⇒ the dataset is an ISOLATED identity space (`pointIds[i]=i`, never
   * cross-comparable — the raw-index guard). Layout-independent (layouts re-embed the SAME cells),
   * so `layoutId` is accepted only for API symmetry.
   */
  pointIds?(layoutId?: string, opts?: DataReadOptions): Promise<Uint32Array>
}
