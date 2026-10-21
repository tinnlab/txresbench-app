import { ApiClient } from '@/api-client'
import {
  type GraphDto,
  type ReadinessDto,
  type RunNodeDto,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { echoLocalSync } from '@/core/sync/localEcho'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const DEFAULT_PER_PAGE = 10

/**
 * The per-project reproducibility view (ITEM-28 / ITEM-15). Holds the paginated
 * run trust-view (`RunsPageDto`) + the backward-closure `GraphDto` (roots +
 * readiness) for the open project. Loaded on the panel's mount keyed on the project
 * id; reloaded on `sync:provenance` / `sync:reconnect` (self-gated on
 * `provenance::read` — no 403 on reconnect).
 */
const ProvenanceDef = defineStore('Provenance', {
  state: {
    projectId: null as string | null,
    /** The project id whose runs+graph are currently loaded (null = never loaded).
     *  Lets the panel's mount effect skip a redundant refetch when the store
     *  already holds this project's data (mirrors RecentProjects' `initialized`). */
    loadedProjectId: null as string | null,
    runs: [] as RunNodeDto[],
    total: 0,
    page: 1,
    perPage: DEFAULT_PER_PAGE,
    graph: null as GraphDto | null,
    readiness: null as ReadinessDto | null,
    loading: false,
    recording: false,
    /** A LOAD failure (runs / graph). Rendered by the pane as "the provenance
     *  graph could not be loaded". */
    error: null as string | null,
    /** A save-time CAPTURE failure — deliberately a SEPARATE slot from `error`.
     *  Sharing one slot made a failed `recordCapture` blank the lineage view
     *  under a false explanation ("the graph could not be loaded"), diagnosing
     *  the wrong subsystem for the user.
     *
     *  PER-PROJECT, like every other slot here: a project SWITCH clears it (F2-34).
     *  Without that, a capture failure in project A kept rendering its "the last
     *  committed selection was NOT recorded" banner over project B's graph — a
     *  false reproducibility claim, in the surface whose whole job is truthful
     *  reproducibility claims.
     *
     *  But ONLY a switch (R3-51). It is equally USER-OWNED state: it clears on a
     *  genuine project switch, on a successful capture, or on an explicit dismiss —
     *  never on a same-project refetch, whoever triggered it. `load()` used to clear
     *  it unconditionally while `init` wires `sync:provenance`/`sync:reconnect` →
     *  `reloadCurrent()` → `load(sameProjectId)`, so ANY background sync tick
     *  silently erased both the warning and its only remediation (the retained
     *  `lastCapture` that `retryCapture` re-posts), leaving an unqualified readiness
     *  badge over a run whose selection was never recorded. */
    captureError: null as string | null,
    /** The arguments of the LAST capture attempt, retained ONLY while a capture
     *  failure is outstanding so the failure banner's action can genuinely
     *  RE-RUN the capture ([`retryCapture`], F2-31) instead of merely dismissing
     *  itself. Cleared on success, on a dismiss, and on a project switch — and, like
     *  `captureError`, NOT by a same-project refetch (R3-51): dropping it would leave
     *  the banner's "Record it again" with nothing to re-post.
     *
     *  `actionType` is retained alongside the recipe because the retry must re-post
     *  the SAME action type: the action type selects the server's `emit_code` arm, so
     *  a retry that quietly picked a different one would record a run whose emitted
     *  script is not the script for the filter that ran — worse than not retrying. */
    lastCapture: null as
      | {
          projectId: string
          inputArtifactId: string
          actionType: string
          recipe: unknown
          label?: string
        }
      | null,
  },
  actions: (set, get) => {
    const loadRuns = async (projectId: string, page = 1) => {
      if (!hasPermissionNow(Permissions.ProvenanceRead)) return
      try {
        const res = await ApiClient.Provenance.runs({
          project_id: projectId,
          page,
          per_page: get().perPage,
        })
        // Defensive against a malformed/short response (e.g. an offline mock or
        // a partial backend error): never assign a non-array to `runs`, which
        // the run table + `runs[0]` reads would otherwise crash on.
        set({
          runs: Array.isArray(res?.runs) ? res.runs : [],
          total: typeof res?.total === 'number' ? res.total : 0,
          page: typeof res?.page === 'number' ? res.page : page,
          perPage: typeof res?.per_page === 'number' ? res.per_page : get().perPage,
        })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : 'Failed to load runs' })
      }
    }

    const loadGraph = async (projectId: string) => {
      if (!hasPermissionNow(Permissions.ProvenanceRead)) return
      try {
        const graph = await ApiClient.Provenance.graph({ project_id: projectId })
        // Only accept a well-formed `GraphDto` (a `roots` array); a malformed
        // response collapses to null so consumers render their empty state
        // rather than crashing on `graph.roots[0]`.
        const valid = graph && Array.isArray((graph as GraphDto).roots)
        set({
          graph: valid ? graph : null,
          readiness: valid ? (graph.readiness ?? null) : null,
        })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : 'Failed to load provenance graph' })
      }
    }

    /** Load runs (page 1) + graph for a project — the panel's mount entrypoint. */
    const load = async (projectId: string) => {
      if (!hasPermissionNow(Permissions.ProvenanceRead)) return
      // `captureError` + its retained attempt are PER-PROJECT facts, so a project
      // SWITCH drops them (F2-34) — a project-A capture failure must not accuse
      // project B's graph of holding an unrecorded run.
      //
      // A SAME-project load must NOT (R3-51). This entry is reached by the background
      // `sync:provenance` / `sync:reconnect` handlers (via `reloadCurrent`), by the
      // load-error "Try again", and by a pane remount — none of which is the user
      // acknowledging or retrying the capture failure. Clearing there erased the "the
      // last committed selection was NOT recorded" warning *and* the retained recipe
      // behind "Record it again", and the pane fell back to an unqualified readiness
      // badge: the user is told the run is reproducible when it is not. Only a switch,
      // a successful capture, or an explicit dismiss may clear this state.
      //
      // R4C-01 — "same project as WHAT?" must be answered by the project the CAPTURE was
      // for, NOT by the previously-loaded `state.projectId`. Keying on the latter still
      // broke the DOMINANT path: the save path (`provenance.record-selection` →
      // `recordCapture`) never loads the store and never sets `projectId`, so after a
      // capture failure `projectId` is still `null` until the user opens the pane — and
      // that FIRST load then read `null !== 'project-A'` as a project switch and
      // destroyed the exact banner (and the `lastCapture` behind "Record it again") the
      // user opened the pane to read. `lastCapture.projectId` is the only fact that can
      // decide whether the outstanding failure belongs to the project being loaded.
      // (`captureError` is only ever set alongside `lastCapture`, so the `?? projectId`
      // fallback is a defensive no-clear for the impossible orphan case.)
      const capturedFor = get().lastCapture?.projectId ?? projectId
      const captureIsForAnotherProject = capturedFor !== projectId
      set({
        projectId,
        loading: true,
        error: null,
        ...(captureIsForAnotherProject ? { captureError: null, lastCapture: null } : {}),
      })
      await Promise.all([loadRuns(projectId, 1), loadGraph(projectId)])
      // Mark this project as loaded only on a clean load, so a mount remount can
      // skip the refetch but a failed load still retries next mount.
      set({ loading: false, loadedProjectId: get().error ? get().loadedProjectId : projectId })
    }

    const setPage = async (page: number) => {
      const id = get().projectId
      if (!id) return
      await loadRuns(id, page)
    }

    const reloadCurrent = async () => {
      const id = get().projectId
      if (id) await load(id)
    }

    /**
     * ITEM-15 wiring: record an interaction recipe against an input artifact
     * (editors only). Posts an opaque recipe (never a materialized mask, DEC-7)
     * and refetches so the new run appears.
     *
     * The ACTION TYPE is an explicit parameter, not something derived from the
     * recipe's shape. It goes through `POST /provenance/actions`
     * (`recordAction`), the generic chokepoint that takes `action_type`
     * directly — NOT `POST /provenance/selections`, which hardcodes a
     * `selection.` prefix and can therefore only ever reach the `selection.*`
     * emitters. The caller knows which action it performed; the server's
     * `action_registry` rejects a non-dispatchable one.
     *
     * RESOLVES ⇒ recorded; THROWS ⇒ not recorded. There is deliberately no
     * boolean (F2-36): it once returned an unread `false`, and the caller's
     * leftover `if (!recorded) surfaceFailure(…)` guard sat INSIDE its own
     * try/catch, so a single failure toasted TWICE (the second message nesting
     * the first) — the exact duplicate-message defect `markSurfaced` exists to
     * prevent. A `Promise<void>` makes the outcome unignorable and leaves no
     * unreachable branch to trip over.
     */
    const recordCapture = async (
      projectId: string,
      inputArtifactId: string,
      actionType: string,
      recipe: unknown,
      label?: string,
    ): Promise<void> => {
      // Retain the attempt BEFORE posting so a failure leaves the banner with
      // something to genuinely re-run (F2-31) — including the action type, so the
      // retry re-posts the SAME action, not merely the same recipe.
      set({
        recording: true,
        captureError: null,
        lastCapture: { projectId, inputArtifactId, actionType, recipe, label },
      })
      try {
        const run = await ApiClient.Provenance.recordAction({
          project_id: projectId,
          action_type: actionType,
          input_artifact_id: inputArtifactId,
          recipe,
          label,
        })
        set({ recording: false, lastCapture: null })
        // `record_action` publishes Provenance/Create to the project audience WITH
        // `origin`, so this tab is skipped. Echoing it — rather than reloading inline —
        // is what lets EVERY `sync:provenance` subscriber (this store's graph, and any
        // other surface that lists runs) react to a local capture exactly as it reacts
        // to a collaborator's. The inline reload refreshed this store and nothing else.
        await echoLocalSync('provenance', 'create', run.run_id)
      } catch (e) {
        // Do NOT collapse to a falsy RESULT. This used to return a boolean nothing read,
        // so a committed filter whose provenance capture failed still ran the
        // caller's success toast — the user was told the save succeeded while the
        // recipe was silently lost, the exact defect this feature exists to
        // eliminate. The error is BOTH parked in `captureError` (for a surface
        // that wants to render it) and re-thrown, so a caller cannot ignore it by
        // omission.
        const message = e instanceof Error ? e.message : 'Failed to record selection'
        set({ recording: false, captureError: message })
        throw e instanceof Error ? e : new Error(message)
      }
    }

    /**
     * RE-RUN the last failed capture (F2-31) — the banner's "Record it again".
     *
     * The banner used to offer a kit `onRetry`, whose button reads "Try again",
     * wired to `clearCaptureError` — a pure dismiss. Clicking it read as a
     * successful retry while the run stayed unrecorded and irreproducible: a
     * false reproducibility signal in the reproducibility surface. It now
     * genuinely re-posts the retained recipe, and the banner clears ONLY on
     * success (`recordCapture` blanks `captureError` on entry and re-parks it
     * on a second failure). Resolves `false` rather than rejecting: it is wired
     * to a click handler, and `recordCapture` has already surfaced the reason.
     *
     * It re-posts the retained ACTION TYPE too — a retry is a retry of the same
     * action, not an opportunity to record a different one.
     */
    const retryCapture = async (): Promise<boolean> => {
      const attempt = get().lastCapture
      if (!attempt) return false
      try {
        await recordCapture(
          attempt.projectId,
          attempt.inputArtifactId,
          attempt.actionType,
          attempt.recipe,
          attempt.label,
        )
        return true
      } catch {
        return false
      }
    }

    /** DISMISS the capture-failure banner without re-attempting anything (the
     *  honest counterpart to [`retryCapture`]). Drops the retained attempt too —
     *  a dismissed failure has no pending retry. */
    const clearCaptureError = () => set({ captureError: null, lastCapture: null })

    return {
      load,
      loadRuns,
      loadGraph,
      setPage,
      reloadCurrent,
      recordCapture,
      retryCapture,
      clearCaptureError,
    }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProvenanceRead)) return
      void actions.reloadCurrent()
    }
    on('sync:provenance', reload)
    on('sync:reconnect', reload)
  },
})

export const useProvenanceStore = ProvenanceDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Provenance'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Provenance = registerLazyStore(ProvenanceDef)
