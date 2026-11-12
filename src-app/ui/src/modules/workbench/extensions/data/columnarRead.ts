// columnarRead (ITEM-42) — the `data` capability's columnar frame read, routed through the SAME
// `WorkbenchStreamingSource` the canvas reads, so a column has ONE byte route, ONE cache and ONE
// arrival clock.
//
// ── THE GAP THIS CLOSES, AS A NUMBER ────────────────────────────────────────────────────────
//
// Measured with the ITEM-11 decode counter (the `immutable` HTTP cache hides a duplicate FETCH
// but not a duplicate DECODE): two consumers of ONE source cost ONE decode, while the previous
// `column_values` route — reading the artifact through its own workstore call — cost a SECOND
// decode on top of the canvas's read. "The two paths produce the same values" was never evidence
// that they were one path (DRIFT-1.48).
//
// ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
//
//   • THE REPRESENTATION POLICY (below). The BYTE ROUTE is unified; incremental-landing (#29)
//     makes the LANDING progressive on top of it — see the `onChunk` arm: a caller that passes it
//     receives each accumulated prefix as the stream arrives (the declarative `$data` colour column
//     paints progressively, ITEM-7), and the FINAL frame is byte-identical to the wholesale
//     `collectStream` result. A caller that passes no `onChunk` still gets exactly the wholesale
//     frame it always did, so every existing consumer is unchanged.
//   • THE REPRESENTATION POLICY. The frame keeps ITEM-21's typed columns, and the
//     `readTable`/`columnarFromTable` split that holds `job.result` and `axis_columns` boxed by
//     construction (DRIFT-1.22) is untouched — nothing here is on those paths.
//
// ── WHY THE STREAMED ROUTE IS NARROWLY GATED, AND WHY THAT IS NOT TIMIDITY ───────────────────
//
// The `continuous` channel is f32 BY CONSTRUCTION (`streamNumericBytes` yields the dense f32 wire
// bytes viz consumes). `readColumnarTable`'s numeric arm hands back the DECODER's own array,
// which for a float64 / int32 / int64 member is NOT a `Float32Array`. Routing such a member
// through the channel would silently change both the type and, above 2^24, the VALUES of a
// column the emit arc plots — a silent-result change of exactly the class this branch exists to
// stop. So the streamed route is taken only for a member the producer DECLARED `float32`, where
// the two decodes are byte-identical (TEST-2 asserts that per channel); every other member keeps
// the previous reader unchanged. The dispatch is on the producer's declaration, never on a peek
// at a value.

import {
  parseStructure,
  readColumnarTableChecked,
  type ArtifactStructure,
  type ColumnarTableData,
  type ZarrTableStructure,
} from '@/core/workstore'
import { collectStream, type Channel } from '@txresbench/viz'
import type { ColumnarFrameOnChunk, ColumnarFrameRead } from './contract.ts'
import type { ProjectSources } from './projectSources.ts'

export type { ColumnarFrameOnChunk }

/** Concatenate the byte chunks collected so far into one contiguous buffer. The inner chunks are
 *  f32 wire bytes and row-aligned by construction, so every prefix is 4-byte aligned and can be
 *  read as a `Float32Array` (ITEM-7 progressive land). */
function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}


/** The declared members of a zarr table, under either spelling the producer writes. */
function tableMembersOf(structure: ArtifactStructure): ZarrTableStructure['columns'] {
  if (structure.encoding !== 'zarr_v3') return undefined
  const t = structure as ZarrTableStructure
  return t.columns ?? t.arrays
}

/** The SOLE member this artifact declares, when it declares exactly one AND that one is a
 *  producer-declared `float32` numeric column. Anything else ⇒ `undefined` ⇒ the previous
 *  reader. */
function soleFloat32Member(
  structure: ArtifactStructure,
): { path: string; name?: string } | undefined {
  const members = tableMembersOf(structure)
  if (!members || members.length !== 1) return undefined
  const m = members[0]
  if (m.kind !== 'numeric' || m.dtype !== 'float32') return undefined
  return { path: m.path, ...(typeof m.name === 'string' ? { name: m.name } : {}) }
}

/** The f32 view of a byte run, copying only when the run is not 4-byte aligned (a `Float32Array`
 *  view refuses an unaligned offset; silently reading past it would be worse than the copy). */
function asFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`streamed column: ${bytes.byteLength} bytes are not f32-aligned`)
  }
  if (bytes.byteOffset % 4 !== 0) return new Float32Array(bytes.slice().buffer)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

/**
 * Build the capability's columnar reader over a LAZY accessor for the project's sources.
 *
 * Lazy because the capability is instantiated while the broker is still being stocked: resolving
 * the sources eagerly here would re-enter that installation. By the time a read happens the
 * broker is memoized, so both this and the canvas reach the same instance.
 */
export function makeColumnarFrameReader(
  sources: () => ProjectSources,
  deps: {
    /** The reader every member this route does NOT stream falls back to. Injected for the same
     *  reason `WorkbenchStreamingDeps` injects its byte boundary: it lets a test drive the GATE
     *  — which member streams and which does not — against a fixture store, without the fallback
     *  reaching the network. Production passes nothing. */
    readWhole?: (read: ColumnarFrameRead) => Promise<ColumnarTableData>
  } = {},
): (read: ColumnarFrameRead, onChunk?: ColumnarFrameOnChunk) => Promise<ColumnarTableData> {
  const readWhole =
    deps.readWhole ??
    (read => readColumnarTableChecked({ id: read.artifactId, structure: read.structure }))
  return async (read, onChunk) => {
    const { artifactId } = read
    // ── THE CORRESPONDENCE READ (ITEM-16/ITEM-19) — GATED ON THE SEGMENTS, NOT ON THIS ARTIFACT
    //
    // Every gate below asks `soleFloat32Member` of the READ's OWN artifact. A correspondence
    // read's own artifact is a `sparse_csc` MATRIX, which declares no such member and fails that
    // gate — so without this branch the read would fall to `readWhole` ON A MATRIX. That is not
    // the documented ITEM-32 slowness; it is WRONG: `readColumnarTable` has no arm for a CSC
    // matrix, and the one column the caller asked for is not what any arm of it would return.
    //
    // The branch is fully specified by the segments themselves — each names its artifact, its
    // COLUMN INDEX within it, and its membership — so there is nothing left for this artifact's
    // declaration to say, and nothing to fall back TO. It therefore takes the streamed route
    // unconditionally and throws on failure rather than degrading into a whole-matrix read.
    const segments = read.members?.segments ?? []
    if (segments.length > 0 && segments.every(s => typeof s.columnIndex === 'number')) {
      const src = sources()
      const channel: Channel = {
        kind: 'members',
        members: {
          // IN THE DECLARED ORDER (ITEM-11/15). `map` preserves it; nothing here sorts.
          segments: segments.map(s => ({
            of: { kind: 'value' as const, key: `${s.column}#${s.columnIndex as number}` },
            alignedTo: s.alignedTo,
            artifact: s.artifact,
            member: s.member,
            count: s.count,
          })),
        },
      }
      const bytes = await collectStream(src.streaming.stream(channel))
      // A gathered `value` segment emits DENSE f32 (see `GatherableChannel`), so the run is f32
      // whatever the parents' sparsity — the same decode every other gathered column takes.
      //
      // ONE column, under the FIRST segment's own value key. A gather emits exactly one row
      // sequence, so there is nothing to disambiguate and the caller reads the sole column; the
      // key is the primary segment's rather than an invented name so that anything logging or
      // caching the frame names an artifact and a column that genuinely exist.
      const first = segments[0]
      return { [`${first.column}#${first.columnIndex as number}`]: asFloat32(bytes) }
    }
    let member: { path: string; name?: string } | undefined
    if (read.structure !== undefined) {
      // Parsing is the producer's declaration being read, not a default being invented: an
      // artifact with no `structure` is an ingest error (INV-2). A structure this reader cannot
      // classify simply falls through to the previous reader below.
      let structure: ArtifactStructure | undefined
      try {
        structure = parseStructure(artifactId, read.structure)
      } catch {
        structure = undefined
      }
      if (structure) member = soleFloat32Member(structure)
    }
    // The streamed route's gate is `soleFloat32Member` of THIS artifact's structure, so it can
    // only speak for segments read from THIS artifact. A gather whose segments name another
    // column has not been gated on that column's declaration at all, and taking the streamed
    // route on its behalf would decode an undeclared member as f32 — so it falls to the reader
    // below, which resolves each segment's column on its own terms.
    //
    // A CORRESPONDENCE SEQUENCE segment (INV-6/INV-7) also falls to the reader below: its index
    // body is a permutation, and the streamed route gathers a numeric column in ONE PASS against
    // the parent's chunks, which requires an ascending body. The fallback reads the parent whole
    // and gathers by random access (`gatherFrame`), which is the only gather a permutation body
    // is safe through.
    if (member && read.members?.segments.some(s => s.column !== artifactId || s.sequence)) member = undefined
    if (member) {
      const src = sources()
      const frameKey = member.name ?? member.path
      // The `continuous` channel key IS the artifact id (`WorkbenchDataSource.catalog()`), and
      // its byte producer resolves the artifact's sole member — the same member gated above.
      // ITEM-20 — a gathered read is the SAME byte route, one channel over: the `members`
      // channel wraps the `continuous` one, checks the membership against this column's own
      // axis, and filters each parent chunk on arrival. So an offered column is a PAINTED
      // column, and it is painted at the coordinate's rows rather than at the parent's.
      // ITEM-15 — the segments go across in the order core declared them, one parent channel
      // each. `map` preserves it; nothing here sorts.
      const channel: Channel = read.members
        ? {
            kind: 'members' as const,
            members: {
              segments: read.members.segments.map(s => ({
                of: { kind: 'continuous' as const, key: s.column },
                alignedTo: s.alignedTo,
                artifact: s.artifact,
                member: s.member,
                count: s.count,
              })),
            },
          }
        : { kind: 'continuous' as const, key: artifactId }
      // ITEM-7: ITERATE the stream (never `collectStream` it) so each inner chunk can land
      // progressively; a caller passing `onChunk` receives each accumulated prefix, then the
      // complete frame. The accumulated bytes are the SAME bytes `collectStream` would have
      // concatenated, so the final frame is byte-identical to the wholesale read (TEST-13's
      // byte-identity leg). The frame KEY is the one `readColumnarTable` mints
      // (`member.name ?? member.path`), so a consumer cannot tell the two routes apart.
      const parts: Uint8Array[] = []
      let total = 0
      for await (const chunk of src.streaming.stream(channel)) {
        parts.push(chunk)
        total += chunk.byteLength
        // Emit each PREFIX as it arrives — the progressive land. (No-op without `onChunk`.)
        onChunk?.({ [frameKey]: asFloat32(concatBytes(parts, total)) }, false)
      }
      const frame = { [frameKey]: asFloat32(concatBytes(parts, total)) }
      onChunk?.(frame, true)
      return frame
    }
    const whole = await readWhole(read)
    // ITEM-20 — THE FALLBACK GATHERS TOO.
    //
    // The streamed route above serves exactly one shape: a zarr table whose sole member is
    // `numeric`/`float32`. Everything else lands here — and "everything else" includes the
    // rows § Colour by lists FIRST, because a categorical column is `uint32` and can never
    // take the streamed branch. Returning `whole` unchanged handed the canvas a
    // PARENT-LENGTH column while the pane's positions were the coordinate's members: the
    // right number of the wrong rows, with a clean console and a plausible picture, which is
    // the one failure this whole model exists to make impossible.
    //
    // The memory property degrades here and only here — the parent is materialised before it
    // is compacted, because a store with no chunking has nothing to filter on arrival. That
    // is the same degradation, for the same reason, that the byte route's own `opaque` arm
    // takes. The VALUES are the values either way.
    //
    // A member this route does not stream lands in ONE step — still announced as a (terminal)
    // chunk so a progressive consumer's landing sequence always closes with a `done`.
    if (!read.members) {
      onChunk?.(whole, true)
      return whole
    }
    // ITEM-15 — EVERY SEGMENT, IN THE DECLARED ORDER. Each segment names its own parent column;
    // the read above is the one for THIS artifact, and any other column is read on its own.
    // Frames are then concatenated in the segments' order — never sorted, never merged by name
    // ordering — because that order IS the row sequence.
    const src = sources()
    const frames: ColumnarTableData[] = []
    const byColumn = new Map<string, ColumnarTableData>([[artifactId, whole]])
    for (const segment of read.members.segments) {
      let parent = byColumn.get(segment.column)
      if (!parent) {
        parent = await readWhole({ artifactId: segment.column })
        byColumn.set(segment.column, parent)
      }
      const positions = await src.streaming.memberIndex(
        { artifact: segment.artifact, member: segment.member },
        // A correspondence sequence body is a declared permutation (INV-6/INV-7); read it without
        // the ascending guard because `gatherFrame` below is random-access and permutation-safe.
        { ordered: !segment.sequence },
      )
      frames.push(gatherFrame(parent, positions))
    }
    // The gathered frame lands in one step — announced as a terminal chunk so a progressive
    // consumer's landing sequence always closes with a `done`.
    const gathered = concatFrames(frames)
    onChunk?.(gathered, true)
    return gathered

  }
}

