/**
 * TxrDeleteSetDialog — the section "Delete" confirm dialog (ITEM-7;
 * PROV-MS-4's `DELETE /api/txr/model-sets/{id}?keep_files=false` through the
 * ONE `deleteSetById` call — `lib/setActions.ts`; the registered
 * `models.deleteSet` action only OPENS this dialog, the confirm is the
 * only delete).
 *
 * Two optional props arm the Models page's "Delete the set" (the set-row
 * wording stands when they are not passed, and the merged list has no set
 * actions): `confirmLabel` (default "Delete the run's models") and
 * `keepsTrainingFiles` (the body adds the kept-training-files sentence when
 * the set records `keep_training_files`). `keep_files` stays `false` on the
 * wire for every caller (DEC-14).
 *
 * DEC-14 (owner D23): the product default deletes the files WITH the rows —
 * `keep_files: false` (the store's default: rows + tree dirs pruned + the
 * kept training copy). The confirm's copy is the board's own words,
 * adapted to the set: `Models.dc.html`'s "Deleting a model removes its
 * file. Results already made with it are kept in History." — the set's
 * plural reading is the same promise ("removes their files … kept in
 * History" — a model's prior results are never touched, D23's
 * record). The danger button is the board's danger red; the dialog never
 * closes on a failed delete (the engine's line surfaces inline);
 * `onDeleted` hands the refresh back to the page.
 *
 * Controlled by `set` (null = closed); Escape/backdrop close through the
 * kit Dialog's `onOpenChange`. Test-ids: `txr-models-set-delete-<id>`
 * (dialog), `-confirm`.
 */
import { useState, type CSSProperties } from 'react'
import { Button, Dialog } from '@txresbench/kit'
import { deleteSetById } from '../lib/setActions'

/** The one failure line (the engine's message, else this constant). */
const DELETE_FAILED_LINE = 'The models could not be deleted.'

/** The board's deletion promise, the set's plural reading (DEC-14/D23:
 *  files go with the row; prior results stay in History). */
const DELETE_BODY =
  'This removes the set and its models\u2019 files. Results already made with them are kept in History.'

/** The extra sentence when the set keeps its training files (the Models
 *  page's "Delete the set": the kept training copy goes too). */
const KEEPS_TRAINING_FILES_SENTENCE =
  ' The training files kept with this set are removed too.'

/** The confirm button's default label (the saved-model run's board verb). */
const DEFAULT_CONFIRM_LABEL = "Delete the run's models"

/** The danger button's look (the board's danger red over the kit variant). */
const DANGER_BUTTON: CSSProperties = {
  background: 'var(--txr-danger-strong)',
  color: 'var(--txr-on-danger)',
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return DELETE_FAILED_LINE
}

export interface TxrDeleteSetDialogProps {
  /** The set whose models are deleted; `null` is the closed dialog. */
  set: { id: string; name: string } | null
  /** The close request (Escape / backdrop / Cancel). */
  onClose: () => void
  /** The confirm succeeded — the page refreshes the saved slice. */
  onDeleted: () => void
  /** The confirm button's label. Defaults to the saved-run board verb
   *  ("Delete the run's models"); the Models page passes "Delete the
   *  set". */
  confirmLabel?: string
  /** True when the set keeps its training files: the body adds one extra
   *  sentence (the kept training copy is removed too). Kept for the Models
   *  page's confirm; the default wording stands when it is not passed. */
  keepsTrainingFiles?: boolean
}

export function TxrDeleteSetDialog({
  set,
  onClose,
  onDeleted,
  confirmLabel = DEFAULT_CONFIRM_LABEL,
  keepsTrainingFiles = false,
}: TxrDeleteSetDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    if (set === null) return
    setBusy(true)
    setError(null)
    try {
      // DEC-14: files are deleted with the rows (the provider's default) —
      // the ONE delete call every caller's confirm goes through.
      await deleteSetById(set.id)
      onDeleted()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      data-testid={set === null ? 'txr-models-set-delete' : `txr-models-set-delete-${set.id}`}
      title={`Delete "${set?.name ?? ''}" and its models?`}
      open={set !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={onClose} data-testid={`txr-models-set-delete-${set?.id}-cancel`}>
            Cancel
          </Button>
          <Button
            style={DANGER_BUTTON}
            onClick={() => void remove()}
            disabled={busy}
            data-testid={`txr-models-set-delete-${set?.id}-confirm`}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <p data-testid={`txr-models-set-delete-${set?.id}-body`} style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: 'var(--txr-text-2)' }}>
        {DELETE_BODY}
        {keepsTrainingFiles ? KEEPS_TRAINING_FILES_SENTENCE : null}
      </p>
      {error !== null ? (
        <p data-testid={`txr-models-set-delete-${set?.id}-error`} style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-danger)' }}>
          {errorText(error)}
        </p>
      ) : null}
    </Dialog>
  )
}
