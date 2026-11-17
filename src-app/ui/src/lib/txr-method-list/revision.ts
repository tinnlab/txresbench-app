/**
 * The method list the screens show, and when it changes.
 *
 * The server runs on ONE signed method list at a time and may move to a newer
 * one between runs (`GET /api/methods/updates`). Every method list and
 * eligibility response names its list (`method_list_sequence`); a run request
 * sends back the sequence the screen showed, and a request from an older list
 * is refused (`409 METHOD_LIST_CHANGED`).
 *
 * This module keeps the sequence the screens last saw and a revision counter
 * that moves when the sequence changes:
 *
 * - `noteMethodListSequence(n)` records a sequence a response named. The
 *   first one only sets it; a different one later bumps the revision and runs
 *   every handler registered with `onMethodListChange` (the intake fetch cache
 *   drops its catalogue reads there) before the subscribers re-render.
 * - `useMethodListRevision()` is the counter, for a fetch hook's effect deps:
 *   a new list refetches the hook's catalogue reads.
 * - `useMethodListUpdates()` is the status for a screen that shows it (the
 *   Settings card) or reads methods (the method rows): while one is mounted
 *   the status is read on mount, on window focus and every 10 minutes. These
 *   reads are local (the app's own server); the server asks the registry only
 *   at its start, before a run and from the Settings button.
 * - `checkForMethodUpdates()` asks the server to check the registry now (the
 *   `methodList.checkForUpdates` action runs it).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { ApiClient } from '@/api-client'
import type { MethodListStatus } from '@/api-client/types'

/** How often a mounted method screen re-reads the status (local, cheap). */
export const STATUS_POLL_MS = 10 * 60 * 1000

let shownSequence: number | null = null
let revision = 0
let status: MethodListStatus | null = null
let checking = false
const subscribers = new Set<() => void>()
const changeHandlers = new Set<() => void>()

function emit(): void {
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** Record the sequence a response named (`undefined`/`null`: nothing to note). */
export function noteMethodListSequence(sequence: number | null | undefined): void {
  if (sequence === null || sequence === undefined) return
  if (shownSequence === sequence) return
  const first = shownSequence === null
  shownSequence = sequence
  if (!first) {
    revision += 1
    for (const drop of changeHandlers) drop()
  }
  emit()
}

/** The sequence the screens last saw (`null` before any response named one). */
export function shownMethodListSequence(): number | null {
  return shownSequence
}

/** Run `handler` whenever the list changes (before the screens re-render). */
export function onMethodListChange(handler: () => void): () => void {
  changeHandlers.add(handler)
  return () => {
    changeHandlers.delete(handler)
  }
}

/** The revision counter: it moves when the method list changes. */
export function useMethodListRevision(): number {
  return useSyncExternalStore(subscribe, () => revision, () => revision)
}

function noteStatus(next: MethodListStatus): void {
  status = next
  noteMethodListSequence(next.sequence)
  emit()
}

/** Re-read the status (a failed read keeps the last one). */
export async function refreshMethodListStatus(): Promise<MethodListStatus | null> {
  try {
    noteStatus(await ApiClient.MethodList.updates())
  } catch {
    // The status is a nicety: the next read retries.
  }
  return status
}

/** Ask the server to check the registry now; answers the new status. */
export async function checkForMethodUpdates(): Promise<MethodListStatus> {
  checking = true
  emit()
  try {
    const next = await ApiClient.MethodList.checkUpdates()
    noteStatus(next)
    return next
  } finally {
    checking = false
    emit()
  }
}

/** Whether a check the user asked for is running. */
export function useMethodListChecking(): boolean {
  return useSyncExternalStore(subscribe, () => checking, () => checking)
}

let pollers = 0
let timer: ReturnType<typeof setInterval> | null = null

function onFocus(): void {
  void refreshMethodListStatus()
}

/**
 * The status, kept fresh while the caller is mounted: read on mount, on
 * window focus and every [`STATUS_POLL_MS`].
 */
export function useMethodListUpdates(): MethodListStatus | null {
  useEffect(() => {
    pollers += 1
    if (pollers === 1) {
      window.addEventListener('focus', onFocus)
      timer = setInterval(onFocus, STATUS_POLL_MS)
    }
    void refreshMethodListStatus()
    return () => {
      pollers -= 1
      if (pollers === 0) {
        window.removeEventListener('focus', onFocus)
        if (timer !== null) clearInterval(timer)
        timer = null
      }
    }
  }, [])
  return useSyncExternalStore(subscribe, () => status, () => status)
}

/** Test seam: forget the sequence and the status (the module state is per page
 *  session; the registered change handlers stay, as module loads made them). */
export function __resetMethodListRevisionForTests(): void {
  shownSequence = null
  revision = 0
  status = null
  checking = false
  emit()
}
