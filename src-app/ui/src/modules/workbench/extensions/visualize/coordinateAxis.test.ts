// TEST-22 (visualize-pane ITEM-14, INV-8) — **THE PANE'S ROWS ARE THE ONES ITS COORDINATES
// DECLARE. NOBODY PICKS THEM, AND NOTHING ELSE MAY WRITE THEM.**
//
// ── what this file was, and why it is not deleted ─────────────────────────────────────────
//
// It was `anchor.test.ts`, and it asserted INV-8 in the direction it ran until 2026-08-13:
// *"a BINDING does not survive a row-space switch"* … *"on an ANCHOR change,
// `$scope.coordinate` goes to `null` rather than being re-resolved to a same-named coordinate
// set in the new space."* The pane's first block was a control that ASKED which rows the pane
// was about, `paneScopeStore.setAxis` was its writer, and the clearing was that writer's job.
//
// The owner deleted the control: there is no such thing as a row space, and an axis is never a
// thing a user picks. So there is no anchor, no anchor change, and nothing for an anchor change
// to clear — the file is renamed for what actually decides the rows now
// (`core/runtime/coordinateAxis.ts::axesOfCoordinate`), and every invariant it protected that
// still exists is carried over verbatim:
//
//   · a frame CAN be set (the positive control that keeps the rest non-vacuous);
//   · a frame does not cross PROJECTS;
//   · there is no third pane value a frame could hide in (INV-13's closed set);
//   · the identity carried is a `content_hash`, never a label (INV-1).
//
// The one invariant that is genuinely gone — "an anchor change nulls the coordinate" — is
// replaced by the property that now carries the same guarantee. The failure INV-8 exists
// against is a picture drawn in ANOTHER population's coordinates, i.e. `$scope.axis` and
// `$scope.coordinate` disagreeing about which rows the pane is about. That could happen when
// they were two independent choices. It cannot happen now, and the three assertions that
// establish it are: the axis FOLLOWS the coordinate, it never outlives it, and no section may
// write it (a declaration writing `axis` would be asserting rows nothing declared — the modern
// spelling of "a binding that survived a switch").
//
// ── why the store and the real derivation, and not a mock ────────────────────────────────
//
// `paneScope.store` is still the rule's only enforcement point, `setValue` is the seam a
// section's `set:` reaches it through, and `axesOfCoordinate` is the sole decider of what the
// rows are. Driving anything else would assert a copy of the rule.

import { beforeEach, describe, expect, it } from 'vitest'

import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { axesOfCoordinate } from '@/modules/workbench/core/runtime/coordinateAxis'
import { PANE_SCOPE_KEYS, currentPaneScope, paneScopeStore } from '@/modules/workbench/core/runtime/paneScope.store'

const PROJECT = 'proj-anchor'
/** Two populations. Content hashes, never labels — the identity `$scope.axis` carries (INV-1). */
const SPACE_A = 'hash-rows-a'
const SPACE_B = 'hash-rows-b'
/** Two DIFFERENT artifacts that a user would read as the same thing: one set of positions, once
 *  per population, under one shared label. Drawing one against the other's rows is the
 *  wrong-frame picture ITEM-14 exists to prevent. */
const POSITIONS_IN_A = 'artifact-positions-in-a'
const POSITIONS_IN_B = 'artifact-positions-in-b'

beforeEach(() => {
  paneScopeStore.getState().reset()
  paneScopeStore.getState().bindProject(PROJECT)
})

/** Choose a coordinate the way a section does — `setValue` from § Coordinates' declared `set:`
 *  — and then record what the derivation says its rows are, the way the pane's own binding
 *  effect does. Two calls, deliberately, because they are two different authorities: the user
 *  picks the positions; nothing but the join decides the rows. */
function frame(coordinate: string, axis: readonly string[]): void {
  paneScopeStore.getState().setValue('coordinate', coordinate)
  paneScopeStore.getState().setDerivedAxis(PROJECT, axis)
}

