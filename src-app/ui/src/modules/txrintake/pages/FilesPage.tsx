import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
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
  measurementsStatus,
  patientsStatus,
  resolveJoins,
  resolveMapping,
  validateRequest,
} from '../lib/flow'
import { fetchTemplateCsv, downloadText, templateFilename } from '../lib/download'
import { ROUTE_CONVENTIONS } from '../module'
import type { LoadedFile } from '../types'

/**
 * Screen C — Your files (board Files.dc.html, ITEM-6): the two file cards
 * (patients + measurements), each with the board's column table, the first
 * rows of the adopted file, the template/example downloads, the drop zone
 * that reads CSV/Excel locally (CONS-UI-INTAKE-7, never re-implemented),
 * the per-row problem list, the spelling-variant join offers and the fuzzy
 * vocabulary confirmations — and the Continue gate (DEC-10) into screen E.
 *
 * INV-2's flow, one pipe for C and N: drop → PROV-FV-7 parse →
 * PROV-FV-2 inspect (per file, as soon as chosen) → PROV-FV-3 validate
 * (automatically once BOTH files are present) → card facts. The same store
 * actions drive the E-screen "Change files" slots (PROV-UI-INTAKE-5), and
 * the marker-column offers live on the measurements file.
 *
 * Suggestion discipline (DEC-9): nothing is auto-joined and nothing fuzzy
 * is auto-mapped. The validate response's non-fuzzy ladder matches
 * (exact/alias/standard_id) ARE the same marker by the vocabulary's own
 * declaration — they are recorded into the confirmed mapping with no user
 * step. A join offer and a fuzzy vocab offer render on the card with
 * Accept / Not now; "Not now" is remembered for the session (the offer
 * does not reappear on the automatic re-validation), while a plain
 * re-validation after an ACCEPT makes the A03 line disappear (the
 * algorithm's own join contract).
 *
 * Copy rule (DEC-13): the card labels and the status boxes are the board's
 * words; every number is computed from the inspections and the validate
 * response (row counts, problem counts, marker lists) — never the board's
 * example counts.
 */

const filesKindOfSlot = { patients: 'patients', measurements: 'measurements' } as const
type Slot = keyof typeof filesKindOfSlot

const PAGE_CONTAINER: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '40px 48px',
  maxWidth: 1280,
  margin: '0 auto',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
}

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

/** The board's two column tables: grouped role rows, verbatim copy. */
interface RoleRow {
  roles: string[]
  tag: 'required' | 'optional'
  copy: string
}

const PATIENTS_ROLES: RoleRow[] = [
  { roles: ['patient_id'], tag: 'required', copy: 'your own code, the same in both files' },
  { roles: ['pfs_days'], tag: 'required', copy: 'days until progression, or last follow-up' },
  {
    roles: ['pfs_event'],
    tag: 'required',
    copy: '1 = progressed or died, 0 = still well at last follow-up',
  },
  { roles: ['os_days', 'os_event'], tag: 'optional', copy: 'the same for death alone' },
  { roles: ['age', 'sex', 'stage'], tag: 'optional', copy: 'used as extra inputs by some methods' },
]

