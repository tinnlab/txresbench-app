// @vitest-environment jsdom
//
// A ROW'S REVOKE BUTTON MUST KEEP ITS NAME WHILE THE DIALOG IS BUSY.
//
// The revoke affordance is a bare bin icon repeated once per row, so its TOOLTIP is the only
// thing that tells twelve otherwise-identical rows apart for a sighted user — `Remove access
// for <principal>`. It goes inert while a share mutation is in flight.
//
// It used to do that with native `disabled`, and a natively `disabled` button can open NO React
// tooltip at all (pointer-events:none, and its mouse events never reach the document root where
// React delegates). So for the length of every request, every row's only visible identity
// disappeared — and it dropped out of the tab order too.
//
// The prior judgement on this site was "a transient global busy is not a per-row reason, so
// there is nothing extra to explain". The first half is right; the conclusion is not, because
// what native `disabled` withheld here was not a REASON, it was the NAME. Its own sibling in the
// same dialog, on the same `mutating` flag, already uses the kit's `loading` (aria-disabled +
// aria-busy, still hoverable and focusable) — the file was reading one flag two ways.
//
// Asserted on the DOM after a real hover, never on a console spy: base-ui dedupes its warnings
// process-wide, so a spy passes for the wrong reason.

import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

afterEach(() => {
  cleanup()
  store.mutating = false
  store.unshareDataset.mockClear()
})

const { ShareDialog } = await import('./ShareDialog')

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no element with data-testid="${id}"`)
  return el
}

async function hoverText(el: Element): Promise<string> {
  await act(async () => {
    fireEvent.pointerEnter(el, { pointerType: 'mouse', bubbles: true })
    fireEvent.mouseOver(el, { bubbles: true })
    fireEvent.mouseEnter(el, { bubbles: true })
    fireEvent.mouseMove(el, { bubbles: true })
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 700))
  })
  return Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .map(t => (t.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join('|')
}

async function mount(): Promise<void> {
  await act(async () => {
    render(<ShareDialog />)
  })
}

describe('the share dialog’s per-row revoke, while a mutation is in flight', () => {
  it('still says WHICH row it removes — the half native `disabled` destroyed', async () => {
    store.mutating = true
    await mount()
    expect(
      await hoverText(byTestId('dataset-share-remove-s1')),
      'a bare bin icon whose hover text is gone is indistinguishable from every other row',
    ).toBe('Remove access for alice')
  })

  // The first row is the one HOVERED above for a reason recorded rather than hidden: in jsdom,
  // hovering the SECOND tooltip trigger inside a kit <Dialog> opens the FIRST one as well.
  // Measured to be PRE-EXISTING and unrelated to this change — it reproduces identically with
  // two plain, fully-live kit Buttons in a Dialog, and not at all outside one (every rect is
  // 0×0 in jsdom, so base-ui's "which trigger is under the pointer" degenerates). Rather than
  // hover into that artifact, the per-row DISTINCTNESS — the property the hover text exists for
  // — is asserted directly on the names.
  it('names each row separately, so twelve identical bins stay distinguishable', async () => {
    store.mutating = true
    await mount()
    expect(byTestId('dataset-share-remove-s1').getAttribute('aria-label')).toBe('Remove access for alice')
    expect(byTestId('dataset-share-remove-s2').getAttribute('aria-label')).toBe('Remove access for bob')
  })

  it('is announced busy and stays a tab stop', async () => {
    store.mutating = true
    await mount()
    const el = byTestId('dataset-share-remove-s1')
    expect(el.getAttribute('aria-disabled')).toBe('true')
    expect(el.getAttribute('aria-busy')).toBe('true')
    expect(el.hasAttribute('disabled'), 'native disabled would remove it from the tab order').toBe(false)
  })

  it('refuses the click anyway — inert is the point, unreachable was the cost', async () => {
    store.mutating = true
    await mount()
    fireEvent.click(byTestId('dataset-share-remove-s1'))
    expect(store.unshareDataset, 'a second revoke must not fire while one is in flight').not.toHaveBeenCalled()
  })

  it('is a live control when nothing is in flight', async () => {
    await mount()
    const el = byTestId('dataset-share-remove-s1')
    expect(el.getAttribute('aria-disabled')).toBeNull()
    expect(await hoverText(el)).toBe('Remove access for alice')
    fireEvent.click(el)
    expect(store.unshareDataset).toHaveBeenCalled()
  })
})
