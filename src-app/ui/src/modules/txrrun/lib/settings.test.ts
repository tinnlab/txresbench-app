/**
 * TEST-RUN-06 — txrrun settings + run request (PROV-UI-RUN-2, INV-4;
 * ITEM-3). The settings rows of screen E (`Busy.dc.html`) and the
 * create-run request are pure functions of the frozen engine contract
 * (PROV-EE-2), so the pins below are the contract's own bytes:
 *
 * - `DEFAULT_RUN_SETTINGS` equals the engine's defaults verbatim;
 * - `mergeRunSettings` follows DEC-6's three sources in order — the
 *   intake's current `decision_day` (the fresh answer beats any stored
 *   config), then the engine's sticky config for every other field, then
 *   the engine's defaults;
 * - `SETTING_OPTIONS` is the boards' option sets (same order);
 * - `buildRunRequest` emits PROV-EE-2's exact shape, `label_day: null`,
 *   and this test pins the returned value against the generated request
 *   type (an assignment the typecheck rejects on any shape drift);
 * - no client-side timing exists in these files (INV-4): a scan over
 *   the two sources finds no schedule/elapsed token and no unit
 *   arithmetic.
 *
 * Board numbers are never data (INV-6): the option values below are the
 * PROV-EE-2 defaults and the boards' option sets, not a run's facts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  CreateRunRequest,
  ParsedTable,
  RunConfig,
  TxrAppConfig,
  TxrRunInput,
} from '@/api-client/types'
import type { RunSettings } from './settings'
import {
  DEFAULT_RUN_SETTINGS,
  SETTING_OPTIONS,
  mergeRunSettings,
  toRunConfig,
} from './settings'
import { buildRunRequest } from './runRequest'

const B = fileURLToPath(new URL('.', import.meta.url))

/**
 * A decoded engine table for the fixtures. The generated client types
 * `ParsedTable.rows` as `string | null[][]` — an openapi-generator
 * artifact of the server's `Vec<Vec<Option<String>>>` — while the wire
 * bytes are `(string | null)[][]`; the same bridge the intake's
 * table-crossing documents (txrintake DRIFT-1 ITEM-3). The bridge is
 * type-level only; the fixture rows below are exactly the wire shape.
 */
function parsedTable(rows: (string | null)[][]): ParsedTable {
  return {
    source: { name: 'measurements.csv', format: 'csv' },
    header_row: 1,
    columns: ['patient_id', 'day', 'marker', 'value'],
    rows: rows as unknown as ParsedTable['rows'],
  }
}

/** A fully-populated engine config — every field distinct from the default. */
const engineConfig: RunConfig = {
  endpoint: 'os',
  decision_day: 84,
  look_ahead_day: 365,
  covariates: true,
  at_a_time: 4,
  cpus: 2,
  save_models: true,
}

const engine = (config: RunConfig | undefined = engineConfig): TxrAppConfig => ({ config })

/** The intake parameters as the store carries them (DEC-5: baseline fix 0). */
const params = (decision_day: number | null): { decision_day: number | null; baseline_max_day: number } => ({
  decision_day,
  baseline_max_day: 0,
})

/** A minimal valid engine input snapshot (the intake builder's own output shape). */
const input: TxrRunInput = {
  measurements: parsedTable([['P0001', '0', 'ldh', '210']]),
  patients: {
    source: { name: 'patients.csv', format: 'csv' },
    header_row: 1,
    columns: ['patient_id', 'response_day', 'age'],
    rows: [['P0001', '28', '55']] as unknown as ParsedTable['rows'],
  },
  joins: [],
  mapping: [],
  keep_copies: true,
}

describe('DEFAULT_RUN_SETTINGS (TEST-RUN-06)', () => {
  it('equals the engine PROV-EE-2 defaults verbatim', () => {
    expect(DEFAULT_RUN_SETTINGS).toEqual({
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
    })
  })
})

describe('SETTING_OPTIONS (TEST-RUN-06)', () => {
  it('renders the outcome options as the board\'s two values', () => {
    expect(SETTING_OPTIONS.endpoint).toEqual([
      { v: 'pfs', label: 'Progression or death' },
      { v: 'os', label: 'Death only' },
    ])
  })

  it('carries the boards\' option sets in the boards\' order (day 56 first, then 28/42/84 as Busy.dc.html reads; the lane presets)', () => {
    // The board's select markup is the screen spec: Day 56 | Day 28 |
    // Day 42 | Day 84. ITEM-3's pin was the plan's "board order" and the
    // plan's ITEM-3 note (c) deferred the order question to ITEM-7's rows —
    // the board's own order wins (DRIFT-1 ITEM-7).
    expect(SETTING_OPTIONS.decision_day).toEqual([56, 28, 42, 84])
    expect(SETTING_OPTIONS.look_ahead_day).toEqual([238, 180, 365])
    expect(SETTING_OPTIONS.at_a_time).toEqual([1, 2, 4])
  })

  it('keeps the default 3 outside the lane presets — the current-value chip case', () => {
    expect(SETTING_OPTIONS.at_a_time).not.toContain(DEFAULT_RUN_SETTINGS.at_a_time)
  })
})

