// @vitest-environment node
/**
 * txrrun step-4 marker-plan facts (single-marker-choice round 2) — the pure
 * half of the ranking's two uses: the `marker_plan` block copied onto the
 * eligibility request and the one line above the method list.
 */
import { describe, expect, it } from 'vitest'
import type {
  MarkerRankingResponse,
  SingleMarkerChoice,
} from '@/api-client/types'
import type { TxrMethodCard } from '@/modules/txrlist'
import {
  eligibilityMarkerPlan,
  MARKER_CHANGE_IT,
  MARKER_RANKING_WAITING,
  markerLineText,
  planBlockOf,
  shownMarkerKinds,
} from './markerPlan'

/** One ranking-route answer (the facts the line/block read). */
function ranking(over: Partial<MarkerRankingResponse> = {}): MarkerRankingResponse {
  return {
    error: undefined,
    markers_by_kind: { any: [], multi: {}, single: [] },
    offered: [],
    ranking: [],
    ranking_patients: 0,
    top: [],
    ...over,
  }
}

/** One synthetic card (the facts the line reads). */
function card(over: Partial<TxrMethodCard> & { id: string }): TxrMethodCard {
  const { id, ...rest } = over
  return {
    key: id,
    id,
    title: id,
    summary: `Summary of ${id}.`,
    paperTitle: null,
    group: 'response-probability',
    groupLabel: 'Response probability',
    language: 'R',
    journal: 'Fixture Journal',
    year: 2020,
    paperDoi: '',
    estimate: { seconds: 120, quality: 'measured' },
    rank: null,
    needs: { markers: '1 marker', covariates: null, covariatesMode: 'none', draws: '1+ draws' },
    run: {
      status: 'can',
      coverageLine: 'all 151 patients',
      reasonCode: null,
      reasonLine: 'all 151 patients',
      reasonLines: ['all 151 patients'],
      reasonFix: '',
      disabled: false,
    },
    ...rest,
  }
}

/** A shown no-list `single` card. */
const singleCard = () =>
  card({
    id: 's',
    needs: {
      markers: '1 marker',
      covariates: null,
      covariatesMode: 'none',
      draws: '1+ draws',
      markerKind: 'single',
      markerCount: 1,
      noFixedList: true,
      markersUsed: null,
    },
  })

/** A shown no-list `multi` k card. */
const multiCard = (k: number) =>
  card({
    id: `m${k}`,
    needs: {
      markers: `${k} markers`,
      covariates: null,
      covariatesMode: 'none',
      draws: '1+ draws',
      markerKind: 'multi',
      markerCount: k,
      noFixedList: true,
      markersUsed: null,
    },
  })

/** A shown no-list `any` card. */
const anyCard = () =>
  card({
    id: 'a',
    needs: {
      markers: 'any markers',
      covariates: null,
      covariatesMode: 'none',
      draws: '1+ draws',
      markerKind: 'any',
      markerCount: 2,
      noFixedList: true,
      markersUsed: null,
    },
  })

/** A fixed-list card (the plan never touches it). */
const fixedCard = () =>
  card({
    id: 'f',
    needs: {
      markers: '3 markers',
      covariates: null,
      covariatesMode: 'none',
      draws: '1+ draws',
      markerKind: 'panel',
      markerCount: 3,
      noFixedList: false,
      markersUsed: null,
    },
  })

const RANKED: SingleMarkerChoice = { mode: 'ranked' }
const CHOSEN: SingleMarkerChoice = { mode: 'chosen', marker: 'ctdna_mm' }
const LEAVE_OUT: SingleMarkerChoice = { mode: 'leave_out' }

