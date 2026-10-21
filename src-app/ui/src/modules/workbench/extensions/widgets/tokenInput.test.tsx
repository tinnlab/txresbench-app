// @vitest-environment jsdom
//
// TEST-13 (ITEM-17) — the generic `token-input` widget renders its bound `$state` array as chips,
// adds a free-text token (Enter), removes a chip, and dispatches the whole new array. Generic (a
// token list, no domain noun) — the source-level "no domain noun" half is the lint gate's job.

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
  ({ id: 'toks', kind: 'token-input', label: 'Tokens', value: '$state.toks', onChange }) as unknown as WidgetSpec

function mount(onChange: string, toks: unknown[]): void {
  const scope: Scope = { params: {}, state: { toks }, derived: {}, const: {}, data: {} }
  render(<WidgetList specs={[spec(onChange)]} scope={scope} viewId="v" specId="t/spec" />)
}

beforeEach(() => {
  cleanup()
  __resetInstallWidgetsForTests()
  installWidgets()
})
afterEach(cleanup)

describe('token-input widget (ITEM-17)', () => {
  it('renders one chip per bound token', () => {
    mount('t/spec::noop', ['AAA', 'BBB'])
    expect(screen.getByTestId('widget-toks-chip-0').textContent).toContain('AAA')
    expect(screen.getByTestId('widget-toks-chip-1').textContent).toContain('BBB')
  })

  it('Enter adds a trimmed token, dispatching the whole new array', () => {
    const box = captureAction('t/spec::add1')
    mount('t/spec::add1', ['AAA'])
    const input = screen.getByTestId('widget-toks-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  CCC  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(box.payloads.at(-1)?.value).toEqual(['AAA', 'CCC'])
  })

  it('does not add a duplicate token', () => {
    const box = captureAction('t/spec::add2')
    mount('t/spec::add2', ['AAA'])
    const input = screen.getByTestId('widget-toks-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'AAA' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(box.payloads.length).toBe(0)
  })

  it('removing a chip dispatches the array without it', () => {
    const box = captureAction('t/spec::rm')
    mount('t/spec::rm', ['AAA', 'BBB'])
    fireEvent.click(screen.getByTestId('widget-toks-remove-0'))
    expect(box.payloads.at(-1)?.value).toEqual(['BBB'])
  })
})
