// @vitest-environment node
/**
 * TEST-HIST-9 — the txrhistory fixtures + gallery cassette (ITEM-6;
 * PROV-HIST-6, INV-6).
 *
 * The gallery stories (PROV-HIST-6) are driven entirely by the synthetic
 * `fixtures.ts`; these pins keep the "fixture" honest and the boards'
 * design-example facts out of the module:
 *
 * - every fixture run id is the namespaced synthetic uuid (the stable
 *   generator — never a real run id, never a random one);
 * - the one patient-id-bearing shape is the fixture log capture: `S\d{4,}`
 *   ids only (never a board `P0###` patient id); the K wire itself carries
 *   no patient list, so the plan's "patient ids S0000…" provision has its
 *   real subject here — the log line naming the first fixture patient;
 * - no board example count/duration/size enters code or data (the
 *   151/38/56/238/312 MB/4-runs family is never spelled; the fixture's
 *   numbers come from the fixed spreads — 46/13/48/21 patients, the 289
 *   MiB usage figure, the hour-step timestamps);
 * - no decimal literal in the fixture sources (the family carries no
 *   probability value — a decimal would be a board-shaped number; the
 *   catalogue VERSION strings are data, stripped before the scan);
 * - no protected-tree access (`restricted/`, `datasets/`, `results/`)
 *   and no dynamic import or fetch in the fixture file;
 * - the cassette mocks EXACTLY the ten operations this node consumes
 *   (CONS-HIST-1..11) and no others: the seven ownable ones at module
 *   scope (the one-owner rule — a sibling-owned key at module scope
 *   would throw in `mergeModuleCassettes`), the sibling-owned
 *   `History.getPreferences` (txrrun), `Txr.updateAnalysisConfig`
 *   (txrrun) and `Txr.listRunLogs` (txrresults) as per-story story
 *   seeds only — an unknown operation key in `gallery.tsx` fails here;
 * - the family is internally consistent: the six runs are newest-first
 *   with unique ids, every run has a detail, the usage segments sum to
 *   the total, the log capture is seq-ascending, the page helper
 *   answers the provider's own q/kind/status + paging semantics over
 *   the family (never a client-side sieve), and the paging family has
 *   25 runs (20-row first page + the Load-more continuation).
 *
 * No store, no DOM: the fixture/cassette layer is data; the story
 * behavior is the gallery-e2e spec's (TEST-HIST-11..14, ITEM-7).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TXHISTORY_DETAILS,
  TXHISTORY_LOGS,
  TXHISTORY_RERUN_SUMMARY,
  TXHISTORY_RUNS,
  TXHISTORY_RUNS_MANY,
  TXHISTORY_RUN_BOARD_TRAIN,
  TXHISTORY_USAGE,
  fixtureHistoryPage,
  fixtureLogsFor,
  fixtureRunId,
  fixtureUsage,
  fxPatientId,
  fxTimestamp,
} from './fixtures'
import { gallery } from './gallery'

const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** The two fixture sources (the pins scan the DATA, never this test). */
function fixtureSourceText(): string {
  return ['fixtures.ts', 'gallery.tsx']
    .map(file => readFileSync(path.join(FIXTURE_DIR, file), 'utf8'))
    .join('\n')
}

/** The gallery's source (the cassette-key pin scans the declarations). */
function gallerySource(): string {
  return readFileSync(path.join(FIXTURE_DIR, 'gallery.tsx'), 'utf8')
}

/** The K operations' generated api-client keys (CONS-HIST-1..11). */
const CONSUMED_KEYS = [
  'History.clearAllCopies',
  'History.getHistory',
  'History.getPreferences',
  'History.getUsage',
  'History.listHistory',
  'History.updatePreferences',
  'Txr.clearRuns',
  'Txr.listRunLogs',
  'Txr.rerunRun',
  'Txr.updateAnalysisConfig',
]

/** The seven keys the module-level cassette owns (the one-owner rule:
 *  `History.getPreferences` is txrrun's, `Txr.updateAnalysisConfig`
 *  txrrun's, `Txr.listRunLogs` txrresults' — ownable only as per-story
 *  seeds, the txrmodels precedent). */
