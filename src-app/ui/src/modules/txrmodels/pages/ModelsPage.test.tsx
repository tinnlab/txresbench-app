// @vitest-environment jsdom
/**
 * TEST-MOD-11 [acceptance] [invariant: INV-4, INV-7] — screen J (ITEM-8):
 * the `ModelsPage` suite (PROV-UI-MODELS-5).
 *
 * Pinned behaviors:
 *
 * - the board's table: the six visible columns + the Actions column (the
 *   screen-reader-only header), the row sublines — a run row "6 markers ·
 *   uses age" (the grown `marker_count` / `uses_covariates` fields), an
 *   imported row "opened from colleague-panel.txr · 5 markers" with the
 *   "not recorded" trained-on and the "opened 4 Dec 2026" Made entry, a
 *   row with no marker/covariate/import fact rendering the name alone —
 *   the Predicts / Trained-on / Made entries through the ITEM-4 formatters;
 * - the search: debounced 250 ms, then `ApiClient.Models.listModels`
 *   carries the server-side `q` (the generated namespace is `Models` —
 *   DEC-17's table; the TESTS.md draft's `Txr.` namespace was an
 *   editorial slip, corrected at this item);
 * - "Open a model file": a File-constructed pick posts the multipart
 *   import (the `file` part) and refreshes the list;
 * - Use → `setIntent('reuse')` + the module store's pending id +
 *   navigation to `/predict-files` (the DEC-10 handoff);
 * - Export → the generated download (the provider's attachment saved
 *   under the sanitised `<name>.txr` — the blob saved, the URL revoked);
 * - Rename → PATCH (`renameModel({id, name})`); Delete → the confirm
 *   dialog whose copy is the board's deletion promise verbatim, then
 *   DELETE; both refresh the inventory;
 * - the footnotes; `txr-models-open-folder` present in the mocked-desktop
 *   render and calling `revealRunDir(models_root)`; in the mocked-web
 *   render the button ABSENT while the models-path TEXT is still present
 *   (the positive control — a desktop gate, not a never-rendered line);
 * - the `?set=` focus: the provider's `set_id` filter + the "Showing the
 *   set … · Show all" affordance (DEC-19, CONS-HIST-16);
 * - the states: the first-load line, the error + Retry, the empty state
 *   with the Open-a-model-file CTA, the honest no-match line.
 *
 * Every fixture value is synthetic (INV-4): the module's own J payload
 * (`TXRMODELS_J_RESPONSE` — four rows, 42 patients in the fixture family,
 * days 60/35, horizons 240/165) — the boards' numbers are never constants
 * here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ModelListResponse, ModelSummary } from '@/api-client/types'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { TXRMODELS_J_RESPONSE, fixtureModelId } from '../fixtures'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { ModelsPage } from './ModelsPage'

// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Input/Button) construct one on pointer interaction, which would
// throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in (the sibling suites' shim, copied).
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

// jsdom has no ResizeObserver either (the kit Input's adornment path).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  renameModel: vi.fn(),
  deleteModel: vi.fn(),
  importModel: vi.fn(),
  exportModel: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Models: {
      listModels: api.listModels,
      renameModel: api.renameModel,
      deleteModel: api.deleteModel,
      importModel: api.importModel,
      exportModel: api.exportModel,
    },
  },
}))

// ── jsdom download stubs (the export's blob + anchor path) ────────────────
const createObjectURL = vi.fn((_blob: Blob) => 'blob:txr-models-test')
const revokeObjectURL = vi.fn((url: string) => {})
const clickSpy = vi.fn()
const invokeSpy = vi.fn((_cmd: string, _args: unknown) => Promise.resolve())

function LocationProbe() {
  const location = useLocation()
  return (
    <div data-testid="route-location">
      {location.pathname}
      {location.search}
    </div>
  )
}

function renderPage(initialEntry = '/models') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ModelsPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** Flush the pending microtasks (the mount fetch) + advance timers. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The J fixture's first row (the run row with the full subline). */
const RUN_ROW = TXRMODELS_J_RESPONSE.models[0]

/** The J fixture's imported row. */
const IMPORTED_ROW = TXRMODELS_J_RESPONSE.models[2]

/** The J fixture's no-facts row. */
const PLAIN_ROW = TXRMODELS_J_RESPONSE.models[3]

/** A File-constructed pick of a model container (never a real file). */
function pickFile(): File {
  return new File(['txr-bytes'], 'colleague-panel.txr', { type: 'application/octet-stream' })
}

