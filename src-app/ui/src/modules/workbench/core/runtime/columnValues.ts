// READ EXACTLY THESE COLUMNS (visualize-pane ITEM-31 / ITEM-36) — the values behind a list the
// USER built, keyed by that list's own keys.
//
// ── Why it is not `axis_columns` ────────────────────────────────────────────────────────
//
// `axis_columns` reads EVERY column on an axis into one frame. That is right for a criteria
// builder, which must offer every column that exists, and it is exactly wrong for the emit
// model: a section that listed forty columns and plotted two would download forty bodies. The
// pane's listing is already meta-only (`row_space_columns`, INV-11); this is the other half of
// the same rule — a body is read when, and only when, the user asks for a picture of it.
//
// ── ONE FRAME PER REQUESTED PLOT, not one merged frame ──────────────────────────────────
//
// The payload is `{ <key> → { <column> → values[] } }`, a frame PER entry rather than one
// frame with N columns, and the nesting is load-bearing for three separate reasons:
//
//   1. Two emitted plots may sit on DIFFERENT row spaces (ITEM-35: switching the anchor leaves
//      already-emitted plots open). Their columns have different lengths, and a single frame
//      holding ragged columns is not a frame.
//   2. Two plots on DIFFERENT row spaces cannot share a base at all — their columns differ in
//      length, which is reason 1 restated at the base rather than at the frame.
//      (This slot used to read *"one shared base would make two plots brush each other; two
//      adjacent plots brush independently is the stated behaviour"*. SUPERSEDED — that is the
//      DECLARATION layer, and `canvasFeed.ts`'s `sharedCoordinateBase` folds exactly those
//      declared bases: plots drawn in ONE coordinate artifact share a base and DO brush
//      together, which `450efed6` / ledger row 34 records as the DESIRED behaviour.)
//   3. DEC-9 — a second click on the SAME row opens a SECOND plot. Two entries then name one
//      artifact, and each must resolve to its own base. Keying by the LIST's key rather than by
//      the artifact is what makes that expressible at all.
//
// The artifact behind two entries is read ONCE and shared, so the second click costs no
// network.
//
// Nothing here belongs to any domain: it reads a list of `{key, artifact}` records and returns
// their values. Which records exist is the caller's business.

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { columnNameForMember, type ColumnarFrame, type ReadArtifactFrame } from './axisSource'

/** Read ONE entry's column off an entry-indexed artifact. Injected, so this module stays IO-free
 *  and the entry arm is unit-drivable with a synthetic reader. */
export type ReadEntryRequest = (row: ArtifactRow, request: ColumnRequest) => Promise<readonly number[]>

/** The `data.<slice>.source` value that selects this resolver. */
export const COLUMN_VALUES_SOURCE = 'column_values'

/** One requested column: a KEY and the artifact behind it.
 *
 *  `name` is optional and display-only — it decides what the resolved frame calls the column,
 *  so a canvas `encode` can bind `{ groupKey: "$c.column" }` using the same word the row showed
 *  the user. Absent ⇒ the producer's own declared name. */
export interface ColumnRequest {
  key: string
  artifact: string
  name?: string
  /**
   * WHICH part of the artifact — an ENTRY key, when the requested column is one entry of an
   * entry-indexed artifact rather than the artifact's own sole column (ITEM-26/ITEM-59).
   *
   * Its presence is what selects the entry arm. Absent ⇒ the artifact IS the column, which is
   * every request the colouring section makes; a matrix carrying thousands of entries is not
   * addressed by its id alone, and reading its whole frame would be the eager read INV-11
   * removes one slice over.
   */
  selector?: string
  /** the entry's INDEX on its own axis, captured when the plot was emitted. A column-indexed
   *  encoding (a CSC matrix) is addressed by position, and the position must come from the
   *  axis's own order — an index taken from anywhere else addresses a different column,
   *  silently. Captured at emit rather than re-derived, so an open plot cannot be re-pointed
   *  by a later list. */
  position?: number
  /** how many rows the plot's row space holds, so a sparse column can be densified against it.
   *  Also captured at emit (ITEM-35: a plot survives an anchor change, and it must keep the
   *  row space it was born in). */
  rows?: number
}

