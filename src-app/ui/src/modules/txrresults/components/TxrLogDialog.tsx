/**
 * TxrLogDialog — the per-method / whole-run log dialog (PROV-UR-5: kit
 * `Dialog`; the F screen's "Show the log" idiom reused for the G/H banner
 * links, matched by the G screen's live-heatmap page). One component serves
 * both screens: the store's `logDialogFor` three-state field decides what
 * is open (undefined = closed, null = the whole run, a method id = that
 * method) and the page renders `<TxrLogDialog />` wherever it renders its
 * banners.
 *
 * Content model: the SSE `log` frames already merge into the store's
 * `liveLogs` (cap 200, seq-de-duped); on open (and on a method switch) the
 * dialog BACKFILLS the pre-SSE history through `TxrResults.loadLogs(
 * method_id|null, after_seq)` with `after_seq` = the last line's seq the
 * store holds (undefined on the first open — the endpoint's start page).
 * The painted lines are the store's, filtered to the open method when one
 * is selected (engine lines without a method id belong to the whole-run
 * view only).
 *
 * Auto-scroll: the pre box follows the newest line while lines arrive (the
 * JobDetail log idiom — `scrollTop = scrollHeight` on the line count); the
 * "Copy the log" action writes the joined text to the clipboard (the kit
 * toast on success; a blocked clipboard degrades to the visible text, never
 * a crash). The engine-authored lines are exactly what the banner's reason
 * sentence promises the user (INV-2's "failure kept with its reason").
 *
 * The title/caption copy is this node's (the F-screen panel's exact bytes
 * are ui-run's): "Run log" for the whole run, the mono method id for one
 * method; recorded as design-gap copy, one-line changeable.
 */
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { useStore } from 'zustand'
import { Button, Dialog, message } from '@ziee/kit'
import { TxrResults, useTxrResultsStore } from '../stores/Results.store'
import type { TxrRunLogLine } from '@/api-client/types'

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

const PRE: CSSProperties = {
  margin: 0,
  maxHeight: 340,
  overflow: 'auto',
  padding: '10px 12px',
  border: '1px solid #e7e5e0',
  borderRadius: 8,
  background: '#fbfaf8',
  fontFamily: MONO_FONT,
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: '#141414',
}

/** The dialog's lines — the store's log tail, filtered to the open method. */
function linesFor(
  lines: TxrRunLogLine[],
  methodId: string | null,
): TxrRunLogLine[] {
  if (methodId === null) return lines
  return lines.filter(l => l.method_id === methodId)
}

/** The copy text — the lines' content joined the way a log file reads. */
function logTextOf(lines: TxrRunLogLine[]): string {
  return lines.map(l => l.content).join('\n')
}

export function TxrLogDialog() {
  const state = useStore(useTxrResultsStore)
  const open = state.logDialogFor !== undefined
  const methodId = state.logDialogFor ?? null
  const lines = linesFor(state.liveLogs, methodId)
  const preRef = useRef<HTMLPreElement>(null)

  // Backfill on open and on a method switch: continue from the last line the
  // store already holds (a re-open after a live tail continues, first open
  // starts at the endpoint's page). The SSE keeps appending while open.
  useEffect(() => {
    if (!open) return
    const lastSeq = state.liveLogs.length > 0 ? state.liveLogs[state.liveLogs.length - 1].seq : undefined
    void TxrResults.loadLogs(methodId, lastSeq)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the backfill is
    // keyed on the OPEN/METHOD transition only, never on the live tail.
  }, [open, methodId])

  // Follow the newest line (the JobDetail log idiom).
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const copyLog = (): void => {
    const text = logTextOf(lines)
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
      onOpenChange={onOpen => {
        if (!onOpen) TxrResults.openLog()
      }}
      title={methodId === null ? 'Run log' : `Log: ${methodId}`}
      data-testid="txr-log-dialog"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            data-testid="txr-log-dialog-copy"
            variant="outline"
            onClick={copyLog}
            disabled={lines.length === 0}
          >
            Copy the log
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="txr-log-dialog-body">
        {state.streaming ? (
          <div style={{ fontSize: 12.5, color: '#5e5e5e' }}>
            Lines appear here as the run writes them.
          </div>
        ) : null}
        <pre ref={preRef} data-testid="txr-log-dialog-pre">
          {lines.length > 0 ? logTextOf(lines) : ''}
        </pre>
      </div>
    </Dialog>
  )
}