const MEASUREMENTS_ROLES: RoleRow[] = [
  { roles: ['patient_id'], tag: 'required', copy: 'matches the patients file' },
  { roles: ['day'], tag: 'required', copy: 'days from the start of treatment' },
  { roles: ['marker'], tag: 'required', copy: 'name as you use it, for example LDH' },
  { roles: ['value'], tag: 'required', copy: 'a number' },
  { roles: ['unit'], tag: 'optional', copy: 'for example U/L; lets us check scales' },
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

export function FilesPage() {
  const navigate = useNavigate()
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const validation = useStore(useTxrIntakeStore, s => s.validation)

  const [busySlot, setBusySlot] = useState<Slot | null>(null)
  const [cardErrors, setCardErrors] = useState<Partial<Record<Slot, string>>>({})
  const [validateError, setValidateError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  /** One flow at a time (a drop's parse/inspect, or a validation round). */
  const flowBusy = useRef(false)
  /** A state change arrived while a round was in flight — run again when it settles. */
  const rerun = useRef(false)
  /** The user's "not now" answers this session (join + vocab keys). */
  const dismissed = useRef(new Set<string>())

  const handlePick = useCallback(async (kind: FileTableKind, file: File) => {
    const slot = kind
    setValidateError(null)
    setCardErrors(prev => ({ ...prev, [slot]: undefined }))
    setBusySlot(slot)
    flowBusy.current = true
    try {
      const table = await parseIntakeFile(file, kind)
      dismissed.current.clear()
      TxrIntake.adoptFile(slot, loadedFrom(table))
      // A join key / mapping key is a raw spelling the server must find in
      // the CURRENT file — the confirmed offers describe the PREVIOUS file's
      // columns, so a new measurements drop forgets them (the re-validation
      // re-derives the offers for the new file's columns; the user confirms
      // again only what the new file needs). `adoptFile` already invalidated
      // the stored validation; this clears the two confirmed lists through
      // the store's public state writer (additive to the ITEM-3 surface).
      if (slot === 'measurements') {
        useTxrIntakeStore.setState({ joins: [], mapping: [] })
      }
      const inspection = await ApiClient.FileValidation.inspect(inspectRequest(kind, table))
      TxrIntake.patchFile(slot, { inspection, problems: inspection.problems })
    } catch (err) {
      setCardErrors(prev => ({ ...prev, [slot]: errorText(err) }))
    } finally {
      flowBusy.current = false
      setBusySlot(null)
      setRetryTick(t => t + 1)
    }
  }, [])

  const handleRemove = useCallback((slot: Slot) => {
    setCardErrors(prev => ({ ...prev, [slot]: undefined }))
    TxrIntake.removeFile(slot)
  }, [])

  const acceptJoin = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.measurements?.joinOffers.find(o => o.key === key)
    if (offer) TxrIntake.acceptJoin(offer)
  }, [])

  const rejectJoin = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.measurements?.joinOffers.find(o => o.key === key)
    if (offer) {
      dismissed.current.add(key)
      TxrIntake.rejectJoin(offer)
    }
  }, [])

  const acceptVocab = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.measurements?.vocabOffers.find(o => o.key === key)
    if (offer && offer.accepted === null) TxrIntake.acceptVocab({ ...offer, accepted: true })
  }, [])

  const rejectVocab = useCallback((key: string) => {
    const state = useTxrIntakeStore.getState()
    const offer = state.measurements?.vocabOffers.find(o => o.key === key)
    if (offer) {
      dismissed.current.add(key)
      TxrIntake.rejectVocab(offer)
    }
  }, [])

  /** The download links (CONS-UI-INTAKE-6, DEC-11) — one card error line. */
  const downloadCsv = useCallback(async (kind: FileTableKind, which: 'template' | 'example') => {
    try {
      const text = await fetchTemplateCsv(kind, which)
      downloadText(templateFilename(kind, which), text)
    } catch {
      setCardErrors(prev => ({
        ...prev,
        [kind]: `The ${which} could not be downloaded. Try again.`,
      }))
    }
  }, [])

  /**
   * The INV-2 flow over the store's files: ensure each adopted file is
   * inspected (the "Try the example data" path adopts PARSE-ONLY files —
   * DRIFT-1 ITEM-4 #2) and validate once both are present. These requests
   * are sequenced by the effect; a state change during a round (an accept,
   * a re-drop) marks `rerun` and the settle re-runs until the store holds a
   * validation matching the current inputs.
   */
  const runFlow = useCallback(async () => {
    const state = useTxrIntakeStore.getState()
    const patientsFile = state.patients
    const measurementsFile = state.measurements
    if (patientsFile === null || measurementsFile === null) return
    const files: Array<[FileTableKind, LoadedFile]> = [
      ['patients', patientsFile],
      ['measurements', measurementsFile],
    ]
    for (const [slot, file] of files) {
      if (file.inspection === null) {
        const inspection = await ApiClient.FileValidation.inspect(inspectRequest(slot, file.table))
        useTxrIntakeStore.getState().patchFile(slot, { inspection, problems: inspection.problems })
      }
    }
    const current = useTxrIntakeStore.getState()
    if (current.patients === null || current.measurements === null) return
    const response = await ApiClient.FileValidation.validate(validateRequest('study', current))
    setValidateError(null)

    // DEC-9: record the non-fuzzy ladder matches (the same marker by the
    // vocabulary's own declaration) so the NEXT validation carries them and
    // the fuzzy/join offer lists derive from the same response.
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
    const patientsProblems = cardProblems(
      'patients',
      settled.patients?.inspection ?? null,
      settled.measurements?.inspection ?? null,
      response,
    )
    const measurementsProblems = cardProblems(
      'measurements',
      settled.measurements?.inspection ?? null,
      settled.patients?.inspection ?? null,
      response,
    )
    settled.patchFile('patients', {
      problems: patientsProblems,
      prepared: !hasErrorProblems(patientsProblems),
    })
    settled.patchFile('measurements', {
      problems: measurementsProblems,
      prepared: !hasErrorProblems(measurementsProblems),
      joinOffers,
      vocabOffers: resolution.offers,
    })
  }, [])

  useEffect(() => {
    if (patients === null || measurements === null) return
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
  }, [patients, measurements, joins, mapping, parameters, validation, retryTick, runFlow])

  const canContinue = validation !== null && !hasErrorProblems(validation.problems)
  const continueFlow = useCallback(() => {
    navigate(ROUTE_CONVENTIONS.methods)
  }, [navigate])

  return (
    <div style={PAGE_CONTAINER} data-testid="txr-intake-files">
      <div>
        <div style={STEP_LINE}>Step 3 of 4</div>
        <h1 style={TITLE}>Add your files</h1>
        <p style={INTRO}>
          Two tables, as CSV or Excel. Read on this computer only. Match the examples; we check
          each file as soon as you choose it.
        </p>
      </div>

      <FileCard
        slot="patients"
        title="Patients"
        description="One row per patient. Time is counted in days from the start of treatment."
        roles={PATIENTS_ROLES}
        file={patients}
        busy={busySlot === 'patients'}
        error={cardErrors.patients ?? null}
        validation={validation}
        joinOffers={[]}
        vocabOffers={[]}
        onPick={handlePick}
        onRemove={() => handleRemove('patients')}
        onDownload={downloadCsv}
        onAcceptJoin={acceptJoin}
        onRejectJoin={rejectJoin}
        onAcceptVocab={acceptVocab}
        onRejectVocab={rejectVocab}
      />

      <FileCard
        slot="measurements"
        title="Measurements"
        description="One row per marker per blood draw. Day 0 is the start of treatment; draws before it are negative."
        roles={MEASUREMENTS_ROLES}
        file={measurements}
        busy={busySlot === 'measurements'}
        error={cardErrors.measurements ?? null}
        validation={validation}
        joinOffers={measurements?.joinOffers ?? []}
        vocabOffers={measurements?.vocabOffers ?? []}
        onPick={handlePick}
        onRemove={() => handleRemove('measurements')}
        onDownload={downloadCsv}
        onAcceptJoin={acceptJoin}
        onRejectJoin={rejectJoin}
        onAcceptVocab={acceptVocab}
        onRejectVocab={rejectVocab}
      />

      <div style={FOOTER}>
        <span style={FOOTER_LABEL}>
          {canContinue
            ? 'Both files check out — next you choose the methods that can run on them.'
            : validation !== null
              ? 'Fix the problems to continue.'
              : 'Both files are needed before the check runs.'}
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
          Continue
        </Button>
      </div>
    </div>
  )
}

