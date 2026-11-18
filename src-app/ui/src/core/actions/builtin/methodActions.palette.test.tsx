// @vitest-environment jsdom
/**
 * `methods.applyPreset` through the REAL command palette (the step-4 review:
 * the gating unit test in `methodActions.test.tsx` builds the gate deps by
 * hand). The palette's own permission read, context registry and instance
 * registry decide here: the action is listed only while a method picker is
 * mounted, and running it from the palette's param form changes the picker's
 * selection and pressed preset.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { setAuthView, type PermissionAuthView } from '@txresbench/framework/permissions'
import type { StoreProxy } from '@txresbench/framework/stores'
import type { TxrMethodCard } from '@/modules/txrlist/types'
import { TxrMethodPicker } from '@/modules/txrlist/components/TxrMethodPicker'
import { CommandPalette } from '@/modules/command-palette/CommandPalette'
import { closeCommandPalette, openCommandPalette } from '@/modules/command-palette/paletteState'
import './methodActions'
import './appActions'

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

/** One runnable card (the picker reads these facts). */
function card(id: string, group: TxrMethodCard['group'], groupLabel: string, seconds: number): TxrMethodCard {
  return {
    key: id,
    id,
    title: id,
    summary: `Summary of ${id}.`,
    paperTitle: null,
    group,
    groupLabel,
    language: 'R',
    journal: 'Fixture Journal',
    year: 2020,
    paperDoi: '10.0000/txr.demo',
    estimate: { seconds, quality: 'measured' },
    rank: null,
    needs: { markers: '1 marker', covariates: null, draws: '1+ draws' },
    run: {
      status: 'can',
      coverageLine: 'all 18 patients',
      reasonCode: null,
      reasonLine: 'all 18 patients',
      reasonLines: ['all 18 patients'],
      reasonFix: '',
      disabled: false,
    },
  }
}

/** Recommended = All = Fast (one per family, all under a minute). */
const CARDS: TxrMethodCard[] = [
  card('m1', 'response-call', 'Response call', 10),
  card('m2', 'static-risk', 'Static risk', 20),
  card('m3', 'dynamic-risk', 'Dynamic risk', 30),
]

function Picker() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['m1', 'm2', 'm3']))
  return (
    <TxrMethodPicker
      cards={CARDS}
      loading={false}
      error={null}
      onRetry={() => {}}
      selected={selected}
      onSelectionChange={setSelected}
      onChangeFiles={() => {}}
      onChangeSettings={() => {}}
    />
  )
}

beforeAll(() => {
  // The palette reads the signed-in user's permissions through the auth view
  // the app registers at start-up: a user holding `mcp::use` (the action's
  // permission), not an admin.
  const view: PermissionAuthView = { user: { id: 'u1', is_admin: false } as never, permissions: ['mcp::use'] }
  setAuthView({ ...view, $: view } as unknown as StoreProxy<PermissionAuthView>)
  const proto = Element.prototype as unknown as { scrollIntoView?: () => void }
  if (typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = () => {}
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver
  }
})

afterEach(() => {
  act(() => closeCommandPalette())
  cleanup()
})

describe('methods.applyPreset in the command palette', () => {
  it('is not listed when no method picker is mounted', async () => {
    render(<CommandPalette />)
    await act(async () => {
      openCommandPalette()
    })
    expect(screen.getByTestId('command-palette-item-app.navigate')).toBeTruthy()
    expect(screen.queryByTestId('command-palette-item-methods.applyPreset')).toBeNull()
  })

  it('is listed while the picker is mounted, and running it from the palette applies the preset', async () => {
    render(
      <>
        <Picker />
        <CommandPalette />
      </>,
    )
    const pressed = (): string[] =>
      (['recommended', 'all', 'fast', 'none'] as const).filter(
        value =>
          screen.getByTestId(`txr-method-preset-${value}`).getAttribute('aria-pressed') === 'true',
      )
    expect(pressed()).toEqual(['recommended'])

    await act(async () => {
      openCommandPalette()
    })
    const item = screen.getByTestId('command-palette-item-methods.applyPreset')
    expect(item.textContent).toContain('Choose a method preset')

    // Selecting it opens the param form; the palette supplies `view_id`
    // itself, so the only field is the preset.
    await act(async () => {
      fireEvent.click(item)
    })
    expect(screen.getByTestId('command-palette-param-form')).toBeTruthy()
    expect(screen.queryByTestId('command-palette-param-view_id')).toBeNull()
    await act(async () => {
      fireEvent.change(screen.getByTestId('command-palette-param-preset'), { target: { value: 'all' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('command-palette-run'))
    })
    expect(pressed()).toEqual(['all'])
  })
})