/** Set the hidden file input's files and fire its change (jsdom files). */
function pickImport(): void {
  const input = screen.getByTestId('txr-models-import-file') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [pickFile()], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(api)) fn.mockReset()
  api.listModels.mockResolvedValue(TXRMODELS_J_RESPONSE)
  api.renameModel.mockImplementation(async (args: { id: string; name: string }) => {
    const model = TXRMODELS_J_RESPONSE.models.find(m => m.id === args.id)
    return { ...(model as ModelSummary), name: args.name }
  })
  api.deleteModel.mockResolvedValue(undefined)
  api.importModel.mockResolvedValue({ models: [], set_id: undefined })
  api.exportModel.mockResolvedValue(new Blob(['txr-bytes']))
  useTxrIntakeStore.getState().reset()
  useTxrModelsStore.getState().reset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  clickSpy.mockClear()
  invokeSpy.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    value: clickSpy,
    writable: true,
    configurable: true,
  })
  // Web mode is the birth state; the desktop arms opt in per test.
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ModelsPage — TEST-MOD-11 (screen J)', () => {
  it("renders the board header, the table's columns and the row sublines with the fallbacks", async () => {
    renderPage()
    await settle(0)
    expect(screen.getByRole('heading', { name: 'Your models' })).toBeTruthy()
    expect(
      screen.getByText(
        'Every model you train is kept here, so you can predict new patients later without training again.',
      ),
    ).toBeTruthy()
    // The board's six visible columns.
    const headers = screen.getAllByRole('columnheader').map(th => th.textContent)
    expect(headers).toEqual([
      'Model',
      'Method',
      'Predicts',
      'Decision day',
      'Trained on',
      'Made',
      'Actions',
    ])
    // The run row: mono method, the grown subline, the board's facts words.
    const runRow = screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)
    expect(within(runRow).getByText(RUN_ROW.name)).toBeTruthy()
    expect(within(runRow).getByText('6 markers \u00b7 uses age')).toBeTruthy()
    expect(within(runRow).getByText(RUN_ROW.method_id)).toBeTruthy()
    expect(within(runRow).getByText('progression, death by day 240')).toBeTruthy()
    expect(within(runRow).getByText('42 patients')).toBeTruthy()
    expect(within(runRow).getByText('29 Nov 2026')).toBeTruthy()
    // The imported row: the "opened from …" subline, the "not recorded"
    // trained-on and the "opened …" Made entry (the board's two facts).
    const importedRow = screen.getByTestId(`txr-models-row-${IMPORTED_ROW.id}`)
    expect(within(importedRow).getByText('opened from colleague-panel.txr \u00b7 5 markers')).toBeTruthy()
    expect(within(importedRow).getByText('not recorded')).toBeTruthy()
    expect(within(importedRow).getByText('opened 4 Dec 2026')).toBeTruthy()
    // The plain row: the name alone, no subline.
    const plainRow = screen.getByTestId(`txr-models-row-${PLAIN_ROW.id}`)
    expect(within(plainRow).getByText(PLAIN_ROW.name)).toBeTruthy()
    expect(
      within(plainRow).queryByText(/markers|uses age|opened from/),
    ).toBeNull()
    // The four row actions per row.
    for (const model of TXRMODELS_J_RESPONSE.models) {
      expect(screen.getByTestId(`txr-models-use-${model.id}`)).toBeTruthy()
      expect(screen.getByTestId(`txr-models-export-${model.id}`)).toBeTruthy()
      expect(screen.getByTestId(`txr-models-rename-${model.id}`)).toBeTruthy()
      expect(screen.getByTestId(`txr-models-delete-${model.id}`)).toBeTruthy()
    }
  })

  it('debounces the search 250 ms and hits the generated client with the server q', async () => {
    renderPage()
    await settle(0)
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledWith({})
    fireEvent.change(screen.getByTestId('txr-models-j-search'), {
      target: { value: 'ldh' },
    })
    await settle(249)
    expect(api.listModels).toHaveBeenCalledTimes(1)
    await settle(2)
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(api.listModels).toHaveBeenLastCalledWith({ q: 'ldh' })
    expect(screen.getByTestId('txr-models-j-search').getAttribute('aria-label')).toBe(
      'Search models',
    )
  })

  it('posts the multipart import and refreshes the list (success), and surfaces a failure inline', async () => {
    renderPage()
    await settle(0)
    pickImport()
    await settle(0)
    expect(api.importModel).toHaveBeenCalledTimes(1)
    const form = api.importModel.mock.calls[0][0] as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect((form.get('file') as File).name).toBe('colleague-panel.txr')
    // The refresh re-reads the inventory.
    expect(api.listModels.mock.calls.length).toBe(2)

    api.importModel.mockRejectedValue(new Error('INVALID_CONTAINER'))
    pickImport()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-import-error').textContent).toBe('INVALID_CONTAINER')
  })

  it('Use sets the reuse intent + the pending model id and navigates to the predict-files screen', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-use-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    expect(useTxrIntakeStore.getState().intent).toBe('reuse')
    expect(useTxrModelsStore.getState().pendingUseModelId).toBe(RUN_ROW.id)
  })

  it('Export saves the provider attachment under the sanitised model name', async () => {
    renderPage()
    await settle(0)
    const createElement = vi.spyOn(document, 'createElement')
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-export-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    expect(api.exportModel).toHaveBeenCalledWith({ id: RUN_ROW.id })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const anchor = createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('CRC-cohort-day-60.txr')
    expect(anchor.href).toBe('blob:txr-models-test')
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:txr-models-test')
    createElement.mockRestore()
  })

  it('Rename opens the dialog with the current label prefilled and PATCHes; Delete confirms with the board promise and DELETEs', async () => {
    renderPage()
    await settle(0)
    // Rename: prefill → change → confirm → PATCH + refresh.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-rename-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    const input = screen.getByTestId(`txr-models-rename-dialog-${RUN_ROW.id}-input`)
    expect((input as HTMLInputElement).value).toBe(RUN_ROW.name)
    fireEvent.change(input, { target: { value: 'Renamed model' } })
    const callsBefore = api.renameModel.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-rename-dialog-${RUN_ROW.id}-confirm`))
      await Promise.resolve()
    })
    expect(api.renameModel).toHaveBeenCalledTimes(callsBefore + 1)
    expect(api.renameModel).toHaveBeenCalledWith({ id: RUN_ROW.id, name: 'Renamed model' })
    expect(api.listModels.mock.calls.length).toBe(2)

    // Delete: the confirm's copy is the board's deletion promise verbatim.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-delete-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    const body = screen.getByTestId(`txr-models-delete-dialog-${RUN_ROW.id}-body`).textContent
    expect(body).toBe(
      'Deleting a model removes its file. Results already made with it are kept in History.',
    )
    const deletesBefore = api.deleteModel.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-delete-dialog-${RUN_ROW.id}-confirm`))
      await Promise.resolve()
    })
    expect(api.deleteModel).toHaveBeenCalledTimes(deletesBefore + 1)
    expect(api.deleteModel).toHaveBeenCalledWith({ id: RUN_ROW.id })
    expect(api.listModels.mock.calls.length).toBe(3)
  })

  it('renders the footnotes: the stored-in path + the deletion note; web mode has no folder button, the path text stays', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-stored-line')).toBeTruthy()
    expect(screen.getByTestId('txr-models-j-models-path').textContent).toBe(
      '/home/txr-fixture/models',
    )
    expect(
      screen.getByText('Deleting a model removes its file. Results already made with it are kept in History.'),
    ).toBeTruthy()
    // The positive control: the button absent in web mode — the gate, not
    // a never-rendered line.
    expect(screen.queryByTestId('txr-models-open-folder')).toBeNull()
  })

  it('desktop mode renders the open-folder button and reveals the models root', async () => {
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: invokeSpy },
    }
    renderPage()
    await settle(0)
    const button = screen.getByTestId('txr-models-open-folder')
    expect(button.textContent).toBe('Open the folder')
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    expect(invokeSpy).toHaveBeenCalledWith('reveal_in_file_manager', {
      path: '/home/txr-fixture/models',
    })
  })

  it('a pathless list response renders the footnotes without the path and without the folder button', async () => {
    api.listModels.mockResolvedValue({
      models: [],
      total: 0,
    } as ModelListResponse)
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-models-j-models-path')).toBeNull()
    expect(screen.queryByTestId('txr-models-open-folder')).toBeNull()
    expect(screen.getByTestId('txr-models-j-stored-line').textContent).toBe('Models are stored in')
  })

  it('reads the ?set= focus, filters by it, shows the clear affordance and clears the param', async () => {
    renderPage('/models?set=set-a')
    await settle(0)
    expect(api.listModels).toHaveBeenCalledWith({ set_id: 'set-a' })
    expect(screen.getByTestId('txr-models-j-set-focus').textContent).toContain(
      'Showing the set',
    )
    expect(screen.getByTestId('txr-models-j-set-focus').textContent).toContain(
      TXRMODELS_J_RESPONSE.models[0].set_name ?? '',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-j-set-clear'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/models')
    expect(screen.queryByTestId('txr-models-j-set-focus')).toBeNull()
  })

  it('renders the first-load line, then the error + Retry, then the table on a successful retry', async () => {
    let reject = true
    api.listModels.mockImplementation(() =>
      reject ? Promise.reject(new Error('transport down')) : Promise.resolve(TXRMODELS_J_RESPONSE),
    )
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-error').textContent).toBe('transport down')
    reject = false
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-j-retry'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeTruthy()
  })

  it('the empty inventory renders the empty state with the Open-a-model-file CTA; a no-hit search is the honest no-match line', async () => {
    api.listModels.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-empty').textContent).toContain('No models yet.')
    expect(screen.getByTestId('txr-models-empty-import')).toBeTruthy()

    api.listModels.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    fireEvent.change(screen.getByTestId('txr-models-j-search'), {
      target: { value: 'zzz' },
    })
    await settle(250)
    await settle(0)
    expect(screen.getByTestId('txr-models-j-no-match').textContent).toContain(
      'Nothing matches here.',
    )
    expect(screen.queryByTestId('txr-models-empty-import')).toBeNull()
  })
})
