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
 * - the header: the board title + the permanent subtitle + the search
 *   input ("Search models" — the SERVER-side `q` filter, debounced 250 ms
 *   in the data hook; a substring on name / method id) + "Open a model
 *   file" (the multipart import: a file picker hands the picked container
 *   to `POST /api/txr/models/import` — CONS-UM-9 — with `set_id` when the
 *   set-focus view is active, then the list refreshes; a FAILURE surfaces
 *   inline: the page's steady "The model file could not be opened." line,
 *   except the server's 409 SET_NAME_TAKEN, which names the remedy
 *   (rename the taken set, or open the file from inside it));
 * - the table: the board's seven columns — Model (the display label +
 *   the subline: "N markers", "uses age", "opened from <file>" — the
 *   grown `marker_count` / `uses_covariates` / `imported_from` with the
 *   fallbacks, a row with none renders the name alone), Method (mono),
 *   Predicts, Decision day (right), Trained on (right, "not recorded" for
 *   an unknown cohort), Made ("21 Oct 2026" / "opened 14 Oct 2026"), and
 *   the Actions column (Use primary, Export / Rename, Delete danger — the
 *   board's plain text row actions);
 * - the row actions: Use → the DEC-10 handoff (`setIntent('reuse')` +
 *   `pendingUseModelId` + navigate to the predict-files screen — the J
 *   half of the flow, the I screen preselects); Export → the provider's
 *   attachment through the generated client (`lib/export.ts`); Rename →
 *   PATCH (`TxrRenameModelDialog`); Delete → the confirm dialog with the
 *   board's deletion promise verbatim (`TxrDeleteModelDialog`), then
 *   DELETE (DEC-14);
 * - the `?set=` focus (DEC-19): READ from the URL — the provider's
 *   `set_id` filter — with the "Showing the set '<name>' · Show all"
 *   affordance that clears the param (screen K's set links target
 *   `modelsPath(setId)`);
 * - the section set actions (the set-level rename/export/delete): each real
 *   set section's header gets Rename set / Export set / Delete set
 *   (link buttons, no demo, none on "Not in a set"); Rename opens
 *   `TxrRenameSetDialog` (the same one the I screen uses), Export runs the
 *   registered `models.exportSet` download (the set's `.txr`), Delete runs
 *   the registered `models.deleteSet`, which only OPENS
 *   `TxrDeleteSetDialog` for the person to confirm (it never deletes);
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
import { useNavigate, useSearchParams } from 'react-router-dom'
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
  formatTrainedOn,
} from '../lib/format'
import { buildModelSetSections, type ModelSetSection } from '../lib/rows'
import { TxrDeleteModelDialog } from '../components/TxrDeleteModelDialog'
import { TxrDeleteSetDialog } from '../components/TxrDeleteSetDialog'
import { TxrRenameModelDialog } from '../components/TxrRenameModelDialog'
import { TxrRenameSetDialog } from '../components/TxrRenameSetDialog'

/** The page's flex spine (the frame fills the routed area). */
const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
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

/** The ONE scroll region's content padding (the region scrolls, the padding rides). */
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

/** The table's rounded card (the board's frame; the REGION scrolls both axes — ITEM-3). */
const TABLE_BOX: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
  minWidth: 0,
}

/** One set's section (the header + the same table the flat page had). */
const SECTION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minWidth: 0,
}

/** The section header (title + facts, one wrapping line — phone width). */
const SECTION_HEADER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '2px 12px',
  padding: '0 2px',
  minWidth: 0,
}

/** The section title (the board's model-set heading). */
const SECTION_TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 18,
  lineHeight: 1.3,
}

/** The section facts line (muted, one line — the I run-facts precedent). */
const SECTION_FACTS: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--txr-muted)',
}

/** The section's action button group (right of the title+facts line on a
 *  wide window; wraps UNDER the title on a phone — the header's own wrap). */
const SECTION_ACTIONS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px 12px',
  alignItems: 'center',
  marginLeft: 'auto',
  minWidth: 0,
}

const TABLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: 14,
  minWidth: 960,
}

const HEAD_LOOK: CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontWeight: 600,
  borderBottom: '1px solid var(--txr-border)',
  background: 'var(--txr-surface-dim)',
  whiteSpace: 'nowrap',
  // ITEM-3: the header sticks to the REGION's top (the region is the
  // scrollport; the opaque surface is the header token).
  position: 'sticky',
  top: 0,
  zIndex: 2,
}

