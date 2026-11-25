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
  FilterOptions,
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
  scheduleClause,
  someFitLine,
  treatmentClause,
  fitHeading,
} from './format'
import {
  buildStudyPreviewRequest,
  descriptiveSentence,
  excludedGroupCode,
  excludedMethods,
  excludedReasonLine,
  fitCounts,
  groupExcludedMethods,
  hasStudyAnswers,
  PREVIEW_ANSWER_INVITE,
  type ExcludedMethod,
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
  treatments: null,
  outcome: null,
  markerGroups: null,
  beforeTreatment: null,
  drawsDuringTreatment: null,
  lastDrawDay: null,
}

const FULL_ANSWERS: StudyAnswers = {
  disease: 'colorectal cancer',
  treatments: ['immune checkpoint inhibitor'],
  outcome: 'progression-by-day',
  markerGroups: { ctdna: true, counts: true, ldh: true },
  beforeTreatment: 'always',
  drawsDuringTreatment: 2,
  lastDrawDay: 56,
}

/** The filtered answers' vocabulary: every id the fixtures use. */
const VOCABULARY: FilterOptions = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [
        { id: 'colorectal cancer', children: [] },
        { id: 'melanoma', children: [] },
      ],
    },
  ],
  treatment_classes: [
    { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
    { id: 'chemotherapy', label: 'Chemotherapy' },
    { id: 'radiotherapy', label: 'Radiotherapy' },
  ],
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

function response(
  methods: MethodEligibility[],
  overrides: Partial<EligibilityResponse> = {},
): EligibilityResponse {
  const total_fit = methods.filter(m => m.status === 'can_run').length
  const total_some = methods.filter(m => m.status === 'can_run_some').length
  const total_cannot = methods.filter(m => m.status === 'cannot_run').length
  return {
    methods,
    total_fit,
    total_some,
    total_cannot,
    total_no_env: 0,
    ...overrides,
  }
}

describe('buildStudyPreviewRequest (TEST-INT-2)', () => {
  it('carries the schedule answers verbatim, answered ones only (R3-intake-2)', () => {
    const req = buildStudyPreviewRequest(FULL_ANSWERS, GROUPS, VOCABULARY)
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

  it('sends the three method-filter facts flattened at the top level, answered ones only (step2-filters)', () => {
    const req = buildStudyPreviewRequest(
      {
        ...EMPTY_ANSWERS,
        disease: 'colorectal cancer',
        treatments: ['immune checkpoint inhibitor', 'radiotherapy'],
        outcome: 'progression-by-day',
      },
      GROUPS,
      VOCABULARY,
    )
    expect(req.disease_group).toBe('colorectal cancer')
    expect(req.treatment_classes).toEqual(['immune checkpoint inhibitor', 'radiotherapy'])
    expect(req.method_group).toBe('static-risk')
  })

  it('omits an unanswered schedule question — the provider reads it as "any" (R3-intake-2)', () => {
    // The old body carried the board's first options when unanswered, so an
    // untouched draw question narrowed the fit count; an unanswered question
    // is ABSENT, never an assumed value.
    const req = buildStudyPreviewRequest(EMPTY_ANSWERS, GROUPS, VOCABULARY)
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
    })
    expect(req.before_treatment).toBeUndefined()
    expect(req.draws_during_treatment).toBeUndefined()
    expect(req.last_draw_day).toBeUndefined()
    expect(req.disease_group).toBeUndefined()
    expect(req.treatment_classes).toBeUndefined()
    expect(req.method_group).toBeUndefined()
  })

  it('sends exactly the answered filter facts (a partial answer — never null, never an empty list)', () => {
    const req = buildStudyPreviewRequest(
      { ...EMPTY_ANSWERS, treatments: [], outcome: 'dynamic-risk', disease: null },
      GROUPS,
      VOCABULARY,
    )
    expect(req.disease_group).toBeUndefined()
    expect(req.treatment_classes).toBeUndefined()
    expect(req.method_group).toBe('dynamic-risk')
  })

  it('a persisted id the vocabulary does not know is never sent (5a3 — the server 422 guard)', () => {
    const req = buildStudyPreviewRequest(
      {
        ...EMPTY_ANSWERS,
        disease: 'dead-cancer',
        treatments: ['radiotherapy', 'obsolete-drug'],
        outcome: 'dynamic-risk',
      },
      GROUPS,
      VOCABULARY,
    )
    expect(req.disease_group).toBeUndefined()
    expect(req.treatment_classes).toEqual(['radiotherapy'])
    expect(req.method_group).toBe('dynamic-risk')
  })

  it('while the vocabulary is not loaded the disease/treatment facts are omitted; the outcome still rides', () => {
    const req = buildStudyPreviewRequest(
      { ...EMPTY_ANSWERS, disease: 'colorectal cancer', treatments: ['chemotherapy'], outcome: 'dynamic-risk' },
      GROUPS,
      null,
    )
    expect(req.disease_group).toBeUndefined()
    expect(req.treatment_classes).toBeUndefined()
    expect(req.method_group).toBe('dynamic-risk')
  })

  it('sends exactly the answered schedule fields (a partial answer)', () => {
    const req = buildStudyPreviewRequest(
      { ...EMPTY_ANSWERS, drawsDuringTreatment: 1 },
      GROUPS,
      VOCABULARY,
    )
    expect(req.draws_during_treatment).toBe(1)
    expect(req.before_treatment).toBeUndefined()
    expect(req.last_draw_day).toBeUndefined()
  })
})

describe('fitCounts + panel copy (TEST-INT-2/13, R2-1 + R3-intake-1)', () => {
  it('derives the count split from the response totals', () => {
    const r = response([
      method('m-a', 'can_run', []),
      method('m-b', 'can_run_some', [{ code: 'MIN_DRAWS_UNMET' }]),
      method('m-c', 'cannot_run', [{ code: 'MARKER_GROUP_MISSING' }]),
    ])
    expect(fitCounts(r)).toEqual({ total: 3, fit: 2, some: 1, leftOut: 1, noEnvFit: 0 })
  })

  it('separates the environment fact from the answer causes (R2-1, and the closed arithmetic R3-intake-1)', () => {
    // 359 methods: 41 can run, 4 env-absent with NO other reasons (they fit
    // the study — the env line says they cannot start), 53 answer-caused
    // left-outs, 261 env-absent with an answer cause too — the runtime
    // stage reclassifies every env-absent method to cannot_run with
    // ENV_IMAGE_MISSING pushed first, so `total_no_env` counts exactly
    // those 265; the left-out count is EVERY answer cause (the 53 plus the
    // 261 mixed ones — the old split left the mixed methods in neither
    // count, so the heading and the headline disagreed).
    const r = response(
      [
        ...Array.from({ length: 41 }, (_, i) => method(`fit-${i}`, 'can_run', [])),
        ...Array.from({ length: 4 }, (_, i) =>
          method(`env-only-${i}`, 'cannot_run', [{ code: 'ENV_IMAGE_MISSING' }]),
        ),
        ...Array.from({ length: 53 }, (_, i) =>
          method(`ans-${i}`, 'cannot_run', [{ code: 'MARKER_GROUP_MISSING' }]),
        ),
        ...Array.from({ length: 261 }, (_, i) =>
          method(`env-ans-${i}`, 'cannot_run', [
            { code: 'ENV_IMAGE_MISSING' },
            { code: 'MARKER_GROUP_MISSING' },
          ]),
        ),
      ],
      {
        total_fit: 41,
        total_some: 0,
        total_cannot: 318,
        total_no_env: 265,
      },
    )
    const counts = fitCounts(r)
    // fit = 41 runnable + 4 env-only (their answers fit; the env line is the
    // separate fact); leftOut = all 314 answer causes (53 + 261); the closed
    // arithmetic fit + leftOut === total; noEnvFit = the env-only fitters.
    expect(counts).toEqual({ total: 359, fit: 45, some: 0, leftOut: 314, noEnvFit: 4 })
    expect(counts.fit + counts.leftOut).toBe(counts.total)
  })

  it('renders the board headline + left-out copy from the split, never a literal count', () => {
    const fit: FitCounts = { total: 39, fit: 26, some: 4, leftOut: 13, noEnvFit: 0 }
    expect(fitHeading(fit)).toBe('26 of 39 methods fit')
    expect(leftOutHeading(fit)).toBe('13 methods are left out')
    expect(someFitLine(fit)).toBe('4 can run for some patients')
  })

  it('noEnvFit positive leaves the heading as the answer causes (R2-1 + R3-intake-1)', () => {
    const fit: FitCounts = { total: 359, fit: 176, some: 0, leftOut: 183, noEnvFit: 171 }
    expect(fitHeading(fit)).toBe('176 of 359 methods fit')
    expect(leftOutHeading(fit)).toBe('183 methods are left out')
  })

  it('speaks the true grammar for one left-out method (R3-intake-1)', () => {
    const fit: FitCounts = { total: 359, fit: 358, some: 0, leftOut: 1, noEnvFit: 0 }
    expect(leftOutHeading(fit)).toBe('1 method is left out')
  })
})

describe('hasStudyAnswers (R2-1 — the panel does not answer before the first answer)', () => {
  it('is false for the birth state and true after the FIRST answer of any kind', () => {
    expect(hasStudyAnswers(EMPTY_ANSWERS)).toBe(false)
    expect(hasStudyAnswers({ ...EMPTY_ANSWERS, disease: 'lung' })).toBe(true)
    expect(hasStudyAnswers({ ...EMPTY_ANSWERS, outcome: 'dynamic-risk' })).toBe(true)
    expect(hasStudyAnswers({ ...EMPTY_ANSWERS, markerGroups: { ctdna: false } })).toBe(true)
    expect(hasStudyAnswers({ ...EMPTY_ANSWERS, beforeTreatment: 'always' })).toBe(true)
    expect(hasStudyAnswers({ ...EMPTY_ANSWERS, drawsDuringTreatment: 2 })).toBe(true)
    expect(hasStudyAnswers({ ...EMPTY_ANSWERS, lastDrawDay: 56 })).toBe(true)
  })

  it('keeps the honest invite line constant', () => {
    expect(PREVIEW_ANSWER_INVITE).toBe(
      'Answer the questions above to see which methods fit your study.',
    )
  })
})

describe('descriptiveSentence (step3-step4-fixes — every answered filter named)', () => {
  /** The sentence's vocabulary (the clause helpers' label/name table). */
  const SENTENCE_VOCABULARY = {
    categories: VOCABULARY.disease_categories,
    treatmentClasses: VOCABULARY.treatment_classes,
  }
  /** The `vocab` while the filter options have not loaded (both empty). */
  const EMPTY_VOCABULARY = { categories: [], treatmentClasses: [] }

  it('renders the pinned all-clauses sentence exactly (the plan example)', () => {
    expect(
      descriptiveSentence(
        {
          ...EMPTY_ANSWERS,
          disease: 'lung cancer',
          treatments: ['chemotherapy'],
          outcome: 'progression-by-day',
          markerGroups: { 'tumour-markers': true },
          beforeTreatment: 'always',
          drawsDuringTreatment: 4,
          lastDrawDay: 56,
        },
        SENTENCE_VOCABULARY,
      ),
    ).toBe(
      'Methods for lung cancer, given with chemotherapy, that predict the risk by a set day, using tumour markers, with a draw before treatment, 4 or more draws during treatment and the last draw on day 56. This updates as you answer.',
    )
  })

  it('renders each answered clause alone, in the page order', () => {
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, disease: 'lung cancer' }, SENTENCE_VOCABULARY),
    ).toBe('Methods for lung cancer. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, treatments: ['chemotherapy'] }, SENTENCE_VOCABULARY),
    ).toBe('Methods given with chemotherapy. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, outcome: 'binary-response' }, SENTENCE_VOCABULARY),
    ).toBe('Methods that predict a yes or no response. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, markerGroups: { ldh: true } }, SENTENCE_VOCABULARY),
    ).toBe('Methods using LDH. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, beforeTreatment: 'always' }, SENTENCE_VOCABULARY),
    ).toBe('Methods with a draw before treatment. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, drawsDuringTreatment: 2 }, SENTENCE_VOCABULARY),
    ).toBe('Methods with 2 to 3 draws during treatment. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, lastDrawDay: 56 }, SENTENCE_VOCABULARY),
    ).toBe('Methods with the last draw on day 56. This updates as you answer.')
  })

  it('a category id reads "another disease in <category>" (the not-listed choice)', () => {
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, disease: 'Solid tumours' }, SENTENCE_VOCABULARY),
    ).toBe('Methods for another disease in solid tumours. This updates as you answer.')
    // While the vocabulary is not loaded the id is the honest text (never a
    // guessed label).
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, disease: 'Solid tumours' }, EMPTY_VOCABULARY),
    ).toBe('Methods for Solid tumours. This updates as you answer.')
  })

  it('treatment labels come from the vocabulary (first letter lower-cased); the id is the fallback', () => {
    expect(
      descriptiveSentence(
        { ...EMPTY_ANSWERS, treatments: ['immune checkpoint inhibitor', 'chemotherapy'] },
        SENTENCE_VOCABULARY,
      ),
    ).toBe(
      'Methods given with immune checkpoint inhibitor or chemotherapy. This updates as you answer.',
    )
    // A class the vocabulary does not know (or before it loads) renders the id.
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, treatments: ['unknown-drug'] }, SENTENCE_VOCABULARY),
    ).toBe('Methods given with unknown-drug. This updates as you answer.')
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, treatments: ['chemotherapy'] }, EMPTY_VOCABULARY),
    ).toBe('Methods given with chemotherapy. This updates as you answer.')
  })

  it('an unanswered question adds nothing (null, or an empty treatment list)', () => {
    expect(descriptiveSentence({ ...EMPTY_ANSWERS, treatments: [] }, SENTENCE_VOCABULARY)).toBe(
      'This updates as you answer.',
    )
    expect(
      descriptiveSentence({ ...EMPTY_ANSWERS, disease: 'lung cancer', treatments: [] }, SENTENCE_VOCABULARY),
    ).toBe('Methods for lung cancer. This updates as you answer.')
  })

  it('distinguishes "nothing answered" from "no marker group checked"', () => {
    expect(descriptiveSentence(EMPTY_ANSWERS, SENTENCE_VOCABULARY)).toBe(
      'This updates as you answer.',
    )
    expect(
      descriptiveSentence(
        { ...EMPTY_ANSWERS, markerGroups: { ctdna: false, counts: false } },
        SENTENCE_VOCABULARY,
      ),
    ).toBe('Methods using no marker groups. This updates as you answer.')
  })

  it('the schedule parts join into one "with …" clause', () => {
    expect(
      descriptiveSentence(
        {
          ...EMPTY_ANSWERS,
          beforeTreatment: 'sometimes',
          drawsDuringTreatment: 1,
          lastDrawDay: 42,
        },
        SENTENCE_VOCABULARY,
      ),
    ).toBe(
      'Methods with a draw before treatment for some patients, 1 draw during treatment and the last draw on day 42. This updates as you answer.',
    )
  })

  it('has no hardcoded counts — a sentence with no schedule answers has no digits (FLOW.md design-example rule)', () => {
    const sentence = descriptiveSentence(
      {
        ...EMPTY_ANSWERS,
        disease: 'lung cancer',
        treatments: ['immune checkpoint inhibitor', 'chemotherapy'],
        outcome: 'dynamic-risk',
        markerGroups: { ctdna: true },
      },
      SENTENCE_VOCABULARY,
    )
    for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(sentence).not.toContain(digit)
    }
  })
})