/** `{ requestKey → { column → values } }`. A request whose artifact could not be read is
 *  ABSENT rather than empty: a consumer can then tell "not resolved" from "resolved to nothing"
 *  and, in the canvas' case, simply not draw that plot for a frame rather than draw an empty
 *  one. */
export type ColumnValues = Record<string, ColumnarFrame>

/**
 * Coerce whatever a `$`-ref resolved to into the request list.
 *
 * ── The key is the POSITION, unless the record names its own ────────────────────────────
 *
 * A duplicate key would merge two requests into one frame, and the canvas bases derived from
 * them into ONE base — which under DEC-9 ("a second click opens a SECOND grid pane") is exactly
 * the case a user reaches by clicking one row twice. Uniqueness therefore belongs at id
 * DERIVATION rather than at a later refusal: refusing a collision is not an option a canvas has
 * (`setOption` is per-GRID, so a refusal blanks every contributor's plots rather than the
 * offender's), and a caller cannot mint a unique token from a declarative `set` — the expression
 * grammar is references only, with no counter and no arithmetic.
 *
 * A record's INDEX in the list is unique in that list by construction, needs nothing to mint it,
 * and is the same key the canvas' own `for_each … as $c, $i` already has in hand — so the state,
 * the frames and the panes agree without any of them being told. A record that DOES carry a
 * `key` keeps it, for a caller whose list has stable identities of its own.
 *
 * A malformed entry is DROPPED rather than throwing: the list is user-built state, and one bad
 * record must not take every other plot off the canvas. It is dropped from the ANSWER only — the
 * remaining records keep their own positions, so a dropped record cannot renumber its
 * neighbours out from under the panes bound to them.
 */
export function toColumnRequests(value: unknown): ColumnRequest[] {
  if (!Array.isArray(value)) return []
  const out: ColumnRequest[] = []
  value.forEach((item, index) => {
    if (item == null || typeof item !== 'object') return
    const rec = item as Record<string, unknown>
    const artifact = rec.artifact
    if (typeof artifact !== 'string' || artifact === '') return
    const key = typeof rec.key === 'string' && rec.key !== '' ? rec.key : String(index)
    out.push({
      key,
      artifact,
      ...(typeof rec.name === 'string' && rec.name !== '' ? { name: rec.name } : {}),
      ...(typeof rec.selector === 'string' && rec.selector !== '' ? { selector: rec.selector } : {}),
      ...(typeof rec.position === 'number' && Number.isInteger(rec.position) && rec.position >= 0
        ? { position: rec.position }
        : {}),
      ...(typeof rec.rows === 'number' && Number.isInteger(rec.rows) && rec.rows > 0 ? { rows: rec.rows } : {}),
    })
  })
  return out
}

/**
 * Read each requested column into its own frame. PURE apart from the injected reader.
 *
 * A request naming an artifact the catalog does not hold is skipped — an artifact that was
 * deleted under an open plot is a real situation, and the honest answer is that this plot has
 * nothing to draw, not that the whole slice failed.
 */
