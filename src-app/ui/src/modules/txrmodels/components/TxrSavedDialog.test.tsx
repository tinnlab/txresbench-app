// @vitest-environment jsdom
/**
 * TEST-MOD-15 — ITEM-9 — the `TxrSavedDialog` suite (dialog L3,
 * `SaveDone.dc.html`; PROV-UI-MODELS-5, CONS-UM-6/12).
 *
 * Pinned behaviors:
 *
 * - the summary renders the response: the saved count ("N models saved"),
 *   the quoted set name + the total size (the Σ of the saved rows'
 *   `size_bytes` through `formatBytes`). qa-fixes4 ITEM-1 (results-r3
 *   R3-results-2): the board's "in …" where-segment is GONE — the dialog
 *   never fetches `models_dir` and never renders the models root (it is
 *   an internal host fact), whatever the list response carries;
 * - the three actions: "Predict new patients with them" sets the intake
 *   intent to `reuse` and navigates `/predict-files`; "See my models"
 *   navigates `/models`; "Done" closes;
 * - the lead paragraph is the board's words verbatim;
 * - brief 3 ("Also save as a file"): the optional `file` outcome renders
 *   the cancelled line, the failed line, or the saved path through the
 *   Models page's `SavedFileNotice`; the no-outcome case adds nothing.
 *
 * Response + dir payloads are the module's synthetic fixtures (INV-4);
 * the listed `listModels` mock stays only because the old test suite
 * asserted the where-segment — the dialog itself never calls it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ModelSaveResponse } from '@/api-client/types'
import type { TxrSaveFileOutcome } from '../lib/export'
import { TXRMODELS_SAVE_RESPONSE } from '../fixtures'
import { useStepTrailStore, useTxrIntakeStore } from '@/modules/txrintake'
import { TxrSavedDialog } from './TxrSavedDialog'
import '@/core/actions/builtin/stepActions'
import { RouterBridge } from '@/core/actions/navigateBridge'

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Models: { listModels: api.listModels },
  },
}))

function RouteProbe() {
  const location = useLocation()
  return <span data-testid="route-probe">{location.pathname}</span>
}

function renderDialog(
  over: {
    response?: ModelSaveResponse | null
    file?: TxrSaveFileOutcome
    onClose?: () => void
    from?: string
  } = {},
) {
  const onClose = over.onClose ?? vi.fn()
  render(
    <MemoryRouter initialEntries={[over.from ?? '/models']}>
      {/* "Predict new patients with them" runs the registered flow.startPath. */}
      <RouterBridge />
      <TxrSavedDialog
        response={over.response === undefined ? TXRMODELS_SAVE_RESPONSE : over.response}
        file={over.file}
        onClose={onClose}
      />
      <RouteProbe />
    </MemoryRouter>,
  )
  return { onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listModels.mockResolvedValue({
    total: 0,
    models: [],
    models_dir: '/home/txr-fixture/models',
  })
})

afterEach(() => {
  cleanup()
})

describe('TxrSavedDialog (TEST-MOD-15)', () => {
  it('renders the response summary (set name + size); the where-segment is gone (qa-fixes4 ITEM-1)', async () => {
    renderDialog()
    await waitFor(() =>
      expect(screen.getByTestId('txr-models-saved-summary').textContent).toBe(
        '\u201cMy fixtures, day 60\u201d \u00b7 27 MB',
      ),
    )
    // The models root is never rendered and never fetched: the dialog's
    // summary carries no path even though the mocked list response does.
    expect(screen.getByTestId('txr-models-saved-summary').textContent).not.toContain(
      '/home/txr-fixture/models',
    )
    expect(screen.getByTestId('txr-models-saved-lead').textContent).toBe(
      "They are listed under Models. To use them, add new patients' measurements and pick the models you want.",
    )
    expect(screen.getByRole('dialog').textContent).toContain('7 models saved')
  })

  it('omits the size when the saved rows carry no readable size (the summary keeps set name + size only)', async () => {
    api.listModels.mockResolvedValue({ total: 0, models: [], models_dir: null })
    const { onClose } = renderDialog()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saved-done'))
    })
    expect(screen.getByTestId('txr-models-saved-summary').textContent).toBe(
      '\u201cMy fixtures, day 60\u201d \u00b7 27 MB',
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('predict new patients sets intent reuse and navigates to the predict-files screen', async () => {
    const { onClose } = renderDialog({ from: '/results' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saved-predict'))
    })
    expect(useTxrIntakeStore.getState().intent).toBe('reuse')
    expect(screen.getByTestId('route-probe').textContent).toBe('/predict-files')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('predict new patients starts the step trail on the page the dialog opened on (Back from N returns there)', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files', '/choose-methods'], current: null })
    renderDialog({ from: '/analysis/run-1/results' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saved-predict'))
    })
    expect(useStepTrailStore.getState().trail).toEqual(['/analysis/run-1/results'])
  })

  it('see my models navigates to the models screen', async () => {
    const { onClose } = renderDialog({ from: '/results' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saved-see-models'))
    })
    expect(screen.getByTestId('route-probe').textContent).toBe('/models')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('done closes without navigating', async () => {
    const { onClose } = renderDialog({ from: '/results' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-saved-done'))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('route-probe').textContent).toBe('/results')
  })

  it('never fetches the models root for the summary (qa-fixes4 ITEM-1)', async () => {
    api.listModels.mockRejectedValue(new Error('offline'))
    renderDialog()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-models-saved-summary').textContent).toBe(
      '\u201cMy fixtures, day 60\u201d \u00b7 27 MB',
    )
    expect(api.listModels).not.toHaveBeenCalled()
  })

  it('reports the "Also save as a file" outcome: a cancelled Save dialog line (brief 3)', async () => {
    renderDialog({ file: { status: 'cancelled' } })
    expect(screen.getByTestId('txr-models-saved-file').textContent).toBe(
      'Your models are saved. The set file was not saved.',
    )
    // The save itself is still reported (the models stay saved).
    expect(screen.getByTestId('txr-models-saved-summary').textContent).toBe(
      '\u201cMy fixtures, day 60\u201d \u00b7 27 MB',
    )
  })

  it('reports the "Also save as a file" outcome: a failed export line (brief 3)', async () => {
    renderDialog({ file: { status: 'failed' } })
    expect(screen.getByTestId('txr-models-saved-file').textContent).toBe(
      'The set file could not be saved. Your models are saved.',
    )
  })

  it('a saved file shows where, through the same SavedFileNotice the Models page uses', async () => {
    renderDialog({ file: { status: 'saved', path: '/Users/me/Models/My-fixtures-day-60.txr' } })
    const notice = screen.getByTestId('txr-models-saved-file')
    expect(notice.textContent).toContain('Saved to /Users/me/Models/My-fixtures-day-60.txr')
    expect(screen.getByTestId('txr-models-saved-file-show').textContent).toBe('Show in folder')
  })

  it('no file outcome (unticked / L2) renders no file line and no notice', async () => {
    renderDialog()
    expect(screen.queryByTestId('txr-models-saved-file')).toBeNull()
  })
})
