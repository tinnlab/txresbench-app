// AXIS-SCOPED SOURCES (PLAN.md ITEM-8 / ITEM-11) — the two resolvers a declarative view
// needs in order to offer inputs and columns that only EXIST relative to another choice.
//
// Both answer the same question from opposite ends: "given the artifact this control is
// pointing at, what else lives on axis X of its dataset?"
//
//   · `artifact_ref` widget, `source: { axis, of, datatype, values }` → the sibling
//     ARTIFACTS (a label-column picker: which column on an axis holds the names).
//   · `data` slice, `source: axis_columns, args: { of, axis }` → their COLUMNS, merged
//     into the columnar frame a view's `derived` primitives already read (a criteria
//     builder, which must offer every metadata column that EXISTS — 65 on the reference
//     dataset — not the 9 an analysis once forecast).
//
// Neither can be a manifest key, and `of` is the reason: the candidate set depends on
// ANOTHER CONTROL'S CURRENT VALUE, which does not exist when the manifest is read. So the
// answer before `of` resolves is EMPTY, never "everything" — a project-wide fallback would
// quietly offer columns belonging to a different dataset, and the user would have no way
// to see that from the form (INV-4).
//
// The server resolves the same relation for a RUN (`sandbox/spec.rs`'s
// `DatasetAxisIndexRef` → `find_dataset_axis_index`), scoping by `dataset_id` + the axis
// name and filtering to the single-column-family capability. This is the read half of
// that, done client-side off the project catalog the workbench already holds — no new
// endpoint, and one catalog fetch serves every source in a spec.
//
// Pure + IO-injected (a `read` callback for the frame), so both resolvers are unit-driven
// with synthetic rows and no backend.

