// @vitest-environment jsdom
//
// TEST-INT-9 [covers ITEM-3] + TEST-INT-26 [acceptance, covers
// PROV-UI-INTAKE-2] — the TxrIntake store: the intent→mode mapping, the file
// slots + their offers, the confirmed joins/mapping, the parameter clamp, the
// ONE in-memory ValidationResponse lifecycle (set on a successful validate,
// nulled on every input mutation, never persisted), the persist partialize
// (small fields survive a reload, table payloads never), and the pure
// buildTxrRunInput shape (CONS-UI-INTAKE-8).
//
// vitest (jsdom — the store's persist storage is localStorage). The real
// store runs; no ApiClient is used by this store.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  FileInspection,
  FilterOptions,
  MarkerMatch,
  ValidationResponse,
} from '@/api-client/types'
import type { ParsedTable } from '@/lib/txr-files/types'
import type { IntakeSnapshot, JoinOffer, LoadedFile, VocabOffer } from '../types'

const storeModule = await import('./TxrIntake.store')
const { TxrIntake, useTxrIntakeStore, buildTxrRunInput, normalizePersistedStudy } = storeModule

/** The store's data fields (snapshot + recalls). */
const state = () => useTxrIntakeStore.getState()

const table = (name: string, rows: (string | null)[][] = [['P0001', '0', 'ldh', '210', 'U/L']]): ParsedTable => ({
  source: { name, format: 'csv' },
  header_row: 1,
  columns: ['patient_id', 'day', 'marker', 'value', 'unit'],
  rows,
})

const inspectionOf = (name: string): FileInspection => ({
  kind: 'measurements',
  source_name: name,
  columns: {
    resolved: { patient_id: 'patient_id', day: 'day', marker: 'marker', value: 'value', unit: 'unit' },
    unresolved: [],
    covariate_columns: [],
  },
  problems: [],
  summary: { rows: 1, markers: [{ name: 'ldh', rows: 1 }], draw_days: [0] },
})

function loadedFile(name = 'm.csv'): LoadedFile {
  return {
    source: { name, format: 'csv' },
    table: table(name),
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],

    columnOffers: [],
  }
}

const joinOffer: JoinOffer = { variants: ['ldh', 'LDH'], key: 'LDH' }

const fuzzyMatch: MarkerMatch = {
  marker_id: 'ldh',
  system: 'LOINC',
  display_name: 'Lactate dehydrogenase',
  unit_family: 'concentration_mass',
  canonical_unit: 'U/L',
  n_methods: 12,
  match_kind: 'fuzzy',
}

const vocabOffer: VocabOffer = { key: 'LDH', match: fuzzyMatch, accepted: null }

const validationOf = (overrides?: Partial<ValidationResponse>): ValidationResponse => ({
  inventory: {
    baseline_max_day: 0,
    decision_day: 56,
    patients: 2,
    covariates: [],
    markers: [
      {
        key: 'ldh',
        display_name: 'LDH',
        has_detection_companion: false,
        is_detection_call: false,
        n_patients_with_value: 2,
        n_patients_with_baseline: 2,
        n_patients_with_ontreatment: 0,
        standard_ids: [],
        unit_family: 'concentration_mass',
      },
    ],
  },
  markers: [
    {
      key: 'ldh',
      n_rows: 2,
      spellings: ['ldh'],
      unit: 'U/L',
      unit_status: 'matches',
      coverage: { patients_with_value: 2, patients_with_baseline: 2, patients_with_ontreatment: 0 },
      vocabulary: [],
    },
  ],
  measurements: { rows: 2, patients: 2, distinct_draw_days: [0, 14] },
  patients: { rows: 1, with_primary_outcome: 1,
    primary_outcome_events: 1, median_followup_days: 90 },
  problems: [],
  ...overrides,
})

beforeEach(() => {
  window.localStorage.clear()
  TxrIntake.reset()
})

