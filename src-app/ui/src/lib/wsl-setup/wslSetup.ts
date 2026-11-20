/**
 * "Set up WSL" (Windows): the notice's facts and the setup itself.
 *
 * Methods on Windows run in WSL 2. When the app's start-up check found WSL
 * missing or too old, `GET /api/sandbox/envs` says why (`stack.reason`) and
 * what the app can do (`stack.wsl_setup`: the offer, whether a setup runs,
 * the last result). Elsewhere, and when methods can run, `stack.wsl_setup` is
 * absent and there is nothing to show.
 *
 * - `refreshWslSetup()` reads the facts (a failed read keeps the last ones).
 * - `setUpWsl()` starts the setup (`POST /api/sandbox/wsl/setup`), which
 *   answers at once with its status (`running`). The setup itself waits for
 *   the person at the PC to confirm in the app's own dialog (Windows may also
 *   ask for permission); then WSL comes from Microsoft. Its result comes in the
 *   facts (`setup.last`) when it ended. The `sandbox.setupWsl` action runs
 *   it, so the notice's button, the command palette and the AI agent all
 *   start the same setup.
 * - `useWslSetup(enabled)` is the notice's hook: it reads the facts on mount
 *   and every few seconds while a setup runs (started here, after a reload,
 *   by the agent, or by the app before it was last closed) or after a No,
 *   until the setup can be started again.
 * - While a setup can start (offered, none running, not just declined), the
 *   `WSL_SETUP_CONTEXT` page context is active: the palette lists the action
 *   and the agent may run it only then.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { ApiClient } from '@/api-client'
import type { WslSetupStatus } from '@/api-client/types'
import { registerActiveContext, unregisterActiveContext } from '@/core/actions/activeContext'

/** The page context of the `sandbox.setupWsl` action: active while a setup can start. */
export const WSL_SETUP_CONTEXT = 'txr.wsl-setup'

/** How often a mounted notice re-reads the facts while a setup runs or after a No. */
export const RUNNING_POLL_MS = 5000

/** What the notice shows: why methods cannot run, and the setup's status. */
export interface WslSetupFacts {
  /** Why methods cannot run, in the start-up check's words. */
  reason: string
  setup: WslSetupStatus
}

export interface WslSetupView {
  facts: WslSetupFacts | null
  /** This window's request to start a setup is open. */
  posting: boolean
}

/** A setup can start now: offered, none running or starting, not just declined. */
function canStart(v: WslSetupView): boolean {
  const setup = v.facts?.setup
  return setup?.offer !== undefined && !setup.running && setup.retry_in_secs === undefined && !v.posting
}

let view: WslSetupView = { facts: null, posting: false }
const subscribers = new Set<() => void>()

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

function update(next: Partial<WslSetupView>): void {
  view = { ...view, ...next }
  if (canStart(view)) registerActiveContext(WSL_SETUP_CONTEXT)
  else unregisterActiveContext(WSL_SETUP_CONTEXT)
  for (const notify of subscribers) notify()
}

/** Read the facts again (a failed read keeps the last ones). */
export async function refreshWslSetup(): Promise<WslSetupFacts | null> {
  try {
    const { stack } = await ApiClient.Sandbox.listEnvs()
    update({ facts: stack.wsl_setup ? { reason: stack.reason ?? '', setup: stack.wsl_setup } : null })
  } catch {
    // The notice is not worth an error of its own: the next read retries.
  }
  return view.facts
}

/** Start the setup: the server answers at once with its status (running),
 *  which the facts take; the result comes later in the facts. */
export async function setUpWsl(): Promise<WslSetupStatus> {
  update({ posting: true })
  try {
    const setup = await ApiClient.Sandbox.setupWsl()
    if (view.facts !== null) update({ facts: { ...view.facts, setup } })
    return setup
  } finally {
    update({ posting: false })
    await refreshWslSetup()
  }
}

/** The facts for the notice: read on mount (when `enabled`), and again every
 *  [`RUNNING_POLL_MS`] while a setup runs or after a No (until it can start again). */
export function useWslSetup(enabled: boolean): WslSetupView {
  const current = useSyncExternalStore(subscribe, () => view, () => view)
  useEffect(() => {
    if (enabled) void refreshWslSetup()
  }, [enabled])
  const setup = current.facts?.setup
  const waiting = enabled && !current.posting && (setup?.running === true || setup?.retry_in_secs !== undefined)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void refreshWslSetup(), RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [waiting])
  return current
}

/** Test seam: forget the facts (the module state is per page session). */
export function __resetWslSetupForTests(): void {
  update({ facts: null, posting: false })
}
