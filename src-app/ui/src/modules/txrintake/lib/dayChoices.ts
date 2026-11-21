/**
 * The day choices of a new analysis, counted from the checked files: the
 * suggested "last draw" days (the study step's last draw and step 4's
 * decision day), their coverage line, and the look-ahead day's suggestions,
 * coverage line and limits.
 *
 * The facts are the validate response's `timeline` block: per patient of the
 * measurements file, the draw days during treatment (day > the baseline
 * limit, the validator's own rule); per row of the patients file, the
 * progression-or-death and death follow-up pairs; and the engine's limits.
 * Nothing here re-reads a file, and no limit is a copy: the look-ahead
 * maximum and the fewest patients an outcome is learned from come with the
 * facts.
 *
 * The rules:
 *
 * - Suggested draw days: the draw days of all patients, grouped where they
 *   cluster (a new group starts after a gap larger than 3 days or 10% of the
 *   day, whichever is larger); a group suggests its last day. A day after
 *   which fewer patients are still free of progression or death than the
 *   engine learns an outcome from is left out. At most five groups, those with
 *   the most patients (ties: the earlier day), shown in day order.
 * - A known outcome at a look-ahead day is the engine's own labelling: a
 *   patient still free of the event at the decision day whose event happened
 *   by the look-ahead day, or whose follow-up goes past it. The chance cannot
 *   be worked out when no patient has a known outcome (the engine then refuses
 *   the probability); it is the same for everyone when every known outcome is
 *   an event, or none is.
 */
import type { FileTimeline, TimelineOutcome, TimelinePatient } from '@/api-client/types'

/** The outcome the look-ahead counts follow (step 4's "Predict" row). */
export type DayEndpoint = 'pfs' | 'os'

/** The most suggested draw days. */
export const MAX_SUGGESTED_DAYS = 5

/** The default distance from the decision day to the look-ahead day. */
export const LOOK_AHEAD_DEFAULT_GAP = 182

/** A whole day in the field (a draw day may carry a fraction). */
const wholeDay = (day: number): number => Math.ceil(day - 1e-9)

/** The gap after which a new group of draw days starts. */
function groupGap(day: number): number {
  return Math.max(3, 0.1 * day)
}

/** Patients of the patients file still free of the event after `day` (the
 *  outcome the count follows: the default pfs, or os). */
export function eventFreeAfter(
  facts: FileTimeline,
  day: number,
  endpoint: DayEndpoint = 'pfs',
): number {
  let n = 0
  for (const patient of facts.outcomes) {
    const pair = pairOf(patient, endpoint)
    if (pair !== null && pair.days > day) n += 1
  }
  return n
}

/**
 * The suggested last-draw days (at most five, ascending; empty when the file
 * has no draw during treatment or no group passes the outcome rule).
 */
export function suggestDrawDays(facts: FileTimeline): number[] {
  const patientsByDay = new Map<number, Set<number>>()
  facts.draw_days.forEach((days, patient) => {
    for (const day of days) {
      const set = patientsByDay.get(day) ?? new Set<number>()
      set.add(patient)
      patientsByDay.set(day, set)
    }
  })
  const days = [...patientsByDay.keys()].sort((a, b) => a - b)
  const groups: Array<{ last: number; patients: Set<number> }> = []
  for (const day of days) {
    const current = groups[groups.length - 1]
    if (current !== undefined && day - current.last <= groupGap(current.last)) {
      current.last = day
      for (const p of patientsByDay.get(day) ?? []) current.patients.add(p)
    } else {
      groups.push({ last: day, patients: new Set(patientsByDay.get(day)) })
    }
  }
  const hasOutcomes = facts.outcomes.length > 0
  const kept = groups
    .map(g => ({ day: wholeDay(g.last), patients: g.patients.size }))
    .filter(g => g.day >= 1)
    // A day the day field would refuse is never suggested (the field check is
    // the one gate: the suggestions must be choosable).
    .filter(g => drawDayError(g.day, facts.limits.look_ahead_day_max) === null)
    .filter(g => !hasOutcomes || eventFreeAfter(facts, g.day) >= facts.limits.min_training_patients)
  kept.sort((a, b) => b.patients - a.patients || a.day - b.day)
  const chosen = [...new Set(kept.slice(0, MAX_SUGGESTED_DAYS).map(g => g.day))]
  return chosen.sort((a, b) => a - b)
}

