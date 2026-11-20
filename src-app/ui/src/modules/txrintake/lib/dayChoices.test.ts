// @vitest-environment node
/**
 * The day choices (`lib/dayChoices.ts`): the suggested draw days on the
 * app's example files and on irregular days, the coverage lines, the
 * look-ahead counts, suggestions and limits, and the engine's rule for the
 * chance. The example facts are built from the committed example files the
 * way the server's timeline block builds them (draw days > 0, distinct; the
 * pfs/os pairs per patients row).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileTimeline, TimelinePatient } from '@/api-client/types'
import {
  checkLookAhead,
  drawCoverage,
  drawCoverageLine,
  drawDayError,
  drawDayWarning,
  eventFreeAfter,
  furthestDayWithShare,
  knownOutcomeLine,
  knownOutcomes,
  lookAheadSuggestions,
  monthsText,
  plainLookAheadDefault,
  suggestDrawDays,
} from './dayChoices'

const LIMITS = { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10 }

const EXAMPLES = resolve(__dirname, '../../../../../../data/file-validator/examples')

function csvRows(name: string): Array<Record<string, string>> {
  const [header, ...lines] = readFileSync(resolve(EXAMPLES, name), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
  const columns = header.split(',')
  return lines.map(line => {
    const values = line.split(',')
    return Object.fromEntries(columns.map((c, i) => [c, values[i] ?? '']))
  })
}

/** The example files' facts, as the server's timeline block carries them. */
function exampleFacts(): FileTimeline {
  const byPatient = new Map<string, Set<number>>()
  for (const row of csvRows('measurements.csv')) {
    const days = byPatient.get(row.patient_id) ?? new Set<number>()
    const day = Number(row.day)
    if (day > 0) days.add(day)
    byPatient.set(row.patient_id, days)
  }
  const pair = (days: string, event: string) =>
    days === '' || event === '' ? undefined : { days: Number(days), event: Number(event) }
  return {
    draw_days: [...byPatient.values()].map(days => [...days].sort((a, b) => a - b)),
    outcomes: csvRows('patients.csv').map(row => ({
      pfs: pair(row.pfs_days, row.pfs_event),
      os: pair(row.os_days, row.os_event),
    })),
    limits: LIMITS,
  }
}

/** Facts from per-patient draw days, with every patient followed past day 1000. */
function facts(drawDays: number[][], outcomes?: TimelinePatient[]): FileTimeline {
  return {
    draw_days: drawDays,
    outcomes: outcomes ?? drawDays.map(() => ({ pfs: { days: 1000, event: 0 } })),
    limits: LIMITS,
  }
}

describe('suggested draw days', () => {
  it('gives 21, 42, 56, 84, 126 on the example files', () => {
    const example = exampleFacts()
    expect(example.draw_days).toHaveLength(100)
    expect(suggestDrawDays(example)).toEqual([21, 42, 56, 84, 126])
  })

  it('keeps irregular days as they are (no snapping to 28, 42, 56)', () => {
    const exact = facts(Array.from({ length: 12 }, () => [29, 41, 55]))
    expect(suggestDrawDays(exact)).toEqual([29, 41, 55])
    // One patient each: the days still stand on their own.
    expect(suggestDrawDays(facts([[29], [41], [55]], []))).toEqual([29, 41, 55])
  })

  it('groups draws spread around each visit and suggests the last day of each group', () => {
    const spread = facts(
      Array.from({ length: 15 }, (_, i) => [27 + (i % 5), 40 + (i % 5), 54 + (i % 5)]),
    )
    expect(suggestDrawDays(spread)).toEqual([31, 44, 58])
    expect(drawCoverageLine(spread, 31)).toBe(
      'Day 31: 15 of 15 patients have a draw during treatment by this day',
    )
  })

  it('leaves out a day after which too few patients are still free of progression or death', () => {
    const outcomes: TimelinePatient[] = Array.from({ length: 20 }, (_, i) => ({
      pfs: { days: i < 12 ? 60 : 500, event: 1 },
    }))
    const f = facts(Array.from({ length: 20 }, () => [28, 84]), outcomes)
    // After day 84 only 8 patients are free of the event (fewer than 10).
    expect(eventFreeAfter(f, 84)).toBe(8)
    expect(suggestDrawDays(f)).toEqual([28])
  })

  it('reads os when a patient has no pfs pair (the os count is its own)', () => {
    const f = facts([[10]], [{ os: { days: 40, event: 1 } }, { pfs: undefined, os: undefined }])
    expect(eventFreeAfter(f, 30, 'os')).toBe(1)
    // The pfs count (the default) never reads the os pair.
    expect(eventFreeAfter(f, 30)).toBe(0)
  })

  it('the event-free count follows the outcome: the os pair at a late day, not the early pfs event', () => {
    const f = facts([[10]], [{ pfs: { days: 30, event: 1 }, os: { days: 300, event: 1 } }])
    // At decision day 56 the pfs event already happened, the death was not yet.
    expect(eventFreeAfter(f, 56, 'pfs')).toBe(0)
    expect(eventFreeAfter(f, 56, 'os')).toBe(1)
    // The default stays pfs (the study step has no endpoint yet).
    expect(eventFreeAfter(f, 56)).toBe(0)
  })

  it('suggests at most five days, those with the most patients', () => {
    const drawDays = Array.from({ length: 10 }, (_, i) => [
      10,
      30,
      60,
      100,
      150,
      ...(i < 3 ? [210] : []),
      ...(i < 2 ? [300] : []),
    ])
    expect(suggestDrawDays(facts(drawDays))).toEqual([10, 30, 60, 100, 150])
  })

  it('evenly spread days give one group, and the field still has its coverage line', () => {
    const even = facts(Array.from({ length: 60 }, (_, i) => [i + 1]))
    const days = suggestDrawDays(even)
    expect(days).toEqual([60])
    expect(drawCoverageLine(even, 30)).toBe(
      'Day 30: 30 of 60 patients have a draw during treatment by this day',
    )
  })

  it('suggests nothing when no patient has a draw during treatment', () => {
    expect(suggestDrawDays(facts([[], []]))).toEqual([])
  })

  it('never suggests a day the day field would refuse (beyond the look-ahead maximum)', () => {
    const f = facts(Array.from({ length: 12 }, () => [21, 735]))
    // Day 735 is past the field's limit (look_ahead_day_max 730 → at most 729).
    expect(suggestDrawDays(f)).toEqual([21])
  })
})

