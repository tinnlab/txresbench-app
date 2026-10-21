// WHICH ROWS A CHOSEN COORDINATE SET IS ABOUT — the join that replaced the question.
//
// The pane used to ASK which rows it was about, in a control above every section. The owner's
// ruling is that the question does not exist: *"there is no such thing as a row space"*, and
// an axis — whatever a dataset happens to call one — is never a thing a person picks. So the
// pane's first block is § Coordinates, and `$scope.axis`, which every other contributed section
// resolves its candidates against, is DERIVED from the coordinate set the user picked.
//
// It is a join over DECLARATIONS (INV-11), never a guess: an unanswerable join yields NOTHING
// (`[]`), which leaves the dependent sections empty and saying what they need, rather than
// pointing them at some other population's rows.
//
// It is PLURAL (ITEM-8). A coordinate integrating two datasets rests on BOTH their axes, so the
// answer is the list of `(axis identity, membership)` pairs it declared — one entry for the
// ordinary single-dataset case, and never a truncation of the integrated one.
//
// TWO rungs, in this order, and the second exists because the FIRST DOES NOT FIRE ON REAL DATA:
//
//   1. `structure.memberships[].aligned_to`, or the legacy scalar `structure.aligned_to` as its
//      one-entry case — the producer named the key sequence(s) its positions rest on.
//      A positive declared join, the strongest thing available, and what a current importer
//      stamps.
//   2. the artifact's own DECLARED axis label, within its own source dataset. Data imported
//      before the importer stamped `aligned_to` declares no alignment at all; on such a
//      project rung 1 answers nothing, and a pane that then anchored on nothing would list
//      coordinates and never scope anything to them. `structure.axis` + the artifact's source
//      dataset are both declarations, and the pair identifies ONE axis instance exactly as
//      `siblingsOnAxis` identifies one (an axis instance is `(source dataset, axis label)`).
//      AMBIGUITY REFUSES: two key artifacts answering means the pair did not identify one
//      thing, and picking either would be `layouts[0]` wearing a join.

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { sharesSourceDataset } from '@/core/workstore'
import { declaredAxes, declaredMemberships } from './axisSource'
import type { DeclaredMembership } from './axisSource'

/** The SOLE member of a list, or `undefined`. Ambiguity is not a tie to break. */
function sole<T>(xs: readonly T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined
}

/**
 * Is this row the artifact that IS an axis — i.e. the thing `AxisSummary.content_hash` names?
 *
 * ONE declaration answers it, and it is the one the PRODUCER uses to say so:
 * `meta.is_axis_index`. That is not a preference — it is the same predicate the server derives
 * the project's axes with (`workstore/data_api.rs`: *"which artifacts are axes — those whose
 * producer declared `meta.is_axis_index`"*), so an artifact without it does not have an
 * `AxisSummary` at all and its `content_hash` names nothing `$scope.axis` can be.
 *
 * ── WHY `structure.key_sequence_digest` IS NOT the second answer (ledger #22) ────────────
 *
 * It reads like one: a digest is what an aligned artifact joins against, so "declares a digest"
 * looks like "is an axis". It is not. The digest is a claim about the artifact's own VALUES —
 * *these values ARE that key sequence* — and an ordinary per-row identifier column truthfully
 * makes it while explicitly not claiming to be the axis. Every real import writes exactly that
 * pair: the canonical index (`is_axis_index` + the digest) and a per-row identifier column
 * carrying the same keys (the digest alone, and the importer's own comment says it *"deliberately
 * carries no `is_axis_index`"*).
 *
 * So accepting the digest made the pair look like TWO axes with one label in one dataset — and
 * ambiguity refuses, correctly, which meant `axesOfCoordinate` answered nothing on every project
 * an ordinary importer produced. That is the reported defect: picking a coordinate set scoped
 * nothing, both dependent sections stayed on their "pick a coordinate set above" sentence,
 * and no fixture had ever written the second keys-declaring artifact.
 *
 * A `content_hash` is still required: `$scope.axis` IS a list of those hashes, so a row without
 * one is not an identity anything downstream can join on and must never be returned as an answer.
 */
function isKeyArtifact(row: ArtifactRow): boolean {
  if (typeof row.content_hash !== 'string' || row.content_hash === '') return false
  return (row.meta as { is_axis_index?: unknown } | undefined)?.is_axis_index === true
}

/**
 * ONE axis a chosen coordinate rests on, paired with the declaration that put it there.
 *
 * The pair is the design's unit (§2.1): an artifact declares an `(axis identity, membership)`
 * PER AXIS, and the membership is what says WHICH of that axis's rows the coordinate is about.
 * Carrying the identity without the declaration it came from would make the two halves
 * re-joinable only by guessing, which is the whole failure mode this model removes.
 */
