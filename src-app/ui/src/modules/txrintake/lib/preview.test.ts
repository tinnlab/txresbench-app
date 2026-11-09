// @vitest-environment node
/**
 * TEST-INT-2 — the screen-B preview lib (PROV-UI-INTAKE-4, ITEM-5): the
 * exact PROV-MC-5 preview body (DEC-5's all-groups-explicit + the
 * unanswered defaults), the fit-count split, the board's descriptive
 * sentence (data-filled template, no hardcoded counts), and the excluded
 * list (cannot_run only, one reason line per method through the
 * CONS-UI-INTAKE-9 shared formatter, the module's fallback for B-unrenderable
 * codes).
 *
 * The reason lines are asserted against the REAL txrlist formatter (the
 * injected `formatters` surface is what the hook binds) — one vocabulary for
 * B and E, with the two deliberate B-side lines (the schedule rule, the
 * fallback) documented in `excludedReasonLine`.
 */
import { describe, expect, it } from 'vitest'
import type {
  EligibilityResponse,
  EligibilityStatus,
  MethodEligibility,
  Reason,
  ReasonCode,
} from '@/api-client/types'
import { formatReasonLine } from '@/modules/txrlist/lib/format'
import {
  EXCLUDED_LIST_LIMIT,
  PREVIEW_REASON_FALLBACK,
  diseaseClause,
  groupShortName,
  leftOutHeading,
  outcomeClause,
  someFitLine,
  fitHeading,
} from './format'
import {
  buildStudyPreviewRequest,
  descriptiveSentence,
  excludedMethods,
  fitCounts,
  type FitCounts,
  type TxrPreviewFormatters,
} from './preview'
import type { StudyAnswers } from '../types'

/** The provider's 7 board group ids (CONS-UI-INTAKE-1, stable set). */
const GROUP_IDS = [
  'ctdna',
  'counts',
  'ldh',
  'tumour-markers',
  'inflammation',
  'methylation-sequencing',
  'other',
]

const GROUPS = GROUP_IDS.map(id => ({ id, display_name: id }))

const EMPTY_ANSWERS: StudyAnswers = {
  disease: null,
  treatment: null,
  outcome: null,
  markerGroups: null,
  beforeTreatment: null,
  drawsDuringTreatment: null,
  lastDrawDay: null,
}

const FULL_ANSWERS: StudyAnswers = {
  disease: 'colorectal',
  treatment: 'immunotherapy',
  outcome: 'progression-by-day',
  markerGroups: { ctdna: true, counts: true, ldh: true },
  beforeTreatment: 'always',
  drawsDuringTreatment: 2,
  lastDrawDay: 56,
}

/** The shared formatter surface the hook binds (the real txrlist function). */
const FORMATTERS: TxrPreviewFormatters = { formatReasonLine }

function method(
  id: string,
  status: EligibilityStatus,
  reasons: Reason[],
  partial: Partial<MethodEligibility> = {},
): MethodEligibility {
  return {
    id,
    status,
    reasons: [...reasons],
    coverage: { eligible: 0, total: 1, fraction: 0 },
    min_draws: { required: 3, met: 0, unmet_patients: 0 },
    missing_markers: [],
    missing_groups: [],
    estimated_seconds: 0,
    estimate_quality: 'estimate',
    ...partial,
  }
}

function response(methods: MethodEligibility[]): EligibilityResponse {
  const total_fit = methods.filter(m => m.status === 'can_run').length
  const total_some = methods.filter(m => m.status === 'can_run_some').length
  const total_cannot = methods.filter(m => m.status === 'cannot_run').length
  return { methods, total_fit, total_some, total_cannot, total_no_env: 0 }
}

describe('buildStudyPreviewRequest (TEST-INT-2)', () => {
  it('emits ALL group ids with explicit booleans, checkboxes verbatim (DEC-5)', () => {
    const req = buildStudyPreviewRequest(FULL_ANSWERS, GROUPS)
    expect(Object.keys(req.marker_groups as Record<string, boolean>).sort()).toEqual(
      [...GROUP_IDS].sort(),
    )
    expect(req.marker_groups).toEqual({
      ctdna: true,
      counts: true,
      ldh: true,
      'tumour-markers': false,
      inflammation: false,
      'methylation-sequencing': false,
      other: false,
    })
    expect(req.before_treatment).toBe('always')
    expect(req.draws_during_treatment).toBe(2)
    expect(req.last_draw_day).toBe(56)
  })

  it('defaults the unanswered schedule: last draw 56 (DEC-5), board first options otherwise', () => {
    const req = buildStudyPreviewRequest(EMPTY_ANSWERS, GROUPS)
    expect(req).toEqual({
      marker_groups: {
        ctdna: false,
        counts: false,
        ldh: false,
        'tumour-markers': false,
        inflammation: false,
        'methylation-sequencing': false,
        other: false,
      },
      before_treatment: 'always',
      draws_during_treatment: 1,
      last_draw_day: 56,
    })
  })
})

describe('fitCounts + panel copy (TEST-INT-2/13)', () => {
  it('derives the count split from the response totals', () => {
    const r = response([
      method('m-a', 'can_run', []),
      method('m-b', 'can_run_some', [{ code: 'MIN_DRAWS_UNMET' }]),
      method('m-c', 'cannot_run', [{ code: 'MARKER_GROUP_MISSING' }]),
    ])
    expect(fitCounts(r)).toEqual({ total: 3, canRun: 1, some: 1, cannot: 1 })
  })

  it('renders the board headline + left-out copy from the split, never a literal count', () => {
    const fit: FitCounts = { total: 39, canRun: 22, some: 4, cannot: 13 }
    expect(fitHeading(fit)).toBe('22 of 39 methods fit')
    expect(leftOutHeading(fit)).toBe('13 methods are left out')
    expect(someFitLine(fit)).toBe('4 can run for some patients')
  })
})