describe('TEST-INT-9 — the TxrIntake store (ITEM-3)', () => {
  it('setIntent sets the intention and the mode it implies', () => {
    TxrIntake.setIntent('pretrained')
    expect(state().intent).toBe('pretrained')
    expect(state().mode).toBe('predict')

    TxrIntake.setIntent('train')
    expect(state().intent).toBe('train')
    expect(state().mode).toBe('study')

    TxrIntake.setIntent('reuse')
    expect(state().intent).toBe('reuse')
    expect(state().mode).toBe('predict')
  })

  it('setIntent forgets the file check when the mode changes (it was made for the other mode), and keeps it otherwise', () => {
    const checked = validationOf()
    TxrIntake.setIntent('pretrained')
    useTxrIntakeStore.setState({ validation: checked })
    TxrIntake.setIntent('reuse') // predict → predict: the same check
    expect(state().validation).toBe(checked)
    TxrIntake.setIntent('train') // predict → study: the predict check is not the learn files' check
    expect(state().validation).toBeNull()
    useTxrIntakeStore.setState({ validation: checked })
    TxrIntake.setIntent('train') // study → study
    expect(state().validation).toBe(checked)
    TxrIntake.setIntent('pretrained') // study → predict
    expect(state().validation).toBeNull()
  })

  it('adoptFile replaces a slot file and resets its offers', () => {
    const withOffers = { ...loadedFile(), joinOffers: [joinOffer], vocabOffers: [vocabOffer] }
    TxrIntake.adoptFile('measurements', withOffers)
    expect(state().measurements?.table).toEqual(withOffers.table)
    expect(state().measurements?.joinOffers).toEqual([])
    expect(state().measurements?.vocabOffers).toEqual([])
    expect(state().fileRecalls.measurements).toEqual({ name: 'm.csv', prepared: false })
    // A replacement replaces, never appends.
    const replacement = { ...loadedFile('m2.csv'), table: table('m2.csv', []) }
    TxrIntake.adoptFile('measurements', replacement)
    expect(state().measurements?.source.name).toBe('m2.csv')
    expect(state().measurements?.table.rows).toEqual([])
  })

  it('acceptJoin records the join and resolves the offer; rejectJoin records nothing', () => {
    const other = { variants: ['cea'], key: 'CEA' }
    TxrIntake.adoptFile('measurements', loadedFile())
    TxrIntake.patchFile('measurements', { joinOffers: [joinOffer, other] })

    TxrIntake.acceptJoin(joinOffer)
    expect(state().joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'LDH' }])
    expect(state().measurements?.joinOffers.map(o => o.key)).toEqual(['CEA'])

    // Idempotent on the key: a second accept of the same join adds nothing.
    TxrIntake.acceptJoin(joinOffer)
    expect(state().joins).toHaveLength(1)

    // Reject drops the offer without recording a join.
    TxrIntake.rejectJoin(other)
    expect(state().joins.map(j => j.key)).toEqual(['LDH'])
    expect(state().measurements?.joinOffers).toEqual([])
  })

  it('acceptVocab maps the key and resolves the offer (replacing a same-key mapping)', () => {
    TxrIntake.adoptFile('measurements', loadedFile())
    TxrIntake.patchFile('measurements', { vocabOffers: [vocabOffer] })
    TxrIntake.acceptVocab(vocabOffer)
    expect(state().mapping).toEqual([{ key: 'LDH', marker_id: 'ldh' }])
    expect(state().measurements?.vocabOffers).toEqual([])

    // A second match on the SAME key replaces the mapping, never appends.
    const second: VocabOffer = {
      key: 'LDH',
      match: { ...fuzzyMatch, marker_id: 'ldh-other' },
      accepted: null,
    }
    TxrIntake.adoptFile('measurements', loadedFile('m2.csv'))
    TxrIntake.patchFile('measurements', { vocabOffers: [second] })
    TxrIntake.acceptVocab(second)
    expect(state().mapping).toEqual([{ key: 'LDH', marker_id: 'ldh-other' }])
  })

  it('rejectVocab drops the offer and leaves the key unmapped', () => {
    TxrIntake.adoptFile('measurements', loadedFile())
    TxrIntake.patchFile('measurements', { vocabOffers: [vocabOffer] })
    TxrIntake.rejectVocab(vocabOffer)
    expect(state().mapping).toEqual([])
    expect(state().measurements?.vocabOffers).toEqual([])
  })

  it('patchParameters keeps any whole decision day (no snapping) and baseline_max_day 0', () => {
    TxrIntake.patchParameters({ decision_day: 100 })
    expect(state().parameters).toEqual({ decision_day: 100, baseline_max_day: 0 })

    TxrIntake.patchParameters({ decision_day: 29 })
    expect(state().parameters.decision_day).toBe(29)

    // A fraction is rounded to a whole day; the engine refuses 0 or less.
    TxrIntake.patchParameters({ decision_day: 41.4 })
    expect(state().parameters.decision_day).toBe(41)
    TxrIntake.patchParameters({ decision_day: 0 })
    expect(state().parameters.decision_day).toBe(1)

    TxrIntake.patchParameters({ decision_day: 42 })
    // baseline_max_day is accepted for shape compatibility and never stored different.
    TxrIntake.patchParameters({ baseline_max_day: 90, decision_day: Number.NaN })
    expect(state().parameters).toEqual({ decision_day: 42, baseline_max_day: 0 })

    TxrIntake.patchParameters({})
    expect(state().parameters).toEqual({ decision_day: 42, baseline_max_day: 0 })
  })

  it('keeps an old saved last-draw answer as it was (no migration needed)', () => {
    TxrIntake.patchStudy({ lastDrawDay: 84 })
    expect(state().study.lastDrawDay).toBe(84)
    TxrIntake.patchStudy({ lastDrawDay: 55 })
    expect(state().study.lastDrawDay).toBe(55)
  })

  it('patchFile writes the per-file card state the drop flow derives', () => {
    TxrIntake.adoptFile('measurements', loadedFile())
    TxrIntake.patchFile('measurements', {
      inspection: inspectionOf('m.csv'),
      problems: [{ code: 'A03', severity: 'warning', row: 14, column: 'marker', message: 'dupe' }],
      prepared: true,
      joinOffers: [joinOffer],
      vocabOffers: [vocabOffer],
    })
    expect(state().measurements?.inspection?.kind).toBe('measurements')
    expect(state().measurements?.prepared).toBe(true)
    expect(state().measurements?.problems).toHaveLength(1)
    expect(state().measurements?.joinOffers).toEqual([joinOffer])
    expect(state().fileRecalls.measurements).toEqual({ name: 'm.csv', prepared: true })
    // A patch on an absent slot is a no-op.
    TxrIntake.patchFile('patients', { prepared: true })
    expect(state().patients).toBeNull()
  })

  it('buildTxrRunInput renders the engine shape from a study snapshot', () => {
    TxrIntake.adoptFile('patients', loadedFile('p.csv'))
    TxrIntake.adoptFile('measurements', loadedFile('m.csv'))
    TxrIntake.acceptJoin(joinOffer)
    TxrIntake.acceptVocab(vocabOffer)

    const input = buildTxrRunInput(state() as IntakeSnapshot, 'learn')
    expect(input.patients).toBe(state().patients?.table)
    expect(input.measurements).toBe(state().measurements?.table)
    expect(input.predict_measurements).toBeUndefined()
    expect(input.joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'LDH' }])
    expect(input.mapping).toEqual([{ key: 'LDH', marker_id: 'ldh' }])
    expect(input.keep_copies).toBe(true)
  })

  it('buildTxrRunInput renders the predict snapshot as the run measurements table', () => {
    TxrIntake.setIntent('pretrained')
    TxrIntake.adoptFile('predictMeasurements', loadedFile('new.csv'))
    const input = buildTxrRunInput(state() as IntakeSnapshot, 'predict')
    expect(input.patients).toBeUndefined()
    expect(input.measurements).toBe(state().predictMeasurements?.table)
    // The engine's reuse/pretrained contract carries the predict file as the
    // separate table (EXAMPLE-EE-7) while the request type requires
    // `measurements` — the run's only table fills it (recorded for
    // RECONCILE with the engine's own plan text).
    expect(input.predict_measurements).toBe(state().predictMeasurements?.table)
    expect(input.keep_copies).toBe(true)
  })

  it('the learn run never carries the predict file (predict file, then learn files)', () => {
    TxrIntake.setIntent('pretrained')
    TxrIntake.adoptExampleFile('predictMeasurements', loadedFile('predict-example.csv'))
    TxrIntake.setIntent('train')
    TxrIntake.adoptExampleFile('patients', loadedFile('patients-example.csv'))
    TxrIntake.adoptExampleFile('measurements', loadedFile('measurements-example.csv'))

    const input = buildTxrRunInput(state() as IntakeSnapshot, 'learn')
    expect(input.patients).toBe(state().patients?.table)
    expect(input.measurements).toBe(state().measurements?.table)
    expect('predict_measurements' in input).toBe(false)
    expect(input.predict_measurements).toBeUndefined()
  })

  it('the predict run is only the predict file (learn files still in the slots)', () => {
    TxrIntake.setIntent('train')
    TxrIntake.adoptFile('patients', loadedFile('patients.csv'))
    TxrIntake.adoptFile('measurements', loadedFile('measurements.csv'))
    TxrIntake.setIntent('pretrained')
    TxrIntake.adoptFile('predictMeasurements', loadedFile('predict.csv'))

    const input = buildTxrRunInput(state() as IntakeSnapshot, 'predict')
    expect('patients' in input).toBe(false)
    expect(input.patients).toBeUndefined()
    expect(input.measurements).toBe(state().predictMeasurements?.table)
    expect(input.predict_measurements).toBe(state().predictMeasurements?.table)
  })

  it('the predict path needs ITS predict file: leftover learn files do not fill it', () => {
    TxrIntake.setIntent('train')
    TxrIntake.adoptFile('patients', loadedFile('patients.csv'))
    TxrIntake.adoptFile('measurements', loadedFile('measurements.csv'))
    TxrIntake.setIntent('pretrained')

    expect(() => buildTxrRunInput(state() as IntakeSnapshot, 'predict')).toThrow(
      /no measurements file adopted/,
    )
  })

  it('buildTxrRunInput refuses a snapshot with no measurements file', () => {
    expect(() => buildTxrRunInput(state() as IntakeSnapshot, 'learn')).toThrow(
      /no measurements file adopted/,
    )
  })

  it('the persist partialize keeps the small fields and never the payloads', () => {
    TxrIntake.setIntent('train')
    TxrIntake.patchStudy({ disease: 'colorectal cancer', lastDrawDay: 84 })
    TxrIntake.adoptFile('measurements', { ...loadedFile(), prepared: true })
    TxrIntake.acceptJoin(joinOffer)
    TxrIntake.acceptVocab(vocabOffer)
    TxrIntake.patchParameters({ decision_day: 84 })
    TxrIntake.applyValidation(validationOf({ problems: [{ code: 'A03', severity: 'error', row: 14, message: 'x' }] }), TxrIntake.currentValidationKey())

    const raw = window.localStorage.getItem('txr-intake-storage')
    expect(raw).not.toBeNull()
    // The zustand persist envelope: { state: <partialized>, version }.
    const persisted = (JSON.parse(raw ?? '{}') as { state: Record<string, unknown> }).state
    expect(persisted.intent).toBe('train')
    expect(persisted.mode).toBe('study')
    expect((persisted.study as { disease: string }).disease).toBe('colorectal cancer')
    expect(persisted.fileRecalls).toEqual({
      patients: null,
      measurements: { name: 'm.csv', prepared: true },
      predictMeasurements: null,
    })
    expect(persisted.joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'LDH' }])
    expect(persisted.mapping).toEqual([{ key: 'LDH', marker_id: 'ldh' }])
    expect(persisted.parameters).toEqual({ decision_day: 84, baseline_max_day: 0 })
    // The heavy bodies never ride the storage key.
    expect(persisted.measurements).toBeUndefined()
    expect(persisted.patients).toBeUndefined()
    expect(persisted.predictMeasurements).toBeUndefined()
    expect(persisted.validation).toBeUndefined()
    expect(raw).not.toContain('P0001')
    expect(raw).not.toContain('concentration_mass')
  })

  it('a reload hydrates answers + file names and leaves the slots and validation null', async () => {
    TxrIntake.reset()
    TxrIntake.setIntent('train')
    TxrIntake.patchStudy({ disease: 'breast cancer', drawsDuringTreatment: 4 })
    TxrIntake.adoptFile('measurements', { ...loadedFile(), table: table('m.csv', [['P0001', '0', 'ldh', '210', 'U/L']]) })
    TxrIntake.patchFile('measurements', { prepared: true })
    TxrIntake.acceptJoin(joinOffer)
    TxrIntake.patchParameters({ decision_day: 42 })
    TxrIntake.applyValidation(validationOf(), TxrIntake.currentValidationKey())

    vi.resetModules()
    const fresh = await import('./TxrIntake.store')
    const rehydrated = fresh.useTxrIntakeStore.getState()
    expect(rehydrated.intent).toBe('train')
    expect(rehydrated.mode).toBe('study')
    expect(rehydrated.study.disease).toBe('breast cancer')
    expect(rehydrated.study.drawsDuringTreatment).toBe(4)
    expect(rehydrated.fileRecalls.measurements).toEqual({ name: 'm.csv', prepared: true })
    expect(rehydrated.measurements).toBeNull()
    expect(rehydrated.patients).toBeNull()
    expect(rehydrated.joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'LDH' }])
    expect(rehydrated.mapping).toEqual([])
    expect(rehydrated.parameters).toEqual({ decision_day: 42, baseline_max_day: 0 })
    expect(rehydrated.validation).toBeNull()
  })
})