const HEAD_RIGHT: CSSProperties = { ...HEAD_LOOK, textAlign: 'right' }

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

const TD_RIGHT: CSSProperties = { ...TD_LOOK, textAlign: 'right', whiteSpace: 'nowrap' }

const ROW_HEADER: CSSProperties = {
  ...TD_LOOK,
  textAlign: 'left',
  fontWeight: 700,
  color: 'var(--txr-text)',
}

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

/** The import failure's fallback (never blank). */
const IMPORT_FAILED_LINE = 'The model file could not be opened.'

/** The import clash line (the server's 409 SET_NAME_TAKEN): the container's
 *  recorded set name is taken — the page names the remedy instead of the
 *  engine's words (rename the set, or open the file from inside that set). */
const IMPORT_NAME_TAKEN_LINE =
  'A set with this name already exists. Rename that set first, or open the file from inside it to add its models.'

/** True for the server's `SET_NAME_TAKEN` import refusal (the framework
 *  transport attaches the server's `error_code` to the thrown Error —
 *  `error_code`, the one stable machine code, never the message). */
function isSetNameTaken(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { error_code?: unknown }).error_code === 'SET_NAME_TAKEN'
  )
}

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

/**
 * One section's facts line from the section's provider facts (the pure
 * `formatSetFacts` — the section header reads ONLY engine facts, never a
 * constant):
 *
 * - a set section: the set's `model_count`, its run/file/source fact, its
 *   `created_at` and `keep_training_files`; the import file is the rows'
 *   own `imported_from` (the subline's fact — a set imported from a file
 *   has no `source_run_id`, and the rows carry the file they were opened
 *   from);
 * - the not-in-a-set section: the bare count line (no set facts exist).
 */
function setFactsLine(section: ModelSetSection): string {
  if (section.unsetted) {
    return formatSetFacts({
      count: section.models.length,
      createdAt: null,
      keepTrainingFiles: false,
      sourceLabel: null,
      fromRun: false,
      importedFrom: null,
    })
  }
  const set = section.set
  const importedFrom =
    section.models
      .map(model => model.imported_from?.trim() ?? '')
      .find(value => value.length > 0) ?? null
  return formatSetFacts({
    count: set?.model_count ?? section.models.length,
    createdAt: set?.created_at ?? null,
    keepTrainingFiles: set?.keep_training_files ?? false,
    sourceLabel: set?.source_label ?? null,
    fromRun: set?.source_run_id !== undefined && set?.source_run_id !== null,
    importedFrom,
  })
}

/** The one row dialog at a time (rename or delete; the plan's per-action confirmations). */
type RowDialog = { kind: 'rename' | 'delete'; model: ModelSummary } | null

/** The one SET dialog at a time (the section header's Rename set /
 *  Delete set — the row dialogs' set-level twins). */
type SetDialog = { kind: 'rename' | 'delete'; set: { id: string; name: string } } | null

const NO_SET_DIALOG: SetDialog = null