export async function readColumnValues(
  artifacts: readonly ArtifactRow[],
  requests: readonly ColumnRequest[],
  read: ReadArtifactFrame,
  readEntry?: ReadEntryRequest,
  /** Optional PROGRESSIVE emitter (incremental-landing ITEM-7): called with the SLICE payload
   *  assembled from the rows landed SO FAR, each time an artifact's stream advances. The landing
   *  runtime turns each into a `partial` chunk so the emit-plot colour column paints as it arrives;
   *  the returned (final) payload is the authoritative wholesale result. Omitting it reads whole. */
  onPartial?: (partial: ColumnValues) => void,
): Promise<ColumnValues> {
  const byId = new Map(artifacts.map(a => [a.id, a]))
  const entryRequests = requests.filter(r => r.selector !== undefined && byId.has(r.artifact))
  const plain = requests.filter(r => r.selector === undefined)
  // ONE read per distinct artifact, however many requests name it (DEC-9's second click).
  const wanted = [...new Set(plain.map(r => r.artifact))].filter(id => byId.has(id))
  const frames = new Map<string, ColumnarFrame>()
  // Declared UP HERE (not beside its readEntry fill below) so the progressive `onChunk` closure can
  // assemble a partial payload that includes any entry columns already resolved (ITEM-7).
  const entryFrames = new Map<string, readonly number[]>()
  await Promise.all(
    wanted.map(async id => {
      const row = byId.get(id)!
      try {
        // Progressive (ITEM-7): each prefix of this artifact's stream re-assembles + emits the
        // slice payload landed so far, so the declarative `$data` colour column fills as it
        // arrives. `onChunk` is passed only when a caller wants partials; otherwise `read` reads
        // whole exactly as before. The final `frames.set` below still lands the complete frame.
        const onChunk = onPartial
          ? (partial: ColumnarFrame, done: boolean): void => {
              if (done) return // the resolved value below is the authoritative complete frame
              frames.set(id, partial)
              onPartial(assembleColumnValues(requests, byId, frames, entryFrames))
            }
          : undefined
        frames.set(id, await read(row, onChunk))
      } catch (e) {
        // Tolerated per artifact, exactly as the axis-columns frame reader tolerates it: one
        // unreadable column must not take the other plots off the canvas. Logged so it is
        // diagnosable rather than a silently blank pane.
        console.error(`[declarative] column_values: read failed for artifact ${id}`, e)
      }
    }),
  )
  // The ENTRY arm: one read per distinct (artifact, position), so pressing one entry's ▶ twice
  // costs no second network read — the same sharing the artifact arm above does, keyed on the
  // pair that identifies a column rather than on the artifact alone.
  if (readEntry) {
    const distinct = new Map<string, ColumnRequest>()
    for (const r of entryRequests) distinct.set(`${r.artifact}\u0000${r.position ?? -1}`, r)
    await Promise.all(
      [...distinct].map(async ([id, req]) => {
        try {
          entryFrames.set(id, await readEntry(byId.get(req.artifact)!, req))
        } catch (e) {
          console.error(
            `[declarative] column_values: read failed for entry "${req.selector}" in artifact ${req.artifact}`,
            e,
          )
        }
      }),
    )
  }

  return assembleColumnValues(requests, byId, frames, entryFrames)
}

/**
 * Assemble the `column_values` slice payload from the frames resolved so far. Extracted (ITEM-7) so
 * the SAME assembly serves both the final wholesale return AND each progressive partial emit — a
 * partial assembles over the prefix frames landed to that point.
 */
function assembleColumnValues(
  requests: readonly ColumnRequest[],
  byId: ReadonlyMap<string, ArtifactRow>,
  frames: ReadonlyMap<string, ColumnarFrame>,
  entryFrames: ReadonlyMap<string, readonly number[]>,
): ColumnValues {
  const out: ColumnValues = {}
  for (const req of requests) {
    if (req.selector !== undefined) {
      const values = entryFrames.get(`${req.artifact}\u0000${req.position ?? -1}`)
      // ABSENT rather than empty when the read failed — a consumer can then tell "not resolved"
      // from "resolved to nothing" and simply not draw that plot.
      if (values) out[req.key] = { [req.name ?? req.selector]: values as unknown[] }
      continue
    }
    const frame = frames.get(req.artifact)
    const row = byId.get(req.artifact)
    if (!frame || !row) continue
    const keys = Object.keys(frame)
    if (keys.length === 0) continue
    if (keys.length === 1) {
      // A single-column store writes its sole member under the CONSTANT path `values`, so the
      // read key is the same string for every column in the project. The caller's `name` (what
      // the user saw on the row) wins; failing that, the producer's own declared name; failing
      // that, the read key. Never the constant — a canvas binding to `values` would bind to
      // whichever column happened to be read.
      const declared = columnNameForMember(row, { name: keys[0] }, 1)
      out[req.key] = { [req.name ?? declared ?? keys[0]]: frame[keys[0]] }
      continue
    }
    out[req.key] = frame
  }
  return out
}
