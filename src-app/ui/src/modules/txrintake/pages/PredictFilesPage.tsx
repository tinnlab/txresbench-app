import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Upload } from '@ziee/kit'
import { ApiClient } from '@/api-client'
import type { FileTableKind, ValidationResponse } from '@/api-client/types'
import { parseCsvFile } from '@/lib/txr-files/csv'
import { parseWorkbookFile } from '@/lib/txr-files/workbook'
import { useStore } from 'zustand'
import { TxrIntake, useTxrIntakeStore } from '../stores/TxrIntake.store'
import {
  cardProblems,
  hasErrorProblems,
  inspectRequest,
  predictMeasurementsStatus,
  resolveJoins,
  resolveMapping,
  validateRequest,
} from '../lib/flow'
import { fetchTemplateCsv, downloadText, templateFilename } from '../lib/download'
import { ROUTE_CONVENTIONS } from '../module'
import type { LoadedFile } from '../types'

/**
 * Screen N — Add the patients to predict (board PredictFiles.dc.html,
 * ITEM-7): the predict-mode variant of the C flow. ONE measurements card
 * (no patients file, no outcomes — the board's "No outcomes are needed, and
 * no patients file." line), the "What the models look for" aside, and the
 * Continue gate into the model choice screens: `/pretrained-models` for
 * intent `pretrained` (screen D) and `/saved-models` for `reuse` (screen I).
 *
 * INV-2's flow, one pipe for C and N (DRIFT-1 ITEM-6 #9: the card markup
 * stays inline until ITEM-9's component extraction — the test-ids and the
 * store actions are already the PROV-UI-INTAKE-5 surface): drop →
 * PROV-FV-7 parse → PROV-FV-2 inspect (as soon as chosen) → PROV-FV-3
 * validate in `mode: 'predict'` (AUTOMATICALLY once the one file is present
 * — the second-table wait and the MISSING_PATIENTS branch do not apply,
 * PROV-FV-3). The same store actions and the same `lib/flow` functions back
 * the C and E screens.
 *
 * The card's green box on THIS screen keeps the board's own continuation —
 * "Found … rows: markers …; draws at day …. Next you choose the models that
 * can run on it." (predictMeasurementsStatus) — where the C screen ends the
 * same line with "Ready.".
 *
 * Suggestion discipline (DEC-9) and the Continue gate (DEC-10) are the C
 * screen's: joins/vocabulary offers are confirmed, never auto-applied (the
 * non-fuzzy ladder matches are the same marker by the vocabulary's own
 * declaration and are recorded without a step), and only error-severity
 * problems block the Continue button.
 *
 * Copy rule (DEC-13): the labels and the aside are the board's words
 * VERBATIM; every number (row counts, marker names, draw days, the N in the
 * status line) is computed from the inspections and the validate response —
 * nowhere hardcoded.
 *
 * The aside's "Answer the questions about your study" clause is the
 * clickable affordance (the ITEM-4 banner precedent): the board's static
 * span becomes a react-router `Link` to `/study` (the round trip works — a
 * predict-intent Continue on B comes back to this screen), while the copy
 * keeps the board's words.
 */

const STUDY_ROUTE = '/study'

const PAGE_CONTAINER: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '40px 48px',
  maxWidth: 1280,
  margin: '0 auto',
  width: '100%',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
}

/** The board's left main column (the card + the Continue footer). */
const MAIN_COLUMN: CSSProperties = {
  flex: '3 1 620px',
  minWidth: 0,
  boxSizing: 'border-box',
  paddingRight: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

/** The board's right grey aside ("What the models look for"). */
const ASIDE: CSSProperties = {
  flex: '1 1 380px',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '26px 28px',
  background: '#fbfaf8',
  borderLeft: '1px solid #e7e5e0',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const ASIDE_EYEBROW: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#5e5e5e',
}

const ASIDE_PARA: CSSProperties = { margin: 0, fontSize: 14, color: '#3a3a3a' }

const ASIDE_LIST: CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 14.5, color: '#3a3a3a' }

