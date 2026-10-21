// workbenchStreamingSource.ts — the APP's `StreamingSource` (ITEM-1..7).
//
// viz's data plane is `stream(channel) → AsyncIterable<Uint8Array>` and its control plane is
// `catalog()`. This is the app's implementation of that contract over the workstore's Zarr
// artifacts. It COMPOSES with `WorkbenchDataSource` rather than replacing it — the pull methods
// stay, every existing reader keeps working, and this adds the chunk-granular path beside them.
//
// ── WHY THE APP OWNS IT (INV-7) ────────────────────────────────────────────────────
//
// viz ships `streamBinaryColumn` (`viz-core/data/fetchStream.ts`), which takes a bare `fetch`
// with no bearer, no credentials and no base URL. The artifact byte route is gated
// `RequirePermissions<(ProjectsUse,)>` plus per-artifact scope resolution, so that function can
// only ever produce a 401 against it. Every byte here therefore travels
// `artifactStore` → `binaryClient` → `ApiClient.Workstore.*`, which is where auth, the base URL,
// the silent 401-refresh and `?range=` live. `typedRead.test.ts`'s guard (TEST-41) fails if any
// module under `core/workstore/` grows its own transport, and TEST-4 pins the other half: with
// `globalThis.fetch` replaced by a throwing stub, every channel still streams.
//
// ── WHAT ACTUALLY STREAMS, AND WHAT ONLY WEARS THE SHAPE (INV-1) ───────────────────
//
//   positions   — genuinely chunked. One inner chunk per yield, row-aligned by construction.
//   continuous  — genuinely chunked. Same mechanism at stride 4.
//   categorical — ONE chunk. The codes are read whole; the level set rides `catalog()` (DEC-8),
//                 so a consumer can label chunk 0 without waiting for the stream to end.
//   value (CSC) — ONE chunk, and INV-5 says it must STAY one: a 20k×10M matrix is a
//                 random-access resource, so this is a bounded `indptr[col..col+2]` window plus
//                 two element ranges — never a stream over the matrix.
//
// The two one-chunk channels are not a shortfall to be fixed later. They are DEC-2's forcing
// function: there is no non-streaming ENTRY, so the progressive path is the only path and a
// channel added later cannot quietly bypass it. TEST-2 enumerates the channels from the CATALOG
// for exactly that reason — a channel with no `stream()` arm fails rather than going unnoticed.
//
// ── THE MULTICAST (ITEM-6), AND WHY IT COUNTS DECODES ──────────────────────────────
//
// viz reads a colour column two or three times per colour change and opens a second pane on the
// same coordinate artifact without re-deriving anything. Artifact bytes are served `immutable`,
// so a duplicate READ usually issues no second request — and still pays a full inflate +
// unshuffle. A request-count guard reads 1 for both the shared case and the repeated one and
// passes while the thing it protects is broken. So the unit of account here is the DECODE
// (`core/workstore/decodeCounter.ts`), and the mechanism is an in-flight multicast: a consumer
// arriving mid-stream receives the chunks already emitted and then the live tail, off ONE read.

import {
  NotReachableError,
  WorkbenchDataSource,
  parseChannelKey,
  type WorkbenchDataSourceDeps,
} from './workbenchDataSource'
import {
  assertMembershipOnParentAxis,
  readCategoricalColumn,
  readDeclaredLevels,
  readMemberIndex,
  streamGatheredNumericBytes,
  readSparseColumn,
  resolveMember,
  streamNumericBytes,
  streamPositionBytes,
  toUint16Codes,
  type ArtifactStructure,
  type ZarrTableStructure,
} from '@/core/workstore'
import type {
  Channel,
  DatasetCatalog,
  GatherableChannel,
  MemberSegment,
  MembersRef,
  StreamOptions,
  StreamingSource,
} from '@ziee/viz'

/** One catalog row. Named off {@link DatasetCatalog} rather than imported, because viz's barrel
 *  publishes the catalog and not its element type — and reaching past the barrel into
 *  `viz-core/data/wire` for one alias would make this module depend on viz's internal layout. */
type CatalogEntry = DatasetCatalog['layouts'][number]

/** How many bytes of COMPLETED channel streams to retain for replay. A second pane opening on a
 *  coordinate artifact after the first finished must not re-decode it (INV-2/INV-6), which means
 *  the bytes have to still be here. Bounded because a session sweeps many columns: 128 MB is ~16
 *  full 1M-row 2-D layouts, and eviction is oldest-first. In-FLIGHT entries are never evicted —
 *  they have live consumers. */
const REPLAY_BUDGET_BYTES = 128 * 1024 * 1024

// ── DEBUG-ONLY: the inter-chunk ARRIVAL DELAY seam (owner-granted 2026-08-16) ────────────────────
//
// WHAT IT FIXES, MEASURED RATHER THAN ASSUMED. TEST-24's two legs both turned on whether React
// COMMITS between two chunk arrivals, and on a localhost read of a 4-chunk fixture the four
// arrivals can land inside ONE task — so React commits once, and the committed state is already
// the post-`done` `null`. Two consequences were measured on this branch:
//
//   · the PRESENCE leg was flaky at ~1 in 3 — the indicator was sometimes never observable at all.
//     Not a timeout problem (the timeout was 60s and the read finishes in well under a second), so
//     no amount of waiting fixes it.
//   · the ABSENCE leg's control did NOT go red: with `MIN_CHUNKS_TO_SHOW = 1` the single-chunk read
//     STILL showed nothing, because its one arrival and its `done` land in the same task. The leg
//     was therefore green for a reason other than the rule it claims to test.
//
// Spacing the arrivals makes both deterministic: the presence leg observes a commit because there
// IS one, and the absence leg's control now genuinely exercises the threshold, because the
// single-chunk read's one arrival gets its own commit before `done`.
//
// GATED exactly like `window.__cyto_read` / `window.__cyto_count_decodes`: the Vite dev server or
// the e2e preview build's `VITE_ENABLE_TEST_SEAMS=1`. Both fold to constants at build time, so a
// release bundle drops the read and `delayBetweenChunks` becomes an unconditional no-op.
//
// Read PER CHUNK from a plain window variable rather than through a setter, for the same reason
// `__cyto_count_decodes` is: a spec sets it in `addInitScript`, before any app module has run, so
// there is no ordering race between arming the seam and the first read starting.
const DELAY_SEAM_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS)

