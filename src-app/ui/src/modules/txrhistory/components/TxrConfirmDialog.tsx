/**
 * TxrConfirmDialog — the K footer's destructive-transition dialog
 * (PROV-HIST-5, INV-2): the ONE dialog with the three confirmations the
 * board's links open — copies-off ("New runs will not keep copies.
 * Copies already stored are removed."), copies-on (the flip back — with
 * the removed copies NOT restored, stated honestly) and clear-all (the
 * owner's two-choice dialog — "Clear history and remove files" (the
 * default, D23's files-with-rows direction) / "Clear history, keep
 * files"). Cancel closes without any call (the store's own
 * confirmation-gate assertion is TEST-HIST-4 — the component only
 * reports).
 *
 * The confirm CTAs report to the page; the page calls the store actions
 * (`setKeepCopies` / `clearAllHistory`), whose no-op-without-confirm
 * gate is the second half of INV-2. `working` disables the CTAs while a
 * transition is in flight (no double fire); the dialog stays open until
 * the transition consumes it (the store clears `confirm` at its start —
 * a failed transition's retry re-opens it, TEST-HIST-4's recorded
 * surface).
 *
 * The dialog's own channel ids (`txr-history-confirm-*`) are the plan's
 * id list extension — the plan's DEC-7 list named the footer links but
 * no dialog channel, and the component/e2e courts need selectors.
 */
import type { CSSProperties } from 'react'
import { Alert, Button, Dialog } from '@txresbench/kit'
import type { TxrHistoryState } from '../stores/TxrHistory.store'

/** The copies-off body (the plan's words, verbatim). */
const COPIES_OFF_BODY = 'New runs will not keep copies. Copies already stored are removed.'

/** The copies-on body — the honest flip-back (removed copies are not restored). */
const COPIES_ON_BODY = 'New runs will keep copies. Copies already removed are not restored.'

/** The clear-all body (the plan's question, verbatim). */
const CLEAR_ALL_BODY = 'Clear the history list and the run folders without the files?'

/** The delete-run body (qa-fixes4 ITEM-2 (f)): what deleting DOES, honestly
 *  (the run and its files and log are removed; saved models are kept — the
 *  model-store's rows are not this run's, D14's separate tree). */
const DELETE_RUN_BODY =
  'This run and its files and log are removed. Saved models are kept.'

/** The confirm CTAs' labels (the board's own words where the board carries
 *  them; the dialog's verbs are the link labels' own words). */
const KEEP_COPIES_ON_LABEL = 'Keep copies'
const CLEAR_FILES_LABEL = 'Clear history and remove files'
const KEEP_FILES_LABEL = 'Clear history, keep files'
const DELETE_RUN_LABEL = 'Delete this run'

/** The danger look (the board's danger red over the kit button). */
const DANGER_BUTTON: CSSProperties = {
  background: 'var(--txr-danger-strong)',
  color: 'var(--txr-on-danger)',
}

/** The footer CTA row (the kit dialog footer's gap). */
const CTA_ROW: CSSProperties = { display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }

export type TxrConfirmKind = NonNullable<TxrHistoryState['confirm']>

export interface TxrConfirmDialogProps {
  /** The open confirmation; null = closed (the store's `confirm`). */
  confirm: TxrConfirmKind | null
  /** The in-flight transition (the CTAs' shared busy state). */
  working: boolean
  /** The close request (Cancel / Escape / backdrop). */
  onCancel: () => void
  /** The copies-off CTA (the store's `setKeepCopies(false)`). */
  onCopiesOff: () => void
  /** The copies-on CTA (the store's `setKeepCopies(true)`). */
  onCopiesOn: () => void
  /** The clear-all CTA with the `delete_files` choice (the store's
   *  `clearAllHistory(deleteFiles)`). */
  onClearAll: (deleteFiles: boolean) => void
  /** The delete-run CTA (the store's `deleteRun` — the run id is the
   *  store's `confirmRunId`, the row the dialog opened for). */
  onDeleteRun: () => void
}

export function TxrConfirmDialog({
  confirm,
  working,
  onCancel,
  onCopiesOff,
  onCopiesOn,
  onClearAll,
  onDeleteRun,
}: TxrConfirmDialogProps) {
  const open = confirm !== null
  const title =
    confirm === 'clear-all'
      ? 'Clear all history?'
      : confirm === 'copies-on'
        ? 'Keep copies of my files?'
        : confirm === 'delete-run'
          ? 'Delete this run?'
          : 'Do not keep copies of my files?'
  return (
    <Dialog
      data-testid="txr-history-confirm"
      title={title}
      open={open}
      onOpenChange={next => {
        if (!next) onCancel()
      }}
      footer={
        <div data-testid={`txr-history-confirm-footer-${confirm ?? 'closed'}`} style={CTA_ROW}>
          <Button
            data-testid="txr-history-confirm-cancel"
            variant="outline"
            disabled={working}
            onClick={onCancel}
          >
            Cancel
          </Button>
          {confirm === 'clear-all' ? (
            <>
              <Button
                data-testid="txr-history-confirm-keep-files"
                variant="outline"
                disabled={working}
                onClick={() => onClearAll(false)}
              >
                {KEEP_FILES_LABEL}
              </Button>
              <Button
                data-testid="txr-history-confirm-clear-files"
                style={DANGER_BUTTON}
                disabled={working}
                onClick={() => onClearAll(true)}
              >
                {CLEAR_FILES_LABEL}
              </Button>
            </>
          ) : confirm === 'delete-run' ? (
            <Button
              data-testid="txr-history-confirm-delete-run"
              style={DANGER_BUTTON}
              disabled={working}
              onClick={onDeleteRun}
            >
              {DELETE_RUN_LABEL}
            </Button>
          ) : confirm === 'copies-on' ? (
            <Button
              data-testid="txr-history-confirm-copies-on"
              disabled={working}
              onClick={onCopiesOn}
            >
              {KEEP_COPIES_ON_LABEL}
            </Button>
          ) : (
            <Button
              data-testid="txr-history-confirm-copies-off"
              disabled={working}
              onClick={onCopiesOff}
            >
              Do not keep copies
            </Button>
          )}
        </div>
      }
    >
      <Alert
        data-testid={`txr-history-confirm-body-${confirm ?? 'closed'}`}
        tone={confirm === 'clear-all' || confirm === 'delete-run' ? 'error' : 'warning'}
      >
        {confirm === 'clear-all'
          ? CLEAR_ALL_BODY
          : confirm === 'copies-on'
            ? COPIES_ON_BODY
            : confirm === 'delete-run'
              ? DELETE_RUN_BODY
              : COPIES_OFF_BODY}
      </Alert>
    </Dialog>
  )
}
