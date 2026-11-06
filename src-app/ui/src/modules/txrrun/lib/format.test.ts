/**
 * TEST-RUN-03 / TEST-RUN-04 / TEST-RUN-05 — txrrun state vocabulary, board
 * copy formatters and the lib copy scan (PROV-UI-RUN-2, INV-4/5/6; ITEM-2).
 *
 * The pins are the frozen contracts:
 *
 * - TEST-RUN-03: the engine's eight per-method states (PROV-EE-3, the
 *   generated `TxrMethodState`) map 1:1 onto `TxrRunBucket` — `bucketOf`
 *   is a total function over the whole vocabulary and
 *   `STATE_LABEL`/`STATE_TONE` give every state a constant label and tone,
 *   never blank;
 * - TEST-RUN-04: the formatters produce the boards' strings (DEC-3, DEC-11
 *   — `BusyRunning.dc.html`'s time bytes and the run screens' shared
 *   download line), null-safe, clamped at zero and never blank;
 * - TEST-RUN-05 [acceptance] [invariant: INV-5]: the module's own lib copy
 *   is the publish surface — `RESEARCH_NOTICE` is the boards' string
 *   verbatim (one source for both run screens) and no copy constant
 *   carries a `stud(y|ies)` token, a work-status word or a URL literal.
 *
 * Board numbers never asserted as data (INV-6): the expected strings below
 * are FORMATTER pins (the boards' words produced from arbitrary inputs),
 * not facts about a run; inputs and expected values are the formatter's
 * own test values.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TxrMethodState, TxrRunMethod, TxrRunProgressFrame } from '@/api-client/types'
import type { TxrRunBucket } from '../types'
import {
  RESEARCH_NOTICE,
  STATE_LABEL,
  STATE_TONE,
  bucketOf,
  formatBytes,
  formatProgress,
  formatSecs,
  formatTimeLeft,
} from './format'

const MB = 1024 * 1024

/** The whole engine vocabulary (PROV-EE-3) — an added state fails the pin below. */
const STATES: TxrMethodState[] = [
  'waiting',
  'downloading',
  'running',
  'finished',
  'failed',
  'stopped',
  'skipped',
  'cannot_run',
]

/** The F-tab partition (DEC-2) — the complete function table. */
const BUCKET: Record<TxrMethodState, Exclude<TxrRunBucket, 'all'>> = {
  waiting: 'working',
  downloading: 'working',
  running: 'working',
  finished: 'finished',
  stopped: 'finished',
  skipped: 'finished',
  failed: 'failed',
  cannot_run: 'failed',
}

describe('bucketOf (TEST-RUN-03)', () => {
  it('is a total function over the engine state vocabulary — the four-tab partition', () => {
    for (const state of STATES) {
      expect(bucketOf(state), state).toBe(BUCKET[state])
    }
    // The three non-All buckets are all reachable (a complete partition:
    // no state invisible to every tab, no bucket left empty by contract).
    const reached = new Set(STATES.map(s => bucketOf(s)))
    expect(reached).toEqual(new Set<Exclude<TxrRunBucket, 'all'>>(['working', 'finished', 'failed']))
  })

  it('never returns the All bucket and never returns blank', () => {
    for (const state of STATES) {
      const bucket = bucketOf(state)
      expect(bucket).not.toBe('all')
      expect(bucket.length).toBeGreaterThan(0)
    }
  })
})

describe('STATE_LABEL / STATE_TONE (TEST-RUN-03)', () => {
  it('gives every state the board label — the state word lower case, never blank', () => {
    const expected: Record<TxrMethodState, string> = {
      waiting: 'waiting',
      downloading: 'downloading',
      running: 'running',
      finished: 'finished',
      failed: 'failed',
      stopped: 'stopped',
      skipped: 'skipped',
      cannot_run: 'cannot run',
    }
    for (const state of STATES) {
      expect(STATE_LABEL[state], state).toBe(expected[state])
      expect(STATE_LABEL[state].length).toBeGreaterThan(0)
    }
    // Board casing: the label is the state id spelled out (cannot_run → "cannot run").
    for (const state of STATES) {
      expect(STATE_LABEL[state]).toBe(state.replace(/_/g, ' '))
    }
  })

  it('gives every state the shared list palette tone, never blank', () => {
    const expected: Record<TxrMethodState, string> = {
      waiting: '#5e5e5e',
      downloading: '#8a5a00',
      running: '#143a68',
      finished: '#1f6b3a',
      failed: '#b3261e',
      stopped: '#5e5e5e',
      skipped: '#5e5e5e',
      cannot_run: '#b3261e',
    }
    for (const state of STATES) {
      expect(STATE_TONE[state], state).toBe(expected[state])
      expect(STATE_TONE[state].length).toBeGreaterThan(0)
    }
  })
})

describe('formatSecs (TEST-RUN-04)', () => {
  it('renders the board exact duration words', () => {
    expect(formatSecs(280)).toBe('4 min 40 s')
    expect(formatSecs(112)).toBe('1 min 52 s')
  })

  it('reads under a minute for any sub-minute span', () => {
    expect(formatSecs(12)).toBe('under a minute')
    expect(formatSecs(59)).toBe('under a minute')
  })

  it('reads whole minutes as the minutes only, and null/negative spans as the placeholder', () => {
    expect(formatSecs(60)).toBe('1 min')
    expect(formatSecs(420)).toBe('7 min')
    expect(formatSecs(null)).toBe('—')
    expect(formatSecs(-5)).toBe('—')
    expect(formatSecs(Number.NaN)).toBe('—')
  })
})