import type {
  ArtifactRefSource,
  AxisScopedArtifactSource,
  DataSourceSpec,
  RowSpaceScopedArtifactSource,
  ViewSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import {
  attachDeclarations,
  declaration,
  type ColumnDeclarations,
  isDeclaredBool,
} from './columnDeclarations'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import type { DatatypeLattice } from '@/modules/workbench/core/datatypes/lattice'
import {
  declaredDimsForDisplay,
  sharesSourceDataset,
  sourceDatasetGroupKey,
  sourceDatasetIds,
  sourceDatasetNames,
  TEXT_VALUE_KINDS,
} from '@/core/workstore'
import type { DecodedColumn } from '@/core/workstore'
import { criterionColumn } from '@/modules/workbench/core/criteria/criteria'
import { reconcileVocabularies, vocabDeclarationOf } from './vocabFusion'
import { evalExpr, type Scope } from './expr'

/** The `data.<slice>.source` value that selects the axis-columns resolver. */
export const AXIS_COLUMNS_SOURCE = 'axis_columns'

/**
 * The `data.<slice>.args.as` value that asks an axis-columns slice for the ARTIFACT ID
 * behind each column instead of the column's VALUES.
 *
 * It exists because a single-column store cannot carry its own name: the writer emits ONE
 * ARTIFACT PER COLUMN whose sole member path is the constant `"values"`, and the display
 * name lives in the catalog row, which is not staged into a sandbox. So a compute that
 * wants a NAMED metadata column must be handed it on a slot that carries the name
 * (`column:<name>`) — and a view can only build that binding if it can get from a column
 * NAME back to the ARTIFACT the name came from.
 * The merged frame cannot answer: it is `{ name: values[] }` and the ids are gone by then.
 *
 * The same slice declaration, asked a different question — deliberately NOT a second source
 * name, and deliberately the SAME row selection (`axisColumnRows`), so the ids describe
 * exactly the columns the frame holds. Answering it costs one catalog read and NO artifact
 * fetches: a column's id and name are both producer DECLARATIONS on the catalog row.
 */
export const AXIS_COLUMNS_AS_SOURCES = 'sources'

/**
 * The `data.<slice>.args.produced_by` value that narrows an axis-columns slice to the
 * columns THIS VIEW'S OWN ANALYSIS did not make.
 *
 * ## Why the source and not the constraint
 *
 * `require.not_in` asks whether a value is in a set. It is right, and it stays exactly as
 * it is; what was wrong was the SET. `existingColumns` answered "every name on this axis",
 * so a form whose default rows are named after the columns it emits invalidated all of them
 * the moment it succeeded once — the run's own previous output read as a collision, and the
 * only route to a second run on the same data was renaming every metric. Narrowing the
 * ANSWER keeps one meaning of `not_in` ("this name is taken") instead of growing a second
 * ("…unless"), and leaves every other slice byte-identical: absent ⇒ every column, as now.
 *
 * ## Whose analysis, and why nothing names it
 *
 * "Its own" is resolved from the view's OWN `run_processor` ops ({@link viewOwnAnalysisIds})
 * — the analyses this view dispatches — never from an id written beside the slice. The id is
 * already in the file once, on the run, and a second copy is one rename from silently
 * meaning nothing: it would still parse, still resolve, and simply stop excluding anything.
 * (It is also the `analysis:` back-pointer a view deliberately does not carry.)
 *
 * The exclusion is by PRODUCER, not by name or by run: superseding your own column is
 * permitted no matter how many times you have done it, and a column another producer made
 * is refused no matter what it is called.
 */
export const AXIS_COLUMNS_PRODUCED_BY_OTHERS = 'others'

/**
 * The analyses a view LAUNCHES — every `run_processor.id` in its action bodies, de-duped.
 *
 * This is the view's own declaration of what it produces runs of, so it is the honest
 * answer to "which previous outputs are MINE": the artifacts of those runs carry exactly
 * these ids as their producing `generator_id`. Reading it rather than restating it means a
 * renamed analysis moves the exclusion with it instead of leaving a dead literal behind.
 *
 * A view that launches nothing yields NOTHING, and a `produced_by: others` slice on such a
 * view therefore excludes nothing — the conservative direction: the slice keeps every
 * column, so the constraint reading it goes on refusing rather than quietly permitting.
 */
export function viewOwnAnalysisIds(spec: ViewSpec | undefined): string[] {
  const out = new Set<string>()
  for (const action of spec?.actions ?? []) {
    for (const op of (action.body ?? []) as Array<{ run_processor?: { id?: unknown } }>) {
      const id = op?.run_processor?.id
      if (typeof id === 'string' && id !== '') out.add(id)
    }
  }
  return [...out]
}

/** One offered artifact in an `artifact_ref` picker. */
export interface ArtifactRefCandidate {
  id: string
  /** what the option READS as — see `candidateLabel`. */
  label: string
  datatype: string
  /** EVERY dataset this artifact came from, carried STRUCTURALLY rather than concatenated
   *  into `label`. The picker groups on it: a user with several datasets attached to a
   *  project needs to see which one an option belongs to, and a suffix says it only where
   *  truncation eats it. Empty/absent when the artifact carries no source dataset; TWO
   *  entries for an artifact that integrated two datasets — which is why this is the set and
   *  not one id, and why the picker must not file such an option under either source alone. */
  datasetIds?: readonly string[]
  datasetNames?: readonly string[]
  /** The single source dataset, present ONLY when there is exactly one — the same
   *  exactly-one rule the wire uses. `undefined` for a multi-source artifact, so a consumer
   *  that reads this alone degrades to "no dataset" rather than to a wrong one. */
  datasetId?: string
  datasetName?: string
  /**
   * The option's LABEL was CONTESTED — two candidates in this offer described identically and
   * had to be told apart (see {@link disambiguate}).
   *
   * INV-10 keys `auto_bind_sole_candidate`'s refusal on this: *"a marked or contested candidate
   * is never chosen FOR the user … sole candidacy is not consent"*. It is per-OFFER by
   * construction, which is the right scope — whether two things are confusable is a fact about
   * the list they are offered in, not about either artifact alone.
   */
  ambiguous?: boolean
  /**
   * **A3** — this candidate's alignment to the anchored row space is UNDECLARED, so whether its
   * values line up with the points on screen is unknown (design §7.7.2's four states: A0 no
   * anchor · A1 aligned · A2 aligned elsewhere, not offered · A3 unknown, offered and MARKED).
   *
   * `undefined` means the question was never ASKED, which is not the same as "the answer is no"
   * and must never be treated as A3. It is undefined for every candidate today: the A0–A3 states
   * only exist relative to an anchored row space, and the shipped `artifact_ref` sources are
   * dataset-scoped siblings with no anchor to be aligned to. The engine-side offering predicate
   * (ITEM-17/ITEM-18) is what sets it, and it is declared here so that INV-10's refusal — which
   * lands with ITEM-29b — is in force the day it does, rather than being a second thing to
   * remember.
   */
  alignmentUnknown?: boolean
  /**
   * What this artifact COVERS, from the producer's declarations alone — the option's second
   * line (see {@link candidateCoverage}).
   *
   * It exists because the second line used to be the source DATASET, unconditionally. In a
   * picker scoped to one anchored row space every option carries the SAME dataset, so that
   * line spent the row's most valuable space on the one string that could not distinguish
   * anything — the identical mistake the row-space picker made by leading both of its options
   * with one filename. Coverage is what actually varies.
   *
   * `undefined` where nothing is declared: absent, never computed (INV-11).
   */
  coverage?: string
  /**
   * The FUSED MEMBER SET (ITEM-35, DEC-D) — EVERY artifact id this offer spans when same-name
   * fusion merged more than one, with the deterministic PRIMARY ({@link id}) at the head. This
   * is what the widget carries into the store's member-set sidecar on a pick, so a run bound to
   * a fused colour source records a `used` edge per member rather than only the primary.
   *
   * `undefined` on an UNFUSED candidate — which is every candidate in a single-dataset project,
   * and every one whose same-name peers' vocabularies did not reconcile (those stay OFFERED
   * SEPARATELY, honest about their divergence). {@link id} stays the one primary id whether or
   * not this is set; the set never replaces the stored value (INV-4).
   */
  artifacts?: readonly string[]
}

/** Is this source the axis-scoped form (the one that depends on another control)? */
export function isAxisScopedSource(s: ArtifactRefSource | undefined): s is AxisScopedArtifactSource {
  return s != null && typeof (s as AxisScopedArtifactSource).axis === 'string'
}

/** Is this source the ROW-SPACE-scoped form (the one that depends on the anchor)? */
export function isRowSpaceScopedSource(
  s: ArtifactRefSource | undefined,
): s is RowSpaceScopedArtifactSource {
  return s != null && typeof (s as RowSpaceScopedArtifactSource).aligned_to === 'string'
}

// ── the OFFERING predicate (ITEM-17 / ITEM-18) ──────────────────────────────────────
//
// `applies_to` and this are two different questions and neither substitutes for the other
// (design §6.1): the first is about KIND (is this section relevant to this project at
// all?), this one is about IDENTITY (are these values paintable on THESE points?). One
// dataset's column and another's coordinates can be perfectly matching KINDS; painting the
// first on the second answers a question about the wrong ENTITIES, silently, and that is
// the failure this whole predicate exists to prevent.
//
// It is applied BY THE ENGINE, not by each view. A view declares WHICH row space it is
// anchored to and nothing else, so there is no per-view spelling of the rule to get wrong
// — and no view can widen it.

/**
 * ONE axis of the anchored row space, resolved to the two things the predicate compares
 * against.
 *
 * `contentHash` is the axis's IDENTITY as the wire states it (`AxisSummary.content_hash` —
 * the content hash of the key artifact that IS the axis). `keySequenceDigest` is what an
 * ALIGNED artifact declares (`structure.aligned_to`, ITEM-15). They are two different
 * identifiers of the same row space, in two different namespaces, and that is not an
 * oversight in either: a producer cannot declare a `content_hash` — ingest mints it, after
 * the fact, over bytes the producer has not finished writing — so the only identity a
 * producer CAN name is the ordered key sequence. The engine therefore JOINS rather than
 * compares, and {@link resolveRowSpaceAnchor} is the whole of the join.
 */
export interface RowSpaceAxis {
  /** this axis's identity, as `$scope.axis` carries it. */
  contentHash: string
  /** the key sequence an artifact aligned to this axis declares; `undefined` when the
   *  axis's own key artifact does not declare one, which makes alignment UNANSWERABLE
   *  rather than false (see {@link alignmentState}). */
  keySequenceDigest?: string
  /**
   * The axis LABEL this axis's own key artifact declares (`structure.axis`).
   *
   * A label, never an identity — which is why it is used in exactly ONE direction: two
   * candidates declaring DIFFERENT labels are on different axes, and that is decidable from
   * the labels alone. Equal labels prove nothing (every dataset's rows are called the same
   * thing), so an equality here decides nothing and falls through to the digests.
   */
  axis?: string
  /**
   * WHICH MEMBERS OF THIS AXIS THE ANCHOR ITSELF IS ABOUT — the chosen coordinate's own
   * membership entry on this axis, or `undefined` when it declared none (ITEM-7 / ITEM-9).
   *
   * ── WHY IT IS HERE AND NOT ON A THIRD PANE-SCOPE VALUE ─────────────────────────────────
   *
   * INV-3 denominates on the COORDINATE's members, and the coordinate's declaration lives on
   * the COORDINATE artifact — not on the key artifact this axis resolved from. The two had to
   * be joined somewhere. `PANE_SCOPE_KEYS` is deliberately CLOSED at two (DEC-10) and widening
   * it is an owner decision, so the join is made here instead, out of a value the pane ALREADY
   * carries: `$scope.coordinate` is one of those two keys, and every call site that builds an
   * anchor already holds it — `resolveRowSpaceColumns`' fourth parameter, `resolvePaneFrame`'s
   * fourth, and `scope` itself in `viewData` and `resolveArtifactRefSource`.
   *
   * The join is on the SAME identity the anchor is keyed on — this axis's
   * {@link keySequenceDigest} against the coordinate's `memberships[].aligned_to` — so it adds
   * no second notion of what makes two axes the same thing, and it reads no artifact the
   * resolver was not already handed. It is the join `axesOfCoordinate` makes one layer up,
   * made here from the digest rather than from the key artifact, because importing that
   * resolver would close a cycle (`coordinateAxis.ts` reads this module).
   *
   * `undefined` is an ordinary state and NOT an empty membership: a coordinate that declared
   * nothing leaves the intersection UNDECIDABLE, which OFFERS (never withholds) and renders no
   * figure — the opposite of a declared membership of zero members.
   */
  membership?: DeclaredMembership
}

/**
 * The anchored row space — the axes it rests on (ITEM-8).
 *
 * ── WHY THIS IS A LIST AND NOT ONE AXIS ─────────────────────────────────────────────────
 *
 * It was one axis, and one axis is a claim: *the rows of this picture are the rows of that
 * key sequence.* An INTEGRATED coordinate falsifies it — its positions rest on TWO datasets'
 * axes at once, and there is no third axis to name instead (design §2.1: an artifact declares
 * an `(axis identity, membership)` pair PER AXIS, and nothing composes two of them into one).
 * A scalar anchor over such a coordinate could only ever name one of the two, which offers one
 * dataset's columns and silently drops the other's — a wrong ANSWER, not a partial one.
 *
 * So the anchor carries every axis the coordinate declared, IN THE ORDER IT DECLARED THEM
 * (the segment order is the anchor's to state, never the consumer's to invent), and the
 * predicate below folds over them.
 *
 * `axes` is NEVER empty: an anchor over no axis is `undefined` — the A0 state — not an
 * anchor that matches nothing. {@link resolveRowSpaceAnchor} is the only constructor and it
 * enforces that.
 */
export interface RowSpaceAnchor {
  /** the axes this row space rests on, in the order the coordinate declared them; never empty. */
  axes: readonly RowSpaceAxis[]
  /** the CHOSEN COORDINATE artifact whose memberships the axes above carry, when one was named.
   *  Carried because a gather (ITEM-14) reads its member index BODY, and an index body is
   *  addressed by `(artifact, member)` — the entry alone names only the member. */
  coordinate?: string
}

/**
 * Resolve the anchored axes' `content_hash`es to their {@link RowSpaceAnchor}.
 *
 * A client-side join, keyed on `content_hash` and on nothing else (DEC-5's rule, applied to
 * the second thing that needs it): the catalog already delivers the axes and the artifacts
 * in one response, so the key artifact is findable and its declared key sequence readable
 * with no extra request and no new wire field. Joining on `AxisSummary.name` would be the
 * INV-1 violation the field exists to remove — two row spaces legitimately share a label.
 *
 * An unresolvable hash yields `undefined`, NOT a permissive anchor: an anchor nobody can
 * find is not an anchor, and answering "everything is aligned" to it would offer every
 * candidate in the project against a row space that is not in the catalog.
 *
 * **ALL OR NOTHING** (ITEM-8). If ANY named hash fails to resolve, the whole anchor is
 * `undefined` — it does not anchor on the ones that did. An anchor that quietly forgot one of
 * its axes is precisely the truncation the plural anchor exists to prevent: it looks anchored,
 * it offers, and every offer is about a subset of the rows the user is looking at. Answering
 * A0 instead makes the sections say what they need, which is the loud failure.
 */
export function resolveRowSpaceAnchor(
  artifacts: readonly ArtifactRow[],
  contentHashes: readonly string[] | null | undefined,
  coordinate?: string | null,
): RowSpaceAnchor | undefined {
  if (!Array.isArray(contentHashes)) return undefined
  // Distinct, order-preserving. A repeated hash names one axis however many times it is
  // written, and duplicating it in the anchor would double every fold below for no answer.
  const wanted = [...new Set(contentHashes.filter(h => typeof h === 'string' && h !== ''))]
  if (wanted.length === 0) return undefined
  // The ANCHOR's own memberships (ITEM-7 / ITEM-9) — read once, from the chosen coordinate
  // artifact, and attached per axis below by the digest join. Absent coordinate, coordinate
  // not in the catalog, or a coordinate declaring nothing ⇒ an empty list, which leaves every
  // axis's `membership` `undefined` and every intersection undecidable. That is the state of
  // every project today and it must go on offering exactly what it offers now (INV-9).
  const anchorMemberships =
    typeof coordinate === 'string' && coordinate !== ''
      ? declaredMemberships(artifacts.find(a => a.id === coordinate)?.structure)
      : []
  const axes: RowSpaceAxis[] = []
  for (const contentHash of wanted) {
    const key = artifacts.find(a => a.content_hash === contentHash)
    if (!key) return undefined
    const declared = (key.structure as { key_sequence_digest?: unknown } | null | undefined)
      ?.key_sequence_digest
    const keySequenceDigest = typeof declared === 'string' && declared !== '' ? declared : undefined
    axes.push({
      contentHash,
      keySequenceDigest,
      // The coordinate's OWN membership on THIS axis. SOLE or none: two entries naming one
      // axis is a declaration that did not identify one thing, and picking either would be
      // the `layouts[0]` guess wearing a join — so it stays undecidable rather than becoming
      // a confident denominator.
      membership:
        keySequenceDigest === undefined
          ? undefined
          : sole(anchorMemberships.filter(m => m.alignedTo === keySequenceDigest)),
      // The SOLE declared axis, or none. Never `[0]` of several: a multi-axis artifact (a
      // matrix declares both) does not name ONE axis, and taking the first would be the
      // `layouts[0]` guess this codebase deletes on sight. A key artifact is single-axis by
      // construction, so the plural case yields `undefined` and the label simply decides
      // nothing — the digests still do.
      axis: soleDeclaredAxis(key.structure),
    })
  }
  return { axes, coordinate: anchorMemberships.length > 0 ? (coordinate ?? undefined) : undefined }
}

/**
 * THE GATHER a column needs before it can be PAINTED on this anchor (ITEM-14 / ITEM-20), or
 * `undefined` when it needs none.
 *
 * The Stage-A case, and the one the whole round exists for: the coordinate is a SUBSET of its
 * axis and the column describes the WHOLE axis. Their lengths differ by orders of magnitude, so
 * painting the column as it stands is not a smaller version of working — it addresses row *i* of
 * a million where row *i* of six thousand was meant. The gather reads the column at the
 * COORDINATE's member positions, so the painted column is the coordinate's own rows.
 *
 * ── IT IS DELIBERATELY NARROW, AND THE NARROWNESS IS THE CORRECTNESS ────────────────────────
 *
 * A gather is returned ONLY when the column declares `kind: full` on the anchor's axis and the
 * coordinate declares a `subset` with an index body to gather by. Every other combination
 * answers `undefined` and the read is exactly the read it was:
 *   · both `full` — the lengths already agree; a gather would be an identity permutation with a
 *     read attached.
 *   · the column a `subset` — its rows are its OWN members, and re-indexing them by the
 *     coordinate's positions would index a subset by axis-space positions. That is the
 *     off-by-thousands paint this model exists to make impossible, and it is the reason this
 *     returns `undefined` rather than attempting a set intersection: two subsets need the
 *     correspondence, which is stage B's, not a guess here.
 *   · the coordinate declaring no index body — nothing to gather BY. Above ITEM-5's budget the
 *     inline set is absent but the body is the authority, so this reads the body's NAME from the
 *     declaration and never the inline blob.
 */
export interface MemberGather {
  /**
   * The SEGMENTS, in the order the ANCHOR declared its memberships (ITEM-11, INV-7). Never
   * empty.
   *
   * The order is the anchor's `axes` array order, which is `axesOfCoordinate`'s reading of the
   * coordinate's own `structure.memberships` array — a DECLARATION, not a derivation. This
   * function may not sort, and does not: a membership is a SET and carries no order, so any
   * order imposed here (by axis identity, by dataset, by anything) would be invented. It would
   * also be invisible — every segment is present, the total length is right, and only the
   * SEQUENCE is wrong, which paints a picture permuted against the positions beside it.
   */
  readonly segments: readonly MemberGatherSegment[]
}

/** ONE segment of a gather — WHICH parent column, and WHICH of its rows. */
export interface MemberGatherSegment {
  /** the parent COLUMN this segment's rows are read from. Carried per segment because a
   *  cross-dataset gather's segments are described by different datasets' columns. */
  readonly column: string
  /** WHICH column WITHIN it, when the parent is a MATRIX rather than a column (ITEM-16/19).
   *  Absent ⇒ the artifact IS the column, which is every membership gather. Present ⇒ this is
   *  one side of a CORRESPONDENCE, and the two sides sit at DIFFERENT indices by construction —
   *  which is why the selector is per SEGMENT and not per gather. */
  readonly columnIndex?: number
  /** the axis's identity, checked against the parent column's own declaration at gather time
   *  (ITEM-12) before a single parent byte is requested. */
  readonly alignedTo: string
  /** the artifact holding the index body — the COORDINATE, not the column. */
  readonly artifact: string
  /** the member within it (ITEM-1's `members` key). */
  readonly member: string
  /** how many members — what this segment contributes to the gathered length. */
  readonly count: number
  /** the producer's declared position for this segment (ITEM-11) — what {@link MemberGather}'s
   *  segments are ranked by, kept on the segment so the ranking is inspectable rather than an
   *  invisible property of the array it arrived in. */
  readonly declaredOrder: number
  /**
   * The anchor is a CORRESPONDENCE (an INTEGRATED coordinate, resting on more than one axis),
   * so this segment's index body is the coordinate's declared row SEQUENCE — a permutation
   * (INV-6/INV-7), not an ascending subset set. The reader gathers it by RANDOM ACCESS and reads
   * the body without the ascending guard. Absent ⇒ a single-axis subset gather (ITEM-20), whose
   * body is ascending and walked in one pass.
   */
  readonly sequence?: boolean
}

export function gatherFor(
  column: string,
  structure: unknown,
  anchor: RowSpaceAnchor | null | undefined,
): MemberGather | undefined {
  if (!anchor?.coordinate) return undefined
  const theirs = declaredMemberships(structure)
  if (theirs.length === 0) return undefined
  const segments: MemberGatherSegment[] = []
  // A CORRESPONDENCE anchor rests on more than one axis (an INTEGRATED coordinate — ITEM-19).
  // Its per-axis index bodies are the coordinate's declared row SEQUENCE (a permutation,
  // INV-6/INV-7), so a column aligned to ONE of those axes is gathered by random access through
  // that axis's permutation rather than by the ascending one-pass subset walk. A single-axis
  // (subset) anchor keeps the ascending gather it always had.
  const sequence = anchor.axes.length > 1
  // IN THE ANCHOR'S OWN ORDER (ITEM-11) — `anchor.axes` is `axesOfCoordinate`'s reading of the
  // coordinate's declared `memberships` array, preserved. Walking it in order and pushing is
  // the whole of the ordering rule; there is deliberately no comparator anywhere below.
  for (const axis of anchor.axes) {
    const mine = axis.membership
    if (mine === undefined || mine.kind !== 'subset') continue
    if (mine.members === undefined || mine.nMembers === undefined) continue
    const onAxis = theirs.filter(m => m.alignedTo === mine.alignedTo)
    if (onAxis.length !== 1 || onAxis[0].kind !== 'full') continue
    segments.push({
      column,
      alignedTo: mine.alignedTo,
      artifact: anchor.coordinate,
      member: mine.members,
      count: mine.nMembers,
      declaredOrder: mine.declaredOrder,
      ...(sequence ? { sequence: true } : {}),
    })
  }
  // The one ordering step, and it ranks by the PRODUCER'S OWN declaration index — not by axis
  // identity, not by dataset, not by count. `anchor.axes` carries the declaration order today
  // because `$scope.axis` is derived from it, but that is a caller's convention rather than a
  // guarantee, and this must not depend on it: the order is the coordinate's statement about
  // its own rows, and it is read from the statement.
  segments.sort((x, y) => x.declaredOrder - y.declaredOrder)
  return segments.length === 0 ? undefined : { segments }
}

/**
 * THE CORRESPONDENCE'S GATHER (ITEM-19) — one segment per row-space axis, each from its OWN
 * parent at its OWN column index, in the ANCHOR's declared order.
 *
 * The membership half is identical to {@link gatherFor}'s and is deliberately not duplicated:
 * the coordinate must declare a `subset` with an index body on the axis, and the side describing
 * that axis must declare `kind: full` on it. What differs is that the parent is resolved PER
 * AXIS rather than being one column for all of them — which is the whole content of INV-6.
 *
 * ── ALL OR NOTHING ──────────────────────────────────────────────────────────────────────────
 *
 * A correspondence that could build segments for only SOME of the anchor's axes answers
 * `undefined`, not a partial gather. A partial one emits a row sequence shorter than the
 * coordinate's, laid against the coordinate's own positions: every value present, every value
 * against the wrong row from the first missing segment onward. {@link gatherFor} is left alone
 * here — its partial behaviour on a plural anchor is pre-existing and is ITEM-20's, not this
 * function's to change.
 */
export function correspondenceGather(
  anchor: RowSpaceAnchor | null | undefined,
  sideFor: (rowSpaceAxis: string) => { column: string; columnIndex: number; structure: unknown } | undefined,
): MemberGather | undefined {
  if (!anchor?.coordinate) return undefined
  const coordinate = anchor.coordinate
  const segments: MemberGatherSegment[] = []
  for (const axis of anchor.axes) {
    const mine = axis.membership
    if (mine === undefined || mine.kind !== 'subset') return undefined
    if (mine.members === undefined || mine.nMembers === undefined) return undefined
    const side = sideFor(axis.contentHash)
    if (!side) return undefined
    const theirs = declaredMemberships(side.structure)
    const onAxis = theirs.filter(m => m.alignedTo === mine.alignedTo)
    if (onAxis.length !== 1 || onAxis.reduce(first => first).kind !== 'full') return undefined
    segments.push({
      column: side.column,
      columnIndex: side.columnIndex,
      alignedTo: mine.alignedTo,
      artifact: coordinate,
      member: mine.members,
      count: mine.nMembers,
      declaredOrder: mine.declaredOrder,
    })
  }
  if (segments.length !== anchor.axes.length || segments.length === 0) return undefined
  // The one ordering step, ranking by the PRODUCER's own declaration index — never by axis
  // identity, dataset or count (ITEM-11). Identical to `gatherFor`'s, for the identical reason.
  segments.sort((x, y) => x.declaredOrder - y.declaredOrder)
  return { segments }
}

/** The SOLE member of a list, or `undefined`. Ambiguity is not a tie to break. */
function sole<T>(xs: readonly T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined
}

/** The ONE axis an artifact declares, or `undefined` when it declares none or several. */
function soleDeclaredAxis(structure: unknown): string | undefined {
  const axes = declaredAxes(structure)
  return axes.length === 1 ? axes[0] : undefined
}

/**
 * Is this artifact AN AXIS rather than something ON one?
 *
 * A key artifact declares the ordered key sequence that IS the row space
 * (`structure.key_sequence_digest`) — §7.7.2: *"an axis IS a key artifact with an identity
 * of its own"*. It is therefore never a candidate COLUMN: offering it means offering the
 * identifiers as a thing to colour by, one distinct value per row.
 *
 * It was offered, on every project, and it was MARKED while it was: a key artifact correctly
 * declares no `aligned_to` (it is aligned to itself, and declaring both is the contradiction
 * the producer's own fidelity test forbids), so it read as A3 — alignment not declared. That
 * is the shape of the whole defect class here: a question answered from the wrong premise. The
 * axis is not of unknown alignment; it is the thing the others are aligned TO.
 */
export function isAxisArtifact(structure: unknown): boolean {
  if (structure == null || typeof structure !== 'object') return false
  const digest = (structure as { key_sequence_digest?: unknown }).key_sequence_digest
  return typeof digest === 'string' && digest !== ''
}

/** What an artifact DECLARES about the row space its values line up with (ITEM-15's
 *  `structure.aligned_to`). Absent ⇒ `undefined`; the producer said nothing, which is a
 *  state (A3), not a match and not a mismatch. */
export function declaredAlignment(structure: unknown): string | undefined {
  if (structure == null || typeof structure !== 'object') return undefined
  const value = (structure as { aligned_to?: unknown }).aligned_to
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * ONE `(axis identity, members)` pair an artifact declared — the design's unit (§2).
 *
 * `alignedTo` is the only IDENTIFYING component. `axis` is the producer's LABEL and is
 * carried for display and for the one negative use a label has (two different labels are
 * two different axes); it never decides a match.
 */
export interface DeclaredMembership {
  /** the axis's identity — the key artifact's `key_sequence_digest`. */
  alignedTo: string
  /** the producer's axis LABEL, when it declared one. Never an identity. */
  axis?: string
  /** `full` — every row of that axis. `subset` — the `nMembers` named by the member set. */
  kind: 'full' | 'subset'
  /** how many of the axis's rows this artifact is about. */
  nMembers?: number
  /** the inline member set (ITEM-5), present only within the producer-side budget.
   *  Absent means "above the budget", which is UNDECIDABLE — never "empty". */
  bitmap?: string
  /** the Zarr member holding the index body (ITEM-3) — the gather list, and the
   *  authority whenever {@link bitmap} is absent. */
  members?: string
  /**
   * WHERE THIS ENTRY SAT IN THE PRODUCER'S `memberships` ARRAY — the declared segment order
   * (ITEM-11, INV-7), carried with the entry rather than left to whatever order a consumer
   * happened to assemble its axes in.
   *
   * A gather's row sequence is its segments concatenated, so their order is load-bearing and a
   * membership — being a SET — supplies none of its own. Reading it off the anchor's `axes`
   * array instead would make the order a property of HOW THE ANCHOR WAS BUILT: `$scope.axis`
   * carries the declaration order today, but that is a caller's convention, and a caller that
   * assembled the same two axes in the other order would silently permute the picture while
   * every count still agreed. Recorded here, the DECLARATION decides, whoever asks.
   *
   * The legacy scalar spelling is one entry and is therefore `0`.
   */
  declaredOrder: number
}

/**
 * WHICH members of WHICH axes an artifact declares its rows are (ITEM-6) — the SINGLE
 * reader, and the one place `structure.memberships` is narrowed.
 *
 * `ArtifactRow.structure` is `unknown` at the TS boundary, so a new declaration key costs
 * no type change and gets no compiler help either. That is precisely why there is exactly
 * one reader: the same discipline `declaredAlignment` / `declaredAxes` already hold.
 *
 * ── THE LEGACY DEFAULT IS APPLIED HERE, AT READ (ITEM-2 / INV-9) ────────────────────────
 *
 * *"Existing artifacts need a DEFAULT, not a rewrite."* Every artifact in every project
 * today declares the scalar `structure.aligned_to` and nothing else, and it already means
 * something exact: these values line up with that key sequence, all of them. That IS a
 * membership — `{aligned_to, kind: full}` — so it is read as one, here, and no artifact is
 * migrated, backfilled or rewritten. A rule that required a `memberships` array to offer
 * anything would take every existing project's offers away on the day it shipped.
 *
 * ── `[]` IS "DECLARED NOTHING", WHICH IS A3 — NOT "DECLARED AN EMPTY SET" ───────────────
 *
 * An artifact declaring neither spelling yields `[]`, and `[]` must never be confused with
 * a declared membership of zero members. They are opposite states: the first is A3
 * (unknown — offered and marked, because it is what an un-stamping producer emits) and the
 * second would be A4 (known, on this axis, and about none of these rows — not offered).
 * Collapsing them silently deletes offers, which is the same shape as the read-A3-as-A1
 * error this pane already shipped once.
 *
 * ── NOTHING COMPOSES (INV-5) ───────────────────────────────────────────────────────────
 *
 * This reads ONE artifact's own declaration and stops. It does not follow a reference to a
 * parent, and there is no chain to walk: a membership computed on a derived artifact
 * anchors to the ORIGINAL dataset axis's digest, which is what makes a derived-of-derived
 * artifact resolvable in exactly one hop.
 */
export function declaredMemberships(structure: unknown): DeclaredMembership[] {
  if (structure == null || typeof structure !== 'object') return []
  const entries = (structure as { memberships?: unknown }).memberships
  if (Array.isArray(entries)) {
    const out: DeclaredMembership[] = []
    let position = -1
    for (const entry of entries) {
      position += 1
      if (entry == null || typeof entry !== 'object') continue
      const e = entry as {
        aligned_to?: unknown
        axis?: unknown
        kind?: unknown
        n_members?: unknown
        bitmap?: unknown
        members?: unknown
      }
      if (typeof e.aligned_to !== 'string' || e.aligned_to === '') continue
      // An UNRECOGNISED `kind` is skipped rather than defaulted. Defaulting it to `full`
      // would turn a declaration this reader does not understand into the strongest claim
      // in the vocabulary; skipping it leaves the artifact reading A3, which is the state
      // for "the producer said something we cannot act on".
      if (e.kind !== 'full' && e.kind !== 'subset') continue
      out.push({
        alignedTo: e.aligned_to,
        axis: typeof e.axis === 'string' && e.axis !== '' ? e.axis : undefined,
        kind: e.kind,
        nMembers: typeof e.n_members === 'number' ? e.n_members : undefined,
        bitmap: typeof e.bitmap === 'string' && e.bitmap !== '' ? e.bitmap : undefined,
        members: typeof e.members === 'string' && e.members !== '' ? e.members : undefined,
        // The producer's own array position — counted over the DECLARED entries, so an entry
        // this reader skipped (an unrecognised `kind`) leaves a gap rather than shifting every
        // entry after it up one. The value is a RANKING and is only ever compared, so a gap
        // costs nothing; a shift would quietly reorder the tail.
        declaredOrder: position,
      })
    }
    return out
  }
  // ITEM-2's default. The scalar spelling is not legacy debt to be tolerated — it is a
  // complete declaration of the commonest case, and it keeps meaning exactly what it means
  // today.
  const scalar = declaredAlignment(structure)
  if (scalar === undefined) return []
  return [{ alignedTo: scalar, axis: soleDeclaredAxis(structure), kind: 'full', declaredOrder: 0 }]
}

/**
 * The inline member set (ITEM-5's `bitmap`) → the exact member positions, ascending.
 *
 * The inverse of `txr_zarr.encode_member_set`, and the ONLY decoder on this side. Base64 over
 * a DELTA-VARINT (LEB128): each position is stored as its gap from the previous one, and each
 * gap as a base-128 varint. See that function's own docstring for why the format is not a
 * roaring bitmap (DRIFT-1.6): the blob has to be readable by numpy+stdlib AND by a browser,
 * and neither has roaring, so "roaring" meant hand-writing a compressed container twice and
 * keeping the two byte-exact.
 *
 * `undefined` on ANY malformation — a bad base64 body, or a trailing varint with no
 * terminating byte. Never a partial list: a member set decoded halfway is an off-by-thousands
 * gather with a plausible shape, which is the failure this whole model exists to make
 * impossible. `undefined` reads as UNDECIDABLE everywhere it is consumed, which offers and
 * renders no figure.
 */
export function decodeMemberSet(blob: string | undefined): number[] | undefined {
  if (typeof blob !== 'string' || blob === '') return undefined
  let raw: string
  try {
    raw = atob(blob)
  } catch {
    return undefined
  }
  const out: number[] = []
  let previous = -1
  let gap = 0
  let shift = 0
  let started = false
  for (let i = 0; i < raw.length; i++) {
    const byte = raw.charCodeAt(i)
    started = true
    gap += (byte & 0x7f) * 2 ** shift
    if (byte & 0x80) {
      shift += 7
      continue
    }
    previous += gap
    out.push(previous)
    gap = 0
    shift = 0
    started = false
  }
  // A truncated blob is REFUSED rather than yielding the members that did decode. The
  // truncation this guards is the one ITEM-5 refuses at the writer (`bitmap` is absent above
  // the budget, never cut short); a blob that arrives cut short anyway came from somewhere
  // that did not honour that, and trusting its prefix is the same wrong answer one layer down.
  return started ? undefined : out
}

/**
 * The MEMBER POSITIONS a declaration names on its axis, or `undefined` when nobody can say.
 *
 * `kind: full` deliberately answers `undefined` too, and it is not a shortfall: `full` names
 * every row of the axis WITHOUT enumerating them, so there is no position list to produce and
 * none is needed — every consumer below special-cases `full` before it asks for one. The two
 * undecidables are distinguished by {@link DeclaredMembership.kind}, never by this returning
 * an empty array, because an empty array is a declared membership of NO members and that is
 * the opposite claim.
 */
function memberPositions(m: DeclaredMembership | undefined): number[] | undefined {
  if (m === undefined || m.kind === 'full') return undefined
  return decodeMemberSet(m.bitmap)
}

/** |A ∩ B| for two ASCENDING position lists, in one pass. The lists are the writer's own
 *  stored order (`encode_member_set` refuses a non-ascending set), so no sort is needed and
 *  none is done — sorting here would hide a producer that broke that promise. */
function intersectionSize(a: readonly number[], b: readonly number[]): number {
  let i = 0
  let j = 0
  let n = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      n++
      i++
      j++
    } else if (a[i] < b[j]) i++
    else j++
  }
  return n
}

