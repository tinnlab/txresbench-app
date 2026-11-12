/**
 * TxrCannotRunBanner — the per-method "could not run" banners of screen G
 * (`BusyResults.dc.html`): one banner per `cannot_run` method row, each with
 * the mono method id, the engine's reason sentence and a "Show the log"
 * action that opens that method's log dialog.
 *
 * Copy facts (board-verbatim, PROV-UR-5 / DEC-15):
 * - the sentence is `<method_id> could not run: <reason detail>. The other
 *   <n> methods are shown.` — the reason is `formatReasonText`'s consumer
 *   copy (the engine's `reason.detail` verbatim, or the REASON_FALLBACK
 *   sentence when it is empty; this node never re-renders a reason code);
 * - "The other N" counts the run's methods EXCLUDING this one (the board's
 *   run: 12 methods, 1 cannot-run → "The other 11 methods are shown."); the
 *   board's plural, with the one-method singular (formatCounts' rule);
 * - "Show the log" reports the method id — the page opens the store's log
 *   dialog (`openLog(methodId)`, ITEM-5's three-state field).
 *
 * The banner is presentational: `methods` holds exactly the cannot-run rows
 * (the page filters `run.methods`), `total` the run's method count.
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import type { TxrRunReason } from '@/api-client/types'
import { formatReasonText } from '../lib/format'

const BANNER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-danger-border)',
  borderRadius: 8,
  background: 'var(--txr-danger-soft)',
  fontSize: 14,
}

const METHOD_ID: CSSProperties = {
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 13,
}

const SHOW_LOG: CSSProperties = { fontSize: 13, color: 'var(--txr-brand)', marginLeft: 'auto', whiteSpace: 'nowrap' }

export interface TxrCannotRunMethod {
  method_id: string
  reason?: TxrRunReason
}

export interface TxrCannotRunBannerProps {
  /** The run's `cannot_run` method rows — one banner each. */
  methods: ReadonlyArray<TxrCannotRunMethod>
  /** The run's total method count (the sentence's "other N"). */
  total: number
  /** "Show the log" for this method (opens the log dialog, ITEM-5). */
  onShowLog: (methodId: string) => void
}

/** The sentence's tail — board plural, with the one-method singular. */
function othersShown(count: number): string {
  return `The other ${count} ${count === 1 ? 'method' : 'methods'} are shown.`
}

export function TxrCannotRunBanner({ methods, total, onShowLog }: TxrCannotRunBannerProps) {
  if (methods.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {methods.map(method => (
        <div key={method.method_id} data-testid={`txr-results-cannot-${method.method_id}`} style={BANNER}>
          <svg
            width={18}
            height={18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--txr-danger)"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            style={{ flexShrink: 0 }}
          >
            <circle cx={12} cy={12} r={10} />
            <path d="M12 7v6M12 16.5v.5" />
          </svg>
          <span>
            <b style={METHOD_ID}>{method.method_id}</b> could not run:{' '}
            {formatReasonText(method.reason?.code, method.reason?.detail)} {othersShown(Math.max(0, total - 1))}
          </span>
          <Button
            data-testid={`txr-results-show-log-${method.method_id}`}
            variant="link"
            className="p-0"
            style={SHOW_LOG}
            onClick={() => onShowLog(method.method_id)}
          >
            Show the log
          </Button>
        </div>
      ))}
    </div>
  )
}
