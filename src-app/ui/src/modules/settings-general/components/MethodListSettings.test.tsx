// @vitest-environment jsdom
/**
 * The Settings > General "Methods" card (PR 5): "Method list #N, published …, last checked
 * …" and "Check for method updates", which runs the registered `methodList.checkForUpdates`
 * action (the palette and the AI agent run the same one).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodListStatus } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
})

vi.mock('@/core/permissions', () => ({ usePermission: () => true, hasPermissionNow: () => true }))

const api = vi.hoisted(() => ({ updates: vi.fn(), checkUpdates: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { MethodList: { updates: api.updates, checkUpdates: api.checkUpdates } },
}))

// The action registers on import (the settings-general module's side-effect import).
await import('@/core/actions/builtin/methodListActions')
const { getActionMeta } = await import('@/core/actions/defineAction')
const { MethodListSettings, methodListLines } = await import('./MethodListSettings')
const { __resetMethodListRevisionForTests } = await import('@/lib/txr-method-list/revision')

function status(over: Partial<MethodListStatus> = {}): MethodListStatus {
  return {
    sequence: 3,
    origin: 'live',
    assembled_at: '2026-11-20T10:00:00Z',
    updates_enabled: true,
    last_check: 'current',
    last_checked_at: '2026-11-21T09:30:00Z',
    ...over,
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  api.updates.mockReset()
  api.checkUpdates.mockReset()
  __resetMethodListRevisionForTests()
})

afterEach(() => {
  cleanup()
})

describe('methodListLines', () => {
  it('names the list, when it was published, when it was checked and what the check found', () => {
    const { title, detail } = methodListLines(status())
    expect(title).toBe('Method list #3')
    expect(detail).toMatch(/^Published .*2026, last checked .*2026.*\. It is up to date\.$/)
  })

  it('the built-in copy, a check not made yet, a problem, demo mode', () => {
    expect(methodListLines(status({ sequence: 0, last_checked_at: undefined, last_check: 'not_checked' })).detail).toBe(
      'Built into this app, not checked yet',
    )
    const unreachable = methodListLines(
      status({ last_check: 'unreachable', last_error: 'The method list could not be reached.' }),
    )
    expect(unreachable.detail.endsWith('. The method list could not be reached.')).toBe(true)
    expect(methodListLines(status({ updates_enabled: false, last_check: 'off' })).detail).toMatch(
      /updates are off in this demo$/,
    )
    expect(methodListLines(null).title).toBe('Method list')
  })
})

describe('MethodListSettings', () => {
  it('the check is a registered action gated on projects::use', () => {
    const meta = getActionMeta('methodList.checkForUpdates')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.ProjectsUse)
    expect(meta?.kind).toBe('global')
  })

  it('shows the list in use and the button runs the check through the action', async () => {
    api.updates.mockResolvedValue(status())
    api.checkUpdates.mockResolvedValue(
      status({ sequence: 4, last_check: 'updated', assembled_at: '2026-11-22T10:00:00Z' }),
    )
    render(<MethodListSettings />)
    await settle()
    expect(screen.getByTestId('settingsgen-method-list-title').textContent).toBe('Method list #3')
    await act(async () => {
      fireEvent.click(screen.getByTestId('settingsgen-method-list-check'))
    })
    await settle()
    expect(api.checkUpdates).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('settingsgen-method-list-title').textContent).toBe('Method list #4')
    expect(screen.getByTestId('settingsgen-method-list-detail').textContent).toContain(
      'your next run uses it',
    )
  })
})
