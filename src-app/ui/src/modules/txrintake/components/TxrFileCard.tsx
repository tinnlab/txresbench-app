/**
 * TxrFileCard — ONE file card of the intake flow (PROV-UI-INTAKE-5).
 *
 * The shared card surface of screens C, N and — reused verbatim — ui-run's
 * E-screen "Change files" / "Predict" slots (DEC-21): the board's column
 * table (static per-role copy of `Files.dc.html` / `PredictFiles.dc.html`),
 * the adopted file's first rows, the template + full-example download links,
 * the drop zone (`TxrFileDrop`, kit `Upload`), the status box (green board
 * line / red "N problems in N rows" / the neutral "check as soon as you
 * choose it" state), the per-row problem list (`TxrProblemList`) and the
 * join / vocabulary / column-rename offer rows (`TxrJoinOffer` /
 * `TxrVocabOffer` / `TxrColumnOffer`).
 *
 * The surface is CONTROLLED — the frozen props carry the card facts and the
 * host's store actions (onPick / onRemove / the four offer answers / the two
 * downloads); the card holds no flow state of its own. The ONE store read is
 * the shared `validation` slot: the E/D/I seam (DRIFT-1 ITEM-7 #4) keeps a
 * single `ValidationResponse` in the `TxrIntake` store, and the plan's props
 * name no validation body — the card reads the same slot the E screen's
 * host reads, so any of the three mounts renders the SAME validation facts
 * with no duplicate fetch or re-derived state.
 *
 * The two mounts differ only in the mode: `'study'` (screen C — the two
 * cards, patients + measurements) and `'predict'` (screen N — the ONE
 * measurements card, board PredictFiles.dc.html; a predict + patients mount
 * does not exist, so the predict spec is the measurements one). The status
 * box's green line is the mode's own builder (patients box = the C line,
 * measurements box = the C "Ready." line / the N board continuation — the
 * two boards' strings live in `lib/flow.ts`).
 *
 * Copy rule (DEC-13): every label is the board's verbatim bytes and every
 * number is computed from the file + validate response (row counts, problem
 * counts, marker lists) — never a design-example count. Colors per DEC-14:
 * `var(--txr-success)` ready, `var(--txr-danger)` error box, `var(--txr-warning)` warning / notes.
 */

import type { CSSProperties } from 'react'
import { Alert, Button } from '@ziee/kit'
import { useStore } from 'zustand'
import type { FileTableKind } from '@/api-client/types'
import {
  fileHasNoDataRows,
  hasErrorProblems,
  measurementsStatus,
  patientsStatus,
  predictMeasurementsStatus,
} from '../lib/flow'
import type { CardStatus } from '../lib/flow'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { ColumnRenameOffer, JoinOffer, LoadedFile, VocabOffer } from '../types'
import { TxrColumnOffer } from './TxrColumnOffer'
import { TxrFileDrop } from './TxrFileDrop'
import { TxrJoinOffer } from './TxrJoinOffer'
import { TxrProblemList } from './TxrProblemList'
import { TxrVocabOffer } from './TxrVocabOffer'

/** The card's mode — screen C's two cards vs screen N's one. */
export type TxrFileCardMode = 'study' | 'predict'

/** The PROV-UI-INTAKE-5 surface: props + the shared store's validation. */
export interface TxrFileCardProps {
  kind: FileTableKind
  mode: TxrFileCardMode
  file: LoadedFile | null
  busy: boolean
  error: string | null
  onPick: (file: File) => void
  onRemove: () => void
  onAcceptJoin: (offer: JoinOffer) => void
  onRejectJoin: (offer: JoinOffer) => void
  onAcceptVocab: (offer: VocabOffer) => void
  onRejectVocab: (offer: VocabOffer) => void
  onAcceptColumn: (offer: ColumnRenameOffer) => void
  onRejectColumn: (offer: ColumnRenameOffer) => void
  onDownloadTemplate: () => void
  onDownloadExample: () => void
}

/** The board's bordered card. */
const CARD: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 12,
  background: 'var(--txr-surface)',
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

const CARD_DESC: CSSProperties = { margin: '2px 0 10px', color: 'var(--txr-text-2)', fontSize: 14 }

/** The static per-role column table (board bytes: role, tag, copy). */
const ROLE_TABLE: CSSProperties = { borderCollapse: 'collapse' }
const ROLE_NAME: CSSProperties = {
  padding: '3px 10px 3px 0',
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12.5,
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
  // ITEM-6 F11: one fixed name-column width so the two cards' tag columns
  // start at the SAME x (the Patients names are longer than the
  // Measurements names — the unaligned tag column was the report's
  // cosmetic complaint; the fixed width is the board's aligned look).
  minWidth: 168,
}
const ROLE_TAG: CSSProperties = {
  padding: '3px 10px 3px 0',
  fontSize: 12.5,
  color: 'var(--txr-muted)',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
}
const ROLE_COPY: CSSProperties = { padding: '3px 0', fontSize: 13, color: 'var(--txr-text-2)' }

