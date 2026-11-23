/**
 * TxrFileMessages — what the check says about ONE adopted file
 * (step3-file-cards): the join / vocabulary / column-rename offer rows
 * (`TxrJoinOffer` / `TxrVocabOffer` / `TxrColumnOffer`), the status box
 * (green board line / red "N problems in N rows" / the neutral "rows read"
 * state) and the per-row problem list (`TxrProblemList`).
 *
 * The card host (`TxrFileCard`) places these parts in a full-width row
 * INSIDE the card — the card's own last child, after its two halves, with
 * the file's title ("Patients file: <name>") — for the C and N screens'
 * cards and the E-screen "Change files" dialog alike. The parts themselves
 * (content, tone, buttons and test ids) are the card's former ones, byte
 * for byte; the offers report the same OFFER OBJECT to the same host
 * callbacks.
 *
 * Like the card, the surface is CONTROLLED: the props carry the file and the
 * host's store actions; the one store read is the shared `validation` slot
 * (and the sibling slot, for the "waiting for the other file" line), so
 * every mount renders the SAME validation facts with no duplicate fetch.
 *
 * Problems that concern both files (a measurements row naming a patient the
 * patients file lacks) are assigned to ONE side by `cardProblems`
 * (`lib/flow.ts`), so each of them shows once, in that card.
 *
 * Copy rule (DEC-13): every label is the board's verbatim bytes and every
 * number is computed from the file + validate response. Colors per DEC-14:
 * `var(--txr-success)` ready, `var(--txr-danger)` error box,
 * `var(--txr-warning)` warning / notes.
 */

import type { CSSProperties } from 'react'
import { Button, Spinner } from '@txresbench/kit'
import { useStore } from 'zustand'
import type { FileTableKind } from '@/api-client/types'
import {
  fileHasNoDataRows,
  hasErrorProblems,
  measurementsStatus,
  missingColumns,
  patientsStatus,
  predictMeasurementsStatus,
} from '../lib/flow'
import type { CardStatus } from '../lib/flow'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { ColumnRenameOffer, JoinOffer, LoadedFile, VocabOffer } from '../types'
import { TxrColumnOffer } from './TxrColumnOffer'
import { TxrJoinOffer } from './TxrJoinOffer'
import { TxrProblemList } from './TxrProblemList'
import { TxrVocabOffer } from './TxrVocabOffer'

/** The mount's mode — screen C's two files vs screen N's one. */
export type TxrFileMessagesMode = 'study' | 'predict'

/** The host's answers to the offers (the card's four offer callbacks). */
export interface TxrFileOfferHandlers {
  onAcceptJoin: (offer: JoinOffer) => void
  onRejectJoin: (offer: JoinOffer) => void
  onAcceptVocab: (offer: VocabOffer) => void
  onRejectVocab: (offer: VocabOffer) => void
  onAcceptColumn: (offer: ColumnRenameOffer) => void
  onRejectColumn: (offer: ColumnRenameOffer) => void
}

/** One file's messages: the file, its mode and the host's store actions. */
export interface TxrFileMessagesProps extends TxrFileOfferHandlers {
  kind: FileTableKind
  mode: TxrFileMessagesMode
  file: LoadedFile | null
  /** "Fix and choose the file again" (the red box) — the card's remove path. */
  onRemove: () => void
}

/** The mode's green box builder (the two boards' lines, one place). */
function statusFor(
  mode: TxrFileMessagesMode,
  kind: FileTableKind,
  validation: Parameters<typeof patientsStatus>[0],
): CardStatus {
  if (kind === 'patients') return patientsStatus(validation)
  return mode === 'predict' ? predictMeasurementsStatus(validation) : measurementsStatus(validation)
}

/** Status boxes: green ready, red problems, the neutral "checking" state,
 *  and the READY-WITH-NOTES state (R2-6: the green "Ready." card carrying
 *  warning notes contradicted itself — the box turns warning-toned and the
 *  notes group reads "Ready, with N notes" instead of a quiet "N notes"
 *  under a green all-clear). */
