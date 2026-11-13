/**
 * TEST-RUN-03 / TEST-RUN-04 / TEST-RUN-05 — txrrun state vocabulary, board
 * copy formatters and the lib copy scan (PROV-UI-RUN-2, INV-4/5/6; ITEM-2).
 *
 * The pins are the frozen contracts:
 *
 * - TEST-RUN-03: the engine's eight per-method states (PROV-EE-3, the
 *   generated `TxrMethodState`) map 1:1 onto `TxrRunBucket` — `bucketOf`
 *   is a total function over the whole vocabulary (one bucket per engine
 *   state, the three doing states under the board's Working tab; qa-fixes
 *   ITEM-3 RP-3) and `STATE_LABEL`/`STATE_TONE` give every state a
 *   constant label and tone, never blank;
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
import type { TxrMethodState, TxrRunLogLine, TxrRunMethod, TxrRunProgressFrame } from '@/api-client/types'
import type { TxrRunBucket } from '../types'
import {
  RESEARCH_NOTICE,
  STATE_LABEL,
  STATE_TONE,
  bucketOf,
  collapseRepeatedLines,
  estimateQualityWord,
  formatBytes,
  formatCollapsedLogLine,
  formatLogLine,
  formatProgress,
  formatRowTime,
  formatSecs,
  formatTimeLeft,
  isTechnicalLogNoise,
  methodLabelOf,
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

/** The F-tab partition (qa-fixes ITEM-3, RP-3) — the complete function
 *  table: one bucket per ENGINE STATE (the three doing states share the
 *  board's Working tab), so a state is never counted under another state's
 *  tab. */
const BUCKET: Record<TxrMethodState, Exclude<TxrRunBucket, 'all'>> = {
  waiting: 'working',
  downloading: 'working',
  running: 'working',
  finished: 'finished',
  stopped: 'stopped',
  skipped: 'skipped',
  failed: 'failed',
  cannot_run: 'cannot_run',
}