describe('TEST-INT-26 — the ONE validation response lifecycle (acceptance)', () => {
  it('sets validation on a successful validate against the current key', () => {
    const response = validationOf()
    TxrIntake.applyValidation(response, TxrIntake.currentValidationKey())
    expect(state().validation).toBe(response)
    expect(state().validation?.markers).toHaveLength(1)
  })

  it('nulls on every mutation of the validated inputs', () => {
    const at = () => TxrIntake.currentValidationKey()
    const apply = () => TxrIntake.applyValidation(validationOf(), at())

    TxrIntake.adoptFile('measurements', loadedFile())
    apply()
    expect(state().validation).not.toBeNull()
    TxrIntake.patchFile('measurements', { prepared: true }) // derived state, not an input
    expect(state().validation).not.toBeNull()

    apply()
    TxrIntake.removeFile('measurements')
    expect(state().validation).toBeNull()

    TxrIntake.adoptFile('measurements', loadedFile())
    apply()
    TxrIntake.acceptJoin(joinOffer)
    expect(state().validation).toBeNull()

    TxrIntake.adoptFile('measurements', loadedFile())
    apply()
    TxrIntake.rejectJoin(joinOffer)
    expect(state().validation).toBeNull()

    TxrIntake.adoptFile('measurements', { ...loadedFile(), vocabOffers: [vocabOffer] })
    apply()
    TxrIntake.acceptVocab(vocabOffer)
    expect(state().validation).toBeNull()

    TxrIntake.adoptFile('measurements', { ...loadedFile(), vocabOffers: [vocabOffer] })
    apply()
    TxrIntake.rejectVocab(vocabOffer)
    expect(state().validation).toBeNull()

    apply()
    TxrIntake.patchParameters({ decision_day: 84 })
    expect(state().validation).toBeNull()

    apply()
    TxrIntake.reset()
    expect(state().validation).toBeNull()
  })

  it('the day facts come with the validation, stay on a day change and go with a file change', () => {
    const timeline = {
      draw_days: [[21, 42]],
      outcomes: [],
      limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10 },
    }
    TxrIntake.adoptFile('measurements', loadedFile())
    TxrIntake.applyValidation(validationOf({ timeline }), TxrIntake.currentValidationKey())
    expect(state().dayFacts).toEqual(timeline)

    TxrIntake.patchParameters({ decision_day: 42 })
    expect(state().validation).toBeNull()
    expect(state().dayFacts).toEqual(timeline)

    TxrIntake.adoptFile('measurements', loadedFile('other.csv'))
    expect(state().dayFacts).toBeNull()

    TxrIntake.applyValidation(validationOf({ timeline }), TxrIntake.currentValidationKey())
    TxrIntake.removeFile('measurements')
    expect(state().dayFacts).toBeNull()

    TxrIntake.applyValidation(validationOf({ timeline }), TxrIntake.currentValidationKey())
    TxrIntake.reset()
    expect(state().dayFacts).toBeNull()
  })

  it('the look-ahead day of the analysis is forgotten when a new path starts', () => {
    TxrIntake.setLookAheadDay(300)
    expect(state().lookAheadDay).toBe(300)
    TxrIntake.setIntent('train')
    expect(state().lookAheadDay).toBeNull()
    TxrIntake.setLookAheadDay(300)
    TxrIntake.reset()
    expect(state().lookAheadDay).toBeNull()
  })

  it('a file change forgets the chosen look-ahead day with the day facts (new files bring the default back)', () => {
    const timeline = {
      draw_days: [[21, 42]],
      outcomes: [],
      limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10 },
    }
    const withFacts = () => TxrIntake.applyValidation(validationOf({ timeline }), TxrIntake.currentValidationKey())

    TxrIntake.adoptFile('measurements', loadedFile())
    withFacts()
    TxrIntake.setLookAheadDay(300)
    expect(state().lookAheadDay).toBe(300)
    expect(state().dayFacts).toEqual(timeline)

    // A replacement file: the chosen look-ahead was for the old files.
    TxrIntake.adoptFile('measurements', loadedFile('other.csv'))
    expect(state().lookAheadDay).toBeNull()
    expect(state().dayFacts).toBeNull()

    TxrIntake.adoptFile('measurements', loadedFile())
    withFacts()
    TxrIntake.setLookAheadDay(300)
    TxrIntake.removeFile('measurements')
    expect(state().lookAheadDay).toBeNull()
    expect(state().dayFacts).toBeNull()

    TxrIntake.setLookAheadDay(300)
    TxrIntake.adoptExampleFile('measurements', loadedFile('example.csv'))
    expect(state().lookAheadDay).toBeNull()
    expect(state().dayFacts).toBeNull()

    TxrIntake.setLookAheadDay(300)
    TxrIntake.adoptExampleFile('measurements', loadedFile('example.csv'))
    TxrIntake.clearExamples()
    expect(state().lookAheadDay).toBeNull()
    expect(state().dayFacts).toBeNull()
  })

  it('patchStudy is not an input mutation: it leaves validation alone', () => {
    TxrIntake.applyValidation(validationOf(), TxrIntake.currentValidationKey())
    TxrIntake.patchStudy({ outcome: 'dynamic-risk' })
    expect(state().validation).not.toBeNull()
  })

  it('drops a response that no longer matches the stored key', () => {
    // The page captures its key before the request; the join is confirmed
    // while the request is in flight.
    const staleKey = TxrIntake.currentValidationKey()
    TxrIntake.acceptJoin(joinOffer)
    TxrIntake.applyValidation(validationOf(), staleKey)
    expect(state().validation).toBeNull()
  })
})