const STATUS: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}
const STATUS_GOOD: CSSProperties = { ...STATUS, border: '1px solid var(--txr-success-border)', background: 'var(--txr-success-soft-2)' }
const STATUS_GOOD_NOTES: CSSProperties = {
  ...STATUS,
  border: '1px solid var(--txr-warning)',
  background: 'var(--txr-bg)',
}
const STATUS_BAD: CSSProperties = { ...STATUS, border: '1px solid var(--txr-danger-border)', background: 'var(--txr-danger-soft)' }
const STATUS_NEUTRAL: CSSProperties = {
  ...STATUS,
  border: '1px solid var(--txr-border-subtle)',
  background: 'var(--txr-bg)',
}

const STATUS_HEADING: CSSProperties = { fontWeight: 700, margin: 0 }
const STATUS_GOOD_HEADING: CSSProperties = { ...STATUS_HEADING, color: 'var(--txr-success)' }
const STATUS_BAD_HEADING: CSSProperties = { ...STATUS_HEADING, color: 'var(--txr-danger)' }
const STATUS_LINE: CSSProperties = { fontSize: 13.5, color: 'var(--txr-text-2)', margin: 0 }

/** The checking line's row (R2-7: an explicit progress state between the
 *  pick and the check finishing — the old neutral box repeated the page's
 *  intro and looked finished while the validation was still running). */
const CHECKING_LINE: CSSProperties = { ...STATUS_LINE, display: 'flex', alignItems: 'center', gap: 8 }

/** A warning-only group under the ready box (warnings never block, DEC-10). */
const WARNING_GROUP: CSSProperties = {
  borderTop: '1px solid var(--txr-surface-raised)',
  marginTop: 8,
  paddingTop: 6,
}
const WARNING_TITLE: CSSProperties = { fontWeight: 700, color: 'var(--txr-warning)', fontSize: 13 }

const FIX_LINK: CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: 'var(--txr-brand)',
  fontWeight: 600,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}

const OFFERS: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }

/** The block's own column (offers first, then the status box). */
const MESSAGES: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }

/** The title's kind words (the file kind, before the file name). */
const KIND_LABEL: Record<FileTableKind, string> = {
  patients: 'Patients file',
  measurements: 'Measurements file',
}

/** The block title: the file kind and the adopted file's name. */
export function fileMessagesTitle(kind: FileTableKind, file: LoadedFile): string {
  return `${KIND_LABEL[kind]}: ${file.source.name}`
}

/** The row count a box's "N problems in N rows" heading reads. */
function fileRowCount(file: LoadedFile | null): number | null {
  return file?.inspection?.summary.rows ?? null
}

/**
 * One file's offers + status box (no title, no frame). Renders nothing
 * before a file is adopted — there is nothing to report yet.
 */
