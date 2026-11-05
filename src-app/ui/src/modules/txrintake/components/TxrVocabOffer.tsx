/**
 * TxrVocabOffer — ONE fuzzy vocabulary-match confirmation
 * (PROV-UI-INTAKE-5).
 *
 * The validator's "this column looks like a known marker" question, in its
 * own row: the match's display name, its registry system + id and the
 * canonical unit ("Your column "ldh" looks like Lactate dehydrogenase
 * (LOINC: loinc:2857-1, U/L). Use it as this marker?"), with
 * Yes, use it / Not this one (kit `Button`). CONTROLLED like
 * `TxrJoinOffer`: Accept and Not now report the SAME offer object to the
 * host (the store's `acceptVocab`/`rejectVocab` take it), and the row is
 * removed by the store + the re-validation — never by itself.
 *
 * Only a `fuzzy` match renders here: the DEC-9 ladder is the module's own
 * rule — `exact` / `alias` / `standard_id` matches are the same marker by
 * the vocabulary's own declaration and are auto-accepted upstream
 * (`resolveMapping`), so a pending offer row for one of them would be a
 * question whose answer is already known. A non-fuzzy offer therefore
 * renders NOTHING (pinned by TEST-INT-7) — the shared row is safe under
 * any host input instead of silently re-asking an auto-joined column.
 */
import type { CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import type { VocabOffer } from '../types'

/** The board's grey offer row (one question + two kit buttons). */
const OFFER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  border: '1px solid #e7e5e0',
  borderRadius: 8,
  background: '#fbfaf8',
  fontSize: 13.5,
}
const OFFER_TEXT: CSSProperties = { flex: '1 1 200px', minWidth: 0, color: '#3a3a3a' }
const OFFER_ACTION: CSSProperties = { borderRadius: 6, fontSize: 13, fontWeight: 600 }
const OFFER_ACCEPT: CSSProperties = {
  ...OFFER_ACTION,
  background: '#1d4e89',
  color: '#ffffff',
  border: 'none',
  padding: '5px 12px',
}
const OFFER_DECLINE: CSSProperties = {
  ...OFFER_ACTION,
  background: '#ffffff',
  color: '#141414',
  border: '1px solid #cfcdc7',
  padding: '4px 11px',
}

export interface TxrVocabOfferProps {
  offer: VocabOffer
  onAccept: (offer: VocabOffer) => void
  onReject: (offer: VocabOffer) => void
}

export function TxrVocabOffer(props: TxrVocabOfferProps) {
  const { offer, onAccept, onReject } = props
  if (offer.match.match_kind !== 'fuzzy') return null
  return (
    <div style={OFFER_ROW} data-testid={`txr-intake-vocab-offer-${offer.key}`}>
      <span style={OFFER_TEXT}>
        Your column "{offer.key}" looks like {offer.match.display_name} (
        {offer.match.system}: {offer.match.marker_id}, {offer.match.canonical_unit}). Use it as
        this marker?
      </span>
      <Button
        data-testid={`txr-intake-vocab-accept-${offer.key}`}
        style={OFFER_ACCEPT}
        onClick={() => onAccept(offer)}
      >
        Yes, use it
      </Button>
      <Button
        variant="outline"
        data-testid={`txr-intake-vocab-decline-${offer.key}`}
        style={OFFER_DECLINE}
        onClick={() => onReject(offer)}
      >
        Not this one
      </Button>
    </div>
  )
}
