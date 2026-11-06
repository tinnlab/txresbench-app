/**
 * TxrRunHeader — screen F's headline block (ITEM-9, board
 * `BusyRunning.dc.html`): the "Running N methods" title with the count from
 * the run's rows, the "about N minutes left · M min S s elapsed" line (each
 * segment omitted when the fact is unknown), the concurrency line ("N run at
 * a time on M CPUs" — DEC-4/OWNER-1: the board's memory segment is omitted,
 * the engine exposes only `memory_total_bytes` and nothing tells us the
 * application's live footprint), the "See the results" link (DEC-12) and the
 * research-use caption (DEC-11, ONE constant — the same string E's bar
 * renders).
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
 * "See the results" lives beside the title, visible exactly when the page
 * says the run has something to show (DEC-12's rule — the page passes
 * `predictions_ready || ≥1 finished row` as `predictionsReady`): the link
 * target is `txrresults`' own `resultsPath(runId)` builder (CONS-UI-RUN-15,
 * PROV-UR-1 — the provider declares this consumer; never a URL literal),
 * and the click also reports through the host's `onSeeResults` (the same
 * navigation the page owns — one affordance, one path).
 *
 * The board's overall two-segment progress bar is NOT here: neither the
 * frozen header nor the counts-strip props carry an overall percentage
 * (the board's 37 % is a design example; see DRIFT-1 ITEM-9).
 */
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { resultsPath } from '@/modules/txrresults/routes'
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

const TIME_LINE: CSSProperties = { fontSize: 14, color: '#3a3a3a' }

const CONCURRENCY: CSSProperties = { fontSize: 14, color: '#3a3a3a' }

const FOOTER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
}

const SEE_RESULTS: CSSProperties = { fontSize: 14, fontWeight: 600 }

const NOTICE: CSSProperties = { fontSize: 13, color: '#5e5e5e' }

/** The board's F title with the count from the run's rows ("Running 6
 *  methods"; one method reads singular — the board's own title words). */
export function formatRunTitle(count: number): string {
  return `Running ${count} ${count === 1 ? 'method' : 'methods'}`
}

export interface TxrRunHeaderProps {
  /** "Running N methods" — the count is the run's row count (pre-formatted). */
  title: string
  /** "about N minutes left" (or null — the run has no estimate; omit the segment). */
  timeLeft: string | null
  /** "M min S s" (or null — no elapsed fact yet; omit the segment). */
  elapsed: string | null
  /** The run's at-a-time value (null — the run carries none; omit the line). */
  atATime: number | null
  /** The detected CPU count (null — "on this computer", DEC-4's honest fallback). */
  cpus: number | null
  /** DEC-12's effective readiness (`predictions_ready` OR ≥1 finished row —
   *  the page computes the OR; this header renders exactly what it is told). */
  predictionsReady: boolean
  /** The run id — the "See the results" link's target builder argument. */
  runId: string
  /** The host's own navigation (the same run the link points to — one affordance). */
  onSeeResults: () => void
}

export function TxrRunHeader({
  title,
  timeLeft,
  elapsed,
  atATime,
  cpus,
  predictionsReady,
  runId,
  onSeeResults,
}: TxrRunHeaderProps) {
  // The board's time line ("about N minutes left · M min S s elapsed"): each
  // segment stands alone when the other fact is missing; no segment renders
  // when neither fact exists (never a fabricated zero or a bare separator).
  const timeLine =
    [timeLeft, elapsed === null ? null : `${elapsed} elapsed`]
      .filter((part): part is string => part !== null)
      .join(' · ') || null
  const concurrency =
    atATime === null
      ? null
      : `${atATime} run at a time on ${cpus !== null ? `${cpus} CPUs` : 'this computer'}`
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
        {predictionsReady ? (
          <Link
            data-testid="txr-run-see-results"
            to={resultsPath(runId)}
            onClick={onSeeResults}
            style={SEE_RESULTS}
          >
            See the results
          </Link>
        ) : null}
        <div data-testid="txr-run-notice" style={NOTICE}>
          {RESEARCH_NOTICE}
        </div>
      </div>
    </header>
  )
}
