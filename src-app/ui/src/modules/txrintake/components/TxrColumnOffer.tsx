/**
 * TxrColumnOffer — ONE column-renaming suggestion of the mapping step
 * (qa-fixes ITEM-6, F2; PROV-UI-INTAKE-5).
 *
 * The card's "pid looks like patient_id — rename it?" row with the answer
 * affordance — the mapping step the drop-zone promise ("matching names are
 * found for you") was missing: a renamed or non-standard header left the
 * validator's per-role problem storm and no way to map the column. The row
 * is CONTROLLED like `TxrJoinOffer` / `TxrVocabOffer` (accept and Not now
 * report the SAME offer object; the store's `renameColumn` applies it), the
 * suggestion is automatic (the closed obvious-name table in `lib/flow.ts`),
 * and DEC-9's discipline holds: nothing is auto-renamed — the user's
 * confirmation IS the mapping step.
 */
import type { CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import type { ColumnRenameOffer } from '../types'

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

export interface TxrColumnOfferProps {
  offer: ColumnRenameOffer
  onAccept: (offer: ColumnRenameOffer) => void
  onReject: (offer: ColumnRenameOffer) => void
}

export function TxrColumnOffer(props: TxrColumnOfferProps) {
  const { offer, onAccept, onReject } = props
  return (
    <div style={OFFER_ROW} data-testid={`txr-intake-column-offer-${offer.from}`}>
      <span style={OFFER_TEXT}>
        The column &ldquo;{offer.from}&rdquo; looks like {offer.to} — rename it?
      </span>
      <Button
        data-testid={`txr-intake-column-accept-${offer.from}`}
        style={OFFER_ACCEPT}
        onClick={() => onAccept(offer)}
      >
        Rename it
      </Button>
      <Button
        variant="outline"
        data-testid={`txr-intake-column-decline-${offer.from}`}
        style={OFFER_DECLINE}
        onClick={() => onReject(offer)}
      >
        Not now
      </Button>
    </div>
  )
}