describe('the draw coverage line and limits', () => {
  it('counts the patients of the measurements file with a draw during treatment by the day', () => {
    const example = exampleFacts()
    expect(drawCoverageLine(example, 56)).toBe(
      'Day 56: 100 of 100 patients have a draw during treatment by this day',
    )
    expect(drawCoverage(example, 20)).toEqual({ withDraw: 0, patients: 100 })
    expect(drawCoverageLine(facts([[5]]), 5)).toBe(
      'Day 5: 1 of 1 patient has a draw during treatment by this day',
    )
  })

  it('accepts a whole day from 1 to one day before the look-ahead maximum', () => {
    expect(drawDayError(1, 730)).toBeNull()
    expect(drawDayError(729, 730)).toBeNull()
    expect(drawDayError(0, 730)).toBe('Choose a whole day from 1 to 729.')
    expect(drawDayError(730, 730)).toBe('Choose a whole day from 1 to 729.')
    expect(drawDayError(28.5, 730)).toBe('Choose a whole day from 1 to 729.')
  })

  it('warns when too few patients are free of the event after the day, never without outcomes', () => {
    const example = exampleFacts()
    expect(drawDayWarning(example, 56)).toBeNull()
    expect(drawDayWarning(example, 700)).toMatch(/^Only \d+ patients have not progressed or died by day 700\./)
    expect(drawDayWarning(facts([[10]], []), 700)).toBeNull()
  })

  it('a draw on day == baseline_max_day is not on treatment (baseline_max_day 7: day 7 no, day 8 yes)', () => {
    const f: FileTimeline = {
      draw_days: Array.from({ length: 12 }, () => [8]),
      outcomes: [],
      limits: { baseline_max_day: 7, look_ahead_day_max: 730, min_training_patients: 10 },
    }
    expect(drawCoverageLine(f, 7)).toBe(
      'Day 7: 0 of 12 patients have a draw during treatment by this day',
    )
    expect(drawCoverageLine(f, 8)).toBe(
      'Day 8: 12 of 12 patients have a draw during treatment by this day',
    )
  })
})

