/**
 * TxrDeleteModelDialog — the J screen's per-row "Delete" confirm dialog
 * (ITEM-8; PROV-MS-5's `DELETE /api/txr/models/{id}` via
 * `ApiClient.Models.deleteModel`).
 *
 * DEC-14 (owner D23): the delete removes the row's FILE with the row — the
 * tree dir is pruned when the last reference is gone. The confirm's copy is
 * the board's own words, verbatim (`Models.dc.html`'s footnote — the
 * module's copy rule: the board's deletion promise, never invented
 * phrasing): "Deleting a model removes its file. Results already made with
 * it are kept in History." The danger button is the board's danger red;
 * the dialog never closes on a failed delete (the engine's line surfaces
 * inline); `onDeleted` hands the refresh back to the page.
 *
 * Controlled by `model` (null = closed); Escape/backdrop close through the
 * kit Dialog's `onOpenChange`. Test-ids: `txr-models-delete-dialog-<id>`
 * (dialog), `-confirm`, `-cancel`, `-body`, `-error`.
 */
import { useState, type CSSProperties } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelSummary } from '@/api-client/types'
import { Button, Dialog } from '@ziee/kit'

/** The one failure line (the engine's message, else this constant). */
const DELETE_FAILED_LINE = 'The model could not be deleted.'

/** The board's deletion promise, verbatim (`Models.dc.html` footnote —
 *  DEC-14/23: the file goes with the row; prior results stay in History). */
const DELETE_BODY =
  'Deleting a model removes its file. Results already made with it are kept in History.'

/** The danger button's look (the board's danger red over the kit variant). */
const DANGER_BUTTON: CSSProperties = {
  background: '#b3261e',
  color: '#ffffff',
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

export interface TxrDeleteModelDialogProps {
  /** The model being deleted; `null` is the closed dialog. */
  model: ModelSummary | null
  /** The close request (Escape / backdrop / Cancel). */
  onClose: () => void
  /** The confirm succeeded — the page refreshes the inventory. */
  onDeleted: () => void
}

export function TxrDeleteModelDialog({ model, onClose, onDeleted }: TxrDeleteModelDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    if (model === null) return
    setBusy(true)
    setError(null)
    try {
      await ApiClient.Models.deleteModel({ id: model.id })
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
      data-testid={model === null ? 'txr-models-delete-dialog' : `txr-models-delete-dialog-${model.id}`}
      title={`Delete "${model?.name ?? ''}"?`}
      open={model !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={onClose} data-testid={`txr-models-delete-dialog-${model?.id}-cancel`}>
            Cancel
          </Button>
          <Button
            style={DANGER_BUTTON}
            onClick={() => void remove()}
            disabled={busy}
            data-testid={`txr-models-delete-dialog-${model?.id}-confirm`}
          >
            Delete
          </Button>
        </div>
      }
    >
      <p data-testid={`txr-models-delete-dialog-${model?.id}-body`} style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: '#3a3a3a' }}>
        {DELETE_BODY}
      </p>
      {error !== null ? (
        <p data-testid={`txr-models-delete-dialog-${model?.id}-error`} style={{ margin: 0, fontSize: 13.5, color: '#b3261e' }}>
          {errorText(error)}
        </p>
      ) : null}
    </Dialog>
  )
}
