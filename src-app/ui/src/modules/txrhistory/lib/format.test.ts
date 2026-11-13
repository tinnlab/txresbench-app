/**
 * TEST-HIST-5 — txrhistory board-copy formatters (PROV-HIST-4, DEC-9;
 * INV-3; ITEM-3).
 *
 * The pins are the board's bytes VERBATIM — `History.dc.html`'s card
 * words: the spelled durations ("3 minutes 10 seconds", "2 minutes",
 * "under a minute"), the estimate parenthetical ("estimated 4 minutes"),
 * the MB figure ("312 MB"), the dates ("Today 10:02" / "19 Oct 14:36"),
 * the status words + tones, the chip words + tones, the endpoint lines
 * ("progression, death by day 238"), the reason lines with the provider's
 * detail VERBATIM and the Took line. The board's NUMBERS (the 4-run
 * footer, the 312 MB, the "151 patients" facts) are design examples,
 * never data (INV-6): the expected strings below are FORMATTER pins (the
 * board's words produced from arbitrary inputs), never run facts.
 *
 * Testability pins: the date's "today" reference and the locale are
 * injected (no hardcoded month table — `Intl.DateTimeFormat`); the
 * invalid-input defensives (a negative/NaN duration, a non-finite byte
 * count, an unparseable stamp) are pinned as the never-print-a-broken-fact
 * rule (the sibling run module's clock-skew guard class).
 */
import { describe, expect, it } from 'vitest'
import type { TxrHistoryBucket, TxrRunCounts, TxrRunReason, TxrRunMode } from '@/api-client/types'
import {
  NO_REASON_RECORDED,
  displayBucketOf,
  endpointLabel,
  formatBytes,
  formatDate,
  formatDurationWords,
  isTroubleRun,
  modeChip,
  reasonLine,
  statusLabel,
  tookLine,
  troubleReasonLine,
} from './format'

const MIB = 1024 * 1024

/** A local wall-clock instant as an ISO string (round-trips to the SAME
 *  local clock on any machine time zone — the tests are TZ-independent). */
function localIso(y: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(y, month, day, hour, minute).toISOString()
}