/** Patients with a draw during treatment by `day`, of the patients in the measurements file. */
export function drawCoverage(facts: FileTimeline, day: number): { withDraw: number; patients: number } {
  let withDraw = 0
  for (const days of facts.draw_days) {
    if (days.length > 0 && days[0] <= day) withDraw += 1
  }
  return { withDraw, patients: facts.draw_days.length }
}

/** "Day 56: 100 of 100 patients have a draw during treatment by this day". */
export function drawCoverageLine(facts: FileTimeline, day: number): string {
  const { withDraw, patients } = drawCoverage(facts, day)
  return `Day ${day}: ${withDraw} of ${patients} ${patients === 1 ? 'patient has' : 'patients have'} a draw during treatment by this day`
}

/** The latest last-draw day the field accepts (a look-ahead day must still fit after it). */
export function maxDrawDay(lookAheadMax: number): number {
  return Math.floor(lookAheadMax) - 1
}

/**
 * Why a typed last-draw day cannot be used, or null. The engine refuses a
 * decision day of 0 or less, and the look-ahead must still fit after it.
 */
export function drawDayError(day: number, lookAheadMax: number): string | null {
  const max = maxDrawDay(lookAheadMax)
  if (!Number.isInteger(day) || day < 1 || day > max) {
    return `Choose a whole day from 1 to ${max}.`
  }
  return null
}

/**
 * The warning under a last-draw day, or null: too few patients are still free
 * of the outcome after it for the methods to learn from. The event the count
 * follows is the endpoint's own — for 'pfs' progression or death, for 'os'
 * death only.
 */
export function drawDayWarning(
  facts: FileTimeline,
  day: number,
  endpoint: DayEndpoint = 'pfs',
): string | null {
  if (facts.outcomes.length === 0) return null
  const free = eventFreeAfter(facts, day, endpoint)
  const min = facts.limits.min_training_patients
  if (free >= min) return null
  const event = endpoint === 'os' ? 'not died' : 'not progressed or died'
  return `Only ${free} ${free === 1 ? 'patient has' : 'patients have'} ${event} by day ${day}. The methods learn an outcome from at least ${min}.`
}

/** The known outcomes at a look-ahead day (the engine's labelling). */
export interface KnownOutcomes {
  /** Patients the engine can label at the day. */
  known: number
  /** Of those, the patients whose event happened by the day. */
  events: number
  /** Patients in the patients file. */
  patients: number
}

function pairOf(patient: TimelinePatient, endpoint: DayEndpoint): TimelineOutcome | null {
  return (endpoint === 'pfs' ? patient.pfs : patient.os) ?? null
}

/** The known outcomes at `lookAhead` for a decision day and an outcome. */
export function knownOutcomes(
  facts: FileTimeline,
  decisionDay: number,
  lookAhead: number,
  endpoint: DayEndpoint,
): KnownOutcomes {
  let known = 0
  let events = 0
  for (const patient of facts.outcomes) {
    const pair = pairOf(patient, endpoint)
    if (pair === null || pair.days <= decisionDay) continue
    if (pair.event === 1 && pair.days <= lookAhead) {
      known += 1
      events += 1
    } else if (pair.days > lookAhead) {
      known += 1
    }
  }
  return { known, events, patients: facts.outcomes.length }
}

/** "Day 238: 78 of 100 patients have a known outcome". */
export function knownOutcomeLine(
  facts: FileTimeline,
  decisionDay: number,
  lookAhead: number,
  endpoint: DayEndpoint,
): string {
  const { known, patients } = knownOutcomes(facts, decisionDay, lookAhead, endpoint)
  return `Day ${lookAhead}: ${known} of ${patients} ${patients === 1 ? 'patient has' : 'patients have'} a known outcome`
}

/**
 * The furthest whole day after the decision day (and at most the maximum)
 * where at least `share` of the patients have a known outcome, or null.
 * The count only falls as the day grows (a patient whose follow-up ends
 * without the event drops out), so the furthest day is well defined.
 */
