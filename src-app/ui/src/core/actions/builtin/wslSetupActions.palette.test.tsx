// @vitest-environment jsdom
/**
 * `sandbox.setupWsl` through the REAL command palette: listed only for a user
 * holding `sandbox::settings::manage`, and only while a setup can start (offered,
 * none running, not just declined: the store keeps the `txr.wsl-setup` context
 * active then); choosing it starts the setup (`POST /api/sandbox/wsl/setup`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { setAuthView, type PermissionAuthView } from '@txresbench/framework/permissions'
import type { StoreProxy } from '@txresbench/framework/stores'
import type { EnvIndexStatus, WslSetupStatus } from '@/api-client/types'

const api = vi.hoisted(() => ({ listEnvs: vi.fn(), setupWsl: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { Sandbox: { listEnvs: api.listEnvs, setupWsl: api.setupWsl } },
}))

const { CommandPalette } = await import('@/modules/command-palette/CommandPalette')
const { closeCommandPalette, openCommandPalette } = await import('@/modules/command-palette/paletteState')
await import('./wslSetupActions')
await import('./appActions')
const { refreshWslSetup, __resetWslSetupForTests } = await import('@/lib/wsl-setup/wslSetup')

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

function signIn(permissions: string[]): void {
  const view: PermissionAuthView = { user: { id: 'u1', is_admin: false } as never, permissions }
  setAuthView({ ...view, $: view } as unknown as StoreProxy<PermissionAuthView>)
}

function envs(wsl_setup?: WslSetupStatus): EnvIndexStatus {
  return {
    stack: { supported: wsl_setup === undefined, registry_base: 'r', tool_bins: {}, wsl_setup },
    base: [],
    layers: [],
  }
}

/** The facts as the server gives them (what the shell's notice reads on mount). */
async function serverSays(wsl_setup?: WslSetupStatus): Promise<void> {
  api.listEnvs.mockResolvedValue(envs(wsl_setup))
  await act(async () => {
    await refreshWslSetup()
  })
}

async function openPalette(): Promise<void> {
  render(<CommandPalette />)
  await act(async () => {
    openCommandPalette()
  })
}

const ITEM = 'command-palette-item-sandbox.setupWsl'

beforeAll(() => {
  const proto = Element.prototype as unknown as { scrollIntoView?: () => void }
  if (typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = () => {}
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver
  }
})

beforeEach(() => {
  api.listEnvs.mockReset()
  api.setupWsl.mockReset()
  __resetWslSetupForTests()
})

afterEach(() => {
  act(() => closeCommandPalette())
  cleanup()
})

describe('sandbox.setupWsl in the command palette', () => {
  it('is listed for a user with the permission while a setup is offered, and runs the setup', async () => {
    signIn(['sandbox::settings::manage'])
    await serverSays({ offer: 'install', running: false })
    api.setupWsl.mockResolvedValue({ offer: 'install', running: true })
    await openPalette()
    const item = screen.getByTestId(ITEM)
    expect(item.textContent).toContain('Set up WSL')
    await act(async () => {
      fireEvent.click(item)
    })
    // No parameters: choosing it runs it (a param-less action has no form).
    expect(screen.queryByTestId('command-palette-param-form')).toBeNull()
    expect(api.setupWsl).toHaveBeenCalledTimes(1)
  })

  it('is not listed for a user without the permission', async () => {
    signIn(['sandbox::settings::read', 'mcp::use'])
    await serverSays({ offer: 'install', running: false })
    await openPalette()
    expect(screen.getByTestId('command-palette-item-app.navigate')).toBeTruthy()
    expect(screen.queryByTestId(ITEM)).toBeNull()
  })

  it('is not listed when there is nothing to set up, one runs, or it was just declined', async () => {
    signIn(['sandbox::settings::manage'])
    const declined = { outcome: 'declined' as const, restart_windows: false, output: '' }
    for (const setup of [
      undefined,
      { running: false },
      { running: false, last: { outcome: 'done' as const, restart_windows: true, output: '' } },
      // One runs (here, from the agent, or from the app before it was closed).
      { offer: 'install' as const, running: true },
      // Declined a moment ago.
      { offer: 'install' as const, running: false, last: declined, retry_in_secs: 30 },
    ]) {
      await serverSays(setup)
      await openPalette()
      expect(screen.queryByTestId(ITEM)).toBeNull()
      act(() => closeCommandPalette())
      cleanup()
    }
  })
})