describe('TEST-22 — the pane’s rows follow its coordinates (ITEM-14 / INV-8)', () => {
  it('positive control: a frame CAN be set, so everything below is not vacuous', () => {
    frame(POSITIONS_IN_A, [SPACE_A])
    expect(currentPaneScope()).toEqual({ axis: [SPACE_A], coordinate: POSITIONS_IN_A })
  })

  it('choosing a coordinate in ANOTHER population moves the rows with it', () => {
    // The replacement for "an anchor change nulls the coordinate". Same guarantee, one
    // dependency inverted: the two values cannot end up describing different populations,
    // because one is derived from the other rather than chosen beside it.
    frame(POSITIONS_IN_A, [SPACE_A])
    frame(POSITIONS_IN_B, [SPACE_B])
    const after = currentPaneScope()
    expect(after.coordinate).toBe(POSITIONS_IN_B)
    expect(after.axis).toEqual([SPACE_B])
    // …and specifically NOT still pointing at the population the previous positions rested on.
    expect(after.axis).not.toEqual([SPACE_A])
  })

  it('the rows never outlive the coordinate they were derived from', () => {
    // An unanswerable join — no coordinate, or one whose rows no declaration decides — is a
    // real answer and must be written. A "only write a truthy value" implementation leaves the
    // previous population standing over positions that are gone, which is the stale-frame half
    // of the same failure.
    frame(POSITIONS_IN_A, [SPACE_A])
    paneScopeStore.getState().setValue('coordinate', null)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [])
    expect(currentPaneScope()).toEqual({ axis: [], coordinate: null })
  })

  it('a SECTION may not write the rows — the seam refuses `axis`, and says so', () => {
    // The move that would restore the pre-derivation failure: a declaration asserting rows of
    // its own, beside positions that declare different ones. Refused, and REPORTED — a write
    // that silently does nothing is a control that looks wired and is not.
    frame(POSITIONS_IN_A, [SPACE_A])
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      paneScopeStore.getState().setValue('axis', SPACE_B)
    } finally {
      console.error = original
    }
    expect(currentPaneScope().axis).toEqual([SPACE_A])
    expect(errors.length).toBe(1)
  })

  it('a re-derivation to the SAME rows does not clear a live frame', () => {
    // The other half of the same rule, and the one a naive "always rewrite" would break: the
    // binding effect re-runs on every catalog read, so a duplicate write must not throw the
    // user's chosen coordinate away.
    frame(POSITIONS_IN_A, [SPACE_A])
    paneScopeStore.getState().setDerivedAxis(PROJECT, [SPACE_A])
    expect(currentPaneScope()).toEqual({ axis: [SPACE_A], coordinate: POSITIONS_IN_A })
  })

  it('a frame does not cross PROJECTS — a hash from another project names nothing', () => {
    frame(POSITIONS_IN_A, [SPACE_A])
    paneScopeStore.getState().bindProject('proj-other')
    expect(currentPaneScope()).toEqual({ axis: [], coordinate: null })
  })

  it('there is no third pane value a frame could hide in (INV-13)', () => {
    // If a `$scope.lastCoordinate` were ever added, everything above could be true while a
    // stale frame survived beside it. The closed set is what makes "moved" mean "moved".
    expect([...PANE_SCOPE_KEYS].sort()).toEqual(['axis', 'coordinate'])
    frame(POSITIONS_IN_A, [SPACE_A])
    frame(POSITIONS_IN_B, [SPACE_B])
    expect(Object.keys(currentPaneScope()).sort()).toEqual(['axis', 'coordinate'])
  })
})

// ── THE JOIN ITSELF — what actually decides the rows ─────────────────────────────────────
//
// The block above drives `setDerivedAxis` with an answer supplied by the test, which is right
// for a store contract and is exactly what a test of the DERIVATION must not do. These assert
// the answer: `axesOfCoordinate` is a join over DECLARATIONS (INV-11) and never a guess, so an
// undecidable join yields NOTHING — the dependent sections then say what they need, rather than
// pointing at some other population's rows.
//
// No domain vocabulary in the fixtures (`rows` / `entries`, `Batch A` / `Batch B`): an
// implementation that RECOGNISED a real axis label would pass a domain-spelt test, which is
// the tautology INV-14 rules out.

const KEY_A = 'k'.repeat(64)
const KEY_B = 'j'.repeat(64)
const DIGEST_A = 'digest-a'
const DIGEST_B = 'digest-b'

/** A KEY artifact — the thing that IS a set of rows, declaring the ordered key sequence others
 *  align to. Its `content_hash` is the identity `$scope.axis` carries, and `meta.is_axis_index`
 *  is the producer declaration that makes it an axis at all (the same one the server derives
 *  the project's axes from). It used to be omitted here, so the fixture stood in for an axis
 *  with the one declaration an ordinary IDENTIFIER COLUMN also carries — see ledger #22. */
const keyArtifact = (id: string, hash: string, digest: string, dataset: string, axis = 'rows'): ArtifactRow =>
  ({
    id,
    project_id: 'p',
    datatype: 'demo/key',
    created_at: '2026-01-01T00:00:00Z',
    content_hash: hash,
    source_dataset_id: dataset,
    source_dataset_name: dataset,
    meta: { is_axis_index: true },
    structure: { encoding: 'zarr_v3', kind: 'table', axis, key: 'values', key_sequence_digest: digest },
  }) as ArtifactRow

/** A coordinate set. `alignedTo` present ⇒ rung 1 (the producer declared the join); absent ⇒
 *  rung 2 has to identify the rows from the artifact's own declared axis label + its dataset. */
