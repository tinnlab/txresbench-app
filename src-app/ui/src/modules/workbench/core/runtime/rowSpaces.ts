// WHAT A SET OF ROWS IS CALLED (visualize-pane ITEM-12 / ITEM-12b) — the naming JOIN.
//
// This module was the pane ANCHOR control's: the list it offered, and the words each option
// read as. The control is deleted (owner, 2026-08-13 — see the divider at the foot of this
// file), and what survives is the one question that was never the control's own: given a set
// of rows, what is it CALLED. `runtime/paneFrame.ts` asks it, to name the rows a pane turned
// out to be about — a caption, downstream of a derivation, not an offer.
//
// ── A FLAT list, and why not a grouped one ──────────────────────────────────────────────
//
// Design §7.5.2: *"The user is not choosing between 'a dataset' and 'the project' — that is a
// storage fact, and it is not the question they are asking. They are choosing WHICH ROWS. So
// the anchor is a flat list of row spaces, and provenance appears only as how each is NAMED.
// The LENGTH is the column that proves they are three different things, not three names for
// one."*
//
// ── The provenance name is a JOIN, and it is keyed on `content_hash` ────────────────────
//
// `AxisSummary` is `{content_hash, name, length}` and nothing else: `name` is the axis LABEL
// and is documented "never a key", and there is no dataset name, run id or producing artifact
// on the wire. ITEM-12's *"each entry is named by provenance"* is therefore not expressible
// from the axis list alone — which is what ITEM-12b records, and DEC-5 rules: a CLIENT-SIDE
// JOIN, in one pure function, keyed on `content_hash` and NEVER on `AxisSummary.name`. The
// catalog already delivers the axes and the artifacts in ONE response, so the join costs
// nothing and adds no derived fact to the wire beside the thing it is derived from.
//
// An axis whose key artifact is not in the artifact list gets a STATED fallback, never a
// guessed name: a name invented for a row space is the one thing that would make two of them
// indistinguishable, which is the whole failure this control exists to prevent.

import type { AxisSummary } from '@/api-client/types'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { sourceDatasetsLabel } from '@/core/workstore'

/** One offered row space. */
export interface RowSpaceOption {
  /** the IDENTITY — `AxisSummary.content_hash`, which is what `$scope.axis` carries and what
   *  every anchored source joins on (INV-1). */
  contentHash: string
  /** where these rows CAME FROM, resolved by the join. Display only. */
  provenance: string
  /** the axis's declared LABEL. Display only — two row spaces legitimately share one, which
   *  is precisely why it is not the identity. */
  label: string
  /** how many rows. The column that proves two same-labelled options are different things. */
  length: number
  /** whether the provenance could be resolved at all. `false` ⇒ {@link provenance} is the
   *  STATED fallback rather than a name, and the control says so instead of pretending. */
  resolved: boolean
}

/** What an axis with no findable key artifact reads as. It states the SITUATION (the axis is
 *  known, its origin is not) rather than inventing a name or rendering blank. */
export const UNRESOLVED_ROW_SPACE = 'Origin not recorded'

/**
 * The row spaces a project offers, in a stable declared order.
 *
 * EVERY axis the catalog publishes is offered, and nothing here decides which axes are
 * "really" row spaces. There is no declaration that says so — an axis is an axis — and every
 * available proxy (the longest one, the one most artifacts sit on, a name) is either a
 * heuristic or a label, i.e. `[0]` wearing a costume. The consequence is stated rather than
 * hidden: on a project whose data carries two axes, the pane opens UNANCHORED and asks, and
 * auto-anchoring (ITEM-13) fires only where there is genuinely one candidate.
 *
 * Sorted by provenance then label then hash — declared and stable, so the list does not
 * reorder itself between two catalog reads that returned the same rows in a different order.
 * NOT by length, and not by "importance": there is no such declaration to read.
 */
export function rowSpaceOptions(
  axes: readonly AxisSummary[],
  artifacts: readonly ArtifactRow[],
): RowSpaceOption[] {
  const byHash = new Map<string, ArtifactRow>()
  for (const a of artifacts) {
    if (typeof a.content_hash === 'string' && a.content_hash !== '' && !byHash.has(a.content_hash)) {
      byHash.set(a.content_hash, a)
    }
  }
  return axes
    .map(axis => {
      const key = byHash.get(axis.content_hash)
      return {
        contentHash: axis.content_hash,
        provenance: key ? sourceDatasetsLabel(key) : UNRESOLVED_ROW_SPACE,
        label: axis.name,
        length: axis.length,
        resolved: key !== undefined,
      }
    })
    .sort(
      (a, b) =>
        a.provenance.localeCompare(b.provenance) ||
        a.label.localeCompare(b.label) ||
        a.contentHash.localeCompare(b.contentHash),
    )
}

// ── WHAT USED TO LIVE BELOW, AND WHERE IT WENT ──────────────────────────────────────────
//
// Five more exports stood here, and all five were the pane ANCHOR control's:
//
//   · `rowSpaceOffer` + `RowSpaceOffer` — CANDIDACY. Which axes were worth OFFERING, because
//     a row space is not an axis: an axis is a candidate only when a picture can be drawn on
//     it (something declaring positions, declared A1-aligned to those rows). It also carried
//     `decided`, so "could not narrow" was a resolved fact rather than an empty list.
//   · `rowSpaceLabel`, `sharedRowSpaceSource`, `rowSpaceOptionLabel`, `rowSpaceOfferLabels` —
//     the LABELLING rules, i.e. print what distinguishes and suppress what is constant, so a
//     project whose one dataset publishes two axes did not read as two datasets.
//
// The owner deleted the control they served (2026-08-13): there is no such thing as a row
// space, an axis is never a thing a user picks, and the pane's rows are DERIVED from the
// chosen coordinate set (`./coordinateAxis.ts`). With the control gone their only remaining
// callers were their own tests, so they are gone with it rather than left as a library nobody
// calls — an offer nothing offers and a label nothing prints are dead weight that reads as
// live rules to the next author.
//
// The RULE they encoded did not die with them: "print what distinguishes, suppress what is
// constant" is now carried by § Coordinates' own candidate list, which groups its options
// under their source dataset and omits the heading when there is only one
// (`runtime/candidateGroups.ts` + the radio arm of `render/ArtifactRefWidget.tsx`), and it is
// asserted where that list is rendered — `render/distinguishableOptions.test.tsx`.
//
// `rowSpaceOptions` and {@link UNRESOLVED_ROW_SPACE} above SURVIVE: `runtime/paneFrame.ts`
// still asks them what a set of rows is CALLED, which is a naming question and not an offer.
