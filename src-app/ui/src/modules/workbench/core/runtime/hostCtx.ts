// The declarative HOST ctx (declarative-processor-ui Slice 3 / ITEM-10). A declared
// action's `body` interprets over an `InterpreterCtx` (`interpreter.ts`) whose effectful
// ops — `run_processor` / `wait_for` / `toast` — need REAL workbench capabilities wired.
// `WidgetHost.dispatch` previously called `runAction(id, params)` with NO ctx, so a
// default `ActionContext` (no `runProcessor`/`waitFor`) reached the interpreter and any
// `run_processor` threw "not wired". This factory builds the ctx that bridges a declared
// action into the REAL run/job pipeline:
//
//   • `run_processor(id, params)` → resolve the analysis from the shared
//     `registry.analyses`, auto-resolve its artifact-ref inputs from the catalog, and
//     submit through the `jobs` capability's `run` (the SAME `POST /api/jobs` path the run
//     pane uses,
//     so a declared Run is a provenance node by construction). Returns the `JobHandle`.
//   • `wait_for(job, until)` → await the handle's job stream reaching a terminal frame.
//   • `toast(msg)` → the host `ui.notify` surface.
//
// The ctx extends the REAL `defineAction` `ActionContext` (createActionContext), so a
// declared action is co-drivable + permission-gated identically for a human click and the
// AI agent (§10/§11). Pure factory (no React) so it is directly unit-testable with a fake
// `WorkbenchAPI`.

import { createActionContext } from '@/core/actions/ctx'
import { resolveOrThrow, type WorkbenchAPI, type AnalysisContribution } from '@/modules/workbench/core'
// The capability CONTRACTS are TYPE-ONLY imports (erased at build), and the ids are plain
// string literals — so core keeps a compile-time reference to an extension's published
// shape without a runtime core→extensions edge (INV-6: routing is by id).
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import type { JobFrame, JobHandle, JobsApi, RunInput } from '@/modules/workbench/extensions/jobs/contract'
import { ORIGIN_AUTO, type BindingOrigin } from './bindingOrigin'
import type { InterpreterCtx } from './interpreter'
import { launchIdentity } from './launchIdentity'
import { markInFlight } from './inFlightLaunches'

export interface WorkbenchCtxDeps {
  api: WorkbenchAPI
  /** The project the workbench is bound to. Surfaced on `run_processor`'s return bag
   *  (DEC-6, Carrier A) so a declared save-path step can address a project-scoped
   *  route via `$<into>.projectId` — no module global, no new host capability. */
  projectId?: string
  /** Surface a toast (defaults to `api.ui.notify`). */
  notify?: (msg: string, level?: 'info' | 'success' | 'error') => void
  /** Router navigate (defaults to the base `ActionContext.navigate`). */
  navigate?: (path: string) => void
  /** Called when a `wait_for` resolves a run to a terminal `completed` — the region uses
   *  it to refresh the catalog so the freshly-produced artifact is picked up. */
  onRunComplete?: () => void
}

/**
 * Resolve a `run_processor`'s artifact inputs from the DECLARED `inputs:` map — the
 * `{ slot → artifact id(s) }` the view passes explicitly from its own state (INV-4).
 * A slot the caller named is honored verbatim; a REQUIRED slot the caller left unset
 * auto-picks the SOLE compatible artifact from the catalog (the run pane's input economy,
 * ITEM-21) and is otherwise left unbound.
 *
 * `supplied` is the `inputs:` map ONLY, never the params bag. Those are different channels
 * and conflating them is not recoverable at this layer: a `params` entry is a plain value,
 * and a string param is indistinguishable from an artifact id here — so a merged bag both
 * INVENTS inputs (a plain string param becomes a phantom slot pointing at no artifact) and
 * silently DROPS the real ones (an input a view declares only in `inputs:`).
 */
