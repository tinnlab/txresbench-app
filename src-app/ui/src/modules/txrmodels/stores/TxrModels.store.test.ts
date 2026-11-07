/**
 * TEST-MOD-04 — the `TxrModels` store (ITEM-3; PROV-UI-MODELS-3, INV-7,
 * the ui-list DEC-15 ONE-inventory pin, DEC-8/10 host-state contracts).
 *
 * Pinned behaviors:
 *
 * - NO zustand `persist(` anywhere in the store source (INV-7: nothing
 *   patient-adjacent in browser storage — the engine is the durability
 *   point, the intake's DEC-4 posture);
 * - `loadInventory` reads the ONE inventory object from the intake GAP
 *   (`validation.inventory`) and never re-derives it; a content change
 *   applies the inventory-scoped reset (selection + filters +
 *   downloadState + the verdicts clear) while the pending-Use handoff id
 *   SURVIVES (DEC-10 — the id must reach the I screen after the user
 *   adds the predict file);
 * - `loadEligibility` fetches ONCE per stable inventory hash (the
 *   `txrlist` `stableInventoryKey` canonicalization — same key, no
 *   refetch; content change refetches; `{force}` retries), posts the ONE
 *   inventory object verbatim, and a stale (older) resolve never
 *   overwrites the newer totals;
 * - `requestDownload` starts `Pretrained.downloadModel`, poll
 *   `Pretrained.listDownloads` every `DOWNLOAD_POLL_MS`, commits the
 *   terminal state ONCE and stops; `reset()` aborts live polls (the
 *   AbortController + terminal latch), and every poll write touches only
 *   its own `downloadState[id]` entry;
 * - `loadPretrained` / `loadSaved` fill their slices (in-flight dedupe,
 *   error surfaces, newer load supersedes);
 * - `toggle` / `toggleAllCanRun` delegate to the txrlist pure helpers
 *   (never a re-implementation) and skip the write on a no-op;
 * - `setPendingUse` / `openDialog` / `closeDialog` / the setters behave.
 *
 * Every fixture value is synthetic (id `ps-<k>`, model uuid `m-<k>`,
 * non-board counts — INV-4: the boards' facts are design examples, never
 * data).
 *
 * The only boundaries mocked are `ApiClient.Pretrained/Models/ModelSets.*`
 * and the intake store (the GAP read); the selection helpers and the
 * canonicalization are the REAL txrlist pure functions (the delegation
 * pin), and the store-kit lifecycle runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  EligibilityStatus,
  InventoryEligibilityRequest,
  ModelEligibility,
  ModelEligibilityResponse,
  ModelListResponse,
  ModelSetListResponse,
  ModelSummary,
  PretrainedDownloadState,
  PretrainedDownloadStatus,
  PretrainedListResponse,
  PretrainedSummary,
} from '@/api-client/types'

const api = vi.hoisted(() => ({
  pretrainedList: vi.fn(),
  downloadModel: vi.fn(),
  listDownloads: vi.fn(),
  savedList: vi.fn(),
  setsList: vi.fn(),
  checkEligibility: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Pretrained: {
      listModels: api.pretrainedList,
      downloadModel: api.downloadModel,
      listDownloads: api.listDownloads,
    },
    Models: {
      listModels: api.savedList,
      checkEligibility: api.checkEligibility,
    },
    ModelSets: {
      listSets: api.setsList,
    },
  },
}))

/** The intake GAP's inventory source (the validation slice decays to null). */
const intake = vi.hoisted(() => ({ validation: null as unknown }))
vi.mock('@/modules/txrintake', () => ({
  useTxrIntakeStore: { getState: (): unknown => ({ validation: intake.validation }) },
}))

const { useTxrModelsStore, DOWNLOAD_POLL_MS, DEFAULT_AT_A_TIME } = await import(
  './TxrModels.store'
)

const state = () => useTxrModelsStore.getState()

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (all synthetic — INV-4)
// ─────────────────────────────────────────────────────────────────────────────

/** A host-shaped analysis inventory (the generated request type). */
function inventory(
  over: Partial<InventoryEligibilityRequest> = {},
): InventoryEligibilityRequest {
  return {
    baseline_max_day: 0,
    covariates: [],
    decision_day: 56,
    markers: [],
    patients: 42,
    ...over,
  }
}

/** One saved-model verdict (the generated I-screen entry). */
function verdict(id: string, status: EligibilityStatus): ModelEligibility {
  return {
    endpoint: 'pfs',
    status,
    coverage: { eligible: 40, total: 42, fraction: 40 / 42 },
    estimate_quality: 'estimate',
    estimated_seconds: 60,
    min_draws: { required: 2, met: 40, unmet_patients: 0 },
    missing_markers: [],
    reasons: [],
    id,
  }
}

