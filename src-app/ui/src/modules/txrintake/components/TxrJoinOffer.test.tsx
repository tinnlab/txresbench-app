// @vitest-environment jsdom
/**
 * TEST-INT-7 [covers ITEM-9] — the spelling-variant join offer
 * (`components/TxrJoinOffer.tsx`): the board's A03 question line
 * ("Marker 'ldh' and 'LDH' look the same: join them?"), and the CONTROLLED
 * answer — Accept and Not now both report the OFFER OBJECT to the host
 * (the store's `acceptJoin`/`rejectJoin` take that object; no host
 * re-derives the shape, PROV-UI-INTAKE-5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrJoinOffer } from './TxrJoinOffer'
import type { JoinOffer } from '../types'

const offer: JoinOffer = { variants: ['ldh', 'LDH'], key: 'ldh' }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrJoinOffer (ITEM-9)', () => {
  it('renders the board question line from the offer variants', () => {
    render(<TxrJoinOffer offer={offer} onAccept={vi.fn()} onReject={vi.fn()} />)
    expect(
      screen.getByText('Marker "ldh" and "LDH" look the same: join them?'),
    ).toBeTruthy()
    expect(screen.getByTestId('txr-intake-join-offer-ldh')).toBeTruthy()
    expect(screen.getByText('Join them')).toBeTruthy()
    expect(screen.getByText('Not now')).toBeTruthy()
  })

  it('Accept reports the offer object', () => {
    const onAccept = vi.fn()
    render(<TxrJoinOffer offer={offer} onAccept={onAccept} onReject={vi.fn()} />)
    fireEvent.click(screen.getByTestId('txr-intake-join-accept-ldh'))
    expect(onAccept).toHaveBeenCalledWith(offer)
  })

  it('Not now reports the offer object', () => {
    const onReject = vi.fn()
    render(<TxrJoinOffer offer={offer} onAccept={vi.fn()} onReject={onReject} />)
    fireEvent.click(screen.getByTestId('txr-intake-join-decline-ldh'))
    expect(onReject).toHaveBeenCalledWith(offer)
  })
})
