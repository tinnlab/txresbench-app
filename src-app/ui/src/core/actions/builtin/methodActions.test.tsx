// @vitest-environment jsdom
/**
 * `methods.applyPreset` (the step-4 fix: the method presets as a registered
 * action). The definition's metadata, and the action driven the way the
 * engine and the palette drive it, against a mounted `TxrMethodPicker`:
 *
 * - the mounted picker joins the instance registry under
 *   `txr.method-picker` and makes that context active; unmounting undoes
 *   both, so the engine's context guard then rejects the invoke;
 * - `runAction` (the call the engine's dispatch and the palette make) changes
 *   the selection and the pressed preset button, exactly like a click;
 * - the snapshot (`view.describe`) carries the preset, the counts and a
 *   `_state_token` that moves on every selection change (a human tick too);
 * - the palette offers it against the live picker (its `view_id`);
 * - a gone picker is NOT_FOUND.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { TxrMethodCard } from '@/modules/txrlist/types'
import { TxrMethodPicker } from '@/modules/txrlist/components/TxrMethodPicker'
import './methodActions'
import './worldModel'
import { getActionMeta, runAction } from '../defineAction'
import { isContextActive } from '../activeContext'
import { instancesOfType } from '../instanceRegistry'
import { checkContextGuard } from '../engine'
import { gateAction } from '@/modules/command-palette/paletteGating'

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

/** Recommended = All = Fast here (one per family, all under a minute). */
const CARDS: TxrMethodCard[] = [
  card('m1', 'response-call', 'Response call', 10),
  card('m2', 'static-risk', 'Static risk', 20),
  card('m3', 'dynamic-risk', 'Dynamic risk', 30),
]

function Host() {
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

/** The mounted picker's view_id (the one live instance of its type). */
function liveViewId(): string {
  const live = instancesOfType('txr.method-picker')
  expect(live.length).toBe(1)
  return live[0].id
}

const pressed = (): string[] =>
  (['recommended', 'all', 'fast', 'none'] as const).filter(
    value => screen.getByTestId(`txr-method-preset-${value}`).getAttribute('aria-pressed') === 'true',
  )

afterEach(() => {
  cleanup()
})

describe('methods.applyPreset (step-4 fix)', () => {
  it('is a permissioned, mutating instance action scoped to the picker context', () => {
    const meta = getActionMeta('methods.applyPreset')
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe('mcp::use')
    expect(meta?.kind).toBe('instance')
    expect(meta?.mutating).toBe(true)
    expect(meta?.stateful).toBe(false)
    expect(meta?.context).toBe('txr.method-picker')
    expect(meta?.group).toBe('Analysis')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('the mounted picker is a live instance with its context active; unmounting removes both', () => {
    const frame = { type: 'agent_invoke' as const, request_id: 'r1', action_id: 'methods.applyPreset', params: {} }
    expect(isContextActive('txr.method-picker')).toBe(false)
    expect(checkContextGuard(frame)).toBe('CONTEXT_INACTIVE: txr.method-picker')

    const { unmount } = render(<Host />)
    liveViewId()
    expect(isContextActive('txr.method-picker')).toBe(true)
    expect(checkContextGuard(frame)).toBeNull()

    unmount()
    expect(instancesOfType('txr.method-picker')).toEqual([])
    expect(isContextActive('txr.method-picker')).toBe(false)
    expect(checkContextGuard(frame)).toBe('CONTEXT_INACTIVE: txr.method-picker')
  })

  it('running it changes the selection and the pressed preset, like the click', async () => {
    render(<Host />)
    const viewId = liveViewId()
    expect(pressed()).toEqual(['recommended'])

    let result: unknown
    await act(async () => {
      result = await runAction('methods.applyPreset', { view_id: viewId, preset: 'all' })
    })
    expect(pressed()).toEqual(['all'])
    expect(result).toMatchObject({ preset: 'all', selected_count: 3, runnable_count: 3 })

    await act(async () => {
      await runAction('methods.applyPreset', { view_id: viewId, preset: 'none' })
    })
    expect(pressed()).toEqual(['none'])
    expect(screen.getByTestId('txr-method-checkbox-m1').getAttribute('aria-checked')).toBe('false')
  })

  it('view.describe reads the preset, the counts and a state token that moves on every selection change', async () => {
    render(<Host />)
    const viewId = liveViewId()
    const read = async () =>
      (await runAction('view.describe', { view_id: viewId })) as Record<string, unknown>

    const first = await read()
    expect(first).toMatchObject({
      type: 'txr.method-picker',
      preset: 'recommended',
      selected_count: 3,
      runnable_count: 3,
    })
    expect(typeof first._state_token).toBe('string')

    // A human tick is a mutation too: the token moves.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-checkbox-m2'))
    })
    const second = await read()
    expect(second).toMatchObject({ preset: 'custom', selected_count: 2 })
    expect(second._state_token).not.toBe(first._state_token)

    await act(async () => {
      await runAction('methods.applyPreset', { view_id: viewId, preset: 'fast' })
    })
    const third = await read()
    expect(third).toMatchObject({ preset: 'fast', selected_count: 3 })
    expect(third._state_token).not.toBe(second._state_token)
  })

  it('the palette offers it against the live picker', () => {
    render(<Host />)
    const viewId = liveViewId()
    const gated = gateAction(getActionMeta('methods.applyPreset')!, {
      isContextActive,
      hasPermission: () => true,
      activeInstanceId: context => instancesOfType(context)[0]?.id,
    })
    expect(gated).toEqual({ meta: getActionMeta('methods.applyPreset'), viewId })
  })

  it('is refused while the method list has not loaded (first load, failed first load); the selection is untouched', async () => {
    const changes: ReadonlySet<string>[] = []
    const view = (loading: boolean, error: string | null, cards: TxrMethodCard[]) => (
      <TxrMethodPicker
        cards={cards}
        loading={loading}
        error={error}
        onRetry={() => {}}
        selected={new Set()}
        onSelectionChange={next => changes.push(next)}
        onChangeFiles={() => {}}
        onChangeSettings={() => {}}
      />
    )
    const { rerender } = render(view(true, null, []))
    const viewId = liveViewId()
    const describe = async () =>
      (await runAction('view.describe', { view_id: viewId })) as Record<string, unknown>

    expect(await describe()).toMatchObject({ loading: true, load_error: null, runnable_count: 0 })
    await expect(
      runAction('methods.applyPreset', { view_id: viewId, preset: 'all' }),
    ).rejects.toThrow('UNAVAILABLE: the method list has not loaded yet')

    rerender(view(false, 'eligibility down', []))
    expect(await describe()).toMatchObject({ loading: false, load_error: 'eligibility down' })
    await expect(
      runAction('methods.applyPreset', { view_id: viewId, preset: 'all' }),
    ).rejects.toThrow('UNAVAILABLE: the method list has not loaded yet (eligibility down)')
    expect(changes).toEqual([])

    // Loaded: the action runs.
    rerender(view(false, null, CARDS))
    expect(await describe()).toMatchObject({ loading: false, load_error: null, runnable_count: 3 })
    await act(async () => {
      await runAction('methods.applyPreset', { view_id: viewId, preset: 'all' })
    })
    expect(changes.length).toBe(1)
    expect([...changes[0]].sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('rejects a bad preset and a gone picker', async () => {
    await expect(
      runAction('methods.applyPreset', { view_id: 'nope', preset: 'everything' }),
    ).rejects.toThrow(/invalid params/)
    await expect(
      runAction('methods.applyPreset', { view_id: 'gone-view', preset: 'all' }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})