/**
 * How many of the ANCHOR's rows on ONE axis a candidate's membership describes — three-valued.
 *
 * `'undecidable'` is returned wherever the answer is not derivable from the two DECLARATIONS,
 * and it is never filled in by reading a body (INV-8) and never estimated from two counts
 * (the design is explicit that intersection cardinality is not derivable that way). The cases
 * that ARE decidable are decidable EXACTLY:
 *
 * · either side `full` ⇒ the intersection IS the other side's set, so its size is that side's
 *   own declared count. That is set arithmetic, not an estimate, and it is the COMMON case.
 * · both `subset` with both inline sets present ⇒ a real intersection, walked.
 * · anything else (a missing inline set above ITEM-5's budget, an undeclared count) ⇒
 *   undecidable.
 */
function intersectionOnAxis(
  candidate: DeclaredMembership,
  anchor: DeclaredMembership,
): number | 'undecidable' {
  if (candidate.kind === 'full' && anchor.kind === 'full') {
    return anchor.nMembers ?? 'undecidable'
  }
  if (candidate.kind === 'full') return anchor.nMembers ?? memberPositions(anchor)?.length ?? 'undecidable'
  if (anchor.kind === 'full') return candidate.nMembers ?? memberPositions(candidate)?.length ?? 'undecidable'
  const mine = memberPositions(anchor)
  const theirs = memberPositions(candidate)
  if (mine === undefined || theirs === undefined) return 'undecidable'
  return intersectionSize(theirs, mine)
}

/**
 * HOW MANY OF THE ANCHOR'S ROWS A CANDIDATE DESCRIBES — INV-3, three-valued (ITEM-9).
 *
 * `|theirs ∩ mine| / |mine|`, **denominated on the COORDINATE's members**, never on the
 * candidate's own. The two denominators give different, equally plausible percentages, and
 * only one of them answers the question a reader is asking of this list ("how much of the
 * picture in front of me would this colour?").
 */
export type DescribedRows =
  /** every one of the anchor's `of` rows. The COMMON case, and it needs no member set on
   *  either side: `full` names them all without enumerating them. */
  | { kind: 'full'; of: number }
  /** `described` of the anchor's `of` rows — a real intersection, walked. */
  | { kind: 'ratio'; described: number; of: number }
  /** the anchor's rows are counted, but the intersection is NOT derivable from the
   *  declarations — an inline member set is absent above ITEM-5's budget. Displayed, not
   *  suppressed (Q3), and never filled in by a body read (INV-8) or estimated from two
   *  counts (the design is explicit that cardinality is not derivable that way). */
  | { kind: 'undecidable'; of: number }

/**
 * The figure for ONE candidate against the anchor, or `undefined` when the question is not
 * posed at all.
 *
 * `undefined` — not a fourth value — covers *nobody stated the denominator*: no anchor, an
 * anchor whose coordinate declared no membership (every project today), or an anchor axis
 * whose declared membership carries no count. The line then simply does not render, which is
 * what {@link candidateCoverage} already does for an undeclared shape and is what keeps a
 * legacy project's list looking exactly as it looks now. It is deliberately NOT
 * `undecidable`: `undecidable` is a statement ABOUT a known population ("of these 10,000
 * rows, how many is not declared"), and printing it where no population is known would put a
 * sentence on every row of every project that says nothing.
 *
 * ── IT IS COMPUTED FROM DECLARATIONS, NEVER FROM WHAT HAS ARRIVED ──────────────────────
 *
 * The figure must be identical whether a slice has landed nothing, some of its rows, or all
 * of them (TEST-64). A figure derived from arrived data changes as data streams in, which
 * reads as progress and is a violation — the resolver that renders this list issues zero
 * data-plane reads by construction (INV-8) and this function is pure over `structure`.
 *
 * ── ACROSS SEVERAL AXES IT IS ONE SUM, NOT ONE AXIS ────────────────────────────────────
 *
 * An integrated coordinate's rows are the segments of every axis it rests on, so `mine` is
 * the sum of the per-axis member counts and `theirs ∩ mine` is the sum of the per-axis
 * intersections. A candidate declaring a membership on only ONE of the axes contributes zero
 * to the numerator on the others and their rows still count in the denominator — which is
 * exactly right, and is the sentence the design tells: one dataset's column describes one
 * dataset's half of the picture.
 */
export function describedRows(
  structure: unknown,
  anchor: RowSpaceAnchor | null | undefined,
): DescribedRows | undefined {
  if (!anchor) return undefined
  const mineMemberships = anchor.axes.map(a => a.membership)
  // Nothing on the anchor's side states a population ⇒ the question is not posed.
  if (mineMemberships.every(m => m === undefined)) return undefined
  const theirs = declaredMemberships(structure)
  let of = 0
  let described = 0
  let undecidable = false
  for (const axis of anchor.axes) {
    const mine = axis.membership
    // An axis the coordinate said nothing about has no counted rows to denominate on, and
    // guessing the axis's full length for it would invent the denominator INV-3 names.
    if (mine === undefined || axis.keySequenceDigest === undefined) return undefined
    const total = mine.nMembers ?? memberPositions(mine)?.length
    if (total === undefined) return undefined
    of += total
    const onAxis = theirs.filter(m => m.alignedTo === axis.keySequenceDigest)
    // Nothing declared on this axis ⇒ this axis's rows are in the denominator and none of
    // them in the numerator.
    if (onAxis.length === 0) continue
    // SEVERAL entries naming one axis is a declaration that did not identify one member set;
    // summing them would double-count any overlap and picking one would be a guess.
    if (onAxis.length > 1) {
      undecidable = true
      continue
    }
    const n = intersectionOnAxis(onAxis[0], mine)
    if (n === 'undecidable') undecidable = true
    else described += n
  }
  if (undecidable) return { kind: 'undecidable', of }
  return described === of ? { kind: 'full', of } : { kind: 'ratio', described, of }
}

/**
 * THE SENTENCE the offered row prints (ITEM-10) — *"describes N of M rows"*.
 *
 * ── WHY NOT THE WORD "COVERAGE" ────────────────────────────────────────────────────────
 *
 * `alignmentCoverage.ts` already owns that word in this pane, for a different quantity
 * entirely (a project's A3-exit migration percentage, `declared / total` artifacts). A second
 * "coverage" beside the first is a defect in waiting, so the quantity is NAMED instead —
 * `describes N of M rows` is the fleet's existing `Showing N of M` idiom and introduces no
 * competing noun. The word does not appear in this function, in its type, or in anything it
 * returns.
 *
 * Nothing is suppressed (Q3 ruled): the undecidable case says so, in the same shape, rather
 * than rendering blank or a computed guess.
 */
export function describedRowsLine(figure: DescribedRows | undefined): string | undefined {
  if (figure === undefined) return undefined
  const rows = `${figure.of.toLocaleString()} ${figure.of === 1 ? 'row' : 'rows'}`
  if (figure.kind === 'full') return `describes all ${rows}`
  if (figure.kind === 'ratio') return `describes ${figure.described.toLocaleString()} of ${rows}`
  return `describes some of ${rows} — how many is not declared`
}

/**
 * The four row-space states of a candidate, relative to an anchor (design §7.7.2, ITEM-18).
 *
 * They are states of a candidate offered AGAINST AN ANCHORED ROW SPACE — none of them is a
 * property of an artifact alone, which is why `alignmentUnknown` is `undefined` (the
 * question was never asked) everywhere the anchor is absent, and why `undefined` must never
 * be read as A3.
 */