export function ModelsPage() {
  const navigate = useNavigate()
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
  const inventory = useModelInventory({ query: search, setId })
  // The sets read is the section headers' facts source (model_count,
  // source_label, created_at, keep_training_files) — loaded and refreshed
  // with the model list (a mutation can change a set's rows/count).
  const sets = useModelSets()
  const [rowDialog, setRowDialog] = useState<RowDialog>(null)
  const [setDialog, setSetDialog] = useState<SetDialog>(NO_SET_DIALOG)
  const [actionError, setActionError] = useState<string | null>(null)
  // Where the desktop app's Save dialog put an exported model file.
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportingSet, setExportingSet] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const models = inventory.response?.models ?? []

  /** The set-focus name (the rows' own `set_name`; the URL id is the honest
   *  fallback for a set with no rows — a deleted set must not fabricate a
   *  name). */
  const focusedSetName = setId === null ? null : (models[0]?.set_name ?? setId)

  /** The section view: one section per set, newest first, the not-in-a-set
   *  section last; the builder omits sections with no listed model (the
   *  server-side `q`/`?set=` filters leave only the matching sections).
   *
   *  A sets re-read IN FLIGHT passes `null` (the fallback grouping): while
   *  the refresh is pending, a model of a brand-new set (an import just
   *  created it) is grouped by its own `set_name` — the sets list may not
   *  know it yet, and the not-in-a-set section must never flash it. */
  const sections = useMemo(
    () => buildModelSetSections(sets.loading ? null : (sets.response?.sets ?? null), models),
    [sets.loading, sets.response, models],
  )

  /** The post-mutation refresh: the model list AND the sets (the section
   *  headers' facts are the sets read's — a rename/import/delete can
   *  change both). */
  const { refresh: refreshInventory } = inventory
  const { refresh: refreshSets } = sets
  const refresh = useCallback((): void => {
    refreshInventory()
    refreshSets()
  }, [refreshInventory, refreshSets])

  // The registered `models.renameSet` action's refresh: the AI/command path
  // has no dialog `onSaved`, so the action publishes the refresh bus and
  // EVERY mounted host that shows the sets data re-reads (this page's hooks
  // here; the saved-models store in the I page). The human path refreshes
  // through the dialogs' own callbacks — never a double refresh.
  useEffect(() => subscribeModelSetsChanged(refresh), [refresh])

  /** The set record for a set id: the SetSummary (name + the keep flag) from
   *  the sets read, else the fallback group's own title (a sets-read-failed
   *  section still has a real set id and its rows' set name). */
  const resolveSet = useCallback(
    (setId: string): { id: string; name: string } | null => {
      const known = sets.response?.sets.find(set => set.id === setId)
      if (known !== undefined) return { id: known.id, name: known.name }
      const section = sections.find(candidate => candidate.key === setId)
      return section === undefined ? null : { id: section.key, name: section.title }
    },
    [sets.response, sections],
  )

  // The registered `models.deleteSet` action only OPENS the confirm dialog
  // (it never deletes): the pending-request channel is the seam, and this
  // page is one of the two hosts (with the saved-models page) that listen.
  // The listener reports back whether IT opened the dialog (true only when
  // the set resolved to a real section and the dialog was shown; false when
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

  /** Import — the picked container to `POST /api/txr/models/import`
   *  (multipart, the `file` part — CONS-UM-9; `set_id` rides when the
   *  set-focus view is active so a focused import lands in the focused
   *  set), then the list refreshes. The input is cleared synchronously so
   *  picking the same file again re-fires. */
  const importFile = useCallback(
    async (file: File): Promise<void> => {
      setImportError(null)
      const form = new FormData()
      form.append('file', file, file.name)
      if (setId !== null) form.append('set_id', setId)
      try {
        await ApiClient.Models.importModel(form)
        refresh()
      } catch (error) {
        // The one clash answer (SET_NAME_TAKEN) names the remedy; every
        // other failure is the page's steady open-failed line — never the
        // transport's own words. brief 3b: the failure's detail is still
        // logged (the fixed line is the user-facing copy, not the whole
        // record).
        if (isSetNameTaken(error)) {
          setImportError(IMPORT_NAME_TAKEN_LINE)
        } else {
          console.warn('model import failed', error)
          setImportError(IMPORT_FAILED_LINE)
        }
      }
    },
    [setId, refresh],
  )

  // The pending first read is the only in-flight state the page shows as a
  // line; later re-reads keep the table (the hook keeps the last response).
  // The sets read rides the same gate: the section headers need it, so the
  // first paint waits for BOTH first responses (they fire in parallel).
  const firstLoading =
    (inventory.loading && inventory.response === null) ||
    (sets.loading && sets.response === null)

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
                  placeholder="Search models"
                  aria-label="Search models"
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
                    <Button data-testid="txr-models-import" onClick={() => fileRef.current?.click()}>
                      {IMPORT_LABEL}
                    </Button>
                    {/* native-control-ok: the file input is invisible; the visible affordance is <Button> */}
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".txr"
                      style={{ display: 'none' }}
                      aria-hidden="true"
                      tabIndex={-1}
                      data-testid="txr-models-import-file"
                      onChange={event => {
                        const file = event.target.files?.[0] ?? null
                        event.target.value = ''
                        if (file !== null) void importFile(file)
                      }}
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
          <ScrollRegion label="Your models" className="txr-models-j-region">
            <div style={REGION_CONTENT}>
        {firstLoading ? (
          <div style={TABLE_BOX}>
            <div data-testid="txr-models-j-loading" style={BOX_LINE}>
              Loading models…
            </div>
          </div>
        ) : models.length === 0 ? (
          <div style={TABLE_BOX}>
            <div
              data-testid={search.trim().length > 0 || setId !== null ? 'txr-models-j-no-match' : 'txr-models-j-empty'}
              style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20, alignItems: 'flex-start' }}
            >
              <p style={{ margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }}>
                {search.trim().length > 0 || setId !== null ? NO_MATCH_LINE : EMPTY_LINE}
              </p>
              {search.trim().length === 0 && setId === null ? (
                <>
                  <p style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-muted)' }}>{EMPTY_NOTE}</p>
                  {!isDemo ? (
                    <Button data-testid="txr-models-empty-import" onClick={() => fileRef.current?.click()}>
                      {IMPORT_LABEL}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : (
          sections.map(section => (
            <section
              key={section.key}
              data-testid={`txr-models-j-section-${section.key}`}
              style={SECTION}
              aria-labelledby={`txr-models-j-title-${section.key}`}
            >
              <header style={SECTION_HEADER}>
                <h2 id={`txr-models-j-title-${section.key}`} style={SECTION_TITLE}>
                  {section.title}
                </h2>
                <span style={SECTION_FACTS}>{setFactsLine(section)}</span>
                {/* The three set actions: every real set section gets them
                    (a sets-read-failed fallback group keeps its buttons —
                    they act by the real set id; the NOT-in-a-set section has
                    none; the demo's pools are the shared one and the server
                    blocks both, ITEM-7). */}
                {!isDemo && !section.unsetted ? (
                  <div
                    role="group"
                    aria-label={`Actions for ${section.title}`}
                    data-testid={`txr-models-set-actions-${section.key}`}
                    style={SECTION_ACTIONS}
                  >
                    <Button
                      data-testid={`txr-models-set-rename-btn-${section.key}`}
                      variant="link"
                      style={ROW_ACTION_LINK}
                      onClick={() => openSetRename(section.key, section.title)}
                    >
                      Rename set
                    </Button>
                    <Button
                      data-testid={`txr-models-set-export-btn-${section.key}`}
                      variant="link"
                      style={ROW_ACTION_LINK}
                      disabled={exportingSet}
                      onClick={() => void exportSet(section.key)}
                    >
                      {setExportLabel()}
                    </Button>
                    <Button
                      data-testid={`txr-models-set-delete-btn-${section.key}`}
                      variant="link"
                      style={ROW_ACTION_DANGER}
                      onClick={() => openSetDelete(section.key)}
                    >
                      Delete set
                    </Button>
                  </div>
                ) : null}
              </header>
              <div style={TABLE_BOX}>
          <table
            data-testid="txr-models-j-table"
            className="txr-models-j-table"
            style={TABLE}
            aria-labelledby={`txr-models-j-title-${section.key}`}
          >
            <thead>
              <tr>
                <th scope="col" style={HEAD_LOOK}>Model</th>
                <th scope="col" style={HEAD_LOOK}>Method</th>
                <th scope="col" style={HEAD_LOOK}>Predicts</th>
                <th scope="col" style={HEAD_RIGHT}>Decision day</th>
                <th scope="col" style={HEAD_RIGHT}>Trained on</th>
                <th scope="col" style={HEAD_LOOK}>Made</th>
                <th scope="col" style={{ ...HEAD_LOOK, textAlign: 'right' }}>
                  <span style={VISUALLY_HIDDEN}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {section.models.map(model => {
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
                const lastTd = { ...TD_LOOK, borderBottom: 'none' }
                return (
                  <tr key={model.id} data-testid={`txr-models-row-${model.id}`}>
                    <th
                      scope="row"
                      data-label="Model"
                      style={{ ...ROW_HEADER, borderBottom: 'none' }}
                    >
                      {model.name}
                      {subline.length > 0 ? (
                        <div className="txr-models-j-subline" style={SUBLINE}>
                          {subline}
                        </div>
                      ) : null}
                    </th>
                    <td data-label="Method" style={lastTd}>
                      <span style={MONO}>{model.method_id}</span>
                    </td>
                    <td data-label="Predicts" style={lastTd}>
                      {formatPredicts(model.task ?? null, model.endpoint, model.horizon)}
                    </td>
                    <td data-label="Decision day" style={{ ...lastTd, textAlign: 'right' }}>
                      {model.decision_day}
                    </td>
                    <td data-label="Trained on" style={{ ...lastTd, textAlign: 'right' }}>
                      <span style={model.trained_on_patients == null ? MUTED : undefined}>
                        {trainedOn}
                      </span>
                    </td>
                    <td data-label="Made" style={{ ...lastTd, whiteSpace: 'nowrap' }}>{formatMade(model.created_at, model.provenance)}</td>
                    <td
                      data-label="Actions"
                      style={{
                        ...lastTd,
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
          </table>
              </div>
            </section>
          ))
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