/** The configured inter-chunk delay in ms, or 0. Never negative, never NaN — a spec that sets
 *  nonsense gets the production behaviour rather than a hang. */
function chunkArrivalDelayMs(): number {
  if (!DELAY_SEAM_ENABLED || typeof window === 'undefined') return 0
  const raw = (window as unknown as { __cyto_stream_chunk_delay_ms?: unknown }).__cyto_stream_chunk_delay_ms
  const ms = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 5_000) : 0
}

/** Await the configured inter-chunk delay. Resolves IMMEDIATELY (no timer, no extra task) when the
 *  seam is off or unset, so the production read is byte-for-byte the read it was. */
function delayBetweenChunks(): Promise<void> | undefined {
  const ms = chunkArrivalDelayMs()
  return ms > 0 ? new Promise<void>(resolve => setTimeout(resolve, ms)) : undefined
}

/**
 * ITEM-19 — what the coverage indicator is fed from.
 *
 * Deliberately the APP's own count, not viz's `onProgress`: that prop is plumbed only on the
 * `<Viz data>` path and the GRID has no such channel, so routing it out of the grid would open
 * another viz file for a number this source already knows.
 */
export interface StreamProgress {
  /** the multicast key — `<kind>\n<...>`, one per `(dataset, channel)`. */
  readonly key: string
  readonly kind: Channel['kind']
  /** chunks that have ARRIVED. This is the honest "can this fill progressively at all" signal:
   *  a read that completes in ONE chunk never reaches 2, which is what keeps the indicator ABSENT
   *  for the sub-8192-row case rather than flashing a full bar at it. */
  readonly chunks: number
  readonly bytesSeen: number
  /** rows seen, for the fixed-stride kinds; `null` where the wire has no fixed bytes-per-row. */
  readonly rowsSeen: number | null
  /** the catalog's `pointCount`, or `null` before the catalog has resolved. */
  readonly totalRows: number | null
  /** SETTLED — the read will produce no further bytes. True for a completed read AND for a failed
   *  one: an indicator whose only terminal signal is success sticks at whatever fraction the read
   *  reached when it died, forever. */
  readonly done: boolean
  /** …and WHY it settled. Optional and additive: a consumer that ignores it simply stops showing
   *  progress on failure (the fix) rather than sticking; one that reads it can say so. */
  readonly failed?: boolean
}

/** Bytes per ROW on the wire, for the kinds whose stride is fixed. `value` (sparse CSC) and
 *  `image` have no per-row stride, so they report `rowsSeen: null` rather than a made-up number. */
const BYTES_PER_ROW: Partial<Record<Channel['kind'], number>> = {
  positions: 8, // interleaved xy f32 — the same stride the catalog declares
  continuous: 4, // dense f32
  // u16 codes — the width `#categoricalBytes` narrows to via `toUint16Codes`, which is what the
  // GPU consumer packs to. This said `4` ("u32 codes"), describing the DECODED form rather than
  // the bytes that go on the wire, so a completed categorical read reported exactly half its rows
  // and the coverage indicator sat at 50% on a finished column.
  categorical: 2,
  pointIds: 4, // u32 ids
}

/** A channel's bytes, and everyone reading them. ONE of these per `(dataset, channel)` — it is
 *  what makes a second consumer JOIN rather than start a second read. */
interface ChannelStream {
  readonly key: string
  /** the channel this entry serves — carried rather than re-derived from `key`, because a
   *  gather's progress is denominated on the CHANNEL's own segment counts (ITEM-15) and the key
   *  is opaque by contract (ITEM-17): parsing it back apart to find them is the one thing
   *  nothing here may do. */
  readonly channel: Channel
  /** every chunk emitted so far, in order. Replayed to a consumer that arrives late. */
  readonly chunks: Uint8Array[]
  bytes: number
  /** ITEM-19: chunks ARRIVED (not chunks buffered — an evicted replay would understate it). */
  arrived: number
  done: boolean
  failure: unknown
  /** woken whenever a chunk lands or the stream settles. */
  waiters: Array<() => void>
  /** live consumers. At zero, an UNFINISHED stream is aborted + evicted (ITEM-7). */
  consumers: number
  readonly abort: AbortController
}

/** The reads this source performs, injected so a test drives the octet boundary and never the
 *  decode logic — the same rule `WorkbenchDataSourceDeps` states. */