/**
 * Lay the segments' frames end to end, IN ORDER, one column at a time (ITEM-15).
 *
 * The one-segment case returns its frame untouched, so the shipped subset read is byte-for-byte
 * what it was. Beyond one, a column present in one segment and absent from another would leave
 * a hole with no honest filler, so the frames must agree on their column NAMES — they do by
 * construction when the segments share a parent, and a mismatch is refused rather than papered
 * over with a short column that every consumer would read as index-parallel and is not.
 */
function concatFrames(frames: readonly ColumnarTableData[]): ColumnarTableData {
  if (frames.length === 1) return frames[0]
  const names = Object.keys(frames[0])
  for (const frame of frames) {
    const theirs = Object.keys(frame)
    if (theirs.length !== names.length || names.some(n => !(n in frame))) {
      throw new Error(
        `gathered segments describe different columns ([${names.join(', ')}] vs ` +
          `[${theirs.join(', ')}]) — they cannot be concatenated into one row sequence`,
      )
    }
  }
  const out: ColumnarTableData = {}
  for (const name of names) {
    const parts = frames.map(f => f[name])
    const total = parts.reduce((n, p) => n + p.length, 0)
    const first = parts[0]
    if (Array.isArray(first) || parts.some(p => Array.isArray(p))) {
      const boxed: unknown[] = []
      for (const part of parts) for (let i = 0; i < part.length; i++) boxed.push(part[i])
      out[name] = boxed as unknown as ArrayLike<number>
      continue
    }
    const ctor = (first as unknown as { constructor: unknown }).constructor as
      | (new (n: number) => { [k: number]: number; length: number })
      | undefined
    if (typeof ctor !== 'function') {
      const boxed: unknown[] = []
      for (const part of parts) for (let i = 0; i < part.length; i++) boxed.push(part[i])
      out[name] = boxed as unknown as ArrayLike<number>
      continue
    }
    const next = new ctor(total)
    let at = 0
    for (const part of parts) {
      const typed = part as ArrayLike<number>
      for (let i = 0; i < typed.length; i++) next[at++] = typed[i]
    }
    out[name] = next as unknown as ArrayLike<number>
  }
  return out
}

/** Compact every column of a landed frame to `positions`, preserving each column's own
 *  representation — a typed column stays typed (`Float32Array` in, `Float32Array` out), a boxed
 *  one stays boxed. A gather that boxed a typed column would undo ITEM-21's whole point one
 *  layer after it was won. */
function gatherFrame(frame: ColumnarTableData, positions: Uint32Array): ColumnarTableData {
  const out: ColumnarTableData = {}
  for (const [name, column] of Object.entries(frame)) {
    if (Array.isArray(column)) {
      out[name] = positions.length === 0 ? [] : Array.from(positions, i => column[i])
      continue
    }
    const typed = column as ArrayLike<number> & { constructor: { from(a: ArrayLike<number>): unknown } }
    const ctor = (typed as unknown as { constructor: unknown }).constructor as
      | (new (n: number) => { [k: number]: number; length: number })
      | undefined
    if (typeof ctor !== 'function') {
      out[name] = Array.from(positions, i => typed[i])
      continue
    }
    const next = new ctor(positions.length)
    for (let i = 0; i < positions.length; i++) next[i] = typed[positions[i]]
    out[name] = next as unknown as ArrayLike<number>
  }
  return out
}