async function resolveInputs(
  api: WorkbenchAPI,
  analysis: AnalysisContribution,
  supplied: Record<string, unknown>,
  suppliedOrigins: Record<string, BindingOrigin> | undefined,
  suppliedArtifacts: Record<string, readonly string[]> | undefined,
): Promise<RunInput[]> {
  const inputs: RunInput[] = []
  const bound = new Set<string>()

  // 1. EVERY DECLARED SLOT, whether or not `appliesTo` names it.
  //
  // Iterating `appliesTo` alone silently DROPPED any supplied input it did not list —
  // and it cannot list them all, by construction: every entry there is required
  // (DEC-5), so an OPTIONAL input has no entry and never could. The optional
  // column-name input that motivated this round is exactly that shape (DEC-8: absent ⇒
  // the axis index, today's behaviour), so the whole fix would have been inert — the view
  // would show the control, the user would pick a column, and the launch would quietly
  // ignore it. The silent-zero metric this round exists to fix would have survived its
  // own fix. (The concrete case is in `docs/design/processor-manifest-ui-separation.md`;
  // core states the SHAPE, the design doc owns the domain narrative.)
  //
  // The same property is what lets a view bind a slot whose NAME is data — a per-row slot
  // keyed on a value the user picked, rather than one the manifest could enumerate.
  //
  // What the caller declared is what the caller decided. Bind it.
  for (const [slot, given] of Object.entries(supplied)) {
    // The caller's own account of how it chose this slot. ABSENT is left absent rather than
    // defaulted to `user`: a headless caller that says nothing has not reviewed anything,
    // and recording a review it never performed is the one error this whole change exists
    // to make impossible (INV-4).
    const origin = suppliedOrigins?.[slot]
    // ITEM-35 (DEC-D) — a FUSED pick FIRST. The stored value is the ONE primary id (INV-4), but
    // the pick stood for a whole member set the sidecar carried here PRIMARY-first. Bind EVERY
    // member as its own input so the recorder writes a `used` edge per artifact — the silent
    // hole this closes is recording only the primary while the colouring drew from several. The
    // member set already leads with the primary, so we bind it and SKIP the plain-value push
    // below (a `continue`) rather than push the primary twice. Applied whether the stored value
    // is a string (single-select) or an array; the set is authoritative for what the run consumes.
    const members = suppliedArtifacts?.[slot]
    if (members && members.length > 0) {
      for (const artifactId of members) inputs.push({ slot, artifactId, ...(origin ? { origin } : {}) })
      bound.add(slot)
      continue
    }
    if (typeof given === 'string' && given) {
      inputs.push({ slot, artifactId: given, ...(origin ? { origin } : {}) })
      bound.add(slot)
    } else if (Array.isArray(given)) {
      const ids = given.filter((v): v is string => typeof v === 'string' && !!v)
      for (const artifactId of ids) inputs.push({ slot, artifactId, ...(origin ? { origin } : {}) })
      if (ids.length > 0) bound.add(slot)
    }
  }

  // 2. Auto-resolve the REQUIRED slots the caller left unset — and only when
  //    UNAMBIGUOUS. This used to be the only path and it THREW on 0 or 2+ candidates, a
  //    launch-time failure the user was given no way to prevent because the input was
  //    never on screen. Views now seed their own state from the same query at mount and
  //    pass it explicitly (INV-4), so reaching here means a caller that supplied nothing
  //    and cannot be asked (an agent, the fallback form). Leaving the slot unbound lets
  //    the compute report it by name, which is a better error than a UI-layer throw.
  for (const sel of analysis.appliesTo ?? []) {
    const slot = sel.slot
    if (!slot || bound.has(slot)) continue
    if (sel.multiple) continue // an unset multi-ref is a legitimate 0-or-more set
    // ITEM-29f — DECLARED, or not at all (R2 / INV-3, DEC-15).
    //
    // This is the worse of the two headless auto-binds, because of WHO reaches it: a caller
    // that supplied nothing and cannot be asked. R2's remedy for a sole candidate is a declared
    // affordance "so the form SHOWS what it bound", and there is no form here — so the only
    // half of the rule that can hold is the declaration, and it has to hold absolutely.
    // Undeclared, the slot stays unbound and the compute reports it BY NAME, which is exactly
    // the better error the comment above already argues for.
    if (sel.auto_bind_sole_candidate !== true) continue
    const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
    const options = await data.artifacts.query(sel)
    // Stamped `auto` at the site that BINDS it, which is the only site that knows. This is
    // the worse of the two headless binds — the caller supplied nothing and cannot be asked
    // — so the fact that nobody looked at this input is precisely what has to survive into
    // the run's record, since the form that would otherwise have shown it does not exist.
    if (options.length === 1) inputs.push({ slot, artifactId: options[0].id, origin: ORIGIN_AUTO })
  }

  return inputs
}

