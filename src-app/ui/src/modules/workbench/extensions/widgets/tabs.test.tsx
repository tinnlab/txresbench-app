// @vitest-environment jsdom
//
// TEST-12 (ITEM-16) — the generic `tabs` widget renders the ACTIVE tab's children, switches the
// active tab through a bound `$state` value, and is DOMAIN-FREE (a tab is a tab). Behaviour only;
// the "no domain nouns in source" half is the `lint:no-domain` gate's job, not a runtime assert.

import * as React from 'react'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import { installWidgets, __resetInstallWidgetsForTests } from './installWidgets'

function captureAction(id: string): { payloads: Record<string, unknown>[] } {
  const box = { payloads: [] as Record<string, unknown>[] }
  defineAction({
    id,
    title: id,
    permission: 'drafts::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async (params: unknown) => {
      box.payloads.push(params as Record<string, unknown>)
    },
  })
  return box
}

const spec = (onChange: string): WidgetSpec =>
  ({
    id: 'modes',
    kind: 'tabs',
    value: '$state.mode',
    onChange,
    tabs: [
      { id: 'a', label: 'First', children: [{ id: 'childA', kind: 'text', value: '$const.a' }] },
      { id: 'b', label: 'Second', children: [{ id: 'childB', kind: 'text', value: '$const.b' }] },
    ],
  }) as unknown as WidgetSpec

function mount(onChange: string, mode: string): void {
  const scope: Scope = {
    params: {},
    state: { mode },
    derived: {},
    const: { a: 'alpha', b: 'beta' },
    data: {},
  }
  render(<WidgetList specs={[spec(onChange)]} scope={scope} viewId="v" specId="t/spec" />)
}

beforeEach(() => {
  cleanup()
  __resetInstallWidgetsForTests()
  installWidgets()
})
afterEach(cleanup)

describe('tabs widget (ITEM-16)', () => {
  it('renders ONLY the active tab’s children', () => {
    mount('t/spec::noop', 'a')
    expect(screen.getByTestId('widget-childA')).toBeTruthy()
    expect(screen.queryByTestId('widget-childB')).toBeNull()
  })

  it('the active tab follows the bound $state value', () => {
    mount('t/spec::noop', 'b')
    expect(screen.getByTestId('widget-childB')).toBeTruthy()
    expect(screen.queryByTestId('widget-childA')).toBeNull()
  })

  it('renders one header button per tab, the active one selected', () => {
    mount('t/spec::noop', 'a')
    expect(screen.getByTestId('widget-modes-tab-a').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('widget-modes-tab-b').getAttribute('aria-selected')).toBe('false')
  })

  it('selecting a tab dispatches onChange with the tab id', () => {
    captureAction('t/spec::noop')
    const box = captureAction('t/spec::setMode')
    mount('t/spec::setMode', 'a')
    fireEvent.click(screen.getByTestId('widget-modes-tab-b'))
    expect(box.payloads.at(-1)?.value).toBe('b')
  })
})
