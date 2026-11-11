// @vitest-environment jsdom
/**
 * TEST-QF3-2 [covers qa-fixes3 ITEM-4] — the `TxrUseExampleButton`:
 * the three states (accessible name, loading, error + retry), the inline
 * confirm before overwriting a user's file, and the ITEM-3 set progress
 * line on the reuse path.
 *
 * The ApiClient is mocked; the store is the real TxrIntake store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { LoadedFile } from '../types'
import { TxrUseExampleButton } from './TxrUseExampleButton'

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

function ownFile(name = 'mine.csv'): LoadedFile {
  return {
    source: { name, format: 'csv' },
    table: {
      source: { name, format: 'csv' },
      header_row: 1,
      columns: ['patient_id', 'day', 'marker', 'value', 'unit'],
      rows: [['P0001', '0', 'ldh', '210', 'U/L']],
    },
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: [],
  }
}

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
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrUseExampleButton (TEST-QF3-2)', () => {
  it('has the visible label and a per-path accessible name', () => {
    render(<TxrUseExampleButton path="train" />)
    const button = screen.getByRole('button', { name: 'Use example data: learn from my data' })
    expect(button.textContent).toBe('Use example')
  })

  it('one click runs the flow and calls onDone (everything filled)', async () => {
    const onDone = vi.fn()
    render(<TxrUseExampleButton path="train" onDone={onDone} />)
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(state().intent).toBe('train')
    expect(state().exampleSlots.patients).toBe(true)
    expect(state().exampleSlots.measurements).toBe(true)
  })

  it('a user file in the path slot asks first; Keep my files cancels, the confirm replaces', async () => {
    state().adoptFile('predictMeasurements', ownFile())
    const onDone = vi.fn()
    render(<TxrUseExampleButton path="pretrained" onDone={onDone} />)

    fireEvent.click(screen.getByTestId('txr-use-example-pretrained'))
    expect(screen.getByTestId('txr-use-example-confirm')).toBeTruthy()
    expect(api.example).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('txr-use-example-confirm-no'))
    expect(screen.queryByTestId('txr-use-example-confirm')).toBeNull()
    expect(state().predictMeasurements?.source.name).toBe('mine.csv')

    fireEvent.click(screen.getByTestId('txr-use-example-pretrained'))
    fireEvent.click(screen.getByTestId('txr-use-example-confirm-yes'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(state().exampleSlots.predictMeasurements).toBe(true)
    expect(state().predictMeasurements?.source.name).toBe('predict-measurements_example.csv')
  })

  it('an example-loaded slot needs no confirm (re-click reloads the example)', async () => {
    state().adoptExampleFile('predictMeasurements', ownFile('predict-measurements_example.csv'))
    const onDone = vi.fn()
    render(<TxrUseExampleButton path="reuse" onDone={onDone} />)
    api.exampleSet.mockResolvedValueOnce({ state: 'ready', set_id: 'set-1', methods: ['kelim'], run_id: undefined, run_status: undefined, error: undefined })
    fireEvent.click(screen.getByTestId('txr-use-example-reuse'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('txr-use-example-confirm')).toBeNull()
    expect(state().pendingExampleSetId).toBe('set-1')
  })

  it('the reuse path shows the set-training progress while creating', async () => {
    api.exampleSet
      .mockResolvedValueOnce({ state: 'creating', run_id: 'r1', run_status: 'running', methods: ['kelim'], set_id: undefined, error: undefined })
      .mockResolvedValueOnce({ state: 'ready', set_id: 'set-2', methods: ['kelim'], run_id: undefined, run_status: undefined, error: undefined })
    const onDone = vi.fn()
    render(<TxrUseExampleButton path="reuse" onDone={onDone} />)
    fireEvent.click(screen.getByTestId('txr-use-example-reuse'))
    await waitFor(() =>
      expect(screen.getByText(/Preparing the example models/)).toBeTruthy(),
    )
    // The poll's real cadence is 1500 ms — the second call needs a wider
    // waitFor budget than the default 1000 ms.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5000 })
    expect(state().pendingExampleSetId).toBe('set-2')
  })

  it('a failure shows the honest line and the button retries', async () => {
    api.example.mockRejectedValueOnce(new Error('net down'))
    const onDone = vi.fn()
    render(<TxrUseExampleButton path="train" onDone={onDone} />)
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Use example data: learn from my data' }).textContent).toBe('Try again')
    expect(onDone).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
