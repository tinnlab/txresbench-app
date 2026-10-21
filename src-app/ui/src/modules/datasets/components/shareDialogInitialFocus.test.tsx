// @vitest-environment jsdom
//
// THE SHARE DIALOG OPENED WITH A DESTRUCTIVE CONTROL FOCUSED.
//
// Base UI's Dialog moves focus to the FIRST TABBABLE element in the popup, which is a DOM-ORDER
// rule. This dialog renders "People with access" ABOVE the share form, so once shares exist the
// first tabbable is a per-row bin — "Remove access for <principal>" — and the dialog opens with a
// destructive action focused and one Enter away.
//
// IT READS AS FINE TODAY ONLY BECAUSE THE SHARES LOAD ASYNCHRONOUSLY. At the instant the dialog
// mounts, `sharesLoading` is true and the list is a spinner, so the first tabbable is the role
// Select; by the time the rows arrive, focus has already been placed. That is TIMING, not design —
// a cached store, a synchronous re-render, or simply a faster response flips it. This file
// therefore mounts with the shares ALREADY PRESENT, which is the state the race can land in and
// the one no test covered.
//
// It was found while DISPROVING a suspected tooltip bug: the "already-open tooltip" in this dialog
// turned out to be this same bin taking programmatic focus, which reports `:focus-visible`.
//
// The remedy is in the kit (`Dialog.initialFocus` + a guarded default that skips
// `data-destructive`), so this file asserts the CONSUMER end of it: that this dialog declares
// where focus goes, and that its bin is declared destructive so the guard covers it even if the
// declaration is ever removed. Oracle: `document.activeElement`.

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const store = {
  shareTarget: { id: 'ds-1', name: 'Cohort A' },
  shares: [
    { id: 's1', principal_id: 'alice', principal_type: 'user', role: 'view' },
    { id: 's2', principal_id: 'bob', principal_type: 'user', role: 'edit' },
  ],
  sharesLoading: false,
  mutating: false,
  closeShare: vi.fn(),
  shareDataset: vi.fn(async () => {}),
  unshareDataset: vi.fn(async () => {}),
}
vi.mock('@/modules/datasets/stores/Datasets.store', () => ({ Datasets: store }))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

const { ShareDialog } = await import('./ShareDialog')

afterEach(cleanup)
beforeEach(() => {
  store.sharesLoading = false
})

async function open(): Promise<void> {
  await act(async () => { render(<ShareDialog />) })
  await act(async () => { await new Promise(r => setTimeout(r, 80)) })
}

const focused = (): string | null => document.activeElement?.getAttribute('data-testid') ?? null

describe('ShareDialog initial focus', () => {
  it('WITH SHARES ALREADY LOADED, focus is NOT on a row Remove — the state the race can land in', async () => {
    await open()
    expect(document.querySelector('[data-testid="dataset-share-remove-s1"]'), 'the fixture must actually render the rows, or this proves nothing').not.toBeNull()
    expect(focused()).not.toBe('dataset-share-remove-s1')
    expect(focused()).not.toBe('dataset-share-remove-s2')
  })

  it('focus lands where the dialog DECLARES it — the field the user came to fill in', async () => {
    await open()
    expect(focused()).toBe('dataset-share-principal')
  })

  it('the row Remove is DECLARED destructive, so the kit guard covers it independently', async () => {
    // Belt and braces on purpose: the declaration above is the intent, and this marker is what
    // keeps the dialog safe if some future edit drops or mistypes that declaration.
    await open()
    const bin = document.querySelector('[data-testid="dataset-share-remove-s1"]')
    expect(bin?.getAttribute('data-destructive')).toBe('true')
  })

  it('NEGATIVE CONTROL — with shares still LOADING, focus is still the declared field', async () => {
    // This is the state that made the bug invisible. It must not be the state the fix depends on.
    store.sharesLoading = true
    await open()
    expect(focused()).toBe('dataset-share-principal')
  })
})
