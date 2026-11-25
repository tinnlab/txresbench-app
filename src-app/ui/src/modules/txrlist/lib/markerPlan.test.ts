/**
 * single-marker-choice round 2 — the marker-plan slice rule's unit tests
 * (`txrlist/lib/markerPlan.ts`): the client-side port of the server's
 * `marker_rank::markers_slice` + `is_no_list`, the same block the step-4
 * eligibility request carries, plus the companion/main-marker predicates.
 *
 * Pure: no mock, no fetch — the fixtures are the plan block + a method's
 * kind/count pins.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBlock, PlanError } from '@/api-client/types'
import {
  isCompanionKey,
  isNoFixedList,
  mainMarkerKeys,
  planLimit,
  plannedMarkerNames,
} from './markerPlan'

const RANKED: PlanBlock = {
  mode: 'ranked',
  top: ['M2', 'M1', 'M3'],
  offered: ['M2', 'M1', 'M3'],
}

describe('isCompanionKey / mainMarkerKeys', () => {
  it('a __detected/__lod name is a companion, never a main marker', () => {
    expect(isCompanionKey('CEA')).toBe(false)
    expect(isCompanionKey('CEA__detected')).toBe(true)
    expect(isCompanionKey('CEA__lod')).toBe(true)
    expect(isCompanionKey('x__detected_')).toBe(false)
  })

  it('mainMarkerKeys strips the companions and keeps the order', () => {
    expect(
      mainMarkerKeys([
        { key: 'M3' },
        { key: 'M1__detected' },
        { key: 'M1' },
        { key: 'M2__lod' },
      ]),
    ).toEqual(['M3', 'M1'])
  })
})

describe('isNoFixedList / planLimit', () => {
  it('required_markers null and absent are both no-list; a list is fixed', () => {
    expect(isNoFixedList({})).toBe(true)
    expect(isNoFixedList({ required_markers: null })).toBe(true)
    expect(
      isNoFixedList({
        required_markers: { list_source: 'x', markers: [], match: 'all', min_fraction: 0 },
      }),
    ).toBe(false)
  })

  it('the slice limit is the server rule (single 1, multi min(k,5), any/panel 5)', () => {
    expect(planLimit('single', 1)).toBe(1)
    expect(planLimit('multi', 2)).toBe(2)
    expect(planLimit('multi', 7)).toBe(5)
    expect(planLimit('any', 0)).toBe(5)
    expect(planLimit('panel', 49)).toBe(5)
  })
})

describe('plannedMarkerNames', () => {
  it('no plan (or none given) and fixed-list methods get nothing', () => {
    expect(plannedMarkerNames('single', 1, true, null)).toBeNull()
    expect(plannedMarkerNames('single', 1, false, RANKED)).toBeNull()
  })

  it('ranked slices the top: single → 1, multi k → k, any → 5', () => {
    expect(plannedMarkerNames('single', 1, true, RANKED)).toEqual(['M2'])
    expect(plannedMarkerNames('multi', 2, true, RANKED)).toEqual(['M2', 'M1'])
    expect(plannedMarkerNames('any', 0, true, RANKED)).toEqual(['M2', 'M1', 'M3'])
  })

  it('chosen leads with the marker and the ranking follows without it', () => {
    const chosen: PlanBlock = { ...RANKED, mode: 'chosen', marker: 'M1' }
    expect(plannedMarkerNames('single', 1, true, chosen)).toEqual(['M1'])
    expect(plannedMarkerNames('multi', 2, true, chosen)).toEqual(['M1', 'M2'])
    expect(plannedMarkerNames('any', 0, true, chosen)).toEqual(['M1', 'M2', 'M3'])
  })

  it('a chosen marker the file does not carry is never shown (the verdict refuses it)', () => {
    const chosen: PlanBlock = { ...RANKED, mode: 'chosen', marker: 'NOPE' }
    expect(plannedMarkerNames('single', 1, true, chosen, ['M1', 'M2', 'M3'])).toBeNull()
    // Without the mains knowledge the block is taken on trust (the registered
    // action already refused an unknown marker before it was stored).
    expect(plannedMarkerNames('single', 1, true, chosen)).toEqual(['NOPE'])
  })

  it('leave_out and a ranking error give nothing', () => {
    expect(plannedMarkerNames('single', 1, true, { mode: 'leave_out' })).toBeNull()
    const erred: PlanBlock = {
      mode: 'ranked',
      error: { code: 'MARKER_RANKING_TOO_FEW', message: 'no ranking' },
    }
    expect(plannedMarkerNames('single', 1, true, erred)).toBeNull()
  })

  it('an empty plan slice is nothing (nothing to say on the card)', () => {
    const short: PlanBlock = { mode: 'ranked', top: [], offered: [] }
    expect(plannedMarkerNames('single', 1, true, short)).toBeNull()
  })

  it('a ranking error is the plan error (code + message pass through)', () => {
    const error: PlanError = {
      code: 'MARKER_RANKING_NO_OUTCOME',
      message: 'The file has no progression or death times, so the markers cannot be ranked.',
    }
    expect(plannedMarkerNames('multi', 2, true, { mode: 'ranked', error })).toBeNull()
  })
})
