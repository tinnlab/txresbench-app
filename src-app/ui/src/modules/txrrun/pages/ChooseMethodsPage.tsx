import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type {
  InventoryEligibilityRequest,
  TxrRunStatus,
} from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import { buildTxrRunInput, useTxrIntakeStore } from '@/modules/txrintake'
import {
  countSelected,
  recommendedSelection,
  TxrMethodPicker,
  useListEstimate,
  useMethodRows,
} from '@/modules/txrlist'
import { Alert, Button, message, Skeleton } from '@ziee/kit'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import {
  PageFrame,
} from '@/modules/txrshell/components/PageFrame'
import {
  ScrollRegion,
} from '@/modules/txrshell/components/ScrollRegion'
import {
  droppedNotice,
  RUN_ALREADY_ACTIVE_LINE,
  RUN_METHODS_GONE_LINE,
  staleMethodIds,
} from '../lib/runErrors'
import { runSetupMissing } from '../lib/slotSummary'
import { buildFilesSummary } from '../lib/filesSummary'
import { formatRunBarTime } from '../lib/runBar'
import { mergeRunSettings, type RunSettings } from '../lib/settings'
import { buildRunRequest } from '../lib/runRequest'
import { buildCovariates } from '../lib/covariates'
import { useKeepCopies } from '../data/useKeepCopies'
import { useRunConfig } from '../data/useRunConfig'
import { runningPath } from '../routes'
import { TxrChangeFilesDialog } from '../components/TxrChangeFilesDialog'
import { TxrRunEmptyState } from '../components/TxrRunEmptyState'
import { TxrSettingsBlock } from '../components/TxrSettingsBlock'
import { TxrFilesSummary } from '../components/TxrFilesSummary'
import { TxrRunBar } from '../components/TxrRunBar'
import type { TxrMethodCard } from '@/modules/txrlist'

/**
 * Screen E — Choose the methods and settings (qa-fixes3 ITEM-1 redesign,
 * part 1: structure, defaults, rows; ITEM-2: the settings card's title and
 * live sentence, the compact files summary, the new run bar and the phone
 * layout):
 *
 * - the page is ONE document that scrolls (`PAGE_MAIN` is the only vertical
 *   scroll container — the old nested ~330 px list box is gone);
 * - the list is the picker `TxrMethodPicker` (txrlist), fed by the
 *   catalogue × eligibility adapter (`useMethodRows` — the intake
 *   validation's ONE inventory, DEC-13: this page never re-validates) with
 *   the new human-name fields (title/summary/paper_title) from the API;
 * - on arrival a deterministic recommended set is already ticked (up to 8,
 *   at most 3 per family — `recommendedSelection`); the user's own tick or
 *   a preset stops the auto-selection for the rest of the screen's life
 *   (a settings change then keeps the user's selection — ITEM-2's
 *   eligibility-preserving rule: the selection keeps the still-eligible,
 *   the newly-ineligible are unticked with the toast);
 * - the eligibility request reflects the SETTINGS the screen shows (the
 *   decision day + the extra-inputs switch are the verdicts' own inputs),
 *   so a change re-checks with the picker's visible re-check line;
 * - the sticky run bar is ITEM-2's own `TxrRunBar` (the boards' shared
 *   `TxrListBottomBar` stays for the D/I model screens);
 * - the create path is unchanged: `buildRunRequest` → `Txr.createRun`, the
 *   202 → `runningPath`, the 404/409 resolutions, the one-create-in-flight
 *   guard (see the ITEM-8 notes carried in the git history).
 *
 * app-shell ITEM-2 — the frame byte (the audit's route table): the fixed
 * top holds the step/title, the files summary, the settings card and the
 * picker TOOLBAR (the picker's own `layout` split keeps its state local),
 * the method list is ONE ScrollRegion (the sections' sticky headers stick
 * to ITS top — the audit's "the list is the scroll region with sticky
 * section headers"), the run bar is pinned in the frame's bottom slot, and
 * the page itself never scrolls. The `layout` callback renders the WHOLE
 * PageFrame because the picker owns the toolbar/list seam.
 */

