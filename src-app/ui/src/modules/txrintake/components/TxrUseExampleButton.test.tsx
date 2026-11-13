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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { IntakeIntent, LoadedFile } from '../types'
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

/** A long failure line (the case that broke the Start cards' button row). */
const LONG_ERROR =
  'No method with a published environment can run on the example data on this computer, so the ' +
  'example models could not be prepared. Check the method catalogue and try again.'

/** A host that places the two parts apart: the action in its row, the message under it. */
function SplitHost({ path, onDone }: { path: IntakeIntent; onDone?: () => void }) {
  return (
    <TxrUseExampleButton
      path={path}
      onDone={onDone}
      layout={({ action, message }) => (
        <div>
          <div data-testid="host-row">{action}</div>
          {message === null ? (
            <span data-testid="host-no-message" />
          ) : (
            <div data-testid="host-below">{message}</div>
          )}
        </div>
      )}
    />
  )
}

/** The row's children: the action alone (or nothing while the confirm is open). */
const rowChildren = () => Array.from(screen.getByTestId('host-row').children)

describe('TxrUseExampleButton — the layout split (the Start cards)', () => {
  it('with nothing to say, the action is the button alone and the message is null', () => {
    render(<SplitHost path="train" />)
    expect(rowChildren().map(el => el.getAttribute('data-testid'))).toEqual(['txr-use-example-train'])
    expect(screen.getByTestId('host-no-message')).toBeTruthy()
  })

  it('a failure puts the error line in the message, never beside the button', async () => {
    api.example.mockRejectedValueOnce(new Error(LONG_ERROR))
    render(<SplitHost path="train" />)
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    const below = screen.getByTestId('host-below')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(LONG_ERROR)
    expect(below.contains(alert)).toBe(true)
    expect(within(below).getByTestId('txr-use-example-message-train').contains(alert)).toBe(true)
    // The row holds the retry button and nothing else.
    expect(rowChildren().map(el => el.getAttribute('data-testid'))).toEqual(['txr-use-example-train'])
    expect(rowChildren()[0]!.textContent).toBe('Try again')
    expect(screen.getByTestId('host-row').contains(alert)).toBe(false)
  })

  it('the reuse progress line is in the message while the example set trains', async () => {
    api.exampleSet
      .mockResolvedValueOnce({ state: 'creating', run_id: 'r1', run_status: 'running', methods: ['kelim'], set_id: undefined, error: undefined })
      .mockResolvedValueOnce({ state: 'ready', set_id: 'set-3', methods: ['kelim'], run_id: undefined, run_status: undefined, error: undefined })
    const onDone = vi.fn()
    render(<SplitHost path="reuse" onDone={onDone} />)
    fireEvent.click(screen.getByTestId('txr-use-example-reuse'))
    await waitFor(() => expect(screen.getByTestId('txr-use-example-progress-reuse')).toBeTruthy())

    const progress = screen.getByTestId('txr-use-example-progress-reuse')
    expect(screen.getByTestId('host-below').contains(progress)).toBe(true)
    expect(rowChildren().map(el => el.getAttribute('data-testid'))).toEqual(['txr-use-example-reuse'])
    // The poll's real cadence is 1500 ms (see the progress case above).
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5000 })
  })

  it('the confirm question replaces the button and sits in the message with both answers', async () => {
    state().adoptFile('predictMeasurements', ownFile())
    const onDone = vi.fn()
    render(<SplitHost path="pretrained" onDone={onDone} />)
    fireEvent.click(screen.getByTestId('txr-use-example-pretrained'))

    // The action is null while the question is open: the row is empty.
    expect(rowChildren()).toHaveLength(0)
    const below = screen.getByTestId('host-below')
    expect(within(below).getByTestId('txr-use-example-confirm')).toBeTruthy()
    expect(within(below).getByTestId('txr-use-example-confirm-yes')).toBeTruthy()
    expect(within(below).getByTestId('txr-use-example-confirm-no')).toBeTruthy()

    fireEvent.click(screen.getByTestId('txr-use-example-confirm-yes'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('txr-use-example-confirm')).toBeNull()
    expect(rowChildren().map(el => el.getAttribute('data-testid'))).toEqual(['txr-use-example-pretrained'])
    expect(screen.getByTestId('host-no-message')).toBeTruthy()
  })
})

/** A promise the test settles by hand (the example fetch stays pending until then). */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The button's own label node: the width holder index.css keeps in the flow while busy. */
const labelOf = (button: HTMLElement) =>
  Array.from(button.children).find(child => child.classList.contains('txr-use-example-label')) ?? null

describe('TxrUseExampleButton — loading keeps the button width', () => {
  it('while loading the label stays in place (hidden by index.css) and the kit spinner is a direct child', async () => {
    const pending = deferred<string>()
    api.example.mockReturnValue(pending.promise)
    render(<TxrUseExampleButton path="train" />)
    const button = screen.getByTestId('txr-use-example-train')
    expect(button.classList.contains('txr-use-example-button')).toBe(true)
    expect(labelOf(button)?.textContent).toBe('Use example')
    expect(button.getAttribute('aria-busy')).toBeNull()

    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'))
    // The index.css rule reads exactly this shape: the busy button, the
    // kit's spinner as a direct `svg.animate-spin` child, the label span.
    expect(button.querySelector(':scope > svg.animate-spin')).not.toBeNull()
    expect(labelOf(button)?.textContent).toBe('Use example')
    expect(button.textContent).toBe('Use example')
    // The name does not depend on the hidden label.
    expect(screen.getByRole('button', { name: 'Use example data: learn from my data' })).toBe(button)
    pending.resolve(PATIENTS_CSV)
  })

  it('a retry keeps "Try again" while it loads, and the label returns to "Use example" after a success', async () => {
    api.example.mockRejectedValueOnce(new Error('net down'))
    const onDone = vi.fn()
    render(<TxrUseExampleButton path="pretrained" onDone={onDone} />)
    const button = screen.getByTestId('txr-use-example-pretrained')
    fireEvent.click(button)
    await waitFor(() => expect(labelOf(button)?.textContent).toBe('Try again'))

    const pending = deferred<string>()
    api.example.mockReturnValueOnce(pending.promise)
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'))
    // The error line is gone, but the label the button had stays (same width).
    expect(screen.queryByRole('alert')).toBeNull()
    expect(labelOf(button)?.textContent).toBe('Try again')

    await act(async () => pending.resolve(PREDICT_CSV))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(labelOf(button)?.textContent).toBe('Use example')
  })

  it('a retry that fails again ends on "Try again" with the error line', async () => {
    // The pretrained path fetches ONE file per attempt (train fetches two).
    api.example.mockRejectedValueOnce(new Error('net down')).mockRejectedValueOnce(new Error('still down'))
    render(<TxrUseExampleButton path="pretrained" />)
    const button = screen.getByTestId('txr-use-example-pretrained')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('net down'))
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('still down'))
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(labelOf(button)?.textContent).toBe('Try again')
  })
})