describe('descriptiveSentence (TEST-INT-2/examples)', () => {
  it('renders the board sentence data-filled (the pinned acceptance string)', () => {
    expect(descriptiveSentence(FULL_ANSWERS)).toBe(
      'for colorectal cancer, risk by a day, with ctDNA, blood counts and LDH. This updates as you answer.',
    )
  })

  it('renders only the answered clauses', () => {
    expect(
      descriptiveSentence({
        ...EMPTY_ANSWERS,
        outcome: 'response-probability',
        markerGroups: { ldh: true },
      }),
    ).toBe('the chance of response, with LDH. This updates as you answer.')
    expect(
      descriptiveSentence({
        ...EMPTY_ANSWERS,
        disease: 'breast',
        outcome: 'dynamic-risk',
        markerGroups: { counts: true, ctdna: true },
      }),
    ).toBe('for breast cancer, risk over time, with blood counts and ctDNA. This updates as you answer.')
  })

  it('distinguishes "nothing answered" from "no marker group checked"', () => {
    expect(descriptiveSentence(EMPTY_ANSWERS)).toBe('This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, markerGroups: { ctdna: false, counts: false } }),
    ).toBe('with no marker groups. This updates as you answer.')
  })

  it('has no hardcoded counts (FLOW.md design-example rule)', () => {
    const sentence = descriptiveSentence(FULL_ANSWERS)
    for (const digit of ['0', '1', '2', '9', '28', '38', '56', '84']) {
      expect(sentence).not.toContain(digit)
    }
  })
})

describe('excludedMethods (TEST-INT-2)', () => {
  it('lists only the cannot_run verdicts, in response order, with one reason each', () => {
    const r = response([
      method('m-a', 'can_run', []),
      method('m-b', 'cannot_run', [{ code: 'MARKER_GROUP_MISSING' }], {
        missing_groups: [{ group_id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' }],
      }),
      method('m-c', 'cannot_run', [{ code: 'MIN_DRAWS_UNMET' }], {
        min_draws: { required: 3, met: 0, unmet_patients: 0 },
      }),
      method('m-d', 'can_run_some', [{ code: 'MIN_DRAWS_UNMET' }]),
    ])
    expect(excludedMethods(r, FORMATTERS).map(m => m.id)).toEqual(['m-b', 'm-c'])
    expect(excludedMethods(r, FORMATTERS)[0]).toEqual({
      id: 'm-b',
      reasonText: 'needs markers from: Tumour DNA in blood (ctDNA)',
    })
    expect(excludedMethods(r, FORMATTERS)[1]).toEqual({ id: 'm-c', reasonText: 'needs 3 or more draws' })
  })

  it('renders the shared formatter line for a required marker (board bytes)', () => {
    const r = response([
      method('ki67-two-week-four-group', 'cannot_run', [{ code: 'REQUIRED_MARKER_MISSING' }], {
        missing_markers: [
          { id: 'ki67', id_system: 'other', display_name: 'Ki-67', group_id: 'other' },
        ],
      }),
    ])
    expect(excludedMethods(r, FORMATTERS)[0].reasonText).toBe('needs Ki-67, not in your file')
  })

  it('renders the shared formatter line for the detection-call rule (E-vocabulary bytes)', () => {
    const r = response([
      method('cox-ctdna-status-rfs', 'cannot_run', [{ code: 'DETECTION_CALL_MISSING' }]),
    ])
    expect(excludedMethods(r, FORMATTERS)[0].reasonText).toBe(
      'needs a detection-call marker, not in your file',
    )
  })

  it('emits the module fallback for a per-patient-only or foreign reason code', () => {
    const r = response([
      method('dyn-per-day', 'cannot_run', [{ code: 'DECISION_DAY_UNMET' }]),
      method('future-m', 'cannot_run', [{ code: 'FUTURE_CODE' as ReasonCode }]),
    ])
    expect(excludedMethods(r, FORMATTERS).map(m => m.reasonText)).toEqual([
      PREVIEW_REASON_FALLBACK,
      PREVIEW_REASON_FALLBACK,
    ])
  })

  it('exposes the board clip limit (Show all N lives at the page, N = the list length)', () => {
    expect(EXCLUDED_LIST_LIMIT).toBe(6)
    const many = Array.from({ length: EXCLUDED_LIST_LIMIT + 2 }, (_, i) =>
      method(`m-${i}`, 'cannot_run', [{ code: 'MIN_DRAWS_UNMET' }]),
    )
    expect(excludedMethods(response(many), FORMATTERS)).toHaveLength(EXCLUDED_LIST_LIMIT + 2)
  })
})

describe('label helpers (TEST-INT-13 rows for this item)', () => {
  it('option text is board verbatim', () => {
    expect(diseaseClause('colorectal')).toBe('colorectal cancer')
    expect(outcomeClause('progression-by-day')).toBe('risk by a day')
    expect(groupShortName('ctdna')).toBe('ctDNA')
    expect(groupShortName('counts')).toBe('blood counts')
    expect(groupShortName('ldh')).toBe('LDH')
    expect(groupShortName('unknown-group')).toBe('unknown-group')
  })
})
