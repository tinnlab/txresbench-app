import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type {
  InventoryEligibilityRequest,
  MethodSummary,
  TxrRunStatus,
} from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import { buildTxrRunInput, useTxrIntakeStore } from '@/modules/txrintake'
import {
  countSelected,
  formatTotalTime,
  TxrSelectList,
  useListEstimate,
  useMethodRows,
} from '@/modules/txrlist'
import { Alert, Button, Skeleton } from '@ziee/kit'
import { RESEARCH_NOTICE } from '../lib/format'
import {
  droppedNotice,
  RUN_ALREADY_ACTIVE_LINE,
  RUN_METHODS_GONE_LINE,
  staleMethodIds,
} from '../lib/runErrors'
import { buildSlotSummaries, runSetupMissing } from '../lib/slotSummary'
import { mergeRunSettings, type RunSettings } from '../lib/settings'
import { buildRunRequest } from '../lib/runRequest'
import { buildCovariates } from '../lib/covariates'
import { buildGroupChips } from '../data/groupChips'
import { useKeepCopies } from '../data/useKeepCopies'
import { useMethodList } from '../data/useMethodList'
import { useRunConfig } from '../data/useRunConfig'
import { runningPath } from '../routes'
import { TxrAboutDialog } from '../components/TxrAboutDialog'
import { TxrChangeFilesDialog } from '../components/TxrChangeFilesDialog'
import { TxrRunEmptyState } from '../components/TxrRunEmptyState'
import { TxrSettingsBlock } from '../components/TxrSettingsBlock'
import { TxrSlotSummary } from '../components/TxrSlotSummary'

/**
 * Screen E — Choose the methods and settings (board `Busy.dc.html`): the
 * file-slot lines (Patients / Measurements / Predict with "Change files"),
 * the four setting rows (Predict, Decision day, Look ahead to, Extra
 * inputs + More settings), the shared method list with its group chips and
 * the bottom bar (selected count, total time, run-N-at-a-time, save-the-
 * trained-models, research notice, Run).
 *
 * Delivered over the ITEM-6/7 shell, ITEM-8 adds the list + the create
 * path:
 *
 * - the list is the SHARED `TxrSelectList` (INV-3 — never a bespoke row),
 *   fed by `txrlist`'s `useMethodRows(inventory)` (CONS-UI-RUN-13's
 *   inventory — the intake store's ONE validation payload, DEC-13/OWNER-4;
 *   this page never re-validates and never re-derives it) and the
 *   estimate-driven bottom bar link (`useListEstimate`, INV-4 — every time
 *   text is the providers' responses);
 * - the group chips are `buildGroupChips` (the ITEM-4 builder) wired by
 *   the host: `active`/`onToggle` are this page's filter state, the counts
 *   and order are the builder's (DEC-8 — the chips' facts come from one
 *   `MethodCatalogue.list` payload, the bounded no-pagination catalogue);
 * - the Run button posts `buildRunRequest` (the frozen PROV-EE-2 shape:
 *   the intake's own `buildTxrRunInput` verbatim — with `keep_copies`
 *   overridden by the history-store preference, CONS-UI-RUN-17/TEST-RUN-36
 *   — the settings as the config, `label_day: null`) through
 *   `ApiClient.Txr.createRun`; on `202` the URL becomes the new run's
 *   `runningPath` (the module's builder, never a literal);
 * - the create errors: a `400` surfaces the engine's line (the settings
 *   keep their values — the run was never created); a `404
 *   METHOD_NOT_FOUND` drops the selected rows the CURRENT catalogue no
 *   longer knows and says so (a stale selection is never handed to the
 *   engine twice, a message is never blank); a `409 RUN_ALREADY_ACTIVE`
 *   resolves through `Txr.listRuns` to the active run and navigates to its
 *   `runningPath` with the one-line notice (DEC-18 — the duplicate-run
 *   button is never seen), or surfaces the error when no active run
 *   answers. One create is ever in flight (the ref guard — a second click
 *   is a no-op, never a second run).
 *
 * The empty state's rule: the E content renders when the run's mode has
 * its inputs (the two train files, or the one predict file); anything
 * partial shows the state naming the missing piece. The slot lines render
 * the store's own facts (the file names + the ONE validated summary) —
 * this page never re-validates and never formats a number. When the
 * inputs are present but the store's validation is transiently null (a
 * mutation the change-files dialog made — the provider re-validates on its
 * own screens) the list area shows the pending line instead of a
 * half-built list (DEC-16's never-half-broken rule; the inventory is the
 * validation's, and a fabricated one would be a re-derivation).
 */
