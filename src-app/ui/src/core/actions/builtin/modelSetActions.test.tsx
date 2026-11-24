// @vitest-environment jsdom
/**
 * The model-set actions (`./modelSetActions.ts`) — the registered wrappers
 * the Models page buttons, the saved-models section actions and the AI
 * agent share:
 *
 * - `models.renameSet` runs the ONE `renameSetById` call (the dialog's
 *   path) and publishes the refresh bus — the mounted Models page re-reads
 *   the inventory + sets;
 * - `models.exportSet` runs `downloadSetExport` (the same function the
 *   button path uses) — the set's name is resolved from the provider first;
 * - `models.deleteSet` OPENS the delete confirm dialog for the set and does
 *   NOT call the API: the person confirms in the dialog, and only then is
 *   `deleteSet` called (with `keep_files: false`, DEC-14). When NO mounted
 *   page could open the dialog (no host, or the set unknown / no data yet)
 *   the action REJECTS with the one line — never a success report for a
 *   confirm nobody showed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ModelListResponse, ModelSetListResponse } from '@/api-client/types'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import { TXRMODELS_J_RESPONSE, TXRMODELS_MODEL_SET_LIST } from '@/modules/txrmodels/fixtures'
import { ModelsPage } from '@/modules/txrmodels/pages/ModelsPage'
import './modelSetActions'
import { RouterBridge } from '@/core/actions/navigateBridge'

// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Button) construct one on pointer interaction. A MouseEvent subclass
// is the standard jsdom stand-in (the sibling suites' shim, copied).
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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  listSets: vi.fn(),
  renameSet: vi.fn(),
  deleteSet: vi.fn(),
  exportSet: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Models: {
      listModels: api.listModels,
    },
    ModelSets: {
      listSets: api.listSets,
      renameSet: api.renameSet,
      deleteSet: api.deleteSet,
      exportSet: api.exportSet,
    },
  },
}))

// ── jsdom download stubs (the export's blob + anchor path) ────────────────
const createObjectURL = vi.fn((_blob: Blob) => 'blob:txr-model-set-actions-test')
const revokeObjectURL = vi.fn((url: string) => {})
const clickSpy = vi.fn()

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/models']}>
      <RouterBridge />
      <ModelsPage />
    </MemoryRouter>,
  )
}

/** Flush the pending microtasks (the mount fetch + the bus-refresh fetch). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listModels.mockResolvedValue(TXRMODELS_J_RESPONSE as ModelListResponse)
  api.listSets.mockResolvedValue(TXRMODELS_MODEL_SET_LIST as ModelSetListResponse)
  api.renameSet.mockResolvedValue(TXRMODELS_MODEL_SET_LIST.sets[0])
  api.deleteSet.mockResolvedValue(undefined)
  api.exportSet.mockResolvedValue(new Blob(['txr-set-bytes']))
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  clickSpy.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    value: clickSpy,
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('models.renameSet', () => {
  it('is registered: McpUse, mutating, global, both surfaces', () => {
    const meta = getActionMeta('models.renameSet')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('renames through the one lib call and publishes the refresh bus: the mounted page re-reads', async () => {
    renderPage()
    await settle()
    expect(api.renameSet).not.toHaveBeenCalled()
    await runAction('models.renameSet', { setId: 'set-a', name: 'CRC cohort, day 60 (v2)' })
    expect(api.renameSet).toHaveBeenCalledWith({ id: 'set-a', name: 'CRC cohort, day 60 (v2)' })
    // The bus re-reads both of the page's reads (no dialog onSaved here).
    await settle()
    expect(api.listModels.mock.calls.length).toBe(2)
    expect(api.listSets.mock.calls.length).toBe(2)
  })

  it('refuses an empty name (the params schema)', async () => {
    await expect(
      runAction('models.renameSet', { setId: 'set-a', name: '' }),
    ).rejects.toThrow(/invalid params/)
    expect(api.renameSet).not.toHaveBeenCalled()
  })
})

describe('models.exportSet', () => {
  it('is registered: McpUse, non-mutating, both surfaces', () => {
    const meta = getActionMeta('models.exportSet')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(false)
    expect(meta?.kind).toBe('global')
  })

  it('runs downloadSetExport: resolves the name from the provider and saves <name>.txr', async () => {
    renderPage()
    await settle()
    const createElement = vi.spyOn(document, 'createElement')
    await runAction('models.exportSet', { setId: 'set-a' })
    expect(api.listSets).toHaveBeenCalledTimes(2)
    expect(api.exportSet).toHaveBeenCalledWith({ id: 'set-a' })
    const anchor = createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('CRC-cohort-day-60.txr')
    createElement.mockRestore()
  })

  it('refuses a set the provider no longer lists (a stale id)', async () => {
    renderPage()
    await settle()
    api.listSets.mockResolvedValue({ ...TXRMODELS_MODEL_SET_LIST, sets: [] })
    await expect(runAction('models.exportSet', { setId: 'set-a' })).rejects.toThrow(
      'The set could not be exported.',
    )
    expect(api.exportSet).not.toHaveBeenCalled()
  })
})

describe('models.deleteSet', () => {
  it('is registered: McpUse, mutating, dangerous, both surfaces', () => {
    const meta = getActionMeta('models.deleteSet')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    // Destructive intent: the palette interposes its own confirmation
    // before invoking this action (`ActionMeta.dangerous`).
    expect(meta?.dangerous).toBe(true)
    expect(meta?.kind).toBe('global')
  })

  it('opens the delete confirm dialog and does NOT call the API until confirmed', async () => {
    renderPage()
    await settle()
    await act(async () => {
      await runAction('models.deleteSet', { setId: 'set-a' })
    })
    // The dialog is open (the Models page answered the request channel)…
    expect(screen.getByTestId('txr-models-set-delete-set-a')).toBeTruthy()
    // …and nothing was deleted yet.
    expect(api.deleteSet).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-set-a-confirm'))
      await Promise.resolve()
    })
    await settle()
    expect(api.deleteSet).toHaveBeenCalledWith({ id: 'set-a', keep_files: false })
  })

  it('rejects when NO mounted page could open the dialog (it never reports a confirm nobody showed)', async () => {
    // Nothing is rendered: the request channel has no listener at all.
    await expect(runAction('models.deleteSet', { setId: 'set-a' })).rejects.toThrow(
      'The delete confirmation could not be opened: open the Models page first.',
    )
    expect(api.deleteSet).not.toHaveBeenCalled()
  })

  it('rejects when the mounted page cannot resolve the set (the listener declines)', async () => {
    renderPage()
    await settle()
    // The page is mounted but this id is in no section/set: its listener
    // answers false — the action must reject rather than report success.
    await expect(runAction('models.deleteSet', { setId: 'no-such-set' })).rejects.toThrow(
      'The delete confirmation could not be opened: open the Models page first.',
    )
    expect(screen.queryByTestId('txr-models-set-delete-no-such-set')).toBeNull()
    expect(api.deleteSet).not.toHaveBeenCalled()
  })
})
