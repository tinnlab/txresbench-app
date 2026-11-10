/**
 * TEST-MOD-08 — the txrmodels save-request builders + the L checklist
 * helpers (`lib/save.ts`, ITEM-4; PROV-UI-MODELS-4, CONS-UM-6, DEC-15).
 *
 * Pinned behaviors:
 *
 * - `buildSaveSetRequest` emits the exact PROV-MS-3 body for dialog L:
 *   `{run_id, method_ids, target: {set_name}, keep_training_files,
 *   also_export, source_label}`;
 * - `buildSaveOneRequest` emits the `target: {set_id}` (existing set) and
 *   `target: {set_name}` (new set) variants for L2 — the two arms stay
 *   exclusive (the provider's untagged enum denies a both-arms payload);
 * - "Only the small ones" keeps exactly the models with
 *   `size_bytes <= SMALL_MODEL_BYTES` (`SMALL_MODEL_MB = 5`, the one named
 *   constant); an unrecorded size is never small; "Select none" is the
 *   empty selection;
 * - the training-data warning names exactly the models whose
 *   `embeds_training_data` fact is true, in the passed order — composed
 *   through ITEM-2's `formatTrainingDataWarning` (the sentence is that
 *   formatter's; this file asserts the join, never a re-worded sentence).
 */
import { describe, expect, it } from 'vitest'
import { formatTrainingDataWarning } from './format'
import {
  SMALL_MODEL_BYTES,
  SMALL_MODEL_MB,
  buildSaveOneRequest,
  buildSaveSetRequest,
  onlySmallModels,
  selectNone,
  trainingDataModelNames,
  type TxrSaveableModel,
} from './save'

const OPTIONS = {
  keepTrainingFiles: true,
  alsoExport: false,
  sourceLabel: 'patients.csv',
}

describe('buildSaveSetRequest — the L body (TEST-MOD-08)', () => {
  it('emits the exact PROV-MS-3 body with the new-set arm', () => {
    expect(buildSaveSetRequest('run-a', ['m1-cox', 'm2-dyn'], 'CRC cohort, day 60', OPTIONS)).toEqual({
      run_id: 'run-a',
      method_ids: ['m1-cox', 'm2-dyn'],
      target: { set_name: 'CRC cohort, day 60' },
      keep_training_files: true,
      also_export: false,
      source_label: 'patients.csv',
    })
  })

  it('omits the source label when the dialog has none (the engine truth wins, GAP-D)', () => {
    const body = buildSaveSetRequest('run-a', ['m1-cox'], 'A new set', {
      keepTrainingFiles: false,
      alsoExport: true,
      sourceLabel: null,
    })
    expect(body).toEqual({
      run_id: 'run-a',
      method_ids: ['m1-cox'],
      target: { set_name: 'A new set' },
      keep_training_files: false,
      also_export: true,
    })
    expect(body).not.toHaveProperty('source_label')
  })
})

describe('buildSaveOneRequest — the L2 body (TEST-MOD-08)', () => {
  it('emits the existing-set arm', () => {
    expect(
      buildSaveOneRequest('run-a', 'm1-cox', { set_id: 'set-a' }, OPTIONS),
    ).toEqual({
      run_id: 'run-a',
      method_ids: ['m1-cox'],
      target: { set_id: 'set-a' },
      keep_training_files: true,
      also_export: false,
      source_label: 'patients.csv',
    })
  })

  it('emits the new-set arm', () => {
    const body = buildSaveOneRequest('run-a', 'm1-cox', { set_name: 'Lung pilot, day 35' }, OPTIONS)
    expect(body.target).toEqual({ set_name: 'Lung pilot, day 35' })
    expect(body.target).not.toHaveProperty('set_id')
  })
})

describe('the L checklist helpers (TEST-MOD-08, DEC-15)', () => {
  const models: TxrSaveableModel[] = [
    { methodId: 'm-small', sizeBytes: 4.6 * 1024 * 1024, embedsTrainingData: false },
    { methodId: 'm-edge', sizeBytes: SMALL_MODEL_BYTES, embedsTrainingData: false },
    { methodId: 'm-big', sizeBytes: 6 * 1024 * 1024, embedsTrainingData: true },
    { methodId: 'm-unknown', sizeBytes: null, embedsTrainingData: true },
  ]

  it('is a named one-line constant (5 MB) and a model of that size counts as small', () => {
    expect(SMALL_MODEL_MB).toBe(5)
    expect(SMALL_MODEL_BYTES).toBe(5 * 1024 * 1024)
    expect(onlySmallModels(models)).toEqual(['m-small', 'm-edge'])
  })

  it('never treats an unrecorded size as small', () => {
    expect(onlySmallModels(models)).not.toContain('m-unknown')
  })

  it('Select none is the empty selection', () => {
    expect(selectNone()).toEqual([])
  })

  it('names exactly the training-data models in order, through the board sentence', () => {
    const names = trainingDataModelNames(models)
    expect(names).toEqual(['m-big', 'm-unknown'])
    expect(formatTrainingDataWarning(names)).toBe(
      '2 models (m-big, m-unknown) keep parts of the training data inside them. They stay in the saved model files; check before you copy or share them.',
    )
    expect(formatTrainingDataWarning(trainingDataModelNames([]))).toBe('')
  })
})