describe('ITEM-6 F2/F6 — the rename action, the "not now", the example fact', () => {
  function tableWith(columns: string[]) {
    return {
      source: { name: 'm.csv', format: 'csv' as const },
      header_row: 1,
      columns,
      rows: [['P0001', '0', 'ldh', '210', 'U/L']],
    }
  }
  function fileWith(columns: string[]) {
    return {
      source: { name: 'm.csv', format: 'csv' as const },
      table: tableWith(columns),
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
      columnOffers: [],
    }
  }
  // adoptFile resets the offers ("a fresh drop has none") — the VALIDATE
  // settle derives them, exactly as FilesPage.patchFile does, so the tests
  // drive them in through the same public writer.
  const offerFor = (from: string) => [{ from, to: 'patient_id' }] as const

  it('renameColumn rewrites the table columns, drops the offer and nulls the validation', () => {
    TxrIntake.reset()
    TxrIntake.adoptFile('predictMeasurements', fileWith(['pid', 'day', 'marker', 'value', 'unit']))
    TxrIntake.patchFile('predictMeasurements', { columnOffers: [...offerFor('pid')] })
    TxrIntake.applyValidation(validationOf(), TxrIntake.currentValidationKey())
    expect(state().validation).not.toBeNull()

    TxrIntake.renameColumn('predictMeasurements', {
      from: 'pid',
      to: 'patient_id',
    })
    expect(state().predictMeasurements?.table.columns).toContain('patient_id')
    expect(state().predictMeasurements?.table.columns).not.toContain('pid')
    expect(state().predictMeasurements?.columnOffers).toEqual([])
    expect(state().validation).toBeNull()
  })

  it('rejectColumnOffer drops the suggestion only (no rename, validation stays)', () => {
    TxrIntake.reset()
    TxrIntake.adoptFile('measurements', fileWith(['pid', 'day', 'marker', 'value', 'unit']))
    TxrIntake.patchFile('measurements', { columnOffers: [...offerFor('pid')] })
    TxrIntake.applyValidation(validationOf(), TxrIntake.currentValidationKey())
    TxrIntake.rejectColumnOffer('measurements', 'pid')
    expect(state().measurements?.table.columns).toContain('pid')
    expect(state().measurements?.table.columns).not.toContain('patient_id')
    expect(state().measurements?.columnOffers).toEqual([])
    expect(state().validation).not.toBeNull()
  })

  it('the example fact is set by the start path and cleared by any adoption (F6)', () => {
    TxrIntake.reset()
    expect(state().exampleLoaded).toBe(false)
    TxrIntake.adoptExampleFile('measurements', fileWith(['patient_id', 'day']))
    expect(state().exampleLoaded).toBe(true)
    TxrIntake.adoptFile('measurements', fileWith(['patient_id', 'day']))
    expect(state().exampleLoaded).toBe(false)
    TxrIntake.adoptExampleFile('measurements', fileWith(['patient_id', 'day']))
    TxrIntake.removeFile('measurements')
    expect(state().exampleLoaded).toBe(false)
    TxrIntake.reset()
    expect(state().exampleLoaded).toBe(false)
  })
})

