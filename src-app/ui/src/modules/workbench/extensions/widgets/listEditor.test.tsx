// @vitest-environment jsdom
//
// TEST-14 (ITEM-18) — the ACTIVATED/EXTENDED `list-editor` in CARD mode renders an editable array
// of `group`-of-children over a `$state` array of OBJECTS, scoping each card by `$item`/`$index`,
// and add/remove dispatch the declared actions. (The FLAT string[] mode is unchanged.)

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

const cardSpec = (setField: string, add: string, remove: string): WidgetSpec =>
  ({
    id: 'cards',
    kind: 'list-editor',
    items: '$state.rows',
    add,
    remove,
    item: {
      children: [
        {
          id: 'nm',
          kind: 'text',
          value: '$item.name',
          onChange: setField,
          args: { key: 'name', index: '$index' },
        },
      ],
    },
  }) as unknown as WidgetSpec

function mount(spec: WidgetSpec, rows: unknown[]): void {
  const scope: Scope = { params: {}, state: { rows }, derived: {}, const: {}, data: {} }
  render(<WidgetList specs={[spec]} scope={scope} viewId="v" specId="t/spec" />)
}

beforeEach(() => {
  cleanup()
  __resetInstallWidgetsForTests()
  installWidgets()
})
afterEach(cleanup)

describe('list-editor CARD mode (ITEM-18)', () => {
  it('renders one card per array element, each child scoped to its $item', () => {
    mount(cardSpec('t/spec::sf', 't/spec::add', 't/spec::rm'), [{ name: 'Alpha' }, { name: 'Beta' }])
    expect(screen.getByTestId('widget-cards-item-0')).toBeTruthy()
    expect(screen.getByTestId('widget-cards-item-1')).toBeTruthy()
    // The child text in card 1 shows $item.name === 'Beta' — proves per-item scope.
    const input1 = screen.getByTestId('widget-cards-item-1').querySelector('input') as HTMLInputElement
    expect(input1.value).toBe('Beta')
  })

  it('editing a card child dispatches the field with its $index', () => {
    const box = captureAction('t/spec::sf')
    captureAction('t/spec::add')
    captureAction('t/spec::rm')
    mount(cardSpec('t/spec::sf', 't/spec::add', 't/spec::rm'), [{ name: 'Alpha' }, { name: 'Beta' }])
    const input1 = screen.getByTestId('widget-cards-item-1').querySelector('input') as HTMLInputElement
    fireEvent.change(input1, { target: { value: 'Bravo' } })
    const last = box.payloads.at(-1)
    expect(last?.index).toBe(1)
    expect(last?.key).toBe('name')
    expect(last?.value).toBe('Bravo')
  })

  it('add dispatches the add action; remove dispatches with the card index', () => {
    captureAction('t/spec::sf2')
    const addBox = captureAction('t/spec::add2')
    const rmBox = captureAction('t/spec::rm2')
    mount(cardSpec('t/spec::sf2', 't/spec::add2', 't/spec::rm2'), [{ name: 'Alpha' }])
    fireEvent.click(screen.getByTestId('widget-cards-add'))
    expect(addBox.payloads.length).toBe(1)
    fireEvent.click(screen.getByTestId('widget-cards-remove-0'))
    expect(rmBox.payloads.at(-1)?.index).toBe(0)
  })
})