describe('bucketOf (TEST-RUN-03)', () => {
  it('is a total function over the engine state vocabulary — one bucket per engine state', () => {
    for (const state of STATES) {
      expect(bucketOf(state), state).toBe(BUCKET[state])
    }
    // Every non-All bucket is reachable (a complete partition: no state
    // invisible to every tab, no bucket left empty by contract), and the
    // buckets carry the engine's OWN state words — a skipped method is
    // never counted as finished, a cannot-run method never as failed.
    const reached = new Set(STATES.map(s => bucketOf(s)))
    expect(reached).toEqual(
      new Set<Exclude<TxrRunBucket, 'all'>>([
        'working',
        'finished',
        'failed',
        'stopped',
        'skipped',
        'cannot_run',
      ]),
    )
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
      waiting: 'var(--txr-muted)',
      downloading: 'var(--txr-warning)',
      running: 'var(--txr-brand-ink)',
      finished: 'var(--txr-success)',
      failed: 'var(--txr-danger)',
      stopped: 'var(--txr-muted)',
      skipped: 'var(--txr-muted)',
      cannot_run: 'var(--txr-danger)',
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

  it('reads a sub-minute span as its whole seconds (qa-fixes2 R2-2/R2-4 — "under a minute" never moved on a sub-minute run)', () => {
    expect(formatSecs(12)).toBe('12 s')
    expect(formatSecs(59)).toBe('59 s')
    expect(formatSecs(3)).toBe('3 s')
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

  it('a sub-minute remainder reads its real seconds — never the constant "under a minute left" (qa-fixes4 ITEM-3, methods-r3 R2-2 leftover)', () => {
    expect(formatTimeLeft({ schedule_seconds: 540 }, 520)).toBe('about 20 s left')
    expect(formatTimeLeft({ schedule_seconds: 30 }, 0)).toBe('about 30 s left')
    expect(formatTimeLeft({ schedule_seconds: 60 }, 1)).toBe('about 59 s left')
  })

  it('an overrun reads "finishing up" — the estimate\'s schedule elapsed, the run is finalizing (never a negative)', () => {
    expect(formatTimeLeft({ schedule_seconds: 300 }, 320)).toBe('finishing up')
    expect(formatTimeLeft({ schedule_seconds: 300 }, 300)).toBe('finishing up')
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

  it('an env-missing row reads the list\'s one sentence, not the engine\'s stored detail (qa-fixes4 ITEM-3, methods-r3 R3-methods-9)', () => {
    // The engine stores the OLD pre-vocabulary sentence under the shared
    // ENV_IMAGE_MISSING code (orchestrator: "no published environment for
    // method \"<id>\""); the method list says "no published environment
    // available" for the same code — the row reads the list's words.
    const oldWording = {
      code: 'ENV_IMAGE_MISSING',
      detail: 'no published environment for method "bayes-pt-cure-joint"',
    }
    expect(formatProgress(row('cannot_run', { reason: oldWording }), null)).toBe(
      'no published environment available',
    )
    expect(formatProgress(row('failed', { reason: oldWording }), null)).toBe(
      'no published environment available',
    )
    // A non-env code keeps the engine's stored words (the row's own fact).
    expect(
      formatProgress(
        row('cannot_run', {
          reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements.' },
        }),
        null,
      ),
    ).toBe('LDH is not in your measurements.')
  })

  it('renders an empty detail line for the terminal non-error states and waiting', () => {
    expect(formatProgress(row('waiting'), null)).toBe('')
    expect(formatProgress(row('finished'), null)).toBe('')
    expect(formatProgress(row('stopped'), null)).toBe('')
    expect(formatProgress(row('skipped'), null)).toBe('')
  })
})

describe('formatRowTime + methodLabelOf (qa-fixes RES-01 null-vs-undefined)', () => {
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

  it('a null duration_ms reads an empty time cell — never "done in —" (the wire null IS absent)', () => {
    expect(formatRowTime(row('finished', { duration_ms: 90_000 }))).toBe('done in 1 min 30 s')
    expect(formatRowTime(row('finished', { duration_ms: null as unknown as number }))).toBe('')
    expect(formatRowTime(row('finished'))).toBe('')
    // The elapsed guard reads null the same way (no duration mark, not a dash).
    expect(formatRowTime(row('running', { elapsed_secs: null as unknown as number }))).toBe('')
  })

  it('a finished row reads the engine\'s own elapsed_secs FIRST — the same count the log line words (qa-fixes4 ITEM-3, methods-r3 R3-methods-8)', () => {
    // The round-3 pair: duration_ms 6286 (→ "6 s" by rounding) against the
    // engine's log/elapsed 7 — the row now reads elapsed_secs so the table
    // cell and the log quote are one count.
    expect(formatRowTime(row('finished', { elapsed_secs: 7, duration_ms: 6286 }))).toBe(
      'done in 7 s',
    )
    // No elapsed (an old row): the duration_ms fallback keeps the R2-4 word.
    expect(formatRowTime(row('finished', { duration_ms: 112_000 }))).toBe('done in 1 min 52 s')
  })

  it('a skipped row never reads a done line (it never ran) and a stopped row reads its elapsed (RP-7)', () => {
    expect(formatRowTime(row('skipped', { duration_ms: 90_000 }))).toBe('')
    expect(formatRowTime(row('skipped', { elapsed_secs: 12 }))).toBe('')
    expect(formatRowTime(row('stopped', { elapsed_secs: 47 }))).toBe('47 s')
    expect(formatRowTime(row('stopped', { elapsed_secs: null as unknown as number }))).toBe('')
  })

  it('a running/downloading row reads its LIVE elapsed from the page clock against the row start (qa-fixes2 R2-4)', () => {
    const start = '2026-11-06T00:00:40Z'
    const nowMs = Date.parse('2026-11-06T00:01:30Z')
    expect(formatRowTime(row('running', { started_at: start }), nowMs)).toBe('50 s')
    expect(formatRowTime(row('downloading', { started_at: start }), nowMs)).toBe('50 s')
    // No clock (or no anchor): the engine's last snapshot, or nothing.
    expect(formatRowTime(row('running', { started_at: start }))).toBe('')
    expect(formatRowTime(row('running', { elapsed_secs: 21 }))).toBe('21 s')
    // A clock BEFORE the start (skew must not print a negative).
    expect(formatRowTime(row('running', { started_at: start }), nowMs - 120_000)).toBe('')
  })

  it('hides the "0 of 0 MB" detail — nothing downloaded is no download line (qa-fixes2 R2-4)', () => {
    expect(
      formatProgress(
        row('downloading', { bytes_downloaded: 0, bytes_total: 4096 }),
        null,
      ),
    ).toBe('')
    expect(formatProgress(row('downloading', { bytes_downloaded: 0 }), null)).toBe('')
    expect(
      formatProgress(
        row('downloading', { bytes_downloaded: 160 * MB, bytes_total: 250 * MB }),
        null,
      ),
    ).toBe('160 of 250 MB')
  })

  it('a null log-line method id is an engine-level line — never a "[null]" bracket', () => {
    const methods = [{ method_id: 'method-a', label: 'method-a' }]
    const engineLine: TxrRunLogLine = {
      seq: 1,
      content: 'run started',
      stream: 'stdout',
      created_at: '2026-11-01T05:00:00Z',
      method_id: null as unknown as string,
    }
    expect(methodLabelOf(engineLine, methods)).toBe('stdout')
    expect(formatLogLine(engineLine, methods)).toContain('[stdout] run started')
    expect(formatLogLine(engineLine, methods)).not.toContain('[null]')
    expect(
      methodLabelOf({ ...engineLine, method_id: 'method-a' }, methods),
    ).toBe('method-a')
  })
})

describe('estimateQualityWord (qa-fixes2 R2-3)', () => {
  it('spells the estimate\'s provenance honestly, and nothing when the run has no quality fact', () => {
    expect(estimateQualityWord('measured')).toBe('measured estimate')
    expect(estimateQualityWord('estimate')).toBe('rough estimate')
    expect(estimateQualityWord(null)).toBeNull()
    expect(estimateQualityWord(undefined)).toBeNull()
  })
})

describe('isTechnicalLogNoise (qa-fixes2 R2-5)', () => {
  const line = (content: string): TxrRunLogLine => ({
    seq: 1,
    content,
    stream: 'stderr',
    created_at: '2026-11-06T05:00:00Z',
  })

  it('names the setlocale / R start-up lines as technical output — never the run\'s own lines', () => {
    expect(isTechnicalLogNoise(line('/bin/bash: warning: setlocale: LC_ALL: cannot change locale (C.UTF-8)'))).toBe(true)
    expect(isTechnicalLogNoise(line('During startup - Warning messages:'))).toBe(true)
    expect(isTechnicalLogNoise(line('1: Setting LC_CTYPE failed, using "C"'))).toBe(true)
    expect(isTechnicalLogNoise(line('7: Setting LC_MEASUREMENT failed'))).toBe(true)
    expect(isTechnicalLogNoise(line('cox-baseline-delta done in 12s'))).toBe(false)
    expect(isTechnicalLogNoise(line('fitting the model'))).toBe(false)
  })
})

describe('collapseRepeatedLines + formatCollapsedLogLine (qa-fixes4 ITEM-3, methods-r3 R3-methods-5)', () => {
  const line = (seq: number, method_id: string | undefined, content: string): TxrRunLogLine => ({
    seq,
    method_id,
    stream: method_id === undefined ? 'engine' : 'stdout',
    content,
    created_at: '2026-11-06T10:02:12Z',
  })
  const METHODS = [{ method_id: 'm', label: 'm' }]

  it('a twice-printed 3-line warning block collapses to one block with the ×6 badge on its first line', () => {
    const lines = [
      line(1, 'm', 'Warning message:'),
      line(2, 'm', 'In read.table(file = file, header = header, sep = sep, quote = quote,  :'),
      line(3, 'm', "  not all columns named in 'colClasses' exist"),
      line(4, 'm', 'Warning message:'),
      line(5, 'm', 'In read.table(file = file, header = header, sep = sep, quote = quote,  :'),
      line(6, 'm', "  not all columns named in 'colClasses' exist"),
    ]
    const collapsed = collapseRepeatedLines(lines)
    expect(collapsed).toHaveLength(3)
    // Each line printed twice; the run's badge counts its 6 raw lines.
    expect(collapsed.map(e => e.count)).toEqual([2, 2, 2])
    expect(collapsed.map(e => e.runLength)).toEqual([6, 6, 6])
    expect(collapsed.map(e => e.runStart)).toEqual([true, false, false])
    // The × badge rides the run's first line (clock omitted — the test
    // host's local TZ shifts the rendered hour; the suffix is the fact).
    expect(fmt(collapsed[0]).endsWith('Warning message: ×6')).toBe(true)
    expect(fmt(collapsed[1])).toContain(
      'In read.table(file = file, header = header, sep = sep, quote = quote,  :',
    )
    expect(fmt(collapsed[2])).toContain("  not all columns named in 'colClasses' exist")
  })

  it('an identical line repeated N times collapses to one line ×N', () => {
    const lines = [
      line(1, 'm', 'same'),
      line(2, 'm', 'same'),
      line(3, 'm', 'same'),
    ]
    const collapsed = collapseRepeatedLines(lines)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].count).toBe(3)
    expect(collapsed[0].runLength).toBe(3)
    expect(fmt(collapsed[0]).endsWith('same ×3')).toBe(true)
  })

  it('a truncated tail is never claimed as a repeat: [A,B,A,B,A] reads A,B ×4 then A', () => {
    const lines = [
      line(1, 'm', 'A'),
      line(2, 'm', 'B'),
      line(3, 'm', 'A'),
      line(4, 'm', 'B'),
      line(5, 'm', 'A'),
    ]
    const collapsed = collapseRepeatedLines(lines)
    expect(collapsed).toHaveLength(3)
    expect(collapsed.map(e => e.count)).toEqual([2, 2, 1])
    expect(collapsed.map(e => e.runLength)).toEqual([4, 4, 1])
    expect(collapsed.map(e => e.runStart)).toEqual([true, false, false])
  })

  it('the longest repeated run wins — a stream that is also A,A never fragments (A,A,B,A,A,B stays the (A,A,B) block)', () => {
    const lines = [
      line(1, 'm', 'A'),
      line(2, 'm', 'A'),
      line(3, 'm', 'B'),
      line(4, 'm', 'A'),
      line(5, 'm', 'A'),
      line(6, 'm', 'B'),
    ]
    const collapsed = collapseRepeatedLines(lines)
    expect(collapsed).toHaveLength(3)
    expect(collapsed[0].count).toBe(2)
    expect(collapsed[0].runLength).toBe(6)
    expect(collapsed[0].runStart).toBe(true)
  })

  it('a first-pair match is never a repeat: [A,A,A,B] reads A ×3 then B', () => {
    const lines = [line(1, 'm', 'A'), line(2, 'm', 'A'), line(3, 'm', 'A'), line(4, 'm', 'B')]
    const collapsed = collapseRepeatedLines(lines)
    expect(collapsed.map(e => e.count)).toEqual([3, 1])
    expect(collapsed.map(e => e.runLength)).toEqual([3, 1])
  })

  it('the same text from two methods is NOT a repeat (identity is method + content)', () => {
    const lines = [line(1, 'm1', 'same'), line(2, 'm2', 'same')]
    const collapsed = collapseRepeatedLines(lines)
    expect(collapsed).toHaveLength(2)
    expect(collapsed.map(e => e.count)).toEqual([1, 1])
  })

  function fmt(entry: ReturnType<typeof collapseRepeatedLines>[number]): string {
    return formatCollapsedLogLine(entry, METHODS)
  }
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
