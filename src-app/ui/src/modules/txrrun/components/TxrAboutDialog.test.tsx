// @vitest-environment jsdom
/**
 * TEST-RUN-16 — the About dialog (`components/TxrAboutDialog.tsx`, ITEM-8;
 * PROV-UI-RUN-4's `TxrAboutDialog`, CONS-UI-RUN-5): the row's "About" opens
 * the catalogue's one-method card — `ApiClient.MethodCatalogue.detail` on
 * open, the card facts (description, software, licence, references,
 * parameters, timing, performance) via kit `Descriptions` — and closes on
 * Escape / backdrop to the host's `onClose`. The 404 (`METHOD_NOT_FOUND`)
 * renders the module's constant fallback line, never a blank card.
 *
 * The fixtures are synthetic (INV-6): a made-up method id, made-up
 * references and a c-index built in-test — the board's numbers never enter
 * expected values.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Method } from '@/api-client/types'
import { METHOD_NOT_FOUND_LINE } from '../data/useMethodDetail'
import { TxrAboutDialog } from './TxrAboutDialog'

const api = vi.hoisted(() => ({
  detail: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      detail: api.detail,
    },
  },
}))

// jsdom gaps the browser APIs the kit's Descriptions probes at mount (the
// TxrResultsHeader suite's shim — ResizeObserver + CSS.escape).
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
})

/** The synthetic one-method payload (INV-6 — no real catalogue entry). */
function method(): Method {
  return {
    id: 'direct-on',
    description: 'A direct rule on the earliest detected change.',
    citations: 3,
    container: true,
    covariates: 'optional',
    embeds_training_data: false,
    env: { contract: '2.0', digest: 'sha256:aa', image: 'ghcr.io/tinnlab/txresbench-direct-on:1.0.0' },
    fitted: false,
    frozen_model: false,
    gate: { pass: true, report_name: 'gate.yml' },
    group: 'response-probability',
    group_label: 'Response probability',
    journal: 'Example Journal',
    language: 'R',
    licence: 'MIT',
    marker_groups_required: [],
    markers: { count: 1, kind: 'any' },
    min_draws: 1,
    needs_baseline: false,
    needs_detection_call: false,
    own_outputs: ['prob'],
    paper_doi: '10.0000/example',
    params: { max_depth: 3 },
    performance: { c_index_median: 0.64, n_datasets: 2, n_units: 3 },
    references: ['Reference one', 'Reference two'],
    runnable: true,
    saves_model: true,
    software: { language: 'R', packages: { 'direct-on': '1.0.0', survival: '3.0' } },
    spec_status: 'final',
    tasks: ['pfs'],
    timing: { base_seconds_per_fold: 120, benchmarked_units: 3, quality: 'measured' },
    uses_history: 'landmark',
    version: '1.0.0',
    year: 2021,
  }
}

function renderDialog(methodId: string | null = 'direct-on') {
  const onClose = vi.fn()
  render(<TxrAboutDialog methodId={methodId} onClose={onClose} />)
  return onClose
}

beforeEach(() => {
  api.detail.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrAboutDialog (TEST-RUN-16)', () => {
  it('GETs the catalogue detail on open and renders the card facts via kit Descriptions', async () => {
    api.detail.mockResolvedValue(method())
    renderDialog()

    expect(api.detail).toHaveBeenCalledWith({ method_id: 'direct-on' })
    expect(screen.getByTestId('txr-run-about-loading')).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByTestId('txr-run-about-description').textContent).toBe(
        'A direct rule on the earliest detected change.',
      )
    })
    const facts = screen.getByTestId('txr-run-about-facts')
    expect(facts.textContent).toContain('Software')
    expect(facts.textContent).toContain('R — direct-on, survival')
    expect(facts.textContent).toContain('Licence')
    expect(facts.textContent).toContain('MIT')
    expect(facts.textContent).toContain('References')
    expect(facts.textContent).toContain('Reference one')
    expect(facts.textContent).toContain('Parameters')
    expect(facts.textContent).toContain('"max_depth": 3')
    expect(facts.textContent).toContain('Timing')
    // The timing fact is the provider's own short-duration formatter's bytes.
    expect(facts.textContent).toContain('about 2 min per fold')
    expect(facts.textContent).toContain('Performance')
    expect(facts.textContent).toContain('median c-index 0.64')
  })

  it('the null id is the closed dialog: no request, no detail', () => {
    renderDialog(null)
    expect(api.detail).not.toHaveBeenCalled()
    expect(screen.queryByTestId('txr-run-about-loading')).toBeNull()
  })

  it('404 METHOD_NOT_FOUND renders the module constant fallback line — never a blank card', async () => {
    api.detail.mockRejectedValue({ status: 404, message: 'METHOD_NOT_FOUND' })
    renderDialog()
    await waitFor(() => {
      expect(screen.getByTestId('txr-run-about-fallback').textContent).toBe(
        METHOD_NOT_FOUND_LINE,
      )
    })
    expect(screen.getByTestId('txr-run-about-fallback').textContent).not.toBe('')
  })

  it('a network failure renders the error line + retry, and retry re-issues the fetch', async () => {
    api.detail.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(method())
    renderDialog()
    await waitFor(() => {
      expect(screen.getByTestId('txr-run-about-error')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('txr-run-about-retry'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-run-about-description').textContent).toContain(
        'A direct rule',
      )
    })
    expect(api.detail).toHaveBeenCalledTimes(2)
  })

  it('Escape closes the dialog to the host onClose', async () => {
    api.detail.mockResolvedValue(method())
    const onClose = renderDialog()
    await waitFor(() => {
      expect(screen.getByTestId('txr-run-about-body')).toBeTruthy()
    })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('an overlay click (backdrop) closes the dialog to the host onClose', async () => {
    api.detail.mockResolvedValue(method())
    const onClose = renderDialog()
    await waitFor(() => {
      expect(screen.getByTestId('txr-run-about-body')).toBeTruthy()
    })
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement
    expect(overlay).not.toBeNull()
    fireEvent.click(overlay)
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