describe('excludedMethods (TEST-INT-2, R2-1 + R3-intake-1)', () => {
  it('lists the cannot_run verdicts with an ANSWER cause, in response order', () => {
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
      reasonCode: 'MARKER_GROUP_MISSING',
    })
    expect(excludedMethods(r, FORMATTERS)[1]).toEqual({
      id: 'm-c',
      reasonText: 'needs 3 or more draws',
      reasonCode: 'MIN_DRAWS_UNMET',
    })
  })

  it('leaves the env-ONLY verdicts to the panel env line; a mixed verdict lists its ANSWER cause (R3-intake-1)', () => {
    const r = response(
      [
        method('env-only', 'cannot_run', [{ code: 'ENV_IMAGE_MISSING' }]),
        method('env-ans', 'cannot_run', [
          { code: 'ENV_IMAGE_MISSING' },
          { code: 'MARKER_GROUP_MISSING' },
        ], {
          missing_groups: [{ group_id: 'methylation-sequencing', display_name: 'Methylation' }],
        }),
        method('answer', 'cannot_run', [{ code: 'MARKER_GROUP_MISSING' }]),
      ],
      { total_no_env: 2 },
    )
    expect(excludedMethods(r, FORMATTERS).map(m => m.id)).toEqual(['env-ans', 'answer'])
    expect(excludedMethods(r, FORMATTERS)[0]).toEqual({
      id: 'env-ans',
      reasonText: 'needs markers from: Methylation',
      // The grouping code is the FIRST NON-ENVIRONMENT reason — the env fact
      // has its own line, so a mixed verdict groups as its answer cause.
      reasonCode: 'MARKER_GROUP_MISSING',
    })
    // The direct line of an env-only method stays the shared E-vocabulary
    // sentence (the safety net: the panel never lists these rows, the reason
    // text is still true if a consumer does).
    const envOnly = method('env-only', 'cannot_run', [{ code: 'ENV_IMAGE_MISSING' }])
    expect(excludedReasonLine(envOnly, FORMATTERS)).toBe('no published environment available')
  })

  it('RUNNER_UNAVAILABLE is a MACHINE reason, like ENV_IMAGE_MISSING: never an answer cause, same fit/noEnvFit rule (w10a2)', () => {
    // When no method can run at all (on Windows: WSL 2 missing, too old or
    // turned off, the app's WSL runtime missing, or the app's run folder not
    // creatable), EVERY method's verdict starts with RUNNER_UNAVAILABLE
    // (first) and some also carry ENV_IMAGE_MISSING — the same machine
    // reasons the panel's "N of them cannot run yet" line owns.
    const r = response([
      method('runner-only', 'cannot_run', [{ code: 'RUNNER_UNAVAILABLE' }]),
      method('runner-env', 'cannot_run', [
        { code: 'RUNNER_UNAVAILABLE' },
        { code: 'ENV_IMAGE_MISSING' },
      ]),
      method('runner-ans', 'cannot_run', [
        { code: 'RUNNER_UNAVAILABLE' },
        { code: 'MARKER_GROUP_MISSING' },
      ]),
      method('runner-env-ans', 'cannot_run', [
        { code: 'RUNNER_UNAVAILABLE' },
        { code: 'ENV_IMAGE_MISSING' },
        { code: 'MARKER_GROUP_MISSING' },
      ]),
    ])
    // The machine-set methods with no answer cause fit (the machine line is
    // their fact); the two with an answer cause are left out by the ANSWERS.
    const counts = fitCounts(r)
    expect(counts).toEqual({ total: 4, fit: 2, some: 0, leftOut: 2, noEnvFit: 2 })
    expect(counts.fit + counts.leftOut).toBe(counts.total)
    // The left-out list carries the answer-caused ones only, bucketed under
    // their ANSWER code — never RUNNER_UNAVAILABLE (or ENV_IMAGE_MISSING).
    const excluded = excludedMethods(r, FORMATTERS)
    expect(excluded.map(m => m.id)).toEqual(['runner-ans', 'runner-env-ans'])
    expect(excluded.map(m => m.reasonCode)).toEqual(['MARKER_GROUP_MISSING', 'MARKER_GROUP_MISSING'])
    // The direct line of a runner-only method is the machine sentence (the
    // env-only safety net's sibling).
    const runnerOnly = method('runner-only', 'cannot_run', [{ code: 'RUNNER_UNAVAILABLE' }])
    expect(excludedReasonLine(runnerOnly, FORMATTERS)).toBe('methods cannot run yet: see the notice at the top of the app')
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
  it('the sentence helpers are pure pieces: ids/labels as-is, never a guessed name', () => {
    expect(diseaseClause('colorectal cancer', VOCABULARY.disease_categories)).toBe(
      'colorectal cancer',
    )
    expect(diseaseClause('Solid tumours', VOCABULARY.disease_categories)).toBe(
      'another disease in solid tumours',
    )
    expect(outcomeClause('binary-response')).toBe('a yes or no response')
    expect(outcomeClause('response-probability')).toBe('the chance of response')
    expect(outcomeClause('progression-by-day')).toBe('the risk by a set day')
    expect(outcomeClause('dynamic-risk')).toBe('risk over time')
    expect(
      treatmentClause(['immune checkpoint inhibitor', 'chemotherapy'], VOCABULARY.treatment_classes),
    ).toBe('given with immune checkpoint inhibitor or chemotherapy')
    expect(treatmentClause(['chemotherapy'], VOCABULARY.treatment_classes)).toBe(
      'given with chemotherapy',
    )
    expect(scheduleClause(EMPTY_ANSWERS)).toBeNull()
    expect(
      scheduleClause({
        ...EMPTY_ANSWERS,
        beforeTreatment: 'always',
        drawsDuringTreatment: 4,
        lastDrawDay: 56,
      }),
    ).toBe('with a draw before treatment, 4 or more draws during treatment and the last draw on day 56')
    expect(groupShortName('ctdna')).toBe('ctDNA')
    expect(groupShortName('counts')).toBe('blood counts')
    expect(groupShortName('ldh')).toBe('LDH')
    expect(groupShortName('unknown-group')).toBe('unknown-group')
  })

  it('the answer-caused reason lines of the new codes render on B through the shared formatter', () => {
    const r = response([
      method('disease-m', 'cannot_run', [
        {
          code: 'DISEASE_NOT_MATCHED',
          params: { made_for: 'melanoma', answer: 'colorectal cancer' },
        },
      ]),
      method('treatment-m', 'cannot_run', [
        {
          code: 'TREATMENT_NOT_MATCHED',
          params: { made_for: 'chemotherapy, radiotherapy', answer: 'targeted therapy' },
        },
      ]),
      method('outcome-m', 'cannot_run', [
        {
          code: 'OUTCOME_NOT_MATCHED',
          params: { predicts: 'dynamic-risk', answer: 'static-risk' },
        },
      ]),
    ])
    expect(excludedMethods(r, FORMATTERS).map(m => m.reasonText)).toEqual([
      'Made for melanoma, not your disease',
      'Made for chemotherapy and radiotherapy, not your treatments',
      'Predicts risk over time, not what you chose',
    ])
  })

  it('the production wrapper threads the vocabulary labels into the reason lines (5a3)', () => {
    // The treated class ids arrive as `made_for`; B renders the vocabulary's
    // display labels ("Immune checkpoint inhibitor"), exactly as E does.
    const r = response([
      method('treatment-m', 'cannot_run', [
        {
          code: 'TREATMENT_NOT_MATCHED',
          params: { made_for: 'immune checkpoint inhibitor', answer: 'chemotherapy' },
        },
      ]),
    ])
    const withLabels: TxrPreviewFormatters = {
      formatReasonLine,
      labels: { treatmentClasses: VOCABULARY.treatment_classes },
    }
    expect(excludedMethods(r, withLabels)[0].reasonText).toBe(
      'Made for Immune checkpoint inhibitor, not your treatments',
    )
    // Without the labels the id is the fallback (never a guess).
    expect(excludedMethods(r, FORMATTERS)[0].reasonText).toBe(
      'Made for immune checkpoint inhibitor, not your treatments',
    )
  })
})

