/**
 * TxrSaveOneDialog — dialog L2 (`SaveOne.dc.html`, ITEM-9): save ONE
 * produced model into a new or existing set.
 *
 * Self-contained like L (DEC-3): it loads the run detail (the summary
 * line's facts) + the set list (`PROV-MS-4`) ONCE per open, joins the
 * produced model row by `method_id` (the event's `methodId`), posts the
 * PROV-MS-3 body through `buildSaveOneRequest` and hands the response to
 * L3.
 *
 * The board's structure, verbatim where the data allows:
 *
 * - the title + the summary line ("<method id> · 0.1 MB · learned from N
 *   patients, decision day D" — the size and the learned-from facts are
 *   the produced model's/run's own; an absent fact omits its segment,
 *   never a blank);
 * - "Save it in": the select with "A new set" first, then each existing
 *   set with its model count ("<set name> (N models already saved)" —
 *   SetSummary's own count), and the "Name of the new set" input shown
 *   ONLY in the new-set case (the board's field);
 * - the "What is saved / Not saved" pair (the singular spelling);
 * - the keep-training-files checkbox (the board's subline; the "Adds
 *   about 4 MB" example size is a design example — INV-4 — never a
 *   constant);
 * - Cancel / Save the model. A server rejection surfaces inline — the
 *   dialog never closes on error.
 *
 * The L2 entry event (`txr:save-one-model-requested`) is emitted by the
 * H one-method view's "Save this model" button (ui-results' growth), so
 * this dialog is reachable, not a gallery-only state. Defensive: a run
 * whose detail carries no produced model for the id (a row the ui-results
 * gate would not emit) renders the honest "no model to save" state and
 * disables the save — never a fabricated size or a silent call.
 *
 * Controlled by `runId` (null = closed); Escape/backdrop close through
 * the kit Dialog's `onOpenChange`. Test-ids: `txr-models-saveone-*`.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Checkbox, Dialog, Input, Select, Skeleton } from '@ziee/kit'
import type { ModelSaveResponse, SetSummary, TxrRunDetail } from '@/api-client/types'
import { ApiClient } from '@/api-client'
import {
  WHAT_IS_SAVED_LABEL,
  NOT_SAVED_LABEL,
  NOT_SAVED_TEXT,
  SAVE_ONE_WHAT_IS_SAVED_TEXT,
  formatBytes,
} from '../lib/format'
import { buildSaveOneRequest, formatLearnedFrom } from '../lib/save'
import { useTxrModelsStore } from '../stores/TxrModels.store'

/** The one failure line of the load (the engine's message, else this
 *  constant). */
const LOAD_FAILED_LINE = 'The model could not be loaded.'

/** The one failure line of the save call (the engine's message, else
 *  this constant). */
const SAVE_FAILED_LINE = 'The model could not be saved.'

/** The dialog title (the board's words). */
const TITLE = 'Save this model'

/** The "Save it in" field label (the board's words). */
const SAVE_IN_LABEL = 'Save it in'

/** The new-set option's label (the board's words — first in the select). */
const NEW_SET_LABEL = 'A new set'

/** The new-set name field label (the board's words). */
const NEW_SET_NAME_LABEL = 'Name of the new set'

/** The keep-training-files label (the board's words). */
const KEEP_TRAINING_LABEL = 'Also keep a copy of my training files'

/** The keep-training-files subline (the board's words without the design
 *  example size — INV-4). */
const KEEP_TRAINING_HINT = 'So this run can be repeated. Delete the set to remove the copies.'

/** The no-model-to-save line (D15's honest state). */
const NO_MODEL_LINE = 'This method has no model to save.'

/** The summary line's mono id look. */
const MONO: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
  fontSize: 12.5,
  color: 'var(--txr-text-2)',
}

/** The muted lines' look. */
const SUBLINE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** The ruled-copy label + body looks. */
const SAVED_LABEL: CSSProperties = { fontWeight: 600, margin: '0 0 2px' }
const RULED_TEXT: CSSProperties = { margin: '0 0 8px', fontSize: 12.5, color: 'var(--txr-text-2)' }

/** The error line's look (the dialog's own muted red). */
const ERROR: CSSProperties = { fontSize: 13.5, color: 'var(--txr-danger)' }

/** The skeleton rows of the loading state. */
const SKELETON_ROWS = 3

/** The engine's message, else the caller's constant. */
function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return fallback
}

/** The summary line: "<id> · <size> · learned from N patients, decision
 *  day D" — segments omitted when their fact is absent (never a blank,
 *  never a fabricated number). */
function summaryLine(
  methodId: string,
  sizeBytes: number | null,
  learned: string | null,
): string {
  const parts = [methodId]
  if (sizeBytes !== null) parts.push(formatBytes(sizeBytes))
  if (learned !== null) parts.push(learned)
  return parts.join(' \u00b7 ')
}

export interface TxrSaveOneDialogProps {
  /** The run whose produced model the dialog saves; `null` = closed. */
  runId: string | null
  /** The event payload's method id. */
  methodId: string | null
  /** The close request (Escape / backdrop / Cancel). */
  onClose: () => void
  /** The save succeeded — the host renders L3 with the response. */
  onSaved: (response: ModelSaveResponse) => void
}

