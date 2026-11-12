/**
 * TxrRunHeader — screen F's headline block (ITEM-9, board
 * `BusyRunning.dc.html`): the "Running N methods" title with the count from
 * the run's rows, the "about N minutes left · M min S s elapsed" line (each
 * segment omitted when the fact is unknown), the concurrency line ("N run at
 * a time on M CPUs" — DEC-4/OWNER-1: the board's memory segment is omitted,
 * the engine exposes only `memory_total_bytes` and nothing tells us the
 * application's live footprint), and the research-use caption (DEC-11, ONE
 * constant — the same string E's bar renders).
 *
 * app-shell ITEM-2 — the SEE-THE-RESULTS affordance moved to the page's
 * fixed bottom bar (the audit route table's "Stop all / See results" row);
 * this header keeps the summary facts only. DEC-12's rule (live exactly
 * when `predictions_ready || ≥1 finished row`) is enforced where the link
 * now lives — the page renders it only with the same `predictionsReady`
 * fact.
 *
 * The component is PRESENTATIONAL, exactly as the frozen props scope it:
 * every string here is pre-formatted by the page (INV-4 — the time-left
 * facts are the run's own estimate minus its elapsed, `lib/format.ts`'s
 * words; nothing in this file computes a schedule or a duration). The one
 * exception is the join of the two time facts ("·" between them) and the
 * count in the title, which is a word form, not a computation — the count
 * is the board's method count over the run's rows, and one method reads
 * singular.
 *
 * The title reads the RUN's status (qa-fixes ITEM-3, RP-1): "Running N
 * methods" while the run works, "Finishing N methods" while the engine
 * finalizes, and the run's own terminal word — Finished / Failed / Stopped
 * — once it is over. A terminal run's title never claims the run is still
 * running.
 *
 * The board's overall two-segment progress bar is NOT here: neither the
 * frozen header nor the counts-strip props carry an overall percentage
 * (the board's 37 % is a design example; see DRIFT-1 ITEM-9).
 */
import type { CSSProperties } from 'react'
import type { TxrRunStatus } from '@/api-client/types'
import { RESEARCH_NOTICE } from '../lib/format'

const HEADER: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const TITLE_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
}

const TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 26,
  lineHeight: 1.2,
}

const TIME_LINE: CSSProperties = { fontSize: 14, color: 'var(--txr-text-2)' }

const CONCURRENCY: CSSProperties = { fontSize: 14, color: 'var(--txr-text-2)' }

const FOOTER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
}

const NOTICE: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

/** The run-status → title word (the board's "Running"; the terminal states
 *  the run's own word — a finished run is never titled "Running"). */
const TITLE_WORD: Record<TxrRunStatus, string> = {
  creating: 'Running',
  preparing: 'Running',
  running: 'Running',
  finishing: 'Finishing',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
}

/**
 * The board's F title with the count from the run's rows ("Running 6
 * methods"; one method reads singular — the board's own title words) and
 * the status word (RP-1; `null` status = the board's running words).
 *
 * qa-fixes2 R2-1: a TERMINAL run's title counts what actually happened,
 * not what was queued — "Finished 4 of 6 methods" (a run with 6 rows of
 * which 4 finished, 1 stopped, 1 skipped) never reads "Finished 6
 * methods" while its table shows 4 done rows; the same shape carries the
 * failed/stopped words. `finished` is the terminal-state count (null
 * while the run is live or when the caller has nothing more precise).
 */
export function formatRunTitle(
  total: number,
  status: TxrRunStatus | null = null,
  finished: number | null = null,
): string {
  const word = TITLE_WORD[status ?? 'running']
  if (finished !== null && (status === 'finished' || status === 'failed' || status === 'stopped')) {
    return `${word} ${finished} of ${total} ${total === 1 ? 'method' : 'methods'}`
  }
  return `${word} ${total} ${total === 1 ? 'method' : 'methods'}`
}

export interface TxrRunHeaderProps {
  /** "Running N methods" — the count is the run's row count (pre-formatted). */
  title: string
  /** "about N minutes left" (or null — the run has no estimate; omit the segment). */
  timeLeft: string | null
  /** The elapsed segment, PRECOMPOSED — "1 min 40 s elapsed" (live) or
   *  "took 1 min 40 s" (a terminal run, qa-fixes2 R2-1 — the header joins
   *  segments, it never words a fact). */
  elapsed: string | null
  /** The estimate's honesty word ("measured estimate" / "rough estimate";
   *  null — no quality fact; omit the segment). */
  estimateWord: string | null
  /** The run's at-a-time value (null — the run carries none; omit the line). */
  atATime: number | null
  /** The detected CPU count (null — omit the "on M CPUs" segment). */
  cpus: number | null
}

export function TxrRunHeader({
  title,
  timeLeft,
  elapsed,
  estimateWord,
  atATime,
  cpus,
}: TxrRunHeaderProps) {
  // The board's time line ("about N minutes left · M min S s elapsed"): each
  // segment stands alone when the other fact is missing; no segment renders
  // when neither fact exists (never a fabricated zero or a bare separator).
  // The estimate's honesty word (qa-fixes2 R2-3) rides at the END so the
  // board's two leading segments keep their exact bytes.
  const timeLine =
    [timeLeft, elapsed, estimateWord]
      .filter((part): part is string => part !== null)
      .join(' · ') || null
  const concurrency =
    atATime === null
      ? null
      : `${atATime} run at a time${cpus !== null ? ` on ${cpus} CPUs` : ''}`
  return (
    <header data-testid="txr-run-header" style={HEADER}>
      <div style={TITLE_ROW}>
        <h1 data-testid="txr-run-title" style={TITLE}>
          {title}
        </h1>
        {timeLine !== null ? (
          <span data-testid="txr-run-time-line" style={TIME_LINE}>
            {timeLine}
          </span>
        ) : null}
      </div>
      {concurrency !== null ? (
        <div data-testid="txr-run-concurrency" style={CONCURRENCY}>
          {concurrency}
        </div>
      ) : null}
      <div style={FOOTER_ROW}>
        <div data-testid="txr-run-notice" style={NOTICE}>
          {RESEARCH_NOTICE}
        </div>
      </div>
    </header>
  )
}
