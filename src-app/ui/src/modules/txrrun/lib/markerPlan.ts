/**
 * txrrun — the step-4 marker plan facts (single-marker-choice round 2).
 *
 * The step-4 page calls the ranking route (the SAME parsed tables the run
 * request carries + the endpoint, decision day and the person's choice) and
 * uses its answer twice:
 *
 * - the `marker_plan` block is copied onto the eligibility request (mode +
 *   marker + top/offered + error), so the verdicts match the run;
 * - the one line above the method list renders the choice's sentence (or the
 *   route's no-ranking message, or "Ranking your markers…" while it loads).
 *
 * This file is the pure part; `data/useMarkerRanking.ts` is the debounced
 * fetch.
 */
import type {
  MarkerRankingResponse,
  MarkerRankingRequest,
  PlanBlock,
  SingleMarkerChoice,
} from '@/api-client/types'
import type { TxrMethodCard } from '@/modules/txrlist'
import { MARKER_TOP_N } from '@/modules/txrlist/lib/markerPlan'

/** The waiting line (the method list does not wait for the ranking). */
export const MARKER_RANKING_WAITING = 'Ranking your markers…'

/**
 * Whether the ranking route answered with its response OBJECT (round 2c).
 * The plan readers touch `response.top.length` / `response.top[0]` at render
 * time, so the transport's crash-safe fallbacks (the gallery mock's `[]` for
 * an unseeded endpoint, an empty body) would THROW inside the render and
 * unmount the page. Such an answer is NOT a response: the caller treats it
 * exactly like a failed call — no plan (the eligibility keeps today's count
 * rule) and no ranked line. The two list fields the plan reads decide the
 * shape.
 */
export function isMarkerRankingResponse(value: unknown): value is MarkerRankingResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as MarkerRankingResponse).top) &&
    Array.isArray((value as MarkerRankingResponse).offered)
  )
}

/** "Change it in step 3" — the existing registered step-navigation link text
 *  (round 2's line tail; the link runs the step-navigation action, never a
 *  new route). */
export const MARKER_CHANGE_IT = 'Change it in step 3'

/** One rendered line: the sentence part + whether the step-3 link applies
 *  (the line's mode sentences say "Change it in step 3"; the waiting line
 *  and the route's no-ranking message do not). */
export interface MarkerLine {
  text: string
  changeable: boolean
}

/**
 * The `marker_plan` block copied from the ranking route's answer: mode +
 * marker (for `chosen`) + the route's `top`/`offered` + the `error` when
 * there is no ranking result. Absent `top`/`offered`/`error` are omitted
 * (`leave_out` and an error carry no markers; the server reads an absent
 * block field as empty).
 */
export function planBlockOf(
  choice: SingleMarkerChoice,
  response: MarkerRankingResponse,
): PlanBlock {
  const block: PlanBlock = choice.mode === 'chosen' ? { mode: 'chosen', marker: choice.marker } : { mode: choice.mode }
  if (response.top.length > 0) block.top = response.top
  if (response.offered.length > 0) block.offered = response.offered
  if (response.error !== undefined) block.error = response.error
  return block
}

/**
 * The marker-plan field of the eligibility request: the plan block once the
 * ranking has SETTLED, `undefined` while it loads or after a fetch failure
 * (the server then keeps today's count rule for that brief window — a stale
 * plan for the OLD endpoint/day would be worse than none). The one refusal
 * that is KNOWN without any ranking still rides: `leave_out` (the choice
 * itself is the refusal — the block needs no markers), and a ranking error
 * when the route answered it (the block carries the error).
 */
export function eligibilityMarkerPlan(
  choice: SingleMarkerChoice,
  response: MarkerRankingResponse | null,
  loading: boolean,
): PlanBlock | undefined {
  if (loading) return undefined
  // `== null` covers a broken client answering `undefined` (the hook's type
  // says null; an undefined answer is the same "no result"). A MALFORMED
  // answer (round 2c) is no result either — a marker-only ranked block would
  // flip a multi method to a one-marker slice the ranking never computed.
  if (response != null && isMarkerRankingResponse(response)) return planBlockOf(choice, response)
  // A fetch failure with no answer: `leave_out` is known without the ranking;
  // `ranked`/`chosen` are not (a marker-only chosen block would flip a multi
  // method to a one-marker slice the ranking never computed).
  if (choice.mode === 'leave_out') return { mode: 'leave_out' }
  return undefined
}

/** The shown no-list kinds of the cards (the line's parts decision). */
export interface ShownMarkerKinds {
  /** A shown no-list `single` method. */
  single: boolean
  /** A shown no-list `multi` / `any` / `panel` method. */
  many: boolean
  /** A shown no-list `any` / `panel` method (the top 5 kinds). */
  anyLike: boolean
  /** The largest `multi` count among shown no-list cards (0 when none). */
  multiCount: number
}

