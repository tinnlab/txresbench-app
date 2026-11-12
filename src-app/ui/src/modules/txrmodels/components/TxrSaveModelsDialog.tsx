/**
 * TxrSaveModelsDialog — dialog L (`SaveModels.dc.html`, ITEM-9): save the
 * finished run's produced models as a NEW set.
 *
 * The dialog is self-contained (DEC-3): it loads the run detail + the
 * predictions + the method catalogue ONCE per open (CONS-UM-12,
 * CONS-UM-22), builds the checklist through `lib/save.ts`'s pure helpers,
 * posts the PROV-MS-3 body through `buildSaveSetRequest` and hands the
 * response to L3 (`onSaved`). It never reads another module's store — the
 * event payload (`runId` + `methodIds`) is the entry, the run detail is
 * the truth.
 *
 * The board's structure, verbatim where the data allows:
 *
 * - the title + the lead ("Keep them to predict new
 *   patients later, without the training data.");
 * - "Name of this set" (the module store's `draftName` — the one draft
 *   field the dialogs share) + the "Made from patients.csv, N patients,
 *   decision day D, <predicts>." line (the engine's grown input summary,
 *   the predictions' patient count as the defensive fallback);
 * - "Models to save" + the count line ("N of M selected · about X MB" —
 *   the Σ of the produced models' recorded sizes, `formatBytes`), Select
 *   none / Only the small ones (DEC-15's `SMALL_MODEL_MB` cutoff), the
 *   checklist rows (mono id, the run's group label, the size), and the
 *   cannot-run note per `cannot_run` method (D15: "report nothing to
 *   save" — the row is named, never silently dropped);
 * - the training-data warning (the method catalogue's
 *   `embeds_training_data` fact — never app-invented, DEC-15) and the
 *   "What is saved / Not saved" pair;
 * - the two checkboxes: keep a copy of the training files (the board's
 *   copy — the "Adds about 4 MB" example size and the
 *   Documents/TxResBench/ example path are DESIGN EXAMPLES, INV-4: the
 *   dialog renders the board's sentence without them; the real folder is
 *   the J screen's `models_dir`) and "Also save as a file";
 * - Cancel / Save N models. Save is refused (disabled) while the name is
 *   empty or no model is selected; a server rejection (409 SET_NAME_TAKEN
 *   / 404 RUN_NOT_FOUND) surfaces inline with the engine's message — the
 *   dialog never closes on error.
 *
 * The L2 event's `methodIds` are the finished methods' ids; the produced
 * models are the saveable set (a finished method with no model is D15's
 * nothing-to-save row — the checklist is `run.models`, never the event's
 * list). The initial selection is the payload filtered to the produced
 * models, the select-all board default when the payload names none.
 *
 * Controlled by `runId` (null = closed); Escape/backdrop close through
 * the kit Dialog's `onOpenChange`. Test-ids: `txr-models-save-*`.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Alert, Button, Checkbox, Dialog, Input, Skeleton } from '@txresbench/kit'
import type { MethodSummary, ModelSaveResponse, TxrPredictionsResponse, TxrRunDetail } from '@/api-client/types'
import { ApiClient } from '@/api-client'
import {
  WHAT_IS_SAVED_LABEL,
  NOT_SAVED_LABEL,
  NOT_SAVED_TEXT,
  SAVE_SET_WHAT_IS_SAVED_TEXT,
  formatBytes,
  formatTrainingDataWarning,
} from '../lib/format'
import {
  SMALL_MODEL_MB,
  buildSaveChecklist,
  buildSaveSetRequest,
  cannotRunNotes,
  formatMadeFrom,
  initialSaveSelection,
  onlySmallModels,
  saveCountLine,
  totalSelectedBytes,
  trainingDataModelNames,
} from '../lib/save'
import { useTxrModelsStore } from '../stores/TxrModels.store'

/** The one failure line of the run-detail load (the engine's message,
 *  else this constant). */
const LOAD_FAILED_LINE = 'The run could not be loaded.'

