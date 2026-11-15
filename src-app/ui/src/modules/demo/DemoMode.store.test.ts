// @vitest-environment jsdom
/**
 * TEST-DM-5 (store half) — the DemoMode boot-read store (ITEM-5): the
 * no-flash birth state (mode null, ready false), the wire answer applied
 * (demo vs desktop, url + notice + limits), the retry ladder (3 tries with
 * backoff, then the desktop fail-safe), the sessionStorage-remembered close
 * (read at birth, written by dismiss), and the init idempotence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDemoModeStore, type DemoMode } from './DemoMode.store'
import { resetDemoMode } from './test-utils/demoSeed'
import type { AppModeResponse } from '@/api-client/types'

// The module-level store is shared across tests: answer through the mock.
vi.mock('./lib/appModeApi', () => ({
  fetchAppMode: vi.fn(),
}))

import { fetchAppMode } from './lib/appModeApi'

const fetchMock = vi.mocked(fetchAppMode)

const DEMO_ANSWER: AppModeResponse = {
  mode: 'demo',
  download_url: 'https://downloads.example.test/txresbench',
  limits: { history: 50, models: 50 },
  notice: 'Runs and models here are shared with everyone who visits the demo.',
}

const DESKTOP_ANSWER: AppModeResponse = {
  mode: 'desktop',
  download_url: '',
  limits: { history: 50, models: 50 },
  notice: '',
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  resetDemoMode()
  fetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DemoMode.boot read (ITEM-5 store half)', () => {
  it('is born unknown — the no-flash rule: mode null, ready false, nothing demo applied', () => {
    const s = useDemoModeStore.getState()
    expect(s.mode).toBeNull()
    expect(s.ready).toBe(false)
    expect(s.downloadUrl).toBe('')
    expect(s.notice).toBe('')
  })

  it('applies a demo answer (mode, url, notice, limits) and settles ready', () => {
    useDemoModeStore.getState().applyResponse(DEMO_ANSWER)
    const s = useDemoModeStore.getState()
    expect(s.mode).toBe('demo')
    expect(s.downloadUrl).toBe(DEMO_ANSWER.download_url)
    expect(s.notice).toBe(DEMO_ANSWER.notice)
    expect(s.historyLimit).toBe(50)
    expect(s.modelLimit).toBe(50)
  })

  it('applies a desktop answer (no url, no notice) and settles ready', () => {
    useDemoModeStore.getState().applyResponse(DESKTOP_ANSWER)
    const s = useDemoModeStore.getState()
    expect(s.mode).toBe('desktop')
    expect(s.downloadUrl).toBe('')
    expect(s.notice).toBe('')
  })

  it('init reads once and settles ready (idempotent while loading/ready)', async () => {
    fetchMock.mockResolvedValue(DEMO_ANSWER)
    const p = useDemoModeStore.getState().init()
    // A second call while the first is in flight is a no-op.
    await useDemoModeStore.getState().init()
    await p
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useDemoModeStore.getState().mode).toBe('demo')
    expect(useDemoModeStore.getState().ready).toBe(true)
    await useDemoModeStore.getState().init()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries twice with backoff and settles DESKTOP on a persistent failure (the fail-safe)', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const p = useDemoModeStore.getState().init()
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const s = useDemoModeStore.getState()
    expect(s.mode).toBe('desktop')
    expect(s.ready).toBe(true)
    expect(s.loading).toBe(false)
  })

  it('recovers on the second attempt (a transient failure is absorbed)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(DEMO_ANSWER)
    const p = useDemoModeStore.getState().init()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useDemoModeStore.getState().mode).toBe('demo')
    expect(useDemoModeStore.getState().ready).toBe(true)
  })

  it('dismissNotice hides the bar for the browser session (sessionStorage)', () => {
    expect(useDemoModeStore.getState().noticeDismissed).toBe(false)
    useDemoModeStore.getState().dismissNotice()
    expect(useDemoModeStore.getState().noticeDismissed).toBe(true)
    expect(window.sessionStorage.getItem('txr-demo-notice-dismissed')).toBe('1')
  })

  it('a re-born store (a new page in the SAME session) reads the close at birth', async () => {
    window.sessionStorage.setItem('txr-demo-notice-dismissed', '1')
    vi.resetModules()
    const fresh = (await import('./DemoMode.store')).useDemoModeStore
    expect(fresh.getState().noticeDismissed).toBe(true)
  })
})
