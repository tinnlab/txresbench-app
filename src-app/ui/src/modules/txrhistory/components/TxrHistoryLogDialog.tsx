/**
 * TxrHistoryLogDialog — the K "Show the log" dialog (PROV-HIST-5, DEC-10):
 * a terminal-SNAPSHOT dialog — kit `Dialog`, the backfilled engine lines
 * (the store's `logLines`, seq-de-duped and capped at 200 — no SSE, no
 * live stream; K is the snapshot reader), the method filter (the run's
 * methods — the provider's per-method log rows), the honest
 * "Showing N of M lines" count (the store's cap means a run with more
 * lines shows a tail — the count states the bound) and "Copy the log"
 * (the clipboard write, the kit toast on success; a blocked clipboard
 * keeps the visible text selectable — never a crash).
 *
 * The presentation idiom is the sibling results module's dialog (kit
 * chrome, mono pre, copy action) — the SHAPE, deliberately NOT the
 * store-bound instance: K's dialog is this module's own, bound by the
 * page to THIS store's backfill actions (DEC-10). The component itself
 * stays presentational (the page passes the store's state + reports the
 * interactions — the TxrLogPanel ownership precedent); the copy is the
 * dialog's own pure client behaviour (the sibling's audit line).
 */
import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Dialog, message, Select, Switch } from '@txresbench/kit'
import type { TxrRunLogLine } from '@/api-client/types'
import { isTechnicalLogNoise } from '@/modules/txrshell/lib/logNoise'

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

const BODY: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }

const FILTER_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }

const PRE: CSSProperties = {
  margin: 0,
  maxHeight: 340,
  overflow: 'auto',
  padding: '10px 12px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 8,
  background: 'var(--txr-surface)',
  fontFamily: MONO_FONT,
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'var(--txr-text)',
}

/** The count line's quiet look (the panel's own bytes). */
const COUNT: CSSProperties = { fontSize: 12, color: 'var(--txr-muted)' }

/** The dialog title of the whole-run view. */
const RUN_TITLE = 'Run log'

/** The method-filter select's "All methods" option label. */
const ALL_METHODS = 'All methods'

/** The visible filter label (the running screen's panel byte — R2-10). */
const FILTER_LABEL: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** The log text — the lines' content joined the way a log file reads. */
export function logTextOf(lines: readonly TxrRunLogLine[]): string {
  return lines.map(line => line.content).join('\n')
}

export interface TxrHistoryLogDialogProps {
  /** Whether the dialog is open (the store's `logDialog !== null`). */
  open: boolean
  runId: string
  /** The active method filter (null = the whole run). */
  methodId: string | null
  /** The run's methods (the filter options; the compact row refs' ids). */
  methods: ReadonlyArray<{ id: string; version: string }>
  /** The backfilled lines (the store's seq-merged, capped tail). */
  lines: readonly TxrRunLogLine[]
  /** The provider's engine-truth line count (the "of M" figure). */
  total: number
  loading: boolean
  /** The close request (Escape/backdrop/Cancel — the store's `closeLog`). */
  onClose: () => void
  /** The method filter picked (the store re-backfills the first page). */
  onMethodChange: (methodId: string | null) => void
}

export function TxrHistoryLogDialog({
  open,
  runId,
  methodId,
  methods,
  lines,
  total,
  loading,
  onClose,
  onMethodChange,
}: TxrHistoryLogDialogProps) {
  const preRef = useRef<HTMLPreElement>(null)
  // R2-10: the setlocale / R start-up noise is hidden by default (the
  // running screen's panel rule — a log that opens with one warning per
  // method hides the run's own lines); the switch is presentation state,
  // the lines stay the store's, and Copy copies the VISIBLE view.
  const [showTechnical, setShowTechnical] = useState(false)
  const filtered = lines.filter(l => (showTechnical ? true : !isTechnicalLogNoise(l)))
  const hiddenTechnical = lines.length - filtered.length
  const text = logTextOf(filtered)

  const copyLog = (): void => {
    if (text.length === 0) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => message.success('Log copied to clipboard'))
      .catch(() => {
        /* a blocked clipboard keeps the visible text selectable — no crash */
      })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose()
      }}
      title={methodId === null ? RUN_TITLE : `Log: ${methodId}`}
      data-testid="txr-history-log-dialog"
      size="lg"
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button
            data-testid="txr-history-log-copy"
            variant="outline"
            onClick={copyLog}
            disabled={filtered.length === 0}
          >
            Copy the log
          </Button>
        </div>
      }
    >
      <div style={BODY} data-testid="txr-history-log-dialog-body">
        <div style={FILTER_ROW}>
          <span style={FILTER_LABEL}>Show the log of</span>
          <Select
            data-testid="txr-history-log-filter"
            aria-label="Show the log of"
            size="sm"
            options={[
              { value: '', label: ALL_METHODS },
              // R2-10: the selected method is ALWAYS an option — the dialog
              // can open on a method id the run's compact list does not
              // carry (the detail's rich rows ARE the method set; the
              // presentational list is the compact refs), and a select whose
              // value is not among its options renders EMPTY (the report's
              // unlabeled blank dropdown).
              ...(methodId !== null && !methods.some(m => m.id === methodId)
                ? [{ value: methodId, label: methodId }]
                : []),
              ...methods.map(method => ({ value: method.id, label: method.id })),
            ]}
            value={methodId ?? ''}
            onValueChange={value => onMethodChange(value === '' ? null : value)}
          />
        </div>
        <pre ref={preRef} data-testid="txr-history-log-lines">
          {loading && lines.length === 0 ? '' : text}
        </pre>
        {total > 0 ? (
          <div data-testid="txr-history-log-count" style={COUNT}>
            Showing {filtered.length} of {total} lines
            {!showTechnical && hiddenTechnical > 0 ? (
              <span data-testid="txr-history-log-technical-count">
                {' · '}
                {hiddenTechnical} technical lines hidden
              </span>
            ) : null}
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <Switch
            data-testid="txr-history-log-technical"
            aria-label="Show technical output"
            checked={showTechnical}
            onCheckedChange={setShowTechnical}
          />
          <span>Show technical output</span>
        </div>
      </div>
    </Dialog>
  )
}