export function furthestDayWithShare(
  facts: FileTimeline,
  decisionDay: number,
  endpoint: DayEndpoint,
  share: number,
): number | null {
  const max = Math.floor(facts.limits.look_ahead_day_max)
  const needed = Math.ceil(share * facts.outcomes.length)
  if (needed === 0) return null
  let labelled = 0
  const censored: number[] = []
  for (const patient of facts.outcomes) {
    const pair = pairOf(patient, endpoint)
    if (pair === null || pair.days <= decisionDay) continue
    labelled += 1
    if (pair.event !== 1) censored.push(pair.days)
  }
  const canLose = labelled - needed
  if (canLose < 0) return null
  censored.sort((a, b) => a - b)
  const day = canLose >= censored.length ? max : Math.min(max, Math.ceil(censored[canLose]) - 1)
  return day > decisionDay ? day : null
}

/** The look-ahead suggestions for a decision day. */
export interface LookAheadSuggestions {
  /** Decision day + 182 when at least half the patients have a known outcome there. */
  default: number
  threeQuarters: number | null
  half: number | null
}

/** The default look-ahead with no facts: decision day + 182, within the maximum. */
export function plainLookAheadDefault(decisionDay: number, lookAheadMax: number): number {
  return Math.min(Math.floor(lookAheadMax), decisionDay + LOOK_AHEAD_DEFAULT_GAP)
}

/** The look-ahead default and the half / three-quarters suggestions. */
export function lookAheadSuggestions(
  facts: FileTimeline,
  decisionDay: number,
  endpoint: DayEndpoint,
): LookAheadSuggestions {
  const half = furthestDayWithShare(facts, decisionDay, endpoint, 0.5)
  const threeQuarters = furthestDayWithShare(facts, decisionDay, endpoint, 0.75)
  const plain = plainLookAheadDefault(decisionDay, facts.limits.look_ahead_day_max)
  const covered =
    facts.outcomes.length > 0 &&
    knownOutcomes(facts, decisionDay, plain, endpoint).known >= Math.ceil(facts.outcomes.length / 2)
  return { default: covered || half === null ? plain : half, threeQuarters, half }
}

/** The look-ahead check: an error blocks the run, a warning does not. */
export interface LookAheadCheck {
  error: string | null
  warning: string | null
}

/**
 * The limits of a look-ahead day (the engine's own: later than the decision
 * day, at most the maximum) and, with facts, the engine's rule for the
 * chance: no known outcome refuses; few known outcomes, or the same outcome
 * for every known patient, warn.
 */
export function checkLookAhead(
  facts: FileTimeline | null,
  decisionDay: number,
  lookAhead: number,
  endpoint: DayEndpoint,
  lookAheadMax: number,
): LookAheadCheck {
  if (!Number.isInteger(lookAhead)) return { error: 'Choose a whole day.', warning: null }
  if (lookAhead <= decisionDay) {
    return { error: `Choose a day after the decision day (day ${decisionDay}).`, warning: null }
  }
  if (lookAhead > lookAheadMax) {
    return { error: `Choose day ${lookAheadMax} or earlier.`, warning: null }
  }
  if (facts === null || facts.outcomes.length === 0) return { error: null, warning: null }
  const { known, events } = knownOutcomes(facts, decisionDay, lookAhead, endpoint)
  if (known === 0) {
    return {
      error: `No patient has a known outcome by day ${lookAhead}, so the chance cannot be worked out. Choose an earlier day.`,
      warning: null,
    }
  }
  const min = facts.limits.min_training_patients
  if (known < min) {
    return {
      error: null,
      warning: `Only ${known} ${known === 1 ? 'patient has' : 'patients have'} a known outcome by day ${lookAhead}. Methods learn an outcome from at least ${min}.`,
    }
  }
  if (events === known) {
    return {
      error: null,
      warning: `Every patient with a known outcome had the event by day ${lookAhead}, so every patient gets the same chance.`,
    }
  }
  if (events === 0) {
    return {
      error: null,
      warning: `No patient with a known outcome had the event by day ${lookAhead}, so every patient gets the same chance.`,
    }
  }
  return { error: null, warning: null }
}

/** Days in a month, on average. */
const DAYS_PER_MONTH = 30.44

/** "238 days ≈ 7.8 months". */
export function monthsText(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'} ≈ ${(days / DAYS_PER_MONTH).toFixed(1)} months`
}
