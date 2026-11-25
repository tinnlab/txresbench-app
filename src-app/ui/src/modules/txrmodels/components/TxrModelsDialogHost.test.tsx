// @vitest-environment jsdom
/**
 * TEST-MOD-12 [acceptance] [invariant: INV-1, INV-6] — ITEM-9 — the
 * `TxrModelsDialogHost` suite (PROV-UI-MODELS-2).
 *
 * Pinned behaviors:
 *
 * - the host subscribes to `txr:save-models-requested` and
 *   `txr:save-one-model-requested` with the de-duplication group name —
 *   exactly one handler per event per mounted host (a host re-render never
 *   re-subscribes; registering the same group twice replaces, never
 *   stacks — the framework's group semantics, pinned with the host's own
 *   group name), and both unsubscribers run on unmount (the handler count
 *   returns to zero);
 * - an emission opens the L dialog with the payload's runId + methodIds
 *   (the run fetch is issued for the payload's id; the checklist's initial
 *   selection is the payload's produced-model ids);
 * - a second emission while a dialog is open REPLACES the dialog state —
 *   exactly one dialog root at any time, never a stack;
 * - `txr:save-one-model-requested` opens the L2 dialog;
 * - emitting with no mounted host is a benign no-op (the zustand bus's
 *   zero-handler path — the results-screen button never crashes);
 * - the host renders nothing when no dialog is open (no layout shift);
 * - brief 3/3b: the "Also save as a file" outcome reaches L3 through the
 *   host's own splice (the L → L3 handoff carries the export's answer —
 *   the saved path, not just the `none` default).
 *
 * Fixture data through the module's synthetic run/predictions/methods
 * payloads; every API call mocked (the `Datasets.store.test` precedent) so
 * the assertions stay at the host/dialog seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Checkbox) construct one on pointer interaction, which would throw and
// swallow the click. The MouseEvent subclass is the standard jsdom stand-in
// (the TxrSaveModelsDialog suite's shim, copied).
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

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useEventBusStore } from '@txresbench/framework/events'
import {
  TXRMODELS_METHODS,
  TXRMODELS_PREDICTIONS,
  TXRMODELS_RUN,
} from '../fixtures'
import { TxrModelsDialogHost } from './TxrModelsDialogHost'

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  getPredictions: vi.fn(),
  listMethods: vi.fn(),
  listSets: vi.fn(),
  listModels: vi.fn(),
  saveModels: vi.fn(),
  exportSet: vi.fn(),
  saveFile: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: { getRun: api.getRun, getPredictions: api.getPredictions },
    MethodCatalogue: { list: api.listMethods },
    ModelSets: { listSets: api.listSets, exportSet: api.exportSet },
    Models: { listModels: api.listModels, saveModels: api.saveModels },
  },
}))
// The post-save "Also save as a file" flow runs the REAL `downloadSetExport`
// against the mocked ModelSets.exportSet; `saveFile` is the outcome seam (the
// set file's answer — saved/cancelled), the same mock the TxrSaveModelsDialog
// suite uses.
vi.mock('@/core/saveFile', () => ({
  saveFile: api.saveFile,
  saveLabel: (_app: string, web: string) => web,
  savesWithDialog: () => true,
  revealSavedFile: async () => undefined,
  showSavedLabel: () => 'Show in folder',
}))

async function emitModels(runId: string, methodIds: string[]): Promise<void> {
  await act(async () => {
    await useEventBusStore
      .getState()
      .emit<'txr:save-models-requested'>({ type: 'txr:save-models-requested', runId, methodIds })
  })
}

async function emitOne(runId: string, methodId: string): Promise<void> {
  await act(async () => {
    await useEventBusStore
      .getState()
      .emit<'txr:save-one-model-requested'>({ type: 'txr:save-one-model-requested', runId, methodId })
  })
}

function renderHost(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TxrModelsDialogHost />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useEventBusStore.getState().clear()
  vi.clearAllMocks()
  api.getRun.mockResolvedValue(TXRMODELS_RUN)
  api.getPredictions.mockResolvedValue(TXRMODELS_PREDICTIONS)
  api.listMethods.mockResolvedValue(TXRMODELS_METHODS)
  api.listSets.mockResolvedValue({ total: 2, sets: [] })
  api.listModels.mockResolvedValue({ total: 0, models: [], models_dir: '/home/txr-fixture/models' })
})

afterEach(() => {
  cleanup()
  useEventBusStore.getState().clear()
})

describe('TxrModelsDialogHost (TEST-MOD-12)', () => {
  it('renders nothing when no dialog is open (no layout shift)', () => {
    const { container } = renderHost()
    expect(container.firstChild).toBeNull()
  })

  it('subscribes once per mount with the de-duplication group and unsubscribes on unmount', () => {
    const bus = useEventBusStore.getState()
    const { unmount } = renderHost()
    expect(bus.getHandlerCount('txr:save-models-requested')).toBe(1)
    expect(bus.getHandlerCount('txr:save-one-model-requested')).toBe(1)
    // A re-render of the mounted host never re-subscribes (the effect's
    // empty deps + the group key).
    unmount()
    expect(bus.getHandlerCount('txr:save-models-requested')).toBe(0)
    expect(bus.getHandlerCount('txr:save-one-model-requested')).toBe(0)
  })

  it('opens the L dialog with the payload runId + methodIds', async () => {
    // The group de-duplication is the host's group name: registering the
    // same group + event twice replaces the handler, never stacks (the
    // framework's semantics the host relies on).
    const bus = useEventBusStore.getState()
    const first = vi.fn()
    bus.on('txr:save-models-requested', first, 'txr-models-dialog-host')
    bus.on('txr:save-models-requested', vi.fn(), 'txr-models-dialog-host')
    expect(bus.getHandlerCount('txr:save-models-requested')).toBe(1)

    renderHost()
    await emitModels('run-c', ['rm-1', 'rm-2', 'rm-3'])

    const dialog = document.querySelector('[data-testid="txr-models-save"]')
    expect(dialog).not.toBeNull()
    await waitFor(() => {
      expect(api.getRun).toHaveBeenCalledTimes(1)
      expect(api.getRun).toHaveBeenCalledWith({ id: 'run-c' })
    })
    // The initial selection = the payload's produced-model ids.
    expect(
      document.querySelector('[data-testid="txr-models-save-count"]')?.textContent,
    ).toContain('3 of 7 selected')
  })

  it('a second emission replaces the dialog state rather than stacking', async () => {
    renderHost()
    await emitModels('run-c', ['rm-1'])
    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(1))

    await emitModels('run-d', ['rm-1', 'rm-2'])
    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(2))

    const roots = document.querySelectorAll('[data-testid="txr-models-save"]')
    expect(roots.length).toBe(1)
    expect(api.getRun).toHaveBeenLastCalledWith({ id: 'run-d' })
  })

  it('the save-one event opens the L2 dialog', async () => {
    renderHost()
    await emitOne('run-c', 'rm-4')
    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.listSets).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-testid="txr-models-saveone"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-models-save"]')).toBeNull()
  })

  it('an emission with no mounted host is a benign no-op', async () => {
    await expect(emitModels('run-c', ['rm-1'])).resolves.toBeUndefined()
    expect(document.querySelector('[data-testid="txr-models-save"]')).toBeNull()
  })

  it('the saved response replaces the dialog with the L3 confirmation', async () => {
    renderHost()
    api.saveModels.mockResolvedValue({
      set: { id: 'set-save-1', name: 'My fixtures, day 60', created_at: '2026-11-30T08:11:00Z', source_run_id: 'run-c', source_label: 'patients.csv', model_count: 1, keep_training_files: false, total_size_bytes: 800_000 },
      models: [],
    })
    await emitModels('run-c', ['rm-1'])
    await waitFor(() => expect(document.querySelector('[data-testid="txr-models-save-body"]')).not.toBeNull())
    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>('[data-testid="txr-models-save-name"]')!,
        { target: { value: 'My fixtures, day 60' } },
      )
    })
    await waitFor(() => {
      const confirm = document.querySelector<HTMLButtonElement>('[data-testid="txr-models-save-confirm"]')!
      expect(confirm.disabled).toBe(false)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="txr-models-save-confirm"]')!.click()
      await Promise.resolve()
    })
    await waitFor(() => expect(api.saveModels).toHaveBeenCalledTimes(1))
    // L3 replaces L — exactly one dialog root.
    const roots = document.querySelectorAll('[data-testid="txr-models-saved"]')
    expect(roots.length).toBe(1)
    expect(document.querySelector('[data-testid="txr-models-save"]')).toBeNull()
  })

  it('the "Also save as a file" outcome reaches L3 through the host splice', async () => {
    renderHost()
    api.saveModels.mockResolvedValue({
      set: { id: 'set-save-1', name: 'My fixtures, day 60', created_at: '2026-11-30T08:11:00Z', source_run_id: 'run-c', source_label: 'patients.csv', model_count: 1, keep_training_files: false, total_size_bytes: 800_000 },
      models: [],
    })
    api.exportSet.mockResolvedValue(new Blob(['txr-set-bytes']))
    api.saveFile.mockResolvedValue({ status: 'saved', path: '/Users/me/Models/My-fixtures-day-60.txr' })
    await emitModels('run-c', ['rm-1'])
    await waitFor(() => expect(document.querySelector('[data-testid="txr-models-save-body"]')).not.toBeNull())
    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>('[data-testid="txr-models-save-name"]')!,
        { target: { value: 'My fixtures, day 60' } },
      )
      fireEvent.click(document.querySelector('[data-testid="txr-models-save-also-export"]')!)
    })
    await waitFor(() => {
      const confirm = document.querySelector<HTMLButtonElement>('[data-testid="txr-models-save-confirm"]')!
      expect(confirm.disabled).toBe(false)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="txr-models-save-confirm"]')!.click()
      await Promise.resolve()
    })
    await waitFor(() => expect(api.saveModels).toHaveBeenCalledTimes(1))
    // L3 replaces L, and the file outcome (the saved set's path) rides along
    // the host's own splice — the export's answer is not lost to the default.
    await waitFor(() =>
      expect(document.querySelector('[data-testid="txr-models-saved-file"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-testid="txr-models-saved-file"]')?.textContent).toContain(
      'Saved to /Users/me/Models/My-fixtures-day-60.txr',
    )
    expect(document.querySelector('[data-testid="txr-models-saved-summary"]')?.textContent).toContain(
      'My fixtures, day 60',
    )
    expect(document.querySelector('[data-testid="txr-models-save"]')).toBeNull()
  })
})
