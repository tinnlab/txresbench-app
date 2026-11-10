/**
 * TEST-UL-1 / TEST-UL-13 — txrlist board copy formatters (PROV-UI-LIST-4,
 * INV-1).
 *
 * The formatters produce the board strings VERBATIM (DEC-12) and never a
 * blank string. The pinned values are the bytes the boards carry:
 * `Busy.dc.html` rows ("12 s", "under 1 min", "about 5 min", "all 151
 * patients", "needs 3 or more draws; 120 of 151 have them"), its bottom
 * bar ("about 14 minutes in total on this computer", "Run 5 methods"),
 * `Pretrained.dc.html` ("all 38 patients, check the scales", "36 of 38
 * patients (2 lack LDH at day 56)", "For research. ..." — the notice is
 * host copy, not a formatter) and `Saved.dc.html` ("needs LDH, not in
 * this file" — the plan pins the "your file" spelling per EXAMPLE-UL-2).
 *
 * The reason-code cases below enumerate the whole vocabulary the switch
 * renders: the provider's closed 12-code set (PROV-MC-5) plus the two
 * grown model-list codes (PROV-MS-9 / PROV-PC-8) — TEST-UL-13's
 * vocabulary check. `TxrReasonCode` is derived from the generated
 * `ReasonCode`, so `format.ts`'s exhaustiveness line fails the typecheck
 * when a provider regen adds an unrendered code; this table keeps the
 * runtime expectations for the current set.
 */
import { describe, expect, it } from 'vitest'
import type { TxrRunStatus } from '../types'
import {
  formatCoverage,
  formatDurationShort,
  formatMissingItem,
  formatReasonLine,
  formatRunHeadline,
  formatTotalTime,
  pluralize,
  runLabel,
  type TxrCoverageFacts,
  type TxrReasonCode,
} from './format'

const SOME = (code: TxrReasonCode): { code: TxrReasonCode }[] => [{ code }]
const COVERAGE = (eligible: number, total: number): TxrCoverageFacts => ({ eligible, total })
const MISSING_LDH = [{ display_name: 'LDH' }]

describe('formatDurationShort', () => {
  it('renders the board row strings', () => {
    expect(formatDurationShort(12)).toBe('12 s')
    expect(formatDurationShort(300)).toBe('about 5 min')
    expect(formatDurationShort(840)).toBe('about 14 min')
    expect(formatDurationShort(120)).toBe('about 2 min')
    expect(formatDurationShort(240)).toBe('about 4 min')
    expect(formatDurationShort(45)).toBe('under 1 min')
  })

  it('pins the seconds / under-1-min boundary at 30 s', () => {
    expect(formatDurationShort(29)).toBe('29 s')
    expect(formatDurationShort(30)).toBe('under 1 min')
    expect(formatDurationShort(59)).toBe('under 1 min')
    expect(formatDurationShort(60)).toBe('about 1 min')
  })

  it('rounds to the nearest minute', () => {
    expect(formatDurationShort(90)).toBe('about 2 min')
    expect(formatDurationShort(89)).toBe('about 1 min')
    expect(formatDurationShort(150)).toBe('about 3 min')
  })

  it('rounds raw wire floats to whole seconds (CM-4: no "5.577333333333334 s")', () => {
    expect(formatDurationShort(5.577333333333334)).toBe('6 s')
    expect(formatDurationShort(22.497333333333334)).toBe('22 s')
    expect(formatDurationShort(14.726666666666668)).toBe('15 s')
    expect(formatDurationShort(19.740000000000002)).toBe('20 s')
    // A float that rounds past the half-minute boundary takes the next bucket.
    expect(formatDurationShort(29.7)).toBe('under 1 min')
    expect(formatDurationShort(12.4)).toBe('12 s')
  })
})

describe('formatCoverage', () => {
  it('reads "all N patients" when every patient is covered', () => {
    expect(formatCoverage(COVERAGE(151, 151))).toBe('all 151 patients')
    expect(formatCoverage(COVERAGE(38, 38))).toBe('all 38 patients')
  })

  it('reads "E of T patients" for a shortfall', () => {
    expect(formatCoverage(COVERAGE(120, 151))).toBe('120 of 151 patients')
    expect(formatCoverage(COVERAGE(36, 38))).toBe('36 of 38 patients')
    expect(formatCoverage(COVERAGE(0, 38))).toBe('0 of 38 patients')
  })
})

