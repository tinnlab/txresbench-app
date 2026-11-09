/**
 * TxrSavedDialog — dialog L3 (`SaveDone.dc.html`, ITEM-9): the saved
 * confirmation with the three board actions.
 *
 * The summary reads the PROV-MS-3 response: "N models saved" (the count of
 * the response's saved rows — the models THIS call saved), the quoted set
 * name + the total size (the Σ of the saved rows' `size_bytes`,
 * `formatBytes` — never a blank, never "0 MB" for a missing fact) and the
 * "in …" where-segment (the REAL models root — `ModelListResponse.
 * models_dir`, CONS-UM-4's one-shot exposure; the board's
 * Documents/TxResBench/models/ path is a design example, INV-4 — the
 * where-segment is omitted when the server reports no root).
 *
 * The three actions (the board's words):
 *
 * - "Predict new patients with them" — the DEC-10 handoff's intent
 *   (`setIntent('reuse')`) + the N screen (`predictFilesPath()` — the
 *   same route the J "Use" handoff uses);
 * - "See my models" — `modelsPath()` (screen J, this module's own);
 * - "Done" — close.
 *
 * The dialog never performs a second save (the save succeeded — L3 is a
 * report); a navigation (or Done) closes it. `response` null = closed;
 * Escape/backdrop close through the kit Dialog's `onOpenChange`.
 * Test-ids: `txr-models-saved-*`.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Dialog } from '@ziee/kit'
import type { ModelSaveResponse } from '@/api-client/types'
import { ApiClient } from '@/api-client'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { predictFilesPath } from '@/modules/txrrun'
import { formatBytes } from '../lib/format'
import { modelsPath } from '../routes'

/** The "see my models" button's label (the board's words). */
const SEE_MODELS_LABEL = 'See my models'

/** The "predict with them" button's label (the board's words). */
const PREDICT_LABEL = 'Predict new patients with them'

/** The lead paragraph (the board's words, verbatim). */
const LEAD_TEXT =
  "They are listed under Models. To use them, add new patients' measurements and pick the models you want."

/** The summary line's look (the board's quiet line). */
const SUMMARY: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--txr-text-2)' }

/** The lead paragraph's look. */
const LEAD: CSSProperties = { margin: '6px 0 0', fontSize: 13, color: 'var(--txr-muted)' }

/** The models root's mono look (the folder the models live in). */
const PATH: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
  fontSize: 12.5,
  color: 'var(--txr-text-2)',
}

/** The separator between the summary's segments (the board's " · "). */
const SEP = ' \u00b7 '

/**
 * The summary's size segment: the Σ of the saved rows' recorded sizes; a
 * row with a non-finite size makes the total unknown (a number that
 * omits a size would understate) — the segment is then omitted, never
 * written as a false total.
 */
function summarySize(models: ReadonlyArray<ModelSaveResponse['models'][number]>): string | null {
  let total = 0
  for (const model of models) {
    if (!Number.isFinite(model.size_bytes)) return null
    total += model.size_bytes
  }
  return formatBytes(total)
}

/** The summary line: the quoted set name, the size, the where-segment. */
function summaryLine(response: ModelSaveResponse, modelsRoot: string | null): string {
  const parts = [`\u201c${response.set.name}\u201d`]
  const size = summarySize(response.models)
  if (size !== null) parts.push(size)
  if (modelsRoot !== null) parts.push(`in ${modelsRoot}`)
  return parts.join(SEP)
}

export interface TxrSavedDialogProps {
  /** The save response; `null` is the closed dialog. */
  response: ModelSaveResponse | null
  /** The close request (Done / Escape / backdrop). */
  onClose: () => void
}

export function TxrSavedDialog({ response, onClose }: TxrSavedDialogProps) {
  const navigate = useNavigate()
  const [modelsRoot, setModelsRoot] = useState<string | null>(null)
  const dirEpoch = useRef(0)

  // The one extra fact: the real models folder (CONS-UM-4's one-shot
  // `models_dir`) — the where-segment of the board's summary line. A
  // failure degrades to the pathless sentence (the segment omits), never
  // blocks the confirmation.
  useEffect(() => {
    if (response === null) {
      setModelsRoot(null)
      return
    }
    const my = ++dirEpoch.current
    void ApiClient.Models.listModels({})
      .then(list => {
        if (my !== dirEpoch.current) return
        setModelsRoot(list.models_dir ?? null)
      })
      .catch(() => {
        if (my !== dirEpoch.current) return
        setModelsRoot(null)
      })
    return () => {
      dirEpoch.current += 1
    }
  }, [response])

  const predictWithThem = (): void => {
    if (response === null) return
    useTxrIntakeStore.getState().setIntent('reuse')
    navigate(predictFilesPath())
    onClose()
  }

  const seeModels = (): void => {
    navigate(modelsPath())
    onClose()
  }

  return (
    <Dialog
      data-testid="txr-models-saved"
      title={response === null ? '' : `${response.models.length} ${response.models.length === 1 ? 'model' : 'models'} saved`}
      open={response !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button variant="outline" data-testid="txr-models-saved-done" onClick={onClose}>
            Done
          </Button>
          <Button variant="outline" data-testid="txr-models-saved-see-models" onClick={seeModels}>
            {SEE_MODELS_LABEL}
          </Button>
          <Button data-testid="txr-models-saved-predict" onClick={predictWithThem}>
            {PREDICT_LABEL}
          </Button>
        </div>
      }
    >
      <p data-testid="txr-models-saved-summary" style={SUMMARY}>
        <span style={PATH}>{response === null ? '' : summaryLine(response, modelsRoot)}</span>
      </p>
      <p data-testid="txr-models-saved-lead" style={LEAD}>
        {LEAD_TEXT}
      </p>
    </Dialog>
  )
}