const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (the frame's page chrome). */
const PAGE_TOP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '24px 36px 0',
  minWidth: 0,
}

/** The picker's fixed-toolbar slot (the picker's split wrapper). */
const PICKER_SPLIT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minWidth: 0,
}

/** The list region's content padding (the region scrolls, the padding rides). */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '12px 36px 24px',
  minWidth: 0,
}

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  minHeight: 0,
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
  color: 'var(--txr-brand)',
}

const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

/** The board's lead paragraph under the title (the data-filled meter). */
const INTRO: CSSProperties = { margin: 0, color: 'var(--txr-text-2)', maxWidth: '62ch' }

/** The settings card's skeleton while the first sticky-config GET is in
 *  flight (a defaults flash would mislead). */
const SETTINGS_SKELETON: CSSProperties = {
  height: 72,
  borderRadius: 10,
}

/** The pending line's card (the inputs are there, the summary is not). */
const PENDING_BLOCK: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '18px 20px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
}

const PENDING_LINE: CSSProperties = { margin: 0, fontSize: 13.5, color: 'var(--txr-muted)' }

/** The pending line (the list's place while the summary is transiently null). */
const PENDING_REFRESH_LINE = 'Re-check your files to see what can run.'

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
 *  showed (a change never writes defaults over a sticky field). */
function diffPatch(next: RunSettings, current: RunSettings): Partial<RunSettings> {
  const out: Partial<RunSettings> = {}
  for (const key of Object.keys(next) as (keyof RunSettings)[]) {
    if (next[key] !== current[key]) {
      ;(out as Record<keyof RunSettings, unknown>)[key] = next[key]
    }
  }
  return out
}

/** The picker's frame: the inventory-dependent hooks (the one adapter fed by
 *  the validation's inventory — a null inventory never fabricates a request
 *  object) plus the ONE-TIME recommended seeding and the ITEM-2
 *  eligibility-preserving rule. The joined cards are reported up so the page
 *  can count the bar's selection against the real runnable set (a stale key
 *  is never counted). */
function TxrMethodPickerFrame({
  inventory,
  selected,
  onSelectionChange,
  onCards,
  onChangeFiles,
  onChangeSettings,
  layout,
}: {
  inventory: InventoryEligibilityRequest
  selected: ReadonlySet<string>
  onSelectionChange(next: ReadonlySet<string>): void
  onCards(cards: TxrMethodCard[]): void
  onChangeFiles(): void
  onChangeSettings(): void
  layout: NonNullable<Parameters<typeof TxrMethodPicker>[0]['layout']>
}) {
  const { cards, loading, error, refetch } = useMethodRows(inventory)
  // The user's own selection change (a manual tick or a preset) turns the
  // auto-recommendation off for the rest of the screen's life — a settings
  // change recomputes eligibility but never overrides a human choice.
  const touched = useRef(false)
  const seeded = useRef(false)
  // The effect below is keyed on `cards` only (the adapter's one event); the
  // CURRENT selection is read through a ref so the prune is never stale.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    onCards(cards)
    // ITEM-2: a settings change re-checks eligibility; the selection keeps
    // the methods that still fit, and the ones that stopped being eligible
    // are UNTICKED with the toast (the plan's words). This runs before the
    // seed, so the first-load recommendation never fires it.
    const disabled = new Set(cards.filter(card => card.run.disabled).map(card => card.key))
    const current = selectedRef.current
    const dropped = [...current].filter(key => disabled.has(key))
    if (dropped.length > 0 && cards.length > 0) {
      const next = new Set([...current].filter(key => !disabled.has(key)))
      onSelectionChange(next)
      message.warning(
        dropped.length === 1
          ? '1 method no longer fits these settings'
          : `${dropped.length} methods no longer fit these settings`,
      )
    }
    if (touched.current || seeded.current || cards.length === 0) return
    seeded.current = true
    onSelectionChange(new Set(recommendedSelection(cards)))
    // `cards` is the only trigger: the seed is one-shot per card set; a
    // content-identical rebuild (same inventory) does not re-seed because
    // the adapter keeps the last good cards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards])

  const changeSelection = useCallback(
    (next: ReadonlySet<string>): void => {
      touched.current = true
      onSelectionChange(next)
    },
    [onSelectionChange],
  )

  return (
    <TxrMethodPicker
      cards={cards}
      loading={loading}
      refreshing={loading}
      error={error}
      onRetry={refetch}
      selected={selected}
      onSelectionChange={changeSelection}
      onChangeFiles={onChangeFiles}
      onChangeSettings={onChangeSettings}
      layout={layout}
    />
  )
}