describe('formatDurationWords (TEST-HIST-5)', () => {
  it('spells the board durations exactly (DEC-9 board words, never the compact sibling form)', () => {
    expect(formatDurationWords(190)).toBe('3 minutes 10 seconds')
    expect(formatDurationWords(120)).toBe('2 minutes')
    expect(formatDurationWords(45)).toBe('under a minute')
    expect(formatDurationWords(60)).toBe('1 minute')
    expect(formatDurationWords(61)).toBe('1 minute 1 second')
    expect(formatDurationWords(62)).toBe('1 minute 2 seconds')
  })

  it('reads whole-minute durations as the minutes only and never pads zero seconds', () => {
    expect(formatDurationWords(120)).toBe('2 minutes')
    expect(formatDurationWords(0)).toBe('under a minute')
    expect(formatDurationWords(59)).toBe('under a minute')
    expect(formatDurationWords(119)).toBe('1 minute 59 seconds')
  })

  it('returns null for a null or broken duration — the segment omits (never a fabricated zero)', () => {
    expect(formatDurationWords(null)).toBeNull()
    expect(formatDurationWords(-5)).toBeNull()
    expect(formatDurationWords(Number.NaN)).toBeNull()
    expect(formatDurationWords(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('reads an estimate in the board estimate words: whole minutes, "estimated" prefix', () => {
    expect(formatDurationWords(240, { estimate: true })).toBe('estimated 4 minutes')
    expect(formatDurationWords(120, { estimate: true })).toBe('estimated 2 minutes')
    expect(formatDurationWords(88, { estimate: true })).toBe('estimated 1 minute')
    expect(formatDurationWords(190, { estimate: true })).toBe('estimated 3 minutes')
  })

  it('reads a sub-minute estimate "under a minute" (the estimate word is not doubled)', () => {
    expect(formatDurationWords(45, { estimate: true })).toBe('under a minute')
    expect(formatDurationWords(0, { estimate: true })).toBe('under a minute')
  })
})

describe('formatBytes (TEST-HIST-5)', () => {
  it('renders the board MB figure — one decimal only when needed', () => {
    expect(formatBytes(312 * MIB)).toBe('312 MB')
    expect(formatBytes(312.5 * MIB)).toBe('312.5 MB')
    expect(formatBytes(1 * MIB)).toBe('1 MB')
    expect(formatBytes(0)).toBe('0 MB')
  })

  it('rounds sub-decimal MB to one decimal place', () => {
    expect(formatBytes(1.25 * MIB)).toBe('1.3 MB')
    expect(formatBytes(0.5 * MIB)).toBe('0.5 MB')
  })

  it('never prints a broken counter', () => {
    expect(formatBytes(-1)).toBe('0 MB')
    expect(formatBytes(Number.NaN)).toBe('0 MB')
  })
})

describe('formatDate (TEST-HIST-5 — injected locale/now, no hardcoded month table)', () => {
  const now = new Date(2026, 10, 5, 12, 0)

  it('reads "Today HH:MM" for the same local calendar day', () => {
    expect(formatDate(localIso(2026, 10, 5, 10, 2), { now })).toBe('Today 10:02')
    expect(formatDate(localIso(2026, 10, 5, 0, 5), { now })).toBe('Today 00:05')
  })

  it('reads the short date for an earlier day (board order: day before month, 24-hour digits)', () => {
    expect(formatDate(localIso(2026, 9, 19, 14, 36), { now })).toBe('19 Oct 14:36')
    expect(formatDate(localIso(2025, 0, 2, 9, 4), { now })).toBe('2 Jan 09:04')
  })

  it('uses the injected locale (no hardcoded month table)', () => {
    expect(formatDate(localIso(2026, 9, 19, 14, 36), { now, locale: 'fr' })).toBe('19 oct. 14:36')
  })

  it('returns the raw stamp for an unparseable one (the honest provider bytes, never a fabricated date)', () => {
    expect(formatDate('not-a-date', { now })).toBe('not-a-date')
  })
})

describe('statusLabel (TEST-HIST-5 + qa-fixes4 ITEM-2)', () => {
  const allDone = { finished: 3, failed: 0, stopped: 0, skipped: 0, cannot_run: 0, running: 0, downloading: 0, waiting: 0 }

  it('maps the four provider buckets to the board words and the sibling status tones (DEC-9)', () => {
    expect(statusLabel('running', allDone, 3)).toEqual({ text: 'Running', tone: 'var(--txr-brand-ink)' })
    expect(statusLabel('finished', allDone, 3)).toEqual({ text: 'Done', tone: 'var(--txr-success)' })
    // ITEM-2: the stopped word is the truthful "Stopped by you" (the old
    // board word "Stopped" did not say WHO stopped the run).
    expect(statusLabel('stopped', { ...allDone, stopped: 1 }, 1)).toEqual({ text: 'Stopped by you', tone: 'var(--txr-muted)' })
    expect(statusLabel('failed', { ...allDone, failed: 1 }, 1)).toEqual({ text: 'Failed', tone: 'var(--txr-danger)' })
  })

  it('"Done" only when every method finished (ITEM-2: the partial truth words)', () => {
    expect(statusLabel('finished', { ...allDone, finished: 2, failed: 3 }, 5).text).toBe(
      'Done, 3 of 5 methods failed',
    )
    expect(statusLabel('finished', { ...allDone, finished: 6, cannot_run: 203 }, 209).text).toBe(
      'Done, 203 of 209 methods could not run',
    )
    expect(statusLabel('finished', { ...allDone, finished: 4, stopped: 1, skipped: 1 }, 6).text).toBe(
      'Done, 2 of 6 methods were stopped or skipped',
    )
    expect(statusLabel('stopped', { ...allDone, stopped: 4, skipped: 2 }, 6).text).toBe(
      'Stopped by you (2 skipped)',
    )
  })

  it('the partial-finished tone is the warning amber (the "some/partly" token), the plain Done stays green', () => {
    expect(statusLabel('finished', { ...allDone, finished: 2, failed: 3 }, 5).tone).toBe('var(--txr-warning)')
    expect(statusLabel('finished', allDone, 3).tone).toBe('var(--txr-success)')
  })

  it('a row without the engine counts falls back to the four bucket words (a pre-ITEM-2 server)', () => {
    expect(statusLabel('finished', undefined, 5).text).toBe('Done')
    expect(statusLabel('stopped', null, 6).text).toBe('Stopped')
  })

  it('is total over the provider bucket vocabulary — every bucket yields a word', () => {
    const buckets: TxrHistoryBucket[] = ['running', 'finished', 'stopped', 'failed']
    for (const bucket of buckets) {
      const { text } = statusLabel(bucket, allDone, 3)
      expect(text.trim().length, bucket).toBeGreaterThan(0)
    }
  })
})

describe('isTroubleRun + troubleReasonLine (qa-fixes4 ITEM-2 — R3-results-3)', () => {
  const counts = (over: Partial<TxrRunCounts>): TxrRunCounts => ({
    finished: 0,
    failed: 0,
    stopped: 0,
    skipped: 0,
    cannot_run: 0,
    running: 0,
    downloading: 0,
    waiting: 0,
    ...over,
  })

  it('a finished bucket with unmet methods is trouble; all-finished is not', () => {
    expect(isTroubleRun('finished', counts({ finished: 2, failed: 3 }), 5)).toBe(true)
    expect(isTroubleRun('finished', counts({ finished: 6, cannot_run: 203 }), 209)).toBe(true)
    expect(isTroubleRun('finished', counts({ finished: 6 }), 6)).toBe(false)
  })

  it('failed/stopped are always trouble, running never, and a counts-less row cannot be judged', () => {
    expect(isTroubleRun('failed', counts({ failed: 1 }), 1)).toBe(true)
    expect(isTroubleRun('stopped', counts({ stopped: 1 }), 1)).toBe(true)
    expect(isTroubleRun('running', counts({ running: 2 }), 2)).toBe(false)
    expect(isTroubleRun('finished', undefined, 5)).toBe(false)
  })

  it('the partial line names the dominant state and keeps the detail verbatim (never a re-author)', () => {
    expect(
      troubleReasonLine(counts({ finished: 2, failed: 3 }), {
        code: 'BUNDLE_MARKER_COUNT_UNMET',
        detail: 'the method needs a different number of markers than the file has',
      }),
    ).toBe('Failed: the method needs a different number of markers than the file has')
    expect(
      troubleReasonLine(counts({ finished: 6, cannot_run: 203 }), {
        code: 'ENV_UNKNOWN',
        detail: 'the method environment is not available yet',
      }),
    ).toBe('Could not run: the method environment is not available yet')
    expect(
      troubleReasonLine(counts({ finished: 4, stopped: 1, skipped: 1 }), {
        code: 'ABORTED',
        detail: 'stopped by the user',
      }),
    ).toBe('Stopped: stopped by the user')
  })

  it('never renders a blank part — the sibling constant stands in (INV-2)', () => {
    expect(troubleReasonLine(counts({ finished: 5, failed: 1 }), undefined)).toBe(
      `Failed: ${NO_REASON_RECORDED}`,
    )
  })
})

describe('modeChip (TEST-HIST-5 — the ui-list chip palette)', () => {
  it('maps train to the accent "Learned and predicted" and reuse to the neutral "Saved model"', () => {
    expect(modeChip('train')).toEqual({ label: 'Learned and predicted', tone: 'accent' })
    expect(modeChip('reuse')).toEqual({ label: 'Saved model', tone: 'neutral' })
  })

  it('never renders blank for a mode outside the vocabulary (a regen between regens)', () => {
    expect(modeChip('future-mode' as TxrRunMode).label.length).toBeGreaterThan(0)
  })
})

describe('endpointLabel (TEST-HIST-5)', () => {
  it('reads the board endpoint lines', () => {
    expect(endpointLabel('pfs', 238)).toBe('progression, death by day 238')
    expect(endpointLabel('os', 238)).toBe('death by day 238')
    expect(endpointLabel('pfs', 56)).toBe('progression, death by day 56')
  })
})

describe('reasonLine (TEST-HIST-5 — the provider detail is VERBATIM)', () => {
  const reason = (detail: string): TxrRunReason => ({ code: 'MARKER_MISSING', detail })

  it('reads the board lines with the provider detail verbatim (a re-authored detail fails)', () => {
    expect(reasonLine('stopped', reason('marker LDH is missing from the measurements'))).toBe(
      'Stopped: marker LDH is missing from the measurements',
    )
    expect(reasonLine('failed', reason('the method integer-divided by zero'))).toBe(
      'Failed: the method integer-divided by zero',
    )
  })

  it('omits the segment for running and finished runs', () => {
    expect(reasonLine('running', reason('x'))).toBeNull()
    expect(reasonLine('finished', reason('x'))).toBeNull()
  })

  it('never renders a blank failure — an unrecorded/blank detail reads the sibling constant (INV-2)', () => {
    expect(reasonLine('stopped', undefined)).toBe(`Stopped: ${NO_REASON_RECORDED}`)
    expect(reasonLine('failed', reason('   '))).toBe(`Failed: ${NO_REASON_RECORDED}`)
  })

  it('treats a `null` reason like an absent one — the wire null IS the generator’s "no property" (RES-01)', () => {
    // The blocker: the engine's `Option` serializes the absent reason as
    // JSON `null` while the generated type renders it optional-only; the
    // old `!== undefined` guard read `null.detail` and crashed the page.
    expect(reasonLine('finished', null as unknown as TxrRunReason)).toBeNull()
    expect(reasonLine('running', null as unknown as TxrRunReason)).toBeNull()
    expect(reasonLine('failed', null as unknown as TxrRunReason)).toBe(
      `Failed: ${NO_REASON_RECORDED}`,
    )
    expect(reasonLine('stopped', null as unknown as TxrRunReason)).toBe(
      `Stopped: ${NO_REASON_RECORDED}`,
    )
  })
})

describe('tookLine (TEST-HIST-5)', () => {
  it('reads the board Took line exactly', () => {
    expect(tookLine(190, 240)).toBe('3 minutes 10 seconds (estimated 4 minutes)')
  })

  it('reads the elapsed alone when no estimate was recorded', () => {
    expect(tookLine(190, null)).toBe('3 minutes 10 seconds')
    expect(tookLine(190, undefined)).toBe('3 minutes 10 seconds')
    expect(tookLine(120, null)).toBe('2 minutes')
  })

  it('omits the whole segment when no elapsed was recorded (never a fabricated took)', () => {
    expect(tookLine(null, 240)).toBeNull()
    expect(tookLine(undefined, 240)).toBeNull()
  })

  it('drops the parenthetical when the estimate cannot be read', () => {
    expect(tookLine(190, -5)).toBe('3 minutes 10 seconds')
    expect(tookLine(190, Number.NaN)).toBe('3 minutes 10 seconds')
  })
})

describe('displayBucketOf (qa-fixes2 R2-02 — the failed-run presentation)', () => {
  it('presents a finished run with no finished method as failed', () => {
    // The engine's own truth: `predictions_ready = counts.finished > 0` —
    // the row's can_reopen/can_download flags carry it.
    expect(displayBucketOf({ bucket: 'finished', can_reopen: false })).toBe('failed')
    expect(displayBucketOf({ bucket: 'finished', can_reopen: true })).toBe('finished')
    expect(displayBucketOf({ bucket: 'running', can_reopen: false })).toBe('running')
    expect(displayBucketOf({ bucket: 'stopped', can_reopen: false })).toBe('stopped')
    expect(displayBucketOf({ bucket: 'failed', can_reopen: false })).toBe('failed')
  })

  it('the failed presentation reads the provider reason line (round-1 hidden reason)', () => {
    // The row's wire bucket is finished (the engine scheduler ran), yet a
    // K row with nothing finished reads Failed + the first terminal
    // reason — the exact shape of the report's a9f2119c / 97b25262 rows.
    const reason: TxrRunReason = {
      code: 'ENV_UNREADY',
      detail: 'oras is not installed',
    }
    expect(
      statusLabel(displayBucketOf({ bucket: 'finished', can_reopen: false }), undefined, 1).text,
    ).toBe('Failed')
    expect(
      reasonLine(displayBucketOf({ bucket: 'finished', can_reopen: false }), reason),
    ).toBe('Failed: oras is not installed')
    expect(
      reasonLine(displayBucketOf({ bucket: 'finished', can_reopen: false }), {
        code: 'ENV_UNKNOWN',
        detail: 'no published environment for method bayes-pt-cure-joint',
      }),
    ).toBe('Failed: no published environment for method bayes-pt-cure-joint')
    // A finished run that DID finish keeps the facts line (no reason).
    expect(reasonLine(displayBucketOf({ bucket: 'finished', can_reopen: true }), reason)).toBeNull()
  })
})
