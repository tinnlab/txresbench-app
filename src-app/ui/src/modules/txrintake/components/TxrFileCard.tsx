/**
 * TxrFileCard — ONE file card of the intake flow (PROV-UI-INTAKE-5).
 *
 * The shared card surface of screens C, N and — reused verbatim — ui-run's
 * E-screen "Change files" / "Predict" slots (DEC-21): the board's column
 * table (static per-role copy of `Files.dc.html` / `PredictFiles.dc.html`),
 * the adopted file's first rows, the template + full-example download links,
 * the drop zone (`TxrFileDrop`, kit `Upload`) and, once a file is chosen,
 * the "Choose a different file" link in its place (every state —
 * step3-file-cards B). What the check says about the file (the status box,
 * the problem list and the offer rows) is `TxrFileMessages`: rendered here
 * for `messages: 'inline'` under the preview (the E-screen dialog), or in
 * the card's own full-width row — the card's LAST child, below both halves,
 * introduced by the file's title — for `messages: 'row'` (screens C and N
 * — step3-file-cards A).
 *
 * The surface is CONTROLLED — the frozen props carry the card facts and the
 * host's store actions (onPick / onRemove / the four offer answers / the two
 * downloads); the card holds no flow state of its own. The messages read the
 * shared `validation` slot (the E/D/I seam, DRIFT-1 ITEM-7 #4 — see
 * `TxrFileMessages`), so any mount renders the SAME validation facts with no
 * duplicate fetch or re-derived state.
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
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Button } from '@txresbench/kit'
import type { FileTableKind } from '@/api-client/types'
import { exampleLinkLabel, templateLinkLabel } from '../lib/download'
import { SavedFileNotice } from '@/modules/txrshell/components/SavedFileNotice'
import type { ColumnRenameOffer, JoinOffer, LoadedFile, VocabOffer } from '../types'
import { TxrFileDrop } from './TxrFileDrop'
import { TxrFileMessages, fileMessagesTitle } from './TxrFileMessages'

/** The card's mode — screen C's two cards vs screen N's one. */
export type TxrFileCardMode = 'study' | 'predict'

/** The PROV-UI-INTAKE-5 surface: props + the shared store's validation. */
export interface TxrFileCardProps {
  kind: FileTableKind
  mode: TxrFileCardMode
  file: LoadedFile | null
  busy: boolean
  error: string | null
  /** Where the desktop app's Save dialog put this card's template/example (null: nothing to show). */
  savedPath?: string | null
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
  /** The card holds the example set's table (qa-fixes3 ITEM-4 — the badge). */
  isExample?: boolean
  /**
   * Where the check's messages render (step3-file-cards A): `'inline'` (the
   * default — inside the card, under the preview: the E-screen dialog) or
   * `'row'` (a full-width row INSIDE the card, after both halves and as the
   * card's last child, titled with the file's name: screens C and N). With
   * `'row'` and no chosen file the card renders no messages at all.
   */
  messages?: 'inline' | 'row'
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

/** The card's full-width messages row (step3-file-cards A): its own flex
 *  line under BOTH halves at every width, divided from them by the card's
 *  border token, with a little top padding. */
const MESSAGES_ROW: CSSProperties = {
  flex: '1 1 100%',
  minWidth: 0,
  borderTop: '1px solid var(--txr-border)',
  paddingTop: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

/** The row's title: the file kind and the adopted file's name. */
const MESSAGES_TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 17,
  overflowWrap: 'anywhere',
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

const EXAMPLE_LABEL: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }
const EXAMPLE_TABLE: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--txr-border)',
  borderRadius: 8,
  borderCollapse: 'separate',
  borderSpacing: 0,
  width: '100%',
}
const EXAMPLE_HEAD: CSSProperties = {
  textAlign: 'left',
  padding: '4px 10px',
  background: 'var(--txr-surface-dim)',
  borderBottom: '1px solid var(--txr-border)',
  fontWeight: 600,
  fontSize: 12.5,
  // F9: the header takes the natural column width (a wrapped header would
  // pinch the column and re-introduce the phone squeeze).
  whiteSpace: 'nowrap',
  // app-shell ITEM-2: the preview table's header sticks inside its OWN
  // bounded box (the audit's "each preview table has its own bounded region
  // with a sticky header") — the box is the table's scrollport, so the
  // header stays put while the rows move.
  position: 'sticky',
  top: 0,
  zIndex: 2,
}
const EXAMPLE_ENTRY: CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid var(--txr-surface-raised)',
  fontSize: 12.5,
  // F9: a preview entry never wraps mid-word — the natural column width is
  // the scrollbox's, never a squeezed 3-line id (the phone report's cut).
  whiteSpace: 'nowrap',
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

/** "Choose a different file" — the card's remove link (every state). */
const CHOOSE_AGAIN_LINK: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 13,
  color: 'var(--txr-brand)',
  fontWeight: 600,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}

/** How many of the adopted file's first rows the card shows (board clip). */
const EXAMPLE_ROW_LIMIT = 5