export type AlignmentState = 'A0' | 'A1' | 'A2' | 'A3' | 'A4'

/**
 * Which of the four states this candidate is in.
 *
 * · **A0** — no anchor. Nothing is offered: with no row space chosen there is no question
 *   to answer, and offering the project's artifacts would be the fallback INV-4 forbids.
 * · **A1** — declared, and it is this row space's key sequence. Offered.
 * · **A2** — declared, and it is a DIFFERENT row space's. NOT offered — not
 *   offered-and-disabled: a disabled row invites the reader to work out why one dataset's
 *   columns are listed under another's coordinates, which is not a question they should be
 *   asked.
 * · **A3** — the producer declared nothing, so alignment is unknown. Offered, MARKED, never
 *   chosen for the user (INV-10). This is today's state for every artifact in every
 *   project, which is why A3 is offered rather than refused.
 * · **A4** — declared, it IS this row space's key sequence, and its members are PROVABLY
 *   disjoint from the anchor's (ITEM-7). NOT offered, and not A2: its alignment is known and
 *   correct, it simply describes none of these rows — a column about a different population
 *   of the same dataset. Reachable only from two declared member sets; every undecidable
 *   intersection is A1, so no project loses an offer it has today (INV-9).
 *
 * An anchor whose own key artifact declares no key sequence makes every candidate A3 rather
 * than A2: the question cannot be answered from either side, and reporting "aligned
 * elsewhere" would be a confident wrong answer about candidates that may well be aligned.
 *
 * ── A3 IS FOR *UNKNOWN*, NOT FOR *NOT ASKED THE RIGHT QUESTION* ─────────────────────────
 *
 * A candidate that declares a DIFFERENT AXIS from the anchor's is A2, and it reaches that
 * verdict without any digest: its alignment is not unknown, it is known and elsewhere. Before
 * this, the only question asked was "does `aligned_to` match?", so a candidate that declared
 * no `aligned_to` landed in A3 — *offered and marked* — however plainly it said which axis it
 * was on. The reported symptom was a colouring list holding values that are one-per-ENTRY of
 * the other axis, and a marker on rows whose alignment nobody was in any doubt about. A mark
 * that fires on everything stops being read, which is the same argument ITEM-20 makes for
 * standing the per-row marks down.
 *
 * It is checked SECOND, and only where the digests could not answer: a POSITIVE declared join
 * outranks a label mismatch, so a producer that spells its axis differently but declares the
 * right key sequence is still A1. And the label is used only NEGATIVELY (see
 * {@link RowSpaceAxis.axis}) — two things called the same are not thereby the same thing.
 */
export function alignmentState(
  structure: unknown,
  anchor: RowSpaceAnchor | null | undefined,
): AlignmentState {
  if (!anchor) return 'A0'
  // ── THE FOLD OVER A PLURAL ANCHOR (ITEM-8) ────────────────────────────────────────────
  //
  // Each axis is decided on its own by {@link stateOnAxis} — the whole of the single-axis
  // rule, unchanged — and the verdicts combine by STRENGTH, not by position:
  //
  //   · A1 on ANY axis wins outright. These values ARE about rows of this row space; that
  //     another of its axes is a different key sequence is not a reason to withhold them,
  //     it is the ordinary shape of an integrated coordinate (one dataset's column
  //     describes one dataset's half of the rows).
  //   · A2 only when EVERY axis says *elsewhere*. A candidate is aligned-somewhere-else only
  //     if it is elsewhere than all of them; deciding A2 off the first axis alone would drop
  //     the second dataset's every column, which is the truncation this type exists against.
  //   · A3 otherwise — some axis could not answer, so the question is open, and reporting a
  //     confident "elsewhere" about it would be a wrong answer rather than an unknown one.
  //
  // Order-independent by construction: the fold cannot see which axis came first.
  //   · A4 only when EVERY axis says *here, and about none of these rows* — same reasoning as
  //     A2, one state over: a candidate describing NONE of the anchor's rows must describe none
  //     of them on every axis the anchor rests on, or it describes some of them.
  let unknown = false
  let disjoint = false
  for (const axis of anchor.axes) {
    const state = stateOnAxis(structure, axis)
    if (state === 'A1') return 'A1'
    if (state === 'A3') unknown = true
    if (state === 'A4') disjoint = true
  }
  if (unknown) return 'A3'
  return disjoint ? 'A4' : 'A2'
}

/** A candidate's state against ONE axis of the anchor — the single-axis rule, whole. */
function stateOnAxis(structure: unknown, anchor: RowSpaceAxis): 'A1' | 'A2' | 'A3' | 'A4' {
  // ── THE MEMBERSHIP TEST (ITEM-7) ───────────────────────────────────────────────────────
  //
  // A1 is no longer "same axis identity"; it is *same axis identity AND a NON-EMPTY member
  // intersection*. The new state A4 is same axis, known members, and NONE of them are the
  // anchor's — a column whose values are about a different population of the same dataset.
  //
  // A4 is NOT A2, and collapsing them would tell the reader the wrong thing: A2 means "known,
  // and elsewhere"; A4 means "known, HERE, and about none of these rows". They are dropped
  // from the offer alike, but they are different facts and only one of them is a mistake the
  // user could have made.
  //
  // ── A4 CAN ONLY EVER *REMOVE* AN OFFER, AND ONLY ON PROOF ──────────────────────────────
  //
  // Every undecidable falls back to the state the code had before this item: an unknown
  // intersection is A1 (offered), never A4. Disjointness has to be PROVEN from two declared
  // member sets — anything less and a legacy project, whose artifacts declare no members at
  // all, would lose offers on the day this shipped, which is exactly what INV-9 forbids.
  const memberships = declaredMemberships(structure)
  if (memberships.length > 0 && anchor.keySequenceDigest !== undefined) {
    const onAxis = memberships.filter(m => m.alignedTo === anchor.keySequenceDigest)
    // Declared, and none of its entries name this axis — known, and elsewhere.
    if (onAxis.length === 0) return 'A2'
    // No membership on the anchor's side ⇒ nothing to intersect against ⇒ the pre-membership
    // answer, unchanged. This is every project today.
    if (anchor.membership === undefined) return 'A1'
    // ANY entry intersecting is enough: an artifact declaring several memberships on one axis
    // is about the union of them.
    for (const m of onAxis) {
      const n = intersectionOnAxis(m, anchor.membership)
      if (n === 'undecidable' || n > 0) return 'A1'
    }
    return 'A4'
  }
  // The memberships could not answer. The AXIS the producer declared still can, in one
  // direction.
  const axes = declaredAxes(structure)
  if (anchor.axis !== undefined && axes.length > 0 && !axes.includes(anchor.axis)) return 'A2'
  return 'A3'
}

/** The candidates an anchored row space may be painted with — A1 and A3, never A2 and never
 *  A4, and nothing at all under A0. The single predicate design §5.4 says stops a ds1 column
 *  being offered against the integrated row space, and (ITEM-7) stops a column about a
 *  DIFFERENT population of the same dataset being offered against this one. */
export function offeredOnRowSpace<T extends { structure: unknown }>(
  rows: readonly T[],
  anchor: RowSpaceAnchor | null | undefined,
): T[] {
  if (!anchor) return []
  return rows.filter(r => {
    const state = alignmentState(r.structure, anchor)
    return state !== 'A2' && state !== 'A4'
  })
}

// ── reading a producer's declaration ────────────────────────────────────────────────

/** A structure's declared members, whichever spelling the encoding uses. `sparse_csc`'s
 *  `indptr`/`indices`/`data` trio is deliberately NOT enumerated: those three are one
 *  matrix, not three columns, and treating them as members would offer `indptr` as a
 *  column-name candidate. */
function members(structure: unknown): Array<{ name?: string; kind?: string }> {
  if (structure == null || typeof structure !== 'object') return []
  const s = structure as { arrays?: unknown }
  const out: Array<{ name?: string; kind?: string }> = tableColumns(structure).slice()
  if (Array.isArray(s.arrays)) {
    for (const m of s.arrays) if (m && typeof m === 'object') out.push(m as { name?: string; kind?: string })
  }
  return out
}

/** A structure's declared 1-D COLUMNS (the `zarr_v3` table members). Empty for a matrix,
 *  an opaque blob, or anything else that is not a column source. */
export function tableColumns(structure: unknown): Array<{ name?: string; kind?: string }> {
  if (structure == null || typeof structure !== 'object') return []
  const cols = (structure as { columns?: unknown }).columns
  if (!Array.isArray(cols)) return []
  return cols.filter((m): m is { name?: string; kind?: string } => m != null && typeof m === 'object')
}

/**
 * The axis LABELS an artifact's `structure` declares.
 *
 * A `zarr_v3` table names its single shared axis (`structure.axis`); a `sparse_csc`
 * matrix names both (`structure.axes`). Read from the ARTIFACT, never from its datatype's
 * declaration (INV-5): the artifact is the thing that exists and the conformance gate is
 * what verified it.
 */
export function declaredAxes(structure: unknown): string[] {
  if (structure == null || typeof structure !== 'object') return []
  const s = structure as { axis?: unknown; axes?: unknown }
  if (typeof s.axis === 'string' && s.axis !== '') return [s.axis]
  if (Array.isArray(s.axes)) return s.axes.filter((a): a is string => typeof a === 'string' && a !== '')
  return []
}


/**
 * The `values:` term a source may declare, resolved to the member kinds it admits.
 *
 * `text` is a SEMANTIC term: "text-valued, however encoded". It exists because the two
 * shipped uses of `values:` both meant that and both wrote `string`, which names one
 * encoding — so on a real dataset they admitted ONLY the axis's own index column (inline
 * utf8) and excluded every dictionary-encoded label column beside it. The picker then had
 * exactly one candidate, auto-selected it, and the run matched its patterns against
 * identifiers instead of labels: a silent zero, produced by the control built to prevent
 * one.
 *
 * Any other term is matched EXACTLY, so the producer's open kind vocabulary is untouched and
 * an author who genuinely wants one encoding can still name it. Deliberately NOT widened to
 * "any kind": a picker for "which column holds the labels" that offers numeric columns is a
 * different silent-wrong-answer, not a fix.
 */
export function valueKindsFor(term: string): readonly string[] {
  return term === 'text' ? TEXT_VALUE_KINDS : [term]
}

/** The producer-declared VALUE kinds of an artifact's members (`numeric` / `categorical` /
 *  `string` — an open vocabulary this side does not police, INV-6). */
export function declaredValueKinds(structure: unknown): string[] {
  const out = new Set<string>()
  for (const m of members(structure)) if (typeof m.kind === 'string' && m.kind !== '') out.add(m.kind)
  return [...out]
}

/**
 * The option label for one candidate.
 *
 * A single-member artifact is labelled by its member NAME — that is the
 * only thing that distinguishes one metadata column on an axis from the next, and it is a
 * pure display label the reader is explicit about never joining on. Anything else falls
 * back to `datatype · dims`, the same floor the schema form's project-wide picker uses
 * (`extensions/widgets/form/fields/artifactLabel.ts`). The two formatters are deliberately
 * NOT shared: that one lives inside an extension, and this resolver is core.
 */
/**
 * A DECLARED string that tells this artifact apart from a same-labelled peer.
 *
 * ── Why this exists: a hash is the symptom of a name that was never used ──────────────
 *
 * `disambiguate` used to break every within-group tie with `id.slice(0, 8)`, and on the
 * shipped Visualize pane that fired for EVERY coordinate set a project holds: the producer
 * named each of them after its DATATYPE, so `meta.name` was one identical word across all of
 * them, they collided by construction, and the user read N rows of `<datatype> · 3f2a1b9c`.
 * The hash was doing its job — it is the only thing left once the names are identical — but
 * the names were identical because a declaration that DOES distinguish them was never read.
 *
 * The producer declares it. `meta.source_key` is the key the artifact was harvested under in
 * its source; `meta.method` is how it was computed. Both are the
 * PRODUCER's own words about which of several same-shaped outputs this one is, both are pure
 * display (never joined on, never dispatched on), and both are exactly what a person would
 * say if asked "which one is that?".
 *
 * These are declared keys, not domain knowledge: core learns that a producer MAY say where an
 * output came from, never what any particular value means (INV-6). The fourth key core reads
 * out of `meta`, alongside `name` / `categories` / `n_categories`.
 *
 * Returns `undefined` when the producer declared none — the caller then falls back to the
 * artifact's own identity, which is honest but opaque, and is now a genuine last resort
 * rather than the default.
 */
export function declaredQualifier(row: ArtifactRow): string | undefined {
  const meta = row.meta as { source_key?: unknown; method?: unknown } | undefined
  for (const v of [meta?.source_key, meta?.method]) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

/**
 * The option's SECOND line — what the artifact COVERS, from declarations alone.
 *
 * ── "Print what distinguishes, suppress what is constant" ─────────────────────────────
 *
 * The radio arm of `artifact_ref` renders a two-line option, and the second line used to be
 * the source DATASET on every row. In the pane's own case the candidates are scoped to one
 * anchored row space, so the dataset is a CONSTANT of the whole list: the row's most valuable
 * space was spent on the one string that could not tell any two options apart. What varies —
 * and what a reader is actually asking — is how many rows the artifact covers.
 *
 * INV-11: this resolves from DECLARATIONS only (`structure`'s member shape, or the table's
 * declared length). No column body is read to fill in a label; an undeclared shape yields
 * `undefined` and the line simply does not render, rather than being computed.
 */
export function candidateCoverage(
  row: ArtifactRow,
  anchor?: RowSpaceAnchor | null,
): string | undefined {
  // ── ITEM-10 EXTENDS THIS SLOT, IT DOES NOT ADD A SECOND ONE ───────────────────────────
  //
  // When the anchor states a population, *"describes N of M rows"* is what this line says,
  // and it REPLACES the artifact's own row count rather than joining it with a `·`. The two
  // are different quantities — the candidate's own length, and how much of the picture in
  // front of the reader it would colour — and only the second is the question being asked in
  // a list scoped to one coordinate set. The line lives in a ~300px pane (see below); saying
  // both would spend that width restating the part nobody asked for.
  //
  // No anchor, or an anchor whose coordinate declared no members, and this is byte-identical
  // to what it has always been.
  const describes = describedRowsLine(describedRows(row.structure, anchor))
  if (describes !== undefined) return describes
  const dims = declaredDimsForDisplay(row.id, row.structure)
  if (dims.length === 0) return undefined
  const rows = `${dims[0].toLocaleString()} rows`
  // A second declared dimension is the component count. Rendered compactly (`· 2D`) because
  // the line lives in a ~300px pane and the row count is the part that was asked for.
  return dims.length > 1 && dims[1] > 0 ? `${rows} · ${dims[1]}D` : rows
}

/**
 * Is this declared name just the artifact's own DATATYPE WORD — i.e. no name at all?
 *
 * A producer that has nothing better to say names its output after its kind, and then every
 * output of that kind carries one identical string. That is the state the owner reported: ten
 * coordinate sets, ten rows reading one datatype word, and the one thing a person wants from
 * the list — which of them is which — nowhere on the screen.
 *
 * The comparison is against the artifact's OWN `datatype` (and its last path segment, since a
 * lattice id is namespaced), normalised for case, spaces, hyphens and underscores. It reads no
 * vocabulary and knows no domain: it only asks whether the producer's "name" repeats the word
 * the catalog row already carries beside it.
 */
function isDatatypeWord(name: string, datatype: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '')
  const n = norm(name)
  if (n === '') return false
  const segment = datatype.split('/').pop() ?? datatype
  return n === norm(datatype) || n === norm(segment)
}