const PAGE_OUTER: CSSProperties = {
  flexGrow: 1,
  // The bounded page (CM-2): the shell header is 56px, and the page below it
  // is the ONE scroll container boundary — without a definite height the
  // list's flex-fill has no bounded parent and the virtualizer renders every
  // row (the 22,630 px report). The list gets the remaining height and
  // scrolls inside itself; the bottom bar stays pinned to its frame.
  height: 'calc(100dvh - 56px)',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  minHeight: 0,
  // A short window (or the phone's tall settings stack) scrolls the fixed
  // parts instead of pushing the list off; on a normal desktop the list
  // fills the space and scrolls inside ITSELF.
  overflowY: 'auto',
  boxSizing: 'border-box',
  padding: '24px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
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

/** The board's lead paragraph under the title (the board's own meters). */
const INTRO: CSSProperties = { margin: 0, color: '#3a3a3a', maxWidth: '62ch' }

/** The board's settings-card skeleton (the card's place while the first
 *  sticky-config GET is in flight — a defaults flash would mislead). */
const SETTINGS_SKELETON: CSSProperties = {
  height: 72,
  borderRadius: 10,
}

/** The list area's frame (the bounded column the shared list fills; the
 *  board's max-height 330px on a taller real page becomes the flex fill —
 *  the fill is BOUNDED by the page's definite height, CM-2 — with a floor
 *  so a short window never collapses the list into nothing). */
const LIST_FRAME: CSSProperties = {
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 240,
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid #cfcdc7',
  borderRadius: 10,
  background: '#ffffff',
  overflow: 'hidden',
}

/** The pending line's card (the inputs are there, the summary is not). */
const PENDING_BLOCK: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '18px 20px',
  border: '1px solid #e7e5e0',
  borderRadius: 10,
  background: '#fbfaf8',
}

const PENDING_LINE: CSSProperties = { margin: 0, fontSize: 13.5, color: '#5e5e5e' }

/** The pending line (the list's place while the summary is transiently null). */
const PENDING_REFRESH_LINE = 'Re-check your files to see what can run.'

/** The no-env honesty line (CM-1): the count of catalogue methods with no
 *  published environment, stated before the rows — the board has no such
 *  line (every board method can start), so the copy follows the app's
 *  plain-voice rule, never a raw code. */
const NO_ENV_LINE: CSSProperties = { margin: 0, fontSize: 12.5, color: '#8a5a00' }

export function noEnvLine(noEnv: number, total: number): string {
  return `${noEnv} of ${total} methods have no published environment on this computer and can't start.`
}

/** The run statuses DEC-18 calls "active" (the one-active-run 409's target). */
const ACTIVE_RUN_STATUSES: ReadonlySet<TxrRunStatus> = new Set([
  'creating',
  'preparing',
  'running',
])

const errorStatus = (error: unknown): number | null => {
  if (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status
  }
  return null
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return 'The run could not be created.'
}

/** The diff-patch: the fields the user changed from the value the screen
 *  showed. The screen's value is the merge + the patch, so a change never
 *  writes defaults over a sticky field the user did not touch. */
function diffPatch(next: RunSettings, current: RunSettings): Partial<RunSettings> {
  const out: Partial<RunSettings> = {}
  for (const key of Object.keys(next) as (keyof RunSettings)[]) {
    if (next[key] !== current[key]) {
      ;(out as Record<keyof RunSettings, unknown>)[key] = next[key]
    }
  }
  return out
}

