// THE FRAME, NAMED (visualize-pane ITEM-35 / ITEM-43 / ITEM-19) — covers the naming half of
// TEST-41 (the ▶ names its subject) and of TEST-48/TEST-A8 (a plot carries whose row space it
// is), plus the acceptance pin TEST-A11 (INV-11: describing the frame reads no column body).
//
// The fixtures carry NO domain vocabulary — no dataset, axis or artifact here is named after
// anything biological. An implementation that recognised such a name would pass a fixture that
// used one, which is the tautology these specs exist to avoid.

import { describe, expect, it, vi } from 'vitest'

import type { AxisSummary } from '@/api-client/types'
import { evalExpr, evalWhen } from './expr'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { NO_COORDINATE_LABEL, NO_PANE_FRAME, resolvePaneFrame } from './paneFrame'
import { NO_ANCHOR_REFUSAL, NO_COORDINATE_REFUSAL } from './rowSpaceColumns'

const KEYS_ONE = 'a'.repeat(64)
const KEYS_TWO = 'b'.repeat(64)
const HASH_ONE = 'h1'.repeat(16)
const HASH_TWO = 'h2'.repeat(16)

function row(over: Partial<ArtifactRow>): ArtifactRow {
  return {
    id: 'x',
    project_id: 'p',
    datatype: 'demo/thing',
    structure: {},
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/** The key artifact that IS a row space. Its `content_hash` is the axis's identity; its
 *  `key_sequence_digest` is what an aligned artifact declares. Two namespaces, spelled apart. */
function rowSpace(id: string, contentHash: string, digest: string, dataset?: string): ArtifactRow {
  return row({
    id,
    content_hash: contentHash,
    datatype: 'demo/key',
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', key: 'values', key_sequence_digest: digest },
    ...(dataset ? { source_dataset_id: dataset, source_dataset_name: dataset } : {}),
  })
}

function positions(id: string, name: string, alignedTo?: string): ArtifactRow {
  return row({
    id,
    datatype: 'demo/positions',
    meta: { name },
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', ...(alignedTo ? { aligned_to: alignedTo } : {}) },
  })
}

const axes = (...specs: Array<[string, string, number]>): AxisSummary[] =>
  specs.map(([content_hash, name, length]) => ({ content_hash, name, length }) as AxisSummary)

describe('resolvePaneFrame — the pane’s two identities, and what they are CALLED', () => {
  it('is EMPTY until a row space is anchored (A0)', () => {
    // A0 is not "the frame with blanks in it": nothing is anchored, so there is no frame, and
    // every consumer gates on that before rendering a name.
    expect(resolvePaneFrame(axes([HASH_ONE, 'entities', 10]), [rowSpace('k', HASH_ONE, KEYS_ONE)], null, null)).toEqual(
      NO_PANE_FRAME,
    )
    expect(resolvePaneFrame([], [], undefined, undefined).anchored).toBe(false)
  })

  it('an anchor the catalog cannot find is NOT anchored — never a permissive frame', () => {
    // Answering "here is a frame" for an identity nobody can resolve would put a name on a
    // picture drawn from something else. INV-4: unset propagates as absence.
    const got = resolvePaneFrame(axes([HASH_ONE, 'entities', 10]), [rowSpace('k', HASH_ONE, KEYS_ONE)], [HASH_TWO], null)
    expect(got).toEqual(NO_PANE_FRAME)
  })

  it('names the row space by the join the ANCHOR CONTROL renders from, keyed on content_hash', () => {
    // One derivation, so the control, the ▶'s label and every plot title spell one row space
    // the same way. Two same-LABELLED axes must not become one name (INV-1).
    const artifacts = [rowSpace('k1', HASH_ONE, KEYS_ONE, 'left'), rowSpace('k2', HASH_TWO, KEYS_TWO, 'right')]
    const list = axes([HASH_ONE, 'entities', 10], [HASH_TWO, 'entities', 20])
    const a = resolvePaneFrame(list, artifacts, [HASH_ONE], null)
    const b = resolvePaneFrame(list, artifacts, [HASH_TWO], null)
    expect(a.anchored && b.anchored).toBe(true)
    expect(a.row_space).not.toBe(b.row_space)
    expect(a.row_space_length).toBe(10)
    expect(b.row_space_length).toBe(20)
    // The LABEL is shared, which is exactly why it is not the identity.
    expect(a.row_space_label).toBe(b.row_space_label)
  })

  it('anchored but unframed until a coordinate is chosen — the two are separate gates', () => {
    const got = resolvePaneFrame(axes([HASH_ONE, 'entities', 10]), [rowSpace('k', HASH_ONE, KEYS_ONE)], [HASH_ONE], null)
    expect(got.anchored).toBe(true)
    expect(got.framed).toBe(false)
    expect(got.coordinate).toBeNull()
    expect(got.coordinate_name).toBe('')
  })

  it('names the coordinate by its producer’s own declared name — the ▶’s subject', () => {
    // ITEM-30/ITEM-43: the control has to read "Plot <that>", never "Plot".
    const got = resolvePaneFrame(
      axes([HASH_ONE, 'entities', 10]),
      [rowSpace('k', HASH_ONE, KEYS_ONE), positions('p1', 'projection one', KEYS_ONE)],
      [HASH_ONE],
      'p1',
    )
    expect(got.framed).toBe(true)
    expect(got.coordinate).toBe('p1')
    expect(got.coordinate_name).toBe('projection one')
  })

  // ── the frame's OWN ▶ (ITEM-39/ITEM-43) ────────────────────────────────────────────
  //
  // The bare-frame ▶ used to carry `when: "$data.frame.framed"`, i.e. it VANISHED before a
  // coordinate was chosen. A control that disappears cannot say what is missing, and the
  // user who never opens the coordinate picker never learns the frame is what is absent —
  // the same dead end the colouring rows' silent-wrong-plot defect had, one surface over.
  // So the frame now carries its own refusal, and a LABEL that still names a subject.
  //
  // RED ON REVERT: drop either field from `resolvePaneFrame` and these fail.
  describe('what the frame’s ▶ says when it cannot emit', () => {
    const anchoredAxes = axes([HASH_ONE, 'entities', 10])
    const anchoredOnly = [rowSpace('k', HASH_ONE, KEYS_ONE)]

    it('UNANCHORED: the refusal names the anchor, and the label still names a subject', () => {
      const got = resolvePaneFrame([], [], null, null)
      expect(got.plot_refusal).toBe(NO_ANCHOR_REFUSAL)
      expect(got.coordinate_label).toBe(NO_COORDINATE_LABEL)
      expect(got.coordinate_label).not.toBe('')
    })

    it('UNFRAMED: the refusal names the COORDINATE, which is now the pane\'s ONLY question', () => {
      const got = resolvePaneFrame(anchoredAxes, anchoredOnly, [HASH_ONE], null)
      expect(got.plot_refusal).toBe(NO_COORDINATE_REFUSAL)
      // ── THE TWO SENTENCES ARE NOW ONE, AND THAT IS THE ASSERTION (owner, 2026-08-13) ──
      //
      // This used to require `NO_COORDINATE_REFUSAL !== NO_ANCHOR_REFUSAL`, on ITEM-63's rule
      // that every emptiness says WHICH one it is. There were two emptinesses then, because
      // the pane asked two questions: which rows, and which positions. It asks ONE now — the
      // control that asked which rows is deleted, and the rows are DERIVED from the positions
      // — so "no rows" and "no positions" are not two states a reader can be in. Two different
      // sentences for one state would be the drift this rule exists to catch, pointing the
      // other way: it would send a user looking for a control that does not exist.
      expect(NO_ANCHOR_REFUSAL).toBe(NO_COORDINATE_REFUSAL)
      // A REASON, not a bare disabled control — `unavailableReason`'s contract.
      expect(got.plot_refusal!.length).toBeGreaterThan(20)
      expect(got.plot_refusal).toMatch(/coordinate/i)
      expect(got.coordinate_label).toBe(NO_COORDINATE_LABEL)
    })

    it('FRAMED: no refusal, and the label is the coordinate’s own declared name', () => {
      // The positive control. Without it, "the frame refuses" would also hold for a resolver
      // that refused unconditionally, and the label assertion would prove nothing.
      const got = resolvePaneFrame(
        anchoredAxes,
        [...anchoredOnly, positions('p1', 'projection one', KEYS_ONE)],
        [HASH_ONE],
        'p1',
      )
      expect(got.plot_refusal).toBeNull()
      expect(got.coordinate_label).toBe('projection one')
      expect(got.coordinate_label).toBe(got.coordinate_name)
    })

    it('a coordinate id the catalog no longer holds refuses — absence, never a guess (INV-4)', () => {
      const got = resolvePaneFrame(anchoredAxes, anchoredOnly, [HASH_ONE], 'gone')
      expect(got.plot_refusal).toBe(NO_COORDINATE_REFUSAL)
      expect(got.coordinate_label).toBe(NO_COORDINATE_LABEL)
    })

    // ── the PRESENCE witness, and why a refusal cannot replace it ────────────────────
    //
    // The ▶ is gated on `$data.frame.resolved` as well as on its refusal. That is not
    // belt-and-braces: a FAILED slice contributes no payload, widgets are not unmounted on
    // `error`, and `refusalReason` reads a missing value as "no refusal" — so a control
    // gated only on the refusal is ENABLED on a backend blip and emits with an undefined
    // coordinate. `resolved` is the one field that distinguishes "the frame says no" from
    // "the frame never answered".
    it('EVERY resolved frame is `resolved: true` — including the empty one', () => {
      expect(NO_PANE_FRAME.resolved).toBe(true)
      expect(resolvePaneFrame([], [], null, null).resolved).toBe(true)
      expect(resolvePaneFrame(anchoredAxes, anchoredOnly, [HASH_ONE], null).resolved).toBe(true)
      expect(
        resolvePaneFrame(anchoredAxes, [...anchoredOnly, positions('p1', 'p', KEYS_ONE)], [HASH_ONE], 'p1')
          .resolved,
      ).toBe(true)
    })

    it('an ABSENT frame slice reads falsy on the gate and MISSING on the refusal — the state a refusal alone cannot express', () => {
      // What the renderer actually sees when the slice failed: `$data` has no `frame` key.
      const absent = evalWhen('$data.frame.resolved', { data: {} } as never)
      expect(absent, 'the gate must refuse to offer the control at all').toBe(false)
      // …while the refusal it would otherwise rely on resolves to nothing, which the renderer
      // reads as "no reason to refuse" — i.e. an ENABLED control. This is the assertion that
      // makes the two-gate design necessary rather than decorative.
      expect(evalExpr('$data.frame.plot_refusal', { data: {} } as never)).toBeUndefined()
      // POSITIVE CONTROL: a resolved-but-unframed frame passes the gate AND carries a reason.
      const frame = resolvePaneFrame(anchoredAxes, anchoredOnly, [HASH_ONE], null)
      expect(evalWhen('$data.frame.resolved', { data: { frame } } as never)).toBe(true)
      expect(evalExpr('$data.frame.plot_refusal', { data: { frame } } as never)).toBe(
        NO_COORDINATE_REFUSAL,
      )
    })
  })

  it('a coordinate the catalog no longer holds is UNFRAMED, not a blank-named frame', () => {
    const got = resolvePaneFrame(
      axes([HASH_ONE, 'entities', 10]),
      [rowSpace('k', HASH_ONE, KEYS_ONE)],
      [HASH_ONE],
      'gone',
    )
    expect(got.anchored).toBe(true)
    expect(got.framed).toBe(false)
  })

  // ── REWRITTEN (owner, ledger #28 + #29) ──────────────────────────────────────────────
  //
  // A `describe('the coordinate's own A3 state')` block stood here with three cases, pinning
  // `coordinate_alignment_unknown` + `coordinate_alignment_mark`: the two fields § Coordinates'
  // alert and every emitted plot's `provenanceNote` were bound to. The owner deleted the alert
  // (#28) and then the plot's copy (#29), so the two fields have no consumer and are gone with
  // them.
  //
  // The block is rewritten rather than dropped. Its three cases distinguished A1 / A3 / A2, and
  // exactly ONE of those distinctions still does work: A2 — a coordinate set aligned to a
  // DIFFERENT row space — must not be quietly treated as the same thing as one that simply
  // declares nothing. That distinction is load-bearing for the OFFER (`row_space_columns` drops
  // A2 candidates and keeps A3 ones), and dropping this file's cases wholesale would have left
  // it pinned nowhere near the frame. So what survives is the fact the frame still states: it
  // resolves, it is framed, and it says NOTHING about alignment in any of the three states.
  describe('the frame no longer tells anyone about alignment (ledger #28 + #29)', () => {
    const list = axes([HASH_ONE, 'entities', 10])
    const key = rowSpace('k', HASH_ONE, KEYS_ONE)

    // The three states the deleted block enumerated, driven through the same resolver: aligned
    // to this row space, aligned to nothing, aligned to a different one. Every one of them is a
    // resolved, framed answer that carries no mark — which is the whole of the two ledger rows.
    it.each([
      ['DECLARED alignment to the anchored row space', KEYS_ONE],
      ['UNDECLARED alignment (A3)', undefined],
      ['alignment to a DIFFERENT row space (A2)', KEYS_TWO],
    ])('%s: framed, and silent about it', (_case, alignedTo) => {
      const got = resolvePaneFrame(
        list,
        [key, alignedTo === undefined ? positions('p1', 'proj') : positions('p1', 'proj', alignedTo)],
        [HASH_ONE],
        'p1',
      )
      expect(got.framed).toBe(true)
      expect(got.coordinate).toBe('p1')
      // Over the WHOLE payload, not over the two fields that used to hold it: the ledger row is
      // about the fact reaching a surface, and a third field would satisfy a two-field check.
      expect(JSON.stringify(got).toLowerCase()).not.toContain('alignment')
    })
  })

  it('reads NO column body — the whole frame is producer declarations (INV-11)', () => {
    // The pure resolver takes no read port at all, so the assertion is structural: it is a
    // function of catalog rows, and there is nothing to spy on. The guard that keeps it that
    // way is the slice reader's, and `viewData.test.ts` drives that. What is pinned here is
    // that no global fetch is reachable from this call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('pane_frame must not fetch')
    })
    try {
      resolvePaneFrame(
        axes([HASH_ONE, 'entities', 10]),
        [rowSpace('k', HASH_ONE, KEYS_ONE), positions('p1', 'proj', KEYS_ONE)],
        [HASH_ONE],
        'p1',
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