/** The board's "Not sure what you have?" note (the study clause is a link). */
const ASIDE_NOTE: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #e7e5e0',
  borderRadius: 8,
  background: '#ffffff',
  fontSize: 13.5,
  color: '#3a3a3a',
}

const ASIDE_LINK: CSSProperties = { color: '#1d4e89', fontWeight: 600 }

/** The board's bottom line — the predict-mode promise, static. */
const ASIDE_FOOTER: CSSProperties = { marginTop: 'auto', fontSize: 13.5, color: '#5e5e5e' }

const STEP_LINE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#1d4e89',
}

const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

const INTRO: CSSProperties = {
  margin: 0,
  color: '#3a3a3a',
  maxWidth: '62ch',
}

/** One card section (the board's bordered card). */
const CARD: CSSProperties = {
  border: '1px solid #cfcdc7',
  borderRadius: 12,
  background: '#ffffff',
  padding: '18px 20px',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 22,
}

const CARD_LEFT: CSSProperties = { flex: '1 1 340px', minWidth: 0 }
const CARD_RIGHT: CSSProperties = {
  flex: '1 1 420px',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const CARD_TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 20,
}

const CARD_DESC: CSSProperties = { margin: '2px 0 10px', color: '#3a3a3a', fontSize: 14 }

/** The static per-role column table (board bytes: role, tag, copy). */
const ROLE_TABLE: CSSProperties = { borderCollapse: 'collapse' }
const ROLE_NAME: CSSProperties = {
  padding: '3px 10px 3px 0',
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12.5,
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
}
const ROLE_TAG: CSSProperties = {
  padding: '3px 10px 3px 0',
  fontSize: 12.5,
  color: '#5e5e5e',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
}
const ROLE_COPY: CSSProperties = { padding: '3px 0', fontSize: 13, color: '#3a3a3a' }

/** The board's per-role column table: grouped role rows, verbatim copy. */
interface RoleRow {
  roles: string[]
  tag: 'required' | 'optional'
  copy: string
}

/**
 * The N screen's measurements column table — the board's own copy, which
 * differs from the C screen's in the per-role wording (no "the same in both
 * files" — there IS no patients file on this screen).
 */
const PREDICT_ROLES: RoleRow[] = [
  { roles: ['patient_id'], tag: 'required', copy: 'your own code' },
  { roles: ['day'], tag: 'required', copy: 'days from the start of treatment' },
  { roles: ['marker'], tag: 'required', copy: 'for example LDH, ctDNA' },
  { roles: ['value'], tag: 'required', copy: 'a number' },
  { roles: ['unit'], tag: 'optional', copy: 'lets us check the scale against the model' },
]

const EXAMPLE_LABEL: CSSProperties = { fontSize: 13, color: '#5e5e5e' }
const EXAMPLE_TABLE: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid #cfcdc7',
  borderRadius: 8,
  borderCollapse: 'collapse',
  width: '100%',
}
const EXAMPLE_HEAD: CSSProperties = {
  textAlign: 'left',
  padding: '4px 10px',
  background: '#f7f6f3',
  borderBottom: '1px solid #cfcdc7',
  fontWeight: 600,
  fontSize: 12.5,
}
const EXAMPLE_ENTRY: CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid #efede8',
  fontSize: 12.5,
}
const EXAMPLE_CODE: CSSProperties = {
  ...EXAMPLE_ENTRY,
  fontFamily: "'Source Code Pro', monospace",
}

const DOWNLOADS: CSSProperties = { display: 'flex', gap: 14, alignItems: 'center' }
const DOWNLOAD_LINK: CSSProperties = {
  fontSize: 13.5,
  color: '#1d4e89',
  fontWeight: 600,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}
const DOWNLOAD_LINK_PLAIN: CSSProperties = { ...DOWNLOAD_LINK, fontWeight: 400 }

