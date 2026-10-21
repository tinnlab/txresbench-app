// selectionRevalidate.ts — THE ONE re-evaluation implementation (ITEM-14 / DEC-22 / DEC-23).
//
// DEC-23 forbids a SECOND IMPLEMENTATION of revalidation, not a second caller. There are two
// callers by necessity and they cannot share a class:
//   - `VizController.revalidateSelection()` / its automatic path — the public, host-facing entry.
//   - the mounted `GridWorkspace` — the only place that can SEE a data/filter/hidden change as it
//     happens, and which holds no reference to the controller.
// Both call `revalidateSelectionIn` below, so the split logic exists exactly once. Putting it in a
// free function rather than on either owner is what makes that structurally true instead of a
// convention someone re-implements later.

import {
  classifyChange,
  deriveSelection,
  type ResolvePane,
} from '../viz-core/selection/provenance'
import { DEFAULT_SELECTION_SPACE } from './Coordination.store'
import type { CoordinationState, CoordinationActions } from './Coordination.store'
import type { VizSelectionContext, VizSelectionOp } from '../viz-core/option/types'

/** The recorded provenance a revalidation works from. */
export interface SelectionProvenanceRecord {
  readonly ops: readonly VizSelectionOp[]
  readonly context?: VizSelectionContext
}

/** Reads the LIVE display context (filters / hidden / per-pane positions hashes) for the panes an op
 *  list touches. Supplied by whoever can see per-cell state. */
export type LiveContextProbe = (prov: SelectionProvenanceRecord) => VizSelectionContext

/** What a revalidation did — `'none'` when nothing moved, `'context'` for a re-partition-only tick,
 *  `'data'` when the geometry actually re-ran. Returned (not just logged) so a caller can assert on
 *  it and so `window.__VIZ_PROV__.lastClassification` can expose it to TEST-24. */
export type RevalidateResult = 'none' | 'context' | 'data' | 'skipped'

/** The last (ops, context) a DERIVE actually ran for, per coordination store.
 *
 *  Only consulted on the empty-selection path, where "the live selection is empty" is ambiguous
 *  between "never derived" (the INV-7 restore window — owes a derive) and "derived, and the answer
 *  IS empty" (e.g. `[add A, subtract A]` — owes nothing). Without it the latter re-runs the full
 *  geometry on every idle tick and never converges, which is how INV-8 was defeatable.
 *
 *  Keyed on the store's own `setSelectionProvenance` action: zustand keeps action identity stable
 *  for the store's lifetime, so the memo is per-instance (INV-11 — two grids cannot share it) and
 *  is collected with the store. */
const derivedFor = new WeakMap<object, string>()

/** A cheap structural signature of the recipe + the context it was derived against. Ops are ~10
 *  vertices, and this is only built on the empty path, so `JSON.stringify` is not a hot cost. */
function signatureOf(ops: readonly VizSelectionOp[], context: VizSelectionContext | undefined): string {
  return JSON.stringify([ops, context ?? null])
}

/**
 * THE INV-8 SPLIT. DEC-19 makes re-evaluation automatic on every change; DEC-20 makes a CONTEXT
 * change provably unable to change the ids. Together they mean re-running the geometry after a
 * filter/hidden tick produces a set that is known in advance to be identical — so the geometry is
 * not merely expensive, it is work whose answer we already have.
 *
 *  - `'data'`    — a pane's positions hash moved ⇒ FULL geometric re-derive (cached ids may point at
 *                  points that no longer exist, so they genuinely must change).
 *  - `'context'` — only filters/hidden moved ⇒ refresh the recorded context and STOP. ZERO
 *                  containment tests, and `ids` keeps its ARRAY IDENTITY — rebuilding an equal array
 *                  would break reference equality for every reactive reader, which is half of what
 *                  TEST-24 asserts.
 *  - `'none'`    — nothing moved ⇒ no work.
 *
 * Landing the automatic trigger WITHOUT this split is the exact regression INV-8 exists to catch: it
 * returns byte-identical CORRECT ids and passes every value assertion, which is why TEST-24 asserts
 * on work performed and object identity rather than on values.
 */