/** The board's two column tables: grouped role rows, verbatim copy. */
interface RoleRow {
  roles: string[]
  tag: 'required' | 'optional'
  copy: string
}

/** One card spec: title, description and the board's role table. */
interface CardSpec {
  title: string
  description: string
  roles: RoleRow[]
}

const STUDY_PATIENTS: CardSpec = {
  title: 'Patients',
  description: 'One row per patient. Time is counted in days from the start of treatment.',
  roles: [
    { roles: ['patient_id'], tag: 'required', copy: 'your own code, the same in both files' },
    { roles: ['pfs_days'], tag: 'required', copy: 'days until progression, or last follow-up' },
    {
      roles: ['pfs_event'],
      tag: 'required',
      copy: '1 = progressed or died, 0 = still well at last follow-up',
    },
    // qa-fixes ITEM-6 F5a: the board's "optional" tag for os_days/os_event
    // contradicts the validator's R02 set (D48 — the four board outcome
    // columns are required; responder/response_day are the optional pair);
    // the card now says what the check enforces, the "required column `os_days`
    // is missing" line is no longer a surprise.
    { roles: ['os_days', 'os_event'], tag: 'required', copy: 'the same for death alone' },
    { roles: ['age', 'sex', 'stage'], tag: 'optional', copy: 'used as extra inputs by some methods' },
  ],
}

const STUDY_MEASUREMENTS: CardSpec = {
  title: 'Measurements',
  description:
    'One row per marker per blood draw. Day 0 is the start of treatment; draws before it are negative.',
  roles: [
    { roles: ['patient_id'], tag: 'required', copy: 'matches the patients file' },
    { roles: ['day'], tag: 'required', copy: 'days from the start of treatment' },
    { roles: ['marker'], tag: 'required', copy: 'name as you use it, for example LDH' },
    { roles: ['value'], tag: 'required', copy: 'a number' },
    { roles: ['unit'], tag: 'optional', copy: 'for example U/L; lets us check scales' },
  ],
}

/** The N screen's measurements spec (board PredictFiles.dc.html — its own
 *  per-role copy; there is NO patients file on this screen). */
const PREDICT_MEASUREMENTS: CardSpec = {
  title: 'Measurements of the patients to predict',
  description:
    'One row per marker per blood draw. Day 0 is the start of treatment; draws before it are negative.',
  roles: [
    { roles: ['patient_id'], tag: 'required', copy: 'your own code' },
    { roles: ['day'], tag: 'required', copy: 'days from the start of treatment' },
    { roles: ['marker'], tag: 'required', copy: 'for example LDH, ctDNA' },
    { roles: ['value'], tag: 'required', copy: 'a number' },
    { roles: ['unit'], tag: 'optional', copy: 'lets us check the scale against the model' },
  ],
}

/** The card's spec for a mount (predict is always the measurements card). */
function cardSpec(mode: TxrFileCardMode, kind: FileTableKind): CardSpec {
  if (mode === 'predict') return PREDICT_MEASUREMENTS
  return kind === 'patients' ? STUDY_PATIENTS : STUDY_MEASUREMENTS
}

/** The mode's green box builder (the two boards' lines, one place). */
function statusFor(
  mode: TxrFileCardMode,
  kind: FileTableKind,
  validation: Parameters<typeof patientsStatus>[0],
): CardStatus {
  if (kind === 'patients') return patientsStatus(validation)
  return mode === 'predict' ? predictMeasurementsStatus(validation) : measurementsStatus(validation)
}

const EXAMPLE_LABEL: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }
const EXAMPLE_TABLE: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--txr-border)',
  borderRadius: 8,
  borderCollapse: 'collapse',
  width: '100%',
}
const EXAMPLE_HEAD: CSSProperties = {
  textAlign: 'left',
  padding: '4px 10px',
  background: 'var(--txr-surface-dim)',
  borderBottom: '1px solid var(--txr-border)',
  fontWeight: 600,
  fontSize: 12.5,
}
const EXAMPLE_ENTRY: CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid var(--txr-surface-raised)',
  fontSize: 12.5,
}
const EXAMPLE_CODE: CSSProperties = {
  ...EXAMPLE_ENTRY,
  fontFamily: "'Source Code Pro', monospace",
}

const DOWNLOADS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }
const DOWNLOAD_LINK: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--txr-brand)',
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
const STATUS_GOOD: CSSProperties = { ...STATUS, border: '1px solid var(--txr-success-border)', background: 'var(--txr-success-soft-2)' }
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

/** How many of the adopted file's first rows the card shows (board clip). */
const EXAMPLE_ROW_LIMIT = 5

/** The row count a card's "N problems in N rows" box reads. */
function cardRowCount(file: LoadedFile | null): number | null {
  return file?.inspection?.summary.rows ?? null
}