/** The list section's props (the page's composition surface). */
interface TxrMethodListFrameProps {
  /** The one eligibility object (the validation's inventory, DEC-13). */
  inventory: InventoryEligibilityRequest
  /** The catalogue's method rows (the chips' facts, DEC-8). */
  methods: MethodSummary[]
  /** The host's selection (controlled; the shared list reports changes). */
  selected: ReadonlySet<string>
  onSelectionChange: (next: ReadonlySet<string>) => void
  /** The active group chip (host filter state — the builder's facts are inert). */
  groupFilter: string | null
  onGroupFilterChange: (id: string | null) => void
  /** The "Can run" pill (CM-3): only non-disabled rows when on. */
  canOnly: boolean
  onCanOnlyChange: (on: boolean) => void
  /** The screen's settings (the bar's at-a-time + save-models tie to them). */
  settings: RunSettings
  onSettingsChange: (next: RunSettings) => void
  /** The row "About" slot (the host owns the dialog). */
  onAbout: (methodId: string) => void
  /** The Run button: the run keys + the bar's options (the create path). */
  onCreate: (keys: string[], opts: { atATime: number; saveModels: boolean }) => void
  /** The chips' own refetch (wired to the list's Retry too). */
  onRetryList?: () => void
}

/**
 * The list's section: the shared `TxrSelectList` fed by the two `txrlist`
 * hooks and the host's group-chip wiring. Split off the page so the
 * inventory-dependent hooks are unconditional here while the page owns the
 * create path and the empty/pending branches (a null inventory — the
 * transient post-mutation state — never fabricates a request object).
 */
function TxrMethodListFrame({
  inventory,
  methods,
  selected,
  onSelectionChange,
  groupFilter,
  onGroupFilterChange,
  canOnly,
  onCanOnlyChange,
  settings,
  onSettingsChange,
  onAbout,
  onCreate,
  onRetryList,
}: TxrMethodListFrameProps) {
  const { rows, noEnvCount, loading, error, refetch } = useMethodRows(inventory)
  const estimate = useListEstimate([...selected], {
    patients: inventory.patients,
    cpus: settings.cpus ?? undefined,
    atATime: settings.at_a_time,
  })

  // The chips: the builder's static facts (the board order, the labels, the
  // counts over the passed set) + this host's two stateful fields — the
  // active chip and the toggle of the group filter (DRIFT-1 ITEM-4 #4).
  const chips = useMemo(
    () =>
      buildGroupChips(methods).map(chip => ({
        ...chip,
        active: groupFilter === chip.id,
        onToggle: () =>
          onGroupFilterChange(groupFilter === chip.id ? null : chip.id),
      })),
    [methods, groupFilter, onGroupFilterChange],
  )

  // The row set the list shows: the group filter over the rows' chip labels
  // (the rows carry the label, never the group id — DEC-8) composed with the
  // can-run-only pill (CM-3's "Can run = only runnable rows").
  const groupLabelOf = useMemo(() => {
    const byGroup = new Map<string, string>()
    for (const method of methods) byGroup.set(method.group, method.group_label)
    return byGroup
  }, [methods])
  const shown = useMemo(() => {
    const grouped =
      groupFilter === null
        ? rows
        : rows.filter(row => row.chip?.label === groupLabelOf.get(groupFilter))
    return canOnly ? grouped.filter(row => !row.run.disabled) : grouped
  }, [rows, groupFilter, canOnly, groupLabelOf])

  return (
    <div data-testid="txr-run-list" style={LIST_FRAME}>
      {noEnvCount > 0 ? (
        <p data-testid="txr-run-no-env-line" style={NO_ENV_LINE}>
          {noEnvLine(noEnvCount, rows.length)}
        </p>
      ) : null}
      <TxrSelectList
        rows={shown}
        itemLabel="method"
        selected={selected}
        onSelectionChange={onSelectionChange}
        filterChips={chips}
        allFilter={{
          active: groupFilter === null && !canOnly,
          onClick: () => {
            onGroupFilterChange(null)
            onCanOnlyChange(false)
          },
        }}
        canRunFilter={{ active: canOnly, onClick: () => onCanOnlyChange(!canOnly) }}
        loading={loading}
        error={error}
        onRetry={() => {
          refetch()
          onRetryList?.()
        }}
        bottomBar={{
          selectedCount: countSelected(selected, rows),
          totalTimeText: formatTotalTime(estimate.scheduleSeconds),
          atATime: {
            value: settings.at_a_time,
            onChange: value => onSettingsChange({ ...settings, at_a_time: value }),
          },
          saveModels: {
            checked: settings.save_models,
            onChange: value => onSettingsChange({ ...settings, save_models: value }),
          },
          notice: RESEARCH_NOTICE,
          onRun: (keys, opts) => onCreate(keys, opts),
        }}
        onRowAction={row => onAbout(row.key)}
      />
    </div>
  )
}

