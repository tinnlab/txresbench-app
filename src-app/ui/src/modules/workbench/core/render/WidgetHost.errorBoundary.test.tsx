// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import * as React from 'react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { registerWidget, __clearWidgetsForTests } from './registry'
import { WidgetList, widgetDisplayName } from './WidgetHost'
import type { Scope } from '@/modules/workbench/core/runtime/expr'

// TEST (finding #7) — a single throwing widget/binding degrades to a compact inline
// placeholder (WidgetErrorBoundary) instead of crashing the whole fanned region: the
// sibling widgets keep rendering.

beforeEach(() => {
  __clearWidgetsForTests()
  cleanup()
  // Register a renderer that throws + a healthy one.
  registerWidget('boom', () => {
    throw new Error('widget exploded')
  })
  registerWidget('ok', spec => (
    <div data-testid={`ok-${(spec as { id?: string }).id}`}>healthy</div>
  ))
})

afterEach(() => {
  __clearWidgetsForTests()
})

const scope: Scope = { params: {}, state: {}, derived: {}, const: {}, data: {} }

describe('WidgetHost error isolation (finding #7)', () => {
  it('isolates a throwing widget to a placeholder; siblings still render', () => {
    // React logs the caught error to console.error — silence it for a clean run.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const specs: WidgetSpec[] = [
      { id: 'good1', kind: 'ok' } as unknown as WidgetSpec,
      { id: 'bad', kind: 'boom' } as unknown as WidgetSpec,
      { id: 'good2', kind: 'ok' } as unknown as WidgetSpec,
    ]

    render(<WidgetList specs={specs} scope={scope} viewId="v" specId="s" />)

    // The healthy siblings rendered.
    expect(screen.queryByTestId('ok-good1')).not.toBeNull()
    expect(screen.queryByTestId('ok-good2')).not.toBeNull()
    // The bad widget degraded to the inline error placeholder — not a blank region.
    expect(screen.queryByTestId('widget-error-bad')).not.toBeNull()

    errSpy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// declarative-rendering-hardening Slice 2 (F7 / F8) — the boundary must LATCH.
//
// The reset key used to be the render `scope` OBJECT, and `DeclarativeRegion` rebuilds a
// fresh scope literal on EVERY render — so the boundary cleared its error every single
// render, re-rendered the throwing child, and re-threw + re-logged forever. These tests pin
// the fix: the key is a PRIMITIVE (the store's `dataRevision`), and the placeholder NAMES
// the widget and offers a Retry (the user-driven half of the latch).
// ─────────────────────────────────────────────────────────────────────────────

describe('WidgetErrorBoundary latching (F7) + named placeholder with retry (F8)', () => {
  /** A renderer that throws until `armed` is flipped off — lets a test prove whether the
   *  boundary actually RE-INVOKED the renderer, which a "placeholder still visible" check
   *  alone cannot. */
  function installFlakyWidget() {
    const calls = { n: 0 }
    const state = { armed: true }
    registerWidget('flaky', spec => {
      calls.n += 1
      if (state.armed) throw new Error('widget exploded')
      return <div data-testid={`recovered-${(spec as { id?: string }).id}`}>recovered</div>
    })
    return { calls, state }
  }

  const flakySpecs: WidgetSpec[] = [
    { id: 'bad', kind: 'flaky', label: 'Column picker' } as unknown as WidgetSpec,
  ]

  // TEST-7 — the acceptance test for INV-2.
  it('a NEW scope object with an UNCHANGED resetKey does NOT reset the boundary', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls, state } = installFlakyWidget()

    const { rerender } = render(
      <WidgetList specs={flakySpecs} scope={{ ...scope }} viewId="v" specId="s" resetKey={7} />,
    )
    expect(screen.queryByTestId('widget-error-bad')).not.toBeNull()
    const afterFirst = calls.n

    // Exactly what DeclarativeRegion does on every store-revision render: a brand-new scope
    // literal, same data revision. Under the old identity-keyed reset this cleared the error
    // and re-invoked (and re-threw) the renderer.
    state.armed = false
    for (let i = 0; i < 3; i++) {
      rerender(<WidgetList specs={flakySpecs} scope={{ ...scope }} viewId="v" specId="s" resetKey={7} />)
    }
    expect(calls.n).toBe(afterFirst) // the renderer was NOT re-invoked — the latch held.
    expect(screen.queryByTestId('widget-error-bad')).not.toBeNull()
    expect(screen.queryByTestId('recovered-bad')).toBeNull()

    // …and bumping the DATA revision (corrected data arrived) DOES reset it.
    rerender(<WidgetList specs={flakySpecs} scope={{ ...scope }} viewId="v" specId="s" resetKey={8} />)
    expect(calls.n).toBeGreaterThan(afterFirst)
    expect(screen.queryByTestId('recovered-bad')).not.toBeNull()
    expect(screen.queryByTestId('widget-error-bad')).toBeNull()

    errSpy.mockRestore()
  })

  // TEST-8 — the signal reaches NESTED children (a `group`'s widgets).
  it('resetKey is forwarded through renderChildren, so a nested widget latches + resets too', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls, state } = installFlakyWidget()
    registerWidget('grp', (spec, ctx) => (
      <div data-testid={`grp-${(spec as { id?: string }).id}`}>
        {ctx.renderChildren((spec as { children?: WidgetSpec[] }).children ?? [], ctx.scope)}
      </div>
    ))

    const nested: WidgetSpec[] = [
      {
        id: 'row',
        kind: 'grp',
        children: [{ id: 'nested-bad', kind: 'flaky', label: 'Min' }],
      } as unknown as WidgetSpec,
    ]

    const { rerender } = render(
      <WidgetList specs={nested} scope={{ ...scope }} viewId="v" specId="s" resetKey={1} />,
    )
    expect(screen.queryByTestId('widget-error-nested-bad')).not.toBeNull()
    const afterFirst = calls.n

    state.armed = false
    rerender(<WidgetList specs={nested} scope={{ ...scope }} viewId="v" specId="s" resetKey={1} />)
    expect(calls.n).toBe(afterFirst) // latched inside the group too

    rerender(<WidgetList specs={nested} scope={{ ...scope }} viewId="v" specId="s" resetKey={2} />)
    expect(screen.queryByTestId('recovered-nested-bad')).not.toBeNull()

    errSpy.mockRestore()
  })

  // TEST-9 — the acceptance test for INV-4.
  it('the placeholder NAMES the widget (label → id → kind) and its Retry recovers it', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { state } = installFlakyWidget()

    render(<WidgetList specs={flakySpecs} scope={{ ...scope }} viewId="v" specId="s" resetKey={1} />)
    const box = screen.getByTestId('widget-error-bad')
    // Named, not the old generic "Widget failed to render".
    // The exact interpolated sentence, so a dropped name/kind fails rather than a
    // substring that the Retry label alone would satisfy.
    expect(box.textContent).toContain('"Column picker" (flaky) failed to render')

    // Retry is the user-driven half of the latch (DEC-5): a RENDER failure is not fixed by
    // re-fetching, so the button clears the error and re-renders in place.
    state.armed = false
    fireEvent.click(screen.getByTestId('widget-error-retry-bad'))
    expect(screen.queryByTestId('recovered-bad')).not.toBeNull()
    expect(screen.queryByTestId('widget-error-bad')).toBeNull()

    errSpy.mockRestore()
  })

  it('widgetDisplayName falls back id → kind, and never prints a $-ref label verbatim', () => {
    expect(widgetDisplayName({ label: 'Min', id: 'critMin', kind: 'text' })).toBe('Min')
    expect(widgetDisplayName({ id: 'critMin', kind: 'text' })).toBe('critMin')
    expect(widgetDisplayName({ kind: 'text' })).toBe('text')
    expect(widgetDisplayName({ label: '$c.column', id: 'critMin', kind: 'text' })).toBe('critMin')
    expect(widgetDisplayName(undefined)).toBe('widget')
  })
})
