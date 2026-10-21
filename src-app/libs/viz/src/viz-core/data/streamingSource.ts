// streamingSource.ts — the ONE data-input surface (viz API consolidation, Part B).
//
// A dataset is a CATALOG (small control-plane JSON — structure + metadata) plus a set of KEYED
// byte STREAMS (the bulk data plane). Every data-plane read is `stream(channel)` yielding
// `AsyncIterable<Uint8Array>`; the viz owns decode + row-reframe + progressive emit + cancellation.
// A resident in-memory array enters via `fromArray()` as a one-chunk stream, so there is NO
// non-streaming entry — the progressive path is always exercised (DEC-2 forcing function).
//
// DESIGN (DECISIONS.md):
//   • DEC-8  — bulk bytes stream; small STRUCTURE (layouts+encoding, keys, categories, rowLabels,
//              image dims+affine, graph topology, hasPointIds) lives in `catalog()`. Graph is
//              catalog-only (tiny topology — no perf win from streaming).
//   • DEC-9  — a channel carries its KEY (layoutId / column key+layer / table name+column / graph is
//              catalog-only). This is the literal shape of every former `DataSource` method.
//   • DEC-10 — encoding (`f32`|`packed-u16`) + `hasPointIds` ride the catalog (a headerless stream is
//              otherwise uninterpretable). See `wire.ts::LayoutEncoding` / `DatasetCatalog`.

import type { PixelSource } from '@vivjs/types'
import type { DatasetCatalog } from './wire'
// type-only (erased at runtime) — the same import `wire.ts` already takes for the same reason.
import type { LabelMaskData } from '../grid/gridModel'

/**
 * A KEYED data-plane channel (DEC-9). Each variant names exactly WHICH column/layout/table its bytes
 * carry — a dataset has many layouts + ~20-30k value columns, so a bare channel enum is insufficient.
 * `graph` is intentionally ABSENT: graph topology is catalog-only (`DatasetCatalog.graphs`, DEC-8).
 */
export type Channel =
  | { readonly kind: 'positions'; readonly layout: string }
  /** a value column (sparse CSC on the wire); `layer` picks a raw/lognorm variant (G21). */
  | { readonly kind: 'value'; readonly key: string; readonly layer?: string }
  | { readonly kind: 'categorical'; readonly key: string }
  | { readonly kind: 'continuous'; readonly key: string }
  /** canonical point ids for a layout (defaults to the dataset's shared namespace). */
  | { readonly kind: 'pointIds'; readonly layout?: string }
  /** one named table's one column of f32 bytes (rowLabels + column keys ride the catalog). */
  | { readonly kind: 'tableColumn'; readonly name: string; readonly column: string }
  /** the image underlay's pixel bytes (dims + affine ride the catalog, DEC-8). */
  | { readonly kind: 'image' }
  /**
   * A column GATHERED to a MEMBER SUBSET of its axis (dimension-membership ITEM-13/ITEM-15).
   *
   * The seam this variant was reserved for by name: *"a future membership-aware key … can be
   * added as a new `Channel` variant without reshaping `stream()`"*. It carries an ORDERED LIST
   * of segments; each names the parent channel whose bytes it is a subset of plus the membership
   * that says WHICH rows — so a source that serves it reads each parent's chunks, keeps only that
   * segment's member rows, and emits the segments IN THE DECLARED ORDER as one row sequence.
   */
  | { readonly kind: 'members'; readonly members: MembersRef }