export function TxrSaveOneDialog({ runId, methodId, onClose, onSaved }: TxrSaveOneDialogProps) {
  const draftName = useTxrModelsStore(s => s.draftName)
  const setDraftName = useTxrModelsStore(s => s.setDraftName)

  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [run, setRun] = useState<TxrRunDetail | null>(null)
  const [sets, setSets] = useState<readonly SetSummary[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [target, setTarget] = useState<'new' | string>('new')
  const [keepTrainingFiles, setKeepTrainingFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const loadEpoch = useRef(0)

  /** One load sequence per open: the run detail + the set list. A failure
   *  of either is the dialog's error state (the summary line and the
   *  target select both need their facts). */
  const loadAll = useCallback(async (): Promise<void> => {
    if (runId === null) return
    const my = ++loadEpoch.current
    setLoadState('loading')
    setLoadError(null)
    try {
      const [detail, list] = await Promise.all([
        ApiClient.Txr.getRun({ id: runId }),
        ApiClient.ModelSets.listSets(),
      ])
      if (my !== loadEpoch.current) return
      setRun(detail)
      setSets(list.sets)
      setSaveError(null)
      setLoadState('ready')
    } catch (error) {
      if (my !== loadEpoch.current) return
      setLoadError(errorText(error, LOAD_FAILED_LINE))
      setLoadState('error')
    }
  }, [runId])

  useEffect(() => {
    setRun(null)
    setSets([])
    setTarget('new')
    setKeepTrainingFiles(false)
    setSaveError(null)
    setLoadState(runId === null ? 'idle' : 'loading')
    void loadAll()
    return () => {
      loadEpoch.current += 1
    }
  }, [loadAll, runId])

  const produced = run?.models.find(model => model.method_id === methodId) ?? null
  const producedSize =
    produced !== null && Number.isFinite(produced.size_bytes) ? produced.size_bytes : null
  const learned = formatLearnedFrom(
    produced?.trained_on_patients ?? run?.input_summary?.patients ?? null,
    run?.config?.decision_day ?? null,
  )
  const newName = draftName.trim()
  const canSave =
    run !== null &&
    produced !== null &&
    (target !== 'new' || newName.length > 0) &&
    !busy

  /** The target arm: `{set_id}` for an existing set, `{set_name}` for a
   *  new one. */
  const targetArms = (): { set_id: string } | { set_name: string } =>
    target === 'new' ? { set_name: newName } : { set_id: target }

  const save = async (): Promise<void> => {
    if (runId === null || methodId === null || produced === null) return
    if (target === 'new' && newName.length === 0) return
    setBusy(true)
    setSaveError(null)
    try {
      const response = await ApiClient.Models.saveModels(
        buildSaveOneRequest(runId, methodId, targetArms(), {
          keepTrainingFiles,
          alsoExport: false,
          sourceLabel: run?.input_summary?.file_names?.patients ?? null,
        }),
      )
      onSaved(response)
    } catch (error) {
      setSaveError(errorText(error, SAVE_FAILED_LINE))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      data-testid="txr-models-saveone"
      title={TITLE}
      open={runId !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      size="lg"
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={onClose} data-testid="txr-models-saveone-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!canSave}
            data-testid="txr-models-saveone-confirm"
          >
            Save the model
          </Button>
        </div>
      }
    >
      {loadState === 'error' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <span data-testid="txr-models-saveone-load-error" style={ERROR}>
            {loadError}
          </span>
          <Button data-testid="txr-models-saveone-retry" variant="outline" onClick={() => void loadAll()}>
            Retry
          </Button>
        </div>
      ) : run === null ? (
        <div data-testid="txr-models-saveone-loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Skeleton key={i} style={{ height: 40, borderRadius: 8 }} />
          ))}
        </div>
      ) : (
        <div data-testid="txr-models-saveone-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p data-testid="txr-models-saveone-summary" style={{ margin: 0, fontSize: 13 }}>
            <span style={MONO}>{summaryLine(methodId ?? '', producedSize, learned)}</span>
          </p>

          {produced === null ? (
            <span data-testid="txr-models-saveone-no-model" style={ERROR}>
              {NO_MODEL_LINE}
            </span>
          ) : (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{SAVE_IN_LABEL}</span>
                <Select
                  data-testid="txr-models-saveone-set-select"
                  aria-label={SAVE_IN_LABEL}
                  value={target}
                  onValueChange={setTarget}
                  options={[
                    { value: 'new', label: NEW_SET_LABEL },
                    ...sets.map(set => ({
                      value: set.id,
                      label: `${set.name} (${set.model_count} ${set.model_count === 1 ? 'model' : 'models'} already saved)`,
                    })),
                  ]}
                />
              </label>

              {target === 'new' ? (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{NEW_SET_NAME_LABEL}</span>
                  <Input
                    data-testid="txr-models-saveone-name"
                    aria-label={NEW_SET_NAME_LABEL}
                    value={draftName}
                    onChange={event => setDraftName(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          )}

          <div>
            <p style={SAVED_LABEL}>{WHAT_IS_SAVED_LABEL}</p>
            <p style={RULED_TEXT}>{SAVE_ONE_WHAT_IS_SAVED_TEXT}</p>
            <p style={SAVED_LABEL}>{NOT_SAVED_LABEL}</p>
            <p style={RULED_TEXT}>{NOT_SAVED_TEXT}</p>
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <Checkbox
              checked={keepTrainingFiles}
              data-testid="txr-models-saveone-keep-training"
              onCheckedChange={setKeepTrainingFiles}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span data-testid="txr-models-saveone-keep-training-label" style={{ fontSize: 13 }}>
                {KEEP_TRAINING_LABEL}
              </span>
              <span data-testid="txr-models-saveone-keep-training-hint" style={SUBLINE}>
                {KEEP_TRAINING_HINT}
              </span>
            </span>
          </label>

          {saveError !== null ? (
            <span data-testid="txr-models-saveone-error" style={ERROR}>
              {saveError}
            </span>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
