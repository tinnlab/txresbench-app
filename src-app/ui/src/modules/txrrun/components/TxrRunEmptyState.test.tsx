// @vitest-environment jsdom
/**
 * ITEM-6 — the not-configured state (`components/TxrRunEmptyState.tsx`,
 * DEC-16): reaching `/choose-methods` with no configured input renders the
 * empty state with the mode's missing piece named and the ONE action
 * ("Start a new analysis" → `/`), never a half-broken screen. The page's
 * empty/partial branch is pinned at ITEM-8 (TEST-RUN-17); this file pins
 * the state's own rendering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrRunEmptyState } from './TxrRunEmptyState'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrRunEmptyState (E not-configured, ITEM-6)', () => {
  it('names the missing piece per mode input', () => {
    render(<TxrRunEmptyState missing="patients" onStartNew={() => undefined} />)
    expect(screen.getByText('Add your files first')).toBeTruthy()
    expect(screen.getByText('Add the patients file first.')).toBeTruthy()

    cleanup()
    render(<TxrRunEmptyState missing="measurements" onStartNew={() => undefined} />)
    expect(screen.getByText('Add the measurements file first.')).toBeTruthy()

    cleanup()
    render(<TxrRunEmptyState missing="predict" onStartNew={() => undefined} />)
    expect(screen.getByText('Add the measurements of the patients to predict first.')).toBeTruthy()
  })

  it('renders without a missing line when nothing is configured at all', () => {
    render(<TxrRunEmptyState missing={null} onStartNew={() => undefined} />)
    expect(screen.getByTestId('txr-run-empty')).toBeTruthy()
    expect(screen.getByText('Add your files first')).toBeTruthy()
    expect(screen.queryByText(/first\./)).toBeNull()
  })

  it('fires the Start-a-new-analysis action once (→ screen A)', () => {
    const onStartNew = vi.fn()
    render(<TxrRunEmptyState missing={null} onStartNew={onStartNew} />)
    fireEvent.click(screen.getByTestId('txr-run-empty-start'))
    expect(onStartNew).toHaveBeenCalledTimes(1)
  })
})
