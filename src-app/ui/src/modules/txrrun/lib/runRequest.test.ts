/**
 * TEST-RUN-06 (supplementary pins, `runRequest.test.ts`) — the E
 * create-run builder (PROV-UI-RUN-2, INV-4; ITEM-3). The main row lives
 * in `settings.test.ts` (the TESTS map names that file); this file holds
 * the builder's own contract pins:
 *
 * - the returned request is the generated `CreateRunRequest` (the
 *   typecheck-level pin — a shape drift fails the assignment, not the
 *   test);
 * - `mode` is the train literal, `method_ids` is the selection, and the
 *   reuse-mode payload keys (`model_ids`) are never emitted;
 * - `config` is exactly the settings mapped through `toRunConfig` with
 *   `label_day: null` (the PROV-EE-2 derivation marker, DEC-7);
 * - the input snapshot is carried through untouched (the one-builder
 *   rule, CONS-UI-RUN-13).
 */
import { describe, expect, it } from 'vitest'
import type { CreateRunRequest, ParsedTable, TxrRunInput } from '@/api-client/types'
import { DEFAULT_RUN_SETTINGS, SETTING_OPTIONS, toRunConfig } from './settings'
import { buildRunRequest } from './runRequest'

/**
 * A decoded engine table for the fixtures. The generated client's
 * `ParsedTable.rows` is `string | null[][]` (the openapi-generator
 * artifact the intake's own bridge documents — wire bytes are
 * `(string | null)[][]`); the bridge is type-level only.
 */
function parsedTable(rows: (string | null)[][]): ParsedTable {
  return {
    source: { name: 'measurements.csv', format: 'csv' },
    header_row: 1,
    columns: ['patient_id', 'day', 'marker', 'value'],
    rows: rows as unknown as ParsedTable['rows'],
  }
}

const input: TxrRunInput = {
  measurements: parsedTable([['P0001', '0', 'ldh', '210']]),
  keep_copies: true,
}

const request = buildRunRequest('train', input, DEFAULT_RUN_SETTINGS, ['direct-on', 'flirti'])
// The type-level pin: any drift from the generated request type — a
// renamed field, a widened `mode`, a missing method_ids — fails here.
const typed: CreateRunRequest = request

describe('buildRunRequest (TEST-RUN-06, runRequest.test.ts)', () => {
  it('is the generated create-run request type (the typecheck-level pin)', () => {
    expect(typed).toBe(request)
  })

  it('carries the train mode literal, the selection and no reuse-mode key', () => {
    expect(request.mode).toBe('train')
    expect(request.method_ids).toEqual(['direct-on', 'flirti'])
    expect('model_ids' in request).toBe(false)
  })

  it('maps the config exactly as the settings layer does, with the derivation marker', () => {
    expect(request.config).toEqual({ ...toRunConfig(DEFAULT_RUN_SETTINGS), label_day: null })
    expect(request.config.label_day).toBeNull()
  })

  it('passes the intake snapshot through unaltered (the one-builder rule)', () => {
    expect(request.input).toBe(input)
    expect(request.input.measurements.columns).toEqual(['patient_id', 'day', 'marker', 'value'])
  })

  it('keeps the lane preset and the CPU choice in the config', () => {
    const chosen = buildRunRequest('train', input, { ...DEFAULT_RUN_SETTINGS, at_a_time: 2, cpus: 4 }, [])
    expect(chosen.config.at_a_time).toBe(2)
    expect(chosen.config.cpus).toBe(4)
    // The preset list is the source of the selectable values — the
    // builder itself never narrows or clamps them (the engine owns the
    // 1..=8 clamp, PROV-EE-2).
    expect(SETTING_OPTIONS.at_a_time).toContain(2)
  })
})
