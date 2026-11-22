// @vitest-environment jsdom
/**
 * step3-file-cards A — `TxrFileMessages` (`components/TxrFileMessages.tsx`):
 * what the check says about ONE adopted file — the join / vocabulary /
 * column-rename offer rows, the status box (green board line / red "N
 * problems in N rows" / the neutral "rows read" state) and the per-row
 * problem list; the offers report the OFFER OBJECT to the host's callbacks
 * and the red box's fix link is the file's own remove path, with no title
 * and no frame of its own.
 *
 * The card host (`TxrFileCard`) places these parts — the title + this
 * component — inside the card, in its full-width row (screens C and N and
 * the E-screen dialog); `TxrFileCard.test.tsx` covers the place (the
 * full-width row inside the card and its title bytes, the parts rendered
 * ONCE per card, no row without a file). This file covers the parts
 * themselves: nothing renders before a file is adopted, the offer rows
 * report the OFFER OBJECT to the host's callbacks, the red box's fix link
 * is the file's own remove path, and predict mode carries the board N
 * continuation. Like the card test, the messages read the real TxrIntake
 * store's shared `validation` slot (reset per test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FileInspection, ValidationResponse } from '@/api-client/types'
import { TxrFileMessages } from './TxrFileMessages'
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

function renderMessages(
  kind: 'patients' | 'measurements',
  file: LoadedFile | null,
  mode: 'study' | 'predict' = 'study',
) {
  const handlers = {
    onAcceptJoin: vi.fn(),
    onRejectJoin: vi.fn(),
    onAcceptVocab: vi.fn(),
    onRejectVocab: vi.fn(),
    onAcceptColumn: vi.fn(),
    onRejectColumn: vi.fn(),
  }
  const onRemove = vi.fn()
  render(
    <MemoryRouter initialEntries={['/files']}>
      <div data-testid="host">
        <TxrFileMessages kind={kind} mode={mode} file={file} onRemove={onRemove} {...handlers} />
      </div>
    </MemoryRouter>,
  )
  return { handlers, onRemove }
}

beforeEach(() => {
  window.localStorage.clear()
  useTxrIntakeStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrFileMessages (step3-file-cards A — one file\'s messages)', () => {
  it('renders nothing before a file is adopted', () => {
    renderMessages('patients', null)
    expect(screen.getByTestId('host').childElementCount).toBe(0)
  })

  it('the offers report the OFFER OBJECT to the host callbacks', () => {
    const { handlers } = renderMessages('measurements', loaded('measurements', 'm.csv', {
      joinOffers: [joinOffer],
      columnOffers: [{ from: 'pid', to: 'patient_id' }],
    }))
    fireEvent.click(screen.getByTestId('txr-intake-join-accept-ldh'))
    expect(handlers.onAcceptJoin).toHaveBeenCalledWith(joinOffer)
    fireEvent.click(screen.getByTestId('txr-intake-join-decline-ldh'))
    expect(handlers.onRejectJoin).toHaveBeenCalledWith(joinOffer)
    fireEvent.click(screen.getByTestId('txr-intake-column-accept-pid'))
    expect(handlers.onAcceptColumn).toHaveBeenCalledWith({ from: 'pid', to: 'patient_id' })
    fireEvent.click(screen.getByTestId('txr-intake-column-decline-pid'))
    expect(handlers.onRejectColumn).toHaveBeenCalledWith({ from: 'pid', to: 'patient_id' })
  })

  it("the red box's fix link calls the file's own remove path", () => {
    seedValidation(validation({ problems: [dayProblem] }))
    const { onRemove } = renderMessages('measurements', loaded('measurements', 'm.csv', {
      problems: [dayProblem],
    }))
    expect(screen.getByText('1 problem in 12 rows')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-file-fix-measurements'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('predict mode: the measurements box carries the board N continuation', () => {
    seedValidation(validation())
    renderMessages('measurements', loaded('measurements', 'predict.csv'), 'predict')
    expect(
      within(screen.getByTestId('txr-intake-file-status-measurements')).getByText(
        /Next you choose the models that can run on it\.$/,
      ),
    ).toBeTruthy()
  })
})
