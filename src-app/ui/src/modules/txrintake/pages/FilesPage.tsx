import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@ziee/kit'
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'
import { parseCsvFile } from '@/lib/txr-files/csv'
import { parseWorkbookFile } from '@/lib/txr-files/workbook'
import { useStore } from 'zustand'
import { TxrIntake, useTxrIntakeStore } from '../stores/TxrIntake.store'
import {
  cardProblems,
  hasErrorProblems,
  inspectRequest,
  resolveJoins,
  resolveMapping,
  validateRequest,
} from '../lib/flow'
import { fetchTemplateCsv, downloadText, templateFilename } from '../lib/download'
import { ROUTE_CONVENTIONS } from '../module'
import { TxrFileCard } from '../components/TxrFileCard'
import type { JoinOffer, LoadedFile, VocabOffer } from '../types'

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
 * The card markup itself is the shared `TxrFileCard` (ITEM-9's component
 * extraction — the markup moved, the flow stayed): this page owns the C
 * flow round and the Continue gate; the card's parts render the store's
 * files + the shared validation slot.
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

const SLOTS = ['patients', 'measurements'] as const
type Slot = (typeof SLOTS)[number]

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

  // The card hands the OFFER OBJECT through (the PROV-UI-INTAKE-5 contract);
  // the store actions take the same object — no key re-derivation here.
  const acceptJoin = useCallback((offer: JoinOffer) => {
    TxrIntake.acceptJoin(offer)
  }, [])

  const rejectJoin = useCallback((offer: JoinOffer) => {
    dismissed.current.add(offer.key)
    TxrIntake.rejectJoin(offer)
  }, [])

  const acceptVocab = useCallback((offer: VocabOffer) => {
    if (offer.accepted === null) TxrIntake.acceptVocab({ ...offer, accepted: true })
  }, [])

  const rejectVocab = useCallback((offer: VocabOffer) => {
    dismissed.current.add(offer.key)
    TxrIntake.rejectVocab(offer)
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
    <div role="main" style={PAGE_CONTAINER} data-testid="txr-intake-files">
      <div>
        <div style={STEP_LINE}>Step 3 of 4</div>
        <h1 style={TITLE}>Add your files</h1>
        <p style={INTRO}>
          Two tables, as CSV or Excel. Read on this computer only. Match the examples; we check
          each file as soon as you choose it.
        </p>
      </div>

      <TxrFileCard
        kind="patients"
        mode="study"
        file={patients}
        busy={busySlot === 'patients'}
        error={cardErrors.patients ?? null}
        onPick={file => void handlePick('patients', file)}
        onRemove={() => handleRemove('patients')}
        onAcceptJoin={acceptJoin}
        onRejectJoin={rejectJoin}
        onAcceptVocab={acceptVocab}
        onRejectVocab={rejectVocab}
        onDownloadTemplate={() => void downloadCsv('patients', 'template')}
        onDownloadExample={() => void downloadCsv('patients', 'example')}
      />

      <TxrFileCard
        kind="measurements"
        mode="study"
        file={measurements}
        busy={busySlot === 'measurements'}
        error={cardErrors.measurements ?? null}
        onPick={file => void handlePick('measurements', file)}
        onRemove={() => handleRemove('measurements')}
        onAcceptJoin={acceptJoin}
        onRejectJoin={rejectJoin}
        onAcceptVocab={acceptVocab}
        onRejectVocab={rejectVocab}
        onDownloadTemplate={() => void downloadCsv('measurements', 'template')}
        onDownloadExample={() => void downloadCsv('measurements', 'example')}
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
