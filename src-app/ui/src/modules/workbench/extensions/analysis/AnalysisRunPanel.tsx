// AnalysisRunPanel — one analysis's params form + Run + LIVE run console + multi-output
// artifact. The config half is input-economy'd (ITEM-21): a sole compatible artifact
// auto-picks, an inputs→produces summary is shown, and Run is disabled-with-a-reason
// until required inputs are met (viewers never see Run). The run half is the CORE
// deliverable (ITEM-22/23): the REAL jobs SSE (`progress`/`log`/`metric`/`status`)
// drives a phase timeline + a live log console + a resource line + Stop, and on
// completion the run's outputs are reviewed DETERMINISTICALLY by `run_id` (ITEM-24 —
// no racy `pickNewest`). One implementation, two hosts (the bottom dock + the W2 run
// pane).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Tag } from '@txresbench/kit'
import { ApiClient } from '@/api-client'
import type { Artifact } from '@/api-client/types'
// The DECLARED axis names of an artifact's datatype (the same registry the workbench
// lattice adapts — `workbenchDataSource`'s `rowAxisFor` reads it exactly this way).
import { datatypeRegistry } from '@/core/datatypes'
import {
  analysisOwnsItsForm,
  artifactRefFields,
  ORIGIN_AUTO,
  ORIGIN_USER,
  pruneHiddenParams,
  resolveOrThrow,
  visibleFields,
  type AnalysisContribution,
  type BindingOrigin,
  type ParamsSchema,
  type WorkbenchAPI,
} from '@/modules/workbench/core'
import {
  DATA_CAPABILITY_ID,
  DATA_CAPABILITY_RANGE,
  type ArtifactRow,
  type DataApi,
} from '../data'
import {
  JOBS_CAPABILITY_ID,
  JOBS_CAPABILITY_RANGE,
  type JobsApi,
  type RunInput,
} from '../jobs/contract'
import { runAction } from '@/core/actions/defineAction'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { BINDING_ORIGIN_COPY, SchemaForm } from '@/modules/workbench/extensions/widgets/form/SchemaForm'
import { ArtifactReview } from '../jobs/ArtifactReview'
import { ArtifactPanel } from '../jobs/ArtifactPanel'
import { artifactDims } from '../jobs/runDiff'
import { RunProgressConsole, type ConsoleStatus } from './RunProgressConsole'
import {
  attachRunSession,
  beginRunSession,
  failRunSession,
  getRunSession,
  patchRunSession,
  reconcileRunSession,
  releaseRunSession,
  setRunSessionDeps,
  useRunSession,
  type RunSessionDeps,
} from './runSession'
import {
  autoPickSoleArtifacts,
  inputsSummary,
  producesSummary,
  runGate,
  selectionSubmitGate,
  fallbackParamsFor,
} from './inputEconomy'
import { ParamOutcomePreview } from './ParamOutcomePreview'
import { residentInputForSelection, type ResidentInput } from './paramPreview'
import { AnalysisVisualizations } from './AnalysisVisualizations'
import { AnalysisFlowGuidance } from './AnalysisFlowGuidance'
import { PaneScroll } from '@/modules/workbench/core/shell/dock/paneModel'
import { jobStopUnavailableReason } from '@/modules/jobs/stopAuthority'

/** Resolve the `data` capability out of the broker (ITEM-6) — the run panel is an
 *  ordinary consumer, routed by id like any third-party extension. */
function dataCapability(api: WorkbenchAPI): DataApi {
  return resolveOrThrow<DataApi>(api.capabilities, DATA_CAPABILITY_ID, DATA_CAPABILITY_RANGE)
}

// `RunState` is declared with the lifecycle that owns it. Re-exported here so the
// pre-existing importers of this module are unmoved.
export type { RunState } from './runSession'

/**
 * What this panel shows for an analysis that OWNS its form (`analysisOwnsItsForm`) — a
 * SIGNPOST, never a second form.
 *
 * The panel cannot synthesize a legitimate form for such an analysis: `fallbackParamsFor`
 * reads `appliesTo`, which is an applicability fact and not an input list, so the result
 * omits every input the view adds (see `core/contributions/ownForm.ts` for the shipped case
 * and for why a Run from here dispatches a different job than the one displayed).
 * Rendering nothing at all would be worse than the rival — an empty pane is unreadable — so
 * this states WHERE the analysis is configured, and offers to go there.
 *
 * The two states are distinguished because their remedies are: a REGISTERED view means "its
 * pane is one click away"; a view declared in `ui:` that failed to load means the analysis is
 * not runnable at all (registration is fail-closed at the analysis) and the package has to be
 * fixed. Offering "open its form" in the second case would point at a pane that does not
 * exist.
 */