describe('formatTimeLeft (TEST-RUN-04)', () => {
  it('subtracts the elapsed from the run estimate and announces it as about', () => {
    expect(formatTimeLeft({ schedule_seconds: 840 }, 420)).toBe('about 7 minutes left')
    expect(formatTimeLeft({ schedule_seconds: 840 }, 0)).toBe('about 14 minutes left')
  })

  it('uses the singular minute for one minute', () => {
    expect(formatTimeLeft({ schedule_seconds: 60 }, 0)).toBe('about 1 minute left')
  })

  it('clamps at zero — an overrun never reads negative — under a minute at the floor', () => {
    expect(formatTimeLeft({ schedule_seconds: 300 }, 320)).toBe('under a minute left')
    expect(formatTimeLeft({ schedule_seconds: 30 }, 0)).toBe('under a minute left')
  })

  it('returns null with no estimate and treats a missing elapsed as a just-started run', () => {
    expect(formatTimeLeft(null, 420)).toBeNull()
    expect(formatTimeLeft({ schedule_seconds: 840 }, null)).toBe('about 14 minutes left')
  })
})

describe('formatBytes (TEST-RUN-04)', () => {
  it('renders the board download line from the byte counters', () => {
    expect(formatBytes(160 * MB, 250 * MB)).toBe('160 of 250 MB')
    expect(formatBytes(171 * MB, 250 * MB)).toBe('171 of 250 MB')
  })

  it('renders the bytes only when the total is null', () => {
    expect(formatBytes(160 * MB, null)).toBe('160 MB')
    expect(formatBytes(0, 250 * MB)).toBe('0 of 250 MB')
  })
})

describe('formatProgress (TEST-RUN-04)', () => {
  const row = (state: TxrMethodState, extra: Partial<TxrRunMethod> = {}): TxrRunMethod => ({
    method_id: 'method-a',
    label: 'method-a',
    version: '1.0.0',
    group: 'response-call',
    group_label: 'Response call',
    state,
    bytes_downloaded: 0,
    ...extra,
  })
  const frame = (message: string): TxrRunProgressFrame => ({ method_id: 'method-a', message })

  it('renders the download line while downloading', () => {
    expect(
      formatProgress(
        row('downloading', { bytes_downloaded: 160 * MB, bytes_total: 250 * MB }),
        null,
      ),
    ).toBe('160 of 250 MB')
  })

  it('renders the latest engine message while running, empty between messages', () => {
    expect(formatProgress(row('running'), frame('tree 140 of 500'))).toBe('tree 140 of 500')
    expect(formatProgress(row('running'), null)).toBe('')
    expect(formatProgress(row('running'), { method_id: 'method-a' })).toBe('')
  })

  it('renders the failure reason, never a blank line, for failed and cannot run', () => {
    const reason = { code: 'ABORTED', detail: 'cleared by the user' }
    expect(formatProgress(row('failed', { reason }), null)).toBe('cleared by the user')
    expect(formatProgress(row('cannot_run', { reason }), null)).toBe('cleared by the user')
    const missing = formatProgress(row('failed'), null)
    expect(missing.length).toBeGreaterThan(0)
    expect(missing).toBe('no reason recorded')
  })

  it('renders an empty detail line for the terminal non-error states and waiting', () => {
    expect(formatProgress(row('waiting'), null)).toBe('')
    expect(formatProgress(row('finished'), null)).toBe('')
    expect(formatProgress(row('stopped'), null)).toBe('')
    expect(formatProgress(row('skipped'), null)).toBe('')
  })
})

describe('RESEARCH_NOTICE + the lib copy scan (TEST-RUN-05, INV-5)', () => {
  it("pins the research-use notice — the boards' own line, one constant for both run screens", () => {
    expect(RESEARCH_NOTICE).toBe("For research. Not for deciding a patient's treatment.")
  })

  /** The module's lib copy: the .ts source files of `lib/` (the tests excluded — verification artifacts). */
  function libCopy(): string {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    return readdirSync(dir)
      .filter(f => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
      .sort()
      .map(f => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n')
  }

  /** The copy's string constants (quoted + template literals), not the identifiers. */
  function stringConstants(source: string): string[] {
    const out: string[] = []
    const literal = /(['"`])((?:\\.|(?!\1).)*)\1/g
    for (const match of source.matchAll(literal)) out.push(match[2])
    return out
  }

  it('carries no study literal, no work-status word and no URL in its lib copy', () => {
    const constants = stringConstants(libCopy())
    const studyRe = new RegExp('st' + 'ud(y|ies)', 'i')
    const statusRe = /\b(phase|progress|placeholder|todo|tbd)\b/i
    for (const constant of constants) {
      expect(studyRe.test(constant), constant).toBe(false)
      expect(statusRe.test(constant), constant).toBe(false)
    }
    expect(libCopy()).not.toContain('http' + '://')
  })
})
