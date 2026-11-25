/**
 * txrmodels — the shared `.txr` model-file import (`useModelFileImport`),
 * the ONE implementation behind BOTH surfaces that open a model file:
 *
 * - the Models page's "Open a model file" button (its hidden input, `POST
 *   /api/txr/models/import` — CONS-UM-9 — and the two error lines), and
 * - the Start page's card-2 "Open a model file" button (predict-card
 *   merge round 1): the picker opens in place over the Start card, and a
 *   successful import navigates to the Models page (via the host's
 *   `onImported`).
 *
 * The hook owns ONLY the picker + the POST + its two error lines; both
 * hosts render the input and call `importFile`, and the success side is
 * the host's (`refresh` on the Models page, navigation on the Start card).
 * The hidden input is the same native-control-ok pattern the Models page
 * used (the visible affordance is a Button; the input is invisible).
 *
 * The hook ALSO registers itself as the `models.openModelFile` picker
 * host (the `lib/modelFilePicker.ts` channel): a human click runs the
 * action, the action asks the channel, and the mounted host opens its
 * input in place (the action's agent path has no host/gesture and
 * navigates instead). The host only answers when a user activation is
 * active — an agent invocation can never open a picker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import { registerModelFilePicker } from '../lib/modelFilePicker'

/** The import failure's fallback (never blank). */
export const IMPORT_FAILED_LINE = 'The model file could not be opened.'

/** The import clash line (the server's 409 SET_NAME_TAKEN): the container's
 *  recorded set name is taken — the hosts name the remedy instead of the
 *  engine's words (rename the set, or open the file from inside that set). */
export const IMPORT_NAME_TAKEN_LINE =
  'A set with this name already exists. Rename that set first, or open the file from inside it to add its models.'

/** True for the server's `SET_NAME_TAKEN` import refusal (the framework
 *  transport attaches the server's `error_code` to the thrown Error —
 *  `error_code`, the one stable machine code, never the message). */
export function isSetNameTaken(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { error_code?: unknown }).error_code === 'SET_NAME_TAKEN'
  )
}

export interface UseModelFileImportOptions {
  /** The `?set=` focus id (the Models page's focused view): the import
   *  rides `set_id` so a focused import lands in the focused set. */
  setId?: string | null
  /** Called after a successful import (the Models page refreshes its
   *  inventory; the Start card navigates to the Models page). */
  onImported?: () => void
}

export interface UseModelFileImportResult {
  /** The import failure line; `null` when healthy. */
  error: string | null
  /** Forget the error (the visible affordance's click resets it). */
  clearError: () => void
  /** The input's props (spread onto the hidden file input): ref, type,
   *  accept, the hidden styling, and the change handler that hands the
   *  picked file to `importFile` (clearing the input synchronously so the
   *  same file can be picked again). A host adds its own `data-testid`. */
  inputProps: {
    ref: React.RefObject<HTMLInputElement | null>
    type: 'file'
    accept: string
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  }
  /** Open the hidden picker (the host's own user-gesture click). */
  openPicker: () => void
  /** POST the picked container (multipart, the `file` part) and report
   *  success; the two error lines (SET_NAME_TAKEN names the remedy, every
   *  other failure is the steady open-failed line — never the transport's
   *  own words). The failure's detail is still logged (the fixed line is
   *  the user-facing copy, not the whole record). */
  importFile: (file: File) => Promise<boolean>
}

/** A user activation is active (the human's own click) — the agent path
 *  never has one, so it can never open a picker. jsdom exposes no
 *  `navigator.userActivation` (tests stub it for the human path). */
function userActivationActive(): boolean {
  const activation = (
    typeof navigator !== 'undefined' ? (navigator as { userActivation?: { isActive: boolean } }).userActivation : undefined
  )
  return activation?.isActive === true
}

export function useModelFileImport(options: UseModelFileImportOptions = {}): UseModelFileImportResult {
  const { setId = null, onImported } = options
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const clearError = useCallback((): void => {
    setError(null)
  }, [])

  const importFile = useCallback(
    async (file: File): Promise<boolean> => {
      setError(null)
      const form = new FormData()
      form.append('file', file, file.name)
      if (setId !== null) form.append('set_id', setId)
      try {
        await ApiClient.Models.importModel(form)
        onImported?.()
        return true
      } catch (importError) {
        // The one clash answer (SET_NAME_TAKEN) names the remedy; every
        // other failure is the steady open-failed line. brief 3b: the
        // failure's detail is still logged.
        if (isSetNameTaken(importError)) {
          setError(IMPORT_NAME_TAKEN_LINE)
        } else {
          console.warn('model import failed', importError)
          setError(IMPORT_FAILED_LINE)
        }
        return false
      }
    },
    [setId, onImported],
  )

  const openPicker = useCallback((): void => {
    inputRef.current?.click()
  }, [])

  // The instance is the `models.openModelFile` host: answer the action's
  // picker request only when a user activation is active (a human click),
  // so the agent path is never handed a picker.
  useEffect(
    () =>
      registerModelFilePicker(() => {
        if (!userActivationActive()) return false
        openPicker()
        return true
      }),
    [openPicker],
  )

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0] ?? null
      // Cleared synchronously so picking the same file again re-fires.
      event.target.value = ''
      if (file !== null) void importFile(file)
    },
    [importFile],
  )

  return {
    error,
    clearError,
    inputProps: {
      ref: inputRef,
      type: 'file',
      accept: '.txr',
      onChange,
    },
    openPicker,
    importFile,
  }
}