function OwnFormNotice({
  analysis,
  viewTitle,
  onReveal,
}: {
  analysis: AnalysisContribution
  /** the REGISTERED pane's title, or `undefined` when `ui:` was declared but nothing registered. */
  viewTitle?: string
  /** reveal the analysis' own pane. Always supplied now — the launch verb is a read. */
  onReveal?: () => void
}) {
  const registered = viewTitle !== undefined
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 p-3"
      data-testid={`workbench-analysis-panel-${analysis.id}`}
    >
      <Alert
        tone={registered ? 'info' : 'warning'}
        data-testid={`workbench-analysis-own-form-${analysis.id}`}
        title={
          registered
            ? `${viewTitle} is configured in its own pane`
            : `${analysis.title} declares a form that could not be loaded`
        }
        description={
          registered
            ? 'This analysis ships its own form — every input it consumes is shown there, and it runs from there. There is nothing to run here.'
            : 'Its declared view file is missing or failed to parse, so the analysis cannot be run. The processor package has to be fixed (the loader logs the file and the reason).'
        }
      />
      {registered && onReveal && (
        <div className="flex items-center">
          <Button
            variant="outline"
            onClick={onReveal}
            data-testid={`workbench-analysis-reveal-own-form-${analysis.id}`}
          >
            Open {viewTitle}
          </Button>
        </div>
      )}
    </div>
  )
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Map each artifact-ref field's value → a compute RunInput mount (`{ slot, artifactId }`).
 *
 *  ITEM-14 — each input is STAMPED with how its slot was bound, read from the caller's
 *  per-slot `origins` map. Called without one (or for a slot the map does not mention)
 *  the input carries no origin at all, and the wire omits the key: absent is absent, and
 *  a run launched on an unknown-origin input must not claim a review happened (INV-4). */
export function buildInputs(
  analysis: AnalysisContribution,
  params: Record<string, unknown>,
  origins?: Record<string, BindingOrigin>,
): RunInput[] {
  const inputs: RunInput[] = []
  for (const field of artifactRefFields(fallbackParamsFor(analysis))) {
    const value = params[field.id]
    // The slot's origin, not the value's: a multi-value slot's entries were bound by one
    // gesture, so they carry one answer rather than a per-entry guess.
    const origin = origins?.[field.id]
    if (Array.isArray(value)) {
      for (const v of value)
        if (typeof v === 'string' && v) inputs.push({ slot: field.id, artifactId: v, ...(origin ? { origin } : {}) })
    } else if (typeof value === 'string' && value) {
      inputs.push({ slot: field.id, artifactId: value, ...(origin ? { origin } : {}) })
    }
  }
  return inputs
}

/**
 * The fields an incoming form bag CHANGED, relative to the one it replaces (ITEM-14).
 *
 * `edited` is the field the control itself named, and it is included unconditionally:
 * re-picking the value already in a slot IS the review an auto-bind was waiting for
 * (INV-5), and by definition no diff can see it. The diff is still computed on top,
 * because a single `onChange` may carry more than the touched field (a dependent picker
 * clears a now-invalid sibling in the same write), and assuming otherwise would leave
 * those siblings marked with the origin of a value that is gone.
 */
export function changedFields(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  edited?: string,
): string[] {
  const changed = new Set<string>(edited ? [edited] : [])
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (!Object.is(prev[key], next[key])) changed.add(key)
  }
  return [...changed]
}

// `pickNewest` / `upsertPhase` now live with the lifecycle that reduces them
// (`runSession.ts` / `runPhases.ts`) — they run with nothing mounted, so they could not
// stay in a component module the session imports. Re-exported here so every existing
// importer (and `extensions/analysis/index.ts`) is unmoved.
export { upsertPhase } from './runPhases'
export { pickNewest } from './runSession'

// A monotonic id for the INSTANCE-scoped session key a host without a `sessionKey` gets.
// Never collides with a pane id (which is what a real host passes), so an unkeyed preview
// can never share a session with a pane.
let instanceCounter = 0
function nextInstanceId(): number {
  instanceCounter += 1
  return instanceCounter
}

