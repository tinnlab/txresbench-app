// @vitest-environment jsdom
/**
 * The Help page as an entry point of the step trail (row 8 of the step
 * Back plan's flow map): a quick-start card's link and its "Try it with
 * example data" both start the trail at Help, so Back from the path's first
 * step returns to Help. Help itself is not a step and has no Back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useStepTrailStore, useTxrIntakeStore } from '@/modules/txrintake'
import { HelpPage } from './HelpPage'

const api = vi.hoisted(() => ({ example: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: { example: api.example },
  },
}))

const PREDICT_CSV = ['patient_id,day,marker,value,unit', 'J1000,0,M1,1.2,a.u.'].join('\n')

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderHelp() {
  return render(
    <MemoryRouter initialEntries={['/help']}>
      <HelpPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  api.example.mockReset()
  api.example.mockResolvedValue(PREDICT_CSV)
  window.localStorage.clear()
  useTxrIntakeStore.getState().reset()
  useStepTrailStore.setState({ trail: ['/', '/study', '/files', '/choose-methods'], current: null })
})

afterEach(() => {
  cleanup()
})

describe('Help as the start of a path (the step trail)', () => {
  it('has no Back of its own', () => {
    renderHelp()
    expect(screen.queryByTestId('txr-step-back')).toBeNull()
  })

  it('a quick-start card link starts the trail at Help', async () => {
    renderHelp()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-help-quickstart-cta-pretrained'))
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    expect(useStepTrailStore.getState().trail).toEqual(['/help'])
  })

  it('a quick-start card’s example data starts the trail at Help too', async () => {
    renderHelp()
    fireEvent.click(screen.getByTestId('txr-use-example-pretrained'))
    await waitFor(() => {
      expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    })
    expect(useStepTrailStore.getState().trail).toEqual(['/help'])
  })
})