describe('formatRunHeadline', () => {
  it('produces the three board headlines and never the FLOW shorthand', () => {
    expect(formatRunHeadline('can')).toBe('Can run')
    expect(formatRunHeadline('some')).toBe('Can run for some patients')
    expect(formatRunHeadline('cannot')).toBe('Cannot run')
    for (const status of ['can', 'some', 'cannot'] as TxrRunStatus[]) {
      expect(formatRunHeadline(status)).not.toBe('partly')
    }
  })
})

describe('formatMissingItem', () => {
  it('uses the first display name', () => {
    expect(formatMissingItem(MISSING_LDH)).toBe('LDH')
    expect(formatMissingItem([{ display_name: 'Ki-67' }, { display_name: 'LDH' }])).toBe('Ki-67')
  })

  it('skips nameless entries and falls back to a constant', () => {
    expect(formatMissingItem([{}, { display_name: 'CEA' }])).toBe('CEA')
    expect(formatMissingItem([{ display_name: '  ' }])).toBe('a required marker')
    expect(formatMissingItem([])).toBe('a required marker')
  })
})

describe('formatReasonLine', () => {
  const minDraws = { required: 3, met: 120, unmet_patients: 31 }

  it('renders REQUIRED_MARKER_MISSING (EXAMPLE-UL-2)', () => {
    expect(
      formatReasonLine('cannot', SOME('REQUIRED_MARKER_MISSING'), COVERAGE(151, 151), minDraws, MISSING_LDH),
    ).toBe('needs LDH, not in your file')
  })

  it('renders MIN_DRAWS_UNMET with the met count over the total (board / EXAMPLE-UL-2)', () => {
    expect(
      formatReasonLine('some', SOME('MIN_DRAWS_UNMET'), COVERAGE(120, 151), minDraws, []),
    ).toBe('needs 3 or more draws; 120 of 151 have them')
  })

  it('renders DECISION_DAY_UNMET from coverage + the missing marker', () => {
    expect(
      formatReasonLine('some', SOME('DECISION_DAY_UNMET'), COVERAGE(36, 38), minDraws, MISSING_LDH),
    ).toBe('36 of 38 patients (2 lack LDH)')
  })

  it('renders the constant reason lines', () => {
    expect(formatReasonLine('cannot', SOME('DETECTION_CALL_MISSING'), COVERAGE(38, 38), minDraws, [])).toBe(
      'needs a detection-call marker, not in your file',
    )
    expect(formatReasonLine('cannot', SOME('COVARIATE_MISSING'), COVERAGE(38, 38), minDraws, [])).toBe(
      'needs extra inputs your file lacks',
    )
    expect(
      formatReasonLine('cannot', SOME('COVARIATE_REQUIRED_UNMET'), COVERAGE(38, 38), minDraws, []),
    ).toBe('needs extra inputs your file lacks')
    expect(formatReasonLine('cannot', SOME('NOT_RUNNABLE'), COVERAGE(38, 38), minDraws, [])).toBe(
      'not available with this build',
    )
    expect(formatReasonLine('cannot', SOME('ENV_IMAGE_MISSING'), COVERAGE(38, 38), minDraws, [])).toBe(
      'no published environment available',
    )
    expect(formatReasonLine('cannot', SOME('TASK_INCOMPATIBLE'), COVERAGE(38, 38), minDraws, [])).toBe(
      'needs an outcome column your file lacks',
    )
    expect(formatReasonLine('cannot', SOME('RESPONSE_LABEL_MISSING'), COVERAGE(38, 38), minDraws, [])).toBe(
      'needs a response label in your file',
    )
    expect(formatReasonLine('cannot', SOME('SURVIVAL_OUTCOME_MISSING'), COVERAGE(38, 38), minDraws, [])).toBe(
      'needs survival times in your file',
    )
    expect(formatReasonLine('cannot', SOME('MODEL_REQUIREMENTS_UNRECORDED'), COVERAGE(38, 38), minDraws, [])).toBe(
      'its requirements weren\'t recorded',
    )
    expect(formatReasonLine('cannot', SOME('ASSET_NOT_AVAILABLE'), COVERAGE(38, 38), minDraws, [])).toBe(
      "the model file isn't available",
    )
  })

  it('renders UNIT_MISMATCH as the board warning composition for can/some and the constant for cannot', () => {
    expect(formatReasonLine('can', SOME('UNIT_MISMATCH'), COVERAGE(38, 38), minDraws, [])).toBe(
      'all 38 patients, check the scales',
    )
    expect(formatReasonLine('some', SOME('UNIT_MISMATCH'), COVERAGE(36, 38), minDraws, [])).toBe(
      '36 of 38 patients, check the scales',
    )
    expect(formatReasonLine('cannot', SOME('UNIT_MISMATCH'), COVERAGE(0, 38), minDraws, [])).toBe('units do not match')
  })

  it('renders MARKER_GROUP_MISSING from the missing groups', () => {
    expect(
      formatReasonLine('cannot', SOME('MARKER_GROUP_MISSING'), COVERAGE(38, 38), minDraws, [], [
        { display_name: '5 methylation markers' },
      ]),
    ).toBe('needs markers from: 5 methylation markers')
    expect(
      formatReasonLine('cannot', SOME('MARKER_GROUP_MISSING'), COVERAGE(38, 38), minDraws, [], [
        { display_name: 'A' },
        { display_name: 'B' },
      ]),
    ).toBe('needs markers from: A, B')
    expect(
      formatReasonLine('cannot', SOME('MARKER_GROUP_MISSING'), COVERAGE(38, 38), minDraws, [], []),
    ).toBe('needs markers from: a missing marker group')
  })

  it('renders the first reason only', () => {
    expect(
      formatReasonLine(
        'cannot',
        [{ code: 'REQUIRED_MARKER_MISSING' }, { code: 'MIN_DRAWS_UNMET' }],
        COVERAGE(151, 151),
        minDraws,
        MISSING_LDH,
      ),
    ).toBe('needs LDH, not in your file')
  })

  it('falls back to the constant for an unknown code and for an empty reasons list', () => {
    const reasons = [{ code: 'SOME_FUTURE_CODE' as TxrReasonCode }]
    expect(formatReasonLine('cannot', reasons, COVERAGE(151, 151), minDraws, MISSING_LDH)).toBe(
      'cannot run with this file',
    )
    expect(formatReasonLine('cannot', [], COVERAGE(151, 151), minDraws, MISSING_LDH)).toBe('cannot run with this file')
  })

  it('never returns a blank line for any code in the vocabulary (TEST-UL-13)', () => {
    const codes: TxrReasonCode[] = [
      'REQUIRED_MARKER_MISSING',
      'MARKER_GROUP_MISSING',
      'DETECTION_CALL_MISSING',
      'MIN_DRAWS_UNMET',
      'COVARIATE_MISSING',
      'COVARIATE_REQUIRED_UNMET',
      'UNIT_MISMATCH',
      'DECISION_DAY_UNMET',
      'NOT_RUNNABLE',
      'ENV_IMAGE_MISSING',
      'TASK_INCOMPATIBLE',
      'RESPONSE_LABEL_MISSING',
      'SURVIVAL_OUTCOME_MISSING',
      'MODEL_REQUIREMENTS_UNRECORDED',
      'ASSET_NOT_AVAILABLE',
    ]
    for (const code of codes) {
      const line = formatReasonLine('cannot', SOME(code), COVERAGE(151, 151), minDraws, MISSING_LDH)
      expect(line.trim().length, code).toBeGreaterThan(0)
    }
  })
})

