// @vitest-environment jsdom
/**
 * TEST-MOD-15 — ITEM-9 — the `TxrSavedDialog` suite (dialog L3,
 * `SaveDone.dc.html`; PROV-UI-MODELS-5, CONS-UM-6/12).
 *
 * Pinned behaviors:
 *
 * - the summary renders the response: the saved count ("N models saved"),
 *   the quoted set name + the total size (the Σ of the saved rows'
 *   `size_bytes` through `formatBytes`), and the "in …" where-segment
 *   with the REAL models root (`ModelListResponse.models_dir` — the
 *   board's Documents/TxResBench/models/ path is a design example, INV-4)
 *   — the pathless fallback omits the where-segment, and a models-dir
 *   fetch failure degrades the same way;
 * - the three actions: "Predict new patients with them" sets the intake
 *   intent to `reuse` and navigates `/predict-files`; "See my models"
 *   navigates `/models`; "Done" closes;
 * - the lead paragraph is the board's words verbatim.
 *
 * Response + dir payloads are the module's synthetic fixtures (INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ModelSaveResponse } from '@/api-client/types'
import { TXRMODELS_SAVE_RESPONSE } from '../fixtures'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { TxrSavedDialog } from './TxrSavedDialog'

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

function renderDialog(over: { response?: ModelSaveResponse | null; onClose?: () => void; from?: string } = {}) {
  const onClose = over.onClose ?? vi.fn()
  render(
    <MemoryRouter initialEntries={[over.from ?? '/models']}>
      <TxrSavedDialog response={over.response === undefined ? TXRMODELS_SAVE_RESPONSE : over.response} onClose={onClose} />
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
  it('renders the response summary with the real models root', async () => {
    renderDialog()
    await waitFor(() =>
      expect(screen.getByTestId('txr-models-saved-summary').textContent).toBe(
        '\u201cMy fixtures, day 60\u201d \u00b7 27 MB \u00b7 in /home/txr-fixture/models',
      ),
    )
    expect(screen.getByTestId('txr-models-saved-lead').textContent).toBe(
      "They are listed under Models. To use them, add new patients' measurements and pick the models you want.",
    )
    expect(screen.getByRole('dialog').textContent).toContain('7 models saved')
  })

  it('omits the where-segment when the server reports no models root', async () => {
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

  it('a models-dir fetch failure degrades to the pathless summary', async () => {
    api.listModels.mockRejectedValue(new Error('offline'))
    renderDialog()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-models-saved-summary').textContent).toBe(
      '\u201cMy fixtures, day 60\u201d \u00b7 27 MB',
    )
  })
})
