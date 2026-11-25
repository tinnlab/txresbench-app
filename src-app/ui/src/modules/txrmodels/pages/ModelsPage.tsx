/**
 * Screen J — Your models (board `Models.dc.html`; ITEM-8, PROV-UI-MODELS-5):
 * the inventory of every kept model, from `model-store`'s
 * `GET /api/txr/models` (CONS-UM-4) — the fifth surface of the module, NOT
 * the shared selection list (the plan-audit ITEM-8: the board is an
 * inventory table; INV-1's "D, I and E are ONE list" names the choice
 * screens only).
 *
 * THE PAGE (the ITEM-1 chrome is the frame this item fills in):
 *
 * - the header: the board title + the permanent subtitle + the ONE
 *   search box ("Search sets and models" — the part-2 CLIENT-side search:
 *   this page loads the full model list, no `q` on the wire, no debounce,
 *   and filters in the page over the sets read: a set-name match shows
 *   the whole set, a model name/method-id match shows the model with its
 *   set row expanded to just the matches — "2 of 3 models match" — and
 *   clearing restores each set's own expand state; `useModelInventory`'s
 *   `q` stays for its other callers) + the two SORTABLE headers, `Name`
 *   and `Made` (buttons inside the `<th aria-sort>`; the state lives in
 *   the page: Made newest first at birth, clicking toggles, clicking the
 *   other column switches to it, Name starts A→Z; the ordering is the
 *   pure `buildModelTableRows`'s, never the component's) + "Open a model
 *   file" (the multipart import: a file picker hands the picked container
 *   to `POST /api/txr/models/import` — CONS-UM-9 — with `set_id` when the
 *   set-focus view is active, then the list refreshes; a FAILURE surfaces
 *   inline: the page's steady "The model file could not be opened." line,
 *   except the server's 409 SET_NAME_TAKEN, which names the remedy);
 * - the ONE table (the one-table round — the user's "one table with set
 *   rows"; brief 7's FOLDER-STYLE layout: the Set and Model columns
 *   merged into the one Name column): columns Name | Method | Predicts |
 *   Decision day | Trained on | Made | Actions. A SET row is the folder:
 *   the chevron disclosure (module-level expansion store, CLOSED by
 *   default), the folder glyph (the project's icon set — lucide's
 *   `Folder`, aria-hidden, never an emoji), the set name with the "(N)"
 *   count beside it (the visible "(N)" is aria-hidden; the
 *   screen-reader-only "N models" text is the one read — never both), the
 *   facts line UNDER the name (from the run/file, training files kept),
 *   the set's Made date, and the set actions (Rename set · Export set… ·
 *   Delete set — the same handlers/dialogs as the old section headers);
 *   the other entries are empty. While a search forces the set open with
 *   only the matches, the count reads "(2 of 3 models match)" in place of
 *   "(3)". A MODEL row is the same board row as before (same columns,
 *   same sublines, same per-model actions and testids), with the Name
 *   entry indented when the row sits under a set. Models with no set are
 *   plain top-level rows (never indented, nothing is ever empty in Name)
 *   — the "Not in a set" section heading and its facts line are gone;
 * - the window-filling box (the user's addendum): the table lives in the
 *   ONE box that takes the space left below the header + search row and
 *   above the footnotes (the page's flex spine), its height and width
 *   follow the window (no fixed pixel height, no JS resize listener). The
 *   rows scroll INSIDE the box, the column headers are sticky against it,
 *   wide content scrolls horizontally inside the same box, and the page
 *   itself does not scroll at a normal window size. The box is the page's
 *   ScrollRegion itself (the shell's one-region byte — the region is the
 *   box, so the app-shell route legs keep reading the
 *   sticky-header-on-region truth). Minimum box height ≈ 5 rows
 *   (`TABLE_BOX_MIN_HEIGHT`, stated in code): it rides the page's spine,
 *   so below it the routed area scrolls rather than the box painting over
 *   the footer (brief 4b F2); in FLOW mode (phone) the spine is the
 *   window height minus the 56 px shell header (brief 4b F3) so the box
 *   stays the scrollport there too. Phone width: the same box, the same
 *   data label card layout (a folder row is a card: name + count + facts
 *   on top, actions wrapped below; a loose model row is a card as before);
 *   expanding a set reveals it inside the box
 *   (`scrollIntoView({ block: 'nearest' })` — the last model row first,
 *   F8), and a typed search reveals its FIRST match the same way (part 2
 *   — the match's 44 px `scroll-margin-top` keeps it clear of the sticky
 *   thead). Sort is a desktop-table feature; the phone cards keep the
 *   default newest-first order (the sortable headers are hidden with the
 *   thead there — no phone control, no second order);
 * - the `?set=` focus (DEC-19): READ from the URL — the provider's
 *   `set_id` filter — with the "Showing the set '<name>' · Show all"
 *   affordance that clears the param (screen K's set links target
 *   `modelsPath(setId)`). The focus view shows ONLY that set row, always
 *   expanded (the banner and Show all are unchanged), and its chevron is
 *   inert (`disabled`, still aria-expanded=true — the focus is the URL's,
 *   not a togglable view-state, brief 4b F7). The focus keeps working with
 *   part 2's sort and search: the sort orders the focused set's rows, and
 *   a search still filters inside it (a no-hit search in the focus view is
 *   the honest no-match line);
 * - the footnotes: "Models are kept so you can use them for new
 *   patients." (qa-fixes4 ITEM-1, results-r3 R3-results-2: the board's
 *   "Models are stored in <path>" line + its "Open the folder" are gone —
 *   the models root is an internal host fact; the copy says what is kept,
 *   not where) + the board's deletion note verbatim;
 * - states: a first read in flight → the muted loading line; a failed
 *   read → the error line + Retry (the last response is kept on a
 *   transient error — the table never clears to nothing); an empty
 *   inventory → "No models yet." + the Open-a-model-file CTA; an empty
 *   search or set view → the honest no-match line.
 *
 * Copy rule (INV-4): every count/name is the engine's fact; the board's
 * `Documents/TxResBench/models/` path and the board's rows are design
 * examples, never constants — the footnote renders no path at all (the
 * provider's `models_dir` remains in the API response; only its rendering
 * was removed, qa-fixes4 ITEM-1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronRight, ArrowDown, ArrowUp, Folder } from 'lucide-react'
import { ApiClient } from '@/api-client'
import type { ModelSummary } from '@/api-client/types'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { PageFooterBar } from '@/modules/txrshell/components/PageFooterBar'
import { DemoRetentionBlock, useAppMode, useDemoUsage } from '@/modules/demo'
import { runAction } from '@/core/actions/defineAction'
import { Alert, Button, Input } from '@txresbench/kit'
import { useModelInventory } from '../data/useModelInventory'
import { useModelSets } from '../data/useModelSets'
import { useModelFileImport } from '../data/useModelFileImport'
import { downloadModelExport, modelExportLabel, setExportLabel, SET_EXPORT_FAILED_LINE } from '../lib/export'
import {
  SET_DELETE_FAILED_LINE,
  subscribeDeleteSetRequest,
  subscribeModelSetsChanged,
} from '../lib/setActions'
import { SavedFileNotice } from '@/modules/txrshell/components/SavedFileNotice'
import {
  formatMade,
  formatModelSublines,
  formatPredicts,
  formatSetFacts,
  formatSetMade,
  formatSetModelCount,
  formatSetModelMatchText,
  formatTrainedOn,
} from '../lib/format'
import {
  buildModelTableRows,
  MODEL_TABLE_DEFAULT_SORT,
  type ModelTableRow,
  type ModelTableSort,
} from '../lib/rows'
import { isSetExpanded, toggleSetExpanded, expandedSetSnapshot } from '../lib/setExpansion'
import { TxrDeleteModelDialog } from '../components/TxrDeleteModelDialog'
import { TxrDeleteSetDialog } from '../components/TxrDeleteSetDialog'
import { TxrRenameModelDialog } from '../components/TxrRenameModelDialog'
import { TxrRenameSetDialog } from '../components/TxrRenameSetDialog'

/**
 * The box's minimum height: about FIVE rows (~5 × 45 px rows ≈ 225 px +
 * the ~40 px sticky header ≈ 265 px → 260). The minimum lives on the
 * PAGE's spine (the main), NOT on the box's scrollport: mounted on the
 * inner scroll div it forces the box past its frame at a short window,
 * painting over the footer. Here the whole page honours it and, below it,
 * the routed area (the shell body) scrolls instead. No fixed pixel
 * HEIGHT, no JS resize listener — the flex spine with `min-height: 0`
 * gives the box the space left below the header + search row and above
 * the footnotes.
 */