/**
 * The channels a {@link Channel} of kind `members` may gather. Each is addressed PER ROW of the
 * axis the membership indexes, which is what makes a positional gather mean anything; the
 * catalog-only kinds (`image`, `tableColumn`, `pointIds`) are absent by construction.
 *
 * ── WHY `value` IS GATHERABLE, AND WHAT IT EMITS (dimension-membership ITEM-16) ──────────────
 *
 * A `value` channel is ONE COLUMN of a sparse matrix, addressed `<artifactId>#<colIndex>`. Its
 * UNGATHERED wire form is the CSC framing (`u32 n | u32[n] row | f32[n] value`) — a scatter of
 * non-zeros carrying the ROW NUMBERS they sit at. A GATHERED one may not keep that framing: the
 * gather RE-INDEXES rows (member *k* becomes row *k*), so a surviving CSC row index would address
 * the PARENT's row space from inside the coordinate's — the off-by-thousands paint this whole
 * model exists to make impossible. A gathered `value` segment therefore emits DENSE f32, one
 * value per member, absent rows zero, exactly as {@link kind} `continuous` does. That is not a
 * convenience: densification is part of what a gather MEANS here.
 *
 * This is the CORRESPONDENCE's byte arm (INV-6): two segments of one gathered column may name
 * two DIFFERENT matrices at two DIFFERENT column indices — one logical ENTRY of a sibling axis is
 * column *i* of ds1's matrix and column *j* of ds2's — joined by index PAIRS rather than by a
 * shared membership.
 */
export type GatherableChannel =
  | { readonly kind: 'continuous'; readonly key: string }
  | { readonly kind: 'categorical'; readonly key: string }
  | { readonly kind: 'value'; readonly key: string; readonly layer?: string }

/**
 * WHICH MEMBERS of WHICH axes, AND IN WHAT ORDER — the gather's whole reference (ITEM-11/15).
 *
 * ── WHY THIS IS AN ORDERED LIST AND NOT A TRIPLE ────────────────────────────────────────────
 *
 * INV-7: *"Membership is a **set**; a coordinate's rows are a **sequence**. … Across two axes the
 * **segment order must be declared**."* A coordinate that rests on two axes has rows from both,
 * and there is no order implicit in either membership — a set has none. So the order is carried
 * here, DECLARED by the anchor (its `structure.memberships` array order), and a source may not
 * invent one: sorting the segments by axis identity, by dataset name, or by anything else yields
 * the right NUMBER of rows in the wrong SEQUENCE, which paints a plausible picture that is
 * silently permuted against the positions beside it. Every count still agrees, which is why this
 * is asserted rather than documented.
 *
 * A one-axis gather is the one-segment case; nothing about it is special-cased.
 */
export interface MembersRef {
  /** the segments, IN THE ORDER THE ANCHOR DECLARED THEM. Never empty, and never reordered by a
   *  consumer — the emitted row sequence is these segments concatenated in exactly this order. */
  readonly segments: readonly MemberSegment[]
}

/**
 * ONE segment of a gather — a parent column, and WHICH of its rows (INV-4: a structured record,
 * never a delimited string).
 *
 * The components stay independently readable, so an id containing `:`, `/` or `|` — all of which
 * a real dataset id carries — round-trips through a declaration, a channel key and a selected
 * value with nothing to re-split. `alignedTo` NAMES THE AXIS by its identity and never by an
 * ordinal into a declared collection.
 */
export interface MemberSegment {
  /**
   * The parent channel this segment's bytes are a subset of.
   *
   * PER SEGMENT rather than per channel, because two segments of one gathered column can have
   * two different parents: an integrated coordinate's segment A is described by one dataset's
   * column and segment B by another's. Deliberately a NARROW channel rather than `Channel`: a
   * gather of a gather has no meaning (a membership's positions are into the AXIS, not into
   * another subset), and allowing it would make that expressible.
   */
  readonly of: GatherableChannel
  /** the axis's IDENTITY — its key artifact's `key_sequence_digest`. Never a label, never an
   *  index. A source refuses the segment when its parent column is aligned elsewhere. */
  readonly alignedTo: string
  /** the artifact whose declaration this membership came from, and which holds the index body. */
  readonly artifact: string
  /** the member within that artifact holding the ascending `uint32` gather list. */
  readonly member: string
  /** how many members — the length THIS SEGMENT contributes to the gathered column. */
  readonly count: number
}

