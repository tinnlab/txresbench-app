// @vitest-environment jsdom
//
// TEST-UR-8 (ITEM-10) — the CSV download seam (PROV-UR-6 / DEC-13, INV-3,
// EXAMPLE-UR-5): `downloadPredictionsCsv` calls the generated
// `ApiClient.Txr.downloadPredictions` exactly once with the run id and
// saves the transport's text under `predictions-<runId>.csv` via a Blob +
// objectURL + anchor (the anchor click spy, the ProvenanceExport idiom) —
// and a 409 / 404 / network failure REJECTS (never a silent no-op; the
// pages surface the rejection as their inline error state), with no raw
// fetch and no host literal anywhere (the seam passes through the
// transport's auth/refresh machinery). The file's name convention is
// single-sourced: `predictionsCsvNameOf` is the one spelling.
//
// The helper is re-exported by the module barrel (PROV-UR-9, GAP-HIST-4):
// the tests import it through the barrel so a missing re-export fails the
// suite, as the acceptance row demands.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadPredictionsCsv, predictionsCsvNameOf, saveTextAsFile } from './download'

const api = vi.hoisted(() => ({
  downloadPredictions: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      downloadPredictions: (...a: unknown[]) => api.downloadPredictions(...a),
    },
  },
}))

/** The barrel re-export — the seam's public surface (PROV-UR-9). */
const { downloadPredictionsCsv: fromBarrel } = await import('../index')

function httpError(status: number, message = 'error'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

/** The anchor-click capture (the txrintake download-test idiom). */
function captureAnchor() {
  const createObjectURL = vi.fn(() => 'blob:txr-test')
  const revokeObjectURL = vi.fn()
  const clickSpy = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    value: clickSpy,
    writable: true,
    configurable: true,
  })
  const createElement = vi.spyOn(document, 'createElement')
  const anchor = () =>
    createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
  return {
    createObjectURL,
    revokeObjectURL,
    clickSpy,
    anchor,
    restore() {
      createElement.mockRestore()
    },
  }
}

const CSV_TEXT = 'patient_id,lm-cox-a,rsf-b\nS0001,0.30,0.49\n'

describe('downloadPredictionsCsv (TEST-UR-8)', () => {
  beforeEach(() => {
    api.downloadPredictions.mockReset()
    api.downloadPredictions.mockResolvedValue(CSV_TEXT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls the generated client exactly once with the run id', async () => {
    await downloadPredictionsCsv('run-1')
    expect(api.downloadPredictions).toHaveBeenCalledTimes(1)
    expect(api.downloadPredictions).toHaveBeenCalledWith({ id: 'run-1' })
  })

  it('saves the transport text under predictions-<runId>.csv (blob + anchor, revoked after)', async () => {
    const capture = captureAnchor()
    await downloadPredictionsCsv('run-1')
    const anchor = capture.anchor()
    expect(anchor).toBeDefined()
    expect(anchor?.download).toBe(predictionsCsvNameOf('run-1'))
    expect(anchor?.href).toBe('blob:txr-test')
    expect(capture.clickSpy).toHaveBeenCalledTimes(1)
    expect(capture.createObjectURL).toHaveBeenCalledTimes(1)
    expect(capture.revokeObjectURL).toHaveBeenCalledWith('blob:txr-test')
    capture.restore()
  })

  it('surfaces a 409 rejection — never a silent no-op (no file is saved)', async () => {
    api.downloadPredictions.mockRejectedValueOnce(httpError(409))
    const capture = captureAnchor()
    await expect(downloadPredictionsCsv('run-1')).rejects.toMatchObject({ status: 409 })
    expect(capture.anchor()).toBeUndefined()
    expect(capture.clickSpy).not.toHaveBeenCalled()
    capture.restore()
  })

  it('surfaces a 404 rejection — never a silent no-op', async () => {
    api.downloadPredictions.mockRejectedValueOnce(httpError(404))
    const capture = captureAnchor()
    await expect(downloadPredictionsCsv('run-1')).rejects.toMatchObject({ status: 404 })
    expect(capture.anchor()).toBeUndefined()
    capture.restore()
  })

  it('surfaces a network rejection — never a silent no-op', async () => {
    api.downloadPredictions.mockRejectedValueOnce(new Error('network down'))
    const capture = captureAnchor()
    await expect(downloadPredictionsCsv('run-1')).rejects.toThrow('network down')
    expect(capture.anchor()).toBeUndefined()
    capture.restore()
  })

  it('rejects an empty body instead of saving nothing', async () => {
    api.downloadPredictions.mockResolvedValueOnce('')
    const capture = captureAnchor()
    await expect(downloadPredictionsCsv('run-1')).rejects.toThrow(
      'the predictions download came back empty',
    )
    expect(capture.anchor()).toBeUndefined()
    capture.restore()
  })

  it('takes the filename convention from the one named helper', () => {
    expect(predictionsCsvNameOf('run-1')).toBe('predictions-run-1.csv')
    expect(predictionsCsvNameOf('run-42')).toBe('predictions-run-42.csv')
  })

  it('is re-exported from the module barrel (GAP-HIST-4 — a missing re-export fails this test)', () => {
    expect(fromBarrel).toBe(downloadPredictionsCsv)
  })

  it('keeps saveTextAsFile the single blob + anchor implementation', () => {
    // The seam's file-write primitive is the lib's own export; a page-local
    // duplicate would not be this function.
    const capture = captureAnchor()
    saveTextAsFile('predictions-run-1.csv', CSV_TEXT)
    expect(capture.anchor()?.download).toBe('predictions-run-1.csv')
    capture.restore()
  })
})
