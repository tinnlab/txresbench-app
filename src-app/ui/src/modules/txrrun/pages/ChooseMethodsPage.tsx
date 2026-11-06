import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { Alert, Button, Skeleton } from '@ziee/kit'
import { buildSlotSummaries, runSetupMissing } from '../lib/slotSummary'
import { mergeRunSettings, type RunSettings } from '../lib/settings'
import { buildCovariates } from '../lib/covariates'
import { useRunConfig } from '../data/useRunConfig'
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
 * ITEM-6 delivers the page BASE: the board's page chrome (from ITEM-1),
 * the slot summary (the data line + the change-files dialog, DEC-9/13) and
 * the not-configured state (DEC-16). ITEM-7 adds the settings card: the
 * DEC-6 mount merge (the intake's CURRENT decision day first, the engine's
 * sticky config for the rest, then the engine defaults) composed from the
 * hook's RAW `engine` + the intake parameters (DRIFT-1 ITEM-4 #1), the
 * write-through of every row change to the sticky store
 * (`useRunConfig().update`, CONS-UI-RUN-6) and the Extra-inputs names line
 * from the patients file's inspection `covariate_columns` (PROV-FV-2).
 * The shared list + run creation (ITEM-8) extend this same file below the
 * settings; the page reads the intake store (the ONE snapshot the later
 * screens read, PROV-UI-INTAKE-2) and navigates only through the module's
 * path builders (never a URL literal).
 *
 * The empty state's rule: the E content renders when the run's mode has
 * its inputs (the two train files, or the one predict file); anything
 * partial shows the state naming the missing piece. The slot lines render
 * the store's own facts (the file names + the ONE validated summary) —
 * this page never re-validates and never formats a number.
 *
 * The settings write-through rule (ITEM-7): the screen's value is the
 * merged view plus the user's own edits (the diff-patch below). The merge
 * re-composes when the engine answers (the mount GET, a retry GET) — the
 * sticky fields the user has NOT touched follow the engine's config
 * (restoring it from a transient load failure never reverts an edit the
 * user made against the not-yet-loaded defaults, and a user change never
 * clobbers a sticky field it did not change). While the FIRST load is in
 * flight the card shows the skin (a flash of defaults before the sticky
 * values would be a wrong screen); a failed load renders the merged
 * defaults with the error line + retry — the four rows stay usable, the
 * sticky store being behind the screen never blocks configuration.
 */
const PAGE_OUTER: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
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

/** The board's settings-card skeleton (the card's place while the first
 *  sticky-config GET is in flight — a defaults flash would mislead). */
const SETTINGS_SKELETON: CSSProperties = {
  height: 72,
  borderRadius: 10,
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

export function ChooseMethodsPage() {
  const navigate = useNavigate()
  const [changeOpen, setChangeOpen] = useState(false)
  const [settingsPatch, setSettingsPatch] = useState<Partial<RunSettings> | null>(null)
  const mode = useStore(useTxrIntakeStore, s => s.mode)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const runConfig = useRunConfig()

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
      </div>
      <TxrChangeFilesDialog
        mode={mode}
        open={changeOpen}
        onOpenChange={setChangeOpen}
      />
    </main>
  )
}
