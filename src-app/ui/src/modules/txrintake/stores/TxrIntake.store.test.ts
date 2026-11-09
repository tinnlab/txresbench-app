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
  MarkerMatch,
  ValidationResponse,
} from '@/api-client/types'
import type { ParsedTable } from '@/lib/txr-files/types'
import type { IntakeSnapshot, JoinOffer, LoadedFile, VocabOffer } from '../types'

const storeModule = await import('./TxrIntake.store')
const { TxrIntake, useTxrIntakeStore, buildTxrRunInput } = storeModule

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

  it('patchParameters snaps decision_day to the four board values and keeps baseline_max_day 0', () => {
    TxrIntake.patchParameters({ decision_day: 100 })
    expect(state().parameters).toEqual({ decision_day: 84, baseline_max_day: 0 })

    TxrIntake.patchParameters({ decision_day: 35 }) // tie between 28 and 42 → the earlier day
    expect(state().parameters.decision_day).toBe(28)

    TxrIntake.patchParameters({ decision_day: 42 })
    expect(state().parameters.decision_day).toBe(42)

    // baseline_max_day is accepted for shape compatibility and never stored different.
    TxrIntake.patchParameters({ baseline_max_day: 90, decision_day: Number.NaN })
    expect(state().parameters).toEqual({ decision_day: 42, baseline_max_day: 0 })

    TxrIntake.patchParameters({})
    expect(state().parameters).toEqual({ decision_day: 42, baseline_max_day: 0 })
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

    const input = buildTxrRunInput(state() as IntakeSnapshot)
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
    const input = buildTxrRunInput(state() as IntakeSnapshot)
    expect(input.patients).toBeUndefined()
    expect(input.measurements).toBe(state().predictMeasurements?.table)
    // The engine's reuse/pretrained contract carries the predict file as the
    // separate table (EXAMPLE-EE-7) while the request type requires
    // `measurements` — the run's only table fills it (recorded for
    // RECONCILE with the engine's own plan text).
    expect(input.predict_measurements).toBe(state().predictMeasurements?.table)
    expect(input.keep_copies).toBe(true)
  })

  it('buildTxrRunInput refuses a snapshot with no measurements file', () => {
    expect(() => buildTxrRunInput(state() as IntakeSnapshot)).toThrow(
      /no measurements file adopted/,
    )
  })

  it('the persist partialize keeps the small fields and never the payloads', () => {
    TxrIntake.setIntent('train')
    TxrIntake.patchStudy({ disease: 'colorectal', lastDrawDay: 84 })
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
    expect((persisted.study as { disease: string }).disease).toBe('colorectal')
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
    TxrIntake.patchStudy({ disease: 'breast', drawsDuringTreatment: 4 })
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
    expect(rehydrated.study.disease).toBe('breast')
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
    expect(state().predictMeasurements?.table.columns[0]).toBe('patient_id')
    expect(state().predictMeasurements?.columnOffers).toEqual([])
    expect(state().validation).toBeNull()
  })

  it('rejectColumnOffer drops the suggestion only (no rename, validation stays)', () => {
    TxrIntake.reset()
    TxrIntake.adoptFile('measurements', fileWith(['pid', 'day', 'marker', 'value', 'unit']))
    TxrIntake.patchFile('measurements', { columnOffers: [...offerFor('pid')] })
    TxrIntake.applyValidation(validationOf(), TxrIntake.currentValidationKey())
    TxrIntake.rejectColumnOffer('measurements', 'pid')
    expect(state().measurements?.table.columns[0]).toBe('pid')
    expect(state().measurements?.columnOffers).toEqual([])
    expect(state().validation).not.toBeNull()
  })

  it('the example fact is set by the start path and cleared by any adoption (F6)', () => {
    TxrIntake.reset()
    expect(state().exampleLoaded).toBe(false)
    TxrIntake.setExampleLoaded(true)
    expect(state().exampleLoaded).toBe(true)
    TxrIntake.adoptFile('measurements', fileWith(['patient_id', 'day']))
    expect(state().exampleLoaded).toBe(false)
    TxrIntake.setExampleLoaded(true)
    TxrIntake.removeFile('measurements')
    expect(state().exampleLoaded).toBe(false)
    TxrIntake.reset()
    expect(state().exampleLoaded).toBe(false)
  })
})