/** Per-`stream` options — cancellation only (the viz bumps `signal` on data-change / unmount). */
export interface StreamOptions {
  readonly signal?: AbortSignal
}

/**
 * The single data source the viz renders against (DEC-2). `catalog()` is the control plane (small
 * JSON, drives the pickers + carries the streaming metadata); `stream(channel)` is the data plane —
 * EVERY bulk read, always a chunk stream. A `resolveDataset(id) => StreamingSource` (id-based, DEC-1)
 * supplies multi-dataset workspaces.
 */
export interface StreamingSource {
  catalog(): Promise<DatasetCatalog>
  stream(channel: Channel, opts?: StreamOptions): AsyncIterable<Uint8Array>
  /**
   * OPTIONAL Viv resolution pyramid, mirroring `DataSource.imagePixelSource` exactly (#159).
   *
   * ── WHY A PYRAMID IS NOT A BYTE CHANNEL ──────────────────────────────────────────────────
   * Everything else here is bytes because everything else is ONE contiguous buffer whose shape
   * the catalog can describe. A pyramid is not: it is a LAZY, RANDOM-ACCESS reader that issues
   * its own range reads per tile, per level, on demand from the viewport. Serializing it into a
   * `stream()` would mean either fetching every tile of every level up front — the whole-object
   * read `docs/design/spatial-storage-layout.md` §2.4 exists to prevent — or inventing a second
   * request protocol on top of the one the reader already speaks. So it rides as an object, the
   * same way `graphs` rides on the catalog rather than as bytes (DEC-8).
   *
   * ── WHY IT IS HERE AND NOT ONLY ON `DataSource` ──────────────────────────────────────────
   * Because `DataSource` is not what production hands the grid. The app builds
   * `asDataSource(streamingSource)` and gives the grid THAT (`projectSources.ts`), and
   * `DatasetStore` wraps the same streaming source a second time. A pyramid that exists only on
   * the pull class is therefore invisible to every renderer — which is the state this seam was
   * in before #159. ABSENT ⇒ `asDataSource` leaves the key ABSENT too, and the raster pane falls
   * back to the single-texture `imageUnderlay()` byte channel, unchanged.
   */
  imagePixelSource?(): Promise<PixelSource<['c']>[]>
  /**
   * OPTIONAL resolved label mask, mirroring `DataSource.imageLabelMask` exactly (#159).
   *
   * Declared and forwarded even though no production source implements one today: the forwarding
   * is the half that lives in shared code, and leaving it out would mean the first label-mask
   * producer has to reopen the adapter, the filter wrapper AND this interface to be seen. See
   * this item's DEC-4 for why the producing half is not here yet — briefly, a label raster's
   * producer-declared structure is byte-identical to an intensity raster's, so a consumer
   * dispatching on the declaration cannot tell them apart.
   */
  imageLabelMask?(params?: { readonly cellId: string }): Promise<LabelMaskData> | LabelMaskData | null
}

/** Resolve a dataset id → its streaming source (id-based multi-dataset seam, DEC-1). */
export type StreamingResolver = (id: string) => StreamingSource | Promise<StreamingSource>

/**
 * Wrap a RESIDENT typed array as a ONE-CHUNK byte stream (ITEM-10). So even in-memory data flows the
 * streaming path — there is no non-streaming entry. The bytes are the array's raw little-endian view
 * (a `Float32Array` of positions/continuous/value-dense, a `Uint16Array` of categorical codes /
 * packed positions, a `Uint32Array` of pointIds). Structured residents (a `DataTable` / `ImageUnderlay`
 * / sparse `SparseColumn`) implement `stream()` per channel instead — there is no single typed-array
 * form for them.
 */
export async function* fromArray(
  typed: Float32Array | Uint16Array | Uint32Array,
): AsyncIterable<Uint8Array> {
  yield new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
}

/** Collect a channel stream into one contiguous `Uint8Array` (the bulk-decode fallback + test oracle). */
export async function collectStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