interface FileCardProps {
  slot: Slot
  title: string
  description: string
  roles: RoleRow[]
  file: LoadedFile | null
  busy: boolean
  error: string | null
  validation: ValidationResponse | null
  joinOffers: LoadedFile['joinOffers']
  vocabOffers: LoadedFile['vocabOffers']
  onPick: (kind: FileTableKind, file: File) => void
  onRemove: () => void
  onDownload: (kind: FileTableKind, which: 'template' | 'example') => void
  onAcceptJoin: (key: string) => void
  onRejectJoin: (key: string) => void
  onAcceptVocab: (key: string) => void
  onRejectVocab: (key: string) => void
}

/**
 * One file card (the PROV-UI-INTAKE-5 surface; ITEM-9 extracts the
 * components from here). The measurements card carries the marker-column
 * offers; the patients card shows the first rows + status + problems only.
 */
function FileCard(props: FileCardProps) {
  const {
    slot,
    title,
    description,
    roles,
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
  const kind = filesKindOfSlot[slot]
  const exampleRows = (file?.table.rows ?? []).slice(0, EXAMPLE_ROW_LIMIT)
  const problems = file?.problems ?? []
  const errors = hasErrorProblems(problems)
  const rowCount = cardRowCount(file)
  const status =
    validation !== null
      ? slot === 'patients'
        ? patientsStatus(validation)
        : measurementsStatus(validation)
      : null
  const showStatusBox = file !== null && file.inspection !== null
  const warnings = problems.filter(problem => problem.severity === 'warning')
  const hasOffers =
    slot === 'measurements' && (joinOffers.length > 0 || vocabOffers.length > 0)

  return (
    <section style={CARD} data-testid={`txr-intake-file-card-${kind}`}>
      <div style={CARD_LEFT}>
        <h2 style={CARD_TITLE}>{title}</h2>
        <p style={CARD_DESC}>{description}</p>
        <RoleTable roles={roles} />
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
            data-testid={`txr-intake-download-template-${kind}`}
            style={DOWNLOAD_LINK}
            onClick={() => onDownload(kind, 'template')}
          >
            Download the template (CSV)
          </Button>
          <Button
            variant="link"
            data-testid={`txr-intake-download-example-${kind}`}
            style={DOWNLOAD_LINK_PLAIN}
            onClick={() => onDownload(kind, 'example')}
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
            data-testid={`txr-intake-file-drop-${kind}`}
            label={`Drop the ${title.toLowerCase()} file here`}
            accept=".csv,.xlsx,.xls"
            disabled={busy}
            onFiles={picked => {
              const pick = picked[0]
              if (pick) onPick(kind, pick)
            }}
          >
            <div style={DROPZONE}>
              <span style={{ color: '#1d4e89', fontWeight: 600, fontSize: 22 }} aria-hidden>
                ↓
              </span>
              <span style={DROPZONE_TEXT}>
                <span style={DROPZONE_TITLE}>Drop the {title.toLowerCase()} file here</span>
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
            data-testid={`txr-intake-file-status-${kind}`}
            style={errors ? STATUS_BAD : status !== null ? STATUS_GOOD : STATUS_NEUTRAL}
          >
            {errors ? (
              <>
                <div style={STATUS_BAD_HEADING}>
                  {problems.length} problem{problems.length === 1 ? '' : 's'}{' '}
                  {rowCount !== null ? `in ${rowCount} row${rowCount === 1 ? '' : 's'}` : ''}
                </div>
                <ProblemLines problems={problems} kind={kind} />
                <Button
                  variant="link"
                  data-testid={`txr-intake-file-fix-${kind}`}
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
                    <ProblemLines problems={warnings} kind={kind} />
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div style={STATUS_HEADING}>
                  {rowCount !== null ? `${rowCount} rows read` : 'File read'}
                </div>
                <p style={STATUS_LINE}>We check each file as soon as you choose it.</p>
                {warnings.length > 0 ? <ProblemLines problems={warnings} kind={kind} /> : null}
                <Button
                  variant="link"
                  data-testid={`txr-intake-file-choose-again-${kind}`}
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
function ProblemLines({
  problems,
  kind,
}: {
  problems: LoadedFile['problems']
  kind: FileTableKind
}) {
  return (
    <ul style={PROBLEM_LIST} data-testid={`txr-intake-file-problems-${kind}`}>
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
function RoleTable({ roles }: { roles: RoleRow[] }) {  return (
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