describe('formatTotalTime', () => {
  it('shows the ellipsis while loading and the board total line otherwise', () => {
    expect(formatTotalTime(null)).toBe('…')
    expect(formatTotalTime(840)).toBe('about 14 minutes in total')
    expect(formatTotalTime(300)).toBe('about 5 minutes in total')
    expect(formatTotalTime(300 + 840)).toBe('about 19 minutes in total')
  })

  it('uses the short total form under a minute', () => {
    expect(formatTotalTime(45)).toBe('under 1 minute in total')
    expect(formatTotalTime(60)).toBe('about 1 minute in total')
  })
})

describe('pluralize / runLabel', () => {
  it('pluralizes the itemLabel', () => {
    expect(pluralize('method', 5)).toBe('methods')
    expect(pluralize('method', 1)).toBe('method')
    expect(pluralize('model', 3)).toBe('models')
    expect(pluralize('model', 1)).toBe('model')
    expect(pluralize('model', 0)).toBe('models')
  })

  it('renders the Run button labels verbatim', () => {
    expect(runLabel('method', 5)).toBe('Run 5 methods')
    expect(runLabel('model', 3)).toBe('Run 3 models')
    expect(runLabel('method', 1)).toBe('Run 1 method')
    expect(runLabel('model', 1)).toBe('Run 1 model')
  })
})