describe('planBlockOf + eligibilityMarkerPlan', () => {
  it('copies mode + marker + top/offered/error onto the plan block, absent ones omitted', () => {
    const answer = ranking({
      top: ['ctdna_mm', 'ldh'],
      offered: ['ctdna_mm', 'ldh', 'cea'],
    })
    expect(planBlockOf(CHOSEN, answer)).toEqual({
      mode: 'chosen',
      marker: 'ctdna_mm',
      top: ['ctdna_mm', 'ldh'],
      offered: ['ctdna_mm', 'ldh', 'cea'],
    })
    // leave_out carries no markers; a ranked answer's top rides the block.
    expect(planBlockOf(LEAVE_OUT, answer)).toEqual({
      mode: 'leave_out',
      top: ['ctdna_mm', 'ldh'],
      offered: ['ctdna_mm', 'ldh', 'cea'],
    })
    expect(planBlockOf(RANKED, ranking({ top: [], offered: [] }))).toEqual({ mode: 'ranked' })
  })

  it('the eligibility plan is undefined while loading and after a failure (never a stale plan)', () => {
    expect(eligibilityMarkerPlan(CHOSEN, null, true)).toBeUndefined()
    expect(eligibilityMarkerPlan(CHOSEN, null, false)).toBeUndefined()
  })

  it('the eligibility plan is the block once the ranking settles', () => {
    expect(eligibilityMarkerPlan(CHOSEN, ranking({ top: ['ctdna_mm'] }), false)).toEqual({
      mode: 'chosen',
      marker: 'ctdna_mm',
      top: ['ctdna_mm'],
    })
  })

  it('leave_out and a ranking error are known refusals — their blocks ride even without a ranking', () => {
    expect(eligibilityMarkerPlan(LEAVE_OUT, null, false)).toEqual({ mode: 'leave_out' })
    const failed = ranking({ error: { code: 'MARKER_RANKING_TOO_FEW', message: 'Fewer than 10 patients…' } })
    expect(eligibilityMarkerPlan(CHOSEN, failed, false)).toEqual({
      mode: 'chosen',
      marker: 'ctdna_mm',
      error: { code: 'MARKER_RANKING_TOO_FEW', message: 'Fewer than 10 patients…' },
    })
  })
})

describe('shownMarkerKinds', () => {
  it('reads the shown no-list kinds off the cards (fixed-list cards ignored)', () => {
    expect(shownMarkerKinds([fixedCard(), singleCard()])).toEqual({
      single: true,
      many: false,
      anyLike: false,
      multiCount: 0,
    })
    expect(shownMarkerKinds([multiCard(2), multiCard(7), singleCard()])).toEqual({
      single: true,
      many: true,
      anyLike: false,
      multiCount: 7,
    })
    expect(shownMarkerKinds([anyCard()])).toEqual({ single: false, many: true, anyLike: true, multiCount: 0 })
    expect(shownMarkerKinds([fixedCard()])).toEqual({ single: false, many: false, anyLike: false, multiCount: 0 })
  })
})