/** The candidates for ONE input slot — what a view seeds its picker from at mount, and
 *  the same query `resolveInputs` uses. Exposed so the form and the launch agree on the
 *  candidate set by construction rather than by two similar queries drifting apart. */
export async function slotCandidates(
  api: WorkbenchAPI,
  analysis: AnalysisContribution,
  slot: string,
): Promise<Array<{ id: string }>> {
  const sel = (analysis.appliesTo ?? []).find(s => s.slot === slot)
  if (!sel) return []
  const data = resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
  return data.artifacts.query(sel)
}

/** The upper bound on a `wait_for` (FE7 / CODING_GUIDELINES §6 "timeout every user-facing wait").
 *  A job stream that never emits a terminal frame (dropped SSE, stuck job) would otherwise leave
 *  the declared action's promise pending forever; this surfaces a stuck run instead. Generous (a
 *  real compute run can be long) but bounded. */
export const WAIT_FOR_TIMEOUT_MS = 30 * 60_000

/** Await a submitted job reaching `until` (default `completed`). Resolves with the terminal
 *  frame; rejects on a `failed`/`stopped` frame (surfacing the run failure to the action) OR on a
 *  `timeoutMs` max-duration lapse (FE7 — never hangs the action body indefinitely). A `completed`
 *  frame always satisfies the wait (a custom `until` that never arrives still resolves on
 *  completion rather than hanging). */
/** Is this frame's phase TERMINAL — the run is over, whatever the outcome?
 *
 *  Shared by the `wait_for` waiter and the in-flight release, so "the run finished" means the
 *  same thing to both. Two readings of that would let the duplicate guard hold a Run button
 *  disabled past a failure the waiter already reported. */
export function isTerminalPhase(phase: string | undefined): boolean {
  const p = (phase ?? '').toLowerCase()
  return p === 'completed' || p === 'failed' || p === 'stopped'
}

export function waitForJob(
  handle: JobHandle,
  until: string | undefined,
  onComplete?: () => void,
  timeoutMs: number = WAIT_FOR_TIMEOUT_MS,
): Promise<JobFrame> {
  const target = (until ?? 'completed').toLowerCase()
  return new Promise<JobFrame>((resolve, reject) => {
    let settled = false
    // `sub` may be undefined inside the callback when a stream emits SYNCHRONOUSLY on
    // subscription (the fake/host stub does): `sub?.dispose()` no-ops then, and the
    // post-assignment `if (settled) sub.dispose()` releases it once assigned.
    let sub: { dispose(): void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void): void => {
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      sub?.dispose()
      fn()
    }
    const onFrame = (f: JobFrame): void => {
      if (settled) return
      const phase = (f.phase ?? '').toLowerCase()
      if (phase === 'failed' || phase === 'stopped') {
        finish(() => reject(new Error(f.message || `run ${phase}`)))
      } else if (phase === target || phase === 'completed') {
        finish(() => {
          onComplete?.()
          resolve(f)
        })
      }
    }
    // Arm the max-duration guard BEFORE subscribing (a stream that never terminates can't hang
    // the action). `timeoutMs <= 0` disables it (test / an explicit unbounded wait).
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) finish(() => reject(new Error(`wait_for timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${target}"`)))
      }, timeoutMs)
    }
    sub = handle.onProgress(onFrame)
    if (settled) sub.dispose()
  })
}

