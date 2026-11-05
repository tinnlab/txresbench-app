// @vitest-environment jsdom
/**
 * TEST-INT-7 [covers ITEM-9] — the fuzzy vocabulary confirmation
 * (`components/TxrVocabOffer.tsx`): the board's confirm line renders the
 * match facts (display name, registry system + id, canonical unit) for a
 * `fuzzy` offer only; Accept / Not this one report the OFFER OBJECT to the
 * host (the store's `acceptVocab`/`rejectVocab` take that object). A
 * non-fuzzy match renders NOTHING — the DEC-9 ladder auto-accepts
 * `exact`/`alias`/`standard_id` upstream (TEST-INT-3 / `resolveMapping`),
 * so a pending row for one would re-ask an already-answered column.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MarkerMatch } from '@/api-client/types'
import { TxrVocabOffer } from './TxrVocabOffer'
import type { VocabOffer } from '../types'

const fuzzyMatch: MarkerMatch = {
  marker_id: 'loinc:27856-1',
  system: 'LOINC',
  display_name: 'Carcinoembryonic antigen',
  unit_family: 'concentration_mass',
  canonical_unit: 'ng/mL',
  n_methods: 9,
  match_kind: 'fuzzy',
}

const offer: VocabOffer = { key: 'cea', match: fuzzyMatch, accepted: null }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrVocabOffer (ITEM-9)', () => {
  it('renders the match confirm line for a fuzzy offer', () => {
    render(<TxrVocabOffer offer={offer} onAccept={vi.fn()} onReject={vi.fn()} />)
    expect(
      screen.getByText(
        'Your column "cea" looks like Carcinoembryonic antigen (LOINC: loinc:27856-1, ng/mL). Use it as this marker?',
      ),
    ).toBeTruthy()
    expect(screen.getByTestId('txr-intake-vocab-offer-cea')).toBeTruthy()
    expect(screen.getByText('Yes, use it')).toBeTruthy()
    expect(screen.getByText('Not this one')).toBeTruthy()
  })

  it('Yes, use it reports the offer object', () => {
    const onAccept = vi.fn()
    render(<TxrVocabOffer offer={offer} onAccept={onAccept} onReject={vi.fn()} />)
    fireEvent.click(screen.getByTestId('txr-intake-vocab-accept-cea'))
    expect(onAccept).toHaveBeenCalledWith(offer)
  })

  it('Not this one reports the offer object', () => {
    const onReject = vi.fn()
    render(<TxrVocabOffer offer={offer} onAccept={vi.fn()} onReject={onReject} />)
    fireEvent.click(screen.getByTestId('txr-intake-vocab-decline-cea'))
    expect(onReject).toHaveBeenCalledWith(offer)
  })

  it('renders nothing for a non-fuzzy match (auto-accepted upstream)', () => {
    const autoAccepted: VocabOffer = { key: 'ldh', match: { ...fuzzyMatch, match_kind: 'exact' }, accepted: true }
    const { container } = render(
      <TxrVocabOffer offer={autoAccepted} onAccept={vi.fn()} onReject={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('txr-intake-vocab-offer-ldh')).toBeNull()
  })
})
