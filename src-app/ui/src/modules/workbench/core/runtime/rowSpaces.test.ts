// TEST-18 (ITEM-12), TEST-19 (ITEM-12b), TEST-16/TEST-17 (ITEM-10, the pane scope's shape)
// and the acceptance pin TEST-A13 (INV-13).
//
// No domain vocabulary: the axis labels are `rows` and `entries`, the datasets are `Batch A` /
// `Batch B`. A fixture spelling a real axis label would let an implementation that RECOGNISED
// the label pass, which is the tautology INV-14 rules out.

import { describe, expect, it } from 'vitest'

import type { AxisSummary } from '@/api-client/types'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { PANE_SCOPE_KEYS, currentPaneScope, paneScopeStore } from './paneScope.store'
import { UNRESOLVED_ROW_SPACE, type RowSpaceOption, rowSpaceOptions } from './rowSpaces'

// What ONE option carries, as its consumer reads it. `rowSpaceLabel` — the deleted formatter
// that joined these three with ` · ` — was the ANCHOR CONTROL's rendering, and the control is
// gone (see the divider at the foot of this file). `runtime/paneFrame.ts`, the surviving
// consumer, reads the three fields SEPARATELY (`row_space`, `row_space_label`,
// `row_space_length`), so that is the shape asserted here: the same three facts, read the way
// the only caller reads them, with no formatter standing between the join and the assertion.
const parts = (o: RowSpaceOption): [string, string, string] => [
  o.provenance,
  o.label,
  o.length.toLocaleString(),
]

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const axis = (hash: string, name: string, length: number): AxisSummary => ({
  content_hash: hash,
  name,
  length,
})

function key(hash: string, dataset: string | null, name: string | null): ArtifactRow {
  return {
    id: `k-${hash.slice(0, 4)}`,
    project_id: 'p',
    datatype: 'demo/key',
    structure: {},
    created_at: '2026-01-01T00:00:00Z',
    content_hash: hash,
    source_dataset_id: dataset,
    source_dataset_name: name,
  }
}

describe('rowSpaceOptions (ITEM-12 / ITEM-12b) — a FLAT list, named by a JOIN', () => {
  it('names each row space by provenance and shows its LENGTH', () => {
    const out = rowSpaceOptions(
      [axis(A, 'rows', 5432), axis(B, 'rows', 9100)],
      [key(A, 'ds-a', 'Batch A'), key(B, 'ds-b', 'Batch B')],
    )
    expect(out.map(parts)).toEqual([
      ['Batch A', 'rows', '5,432'],
      ['Batch B', 'rows', '9,100'],
    ])
  })

  it('is FLAT — nothing is grouped by dataset-vs-project scope', () => {
    const out = rowSpaceOptions([axis(A, 'rows', 10), axis(B, 'rows', 20)], [
      key(A, 'ds-a', 'Batch A'),
      key(B, null, null),
    ])
    // Two peers in one list. A project-scoped row space is NAMED differently and is not
    // filed under a different heading — the storage fact is not the question being asked.
    expect(out).toHaveLength(2)
    expect(out.every(o => typeof o.provenance === 'string')).toBe(true)
    expect(out.map(o => o.contentHash).sort()).toEqual([A, B].sort())
  })

  it('tells two SAME-LABELLED row spaces apart, and keys on the hash — never on the label', () => {
    const out = rowSpaceOptions(
      [axis(A, 'rows', 5432), axis(B, 'rows', 9100)],
      [key(A, 'ds-a', 'Batch A'), key(B, 'ds-b', 'Batch B')],
    )
    const labels = out.map(o => parts(o).join(' · '))
    expect(new Set(labels).size).toBe(2)
    expect(new Set(out.map(o => o.contentHash)).size).toBe(2)
  })

  it('STATES an unresolvable provenance rather than guessing a name', () => {
    const out = rowSpaceOptions([axis(A, 'rows', 5432)], [])
    expect(out[0].resolved).toBe(false)
    expect(out[0].provenance).toBe(UNRESOLVED_ROW_SPACE)
    // …and still carries the identity and the length, so it remains selectable and legible.
    expect(out[0].contentHash).toBe(A)
    expect(parts(out[0])).toContain('5,432')
  })

  it('never joins on the axis LABEL — a key artifact with a matching name but a different hash is not it', () => {
    const decoy = key('c'.repeat(64), 'ds-c', 'Batch C')
    const out = rowSpaceOptions([axis(A, 'rows', 5432)], [decoy])
    expect(out[0].provenance).toBe(UNRESOLVED_ROW_SPACE)
  })

  it('offers EVERY published axis, and arbitrates none away', () => {
    // Nothing declares which axes are "really" row spaces, so nothing here decides. The
    // consequence is stated in `rowSpaces.ts` and is what makes the auto-anchor honest.
    const out = rowSpaceOptions([axis(A, 'rows', 5432), axis(B, 'entries', 18204)], [
      key(A, 'ds-a', 'Batch A'),
      key(B, 'ds-a', 'Batch A'),
    ])
    expect(out).toHaveLength(2)
  })
})

