// @vitest-environment jsdom
/**
 * The shell's WSL notice (Windows): why methods cannot run, "Set up WSL" /
 * "Update WSL" when the app offers a setup (the registered
 * `sandbox.setupWsl` action), the running state and the result texts; nothing
 * when the server reports no `wsl_setup` (other systems, methods can run),
 * in the demo, or without the sandbox read permission.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvIndexStatus, WslSetupResult, WslSetupStatus } from '@/api-client/types'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

const api = vi.hoisted(() => ({ listEnvs: vi.fn(), setupWsl: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { Sandbox: { listEnvs: api.listEnvs, setupWsl: api.setupWsl } },
}))

// The action registers on import (the txrshell module's side-effect import).
await import('@/core/actions/builtin/wslSetupActions')
const { getActionMeta } = await import('@/core/actions/defineAction')
const { isContextActive } = await import('@/core/actions/activeContext')
const { seedDemoMode, resetDemoMode } = await import('@/modules/demo/test-utils/demoSeed')
const { __resetWslSetupForTests, WSL_SETUP_CONTEXT } = await import('@/lib/wsl-setup/wslSetup')
const {
  WslSetupNotice,
  wslNoticeView,
  formatExitCode,
  WSL_MISSING_LINE,
  WSL_OLD_LINE,
  WSL_RUNNING_LINE,
  WSL_ASKS_LINE,
  WSL_DONE_RESTART_LINE,
  WSL_DONE_LINE,
  WSL_DECLINED_LINE,
} = await import('./WslSetupNotice')

const REASON =
  'methods run in WSL 2, which is not installed or too old on this PC: open PowerShell as administrator, run `wsl --install --no-distribution`'

function facts(setup: Partial<WslSetupStatus> = {}, reason = REASON) {
  return { reason, setup: { running: false, ...setup } }
}

function envs(wsl_setup?: WslSetupStatus): EnvIndexStatus {
  return {
    stack: {
      supported: wsl_setup === undefined,
      reason: wsl_setup === undefined ? undefined : REASON,
      registry_base: 'ghcr.io/x',
      tool_bins: {},
      wsl_setup,
    },
    base: [],
    layers: [],
  }
}

function result(over: Partial<WslSetupResult>): WslSetupResult {
  return { outcome: 'failed', restart_windows: false, output: '', ...over }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  api.listEnvs.mockReset()
  api.setupWsl.mockReset()
  resetDemoMode()
  __resetWslSetupForTests()
})

afterEach(() => {
  cleanup()
})

describe('wslNoticeView', () => {
  it('offers "Set up WSL" when WSL is missing and "Update WSL" when it is too old', () => {
    const install = wslNoticeView(facts({ offer: 'install' }), false)
    expect(install.title).toBe(WSL_MISSING_LINE)
    expect(install.button).toEqual({ label: 'Set up WSL', busy: false })
    expect(install.status).toBe(WSL_ASKS_LINE)
    expect(install.tone).toBe('warning')
    const update = wslNoticeView(facts({ offer: 'update' }), false)
    expect(update.title).toBe(WSL_OLD_LINE)
    expect(update.button).toEqual({ label: 'Update WSL', busy: false })
  })

  it('without an offer says why in the start-up check\'s words, with no button', () => {
    const view = wslNoticeView(
      facts({}, 'this is the x86_64 build of the app running on ARM64 Windows; install the ARM64 build to run methods'),
      false,
    )
    expect(view.button).toBeNull()
    expect(view.status).toBeNull()
    expect(view.title).toBe(
      'Methods cannot run yet: this is the x86_64 build of the app running on ARM64 Windows; install the ARM64 build to run methods.',
    )
  })

  it('while a setup runs (this window\'s or another\'s) the button is busy and says what happens', () => {
    for (const [running, posting] of [
      [true, false],
      [false, true],
    ] as const) {
      const view = wslNoticeView(facts({ offer: 'install', running }), posting)
      expect(view.button).toEqual({ label: 'Set up WSL', busy: true })
      expect(view.status).toBe(WSL_RUNNING_LINE)
      expect(view.tone).toBe('info')
    }
  })

  it('a done setup says to restart Windows (or the app) and offers nothing more', () => {
    const restart = wslNoticeView(facts({ last: result({ outcome: 'done', restart_windows: true }) }), false)
    expect(restart).toEqual({ tone: 'success', title: WSL_DONE_RESTART_LINE, status: null, detail: null, button: null })
    const reopen = wslNoticeView(facts({ last: result({ outcome: 'done', restart_windows: false }) }), false)
    expect(reopen.title).toBe(WSL_DONE_LINE)
    expect(reopen.button).toBeNull()
  })

  it('says how the last setup went and offers it again', () => {
    const declined = wslNoticeView(facts({ offer: 'install', last: result({ outcome: 'declined' }) }), false)
    expect(declined.status).toBe(WSL_DECLINED_LINE)
    expect(declined.button?.label).toBe('Set up WSL')

    const notStarted = wslNoticeView(
      facts({ offer: 'update', last: result({ outcome: 'not_started', windows_error: 2 }) }),
      false,
    )
    expect(notStarted.status).toBe('WSL setup could not start (Windows error 2).')
    expect(notStarted.tone).toBe('error')

    const failed = wslNoticeView(
      facts({
        offer: 'install',
        last: result({ outcome: 'failed', exit_code: 0x80070422, output: 'The service cannot be started.\nError code: Wsl/0x80070422' }),
      }),
      false,
    )
    expect(failed.status).toBe('WSL could not be set up (code 0x80070422). Check the internet connection and try again.')
    expect(failed.detail).toBe('The service cannot be started.\nError code: Wsl/0x80070422')
    expect(failed.button?.label).toBe('Set up WSL')

    const silent = wslNoticeView(facts({ offer: 'install', last: result({ outcome: 'failed', exit_code: 1 }) }), false)
    expect(silent.status).toBe('WSL could not be set up (code 1). Check the internet connection and try again.')
    expect(silent.detail).toBeNull()

    const late = wslNoticeView(facts({ offer: 'install', last: result({ outcome: 'timed_out' }) }), false)
    expect(late.status).toBe('The WSL setup did not finish in time; it may still be running.')
  })

  it('prints a Windows error code in hex and a small exit code as is', () => {
    expect(formatExitCode(0x80370102)).toBe('0x80370102')
    expect(formatExitCode(0x8000ffff)).toBe('0x8000FFFF')
    expect(formatExitCode(7)).toBe('7')
  })
})

describe('WslSetupNotice', () => {
  it('shows nothing when the server reports no WSL notice (other systems, methods can run)', async () => {
    seedDemoMode('desktop')
    api.listEnvs.mockResolvedValue(envs())
    render(<WslSetupNotice />)
    await settle()
    expect(api.listEnvs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('txr-wsl-notice')).toBeNull()
    expect(isContextActive(WSL_SETUP_CONTEXT)).toBe(false)
  })

  it('reads nothing and shows nothing in the demo or while the mode read is pending', async () => {
    api.listEnvs.mockResolvedValue(envs({ offer: 'install', running: false }))
    render(<WslSetupNotice />)
    await settle()
    expect(screen.queryByTestId('txr-wsl-notice')).toBeNull()
    cleanup()
    seedDemoMode('demo')
    render(<WslSetupNotice />)
    await settle()
    expect(screen.queryByTestId('txr-wsl-notice')).toBeNull()
    expect(api.listEnvs).not.toHaveBeenCalled()
  })

  it('a refused read (no permission, 403) shows nothing', async () => {
    seedDemoMode('desktop')
    api.listEnvs.mockRejectedValue(Object.assign(new Error('Missing required permission'), { status: 403 }))
    render(<WslSetupNotice />)
    await settle()
    expect(api.listEnvs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('txr-wsl-notice')).toBeNull()
  })

  it('without an offer says why and has no button', async () => {
    seedDemoMode('desktop')
    api.listEnvs.mockResolvedValue(envs({ running: false }))
    render(<WslSetupNotice />)
    await settle()
    expect(screen.getByTestId('txr-wsl-notice').textContent).toContain('Methods cannot run yet: methods run in WSL 2')
    expect(screen.queryByTestId('txr-wsl-notice-setup')).toBeNull()
    expect(screen.getByRole('region', { name: 'WSL notice' })).toBeTruthy()
    expect(isContextActive(WSL_SETUP_CONTEXT)).toBe(false)
  })

  it('"Set up WSL" runs the registered action, shows the running state, then the result', async () => {
    seedDemoMode('desktop')
    api.listEnvs.mockResolvedValue(envs({ offer: 'install', running: false }))
    let finish: (r: WslSetupResult) => void = () => {}
    api.setupWsl.mockImplementation(() => new Promise<WslSetupResult>(resolve => (finish = resolve)))
    render(<WslSetupNotice />)
    await settle()
    expect(screen.getByTestId('txr-wsl-notice').textContent).toContain(WSL_MISSING_LINE)
    const button = screen.getByTestId('txr-wsl-notice-setup')
    expect(button.textContent).toContain('Set up WSL')
    expect(isContextActive(WSL_SETUP_CONTEXT)).toBe(true)

    await act(async () => {
      fireEvent.click(button)
    })
    expect(api.setupWsl).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('txr-wsl-notice-status').textContent).toBe(WSL_RUNNING_LINE)
    expect(screen.getByTestId('txr-wsl-notice-setup').getAttribute('aria-busy')).toBe('true')

    const done = result({ outcome: 'done', restart_windows: true })
    api.listEnvs.mockResolvedValue(envs({ running: false, last: done }))
    await act(async () => {
      finish(done)
    })
    await settle()
    expect(screen.getByTestId('txr-wsl-notice').textContent).toContain(WSL_DONE_RESTART_LINE)
    expect(screen.queryByTestId('txr-wsl-notice-setup')).toBeNull()
    expect(isContextActive(WSL_SETUP_CONTEXT)).toBe(false)
  })

  it('shows the update label and a failed setup\'s code and words', async () => {
    seedDemoMode('desktop')
    api.listEnvs.mockResolvedValue(
      envs({ offer: 'update', running: false, last: result({ exit_code: 4294967295, output: 'Update failed.' }) }),
    )
    render(<WslSetupNotice />)
    await settle()
    expect(screen.getByTestId('txr-wsl-notice-setup').textContent).toContain('Update WSL')
    expect(screen.getByTestId('txr-wsl-notice-status').textContent).toBe(
      'WSL could not be set up (code 0xFFFFFFFF). Check the internet connection and try again.',
    )
    expect(screen.getByTestId('txr-wsl-notice-detail').textContent).toBe('Update failed.')
  })

  it('a refused setup (409) is said in a message, not thrown', async () => {
    seedDemoMode('desktop')
    api.listEnvs.mockResolvedValue(envs({ offer: 'install', running: false }))
    api.setupWsl.mockRejectedValue(new Error('a WSL setup is already running; wait for it to end'))
    render(<WslSetupNotice />)
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-wsl-notice-setup'))
    })
    await settle()
    expect(api.setupWsl).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('txr-wsl-notice-setup').getAttribute('aria-busy')).not.toBe('true')
  })

  it('reads again while a setup it is not waiting for runs, and stops when it ended', async () => {
    vi.useFakeTimers()
    try {
      seedDemoMode('desktop')
      api.listEnvs.mockResolvedValue(envs({ offer: 'install', running: true }))
      render(<WslSetupNotice />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByTestId('txr-wsl-notice-status').textContent).toBe(WSL_RUNNING_LINE)
      expect(api.listEnvs).toHaveBeenCalledTimes(1)
      api.listEnvs.mockResolvedValue(envs({ offer: 'install', running: false, last: result({ outcome: 'declined' }) }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(api.listEnvs).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('txr-wsl-notice-status').textContent).toBe(WSL_DECLINED_LINE)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000)
      })
      expect(api.listEnvs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the action is the setup, with the sandbox manage permission, no params and the setup context', () => {
    const meta = getActionMeta('sandbox.setupWsl')
    expect(meta).toMatchObject({
      title: 'Set up WSL',
      permission: 'sandbox::settings::manage',
      mutating: true,
      kind: 'global',
      context: WSL_SETUP_CONTEXT,
      surfaces: { palette: true, ai: true },
    })
  })
})
