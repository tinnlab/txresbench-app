/**
 * TxrAtATimeControl — the F screen's mid-run concurrency control (ITEM-10,
 * the board `BusyRunning.dc.html`'s "Run at the same time" row; DEC-5,
 * CONS-UI-RUN-11's GAP call site): the run's current value plus the
 * board's presets (1/2/4, `SETTING_OPTIONS.at_a_time`), with a value
 * outside the presets — the engine's default 3 — rendering as its own
 * chip (the module's numeric-chip rule, ITEM-7 note (c): a pick with the
 * current value selected nowhere is a dead control).
 *
 * The control is a KIT `Segmented` (the module's own numeric-chip idiom)
 * and it is REPORTS-only, exactly as the frozen props scope it:
 * `value` is the run's current lane count and `onChange` is the host's
 * call — the F page wires it to the run store's `setAtATime` (the
 * generated `ApiClient.Txr.setAtATime`, the engine's at-a-time route the
 * CONS-UI-RUN-11 GAP assumed; a typed provider error surfaces
 * `atATimeError` and the store restores the run's value — the consumer
 * never re-implements the lane manager, and a failure is never silent).
 *
 * `busy` disables the control (a run-level action in flight — the Stop
 * all sequence; the plan's frozen `busy` slot). The grown `error` line
 * renders the store's `atATimeError` under the control — the failed
 * pick's words, never a silent stale value (DRIFT-1 ITEM-5 #1 class).
 */
import type { CSSProperties } from 'react'
import { Segmented } from '@txresbench/kit'
import type { SegmentedOption } from '@txresbench/kit'
import { SETTING_OPTIONS } from '../lib/settings'

const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  fontSize: 13.5,
}

const LABEL: CSSProperties = { color: 'var(--txr-text-2)' }

const ERROR_LINE: CSSProperties = { flexBasis: '100%', fontSize: 12, color: 'var(--txr-danger)' }

/**
 * The control's option set: the board's presets, plus the CURRENT value as
 * its own chip when the value sits outside them (the module's numeric-chip
 * rule — a pick with the current value selected nowhere is a dead control).
 */
function atATimeOptions(value: number | null): SegmentedOption[] {
  const presets: readonly number[] = SETTING_OPTIONS.at_a_time
  const options: SegmentedOption[] = presets.map(n => ({
    value: String(n),
    label: String(n),
  }))
  if (value !== null && !presets.includes(value)) {
    options.push({ value: String(value), label: String(value) })
  }
  return options
}

export interface TxrAtATimeControlProps {
  /** The run's current lane count (the run detail's at_a_time, or the store's live value). */
  value: number | null
  /** The host's lane change (the run store's `setAtATime` — the engine's GAP route). */
  onChange: (n: number) => void
  /** A run-level action in flight — the control is disabled (never a race with the run). */
  busy: boolean
  /** The store's typed failure line (the failed pick's words; null = no error). */
  error?: string | null
}

export function TxrAtATimeControl({ value, onChange, busy, error = null }: TxrAtATimeControlProps) {
  return (
    <div data-testid="txr-run-at-a-time" style={ROW}>
      <span style={LABEL}>Run at the same time</span>
      <Segmented
        data-testid="txr-run-at-a-time-control"
        aria-label="Run at the same time"
        size="sm"
        value={value === null ? '' : String(value)}
        disabled={busy}
        onValueChange={next => onChange(Number(next))}
        options={atATimeOptions(value)}
      />
      {error !== null ? (
        <span
          data-testid="txr-run-at-a-time-error"
          style={ERROR_LINE}
          role="status"
          aria-live="polite"
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}