function eligibilityResponse(entries: ModelEligibility[]): ModelEligibilityResponse {
  const fit = entries.filter(e => e.status === 'can_run').length
  const some = entries.filter(e => e.status === 'can_run_some').length
  return { models: entries, total_fit: fit, total_some: some, total_cannot: entries.length - fit - some }
}

/** One download-manager status (the generated PROV-PC-6 shape). */
function download(
  id: string,
  downloadState: PretrainedDownloadState,
  over: Partial<PretrainedDownloadStatus> = {},
): PretrainedDownloadStatus {
  return {
    id,
    version: '1.0.0',
    state: downloadState,
    bytes_downloaded: 0,
    cached: false,
    bundled: false,
    ...over,
  }
}

/** One catalogue row (the generated PROV-PC-3 shape). */
function card(over: Partial<PretrainedSummary> & Pick<PretrainedSummary, 'id'>): PretrainedSummary {
  return {
    description: 'A fever chart',
    asset: { bundled: false, file: 'id.txr', sha256: 'ab', size_bytes: 1024 },
    decision_day: 42,
    endpoint: 'os',
    group: 'response-probability',
    group_label: 'Response probability',
    horizon: 182,
    kind: 'published-rule',
    licence: 'MIT',
    method_id: 'method-x',
    method_version: '1.0.0',
    name: 'Fever',
    paper: { doi: '10.1/x', journal: 'J', year: 2024 },
    research_notice: true,
    state: 'not_downloaded',
    transfer: { median: 0.64, metric: 'auc_rule', n_cohorts: 3 },
    version: '1.0.0',
    warnings: [],
    ...over,
  }
}

/** One saved-model row (the generated PROV-MS-2 shape). */
function model(over: Partial<ModelSummary> & Pick<ModelSummary, 'id'>): ModelSummary {
  return {
    created_at: '2026-10-21T12:00:00.000Z',
    decision_day: 56,
    embeds_training_data: false,
    endpoint: 'pfs',
    group: 'dynamic-risk',
    group_label: 'Dynamic risk',
    horizon: 238,
    method_id: 'method-1',
    method_version: '1.0.0',
    name: 'A model',
    provenance: 'run',
    size_bytes: 2048,
    uses_covariates: false,
    ...over,
  }
}

