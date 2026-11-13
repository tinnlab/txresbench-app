// @vitest-environment jsdom
/**
 * TEST-QF4-4 (ITEM-4, R3-intake-8) — the session bootstrap: when
 * `POST /api/session/local` fails or is slow the app must never sit on a
 * bare "Loading…". The store retries the mint automatically (3 tries, with
 * backoff), marks a slow mint, and after the last try the guard shows "We
 * could not start the app" with the plain reason and a Retry button.
 *
 * The ApiClient is mocked; the store and the guard are real. Fake timers
 * drive the backoff sleeps and the slow timer deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Session, useSessionStore } from './Session.store'
import { SessionGuard } from './SessionGuard'

const api = vi.hoisted(() => ({
  create: vi.fn(),
  me: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    LocalSession: { create: api.create },
    Auth: { me: api.me },
  },
}))

const SESSION = { access_token: 'tok', refresh_token: 'refresh' }
const ME = {
  user: { id: 'owner', name: 'Owner' },
  permissions: ['*'],
}

beforeEach(() => {
  api.create.mockReset()
  api.me.mockReset()
  api.create.mockResolvedValue(SESSION)
  api.me.mockResolvedValue(ME)
  vi.useFakeTimers()
  useSessionStore.setState({
    user: null,
    permissions: [],
    ready: false,
    minting: false,
    error: null,
    attempts: 0,
    slow: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  cleanup()
})

async function runMint() {
  await act(async () => {
    void Session.initSession()
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(6000)
  })
}

describe('Session.store (R3-intake-8)', () => {
  it('mints the session and /me on the first try', async () => {
    await runMint()
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().ready).toBe(true)
    expect(useSessionStore.getState().error).toBeNull()
    expect(useSessionStore.getState().attempts).toBe(1)
  })

  it('retries a failing mint 3 times with backoff, then reports the plain reason', async () => {
    api.create.mockRejectedValue(new Error('Failed to fetch'))
    await runMint()
    expect(api.create).toHaveBeenCalledTimes(3)
    expect(useSessionStore.getState().ready).toBe(false)
    expect(useSessionStore.getState().minting).toBe(false)
    expect(useSessionStore.getState().error).toBe('Failed to fetch')
    expect(useSessionStore.getState().attempts).toBe(3)
    // The backoff gaps are real (500 ms then 1 s across the three tries).
    expect(api.create.mock.invocationCallOrder.length).toBe(3)
  })

  it('recovers from one transient failure (the round-3 load)', async () => {
    api.create.mockRejectedValueOnce(new Error('Failed to fetch'))
    await runMint()
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().ready).toBe(true)
    expect(useSessionStore.getState().error).toBeNull()
  })

  it('marks a slow mint ("still trying", never a bare hang)', async () => {
    let resolveCreate!: (value: typeof SESSION) => void
    api.create.mockImplementationOnce(
      () => new Promise(resolve => (resolveCreate = resolve)),
    )
    let started = false
    await act(async () => {
      void Session.initSession()
      started = true
      await vi.advanceTimersByTimeAsync(4100)
    })
    expect(started).toBe(true)
    expect(useSessionStore.getState().minting).toBe(true)
    expect(useSessionStore.getState().slow).toBe(true)
    await act(async () => {
      resolveCreate(SESSION)
      await Promise.resolve()
    })
    expect(useSessionStore.getState().ready).toBe(true)
    expect(useSessionStore.getState().slow).toBe(false)
  })
})

describe('SessionGuard (R3-intake-8)', () => {
  it('shows "We could not start the app", the reason and Retry after 3 failed tries', async () => {
    api.create.mockRejectedValue(new Error('connection refused'))
    render(
      <SessionGuard>
        <div>app content</div>
      </SessionGuard>,
    )
    // The guard says what is happening while the mint retries.
    expect(screen.getByText('Starting the app…')).toBeTruthy()
    // Three tries: attempt 1 fails, backoff 500 ms, attempt 2 fails,
    // backoff 1 s, attempt 3 fails → the error state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByText('We could not start the app')).toBeTruthy()
    expect(screen.getByText('connection refused')).toBeTruthy()
    expect(screen.queryByText('app content')).toBeNull()

    // Retry with the endpoint healthy again → the app content renders.
    api.create.mockResolvedValue(SESSION)
    fireEvent.click(screen.getByTestId('session-retry'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText('app content')).toBeTruthy()
  })

  it('reports the still-trying line on a slow mint (the bare Loading is gone)', async () => {
    let resolveCreate!: (value: typeof SESSION) => void
    api.create.mockImplementationOnce(
      () => new Promise(resolve => (resolveCreate = resolve)),
    )
    render(
      <SessionGuard>
        <div>app content</div>
      </SessionGuard>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100)
    })
    expect(screen.getByTestId('session-slow').textContent).toBe(
      'This is taking longer than usual. Still trying.',
    )
    expect(screen.getByText('Starting the app…')).toBeTruthy()
    await act(async () => {
      resolveCreate(SESSION)
      await Promise.resolve()
    })
    expect(screen.queryByTestId('session-slow')).toBeNull()
    expect(screen.getByText('app content')).toBeTruthy()
  })
})