/** The one failure line of the save call (the engine's message, else
 *  this constant). */
const SAVE_FAILED_LINE = 'The models could not be saved.'

/** The dialog title (the board's words). */
const TITLE = 'Save the models'

/** The lead paragraph (the board's words, verbatim). */
const DESCRIPTION =
  'Keep them to predict new patients later, without the training data.'

/** The set-name field label (the board's words). */
const NAME_LABEL = 'Name of this set'

/** The "Models to save" section head (the board's words). */
const MODELS_LABEL = 'Models to save'

/** The two "what is saved" leads' look. */
const SAVED_LABEL: CSSProperties = { fontWeight: 600, margin: '0 0 2px' }

/** The rule-of-copy body lines' look. */
const RULED_TEXT: CSSProperties = { margin: '0 0 8px', fontSize: 12.5, color: 'var(--txr-text-2)' }

/** The facts line's look ("Made from …"). */
const MADE_FROM: CSSProperties = { margin: '4px 0 0', fontSize: 12, color: 'var(--txr-muted)' }

/** The muted section-subline look. */
const SUBLINE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** The error looks (the dialog's own muted red). */
const ERROR: CSSProperties = { fontSize: 13.5, color: 'var(--txr-danger)' }

/** The checklist row's board look (the mono id + the group label). */
const ROW_NAME: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
  fontSize: 12.5,
  color: 'var(--txr-text-2)',
}

/** The row's right-aligned size (the board's checklist column). */
const ROW_SIZE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** The group label's muted look. */
const ROW_GROUP: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** One checklist row's layout (the board's row: checkbox, name + group,
 *  size right). */
const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '5px 0',
}

/** The name+group stack of a checklist row. */
const ROW_TEXT: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1 }

/** The cannot-run note's muted look. */
const NOTE: CSSProperties = { margin: '6px 0 0', fontSize: 12.5, color: 'var(--txr-muted)' }

/** The skeleton rows of the loading state. */
const SKELETON_ROWS = 4

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

/** The board's "Made from …" line's patient-count fallback: the predictions the
 *  run produced (their patient ids ARE the run's patients) when the input
 *  summary carries no count. */
function predictPatientCount(predictions: TxrPredictionsResponse | null): number | null {
  return predictions === null ? null : predictions.patients.length
}

/**
 * The trained-on reconciliation line (qa-fixes RES-15): the dialog's
 * "Made from patients.csv, 94 patients" counts the FILE, the model rows'
 * "Trained on 73" the run's actual training cohort (the patients with the
 * draws and outcomes the run needs) — the two numbers are explained, never
 * left to argue. Null when the run carries no produced model, the cohort is
 * unknown, or the two counts already agree.
 */
function trainedOnNote(run: TxrRunDetail, filePatients: number | null): { trained: number; file: number } | null {
  const trained = run.models.reduce((max, model) => Math.max(max, model.trained_on_patients ?? 0), 0)
  if (trained <= 0 || filePatients === null || filePatients <= 0 || trained === filePatients) {
    return null
  }
  return { trained, file: filePatients }
}

export interface TxrSaveModelsDialogProps {
  /** The run whose produced models the dialog saves; `null` is the closed
   *  dialog. */
  runId: string | null
  /** The event payload's finished method ids (the initial selection's
   *  request). */
  methodIds: string[]
  /** The close request (Escape / backdrop / Cancel). */
  onClose: () => void
  /** The save succeeded — the host renders L3 with the response. */
  onSaved: (response: ModelSaveResponse) => void
}