describe('qa-fixes3 ITEM-4 — the per-slot example fact, the clear action and the set handoff', () => {
  it('adoptExampleFile marks the slot (and the aggregate), a user adoption only clears that slot', () => {
    TxrIntake.reset()
    TxrIntake.adoptExampleFile('predictMeasurements', loadedFile('predict-measurements_example.csv'))
    expect(state().exampleSlots.predictMeasurements).toBe(true)
    expect(state().exampleSlots.measurements).toBe(false)
    expect(state().exampleLoaded).toBe(true)

    // A user's own drop into the slot clears ONLY the slot (the example is
    // gone there); the aggregate follows.
    TxrIntake.adoptFile('predictMeasurements', loadedFile('mine.csv'))
    expect(state().exampleSlots.predictMeasurements).toBe(false)
    expect(state().exampleLoaded).toBe(false)
  })

  it('clearExamples removes only the example-flagged slots and resets the offers + handoff', () => {
    TxrIntake.reset()
    TxrIntake.adoptExampleFile('patients', loadedFile('patients_example.csv'))
    TxrIntake.adoptExampleFile('measurements', loadedFile('measurements_example.csv'))
    // The user's own predict file is in the third slot — the clear must
    // never touch it.
    TxrIntake.adoptFile('predictMeasurements', loadedFile('predict.csv'))
    TxrIntake.setPendingExampleSet('set-1')
    TxrIntake.acceptJoin(joinOffer)

    TxrIntake.clearExamples()

    expect(state().patients).toBeNull()
    expect(state().measurements).toBeNull()
    expect(state().predictMeasurements?.source.name).toBe('predict.csv')
    expect(state().exampleLoaded).toBe(false)
    expect(state().exampleSlots).toEqual({
      patients: false,
      measurements: false,
      predictMeasurements: false,
    })
    // The example's measurement table left the flow — the confirmed
    // offers (an artifact of the removed files) are forgotten; the set
    // handoff is dropped.
    expect(state().joins).toEqual([])
    expect(state().pendingExampleSetId).toBeNull()
    // The user's own file's recall survives.
    expect(state().fileRecalls.predictMeasurements?.name).toBe('predict.csv')
  })

  it('clearExamples keeps the confirmed joins of a kept own measurements file', () => {
    TxrIntake.reset()
    TxrIntake.adoptExampleFile('patients', loadedFile('patients_example.csv'))
    TxrIntake.adoptFile('measurements', loadedFile('mine.csv'))
    TxrIntake.acceptJoin(joinOffer)

    TxrIntake.clearExamples()

    expect(state().patients).toBeNull()
    expect(state().measurements?.source.name).toBe('mine.csv')
    expect(state().joins).toEqual([joinOffer])
  })

  it('the set handoff is a non-persisted field: set + clear through the two actions', () => {
    TxrIntake.reset()
    expect(state().pendingExampleSetId).toBeNull()
    TxrIntake.setPendingExampleSet('set-7')
    expect(state().pendingExampleSetId).toBe('set-7')
    TxrIntake.setPendingExampleSet(null)
    expect(state().pendingExampleSetId).toBeNull()
    TxrIntake.reset()
    expect(state().pendingExampleSetId).toBeNull()
    expect(state().exampleSlots).toEqual({
      patients: false,
      measurements: false,
      predictMeasurements: false,
    })
  })

  it('the method ticks of screen E are a non-persisted field: set, kept apart from the persisted slice, cleared by reset', () => {
    TxrIntake.reset()
    expect(state().methodPicks).toBeNull()
    TxrIntake.setIntent('train')
    TxrIntake.setMethodPicks({ key: 'inv-1', selected: ['direct-on'], touched: true, preset: 'all' })
    expect(state().methodPicks).toEqual({
      key: 'inv-1',
      selected: ['direct-on'],
      touched: true,
      preset: 'all',
    })
    const raw = window.localStorage.getItem('txr-intake-storage') ?? ''
    expect(raw).not.toContain('methodPicks')
    expect(raw).not.toContain('direct-on')
    TxrIntake.reset()
    expect(state().methodPicks).toBeNull()
  })
})

