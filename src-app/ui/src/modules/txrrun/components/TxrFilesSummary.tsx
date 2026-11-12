/**
 * TxrFilesSummary — the E screen's ONE compact files summary (qa-fixes3
 * ITEM-2 (a)): the plan's line ("94 patients · 82 events · 2 markers ·
 * draws from day 0 to 799 (93 different days)"), the marker names beside
 * it, a "Details" disclosure holding the FULL list (the old slot chips —
 * the long draw-day strip is gone from the face of the page), and "Change
 * files" beside the line.
 *
 * The facts are DATA handed in by the page (`buildFilesSummary` — the ONE
 * builder, DEC-13): this component never reads the store, never formats a
 * number, and renders the marker names line only when the validator
 * resolved markers. The "Change files" affordance is the board's
 * link-element spot; the button opens the module's change-files dialog
 * (the page owns the dialog state).
 *
 * At the app's phone width the card is COLLAPSIBLE (collapsed by default)
 * with the one-line summary as the toggle; the app-shell's short shell
 * windows (the audit's 720/768 px fixed-top byte) use the same compact
 * form via the `collapsed` prop so the E page's fixed chrome shares the
 * window with the method list.
 * with the compact line as its one-line summary; the Details disclosure
 * and "Change files" live in the expanded body (same content, smaller
 * chrome).
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import { SLOT_KIND_LABEL, type TxrSlotSummarySlot } from '../lib/slotSummary'
import { useNarrow } from '../lib/useNarrow'

/** The card's bordered look (the board's chip row's card family). */
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 16px',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  minWidth: 0,
}

/** The compact line's wrap row (the line + Change files). */
const LINE_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
}

/** The one-line summary (13.5, the board's chip text size). */
const LINE: CSSProperties = { margin: 0, fontSize: 13.5, color: 'var(--txr-text)' }

/** The marker-names line (quiet; the plan's "with the marker names"). */
const MARKERS_LINE: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--txr-muted)' }

/** The "Change files" link styling (the board's link role). */
const CHANGE_FILES: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  padding: '2px 4px',
  minHeight: 44,
}

/** The Details disclosure's quiet word. */
const DETAILS_TOGGLE: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  height: 'auto',
  fontSize: 12.5,
  color: 'var(--txr-brand)',
  minHeight: 44,
}

/** The disclosure body: the old chip lines (the FULL list). */
const DETAILS_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '8px 0 4px',
  borderTop: '1px solid var(--txr-border-subtle)',
}

/** The old chip line (the slot's label + name + validated facts). */
const DETAIL_CHIP: CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 8,
  background: 'var(--txr-bg)',
  fontSize: 13,
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const DETAIL_LABEL: CSSProperties = { color: 'var(--txr-muted)' }

/** The chip's value line (name + the validated summary, dot-separated). */
function slotValue(slot: TxrSlotSummarySlot): string {
  return [slot.sourceName, slot.summaryText].filter(Boolean).join(' · ')
}

export interface TxrFilesSummaryProps {
  /** The compact line ("94 patients · 82 events · …"). */
  line: string
  /** The marker names (empty when the validation resolved none). */
  markerNames: string[]
  /** The full per-file list (the Details disclosure's content). */
  details: TxrSlotSummarySlot[]
  /** The "Change files" action (opens the module's change-files dialog). */
  onChangeFiles: () => void
  /** app-shell ITEM-2: a SHORT shell window renders the card collapsed by
   *  default (the audit's fixed-top byte — the one-line summary form the
   *  phone width already uses); `undefined` keeps the width-driven state. */
  collapsed?: boolean
}

export function TxrFilesSummary({
  line,
  markerNames,
  details,
  onChangeFiles,
  collapsed,
}: TxrFilesSummaryProps) {
  const narrow = useNarrow()
  /** The compact (one-line) form: phone width, or a SHORT shell window. */
  const compact = narrow || collapsed === true
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)

  const detailsPanel = (
    <div data-testid="txr-run-summary-details-body" style={DETAILS_BODY}>
      <Button
        variant="link"
        data-testid="txr-run-summary-details"
        aria-expanded={detailsOpen}
        style={DETAILS_TOGGLE}
        onClick={() => setDetailsOpen(open => !open)}
      >
        {detailsOpen ? 'Hide Details' : 'Details'}
      </Button>
      {detailsOpen ? (
        <div data-testid="txr-run-summary-details-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {details.map(slot => (
            <div
              key={slot.kind}
              data-testid={`txr-run-summary-details-${slot.kind}`}
              style={DETAIL_CHIP}
            >
              <span style={DETAIL_LABEL}>{SLOT_KIND_LABEL[slot.kind]}</span>{' '}
              {slotValue(slot)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )

  const body = (
    <>
      <div style={LINE_ROW}>
        <p style={LINE} data-testid="txr-run-summary-line">
          {line}
        </p>
        <Button
          variant="link"
          data-testid="txr-run-change-files"
          style={CHANGE_FILES}
          onClick={onChangeFiles}
        >
          Change files
        </Button>
      </div>
      {markerNames.length > 0 ? (
        <p style={MARKERS_LINE} data-testid="txr-run-summary-markers">
          Markers: {markerNames.join(', ')}
        </p>
      ) : null}
      {detailsPanel}
    </>
  )

  if (compact && !phoneOpen) {
    return (
      <div style={CARD} data-testid="txr-run-summary" data-narrow="true">
        <Button
          variant="outline"
          data-testid="txr-run-summary-toggle"
          aria-expanded={false}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            textAlign: 'left',
            padding: '8px 10px',
            border: 'none',
            background: 'transparent',
            height: 'auto',
            minHeight: 44,
            minWidth: 0,
            // The kit button's default is nowrap — the one-line summary must
            // WRAP on a narrow card (the 390 sweep's byte).
            whiteSpace: 'normal',
          }}
          onClick={() => setPhoneOpen(true)}
        >
          <span style={LINE}>{line}</span>
        </Button>
      </div>
    )
  }

  return (
    <div
      style={CARD}
      data-testid="txr-run-summary"
      data-narrow={compact ? 'true' : 'false'}
    >
      {compact ? (
        <Button
          variant="outline"
          data-testid="txr-run-summary-toggle"
          aria-expanded={true}
          style={{ alignSelf: 'flex-start', minHeight: 44 }}
          onClick={() => setPhoneOpen(false)}
        >
          Hide the summary
        </Button>
      ) : null}
      {body}
    </div>
  )
}
