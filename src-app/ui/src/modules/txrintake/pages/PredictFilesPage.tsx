import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '@ziee/kit'
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'
import { useStore } from 'zustand'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
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
import { fetchTemplateCsv, downloadText, templateFilename } from '../lib/download'
import { ROUTE_CONVENTIONS } from '../module'
import { TxrFileCard } from '../components/TxrFileCard'
import type { ColumnRenameOffer, JoinOffer, LoadedFile, VocabOffer } from '../types'

/**
 * Screen N — Add the patients to predict (board PredictFiles.dc.html,
 * ITEM-7): the predict-mode variant of the C flow. ONE measurements card
 * (no patients file, no outcomes — the board's "No outcomes are needed, and
 * no patients file." line), the "What the models look for" aside, and the
 * Continue gate into the model choice screens: `/pretrained-models` for
 * intent `pretrained` (screen D) and `/saved-models` for `reuse` (screen I).
 *
 * INV-2's flow, one pipe for C and N (the card markup is the shared
 * `TxrFileCard` — ITEM-9's component extraction; this page owns the N
 * validate round and the aside): drop → PROV-FV-7 parse → PROV-FV-2
 * inspect (as soon as chosen) → PROV-FV-3 validate in `mode: 'predict'`
 * (AUTOMATICALLY once the one file is present — the second-table wait and
 * the MISSING_PATIENTS branch do not apply, PROV-FV-3). The same store
 * actions and the same `lib/flow` functions back the C and E screens.
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

/** The page container's phone class (the ITEM-6 narrow block in index.css). */
const PAGE_CONTAINER_CLASS = 'txr-intake-page'

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
  background: 'var(--txr-bg)',
  borderLeft: '1px solid var(--txr-border-subtle)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const ASIDE_EYEBROW: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-muted)',
}

const ASIDE_PARA: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }

const ASIDE_LIST: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  // qa-fixes ITEM-6 P1: the board's list has bullet markers — the kit's
  // global reset removed them and the items read as one grey block.
  listStyle: 'disc',
  fontSize: 14.5,
  color: 'var(--txr-text-2)',
}

/** One aside item: the board's bold lead-in on its own line, then the fact. */
const ASIDE_ITEM: CSSProperties = { margin: '2px 0' }

/** The board's "Not sure what you have?" note (the study clause is a link). */
const ASIDE_NOTE: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 8,
  background: 'var(--txr-surface)',
  fontSize: 13.5,
  color: 'var(--txr-text-2)',
}

const ASIDE_LINK: CSSProperties = { color: 'var(--txr-brand)', fontWeight: 600 }

/** The board's bottom line — the predict-mode promise, static. */
const ASIDE_FOOTER: CSSProperties = { marginTop: 'auto', fontSize: 13.5, color: 'var(--txr-muted)' }

const STEP_LINE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-brand)',
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
    columnOffers: resolveColumnRenames(table.columns, kind),
  }
}

export function PredictFilesPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const file = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const intent = useStore(useTxrIntakeStore, s => s.intent)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('Add the patients to predict')
  // The J "Use" handoff (RES-21): the id + display label ride the URL (the
  // J "?set=" view precedent) so this screen can name the chosen model —
  // the reuse flow said nothing about WHICH model was picked between the
  // Use click and the choice screen's preselection.
  const pendingUseId = searchParams.get('use')
  const pendingUseName = searchParams.get('name')

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
      const table = await parsePickedFile(picked, kind)
      dismissed.current.clear()
      TxrIntake.adoptFile('predictMeasurements', loadedFrom(table, kind))
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

  const acceptColumn = useCallback((offer: ColumnRenameOffer) => {
    TxrIntake.renameColumn('predictMeasurements', offer)
  }, [])

  const rejectColumn = useCallback((offer: ColumnRenameOffer) => {
    dismissed.current.add(offer.from)
    TxrIntake.rejectColumnOffer('predictMeasurements', offer.from)
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
      columnOffers: resolveColumnRenames(
        settled.predictMeasurements?.table.columns ?? [],
        'measurements',
        dismissed.current,
      ),
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

  const canContinue =
    validation !== null &&
    !hasErrorProblems(validation.problems) &&
    !fileHasNoDataRows(file)
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
    <div
      role="main"
      style={PAGE_CONTAINER}
      className={PAGE_CONTAINER_CLASS}
      data-testid="txr-intake-predict-files"
    >
      <div style={MAIN_COLUMN}>
        <div>
          <div style={STEP_LINE}>Step 3 of 4</div>
          <h1 style={TITLE}>Add the patients to predict</h1>
          <p style={INTRO}>
            Only their blood measurements. Used only for the analyses you start. Match the
            example; we check the file as soon as you choose it.
          </p>
        </div>

        {pendingUseId !== null ? (
          <p data-testid="txr-intake-pending-use" style={INTRO}>
            You chose the model &ldquo;{pendingUseName ?? 'this model'}&rdquo;. Add its
            patients&rsquo; measurements to predict.
          </p>
        ) : null}

        <TxrFileCard
          kind="measurements"
          mode="predict"
          file={file}
          busy={busy}
          error={cardError}
          onPick={picked => void handlePick('measurements', picked)}
          onRemove={handleRemove}
          onAcceptJoin={acceptJoin}
          onRejectJoin={rejectJoin}
          onAcceptVocab={acceptVocab}
          onRejectVocab={rejectVocab}
          onAcceptColumn={acceptColumn}
          onRejectColumn={rejectColumn}
          onDownloadTemplate={() => void downloadCsv('template')}
          onDownloadExample={() => void downloadCsv('example')}
        />

        <div style={FOOTER} className="txr-intake-footer">
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
          <li style={ASIDE_ITEM}>
            <b>Before treatment</b>
            <br />
            (day 0): needed by almost all models
          </li>
          <li style={ASIDE_ITEM}>
            <b>Early on treatment</b>
            <br />
            (about day 14 to 28): needed by the models that look at change
          </li>
          <li style={ASIDE_ITEM}>
            <b>Markers</b>
            <br />
            : ctDNA, LDH, blood counts and tumour markers are the most used. The more you measured,
            the more models can run
          </li>
          <li style={ASIDE_ITEM}>
            <b>Units</b>
            <br />
            : add the unit column so we can check that the scale matches the model
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