describe('step2-filters — the persisted answer migration and the vocabulary reconcile', () => {
  const vocab: FilterOptions = {
    disease_categories: [
      {
        id: 'Solid tumours',
        diseases: [
          { id: 'colorectal cancer', children: [] },
          {
            id: 'kidney transplant',
            children: ['kidney transplant rejection', 'kidney transplant graft failure'],
          },
        ],
      },
    ],
    treatment_classes: [
      { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
      { id: 'chemotherapy', label: 'Chemotherapy' },
    ],
  }

  it('maps the OLD disease and treatment ids once, at rehydrate (never a crash, unknown → unanswered)', () => {
    const oldStudy = {
      disease: 'colorectal',
      treatment: 'immunotherapy',
      outcome: 'progression-by-day',
      markerGroups: { ctdna: true },
      beforeTreatment: 'always',
      drawsDuringTreatment: 2,
      lastDrawDay: 84,
    }
    const merged = normalizePersistedStudy(oldStudy)
    expect(merged.disease).toBe('colorectal cancer')
    expect(merged.treatments).toEqual(['immune checkpoint inhibitor'])
    expect(merged.outcome).toBe('progression-by-day')
    expect(merged.markerGroups).toEqual({ ctdna: true })
    expect(merged.beforeTreatment).toBe('always')
    expect(merged.drawsDuringTreatment).toBe(2)
    expect(merged.lastDrawDay).toBe(84)

    const other = normalizePersistedStudy({ disease: 'other', treatment: 'other-mixed' })
    expect(other.disease).toBeNull()
    expect(other.treatments).toBeNull()
    // A wrong-type value is unanswered, never a crash.
    const wrong = normalizePersistedStudy({ disease: 42, treatment: ['chemotherapy'] })
    expect(wrong.disease).toBeNull()
    expect(wrong.treatments).toBeNull()
    // An empty persisted object is the birth state.
    expect(normalizePersistedStudy({})).toEqual({
      disease: null,
      treatments: null,
      outcome: null,
      markerGroups: null,
      beforeTreatment: null,
      drawsDuringTreatment: null,
      lastDrawDay: null,
    })
  })

  it('reads the OLD-id map with hasOwn — prototype names never match an old id (5a3)', () => {
    // `in` on a plain object matches the prototype, so the old code mapped
    // "constructor"/"toString"/"__proto__": a disease held the prototype
    // down as the answer, a treatment held Object.prototype as its list.
    // hasOwn: an unknown OLD-shape value is unanswered; a NEW-shape string
    // (the current ids are the catalogue's names) passes through as itself.
    const ctor = normalizePersistedStudy({ disease: 'constructor', treatment: 'constructor' })
    expect(ctor.disease).toBe('constructor')
    expect(ctor.treatments).toBeNull()
    const proto = normalizePersistedStudy({ disease: '__proto__', treatment: '__proto__' })
    expect(proto.disease).toBe('__proto__')
    expect(proto.treatments).toBeNull()
    const str = normalizePersistedStudy({ disease: 'toString', treatment: 'toString' })
    expect(str.disease).toBe('toString')
    expect(str.treatments).toBeNull()
    // The real old ids still map.
    expect(normalizePersistedStudy({ disease: 'lung', treatment: 'targeted' }).disease).toBe(
      'lung cancer',
    )
    expect(
      normalizePersistedStudy({ disease: 'lung', treatment: 'targeted' }).treatments,
    ).toEqual(['targeted therapy'])
  })

  it('a persisted treatments list that is empty or has a non-string entry is unanswered (5a3)', () => {
    // An empty list is the store's "no filter" spelling — the example
    // family's `isExampleStudy` reads `treatments === null`, so an
    // unanswered list must be null, never [].
    expect(normalizePersistedStudy({ treatments: [] }).treatments).toBeNull()
    expect(normalizePersistedStudy({ treatments: [1] }).treatments).toBeNull()
    expect(
      normalizePersistedStudy({ treatments: ['chemotherapy', 2] }).treatments,
    ).toBeNull()
    // The well-formed list is kept, in order.
    expect(
      normalizePersistedStudy({ treatments: ['chemotherapy', 'radiotherapy'] }).treatments,
    ).toEqual(['chemotherapy', 'radiotherapy'])
  })

  it('passes the NEW shape through the merge untouched (the id list keeps order)', () => {
    const merged = normalizePersistedStudy({
      disease: 'melanoma',
      treatments: ['chemotherapy', 'radiotherapy'],
      outcome: null,
      markerGroups: null,
      beforeTreatment: null,
      drawsDuringTreatment: null,
      lastDrawDay: null,
    })
    expect(merged.disease).toBe('melanoma')
    expect(merged.treatments).toEqual(['chemotherapy', 'radiotherapy'])
  })

  it('the persisted old shape hydrates through the REAL persist store (merge runs the map)', async () => {
    TxrIntake.reset()
    // Write a PRE-migration persisted envelope directly into localStorage.
    window.localStorage.setItem(
      'txr-intake-storage',
      JSON.stringify({
        state: {
          intent: 'train',
          mode: 'study',
          study: { disease: 'lung', treatment: 'targeted', outcome: 'dynamic-risk' },
          fileRecalls: { patients: null, measurements: null, predictMeasurements: null },
          joins: [],
          mapping: [],
          parameters: { decision_day: 56, baseline_max_day: 0 },
        },
        version: 0,
      }),
    )
    vi.resetModules()
    const fresh = await import('./TxrIntake.store')
    const study = fresh.useTxrIntakeStore.getState().study
    expect(study.disease).toBe('lung cancer')
    expect(study.treatments).toEqual(['targeted therapy'])
    expect(study.outcome).toBe('dynamic-risk')
  })

  it('reconcileStudyWithVocabulary drops an unknown disease/treatment id to unanswered (the 422 guard)', () => {
    TxrIntake.reset()
    TxrIntake.patchStudy({
      disease: 'not-a-vocabulary-id',
      treatments: ['immune checkpoint inhibitor', 'gone-away'],
    })
    TxrIntake.reconcileStudyWithVocabulary(vocab)
    const s = state()
    expect(s.study.disease).toBeNull()
    // Known ids stay, unknown ones are dropped; all-unknown → unanswered.
    expect(s.study.treatments).toEqual(['immune checkpoint inhibitor'])
    TxrIntake.patchStudy({ treatments: ['gone-away'] })
    TxrIntake.reconcileStudyWithVocabulary(vocab)
    expect(state().study.treatments).toBeNull()
  })

  it('reconcileStudyWithVocabulary is idempotent: an all-known state changes nothing', () => {
    TxrIntake.reset()
    TxrIntake.patchStudy({
      disease: 'colorectal cancer',
      treatments: ['chemotherapy'],
      outcome: 'dynamic-risk',
    })
    const before = state().study
    TxrIntake.reconcileStudyWithVocabulary(vocab)
    expect(state().study).toEqual(before)
  })
})
