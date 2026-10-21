// TEST-6 [covers ITEM-6] — the actor-id resolver renders human names, and NEVER a
// bare UUID: an unresolvable id gets a labeled short form.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getMock = vi.fn()
vi.mock('@/api-client', () => ({ ApiClient: { User: { get: (...a: unknown[]) => getMock(...a) } } }))

const { BillingUserDirectory, useBillingUserDirectoryStore, nameFor, shortActorLabel } =
  await import('./userDirectory')

const UUID = '3f2a1b9c-0000-4000-8000-000000000001'

beforeEach(() => {
  getMock.mockReset()
  useBillingUserDirectoryStore.setState({ names: {}, pending: {} } as never)
})
afterEach(() => vi.clearAllMocks())

describe('TEST-6 — userDirectory resolver', () => {
  it('resolves a known id to its display name (preferring display_name)', async () => {
    getMock.mockResolvedValue({ id: UUID, username: 'ada', display_name: 'Ada Lovelace' })
    await BillingUserDirectory.resolve(UUID)
    expect(nameFor(useBillingUserDirectoryStore.getState().names, UUID)).toBe('Ada Lovelace')
  })

  it('falls back to username when display_name is absent', async () => {
    getMock.mockResolvedValue({ id: UUID, username: 'aturing' })
    await BillingUserDirectory.resolve(UUID)
    expect(nameFor(useBillingUserDirectoryStore.getState().names, UUID)).toBe('aturing')
  })

  it('renders a labeled short form (never the raw UUID) when resolution fails', async () => {
    getMock.mockRejectedValue(new Error('403'))
    await BillingUserDirectory.resolve(UUID)
    const label = nameFor(useBillingUserDirectoryStore.getState().names, UUID)
    expect(label).toBe(shortActorLabel(UUID))
    expect(label).not.toBe(UUID)
    expect(label).not.toContain('-') // not the raw uuid
  })

  it('nameFor returns a labeled short form for an unresolved id, not the UUID', () => {
    const label = nameFor({}, UUID)
    expect(label).not.toBe(UUID)
    expect(label.startsWith('admin ·')).toBe(true)
  })

  it('nameFor returns a dash for an empty id', () => {
    expect(nameFor({}, undefined)).toBe('—')
  })

  it('de-dupes concurrent resolves (one User.get per id)', async () => {
    getMock.mockResolvedValue({ id: UUID, username: 'ada', display_name: 'Ada Lovelace' })
    await Promise.all([BillingUserDirectory.resolve(UUID), BillingUserDirectory.resolve(UUID)])
    expect(getMock).toHaveBeenCalledTimes(1)
  })
})
