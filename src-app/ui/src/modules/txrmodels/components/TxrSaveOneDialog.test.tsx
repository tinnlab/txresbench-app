// @vitest-environment jsdom
/**
 * TEST-MOD-14 — ITEM-9 — the `TxrSaveOneDialog` suite (dialog L2,
 * `SaveOne.dc.html`; PROV-UI-MODELS-5, CONS-UM-6/7/12).
 *
 * Pinned behaviors:
 *
 * - one load of the run detail + the set list per open, the summary line
 *   from the run's facts ("<id> · <size> · learned from N patients,
 *   decision day D" — the produced model's recorded size and cohort);
 * - the "Save it in" select renders "A new set" first, then each existing
 *   set with its model count ("CRC cohort, day 60 (7 models already
 *   saved)" — the set's own count);
 * - the new-set name input is visible ONLY while "A new set" is chosen
 *   and hidden for an existing set (the board's field);
 * - Save posts `target: {set_name}` for a new set and `target: {set_id}`
 *   for an existing one, with the keep-training-files checkbox and the
 *   run's source label;
 * - the dialog never closes on a server rejection (the engine's line is
 *   inline) and Cancel closes without a call;
 * - a run whose detail has no produced model for the id renders the
 *   honest "no model to save" state with the save disabled.
 *
 * Every payload is the module's synthetic run/set fixture (INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Checkbox/Select) construct one on pointer interaction, which would
// throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in (the shared-list suite's shim, copied).
{
  const w = window as unknown as {
    PointerEvent?: new (type: string, init?: MouseEventInit) => MouseEvent
  }
  try {
    void new (w.PointerEvent as new (type: string, init?: MouseEventInit) => MouseEvent)('probe')
  } catch {
    w.PointerEvent = class extends MouseEvent {}
  }
}

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { TXRMODELS_MODEL_SET_LIST, TXRMODELS_RUN, TXRMODELS_SAVE_RESPONSE } from '../fixtures'
import { TxrSaveOneDialog } from './TxrSaveOneDialog'

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  listSets: vi.fn(),
  saveModels: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: { getRun: api.getRun },
    ModelSets: { listSets: api.listSets },
    Models: { saveModels: api.saveModels },
  },
}))

function renderDialog(over: { runId?: string | null; methodId?: string | null; onClose?: () => void; onSaved?: (r: unknown) => void } = {}) {
  const onClose = over.onClose ?? vi.fn()
  const onSaved = over.onSaved ?? vi.fn()
  render(
    <MemoryRouter>
      <TxrSaveOneDialog
        runId={over.runId === undefined ? 'run-c' : over.runId}
        methodId={over.methodId === undefined ? 'rm-4' : over.methodId}
        onClose={onClose}
        onSaved={onSaved}
      />
    </MemoryRouter>,
  )
  return { onClose, onSaved }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getRun.mockResolvedValue(TXRMODELS_RUN)
  api.listSets.mockResolvedValue(TXRMODELS_MODEL_SET_LIST)
  api.saveModels.mockResolvedValue(TXRMODELS_SAVE_RESPONSE)
  useTxrModelsStore.getState().setDraftName('')
})

afterEach(() => {
  cleanup()
  useTxrModelsStore.getState().setDraftName('')
})

describe('TxrSaveOneDialog (TEST-MOD-14)', () => {
  it('loads the run detail + the set list once and renders the summary line', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-body')).toBeDefined())
    expect(api.getRun).toHaveBeenCalledTimes(1)
    expect(api.getRun).toHaveBeenCalledWith({ id: 'run-c' })
    expect(api.listSets).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('txr-models-saveone-summary').textContent).toBe(
      'rm-4 \u00b7 12 MB \u00b7 learned from 42 patients, decision day 60',
    )
  })

  it('renders "A new set" first and each existing set with its model count', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-set-select')).toBeDefined())
    const trigger = screen.getByTestId('txr-models-saveone-set-select')
    // The closed trigger shows the first option (the board's default).
    expect(trigger.textContent).toContain('A new set')
    expect(screen.getByTestId('txr-models-saveone-name')).toBeDefined()

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    expect(
      document.querySelector('[data-testid="txr-models-saveone-set-select-opt-set-a"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-testid="txr-models-saveone-set-select-opt-set-a"]')?.textContent,
    ).toContain('CRC cohort, day 60 (7 models already saved)')
    expect(
      document.querySelector('[data-testid="txr-models-saveone-set-select-opt-set-b"]')?.textContent,
    ).toContain('Lung pilot, day 35 (3 models already saved)')
  })

  it('shows the new-set name field only for the new-set choice', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-set-select')).toBeDefined())
    const selectOption = async (value: string): Promise<void> => {
      const trigger = screen.getByTestId('txr-models-saveone-set-select')
      await act(async () => {
        fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
        fireEvent.click(trigger)
        await Promise.resolve()
      })
      const option = document.querySelector<HTMLElement>(
        `[data-testid="txr-models-saveone-set-select-opt-${value}"]`,
      )!
      await act(async () => {
        fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
        fireEvent.mouseDown(option, { button: 0 })
        fireEvent.click(option)
        await Promise.resolve()
      })
    }
    await selectOption('set-a')
    expect(screen.queryByTestId('txr-models-saveone-name')).toBeNull()
    await selectOption('new')
    expect(screen.getByTestId('txr-models-saveone-name')).toBeDefined()
  })

  it('posts the set_name arm for a new set and the set_id arm for an existing one', async () => {
    const { onSaved } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-body')).toBeDefined())

    // New set: name typed, keep-training-files checked.
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-models-saveone-name'), {
        target: { value: 'My second set' },
      })
      fireEvent.click(screen.getByTestId('txr-models-saveone-keep-training'))
      fireEvent.click(screen.getByTestId('txr-models-saveone-confirm'))
    })
    expect(api.saveModels).toHaveBeenCalledWith({
      run_id: 'run-c',
      method_ids: ['rm-4'],
      target: { set_name: 'My second set' },
      keep_training_files: true,
      also_export: false,
      source_label: 'patients.csv',
    })
    expect(onSaved).toHaveBeenCalledTimes(1)

    // Existing set: the select's choice is the target, no name field.
    const selectOption = async (value: string): Promise<void> => {
      await act(async () => {
        fireEvent.pointerDown(screen.getByTestId('txr-models-saveone-set-select'), { button: 0, pointerType: 'mouse' })
        fireEvent.click(screen.getByTestId('txr-models-saveone-set-select'))
        await Promise.resolve()
      })
      const option = document.querySelector<HTMLElement>(
        `[data-testid="txr-models-saveone-set-select-opt-${value}"]`,
      )!
      await act(async () => {
        fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
        fireEvent.mouseDown(option, { button: 0 })
        fireEvent.click(option)
        await Promise.resolve()
      })
    }
    await selectOption('set-a')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saveone-confirm'))
    })
    expect(api.saveModels).toHaveBeenLastCalledWith({
      run_id: 'run-c',
      method_ids: ['rm-4'],
      target: { set_id: 'set-a' },
      keep_training_files: true,
      also_export: false,
      source_label: 'patients.csv',
    })
  })

  it('surfaces a rejected save inline and never closes on error', async () => {
    api.saveModels.mockRejectedValue(new Error('The run is no longer there.'))
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-body')).toBeDefined())
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-models-saveone-name'), { target: { value: 'N' } })
      fireEvent.click(screen.getByTestId('txr-models-saveone-confirm'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-models-saveone-error').textContent).toBe(
        'The run is no longer there.',
      ),
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancel closes without a call', async () => {
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-body')).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saveone-cancel'))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.saveModels).not.toHaveBeenCalled()
  })

  it('a run with no produced model for the id renders the honest no-model state', async () => {
    renderDialog({ methodId: 'rm-8' })
    await waitFor(() => expect(screen.getByTestId('txr-models-saveone-body')).toBeDefined())
    expect(screen.getByTestId('txr-models-saveone-no-model').textContent).toBe(
      'This method has no model to save.',
    )
    expect(screen.getByTestId('txr-models-saveone-confirm').hasAttribute('disabled')).toBe(true)
  })
})