export interface WorkbenchStreamingDeps {
  /** interleaved `[x0,y0,…]` f32 wire bytes, one yield per inner chunk. */
  streamPositions(
    artifactId: string,
    structure: ArtifactStructure,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>
  /** dense f32 wire bytes, one yield per inner chunk. */
  streamNumeric(
    artifactId: string,
    structure: ArtifactStructure,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>
  /** codes + the level set, whole (the categorical channel is one chunk by design). */
  readCategorical(
    artifactId: string,
    structure: ArtifactStructure,
    column?: string,
  ): Promise<{ codes: Uint32Array; categories: string[] }>
  /** one CSC column's non-zeros, over the bounded `indptr` window (INV-5). */
  readSparse(
    artifactId: string,
    col: number,
    structure: ArtifactStructure,
  ): Promise<{ row: Uint32Array; value: Float32Array }>
  /** the producer's DECLARED level set for one member, or `undefined` when it declared none.
   *  Costs one `zarr.json` open, which the stream that follows reuses out of the shared
   *  `MEMBER_ARRAYS` cache. */
  declaredLevels(
    artifactId: string,
    memberPath: string,
    structure: ArtifactStructure,
  ): Promise<readonly string[] | undefined>
  /** ITEM-3 — one member INDEX BODY, whole (the gather list). MEMBER-count long, not the
   *  parent's length. Ascending by default (the subset one-pass guard); `ordered: false` reads a
   *  CORRESPONDENCE sequence body, which is a declared permutation (INV-6 / INV-7) consumed only
   *  by a random-access gather. */
  readMembers(
    artifactId: string,
    structure: ArtifactStructure,
    member: string,
    ordered?: boolean,
  ): Promise<Uint32Array>
  /** ITEM-14 — the parent's chunks, filtered to the member rows on arrival. */
  streamGathered(
    artifactId: string,
    structure: ArtifactStructure,
    members: Uint32Array,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>
}

function defaultStreamingDeps(): WorkbenchStreamingDeps {
  return {
    streamPositions: (artifactId, structure, signal) =>
      streamPositionBytes(artifactId, structure, undefined, { signal }),
    streamNumeric: (artifactId, structure, signal) =>
      streamNumericBytes(artifactId, structure, undefined, { signal }),
    readMembers: (artifactId, structure, member, ordered = true) =>
      readMemberIndex(artifactId, structure, member, {}, ordered),
    streamGathered: (artifactId, structure, members, signal) =>
      streamGatheredNumericBytes(artifactId, structure, members, undefined, { signal }),
    readCategorical: (artifactId, structure, column) =>
      readCategoricalColumn(artifactId, structure, column),
    readSparse: (artifactId, col, structure) => readSparseColumn(artifactId, col, structure),
    declaredLevels: async (artifactId, memberPath, structure) => {
      // The member row's own `levels` first (free — the structure is already in hand); then the
      // array's `attributes.cyto.levels`, which is where a producer that outgrew the manifest
      // cap puts them. Absence is an answer, not an error: a `string` column legitimately has
      // no declared level set (see `categoriesFor`).
      const declared = declaredMemberLevels(structure, memberPath)
      if (declared) return declared
      return readDeclaredLevels(artifactId, memberPath)
    },
  }
}

/** The member row's inline level set, when the producer still writes one. */
function declaredMemberLevels(
  structure: ArtifactStructure,
  memberPath: string,
): readonly string[] | undefined {
  if (structure.encoding !== 'zarr_v3') return undefined
  const members = (structure as ZarrTableStructure).columns ?? (structure as ZarrTableStructure).arrays
  const hit = members?.find(m => m.path === memberPath)
  return hit?.levels
}

/** The CSC value wire framing: `u32 n | u32[n] row | f32[n] value`, little-endian
 *  (`viz-core/data/wire.ts`). Built once from the bounded range read — the wire format is the
 *  viz contract, and producing it here is what lets the ONE decoder in viz serve both sources. */
function encodeSparseWire(row: Uint32Array, value: Float32Array): Uint8Array {
  const n = row.length
  const out = new Uint8Array(4 + n * 8)
  new DataView(out.buffer).setUint32(0, n, true)
  out.set(new Uint8Array(row.buffer, row.byteOffset, n * 4), 4)
  out.set(new Uint8Array(value.buffer, value.byteOffset, n * 4), 4 + n * 4)
  return out
}

/** A stable cache key for a channel. Built from the channel's OWN fields, never by parsing a
 *  composed id back apart — the key is opaque to the cache, which is what lets a future
 *  membership-aware `Channel` variant land without reshaping any of this. */
function channelKey(channel: Channel): string {
  switch (channel.kind) {
    case 'positions':
      return `positions\n${channel.layout}`
    case 'value':
      return `value\n${channel.key}\n${channel.layer ?? ''}`
    case 'categorical':
      return `categorical\n${channel.key}`
    case 'continuous':
      return `continuous\n${channel.key}`
    case 'pointIds':
      return `pointIds\n${channel.layout ?? ''}`
    case 'tableColumn':
      return `tableColumn\n${channel.name}\n${channel.column}`
    case 'image':
      return 'image'
    case 'members':
      // Built from the channel's OWN FIELDS (ITEM-17), exactly as every arm above is: each
      // SEGMENT's parent key, then its membership's components in their own right. Nothing
      // splits, parses or reconstructs this string — the cache treats it as opaque — so a
      // dataset id carrying `:`, `/` or `|` needs no escaping and no delimiter is load-bearing.
      //
      // The segments are joined IN THEIR DECLARED ORDER and NOT sorted (ITEM-11): two gathers
      // over the same segments in two different orders are two different row sequences, so they
      // must be two different cache entries. An order-insensitive key would serve the second
      // consumer the first's bytes — the silent permutation, delivered by the cache.
      return [
        'members',
        ...channel.members.segments.flatMap(s => [
          s.of.kind,
          s.of.key,
          s.alignedTo,
          s.artifact,
          s.member,
        ]),
      ].join('\n')
    default: {
      const never: never = channel
      throw new Error(`unhandled channel ${JSON.stringify(never)}`)
    }
  }
}

/**
 * A `value` channel key, split ONCE (ITEM-16).
 *
 * TWO readers need this — the plain `value` channel and a gathered `value` SEGMENT — and they
 * must split it identically. Two copies of "where does the artifact id end, and what counts as a
 * column index" drift the moment one of them is relaxed: the laxer reader accepts a key the
 * stricter one refuses, and the disagreement surfaces as a channel that streams from one entry
 * point and throws from the other over the same bytes. So there is one parser and both call it.
 */
function parseValueKey(key: string): { artifactId: string; col: number } {
  const { artifactId, column } = parseChannelKey(key)
  const col = Number(column)
  if (!key.includes('#') || !artifactId || column === '' || !Number.isFinite(col)) {
    throw new WorkbenchStreamingError(`value column key "${key}" must be "<artifactId>#<colIndex>"`)
  }
  return { artifactId, col }
}

/**
 * The ARTIFACT a gatherable channel's bytes come from — which is NOT its key (ITEM-16).
 *
 * `continuous` is keyed on the artifact id itself; `categorical` and `value` are keyed on the
 * COMPOSITE `<artifactId>#<column>` the catalog mints. A gather resolves the artifact FIRST,
 * because everything it then does — reading the declaration, checking the membership's axis
 * (ITEM-12) — is a question about the ARTIFACT and never about the key. Handing the composite
 * key to `structureFor` looks up an artifact whose id ends in `#0`, and finds nothing.
 */
function gatherParentArtifact(of: GatherableChannel): string {
  switch (of.kind) {
    case 'continuous':
      return of.key
    case 'categorical':
      return parseChannelKey(of.key).artifactId
    case 'value':
      return parseValueKey(of.key).artifactId
    default: {
      const never: never = of
      throw new Error(`unhandled gatherable channel ${JSON.stringify(never)}`)
    }
  }
}

/** Bytes per ROW of a GATHERED segment. A gather DENSIFIES (`value`'s CSC scatter becomes one f32
 *  per member — see {@link GatherableChannel}), so a gathered stride is not always the ungathered
 *  channel's, and {@link BYTES_PER_ROW} — which describes the UNGATHERED wire — cannot answer for
 *  it. `value` has no ungathered per-row stride at all and is absent from that table, so reading
 *  it there reports a finished gathered column as `rowsSeen: null` forever. */
function gatheredBytesPerRow(kind: GatherableChannel['kind']): number | undefined {
  return kind === 'value' ? 4 : BYTES_PER_ROW[kind]
}

/**
 * A gather emits ONE column, so every segment must put the SAME WIRE KIND on it (ITEM-15).
 *
 * Concatenating a `categorical` segment's u16 codes onto a `continuous` segment's f32 values
 * produces a byte run that decodes — as the wrong thing, at the wrong stride, for the whole
 * tail. Nothing downstream can detect it: the bytes are present, the length is plausible, and
 * the codes it invents are all in range. Refused here, where the two kinds are both in hand.
 */
function assertOneWireKind(ref: MembersRef): void {
  if (ref.segments.length === 0) {
    throw new WorkbenchStreamingError('a gather was requested with no segments — nothing to read')
  }
  const first = ref.segments[0].of.kind
  for (const segment of ref.segments) {
    if (segment.of.kind !== first) {
      throw new WorkbenchStreamingError(
        `a gather cannot concatenate a "${first}" segment with a "${segment.of.kind}" one — ` +
          'one gathered column carries one wire kind',
      )
    }
  }
}

/** The gathered column's TOTAL length — the sum of the segments' member counts (ITEM-15).
 *  This is what a gather's progress is denominated on; the parents' lengths are not it. */
function gatheredRowCount(ref: MembersRef): number {
  let total = 0
  for (const segment of ref.segments) total += segment.count
  return total
}

/** The abort every cancelled read raises, so a consumer can tell cancellation from failure. */
function abortError(): DOMException {
  return new DOMException('the channel stream was aborted', 'AbortError')
}

/**
 * The app's {@link StreamingSource}: `catalog()` from {@link WorkbenchDataSource} (the same four
 * channels, the same composite keys), `stream()` over the workstore's chunk reader.
 */
export class WorkbenchStreamingSource implements StreamingSource {
  readonly #pull: WorkbenchDataSource
  readonly #deps: WorkbenchStreamingDeps
  readonly #streams = new Map<string, ChannelStream>()
  /** The decoded categorical, shared between `catalog()`'s level-set resolution and the byte
   *  stream. Without this the observed-levels path would decode the column twice — once to name
   *  the categories and once to serve the codes — which is exactly the duplicate ITEM-6 exists to
   *  remove, arriving through the back door. */
  readonly #categoricalReads = new Map<
    string,
    Promise<{ codes: Uint32Array; categories: string[] }>
  >()
  /** RESOLVED bytes per cached categorical read — the retention `#evict` was not counting.
   *  Written when a read settles (a pending read has no size to charge yet), deleted with its
   *  entry, so the two maps cannot disagree about what is held. */
  readonly #categoricalHeldBytes = new Map<string, number>()
  #catalogCache?: Promise<DatasetCatalog>
  /** ITEM-19 progress observers. Read-only fan-out; a throwing observer must never break a read. */
  readonly #progressObservers = new Set<(p: StreamProgress) => void>()
  /** `catalog().pointCount` once resolved — read synchronously by the progress fan-out, which
   *  cannot await. `null` until the catalog lands, and the indicator simply has no denominator
   *  until then (it reports `totalRows: null` rather than guessing one). */
  #totalRows: number | null = null

  /** The retention ceiling this instance enforces. Constructor-overridable ONLY so a test can
   *  drive eviction with kilobytes instead of allocating 128 MB; production never passes it. */
  readonly #replayBudgetBytes: number

  constructor(
    projectId: string,
    options: {
      pull?: WorkbenchDataSource
      deps?: Partial<WorkbenchStreamingDeps>
      pullDeps?: Partial<WorkbenchDataSourceDeps>
      replayBudgetBytes?: number
    } = {},
  ) {
    this.#pull = options.pull ?? new WorkbenchDataSource(projectId, options.pullDeps ?? {})
    this.#deps = { ...defaultStreamingDeps(), ...options.deps }
    this.#replayBudgetBytes =
      typeof options.replayBudgetBytes === 'number' && options.replayBudgetBytes > 0
        ? options.replayBudgetBytes
        : REPLAY_BUDGET_BYTES
  }

  /**
   * The control plane. Delegates to the pull source and then adds what a HEADERLESS byte stream
   * cannot self-describe (DEC-8/DEC-10):
   *
   *   • per-layout `encoding` — every layout here streams interleaved f32 xy at stride 8.
   *   • per-categorical `categories` — the level set, which travels on the catalog rather than
   *     in the byte stream so a consumer can label chunk 0 immediately (TEST-9).
   *
   * COST, stated rather than buried. A `categorical` member declares its levels, so resolving it
   * is one cached `zarr.json` open that the stream then reuses — no data bytes. A member with NO
   * declared level set (a `string` column; a numeric column coloured categorically) has none to
   * read: its categories only exist once the values have been seen, so that entry is resolved by
   * reading the column — through this source's own cache, so the `stream()` that follows costs
   * ZERO additional decodes. The declared path is the one every `cyto_columns` categorical takes.
   */
  catalog(): Promise<DatasetCatalog> {
    if (!this.#catalogCache) {
      const building = this.#buildCatalog()
      // A FAILED catalog must not be remembered — the rule `#streams` and `#categoricalReads`
      // already follow, and the one this memo was missing. Caching the rejected promise made any
      // single failing member permanent for the life of the tab: the caller retries, gets the same
      // rejection with no new request issued, and (because `asDataSource` memoizes this source and
      // `buildProjectSources` memoizes that per `(broker, project)`) the whole streaming canvas
      // stays down for the project until a full page reload.
      building.catch(() => {
        if (this.#catalogCache === building) this.#catalogCache = undefined
      })
      this.#catalogCache = building
    }
    return this.#catalogCache
  }

  async #buildCatalog(): Promise<DatasetCatalog> {
    const base = await this.#pull.catalog()
    const layouts: CatalogEntry[] = base.layouts.map(l => ({
      ...l,
      encoding: { kind: 'f32', stride: 8 } as const,
    }))
    const categoricalColumns = await Promise.all(
      base.categoricalColumns.map(async c => ({
        ...c,
        categories: await this.#categoriesFor(c.id),
      })),
    )
    this.#totalRows = typeof base.pointCount === 'number' ? base.pointCount : null
    return { ...base, layouts, categoricalColumns }
  }

  /** The level set for one categorical channel key — declared where a declaration exists, else
   *  the observed set the codes are already coded against. Never invented, and never `[]` as a
   *  stand-in for "did not look": an empty label set renders every point as an unnamed category,
   *  which is a plausible picture with nothing raised. */
  async #categoriesFor(key: string): Promise<readonly string[]> {
    const { artifactId, column } = parseChannelKey(key)
    const structure = await this.#pull.structureFor(artifactId)
    const member = resolveMember(artifactId, asTable(artifactId, structure), column || undefined)
    const declared = await this.#deps.declaredLevels(artifactId, member.path, structure)
    if (declared) return [...declared]
    // No declaration ⇒ the categories ARE the observed values, so they cost the read. It is the
    // same read `stream()` will serve, taken through the same cache — one decode, not two.
    const decoded = await this.#categoricalRead(key)
    return decoded.categories
  }

  /**
   * ITEM-19 — observe byte arrival, per `(dataset, channel)`. Returns an unsubscribe.
   *
   * Read-only: an observer sees what already happened and cannot influence the read. It fires on
   * every arrived chunk and once more when the stream settles, so a consumer can distinguish
   * "still arriving" from "finished" without polling.
   */
  onProgress(observer: (p: StreamProgress) => void): () => void {
    this.#progressObservers.add(observer)
    return () => {
      this.#progressObservers.delete(observer)
    }
  }

  #emitProgress(entry: ChannelStream): void {
    if (this.#progressObservers.size === 0) return
    const channel = entry.channel
    const kind = channel.kind
    // ITEM-15 — A GATHER IS DENOMINATED ON ITS OWN LENGTH, NOT ITS PARENTS'.
    //
    // A gathered column's stride is its SEGMENTS' wire kind (they all share one, asserted at
    // read time), and its total is the sum of the segment counts — the gathered length. Left on
    // the parents' accounting a subset of 6,000 rows out of a 1,000,000-row parent reports
    // `0 / 1,000,000` and completes at well under one percent: a progress bar that stalls near
    // zero and then finishes, which every assertion on the final VALUES passes straight over.
    const perRow =
      channel.kind === 'members'
        ? gatheredBytesPerRow(channel.members.segments[0]?.of.kind ?? 'continuous')
        : BYTES_PER_ROW[kind]
    const p: StreamProgress = {
      key: entry.key,
      kind,
      chunks: entry.arrived,
      bytesSeen: entry.bytes,
      rowsSeen: perRow ? Math.floor(entry.bytes / perRow) : null,
      totalRows: channel.kind === 'members' ? gatheredRowCount(channel.members) : this.#totalRows,
      done: entry.done || entry.failure !== undefined,
      failed: entry.failure !== undefined,
    }
    for (const observer of this.#progressObservers) {
      try {
        observer(p)
      } catch {
        // An indicator that throws must not fail the read it is only WATCHING.
      }
    }
  }

  /**
   * The data plane. Every channel, always a chunk stream (INV-1).
   *
   * `opts.signal` is honoured per CONSUMER: aborting one ends ITS iteration and, when it was the
   * last consumer of an unfinished read, cancels the underlying range reads too. A consumer
   * walking away must never tear down a multicast others are still reading (INV-4 vs ITEM-7 —
   * the interaction the plan audit flagged as this item's real risk).
   *
   * ── HOW FAR "CANCELS THE UNDERLYING READS" ACTUALLY REACHES ──────────────────────────────────
   * Stated exactly, because this sentence was previously true of the apparatus and false of the
   * behaviour: the signal was declared on `WorkbenchStreamingDeps`, threaded by
   * `defaultStreamingDeps`, and checked per chunk turn by `artifactReader.throwIfAborted` — while
   * BOTH `#produce` call sites omitted the argument, so nothing downstream ever saw a signal.
   *
   * With the argument passed, an abort reaches:
   *   ✓ the producing generator, at its next chunk turn (`throwIfAborted` in
   *     `streamPositionBytes`/`streamNumericBytes`) — so no further chunk is decoded, copied,
   *     or handed on, and no further chunk fetch is SCHEDULED;
   *   ✓ `#pump`, which stops appending to the replay buffer.
   *
   * It does NOT reach:
   *   ✗ an in-flight HTTP body. `ZarrArray.chunks()` takes no signal, and `streamingShard`
   *     (`zarrReader.ts`) has no cancel path at all — no `reader.cancel()`, no `releaseLock()`,
   *     no abort check, and `ShardSource` has no `dispose`. A shard already being read keeps
   *     arriving and its buffer keeps growing until the body ends.
   *   ✗ the transport. The SDK's `callAsync`/`performCall` accept no `AbortSignal` for
   *     `responseType: 'stream'`, so the request cannot be cancelled at source.
   * Closing either needs a design decision that is not this module's to make (a shard source is
   * SHARED between reads, so one consumer's abort must not cancel a shard another is waiting on),
   * plus an SDK change. Do not upgrade this comment to a stronger claim without that work.
   */
  stream(channel: Channel, opts?: StreamOptions): AsyncIterable<Uint8Array> {
    return this.#subscribe(
      channelKey(channel),
      channel,
      readSignal => this.#produce(channel, readSignal),
      opts?.signal,
    )
  }

  /** Route one channel to its byte producer. Exhaustive: a new `Channel` variant fails to
   *  compile here rather than silently falling through to an empty stream. */
  #produce(channel: Channel, readSignal: AbortSignal): AsyncIterable<Uint8Array> {
    switch (channel.kind) {
      case 'positions':
        return this.#positionBytes(channel.layout, readSignal)
      case 'continuous':
        return this.#continuousBytes(channel.key, readSignal)
      case 'categorical':
        return this.#categoricalBytes(channel.key)
      case 'value':
        return this.#valueBytes(channel.key)
      case 'members':
        return this.#gatheredBytes(channel.members, readSignal)
      // THE RASTER CHANNEL (#159). It used to refuse, and the refusal was correct only because
      // `catalog()` hardcoded `hasImage: false` — the comment below still records that reasoning
      // for the two channels it is still true of. Now that a project's raster IS advertised, this
      // arm has to serve, and the two edits are ONE change: advertising a channel whose producer
      // still refuses turns a never-reached error into a reachable one, and the adapter surfaces
      // it as a throwing `imageUnderlay()` on the object the grid holds.
      //
      // The bytes are the pull source's own reduction, so `asDataSource`'s reconstitution —
      // which pairs these bytes with `catalog().image`'s dimensions — describes exactly the
      // texture it is given. One chunk, because a texture is one buffer: there is no partial
      // state of an image that a consumer could paint.
      case 'image':
        return this.#imageBytes(readSignal)
      // The two channels this data plane does not serve. They are ABSENT from `catalog()`
      // (no `tables`, no `hasPointIds`), so nothing reaches them through the
      // adapter — and they refuse in the pull source's own taxonomy rather than returning empty
      // bytes, which would decode as a zero-length column instead of as "not here".
      case 'pointIds':
        return failing(new NotReachableError('canonical point ids'))
      case 'tableColumn':
        return failing(new NotReachableError(`table "${channel.name}"`))
      default: {
        const never: never = channel
        throw new Error(`unhandled channel ${JSON.stringify(never)}`)
      }
    }
  }