export function TxrFileCard(props: TxrFileCardProps) {
  const {
    kind,
    mode,
    file,
    busy,
    error,
    onPick,
    onRemove,
    onAcceptJoin,
    onRejectJoin,
    onAcceptVocab,
    onRejectVocab,
    onAcceptColumn,
    onRejectColumn,
    onDownloadTemplate,
    onDownloadExample,
  } = props
  // The ONE validation slot the C/N screens (and the E-screen host) share —
  // see the header: the status box's facts are the store's last validated
  // response, never a per-mount fetch or a second copy.
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const spec = cardSpec(mode, kind)
  const exampleRows = (file?.table.rows ?? []).slice(0, EXAMPLE_ROW_LIMIT)
  const problems = file?.problems ?? []
  const errors = hasErrorProblems(problems)
  const errorsOnly = problems.filter(problem => problem.severity === 'error')
  const rowCount = cardRowCount(file)
  const status = validation !== null ? statusFor(mode, kind, validation) : null
  const showStatusBox = file !== null && file.inspection !== null
  const warnings = problems.filter(problem => problem.severity === 'warning')
  const hasNoDataRows = fileHasNoDataRows(file)
  // ITEM-6 F5d: the red box counts and lists ERROR problems; warnings are
  // notes ("N notes"), even under an error — one severity per box.
  const errorCount = errorsOnly.length
  const hasOffers =
    (file?.joinOffers.length ?? 0) > 0 ||
    (file?.vocabOffers.length ?? 0) > 0 ||
    (file?.columnOffers.length ?? 0) > 0

  return (
    <section style={CARD} data-testid={`txr-intake-file-card-${kind}`}>
      <div style={CARD_LEFT}>
        <h2 style={CARD_TITLE}>{spec.title}</h2>
        <p style={CARD_DESC}>{spec.description}</p>
        <RoleTable roles={spec.roles} />
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
            onClick={onDownloadTemplate}
          >
            Download the template (CSV)
          </Button>
          <Button
            variant="link"
            data-testid={`txr-intake-download-example-${kind}`}
            style={DOWNLOAD_LINK_PLAIN}
            onClick={onDownloadExample}
          >
            Download the full example
          </Button>
        </div>

        {error !== null ? (
          <Alert tone="error" data-testid={`txr-intake-file-error-${kind}`}>
            {error}
          </Alert>
        ) : null}

        {file === null ? (
          <TxrFileDrop kind={kind} busy={busy} onPick={onPick} />
        ) : null}

        {showStatusBox ? (
          <div
            data-testid={`txr-intake-file-status-${kind}`}
            style={
              errors || hasNoDataRows
                ? STATUS_BAD
                : status !== null
                  ? STATUS_GOOD
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
                <TxrProblemList kind={kind} problems={errorsOnly} />
                {warnings.length > 0 ? (
                  <div style={WARNING_GROUP}>
                    <div style={WARNING_TITLE}>
                      {warnings.length} note{warnings.length === 1 ? '' : 's'}
                    </div>
                    <TxrProblemList kind={kind} group="notes" problems={warnings} />
                  </div>
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
                {warnings.length > 0 ? (
                  <div style={WARNING_GROUP}>
                    <div style={WARNING_TITLE}>
                      {warnings.length} note{warnings.length === 1 ? '' : 's'}
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
                <p style={STATUS_LINE}>We check each file as soon as you choose it.</p>
                {warnings.length > 0 ? <TxrProblemList kind={kind} group="notes" problems={warnings} /> : null}
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
          <div style={OFFERS}>
            {(file?.joinOffers ?? []).map(offer => (
              <TxrJoinOffer
                key={offer.key}
                offer={offer}
                onAccept={onAcceptJoin}
                onReject={onRejectJoin}
              />
            ))}
            {(file?.vocabOffers ?? []).map(offer => (
              <TxrVocabOffer
                key={offer.key}
                offer={offer}
                onAccept={onAcceptVocab}
                onReject={onRejectVocab}
              />
            ))}
            {(file?.columnOffers ?? []).map(offer => (
              <TxrColumnOffer
                key={offer.from}
                offer={offer}
                onAccept={onAcceptColumn}
                onReject={onRejectColumn}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** The board's static per-role table (role, tag, copy — verbatim bytes). */
function RoleTable({ roles }: { roles: RoleRow[] }) {
  return (
    <table className="txr-intake-role-table" style={ROLE_TABLE}>
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
    // ITEM-6 F9: the table scrolls INSIDE its box (the last column of the
    // patients preview used to clip at the card edge with no way to see it —
    // "response_da" cut mid-word; the box's own overflow keeps the page
    // fixed and the hint-comma inside cells no longer hides the tail).
    <div className="txr-intake-first-rows" style={{ overflowX: 'auto', borderRadius: 8 }}>
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