/** What the cards on screen say about the no-list kinds. */
export function shownMarkerKinds(cards: ReadonlyArray<TxrMethodCard>): ShownMarkerKinds {
  let single = false
  let many = false
  let anyLike = false
  let multiCount = 0
  for (const card of cards) {
    if (!card.needs.noFixedList) continue
    if (card.needs.markerKind === 'single') single = true
    else if (card.needs.markerKind === 'multi') {
      many = true
      multiCount = Math.max(multiCount, card.needs.markerCount ?? 0)
    } else if (card.needs.markerKind !== undefined) {
      many = true
      anyLike = true
    }
  }
  return { single, many, anyLike, multiCount }
}

/** The plain join ("a, b and c" — the board's list bytes). */
function joinList(parts: ReadonlyArray<string>): string {
  const kept = parts.filter(part => part.trim().length > 0)
  if (kept.length <= 1) return kept.join('')
  return `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`
}

/** The fragment after "use " in the ranked sentence, by the shown kinds. */
function rankedUsePart(
  kinds: ShownMarkerKinds,
  ranked: ReadonlyArray<string>,
): string | null {
  const m1 = ranked[0]
  if (m1 === undefined) return null
  if (kinds.single && kinds.many) {
    const k = markerTopK(kinds)
    const rest = ranked.slice(0, k)
    return `use ${m1} (one marker) and up to the top ${k}: ${joinList(rest)}`
  }
  if (kinds.single) return `use ${m1}`
  const k = markerTopK(kinds)
  const names = ranked.slice(0, k)
  if (names.length === 0) return null
  return `use the top ${k}: ${joinList(names)}`
}

/** The "top k" the many-only sentence names: 5 for an `any`/`panel` card,
 *  the largest `multi` count otherwise (a declared k is given exactly k —
 *  never capped at 5). */
function markerTopK(kinds: ShownMarkerKinds): number {
  return Math.max(kinds.anyLike ? MARKER_TOP_N : 0, Math.max(1, kinds.multiCount))
}

/**
 * The line above the method list (the brief's bytes, `txr-run-single-marker-line`):
 *
 * - nothing when no shown method has no fixed list (the line is about the
 *   methods the plan affects);
 * - "Ranking your markers…" while the ranking is loading (the list does not
 *   wait);
 * - the route's no-ranking message when the ranking has none (the three
 *   texts; even a `chosen` plan reads it — the reasons replace the fallback);
 * - otherwise the mode's sentence ("ranked" / "chosen" / "left out"), with
 *   the "(one marker)" and "up to the top N" parts only for the kinds shown
 *   (N = the largest count a shown kind receives — 5 for an `any`/`panel`
 *   card, the largest `multi` count otherwise).
 *
 * The sentence part carries no "Change it in step 3" tail — the renderer
 * appends it as the registered step-navigation link (`changeable: true`).
 * `null` = no line (nothing shown to match).
 */
export function markerLineText(
  choice: SingleMarkerChoice,
  response: MarkerRankingResponse | null,
  loading: boolean,
  cards: ReadonlyArray<TxrMethodCard>,
  outcomeWord: string,
): MarkerLine | null {
  const kinds = shownMarkerKinds(cards)
  if (!kinds.single && !kinds.many) return null
  if (loading) return { text: MARKER_RANKING_WAITING, changeable: false }
  // No answer (a failed call) or a MALFORMED answer (round 2c): no line — the
  // route's no-ranking message only applies when the route itself answered it.
  if (response == null || !isMarkerRankingResponse(response)) return null
  if (response.error !== undefined && response.error !== null) {
    return { text: response.error.message, changeable: false }
  }
  if (choice.mode === 'leave_out') {
    return {
      text: 'Methods that pick markers from your file are left out.',
      changeable: true,
    }
  }
  const top = response.top
  // The ranked slice reads the OFFERED order (a multi k above 5 gets its k;
  // the route's `top` is only the display's first five).
  const ranked = response.offered.length > 0 ? response.offered : response.top
  if (choice.mode === 'chosen') {
    const chosen = choice.marker
    if (chosen === undefined) return null
    if (!kinds.many) {
      return {
        text: `Methods that pick markers from your file use ${chosen}, your choice.`,
        changeable: true,
      }
    }
    const rest = ranked.filter(marker => marker !== chosen)
    const ranking = rest.length > 0 ? `, then the ranking: ${joinList(rest)}` : ''
    return {
      text: `Methods that pick markers from your file use ${chosen}, your choice${ranking}.`,
      changeable: true,
    }
  }
  const usePart = rankedUsePart(kinds, ranked)
  if (usePart === null) return null
  return {
    text: `Methods that pick markers from your file ${usePart}, ranked by how well each separates ${outcomeWord} in your patients.`,
    changeable: true,
  }
}