describe('mergeRunSettings (TEST-RUN-06)', () => {
  it('uses the intake decision day over any stored config, every other field from the engine', () => {
    const merged = mergeRunSettings(engine(), params(42))
    expect(merged).toEqual({ ...engineConfig, decision_day: 42, at_a_time: 3 })
  })

  it('lets the intake null fall through to the engine config decision day', () => {
    const merged = mergeRunSettings(engine(), params(null))
    expect(merged.decision_day).toBe(84)
  })

  it('applies the engine config fields when the intake is absent (the restored path)', () => {
    // The ONE exception: at_a_time is a RUN option, not an analysis setting —
    // the sticky "1 at a time" must not persist across analyses (qa-fixes
    // ITEM-2), so the restore always lands at the engine's default 3 while
    // every other stored field comes back.
    expect(mergeRunSettings(engine(), null)).toEqual({ ...engineConfig, at_a_time: 3 })
  })

  it('never restores a stored run-N-at-a-time value across analyses', () => {
    const merged = mergeRunSettings(engine(), null)
    expect(merged.at_a_time).toBe(DEFAULT_RUN_SETTINGS.at_a_time)
    expect(merged.at_a_time).toBe(3)
  })

  it('falls back to the engine defaults with no engine config and no intake', () => {
    expect(mergeRunSettings(null, null)).toEqual(DEFAULT_RUN_SETTINGS)
    expect(mergeRunSettings({ config: undefined }, params(null))).toEqual(DEFAULT_RUN_SETTINGS)
  })

  it('fills a partial engine config field by field from the defaults', () => {
    const merged = mergeRunSettings(engine({ endpoint: 'os', decision_day: 84 }), null)
    expect(merged).toEqual({
      endpoint: 'os',
      decision_day: 84,
      look_ahead_day: 238,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
    })
  })

  it('never fabricates a cpus value — null stays null (detect), even from a stored config', () => {
    // The wire's stored config carries `cpus: null`; the generated client
    // types it `cpus?: number` (the nullable-optional collapse), so the
    // test bridges the byte truth the same way the merge sees it.
    const wireConfig = { ...engineConfig, cpus: null } as unknown as RunConfig
    expect(mergeRunSettings(engine(wireConfig), null).cpus).toBeNull()
  })
})

describe('toRunConfig (TEST-RUN-06)', () => {
  it('maps every settings field one to one, label day null by default', () => {
    expect(toRunConfig(DEFAULT_RUN_SETTINGS)).toEqual({
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
      label_day: null,
    })
  })

  it('carries a chosen label day through when one is given', () => {
    expect(toRunConfig(DEFAULT_RUN_SETTINGS, 56).label_day).toBe(56)
  })

  it('keeps an explicit cpus number (the CPU selector value)', () => {
    const settings: RunSettings = { ...DEFAULT_RUN_SETTINGS, cpus: 4 }
    expect(toRunConfig(settings).cpus).toBe(4)
  })
})

describe('buildRunRequest (TEST-RUN-06)', () => {
  it('emits the frozen PROV-EE-2 shape byte for byte (label day null, mode train)', () => {
    const settings: RunSettings = {
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
    }
    const request = buildRunRequest('train', input, settings, ['a', 'b'])
    // The typecheck-level pin: any drift from the generated request type
    // (or from `mode: 'train'`) fails the assignment below, not the test.
    const typed: CreateRunRequest = request
    expect(typed).toBe(request)
    expect(request).toEqual({
      mode: 'train',
      input,
      config: {
        endpoint: 'pfs',
        decision_day: 56,
        look_ahead_day: 238,
        covariates: false,
        at_a_time: 3,
        cpus: null,
        save_models: false,
        label_day: null,
      },
      method_ids: ['a', 'b'],
    })
  })

  it('passes the input snapshot through unaltered (the one-builder rule)', () => {
    const request = buildRunRequest('train', input, DEFAULT_RUN_SETTINGS, ['a'])
    expect(request.input).toBe(input)
    expect(request.input).toEqual(input)
  })
})

describe('no client-side timing (TEST-RUN-06, INV-4)', () => {
  it('computes no schedule or elapsed value in the settings/request layer', () => {
    const sources = ['settings.ts', 'runRequest.ts']
      .map(f => readFileSync(path.join(B, f), 'utf8'))
      .join('\n')
    // The engine contract's timing facts and display unit arithmetic are
    // entirely absent here: the estimate/eligibility text comes from the
    // list hooks and the engine, never from a local sum.
    const timingTokens = ['schedule_seconds', 'total_seconds', 'elapsed_secs', 'minute', '* 60', '/ 60']
    for (const token of timingTokens) {
      expect(sources.includes(token), token).toBe(false)
    }
  })
})