export function TxrSaveModelsDialog({
  runId,
  methodIds,
  onClose,
  onSaved,
}: TxrSaveModelsDialogProps) {
  const draftName = useTxrModelsStore(s => s.draftName)
  const setDraftName = useTxrModelsStore(s => s.setDraftName)

  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [run, setRun] = useState<TxrRunDetail | null>(null)
  const [predictions, setPredictions] = useState<TxrPredictionsResponse | null>(null)
  const [methods, setMethods] = useState<readonly MethodSummary[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [keepTrainingFiles, setKeepTrainingFiles] = useState(false)
  const [alsoExport, setAlsoExport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const loadEpoch = useRef(0)

  /** One load sequence per open: the run detail first (its failure is the
   *  dialog's error state — the checklist has no other truth), then the
   *  predictions + the method catalogue (degrading reads: a failed
   *  predictions read only costs the patient-count fallback, a failed
   *  catalogue read the training-data facts — never a blocked save). The
   *  epoch guard keeps a late resolve (or a resolve after close) from
   *  writing. */
  const loadAll = useCallback(async (): Promise<void> => {
    if (runId === null) return
    const my = ++loadEpoch.current
    setLoadState('loading')
    setLoadError(null)
    try {
      const detail = await ApiClient.Txr.getRun({ id: runId })
      if (my !== loadEpoch.current) return
      const [preds, catal] = await Promise.allSettled([
        ApiClient.Txr.getPredictions({ id: runId }),
        ApiClient.MethodCatalogue.list({}),
      ])
      if (my !== loadEpoch.current) return
      const methodRows =
        catal.status === 'fulfilled' ? catal.value.methods : ([] as MethodSummary[])
      setRun(detail)
      setPredictions(preds.status === 'fulfilled' ? preds.value : null)
      setMethods(methodRows)
      setSelected(initialSaveSelection(buildSaveChecklist(detail, methodRows), methodIds))
      setSaveError(null)
      setLoadState('ready')
    } catch (error) {
      if (my !== loadEpoch.current) return
      setLoadError(errorText(error, LOAD_FAILED_LINE))
      setLoadState('error')
    }
  }, [runId, methodIds])

  useEffect(() => {
    setRun(null)
    setPredictions(null)
    setMethods([])
    setSelected(new Set())
    setSaveError(null)
    setLoadState(runId === null ? 'idle' : 'loading')
    void loadAll()
    return () => {
      loadEpoch.current += 1
    }
  }, [loadAll, runId])

  const entries = run === null ? [] : buildSaveChecklist(run, methods)
  const selectedList = [...selected]
  const totalBytes = totalSelectedBytes(selected, entries)
  const countLine = saveCountLine(selected.size, entries.length, totalBytes)
  const warning = formatTrainingDataWarning(trainingDataModelNames(entries))
  const notes = run === null ? [] : cannotRunNotes(run)
  const name = draftName.trim()
  const canSave = entries.length > 0 && selected.size > 0 && name.length > 0 && !busy
  const trainedNote = run === null ? null : trainedOnNote(run, predictPatientCount(predictions))

  const toggle = (methodId: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(methodId)) {
        next.delete(methodId)
      } else {
        next.add(methodId)
      }
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (runId === null || selected.size === 0 || name.length === 0) return
    setBusy(true)
    setSaveError(null)
    try {
      const response = await ApiClient.Models.saveModels(
        buildSaveSetRequest(runId, selectedList, name, {
          keepTrainingFiles,
          alsoExport,
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
      data-testid="txr-models-save"
      title={TITLE}
      description={DESCRIPTION}
      open={runId !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      size="lg"
      footer={
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={onClose} data-testid="txr-models-save-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!canSave}
            data-testid="txr-models-save-confirm"
          >
            Save {selected.size} {selected.size === 1 ? 'model' : 'models'}
          </Button>
        </div>
      }
    >
      {loadState === 'error' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <span data-testid="txr-models-save-load-error" style={ERROR}>
            {loadError}
          </span>
          <Button data-testid="txr-models-save-retry" variant="outline" onClick={() => void loadAll()}>
            Retry
          </Button>
        </div>
      ) : run === null ? (
        <div data-testid="txr-models-save-loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Skeleton key={i} style={{ height: 40, borderRadius: 8 }} />
          ))}
        </div>
      ) : (
        <div data-testid="txr-models-save-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{NAME_LABEL}</span>
            <Input
              data-testid="txr-models-save-name"
              aria-label={NAME_LABEL}
              placeholder="Name this set"
              value={draftName}
              onChange={event => setDraftName(event.target.value)}
            />
            <span data-testid="txr-models-save-made-from" style={MADE_FROM}>
              {formatMadeFrom(run, predictPatientCount(predictions))}
            </span>
            {trainedNote !== null ? (
              <span data-testid="txr-models-save-trained-on" style={SUBLINE}>
                The models are trained on the {trainedNote.trained} of the {trainedNote.file}{' '}
                patients with the draws and outcomes this run needs.
              </span>
            ) : null}
            {name.length === 0 ? (
              <span data-testid="txr-models-save-name-hint" style={SUBLINE}>
                Name the set to save the models.
              </span>
            ) : null}
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{MODELS_LABEL}</span>
              <span data-testid="txr-models-save-count" style={SUBLINE}>
                {countLine}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button
                variant="outline"
                data-testid="txr-models-save-select-none"
                onClick={() => setSelected(new Set())}
              >
                Select none
              </Button>
              <Button
                variant="outline"
                data-testid="txr-models-save-only-small"
                onClick={() => setSelected(new Set(onlySmallModels(entries)))}
              >
                {`Only the small ones (under ${SMALL_MODEL_MB} MB)`}
              </Button>
            </div>
          </div>

          <div data-testid="txr-models-save-list" style={{ display: 'flex', flexDirection: 'column' }}>
            {entries.map(entry => (
              <label key={entry.methodId} style={ROW} data-testid={`txr-models-save-row-${entry.methodId}`}>
                <Checkbox
                  checked={selected.has(entry.methodId)}
                  aria-label={entry.methodId}
                  data-testid={`txr-models-save-check-${entry.methodId}`}
                  onCheckedChange={() => toggle(entry.methodId)}
                />
                <span style={ROW_TEXT}>
                  <span style={ROW_NAME}>{entry.methodId}</span>
                  {entry.groupLabel !== null ? <span style={ROW_GROUP}>{entry.groupLabel}</span> : null}
                </span>
                {entry.sizeBytes !== null ? (
                  <span style={{ ...ROW_SIZE, marginLeft: 'auto' }}>{formatBytes(entry.sizeBytes)}</span>
                ) : null}
              </label>
            ))}
          </div>

          {notes.length > 0 ? (
            <div data-testid="txr-models-save-cannot-run">
              {notes.map(note => (
                <p key={note} style={NOTE}>
                  {note}
                </p>
              ))}
            </div>
          ) : null}

          {warning.length > 0 ? (
            <Alert tone="warning" data-testid="txr-models-save-warning" title={warning} />
          ) : null}

          <div>
            <p style={SAVED_LABEL}>{WHAT_IS_SAVED_LABEL}</p>
            <p style={RULED_TEXT}>{SAVE_SET_WHAT_IS_SAVED_TEXT}</p>
            <p style={SAVED_LABEL}>{NOT_SAVED_LABEL}</p>
            <p style={RULED_TEXT}>{NOT_SAVED_TEXT}</p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Checkbox
                checked={keepTrainingFiles}
                data-testid="txr-models-save-keep-training"
                onCheckedChange={setKeepTrainingFiles}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span data-testid="txr-models-save-keep-training-label" style={{ fontSize: 13 }}>
                  Also keep a copy of my training files, so this run can be repeated
                </span>
                <span data-testid="txr-models-save-keep-training-hint" style={SUBLINE}>
                  They are kept with the set. Delete the set to remove them.
                </span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Checkbox
                checked={alsoExport}
                data-testid="txr-models-save-also-export"
                onCheckedChange={setAlsoExport}
              />
              <span data-testid="txr-models-save-also-export-label" style={{ fontSize: 13 }}>
                Also save as a file
              </span>
            </label>
          </div>

          {saveError !== null ? (
            <span data-testid="txr-models-save-error" style={ERROR}>
              {saveError}
            </span>
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