/** Status boxes: green ready, red problems, the neutral "checking" state. */
const STATUS: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}
const STATUS_GOOD: CSSProperties = { ...STATUS, border: '1px solid #b9dcc4', background: '#f1f9f3' }
const STATUS_BAD: CSSProperties = { ...STATUS, border: '1px solid #f0c9c4', background: '#fdf3f2' }
const STATUS_NEUTRAL: CSSProperties = {
  ...STATUS,
  border: '1px solid #e7e5e0',
  background: '#fbfaf8',
}

const STATUS_HEADING: CSSProperties = { fontWeight: 700, margin: 0 }
const STATUS_GOOD_HEADING: CSSProperties = { ...STATUS_HEADING, color: '#1f6b3a' }
const STATUS_BAD_HEADING: CSSProperties = { ...STATUS_HEADING, color: '#b3261e' }
const STATUS_LINE: CSSProperties = { fontSize: 13.5, color: '#3a3a3a', margin: 0 }

/** The per-row problem list (severity colors, DEC-14). */
const PROBLEM_LIST: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5 }
const PROBLEM_ERROR: CSSProperties = { color: '#b3261e' }
const PROBLEM_WARNING: CSSProperties = { color: '#8a5a00' }

/** A warning-only group under the ready box (warnings never block, DEC-10). */
const WARNING_GROUP: CSSProperties = {
  borderTop: '1px solid #efede8',
  marginTop: 8,
  paddingTop: 6,
}
const WARNING_TITLE: CSSProperties = { fontWeight: 700, color: '#8a5a00', fontSize: 13 }

const FIX_LINK: CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: '#1d4e89',
  fontWeight: 600,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}

/** The offer rows (join + vocabulary confirmations). */
const OFFER_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  border: '1px solid #e7e5e0',
  borderRadius: 8,
  background: '#fbfaf8',
  fontSize: 13.5,
}
const OFFER_TEXT: CSSProperties = { flex: '1 1 200px', minWidth: 0, color: '#3a3a3a' }
const OFFER_ACTION: CSSProperties = { borderRadius: 6, fontSize: 13, fontWeight: 600 }
const OFFER_ACCEPT: CSSProperties = {
  ...OFFER_ACTION,
  background: '#1d4e89',
  color: '#ffffff',
  border: 'none',
  padding: '5px 12px',
}
const OFFER_DECLINE: CSSProperties = {
  ...OFFER_ACTION,
  background: '#ffffff',
  color: '#141414',
  border: '1px solid #cfcdc7',
  padding: '4px 11px',
}

/** The drop zone (board copy; the kit Upload is the only file input). */
const DROPZONE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '14px 16px',
  border: '2px dashed #b3261e',
  borderRadius: 10,
  background: '#fbfaf8',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'left',
}
const DROPZONE_TEXT: CSSProperties = { display: 'block', flex: '1 1 auto', minWidth: 0 }
const DROPZONE_TITLE: CSSProperties = { display: 'block', fontWeight: 600 }
const DROPZONE_HINT: CSSProperties = { display: 'block', fontSize: 13, color: '#5e5e5e' }
const DROPZONE_CHOOSE: CSSProperties = {
  padding: '6px 12px',
  border: '1px solid #1d4e89',
  borderRadius: 6,
  color: '#1d4e89',
  fontWeight: 600,
  fontSize: 14,
  background: '#ffffff',
  whiteSpace: 'nowrap',
}

const FOOTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  paddingTop: 4,
}
const FOOTER_LABEL: CSSProperties = {
  flex: '1 1 auto',
  fontSize: 13.5,
  color: '#5e5e5e',
}
const PRIMARY_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: '#1d4e89',
  color: '#ffffff',
  fontWeight: 700,
}
const PAGE_ERROR: CSSProperties = { margin: 0, color: '#b3261e', fontSize: 13.5 }
const CARD_ERROR: CSSProperties = { margin: 0, color: '#b3261e', fontSize: 13 }

