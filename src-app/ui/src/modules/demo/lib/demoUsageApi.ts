import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'

/**
 * The demo usage read (demo-mode ITEM-7, "n of 50" counters): the ONE
 * `GET /api/txr/history/usage` answer carries both counter pairs in demo
 * mode (ITEM-4's adapted arm: `{runs, run_limit, models, model_limit,
 * pinned_runs, pinned_models, shared}`), so History's "n of 50 runs" and
 * Models'/Saved-models' "n of 50 models" read the same wire call.
 *
 * The demo shape is BELOW the OpenAPI spec by design (the desktop
 * `TxrHistoryUsage` stays the documented byte figure — DRIFT-1 ITEM-4 #5),
 * so this parse is a defensive cast at the one seam: `fetchDemoUsage`
 * returns the demo fields, every caller reads them through this typed
 * wrapper, and a desktop-mode answer (no `shared` flag) reads as the demo
 * shape's STARVING state (0 of 50) rather than a crash — the pages only
 * call it in demo mode anyway.
 */
export interface DemoUsage {
  /** The counted (non-pinned) runs — the "N of 50 runs" N. */
  runs: number
  /** The configured run limit (the audit's 50; `demo.history_limit`). */
  run_limit: number
  /** The counted (non-pinned) models — the "N of 50 models" N. */
  models: number
  /** The configured model limit (the audit's 50; `demo.model_limit`). */
  model_limit: number
  /** The pinned (never evicted, not counted) runs. */
  pinned_runs: number
  /** The pinned (never evicted, not counted) models. */
  pinned_models: number
  /** The shared-pool flag (`true` in demo mode). */
  shared: boolean
}

function parseDemoUsage(raw: unknown): DemoUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.shared !== true) return null
  const number = (key: string): number =>
    typeof value[key] === 'number' && Number.isFinite(value[key] as number)
      ? (value[key] as number)
      : 0
  return {
    runs: number('runs'),
    run_limit: number('run_limit'),
    models: number('models'),
    model_limit: number('model_limit'),
    pinned_runs: number('pinned_runs'),
    pinned_models: number('pinned_models'),
    shared: true,
  }
}

/** The ONE network read (the store-less fetch the page hooks reuse). */
export function fetchDemoUsage(): Promise<DemoUsage | null> {
  return ApiClient.History.getUsage().then(raw => parseDemoUsage(raw as unknown))
}

/**
 * The page hook: fetch the demo counters once per demo mount (the figures
 * move as the shared pool's runs and models come and go — a re-mount or the
 * page's own refresh re-reads). `enabled` is the demo-mode fact: a desktop
 * page never dials the usage endpoint for the counters (its own store
 * already owns the desktop figure); a late mode flip re-runs the read.
 * While the fetch is in flight `usage` is null and `loading` true: the
 * statement paragraph renders with the counter in its null state ("n of 50"
 * appears once the answer lands — the numbers are the server's, never
 * invented by the UI).
 */
export function useDemoUsage(enabled = true): { usage: DemoUsage | null; loading: boolean } {
  const [usage, setUsage] = useState<DemoUsage | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!enabled) {
      setUsage(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setUsage(null)
    setLoading(true)
    void fetchDemoUsage()
      .then(found => {
        if (cancelled) return
        setUsage(found)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setUsage(null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return { usage, loading }
}