export function candidateLabel(row: ArtifactRow): string {
  // The PRODUCER'S OWN display name first (`meta.name`). A single-column store writes its
  // sole member under the constant path `values`, so the member-name branch below labelled
  // every metadata column on an axis "values" — a picker of six real, different columns
  // rendered as six identical strings. The name the producer actually chose is in `meta`,
  // and it is a label (never joined on, never dispatched on), which is exactly what an
  // option needs.
  //
  // ── …UNLESS THE "NAME" IS THE DATATYPE WORD (ledger #11/#17) ──────────────────────────
  //
  // Then it is not a name, and the producer's OTHER declarations are — `meta.source_key` (the
  // key this output was harvested under) and `meta.method` (how it was computed), which are
  // exactly what a person says when asked *"which one is that?"*. Reaching for them is
  // UNCONDITIONAL here, not a tie-break: a project holding ONE such artifact must read its own
  // declared key for the same reason a project holding a hundred must read a hundred different
  // ones, and a rule that fires only on a collision leaves the first case reading the word that
  // says nothing. Treating it as a tie-break is precisely the narrowing the ledger records.
  //
  // Declaring NEITHER key is the honest dead end, and it stays one: the label remains the
  // datatype word and {@link disambiguate} appends the artifact's own short identity where
  // that collides. Opaque, but true — nothing here invents a name out of a datatype.
  const declared = (row.meta as { name?: unknown } | undefined)?.name
  if (typeof declared === 'string' && declared.trim() !== '') {
    const name = declared.trim()
    if (!isDatatypeWord(name, row.datatype)) return name
    const qualifier = declaredQualifier(row)
    if (qualifier !== undefined) return qualifier
    return name
  }
  const named = members(row.structure).filter(m => typeof m.name === 'string' && m.name !== '')
  if (named.length === 1) return named[0].name as string
  const dims = declaredDimsForDisplay(row.id, row.structure)
  return dims.length > 0 ? `${row.datatype} · ${dims.join('×')}` : row.datatype
}

// ── the sibling-artifact resolver (ITEM-8) ──────────────────────────────────────────

/** The datatype constraints a source may declare, in one shape (both source forms carry
 *  them). Named separately from the contract types so the matcher has one parameter. */
export interface ArtifactTypeFilter {
  datatype?: string
  subtypes_of?: string
  capabilities?: string[]
  excludes?: string[]
  /** the declared COMPONENT COUNT an offered artifact must carry — see
   *  {@link CatalogArtifactSource.dims}. Fails closed: an undeclared shape does not match. */
  dims?: number
}

/**
 * How the datatype constraints are evaluated. The workbench threads its injected
 * `DatatypeLattice`; a bare unit context may omit it, and the degradation is deliberately
 * asymmetric:
 *
 *   · `datatype` / `subtypes_of` fall back to identity (a subtype no longer matches).
 *   · `excludes` and `capabilities` FAIL CLOSED — an exclusion that cannot be evaluated
 *     drops the candidate rather than keeping it.
 *
 * A permissive fallback for the two NEGATIVE constraints would silently offer exactly what
 * they exist to forbid, which is worse than offering nothing: an over-narrow picker is
 * visible to the user, an over-wide one produces a plausible wrong answer.
 */
export interface AxisResolveOptions {
  lattice?: DatatypeLattice
}

/** Does this row satisfy the source's datatype constraints? */
export function matchesTypeFilter(
  row: ArtifactRow,
  filter: ArtifactTypeFilter | undefined,
  opts?: AxisResolveOptions,
): boolean {
  if (!filter) return true
  const lattice = opts?.lattice
  const isA = (sub: string, sup: string): boolean => (lattice ? lattice.isA(sub, sup) : sub === sup)

  if (filter.subtypes_of != null && !isA(row.datatype, filter.subtypes_of)) return false
  if (filter.datatype != null && !isA(row.datatype, filter.datatype)) return false

  const excludes = filter.excludes ?? []
  if (excludes.length > 0) {
    if (!lattice) return false
    if (excludes.some(e => lattice.isA(row.datatype, e))) return false
  }
  const required = filter.capabilities ?? []
  if (required.length > 0) {
    const declared = lattice?.get(row.datatype)?.capabilities
    if (!declared) return false
    if (!required.every(c => declared.includes(c))) return false
  }
  if (filter.dims != null && declaredComponentCount(row) !== filter.dims) return false
  return true
}

/**
 * The COMPONENT COLUMNS a producer declared for this artifact (`meta.component_columns`) —
 * the NAMES of the 1-D sibling columns whose values ARE this artifact's components, one per
 * component, in component order. `undefined` when it declared none, or declared something
 * this reader refuses.
 *
 * ── WHY A SHAPE DECLARATION IS BEING READ OUT OF `meta` AT ALL ────────────────────────
 *
 * Because `structure` does not survive a narrowing. When a narrowed row set is materialised
 * server-side, each source artifact is GATHERED and the result gets a FRESHLY MINTED
 * `structure` (`src-app/server/src/modules/workstore/virtual_dataset.rs:1688-1705` →
 * `gathered_structure`, `:574-641`): one `values` column of `shape: [n_kept]`, `arrays: []`,
 * every time — while the source's `meta` is copied VERBATIM (`:1714`) and so is its
 * `datatype` (`:1729`). So an artifact that declared TWO components upstream arrives at this
 * function declaring ONE dimension and still carrying every capability its datatype
 * advertises. {@link declaredDimsForDisplay} reads `[n]`, {@link declaredComponentCount}
 * therefore answered `undefined`, and `matchesTypeFilter`'s `dims` narrowing dropped the row:
 * the § Coordinates pane rendered its `empty_text` and nothing anywhere said why. `meta` is
 * the ONLY channel a producer's own shape declaration can cross that boundary in, which is
 * the whole of why a shape fact is read from the display half of the row.
 *
 * ── FAIL CLOSED, AND NEVER THROW ─────────────────────────────────────────────────────
 *
 * `meta` is producer-written and the server never interprets it, so this key can hold
 * anything at all. It is accepted ONLY as a list of at least two non-empty, DISTINCT
 * strings: fewer than two names no pair to read, and a repeated name would resolve two
 * components to ONE column and draw a perfect diagonal — data-shaped, wrong, and with
 * nothing raised. Everything else answers `undefined`, exactly as an absent declaration
 * does, because both callers are LISTINGS over every artifact in a project and one
 * malformed row must not take the rest with it.
 *
 * The names come back VERBATIM. They are joined against ANOTHER producer declaration
 * (`meta.name`, the column's own declared name) by the render half, and normalising one
 * side of a join is how the two sides stop matching.
 *
 * Takes the `meta` half of the row rather than the whole row so the SAME acceptance rule is
 * available to both halves of this mechanism — the selection half here holds an
 * `ArtifactRow` (which satisfies the parameter), while the render half holds its own row
 * type. A declaration accepted by the picker and refused by the reader is precisely the
 * offered-but-unrenderable state ("it looks finished and the view is blank") that keying
 * both halves on one declaration exists to make unreachable.
 */
export function declaredComponentColumns(
  row: Pick<ArtifactRow, 'meta'>,
): readonly string[] | undefined {
  const meta = row.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const declared = (meta as { component_columns?: unknown }).component_columns
  if (!Array.isArray(declared) || declared.length < 2) return undefined
  const names: string[] = []
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.trim() === '') return undefined
    if (names.includes(entry)) return undefined
    names.push(entry)
  }
  return names
}

/**
 * How many COMPONENTS this artifact declares — its SECOND declared dimension, or `undefined`
 * when the producer declared no second one.
 *
 * `declaredDimsForDisplay` is the single reader of a producer's shape declaration everywhere
 * else in this pane (it is what `candidateCoverage` renders as `· 2D`), so the narrowing and
 * the line the reader sees cannot come to disagree about what a component count is.
 *
 * ── THE FALLBACK: THE ONE DECLARATION THAT SURVIVES A NARROWING ───────────────────────
 *
 * `structure` STILL WINS wherever it speaks. Only when it declares no second dimension at
 * all does the producer's own {@link declaredComponentColumns} answer instead — which is
 * exactly the state a gathered row is left in (`virtual_dataset.rs:1688-1705` mints
 * `columns: [{path: "values", shape: [n_kept]}]`, `arrays: []` for every non-sparse source,
 * and copies `meta` verbatim at `:1714`). So on everything shipped today the answer is
 * byte-identical: no producer in the tree declared component columns before this, and an
 * artifact whose structure states its width is not consulted about `meta` at all.
 *
 * TWO properties are deliberate, and both are about what is NOT widened:
 *
 *   · An artifact declaring FIFTY components and no component columns is STILL not offered
 *     to a `dims: 2` source. That refusal is `coordinates.yaml:18-26`'s argued divergence
 *     from the mockup — a 50-wide decomposition advertises `plottable-xy` just as truthfully
 *     as a 2-wide layout, and offering it means either asking which projection was meant or
 *     silently taking the first two — and this fallback does not touch it: no declaration,
 *     no answer, and the row is dropped exactly as before.
 *   · The fallback is keyed on the SAME declaration the render half resolves to actual
 *     columns (`extensions/data/workbenchDataSource.ts::catalog()`, which reads
 *     `meta.component_columns` and emits `CatalogEntry.components`). Offering and drawing
 *     therefore stand or fall together: there is no input that makes one of them true and
 *     the other false, so the artifact can never be selectable-but-blank.
 */
export function declaredComponentCount(row: ArtifactRow): number | undefined {
  const dims = declaredDimsForDisplay(row.id, row.structure)
  if (dims.length > 1) return dims[1]
  return declaredComponentColumns(row)?.length
}

/**
 * The sibling artifacts on `axis` of the dataset the artifact `ofId` belongs to.
 *
 * "Sibling" excludes the ANCHOR itself: the artifact a picker is scoped BY declares that
 * same axis too, and offering it as a choice invites picking the thing the question was
 * asked about. An anchor whose lineage resolves to NO source dataset yields
 * nothing — its "dataset" is not a set anyone can enumerate, and guessing project-wide
 * would silently widen the scope.
 *
 * "The dataset the artifact belongs to" is a SET, not one dataset: an anchor produced by
 * integrating two datasets belongs to both. So the scope test is an INTERSECTION
 * ({@link sharesSourceDataset}), not scalar equality on a single derived id. It used to be
 * the latter, and the server used to answer that id with whichever source the producing run
 * declared first — so an integrated anchor was silently scoped to HALF its lineage: every
 * sibling artifact and every metadata column belonging to the other source disappeared from
 * dependent pickers and from the criteria builder's frame, with nothing to show it. For a
 * single-source anchor and single-source candidates this is exactly the old comparison.
 */
export function siblingsOnAxis(artifacts: readonly ArtifactRow[], ofId: string, axis: string): ArtifactRow[] {
  const anchor = artifacts.find(a => a.id === ofId)
  if (!anchor) return []
  if (sourceDatasetIds(anchor).length === 0) return []
  return artifacts.filter(
    a => a.id !== ofId && sharesSourceDataset(anchor, a) && declaredAxes(a.structure).includes(axis),
  )
}

/**
 * Resolve an `artifact_ref` widget's `source` to its offered candidates.
 *
 * A CATALOG source matches project-wide by datatype; an AXIS-SCOPED source resolves `of`
 * against the render scope first and is EMPTY while that reference has no value. `values`
 * narrows to artifacts declaring that member kind — DEC-8's "every string-valued artifact
 * on the axis, unfiltered and unranked": the reference dataset carries at least five string
 * columns on one axis with nothing structural separating them, so narrowing further would
 * mean guessing by column NAME (a hardcoded spelling list) or by CONTENT (inference from
 * data), and both are what this round removes.
 *
 * A ROW-SPACE-SCOPED source resolves `aligned_to` against the scope and then applies the
 * OFFERING predicate (ITEM-17): A2 candidates are dropped, A3 candidates are offered and
 * MARKED, and with no anchor the answer is empty. The mark is set HERE rather than by the
 * control, because a control cannot observe alignment any more than it can observe
 * candidate availability — and because INV-10's refusal to auto-bind an A3 candidate reads
 * exactly this flag.
 *
 * The other two source forms are untouched, and `alignmentUnknown` stays `undefined` for
 * every candidate they produce: their candidates are dataset-scoped siblings with no anchor
 * to be aligned to, so the question was never asked. `undefined` is NOT A3 (DEC-16).
 */
export function resolveArtifactRefSource(
  artifacts: readonly ArtifactRow[],
  source: ArtifactRefSource | undefined,
  scope: Scope,
  opts?: AxisResolveOptions,
): ArtifactRefCandidate[] {
  if (!source) return []
  if (isRowSpaceScopedSource(source)) {
    // `anchorIds`, not `anchorId` (ITEM-8): `aligned_to` is in practice `"$scope.axis"`, and
    // that value is now EVERY axis the chosen coordinate rests on. `anchorId` refuses a list
    // naming two things — correctly, for the questions that need ONE axis — so using it here
    // would make an integrated coordinate offer nothing at all, and the offering predicate is
    // exactly the question that composes over several axes.
    const anchor = resolveRowSpaceAnchor(
      artifacts,
      anchorIds(source.aligned_to, scope),
      // ITEM-7 — the anchor's OWN membership, so a candidate about a different population of
      // the same dataset is A4 and is not offered here either.
      anchorCoordinate(scope),
    )
    const rows = offeredOnRowSpace(
      artifacts.filter(a => matchesTypeFilter(a, source, opts)),
      anchor,
    )
    return disambiguate(
      fuseCandidatesSameName(
        rows.map(r => ({
          row: r,
          id: r.id,
          label: candidateLabel(r),
          datatype: r.datatype,
          alignmentUnknown: alignmentState(r.structure, anchor) === 'A3',
        })),
      ),
      anchor,
    )
  }
  const rows = isAxisScopedSource(source)
    ? resolveAxisScoped(artifacts, source, scope, opts)
    : artifacts.filter(a => matchesTypeFilter(a, source, opts))
  return disambiguate(
    fuseCandidatesSameName(rows.map(r => ({ row: r, id: r.id, label: candidateLabel(r), datatype: r.datatype }))),
  )
}

/** One pre-disambiguation candidate: the artifact row plus the three facts fusion + labelling
 *  read. `alignmentUnknown` rides along from the row-space branch untouched. */
type RawCandidate = {
  row: ArtifactRow
  id: string
  label: string
  datatype: string
  alignmentUnknown?: boolean
}

/** A fused representative extends a raw candidate with the member set + the union datasets. */
type FusedCandidate = RawCandidate & {
  artifacts?: readonly string[]
  fusedDatasetIds?: readonly string[]
  fusedDatasetNames?: readonly string[]
}

