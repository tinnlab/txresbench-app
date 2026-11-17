// @vitest-environment jsdom
/**
 * The step views' Back: `useStepBack` (the trail record, the `txr.step`
 * context, the current-step facts), the `TxrStepBack` button (the registered
 * `flow.back` through the router bridge; unavailable with the reason while a
 * run is starting) and `TxrStepBackBar`. The palette offers `flow.back` only
 * while a step view is on screen (the real gate over the real registry).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@txresbench/kit'
import '@/core/actions/builtin/stepActions'
import { getActionRegistry } from '@/core/actions/defineAction'
import { isContextActive } from '@/core/actions/activeContext'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { gatePaletteActions } from '@/modules/command-palette/paletteGating'
import { beginPath, TXR_STEP_CONTEXT, useStepTrailStore, type TxrStepId } from '../lib/stepTrail'
import {
  STEP_BACK_STARTING_REASON,
  TxrStepBack,
  TxrStepBackBar,
  useStepBack,
} from './TxrStepBack'

function Probe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}

/** A stand-in step page: the hook plus its Back button. */
function Step({
  step,
  fallback,
  blockedReason = null,
  dialogOpen = false,
  next,
}: {
  step: TxrStepId
  fallback: string
  blockedReason?: string | null
  dialogOpen?: boolean
  next?: string
}) {
  useStepBack({ step, fallback, blockedReason, dialogOpen })
  const navigate = useNavigate()
  return (
    <div data-testid={`page-${step}`}>
      <TxrStepBack />
      {next !== undefined ? (
        <Button data-testid="continue" onClick={() => navigate(next)}>
          Continue
        </Button>
      ) : null}
    </div>
  )
}

function Start() {
  return <div data-testid="page-start">Start</div>
}

function renderFlow(initial: string, steps: { blocked?: string | null; dialog?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <RouterBridge />
      <Probe />
      <Routes>
        <Route path="/" element={<Start />} />
        <Route path="/study" element={<Step step="study" fallback="/" next="/files" />} />
        <Route
          path="/pretrained-models"
          element={<Step step="pretrained-models" fallback="/predict-files" />}
        />
        <Route
          path="/files"
          element={
            <Step
              step="files"
              fallback="/study"
              blockedReason={steps.blocked ?? null}
              dialogOpen={steps.dialog ?? false}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const location = (): string => screen.getByTestId('location').textContent ?? ''

async function clickBack(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('txr-step-back'))
    await Promise.resolve()
  })
}

beforeEach(() => {
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
})

afterEach(() => {
  cleanup()
})

describe('useStepBack', () => {
  it('records the step in the trail, sets the current step and declares the txr.step context while mounted', () => {
    beginPath('/')
    const view = renderFlow('/study')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/study'])
    expect(useStepTrailStore.getState().current).toEqual({
      step: 'study',
      url: '/study',
      fallback: '/',
      blockedReason: null,
      dialogOpen: false,
    })
    expect(isContextActive(TXR_STEP_CONTEXT)).toBe(true)
    view.unmount()
    expect(useStepTrailStore.getState().current).toBeNull()
    expect(isContextActive(TXR_STEP_CONTEXT)).toBe(false)
  })

  it('a step entered by Continue is appended; Back from it returns to the step before', async () => {
    beginPath('/')
    renderFlow('/study')
    await act(async () => {
      fireEvent.click(screen.getByTestId('continue'))
    })
    expect(location()).toBe('/files')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/study', '/files'])
    await clickBack()
    expect(location()).toBe('/study')
    await clickBack()
    expect(location()).toBe('/')
    expect(screen.getByTestId('page-start')).toBeTruthy()
  })
})

describe('TxrStepBack', () => {
  it('is a kit outline button labelled Back, clickable with no reason', () => {
    renderFlow('/study')
    const back = screen.getByTestId('txr-step-back')
    expect(back.textContent).toContain('Back')
    expect(back.getAttribute('aria-disabled')).toBeNull()
  })

  it('while a Back is already leaving the step, another click does nothing', async () => {
    beginPath('/')
    renderFlow('/study')
    act(() => {
      useStepTrailStore.setState({ leaving: true })
    })
    await clickBack()
    expect(location()).toBe('/study')
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/study'])
  })

  it('leaving the step view ends the leaving state', () => {
    const view = renderFlow('/study')
    act(() => {
      useStepTrailStore.setState({ leaving: true })
    })
    view.unmount()
    expect(useStepTrailStore.getState().leaving).toBe(false)
  })

  it('a deep link (no trail) goes to the step fallback', async () => {
    renderFlow('/files')
    await clickBack()
    expect(location()).toBe('/study')
  })

  it('while a run is starting it is unavailable with the reason, and a click goes nowhere', async () => {
    beginPath('/')
    useStepTrailStore.setState({ trail: ['/', '/study'] })
    renderFlow('/files', { blocked: STEP_BACK_STARTING_REASON })
    const back = screen.getByTestId('txr-step-back')
    expect(back.getAttribute('aria-disabled')).toBe('true')
    expect(back.textContent).toContain(STEP_BACK_STARTING_REASON)
    await clickBack()
    expect(location()).toBe('/files')
  })
})

describe('TxrStepBackBar', () => {
  it('is a bottom bar whose last child is the Back button', () => {
    render(
      <MemoryRouter initialEntries={['/files']}>
        <TxrStepBackBar />
      </MemoryRouter>,
    )
    const bar = screen.getByTestId('txr-step-back-bar')
    expect(bar.lastElementChild).toBe(screen.getByTestId('txr-step-back'))
  })
})

describe('the palette offers flow.back only on a step view', () => {
  const offered = (): string[] =>
    gatePaletteActions(
      Array.from(getActionRegistry().values()).map(entry => entry.meta),
      { isContextActive, hasPermission: () => true, activeInstanceId: () => undefined },
    ).map(g => g.meta.id)

  it('absent with no step view, present while one is mounted, absent again after', () => {
    expect(offered()).not.toContain('flow.back')
    const view = renderFlow('/study')
    expect(offered()).toContain('flow.back')
    view.unmount()
    expect(offered()).not.toContain('flow.back')
  })

  it('models.switchList only on the model steps (D, I), never on B, C, N or E', () => {
    const study = renderFlow('/study')
    expect(offered()).toContain('flow.back')
    expect(offered()).not.toContain('models.switchList')
    study.unmount()
    const models = renderFlow('/pretrained-models')
    expect(offered()).toContain('models.switchList')
    models.unmount()
    expect(offered()).not.toContain('models.switchList')
  })

  it('absent on a non-step page (Start)', () => {
    renderFlow('/')
    expect(offered()).not.toContain('flow.back')
  })
})
