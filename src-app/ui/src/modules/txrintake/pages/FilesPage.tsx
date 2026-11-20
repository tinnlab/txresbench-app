import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@txresbench/kit'
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'
import { useStore } from 'zustand'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { PageFooterBar } from '@/modules/txrshell/components/PageFooterBar'
import { TxrIntake, useTxrIntakeStore } from '../stores/TxrIntake.store'
import {
  cardProblems,
  fileHasNoDataRows,
  hasErrorProblems,
  inspectRequest,
  parsePickedFile,
  resolveColumnRenames,
  resolveJoins,
  resolveMapping,
  validateRequest,
} from '../lib/flow'
import { fetchTemplateCsv, downloadText, templateFilename, templateSaveError } from '../lib/download'
import { FLOW_ROUTES, nextLearnRoute, previousLearnRoute } from '@/modules/txrshell/lib/flowSteps'
import { TxrFileCard } from '../components/TxrFileCard'
import { TxrFileMessagesRow } from '../components/TxrFileMessages'
import { TxrUseExampleButton } from '../components/TxrUseExampleButton'
import { TxrStepBack, TxrStepLine, useStepBack } from '../components/TxrStepBack'
import { CLEAR_EXAMPLE_LABEL, EXAMPLE_BANNER, runExampleFlow } from '../lib/example'
import { ExampleFileCard } from '@/modules/demo/components/ExampleFileCard'
import { useAppMode } from '@/modules/demo'
import type { ColumnRenameOffer, JoinOffer, LoadedFile, VocabOffer } from '../types'

/**
 * Screen C — Your files (board Files.dc.html, ITEM-6): the two file cards
 * (patients + measurements), each with the board's column table, the first
 * rows of the adopted file, the template/example downloads, the drop zone
 * that reads CSV/Excel locally (CONS-UI-INTAKE-7, never re-implemented),
 * the per-row problem list, the spelling-variant join offers and the fuzzy
 * vocabulary confirmations — and the Continue gate (DEC-10) into the study questions (the learn path: files, then questions, then methods).
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
 * files + the shared validation slot. The cards keep the drop zone / file
 * preview only; what the check says about each file (status box, problem
 * list, offers) is ONE full-width row under the two cards
 * (`TxrFileMessagesRow`, step3-file-cards): a block per chosen file,
 * patients first, each titled with the file kind and name.
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


const PAGE_ROOT: CSSProperties = {
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
}

const PAGE_TOP: CSSProperties = {
  boxSizing: 'border-box',
  padding: '40px 48px 10px',
  maxWidth: 1280,
  margin: '0 auto',
  width: '100%',
}

/** The body region's content (the cards' column, page-width capped). */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  boxSizing: 'border-box',
  padding: '0 48px 24px',
  maxWidth: 1280,
  margin: '0 auto',
  width: '100%',
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
  color: 'var(--txr-text-2)',
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
  color: 'var(--txr-muted)',
}
const PRIMARY_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-brand)',
  color: 'var(--txr-on-brand)',
  fontWeight: 700,
}
const PAGE_ERROR: CSSProperties = { margin: 0, color: 'var(--txr-danger)', fontSize: 13.5 }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'The file could not be read.'
}

/** The adopted-file shell (decode only; the flows fill the card facts). */
function loadedFrom(
  table: Awaited<ReturnType<typeof parsePickedFile>>,
  kind: FileTableKind,
): LoadedFile {
  return {
    source: table.source,
    table,
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
    // ITEM-6 F2: the column-mapping suggestions are derived the moment the
    // file is adopted — the "pid looks like patient_id" step needs no
    // validation round to show.
    columnOffers: resolveColumnRenames(table.columns, kind),
  }
}