export function ChooseMethodsPage() {
  const navigate = useNavigate()
  const [changeOpen, setChangeOpen] = useState(false)
  const [settingsPatch, setSettingsPatch] = useState<Partial<RunSettings> | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [canOnly, setCanOnly] = useState(false)
  const [aboutId, setAboutId] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const creating = useRef(false)
  const mode = useStore(useTxrIntakeStore, s => s.mode)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const runConfig = useRunConfig()
  const { keepCopies } = useKeepCopies()
  const { methods, refetch: refetchList } = useMethodList()

  const merged = useMemo(
    () => mergeRunSettings(runConfig.engine, parameters),
    [runConfig.engine, parameters],
  )
  const settings = settingsPatch === null ? merged : { ...merged, ...settingsPatch }
  // The Extra-inputs names line: the patients file's inspection
  // covariate columns (the one file that owns the covariate roles); a
  // render without a patients file has no covariate source at all.
  const covariates = patients === null ? null : buildCovariates(patients.inspection)

  const change = (next: RunSettings): void => {
    setSettingsPatch(current => ({ ...(current ?? {}), ...diffPatch(next, settings) }))
    void runConfig.update(next)
  }

  // A retry-load that lands AFTER the user's edit recomposes the merged
  // view: the write-through body is once more the screen's truth (the
  // user's fields + the freshly restored sticky fields). The user's
  // edit was queued against the defaults-based view, and the hook
  // coalesces the two writes so the sticky store never ends at a
  // defaults value for a field the user did not touch. The mount
  // transition (first engine value) has no patch yet — the skeleton
  // keeps the rows un-runnable until it lands — so it writes nothing.
  const engineBefore = useRef<typeof runConfig.engine>(runConfig.engine)
  useEffect(() => {
    const previous = engineBefore.current
    engineBefore.current = runConfig.engine
    if (settingsPatch === null) return
    if (previous !== runConfig.engine) {
      void runConfig.update({ ...merged, ...settingsPatch })
    }
    // The engine transition is the only trigger — a row change is already
    // written by `change` above (this closure intentionally binds only
    // the transition render's patch/merge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runConfig.engine])

  const inventory = validation?.inventory ?? null

  /**
   * The Run button's create path: one request (the frozen PROV-EE-2 shape)
   * through the engine, then the module's own `runningPath`. The bar's
   * options are the screen's values for the two fields they own; the
   * intake's input builder result is VERBATIM with the history-store
   * preference overriding `keep_copies` (CONS-UI-RUN-17).
   */
  const createRun = useCallback(
    async (
      keys: string[],
      opts: { atATime: number; saveModels: boolean },
    ): Promise<void> => {
      if (creating.current) return
      creating.current = true
      setRunError(null)
      setRunNotice(null)
      try {
        // The intake's ONE builder gets the run inputs it reads — the file
        // slots, the confirmed joins and the marker mapping. The remaining
        // `IntakeSnapshot` fields (the answer/interests/parameters slices,
        // whose names this module never spells — the ITEM-6 copy rule) are
        // untouched by the builder; the provider's type requires them, so
        // the object here is the builder's consumed contract (the same
        // type-bridge class as `toRunConfig`'s, ITEM-3 note (a)).
        const input = buildTxrRunInput({
          patients,
          measurements,
          predictMeasurements,
          joins,
          mapping,
        } as unknown as IntakeSnapshot)
        const request = buildRunRequest(
          'train',
          { ...input, keep_copies: keepCopies },
          { ...settings, at_a_time: opts.atATime, save_models: opts.saveModels },
          keys,
        )
        const run = await ApiClient.Txr.createRun(request)
        navigate(runningPath(run.id))
      } catch (err) {
        const status = errorStatus(err)
        if (status === 409) {
          try {
            const page = await ApiClient.Txr.listRuns({ limit: 50 })
            const active = page.runs.find(run => ACTIVE_RUN_STATUSES.has(run.status))
            if (active !== undefined) {
              navigate(runningPath(active.id), { state: { resumed: true } })
              return
            }
          } catch {
            // The lookup failed — the error line below is the honest state.
          }
          setRunError(RUN_ALREADY_ACTIVE_LINE)
        } else if (status === 404) {
          const message = errorText(err)
          const dropped = staleMethodIds(
            message,
            keys,
            methods.map(method => method.id),
          )
          if (dropped.length > 0) {
            const droppedSet = new Set(dropped)
            setSelected(current => new Set([...current].filter(key => !droppedSet.has(key))))
            setRunNotice(droppedNotice(dropped))
          } else {
            setRunError(RUN_METHODS_GONE_LINE)
          }
        } else {
          setRunError(errorText(err))
        }
      } finally {
        creating.current = false
      }
    },
    [
      patients,
      measurements,
      predictMeasurements,
      joins,
      mapping,
      keepCopies,
      settings,
      methods,
      navigate,
    ],
  )

  const missing = runSetupMissing({ mode, patients, measurements, predictMeasurements })
  if (missing !== null) {
    return (
      <main data-testid="txr-run" style={PAGE_OUTER}>
        <div style={PAGE_MAIN}>
          <div style={STEP_LINE}>Step 4 of 4</div>
          <h1 style={TITLE}>Choose the methods and settings</h1>
          <TxrRunEmptyState missing={missing} onStartNew={() => navigate('/')} />
        </div>
      </main>
    )
  }

  return (
    <main data-testid="txr-run" style={PAGE_OUTER}>
      <div style={PAGE_MAIN}>
        <div style={STEP_LINE}>Step 4 of 4</div>
        <h1 style={TITLE}>Choose the methods and settings</h1>
        {inventory !== null ? (
          <p data-testid="txr-run-intro" style={INTRO}>
            Checked against your files. Pick as many methods as you like; each
            learns from your {inventory.patients} patients, then predicts.
          </p>
        ) : null}
        <TxrSlotSummary
          slots={buildSlotSummaries({ mode, patients, measurements, predictMeasurements, validation })}
          onChangeFiles={() => setChangeOpen(true)}
        />
        {runConfig.loading ? (
          <Skeleton data-testid="txr-run-settings-loading" style={SETTINGS_SKELETON} />
        ) : (
          <>
            {runConfig.error !== null ? (
              <Alert
                tone="warning"
                data-testid="txr-run-settings-error"
                title={runConfig.error}
              >
                <Button
                  variant="outline"
                  data-testid="txr-run-settings-retry"
                  onClick={runConfig.retry}
                >
                  Retry
                </Button>
              </Alert>
            ) : null}
            <TxrSettingsBlock
              value={settings}
              covariates={covariates}
              onChange={change}
              onMoreSettings={next => change({ ...settings, ...next })}
            />
          </>
        )}
        {runError !== null ? (
          <Alert tone="error" data-testid="txr-run-create-error" title={runError} />
        ) : null}
        {runNotice !== null ? (
          <Alert tone="warning" data-testid="txr-run-create-notice" title={runNotice} />
        ) : null}
        {inventory !== null ? (
          <TxrMethodListFrame
            inventory={inventory}
            methods={methods}
            selected={selected}
            onSelectionChange={setSelected}
            groupFilter={groupFilter}
            onGroupFilterChange={setGroupFilter}
            canOnly={canOnly}
            onCanOnlyChange={setCanOnly}
            settings={settings}
            onSettingsChange={change}
            onAbout={setAboutId}
            onCreate={(keys, opts) => {
              void createRun(keys, opts)
            }}
            onRetryList={refetchList}
          />
        ) : (
          <div data-testid="txr-run-list-pending" style={PENDING_BLOCK}>
            <p style={PENDING_LINE}>{PENDING_REFRESH_LINE}</p>
          </div>
        )}
      </div>
      <TxrChangeFilesDialog
        mode={mode}
        open={changeOpen}
        onOpenChange={setChangeOpen}
      />
      <TxrAboutDialog methodId={aboutId} onClose={() => setAboutId(null)} />
    </main>
  )
}