const setValidation = (value: unknown): void => {
  intake.validation = value
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TxrModels store (TEST-MOD-04)', () => {
  beforeEach(async () => {
    state().reset()
    for (const fn of Object.values(api)) fn.mockReset()
    setValidation(null)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never declares persistence (INV-7: nothing patient-adjacent in browser storage)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./TxrModels.store.ts', import.meta.url)),
      'utf8',
    )
    expect(source).not.toContain('persist(')
    expect(source).not.toContain('localStorage')
  })

  it('loadInventory reads the ONE intake inventory object straight through (no re-derivation, same content keeps the host state)', () => {
    const invA = inventory()
    setValidation({ inventory: invA })
    state().loadInventory()
    expect(state().inventory).toBe(invA)

    // A content-identical rebuild is a no-op for the host state (the
    // reference swaps, the selection survives).
    state().toggle({ key: 'm-1', run: { disabled: false } })
    const invASameContent = inventory()
    setValidation({ inventory: invASameContent })
    state().loadInventory()
    expect(state().inventory).toBe(invASameContent)
    expect(state().selection.has('m-1')).toBe(true)
  })

  it('a changed inventory clears selection, filters, the download views and the verdicts — and keeps the pending-Use handoff id (DEC-10)', () => {
    const invA = inventory()
    setValidation({ inventory: invA })
    state().loadInventory()
    state().toggle({ key: 'm-1', run: { disabled: false } })
    state().setFilter('same-outcome')
    state().setPendingUse('m-9')
    state().setDraftName('My set')
    state().setSearch('cox')
    state().setSort('time')
    state().setAtATime(4)
    state().openDialog('save-set')

    const invB = inventory({ patients: 84, decision_day: 42 })
    setValidation({ inventory: invB })
    state().loadInventory()
    expect(state().selection.size).toBe(0)
    expect(state().filters).toEqual([])
    expect(state().eligibility.totals).toBeNull()
    // Handoff + draft + list state survive an inventory change.
    expect(state().pendingUseModelId).toBe('m-9')
    expect(state().draftName).toBe('My set')
    expect(state().search).toBe('cox')
    expect(state().sort).toBe('time')
    expect(state().atATime).toBe(4)
    expect(state().dialog).toBe('save-set')
  })

  it('loads the pretrained catalogue and the saved models + sets once, and surfaces a fetch failure', async () => {
    api.pretrainedList.mockResolvedValueOnce({ models: [card({ id: 'ps-1' })], total: 1 })
    api.savedList.mockResolvedValueOnce({ models: [model({ id: 'm-1' })], total: 1 })
    api.setsList.mockResolvedValueOnce({ sets: [], total: 0 })

    const first = state().loadSaved()
    const second = state().loadSaved() // in-flight dedupe — no second request
    await Promise.all([first, second])
    expect(api.savedList).toHaveBeenCalledTimes(1)

    await state().loadPretrained()
    expect(state().pretrained.cards.map(c => c.id)).toEqual(['ps-1'])
    expect(state().pretrained.loading).toBe(false)
    expect(state().saved.summaries.map(m => m.id)).toEqual(['m-1'])

    api.pretrainedList.mockRejectedValueOnce(new Error('boom'))
    await state().loadPretrained()
    expect(state().pretrained.error).toBe('boom')
  })

  it('loadEligibility fetches once per stable inventory hash, refetches on a content change, and posts the ONE inventory object', async () => {
    const invA = inventory()
    const respA = eligibilityResponse([verdict('m-1', 'can_run')])
    api.checkEligibility.mockResolvedValueOnce(respA)

    setValidation({ inventory: invA })
    state().loadInventory()
    await state().loadEligibility(['m-1'])
    const invASameContent = inventory()
    setValidation({ inventory: invASameContent })
    state().loadInventory()
    await state().loadEligibility(['m-1']) // same key — no refetch
    expect(api.checkEligibility).toHaveBeenCalledTimes(1)
    const call = api.checkEligibility.mock.calls[0][0] as { inventory: unknown }
    expect(call.inventory).toBe(invA)

    // A changed inventory refetches with the NEW object verbatim.
    const invB = inventory({ patients: 84 })
    const respB = eligibilityResponse([verdict('m-1', 'cannot_run')])
    api.checkEligibility.mockResolvedValueOnce(respB)
    setValidation({ inventory: invB })
    state().loadInventory()
    await state().loadEligibility(['m-1'])
    expect(api.checkEligibility).toHaveBeenCalledTimes(2)
    expect((api.checkEligibility.mock.calls[1][0] as { inventory: unknown }).inventory).toBe(invB)
    expect(state().eligibility.totals).toEqual({ fit: 0, some: 0, cannot: 1 })
    expect(state().eligibility.byKey.get('m-1')?.status).toBe('cannot_run')

    // `{force}` is the retry: same key, still refetches.
    api.checkEligibility.mockResolvedValueOnce(respA)
    await state().loadEligibility(['m-1'], { force: true })
    expect(api.checkEligibility).toHaveBeenCalledTimes(3)

    // A changed MODEL ID SET is a changed key too: a model saved since
    // the last verdict fetch must be scored (an inventory-only key would
    // skip it and leave the new row verdict-less).
    api.checkEligibility.mockResolvedValueOnce(
      eligibilityResponse([verdict('m-1', 'can_run'), verdict('m-2', 'cannot_run')]),
    )
    await state().loadEligibility(['m-1', 'm-2'])
    expect(api.checkEligibility).toHaveBeenCalledTimes(4)
    expect(state().eligibility.byKey.get('m-2')?.status).toBe('cannot_run')
  })

  it('discards a stale eligibility resolve — the newer totals stay (the newer call wins by epoch)', async () => {
    const invA = inventory({ patients: 42 })
    const invB = inventory({ patients: 84 })
    let resolveA!: (v: ModelEligibilityResponse) => void
    let resolveB!: (v: ModelEligibilityResponse) => void
    api.checkEligibility
      .mockReturnValueOnce(
        new Promise<ModelEligibilityResponse>(r => {
          resolveA = r
        }),
      )
      .mockReturnValueOnce(
        new Promise<ModelEligibilityResponse>(r => {
          resolveB = r
        }),
      )

    setValidation({ inventory: invA })
    state().loadInventory()
    const slowOld = state().loadEligibility(['m-1'])
    setValidation({ inventory: invB })
    state().loadInventory()
    const fastNew = state().loadEligibility(['m-1'])

    resolveB(eligibilityResponse([verdict('m-1', 'can_run')]))
    await fastNew
    resolveA(eligibilityResponse([verdict('m-1', 'cannot_run')]))
    await slowOld

    expect(state().eligibility.totals).toEqual({ fit: 1, some: 0, cannot: 0 })
    expect(state().eligibility.byKey.get('m-1')?.status).toBe('can_run')
  })

  it('loads nothing and clears the verdicts when there is no inventory (the not-ready screen state)', async () => {
    state().loadInventory()
    expect(state().inventory).toBeNull()
    api.checkEligibility.mockResolvedValueOnce(eligibilityResponse([]))
    await state().loadEligibility(['m-1'])
    expect(api.checkEligibility).not.toHaveBeenCalled()
    expect(state().eligibility.loading).toBe(false)
    expect(state().eligibility.totals).toBeNull()
  })

  it('toggle and toggleAllCanRun delegate to the txrlist helpers (disabled rows never move, no-op skips the write)', () => {
    state().toggle({ key: 'm-1', run: { disabled: false } })
    expect(state().selection.has('m-1')).toBe(true)
    const selectionRef = state().selection
    state().toggle({ key: 'm-1', run: { disabled: true } }) // cannot row — no helper change
    expect(state().selection).toBe(selectionRef)
    expect(state().selection.has('m-1')).toBe(true)

    const rows = [
      { key: 'm-1', run: { disabled: false } },
      { key: 'm-2', run: { disabled: false } },
      { key: 'm-3', run: { disabled: true } },
    ]
    state().toggleAllCanRun(rows)
    expect(state().selection.has('m-1')).toBe(true)
    expect(state().selection.has('m-2')).toBe(true)
    expect(state().selection.has('m-3')).toBe(false)
  })

  it('requestDownload starts the provider download and polls to a terminal state, committing it once', async () => {
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'downloading', { bytes_total: 100 }))
    api.listDownloads.mockResolvedValueOnce({
      downloads: [download('ps-1', 'downloading', { bytes_downloaded: 40, bytes_total: 100 })],
    })
    await state().requestDownload('ps-1')
    expect(state().downloadState['ps-1'].status?.state).toBe('downloading')
    // Poll #1 — still downloading, keeps polling.
    await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS)
    expect(api.listDownloads).toHaveBeenCalledTimes(1)
    // Poll #2 — terminal; committed once, then the poll stops.
    api.listDownloads.mockResolvedValueOnce({ downloads: [download('ps-1', 'ready')] })
    await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS)
    expect(api.listDownloads).toHaveBeenCalledTimes(2)
    expect(state().downloadState['ps-1'].status?.state).toBe('ready')
    await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 5)
    expect(api.listDownloads).toHaveBeenCalledTimes(2)
  })

  it('requestDownload is a no-op while a download is live or terminal, and retries a failed one', async () => {
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'downloading'))
    api.listDownloads.mockReturnValue({ downloads: [download('ps-1', 'downloading')] })
    const first = state().requestDownload('ps-1')
    await first
    await state().requestDownload('ps-1') // live — no second start
    expect(api.downloadModel).toHaveBeenCalledTimes(1)

    state().reset()
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'failed', { error: 'bad digest' }))
    await state().requestDownload('ps-1')
    expect(state().downloadState['ps-1'].status?.state).toBe('failed')
    // A failed entry is re-requestable (the Retry button).
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'ready'))
    await state().requestDownload('ps-1')
    expect(api.downloadModel).toHaveBeenCalledTimes(3)
    expect(state().downloadState['ps-1'].status?.state).toBe('ready')
  })

  it('reset() aborts a live poll (unmount-safe): no more polls, the state clears', async () => {
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'downloading'))
    api.listDownloads.mockReturnValue({ downloads: [download('ps-1', 'downloading')] })
    const first = state().requestDownload('ps-1')
    await first
    await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS)
    expect(api.listDownloads).toHaveBeenCalledTimes(1)

    state().reset()
    await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 5)
    expect(api.listDownloads).toHaveBeenCalledTimes(1)
    expect(state().downloadState['ps-1']).toBeUndefined()
  })

  it('a fetch failure of the download start surfaces the error line and stays retryable', async () => {
    api.downloadModel.mockRejectedValueOnce(new Error('offline'))
    await state().requestDownload('ps-1')
    expect(state().downloadState['ps-1'].error).toBe('offline')
    expect(state().downloadState['ps-1'].status).toBeNull()
  })

  it('host-state setters and the dialog surface behave (draft name, at-a-time, search, sort, filters, pending-Use)', () => {
    state().setDraftName('CRC cohort')
    state().setAtATime(2)
    state().setSearch('cox')
    state().setSort('newest-run')
    state().setFilter('published')
    state().setFilter('learned')
    expect(state().filters).toEqual(['published', 'learned'])
    state().setFilter('published')
    expect(state().filters).toEqual(['learned'])

    state().setPendingUse('m-7')
    expect(state().pendingUseModelId).toBe('m-7')
    state().setPendingUse(null)
    expect(state().pendingUseModelId).toBeNull()

    state().openDialog('card:ps-1')
    expect(state().dialog).toBe('card:ps-1')
    state().openDialog('save-set')
    expect(state().dialog).toBe('save-set')
    state().closeDialog()
    expect(state().dialog).toBe('none')
  })

  it('registers whole-store-lazy (the proxy + the bound hook are one store)', () => {
    // The module declares `stores: []`; this file registers the store on
    // import, and the proxy passes its state through to the hook handle.
    expect(useTxrModelsStore.getState()).toBeTruthy()
    expect(state().atATime).toBe(DEFAULT_AT_A_TIME)
  })
})