const TABLE_BOX_MIN_HEIGHT = 260

/** The page's flex spine (the frame fills the routed area); the spine's
 *  own FIVE-row minimum is `TABLE_BOX_MIN_HEIGHT` above. */
const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: TABLE_BOX_MIN_HEIGHT,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (title + toolbar — the audit row). */
const PAGE_TOP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 24px 12px',
  minWidth: 0,
}

/** The box's content padding (the box's rows scroll, the padding rides
 *  inside the scrollport — the sticky header sticks to the box top). */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 24px 20px',
  minWidth: 0,
}

const HEADER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 16,
}

const TITLE: CSSProperties = {
  margin: '0 0 2px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

const SUBTITLE: CSSProperties = {
  color: 'var(--txr-text-2)',
  fontSize: 14,
}

const HEADER_CONTROLS: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  flexWrap: 'wrap',
}

/** The ONE window-filling box (the box IS the page's ScrollRegion — the
 *  shell's one-region byte). The region's own `overflow: auto` (both axes)
 *  makes it the scrollport: rows scroll inside it, wide content scrolls
 *  horizontally inside the same box, and the sticky header row pins to its
 *  top with the opaque surface token (HEAD_LOOK). The FIVE-row minimum is
 *  NOT here — it sits on the page's spine (`PAGE_OUTER`) so a short window
 *  scrolls the routed area instead of the box painting over the footer. */
const TABLE_BOX: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
  minWidth: 0,
}

const TABLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: 14,
  minWidth: 1080,
}

const HEAD_LOOK: CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontWeight: 600,
  borderBottom: '1px solid var(--txr-border)',
  background: 'var(--txr-surface-dim)',
  whiteSpace: 'nowrap',
  // ONE-TABLE: the header row is sticky against the BOX (the page's own
  // scrollport); the opaque surface is the header token, z-index above the
  // rows.
  position: 'sticky',
  top: 0,
  zIndex: 2,
}

const HEAD_RIGHT: CSSProperties = { ...HEAD_LOOK, textAlign: 'right' }

/** A sortable header's trigger: the header label IS the button (the
 *  sortable look must not change the column's words — the active column's
 *  th carries `aria-sort`, the button carries an arrow glyph). */
const SORT_BUTTON: CSSProperties = {
  padding: 0,
  margin: -2,
  fontSize: 'inherit',
  fontWeight: 600,
  color: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
}

/** The active sort column's direction arrow (brand — the one hint the
 *  sighted user has; `aria-sort` is the assistive truth). */
const SORT_ARROW: CSSProperties = { color: 'var(--txr-brand)' }

/** The board's screen-reader-only "Actions" header (a real column, a hidden label). */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
}

const TD_LOOK: CSSProperties = {
  padding: '12px 14px',
  borderBottom: '1px solid var(--txr-border-subtle)',
  verticalAlign: 'top',
}

const ROW_HEADER: CSSProperties = {
  ...TD_LOOK,
  textAlign: 'left',
  fontWeight: 700,
  color: 'var(--txr-text)',
}

/** The one-table model-row indent: a set's models sit under the set row. */
const MODEL_INDENT = 42

/**
 * The rows' scroll-margin-top (a bit more than the ~40 px sticky thead, so
 * 44): `scrollIntoView({ block: 'nearest' })` must never leave a row
 * hidden under the sticky header — the margin is what the browser keeps
 * clear of the scrollport's top when it aligns the row.
 */
const ROW_SCROLL_MARGIN = 44

/** The model subline (12.5 px muted — the board's `div` under the name). */
const SUBLINE: CSSProperties = { fontWeight: 400, fontSize: 12.5, color: 'var(--txr-muted)' }

/** The mono method entry (the board's 'Source Code Pro' column). */
const MONO: CSSProperties = {
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 12.5,
}

/** The muted fallback word ("not recorded" — the board's grey span). */
const MUTED: CSSProperties = { color: 'var(--txr-muted)' }

