/**
 * TxrSlotSummary — the E screen's three file-slot lines (board
 * `Busy.dc.html`, ITEM-6; PROV-UI-RUN-4).
 *
 * The board's chips (the data-filled slot lines — patients, measurements,
 * "Measurements measurements.csv · 5 markers · draws at day 0, 14, 28, 56",
 * "Predict new_measurements.csv · 38 patients") render the snapshot's slot
 * facts: the board labels are this component's own copy, and the name +
 * summary text are DATA handed in by the page (`buildSlotSummaries` — the
 * ONE builder, DEC-13) — this component never reads the store and never
 * formats a number. A slot without an adopted file is absent from the
 * array, so it renders nothing (nothing half-drawn).
 *
 * The "Change files" affordance is the board's link-element spot; the link
 * opens the module's change-files dialog (ITEM-6), which is why the button
 * is a plain callback here (the page owns the dialog state).
 */
import type { CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import type { TxrSlotKind, TxrSlotSummarySlot } from '../lib/slotSummary'

/** The board's chip row (Busy.dc.html: flex-wrap, 10 gap). */
const SLOT_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  alignItems: 'center',
}

/** The board's chip box (the neutral token row: 8×14 padding, 8 radius). */
const SLOT_CHIP: CSSProperties = {
  padding: '8px 14px',
  border: '1px solid #e7e5e0',
  borderRadius: 8,
  background: '#fbfaf8',
  fontSize: 13.5,
}

/** The slot label's muted color (the board's `#5e5e5e`). */
const SLOT_LABEL: CSSProperties = { color: '#5e5e5e' }

/** The board's "Change files" link styling. */
const CHANGE_FILES: CSSProperties = {
  alignSelf: 'center',
  fontSize: 13.5,
  fontWeight: 600,
  padding: '2px 4px',
}

/** The board's slot labels, verbatim. */
export const SLOT_KIND_LABEL: Record<TxrSlotKind, string> = {
  patients: 'Patients',
  measurements: 'Measurements',
  predict: 'Predict',
}

export interface TxrSlotSummaryProps {
  /** The slots with data, in the board's order (a slot without a file is absent). */
  slots: TxrSlotSummarySlot[]
  /** The "Change files" action (opens the module's change-files dialog). */
  onChangeFiles: () => void
}

/** The chip's value line (name + the validated summary, dot-separated). */
function slotValue(slot: TxrSlotSummarySlot): string {
  return [slot.sourceName, slot.summaryText].filter(Boolean).join(' · ')
}

export function TxrSlotSummary({ slots, onChangeFiles }: TxrSlotSummaryProps) {
  return (
    <div style={SLOT_ROW} data-testid="txr-run-slots">
      {slots.map(slot => (
        <div
          key={slot.kind}
          data-testid={`txr-run-slots-${slot.kind}`}
          style={SLOT_CHIP}
        >
          <span style={SLOT_LABEL}>{SLOT_KIND_LABEL[slot.kind]}</span>{' '}
          {slotValue(slot)}
        </div>
      ))}
      <Button
        variant="link"
        data-testid="txr-run-change-files"
        style={CHANGE_FILES}
        onClick={onChangeFiles}
      >
        Change files
      </Button>
    </div>
  )
}