describe('the look-ahead day', () => {
  it('counts the known outcomes the engine labels (example files, decision day 56)', () => {
    const example = exampleFacts()
    expect(knownOutcomes(example, 56, 238, 'pfs').known).toBe(78)
    expect(knownOutcomes(example, 56, 321, 'pfs').known).toBe(75)
    expect(knownOutcomes(example, 56, 730, 'pfs').known).toBe(63)
    expect(knownOutcomeLine(example, 56, 238, 'pfs')).toBe(
      'Day 238: 78 of 100 patients have a known outcome',
    )
  })

  it('suggests decision day + 182, three quarters at 321 and half at the 730 limit (example files)', () => {
    const s = lookAheadSuggestions(exampleFacts(), 56, 'pfs')
    expect(s).toEqual({ default: 238, threeQuarters: 321, half: 730 })
  })

  it('follows the Predict row (death only reads the os pairs)', () => {
    const example = exampleFacts()
    expect(knownOutcomes(example, 56, 238, 'os').known).toBe(91)
    expect(furthestDayWithShare(example, 56, 'os', 0.75)).toBe(407)
  })

  it('labels at the boundaries: time == the day with an event is known, without one it is not, the decision day is excluded', () => {
    const outcomes: TimelinePatient[] = [
      { pfs: { days: 300, event: 0 } }, // follow-up ends AT the day: not known there
      { pfs: { days: 300, event: 1 } }, // event AT the day: known and an event
      { pfs: { days: 56, event: 1 } }, // AT the decision day: excluded
    ]
    const f = facts([[28]], outcomes)
    expect(knownOutcomes(f, 56, 300, 'pfs')).toEqual({ known: 1, events: 1, patients: 3 })
    // One day BEFORE the censor: the censored follow-up still goes past the look-ahead.
    expect(knownOutcomes(f, 56, 299, 'pfs')).toEqual({ known: 2, events: 0, patients: 3 })
  })

  it('takes the half day as the default when decision day + 182 is not covered', () => {
    // 10 patients: 6 followed only to day 150 without the event, 4 with the event at day 400.
    const outcomes: TimelinePatient[] = [
      ...Array.from({ length: 6 }, () => ({ pfs: { days: 150, event: 0 } })),
      ...Array.from({ length: 4 }, () => ({ pfs: { days: 400, event: 1 } })),
    ]
    const f = facts(Array.from({ length: 10 }, () => [28]), outcomes)
    // At day 238 only the 4 events are known (4 of 10, under half).
    expect(knownOutcomes(f, 56, 238, 'pfs').known).toBe(4)
    const s = lookAheadSuggestions(f, 56, 'pfs')
    // Half (5 of 10) holds until the first censoring at 150: day 149.
    expect(s.half).toBe(149)
    expect(s.default).toBe(149)
  })

  it('keeps the default within the limit', () => {
    expect(plainLookAheadDefault(600, 730)).toBe(730)
    expect(plainLookAheadDefault(56, 730)).toBe(238)
  })

  it('checks the limits: after the decision day, at most the maximum, a whole day', () => {
    const example = exampleFacts()
    expect(checkLookAhead(example, 56, 56, 'pfs', 730).error).toBe(
      'Choose a day after the decision day (day 56).',
    )
    expect(checkLookAhead(example, 56, 731, 'pfs', 730).error).toBe('Choose day 730 or earlier.')
    expect(checkLookAhead(example, 56, 200.5, 'pfs', 730).error).toBe('Choose a whole day.')
    expect(checkLookAhead(example, 56, 730, 'pfs', 730)).toEqual({ error: null, warning: null })
    // Without facts only the limits apply.
    expect(checkLookAhead(null, 56, 238, 'pfs', 730)).toEqual({ error: null, warning: null })
  })

  it('refuses a day where no patient has a known outcome (the chance cannot be worked out)', () => {
    const outcomes: TimelinePatient[] = Array.from({ length: 12 }, () => ({
      pfs: { days: 100, event: 0 },
    }))
    const f = facts(Array.from({ length: 12 }, () => [28]), outcomes)
    expect(checkLookAhead(f, 56, 150, 'pfs', 730).error).toBe(
      'No patient has a known outcome by day 150, so the chance cannot be worked out. Choose an earlier day.',
    )
  })

  it('warns when few outcomes are known, and when every known outcome is the same', () => {
    const few: TimelinePatient[] = [
      ...Array.from({ length: 3 }, () => ({ pfs: { days: 120, event: 1 } })),
      ...Array.from({ length: 3 }, () => ({ pfs: { days: 400, event: 0 } })),
    ]
    const f = facts(Array.from({ length: 6 }, () => [28]), few)
    expect(checkLookAhead(f, 56, 200, 'pfs', 730).warning).toBe(
      'Only 6 patients have a known outcome by day 200. Methods learn an outcome from at least 10.',
    )
    const allEvents: TimelinePatient[] = Array.from({ length: 12 }, () => ({
      pfs: { days: 120, event: 1 },
    }))
    expect(
      checkLookAhead(facts(Array.from({ length: 12 }, () => [28]), allEvents), 56, 200, 'pfs', 730)
        .warning,
    ).toBe('Every patient with a known outcome had the event by day 200, so every patient gets the same chance.')
    const noEvents: TimelinePatient[] = Array.from({ length: 12 }, () => ({
      pfs: { days: 500, event: 0 },
    }))
    expect(
      checkLookAhead(facts(Array.from({ length: 12 }, () => [28]), noEvents), 56, 200, 'pfs', 730)
        .warning,
    ).toBe('No patient with a known outcome had the event by day 200, so every patient gets the same chance.')
  })

  it('shows the months beside the days', () => {
    expect(monthsText(238)).toBe('238 days ≈ 7.8 months')
    expect(monthsText(730)).toBe('730 days ≈ 24.0 months')
  })
})
