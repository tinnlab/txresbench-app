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
 * - `setUpWsl()` runs the setup (`POST /api/sandbox/wsl/setup`): Windows asks
 *   the person at the PC for permission, then WSL comes from Microsoft. It
 *   answers when the setup ended; then the facts are read again. The
 *   `sandbox.setupWsl` action runs it, so the notice's button, the command
 *   palette and the AI agent all run the same setup.
 * - `useWslSetup(enabled)` is the notice's hook: it reads the facts on mount
 *   and, while the server says a setup runs that this window is not waiting
 *   for (a reload, or the agent started it elsewhere), every few seconds.
 * - While a setup is offered, the `WSL_SETUP_CONTEXT` page context is active:
 *   the palette lists the action and the agent may run it only then.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { ApiClient } from '@/api-client'
import type { WslSetupResult, WslSetupStatus } from '@/api-client/types'
import { registerActiveContext, unregisterActiveContext } from '@/core/actions/activeContext'

/** The page context of the `sandbox.setupWsl` action: active while a setup is offered. */
export const WSL_SETUP_CONTEXT = 'wsl-setup'

/** How often a mounted notice re-reads the facts while a setup runs. */
export const RUNNING_POLL_MS = 5000

/** What the notice shows: why methods cannot run, and the setup's status. */
export interface WslSetupFacts {
  /** Why methods cannot run, in the start-up check's words. */
  reason: string
  setup: WslSetupStatus
}

export interface WslSetupView {
  facts: WslSetupFacts | null
  /** A setup this window started is running (its request is open). */
  posting: boolean
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
  if (view.facts?.setup.offer !== undefined) registerActiveContext(WSL_SETUP_CONTEXT)
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

/** Run the setup and wait for its end; then read the facts again. */
export async function setUpWsl(): Promise<WslSetupResult> {
  update({ posting: true })
  try {
    return await ApiClient.Sandbox.setupWsl()
  } finally {
    update({ posting: false })
    await refreshWslSetup()
  }
}

/** The facts for the notice: read on mount (when `enabled`), and again every
 *  [`RUNNING_POLL_MS`] while a setup runs that this window is not waiting for. */
export function useWslSetup(enabled: boolean): WslSetupView {
  const current = useSyncExternalStore(subscribe, () => view, () => view)
  useEffect(() => {
    if (enabled) void refreshWslSetup()
  }, [enabled])
  const runningElsewhere = enabled && current.facts?.setup.running === true && !current.posting
  useEffect(() => {
    if (!runningElsewhere) return
    const timer = setInterval(() => void refreshWslSetup(), RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [runningElsewhere])
  return current
}

/** Test seam: forget the facts (the module state is per page session). */
export function __resetWslSetupForTests(): void {
  update({ facts: null, posting: false })
}