export function ChooseMethodsPage() {
  const navigate = useNavigate()
  const [changeOpen, setChangeOpen] = useState(false)
  const [settingsPatch, setSettingsPatch] = useState<Partial<RunSettings> | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const creating = useRef(false)
  const settingsAnchor = useRef<HTMLDivElement | null>(null)
  useDocumentTitle('Choose the methods and settings')
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

  const merged = useMemo(
    () => mergeRunSettings(runConfig.engine, parameters),
    [runConfig.engine, parameters],
  )
  const settings = settingsPatch === null ? merged : { ...merged, ...settingsPatch }
  const covariates = patients === null ? null : buildCovariates(patients.inspection)

  const change = (next: RunSettings): void => {
    setSettingsPatch(current => ({ ...(current ?? {}), ...diffPatch(next, settings) }))
    void runConfig.update(next)
  }

  // The retry-load transition (the engine's sticky fields land after an
  // edit): the write-through body is once more the screen's truth.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const engineBefore = useRef<typeof runConfig.engine>(runConfig.engine)
  useEffect(() => {
    const previous = engineBefore.current
    engineBefore.current = runConfig.engine
    if (settingsPatch === null) return
    if (previous !== runConfig.engine) {
      void runConfig.update({ ...merged, ...settingsPatch })
    }
  }, [runConfig.engine])

  const inventory = validation?.inventory ?? null
  // ITEM-2 (a): the ONE compact summary (the line + marker names + the
  // Details list) — the builder's facts are the store's own (DEC-13).
  const filesSummary = useMemo(
    () =>
      buildFilesSummary({
        mode,
        patients,
        measurements,
        predictMeasurements,
        validation,
      }),
    [mode, patients, measurements, predictMeasurements, validation],
  )
  // ITEM-2 (b): the eligibility request reflects the SETTINGS the screen
  // shows — the decision day and the extra-inputs switch are the two
  // settings the verdicts read (the wire's own fields), so a change here
  // changes the inventory's content key and the adapter refetches (the
  // visible re-check state) while the picker keeps the last cards.
  const settingsInventory = useMemo(
    () =>
      inventory === null
        ? null
        : {
            ...inventory,
            decision_day: settings.decision_day,
            covariates: settings.covariates ? inventory.covariates : [],
          },
    [inventory, settings.decision_day, settings.covariates],
  )
  const [cards, setCards] = useState<TxrMethodCard[]>([])
  const estimate = useListEstimate([...selected], {
    patients: inventory?.patients ?? 0,
    cpus: settings.cpus ?? undefined,
    atATime: settings.at_a_time,
  })

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
          const known = new Set(cards.map(card => card.id))
          const dropped = staleMethodIds(message, keys, [...known])
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
    [patients, measurements, predictMeasurements, joins, mapping, keepCopies, settings, cards, navigate],
  )

  const onChangeSettings = useCallback((): void => {
    settingsAnchor.current?.scrollIntoView({ block: 'start' })
  }, [])

  const missing = runSetupMissing({ mode, patients, measurements, predictMeasurements })
  if (missing !== null) {
    return (
      <main data-testid="txr-run" className="txr-run-page" style={PAGE_OUTER}>
        <PageFrame
          top={
            <div style={PAGE_TOP}>
              <div style={STEP_LINE}>Step 4 of 4</div>
              <h1 style={TITLE}>Choose the methods and settings</h1>
            </div>
          }
          body={
            <ScrollRegion label="Methods to choose">
              <div style={REGION_CONTENT}>
                <TxrRunEmptyState missing={missing} onStartNew={() => navigate('/')} />
              </div>
            </ScrollRegion>
          }
        />
      </main>
    )
  }

  /** The fixed top's page chrome (the picker's toolbar joins it when the
   *  picker is mounted — the toolbar state stays inside the picker). */
  const top = (toolbar: ReactNode | null): ReactNode => (
    <div className="txr-run-top" style={PAGE_TOP}>
      <div style={STEP_LINE}>Step 4 of 4</div>
      <h1 style={TITLE}>Choose the methods and settings</h1>
      <p data-testid="txr-run-intro" style={INTRO}>
        Run these methods on your patients. Checked against your files;
        each learns from your {inventory !== null ? inventory.patients : 0}{' '}
        patients, then predicts.
      </p>
      <TxrFilesSummary
        line={filesSummary.line}
        markerNames={filesSummary.markerNames}
        details={filesSummary.details}
        onChangeFiles={() => setChangeOpen(true)}
      />
      <div ref={settingsAnchor}>
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
      </div>
      {runError !== null ? (
        <Alert tone="error" data-testid="txr-run-create-error" title={runError} />
      ) : null}
      {runNotice !== null ? (
        <Alert tone="warning" data-testid="txr-run-create-notice" title={runNotice} />
      ) : null}
      {toolbar !== null ? (
        <div data-testid="txr-method-picker" style={PICKER_SPLIT}>
          {toolbar}
        </div>
      ) : null}
    </div>
  )

  /** The list region (the ONE scroll container of the page). */
  const body = (list: ReactNode): ReactNode => (
    <ScrollRegion label="Methods to choose" className="txr-run-methods-region">
      <div className="txr-run-methods-content" style={REGION_CONTENT}>{list}</div>
    </ScrollRegion>
  )

  const runBar =
    inventory !== null ? (
      <TxrRunBar
        selectedCount={countSelected(selected, cards)}
        timeText={formatRunBarTime(estimate.scheduleSeconds, settings.at_a_time, settings.cpus)}
        atATime={settings.at_a_time}
        saveModels={{
          checked: settings.save_models,
          onChange: value => change({ ...settings, save_models: value }),
        }}
        onRun={opts => {
          // The bar reports the OPTIONS; the keys are the selection minus
          // the cards this page can see are disabled (the rule set the
          // shared selection helpers compute on the D/I screens).
          const disabled = new Set(cards.filter(card => card.run.disabled).map(card => card.key))
          const keys = [...selected].filter(key => !disabled.has(key))
          void createRun(keys, opts)
        }}
      />
    ) : null

  if (settingsInventory === null) {
    return (
      <main data-testid="txr-run" className="txr-run-page" style={PAGE_OUTER}>
        <PageFrame
          top={top(null)}
          body={body(
            <div data-testid="txr-run-list-pending" style={PENDING_BLOCK}>
              <p style={PENDING_LINE}>{PENDING_REFRESH_LINE}</p>
            </div>,
          )}
          bottom={runBar}
        />
        <TxrChangeFilesDialog
          mode={mode}
          open={changeOpen}
          onOpenChange={setChangeOpen}
        />
      </main>
    )
  }

  return (
    <TxrMethodPickerFrame
      inventory={settingsInventory}
      selected={selected}
      onSelectionChange={setSelected}
      onCards={setCards}
      onChangeFiles={() => setChangeOpen(true)}
      onChangeSettings={onChangeSettings}
      layout={pickerParts => (
        <main data-testid="txr-run" className="txr-run-page" style={PAGE_OUTER}>
          <PageFrame
            top={top(pickerParts.toolbar)}
            body={body(pickerParts.list)}
            bottom={runBar}
          />
          <TxrChangeFilesDialog
            mode={mode}
            open={changeOpen}
            onOpenChange={setChangeOpen}
          />
        </main>
      )}
    />
  )
}
