import type { ActionContext } from './ctx'
import type { InstanceHandle } from './instanceRegistry'
import { awaitAffordance } from './affordances'
import { emitChoreography } from './choreographyBus'

// The CHOREOGRAPHY step model + runner (richer-actions ITEM-6/8/9/14). A compound
// action declares an ordered `Step[]` (DEC-4 declarative); `runChoreography` drives
// them VISIBLY: for each handler step it awaits the target affordance AND its live
// instance (readiness), spotlights it (caption only on a fully-narrated AI run —
// DEC-6), dwells so a human can follow, then invokes the SAME live instance handler
// the human's click calls (DEC-2 handler+spotlight parity). It stops at a `yield`
// (the human "stage + hand back" — DEC-7) and aborts cleanly on `ctx.signal` OR when
// a NEW run supersedes it (run-serialization). It NEVER throws (a handler error is
// caught + reported in the result), and returns a `ChoreographyResult` so the
// caller/AI knows whether it completed. Two variants share a prefix by concatenating
// their step arrays (DEC-1).

/** Open a workbench pane of `kind` (delegated to the caller so this core module
 *  never imports a workbench store). */
export interface OpenPaneStep {
  op: 'openPane'
  kind: string
}
/** Invoke a named affordance HANDLER on the target instance, spotlighting an
 *  affordance while it runs. The full `params` object is passed to the handler. */
export interface HandlerStep {
  /** The instance handler id to invoke (a PRIVATE affordance handler — DEC-3). */
  handler: string
  /** The affordance NAME to await (readiness) + ring (spotlight). */
  spotlight?: string
  /** The narration caption (shown only on a narrated run). */
  caption?: string
}
/** Stage the UI and HAND CONTROL BACK to the user (no further steps run). */
export interface YieldStep {
  op: 'yield'
}
export type Step = OpenPaneStep | HandlerStep | YieldStep

/** What a choreography run reports back (so the AI/caller knows the outcome). */
export interface ChoreographyResult {
  /** True when the run completed all steps OR yielded cleanly. */
  ok: boolean
  /** Set when the run stopped early because it (or a superseding run) aborted. */
  aborted?: boolean
  /** Set when the run stopped at a `yield` step (human staging path). */
  yielded?: boolean
  /** A human-readable reason when `ok` is false and it wasn't an abort. */
  error?: string
}

/** Named pacing/limit constants (DEC-8) — a `Limits` struct, not inline magic
 *  numbers, so it is promotable to a per-user setting later without a rewrite.
 *  Reduced motion collapses the dwell to 0 (see `runChoreography`). */
export const CHOREOGRAPHY_LIMITS = {
  /** How long a spotlight lingers before the step's handler fires, so a human can
   *  follow what the AI is doing. Deliberately unhurried — a too-fast spotlight is
   *  gone before the user notices it (FB-1). */
  stepDwellMs: 900,
  /** After the LAST step completes, hold the final spotlight this long before
   *  clearing, so the end of the sequence is perceptible instead of vanishing the
   *  instant the action finishes (FB-1). */
  finalHoldMs: 900,
  /** Max wait for a step's target affordance + instance to become ready. */
  readinessTimeoutMs: 4000,
  /** Poll interval while waiting for the live instance to register (it mounts in
   *  a passive effect, one phase after the affordance's commit-phase ref). */
  instancePollMs: 16,
} as const

export interface RunChoreographyOptions {
  /** The instance TYPE whose live handlers the handler steps resolve against
   *  (e.g. `'datasets'`) — the single focused instance of that type in the realm. */
  instanceType: string
  /** How to satisfy an `openPane` step (the action's `run` wires this to the
   *  workbench instance so core stays decoupled from the workbench store). The
   *  return value is awaited but otherwise ignored. */
  openPane: (kind: string) => unknown
  /** Full narration (AI): a caption per step. Soft (human): a single quiet
   *  spotlight, no captions (DEC-6). */
  narrate: boolean
  /** Test/override hook for the OS reduced-motion signal (production callers omit
   *  it — the runner reads `prefersReducedMotion()`). */
  prefersReducedMotion?: boolean
  /** Override the affordance+instance readiness timeout (defaults to
   *  `CHOREOGRAPHY_LIMITS.readinessTimeoutMs`); used by tests to exercise the
   *  not-ready branch quickly. */
  readinessTimeoutMs?: number
}

/** The OS "reduce motion" preference — shared by the runner (dwell collapse) and
 *  the overlay (no ring transition). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** A cancellable dwell — resolves after `ms`, immediately if `ms<=0` OR the signal
 *  is already aborted, else early when `signal` aborts. */
function dwell(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => finish()
    signal?.addEventListener('abort', onAbort)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
  })
}

/** Wait until a live instance of `type` is registered (it mounts in a passive
 *  effect, one phase after the affordance's commit-phase ref, so a fresh pane-open
 *  under reduced motion can reach a handler step before the instance exists).
 *  Resolves the handle, or `undefined` on abort/timeout. */