export function TxrFileCard(props: TxrFileCardProps) {
  const {
    kind,
    mode,
    file,
    busy,
    error,
    savedPath = null,
    messages = 'inline',
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
  const spec = cardSpec(mode, kind)
  const exampleRows = (file?.table.rows ?? []).slice(0, EXAMPLE_ROW_LIMIT)
  // The messages row's accessible name is its own title (aria-labelledby).
  const messagesTitleId = useId()
  const offerHandlers = {
    onAcceptJoin,
    onRejectJoin,
    onAcceptVocab,
    onRejectVocab,
    onAcceptColumn,
    onRejectColumn,
  }

  return (
    <section style={CARD} data-testid={`txr-intake-file-card-${kind}`}>
      <div style={CARD_LEFT}>
        <h2 style={CARD_TITLE}>
          {spec.title}
          {props.isExample === true ? (
            <span
              data-testid={`txr-file-card-example-${kind}`}
              style={{
                fontSize: 12.5,
                padding: '2px 10px',
                borderRadius: 999,
                background: 'var(--txr-accent-soft)',
                color: 'var(--txr-brand-ink)',
                marginLeft: 10,
                verticalAlign: 'middle',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              Example
            </span>
          ) : null}
        </h2>
        <p style={CARD_DESC}>{spec.description}</p>
        <RoleTable roles={spec.roles} />
      </div>

      <div style={CARD_RIGHT}>
        {file !== null ? (
          exampleRows.length > 0 ? (
            <>
              <div style={EXAMPLE_LABEL}>Example (first rows)</div>
              <FirstRows columns={file.table.columns} rows={exampleRows} />
            </>
          ) : (
            // R2-8: a header-only file's "Example (first rows)" was an empty
            // table — the honest line instead.
            <div data-testid={`txr-intake-file-no-rows-${kind}`} style={EXAMPLE_LABEL}>
              No data rows to show.
            </div>
          )
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
            {templateLinkLabel()}
          </Button>
          <Button
            variant="link"
            data-testid={`txr-intake-download-example-${kind}`}
            style={DOWNLOAD_LINK_PLAIN}
            onClick={onDownloadExample}
          >
            {exampleLinkLabel(false)}
          </Button>
        </div>

        {error !== null ? (
          <Alert tone="error" data-testid={`txr-intake-file-error-${kind}`}>
            {error}
          </Alert>
        ) : null}
        {savedPath !== null ? (
          <SavedFileNotice path={savedPath} testId={`txr-intake-file-saved-${kind}`} />
        ) : null}

        {/* step3-file-cards B: a chosen file can ALWAYS be changed — the
            drop zone's place holds "Choose a different file" in every state
            (waiting, checking, ready, ready with notes, problems); the remove
            empties the slot, the drop zone comes back and the next pick
            re-runs the check for the pair. */}
        {file === null ? (
          <TxrFileDrop kind={kind} busy={busy} onPick={onPick} />
        ) : (
          <Button
            variant="link"
            data-testid={`txr-intake-file-choose-again-${kind}`}
            style={CHOOSE_AGAIN_LINK}
            onClick={onRemove}
          >
            Choose a different file
          </Button>
        )}

        {messages === 'inline' ? (
          <TxrFileMessages kind={kind} mode={mode} file={file} onRemove={onRemove} {...offerHandlers} />
        ) : null}
      </div>

      {/* step3-file-cards A: with a chosen file the check's messages are the
          card's own full-width row — after both halves, the card's last
          child, titled with the file kind and name (the card shows the file
          name nowhere else). No file: no row. */}
      {messages === 'row' && file !== null ? (
        <section
          style={MESSAGES_ROW}
          data-testid={`txr-intake-file-messages-${kind}`}
          aria-labelledby={`${messagesTitleId}-${kind}`}
        >
          <h3
            id={`${messagesTitleId}-${kind}`}
            style={MESSAGES_TITLE}
            data-testid={`txr-intake-file-messages-title-${kind}`}
          >
            {fileMessagesTitle(kind, file)}
          </h3>
          <TxrFileMessages kind={kind} mode={mode} file={file} onRemove={onRemove} {...offerHandlers} />
        </section>
      ) : null}
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

/** The adopted file's first rows (the board's "Example (first rows)" box).
 *  app-shell ITEM-2: the box is the preview's OWN bounded region — a fixed
 *  max height with overflow on BOTH axes and the sticky header above, so a
 *  tall preview scrolls inside its box and the header never leaves it (the
 *  audit's /files + /predict-files byte; the card never grows the page).
 *  qa-fixes4 F9: the table's entries are NOWRAP (a patient id never wraps
 *  mid-word and a wide unit column never squeezes the id column into 3
 *  lines — the phone preview's cut columns), the box keeps the table's
 *  NATURAL width so every column is reachable, and an overflow shadow hints
 *  that the box scrolls sideways (the round-3 report's "cut at 'os_e' with
 *  no scroll hint"). */
function FirstRows({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [scrollsSideways, setScrollsSideways] = useState(false)
  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = () => {
      setScrollsSideways(box.scrollWidth > box.clientWidth + 1)
    }
    measure()
    box.addEventListener('scroll', measure)
    // jsdom has no ResizeObserver (the ScrollRegion precedent); the scroll
    // listener + the initial measure still drive the hint.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(box)
      return () => {
        box.removeEventListener('scroll', measure)
        observer.disconnect()
      }
    }
    return () => {
      box.removeEventListener('scroll', measure)
    }
  }, [columns])
  return (
    <div style={{ position: 'relative' }}>
      {/* ITEM-6 F9: the table scrolls INSIDE its box (the last column of the
          patients preview used to clip at the card edge with no way to see it —
          "response_da" cut mid-word; the box's own overflow keeps the page
          fixed and a long value's tail no longer hides the neighbour). */}
      <div
        ref={boxRef}
        className="txr-intake-first-rows"
        style={{ overflow: 'auto', borderRadius: 8, maxHeight: 280, maxWidth: '100%' }}
      >
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
      {/* F9: the sideways-scroll hint — a right-edge fade over the box row
          (the viewer only when the box actually overflows its width). */}
      {scrollsSideways ? (
        <div
          data-testid="txr-intake-first-rows-scroll-hint"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 44,
            pointerEvents: 'none',
            background:
              'linear-gradient(to left, var(--txr-surface) 0%, var(--txr-surface) 12%, transparent 100%)',
            borderRadius: '0 8px 8px 0',
          }}
        />
      ) : null}
    </div>
  )
}
