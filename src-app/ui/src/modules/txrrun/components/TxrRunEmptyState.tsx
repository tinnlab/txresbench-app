/**
 * TxrRunEmptyState — the E screen's not-configured state (ITEM-6, DEC-16).
 *
 * Screen E is reached from the intake flow's Continue, but a direct URL (or
 * a reload mid-flow) can land on `/choose-methods` with nothing configured:
 * the screen then renders this state instead of a half-broken list — the
 * mode's missing input is named, and the one action is "Start a new
 * analysis" (back to screen A, `/`), matching the plan's empty-state pin.
 *
 * The copy is this component's own (no board spells this state): the title
 * reuses the intake's own "Add your files" wording (screen C's board h1),
 * the line names the missing input the page determined
 * (`runSetupMissing`), and the CTA is the plan's "Start a new analysis".
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import type { TxrSlotKind } from '../lib/slotSummary'

/** The named-missing-input line per mode (DEC-16's "never half-broken"). */
const MISSING_PIECE_LINE: Record<TxrSlotKind, string> = {
  patients: 'Add the patients file first.',
  measurements: 'Add the measurements file first.',
  predict: 'Add the measurements of the patients to predict first.',
}

const BLOCK: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
  padding: '18px 20px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
}

const TITLE: CSSProperties = { margin: 0, fontWeight: 700, fontSize: 17 }
const LINE: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }

export interface TxrRunEmptyStateProps {
  /** The mode's first missing input (null = nothing configured at all). */
  missing: TxrSlotKind | null
  /** The "Start a new analysis" action (→ `/`). */
  onStartNew: () => void
}

export function TxrRunEmptyState({ missing, onStartNew }: TxrRunEmptyStateProps) {
  return (
    <div style={BLOCK} data-testid="txr-run-empty">
      <div style={TITLE}>Add your files first</div>
      {missing !== null ? <p style={LINE}>{MISSING_PIECE_LINE[missing]}</p> : null}
      <Button
        variant="outline"
        data-testid="txr-run-empty-start"
        onClick={onStartNew}
        style={{ padding: '9px 16px', fontWeight: 600, borderRadius: 8 }}
      >
        Start a new analysis
      </Button>
    </div>
  )
}