/**
 * Same-name fusion for artifact-ref OFFERS (ITEM-35, DEC-D) — the picker twin of `fuseSameName`
 * in `rowSpaceColumns.ts`, sharing its exact reconciliation primitives (`vocabDeclarationOf` +
 * `reconcileVocabularies`).
 *
 * Two datasets carrying a SAME-NAMED artifact (a `celltype` column in each) are ONE offer, not
 * two — but ONLY WHEN their category vocabularies reconcile, the same guard the row-space path
 * applies. A group that does not reconcile is left as SEPARATE offers: §7 Q1 names this as the
 * one place the model could quietly mislead, so an unreconcilable pair stays two honest picks
 * rather than a merge asserting a shared meaning that is not there.
 *
 * The merged offer keeps the DETERMINISTIC primary (lowest artifact id — a picker key and a
 * stored-choice target, so two catalog reads in different orders must answer the same id) as its
 * `id`/stored value, and carries the whole member set on `artifacts`, primary first. The stored
 * VALUE never becomes the set (INV-4); the set travels beside it via the store sidecar.
 *
 * Runs BEFORE {@link disambiguate}: disambiguation makes same-name labels distinct, so a group
 * has to be collapsed while its members still share the label fusion groups on.
 */
function fuseCandidatesSameName(cands: RawCandidate[]): FusedCandidate[] {
  const groups = new Map<string, RawCandidate[]>()
  for (const c of cands) {
    const g = groups.get(c.label) ?? []
    g.push(c)
    groups.set(c.label, g)
  }
  const out: FusedCandidate[] = []
  for (const group of groups.values()) {
    // Spans ≥2 datasets? Fusion's whole precondition — a same-name pair WITHIN one dataset is a
    // real ambiguity `disambiguate` tells apart, never a fusion.
    const datasets = [...new Set(group.map(c => c.row.source_dataset_id).filter((d): d is string => !!d))]
    if (group.length < 2 || datasets.length < 2) {
      out.push(...group)
      continue
    }
    const decls = group.map(c => vocabDeclarationOf(c.row))
    let reconciled = true
    for (let i = 0; reconciled && i < decls.length; i++) {
      for (let j = i + 1; reconciled && j < decls.length; j++) {
        reconciled = reconcileVocabularies(decls[i], decls[j]).verdict === 'reconciled'
      }
    }
    if (!reconciled) {
      out.push(...group)
      continue
    }
    const ordered = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const primary = ordered[0]
    out.push({
      ...primary,
      artifacts: ordered.map(c => c.id),
      fusedDatasetIds: [...new Set(ordered.flatMap(c => sourceDatasetIds(c.row) ?? []))].sort(),
      fusedDatasetNames: [...new Set(ordered.flatMap(c => sourceDatasetNames(c.row) ?? []))],
    })
  }
  return out
}

/**
 * Make every offered label DISTINCT within one control.
 *
 * `candidateLabel` describes an artifact by itself, and two artifacts can legitimately
 * describe identically — the same file imported into two datasets produces two rows with
 * the same datatype and the same dims, and every single-column store declares its sole
 * member under the same constant name. The picker then offers N options a human cannot
 * tell apart, which is not a smaller version of a working picker: a choice between
 * indistinguishable options is not a choice, and picking the wrong one silently anchors
 * the whole run — including the axis every dependent control resolves its options from —
 * to the wrong dataset.
 *
 * The tie-breaker is the SOURCE DATASET, which is what that field was added for ("the
 * picker groups/labels candidates by which dataset each came from, so a user with several
 * datasets attached to a project can tell the inputs apart"). It is appended ONLY to the
 * labels that actually collide, so the common case — distinct labels — is untouched. With
 * no source dataset to name (or two candidates from the SAME one), a short id suffix is
 * the last resort: ugly, but honest, and still selectable.
 */
function disambiguate(
  cands: Array<{
    row: ArtifactRow
    id: string
    label: string
    datatype: string
    alignmentUnknown?: boolean
    /** ITEM-35 (DEC-D) — set on a FUSED representative (see {@link fuseCandidatesSameName}):
     *  the whole member set, primary first. Carried straight through to the output candidate. */
    artifacts?: readonly string[]
    /** The UNION source datasets of a fused group — a fused offer spans several, so its display
     *  must not file it under the primary's dataset alone. `undefined` on an unfused candidate,
     *  which then falls back to the row's own source datasets exactly as before. */
    fusedDatasetIds?: readonly string[]
    fusedDatasetNames?: readonly string[]
  }>,
  /** the anchor these candidates were offered against, when there was one — so the option's
   *  second line can be the ANCHOR-RELATIVE fact (ITEM-10) rather than the artifact's own row
   *  count. Absent for every source form that asks no alignment question, which is what keeps
   *  those forms byte-identical. */
  anchor?: RowSpaceAnchor | null,
): ArtifactRefCandidate[] {
  // Ties are resolved WITHIN a dataset, because the dataset is now carried structurally and the
  // picker groups on it — two artifacts that describe identically but come from different
  // datasets are already told apart by the group they sit under.
  //
  // This used to append the dataset name to the LABEL, and only when two labels collided. Two
  // things were wrong with that. It said nothing in the common case, so a user could not see
  // which dataset an option belonged to unless the system happened to notice a collision. And
  // the suffix went on the END, where tail-truncation eats it first: `counts · Patient-A-…` and
  // `counts · Patient-A-…` clip identically, so the one substring that distinguished them was
  // the first thing removed.
  // Keyed on the SET of source datasets, not a member of it: an artifact integrating A and B
  // sits in neither A's nor B's bucket, so its labels are made unique against its own peers.
  const key = (c: { row: ArtifactRow }): string => sourceDatasetGroupKey(c.row)
  const byLabelInGroup = new Map<string, number>()
  for (const c of cands) {
    const k = `${key(c)}\u0000${c.label}`
    byLabelInGroup.set(k, (byLabelInGroup.get(k) ?? 0) + 1)
  }
  // Uniqueness is enforced PER GROUP, not globally: two artifacts that read alike in DIFFERENT
  // datasets are already told apart by the heading above them, and suffixing them anyway would
  // reintroduce the truncatable tail this change exists to remove.
  const usedInGroup = new Map<string, Set<string>>()
  // Is EVERY candidate in this offer contesting the SAME label? Then the shared word is a
  // constant of the whole list rather than a separator within it (see the branch below).
  const sameLabelThroughout =
    cands.length > 1 && cands.every(c => c.label === cands[0].label)
  return cands.map(c => {
    let label = c.label
    // A genuine within-group tie (two artifacts of ONE dataset sharing a member name) still
    // needs a tie-breaker, and there is nothing left to name but the artifact itself: ugly,
    // honest, and still selectable.
    // CONTESTED — two candidates in this offer describe identically. Recorded on the candidate
    // as well as fixed in the label, because INV-10 refuses to auto-bind one FOR the user: a
    // choice between options a human could not have told apart is not a choice, and being the
    // only one left does not make it consent.
    const contested = (byLabelInGroup.get(`${key(c)}\u0000${c.label}`) ?? 0) > 1
    if (contested) {
      // A DECLARED distinguisher first (see `declaredQualifier`). The short id is the last
      // resort it was always meant to be — for an artifact whose producer declared nothing
      // that tells it apart — rather than the answer for every same-named peer, which is
      // what it had become the moment a producer named its outputs after their datatype.
      const declared = declaredQualifier(c.row)
      // And when the contested name is shared by EVERY option in the group, it is a constant
      // of the list: `<datatype> · K_alpha` / `<datatype> · K_beta` still spends the start of
      // every line — where the eye lands — on the one word that distinguishes nothing, which
      // is the same defect as printing one dataset under every option. The declared name then
      // stands alone. If only SOME options collide the shared word still separates them from
      // the rest of the list, so it is kept.
      label = declared
        ? sameLabelThroughout && byLabelInGroup.size === 1
          ? declared
          : `${label} · ${declared}`
        : `${label} · ${c.id.slice(0, 8)}`
    }
    let used = usedInGroup.get(key(c))
    if (!used) {
      used = new Set<string>()
      usedInGroup.set(key(c), used)
    }
    if (used.has(label)) label = `${label} · ${c.id.slice(0, 8)}`
    used.add(label)
    // A FUSED representative spans several datasets, so its display set is the UNION the fusion
    // computed, not the primary row's own; and `datasetId`/`datasetName` (the exactly-ONE
    // fields) collapse to undefined, the same rule a natively multi-source artifact follows.
    const fused = c.artifacts && c.artifacts.length > 0
    const datasetIds = fused ? (c.fusedDatasetIds ?? []) : sourceDatasetIds(c.row)
    const datasetNames = fused ? (c.fusedDatasetNames ?? []) : sourceDatasetNames(c.row)
    return {
      id: c.id,
      label,
      datatype: c.datatype,
      datasetIds,
      datasetNames,
      datasetId: fused ? undefined : (c.row.source_dataset_id ?? undefined),
      datasetName: fused ? undefined : (c.row.source_dataset_name ?? undefined),
      ...(fused ? { artifacts: c.artifacts } : {}),
      ambiguous: contested,
      // WHAT VARIES between two options of one row space (see `candidateCoverage`). Declared
      // only — `undefined` where the producer declared no shape, so the line is absent rather
      // than invented.
      coverage: candidateCoverage(c.row, anchor),
      // Carried through UNCHANGED, including its absence: a candidate produced by a source
      // that asks no alignment question keeps `undefined`, which is not `false` and is not
      // A3 (DEC-16).
      alignmentUnknown: c.alignmentUnknown,
    }
  })
}

function resolveAxisScoped(
  artifacts: readonly ArtifactRow[],
  source: AxisScopedArtifactSource,
  scope: Scope,
  opts?: AxisResolveOptions,
): ArtifactRow[] {
  const ofId = anchorId(source.of, scope)
  if (!ofId) return []
  return siblingsOnAxis(artifacts, ofId, source.axis)
    .filter(a => matchesTypeFilter(a, source, opts))
    .filter(a => {
      if (!source.values) return true
      const admitted = valueKindsFor(source.values)
      return declaredValueKinds(a.structure).some(k => admitted.includes(k))
    })
}

/**
 * The artifact id an `of` reference points at — the SOLE one, or nothing.
 *
 * `of` may bind a MULTI-valued control (a matrix picker is `multiple`). This used to take
 * `v[0]` and justify it in prose: *"the selections all sit on the same dataset by
 * construction, so any of them names the same axis."* Nothing checked that, nothing could
 * enforce it, and the sibling {@link anchorIds} exists precisely because it is false for some
 * callers — an axis instance is identified by the anchor's own `source_dataset_id` plus the
 * axis name ({@link siblingsOnAxis}), so two anchors from two datasets name two DIFFERENT
 * axes and answering with the first one's is a different question, silently (INV-1).
 *
 * What CAN be decided from this scope is only what `of` itself resolved to: this function is
 * handed an expression and a scope and never sees the catalog, so "are these anchors on one
 * dataset?" is not a question askable here. So the check is the one that IS available and IS
 * sufficient — a multi-selection is provably consistent when every element resolves to the
 * SAME id, which is the case a `multiple` control in fact produces when it names one thing.
 * Anything else (two distinct ids, an empty selection, a non-string) resolves to `undefined`,
 * which the callers already handle: it makes the source EMPTY rather than answering about an
 * axis nobody chose.
 *
 * A caller that genuinely means the plural — "every axis this run writes to" — asks
 * {@link anchorIds} and gets the whole list; that is the seam for it, not a widened `[0]`.
 */
export function anchorId(of: string | undefined, scope: Scope): string | undefined {
  if (!of) return undefined
  const v = evalExpr(of, scope)
  const list = Array.isArray(v) ? v : [v]
  // ONE distinct value, whatever the arity: `'a'`, `['a']` and `['a','a']` all name one
  // anchor; `['a','b']` names two and therefore identifies neither.
  if (new Set(list).size !== 1) return undefined
  const only = list[0]
  return typeof only === 'string' && only !== '' ? only : undefined
}

/**
 * EVERY anchor `of` resolves to, in order — the whole list where {@link anchorId} answers
 * only when the list names ONE thing.
 *
 * An axis-scoped question is asked of ONE axis instance, and an instance is identified by
 * the anchor's own `source_dataset_id` plus the axis name ({@link siblingsOnAxis}). So a
 * control bound to a LIST of anchors is asking about SEVERAL instances, and answering with
 * the first one's is not an approximation — it is a different question, silently. The one
 * caller that needs the plural form is a slice asking WHICH COLUMN NAMES ARE ALREADY TAKEN
 * on the axes a run will write to: a run over two datasets writes to two axes, and a name
 * free on the first and taken on the second is taken.
 */
/**
 * The `$`-ref naming the CHOSEN COORDINATE artifact, spelled ONCE (ITEM-7 / ITEM-9).
 *
 * `coordinate` is one of the two values `PANE_SCOPE_KEYS` holds, and the anchor's own
 * membership is read off the artifact it names — so a resolver that has a `Scope` and no
 * declared `coordinate:` arg can still make the join without a third pane-scope value being
 * invented for it (DEC-10 keeps that set closed). Reading it through {@link anchorId} means it
 * is EVALUATED like every other ref rather than reached for inside the scope object, and the
 * key name appears exactly here.
 */
export const COORDINATE_SCOPE_REF = '$scope.coordinate'

/** The chosen coordinate artifact's id, from the pane scope. `undefined` when nothing is
 *  chosen — which leaves every anchor membership `undefined` and every intersection
 *  undecidable, i.e. exactly the behaviour that predates the membership rule. */
export function anchorCoordinate(scope: Scope): string | undefined {
  return anchorId(COORDINATE_SCOPE_REF, scope)
}

export function anchorIds(of: string | undefined, scope: Scope): string[] {
  if (!of) return []
  const v = evalExpr(of, scope)
  const list = Array.isArray(v) ? v : [v]
  return list.filter((x): x is string => typeof x === 'string' && x !== '')
}

// ── the axis-columns data source (ITEM-11) ──────────────────────────────────────────

/** The `data` slices of a spec that use the axis-columns source, keyed by slice name. */
export function axisColumnSlices(spec: ViewSpec): Array<[string, DataSourceSpec]> {
  return Object.entries(spec.data ?? {}).filter(
    ([, decl]) => decl != null && decl.source === AXIS_COLUMNS_SOURCE,
  ) as Array<[string, DataSourceSpec]>
}

/**
 * A digest of what every axis-columns slice is currently anchored to — the re-resolve
 * trigger for the view-data resolver.
 *
 * The catalog epoch alone cannot serve: picking a different dataset changes what these
 * slices resolve to with the catalog byte-identical. The store's `revision` cannot serve
 * either — it bumps on every slider tick, and using it would turn a drag into a refetch
 * storm. Only the resolved anchors are digested, so the key is stable across all the state
 * traffic that does not change the answer. A spec with no axis source digests to `''`,
 * leaving the epoch-only behaviour exactly as it was.
 */
/**
 * The DISTINCT column names a criteria list refers to (ITEM-34) — sorted, de-duplicated, blanks
 * dropped. The one place `values_for` is interpreted, so the slice resolver and the re-resolve
 * digest cannot disagree about which bodies are wanted.
 *
 * Sorted so re-ORDERING criteria does not refetch (the wanted SET is what matters), and
 * de-duplicated so two criteria on one column are one body.
 */