export function revalidateSelectionIn(
  coord: CoordinationState & CoordinationActions,
  resolvePane: ResolvePane,
  liveContext: LiveContextProbe,
): RevalidateResult {
  const prov = coord.selectionProvenance
  if (!prov || prov.ops.length === 0) return 'skipped'

  const live = liveContext(prov)
  const cls = classifyChange(prov.context, live)

  // INV-7 / DEC-9 — the OPS-ONLY RESTORE window. `classifyChange` answers "did anything move since
  // the ids were computed", which presumes ids were EVER computed. They were not: a `'ops-only'`
  // option (DEC-21) carries the recipe and no cache, so the very first tick after a pane resolver
  // appears finds a matching context and would report `'none'` — leaving the restore permanently
  // EMPTY while calling itself fresh. Non-empty ops with an empty live selection is by definition
  // not fresh, so it owes a derive regardless of what moved. TEST-13 is written against exactly
  // this: it asserts a NON-EMPTY restored set.
  //
  // Two ways the first cut of this carve-out defeated INV-8 (audit), both fixed here:
  //
  //   (1) it read ONLY the default space, so a selection living in a NON-DEFAULT space — i.e. EVERY
  //       multi-dataset selection — looked permanently "empty" and re-ran full geometry on every
  //       idle tick while reporting `'data'`. `liveIsEmpty` now considers ALL spaces.
  //   (2) it could not tell "never derived" from "derived, and the answer IS empty" (ops such as
  //       `[add A, subtract A]`), so a legitimately-empty selection re-derived forever and never
  //       converged. `derivedFor` remembers the last recipe+context a derive actually ran for, so
  //       the empty answer converges to `'none'` on the next tick.
  //
  // The memo is keyed on the store's own `setSelectionProvenance` action, which zustand keeps
  // identity-stable for the store's lifetime — so it is per-instance (no cross-instance leakage,
  // INV-11) and is collected with the store.
  const liveIsEmpty =
    (coord.pointSelection?.length ?? 0) === 0 &&
    !Object.values(coord.selectionBySpace ?? {}).some(s => (s?.ids?.length ?? 0) > 0)
  const memoKey = coord.setSelectionProvenance as unknown as object
  const sig = liveIsEmpty ? signatureOf(prov.ops, live) : ''
  if (cls === 'none' && !liveIsEmpty) return 'none'
  if (cls === 'none' && liveIsEmpty && derivedFor.get(memoKey) === sig) return 'none'

  if (cls === 'context') {
    // RE-PARTITION ONLY: record what the user is now looking at, touch nothing else. The ids array
    // is deliberately NOT rewritten — not even to an equal array.
    coord.setSelectionProvenance({ ops: [...prov.ops], context: live })
    return 'context'
  }

  // DATA — the only class that re-runs geometry.
  //
  // DEFER when the panes are not resolvable yet. A geometry op whose pane has no live buffers
  // contributes nothing to `deriveSelection`, so re-deriving mid-reload would publish an EMPTY
  // selection and record the new context — destroying the user's selection and then reporting
  // itself as `'fresh'`. That is the DEC-9 hazard in the DATA path (the INV-7 restore case is the
  // same hazard at hydrate time). Keeping the stale ids and returning `'skipped'` leaves the next
  // tick — the one that has buffers — to do the real work.
  const needsGeometry = prov.ops.some(o => o.tool !== 'ids')
  if (needsGeometry) {
    const anyResolvable = prov.ops.some(o => o.tool !== 'ids' && resolvePane(o.pane) != null)
    if (!anyResolvable) return 'skipped'
  }
  // CONV-14 — the write-back must clear a space the re-derive EMPTIED, not just write the ones it
  // filled. `deriveSelection` populates `bySpace` only via `addTo`, so a space whose recipe now
  // selects nothing gets NO key at all: iterating `Object.entries(bySpace)` alone never visits it
  // and its stale ids survive forever, under a recipe that denotes ∅. That breaks INV-2 ("ops
  // re-derive ids EXACTLY"), is never repaired (the tail records `context: live`, so the next tick
  // is `'none'` while the space still holds ids), and it SERIALIZES — a saved workspace shipping
  // ids its own recipe cannot reproduce.
  //
  // This is the SAME default-space-only asymmetry as CONV-1/CONV-8/CONV-13, on the IDS side rather
  // than the recipe side: the DEFAULT arm below always writes (clearing on empty), the non-default
  // loop only ever wrote. Three recipe-focused sweeps walked straight past it because they were
  // looking at `selectionProvenance`, not at the ids. Snapshot what was live BEFORE the derive so
  // the two sides can be made symmetric.
  const liveSpacesBefore = Object.keys(coord.selectionBySpace ?? {})
  const bySpace = deriveSelection(prov.ops, resolvePane)
  // CONV-18 — a space the derive did not fill is EMPTY only if the derive could actually SEE it.
  // `deriveSelection` SKIPS a pane group whose pane does not resolve (`provenance.ts`: `if (!pane)`),
  // so "no key in `bySpace`" is ambiguous between "the recipe selects nothing there" and "that
  // space's pane was mid-reload and nothing looked". Clearing on the second reading destroys live
  // ids on the strength of a derive that never ran — and the `anyResolvable` guard above is `some`,
  // not `every`, so ONE resolvable pane is enough to reach here while another is still absent.
  // Mirrors CONV-10's all-or-nothing rule on the lift side: an unevaluable group makes its spaces'
  // answers UNUSABLE, not empty. A space no op names is vacuously usable — its recipe genuinely
  // denotes ∅, which is CONV-14's original case and must keep working.
  //
  // CONV-21 — this gates the WRITES as well as the CLEARS. The first cut applied it only where the
  // derive produced no key, which is half the hazard: `deriveSelection` folds PER PANE and unions
  // into the space, so when ONE identity space is named by TWO panes and only one resolves,
  // `bySpace[space]` carries a PARTIAL answer — a key, with half the ids. Writing that is the same
  // "ids destroyed on the strength of a derive that never fully ran" defect, just one step to the
  // left, and equally unrepaired (the tail records the new context, so the next tick is `'none'`).
  // `recordCellProvenance` produces exactly this shape for two grid cells over one dataset. So the
  // predicate is USABILITY of the space's answer, not merely permission to clear it: unusable ⇒
  // leave the space entirely alone and let a later tick, with buffers, do the real work.
  const unevaluable = unevaluableSpaces(prov.ops, resolvePane)
  const usable = (spaceId: string) => !unevaluable.has(spaceId)

  const derivedDefault = bySpace[DEFAULT_SELECTION_SPACE]
  if (usable(DEFAULT_SELECTION_SPACE)) {
    coord.setSelectionInSpace(
      DEFAULT_SELECTION_SPACE,
      null,
      derivedDefault?.length ? Uint32Array.from(derivedDefault) : null,
    )
  }
  for (const [spaceId, ids] of Object.entries(bySpace)) {
    if (spaceId === DEFAULT_SELECTION_SPACE) continue
    if (!usable(spaceId)) continue
    coord.setSelectionInSpace(spaceId, null, ids.length > 0 ? Uint32Array.from(ids) : null)
  }
  // Symmetric with the DEFAULT arm: every space that WAS live and the derive did not fill is now
  // empty, so clear it rather than leaving ids no op explains — but only where every op naming it
  // was evaluable (see `unevaluable` above).
  for (const spaceId of liveSpacesBefore) {
    if (spaceId === DEFAULT_SELECTION_SPACE) continue
    if (!(spaceId in bySpace) && usable(spaceId)) coord.setSelectionInSpace(spaceId, null, null)
  }
  // The recorded context must move with the ids, or the next tick classifies `'data'` forever.
  //
  // ⚠ DO NOT FUSE THIS COMMIT WITH THE `setSelectionInSpace` CALLS ABOVE (CONV-29). They write the
  // ids and the recipe in the same TICK but as SEPARATE action commits, and that separation is
  // load-bearing for invariant A, not incidental tidiness. A fires on a live→empty transition ONLY
  // while the recipe object is reference-unchanged: today the clearing commits transition and are
  // judged, and this recording commit sees no transition. Fusing them into one atomic commit — the
  // obvious "keep the ids and the recorded context symmetric" refactor that CONV-14/CONV-18/CONV-21
  // are three consecutive fixes about — produces a commit that empties the ids AND rewrites the
  // recipe, which A reads as a deliberate `hydrate`-shaped write and does not judge. The result is
  // a recipe describing a set that no longer exists: the DEC-5 lie the assertion exists to prevent,
  // with the assertion silent. `CONV-29 — commit separation` in `Coordination.store.invariant.test`
  // pins this mechanically; see the `assertSelectionInvariants` header for the full analysis.
  coord.setSelectionProvenance({ ops: [...prov.ops], context: live })
  // Remember that a derive RAN for this exact recipe+context. When the answer is legitimately empty
  // this is what lets the next tick return `'none'` instead of re-running the geometry forever.
  derivedFor.set(memoKey, signatureOf(prov.ops, live))
  return 'data'
}

