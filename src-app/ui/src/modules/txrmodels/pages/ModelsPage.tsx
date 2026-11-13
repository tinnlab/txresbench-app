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
 *   set-focus view is active, then the list refreshes; failures surface
 *   inline);
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
import { useCallback, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiClient } from '@/api-client'
import type { ModelSummary } from '@/api-client/types'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { PageFooterBar } from '@/modules/txrshell/components/PageFooterBar'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { predictFilesPath } from '@/modules/txrrun'
import { Alert, Button, Input } from '@txresbench/kit'
import { useModelInventory } from '../data/useModelInventory'
import { downloadModelExport } from '../lib/export'
import { formatMade, formatModelSublines, formatPredicts, formatTrainedOn } from '../lib/format'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { TxrDeleteModelDialog } from '../components/TxrDeleteModelDialog'
import { TxrRenameModelDialog } from '../components/TxrRenameModelDialog'

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

/** The one row dialog at a time (rename or delete; the plan's per-action confirmations). */
type RowDialog = { kind: 'rename' | 'delete'; model: ModelSummary } | null

export function ModelsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const setId = searchParams.get('set')
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('Your models')

  const [search, setSearch] = useState('')
  const inventory = useModelInventory({ query: search, setId })
  const [rowDialog, setRowDialog] = useState<RowDialog>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const models = inventory.response?.models ?? []

  /** The set-focus name (the rows' own `set_name`; the URL id is the honest
   *  fallback for a set with no rows — a deleted set must not fabricate a
   *  name). */
  const focusedSetName = setId === null ? null : (models[0]?.set_name ?? setId)

  const refresh = inventory.refresh

  /** Use — the DEC-10 handoff: intent reuse + the pending model id, then
   *  the N screen (the user adds the predict file; the I screen preselects
   *  this row on mount — the board's path 3 flow, never a direct run). */
  const useModel = useCallback(
    (model: ModelSummary): void => {
      useTxrIntakeStore.getState().setIntent('reuse')
      useTxrModelsStore.getState().setPendingUse(model.id)
      // The URL announces the choice (the J "?set=" view precedent, DEC-19):
      // the N screen names the chosen model while the handoff is live
      // (RES-21 — "which model did I pick?" was left unspoken by the flow).
      navigate(`${predictFilesPath()}?use=${encodeURIComponent(model.id)}&name=${encodeURIComponent(model.name)}`)
    },
    [navigate],
  )

  /** Export — the provider's attachment, byte passthrough; the picked
   *  bytes land in the user's downloads via `lib/export.ts`. A failure
   *  surfaces inline (never a silent no-op). */
  const exportModel = useCallback(
    async (model: ModelSummary): Promise<void> => {
      setExporting(true)
      setActionError(null)
      try {
        await downloadModelExport(model)
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
        setImportError(errorText(error))
      }
    },
    [setId, refresh],
  )

  // The pending first read is the only in-flight state the page shows as a
  // line; later re-reads keep the table (the hook keeps the last response).
  const firstLoading = inventory.loading && inventory.response === null

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
              </div>
            </div>

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
            {importError !== null ? (
              <Alert tone="error" data-testid="txr-models-j-import-error" title={importError} />
            ) : null}
            {actionError !== null ? (
              <Alert tone="error" data-testid="txr-models-j-action-error" title={actionError} />
            ) : null}
          </div>
        }
        body={
          <ScrollRegion label="Your models" className="txr-models-j-region">
            <div style={REGION_CONTENT}>
              <div style={TABLE_BOX}>
        {firstLoading ? (
          <div data-testid="txr-models-j-loading" style={BOX_LINE}>
            Loading models…
          </div>
        ) : models.length === 0 ? (
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
                <Button data-testid="txr-models-empty-import" onClick={() => fileRef.current?.click()}>
                  {IMPORT_LABEL}
                </Button>
              </>
            ) : null}
          </div>
        ) : (
          <table
            data-testid="txr-models-j-table"
            className="txr-models-j-table"
            style={TABLE}
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
              {models.map(model => {
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
                    <td data-label="Made" style={lastTd}>{formatMade(model.created_at, model.provenance)}</td>
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
                      </Button>{' '}
                      <Button
                        data-testid={`txr-models-export-${model.id}`}
                        variant="link"
                        style={ROW_ACTION_LINK}
                        disabled={exporting}
                        onClick={() => void exportModel(model)}
                      >
                        Export
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
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
              </div>
            </div>
          </ScrollRegion>
        }
        bottom={
          <PageFooterBar testId="txr-models-j-footer-bar">
            <div style={FOOTNOTES}>
              <span data-testid="txr-models-j-stored-line" style={STORED_LINE}>
                <span>Models are kept so you can use them for new patients.</span>
              </span>
              <span>Deleting a model removes its file. Results already made with it are kept in History.</span>
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
    </main>
  )
}