const OWNED_CASSETTE_KEYS = [
  'History.clearAllCopies',
  'History.getHistory',
  'History.getUsage',
  'History.listHistory',
  'History.updatePreferences',
  'Txr.clearRuns',
  'Txr.rerunRun',
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('txrhistory fixtures (TEST-HIST-9)', () => {
  it('gives every run a namespaced synthetic uuid and a stable generator', () => {
    const ids = TXHISTORY_RUNS.map(run => run.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toMatch(UUID_RE)
    expect(new Set(ids).size).toBe(ids.length)
    // The generator is stable + namespaced: a re-run gives the same id.
    expect(fixtureRunId(1)).toBe('e0000000-0000-4000-8000-000000000001')
    expect(ids).toContain(fixtureRunId(1))
    // The rerun's summary is the NEW run (never a reuse of an existing id).
    expect(TXHISTORY_RERUN_SUMMARY.id).toBe(fixtureRunId(7))
    expect(ids).not.toContain(TXHISTORY_RERUN_SUMMARY.id)
  })

  it('spells S-prefixed patient ids only, never a board patient id', () => {
    // The K wire carries no patient list; the fixture's one patient-id
    // shape is the terminal log capture (a method line naming the first
    // fixture patient — the plan's "patient ids S0000…" provision's real
    // subject on this module).
    const source = fixtureSourceText()
    const patientIds = source.match(/S\d+/g) ?? []
    expect(patientIds.length).toBeGreaterThan(0)
    for (const id of patientIds) expect(id).toMatch(/^S\d{4,}$/)
    expect(fxPatientId(1)).toBe('S0001')
    // The boards' patient ids are `P0###`-shaped — never in the fixtures.
    expect(source.match(/P0\d{3}/g)).toBeNull()
  })

  it('carries no board example count, duration or size as a constant (INV-6)', () => {
    const source = fixtureSourceText().toLowerCase()
    const boardFacts = [
      '4 ru' + 'ns',
      '312 m' + 'b',
      '38 pa' + 'tients',
      '151 pa' + 'tients',
      '22 pa' + 'tients',
      '64 pa' + 'tients',
      '2 me' + 'thods',
      '3 minutes 10 se' + 'conds',
    ]
    for (const fact of boardFacts) {
      expect(source, `board fact "${fact}"`).not.toContain(fact)
    }
    // The fixture's numbers are the fixed spreads (the count facts are
    // data — the fixture family's own, never the boards').
    expect(TXHISTORY_RUNS[0]!.method_count).toBe(3)
    expect(TXHISTORY_RUNS[0]!.learned_from).toBe(46)
    expect(TXHISTORY_USAGE.run_count).toBe(6)
  })

  it('carries no decimal literal (the family has no probability value)', () => {
    // A decimal in the fixture sources would be a board-shaped number:
    // the K family's facts are counts/times/bytes (integers) and the
    // catalogue VERSIONS — the version strings are data and stripped
    // before the scan (a stray numeric literal still fails).
    const source = fixtureSourceText().replace(/version:\s*'[^']*'/g, '')
    expect(source.match(/(?<![\d.])\d+\.\d+(?![\d.])/g)).toBeNull()
  })

  it('never reads or spells the trees the app must not touch', () => {
    // The story frame's own route strings (`/analysis/:runId/results`,
    // `/analysis/:runId/running`) are the app's URL space, not data
    // trees — stripped before the scan, like the txrresults pin.
    const source = fixtureSourceText()
      .toLowerCase()
      .replace(/\/analysis\/[^'"`]+/g, '')
    for (const forbidden of ['restricted/', 'datasets/', 'results/']) {
      expect(source).not.toContain(forbidden)
    }
    const fixtureSource = readFileSync(path.join(FIXTURE_DIR, 'fixtures.ts'), 'utf8')
    expect(fixtureSource).not.toContain('import(')
    expect(fixtureSource).not.toContain('fetch(')
  })

  it('mocks exactly the ten consumed operations — seven owned, three story-seeded', () => {
    // The module cassette owns exactly the seven ownable keys (no
    // sibling collision — a duplicate would throw at gallery boot).
    expect(Object.keys(gallery.cassette ?? {}).sort()).toEqual(OWNED_CASSETTE_KEYS)
    for (const key of OWNED_CASSETTE_KEYS) {
      expect(gallery.cassette![key as keyof typeof gallery.cassette]).toBeDefined()
    }
    // Every operation key the gallery source spells is one of the ten
    // (a new/unconsumed `History.*`/`Txr.*` op fails here — no hidden
    // backend dependency in the gallery tier; the lookbehind keeps the
    // `TxrHistory`-prefixed identifiers out of the scan).
    const source = gallerySource()
    const spelled = [...source.matchAll(/(?<![A-Za-z0-9_])(History|Txr)\.[a-z][\w]*/g)]
      .map(match => match[0])
    const unexpected = spelled.filter(key => !CONSUMED_KEYS.includes(key))
    expect(unexpected).toEqual([])
    // The three sibling-owned keys are answered per story (their seeds'
    // extendCassette calls), never at module scope.
    for (const key of ['History.getPreferences', 'Txr.updateAnalysisConfig', 'Txr.listRunLogs']) {
      expect(gallery.cassette, `module cassette must not own ${key}`).not.toHaveProperty(key)
      expect(source, `a story seed must answer ${key}`).toContain(`'${key}':`)
    }
  })

  it('orders the family newest-first with unique ids and complete details', () => {
    const stamps = TXHISTORY_RUNS.map(run => new Date(run.created_at).getTime())
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i - 1]!).toBeGreaterThan(stamps[i]!)
    }
    for (const run of TXHISTORY_RUNS) {
      const detail = TXHISTORY_DETAILS[run.id]
      expect(detail, `detail of ${run.id}`).toBeDefined()
      expect(detail.id).toBe(run.id)
      expect(detail.methods.map(row => row.method_id)).toEqual(
        run.methods.map(row => row.id),
      )
    }
  })

  it('keeps the usage figure internally consistent and spread-derived', () => {
    expect(TXHISTORY_USAGE.runs_bytes + TXHISTORY_USAGE.models_bytes + TXHISTORY_USAGE.other_bytes)
      .toBe(TXHISTORY_USAGE.total_bytes)
    for (const [runs, bytes] of [
      [0, 0],
      [1, 28 * 1024 * 1024],
      [25, 275 * 1024 * 1024],
    ] as const) {
      const usage = fixtureUsage(runs, bytes)
      expect(usage.runs_bytes + usage.models_bytes + usage.other_bytes).toBe(usage.total_bytes)
    }
  })

  it('serves the log capture seq-ascending and the method-filtered view honestly', () => {
    const lines = TXHISTORY_LOGS[TXHISTORY_RUN_BOARD_TRAIN.id]!
    expect(lines.length).toBeGreaterThan(0)
    const seqs = lines.map(line => line.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const method = lines.find(line => line.method_id !== undefined)!.method_id!
    const filtered = fixtureLogsFor(TXHISTORY_RUN_BOARD_TRAIN.id, method)
    expect(filtered.lines.length).toBeGreaterThan(0)
    expect(filtered.lines.every(line => line.method_id === method)).toBe(true)
    // The whole-run view is the full capture (the dialog's first page).
    const whole = fixtureLogsFor(TXHISTORY_RUN_BOARD_TRAIN.id, null)
    expect(whole).toEqual({ lines, next_seq: lines[lines.length - 1]!.seq, total: lines.length })
  })

  it('answers the provider\'s own q/kind/status + paging semantics (never a sieve)', () => {
    // The category filters + the grown multi-value status (GAP-HIST-3).
    const learned = fixtureHistoryPage(TXHISTORY_RUNS, { kind: 'learned' })
    expect(learned.items.every(run => run.mode === 'train')).toBe(true)
    expect(learned.total).toBe(TXHISTORY_RUNS.filter(run => run.mode === 'train').length)
    const stoppedFailed = fixtureHistoryPage(TXHISTORY_RUNS, { status: 'stopped,failed' })
    expect(stoppedFailed.items.map(run => run.id)).toEqual([TXHISTORY_RUNS[4]!.id])
    // The search also matches method ids and set names (the q note).
    const byMethod = fixtureHistoryPage(TXHISTORY_RUNS, { q: 'cox-cutpoint' })
    expect(byMethod.items.length).toBeGreaterThan(1)
    const bySet = fixtureHistoryPage(TXHISTORY_RUNS, { q: 'Cohort A' })
    expect(bySet.items.map(run => run.id).sort()).toEqual(
      [TXHISTORY_RUNS[2]!.id, TXHISTORY_RUNS[5]!.id].sort(),
    )
    // Paging: limit/offset slice, total unchanged (the Load-more contract).
    const pageOne = fixtureHistoryPage(TXHISTORY_RUNS, { limit: '20', offset: '0' })
    expect(pageOne.items).toHaveLength(TXHISTORY_RUNS.length)
    const manyOne = fixtureHistoryPage(TXHISTORY_RUNS_MANY, { limit: '20', offset: '0' })
    expect(manyOne.items).toHaveLength(20)
    expect(manyOne.total).toBe(25)
    const manyTwo = fixtureHistoryPage(TXHISTORY_RUNS_MANY, { limit: '20', offset: '20' })
    expect(manyTwo.items).toHaveLength(5)
    expect(manyTwo.items[0]!.id).toBe(TXHISTORY_RUNS_MANY[20]!.id)
  })

  it('builds the 25-run paging family (20-row first page + a continuation)', () => {
    expect(TXHISTORY_RUNS_MANY).toHaveLength(25)
    expect(new Set(TXHISTORY_RUNS_MANY.map(run => run.id)).size).toBe(25)
    // The timestamps are the fixed hour-step spread, newest first.
    expect(fxTimestamp(1)).toBe('2026-06-18T10:02:05.000Z')
    expect(TXHISTORY_RUNS_MANY[1]!.created_at < TXHISTORY_RUNS_MANY[0]!.created_at).toBe(true)
  })
})
