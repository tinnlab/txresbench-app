import { describe, expect, it } from 'vitest'
import {
  exitCodeLabel,
  formatDurationMs,
  formatJobDuration,
  formatRelative,
  formatTimestamp,
  jobElapsedMs,
  primaryTimestamp,
  type TimedJobLike,
} from './jobTiming'

// TEST-1 [acceptance INV-3] + TEST-2 (ITEM-1): timing is HUMANIZED, never raw ms/ISO/epoch.

describe('formatDurationMs — humanized, never raw ms (INV-3)', () => {
  it('sub-second → ms, <60s → s, <60m → m s, ≥1h → h mm', () => {
    expect(formatDurationMs(820)).toBe('820ms')
    expect(formatDurationMs(42_000)).toBe('42s')
    expect(formatDurationMs(133_000)).toBe('2m 13s')
    expect(formatDurationMs(120_000)).toBe('2m')
    expect(formatDurationMs(3_840_000)).toBe('1h 04m')
  })
  it('never prints NaN / a negative span', () => {
    expect(formatDurationMs(Number.NaN)).toBe('—')
    expect(formatDurationMs(-5)).toBe('—')
  })
  it('rolls a near-1000ms span over to seconds instead of printing "1000ms"', () => {
    expect(formatDurationMs(999.6)).toBe('1s')
    expect(formatDurationMs(999)).toBe('999ms')
  })
})

describe('formatRelative (INV-3 relative hint)', () => {
  const now = Date.parse('2026-07-19T12:00:00Z')
  it('humanizes each bucket, past and future, and "now" at 0', () => {
    expect(formatRelative('2026-07-19T12:00:00Z', now)).toBe('now')
    expect(formatRelative('2026-07-19T11:59:48Z', now)).toBe('12 seconds ago')
    expect(formatRelative('2026-07-19T11:57:00Z', now)).toBe('3 minutes ago')
    expect(formatRelative('2026-07-19T10:00:00Z', now)).toBe('2 hours ago')
    expect(formatRelative('2026-07-17T12:00:00Z', now)).toBe('2 days ago')
    expect(formatRelative('2026-07-19T12:02:00Z', now)).toBe('in 2 minutes')
  })
  it('is empty for an absent/unparseable instant', () => {
    expect(formatRelative(undefined, now)).toBe('')
    expect(formatRelative('nope', now)).toBe('')
  })
})

describe('jobElapsedMs / formatJobDuration', () => {
  const base: TimedJobLike = { status: 'completed', created_at: '2026-07-19T12:00:00Z' }

  it('completed: finished − started', () => {
    const job = { ...base, started_at: '2026-07-19T12:00:01Z', finished_at: '2026-07-19T12:02:05Z' }
    expect(jobElapsedMs(job)).toBe(124_000)
    expect(formatJobDuration(job)).toBe('2m 4s')
  })
  it('running: now − started (live)', () => {
    const now = Date.parse('2026-07-19T12:00:43Z')
    const job: TimedJobLike = { status: 'running', created_at: base.created_at, started_at: '2026-07-19T12:00:01Z' }
    expect(jobElapsedMs(job, now)).toBe(42_000)
    expect(formatJobDuration(job, now)).toBe('42s')
  })
  it('queued (never started) → no duration', () => {
    const job: TimedJobLike = { status: 'queued', created_at: base.created_at }
    expect(jobElapsedMs(job)).toBeNull()
    expect(formatJobDuration(job)).toBeNull()
  })
  it('finished but never started (refused before spawn) → no duration, no crash', () => {
    const job: TimedJobLike = { status: 'failed', created_at: base.created_at, finished_at: '2026-07-19T12:00:05Z' }
    expect(jobElapsedMs(job)).toBeNull()
  })
})

describe('timestamp / exit-code labels (TEST-2, ITEM-1)', () => {
  it('formatTimestamp renders an absolute datetime, not the raw ISO string', () => {
    const out = formatTimestamp('2026-07-19T12:02:05Z')
    // Locale-robust: it must differ from the raw ISO, carry a 4-digit year and a
    // HH:MM time separator — without asserting a specific locale's month spelling.
    expect(out).not.toBe('2026-07-19T12:02:05Z')
    expect(out).toContain('2026')
    expect(out).toMatch(/\d{1,2}:\d{2}/)
  })
  it('formatTimestamp degrades absent/garbage to a dash, never NaN/Invalid', () => {
    expect(formatTimestamp(undefined)).toBe('—')
    expect(formatTimestamp('not-a-date')).toBe('—')
  })
  it('exitCodeLabel phrases 0 and 1, and is null when absent', () => {
    expect(exitCodeLabel({ status: 'completed', created_at: '', exit_code: 0 })).toBe('exit 0')
    expect(exitCodeLabel({ status: 'failed', created_at: '', exit_code: 1 })).toBe('exit 1')
    expect(exitCodeLabel({ status: 'running', created_at: '' })).toBeNull()
  })
  it('primaryTimestamp picks finished → started → created by state', () => {
    expect(primaryTimestamp({ status: 'completed', created_at: 'c', started_at: 's', finished_at: 'f' })).toEqual({ label: 'Finished', iso: 'f' })
    expect(primaryTimestamp({ status: 'running', created_at: 'c', started_at: 's' })).toEqual({ label: 'Started', iso: 's' })
    expect(primaryTimestamp({ status: 'queued', created_at: 'c' })).toEqual({ label: 'Queued', iso: 'c' })
  })
})