/** The identity spaces whose derived answer is INCOMPLETE — named by at least one pane group that
 *  `deriveSelection` could not evaluate, so `bySpace` carries no verdict for them (CONV-18).
 *
 *  This MIRRORS `deriveSelection`'s own grouping and skip rule deliberately: ops are grouped by
 *  pane (a `null` pane is the programmatic group), and a group is evaluable when its pane resolves
 *  OR every op in it is `tool:'ids'` (a pure-ids group needs no geometry and folds regardless).
 *  Any other group contributes nothing, so a space it names cannot be distinguished from empty —
 *  and must therefore be left alone rather than cleared.
 *
 *  Returning the UNEVALUABLE set (rather than the evaluable one) is what makes a space that NO op
 *  names usable by default: it is absent here, so `usable()` is true and CONV-14's original case —
 *  a recipe that genuinely denotes ∅ for a still-live space — keeps clearing.
 *
 *  CONV-28 — this said `clearable()` until now. CONV-21 renamed that predicate to `usable()` in the
 *  same hunk, precisely because it stopped meaning "permission to clear" and started meaning
 *  "usability of this space's answer" once it gated the WRITE branches too. The stale name pointed
 *  the next reader at the clear-only reading. */
function unevaluableSpaces(
  ops: readonly VizSelectionOp[],
  resolvePane: ResolvePane,
): Set<string> {
  const byPane = new Map<string | null, VizSelectionOp[]>()
  for (const op of ops) {
    const key = op.pane ?? null
    const list = byPane.get(key)
    if (list) list.push(op)
    else byPane.set(key, [op])
  }
  const out = new Set<string>()
  for (const [paneId, paneOps] of byPane) {
    const evaluable = resolvePane(paneId) != null || paneOps.every(o => o.tool === 'ids')
    if (!evaluable) for (const op of paneOps) out.add(op.space)
  }
  return out
}
