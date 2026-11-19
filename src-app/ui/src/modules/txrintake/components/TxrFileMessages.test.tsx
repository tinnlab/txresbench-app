// @vitest-environment jsdom
/**
 * step3-file-cards A — the messages row (`components/TxrFileMessages.tsx`):
 * one full-width row under the file cards, a block per CHOSEN file in the
 * order given (patients, then measurements), each titled with the file kind
 * and the file name; a slot without a file gets no block and an empty row
 * renders nothing; the offers report the OFFER OBJECT to the host's
 * callbacks and the red box's fix link is the slot's own remove path.
 *
 * Like the card test, the row reads the real TxrIntake store's shared
 * `validation` slot (reset per test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FileInspection, ValidationResponse } from '@/api-client/types'
import { TxrFileMessagesRow, type TxrFileMessagesSlot } from './TxrFileMessages'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { JoinOffer, LoadedFile } from '../types'

const joinOffer: JoinOffer = { variants: ['ldh', 'LDH'], key: 'ldh' }

const dayProblem = {
  code: 'R03' as const,
  severity: 'error' as const,
  row: 14,
  column: 'day',
  message: '`week 4` is not a number in the day column',
}

function inspection(kind: 'patients' | 'measurements', name: string): FileInspection {
  return {
    kind,
    source_name: name,
    columns: { resolved: {}, unresolved: [], covariate_columns: [] },
    problems: [],
    summary: { rows: 12, markers: [], draw_days: [] },
  }
}

function loaded(
  kind: 'patients' | 'measurements',
  name: string,
  overrides: Partial<LoadedFile> = {},
): LoadedFile {
  return {
    source: { name, format: 'csv' },
    table: {
      source: { name, format: 'csv' },
      header_row: 1,
      columns: ['patient_id'],
      rows: [['P0001']],
    },
    inspection: inspection(kind, name),
    problems: [],
    prepared: true,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: [],
    ...overrides,
  }
}

function validation(overrides: Partial<ValidationResponse> = {}): ValidationResponse {
  return {
    patients: { rows: 12, with_primary_outcome: 9, primary_outcome_events: 9, median_followup_days: 200 },
    measurements: { rows: 40, patients: 12, distinct_draw_days: [0, 14] },
    markers: [],
    problems: [],
    inventory: { baseline_max_day: 0, decision_day: 56, patients: 12, covariates: [], markers: [] },
    ...overrides,
  }
}

function seedValidation(response: ValidationResponse) {
  useTxrIntakeStore.getState().applyValidation(response, {
    joins: [],
    mapping: [],
    parameters: { decision_day: 56, baseline_max_day: 0 },
  })
}

function renderRow(
  slots: Array<Omit<TxrFileMessagesSlot, 'onRemove'>>,
  mode: 'study' | 'predict' = 'study',
) {
  const removes = slots.map(() => vi.fn())
  const handlers = {
    onAcceptJoin: vi.fn(),
    onRejectJoin: vi.fn(),
    onAcceptVocab: vi.fn(),
    onRejectVocab: vi.fn(),
    onAcceptColumn: vi.fn(),
    onRejectColumn: vi.fn(),
  }
  render(
    <MemoryRouter initialEntries={['/files']}>
      <div data-testid="host">
        <TxrFileMessagesRow
          mode={mode}
          slots={slots.map((slot, index) => ({ ...slot, onRemove: removes[index] }))}
          {...handlers}
        />
      </div>
    </MemoryRouter>,
  )
  return { removes, handlers }
}

beforeEach(() => {
  window.localStorage.clear()
  useTxrIntakeStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrFileMessagesRow (step3-file-cards A)', () => {
  it('renders nothing while no file is chosen', () => {
    renderRow([
      { kind: 'patients', file: null },
      { kind: 'measurements', file: null },
    ])
    expect(screen.queryByTestId('txr-intake-file-messages')).toBeNull()
    expect(screen.getByTestId('host').childElementCount).toBe(0)
  })

  it('a block per chosen file, patients first, titled with the kind and the file name', () => {
    seedValidation(validation())
    renderRow([
      { kind: 'patients', file: loaded('patients', 'cohort_patients.csv') },
      { kind: 'measurements', file: loaded('measurements', 'blood_draws.xlsx') },
    ])
    const row = screen.getByTestId('txr-intake-file-messages')
    const blocks = row.querySelectorAll(':scope > section')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].getAttribute('data-testid')).toBe('txr-intake-file-messages-patients')
    expect(blocks[1].getAttribute('data-testid')).toBe('txr-intake-file-messages-measurements')
    expect(screen.getByTestId('txr-intake-file-messages-title-patients').textContent).toBe(
      'Patients file: cohort_patients.csv',
    )
    expect(screen.getByTestId('txr-intake-file-messages-title-measurements').textContent).toBe(
      'Measurements file: blood_draws.xlsx',
    )
    // Each block holds its own file's status box (same test ids as before).
    expect(
      within(blocks[0] as HTMLElement).getByTestId('txr-intake-file-status-patients'),
    ).toBeTruthy()
    expect(
      within(blocks[1] as HTMLElement).getByTestId('txr-intake-file-status-measurements'),
    ).toBeTruthy()
    expect(within(blocks[1] as HTMLElement).getByText('✓ 12 patients read')).toBeTruthy()
  })

  it('a slot without a file gets no block (no empty block)', () => {
    renderRow([
      { kind: 'patients', file: loaded('patients', 'patients.csv') },
      { kind: 'measurements', file: null },
    ])
    expect(screen.getByTestId('txr-intake-file-messages-patients')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-messages-measurements')).toBeNull()
    expect(screen.queryByTestId('txr-intake-file-status-measurements')).toBeNull()
    expect(screen.getByText('We check the files once both are here.')).toBeTruthy()
  })

  it('the offers in the row report the OFFER OBJECT to the host callbacks', () => {
    const { handlers } = renderRow([
      {
        kind: 'measurements',
        file: loaded('measurements', 'm.csv', {
          joinOffers: [joinOffer],
          columnOffers: [{ from: 'pid', to: 'patient_id' }],
        }),
      },
    ])
    const block = screen.getByTestId('txr-intake-file-messages-measurements')
    fireEvent.click(within(block).getByTestId('txr-intake-join-accept-ldh'))
    expect(handlers.onAcceptJoin).toHaveBeenCalledWith(joinOffer)
    fireEvent.click(within(block).getByTestId('txr-intake-join-decline-ldh'))
    expect(handlers.onRejectJoin).toHaveBeenCalledWith(joinOffer)
    fireEvent.click(within(block).getByTestId('txr-intake-column-accept-pid'))
    expect(handlers.onAcceptColumn).toHaveBeenCalledWith({ from: 'pid', to: 'patient_id' })
    fireEvent.click(within(block).getByTestId('txr-intake-column-decline-pid'))
    expect(handlers.onRejectColumn).toHaveBeenCalledWith({ from: 'pid', to: 'patient_id' })
  })

  it("the red box's fix link calls the slot's own remove path", () => {
    seedValidation(validation({ problems: [dayProblem] }))
    const { removes } = renderRow([
      { kind: 'patients', file: loaded('patients', 'p.csv') },
      { kind: 'measurements', file: loaded('measurements', 'm.csv', { problems: [dayProblem] }) },
    ])
    const block = screen.getByTestId('txr-intake-file-messages-measurements')
    expect(within(block).getByText('1 problem in 12 rows')).toBeTruthy()
    fireEvent.click(within(block).getByTestId('txr-intake-file-fix-measurements'))
    expect(removes[1]).toHaveBeenCalledTimes(1)
    expect(removes[0]).not.toHaveBeenCalled()
  })

  it('predict mode: the one measurements block carries the board N continuation', () => {
    seedValidation(validation())
    renderRow([{ kind: 'measurements', file: loaded('measurements', 'predict.csv') }], 'predict')
    expect(screen.getByTestId('txr-intake-file-messages-title-measurements').textContent).toBe(
      'Measurements file: predict.csv',
    )
    expect(
      within(screen.getByTestId('txr-intake-file-status-measurements')).getByText(
        /Next you choose the models that can run on it\.$/,
      ),
    ).toBeTruthy()
  })
})