describe('pane scope (ITEM-10 / INV-13) — exactly the design\'s values, and no more', () => {
  it('holds EXACTLY `axis` and `coordinate`, by enumeration', () => {
    // TEST-17 / TEST-A13: an enumeration, so a third value — `$scope.colorBy`, the one the
    // design explicitly removed ("there is no such fact") — fails here rather than passing
    // review.
    expect([...PANE_SCOPE_KEYS]).toEqual(['axis', 'coordinate'])
    paneScopeStore.getState().reset()
    expect(Object.keys(currentPaneScope()).sort()).toEqual([...PANE_SCOPE_KEYS].sort())
  })

  it('is EMPTY until chosen (R1/INV-2)', () => {
    paneScopeStore.getState().reset()
    expect(currentPaneScope().axis).toEqual([])
  })

  it('carries an `AxisSummary.content_hash`, DERIVED — and a re-derivation keeps the coordinate', () => {
    // This asserted the opposite until 2026-08-13: `setAxis` NULLED the coordinate on every
    // anchor change, because the anchor was a question asked ABOVE the coordinate picker. The
    // owner deleted that control (an axis is never a thing a user picks), so the dependency
    // inverted — the coordinate is the choice and the rows are DERIVED from it
    // (`./coordinateAxis.ts`), written only through `setDerivedAxis`. Clearing the coordinate
    // here would now destroy the choice in the act of recording its consequence.
    //
    // The property the old assertion protected — the pane's two values may never disagree
    // about which population they are about — is unchanged and is what makes the derivation
    // safe: `axis` cannot outlive the coordinate it came from, because it is re-derived
    // whenever that coordinate moves.
    paneScopeStore.getState().reset()
    paneScopeStore.getState().bindProject('p1')
    paneScopeStore.getState().setDerivedAxis('p1', [A])
    expect(currentPaneScope().axis).toEqual([A])
    paneScopeStore.getState().setValue('coordinate', 'some-artifact')
    paneScopeStore.getState().setDerivedAxis('p1', [B])
    expect(currentPaneScope()).toEqual({ axis: [B], coordinate: 'some-artifact' })
  })

  it('does not carry the rows ACROSS projects — a hash from another project names nothing', () => {
    paneScopeStore.getState().reset()
    paneScopeStore.getState().bindProject('p1')
    paneScopeStore.getState().setDerivedAxis('p1', [A])
    paneScopeStore.getState().bindProject('p2')
    expect(currentPaneScope().axis).toEqual([])
    // Re-binding the SAME project is a no-op, so this is safe from a render effect.
    paneScopeStore.getState().setDerivedAxis('p2', [B])
    paneScopeStore.getState().bindProject('p2')
    expect(currentPaneScope().axis).toEqual([B])
  })
})

// ── THE CANDIDACY + OFFER-LABELLING BLOCK THAT STOOD HERE ──────────────────────────────
//
// It exercised `rowSpaceOffer` and `rowSpaceOfferLabels` (and, through them,
// `sharedRowSpaceSource` / `rowSpaceOptionLabel` / `rowSpaceLabel`): which axes were worth
// OFFERING as row spaces, and what each option READ as once offered.
//
// All five functions are DELETED from `rowSpaces.ts` (owner, 2026-08-13). The pane's anchor
// control was their only production caller, and the owner's ruling is that the control asked a
// question that does not exist — there is no such thing as a row space, and an axis is never a
// thing a user picks. The pane's rows are now DERIVED from the coordinate set the user chose
// (`./coordinateAxis.ts`), so there is no offer to narrow and no option to label. Tests kept
// alive over test-only functions certify a library nobody calls, so the block goes with them.
//
// Neither rule is unguarded:
//   · CANDIDACY — "only offer what a picture can be drawn on" is now the § Coordinates source
//     itself (`capabilities: [plottable-xy], dims: 2` in the shipped view spec), asserted in
//     `extensions/visualize/coordinates.test.ts`;
//   · LABELLING — "print what distinguishes, suppress what is constant" is now the candidate
//     list's dataset grouping, asserted on RENDERED TEXT in
//     `render/distinguishableOptions.test.tsx`, which is a stronger place for it than a string
//     comparison against a pure function.