/** The footnotes row (the board's muted two spans). */
const FOOTNOTES: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 28,
  alignItems: 'flex-start',
  fontSize: 13.5,
  color: 'var(--txr-muted)',
}

/** The kept-models footnote (one flowing line). */
const STORED_LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
}

/** The set-focus banner (DEC-19 — the URL is the view; the clear is the inverse). */
const SET_FOCUS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
  fontSize: 13.5,
  color: 'var(--txr-text-2)',
}

/** The empty/loading/muted line inside the table box. */
const BOX_LINE: CSSProperties = { padding: '14px', fontSize: 13.5, color: 'var(--txr-muted)' }

/** The sets-read failure line (muted — the rows stay grouped, the facts
 *  fall back to the rows' own; only the failure is announced). */
const SETS_ERROR_LINE: CSSProperties = { fontSize: 13.5, color: 'var(--txr-muted)' }

/** The set row's first entry: the chevron disclosure + the name block. */
const SET_LEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  minWidth: 0,
}

/** The chevron trigger (flush, no chrome — the row's own pixels). */
const SET_TOGGLE: CSSProperties = {
  padding: 0,
  alignSelf: 'center',
  flexShrink: 0,
  color: 'var(--txr-brand)',
}

/** The chevron's turn (data-driven: aria-expanded is the source of truth;
 *  the rotation is presentation only). */
const CHEVRON: CSSProperties = { transition: 'transform 150ms', flexShrink: 0 }

/** The set name block: the name line + the facts line UNDER it (one
 *  wrapping line — phone width). */
const SET_NAMES: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The set name line: the name + the "(N)" count beside it (the facts
 *  line under it is the block's second row). */
const SET_NAME_LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 6,
  minWidth: 0,
}

/** The set name (the row's header word). */
const SET_NAME: CSSProperties = {
  fontWeight: 700,
  color: 'var(--txr-text)',
}

/** The folder row's count "(N)" (muted — the sr-only "N models" text is
 *  the assistive read; the visible "(N)" is aria-hidden). */
const SET_COUNT: CSSProperties = {
  fontWeight: 400,
  fontSize: 12.5,
  color: 'var(--txr-muted)',
  whiteSpace: 'nowrap',
}

/** The folder glyph (the project's icon set — lucide's Folder; muted,
 *  aria-hidden — the set name/actions speak for the row). */
const FOLDER_ICON: CSSProperties = {
  flexShrink: 0,
  alignSelf: 'center',
  color: 'var(--txr-muted)',
}

/** The set facts line (muted — the run/file source + training files kept). */
const SET_FACTS: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 400,
  color: 'var(--txr-muted)',
}

/** The set row's action button group (wraps — phone width). */
const SET_ACTIONS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px 12px',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minWidth: 0,
}

/** The empty state's lead sentence. */
const EMPTY_LINE = 'No models yet.'

/** The empty state's explanation (next to the CTA; honest, no board copy). */
const EMPTY_NOTE = 'Run an analysis and save its models, or open a model file.'

/** The no-match line for a search/set view with no rows. */
const NO_MATCH_LINE = 'Nothing matches here.'

/** The empty/CTA button (the board's header verb). */
const IMPORT_LABEL = 'Open a model file'

/** The page's row-action failure fallback (never blank). */
const ACTION_FAILED_LINE = 'The model could not be updated.'

/** The response-null fallback's models: ONE frozen shared empty list. The
 *  `?? []` fallback allocates a fresh array on every render while the
 *  first read is still in flight (a new `models` identity also re-runs the
 *  rows memo); the frozen module-level constant never changes. */
const EMPTY_MODELS = Object.freeze([] as ModelSummary[]) as ModelSummary[]

const ROW_ACTION_LINK: CSSProperties = { fontSize: 13.5, color: 'var(--txr-brand)' }
const ROW_ACTION_DANGER: CSSProperties = { fontSize: 13.5, color: 'var(--txr-danger)' }

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return ACTION_FAILED_LINE
}

/** One set row's facts line from the row's facts (the pure `formatSetFacts`
 *  — the set row reads ONLY engine facts, never a constant):
 *
 * - a real set: the set's run/file/source fact + `keep_training_files`
 *   (the count is the Name cell's "(N)" beside the name, the made date
 *   is the Made column's entry now);
 * - a fallback group (the sets read not answered / failed): no set facts
 *   exist — `""` (the page renders no facts line; the rows present the
 *   facts individually).
 */
function setFactsLine(row: Extract<ModelTableRow, { kind: 'set' }>): string {
  const importedFrom =
    row.models
      .map(model => model.imported_from?.trim() ?? '')
      .find(value => value.length > 0) ?? null
  if (row.set === null) {
    return formatSetFacts({
      keepTrainingFiles: false,
      sourceLabel: null,
      fromRun: false,
      importedFrom,
    })
  }
  return formatSetFacts({
    keepTrainingFiles: row.set.keep_training_files,
    sourceLabel: row.set.source_label ?? null,
    fromRun: row.set.source_run_id !== undefined && row.set.source_run_id !== null,
    importedFrom,
  })
}

/** The one row dialog at a time (rename or delete; the plan's per-action confirmations). */
type RowDialog = { kind: 'rename' | 'delete'; model: ModelSummary } | null

/** The one SET dialog at a time (the set row's Rename set /
 *  Delete set — the row dialogs' set-level twins). */
type SetDialog = { kind: 'rename' | 'delete'; set: { id: string; name: string } } | null

const NO_SET_DIALOG: SetDialog = null

/** One `<tbody>` of the one table: a set's rows (the set row + its
 *  expanded models) or one no-set model row. */
interface TableBody {
  key: string
  rows: ModelTableRow[]
}

/** The flat `rows` list → the table's tbodies (the builder's order is
 *  guaranteed: a set row's expanded models follow it; the no-set rows come
 *  last — the renderer only needs to split at the set boundaries). */
function toTableBodies(rows: ModelTableRow[]): TableBody[] {
  const bodies: TableBody[] = []
  let open = -1
  for (const row of rows) {
    if (row.kind === 'set') {
      bodies.push({
        key: row.key,
        rows: [row],
      })
      open = bodies.length - 1
    } else if (row.inSet) {
      bodies[open]?.rows.push(row)
    } else {
      bodies.push({ key: row.model.id, rows: [row] })
      open = -1
    }
  }
  return bodies
}

