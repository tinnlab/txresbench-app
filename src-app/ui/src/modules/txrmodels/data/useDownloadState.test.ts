// @vitest-environment jsdom
/**
 * TEST-MOD-28 — the D card download controller (ITEM-5; PROV-PC-6,
 * CONS-UM-20): `useDownloadState` + the backoff schedule.
 *
 * Pinned behaviors:
 *
 * - `start()` re-issues the store's `requestDownload(id)` (the ONE poll
 *   owner — THIS hook never polls; the store's fixed-interval poll + the
 *   terminal-committed-once contract stay TEST-MOD-04's);
 * - a failed START re-issues itself on the exponential schedule
 *   (`downloadBackoffMs`: 2 s, 4 s, 8 s, … capped at 30 s) up to
 *   `DOWNLOAD_MAX_RETRIES` — one attempt in flight at a time (the
 *   schedule arms after the response landed);
 * - any non-null status — the download started, or the terminal
 *   `ready`/`failed` — STOPS the retry schedule (stop-on-terminal); a
 *   provider `failed` is never auto-retried (the human's Retry);
 * - a manual `retry()` cancels a pending automatic retry and re-issues
 *   (no doubled starts);
 * - unmount cancels a pending retry (no retry against a card the user
 *   left);
 * - the store's poll still delivers the bytes/progress and the terminal
 *   state through the hook's `entry`.
 *
 * The store runs REAL with a mocked `ApiClient` (the `Datasets.store.test`
 * precedent) and the poll/backoff timers are driven with fake timers.
 * Every fixture value is synthetic (id `ps-1`, non-board counts — INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { PretrainedDownloadState, PretrainedDownloadStatus } from '@/api-client/types'

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  checkEligibility: vi.fn(),
  downloadModel: vi.fn(),
  listDownloads: vi.fn(),
  savedList: vi.fn(),
  savedEligibility: vi.fn(),
  setsList: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Pretrained: {
      listModels: api.listModels,
      getModel: api.getModel,
      checkEligibility: api.checkEligibility,
      downloadModel: api.downloadModel,
      listDownloads: api.listDownloads,
    },
    Models: { listModels: api.savedList, checkEligibility: api.savedEligibility },
    ModelSets: { listSets: api.setsList },
  },
}))

const intake = vi.hoisted(() => ({ validation: null as unknown }))
vi.mock('@/modules/txrintake', () => ({
  useTxrIntakeStore: { getState: (): unknown => ({ validation: intake.validation }) },
}))

const { useTxrModelsStore, DOWNLOAD_POLL_MS } = await import('../stores/TxrModels.store')
const {
  useDownloadState,
  downloadBackoffMs,
  DOWNLOAD_RETRY_BASE_MS,
  DOWNLOAD_RETRY_CAP_MS,
  DOWNLOAD_MAX_RETRIES,
} = await import('./useDownloadState')

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

const state = () => useTxrModelsStore.getState()

/** Flush the pending promise chain of the mocked client. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useDownloadState (TEST-MOD-28)', () => {
  beforeEach(() => {
    state().reset()
    for (const fn of Object.values(api)) fn.mockReset()
    intake.validation = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('start() surfaces the provider status and the store\'s poll delivers bytes + terminal', async () => {
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'downloading', { bytes_total: 100 }))
    api.listDownloads
      .mockResolvedValueOnce({
        downloads: [download('ps-1', 'downloading', { bytes_downloaded: 40, bytes_total: 100 })],
      })
      .mockResolvedValueOnce({
        downloads: [download('ps-1', 'ready', { bytes_downloaded: 100, bytes_total: 100, digest: 'ab' })],
      })
    const { result } = renderHook(() => useDownloadState('ps-1'))
    await act(async () => {
      result.current.start()
    })
    await flush()
    expect(api.downloadModel).toHaveBeenCalledTimes(1)
    expect(result.current.entry?.status?.state).toBe('downloading')
    expect(result.current.retrying).toBe(false)

    // One poll tick: the bytes line updates; the next tick commits `ready`
    // (terminal — the store's poll stops) and the hook's entry reads it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS)
    })
    expect(result.current.entry?.status?.bytes_downloaded).toBe(40)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS)
    })
    expect(result.current.entry?.status?.state).toBe('ready')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS * 3)
    })
    expect(api.listDownloads).toHaveBeenCalledTimes(2)
  })

  it('a failed start re-issues on the exponential schedule and stops at the budget', async () => {
    api.downloadModel.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useDownloadState('ps-1'))
    await act(async () => {
      result.current.start()
    })
    await flush()
    expect(api.downloadModel).toHaveBeenCalledTimes(1)
    expect(result.current.entry?.error).toBe('offline')
    expect(result.current.retrying).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_BASE_MS)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_BASE_MS * 2)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_BASE_MS * 4)
    })
    // 1 start + 3 retries (2 s, 4 s, 8 s), then the budget is spent.
    expect(api.downloadModel).toHaveBeenCalledTimes(1 + DOWNLOAD_MAX_RETRIES)
    expect(result.current.retrying).toBe(false)
    expect(result.current.entry?.error).toBe('offline')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_CAP_MS * 2)
    })
    expect(api.downloadModel).toHaveBeenCalledTimes(1 + DOWNLOAD_MAX_RETRIES)
  })

  it('stop-on-terminal: a status landing cancels the pending retry schedule', async () => {
    api.downloadModel
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(download('ps-1', 'downloading'))
    const { result } = renderHook(() => useDownloadState('ps-1'))
    await act(async () => {
      result.current.start()
    })
    await flush()
    expect(result.current.entry?.error).toBe('offline')
    expect(result.current.retrying).toBe(true)

    // The human's Retry before the backoff fires: the pending timer is
    // cancelled, the new start succeeds, and no automatic retry follows.
    await act(async () => {
      result.current.retry()
    })
    await flush()
    expect(result.current.retrying).toBe(false)
    expect(result.current.entry?.status?.state).toBe('downloading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_CAP_MS * 2)
    })
    expect(api.downloadModel).toHaveBeenCalledTimes(2)
  })

  it('unmount cancels a pending retry (no retry against a card the user left)', async () => {
    api.downloadModel.mockRejectedValue(new Error('offline'))
    const { result, unmount } = renderHook(() => useDownloadState('ps-1'))
    await act(async () => {
      result.current.start()
    })
    await flush()
    expect(result.current.retrying).toBe(true)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_CAP_MS * 2)
    })
    expect(api.downloadModel).toHaveBeenCalledTimes(1)
  })

  it('a provider terminal failure is never auto-retried — the human Retry re-issues', async () => {
    api.downloadModel
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(download('ps-1', 'failed', { error: 'bad digest' }))
    const { result } = renderHook(() => useDownloadState('ps-1'))
    await act(async () => {
      result.current.start()
    })
    await flush()
    expect(result.current.retrying).toBe(true)

    // The budget's first automatic retry lands a TERMINAL `failed`: the
    // schedule STOPS (status non-null — the provider's sha256 verify
    // failure is the human's call, never auto-retried).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_BASE_MS)
    })
    expect(result.current.entry?.status?.state).toBe('failed')
    expect(result.current.retrying).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_CAP_MS * 2)
    })
    expect(api.downloadModel).toHaveBeenCalledTimes(2)

    // The card's Retry re-issues the idempotent start.
    api.downloadModel.mockResolvedValueOnce(download('ps-1', 'ready'))
    await act(async () => {
      result.current.retry()
    })
    await flush()
    expect(result.current.entry?.status?.state).toBe('ready')
    expect(api.downloadModel).toHaveBeenCalledTimes(3)
  })
})

describe('downloadBackoffMs (TEST-MOD-28)', () => {
  it('is exponential and capped at the 30 s ceiling', () => {
    expect(downloadBackoffMs(0)).toBe(2000)
    expect(downloadBackoffMs(1)).toBe(4000)
    expect(downloadBackoffMs(2)).toBe(8000)
    expect(downloadBackoffMs(3)).toBe(16000)
    expect(downloadBackoffMs(4)).toBe(30000)
    expect(downloadBackoffMs(8)).toBe(30000)
    expect(downloadBackoffMs(0, 1000, 5000)).toBe(1000)
    expect(downloadBackoffMs(3, 1000, 5000)).toBe(5000)
  })
})