export function criterionColumnNames(binding: string | undefined, scope: Scope): string[] {
  if (typeof binding !== 'string' || binding === '') return []
  const raw = evalExpr(binding, scope)
  if (!Array.isArray(raw)) return []
  const out = new Set<string>()
  for (const c of raw) {
    if (c == null || typeof c !== 'object') continue
    // THE SAME FUNCTION the kernel uses, not the same-sounding one.
    //
    // This used to call JS `String.prototype.trim()` while claiming to apply "the same
    // normalisation `keep_mask`'s `criterionColumn` applies". `criterionColumn` deliberately does
    // NOT use the native trim: it strips the SIX ASCII whitespace characters, because JS `trim()`
    // also eats U+FEFF while python's `str.strip()` and Rust's `str::trim()` do not (and python
    // eats U+001C–U+001F, which neither other reader does). Its docstring says so at length.
    //
    // The divergence is not theoretical: an Excel-written CSV header column (`"\ufeff"` prefixing
    // the name) was normalised HERE to the bare name, so the resolver fetched a column the kernel —
    // looking up the BOM-bearing spelling — never finds. Same terminal symptom as asking the gate
    // the wrong vocabulary: nothing fetched, all-false mask, permanent spinner.
    const name = criterionColumn(c as { column?: unknown })
    if (name !== '') out.add(name)
  }
  return [...out].sort()
}

export function axisSourceRequestKey(spec: ViewSpec, state: Record<string, unknown> | undefined): string {
  const slices = axisColumnSlices(spec)
  if (slices.length === 0) return ''
  const scope: Scope = { state: state ?? {} }
  const parts = slices.map(([key, decl]) => {
    const args = (decl.args ?? {}) as { of?: string; axis?: string; values_for?: string }
    // EVERY anchor, not the first: a slice covering several axis instances re-resolves when
    // any of them changes, and digesting only the first would freeze its answer the moment
    // the user edited the rest of the list.
    //
    // ITEM-34 — plus the CRITERION-NAMED COLUMNS, because under lazy bodies they decide what the
    // slice fetches. Without them the digest is unchanged when a user points a criterion at a new
    // column, the slice never re-resolves, that column's body never arrives, and the criterion
    // sits pending forever — a mask stuck all-false with nothing to explain it.
    //
    // It digests the NAMES only, sorted and de-duplicated, never the criteria themselves: a
    // bound edit or a keep-set tick must NOT refetch, and dragging a slider would otherwise
    // become the refetch storm this key was written to avoid.
    return `${key}=${anchorIds(args.of, scope).join('+')}@${args.axis ?? ''}#${criterionColumnNames(
      args.values_for,
      scope,
    ).join('+')}`
  })
  return `|axis:${parts.join(',')}`
}

/**
 * A columnar frame — the `{ column: values }` shape a view's `derived` primitives read.
 * Identical to what the `job.result` resolver lands, so a view can swap sources without
 * touching its `derived` block.
 *
 * ITEM-21 — a column is a {@link DecodedColumn}: boxed, or the decoder's own `TypedArray` for a
 * numeric member. The type is a UNION rather than `unknown[]` so a consumer cannot index it as a
 * plain array without saying so; narrow with `isColumn`, never `Array.isArray`.
 *
 * Which of the two arrives is decided by the READER a caller injects, not by this type: the
 * `column_values` slice injects `readColumnarTableChecked` and therefore sees typed numeric
 * columns, while `axis_columns` injects the row-major `columnarFromTable` and therefore sees
 * boxed ones. Widening here does not convert the latter — it only stops the type from CLAIMING
 * that no frame is ever typed, which is the claim that let a typed column reach an `Array.isArray`
 * guard with the compiler's blessing.
 */
export type ColumnarFrame = Record<string, DecodedColumn>

/** Read one artifact into a columnar frame. Injected so this module does no IO. */
export type ReadArtifactFrame = (
  row: ArtifactRow,
  /** Optional PROGRESSIVE consumer (incremental-landing ITEM-7): called with each accumulated
   *  prefix (`done: false`) as the artifact's stream arrives, then the complete frame
   *  (`done: true`). Omitting it reads the whole frame in one step, as before. */
  onChunk?: (frame: ColumnarFrame, done: boolean) => void,
) => Promise<ColumnarFrame>

/**
 * How an axis-columns caller NARROWS the shared row selection. ONE options type for the
 * selection and both answers built on it ({@link axisColumnSources} /
 * {@link readAxisColumnsFrame}), so a narrowing cannot reach one answer and miss the other —
 * which is the same reason the selection itself is one named function.
 */
export interface AxisColumnRowOptions extends AxisResolveOptions {
  /** datatype constraints, evaluated by {@link matchesTypeFilter}. */
  filter?: ArtifactTypeFilter
  /** Drop the columns these ANALYSES produced (`ArtifactRow.generator_id`) — the row-level
   *  half of `produced_by: others`. Empty / absent narrows nothing. */
  excludeGenerators?: readonly string[]
}

/**
 * The artifacts that are COLUMN SOURCES on `axis` of the dataset `of` anchors — the ONE row
 * selection both axis-columns answers are built from.
 *
 * It is a named function rather than two similar filter chains because the VALUES answer
 * (`readAxisColumnsFrame`) and the IDS answer (`axisColumnSources`) must describe the same
 * set or a view can offer a column whose artifact the launch cannot name — the criterion the
 * user builds and the run cannot mount. One selection, so they cannot disagree.
 *
 * Only artifacts that DECLARE 1-D columns are column sources. An expression matrix sits on
 * the same axis and would otherwise be handed to a table reader that throws on it — a
 * caught, logged failure per matrix per resolve, for an artifact that was never a candidate.
 * Selecting on the producer's own declaration keeps this free of a hardcoded
 * `metadata-column` datatype literal (INV-6); the SERVER makes the same cut by capability
 * (`metadata-column-family`) rather than by id, for the same reason.
 *
 * `excludeGenerators` drops the columns a NAMED SET OF ANALYSES produced — the row-level
 * half of `produced_by: others`. It is applied HERE, on the one shared selection, and not
 * afterwards on either answer, because the collision rule below is computed OVER the
 * selection: minting first and removing keys second would leave a name carried by two of
 * the EXCLUDED columns behind as a contested bare key, i.e. the excluded producer would go
 * on blocking under a key that no longer denotes anything.
 */
export function axisColumnRows(
  artifacts: readonly ArtifactRow[],
  ofId: string | undefined,
  axis: string | undefined,
  opts?: AxisColumnRowOptions,
): ArtifactRow[] {
  if (!ofId || !axis) return []
  const excluded = opts?.excludeGenerators
  return siblingsOnAxis(artifacts, ofId, axis)
    .filter(a => matchesTypeFilter(a, opts?.filter, opts))
    .filter(a => tableColumns(a.structure).length > 0)
    .filter(a => !isProducedBy(a, excluded))
}

/**
 * Was this row produced by one of `generators`?
 *
 * ONLY a row that NAMES its producer can answer yes. A row with no `generator_id` — an
 * import, or a run whose provenance was never recorded — is not attributable, and reading
 * "I do not know who made this" as "I made this" would hand the exclusion to every column
 * on the axis and quietly end whatever constraint the caller was applying. So absence is
 * NOT membership, in either direction: an unattributed column is kept.
 */
function isProducedBy(row: ArtifactRow, generators: readonly string[] | undefined): boolean {
  if (!generators || generators.length === 0) return false
  const producer = row.generator_id
  return typeof producer === 'string' && producer !== '' && generators.includes(producer)
}

/**
 * The name a metadata column carries in a FRAME — the producer's name, not the container's.
 *
 * A single-column store writes its sole member under the CONSTANT path `values`
 * (`_lib/txr_columns.py`: `t.categorical("values", …)` / `t.string(…)` / `t.numeric(…)`),
 * and records the column's real name in `meta.name`. So on a real import EVERY column on an
 * axis declares the same member name, and any map keyed on it collapses to ONE entry — the
 * frame becomes a single column called `values`, the `as: sources` map becomes
 * `{values: <whichever row was read last>}`, and a view offering "a criterion on any
 * column" offers one meaningless one.
 *
 * `candidateLabel` already fixed this FOR THE PICKER LABEL and the fix stopped there: the
 * frame key and the sources map kept reading `member.name`. That is the recurring shape in
 * this repo — a rule corrected in one place and left stale in the others — so the rule now
 * lives HERE and all three callers share it.
 *
 * Multi-member table artifacts are untouched: their members carry real, distinct names and
 * one `meta.name` describes the whole artifact, so preferring `meta.name` per member would
 * collapse THEM. The producer's name wins only where the container has exactly one member
 * to be the column — the same `named.length === 1` condition `candidateLabel` uses.
 */
export function columnNameForMember(
  row: ArtifactRow,
  member: { name?: unknown },
  memberCount: number,
): string | undefined {
  if (memberCount === 1) {
    const declared = (row.meta as { name?: unknown } | undefined)?.name
    if (typeof declared === 'string' && declared.trim() !== '') return declared.trim()
  }
  return typeof member.name === 'string' && member.name !== '' ? member.name : undefined
}

// ── the collision rule: a contested name is ADDRESSED, never decided ─────────────────
//
// An axis can carry two artifacts declaring the SAME column name, and that is not a fault:
// the artifact natural key is `(project, dataset, run, output)` — the NAME is not in it — so
// re-running an analysis legitimately lands a second `<name>` beside the first. A live
// project measured THREE.
//
// Both readers below used to key on the raw name and let the last row win. That was
// defensible while EVERY column arrived under the constant member path `values`: a collision
// was then the norm and the merge was damage control. Once `columnNameForMember` gave each
// column its producer's real name, a collision became a REAL event and last-write-wins
// became SILENT DATA SUBSTITUTION — one of the three reached the criteria builder and the
// canvas, the other two vanished, and WHICH one survived was decided by the order the
// catalog happened to return rows in. A criterion the user built kept its spelling and
// quietly changed meaning the next time the analysis ran.
//
// The rule now: a name declared by exactly ONE column is that column's key, unchanged (the
// overwhelmingly common case is byte-identical). A name declared by SEVERAL is not a key at
// all — each of the contending columns is addressed by `<name> · <artifact>` instead, so all
// of them survive, each keeps its own values, and none of them answers to the ambiguous
// spelling. Nothing about the answer depends on arrival order.
//
// It surfaces itself with no renderer change, which is why this shape was chosen over
// refusing the merge (which would blank a builder over one contested column) or a documented
// precedence (whose winner would still be unidentifiable on screen): the criteria picker
// mints one option per frame key and LABELS it by that key (`columns_of`), so the user reads
// `label_a · 3f2a1b9c` and `label_a · c19b8e02` where they used to read one `label_a`.

/** How much of an artifact id distinguishes one column from another of the same name — the
 *  same 8 the artifact picker's own tie-breaker uses (`disambiguate`) and the same the
 *  catalog's categorical channel labels with. */
const SHORT_ID_CHARS = 8

/** What separates a column's NAME from the thing that distinguishes it. Matches the
 *  repo-wide ` · ` discriminator so a qualified column reads like every other qualified
 *  label in the app (the artifact picker's tie-breaker, the catalog's categorical labels). */
const COLUMN_KEY_SEPARATOR = ' · '

/** One column on an axis, as addressed once the WHOLE axis has been read. */
export interface AxisColumnKey {
  /** the artifact the column lives in. */
  artifactId: string
  /** the producer's own name for the column — the thing that can collide. */
  name: string
  /** the unique key it is addressed by: `name`, or a qualified form when `name` is
   *  contested. Distinct for every column in the input, always. */
  key: string
  /**
   * Whether the NAME is genuinely contested — carried by MORE THAN ONE ARTIFACT on this axis,
   * so the bare name identifies no single column.
   *
   * ITEM-29d: this used to be returned as `key !== c.name`, recomputed from the final key rather
   * than reported from the collision the minter actually measured. Those are two different
   * propositions and the second is strictly wider: the residual-ordinal path below (two members
   * of ONE artifact declaring one name) also produces `key !== name`, so it reported
   * `ambiguous: true` for a name that names exactly one artifact and is not contested at all.
   *
   * The separation matters because INV-10 keys `auto_bind_sole_candidate`'s REFUSAL on this
   * flag — *"a marked or contested candidate is never chosen FOR the user"*. Under the old
   * spelling that refusal would have fired on a malformed-but-unambiguous artifact and not
   * fired for the reason it was written. `qualified` below carries the other proposition, so
   * nothing that wanted "did the key have to change?" loses it.
   */
  ambiguous: boolean
  /** Whether `key` had to differ from `name` — for ANY reason, including the residual ordinal.
   *  This is the display question ("is the user reading a qualified label?"); `ambiguous` is
   *  the identity question ("does this name denote more than one artifact?"). */
  qualified: boolean
}

/** Collisions already reported, so a resolver that re-runs on every keystroke says it once. */
const warnedCollisions = new Set<string>()

/**
 * Mint a UNIQUE key for every `(artifact, column name)` pair — the ONE rule both axis-columns
 * answers resolve collisions with, so the frame and the id map cannot disagree about which
 * column a key denotes.
 *
 * ORDER-INDEPENDENT: a key is a function of the name, of how many columns carry it, and of the
 * owning artifact's id — never of where the column sat in the input. The one exception is a
 * single artifact declaring one name TWICE (malformed, and unreachable from a read frame,
 * which cannot hold two identical keys): the id cannot separate those, so an ordinal does, in
 * that artifact's own declaration order.
 *
 * EXPORTED because the rule itself is the contract, not any one caller's use of it: the frame,
 * the id map and (ITEM-17/ITEM-20) the pane's column offering all have to agree about which
 * names are contested, and a rule that can only be observed through one caller's derived output
 * is a rule nothing can pin. ITEM-29d's separation of `ambiguous` from `qualified` is
 * unobservable through `axisColumnSourcesFor` alone — both spellings produce the identical map —
 * so it would have been untestable as an internal.
 */
export function mintColumnKeys(cols: ReadonlyArray<{ artifactId: string; name: string }>): AxisColumnKey[] {
  const carriers = new Map<string, Set<string>>()
  for (const c of cols) {
    let ids = carriers.get(c.name)
    if (!ids) {
      ids = new Set<string>()
      carriers.set(c.name, ids)
    }
    ids.add(c.artifactId)
  }
  const occurrences = new Map<string, number>()
  for (const c of cols) occurrences.set(c.name, (occurrences.get(c.name) ?? 0) + 1)
  const used = new Set<string>()
  return cols.map(c => {
    // Whether the key must be QUALIFIED — a name that OCCURS more than once cannot be minted
    // bare, whoever carries it. Deliberately still counted on occurrences (not carriers), so
    // the minted keys are byte-identical to before: ITEM-29d separates what is REPORTED, and
    // changing what is minted would move column keys the frame, the option labels and
    // `require.not_in` all read.
    const needsQualifier = (occurrences.get(c.name) ?? 0) > 1
    // Whether the name is genuinely CONTESTED — carried by more than one ARTIFACT, which is
    // the proposition INV-10 refuses to auto-bind on and the one `warnCollision` already
    // reports ("declared by N artifacts"). One artifact declaring a name twice occupies the
    // name completely; it does not contest it with anyone.
    const contested = (carriers.get(c.name)?.size ?? 0) > 1
    let key = needsQualifier
      ? `${c.name}${COLUMN_KEY_SEPARATOR}${c.artifactId.slice(0, SHORT_ID_CHARS)}`
      : c.name
    // Last resort — two members of ONE artifact under one name, or a qualified key that
    // happens to spell an unqualified one. Uniqueness is the invariant; nothing may share.
    if (used.has(key)) {
      let n = 2
      while (used.has(`${key}${COLUMN_KEY_SEPARATOR}${n}`)) n += 1
      key = `${key}${COLUMN_KEY_SEPARATOR}${n}`
    }
    used.add(key)
    if (contested) warnCollision(c.name, carriers.get(c.name))
    return { artifactId: c.artifactId, name: c.name, key, ambiguous: contested, qualified: key !== c.name }
  })
}