const coords = (id: string, dataset: string, axis: string, alignedTo?: string): ArtifactRow =>
  ({
    id,
    project_id: 'p',
    datatype: 'demo/positions',
    created_at: '2026-01-01T00:00:00Z',
    content_hash: `c-${id}`,
    source_dataset_id: dataset,
    source_dataset_name: dataset,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      ...(alignedTo === undefined ? {} : { aligned_to: alignedTo }),
    },
  }) as ArtifactRow

/** The pair {@link axesOfCoordinate} answers for the LEGACY scalar `aligned_to` these
 *  fixtures declare — which ITEM-6's single reader reads as one `full` membership on the
 *  artifact's own declared axis (ITEM-2). The whole entry is asserted, not just the digest:
 *  a resolver that carried the identity and dropped the membership would leave ITEM-9's
 *  figure nothing to be denominated on, and would pass a digest-only assertion. */
function legacyPair(contentHash: string, alignedTo: string) {
  return {
    contentHash,
    alignedTo,
    membership: { alignedTo, axis: 'rows', kind: 'full', declaredOrder: 0 },
  }
}

describe('axesOfCoordinate — the rows a chosen coordinate set declares', () => {
  it('rung 1: a DECLARED alignment names the key artifact, and the answer is its content_hash', () => {
    const catalog = [
      keyArtifact('k-a', KEY_A, DIGEST_A, 'Batch A'),
      keyArtifact('k-b', KEY_B, DIGEST_B, 'Batch B'),
      coords('pos', 'Batch A', 'rows', DIGEST_A),
    ]
    expect(axesOfCoordinate(catalog, 'pos')).toEqual([legacyPair(KEY_A, DIGEST_A)])
  })

  it('rung 1 answers with the DECLARATION, not with the artifact’s own dataset', () => {
    // The negative control that makes the rung real: the positions sit in one dataset and
    // declare alignment to a key sequence published by ANOTHER (an integration reusing a
    // source's keys). A "same dataset wins" shortcut passes rung 1's happy path and fails here.
    const catalog = [
      keyArtifact('k-a', KEY_A, DIGEST_A, 'Batch A'),
      keyArtifact('k-b', KEY_B, DIGEST_B, 'Batch B'),
      coords('pos', 'Batch B', 'rows', DIGEST_A),
    ]
    expect(axesOfCoordinate(catalog, 'pos')).toEqual([legacyPair(KEY_A, DIGEST_A)])
  })

  it('rung 1 REFUSES rather than guesses when the declared digest names nothing', () => {
    const catalog = [keyArtifact('k-a', KEY_A, DIGEST_A, 'Batch A'), coords('pos', 'Batch A', 'rows', 'digest-nobody')]
    expect(axesOfCoordinate(catalog, 'pos')).toEqual([])
  })

  it('rung 2: nothing declared alignment, so the axis INSTANCE is (declared label, own dataset)', () => {
    // Data imported before the importer stamped `aligned_to` declares no alignment at all. Rung
    // 1 answers nothing there, and a pane that then scoped to nothing would list coordinates
    // and never scope anything to them. Both halves of the pair are DECLARATIONS.
    const catalog = [
      keyArtifact('k-a', KEY_A, DIGEST_A, 'Batch A', 'rows'),
      keyArtifact('k-b', KEY_B, DIGEST_B, 'Batch B', 'rows'),
      coords('pos', 'Batch A', 'rows'),
    ]
    expect(axesOfCoordinate(catalog, 'pos')).toEqual([{ contentHash: KEY_A }])
  })

  it('rung 2 does not cross DATASETS — a same-labelled axis next door is not these rows', () => {
    const catalog = [keyArtifact('k-b', KEY_B, DIGEST_B, 'Batch B', 'rows'), coords('pos', 'Batch A', 'rows')]
    expect(axesOfCoordinate(catalog, 'pos')).toEqual([])
  })

  it('AMBIGUITY REFUSES — two key artifacts answering means the pair identified no one thing', () => {
    // Picking either would be `layouts[0]` wearing a join, which is the whole failure mode this
    // pane is written against.
    const catalog = [
      keyArtifact('k-a', KEY_A, DIGEST_A, 'Batch A', 'rows'),
      keyArtifact('k-a2', 'l'.repeat(64), 'digest-a2', 'Batch A', 'rows'),
      coords('pos', 'Batch A', 'rows'),
    ]
    expect(axesOfCoordinate(catalog, 'pos')).toEqual([])
  })

  it('no coordinate, an empty one, and one that is not in the catalog all answer null', () => {
    const catalog = [keyArtifact('k-a', KEY_A, DIGEST_A, 'Batch A'), coords('pos', 'Batch A', 'rows', DIGEST_A)]
    expect(axesOfCoordinate(catalog, null)).toEqual([])
    expect(axesOfCoordinate(catalog, undefined)).toEqual([])
    expect(axesOfCoordinate(catalog, '')).toEqual([])
    expect(axesOfCoordinate(catalog, 'not-in-this-project')).toEqual([])
  })
})