  /**
   * The raster underlay as ONE chunk of RGBA bytes — the pull source's reduction, verbatim.
   *
   * Takes the read signal like every other arm of the switch. It cannot cancel the decode itself
   * (the reduction is one `await` with no interior turn), but it does stop the bytes being
   * published to a subscriber that has gone away — a pane the user closed mid-decode.
   */
  async *#imageBytes(readSignal: AbortSignal): AsyncIterable<Uint8Array> {
    const underlay = await this.#pull.imageUnderlay()
    if (readSignal.aborted) throw abortError()
    yield underlay.data
  }

  /**
   * THE PYRAMID SEAM (#159), delegated to the pull source.
   *
   * Declared on `StreamingSource` and forwarded by `asDataSource`, which is the only reason it
   * reaches a renderer at all: production hands the grid `asDataSource(this)`, never this class
   * and never the pull source. A pyramid implemented only on the pull class is invisible.
   *
   * Not a byte channel, and that is a property of what a pyramid IS rather than a shortcut — it
   * is a lazy random-access reader that issues its own range reads per tile from the viewport,
   * so serializing it would mean fetching every tile of every level up front.
   */
  imagePixelSource(): ReturnType<WorkbenchDataSource['imagePixelSource']> {
    return this.#pull.imagePixelSource()
  }

  /**
   * A column GATHERED to a member subset (ITEM-12 / ITEM-14).
   *
   * Two things happen before a single parent byte is requested, in this order:
   *   1. the member INDEX BODY is read (a small `uint32` member, the MEMBER count long) and
   *      checked strictly ascending;
   *   2. the membership's axis is checked against the PARENT column's own declaration
   *      (ITEM-12). A mismatch throws, named, and the parent is never opened — an
   *      off-by-thousands gather is silent otherwise, because both declarations are
   *      well-formed and every byte is present.
   *
   * Then the parent is streamed CHUNK-WISE and each chunk is filtered on arrival, so retained
   * memory scales with the SUBSET (ITEM-14). A `collectStream`-then-filter implementation
   * returns identical final values, which is why the test measures during the stream.
   */
  /**
   * THE MEMBER INDEX BODY a gather reads by (ITEM-3) — public because the gather has TWO
   * consumers and only one of them is a channel.
   *
   * The byte route below serves a column that streams. A column that does NOT stream — a
   * categorical, an int, a multi-member table — is read whole by
   * `makeColumnarFrameReader`'s fallback, and that fallback has to gather too or the pane
   * paints a parent-length column against a subset's positions. Both need exactly the same
   * answer to "which positions", so there is ONE implementation of it and the fallback calls
   * this rather than re-deriving it from the inline set (which is absent above the producer's
   * budget, where the body is the authority).
   */
  async memberIndex(
    segment: Pick<MemberSegment, 'artifact' | 'member'>,
    opts: { ordered?: boolean } = {},
  ): Promise<Uint32Array> {
    const indexStructure = await this.#pull.structureFor(segment.artifact)
    return await this.#deps.readMembers(segment.artifact, indexStructure, segment.member, opts.ordered ?? true)
  }

  /**
   * The gathered row sequence — every segment, IN THE DECLARED ORDER (ITEM-15).
   *
   * Segment *k* is read from its OWN parent and emitted whole before segment *k+1* is opened, so
   * the concatenation is the emission order and nothing buffers a segment to reorder it later.
   * The declared order is honoured exactly as it arrives (ITEM-11); there is no sort here, and
   * adding one would produce the right number of rows in the wrong sequence.
   */
  async *#gatheredBytes(ref: MembersRef, readSignal: AbortSignal): AsyncIterable<Uint8Array> {
    assertOneWireKind(ref)
    for (const segment of ref.segments) {
      if (readSignal.aborted) throw abortError()
      yield* this.#segmentBytes(segment, readSignal)
    }
  }

  async *#segmentBytes(
    segment: MemberSegment,
    readSignal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const of = segment.of
    const members = await this.memberIndex(segment)
    // THE ARTIFACT, then its declaration, then the axis check — in that order (ITEM-16). A
    // `categorical`/`value` channel is keyed on a COMPOSITE `<artifactId>#<column>`, so the
    // artifact has to be resolved before either the structure read or ITEM-12's check can be
    // asked about it: the axis a membership must agree with is declared by the MATRIX (or the
    // table), never by the column key naming one of its columns.
    const parentArtifact = gatherParentArtifact(of)
    const parentStructure = await this.#pull.structureFor(parentArtifact)
    assertMembershipOnParentAxis(parentArtifact, parentStructure, segment.alignedTo)
    if (readSignal.aborted) throw abortError()
    if (of.kind === 'value') {
      // ITEM-16 — THE CORRESPONDENCE'S BYTE ARM, and it emits DENSE f32, not the CSC wire.
      //
      // The gather RE-INDEXES rows: member *k* becomes row *k*. A surviving CSC row index would
      // therefore address the PARENT's row space from inside the coordinate's — full-length,
      // well-typed, and wrong for every row — so the column is densified against the MEMBERS
      // here, where both the member list and the non-zeros are in hand. Absent rows are zero,
      // which is what a sparse column's absent rows already mean everywhere else on this path.
      const { col } = parseValueKey(of.key)
      const sparse = await this.#deps.readSparse(parentArtifact, col, parentStructure)
      const out = new Float32Array(members.length)
      // Both sides are ascending — `members` is checked ascending when the index body is read,
      // and a CSC column's `indices` window is ascending by the format's own rule — so this is
      // ONE merge pass, not a lookup per member over a map of the parent's non-zeros.
      let at = 0
      for (let i = 0; i < members.length; i++) {
        const row = members[i]
        while (at < sparse.row.length && sparse.row[at] < row) at++
        if (at < sparse.row.length && sparse.row[at] === row) out[i] = sparse.value[at]
      }
      yield new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      return
    }
    if (of.kind === 'categorical') {
      // The categorical read is whole-column by construction upstream (the level set has to be
      // resolved before a code means anything), so the gather here is a compaction of the
      // decoded codes rather than a per-chunk filter. It is the SAME member walk, and it is
      // stated rather than left to be inferred from the absence of a loop.
      const decoded = await this.#categoricalRead(of.key)
      const codes = toUint16Codes(decoded.codes, decoded.categories.length)
      const out = new Uint16Array(members.length)
      for (let i = 0; i < members.length; i++) out[i] = codes[members[i]]
      yield new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      return
    }
    if (parentStructure.encoding !== 'zarr_v3') {
      // An `opaque` parent has no chunking to filter, so the subset is taken off the whole.
      // Still the same member walk; the memory property is the one thing that degrades, and it
      // degrades because the STORE has no chunks, not because the gather forgot to use them.
      const whole = await this.#pull.continuous(of.key)
      const out = new Float32Array(members.length)
      for (let i = 0; i < members.length; i++) out[i] = whole.value[members[i]]
      yield new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      return
    }
    yield* this.#deps.streamGathered(of.key, parentStructure, members, readSignal)
  }

  async *#positionBytes(layoutId: string, readSignal: AbortSignal): AsyncIterable<Uint8Array> {
    const structure = await this.#pull.structureFor(layoutId)
    if (structure.encoding !== 'zarr_v3') {
      // An `opaque` layout is one interleaved f32 blob with no chunking to speak of, and the
      // dims inference + `dims > 2` projection that make it readable live on the pull method.
      // Wrapped as ONE chunk so INV-1 holds: there is still no non-streaming entry.
      const whole = await this.#pull.positions(layoutId)
      const p = whole.positions
      yield new Uint8Array(p.buffer, p.byteOffset, p.byteLength)
      return
    }
    yield* this.#deps.streamPositions(layoutId, structure, readSignal)
  }

  async *#continuousBytes(key: string, readSignal: AbortSignal): AsyncIterable<Uint8Array> {
    const structure = await this.#pull.structureFor(key)
    if (structure.encoding !== 'zarr_v3') {
      const whole = await this.#pull.continuous(key)
      const v = whole.value
      yield new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      return
    }
    yield* this.#deps.streamNumeric(key, structure, readSignal)
  }

  /** Codes as u16 — the width the GPU consumer packs to, narrowed by the ONE implementation of
   *  that rule (`toUint16Codes`), which ERRORS on an over-cap level set rather than wrapping a
   *  code to 0 and painting confidently wrong labels. */
  async *#categoricalBytes(key: string): AsyncIterable<Uint8Array> {
    const decoded = await this.#categoricalRead(key)
    const codes = toUint16Codes(decoded.codes, decoded.categories.length)
    yield new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength)
  }

  async #categoricalRead(key: string): Promise<{ codes: Uint32Array; categories: string[] }> {
    const { artifactId, column } = parseChannelKey(key)
    if (!key.includes('#') || !artifactId) {
      throw new WorkbenchStreamingError(
        `categorical column key "${key}" must be "<artifactId>#<columnName>"`,
      )
    }
    const structure = await this.#pull.structureFor(artifactId)
    const cached = this.#categoricalReads.get(key)
    if (cached) return cached
    const read = this.#deps.readCategorical(artifactId, structure, column || undefined)
    this.#categoricalReads.set(key, read)
    read.then(
      decoded => {
        // Charge what is actually held: the codes, plus the level strings (2 bytes/char is JS's
        // usual worst case). Then re-check the budget — a categorical read is the one retention
        // path that starts and finishes WITHOUT a `#pump`, so without this call an over-budget
        // cache could sit untrimmed until some unrelated stream happened to start.
        let bytes = decoded.codes.byteLength
        for (const level of decoded.categories) bytes += level.length * 2
        if (this.#categoricalReads.get(key) === read) this.#categoricalHeldBytes.set(key, bytes)
        this.#evict()
      },
      () => {
        this.#categoricalReads.delete(key)
        this.#categoricalHeldBytes.delete(key)
      },
    )
    return read
  }

  async *#valueBytes(key: string): AsyncIterable<Uint8Array> {
    const { artifactId, col } = parseValueKey(key)
    const structure = await this.#pull.structureFor(artifactId)
    const sparse = await this.#deps.readSparse(artifactId, col, structure)
    yield encodeSparseWire(sparse.row, sparse.value)
  }

  // ── the multicast (ITEM-6) + per-consumer cancellation (ITEM-7) ─────────────────

  async *#subscribe(
    key: string,
    channel: Channel,
    start: (readSignal: AbortSignal) => AsyncIterable<Uint8Array>,
    signal: AbortSignal | undefined,
  ): AsyncIterable<Uint8Array> {
    if (signal?.aborted) throw abortError()
    let entry = this.#streams.get(key)
    if (!entry) {
      entry = {
        key,
        channel,
        chunks: [],
        bytes: 0,
        arrived: 0,
        done: false,
        failure: undefined,
        waiters: [],
        consumers: 0,
        abort: new AbortController(),
      }
      this.#streams.set(key, entry)
      void this.#pump(entry, start)
    } else {
      // Touch for the replay LRU: the entry a second pane just joined is the LAST one that
      // should be evicted out from under a third.
      this.#streams.delete(key)
      this.#streams.set(key, entry)
    }
    const live = entry
    live.consumers++
    let onAbort: (() => void) | undefined
    try {
      let i = 0
      for (;;) {
        while (i < live.chunks.length) {
          yield live.chunks[i]
          i++
        }
        if (live.failure !== undefined) throw live.failure
        if (live.done) return
        if (signal?.aborted) throw abortError()
        await new Promise<void>((resolve, reject) => {
          const wake = (): void => {
            if (onAbort && signal) signal.removeEventListener('abort', onAbort)
            onAbort = undefined
            resolve()
          }
          live.waiters.push(wake)
          if (signal) {
            onAbort = () => {
              // Do NOT remove the waiter — it is identified by `wake`, which resolves; letting
              // it fire later is harmless (the loop re-checks the signal), and splicing it out
              // under a concurrent notify is how a consumer ends up waiting forever.
              reject(abortError())
            }
            signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      }
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      live.consumers--
      if (live.consumers === 0 && !live.done && live.failure === undefined) {
        // The LAST reader walked away from an unfinished read. Cancel the underlying range
        // reads — INV-4's "one epoch bump cancels the network reader", which an `alive` boolean
        // that merely discards results does not deliver — and evict, because the bytes buffered
        // so far are a PREFIX and replaying them to a later consumer would serve a truncated
        // column that decodes without error.
        live.abort.abort()
        if (this.#streams.get(key) === live) this.#streams.delete(key)
      }
    }
  }

  async #pump(
    entry: ChannelStream,
    start: (readSignal: AbortSignal) => AsyncIterable<Uint8Array>,
  ): Promise<void> {
    try {
      for await (const chunk of start(entry.abort.signal)) {
        if (entry.abort.signal.aborted) break
        entry.chunks.push(chunk)
        entry.bytes += chunk.byteLength
        entry.arrived++
        this.#notify(entry)
        this.#emitProgress(entry)
        // DEBUG-ONLY (see `chunkArrivalDelayMs`): space this arrival from the next one. AFTER the
        // emit, deliberately — the thing a spec needs to observe is the state BETWEEN two
        // arrivals, and a delay taken before the emit produces the same single committed state a
        // localhost read already produces. Guarded rather than `await`ed unconditionally: even
        // `await undefined` costs a microtask suspension, and the production read must be the read
        // it was.
        const spacing = delayBetweenChunks()
        if (spacing) await spacing
      }
      if (!entry.abort.signal.aborted) {
        entry.done = true
        this.#emitProgress(entry)
      }
    } catch (e) {
      entry.failure = e ?? new Error('channel stream failed with no reason')
      // A failed read must not be remembered: a transient 5xx would otherwise poison this
      // channel for the life of the source (the same rule `MEMBER_ARRAYS` follows on open).
      if (this.#streams.get(entry.key) === entry) this.#streams.delete(entry.key)
      // TERMINAL progress on the failure path too. Without it the only settle signal was
      // `done: true` from the success arm, so a read that died at chunk 2 of 5 left the coverage
      // indicator pinned at 40% for the life of the page — a failure rendered as "still loading".
      this.#emitProgress(entry)
    } finally {
      this.#notify(entry)
      this.#evict()
    }
  }

  #notify(entry: ChannelStream): void {
    const waiters = entry.waiters
    entry.waiters = []
    for (const wake of waiters) wake()
  }

  /**
   * Drop the oldest COMPLETED entries until the replay buffer is inside budget. An entry with
   * live consumers is never evicted — it is not spare capacity, it is a read in progress.
   *
   * `#categoricalReads` is counted and trimmed alongside `#streams`. It used to be neither: its
   * decoded codes + level sets are retained for the life of the source with no eviction at all and
   * were absent from this total, so REAL retention exceeded the stated 128 MB budget by an amount
   * bounded only by how many categorical columns a session touched. Same oldest-first rule, and
   * dropping one costs a re-read exactly as dropping a completed stream does.
   *
   * Streams are trimmed first, deliberately: a replayable stream is the larger object and the
   * cheaper thing to lose (its bytes are still cached by the transport), whereas a categorical
   * entry also carries the level set `catalog()` hands out.
   */
  #evict(): void {
    let held = 0
    for (const entry of this.#streams.values()) held += entry.bytes
    for (const bytes of this.#categoricalHeldBytes.values()) held += bytes
    if (held <= this.#replayBudgetBytes) return
    for (const [key, entry] of [...this.#streams]) {
      if (held <= this.#replayBudgetBytes) break
      if (entry.consumers > 0 || !entry.done) continue
      this.#streams.delete(key)
      held -= entry.bytes
    }
    for (const [key, bytes] of [...this.#categoricalHeldBytes]) {
      if (held <= this.#replayBudgetBytes) break
      this.#categoricalHeldBytes.delete(key)
      this.#categoricalReads.delete(key)
      held -= bytes
    }
  }

}

/** This module's taxonomy for a key that does not address a column. NOT exported: nothing outside
 *  this module discriminates on it today, and an exported error type no caller catches is a
 *  capability with no consumer. Export it in the commit that adds the first `catch`. */
class WorkbenchStreamingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkbenchStreamingError'
  }
}

/** A stream that only ever throws — the honest shape for a channel this source does not serve. */
async function* failing(error: Error): AsyncIterable<Uint8Array> {
  throw error
}

function asTable(artifactId: string, structure: ArtifactStructure): ZarrTableStructure {
  if (structure.encoding !== 'zarr_v3') {
    throw new WorkbenchStreamingError(
      `artifact ${artifactId} is "${structure.encoding}" — a categorical channel needs a zarr_v3 table`,
    )
  }
  return structure as ZarrTableStructure
}