/**
 * Build the `InterpreterCtx` a declarative view's actions run over. Wires the effectful ops
 * (`run_processor` / `wait_for` / `toast`) onto the injected `WorkbenchAPI`; the base
 * navigate/progress/log/instance surface comes from the real `ActionContext`.
 */
export function createWorkbenchInterpreterCtx(deps: WorkbenchCtxDeps): InterpreterCtx {
  const { api } = deps
  const base = createActionContext()
  const notify = deps.notify ?? ((m: string, l?: 'info' | 'success' | 'error') => api.ui.notify(m, l))
  return {
    ...base,
    projectId: deps.projectId,
    navigate: deps.navigate ?? base.navigate,
    runProcessor: async (id, params, declaredInputs, declaredOrigins, declaredArtifacts) => {
      const analysis = api.registry.analyses.get(id) as AnalysisContribution | undefined
      if (!analysis) throw new Error(`[declarative] run_processor: unknown analysis "${id}"`)
      const p = (params ?? {}) as Record<string, unknown>
      // Inputs come from the DECLARED `inputs:` channel; `params` is passed through to the
      // compute untouched. Binding inputs off `params` instead made every string param a
      // candidate artifact id and ignored the `inputs:` block the views actually declare.
      const inputs = await resolveInputs(
        api,
        analysis,
        (declaredInputs ?? {}) as Record<string, unknown>,
        declaredOrigins,
        declaredArtifacts,
      )
      const jobs = resolveOrThrow<JobsApi>(api.capabilities, 'jobs', '^1')
      const handle = await jobs.run(analysis.run, inputs, p, {
        schedule: analysis.schedule,
        name: analysis.title,
        analysisId: analysis.id,
      })
      // The launch is IN FLIGHT from here until its job reaches a terminal phase. Marked after
      // `jobs.run` resolves, so a submit that threw never marks (there is nothing in the air)
      // and cannot leave a Run button disabled against a job that does not exist (DEC-4).
      // Identity is computed from the DECLARED input bag, not the resolved `RunInput[]`.
      // Both sides of the guard must derive it the same way: the render layer cannot resolve
      // (that is async and needs the catalog), so if the launch used the resolved form the
      // button would compare against an identity nothing ever marks, and the guard would be
      // silently inert. The declared bag is also the right ANSWER — it is what the form
      // submitted, which is exactly what distinguishes two clicks.
      const declared = (declaredInputs ?? {}) as Record<string, unknown>
      const release = markInFlight(launchIdentity(analysis.id, declared, p))

      // ONE underlying job stream, however many observers.
      //
      // `handle.onProgress` opens its OWN SSE connection per call (`streamJob` → `Jobs.stream`).
      // Subscribing here for the in-flight release therefore added a SECOND long-lived
      // connection per launch, beside the one a view's `wait_for` opens and the run console's.
      // Browsers cap concurrent connections per host, so on the second consecutive run the
      // `wait_for` stream could simply never connect: the run completed server-side while the
      // UI waited forever for a frame. Observed exactly that way — the run's outputs were
      // ingested and no terminal frame ever reached the view.
      //
      // So the handle is wrapped: observers share one underlying stream, and it is opened on
      // the first subscription and disposed when the last one leaves. Strictly fewer connections
      // than before this guard existed, not merely no more.
      const listeners = new Set<(f: JobFrame) => void>()
      let underlying: { dispose(): void } | undefined
      // The terminal frame is LATCHED and replayed to any later subscriber.
      //
      // Without it, this guard introduced a race that hung the UI on a run that had finished.
      // The release below subscribes first; on a fast run its terminal frame can arrive BEFORE
      // the view's `wait_for` attaches. The release then unsubscribes as the only listener, the
      // stream closes, and `wait_for` opens a fresh one against an already-terminal job — which
      // emits nothing further. The run's outputs were ingested and the form waited forever.
      //
      // A late observer of a finished job should learn that it finished; that is true of any
      // consumer here, not just the two in this file, so the latch belongs in the handle rather
      // than in either caller.
      let terminal: JobFrame | undefined
      const shared: JobHandle = {
        jobId: handle.jobId,
        onProgress: cb => {
          if (terminal) {
            // Asynchronously, so a subscriber that inspects its own subscription object inside
            // the callback (`waitForJob` does) is not handed one that does not exist yet.
            const frame = terminal
            queueMicrotask(() => cb(frame))
            return { dispose: () => {} }
          }
          listeners.add(cb)
          // Opened AFTER the listener is registered, so a stream that emits synchronously on
          // subscription (the fake host does) still reaches this observer.
          underlying ??= handle.onProgress(f => {
            if (isTerminalPhase(f.phase)) terminal = f
            for (const l of [...listeners]) l(f)
          })
          return {
            dispose: () => {
              listeners.delete(cb)
              // Only closed once the job is OVER. Closing on an empty listener set alone is the
              // race described above — the stream would go with the first observer to finish
              // with it, taking the frames a later one still needs.
              if (listeners.size === 0 && terminal) {
                underlying?.dispose()
                underlying = undefined
              }
            },
          }
        },
      }

      // `sub` may be undefined inside the callback when the stream emits SYNCHRONOUSLY on
      // subscription — the hazard `waitForJob` documents. `done` carries the decision out so
      // the post-assignment line releases the subscription once it exists.
      let sub: { dispose(): void } | undefined
      let done = false
      sub = shared.onProgress(f => {
        if (!isTerminalPhase(f.phase)) return
        done = true
        release()
        sub?.dispose()
      })
      if (done) sub.dispose()

      // ACKNOWLEDGE ON CREATE, not on completion.
      //
      // Until here the only feedback a launch produced was the declared success toast, minutes
      // later. A user could not tell a submitted run from a click that did nothing, and the
      // rational response to an unresponsive button is to press it again — each press a real
      // duplicate consuming a sandbox slot.
      //
      // It lives HERE rather than in each view's `actions:` because a per-view `toast:` is a
      // thing every processor author must remember, and the author who forgets ships exactly
      // the behaviour this removes. Same reasoning as the value excerpt being implicit: a fix
      // that depends on the author knowing about the problem does not fix the problem.
      //
      // It names the ANALYSIS (DEC-2) — two runs launched in quick succession are otherwise
      // indistinguishable — and it is only reached once `jobs.run` has RESOLVED, so a failed
      // submit throws past it and acknowledges nothing (DEC-4).
      notify(`${analysis.title} started`, 'info')
      // DEC-6 (Carrier A): surface the RESOLVED inputs + the bound project on the
      // `into:` bag alongside the job handle. `resolveInputs` already computed them
      // and used to DISCARD them, so a later declared step (a save-path provenance
      // recording) had no way to name the artifact the run actually consumed — and
      // re-resolving it would race the post-run catalog refresh and can pick a
      // DIFFERENT artifact. These are the very ids `jobs.run` pinned into the
      // run's `inputs[].artifact_ref`, so the recorded input and the run's `used`
      // edge cannot disagree. Spread (not wrapped) so `wait_for`'s `jobId`/
      // `onProgress` reads stay source-compatible.
      return { ...shared, inputs, projectId: deps.projectId }
    },
    waitFor: (job, until) => waitForJob(job as JobHandle, until, deps.onRunComplete),
    toast: msg => {
      if (typeof msg === 'string') notify(msg, 'success')
      else if (msg.error) notify(msg.error, 'error')
      else if (msg.success) notify(msg.success, 'success')
    },
  }
}
