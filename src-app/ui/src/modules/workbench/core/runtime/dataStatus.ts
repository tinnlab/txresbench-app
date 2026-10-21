// The declarative DATA-STATUS vocabulary (declarative-rendering-hardening Slice 2, F3 —
// ITEM-1/2/3). One tiny dependency-free module both the RESOLVER (`viewData.ts`) and the
// STORE (`store.ts`) import, so neither has to depend on the other.
//
// Why it exists: before this, a failed slice fetch and a genuinely-empty project were the
// SAME thing to the renderer — `viewData.ts` logged to console and returned `undefined`, and
// `DeclarativeRegion` "rendered structure". A backend-down / permission-denied region was
// pixel-identical to a project that simply hasn't produced anything yet. This module gives
// the engine the four-value vocabulary the region renders against.
//
// It is DOMAIN-AGNOSTIC by construction: every predicate reads the DECLARED spec
// (`data.<slice>.source` / `.args.datatype`), never a processor id or a datatype literal.

import type { DataSourceSpec, ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'

/**
 * The lifecycle of a region's declared data.
 *
 * - `loading`    — a declared slice is being resolved; nothing to paint yet.
 * - `ready`      — data landed (or the view declares no resolvable slice, so there is
 *                  nothing to wait for).
 * - `empty`      — every declared slice resolved to genuinely NO data (no artifact of the
 *                  declared datatype, or a served table with zero rows). Expected, not a
 *                  fault.
 * - `unreadable` — a declared slice's sources were all FOUND and none of them yielded any
 *                  data. The data is there; this client could not decode it.
 * - `error`      — a declared slice FAILED to resolve (query threw, read threw). A fault,
 *                  and the one the user must be able to tell apart from `empty`.
 *
 * WHY `unreadable` IS ITS OWN VALUE, and not a fifth spelling of one of the other four.
 * The vocabulary is closed on purpose and a new member has to name a state the set genuinely
 * lacks; this one does, and it was reachable — measured — on the shipped tree.
 *
 * A slice resolved through the AXIS relation deliberately TOLERATES a per-artifact read
 * failure (`readAxisColumnsFrame`): one unreadable column must not blank a form the other
 * columns can still populate. Nothing named the state where that tolerance consumes
 * EVERYTHING. The frame came back with no columns, which is indistinguishable at the type
 * level from an axis that carries none, so the slice reported `empty` — and `empty` is the
 * one status a view is entitled to make a positive claim about ("this dataset carries no
 * measurements", offering to go and produce them). It was a falsehood about a dataset whose
 * columns were sitting in the catalog. Ranked ABOVE `ready` by `aggregateDataStatus`,
 * because the observed shape is a second slice answering `ready` off the same catalog rows
 * without reading them: worst-of then reported a clean `ready` over a blank form, with every
 * sentence in the view gated on a status and none of them describing this one.
 *
 * WHY `unsupported` IS ITS OWN VALUE — the same bar, met the same way.
 * A view may declare `data.<slice>.source: <name>` that this build has NO READER for: a
 * spec written against a newer app, or simply a typo. That was SILENTLY SKIPPED — the slice
 * contributed no data and no status, so a view whose only slice was unrecognised aggregated
 * to a clean `ready` and rendered widgets bound to `$data.<key>` with nothing in them. A
 * blank surface, reported healthy: the third instance of that class in this lifecycle, after
 * the artifact pane's blank read and the artifact listing's untold status.
 *
 * None of the other five can carry it, and each is wrong in a way that misdirects:
 * `error` says the resolve FAILED (query threw, read threw) — nothing was attempted here,
 * and its copy sends the user to the server ("may be unavailable, or you may not have
 * access"); `unreadable` says the sources were FOUND and opened — none was even located;
 * `empty` makes a positive claim about the project ("run the analysis that produces its
 * input") that is simply false; `ready` is the lie being fixed. It is ranked ABOVE `error`
 * because it is DETERMINISTIC and retrying cannot clear it, while `error` is the retryable
 * one — reporting a transient fault over a build/spec mismatch sends someone to debug a
 * backend that is fine.
 *
 * It does NOT throw and does not suppress the view: `DeclarativeRegion` renders widgets for
 * every status except `loading`, so an app older than its spec keeps working and simply says
 * what it cannot load.
 *
 * It is NOT `error`. `error` is "the resolve failed" — the query threw, the single
 * authoritative artifact a `job.result` slice names threw, the request timed out — where
 * nothing was tolerated and nothing is known. `unreadable` is a COMPLETED resolution with a
 * definite answer: every source was found, every source was opened, none of them gave
 * anything. The two need different sentences, which is the whole reason the vocabulary
 * exists rather than a boolean.
 */
export type DataStatus =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unreadable'
  | 'unsupported'
  /**
   * DATA IS ARRIVING INCREMENTALLY — some rows of a declared slice have landed and more are still
   * coming (incremental-landing ITEM-1). It is NOT `loading` (loading is "nothing to paint yet",
   * and it is the ONE status that unmounts the form): `partial` means there ARE rows on screen,
   * and the point of progressive paint is that the user watches them fill in. It is NOT `ready`
   * (the stream has not completed) and NOT `empty` (there IS data). In the worst-of fold it ranks
   * ABOVE `ready` (a frame that is `ready` on one slice and still arriving on another is still
   * arriving — the user is waiting on data) and above `empty`, but BELOW every genuine fault — a
   * still-arriving slice must never mask an `error`/`unreadable`/`unsupported`/`degraded` the user
   * has to see. The final chunk lands `ready`.
   */
  | 'partial'
  /**
   * BOTH an unsupported slice AND a failing one, at once.
   *
   * ── WHY IT IS A MEMBER AND NOT A RANKING ─────────────────────────────────────────────
   *
   * These two halves want opposite things from the surface. `unsupported` is deterministic,
   * so it deliberately offers NO retry (a Try-again that cannot help) and its copy reassures
   * that *"everything else on this view still works"*. `error` is retryable and must offer
   * one. Folding the pair to either winner suppresses a truth the user needs:
   *
   *   · `unsupported` wins  ⇒ a backend outage is never mentioned and the retry is gone,
   *                           under copy that says the rest is fine. (What shipped.)
   *   · `error` wins        ⇒ a build mismatch is invisible and the user retries something
   *                           retrying cannot clear. (The defect the ranking already refused.)
   *
   * So the mixed state is its own value. Same move as ITEM-39's typed silence: when two
   * states collapse into one rendering, separate them in the TYPE rather than picking a
   * winner — reordering only chooses which truth to lose.
   */
  | 'degraded'

/** A per-slice outcome. `partial` is the one NON-terminal member (more chunks are still coming);
 *  every other value is terminal. Incremental landing lands `partial` per chunk and `ready` on the
 *  last one (incremental-landing ITEM-1). */
type SliceStatus = Extract<
  DataStatus,
  'ready' | 'empty' | 'error' | 'unreadable' | 'unsupported' | 'partial'
>

/** One declared slice's resolution: its terminal status plus, on `ready`, the payload and,
 *  on `error`, a human-readable message the region surfaces in its Alert. */
export interface SliceResolution {
  status: SliceStatus
  payload?: unknown
  error?: string
  /**
   * A HUMAN sentence the surface may show inline, distinct from `error`'s technical string
   * (ITEM-41 / INV-9).
   *
   * The kit's error surface puts `details` behind a "Details" disclosure, deliberately —
   * raw error text must never be the description. But for a refusal the SERVER wrote for a
   * person, the fact the reader needs (WHICH source went missing) was inside that string, so
   * it reached the screen only after a click. INV-9 says name the missing source; the
   * listing half already refuses to hide it in a `title` "a pointer has to find and a touch
   * device never will", and a disclosure is the same bargain.
   *
   * So a resolution may carry the server's own sentence separately from the wrapped
   * technical one. Absent for every failure that has no user-facing sentence to show.
   */
  hint?: string
}

/** The datatype a slice resolves against, taken from the view's DECLARED
 *  `data.<slice>.args.datatype` (INV-6 — the general engine honors the spec, never a
 *  hardcoded processor datatype). A slice that declares no datatype resolves nothing. */
export function sliceDatatype(decl: DataSourceSpec): string | undefined {
  const dt = (decl.args as { datatype?: unknown } | undefined)?.datatype
  return typeof dt === 'string' && dt ? dt : undefined
}

/**
 * Does this view declare at least one slice the resolver can actually go and fetch?
 * (`source: job.result` AND a concrete `datatype`.) A view that declares none has nothing
 * to wait for, so its initial status is `ready` — never a skeleton pinned forever (DEC-3).
 */
export function declaresResolvableData(spec: ViewSpec): boolean {
  for (const decl of Object.values(spec.data ?? {})) {
    if (decl && decl.source === 'job.result' && sliceDatatype(decl)) return true
  }
  return false
}

/**
 * Fold the per-slice resolutions into ONE region status, WORST-OF:
 * `degraded` > `unsupported` > `error` > `unreadable` > `partial` > `ready` > `empty`.
 * (`partial` outranks `ready` — while any slice is still arriving the region is still arriving.)
 *
 * `degraded` is the UNSUPPORTED-AND-ERROR pair, and it is checked first because it is the
 * only state that is not one of its halves — see the `DataStatus` member for why it is a
 * value rather than a ranking decision.
 *
 * `unsupported` outranks even `error` because it is the DETERMINISTIC one: a slice this
 * build has no reader for cannot be cleared by retrying, while an `error` can. Reporting a
 * retryable server fault over a build/spec mismatch sends someone to debug a backend that is
 * working.
 *
 * Any `error` wins (a partial failure is still a failure the user must see); else any
 * `unreadable` wins, because a region may not report a clean `ready` over a blank it cannot
 * explain — that ranking IS the fix, since the observed shape is one slice reading `ready`
 * off the catalog rows beside one that opened them and got nothing; else any `ready` (some
 * data landed); else — if anything was classified at all — `empty`.
 * Nothing classified ⇒ `ready` (see `declaresResolvableData`).
 */
export function aggregateDataStatus(
  parts: ReadonlyArray<Pick<SliceResolution, 'status' | 'error' | 'hint'>>,
): { status: DataStatus; error?: string; hint?: string } {
  const unsupported = parts.find(p => p.status === 'unsupported')
  const failed = parts.find(p => p.status === 'error')
  if (unsupported && failed) {
    // BOTH sentences, error first: it is the actionable half, and the one a retry can clear.
    // Neither is dropped — dropping either is exactly what the two single-winner foldings did.
    const both = [failed.error, unsupported.error].filter(e => e && e.trim() !== '').join(' · ')
    return { status: 'degraded', error: both === '' ? undefined : both }
  }
  if (unsupported) return { status: 'unsupported', error: unsupported.error }
  if (failed) return { status: 'error', error: failed.error }
  const unreadable = parts.find(p => p.status === 'unreadable')
  // The HINT travels with the slice it came from, never merged across slices: two failures
  // have two sentences and picking one at random would attribute the wrong source.
  if (unreadable) return { status: 'unreadable', error: unreadable.error, hint: unreadable.hint }
  // A slice still ARRIVING outranks `ready`: if ANYTHING is still coming, the region is `partial`,
  // even beside a slice that has fully landed — the user is still waiting on data
  // (incremental-landing ITEM-1 / DEC-1). It stays below every fault above.
  if (parts.some(p => p.status === 'partial')) return { status: 'partial' }
  if (parts.some(p => p.status === 'ready')) return { status: 'ready' }
  if (parts.length > 0) return { status: 'empty' }
  return { status: 'ready' }
}

/** Normalize an unknown thrown value to the message the region's Alert shows. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