/** How many of the adopted file's first rows the card shows (board clip). */
const EXAMPLE_ROW_LIMIT = 5

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'The file could not be read.'
}

/** Decode a File as CSV or Excel through PROV-FV-7 (one shared decode library). */
async function parseIntakeFile(
  file: File,
  kind: FileTableKind,
): Promise<Awaited<ReturnType<typeof parseCsvFile>>> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseWorkbookFile(file, { kind })
  }
  return parseCsvFile(file, { kind })
}

/** The adopted-file shell (decode only; the flows fill the card facts). */
function loadedFrom(table: Awaited<ReturnType<typeof parseIntakeFile>>): LoadedFile {
  return {
    source: table.source,
    table,
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
  }
}

/** One card's problem line: the file row when the problem has one (board box). */
function problemLine(problem: { row?: number | null; message: string }): string {
  return problem.row !== undefined && problem.row !== null
    ? `Row ${problem.row}: ${problem.message}`
    : problem.message
}

/** The row count a card's "N problems in N rows" box reads. */
function cardRowCount(file: LoadedFile | null): number | null {
  return file?.inspection?.summary.rows ?? null
}

export function PredictFilesPage() {
  const navigate = useNavigate()
  const file = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const intent = useStore(useTxrIntakeStore, s => s.intent)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const validation = useStore(useTxrIntakeStore, s => s.validation)

  const [busy, setBusy] = useState(false)
  const [cardError, setCardError] = useState<string | null>(null)
  const [validateError, setValidateError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  /** One flow at a time (a drop's parse/inspect, or a validation round). */
  const flowBusy = useRef(false)
  /** A state change arrived while a round was in flight — run again when it settles. */
  const rerun = useRef(false)
  /** The user's "not now" answers this session (join + vocab keys). */
  const dismissed = useRef(new Set<string>())

  const handlePick = useCallback(async (kind: FileTableKind, picked: File) => {
    setValidateError(null)
    setCardError(null)
    setBusy(true)
    flowBusy.current = true
    try {
      const table = await parseIntakeFile(picked, kind)
      dismissed.current.clear()
      TxrIntake.adoptFile('predictMeasurements', loadedFrom(table))
      // Same rule as the C screen's measurements drop: a join/mapping key is
      // a raw spelling the server must find in the CURRENT file — the
      // confirmed offers describe the PREVIOUS file's columns, so a new
      // predict drop forgets them and the re-validation re-derives the
      // offers for the new file.
      useTxrIntakeStore.setState({ joins: [], mapping: [] })
      const inspection = await ApiClient.FileValidation.inspect(inspectRequest(kind, table))
      TxrIntake.patchFile('predictMeasurements', { inspection, problems: inspection.problems })
    } catch (err) {
      setCardError(errorText(err))
    } finally {
      flowBusy.current = false
      setBusy(false)
      setRetryTick(t => t + 1)
    }
  }, [])

  const handleRemove = useCallback(() => {
    setCardError(null)
    TxrIntake.removeFile('predictMeasurements')
  }, [])

  const acceptJoin = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.predictMeasurements?.joinOffers.find(o => o.key === key)
    if (offer) TxrIntake.acceptJoin(offer)
  }, [])

  const rejectJoin = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.predictMeasurements?.joinOffers.find(o => o.key === key)
    if (offer) {
      dismissed.current.add(key)
      TxrIntake.rejectJoin(offer)
    }
  }, [])

  const acceptVocab = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.predictMeasurements?.vocabOffers.find(o => o.key === key)
    if (offer && offer.accepted === null) TxrIntake.acceptVocab({ ...offer, accepted: true })
  }, [])

  const rejectVocab = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.predictMeasurements?.vocabOffers.find(o => o.key === key)
    if (offer) {
      dismissed.current.add(key)
      TxrIntake.rejectVocab(offer)
    }
  }, [])

  /** The download links (CONS-UI-INTAKE-6, DEC-11) — one card error line. */
  const downloadCsv = useCallback(async (which: 'template' | 'example') => {
    try {
      const text = await fetchTemplateCsv('measurements', which)
      downloadText(templateFilename('measurements', which), text)
    } catch {
      setCardError(`The measurements ${which} could not be downloaded. Try again.`)
    }
  }, [])

  /**
   * The INV-2 flow over the store's predict slot: ensure the adopted file
   * is inspected (a parse-only adoption — the same defense the C screen
   * carries) and validate in predict mode — automatically, with no second
   * file to wait for (PROV-FV-3: the MISSING_PATIENTS branch does not apply
   * to predict). Same sequencing guard as the C screen: a state change
   * during a round marks `rerun` and the settle re-runs until the store
   * holds a validation matching the current inputs.
   */
  const runFlow = useCallback(async () => {
    const state = useTxrIntakeStore.getState()
    const predictFile = state.predictMeasurements
    if (predictFile === null) return
    if (predictFile.inspection === null) {
      const inspection = await ApiClient.FileValidation.inspect(
        inspectRequest('measurements', predictFile.table),
      )
      useTxrIntakeStore
        .getState()
        .patchFile('predictMeasurements', { inspection, problems: inspection.problems })
    }
    const current = useTxrIntakeStore.getState()
    if (current.predictMeasurements === null) return
    const response = await ApiClient.FileValidation.validate(validateRequest('predict', current))
    setValidateError(null)

    // DEC-9: record the non-fuzzy ladder matches (the same marker by the
    // vocabulary's own declaration) so the NEXT validation carries them and
    // the fuzzy/join offer lists derive from the same response — identical
    // to the C screen's round.
    const resolution = resolveMapping(response.markers, current.mapping, dismissed.current)
    for (const offer of resolution.auto) {
      const now = useTxrIntakeStore.getState()
      if (now.mapping.some(entry => entry.key === offer.key)) continue
      useTxrIntakeStore.getState().acceptVocab(offer)
    }
    const after = useTxrIntakeStore.getState()
    const joinOffers = resolveJoins(response.markers, after.joins, dismissed.current)
    after.applyValidation(response, after.currentValidationKey())
    const settled = useTxrIntakeStore.getState()
    const problems = cardProblems(
      'measurements',
      settled.predictMeasurements?.inspection ?? null,
      null,
      response,
    )
    settled.patchFile('predictMeasurements', {
      problems,
      prepared: !hasErrorProblems(problems),
      joinOffers,
      vocabOffers: resolution.offers,
    })
  }, [])

  useEffect(() => {
    if (file === null) return
    if (validation !== null) return
    if (flowBusy.current) {
      rerun.current = true
      return
    }
    flowBusy.current = true
    void runFlow()
      .catch(err => setValidateError(errorText(err)))
      .finally(() => {
        flowBusy.current = false
        if (rerun.current) {
          rerun.current = false
          setRetryTick(t => t + 1)
        }
      })
    // `retryTick` is the settle trigger: a round that found a mutation in
    // flight re-runs once the store settles. The other deps are the exact
    // inputs the validation reads (a change = a new validation).
  }, [file, joins, mapping, parameters, validation, retryTick, runFlow])

  const canContinue = validation !== null && !hasErrorProblems(validation.problems)
  /**
   * The board's Continue — into the model choice screens: pretrained (D)
   * for intent `pretrained`, saved (I) for `reuse` (DEC-3's declared
   * conventions; the ownership stays ui-models').
   */
  const continueFlow = useCallback(() => {
    navigate(
      intent === 'reuse' ? ROUTE_CONVENTIONS.savedModels : ROUTE_CONVENTIONS.pretrainedModels,
    )
  }, [navigate, intent])

  return (
    <div style={PAGE_CONTAINER} data-testid="txr-intake-predict-files">
      <div style={MAIN_COLUMN}>
        <div>
          <div style={STEP_LINE}>Step 3 of 4</div>
          <h1 style={TITLE}>Add the patients to predict</h1>
          <p style={INTRO}>
            Only their blood measurements. Read on this computer only, never uploaded. Match the
            example; we check the file as soon as you choose it.
          </p>
        </div>

        <PredictCard
          file={file}
          busy={busy}
          error={cardError}
          validation={validation}
          joinOffers={file?.joinOffers ?? []}
          vocabOffers={file?.vocabOffers ?? []}
          onPick={handlePick}
          onRemove={handleRemove}
          onDownload={downloadCsv}
          onAcceptJoin={acceptJoin}
          onRejectJoin={rejectJoin}
          onAcceptVocab={acceptVocab}
          onRejectVocab={rejectVocab}
        />

        <div style={FOOTER}>
          <span style={FOOTER_LABEL}>
            {file === null
              ? 'Add the measurements file to check which models can run on it.'
              : validation === null
                ? 'We check the file as soon as you choose it.'
                : !canContinue
                  ? 'Fix the problems to continue.'
                  : 'The file checks out — continue to the models.'}
          </span>
          {validateError !== null ? (
            <span role="alert" style={PAGE_ERROR}>
              {validateError}
            </span>
          ) : null}
          <Button
            data-testid="txr-intake-continue"
            style={PRIMARY_BUTTON}
            disabled={!canContinue}
            onClick={continueFlow}
          >
            Continue: choose models
          </Button>
        </div>
      </div>

      <aside style={ASIDE} data-testid="txr-intake-aside">
        <div style={ASIDE_EYEBROW}>What the models look for</div>
        <p style={ASIDE_PARA}>
          After you add the file we check which pretrained models can run on it. These are the
          draws most models use:
        </p>
        <ul style={ASIDE_LIST}>
          <li>
            <b>Before treatment</b> (day 0): needed by almost all models
          </li>
          <li>
            <b>Early on treatment</b> (about day 14 to 28): needed by the models that look at
            change
          </li>
          <li>
            <b>Markers</b>: ctDNA, LDH, blood counts and tumour markers are the most used. The
            more you measured, the more models can run
          </li>
          <li>
            <b>Units</b>: add the unit column so we can check that the scale matches the model
          </li>
        </ul>
        <div style={ASIDE_NOTE}>
          Not sure what you have?{' '}
          <Link data-testid="txr-intake-aside-study" style={ASIDE_LINK} to={STUDY_ROUTE}>
            Answer the questions about your study
          </Link>{' '}
          on the previous screen, or just add the file: nothing is lost if some models cannot run.
        </div>
        <div style={ASIDE_FOOTER}>No outcomes are needed, and no patients file.</div>
      </aside>
    </div>
  )
}