export function AnalysisRunPanel({
  analysis,
  initialParams,
  initialParamOrigins,
  onParamsChange,
  onArtifact,
  onRunComplete,
  sessionKey,
}: {
  analysis: AnalysisContribution
  initialParams?: Record<string, unknown>
  /** The origins restored alongside {@link initialParams}. Absent ⇒ nothing is claimed about
   *  how the restored values were chosen, which is the honest answer for a host that does not
   *  persist them (INV-4: absence is never `user`). */
  initialParamOrigins?: Record<string, BindingOrigin>
  /** Called on every params edit — the run PANE persists it to `paneState` (keyed by pane id) so
   *  the entered config survives a pop-out / return (ITEM-19). */
  /** Persist the panel's config. Receives the values AND how each was chosen — a host that
   *  keeps one without the other restores a binding that has quietly lost its origin. */
  onParamsChange?: (params: Record<string, unknown>, origins: Record<string, BindingOrigin>) => void
  /** Called with the produced artifact id when a run completes (null on error/stop) — the run PANE
   *  binds itself to that artifact so it self-closes if the artifact is deleted (ITEM-19). */
  onArtifact?: (artifactId: string | null) => void
  /** Called with the resolved RUN id when a run completes deterministically (ITEM-63) — the
   *  re-run pane pairs it with the source run for the before/after diff. */
  onRunComplete?: (runId: string) => void
  /**
   * The DURABLE identity of this panel's run — a pane host passes its PANE ID.
   *
   * The run lifecycle (state + the live SSE subscription) is keyed by this in
   * `runSession.ts` rather than held in `useState`, because a region renders only its
   * ACTIVE tab: a tab switch unmounts this component, and the run has to outlive that.
   * Same key discipline as `paneState` — stable across a move / pop-out / return, and
   * released when the pane CLOSES.
   *
   * A host with no durable identity (a preview, a test render) may omit it: the panel
   * falls back to a per-instance key and releases it on unmount, which is exactly the
   * pre-existing behaviour and is correct for a surface that has no life beyond its
   * render.
   */
  sessionKey?: string
}) {
  const { api, projectId, canEdit, refreshCatalog, producedTypeIds, lattice, viewId } = useWorkbench()
  const [params, setRawParams] = useState<Record<string, unknown>>(() => ({
    ...{},
    ...initialParams,
  }))
  // HOW each param was bound, keyed by field id (ITEM-14) — the SIDECAR to `params`,
  // never a wrapper around the values (DEC-2). Written in the SAME statement as the
  // values it describes, through `setParams`, so the two cannot desynchronize.
  const [paramOrigins, setRawParamOrigins] = useState<Record<string, BindingOrigin>>(
    initialParamOrigins ?? {},
  )
  // Latest params for one-shot async effects (ITEM-64) that must merge onto the freshest
  // value (e.g. after the auto-pick patch lands) without re-subscribing.
  const paramsRef = useRef(params)
  // The SAME ref discipline for the origins (ITEM-14). Not optional: the auto-pick effect
  // below deliberately merges its patch onto `paramsRef.current` rather than onto its
  // mount-captured closure, so an origin map read from a stale closure would describe a
  // params object that no longer exists — the stale-snapshot class this repo has already
  // paid for. Both refs are written inside `setParams`, in the same statement, so a later
  // reader of either sees the pair as it was written.
  const paramOriginsRef = useRef(paramOrigins)
  const setParams = (next: Record<string, unknown>, origins?: Record<string, BindingOrigin>) => {
    paramsRef.current = next
    if (origins) {
      const merged = { ...paramOriginsRef.current, ...origins }
      paramOriginsRef.current = merged
      setRawParamOrigins(merged)
    }
    setRawParams(next)
    // The values and their origins are handed UP in one call, for the same reason they are
    // written in one statement below: a host that persists the params and drops the origins
    // restores a binding whose mark has vanished while the value survived — the value is
    // still one nobody reviewed, and the control would render it as a chosen one (INV-2).
    // Observed exactly that way: a region renders only its ACTIVE tab, so a tab switch
    // remounts this panel, `autoPickSoleArtifacts` skips the already-set slot, and nothing
    // re-stamps.
    onParamsChange?.(next, paramOriginsRef.current)
  }
  paramsRef.current = params
  paramOriginsRef.current = paramOrigins
  // ── the RUN LIFECYCLE — held by `runSession`, NOT by this component ────────────────
  //
  // Ten `useState`s stood here (runState / phases / logs / metric / jobId / runId /
  // fallbackArtifactId / producedArtifactId / error / stopping) alongside a `subRef`
  // disposed on unmount by an effect that never re-subscribed. A region renders only its
  // ACTIVE tab, so a tab switch DESTROYED all of it and killed the progress stream: the
  // run carried on server-side and the pane came back reading `idle`. React state is the
  // wrong home for something that has to outlive the render — see `runSession.ts` for
  // why the state moved rather than the subscription merely being re-established.
  //
  // The instance fallback key keeps a host with no durable identity (a preview, a test
  // render) behaving exactly as before: its session is released on unmount.
  const instanceKeyRef = useRef<string | null>(null)
  if (!instanceKeyRef.current) instanceKeyRef.current = `analysis-run-instance:${nextInstanceId()}`
  const runKey = sessionKey ?? instanceKeyRef.current
  const {
    runState,
    phases,
    logs,
    metric,
    jobId,
    runId,
    fallbackArtifactId,
    producedArtifactId,
    error,
    stopping,
  } = useRunSession(runKey)
  // WHO MAY STOP THIS RUN — read from the server, never re-derived here.
  //
  // Stop used to be gated on `canEdit && runState === 'running'`: the per-project EDIT role
  // standing in for the stop right. They are different rights with different answers — the
  // server allows the run's CREATOR, the OWNER of the dataset/project it is scoped to, or an
  // admin, and refuses a third-party editor with a 403 — so the role both offered a Stop that
  // would be refused and hid one that would have been allowed. Copying the real rule here would
  // just be the same defect spelled correctly for a while, so nothing is derived: the panel
  // holds a job ID, and `GET /api/jobs/{id}` states `can_stop` for exactly this case (a surface
  // that opened a job directly rather than through a list row).
  //
  // Asked ONCE, when the id lands. It is not a poll: a fourth interval against /api/jobs would
  // be a real cost for a fact that does not change over a run. Until the answer arrives the
  // reason is absent — the control is available and the server remains the boundary — because
  // "not asked yet" is not "you are refused", and saying otherwise would be a guess in the
  // other direction. The answer is keyed by job id so a re-run cannot render the PREVIOUS run's
  // verdict against the new one.
  const [stopAuthority, setStopAuthority] = useState<{ jobId: string; canStop: boolean } | null>(null)
  useEffect(() => {
    if (!jobId) {
      setStopAuthority(null)
      return
    }
    let cancelled = false
    void ApiClient.Jobs.get({ id: jobId })
      .then(d => {
        if (!cancelled) setStopAuthority({ jobId, canStop: d.can_stop })
      })
      .catch(() => {
        /* unknown: leave the control available and let the server answer on the click */
      })
    return () => {
      cancelled = true
    }
  }, [jobId])
  const stopRefusal =
    stopAuthority && stopAuthority.jobId === jobId
      ? jobStopUnavailableReason(stopAuthority.canStop)
      : undefined
  /**
   * A form edit (ITEM-14 / INV-5) — "a user write resolves the origin to `user`, whatever
   * it was before". Re-picking an auto-bound input IS the review, so the field the control
   * named resolves to `user` even when the value it lands on is the one already there.
   */
  const onFormEdit = (next: Record<string, unknown>, edited?: { fieldId: string }) => {
    const origins: Record<string, BindingOrigin> = {}
    for (const id of changedFields(paramsRef.current, next, edited?.fieldId)) origins[id] = ORIGIN_USER
    setParams(next, origins)
  }

  const artifactKind = analysis.produces[0]

  // ── the session's view of THIS host ────────────────────────────────────────────────
  //
  // Re-supplied on every render, so a completion that lands after a remount calls the
  // CURRENT host's `onArtifact`/`onRunComplete` and refreshes the CURRENT catalog rather
  // than a dead render's. Everything here is a thin wrapper over an ApiClient call; the
  // lifecycle itself is in `runSession.ts` and never sees the ApiClient.
  const deps = useMemo<RunSessionDeps>(
    () => ({
      getJob: async (id: string) => {
        const d = await ApiClient.Jobs.get({ id })
        return { id: d.job.id, run_id: d.job.run_id ?? null, status: d.job.status }
      },
      getLogs: async (id: string) => {
        const page = await ApiClient.Jobs.logs({ id })
        return page.logs.map(l => ({ seq: l.seq, stream: l.stream, content: l.content }))
      },
      queryArtifacts: (kind: string) => dataCapability(api).artifacts.query({ type: kind }),
      artifactKind,
      refreshCatalog,
      notify: (message, tone) => api.ui.notify(message, tone),
      onArtifact,
      onRunComplete,
    }),
    [api, artifactKind, refreshCatalog, onArtifact, onRunComplete],
  )
  const depsRef = useRef(deps)
  depsRef.current = deps
  // In an EFFECT, not in render: this writes to a module-level map, and a render-phase
  // write is not safe to repeat under concurrent rendering. Nothing reads the stored deps
  // before it runs — `beginRunSession` and `reconcileRunSession` both pass theirs
  // explicitly, and a frame can only arrive after a launch.
  useEffect(() => {
    setRunSessionDeps(runKey, deps)
  }, [runKey, deps])

  // MOUNT: reconcile a session that still claims `running`.
  //
  // The subscription survived the unmount, so the ordinary "it finished while you were on
  // another tab" case is already settled by the time this fires — the session shows `done`
  // and this returns immediately. What it catches is the stream that DIED silently (an
  // aborted SSE, a dropped connection): without it, a pane could come back rendering a
  // spinner over a job that ended long ago. A single read, never a poll.
  useEffect(() => {
    void reconcileRunSession(runKey, depsRef.current)
  }, [runKey])

  // A host that supplied no `sessionKey` has no life beyond this render, so its session is
  // released here. A KEYED session deliberately is NOT — releasing on unmount is the whole
  // defect. Its owner (the pane) releases it on CLOSE, via `clearPaneState`.
  useEffect(() => {
    if (sessionKey) return
    const own = runKey
    return () => releaseRunSession(own)
  }, [runKey, sessionKey])

  // The compatible artifact rows per single-value artifact-ref field (resolved once) —
  // reused both for auto-pick AND to read the SELECTED input's resident axis lengths for
  // the param→outcome preview (ITEM-65, cap estimates against the DECLARED axes).
  const [residentByField, setResidentByField] = useState<Record<string, ArtifactRow[]>>({})

  // Input economy (ITEM-21): auto-pick the SOLE compatible artifact for each unset
  // single-value artifact-ref field, using the SAME project-scoped, type-filtered
  // query the picker uses. Runs once per analysis (never clobbers a user choice).
  const autoPickedRef = useRef(false)
  useEffect(() => {
    if (autoPickedRef.current) return
    // An analysis that owns its form renders no form here (see the early return below), so
    // there is nothing to auto-pick INTO — skip the catalog queries rather than resolving
    // candidates for controls that will never be painted.
    if (analysisOwnsItsForm(analysis)) {
      autoPickedRef.current = true
      return
    }
    const fields = artifactRefFields(fallbackParamsFor(analysis)).filter(f => !f.multiple)
    if (fields.length === 0) {
      autoPickedRef.current = true
      return
    }
    let cancelled = false
    void Promise.all(
      fields.map(
        async f =>
          [f.id, await dataCapability(api).artifacts.query(f.accepts).catch(() => [])] as const,
      ),
    ).then(entries => {
      if (cancelled) return
      autoPickedRef.current = true
      const byField: Record<string, ArtifactRow[]> = {}
      for (const [id, rows] of entries) byField[id] = rows
      setResidentByField(byField)
      // Compute + merge the patch against the FRESHEST params (`paramsRef.current`), NOT
      // the stale mount-captured `params` closure (this effect's deps are [analysis, api]).
      // Mirrors the ITEM-64 effect below — so a late-resolving artifact query never
      // clobbers a concurrently-applied data-driven default or a user edit made while the
      // query was in flight (and an already-chosen field is detected from the live value).
      const { patch, autoBound } = autoPickSoleArtifacts(analysis, paramsRef.current, byField)
      // ITEM-14 — record `'auto'` for exactly the slots the pick REPORTS it bound, in the
      // same write as the values (INV-1). The set is taken from the pick rather than
      // re-derived from the patch here: a second reading of the pick's rules is a second
      // implementation of them, and the two would only have to disagree once.
      if (Object.keys(patch).length > 0) {
        const origins: Record<string, BindingOrigin> = {}
        for (const slot of autoBound) origins[slot] = ORIGIN_AUTO
        setParams({ ...paramsRef.current, ...patch }, origins)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, api])

  // ITEM-64's data-driven-default effect stood here. It summarized the selected input's
  // declared columns and prefilled any number field carrying a `defaultResolver` — but a
  // resolver was a JS function on a form field, unrepresentable in a manifest's YAML, and
  // it left `AnalysisContribution` with the rest of the form schema (INV-1). Its two
  // helpers were left returning empty for every input, so this effect resolved zero column
  // refs, short-circuited, and fetched nothing on every mount of every analysis. Removed
  // with them: a view that wants a data-driven starting value computes it in its own
  // `derived` block, where the data it derives from is in scope.

  // The resident input axis lengths for the CURRENTLY-selected single-value artifact-ref
  // inputs — the cheap, real basis for a cap-style param's live estimate. Keyed by the axis
  // LABEL the artifact's datatype DECLARES at that position (E1/E5): an `ArrayDecl` binds an
  // OPEN set of dims, so no dim POSITION carries a fixed meaning the app is entitled to name
  // — a `(region, channel)` image and a `(comparison, target)` table each name their own. A
  // position whose datatype declares no axis contributes nothing (the preview DEFERS rather
  // than guessing), and the key matches a field's declared `capsAxis`, which a positional key
  // never could.
  //
  // INV-3 — the derivation itself is `residentInputForSelection`, which refuses a label two
  // inputs disagree about instead of `Math.max`-ing their lengths into a cardinality
  // belonging to neither axis. The panel supplies the two lookups and nothing else, so the
  // fold is under test at the site that performs it; see that function for why length
  // disagreement is the identity signal available here.
  const residentInput = useMemo<ResidentInput>(
    () =>
      residentInputForSelection<ArtifactRow>({
        fields: artifactRefFields(fallbackParamsFor(analysis)).filter(fld => !fld.multiple),
        params,
        rowsByField: residentByField,
        axesOf: datatype => datatypeRegistry.get(datatype)?.axes ?? [],
        dimsOf: artifactDims,
      }),
    [analysis, params, residentByField],
  )

  // ITEM-36 conditional-schema seam (cross-round W3↔W5 integration): the SAME gating
  // context `SchemaForm` renders visibility with, so the host prunes hidden-field values
  // on submit (no stale-value leak) and gates Run on VISIBLE required inputs only. A flat,
  // non-conditional schema keeps its exact prior behavior (`visibleIds` = all fields).
  const gating = useMemo(() => ({ producedTypeIds }), [producedTypeIds])
  const visibleFieldList = useMemo(
    () => visibleFields(fallbackParamsFor(analysis), params, gating, lattice),
    [fallbackParamsFor(analysis), params, gating, lattice],
  )
  const visibleIds = new Set(visibleFieldList.map(f => f.id))
  const isVisibleField = (id: string) => visibleIds.has(id)

  // `submit` runs an ALREADY-FINAL params object (hidden fields pruned) — `run()` below
  // is the one caller and prunes first. It stays a separate function because it is the
  // single place a run is dispatched from.
  //
  // The lifecycle it drives (the frame reducer, the terminal transition, the run-id
  // resolution) is `runSession`'s, not this component's — see the note on the session
  // read above. `beginRunSession` also clears the PRIOR run's job id before the
  // `jobs.run` await lands the new one, so `stop()` is a no-op rather than aimed at the
  // previous run during that window.
  const submit = async (submitted: Record<string, unknown>) => {
    beginRunSession(runKey, deps)
    try {
      // The ORIGINS as of this launch (the ref, not the render-time state): `submit` is
      // async and the values it was handed came from `paramsRef` too, so the pair stays
      // the pair. ITEM-10 carries them onto the wire as `bound_by`.
      const inputs = buildInputs(analysis, submitted, paramOriginsRef.current)
      const jobs = resolveOrThrow<JobsApi>(api.capabilities, JOBS_CAPABILITY_ID, JOBS_CAPABILITY_RANGE)
      const handle = await jobs.run(analysis.run, inputs, submitted, {
        schedule: analysis.schedule,
        name: analysis.title,
        analysisId: analysis.id,
      })
      // The session takes ownership of the stream here. It is NOT disposed on unmount —
      // that was the defect — only on the pane's close.
      attachRunSession(runKey, handle.jobId, handle)
    } catch (err) {
      failRunSession(runKey, errMessage(err))
      api.ui.notify(errMessage(err), 'error')
    }
  }

  // The Run button: prune hidden-field values (ITEM-36) then submit. This is the ONLY
  // run trigger on the surface — the wizard's last-step Run was deleted with the stepped
  // form (see the removal note in `widgets/form/SchemaForm.tsx`), so this button is no
  // longer conditional on the schema shape.
  const run = () => submit(pruneHiddenParams(fallbackParamsFor(analysis), params, gating, lattice))

  const stop = async () => {
    const jid = getRunSession(runKey).jobId
    if (!jid) return
    patchRunSession(runKey, { stopping: true })
    try {
      await ApiClient.Jobs.stop({ id: jid })
      api.ui.notify('Run stopped', 'info')
    } catch (err) {
      api.ui.notify(errMessage(err), 'error')
    } finally {
      // Cleared here for the FAILED stop; a stop the server honours arrives as a terminal
      // frame, and `finishTerminal` clears it there too (the session may well be unmounted
      // by then, which is precisely why the flag lives in the session).
      patchRunSession(runKey, { stopping: false })
    }
  }

  // The run gate = required-inputs (ITEM-21) THEN the live widget validity (ITEM-52): a
  // widget that owns its own live validation embeds its verdict in its value, so an invalid
  // selection disables Run with the widget's reason — no recomputation in the panel. (No
  // shipping widget emits a gate since ITEM-39; see the note on `selectionSubmitGate`.)
  const baseGate = runGate(analysis, params, isVisibleField)
  const gate = baseGate.disabled ? baseGate : selectionSubmitGate(params, isVisibleField)
  const produces = producesSummary(analysis)
  const inputs = inputsSummary(analysis, params, paramOrigins)
  const consoleStatus: ConsoleStatus =
    runState === 'error' ? 'error' : runState === 'stopped' ? 'stopped' : runState === 'done' ? 'done' : 'running'

  // ── INV-4 gate: an analysis that OWNS its form gets no rival one here ────────────────
  //
  // Placed AFTER every hook (React's rules), and at the CONSTRUCTION site rather than at any
  // one caller, because this panel has four hosts — the `run` pane (`analysis.launch`, ⌘K,
  // chaining/flow guidance, the AI, `window.__workbenchPanes.open('run', …)`, a persisted
  // layout), the `rerun` pane, and the mobile analyses dock. Gating a single entry point
  // would leave the others open, and a re-run in particular reached this panel with only the
  // source run's PARAMS (`reseedFromRun` recovers no inputs), so it re-ran a view-backed
  // analysis with the view's own inputs silently dropped.
  //
  // `analysis.launch` additionally ROUTES such an analysis to its own pane
  // (`WorkbenchSection.tsx`) so a launcher click still lands on a working form in one step —
  // this branch is what covers every other door.
  //
  // The reveal affordance goes through the ONE `analysis.launch` action every other
  // affordance uses (Launcher row, ⌘K, chaining, the AI) rather than poking the dock
  // directly — that action is what knows an analysis owns its form, so this button and a
  // launcher click land in exactly the same place. It is NOT `canEdit`-gated: the verb is a
  // READ (`analysis.launch`, `mutating: false` + `ProjectsUse`) and this notice's entire job is
  // to say WHERE the form is, so withholding the one affordance that goes there left a viewer
  // reading a signpost with the road removed.
  if (analysisOwnsItsForm(analysis)) {
    return (
      <OwnFormNotice
        analysis={analysis}
        viewTitle={api.registry.views.get(analysis.id)?.title}
        onReveal={() => {
          void runAction('analysis.launch', { view_id: viewId, analysis_id: analysis.id }).catch(err =>
            api.ui.notify(errMessage(err), 'error'),
          )
        }}
      />
    )
  }

  return (
    <PaneScroll className="min-h-0 flex-1" data-testid={`workbench-analysis-panel-${analysis.id}`}>
      <div className="flex flex-col gap-3">
        {analysis.description && <p className="text-sm text-muted-foreground">{analysis.description}</p>}

        <SchemaForm
          params={fallbackParamsFor(analysis)}
          value={params}
          onChange={onFormEdit}
          origins={paramOrigins}
          data-testid={`workbench-analysis-form-${analysis.id}`}
        />

        {/* Inputs → produces summary (ITEM-21). */}
        {(inputs.length > 0 || produces.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid={`workbench-analysis-io-${analysis.id}`}>
            {inputs.map(i => (
              <Tag
                key={i.field}
                tone={i.artifactId ? 'info' : 'default'}
                variant="soft"
                data-binding-origin={i.origin}
                data-testid={`workbench-analysis-input-${analysis.id}-${i.field}`}
              >
                {i.label}
                {i.artifactId ? '' : ' (unset)'}
                {/* ITEM-16 / R8 — the SECOND surface. The control's own mark is gone the
                    moment the reader looks away from it; this line is what the reader is
                    looking at when they decide to press Run. Visible text, never a
                    tooltip. An input with no recorded origin says nothing (INV-4). */}
                {i.origin === ORIGIN_AUTO ? ` — ${BINDING_ORIGIN_COPY.autoBoundSummary}` : ''}
              </Tag>
            ))}
            {produces.length > 0 && <span aria-hidden>→ produces</span>}
            {produces.map(p => (
              <Tag key={p} tone="success" variant="soft" data-testid={`workbench-analysis-produces-${analysis.id}-${p}`}>
                {p}
              </Tag>
            ))}
          </div>
        )}

        {/* Advertised visualizations (ITEM-17) — list-and-explain: an embedding scatter is
            listed "needs an embedding" when the input carries none, never silently absent. */}
        <AnalysisVisualizations analysis={analysis} lattice={lattice} data-testid={`workbench-analysis-viz-${analysis.id}`} />

        {/* Param→outcome LIVE preview (ITEM-65) — honest cap estimates + "computes on run"
            deferrals, while configuring (hidden during/after a run to keep the console clean). */}
        {(runState === 'idle' || runState === 'error') && (
          <ParamOutcomePreview
            fields={visibleFieldList}
            params={params}
            resident={residentInput}
            data-testid={`workbench-param-preview-${analysis.id}`}
          />
        )}

        {/* The ONE run trigger (the form renders controls only); viewers see the read-only note. */}
        <div className="flex items-center gap-3">
            {canEdit ? (
              <Button
                variant="default"
                loading={runState === 'running'}
                disabled={runState === 'running'}
                // `gate.reason` was a `tooltip` on a natively `disabled` button, so it could
                // never open. Unlike the other sites in this class, almost nothing was LOST by
                // that — the same sentence is rendered as permanent visible text beside this
                // button (below), which beats hover-only. What was lost is the KEYBOARD user: a
                // disabled button is not a tab stop, so tabbing out of the form skipped Run
                // entirely rather than landing on it and hearing why it will not fire.
                // `unavailableReason` restores that, from the SAME `gate.reason` string, so the
                // two channels cannot disagree.
                unavailableReason={gate.disabled ? gate.reason : undefined}
                aria-label="Run"
                onClick={() => void run()}
                data-testid={`workbench-analysis-run-${analysis.id}`}
              >
                Run
              </Button>
            ) : (
              <span className="text-sm text-muted-foreground">Read-only — viewers cannot run analyses.</span>
            )}
        </div>

        {/* VISIBLE, permanently — discovery beats hover. `aria-hidden` because the very same
            string is already wired into the refusing control's `aria-describedby` by
            `unavailableReason`; without this a screen-reader user hears the reason twice, once
            attached to the control and once loose in the flow.

            It is a SIBLING of the Run button, not a child of any conditional around it. It used
            to live inside a `(!stepped || !canEdit)` block whose job was to hide the external Run
            on a stepped form — and it took the reason down with it, so the one surface where the
            refusal was hardest to work out was the one that explained it least. The stepped form
            is gone and that block with it; the reason stays hoisted, because the coupling that
            made it disappear was never something the wizard alone could cause. */}
        {canEdit && gate.disabled && (
          <span
            aria-hidden
            className="text-xs text-muted-foreground"
            data-testid={`workbench-analysis-run-reason-${analysis.id}`}
          >
            {gate.reason}
          </span>
        )}

        {/* Live run console — phase timeline + logs + metric + Stop (ITEM-22/23). */}
        {(runState === 'running' || runState === 'error' || runState === 'stopped' || (runState === 'done' && phases.length > 0)) && (
          <RunProgressConsole
            status={consoleStatus}
            phases={phases}
            logs={logs}
            metric={metric}
            error={error}
            // Status only — whether there is anything to stop. The authority is the
            // server's `can_stop`, below.
            canStop={runState === 'running'}
            stopUnavailableReason={stopRefusal}
            stopping={stopping}
            onStop={() => void stop()}
            analysisId={analysis.id}
          />
        )}

        {/* Artifact review (ITEM-24/25/27) — multi-output by run_id; the fallback path
            renders the single artifact resolved via the host facade. */}
        {runState === 'done' && runId && (
          <ArtifactReview
            runId={runId}
            producedByAnalysisId={analysis.id}
            methodsText={analysis.methodsText?.(params)}
            onArtifactsLoaded={(artifacts: Artifact[]) => {
              patchRunSession(runKey, { producedArtifactId: artifacts[0]?.id ?? null })
              onArtifact?.(artifacts[0]?.id ?? null)
            }}
          />
        )}
        {runState === 'done' && !runId && fallbackArtifactId && artifactKind && (
          <ArtifactPanel artifactKind={artifactKind} artifactId={fallbackArtifactId} />
        )}

        {/* Self-explaining pipeline (ITEM-35): on completion, state what it produced + the
            DERIVED next-step launch actions (analyses that consume this output). */}
        {runState === 'done' && (
          <AnalysisFlowGuidance
            analysisId={analysis.id}
            artifactId={producedArtifactId ?? fallbackArtifactId ?? undefined}
            data-testid={`workbench-flow-guidance-${analysis.id}`}
          />
        )}
      </div>
    </PaneScroll>
  )
}
