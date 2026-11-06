/**
 * txrrun — the sticky E-screen settings hook (PROV-UI-RUN-4, CONS-UI-RUN-6;
 * ITEM-4).
 *
 * Screen E is reached from "Start → … → E", and the owner's sticky rule
 * (PROV-EE-8) is that the last-used analysis config RESTORES there. The
 * engine owns the singleton (`txr_app_config`, id = 1): this hook GETs it on
 * mount (`ApiClient.Txr.getAnalysisConfig`) and writes the user's changes
 * back with a 400 ms debounced PUT (`ApiClient.Txr.updateAnalysisConfig`) —
 * the coalescing discipline of `useListEstimate`'s 250 ms timer, tuned to
 * the settings' slower cadence.
 *
 * What the hook owns and what it does not:
 *
 * - It owns the STICKY CONFIG only. The PUT body is
 *   `{ ...engine, config: toRunConfig(next) }` — the settings the screen
 *   changed, wrapped in `TxrAppConfig`, with the field the hook does not
 *   touch (`last_input_summary`) carried through from the last GET. A
 *   producer of the input summary writes it at its own PUT, never through
 *   this hook.
 * - The DEC-6 MOUNT MERGE is the page's, not the hook's: `settings` here is
 *   the ENGINE-side view (`mergeRunSettings(engine, null)`: the sticky
 *   config over the engine's defaults; `null` when the engine answers the
 *   honest never-configured `config: null`), while the page composes
 *   `mergeRunSettings(engine, intakeParams)` so the outcome answer the user
 *   JUST gave wins the decision day. The raw `engine` response is exposed
 *   for exactly that composition — the page never re-derives the engine
 *   contract.
 * - `update(next)` is the write-through. The value the screen shows is
 *   OPTIMISTIC: the hook's `settings` becomes `next` immediately, and the
 *   PUT carries the coalesced newest value (a burst of changes costs ONE
 *   request). Every queued `update` promise settles when the PUT that
 *   carried the newest value completes (a superseded value's promise
 *   settles with the same flush — the coalescing made it one write). A
 *   failed PUT keeps the optimistic view and surfaces `error` — the sticky
 *   store is behind the screen, and `retry()` below re-issues exactly the
 *   failed operation.
 * - `retry()` re-runs the operation that failed last: the mount GET (error
 *   while loading) or the save (error while writing). `retry` never PUTs on
 *   mount — an untouched screen issues exactly one request, the GET.
 * - An epoch guard on BOTH operations discards an out-of-order response (an
 *   older GET resolving after a newer one, or an older PUT's failure
 *   landing after a newer PUT succeeded) — the `useListEstimate` discipline.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { TxrAppConfig } from '@/api-client/types'
import { mergeRunSettings, toRunConfig, type RunSettings } from '../lib/settings'

/** The PUT coalescing window: a burst of settings changes costs one write. */
export const RUN_CONFIG_DEBOUNCE_MS = 400

/** The load-failure line (shown beside the retry affordance). */
export const RUN_CONFIG_LOAD_FAILED = 'Could not load the saved settings.'

/** The save-failure line (the sticky store was not updated; retry re-writes). */
export const RUN_CONFIG_SAVE_FAILED = 'Could not save the settings.'

export interface UseRunConfigResult {
  /**
   * The engine-side sticky view: the last loaded/PUT'd config over the
   * engine's defaults; `null` while unloaded, on a load failure, or for the
   * honest never-configured answer (`config: null` — TEST-RUN-07's empty
   * config). The page composes the DEC-6 mount merge with the raw `engine`.
   */
  settings: RunSettings | null
  /**
   * The raw `TxrAppConfig` the hook last loaded (or the PUT-updated local
   * view). The page passes it to `mergeRunSettings(engine, params)`; `null`
   * only before the first successful GET.
   */
  engine: TxrAppConfig | null
  /** True while the mount GET (or a retry GET) is in flight. */
  loading: boolean
  /** The failure line of the last failed load or save; `null` when healthy. */
  error: string | null
  /**
   * Write through to the sticky store: debounced (RUN_CONFIG_DEBOUNCE_MS),
   * coalesced to the newest value, optimistic in the hook's own view. The
   * returned promise settles when the flush that carried the newest value
   * completes — never rejects (a failure is the `error` slot).
   */
  update(next: RunSettings): Promise<void>
  /** Re-run the operation that failed last (the mount GET or the save). */
  retry(): void
}

/** One queued save: the newest value + every caller waiting on its flush. */
type PendingSave = {
  value: RunSettings
  settles: (() => void)[]
}

const isErrorMessage = (err: unknown): string | null =>
  err instanceof Error ? err.message : null

/**
 * The mount GET. The epoch guard masters the out-of-order case: a `retry()`
 * while a slow first GET is in flight discards the first response entirely.
 */