/** True for the table's VERY LAST row: the ONE row whose bottom border is
 *  omitted. The whole-table truth, never a per-tbody one — a collapsed set
 *  is its own tbody with a single row, and a per-tbody "last" would remove
 *  the separator under every collapsed set (F1). */
function isLastTableRow(row: ModelTableRow, tableRows: ModelTableRow[]): boolean {
  const last = tableRows[tableRows.length - 1]
  if (last === undefined) return false
  if (last.kind === 'set') return row.kind === 'set' && row.key === last.key
  return row.kind === 'model' && row.model.id === last.model.id
}

export function ModelsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const setId = searchParams.get('set')
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('Your models')
  // ITEM-7: the demo's inventory is the shared pool's — the visible
  // statement + the "n of 50 models" counter, and the import/export/rename/
  // delete row actions are absent (the server blocks them; DEC-3).
  const { isDemo } = useAppMode()
  const demoUsage = useDemoUsage(isDemo)

  const [search, setSearch] = useState('')
  // Part 2: the search is CLIENT-side — this page reads the FULL model
  // list (never a `q` on the wire; the generated endpoint has no
  // pagination, DEC-19) and filters in the page over the sets read, so the
  // input is responsive with no debounce. `useModelInventory`'s `q` arm
  // stays for its other callers; here the query is omitted (the hook
  // defaults it to the empty string — the same read).
  const inventory = useModelInventory({ setId })
  // The sort state (the page owns it; the pure row builder turns it into
  // the row order — never the component).
  const [sort, setSort] = useState<ModelTableSort>(MODEL_TABLE_DEFAULT_SORT)
  // The sets read is the set rows' facts source (model_count, source_label,
  // created_at, keep_training_files) — loaded and refreshed with the model
  // list (a mutation can change a set's rows/count).
  const sets = useModelSets()
  const [rowDialog, setRowDialog] = useState<RowDialog>(null)
  const [setDialog, setSetDialog] = useState<SetDialog>(NO_SET_DIALOG)
  const [actionError, setActionError] = useState<string | null>(null)
  // Where the desktop app's Save dialog put an exported model file.
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportingSet, setExportingSet] = useState(false)
  // The module-level expansion store is not reactive: the tick is the
  // component's re-render lever (the store itself survives unmount).
  const [expansionTick, setExpansionTick] = useState(0)
  const setRowRefs = useRef(new Map<string, HTMLTableRowElement | null>())
  // The ONE table element itself (the search-reveal effect's first-match
  // target — the table's own ref, never a global document query).
  const tableRef = useRef<HTMLTableElement>(null)

  const models = inventory.response?.models ?? EMPTY_MODELS

  /** The set-focus name (the rows' own `set_name`; the URL id is the honest
   *  fallback for a set with no rows — a deleted set must not fabricate a
   *  name). */
  const focusedSetName = setId === null ? null : (models[0]?.set_name ?? setId)

  /** The one-table rows: the flat, ordered set/model row list. The sets
   *  read is the set rows' FACTS source; during a re-read (rename/import
   *  refresh) the LAST response is kept and served — the builder gets
   *  `null` (its own-facts fallback grouping) only while the FIRST read
   *  has not answered, so a known set row never flashes "not recorded"
   *  and loses its facts over a refresh. A model of a brand-new set (an
   *  import just created it) is a plain top-level row until the sets
   *  re-read answers — the last response is the store's truth. The
   *  `?set=` focus shows ONLY that set's rows, always expanded. */
  const rows = useMemo(
    () =>
      buildModelTableRows(sets.response?.sets ?? null, models, {
        expanded: expandedSetSnapshot(),
        focusSetId: setId,
        search,
        sort,
      }),
    // expansionTick: the store is module-level; the tick makes the memo
    // re-read it (a toggle expands/collapses the rows).
    [expansionTick, sets.response, models, setId, search, sort],
  )

  /** The tbodies of the one table (each set row's models follow it in the
   *  same tbody; a collapsed set's tbody holds its one set row). */
  const tableBodies = useMemo(() => toTableBodies(rows), [rows])

  /** The post-mutation refresh: the model list AND the sets (the set rows'
   *  facts are the sets read's — a rename/import/delete can change both). */
  const { refresh: refreshInventory } = inventory
  const { refresh: refreshSets } = sets
  const refresh = useCallback((): void => {
    refreshInventory()
    refreshSets()
  }, [refreshInventory, refreshSets])

  // The shared `.txr` import (predict-card merge round 1): the hook owns
  // the picker, the POST and the two error lines; the success side is this
  // page's refresh (the imported row appears, exactly as before). The
  // import affordance is the registered `models.openModelFile` action — a
  // human click opens the picker through the hook's host channel in place
  // (round-1 audit item 5: no `navigator.userActivation` dependency — the
  // action decides the demo refusal, the click opens the input) and clears
  // a previous error (item 9's sibling rule).
  const { error: importError, inputProps: importInputProps, clearError: clearImportError } =
    useModelFileImport({
      setId,
      onImported: refresh,
    })

  // The registered `models.renameSet` action's refresh: the AI/command path
  // has no dialog `onSaved`, so the action publishes the refresh bus and
  // EVERY mounted host that shows the sets data re-reads (this page's hooks
  // here — the merged list shows saved rows but no set actions, so it does
  // not subscribe). The human path refreshes through the dialogs' own
  // callbacks — never a double refresh.
  useEffect(() => subscribeModelSetsChanged(refresh), [refresh])

  /** The set record for a set id: the SetSummary (name + the keep flag) from
   *  the sets read, else the set row's own name (a sets-read-failed
   *  fallback group still has a real set id and its rows' set name). */
  const rowsByKey = useMemo(
    () => new Map(rows.filter((row): row is Extract<ModelTableRow, { kind: 'set' }> => row.kind === 'set').map(row => [row.key, row])),
    [rows],
  )
  const resolveSet = useCallback(
    (setId: string): { id: string; name: string } | null => {
      const known = sets.response?.sets.find(set => set.id === setId)
      if (known !== undefined) return { id: known.id, name: known.name }
      const row = rowsByKey.get(setId)
      return row === undefined ? null : { id: row.key, name: row.name }
    },
    [sets.response, rowsByKey],
  )

  // The registered `models.deleteSet` action only OPENS the confirm dialog
  // (it never deletes): the pending-request channel is the seam, and this
  // page is the ONE host that listens (the old saved-models page is gone
  // with round 3 — the merged list has no set actions).
  // The listener reports back whether IT opened the dialog (true only when
  // the set resolved to a real set row and the dialog was shown; false when
  // the set is unknown or the reads are still empty) — the action rejects
  // when no host handled the request.
  useEffect(
    () =>
      subscribeDeleteSetRequest(setId => {
        const set = resolveSet(setId)
        if (set === null) return false
        setActionError(null)
        setSetDialog({ kind: 'delete', set })
        return true
      }),
    [resolveSet],
  )

  /** The pending reveal after a chevron toggle: the expanded model rows
   *  exist only AFTER the tick's re-render, so the reveal runs in an
   *  effect, never inline at the click. */
  const pendingRevealRef = useRef<string | null>(null)

  /** The chevron toggle: flip the module store (the expanded ids survive
   *  unmount), re-render through the tick, and reveal the toggled set's
   *  rows inside the box — `block: 'nearest'` only, never unneeded motion. */
  const toggleSet = useCallback((key: string): void => {
    toggleSetExpanded(key)
    setExpansionTick(tick => tick + 1)
    pendingRevealRef.current = key
  }, [])

  /** The post-render reveal (F8): an EXPANDED set shows as much of its
   *  models as fit — the LAST model row is scrolled into view first
   *  (`nearest`), then the set row too only if it left the view above (its
   *  header is worth keeping at the top edge); a COLLAPSED set (or one with
   *  no model rows) just keeps its set row in view. Every row carries
   *  `scroll-margin-top` so neither ever hides under the sticky thead. */
  useEffect(() => {
    const key = pendingRevealRef.current
    if (key === null) return
    pendingRevealRef.current = null
    const setRow = setRowRefs.current.get(key)
    if (setRow == null) return
    const last = setRow.closest('tbody')?.lastElementChild
    if (last instanceof HTMLElement && last !== setRow) {
      last.scrollIntoView({ block: 'nearest' })
      const regionTop = setRow.closest('[role="region"]')?.getBoundingClientRect().top ?? 0
      if (setRow.getBoundingClientRect().top < regionTop) {
        setRow.scrollIntoView({ block: 'nearest' })
      }
    } else {
      setRow.scrollIntoView({ block: 'nearest' })
    }
  }, [expansionTick, rows])

  /** One sortable header's click (part 2): the SAME column toggles Made
   *  (newest ↔ oldest) or Name (A→Z ↔ Z→A); the OTHER column switches to
   *  it with the brief's birth direction (Name starts A→Z, Made newest
   *  first). The state is the page's; the ordering is the builder's. */
  const setSortColumn = useCallback((by: ModelTableSort['by']): void => {
    setSort(prev =>
      prev.by === by
        ? { by, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { by, direction: by === 'name' ? 'asc' : 'desc' },
    )
  }, [])

  /** A typed search reveals its FIRST match inside the window-filling box:
   *  the effect runs after the commit (the filtered rows already exist), so
   *  `block: 'nearest'` plus the rows' 44 px `scroll-margin-top` brings the
   *  match out from under the sticky thead. Clearing the search never
   *  scrolls — the restore is the set's own state. */
  useEffect(() => {
    if (search.trim().length === 0) return
    const first = tableRef.current?.querySelector<HTMLElement>('tbody tr')
    first?.scrollIntoView({ block: 'nearest' })
  }, [search, tableRef])

  /** Use — the DEC-10 handoff: intent reuse + the pending model id, then
   *  the N screen (the user adds the predict file; the I screen preselects
   *  this row on mount — the board's path 3 flow, never a direct run). */
  //  The registered `models.useModel` does it (the palette and the AI start
  //  the same path): the path's first step goes back here (the step trail),
  //  and the URL announces the choice (the J "?set=" view precedent, DEC-19:
  //  the N screen names the chosen model while the handoff is live — RES-21).
  const useModel = useCallback((model: ModelSummary): void => {
    runAction('models.useModel', { modelId: model.id, name: model.name }).catch(
      (error: unknown) => {
        setActionError(error instanceof Error ? error.message : 'The model could not be used.')
      },
    )
  }, [])

  /** Export — the provider's attachment, byte passthrough; the picked
   *  bytes land in the user's downloads via `lib/export.ts`. A failure
   *  surfaces inline (never a silent no-op). */
  const exportModel = useCallback(
    async (model: ModelSummary): Promise<void> => {
      setExporting(true)
      setActionError(null)
      setSavedPath(null)
      try {
        const result = await downloadModelExport(model)
        if (result.status === 'saved') setSavedPath(result.path)
      } catch (error) {
        setActionError(errorText(error))
      } finally {
        setExporting(false)
      }
    },
    [],
  )

  /** Rename/Delete — the dialogs own the wire; `refresh()` re-reads (the
   *  engine is the truth). */
  const openRename = useCallback((model: ModelSummary): void => {
    setActionError(null)
    setRowDialog({ kind: 'rename', model })
  }, [])

  const openDelete = useCallback((model: ModelSummary): void => {
    setActionError(null)
    setRowDialog({ kind: 'delete', model })
  }, [])

  /** Set Rename — the dialog collects the new name; its confirm goes
   *  through the ONE `renameSetById` call the registered
   *  `models.renameSet` action uses (the AI path renames by id + name). */
  const openSetRename = useCallback((setId: string, name: string): void => {
    setActionError(null)
    setSetDialog({ kind: 'rename', set: { id: setId, name } })
  }, [])

  /** Set Export — the registered `models.exportSet` action owns the
   *  download (the button and the AI agent take the same path); the
   *  desktop Save dialog's chosen path is announced like the model export's. */
  const exportSet = useCallback(
    async (setId: string): Promise<void> => {
      setExportingSet(true)
      setActionError(null)
      setSavedPath(null)
      try {
        const result = (await runAction('models.exportSet', { setId })) as {
          status: 'saved' | 'downloaded' | 'cancelled'
          path?: string
        }
        if (result.status === 'saved' && result.path !== undefined) setSavedPath(result.path)
      } catch {
        // The one failure line (never the transport's own words).
        setActionError(SET_EXPORT_FAILED_LINE)
      } finally {
        setExportingSet(false)
      }
    },
    [],
  )

  /** Set Delete — the registered `models.deleteSet` action OPENS the
   *  confirm dialog through the pending-request channel (it never deletes;
   *  the dialog's confirm is the one delete). A refusal to open it is the
   *  page's FIXED line — never the transport's/action's own words. */
  const openSetDelete = useCallback((setId: string): void => {
    setActionError(null)
    void runAction('models.deleteSet', { setId }).catch(() => {
      setActionError(SET_DELETE_FAILED_LINE)
    })
  }, [])

  /** The set delete succeeded: re-read both reads, and clear a `?set=`
   *  focus that names the deleted set (a dead-view URL is a stale view —
   *  the honest page is the unfiltered inventory). ONLY the `set` param is
   *  cleared: the other params (a search, another screen's query) survive
   *  the deletion — the URL is not a scratchpad to wipe. */
  const onSetDeleted = useCallback((): void => {
    refresh()
    const deletedId = setDialog?.kind === 'delete' ? setDialog.set.id : null
    if (setId !== null && deletedId !== null && deletedId === setId) {
      const next = new URLSearchParams(searchParams)
      next.delete('set')
      setSearchParams(next)
    }
  }, [refresh, setDialog, setId, searchParams, setSearchParams])

  // The pending first read is the only in-flight state the page shows as a
  // line; later re-reads keep the table (the hook keeps the last response).
  // The sets read rides the same gate: the set rows need it, so the first
  // paint waits for BOTH first responses (they fire in parallel).
  const firstLoading =
    (inventory.loading && inventory.response === null) ||
    (sets.loading && sets.response === null)

  // The part-2 view-empty truth: the BUILDER's rows are the filter's
  // answer — a client-side search (or `?set=` focus) with zero rows is the
  // honest no-match line; an inventory with no models at all (and no
  // search/focus) is the empty state.
  const searching = search.trim().length > 0
  const viewEmpty = rows.length === 0
  const noMatch = viewEmpty && (searching || setId !== null)

  return (
    <main
      data-testid="txr-models-j"
      className="txr-models-j-main"
      style={PAGE_OUTER}
    >
      <PageFrame
        testId="txr-models-j-frame"
        top={
          <div className="txr-models-j-top" style={PAGE_TOP}>
            <div className="txr-models-j-header" style={HEADER}>
              <div>
                <h1 style={TITLE}>Your models</h1>
                <div style={SUBTITLE}>
                  Every model you train is kept here, so you can predict new patients later without
                  training again.
                </div>
              </div>
              <div style={HEADER_CONTROLS}>
                <Input
                  data-testid="txr-models-j-search"
                  className="txr-models-j-search"
                  type="search"
                  placeholder="Search sets and models"
                  aria-label="Search sets and models"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  style={{ width: 220 }}
                  allowStyle
                />
                {/* ITEM-7: the import affordance is ABSENT in demo (the
                    server blocks `models/import`; a visitor's file would
                    land in the shared pool). */}
                {!isDemo ? (
                  <>
                    <Button
                      data-testid="txr-models-import"
                      onClick={() => {
                        clearImportError()
                        void runAction('models.openModelFile', {})
                      }}
                    >
                      {IMPORT_LABEL}
                    </Button>
                    {/* native-control-ok: the file input is invisible; the visible affordance is <Button> */}
                    <input
                      {...importInputProps}
                      style={{ display: 'none' }}
                      aria-hidden="true"
                      tabIndex={-1}
                      data-testid="txr-models-import-file"
                    />
                  </>
                ) : null}
              </div>
            </div>

            {isDemo ? (
              <DemoRetentionBlock
                kind="models"
                count={demoUsage.usage?.models ?? null}
                limit={demoUsage.usage?.model_limit ?? 50}
              />
            ) : null}

            {setId !== null ? (
              <div data-testid="txr-models-j-set-focus" style={SET_FOCUS}>
                <span>
                  Showing the set &ldquo;{focusedSetName}&rdquo;
                </span>
                <Button
                  data-testid="txr-models-j-set-clear"
                  variant="outline"
                  onClick={() => setSearchParams({})}
                >
                  Show all
                </Button>
              </div>
            ) : null}

            {inventory.error !== null ? (
              <Alert tone="error" data-testid="txr-models-j-error" title={inventory.error} />
            ) : null}
            {inventory.error !== null ? (
              <div>
                <Button variant="outline" data-testid="txr-models-j-retry" onClick={refresh}>
                  Retry
                </Button>
              </div>
            ) : null}
            {inventory.error === null && sets.error !== null ? (
              <div data-testid="txr-models-j-sets-error" style={SETS_ERROR_LINE}>
                The set details could not be loaded.
              </div>
            ) : null}
            {importError !== null ? (
              <Alert tone="error" data-testid="txr-models-j-import-error" title={importError} />
            ) : null}
            {actionError !== null ? (
              <Alert tone="error" data-testid="txr-models-j-action-error" title={actionError} />
            ) : null}
            {savedPath !== null ? (
              <SavedFileNotice path={savedPath} testId="txr-models-j-export-saved" />
            ) : null}
          </div>
        }
        body={
          // ONE-TABLE: the page's ScrollRegion IS the window-filling box —
          // the shell's one-scroll-region byte keeps its restore/keyboard/
          // shadow behaviour, and the box's own `overflow: auto` (both axes)
          // makes it the scrollport: rows scroll inside it, the sticky
          // header pins to its top, and the page itself does not scroll.
          <ScrollRegion
            label="Your models"
            className="txr-models-j-region"
            testId="txr-models-j-table-box"
            style={TABLE_BOX}
          >
            <div style={REGION_CONTENT}>
        {firstLoading ? (
          <div data-testid="txr-models-j-loading" style={BOX_LINE}>
            Loading models…
          </div>
        ) : noMatch ? (
          <div
            data-testid="txr-models-j-no-match"
            style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20, alignItems: 'flex-start' }}
          >
            <p style={{ margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }}>
              {NO_MATCH_LINE}
            </p>
          </div>
        ) : models.length === 0 ? (
          <div
            data-testid="txr-models-j-empty"
            style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20, alignItems: 'flex-start' }}
          >
            <p style={{ margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }}>
              {EMPTY_LINE}
            </p>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-muted)' }}>{EMPTY_NOTE}</p>
            {!isDemo ? (
              <Button
                data-testid="txr-models-empty-import"
                onClick={() => {
                  clearImportError()
                  void runAction('models.openModelFile', {})
                }}
              >
                {IMPORT_LABEL}
              </Button>
            ) : null}
          </div>
        ) : (
          <table
            data-testid="txr-models-j-table"
            className="txr-models-j-table"
            style={TABLE}
            ref={tableRef}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  style={HEAD_LOOK}
                  aria-sort={sort.by === 'name' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <Button
                    variant="ghost"
                    data-testid="txr-models-sort-name"
                    style={SORT_BUTTON}
                    onClick={() => setSortColumn('name')}
                  >
                    Name
                    {sort.by === 'name' ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp aria-hidden size={12} style={SORT_ARROW} />
                      ) : (
                        <ArrowDown aria-hidden size={12} style={SORT_ARROW} />
                      )
                    ) : null}
                  </Button>
                </th>
                <th scope="col" style={HEAD_LOOK}>Method</th>
                <th scope="col" style={HEAD_LOOK}>Predicts</th>
                <th scope="col" style={HEAD_RIGHT}>Decision day</th>
                <th scope="col" style={HEAD_RIGHT}>Trained on</th>
                <th
                  scope="col"
                  style={HEAD_LOOK}
                  aria-sort={sort.by === 'made' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <Button
                    variant="ghost"
                    data-testid="txr-models-sort-made"
                    style={SORT_BUTTON}
                    onClick={() => setSortColumn('made')}
                  >
                    Made
                    {sort.by === 'made' ? (
                      sort.direction === 'asc' ? (
                        <ArrowUp aria-hidden size={12} style={SORT_ARROW} />
                      ) : (
                        <ArrowDown aria-hidden size={12} style={SORT_ARROW} />
                      )
                    ) : null}
                  </Button>
                </th>
                <th scope="col" style={{ ...HEAD_LOOK, textAlign: 'right' }}>
                  <span style={VISUALLY_HIDDEN}>Actions</span>
                </th>
              </tr>
            </thead>
            {tableBodies.map(body => (
              <tbody key={body.key}>
                {body.rows.map(row => {
                  if (row.kind === 'set') {
                    // A PARTIAL search match is a FORCED-expanded view arm
                    // (the chevron must tell the truth — the models ARE
                    // shown) but the store is untouched, so clearing the
                    // search restores the set's own state.
                    const expanded =
                      setId === row.key || row.match === 'partial' || isSetExpanded(row.key)
                    const factsLine = setFactsLine(row)
                    const isLast = isLastTableRow(row, rows)
                    const tdStyle = isLast ? { ...TD_LOOK, borderBottom: 'none' } : TD_LOOK
                    const toggleLabel = expanded
                      ? `Hide the models of \u201c${row.name}\u201d`
                      : `Show the models of \u201c${row.name}\u201d`
                    return (
                      <tr
                        key={row.key}
                        data-testid={`txr-models-set-row-${row.key}`}
                        className="txr-models-j-set-row"
                        style={{ scrollMarginTop: ROW_SCROLL_MARGIN }}
                        ref={el => {
                          if (el === null) setRowRefs.current.delete(row.key)
                          else setRowRefs.current.set(row.key, el)
                        }}
                      >
                        <th scope="row" style={{ ...ROW_HEADER, ...tdStyle }}>
                          <span style={SET_LEAD}>
                            {/* ONE-TABLE: the disclosure trigger — the
                                module-level store keeps the open sets while
                                the app is open. No `aria-controls`: the
                                tbody it would name CONTAINS the chevron's
                                own row (the disclosure's models are its
                                siblings, not a separate region it owns), so
                                the reference was neither truthful nor
                                useful; the `title` carries the same text as
                                the aria-label. In the ?set= focus view the
                                trigger is inert (`disabled`, still
                                aria-expanded=true): the focus is the URL's,
                                not a togglable view-state — the same inert
                                truth under a PARTIAL search, where the
                                match FORCES the set open (the chevron must
                                not fight the search's view). */}
                            <Button
                              variant="link"
                              data-testid={`txr-models-set-toggle-${row.key}`}
                              style={SET_TOGGLE}
                              aria-expanded={expanded}
                              disabled={setId === row.key || row.match === 'partial'}
                              aria-label={toggleLabel}
                              title={toggleLabel}
                              onClick={
                                setId === row.key || row.match === 'partial'
                                  ? undefined
                                  : () => toggleSet(row.key)
                              }
                            >
                              <ChevronRight
                                aria-hidden
                                size={16}
                                style={{
                                  ...CHEVRON,
                                  transform: expanded ? 'rotate(90deg)' : undefined,
                                }}
                              />
                            </Button>
                            <Folder
                              aria-hidden
                              size={16}
                              style={FOLDER_ICON}
                              data-testid={`txr-models-set-folder-${row.key}`}
                            />
                            <span style={SET_NAMES}>
                              <span style={SET_NAME_LINE}>
                                <span style={SET_NAME}>{row.name}</span>
                                {/* brief 7 — the folder's count is "(N)" on
                                    the row (aria-hidden: the "(N)" is a
                                    rendering of the count, not the words the
                                    reader should hear) with ONE
                                    screen-reader-only "N models" text — the
                                    one read, never both. A PARTIAL search
                                    count reads the plan's "2 of 3 models
                                    match" instead. */}
                                {row.match === 'partial' ? (
                                  <span style={SET_COUNT}>
                                    <span aria-hidden="true">
                                      ({formatSetModelMatchText(row.matchCount, row.modelCount)})
                                    </span>
                                    <span style={VISUALLY_HIDDEN}>
                                      {formatSetModelMatchText(row.matchCount, row.modelCount)}
                                    </span>
                                  </span>
                                ) : (
                                  <span style={SET_COUNT}>
                                    <span aria-hidden="true">({row.modelCount})</span>
                                    <span style={VISUALLY_HIDDEN}>
                                      {formatSetModelCount(row.modelCount)}
                                    </span>
                                  </span>
                                )}
                              </span>
                              {factsLine.length > 0 ? (
                                <span style={SET_FACTS}>{factsLine}</span>
                              ) : null}
                            </span>
                          </span>
                        </th>
                        <td style={tdStyle} />
                        <td style={tdStyle} />
                        <td style={{ ...tdStyle, textAlign: 'right' }} />
                        <td style={{ ...tdStyle, textAlign: 'right' }} />
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          {formatSetMade(row.set?.created_at ?? null)}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {/* The three set actions: every real set row gets
                              them (a sets-read-failed fallback group keeps
                              its buttons — they act by the real set id; the
                              demo's pools are the shared one and the server
                              blocks both, ITEM-7). */}
                          {!isDemo ? (
                            <div
                              role="group"
                              aria-label={`Actions for ${row.name}`}
                              data-testid={`txr-models-set-actions-${row.key}`}
                              style={SET_ACTIONS}
                            >
                              <Button
                                data-testid={`txr-models-set-rename-btn-${row.key}`}
                                variant="link"
                                style={ROW_ACTION_LINK}
                                onClick={() => openSetRename(row.key, row.name)}
                              >
                                Rename set
                              </Button>
                              <Button
                                data-testid={`txr-models-set-export-btn-${row.key}`}
                                variant="link"
                                style={ROW_ACTION_LINK}
                                disabled={exportingSet}
                                onClick={() => void exportSet(row.key)}
                              >
                                {setExportLabel()}
                              </Button>
                              <Button
                                data-testid={`txr-models-set-delete-btn-${row.key}`}
                                variant="link"
                                style={ROW_ACTION_DANGER}
                                onClick={() => openSetDelete(row.key)}
                              >
                                Delete set
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    )
                  }
                  const model = row.model
                  const setName =
                    model.set_name !== null &&
                    model.set_name !== undefined &&
                    model.set_name.trim().length > 0 &&
                    model.set_name !== model.name
                      ? model.set_name
                      : null
                  const subline = formatModelSublines(
                    model.marker_count ?? null,
                    model.uses_covariates,
                    model.imported_from,
                    setName,
                    model.marker_kind ?? null,
                  )
                  const trainedOn = formatTrainedOn(model.trained_on_patients ?? null)
                  const isLast = isLastTableRow(row, rows)
                  const tdStyle = isLast ? { ...TD_LOOK, borderBottom: 'none' } : TD_LOOK
                  return (
                    <tr
                      key={model.id}
                      data-testid={`txr-models-row-${model.id}`}
                      style={{ scrollMarginTop: ROW_SCROLL_MARGIN }}
                    >
                      {/* brief 7 — the Set column is gone: the merged Name
                          column holds the model's label + subline, indented
                          when the row sits under a set (a no-set model is a
                          top-level row, never indented — nothing is ever
                          empty in Name). */}
                      <th
                        scope="row"
                        data-label="Name"
                        style={{
                          ...ROW_HEADER,
                          ...tdStyle,
                          paddingLeft: row.inSet ? MODEL_INDENT : undefined,
                        }}
                      >
                        {model.name}
                        {subline.length > 0 ? (
                          <div className="txr-models-j-subline" style={SUBLINE}>
                            {subline}
                          </div>
                        ) : null}
                      </th>
                      <td data-label="Method" style={tdStyle}>
                        <span style={MONO}>{model.method_id}</span>
                      </td>
                      <td data-label="Predicts" style={tdStyle}>
                        {formatPredicts(model.task ?? null, model.endpoint, model.horizon)}
                      </td>
                      <td data-label="Decision day" style={{ ...tdStyle, textAlign: 'right' }}>
                        {model.decision_day}
                      </td>
                      <td data-label="Trained on" style={{ ...tdStyle, textAlign: 'right' }}>
                        <span style={model.trained_on_patients == null ? MUTED : undefined}>
                          {trainedOn}
                        </span>
                      </td>
                      <td data-label="Made" style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatMade(model.created_at, model.provenance)}</td>
                      <td
                        data-label="Actions"
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Button data-testid={`txr-models-use-${model.id}`} onClick={() => useModel(model)}>
                          Use
                        </Button>
                        {/* ITEM-7: Export / Rename / Delete are ABSENT in demo
                            (the server blocks them; DEC-3 — no free text,
                            no export of the recorded stubs). */}
                        {!isDemo ? (
                          <>
                            {' '}
                            <Button
                              data-testid={`txr-models-export-${model.id}`}
                              variant="link"
                              style={ROW_ACTION_LINK}
                              disabled={exporting}
                              onClick={() => void exportModel(model)}
                            >
                              {modelExportLabel()}
                            </Button>{' '}
                            <Button
                              data-testid={`txr-models-rename-${model.id}`}
                              variant="link"
                              style={ROW_ACTION_LINK}
                              onClick={() => openRename(model)}
                            >
                              Rename
                            </Button>{' '}
                            <Button
                              data-testid={`txr-models-delete-${model.id}`}
                              variant="link"
                              style={ROW_ACTION_DANGER}
                              onClick={() => openDelete(model)}
                            >
                              Delete
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>
        )}
            </div>
          </ScrollRegion>
        }
        bottom={
          <PageFooterBar testId="txr-models-j-footer-bar">
            <div style={FOOTNOTES}>
              <span data-testid="txr-models-j-stored-line" style={STORED_LINE}>
                <span>Models are kept so you can use them for new patients.</span>
              </span>
              {/* ITEM-7: the deletion note is the desktop's own promise; in
                  the demo the shared-pool retention paragraph (above the
                  table) is the deletion truth — nothing is deleted by hand. */}
              {!isDemo ? (
                <span>Deleting a model removes its file. Results already made with it are kept in History.</span>
              ) : null}
            </div>
          </PageFooterBar>
        }
      />

      <TxrRenameModelDialog
        model={rowDialog?.kind === 'rename' ? rowDialog.model : null}
        onClose={() => setRowDialog(null)}
        onSaved={refresh}
      />
      <TxrDeleteModelDialog
        model={rowDialog?.kind === 'delete' ? rowDialog.model : null}
        onClose={() => setRowDialog(null)}
        onDeleted={refresh}
      />
      <TxrRenameSetDialog
        set={setDialog?.kind === 'rename' ? setDialog.set : null}
        onClose={() => setSetDialog(NO_SET_DIALOG)}
        onSaved={refresh}
      />
      <TxrDeleteSetDialog
        set={setDialog?.kind === 'delete' ? setDialog.set : null}
        onClose={() => setSetDialog(NO_SET_DIALOG)}
        onDeleted={onSetDeleted}
        confirmLabel="Delete the set"
        keepsTrainingFiles={
          setDialog?.kind === 'delete' && setDialog.set !== null
            ? (sets.response?.sets.find(set => set.id === setDialog.set.id)
                ?.keep_training_files ?? false)
            : false
        }
      />
    </main>
  )
}