describe('markerLineText', () => {
  const TOP = ['ctdna_mm', 'ldh', 'cea', 'ca19_9', 'albumin']

  it('renders nothing when no shown method has no fixed list (the line is about the plan)', () => {
    expect(markerLineText(RANKED, ranking({ top: TOP }), false, [fixedCard()], 'progression')).toBeNull()
  })

  it('renders the waiting line while the ranking is loading (the list does not wait)', () => {
    const line = markerLineText(RANKED, null, true, [singleCard()], 'progression')
    expect(line).toEqual({ text: MARKER_RANKING_WAITING, changeable: false })
  })

  it('renders nothing after a failure with no response (the list keeps its verdicts)', () => {
    expect(markerLineText(RANKED, null, false, [singleCard()], 'progression')).toBeNull()
  })

  it('renders the route no-ranking message, never changeable', () => {
    const failed = ranking({
      error: {
        code: 'MARKER_RANKING_TOO_FEW',
        message: 'Fewer than 10 patients have a draw before and during treatment and a known outcome by day 56, so the markers cannot be ranked.',
      },
    })
    const line = markerLineText(CHOSEN, failed, false, [multiCard(2)], 'death')
    expect(line).toEqual({
      text: 'Fewer than 10 patients have a draw before and during treatment and a known outcome by day 56, so the markers cannot be ranked.',
      changeable: false,
    })
  })

  it('leave_out: one sentence, changeable', () => {
    expect(markerLineText(LEAVE_OUT, ranking({ top: TOP }), false, [singleCard()], 'death')).toEqual({
      text: 'Methods that pick markers from your file are left out.',
      changeable: true,
    })
  })

  it('chosen + single-only: the choice, no ranking tail', () => {
    const line = markerLineText(CHOSEN, ranking({ top: TOP }), false, [singleCard()], 'death')
    expect(line).toEqual({
      text: 'Methods that pick markers from your file use ctdna_mm, your choice.',
      changeable: true,
    })
  })

  it('chosen + multi/any shown: the chosen marker, then the ranking without it', () => {
    const line = markerLineText(CHOSEN, ranking({ top: TOP }), false, [multiCard(3)], 'death')
    expect(line).toEqual({
      text: 'Methods that pick markers from your file use ctdna_mm, your choice, then the ranking: ldh, cea, ca19_9 and albumin.',
      changeable: true,
    })
  })

  it('ranked + single only: "use {m1}" without the count parts', () => {
    const line = markerLineText(RANKED, ranking({ top: TOP }), false, [singleCard()], 'death')
    expect(line).toEqual({
      text: 'Methods that pick markers from your file use ctdna_mm, ranked by how well each separates death in your patients.',
      changeable: true,
    })
  })

  it('ranked + multi only: "use the top {k}" with the largest shown multi count', () => {
    const line = markerLineText(RANKED, ranking({ top: TOP }), false, [multiCard(2), multiCard(3)], 'death')
    expect(line).toEqual({
      text: 'Methods that pick markers from your file use the top 3: ctdna_mm, ldh and cea, ranked by how well each separates death in your patients.',
      changeable: true,
    })
  })

  it('ranked + any/panel shown: the top 5 (any takes what is ranked)', () => {
    const line = markerLineText(RANKED, ranking({ top: TOP }), false, [anyCard()], 'death')
    expect(line).toEqual({
      text: 'Methods that pick markers from your file use the top 5: ctdna_mm, ldh, cea, ca19_9 and albumin, ranked by how well each separates death in your patients.',
      changeable: true,
    })
  })

  it('ranked + single and multi both shown: "(one marker) and up to the top 5"', () => {
    const line = markerLineText(RANKED, ranking({ top: TOP }), false, [singleCard(), multiCard(2)], 'progression')
    expect(line).toEqual({
      text: 'Methods that pick markers from your file use ctdna_mm (one marker) and up to the top 5: ctdna_mm, ldh, cea, ca19_9 and albumin, ranked by how well each separates progression in your patients.',
      changeable: true,
    })
  })

  it('the changeable link text is the registered step-navigation label', () => {
    expect(MARKER_CHANGE_IT).toBe('Change it in step 3')
  })
})

describe('round 2c: a malformed ranking answer never throws or fabricates a plan', () => {
  // The gallery mock's no-cassette answer is the empty ARRAY (a
  // crash-safe fallback shape); the old readers would throw
  // (`response.top.length` / `top[0]`) inside the render and take the
  // whole page down.
  const malformed = [] as unknown as MarkerRankingResponse

  it('eligibilityMarkerPlan treats it like a failed call: no plan, leave_out still known', () => {
    expect(eligibilityMarkerPlan(RANKED, malformed, false)).toBeUndefined()
    expect(eligibilityMarkerPlan(CHOSEN, malformed, false)).toBeUndefined()
    expect(eligibilityMarkerPlan(LEAVE_OUT, malformed, false)).toEqual({ mode: 'leave_out' })
  })

  it('markerLineText renders nothing (the route never answered)', () => {
    expect(markerLineText(RANKED, malformed, false, [singleCard()], 'progression')).toBeNull()
    expect(markerLineText(CHOSEN, malformed, false, [multiCard(2)], 'death')).toBeNull()
  })
})
