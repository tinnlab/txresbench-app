/**
 * TxrRenameSetDialog — the I screen's section "Rename" dialog (ITEM-7;
 * PROV-MS-4's `PATCH /api/txr/model-sets/{id}` via
 * `ApiClient.ModelSets.renameSet`).
 *
 * The board's section action is a row-level action ("Rename" on
 * `Saved.dc.html`); the dialog is THIS module's host chrome — a set name
 * is one text field, so the dialog is the board's own minimal modal: an
 * Input prefilled with the set's current name, Cancel, and the confirm
 * renamed button. The confirm is disabled while no trimmed text is typed
 * (an empty name is refused before the wire — the engine's 400 is the
 * same rule, stated here); a failure surfaces the engine's line inline
 * (the dialog never closes on error); `onSaved` hands the refreshed set
 * back to the page, which refetches the store's saved slice (the engine is
 * the truth).
 *
 * Controlled by `set` (null = closed); Escape/backdrop close through the
 * kit Dialog's `onOpenChange`. Test-ids follow the plan's set-action
 * convention: `txr-models-set-rename-<id>` (dialog), `-input`, `-confirm`.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { ApiClient } from '@/api-client'
import { Button, Dialog, Input } from '@ziee/kit'

/** The one failure line (the engine's message, else this constant). */
const RENAME_FAILED_LINE = 'The set could not be renamed.'

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

export interface TxrRenameSetDialogProps {
  /** The set being renamed; `null` is the closed dialog. */
  set: { id: string; name: string } | null
  /** The close request (Escape / backdrop / Cancel). */
  onClose: () => void
  /** The confirm succeeded — the page refreshes the saved slice. */
  onSaved: () => void
}

export function TxrRenameSetDialog({ set, onClose, onSaved }: TxrRenameSetDialogProps) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The dialog is a fresh form per open: the input re-seeds from the set's
  // current name, the failure line clears (a stale error from a previous
  // open is noise).
  useEffect(() => {
    if (set !== null) {
      setName(set.name)
      setBusy(false)
      setError(null)
    }
  }, [set])

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && trimmed !== set?.name && !busy

  const save = async (): Promise<void> => {
    if (set === null || trimmed.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await ApiClient.ModelSets.renameSet({ id: set.id, name: trimmed })
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
      data-testid={set === null ? 'txr-models-set-rename' : `txr-models-set-rename-${set.id}`}
      title={`Rename "${set?.name ?? ''}"`}
      open={set !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={onClose} data-testid={`txr-models-set-rename-${set?.id}-cancel`}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} data-testid={`txr-models-set-rename-${set?.id}-confirm`}>
            {CONFIRM_LABEL}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input
          data-testid={`txr-models-set-rename-${set?.id}-input`}
          aria-label="Set name"
          value={name}
          onChange={event => setName(event.target.value)}
        />
        {error !== null ? (
          <span data-testid={`txr-models-set-rename-${set?.id}-error`} style={ERROR}>
            {error}
          </span>
        ) : null}
      </div>
    </Dialog>
  )
}
