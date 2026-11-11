// @vitest-environment jsdom
/**
 * TEST-QF3-2 [covers qa-fixes3 ITEM-4] — the example-flow lib (`lib/example.ts`):
 * the shared table loader decodes the three example kinds through the REAL
 * browser decode (the provider asset bytes in, the `ParsedTable` the C/N
 * flow consumes out), the path → slots/kinds tables are the plan's
 * (train = the two files, the predict paths = the one predict table), the
 * example study answers are the generator's facts, and the ITEM-3 set
 * poll reports progress and stops on ready/failed.
 *
 * The ApiClient is mocked (the one seam outside the lib); the store is the
 * real TxrIntake store, reset per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import {
  EXAMPLE_DECISION_DAY,
  EXAMPLE_STUDY,
  exampleKindsFor,
  exampleSlotsFor,
  ensureExampleSet,
  fetchExampleTable,
  runExampleFlow,
} from './example'

const api = vi.hoisted(() => ({
  example: vi.fn(),
  exampleSet: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: { example: api.example },
    Models: { exampleSet: api.exampleSet },
  },
}))

const PATIENTS_CSV = ['patient_id,pfs_days,pfs_event', 'P0001,214,1'].join('\n')
const MEASUREMENTS_CSV = ['patient_id,day,marker,value,unit', 'P0001,0,ldh,210,U/L'].join('\n')
const PREDICT_CSV = ['patient_id,day,marker,value,unit', 'J1000,0,M1,1.2,a.u.'].join('\n')

const state = () => useTxrIntakeStore.getState()

beforeEach(() => {
  api.example.mockReset()
  api.exampleSet.mockReset()
  api.example.mockImplementation(({ kind }: { kind: string }) =>
    Promise.resolve(kind === 'patients' ? PATIENTS_CSV : kind === 'measurements' ? MEASUREMENTS_CSV : PREDICT_CSV),
  )
  window.localStorage.clear()
  state().reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the shared table loader', () => {
  it('decodes the three example kinds through the browser decode with the example file names', async () => {
    const patients = await fetchExampleTable('patients')
    expect(patients.source.name).toBe('patients_example.csv')
    expect(patients.columns).toEqual(['patient_id', 'pfs_days', 'pfs_event'])
    expect(patients.rows).toEqual([['P0001', '214', '1']])

    const predict = await fetchExampleTable('predict-measurements')
    expect(predict.source.name).toBe('predict-measurements_example.csv')
    expect(predict.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    // The N-screen decode kind is measurements (the header scan is the
    // measurements contract).
    expect(predict.rows).toEqual([['J1000', '0', 'M1', '1.2', 'a.u.']])
  })

  it('refuses an empty body loudly', async () => {
    api.example.mockResolvedValueOnce('')
    await expect(fetchExampleTable('measurements')).rejects.toThrow('came back empty')
  })
})

describe('the path tables and the example study answers', () => {
  it('train fills the two C slots + kinds; the predict paths fill the N slot + the predict table', () => {
    expect(exampleSlotsFor('train')).toEqual(['patients', 'measurements'])
    expect(exampleSlotsFor('pretrained')).toEqual(['predictMeasurements'])
    expect(exampleSlotsFor('reuse')).toEqual(['predictMeasurements'])
    expect(exampleKindsFor('train')).toEqual(['patients', 'measurements'])
    expect(exampleKindsFor('pretrained')).toEqual(['predict-measurements'])
    expect(exampleKindsFor('reuse')).toEqual(['predict-measurements'])
  })

  it('the answers are the example family facts (synthetic disease/drug, survival task, day 56)', () => {
    expect(EXAMPLE_STUDY.disease).toBe('other')
    expect(EXAMPLE_STUDY.treatment).toBe('other-mixed')
    expect(EXAMPLE_STUDY.outcome).toBe('progression-by-day')
    expect(EXAMPLE_STUDY.beforeTreatment).toBe('always')
    expect(EXAMPLE_STUDY.drawsDuringTreatment).toBe(4)
    expect(EXAMPLE_STUDY.lastDrawDay).toBe(EXAMPLE_DECISION_DAY)
    expect(EXAMPLE_DECISION_DAY).toBe(56)
  })
})

describe('runExampleFlow', () => {
  it('train: intent, answers, both files adopted as example slots', async () => {
    await runExampleFlow('train')
    const s = state()
    expect(s.intent).toBe('train')
    expect(s.mode).toBe('study')
    expect(s.study).toEqual(EXAMPLE_STUDY)
    expect(s.parameters.decision_day).toBe(EXAMPLE_DECISION_DAY)
    expect(s.exampleSlots.patients).toBe(true)
    expect(s.exampleSlots.measurements).toBe(true)
    expect(s.exampleLoaded).toBe(true)
    expect(s.patients?.table.rows).toEqual([['P0001', '214', '1']])
    expect(s.measurements?.table.rows).toEqual([['P0001', '0', 'ldh', '210', 'U/L']])
    // The adoption invalidates the validation (the file screens' own flow
    // re-validates the adopted tables, exactly like a user drop).
    expect(s.validation).toBeNull()
  })

  it('pretrained: intent + the predict table only', async () => {
    await runExampleFlow('pretrained')
    const s = state()
    expect(s.intent).toBe('pretrained')
    expect(s.mode).toBe('predict')
    expect(s.patients).toBeNull()
    expect(s.measurements).toBeNull()
    expect(s.exampleSlots.predictMeasurements).toBe(true)
    expect(s.predictMeasurements?.table.rows).toEqual([['J1000', '0', 'M1', '1.2', 'a.u.']])
    expect(s.pendingExampleSetId).toBeNull()
  })

  it('reuse: the path files AND the ITEM-3 set handoff (the example set ticked later)', async () => {
    api.exampleSet.mockResolvedValueOnce({ state: 'ready', set_id: 'set-1', methods: ['kelim'], run_id: undefined, run_status: undefined, error: undefined })
    await runExampleFlow('reuse')
    const s = state()
    expect(s.intent).toBe('reuse')
    expect(s.exampleSlots.predictMeasurements).toBe(true)
    expect(s.pendingExampleSetId).toBe('set-1')
  })

  it('a confirmed join from a previous file never survives the adoption (the re-validation re-derives)', async () => {
    state().acceptJoin({ variants: ['ldh', 'LDH'], key: 'LDH' })
    await runExampleFlow('pretrained')
    expect(state().joins).toEqual([])
    expect(state().mapping).toEqual([])
  })
})

describe('ensureExampleSet', () => {
  it('polls while creating and reports progress, then settles on ready', async () => {
    api.exampleSet
      .mockResolvedValueOnce({ state: 'creating', run_id: 'r1', run_status: 'running', methods: ['kelim'], set_id: undefined, error: undefined })
      .mockResolvedValueOnce({ state: 'creating', run_id: 'r1', run_status: 'running', methods: ['kelim'], set_id: undefined, error: undefined })
      .mockResolvedValue({ state: 'ready', set_id: 'set-9', methods: ['kelim'], run_id: undefined, run_status: undefined, error: undefined })
    const progress: string[] = []
    const response = await ensureExampleSet(r => progress.push(r.state), { delayMs: 1 })
    expect(response.state).toBe('ready')
    expect(response.set_id).toBe('set-9')
    expect(progress).toEqual(['creating', 'creating'])
    expect(api.exampleSet).toHaveBeenCalledTimes(3)
  })

  it('a failed answer throws the honest reason (the button retry state)', async () => {
    api.exampleSet.mockResolvedValueOnce({
      state: 'failed',
      set_id: undefined,
      run_id: undefined,
      run_status: undefined,
      methods: [],
      error: 'no method with a published environment can run on the example data',
    })
    await expect(ensureExampleSet()).rejects.toThrow('no method with a published environment')
  })

  it('a cancelled poll stops (the unmount guard)', async () => {
    api.exampleSet.mockResolvedValue({ state: 'creating', run_id: 'r1', run_status: 'running', methods: ['kelim'], set_id: undefined, error: undefined })
    await expect(
      ensureExampleSet(() => {}, { delayMs: 1, cancelled: () => true }),
    ).rejects.toThrow('cancelled')
  })
})