async function awaitInstance(
  ctx: ActionContext,
  type: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<InstanceHandle | undefined> {
  const start = Date.now()
  for (;;) {
    if (signal?.aborted) return undefined
    const inst = ctx.instances(type)[0]
    if (inst) return inst
    if (Date.now() - start > timeoutMs) return undefined
    await dwell(CHOREOGRAPHY_LIMITS.instancePollMs, signal)
  }
}

// Run-serialization: only ONE choreography drives the shared overlay/affordances at
// a time. Starting a new run aborts the previous (it sees the abort → stops + clears),
// so a human `dataset.add` and an AI `dataset.add.byId` (or two triggers) can't
// interleave handlers or fight over the single spotlight. Module-scoped singleton.
let activeRun: AbortController | null = null

/** Combine the caller's `ctx.signal` with the run-serialization signal. */
function combinedSignal(ctxSignal: AbortSignal | undefined, runSignal: AbortSignal): AbortSignal {
  if (!ctxSignal) return runSignal
  return AbortSignal.any([ctxSignal, runSignal])
}

/** Interrupt the currently-running choreography, if any (the "user takes over" /
 *  a global Stop). A no-op when none is running. */
export function abortActiveChoreography(): void {
  activeRun?.abort()
}

/**
 * Run a declarative choreography. Resolves with a `ChoreographyResult` when the
 * sequence completes, yields, or is interrupted. NEVER throws — a handler/openPane
 * error is caught, the overlay cleared, and reported as `{ ok:false, error }`.
 */
export async function runChoreography(
  steps: readonly Step[],
  params: Record<string, unknown>,
  ctx: ActionContext,
  opts: RunChoreographyOptions,
): Promise<ChoreographyResult> {
  // Supersede any in-flight run, then register as the active one.
  activeRun?.abort()
  const runController = new AbortController()
  activeRun = runController
  const signal = combinedSignal(ctx.signal, runController.signal)
  const reduced = opts.prefersReducedMotion ?? prefersReducedMotion()
  const readinessMs = opts.readinessTimeoutMs ?? CHOREOGRAPHY_LIMITS.readinessTimeoutMs

  const finish = (result: ChoreographyResult): ChoreographyResult => {
    // Only clear the overlay + release the slot if WE still own it. A run that was
    // SUPERSEDED (activeRun already points at a newer run) must NOT emit a clear
    // when its own late, non-abortable await (e.g. an in-flight attach network call)
    // finally settles — that late clear would wipe the NEW run's live spotlight. The
    // superseding run owns the overlay now and will clear it when it finishes.
    if (activeRun === runController) {
      emitChoreography({ type: 'clear' })
      activeRun = null
    }
    return result
  }

  for (const step of steps) {
    if (signal.aborted) return finish({ ok: false, aborted: true })

    if ('op' in step) {
      if (step.op === 'openPane') {
        try {
          await opts.openPane(step.kind)
        } catch (e) {
          return finish({ ok: false, error: `openPane(${step.kind}) failed: ${errText(e)}` })
        }
        continue
      }
      // 'yield' — stage the UI and hand back (DEC-7 fire-and-forget).
      return finish({ ok: true, yielded: true })
    }

    // A handler step: gate on the affordance being ready, spotlight it, dwell,
    // then invoke the live instance handler.
    if (step.spotlight) {
      try {
        await awaitAffordance(step.spotlight, {
          signal,
          timeoutMs: readinessMs,
        })
      } catch (e) {
        if (signal.aborted) return finish({ ok: false, aborted: true })
        // Not ready in time — log and skip the spotlight, but still try the
        // handler (best-effort, matching "the AI just does the thing").
        console.warn(`[choreography] affordance '${step.spotlight}' not ready: ${errText(e)}`)
      }
      emitChoreography({
        type: 'spotlight',
        name: step.spotlight,
        caption: opts.narrate ? step.caption : undefined,
      })
      await dwell(reduced ? 0 : CHOREOGRAPHY_LIMITS.stepDwellMs, signal)
    }

    if (signal.aborted) return finish({ ok: false, aborted: true })

    // Resolve the live instance (it may register a phase after the affordance).
    const instance = await awaitInstance(ctx, opts.instanceType, signal, readinessMs)
    if (signal.aborted) return finish({ ok: false, aborted: true })
    const handler = instance?.handlers[step.handler]
    if (!handler) {
      return finish({
        ok: false,
        error: `handler '${step.handler}' unavailable on instance '${opts.instanceType}'`,
      })
    }
    try {
      const result = await handler(params, ctx)
      // A handler may signal its own failure (e.g. attach failed) via {ok:false}.
      if (isFailureResult(result)) {
        return finish({ ok: false, error: `handler '${step.handler}' reported failure` })
      }
    } catch (e) {
      return finish({ ok: false, error: `handler '${step.handler}' threw: ${errText(e)}` })
    }
  }
  // Hold the final spotlight a beat so the completed sequence is perceptible (FB-1),
  // then clear. Abort-aware (a supersede cuts it short) and skipped under reduced motion.
  await dwell(reduced ? 0 : CHOREOGRAPHY_LIMITS.finalHoldMs, signal)
  return finish({ ok: true })
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A handler that returns `{ ok: false }` is reporting a real failure (e.g. attach
 *  rejected) — surfaced in the choreography result so the AI isn't told "success". */
function isFailureResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok?: unknown }).ok === false
  )
}
