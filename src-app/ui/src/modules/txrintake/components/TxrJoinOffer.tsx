/**
 * TxrJoinOffer — ONE confirmed spelling-variant join suggestion
 * (PROV-UI-INTAKE-5).
 *
 * The validator's A03 question, in its own row with the answer affordance —
 * the invite to treat a column's spellings as one marker. Board copy
 * ("Marker 'ldh' and 'LDH' look the same: join them?"), Accept / Not now
 * (kit `Button`). The component is CONTROLLED: the offer object (and its
 * `key`) is prop-passed, Accept and Not now report the SAME offer object
 * to the host — the store's `acceptJoin`/`rejectJoin` take that offer, so
 * no host re-derives a shape (DEC-21: ui-run's Change-files dialog mounts
 * this row with the same store actions).
 *
 * The offer never re-renders itself (a resolved row is removed by the
 * store, the re-validation derives the remaining ones).
 */
import type { CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import type { JoinOffer } from '../types'

/** The board's grey offer row (one question + two kit buttons). */
const OFFER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 8,
  background: 'var(--txr-bg)',
  fontSize: 13.5,
}
const OFFER_TEXT: CSSProperties = { flex: '1 1 200px', minWidth: 0, color: 'var(--txr-text-2)' }
const OFFER_ACTION: CSSProperties = { borderRadius: 6, fontSize: 13, fontWeight: 600 }
const OFFER_ACCEPT: CSSProperties = {
  ...OFFER_ACTION,
  background: 'var(--txr-brand)',
  color: 'var(--txr-on-brand)',
  border: 'none',
  padding: '5px 12px',
}
const OFFER_DECLINE: CSSProperties = {
  ...OFFER_ACTION,
  background: 'var(--txr-surface)',
  color: 'var(--txr-text)',
  border: '1px solid var(--txr-border)',
  padding: '4px 11px',
}

export interface TxrJoinOfferProps {
  offer: JoinOffer
  onAccept: (offer: JoinOffer) => void
  onReject: (offer: JoinOffer) => void
}

export function TxrJoinOffer(props: TxrJoinOfferProps) {
  const { offer, onAccept, onReject } = props
  return (
    <div style={OFFER_ROW} data-testid={`txr-intake-join-offer-${offer.key}`}>
      <span style={OFFER_TEXT}>
        Marker {offer.variants.map(v => `"${v}"`).join(' and ')} look the same: join them?
      </span>
      <Button
        data-testid={`txr-intake-join-accept-${offer.key}`}
        style={OFFER_ACCEPT}
        onClick={() => onAccept(offer)}
      >
        Join them
      </Button>
      <Button
        variant="outline"
        data-testid={`txr-intake-join-decline-${offer.key}`}
        style={OFFER_DECLINE}
        onClick={() => onReject(offer)}
      >
        Not now
      </Button>
    </div>
  )
}