export function FilesPage() {
  const navigate = useNavigate()
  const { isDemo } = useAppMode()
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const exampleLoaded = useStore(useTxrIntakeStore, s => s.exampleLoaded)
  const exampleSlots = useStore(useTxrIntakeStore, s => s.exampleSlots)
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('Add your files')
  // The step's Back (the step trail): with no trail, Back goes to the study step.
  useStepBack({ step: 'files', fallback: previousLearnRoute('files') })

  const [busySlot, setBusySlot] = useState<Slot | null>(null)
  const [cardErrors, setCardErrors] = useState<Partial<Record<Slot, string>>>({})
  // Where the desktop app's Save dialog put a card's template/example.
  const [cardSaved, setCardSaved] = useState<Partial<Record<Slot, string>>>({})
  const [validateError, setValidateError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  // demo-mode ITEM-6 — the audit's /files row: the drop zone and the picker
  // are REPLACED by the two example cards, and no upload is possible (the
  // server's inspect/validate guard admits the example tables only). The
  // example tables are the page's one content: adopted at mount when the
  // flow has not filled them yet (a direct /files visit), then the page's
  // own inspect/validate round runs exactly as for a user drop.
  const [demoLoading, setDemoLoading] = useState(false)
  const [demoError, setDemoError] = useState<string | null>(null)
  const loadDemo = useCallback(async () => {
    setDemoLoading(true)
    setDemoError(null)
    try {
      await runExampleFlow('train')
    } catch (err) {
      setDemoError(
        err instanceof Error ? err.message : 'The example tables could not be loaded.',
      )
    } finally {
      setDemoLoading(false)
    }
  }, [])
  useEffect(() => {
    // A failed attempt STAYS failed (the error line + its Retry): without
    // this the state flips (loading true→false) and the effect re-adopts on
    // its own — a silent auto-retry loop behind the user's back.
    if (!isDemo || patients !== null || demoLoading || demoError !== null) return
    void loadDemo()
  }, [isDemo, patients, demoLoading, demoError, loadDemo])

  /** The example tables' marker names (the validator's own resolved set). */
  const measurementMarkers = useMemo(
    () => (validation?.markers ?? []).map(marker => marker.key),
    [validation],
  )

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
      const table = await parsePickedFile(file, kind)
      dismissed.current.clear()
      TxrIntake.adoptFile(slot, loadedFrom(table, kind))
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

  /** "Clear example" (qa-fixes3 ITEM-4): remove the example files (only
   *  the example-flagged slots), forget the example's offers and return
   *  the screen to its empty state — the user's own files are never
   *  touched. */
  const clearExamples = useCallback(() => {
    setCardErrors(prev => ({ ...prev, patients: undefined, measurements: undefined }))
    setValidateError(null)
    TxrIntake.clearExamples()
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

  // ITEM-6 F2 (the mapping step): an ACCEPTED rename rewrites the table's
  // columns (the next inspect/validate reads the canonical spelling) — the
  // offer's re-derivation then finds nothing to re-offer; a "Not now" is
  // remembered for the session like the join/vocab "not now" answers. The
  // offer's slot is the card that owns it (a patients-card column never
  // lives on the measurements card).
  const acceptColumn = useCallback((offer: ColumnRenameOffer) => {
    const state = useTxrIntakeStore.getState()
    const slot =
      state.patients?.columnOffers.some(o => o.from === offer.from) === true
        ? 'patients'
        : 'measurements'
    TxrIntake.renameColumn(slot, offer)
  }, [])

  const rejectColumn = useCallback((offer: ColumnRenameOffer) => {
    dismissed.current.add(offer.from)
    const state = useTxrIntakeStore.getState()
    const slot =
      state.patients?.columnOffers.some(o => o.from === offer.from) === true
        ? 'patients'
        : 'measurements'
    TxrIntake.rejectColumnOffer(slot, offer.from)
  }, [])

  /** The download links (CONS-UI-INTAKE-6, DEC-11) — one card error line. */
  const downloadCsv = useCallback(async (kind: FileTableKind, which: 'template' | 'example') => {
    setCardSaved(prev => ({ ...prev, [kind]: undefined }))
    try {
      const text = await fetchTemplateCsv(kind, which)
      const result = await downloadText(templateFilename(kind, which), text)
      if (result.status === 'saved') setCardSaved(prev => ({ ...prev, [kind]: result.path }))
    } catch {
      setCardErrors(prev => ({
        ...prev,
        [kind]: templateSaveError(which),
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
      columnOffers: resolveColumnRenames(
        settled.patients?.table.columns ?? [],
        'patients',
        dismissed.current,
      ),
    })
    settled.patchFile('measurements', {
      problems: measurementsProblems,
      prepared: !hasErrorProblems(measurementsProblems),
      joinOffers,
      vocabOffers: resolution.offers,
      columnOffers: resolveColumnRenames(
        settled.measurements?.table.columns ?? [],
        'measurements',
        dismissed.current,
      ),
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

  const canContinue =
    validation !== null &&
    !hasErrorProblems(validation.problems) &&
    !fileHasNoDataRows(patients) &&
    !fileHasNoDataRows(measurements)
  const continueFlow = useCallback(() => {
    navigate(nextLearnRoute('files') ?? FLOW_ROUTES.methods)
  }, [navigate])

  return (
    <div
      role="main"
      style={PAGE_ROOT}
      className="txr-intake-page"
      data-testid="txr-intake-files"
    >
      <PageFrame
        top={
          <div className="txr-intake-top txr-intake-page-top" style={PAGE_TOP}>
            <div>
              <TxrStepLine step="files" />
              <h1 style={TITLE}>Add your files</h1>
              <p style={INTRO}>
                Two tables, as CSV or Excel. Used only for the analyses you start. Match the examples; we
                check each file as soon as you choose it.
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              {/* demo-mode ITEM-6: the example cards replace drop zones and
                  pickers; "Clear example" (which would empty the only
                  content demo mode offers) and the Use-example button are
                  desktop bytes, hidden here. */}
              {isDemo ? null : (
                <>
                  {exampleLoaded ? (
                    <p data-testid="txr-intake-example-loaded" style={{ ...INTRO, margin: 0 }}>
                      {EXAMPLE_BANNER} —{' '}
                      <Button
                        data-testid="txr-intake-clear-example"
                        variant="link"
                        style={{ padding: 0, color: 'var(--txr-brand)', fontWeight: 600 }}
                        onClick={clearExamples}
                      >
                        {CLEAR_EXAMPLE_LABEL}
                      </Button>{' '}
                      to start with your own.
                    </p>
                  ) : (
                    <span style={INTRO}></span>
                  )}
                  <TxrUseExampleButton path="train" />
                </>
              )}
            </div>
          </div>
        }
        body={
          <ScrollRegion label="Your files" className="txr-files-region">
            <div className="txr-intake-page-body" style={REGION_CONTENT}>
              {isDemo ? (
                <>
                  {demoError !== null ? (
                    <div
                      role="alert"
                      data-testid="txr-demo-example-error"
                      style={PAGE_ERROR}
                    >
                      {demoError}{' '}
                      <Button
                        data-testid="txr-demo-example-retry"
                        variant="link"
                        style={{ padding: 0, color: 'var(--txr-brand)', fontWeight: 600 }}
                        onClick={() => void loadDemo()}
                      >
                        Try again
                      </Button>
                    </div>
                  ) : null}
                  {patients === null && demoError === null ? (
                    <p data-testid="txr-demo-example-loading" style={{ ...INTRO, margin: 0 }}>
                      Loading the example tables…
                    </p>
                  ) : (
                    <>
                      <ExampleFileCard
                        kind="patients"
                        rows={patients?.table.rows.length ?? 0}
                        onDownloadTemplate={() => void downloadCsv('patients', 'template')}
                        onDownloadExample={() => void downloadCsv('patients', 'example')}
                      />
                      <ExampleFileCard
                        kind="measurements"
                        rows={measurements?.table.rows.length ?? 0}
                        markers={measurementMarkers}
                        onDownloadTemplate={() => void downloadCsv('measurements', 'template')}
                        onDownloadExample={() => void downloadCsv('measurements', 'example')}
                      />
                    </>
                  )}
                </>
              ) : (
                <>
                  <TxrFileCard
                    kind="patients"
                    mode="study"
                    file={patients}
                    busy={busySlot === 'patients'}
                    error={cardErrors.patients ?? null}
                    savedPath={cardSaved.patients ?? null}
                    isExample={exampleSlots.patients}
                    messages="row"
                    onPick={file => void handlePick('patients', file)}
                    onRemove={() => handleRemove('patients')}
                    onAcceptJoin={acceptJoin}
                    onRejectJoin={rejectJoin}
                    onAcceptVocab={acceptVocab}
                    onRejectVocab={rejectVocab}
                    onAcceptColumn={acceptColumn}
                    onRejectColumn={rejectColumn}
                    onDownloadTemplate={() => void downloadCsv('patients', 'template')}
                    onDownloadExample={() => void downloadCsv('patients', 'example')}
                  />

                  <TxrFileCard
                    kind="measurements"
                    mode="study"
                    file={measurements}
                    busy={busySlot === 'measurements'}
                    error={cardErrors.measurements ?? null}
                    savedPath={cardSaved.measurements ?? null}
                    isExample={exampleSlots.measurements}
                    messages="row"
                    onPick={file => void handlePick('measurements', file)}
                    onRemove={() => handleRemove('measurements')}
                    onAcceptJoin={acceptJoin}
                    onRejectJoin={rejectJoin}
                    onAcceptVocab={acceptVocab}
                    onRejectVocab={rejectVocab}
                    onAcceptColumn={acceptColumn}
                    onRejectColumn={rejectColumn}
                    onDownloadTemplate={() => void downloadCsv('measurements', 'template')}
                    onDownloadExample={() => void downloadCsv('measurements', 'example')}
                  />

                  <TxrFileMessagesRow
                    mode="study"
                    slots={[
                      {
                        kind: 'patients',
                        file: patients,
                        onRemove: () => handleRemove('patients'),
                      },
                      {
                        kind: 'measurements',
                        file: measurements,
                        onRemove: () => handleRemove('measurements'),
                      },
                    ]}
                    onAcceptJoin={acceptJoin}
                    onRejectJoin={rejectJoin}
                    onAcceptVocab={acceptVocab}
                    onRejectVocab={rejectVocab}
                    onAcceptColumn={acceptColumn}
                    onRejectColumn={rejectColumn}
                  />
                </>
              )}
            </div>
          </ScrollRegion>
        }
        bottom={
          <PageFooterBar className="txr-intake-footer-bar">
            <div style={{ ...FOOTER, width: '100%' }} className="txr-intake-footer">
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
              <TxrStepBack />
              <Button
                data-testid="txr-intake-continue"
                style={PRIMARY_BUTTON}
                disabled={!canContinue}
                onClick={continueFlow}
              >
                Continue
              </Button>
            </div>
          </PageFooterBar>
        }
      />
    </div>
  )
}
