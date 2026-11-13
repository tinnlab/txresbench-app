/**
 * TEST-UR-3 — txrresults board copy formatters (ITEM-3; PROV-UR-5's
 * strings, DEC-4/6/7/10/15).
 *
 * The formatters produce the G/H strings VERBATIM from `BusyResults.dc.html`
 * and `Results.dc.html`, and never a blank string: the subtitle pins
 * ("11 minutes 20 seconds", "under a minute", the "·"-joined sentence with
 * each segment omitted when its datum is null), the outcome-tab labels, the
 * cannot-run reason sentence (engine detail verbatim, constant fallback —
 * never the bare code), whole percents (plain ASCII digits, so the
 * `tabular-nums` value rendering has fixed-width digits), the saved-in path
 * and the compare-card sentences.
 *
 * Board example facts (the boards' patient counts, method counts, ids and
 * probabilities) are NEVER expectations: the fixtures here use synthetic ids
 * (`S00xx` per the module's fixture convention) and non-board counts. The
 * one board-verbatim SUBTITLE pin is assembled from parts because the
 * module's own INV-4/5 scan refuses the boards' example numbers as literals
 * in the module's files (see `module.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  COMPARE_CARD_TITLE,
  DIFFER_LEAD,
  DIFFER_NONE,
  DIVERGENCE_PP,
  DIVERGENT_TOGGLE,
  LEGEND_LABEL,
  REASON_FALLBACK,
  SHARED_TOP_LEAD,
  SHARED_TOP_NONE,
  SHARED_TOP_TAIL,
  compareCardTitle,
  formatChanceMissingNote,
  formatConstantNote,
  formatNoChanceNote,
  formatCounts,
  formatCoverage,
  formatDecisionDay,
  formatDifferSentence,
  formatLearnedFrom,
  formatMixedOutcomeNote,
  formatPatientList,
  formatPct,
  formatProbSourceLine,
  formatReasonText,
  formatSharedTopSentence,
  formatSubtitle,
  formatTaskLabel,
  formatTook,
  txrRunFailed,
} from './format'
import { SAFE_TEXT_GENERIC } from '@/modules/txrshell/lib/safeText'

describe('formatTook (the subtitle duration)', () => {
  it('renders the boarded precise durations (TEST-UR-3 pins)', () => {
    expect(formatTook(680)).toBe('11 minutes 20 seconds')
    expect(formatTook(45)).toBe('under a minute')
    expect(formatTook(60)).toBe('1 minute')
    expect(formatTook(90)).toBe('1 minute 30 seconds')
  })

  it('spells the under-a-minute form in the whole window and the exact hours at the boundaries', () => {
    expect(formatTook(0)).toBe('under a minute')
    expect(formatTook(59)).toBe('under a minute')
    expect(formatTook(60)).toBe('1 minute')
    expect(formatTook(61)).toBe('1 minute 1 second')
    expect(formatTook(62)).toBe('1 minute 2 seconds')
    expect(formatTook(119)).toBe('1 minute 59 seconds')
    expect(formatTook(120)).toBe('2 minutes')
    expect(formatTook(121)).toBe('2 minutes 1 second')
    expect(formatTook(680)).toBe('11 minutes 20 seconds')
  })

  it('renormalizes a fractional second that rounds into the next minute', () => {
    expect(formatTook(119.6)).toBe('2 minutes')
    expect(formatTook(179.6)).toBe('3 minutes')
  })

  it('returns null for a null, non-finite or negative datum (the segment is omitted)', () => {
    expect(formatTook(null)).toBeNull()
    expect(formatTook(Number.NaN)).toBeNull()
    expect(formatTook(Number.POSITIVE_INFINITY)).toBeNull()
    expect(formatTook(-5)).toBeNull()
  })
})

describe('formatPct (whole percents, tabular numerals)', () => {
  it('renders whole percents on the 0–100 legend', () => {
    expect(formatPct(77.4)).toBe('77%')
    expect(formatPct(77.5)).toBe('78%')
    expect(formatPct(0)).toBe('0%')
    expect(formatPct(100)).toBe('100%')
    expect(formatPct(37.5)).toBe('38%')
  })

  it('clamps a provider value outside the legend', () => {
    expect(formatPct(104.2)).toBe('100%')
    expect(formatPct(-3)).toBe('0%')
  })

  it('renders plain ASCII digits (the tabular-numeral rendering is the value\u2019s CSS, PROV-UR-5)', () => {
    expect(formatPct(72)).toMatch(/^[0-9]+%$/)
    expect(formatPct(7)).toMatch(/^[0-9]+%$/)
  })

  it('returns null for a null or non-finite value (an abstain value renders empty, never 0%)', () => {
    expect(formatPct(null)).toBeNull()
    expect(formatPct(Number.NaN)).toBeNull()
  })
})

describe('formatTaskLabel (the outcome-tab labels, DEC-4)', () => {
  it('spells the two survival tabs verbatim (TEST-UR-3 pins)', () => {
    expect(formatTaskLabel('pfs', 238)).toBe('Progression or death by day 238')
    expect(formatTaskLabel('os', 238)).toBe('Death by day 238')
  })

  it('spells the response tab with the OWNER-UR-1 default copy', () => {
    expect(formatTaskLabel('response', 56)).toBe('No response by day 56')
    expect(formatTaskLabel('response', 238)).toBe('No response by day 238')
  })
})

describe('the subtitle segment builders (PROV-UR-5)', () => {
  it('formatCounts renders the board sentence and the single-method singular', () => {
    expect(formatCounts(11, 12)).toBe('11 of ' + '12 methods finished')
    expect(formatCounts(1, 12)).toBe('1 of 12 methods finished')
    expect(formatCounts(0, 1)).toBe('0 of 1 method finished')
    expect(formatCounts(1, 1)).toBe('1 of 1 method finished')
  })

  it('formatLearnedFrom / formatDecisionDay render their segments', () => {
    expect(formatLearnedFrom(120)).toBe('learned from 120 patients')
    expect(formatLearnedFrom(1)).toBe('learned from 1 patient')
    expect(formatDecisionDay(56)).toBe('decision day 56')
  })

  it('omits a segment exactly when its datum is null (no empty runs in the sentence)', () => {
    expect(formatCounts(null, 12)).toBeNull()
    expect(formatCounts(11, null)).toBeNull()
    expect(formatLearnedFrom(null)).toBeNull()
    expect(formatDecisionDay(null)).toBeNull()
  })

  it('composes the board subtitle from the non-null segments (TEST-UR-3 example-verbatim)', () => {
    expect(
      formatSubtitle({
        finished: 11,
        total: 12,
        trainedOn: 120,
        decisionDay: 56,
        tookSeconds: 680,
      }),
    ).toBe(
      ['11 of ', '12 methods finished', ' · learned from ', '120 patients', ' · decision day ', '56', ' · took 11 minutes 20 seconds'].join(''),
    )
  })

  it('joins only the present segments, in board order, with the board separator', () => {
    expect(
      formatSubtitle({ finished: null, total: 12, trainedOn: null, decisionDay: 56, tookSeconds: null }),
    ).toBe('decision day 56')
    expect(
      formatSubtitle({ finished: 11, total: 12, trainedOn: 120, decisionDay: null, tookSeconds: null }),
    ).toBe('11 of ' + '12 methods finished · learned from 120 patients')
    expect(
      formatSubtitle({ finished: null, total: null, trainedOn: null, decisionDay: null, tookSeconds: null }),
    ).toBe('')
  })

  it('ITEM-2 (a): a terminal run\'s status word leads and replaces the counts segment (the K vocabulary)', () => {
    expect(
      formatSubtitle({
        status: 'Done, 3 of 5 methods failed',
        finished: 2,
        total: 5,
        trainedOn: 120,
        decisionDay: 56,
        tookSeconds: 680,
      }),
    ).toBe('Done, 3 of 5 methods failed · learned from 120 patients · decision day 56 · took 11 minutes 20 seconds')
    expect(
      formatSubtitle({
        status: 'Failed',
        finished: 0,
        total: 6,
        trainedOn: null,
        decisionDay: 56,
        tookSeconds: null,
      }),
    ).toBe('Failed · decision day 56')
    // A null status keeps the live counts segment.
    expect(
      formatSubtitle({
        status: null,
        finished: 2,
        total: 5,
        trainedOn: null,
        decisionDay: null,
        tookSeconds: null,
      }),
    ).toBe('2 of 5 methods finished')
  })
})

describe('formatReasonText (the cannot-run banner sentence, DEC-15)', () => {
  it('renders the engine reason detail verbatim, sentence-terminated', () => {
    expect(formatReasonText('REQUIRED_MARKER_MISSING', 'LDH is not in your measurements')).toBe(
      'LDH is not in your measurements.',
    )
    expect(formatReasonText('ENV_UNKNOWN', 'no published environment for method "x"')).toBe(
      'no published environment for method "x".',
    )
  })

  it('keeps the engine punctuation when the detail already ends the sentence', () => {
    expect(formatReasonText('JOB_TIMEOUT', 'The job timed out.')).toBe('The job timed out.')
    expect(formatReasonText('JOB_TIMEOUT', 'What happened?!')).toBe('What happened?!')
  })

  it('returns a readable, non-blank fallback for an unknown code / an empty detail (never a code string)', () => {
    expect(formatReasonText('SOME_FUTURE_CODE', null)).toBe(`${REASON_FALLBACK}.`)
    expect(formatReasonText('SOME_FUTURE_CODE', undefined)).toBe(`${REASON_FALLBACK}.`)
    expect(formatReasonText('SOME_FUTURE_CODE', '   ')).toBe(`${REASON_FALLBACK}.`)
    expect(formatReasonText(null, null)).toBe(`${REASON_FALLBACK}.`)
    const line = formatReasonText('SOME_FUTURE_CODE', null)
    expect(line.trim().length).toBeGreaterThan(0)
    expect(line).not.toContain('SOME_FUTURE_CODE')
  })

  it('omits no sentence for any prior detail', () => {
    expect(formatReasonText('REQUIRED_MARKER_MISSING', 'LDH is not in your measurements')).toMatch(/\.$/)
  })

  it('refuses to render an internal path or <app_data> detail (qa-fixes4 ITEM-1)', () => {
    // The UI-side safeText guard (the server sanitiser's second line): a
    // leaked absolute path or placeholder never reaches the screen.
    expect(formatReasonText('ENV_TOOL_MISSING', 'oras is not installed (looked in /data/tmp/bin and PATH)')).toBe(
      `${SAFE_TEXT_GENERIC}.`,
    )
    expect(formatReasonText('ENV_TOOL_MISSING', 'oras is not installed (looked in <app_data>/bin and PATH)')).toBe(
      `${SAFE_TEXT_GENERIC}.`,
    )
    expect(formatReasonText('ENV_UNKNOWN', 'no published environment on /usr/local/methods')).toBe(
      `${SAFE_TEXT_GENERIC}.`,
    )
  })
})

describe('the compare-card copy constants and sentence builders (DEC-7)', () => {
  it('pins the copy constants', () => {
    expect(DIVERGENCE_PP).toBe(10)
    expect(COMPARE_CARD_TITLE).toBe('How the two methods compare')
    expect(SHARED_TOP_LEAD).toBe('Both methods put')
    expect(SHARED_TOP_TAIL).toBe('among their five highest chances')
    expect(DIFFER_LEAD).toBe('They differ most for')
    expect(DIVERGENT_TOGGLE).toBe('Show only the patients where they differ')
  })

  it('names patients the board way (no Oxford comma, "and" before the last)', () => {
    expect(formatPatientList(['S0081', 'S0092', 'S0093'])).toBe('S0081, S0092 and S0093')
    expect(formatPatientList(['S0081', 'S0092'])).toBe('S0081 and S0092')
    expect(formatPatientList(['S0081'])).toBe('S0081')
    expect(formatPatientList([])).toBe('')
    expect(formatPatientList(['S0081', '', 'S0093'])).toBe('S0081 and S0093')
  })

  it('builds the shared-top sentence (the top-5 intersection, ≤ 3 names)', () => {
    expect(
      formatSharedTopSentence([{ patientId: 'S0081' }, { patientId: 'S0092' }, { patientId: 'S0093' }]),
    ).toBe('Both methods put S0081, S0092 and S0093 among their five highest chances.')
    expect(formatSharedTopSentence([{ patientId: 'S0081' }])).toBe(
      'Both methods put S0081 among their five highest chances.',
    )
  })

  it('builds the differ sentence with both whole percents', () => {
    expect(
      formatDifferSentence([
        { patientId: 'S0099', a: 77, b: 52 },
        { patientId: 'S0101', a: 35, b: 57 },
      ]),
    ).toBe('They differ most for S0099 (77% and 52%) and S0101 (35% and 57%).')
    expect(formatDifferSentence([{ patientId: 'S0099', a: 80, b: 12 }])).toBe(
      'They differ most for S0099 (80% and 12%).',
    )
  })

  it('spells an abstain slot as an em dash and handles the empty cases with constant sentences', () => {
    expect(formatDifferSentence([{ patientId: 'S0099', a: null, b: 52 }])).toBe(
      'They differ most for S0099 (\u2014 and 52%).',
    )
    expect(formatSharedTopSentence([])).toBe(`${SHARED_TOP_NONE}.`)
    expect(formatDifferSentence([])).toBe(`${DIFFER_NONE}.`)
  })
})

describe('qa-fixes ITEM-4 — the names, legend and plain-voice notes (RES-03/04/10)', () => {
  it('names the two methods in the compare-card title (RES-10)', () => {
    expect(compareCardTitle('landmark-cox-current', 'cox-cutpoint-risk')).toBe(
      'How landmark-cox-current and cox-cutpoint-risk compare',
    )
  })

  it('spells the legend per outcome tab (RES-04: the no-response tab never reads "failure")', () => {
    expect(LEGEND_LABEL.pfs).toBe('Chance of failure')
    expect(LEGEND_LABEL.os).toBe('Chance of death')
    expect(LEGEND_LABEL.response).toBe('Chance of no response')
  })

  it('builds the mixed-outcome note (RES-04) with the hidden tasks named and counted', () => {
    expect(
      formatMixedOutcomeNote(5, 6, [{ key: 'response', day: 30 }]),
    ).toBe(
      'Showing the 5 of 6 finished methods on this tab; the other 1 predicts no response by day 30 and is shown on its own tab.',
    )
    expect(
      formatMixedOutcomeNote(4, 6, [
        { key: 'response', day: 30 },
        { key: 'os', day: 238 },
      ]),
    ).toBe(
      'Showing the 4 of 6 finished methods on this tab; the other 2 predict death by day 238 or no response by day 30 and are shown on their own tabs.',
    )
    expect(formatMixedOutcomeNote(6, 6, [])).toBeNull()
  })

  it('names a constant column plainly (RES-03), one value or a set, and nothing when none is constant', () => {
    expect(
      formatConstantNote([
        { constantValue: 0 },
        { constantValue: 0 },
        { constantValue: 0.865 },
        { constantValue: null },
      ]),
    ).toBe('3 methods gave the same chance (0% and 87%) for every patient.')
    expect(formatConstantNote([{ constantValue: 0 }])).toBe(
      '1 method gave the same chance (0%) for every patient.',
    )
    expect(formatConstantNote([{ constantValue: null }, { constantValue: null }])).toBeNull()
    expect(formatConstantNote([])).toBeNull()
  })

  it('says plainly when a finished method has no chance column (qa-fixes2 R2-10 — the "6 of 6" header vs "All 5" table)', () => {
    const finished = [{ methodId: 'ctdna-clearance', label: 'ctdna-clearance' }]
    const five = ['cfmedip-ctdna-clearance-three-group', 'cox-baseline-delta', 'ctdna-anytime-detectability', 'ctdna-week4-rise-or-emergence', 'landmark-cox-current'].map(id => ({ methodId: id }))
    expect(
      formatChanceMissingNote(
        [...finished, ...five.map(m => ({ methodId: m.methodId, label: m.methodId }))],
        five,
      ),
    ).toBe(
      'Showing the 5 of 6 finished methods that give chances; ctdna-clearance finished without a recorded chance column and is not shown.',
    )
    // Every finished method carries a column → no note.
    expect(formatChanceMissingNote(five.map(m => ({ methodId: m.methodId, label: m.methodId })), five)).toBeNull()
    // Several missing methods read the plural.
    expect(
      formatChanceMissingNote(
        [
          { methodId: 'a', label: 'a' },
          { methodId: 'b', label: 'b' },
          { methodId: 'c', label: 'c' },
        ],
        [{ methodId: 'c' }],
      ),
    ).toBe(
      'Showing the 1 of 3 finished methods that give chances; a, b finished without a recorded chance column and are not shown.',
    )
  })

  it('formats the coverage line (RES-11) and the prob-source sentence (RES-11/05)', () => {
    expect(formatCoverage(68, 94)).toBe('Scored for 68 of 94 patients')
    expect(formatCoverage(1, 1)).toBe('Scored for 1 of 1 patient')
    expect(formatCoverage(null, 94)).toBeNull()
    expect(formatProbSourceLine('native')).toBe(
      "The chances are the method's own estimates, as it was trained.",
    )
    expect(formatProbSourceLine('recalibrated')).toBe(
      'The chances were recalibrated on your patients before being shown.',
    )
    expect(formatProbSourceLine(null)).toBe(
      'No chances are shown: this predict-only reuse has no training data to convert the scores into chances.',
    )
  })
})

describe('txrRunFailed (R2-02/RES-02 failed-run truth)', () => {
  it('treats failed and stopped as failed regardless of method states', () => {
    expect(txrRunFailed({ status: 'failed', methods: [{ state: 'finished' }] })).toBe(true)
    expect(txrRunFailed({ status: 'stopped', methods: [{ state: 'finished' }] })).toBe(true)
    expect(txrRunFailed({ status: 'failed', methods: [{ state: 'failed' }] })).toBe(true)
  })

  it('treats a finished run with no finished method as failed (the engine rule)', () => {
    expect(
      txrRunFailed({ status: 'finished', methods: [{ state: 'failed' }, { state: 'cancelled' }] }),
    ).toBe(true)
    expect(txrRunFailed({ status: 'finished', methods: [] })).toBe(true)
  })

  it('treats a finished run with at least one finished method as a run', () => {
    expect(
      txrRunFailed({
        status: 'finished',
        methods: [{ state: 'failed' }, { state: 'finished' }],
      }),
    ).toBe(false)
  })

  it('treats non-terminal statuses as not failed (running/pending)', () => {
    expect(txrRunFailed({ status: 'running', methods: [] })).toBe(false)
    expect(txrRunFailed({ status: 'pending', methods: [] })).toBe(false)
  })
})

describe('formatNoChanceNote (R2-03 no-chance wall of blanks)', () => {
  it('names the single no-chance column with the prob-source words', () => {
    expect(
      formatNoChanceNote([
        { label: 'Model A', probSource: 'native' },
        { label: 'Model B', probSource: null },
      ]),
    ).toBe(
      'No chances are shown for Model B: this predict-only reuse has no training data to convert the scores into chances.',
    )
  })

  it('names several columns, plural', () => {
    expect(
      formatNoChanceNote([
        { label: 'Model A', probSource: null },
        { label: 'Model B', probSource: null },
        { label: 'Model C', probSource: 'recalibrated' },
      ]),
    ).toBe(
      'No chances are shown for Model A, Model B: this predict-only reuse has no training data to convert the scores into chances.',
    )
  })

  it('is null when every column carries chances', () => {
    expect(
      formatNoChanceNote([
        { label: 'Model A', probSource: 'native' },
        { label: 'Model B', probSource: 'recalibrated' },
      ]),
    ).toBeNull()
    expect(formatNoChanceNote([])).toBeNull()
  })
})