describe('groupExcludedMethods (brief 5b — the grouped left-out list)', () => {
  /** One excluded row (the code is the row's grouping id). */
  function row(id: string, code: ReasonCode): ExcludedMethod {
    return { id, reasonText: id, reasonCode: code }
  }

  it('buckets the answer-caused codes first (disease, treatment, outcome), every other code together', () => {
    const rows = [
      row('m-marker', 'REQUIRED_MARKER_MISSING'),
      row('m-disease', 'DISEASE_NOT_MATCHED'),
      row('m-outcome', 'OUTCOME_NOT_MATCHED'),
      row('m-draws', 'MIN_DRAWS_UNMET'),
      row('m-treatment', 'TREATMENT_NOT_MATCHED'),
    ]
    expect(groupExcludedMethods(rows).map(g => g.code)).toEqual([
      'DISEASE_NOT_MATCHED',
      'TREATMENT_NOT_MATCHED',
      'OUTCOME_NOT_MATCHED',
      'other',
    ])
    // The rows keep the list's own order inside each bucket.
    expect(groupExcludedMethods(rows).map(g => g.methods.map(m => m.id))).toEqual([
      ['m-disease'],
      ['m-treatment'],
      ['m-outcome'],
      ['m-marker', 'm-draws'],
    ])
  })

  it('omits empty sections and maps every foreign code to the do-not-fit bucket', () => {
    const rows = [
      row('m-a', 'MARKER_GROUP_MISSING'),
      row('m-b', 'SURVIVAL_OUTCOME_MISSING'),
    ]
    expect(groupExcludedMethods(rows)).toEqual([
      { code: 'other', methods: rows },
    ])
    expect(excludedGroupCode('DISEASE_NOT_MATCHED')).toBe('DISEASE_NOT_MATCHED')
    expect(excludedGroupCode('TREATMENT_NOT_MATCHED')).toBe('TREATMENT_NOT_MATCHED')
    expect(excludedGroupCode('OUTCOME_NOT_MATCHED')).toBe('OUTCOME_NOT_MATCHED')
    expect(excludedGroupCode('MIN_DRAWS_UNMET')).toBe('other')
    expect(excludedGroupCode('ENV_IMAGE_MISSING')).toBe('other')
  })
})