export interface CoordinateAxis {
  /** the axis's IDENTITY — an `AxisSummary.content_hash`, exactly what `$scope.axis` carries
   *  and what `resolveRowSpaceAnchor` joins on. */
  contentHash: string
  /**
   * The key sequence the membership entry this axis came from named
   * (`aligned_to`), or `undefined` when the axis was identified by LABEL — rung 2 reads no
   * membership at all, so there is nothing to report rather than a membership to invent.
   */
  alignedTo?: string
  /**
   * The WHOLE membership entry this axis came from (ITEM-6) — `kind`, `n_members`, the
   * inline member set — or `undefined` on rung 2, where no membership was read.
   *
   * `alignedTo` above is this entry's identifying component, kept as its own field because
   * every consumer today wants exactly that; this is what the ones that need to know WHICH
   * ROWS read (ITEM-9's figure is denominated on `nMembers`, and a gather's segment order
   * is these entries' declaration order).
   */
  membership?: DeclaredMembership
}

/**
 * The axes a chosen coordinate artifact's positions rest on — the `(axis identity, membership)`
 * pairs it declared, in the order it declared them (ITEM-8).
 *
 * `[]` for: no coordinate chosen, a coordinate that is not in the catalog, and every join that
 * could not be decided from declarations.
 *
 * ── WHY THIS IS PLURAL ──────────────────────────────────────────────────────────────────
 *
 * It answered ONE `content_hash`, which is a claim that a coordinate rests on one axis. An
 * INTEGRATED coordinate rests on two, and there is no third axis that is "the" one — so the
 * scalar form could only ever answer with one of the pair, and the pane would then offer half
 * the columns and call the picture complete. See `RowSpaceAnchor` (`./axisSource.ts`) for the
 * same argument one layer down.
 *
 * ── ALL OR NOTHING ──────────────────────────────────────────────────────────────────────
 *
 * Every declared membership must resolve to exactly ONE key artifact. If any one of them is
 * unresolvable or AMBIGUOUS, the answer is `[]` — not the pairs that did resolve. Returning a
 * short list is the truncation this function was made plural to stop, and it is indistinguishable
 * downstream from a coordinate that genuinely rests on fewer axes. Ambiguity still refuses
 * rather than picking, exactly as the scalar form did.
 */
export function axesOfCoordinate(
  artifacts: readonly ArtifactRow[],
  coordinate: string | null | undefined,
): CoordinateAxis[] {
  if (typeof coordinate !== 'string' || coordinate === '') return []
  const row = artifacts.find(a => a.id === coordinate)
  if (!row) return []
  const keys = artifacts.filter(isKeyArtifact)

  // Rung 1 — the producer said which key sequence(s) these positions line up with, read
  // through ITEM-6's single reader (which applies ITEM-2's legacy default, so the scalar
  // `aligned_to` every artifact in every project carries today is its one-entry case).
  const declared = declaredMemberships(row.structure)
  if (declared.length > 0) {
    const out: CoordinateAxis[] = []
    for (const membership of declared) {
      const match = sole(
        keys.filter(
          a =>
            (a.structure as { key_sequence_digest?: string }).key_sequence_digest ===
            membership.alignedTo,
        ),
      )
      if (!match?.content_hash) return []
      out.push({ contentHash: match.content_hash, alignedTo: membership.alignedTo, membership })
    }
    return out
  }

  // Rung 2 — nothing declared alignment, so the axis INSTANCE is identified the way every other
  // axis-scoped question in the engine identifies one: the artifact's own declared axis label,
  // inside its own source dataset.
  //
  // STILL SOLE, and still for the original reason: a coordinate declaring SEVERAL axis labels
  // and no alignment has named no membership on any of them, so which rows of each it is about
  // is exactly the thing nothing states. Enumerating them here would turn "undeclared" into a
  // positive claim of `full` on every one of them — the guess rung 2's `sole` was written to
  // refuse. An integrated coordinate is expected to declare its memberships (rung 1); one that
  // does not is A3 territory, and A3 is a state, not a shortfall to be filled in.
  const axis = sole(declaredAxes(row.structure))
  if (axis === undefined) return []
  const match = sole(
    keys.filter(a => sharesSourceDataset(row, a) && declaredAxes(a.structure).includes(axis)),
  )
  if (!match?.content_hash) return []
  return [{ contentHash: match.content_hash }]
}

