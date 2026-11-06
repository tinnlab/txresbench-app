/**
 * TxrCountsStrip — the five per-state counters of screen F (ITEM-9, the
 * board `BusyRunning.dc.html`): the finished / running / downloading /
 * waiting / failed row under the header. The numbers are the engine's own
 * `TxrRunDetail.counts` (PROV-EE-3, TEST-RUN-19's "render the engine
 * `counts` values"); the store's frame handlers recompute those very counts
 * from the rows, so the strip always shows the run's current truth.
 *
 * Board facts kept:
 *
 * - the five counters and their order are the board's (finished first, the
 *   failure last — a failure is never hidden, INV-2), each as
 *   "N <label>" with the count in the state's tone, from the module's own
 *   per-state palette (`lib/format.ts`'s `STATE_TONE` — the same palette
 *   the rows' state chips use, one colour source for a state's fact);
 * - a zero counter is greyed but still rendered (a zero is a real fact on
 *   this screen, never a gap — an empty run shows five greyed zeros);
 * - the concurrency text ("3 run at a time …") is NOT here — the plan puts
 *   it on the header (DEC-4), and the memory segment is omitted by owner
 *   decision (OWNER-1/D39). The board's overall two-segment bar is also
 *   outside this component: the frozen props carry the counts only.
 *
 * The strip is presentational — no bucket math, no state mapping; the
 * counts object is the data, rendered as-is.
 */
import type { CSSProperties } from 'react'
import type { TxrMethodState, TxrRunCounts } from '@/api-client/types'
import { STATE_TONE } from '../lib/format'

/** The five counters' board order (the counts' own key names). */
const COUNTERS: ReadonlyArray<{ state: TxrMethodState; label: string }> = [
  { state: 'finished', label: 'finished' },
  { state: 'running', label: 'running' },
  { state: 'downloading', label: 'downloading' },
  { state: 'waiting', label: 'waiting' },
  { state: 'failed', label: 'failed' },
]

const STRIP: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 18px',
  fontSize: 14,
}

const COUNT: CSSProperties = { fontWeight: 700 }

/** A zero counter's grey (the neutral of the module's palette). */
const ZERO_TONE = '#5e5e5e'

export interface TxrCountsStripProps {
  /** The run's per-state counts (the engine's own — PROV-EE-3). */
  counts: TxrRunCounts
}

export function TxrCountsStrip({ counts }: TxrCountsStripProps) {
  return (
    <div data-testid="txr-run-counts" style={STRIP}>
      {COUNTERS.map(({ state, label }) => {
        const count = counts[state]
        return (
          <span key={state} data-testid={`txr-run-counts-${state}`}>
            <b style={{ ...COUNT, color: count > 0 ? STATE_TONE[state] : ZERO_TONE }}>
              {count}
            </b>{' '}
            {label}
          </span>
        )
      })}
    </div>
  )
}