export function TxrFileMessages(props: TxrFileMessagesProps) {
  const {
    kind,
    mode,
    file,
    onRemove,
    onAcceptJoin,
    onRejectJoin,
    onAcceptVocab,
    onRejectVocab,
    onAcceptColumn,
    onRejectColumn,
  } = props
  // The ONE validation slot the C/N screens (and the E-screen host) share —
  // the status box's facts are the store's last validated response, never a
  // per-mount fetch or a second copy.
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  // R2-7: the C screen's check needs BOTH files — the patients box's
  // "checking" state before the measurements file exists would be a lie
  // (the flow is not running; the page's footer says both files are
  // needed). The sibling slot tells the two states apart.
  const siblingFile = useStore(useTxrIntakeStore, s =>
    mode === 'study' ? (kind === 'patients' ? s.measurements : s.patients) : null,
  )
  if (file === null) return null
  const waitingForSibling = mode === 'study' && siblingFile === null
  const problems = file.problems
  const errors = hasErrorProblems(problems)
  const errorsOnly = problems.filter(problem => problem.severity === 'error')
  const rowCount = fileRowCount(file)
  const status = validation !== null ? statusFor(mode, kind, validation) : null
  const warnings = problems.filter(problem => problem.severity === 'warning')
  const hasNoDataRows = fileHasNoDataRows(file)
  // ITEM-6 F5d: the red box counts and lists ERROR problems; warnings are
  // notes ("N notes"), even under an error — one severity per box.
  const errorCount = errorsOnly.length
  // R3-intake-6: the one line naming the canonical columns the renamed-file
  // case is missing — visible beside the offers AND after they are declined
  // (the grouped R02 lines repeat the same fact per column inside a wall of
  // per-row counts; the suggestions never show the canonical names).
  const missing = missingColumns(errorsOnly, kind)
  const hasOffers =
    file.joinOffers.length > 0 || file.vocabOffers.length > 0 || file.columnOffers.length > 0
  // R2-4: while the mapping/join/vocabulary suggestions are pending they are
  // the action to take, and the problem list is HIDDEN — the renamed-file
  // case offered its suggestions BELOW a 1,894-line red wall; the list
  // reappears once the offers are declined (or accepted — the rename
  // re-validates and the problems are re-derived from the canonical table).
  const showProblemDetails = !hasOffers
  // R2-6: a file that is READY but carries warning notes is not the green
  // all-clear ("Ready, with notes" is its own state — see the styles above).
  const readyWithNotes = status !== null && warnings.length > 0 && !hasNoDataRows

  return (
    <div style={MESSAGES}>
      {/* R2-4: the suggestions come FIRST — the pending question is the
          action to take; the status box's problem list follows (and is
          hidden until the offers are resolved). */}
      {hasOffers ? (
        <div style={OFFERS}>
          {file.joinOffers.map(offer => (
            <TxrJoinOffer key={offer.key} offer={offer} onAccept={onAcceptJoin} onReject={onRejectJoin} />
          ))}
          {file.vocabOffers.map(offer => (
            <TxrVocabOffer
              key={offer.key}
              offer={offer}
              onAccept={onAcceptVocab}
              onReject={onRejectVocab}
            />
          ))}
          {file.columnOffers.map(offer => (
            <TxrColumnOffer
              key={offer.from}
              offer={offer}
              onAccept={onAcceptColumn}
              onReject={onRejectColumn}
            />
          ))}
        </div>
      ) : null}

      {/* R2-7: the status box shows as soon as the file is ADOPTED (its
          inspecting/validating state is an explicit phase). */}
      <div
        data-testid={`txr-intake-file-status-${kind}`}
        style={
          errors || hasNoDataRows
            ? STATUS_BAD
            : status !== null
              ? readyWithNotes
                ? STATUS_GOOD_NOTES
                : STATUS_GOOD
              : STATUS_NEUTRAL
        }
      >
        {errors || hasNoDataRows ? (
          <>
            {hasNoDataRows ? (
              <div style={STATUS_BAD_HEADING}>This file has no data rows</div>
            ) : (
              <div style={STATUS_BAD_HEADING}>
                {errorCount} problem{errorCount === 1 ? '' : 's'}
                {rowCount !== null && rowCount > 0
                  ? ` in ${rowCount} row${rowCount === 1 ? '' : 's'}`
                  : ''}
              </div>
            )}
            {missing.length > 0 ? (
              <div
                data-testid={`txr-intake-file-missing-columns-${kind}`}
                style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-danger)' }}
              >
                Missing columns: {missing.join(', ')}
              </div>
            ) : null}
            {showProblemDetails ? (
              <>
                <TxrProblemList kind={kind} problems={errorsOnly} />
                {/* R2-8: a header-only file's warning notes (R14's "fewer
                    than 10 patients …") describe rows that do not exist —
                    the "no data rows" heading is the one true fact. */}
                {warnings.length > 0 && !hasNoDataRows ? (
                  <div style={WARNING_GROUP}>
                    <div style={WARNING_TITLE}>
                      {warnings.length} note{warnings.length === 1 ? '' : 's'}
                    </div>
                    <TxrProblemList kind={kind} group="notes" problems={warnings} />
                  </div>
                ) : null}
              </>
            ) : null}
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
            {showProblemDetails && warnings.length > 0 ? (
              <div style={WARNING_GROUP}>
                <div style={WARNING_TITLE}>
                  {readyWithNotes
                    ? `Ready, with ${warnings.length} note${warnings.length === 1 ? '' : 's'}`
                    : `${warnings.length} note${warnings.length === 1 ? '' : 's'}`}
                </div>
                <TxrProblemList kind={kind} group="notes" problems={warnings} />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div style={STATUS_HEADING}>
              {rowCount !== null ? `${rowCount} rows read` : 'File read'}
            </div>
            <p style={STATUS_LINE}>
              {waitingForSibling ? (
                'We check the files once both are here.'
              ) : (
                <span style={CHECKING_LINE}>
                  <Spinner size="sm" label="Checking the file" />
                  Checking the file…
                </span>
              )}
            </p>
            {showProblemDetails && warnings.length > 0 ? (
              <TxrProblemList kind={kind} group="notes" problems={warnings} />
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
