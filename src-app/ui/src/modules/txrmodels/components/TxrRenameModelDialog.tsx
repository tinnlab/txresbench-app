/**
 * TxrRenameModelDialog — the J screen's per-row "Rename" dialog (ITEM-8;
 * PROV-MS-5's `PATCH /api/txr/models/{id}` via
 * `ApiClient.Models.renameModel`).
 *
 * One text field — the board's row action has no mock (the row's Rename is
 * plain text on the board), so the dialog is the module's minimal modal
 * (the set-rename sibling's shape): an Input prefilled with the model's
 * current display label, Cancel, and the confirm renamed button, disabled
 * until the trimmed text differs from the current name (an empty or
 * unchanged name is refused before the wire); a failure surfaces the
 * engine's line inline and the dialog never closes on error; `onSaved`
 * hands the refresh back to the page (the engine is the truth).
 *
 * Controlled by `model` (null = closed); Escape/backdrop close through the
 * kit Dialog's `onOpenChange`. Test-ids: `txr-models-rename-dialog-<id>`
 * (dialog), `-input`, `-confirm`, `-cancel`, `-error`.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { ApiClient } from '@/api-client'
import type { ModelSummary } from '@/api-client/types'
import { Button, Dialog, Input } from '@ziee/kit'

/** The one failure line (the engine's message, else this constant). */
const RENAME_FAILED_LINE = 'The model could not be renamed.'

/** The confirm button label (the board's verb). */
const CONFIRM_LABEL = 'Rename'

/** The error line's look (the dialog's own muted red). */
const ERROR: CSSProperties = { fontSize: 13.5, color: '#b3261e' }

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
  return RENAME_FAILED_LINE
}

export interface TxrRenameModelDialogProps {
  /** The model being renamed; `null` is the closed dialog. */
  model: ModelSummary | null
  /** The close request (Escape / backdrop / Cancel). */
  onClose: () => void
  /** The confirm succeeded — the page refreshes the inventory. */
  onSaved: () => void
}

export function TxrRenameModelDialog({ model, onClose, onSaved }: TxrRenameModelDialogProps) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The dialog is a fresh form per open: the input re-seeds from the
  // model's current label, the failure line clears.
  useEffect(() => {
    if (model !== null) {
      setName(model.name)
      setBusy(false)
      setError(null)
    }
  }, [model])

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && trimmed !== model?.name && !busy

  const save = async (): Promise<void> => {
    if (model === null || trimmed.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await ApiClient.Models.renameModel({ id: model.id, name: trimmed })
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      data-testid={model === null ? 'txr-models-rename-dialog' : `txr-models-rename-dialog-${model.id}`}
      title={`Rename "${model?.name ?? ''}"`}
      open={model !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={onClose} data-testid={`txr-models-rename-dialog-${model?.id}-cancel`}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!canSave}
            data-testid={`txr-models-rename-dialog-${model?.id}-confirm`}
          >
            {CONFIRM_LABEL}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input
          data-testid={`txr-models-rename-dialog-${model?.id}-input`}
          aria-label="Model name"
          value={name}
          onChange={event => setName(event.target.value)}
        />
        {error !== null ? (
          <span data-testid={`txr-models-rename-dialog-${model?.id}-error`} style={ERROR}>
            {error}
          </span>
        ) : null}
      </div>
    </Dialog>
  )
}