interface PredictCardProps {
  file: LoadedFile | null
  busy: boolean
  error: string | null
  validation: ValidationResponse | null
  joinOffers: LoadedFile['joinOffers']
  vocabOffers: LoadedFile['vocabOffers']
  onPick: (kind: FileTableKind, file: File) => void
  onRemove: () => void
  onDownload: (which: 'template' | 'example') => void
  onAcceptJoin: (key: string) => void
  onRejectJoin: (key: string) => void
  onAcceptVocab: (key: string) => void
  onRejectVocab: (key: string) => void
}

/**
 * The N screen's ONE measurements card (the PROV-UI-INTAKE-5 surface in its
 * predict mount; ITEM-9 extracts the shared components from here and from
 * FilesPage's card): the board's N column table, the first rows of the
 * adopted file, the template/example downloads, the drop zone, the status
 * box with the board-N line, the per-row problems and the offer rows.
 */
function PredictCard(props: PredictCardProps) {
  const {
    file,
    busy,
    error,
    validation,
    joinOffers,
    vocabOffers,
    onPick,
    onRemove,
    onDownload,
    onAcceptJoin,
    onRejectJoin,
    onAcceptVocab,
    onRejectVocab,
  } = props
  const exampleRows = (file?.table.rows ?? []).slice(0, EXAMPLE_ROW_LIMIT)
  const problems = file?.problems ?? []
  const errors = hasErrorProblems(problems)
  const rowCount = cardRowCount(file)
  const status = validation !== null ? predictMeasurementsStatus(validation) : null
  const showStatusBox = file !== null && file.inspection !== null
  const warnings = problems.filter(problem => problem.severity === 'warning')
  const hasOffers = joinOffers.length > 0 || vocabOffers.length > 0

  return (
    <section style={CARD} data-testid="txr-intake-file-card-measurements">
      <div style={CARD_LEFT}>
        <h2 style={CARD_TITLE}>Measurements of the patients to predict</h2>
        <p style={CARD_DESC}>
          One row per marker per blood draw. Day 0 is the start of treatment; draws before it are
          negative.
        </p>
        <RoleTable roles={PREDICT_ROLES} />
      </div>

      <div style={CARD_RIGHT}>
        {file !== null ? (
          <>
            <div style={EXAMPLE_LABEL}>Example (first rows)</div>
            <FirstRows columns={file.table.columns} rows={exampleRows} />
          </>
        ) : (
          <div style={EXAMPLE_LABEL}>The columns we look for are on the left.</div>
        )}

        <div style={DOWNLOADS}>
          <Button
            variant="link"
            data-testid="txr-intake-download-template-measurements"
            style={DOWNLOAD_LINK}
            onClick={() => onDownload('template')}
          >
            Download the template (CSV)
          </Button>
          <Button
            variant="link"
            data-testid="txr-intake-download-example-measurements"
            style={DOWNLOAD_LINK_PLAIN}
            onClick={() => onDownload('example')}
          >
            Download the full example
          </Button>
        </div>

        {error !== null ? (
          <div role="alert" style={CARD_ERROR}>
            {error}
          </div>
        ) : null}

        {file === null ? (
          <Upload
            data-testid="txr-intake-file-drop-measurements"
            label="Drop the measurements file here"
            accept=".csv,.xlsx,.xls"
            disabled={busy}
            onFiles={picked => {
              const pick = picked[0]
              if (pick) onPick('measurements', pick)
            }}
          >
            <div style={DROPZONE}>
              <span style={{ color: '#1d4e89', fontWeight: 600, fontSize: 22 }} aria-hidden>
                ↓
              </span>
              <span style={DROPZONE_TEXT}>
                <span style={DROPZONE_TITLE}>Drop the measurements file here</span>
                <span style={DROPZONE_HINT}>
                  CSV or Excel. The columns can be in any order; matching names are found for
                  you.
                </span>
              </span>
              <span style={DROPZONE_CHOOSE}>Choose file</span>
            </div>
          </Upload>
        ) : null}

        {showStatusBox ? (
          <div
            data-testid="txr-intake-file-status-measurements"
            style={errors ? STATUS_BAD : status !== null ? STATUS_GOOD : STATUS_NEUTRAL}
          >
            {errors ? (
              <>
                <div style={STATUS_BAD_HEADING}>
                  {problems.length} problem{problems.length === 1 ? '' : 's'}{' '}
                  {rowCount !== null ? `in ${rowCount} row${rowCount === 1 ? '' : 's'}` : ''}
                </div>
                <ProblemLines problems={problems} />
                <Button
                  variant="link"
                  data-testid="txr-intake-file-fix-measurements"
                  style={FIX_LINK}
                  onClick={onRemove}
                >
                  Fix and choose the file again
                </Button>
              </>
            ) : status !== null ? (
              <>
                <div style={STATUS_GOOD_HEADING}>{status.heading}</div>
                <p style={STATUS_LINE}>{status.line}</p>
                {warnings.length > 0 ? (
                  <div style={WARNING_GROUP}>
                    <div style={WARNING_TITLE}>
                      {warnings.length} note{warnings.length === 1 ? '' : 's'}
                    </div>
                    <ProblemLines problems={warnings} />
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div style={STATUS_HEADING}>
                  {rowCount !== null ? `${rowCount} rows read` : 'File read'}
                </div>
                <p style={STATUS_LINE}>We check each file as soon as you choose it.</p>
                {warnings.length > 0 ? <ProblemLines problems={warnings} /> : null}
                <Button
                  variant="link"
                  data-testid="txr-intake-file-choose-again-measurements"
                  style={FIX_LINK}
                  onClick={onRemove}
                >
                  Choose a different file
                </Button>
              </>
            )}
          </div>
        ) : null}

        {hasOffers ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {joinOffers.map(offer => (
              <div
                key={offer.key}
                style={OFFER_ROW}
                data-testid={`txr-intake-join-offer-${offer.key}`}
              >
                <span style={OFFER_TEXT}>
                  Marker {offer.variants.map(v => `"${v}"`).join(' and ')} look the same: join
                  them?
                </span>
                <Button
                  data-testid={`txr-intake-join-accept-${offer.key}`}
                  style={OFFER_ACCEPT}
                  onClick={() => onAcceptJoin(offer.key)}
                >
                  Join them
                </Button>
                <Button
                  variant="outline"
                  data-testid={`txr-intake-join-decline-${offer.key}`}
                  style={OFFER_DECLINE}
                  onClick={() => onRejectJoin(offer.key)}
                >
                  Not now
                </Button>
              </div>
            ))}
            {vocabOffers.map(offer => (
              <div
                key={offer.key}
                style={OFFER_ROW}
                data-testid={`txr-intake-vocab-offer-${offer.key}`}
              >
                <span style={OFFER_TEXT}>
                  Your column "{offer.key}" looks like {offer.match.display_name} (
                  {offer.match.system}: {offer.match.marker_id}, {offer.match.canonical_unit}).
                  Use it as this marker?
                </span>
                <Button
                  data-testid={`txr-intake-vocab-accept-${offer.key}`}
                  style={OFFER_ACCEPT}
                  onClick={() => onAcceptVocab(offer.key)}
                >
                  Yes, use it
                </Button>
                <Button
                  variant="outline"
                  data-testid={`txr-intake-vocab-decline-${offer.key}`}
                  style={OFFER_DECLINE}
                  onClick={() => onRejectVocab(offer.key)}
                >
                  Not this one
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** One problem line set: row-numbered lines, severity-colored (DEC-14). */
function ProblemLines({ problems }: { problems: LoadedFile['problems'] }) {
  return (
    <ul style={PROBLEM_LIST} data-testid="txr-intake-file-problems-measurements">
      {problems.map((problem, index) => (
        <li
          key={`${problem.code}-${index}`}
          style={problem.severity === 'error' ? PROBLEM_ERROR : PROBLEM_WARNING}
        >
          {problemLine(problem)}
        </li>
      ))}
    </ul>
  )
}

/** The board's static per-role table (role, tag, copy — verbatim bytes). */
function RoleTable({ roles }: { roles: RoleRow[] }) {
  return (
    <table style={ROLE_TABLE}>
      <tbody>
        {roles.map(row => (
          <tr key={row.roles.join(',')}>
            <td style={ROLE_NAME}>{row.roles.join(', ')}</td>
            <td style={ROLE_TAG}>{row.tag}</td>
            <td style={ROLE_COPY}>{row.copy}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The adopted file's first rows (the board's "Example (first rows)" box). */
function FirstRows({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  return (
    <div style={{ overflow: 'hidden', borderRadius: 8 }}>
      <table style={EXAMPLE_TABLE}>
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column} scope="col" style={EXAMPLE_HEAD}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column, cindex) => (
                <td key={column} style={cindex === 0 ? EXAMPLE_CODE : EXAMPLE_ENTRY}>
                  {row[cindex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