function warnCollision(name: string, ids: Set<string> | undefined): void {
  const signature = `${name} ${[...(ids ?? [])].sort().join(',')}`
  if (warnedCollisions.has(signature)) return
  warnedCollisions.add(signature)
  console.warn(
    `[declarative] axis_columns: "${name}" is declared by ${ids?.size ?? 0} artifacts on this ` +
      `axis (${[...(ids ?? [])].join(', ')}). Each is offered under its own qualified name; the ` +
      'bare one binds nothing.',
  )
}

/** Test-only reset of the once-per-collision warning memo. */
export function __resetColumnCollisionWarningsForTests(): void {
  warnedCollisions.clear()
}

/** The columns a row DECLARES, as `(artifact, member path, column name)` triples. A member
 *  with no derivable name is skipped — it names no column in the frame either. */
function declaredColumnsOf(
  row: ArtifactRow,
): Array<{ artifactId: string; member: string; name: string; kind?: string; dtype?: string; n?: number }> {
  const cols = tableColumns(row.structure)
  const out: Array<{ artifactId: string; member: string; name: string; kind?: string; dtype?: string; n?: number }> = []
  const rowN = (row.structure as { n?: unknown } | undefined)?.n
  for (const member of cols) {
    const name = columnNameForMember(row, member, cols.length)
    if (name === undefined) continue
    const m = member as { name?: unknown; kind?: unknown; dtype?: unknown; shape?: unknown; n?: unknown }
    // ITEM-34 — the DECLARED row count, from the member's own `shape[0]`/`n` or the table's `n`.
    // Free (it is already in `structure`) and it is what keeps `columnLength` answerable when no
    // body has been fetched. Never inferred from values: this is the producer's fact.
    const shape0 = Array.isArray(m.shape) ? (m.shape as unknown[])[0] : undefined
    const declaredN = [m.n, shape0, rowN].find(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)
    out.push({
      artifactId: row.id,
      member: typeof m.name === 'string' ? m.name : '',
      name,
      ...(typeof declaredN === 'number' ? { n: declaredN } : {}),
      // ITEM-43 — the producer's declared kind + stored dtype, carried through so the kernels
      // stop classifying a column by peeking at its first value. Free: both are already in the
      // `structure` the row carries, so this costs no read.
      ...(typeof m.kind === 'string' ? { kind: m.kind } : {}),
      ...(typeof m.dtype === 'string' ? { dtype: m.dtype } : {}),
    })
  }
  return out
}

/** Drop repeats, keeping first appearance. A row reached through two anchors is ONE column
 *  source; counting it twice would make its own names look contested with themselves. */
function dedupeRows(rows: readonly ArtifactRow[]): ArtifactRow[] {
  const seen = new Set<string>()
  const out: ArtifactRow[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

/**
 * `{ columnKey → artifactId }` for a row selection — the reverse of the frame, and the only
 * thing that lets a view bind a slot whose NAME is data (`column:<name>` → the artifact that
 * column lives in). Read off the producers' DECLARED members, so it costs no artifact fetch.
 *
 * Takes ROWS rather than an anchor so a caller covering SEVERAL axis instances can mint over
 * the combined selection instead of merging two independently-minted maps — which is
 * `Object.assign`, i.e. the same last-write-wins one anchor further out.
 *
 * Every declared NAME is additionally present as a key. `require.not_in` reads this map's
 * KEYS to answer "is this column name already taken on the axis this run writes to", and two
 * artifacts carrying a name is the case where it is MOST taken — dropping the bare key would
 * turn the strongest collision into the one that guard misses. A CONTESTED name maps to the
 * EMPTY STRING: it names several columns in several artifacts, so it names no single artifact,
 * and answering with one of them is the substitution this rule exists to remove. A binding that
 * reaches for it gets nothing, which the launch interpreter already refuses loudly.
 *
 * ITEM-29d — a name that merely had to be QUALIFIED is not the same case. One artifact
 * declaring a name twice occupies that name completely: the bare name still denotes exactly
 * ONE artifact, so it binds to it rather than to nothing. Under the conflated flag both shapes
 * answered `''`, which made a malformed-but-unambiguous artifact unbindable by name for no
 * reason. Both shapes keep the bare KEY either way, so `require.not_in` is unaffected.
 */
export function axisColumnSourcesFor(rows: readonly ArtifactRow[]): Record<string, string> {
  const minted = mintColumnKeys(dedupeRows(rows).flatMap(declaredColumnsOf))
  const out: Record<string, string> = {}
  for (const col of minted) out[col.key] = col.artifactId
  for (const col of minted) {
    if (col.qualified && !(col.name in out)) out[col.name] = col.ambiguous ? '' : col.artifactId
  }
  return out
}

export function axisColumnSources(
  artifacts: readonly ArtifactRow[],
  ofId: string | undefined,
  axis: string | undefined,
  opts?: AxisColumnRowOptions,
): Record<string, string> {
  return axisColumnSourcesFor(axisColumnRows(artifacts, ofId, axis, opts))
}

/**
 * Every metadata column present on `axis` of the dataset `of` anchors, merged into ONE
 * columnar frame.
 *
 * This reads what the axis ACTUALLY carries (INV-5) instead of the newest artifact of a
 * datatype an analysis declared, which is what made the criteria builder offer only the
 * newest analysis' own outputs. A column that predates every analysis — the 65 the reference dataset
 * imported — appears here on equal terms with one a run produced ten seconds ago.
 *
 * A single artifact failing to read does NOT sink the frame: its columns are absent and
 * the rest resolve, because "one column is unreadable" and "the dataset has no metadata"
 * are different situations and only the second is worth blanking the builder for. The
 * failure is logged so it is diagnosable.
 *
 * NOTHING IS EVER MERGED ONTO AN OCCUPIED KEY. Every column that read lands in the frame,
 * under a key minted for the axis AS A WHOLE (`mintColumnKeys`) — so two artifacts declaring
 * one name yield two columns a user can tell apart, rather than one column whose identity
 * was settled by the order the catalog returned rows in.
 */
export async function readAxisColumnsFrame(
  artifacts: readonly ArtifactRow[],
  ofId: string | undefined,
  axis: string | undefined,
  read: ReadArtifactFrame,
  opts?: AxisColumnRowOptions,
  /**
   * OPTIONAL metadata-only reader for a categorical member's DECLARED level set (ITEM-32/34).
   *
   * Injected rather than imported, so this module stays IO-free — the same reason `read` is.
   * It is a METADATA read (one `zarr.json`, no chunks): the picker must be able to list a
   * column's categories without downloading the column, because the list is rendered for every
   * column on the axis while the VALUES are wanted only for the one or two a criterion names.
   * Omitted ⇒ no levels are attached and every consumer falls back to inspecting the data, i.e.
   * byte-identical to before.
   */
  readLevels?: (row: ArtifactRow, memberPath: string) => Promise<readonly string[] | undefined>,
  /**
   * WHICH columns' bodies to fetch (ITEM-34). Given a declared column NAME, `true` ⇒ read this
   * artifact's values; `false` ⇒ describe it from metadata alone.
   *
   * Omitted ⇒ every artifact is read, i.e. byte-identical to the eager behaviour this had before
   * lazy bodies, which is what keeps every existing caller and test unchanged.
   *
   * An artifact that declares NO columns is read regardless: its column set is knowable only by
   * decoding it, so skipping it would silently drop columns rather than defer them. In practice
   * `axisColumnRows` already excludes such an artifact from the candidate rows (that is what
   * keeps a MATRIX out of the table reader), so this arm is defence-in-depth for a direct caller
   * — the laziness applies to what the producer DESCRIBED, and it must never become a second,
   * different filter on which artifacts count as column sources.
   */
  wantValues?: (name: string) => boolean,
): Promise<ColumnarFrame> {
  const rows = dedupeRows(axisColumnRows(artifacts, ofId, axis, opts))
  // ── the gate must be asked in the SAME vocabulary the caller answers in ──────────────────────
  //
  // A criterion carries `col.key` — what the picker offered, what the frame is keyed by, and what
  // the declaration at the bottom of this function writes — and `mintColumnKeys` QUALIFIES that key
  // to `name · <shortid>` for any name occurring on more than one artifact (a live project in this
  // file's own notes has three). Asking `wantValues` the BARE name therefore missed every qualified
  // column: the body was never fetched, the column came back declared-but-absent, and the mask went
  // ALL-FALSE — 0 of N rows with a permanent spinner, because `axisSourceRequestKey` digests the
  // same name set on every edit and so nothing ever re-resolves.
  //
  // Both spellings are accepted. The key is what a picker-built criterion carries; the bare name is
  // what a hand-written spec (and every pre-qualification criterion) carries, and for an
  // uncontested column the two are the same string anyway.
  const mintedKeyByColumn = new Map<string, string>()
  for (const col of mintColumnKeys(rows.flatMap(declaredColumnsOf))) {
    mintedKeyByColumn.set(`${col.artifactId}\n${col.name}`, col.key)
  }
  const read_ = await Promise.all(
    rows.map(async row => {
      // ITEM-34 — decide from the DECLARATION whether this artifact's bytes are needed at all.
      // `declaredColumnsOf` reads the catalog row's own `structure`; it makes no request.
      const declaredHere = declaredColumnsOf(row)
      const wantedHere = (d: { artifactId: string; name: string }): boolean => {
        if (wantValues!(d.name)) return true
        const key = mintedKeyByColumn.get(`${d.artifactId}\n${d.name}`)
        return key !== undefined && key !== d.name && wantValues!(key)
      }
      if (wantValues && declaredHere.length > 0 && !declaredHere.some(wantedHere)) {
        return { row, frame: undefined }
      }
      try {
        return { row, frame: await read(row) }
      } catch (e) {
        console.error(`[declarative] axis_columns: read failed for artifact ${row.id} on axis "${axis}"`, e)
        return { row, frame: {} as ColumnarFrame }
      }
    }),
  )
  // The NAME each read column carries. The reader keys by the MEMBER it decoded, and a
  // single-column store's sole member is the constant `values` — identical for every column
  // on the axis — so the producer's own name is recovered here, at the seam where the row is
  // still in hand (`columnNameForMember`). A column the reader produced without declaring is
  // named by its own key rather than dropped: it is still a column, and it still may not
  // silently displace another.
  const named: Array<{
    artifactId: string
    name: string
    readKey: string
    /** ITEM-34 — `undefined` when this column's body was deliberately not fetched. */
    values: DecodedColumn | undefined
    row: ArtifactRow
    member: string
    kind?: string
    dtype?: string
    n?: number
  }> = []
  for (const { row, frame } of read_) {
    const declared = declaredColumnsOf(row)
    // ITEM-34 — an artifact whose bytes were skipped is described from its DECLARATION alone:
    // every column it declares still appears, with its kind, dtype and row count, and no values.
    // That is the "metadata for all columns" half, and it is why the picker keeps offering all
    // 65 while only the criterion-named bodies are downloaded.
    if (frame === undefined) {
      for (const d of declared) {
        named.push({
          artifactId: row.id,
          name: d.name,
          readKey: d.member,
          values: undefined,
          row,
          member: d.member,
          ...(d.kind !== undefined ? { kind: d.kind } : {}),
          ...(d.dtype !== undefined ? { dtype: d.dtype } : {}),
          ...(d.n !== undefined ? { n: d.n } : {}),
        })
      }
      continue
    }
    const byMember = new Map(declared.map(d => [d.member, d.name]))
    const declByMember = new Map(declared.map(d => [d.member, d]))
    const keys = Object.keys(frame)
    for (const readKey of keys) {
      const name =
        byMember.get(readKey) ??
        // A sole member decoded under a path the declaration spells differently is still that
        // member: the producer's name is the answer, and this is the shape every real
        // single-column import takes.
        (declared.length === 1 && keys.length === 1 ? declared[0].name : readKey)
      const decl = declByMember.get(readKey) ?? (declared.length === 1 ? declared[0] : undefined)
      named.push({
        artifactId: row.id,
        name,
        readKey,
        values: frame[readKey],
        row,
        member: decl?.member ?? readKey,
        ...(decl?.kind !== undefined ? { kind: decl.kind } : {}),
        ...(decl?.dtype !== undefined ? { dtype: decl.dtype } : {}),
        ...(decl?.n !== undefined ? { n: decl.n } : {}),
      })
    }
  }
  const out: ColumnarFrame = {}
  const decls: ColumnDeclarations = {}
  const minted = mintColumnKeys(named)
  // The declared level set of every CATEGORICAL member, read as METADATA and concurrently.
  // Numeric members are skipped — they have no level set and a range control needs none.
  const levels = new Map<string, readonly string[] | undefined>()
  if (readLevels) {
    await Promise.all(
      minted.map(async (col, i) => {
        const n = named[i]
        // Categorical OR declared-bool. A bool column HAS a level set (`false`/`true`) and users
        // filter on it, but it is not spelled `categorical` by every producer — and skipping it
        // here left the picker deriving its options from the CODES (`"1"`/`"0"`), which the
        // comparator cannot match against a saved `True`. Numeric members are still skipped: a
        // range control needs no level set, and reading one would be the body fetch this whole
        // metadata path exists to avoid.
        if (n.kind !== 'categorical' && !isDeclaredBool(n.kind, n.dtype)) return
        try {
          levels.set(col.key, await readLevels(n.row, n.member))
        } catch (e) {
          // A member whose metadata cannot be read contributes no levels; the consumer falls
          // back to inspecting the values, exactly as before this existed. Logged rather than
          // silent, because a DECLARED categorical that cannot state its levels is a real fault.
          console.error(`[declarative] axis_columns: declared-levels read failed for ${n.name}`, e)
        }
      }),
    )
  }
  minted.forEach((col, i) => {
    const n = named[i]
    // ITEM-34 — a column whose body was not fetched contributes NO frame key. That is load-bearing
    // rather than incidental: `keep_mask` tells ABSENT from PENDING by exactly this pair — the
    // declaration says the column exists while the frame says its values are not here — and a
    // placeholder (an empty array, a null) would read as a present column of zero rows and take
    // the permissive all-true path. `Object.keys(frame)` therefore stays the set of columns whose
    // VALUES are available, which is what every guard in the tree already assumes it to be.
    if (n.values !== undefined) out[col.key] = n.values
    // A `numeric` member IS the continuous kind; everything else keeps the producer's own word.
    // An undeclared member contributes nothing, so a frame with no declarations behaves exactly
    // as it did before this existed.
    if (n.kind !== undefined) {
      decls[col.key] = declaration(
        n.kind === 'numeric' ? 'continuous' : n.kind,
        levels.get(col.key),
        // `isDeclaredBool`, not an inline `dtype === 'bool'`. The rule it encodes — a bool column
        // is declared `kind: categorical` with `stored_dtype: bool`, so the KIND alone cannot tell
        // you its levels need the spelling bridge — was written down in the predicate and then
        // re-implemented, half of it, here. Routing through it also picks up the producer that
        // declares `kind: bool` directly, which the inline test silently missed: its levels would
        // have been offered raw (`"true"`) against a comparator that spells them `"True"`, and
        // every row of that criterion would disappear with no error.
        isDeclaredBool(n.kind, n.dtype),
        n.n,
      )
    }
  })
  // ITEM-43 / DRIFT-1.12 — registered AGAINST the frame object, never as a key INSIDE it. The
  // frame's own key space stays exactly the column set, which is what `Object.keys(frame)` is
  // asked for all over the tree and what four assertions in this module's tests pin.
  return attachDeclarations(out, decls)
}
