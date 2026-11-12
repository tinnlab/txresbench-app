// @vitest-environment jsdom
//
// The kit's own suite proves that a kit overlay HONOURS a portal container when one is provided
// (sdk/packages/kit/src/kit/portal-container.test.tsx). That leaves the half nobody was asserting:
// that anything actually PROVIDES one at the boundary where a second document is created.
//
// A fix nobody installs is indistinguishable from no fix, so this test drives the REAL boundary —
// `@txresbench/dock`'s `<ContainerWindows>`, the component `RegionPopoutWindows` renders for every
// popped-out pane — against a REAL second document, and asserts:
//
//   1. an overlay opened by content inside a popped-out window lands in THAT window's document;
//   2. it does NOT appear in the opener's document (the user-visible symptom: the tooltip renders
//      in the main window, invisible or mispositioned, while the popup shows nothing);
//   3. the popup document carries the opener's ROOT attributes — a portal that lands in the right
//      document but without the theme stamped on `<html>` is still a broken surface, because every
//      colour token in the kit is scoped to `html.dark` / `:root`.
//
// The popup window is an iframe: it is a genuinely separate document WITH a `defaultView`, which is
// the shape `window.open` hands `ContainerWindows`. Nothing here mocks the kit or the dock.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ContainerWindows,
  registerPopupWindow,
  unregisterPopupWindow,
  type ContainerId,
} from '@txresbench/dock'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@txresbench/kit/shadcn/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@txresbench/kit/shadcn/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@txresbench/kit/shadcn/dropdown-menu'
import {
  Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList,
} from '@txresbench/kit/shadcn/combobox'

function polyfill(scope: Window & typeof globalThis): void {
  const g = scope as unknown as Record<string, unknown>
  g.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (typeof g.PointerEvent !== 'function') g.PointerEvent = class extends scope.MouseEvent {}
  if (!g.CSS) g.CSS = { escape: (v: string) => v }
  if (!scope.matchMedia) {
    scope.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as never
  }
}

beforeAll(() => polyfill(globalThis as unknown as Window & typeof globalThis))

const CONTAINER = 'popup-1' as ContainerId

let root: Root | null = null
let frame: HTMLIFrameElement | null = null

/** Stand up a real second window and register it exactly as the pop-out gesture does. */
function openPopupWindow(): { doc: Document; win: Window } {
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) throw new Error('iframe produced no document — the two-document premise is void')
  polyfill(win as unknown as Window & typeof globalThis)
  registerPopupWindow(CONTAINER, win)
  return { doc, win }
}

function renderPoppedOut(content: React.ReactNode): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(
      <ContainerWindows
        containers={[CONTAINER]}
        renderContainer={() => content}
        onWindowClosed={() => {}}
        pendingClose={[]}
        onAcknowledgeClose={() => {}}
      />,
    )
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  unregisterPopupWindow(CONTAINER)
  frame?.remove()
  frame = null
  document.body.innerHTML = ''
  document.documentElement.className = ''
  document.documentElement.removeAttribute('data-theme')
})

describe('overlays opened inside a popped-out window', () => {
  it('a tooltip renders in the POPUP document, not the opener', () => {
    const { doc } = openPopupWindow()
    renderPoppedOut(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger render={<button type="button" />}>trigger</TooltipTrigger>
          <TooltipContent>hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    expect(doc.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(0)
  })

  it('a select popup renders in the POPUP document, with its options reachable there', () => {
    const { doc } = openPopupWindow()
    renderPoppedOut(
      <Select open>
        <SelectTrigger>pick</SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
          <SelectItem value="b">B</SelectItem>
        </SelectContent>
      </Select>,
    )

    expect(doc.querySelectorAll('[data-slot="select-content"]')).toHaveLength(1)
    // The options must be in the popup too — a popup whose list stayed behind is not usable.
    expect(doc.querySelectorAll('[role="option"]').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelectorAll('[data-slot="select-content"]')).toHaveLength(0)
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  // The workbench command palette is a Combobox (`WorkbenchCommandPalette`). It lives in the main
  // window's header today, so this is the guard against the tempting WRONG fix for its stacking
  // bug: portalling to a hardcoded `document.body`. That would look identical in the main window
  // and put the list in the OPENER whenever a Combobox is rendered in a popped-out pane.
  it('a combobox popup renders in the POPUP document, with its options reachable there', () => {
    const { doc } = openPopupWindow()
    const items = [
      { label: 'Add dataset', value: 'dataset.add' },
      { label: 'Open artifacts', value: 'workbench.openArtifacts' },
    ]
    renderPoppedOut(
      <Combobox items={items} open filter={null}>
        <ComboboxInput data-testid="cmd" placeholder="Search commands…" />
        <ComboboxContent>
          <ComboboxList data-testid="cmd-list">
            {(o: { label: string; value: string }) => (
              <ComboboxItem key={o.value} value={o} data-testid={`cmd-${o.value}`}>
                {o.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>,
    )

    expect(doc.querySelectorAll('[data-slot="combobox-content"]')).toHaveLength(1)
    expect(doc.querySelectorAll('[role="option"]').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelectorAll('[data-slot="combobox-content"]')).toHaveLength(0)
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  it('a dropdown menu renders in the POPUP document', () => {
    const { doc } = openPopupWindow()
    renderPoppedOut(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<button type="button" />}>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    expect(doc.querySelectorAll('[data-slot="dropdown-menu-content"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="dropdown-menu-content"]')).toHaveLength(0)
  })
})

describe('the popup document is styled like the opener', () => {
  it('mirrors the root attributes the theme is stamped on', () => {
    document.documentElement.classList.add('dark')
    document.documentElement.setAttribute('data-theme', 'dark')
    const { doc } = openPopupWindow()
    renderPoppedOut(<div data-testid="content" />)

    expect(doc.documentElement.classList.contains('dark')).toBe(true)
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('keeps them synced when the theme changes while the window is open', async () => {
    document.documentElement.classList.add('dark')
    const { doc } = openPopupWindow()
    renderPoppedOut(<div data-testid="content" />)
    expect(doc.documentElement.classList.contains('dark')).toBe(true)

    document.documentElement.classList.remove('dark')
    // MutationObserver callbacks are microtasks — let them drain.
    await act(async () => {
      await Promise.resolve()
    })
    expect(doc.documentElement.classList.contains('dark')).toBe(false)
  })

  it('does not strip the height the popup needs to fill its window', () => {
    // The opener's <html> carries no inline style, so a naive "make the popup's attributes equal
    // the opener's" would REMOVE the `height: 100%` ContainerWindows sets — collapsing the whole
    // workspace to zero height. That attribute is popup-owned.
    const { doc } = openPopupWindow()
    renderPoppedOut(<div data-testid="content" />)
    expect(doc.documentElement.style.height).toBe('100%')
    expect(doc.body.style.height).toBe('100%')
  })
})
