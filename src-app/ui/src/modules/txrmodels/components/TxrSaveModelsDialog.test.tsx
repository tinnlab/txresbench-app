// @vitest-environment jsdom
/**
 * TEST-MOD-13 [acceptance] [invariant: INV-1, INV-7] — ITEM-9 — the
 * `TxrSaveModelsDialog` suite (dialog L, `SaveModels.dc.html`;
 * PROV-UI-MODELS-5, CONS-UM-6/12/22).
 *
 * Pinned behaviors:
 *
 * - the dialog loads `getRun` + `getPredictions` + `listMethods` ONCE per
 *   open (a stable-props re-render never refetches), the run detail with
 *   the payload's id;
 * - the count line ("N of M selected · about X MB" — the Σ of the
 *   produced models' recorded sizes through `formatBytes`; a selected
 *   model with an unrecorded size drops the size segment — never "0 MB");
 * - the checklist rows: mono id + the group label joined from the run's
 *   method rows + the size (`formatBytes`) — one row per produced model,
 *   in the run's order; a non-finite `size_bytes` (the not-yet-grown
 *   record) renders the row WITHOUT a size;
 * - "Select none" / "Only the small ones" update the selection and the
 *   count line (the named `SMALL_MODEL_MB` cutoff);
 * - the cannot-run note names each `cannot_run` method ("<id> could not
 *   run, so it has no model to save.");
 * - the training-data warning names exactly the methods whose catalogue
 *   fact `embeds_training_data` is true (the catalogue join — never an
 *   invented warning);
 * - keep-training-files / also-export checkboxes ride the saved body;
 * - Save posts the EXACT PROV-MS-3 body (the `buildSaveSetRequest` shape:
 *   the run id, the selected method ids, `target.set_name`, the checkbox
 *   facts, the source label from the run's input summary) and hands the
 *   response to `onSaved`; a server rejection (409 / 404) surfaces the
 *   engine's message inline and the dialog stays open; Cancel closes
 *   without a call.
 *
 * Every payload is the module's synthetic run fixture (INV-4: seven
 * models, 42 patients, day 60 — never the boards' example numbers).
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
import {
  TXRMODELS_METHODS,
  TXRMODELS_PREDICTIONS,
  TXRMODELS_RUN,
  TXRMODELS_SAVE_RESPONSE,
} from '../fixtures'
import { TxrSaveModelsDialog } from './TxrSaveModelsDialog'

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  getPredictions: vi.fn(),
  listMethods: vi.fn(),
  saveModels: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: { getRun: api.getRun, getPredictions: api.getPredictions },
    MethodCatalogue: { list: api.listMethods },
    Models: { saveModels: api.saveModels },
  },
}))

const ALL_IDS = ['rm-1', 'rm-2', 'rm-3', 'rm-4', 'rm-5', 'rm-6', 'rm-7']

function renderDialog(
  over: { runId?: string | null; methodIds?: string[]; onClose?: () => void; onSaved?: (r: unknown) => void } = {},
) {
  const onClose = over.onClose ?? vi.fn()
  const onSaved = over.onSaved ?? vi.fn()
  const view = render(
    <MemoryRouter>
      <TxrSaveModelsDialog
        runId={over.runId === undefined ? 'run-c' : over.runId}
        methodIds={over.methodIds ?? ALL_IDS}
        onClose={onClose}
        onSaved={onSaved}
      />
    </MemoryRouter>,
  )
  return { onClose, onSaved, view }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getRun.mockResolvedValue(TXRMODELS_RUN)
  api.getPredictions.mockResolvedValue(TXRMODELS_PREDICTIONS)
  api.listMethods.mockResolvedValue(TXRMODELS_METHODS)
  api.saveModels.mockResolvedValue(TXRMODELS_SAVE_RESPONSE)
  useTxrModelsStore.getState().setDraftName('')
})

afterEach(() => {
  cleanup()
  useTxrModelsStore.getState().setDraftName('')
})

describe('TxrSaveModelsDialog (TEST-MOD-13)', () => {
  it('loads the run detail, the predictions and the method catalogue once per open', async () => {
    const { view } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    expect(api.getRun).toHaveBeenCalledTimes(1)
    expect(api.getRun).toHaveBeenCalledWith({ id: 'run-c' })
    expect(api.getPredictions).toHaveBeenCalledTimes(1)
    expect(api.listMethods).toHaveBeenCalledTimes(1)
    view.rerender(
      <MemoryRouter>
        <TxrSaveModelsDialog runId="run-c" methodIds={ALL_IDS} onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    expect(api.getRun).toHaveBeenCalledTimes(1)
    expect(api.getPredictions).toHaveBeenCalledTimes(1)
    expect(api.listMethods).toHaveBeenCalledTimes(1)
  })

  it('renders the board header, the made-from line and the checklist rows with their group labels and sizes', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-name')).toBeDefined())
    expect(screen.getByTestId('txr-models-save-count').textContent).toBe('7 of 7 selected \u00b7 about 27 MB')
    // The board's "Made from patients.csv, 151 patients, decision day 56,
    // progression or death by day 238." STRUCTURE with the fixture facts.
    expect(screen.getByTestId('txr-models-save-made-from').textContent).toBe(
      'Made from patients.csv, 42 patients, decision day 60, progression, death by day 240.',
    )
    const row1 = screen.getByTestId('txr-models-save-row-rm-1')
    expect(row1.textContent).toContain('rm-1')
    expect(row1.textContent).toContain('Response probability')
    expect(row1.textContent).toContain('0.8 MB')
    const row4 = screen.getByTestId('txr-models-save-row-rm-4')
    expect(row4.textContent).toContain('Dynamic risk')
    expect(row4.textContent).toContain('12 MB')
    const row6 = screen.getByTestId('txr-models-save-row-rm-6')
    expect(row6.textContent).toContain('Static risk')
    expect(row6.textContent).toContain('4.4 MB')
  })

  it('select none and only the small ones update the selection and the count line', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-save-select-none'))
    })
    expect(screen.getByTestId('txr-models-save-count').textContent).toBe('0 of 7 selected')
    // Only the small ones: the named 5-MB cutoff — the two larger models
    // (rm-4, rm-5) stay unselected.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-save-only-small'))
    })
    expect(screen.getByTestId('txr-models-save-count').textContent).toBe(
      '5 of 7 selected \u00b7 about 9.3 MB',
    )
    // A deselected-by-click row no longer counts.
    fireEvent.click(screen.getByTestId('txr-models-save-check-rm-1'))
    expect(screen.getByTestId('txr-models-save-count').textContent).toBe(
      '4 of 7 selected \u00b7 about 8.6 MB',
    )
  })

  it('names each cannot-run method and only the two training-data-resident methods in the warning', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    expect(screen.getByTestId('txr-models-save-cannot-run').textContent).toContain(
      'rm-8 could not run, so it has no model to save.',
    )
    expect(screen.getByTestId('txr-models-save-warning').textContent).toBe(
      '2 models (rm-4, rm-5) keep parts of the training data inside them. They stay in the saved model files; check before you copy or share them.',
    )
  })

  it('save posts the exact PROV-MS-3 body and hands the response to onSaved', async () => {
    const { onSaved } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-name')).toBeDefined())
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-models-save-name'), {
        target: { value: 'My fixtures, day 60' },
      })
      fireEvent.click(screen.getByTestId('txr-models-save-keep-training'))
      fireEvent.click(screen.getByTestId('txr-models-save-also-export'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-save-confirm'))
    })
    expect(api.saveModels).toHaveBeenCalledTimes(1)
    expect(api.saveModels).toHaveBeenCalledWith({
      run_id: 'run-c',
      method_ids: ALL_IDS,
      target: { set_name: 'My fixtures, day 60' },
      keep_training_files: true,
      also_export: true,
      source_label: 'patients.csv',
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(TXRMODELS_SAVE_RESPONSE)
  })

  it('a rejected save leaves the dialog open with the engine message', async () => {
    api.saveModels.mockRejectedValue(new Error('A set with this name already exists.'))
    const { onClose, onSaved } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-name')).toBeDefined())
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-models-save-name'), {
        target: { value: 'Taken name' },
      })
      fireEvent.click(screen.getByTestId('txr-models-save-confirm'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-models-save-error').textContent).toBe(
        'A set with this name already exists.',
      ),
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('cancel closes without a call', async () => {
    const { onClose } = renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-name')).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-save-cancel'))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.saveModels).not.toHaveBeenCalled()
  })

  it('an unrecorded size renders the row without a size and drops the size segment', async () => {
    const run = {
      ...TXRMODELS_RUN,
      models: TXRMODELS_RUN.models.map(model =>
        model.method_id === 'rm-3' ? { ...model, size_bytes: Number.NaN } : model,
      ),
    }
    api.getRun.mockResolvedValue(run)
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    const row3 = screen.getByTestId('txr-models-save-row-rm-3')
    expect(row3.textContent).not.toContain('MB')
    expect(row3.textContent).not.toContain('KB')
    // The total is unknown while rm-3 is selected — no size segment.
    expect(screen.getByTestId('txr-models-save-count').textContent).toBe('7 of 7 selected')
  })
})

describe('TxrSaveModelsDialog qa-fixes ITEM-4 (RES-13/14/15)', () => {
  it('names the set: a field hint + the disabled Save explained (RES-13), the small cut-off in the button (RES-14)', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    const name = screen.getByTestId('txr-models-save-name')
    expect(name.getAttribute('placeholder')).toBe('Name this set')
    // The disabled Save carries the reason next to it, never a silent button.
    expect(screen.getByTestId('txr-models-save-name-hint').textContent).toBe(
      'Name the set to save the models.',
    )
    const confirm = screen.getByTestId('txr-models-save-confirm')
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.change(name, { target: { value: 'my set' } })
    expect(screen.queryByTestId('txr-models-save-name-hint')).toBeNull()
    expect(screen.getByTestId('txr-models-save-confirm').hasAttribute('disabled')).toBe(false)
    // The small cut-off is spelled in the button (5 MB), never a bare preset.
    expect(screen.getByTestId('txr-models-save-only-small').textContent).toBe(
      'Only the small ones (under 5 MB)',
    )
  })

  it('explains the file count vs the trained-on count (RES-15)', async () => {
    const run = {
      ...TXRMODELS_RUN,
      models: TXRMODELS_RUN.models.map(model => ({ ...model, trained_on_patients: 30 })),
    }
    api.getRun.mockResolvedValue(run)
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    expect(screen.getByTestId('txr-models-save-trained-on').textContent).toBe(
      'The models are trained on the 30 of the 42 patients with the draws and outcomes this run needs.',
    )
  })

  it('omits the trained-on line when the counts already agree or are unknown', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('txr-models-save-body')).toBeDefined())
    expect(screen.queryByTestId('txr-models-save-trained-on')).toBeNull()
  })
})