export function useRunConfig(): UseRunConfigResult {
  const [engine, setEngine] = useState<TxrAppConfig | null>(null)
  const [settings, setSettings] = useState<RunSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const engineRef = useRef<TxrAppConfig | null>(null)
  const pendingRef = useRef<PendingSave | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflightRef = useRef(false)
  const loadEpoch = useRef(0)
  const saveEpoch = useRef(0)
  const saveVersion = useRef(0)
  const failedOp = useRef<'load' | 'save' | null>(null)
  const lastSaveValue = useRef<RunSettings | null>(null)

  /** The hook's local view of the sticky store after a PUT: the settings the
   *  PUT carried, the carried-through summary untouched. */
  const applySaved = (value: RunSettings): void => {
    const nextEngine: TxrAppConfig = {
      ...(engineRef.current ?? {}),
      config: toRunConfig(value),
    }
    engineRef.current = nextEngine
    setEngine(nextEngine)
    setSettings(value)
  }

  const runLoad = useCallback((): void => {
    const requestEpoch = (loadEpoch.current += 1)
    // A GET that started BEFORE the newest save resolved carries the
    // PRE-save store; its view must not overwrite the newer optimistic one
    // (the stale-guard's save half — the response itself is still honest
    // for the load/error fields).
    const saveVersionAtStart = saveVersion.current
    setLoading(true)
    ApiClient.Txr.getAnalysisConfig()
      .then((response: TxrAppConfig) => {
        if (loadEpoch.current !== requestEpoch) return
        setLoading(false)
        setError(null)
        failedOp.current = null
        if (saveVersion.current !== saveVersionAtStart) return
        engineRef.current = response
        setEngine(response)
        // The honest never-configured answer stays `null` (TEST-RUN-07); a
        // present (even partial) config is the engine's fields over the
        // engine's own defaults.
        setSettings(response.config ? mergeRunSettings(response, null) : null)
      })
      .catch((err: unknown) => {
        if (loadEpoch.current !== requestEpoch) return
        setLoading(false)
        setError(isErrorMessage(err) ?? RUN_CONFIG_LOAD_FAILED)
        failedOp.current = 'load'
      })
  }, [])

  useEffect(() => {
    runLoad()
    return () => {
      loadEpoch.current += 1
    }
  }, [runLoad])

  /** The debounced flush: ONE PUT carrying the newest coalesced value.
   *  Writes are SERIALIZED — a flush that fires while a PUT is on the wire
   *  leaves the newest pending value queued, and the settling path arms the
   *  next debounce; two PUTs never race, so the server's sticky singleton always
   *  ends at the newest value. */
  const flush = useCallback((): void => {
    if (inflightRef.current) return
    const pending = pendingRef.current
    if (pending === null) return
    pendingRef.current = null
    inflightRef.current = true
    const value = pending.value
    lastSaveValue.current = value
    const requestEpoch = (saveEpoch.current += 1)
    const settle = (): void => {
      inflightRef.current = false
      for (const resolve of pending.settles) resolve()
    }
    setError(null)
    // The settings-only write: the fields the hook owns, with the engine's
    // carried-through fields (the input summary) preserved — the hook never
    // clobbers data it does not own.
    ApiClient.Txr.updateAnalysisConfig({
      ...(engineRef.current ?? {}),
      config: toRunConfig(value),
    })
      .then(() => {
        settle()
        if (saveEpoch.current !== requestEpoch) return
        saveVersion.current += 1
        applySaved(value)
        failedOp.current = null
        // A change landed WHILE the PUT was in flight: its timer ran and
        // queued a newer value — write it next, one more debounce.
        if (pendingRef.current !== null) {
          timerRef.current = setTimeout(flush, RUN_CONFIG_DEBOUNCE_MS)
        }
      })
      .catch((err: unknown) => {
        settle()
        if (saveEpoch.current !== requestEpoch) return
        setError(isErrorMessage(err) ?? RUN_CONFIG_SAVE_FAILED)
        failedOp.current = 'save'
        if (pendingRef.current !== null) {
          timerRef.current = setTimeout(flush, RUN_CONFIG_DEBOUNCE_MS)
        }
      })
  }, [])

  const update = useCallback(
    (next: RunSettings): Promise<void> => {
      // Optimistic: the screen already shows `next`; the hook's view follows
      // so a re-render never flashes the stored value back over the change.
      setSettings(next)
      const pending = pendingRef.current
      if (pending !== null) {
        // Coalesce: this call's value SUPERSEDES the queued one — one timer,
        // one PUT, the newest bytes; its promise settles with that flush.
        pending.value = next
        return new Promise<void>(resolve => {
          pending.settles.push(resolve)
        })
      }
      return new Promise<void>(resolve => {
        pendingRef.current = { value: next, settles: [resolve] }
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(flush, RUN_CONFIG_DEBOUNCE_MS)
      })
    },
    [flush],
  )

  const retry = useCallback((): void => {
    if (failedOp.current === 'save' && lastSaveValue.current !== null) {
      // The sticky store is behind the screen: re-write the value the store
      // did not take (the optimistic view stays — retry is the honest
      // affordance, never a silent second PUT from a timer).
      void update(lastSaveValue.current)
      return
    }
    runLoad()
  }, [runLoad, update])

  return { settings, engine, loading, error, update, retry }
}
